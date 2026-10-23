/**
 * Check-to-spawn race and caller-bounded confirmation (#562 round 9).
 *
 * Round 8's gate is async. A caller awaited it, did more async work (or none), then spawned,
 * and a retirement that failed in that window quarantined a session the spawn still went
 * ahead on. Two pieces close it: a fence set when a retirement BEGINS, and a synchronous
 * `assertSessionSpawnable` on the line before each process is created. The gate itself now
 * honours the caller's deadline and abort signal, so a slow confirmation cannot hold a
 * bounded caller past its own budget.
 *
 * Fake PTYs only, in-memory session store, explicit cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import { runOneShot } from "../oneshot/engine";
import { runPrint } from "../oneshot/print";
import { _setClaudeSpawnForTests, runClaudeOnce } from "../runner";
import {
  PtyExitUnconfirmedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
} from "../runner/pty-process";
import {
  __resetQuarantineForTests,
  assertSessionSpawnable,
  fenceSession,
  isSessionQuarantined,
  liftFence,
  PtyQuarantinedError,
  quarantineSession,
} from "../runner/pty-quarantine";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectRespawnRetriesForTests,
  injectSleep,
  injectSpawnPty,
  retirePtySession,
  runOnPty,
  sendToLiveSession,
  shutdownSupervisor,
} from "../runner/pty-supervisor";

interface FakePty extends PtyProcess {
  /** Whether the OS would confirm the exit right now. */
  canDie: boolean;
  /** How long a dispose / confirmation takes, ms. */
  confirmDelayMs: number;
  /** A dispose waits for this before it settles. */
  holdDispose?: Promise<void>;
}

function makeFake(sessionId = "sess-1"): FakePty {
  let alive = true;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const fake = {
    label: "fake:4242",
    pid: 4242,
    sessionId,
    cwd: "/tmp/fake-cwd",
    canDie: false,
    confirmDelayMs: 0,
    holdDispose: undefined as Promise<void> | undefined,
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId };
    },
    async dispose(): Promise<void> {
      await fake.holdDispose;
      alive = false;
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
    async confirmExit(): Promise<void> {
      if (fake.confirmDelayMs > 0) await sleep(fake.confirmDelayMs);
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
  };
  return fake as unknown as FakePty;
}

const memStore = (initial?: string) => {
  let id: string | undefined = initial;
  return {
    load: async () => id,
    save: async (s: string) => {
      id = s;
    },
  };
};

const scope = () => ({
  sessionStore: memStore(),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

let queue: PtyProcess[];

beforeEach(async () => {
  __resetSupervisorForTests();
  __resetQuarantineForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectIsSessionResumable(async () => true);
  injectSleep(async () => {});
  injectMaxRetriesForTests(0);
  injectRespawnRetriesForTests(2);
  queue = [];
  injectSpawnPty(async (_o: PtyProcessOptions) => queue.shift() ?? makeFake("sess-fresh"));
});

afterEach(async () => {
  _setClaudeSpawnForTests(null);
  await shutdownSupervisor();
  __resetSupervisorForTests();
  __resetQuarantineForTests();
});

describe("a session quarantined during the awaited gap before a spawn", () => {
  it("the legacy `claude -p --resume` does not spawn (runner spawnClaude)", async () => {
    // Fault (site: `assertResumeSpawnable` in `spawnClaude`): the async gate has already
    // passed, so the spawn goes ahead on a quarantined session. Predicted result: `spawned`
    // is 1 and the call resolves instead of rejecting.
    let spawned = 0;
    _setClaudeSpawnForTests((() => {
      spawned++;
      throw new Error("must not spawn");
    }) as never);

    // `runClaudeOnce` runs synchronously up to the gate's await: the quarantine below lands
    // in exactly the gap between the gate and the spawn.
    const run = runClaudeOnce(["claude", "-p", "x", "--resume", "sess-1"], "", "", {}, 1000);
    quarantineSession("thread:a", makeFake("sess-1"), "test");

    await expect(run).rejects.toThrow("quarantined");
    expect(spawned).toBe(0);
  });

  it("the print engine does not spawn after its config and runner imports (print.ts)", async () => {
    // Fault (site: `assertSessionSpawnable` in `runPrint`): the engine-level gate passed
    // before the imports, so the spawn goes ahead. Predicted result: `spawned` is 1.
    let spawned = 0;
    const spawnFn = (() => {
      spawned++;
      throw new Error("must not spawn");
    }) as never;
    const { withPrintRuntime } = await import("../oneshot/print");

    const run = withPrintRuntime({ spawn: spawnFn }, () =>
      runPrint({
        route: "compact",
        prompt: "p",
        isolation: "trusted-session",
        resumeSessionId: "sess-1",
        timeoutMs: 1000,
      }),
    );
    // `runPrint` is parked on `await import(...)`: the quarantine lands in that gap.
    quarantineSession("thread:a", makeFake("sess-1"), "test");

    await expect(run).rejects.toThrow("quarantined");
    expect(spawned).toBe(0);
  });
});

describe("the retirement fence", () => {
  it("is refused synchronously from the moment a retirement begins, and lifted when it confirms", async () => {
    // Fault (site: `fenceSession` in `retireEntry`): nothing is fenced while the disposal is
    // in flight. Predicted result: the first `assertSessionSpawnable` does not throw.
    const pty = makeFake("sess-1");
    pty.canDie = true;
    let release!: () => void;
    pty.holdDispose = new Promise<void>((r) => {
      release = r;
    });
    queue.push(pty);
    await runOnPty("thread:a", "seed", { timeoutMs: 5000, ...scope() });

    const retiring = retirePtySession("thread:a");
    // Synchronously after the call: no await has run, the disposal has not finished.
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).toThrow(PtyQuarantinedError);
    expect(() => assertSessionSpawnable({ sessionId: "sess-1" })).toThrow(PtyQuarantinedError);
    expect(isSessionQuarantined({ sessionKey: "thread:a" })).toBe(false);

    release();
    await retiring;
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).not.toThrow();
    expect(() => assertSessionSpawnable({ sessionId: "sess-1" })).not.toThrow();
  });

  it("becomes the quarantine record, with no gap, when the exit is not confirmed", async () => {
    // Fault (site: `quarantineSession` dropping the fence late, or `retireEntry` lifting it
    // before quarantining): a window with neither. Predicted result: the check after the
    // retirement does not throw.
    const pty = makeFake("sess-1");
    queue.push(pty);
    await runOnPty("thread:a", "seed", { timeoutMs: 5000, ...scope() });

    await retirePtySession("thread:a").catch(() => undefined);

    expect(isSessionQuarantined({ sessionKey: "thread:a" })).toBe(true);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).toThrow(PtyQuarantinedError);
  });

  it("refuses a first spawn that would resume the session of a key whose retirement is in flight", async () => {
    // Fault (site: `assertSessionSpawnable` in `spawnEntry`): the async gate sees no record
    // (the retirement is fenced, not yet unconfirmed), so the replacement is spawned beside
    // the dying process. Predicted result: `spawnCount` goes up by one and the run succeeds.
    const dying = makeFake("sess-1");
    dying.canDie = true;
    let release!: () => void;
    dying.holdDispose = new Promise<void>((r) => {
      release = r;
    });
    queue.push(dying);
    await runOnPty("thread:a", "seed", { timeoutMs: 5000, ...scope() });
    const retiring = retirePtySession("thread:a");
    let spawnCount = 0;
    injectSpawnPty(async () => {
      spawnCount++;
      return makeFake("sess-fresh");
    });

    const r = await runOnPty("thread:b", "hello", {
      timeoutMs: 5000,
      ...scope(),
      sessionStore: memStore("sess-1"),
    }).catch((err: unknown) => err);

    expect(r instanceof Error ? r.message : JSON.stringify(r)).toContain("quarantined");
    expect(spawnCount).toBe(0);
    release();
    await retiring;
  });

  it("module level: fence, then quarantine converts it, then liftFence is a no-op", () => {
    const pty = makeFake("sess-9");
    fenceSession("k", pty);
    expect(() => assertSessionSpawnable({ sessionKey: "k" })).toThrow(PtyQuarantinedError);
    quarantineSession("k", pty, "test");
    liftFence(pty); // the record took the fence over: lifting must not release the session
    expect(() => assertSessionSpawnable({ sessionKey: "k" })).toThrow(PtyQuarantinedError);
  });
});

describe("the gate honours the caller's deadline and abort", () => {
  it("sendToLiveSession returns within its budget and keeps the quarantine", async () => {
    // Fault (site: `assertSessionWritable`, await the confirmation directly): the call waits
    // the full confirmation. Predicted result: elapsed is about 200 ms and `timedOut` is
    // false.
    const slow = makeFake("sess-1");
    slow.confirmDelayMs = 200;
    quarantineSession("global", slow, "test");

    const started = Date.now();
    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5 });
    const elapsed = Date.now() - started;

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(100);
    expect(isSessionQuarantined({ sessionKey: "global" })).toBe(true);
  });

  it("sendToLiveSession returns aborted when the signal fires first", async () => {
    // Fault (site: `assertSessionWritable`, ignore the signal): the call waits out the
    // confirmation. Predicted result: elapsed is about 200 ms and `aborted` is false.
    const slow = makeFake("sess-1");
    slow.confirmDelayMs = 200;
    quarantineSession("global", slow, "test");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);

    const started = Date.now();
    const r = await sendToLiveSession("global", "/compact", {
      timeoutMs: 5000,
      signal: ctl.signal,
    });
    const elapsed = Date.now() - started;

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.aborted).toBe(true);
    expect(elapsed).toBeLessThan(100);
    expect(isSessionQuarantined({ sessionKey: "global" })).toBe(true);
  });

  it("the confirmation keeps running after the caller gave up, and releases a gone pid", async () => {
    // A timeout never releases the quarantine, but the confirmation it abandoned still ends:
    // once it succeeds, the session is writable again.
    const slow = makeFake("sess-1");
    slow.confirmDelayMs = 50;
    slow.canDie = true;
    quarantineSession("global", slow, "test");

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5 });
    expect(r.status === "failed" && r.timedOut).toBe(true);
    expect(isSessionQuarantined({ sessionKey: "global" })).toBe(true);

    await new Promise((res) => setTimeout(res, 120));
    expect(isSessionQuarantined({ sessionKey: "global" })).toBe(false);
  });

  it("runOneShot gives the timed-out result within its budget and keeps the quarantine", async () => {
    // Fault (site: `runOneShot`, call the gate without the deadline): the one-shot waits
    // the full confirmation. Predicted result: elapsed is about 200 ms.
    const slow = makeFake("sess-1");
    slow.confirmDelayMs = 200;
    quarantineSession("global", slow, "test");

    const started = Date.now();
    const r = await runOneShot({
      route: "compact",
      prompt: "p",
      isolation: "trusted-session",
      resumeSessionId: "sess-1",
      timeoutMs: 5,
    });
    const elapsed = Date.now() - started;

    expect(r.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(100);
    expect(isSessionQuarantined({ sessionId: "sess-1" })).toBe(true);
  });

  it("runOneShot rejects with the abort when the signal fires first", async () => {
    // Fault (site: `runOneShot`, call the gate without the signal): the one-shot waits the
    // full confirmation. Predicted result: elapsed is about 200 ms.
    const slow = makeFake("sess-1");
    slow.confirmDelayMs = 200;
    quarantineSession("global", slow, "test");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);

    const started = Date.now();
    const run = runOneShot({
      route: "compact",
      prompt: "p",
      isolation: "trusted-session",
      resumeSessionId: "sess-1",
      timeoutMs: 5000,
      signal: ctl.signal,
    });

    await expect(run).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(100);
    expect(isSessionQuarantined({ sessionId: "sess-1" })).toBe(true);
  });
});
