/**
 * `sendToLiveSession` (#549): write one turn into an already-live, idle supervisor
 * entry — or say `not-live` and spawn nothing.
 *
 * Fake PTYs only. Every entry is seeded through `runOnPty` with an in-memory
 * `sessionStore` and an explicit `cwd`, so nothing touches `session.json` or `agents/`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectSleep,
  injectSpawnPty,
  liveSessionKeys,
  retirePtySession,
  runOnPty,
  sendToLiveSession,
  shutdownSupervisor,
  supervisorEntryCount,
} from "../runner/pty-supervisor";
import {
  type PtyProcess,
  type PtyProcessOptions,
  PtyTurnTimeoutError,
  type PtyTurnResult,
} from "../runner/pty-process";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakePty extends PtyProcess {
  prompts: string[];
  disposed: boolean;
}

/** Per-prompt behaviour: default echoes. `gates` hold a turn open until released. */
function makeFake(
  opts: { onPrompt?: (prompt: string, idx: number) => Promise<PtyTurnResult> } = {},
): FakePty {
  const prompts: string[] = [];
  let alive = true;
  let disposed = false;
  const fake = {
    label: "fake",
    pid: 4242,
    sessionId: "sess-1",
    cwd: "/tmp/fake-cwd",
    prompts,
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      const idx = prompts.length;
      prompts.push(prompt);
      if (opts.onPrompt) return opts.onPrompt(prompt, idx);
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" };
    },
    async dispose(): Promise<void> {
      alive = false;
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  };
  return fake as unknown as FakePty;
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

/** Scope that keeps the supervisor off the real filesystem. */
const scope = () => ({
  sessionStore: memStore(),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

let spawned: FakePty[];
let spawnOpts: PtyProcessOptions[];
let nextFake: () => FakePty;

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectIsSessionResumable(async () => true);
  injectSleep(async () => {});
  injectMaxRetriesForTests(0);
  spawned = [];
  spawnOpts = [];
  nextFake = () => makeFake();
  injectSpawnPty(async (o) => {
    const f = nextFake();
    spawned.push(f);
    spawnOpts.push(o);
    return f;
  });
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
});

/** Seed a live idle entry on `key` with one completed turn. */
async function seed(key: string): Promise<void> {
  const r = await runOnPty(key, "seed", { timeoutMs: 5000, ...scope() });
  expect(r.exitCode).toBe(0);
}

describe("sendToLiveSession", () => {
  it("writes ONE turn into a live idle entry and resolves on end of turn", async () => {
    await seed("global");
    expect(spawned.length).toBe(1);

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    expect(r.status).toBe("sent");
    if (r.status !== "sent") throw new Error("unreachable");
    expect(r.text).toBe("echo:/compact");
    expect(r.cleanBoundary).toBe(true);
    // exactly one extra turn, and it is the text we sent; no second process
    expect(spawned[0].prompts).toEqual(["seed", "/compact"]);
    expect(spawned.length).toBe(1);
  });

  it("returns not-live without spawning when there is no entry for the key", async () => {
    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    expect(r).toEqual({ status: "not-live", reason: "no-entry" });
    expect(spawned.length).toBe(0);
  });

  it("busy: queues behind the running turn, then sends live; never reports not-live", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return p === "long turn"
        ? gate.promise
        : Promise.resolve({
            text: "ok",
            bytesCaptured: 1,
            cleanBoundary: true,
            sessionId: "sess-1",
          });
    }) as PtyProcess["runTurn"];
    const running = runOnPty("global", "long turn", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(30);
    // nothing written on top of the user's turn while it runs
    expect(spawned[0].prompts).toEqual(["seed", "long turn"]);

    gate.resolve({ text: "done", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    await running;
    const r = await sending;
    expect(r.status).toBe("sent");
    expect(spawned[0].prompts).toEqual(["seed", "long turn", "/compact"]);
    expect(spawned.length).toBe(1);
  });

  it("busy past the timeout: failed (no not-live), and the abandoned send is never written later", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return gate.promise;
    }) as PtyProcess["runTurn"];
    const running = runOnPty("global", "long turn", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 40 });

    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("waited");
    // the user's turn is left alone: not retired, not disposed
    expect(spawned[0].disposed).toBe(false);
    // the abandoned send must not open the lock early: a later turn still queues
    // behind the one that is running
    const later = runOnPty("global", "later user message", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(30);
    expect(spawned[0].prompts).toEqual(["seed", "long turn"]);
    spawned[0].runTurn = (async (p: string) => {
      spawned[0].prompts.push(p);
      return { text: "x", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" };
    }) as PtyProcess["runTurn"];
    gate.resolve({ text: "done", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    await running;
    await later;
    await Bun.sleep(20);
    // /compact never ran; the later user message did, after the long turn
    expect(spawned[0].prompts).toEqual(["seed", "long turn", "later user message"]);
    // and the lock chain is intact: a later send goes through
    expect((await sendToLiveSession("global", "/later", { timeoutMs: 5000 })).status).toBe("sent");
  });

  it("a spawn still in flight: waits for it and sends live, not not-live", async () => {
    const spawnGate = deferred<void>();
    injectSpawnPty(async (o) => {
      await spawnGate.promise;
      const f = nextFake();
      spawned.push(f);
      spawnOpts.push(o);
      return f;
    });
    const first = runOnPty("global", "first", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(10);

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(20);
    expect(spawned.length).toBe(0);

    spawnGate.resolve();
    expect((await first).exitCode).toBe(0);
    const r = await sending;
    expect(r.status).toBe("sent");
    expect(spawned[0].prompts).toEqual(["first", "/compact"]);
  });

  it("a spawn whose caller gave up is still in flight: waits for it, never not-live", async () => {
    const spawnGate = deferred<void>();
    injectSpawnPty(async (o) => {
      await spawnGate.promise;
      const f = nextFake();
      spawned.push(f);
      spawnOpts.push(o);
      return f;
    });
    // the first caller's own deadline passes during the spawn; the spawn goes on
    const gaveUp = await runOnPty("global", "first", { timeoutMs: 30, ...scope() });
    expect(gaveUp.exitCode).toBe(1);

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(20);
    spawnGate.resolve();

    const r = await sending;
    expect(r.status).toBe("sent");
    expect(spawned.length).toBe(1);
    expect(spawned[0].prompts).toEqual(["/compact"]);
  });

  it("the process dies while the send is queued: not-live, nothing written to the dead PTY", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return gate.promise;
    }) as PtyProcess["runTurn"];
    const running = runOnPty("global", "long turn", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);
    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(10);

    await spawned[0].dispose(); // the process exits mid-turn
    gate.resolve({ text: "done", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    await running;

    expect(await sending).toEqual({ status: "not-live", reason: "no-process" });
    expect(spawned[0].prompts).toEqual(["seed", "long turn"]);
  });

  it("the wait and the turn share ONE budget: the turn gets only what the wait left", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    const seen: number[] = [];
    spawned[0].runTurn = ((p: string, o: { timeoutMs: number }) => {
      spawned[0].prompts.push(p);
      if (p === "long turn") return gate.promise;
      seen.push(o.timeoutMs);
      return Promise.resolve({
        text: "ok",
        bytesCaptured: 1,
        cleanBoundary: true,
        sessionId: "sess-1",
      });
    }) as PtyProcess["runTurn"];
    const running = runOnPty("global", "long turn", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(60);
    gate.resolve({ text: "done", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    await running;
    await sending;

    expect(seen.length).toBe(1);
    expect(seen[0]).toBeLessThan(5000 - 40);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("an entry being retired: waits until its process is gone; then no-entry (safe to fall back)", async () => {
    await seed("global");
    const disposeGate = deferred<void>();
    const realDispose = spawned[0].dispose.bind(spawned[0]);
    spawned[0].dispose = async () => {
      await disposeGate.promise;
      await realDispose();
    };
    const retiring = retirePtySession("global");
    await Bun.sleep(5);

    let settled = false;
    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 }).then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false); // the old process may still be alive: no verdict yet

    disposeGate.resolve();
    await retiring;
    expect(await sending).toEqual({ status: "not-live", reason: "no-entry" });
  });

  it("an entry being retired that never finishes: failed within the timeout, never not-live", async () => {
    await seed("global");
    const disposeGate = deferred<void>();
    spawned[0].dispose = async () => {
      await disposeGate.promise;
    };
    const retiring = retirePtySession("global");
    await Bun.sleep(5);

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 40 });

    expect(r.status).toBe("failed");
    disposeGate.resolve();
    await retiring;
  });

  it("shutting down with the process still there: failed, not not-live", async () => {
    await seed("global");
    const disposeGate = deferred<void>();
    spawned[0].dispose = async () => {
      await disposeGate.promise;
    };
    const shutting = shutdownSupervisor();
    await Bun.sleep(5);

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 40 });

    expect(r.status).toBe("failed");
    disposeGate.resolve();
    await shutting;
    // once the process is gone there is nothing left to race
    expect(await sendToLiveSession("global", "/compact", { timeoutMs: 40 })).toEqual({
      status: "not-live",
      reason: "no-entry",
    });
  });

  it("an entry whose process has died: not-live (nothing alive to race)", async () => {
    await seed("global");
    await spawned[0].dispose();

    expect(await sendToLiveSession("global", "/compact", { timeoutMs: 5000 })).toEqual({
      status: "not-live",
      reason: "no-process",
    });
  });

  it("holds the per-key lock: a runOnPty issued mid-send waits for the send to end", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return p === "/compact"
        ? gate.promise
        : Promise.resolve({
            text: "ok",
            bytesCaptured: 1,
            cleanBoundary: true,
            sessionId: "sess-1",
          });
    }) as PtyProcess["runTurn"];

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(5);
    const concurrent = runOnPty("global", "user message", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(20);
    // the user's turn must NOT have been written into the PTY while /compact runs
    expect(spawned[0].prompts).toEqual(["seed", "/compact"]);

    gate.resolve({ text: "compacted", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    expect((await sending).status).toBe("sent");
    expect((await concurrent).exitCode).toBe(0);
    expect(spawned[0].prompts).toEqual(["seed", "/compact", "user message"]);
  });

  it("is idle again after a send, and after a runOnPty that gave up waiting on its predecessor", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return gate.promise;
    }) as PtyProcess["runTurn"];
    const first = runOnPty("global", "slow", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);
    // second caller gives up waiting for `slow` (its own timeoutMs is tiny)
    const second = await runOnPty("global", "impatient", { timeoutMs: 30, ...scope() });
    expect(second.exitCode).toBe(1);

    gate.resolve({ text: "done", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
    await first;
    await Bun.sleep(5);
    spawned[0].runTurn = (async (p: string) => {
      spawned[0].prompts.push(p);
      return { text: "x", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" };
    }) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    expect(r.status).toBe("sent");
  });

  it("on a turn timeout reports failed+timedOut and retires the entry (no fallback signal)", async () => {
    await seed("global");
    spawned[0].runTurn = (async () => {
      throw new PtyTurnTimeoutError("fake", 5000);
    }) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.timedOut).toBe(true);
    expect(spawned[0].disposed).toBe(true);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("an abort stops the wait at once but keeps the lock until the turn really ends", async () => {
    await seed("global");
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return gate.promise;
    }) as PtyProcess["runTurn"];
    const ac = new AbortController();

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000, signal: ac.signal });
    await Bun.sleep(5);
    ac.abort();
    const r = await sending;

    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.aborted).toBe(true);
    // the PTY is still mid-turn: a second send must not be written on top of it
    const again = await sendToLiveSession("global", "/again", { timeoutMs: 40 });
    expect(again.status).toBe("failed");
    expect(spawned[0].prompts).toEqual(["seed", "/compact"]);
    gate.resolve({ text: "late", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
  });

  it("an already-aborted signal writes nothing", async () => {
    await seed("global");
    const ac = new AbortController();
    ac.abort();

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000, signal: ac.signal });

    expect(r.status).toBe("failed");
    expect(spawned[0].prompts).toEqual(["seed"]);
  });

  it("does not treat an in-flight ephemeral one-shot as a live session", async () => {
    const gate = deferred<PtyTurnResult>();
    nextFake = () =>
      makeFake({
        onPrompt: () => gate.promise,
      });
    const oneShot = runOnPty("fallback:global", "x", {
      timeoutMs: 5000,
      ...scope(),
      ephemeral: true,
    });
    await Bun.sleep(10);

    const r = await sendToLiveSession("fallback:global", "/compact", { timeoutMs: 5000 });

    expect(r.status).toBe("not-live");
    expect(liveSessionKeys()).toEqual([]);
    gate.resolve({ text: "x", bytesCaptured: 1, cleanBoundary: true, sessionId: "s" });
    await oneShot;
  });
});

describe("liveSessionKeys", () => {
  it("lists keys of live, non-ephemeral entries, sorted", async () => {
    await seed("global");
    await seed("agent:suzy");
    await seed("thread:42");

    expect(liveSessionKeys()).toEqual(["agent:suzy", "global", "thread:42"]);
  });

  it("omits an entry whose process has died", async () => {
    await seed("global");
    await spawned[0].dispose();

    expect(liveSessionKeys()).toEqual([]);
  });
});
