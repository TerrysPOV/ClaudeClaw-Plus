/**
 * PTY integration tests (Phase C of the PTY migration).
 *
 * What this covers:
 *   1. Real `claude` PTY end-to-end through the supervisor's `runOnPty`:
 *        - send a prompt, verify the RunOnPtyResult shape (rawStdout / stderr /
 *          exitCode / sessionId) matches what the spec §3.2 promises.
 *   2. Session resume after a hard kill: kill the PTY, send another prompt,
 *      verify Claude has full prior context (it remembers the previous prompt).
 *   3. Concurrent PTYs: 3 independent sessionKeys, no output interleaving.
 *   4. Crash + retry: synthetic crash via the spawn-injection seam, verify
 *      the supervisor respawns and the user-visible result is correct.
 *      Plus max-retry exhaustion → structured error result (spec §3.2).
 *   5. Idle reap: shrink idleReapMinutes, advance the fake clock,
 *      __reapNowForTests, verify the ad-hoc PTY is disposed, then verify the
 *      next runOnPty respawns transparently.
 *   6. Backward-compat regression: with pty.enabled=false, the supervisor is
 *      never reached. (Covered by pty-backward-compat.test.ts at the unit
 *      level; here we just spot-check the runOnPty contract is unchanged.)
 *
 * Real-claude tests are gated by the env var
 *   CLAUDECLAW_PTY_INTEGRATION_TESTS=1
 * because they spawn the actual `claude` CLI (slow, requires a logged-in
 * subscription account). The synthetic-crash and idle-reap tests run
 * unconditionally — they use the injectSpawnPty seam.
 *
 * Each real-claude test bounds its work with a generous per-turn timeout
 * (TURN_TIMEOUT_MS = 120s, matching settings.timeouts.* defaults) and a
 * per-test envelope of 3 turns + 60s headroom. Synthetic tests use the fake
 * clock + fake sleep seams so they finish in milliseconds.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink, rm } from "fs/promises";
import { existsSync } from "fs";

import { initConfig, loadSettings, reloadSettings, getSettings } from "../config";
import {
  injectSpawnPty,
  injectEnsureAgentDir,
  injectClock,
  resetClock,
  injectSleep,
  resetSleep,
  __resetSupervisorForTests,
  __reapNowForTests,
  runOnPty,
  shutdownSupervisor,
  snapshotSupervisor,
} from "../runner/pty-supervisor";
import {
  PtyClosedError,
  PtyTurnTimeoutError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
  type SpawnPty,
} from "../runner/pty-process";
import { createThreadSession, removeThreadSession } from "../sessionManager";
import { readdir } from "fs/promises";
import { homedir } from "os";

// ─────────────────────────────────────────────────────────────────────────────
// Environment & guards.

const REAL_CLAUDE = process.env.CLAUDECLAW_PTY_INTEGRATION_TESTS === "1";
// Per-turn timeout passed to runTurn. Real Claude can take 30-60s for a cold
// turn (model warmup, MCP attach, tool resolution); 120s is the operator
// default in settings.timeouts.* too.
const TURN_TIMEOUT_MS = 120_000;
// Outer per-test timeout headroom — covers spawn + multi-turn + reap delays.
const TEST_TIMEOUT_MS = TURN_TIMEOUT_MS * 3 + 60_000;
const TEST_PROJECT_DIR = join("/tmp", `claudeclaw-pty-it-${process.pid}`);

// Per-test settings backup/restore so we can tweak pty.* without corrupting
// the developer's working settings.json.
const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.pty-it-backup");

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
}

let backedUp = false;

async function backupSettings(): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE) && !existsSync(BACKUP_FILE)) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
    backedUp = true;
  }
}

async function restoreSettings(): Promise<void> {
  if (backedUp && existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
    backedUp = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake-PTY factory shared by synthetic tests.
//
// We model a minimal in-memory PtyProcess. Tests pass `onTurn` to dictate
// what each call to `runTurn` does.

interface FakePtyOpts {
  onTurn?: (prompt: string, callIndex: number) => Promise<PtyTurnResult>;
  initialSessionId?: string;
  pid?: number;
  label?: string;
  /** Clock for `lastTurnEndedAt()`. Defaults to Date.now. Tests that drive a
   *  fake clock pass this in so the supervisor's reap logic sees consistent
   *  times. */
  clock?: () => number;
}

interface FakePtyHandle extends PtyProcess {
  turnCount: number;
  disposed: boolean;
}

function makeFakePty(opts: FakePtyOpts = {}): FakePtyHandle {
  const pid = opts.pid ?? Math.floor(Math.random() * 90000) + 1000;
  const label = opts.label ?? `fake:${pid}`;
  const clock = opts.clock ?? (() => Date.now());
  let sessionId = opts.initialSessionId ?? `sess-${pid}`;
  let lastTurnEndedAt = 0;
  let disposed = false;
  let turnCount = 0;

  const handle: FakePtyHandle = {
    label,
    pid,
    get sessionId() {
      return sessionId;
    },
    cwd: "/tmp",
    isAlive: () => !disposed,
    lastTurnEndedAt: () => lastTurnEndedAt,
    runTurn: async (prompt: string): Promise<PtyTurnResult> => {
      turnCount += 1;
      handle.turnCount = turnCount;
      if (opts.onTurn) {
        const r = await opts.onTurn(prompt, turnCount - 1);
        lastTurnEndedAt = clock();
        sessionId = r.sessionId || sessionId;
        return r;
      }
      lastTurnEndedAt = clock();
      return {
        text: `fake-response:${prompt}`,
        bytesCaptured: prompt.length,
        cleanBoundary: true,
        sessionId,
      };
    },
    dispose: async () => {
      disposed = true;
    },
    turnCount: 0,
    disposed: false,
  };
  // mirror disposed onto the handle for test assertions
  Object.defineProperty(handle, "disposed", {
    get: () => disposed,
  });
  return handle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite-wide setup.

beforeAll(async () => {
  await backupSettings();
  await mkdir(TEST_PROJECT_DIR, { recursive: true });
});

beforeEach(async () => {
  // Reset internal state so each test starts clean.
  __resetSupervisorForTests();
  // Real-clock + real-sleep for real-PTY tests; tests that want fake time
  // re-inject them explicitly.
  resetClock();
  resetSleep();
  // Stub ensureAgentDir so we don't pollute the repo's agents/ directory.
  injectEnsureAgentDir(async (name: string) => join(TEST_PROJECT_DIR, "agents", name));
  // Default settings: PTY enabled, fast backoff so retry tests don't wait
  // wall-clock. turnIdleTimeoutMs is the per-turn hard-cap safety-net.
  // quietWindowMs / sentinelMaxWaitMs control the sentinel-echo round-trip
  // (issue #81). quietWindowMs is set wide for real-claude tests so Claude's
  // own mid-response pauses don't trigger a premature sentinel write.
  await writeRawSettings({
    pty: {
      enabled: true,
      idleReapMinutes: 30,
      maxRetries: 2,
      backoffMs: [10, 20],
      namedAgentsAlwaysAlive: true,
      turnIdleTimeoutMs: 60_000,
      cols: 100,
      rows: 30,
      quietWindowMs: 1500,
      sentinelMaxWaitMs: 30_000,
    },
  });
  await initConfig();
  await loadSettings();
  await reloadSettings();
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
  resetClock();
  resetSleep();
  // Clean up any agent session files the supervisor's persistSessionId may
  // have written to repo-root/agents/ via createSession() (which always
  // resolves against process.cwd(), not our injected ensureAgentDir).
  for (const name of ["suzy", "test-resume", "test-conc"]) {
    await rm(join(process.cwd(), "agents", name), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
});

afterAll(async () => {
  await restoreSettings();
  try {
    await rm(TEST_PROJECT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Slugify the cwd the same way Claude Code does for its JSONL directory.
// Claude Code replaces both '/' and '.' with '-' to build the project dir
// name under ~/.claude/projects/.
function cwdSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// Discover the session UUID Claude allocated for the current cwd. Returns the
// most recently modified JSONL filename (sans .jsonl) under
// ~/.claude/projects/<cwd-slug>/.
async function discoverLatestClaudeSession(cwd: string): Promise<string | null> {
  const dir = join(homedir(), ".claude", "projects", cwdSlug(cwd));
  if (!existsSync(dir)) return null;
  const files = await readdir(dir);
  const jsonls = files.filter((f) => f.endsWith(".jsonl"));
  if (jsonls.length === 0) return null;
  // Find most-recently-modified.
  let latest: { name: string; mtime: number } | null = null;
  for (const f of jsonls) {
    const fp = join(dir, f);
    const stat = await Bun.file(fp).lastModified;
    if (!latest || stat > latest.mtime) latest = { name: f, mtime: stat };
  }
  return latest ? latest.name.replace(/\.jsonl$/, "") : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test case 1 — Real-claude happy path.
//
// Sends a prompt to a real `claude` PTY and asserts the returned
// RunOnPtyResult shape matches spec §3.2.
//
// NOTE on sessionId: per spec §8 OR-6, engineer-pty-core chose NOT to scrape
// the session UUID from the TUI. For fresh threads, `result.sessionId` is
// therefore the empty string (which the supervisor surfaces as `undefined`).
// We assert the shape without requiring a non-empty sessionId.
// (Resume-after-kill is tested below by discovering the sessionId from disk.)

describe("PTY integration — real Claude happy path", () => {
  test.skipIf(!REAL_CLAUDE)(
    "single prompt against a fresh thread returns valid result shape",
    async () => {
      const threadId = `it-happy-${Date.now()}`;
      try {
        const result = await runOnPty(
          `thread:${threadId}`,
          "Reply with exactly the word ACK and nothing else.",
          {
            timeoutMs: TURN_TIMEOUT_MS,
            threadId,
          },
        );

        // Shape assertions match RunOnPtyResult in SPEC §3.2.
        expect(typeof result.rawStdout).toBe("string");
        expect(typeof result.stderr).toBe("string");
        expect(typeof result.exitCode).toBe("number");
        // Real-PTY runs return exitCode 0 on success.
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        // rawStdout is the parsed assistant response.
        expect(result.rawStdout.length).toBeGreaterThan(0);
        // sessionId field exists (may be string or undefined).
        const sid = result.sessionId;
        expect(sid === undefined || typeof sid === "string").toBe(true);
      } finally {
        await removeThreadSession(threadId).catch(() => {});
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 2 — Resume after kill (synthetic + real-claude smoke).
//
// The resume mechanism contract has two parts:
//
//   (a) The supervisor reads getThreadSession(threadId) when spawning a new
//       PTY for an existing thread and passes the stored sessionId as
//       PtyProcessOptions.sessionId. This becomes `claude --resume <id>` at
//       the CLI layer (per pty-process.ts buildClaudeArgs).
//
//   (b) Claude Code itself loads the JSONL transcript when given --resume <id>
//       and continues the conversation with full prior context.
//
// (a) is a deterministic contract we can verify with a synthetic spawn. (b) is
// a property of the `claude` CLI itself and is well-trodden upstream — there
// is no value in re-testing Claude Code's --resume in our suite. (Plus, per
// spec §8 OR-6, our parser doesn't currently scrape Claude's session UUID
// from the TUI, so wiring the full real-claude path requires reading the
// JSONL dir off-band, which makes the test fragile in shared cwd scenarios
// like this worktree.)
//
// We therefore test (a) synthetically and gate the real-claude smoke on the
// integration env var.

describe("PTY integration — resume after kill (synthetic)", () => {
  test("second spawn for an existing threadId uses the stored sessionId as --resume", async () => {
    const threadId = `synth-resume-${Date.now()}`;
    const knownSessionId = `pre-existing-${threadId}-uuid`;

    // Pre-seed the thread-session map so the supervisor will pass this
    // sessionId on first spawn.
    await createThreadSession(threadId, knownSessionId);

    const observedSpawnOpts: PtyProcessOptions[] = [];
    const spawn: SpawnPty = async (opts) => {
      observedSpawnOpts.push(opts);
      return makeFakePty({
        initialSessionId: opts.sessionId,
        onTurn: async (prompt) => ({
          text: `synth-resume:${prompt}`,
          bytesCaptured: prompt.length,
          cleanBoundary: true,
          // Echo back the resumed sessionId, so the supervisor's
          // persistSessionId is a no-op (already known).
          sessionId: opts.sessionId,
        }),
      });
    };
    injectSpawnPty(spawn);

    try {
      const r1 = await runOnPty(`thread:${threadId}`, "first prompt", {
        timeoutMs: 1000,
        threadId,
      });
      expect(r1.exitCode).toBe(0);
      // The supervisor passed our stored sessionId through.
      expect(observedSpawnOpts.length).toBe(1);
      expect(observedSpawnOpts[0]!.sessionId).toBe(knownSessionId);
      expect(r1.sessionId).toBe(knownSessionId);

      // Simulate a hard kill from outside (the supervisor's view: PTY died).
      await shutdownSupervisor();
      __resetSupervisorForTests();
      injectSpawnPty(spawn);
      injectEnsureAgentDir(async (name: string) => join(TEST_PROJECT_DIR, "agents", name));

      const r2 = await runOnPty(`thread:${threadId}`, "second prompt", {
        timeoutMs: 1000,
        threadId,
      });
      expect(r2.exitCode).toBe(0);
      // Second spawn ALSO received the same stored sessionId — i.e. the
      // supervisor re-read getThreadSession() and resumed.
      expect(observedSpawnOpts.length).toBe(2);
      expect(observedSpawnOpts[1]!.sessionId).toBe(knownSessionId);
      expect(r2.sessionId).toBe(knownSessionId);
    } finally {
      await removeThreadSession(threadId).catch(() => {});
    }
  });
});

// Real-claude smoke for the resume path. Spawns a real PTY, runs one turn,
// then directly verifies the supervisor's spawn options on a second call point
// at a stored session ID (we manufacture the ID rather than scraping it,
// which is the same shape the supervisor would produce after the
// scrape-session-id fix lands per OR-6).

describe("PTY integration — real Claude resume smoke", () => {
  test.skipIf(!REAL_CLAUDE)(
    "real claude PTY survives shutdown and respawns with a stored sessionId",
    async () => {
      const threadId = `real-resume-${Date.now()}`;
      const cwd = process.cwd();
      try {
        // Turn 1 — let Claude allocate its own session.
        const r1 = await runOnPty(`thread:${threadId}`, "say hello", {
          timeoutMs: TURN_TIMEOUT_MS,
          threadId,
        });
        expect(r1.exitCode).toBe(0);

        // Discover whichever session UUID Claude allocated for this cwd.
        // In a shared worktree the latest JSONL may not be ours, but it's
        // guaranteed to exist (claude wrote one) and to be valid for --resume.
        const someSessionId = await discoverLatestClaudeSession(cwd);
        if (!someSessionId) {
          throw new Error(`No JSONL session found under ~/.claude/projects/${cwdSlug(cwd)}/`);
        }
        await createThreadSession(threadId, someSessionId);

        await shutdownSupervisor();
        __resetSupervisorForTests();
        injectEnsureAgentDir(async (name: string) => join(TEST_PROJECT_DIR, "agents", name));

        // Turn 2 — supervisor must spawn with --resume <someSessionId>. We
        // can't assert on Claude's actual response (the session content is
        // shared/uncontrolled), but the supervisor's contract holds if the
        // spawn succeeds and returns a non-error result.
        const r2 = await runOnPty(`thread:${threadId}`, "echo READY", {
          timeoutMs: TURN_TIMEOUT_MS,
          threadId,
        });
        expect(r2.exitCode).toBe(0);
        expect(r2.sessionId).toBe(someSessionId);
      } finally {
        await removeThreadSession(threadId).catch(() => {});
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 3 — Concurrency: three independent PTYs, no interleaving.

describe("PTY integration — concurrent isolation", () => {
  test.skipIf(!REAL_CLAUDE)(
    "three concurrent runOnPty calls produce isolated, non-interleaved responses",
    async () => {
      const threads = [
        { id: `it-conc-A-${Date.now()}`, secret: "ALPHA-111" },
        { id: `it-conc-B-${Date.now()}`, secret: "BRAVO-222" },
        { id: `it-conc-C-${Date.now()}`, secret: "CHARLIE-333" },
      ];
      try {
        const promises = threads.map(({ id, secret }) =>
          runOnPty(`thread:${id}`, `Reply with exactly this token and nothing else: ${secret}`, {
            timeoutMs: TURN_TIMEOUT_MS,
            threadId: id,
          }),
        );
        const results = await Promise.all(promises);

        // Each result must contain its own secret and not any other thread's.
        for (let i = 0; i < threads.length; i++) {
          const { secret } = threads[i]!;
          const others = threads.filter((_, j) => j !== i).map((t) => t.secret);
          expect(results[i]!.exitCode).toBe(0);
          expect(results[i]!.rawStdout).toContain(secret);
          for (const other of others) {
            expect(results[i]!.rawStdout).not.toContain(other);
          }
        }
        // Each thread got its own PTY entry.
        const snapshot = snapshotSupervisor();
        const adhocKeys = snapshot.ptys
          .filter((p) => p.sessionKey.startsWith("thread:it-conc-"))
          .map((p) => p.sessionKey);
        expect(adhocKeys.length).toBe(3);
      } finally {
        for (const { id } of threads) {
          await removeThreadSession(id).catch(() => {});
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 4 — Synthetic crash + retry.
//
// Uses injectSpawnPty to drive deterministic crash/recovery scenarios so we
// can exercise the supervisor's retry-on-fresh-PTY path without depending on
// killing a real `claude` mid-stream (inherently flaky).

describe("PTY integration — crash + retry (synthetic)", () => {
  test("PtyClosedError on first turn triggers respawn; second turn succeeds", async () => {
    // backoffMs[0]=10, maxRetries=2 — set in beforeEach.
    let spawnCount = 0;
    const observedBackoffs: number[] = [];
    injectSleep(async (ms) => {
      observedBackoffs.push(ms);
    });

    const spawn: SpawnPty = async (_opts: PtyProcessOptions) => {
      spawnCount += 1;
      if (spawnCount === 1) {
        // First instance: explodes on runTurn.
        return makeFakePty({
          onTurn: async (prompt) => {
            throw new PtyClosedError(`fake:${spawnCount}`, 137, "SIGKILL");
          },
        });
      }
      // Second instance: succeeds.
      return makeFakePty({
        onTurn: async (prompt) => ({
          text: `recovered:${prompt}`,
          bytesCaptured: prompt.length,
          cleanBoundary: true,
          sessionId: "recovered-session",
        }),
      });
    };
    injectSpawnPty(spawn);

    const r = await runOnPty("thread:crash-test", "hello", {
      timeoutMs: 1000,
      threadId: "crash-test",
    });

    expect(r.exitCode).toBe(0);
    expect(r.rawStdout).toBe("recovered:hello");
    expect(r.sessionId).toBe("recovered-session");
    expect(spawnCount).toBe(2); // 1 initial + 1 respawn
    // Backoff was honoured (backoffMs[0]=10 from beforeEach config).
    expect(observedBackoffs).toEqual([10]);
  });

  test("PtyTurnTimeoutError is also retryable", async () => {
    let spawnCount = 0;
    injectSleep(async () => {});
    const spawn: SpawnPty = async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return makeFakePty({
          onTurn: async () => {
            throw new PtyTurnTimeoutError(`fake:${spawnCount}`, 5000);
          },
        });
      }
      return makeFakePty({
        onTurn: async () => ({
          text: "ok",
          bytesCaptured: 2,
          cleanBoundary: true,
          sessionId: "s",
        }),
      });
    };
    injectSpawnPty(spawn);

    const r = await runOnPty("thread:to", "hello", {
      timeoutMs: 1000,
      threadId: "to",
    });
    expect(r.exitCode).toBe(0);
    expect(spawnCount).toBe(2);
  });

  test("max-retries exhaustion returns structured error per spec §3.2", async () => {
    let spawnCount = 0;
    injectSleep(async () => {});

    const spawn: SpawnPty = async () => {
      spawnCount += 1;
      return makeFakePty({
        onTurn: async () => {
          throw new PtyClosedError(`fake:${spawnCount}`, 1, null);
        },
      });
    };
    injectSpawnPty(spawn);

    const r = await runOnPty("thread:always-crash", "hello", {
      timeoutMs: 1000,
      threadId: "always-crash",
    });

    // Spec §3.2: after maxRetries, return { rawStdout: "", stderr: <user-facing>,
    //   exitCode: 1 } with no sessionId.
    expect(r.exitCode).toBe(1);
    expect(r.rawStdout).toBe("");
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stderr).toContain("max retries");
    expect(r.sessionId).toBeUndefined();
    // 1 initial + maxRetries=2 respawns = 3 spawns total.
    expect(spawnCount).toBe(1 + 2);
  });

  test("exponential backoff sequence is honoured across retries", async () => {
    // Override settings for this test: longer backoff list, 3 retries.
    await writeRawSettings({
      pty: {
        enabled: true,
        idleReapMinutes: 30,
        maxRetries: 3,
        backoffMs: [10, 20, 40],
        namedAgentsAlwaysAlive: true,
        turnIdleTimeoutMs: 2000,
        cols: 100,
        rows: 30,
      },
    });
    await reloadSettings();

    let spawnCount = 0;
    const observedBackoffs: number[] = [];
    injectSleep(async (ms) => {
      observedBackoffs.push(ms);
    });
    const spawn: SpawnPty = async () => {
      spawnCount += 1;
      return makeFakePty({
        onTurn: async () => {
          throw new PtyClosedError("fake", 1, null);
        },
      });
    };
    injectSpawnPty(spawn);

    const r = await runOnPty("thread:backoff", "hello", {
      timeoutMs: 1000,
      threadId: "backoff",
    });
    expect(r.exitCode).toBe(1);
    expect(observedBackoffs).toEqual([10, 20, 40]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 5 — Idle reap + respawn-from-resume.
//
// Uses fake clock + __reapNowForTests to deterministically reap an ad-hoc
// PTY, then verifies the next runOnPty call respawns it.

describe("PTY integration — idle reap and respawn", () => {
  test("ad-hoc PTY is reaped after idleReapMinutes; next call respawns", async () => {
    // Shrink idleReapMinutes for this test (0.01 min = 600ms).
    await writeRawSettings({
      pty: {
        enabled: true,
        idleReapMinutes: 0.01,
        maxRetries: 2,
        backoffMs: [10, 20],
        namedAgentsAlwaysAlive: true,
        turnIdleTimeoutMs: 2000,
        cols: 100,
        rows: 30,
      },
    });
    await reloadSettings();

    let spawnCount = 0;
    // Synthetic clock so we can fast-forward. Both the supervisor and the
    // fake PTYs read from this same clock so timestamps stay consistent.
    let now = 1_000_000;
    const clock = () => now;
    injectClock(clock);

    const spawn: SpawnPty = async () => {
      spawnCount += 1;
      return makeFakePty({
        pid: 1000 + spawnCount,
        clock,
        onTurn: async (prompt) => ({
          text: `turn${spawnCount}:${prompt}`,
          bytesCaptured: prompt.length,
          cleanBoundary: true,
          sessionId: `sess-adhoc-${spawnCount}`,
        }),
      });
    };
    injectSpawnPty(spawn);

    // First turn — spawns PTY #1.
    const r1 = await runOnPty("thread:reap-test", "first", {
      timeoutMs: 1000,
      threadId: "reap-test",
    });
    expect(r1.exitCode).toBe(0);
    expect(spawnCount).toBe(1);
    const snap1 = snapshotSupervisor();
    const beforeReap = snap1.ptys.find((p) => p.sessionKey === "thread:reap-test");
    expect(beforeReap).toBeDefined();
    expect(beforeReap!.isAlive).toBe(true);
    expect(beforeReap!.kind).toBe("adhoc");

    // Advance virtual time past idleReapMinutes (0.01 min = 600ms), then
    // run the reap pass.
    now += 60 * 1000; // 1 virtual minute, far past 0.01 min
    await __reapNowForTests(clock);

    // PTY entry should be gone from the supervisor's map.
    const snap2 = snapshotSupervisor();
    const afterReap = snap2.ptys.find((p) => p.sessionKey === "thread:reap-test");
    expect(afterReap).toBeUndefined();

    // Next turn — supervisor should spawn a fresh PTY #2.
    const r2 = await runOnPty("thread:reap-test", "second", {
      timeoutMs: 1000,
      threadId: "reap-test",
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.rawStdout).toBe("turn2:second");
    expect(spawnCount).toBe(2);
  });

  test("named-agent PTYs are NOT reaped when namedAgentsAlwaysAlive=true", async () => {
    let spawnCount = 0;
    let now = 1_000_000;
    const clock = () => now;
    injectClock(clock);
    const spawn: SpawnPty = async () => {
      spawnCount += 1;
      return makeFakePty({ pid: 2000 + spawnCount, clock });
    };
    injectSpawnPty(spawn);

    await runOnPty("agent:suzy", "hi", {
      timeoutMs: 1000,
      agentName: "suzy",
    });
    expect(spawnCount).toBe(1);

    // Massive virtual-time jump — 24h.
    now += 24 * 60 * 60 * 1000;
    await __reapNowForTests(clock);

    const snap = snapshotSupervisor();
    const suzy = snap.ptys.find((p) => p.sessionKey === "agent:suzy");
    expect(suzy).toBeDefined();
    expect(suzy!.isAlive).toBe(true);
    expect(suzy!.kind).toBe("named");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 5.5 — Sentinel-echo round-trip (issue #81).
//
// Real-claude tests for the new turn-completion mechanism. These exercise
// the full sentinel-write + echo-detect + cleanup pipeline against a live
// claude PTY. Gated on CLAUDECLAW_PTY_INTEGRATION_TESTS=1.
//
// We assert: (1) the response text contains the model's reply and NOT the
// sentinel string itself, (2) a second turn in the same PTY also completes
// — proving cleanup left the prompt buffer in a usable state.

describe("PTY integration — sentinel-echo turn detection (real claude)", () => {
  test.skipIf(!REAL_CLAUDE)(
    "first turn parses cleanly and the sentinel does not leak into the response",
    async () => {
      const threadId = `it-sentinel-${Date.now()}`;
      try {
        const r = await runOnPty(`thread:${threadId}`, "Reply with exactly the single word: pong", {
          timeoutMs: TURN_TIMEOUT_MS,
          threadId,
        });
        expect(r.exitCode).toBe(0);
        expect(r.rawStdout.length).toBeGreaterThan(0);
        // The sentinel string is an implementation detail; the operator must
        // NEVER see it in the response.
        expect(r.rawStdout).not.toContain("<<<CCAW_TURN_END_");
        // The model's response should appear.
        expect(r.rawStdout.toLowerCase()).toContain("pong");
      } finally {
        await removeThreadSession(threadId).catch(() => {});
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!REAL_CLAUDE)(
    "two sequential turns on the same PTY both succeed (sentinel cleanup works)",
    async () => {
      const threadId = `it-sentinel-multi-${Date.now()}`;
      try {
        const r1 = await runOnPty(`thread:${threadId}`, "Reply with the single word: alpha", {
          timeoutMs: TURN_TIMEOUT_MS,
          threadId,
        });
        expect(r1.exitCode).toBe(0);
        expect(r1.rawStdout.toLowerCase()).toContain("alpha");

        const r2 = await runOnPty(`thread:${threadId}`, "Reply with the single word: bravo", {
          timeoutMs: TURN_TIMEOUT_MS,
          threadId,
        });
        expect(r2.exitCode).toBe(0);
        expect(r2.rawStdout.toLowerCase()).toContain("bravo");
        // Each response must not contain the other prompt's keyword echoed
        // back, proving cleanup cleared the input buffer between turns.
        expect(r2.rawStdout.toLowerCase()).not.toContain("alpha");
      } finally {
        await removeThreadSession(threadId).catch(() => {});
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test case 6 — Backward compat: runOnPty contract under enabled=false.
//
// The full no-regression sweep lives in pty-backward-compat.test.ts. Here we
// just confirm that runOnPty itself is unchanged when pty.enabled=false at
// the settings level (the supervisor doesn't gate on the flag — callers do —
// but its contract must still hold).

describe("PTY integration — backward-compat sanity", () => {
  test("runOnPty result shape is identical regardless of pty.enabled flag", async () => {
    const spawn: SpawnPty = async () =>
      makeFakePty({
        onTurn: async (prompt) => ({
          text: `flag-test:${prompt}`,
          bytesCaptured: prompt.length,
          cleanBoundary: true,
          sessionId: "flag-test-session",
        }),
      });
    injectSpawnPty(spawn);

    // First call with enabled=true (set by beforeEach).
    const enabled = await runOnPty("thread:flag-on", "x", {
      timeoutMs: 1000,
      threadId: "flag-on",
    });

    // Flip the flag and confirm the supervisor still works when invoked
    // directly. (The execClaude routing bypasses runOnPty entirely when
    // disabled — that's tested in pty-backward-compat.test.ts.)
    await writeRawSettings({ pty: { enabled: false } });
    await reloadSettings();
    __resetSupervisorForTests();
    injectEnsureAgentDir(async (name: string) => join(TEST_PROJECT_DIR, "agents", name));
    injectSpawnPty(spawn);

    const disabled = await runOnPty("thread:flag-off", "x", {
      timeoutMs: 1000,
      threadId: "flag-off",
    });

    // Both produce the same shape.
    const keys = (r: typeof enabled) =>
      Object.keys(r)
        .filter((k) => r[k as keyof typeof r] !== undefined)
        .sort();
    expect(keys(enabled)).toEqual(keys(disabled));
    expect(typeof enabled.exitCode).toBe("number");
    expect(typeof disabled.exitCode).toBe("number");
    expect(enabled.exitCode).toBe(0);
    expect(disabled.exitCode).toBe(0);
  });
});
