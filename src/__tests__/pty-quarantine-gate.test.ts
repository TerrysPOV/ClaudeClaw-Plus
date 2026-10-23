/**
 * One quarantine gate on every path that can start a writer on a session (#562 round 8).
 *
 * Round 7 fenced `runOnPty` admission only. Two other paths still reached a one-shot resume of
 * the same transcript while a process the OS had not confirmed gone could write to it: the
 * entry a failed crash recovery retains, and `skipLive` after a retirement that quarantined
 * instead of failing. The registry is now keyed by session (supervisor key AND claude session
 * id) and `assertSessionWritable` is the gate each of those paths passes.
 *
 * Fake PTYs only, in-memory session store, explicit cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import { runOneShot, type OneShotEngine } from "../oneshot/engine";
import { engines } from "../oneshot/registry";
import {
  PtyClosedError,
  PtyExitUnconfirmedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
} from "../runner/pty-process";
import { actOnSession, injectOneShotForTests } from "../runner/live-session-actions";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectRespawnRetriesForTests,
  injectSleep,
  injectSpawnPty,
  killAllPtysReport,
  retirePtySession,
  runOnPty,
  sendToLiveSession,
  shutdownSupervisor,
  snapshotSupervisor,
  supervisorEntryCount,
} from "../runner/pty-supervisor";
import { _setClaudeSpawnForTests, runClaudeOnce } from "../runner";

interface StubbornPty extends PtyProcess {
  /** Whether the OS would confirm the exit right now. */
  canDie: boolean;
  closeNextTurn: boolean;
  /** `isAlive()` stays true after a dispose that was not confirmed (the process IS alive). */
  stuckAlive: boolean;
  /** The next failing turn waits for this before it throws. */
  holdFailure?: Promise<void>;
  /** Called when the failing turn has started (so it holds the lock). */
  onFailingTurn?: () => void;
}

function makeStubborn(sessionId = "sess-1"): StubbornPty {
  let alive = true;
  const fake = {
    label: "fake:4242",
    pid: 4242,
    sessionId,
    cwd: "/tmp/fake-cwd",
    canDie: false,
    closeNextTurn: false,
    stuckAlive: false,
    holdFailure: undefined as Promise<void> | undefined,
    onFailingTurn: undefined as (() => void) | undefined,
    isAlive: () => alive || fake.stuckAlive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      if (fake.closeNextTurn) {
        fake.closeNextTurn = false;
        fake.onFailingTurn?.();
        await fake.holdFailure;
        alive = false;
        throw new PtyClosedError(fake.label, 1, null, false);
      }
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId };
    },
    async dispose(): Promise<void> {
      alive = false;
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
    async confirmExit(): Promise<void> {
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
  };
  return fake as unknown as StubbornPty;
}

function makeNormal(): PtyProcess {
  let alive = true;
  return {
    label: "fake:5555",
    pid: 5555,
    sessionId: "sess-2",
    cwd: "/tmp/fake-cwd",
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-2" };
    },
    async dispose(): Promise<void> {
      alive = false;
    },
  };
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

const scope = (storedId?: string) => ({
  sessionStore: memStore(storedId),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

let queue: PtyProcess[];
let oneShotCalls: number;
let spawnCount: number;

const fakeOneShot = async () => {
  oneShotCalls++;
  return { text: "one-shot ran", engine: "fake", model: "m", exitCode: 0 };
};

/** Seed `key` with a stubborn process and retire it: the key is now quarantined. */
async function quarantine(key: string, stubborn: StubbornPty): Promise<void> {
  queue.push(stubborn);
  await runOnPty(key, "seed", { timeoutMs: 5000, ...scope() });
  await retirePtySession(key).catch(() => undefined);
}

const compact = (extra: Record<string, unknown>) =>
  actOnSession({
    route: "compact",
    prompt: "/compact",
    sessionId: "sess-1",
    timeoutMs: 1000,
    ...extra,
  });

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectIsSessionResumable(async () => true);
  injectSleep(async () => {});
  injectMaxRetriesForTests(0);
  injectRespawnRetriesForTests(2);
  queue = [];
  oneShotCalls = 0;
  spawnCount = 0;
  injectOneShotForTests(fakeOneShot);
  injectSpawnPty(async (_o: PtyProcessOptions) => {
    spawnCount++;
    return queue.shift() ?? makeNormal();
  });
});

afterEach(async () => {
  injectOneShotForTests(null);
  _setClaudeSpawnForTests(null);
  await shutdownSupervisor();
  __resetSupervisorForTests();
});

describe("the retained entry of a failed crash recovery", () => {
  it("sendToLiveSession answers failed, and no one-shot resumes the transcript", async () => {
    // Fault (site: `sendToLiveSession`, the gate at the top of the loop): the retained entry's
    // process reports dead, so the call answers `not-live`. Predicted result: status
    // "not-live" with reason "no-process".
    const stubborn = makeStubborn();
    queue.push(stubborn);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    injectMaxRetriesForTests(2);
    stubborn.closeNextTurn = true;
    await runOnPty("global", "next", { timeoutMs: 5000, ...scope() }).catch(() => undefined);

    const sent = await sendToLiveSession("global", "/compact", { timeoutMs: 1000 });
    const acted = await compact({ sessionKey: "global" });

    expect(sent.status).toBe("failed");
    if (sent.status === "failed") expect(sent.error).toContain("quarantined");
    expect(acted.ok).toBe(false);
    expect(oneShotCalls).toBe(0);
  });
});

describe("a send queued behind a turn whose crash recovery quarantines the process", () => {
  it("is checked again under the lock and never writes to the process", async () => {
    // Fault (site: `sendToLiveSession`, the check under the lock): the entry is still
    // current and its process still reports alive, so the queued prompt is written to a
    // process that may keep writing the transcript. Predicted result: status "sent".
    const stubborn = makeStubborn();
    stubborn.stuckAlive = true;
    queue.push(stubborn);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    injectMaxRetriesForTests(2);
    let openGate: () => void = () => {};
    stubborn.holdFailure = new Promise<void>((r) => {
      openGate = r;
    });
    stubborn.closeNextTurn = true;
    const holding = new Promise<void>((r) => {
      stubborn.onFailingTurn = r;
    });
    const turn = runOnPty("global", "next", { timeoutMs: 5000, ...scope() }).catch(() => undefined);
    await holding; // the failing turn now holds the lock

    const queued = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await new Promise<void>((r) => setTimeout(r, 20)); // it is now waiting on the lock
    openGate();
    await turn;
    const sent = await queued;

    expect(sent.status).toBe("failed");
    if (sent.status === "failed") expect(sent.error).toContain("quarantined");
  });
});

describe("skipLive after a retirement that could not prove the exit", () => {
  it("fails the call as a retirement failure and starts no one-shot", async () => {
    // Fault (site: `retirePtySession`, drop the `assertSessionWritable` after the retirement):
    // the retirement "succeeds", and the failure is attributed to the generic gate instead.
    // Predicted result: `detail` lacks "could not retire the wedged session".
    queue.push(makeStubborn());
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });

    const r = await compact({ sessionKey: "global", skipLive: true });

    expect(r.ok).toBe(false);
    expect(r.detail).toContain("could not retire the wedged session");
    expect(r.detail).toContain("quarantined");
    expect(oneShotCalls).toBe(0);
  });
});

describe("the one-shot fallback is gated by session id as well as key", () => {
  it("a transcript quarantined under another key is not resumed one-shot", async () => {
    // Fault (site: `actOnSession`, the gate before `_runOneShot`): the key asked about has no
    // entry, so the call is `not-live` and resumes the transcript another key's unconfirmed
    // process still holds. Predicted result: `oneShotCalls` is 2 and both calls are ok.
    await quarantine("thread:a", makeStubborn("sess-1"));

    const byOtherKey = await compact({ sessionKey: "thread:b" });
    const byIdOnly = await compact({});

    expect(byOtherKey.ok).toBe(false);
    expect(byIdOnly.ok).toBe(false);
    expect(byIdOnly.detail).toContain("quarantined");
    expect(oneShotCalls).toBe(0);
  });

  it("runOneShot refuses a resume of a quarantined transcript before any engine runs", async () => {
    // Fault (site: `runOneShot`, the `resumeSessionId` gate): the engine runs. Predicted
    // result: `engineRuns` is 1 and the call resolves.
    await quarantine("thread:a", makeStubborn("sess-1"));
    let engineRuns = 0;
    const stub: OneShotEngine = {
      id: "stub",
      caps: { resume: true, tools: true, isolation: true },
      run: async () => {
        engineRuns++;
        return { text: "x", engine: "stub", model: "m", exitCode: 0 };
      },
    };
    const saved = new Map(engines);
    for (const id of saved.keys()) engines.set(id, { ...stub, id });
    try {
      await expect(
        runOneShot({
          route: "compact",
          prompt: "p",
          isolation: "trusted-session",
          resumeSessionId: "sess-1",
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("quarantined");
    } finally {
      for (const [id, e] of saved) engines.set(id, e);
    }
    expect(engineRuns).toBe(0);
  });

  it("the legacy `claude -p --resume` is refused too", async () => {
    // Fault (site: `gateResume` in runner.ts): the process is spawned beside the unconfirmed
    // one. Predicted result: `spawned` is 1.
    await quarantine("thread:a", makeStubborn("sess-1"));
    let spawned = 0;
    _setClaudeSpawnForTests((() => {
      spawned++;
      throw new Error("must not spawn");
    }) as never);

    await expect(
      runClaudeOnce(["claude", "-p", "x", "--resume", "sess-1"], "", "", {}, 1000),
    ).rejects.toThrow("quarantined");
    expect(spawned).toBe(0);
  });
});

describe("a session id held under another key", () => {
  it("a first spawn that would resume the stored session id of a quarantined key is refused", async () => {
    // Fault (site: `spawnEntry`, the gate before `spawn`): admission sees only the NEW key and
    // no `resumeSessionId`, so the stored id is resumed beside the unconfirmed process.
    // Predicted result: `spawnCount` is 2 and the run succeeds.
    await quarantine("thread:a", makeStubborn("sess-1"));
    const before = spawnCount;

    const r = await runOnPty("thread:b", "hello", {
      timeoutMs: 5000,
      ...scope("sess-1"),
    }).catch((err: unknown) => err);

    const failed = r instanceof Error ? r.message : JSON.stringify(r);
    expect(failed).toContain("quarantined");
    expect(spawnCount).toBe(before);
  });

  it("a crash-recovery respawn that would resume a quarantined session id is refused", async () => {
    // Fault (site: `respawnEntry`, the gate before `spawn`): the replacement resumes the
    // transcript beside the unconfirmed process of the other key. Predicted result:
    // `spawnCount` goes up by one and the run succeeds.
    await quarantine("thread:a", makeStubborn("sess-1"));
    const crashy = makeStubborn("sess-1");
    crashy.canDie = true; // its own dispose is confirmed; the OTHER key's process is not
    queue.push(crashy);
    await runOnPty("thread:b", "seed", { timeoutMs: 5000, ...scope() });
    injectMaxRetriesForTests(2);
    crashy.closeNextTurn = true;
    const before = spawnCount;

    const r = await runOnPty("thread:b", "next", { timeoutMs: 5000, ...scope() }).catch(
      (err: unknown) => err,
    );

    const failed = r instanceof Error ? r.message : JSON.stringify(r);
    expect(failed).toContain("quarantined");
    expect(spawnCount).toBe(before);
  });
});

describe("recovery and visibility", () => {
  it("the next use from ANY path releases the quarantine once the pid is gone", async () => {
    // Fault (site: `assertSessionWritable`, skip the confirmation retry): the session stays
    // blocked for ever. Predicted result: the one-shot never runs (`oneShotCalls` 0).
    const stubborn = makeStubborn();
    await quarantine("global", stubborn);
    expect((await compact({ sessionKey: "global" })).ok).toBe(false);
    expect(snapshotSupervisor().quarantined).toHaveLength(1);

    stubborn.canDie = true;
    const r = await compact({ sessionKey: "global" });

    expect(r.ok).toBe(true);
    expect(oneShotCalls).toBe(1);
    expect(snapshotSupervisor().quarantined).toEqual([]);
  });

  it("status lists a quarantined session with its key, pid, reason and time", async () => {
    // Fault (site: `snapshotSupervisor`, leave `quarantined` empty): an idle retirement
    // disappears from status. Predicted result: `quarantined` is [].
    const before = Date.now();
    await quarantine("global", makeStubborn());

    const [q] = snapshotSupervisor().quarantined;

    expect(q).toMatchObject({
      sessionKey: "global",
      sessionId: "sess-1",
      pid: 4242,
      reason: "retire-exit-unconfirmed",
    });
    expect(q?.since).toBeGreaterThanOrEqual(before);
    // `/kill` is gated on this count: a quarantined process alone is still something to kill.
    expect(supervisorEntryCount()).toBeGreaterThan(0);
  });

  it("/kill and shutdown count the exits they could not confirm", async () => {
    // Fault (site: `killAllPtysReport`, skip the final confirmation): the count is 0.
    // Predicted result: `unconfirmed` is 0 although the process is still there.
    await quarantine("global", makeStubborn());

    const killed = await killAllPtysReport();
    const shut = await shutdownSupervisor();

    expect(killed.unconfirmed).toBe(1);
    expect(shut).toBe(1);
  });
});
