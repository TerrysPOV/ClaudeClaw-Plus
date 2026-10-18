/**
 * #546: every agent-turn path honours `settings.pty.enabled`.
 *
 * The primary turn always did; the rate-limit fallback, the dashboard chat
 * (`streamUserMessage`), Telegram forks (`runFork`) and bus agent jobs
 * (`runAgentJobHeadless`) always spawned `claude -p`. Each test runs one path
 * with the flag on and off and asserts which engine it reached:
 *
 *   - PTY route: the supervisor's spawn seam (`injectSpawnPty`) receives the
 *     spawn, the legacy spawn seam sees nothing.
 *   - legacy route: the legacy spawn seam (`_setClaudeSpawnForTests`) sees a
 *     `claude -p` argv, no PTY is spawned.
 *
 * Settings are stubbed through `getSettings`; the session files the paths read
 * and write in `<cwd>/.claude/claudeclaw/` are restored after the suite,
 * deleted ones included.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as configMod from "../config";
import { getSettings, initConfig, loadSettings } from "../config";
import * as runnerMod from "../runner";
import {
  __resetSupervisorForTests,
  injectEnsureAgentDir,
  injectIsSessionResumable,
  injectMcpIdentityIssuer,
  injectSleep,
  injectSpawnPty,
  killAllPtys,
  resetSleep,
  snapshotSupervisor,
} from "../runner/pty-supervisor";
import {
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/pty-process";
import {
  createFallbackSession,
  getFallbackSession,
  peekSession,
  resetFallbackSession,
  resetSession,
} from "../sessions";
import { createThreadSession, removeThreadSession } from "../sessionManager";

const STATE_DIR = join(process.cwd(), ".claude", "claudeclaw");
const AGENT = `t546-agent-${process.pid}`;
const AGENT_DIR = join(process.cwd(), "agents", AGENT);

// ── State snapshot: the paths under test read and write the global session,
// the fallback/thread session files and usage records. Put back what we found.
let stateBefore: Map<string, string> | null = null;
async function snapshotDir(
  dir: string,
  into = new Map<string, string>(),
): Promise<Map<string, string>> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return into;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      into.set(p, await readFile(p, "utf8"));
    } catch {
      await snapshotDir(p, into); // a directory
    }
  }
  return into;
}
async function restoreDir(dir: string, snap: Map<string, string>): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    const before = snap.get(p);
    if (before !== undefined) {
      await writeFile(p, before);
      continue;
    }
    const isDirWithKnownFiles = [...snap.keys()].some((k) => k.startsWith(`${p}/`));
    if (isDirWithKnownFiles) await restoreDir(p, snap);
    else await rm(p, { recursive: true, force: true });
  }
}
/** Put back the snapshotted files a test deleted (e.g. the fallback session file). */
async function restoreDeleted(snap: Map<string, string>): Promise<void> {
  for (const [p, before] of snap) {
    if (await Bun.file(p).exists()) continue;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, before);
  }
}

// ── Engines under observation.
let ptySpawns: PtyProcessOptions[] = [];
let ptys: FakePty[] = [];
let legacyArgv: string[][] = [];
type TurnScript = (
  prompt: string,
  opts: { onChunk?: (t: string) => void },
  pty: FakePty,
) => Promise<string>;
let turnScript: TurnScript = async () => "pty-ok";
let disposeDelayMs = 0;

interface FakePty extends PtyProcess {
  disposed: boolean;
}

function makeFakePty(opts: PtyProcessOptions): FakePty {
  const sessionId = opts.sessionId || opts.newSessionId || "pty-fresh";
  let ended = 0;
  const pty: FakePty = {
    label: `fake:${ptys.length}`,
    pid: 40_000 + ptys.length,
    sessionId,
    cwd: opts.cwd,
    disposed: false,
    isAlive: () => !pty.disposed,
    lastTurnEndedAt: () => ended,
    exitInfo: () => null,
    runTurn: async (prompt, turnOpts) => {
      const text = await turnScript(prompt, turnOpts, pty);
      ended = Date.now();
      return { text, bytesCaptured: text.length, cleanBoundary: true, sessionId };
    },
    dispose: async () => {
      pty.disposed = true;
      if (disposeDelayMs > 0) await new Promise((r) => setTimeout(r, disposeDelayMs));
    },
  };
  return pty;
}

const LEGACY_RESULT = JSON.stringify({
  type: "result",
  result: "legacy-ok",
  session_id: "legacy-session",
});

function stubSettings(ptyEnabled: boolean, extra: Record<string, unknown> = {}): void {
  const real = getSettings();
  spyOn(configMod, "getSettings").mockReturnValue({
    ...real,
    model: "primary-model",
    api: "",
    fallback: { model: "fallback-model", api: "" },
    agentic: { ...real.agentic, enabled: false },
    session: { ...real.session, autoRotate: false },
    mcp: { ...real.mcp, shared: [] },
    pty: { ...real.pty, enabled: ptyEnabled, maxRetries: 0, backoffMs: [0] },
    ...extra,
  } as ReturnType<typeof getSettings>);
}

beforeAll(async () => {
  await initConfig();
  await loadSettings();
  stateBefore = await snapshotDir(STATE_DIR);
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(join(AGENT_DIR, "IDENTITY.md"), "test agent for #546\n");
});

afterAll(async () => {
  if (stateBefore) {
    await restoreDir(STATE_DIR, stateBefore);
    await restoreDeleted(stateBefore);
  }
  await rm(AGENT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  ptySpawns = [];
  ptys = [];
  legacyArgv = [];
  turnScript = async () => "pty-ok";
  disposeDelayMs = 0;
  __resetSupervisorForTests();
  injectSleep(async () => {});
  injectIsSessionResumable(async () => true);
  injectEnsureAgentDir(async () => AGENT_DIR);
  injectSpawnPty(async (opts) => {
    ptySpawns.push(opts);
    const pty = makeFakePty(opts);
    ptys.push(pty);
    return pty;
  });
  runnerMod._setClaudeSpawnForTests((args) => {
    legacyArgv.push(args);
    return Bun.spawn(["printf", "%s\\n", LEGACY_RESULT], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  });
});

afterEach(() => {
  runnerMod._setClaudeSpawnForTests(null);
  runnerMod._setPrimaryExecForTests(null);
  (configMod.getSettings as unknown as { mockRestore?: () => void }).mockRestore?.();
  __resetSupervisorForTests();
  resetSleep();
});

describe("#546 resolveAgentTurnRoute", () => {
  it("follows pty.enabled; bootstrap stays legacy", () => {
    stubSettings(true);
    expect(runnerMod.resolveAgentTurnRoute("chat")).toBe("pty");
    expect(runnerMod.resolveAgentTurnRoute()).toBe("pty");
    expect(runnerMod.resolveAgentTurnRoute("bootstrap")).toBe("legacy");
    (configMod.getSettings as unknown as { mockRestore: () => void }).mockRestore();
    stubSettings(false);
    expect(runnerMod.resolveAgentTurnRoute("chat")).toBe("legacy");
  });
});

describe("#546 runFork", () => {
  it("pty.enabled: true → an ephemeral PTY on the fork model, retired after", async () => {
    stubSettings(true);
    const r = await runnerMod.runFork("how is the main agent doing?");
    expect(legacyArgv).toHaveLength(0);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].modelOverride).toBe("claude-haiku-4-5-20251001");
    expect(ptySpawns[0].appendSystemPrompt).toContain("OUTPUT FORMAT CONSTRAINT");
    expect(ptySpawns[0].sessionId).toBe(""); // never resumes anything
    expect(r).toEqual({ stdout: "pty-ok", stderr: "", exitCode: 0 });
    expect(ptys[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
  });

  it("pty.enabled: false → claude -p, no PTY", async () => {
    stubSettings(false);
    const r = await runnerMod.runFork("how is the main agent doing?");
    expect(ptySpawns).toHaveLength(0);
    expect(legacyArgv).toHaveLength(1);
    expect(legacyArgv[0]).toContain("-p");
    expect(r.stdout).toBe("legacy-ok");
  });

  it("/kill does not reach a fork in flight", async () => {
    stubSettings(true);
    let release: () => void = () => {};
    const started = new Promise<void>((r) => {
      turnScript = async () => {
        r();
        await new Promise<void>((done) => {
          release = done;
        });
        return "fork-done";
      };
    });
    const fork = runnerMod.runFork("q");
    await started;
    expect(runnerMod.killActive()).toBe(false);
    expect(await killAllPtys()).toBe(0);
    expect(ptys[0].disposed).toBe(false);
    release();
    expect((await fork).stdout).toBe("fork-done");
  });
});

describe("#546 dashboard chat (streamUserMessage)", () => {
  it("pty.enabled: true → the global PTY, chunks reach onChunk in order", async () => {
    stubSettings(true);
    turnScript = async (_p, opts) => {
      for (const c of ["one ", "two ", "three"]) opts.onChunk?.(c);
      return "one two three";
    };
    const chunks: string[] = [];
    let unblocked = 0;
    await runnerMod.streamUserMessage(
      "chat",
      "hello",
      (t) => chunks.push(t),
      () => unblocked++,
    );
    expect(legacyArgv).toHaveLength(0);
    expect(ptySpawns).toHaveLength(1);
    expect(snapshotSupervisor().ptys.map((p) => p.sessionKey)).toEqual(["global"]);
    expect(chunks).toEqual(["one ", "two ", "three"]);
    expect(unblocked).toBe(1);
    // The chat may be the turn that spawns the shared global PTY: it must carry
    // the full global prompt, not a chat-only one.
    expect(ptySpawns[0].appendSystemPrompt).toContain("OUTPUT FORMAT CONSTRAINT");
  });

  it("pty.enabled: true, primary streams a rate-limit notice → the fallback's answer reaches onChunk", async () => {
    stubSettings(true);
    const limit = "You've hit your limit · resets 5pm (UTC)";
    turnScript = async (_p, opts, pty) => {
      if (ptySpawns[ptys.indexOf(pty)].modelOverride === "fallback-model") return "fallback answer";
      opts.onChunk?.(limit);
      return limit;
    };
    const chunks: string[] = [];
    try {
      await runnerMod.streamUserMessage(
        "chat",
        "hello",
        (t) => chunks.push(t),
        () => {},
      );
    } finally {
      await resetFallbackSession();
    }
    expect(
      snapshotSupervisor()
        .ptys.map((p) => p.sessionKey)
        .sort(),
    ).toEqual(["fallback:global", "global"]);
    expect(chunks).toEqual([limit, "fallback answer"]);
  });

  it("pty.enabled: true, no fallback → the streamed answer is not delivered twice", async () => {
    stubSettings(true);
    turnScript = async (_p, opts) => {
      opts.onChunk?.("answer");
      return "answer";
    };
    const chunks: string[] = [];
    await runnerMod.streamUserMessage(
      "chat",
      "hello",
      (t) => chunks.push(t),
      () => {},
    );
    expect(chunks).toEqual(["answer"]);
  });

  it("pty.enabled: false → claude -p", async () => {
    stubSettings(false);
    const chunks: string[] = [];
    await runnerMod.streamUserMessage(
      "chat",
      "hello",
      (t) => chunks.push(t),
      () => {},
    );
    expect(ptySpawns).toHaveLength(0);
    expect(legacyArgv).toHaveLength(1);
    expect(legacyArgv[0]).toContain("-p");
    expect(chunks).toEqual(["legacy-ok"]);
  });
});

describe("#546 agent jobs (runAgentJobHeadless)", () => {
  it("pty.enabled: true → one PTY for the job in the agent dir, retired at the end", async () => {
    stubSettings(true);
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "do the job",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      mcpConfigPath: "/tmp/t546-job-mcp.json",
    });
    expect(legacyArgv).toHaveLength(0);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].cwd).toBe(AGENT_DIR);
    expect(ptySpawns[0].appendSystemPrompt).toContain("test agent for #546");
    expect(ptySpawns[0].appendSystemPrompt).toContain("OUTPUT FORMAT CONSTRAINT");
    expect(ptySpawns[0].sessionId).toBe("");
    // The bus mints and releases the job's MCP config; the PTY uses it as is.
    expect(ptySpawns[0].mcpConfigPath).toBe("/tmp/t546-job-mcp.json");
    expect(r).toEqual({ exitCode: 0, resultText: "pty-ok" });
    expect(ptys[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
  });

  it("a job whose turn succeeded stays a success when the timer fires during teardown", async () => {
    stubSettings(true);
    disposeDelayMs = 150; // teardown outlasts the job timeout below
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "quick job",
      timeoutMs: 50,
      signal: new AbortController().signal,
    });
    expect(r).toEqual({ exitCode: 0, resultText: "pty-ok" });
  });

  it("a job the bus gave no MCP config runs without one, even with the multiplexer active", async () => {
    const real = getSettings();
    stubSettings(true, {
      web: { ...real.web, enabled: true },
      mcp: { ...real.mcp, shared: ["some-server"] },
    });
    const issued: string[] = [];
    injectMcpIdentityIssuer({
      issue: (ptyId) => {
        issued.push(ptyId);
        return { ptyId, issuedAt: 0 } as never;
      },
    });
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "do the job",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(r.exitCode).toBe(0);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].mcpConfigPath).toBeUndefined();
    expect(issued).toEqual([]);
  });

  it("abort mid-job kills the PTY and leaves no entry behind", async () => {
    stubSettings(true);
    const ac = new AbortController();
    turnScript = async (_p, _o, pty) => {
      // A turn that only ends when its PTY is disposed — like a real one.
      queueMicrotask(() => ac.abort());
      while (!pty.disposed) await new Promise((r) => setTimeout(r, 5));
      throw new PtyClosedError(pty.label, null, null);
    };
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "long job",
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    expect(r.exitCode).toBe(124);
    expect(r.error).toBe("aborted");
    expect(ptySpawns).toHaveLength(1); // no respawn after the abort
    expect(ptys[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
  });

  it("the job timeout disposes the PTY and reports timedOut", async () => {
    stubSettings(true);
    turnScript = async (_p, _o, pty) => {
      while (!pty.disposed) await new Promise((r) => setTimeout(r, 5));
      throw new PtyClosedError(pty.label, null, null);
    };
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "slow job",
      timeoutMs: 50,
      signal: new AbortController().signal,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(ptys[0].disposed).toBe(true);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
  });

  it("pty.enabled: false → claude -p", async () => {
    stubSettings(false);
    const r = await runnerMod.runAgentJobHeadless({
      agent: AGENT,
      prompt: "do the job",
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(ptySpawns).toHaveLength(0);
    expect(legacyArgv).toHaveLength(1);
    expect(legacyArgv[0]).toContain("-p");
    expect(r.exitCode).toBe(0);
  });
});

describe("#546 rate-limit fallback", () => {
  const thread = `t546-thread-${process.pid}`;

  beforeEach(async () => {
    await createThreadSession(thread, "primary-session");
    await createFallbackSession("fallback-session", undefined, thread);
    runnerMod._setPrimaryExecForTests(async () => ({
      rawStdout: "You've hit your limit · resets 5pm (UTC)",
      stderr: "",
      exitCode: 1,
    }));
  });

  afterEach(async () => {
    await removeThreadSession(thread);
    await resetFallbackSession(undefined, thread);
  });

  it("pty.enabled: true → fallback model on its own PTY, resuming the fallback session only", async () => {
    stubSettings(true);
    const r = await runnerMod.run("t546", "hello", thread);
    expect(legacyArgv).toHaveLength(0);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].modelOverride).toBe("fallback-model");
    expect(ptySpawns[0].sessionId).toBe("fallback-session");
    expect(ptySpawns[0].sessionId).not.toBe("primary-session");
    expect(snapshotSupervisor().ptys.map((p) => p.sessionKey)).toEqual([
      `fallback:thread:${thread}`,
    ]);
    expect(r.stdout).toBe("pty-ok");
  });

  it("pty.enabled: true, corrupted fallback session → fresh PTY, new id saved as the fallback session", async () => {
    stubSettings(true);
    turnScript = async (_p, _o, pty) => {
      if (pty.sessionId === "fallback-session") {
        throw new Error("API Error: Invalid signature in thinking block");
      }
      return "recovered";
    };
    // A turn that throws a non-retryable error surfaces as exit 1 + stderr,
    // which is what the corrupted-session branch matches on.
    const r = await runnerMod.run("t546", "hello", thread);
    expect(legacyArgv).toHaveLength(0);
    expect(ptySpawns).toHaveLength(2);
    expect(ptySpawns[0].sessionId).toBe("fallback-session");
    expect(ptySpawns[1].sessionId).toBe(""); // fresh: the retired PTY is not reused
    expect(ptys[0].disposed).toBe(true);
    const saved = await getFallbackSession(undefined, thread);
    expect(saved?.sessionId).toBe(ptySpawns[1].newSessionId);
    expect(r.stdout).toBe("recovered");
  });

  it("a named agent's fallback PTY is reapable (adhoc), not kept alive like the agent", async () => {
    stubSettings(true);
    await createFallbackSession("agent-fallback-session", AGENT);
    try {
      await runnerMod.run("t546", "hello", undefined, undefined, undefined, AGENT);
      const ptyState = snapshotSupervisor().ptys;
      expect(ptyState.map((p) => [p.sessionKey, p.kind])).toEqual([
        [`fallback:agent:${AGENT}`, "adhoc"],
      ]);
      expect(ptySpawns[0].sessionId).toBe("agent-fallback-session");
    } finally {
      await resetFallbackSession(AGENT);
    }
  });

  it("pty.enabled: false → claude -p with the fallback model and session", async () => {
    stubSettings(false);
    await runnerMod.run("t546", "hello", thread);
    expect(ptySpawns).toHaveLength(0);
    expect(legacyArgv).toHaveLength(1);
    const argv = legacyArgv[0];
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback-model");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("fallback-session");
  });
});

describe("#559 a fresh chat turn with the clock prefix is submitted", () => {
  // A real PTY running a stand-in for claude's input box (fixtures/paste-burst-tui.ts):
  // an unmarked burst of 64+ bytes is a paste whose CR stays text, as on CLI 2.1.296.
  it("runUserMessage('chat') on a new session submits the prefixed prompt", async () => {
    // A prompt left in the input box ends in the turn timeout: 3 s here, not 5 min.
    stubSettings(true, { timeouts: { ...getSettings().timeouts, default: 0.05 } });
    await resetSession();
    expect(await peekSession()).toBeNull();
    const tui = join(import.meta.dir, "fixtures", "paste-burst-tui.ts");
    injectSpawnPty(async (opts) => {
      ptySpawns.push(opts);
      return spawnPty({
        ...opts,
        _commandOverride: process.execPath,
        _argsOverride: [tui],
        quietWindowMs: 300,
        sentinelMaxWaitMs: 2_000,
      });
    });
    const prompt = "Reply with exactly the word FRESH559 and nothing else.";
    const r = await runnerMod.runUserMessage("chat", prompt);
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].sessionId).toBe(""); // fresh: nothing to resume
    expect(r.exitCode).toBe(0);
    const submitted = /SUBMITTED<([^>]*)>/.exec(r.stdout)?.[1];
    expect(submitted).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d+(?::\d{2})?\] /);
    expect(submitted?.endsWith(prompt)).toBe(true);
  }, 20_000);

  it("a prompt carrying a paste end marker cannot close the paste early", async () => {
    const tui = join(import.meta.dir, "fixtures", "paste-burst-tui.ts");
    const pty = await spawnPty({
      sessionId: "",
      cwd: process.cwd(),
      security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
      env: { ...process.env } as Record<string, string>,
      agentName: "t559",
      _commandOverride: process.execPath,
      _argsOverride: [tui],
      quietWindowMs: 300,
      sentinelMaxWaitMs: 2_000,
    });
    try {
      const r = await pty.runTurn(
        "before \x1b[201~\r after, and enough text after the marker for a burst of 64+ bytes",
        {
          timeoutMs: 5_000,
        },
      );
      const submits = r.text.match(/SUBMITTED<[^>]*>/g) ?? [];
      expect(submits).toEqual([
        "SUBMITTED<before [201~  after, and enough text after the marker for a burst of 64+ bytes>",
      ]);
    } finally {
      await pty.dispose();
    }
  }, 20_000);
});
