/**
 * A key whose process the OS still shows after SIGKILL is quarantined (#562 round 7, Fix 1).
 *
 * `PtyProcess.dispose()` rejects with `PtyExitUnconfirmedError` when it cannot prove the pid is
 * gone. The supervisor must then not spawn, respawn or resume anything on that session key
 * until a later confirmation succeeds, because the old process may still append to the
 * transcript and the next identical prompt would read its record as its own.
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
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectRespawnRetriesForTests,
  injectSleep,
  injectSpawnPty,
  liveSessionKeys,
  retirePtySession,
  runOnPty,
  sendToLiveSession,
  shutdownSupervisor,
} from "../runner/pty-supervisor";

interface StubbornPty extends PtyProcess {
  /** Whether the OS would confirm the exit right now. */
  canDie: boolean;
  confirmCalls: number;
  /** The next turn finds the process closed before the prompt went out. */
  closeNextTurn: boolean;
}

function makeStubborn(): StubbornPty {
  let alive = true;
  const fake = {
    label: "fake:4242",
    pid: 4242,
    sessionId: "sess-1",
    cwd: "/tmp/fake-cwd",
    canDie: false,
    confirmCalls: 0,
    closeNextTurn: false,
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      if (fake.closeNextTurn) {
        fake.closeNextTurn = false;
        alive = false;
        throw new PtyClosedError(fake.label, 1, null, false);
      }
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" };
    },
    async dispose(): Promise<void> {
      alive = false;
      if (!fake.canDie) throw new PtyExitUnconfirmedError(fake.label, fake.pid);
    },
    async confirmExit(): Promise<void> {
      fake.confirmCalls++;
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

const memStore = () => {
  let id: string | undefined;
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

let spawned: PtyProcess[];
let queue: PtyProcess[];

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectIsSessionResumable(async () => true);
  injectSleep(async () => {});
  injectMaxRetriesForTests(0);
  injectRespawnRetriesForTests(2);
  spawned = [];
  queue = [];
  injectSpawnPty(async (_o: PtyProcessOptions) => {
    const next = queue.shift() ?? makeNormal();
    spawned.push(next);
    return next;
  });
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
});

describe("quarantine of a key whose process is not proven dead", () => {
  it("retiring an unconfirmed process quarantines the key: no replacement is spawned", async () => {
    // Fault (c) (site: `retireEntry`, drop the `quarantinePty` call): the key is free as soon
    // as the entry leaves the map, so the next run spawns a second process beside the live
    // one. Predicted result: `spawned.length` is 2 and the run succeeds.
    const stubborn = makeStubborn();
    queue.push(stubborn);
    const first = await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    expect(first.exitCode).toBe(0);

    // The retirement itself reports the unconfirmed exit (#562 round 8): a caller must not go on.
    await expect(retirePtySession("global")).rejects.toThrow("quarantined");
    expect(liveSessionKeys()).toContain("global");

    const second = await runOnPty("global", "again", { timeoutMs: 5000, ...scope() }).catch(
      (err: unknown) => err,
    );

    expect(spawned.length).toBe(1);
    const failed = second instanceof Error ? second.message : JSON.stringify(second);
    expect(failed).toContain("quarantined");
  });

  it("the quarantine lifts once the OS confirms the exit, and then the key spawns again", async () => {
    const stubborn = makeStubborn();
    queue.push(stubborn);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    await retirePtySession("global").catch(() => undefined);

    // Still alive: refused, and every refusal asked the process to prove it again.
    await runOnPty("global", "x", { timeoutMs: 5000, ...scope() }).catch(() => undefined);
    expect(spawned.length).toBe(1);
    expect(stubborn.confirmCalls).toBeGreaterThan(0);

    stubborn.canDie = true;
    const r = await runOnPty("global", "after", { timeoutMs: 5000, ...scope() });

    expect(r.exitCode).toBe(0);
    expect(spawned.length).toBe(2);
    expect(liveSessionKeys()).toEqual(["global"]);
  });

  it("sendToLiveSession on a quarantined key is failed, never not-live (no one-shot resume)", async () => {
    // Fault (site: the `!entry` branch, return not-live as before): the caller is told there
    // is nothing alive and resumes the transcript in a second process. Predicted result:
    // status "not-live".
    queue.push(makeStubborn());
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    await retirePtySession("global").catch(() => undefined);

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 1000 });

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toContain("quarantined");
  });

  it("a crash-recovery respawn does not resume over a process that is not proven dead", async () => {
    // Fault (site: `respawnEntry`, swallow the dispose rejection as before): the dead-looking
    // process is replaced and the stored session is resumed beside it. Predicted result:
    // `spawned.length` is 2.
    const stubborn = makeStubborn();
    queue.push(stubborn);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    injectMaxRetriesForTests(2);
    stubborn.closeNextTurn = true;

    const r = await runOnPty("global", "next", { timeoutMs: 5000, ...scope() }).catch(
      (err: unknown) => err,
    );

    expect(spawned.length).toBe(1);
    const failed = r instanceof Error ? r.message : JSON.stringify(r);
    expect(failed).toContain("quarantined");
  });

  it("a confirmed retirement quarantines nothing", async () => {
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    await retirePtySession("global");
    expect(liveSessionKeys()).toEqual([]);
    const r = await runOnPty("global", "again", { timeoutMs: 5000, ...scope() });
    expect(r.exitCode).toBe(0);
    expect(spawned.length).toBe(2);
  });
});
