/**
 * Single-PTY wrapper around one `claude` interactive process.
 *
 * Knows nothing about supervisors, sessions, or adapters. Stateless beyond
 * the PTY handle it owns. Implements the contract from SPEC §3.1 verbatim.
 *
 * ─── Turn evidence: the session transcript, never the screen (#562 round 2) ────
 *
 * Whether a prompt was accepted, what the answer is and when the turn is over are read
 * from the session transcript the CLI itself writes (`pty-transcript.ts`), not from the
 * TUI's rendering. Repaints of the old conversation, chunk splits, a prompt echoed into
 * the input box and changes to the CLI's chrome all produced false successes (#559, the
 * #562 soak). The screen is used only for readiness (boot settle, dialogs), liveness
 * (exit, tail diagnostics) and timing (wait for a repaint to quiet before the next
 * prompt), and only ever to delay, fail or abort a turn, never to complete one.
 *
 *   1. Mark the transcript (size and file identity), write the prompt as a bracketed paste
 *      + `\r`.
 *   2. Accepted = a `user` (or `enqueue`) entry whose payload IS this prompt, appended after
 *      the mark. Not seen within `submitConfirmMs`: one bare CR; again: Ctrl-U and
 *      `PtyPromptNotAcceptedError`.
 *   3. Answer = the text of the turn's FINAL assistant message in the transcript (the print
 *      path's `result`), never between-tool narration and never a later turn.
 *   4. Done = the turn's final assistant message carries a terminal stop reason AND the
 *      transcript shows an authoritative boundary after it: the CLI's `turn_duration` or the
 *      next real user prompt (`/compact`: `compact_boundary`). No quiet-file timer. Failed =
 *      the CLI's own API error (anywhere before the boundary), a command's stderr, an
 *      uncertain attribution, or a reply with no text (`PtyTurnFailedError`); a transcript
 *      that was replaced fails with `TranscriptReplacedError`. A final message with no
 *      boundary by the timeout is `PtyTranscriptUncertainError`: not a success, not replayed.
 *   5. The moment the transcript establishes the outcome it is COMMITTED (`_commitTurn`): the
 *      hard timeout is cancelled and a PTY exit no longer rejects. The screen settle that
 *      follows only delays the return.
 *   6. No transcript to read (untrusted one-shot, no session id, switched off) = the
 *      turn fails before anything is written: `PtyTranscriptUnavailableError`.
 *
 * ─── OR-6 decision (session-ID) ──────────────────────────────────────────────
 *   Pre-allocate via `--session-id <uuid>` for fresh spawns when
 *   `opts.newSessionId` is provided. The TUI does NOT print a session UUID at
 *   startup. When neither `sessionId` nor `newSessionId` is provided, we spawn
 *   without any session flag and Claude allocates internally. An untrusted
 *   one-shot (`isolation: "untrusted"`) takes neither flag even when an id is
 *   set: `buildClaudeArgs` returns early with `--no-session-persistence`.
 */
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { SecurityConfig } from "../config";
import { UNTRUSTED_CLAUDE_ARGS } from "../oneshot/isolation.js";
import { cliModelFlag } from "../oneshot/model.js";
import { claudeExecutable, withCleanProcessEnv } from "../runner";
// Screen text is used for readiness and dialogs only (`_waitForReadySettle`): the
// parser's completion/answer API is deliberately NOT imported here (#562 round 2; the
// guard test `pty-turn-evidence-guard.test.ts` fails the build if it comes back).
import { stripAnsi } from "./pty-output-parser";
import { assertSessionSpawnable } from "./pty-quarantine";
// Re-export the sanitiser from its standalone home so existing callers that
// pull it from `pty-process` (and through `runner/index`) keep working without
// loading bun-pty just to get the helper.
import { preparePtyPromptForWrite, sanitizePtyPromptText } from "./pty-prompt-sanitizer";
import {
  resolveTranscriptPath,
  TranscriptReplacedError,
  TranscriptTurn,
  type TurnFailureKind,
} from "./pty-transcript";

export { TranscriptReplacedError };
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/**
 * A process's birth identity: something a reused pid cannot share with the process that held
 * it before. Linux: field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot, read
 * with a plain file read). macOS/BSD: `ps -o lstart=` (the start time to the second; one
 * `ps` spawn, about 10-20 ms, paid once at spawn and once per signal, never per poll).
 * Reuse inside the same second would need the pid counter to wrap in that second. `null`:
 * the pid is gone or the identity cannot be read (Windows, no `ps`).
 */
export function readPidIdentity(pid: number): string | null {
  try {
    if (process.platform === "win32") return null;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `comm` (field 2) may hold spaces and parens: split after the LAST ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] || null; // field 22 = index 19 once fields 1-2 are cut
    }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2000,
    });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

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
  /** Quiet window (ms) the screen must show after the transcript says the reply is
   *  complete, before the next prompt may be sent (readiness; it only delays).
   *  Default: 500. */
  quietWindowMs?: number;
  /** How long (ms) to wait for evidence the prompt was ACCEPTED (the turn-start
   *  edge, #562) before re-sending the submit key once, and again before failing
   *  the turn with `PtyPromptNotAcceptedError`. Default: 3000. */
  submitConfirmMs?: number;
  /**
   * Where the CLI writes this session's transcript. Derived from the session id, cwd
   * and config dir when omitted; an untrusted one-shot (`--no-session-persistence`) and
   * a process spawned through a test hook have none. With a transcript, acceptance, the
   * answer and the end of the turn come from it, not from the screen (#562 round 2).
   */
  transcriptPath?: string;
  /** Longest (ms) a finished reply waits for the screen to go quiet. Past it the turn
   *  resolves anyway: the wait is readiness, never evidence. Default: 2000. */
  settleCapMs?: number;
  /** @deprecated No sentinel any more (#562 round 2); accepted so callers compile. */
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
   * INTERNAL TEST HOOK: send a signal to a pid (`0` probes). Default `process.kill`. Retirement
   * proves death with it, so a stand-in process with a made-up pid needs a stand-in here.
   */
  _signalPid?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /**
   * INTERNAL TEST HOOK: read a pid's birth identity (`readPidIdentity`). A test that stands in
   * for the pid with `_signalPid` gets "no identity" unless it names a reader too.
   */
  _readPidIdentity?: (pid: number) => string | null;
  /**
   * INTERNAL TEST HOOK: replace bun-pty's `spawn`. A test that needs a stand-in child uses this
   * instead of `mock.module("bun-pty")`, which is process-wide in bun and is not undone by
   * `mock.restore`: it leaks into every later file of a single-process `bun test src` (CI).
   */
  _ptySpawn?: typeof ptySpawn;
  /** INTERNAL TEST HOOK: wait for a graceful exit before SIGKILL (default 2000ms). */
  _exitGraceMs?: number;
  /** INTERNAL TEST HOOK: total wait for the OS to confirm the exit (default 7000ms). */
  _exitCapMs?: number;
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
  /**
   * Retire the process. Resolves only once the OS has confirmed the pid is gone (a probe, not
   * bun-pty's exit event); rejects with `PtyExitUnconfirmedError` when it is not.
   */
  dispose(): Promise<void>;
  /**
   * Re-run the exit confirmation of a process whose `dispose()` rejected: probe, SIGKILL,
   * probe. Resolves once the pid is gone. Used to release a quarantine.
   */
  confirmExit?(): Promise<void>;
}

export interface PtyTurnResult {
  text: string;
  bytesCaptured: number;
  /** Always true from a real process: a turn resolves only on a complete transcript
   *  reply. A result that says false is a failure for both callers, whatever else it
   *  carries (#562 round 3: there is no "complete anyway" exception). */
  cleanBoundary: boolean;
  sessionId: string;
}

/**
 * A result whose boundary is not confirmed. A real process never returns one (it rejects
 * instead); the type and the callers keep the contract, so a stand-in that does is a
 * failure, not a success with whatever text it carried. The turn may have run: never
 * resubmit.
 */
export class PtyBoundaryUnconfirmedError extends Error {
  constructor(public readonly label: string) {
    super(
      `PTY turn boundary unconfirmed for ${label}: no complete reply was confirmed in the session transcript; the turn may have run`,
    );
    this.name = "PtyBoundaryUnconfirmedError";
  }
}

/**
 * What to do with a finished turn: `ok`, or `failed` when the boundary is not clean. There
 * is no third verdict: a reply that arrived without a clean boundary used to be returned
 * as a success and the entry retired (#562 round 3, M2). Both callers of `runTurn` in the
 * supervisor apply it.
 */
export function boundaryVerdict(result: PtyTurnResult): "ok" | "failed" {
  return result.cleanBoundary ? "ok" : "failed";
}

/**
 * The transcript says the turn ended in failure: the CLI's own API error, a command's
 * stderr, or something that leaves it uncertain whose reply this is (`ambiguous`). The
 * prompt did run (or may have), so the turn is never retried or resubmitted. For an
 * `api-error`, `text` is the CLI's error text, which the runner reads to decide whether the
 * stored session is corrupt (the print path does the same from its output).
 */
export class PtyTurnFailedError extends Error {
  constructor(
    public readonly label: string,
    public readonly kind: TurnFailureKind,
    public readonly text: string,
  ) {
    super(
      kind === "ambiguous"
        ? `PTY turn outcome uncertain for ${label}: ${text}; the turn may have run`
        : `PTY turn failed for ${label} (${kind}): ${text}`,
    );
    this.name = "PtyTurnFailedError";
  }
}

/**
 * Type of the `spawnPty` factory function. Exposed so the supervisor (and
 * tests) can declare an injectable spawn seam (`injectSpawnPty`) without
 * importing the concrete `spawnPty` symbol from this file at top-level.
 */
export type SpawnPty = (opts: PtyProcessOptions) => Promise<PtyProcess>;

/**
 * A message of the turn carries a terminal stop reason, but the transcript never showed an
 * authoritative boundary after it (`turn_duration`, the next real prompt) before the
 * timeout. The reply may be incomplete (a later block can still arrive), so it is not
 * delivered and the turn is not replayed. The supervisor kills the process and resumes the
 * session in a new one.
 */
export class PtyTranscriptUncertainError extends Error {
  constructor(
    public readonly label: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `PTY turn outcome uncertain for ${label}: the reply ended but the transcript showed no turn boundary within ${elapsedMs}ms; the turn may have run`,
    );
    this.name = "PtyTranscriptUncertainError";
  }
}

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
 * The prompt was written but claude never showed a turn running (#562): the
 * paste sat unsubmitted in the input box, or the TUI is wedged. Raised instead
 * of completing the turn on whatever the screen happened to show. NOT retried by
 * the supervisor: the process is alive, and a re-sent prompt could land twice.
 */
export class PtyPromptNotAcceptedError extends Error {
  constructor(
    public readonly label: string,
    public readonly elapsedMs: number,
    detail?: string,
  ) {
    super(
      `PTY prompt not accepted for ${label}: no turn started within ${elapsedMs}ms of the send and one submit retry${detail ? ` (${detail})` : ""}`,
    );
    this.name = "PtyPromptNotAcceptedError";
  }
}

/**
 * This process has no transcript to read, so no turn on it can be verified (#562 round
 * 2). Raised before anything is written: the screen is not an acceptable substitute.
 */
export class PtyTranscriptUnavailableError extends Error {
  constructor(
    public readonly label: string,
    public readonly why: string,
  ) {
    super(`PTY turn refused for ${label}: no session transcript to read (${why})`);
    this.name = "PtyTranscriptUnavailableError";
  }
}

/**
 * The OS still shows the process after SIGTERM, SIGKILL and the hard cap. It may still be
 * writing its transcript, so nothing may resume that session until a later confirmation
 * succeeds (the supervisor quarantines the key).
 */
export class PtyExitUnconfirmedError extends Error {
  constructor(
    public readonly label: string,
    public readonly pid: number,
  ) {
    super(
      `PTY process ${label} (pid ${pid}) is still alive after SIGKILL; its exit is unconfirmed`,
    );
    this.name = "PtyExitUnconfirmedError";
  }
}

export class PtyClosedError extends Error {
  constructor(
    public readonly label: string,
    public readonly exitCode: number | null,
    public readonly signal: string | null,
    /**
     * The turn's prompt had been written when the process went away, so it may have run.
     * False (the default) means it never went out and the supervisor may retry it.
     */
    public readonly promptSent = false,
  ) {
    super(`PTY closed during turn for ${label} (exit=${exitCode} signal=${signal})`);
    this.name = "PtyClosedError";
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_QUIET_WINDOW_MS = 500;
const DEFAULT_SETTLE_CAP_MS = 2000;
const DEFAULT_SUBMIT_CONFIRM_MS = 3000;
/** How often a turn's transcript is read. */
const DEFAULT_POLL_MS = 50;
/** Retirement: how long SIGTERM gets before SIGKILL, and the total wait for the OS to agree. */
const DEFAULT_EXIT_GRACE_MS = 2000;
const DEFAULT_EXIT_CAP_MS = 7000;
const EXIT_PROBE_MS = 20;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_PERMISSION_MODE_ARGS = ["--dangerously-skip-permissions"];
/** Bracketed-paste markers (xterm mode 2004, which claude's TUI turns on) (#559). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Delay between the project MCP server dialog showing and its Esc (#469). */
export const MCP_DIALOG_ANSWER_DELAY_MS = 500;
/** Ready-settle hard timeout: the boot window, and each fresh window a dialog opens. */
export const READY_SETTLE_HARD_TIMEOUT_MS = 3000;
/**
 * Hard cap on the tail ring buffer that captures pre-settle PTY output for
 * the issue #176 diagnostic snapshot. 8 KiB is enough to hold a typical
 * claude error message (auth failure, missing binary, updater crash, …)
 * without bloating per-PTY memory. Anything older slides off.
 */
const SETTLE_TAIL_MAX_BYTES = 8 * 1024;

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
    args.push(...UNTRUSTED_CLAUDE_ARGS);
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
  private readonly _settleCapMs: number;
  private readonly _submitConfirmMs: number;
  private readonly _now: () => number;
  private readonly _setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly _setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (handle: ReturnType<typeof setInterval>) => void;

  /** Whether we are currently inside a runTurn call. */
  private _turnInProgress = false;
  /** Resolver for the current runTurn promise. */
  private _turnResolve: ((result: PtyTurnResult) => void) | null = null;
  private _turnReject: ((err: Error) => void) | null = null;
  private _turnHardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _pollHandle: ReturnType<typeof setInterval> | null = null;
  /** #562: fires while the transcript does not show the prompt; retries the submit once. */
  private _submitConfirmHandle: ReturnType<typeof setTimeout> | null = null;
  private _submitRetried = false;
  private _turnStartedAt = 0;
  /** Where the CLI writes this session's transcript; null when there is none to read. */
  private readonly _transcriptPath: string | null;
  /** Why there is no transcript path (for the refusal message). */
  private readonly _noTranscriptWhy: string;
  /** The transcript reader for the turn in flight. */
  private _tx: TranscriptTurn | null = null;
  /** Assistant text already handed to `onChunk`. */
  private _txStreamed = "";
  /** Tool lines already handed to `onToolEvent`. */
  private _txToolsEmitted = 0;
  /** The transcript has shown this turn's prompt. */
  private _accepted = false;
  /** When the transcript first showed the reply complete; 0 until then. */
  private _endedAt = 0;
  /** When the screen last painted: readiness timing only. */
  private _lastDataAt = 0;
  private _disposed = false;
  /** The retirement in flight or last settled OK; cleared when it rejects so a retry runs. */
  private _disposal: Promise<void> | null = null;
  private readonly _signalPid: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly _readIdentity: (pid: number) => string | null;
  /** The child's birth identity, read at spawn; null when it could not be read. */
  private readonly _identity: string | null;
  private readonly _exitGraceMs: number;
  private readonly _exitCapMs: number;
  /** Listener disposables from bun-pty. */
  private _onDataDisposable: { dispose(): void } | null = null;
  private _onExitDisposable: { dispose(): void } | null = null;
  /** Optional callbacks from the current runTurn. */
  private _onChunk?: (text: string) => void;
  private _onToolEvent?: (line: string) => void;
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

  constructor(pty: IPty, opts: PtyProcessOptions) {
    this._pty = pty;
    this._pid = pty.pid;
    this._sessionId =
      opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : (opts.newSessionId ?? "");
    this.cwd = opts.cwd;
    // A process spawned through a test hook is not a real claude: it writes no
    // transcript unless the test names one.
    const hooked = Boolean(opts._commandOverride || opts._argsOverride || opts._skipClaudeArgs);
    const untrusted = opts.isolation === "untrusted";
    this._transcriptPath =
      opts.transcriptPath ??
      (hooked
        ? null
        : resolveTranscriptPath({
            cwd: opts.cwd,
            sessionId: this._sessionId,
            env: opts.env,
            untrusted,
          }));
    this._noTranscriptWhy = untrusted
      ? "an untrusted one-shot runs with --no-session-persistence"
      : hooked
        ? "spawned through a test hook without a transcriptPath"
        : "no session id";
    this._secretValues = collectSecretValues(opts.env);
    this.label = `${opts.agentName ?? "pty"}:${pty.pid}`;
    this._quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    this._settleCapMs = opts.settleCapMs ?? DEFAULT_SETTLE_CAP_MS;
    this._submitConfirmMs = opts.submitConfirmMs ?? DEFAULT_SUBMIT_CONFIRM_MS;
    this._now = opts._now ?? (() => Date.now());
    this._signalPid = opts._signalPid ?? ((pid, signal) => void process.kill(pid, signal));
    this._readIdentity = opts._readPidIdentity ?? (opts._signalPid ? () => null : readPidIdentity);
    this._identity = this._readIdentity(pty.pid);
    this._exitGraceMs = opts._exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    this._exitCapMs = opts._exitCapMs ?? DEFAULT_EXIT_CAP_MS;
    this._setTimeout = opts._setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout = opts._clearTimeout ?? ((h) => clearTimeout(h));
    this._setInterval = opts._setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this._clearInterval = opts._clearInterval ?? ((h) => clearInterval(h));
    this._spawnedAt = this._now();

    this._onDataDisposable = pty.onData((data) => this._handleData(data));
    this._onExitDisposable = pty.onExit((info) => this._handleExit(info));
  }

  get pid(): number {
    return this._pid;
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

  private _handleData(data: string): void {
    // bun-pty delivers strings; the byte count is all the screen is used for here.
    const bytes = new TextEncoder().encode(data);
    const now = this._now();
    dumpPtyTrace(`<< pid=${this._pid} turn=${this._turnInProgress} n=${bytes.length}`, data);
    if (this._firstDataAt === 0) this._firstDataAt = now;
    // Liveness only: when did the TUI last paint. A finished reply waits for this to go
    // quiet before the next prompt is accepted (readiness); it never decides the outcome.
    this._lastDataAt = now;

    // Issue #176: maintain a rolling tail of recent bytes so we can diagnose
    // "PTY exited before TUI settled" failures; the tail persists across spawn → exit.
    this._appendToTail(bytes);
  }

  private _emitChunk(text: string): void {
    if (text.length === 0 || !this._onChunk) return;
    try {
      this._onChunk(text);
    } catch {
      // Caller bug; never let it kill the PTY pipeline.
    }
  }

  /**
   * One poll of the turn's transcript: acceptance (the submit-retry timer stands down),
   * the assistant's own text and tool calls for the streaming callbacks, and the end of the
   * reply. The only place a turn can come to succeed (#562 round 2).
   */
  private _pollTurn(): void {
    const tx = this._tx;
    if (!tx || !this._turnInProgress) return;
    let state: ReturnType<TranscriptTurn["poll"]>;
    try {
      state = tx.poll();
    } catch (err) {
      // The file is no longer the one the turn started on: nothing in it can be trusted
      // as new evidence, and the prompt may have run. Fail, never resubmit.
      if (err instanceof TranscriptReplacedError) this._rejectTurn(err);
      return; // Any other failed read is a poll that saw nothing; the next one retries.
    }
    if (state.accepted) {
      this._accepted = true;
      this._clearSubmitConfirm();
    }
    if (this._onChunk && state.answer.length > 0 && state.answer !== this._txStreamed) {
      const delta = state.answer.startsWith(this._txStreamed)
        ? state.answer.slice(this._txStreamed.length)
        : `${this._txStreamed.length > 0 ? "\n" : ""}${state.answer}`;
      this._txStreamed = state.answer;
      this._emitChunk(delta);
    }
    if (this._onToolEvent) {
      for (; this._txToolsEmitted < state.toolLines.length; this._txToolsEmitted++) {
        try {
          this._onToolEvent(state.toolLines[this._txToolsEmitted] as string);
        } catch {
          /* swallow */
        }
      }
    }
    if (state.ended && this._endedAt === 0) this._commitTurn();
  }

  /**
   * The transcript has established the outcome: the turn is COMMITTED. From here the hard
   * timeout, the submit retry and a PTY exit can no longer change it; the screen settling
   * that follows only delays the return (#562 round 3, H5). A timeout that fired during
   * the settle would turn a finished reply into `PtyTurnTimeoutError`, which the supervisor
   * retries: the same prompt would run a second time.
   */
  private _commitTurn(): void {
    this._endedAt = this._now();
    this._clearSubmitConfirm();
    if (this._turnHardTimeoutHandle != null) {
      this._clearTimeout(this._turnHardTimeoutHandle);
      this._turnHardTimeoutHandle = null;
    }
  }

  /**
   * Every tick: read the transcript, and once it shows the reply complete, resolve. The
   * screen's only say is TIMING: wait until it has been quiet for `quietWindowMs`, so the
   * next paste does not land on a repaint, but never past `settleCapMs`. That wait can
   * only delay the resolution; it cannot complete a turn (nothing but the transcript
   * does), change the answer or turn a success into a failure.
   */
  private _tick(): void {
    if (!this._turnInProgress) return;
    this._pollTurn();
    if (this._endedAt === 0) return;
    // A failed turn is retired by the caller, so there is no next paste to wait for.
    if (this._tx?.state().failure) {
      this._completeTurn();
      return;
    }
    const now = this._now();
    if (now - this._lastDataAt >= this._quietWindowMs || now - this._endedAt >= this._settleCapMs) {
      this._completeTurn();
    }
  }

  private _handleExit(info: { exitCode: number; signal?: number | string }): void {
    this._alive = false;
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

    if (this._turnInProgress) {
      // A reply the transcript committed (even one not read yet) stays the outcome: the
      // process exiting while the screen settles must not make the supervisor respawn and
      // run it again.
      this._pollTurn();
      if (!this._turnInProgress) return;
      if (this._endedAt !== 0) {
        this._completeTurn();
        return;
      }
      const err = new PtyClosedError(
        this.label,
        info.exitCode ?? null,
        info.signal != null ? String(info.signal) : null,
        true,
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
    // Nothing but the session transcript can say a turn was accepted, what the answer is
    // or that it is over. A process with no transcript to read has no way to succeed, so
    // it fails BEFORE the prompt is written rather than after a turn it cannot verify.
    if (!this._transcriptPath) {
      return Promise.reject(new PtyTranscriptUnavailableError(this.label, this._noTranscriptWhy));
    }

    this._turnInProgress = true;
    this._onChunk = opts.onChunk;
    this._onToolEvent = opts.onToolEvent;
    this._txStreamed = "";
    this._txToolsEmitted = 0;
    this._accepted = false;
    this._endedAt = 0;
    this._turnStartedAt = this._now();

    // What goes on the wire, once: the transcript is matched against exactly this. Marked
    // BEFORE the write, so only what the CLI appends after it can count.
    const written = preparePtyPromptForWrite(prompt, {
      allowReplCommand: opts.allowReplCommand,
    });
    this._tx = new TranscriptTurn({
      path: this._transcriptPath,
      written,
      replCommand: opts.allowReplCommand === true,
    });
    this._tx.mark();

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
      dumpPtyTrace(`>> pid=${this._pid} write prompt`, `${JSON.stringify(prompt).slice(0, 80)}+CR`);
      this._pty.write(`${PASTE_START}${written}${PASTE_END}\r`);
    } catch (err) {
      this._turnInProgress = false;
      this._tx = null;
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    return new Promise<PtyTurnResult>((resolve, reject) => {
      this._turnResolve = resolve;
      this._turnReject = reject;

      if (opts.timeoutMs > 0) {
        this._turnHardTimeoutHandle = this._setTimeout(() => {
          // The outcome may already be in the file, unread (the poll runs every 50 ms): a
          // reply that finished before the deadline is not a timeout.
          this._pollTurn();
          if (!this._turnInProgress || this._endedAt !== 0) return;
          const elapsed = this._now() - this._turnStartedAt;
          // A final message with no boundary is UNCERTAIN (it may still gain blocks), which
          // is not the same as a turn still running.
          this._rejectTurn(
            this._tx?.state().finalSeen
              ? new PtyTranscriptUncertainError(this.label, elapsed)
              : new PtyTurnTimeoutError(this.label, elapsed),
          );
        }, opts.timeoutMs);
      }

      this._armSubmitConfirm();
      this._pollHandle = this._setInterval(() => this._tick(), DEFAULT_POLL_MS);
    });
  }

  /**
   * #562: the transcript is the evidence the prompt was accepted. Until it shows, the
   * paste may sit unsubmitted in the input box (or its CR landed inside the paste). Wait
   * `submitConfirmMs`, press Enter once more (a bare CR is harmless on an empty input box
   * if the first one WAS accepted; the prompt is never written again), wait again, then
   * fail the turn: never complete it on anything but the transcript.
   */
  private _clearSubmitConfirm(): void {
    if (this._submitConfirmHandle != null) {
      this._clearTimeout(this._submitConfirmHandle);
      this._submitConfirmHandle = null;
    }
  }

  private _armSubmitConfirm(): void {
    this._submitRetried = false;
    const check = (): void => {
      this._submitConfirmHandle = null;
      // The evidence may already be in the file, unread: look before deciding.
      this._pollTurn();
      if (!this._turnInProgress || this._accepted) return;
      if (!this._submitRetried) {
        this._submitRetried = true;
        try {
          dumpPtyTrace(`>> pid=${this._pid} retry submit (prompt not in transcript)`, "");
          this._pty.write("\r");
        } catch (err) {
          this._rejectTurn(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this._submitConfirmHandle = this._setTimeout(check, this._submitConfirmMs);
        return;
      }
      // Still nothing: clear whatever sits in the input box so it cannot be submitted by
      // the NEXT turn's CR, then fail.
      this._clearInputBox();
      const foreign = this._tx?.state().foreignUserEntries ?? 0;
      this._rejectTurn(
        new PtyPromptNotAcceptedError(
          this.label,
          this._now() - this._turnStartedAt,
          foreign > 0
            ? `the transcript recorded ${foreign} user entr${foreign === 1 ? "y" : "ies"} that did not match this prompt`
            : undefined,
        ),
      );
    };
    this._submitConfirmHandle = this._setTimeout(check, this._submitConfirmMs);
  }

  /** Ctrl-U (0x15, `kill-line`) empties claude's input box. Input hygiene on a failed turn. */
  private _clearInputBox(): void {
    try {
      this._pty.write("\x15");
    } catch {
      // PTY may have died; ignore — the next turn will fail loudly.
    }
  }

  private _clearTurnTimers(): void {
    if (this._turnHardTimeoutHandle != null) {
      this._clearTimeout(this._turnHardTimeoutHandle);
      this._turnHardTimeoutHandle = null;
    }
    if (this._pollHandle != null) {
      this._clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    this._clearSubmitConfirm();
  }

  private _completeTurn(): void {
    if (!this._turnInProgress) return;
    // One more read so nothing written since the last poll is missed. The answer is the
    // assistant's own text from the transcript; the screen contributes nothing to it.
    this._pollTurn();
    if (!this._turnInProgress) return; // that read found the file replaced: already failed
    const state = this._tx?.state();
    const text = state?.answer ?? "";
    const failure = state?.failure ?? null;
    if (failure) {
      this._lastTurnEndedAt = this._now();
      this._rejectTurn(new PtyTurnFailedError(this.label, failure.kind, failure.text));
      return;
    }
    this._turnInProgress = false;
    this._tx = null;
    this._lastTurnEndedAt = this._now();
    this._onChunk = undefined;
    this._onToolEvent = undefined;
    this._clearTurnTimers();

    const result: PtyTurnResult = {
      text,
      bytesCaptured: Buffer.byteLength(text),
      // A turn resolves only on a complete transcript reply; anything else rejects.
      cleanBoundary: true,
      sessionId: this._sessionId,
    };
    const resolve = this._turnResolve;
    this._turnResolve = null;
    this._turnReject = null;
    if (resolve) resolve(result);
  }

  private _rejectTurn(err: Error): void {
    if (!this._turnInProgress) return;
    // The prompt may have run and its record may still arrive. Nothing is remembered here:
    // the supervisor kills this process and waits for its exit before any later turn marks
    // its offset (`retireEntry`), so no writer is left to append a late record.
    this._turnInProgress = false;
    this._tx = null;
    this._onChunk = undefined;
    this._onToolEvent = undefined;
    this._clearTurnTimers();
    const reject = this._turnReject;
    this._turnResolve = null;
    this._turnReject = null;
    if (reject) reject(err);
  }

  // ─── dispose ────────────────────────────────────────────────────────

  /**
   * Retire the process and prove it. bun-pty 0.4.9 `kill()` ignores its signal argument, fires
   * `onExit` synchronously whether or not the child died, and turns every later `kill()` into a
   * no-op, so neither its event nor a second `kill("SIGKILL")` says anything about the OS. Death
   * is read from the OS: `process.kill(pid, 0)` throws ESRCH once the pid is gone (EPERM means
   * it still exists). If the child outlives the grace period it gets SIGKILL straight from here,
   * to its process group too (the child is its own group leader, so its MCP children go with it).
   * Rejects with `PtyExitUnconfirmedError` when the pid is still there at the hard cap.
   */
  dispose(): Promise<void> {
    if (!this._disposal) {
      const run = this._retire();
      this._disposal = run;
      // A rejected retirement is retried by the next `dispose()` / `confirmExit()`.
      run.catch(() => {
        if (this._disposal === run) this._disposal = null;
      });
    }
    return this._disposal;
  }

  confirmExit(): Promise<void> {
    return this.dispose();
  }

  private async _retire(): Promise<void> {
    const firstRun = !this._disposed;
    this._disposed = true;
    // Read before kill(): bun-pty's own exit event flips this synchronously.
    const wasAlive = this._alive;

    if (firstRun && this._turnInProgress) {
      this._rejectTurn(new PtyClosedError(this.label, null, "SIGTERM", true));
    }

    // Win32 has no signal 0 probe; keep waiting for the exit event there.
    const probeable = process.platform !== "win32" && Number.isInteger(this._pid) && this._pid > 1;

    if (firstRun && wasAlive) {
      if (probeable) {
        // Not through bun-pty if the pid now belongs to someone else.
        if (this._pidState(this._pid) !== "replaced") {
          try {
            this._pty.kill("SIGTERM");
          } catch {
            // Already dead.
          }
        }
      } else {
        await this._retireByExitEvent();
      }
    }

    if (probeable && (wasAlive || !firstRun)) await this._confirmGoneByPid(firstRun);

    try {
      this._onDataDisposable?.dispose();
    } catch {}
    try {
      this._onExitDisposable?.dispose();
    } catch {}
    this._onDataDisposable = null;
    this._onExitDisposable = null;
  }

  private _pidExists(pid: number): boolean {
    try {
      this._signalPid(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * What the pid is now, against the child we spawned (#562 round 8). Existence alone proves
   * nothing: a later confirmation can run long after the child exited, and the OS reuses pids.
   *   gone      no process has the pid: the original exited.
   *   replaced  a process with a different birth identity has it: the original exited.
   *   same      the identity matches: the original is still there.
   *   unknown   the pid exists but the identity could not be compared: cannot tell.
   */
  private _pidState(pid: number): "gone" | "replaced" | "same" | "unknown" {
    if (!this._pidExists(pid)) return "gone";
    if (this._identity === null) return "unknown";
    const now = this._readIdentity(pid);
    if (now === null) return "unknown";
    return now === this._identity ? "same" : "replaced";
  }

  private _originalGone(pid: number): boolean {
    const s = this._pidState(pid);
    return s === "gone" || s === "replaced";
  }

  /**
   * May this process be signalled? Only a pid proven to still be the child we spawned. With
   * no identity recorded at spawn, only inside the initial retirement window (the child was
   * seen alive moments ago, so reuse is not plausible); a later confirmation sends nothing.
   */
  private _maySignal(pid: number, initial: boolean): boolean {
    const s = this._pidState(pid);
    return s === "same" || (s === "unknown" && initial && this._identity === null);
  }

  /**
   * Poll until the original is gone or `ms` pass. Wall clock and real timers on purpose: the
   * injected clock and timers drive turn timing, and a frozen one must not hang retirement.
   * The cheap existence probe runs every tick; the identity (a `ps` spawn on macOS) is read
   * on the first and the last check only.
   */
  private async _waitGone(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    let first = true;
    for (;;) {
      const last = Date.now() >= until;
      if (first || last ? this._originalGone(pid) : !this._pidExists(pid)) return true;
      if (last) return false;
      first = false;
      await new Promise<void>((r) => setTimeout(r, EXIT_PROBE_MS));
    }
  }

  private async _confirmGoneByPid(initial: boolean): Promise<void> {
    const pid = this._pid;
    if (await this._waitGone(pid, this._exitGraceMs)) return;
    // Not obeying SIGTERM: kill the group (MCP children) and the leader directly, not through
    // bun-pty, whose `kill()` has already run and is now a no-op. The identity is checked
    // before EACH signal, so a pid the OS has handed to someone else is never signalled.
    for (const target of [-pid, pid]) {
      if (!this._maySignal(pid, initial)) continue;
      try {
        this._signalPid(target, "SIGKILL");
      } catch {
        // ESRCH: already gone.
      }
    }
    if (await this._waitGone(pid, Math.max(0, this._exitCapMs - this._exitGraceMs))) return;
    throw new PtyExitUnconfirmedError(this.label, pid);
  }

  /** The pre-probe behaviour, for platforms that cannot probe a pid. */
  private async _retireByExitEvent(): Promise<void> {
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
    }, this._exitGraceMs);
    await exited;
    this._clearTimeout(killTimer);
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
    // #562 round 9: the synchronous final word for a session that is already named. No
    // await between this check and the `_ptySpawn` call below.
    if (opts.sessionId && opts.sessionId.length > 0) {
      assertSessionSpawnable({ sessionId: opts.sessionId });
    }
    const cmd = opts._commandOverride ?? claudeExecutable();
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
      // those keys from process.env around the synchronous FFI call.
      pty = withCleanProcessEnv(() =>
        (opts._ptySpawn ?? ptySpawn)(cmd, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd,
          env: opts.env,
        }),
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

    proc._waitForReadySettle(READY_SETTLE_HARD_TIMEOUT_MS).then(() => {
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
