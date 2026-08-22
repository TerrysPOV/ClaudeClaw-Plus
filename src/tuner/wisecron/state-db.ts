import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { RevisionRecord, ScheduleState, AppliedBy } from "./types.js";
import type { Patch, PersistedProposal, Proposal } from "../../skills-tuner/core/types.js";
import { PersistedProposalSchema, ProposalSchema } from "../../skills-tuner/core/types.js";

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

/**
 * A proposal the emit gate refused. Distinct from every other failure
 * `persistProposal` can raise — a full disk, a locked database, a corrupt
 * file — because only this one is the SUBJECT's bug. A caller that isolates
 * refusals so one bad proposal cannot end a run must not swallow a disk
 * failure through the same catch and report the run as healthy.
 */
export class ProposalRejectedError extends Error {
  constructor(
    readonly proposalId: number,
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`proposal #${proposalId} from subject '${subject}' is not persistable — ${reason}`);
    this.name = "ProposalRejectedError";
  }
}

/** Persisted proposal lifecycle status — what this binary WRITES. */
export type ProposalStatus = "pending" | "applied" | "refused";

/**
 * Whether a stored status column value is one this binary understands.
 *
 * A store outlives the binary that wrote it: a production store holds rows in
 * `rejected`, a status nothing here writes any more. `StoredProposal.status`
 * is therefore typed as the string it actually is, and code that needs the
 * union narrows through this guard instead of asserting.
 */
export function isKnownProposalStatus(status: string): status is ProposalStatus {
  return status === "pending" || status === "applied" || status === "refused";
}

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
  /** The status column verbatim. Not narrowed to `ProposalStatus`: a row an
   *  older binary wrote can hold a value outside the union. Narrow with
   *  `isKnownProposalStatus` where the union is required. */
  status: string;
  proposal: PersistedProposal;
  created_at: Date;
  updated_at: Date;
}

/** A stored row that could not be rehydrated, reported instead of dropped. */
export interface UnreadableProposalRow {
  id: string;
  subject: string;
  status: string;
  error: string;
}

/** A proposal listing: the rows that parsed, plus the ones that did not. */
export interface ProposalListing {
  proposals: StoredProposal[];
  unreadable: UnreadableProposalRow[];
}

function rowToStoredProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    subject: row.subject,
    // NOT cast to `ProposalStatus`. The column is a plain string and real
    // stores hold values this binary no longer writes — a production store
    // has rows in `rejected`, which the union does not contain. Asserting the
    // narrow type here would lie to every consumer, and that lie is exactly
    // what produced a `counts[row.status]++` yielding NaN in the summary.
    // Callers that need the union narrow it with `isKnownProposalStatus`.
    status: row.status,
    // Read path: PersistedProposalSchema, NOT the emit schema — a row on disk is
    // validated against the shape it was written under, not against the bounds a
    // subject must respect today. It coerces created_at (string in JSON) back to
    // a Date so the canonical signature re-derivation (which calls
    // created_at.toISOString()) matches what was signed at persist time.
    proposal: PersistedProposalSchema.parse(JSON.parse(row.proposal_json)),
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

/**
 * Target schema version. The baseline schema above (all `CREATE TABLE IF NOT
 * EXISTS`) is version 1. Bump this and append a migration to `MIGRATIONS` for
 * the first change that a plain `IF NOT EXISTS` cannot express (e.g. an
 * `ALTER TABLE ... ADD COLUMN` on a table that already exists in older DBs).
 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Forward-only migrations. `MIGRATIONS[v]` upgrades a DB that is at
 * `user_version = v` to `v + 1`. Index 0 (v0 → v1) is intentionally empty:
 * the baseline tables are already materialised by `SCHEMA` via
 * `IF NOT EXISTS`, so first init only needs to stamp `user_version = 1`.
 *
 * To add the first real migration, set `CURRENT_SCHEMA_VERSION = 2` and push a
 * function here that runs the `ALTER TABLE`. Use only static SQL literals — no
 * interpolated identifiers.
 */
const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  // v0 → v1: baseline schema (created by SCHEMA). No forward work required.
  () => {},
];

export class WisecronStateDB {
  private db: Database;
  private readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath.replace(/^~/, homedir());
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  /**
   * Apply forward-only migrations from the DB's current `user_version` up to
   * `CURRENT_SCHEMA_VERSION`, then stamp the new version. On a fresh DB
   * `user_version` is 0, so this simply runs the (empty) v0 → v1 step and marks
   * the DB at version 1. Idempotent: a DB already at the target version does no
   * work. `PRAGMA user_version` cannot be parameterized; the value written is a
   * static integer constant, never user input.
   */
  private runMigrations(): void {
    const { user_version: from } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (from >= CURRENT_SCHEMA_VERSION) return;
    for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
      MIGRATIONS[v]?.(this.db);
    }
    this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
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
   *
   * Returns whether a row was actually INSERTED. That distinction is the
   * whole point of the idempotence: a caller counting "proposals produced"
   * without it counts presentations, and a cron re-running an overlapping
   * window then reports a steady stream while writing nothing.
   */
  persistProposal(proposal: Proposal): boolean {
    // Emit gate. The read path deliberately no longer carries the alternatives
    // upper bound, so this is where a subject that emits past it is rejected:
    // at the write, loudly, while it is still a live bug someone can fix — not
    // on the way back out, years later, against a row nobody can change.
    //
    // The error names the proposal and its subject. A bare ZodError dump gives
    // an operator nothing to act on: a propose cycle walks every subject, and
    // "expected array to have <=20 items" does not say which one produced it.
    const parsed = ProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      const why = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ProposalRejectedError(proposal.id, proposal.subject, why);
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
      INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
      // `parsed.data`, not the caller's object. The emit schema coerces
      // (`created_at: z.coerce.date()`), so a non-TypeScript caller can pass a
      // date as text, satisfy the gate, and have the un-normalised form
      // written — after which the canonical signature, derived from
      // `created_at.toISOString()`, no longer matches on read. Validating and
      // then storing something else makes the gate decorative.
      .run(String(parsed.data.id), parsed.data.subject, JSON.stringify(parsed.data), now, now);
    return result.changes === 1;
  }

  /**
   * Listing with per-row error isolation: one row whose stored JSON no longer
   * parses is reported in `unreadable` instead of aborting the whole query. A
   * listing walks rows the caller did not name — including terminal ones it will
   * never act on — so a single bad row must not be able to hide every good one.
   * Skipped rows are always returned, never dropped silently: the caller decides
   * whether to surface them.
   */
  listProposalsDetailed(status?: ProposalStatus): ProposalListing {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC")
            .all(status)
        : this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all()
    ) as ProposalRow[];
    const proposals: StoredProposal[] = [];
    const unreadable: UnreadableProposalRow[] = [];
    for (const row of rows) {
      try {
        proposals.push(rowToStoredProposal(row));
      } catch (err) {
        unreadable.push({
          id: row.id,
          subject: row.subject,
          status: row.status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { proposals, unreadable };
  }

  /**
   * Existence only — never rehydrates the row, so a row the read schema cannot
   * parse still answers an existence question (dedup) instead of throwing.
   */
  hasProposal(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM proposals WHERE id = ?").get(id) != null;
  }

  /**
   * Whether a stored row can still be rehydrated. Separate from
   * `hasProposal` on purpose: existence answers dedup, readability answers
   * "is this row still usable", and conflating the two lets a caller be told
   * its proposal is queued when the bytes on disk cannot be listed or applied.
   * Returns false for a row that does not exist at all.
   */
  isProposalReadable(id: string): boolean {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
      | ProposalRow
      | undefined;
    if (!row) return false;
    try {
      rowToStoredProposal(row);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Back-compat shim for the pre-isolation signature. `WisecronStateDB` is
   * public surface of a published plugin, so the rename to
   * `listProposalsDetailed` should not silently remove the method an
   * out-of-tree caller depends on.
   *
   * It is NOT a transparent restoration: this shape has nowhere to report a
   * skipped row, so on a degraded store it throws rather than returning a
   * short list the caller has no reason to distrust. That is a deliberate
   * breaking choice — a caller surviving on a degraded store must move to
   * `listProposalsDetailed`, and the error says so.
   */
  listProposals(status?: ProposalStatus): StoredProposal[] {
    const { proposals, unreadable } = this.listProposalsDetailed(status);
    if (unreadable.length > 0) {
      // Refusing beats truncating. This shape has no way to say "and N rows
      // were skipped", so returning the good rows alone would hand a caller a
      // short listing it has no reason to distrust — the exact silent loss
      // this store was changed to stop. A caller that wants to survive a
      // degraded store asks for it explicitly.
      const named = unreadable.slice(0, 20).map((r) => r.id);
      const more = unreadable.length - named.length;
      throw new Error(
        `${unreadable.length} stored proposal(s) could not be rehydrated ` +
          `(${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}); ` +
          `use listProposalsDetailed() to receive them alongside the readable rows`,
      );
    }
    return proposals;
  }

  /**
   * Single-row fetch. Unlike the listing path this still throws on a row that
   * fails to parse: the caller asked for THIS proposal by id, and reporting an
   * unreadable row as `null` would read as "no such proposal" — the lifecycle
   * handlers would then answer "not found" for a row that is on disk.
   */
  getStoredProposal(id: string): StoredProposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
      | ProposalRow
      | undefined;
    if (!row) return null;
    try {
      return rowToStoredProposal(row);
    } catch (err) {
      // Still throws — returning `null` would read as "no such proposal" and
      // send a lifecycle handler down the not-found path for a row that is
      // very much on disk. But it says WHICH row and why, instead of handing
      // an operator a raw schema dump. This is the error they actually hit:
      // apply and refuse both come through here.
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `proposal #${id} (subject '${row.subject}', status '${row.status}') is on disk ` +
          `but its stored JSON no longer rehydrates — ${why}`,
      );
    }
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

  /**
   * EWMA-update the prior for (subject, kind) with a new observed delta.
   *
   * Done as a single atomic `INSERT ... ON CONFLICT DO UPDATE` so concurrent
   * callers cannot lose an update via a read-modify-write race: on first insert
   * the prior seeds to `delta` with `n = 1`; on conflict the blend
   * `alpha*delta + (1-alpha)*ewma_delta` and `n = n + 1` are computed against
   * the row's live values inside the statement. All inputs are `?`-bound.
   */
  upsertPrior(subject: string, kind: string, delta: number, alpha = 0.3): void {
    this.db
      .prepare(`
      INSERT INTO priors(subject, kind, ewma_delta, n) VALUES (?, ?, ?, 1)
      ON CONFLICT(subject, kind) DO UPDATE SET
        ewma_delta = ? * ? + (1 - ?) * priors.ewma_delta,
        n = priors.n + 1
    `)
      .run(subject, kind, delta, alpha, delta, alpha);
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
    // Drop the WAL/SHM sidecars of the corrupt DB. If left behind, SQLite would
    // treat them as belonging to the brand-new file at this.path and try to
    // replay the stale WAL into it — resurrecting corrupt pages or failing the
    // open. Best-effort: they may not exist (e.g. a checkpointed DB).
    for (const sidecar of [`${this.path}-wal`, `${this.path}-shm`]) {
      try {
        unlinkSync(sidecar);
      } catch {
        /* ignore if missing */
      }
    }
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    this.runMigrations();
  }
}
