/**
 * `sendToLiveSession` (#549): write one turn into an already-live, idle supervisor
 * entry — or say `not-live` and spawn nothing.
 *
 * Fake PTYs only. Every entry is seeded through `runOnPty` with an in-memory
 * `sessionStore` and an explicit `cwd`, so nothing touches `session.json` or `agents/`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import { type MemorySaveDeps, saveMemoryAtShutdown } from "../shutdown-memory-save";
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
  PtyPromptNotAcceptedError,
  PtyTurnFailedError,
  PtyTurnTimeoutError,
  type PtyTurnResult,
  TranscriptReplacedError,
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

  it("#562 round 2: an unconfirmed turn boundary reports failed (not sent) and retires the entry", async () => {
    await seed("global");
    spawned[0].runTurn = (async () => ({
      text: "partial",
      bytesCaptured: 7,
      cleanBoundary: false,
      sessionId: "sess-1",
    })) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    // Fault: report the send as "sent" again and this is a success on a partial answer.
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("boundary unconfirmed");
    expect(spawned[0].disposed).toBe(true);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("#562 round 3: an unconfirmed boundary fails even with a complete reply and `replyComplete`", async () => {
    await seed("global");
    spawned[0].runTurn = (async () => ({
      text: "the whole answer",
      bytesCaptured: 16,
      cleanBoundary: false,
      replyComplete: true,
      sessionId: "sess-1",
    })) as unknown as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "hello", { timeoutMs: 5000 });

    // Fault: restore the `replyComplete` exception and this is "sent" with the text.
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("boundary unconfirmed");
    expect(spawned[0].disposed).toBe(true);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("#562 round 3: an API error or a command's stderr in the transcript reports failed (not sent) and retires the entry", async () => {
    for (const [kind, text] of [
      ["api-error", "API Error: 529"],
      ["command-error", "Error: Not enough messages to compact."],
    ] as const) {
      await seed("global");
      spawned[spawned.length - 1].runTurn = (async () => {
        throw new PtyTurnFailedError("fake", kind, text);
      }) as PtyProcess["runTurn"];

      const r = await sendToLiveSession("global", "hello", { timeoutMs: 5000 });

      // Fault: leave PtyTurnFailedError out of the retire list and the entry stays live.
      expect(r.status).toBe("failed");
      if (r.status !== "failed") throw new Error("unreachable");
      expect(r.error).toContain(text);
      expect(r.timedOut).toBe(false);
      expect(spawned[spawned.length - 1].disposed).toBe(true);
      expect(supervisorEntryCount()).toBe(0);
    }
  });

  it("#562 round 3: a replaced transcript reports failed and retires the entry", async () => {
    await seed("global");
    spawned[0].runTurn = (async () => {
      throw new TranscriptReplacedError("/x/s.jsonl", "was replaced by a different file");
    }) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "hello", { timeoutMs: 5000 });

    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("replaced");
    expect(spawned[0].disposed).toBe(true);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("#562: a prompt claude never accepted reports failed (not sent) and retires the entry", async () => {
    await seed("global");
    spawned[0].runTurn = (async () => {
      throw new PtyPromptNotAcceptedError("fake", 6000);
    }) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    // Fault: drop the retire and the entry stays live on a TUI we cannot read.
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.error).toContain("not accepted");
    expect(r.timedOut).toBe(false);
    expect(spawned[0].disposed).toBe(true);
    expect(supervisorEntryCount()).toBe(0);
  });

  describe("an abort after the prompt was sent (#562 round 6, Fix 1)", () => {
    const shared = () => {
      const store = memStore();
      return { sessionStore: store, cwd: "/tmp/fake-cwd", mcpConfig: { path: undefined } };
    };
    /** Make `fake`'s disposal hold until `exit` resolves, logging when it starts and ends. */
    function slowExit(fake: FakePty, events: string[]): Deferred<void> {
      const exit = deferred<void>();
      fake.dispose = async () => {
        events.push("dispose-start");
        fake.isAlive = () => false;
        await exit.promise;
        events.push("dispose-exited");
      };
      return exit;
    }
    /** Hold `fake`'s next turn open until the returned deferred settles. */
    function holdTurn(fake: FakePty): Deferred<PtyTurnResult> {
      const gate = deferred<PtyTurnResult>();
      fake.runTurn = ((p: string) => {
        fake.prompts.push(p);
        return gate.promise;
      }) as PtyProcess["runTurn"];
      return gate;
    }

    it("retires the entry and returns only after the process has exited; the next call resumes the same session in a new process", async () => {
      // Fault A (site: the abort branch of `sendToLiveSession`, return at once as before):
      // no disposal ever starts, so `events` stays empty. Fault B (start the retirement but
      // do not await it): `returned` is true while the exit is still held.
      const sc = shared();
      expect((await runOnPty("global", "seed", { timeoutMs: 5000, ...sc })).exitCode).toBe(0);
      const events: string[] = [];
      const gate = holdTurn(spawned[0]);
      const exit = slowExit(spawned[0], events);
      const ac = new AbortController();

      let returned = false;
      const sending = sendToLiveSession("global", "/compact", {
        timeoutMs: 5000,
        signal: ac.signal,
      }).then((r) => {
        returned = true;
        events.push("returned");
        return r;
      });
      await Bun.sleep(5);
      ac.abort();
      await Bun.sleep(30);
      expect(events).toEqual(["dispose-start"]);
      expect(returned).toBe(false);
      exit.resolve();
      const r = await sending;

      expect(r.status).toBe("failed");
      if (r.status !== "failed") throw new Error("unreachable");
      expect(r.aborted).toBe(true);
      expect(events).toEqual(["dispose-start", "dispose-exited", "returned"]);
      expect(supervisorEntryCount()).toBe(0);
      // the abandoned turn failing later changes nothing
      gate.reject(new Error("process closed"));
      await Bun.sleep(5);

      const next = await runOnPty("global", "next", { timeoutMs: 5000, ...sc });
      expect(next.exitCode).toBe(0);
      expect(spawned).toHaveLength(2);
      expect(spawnOpts[1]?.sessionId).toBe("sess-1");
    });

    it("keeps the lock until the disposal has finished, even when the abandoned turn rejects first", async () => {
      // Fault (site: the release chain, release as soon as the turn settles as before): the
      // queued turn behind it is let go while the old process is still exiting.
      const sc = shared();
      expect((await runOnPty("global", "seed", { timeoutMs: 5000, ...sc })).exitCode).toBe(0);
      const events: string[] = [];
      const gate = holdTurn(spawned[0]);
      const exit = slowExit(spawned[0], events);
      const ac = new AbortController();
      const sending = sendToLiveSession("global", "/compact", {
        timeoutMs: 5000,
        signal: ac.signal,
      });
      await Bun.sleep(5);
      // a user message queued behind the live send, on the same key
      let behindReturned = false;
      const behind = runOnPty("global", "behind", { timeoutMs: 5000, ...sc }).then((r) => {
        behindReturned = true;
        return r;
      });
      await Bun.sleep(5);

      ac.abort();
      gate.reject(new Error("process closed")); // the abandoned turn settles at once
      await Bun.sleep(30);
      expect(events).toEqual(["dispose-start"]);
      expect(behindReturned).toBe(false);
      exit.resolve();
      await sending;
      await behind;
      expect(spawned[0].prompts).toEqual(["seed", "/compact"]);
    });

    it("an abort while queued behind another turn, before anything was written, retires nothing", async () => {
      // Fault (site: `settleBy` give-up path, retire on any abort): the entry running the
      // OTHER turn is killed.
      const sc = shared();
      expect((await runOnPty("global", "seed", { timeoutMs: 5000, ...sc })).exitCode).toBe(0);
      const gate = holdTurn(spawned[0]);
      const running = runOnPty("global", "running", { timeoutMs: 5000, ...sc });
      await Bun.sleep(5);
      const ac = new AbortController();
      const sending = sendToLiveSession("global", "/compact", {
        timeoutMs: 5000,
        signal: ac.signal,
      });
      await Bun.sleep(5);
      ac.abort();
      const r = await sending;

      expect(r.status).toBe("failed");
      expect(spawned[0].disposed).toBe(false);
      expect(supervisorEntryCount()).toBe(1);
      expect(spawned[0].prompts).toEqual(["seed", "running"]);
      gate.resolve({ text: "ok", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" });
      expect((await running).exitCode).toBe(0);
    });
  });

  it("persists the session id under the lock: an entry retired and replaced before its turn settled leaves the replacement's stored id alone", async () => {
    // One store shared by both entries, as the real per-key store is.
    const store = memStore();
    const sc = () => ({
      sessionStore: store,
      cwd: "/tmp/fake-cwd",
      mcpConfig: { path: undefined },
    });
    expect((await runOnPty("global", "seed", { timeoutMs: 5000, ...sc() })).exitCode).toBe(0);
    const gate = deferred<PtyTurnResult>();
    spawned[0].runTurn = ((p: string) => {
      spawned[0].prompts.push(p);
      return gate.promise;
    }) as PtyProcess["runTurn"];

    const sending = sendToLiveSession("global", "/compact", { timeoutMs: 5000 });
    await Bun.sleep(5);
    // /kill, then a fresh entry for the same key that stores its own id
    void retirePtySession("global");
    await Bun.sleep(5);
    nextFake = () =>
      makeFake({
        onPrompt: async () => ({
          text: "new",
          bytesCaptured: 1,
          cleanBoundary: true,
          sessionId: "sess-NEW",
        }),
      });
    expect((await runOnPty("global", "again", { timeoutMs: 5000, ...sc() })).exitCode).toBe(0);
    expect(await store.load()).toBe("sess-NEW");

    gate.resolve({ text: "late", bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-OLD" });
    await sending;

    expect(await store.load()).toBe("sess-NEW");
  });

  it("persists the id of a live send while the entry is still current", async () => {
    const store = memStore();
    const sc = { sessionStore: store, cwd: "/tmp/fake-cwd", mcpConfig: { path: undefined } };
    expect((await runOnPty("global", "seed", { timeoutMs: 5000, ...sc })).exitCode).toBe(0);
    spawned[0].runTurn = (async () => ({
      text: "ok",
      bytesCaptured: 1,
      cleanBoundary: true,
      sessionId: "sess-2",
    })) as PtyProcess["runTurn"];

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000 });

    expect(r.status).toBe("sent");
    expect(await store.load()).toBe("sess-2");
  });

  it("an already-aborted signal writes nothing", async () => {
    await seed("global");
    const ac = new AbortController();
    ac.abort();

    const r = await sendToLiveSession("global", "/compact", { timeoutMs: 5000, signal: ac.signal });

    expect(r.status).toBe("failed");
    expect(spawned[0].prompts).toEqual(["seed"]);
    // nothing was written, so there is nothing to kill
    expect(spawned[0].disposed).toBe(false);
    expect(supervisorEntryCount()).toBe(1);
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

  // #561 Codex P1: an entry with no live process YET, or one that STILL has one, is not
  // "gone". Leaving it out sent a shutdown to the one-shot fallback, a second writer on
  // the transcript.
  it("lists an entry whose spawn is still in flight (no process yet)", async () => {
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

    expect(spawned.length).toBe(0);
    expect(liveSessionKeys()).toEqual(["global"]);

    spawnGate.resolve();
    await first;
  });

  it("lists an entry that is being retired (its process may still be there)", async () => {
    await seed("global");
    const disposeGate = deferred<void>();
    spawned[0].dispose = async () => {
      await disposeGate.promise;
    };
    const retiring = retirePtySession("global");
    await Bun.sleep(5);

    expect(liveSessionKeys()).toEqual(["global"]);

    disposeGate.resolve();
    await retiring;
    // retirement done: the entry is gone and so is the key
    expect(liveSessionKeys()).toEqual([]);
  });

  it("still omits an ephemeral entry, spawning or live", async () => {
    const spawnGate = deferred<void>();
    injectSpawnPty(async (o) => {
      await spawnGate.promise;
      const f = nextFake();
      spawned.push(f);
      spawnOpts.push(o);
      return f;
    });
    const gate = deferred<PtyTurnResult>();
    nextFake = () => makeFake({ onPrompt: () => gate.promise });
    const oneShot = runOnPty("fallback:global", "x", {
      timeoutMs: 5000,
      ...scope(),
      ephemeral: true,
    });
    await Bun.sleep(10);
    expect(spawned.length).toBe(0); // still spawning
    expect(liveSessionKeys()).toEqual([]);

    spawnGate.resolve();
    await Bun.sleep(10);
    expect(spawned.length).toBe(1); // live and mid-turn
    expect(liveSessionKeys()).toEqual([]);

    gate.resolve({ text: "x", bytesCaptured: 1, cleanBoundary: true, sessionId: "s" });
    await oneShot;
  });
});

/**
 * The real supervisor wired into `saveMemoryAtShutdown` the way `start.ts` wires it:
 * a global entry that is mid-transition when the shutdown starts must never reach the
 * one-shot fallback while its process is, or may yet be, writing the transcript (#561).
 */
describe("shutdown memory save over a transitional global entry", () => {
  function wiredDeps(fallbackCalls: Array<{ processGone: boolean }>): MemorySaveDeps {
    return {
      liveKeys: liveSessionKeys,
      send: sendToLiveSession,
      memoryPathFor: (k) => (k === "global" ? "/mem/global.md" : null),
      fallbackSave: async () => {
        // every process the supervisor spawned is disposed (none spawned counts as gone)
        fallbackCalls.push({ processGone: spawned.every((p) => p.disposed) });
        return "saved";
      },
      log: () => {},
    };
  }

  it("global spawning: no one-shot while the spawn is in flight; once it lands the save goes live", async () => {
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

    const fallbackCalls: Array<{ processGone: boolean }> = [];
    const saving = saveMemoryAtShutdown(5000, wiredDeps(fallbackCalls));
    await Bun.sleep(30);
    expect(fallbackCalls).toEqual([]);
    expect(spawned.length).toBe(0);

    spawnGate.resolve();
    const out = await saving;
    await first;

    expect(fallbackCalls).toEqual([]);
    expect(out.saved).toEqual(["global"]);
    expect(spawned[0].prompts.length).toBe(2);
    expect(spawned[0].prompts[0]).toBe("first");
    expect(spawned[0].prompts[1]).toContain("/mem/global.md");
  });

  it("global retiring: the save waits for the process to go, then runs the one-shot exactly once", async () => {
    await seed("global");
    const disposeGate = deferred<void>();
    const realDispose = spawned[0].dispose.bind(spawned[0]);
    spawned[0].dispose = async () => {
      await disposeGate.promise;
      await realDispose();
    };
    const retiring = retirePtySession("global");
    await Bun.sleep(5);

    const fallbackCalls: Array<{ processGone: boolean }> = [];
    const saving = saveMemoryAtShutdown(5000, wiredDeps(fallbackCalls));
    await Bun.sleep(30);
    expect(fallbackCalls).toEqual([]); // the old process may still be writing

    disposeGate.resolve();
    await retiring;
    const out = await saving;

    expect(fallbackCalls).toEqual([{ processGone: true }]);
    expect(out.saved).toEqual(["global (one-shot)"]);
    expect(spawned[0].prompts).toEqual(["seed"]); // nothing written into the retiring PTY
  });
});
