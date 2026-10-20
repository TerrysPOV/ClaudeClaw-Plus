/**
 * #315: the bounded drain the daemon runs on SIGTERM before tearing anything
 * down. Time is virtual — `now`/`sleep` are injected — so every path is exact.
 */
import { describe, expect, it } from "bun:test";
import { drainActiveTurns } from "../shutdown-drain";

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

/** A scripted bus: who is busy at a given virtual time, and which agents emit turn_end. */
function scriptedBus(
  c: ReturnType<typeof clock>,
  schedule: Record<string, { until: number; turnEnd: boolean }>,
) {
  const handlers: Array<(a: string) => void> = [];
  const ended = new Set<string>();
  return {
    busyAgents: () => {
      const busy: string[] = [];
      for (const [agent, s] of Object.entries(schedule)) {
        if (c.at() < s.until) busy.push(agent);
        else if (s.turnEnd && !ended.has(agent)) {
          ended.add(agent);
          for (const h of handlers) h(agent);
        }
      }
      return busy;
    },
    onTurnEnd: (h: (a: string) => void) => {
      handlers.push(h);
      return () => {
        handlers.splice(handlers.indexOf(h), 1);
      };
    },
  };
}

describe("drainActiveTurns (#315)", () => {
  it("with nothing busy it waits only the settle grace (a prompt may land right after the signal), without logging", async () => {
    const c = clock();
    const lines: string[] = [];
    const out = await drainActiveTurns(30_000, {
      busyAgents: () => [],
      log: (l) => lines.push(l),
      settleMs: 1000,
      ...c,
    });
    expect(out.busyAtStart).toEqual([]);
    expect(out.waitedMs).toBe(1000);
    expect(lines).toEqual([]);
  });

  it("drainTurnsMs = 0 with nothing busy returns at once", async () => {
    const c = clock();
    const out = await drainActiveTurns(0, { busyAgents: () => [], ...c });
    expect(out.waitedMs).toBe(0);
  });

  it("a prompt accepted right after the signal enters the busy set during the grace and is drained (#420)", async () => {
    const c = clock();
    const lines: string[] = [];
    // nothing busy at t=0; at 300ms a prompt lands and its turn runs until 900ms
    const bus = scriptedBus(c, { greg: { until: 900, turnEnd: true } });
    const busyAgents = () => (c.at() < 300 ? [] : bus.busyAgents());
    const out = await drainActiveTurns(30_000, {
      busyAgents,
      onTurnEnd: bus.onTurnEnd,
      log: (l) => lines.push(l),
      settleMs: 1000,
      ...c,
    });
    expect(out.busyAtStart).toEqual(["greg"]);
    expect(out.finished).toEqual(["greg"]);
    expect(lines[0]).toContain("became busy right after the signal (greg)");
    expect(lines.at(-1)).toContain("drain complete");
  });

  it("a turn that starts and ends between two polls is seen through its turn_end and gets the settle grace from then (#420)", async () => {
    const c = clock();
    const handlers: Array<(a: string) => void> = [];
    let fired = false;
    // never busy at any poll: the turn lives between the 250ms and 500ms samples
    const out = await drainActiveTurns(30_000, {
      busyAgents: () => [],
      onTurnEnd: (h) => {
        handlers.push(h);
        return () => undefined;
      },
      settleMs: 1000,
      ...c,
      sleep: async (ms) => {
        await c.sleep(ms);
        if (!fired && c.at() >= 480) {
          fired = true;
          for (const h of handlers) h("greg"); // turn_end lands at ~500ms
        }
      },
    });
    expect(out.finished).toEqual(["greg"]);
    // grace re-based on the turn_end (~500ms) → ends ~1500ms, not at the original 1000ms
    expect(out.waitedMs).toBeGreaterThanOrEqual(1500);
    expect(out.waitedMs).toBeLessThan(1500 + 250);
  });

  it("a second signal during the empty-snapshot grace aborts it", async () => {
    const c = clock();
    const out = await drainActiveTurns(30_000, {
      busyAgents: () => [],
      shouldAbort: () => c.at() >= 250,
      settleMs: 1000,
      ...c,
    });
    expect(out.aborted).toBe(true);
    expect(out.waitedMs).toBeLessThan(1000);
  });

  it("waits for the turns to end, settles, and reports them as finished", async () => {
    const c = clock();
    const lines: string[] = [];
    const bus = scriptedBus(c, {
      greg: { until: 600, turnEnd: true },
      suzy: { until: 1100, turnEnd: true },
    });
    const out = await drainActiveTurns(30_000, {
      ...bus,
      log: (l) => lines.push(l),
      settleMs: 1000,
      ...c,
    });
    expect(out.busyAtStart).toEqual(["greg", "suzy"]);
    expect(out.finished.sort()).toEqual(["greg", "suzy"]);
    expect(out.endedWithoutTurnEnd).toEqual([]);
    expect(out.busyAtEnd).toEqual([]);
    expect(out.aborted).toBe(false);
    // 1100ms of turns + the 1000ms settle grace, within one poll
    expect(out.waitedMs).toBeGreaterThanOrEqual(2100);
    expect(out.waitedMs).toBeLessThan(2100 + 250);
    expect(lines[0]).toContain("2 agent(s) still busy (greg, suzy)");
    expect(lines[0]).toContain("up to 30.0s");
    expect(lines[1]).toContain("drain complete");
    expect(lines[1]).toContain("2 turn(s) finished (greg, suzy)");
  });

  it("an agent that leaves the busy set WITHOUT turn_end is reported as such, not as finished", async () => {
    // The KillMode=control-group case: the claude child died with the signal,
    // its IPC closed, the bus cleared its turn. Pre-#315 rev.1 logged
    // "all turns finished" here.
    const c = clock();
    const lines: string[] = [];
    const bus = scriptedBus(c, { greg: { until: 300, turnEnd: false } });
    const out = await drainActiveTurns(30_000, {
      ...bus,
      log: (l) => lines.push(l),
      settleMs: 0,
      ...c,
    });
    expect(out.finished).toEqual([]);
    expect(out.endedWithoutTurnEnd).toEqual(["greg"]);
    expect(lines[1]).toContain("ended without a turn_end (greg)");
    expect(lines[1]).toContain("KillMode=control-group");
    expect(lines[1]).not.toContain("finished");
  });

  it("gives up when the window closes and names what was still busy", async () => {
    const c = clock();
    const lines: string[] = [];
    const out = await drainActiveTurns(2000, {
      busyAgents: () => ["greg"],
      log: (l) => lines.push(l),
      ...c,
    });
    expect(out.busyAtEnd).toEqual(["greg"]);
    expect(out.waitedMs).toBe(2000); // never overshoots the window
    expect(lines[1]).toContain("drain window (2.0s) elapsed");
    expect(lines[1]).toContain("1 agent(s) still busy (greg)");
    expect(lines[1]).toContain("replies are lost");
  });

  it("a second signal aborts the wait", async () => {
    const c = clock();
    const lines: string[] = [];
    const out = await drainActiveTurns(30_000, {
      busyAgents: () => ["greg"],
      shouldAbort: () => c.at() >= 500,
      log: (l) => lines.push(l),
      ...c,
    });
    expect(out.aborted).toBe(true);
    expect(out.busyAtEnd).toEqual(["greg"]);
    expect(out.waitedMs).toBeLessThan(1000);
    expect(lines[1]).toContain("aborted by a second signal");
  });

  it("a second signal during the settle grace aborts it too", async () => {
    const c = clock();
    const bus = scriptedBus(c, { greg: { until: 100, turnEnd: true } });
    const out = await drainActiveTurns(30_000, {
      ...bus,
      settleMs: 5000,
      shouldAbort: () => c.at() >= 600,
      ...c,
    });
    expect(out.finished).toEqual(["greg"]);
    expect(out.aborted).toBe(true);
    expect(out.waitedMs).toBeLessThan(1000);
  });

  it("drainTurnsMs = 0 disables the wait but still reports the busy agents", async () => {
    const c = clock();
    const lines: string[] = [];
    const out = await drainActiveTurns(0, {
      busyAgents: () => ["greg"],
      log: (l) => lines.push(l),
      ...c,
    });
    expect(out.busyAtStart).toEqual(["greg"]);
    expect(out.busyAtEnd).toEqual(["greg"]);
    expect(out.waitedMs).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain disabled");
  });

  it("polls no faster than 250ms and never sleeps past the window", async () => {
    const c = clock();
    const sleeps: number[] = [];
    await drainActiveTurns(600, {
      busyAgents: () => ["greg"],
      ...c,
      sleep: async (ms) => {
        sleeps.push(ms);
        await c.sleep(ms);
      },
    });
    expect(sleeps).toEqual([250, 250, 100]);
  });

  it("the settle grace is bounded by the window too", async () => {
    const c = clock();
    const bus = scriptedBus(c, { greg: { until: 900, turnEnd: true } });
    const out = await drainActiveTurns(1000, { ...bus, settleMs: 5000, ...c });
    expect(out.finished).toEqual(["greg"]);
    expect(out.waitedMs).toBe(1000);
  });

  it("unsubscribes from turn_end when it returns", async () => {
    const c = clock();
    let subs = 0;
    await drainActiveTurns(100, {
      busyAgents: () => (c.at() < 50 ? ["greg"] : []),
      onTurnEnd: () => {
        subs += 1;
        return () => {
          subs -= 1;
        };
      },
      settleMs: 0,
      ...c,
    });
    expect(subs).toBe(0);
  });
});
