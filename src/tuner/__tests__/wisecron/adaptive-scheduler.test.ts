import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdaptiveScheduler } from "../../wisecron/adaptive-scheduler.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import { INITIAL_INTERVAL_HOURS, MAX_INTERVAL_HOURS } from "../../wisecron/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let db: WisecronStateDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wisecron-sched-"));
  db = new WisecronStateDB(join(tmpDir, "wisecron.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function frozenNow(d: Date): () => Date {
  return () => d;
}

// ── Pure math ──────────────────────────────────────────────────────────────

describe("AdaptiveScheduler — pure math", () => {
  it("nextIntervalHours: zero-proposal run climbs 24 → 48 → 72 → … → 168 (cap)", () => {
    const s = new AdaptiveScheduler(db);
    const sequence: number[] = [];
    let current = INITIAL_INTERVAL_HOURS;
    for (let i = 0; i < 10; i++) {
      current = s.nextIntervalHours(
        { current_interval_hours: current, consecutive_zero_runs: i },
        0,
      );
      sequence.push(current);
    }
    expect(sequence[0]).toBe(48);
    expect(sequence[1]).toBe(72);
    expect(sequence[2]).toBe(96);
    expect(sequence[3]).toBe(120);
    expect(sequence[4]).toBe(144);
    expect(sequence[5]).toBe(168);
    // Cap holds
    expect(sequence[6]).toBe(168);
    expect(sequence[9]).toBe(168);
    expect(sequence.every((v) => v <= MAX_INTERVAL_HOURS)).toBe(true);
  });

  it("nextIntervalHours: any non-zero proposal resets to initial (24h)", () => {
    const s = new AdaptiveScheduler(db);
    expect(s.nextIntervalHours({ current_interval_hours: 168, consecutive_zero_runs: 6 }, 1)).toBe(
      24,
    );
    expect(s.nextIntervalHours({ current_interval_hours: 96, consecutive_zero_runs: 3 }, 5)).toBe(
      24,
    );
  });

  it("nextConsecutiveZero: increments on zero-run, resets to 0 on non-zero", () => {
    const s = new AdaptiveScheduler(db);
    expect(s.nextConsecutiveZero(0, 0)).toBe(1);
    expect(s.nextConsecutiveZero(5, 0)).toBe(6);
    expect(s.nextConsecutiveZero(5, 3)).toBe(0);
    expect(s.nextConsecutiveZero(0, 1)).toBe(0);
  });

  it("pure helpers are deterministic across identical inputs", () => {
    const s = new AdaptiveScheduler(db);
    const input = { current_interval_hours: 72, consecutive_zero_runs: 2 };
    expect(s.nextIntervalHours(input, 0)).toBe(s.nextIntervalHours(input, 0));
    expect(s.nextConsecutiveZero(2, 0)).toBe(s.nextConsecutiveZero(2, 0));
  });
});

// ── State machine ──────────────────────────────────────────────────────────

describe("AdaptiveScheduler — state machine", () => {
  it("ensureRegistered: idempotent (re-call leaves state untouched)", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    const first = db.getScheduleState("cron")!;
    // Re-call after time has passed — should be no-op
    const s2 = new AdaptiveScheduler(db, { now: frozenNow(new Date("2026-01-02T00:00:00Z")) });
    s2.ensureRegistered("cron");
    const second = db.getScheduleState("cron")!;
    expect(second.last_run.toISOString()).toBe(first.last_run.toISOString());
    expect(second.current_interval_hours).toBe(first.current_interval_hours);
  });

  it("recordRun: zero proposals → next_run = now + 48h on run 1", () => {
    const t0 = new Date("2026-01-01T12:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    const state = s.recordRun("cron", 0);
    expect(state.current_interval_hours).toBe(48);
    expect(state.next_run.getTime() - t0.getTime()).toBe(48 * 3_600_000);
    expect(state.consecutive_zero_runs).toBe(1);
  });

  it("recordRun: 6 consecutive zero runs → next_run = now + 168h (cap)", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    let state = db.getScheduleState("cron")!;
    for (let i = 0; i < 6; i++) state = s.recordRun("cron", 0);
    expect(state.current_interval_hours).toBe(168);
    expect(state.consecutive_zero_runs).toBe(6);
    // 7th zero run should stay at cap
    state = s.recordRun("cron", 0);
    expect(state.current_interval_hours).toBe(168);
  });

  it("recordRun: non-zero proposal mid-streak resets interval to 24h", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    for (let i = 0; i < 3; i++) s.recordRun("cron", 0);
    const state = s.recordRun("cron", 2);
    expect(state.current_interval_hours).toBe(24);
    expect(state.consecutive_zero_runs).toBe(0);
    expect(state.last_proposal_count).toBe(2);
  });

  it("forceRun: sets next_run to now → pickNextSubject returns it", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    s.ensureRegistered("hook");
    s.recordRun("cron", 0); // pushes cron to +48h
    s.recordRun("hook", 0); // pushes hook to +48h
    s.forceRun("cron");
    const next = s.pickNextSubject();
    expect(next?.subject).toBe("cron");
    expect(next?.due).toBe(true);
  });

  it("resetInterval: pause+resume cycle restores 24h cadence + zero consecutive", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    for (let i = 0; i < 4; i++) s.recordRun("cron", 0);
    expect(db.getScheduleState("cron")?.current_interval_hours).toBeGreaterThan(24);
    s.resetInterval("cron");
    const after = db.getScheduleState("cron")!;
    expect(after.current_interval_hours).toBe(24);
    expect(after.consecutive_zero_runs).toBe(0);
  });
});

// ── Picking ────────────────────────────────────────────────────────────────

describe("AdaptiveScheduler — picking", () => {
  it("pickNextSubject returns soonest due subject, due=true when next_run <= now", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    db.upsertScheduleState({
      subject: "cron",
      last_run: new Date(t0.getTime() - 48 * 3_600_000),
      next_run: new Date(t0.getTime() - 3_600_000), // 1h overdue
      current_interval_hours: 24,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: true,
    });
    db.upsertScheduleState({
      subject: "hook",
      last_run: new Date(t0.getTime() - 48 * 3_600_000),
      next_run: new Date(t0.getTime() - 7_200_000), // 2h overdue (sooner)
      current_interval_hours: 24,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: true,
    });
    const next = s.pickNextSubject();
    expect(next?.subject).toBe("hook");
    expect(next?.due).toBe(true);
    expect(next?.eta_ms).toBeLessThan(0);
  });

  it("pickNextSubject returns null when no subjects enabled", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    expect(s.pickNextSubject()).toBeNull();
    db.upsertScheduleState({
      subject: "cron",
      last_run: t0,
      next_run: t0,
      current_interval_hours: 24,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: false,
    });
    expect(s.pickNextSubject()).toBeNull();
  });

  it("pickNextSubject skips disabled subjects", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    db.upsertScheduleState({
      subject: "cron",
      last_run: t0,
      next_run: new Date(t0.getTime() - 3_600_000),
      current_interval_hours: 24,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: false,
    });
    db.upsertScheduleState({
      subject: "hook",
      last_run: t0,
      next_run: new Date(t0.getTime() + 24 * 3_600_000),
      current_interval_hours: 24,
      consecutive_zero_runs: 0,
      last_proposal_count: 0,
      enabled: true,
    });
    const next = s.pickNextSubject();
    expect(next?.subject).toBe("hook");
    expect(next?.due).toBe(false);
  });
});

// ── 7-day simulation ───────────────────────────────────────────────────────

describe("AdaptiveScheduler — 7-day simulation", () => {
  it("always-empty proposals: interval 24→48→72→96→120→144→168→168", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    const observed: number[] = [];
    for (let i = 0; i < 8; i++) {
      const st = s.recordRun("cron", 0);
      observed.push(st.current_interval_hours);
    }
    expect(observed).toEqual([48, 72, 96, 120, 144, 168, 168, 168]);
  });

  it("sporadic proposals (every 3rd run): interval stays 24-72h, never hits cap", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const s = new AdaptiveScheduler(db, { now: frozenNow(t0) });
    s.ensureRegistered("cron");
    const observed: number[] = [];
    for (let i = 0; i < 15; i++) {
      const proposals = (i + 1) % 3 === 0 ? 2 : 0;
      const st = s.recordRun("cron", proposals);
      observed.push(st.current_interval_hours);
    }
    expect(Math.max(...observed)).toBeLessThanOrEqual(72);
    expect(observed).toContain(24);
    expect(observed).toContain(48);
    expect(observed).toContain(72);
  });
});
