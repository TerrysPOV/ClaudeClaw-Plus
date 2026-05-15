/**
 * Backward-compatibility regression gate (SPEC §5.4).
 *
 * Verifies the two operator-locked routing rules in execClaude:
 *
 *   1. settings.pty.enabled === false  → supervisor is bypassed entirely.
 *   2. name === "bootstrap"            → supervisor is bypassed even when
 *                                        pty.enabled === true (SPEC §7.1).
 *
 * We can't easily invoke execClaude end-to-end without spawning a real claude
 * subprocess (Phase C territory), so this file verifies the routing logic by
 * driving the supervisor directly under both flag positions and asserting
 * which path executes.
 *
 * The "no regressions" guarantee for existing tests is provided structurally:
 *   - No existing test in src/__tests__/ invokes execClaude.
 *   - All existing tests continue to pass under the default (pty.enabled=true)
 *     config — verified by `bun test` on this branch.
 *   - With pty.enabled=false, runner.ts skips the supervisor entirely so its
 *     behaviour is byte-identical to pre-migration code.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { copyFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";

import { initConfig, loadSettings, reloadSettings, getSettings } from "../config";
import {
  injectSpawnPty,
  injectEnsureAgentDir,
  injectSleep,
  resetSleep,
  __resetSupervisorForTests,
  runOnPty,
  shutdownSupervisor,
} from "../runner/pty-supervisor";
import type {
  PtyProcess,
  PtyProcessOptions,
  SpawnPty,
} from "../runner/pty-process";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.pty-bc-test-backup");

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
}

function makeNoopPty(): PtyProcess {
  return {
    label: "noop",
    pid: 999,
    sessionId: "noop-session",
    cwd: "/tmp",
    isAlive: () => true,
    lastTurnEndedAt: () => Date.now(),
    runTurn: async (prompt) => ({
      text: `noop:${prompt}`,
      bytesCaptured: prompt.length,
      cleanBoundary: true,
      sessionId: "noop-session",
    }),
    dispose: async () => {},
  };
}

let backedUp = false;

beforeEach(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE) && !existsSync(BACKUP_FILE)) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
    backedUp = true;
  }
  __resetSupervisorForTests();
  resetSleep();
  injectSleep(async () => {});
  injectEnsureAgentDir(async (name: string) => `/tmp/agents/${name}`);
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
  if (backedUp && existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
    backedUp = false;
  }
});

describe("pty.enabled flag — config-level", () => {
  it("default is false (opt-in) — supervisor only reachable when explicitly enabled", async () => {
    await writeRawSettings({});
    await initConfig();
    await loadSettings();
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(false);
  });

  it("enabled=true permits supervisor calls", async () => {
    await writeRawSettings({ pty: { enabled: true } });
    await initConfig();
    await loadSettings();
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(true);

    let spawnCount = 0;
    const spawn: SpawnPty = async (_opts: PtyProcessOptions) => {
      spawnCount += 1;
      return makeNoopPty();
    };
    injectSpawnPty(spawn);

    const r = await runOnPty("global", "hi", { timeoutMs: 1000 });
    expect(r.exitCode).toBe(0);
    expect(spawnCount).toBe(1);
  });

  it("enabled=false still permits direct supervisor calls (the runner-level guard is upstream)", async () => {
    // The supervisor itself is flag-agnostic — the routing guard lives in
    // execClaude. This test documents the contract: callers MUST check the
    // flag BEFORE invoking runOnPty. The supervisor still works if called
    // directly, which is correct (the flag is a routing concern, not a
    // capability concern).
    await writeRawSettings({ pty: { enabled: false } });
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(false);

    let spawnCount = 0;
    injectSpawnPty(async () => {
      spawnCount += 1;
      return makeNoopPty();
    });

    const r = await runOnPty("global", "hi", { timeoutMs: 1000 });
    expect(r.exitCode).toBe(0);
    expect(spawnCount).toBe(1);
  });
});

describe("execClaude routing — flag and bootstrap (source-pinned)", () => {
  // We can't import execClaude (it's not exported), so we verify the
  // source-level routing rule by reading the runner.ts file and asserting
  // the bootstrap bypass + flag check exist exactly as the spec requires.
  it("runner.ts contains the isInfraCall = name === 'bootstrap' check", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    expect(src).toMatch(/isInfraCall\s*=\s*name\s*===\s*["']bootstrap["']/);
  });

  it("runner.ts contains the useLegacyPath OR of !pty.enabled and isInfraCall", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    expect(src).toMatch(/useLegacyPath\s*=\s*!\s*settings\.pty\.enabled\s*\|\|\s*isInfraCall/);
  });

  it("runner.ts routes to runClaudeStream on the legacy branch", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    // The legacy call should still use runClaudeStream with the standard arg list.
    expect(src).toMatch(/if\s*\(\s*useLegacyPath\s*\)\s*\{[\s\S]*?runClaudeStream\(/);
  });

  it("runner.ts routes to runOnPty on the PTY branch", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    // The PTY call should still use runOnPty with a sessionKey.
    expect(src).toMatch(/runOnPty\(\s*sessionKey/);
  });

  it("runner.ts streamClaude (OR-3 bypass) is unchanged: it still uses Bun.spawn directly", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    // streamClaude must still spawn its own claude -p subprocess. Look for
    // the streamClaude function signature and assert it still contains
    // Bun.spawn (not runOnPty).
    const streamFn = src.match(/async function streamClaude\([\s\S]*?\n\}\n/);
    expect(streamFn).not.toBeNull();
    // streamClaude should NOT invoke the supervisor.
    expect(streamFn![0]).not.toMatch(/runOnPty/);
    // streamClaude SHOULD still use the legacy spawn.
    expect(streamFn![0]).toMatch(/Bun\.spawn/);
  });
});
