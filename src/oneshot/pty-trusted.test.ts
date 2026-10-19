import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import type { PtyProcessOptions } from "../runner/pty-process.js";
import { PtyClosedError, __buildClaudeArgsForTests } from "../runner/pty-process.js";
import { PTY_OUTPUT_FORMAT_CONSTRAINT } from "../runner/pty-output-format.js";
import {
  __resetSupervisorForTests,
  injectMaxConcurrentForTests,
  injectMcpIdentityIssuer,
  injectOneShotTrustForTests,
  injectSpawnPty,
  killAllPtys,
  runOnPty,
  shutdownSupervisor,
  snapshotSupervisor,
} from "../runner/pty-supervisor.js";
import type { OneShotRequest } from "./engine.js";
import { engines } from "./registry.js";
import { buildPrintArgs, withPrintRuntime } from "./print.js";

const security = { level: "moderate" as const, allowedTools: [], disallowedTools: [] };
const base: OneShotRequest = {
  route: "compact",
  prompt: "p",
  isolation: "trusted-session",
  timeoutMs: 1000,
};

function ptyArgs(model: string | undefined, isolation: PtyProcessOptions["isolation"]): string[] {
  return __buildClaudeArgsForTests({
    sessionId: "",
    cwd: "/tmp",
    isolation,
    modelOverride: model,
    security,
    env: {},
  });
}

describe("model alias rule shared by print and pty (Codex P2 on #560)", () => {
  for (const alias of ["glm", "kimi-k2p6", "KIMI-K2P6"]) {
    for (const isolation of ["trusted-session", "untrusted"] as const) {
      it(`neither engine forwards --model ${alias} (${isolation})`, () => {
        const print = buildPrintArgs({
          ...base,
          route: isolation === "untrusted" ? "tuner.judge" : "compact",
          isolation,
          model: alias,
        });
        expect(print).not.toContain("--model");
        expect(ptyArgs(alias, isolation)).not.toContain("--model");
      });
    }
  }
  it("both engines forward a real model name", () => {
    const model = "claude-sonnet-4-20250514";
    const print = buildPrintArgs({ ...base, model });
    expect(print.slice(print.indexOf("--model"), print.indexOf("--model") + 2)).toEqual([
      "--model",
      model,
    ]);
    const pty = ptyArgs(model, "trusted-session");
    expect(pty.slice(pty.indexOf("--model"), pty.indexOf("--model") + 2)).toEqual([
      "--model",
      model,
    ]);
  });
});

// ── Trusted-route PTY engine: production-grade behaviour ─────────────────────

const ok = { text: "ok", sessionId: "sid", bytesCaptured: 2, cleanBoundary: true };
type FakeSpawn = Parameters<typeof injectSpawnPty>[0];
interface Fake {
  opts: PtyProcessOptions[];
  disposed: number;
  turnStarted: Promise<void>;
}

/** A PTY whose turn blocks until disposed (then fails like a killed child). */
function hangingPty(): { spawn: NonNullable<FakeSpawn>; fake: Fake } {
  let started!: () => void;
  const fake: Fake = {
    opts: [],
    disposed: 0,
    turnStarted: new Promise<void>((resolve) => {
      started = resolve;
    }),
  };
  const spawn: NonNullable<FakeSpawn> = async (opts) => {
    fake.opts.push(opts);
    let rejectTurn: (e: Error) => void = () => {};
    return {
      label: "fake",
      pid: 1,
      sessionId: "sid",
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: () => {
        started();
        return new Promise((_, reject) => {
          rejectTurn = reject;
        });
      },
      dispose: async () => {
        fake.disposed++;
        rejectTurn(new PtyClosedError("fake", null, "SIGTERM"));
      },
    } as never;
  };
  return { spawn, fake };
}

function okPty(record: PtyProcessOptions[]): NonNullable<FakeSpawn> {
  return async (opts) => {
    record.push(opts);
    return {
      label: "fake",
      pid: 1,
      sessionId: "sid",
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: async () => ok,
      dispose: async () => {},
    } as never;
  };
}

let dir: string;
let cwd: string;
async function useSettings(settings: unknown): Promise<void> {
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  _setSettingsFileForTests(file);
  await loadSettings();
}
const trusted = (over: Partial<OneShotRequest> = {}): OneShotRequest => ({
  ...base,
  prompt: "summarise",
  timeoutMs: 2000,
  cwd,
  ...over,
});
const pty = () => engines.get("pty")!;

describe("trusted-route PTY engine", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "oneshot-pty-trusted-"));
    cwd = mkdtempSync(join(tmpdir(), "oneshot-pty-cwd-"));
    await useSettings({});
    injectOneShotTrustForTests(async () => ({ ok: true }));
  });
  afterEach(() => {
    __resetSupervisorForTests();
    injectOneShotTrustForTests(null);
    injectSpawnPty(null);
    injectMaxConcurrentForTests(null);
    _setSettingsFileForTests();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("builds spawn options like keyed sessions: settings.pty values and the multiplexer config", async () => {
    await useSettings({
      pty: {
        cols: 111,
        rows: 37,
        turnIdleTimeoutMs: 4321,
        quietWindowMs: 123,
        sentinelMaxWaitMs: 9876,
      },
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const revoked: string[] = [];
    injectMcpIdentityIssuer({
      issue: (ptyId) => ({ ptyId, headers: { Authorization: "Bearer x" } }) as never,
      revoke: (ptyId) => {
        revoked.push(ptyId);
      },
    });
    const seen: PtyProcessOptions[] = [];
    injectSpawnPty(okPty(seen));
    await pty().run(trusted());
    const o = seen[0]!;
    expect([o.cols, o.rows, o.turnIdleTimeoutMs, o.quietWindowMs, o.sentinelMaxWaitMs]).toEqual([
      111, 37, 4321, 123, 9876,
    ]);
    expect(o.mcpConfigPath).toContain("mcp-pty-oneshot:compact:");
    // Retiring the entry releases the identity and deletes the synthesized file.
    expect(revoked).toHaveLength(1);
    expect(existsSync(o.mcpConfigPath!)).toBe(false);
  });

  it("registers the child in the supervisor: shutdown during an in-flight one-shot disposes it", async () => {
    const { spawn, fake } = hangingPty();
    injectSpawnPty(spawn);
    const running = pty().run(trusted({ timeoutMs: 30_000 }));
    await fake.turnStarted;
    expect(snapshotSupervisor().ptys).toHaveLength(1);
    await shutdownSupervisor();
    const result = await running;
    expect(fake.disposed).toBe(1);
    expect(result.exitCode).not.toBe(0);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
  });

  it("registers the child in the supervisor: /kill during an in-flight one-shot disposes it", async () => {
    const { spawn, fake } = hangingPty();
    injectSpawnPty(spawn);
    const running = pty().run(trusted({ timeoutMs: 30_000 }));
    await fake.turnStarted;
    expect(await killAllPtys()).toBe(1);
    const result = await running;
    expect(fake.disposed).toBe(1);
    expect(result.exitCode).not.toBe(0);
  });

  it("is never reused and never evicts a keyed session, even at the concurrency cap", async () => {
    injectMaxConcurrentForTests(1);
    const seen: PtyProcessOptions[] = [];
    injectSpawnPty(okPty(seen));
    await runOnPty("thread:keep", "hello", { timeoutMs: 1000, threadId: "keep", cwd });
    await pty().run(trusted());
    await pty().run(trusted());
    // keyed + two distinct one-shot spawns; the keyed entry survives both.
    expect(seen).toHaveLength(3);
    expect(snapshotSupervisor().ptys.map((p) => p.sessionKey)).toEqual(["thread:keep"]);
  });

  it("appends the plain-prose output constraint to the system prompt", async () => {
    const seen: PtyProcessOptions[] = [];
    injectSpawnPty(okPty(seen));
    await pty().run(trusted({ system: "Be brief." }));
    expect(seen[0]!.appendSystemPrompt).toContain("Be brief.");
    expect(seen[0]!.appendSystemPrompt).toContain(PTY_OUTPUT_FORMAT_CONSTRAINT);
    await pty().run(trusted());
    expect(seen[1]!.appendSystemPrompt).toBe(PTY_OUTPUT_FORMAT_CONSTRAINT);
  });

  it("survives a throwing or failing trust self-heal, and says so", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const seen: PtyProcessOptions[] = [];
      injectSpawnPty(okPty(seen));
      injectOneShotTrustForTests(async () => {
        throw new Error("disk full");
      });
      expect((await pty().run(trusted())).exitCode).toBe(0);
      injectOneShotTrustForTests(async () => ({ ok: false, reason: "no ~/.claude.json" }));
      expect((await pty().run(trusted())).exitCode).toBe(0);
      expect(seen).toHaveLength(2);
      expect(warn.mock.calls.flat().join(" ")).toContain("trust self-heal failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("denies tools outside allowedTools instead of waiting at a permission prompt", async () => {
    const seen: PtyProcessOptions[] = [];
    injectSpawnPty(okPty(seen));
    await pty().run(trusted({ allowedTools: ["Read", "Grep"] }));
    expect(seen[0]!.securityArgs).toEqual([
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read,Grep",
    ]);
    const argv = __buildClaudeArgsForTests(seen[0]!);
    expect(argv).toContain("dontAsk");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });
});

describe("exit contract is the same for every engine", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "oneshot-contract-"));
    cwd = mkdtempSync(join(tmpdir(), "oneshot-contract-cwd-"));
    await useSettings({});
    injectOneShotTrustForTests(async () => ({ ok: true }));
  });
  afterEach(() => {
    __resetSupervisorForTests();
    injectOneShotTrustForTests(null);
    injectSpawnPty(null);
    _setSettingsFileForTests();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Runs one request on one engine with the child behaving as `scenario`. */
  async function run(id: string, scenario: "timeout" | "failure") {
    const req = trusted({ timeoutMs: 40 });
    if (id === "pty") {
      const hanging = hangingPty();
      injectSpawnPty(
        scenario === "timeout"
          ? hanging.spawn
          : async () =>
              ({
                label: "fake",
                pid: 1,
                sessionId: "s",
                cwd,
                isAlive: () => true,
                lastTurnEndedAt: () => 0,
                runTurn: async () => {
                  throw new PtyClosedError("fake", 1, null);
                },
                dispose: async () => {},
              }) as never,
      );
      return pty().run(req);
    }
    const child = (): EventEmitter =>
      Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end: () => {} }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
    const spawnFn = (() => {
      const c = child();
      if (scenario === "failure") queueMicrotask(() => c.emit("close", 2));
      else Object.assign(c, { kill: () => queueMicrotask(() => c.emit("close", null)) });
      return c;
    }) as unknown as typeof spawn;
    return withPrintRuntime({ spawn: spawnFn }, () => engines.get(id)!.run(req));
  }

  for (const id of ["print", "pty"]) {
    it(`${id}: a timeout resolves with exitCode 124`, async () => {
      expect((await run(id, "timeout")).exitCode).toBe(124);
    });
    it(`${id}: a failed turn resolves with a non-zero exitCode`, async () => {
      const result = await run(id, "failure");
      expect(result.exitCode).not.toBe(0);
      expect(result.exitCode).not.toBe(124);
    });
  }
  it("covers every registered engine", () => {
    expect([...engines.keys()].sort()).toEqual(["print", "pty"]);
  });
});
