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
 *     retries the SAME prompt up to `maxRetries` times. After exhaustion the
 *     supervisor surfaces a structured error in RunOnPtyResult.stderr and
 *     exitCode=1; execClaude treats this as any other non-zero exit.
 *
 *   - Settings are re-read via getSettings() on every call — never cached
 *     across calls — so hot-reload works. The reap interval is rebuilt
 *     whenever initSupervisor() is called with a new idleReapMinutes.
 */
import type {
  PtyProcess,
  PtyProcessOptions,
  SpawnPty,
} from "./pty-process";
import { PtyClosedError, PtyTurnTimeoutError } from "./pty-process";
import { getSettings, type SecurityConfig } from "../config";
import { getSession, createSession } from "../sessions";
import { getThreadSession, createThreadSession } from "../sessionManager";

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

// Lazy imports of the canonical env-sanitiser + security-args builder from
// runner.ts (same circular-import dance as ensureAgentDir). Phase D fixes
// #1 / #3: keep one source of truth for the strip list AND for permission-
// mode argv so the PTY path can't silently diverge from `claude -p` policy.
type CleanSpawnEnvFn = () => Record<string, string>;
type BuildSecurityArgsFn = (security: SecurityConfig) => string[];
let _cleanSpawnEnv: CleanSpawnEnvFn | null = null;
let _buildSecurityArgs: BuildSecurityArgsFn | null = null;
async function getRunnerHelpers(): Promise<{
  cleanSpawnEnv: CleanSpawnEnvFn;
  buildSecurityArgs: BuildSecurityArgsFn;
}> {
  if (_cleanSpawnEnv && _buildSecurityArgs) {
    return { cleanSpawnEnv: _cleanSpawnEnv, buildSecurityArgs: _buildSecurityArgs };
  }
  const mod = (await import("../runner")) as {
    cleanSpawnEnv?: CleanSpawnEnvFn;
    buildSecurityArgs?: BuildSecurityArgsFn;
  };
  if (!mod.cleanSpawnEnv) {
    throw new Error("[pty-supervisor] runner.ts does not export cleanSpawnEnv");
  }
  if (!mod.buildSecurityArgs) {
    throw new Error("[pty-supervisor] runner.ts does not export buildSecurityArgs");
  }
  _cleanSpawnEnv = _cleanSpawnEnv ?? mod.cleanSpawnEnv;
  _buildSecurityArgs = _buildSecurityArgs ?? mod.buildSecurityArgs;
  return { cleanSpawnEnv: _cleanSpawnEnv, buildSecurityArgs: _buildSecurityArgs };
}
async function getCleanSpawnEnv(): Promise<CleanSpawnEnvFn> {
  const h = await getRunnerHelpers();
  return h.cleanSpawnEnv;
}

/** For tests only. Stub the runner helpers (cleanSpawnEnv + buildSecurityArgs). */
export function injectRunnerHelpers(opts: {
  cleanSpawnEnv?: CleanSpawnEnvFn | null;
  buildSecurityArgs?: BuildSecurityArgsFn | null;
}): void {
  if (opts.cleanSpawnEnv !== undefined) _cleanSpawnEnv = opts.cleanSpawnEnv;
  if (opts.buildSecurityArgs !== undefined) _buildSecurityArgs = opts.buildSecurityArgs;
}

/** Back-compat shim — fix #1's test used this name. Same behaviour. */
export function injectCleanSpawnEnv(fn: CleanSpawnEnvFn | null): void {
  _cleanSpawnEnv = fn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — frozen by SPEC §3.2.

export interface SupervisorOptions {
  idleReapMinutes: number;
  maxRetries: number;
  backoffMs: number[];
  namedAgentsAlwaysAlive: boolean;
}

export interface RunOnPtyResult {
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
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
    /** "named" → never reaped; "adhoc" → reaped after idle. */
    kind: "named" | "adhoc" | "global";
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test seams.

let _spawnPty: SpawnPty | null = null;
let _clock: () => number = () => Date.now();
let _sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise<void>((r) => setTimeout(r, ms));

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

/**
 * For tests only. Force one reap pass using the caller-supplied clock.
 * Bypasses the timer cadence so tests can advance fake time arbitrarily.
 */
export async function __reapNowForTests(clock?: () => number): Promise<void> {
  if (clock) injectClock(clock);
  const opts = readSupervisorOptions();
  await reapIdle(opts);
}

/** For tests only. Wipe all internal state. */
export function __resetSupervisorForTests(): void {
  for (const entry of state.ptys.values()) {
    try {
      void entry.pty?.dispose();
    } catch {
      // ignore
    }
  }
  state.ptys.clear();
  if (state.reapTimer) {
    clearInterval(state.reapTimer);
    state.reapTimer = null;
  }
  state.initialised = false;
  _spawnPty = null;
  _ensureAgentDir = null;
  _cleanSpawnEnv = null;
  _buildSecurityArgs = null;
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
}

interface SupervisorState {
  ptys: Map<string, PtyEntry>;
  reapTimer: ReturnType<typeof setInterval> | null;
  initialised: boolean;
}

const state: SupervisorState = {
  ptys: new Map(),
  reapTimer: null,
  initialised: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API.

/**
 * Initialise the supervisor at daemon startup. Idempotent.
 * Lazy-spawn strategy: named-agent PTYs spawn on first event, not here.
 */
export async function initSupervisor(): Promise<void> {
  const settings = getSettings();
  const opts: SupervisorOptions = {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: settings.pty.maxRetries,
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
  const disposals: Promise<void>[] = [];
  for (const entry of state.ptys.values()) {
    if (entry.pty) {
      disposals.push(
        entry.pty.dispose().catch(() => {
          // Best-effort.
        }),
      );
    }
  }
  await Promise.allSettled(disposals);
  state.ptys.clear();
  state.initialised = false;
}

/**
 * Snapshot of supervisor state for /status and tests.
 * Order-stable: sorted by sessionKey.
 */
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
    /** Phase D fix #3: pre-built security argv from runner.ts:buildSecurityArgs. */
    securityArgs?: string[];
    /** Phase D fix #2: assembled --append-system-prompt payload. */
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
  },
): Promise<RunOnPtyResult> {
  const supervisorOpts = readSupervisorOptions();

  // Per-key serial lock. Different keys proceed in parallel.
  const entry = await getOrCreateEntry(sessionKey, opts);
  const previousLock = entry.lock;
  let release: () => void = () => {};
  entry.lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previousLock;
    return await runTurnWithRetries(entry, prompt, opts, supervisorOpts);
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals.

function readSupervisorOptions(): SupervisorOptions {
  const settings = getSettings();
  return {
    idleReapMinutes: settings.pty.idleReapMinutes,
    maxRetries: settings.pty.maxRetries,
    backoffMs: settings.pty.backoffMs,
    namedAgentsAlwaysAlive: settings.pty.namedAgentsAlwaysAlive,
  };
}

function classifyKey(
  sessionKey: string,
  threadId?: string,
  agentName?: string,
): SessionKind {
  // Match the conventions in SPEC §3.2 + §5.2.
  if (sessionKey.startsWith("thread:") || threadId) return "adhoc";
  if (sessionKey.startsWith("agent:") || agentName) return "named";
  return "global";
}

async function getOrCreateEntry(
  sessionKey: string,
  opts: {
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
  },
): Promise<PtyEntry> {
  const existing = state.ptys.get(sessionKey);
  if (existing) return existing;

  const kind = classifyKey(sessionKey, opts.threadId, opts.agentName);
  const entry: PtyEntry = {
    sessionKey,
    kind,
    threadId: opts.threadId,
    agentName: opts.agentName,
    pty: null,
    spawnOpts: null,
    lock: Promise.resolve(),
  };
  state.ptys.set(sessionKey, entry);
  return entry;
}

async function buildSpawnOptions(
  entry: PtyEntry,
  modelOverride: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<PtyProcessOptions> {
  const settings = getSettings();
  const { security } = settings;

  // Resolve cwd:
  //   - agent  → agents/<name> (created if needed)
  //   - thread → repo root (process.cwd())
  //   - global → repo root
  const cwd = entry.agentName
    ? await ensureAgentDirLazy(entry.agentName)
    : process.cwd();

  // Resume from stored session ID where available.
  let sessionId = "";
  if (entry.threadId) {
    const t = await getThreadSession(entry.threadId);
    sessionId = t?.sessionId ?? "";
  } else if (entry.agentName) {
    const a = await getSession(entry.agentName);
    sessionId = a?.sessionId ?? "";
  } else {
    const g = await getSession();
    sessionId = g?.sessionId ?? "";
  }

  // Phase D fix #1: canonical env-sanitiser from runner.ts. Don't reinvent
  // the strip list — divergence here re-introduces the ANTHROPIC_API_KEY
  // billing leak.
  //
  // Phase D fix #3: derive securityArgs from runner.ts:buildSecurityArgs
  // when the caller didn't pre-build them (e.g. legacy tests). The supervisor
  // is otherwise allowed to pass through whatever the caller assembled.
  const cleanEnv = await getCleanSpawnEnv();
  let resolvedSecurityArgs = securityArgs;
  if (!resolvedSecurityArgs) {
    try {
      const { buildSecurityArgs } = await getRunnerHelpers();
      resolvedSecurityArgs = buildSecurityArgs(security);
    } catch {
      // Fall through — buildClaudeArgs will use its internal legacy
      // derivation when securityArgs is undefined.
      resolvedSecurityArgs = undefined;
    }
  }

  return {
    sessionId,
    cwd,
    agentName: entry.agentName,
    modelOverride: modelOverride ?? undefined,
    security: cloneSecurity(security),
    securityArgs: resolvedSecurityArgs,
    appendSystemPrompt,
    env: cleanEnv(),
    cols: settings.pty.cols,
    rows: settings.pty.rows,
    turnIdleTimeoutMs: settings.pty.turnIdleTimeoutMs,
  };
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

async function spawnEntry(
  entry: PtyEntry,
  modelOverride: string | undefined,
  securityArgs: string[] | undefined,
  appendSystemPrompt: string | undefined,
): Promise<void> {
  const spawn = await ensureSpawnPty();
  const spawnOpts = await buildSpawnOptions(
    entry,
    modelOverride,
    securityArgs,
    appendSystemPrompt,
  );
  entry.spawnOpts = spawnOpts;
  entry.pty = await spawn(spawnOpts);
}

async function respawnEntry(entry: PtyEntry): Promise<void> {
  if (!entry.spawnOpts) {
    throw new Error(`[pty-supervisor] cannot respawn ${entry.sessionKey} — no cached spawn options`);
  }
  // Always resume against the last-known session ID — Claude Code keeps the
  // JSONL on disk after a crash, so --resume <id> picks up where we left off.
  const lastSessionId = entry.pty?.sessionId ?? entry.spawnOpts.sessionId;
  const opts: PtyProcessOptions = {
    ...entry.spawnOpts,
    sessionId: lastSessionId ?? "",
  };
  const spawn = await ensureSpawnPty();
  // Best-effort dispose of the dead one (may already be exited).
  if (entry.pty) {
    try {
      await entry.pty.dispose();
    } catch {
      // ignore
    }
  }
  entry.pty = null;
  entry.pty = await spawn(opts);
  entry.spawnOpts = opts;
}

async function runTurnWithRetries(
  entry: PtyEntry,
  prompt: string,
  callOpts: {
    timeoutMs: number;
    threadId?: string;
    agentName?: string;
    modelOverride?: string;
    securityArgs?: string[];
    appendSystemPrompt?: string;
    onChunk?: (text: string) => void;
    onToolEvent?: (line: string) => void;
  },
  supervisorOpts: SupervisorOptions,
): Promise<RunOnPtyResult> {
  // Lazy spawn on first turn for this key.
  if (!entry.pty) {
    try {
      await spawnEntry(
        entry,
        callOpts.modelOverride,
        callOpts.securityArgs,
        callOpts.appendSystemPrompt,
      );
    } catch (err) {
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
      const retryable =
        err instanceof PtyClosedError || err instanceof PtyTurnTimeoutError;
      if (!retryable) {
        return errorResult(
          `[pty-supervisor] non-retryable error on ${entry.sessionKey}: ${(err as Error).message}`,
        );
      }
      // Exhausted?
      if (attempt >= supervisorOpts.maxRetries) break;

      const delay = pickBackoff(supervisorOpts.backoffMs, attempt);
      attempt += 1;
      await _sleep(delay);
      try {
        await respawnEntry(entry);
      } catch (respawnErr) {
        return errorResult(
          `[pty-supervisor] respawn failed for ${entry.sessionKey} after ${attempt} attempt(s): ${(respawnErr as Error).message}`,
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
  if (!sessionId) return;
  // Did we already know this ID? Then nothing to do.
  if (entry.spawnOpts?.sessionId && entry.spawnOpts.sessionId === sessionId) {
    return;
  }
  // First-time capture — write to the right store and update our cached opts.
  if (entry.threadId) {
    const existing = await getThreadSession(entry.threadId);
    if (!existing) {
      await createThreadSession(entry.threadId, sessionId);
    }
  } else {
    const existing = await getSession(entry.agentName);
    if (!existing) {
      await createSession(sessionId, entry.agentName);
    }
  }
  if (entry.spawnOpts) {
    entry.spawnOpts = { ...entry.spawnOpts, sessionId };
  }
}

async function reapIdle(opts: SupervisorOptions): Promise<void> {
  const cutoff = _clock() - opts.idleReapMinutes * 60_000;
  const toReap: PtyEntry[] = [];
  for (const entry of state.ptys.values()) {
    if (!entry.pty) continue;
    // Named agents stay alive forever when the flag is on.
    if (entry.kind === "named" && opts.namedAgentsAlwaysAlive) continue;
    const last = entry.pty.lastTurnEndedAt();
    // A PTY that has never finished a turn is mid-spawn — leave it alone.
    if (last === 0) continue;
    if (last < cutoff) toReap.push(entry);
  }
  for (const entry of toReap) {
    if (entry.pty) {
      try {
        await entry.pty.dispose();
      } catch {
        // ignore
      }
    }
    state.ptys.delete(entry.sessionKey);
  }
}
