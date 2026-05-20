import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ScopeConfig, UsageRecord, ScopeRow } from "./types.js";

const WINDOW_SECONDS = {
  daily: 86400,
  weekly: 604800,
  monthly: 2592000, // 30d approximation
} as const;

export type Window = keyof typeof WINDOW_SECONDS;

function resolvePath(raw: string): string {
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

export class BudgetGuardDb {
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
      CREATE TABLE IF NOT EXISTS scopes (
        scope           TEXT PRIMARY KEY,
        daily_cap_usd   REAL NOT NULL,
        weekly_cap_usd  REAL,
        monthly_cap_usd REAL,
        deny_when_exceeded INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope        TEXT NOT NULL,
        call_id      TEXT NOT NULL UNIQUE,
        model        TEXT NOT NULL,
        cost_usd     REAL NOT NULL,
        tokens_in    INTEGER NOT NULL,
        tokens_out   INTEGER NOT NULL,
        recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_usage_scope_ts ON usage_records(scope, recorded_at)");
  }

  upsertScope(cfg: ScopeConfig): void {
    this.db.run(
      `INSERT INTO scopes (scope, daily_cap_usd, weekly_cap_usd, monthly_cap_usd, deny_when_exceeded)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         daily_cap_usd   = excluded.daily_cap_usd,
         weekly_cap_usd  = excluded.weekly_cap_usd,
         monthly_cap_usd = excluded.monthly_cap_usd,
         deny_when_exceeded = excluded.deny_when_exceeded`,
      [
        cfg.name,
        cfg.daily_cap_usd,
        cfg.weekly_cap_usd ?? null,
        cfg.monthly_cap_usd ?? null,
        cfg.deny_when_exceeded ? 1 : 0,
      ]
    );
  }

  getScope(scope: string): ScopeRow | null {
    return (this.db.query("SELECT * FROM scopes WHERE scope = ?").get(scope) as ScopeRow | null);
  }

  listScopes(): ScopeRow[] {
    return this.db.query("SELECT * FROM scopes ORDER BY scope").all() as ScopeRow[];
  }

  recordUsage(
    scope: string,
    callId: string,
    model: string,
    costUsd: number,
    tokensIn: number,
    tokensOut: number
  ): void {
    this.db.run(
      `INSERT OR IGNORE INTO usage_records (scope, call_id, model, cost_usd, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scope, callId, model, costUsd, tokensIn, tokensOut]
    );
  }

  getUsedInWindow(scope: string, window: Window): number {
    const seconds = WINDOW_SECONDS[window];
    const result = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM usage_records
         WHERE scope = ?
           AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' seconds')`
      )
      .get(scope, `-${seconds}`) as { total: number };
    return result.total;
  }

  getCallCountInWindow(scope: string, window: Window): number {
    const seconds = WINDOW_SECONDS[window];
    const result = this.db
      .query(
        `SELECT COUNT(*) as cnt
         FROM usage_records
         WHERE scope = ?
           AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' seconds')`
      )
      .get(scope, `-${seconds}`) as { cnt: number };
    return result.cnt;
  }

  getLastCallAt(scope: string): string | null {
    const result = this.db
      .query("SELECT MAX(recorded_at) as last FROM usage_records WHERE scope = ?")
      .get(scope) as { last: string | null };
    return result.last;
  }

  resetWindow(scope: string, window: Window | "all"): string[] {
    const resets: string[] = [];
    if (window === "all") {
      this.db.run("DELETE FROM usage_records WHERE scope = ?", [scope]);
      resets.push("daily", "weekly", "monthly");
    } else {
      const seconds = WINDOW_SECONDS[window];
      this.db.run(
        `DELETE FROM usage_records
         WHERE scope = ?
           AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' seconds')`,
        [scope, `-${seconds}`]
      );
      resets.push(window);
    }
    return resets;
  }

  getDbSizeBytes(): number {
    try {
      const result = this.db.query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
      return result.size;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.db.close();
  }
}
