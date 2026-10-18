/**
 * compact / memory.save.precompact / rotation.summary (#549): try the live PTY
 * session first, fall back to `runOneShot({ isolation: "trusted-session" })` only
 * when there is no live, idle session for the key.
 *
 * The supervisor is the real one with a fake `spawnPty`; `runOneShot` is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig, loadSettings, reloadSettings } from "../config";
import type { OneShotRequest, OneShotResult } from "../oneshot/engine";
import { runCompact } from "../runner";
import {
  actOnSession,
  injectOneShotForTests,
  looksLikeCommandError,
} from "../runner/live-session-actions";
import type { PtyProcess, PtyTurnResult } from "../runner/pty-process";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectSleep,
  injectSpawnPty,
  runOnPty,
  shutdownSupervisor,
} from "../runner/pty-supervisor";
import { generateSummary, type RotateDeps, rotateSession } from "../rotation";
import type { SessionConfig } from "../config";

interface FakePty extends PtyProcess {
  prompts: string[];
}

function makeFake(reply: (p: string) => Promise<PtyTurnResult> | PtyTurnResult): FakePty {
  const prompts: string[] = [];
  return {
    label: "fake",
    pid: 7,
    sessionId: "live-sess",
    cwd: "/tmp/fake-cwd",
    prompts,
    isAlive: () => true,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string) {
      prompts.push(prompt);
      return reply(prompt);
    },
    async dispose() {},
  } as unknown as FakePty;
}

const ok = (text: string): PtyTurnResult => ({
  text,
  bytesCaptured: text.length,
  cleanBoundary: true,
  sessionId: "live-sess",
});

const scope = () => {
  let id: string | undefined;
  return {
    sessionStore: {
      load: async () => id,
      save: async (s: string) => {
        id = s;
      },
    },
    cwd: "/tmp/fake-cwd",
    mcpConfig: { path: undefined },
  };
};

let fakes: FakePty[];
let reply: (p: string) => Promise<PtyTurnResult> | PtyTurnResult;
let oneShotCalls: OneShotRequest[];
let oneShotResult: () => Promise<OneShotResult>;

const done = (text = "", exitCode = 0): OneShotResult => ({
  text,
  engine: "print",
  model: "m",
  exitCode,
});

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectIsSessionResumable(async () => true);
  injectSleep(async () => {});
  injectMaxRetriesForTests(0);
  fakes = [];
  reply = (p) => ok(`echo:${p}`);
  injectSpawnPty(async () => {
    const f = makeFake((p) => reply(p));
    fakes.push(f);
    return f;
  });
  oneShotCalls = [];
  oneShotResult = async () => done("one-shot text");
  injectOneShotForTests(async (req) => {
    oneShotCalls.push(req);
    return oneShotResult();
  });
});

afterEach(async () => {
  injectOneShotForTests(null);
  await shutdownSupervisor();
  __resetSupervisorForTests();
});

async function seedLive(key: string): Promise<void> {
  expect((await runOnPty(key, "seed", { timeoutMs: 5000, ...scope() })).exitCode).toBe(0);
}

describe("runCompact", () => {
  it("with a live entry: writes /compact into the PTY and spawns no claude of its own", async () => {
    await seedLive("global");

    const okCompact = await runCompact({
      sessionId: "sid-1",
      sessionKey: "global",
      model: "sonnet",
      timeoutMs: 5000,
    });

    expect(okCompact).toBe(true);
    expect(fakes.length).toBe(1); // no second PTY
    expect(fakes[0].prompts).toEqual(["seed", "/compact"]);
    expect(oneShotCalls).toEqual([]); // and no `claude -p`
  });

  it("with no entry: calls runOneShot as a trusted-session resume of the session id", async () => {
    const okCompact = await runCompact({
      sessionId: "sid-2",
      sessionKey: "agent:suzy",
      model: "sonnet",
      timeoutMs: 7000,
      cwd: "/work/agents/suzy",
    });

    expect(okCompact).toBe(true);
    expect(fakes.length).toBe(0);
    expect(oneShotCalls).toEqual([
      {
        route: "compact",
        prompt: "/compact",
        isolation: "trusted-session",
        resumeSessionId: "sid-2",
        cwd: "/work/agents/suzy",
        model: "sonnet",
        allowedTools: [],
        timeoutMs: 7000,
      },
    ]);
  });

  it("a one-shot that exits non-zero, or throws, is a failed compact", async () => {
    oneShotResult = async () => done("", 1);
    expect(await runCompact({ sessionId: "s", model: "m", timeoutMs: 1000 })).toBe(false);

    oneShotResult = async () => {
      throw new Error("spawn failed");
    };
    expect(await runCompact({ sessionId: "s", model: "m", timeoutMs: 1000 })).toBe(false);
  });

  it("without a session key, goes straight to the one-shot", async () => {
    await seedLive("global");

    await runCompact({ sessionId: "sid-3", model: "m", timeoutMs: 1000 });

    expect(fakes[0].prompts).toEqual(["seed"]);
    expect(oneShotCalls.length).toBe(1);
  });
});

describe("actOnSession", () => {
  it("busy session: waits for the user's turn, runs the action in the live session, spawns NO one-shot", async () => {
    await seedLive("global");
    let release!: (r: PtyTurnResult) => void;
    reply = (p) =>
      p === "long"
        ? new Promise<PtyTurnResult>((r) => {
            release = r;
          })
        : ok(`echo:${p}`);
    const running = runOnPty("global", "long", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);

    const acting = actOnSession({
      route: "compact",
      prompt: "/compact",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 5000,
    });
    await Bun.sleep(30);
    // nothing written on top of the turn, and no second process on the transcript
    expect(fakes[0].prompts).toEqual(["seed", "long"]);
    expect(oneShotCalls).toEqual([]);

    release(ok("done"));
    await running;
    const r = await acting;

    expect(r.ok).toBe(true);
    expect(r.via).toBe("live");
    expect(fakes[0].prompts).toEqual(["seed", "long", "/compact"]); // after the user turn ended
    expect(oneShotCalls).toEqual([]);
  });

  it("busy past the timeout: ok:false with a clear detail and ZERO one-shot calls", async () => {
    await seedLive("global");
    let release!: (r: PtyTurnResult) => void;
    reply = () =>
      new Promise<PtyTurnResult>((r) => {
        release = r;
      });
    const running = runOnPty("global", "long", { timeoutMs: 5000, ...scope() });
    await Bun.sleep(5);

    const r = await actOnSession({
      route: "compact",
      prompt: "/compact",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 40,
    });

    expect(r.ok).toBe(false);
    expect(r.via).toBe("live");
    expect(r.detail).toContain("waited");
    expect(oneShotCalls).toEqual([]);
    expect(fakes[0].prompts).toEqual(["seed", "long"]);
    release(ok("done"));
    await running;
  });

  it("no process at all (entry gone): resumes one-shot", async () => {
    const r = await actOnSession({
      route: "compact",
      prompt: "/compact",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 1000,
    });

    expect(r.via).toBe("oneshot");
    expect(oneShotCalls.length).toBe(1);
  });

  it("does NOT fall back after a live attempt failed: a second process would race the session", async () => {
    await seedLive("global");
    reply = () => {
      throw new Error("tui exploded");
    };

    const r = await actOnSession({
      route: "compact",
      prompt: "/compact",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 1000,
    });

    expect(r.ok).toBe(false);
    expect(r.via).toBe("live");
    expect(oneShotCalls).toEqual([]);
  });

  it("memory.save.precompact: a wedged (timed-out) session skips the live path, and its process is gone BEFORE the one-shot", async () => {
    await seedLive("global");
    let disposedAtOneShot: boolean | null = null;
    injectOneShotForTests(async (req) => {
      disposedAtOneShot = (fakes[0] as unknown as { disposed: boolean }).disposed;
      oneShotCalls.push(req);
      return done("ok");
    });
    (fakes[0] as unknown as { disposed: boolean }).disposed = false;
    const realDispose = fakes[0].dispose.bind(fakes[0]);
    fakes[0].dispose = async () => {
      (fakes[0] as unknown as { disposed: boolean }).disposed = true;
      await realDispose();
    };

    const r = await actOnSession({
      route: "memory.save.precompact",
      prompt: "save it",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 1000,
      skipLive: true,
      allowedTools: ["Write"],
    });

    expect(r.via).toBe("oneshot");
    expect(fakes[0].prompts).toEqual(["seed"]);
    expect(disposedAtOneShot).toBe(true);
    expect(oneShotCalls[0]).toMatchObject({
      route: "memory.save.precompact",
      allowedTools: ["Write"],
      isolation: "trusted-session",
      resumeSessionId: "sid",
    });
  });

  it("memory.save.precompact: a healthy live session takes the save", async () => {
    await seedLive("global");

    const r = await actOnSession({
      route: "memory.save.precompact",
      prompt: "save it",
      sessionKey: "global",
      sessionId: "sid",
      timeoutMs: 1000,
      allowedTools: ["Write"],
    });

    expect(r.via).toBe("live");
    expect(r.ok).toBe(true);
    expect(fakes[0].prompts).toEqual(["seed", "save it"]);
    expect(oneShotCalls).toEqual([]);
  });
});

describe("looksLikeCommandError", () => {
  it("catches the TUI's own error line for a slash command, and not ordinary output", () => {
    expect(looksLikeCommandError("Error: Not enough messages to compact.")).toBe(true);
    expect(looksLikeCommandError("● Compacted (ctrl+o to see full summary)")).toBe(false);
    expect(looksLikeCommandError("")).toBe(false);
  });

  it("a live /compact that prints the error is a failed compact, not a success", async () => {
    await seedLive("global");
    reply = () => ok("Error: Not enough messages to compact.");

    const r = await runCompact({
      sessionId: "s",
      sessionKey: "global",
      model: "m",
      timeoutMs: 1000,
    });

    expect(r).toBe(false);
    expect(oneShotCalls).toEqual([]);
  });
});

describe("generateSummary (rotation.summary)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rot-summary-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the one-shot fallback grants NO tools (allowedTools: []) and resumes the old session", async () => {
    oneShotResult = async () => done("  the summary  ");

    const text = await generateSummary("old-sid", dir);

    expect(text).toBe("the summary");
    expect(oneShotCalls.length).toBe(1);
    expect(oneShotCalls[0]).toMatchObject({
      route: "rotation.summary",
      isolation: "trusted-session",
      resumeSessionId: "old-sid",
      allowedTools: [],
    });
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    expect((await readFile(join(dir, files[0]), "utf-8")).trim()).toBe("the summary");
  });

  it("with a live session, asks it for the summary and runs no one-shot", async () => {
    await seedLive("global");
    reply = () => ok("live summary");

    const text = await generateSummary("sid", dir, { sessionKey: "global" });

    expect(text).toBe("live summary");
    expect(oneShotCalls).toEqual([]);
    expect(fakes[0].prompts.length).toBe(2);
  });

  it("returns null and writes nothing when the call fails or is empty", async () => {
    oneShotResult = async () => done("", 1);
    expect(await generateSummary("sid", dir)).toBeNull();
    oneShotResult = async () => done("   ", 0);
    expect(await generateSummary("sid", dir)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("rotateSession", () => {
  const session = {
    sessionId: "old-sid",
    createdAt: new Date().toISOString(),
    messageCount: 10,
  } as unknown as Awaited<ReturnType<RotateDeps["peek"]>>;

  function rotateDeps(events: string[], over: Partial<RotateDeps> = {}): RotateDeps {
    return {
      peek: async () => session,
      summarize: async (_id, _path, opts) => {
        events.push(`summarize:${opts?.sessionKey}`);
        return "sum";
      },
      backup: async () => {
        events.push("backup");
        return "bak";
      },
      reset: async () => {
        events.push("reset");
      },
      retireLive: async (key) => {
        events.push(`retire:${key}`);
      },
      ...over,
    };
  }
  const cfg = { summaryPath: "/tmp/x" } as unknown as SessionConfig;

  it("summarises through the live session, resets, then retires the live global entry", async () => {
    const events: string[] = [];

    const out = await rotateSession(cfg, rotateDeps(events));

    expect(out).toBe("sum");
    expect(events).toEqual(["summarize:global", "backup", "reset", "retire:global"]);
  });

  it("a failing summary or retire never stops the rotation", async () => {
    const events: string[] = [];

    const out = await rotateSession(
      cfg,
      rotateDeps(events, {
        summarize: async () => {
          throw new Error("no summary");
        },
        retireLive: async () => {
          throw new Error("no retire");
        },
      }),
    );

    expect(out).toBeNull();
    expect(events).toEqual(["backup", "reset"]);
  });

  it("with no session, touches nothing", async () => {
    const events: string[] = [];
    const out = await rotateSession(cfg, rotateDeps(events, { peek: async () => null }));
    expect(out).toBeNull();
    expect(events).toEqual([]);
  });
});
