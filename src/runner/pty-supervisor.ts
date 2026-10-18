/**
 * pty-supervisor.ts — owns the lifecycle of N+M long-lived `claude` PTYs.
 *
 * Public contract: SPEC.md §3.2 (frozen, do not change exported types).
 *
 * Design decisions for this implementation (operator-locked, see SPEC §3.2 and
 * the parent plan):
 *
 *   - OR-5 (named-agent spawn strategy): **LAZY**. Named-agent PTYs are spawned
 *     on the first event for that agent, not at initSupervisor(). The
 *     `namedAgentsAlwaysAlive` flag still governs post-spawn behaviour — named
 *     agents are never reaped once alive. This keeps daemon startup fast and
 *     simplifies the supervisor (no eager enumerate-agents-dir pass).
 *
 *   - PTY-supervisor is decoupled from engineer-pty-core's worktree via the
 *     `injectSpawnPty` / `injectClock` test seams. At runtime the supervisor
 *     dynamically imports the real `spawnPty` from `./pty-process` on first
 *     use; in tests, a fake `spawnPty` is injected before any `runOnPty` call.
 *
 *   - One write-lock per sessionKey enforces sequential `runTurn` invocations
 *     on the same PTY (per the §3.1 concurrency contract). Different keys
 *     proceed in parallel.
 *
 *   - Crash-respawn-replay: on PtyClosedError or PtyTurnTimeoutError, the
 *     supervisor disposes the dead PTY, sleeps `backoffMs[i]`, respawns
 *     (via cached spawn options + last-known sessionId for --resume), and
 *     retries the SAME prompt up to `maxRetries` times (outer loop). Each
 *     outer retry first tries to respawn the PTY up to `respawnRetries`
 *     times (inner loop — issue #175). If the inner loop is exhausted the
 *     outer loop terminates early with a "respawn failed after N attempts"
 *     error rather than consuming the remaining outer budget. After
 *     exhaustion the supervisor surfaces a structured error in
 *     RunOnPtyResult.stderr and exitCode=1; execClaude treats this as any
 *     other non-zero exit.
 *
 *   - Settings are re-read via getSettings() on every call — never cached
 *     across calls — so hot-reload works. The reap interval is rebuilt
 *     whenever initSupervisor() is called with a new idleReapMinutes.
 *
 *   - Phase D fix #5 (FA-3a): `settings.pty.maxConcurrent` (default 32) caps
 *     the number of concurrent live PTYs. On overflow, the LRU AD-HOC PTY is
 *     evicted (disposed + entry removed). Named agents are exempt — they're
 *     the operator-configured slate and shouldn't shrink under thread burst.
 *
 *   - Phase D fix #4 (FA-6a): `killAllPtys()` is exposed so `runner.ts:
 *     killActive()` (the `/kill` command) can dispose every live PTY. The
 *     in-flight turn surfaces a `PtyClosedError`, mirroring how `/kill`
 *     behaves against legacy `Bun.spawn` subprocesses. Session IDs survive
 *     on disk via the Claude Code JSONL; the next event for the same key
 *     re-spawns and `--resume`s.
 */
// #72 item 9: normalise ESM `.js` extensions on every relative import.
// The mcp-multiplexer/* files use them; pre-cleanup the runner/* files
// used bare specifiers. Both work under `moduleResolution: bundler`, but
// mixing forms makes greps lie and risks breakage if we ever flip to
// `moduleResolution: nodenext` (which requires the extension).
import type { PtyProcess, PtyProcessOptions, PtyTurnResult, SpawnPty } from "./pty-process.js";
import { PtyClosedError, PtyTurnTimeoutError } from "./pty-process.js";
import { ensureTrustAccepted } from "./pty-trust-prompt.js";
import type { OneShotRequest, OneShotResult } from "../oneshot/engine.js";
import { trustedToolFlags, validateIsolation } from "../oneshot/isolation.js";
import { validateRouteEngine } from "../oneshot/config.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, type SecurityConfig } from "../config.js";
import { getSession, createSession } from "../sessions.js";
import { getThreadSession, createThreadSession } from "../sessionManager.js";
import {
  writeConfigForPty,
  deleteConfigForPty,
  type PtyIdentity,
  type SharedServerEntry,
  type PerPtyServerEntry,
} from "./pty-mcp-config-writer.js";

// Lazy import for `ensureAgentDir` to avoid the circular-import hazard
// (runner.ts imports this module to route into the supervisor; importing
// runner.ts at module load time would observe a partially-initialised
// module). We resolve the symbol on first agent-PTY spawn.
type EnsureAgentDirFn = (name: string) => Promise<string>;
let _ensureAgentDir: EnsureAgentDirFn | null = null;
async function ensureAgentDirLazy(name: string): Promise<string> {
  if (!_ensureAgentDir) {
    const mod = (await import("../runner")) as { ensureAgentDir?: EnsureAgentDirFn };
    if (!mod.ensureAgentDir) {
      throw new Error("[pty-supervisor] runner.ts does not export ensureAgentDir");
    }
    _ensureAgentDir = mod.ensureAgentDir;
  }
  return _ensureAgentDir(name);
}

/** For tests only. Stub the agent-dir resolver. */
export function injectEnsureAgentDir(fn: EnsureAgentDirFn | null): void {
  _ensureAgentDir = fn;
}

// ─── MCP multiplexer integration seam (SPEC §4.3 §4.5) ───────────────────────
// The MCP multiplexer plugin (W1, src/plugins/mcp-multiplexer/) mints
// per-PTY identities and routes shared MCP-server calls over local HTTP.
// The supervisor only needs two operations from it: issue an identity for a
// new PTY and revoke it on dispose. The full plugin doesn't exist in W2's
// worktree, so this seam stays an optional dependency: when no issuer is
// wired, the synthesis path simply doesn't fire and PTY behaviour is
// byte-identical to today (matches the SPEC §6.1 dormant-multiplexer
// contract from the perspective of the supervisor).
//
// At daemon startup (production), commands/start.ts calls
// `injectMcpIdentityIssuer({ issue, revoke })` after the multiplexer plugin
// starts. The issuer is opaque here — the supervisor only ever asks for
// (ptyId) → PtyIdentity and (ptyId) → void.

/** Function that returns a per-PTY identity (HMAC bearer header included). */
export type McpIdentityIssuer = (ptyId: string) => PtyIdentity;
/** Function that releases the per-PTY identity and any associated bridge
 *  session state. Called from the supervisor's dispose paths. Safe to call
 *  for an unknown ptyId (idempotent). */
export type McpIdentityRevoker = (ptyId: string) => void | Promise<void>;
/** Returns the multiplexer's HTTP listener base URL. Single source of truth —
 *  the supervisor uses this when synthesising `--mcp-config` so the URL never
 *  drifts from what the multiplexer plugin actually bound. */
export type McpBridgeBaseUrlGetter = () => string;

let _mcpIssueIdentity: McpIdentityIssuer | null = null;
let _mcpRevokeIdentity: McpIdentityRevoker | null = null;
let _mcpBridgeBaseUrl: McpBridgeBaseUrlGetter | null = null;

/** Wire the multiplexer plugin's identity functions. Called once at daemon
 *  startup (after the plugin's `.start()` returns) and by tests via the
 *  injectMcpIdentityIssuer test seam. Passing `null` for any function
 *  disables the corresponding synthesis path. */
export function injectMcpIdentityIssuer(opts: {
  issue?: McpIdentityIssuer | null;
  revoke?: McpIdentityRevoker | null;
  bridgeBaseUrl?: McpBridgeBaseUrlGetter | null;
}): void {
  if (opts.issue !== undefined) _mcpIssueIdentity = opts.issue;
  if (opts.revoke !== undefined) _mcpRevokeIdentity = opts.revoke;
  if (opts.bridgeBaseUrl !== undefined) _mcpBridgeBaseUrl = opts.bridgeBaseUrl;
}

// Lazy imports of the canonical env-sanitiser + security-args builder +
// child-env shim from runner.ts (same circular-import dance as
// ensureAgentDir). Phase D fixes #1 / #3 and Codex Phase D #1: keep one
// source of truth for the strip list, the permission-mode argv, AND the
// provider env so the PTY path can't silently diverge from `claude -p`
// policy.
type CleanSpawnEnvFn = () => Record<string, string>;
type BuildSecurityArgsFn = (security: SecurityConfig) => string[];
type BuildChildEnvFn = (
  baseEnv: Record<string, string>,
  model: string,
  api: string,
) => Record<string, string>;
let _cleanSpawnEnv: CleanSpawnEnvFn | null = null;
let _buildSecurityArgs: BuildSecurityArgsFn | null = null;
let _buildChildEnv: BuildChildEnvFn | null = null;
async function getRunnerHelpers(): Promise<{
  cleanSpawnEnv: CleanSpawnEnvFn;
  buildSecurityArgs: BuildSecurityArgsFn;
  buildChildEnv: BuildChildEnvFn;
}> {
  if (_cleanSpawnEnv && _buildSecurityArgs && _buildChildEnv) {
    return {
      cleanSpawnEnv: _cleanSpawnEnv,
      buildSecurityArgs: _buildSecurityArgs,
      buildChildEnv: _buildChildEnv,
    };
  }
  const mod = (await import("../runner")) as {
    cleanSpawnEnv?: CleanSpawnEnvFn;
    buildSecurityArgs?: BuildSecurityArgsFn;
    buildChildEnv?: BuildChildEnvFn;
  };
  if (!mod.cleanSpawnEnv) {
    throw new Error("[pty-supervisor] runner.ts does not export cleanSpawnEnv");
  }
  if (!mod.buildSecurityArgs) {
    throw new Error("[pty-supervisor] runner.ts does not export buildSecurityArgs");
  }
  if (!mod.buildChildEnv) {
    throw new Error("[pty-supervisor] runner.ts does not export buildChildEnv");
  }
  _cleanSpawnEnv = _cleanSpawnEnv ?? mod.cleanSpawnEnv;
  _buildSecurityArgs = _buildSecurityArgs ?? mod.buildSecurityArgs;
  _buildChildEnv = _buildChildEnv ?? mod.buildChildEnv;
  return {
    cleanSpawnEnv: _cleanSpawnEnv,
    buildSecurityArgs: _buildSecurityArgs,
    buildChildEnv: _buildChildEnv,
  };
}
async function getCleanSpawnEnv(): Promise<CleanSpawnEnvFn> {
  const h = await getRunnerHelpers();
  return h.cleanSpawnEnv;
}

/** For tests only. Stub the runner helpers (cleanSpawnEnv + buildSecurityArgs
 *  + buildChildEnv). */
export function injectRunnerHelpers(opts: {
  cleanSpawnEnv?: CleanSpawnEnvFn | null;
  buildSecurityArgs?: BuildSecurityArgsFn | null;
  buildChildEnv?: BuildChildEnvFn | null;
}): void {
  if (opts.cleanSpawnEnv !== undefined) _cleanSpawnEnv = opts.cleanSpawnEnv;
  if (opts.buildSecurityArgs !== undefined) _buildSecurityArgs = opts.buildSecurityArgs;
  if (opts.buildChildEnv !== undefined) _buildChildEnv = opts.buildChildEnv;
}

/** Back-compat shim — fix #1's test used this name. Same behaviour. */
export function injectCleanSpawnEnv(fn: CleanSpawnEnvFn | null): void {
  _cleanSpawnEnv = fn;
}

let ensureTrust: (cwd: string) => Promise<unknown> = ensureTrustAccepted;
/** Keep unit tests from changing the operator's Claude trust configuration. */
export function injectOneShotTrustForTests(fn: ((cwd: string) => Promise<unknown>) | null): void {
  ensureTrust = fn ?? ensureTrustAccepted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — frozen by SPEC §3.2.

export interface SupervisorOptions {
  idleReapMinutes: number;
  maxRetries: number;
  /** Inner retry budget for `respawnEntry()` after a retryable `runTurn`
   *  failure. Issue #175. */
  respawnRetries: number;
  backoffMs: number[];
  namedAgentsAlwaysAlive: boolean;
}

export interface RunOnPtyResult {
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
}

/**
 * Where a PTY resumes its conversation id from and saves it to (#546). The
 * default store is picked from the entry's ids (thread / agent / global); the
 * rate-limit fallback passes its own so it never resumes the primary transcript.
 */
export interface PtySessionStore {
  load(): Promise<string | undefined>;
  save(sessionId: string): Promise<void>;
}

/**
 * How a `runOnPty` call owns its PTY (#546). Read when the entry for the key is
 * created; a later call on the same key reuses the entry as it is.
 */
export interface PtyRunScope {
  /** Session store override. Default: thread / agent / global, from the ids. */
  sessionStore?: PtySessionStore;
  /** One-shot run: fresh session, nothing persisted, no turn retry, PTY retired
   *  when the call returns. Outside the `maxConcurrent` cap, LRU eviction and
   *  the idle reaper — the call itself bounds its life. */
  ephemeral?: boolean;
  /** Not reached by `/kill` (`killAllPtys`, `supervisorEntryCount`). */
  survivesKill?: boolean;
  /** Working directory. Default: the agent dir, else `process.cwd()`. */
  cwd?: string;
  /** Caller-owned MCP config: when set, `path` is passed as `--mcp-config`
   *  (or, undefined, no flag at all) — never synthesized, rotated or released
   *  by the supervisor. */
  mcpConfig?: { path: string | undefined };
  /** Ephemeral runs only: resume this conversation (`oneShot` `resumeSessionId`).
   *  Used as given, without the resumability probe: a conversation that does not
   *  exist must fail the call, not quietly start a different one. */
  resumeSessionId?: string;
  /** One-shot isolation, forwarded to the spawned PTY. `untrusted` also skips
   *  trust self-healing (the cwd is a throwaway directory). */
  isolation?: "untrusted" | "trusted-session";
}

export interface SupervisorSnapshot {
  ptys: Array<{
    sessionKey: string;
    label: string;
    pid: number;
    sessionId: string;
    cwd: string;
    isAlive: boolean;
    lastTurnEndedAt: number;
    /** "named" → never reaped when `namedAgentsAlwaysAlive` is on; "adhoc"/"global" → reaped after idle. */
    kind: "named" | "adhoc" | "global";
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test seams.

let _spawnPty: SpawnPty | null = null;
let _clock: () => number = () => Date.now();
let _sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms));
/** Injectable UUID generator. Used to pre-allocate a session ID for fresh
 *  PTY spawns so the conversation survives daemon restart. Phase D fix
 *  (Codex HIGH #2). */
let _newSessionId: () => string = () => crypto.randomUUID();

/**
 * Issue #89: tells the supervisor whether `claude --resume <sessionId>`
 * has a chance of succeeding for a given `(cwd, sessionId)` pair. claude
 * persists each conversation as `~/.claude/projects/<mangled-cwd>/<id>.jsonl`
 * — the directory may be created at spawn but the JSONL is only written
 * once claude has actually logged a turn. If the JSONL is absent, the
 * sessionId is a phantom (eager pre-allocation from a PTY whose first
 * turn failed) and `--resume` will exit 1 with "No conversation found".
 *
 * The mangling rule is the one `encodeCwdForProjectsDir` implements (#368):
 * every non-alphanumeric character becomes `-`, and a name past 200
 * characters is truncated and suffixed with a hash of the original cwd.
 * `/home/claw/project` → `-home-claw-project`. claude does this in its own
 * filesystem layout and we match it through that one encoder.
 *
 * Injectable so tests can stub the filesystem layer.
 */
let _isSessionResumable: (cwd: string, sessionId: string) => Promise<boolean> = async (
  cwd,
  sessionId,
) => {
  try {
    const { homedir } = await import("node:os");
    const { resolve: resolvePath } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { encodeCwdForProjectsDir } = await import("../bus/jsonl-line-types");
    const mangled = encodeCwdForProjectsDir(resolvePath(cwd)); // #368
    const jsonlPath = resolvePath(homedir(), ".claude", "projects", mangled, `${sessionId}.jsonl`);
    return existsSync(jsonlPath);
  } catch {
    // Fail-closed: if anything goes wrong probing the filesystem, treat
    // the session as non-resumable. We'd rather lose one turn's continuity
    // than surface "max retries exhausted" to the user.
    return false;
  }
};

/** For tests only. Inject a deterministic resumability check. */
export function injectIsSessionResumable(
  fn: ((cwd: string, sessionId: string) => Promise<boolean>) | null,
): void {
  _isSessionResumable =
    fn ??
    (async (cwd, sessionId) => {
      try {
        const { homedir } = await import("node:os");
        const { resolve: resolvePath } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const { encodeCwdForProjectsDir } = await import("../bus/jsonl-line-types");
        const mangled = encodeCwdForProjectsDir(resolvePath(cwd)); // #368
        const jsonlPath = resolvePath(
          homedir(),
          ".claude",
          "projects",
          mangled,
          `${sessionId}.jsonl`,
        );
        return existsSync(jsonlPath);
      } catch {
        return false;
      }
    });
}

/** For tests only. Inject a fake spawnPty before any runOnPty call. */
export function injectSpawnPty(fn: SpawnPty | null): void {
  _spawnPty = fn;
}

/** For tests only. Inject a deterministic clock. */
export function injectClock(fn: () => number): void {
  _clock = fn;
}

export function resetClock(): void {
  _clock = () => Date.now();
}

/** For tests only. Inject a deterministic sleep (so backoff delays don't
 *  consume wall-clock time in unit tests). */
export function injectSleep(fn: (ms: number) => Promise<void>): void {
  _sleep = fn;
}

export function resetSleep(): void {
  _sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));
}

/** For tests only. Inject a deterministic UUID generator so fresh-session
 *  persistence can be pinned without randomness. */
export function injectNewSessionId(fn: (() => string) | null): void {
  _newSessionId = fn ?? (() => crypto.randomUUID());
}

/**
 * For tests only. Force one reap pass using the caller-supplied clock.
 * Bypasses the timer cadence so tests can advance fake time arbitrarily.
 */
export async function __reapNowForTests(clock?: () => number): Promise<void> {
  if (clock) injectClock(clock);
  const opts = readSupervisorOptions();
  await reapIdle(opts);
}

/** For tests only. Inspect the lazy-init flag.
 *  Returns true iff `initSupervisor()` has run (and `shutdownSupervisor` /
 *  `__resetSupervisorForTests` haven't cleared it since). */
export function __isSupervisorInitialisedForTests(): boolean {
  return state.initialised;
}

/** For tests only. Wipe all internal state. */
export function __resetSupervisorForTests(): void {
  for (const entry of state.ptys.values()) {
    try {
      void entry.pty?.dispose();
    } catch {
      // ignore
    }
    // Release multiplexer identity + delete synthesized config (SPEC §4.5).
    // Fire-and-forget — __resetSupervisorForTests is synchronous and tests
    // don't await it.
    void releaseMcpIdentityFor(entry);
  }
  state.ptys.clear();
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  state.initialised = false;
  state.shuttingDown = false;
  _initPromise = null;
  _admissionLock = Promise.resolve();
  _spawnPty = null;
  _ensureAgentDir = null;
  _cleanSpawnEnv = null;
  _buildSecurityArgs = null;
  _buildChildEnv = null;
  _maxConcurrentOverride = null;
  _maxRetriesOverride = null;
  _respawnRetriesOverride = null;
  _newSessionId = () => crypto.randomUUID();
  _mcpIssueIdentity = null;
  _mcpRevokeIdentity = null;
  _mcpBridgeBaseUrl = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state.

type SessionKind = "named" | "adhoc" | "global";

interface PtyEntry {
  sessionKey: string;
  kind: SessionKind;
  threadId?: string;
  agentName?: string;
  /** May be null while a spawn-or-respawn is in flight. */
  pty: PtyProcess | null;
  /** Cached options used for the most recent spawn — reused when respawning
   *  after a crash. Never null once the first spawn has been attempted. */
  spawnOpts: PtyProcessOptions | null;
  /** Per-key serial lock. The promise resolves once the in-flight turn finishes. */
  lock: Promise<void>;
  /** Last time `runOnPty` was called against this key. Drives LRU eviction
   *  when `pty.maxConcurrent` is hit. Adhoc-only — named agents are exempt. */
  lastAccessedAt: number;
  /** The first-turn spawn — or, since #385, a crash-recovery respawn — while it
   *  is still running. A caller that abandons the
   *  spawn on its own deadline leaves this behind, so the next caller on the key
   *  awaits the SAME spawn instead of starting a second one. Two spawns on one
   *  entry would each set `entry.pty`, orphaning whichever landed first — a
   *  claude process plus its MCP fleet with no path to `dispose()`, since only
   *  the entry is tracked in `state.ptys`. Cleared once the spawn settles, so a
   *  failed spawn can be retried by a later turn. */
  spawnInFlight?: Promise<void>;
  /** Set — synchronously, before any await — by the removal path that is
   *  retiring this entry (reap, LRU eviction, `/kill`, shutdown); resolves once
   *  the PTY is disposed, the MCP identity released and the entry out of the
   *  map. While set: `landPty` disposes anything that lands, no respawn starts,
   *  and `getOrCreateEntry` waits for it before creating a replacement for the
   *  key — identity and config are keyed by sessionKey, so two entries on one
   *  key must never overlap (#385, Copilot on #391). */
  retiring?: Promise<void>;
  /** The in-flight `dispose()` of `pty`, when a respawn started one. A second
   *  `dispose()` on the same PTY returns at once, so a retirement racing that
   *  respawn must join THIS promise or it would release the key and admit a
   *  replacement while the old process is still being torn down. */
  disposing?: Promise<void>;
  /** A failed first-turn spawn's own identity/config release while it runs.
   *  A retirement starting meanwhile joins it before its own release, so the
   *  replacement it unblocks cannot be admitted while this release — keyed by
   *  sessionKey — could still touch the key. */
  releasing?: Promise<void>;
  /** Wall-clock at the most recent spawn (or respawn). Used by `reapIdle` to
   *  time out PTYs that never complete a first turn after a (re)spawn
   *  (issue #65 item 6). Reset on every respawn so a healthy long-lived PTY
   *  that crashes and respawns gets a fresh grace window — keying off entry
   *  creation time would incorrectly evict it (Codex P1 on PR #149).
   *  Stays 0 until the first successful spawn completes. */
  lastSpawnedAt: number;
  /** #546: see `PtyRunScope`. Fixed at entry creation. */
  scope: PtyRunScope;
  /** Callers currently holding or queued on `lock` (#549). The lock is a promise
   *  chain and cannot be inspected synchronously; `sendToLiveSession` needs to
   *  know "idle" without queueing behind a turn. Moves only through `installLock`. */
  activeTurns: number;
}

interface SupervisorState {
  ptys: Map<string, PtyEntry>;
  reapTimer: ReturnType<typeof setInterval> | null;
  initialised: boolean;
  /** True from the first synchronous step of `shutdownSupervisor` until it
   *  returns. Admission refuses new entries meanwhile (#385): a caller that was
   *  waiting for a retiring entry on its key must not create the replacement
   *  the shutdown would then have to chase. Cleared on return so the next
   *  caller re-initialises normally. */
  shuttingDown: boolean;
  /** Bumped synchronously when a shutdown starts (#394). A caller that went
   *  to sleep on a retiring key BEFORE the shutdown and wakes up AFTER it
   *  finished would see `shuttingDown` already cleared — the shutdown's own
   *  `allSettled` continuation was queued first — and admit a replacement the
   *  shutdown never saw. Comparing the epoch captured before the wait catches
   *  that; the flag alone does not. */
  shutdownEpoch: number;
}

const state: SupervisorState = {
  ptys: new Map(),
  reapTimer: null,
  initialised: false,
  shuttingDown: false,
  shutdownEpoch: 0,
};

/** Thrown by admission while the supervisor is shutting down. */
class SupervisorShuttingDownError extends Error {
  constructor(sessionKey: string) {
    super(`[pty-supervisor] supervisor is shutting down — not admitting ${sessionKey}`);
    this.name = "SupervisorShuttingDownError";
  }
}

/**
 * Phase D fix #3 (Codex review HIGH #3): cache the in-flight init promise so
 * concurrent first-callers don't double-init the reaper. Cleared by
 * `__resetSupervisorForTests` and by `shutdownSupervisor`.
 */
let _initPromise: Promise<void> | null = null;

/**
 * Idempotently start the supervisor (reaper interval). Called lazily from
 * `runOnPty` so the daemon runtime — which goes directly through `runOnPty`,
 * never through `initSupervisor` — picks up `settings.pty.idleReapMinutes`.
 *
 * Race-safe: concurrent first-callers await the same in-flight promise. The
 * underlying `initSupervisor` is itself idempotent (it clears + rebuilds the
 * reap timer), so a fresh call after `__resetSupervisorForTests` re-installs
 * the timer cleanly.
 */
async function ensureSupervisorInitialised(): Promise<void> {
  if (state.initialised) return;
  if (_initPromise) {
    await _initPromise;
    return;
  }
  _initPromise = initSupervisor().finally(() => {
    _initPromise = null;
  });
  await _initPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API.

/**
 * Initialise the supervisor at daemon startup. Idempotent.
 * Lazy-spawn strategy: named-agent PTYs spawn on first event, not here.
 *
 * In practice the daemon runtime never calls this directly — it's invoked
 * lazily by `runOnPty` via `ensureSupervisorInitialised()` so the reap
 * interval reliably starts on first PTY use. See Phase D fix #3.
 */
export async function initSupervisor(): Promise<void> {
  const settings = getSettings();
  const opts: SupervisorOptions = {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: settings.pty.maxRetries,
    respawnRetries: settings.pty.respawnRetries,
    backoffMs: settings.pty.backoffMs,
    namedAgentsAlwaysAlive: settings.pty.namedAgentsAlwaysAlive,
  };

  // Reap interval — rebuild on re-init (in case idleReapMinutes changed).
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  // Tick once a minute; reaper itself decides what's stale.
  state.reapTimer = setInterval(() => {
    void reapIdle(opts).catch(() => {
      // Reap errors are swallowed — they're best-effort housekeeping.
    });
  }, 60_000);
  // Don't keep the daemon alive solely because of the reaper.
  if (typeof (state.reapTimer as { unref?: () => void }).unref === "function") {
    (state.reapTimer as { unref: () => void }).unref();
  }

  state.initialised = true;
}

/**
 * Graceful shutdown. Disposes all live PTYs.
 */
export async function shutdownSupervisor(): Promise<void> {
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  // Retire every entry (#385): `retiring` is set before the first await, so a
  // (re)spawn still in flight for one of them is disposed by `landPty` when it
  // lands, whenever that is. A `runOnPty` racing this shutdown is not
  // reconciled here — that race predates this change.
  // Refuse admissions from here on (synchronously, before the first await):
  // a caller waiting for a retiring entry on its key would otherwise create
  // the replacement right as we finish and leave it untracked. Anything that
  // was already past admission is in the map and retired below; the loop
  // catches an entry added between the snapshot and the settle.
  state.shuttingDown = true;
  state.shutdownEpoch += 1;
  try {
    while (state.ptys.size > 0) {
      await Promise.allSettled([...state.ptys.values()].map(retireEntry));
    }
  } finally {
    state.shuttingDown = false;
  }
  state.initialised = false;
  _initPromise = null;
  _admissionLock = Promise.resolve();
}

/**
 * Phase D fix #4: dispose every live PTY managed by the supervisor.
 *
 * Called from `runner.ts:killActive()` so that `/kill` reaches PTY-mode
 * sessions. Tradeoff:
 *   - Destroying a PTY mid-turn surfaces `PtyClosedError` to the in-flight
 *     `runOnPty` caller (the supervisor's per-key serial lock guarantees the
 *     promise has a resolver). execClaude then propagates the failure to the
 *     user just like a `/kill` against the legacy `Bun.spawn` path does today.
 *   - The PTY is gone — the conversation session ID survives on disk (Claude
 *     Code keeps the JSONL), so the next event for the same `sessionKey`
 *     re-spawns and `--resume`s. Conversation context is preserved; the
 *     in-flight turn alone is aborted.
 *   - Named agents are NOT exempt here. `/kill` is an explicit operator
 *     command and should resolve a stuck named-agent PTY just as it does a
 *     stuck ad-hoc thread. The auditor's argument (FA-6a) is the load-bearing
 *     one: silent no-op `/kill` is worse than session loss when an agent is
 *     genuinely wedged.
 *
 * Returns the number of PTYs that were disposed. Best-effort: errors from
 * `dispose()` are swallowed.
 */
export async function killAllPtys(): Promise<number> {
  const entries = [...state.ptys.values()].filter((e) => !e.scope.survivesKill);
  if (entries.length === 0) return 0;
  const killed = entries.filter((e) => e.pty).length;
  await Promise.allSettled(entries.map(retireEntry));
  return killed;
}

/**
 * Retire the entry on `sessionKey`, if any (#546): dispose its PTY and drop
 * the entry, so the next call on the key spawns fresh from its session store.
 * Used when the caller has just reset that store (corrupted fallback session).
 */
export async function retirePtySession(sessionKey: string): Promise<void> {
  const entry = state.ptys.get(sessionKey);
  if (entry) await retireEntry(entry);
}

/**
 * Snapshot of supervisor state for /status and tests.
 * Order-stable: sorted by sessionKey.
 */
/**
 * Number of entries the supervisor tracks, INCLUDING those whose spawn has
 * not landed yet (`pty === null`) and those being retired. `snapshotSupervisor`
 * omits the former on purpose — there is no pid to show — which made `/kill`
 * a no-op when the only session was still booting (#394): its late spawn then
 * landed on an entry nothing had asked to retire. Gate `/kill` on this instead.
 */
export function supervisorEntryCount(): number {
  // #546: entries `/kill` does not reach (forks) are not counted either.
  let n = 0;
  for (const entry of state.ptys.values()) if (!entry.scope.survivesKill) n += 1;
  return n;
}

export function snapshotSupervisor(): SupervisorSnapshot {
  const keys = [...state.ptys.keys()].sort();
  const ptys: SupervisorSnapshot["ptys"] = [];
  for (const key of keys) {
    const entry = state.ptys.get(key)!;
    if (!entry.pty) continue;
    ptys.push({
      sessionKey: entry.sessionKey,
      label: entry.pty.label,
      pid: entry.pty.pid,
      sessionId: entry.pty.sessionId,
      cwd: entry.pty.cwd,
      isAlive: entry.pty.isAlive(),
      lastTurnEndedAt: entry.pty.lastTurnEndedAt(),
      kind: entry.kind,
    });
  }
  return { ptys };
}

/**
 * Thrown by `withDeadline` when the wrapped promise does not settle in time.
 * A distinct type so callers can tell "we gave up waiting" apart from a real
 * failure the operation itself reported.
 */
class DeadlineExceeded extends Error {
  constructor(ms: number) {
    super(`deadline of ${ms}ms exceeded`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * Resolve `p`, or reject with `DeadlineExceeded` after `ms`.
 *
 * The loser of the race is not abandoned silently: the timer is always cleared,
 * and a late rejection from `p` is swallowed so it cannot surface as an
 * unhandled rejection after we have already returned. `p` itself keeps running —
 * there is no cancellation to hand it — so this bounds the WAIT, not the work.
 * That is the right shape here: an admission that eventually completes leaves a
 * usable entry behind for the next call.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(ms)), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
    p.catch(() => {});
  });
}

/**
 * Run a single turn on the PTY associated with `sessionKey`.
 * See SPEC §3.2 for the contract.
 *
 * Phase D additions:
 *   - `securityArgs`: pre-built argv from runner.ts:buildSecurityArgs(), so
 *     the supervisor honours the operator's permissionMode + locked-mode
 *     Write tool. Without this, every PTY spawn unconditionally bypassed
 *     permissions via `--dangerously-skip-permissions`.
 *   - `appendSystemPrompt`: the assembled `--append-system-prompt` payload
 *     (CLAUDE.md + MEMORY.md + agent identity + dir-scope guard). Without
 *     this, named agents lose their identity and memory under PTY mode.
 */
export async function runOnPty(
  sessionKey: string,
  prompt: string,
  opts: {
    timeoutMs: number;
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
    /** Codex Phase D #1: resolved auth token from settings/agentic routing/job
     *  override. The supervisor passes this to `buildChildEnv` so the PTY's
     *  env carries `ANTHROPIC_AUTH_TOKEN` and the GLM/Kimi base-URL shims
     *  identical to the legacy `claude -p` path. */
    api?: string;
    /** Phase D fix #3: pre-built security argv from runner.ts:buildSecurityArgs. */
    securityArgs?: string[];
    /** Phase D fix #2: assembled --append-system-prompt payload. */
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
    /** #546: aborting retires the entry — the PTY is disposed mid-turn and the
     *  call returns an error result. */
    signal?: AbortSignal;
  } & PtyRunScope,
): Promise<RunOnPtyResult> {
  if (opts.signal?.aborted) return errorResult(`[pty-supervisor] ${sessionKey} aborted`);
  // Phase D fix #3 (Codex HIGH #3): lazily start the reaper interval. The
  // daemon runtime enters PTY mode through `runOnPty` directly and never
  // calls `initSupervisor`, so without this `settings.pty.idleReapMinutes`
  // would be ignored in production.
  // Issue #369: `timeoutMs` is consumed inside `runTurnWithRetries`, so it
  // bounds the TURN. Everything before it — supervisor init, admission (lock
  // wait, `enforceMaxConcurrent`, spawning claude plus the MCP fleet), and the
  // wait on the previous turn's lock — ran with no deadline at all. A stall in
  // any of those was an unbounded hang rather than a recoverable timeout: the
  // caller's `timeoutMs` elapsed and nothing fired. That is the difference
  // between a job failing cleanly and a job wedging.
  //
  // Each stage is bounded by the caller's own `timeoutMs`. Note this is a
  // per-stage bound, not a total: admission, the lock wait, the spawn, each
  // of `maxRetries + 1` turns and (since #385) each of up to `respawnRetries`
  // crash-recovery respawns between them are each bounded by it, so the worst
  // case is a multiple of `timeoutMs`, not `timeoutMs`. The retry
  // multiplication predates this change; what changes here is that the stages
  // ahead of and between the turns are bounded at all instead of being able to
  // hang forever.
  let entry: PtyEntry;
  let supervisorOpts: ReturnType<typeof readSupervisorOptions>;
  const admission = (async () => {
    await ensureSupervisorInitialised();
    // Read settings before admission, as before: never cached across calls,
    // so hot-reload keeps working.
    const so = readSupervisorOptions();
    // Phase D fix #5: enforce maxConcurrent cap with LRU eviction BEFORE
    // allocating a new entry. Named agents are exempt — they're always-alive
    // by design.
    //
    // Issue #65 item 2: enforce + create must be a single critical section.
    // `enforceMaxConcurrent` awaits on `dispose()`, opening a window where two
    // concurrent admissions can both see "under cap" and both add entries —
    // exceeding the cap. Serialize through `_admissionLock`.
    const e = await admitEntry(sessionKey, opts);
    return { entry: e, supervisorOpts: so };
  })();
  try {
    ({ entry, supervisorOpts } = await withDeadline(admission, opts.timeoutMs));
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      // #546: nothing else will ever retire a one-shot entry admitted late.
      if (opts.ephemeral)
        void admission.then(
          ({ entry: e }) => retireEntry(e),
          () => {},
        );
      return errorResult(
        `[pty-supervisor] admission stage exceeded ${opts.timeoutMs}ms for ${sessionKey} — supervisor init, concurrency admission, or PTY spawn did not settle`,
      );
    }
    if (err instanceof SupervisorShuttingDownError) return errorResult(err.message);
    throw err;
  }

  entry.lastAccessedAt = _clock();
  // #546: abort and one-shot runs both end by retiring the entry. Retiring
  // disposes the PTY (a turn in flight fails with PtyClosedError) and fences
  // any spawn still landing, so nothing outlives the call.
  const onAbort = (): void => {
    void retireEntry(entry);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.signal?.aborted) {
      await retireEntry(entry);
      return errorResult(`[pty-supervisor] ${sessionKey} aborted`);
    }
    return await runOnAdmittedEntry(entry, sessionKey, prompt, opts, supervisorOpts);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (entry.scope.ephemeral) await retireEntry(entry);
  }
}

async function runOnAdmittedEntry(
  entry: PtyEntry,
  sessionKey: string,
  prompt: string,
  opts: Parameters<typeof runOnPty>[2],
  supervisorOpts: SupervisorOptions,
): Promise<RunOnPtyResult> {
  const { previousLock, release } = installLock(entry);
  // The lock is a chain: each caller captures its predecessor, installs its own,
  // awaits the predecessor, and releases in `finally`. Giving up on the wait is
  // therefore delicate — releasing immediately would hand the chain to the next
  // caller while the predecessor's turn is *still running*, putting two turns on
  // one PTY with interleaved writes and reads. Bounding the wait must not cost
  // the serialisation it is bounding.
  //
  // So on timeout this call abandons its own wait but leaves the chain intact:
  // its lock is released only once the predecessor actually settles.
  let releaseOnExit = true;
  try {
    try {
      await withDeadline(previousLock, opts.timeoutMs);
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        // Not `release()` — see above. Successors keep waiting behind the
        // predecessor that is still running, and are unblocked when it ends.
        releaseOnExit = false;
        void previousLock.finally(release);
        return errorResult(
          `[pty-supervisor] waited ${opts.timeoutMs}ms for the previous turn on ${sessionKey} to finish; it never did`,
        );
      }
      throw err;
    }
    // #394: the entry may have been retired while this turn waited behind the
    // previous one — `retireEntry` leaves `entry.pty` pointing at the disposed
    // process, so running here would only fail into a respawn that is refused
    // a second later. Fail now; the next call on the key gets a fresh entry.
    if (!isCurrentEntry(entry)) {
      return errorResult(
        `[pty-supervisor] ${sessionKey} was retired while this turn waited for the previous one — not running on it`,
      );
    }
    return await runTurnWithRetries(entry, prompt, opts, supervisorOpts);
  } finally {
    if (releaseOnExit) release();
  }
}

/**
 * Take the per-key serial lock: returns the predecessor to wait on and a
 * `release` that frees the lock exactly once (a second call is a no-op), keeping
 * `entry.activeTurns` in step with the chain.
 */
function installLock(entry: PtyEntry): { previousLock: Promise<void>; release: () => void } {
  const previousLock = entry.lock;
  let resolveLock: () => void = () => {};
  entry.lock = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  entry.activeTurns += 1;
  let released = false;
  return {
    previousLock,
    release: () => {
      if (released) return;
      released = true;
      entry.activeTurns -= 1;
      resolveLock();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-session send (#549).

/**
 * Why `sendToLiveSession` found nothing alive to write to. Every reason here means
 * NO process holds the session, so the caller may resume it in a one-shot. Anything
 * else — a turn running, a spawn or retirement in flight, a shutdown with the process
 * still there — is waited out, or reported as `failed`, never as `not-live`: a
 * one-shot beside a live process is two writers on one transcript.
 */
export type NotLiveReason =
  /** No entry for the key: nothing tracked, or its retirement has finished. */
  | "no-entry"
  /** An entry whose process has exited and that nothing is spawning. */
  | "no-process"
  /** A one-shot stand-in (`ephemeral`): a fresh session, never the conversation asked about. */
  | "ephemeral";

/**
 * Outcome of `sendToLiveSession`. `not-live` means no process holds the session and
 * the caller may fall back to a one-shot; `failed` means the live session could not
 * be used (the turn was attempted, the wait ran out, or the session is being torn
 * down) and a fallback process on the same transcript would race it.
 */
export type LiveSendResult =
  | { status: "sent"; text: string; sessionId: string; cleanBoundary: boolean }
  | { status: "not-live"; reason: NotLiveReason }
  | { status: "failed"; error: string; timedOut: boolean; aborted: boolean };

class LiveSendAborted extends Error {
  constructor() {
    super("live send aborted");
    this.name = "LiveSendAborted";
  }
}

/** Resolve with `p`, or reject with `LiveSendAborted` as soon as `signal` fires. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new LiveSendAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Wait for `p` to settle (either way), until `deadline` (a `_clock()` time) or `signal`. */
async function settleBy(
  p: Promise<unknown>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<"settled" | "timeout" | "aborted"> {
  if (signal?.aborted) return "aborted";
  const left = deadline - _clock();
  if (left <= 0) return "timeout";
  try {
    await raceAbort(withDeadline(p, left), signal);
    return "settled";
  } catch (err) {
    if (err instanceof DeadlineExceeded) return "timeout";
    if (err instanceof LiveSendAborted) return "aborted";
    return "settled"; // `p` rejected: it is over, which is all we wait for
  }
}

/**
 * Write `text` as one turn into the live PTY for `sessionKey` and wait for its end
 * of turn (#549). Used for `/compact`, memory saves and the rotation summary, which
 * used to resume the same session in a second `claude -p`.
 *
 * The contract is "never a second process on a session a process still holds":
 *   - a turn running, queued turns, or an in-flight (re)spawn: wait for them on the
 *     per-key lock, then send. `timeoutMs` is one budget for the wait plus the turn.
 *   - an entry being retired: wait until its process is gone, then re-evaluate (a
 *     replacement may have been admitted; otherwise `not-live`/`no-entry`).
 *   - the supervisor shutting down with the entry still there: `failed`.
 *   - the wait runs out or `signal` fires: `failed`. The abandoned send is dropped, and
 *     the lock chain stays intact (our slot is released when the predecessor ends).
 * Only "no entry", "its process is dead and nothing is spawning" and "a one-shot
 * stand-in" return `not-live`. Never spawns.
 *
 * While the turn runs the entry's lock is held, so a user message arriving meanwhile
 * waits behind it. An abort stops the WAIT only; the lock is kept until the turn
 * really ends. A turn timeout retires the entry (the sentinel may be left in claude's
 * input buffer); the next `runOnPty` on the key resumes from disk.
 */
export async function sendToLiveSession(
  sessionKey: string,
  text: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<LiveSendResult> {
  const deadline = _clock() + opts.timeoutMs;
  const gaveUp = (what: string, how: "timeout" | "aborted"): LiveSendResult => ({
    status: "failed",
    error:
      how === "aborted"
        ? `aborted while waiting for ${what}`
        : `waited ${opts.timeoutMs}ms for ${what} on ${sessionKey}; not writing to it, and not resuming it elsewhere`,
    timedOut: how === "timeout",
    aborted: how === "aborted",
  });

  for (;;) {
    if (opts.signal?.aborted) {
      return { status: "failed", error: "aborted before send", timedOut: false, aborted: true };
    }
    const entry = state.ptys.get(sessionKey);
    // No entry: no process (a finished retirement removes it), whatever the
    // supervisor is doing.
    if (!entry) return { status: "not-live", reason: "no-entry" };
    if (entry.scope.ephemeral) return { status: "not-live", reason: "ephemeral" };
    // The entry is still tracked, so its process may still be alive. A supervisor
    // shutdown marks every entry `retiring` before its first await, so the wait
    // below is also what holds a send back during a shutdown.
    if (entry.retiring) {
      const w = await settleBy(entry.retiring, deadline, opts.signal);
      if (w !== "settled") return gaveUp("its retirement to finish", w);
      continue;
    }
    if (entry.spawnInFlight) {
      const w = await settleBy(entry.spawnInFlight, deadline, opts.signal);
      if (w !== "settled") return gaveUp("its spawn to finish", w);
      continue;
    }
    // Nothing queued and nothing running: a missing or dead process is nothing alive.
    if (entry.activeTurns === 0 && (!entry.pty || !entry.pty.isAlive())) {
      return { status: "not-live", reason: "no-process" };
    }

    // Queue on the per-key lock behind whatever runs now.
    const { previousLock, release } = installLock(entry);
    const waited = await settleBy(previousLock, deadline, opts.signal);
    if (waited !== "settled") {
      // Not ours to run, but the chain must stay intact: free our slot only once the
      // predecessor has actually ended (as `runOnAdmittedEntry` does).
      void previousLock.then(release, release);
      return gaveUp("the running turn to end", waited);
    }
    // The world may have changed while we queued: re-check under the lock.
    if (!isCurrentEntry(entry) || entry.spawnInFlight || !entry.pty?.isAlive()) {
      release();
      continue;
    }

    const pty = entry.pty;
    entry.lastAccessedAt = _clock();
    let turn: Promise<PtyTurnResult>;
    try {
      turn = pty.runTurn(text, { timeoutMs: Math.max(1, deadline - _clock()) });
    } catch (err) {
      release();
      return { status: "failed", error: (err as Error).message, timedOut: false, aborted: false };
    }
    // Released when the turn settles, whoever stopped waiting for it.
    turn.then(release, release);

    try {
      const result = await raceAbort(turn, opts.signal);
      try {
        await persistSessionId(entry, result.sessionId);
      } catch {
        // Best-effort, as on the `runOnPty` path: the turn itself succeeded.
      }
      return {
        status: "sent",
        text: result.text,
        sessionId: result.sessionId,
        cleanBoundary: result.cleanBoundary,
      };
    } catch (err) {
      if (err instanceof LiveSendAborted) {
        return { status: "failed", error: "aborted", timedOut: false, aborted: true };
      }
      const timedOut = err instanceof PtyTurnTimeoutError;
      if (timedOut) await retireEntry(entry);
      return { status: "failed", error: (err as Error).message, timedOut, aborted: false };
    }
  }
}

/**
 * Keys of the non-ephemeral entries that have a process or may yet get one (sorted):
 * the sessions a shutdown should ask to save their memory (#549).
 *
 * That includes an entry whose spawn or respawn is in flight and one that is retiring.
 * Leaving them out would let the caller treat the key as having no process and resume
 * the transcript in a one-shot while the PTY lands or is still being disposed (#561).
 * `sendToLiveSession` waits those states out and answers `not-live` only once the
 * process is gone, so the caller goes through it either way.
 */
export function liveSessionKeys(): string[] {
  const keys: string[] = [];
  for (const entry of state.ptys.values()) {
    if (entry.scope.ephemeral) continue;
    if (!entry.retiring && !entry.spawnInFlight && !entry.pty?.isAlive()) continue;
    keys.push(entry.sessionKey);
  }
  return keys.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals.

function readSupervisorOptions(): SupervisorOptions {
  const settings = getSettings();
  return {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: _maxRetriesOverride != null ? _maxRetriesOverride : settings.pty.maxRetries,
    respawnRetries:
      _respawnRetriesOverride != null ? _respawnRetriesOverride : settings.pty.respawnRetries,
    backoffMs: settings.pty.backoffMs,
    namedAgentsAlwaysAlive: settings.pty.namedAgentsAlwaysAlive,
  };
}

function classifyKey(sessionKey: string, threadId?: string, agentName?: string): SessionKind {
  // Match the conventions in SPEC §3.2 + §5.2.
  // #546: a rate-limit fallback PTY is reapable and evictable whatever it
  // stands in for — a named agent's fallback must not stay alive for good.
  if (sessionKey.startsWith("fallback:")) return "adhoc";
  if (sessionKey.startsWith("thread:") || threadId) return "adhoc";
  if (sessionKey.startsWith("agent:") || agentName) return "named";
  return "global";
}

function getOrCreateEntry(
  sessionKey: string,
  opts: {
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
  } & PtyRunScope,
): PtyEntry {
  // A retiring entry is waited for in `admitEntry`, outside the global lock.
  // One that started retiring during `enforceMaxConcurrent` is returned as is:
  // every (re)spawn site refuses to act on it, so the turn fails bounded.
  const existing = state.ptys.get(sessionKey);
  if (existing) return existing;

  const kind = classifyKey(sessionKey, opts.threadId, opts.agentName);
  const now = _clock();
  const entry: PtyEntry = {
    sessionKey,
    kind,
    threadId: opts.threadId,
    agentName: opts.agentName,
    pty: null,
    spawnOpts: null,
    lock: Promise.resolve(),
    lastAccessedAt: now,
    // Stamped at every (re)spawn site below. 0 until the first spawn lands —
    // `reapIdle` treats that as "still admitting, leave alone".
    lastSpawnedAt: 0,
    activeTurns: 0,
    scope: {
      sessionStore: opts.sessionStore,
      ephemeral: opts.ephemeral,
      survivesKill: opts.survivesKill,
      cwd: opts.cwd,
      mcpConfig: opts.mcpConfig,
      resumeSessionId: opts.resumeSessionId,
      isolation: opts.isolation,
    },
  };
  state.ptys.set(sessionKey, entry);
  return entry;
}

/** Test-only override for the maxConcurrent cap. When non-null, takes
 *  precedence over `settings.pty.maxConcurrent`. Cleared by
 *  __resetSupervisorForTests. */
let _maxConcurrentOverride: number | null = null;
/** Test-only override for maxRetries. */
let _maxRetriesOverride: number | null = null;
/** Test-only override for respawnRetries. Issue #175. */
let _respawnRetriesOverride: number | null = null;

/** For tests only. Override the maxConcurrent cap without writing to disk. */
export function injectMaxConcurrentForTests(cap: number | null): void {
  _maxConcurrentOverride = cap;
}

/** For tests only. Override maxRetries without writing to disk. */
export function injectMaxRetriesForTests(n: number | null): void {
  _maxRetriesOverride = n;
}

/** For tests only. Override respawnRetries without writing to disk. */
export function injectRespawnRetriesForTests(n: number | null): void {
  _respawnRetriesOverride = n;
}

/**
 * Issue #65 item 2: single mutex serialising the
 * `enforceMaxConcurrent → getOrCreateEntry` admission critical section. Without
 * this, two concurrent `runOnPty` calls can both observe `state.ptys.size < cap`
 * during the eviction `await` window and both add new entries, exceeding the
 * cap. Held only across admission (cheap: at most one `dispose()`), then
 * released so different keys proceed in parallel on the per-entry lock.
 */
let _admissionLock: Promise<void> = Promise.resolve();

async function admitEntry(
  sessionKey: string,
  opts: {
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
  } & PtyRunScope,
): Promise<PtyEntry> {
  // A shutdown that starts AND finishes while this caller is parked on a
  // retirement (or on the lock) has already cleared `shuttingDown` by the
  // time the caller wakes; the epoch is what still says it happened (#394).
  const epoch = state.shutdownEpoch;
  const refuseIfShuttingDown = (): void => {
    if (state.shuttingDown || state.shutdownEpoch !== epoch) {
      throw new SupervisorShuttingDownError(sessionKey);
    }
  };
  for (;;) {
    // Checked BEFORE parking on a retirement as well as after: a caller that
    // arrives mid-shutdown must not wait it out and then admit.
    refuseIfShuttingDown();
    // #385: an entry on this key that is mid-retirement must finish before a
    // replacement is created — identity and config are keyed by sessionKey.
    // That wait happens OUTSIDE the global admission lock: a slow retirement
    // (reap, `/kill`, shutdown, a hung dispose or revoke) must stall this key
    // only, not admission for every other key. Bounded by the caller's
    // admission deadline like the rest of admission.
    const retiring = state.ptys.get(sessionKey)?.retiring;
    if (retiring) {
      await retiring.catch(() => {});
      continue;
    }
    const prev = _admissionLock;
    let release: () => void = () => {};
    _admissionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      // A retirement may have started on this key while we queued for the
      // lock; go back to waiting for it without holding the lock.
      if (state.ptys.get(sessionKey)?.retiring) continue;
      refuseIfShuttingDown();
      // #546: a one-shot run neither counts against the cap nor evicts.
      if (!opts.ephemeral) await enforceMaxConcurrent(sessionKey);
      // The eviction above awaits a dispose; a shutdown can start AND finish
      // inside that wait (it joins the same retirement), leaving the flag
      // already cleared — the epoch is what still refuses this admission.
      refuseIfShuttingDown();
      return getOrCreateEntry(sessionKey, opts);
    } finally {
      release();
    }
  }
}

/**
 * Phase D fix #5 (FA-3a): cap the number of concurrent live PTYs to
 * `settings.pty.maxConcurrent`. When the cap is hit, evict the
 * least-recently-accessed AD-HOC PTY. Both `named` agents (always-alive
 * by design) and `global` entries (per-cwd anonymous sessions used by the
 * legacy non-bus runtime) are exempt — only `adhoc` is considered for
 * eviction. The evicted PTY is disposed and its entry removed from the
 * state map.
 *
 * If the cap is hit but EVERY entry is exempt (all named/global) or the
 * incoming key is for a named agent that doesn't yet exist, we let it through
 * — the operator's named-agent slate is the source of truth and shouldn't be
 * silently shrunk by a thread burst.
 *
 * Concurrency: callers must hold `_admissionLock` to serialise the check +
 * eviction window. See `admitEntry`.
 */
async function enforceMaxConcurrent(incomingKey: string): Promise<void> {
  let cap: number;
  if (_maxConcurrentOverride != null) {
    cap = _maxConcurrentOverride;
  } else {
    cap = getSettings().pty.maxConcurrent;
  }
  if (!Number.isFinite(cap) || cap <= 0) return; // disabled
  if (state.ptys.has(incomingKey)) return; // existing key, no new allocation
  // #385: an entry being retired is on its way out; it neither counts against
  // the cap nor is an eviction candidate — awaiting its retirement here would
  // hold the global admission lock on a removal already in progress.
  let live = 0;
  for (const entry of state.ptys.values()) {
    if (!entry.retiring && !entry.scope.ephemeral) live += 1;
  }
  if (live < cap) return; // headroom available

  // Find LRU candidate among adhoc entries (skip named + global + retiring).
  let lruEntry: PtyEntry | null = null;
  for (const entry of state.ptys.values()) {
    if (entry.kind !== "adhoc" || entry.retiring || entry.scope.ephemeral) continue;
    if (!lruEntry || entry.lastAccessedAt < lruEntry.lastAccessedAt) {
      lruEntry = entry;
    }
  }

  if (!lruEntry) {
    // Nothing evictable — let the new spawn proceed (operator-configured
    // named agents are sacrosanct). The state.ptys.size will temporarily
    // exceed cap; the next idle-reap pass will catch up if any entry
    // becomes idle.
    return;
  }

  // Dispose and remove (#385: through `retireEntry`, which fences late spawns
  // and same-key replacements). Errors are best-effort.
  await retireEntry(lruEntry);
}

async function buildSpawnOptions(
  entry: PtyEntry,
  modelOverride: string | undefined,
  api: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<PtyProcessOptions> {
  const settings = getSettings();
  const { security } = settings;

  // Resolve cwd:
  //   - agent  → agents/<name> (created if needed)
  //   - thread → repo root (process.cwd())
  //   - global → repo root
  const cwd =
    entry.scope.cwd ??
    (entry.agentName ? await ensureAgentDirLazy(entry.agentName) : process.cwd());

  // Resume from stored session ID where available. A one-shot run never
  // resumes; a caller-supplied store (#546) replaces the id-based lookup.
  let sessionId = "";
  if (entry.scope.ephemeral) {
    sessionId = entry.scope.resumeSessionId ?? "";
  } else if (entry.scope.sessionStore) {
    sessionId = (await entry.scope.sessionStore.load()) ?? "";
  } else if (entry.threadId) {
    const t = await getThreadSession(entry.threadId);
    sessionId = t?.sessionId ?? "";
  } else if (entry.agentName) {
    const a = await getSession(entry.agentName);
    sessionId = a?.sessionId ?? "";
  } else {
    const g = await getSession();
    sessionId = g?.sessionId ?? "";
  }

  // Issue #89: validate the stored sessionId is actually resumable BEFORE
  // passing it to `claude --resume`. The Phase D eager-persistence (Codex
  // HIGH #2) writes the UUID to sessions.json at spawn-time so a daemon
  // crash between spawn and first turn doesn't lose the conversation —
  // but if claude exits BEFORE writing its `.jsonl` (auth gate, parser
  // bug, OOM, anything), the persisted UUID is now a phantom. Every
  // subsequent `--resume <phantom>` errors with "No conversation found"
  // and claude exits 1; the supervisor retries 5x and surfaces "max
  // retries exhausted" to the user. Required three manual sessions.json
  // cleanups during the 2026-05-16 PTY rollout.
  //
  // The resumability test: `<sessionId>.jsonl` exists in claude's project
  // dir for `cwd`. Directory presence is not enough (claude creates the
  // dir on startup but doesn't write the jsonl until it's logged at
  // least one turn). Fail-closed: if we can't confirm, treat as phantom
  // and allocate a fresh session. Worst case we lose continuity for one
  // bad record; far better than user-visible "max retries exhausted".
  if (sessionId && !entry.scope.resumeSessionId && !(await _isSessionResumable(cwd, sessionId))) {
    sessionId = "";
  }

  // Phase D fix (Codex HIGH #2): no stored session ID for this key. Pre-allocate
  // a deterministic UUID and pass it via `--session-id` so the conversation
  // survives daemon restart / idle reap / `/kill` / crash. Without this, fresh
  // PTY conversations only live in the long-lived process — subsequent turns
  // would start a brand-new Claude Code session every time.
  //
  // The supervisor persists this UUID to disk immediately after spawn (see
  // `spawnEntry`), not on first-turn completion, so a daemon that dies between
  // spawn and the first response still recovers the same conversation on
  // restart.
  let newSessionId: string | undefined;
  if (!sessionId) {
    newSessionId = _newSessionId();
  }

  // Phase D fix #1: canonical env-sanitiser from runner.ts. Don't reinvent
  // the strip list — divergence here re-introduces the ANTHROPIC_API_KEY
  // billing leak.
  //
  // Phase D fix #3: derive securityArgs from runner.ts:buildSecurityArgs
  // when the caller didn't pre-build them (e.g. legacy tests). The supervisor
  // is otherwise allowed to pass through whatever the caller assembled.
  //
  // Codex Phase D #1: build the child env with the same `buildChildEnv` the
  // legacy path uses so ANTHROPIC_AUTH_TOKEN and the GLM/Kimi base-URL shims
  // are applied to PTY spawns. Without this, the PTY path always inherited
  // the daemon's raw env regardless of the resolved model/provider.
  const runnerHelpers = await getRunnerHelpers();
  const cleanEnv = runnerHelpers.cleanSpawnEnv();
  const childEnv = runnerHelpers.buildChildEnv(cleanEnv, modelOverride ?? "", api ?? "");

  let resolvedSecurityArgs = securityArgs;
  if (!resolvedSecurityArgs) {
    try {
      resolvedSecurityArgs = runnerHelpers.buildSecurityArgs(security);
    } catch {
      // Fall through — buildClaudeArgs will use its internal legacy
      // derivation when securityArgs is undefined.
      resolvedSecurityArgs = undefined;
    }
  }

  // MCP multiplexer (SPEC §4.5): synthesize a per-PTY `--mcp-config` JSON
  // when the multiplexer is active. "Active" iff (per SPEC §6.3):
  //   - settings.mcp.shared is non-empty, AND
  //   - settings.web.enabled is true (the multiplexer mounts on the gateway), AND
  //   - the multiplexer plugin has wired its issuer (injectMcpIdentityIssuer).
  // Otherwise: skip — leave mcpConfigPath unset so buildClaudeArgs emits no
  // --mcp-config flag and the PTY's claude falls back to default MCP discovery.
  // This preserves byte-identical behaviour with today (settings.mcp.shared=[]).
  // #385: everything above awaited. If the entry was retired meanwhile — and
  // possibly replaced on the same key — synthesizing here would overwrite the
  // replacement's sessionKey-scoped config and rotate its bearer. Check right
  // before the (synchronous) synthesis, so there is no window.
  if (!isCurrentEntry(entry)) {
    throw new EntryRemovedError(
      entry.sessionKey,
      "not synthesizing MCP config for a retired entry",
    );
  }
  const mcpConfigPath = entry.scope.mcpConfig
    ? entry.scope.mcpConfig.path
    : synthesizeMcpConfigIfActive(entry.sessionKey, cwd, settings);

  const opts: PtyProcessOptions = {
    sessionId,
    newSessionId,
    ...(entry.scope.isolation ? { isolation: entry.scope.isolation } : {}),
    cwd,
    agentName: entry.agentName,
    modelOverride: modelOverride ?? undefined,
    security: cloneSecurity(security),
    securityArgs: resolvedSecurityArgs,
    appendSystemPrompt,
    env: childEnv,
    cols: settings.pty.cols,
    rows: settings.pty.rows,
    turnIdleTimeoutMs: settings.pty.turnIdleTimeoutMs,
    quietWindowMs: settings.pty.quietWindowMs,
    sentinelMaxWaitMs: settings.pty.sentinelMaxWaitMs,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
  };
  // Recorded on the entry in the same synchronous step as the synthesis, so a
  // retirement that starts before `spawnEntry` resumes still sees the config
  // it has to release.
  entry.spawnOpts = opts;
  return opts;
}

/**
 * Synthesize the per-PTY `--mcp-config` JSON when the multiplexer is active.
 * Returns the absolute path on success, or `undefined` when synthesis is
 * skipped (multiplexer dormant, gateway disabled, issuer not wired, etc.).
 *
 * Failure to write when synthesis IS active throws — the supervisor lets the
 * error propagate to `spawnEntry`, which fails the spawn with a clear
 * message. SPEC §4.5: "do NOT silently fall through to no-MCP mode".
 */
function synthesizeMcpConfigIfActive(
  ptyId: string,
  cwd: string,
  settings: ReturnType<typeof getSettings>,
): string | undefined {
  const shared = settings.mcp?.shared ?? [];
  if (shared.length === 0) return undefined; // dormant — fast path
  if (!settings.web?.enabled) {
    // SPEC §6.3: gateway disabled means the multiplexer's HTTP routes
    // aren't mounted, so synthesizing a config pointing at a non-existent
    // listener would produce confusing "Connection refused" errors. The
    // config parser already logged a warning at parseSettings time.
    return undefined;
  }
  if (!_mcpIssueIdentity) {
    // Issuer not wired (no multiplexer plugin started, or W1 hasn't merged
    // yet). Skip synthesis silently — the plugin's own startup path is
    // responsible for warning operators when this combination occurs.
    return undefined;
  }

  const identity = _mcpIssueIdentity(ptyId);
  const sharedServers: SharedServerEntry[] = shared.map((name) => ({ name }));
  // Per-PTY stdio entries are not synthesized by W2 — that's an
  // operator-managed concern via mcp-proxy.json. The writer accepts
  // perPtyServers for forward-compat, but we pass an empty list here. If
  // settings.mcp.perPtyOnly becomes a real synthesis surface later, the
  // wiring lands here.
  const perPtyServers: PerPtyServerEntry[] = [];

  // Single source of truth: read the URL the multiplexer actually bound to,
  // not a recomputation from settings. Fallback only if the seam is null
  // (e.g. unit tests skip the issuer wiring); falls back to the conservative
  // loopback default so a test misconfiguration fails closed.
  const bridgeBaseUrl = _mcpBridgeBaseUrl
    ? _mcpBridgeBaseUrl()
    : `http://127.0.0.1:${settings.web?.port ?? 4632}`;

  const { path } = writeConfigForPty({
    ptyId,
    cwd,
    sharedServers,
    perPtyServers,
    bridgeBaseUrl,
    identity,
  });
  return path.length > 0 ? path : undefined;
}

/**
 * Release multiplexer identity + delete the synthesized config file for a
 * PTY entry that is being permanently disposed (idle reap, LRU evict,
 * shutdown, `/kill`, test reset). Best-effort — errors are swallowed so
 * cleanup never blocks the supervisor's dispose path.
 *
 * NOT called on crash-respawn (`respawnEntry`) — the bearer token rotates
 * via the next `writeConfigForPty` call on the same path. SPEC §4.5.
 */
async function releaseMcpIdentityFor(entry: PtyEntry): Promise<void> {
  // #546: a caller-owned config was never issued under this key; its owner releases it.
  if (entry.scope.mcpConfig) return;
  const cfgPath = entry.spawnOpts?.mcpConfigPath;
  const cwd = entry.spawnOpts?.cwd;

  // Revoke identity (drops HMAC secret + per-PTY session map entries in the
  // multiplexer). Safe to call even if no identity was ever issued — the
  // multiplexer's `revokeIdentity` is documented as idempotent.
  if (_mcpRevokeIdentity) {
    try {
      await _mcpRevokeIdentity(entry.sessionKey);
    } catch {
      // best-effort
    }
  }

  // Delete the synthesized JSON. We pass through cwd from cached spawnOpts
  // rather than recomputing — keeps cleanup decoupled from any later cwd
  // changes (operator-renamed agent dir, etc.).
  if (cfgPath && cwd) {
    try {
      deleteConfigForPty(cwd, entry.sessionKey);
    } catch {
      // best-effort — operator may have manually removed the directory.
    }
  }
}

function cloneSecurity(security: SecurityConfig): SecurityConfig {
  return {
    level: security.level,
    allowedTools: [...security.allowedTools],
    disallowedTools: [...security.disallowedTools],
  };
}

// Note: the supervisor consumes runner.ts's `cleanSpawnEnv` via the lazy
// import in `getCleanSpawnEnv()`. The old local copy was deleted in Phase D
// because it diverged from the canonical strip list (missing
// `ANTHROPIC_API_KEY`), which silently re-introduced API-credit billing on
// every PTY spawn. Don't add a local copy — always go through
// `getCleanSpawnEnv()`.

/**
 * A utility turn on its own PTY, through the same spawn path as keyed sessions
 * (`buildSpawnOptions`, trust self-heal, multiplexer config) with the #546
 * ephemeral scope: registered in `state.ptys` so shutdown and `/kill` reach it,
 * never reused, outside the LRU and the `maxConcurrent` cap, retired on return.
 *
 * Exit contract matches the `print` engine: timeout and abort resolve with
 * exitCode 124, a failed spawn or turn with a non-zero code. Never throws on
 * those; a request that is invalid or already aborted still throws.
 */
export async function runOnceOnPty(req: OneShotRequest): Promise<OneShotResult> {
  validateIsolation(req);
  validateRouteEngine(
    "pty",
    req.route,
    req.isolation === "untrusted",
    req.resumeSessionId !== undefined,
  );
  req.signal?.throwIfAborted();
  const settings = getSettings();
  const untrusted = req.isolation === "untrusted";
  const model = req.model ?? settings.model;
  const result = (exitCode: number, text = "", sessionId?: string): OneShotResult => ({
    text,
    engine: "pty",
    model,
    exitCode,
    ...(sessionId ? { sessionId } : {}),
  });
  // Created inside the try and removed in the finally, so it never depends on
  // the turn settling (a hung turn or a spawn that never lands).
  let tempCwd: string | undefined;
  try {
    if (untrusted) tempCwd = mkdtempSync(join(tmpdir(), "claudeclaw-oneshot-pty-"));
    const helpers = await getRunnerHelpers();
    const { PTY_OUTPUT_FORMAT_CONSTRAINT } = await import("./pty-output-format.js");
    const exec = await runEphemeralWithDeadline(
      `oneshot:${req.route}:${randomUUID()}`,
      req.prompt,
      {
        timeoutMs: req.timeoutMs,
        modelOverride: model,
        api: settings.api,
        ...(untrusted
          ? { mcpConfig: { path: undefined } }
          : {
              // Same flags as the `print` engine (`trustedToolFlags`); the default
              // permission profile only when the caller gave no grant at all.
              securityArgs: trustedToolFlags(req) ?? helpers.buildSecurityArgs(settings.security),
              appendSystemPrompt: [req.system, PTY_OUTPUT_FORMAT_CONSTRAINT]
                .filter(Boolean)
                .join("\n\n"),
            }),
        isolation: req.isolation,
        cwd: tempCwd ?? req.cwd ?? process.cwd(),
        resumeSessionId: req.resumeSessionId,
      },
      req.signal,
    );
    if (exec.timedOut || exec.aborted) return result(124);
    if (exec.exitCode !== 0) {
      console.warn(`[pty-supervisor] one-shot ${req.route} failed: ${exec.stderr}`);
      return result(exec.exitCode);
    }
    return result(0, exec.rawStdout, exec.sessionId);
  } finally {
    if (tempCwd) {
      try {
        rmSync(tempCwd, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * `runOnPty` on an ephemeral entry with one wall-clock deadline over admission,
 * spawn and turn (the supervisor bounds each stage separately). The deadline and
 * `signal` abort the same controller, which retires the entry mid-turn.
 */
export async function runEphemeralWithDeadline(
  sessionKey: string,
  prompt: string,
  opts: Omit<Parameters<typeof runOnPty>[2], "signal" | "ephemeral">,
  signal?: AbortSignal,
): Promise<RunOnPtyResult & { timedOut: boolean; aborted: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exec = await runOnPty(sessionKey, prompt, {
      ...opts,
      ephemeral: true,
      signal: controller.signal,
    });
    // A turn that produced its result stands, even if the timer or a cancel
    // fired while the PTY was being torn down afterwards.
    const failed = exec.exitCode !== 0;
    return {
      ...exec,
      timedOut: failed && timedOut,
      aborted: failed && !timedOut && controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function ensureSpawnPty(): Promise<SpawnPty> {
  if (_spawnPty) return _spawnPty;
  // Lazy real import. In Phase C, this resolves to engineer-pty-core's
  // pty-process.ts implementation. In Phase B (this worktree), the file
  // doesn't exist yet — but every test path injects a fake via
  // injectSpawnPty() before calling runOnPty, so this branch is never
  // taken in tests. If it IS taken at runtime without the real module
  // present, we throw a clear error.
  try {
    // The string is constructed to avoid bundler resolution at build time.
    // Phase C ships ./pty-process.ts in the merged worktree and this works.
    const moduleSpecifier = "./pty-process";
    const mod = (await import(moduleSpecifier)) as { spawnPty?: SpawnPty };
    if (mod.spawnPty) {
      _spawnPty = mod.spawnPty;
      return mod.spawnPty;
    }
    throw new Error("module loaded but spawnPty not exported");
  } catch (err) {
    throw new Error(
      `[pty-supervisor] spawnPty implementation not available. ` +
        `In tests, call injectSpawnPty() before any runOnPty. ` +
        `At runtime, engineer-pty-core's pty-process.ts must be present. ` +
        `Cause: ${(err as Error).message}`,
    );
  }
}

/**
 * Land a freshly spawned PTY on its entry — or dispose it if the entry is gone.
 *
 * Issue #385: a spawn or respawn whose caller gave up on its deadline keeps
 * running (`withDeadline` bounds the wait, not the work), and the entry can be
 * removed before it lands — LRU-evicted, reaped, `/kill`ed or shut down; each of
 * those disposes `entry.pty`, which is null or the dead PTY while a spawn is in
 * flight. Assigning `entry.pty` on an entry nothing tracks would orphan a claude
 * process plus its MCP fleet, and the next turn on the key would spawn a second
 * one beside it. Dispose the late arrival instead and fail the spawn.
 */
async function landPty(entry: PtyEntry, pty: PtyProcess): Promise<void> {
  if (isCurrentEntry(entry)) {
    entry.pty = pty;
    return;
  }
  try {
    await pty.dispose();
  } catch {
    // best-effort
  }
  throw new EntryRemovedError(entry.sessionKey, "disposed the late PTY");
}

/** True while `entry` is the live entry for its key: tracked in `state.ptys`
 *  and not being retired. Every removal path sets `retiring` synchronously
 *  before its first await, so a (re)spawn landing at any point of a removal
 *  sees `false` — there is no window. */
function isCurrentEntry(entry: PtyEntry): boolean {
  return state.ptys.get(entry.sessionKey) === entry && !entry.retiring;
}

/**
 * Retire an entry: dispose its PTY, release its MCP identity and config, and
 * take it out of the map — in that order, with `retiring` set before the first
 * await. The single removal primitive for reap, LRU eviction, `/kill` and
 * shutdown (#385, Copilot on #391). Keeping the entry in the map until the
 * release has finished is what stops a replacement on the same key from being
 * admitted while the old identity is still being revoked; `retiring` is what
 * stops a late (re)spawn from landing on it meanwhile. Idempotent: a second
 * caller joins the first retirement.
 */
function retireEntry(entry: PtyEntry): Promise<void> {
  if (entry.retiring) return entry.retiring;
  const run = (async () => {
    // A first-turn spawn failure may be releasing this key right now; let it
    // finish before releasing again, so nothing keyed by sessionKey is still
    // in flight when the replacement this retirement unblocks is admitted.
    if (entry.releasing) await entry.releasing.catch(() => {});
    // Dispose and release CONCURRENTLY, as `/kill` and shutdown always did: a
    // PTY whose exit never arrives must not keep the bearer and config live.
    // Join a dispose a respawn already started — a second `dispose()` on the
    // same PTY returns immediately, which would let this retirement finish
    // while the old process is still being torn down.
    try {
      const disposal = entry.disposing ?? entry.pty?.dispose() ?? Promise.resolve();
      await Promise.allSettled([
        disposal,
        // Release multiplexer identity + delete synthesized config (SPEC §4.5).
        releaseMcpIdentityFor(entry),
      ]);
    } finally {
      // Unconditional: an entry left in the map with `retiring` settled would
      // spin every admission on its key (and the shutdown loop) forever.
      if (state.ptys.get(entry.sessionKey) === entry) state.ptys.delete(entry.sessionKey);
    }
  })();
  entry.retiring = run;
  return run;
}

/**
 * The entry a (re)spawn was working for is being retired or is gone. Distinct
 * type so the callers can tell it from a spawn failure: there is nothing to
 * retry — the key may already have a NEW entry.
 */
class EntryRemovedError extends Error {
  constructor(sessionKey: string, detail: string) {
    super(`[pty-supervisor] ${sessionKey} was retired while its spawn was in flight — ${detail}`);
    this.name = "EntryRemovedError";
  }
}

async function spawnEntry(
  entry: PtyEntry,
  modelOverride: string | undefined,
  api: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<void> {
  const spawn = await ensureSpawnPty();
  const spawnOpts = await buildSpawnOptions(
    entry,
    modelOverride,
    api,
    securityArgs,
    appendSystemPrompt,
  );
  entry.spawnOpts = spawnOpts;

  // Issue #81 self-heal: claude 2.1.89 blocks on an interactive trust prompt
  // the first time it's invoked in a cwd. We pre-write `hasTrustDialogAccepted
  // = true` to ~/.claude.json so the prompt is skipped. Best-effort — a
  // failure here doesn't block spawn; if trust isn't acked, the supervisor's
  // existing idle-timeout / sentinel-max-wait paths will surface the stall.
  // An untrusted one-shot runs in a throwaway directory: nothing to remember.
  if (entry.scope.isolation !== "untrusted") {
    try {
      const heal = (await ensureTrust(spawnOpts.cwd)) as
        | { ok?: boolean; reason?: string }
        | undefined;
      if (heal && !heal.ok && heal.reason) {
        // Surface to stderr-equivalent for operator visibility. Don't fail the
        // spawn — the user can still recover by manually accepting the prompt.
        console.warn(`[pty-supervisor] trust self-heal failed: ${heal.reason}`);
      }
    } catch {
      // Defensive — the function is meant to never throw, but if it does we
      // proceed anyway.
    }
  }

  try {
    // #385: `ensureTrustAccepted` awaited above; a retirement that started
    // meanwhile has already released this key's identity and config. Do not
    // spawn a claude nobody will track.
    if (!isCurrentEntry(entry)) {
      throw new EntryRemovedError(entry.sessionKey, "not spawning for a retired entry");
    }
    await landPty(entry, await spawn(spawnOpts));
    // Stamp the (re)spawn time so the reaper's spawn-grace window restarts
    // from now — see PtyEntry.lastSpawnedAt + reapIdle.
    entry.lastSpawnedAt = _clock();
  } catch (err) {
    // If the spawn itself failed AFTER we synthesized an --mcp-config file,
    // clean up the on-disk artifact so the next attempt doesn't leak it on
    // permanent failure. Best-effort — caller surfaces the spawn error.
    //
    // Only while this entry is still the live one for its key (#385). Once a
    // retirement has started, its own release covers this key's identity and
    // config (synthesis after that point is refused above, so nothing newer
    // exists), and a release from here could overlap the admission of a
    // replacement on the same key and revoke ITS bearer — identity and config
    // are keyed by sessionKey. Deciding on `isCurrentEntry` right before the
    // release is safe: a retirement cannot start between the check and the
    // release's first effect without `retiring` being set first.
    if (spawnOpts.mcpConfigPath && isCurrentEntry(entry)) {
      // Published on the entry so a retirement that starts during this await
      // joins it before its own release (see `retireEntry`).
      const releasing = releaseMcpIdentityFor(entry).finally(() => {
        if (entry.releasing === releasing) entry.releasing = undefined;
      });
      entry.releasing = releasing;
      await releasing;
      entry.spawnOpts = { ...spawnOpts, mcpConfigPath: undefined };
    }
    throw err;
  }

  // Phase D fix (Codex HIGH #2): persist a freshly pre-allocated session ID
  // to disk immediately after spawn — not on first-turn completion. If the
  // daemon dies between spawn and the first response (idle reap, /kill,
  // crash, restart), the conversation is still resumable via --resume <id>
  // on next message for the same sessionKey.
  // #385: not for an entry retired while the spawn landed — its write could
  // land after a same-key replacement's and point the next resume at the
  // wrong session.
  if (spawnOpts.newSessionId && isCurrentEntry(entry)) {
    try {
      await persistSessionId(entry, spawnOpts.newSessionId);
    } catch {
      // Best-effort. If the on-disk write fails (filesystem error), the live
      // PTY still has the UUID in its own state; persistence will be retried
      // on the first runTurn completion via the existing post-turn path.
    }
  }
}

async function respawnEntry(
  entry: PtyEntry,
  respawnOpts: { dropResume?: boolean } = {},
): Promise<void> {
  if (!entry.spawnOpts) {
    throw new Error(
      `[pty-supervisor] cannot respawn ${entry.sessionKey} — no cached spawn options`,
    );
  }
  // Normally resume against the last-known session ID — Claude Code keeps the
  // JSONL on disk after a crash, so --resume <id> picks up where we left off.
  //
  // Issue #177 corrupted-session escape hatch: when the retry loop signals
  // `dropResume: true` (the final attempt after prior failures), abandon
  // --resume and let claude start a fresh session. Trade the conversation
  // state for an unstuck agent. The persistSessionId post-turn path will
  // record the fresh id once the new claude completes its first turn.
  //
  // Why only on prior failures: firing on the very first respawn attempt
  // would abandon sessions even when respawnRetries=1 (the operator opt-out
  // for fast-fail behaviour, see #175), silently breaking conversation
  // continuity. The caller (respawnEntryWithRetries) only sets
  // `dropResume: true` when `i > 0` AND `i === attempts - 1`.
  const lastSessionId = entry.pty?.sessionId ?? entry.spawnOpts.sessionId;
  // `!!lastSessionId` guard: no point abandoning a resume if there's no
  // session id to abandon — silently no-op rather than logging an empty id.
  const abandonResume = !!respawnOpts.dropResume && !!lastSessionId;
  if (abandonResume) {
    process.stderr.write(
      `[pty-supervisor] dropping --resume for ${entry.sessionKey} on final respawn attempt — corrupted-session escape hatch; abandoned sessionId=${lastSessionId} (inspect or remove ~/.claude/projects/<cwd-slug>/${lastSessionId}.jsonl if the crash recurs)\n`,
    );
  }
  // When abandoning the resume, we need to MINT a fresh `newSessionId`
  // distinct from the poisoned UUID. Two issues we're avoiding:
  //
  //   1. If we kept `entry.spawnOpts.newSessionId` (the original pre-
  //      allocated UUID), `buildClaudeArgs` (pty-process.ts:251-253) would
  //      fall back to `--session-id <old-uuid>` for the empty `sessionId`
  //      and re-bind the "fresh" claude to the SAME UUID that owns the
  //      corrupted JSONL — silently defeating the escape hatch. This was
  //      a confidence-92 finding from the 5-agent review.
  //
  //   2. If we cleared `newSessionId` entirely (initial fix), claude would
  //      start a fresh session but `PtyProcessImpl._sessionId` would be ""
  //      (pty-process.ts:333-334 derives only from sessionId|newSessionId).
  //      Every subsequent `runTurn` would return an empty sessionId,
  //      `persistSessionId` would no-op (line 1386 `if (!sessionId) return`),
  //      and the recovered conversation could not be saved / resumed after
  //      an idle reap, `/kill`, or daemon restart — Codex P2 on PR #183.
  //
  // Minting a fresh UUID via `_newSessionId()` (the same generator used by
  // `buildSpawnOptions`) lets the post-turn `persistSessionId` path write
  // it through and keeps recovery working.
  const freshNewSessionId = abandonResume ? _newSessionId() : undefined;
  const opts: PtyProcessOptions = {
    ...entry.spawnOpts,
    sessionId: abandonResume ? "" : (lastSessionId ?? ""),
    ...(abandonResume ? { newSessionId: freshNewSessionId } : {}),
  };

  // MCP multiplexer (SPEC §4.5 "Respawn behaviour"): rotate the bearer token
  // on crash-respawn. A crashed PTY may have leaked its bearer via core dump,
  // so we don't reuse it. We DO keep the same on-disk path (it's keyed on
  // ptyId) — `writeConfigForPty` overwrites idempotently.
  //
  // We do NOT revoke the multiplexer identity here — the same ptyId continues
  // (this is a respawn, not a permanent dispose). `issueIdentity(ptyId)` is
  // expected to either return the cached identity OR rotate (W1's choice).
  // The writer just embeds whatever the issuer hands back into the new file.
  if (entry.spawnOpts.mcpConfigPath && !entry.scope.mcpConfig) {
    const settings = getSettings();
    const refreshedPath = synthesizeMcpConfigIfActive(
      entry.sessionKey,
      entry.spawnOpts.cwd,
      settings,
    );
    if (refreshedPath) {
      opts.mcpConfigPath = refreshedPath;
    } else {
      // Synthesis is no longer active (operator dropped settings.mcp.shared
      // since the original spawn). Strip the stale path — claude will fall
      // back to default MCP discovery.
      delete opts.mcpConfigPath;
    }
  }

  const spawn = await ensureSpawnPty();
  // Best-effort dispose of the dead one (may already be exited). Kept on the
  // entry while it runs so a retirement racing this respawn joins it (#385).
  if (entry.pty) {
    const disposal = entry.pty.dispose().finally(() => {
      if (entry.disposing === disposal) entry.disposing = undefined;
    });
    entry.disposing = disposal;
    try {
      await disposal;
    } catch {
      // ignore
    }
  }
  entry.pty = null;
  // #385: the awaits above are where a retirement can start. Do not boot a
  // claude for a retired entry — it would run untracked until it landed.
  if (!isCurrentEntry(entry)) {
    throw new EntryRemovedError(entry.sessionKey, "not respawning a retired entry");
  }
  await landPty(entry, await spawn(opts));
  entry.spawnOpts = opts;
  // Reset the spawn-grace window on respawn so a healthy long-lived PTY that
  // crashes doesn't get immediately reaped before its first post-respawn turn
  // (Codex P1 on PR #149).
  entry.lastSpawnedAt = _clock();
}

/**
 * Issue #175: retry `respawnEntry()` itself.
 *
 * The outer `runTurnWithRetries` loop catches retryable `runTurn` failures
 * (PTY closed, turn timeout) and respawns the PTY between turns. Before this
 * helper existed, a single failed respawn would `return errorResult(...)`
 * and truncate the outer `maxRetries` envelope (default 5) to 1 attempt —
 * production observed 26% of `daily-digest` / `daily-content-research`
 * cron runs giving up after the first respawn failure with *"PTY for claude
 * exited before TUI settled"*.
 *
 * This helper retries `respawnEntry()` up to `max(1, opts.respawnRetries)`
 * times (the floor guards against accidental 0 from a test injection; the
 * config parser separately enforces ≥ 1 with default 3) with the existing
 * backoff schedule. On total exhaustion it throws the last error; the outer
 * loop wraps the thrown error in a "respawn failed after N attempts"
 * message and returns `errorResult(...)` for the operator.
 *
 * Issue #177 (corrupted-session escape hatch): when at least one attempt has
 * already failed and we're entering the final attempt, signal `respawnEntry`
 * to drop `--resume <sessionId>` and start a fresh claude. A poisoned session
 * JSONL would otherwise make every retry hit the same crash; trading the
 * conversation state for an unstuck agent is the right call. We only fire the
 * fallback when there were prior failures (`i > 0`) so `respawnRetries=1`
 * (the documented pre-#175 opt-out) keeps its original behaviour and never
 * abandons the session unilaterally.
 *
 * Issue #385: each attempt is bounded by the caller's `timeoutMs` and the
 * in-flight respawn is owned by the entry (`spawnInFlight`), mirroring the
 * first-turn spawn path from #369. A deadline ends the loop rather than
 * retrying: the respawn that did not settle is still running, and a second one
 * beside it would orphan whichever PTY landed first.
 */
async function respawnEntryWithRetries(
  entry: PtyEntry,
  opts: SupervisorOptions,
  timeoutMs: number,
): Promise<void> {
  const attempts = Math.max(1, opts.respawnRetries);
  let lastErr: unknown = new Error("respawnEntryWithRetries: no attempts made");
  for (let i = 0; i < attempts; i++) {
    const isFinalAttempt = i === attempts - 1;
    const hadPriorFailures = i > 0;
    const dropResume = isFinalAttempt && hadPriorFailures;
    // Issue #385: each attempt is bounded by the caller's `timeoutMs`, the
    // same way the first-turn spawn is. `respawnEntry` does the same work —
    // boot claude plus the MCP fleet — and ran here with no deadline, on the
    // crash-recovery path that a host under pressure is most likely to take.
    //
    // Ownership follows the first-turn rule: the in-flight respawn lives on
    // `entry.spawnInFlight`, so a caller that gives up leaves the next turn
    // joining it rather than spawning a second PTY onto the same entry. That
    // join happens at the top of `runTurnWithRetries`, under the per-key lock,
    // before this loop runs — so `spawnInFlight` is normally undefined here.
    // The join below is a defence for a path the lock should make
    // unreachable, not one the tests exercise; if it ever is reached, the
    // joined respawn counts as this caller's attempt `i`.
    //
    // A deadline also ends this caller's attempt count: the next caller
    // starts again at attempt 1, so the #177 `dropResume` escape hatch only
    // fires when respawns fail fast (the case it was written for). A session
    // that takes longer than `timeoutMs` to crash never reaches it — before
    // this change that caller hung instead.
    // The entry may have been evicted, reaped, killed or shut down while the
    // previous attempt ran. Respawning it would synthesize MCP config under a
    // key that may now belong to a replacement entry. Stop instead.
    if (!isCurrentEntry(entry)) {
      throw new EntryRemovedError(entry.sessionKey, "not respawning a removed entry");
    }
    let inFlight = entry.spawnInFlight;
    if (!inFlight) {
      const started: Promise<void> = respawnEntry(entry, { dropResume }).finally(() => {
        if (entry.spawnInFlight === started) entry.spawnInFlight = undefined;
      });
      started.catch(() => {});
      entry.spawnInFlight = started;
      inFlight = started;
    }
    try {
      await withDeadline(inFlight, timeoutMs);
      return;
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        // The respawn has not failed — it has not settled. Retrying now would
        // start a second spawn beside it, which is the orphan this guards
        // against. Stop here; the respawn stays owned by the entry.
        throw new Error(
          `respawn attempt ${i + 1} of ${attempts} for ${entry.sessionKey} exceeded ${timeoutMs}ms — claude or the MCP fleet did not come up; not retrying while it is still in flight`,
        );
      }
      // Same reason as the check above: the attempt landed on a removed entry.
      // A retry is not a recovery, it is a second spawn for a dead key.
      if (err instanceof EntryRemovedError) throw err;
      lastErr = err;
      if (isFinalAttempt) break;
      const delay = pickBackoff(opts.backoffMs, i);
      await _sleep(delay);
    }
  }
  throw lastErr;
}

async function runTurnWithRetries(
  entry: PtyEntry,
  prompt: string,
  callOpts: {
    timeoutMs: number;
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
    api?: string;
    securityArgs?: string[];
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
    signal?: AbortSignal;
  },
  supervisorOpts: SupervisorOptions,
): Promise<RunOnPtyResult> {
  // Lazy spawn on first turn for this key.
  //
  // Issue #369: this is where the unbounded wait actually lived. `timeoutMs`
  // is applied inside the retry loop below, so it bounds the TURN — but the
  // spawn that boots claude and the MCP fleet runs ahead of that loop with no
  // deadline of its own. A spawn that never settles hung the caller for as long
  // as the process lived: reported as "given timeoutMs 600_000 it sat the full
  // 600s", which is exactly this path.
  //
  // The issue attributed the stall to `admitEntry` -> `getOrCreateEntry`.
  // `getOrCreateEntry` does not spawn; the only `spawnEntry` call reachable on
  // the first-turn path is this one.
  //
  // Issue #385: an abandoned RESPAWN is also in flight here (see
  // `respawnEntryWithRetries`). While it runs, `entry.pty` may still be the
  // dead PTY it is replacing; running a turn on that would only fail into a
  // second respawn. Join the in-flight one instead.
  if (!entry.pty || entry.spawnInFlight) {
    // Abandoning the wait must not abandon ownership: keep the in-flight spawn
    // on the entry so the next caller awaits THIS one rather than starting a
    // second. Cleared on settle so a failed spawn stays retryable.
    if (!entry.spawnInFlight) {
      const inFlight = spawnEntry(
        entry,
        callOpts.modelOverride,
        callOpts.api,
        callOpts.securityArgs,
        callOpts.appendSystemPrompt,
      ).finally(() => {
        if (entry.spawnInFlight === inFlight) entry.spawnInFlight = undefined;
      });
      // A caller that walks away leaves nobody awaiting this; keep its rejection
      // from surfacing unhandled. Real callers still see it through their own await.
      inFlight.catch(() => {});
      entry.spawnInFlight = inFlight;
    }
    try {
      await withDeadline(entry.spawnInFlight, callOpts.timeoutMs);
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        return errorResult(
          `[pty-supervisor] PTY spawn for ${entry.sessionKey} exceeded ${callOpts.timeoutMs}ms — claude or the MCP fleet did not come up`,
        );
      }
      return errorResult(
        `[pty-supervisor] failed to spawn PTY for ${entry.sessionKey}: ${(err as Error).message}`,
      );
    }
  }

  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= supervisorOpts.maxRetries) {
    if (!entry.pty) {
      return errorResult(
        `[pty-supervisor] PTY for ${entry.sessionKey} unexpectedly null after spawn`,
      );
    }
    try {
      const result = await entry.pty.runTurn(prompt, {
        timeoutMs: callOpts.timeoutMs,
        onChunk: callOpts.onChunk,
        onToolEvent: callOpts.onToolEvent,
      });
      // Persist session ID if newly captured.
      await persistSessionId(entry, result.sessionId);
      return {
        rawStdout: result.text,
        stderr: "",
        exitCode: 0,
        sessionId: result.sessionId || undefined,
      };
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof PtyClosedError || err instanceof PtyTurnTimeoutError;
      if (!retryable) {
        return errorResult(
          `[pty-supervisor] non-retryable error on ${entry.sessionKey}: ${(err as Error).message}`,
        );
      }
      // #546: an aborted call does not respawn what the abort just retired.
      if (callOpts.signal?.aborted) {
        return errorResult(`[pty-supervisor] ${entry.sessionKey} aborted`);
      }
      // Exhausted? A one-shot run gets no turn retry: it holds no conversation
      // to recover, and a retry would double its caller's wall-clock budget.
      if (entry.scope.ephemeral || attempt >= supervisorOpts.maxRetries) break;

      const delay = pickBackoff(supervisorOpts.backoffMs, attempt);
      attempt += 1;
      await _sleep(delay);
      try {
        await respawnEntryWithRetries(entry, supervisorOpts, callOpts.timeoutMs);
      } catch (respawnErr) {
        return errorResult(
          `[pty-supervisor] respawn failed for ${entry.sessionKey} after up to ${supervisorOpts.respawnRetries} attempt(s) (outer turn-retry ${attempt}): ${(respawnErr as Error).message}`,
        );
      }
    }
  }

  return errorResult(
    `[pty-supervisor] max retries (${supervisorOpts.maxRetries}) exhausted for ${entry.sessionKey}: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

function pickBackoff(backoffMs: number[], attempt: number): number {
  if (backoffMs.length === 0) return 0;
  const idx = Math.min(attempt, backoffMs.length - 1);
  return Math.max(0, backoffMs[idx] ?? 0);
}

function errorResult(message: string): RunOnPtyResult {
  return {
    rawStdout: "",
    stderr: message,
    exitCode: 1,
    sessionId: undefined,
  };
}

async function persistSessionId(entry: PtyEntry, sessionId: string): Promise<void> {
  if (!sessionId || entry.scope.ephemeral) return;
  // Did we already know this ID? Then nothing to do.
  if (entry.spawnOpts?.sessionId && entry.spawnOpts.sessionId === sessionId) {
    return;
  }
  // Issue #89: if a record exists on disk but holds a DIFFERENT sessionId
  // (e.g. a phantom left over from a prior PTY whose first turn failed),
  // overwrite it with the fresh ID. createThreadSession / createSession
  // both overwrite unconditionally, so we drop the prior `!existing`
  // guard — that guard was the reason a stale-then-fresh sequence kept
  // the on-disk sessionId pinned to the stale value across all subsequent
  // messages, breaking conversation continuity even though the runtime
  // recovered cleanly.
  if (entry.scope.sessionStore) {
    if ((await entry.scope.sessionStore.load()) !== sessionId) {
      await entry.scope.sessionStore.save(sessionId);
    }
  } else if (entry.threadId) {
    const existing = await getThreadSession(entry.threadId);
    if (!existing || existing.sessionId !== sessionId) {
      await createThreadSession(entry.threadId, sessionId);
    }
  } else {
    const existing = await getSession(entry.agentName);
    if (!existing || existing.sessionId !== sessionId) {
      await createSession(sessionId, entry.agentName);
    }
  }
  if (entry.spawnOpts) {
    entry.spawnOpts = { ...entry.spawnOpts, sessionId };
  }
}

async function reapIdle(opts: SupervisorOptions): Promise<void> {
  const now = _clock();
  const cutoff = now - opts.idleReapMinutes * 60_000;
  // Issue #65 item 6: PTYs that never complete a first turn used to be skipped
  // forever, so a claude that crashed during spawn (or any case where
  // `lastTurnEndedAt` stays 0) would hold a slot under `maxConcurrent`
  // indefinitely. Give a generous grace period (3× idleReapMinutes) so slow
  // first-turn cases aren't false-positives, then reap by `lastSpawnedAt`.
  // Keying off `lastSpawnedAt` (not entry-creation time) lets a long-lived PTY
  // that crashes and respawns get a fresh grace window — Codex P1 on PR #149.
  const spawnGraceCutoff = now - opts.idleReapMinutes * 60_000 * 3;
  const toReap: PtyEntry[] = [];
  for (const entry of state.ptys.values()) {
    if (!entry.pty || entry.scope.ephemeral) continue;
    // Named agents stay alive forever when the flag is on.
    if (entry.kind === "named" && opts.namedAgentsAlwaysAlive) continue;
    const last = entry.pty.lastTurnEndedAt();
    if (last === 0) {
      // Mid-spawn or stuck. If `lastSpawnedAt === 0` we haven't even finished
      // the first spawn yet — leave it alone. Otherwise reap once we're past
      // the grace window counted from the most recent (re)spawn.
      if (entry.lastSpawnedAt !== 0 && entry.lastSpawnedAt < spawnGraceCutoff) {
        toReap.push(entry);
      }
      continue;
    }
    if (last < cutoff) toReap.push(entry);
  }
  for (const entry of toReap) {
    await retireEntry(entry);
  }
}
