/**
 * The argv the one-shot fallbacks of compact / rotation summary actually spawn (#549
 * review fixes). Goes through the real `print` engine with only `spawn` faked, so it
 * sees what `claude` would be started with.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig, loadSettings, reloadSettings } from "../config";
import { withPrintRuntime } from "../oneshot/print";
import { runCompact } from "../runner";
import { injectOneShotForTests } from "../runner/live-session-actions";
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

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  injectOneShotForTests(null); // the real runOneShot -> print engine
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
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
    expect(args).not.toContain("--permission-mode");
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
    expect(args).not.toContain("--permission-mode");
  });
});
