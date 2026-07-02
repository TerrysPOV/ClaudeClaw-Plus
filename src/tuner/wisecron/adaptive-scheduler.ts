import type { WisecronStateDB } from "./state-db.js";
import type { ScheduleState } from "./types.js";
import { INITIAL_INTERVAL_HOURS, MAX_INTERVAL_HOURS } from "./types.js";

/**
 * AdaptiveScheduler — per-subject cadence with backoff.
 *
 * Math (from SPEC):
 *   - First run / reset:           24h
 *   - Each zero-proposal run adds: +24h (linear)
 *   - Cap:                         168h (7 days)
 *   - Any non-zero proposal run:   reset to 24h, consecutive_zero_runs = 0
 *
 * Deterministic: same state in → same next_run out. Tests assert this.
 */
export class AdaptiveScheduler {
  private readonly db: WisecronStateDB;
  private readonly initialHours: number;
  private readonly maxHours: number;
  private readonly now: () => Date;

  constructor(
    db: WisecronStateDB,
    opts: { initialHours?: number; maxHours?: number; now?: () => Date } = {},
  ) {
    this.db = db;
    this.initialHours = opts.initialHours ?? INITIAL_INTERVAL_HOURS;
    this.maxHours = opts.maxHours ?? MAX_INTERVAL_HOURS;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Pick the next subject due. Returns null if none due, or the soonest-due
   * subject with `due=true` if its next_run <= now.
   */
  pickNextSubject(): { subject: string; due: boolean; eta_ms: number } | null {
    const states = this.db.listScheduleStates().filter((s) => s.enabled);
    if (states.length === 0) return null;
    states.sort((a, b) => a.next_run.getTime() - b.next_run.getTime());
    const head = states[0]!;
    const nowMs = this.now().getTime();
    const eta = head.next_run.getTime() - nowMs;
    return { subject: head.subject, due: eta <= 0, eta_ms: eta };
  }

  /**
   * Update state after a collect+propose cycle for `subject`.
   * proposalCount=0 → backoff. proposalCount>0 → reset.
   */
  recordRun(subject: string, proposalCount: number): ScheduleState {
    const existing = this.db.getScheduleState(subject);
    const baseInterval = existing?.current_interval_hours ?? this.initialHours;
    const baseConsecutive = existing?.consecutive_zero_runs ?? 0;
    const enabled = existing?.enabled ?? true;

    const newInterval = this.nextIntervalHours(
      { current_interval_hours: baseInterval, consecutive_zero_runs: baseConsecutive },
      proposalCount,
    );
    const newConsecutive = this.nextConsecutiveZero(baseConsecutive, proposalCount);
    const now = this.now();
    const nextRun = new Date(now.getTime() + newInterval * 3_600_000);

    const state: ScheduleState = {
      subject,
      last_run: now,
      next_run: nextRun,
      current_interval_hours: newInterval,
      consecutive_zero_runs: newConsecutive,
      last_proposal_count: proposalCount,
      enabled,
    };
    this.db.upsertScheduleState(state);
    return state;
  }

  /**
   * Force-run a subject ignoring current cadence. Used by `tuner wisecron run`.
   * After force-run completes, recordRun() applies normal math.
   */
  forceRun(subject: string): void {
    const existing = this.db.getScheduleState(subject);
    const now = this.now();
    const state: ScheduleState = existing
      ? { ...existing, next_run: now }
      : {
          subject,
          last_run: now,
          next_run: now,
          current_interval_hours: this.initialHours,
          consecutive_zero_runs: 0,
          last_proposal_count: 0,
          enabled: true,
        };
    this.db.upsertScheduleState(state);
  }

  /**
   * Reset interval to initial value (24h). Called by `wisecron resume`.
   */
  resetInterval(subject: string): void {
    const existing = this.db.getScheduleState(subject);
    const now = this.now();
    const state: ScheduleState = existing
      ? {
          ...existing,
          current_interval_hours: this.initialHours,
          consecutive_zero_runs: 0,
          next_run: new Date(now.getTime() + this.initialHours * 3_600_000),
        }
      : {
          subject,
          last_run: now,
          next_run: new Date(now.getTime() + this.initialHours * 3_600_000),
          current_interval_hours: this.initialHours,
          consecutive_zero_runs: 0,
          last_proposal_count: 0,
          enabled: true,
        };
    this.db.upsertScheduleState(state);
  }

  /**
   * Initialise subject_state row for a freshly-registered subject.
   * Idempotent: if row exists, no-op.
   */
  ensureRegistered(subject: string): void {
    if (this.db.getScheduleState(subject) !== null) return;
    const now = this.now();
    this.db.upsertScheduleState({
      subject,
      last_run: now,
      next_run: now,
      current_interval_hours: this.initialHours,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: true,
    });
  }

  // ── Pure math helpers (testable in isolation) ─────────────────────────────

  /**
   * Compute the next interval given current state and proposal count.
   * Pure function: no side effects, no I/O. Deterministic.
   */
  nextIntervalHours(
    state: Pick<ScheduleState, "current_interval_hours" | "consecutive_zero_runs">,
    proposalCount: number,
  ): number {
    if (proposalCount > 0) return this.initialHours;
    const next = state.current_interval_hours + this.initialHours;
    return Math.min(next, this.maxHours);
  }

  /**
   * Compute consecutive_zero_runs delta given a proposal count.
   * Pure function.
   */
  nextConsecutiveZero(prev: number, proposalCount: number): number {
    return proposalCount > 0 ? 0 : prev + 1;
  }
}
