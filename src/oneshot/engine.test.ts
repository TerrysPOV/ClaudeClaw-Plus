import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings, reloadSettings } from "../config.js";
import { runOneShot, type OneShotRequest } from "./engine.js";
import { engines } from "./registry.js";
import { parseOneShotSettings } from "./config.js";
import { UNTRUSTED_CLAUDE_ARGS } from "./isolation.js";
import { buildPrintArgs, withPrintRuntime } from "./print.js";
import { __buildClaudeArgsForTests } from "../runner/pty-process.js";
import {
  injectSpawnPty,
  snapshotSupervisor,
  injectOneShotTrustForTests,
} from "../runner/pty-supervisor.js";
import { ClaudeCliBackend, makeLLMClient } from "../skills-tuner/core/llm.js";
import { TunerConfigSchema } from "../skills-tuner/core/config.js";

const req: OneShotRequest = {
  route: "tuner.judge",
  prompt: "untrusted",
  isolation: "untrusted",
  timeoutMs: 1000,
};
const security = { level: "moderate" as const, allowedTools: [], disallowedTools: [] };
let configDir: string;
beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "oneshot-test-"));
  const file = join(configDir, "settings.json");
  writeFileSync(file, "{}");
  _setSettingsFileForTests(file);
  await loadSettings();
  injectOneShotTrustForTests(async () => {});
  injectSpawnPty(async () => {
    throw new Error("unexpected spawn");
  });
});
afterEach(() => {
  injectSpawnPty(null);
  injectOneShotTrustForTests(null);
  _setSettingsFileForTests();
  rmSync(configDir, { recursive: true, force: true });
});

describe("one-shot isolation contract", () => {
  it("rejects cwd on untrusted calls", async () => {
    await withPrintRuntime(
      {
        spawn: (() => {
          throw new Error("unexpected spawn");
        }) as typeof spawn,
      },
      async () => {
        await expect(runOneShot({ ...req, cwd: configDir } as OneShotRequest)).rejects.toThrow(
          "untrusted calls cannot specify",
        );
      },
    );
  });
  it("trusted print honours the requested cwd", async () => {
    let actualCwd = "";
    const spawnFn = ((_cmd: string, _args: string[], opts: { cwd: string }) => {
      actualCwd = opts.cwd;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof spawn;
    await withPrintRuntime({ spawn: spawnFn }, () =>
      runOneShot({ ...req, isolation: "trusted-session", cwd: configDir } as OneShotRequest),
    );
    expect(actualCwd).toBe(configDir);
    expect(existsSync(configDir)).toBe(true);
  });
  it("trusted PTY honours the requested cwd", async () => {
    let actualCwd = "";
    injectSpawnPty(async (opts) => {
      actualCwd = opts.cwd;
      return {
        runTurn: async () => ({
          text: "ok",
          sessionId: "s",
          bytesCaptured: 2,
          cleanBoundary: true,
        }),
        dispose: async () => {},
      } as never;
    });
    await engines
      .get("pty")!
      .run({ ...req, isolation: "trusted-session", cwd: configDir } as OneShotRequest);
    expect(actualCwd).toBe(configDir);
    expect(existsSync(configDir)).toBe(true);
  });
  for (const engine of engines.values()) {
    it(`${engine.id}: isolation must be explicit and deadline positive`, async () => {
      await withPrintRuntime(
        {
          spawn: (() => {
            throw new Error("unexpected spawn");
          }) as typeof spawn,
        },
        async () => {
          await expect(
            engine.run({ ...req, isolation: undefined } as unknown as OneShotRequest),
          ).rejects.toThrow("isolation");
          await expect(engine.run({ ...req, timeoutMs: 0 })).rejects.toThrow("timeoutMs");
        },
      );
    });
    it(`${engine.id}: rejects an already aborted request`, async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        engine.run({ ...req, isolation: "trusted-session", signal: controller.signal }),
      ).rejects.toThrow();
    });
    it(`${engine.id}: rejects untrusted resume and tools before executing`, async () => {
      for (const extra of [{ resumeSessionId: "x" }, { allowedTools: [] }]) {
        const call = () =>
          withPrintRuntime(
            {
              spawn: (() => {
                throw new Error("unexpected spawn");
              }) as typeof spawn,
            },
            () => engine.run({ ...req, ...extra }),
          );
        await expect(call()).rejects.toThrow("cannot specify resumeSessionId or allowedTools");
      }
    });
  }
  it("dispatcher rejects missing isolation and untrusted session privileges", async () => {
    await expect(
      runOneShot({ ...req, isolation: undefined } as unknown as OneShotRequest),
    ).rejects.toThrow("isolation");
    await withPrintRuntime(
      {
        spawn: (() => {
          throw new Error("unexpected spawn");
        }) as typeof spawn,
      },
      async () => {
        await expect(runOneShot({ ...req, resumeSessionId: "x" })).rejects.toThrow(
          "cannot specify",
        );
        await expect(runOneShot({ ...req, allowedTools: ["Write"] })).rejects.toThrow(
          "cannot specify",
        );
      },
    );
  });
  for (const id of ["print", "pty"]) {
    it(`${id}: argv contains canonical isolation sequence without privileged flags`, () => {
      const args =
        id === "print"
          ? buildPrintArgs(req)
          : __buildClaudeArgsForTests({
              sessionId: "hostile-session",
              cwd: "/tmp",
              env: {},
              security,
              isolation: "untrusted",
              securityArgs: ["--dangerously-skip-permissions"],
              mcpConfigPath: "/secret",
              appendSystemPrompt: "persona",
            });
      const start = args.indexOf("--tools");
      expect(args.slice(start, start + UNTRUSTED_CLAUDE_ARGS.length)).toEqual([
        ...UNTRUSTED_CLAUDE_ARGS,
      ]);
      for (const flag of [
        "--mcp-config",
        "--resume",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "--append-system-prompt",
      ])
        expect(args).not.toContain(flag);
    });
  }
  it("keeps the Python recall isolation flags in parity", () => {
    const source = readFileSync(
      new URL("../../tools/memory-search/memory_search/recall.py", import.meta.url),
      "utf8",
    );
    const body = source.match(/UNTRUSTED_CLI_FLAGS = (\[[\s\S]*?\])/)!;
    expect(JSON.parse(body[1]!.replace(/,\s*\]/, "]"))).toEqual([...UNTRUSTED_CLAUDE_ARGS]);
  });
  for (const code of [0, 1]) {
    it(`print removes its empty temporary cwd after exit ${code}`, async () => {
      let cwd = "";
      const spawnFn = ((_cmd: string, _args: string[], opts: { cwd: string }) => {
        cwd = opts.cwd;
        expect(readdirSync(cwd)).toEqual([]);
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("answer"));
          child.emit("close", code);
        });
        return child;
      }) as unknown as typeof spawn;
      const result = await withPrintRuntime({ spawn: spawnFn }, () => runOneShot(req));
      expect(result).toMatchObject({ engine: "print", text: "answer", exitCode: code });
      expect(cwd).not.toBe("");
      try {
        expect(existsSync(cwd)).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
  it("PTY uses a fresh process and disposes it without LRU admission", async () => {
    let disposed = 0;
    const before = snapshotSupervisor().ptys.length;
    injectSpawnPty(async (opts) => {
      expect(opts.sessionId).toBe("resume-me");
      return {
        sessionId: "resume-me",
        runTurn: async (prompt: string) => {
          expect(prompt).toBe("hello");
          expect(snapshotSupervisor().ptys.length).toBe(before);
          return { text: "done", sessionId: "resume-me", bytesCaptured: 4, cleanBoundary: true };
        },
        dispose: async () => {
          disposed++;
        },
      } as never;
    });
    const result = await engines
      .get("pty")!
      .run({ ...req, prompt: "hello", isolation: "trusted-session", resumeSessionId: "resume-me" });
    expect(result.text).toBe("done");
    expect(disposed).toBe(1);
    expect(snapshotSupervisor().ptys.length).toBe(before);
  });
  it("PTY deadline disposes the process exactly once", async () => {
    let disposed = 0;
    let started = false;
    injectSpawnPty(
      async () =>
        ({
          runTurn: () => {
            started = true;
            return new Promise(() => {});
          },
          dispose: async () => {
            disposed++;
          },
        }) as never,
    );
    await expect(
      engines.get("pty")!.run({ ...req, isolation: "trusted-session", timeoutMs: 30 }),
    ).rejects.toThrow("timed out");
    expect(started).toBe(true);
    expect(disposed).toBe(1);
  });
  it("PTY deadline retires a process whose spawn lands late", async () => {
    let release!: (pty: never) => void;
    let disposed = 0;
    let spawned = false;
    injectSpawnPty(() => {
      spawned = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await expect(
      engines.get("pty")!.run({ ...req, isolation: "trusted-session", timeoutMs: 30 }),
    ).rejects.toThrow("timed out");
    expect(spawned).toBe(true);
    release({
      dispose: async () => {
        disposed++;
      },
      runTurn: () => {
        throw new Error("late turn must not run");
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(1);
  });
  it("print deadline terminates the child and removes cwd", async () => {
    let cwd = "";
    let killed = false;
    const spawnFn = ((_cmd: string, _args: string[], opts: { cwd: string }) => {
      cwd = opts.cwd;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          killed = true;
          queueMicrotask(() => child.emit("close", null));
          return true;
        },
      });
      return child;
    }) as unknown as typeof spawn;
    const result = await withPrintRuntime({ spawn: spawnFn }, () =>
      runOneShot({ ...req, timeoutMs: 10 }),
    );
    expect(result.exitCode).toBe(124);
    expect(killed).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });
  it("preserves classifier stdin delivery and environment", async () => {
    let input = "";
    const env = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "test-only" };
    const spawnFn = ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      expect(args).not.toContain("private message");
      expect(args).toContain("--print");
      expect(opts.env).toEqual(env);
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), {
          end: (text: string) => {
            input = text;
          },
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof spawn;
    await withPrintRuntime({ spawn: spawnFn, env, stdinPrompt: true }, () =>
      runOneShot({ ...req, route: "discord.classifier", prompt: "private message" }),
    );
    expect(input).toBe("private message");
  });
});

describe("one-shot configuration", () => {
  it("tuner oneshot follows routing while claude_cli remains a print alias", async () => {
    engines.set("fake", {
      id: "fake",
      caps: { resume: true, tools: true, isolation: true },
      run: async () => ({ text: "via-route", engine: "fake", model: "", exitCode: 0 }),
    });
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({ oneShot: { routes: { "tuner.judge": "fake" } } }),
      );
      await reloadSettings();
      const client = makeLLMClient(TunerConfigSchema.parse({ llm: { backend: "oneshot" } }));
      expect(await client.call("judge", "sys", [])).toBe("via-route");
      let spawned = 0;
      const spawnFn = (() => {
        spawned++;
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("via-print"));
          child.emit("close", 0);
        });
        return child;
      }) as unknown as typeof spawn;
      expect(
        await new ClaudeCliBackend(TunerConfigSchema.parse({}), spawnFn).call("judge", "sys", []),
      ).toBe("via-print");
      expect(spawned).toBe(1);
    } finally {
      engines.delete("fake");
    }
  });
  it("rejects bad routing during settings load", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ oneShot: { routes: { "memory.recall": "pty" } } }),
    );
    await expect(reloadSettings()).rejects.toThrow("spike");
  });
  it("routes trusted requests to the selected engine and logs once", async () => {
    const original = console.info;
    const logs: string[] = [];
    console.info = (line: string) => {
      logs.push(line);
    };
    engines.set("fake", {
      id: "fake",
      caps: { resume: true, tools: true, isolation: true },
      run: async (request) => {
        expect(request.resumeSessionId).toBe("sid");
        return {
          text: "routed",
          engine: "fake",
          model: "test",
          exitCode: 0,
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    });
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({ oneShot: { routes: { compact: "fake" } } }),
      );
      await reloadSettings();
      expect(
        (
          await runOneShot({
            ...req,
            route: "compact",
            isolation: "trusted-session",
            resumeSessionId: "sid",
          })
        ).engine,
      ).toBe("fake");
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!.replace("[oneshot] ", ""))).toMatchObject({
        route: "compact",
        engine: "fake",
        model: "test",
        isolation: "trusted-session",
        exitCode: 0,
        inputTokens: 3,
        outputTokens: 2,
      });
    } finally {
      console.info = original;
      engines.delete("fake");
    }
  });
  it("defaults every route to print", () =>
    expect(parseOneShotSettings(undefined)).toEqual({ default: "print", engines: {}, routes: {} }));
  it("rejects resume routes on engines without resume capability", () => {
    engines.set("stateless", {
      id: "stateless",
      caps: { resume: false, tools: false, isolation: true },
      run: async () => {
        throw new Error("unused");
      },
    });
    try {
      expect(() => parseOneShotSettings({ routes: { compact: "stateless" } })).toThrow("resume");
    } finally {
      engines.delete("stateless");
    }
  });
  for (const settings of [
    { routes: { "tuner.judge": "pty" } },
    { default: "pty" },
    { routes: { "tuner.*": "pty" } },
  ]) {
    it(`rejects untrusted PTY before the isolation spike: ${JSON.stringify(settings)}`, () =>
      expect(() => parseOneShotSettings(settings)).toThrow("spike"));
  }
  it("rejects unknown engines", () =>
    expect(() => parseOneShotSettings({ default: "missing" })).toThrow("Unknown"));
  it("accepts a PTY default with explicit print overrides for untrusted routes", () => {
    expect(
      parseOneShotSettings({
        default: "pty",
        routes: { "tuner.*": "print", "discord.classifier": "print", "memory.recall": "print" },
      }).default,
    ).toBe("pty");
  });
  it("rejects malformed engine and route declarations", () => {
    for (const raw of [
      null,
      { engines: [] },
      { engines: { print: null } },
      { routes: { compact: 42 } },
      { default: 7 },
    ]) {
      expect(() => parseOneShotSettings(raw)).toThrow("oneShot");
    }
  });
});
