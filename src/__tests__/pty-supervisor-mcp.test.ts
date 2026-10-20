/**
 * pty-supervisor.ts × MCP multiplexer wiring tests (SPEC §4.5, §6.1, §6.3).
 *
 * Exercises the synthesis hook in buildSpawnOptions + the cleanup hook on
 * dispose paths. The multiplexer plugin itself doesn't exist in this
 * worktree — we stub it via `injectMcpIdentityIssuer`.
 *
 * Coverage (this file):
 *   - Synthesis fires when settings.mcp.shared is non-empty AND web.enabled AND
 *     issuer is wired → PtyProcessOptions.mcpConfigPath is set, file on disk.
 *   - Synthesis SKIPS when settings.mcp.shared is empty (backward-compat, SPEC §6.1).
 *   - Synthesis SKIPS when web.enabled is false (SPEC §6.3).
 *   - Synthesis SKIPS when no issuer is wired (multiplexer dormant).
 *   - Cleanup fires on shutdownSupervisor and killAllPtys.
 *
 * NOT covered here (component-tested elsewhere or pending follow-up):
 *   - reapIdle / LRU eviction cleanup — exercised at the supervisor-component
 *     level via the broader pty-supervisor.test.ts dispose-path tests.
 *   - Respawn bearer rotation — exercised by the multiplexer plugin tests
 *     (`mcp-multiplexer/__tests__/index.test.ts`) which validate
 *     `issueIdentity(ptyId)` mints a fresh secret on every call. A dedicated
 *     supervisor-side respawn-rotation test is filed as a v1.1 follow-up.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyFile, mkdir, unlink } from "fs/promises";

import {
  runOnPty,
  shutdownSupervisor,
  killAllPtys,
  injectSpawnPty,
  injectClock,
  resetClock,
  injectSleep,
  resetSleep,
  injectEnsureAgentDir,
  injectMcpIdentityIssuer,
  __resetSupervisorForTests,
} from "../runner/pty-supervisor";
import {
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
  type SpawnPty,
} from "../runner/pty-process";
import { configPathFor, type PtyIdentity } from "../runner/pty-mcp-config-writer";
import { initConfig, loadSettings, reloadSettings } from "../config";

// ─── Settings management ────────────────────────────────────────────────────

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.pty-mcp-test-backup");

async function backupSettings(): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
  }
}

async function restoreSettings(): Promise<void> {
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
  try {
    await reloadSettings();
  } catch {
    // tolerate
  }
}

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
  await reloadSettings();
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

let TEST_ROOT: string;

interface FakePtyHandle extends PtyProcess {
  disposed: boolean;
}

function makeFakePty(label: string, cwd: string): FakePtyHandle {
  let alive = true;
  let lastTurnEndedAt = 0;
  let disposed = false;
  const handle: FakePtyHandle = {
    label,
    pid: Math.floor(Math.random() * 100000) + 1000,
    sessionId: "fake-session-id",
    cwd,
    isAlive() {
      return alive;
    },
    lastTurnEndedAt() {
      return lastTurnEndedAt;
    },
    async runTurn(prompt): Promise<PtyTurnResult> {
      lastTurnEndedAt = Date.now();
      return {
        text: `echo:${prompt}`,
        bytesCaptured: prompt.length,
        cleanBoundary: true,
        sessionId: "fake-session-id",
      };
    },
    async dispose(): Promise<void> {
      alive = false;
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  } as unknown as FakePtyHandle;
  Object.defineProperty(handle, "disposed", { get: () => disposed });
  return handle;
}

interface SpawnTracker {
  spawn: SpawnPty;
  spawned: FakePtyHandle[];
  spawnOpts: PtyProcessOptions[];
}

function makeSpawnTracker(): SpawnTracker {
  const spawned: FakePtyHandle[] = [];
  const spawnOpts: PtyProcessOptions[] = [];
  const spawn: SpawnPty = async (opts) => {
    const handle = makeFakePty("test", opts.cwd);
    spawned.push(handle);
    spawnOpts.push(opts);
    return handle;
  };
  return { spawn, spawned, spawnOpts };
}

interface FakeIssuerHandle {
  issue: (ptyId: string) => PtyIdentity;
  revoke: (ptyId: string) => void;
  issued: string[]; // log of ptyIds for which we issued
  revoked: string[]; // log of ptyIds for which we revoked
  currentSecret: Map<string, string>; // ptyId → hex
}

let _secretCounter = 0;

function makeFakeIssuer(): FakeIssuerHandle {
  const issued: string[] = [];
  const revoked: string[] = [];
  const currentSecret = new Map<string, string>();
  return {
    issued,
    revoked,
    currentSecret,
    issue(ptyId: string): PtyIdentity {
      _secretCounter += 1;
      const hex = _secretCounter.toString(16).padStart(64, "0");
      currentSecret.set(ptyId, hex);
      issued.push(ptyId);
      const issuedAt = 1_700_000_000_000 + _secretCounter;
      const bearer = `Bearer ${hex}`;
      return {
        ptyId,
        issuedAt,
        bearer,
        headers: {
          Authorization: bearer,
          "X-Claudeclaw-Pty-Id": ptyId,
          "X-Claudeclaw-Ts": String(issuedAt),
        },
      };
    },
    revoke(ptyId: string): void {
      revoked.push(ptyId);
      currentSecret.delete(ptyId);
    },
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  __resetSupervisorForTests();
  resetClock();
  resetSleep();
  TEST_ROOT = mkdtempSync(join(tmpdir(), "ccw-pty-mcp-sup-"));
  await initConfig();
  await loadSettings();
  await backupSettings();
  // Default test setup: TEST_ROOT is the cwd for spawned agents. We stub
  // ensureAgentDir to write under TEST_ROOT instead of the repo's agents/.
  injectEnsureAgentDir(async (name: string) => {
    const d = join(TEST_ROOT, "agents", name);
    await mkdir(d, { recursive: true });
    return d;
  });
});

/** Agent names this file spawns; see the cleanup in `afterEach`. */
const AGENT_NAMES_USED = ["suzy"];

afterEach(async () => {
  resetClock();
  resetSleep();
  await shutdownSupervisor();
  __resetSupervisorForTests();
  await restoreSettings();
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
  // `ensureAgentDir` is stubbed to TEST_ROOT above, but the supervisor's
  // `persistSessionId` writes through `createSession()`, which always resolves
  // against `process.cwd()` — so a run leaves `<repo>/agents/suzy` behind. It
  // then makes `validateAgentName("suzy")` answer "already exists" in
  // `agents.test.ts`, which is why the full-tree CI job has been red on main
  // (the same cleanup the sibling `pty-integration.test.ts` already does).
  for (const name of AGENT_NAMES_USED) {
    rmSync(join(process.cwd(), "agents", name), { recursive: true, force: true });
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("supervisor × MCP multiplexer — synthesis activation (SPEC §4.5 §6.3)", () => {
  it("synthesizes mcpConfigPath when shared non-empty, web enabled, issuer wired", async () => {
    await writeRawSettings({
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    const issuer = makeFakeIssuer();
    injectMcpIdentityIssuer({ issue: issuer.issue, revoke: issuer.revoke });

    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(tracker.spawned).toHaveLength(1);
    const opts = tracker.spawnOpts[0]!;
    expect(opts.mcpConfigPath).toBeDefined();
    expect(opts.mcpConfigPath).toContain(".claudeclaw");
    expect(opts.mcpConfigPath).toContain("mcp-pty-agent:suzy.json");
    expect(existsSync(opts.mcpConfigPath!)).toBe(true);
    // Issuer was asked for an identity for this PTY.
    expect(issuer.issued).toContain("agent:suzy");
  });

  it("does NOT synthesize when settings.mcp.shared is empty (backward-compat, SPEC §6.1)", async () => {
    await writeRawSettings({
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: [] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    const issuer = makeFakeIssuer();
    injectMcpIdentityIssuer({ issue: issuer.issue, revoke: issuer.revoke });

    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(tracker.spawnOpts[0]!.mcpConfigPath).toBeUndefined();
    // Issuer is NEVER called when synthesis is skipped — keeps the
    // multiplexer's HMAC map empty for dormant PTYs.
    expect(issuer.issued).toEqual([]);
  });

  it("does NOT synthesize when settings.web.enabled is false (SPEC §6.3)", async () => {
    await writeRawSettings({
      web: { enabled: false, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    const issuer = makeFakeIssuer();
    injectMcpIdentityIssuer({ issue: issuer.issue, revoke: issuer.revoke });

    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(tracker.spawnOpts[0]!.mcpConfigPath).toBeUndefined();
    expect(issuer.issued).toEqual([]);
  });

  it("does NOT synthesize when no issuer is wired (W1 dormant)", async () => {
    await writeRawSettings({
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    // No injectMcpIdentityIssuer call — issuer remains null.

    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(tracker.spawnOpts[0]!.mcpConfigPath).toBeUndefined();
  });
});

describe("supervisor × MCP multiplexer — cleanup paths (SPEC §4.5)", () => {
  async function setupActivePty(): Promise<{
    tracker: SpawnTracker;
    issuer: FakeIssuerHandle;
    cwd: string;
  }> {
    await writeRawSettings({
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    const issuer = makeFakeIssuer();
    injectMcpIdentityIssuer({ issue: issuer.issue, revoke: issuer.revoke });
    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });
    const opts = tracker.spawnOpts[0]!;
    expect(opts.mcpConfigPath).toBeDefined();
    expect(existsSync(opts.mcpConfigPath!)).toBe(true);
    return { tracker, issuer, cwd: opts.cwd };
  }

  it("shutdownSupervisor revokes identity and deletes the synthesized config", async () => {
    const { issuer, cwd } = await setupActivePty();
    const cfgPath = configPathFor(cwd, "agent:suzy");
    expect(existsSync(cfgPath)).toBe(true);

    await shutdownSupervisor();

    expect(issuer.revoked).toContain("agent:suzy");
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("killAllPtys revokes identity and deletes the synthesized config", async () => {
    const { issuer, cwd } = await setupActivePty();
    const cfgPath = configPathFor(cwd, "agent:suzy");

    await killAllPtys();

    expect(issuer.revoked).toContain("agent:suzy");
    expect(existsSync(cfgPath)).toBe(false);
  });
});

describe("supervisor × MCP multiplexer — identity-issuer toggle", () => {
  it("injectMcpIdentityIssuer({ issue: null }) disables synthesis even when settings are active", async () => {
    await writeRawSettings({
      web: { enabled: true, host: "127.0.0.1", port: 4632 },
      mcp: { shared: ["graphiti"] },
    });
    const tracker = makeSpawnTracker();
    injectSpawnPty(tracker.spawn);
    const issuer = makeFakeIssuer();
    injectMcpIdentityIssuer({ issue: issuer.issue, revoke: issuer.revoke });
    // Re-disable.
    injectMcpIdentityIssuer({ issue: null });

    await runOnPty("agent:suzy", "hello", {
      timeoutMs: 60_000,
      agentName: "suzy",
    });

    expect(tracker.spawnOpts[0]!.mcpConfigPath).toBeUndefined();
  });
});
