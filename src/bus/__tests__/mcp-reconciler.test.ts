import { describe, it, expect } from "bun:test";
import { createMcpReconciler, type McpReconcilerDeps } from "../mcp-reconciler";

/**
 * Deterministic harness: manual timer queue + mutable clock so confirm-delay,
 * cooldown, and the attempt cap can be exercised without real time.
 */
function harness(over: Partial<McpReconcilerDeps> = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  let clock = 1_000_000;
  const restartCalls: string[] = [];

  const deps: McpReconcilerDeps = {
    isConnected: () => false,
    isProcessAlive: () => true,
    restart: async (id) => {
      restartCalls.push(id);
    },
    log: (msg, fields) => logs.push({ msg, fields }),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    now: () => clock,
    ...over,
  };

  return {
    deps,
    logs,
    restartCalls,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    // Fire all currently-queued timers (simulating their delay elapsing) and
    // let the restart promise's .then run.
    flush: async () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createMcpReconciler (#222)", () => {
  it("does not restart on the bare signal — arms a confirm timer first", () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "test" });
    expect(h.restartCalls).toEqual([]);
    expect(h.timers.length).toBe(1);
    expect(h.logs.some((l) => l.msg === "reconcile-armed")).toBe(true);
  });

  it("restarts when still disconnected + alive after the confirm window", async () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "test" });
    await h.flush();
    expect(h.restartCalls).toEqual(["default"]);
  });

  it("does NOT restart if the agent reconnected during the confirm window", async () => {
    let connected = false;
    const h = harness({ isConnected: () => connected });
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "test" });
    connected = true; // mcp-server re-handshaked on its own
    await h.flush();
    expect(h.restartCalls).toEqual([]);
    expect(h.logs.some((l) => l.msg === "reconcile-recovered")).toBe(true);
  });

  it("does NOT restart if the process is not alive (supervisor owns respawn)", async () => {
    const h = harness({ isProcessAlive: () => false });
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "test" });
    await h.flush();
    expect(h.restartCalls).toEqual([]);
    expect(h.logs.some((l) => l.msg === "reconcile-skip")).toBe(true);
  });

  it("does NOT restart while a turn is actively streaming — defers until the turn ends (#252 stack ultra)", async () => {
    let turnActive = true;
    const h = harness({ isTurnActive: () => turnActive });
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "test" });
    await h.flush(); // confirm window fires: turn active → skip + re-arm, no restart
    expect(h.restartCalls).toEqual([]);
    expect(
      h.logs.some((l) => l.msg === "reconcile-skip" && l.fields.reason === "turn-active"),
    ).toBe(true);
    // The turn ends; the deferred re-check now restarts the still-deaf agent.
    turnActive = false;
    await h.flush();
    expect(h.restartCalls).toEqual(["default"]);
  });

  it("coalesces a burst of signals into a single restart", async () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps);
    onFail("default", { reason: "a" });
    onFail("default", { reason: "b" });
    onFail("default", { reason: "c" });
    expect(h.timers.length).toBe(1); // only one confirm armed
    await h.flush();
    expect(h.restartCalls).toEqual(["default"]);
  });

  it("honours the cooldown between restarts", async () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps, { cooldownMs: 60_000 });
    onFail("default", { reason: "1" });
    await h.flush();
    expect(h.restartCalls.length).toBe(1);

    h.advance(10_000); // < cooldown
    onFail("default", { reason: "2" });
    await h.flush();
    expect(h.restartCalls.length).toBe(1); // suppressed
    expect(h.logs.some((l) => l.msg === "reconcile-skip" && l.fields.reason === "cooldown")).toBe(
      true,
    );

    h.advance(60_000); // now past cooldown
    onFail("default", { reason: "3" });
    await h.flush();
    expect(h.restartCalls.length).toBe(2);
  });

  it("backs off after the attempt cap within the window", async () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps, {
      cooldownMs: 1_000,
      maxAttempts: 2,
      windowMs: 60 * 60_000,
    });
    for (let i = 0; i < 4; i++) {
      onFail("default", { reason: `r${i}` });
      await h.flush();
      h.advance(2_000); // clear cooldown each round
    }
    expect(h.restartCalls.length).toBe(2); // capped
    expect(h.logs.some((l) => l.msg === "reconcile-giveup")).toBe(true);
  });

  it("rate-limits and gives up even when restart() REJECTS (no storm)", async () => {
    // restart() that always rejects — e.g. the Session Manager throwing on its
    // OWN crash-loop rate-limit ("restart rate limit exceeded"). The cooldown
    // and attempt-cap must still engage: the reconciler counts ATTEMPTS, not
    // successes. Without that, restartHistory stays empty and the reconciler
    // storms restart() every confirm window forever, and reconcile-giveup
    // never fires.
    const calls: string[] = [];
    const h = harness({
      restart: async (id) => {
        calls.push(id);
        throw new Error("restart rate limit exceeded");
      },
    });
    const onFail = createMcpReconciler(h.deps, {
      cooldownMs: 1_000,
      maxAttempts: 2,
      windowMs: 60 * 60_000,
    });
    for (let i = 0; i < 6; i++) {
      onFail("default", { reason: `r${i}` });
      await h.flush();
      h.advance(2_000); // clear cooldown each round
    }
    expect(calls.length).toBe(2); // capped despite every restart rejecting
    expect(h.logs.some((l) => l.msg === "reconcile-giveup")).toBe(true);
  });

  it("tracks agents independently", async () => {
    const h = harness();
    const onFail = createMcpReconciler(h.deps);
    onFail("alpha", { reason: "x" });
    onFail("beta", { reason: "y" });
    expect(h.timers.length).toBe(2);
    await h.flush();
    expect(h.restartCalls.sort()).toEqual(["alpha", "beta"]);
  });
});
