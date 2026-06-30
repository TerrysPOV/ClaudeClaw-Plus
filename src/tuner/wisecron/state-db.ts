import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { RevisionRecord, ScheduleState, AppliedBy } from "./types.js";
import type { Patch, Proposal } from "../../skills-tuner/core/types.js";
import { ProposalSchema } from "../../skills-tuner/core/types.js";

interface SubjectStateRow {
  subject: string;
  last_run: string;
  next_run: string;
  current_interval_hours: number;
  consecutive_zero_runs: number;
  last_proposal_count: number;
  enabled: number;
}

interface RollbackRow {
  id: number;
  proposal_id: string;
  subject: string;
  applied_at: string;
  forward_patch_json: string;
  inverse_patch_json: string;
  applied_by: string;
  rolled_back_at: string | null;
}

export interface OutcomeRow {
  proposal_id: string;
  metric: string;
  commit_sha: string | null;
  subject: string;
  baseline: number | null;
  post: number | null;
  delta: number | null;
  window_start: string;
  window_end: string;
  verdict: string | null;
}

/** Persisted proposal lifecycle status. */
export type ProposalStatus = "pending" | "applied" | "refused";

interface ProposalRow {
  id: string;
  subject: string;
  status: string;
  proposal_json: string;
  created_at: string;
  updated_at: string;
}

/** A persisted proposal: the signed Proposal plus its lifecycle status. */
export interface StoredProposal {
  id: string;
  subject: string;
  status: ProposalStatus;
  proposal: Proposal;
  created_at: Date;
  updated_at: Date;
}

function rowToStoredProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status as ProposalStatus,
    // ProposalSchema coerces created_at (string in JSON) back to a Date so the
    // canonical signature re-derivation (which calls created_at.toISOString())
    // matches what was signed at persist time.
    proposal: ProposalSchema.parse(JSON.parse(row.proposal_json)),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function rowToScheduleState(row: SubjectStateRow): ScheduleState {
  return {
    subject: row.subject,
    last_run: new Date(row.last_run),
    next_run: new Date(row.next_run),
    current_interval_hours: row.current_interval_hours,
    consecutive_zero_runs: row.consecutive_zero_runs,
    last_proposal_count: row.last_proposal_count,
    enabled: row.enabled === 1,
  };
}

function rowToRevisionRecord(row: RollbackRow): RevisionRecord {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    subject: row.subject,
    applied_at: new Date(row.applied_at),
    forward_patch: JSON.parse(row.forward_patch_json),
    inverse_patch: JSON.parse(row.inverse_patch_json),
    applied_by: row.applied_by as AppliedBy,
    rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subject_state (
  subject TEXT PRIMARY KEY,
  last_run TEXT NOT NULL,
  next_run TEXT NOT NULL,
  current_interval_hours INTEGER NOT NULL,
  consecutive_zero_runs INTEGER NOT NULL DEFAULT 0,
  last_proposal_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rollback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  forward_patch_json TEXT NOT NULL,
  inverse_patch_json TEXT NOT NULL,
  applied_by TEXT NOT NULL,
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_cache (
  subject TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (subject, observation_id)
);

-- OutcomeLoop ledger. One row per (proposal, metric): baseline snapshotted at
-- apply, post/delta/verdict filled by the maturation pass once windowDays
-- elapse. Reality correction vs spec: PK is (proposal_id, metric) — a single
-- proposal scores several metrics — keyed on the EXISTING proposal id + its
-- commit_sha (no separate revision_id). proposal_id is TEXT to match
-- rollback_history. post/delta/verdict are NULL until maturation.
CREATE TABLE IF NOT EXISTS outcomes (
  proposal_id  TEXT NOT NULL,
  metric       TEXT NOT NULL,
  commit_sha   TEXT,
  subject      TEXT NOT NULL,
  baseline     REAL,
  post         REAL,
  delta        REAL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  verdict      TEXT,
  PRIMARY KEY (proposal_id, metric)
);

-- Proposal queue. The wisecron ProposalEngine returns proposals but does not
-- persist them; this table is the durable approve-then-apply file the CLI/notifier
-- drive. Signed Proposal JSON is stored verbatim so apply-time signature
-- verification round-trips. status: pending → applied | refused.
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  proposal_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Phase 2 substrate (generative ranking). Empty + unused in Phase 1.
CREATE TABLE IF NOT EXISTS priors (
  subject    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ewma_delta REAL NOT NULL DEFAULT 0,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, kind)
);

CREATE INDEX IF NOT EXISTS idx_rollback_subject ON rollback_history(subject, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_rollback_proposal ON rollback_history(proposal_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_collected ON telemetry_cache(subject, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_pending ON outcomes(verdict, window_end);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at DESC);
`;

export class WisecronStateDB {
  private db: Database;
  private readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath.replace(/^~/, homedir());
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── subject_state ─────────────────────────────────────────────────────────

  upsertScheduleState(state: ScheduleState): void {
    this.db
      .prepare(`
      INSERT INTO subject_state(
        subject, last_run, next_run, current_interval_hours,
        consecutive_zero_runs, last_proposal_count, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET
        last_run = excluded.last_run,
        next_run = excluded.next_run,
        current_interval_hours = excluded.current_interval_hours,
        consecutive_zero_runs = excluded.consecutive_zero_runs,
        last_proposal_count = excluded.last_proposal_count,
        enabled = excluded.enabled
    `)
      .run(
        state.subject,
        state.last_run.toISOString(),
        state.next_run.toISOString(),
        state.current_interval_hours,
        state.consecutive_zero_runs,
        state.last_proposal_count,
        state.enabled ? 1 : 0,
      );
  }

  getScheduleState(subject: string): ScheduleState | null {
    const row = this.db.prepare("SELECT * FROM subject_state WHERE subject = ?").get(subject) as
      | SubjectStateRow
      | undefined;
    return row ? rowToScheduleState(row) : null;
  }

  listScheduleStates(): ScheduleState[] {
    const rows = this.db
      .prepare("SELECT * FROM subject_state ORDER BY next_run ASC")
      .all() as SubjectStateRow[];
    return rows.map(rowToScheduleState);
  }

  setEnabled(subject: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE subject_state SET enabled = ? WHERE subject = ?")
      .run(enabled ? 1 : 0, subject);
  }

  // ── rollback_history ──────────────────────────────────────────────────────

  recordApply(record: {
    proposal_id: string;
    subject: string;
    forward_patch: Patch;
    inverse_patch: Patch;
    applied_by: AppliedBy;
  }): number {
    const result = this.db
      .prepare(`
      INSERT INTO rollback_history(
        proposal_id, subject, applied_at,
        forward_patch_json, inverse_patch_json, applied_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        record.proposal_id,
        record.subject,
        new Date().toISOString(),
        JSON.stringify(record.forward_patch),
        JSON.stringify(record.inverse_patch),
        record.applied_by,
      );
    return Number(result.lastInsertRowid);
  }

  markRolledBack(revisionId: number): void {
    this.db
      .prepare("UPDATE rollback_history SET rolled_back_at = ? WHERE id = ?")
      .run(new Date().toISOString(), revisionId);
  }

  getRevision(revisionId: number): RevisionRecord | null {
    const row = this.db.prepare("SELECT * FROM rollback_history WHERE id = ?").get(revisionId) as
      | RollbackRow
      | undefined;
    return row ? rowToRevisionRecord(row) : null;
  }

  listRevisionsBySubject(subject: string, limit = 50): RevisionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM rollback_history WHERE subject = ? ORDER BY applied_at DESC LIMIT ?")
      .all(subject, limit) as RollbackRow[];
    return rows.map(rowToRevisionRecord);
  }

  purgeExpiredRevisions(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const result = this.db.prepare("DELETE FROM rollback_history WHERE applied_at < ?").run(cutoff);
    return Number(result.changes);
  }

  /**
   * The newest still-applied revision for a proposal (rolled_back_at IS NULL),
   * or null if none. Used by the maturation pass to map a regressed proposal
   * back to the revision its defensive revert must replay.
   */
  getActiveRevisionByProposal(proposalId: string): RevisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM rollback_history
         WHERE proposal_id = ? AND rolled_back_at IS NULL
         ORDER BY applied_at DESC LIMIT 1`,
      )
      .get(proposalId) as RollbackRow | undefined;
    return row ? rowToRevisionRecord(row) : null;
  }

  // ── proposals queue ───────────────────────────────────────────────────────

  /**
   * Persist a signed proposal as `pending`. Idempotent on re-run: an existing
   * row (any status) is left untouched, so re-running a cron cycle never
   * resurrects an applied/refused proposal or clobbers its status.
   */
  persistProposal(proposal: Proposal): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
      INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
      .run(String(proposal.id), proposal.subject, JSON.stringify(proposal), now, now);
  }

  listProposals(status?: ProposalStatus): StoredProposal[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC")
            .all(status)
        : this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all()
    ) as ProposalRow[];
    return rows.map(rowToStoredProposal);
  }

  getStoredProposal(id: string): StoredProposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
      | ProposalRow
      | undefined;
    return row ? rowToStoredProposal(row) : null;
  }

  setProposalStatus(id: string, status: ProposalStatus): void {
    this.db
      .prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  // ── telemetry_cache ───────────────────────────────────────────────────────

  cacheTelemetry(subject: string, observationId: string, data: unknown): void {
    this.db
      .prepare(`
      INSERT INTO telemetry_cache(subject, observation_id, collected_at, data_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject, observation_id) DO UPDATE SET
        collected_at = excluded.collected_at,
        data_json = excluded.data_json
    `)
      .run(subject, observationId, new Date().toISOString(), JSON.stringify(data));
  }

  recentTelemetry(
    subject: string,
    sinceIso: string,
  ): Array<{ observation_id: string; data: unknown }> {
    const rows = this.db
      .prepare(`
      SELECT observation_id, data_json FROM telemetry_cache
      WHERE subject = ? AND collected_at >= ?
      ORDER BY collected_at DESC
    `)
      .all(subject, sinceIso) as Array<{ observation_id: string; data_json: string }>;
    return rows.map((r) => ({ observation_id: r.observation_id, data: JSON.parse(r.data_json) }));
  }

  // ── outcomes ledger (OutcomeLoop) ─────────────────────────────────────────

  /**
   * Snapshot the baseline fitness for one (proposal, metric) at apply time.
   * Idempotent: re-snapshotting the same key refreshes baseline + window,
   * leaving post/delta/verdict untouched.
   */
  snapshotBaseline(row: {
    proposal_id: string;
    metric: string;
    commit_sha?: string;
    subject: string;
    baseline: number;
    window_start: Date;
    window_end: Date;
  }): void {
    this.db
      .prepare(`
      INSERT INTO outcomes(
        proposal_id, metric, commit_sha, subject, baseline, window_start, window_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id, metric) DO UPDATE SET
        commit_sha = excluded.commit_sha,
        subject = excluded.subject,
        baseline = excluded.baseline,
        window_start = excluded.window_start,
        window_end = excluded.window_end
    `)
      .run(
        row.proposal_id,
        row.metric,
        row.commit_sha ?? null,
        row.subject,
        row.baseline,
        row.window_start.toISOString(),
        row.window_end.toISOString(),
      );
  }

  /** Fill post / delta / verdict once a window matures. */
  finalizeOutcome(row: {
    proposal_id: string;
    metric: string;
    post: number;
    delta: number;
    verdict: string;
  }): void {
    this.db
      .prepare(`
      UPDATE outcomes SET post = ?, delta = ?, verdict = ?
      WHERE proposal_id = ? AND metric = ?
    `)
      .run(row.post, row.delta, row.verdict, row.proposal_id, row.metric);
  }

  getOutcomes(proposalId: string): OutcomeRow[] {
    return this.db
      .prepare("SELECT * FROM outcomes WHERE proposal_id = ? ORDER BY metric ASC")
      .all(proposalId) as OutcomeRow[];
  }

  /**
   * Outcomes whose verdict is still NULL and whose window_end is at or before
   * `asOf` — i.e. ready for the maturation pass to compute post/delta/verdict.
   */
  listMaturableOutcomes(asOf: Date): OutcomeRow[] {
    return this.db
      .prepare(
        "SELECT * FROM outcomes WHERE verdict IS NULL AND window_end <= ? ORDER BY window_end ASC",
      )
      .all(asOf.toISOString()) as OutcomeRow[];
  }

  // ── priors (Phase 2 substrate; unused in Phase 1) ─────────────────────────

  /** EWMA-update the prior for (subject, kind) with a new observed delta. */
  upsertPrior(subject: string, kind: string, delta: number, alpha = 0.3): void {
    const existing = this.db
      .prepare("SELECT ewma_delta, n FROM priors WHERE subject = ? AND kind = ?")
      .get(subject, kind) as { ewma_delta: number; n: number } | undefined;
    const ewma = existing ? alpha * delta + (1 - alpha) * existing.ewma_delta : delta;
    const n = (existing?.n ?? 0) + 1;
    this.db
      .prepare(`
      INSERT INTO priors(subject, kind, ewma_delta, n) VALUES (?, ?, ?, ?)
      ON CONFLICT(subject, kind) DO UPDATE SET ewma_delta = excluded.ewma_delta, n = excluded.n
    `)
      .run(subject, kind, ewma, n);
  }

  getPrior(subject: string, kind: string): { ewma_delta: number; n: number } | null {
    const row = this.db
      .prepare("SELECT ewma_delta, n FROM priors WHERE subject = ? AND kind = ?")
      .get(subject, kind) as { ewma_delta: number; n: number } | undefined;
    return row ?? null;
  }

  // ── lifecycle / migration ────────────────────────────────────────────────

  static fileExists(dbPath: string): boolean {
    return existsSync(dbPath.replace(/^~/, homedir()));
  }

  /**
   * On corruption detected at open time, backup + recreate fresh schema.
   * Reset subject_state to defaults; rollback_history is lost (acceptable —
   * archived audit log on disk has the trace).
   *
   * **Best-effort contract.** This call closes the bad connection, renames
   * the corrupt file to `*.corrupt-<ISO>`, and opens a fresh DB. Both
   * `subject_state` and `rollback_history` are reset; the only durable trace
   * of pre-corruption applies is the appended audit log on disk. Operators
   * who need rollback history that survives a corruption event should back
   * up `~/.config/tuner/wisecron.db` periodically (e.g. via a daily cron
   * snapshot to a side directory).
   */
  recover(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${this.path}.corrupt-${ts}`;
    try {
      renameSync(this.path, backup);
    } catch {
      /* ignore if missing */
    }
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }
}
