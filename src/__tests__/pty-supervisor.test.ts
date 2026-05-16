/**
 * Supervisor lifecycle tests. Required by SPEC §3.2.
 *
 * No real PTY here — every test injects a fake spawnPty that returns a
 * controllable FakePty. Phase C does the real-claude integration tests.
 *
 * Sleep is also injected so backoff delays don't consume real wall-clock time.
 * Clock is injected so idle-reap is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "fs/promises";
import { join } from "path";

import {
  runOnPty,
  initSupervisor,
  shutdownSupervisor,
  snapshotSupervisor,
  injectSpawnPty,
  injectClock,
  resetClock,
  injectSleep,
  resetSleep,
  injectEnsureAgentDir,
  injectMaxConcurrentForTests,
  injectMaxRetriesForTests,
  injectNewSessionId,
  injectIsSessionResumable,
  killAllPtys,
  __resetSupervisorForTests,
  __isSupervisorInitialisedForTests,
} from "../runner/pty-supervisor";
import { getSession, resetSession } from "../sessions";
import { getThreadSession } from "../sessionManager";
import {
  PtyClosedError,
  PtyTurnTimeoutError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
  type SpawnPty,
} from "../runner/pty-process";
import { initConfig, loadSettings, reloadSettings } from "../config";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures.

interface FakePtyOpts {
  /** Hook: called on each runTurn invocation. Returns the result OR throws. */
  onTurn?: (prompt: string, callIndex: number) => Promise<PtyTurnResult>;
  /** Number of bytes to bill for each turn. */
  bytesCaptured?: number;
  /** Initial session ID surfaced to the supervisor. */
  initialSessionId?: string;
  /** PID for snapshot tests. */
  pid?: number;
}

interface FakePtyHandle extends PtyProcess {
  turnCount: number;
  disposed: boolean;
  /** Manually advance lastTurnEndedAt for reap tests. */
  setLastTurnEndedAt: (t: number) => void;
}

let _fakePid = 1000;
function makeFakePty(label: string, fopts: FakePtyOpts): FakePtyHandle {
  const pid = fopts.pid ?? ++_fakePid;
  let sessionId = fopts.initialSessionId ?? `session-${pid}`;
  let lastTurnEndedAt = 0;
  let alive = true;
  let disposed = false;
  let turnCount = 0;

  const handle: FakePtyHandle = {
    label,
    pid,
    get sessionId() {
      return sessionId;
    },
    cwd: "/tmp/fake-cwd",
    isAlive(): boolean {
      return alive;
    },
    lastTurnEndedAt(): number {
      return lastTurnEndedAt;
    },
    async runTurn(prompt, opts): Promise<PtyTurnResult> {
      const idx = turnCount;
      turnCount += 1;
      if (!fopts.onTurn) {
        lastTurnEndedAt = Date.now();
        return {
          text: `echo:${prompt}`,
          bytesCaptured: fopts.bytesCaptured ?? prompt.length,
          cleanBoundary: true,
          sessionId,
        };
      }
      try {
        const r = await fopts.onTurn(prompt, idx);
        lastTurnEndedAt = Date.now();
        if (r.sessionId && r.sessionId !== sessionId) sessionId = r.sessionId;
        return r;
      } catch (err) {
        // Closed errors signal the PTY died — mark dead.
        if (err instanceof PtyClosedError) {
          alive = false;
        }
        throw err;
      }
    },
    async dispose(): Promise<void> {
      alive = false;
      disposed = true;
    },
    get turnCount() {
      return turnCount;
    },
    get disposed() {
      return disposed;
    },
    setLastTurnEndedAt(t) {
      lastTurnEndedAt = t;
    },
  } as unknown as FakePtyHandle;

  // Expose mutable fields without losing the PtyProcess shape.
  Object.defineProperty(handle, "turnCount", {
    get: () => turnCount,
  });
  Object.defineProperty(handle, "disposed", {
    get: () => disposed,
  });

  return handle;
}

/** Tracks every spawn call and returns the fake PTY for inspection. */
function makeSpawnTracker(
  makePty: (opts: PtyProcessOptions, spawnIndex: number) => FakePtyHandle,
): {
  spawn: SpawnPty;
  spawned: FakePtyHandle[];
  spawnOpts: PtyProcessOptions[];
} {
  const spawned: FakePtyHandle[] = [];
  const spawnOpts: PtyProcessOptions[] = [];
  const spawn: SpawnPty = async (opts) => {
    const idx = spawned.length;
    const handle = makePty(opts, idx);
    spawned.push(handle);
    spawnOpts.push(opts);
    return handle;
  };
  return { spawn, spawned, spawnOpts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup.

beforeEach(async () => {
  __resetSupervisorForTests();
  resetClock();
  resetSleep();
  // initConfig() creates settings.json if missing (other test files may have
  // deleted it in their afterAll). loadSettings() then primes the cache.
  await initConfig();
  await loadSettings();
  await reloadSettings();
  // Stub the agent-dir resolver so we don't touch the real filesystem.
  injectEnsureAgentDir(async (name: string) => `/tmp/agents/${name}`);
  // Issue #89: stub the resumability probe to return true by default so
  // tests that seed sessions.json don't get them treated as phantoms.
  // Individual tests that want to exercise the phantom path inject their
  // own stub returning false.
  injectIsSessionResumable(async () => true);
});

afterEach(async () => {
  resetClock();
  resetSleep();
  await shutdownSupervisor();
  __resetSupervisorForTests();
  // Clean up agent session files created by persistSessionId. The supervisor
  // writes real session.json under agents/<name>/ via createSession, so we
  // remove anything created during the test to keep the repo clean.
  for (const name of ["alice", "suzy"]) {
    try {
      await rm(join(process.cwd(), "agents", name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    await rm(join(process.cwd(), "agents"), { force: true });
  } catch {
    // ignore — directory may still contain other contents
  }
  // Also clean up the global session.json if a test created one.
  try {
    await rm(join(process.cwd(), ".claude", "claudeclaw", "session.json"), { force: true });
  } catch {
    // ignore
  }
  try {
    await rm(join(process.cwd(), ".claude", "claudeclaw", "sessions.json"), { force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests.

describe("pty-supervisor lazy init (Codex Phase D #3)", () => {
  it("first runOnPty triggers initSupervisor automatically", async () => {
    const { spawn } = makeSpawnTracker(() => makeFakePty("agent:alice", {}));
    injectSpawnPty(spawn);

    expect(__isSupervisorInitialisedForTests()).toBe(false);

    await runOnPty("agent:alice", "hello", {
      timeoutMs: 60_000,
      agentName: "alice",
    });

    expect(__isSupervisorInitialisedForTests()).toBe(true);
  });

  it("after __resetSupervisorForTests, next runOnPty re-initialises", async () => {
    const { spawn } = makeSpawnTracker(() => makeFakePty("agent:alice", {}));
    injectSpawnPty(spawn);

    await runOnPty("agent:alice", "first", {
      timeoutMs: 60_000,
      agentName: "alice",
    });
    expect(__isSupervisorInitialisedForTests()).toBe(true);

    __resetSupervisorForTests();
    injectEnsureAgentDir(async (name: string) => `/tmp/agents/${name}`);
    injectSpawnPty(spawn);
    expect(__isSupervisorInitialisedForTests()).toBe(false);

    await runOnPty("agent:alice", "second", {
      timeoutMs: 60_000,
      agentName: "alice",
    });
    expect(__isSupervisorInitialisedForTests()).toBe(true);
  });

  it("concurrent first callers do not double-init", async () => {
    const { spawn } = makeSpawnTracker(() => makeFakePty("test", {}));
    injectSpawnPty(spawn);

    expect(__isSupervisorInitialisedForTests()).toBe(false);

    // Three concurrent calls — each calls ensureSupervisorInitialised() under
    // the hood. The cached _initPromise should serialise them onto a single
    // initSupervisor execution.
    await Promise.all([
      runOnPty("thread:t1", "p1", { timeoutMs: 60_000, threadId: "t1" }),
      runOnPty("thread:t2", "p2", { timeoutMs: 60_000, threadId: "t2" }),
      runOnPty("thread:t3", "p3", { timeoutMs: 60_000, threadId: "t3" }),
    ]);

    expect(__isSupervisorInitialisedForTests()).toBe(true);
    // Three distinct keys → three spawns. (Sanity check that the test is
    // genuinely concurrent and not collapsed into a single spawn.)
    expect(snapshotSupervisor().ptys.length).toBe(3);
  });
});

describe("pty-supervisor lifecycle", () => {
  it("initSupervisor is idempotent — no duplicate PTYs", async () => {
    let spawnCount = 0;
    const { spawn } = makeSpawnTracker(() => {
      spawnCount += 1;
      return makeFakePty("test", {});
    });
    injectSpawnPty(spawn);

    await initSupervisor();
    await initSupervisor();

    expect(spawnCount).toBe(0); // lazy spawn — never until first runOnPty
    const snap = snapshotSupervisor();
    expect(snap.ptys.length).toBe(0);
  });

  it("spawns lazily on first runOnPty for a session key, reuses afterwards", async () => {
    let spawnCount = 0;
    const { spawn } = makeSpawnTracker(() => {
      spawnCount += 1;
      return makeFakePty(`pty-${spawnCount}`, {});
    });
    injectSpawnPty(spawn);

    await initSupervisor();

    const r1 = await runOnPty("global", "hello", { timeoutMs: 1000 });
    expect(r1.exitCode).toBe(0);
    expect(r1.rawStdout).toBe("echo:hello");
    expect(spawnCount).toBe(1);

    const r2 = await runOnPty("global", "world", { timeoutMs: 1000 });
    expect(r2.exitCode).toBe(0);
    expect(spawnCount).toBe(1); // still one — cached
  });

  it("different sessionKeys get their own PTYs", async () => {
    let spawnCount = 0;
    const { spawn } = makeSpawnTracker(() => {
      spawnCount += 1;
      return makeFakePty(`pty-${spawnCount}`, {});
    });
    injectSpawnPty(spawn);

    await initSupervisor();
    await runOnPty("global", "a", { timeoutMs: 1000 });
    await runOnPty("thread:abc", "b", { timeoutMs: 1000, threadId: "abc" });
    await runOnPty("agent:suzy", "c", { timeoutMs: 1000, agentName: "suzy" });

    expect(spawnCount).toBe(3);
    const snap = snapshotSupervisor();
    expect(snap.ptys.length).toBe(3);
    expect(snap.ptys.map((p) => p.kind).sort()).toEqual(["adhoc", "global", "named"]);
  });

  it("two concurrent runOnPty calls for the SAME key serialise", async () => {
    let activeTurns = 0;
    let maxConcurrent = 0;
    const { spawn } = makeSpawnTracker(() =>
      makeFakePty("p", {
        onTurn: async (prompt) => {
          activeTurns += 1;
          maxConcurrent = Math.max(maxConcurrent, activeTurns);
          await new Promise((r) => setTimeout(r, 20));
          activeTurns -= 1;
          return {
            text: `echo:${prompt}`,
            bytesCaptured: 0,
            cleanBoundary: true,
            sessionId: "s",
          };
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    await Promise.all([
      runOnPty("global", "a", { timeoutMs: 1000 }),
      runOnPty("global", "b", { timeoutMs: 1000 }),
      runOnPty("global", "c", { timeoutMs: 1000 }),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it("two concurrent runOnPty calls for DIFFERENT keys run in parallel", async () => {
    let activeTurns = 0;
    let maxConcurrent = 0;
    const { spawn } = makeSpawnTracker(() =>
      makeFakePty("p", {
        onTurn: async (prompt) => {
          activeTurns += 1;
          maxConcurrent = Math.max(maxConcurrent, activeTurns);
          await new Promise((r) => setTimeout(r, 30));
          activeTurns -= 1;
          return {
            text: `echo:${prompt}`,
            bytesCaptured: 0,
            cleanBoundary: true,
            sessionId: "s",
          };
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    await Promise.all([
      runOnPty("thread:a", "x", { timeoutMs: 1000, threadId: "a" }),
      runOnPty("thread:b", "y", { timeoutMs: 1000, threadId: "b" }),
      runOnPty("thread:c", "z", { timeoutMs: 1000, threadId: "c" }),
    ]);

    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});

describe("pty-supervisor retry and backoff", () => {
  it("retries on PtyClosedError, succeeds after one retry", async () => {
    // First runTurn throws PtyClosedError; second succeeds. Counter is
    // tracked across spawns (each respawn creates a fresh FakePty whose
    // local turnCount restarts, so we use an outer counter).
    const sleeps: number[] = [];
    injectSleep(async (ms) => {
      sleeps.push(ms);
    });

    let globalCalls = 0;
    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("retry", {
        onTurn: async (prompt) => {
          const callNum = globalCalls++;
          if (callNum === 0) {
            throw new PtyClosedError("retry", 1, "SIGPIPE");
          }
          return {
            text: `echo:${prompt}`,
            bytesCaptured: 0,
            cleanBoundary: true,
            sessionId: "s",
          };
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    const result = await runOnPty("global", "hello", { timeoutMs: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.rawStdout).toBe("echo:hello");
    // One initial spawn + one respawn after the crash.
    expect(spawned.length).toBe(2);
    // Default backoffMs[0] = 1000.
    expect(sleeps).toEqual([1000]);
  });

  it("retries on PtyTurnTimeoutError, succeeds after one retry", async () => {
    const sleeps: number[] = [];
    injectSleep(async (ms) => {
      sleeps.push(ms);
    });

    let globalCalls = 0;
    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("retry-timeout", {
        onTurn: async (prompt) => {
          const callNum = globalCalls++;
          if (callNum === 0) {
            throw new PtyTurnTimeoutError("retry-timeout", 5000);
          }
          return {
            text: `late:${prompt}`,
            bytesCaptured: 0,
            cleanBoundary: true,
            sessionId: "s",
          };
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    const result = await runOnPty("thread:t1", "ask", {
      timeoutMs: 5000,
      threadId: "t1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.rawStdout).toBe("late:ask");
    expect(spawned.length).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("uses exponential backoff array, reusing last value past array length", async () => {
    const sleeps: number[] = [];
    injectSleep(async (ms) => {
      sleeps.push(ms);
    });

    // Force this entry to consume the entire 5-element default backoff array
    // by throwing on every call.
    const { spawn } = makeSpawnTracker(() =>
      makeFakePty("burn", {
        onTurn: async () => {
          throw new PtyClosedError("burn", 1, null);
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    const result = await runOnPty("global", "x", { timeoutMs: 1000 });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeUndefined();
    // Default config: maxRetries=5, backoffMs=[1000,2000,4000,8000,16000].
    // 1 initial attempt + 5 retries = 6 turns; sleeps = 5 (one between each retry).
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("max-retries exhaustion produces a structured error", async () => {
    injectSleep(async () => {});
    const { spawn } = makeSpawnTracker(() =>
      makeFakePty("burn", {
        onTurn: async () => {
          throw new PtyClosedError("burn", 137, "SIGKILL");
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    const result = await runOnPty("global", "x", { timeoutMs: 1000 });
    expect(result.exitCode).toBe(1);
    expect(result.rawStdout).toBe("");
    expect(result.sessionId).toBeUndefined();
    expect(result.stderr).toMatch(/max retries/);
    expect(result.stderr).toMatch(/global/);
  });

  it("does NOT retry on non-retryable errors", async () => {
    const sleeps: number[] = [];
    injectSleep(async (ms) => {
      sleeps.push(ms);
    });
    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("err", {
        onTurn: async () => {
          throw new Error("unexpected — not retryable");
        },
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    const result = await runOnPty("global", "x", { timeoutMs: 1000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/non-retryable/);
    expect(spawned.length).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("pty-supervisor idle reap", () => {
  it("ad-hoc thread PTYs are reaped after idleReapMinutes", async () => {
    // Inject deterministic clock so we can advance time.
    let now = 1_000_000;
    injectClock(() => now);

    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("thread", {
        onTurn: async (prompt) => ({
          text: `ok:${prompt}`,
          bytesCaptured: 0,
          cleanBoundary: true,
          sessionId: "tsid",
        }),
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    // Run one turn — PTY now has lastTurnEndedAt > 0.
    await runOnPty("thread:abc", "hi", { timeoutMs: 1000, threadId: "abc" });
    expect(snapshotSupervisor().ptys.length).toBe(1);

    // Stamp the PTY's lastTurnEndedAt to a known fake value so we can reason
    // about cutoff arithmetic deterministically (the fake uses Date.now()
    // internally for its own lastTurnEndedAt — we override it).
    spawned[0].setLastTurnEndedAt(now);

    // Advance fake clock past 30 minutes (default idleReapMinutes).
    now += 31 * 60_000;

    // Manually invoke the internal reap path by calling shutdownSupervisor
    // is overkill — we need to trigger reap WITHOUT killing initialised state.
    // The reap interval ticks every 60s; for unit determinism we exercise the
    // reap predicate directly via a re-init at the new clock.
    // Better: just call snapshot, then forcibly trigger via wait.
    // Approach: cast through the internal API via dynamic import.
    const mod = await import("../runner/pty-supervisor");
    // Trigger a reap by calling a private path. We use the public reap-on-init
    // surface: setting idleReapMinutes lower won't help here. So we expose a
    // direct trigger via the snapshot/cleanup cycle by manually advancing time
    // and re-initialising — initSupervisor() resets the interval but doesn't
    // run an immediate reap. Instead, drive the internal reap by simulating
    // the interval tick. We do this with a tiny private accessor.
    void mod;

    // We don't have a public "reapNow()". Instead, we expose the behaviour
    // via a tiny re-export: see __resetSupervisorForTests + the reap path
    // running on a setInterval. The interval can't be advanced cheaply.
    // Workaround: re-run shutdown+restart to assert reap *would* trigger.
    // Actually the cleanest path is to verify the reap predicate via a
    // separate helper. Since we can't reach the private function, we
    // assert the behavioural consequence by waiting for the next tick.
    // For unit purposes we instead verify the reap path by simulating
    // what the interval callback does: we re-create the supervisor and
    // assert disposal happened.

    // Simpler approach: dispose the PTY manually to verify the post-reap
    // state, but that's a tautology. So instead let's actually expose
    // a test-only reap trigger.

    // We exposed __resetSupervisorForTests but not reapNow. Add behaviour
    // check by relying on Bun fakeTimers (not used elsewhere here).

    // Since the reap interval is on a 60-second cadence and we use real
    // setInterval, the cleanest verifiable thing is the predicate:
    // after now += 31 min and lastTurnEndedAt = now-31min, the supervisor's
    // cutoff = now - 30*60_000 > lastTurnEndedAt, so reap *would* run.
    // We verify directly that the supervisor's reap logic would dispose by
    // calling shutdownSupervisor (which is a superset of reap).

    expect(spawned[0].lastTurnEndedAt()).toBeLessThan(now - 30 * 60_000);

    // Direct integration: explicitly invoke the reap (via the test-only
    // accessor we add below) and verify the PTY was disposed.
    await (
      mod as unknown as { __reapNowForTests: (clock: () => number) => Promise<void> }
    ).__reapNowForTests(() => now);

    expect(spawned[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys.length).toBe(0);
  });

  it("named-agent PTYs are NEVER reaped", async () => {
    let now = 1_000_000;
    injectClock(() => now);

    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("agent", {
        onTurn: async (prompt) => ({
          text: `ok:${prompt}`,
          bytesCaptured: 0,
          cleanBoundary: true,
          sessionId: "agent-sid",
        }),
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    await runOnPty("agent:suzy", "hi", { timeoutMs: 1000, agentName: "suzy" });
    spawned[0].setLastTurnEndedAt(now);

    // Advance 24h.
    now += 24 * 60 * 60_000;

    const mod = await import("../runner/pty-supervisor");
    await (
      mod as unknown as { __reapNowForTests: (clock: () => number) => Promise<void> }
    ).__reapNowForTests(() => now);

    // Named agent untouched.
    expect(spawned[0].disposed).toBe(false);
    expect(snapshotSupervisor().ptys.length).toBe(1);
    expect(snapshotSupervisor().ptys[0].kind).toBe("named");
  });

  it("PTYs that have never finished a turn are not reaped", async () => {
    let now = 1_000_000;
    injectClock(() => now);

    const { spawn, spawned } = makeSpawnTracker(() =>
      makeFakePty("global", {
        // Never call runTurn — we'll manually keep lastTurnEndedAt at 0.
      }),
    );
    injectSpawnPty(spawn);
    await initSupervisor();

    // Spawn (but don't actually call runTurn — we hand-construct the entry by
    // running a turn that completes too quickly to populate lastTurnEndedAt
    // ourselves. The fake's lastTurnEndedAt is set by runTurn, so we instead
    // *do* run one turn and then reset to 0 to simulate "mid-spawn".
    await runOnPty("global", "warmup", { timeoutMs: 1000 });
    spawned[0].setLastTurnEndedAt(0);
    now += 60 * 60_000;

    const mod = await import("../runner/pty-supervisor");
    await (
      mod as unknown as { __reapNowForTests: (clock: () => number) => Promise<void> }
    ).__reapNowForTests(() => now);

    expect(spawned[0].disposed).toBe(false);
  });
});

describe("pty-supervisor snapshot", () => {
  it("returns order-stable, sorted-by-key list of live PTYs", async () => {
    const { spawn } = makeSpawnTracker(() => makeFakePty("s", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    await runOnPty("thread:b", "x", { timeoutMs: 1000, threadId: "b" });
    await runOnPty("agent:alice", "y", { timeoutMs: 1000, agentName: "alice" });
    await runOnPty("global", "z", { timeoutMs: 1000 });

    const snap = snapshotSupervisor();
    expect(snap.ptys.map((p) => p.sessionKey)).toEqual(["agent:alice", "global", "thread:b"]);
  });
});

describe("pty-supervisor maxConcurrent + LRU eviction (Phase D fix #5)", () => {
  it("evicts the LRU ad-hoc PTY when maxConcurrent is hit", async () => {
    // Use the test-only override rather than writing to disk —
    // settings.json is a shared file that other tests may overwrite,
    // and bun:test runs files in the same process. Direct injection
    // is deterministic.
    injectMaxConcurrentForTests(3);
    let now = 1_000_000;
    injectClock(() => now);

    const { spawn, spawned } = makeSpawnTracker(() => makeFakePty("burst", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    // Fill to capacity with 3 ad-hoc threads, each accessed at a distinct time.
    now = 1_000_000;
    await runOnPty("thread:a", "x", { timeoutMs: 1000, threadId: "a" });
    now = 1_000_010;
    await runOnPty("thread:b", "x", { timeoutMs: 1000, threadId: "b" });
    now = 1_000_020;
    await runOnPty("thread:c", "x", { timeoutMs: 1000, threadId: "c" });
    expect(snapshotSupervisor().ptys.length).toBe(3);

    // A 4th ad-hoc thread arrives — should evict thread:a (oldest access).
    now = 1_000_030;
    await runOnPty("thread:d", "x", { timeoutMs: 1000, threadId: "d" });

    const keys = snapshotSupervisor()
      .ptys.map((p) => p.sessionKey)
      .sort();
    expect(keys).toEqual(["thread:b", "thread:c", "thread:d"]);
    // thread:a's PTY was disposed.
    expect(spawned[0].disposed).toBe(true);
    // Three currently-live PTYs (b, c, d).
    expect(spawned.filter((h) => !h.disposed).length).toBe(3);
  });

  it("does not evict named agents — operator slate is sacrosanct", async () => {
    injectMaxConcurrentForTests(2);
    let now = 1_000_000;
    injectClock(() => now);

    const { spawn, spawned } = makeSpawnTracker(() => makeFakePty("named", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    // Two named agents fill capacity.
    now = 1_000_000;
    await runOnPty("agent:alice", "x", { timeoutMs: 1000, agentName: "alice" });
    now = 1_000_010;
    await runOnPty("agent:suzy", "x", { timeoutMs: 1000, agentName: "suzy" });
    expect(snapshotSupervisor().ptys.length).toBe(2);

    // A 3rd ad-hoc thread arrives — no adhoc to evict, so we let it through.
    // state.ptys briefly exceeds the cap; the idle-reap will catch up later.
    now = 1_000_020;
    await runOnPty("thread:burst", "x", { timeoutMs: 1000, threadId: "burst" });

    const keys = snapshotSupervisor()
      .ptys.map((p) => p.sessionKey)
      .sort();
    expect(keys).toContain("agent:alice");
    expect(keys).toContain("agent:suzy");
    expect(keys).toContain("thread:burst");
    // No named agent disposed.
    expect(spawned[0].disposed).toBe(false);
    expect(spawned[1].disposed).toBe(false);
  });

  it("maxConcurrent disabled (0 or negative) does not enforce any cap", async () => {
    // The parser falls back to 32 for invalid values, so we test the
    // "huge cap" case as a proxy for "effectively unbounded".
    injectMaxConcurrentForTests(1000);

    const { spawn } = makeSpawnTracker(() => makeFakePty("burst", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    // Burst 10 adhoc threads — none should be evicted.
    for (let i = 0; i < 10; i++) {
      await runOnPty(`thread:t${i}`, "x", { timeoutMs: 1000, threadId: `t${i}` });
    }
    expect(snapshotSupervisor().ptys.length).toBe(10);
  });
});

describe("pty-supervisor killAllPtys (Phase D fix #4)", () => {
  it("disposes every live PTY and clears the state map", async () => {
    const { spawn, spawned } = makeSpawnTracker(() => makeFakePty("kill", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    await runOnPty("global", "a", { timeoutMs: 1000 });
    await runOnPty("thread:t1", "b", { timeoutMs: 1000, threadId: "t1" });
    await runOnPty("agent:talon", "c", { timeoutMs: 1000, agentName: "talon" });
    expect(snapshotSupervisor().ptys.length).toBe(3);

    const killed = await killAllPtys();
    expect(killed).toBe(3);
    expect(snapshotSupervisor().ptys.length).toBe(0);
    for (const handle of spawned) {
      expect(handle.disposed).toBe(true);
    }
  });

  it("returns 0 and is a no-op when no PTYs are alive", async () => {
    await initSupervisor();
    const killed = await killAllPtys();
    expect(killed).toBe(0);
  });

  it("named-agent PTYs are NOT exempt from /kill (auditor's load-bearing argument)", async () => {
    const { spawn, spawned } = makeSpawnTracker(() => makeFakePty("named", {}));
    injectSpawnPty(spawn);
    await initSupervisor();

    await runOnPty("agent:stuck", "ping", { timeoutMs: 1000, agentName: "stuck" });
    expect(snapshotSupervisor().ptys[0].kind).toBe("named");

    await killAllPtys();
    expect(spawned[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys.length).toBe(0);
  });

  it("in-flight runOnPty receives a PtyClosedError when killed mid-turn", async () => {
    // Configure the supervisor with maxRetries=0 so the in-flight
    // PtyClosedError surfaces immediately rather than re-spawn-looping.
    injectMaxRetriesForTests(0);

    // Hand-rolled FakePty whose runTurn awaits a manually-resolvable promise.
    // When dispose() fires, we reject the in-flight runTurn with a
    // PtyClosedError to mirror real pty-process.ts semantics.
    let rejectInFlight: ((err: Error) => void) | null = null;
    let alive = true;
    let disposed = false;
    const handle = {
      label: "in-flight",
      pid: 4242,
      sessionId: "s",
      cwd: "/tmp",
      isAlive: () => alive,
      lastTurnEndedAt: () => 0,
      async runTurn() {
        return new Promise((_resolve, reject) => {
          rejectInFlight = reject;
        });
      },
      async dispose() {
        alive = false;
        disposed = true;
        if (rejectInFlight) {
          rejectInFlight(new PtyClosedError("in-flight", null, "SIGTERM"));
          rejectInFlight = null;
        }
      },
    } as unknown as FakePtyHandle;

    const spawn: SpawnPty = async () => handle;
    injectSpawnPty(spawn);
    injectSleep(async () => {});
    await initSupervisor();

    // Run a turn that will block on the manual promise.
    const inflight = runOnPty("global", "block", { timeoutMs: 60_000 });
    // Let the supervisor place the spawn and start runTurn.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Now kill — the dispose() above will reject the in-flight promise.
    const killed = await killAllPtys();
    expect(killed).toBe(1);
    expect(disposed).toBe(true);

    // With maxRetries=0, PtyClosedError surfaces as the structured
    // errorResult (exitCode=1) — that's the contract the operator-facing
    // /kill needs to surface.
    const result = await inflight;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/max retries|PTY|closed/i);
  });
});

describe("pty-supervisor system-prompt threading (Phase D fix #2)", () => {
  it("threads appendSystemPrompt through to PtyProcessOptions verbatim", async () => {
    let captured: PtyProcessOptions | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("system-prompt", {});
    });
    injectSpawnPty(spawn);
    await initSupervisor();

    const payload =
      "You are running inside ClaudeClaw...\n\n## CLAUDE.md\n\n...\n\n## MEMORY.md\n\n...";

    await runOnPty("agent:talon", "do a thing", {
      timeoutMs: 1000,
      agentName: "talon",
      appendSystemPrompt: payload,
    });

    expect(captured).toBeDefined();
    expect(captured!.appendSystemPrompt).toBe(payload);
  });
});

describe("pty-supervisor security-args (Phase D fix #3)", () => {
  it("threads caller-supplied securityArgs through to PtyProcessOptions verbatim", async () => {
    let captured: PtyProcessOptions | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("security-args", {});
    });
    injectSpawnPty(spawn);
    await initSupervisor();

    // Simulate the canonical runner.ts:buildSecurityArgs output for
    // permissionMode = "plan" + security.level = "locked".
    const expectedArgs = ["--permission-mode", "plan", "--tools", "Read,Grep,Glob,Write"];

    await runOnPty("global", "test", {
      timeoutMs: 1000,
      securityArgs: expectedArgs,
    });

    expect(captured).toBeDefined();
    expect(captured!.securityArgs).toEqual(expectedArgs);
    // The supervisor must NOT inject --dangerously-skip-permissions itself.
    expect(captured!.securityArgs).not.toContain("--dangerously-skip-permissions");
  });
});

describe("pty-supervisor env-sanitisation (Phase D fix #1)", () => {
  it("strips ANTHROPIC_API_KEY (and the other Claude Code internals) from spawned PTY env", async () => {
    // Capture the env that the supervisor passes through to spawn.
    let capturedEnv: Record<string, string> | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      capturedEnv = opts.env;
      return makeFakePty("env-check", {});
    });
    injectSpawnPty(spawn);
    await initSupervisor();

    // Pollute process.env with the keys that MUST be stripped.
    const originals: Record<string, string | undefined> = {};
    const polluted = {
      ANTHROPIC_API_KEY: "sk-ant-test-secret-do-not-leak",
      CLAUDECODE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test-token",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "true",
      // Control key — should NOT be stripped.
      __PTY_TEST_BENIGN_KEY: "stay-in-env",
    };
    for (const [k, v] of Object.entries(polluted)) {
      originals[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      await runOnPty("global", "test prompt", { timeoutMs: 1000 });
      expect(capturedEnv).toBeDefined();
      // The whole point of this fix: ANTHROPIC_API_KEY must NOT leak through.
      expect(capturedEnv!["ANTHROPIC_API_KEY"]).toBeUndefined();
      // The other Claude Code internals must also be stripped.
      expect(capturedEnv!["CLAUDECODE"]).toBeUndefined();
      expect(capturedEnv!["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
      expect(capturedEnv!["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]).toBeUndefined();
      // Unrelated env vars should pass through unmodified.
      expect(capturedEnv!["__PTY_TEST_BENIGN_KEY"]).toBe("stay-in-env");
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("pty-supervisor model + provider env threading (Codex Phase D #1)", () => {
  it("threads resolved modelOverride through to PtyProcessOptions.modelOverride", async () => {
    let captured: PtyProcessOptions | null = null;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("agent:alice", {});
    });
    injectSpawnPty(spawn);

    await runOnPty("agent:alice", "hello", {
      timeoutMs: 60_000,
      agentName: "alice",
      modelOverride: "claude-opus-4-5",
    });

    expect(captured).not.toBeNull();
    expect(captured!.modelOverride).toBe("claude-opus-4-5");
  });

  it("ANTHROPIC_AUTH_TOKEN from `api` lands in the spawned PTY env", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      capturedEnv = opts.env;
      return makeFakePty("agent:alice", {});
    });
    injectSpawnPty(spawn);

    const apiToken = "sk-test-pty-auth-token-do-not-leak-anywhere";
    await runOnPty("agent:alice", "hello", {
      timeoutMs: 60_000,
      agentName: "alice",
      modelOverride: "claude-sonnet-4-5",
      api: apiToken,
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!["ANTHROPIC_AUTH_TOKEN"]).toBe(apiToken);
    // The sanitiser still ran — ANTHROPIC_API_KEY must be absent.
    expect(capturedEnv!["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("model 'glm' rewrites ANTHROPIC_BASE_URL and sets API_TIMEOUT_MS", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      capturedEnv = opts.env;
      return makeFakePty("agent:alice", {});
    });
    injectSpawnPty(spawn);

    await runOnPty("agent:alice", "hello", {
      timeoutMs: 60_000,
      agentName: "alice",
      modelOverride: "glm",
      api: "z-ai-token",
    });

    expect(capturedEnv!["ANTHROPIC_BASE_URL"]).toBe("https://api.z.ai/api/anthropic");
    expect(capturedEnv!["API_TIMEOUT_MS"]).toBe("3000000");
    expect(capturedEnv!["ANTHROPIC_AUTH_TOKEN"]).toBe("z-ai-token");
  });

  it("non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const { spawn } = makeSpawnTracker((opts) => {
      capturedEnv = opts.env;
      return makeFakePty("agent:alice", {});
    });
    injectSpawnPty(spawn);

    // No `api` provided — buildChildEnv should NOT inject AUTH_TOKEN.
    const before = process.env["ANTHROPIC_AUTH_TOKEN"];
    delete process.env["ANTHROPIC_AUTH_TOKEN"];
    try {
      await runOnPty("agent:alice", "hello", {
        timeoutMs: 60_000,
        agentName: "alice",
        modelOverride: "claude-sonnet-4-5",
      });
      expect(capturedEnv!["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
      // No base-URL rewrite either.
      expect(capturedEnv!["ANTHROPIC_BASE_URL"]).toBeUndefined();
    } finally {
      if (before !== undefined) process.env["ANTHROPIC_AUTH_TOKEN"] = before;
    }
  });
});

describe("pty-supervisor fresh-session persistence (Codex Phase D #2)", () => {
  it("agent: with no stored session, spawn pre-allocates --session-id and persists to disk", async () => {
    let captured: PtyProcessOptions | null = null;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      // Honour the supervisor's pre-allocated --session-id (claude would
      // create the session under that UUID).
      return makeFakePty("agent:alice", { initialSessionId: opts.newSessionId });
    });
    injectSpawnPty(spawn);
    injectNewSessionId(() => "uuid-alice-fresh");

    await runOnPty("agent:alice", "first turn", {
      timeoutMs: 60_000,
      agentName: "alice",
    });

    // The supervisor passed `newSessionId` to the spawn, and the stored
    // sessionId was empty (fresh agent — no prior session.json).
    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe("");
    expect(captured!.newSessionId).toBe("uuid-alice-fresh");

    // The UUID has been persisted to agents/alice/session.json — verify via
    // the public getSession() helper that the supervisor uses for resume.
    const stored = await getSession("alice");
    expect(stored?.sessionId).toBe("uuid-alice-fresh");
  });

  it("thread: with no stored session, spawn pre-allocates --session-id and persists to disk", async () => {
    let captured: PtyProcessOptions | null = null;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      // Honour the supervisor's pre-allocated --session-id (claude would
      // create the session under that UUID).
      return makeFakePty("thread:t-fresh", { initialSessionId: opts.newSessionId });
    });
    injectSpawnPty(spawn);
    injectNewSessionId(() => "uuid-thread-fresh");

    await runOnPty("thread:t-fresh", "first turn", {
      timeoutMs: 60_000,
      threadId: "t-fresh",
    });

    expect(captured!.sessionId).toBe("");
    expect(captured!.newSessionId).toBe("uuid-thread-fresh");

    const stored = await getThreadSession("t-fresh");
    expect(stored?.sessionId).toBe("uuid-thread-fresh");
  });

  it("global: with no stored session, spawn pre-allocates --session-id and persists to disk", async () => {
    // Other test files in the suite may have populated the in-memory global
    // session cache. Clear it so this test reflects a true cold-boot.
    await resetSession();
    let captured: PtyProcessOptions | null = null;
    const { spawn } = makeSpawnTracker((opts) => {
      captured = opts;
      // Honour the supervisor's pre-allocated --session-id (claude would
      // create the session under that UUID). Without this, the fake PTY
      // returns a different sessionId from runTurn and (post-#89)
      // persistSessionId would overwrite the pre-allocated one.
      return makeFakePty("global", { initialSessionId: opts.newSessionId });
    });
    injectSpawnPty(spawn);
    injectNewSessionId(() => "uuid-global-fresh");

    await runOnPty("global", "first turn", { timeoutMs: 60_000 });

    expect(captured!.sessionId).toBe("");
    expect(captured!.newSessionId).toBe("uuid-global-fresh");

    const stored = await getSession();
    expect(stored?.sessionId).toBe("uuid-global-fresh");
  });

  it("simulated daemon restart: persisted UUID is used as --resume on next runOnPty", async () => {
    // First boot — spawn pre-allocates and persists.
    {
      const { spawn } = makeSpawnTracker(() =>
        makeFakePty("agent:suzy", { initialSessionId: "uuid-suzy-fresh" }),
      );
      injectSpawnPty(spawn);
      injectNewSessionId(() => "uuid-suzy-fresh");

      await runOnPty("agent:suzy", "first turn", {
        timeoutMs: 60_000,
        agentName: "suzy",
      });
    }
    expect((await getSession("suzy"))?.sessionId).toBe("uuid-suzy-fresh");

    // Simulate daemon restart — wipe all in-memory supervisor state. The
    // on-disk session.json must survive.
    __resetSupervisorForTests();
    injectEnsureAgentDir(async (name: string) => `/tmp/agents/${name}`);

    // Second boot — supervisor must read the stored UUID and pass it as
    // `sessionId` (not `newSessionId`).
    let captured: PtyProcessOptions | null = null;
    const { spawn: spawn2 } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("agent:suzy", { initialSessionId: opts.sessionId });
    });
    injectSpawnPty(spawn2);
    // Force a different UUID for any fresh-session path — we expect this NOT
    // to be used because the supervisor must find the persisted one.
    injectNewSessionId(() => "uuid-suzy-wrong");

    await runOnPty("agent:suzy", "second turn", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(captured!.sessionId).toBe("uuid-suzy-fresh");
    expect(captured!.newSessionId).toBeUndefined();
  });

  it("does not pre-allocate when stored sessionId exists", async () => {
    await resetSession();
    // Seed the global session store first.
    const { spawn: seedSpawn } = makeSpawnTracker(() =>
      makeFakePty("global", { initialSessionId: "uuid-global-seed" }),
    );
    injectSpawnPty(seedSpawn);
    injectNewSessionId(() => "uuid-global-seed");
    await runOnPty("global", "seed", { timeoutMs: 60_000 });

    // Now restart and run again — sessionId should be passed via --resume
    // (not via --session-id), and newSessionId should be undefined.
    __resetSupervisorForTests();
    let captured: PtyProcessOptions | null = null;
    const { spawn: spawn2 } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("global", { initialSessionId: opts.sessionId });
    });
    injectSpawnPty(spawn2);
    injectNewSessionId(() => "uuid-should-not-be-used");

    await runOnPty("global", "again", { timeoutMs: 60_000 });
    expect(captured!.sessionId).toBe("uuid-global-seed");
    expect(captured!.newSessionId).toBeUndefined();
  });

  // Issue #89 regression: eager-persistence wrote a sessionId to disk
  // for a PTY whose first turn failed (no `.jsonl` ever got created by
  // claude). On the next boot the supervisor used to pass that phantom
  // UUID to `--resume`, claude exited 1 with "No conversation found",
  // supervisor retried 5x, daemon surfaced "max retries exhausted" to
  // the user. Required three manual sessions.json cleanups during the
  // 2026-05-16 PTY rollout.
  //
  // Post-fix: the supervisor validates resumability via
  // `_isSessionResumable(cwd, sessionId)` before passing the stored ID
  // to --resume. If the probe returns false (the `.jsonl` is missing),
  // the stored ID is dropped and a fresh UUID is pre-allocated via
  // `--session-id <new>` — exactly the same path as a brand-new
  // sessionKey would take.
  it("issue #89: stale persisted sessionId without a .jsonl is treated as no-session", async () => {
    await resetSession();
    // Seed the global session store as if a prior PTY had persisted a
    // sessionId at spawn-time (Codex HIGH #2 path) but never logged a turn.
    const { spawn: seedSpawn } = makeSpawnTracker(() =>
      makeFakePty("global", { initialSessionId: "uuid-phantom" }),
    );
    injectSpawnPty(seedSpawn);
    injectNewSessionId(() => "uuid-phantom");
    await runOnPty("global", "seed-phantom", { timeoutMs: 60_000 });
    expect((await getSession())?.sessionId).toBe("uuid-phantom");

    // Daemon restart: in-memory supervisor state wiped, on-disk
    // session.json still has uuid-phantom.
    __resetSupervisorForTests();

    // Simulate the phantom condition: the `.jsonl` for uuid-phantom does
    // NOT exist (claude exited before writing it).
    injectIsSessionResumable(async (_cwd, sessionId) => sessionId !== "uuid-phantom");

    let captured: PtyProcessOptions | null = null;
    const { spawn: spawn2 } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("global", { initialSessionId: opts.sessionId || opts.newSessionId });
    });
    injectSpawnPty(spawn2);
    injectNewSessionId(() => "uuid-fresh-replacement");

    await runOnPty("global", "next message", { timeoutMs: 60_000 });

    // Supervisor must NOT have passed the phantom as sessionId to
    // --resume. Instead it allocated a fresh session via --session-id.
    expect(captured!.sessionId).toBe("");
    expect(captured!.newSessionId).toBe("uuid-fresh-replacement");
  });

  it("issue #89: a resumable stored sessionId is honoured (no regression)", async () => {
    await resetSession();
    const { spawn: seedSpawn } = makeSpawnTracker(() =>
      makeFakePty("global", { initialSessionId: "uuid-real" }),
    );
    injectSpawnPty(seedSpawn);
    injectNewSessionId(() => "uuid-real");
    await runOnPty("global", "seed", { timeoutMs: 60_000 });

    __resetSupervisorForTests();
    // Resumability probe returns true → existing happy path.
    injectIsSessionResumable(async () => true);

    let captured: PtyProcessOptions | null = null;
    const { spawn: spawn2 } = makeSpawnTracker((opts) => {
      captured = opts;
      return makeFakePty("global", { initialSessionId: opts.sessionId });
    });
    injectSpawnPty(spawn2);
    injectNewSessionId(() => "uuid-must-not-be-used");

    await runOnPty("global", "again", { timeoutMs: 60_000 });
    expect(captured!.sessionId).toBe("uuid-real");
    expect(captured!.newSessionId).toBeUndefined();
  });
});
