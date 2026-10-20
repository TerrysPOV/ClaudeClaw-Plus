/**
 * PTY integration against a REAL `claude` — nightly job, not the PR job (#304).
 *
 * These five tests need a working `claude` binary and credentials. They used
 * to sit in `src/__tests__/pty-integration.test.ts` behind
 * `test.skipIf(!CLAUDECLAW_PTY_INTEGRATION_TESTS)`, which meant the PR job
 * reported them green without running them — the exact shape that let PR
 * #290's hanging tests through. They now run un-gated from
 * `.github/workflows/integration.yml` (nightly + on demand), where a failure
 * is red and visible, and they stay OUT of `src/` so `bun test src` — the PR
 * job — never sees them.
 *
 * Run locally: `bun test tests/integration` with `claude` on PATH and logged in.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink, rm, readdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";

import { initConfig, loadSettings, reloadSettings } from "../../src/config";
import {
  injectEnsureAgentDir,
  resetClock,
  resetSleep,
  injectIsSessionResumable,
  __resetSupervisorForTests,
  runOnPty,
  shutdownSupervisor,
  snapshotSupervisor,
} from "../../src/runner/pty-supervisor";
import { createThreadSession, removeThreadSession } from "../../src/sessionManager";
import { encodeCwdForProjectsDir } from "../../src/bus/jsonl-line-types";
import { seedClaudeOnboarding, unseedClaudeOnboarding } from "./claude-onboarding";

// Per-turn timeout passed to runTurn. Real Claude can take 30-60s for a cold
// turn (model warmup, MCP attach, tool resolution); 120s is the operator
// default in settings.timeouts.* too.
const TURN_TIMEOUT_MS = 120_000;
// Outer per-test timeout headroom — covers spawn + multi-turn + reap delays.
const TEST_TIMEOUT_MS = TURN_TIMEOUT_MS * 3 + 60_000;
const TEST_PROJECT_DIR = join("/tmp", `claudeclaw-pty-live-${process.pid}`);

// Per-test settings backup/restore so we can tweak pty.* without corrupting
// the developer's working settings.json.
const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
// Unique per run, so a backup left by an interrupted run is never mistaken
// for ours (and ours never overwrites it).
const BACKUP_FILE = join(SETTINGS_DIR, `settings.json.pty-live-backup-${process.pid}`);

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
}

let backedUp = false;

let hadSettingsFile = false;

async function backupSettings(): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  hadSettingsFile = existsSync(SETTINGS_FILE);
  if (hadSettingsFile) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
    backedUp = true;
  }
}

/** Put the settings file back exactly as found: restored from the backup,
 *  or removed when there was none. */
async function restoreSettings(): Promise<void> {
  if (backedUp && existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
    backedUp = false;
  } else if (!hadSettingsFile) {
    await rm(SETTINGS_FILE, { force: true }).catch(() => undefined);
  }
}

beforeAll(async () => {
  seedClaudeOnboarding();
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
  // Issue #89: stub the resumability probe so tests that pre-seed
  // session.json don't get them treated as phantoms (the probe checks
  // for a `.jsonl` on disk under claude's projects dir, which fake-PTY
  // tests never create). Tests that exercise the phantom path override
  // this with their own stub.
  injectIsSessionResumable(async () => true);
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
  unseedClaudeOnboarding();
  try {
    await rm(TEST_PROJECT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Slugify the cwd the same way Claude Code does for its JSONL directory —
// through the one encoder production uses (#368), so this helper cannot pass
// while production resolves to a directory that does not exist.
function cwdSlug(cwd: string): string {
  return encodeCwdForProjectsDir(cwd);
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

describe("PTY integration — real Claude happy path", () => {
  test(
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

describe("PTY integration — real Claude resume smoke", () => {
  test(
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

describe("PTY integration — concurrent isolation", () => {
  test(
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

describe("PTY integration — sentinel-echo turn detection (real claude)", () => {
  test(
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

  test(
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
