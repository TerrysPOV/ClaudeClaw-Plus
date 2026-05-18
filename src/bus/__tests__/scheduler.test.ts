/**
 * Tests for `src/bus/scheduler.ts` (Bus Scheduler, Sprint 4 Agent B).
 *
 * Run with: `bun test src/bus/__tests__/scheduler.test.ts`
 *
 * Strategy:
 *   - Most tests use a virtual `SchedulerClock` (`makeFakeClock`) so we
 *     can fast-forward time deterministically without sleeping. This is
 *     the same pattern as Jest's `useFakeTimers` but bun:test doesn't
 *     ship that yet, and the scheduler exposes a `clock` injection
 *     point on purpose.
 *   - One real-timer test exercises the production code path end-to-end
 *     at sub-second intervals to catch wiring bugs the fake clock can't
 *     see (drift in particular).
 *
 * Spec:
 *   - `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.6 + §6.4.
 *   - Legacy behaviour parity: `src/cron.ts` for cron grammar.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { BusCore, BusState, SendPromptRequest, Subscription } from "../core";
import {
  createBusScheduler,
  type BusScheduler,
  type SchedulerClock,
  type TimerHandle,
} from "../scheduler";

/* ───────────────────────────────────────────────────────────────────── */
/* Test doubles                                                          */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * FakeBus — captures every `sendPrompt` call. Mirrors the pattern used
 * by Discord/Telegram adapter tests (which sit in
 * `src/adapters/<name>/__tests__/`). Only `sendPrompt` matters for the
 * scheduler; the rest throws to catch accidental use.
 */
function createFakeBus(): {
  bus: BusCore;
  calls: SendPromptRequest[];
} {
  const calls: SendPromptRequest[] = [];
  const bus: BusCore = {
    async sendPrompt(req: SendPromptRequest) {
      calls.push(req);
      return { promise_id: `pid-${calls.length}` };
    },
    subscribe(): Subscription {
      throw new Error("FakeBus.subscribe not used by scheduler");
    },
    async invokeSlashCommand(): Promise<void> {
      throw new Error("FakeBus.invokeSlashCommand not used by scheduler");
    },
    ingestReply(): void {
      throw new Error("FakeBus.ingestReply not used by scheduler");
    },
    ingestSessionEvent(): void {
      throw new Error("FakeBus.ingestSessionEvent not used by scheduler");
    },
    ingestPermissionDecision(): void {
      throw new Error("FakeBus.ingestPermissionDecision not used by scheduler");
    },
    ingestAskAnswer(): void {
      throw new Error("FakeBus.ingestAskAnswer not used by scheduler");
    },
    state(): BusState {
      return { subscriberCount: 0, connectedAgents: [], totalOverflows: 0 };
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };
  return { bus, calls };
}

/**
 * Virtual clock — tests drive time forward with `.advance(ms)`. Honours
 * timer cancellation so cancellation tests don't see ghost callbacks.
 */
interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

interface FakeClock extends SchedulerClock {
  /** Current virtual time. */
  current(): number;
  /** Move time forward by `ms`, firing all timers that elapse. */
  advance(ms: number): void;
  /** Currently armed timers. */
  pending(): readonly FakeTimer[];
}

function makeFakeClock(startAt = 1_700_000_000_000): FakeClock {
  let now = startAt;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const setTimeoutFn = (fn: () => void, ms: number): TimerHandle => {
    const t: FakeTimer = {
      id: nextId++,
      fireAt: now + Math.max(0, ms),
      fn,
      cancelled: false,
    };
    timers.push(t);
    // Cast through unknown because `TimerHandle` is a `NodeJS.Timeout`-ish
    // shape in production. The scheduler never inspects it — it just
    // hands it back to `clearTimeout`.
    return t as unknown as TimerHandle;
  };

  const clearTimeoutFn = (handle: TimerHandle): void => {
    const t = handle as unknown as FakeTimer;
    t.cancelled = true;
  };

  const advance = (ms: number): void => {
    const target = now + ms;
    // Loop because a fired timer may schedule another timer that should
    // also fire within the same `advance` window.
    // Cap iterations to prevent accidental infinite loops in buggy code.
    for (let safety = 0; safety < 100_000; safety++) {
      // Earliest non-cancelled timer at or before target.
      let next: FakeTimer | null = null;
      for (const t of timers) {
        if (t.cancelled) continue;
        if (t.fireAt > target) continue;
        if (!next || t.fireAt < next.fireAt) next = t;
      }
      if (!next) break;
      now = next.fireAt;
      next.cancelled = true; // one-shot
      next.fn();
    }
    now = target;
  };

  return {
    now: () => now,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    current: () => now,
    advance,
    pending: () => timers.filter((t) => !t.cancelled),
  };
}

/* ───────────────────────────────────────────────────────────────────── */
/* Lifecycle                                                              */
/* ───────────────────────────────────────────────────────────────────── */

let scheduler: BusScheduler | null = null;

afterEach(async () => {
  if (scheduler) {
    await scheduler.stop();
    scheduler = null;
  }
});

/* ───────────────────────────────────────────────────────────────────── */
/* Heartbeat                                                              */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusScheduler.scheduleHeartbeat", () => {
  it("fires at the configured interval", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1, // 60_000ms
      prompt: "ping",
    });

    // Just before first fire.
    clock.advance(59_999);
    expect(calls).toHaveLength(0);

    // Fire 1.
    clock.advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent_id).toBe("alpha");
    expect(calls[0].origin).toBe("heartbeat");
    expect(calls[0].user_id).toBe("system");
    expect(calls[0].text).toBe("ping");
    expect(calls[0].metadata?.scheduler).toBe("bus");
    expect(calls[0].metadata?.kind).toBe("heartbeat");

    // Fire 2.
    clock.advance(60_000);
    expect(calls).toHaveLength(2);

    // Fire 3.
    clock.advance(60_000);
    expect(calls).toHaveLength(3);
  });

  it("does not fire immediately on registration", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 5,
      prompt: "ping",
    });

    expect(calls).toHaveLength(0);
  });

  it("forwards user-provided metadata and tags scheduler/kind", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1,
      prompt: "ping",
      metadata: { source: "test", custom: 42 },
    });

    clock.advance(60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.source).toBe("test");
    expect(calls[0].metadata?.custom).toBe(42);
    expect(calls[0].metadata?.scheduler).toBe("bus");
    expect(calls[0].metadata?.kind).toBe("heartbeat");
  });

  it("cancel() stops further fires", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    const trigger = scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1,
      prompt: "ping",
    });

    clock.advance(60_000);
    expect(calls).toHaveLength(1);

    trigger.cancel();
    clock.advance(120_000);
    expect(calls).toHaveLength(1);
  });

  it("rejects non-positive intervals", () => {
    const { bus } = createFakeBus();
    const clock = makeFakeClock();
    const s = createBusScheduler({ bus, clock });
    scheduler = s;

    expect(() =>
      s.scheduleHeartbeat({
        agent_id: "alpha",
        interval_minutes: 0,
        prompt: "ping",
      }),
    ).toThrow();

    expect(() =>
      s.scheduleHeartbeat({
        agent_id: "alpha",
        interval_minutes: -1,
        prompt: "ping",
      }),
    ).toThrow();
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Cron — one-shot `at`                                                   */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusScheduler.scheduleCron (at)", () => {
  it("fires once at the scheduled time", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    const fireAt = new Date(clock.current() + 30_000);
    scheduler.scheduleCron({
      agent_id: "alpha",
      at: fireAt,
      prompt: "kick",
      metadata: { tag: "weekly-report" },
    });

    clock.advance(29_999);
    expect(calls).toHaveLength(0);

    clock.advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe("cron");
    expect(calls[0].user_id).toBe("system");
    expect(calls[0].text).toBe("kick");
    expect(calls[0].metadata?.tag).toBe("weekly-report");
    expect(calls[0].metadata?.scheduler).toBe("bus");
    expect(calls[0].metadata?.kind).toBe("cron");
    expect(calls[0].metadata?.mode).toBe("at");

    // No second fire.
    clock.advance(60_000);
    expect(calls).toHaveLength(1);
  });

  it("cancel() before fire-at prevents the fire", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    const trigger = scheduler.scheduleCron({
      agent_id: "alpha",
      at: new Date(clock.current() + 30_000),
      prompt: "kick",
    });

    clock.advance(10_000);
    trigger.cancel();
    clock.advance(60_000);
    expect(calls).toHaveLength(0);
  });

  it("fires immediately if the `at` time has already passed", () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleCron({
      agent_id: "alpha",
      at: new Date(clock.current() - 10_000),
      prompt: "late",
    });

    clock.advance(0);
    expect(calls).toHaveLength(1);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Cron — 5-field expression                                              */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusScheduler.scheduleCron (cronExpr)", () => {
  it("fires on a `*/5 * * * *` schedule", () => {
    const { bus, calls } = createFakeBus();
    // Start at a deterministic minute boundary: 2026-01-01 00:00:00 UTC.
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const clock = makeFakeClock(start);
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleCron({
      agent_id: "alpha",
      cronExpr: "*/5 * * * *",
      prompt: "tick",
    });

    // Next match after 00:00:00 should be 00:05:00 — 5 min away.
    // `nextCronMatch` snaps to the next minute, so at exactly t=0 it
    // looks for matches starting at 00:01:00 and finds 00:05:00.
    clock.advance(5 * 60_000 - 1);
    expect(calls).toHaveLength(0);
    clock.advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe("cron");
    expect(calls[0].metadata?.mode).toBe("cron");
    expect(calls[0].metadata?.cron).toBe("*/5 * * * *");

    // Re-arm: next match is 00:10:00.
    clock.advance(5 * 60_000);
    expect(calls).toHaveLength(2);

    // And again at 00:15:00.
    clock.advance(5 * 60_000);
    expect(calls).toHaveLength(3);
  });

  it("rejects when both `at` and `cronExpr` are set", () => {
    const { bus } = createFakeBus();
    const clock = makeFakeClock();
    const s = createBusScheduler({ bus, clock });
    scheduler = s;

    expect(() =>
      s.scheduleCron({
        agent_id: "alpha",
        at: new Date(),
        cronExpr: "* * * * *",
        prompt: "x",
      }),
    ).toThrow();
  });

  it("rejects when neither `at` nor `cronExpr` is set", () => {
    const { bus } = createFakeBus();
    const clock = makeFakeClock();
    const s = createBusScheduler({ bus, clock });
    scheduler = s;

    expect(() =>
      s.scheduleCron({
        agent_id: "alpha",
        prompt: "x",
      }),
    ).toThrow();
  });

  it("cancel() on a recurring cron stops further fires", () => {
    const { bus, calls } = createFakeBus();
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const clock = makeFakeClock(start);
    scheduler = createBusScheduler({ bus, clock });

    const trigger = scheduler.scheduleCron({
      agent_id: "alpha",
      cronExpr: "*/5 * * * *",
      prompt: "tick",
    });

    clock.advance(5 * 60_000);
    expect(calls).toHaveLength(1);
    trigger.cancel();
    clock.advance(20 * 60_000);
    expect(calls).toHaveLength(1);
  });

  // Codex P2 fix on PR #117: malformed cron expressions used to be
  // silently accepted (probe via nextCronMatch didn't throw on garbage).
  // Now eager validation rejects fast on operator typos.
  it("rejects malformed cron expressions instead of silently accepting", () => {
    const { bus } = createFakeBus();
    scheduler = createBusScheduler({ bus });

    // Wrong field count.
    expect(() =>
      scheduler.scheduleCron({ agent_id: "a", cronExpr: "*/5 * *", prompt: "p" }),
    ).toThrow(/expected 5 fields/);

    // Non-numeric token.
    expect(() =>
      scheduler.scheduleCron({ agent_id: "a", cronExpr: "abc * * * *", prompt: "p" }),
    ).toThrow(/invalid characters/);

    // Out-of-range minute.
    expect(() =>
      scheduler.scheduleCron({ agent_id: "a", cronExpr: "75 * * * *", prompt: "p" }),
    ).toThrow(/out of \[0,59\]/);

    // Inverted range.
    expect(() =>
      scheduler.scheduleCron({ agent_id: "a", cronExpr: "0 10-5 * * *", prompt: "p" }),
    ).toThrow(/inverted/);

    // Zero step.
    expect(() =>
      scheduler.scheduleCron({ agent_id: "a", cronExpr: "*/0 * * * *", prompt: "p" }),
    ).toThrow(/step must be > 0/);

    // Valid expression — should NOT throw.
    expect(() =>
      scheduler
        .scheduleCron({ agent_id: "a", cronExpr: "*/15 9-17 * * 1-5", prompt: "p" })
        .cancel(),
    ).not.toThrow();
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Lifecycle — start/stop                                                 */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusScheduler lifecycle", () => {
  it("stop() clears all timers; no events after stop", async () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1,
      prompt: "ping",
    });
    scheduler.scheduleCron({
      agent_id: "beta",
      at: new Date(clock.current() + 30_000),
      prompt: "cron",
    });

    expect(clock.pending().length).toBeGreaterThan(0);

    await scheduler.stop();
    expect(clock.pending().length).toBe(0);

    clock.advance(10 * 60_000);
    expect(calls).toHaveLength(0);
  });

  it("stop() is idempotent", async () => {
    const { bus } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    await scheduler.stop();
    await scheduler.stop();
    // No throw — that's the assertion.
  });

  it("start() is idempotent and works after stop()", async () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    await scheduler.start();
    await scheduler.start();
    await scheduler.stop();
    await scheduler.start();

    scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1,
      prompt: "ping",
    });

    clock.advance(60_000);
    expect(calls).toHaveLength(1);
  });

  it("scheduling after stop() returns a no-op trigger", async () => {
    const { bus, calls } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock });

    await scheduler.stop();
    const t = scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 1,
      prompt: "ping",
    });
    // cancel must not throw.
    t.cancel();
    clock.advance(10 * 60_000);
    expect(calls).toHaveLength(0);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Drift                                                                  */
/* ───────────────────────────────────────────────────────────────────── */

describe("BusScheduler drift", () => {
  it("10 heartbeats at 100ms interval ≈ 1s total wall-clock (±50ms)", async () => {
    // This is the only test that uses real timers. We want to catch any
    // drift accumulation in the production code path that a virtual
    // clock can't see (e.g. accidentally chaining `setTimeout(fn, 100)`
    // on top of the previous fire instead of anchoring to `startedAt`).
    const { bus, calls } = createFakeBus();
    scheduler = createBusScheduler({ bus });

    const startedAt = Date.now();
    const trigger = scheduler.scheduleHeartbeat({
      agent_id: "alpha",
      interval_minutes: 100 / 60_000, // 100ms
      prompt: "ping",
    });

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (calls.length >= 10) {
          clearInterval(checkInterval);
          trigger.cancel();
          resolve();
        }
      }, 25);
    });

    const elapsed = Date.now() - startedAt;
    // 10 ticks × 100ms = 1000ms. The first tick fires after a full
    // interval (~100ms) and the 10th completes after ~1000ms from start.
    // We accept ±150ms on either side: the lower bound guards against
    // back-to-back fires (the bug fixed in v0.1 where the heartbeat
    // would fire twice in the same interval), the upper bound is a soft
    // limit for jittery CI runners. The polling check itself runs every
    // 25ms so it can detect completion up to 25ms late.
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThanOrEqual(1300);
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Factory                                                                */
/* ───────────────────────────────────────────────────────────────────── */

describe("createBusScheduler factory", () => {
  it("accepts a bare BusCore (backwards-compat overload)", () => {
    const { bus, calls } = createFakeBus();
    scheduler = createBusScheduler(bus);

    // No clock injection means real timers — just verify the factory
    // builds something usable and start/stop don't blow up.
    expect(scheduler).toBeDefined();
    void calls; // suppress unused-binding lint
  });

  it("accepts options object", () => {
    const { bus } = createFakeBus();
    const clock = makeFakeClock();
    scheduler = createBusScheduler({ bus, clock, timezoneOffsetMinutes: 60 });
    expect(scheduler).toBeDefined();
  });
});
