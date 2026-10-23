import { mkdir, readFile, writeFile, realpath } from "fs/promises";
import { join, dirname, resolve, sep } from "path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import {
  getSession,
  createSession,
  resetSession,
  incrementTurn,
  markCompactWarned,
  getFallbackSession,
  createFallbackSession,
  resetFallbackSession,
  incrementFallbackTurn,
  peekSession,
  incrementMessageCount,
  backupSession,
} from "./sessions";
import { needsRotation, rotateSession, loadLatestSummary } from "./rotation";
import { actOnSession, saveMemoryBeforeCompact } from "./runner/live-session-actions";
import {
  getThreadSession,
  createThreadSession,
  removeThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import {
  getSettings,
  DEFAULT_SESSION_TIMEOUT_MS,
  NATIVE_SCHEDULING_TOOLS_BLOCKLIST,
  type ModelConfig,
  type SecurityConfig,
  type AgenticMode,
} from "./config";
import { buildClockPromptPrefix } from "./timezone";
import {
  selectModel as governanceSelectModel,
  configureRouter as configureGovernanceRouter,
} from "./governance/model-router";
import { setModeDispatchSink, fileModeDispatchSink } from "./governance/mode-dispatch-journal";
import {
  recordInvocationStart,
  recordInvocationCompletion,
  recordInvocationFailure,
  extractTranscriptUsage,
  type EstimatedCost,
  type UsageMetrics,
} from "./governance/usage-tracker";
import { calculateEstimatedCost } from "./governance/budget-engine";
import {
  recordExecutionMetric,
  checkLimits,
  clearInvocation as watchdogClearInvocation,
  handleTrigger as watchdogHandleTrigger,
} from "./governance/watchdog";
import {
  startSession as watchdogStart,
  recordResult as watchdogRecord,
  abortReason as watchdogAbortReason,
  clearSession as watchdogClear,
} from "./watchdog";
import { getGovernanceClient, type GovernanceClient } from "./governance/client";
import {
  loadMemory,
  loadMemoryInstructions,
  ensureMemoryFile,
  getMemoryPath,
  indexSessionsBackground,
} from "./memory";
import { loadAgent } from "./agents";
import { validateModelString } from "./jobs";
import { selectModel } from "./model-router";
import { recordResult, abortReason, clearSession, startSession } from "./watchdog";
import { getPluginManager, type EventContext } from "./plugins";
import {
  runOnPty,
  killAllPtys,
  supervisorEntryCount,
  retirePtySession,
  liveSessionKeys,
  type PtySessionStore,
  type PtyUnsafeReplayKind,
  runEphemeralWithDeadline,
} from "./runner/pty-supervisor";
import {
  assertSessionSpawnable,
  assertSessionWritable,
  PtyQuarantinedError,
} from "./runner/pty-quarantine";
import { encodeCwdForProjectsDir } from "./bus/jsonl-line-types";
import { PTY_OUTPUT_FORMAT_CONSTRAINT } from "./runner/pty-output-format";
import { SPAWN_ENV_STRIP_KEYS, cleanSpawnEnv, shouldStripSpawnEnvKey } from "./runner/spawn-env";
import {
  endsInRenderedSignatureError,
  signatureErrorWarrantsReset,
} from "./runner/signature-error";
import {
  CLAUDE_EXECUTABLE,
  _setClaudeExecutableForTests,
  claudeExecutable,
} from "./runner/claude-executable";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");

// Initialize governance router with agentic modes from settings
let governanceInitialized = false;
function ensureGovernanceRouter(modes?: AgenticMode[], defaultMode?: string): void {
  if (!governanceInitialized && modes && defaultMode) {
    configureGovernanceRouter({
      modes,
      defaultMode,
      defaultProvider: "anthropic",
      defaultModel: "claude-3-5-sonnet",
    });
    // Activate mode_dispatch telemetry: from here, each keyword/phrase route is
    // journalled for the tuner's routing_reclassify_rate (inert until now).
    setModeDispatchSink(fileModeDispatchSink());
    governanceInitialized = true;
  }
}

const ACTIVE_RUNS_FILE = join(process.cwd(), ".claude/claudeclaw/active-runs");
const PERMISSION_MODE_FILE = join(process.cwd(), ".claude/claudeclaw/permission-mode.json");
// Resolve prompts relative to the claudeclaw installation, not the project dir
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

export { _setClaudeExecutableForTests, claudeExecutable };

/** Versions of the Claude Code CLI whose interactive TTY output the PTY parser
 *  has been validated against (see .planning/pty-migration/SPEC.md §2 and the
 *  golden fixture at .planning/pty-migration/fixtures/turn-boundary-sample.txt).
 *  Other versions may still work — the parser also has a turnIdleTimeoutMs
 *  safety net — but a mismatch here means we cannot guarantee turn-boundary
 *  detection. Add a version after empirical validation. */
const KNOWN_GOOD_CLAUDE_VERSIONS = ["2.1.141"];

/** Probe `claude --version` at daemon startup and log the result. Warns if the
 *  installed version isn't in the known-good list — does NOT block startup. */
export async function probeClaudeCliVersion(): Promise<{ version: string | null; known: boolean }> {
  try {
    const proc = Bun.spawn([CLAUDE_EXECUTABLE, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // `claude --version` prints something like "2.1.141 (Claude Code)" — extract
    // the leading semver-ish token. We don't enforce strict semver here.
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    const version = match ? match[1] : null;
    const known = version !== null && KNOWN_GOOD_CLAUDE_VERSIONS.includes(version);
    return { version, known };
  } catch {
    return { version: null, known: false };
  }
}

/**
 * Compact configuration.
 * COMPACT_WARN_THRESHOLD: notify user that context is getting large.
 * COMPACT_TIMEOUT_ENABLED: whether to auto-compact on timeout (exit 124). This applies
 * to the print (`claude -p`) path only. A PTY turn timeout is also exit 124 (so the
 * watchdog and the timeout messages see it), and the supervisor retires the PTY, but the
 * runner neither compacts nor re-runs it: it is usually a turn-detection miss on a
 * healthy session, and the interactive REPL compacts its own context.
 */
const COMPACT_WARN_THRESHOLD = 25;
const COMPACT_TIMEOUT_ENABLED = true;

/**
 * Build a sanitized env for spawning the `claude` CLI as a long-running daemon
 * subprocess. Drops env vars injected by a parent Claude Code / Claude Desktop
 * session that break detached child auth:
 *
 * - `CLAUDECODE`: marks "we're nested inside Claude Code" — confuses the CLI's
 *   reentry detection and triggers transcript-aware behaviour we don't want.
 * - `CLAUDE_CODE_OAUTH_TOKEN`: the parent's frozen OAuth access token. Without
 *   the matching refresh token (which lives in the platform-native credential
 *   store, not the env), it expires after ~8h and the daemon's spawned `claude`
 *   processes start returning HTTP 401 silently. Stripping it lets the CLI
 *   fall back to the credential store on each platform — Keychain on macOS,
 *   `~/.claude/.credentials.json` on Linux/WSL2, Credential Manager on Windows
 *   — which handles refresh automatically.
 * - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`: tells the CLI "the host process
 *   manages provider auth — don't read local credentials." In a detached
 *   daemon there is no host to consult; the CLI errors with `Not logged in`.
 * - `ANTHROPIC_API_KEY`: a raw API key in the daemon's environment (e.g. from
 *   a .env file that also serves other tools like MCP servers). Claude Code
 *   treats `ANTHROPIC_API_KEY` with higher priority than the credential store,
 *   so if left in the child env it bypasses OAuth entirely and bills against
 *   API credits rather than the user's Claude subscription.
 *
 * Cross-platform note: the helper just deletes keys from the inherited env
 * object — no shell, no OS-specific calls. The `claude` CLI it spawns then
 * resolves credentials using its own per-platform code path.
 */
// Moved to a leaf module; re-exported for existing importers.
export { cleanSpawnEnv, shouldStripSpawnEnvKey };

/**
 * Run `fn` with `SPAWN_ENV_STRIP_KEYS` temporarily deleted from `process.env`,
 * then restore the originals. Required because `bun-pty`'s Rust wrapper does
 * NOT call `CommandBuilder::env_clear()` — `portable_pty` MERGES the
 * caller-supplied env with the parent process env at fork() time, so just
 * passing a sanitised env Record (`cleanSpawnEnv()`) is not enough. The
 * spawned `claude` still sees `ANTHROPIC_API_KEY` from the daemon's
 * `process.env` (typically loaded from `/etc/claudeclaw/.claudeclaw-env`),
 * triggers the "Detected a custom API key" interactive gate in claude 2.1.89,
 * and dumps the prompt — with a truncated key — into the PTY. That output
 * then leaks to the user-visible surface (Discord, Telegram, etc.).
 *
 * Safety: This mutates global state. It is ONLY race-free because:
 *   1. Bun is single-threaded JS — no preemption between sync statements.
 *   2. `bun-pty.spawn` is a synchronous FFI call: it does fork+exec inside
 *      the Rust shared library and returns the handle BEFORE the JS event
 *      loop resumes. The child inherits the parent's env at fork() time,
 *      which is during the FFI call, AFTER our delete and BEFORE our restore.
 *   3. `fn` MUST be synchronous (or at least, the work that depends on
 *      `process.env` being stripped must finish before any `await`). Do NOT
 *      pass an async function that awaits between delete and the actual
 *      spawn — the event loop could schedule other JS that observes the
 *      stripped env.
 *
 * If you find yourself wanting to wrap async work, refactor that work to
 * have the spawn as the only call inside `withCleanProcessEnv` and do the
 * rest outside.
 */
/**
 * Lazy-loaded `libc.unsetenv` / `libc.setenv` bindings.
 *
 * Bun (and Node) implement `delete process.env.X` and `process.env.X = "..."`
 * by mutating an in-process hash — they do NOT call libc `unsetenv()` /
 * `setenv()`. That means the underlying `environ` array still has the
 * original value, and any native code (or child process spawned via fork+exec
 * without explicit `env_clear()`) sees the un-stripped env.
 *
 * `bun-pty`'s Rust wrapper relies on `portable_pty::CommandBuilder`, which
 * inherits parent env via `std::env::vars_os()` → reads `environ` → sees the
 * un-stripped value. So `withCleanProcessEnv` MUST also call libc `unsetenv`
 * to actually remove the var before spawn.
 */
let _libcUnsetEnv: ((name: Buffer) => number) | null = null;
let _libcSetEnv: ((name: Buffer, value: Buffer, overwrite: number) => number) | null = null;
let _libcLoadAttempted = false;

function loadLibc(): void {
  if (_libcLoadAttempted) return;
  _libcLoadAttempted = true;
  try {
    // bun:ffi is only available under Bun — import lazily to avoid blowing
    // up under tsc / non-Bun tooling.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Bun runtime import
    const { dlopen, FFIType } = require("bun:ffi") as any;
    const candidates =
      process.platform === "darwin"
        ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]
        : ["libc.so.6", "libc.so"];
    for (const candidate of candidates) {
      try {
        const lib = dlopen(candidate, {
          unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
          setenv: {
            args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
            returns: FFIType.i32,
          },
        });
        _libcUnsetEnv = lib.symbols.unsetenv;
        _libcSetEnv = lib.symbols.setenv;
        return;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // bun:ffi unavailable (e.g. test env). withCleanProcessEnv will fall back
    // to JS-only delete; that's correct for tests against /bin/cat etc. but
    // would re-leak under real bun-pty + native fork. Surface this loudly
    // in production via logging.
  }
}

export function withCleanProcessEnv<T>(fn: () => T): T {
  loadLibc();
  const restore: Record<string, string | undefined> = {};
  for (const k of SPAWN_ENV_STRIP_KEYS) {
    const currentValue = process.env[k];
    // Skip the strip entirely for keys whose current value is exempt
    // (e.g. long-lived `sk-ant-oat01-*` OAuth tokens). Leaving `restore[k]`
    // unset means the finally-block does not touch JS env or libc environ
    // for this key — it stays as-is throughout `fn`'s execution.
    if (!shouldStripSpawnEnvKey(k, currentValue)) continue;
    restore[k] = currentValue;
    // 1. JS-side delete so anything checking process.env directly sees it gone.
    delete process.env[k];
    // 2. libc unsetenv so anything reading via `environ` (bun-pty's Rust
    //    `std::env::vars_os()`) ALSO sees it gone. Without this, the child
    //    inherits the original value via fork+exec.
    if (_libcUnsetEnv) {
      _libcUnsetEnv(Buffer.from(`${k}\0`, "utf8"));
    }
  }
  try {
    return fn();
  } finally {
    for (const k of SPAWN_ENV_STRIP_KEYS) {
      const v = restore[k];
      if (v !== undefined) {
        // Restore on BOTH sides: JS hash (so process.env.X reads work) and
        // libc environ (so subsequent fork+exec children see it). Bun does
        // not keep these in sync for assignment any more than it does for
        // delete, so we touch both explicitly.
        process.env[k] = v;
        if (_libcSetEnv) {
          _libcSetEnv(Buffer.from(`${k}\0`, "utf8"), Buffer.from(`${v}\0`, "utf8"), 1);
        }
      }
    }
  }
}

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | {
      type: "auto-compact-retry";
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
    };

type CompactEventListener = (event: CompactEvent) => void;
const compactListeners: CompactEventListener[] = [];

/** Register a listener for compact-related events (warnings, auto-compact notifications). */
export function onCompactEvent(listener: CompactEventListener): void {
  compactListeners.push(listener);
}

function emitCompactEvent(event: CompactEvent): void {
  for (const listener of compactListeners) {
    try {
      listener(event);
    } catch {}
  }
}

function pluginCtx(threadId?: string, agentName?: string): EventContext {
  return {
    sessionKey: threadId || "global",
    conversationId: threadId || "global",
    channelId: threadId || "global",
    agentId: agentName,
    workspaceDir: process.cwd(),
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * #376: the Claude session this run used or created — taken from the CLI's
   * own `system/init` / `result` events on the stream, the documented source
   * (never from the transcript file, whose format is internal). Absent when the
   * stream carried no id (a rate-limit fallback, an exec that died before
   * `init`). The gateway records it so `--resume` can be emitted.
   */
  sessionId?: string;
  /**
   * #546: set when the response came from the rate-limit fallback. Primary
   * text may only be a rate-limit notice; fallback delivery is tracked separately.
   */
  usedFallback?: true;
  /** Whether the final fallback attempt delivered nonempty text via onChunk. */
  fallbackStreamedText?: boolean;
  /**
   * #562: set only when a PTY turn failed with an unknown outcome (no turn boundary,
   * ambiguous attribution, timeout): it may have completed and done its side effects, so a
   * caller must not replay it. Absent on a success, on a definite failure and on every
   * non-PTY engine, which keep their old behaviour.
   */
  failureKind?: PtyUnsafeReplayKind;
}

export interface AgentStreamEvent {
  type: "spawn" | "done";
  id: string;
  description: string;
  result?: string;
}

const RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;
const RATE_LIMIT_RESET_PATTERN = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*UTC\s*\)?/i;
// Signature-error detection lives in `./runner/signature-error`: bounded, linear matching
// of attacker-influenced text, and a transcript check before a PTY-rendered error resets a
// session (#562 security review).
export { endsInRenderedSignatureError };

// Claude Code prints this when --resume references a session it no longer
// has on disk (cleared, expired, compacted away, or moved to another machine).
// When we see it, the cached session ID is dead and the only recovery is to
// drop --resume and start fresh.
const STALE_SESSION_PATTERN = /No conversation found with session ID/i;

function isStaleSessionError(stdout: string, stderr: string): boolean {
  return STALE_SESSION_PATTERN.test(stderr) || STALE_SESSION_PATTERN.test(stdout);
}

/** Strip --resume <id> from a claude argv list so it runs as a brand-new session. */
function stripResume(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i += 1; // skip the session id that follows
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

/** Replace the value following --output-format (returns a modified copy). */
function withOutputFormat(args: string[], format: string): string[] {
  const out = [...args];
  const idx = out.indexOf("--output-format");
  if (idx >= 0 && idx + 1 < out.length) out[idx + 1] = format;
  return out;
}

// --- Rate limit state ---
let rateLimitResetAt: number = 0; // epoch ms; 0 = not rate-limited
let rateLimitNotified: boolean = false;

function parseRateLimitResetTime(text: string): number | null {
  const match = text.match(RATE_LIMIT_RESET_PATTERN);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const ampm = match[3]?.toLowerCase();

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(hours, minutes, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.getTime();
}

export function isRateLimited(): boolean {
  if (rateLimitResetAt === 0) return false;
  if (Date.now() >= rateLimitResetAt) {
    rateLimitResetAt = 0;
    rateLimitNotified = false;
    return false;
  }
  return true;
}

export function getRateLimitResetAt(): number {
  return rateLimitResetAt;
}

export function wasRateLimitNotified(): boolean {
  return rateLimitNotified;
}

export function markRateLimitNotified(): void {
  rateLimitNotified = true;
}

const STALE_THINKING_PATTERN = /Invalid.*signature.*thinking|thinking.*block.*signature/i;

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
// Reset to a fresh resolved promise after each task to avoid holding
// references to every previous result (memory leak).
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

// Counter of concurrently-running main-queue sessions (per-thread queues run in parallel)
let mainRunCount = 0;

/** Current number of concurrently-running main-queue sessions. */
export function getMainRunCount(): number {
  return mainRunCount;
}

function persistRunCount(): void {
  try {
    mkdirSync(dirname(ACTIVE_RUNS_FILE), { recursive: true });
    writeFileSync(ACTIVE_RUNS_FILE, String(mainRunCount));
  } catch {}
}

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(
      threadId,
      task.then(
        () => {},
        () => {},
      ),
    );
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.then(
    () => {},
    () => {},
  );
  return task;
}

// Track active main-queue subprocesses so /kill targets them exclusively.
// Using a Set because per-thread queues run in parallel — multiple main
// runs can be in-flight at the same time. Fork procs are excluded: they run
// outside the main queue and must not be killed by /kill.
const mainActiveProcs = new Set<ReturnType<typeof Bun.spawn>>();

/**
 * Kill all running main-queue claude subprocesses AND dispose every live PTY
 * managed by the supervisor.
 *
 * Two cohorts:
 *   1. Legacy `Bun.spawn` handles tracked in `mainActiveProcs` — killed
 *      synchronously via `proc.kill()`.
 *   2. PTY-mode processes owned by the supervisor — disposed asynchronously
 *      via `killAllPtys()`. The supervisor's per-key serial lock turns the
 *      in-flight `runTurn` promise into a `PtyClosedError` rejection,
 *      mirroring the SIGTERM-style failure surface of the legacy path.
 *
 * The fire-and-forget pattern on the PTY disposal preserves the synchronous
 * boolean-return contract (legacy `/kill` callsites assume immediate
 * truthy/falsy without awaiting). PTYs detect the kill on their next event
 * tick; the caller does not need to await disposal.
 *
 * Returns true iff anything was killed (legacy procs OR live PTYs).
 *
 * Phase D fix #4 (FA-6a): without this, `/kill` was a silent no-op against
 * PTY-mode sessions — a runaway PTY could only be killed by manual PID
 * intervention.
 */
export function killActive(): boolean {
  let killed = false;
  if (mainActiveProcs.size > 0) {
    for (const proc of mainActiveProcs) {
      try {
        proc.kill();
      } catch {}
    }
    mainActiveProcs.clear();
    killed = true;
  }
  // Best-effort async PTY disposal. We don't await because killActive is
  // historically synchronous; PTY callers see PtyClosedError on their next
  // tick which surfaces as a structured error via the supervisor's lock.
  // #394: count entries, not live PTYs — an entry whose spawn has not landed
  // yet has no pid and is absent from the snapshot, and `/kill` must reach it
  // (the retirement refuses its late landing) rather than skip it.
  const ptyCountBefore = supervisorEntryCount();
  if (ptyCountBefore > 0) {
    void killAllPtys();
    killed = true;
  }
  return killed;
}

/** True while any main-queue agent is processing a task (excludes fork). */
export function isMainBusy(): boolean {
  return mainRunCount > 0;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return (
    a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim()
  );
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

/**
 * Apply provider-specific env vars on top of a sanitised base env. The same
 * helper is used by both the legacy `claude -p` path and the PTY supervisor
 * so model/provider selection (and GLM/Kimi base-URL shims) behave
 * identically across the two transports.
 *
 * - `api` (the resolved auth token from settings/agentic routing/overrides)
 *   becomes `ANTHROPIC_AUTH_TOKEN` so Claude Code reaches the right account.
 * - `model === "glm"` rewrites `ANTHROPIC_BASE_URL` to z.ai's Anthropic
 *   shim and extends the API timeout.
 * - `model === "kimi-k2p6"` rewrites `ANTHROPIC_BASE_URL` to Kimi's coding
 *   endpoint and prefers `KIMI_API_KEY` when set.
 *
 * Exported (Phase D / Codex HIGH #1) so the PTY supervisor can build child
 * env via this single source of truth — without it, the PTY path silently
 * dropped configured model selection and provider routing.
 */
export function buildChildEnv(
  baseEnv: Record<string, string>,
  model: string,
  api: string,
): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  } else if (normalizedModel === "kimi-k2p6") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.kimi.com/coding/";
    if (process.env.KIMI_API_KEY) childEnv.ANTHROPIC_AUTH_TOKEN = process.env.KIMI_API_KEY;
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

/**
 * Resolve the subprocess timeout (in ms) for a given invocation category.
 * Values are read fresh from settings on every call, so hot-reload works
 * automatically: edit settings.json and the next subprocess picks it up.
 *
 * Category mapping:
 *   "telegram"  → settings.timeouts.telegram  (default 5 min)
 *   "discord"   → settings.timeouts.discord   (default 5 min)
 *   "heartbeat" → settings.timeouts.heartbeat (default 15 min)
 *   "job"       → settings.timeouts.job       (default 30 min)
 *   anything else (bootstrap, trigger, chat…) → settings.timeouts.default (default 5 min)
 *
 * Use execClaude's `timeoutCategory` param to pass the category separately from
 * the display/log/session name (e.g. scheduled jobs use job.name for the session
 * ID but pass "job" as the category so they get timeouts.job, not timeouts.default).
 */
function resolveTimeoutMs(name: string): number {
  const t = getSettings().timeouts;
  let minutes: number;
  if (name === "telegram") {
    minutes = t.telegram;
  } else if (name === "discord") {
    minutes = t.discord;
  } else if (name === "heartbeat") {
    minutes = t.heartbeat;
  } else if (name === "job") {
    minutes = t.job;
  } else {
    minutes = t.default;
  }
  return minutes * 60_000;
}

// Cap stdout/stderr to prevent unbounded memory growth.
// 10 MB is far beyond any real Claude response; protects against runaway streams only.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes < maxBytes) {
        const space = maxBytes - totalBytes;
        if (value.byteLength <= space) {
          chunks.push(value);
          totalBytes += value.byteLength;
        } else {
          chunks.push(value.subarray(0, space));
          totalBytes = maxBytes;
          // cap reached — keep draining without storing so the child process isn't blocked
        }
      }
      // beyond cap: read and discard to keep the pipe flowing
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface RunOptions {
  modelOverride?: string;
}

/**
 * Which engine runs an agent turn (#546). The single decision the agent-turn
 * call sites go through — primary turn, rate-limit fallback, dashboard chat,
 * fork, agent job — so a new call site cannot quietly skip `pty.enabled`.
 * Bootstrap and recovery retries also follow this setting (#550).
 *
 *   - `settings.pty.enabled === false` → legacy `claude -p` (SPEC §5.2).
 *   - otherwise → the PTY supervisor.
 *
 * `pty.enabled` defaults to true except on win32, where it defaults to false: nothing
 * in the codebase shows the PTY path working there (`claude` is a `.cmd` wrapper,
 * spec §5.3 names `process` as the Windows fallback). An explicit `pty.enabled: true`
 * still opts in. See `defaultPtyEnabled` in `src/config.ts`.
 */
export function resolveAgentTurnRoute(name?: string): "legacy" | "pty" {
  return getSettings().pty.enabled ? "pty" : "legacy";
}

type ClaudeProc = Bun.Subprocess<"ignore", "pipe", "pipe">;
type ClaudeSpawn = (
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
) => ClaudeProc;
let _claudeSpawnForTests: ClaudeSpawn | null = null;
/**
 * Test seam (#546): replaces the `Bun.spawn` of the legacy `claude -p` call
 * sites, so a test can tell which route a path took without a real `claude`.
 * Production never sets it.
 */
export function _setClaudeSpawnForTests(fn: ClaudeSpawn | null): void {
  _claudeSpawnForTests = fn;
}
/**
 * #562 round 8: a legacy `claude -p --resume <id>` passes the same gate as every other start
 * on a session. A transcript whose previous process the OS has not confirmed gone is not
 * resumed beside it.
 */
async function gateResume(args: string[]): Promise<void> {
  const id = resumeIdOf(args);
  if (id) await assertSessionWritable({ sessionId: id });
}

function resumeIdOf(args: string[]): string | undefined {
  const i = args.indexOf("--resume");
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * #562 round 9: the synchronous final word, run on the line before the process is created.
 * `gateResume` is async, so a retirement that fails after it passed would quarantine a session
 * the spawn then goes ahead on.
 */
function assertResumeSpawnable(args: string[]): void {
  const id = resumeIdOf(args);
  if (id) assertSessionSpawnable({ sessionId: id });
}

async function spawnClaude(
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
): Promise<ClaudeProc> {
  await gateResume(args);
  // Synchronous check; no await between it and the spawn below (#562 round 9).
  assertResumeSpawnable(args);
  if (_claudeSpawnForTests) return _claudeSpawnForTests(args, opts);
  return Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
}

/**
 * #562 connector P1: `pty.enabled` can flip to false while a PTY still owns a session key, and
 * the next turn then resumes that session on print. Two processes would write one transcript
 * (or the CLI refuses with "Session ID ... is already in use"). Retire the live PTY on each of
 * `keys` BEFORE the legacy spawn. `retirePtySession` applies the round 8/9 fence and rejects
 * with `PtyQuarantinedError` when the exit is unconfirmed, so the turn fails instead of
 * resuming beside a process that may still be writing. A print-only install has no live key
 * and pays one empty-array check.
 */
async function retireLivePtysBeforePrint(keys: string[]): Promise<void> {
  const live = liveSessionKeys();
  if (live.length === 0) return;
  for (const key of keys) if (live.includes(key)) await retirePtySession(key);
}

/** A one-shot agent turn on its own PTY (#546); see `runEphemeralWithDeadline`. */
const runOneShotOnPty = runEphemeralWithDeadline;

/**
 * The model override as `run()` accepts it: the bare model string production
 * passes today (`start.ts` job tick), or the `RunOptions` object the original
 * wiring (7e6dae9) intended and the tests always used (#330). Anything else
 * is treated as "no override" rather than reaching `primaryConfig.model`.
 */
export function resolveModelOverride(value: string | RunOptions | undefined): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && typeof value.modelOverride === "string") {
    return value.modelOverride.trim() || undefined;
  }
  return undefined;
}

export async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  cwd?: string,
  signal?: AbortSignal,
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm" && normalizedModel !== "kimi-k2p6")
    args.push("--model", model.trim());

  const proc = await spawnClaude(args, { env: buildChildEnv(baseEnv, model, api), cwd });

  mainActiveProcs.add(proc);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  // Cancellation (e.g. a job cancelled via the AgentJobRunner): abort like a
  // timeout so the catch below kills the process and returns.
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  try {
    const [rawStdout, stderr] = (await Promise.race([
      Promise.all([
        collectStream(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
      ]),
      timeoutPromise,
      abortPromise,
    ])) as [string, string];

    if (timeoutId) clearTimeout(timeoutId);
    await proc.exited;
    mainActiveProcs.delete(proc);

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    mainActiveProcs.delete(proc);
    // Kill the hung process
    try {
      proc.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 5000);

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);

    return {
      rawStdout: "",
      stderr: message,
      exitCode: 124,
    };
  }
}

/**
 * Build the argv for one headless agent job.
 *
 * Extracted so the `--mcp-config` wiring is directly assertable: without the
 * flag a dispatched job cannot reach any of the operator's `mcp.shared`
 * servers, while the agent that dispatched it reaches all of them.
 */
export function buildAgentJobArgs(input: {
  prompt: string;
  securityArgs: string[];
  persona: string;
  mcpConfigPath?: string;
}): string[] {
  const args = [CLAUDE_EXECUTABLE, "-p", input.prompt, ...input.securityArgs];
  if (input.persona) args.push("--append-system-prompt", input.persona);
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  return args;
}

/**
 * Run a named agent as a one-shot headless job (for the bus AgentJobRunner). Loads
 * the agent's persona (IDENTITY/SOUL/CLAUDE.md), runs on the configured engine in the
 * agent's dir with plain-text output, and returns the final text. Honours the
 * AbortSignal (cancel → kill) and the timeout via `runClaudeOnce`. This is the
 * supported replacement for the hand-rolled `/tmp` fire-scripts that caused #295.
 */
export async function runAgentJobHeadless(input: {
  agent: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Bus job id, used to name the job's PTY session. */
  jobId?: string;
  /**
   * Absolute path to a synthesized `--mcp-config` for this job, or omitted
   * when the MCP multiplexer is dormant. Minted and released by the caller
   * (the bus wires the job runner and owns the multiplexer identity); this
   * function only forwards the flag to the spawned `claude`.
   */
  mcpConfigPath?: string;
}): Promise<{ exitCode: number; resultText?: string; error?: string; timedOut?: boolean }> {
  const settings = getSettings();
  // Security review (#296 PR 3): validate the caller-supplied model against the
  // allow-list before spawning — reject an attacker-picked tier rather than
  // silently falling back. Throws → the job is marked failed (never spawns).
  validateModelString(input.model, "agent job");
  const ctx = await loadAgent(input.agent);
  const persona = await loadAgentPrompts(input.agent);
  const args = buildAgentJobArgs({
    prompt: input.prompt,
    securityArgs: buildSecurityArgs(settings.security),
    persona,
    mcpConfigPath: input.mcpConfigPath,
  });
  const model = input.model?.trim() || settings.model;
  if (resolveAgentTurnRoute() === "pty") {
    // #546: one PTY per job, retired when the job ends. Cancel (the signal)
    // and the job timeout both dispose it mid-turn.
    const exec = await runOneShotOnPty(
      `job:${input.agent}:${input.jobId ?? crypto.randomUUID()}`,
      input.prompt,
      {
        timeoutMs: input.timeoutMs,
        agentName: input.agent,
        cwd: ctx.dir,
        modelOverride: model,
        api: settings.api,
        securityArgs: buildSecurityArgs(settings.security),
        // The reply is read off the rendered TUI: plain prose only (see execClaude).
        appendSystemPrompt: [persona, PTY_OUTPUT_FORMAT_CONSTRAINT].filter(Boolean).join("\n\n"),
        // The bus owns the job's MCP config, absent included: the supervisor
        // must not synthesize one the `-p` job would not have had.
        mcpConfig: { path: input.mcpConfigPath },
      },
      input.signal,
    );
    // Same mapping as the `-p` path: timeout and abort both end as exit 124.
    if (exec.timedOut || exec.aborted) {
      const reason = exec.timedOut ? `timed out after ${input.timeoutMs / 1000}s` : "aborted";
      return { exitCode: 124, timedOut: true, error: reason };
    }
    if (exec.exitCode !== 0) {
      return { exitCode: exec.exitCode, error: exec.stderr || `claude exited ${exec.exitCode}` };
    }
    return { exitCode: 0, resultText: exec.rawStdout.trim() };
  }
  const { rawStdout, stderr, exitCode } = await runClaudeOnce(
    args,
    model,
    settings.api,
    cleanSpawnEnv(),
    input.timeoutMs,
    ctx.dir,
    input.signal,
  );
  if (exitCode === 124) return { exitCode, timedOut: true, error: stderr || "timed out" };
  if (exitCode !== 0) return { exitCode, error: stderr || `claude exited ${exitCode}` };
  return { exitCode, resultText: rawStdout.trim() };
}

// Runs claude with --output-format stream-json --verbose, reading NDJSON events as they
// arrive rather than buffering the full stdout. This allows the parent process to remain
// responsive while Claude orchestrates subagents via the Task tool — each subagent emits
// events through the parent's stdout stream, so the process stays alive and producing
// output until all agents finish. Returns the final result text and the session ID
// captured from the stream/init event.
async function runClaudeStream(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
  cwd?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void,
): Promise<{ rawStdout: string; stderr: string; exitCode: number; sessionId?: string }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = await spawnClaude(args, { env: buildChildEnv(baseEnv, model, api), cwd });

  mainActiveProcs.add(proc);
  let sessionId: string | undefined;
  let resultText = "";
  let stderr = "";

  // Streaming state for onChunk/onToolEvent callbacks
  let streamDelivered = "";
  let streamLastMsgId = "";
  const streamPendingToolCalls = new Map<string, string>();

  const readStdout = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if (
            (event.type === "system" || event.type === "result") &&
            typeof event.session_id === "string"
          ) {
            sessionId = event.session_id;
          }
          if (event.type === "result" && typeof event.result === "string") {
            resultText = event.result;
          }
          // Emit streaming callbacks if provided
          if (
            (onChunk || onToolEvent) &&
            event.type === "assistant" &&
            (event.message as any)?.content
          ) {
            const msg = event.message as any;
            const msgId: string = msg.id ?? "";
            if (msgId !== streamLastMsgId) {
              if (onChunk && streamDelivered) onChunk("\n");
              streamDelivered = "";
              streamLastMsgId = msgId;
            }
            let full = "";
            for (const block of msg.content) {
              if (block.type === "text" && typeof block.text === "string") {
                full += block.text;
              } else if (block.type === "tool_use" && onToolEvent) {
                streamPendingToolCalls.set(block.id, block.name);
                onToolEvent(`● ${formatToolCallSummary(block.name, block.input ?? {})}`);
              }
            }
            if (onChunk && full.length > streamDelivered.length) {
              onChunk(full.slice(streamDelivered.length));
              streamDelivered = full;
            }
          }
          if (onToolEvent && event.type === "user") {
            for (const block of (event.message as any)?.content ?? []) {
              if (block.type === "tool_result") {
                const toolName = streamPendingToolCalls.get(block.tool_use_id) ?? "?";
                streamPendingToolCalls.delete(block.tool_use_id);
                const text = extractToolResultText(block.content);
                const firstLine = text.split("\n")[0].slice(0, 80);
                const summary = block.is_error ? `Error: ${firstLine}` : firstLine || "done";
                onToolEvent(`  ⎿  [${toolName}] ${summary}`);
              }
            }
          }
        } catch {}
      }
    }
  };

  const readStderr = async () => {
    stderr = await collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES);
  };

  let streamJsonTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    streamJsonTimeoutId = setTimeout(
      () => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([Promise.all([readStdout(), readStderr()]), timeoutPromise]);
    if (streamJsonTimeoutId) clearTimeout(streamJsonTimeoutId);
    await proc.exited;
    mainActiveProcs.delete(proc);
    return {
      rawStdout: resultText,
      stderr: stderr.trim(),
      exitCode: proc.exitCode ?? 1,
      sessionId,
    };
  } catch (err) {
    if (streamJsonTimeoutId) clearTimeout(streamJsonTimeoutId);
    mainActiveProcs.delete(proc);
    try {
      proc.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 5000);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);
    return { rawStdout: "", stderr: message, exitCode: 124, sessionId };
  }
}

function formatToolCallSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 50) => String(v ?? "").slice(0, max);
  switch (name) {
    case "Write":
    case "Edit":
    case "Read":
      return `${name}(${s(input.file_path)})`;
    case "Bash":
      return `Bash(${s(input.command, 60)})`;
    case "Grep":
      return `Grep(${s(input.pattern)} in ${s(input.path ?? ".")})`;
    case "Glob":
      return `Glob(${s(input.pattern)})`;
    case "WebSearch":
      return `WebSearch(${s(input.query)})`;
    case "WebFetch":
      return `WebFetch(${s(input.url, 60)})`;
    default:
      return `${name}(...)`;
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

const PROJECT_DIR = process.cwd();

// Converts a raw agent/thread display name to a safe filesystem segment.
// Converts a display name to a safe filesystem segment (no unique suffix).
// Exported for display-only use (e.g. showing the human-readable name in UI).
export function safeAgentSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error(`Agent name "${raw}" cannot be converted to a safe path segment`);
  return slug;
}

// Builds a guaranteed-unique, filesystem-safe directory key for an agent thread.
// Truncates the display slug to leave room for "-<threadId>" so the suffix is
// NEVER truncated away on a second slugging pass.
export function agentDirKey(rawName: string, threadId: string): string {
  const suffix = `-${threadId}`;
  const maxSlugLen = Math.max(1, 64 - suffix.length);
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlugLen);
  if (!slug) throw new Error(`Agent name "${rawName}" cannot be converted to a safe path segment`);
  return `${slug}${suffix}`;
}

// Returns the working directory for a named agent's Claude spawn.
// Works with any agent name — Discord-generated keys (from agentDirKey) or
// raw filesystem directory names used by scheduled jobs.
// Security: uses realpath() after mkdir so symlinks are resolved before the
// containment check. A lexical path.resolve() check is not sufficient because
// a symlinked agents/<name> can point outside the repo and pass lexical checks.
export async function ensureAgentDir(name: string): Promise<string> {
  const agentsRoot = join(PROJECT_DIR, "agents");
  const dir = join(agentsRoot, name);
  // Lexical pre-check: reject obvious traversal before touching the filesystem
  if (!resolve(dir).startsWith(resolve(agentsRoot) + sep)) {
    throw new Error(`Agent directory "${dir}" would escape the agents root — rejecting`);
  }
  await mkdir(dir, { recursive: true });
  // Post-mkdir realpath checks resolve symlinks at every level.
  // We verify two things:
  //   1. agents/ itself resolves inside PROJECT_DIR (catches a symlinked agents/ root)
  //   2. agents/<name> resolves inside agents/ (catches a symlinked individual agent dir)
  const realProjectDir = await realpath(PROJECT_DIR);
  const realRoot = await realpath(agentsRoot);
  const realDir = await realpath(dir);
  if (!realRoot.startsWith(realProjectDir + sep)) {
    throw new Error(
      `agents/ root "${realRoot}" resolves outside the project directory via symlink — rejecting`,
    );
  }
  if (!realDir.startsWith(realRoot + sep)) {
    throw new Error(
      `Agent directory "${realDir}" resolves outside the agents root via symlink — rejecting`,
    );
  }
  return realDir;
}

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [CLAUDECLAW_BLOCK_START, promptContent, CLAUDECLAW_BLOCK_END].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(
        `[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`,
        e,
      );
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m",
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

/**
 * Permission modes accepted by Claude Code's `--permission-mode` flag.
 *
 * Full-parity with the CLI choices (verified against `claude --help`
 * 2026-05-20). Kept in sync with `VALID_PERMISSION_MODES` in
 * `src/config.ts` and the union types in `src/bus/types.ts`. If any
 * one of these three sites is updated, all three must move together —
 * otherwise a value documented in one path will be silently rejected
 * by another (Codex P2 on PR #145; 5-agent review Agent 2 on PR
 * #expand-valid-permission-modes flagged this exact runner gap).
 */
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

const VALID_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);

let cachedPermissionMode: PermissionMode | null = null;

export function getPermissionMode(): PermissionMode {
  if (cachedPermissionMode) return cachedPermissionMode;
  try {
    const raw = JSON.parse(readFileSync(PERMISSION_MODE_FILE, "utf8")) as { mode?: unknown };
    if (typeof raw.mode === "string" && VALID_PERMISSION_MODES.has(raw.mode as PermissionMode)) {
      cachedPermissionMode = raw.mode as PermissionMode;
      return cachedPermissionMode;
    }
  } catch {}
  return "bypassPermissions";
}

export function setPermissionMode(mode: PermissionMode): void {
  cachedPermissionMode = mode;
  try {
    mkdirSync(dirname(PERMISSION_MODE_FILE), { recursive: true });
    writeFileSync(PERMISSION_MODE_FILE, `${JSON.stringify({ mode }, null, 2)}\n`);
  } catch (err) {
    console.error("[runner] Failed to persist permission mode:", err);
  }
}

/**
 * Build the security-related argv for a `claude` invocation (both `claude -p`
 * and PTY-mode). Reads `getPermissionMode()` to decide between
 * `--dangerously-skip-permissions` and `--permission-mode <mode>`, then
 * appends tool gating per `security.level`. Exported so the PTY supervisor
 * can pass the same argv to its spawned `claude` rather than reinventing the
 * logic — this is the only place permission-mode policy lives.
 */
export function buildSecurityArgs(security: SecurityConfig): string[] {
  const permissionMode = getPermissionMode();
  const args: string[] =
    permissionMode === "bypassPermissions"
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", permissionMode];

  // Native scheduling tools (CronCreate/…) are broken in every daemon-spawned
  // claude process — a headless `claude -p` is a one-shot that exits before any
  // wakeup could fire (#342). Block them everywhere buildSecurityArgs is used,
  // merged into a single `--disallowedTools` alongside the level's own denials
  // and any operator config, so multiple `--disallowedTools` flags can't fight.
  const disallowed = new Set<string>(NATIVE_SCHEDULING_TOOLS_BLOCKLIST);

  if (security.level === "locked") {
    // Include Write tool so memory persistence works even in locked mode. This
    // is an allow-LIST (`--tools`): everything else, native cron included, is
    // already unavailable, so no `--disallowedTools` is needed here.
    args.push("--tools", "Read,Grep,Glob,Write");
    if (security.allowedTools.length > 0) {
      args.push("--allowedTools", security.allowedTools.join(" "));
    }
    return args;
  }

  if (security.level === "strict") {
    disallowed.add("Bash");
    disallowed.add("WebSearch");
    disallowed.add("WebFetch");
  }
  // "moderate" / "unrestricted": all tools available except the merged denials.
  for (const tool of security.disallowedTools) disallowed.add(tool);

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  args.push("--disallowedTools", [...disallowed].join(","));

  return args;
}

/** Load and concatenate all prompt files from the prompts/ directory. */
async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/claudeclaw/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(
          `[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`,
          e,
        );
      }
    }
  }
  return "";
}

/**
 * Run /compact on a session to reduce context size. With a live PTY session for
 * `sessionKey` the command goes into it (#549); otherwise it is a `trusted-session`
 * one-shot resume of `sessionId`. `cwd` is where the session was created: `--resume`
 * finds a session by it.
 */
export async function runCompact(opts: {
  sessionId: string;
  sessionKey?: string;
  model: string;
  timeoutMs: number;
  cwd?: string;
  /** The session is wedged (its last turn timed out): retire it, then resume one-shot. */
  skipLive?: boolean;
}): Promise<boolean> {
  console.log(
    `[${new Date().toLocaleTimeString()}] Running /compact on session ${opts.sessionId.slice(0, 8)}...`,
  );
  const result = await actOnSession({
    route: "compact",
    prompt: "/compact",
    sessionKey: opts.sessionKey,
    sessionId: opts.sessionId,
    timeoutMs: opts.timeoutMs,
    skipLive: opts.skipLive,
    model: opts.model,
    cwd: opts.cwd,
    // /compact needs no tools. An empty grant (not an absent one) keeps the one-shot
    // off the default permission profile, which can include the bypass flag.
    allowedTools: [],
  });
  console.log(
    `[${new Date().toLocaleTimeString()}] Compact ${result.ok ? `succeeded (${result.via})` : `failed (${result.detail ?? result.via})`}`,
  );
  return result.ok;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(
  agentName?: string,
): Promise<{ success: boolean; message: string }> {
  const existing = await getSession(agentName);
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const compactCwd = agentName ? await ensureAgentDir(agentName) : undefined;
  const ok = await runCompact({
    sessionId: existing.sessionId,
    sessionKey: agentName ? `agent:${agentName}` : "global",
    model: settings.model,
    timeoutMs: settings.sessionTimeoutMs,
    cwd: compactCwd,
  });

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

/**
 * Policy-aware tool execution wrapper.
 * Evaluates tool requests against policy before allowing execution.
 */
async function evaluateToolForExecution(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  context: {
    source: string;
    channelId?: string;
    userId?: string;
    skillName?: string;
    sessionId?: string;
    claudeSessionId?: string | null;
    eventId: string;
  },
): Promise<{ allowed: boolean; decision: import("./policy/engine").PolicyDecision }> {
  const gc = getGovernanceClient();
  const request: import("./policy/engine").ToolRequestContext = {
    eventId: context.eventId,
    source: context.source,
    channelId: context.channelId,
    userId: context.userId,
    skillName: context.skillName,
    toolName,
    toolArgs,
    sessionId: context.sessionId,
    claudeSessionId: context.claudeSessionId,
    timestamp: new Date().toISOString(),
  };

  const decision = gc.evaluateToolRequest(request);

  if (decision.action === "deny") {
    console.warn(`[policy] Tool ${toolName} denied: ${decision.reason}`);
    return { allowed: false, decision };
  }

  if (decision.action === "require_approval") {
    console.warn(`[policy] Tool ${toolName} requires approval: ${decision.reason}`);
    // Enqueue for approval
    const entry = await gc.requestApproval(request, decision);
    if (entry) {
      console.warn(`[policy] Approval request enqueued: ${entry.id}`);
    }
    return { allowed: false, decision };
  }

  return { allowed: true, decision };
}

/**
 * Get context for policy evaluation from current session and settings.
 */
async function getPolicyContext(
  source: string,
  channelId?: string,
  userId?: string,
  skillName?: string,
): Promise<{
  eventId: string;
  source: string;
  channelId?: string;
  userId?: string;
  skillName?: string;
  sessionId?: string;
  claudeSessionId?: string | null;
}> {
  const existing = await getSession();
  const settings = getSettings();
  return {
    eventId: crypto.randomUUID(),
    source,
    channelId, // #258 item 1: threaded from inbound event (undefined for non-channel sources)
    userId,
    skillName,
    sessionId: existing?.sessionId,
    claudeSessionId: existing?.sessionId ?? null,
  };
}

/**
 * Load IDENTITY.md, SOUL.md, and CLAUDE.md from an agent's directory
 * and concatenate them into a single system-prompt string.
 */
async function loadAgentPrompts(agentName: string): Promise<string> {
  const ctx = await loadAgent(agentName);
  const files = [ctx.identityPath, ctx.soulPath, ctx.claudeMdPath];
  const parts: string[] = [];
  for (const file of files) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch {
      // missing file is non-fatal
    }
  }
  return parts.join("\n\n");
}

// Compact a Discord thread session by threadId. Uses getThreadSession (not getSession)
// because Discord threads have their own session store. agentName is used only for cwd isolation.
export async function compactCurrentThreadSession(
  threadId: string,
  agentName?: string,
): Promise<{ success: boolean; message: string }> {
  const existing = await getThreadSession(threadId);
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const compactCwd = agentName ? await ensureAgentDir(agentName) : undefined;
  const ok = await runCompact({
    sessionId: existing.sessionId,
    sessionKey: `thread:${threadId}`,
    model: settings.model,
    timeoutMs: settings.sessionTimeoutMs,
    cwd: compactCwd,
  });

  return ok
    ? {
        success: true,
        message: `✅ Thread session compact complete (${existing.sessionId.slice(0, 8)})`,
      }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

/**
 * Identity fields threaded from the inbound surface for policy/budget scoping (#258 item 1).
 */
interface PolicyIdentity {
  userId?: string;
  skillName?: string;
}

/**
 * Injectable seam for the PRIMARY exec of `execClaude` (#330): the step that
 * runs the resolved `primaryConfig.model` through `runClaudeStream` (legacy)
 * or `runOnPty` (supervisor). The modelOverride tests used to
 * `spyOn(module, "runClaudeOnce")` — a function `execClaude` never calls for
 * the primary run, and a module spy cannot intercept a local binding anyway —
 * so eleven tests ran for three months without executing one assertion.
 * When set, the seam receives the resolved model/api, the legacy-shaped args,
 * cwd, timeout and which route the real call would have taken; PTY-only
 * inputs (prompt, securityArgs, appendSystemPrompt) and the spawn env are not
 * part of it. Only the PRIMARY exec is seamed: the result flows into the
 * unchanged downstream (rate-limit fallback, corruption and stale-session
 * recovery), which still spawns claude — so a seam should return a clean
 * result or throw. Production never sets it.
 */
export interface PrimaryExecCall {
  name: string;
  args: string[];
  model: string;
  api: string;
  cwd: string | undefined;
  timeoutMs: number;
  route: "legacy" | "pty";
}
type PrimaryExec = (call: PrimaryExecCall) => Promise<{
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
  failureKind?: PtyUnsafeReplayKind;
}>;
/** What one exec (print or PTY) hands back; `failureKind` is set only by the PTY path. */
type ExecOutcome = {
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
  failureKind?: PtyUnsafeReplayKind;
};
let _primaryExecForTests: PrimaryExec | null = null;
export function _setPrimaryExecForTests(fn: PrimaryExec | null): void {
  _primaryExecForTests = fn;
}

async function execClaude(
  name: string,
  prompt: string,
  threadId?: string,
  modelOverride?: string,
  timeoutMsOverride?: number,
  agentName?: string,
  timeoutCategory?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void,
  identity?: PolicyIdentity,
): Promise<RunResult> {
  mainRunCount++;
  persistRunCount();
  // Invocation ID for watchdog tracking. Declared OUTSIDE the try so the
  // `finally` can always clear the activeInvocations record on EVERY exit
  // path — early returns, throws, and normal completion alike (#268).
  const invocationId = crypto.randomUUID();
  try {
    await mkdir(LOGS_DIR, { recursive: true });

    // Rotate the global session if thresholds are exceeded (thread/agent sessions are not rotated).
    let rotationSummary: string | null = null;
    if (!threadId && !agentName) {
      const { session: sessionConfig } = getSettings();
      if (sessionConfig.autoRotate) {
        const peeked = await peekSession();
        if (peeked && needsRotation(peeked, sessionConfig)) {
          rotationSummary = await rotateSession(sessionConfig);
        }
      }
    }

    const existing = threadId ? await getThreadSession(threadId) : await getSession(agentName);
    const isNew = !existing;
    // Start the watchdog clock for resumed sessions (we know the ID immediately).
    if (existing) startSession(existing.sessionId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

    const settings = getSettings();
    const { security, model, api, fallback, agentic, watchdog } = settings;

    const invocationSessionId = existing?.sessionId;

    // Initialize watchdog metrics
    await recordExecutionMetric({ invocationId, sessionId: invocationSessionId }, {});
    // Minimal watchdog: start clock for resumed sessions (new sessions get startSession after JSON parse)
    if (invocationSessionId) watchdogStart(invocationSessionId);

    // Determine which model to use based on agentic routing
    let primaryConfig: ModelConfig;
    let taskType = "unknown";
    let routingReasoning = "";

    if (modelOverride) {
      primaryConfig = { model: modelOverride, api };
      taskType = "job-override";
      routingReasoning = `override: ${modelOverride}`;
      console.log(`[${new Date().toLocaleTimeString()}] Job model override: ${modelOverride}`);
    } else if (agentic.enabled) {
      ensureGovernanceRouter(agentic.modes, agentic.defaultMode);
      const routing = await governanceSelectModel({
        prompt,
        taskType: agentic.defaultMode,
        sessionId: existing?.sessionId,
        channelId: threadId, // #258 item 1: per-channel budget/policy scoping
        userId: identity?.userId,
        source: name,
      });
      primaryConfig = {
        model: routing.selectedModel,
        api: routing.selectedProvider === "openai" ? "" : api,
      };
      taskType = routing.reason;
      routingReasoning = routing.reason;
      // Handle budget block
      if (routing.budgetState === "block") {
        console.warn(
          `[${new Date().toLocaleTimeString()}] Execution blocked: budget limit exceeded`,
        );
        // Record failure and return
        await recordInvocationFailure(invocationId, {
          type: "budget-blocked",
          message: `Budget state: ${routing.budgetState}`,
        });
        return {
          stdout: "",
          stderr: "Execution blocked: budget limit exceeded",
          exitCode: 0,
          ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
        };
      }
      console.log(
        `[${new Date().toLocaleTimeString()}] Agentic routing: ${routing.selectedModel} (${routing.reason})`,
      );
    } else {
      primaryConfig = { model, api };
    }

    const fallbackConfig: ModelConfig = {
      model: fallback?.model ?? "",
      api: fallback?.api ?? "",
    };
    const securityArgs = buildSecurityArgs(security);
    const timeoutMs = timeoutMsOverride ?? resolveTimeoutMs(timeoutCategory ?? name);

    console.log(
      `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level}, timeout: ${timeoutMs / 60_000}m)`,
    );

    // Plugins: before_agent_start — fired before Claude is invoked.
    const pm = getPluginManager();
    const ctx = pluginCtx(threadId, agentName);
    if (pm) await pm.emit("before_agent_start", { prompt }, ctx);

    // stream-json emits NDJSON events as Claude works, including during subagent (Task tool)
    // orchestration. This keeps the process alive and producing output rather than silently
    // blocking until all spawned agents finish. --verbose is required for stream-json in
    // print (-p) mode. Session ID is captured from the system/init event; the final result
    // text comes from the result event — no separate output format needed for new vs resumed.
    const args = [
      CLAUDE_EXECUTABLE,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...securityArgs,
    ];

    if (!isNew) {
      args.push("--resume", existing.sessionId);
    }

    // Build the appended system prompt: CLAUDE.md + directory scoping
    // This is passed on EVERY invocation (not just new sessions) because
    // --append-system-prompt does not persist across --resume.
    const memPath = getMemoryPath(agentName);
    // Prompt files (IDENTITY.md, USER.md, SOUL.md) are already embedded in
    // CLAUDE.md by ensureProjectClaudeMd(), which runs before every call.
    const appendParts: string[] = [
      `You are running inside ClaudeClaw. IMPORTANT: After completing any task, you MUST update your memory file at ${memPath} using the Write tool.`,
    ];

    if (rotationSummary)
      appendParts.push(`Context from the previous session:\n\n${rotationSummary}`);

    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }

    // Plugins: before_prompt_build — lets plugins inject system context
    if (pm) {
      const pluginResult = await pm.emit("before_prompt_build", { prompt }, ctx);
      if (pluginResult?.appendSystemContext) appendParts.push(pluginResult.appendSystemContext);
    }

    if (agentName) {
      // Agent path: load only the agent's IDENTITY/SOUL/CLAUDE.md.
      const agentPrompts = await loadAgentPrompts(agentName);
      if (agentPrompts) appendParts.push(agentPrompts);
    } else {
      // Main session path: global prompts + project CLAUDE.md.
      const promptContent = await loadPrompts();
      if (promptContent) appendParts.push(promptContent);

      if (existsSync(PROJECT_CLAUDE_MD)) {
        try {
          const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
          if (claudeMd.trim()) appendParts.push(claudeMd.trim());
        } catch (e) {
          console.error(
            `[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`,
            e,
          );
        }
      }
    }

    // Load memory (put after static files for optimal prompt caching)
    if (isNew) await ensureMemoryFile(agentName);
    const memoryContent = await loadMemory(agentName);
    if (memoryContent) {
      appendParts.push(`## Your Memory (from MEMORY.md)\n\n${memoryContent}`);
    }
    const memoryInstructions = await loadMemoryInstructions(agentName);
    if (memoryInstructions) appendParts.push(memoryInstructions);

    if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

    // Band-aid for #105 — the PTY sentinel-echo parser captures the TUI
    // rendered form of the model's reply, not the underlying assistant text.
    // When the model emits markdown structure (backticks, code fences, bullets,
    // numbered lists, block quotes), the TUI renders them inside framed
    // visual elements and the parser extracts box-chrome glyphs instead of
    // textual content. Empirically observed: a reply of `Saved to
    // `/path/to/file.png`` (clean in JSONL) came back through Discord as
    // `*↓1`.
    //
    // Constrain the assistant output to plain prose when PTY parsing is the
    // surface translation layer. This is a workaround, not a fix — the proper
    // fix is the Bus runtime (issue #107 epic, spec PR #106) which reads the
    // JSONL directly and doesn't depend on TUI rendering. Remove this block
    // when `runtime: bus` becomes the default.
    if (settings.pty.enabled) {
      appendParts.push(PTY_OUTPUT_FORMAT_CONSTRAINT);
    }

    if (appendParts.length > 0) {
      args.push("--append-system-prompt", appendParts.join("\n\n"));
    }

    const baseEnv = cleanSpawnEnv();
    const spawnCwd = agentName ? await ensureAgentDir(agentName) : undefined;

    // Record invocation start
    const invocationContext = {
      sessionId: existing?.sessionId,
      claudeSessionId: existing?.sessionId ?? null,
      source: name,
      channelId: threadId, // #258 item 1: persist channel scope into usage record
      userId: identity?.userId,
      skillName: identity?.skillName,
      provider:
        primaryConfig.model.startsWith("gpt") ||
        primaryConfig.model.startsWith("o1") ||
        primaryConfig.model.startsWith("o3")
          ? "openai"
          : "anthropic",
      model: primaryConfig.model,
      metadata: { taskType, routingReasoning },
    };
    const invocationStartedAt = new Date().toISOString();
    await recordInvocationStart(invocationContext, invocationId);

    // Capture memory file mtime before invocation (for fallback write detection)
    let memMtimeBefore = 0;
    try {
      const memPath = getMemoryPath(agentName);
      if (existsSync(memPath)) {
        const { statSync } = await import("fs");
        memMtimeBefore = statSync(memPath).mtimeMs;
      }
    } catch {}

    // ──────────────────────────────────────────────────────────────────────────
    // #550: every agent turn, including bootstrap and recovery, follows the
    // configured engine. Recovery retires the old PTY before retrying so a
    // reset store or compacted transcript is actually loaded by a fresh CLI.
    const useLegacyPath = resolveAgentTurnRoute(name) === "legacy";
    const ptySessionKey = threadId
      ? `thread:${threadId}`
      : agentName
        ? `agent:${agentName}`
        : "global";
    const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
    // A flip to print leaves the PTY of this turn's key alive; retire it before the primary
    // legacy spawn can resume its session. The fallback key is retired only where the
    // fallback is about to run (below): a quarantined fallback must not fail a healthy primary.
    if (useLegacyPath) {
      await retireLivePtysBeforePrint([ptySessionKey]);
    }
    let exec: ExecOutcome;
    if (_primaryExecForTests) {
      exec = await _primaryExecForTests({
        name,
        args,
        model: primaryConfig.model,
        api: primaryConfig.api,
        cwd: spawnCwd,
        timeoutMs,
        route: useLegacyPath ? "legacy" : "pty",
      });
    } else if (useLegacyPath) {
      exec = await runClaudeStream(
        args,
        primaryConfig.model,
        primaryConfig.api,
        baseEnv,
        timeoutMs,
        spawnCwd,
        onChunk,
        onToolEvent,
      );
    } else {
      // Phase D fixes #2 (CRITICAL-1) and #3 (MAJOR-2/3): thread the assembled
      // --append-system-prompt payload AND the canonical securityArgs through
      // to the PTY path so named agents keep their identity/memory and the
      // operator's permissionMode is honoured (instead of always
      // --dangerously-skip-permissions).
      //
      // Codex Phase D #1: ALSO thread the resolved primaryConfig.model and
      // primaryConfig.api through, so the PTY supervisor can:
      //   - pass `--model <model>` (matching what the legacy path does), and
      //   - build child env with `buildChildEnv(baseEnv, model, api)` —
      //     applying ANTHROPIC_AUTH_TOKEN, the GLM/Kimi base-URL shims, etc.
      // Without these, settings.api / agentic-router model choices / GLM /
      // Kimi configuration silently drop on the PTY path.
      exec = await runOnPty(ptySessionKey, prompt, {
        timeoutMs,
        retry: name !== "bootstrap",
        threadId,
        agentName,
        modelOverride: primaryConfig.model || (modelOverride ?? undefined),
        api: primaryConfig.api,
        securityArgs,
        appendSystemPrompt,
        onChunk,
        onToolEvent,
      });
    }
    let fallbackStreamedText = false;
    const onFallbackChunk = onChunk
      ? (text: string) => {
          if (text.length > 0) fallbackStreamedText = true;
          onChunk(text);
        }
      : undefined;
    const execRecovery = async (
      legacyArgs: string[],
      config: ModelConfig,
      fallback = false,
    ): Promise<ExecOutcome> => {
      if (useLegacyPath) {
        return runClaudeStream(legacyArgs, config.model, config.api, baseEnv, timeoutMs, spawnCwd);
      }
      const key = fallback ? `fallback:${ptySessionKey}` : ptySessionKey;
      await retirePtySession(key);
      if (fallback) fallbackStreamedText = false;
      // One attempt: no supervisor turn/respawn retries on a recovery call. The PTY
      // migration (§5.3) does not compound supervisor recovery with downstream
      // recovery, and this IS the downstream one. With `pty.maxRetries` 5 a persistent
      // timeout would cost ~6 x timeoutMs here while holding the global queue.
      return runOnPty(key, prompt, {
        timeoutMs,
        retry: false,
        threadId,
        agentName,
        modelOverride: config.model || modelOverride,
        api: config.api,
        securityArgs,
        appendSystemPrompt,
        onChunk: fallback ? onFallbackChunk : onChunk,
        onToolEvent,
        ...(fallback
          ? {
              sessionStore: {
                load: async () => (await getFallbackSession(agentName, threadId))?.sessionId,
                save: (id: string) => createFallbackSession(id, agentName, threadId),
              },
            }
          : {}),
      });
    };
    const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
    let usedFallback = false;
    // The fallback session the response came from, when the stream carried no
    // id of its own (CodeRabbit on #376): resumed, so the CLI may omit it.
    let fallbackSessionId: string | undefined;

    // Not for bootstrap, on either route: its job is to create the PRIMARY session, and a
    // fallback run cannot (it persists to the separate fallback session store, never
    // `createSession`, see `!usedFallback` below). It would only spend a second full turn
    // holding the global queue that startup chat waits behind. The print opt-out gets
    // the same rule: a "live" log line for a session that does not exist helps nobody.
    if (
      name !== "bootstrap" &&
      primaryRateLimit &&
      hasModelConfig(fallbackConfig) &&
      !sameModelConfig(primaryConfig, fallbackConfig)
    ) {
      console.warn(
        `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`,
      );
      const fallbackSession = await getFallbackSession(agentName, threadId);
      fallbackSessionId = fallbackSession?.sessionId;
      const fallbackArgs = [
        CLAUDE_EXECUTABLE,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        ...securityArgs,
      ];
      if (fallbackSession) {
        fallbackArgs.push("--resume", fallbackSession.sessionId);
      }
      if (appendParts.length > 0) {
        fallbackArgs.push("--append-system-prompt", appendParts.join("\n\n"));
      }
      // #546: the fallback follows the primary's route. On PTY it runs on its
      // own key and resumes from the fallback session store only, so it never
      // resumes the primary transcript.
      const fallbackPtyKey = `fallback:${ptySessionKey}`;
      const fallbackStore: PtySessionStore = {
        load: async () => (await getFallbackSession(agentName, threadId))?.sessionId,
        save: (id) => createFallbackSession(id, agentName, threadId),
      };
      // `recovery` marks the fallback's own corruption retry: one supervisor attempt, like
      // `execRecovery`, so recovery does not compound with the supervisor's retries. The
      // first fallback attempt keeps the normal envelope. The print path is unchanged.
      const execFallback = (legacyArgs: string[], { recovery = false } = {}) => {
        fallbackStreamedText = false;
        return useLegacyPath
          ? runClaudeStream(
              legacyArgs,
              fallbackConfig.model,
              fallbackConfig.api,
              baseEnv,
              timeoutMs,
              spawnCwd,
            )
          : runOnPty(fallbackPtyKey, prompt, {
              timeoutMs,
              ...(recovery ? { retry: false } : {}),
              threadId,
              agentName,
              modelOverride: fallbackConfig.model,
              api: fallbackConfig.api,
              securityArgs,
              appendSystemPrompt,
              sessionStore: fallbackStore,
              onChunk: onFallbackChunk,
              onToolEvent,
            });
      };
      // The fallback resumes its own session, which a flip to print can leave with a live
      // PTY: retire it immediately before use. A fallback session that cannot be retired
      // (quarantined) fails this fallback attempt only; the primary has already run.
      let fallbackRefused: PtyQuarantinedError | undefined;
      if (useLegacyPath) {
        try {
          await retireLivePtysBeforePrint([fallbackPtyKey]);
        } catch (err) {
          if (!(err instanceof PtyQuarantinedError)) throw err;
          fallbackRefused = err;
        }
      }
      exec = fallbackRefused
        ? { rawStdout: "", stderr: fallbackRefused.message, exitCode: 1 }
        : await execFallback(fallbackArgs);
      usedFallback = true;
      let fallbackRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);

      // If the fallback resumed a corrupted session, reset it and retry fresh. On the print
      // path a non-zero exit with the phrase is the CLI's own verdict. On a PTY the output is
      // rendered text the model can also write, so whatever the exit code the transcript must
      // confirm it (`signatureErrorWarrantsReset`).
      const fallbackSignatureError =
        !fallbackRateLimit &&
        !!fallbackSession &&
        (await signatureErrorWarrantsReset({
          useLegacyPath,
          exitCode: exec.exitCode,
          output: exec.rawStdout,
          stderr: exec.stderr,
          sessionId: exec.sessionId ?? fallbackSession.sessionId,
          cwd: spawnCwd ?? process.cwd(),
        }));
      if (fallbackSession && fallbackSignatureError) {
        await resetFallbackSession(agentName, threadId);
        const flabel = threadId
          ? ` (thread ${threadId.slice(0, 8)})`
          : agentName
            ? ` (agent ${agentName})`
            : "";
        console.warn(
          `[${new Date().toLocaleTimeString()}] Detected corrupted fallback session (thinking block signature mismatch). Reset${flabel}, retrying fallback fresh...`,
        );
        const freshFallbackArgs = fallbackArgs.filter(
          (a) => a !== "--resume" && a !== fallbackSession.sessionId,
        );
        // The PTY on the fallback key still holds the corrupted session; drop
        // it so the retry spawns fresh from the store just reset.
        if (!useLegacyPath) await retirePtySession(fallbackPtyKey);
        exec = await execFallback(freshFallbackArgs, { recovery: true });
        fallbackRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
        if (!fallbackRateLimit && exec.sessionId) {
          await createFallbackSession(exec.sessionId, agentName, threadId);
          console.log(
            `[${new Date().toLocaleTimeString()}] Fallback session recovered: ${exec.sessionId}${flabel}`,
          );
        }
      } else if (!fallbackRateLimit) {
        if (!fallbackSession && exec.sessionId) {
          await createFallbackSession(exec.sessionId, agentName, threadId);
          const label = threadId
            ? ` (thread ${threadId.slice(0, 8)})`
            : agentName
              ? ` (agent ${agentName})`
              : "";
          console.log(
            `[${new Date().toLocaleTimeString()}] Fallback session created: ${exec.sessionId}${label}`,
          );
        } else if (fallbackSession) {
          await incrementFallbackTurn(agentName, threadId);
        }
      }
    }

    let rawStdout = exec.rawStdout;
    let stderr = exec.stderr;
    let exitCode = exec.exitCode;
    let stdout = rawStdout;
    let sessionId = existing?.sessionId ?? "unknown";

    // Auto-detect corrupted primary session from thinking block signature mismatch.
    // Gated on !usedFallback — fallback corruption is handled inside the fallback block above.
    // The interactive REPL may render an API error and return to its input prompt without
    // exiting, and its output is text the model can also write. On a PTY the reset needs the
    // rendered tail AND the session transcript's own API-error entry, whatever the exit code;
    // the print path keeps its non-zero-exit rule (`signatureErrorWarrantsReset`).
    const primarySignatureError =
      !isNew &&
      !usedFallback &&
      (await signatureErrorWarrantsReset({
        useLegacyPath,
        exitCode,
        output: rawStdout,
        stderr,
        sessionId: exec.sessionId ?? existing?.sessionId,
        cwd: spawnCwd ?? process.cwd(),
      }));
    if (primarySignatureError) {
      if (threadId) {
        await removeThreadSession(threadId);
      } else if (agentName) {
        await resetSession(agentName);
      } else {
        await backupSession();
      }
      const label = threadId
        ? ` (thread ${threadId.slice(0, 8)})`
        : agentName
          ? ` (agent ${agentName})`
          : "";
      console.warn(
        `[${new Date().toLocaleTimeString()}] Detected corrupted session (thinking block signature mismatch). Reset${label}, retrying with fresh session...`,
      );
      const freshArgs = args.filter((a) => a !== "--resume" && a !== existing?.sessionId);
      const fmtIdx = freshArgs.indexOf("--output-format");
      if (fmtIdx !== -1 && fmtIdx + 1 < freshArgs.length) freshArgs[fmtIdx + 1] = "stream-json";
      exec = await execRecovery(freshArgs, primaryConfig);
      rawStdout = exec.rawStdout;
      stderr = exec.stderr;
      exitCode = exec.exitCode;
      stdout = rawStdout;

      // Persist the fresh session ID so subsequent calls resume it correctly.
      if (exec.sessionId) {
        sessionId = exec.sessionId;
        if (threadId) {
          await createThreadSession(threadId, sessionId);
          console.log(
            `[${new Date().toLocaleTimeString()}] Thread session recovered: ${sessionId} (thread ${threadId.slice(0, 8)})`,
          );
        } else {
          await createSession(sessionId, agentName);
          const sLabel = agentName ? ` (agent ${agentName})` : "";
          console.log(
            `[${new Date().toLocaleTimeString()}] Session recovered: ${sessionId}${sLabel}`,
          );
        }
        startSession(sessionId);
      }
    }

    let recoveredFromStale = false;

    // --- Stale session recovery ---
    // Claude Code returns "No conversation found with session ID: <id>" when
    // --resume points at a session it no longer has (cleared, expired, etc.).
    // Back up the dead ID, drop --resume, and retry as a new session so the
    // user isn't permanently stuck.
    if (!isNew && exitCode !== 0 && existing && isStaleSessionError(rawStdout, stderr)) {
      console.warn(
        `[${new Date().toLocaleTimeString()}] Stale session ${existing.sessionId.slice(0, 8)} for ${name}; recovering with a new session...`,
      );

      if (usedFallback) {
        await resetFallbackSession(agentName, threadId);
      } else if (threadId) {
        await removeThreadSession(threadId);
      } else if (agentName) {
        await resetSession(agentName);
      } else {
        await backupSession();
      }

      const retryArgs = withOutputFormat(stripResume(args), "stream-json");
      const retryConfig = usedFallback ? fallbackConfig : primaryConfig;
      exec = await execRecovery(retryArgs, retryConfig, usedFallback);

      rawStdout = exec.rawStdout;
      stderr = exec.stderr;
      exitCode = exec.exitCode;
      stdout = rawStdout;
      recoveredFromStale = true;
    }

    const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

    if (rateLimitMessage) {
      stdout = rateLimitMessage;
      const resetTime = parseRateLimitResetTime(rateLimitMessage);
      rateLimitResetAt = resetTime ?? Date.now() + 60 * 60_000;
      rateLimitNotified = false;
      console.warn(
        `[${new Date().toLocaleTimeString()}] Rate limit detected. Reset at: ${new Date(rateLimitResetAt).toISOString()}`,
      );
    }

    // Surface stderr when the result event never arrived (abort, tool error, etc.)
    if (!rateLimitMessage && exitCode !== 0 && !stdout && stderr) {
      stdout = stderr;
    }

    // Capture session ID from stream events and persist for new sessions.
    // Gate only on isNew + sessionId present — not on exitCode, so a session that timed
    // out mid-run is still persisted and can be resumed on the next message.
    const parseAsNew = isNew || recoveredFromStale;
    if (!rateLimitMessage && parseAsNew && exec.sessionId) {
      sessionId = exec.sessionId;
      if (recoveredFromStale && usedFallback) {
        await createFallbackSession(sessionId, agentName, threadId);
        const label = threadId
          ? ` (thread ${threadId.slice(0, 8)})`
          : agentName
            ? ` (agent ${agentName})`
            : "";
        console.log(
          `[${new Date().toLocaleTimeString()}] Fallback session created: ${sessionId}${label}`,
        );
        startSession(sessionId);
      } else if (!usedFallback) {
        if (threadId) {
          await createThreadSession(threadId, sessionId);
          console.log(
            `[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`,
          );
        } else {
          await createSession(sessionId, agentName);
          const label = agentName ? ` (agent ${agentName})` : "";
          console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}${label}`);
        }
        startSession(sessionId);
      }
    }

    const result: RunResult = {
      stdout,
      stderr,
      exitCode,
      // The id of the exec that produced THIS response: on a rate-limit
      // fallback that is the fallback session, not the primary (#376).
      ...(() => {
        const reported = usedFallback ? (exec.sessionId ?? fallbackSessionId) : sessionId;
        return reported && reported !== "unknown" ? { sessionId: reported } : {};
      })(),
      ...(usedFallback ? { usedFallback: true as const, fallbackStreamedText } : {}),
      // From the exec that produced THIS result, and only while it is a failure.
      ...(exitCode !== 0 && exec.failureKind ? { failureKind: exec.failureKind } : {}),
    };

    // Record successful completion WITH the real token usage + cost so the
    // budget layer can actually enforce. Previously this passed undefined →
    // every record had estimatedCost undefined → totalEstimatedCost stayed 0 →
    // budgetState never left "healthy" → the block branch was unreachable
    // (governance audit CRITICAL). Usage is read from claude's own session
    // transcript (works for BOTH the legacy stream-json and the PTY paths);
    // cost is computed from the configured pricing tier. Best-effort: a failure
    // here never breaks the invocation.
    let invocationUsage: UsageMetrics | undefined;
    let invocationCost: EstimatedCost | undefined;
    try {
      const u = await extractTranscriptUsage(
        spawnCwd ?? PROJECT_DIR,
        sessionId,
        invocationStartedAt,
      );
      if (u) {
        invocationUsage = u;
        const c = calculateEstimatedCost(u, invocationContext.provider, invocationContext.model);
        if (c) {
          invocationCost = {
            currency: "USD",
            inputCost: c.breakdown.inputCost,
            outputCost: c.breakdown.outputCost,
            cacheCost: c.breakdown.cacheCost,
            totalCost: c.totalCost,
          };
        }
      }
    } catch {
      // best-effort — usage accounting must never break the invocation
    }
    await recordInvocationCompletion(invocationId, invocationUsage, invocationCost);

    // Check watchdog limits. Both suspend AND kill route through
    // handleTrigger, which dispatches by state (kill → audited terminate path).
    // `kill` is now reachable (#280): checkLimits escalates past the hard ceiling.
    const watchdogDecision = await checkLimits({ invocationId, sessionId: invocationSessionId });
    if (watchdogDecision.state === "suspend" || watchdogDecision.state === "kill") {
      console.warn(
        `[${new Date().toLocaleTimeString()}] Watchdog ${watchdogDecision.state}: ${watchdogDecision.reason}`,
      );
      await watchdogHandleTrigger(
        { invocationId, sessionId: invocationSessionId },
        watchdogDecision,
        { terminate: killActive },
      );
      // Send escalation notification for watchdog triggers
      try {
        const { handleWatchdogTrigger } = await import("./escalation");
        await handleWatchdogTrigger(watchdogDecision, {
          invocationId,
          sessionId: invocationSessionId,
        });
      } catch (escalationError) {
        console.error("[escalation] Failed to send watchdog notification:", escalationError);
      }
    }

    // Plugins: agent_end — fire-and-forget, does not block response
    if (pm && exitCode === 0) {
      pm.emitAsync(
        "agent_end",
        {
          messages: [{ role: "assistant", content: stdout }],
        },
        ctx,
      );
    }

    const output = [
      `# ${name}`,
      `Date: ${new Date().toISOString()}`,
      `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
      `Model config: ${usedFallback ? "fallback" : "primary"}`,
      ...(agentic.enabled ? [`Task type: ${taskType}`, `Routing: ${routingReasoning}`] : []),
      `Prompt: ${prompt}`,
      `Exit code: ${result.exitCode}`,
      "",
      "## Output",
      stdout,
      ...(stderr ? ["## Stderr", stderr] : []),
    ].join("\n");

    await Bun.write(logFile, output);
    // Count this invocation for rotation tracking on the legacy (global)
    // session path. Bus-mode agent sessions are counted separately via
    // `streamBusPrompt` in `src/bus/webui-bridge.ts`, which threads the
    // `agentId` through to `incrementMessageCount` so per-agent accounting
    // lands on the agent's own `session.json` (#213). The restart-based
    // rotation mechanism for those agent sessions is tracked in #227.
    if (!agentName && !threadId) await incrementMessageCount();
    console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

    // Fallback: append session log to MEMORY.md only if Claude didn't write it
    if (exitCode === 0 && stdout && name !== "bootstrap") {
      try {
        const memPath = getMemoryPath(agentName);
        if (existsSync(memPath)) {
          const { statSync } = await import("fs");
          const afterMtime = statSync(memPath).mtimeMs;

          // Claude wrote memory if the file was modified after we started this invocation
          const claudeWroteMemory = afterMtime > memMtimeBefore;

          if (!claudeWroteMemory) {
            const memContent = await readFile(memPath, "utf8");
            const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
            const summary = stdout.slice(0, 120).replace(/\n/g, " ").trim();
            const logEntry = `- ${ts} [${name}] ${summary}`;

            const logMarker = "## Session Log";
            const logIdx = memContent.indexOf(logMarker);
            if (logIdx !== -1) {
              const afterMarker = logIdx + logMarker.length;
              const updated =
                memContent.slice(0, afterMarker) + "\n" + logEntry + memContent.slice(afterMarker);
              const lines = updated.split("\n");
              const trimmed = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n" : updated;
              await writeFile(memPath, trimmed, "utf8");
            }
          }
        }
      } catch (e) {
        // Non-fatal
      }
    }

    // --- Watchdog: track consecutive timeouts ---
    // Skip tracking for unresolved session IDs ("unknown") to avoid cross-session
    // state collisions when a new session fails before its real ID is known.
    const trackingId = sessionId !== "unknown" ? sessionId : null;
    if (trackingId) {
      if (exitCode === 0) {
        clearSession(trackingId);
      } else {
        recordResult(trackingId, exitCode);
        const reason = abortReason(trackingId, watchdog);
        if (reason) {
          console.warn(`[${new Date().toLocaleTimeString()}] ${reason}`);
          clearSession(trackingId);
          return result;
        }
        // Non-timeout, non-zero exits: counter is already reset by recordResult.
        // Do NOT clearSession here — that would reset startedAt and weaken maxRuntimeSeconds.
      }
    }

    // --- Auto-compact on timeout (exit 124): PRINT PATH ONLY ---
    // Print-era recovery for a wedged `claude -p`. A PTY turn timeout is also exit 124
    // (so the watchdog and the "timed out" messages see it), but the supervisor has
    // already retired that PTY, and the runner does nothing more on it: no memory save,
    // no /compact, no re-run. PTY timeouts are often turn-detection misses on a healthy
    // session (#369, #316/#317); re-running would repeat tool side effects, and the
    // interactive REPL compacts its own context. The next turn on the key respawns and
    // resumes the stored session id.
    if (
      useLegacyPath &&
      COMPACT_TIMEOUT_ENABLED &&
      exitCode === 124 &&
      !isNew &&
      existing &&
      !recoveredFromStale
    ) {
      // No `sessionKey` below: the print opt-out has no supervisor session, so the
      // utility calls resume one-shot without touching the PTY machinery at all.
      // Save memory before compact wipes context.
      try {
        const memPath = getMemoryPath(agentName);
        console.log(
          `[${new Date().toLocaleTimeString()}] Pre-compact: saving memory to ${memPath}`,
        );
        const saved = await saveMemoryBeforeCompact({
          memPath,
          prompt: `Session is about to compact. Save your current memory to ${memPath} now. Include: current status, what was accomplished, key context for next session. Keep it concise.`,
          sessionId: existing.sessionId,
          skipLive: exitCode === 124,
          model: primaryConfig.model,
          cwd: spawnCwd,
          timeoutMs: 30_000,
        });
        if (!saved.ok) {
          console.warn(
            `[${new Date().toLocaleTimeString()}] Pre-compact memory save failed: ${saved.detail ?? saved.via}`,
          );
        }
      } catch (e) {
        console.warn(`[${new Date().toLocaleTimeString()}] Pre-compact memory save failed:`, e);
      }

      emitCompactEvent({ type: "auto-compact-start" });
      const compactOk = await runCompact({
        sessionId: existing.sessionId,
        skipLive: true,
        model: primaryConfig.model,
        timeoutMs,
        cwd: spawnCwd,
      });
      emitCompactEvent({ type: "auto-compact-done", success: compactOk });
      if (compactOk && pm) pm.emitAsync("after_compaction", {}, ctx);

      if (compactOk) {
        console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
        const retryExec = await execRecovery(args, primaryConfig);
        const retryResult: RunResult = {
          stdout: retryExec.rawStdout,
          stderr: retryExec.stderr,
          exitCode: retryExec.exitCode,
          ...(retryExec.sessionId || existing?.sessionId
            ? { sessionId: retryExec.sessionId || existing?.sessionId }
            : {}),
          ...(retryExec.exitCode !== 0 && retryExec.failureKind
            ? { failureKind: retryExec.failureKind }
            : {}),
        };
        emitCompactEvent({
          type: "auto-compact-retry",
          success: retryExec.exitCode === 0,
          stdout: retryResult.stdout,
          stderr: retryResult.stderr,
          exitCode: retryResult.exitCode,
        });

        if (retryExec.exitCode === 0) {
          const count = threadId
            ? await incrementThreadTurn(threadId)
            : await incrementTurn(agentName);
          console.log(
            `[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`,
          );
          // Check watchdog after successful retry
          const retryWatchdogDecision = await checkLimits({
            invocationId,
            sessionId: invocationSessionId,
          });
          if (retryWatchdogDecision.state === "suspend" || retryWatchdogDecision.state === "kill") {
            console.warn(
              `[${new Date().toLocaleTimeString()}] Watchdog ${retryWatchdogDecision.state} after retry: ${retryWatchdogDecision.reason}`,
            );
            await watchdogHandleTrigger(
              { invocationId, sessionId: invocationSessionId },
              retryWatchdogDecision,
              { terminate: killActive },
            );
          }
        }
        return retryResult;
      }
    }

    // --- Turn tracking & compact warning ---
    if (exitCode === 0 && !isNew && !recoveredFromStale) {
      const turnCount = threadId
        ? await incrementThreadTurn(threadId)
        : await incrementTurn(agentName);
      const turnLabel = threadId
        ? ` (thread ${threadId.slice(0, 8)})`
        : agentName
          ? ` (agent ${agentName})`
          : "";
      console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${turnLabel}`);

      if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
        if (threadId) {
          await markThreadCompactWarned(threadId);
        } else {
          await markCompactWarned(agentName);
        }
        emitCompactEvent({ type: "warn", turnCount });
      }

      // memory-search: periodic re-index every N turns (issue #19 follow-up).
      // Default 10 turns; 0 disables. Fire-and-forget — never blocks the runner.
      const memSettings = getSettings().memorySearch;
      const reindexEvery = memSettings?.reindexEveryNTurns ?? 10;
      if (reindexEvery > 0 && turnCount > 0 && turnCount % reindexEvery === 0) {
        console.log(
          `[${new Date().toLocaleTimeString()}] memory-search: periodic re-index (turn ${turnCount})`,
        );
        indexSessionsBackground(memSettings);
      }
    }

    return result;
  } finally {
    // Lifecycle hook (#268): drop the invocation record on EVERY exit path —
    // normal completion, early returns (budget block, consecutive-timeout
    // abort, auto-compact retry) and throws. Without this, `activeInvocations`
    // accumulates a record per cron firing; once any record ages past
    // maxRuntimeSeconds (default 2h) `checkLimits` returns suspend forever and
    // a CRITICAL watchdog handoff fires on every tick. Best-effort: a clear
    // failure must never mask the original result or throw.
    try {
      await watchdogClearInvocation(invocationId);
    } catch (clearErr) {
      console.warn(`[watchdog] clearInvocation(${invocationId}) failed:`, clearErr);
    }
    mainRunCount--;
    persistRunCount();
  }
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  modelOverride?: string | RunOptions,
  timeoutMs?: number,
  agentName?: string,
  timeoutCategory?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void,
  identity?: PolicyIdentity,
): Promise<RunResult> {
  return enqueue(
    () =>
      execClaude(
        name,
        prompt,
        threadId,
        resolveModelOverride(modelOverride),
        timeoutMs,
        agentName,
        timeoutCategory,
        onChunk,
        onToolEvent,
        identity,
      ),
    threadId,
  );
}

async function streamClaude(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  onAgentEvent?: (ev: AgentStreamEvent) => void,
): Promise<void> {
  if (resolveAgentTurnRoute(name) === "pty") {
    // #546: on PTY the chat is a turn on the shared global PTY, so it goes
    // through execClaude — the same prompt assembly (identity, memory, the
    // PTY output-format constraint), rotation and session handling as every
    // other global turn. A chat that spawned the global PTY with this
    // function's shorter prompt would fix it for all later turns. The PTY has
    // no structured Agent tool events, so onAgentEvent stays silent here.
    let unblocked = false;
    const unblock = (): void => {
      if (!unblocked) {
        unblocked = true;
        onUnblock();
      }
    };
    let textEmitted = false;
    try {
      const result = await execClaude(
        name,
        prompt,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (text) => {
          textEmitted = true;
          onChunk(text);
          unblock();
        },
        () => unblock(),
      );
      // A primary rate-limit notice says nothing about fallback delivery.
      // Emit buffered stdout only if this response's engine streamed no text.
      const needsFinalText = result.usedFallback ? !result.fallbackStreamedText : !textEmitted;
      if (needsFinalText && result.stdout) onChunk(result.stdout);
    } finally {
      unblock();
    }
    return;
  }

  await mkdir(LOGS_DIR, { recursive: true });

  // Rotate the global session if thresholds are exceeded (mirrors the check in execClaude).
  let streamRotationSummary: string | null = null;
  const { session: streamSessionConfig } = getSettings();
  if (streamSessionConfig.autoRotate) {
    const streamPeeked = await peekSession();
    if (streamPeeked && needsRotation(streamPeeked, streamSessionConfig)) {
      streamRotationSummary = await rotateSession(streamSessionConfig);
    }
  }

  const existing = await getSession();
  const { security, model, api } = getSettings();
  const securityArgs = buildSecurityArgs(security);

  // Plugins: before_agent_start
  const streamPm = getPluginManager();
  const streamCtx = pluginCtx();
  if (streamPm) await streamPm.emit("before_agent_start", { prompt }, streamCtx);

  // stream-json gives us events as they happen — text before tool calls,
  // so we can unblock the UI as soon as Claude acknowledges, not after sub-agents finish.
  // --verbose is required for stream-json to produce output in -p (print) mode.
  const args = [
    CLAUDE_EXECUTABLE,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    ...securityArgs,
  ];

  if (existing) args.push("--resume", existing.sessionId);

  const appendParts: string[] = ["You are running inside ClaudeClaw."];

  if (streamRotationSummary)
    appendParts.push(`Context from the previous session:\n\n${streamRotationSummary}`);

  try {
    const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
    if (claudeMd.trim()) appendParts.push(claudeMd.trim());
  } catch {}

  // Plugins: before_prompt_build
  if (streamPm) {
    const pluginResult = await streamPm.emit("before_prompt_build", { prompt }, streamCtx);
    if (pluginResult?.appendSystemContext) appendParts.push(pluginResult.appendSystemContext);
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm" && normalizedModel !== "kimi-k2p6")
    args.push("--model", model.trim());

  const childEnv = buildChildEnv(cleanSpawnEnv(), model, api);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (stream-json, session: ${existing?.sessionId?.slice(0, 8) ?? "new"})`,
  );

  // The dashboard chat resumes the global session on print; retire its PTY first (see above).
  await retireLivePtysBeforePrint(["global"]);
  const proc = await spawnClaude(args, { env: childEnv });

  // Collect stderr in the background so it doesn't back-pressure the process.
  // We need it after proc.exited for stale session detection.
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let unblocked = false;
  let textEmitted = false;
  // Track pending Agent tool calls: tool_use_id → description
  const pendingAgents = new Map<string, string>();

  const maybeUnblock = () => {
    if (!unblocked) {
      unblocked = true;
      onUnblock();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Parse complete newline-delimited JSON events
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;

        if (event.type === "system" && (event.subtype === "init" || event.session_id)) {
          // Capture session ID for new sessions
          const sid = event.session_id as string | undefined;
          if (sid && !existing) {
            await createSession(sid);
            console.log(
              `[${new Date().toLocaleTimeString()}] Session created (stream-json): ${sid}`,
            );
          }
        } else if (event.type === "assistant") {
          // Text and tool_use blocks from the assistant
          type ContentBlock = {
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          };
          const msg = event.message as { content?: ContentBlock[] } | undefined;
          const blocks = msg?.content ?? [];
          let hasActivity = false;
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              onChunk(block.text);
              textEmitted = true;
              hasActivity = true;
            }
            // Detect Agent tool spawns and emit lifecycle event
            if (block.type === "tool_use" && block.name === "Agent" && block.id && onAgentEvent) {
              const description = String(
                block.input?.description ?? block.input?.prompt ?? "Running background task...",
              );
              pendingAgents.set(block.id, description);
              onAgentEvent({ type: "spawn", id: block.id, description });
              hasActivity = true;
            }
            // Always emit plugin observation for all tool_use blocks (including Agent)
            if (block.type === "tool_use") {
              hasActivity = true;
              if (streamPm && block.name) {
                streamPm.emitAsync(
                  "tool_result_persist",
                  {
                    toolName: block.name,
                    params: block.input ?? {},
                    message: {
                      content: [
                        { type: "text", text: JSON.stringify(block.input ?? {}).slice(0, 500) },
                      ],
                    },
                  },
                  streamCtx,
                );
              }
            }
          }
          if (hasActivity) maybeUnblock();
        } else if (event.type === "user") {
          // Tool results come back as user messages — match Agent completions
          type ToolResultBlock = { type: string; tool_use_id?: string; content?: unknown };
          const msg = event.message as { content?: ToolResultBlock[] } | undefined;
          const blocks = msg?.content ?? [];
          for (const block of blocks) {
            if (
              block.type === "tool_result" &&
              block.tool_use_id &&
              pendingAgents.has(block.tool_use_id)
            ) {
              const description = pendingAgents.get(block.tool_use_id)!;
              pendingAgents.delete(block.tool_use_id);
              const result =
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content ?? "");
              if (onAgentEvent)
                onAgentEvent({ type: "done", id: block.tool_use_id, description, result });
            }
          }
        } else if (event.type === "tool_use") {
          // Top-level tool_use event (some stream-json versions) — unblock the UI
          maybeUnblock();
        } else if (event.type === "result") {
          // Final result event — emit text as fallback if no assistant text was seen
          const resultText = (event as Record<string, unknown>).result as string | undefined;
          if (resultText && !textEmitted) {
            onChunk(resultText);
          }
          maybeUnblock();
        }
      } catch {}
    }
  }

  await proc.exited;
  const stderrText = await stderrPromise;

  // --- Stale session recovery (stream path) ---
  if (
    existing &&
    !textEmitted &&
    (proc.exitCode ?? 0) !== 0 &&
    isStaleSessionError("", stderrText)
  ) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Stale session ${existing.sessionId.slice(0, 8)} for ${name} (stream); recovering with a new session...`,
    );
    await backupSession();
    await streamClaude(name, prompt, onChunk, onUnblock, onAgentEvent);
    return;
  }

  // Ensure unblock fires even if something unexpected happened
  maybeUnblock();

  // Plugins: agent_end
  if (streamPm) streamPm.emitAsync("agent_end", { messages: [] }, streamCtx);

  // Count this invocation for rotation tracking.
  await incrementMessageCount();

  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name}`);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  onAgentEvent?: (ev: AgentStreamEvent) => void,
): Promise<void> {
  return enqueue(() =>
    streamClaude(name, prefixUserMessageWithClock(prompt), onChunk, onUnblock, onAgentEvent),
  );
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(
  name: string,
  prompt: string,
  threadId?: string,
  agentName?: string,
  onChunk?: (text: string) => void,
  onToolEvent?: (line: string) => void,
  modelOverride?: string,
  identity?: PolicyIdentity,
): Promise<RunResult> {
  return run(
    name,
    prefixUserMessageWithClock(prompt),
    threadId,
    modelOverride,
    undefined,
    agentName,
    undefined,
    onChunk,
    onToolEvent,
    identity,
  );
}

// Path where Claude Code stores session JSONL transcripts for this project
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/root",
  ".claude",
  "projects",
  encodeCwdForProjectsDir(PROJECT_DIR), // #368: the CLI's rule, not `/`-only
);

const FORK_SYSTEM_PROMPT = [
  "You are a FORK AGENT — a fast, lightweight watcher running in parallel with the main agent.",
  "",
  "SPEED IS YOUR PRIORITY. Be brief. Answer in 1-3 sentences. No preamble, no padding.",
  "Do NOT over-analyze. Do NOT think through edge cases. Just answer and stop.",
  "",
  "Your job: answer quick questions and peek at the main agent's progress via its session transcript.",
  "",
  "DENY immediately (one sentence explanation) any request that would take more than ~30 seconds:",
  "• Compiling / building anything (kernels, projects, binaries)",
  "• Downloads or network fetches",
  "• Fuzzing, long analysis, heavy computations",
  "• Anything that would block you and prevent monitoring/killing the main agent",
  "",
  "ALLOW:",
  "• Reading files (especially JSONL transcripts to report main agent progress)",
  "• Short factual answers",
  "• Reporting on what the main agent is currently doing",
  "",
  `Main session info lives at: /project/.claude/claudeclaw/session.json`,
  `Session JSONL transcripts dir: ${CLAUDE_SESSIONS_DIR}`,
  "To peek at main agent progress: read session.json for the session ID, then read the .jsonl file in the transcripts dir.",
  "Each JSONL line is a turn. The last few lines show what the main agent is currently doing.",
].join("\n");

const FORK_MODEL = "claude-haiku-4-5-20251001";

// Forks are lightweight watchers — hard-kill after 2 minutes.
const FORK_TIMEOUT_MS = 120_000;

/**
 * Run a fork agent — parallel, outside the main serial queue, no main session.
 *
 * Spawns directly rather than through runClaudeOnce so the fork proc is never
 * added to mainActiveProcs — /kill must only target main-queue runs, not forks.
 * Uses the same collectStream + timeout pattern as the main runner so forks
 * cannot hang indefinitely or grow memory unbounded.
 */
export async function runFork(prompt: string): Promise<RunResult> {
  const { api, security } = getSettings();
  const baseEnv = cleanSpawnEnv();
  const securityArgs = buildSecurityArgs(security);

  if (resolveAgentTurnRoute() === "pty") {
    // #546: an ephemeral PTY, outside the LRU and out of `/kill`'s reach like
    // the `-p` fork (never in mainActiveProcs).
    const exec = await runOneShotOnPty(`fork:${crypto.randomUUID()}`, prompt, {
      timeoutMs: FORK_TIMEOUT_MS,
      modelOverride: FORK_MODEL,
      api,
      securityArgs,
      appendSystemPrompt: `${FORK_SYSTEM_PROMPT}\n\n${PTY_OUTPUT_FORMAT_CONSTRAINT}`,
      survivesKill: true,
    });
    if (exec.timedOut) {
      return { stdout: "", stderr: `Fork timed out after ${FORK_TIMEOUT_MS / 1000}s`, exitCode: 1 };
    }
    return { stdout: exec.rawStdout, stderr: exec.stderr, exitCode: exec.exitCode };
  }

  const args = [
    CLAUDE_EXECUTABLE,
    "-p",
    prompt,
    "--output-format",
    "json",
    ...securityArgs,
    "--model",
    FORK_MODEL,
    "--append-system-prompt",
    FORK_SYSTEM_PROMPT,
  ];

  const proc = await spawnClaude(args, { env: buildChildEnv(baseEnv, FORK_MODEL, api) });

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error(`Fork timed out after ${FORK_TIMEOUT_MS / 1000}s`));
    }, FORK_TIMEOUT_MS);
  });

  let rawStdout: string;
  let rawStderr: string;
  let exitCode: number;

  try {
    [rawStdout, rawStderr] = (await Promise.race([
      Promise.all([
        collectStream(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        collectStream(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
      ]),
      timeoutPromise,
    ])) as [string, string];
    if (timeoutId) clearTimeout(timeoutId);
    await proc.exited;
    exitCode = proc.exitCode ?? 1;
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return { stdout: "", stderr: String(err), exitCode: 1 };
  }

  let stdout = rawStdout;
  if (exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      stdout = json.result ?? rawStdout;
    } catch {}
  }

  return { stdout, stderr: rawStderr, exitCode };
}

/**
 * The timeout handed to a PTY bootstrap's single `runOnPty` attempt. Issue #369 measured a
 * 38.7 s real PTY cold start (spawn, MCP fleet, first turn), so 30 s failed a healthy boot;
 * 120 s is ~3x that, and far under the 5 min `timeouts.default`, because bootstrap holds
 * the serial queue a first channel message waits behind. It is a per-stage bound, not a
 * total: `runOnPty` bounds four stages separately by `timeoutMs` (admission, lock wait,
 * spawn, turn; 88cc310f), so the worst case a bootstrap holds the queue is up to 4x this
 * value. About 3x on first boot, because nothing else holds the `global` lock yet. It
 * never blocks startup itself: the daemon runs it in the background.
 */
export const BOOTSTRAP_PTY_MAX_MS = 120_000;

/**
 * The bootstrap's one-attempt timeout. The PTY route is capped at `BOOTSTRAP_PTY_MAX_MS`
 * (a smaller configured `timeouts.default` still wins); the explicit print opt-out keeps
 * `timeouts.default`, as the old bootstrap did.
 */
export function resolveBootstrapTimeoutMs(route: "pty" | "legacy", configuredMs: number): number {
  return route === "pty" ? Math.min(configuredMs, BOOTSTRAP_PTY_MAX_MS) : configuredMs;
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  // Reserve the same serial queue used by global chat before doing any I/O.
  // A channel turn arriving during startup waits behind this one attempt;
  // a session already created by an earlier turn makes bootstrap a no-op.
  return enqueue(async () => {
    const existing = await getSession();
    if (existing) return;

    console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
    const { session: sessionConfig } = getSettings();
    const summary = sessionConfig.summaryPath
      ? await loadLatestSummary(sessionConfig.summaryPath)
      : null;
    const wakeupPrompt = summary
      ? `Wakeup, my friend!\n\nContext from the previous session:\n\n${summary}`
      : "Wakeup, my friend!";
    const result = await execClaude(
      "bootstrap",
      wakeupPrompt,
      undefined,
      undefined,
      resolveBootstrapTimeoutMs(resolveAgentTurnRoute("bootstrap"), resolveTimeoutMs("bootstrap")),
    );
    if (result.exitCode !== 0) {
      if (resolveAgentTurnRoute("bootstrap") === "pty") await retirePtySession("global");
      throw new Error(`Bootstrap exited ${result.exitCode}`);
    }
    console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
  });
}
