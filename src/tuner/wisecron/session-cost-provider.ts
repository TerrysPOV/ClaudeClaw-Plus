/**
 * Reference `session_cost` TelemetryProvider (OutcomeLoop Phase 1).
 *
 * This is a HOST-side adapter, not tuner core: it owns telemetry PRODUCTION +
 * provenance for ONE stream (`session_cost`) by reading a per-session cost
 * store. Subjects never see this file — they call `provider.query(...)`. The
 * tuner core stays source-agnostic; swapping the cost store (or shipping a
 * different host) means swapping this adapter, nothing else.
 *
 * Source of truth (reference deployment): a SQLite `session_costs` table with
 * columns `date, job, model, cost_usd, *_tokens`. One row per Claude session.
 *   - `value`  ← `cost_usd` (USD spent in the session)
 *   - `ts`     ← `date` (day-granular; see ATTRIBUTION NOTE below)
 *   - `labels` ← `{ job, model }`
 *
 * Capability detection: `session_cost` is advertised `available:true` only when
 * the store exists AND holds rows; otherwise `available:false` with a reason,
 * so the activation gate degrades the dependent fitness to proposal-only. Every
 * other contract stream is advertised `available:false` (no producer in this
 * reference host) — a customer host implements its own provider for those.
 *
 * ATTRIBUTION NOTE (imperfect, flagged): `job` is free-text — sometimes a clean
 * tag (`bootstrap`, `gmail`), often a raw prompt prefix (`<channel source="cron"
 * …>`, `Tu es l'agent …`). Exact-match label filtering is therefore brittle;
 * subjects that need a subset (e.g. cron-origin sessions) should query broadly
 * and post-filter on `labels.job`. And `date` is day-granular, so a window edge
 * is rounded to the day. Both are properties of the store, not the contract.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  type DateRange,
  type MetricSample,
  type TelemetryCapability,
  type TelemetryProvider,
  type TelemetryStream,
  TELEMETRY_CONTRACT_VERSION,
  TELEMETRY_STREAMS,
} from "../../skills-tuner/core/telemetry.js";

export interface SessionCostProviderConfig {
  /** Path to the cost SQLite store. Default `~/agent/data/costs.db`. */
  dbPath?: string;
  /** Schema version advertised for the `session_cost` stream. */
  schemaVersion?: string;
}

interface CostRow {
  date: string;
  job: string;
  model: string;
  cost_usd: number;
}

/** `YYYY-MM-DD` in UTC — matches the store's day-granular `date` column. */
function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class SessionCostTelemetryProvider implements TelemetryProvider {
  private readonly dbPath: string;
  private readonly schemaVersion: string;
  /** Lazily opened, cached, read-only handle; null once we know it's absent. */
  private db: Database | null = null;
  private opened = false;

  constructor(cfg: SessionCostProviderConfig = {}) {
    this.dbPath = (cfg.dbPath ?? `${homedir()}/agent/data/costs.db`).replace(/^~/, homedir());
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  /**
   * Open (once) and return the read-only handle, or null if the store is
   * missing/unopenable. Cached so capabilities() + query() share one probe.
   */
  private handle(): Database | null {
    if (this.opened) return this.db;
    this.opened = true;
    if (!existsSync(this.dbPath)) {
      this.db = null;
      return null;
    }
    try {
      this.db = new Database(this.dbPath, { readonly: true });
    } catch {
      this.db = null;
    }
    return this.db;
  }

  /** Row count in session_costs, or null if the table is absent/unreadable. */
  private rowCount(db: Database): number | null {
    try {
      const r = db.query("SELECT COUNT(*) AS n FROM session_costs").get() as { n: number } | null;
      return r ? r.n : 0;
    } catch {
      return null;
    }
  }

  capabilities(): TelemetryCapability[] {
    const db = this.handle();
    let costCap: TelemetryCapability;
    if (!db) {
      costCap = {
        stream: "session_cost",
        schemaVersion: this.schemaVersion,
        available: false,
        reason: `cost store not found at ${this.dbPath}`,
      };
    } else {
      const n = this.rowCount(db);
      if (n === null) {
        costCap = {
          stream: "session_cost",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: "session_costs table missing or unreadable",
        };
      } else if (n === 0) {
        costCap = {
          stream: "session_cost",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: "session_costs table empty",
        };
      } else {
        costCap = { stream: "session_cost", schemaVersion: this.schemaVersion, available: true };
      }
    }

    // Every other contract stream: no producer in this reference host.
    const others: TelemetryCapability[] = TELEMETRY_STREAMS.filter((s) => s !== "session_cost").map(
      (stream) => ({
        stream,
        schemaVersion: this.schemaVersion,
        available: false,
        reason: "no producer wired in this reference host environment",
      }),
    );

    return [costCap, ...others];
  }

  /**
   * Pull samples for a stream over `[range.start, range.end)`. Only
   * `session_cost` returns data here; any other stream yields `[]` (no producer
   * in this host). `filters` apply exact label equality on `job` / `model` when
   * supplied — but see ATTRIBUTION NOTE: `job` is brittle for exact match, so
   * callers needing a subset should query broadly and post-filter.
   */
  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    if (stream !== "session_cost") return [];
    const db = this.handle();
    if (!db) return [];
    if (this.rowCount(db) === null) return [];

    const clauses = ["date >= ?", "date < ?"];
    const params: string[] = [toDay(range.start), toDay(range.end)];
    if (filters?.job !== undefined) {
      clauses.push("job = ?");
      params.push(filters.job);
    }
    if (filters?.model !== undefined) {
      clauses.push("model = ?");
      params.push(filters.model);
    }

    let rows: CostRow[];
    try {
      rows = db
        .query(
          `SELECT date, job, model, cost_usd FROM session_costs
           WHERE ${clauses.join(" AND ")}
           ORDER BY date ASC`,
        )
        .all(...params) as CostRow[];
    } catch {
      return [];
    }

    return rows.map((r) => ({
      ts: new Date(`${r.date}T00:00:00.000Z`),
      value: typeof r.cost_usd === "number" ? r.cost_usd : Number(r.cost_usd) || 0,
      labels: { job: r.job ?? "", model: r.model ?? "" },
    }));
  }

  /** Release the read-only handle. Safe to call repeatedly. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
    this.db = null;
    this.opened = false;
  }
}
