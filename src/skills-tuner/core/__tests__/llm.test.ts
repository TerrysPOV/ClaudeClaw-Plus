import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn, SpawnOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { ClaudeCliBackend } from "../llm.js";
import { DEFAULT_LLM_TIMEOUT_MS, TunerConfigSchema } from "../config.js";
import { cleanSpawnEnv } from "../../../runner/spawn-env.js";

// Every flag the backend may pass. All exist in `claude --help` (2.1.x); an
// unknown flag makes the CLI exit 1 before any model call.
const KNOWN_FLAGS = new Set([
  "--print",
  "--output-format",
  "--model",
  "--tools",
  "--strict-mcp-config",
  "--setting-sources",
  "--no-session-persistence",
  "--disable-slash-commands",
]);

interface Captured {
  command: string;
  args: string[];
  options: SpawnOptions;
  /** Whether the cwd existed (and was empty) while the child ran. */
  cwdLiveAndEmpty: boolean;
  /** What was written to the child's stdin. */
  stdin: string;
}

function fakeSpawn(
  captured: Captured[],
  stdout = "ok",
  code = 0,
  stderr = "",
): typeof spawn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    const cwd = typeof options?.cwd === "string" ? options.cwd : "";
    const record: Captured = {
      command,
      args,
      options,
      cwdLiveAndEmpty: cwd !== "" && existsSync(cwd) && readdirSync(cwd).length === 0,
      stdin: "",
    };
    captured.push(record);
    const child = new EventEmitter() as EventEmitter & {
      stdin: { on: () => void; end: (text: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdin = {
      on: () => {},
      end: (text: string) => {
        record.stdin = text;
      },
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  }) as unknown as typeof spawn;
}

function backend(captured: Captured[]) {
  const config = TunerConfigSchema.parse({
    models: { judge: "judge-model", proposer_default: "proposer-model" },
  });
  return new ClaudeCliBackend(config, fakeSpawn(captured));
}

function argsAt(captured: Captured[], i: number): string[] {
  const call = captured[i];
  if (!call) throw new Error(`no spawn call #${i}`);
  return call.args;
}

/** The value that follows `flag` in `args`. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function flagsOf(args: string[]): string[] {
  return args.filter((a) => a.startsWith("-"));
}

describe("ClaudeCliBackend — CLI arguments", () => {
  it("passes only flags the claude CLI accepts", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "sys", [{ role: "user", content: "hi" }], 512);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.command).toBe("claude");
    const args = argsAt(captured, 0);
    for (const flag of flagsOf(args)) {
      expect(KNOWN_FLAGS.has(flag)).toBe(true);
    }
    expect(args).not.toContain("--max-tokens");
  });

  it("passes the model configured for the role", async () => {
    const captured: Captured[] = [];
    const b = backend(captured);
    await b.call("judge", "sys", [{ role: "user", content: "hi" }]);
    await b.call("proposer", "sys", [{ role: "user", content: "hi" }]);
    for (const [i, model] of ["judge-model", "proposer-model"].entries()) {
      expect(flagValue(argsAt(captured, i), "--model")).toBe(model);
    }
  });

  it("omits --model when the config has no models section", async () => {
    const captured: Captured[] = [];
    // zod 4 does not apply nested defaults under .default({}), so models is {}.
    const config = TunerConfigSchema.parse({});
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    const args = argsAt(captured, 0);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("undefined");
  });

  it("omits --model for the env-routed glm alias", async () => {
    const captured: Captured[] = [];
    const config = TunerConfigSchema.parse({ models: { judge: "GLM" } });
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    expect(argsAt(captured, 0)).not.toContain("--model");
  });

  it("trims the configured model", async () => {
    const captured: Captured[] = [];
    const config = TunerConfigSchema.parse({ models: { judge: "  judge-model " } });
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    expect(flagValue(argsAt(captured, 0), "--model")).toBe("judge-model");
  });

  it("disables built-in tools and MCP servers", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("proposer", "sys", [{ role: "user", content: "hi" }]);
    const args = argsAt(captured, 0);
    expect(args).toContain("--tools");
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
  });

  it("delivers the prompt on stdin, never in argv", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "SYSTEM", [{ role: "user", content: "--settings={}" }]);
    const args = argsAt(captured, 0);
    expect(args).toContain("--print");
    expect(args).not.toContain("-p");
    expect(args.some((arg) => arg.includes("SYSTEM") || arg.includes("--settings"))).toBe(false);
    expect(captured[0]?.stdin).toContain("SYSTEM");
    expect(captured[0]?.stdin).toContain("--settings={}");
  });

  it("returns trimmed stdout on exit 0 and rejects on non-zero", async () => {
    const config = TunerConfigSchema.parse({});
    const ok = new ClaudeCliBackend(config, fakeSpawn([], "  answer \n", 0));
    expect(await ok.call("judge", "s", [])).toBe("answer");
    const ko = new ClaudeCliBackend(config, fakeSpawn([], "", 1));
    await expect(ko.call("judge", "s", [])).rejects.toThrow("claude CLI exited 1");
  });
});

describe("ClaudeCliBackend — isolation of the untrusted call", () => {
  it("loads no settings, hooks, session or slash commands", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "sys", [{ role: "user", content: "hi" }]);
    const args = argsAt(captured, 0);
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources");
    expect(flagValue(args, "--setting-sources")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    for (const flag of [
      "--mcp-config",
      "--resume",
      "--dangerously-skip-permissions",
      "--allowedTools",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("spawns with cleanSpawnEnv(), not the daemon env", async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDECODE: process.env.CLAUDECODE,
    };
    process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
    process.env.CLAUDECODE = "1";
    try {
      const captured: Captured[] = [];
      await backend(captured).call("judge", "sys", []);
      const env = captured[0]?.options.env;
      expect(env).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(env).toEqual(cleanSpawnEnv());
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.CLAUDECODE).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  for (const code of [0, 1]) {
    it(`runs in an empty temp cwd that is removed after exit ${code}`, async () => {
      const captured: Captured[] = [];
      const config = TunerConfigSchema.parse({});
      const b = new ClaudeCliBackend(config, fakeSpawn(captured, "x", code));
      const call = b.call("judge", "sys", []);
      if (code === 0) await call;
      else await expect(call).rejects.toThrow("claude CLI exited 1");
      const cwd = captured[0]?.options.cwd;
      expect(typeof cwd).toBe("string");
      expect(String(cwd).startsWith(tmpdir())).toBe(true);
      expect(String(cwd)).not.toBe(process.cwd());
      expect(captured[0]?.cwdLiveAndEmpty).toBe(true);
      expect(existsSync(String(cwd))).toBe(false);
    });
  }

  it("removes the temp cwd when the spawn itself fails", async () => {
    let seenCwd = "";
    const failing = ((_c: string, _a: string[], options: SpawnOptions) => {
      seenCwd = String(options.cwd);
      const child = new EventEmitter() as EventEmitter & {
        stdin: { on: () => void; end: () => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdin = { on: () => {}, end: () => {} };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    }) as unknown as typeof spawn;
    const b = new ClaudeCliBackend(TunerConfigSchema.parse({}), failing);
    await expect(b.call("judge", "sys", [])).rejects.toThrow("ENOENT");
    expect(seenCwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(seenCwd)).toBe(false);
  });
});

describe("ClaudeCliBackend — call timeout (#548 review: main had none)", () => {
  /** setTimeout delays requested while `run` executes. */
  async function delaysDuring(run: () => Promise<unknown>): Promise<number[]> {
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") delays.push(ms);
      return original(fn, ms, ...rest);
    }) as typeof setTimeout;
    try {
      await run();
    } finally {
      globalThis.setTimeout = original;
    }
    return delays;
  }

  it("defaults to ten minutes, not the 60 s that made slow calls exit 124", async () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(600_000);
    expect(TunerConfigSchema.parse({ llm: { backend: "claude_cli" } }).llm.timeout_ms).toBe(
      DEFAULT_LLM_TIMEOUT_MS,
    );
    for (const config of [TunerConfigSchema.parse({}), TunerConfigSchema.parse({ llm: {} })]) {
      const delays = await delaysDuring(() =>
        new ClaudeCliBackend(config, fakeSpawn([])).call("judge", "s", []),
      );
      expect(delays).toContain(DEFAULT_LLM_TIMEOUT_MS);
      expect(delays).not.toContain(60_000);
    }
  });

  it("honours llm.timeout_ms from the tuner config", async () => {
    const config = TunerConfigSchema.parse({ llm: { backend: "claude_cli", timeout_ms: 123_456 } });
    const delays = await delaysDuring(() =>
      new ClaudeCliBackend(config, fakeSpawn([])).call("judge", "s", []),
    );
    expect(delays).toContain(123_456);
    expect(delays).not.toContain(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("rejects a non-positive llm.timeout_ms at config load", () => {
    expect(() => TunerConfigSchema.parse({ llm: { timeout_ms: 0 } })).toThrow();
  });
});

describe("ClaudeCliBackend — stderr excerpt on non-zero exit", () => {
  const failing = (stderr: string) =>
    new ClaudeCliBackend(TunerConfigSchema.parse({}), fakeSpawn([], "", 1, stderr));

  it("includes the first 200 characters of stderr", async () => {
    const error = await failing("boom: " + "lorem ipsum ".repeat(50))
      .call("judge", "s", [])
      .catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message.startsWith("claude CLI exited 1: boom: ")).toBe(true);
    expect(message.slice("claude CLI exited 1: ".length)).toHaveLength(200);
  });

  it("masks credentials before they reach the error", async () => {
    const apiKey = ["sk", "ant", "api03", "A".repeat(30)].join("-");
    const error = await failing(`auth failed for ${apiKey}; ANTHROPIC_TOKEN=abc123 Bearer tok.en/xyz`)
      .call("judge", "s", [])
      .catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain("auth failed for [redacted]");
    for (const secret of [apiKey, "abc123", "tok.en/xyz"]) expect(message).not.toContain(secret);
  });

  it("masks a credential that straddles the 200-character cut", async () => {
    const apiKey = ["sk", "ant", "api03", "B".repeat(60)].join("-");
    const stderr = "e".repeat(190) + " " + apiKey;
    const error = await failing(stderr)
      .call("judge", "s", [])
      .catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).not.toContain("sk-ant");
    expect(message).not.toContain("BBBB");
  });
});
