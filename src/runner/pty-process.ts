/**
 * Single-PTY wrapper around one `claude` interactive process.
 *
 * Knows nothing about supervisors, sessions, or adapters. Stateless beyond
 * the PTY handle it owns. Implements the contract from SPEC §3.1 verbatim.
 *
 * ─── Turn detection: sentinel-echo round-trip (issue #81) ────────────────────
 *
 * Claude 2.1.89 dropped the OSC 9;4 progress markers earlier versions emitted
 * around each turn. To detect turn completion without those markers, runTurn
 * uses a sentinel-echo round-trip implemented in `pty-output-parser.ts`:
 *
 *   1. Write the user prompt + `\r` to the PTY (claude submits on Enter).
 *   2. Accumulate every byte that comes back.
 *   3. When the stream has been silent for `quietWindowMs` (default 500ms),
 *      write a unique sentinel string into claude's prompt buffer WITHOUT a
 *      trailing `\r`. claude's TUI echoes the bytes straight back into stdout.
 *   4. When the echo is seen, the turn is complete. The response is the slice
 *      from `turn-start.offset` up to `sentinel-found.offset`.
 *   5. Send Ctrl-U (0x15, `kill-line`) to clear the sentinel from claude's
 *      input buffer before the next turn.
 *
 * Fallback: if the sentinel never echoes back within `sentinelMaxWaitMs`
 * (claude crashed, TUI stalled), the turn completes with `cleanBoundary=false`
 * and whatever bytes were captured.
 *
 * ─── OR-6 decision (session-ID) ──────────────────────────────────────────────
 *   Pre-allocate via `--session-id <uuid>` for fresh spawns when
 *   `opts.newSessionId` is provided. The TUI does NOT print a session UUID at
 *   startup. When neither `sessionId` nor `newSessionId` is provided, we spawn
 *   without any session flag and Claude allocates internally. An untrusted
 *   one-shot (`isolation: "untrusted"`) takes neither flag even when an id is
 *   set: `buildClaudeArgs` returns early with interactive isolation flags.
 */
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { SecurityConfig } from "../config";
import { untrustedInteractiveArgs } from "../oneshot/isolation.js";
import { cliModelFlag } from "../oneshot/model.js";
import { withCleanProcessEnv } from "../runner";
import {
  createParser,
  decodeTurn,
  encodeSentinel,
  feed,
  buildSentinel,
  markSentinelWritten,
  resetTurn,
  startTurn,
  stripAnsi,
  tick,
  type Parser,
} from "./pty-output-parser";
// Re-export the sanitiser from its standalone home so existing callers that
// pull it from `pty-process` (and through `runner/index`) keep working without
// loading bun-pty just to get the helper.
import {
  neutralizeFileMentions,
  preparePtyPromptForWrite,
  sanitizePtyPromptText,
} from "./pty-prompt-sanitizer";
import { promptPrepareOverride, untrustedFileMentionNeutralizing } from "./pty-process-test-seams";
import { appendFileSync } from "node:fs";
import {
  type GroupTerminationOptions,
  type SurvivorCause,
  terminateProcessGroup,
} from "./pty-group-kill";
import { processStartMs } from "./pty-proc-identity";
import { Screen } from "./pty-screen";

/**
 * Raw PTY trace, off unless `CLAUDECLAW_PTY_DUMP=<file>` is set. Every chunk
 * claude emits and every write we make lands in the file, timestamped, with
 * the parser state at that instant. Issue #369 was found this way: a
 * standalone capture harness reproduces claude's boot but not our input
 * protocol, so its silence says nothing about the daemon (see the issue's
 * caveat) — this trace is the daemon's own bytes. Best-effort: a failed write
 * never touches the turn.
 */
function dumpPtyTrace(tag: string, payload: string): void {
  const file = process.env.CLAUDECLAW_PTY_DUMP;
  if (!file) return;
  try {
    appendFileSync(file, `\n@@${new Date().toISOString()} ${tag}\n${payload}`, { mode: 0o600 });
  } catch {
    /* diagnostic only */
  }
}
export { sanitizePtyPromptText };

// ─── Public types (FROZEN per SPEC §3.1) ────────────────────────────────────

export interface PtyProcessOptions {
  /** One-shot isolation overrides every persona, resume and permission flag. */
  isolation?: "untrusted" | "trusted-session";
  /**
   * Retire the child's whole process group, and wait until it is gone (pty-group-kill).
   * Default: on for an untrusted one-shot, off otherwise. Trusted sessions keep the old
   * retirement: tests drive them with fake pids, and a group signal to a fake pid would
   * hit a real process.
   */
  terminateGroup?: boolean;
  /** Test seam: how long an untrusted spawn waits for the REPL footer. Default 20 s. */
  _replReadyBudgetMs?: number;
  /**
   * Called with the pid, and the leader's start time recorded at spawn (null when it could not be
   * read), and why: the group is still alive, an escapee outside it is, or the escapee scan could
   * not tell (`scan-unknown`). Called when retirement could not get all of that to disappear.
   * It must not throw: if it does,
   * the error is logged and `dispose()` rejects, so the caller keeps whatever the child may
   * still be writing into.
   */
  onGroupSurvived?: (pid: number, startMs: number | null, cause: SurvivorCause) => void;
  /**
   * Called once the group is gone: stop descendants that left it (Linux, see pty-escape-scan),
   * given the leader's pid and the start time recorded at spawn (a process older than that
   * cannot be ours). Resolves the pids that are still alive; a rejection (`/proc` could not be
   * listed) counts as "could not tell" and fails closed like a survivor.
   */
  reapEscapees?: (leader: { pid: number; startMs: number | null }) => Promise<number[]>;
  /** Test seam: signal function, clock and timings of the group termination. */
  _groupTermination?: GroupTerminationOptions;
  /** Existing Claude Code session ID to resume via `claude --resume <id>`.
   *  Empty string means "no resume". */
  sessionId: string;
  /** Optional: pre-allocate a specific session UUID via
   *  `claude --session-id <uuid>`. Mutually exclusive with a non-empty
   *  sessionId. */
  newSessionId?: string;
  /** Working directory for the spawned `claude` process. */
  cwd: string;
  /** Display label for logs only. NOT a session key. */
  agentName?: string;
  /** Model alias/name to pass via `--model`. Empty → no flag. */
  modelOverride?: string;
  /** Security profile mirroring `buildSecurityArgs` for `claude -p`.
   *  Used as a fallback when `securityArgs` is not provided. */
  security: SecurityConfig;
  /**
   * Pre-built argv produced by runner.ts:`buildSecurityArgs(security)`. When
   * provided, the PTY wrapper uses these flags verbatim instead of deriving
   * them from `security`. (Phase D fix #3 for MAJOR-2/MAJOR-3.)
   */
  securityArgs?: string[];
  /**
   * Optional system prompt to append via `--append-system-prompt <text>`.
   * (Phase D fix #2 for CRITICAL-1.)
   *
   * Operator note (issue #65 item 7): the assembled text is passed on the
   * spawned `claude` argv and is therefore visible to other UIDs via `ps aux`
   * (or equivalent) on shared multi-user hosts. This is parity with the
   * legacy `claude -p` path (no new attack surface), but operators deploying
   * on shared servers should treat the system-prompt payload as low-secrecy
   * — do not embed long-lived secrets in it.
   */
  appendSystemPrompt?: string;
  /** Untrusted one-shots only: the request's `system`, passed as `--system-prompt` as the
   *  print engine does. Trusted spawns use `appendSystemPrompt`. */
  systemPrompt?: string;
  /** Env vars to pass to the child. Caller is responsible for a sanitised env. */
  env: Record<string, string>;
  /**
   * Absolute path to a synthesized `--mcp-config` JSON written by the
   * supervisor (see SPEC §4.5). When set, the PTY appends
   * `--mcp-config <path>` to claude's argv.
   */
  mcpConfigPath?: string;
  /** Initial PTY columns. Default 100. */
  cols?: number;
  /** Initial PTY rows. Default 30. */
  rows?: number;
  /** Idle-timeout safety net for runTurn (cap on absolute response time when
   *  the sentinel echo never arrives). Default 30000ms. */
  turnIdleTimeoutMs?: number;
  /** Quiet window (ms) of inactivity before runTurn writes the sentinel.
   *  Default: 500. */
  quietWindowMs?: number;
  /** Hard cap (ms) waiting for the sentinel echo after we write it. After
   *  this elapses with no echo, the turn completes with cleanBoundary=false.
   *  Default: 30_000. */
  sentinelMaxWaitMs?: number;
  /**
   * INTERNAL TEST HOOK: command path to spawn instead of `claude`.
   * Used by unit tests to substitute /bin/cat etc. NOT a public API.
   */
  _commandOverride?: string;
  /**
   * INTERNAL TEST HOOK: when true, do NOT append the standard claude flags
   * (security, --resume, --session-id, --model).
   */
  _skipClaudeArgs?: boolean;
  /**
   * INTERNAL TEST HOOK: alternative arg list to use instead of the
   * claude-args built from the options.
   */
  _argsOverride?: string[];
  /**
   * INTERNAL TEST HOOK: injectable clock for deterministic timing tests.
   * Returns ms-epoch like Date.now(). Default: Date.now.
   */
  _now?: () => number;
  /**
   * INTERNAL TEST HOOK: injectable setTimeout for deterministic tests.
   * Default: global setTimeout.
   */
  _setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * INTERNAL TEST HOOK: injectable clearTimeout. Default: global clearTimeout.
   */
  _clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * INTERNAL TEST HOOK: injectable setInterval / clearInterval (for the
   * quiet-tick poll). Defaults: global setInterval / clearInterval.
   */
  _setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  _clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  /**
   * INTERNAL TEST HOOK: skip waiting for first bytes at spawn (some test
   * targets like /bin/cat are silent on startup). Default false.
   */
  _skipReadySettle?: boolean;
  /**
   * INTERNAL TEST HOOK: override the per-turn sentinel UUID. When set, the
   * supervisor uses this string instead of a fresh crypto.randomUUID(). Lets
   * tests pin the exact sentinel bytes the PTY will write.
   */
  _sentinelUuidOverride?: () => string;
}

/**
 * Diagnostic snapshot captured when a PTY exits before its TUI settles.
 * Issue #176 — before this existed, the error message was just "PTY for
 * claude exited before TUI settled (pid=N)" with no signal as to *why*
 * claude exited. Production saw 36 cron-job failures fitting this shape
 * since 2026-05-19; we couldn't tell whether claude was hitting an auth
 * error, an updater crash, an OOM, or a stale-JSONL refusal.
 */
export interface PtyExitInfo {
  /** Exit code if the process exited with one. `null` when killed by signal. */
  exitCode: number | null;
  /** Signal name if the process was killed (`"SIGKILL"`, `"SIGTERM"`, …). */
  signal: string | null;
  /** Milliseconds between spawn and exit. */
  elapsedMs: number;
  /** Last ≤8 KB of PTY output before exit, ANSI-stripped, control-char
   *  squashed, AND credential patterns (sk-*, Bearer, JWT, GitHub PATs,
   *  Slack tokens) replaced with `<redacted>`. Operator-facing diagnostic;
   *  not a precise machine record. */
  tail: string;
}

export interface PtyProcess {
  readonly label: string;
  readonly pid: number;
  /** The leader's start time recorded at spawn (untrusted children only); null when not read. */
  readonly leaderStartMs?: number | null;
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  lastTurnEndedAt(): number;
  /** Diagnostic snapshot of how the PTY exited. Returns `null` while the
   *  process is still alive; populated as soon as `_handleExit` fires. */
  exitInfo(): PtyExitInfo | null;
  runTurn(
    prompt: string,
    opts: {
      timeoutMs: number;
      onChunk?: (text: string) => void;
      onToolEvent?: (line: string) => void;
      /** Deliberate REPL command (`/compact`); honoured only for an exact allowed command. */
      allowReplCommand?: boolean;
    },
  ): Promise<PtyTurnResult>;
  dispose(): Promise<void>;
}

export interface PtyTurnResult {
  text: string;
  bytesCaptured: number;
  cleanBoundary: boolean;
  sessionId: string;
}

/**
 * Type of the `spawnPty` factory function. Exposed so the supervisor (and
 * tests) can declare an injectable spawn seam (`injectSpawnPty`) without
 * importing the concrete `spawnPty` symbol from this file at top-level.
 */
export type SpawnPty = (opts: PtyProcessOptions) => Promise<PtyProcess>;

export class PtyTurnTimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly elapsedMs: number,
  ) {
    super(`PTY turn timed out for ${label} after ${elapsedMs}ms`);
    this.name = "PtyTurnTimeoutError";
  }
}

/**
 * An untrusted one-shot's REPL never became usable (a login, onboarding or trust screen, or no
 * footer in time), so the prompt was not written. Only the reason code is carried.
 */
export class PtyNotReadyError extends Error {
  constructor(
    public readonly label: string,
    public readonly reason: string,
  ) {
    super(`untrusted PTY not ready (${reason}); nothing was sent`);
    this.name = "PtyNotReadyError";
  }
}

export class PtyClosedError extends Error {
  constructor(
    public readonly label: string,
    public readonly exitCode: number | null,
    public readonly signal: string | null,
  ) {
    super(`PTY closed during turn for ${label} (exit=${exitCode} signal=${signal})`);
    this.name = "PtyClosedError";
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_QUIET_WINDOW_MS = 500;
const DEFAULT_SENTINEL_MAX_WAIT_MS = 30_000;
const DEFAULT_QUIET_TICK_MS = 50;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_PERMISSION_MODE_ARGS = ["--dangerously-skip-permissions"];
/** Bracketed-paste markers (xterm mode 2004, which claude's TUI turns on) (#559). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Delay between the project MCP server dialog showing and its Esc (#469). */
const MCP_DIALOG_ANSWER_DELAY_MS = 500;
/**
 * Hard cap on the tail ring buffer that captures pre-settle PTY output for
 * the issue #176 diagnostic snapshot. 8 KiB is enough to hold a typical
 * claude error message (auth failure, missing binary, updater crash, …)
 * without bloating per-PTY memory. Anything older slides off.
 */
const SETTLE_TAIL_MAX_BYTES = 8 * 1024;

/** `ok: false` carries a reason code (never screen text). */
interface ReplReadyVerdict {
  ok: boolean;
  reason?: string;
}

/** An untrusted spawn waits this long for claude's REPL footer before giving up. */
const UNTRUSTED_REPL_READY_MS = 20_000;

/**
 * Boot screens that are not a usable REPL: a login or onboarding menu, a trust dialog, or the
 * REPL's own "Not logged in" status (the footer is painted in that state too, so it alone
 * proves nothing). Matched on the ANSI-stripped screen with gaps allowed, because the
 * renderer draws word gaps as cursor moves.
 */
export const BLOCKED_BOOT_SCREENS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "login-required",
    /Not\s*logged\s*in|Run\s*\/login|Select\s*login\s*method|Paste\s*code\s*here/i,
  ],
  ["onboarding", /Choose\s*the\s*text\s*style|Let'?s\s*get\s*started/i],
  ["trust-dialog", /trust\s*this\s*folder|Do\s*you\s*trust\s*the\s*files/i],
];

/**
 * claude's idle REPL footer: the mode-cycler hint ("tab to cycle", every mode of 2.1.304 that
 * has one) or the default mode's "? for shortcuts".
 */
export const REPL_FOOTER = /tab\s*to\s*cycle|for\s*shortcuts/;

/** A child that exited on its own is still swept for descendants for this long. */
const GROUP_SWEEP_MAX_AGE_MS = 30_000;

/**
 * Patterns redacted from `_readTailSnapshot()` before the tail is exposed
 * via `exitInfo().tail` or interpolated into the supervisor's "exited
 * before TUI settled" error message. Issue #176 security-review follow-up:
 * a misbehaving claude printing an auth-failure message with the leaked
 * token attached would otherwise land it in stderr → journald / Sentry.
 * The patterns are intentionally broad — false positives ("redacted" in
 * place of an innocent UUID) are cheap; false negatives are a credential
 * leak.
 */
const TAIL_REDACTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic API keys, long-lived OAuth tokens, session tokens — anything
  // starting with `sk-` followed by ≥ 20 token chars.
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Generic `Bearer <token>` header values.
  /\bBearer\s+[A-Za-z0-9_.-]{16,}/g,
  // JWTs: `header.payload.sig` shape with base64url tokens.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // GitHub personal-access tokens.
  /\bghp_[A-Za-z0-9]{36}\b/g,
  // GitHub fine-grained personal-access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack bot / app / user tokens (xoxb / xoxa / xoxp / xoxs).
  /\bxox[bapso]-[A-Za-z0-9-]{10,}/g,
  // `id.secret` tokens with no recognisable prefix (the z.ai GLM form).
  /\b[A-Za-z0-9]{32}\.[A-Za-z0-9]{16,}/g,
];

/** Child-env names whose values are credentials, beyond the suffix rule below. */
const CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "KIMI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
/** A name ending like a credential: `FOO_API_KEY`, `DB_PASSWORD`, `GCP_CREDENTIALS`, … */
const CREDENTIAL_ENV_SUFFIX = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)$/i;
/** A URL-valued name whose value may embed `scheme://user:password@host`. */
const URL_ENV_SUFFIX = /(?:URL|URI|DSN)$/i;
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:([^\s/@]+)@/i;
/** Shorter values are not worth redacting: they would mangle ordinary words. */
const MIN_REDACTED_SECRET_LENGTH = 8;

/**
 * The credential values in the child's env. The prefix patterns above only know a few
 * token shapes; the child gets `ANTHROPIC_AUTH_TOKEN` / `KIMI_API_KEY` values of any
 * shape, and one printed in an auth failure must not reach the log or a chat reply.
 * For a `*_URL` / `*_URI` / `*_DSN` value with `scheme://user:pass@host`, the password.
 * Longest first, so a value that contains another is replaced whole.
 */
export function collectSecretValues(env: Record<string, string | undefined> | undefined): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!value) continue;
    if (CREDENTIAL_ENV_NAMES.has(name) || CREDENTIAL_ENV_SUFFIX.test(name)) {
      if (value.length >= MIN_REDACTED_SECRET_LENGTH) values.add(value);
    } else if (URL_ENV_SUFFIX.test(name)) {
      const password = URL_PASSWORD.exec(value)?.[1];
      if (password && password.length >= MIN_REDACTED_SECRET_LENGTH) values.add(password);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * A regex matching `value` with optional whitespace between any two characters, because
 * the TUI hard-wraps at `pty.cols` and a token printed in a banner comes back as two
 * halves split by a newline and the indent of the next row. The parts are single escaped
 * literals joined by `\s*`, so the `\s*` sits between characters and not after the last;
 * literals are never whitespace (a value containing whitespace is matched exactly
 * instead), so there is nothing to backtrack over and the cost is linear in the tail.
 */
function wrappedSecretRegex(value: string): RegExp | null {
  if (/\s/.test(value)) return null;
  const parts = [...value].map((ch) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"));
  return new RegExp(parts.join("\\s*"), "g");
}

/**
 * Replace credentials in `text` with `<redacted>` so the tail can be logged. The text MUST
 * be bounded: the JWT pattern is quadratic on unbounded input, and the 8 KiB tail cap
 * (`SETTLE_TAIL_MAX_BYTES`) is what makes that safe. Exact credential values are redacted
 * even when the TUI wrapped them across lines.
 */
export function redactSecretsInTail(text: string, secretValues: readonly string[] = []): string {
  let out = text;
  for (const value of secretValues) {
    out = out.split(value).join("<redacted>");
    const wrapped = wrappedSecretRegex(value);
    if (wrapped) out = out.replace(wrapped, "<redacted>");
  }
  for (const pattern of TAIL_REDACTION_PATTERNS) {
    out = out.replace(pattern, "<redacted>");
  }
  return out;
}

/** Build the argv for spawning `claude` based on options. See header. */
function buildClaudeArgs(opts: PtyProcessOptions): string[] {
  if (opts._argsOverride) return opts._argsOverride;
  if (opts._skipClaudeArgs) return [];

  const args: string[] = [];

  if (opts.isolation === "untrusted") {
    const model = cliModelFlag(opts.modelOverride);
    if (model) args.push("--model", model);
    // Same flag the print engine passes for `req.system`; not print-only.
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    args.push(...untrustedInteractiveArgs());
    return args;
  }

  if (opts.securityArgs && opts.securityArgs.length > 0) {
    args.push(...opts.securityArgs);
  } else {
    args.push(...DEFAULT_PERMISSION_MODE_ARGS);
    switch (opts.security.level) {
      case "locked":
        args.push("--tools", "Read,Grep,Glob,Write");
        break;
      case "strict":
        args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
        break;
    }
    if (opts.security.allowedTools.length > 0) {
      args.push("--allowedTools", opts.security.allowedTools.join(" "));
    }
    if (opts.security.disallowedTools.length > 0) {
      args.push("--disallowedTools", opts.security.disallowedTools.join(" "));
    }
  }

  if (opts.sessionId && opts.sessionId.length > 0) {
    args.push("--resume", opts.sessionId);
  } else if (opts.newSessionId && opts.newSessionId.length > 0) {
    args.push("--session-id", opts.newSessionId);
  }

  const model = cliModelFlag(opts.modelOverride);
  if (model) args.push("--model", model);

  if (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.mcpConfigPath && opts.mcpConfigPath.length > 0) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  return args;
}

/**
 * Test-only re-export of `buildClaudeArgs`. NOT part of the SPEC §3.1 public
 * contract.
 */
export function __buildClaudeArgsForTests(opts: PtyProcessOptions): string[] {
  return buildClaudeArgs(opts);
}

// ─── PtyProcess implementation ──────────────────────────────────────────────

class PtyProcessImpl implements PtyProcess {
  public readonly label: string;
  public readonly cwd: string;
  private _pid: number;
  private _sessionId: string;
  private _alive: boolean = true;
  private _lastTurnEndedAt: number = 0;
  private _pty: IPty;
  private readonly _quietWindowMs: number;
  private readonly _preparePrompt: typeof preparePtyPromptForWrite;
  private readonly _sentinelMaxWaitMs: number;
  private readonly _now: () => number;
  private readonly _setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly _setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  private readonly _sentinelUuidGen: () => string;

  /** Accumulated bytes for the in-flight turn, OR all bytes when no turn
   *  is in flight (kept so idle-fallback can produce a defensible response). */
  private _turnBuf: Uint8Array[] = [];
  private _turnBufLen = 0;
  private _parser: Parser;

  /** Whether we are currently inside a runTurn call. */
  private _turnInProgress = false;
  /** Resolver for the current runTurn promise. */
  private _turnResolve: ((result: PtyTurnResult) => void) | null = null;
  private _turnReject: ((err: Error) => void) | null = null;
  private _turnHardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _quietTickHandle: ReturnType<typeof setInterval> | null = null;
  private _sentinelDeadlineHandle: ReturnType<typeof setTimeout> | null = null;
  private _turnStartedAt = 0;
  /** Sentinel state for the current turn. */
  private _activeSentinelBytes: Uint8Array | null = null;
  private _activeSentinelString = "";
  private _disposed = false;
  /** Listener disposables from bun-pty. */
  private _onDataDisposable: { dispose(): void } | null = null;
  private _onExitDisposable: { dispose(): void } | null = null;
  /** Optional callbacks from the current runTurn. */
  private _onChunk?: (text: string) => void;
  private _onToolEvent?: (line: string) => void;
  /** Decoder shared across chunks for onChunk emission (UTF-8 stream). */
  private _streamDecoder = new TextDecoder("utf-8");
  /** Tracks whether any data has been received since spawn — used by
   *  `_waitForReadySettle` to flag a "TUI is alive" signal. */
  private _firstDataAt = 0;
  /** Wall-clock at construction time. Used to compute elapsed-ms on exit
   *  for the issue #176 diagnostic snapshot. */
  private readonly _spawnedAt: number;
  /** Tail ring buffer for early PTY output, capped at SETTLE_TAIL_MAX_BYTES.
   *  Captures the last N bytes so that if claude exits before the TUI
   *  settles, the operator can see whatever claude printed (auth error,
   *  updater crash, stale-JSONL refusal, …). Issue #176. */
  private _tailBuf: Uint8Array[] = [];
  private _tailBufLen = 0;
  /** Diagnostic snapshot, populated when `_handleExit` fires. */
  private _exitInfo: PtyExitInfo | null = null;
  /** Credential values in the child env, redacted from the tail snapshot. */
  private readonly _secretValues: string[];
  /** Untrusted one-shot: the prompt and the raw PTY output stay out of `CLAUDECLAW_PTY_DUMP`. */
  private readonly _untrustedTrace: boolean;
  /** Retirement stops the whole process group and waits for it (pty-group-kill). */
  private readonly _terminateGroup: boolean;
  private readonly _onGroupSurvived?: (
    pid: number,
    startMs: number | null,
    cause: SurvivorCause,
  ) => void;
  private readonly _reapEscapees?: (leader: {
    pid: number;
    startMs: number | null;
  }) => Promise<number[]>;
  private readonly _groupTermination?: GroupTerminationOptions;
  /** The leader's start time at spawn: every later signal checks that the pid still has it. */
  private readonly _leaderStartMs: number | null;
  /**
   * Untrusted one-shot: the screen is watched until the REPL is ready, and the prompt is not
   * written before that (see `_awaitReplReady`). Off when the settle wait is skipped (tests).
   */
  private _readyGate: boolean;
  /** The reconstructed current screen, collected while the ready gate is on. */
  private _screen: Screen;
  /** Why the REPL was refused, once it has been: later turns are refused without waiting. */
  private _notReady: string | null = null;
  private _onScreen: (() => void) | null = null;
  /** Ends a pending ready gate with a failure reason; set only while one is waiting. */
  private _endReplGate: ((reason: string) => void) | null = null;
  private readonly _replReadyBudgetMs: number;
  /** When `_handleExit` ran; a group of a child that exited long ago is not signalled. */
  private _exitedAt = 0;

  constructor(pty: IPty, opts: PtyProcessOptions) {
    this._pty = pty;
    this._pid = pty.pid;
    this._sessionId =
      opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : (opts.newSessionId ?? "");
    this.cwd = opts.cwd;
    this._secretValues = collectSecretValues(opts.env);
    this._untrustedTrace = opts.isolation === "untrusted";
    this._terminateGroup = opts.terminateGroup ?? opts.isolation === "untrusted";
    this._readyGate = opts.isolation === "untrusted" && !opts._skipReadySettle;
    this._replReadyBudgetMs = opts._replReadyBudgetMs ?? UNTRUSTED_REPL_READY_MS;
    this._onGroupSurvived = opts.onGroupSurvived;
    this._reapEscapees = opts.reapEscapees;
    this._groupTermination = opts._groupTermination;
    this._leaderStartMs = this._terminateGroup ? processStartMs(pty.pid) : null;
    this._screen = new Screen(opts.cols ?? DEFAULT_COLS, opts.rows ?? DEFAULT_ROWS);
    this.label = `${opts.agentName ?? "pty"}:${pty.pid}`;
    this._quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    // Untrusted text also loses its `@` file mentions (see neutralizeFileMentions). The
    // trusted path is untouched. The two seams are test-only (pty-process-test-seams).
    const prepare = promptPrepareOverride() ?? preparePtyPromptForWrite;
    this._preparePrompt =
      opts.isolation === "untrusted" && untrustedFileMentionNeutralizing()
        ? (text, writeOptions) => neutralizeFileMentions(prepare(text, writeOptions))
        : prepare;
    this._sentinelMaxWaitMs = opts.sentinelMaxWaitMs ?? DEFAULT_SENTINEL_MAX_WAIT_MS;
    this._now = opts._now ?? (() => Date.now());
    this._setTimeout = opts._setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout = opts._clearTimeout ?? ((h) => clearTimeout(h));
    this._setInterval = opts._setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this._clearInterval = opts._clearInterval ?? ((h) => clearInterval(h));
    this._sentinelUuidGen = opts._sentinelUuidOverride ?? (() => crypto.randomUUID());
    this._spawnedAt = this._now();
    this._parser = createParser({ quietWindowMs: this._quietWindowMs });

    this._onDataDisposable = pty.onData((data) => this._handleData(data));
    this._onExitDisposable = pty.onExit((info) => this._handleExit(info));
  }

  get pid(): number {
    return this._pid;
  }
  /** The leader's start time recorded at spawn, for a group that outlives it. Null: not read. */
  get leaderStartMs(): number | null {
    return this._leaderStartMs;
  }
  get sessionId(): string {
    return this._sessionId;
  }
  isAlive(): boolean {
    return this._alive;
  }
  lastTurnEndedAt(): number {
    return this._lastTurnEndedAt;
  }
  exitInfo(): PtyExitInfo | null {
    return this._exitInfo;
  }

  /**
   * Append bytes to the tail ring buffer, dropping the oldest chunks once
   * the buffer exceeds `SETTLE_TAIL_MAX_BYTES`. Cheap O(1) per chunk in the
   * common case; the loop runs at most a handful of iterations when a very
   * chatty pre-settle PTY pushes us past the cap. Issue #176.
   *
   * Edge case (confidence-82 finding from the 5-agent review): when a
   * single chunk alone exceeds the cap (bun-pty buffering, high-bandwidth
   * child), the "drop oldest" loop can't help — there's only one element
   * to drop. Slice it down to keep just the trailing bytes so the buffer
   * stays bounded.
   */
  private _appendToTail(bytes: Uint8Array): void {
    this._tailBuf.push(bytes);
    this._tailBufLen += bytes.length;
    while (this._tailBufLen > SETTLE_TAIL_MAX_BYTES) {
      if (this._tailBuf.length === 1) {
        // Single oversized chunk: COPY the trailing SETTLE_TAIL_MAX_BYTES
        // into a new buffer. We must use `.slice()` (which copies) rather
        // than `.subarray()` (which would return a view that pins the
        // entire oversized ArrayBuffer alive — Codex P2 on PR #185).
        // Preserves the most-recent bytes, which are the most
        // diagnostically useful (closest to the crash).
        const chunk = this._tailBuf[0];
        const keep = chunk.slice(chunk.length - SETTLE_TAIL_MAX_BYTES);
        this._tailBuf[0] = keep;
        this._tailBufLen = keep.length;
        break;
      }
      const dropped = this._tailBuf.shift();
      if (dropped) this._tailBufLen -= dropped.length;
    }
  }

  /**
   * Snapshot the tail ring buffer as a UTF-8 string with ANSI escapes
   * stripped and stray NUL/control bytes replaced. The result is meant for
   * operator-facing diagnostics — not a precise record of every byte.
   */
  private _readTailSnapshot(): string {
    if (this._tailBuf.length === 0) return "";
    const combined = new Uint8Array(this._tailBufLen);
    let offset = 0;
    for (const chunk of this._tailBuf) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(combined);
    // Strip ANSI, squash remaining control chars (NUL, BS, DEL …) so the
    // operator sees printable text, then redact common credential patterns
    // before the snapshot can be logged. Newlines are preserved.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes by design
    const stripped = stripAnsiInline(decoded).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
    return redactSecretsInTail(stripped, this._secretValues);
  }

  // ─── data flow ────────────────────────────────────────────────────────

  /**
   * A trace line that can carry prompt or reply text. An untrusted one-shot's PTY writes
   * metadata only (tag and length): the screen echoes the prompt, and the trace file lives
   * outside the throwaway config root that is removed after the call (A in r11).
   */
  private _trace(tag: string, payload: string): void {
    dumpPtyTrace(
      tag,
      this._untrustedTrace ? `[withheld: untrusted, ${payload.length} chars]` : payload,
    );
  }

  private _handleData(data: string): void {
    // bun-pty delivers strings; re-encode for the byte-level parser.
    const bytes = new TextEncoder().encode(data);
    const now = this._now();
    this._trace(
      `<< pid=${this._pid} state=${this._parser.state} turn=${this._turnInProgress} n=${bytes.length}`,
      data,
    );
    if (this._firstDataAt === 0) this._firstDataAt = now;
    if (this._readyGate) {
      this._screen.feed(data);
      this._onScreen?.();
    }

    // Buffer for the current turn (so idle-fallback can return content).
    this._turnBuf.push(bytes);
    this._turnBufLen += bytes.length;

    // Issue #176: maintain a separate rolling tail of recent bytes so we
    // can diagnose "PTY exited before TUI settled" failures. _turnBuf gets
    // reset between turns; the tail buffer persists across the spawn → exit
    // window, which is exactly when we need it.
    this._appendToTail(bytes);

    const events = feed(this._parser, bytes, now);

    // onChunk streaming — opportunistic delta delivery.
    if (this._turnInProgress && this._onChunk) {
      const decoded = this._streamDecoder.decode(bytes, { stream: true });
      const stripped = stripAnsiInline(decoded);
      if (stripped.length > 0) {
        try {
          this._onChunk(stripped);
        } catch {
          // Caller bug; never let it kill the PTY pipeline.
        }
      }
    }

    // onToolEvent — best-effort detection of `⏺ <ToolName>(<args>)` and
    // `  ⎿ <result>` lines.
    if (this._turnInProgress && this._onToolEvent) {
      const text = new TextDecoder().decode(bytes);
      const stripped = stripAnsiInline(text).replace(/\r\n/g, "\n").replace(/\r/g, "");
      for (const line of stripped.split("\n")) {
        if (line.startsWith("⏺ ") || line.trim().startsWith("⎿ ")) {
          try {
            this._onToolEvent(line);
          } catch {
            /* swallow */
          }
        }
      }
    }

    // Did this chunk reveal the sentinel echo?
    for (const ev of events) {
      if (ev.type === "sentinel-found" && this._turnInProgress) {
        this._completeTurn(true, ev.offset);
        return;
      }
    }
  }

  private _handleExit(info: { exitCode: number; signal?: number | string }): void {
    this._alive = false;
    this._exitedAt = this._now();
    // Issue #176: capture a diagnostic snapshot the moment the PTY exits.
    // Reading the tail ring buffer now is cheap and avoids the
    // _onDataDisposable race (data events still flush before exit on
    // bun-pty). The snapshot is exposed via `exitInfo()` so the supervisor
    // can include the WHY in its "exited before TUI settled" error message.
    this._exitInfo = {
      exitCode: info.exitCode ?? null,
      signal: info.signal != null ? String(info.signal) : null,
      elapsedMs: Math.max(0, this._now() - this._spawnedAt),
      tail: this._readTailSnapshot(),
    };
    // NOTE: Do NOT dispose listeners here. bun-pty's EventEmitter iterates
    // its listener array by index inside `fire()`, and disposing a listener
    // from within its own callback mutates the array under the iterator,
    // which causes subsequent listeners to be skipped.

    // A child that exited while the ready gate waited will never show a footer. A boot screen it
    // died on (a login menu) is still the better reason.
    this._endReplGate?.(this._blockedBootReason() ?? "exited");

    if (this._turnInProgress) {
      const err = new PtyClosedError(
        this.label,
        info.exitCode ?? null,
        info.signal != null ? String(info.signal) : null,
      );
      this._rejectTurn(err);
    }
  }

  // ─── runTurn ─────────────────────────────────────────────────────────

  runTurn(
    prompt: string,
    opts: {
      timeoutMs: number;
      onChunk?: (text: string) => void;
      onToolEvent?: (line: string) => void;
      /** Deliberate REPL command (`/compact`); honoured only for an exact allowed command. */
      allowReplCommand?: boolean;
    },
  ): Promise<PtyTurnResult> {
    // An untrusted one-shot's first turn waits for a ready REPL; nothing is written until then.
    if (this._notReady !== null) {
      return Promise.reject(new PtyNotReadyError(this.label, this._notReady));
    }
    if (this._readyGate) {
      return this._awaitReplReady(Math.min(this._replReadyBudgetMs, opts.timeoutMs)).then(
        (verdict) => {
          if (!verdict.ok) {
            this._notReady = verdict.reason ?? "unknown";
            throw new PtyNotReadyError(this.label, this._notReady);
          }
          return this._startTurn(prompt, opts);
        },
      );
    }
    return this._startTurn(prompt, opts);
  }

  private _startTurn(
    prompt: string,
    opts: {
      timeoutMs: number;
      onChunk?: (text: string) => void;
      onToolEvent?: (line: string) => void;
      allowReplCommand?: boolean;
    },
  ): Promise<PtyTurnResult> {
    if (this._disposed) {
      return Promise.reject(new PtyClosedError(this.label, null, null));
    }
    if (!this._alive) {
      return Promise.reject(new PtyClosedError(this.label, null, null));
    }
    if (this._turnInProgress) {
      return Promise.reject(
        new Error(`runTurn called concurrently on ${this.label}; supervisor must serialise`),
      );
    }

    this._turnInProgress = true;
    this._onChunk = opts.onChunk;
    this._onToolEvent = opts.onToolEvent;
    this._turnBuf = [];
    this._turnBufLen = 0;
    this._streamDecoder = new TextDecoder("utf-8");
    this._turnStartedAt = this._now();

    // Build the sentinel for this turn.
    const uuid = this._sentinelUuidGen();
    const sentinelString = buildSentinel(uuid);
    const sentinelBytes = encodeSentinel(sentinelString);
    this._activeSentinelString = sentinelString;
    this._activeSentinelBytes = sentinelBytes;

    // Tell the parser we're starting a turn (offset = current totalBytes).
    startTurn(this._parser, uuid, sentinelBytes, this._turnStartedAt);

    // Write prompt + CR (TUI submits on Enter). Sanitize embedded CR/LF so
    // they don't submit mid-prompt.
    //
    // Issue #559: the prompt goes in as a bracketed paste. claude's TUI reads
    // a burst of input as a paste when it is long enough (64+ bytes with CLI
    // 2.1.296), and a CR inside that paste is kept as text, not Enter: the
    // prompt sits in the input box and the turn times out. The clock prefix
    // `runUserMessage` adds pushes nearly every chat prompt past that size.
    // With explicit paste markers the TUI knows where the text ends, so the
    // CR after them is a keypress whatever the length. The sanitizer strips
    // ESC, so the prompt cannot close the paste early.
    try {
      this._trace(`>> pid=${this._pid} write prompt`, `${JSON.stringify(prompt).slice(0, 80)}+CR`);
      this._pty.write(
        `${PASTE_START}${this._preparePrompt(prompt, { allowReplCommand: opts.allowReplCommand })}${PASTE_END}\r`,
      );
    } catch (err) {
      this._turnInProgress = false;
      this._activeSentinelBytes = null;
      this._activeSentinelString = "";
      resetTurn(this._parser);
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    return new Promise<PtyTurnResult>((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;

      if (opts.timeoutMs > 0) {
        this._turnHardTimeoutHandle = this._setTimeout(() => {
          const elapsed = this._now() - this._turnStartedAt;
          this._rejectTurn(new PtyTurnTimeoutError(this.label, elapsed));
        }, opts.timeoutMs);
      }

      // Tick the quiet timer until the parser fires `quiet`, then write the
      // sentinel; once written, the timer continues to enforce the sentinel
      // max-wait deadline.
      this._quietTickHandle = this._setInterval(() => {
        if (!this._turnInProgress) return;
        const now = this._now();
        const evs = tick(this._parser, now);
        for (const ev of evs) {
          if (ev.type === "quiet") {
            this._writeSentinel();
          }
        }
      }, DEFAULT_QUIET_TICK_MS);
    });
  }

  /**
   * Write the per-turn sentinel into claude's input buffer (no `\r`, so it
   * stays in the prompt area). Schedule the max-wait deadline. Tell the
   * parser to start scanning for the echo.
   */
  private _writeSentinel(): void {
    if (!this._turnInProgress || !this._activeSentinelBytes) return;
    if (this._parser.state !== "accumulating") return;
    try {
      dumpPtyTrace(`>> pid=${this._pid} write sentinel`, "");
      this._pty.write(this._activeSentinelString);
    } catch (err) {
      this._rejectTurn(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    markSentinelWritten(this._parser);

    // Arm the sentinel max-wait deadline. If the echo never lands, fall
    // back to a non-clean completion using whatever bytes we have.
    if (this._sentinelDeadlineHandle != null) {
      this._clearTimeout(this._sentinelDeadlineHandle);
    }
    this._sentinelDeadlineHandle = this._setTimeout(() => {
      if (this._turnInProgress) {
        // Sentinel never came back — emit whatever we've got.
        // Codex PR #82 P1: `_completeTurn` treats `responseEndOffset` as an
        // ABSOLUTE stream offset (matching the units used by
        // sentinel-found events on the parser). Passing `_turnBufLen` here
        // (which is the LENGTH of the accumulated turn buffer, not an
        // absolute offset) made the slice arithmetic clamp `sliceEnd` to
        // `sliceStart` whenever any pre-turn bytes existed in
        // `parser.totalBytes` (e.g. claude's startup banner), producing
        // an empty fallback response. The current end of the stream IS
        // `this._parser.totalBytes` — that's the absolute offset we want.
        this._completeTurn(false, this._parser.totalBytes);
      }
    }, this._sentinelMaxWaitMs);
  }

  /**
   * Send cleanup bytes to clear the sentinel from claude's input buffer
   * before the next turn. We use Ctrl-U (0x15, `kill-line`) which claude's
   * raw-mode input editor honours by wiping the pending input back to the
   * start of the line — verified against claude 2.1.89 on Hetzner. Backspace
   * × N also clears the cursor visually but leaves stale bytes in claude's
   * TUI input state; Ctrl-U produces a cleaner state for the next turn.
   *
   * No trailing `\r` — the supervisor's next `runTurn` submits via its own
   * prompt write.
   */
  private _writeSentinelCleanup(): void {
    if (!this._activeSentinelBytes) return;
    try {
      this._pty.write("\x15");
    } catch {
      // PTY may have died; ignore — next turn will fail loudly.
    }
  }

  private _completeTurn(cleanBoundary: boolean, responseEndOffset: number): void {
    if (!this._turnInProgress) return;

    // Slice out the response: everything from turn start (just after our
    // prompt write — which we never see because prompts go OUT, not back IN)
    // up to the sentinel echo. We don't see our own prompt-write echo from
    // claude either; claude submits on Enter and doesn't re-echo the line.
    const turnStart = this._parser.turnStartOffset;
    const allBytes = concatBytes(this._turnBuf, this._turnBufLen);
    // turnStart is an offset into the stream; the buffer starts at the same
    // origin (we cleared it at runTurn entry), so we slice directly.
    const sliceStart = Math.max(0, turnStart - (this._parser.totalBytes - allBytes.length));
    const sliceEnd = Math.max(
      sliceStart,
      Math.min(allBytes.length, responseEndOffset - (this._parser.totalBytes - allBytes.length)),
    );
    const responseBytes = allBytes.slice(sliceStart, sliceEnd);

    let { text } = decodeTurn(responseBytes);
    // Belt-and-braces: strip any leaked sentinel string from the extracted
    // text (the response slice cuts BEFORE the sentinel, but if claude
    // chunks bytes mid-sentinel and the carry-over math is off by a UTF-8
    // boundary we'd rather show "" than the raw marker).
    if (this._activeSentinelString && text.includes(this._activeSentinelString)) {
      text = text.replace(this._activeSentinelString, "").trim();
    }

    this._turnInProgress = false;
    this._lastTurnEndedAt = this._now();
    this._onChunk = undefined;
    this._onToolEvent = undefined;

    if (this._turnHardTimeoutHandle != null) {
      this._clearTimeout(this._turnHardTimeoutHandle);
      this._turnHardTimeoutHandle = null;
    }
    if (this._quietTickHandle != null) {
      this._clearInterval(this._quietTickHandle);
      this._quietTickHandle = null;
    }
    if (this._sentinelDeadlineHandle != null) {
      this._clearTimeout(this._sentinelDeadlineHandle);
      this._sentinelDeadlineHandle = null;
    }

    // Send cleanup bytes to clear claude's prompt buffer.
    this._writeSentinelCleanup();

    // Reset parser for the next turn (preserves totalBytes counter).
    resetTurn(this._parser);
    this._activeSentinelBytes = null;
    this._activeSentinelString = "";

    const result: PtyTurnResult = {
      text,
      bytesCaptured: responseBytes.length,
      cleanBoundary,
      sessionId: this._sessionId,
    };
    const resolve = this._turnResolve;
    this._turnResolve = null;
    this._turnReject = null;
    if (resolve) resolve(result);
  }

  private _rejectTurn(err: Error): void {
    if (!this._turnInProgress) return;
    this._turnInProgress = false;
    this._onChunk = undefined;
    this._onToolEvent = undefined;
    if (this._turnHardTimeoutHandle != null) {
      this._clearTimeout(this._turnHardTimeoutHandle);
      this._turnHardTimeoutHandle = null;
    }
    if (this._quietTickHandle != null) {
      this._clearInterval(this._quietTickHandle);
      this._quietTickHandle = null;
    }
    if (this._sentinelDeadlineHandle != null) {
      this._clearTimeout(this._sentinelDeadlineHandle);
      this._sentinelDeadlineHandle = null;
    }
    resetTurn(this._parser);
    this._activeSentinelBytes = null;
    this._activeSentinelString = "";
    const reject = this._turnReject;
    this._turnResolve = null;
    this._turnReject = null;
    if (reject) reject(err);
  }

  // ─── dispose ────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    if (this._turnInProgress) {
      this._rejectTurn(new PtyClosedError(this.label, null, "SIGTERM"));
    }
    // The ready gate is not a turn: ending it here lets the caller waiting on it go at once.
    this._endReplGate?.("closed");

    // bun-pty's kill() fires onExit synchronously, so the exit event below proves nothing
    // about the child. The group is signalled first, while the leader is still ours, and its
    // disappearance is awaited separately (#570 r12). A child that exited on its own is only
    // swept shortly after: a pid that old may belong to someone else by now.
    const sweepGroup =
      this._terminateGroup &&
      (this._alive || this._now() - this._exitedAt <= GROUP_SWEEP_MAX_AGE_MS);
    const groupGone = sweepGroup
      ? terminateProcessGroup(this._pid, {
          leaderStartMs: this._leaderStartMs,
          leaderAlive: () => this._alive,
          firstTermination: true,
          ...this._groupTermination,
        })
      : Promise.resolve(true);

    if (this._alive) {
      const exited = new Promise<void>((resolve) => {
        if (!this._alive) {
          resolve();
          return;
        }
        const sub = this._pty.onExit(() => resolve());
        if (!this._alive) {
          resolve();
          try {
            sub.dispose();
          } catch {}
        }
      });

      try {
        this._pty.kill("SIGTERM");
      } catch {
        // Already dead.
      }

      const killTimer = this._setTimeout(() => {
        try {
          this._pty.kill("SIGKILL");
        } catch {}
      }, 2000);

      await exited;
      this._clearTimeout(killTimer);
    }

    let survived = !(await groupGone);
    let cause: SurvivorCause = "group";
    let escapees: number[] = [];
    // The window above guards only the signal to the bare pid. A descendant that left the group is
    // found by what it inherited, not by the leader's pid, so it is looked for however old the
    // child is (#570 r14, A).
    if (this._terminateGroup && this._reapEscapees) {
      try {
        escapees = await this._reapEscapees({ pid: this._pid, startMs: this._leaderStartMs });
      } catch (error) {
        // Could not tell whether a descendant that left the group is still running: not a success.
        console.error(
          `[pty-process] ${this.label} escapee scan failed (${(error as NodeJS.ErrnoException)?.code ?? "error"})`,
        );
        if (!survived) cause = "scan-unknown";
        survived = true;
      }
    }
    if (!survived && escapees.length > 0) cause = "escapee";
    let hookError: unknown;
    if (survived || escapees.length > 0) {
      console.error(
        `[pty-process] ${this.label} retired but ${survived ? "its process group is still alive" : `${escapees.length} process(es) outside its group are still alive`} (pid=${this._pid})`,
      );
      try {
        this._onGroupSurvived?.(this._pid, this._leaderStartMs, cause);
      } catch (error) {
        // Fail closed: if the caller could not record the survivor it cannot protect what the
        // survivor may write into, so the disposal does not report success.
        console.error(
          `[pty-process] ${this.label} survivor hook threw (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "error"})`,
        );
        hookError = error;
      }
    }

    try {
      this._onDataDisposable?.dispose();
    } catch {}
    try {
      this._onExitDisposable?.dispose();
    } catch {}
    this._onDataDisposable = null;
    this._onExitDisposable = null;
    if (hookError !== undefined) {
      throw new Error(`survivor hook failed for ${this.label}`, { cause: hookError });
    }
  }

  /** The code of the blocked boot screen (login, onboarding, trust) on the screen now, if any. */
  private _blockedBootReason(): string | undefined {
    const screen = stripAnsi(this._screen.text());
    return BLOCKED_BOOT_SCREENS.find(([, pattern]) => pattern.test(screen))?.[0];
  }

  /**
   * Untrusted one-shot: resolve `ok` once claude's REPL footer is on screen with no login,
   * onboarding or trust screen, and `!ok` with a reason code otherwise (a blocked screen, or no
   * footer within the budget). Fails closed: the caller does not write the prompt unless this is
   * `ok`. Only the reason code is reported, never screen text. Two more verdicts end the wait
   * without a footer: `closed` (the child was retired, now or while waiting) and `exited` (it
   * died, now or while waiting, with no blocked screen to name). Spawn-time only; once decided,
   * the screen is no longer collected.
   */
  _awaitReplReady(budgetMs: number): Promise<ReplReadyVerdict> {
    // A child that is already retired or gone will never show a footer: no wait, no timers.
    if (this._disposed) return Promise.resolve({ ok: false, reason: "closed" });
    if (!this._alive)
      return Promise.resolve({ ok: false, reason: this._blockedBootReason() ?? "exited" });
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const finish = (verdict: ReplReadyVerdict): void => {
        this._clearTimeout(deadline);
        if (quiet !== null) this._clearTimeout(quiet);
        this._onScreen = null;
        this._endReplGate = null;
        this._readyGate = false;
        this._screen = new Screen(1, 1); // nothing more is collected
        resolve(verdict);
      };
      // Retirement and exit end the wait at once (#570 r15, A2): without this the gate ran to its
      // own deadline after the child was gone, and a retired attempt kept its caller waiting.
      this._endReplGate = (reason) => finish({ ok: false, reason });
      const blockedReason = (): string | undefined => this._blockedBootReason();
      // Judged on the screen as it is now, not on what was ever written: a login menu that was
      // cleared and replaced by the REPL is gone, and a status painted after the footer is there.
      // Once the footer (or a blocked screen) shows, one quiet window must pass without the
      // screen changing, and the blocked screens are looked for again on what is left.
      const hasFooter = (): boolean => REPL_FOOTER.test(stripAnsi(this._screen.text()));
      const onQuiet = (): void => {
        quiet = null;
        const reason = blockedReason();
        if (reason !== undefined) finish({ ok: false, reason });
        else if (hasFooter()) finish({ ok: true });
      };
      // The quiet window restarts only when the reconstructed screen text changed: a REPL that
      // keeps moving its cursor or repainting identical text is not a screen that is still
      // changing (#570 r14, D). The blocked screens are looked for on every chunk.
      let lastText: string | null = null;
      const check = (): void => {
        const text = this._screen.text();
        const changed = text !== lastText;
        lastText = text;
        if (!hasFooter() && blockedReason() === undefined) {
          if (quiet !== null) this._clearTimeout(quiet);
          quiet = null;
          return;
        }
        if (quiet !== null && !changed) return; // the window already running keeps running
        if (quiet !== null) this._clearTimeout(quiet);
        quiet = this._setTimeout(onQuiet, this._quietWindowMs);
      };
      const deadline = this._setTimeout(() => {
        // A screen that never went quiet is judged a last time, as it stands.
        const reason = blockedReason();
        finish({
          ok: false,
          reason: reason ?? (hasFooter() ? "screen-not-settled" : "no-repl-footer"),
        });
      }, budgetMs);
      this._onScreen = check;
      check();
    });
  }

  // ─── internal: used only by spawnPty to await TUI settle ─────────────

  /**
   * Resolve once the TUI has both painted (first data chunk arrived) AND
   * gone quiet for `quietWindowMs` (no new data for that long, meaning the
   * paint is done and the TUI is awaiting input). Falls back to resolve on
   * `timeoutMs` regardless, so a stalled/silent claude doesn't deadlock
   * spawn.
   *
   * Issue #84: pre-fix, this resolved on the FIRST BYTE — but claude
   * 2.1.89's TUI takes ~1–2 seconds to fully paint after the first byte.
   * `spawnPty` would return early, the supervisor's first `runTurn` wrote
   * the user prompt into a half-painted TUI, and claude either ate those
   * bytes or interpreted them as navigation keys. The sentinel-echo path
   * then captured only the splash banner and returned it as the "model
   * response" (visible to Discord/Telegram users).
   *
   * Two-phase model:
   *   1. Wait for first data byte (TUI started painting).
   *   2. Wait for `quietWindowMs` of NO new data (TUI finished painting
   *      and is silent at the input prompt).
   * On every incoming chunk after phase 1, reset the quiet timer.
   *
   * Issue #460: on a fresh HOME, `--dangerously-skip-permissions` opens the
   * "Bypass Permissions mode" warning before the REPL, with "No, exit"
   * PRESELECTED. It goes quiet like a painted REPL, so pre-fix this resolved,
   * the first runTurn's CR confirmed "No, exit", and claude exited 1. Answer
   * it here the way the bus does (#193): Down, then Enter, once — never a
   * blind Enter. After answering, settle waits for the REPL footer ("tab to
   * cycle") instead of the first quiet gap, with a fresh hard-timeout window
   * — so a spawn that hits the dialog can take up to 2 × `timeoutMs`. Only a
   * dialog painted inside the settle window is answered.
   *
   * Issue #469: a cwd whose project has an unapproved `.mcp.json` opens "New
   * MCP server found in this project" before that warning. Pre-fix, settle
   * resolved on it and the first prompt's CR dismissed it, so the prompt was
   * lost to the bypass dialog behind it and the turn timed out. Reject it with
   * Esc, once: "continue without" in the single-server dialog and "reject all"
   * in the multi-select, whose servers are all pre-checked (an Enter there
   * would enable every one), 500 ms after it shows. Then wait for the REPL
   * as above, in a fresh hard-timeout window opened when the dialog showed.
   */
  _waitForReadySettle(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const originalHandler = this._handleData.bind(this);
      let bootRaw = "";
      let answeredBypass = false;
      let mcpTimer: ReturnType<typeof setTimeout> | null = null;
      let awaitingRepl = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        if (quietTimer) this._clearTimeout(quietTimer);
        this._clearTimeout(hardTimer);
        // Restore the original handler so subsequent runTurn calls don't
        // pay the patched-handler overhead and don't leak the closure.
        this._handleData = originalHandler;
        resolve();
      };

      const onQuiet = () => {
        // Dialog answered but the REPL has not painted yet: a quiet gap here
        // is the TUI switching screens, not a settled REPL. The hard timer
        // still bounds the wait; an exit (no more data) falls through to it.
        if (awaitingRepl && this._alive) {
          scheduleQuiet();
          return;
        }
        done();
      };

      const scheduleQuiet = () => {
        if (quietTimer) this._clearTimeout(quietTimer);
        quietTimer = this._setTimeout(onQuiet, this._quietWindowMs);
      };

      // Hard timeout: if the TUI never paints AT ALL within timeoutMs,
      // resolve anyway and let the caller proceed. This also guards
      // against a TUI that paints forever without ever going quiet.
      let hardTimer = this._setTimeout(done, timeoutMs);

      const sendKey = (key: string) => {
        try {
          this._pty.write(key);
        } catch {
          /* pty may have exited — the settle check after resolve reports it */
        }
      };

      const rejectMcp = () => {
        dumpPtyTrace(`>> pid=${this._pid} reject project MCP server dialog`, "Esc");
        sendKey("\x1b");
      };

      // Patch _handleData to reset the quiet timer on every incoming
      // chunk. The quiet timer only starts firing after the first chunk
      // (paint started) and only resolves once a full quietWindowMs has
      // elapsed with no further chunks (paint finished).
      this._handleData = (data: string) => {
        originalHandler(data);
        // Strip the accumulated raw text, not each chunk: an escape sequence
        // can straddle chunks. stripAnsi expands the cursor moves claude
        // uses as word gaps (CHA, CUF) so "Yes, I accept" stays matchable.
        bootRaw = (bootRaw + data).slice(-4000);
        const bootText = stripAnsi(bootRaw);
        // REPL footer first, so a key is never injected into a live REPL.
        if (/tab\s*to\s*cycle/.test(bootText)) {
          awaitingRepl = false;
          // The REPL is up: an Esc still pending would land in it. The timer
          // stays set so the dialog is never answered after this.
          if (mcpTimer) this._clearTimeout(mcpTimer);
        } else if (!mcpTimer && /MCP\s*servers?\s*found\s*in\s*this\s*project/.test(bootText)) {
          // Not straight away: claude 2.1.300 swallows an Esc sent while the
          // dialog paints (lost at 100 ms, taken from 200 ms).
          awaitingRepl = true;
          mcpTimer = this._setTimeout(rejectMcp, MCP_DIALOG_ANSWER_DELAY_MS);
          this._clearTimeout(hardTimer);
          hardTimer = this._setTimeout(done, timeoutMs);
        } else if (!answeredBypass && /Yes,\s*I\s*accept/.test(bootText)) {
          answeredBypass = true;
          awaitingRepl = true;
          dumpPtyTrace(`>> pid=${this._pid} answer bypass-permissions dialog`, "Down+CR");
          sendKey("\x1b[B");
          this._setTimeout(() => sendKey("\r"), 200);
          this._clearTimeout(hardTimer);
          hardTimer = this._setTimeout(done, timeoutMs);
        }
        scheduleQuiet();
      };

      // If data already arrived before this was called, kick off the
      // quiet timer immediately — we may never see another byte and don't
      // want to wait the full hard timeout.
      if (this._firstDataAt > 0) {
        scheduleQuiet();
      }
    });
  }
}

/** Inline ANSI strip used by onChunk / onToolEvent. */
function stripAnsiInline(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences require control bytes.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape stripper.
      .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: catch-all ESC byte stripper.
      .replace(/\x1b/g, "")
  );
}

/** Concatenate accumulated chunks into a single Uint8Array. */
function concatBytes(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Spawn one Claude interactive PTY and wait for the TUI to settle. "Settled"
 * is approximated as "the first byte of output has arrived OR 3 seconds
 * elapsed", since claude 2.1.89 no longer emits OSC progress markers (issue
 * #81). On success, returns a ready-to-use PtyProcess.
 */
export function spawnPty(opts: PtyProcessOptions): Promise<PtyProcess> {
  return new Promise<PtyProcess>((resolve, reject) => {
    const cmd = opts._commandOverride ?? "claude";
    const args = buildClaudeArgs(opts);
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;

    let pty: IPty;
    try {
      // bun-pty's Rust wrapper does NOT call CommandBuilder::env_clear()
      // before adding env vars — portable_pty MERGES the caller-supplied
      // env with the parent process env at fork() time. So passing a
      // sanitised `opts.env` is not enough: the child claude still inherits
      // ANTHROPIC_API_KEY (and the other Claude-Code internals) from this
      // daemon's process.env, hits claude 2.1.89's "Detected a custom API
      // key" interactive gate, and leaks the prompt + a truncated key into
      // the PTY (visible on Discord/Telegram). withCleanProcessEnv strips
      // those keys from process.env around the synchronous FFI call. An untrusted
      // spawn passes `opts.env` as the exact policy instead: every other key of the
      // parent environment is removed for the call (and `opts.env` has already had
      // the strip list applied, see the supervisor's untrustedChildEnv).
      pty = withCleanProcessEnv(
        () =>
          ptySpawn(cmd, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: opts.cwd,
            env: opts.env,
          }),
        opts.isolation === "untrusted" ? opts.env : undefined,
      );
    } catch (err) {
      reject(
        new Error(
          `Failed to spawn PTY for ${cmd}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const proc = new PtyProcessImpl(pty, opts);

    if (opts._skipReadySettle) {
      resolve(proc);
      return;
    }

    proc._waitForReadySettle(3000).then(() => {
      if (!proc.isAlive()) {
        // Issue #176: include the captured exit info in the error message so
        // the supervisor's "respawn failed" path (and any operator tailing
        // stderr) sees *why* claude exited within the 3-second settle
        // window. Without this the message is just "exited before TUI
        // settled" — we can't tell an auth failure from an updater crash
        // from a stale-JSONL refusal.
        const info = proc.exitInfo();
        let detail = "";
        if (info) {
          const fragments: string[] = [];
          if (info.exitCode !== null) fragments.push(`exitCode=${info.exitCode}`);
          if (info.signal !== null) fragments.push(`signal=${info.signal}`);
          fragments.push(`elapsed=${info.elapsedMs}ms`);
          if (info.tail.length > 0) {
            // Trim leading/trailing whitespace and collapse runs of newlines
            // so a long banner doesn't dominate the log line. The tail is
            // already capped at 8 KiB by `_appendToTail`.
            const trimmed = info.tail.trim().replace(/\n{3,}/g, "\n\n");
            fragments.push(`tail=${JSON.stringify(trimmed)}`);
          }
          detail = ` (${fragments.join(", ")})`;
        }
        reject(new Error(`PTY for ${cmd} exited before TUI settled (pid=${pty.pid})${detail}`));
        return;
      }
      resolve(proc);
    });
  });
}
