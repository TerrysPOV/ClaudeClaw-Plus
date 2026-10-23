/**
 * Retirement owns the spawns still pending on the entry (#562 final round, #592).
 *
 * `retireEntry` used to fence the session only when a PTY had landed, and finished without
 * joining a spawn or respawn still in its ready-settle. That child was untracked: print (or a
 * replacement admission) could resume the same transcript while `landPty` was yet to dispose
 * it. The retirement now fences the KEY from its first step, holds it until every pending
 * spawn has settled and `landPty` has confirmed what it produced, and quarantines the session
 * when the spawn does not settle within `PENDING_SPAWN_BOUND_MS`.
 *
 * Fake PTYs only, in-memory session store, explicit cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import {
  PtyClosedError,
  PtyExitUnconfirmedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
} from "../runner/pty-process";
import {
  __resetQuarantineForTests,
  assertSessionSpawnable,
  assertSessionWritable,
  isSessionQuarantined,
  PtyQuarantinedError,
} from "../runner/pty-quarantine";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectPendingSpawnWait,
  injectRespawnRetriesForTests,
  injectSleep,
  injectSpawnPty,
  liveSessionKeys,
  PENDING_SPAWN_BOUND_MS,
  retirePtySession,
  runOnPty,
  shutdownSupervisor,
} from "../runner/pty-supervisor";

interface FakePty extends PtyProcess {
  disposed: boolean;
  /** Whether the OS would confirm the exit. */
  canDie: boolean;
}

function makeFake(sessionId: string, opts: { dies?: boolean; canDie?: boolean } = {}): FakePty {
  const fake = {
    label: `fake:${sessionId}`,
    pid: 4242,
    sessionId,
    cwd: "/tmp/fake-cwd",
    disposed: false,
    canDie: opts.canDie ?? true,
    isAlive: () => !fake.disposed,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      // Dies before the prompt goes out: the supervisor respawns and replays.
      if (opts.dies) throw new PtyClosedError(fake.label, 1, "SIGKILL");
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId };
    },
    async dispose(): Promise<void> {
      fake.disposed = true;
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
    async confirmExit(): Promise<void> {
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

/** A store that resumes `sess-1`, so a spawn's session id is known while it is pending. */
const scope = () => ({
  sessionStore: memStore("sess-1"),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  while (!cond() && Date.now() < stop) await tick(5);
}

/** Watches `p` without holding the test on it while it is pending. */
function track<T>(p: Promise<T>): { done: () => boolean; p: Promise<T> } {
  let done = false;
  const q = p.then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  q.catch(() => {});
  return { done: () => done, p: q };
}

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
});

afterEach(async () => {
  injectPendingSpawnWait(async () => {});
  await shutdownSupervisor();
  __resetSupervisorForTests();
  __resetQuarantineForTests();
});

describe("a retirement while the first spawn is pending", () => {
  it("is held, refuses a resume on the session synchronously, and ends after the late PTY is confirmed dead", async () => {
    // Fault (site: the `joinPendingSpawns` member of `retireEntry`'s settle): the retirement
    // does not join the spawn. Predicted result: `retiring.done()` is true before the spawn is
    // released and the late PTY is not yet disposed.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const late = makeFake("sess-1");
    let spawnCalls = 0;
    injectSpawnPty(async (_o: PtyProcessOptions) => {
      spawnCalls++;
      if (spawnCalls === 1) {
        await held;
        return late;
      }
      return makeFake("sess-fresh");
    });

    // The caller gives up at 60 ms; the spawn stays on the entry.
    const turn = await runOnPty("thread:a", "x", { timeoutMs: 60, ...scope() });
    expect(turn.exitCode).toBe(1);
    await until(() => spawnCalls === 1); // the abandoned spawn still runs on the entry
    expect(spawnCalls).toBe(1);
    // An entry with only a pending spawn is live to the runner's presence test.
    expect(liveSessionKeys()).toContain("thread:a");

    const retiring = track(retirePtySession("thread:a"));
    await tick(40);
    expect(retiring.done()).toBe(false);
    // Fenced by KEY and by session id although no PTY has landed: nothing may start on it.
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).toThrow(PtyQuarantinedError);
    expect(() => assertSessionSpawnable({ sessionId: "sess-1" })).toThrow(PtyQuarantinedError);
    expect(late.disposed).toBe(false);

    release();
    await retiring.p;
    // The late PTY was disposed and confirmed before the retirement ended.
    expect(late.disposed).toBe(true);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).not.toThrow();
    expect(() => assertSessionSpawnable({ sessionId: "sess-1" })).not.toThrow();
    expect(isSessionQuarantined({ sessionKey: "thread:a" })).toBe(false);

    // The next resume proceeds.
    const next = await runOnPty("thread:a", "two", { timeoutMs: 5000, ...scope() });
    expect(next.exitCode).toBe(0);
    expect(spawnCalls).toBe(2);
  });

  it("is fenced from its first step, and a replacement admission waits instead of resuming beside the child", async () => {
    // Fault (site: `fenceKey` in `retireEntry`, restoring the `if (entry.pty)` condition):
    // nothing is fenced while the spawn is pending. Predicted result: the synchronous check
    // right after `retirePtySession(...)` does not throw.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const spawned: string[] = [];
    injectSpawnPty(async (o: PtyProcessOptions) => {
      spawned.push(o.sessionId ?? "");
      if (spawned.length === 1) await held;
      return makeFake("sess-1");
    });
    await runOnPty("thread:a", "x", { timeoutMs: 60, ...scope() });
    await until(() => spawned.length === 1);

    const retiring = track(retirePtySession("thread:a"));
    // Synchronously after the call: no await has run.
    expect(() => assertSessionSpawnable({ sessionKey: "thread:a" })).toThrow(PtyQuarantinedError);

    const replacement = track(runOnPty("thread:a", "again", { timeoutMs: 5000, ...scope() }));
    await tick(40);
    expect(spawned).toHaveLength(1); // not spawned beside the pending child
    expect(replacement.done()).toBe(false);

    release();
    await retiring.p;
    expect((await replacement.p).exitCode).toBe(0);
    expect(spawned).toHaveLength(2);
  });
});

describe("a retirement while a respawn is pending", () => {
  it("is held until the late respawn is disposed", async () => {
    // Fault: as above, on the respawn path (`respawnEntryWithRetries` owns `spawnInFlight`).
    // Predicted result: the retirement resolves while the respawn is still held.
    injectMaxRetriesForTests(1);
    injectRespawnRetriesForTests(3);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const respawned = makeFake("sess-1");
    let spawnCalls = 0;
    injectSpawnPty(async () => {
      spawnCalls++;
      if (spawnCalls === 1) return makeFake("sess-1", { dies: true });
      await held;
      return respawned;
    });

    const turn = await runOnPty("thread:r", "x", { timeoutMs: 500, ...scope() });
    expect(turn.exitCode).toBe(1);
    expect(spawnCalls).toBe(2); // the respawn is in flight and abandoned by its caller

    const retiring = track(retirePtySession("thread:r"));
    await tick(40);
    expect(retiring.done()).toBe(false);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:r" })).toThrow(PtyQuarantinedError);
    expect(respawned.disposed).toBe(false);

    release();
    await retiring.p;
    expect(respawned.disposed).toBe(true);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:r" })).not.toThrow();
  });
});

describe("a late PTY whose exit cannot be confirmed", () => {
  it("quarantines the session after the retirement", async () => {
    // Fault (site: `landPty` quarantine on `PtyExitUnconfirmedError`): the late PTY is
    // dropped as if confirmed. Predicted result: `retirePtySession` resolves and the session
    // is not quarantined.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const late = makeFake("sess-1", { canDie: false });
    let spawnStarted = 0;
    injectSpawnPty(async () => {
      spawnStarted++;
      await held;
      return late;
    });
    await runOnPty("thread:q", "x", { timeoutMs: 60, ...scope() });
    await until(() => spawnStarted > 0);

    const retiring = track(retirePtySession("thread:q"));
    await tick(30);
    expect(retiring.done()).toBe(false);
    release();

    await expect(retiring.p).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(isSessionQuarantined({ sessionKey: "thread:q" })).toBe(true);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:q" })).toThrow(PtyQuarantinedError);
  });
});

describe("a pending spawn that never settles", () => {
  it("is quarantined once the bound passes, never released", async () => {
    // Fault (site: the bound branch of `retireEntry`, lifting the fence instead of
    // quarantining): predicted result: the retirement resolves and `assertSessionSpawnable`
    // does not throw afterwards.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const late = makeFake("sess-1");
    let spawnStarted = 0;
    injectSpawnPty(async () => {
      spawnStarted++;
      await held;
      return late;
    });
    // The fake clock: the bound ends when the test says so, and records how long it was asked for.
    let askedMs = -1;
    let expire!: () => void;
    injectPendingSpawnWait((ms) => {
      askedMs = ms;
      return new Promise<void>((r) => {
        expire = r;
      });
    });
    await runOnPty("thread:n", "x", { timeoutMs: 60, ...scope() });
    await until(() => spawnStarted > 0);

    const retiring = track(retirePtySession("thread:n"));
    await tick(40);
    expect(askedMs).toBe(PENDING_SPAWN_BOUND_MS);
    expect(PENDING_SPAWN_BOUND_MS).toBe(15_000);
    expect(retiring.done()).toBe(false);

    expire();
    await expect(retiring.p).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(isSessionQuarantined({ sessionKey: "thread:n" })).toBe(true);
    expect(isSessionQuarantined({ sessionId: "sess-1" })).toBe(true);
    expect(() => assertSessionSpawnable({ sessionKey: "thread:n" })).toThrow(PtyQuarantinedError);
    // Not released by asking again while the spawn is still pending.
    await expect(assertSessionWritable({ sessionKey: "thread:n" })).rejects.toBeInstanceOf(
      PtyQuarantinedError,
    );

    // The spawn finally settles: `landPty` disposes the late arrival, and the next gate lifts
    // the quarantine.
    release();
    await until(() => late.disposed);
    expect(late.disposed).toBe(true);
    await assertSessionWritable({ sessionKey: "thread:n" });
    expect(isSessionQuarantined({ sessionKey: "thread:n" })).toBe(false);
  });
});
