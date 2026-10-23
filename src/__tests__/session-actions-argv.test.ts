/**
 * The argv the one-shot fallbacks of compact / rotation summary actually spawn (#549
 * review fixes). Goes through the real `print` engine with only `spawn` faked, so it
 * sees what `claude` would be started with.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, initConfig, loadSettings, reloadSettings } from "../config";
import { runOneShot } from "../oneshot/engine";
import { withPrintRuntime } from "../oneshot/print";
import { runCompact } from "../runner";
import { injectOneShotForTests, saveMemoryBeforeCompact } from "../runner/live-session-actions";
import { __resetSupervisorForTests, shutdownSupervisor } from "../runner/pty-supervisor";
import { generateSummary } from "../rotation";

/** Runs `fn` with the print engine's spawn faked; returns every argv it was given. */
async function captureArgv<T>(
  fn: () => Promise<T>,
  stdout = "",
): Promise<{ argv: string[][]; result: T }> {
  const argv: string[][] = [];
  const spawnFn = ((_cmd: string, args: string[]) => {
    argv.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {},
    });
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const result = await withPrintRuntime({ spawn: spawnFn }, fn);
  return { argv, result };
}

/** The value following `flag`, or undefined when the flag is absent. */
const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

let settingsDir: string;

beforeEach(async () => {
  __resetSupervisorForTests();
  settingsDir = await mkdtemp(join(tmpdir(), "session-actions-argv-"));
  const settingsPath = join(settingsDir, "settings.json");
  _setSettingsFileForTests(settingsPath);
  await initConfig();
  await writeFile(settingsPath, JSON.stringify({ oneShot: { default: "print" } }));
  await loadSettings();
  await reloadSettings();
  injectOneShotForTests(null); // the real runOneShot -> print engine
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
  _setSettingsFileForTests();
  await rm(settingsDir, { recursive: true, force: true });
});

describe("compact fallback argv", () => {
  it("runs with no tools and without the permission-bypass or any default permission profile", async () => {
    const { argv } = await captureArgv(() =>
      runCompact({ sessionId: "sid-1", sessionKey: "global", model: "sonnet", timeoutMs: 5000 }),
    );

    expect(argv.length).toBe(1);
    const args = argv[0];
    expect(args.slice(0, 2)).toEqual(["-p", "/compact"]);
    expect(flagValue(args, "--resume")).toBe("sid-1");
    expect(flagValue(args, "--tools")).toBe(""); // no tools at all
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(args, "--permission-mode")).toBe("dontAsk"); // denies, never prompts
    expect(args).not.toContain("--disallowedTools");
  });
});

describe("rotation summary fallback argv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rot-argv-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("grants no tools: the summary comes back on stdout and the daemon writes the file", async () => {
    const { argv, result } = await captureArgv(
      () => generateSummary("old-sid", dir),
      "the summary",
    );

    expect(result).toBe("the summary");
    expect(argv.length).toBe(1);
    const args = argv[0];
    expect(flagValue(args, "--resume")).toBe("old-sid");
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).not.toContain("Write");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(args, "--permission-mode")).toBe("dontAsk"); // denies, never prompts
  });
});

describe("print engine with an explicit tool list only", () => {
  it("does not fall back to the default permission profile (which can carry the bypass flag)", async () => {
    const { argv } = await captureArgv(() =>
      runOneShot({
        route: "compact",
        prompt: "/compact",
        isolation: "trusted-session",
        resumeSessionId: "sid",
        tools: ["Read"],
        timeoutMs: 5000,
      }),
    );

    expect(flagValue(argv[0], "--tools")).toBe("Read");
    expect(argv[0]).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(argv[0], "--permission-mode")).toBe("dontAsk"); // denies, never prompts
  });
});

describe("pre-compact memory save fallback argv", () => {
  const save = (memPath: string, over: Record<string, unknown> = {}) =>
    saveMemoryBeforeCompact({
      memPath,
      prompt: "save it",
      sessionKey: "global",
      sessionId: "sid-9",
      skipLive: true,
      model: "sonnet",
      timeoutMs: 5000,
      ...over,
    });

  it("resumes with Read,Write available and only the memory file pre-approved", async () => {
    const { argv, result } = await captureArgv(() => save("/work/proj/MEMORY.md"));

    expect(result.ok).toBe(true);
    expect(argv.length).toBe(1);
    const args = argv[0];
    expect(flagValue(args, "--resume")).toBe("sid-9");
    expect(flagValue(args, "--tools")).toBe("Read,Write");
    expect(flagValue(args, "--allowedTools")).toBe(
      "Edit(//work/proj/MEMORY.md),Read(//work/proj/MEMORY.md)",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("a memory path that cannot be scoped fails the save and spawns nothing", async () => {
    const { argv, result } = await captureArgv(() => save("/work/pr*oj/MEMORY.md"));

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("cannot be scoped");
    expect(argv).toEqual([]);
  });
});
