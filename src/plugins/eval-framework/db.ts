import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { RunRecord, ExampleResult, RunMetrics, RunStatus, Recommendation } from "./types.js";

function resolvePath(raw: string): string {
  return raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
}

export class EvalDb {
  private db: Database;

  constructor(dbPath: string) {
    const resolved = resolvePath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved, { create: true });
    this._init();
  }

  private _init(): void {
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id          TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        set_id          TEXT NOT NULL,
        model           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'running',
        started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        completed_at    TEXT,
        pass_rate       REAL,
        p50_latency_ms  REAL,
        p95_latency_ms  REAL,
        p99_latency_ms  REAL,
        cost_usd        REAL NOT NULL DEFAULT 0,
        n_examples      INTEGER NOT NULL DEFAULT 0,
        max_cost_usd    REAL NOT NULL DEFAULT 2.0,
        cost_accumulated REAL NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS examples (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        TEXT NOT NULL REFERENCES runs(run_id),
        example_id    TEXT NOT NULL,
        input_hash    TEXT NOT NULL,
        model         TEXT NOT NULL,
        latency_ms    REAL NOT NULL,
        cost_usd      REAL NOT NULL,
        judge_verdict INTEGER NOT NULL,
        judge_mode    TEXT NOT NULL,
        error         TEXT,
        UNIQUE(run_id, example_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS recommendations (
        task_id                   TEXT PRIMARY KEY,
        recommended_default_tier  TEXT NOT NULL,
        escalation_rule           TEXT NOT NULL,
        validated_at_iso          TEXT NOT NULL,
        basis_run_id              TEXT NOT NULL REFERENCES runs(run_id)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_examples_run ON examples(run_id)");
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  createRun(run: Pick<RunRecord, "run_id" | "task_id" | "set_id" | "model" | "max_cost_usd">): void {
    this.db.run(
      `INSERT INTO runs (run_id, task_id, set_id, model, max_cost_usd) VALUES (?, ?, ?, ?, ?)`,
      [run.run_id, run.task_id, run.set_id, run.model, run.max_cost_usd],
    );
  }

  updateRunStatus(runId: string, status: RunStatus, metrics?: RunMetrics): void {
    if (metrics) {
      this.db.run(
        `UPDATE runs SET status=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         pass_rate=?, p50_latency_ms=?, p95_latency_ms=?, p99_latency_ms=?, cost_usd=?, n_examples=?
         WHERE run_id=?`,
        [status, metrics.pass_rate, metrics.p50_latency_ms, metrics.p95_latency_ms, metrics.p99_latency_ms, metrics.cost_usd, metrics.n_examples, runId],
      );
    } else {
      this.db.run(
        `UPDATE runs SET status=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE run_id=?`,
        [status, runId],
      );
    }
  }

  updateRunCost(runId: string, costAccumulated: number): void {
    this.db.run(`UPDATE runs SET cost_accumulated=? WHERE run_id=?`, [costAccumulated, runId]);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.query(`SELECT * FROM runs WHERE run_id=?`).get(runId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      run_id: row.run_id as string,
      task_id: row.task_id as string,
      set_id: row.set_id as string,
      model: row.model as string,
      status: row.status as RunStatus,
      started_at: row.started_at as string,
      completed_at: (row.completed_at as string) || undefined,
      max_cost_usd: row.max_cost_usd as number,
      cost_accumulated: row.cost_accumulated as number,
      metrics: row.pass_rate != null ? {
        pass_rate: row.pass_rate as number,
        p50_latency_ms: row.p50_latency_ms as number,
        p95_latency_ms: row.p95_latency_ms as number,
        p99_latency_ms: row.p99_latency_ms as number,
        cost_usd: row.cost_usd as number,
        n_examples: row.n_examples as number,
      } : undefined,
    };
  }

  listRuns(taskId?: string, sinceIso?: string, limit = 50): RunRecord[] {
    let sql = "SELECT * FROM runs WHERE 1=1";
    const params: unknown[] = [];
    if (taskId) { sql += " AND task_id=?"; params.push(taskId); }
    if (sinceIso) { sql += " AND started_at>=?"; params.push(sinceIso); }
    sql += " ORDER BY started_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.query(sql).all(...(params as string[])) as Record<string, unknown>[];
    return rows.map((row) => ({
      run_id: row.run_id as string,
      task_id: row.task_id as string,
      set_id: row.set_id as string,
      model: row.model as string,
      status: row.status as RunStatus,
      started_at: row.started_at as string,
      completed_at: (row.completed_at as string) || undefined,
      max_cost_usd: row.max_cost_usd as number,
      cost_accumulated: row.cost_accumulated as number,
    }));
  }

  // ── Examples ──────────────────────────────────────────────────────────────

  insertExample(result: ExampleResult & { run_id: string }): void {
    this.db.run(
      `INSERT OR IGNORE INTO examples (run_id, example_id, input_hash, model, latency_ms, cost_usd, judge_verdict, judge_mode, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [result.run_id, result.example_id, result.input_hash, result.model, result.latency_ms, result.cost_usd, result.judge_verdict ? 1 : 0, result.judge_mode, result.error ?? null],
    );
  }

  getExamplesForRun(runId: string): ExampleResult[] {
    const rows = this.db.query(`SELECT * FROM examples WHERE run_id=? ORDER BY id`).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      example_id: r.example_id as string,
      input_hash: r.input_hash as string,
      model: r.model as string,
      latency_ms: r.latency_ms as number,
      cost_usd: r.cost_usd as number,
      judge_verdict: (r.judge_verdict as number) === 1,
      judge_mode: r.judge_mode as ExampleResult["judge_mode"],
      error: (r.error as string) || undefined,
    }));
  }

  getCompletedExampleCount(runId: string): number {
    const row = this.db.query(`SELECT COUNT(*) as cnt FROM examples WHERE run_id=?`).get(runId) as { cnt: number };
    return row.cnt;
  }

  // ── Recommendations ───────────────────────────────────────────────────────

  upsertRecommendation(rec: Recommendation & { task_id: string }): void {
    this.db.run(
      `INSERT OR REPLACE INTO recommendations (task_id, recommended_default_tier, escalation_rule, validated_at_iso, basis_run_id)
       VALUES (?, ?, ?, ?, ?)`,
      [rec.task_id, rec.recommended_default_tier, rec.escalation_rule, rec.validated_at_iso, rec.basis_run_id],
    );
  }

  getRecommendation(taskId: string): Recommendation | null {
    const row = this.db.query(`SELECT * FROM recommendations WHERE task_id=?`).get(taskId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      recommended_default_tier: row.recommended_default_tier as string,
      escalation_rule: row.escalation_rule as string,
      validated_at_iso: row.validated_at_iso as string,
      basis_run_id: row.basis_run_id as string,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  getDbSizeBytes(): number {
    const row = this.db.query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
    return row.size;
  }

  close(): void {
    this.db.close();
  }
}
