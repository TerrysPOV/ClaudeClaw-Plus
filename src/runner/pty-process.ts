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
 *   6. No transcript to read (no session id, switched off, an untrusted one-shot with no
 *      throwaway config root) = the turn fails before anything is written:
 *      `PtyTranscriptUnavailableError`.
 *   7. An untrusted one-shot reads the same way from the isolated source (#581 cp4): the project
 *      directory of its own throwaway config root, where the CLI names the session file. The
 *      file is discovered and bound by inode, and only appended records that carry the exact
 *      bytes written (after the `@` neutralising) count. Acceptance retries, the deadline and
 *      the answer all come from that one observer; the supervisor reads nothing after the turn.
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
import { claudeExecutable, withCleanProcessEnv } from "../runner";
// Screen text is used for readiness and dialogs only (`_waitForReadySettle`): the
// parser's completion/answer API is deliberately NOT imported here (#562 round 2; the
// guard test `pty-turn-evidence-guard.test.ts` fails the build if it comes back).
import { stripAnsi } from "./pty-output-parser";
import { assertSessionSpawnable, PtyQuarantinedError } from "./pty-quarantine";
// Re-export the sanitiser from its standalone home so existing callers that
// pull it from `pty-process` (and through `runner/index`) keep working without
// loading bun-pty just to get the helper.
import {
  neutralizeFileMentions,
  preparePtyPromptForWrite,
  sanitizePtyPromptText,
} from "./pty-prompt-sanitizer";
import { promptPrepareOverride, untrustedFileMentionNeutralizing } from "./pty-process-test-seams";
import {
  resolveIsolatedProjectDir,
  resolveTranscriptPath,
  TranscriptReplacedError,
  TranscriptTurn,
  type TurnFailureKind,
} from "./pty-transcript";
// The common termination and confirmation of the leader AND its process group (#581 cp3).
import {
  type GroupDescription,
  type RetireGroupOutcome,
  type SurvivorCause,
  noteGroupMembers,
  retireProcessGroup,
} from "./pty-group-kill";
import { type GroupConfirmMode, judgeGroupOutcome } from "./pty-group-confirm";
// The one OS identity reader (#581 cp2). The leader's numeric start time is a projection of the
// same reading, not a second read.
import {
  type GroupMember,
  type GroupMembersReader,
  type PgidReader,
  readGroupMembers,
  readPgid,
  readPidIdentity,
  readPidSnapshot,
  sameIdentity,
  startMsFromIdentity,
} from "./pty-proc-identity";
// Screen is used for readiness and dialogs only (`_awaitReplReady`), never for a turn outcome.
import { Screen } from "./pty-screen";

export { TranscriptReplacedError };
import { appendFileSync } from "node:fs";

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

/**
 * What a later, independent retry needs to keep its signal authority when a retirement could not
 * finish (#581 cp8, H1): the leader's raw birth identity and process group id as read at spawn, and
 * the group members identified positively. A retry re-reads each before it signals anything.
 */
export interface GroupSurvivorEvidence {
  identity: string | null;
  groupId: number | null;
  members: GroupMember[];
}

export interface PtyProcessOptions {
  /** One-shot isolation overrides every persona, resume and permission flag. */
  isolation?: "untrusted" | "trusted-session";
  /**
   * The supervisor session key (or bus agent id) this process serves. Reported in the
   * group-unconfirmed log line, and carried to the final spawn assertion (an untrusted
   * one-shot's ephemeral key is its only fence key: the CLI session id is unknown).
   */
  sessionKey?: string;
  /**
   * INTERNAL TEST HOOK: overrides `pty.groupConfirm` for this process. An untrusted one-shot
   * enforces whatever this says (the setting cannot weaken it).
   */
  _groupConfirm?: GroupConfirmMode;
  /** INTERNAL TEST HOOK: live (non-zombie) members of the group; see `retireProcessGroup`. */
  _liveMembers?: (pid: number) => number | undefined;
  /** INTERNAL TEST HOOK: names the members left in a group that would not go. */
  _describeGroup?: (pid: number, deadlineAt: number) => GroupDescription;
  /**
   * INTERNAL TEST HOOK: lists a process group's members with their birth identities. The default
   * reads the OS. A test that stands in for the OS with `_signalPid` or `_readPidIdentity` gets
   * an empty listing unless it names a reader: a made-up group has no members to identify.
   */
  _readMembers?: GroupMembersReader;
  /**
   * INTERNAL TEST HOOK: reads a process group id (the child's at spawn, the daemon's at
   * retirement). A test that stands in for the OS gets a fake in which every pid leads its own
   * group; a real one reads the OS (`readPidSnapshot`).
   */
  _readPgid?: PgidReader;
  /** Test seam: how long an untrusted spawn waits for the REPL footer. Default 20 s. */
  _replReadyBudgetMs?: number;
  /**
   * Called with the pid, and the leader's start time recorded at spawn (null when it could not be
   * read), and why: the group is still alive, an escapee outside it is, or the escapee scan could
   * not tell (`scan-unknown`). Called when retirement could not get all of that to disappear.
   * An isolation adapter (root and slot retention): it plugs in AFTER the outcome is decided,
   * and nothing it does, an exception included, can change that outcome. If it throws, the error
   * is logged and `dispose()` rejects all the same.
   */
  onGroupSurvived?: (
    pid: number,
    startMs: number | null,
    cause: SurvivorCause,
    evidence?: GroupSurvivorEvidence,
  ) => void;
  /**
   * Called once the group is gone: stop descendants that left it (Linux, see pty-escape-scan),
   * given the leader's pid and the start time recorded at spawn (a process older than that
   * cannot be ours). Resolves the pids that are still alive; a rejection (`/proc` could not be
   * listed) counts as "could not tell" and fails closed like a survivor.
   */
  reapEscapees?: (leader: {
    pid: number;
    startMs: number | null;
    /** Time left in the retirement's one deadline; the scan must not start a budget of its own. */
    remainingMs: number;
    /** The retirement's one absolute deadline (`Date.now()` ms): the scan is bounded by it. */
    deadlineAt: number;
  }) => Promise<number[]>;
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
   * and config dir when omitted; a process spawned through a test hook has none. An untrusted
   * one-shot writes one inside its throwaway config root (`_isolatedProjectDir`). With a transcript, acceptance, the
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
  /** The leader's start time recorded at spawn (untrusted children only); null when not read. */
  readonly leaderStartMs?: number | null;
  /** Identity, group id and identified members, for a retry that must keep its signal authority. */
  survivorEvidence?(): GroupSurvivorEvidence;
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
/** When the child's group id is read again after spawn (see `PtyProcess._refreshGroupId`). */
const GROUP_ID_REFRESH_MS = [25, 250] as const;
const DEFAULT_EXIT_CAP_MS = 7000;
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
  /**
   * An untrusted one-shot's own project directory, where the CLI names the session file itself
   * (the isolated transcript source); null for every other process.
   */
  private readonly _isolatedProjectDir: string | null;
  /** Why there is no transcript to read (for the refusal message). */
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
  /** A test's identity reader; undefined: the retirement uses the OS reader bounded by its deadline. */
  private readonly _injectedIdentity: ((pid: number) => string | null) | undefined;
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
  /** Untrusted one-shot: the prompt and the raw PTY output stay out of `CLAUDECLAW_PTY_DUMP`. */
  private readonly _untrustedTrace: boolean;
  /** An untrusted one-shot: always enforces group confirmation (pty-group-confirm). */
  private readonly _untrusted: boolean;
  private readonly _sessionKey: string;
  private readonly _groupConfirm?: GroupConfirmMode;
  private readonly _liveMembers?: (pid: number) => number | undefined;
  private readonly _describeGroup?: (pid: number, deadlineAt: number) => GroupDescription;
  private readonly _readMembers: GroupMembersReader;
  private readonly _readPgid: PgidReader;
  /** A test's (or the fake OS's) group id reader; undefined: the retirement reads the OS, bounded by its deadline. */
  private readonly _injectedPgid: PgidReader | undefined;
  /** The leader's process group id, read with its identity at spawn; null when unreadable. */
  private _groupId: number | null;
  private readonly _onGroupSurvived?: (
    pid: number,
    startMs: number | null,
    cause: SurvivorCause,
    evidence?: GroupSurvivorEvidence,
  ) => void;
  private readonly _reapEscapees?: (leader: {
    pid: number;
    startMs: number | null;
    remainingMs: number;
    deadlineAt: number;
  }) => Promise<number[]>;
  /**
   * Group members identified positively (pid and birth identity) by a live look, while the leader
   * was the recorded process and before any retirement began (#581 cp10, option B). A retirement
   * only narrows them. Evidence only: each is read again before it grants any authority, and
   * nothing here expires or renews by itself (#581 cp8, H2).
   */
  private _groupMembers: GroupMember[] = [];
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
    // An untrusted one-shot reads only the transcript its own throwaway root receives. It never
    // takes a caller's `transcriptPath` and never falls back to a session id or the operator's
    // config root (`resolveIsolatedProjectDir`).
    this._isolatedProjectDir = untrusted
      ? resolveIsolatedProjectDir({ cwd: opts.cwd, env: opts.env })
      : null;
    this._transcriptPath = untrusted
      ? null
      : (opts.transcriptPath ??
        (hooked
          ? null
          : resolveTranscriptPath({
              cwd: opts.cwd,
              sessionId: this._sessionId,
              env: opts.env,
            })));
    this._noTranscriptWhy = untrusted
      ? "an untrusted one-shot has no throwaway config root to read a transcript from"
      : hooked
        ? "spawned through a test hook without a transcriptPath"
        : "no session id";
    this._secretValues = collectSecretValues(opts.env);
    this._untrustedTrace = opts.isolation === "untrusted";
    this._untrusted = untrusted;
    this._sessionKey = opts.sessionKey ?? opts.agentName ?? "pty";
    this._groupConfirm = opts._groupConfirm;
    this._liveMembers = opts._liveMembers;
    this._describeGroup = opts._describeGroup;
    this._readyGate = opts.isolation === "untrusted" && !opts._skipReadySettle;
    this._replReadyBudgetMs = opts._replReadyBudgetMs ?? UNTRUSTED_REPL_READY_MS;
    this._onGroupSurvived = opts.onGroupSurvived;
    this._reapEscapees = opts.reapEscapees;
    this._screen = new Screen(opts.cols ?? DEFAULT_COLS, opts.rows ?? DEFAULT_ROWS);
    this.label = `${opts.agentName ?? "pty"}:${pty.pid}`;
    this._quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    // Untrusted text also loses its `@` file mentions (see neutralizeFileMentions). The
    // trusted path is untouched. The two seams are test-only (pty-process-test-seams).
    // The exact bytes this produces are what the transcript turn must see in the user record:
    // `runTurn` hands them to the observer, so neutralised text is matched as neutralised.
    const prepare = promptPrepareOverride() ?? preparePtyPromptForWrite;
    this._preparePrompt =
      opts.isolation === "untrusted" && untrustedFileMentionNeutralizing()
        ? (text, writeOptions) => neutralizeFileMentions(prepare(text, writeOptions))
        : prepare;
    this._settleCapMs = opts.settleCapMs ?? DEFAULT_SETTLE_CAP_MS;
    this._submitConfirmMs = opts.submitConfirmMs ?? DEFAULT_SUBMIT_CONFIRM_MS;
    this._now = opts._now ?? (() => Date.now());
    this._signalPid = opts._signalPid ?? ((pid, signal) => void process.kill(pid, signal));
    // A test that stands in for the OS (a made-up pid with `_signalPid` or `_readPidIdentity`) gets
    // a fake one: every pid leads its own group and has no members; the real reader is the default.
    const fakeOs = Boolean(opts._signalPid || opts._readPidIdentity || opts._readPgid);
    this._injectedPgid = opts._readPgid ?? (fakeOs ? (pid) => pid : undefined);
    this._readPgid = this._injectedPgid ?? ((pid) => readPgid(pid));
    this._readMembers =
      opts._readMembers ??
      (fakeOs
        ? () => ({ members: [], complete: true })
        : (pgid, deadlineAt) => readGroupMembers(pgid, deadlineAt));
    this._injectedIdentity = opts._readPidIdentity ?? (opts._signalPid ? () => null : undefined);
    this._readIdentity = this._injectedIdentity ?? readPidIdentity;
    // The child's identity and its group id come from ONE reading, taken while it is certainly
    // the process we spawned (#581 cp8, L1).
    if (this._injectedIdentity || opts._readPgid) {
      this._identity = this._readIdentity(pty.pid);
      this._groupId = this._readPgid(pty.pid);
    } else {
      const snapshot = readPidSnapshot(pty.pid);
      this._identity = snapshot?.identity ?? null;
      this._groupId = snapshot?.pgid ?? null;
    }
    this._leaderStartMs = startMsFromIdentity(this._identity);
    this._exitGraceMs = opts._exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    this._exitCapMs = opts._exitCapMs ?? DEFAULT_EXIT_CAP_MS;
    this._setTimeout = opts._setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout = opts._clearTimeout ?? ((h) => clearTimeout(h));
    this._setInterval = opts._setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this._clearInterval = opts._clearInterval ?? ((h) => clearInterval(h));
    this._spawnedAt = this._now();

    this._onDataDisposable = pty.onData((data) => this._handleData(data));
    this._onExitDisposable = pty.onExit((info) => this._handleExit(info));
    // The reading above can predate the child's `setsid()`, and a child that prints nothing never
    // triggers the first-data refresh. Real timers on purpose, like the retirement's: a frozen
    // turn clock must not keep the group id wrong.
    for (const ms of GROUP_ID_REFRESH_MS) {
      const timer = setTimeout(() => this._refreshGroupId(), ms);
      timer.unref?.();
    }
  }

  get pid(): number {
    return this._pid;
  }
  /** The leader's start time recorded at spawn, for a group that outlives it. Null: not read. */
  get leaderStartMs(): number | null {
    return this._leaderStartMs;
  }
  /**
   * What a later retry needs to keep its signal authority over this child's group (see
   * `GroupSurvivorEvidence`): the identity and group id recorded at spawn and the members a
   * retirement has identified so far.
   */
  survivorEvidence(): GroupSurvivorEvidence {
    return {
      identity: this._identity,
      groupId: this._groupId,
      members: [...this._groupMembers],
    };
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
    // bun-pty delivers strings; the byte count is all the screen is used for here.
    const bytes = new TextEncoder().encode(data);
    const now = this._now();
    this._trace(`<< pid=${this._pid} turn=${this._turnInProgress} n=${bytes.length}`, data);
    if (this._firstDataAt === 0) {
      this._firstDataAt = now;
      this._refreshGroupId();
    }
    // Liveness only: when did the TUI last paint. A finished reply waits for this to go
    // quiet before the next prompt is accepted (readiness); it never decides the outcome.
    this._lastDataAt = now;
    // Readiness gate only (login/trust/footer detection): the screen never feeds a turn outcome.
    if (this._readyGate) {
      this._screen.feed(data);
      this._onScreen?.();
    }

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

  /**
   * The group id read at construction can predate the child's `setsid()`; the first output proves
   * the child has run. Re-read it, but only while the pid still has the identity recorded at spawn.
   */
  private _refreshGroupId(): void {
    if (this._identity === null) return;
    if (this._injectedPgid) {
      this._groupId = this._injectedPgid(this._pid);
      return;
    }
    const snapshot = readPidSnapshot(this._pid);
    if (snapshot !== null && sameIdentity(snapshot.identity, this._identity)) {
      this._groupId = snapshot.pgid;
    }
  }

  /**
   * Remember who is in the group while it is provably ours (see `noteGroupMembers`): once the
   * leader is gone nothing else can say the survivors are ours. Evidence only. Reached only
   * through `_noteLiveGroup`.
   */
  private _noteGroupMembers(): void {
    // Only ever outside a retirement (`_noteLiveGroup`), so the look has its own short budget.
    const noted = noteGroupMembers({
      pid: this._pid,
      identity: this._identity,
      groupId: this._groupId,
      members: this._groupMembers,
      signal: this._signalPid,
      readIdentity: this._injectedIdentity,
      readMembers: this._readMembers,
      readGroupId: this._injectedPgid,
    });
    this._groupMembers = noted.members;
    this._groupId = noted.groupId;
  }

  /**
   * Learn the group while the leader is alive and no retirement has begun: at the hand-over from
   * spawn, when a turn starts and when one ends cleanly (#581 cp9, H2). These are the ONLY looks
   * (cp10, option B): none at the exit and none inside a retirement. A leader that later exits
   * on its own leaves behind members identified before it went, which can vouch for its group.
   * Evidence only.
   */
  _noteLiveGroup(): void {
    if (this._alive && !this._disposed) this._noteGroupMembers();
  }

  private _handleExit(info: { exitCode: number; signal?: number | string }): void {
    this._alive = false;
    // No member look here: the exit callback proves nothing about whose group this is (it can be
    // delivered late). Members are learned only while the leader is alive (cp10, option B).
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
    // Nothing but the session transcript can say a turn was accepted, what the answer is
    // or that it is over. A process with no transcript to read has no way to succeed, so
    // it fails BEFORE the prompt is written rather than after a turn it cannot verify. An
    // untrusted one-shot reads the isolated source (its own throwaway root); the trusted
    // routes read their session's file.
    if (!this._transcriptPath && !this._isolatedProjectDir) {
      return Promise.reject(new PtyTranscriptUnavailableError(this.label, this._noTranscriptWhy));
    }

    // The servers started at boot or by the last turn are in the group by now: learn them
    // while the leader can still be identified (#581 cp9, H2).
    this._noteLiveGroup();

    this._turnInProgress = true;
    this._onChunk = opts.onChunk;
    this._onToolEvent = opts.onToolEvent;
    this._txStreamed = "";
    this._txToolsEmitted = 0;
    this._accepted = false;
    this._endedAt = 0;
    this._turnStartedAt = this._now();

    // What goes on the wire, once: the transcript is matched against exactly this (after the
    // untrusted `@` neutralising, not before). Marked BEFORE the write, so only what the CLI
    // appends after it can count.
    const written = this._preparePrompt(prompt, {
      allowReplCommand: opts.allowReplCommand,
    });
    const tx = new TranscriptTurn({
      ...(this._isolatedProjectDir
        ? { isolatedProjectDir: this._isolatedProjectDir }
        : { path: this._transcriptPath as string }),
      written,
      replCommand: opts.allowReplCommand === true,
    });
    try {
      tx.mark();
    } catch {
      // The isolated directory cannot be listed, so nothing sent could be told apart from what
      // was there. Refused before the write, like a missing transcript.
      this._turnInProgress = false;
      return Promise.reject(
        new PtyTranscriptUnavailableError(
          this.label,
          "the isolated transcript directory could not be read",
        ),
      );
    }
    this._tx = tx;

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
    // A clean end: whatever the turn started (a lazily spawned server, a tool's helper) is
    // learned while the leader is still there to vouch for it (#581 cp9, H2).
    this._noteLiveGroup();
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
   * it still exists). The group is signalled first (`retireProcessGroup`: the child is its own
   * group leader, so its MCP children go with it): SIGTERM at once, SIGKILL if the leader or any
   * member outlives the grace. Resolves only when the leader AND its group are proven gone.
   * Rejects with `PtyExitUnconfirmedError` when the leader is still there at the hard cap, and
   * when a group member is, for an untrusted one-shot or `pty.groupConfirm: "enforce"`; a trusted
   * PTY in "observe" mode logs and counts the surviving member instead (pty-group-confirm).
   */
  dispose(): Promise<void> {
    if (!this._disposal) {
      // The joined promise is published BEFORE the retirement starts: `_retire()` runs
      // synchronously up to its first await, and the native `kill()` in it fires bun-pty's exit
      // callbacks right there. A callback that calls `dispose()` / `confirmExit()` must find this
      // retirement and join it, not start a second one with its own deadline (#581 cp8, M3).
      let settle!: { resolve: () => void; reject: (reason: unknown) => void };
      const joined = new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
      this._disposal = joined;
      // A rejected retirement is retried by the next `dispose()` / `confirmExit()`.
      joined.catch(() => {
        if (this._disposal === joined) this._disposal = null;
      });
      this._retire().then(settle.resolve, settle.reject);
    }
    return this._disposal;
  }

  confirmExit(): Promise<void> {
    return this.dispose();
  }

  private async _retire(): Promise<void> {
    // ONE absolute deadline for the whole retirement, allocated before any read and before the
    // native kill, so no read or signal below can start a budget of its own (cp9, M2).
    await this._retireWithin(Date.now() + this._exitCapMs);
  }

  private async _retireWithin(deadlineAt: number): Promise<void> {
    const firstRun = !this._disposed;
    this._disposed = true;
    // Read before kill(): bun-pty's own exit event flips this synchronously.
    const wasAlive = this._alive;
    // No member look here: a retirement learns no member (cp10, option B). The evidence is what
    // `_noteLiveGroup` learned while the leader was alive and before the retirement began.

    if (firstRun && this._turnInProgress) {
      this._rejectTurn(new PtyClosedError(this.label, null, "SIGTERM", true));
    }
    // The ready gate is not a turn: ending it here lets the caller waiting on it go at once.
    if (firstRun) this._endReplGate?.("closed");

    // Win32 has no signal 0 probe; keep waiting for the exit event there.
    const probeable = process.platform !== "win32" && Number.isInteger(this._pid) && this._pid > 1;

    if (firstRun && wasAlive) {
      if (probeable) {
        // Through bun-pty only on a fresh positive identity match, and not past the deadline: the
        // identity read takes time and the native kill is a signal like any other. Unknown, gone
        // and replaced all withhold it (cp10, H5), as the bus adapter's native kill does.
        if (this._pidState(this._pid) === "same" && Date.now() < deadlineAt) {
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

    // Always, whether or not the leader was alive: a leader that exited on its own can leave a
    // group behind, and bun-pty's exit event proves neither the leader's death nor the group's.
    if (probeable) await this._confirmGone(firstRun, deadlineAt);

    try {
      this._onDataDisposable?.dispose();
    } catch {}
    try {
      this._onExitDisposable?.dispose();
    } catch {}
    this._onDataDisposable = null;
    this._onExitDisposable = null;
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
    return sameIdentity(now, this._identity) ? "same" : "replaced";
  }

  /**
   * Prove the exit from the OS, the leader AND its process group, inside ONE absolute deadline
   * (`_exitCapMs` from now: wall clock and real timers on purpose, since the injected clock
   * drives turn timing and a frozen one must not hang retirement). The termination and the
   * probes are `retireProcessGroup`; the escape scan of an isolated one-shot gets only what is
   * left of the same deadline. Throws `PtyExitUnconfirmedError` through `_mapGroupOutcome`.
   */
  private async _confirmGone(initial: boolean, deadlineAt: number): Promise<void> {
    const pid = this._pid;
    const outcome = await retireProcessGroup({
      pid,
      identity: this._identity,
      groupId: this._groupId,
      members: this._groupMembers,
      readMembers: this._readMembers,
      readGroupId: this._injectedPgid,
      readIdentity: this._injectedIdentity,
      signal: this._signalPid,
      liveMembers: this._liveMembers,
      describe: this._describeGroup,
      initial,
      // Linux only (#570 r14, B): a leader with no identity recorded at spawn may be signalled on
      // group membership alone in the first termination. On macOS nothing is signalled without
      // identity evidence (#581 decision 2, review H1): such a child is quarantined instead.
      allowUnrecordedInitial: process.platform !== "darwin",
      sendTerm: initial,
      deadlineAt,
      termGraceMs: this._exitGraceMs,
    });
    // What the OS vouched for in this call replaces what an earlier one carried: members that
    // were not seen again are not remembered, and nothing about time or a flag survives.
    this._groupMembers = outcome.members;
    this._groupId = outcome.groupId;
    let scanCause: SurvivorCause | null = null;
    if (this._reapEscapees) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        // Out of time: not looking is not the same as finding nothing. The root stays held.
        scanCause = "scan-unknown";
      } else {
        try {
          const left = await this._reapEscapees({
            pid,
            startMs: this._leaderStartMs,
            remainingMs,
            deadlineAt,
          });
          if (left.length > 0) scanCause = "escapee";
        } catch {
          scanCause = "scan-unknown";
        }
      }
    }
    this._mapGroupOutcome(outcome, scanCause);
  }

  /**
   * The outcome of `_confirmGone` becomes a verdict in `judgeGroupOutcome` (pty-group-confirm),
   * the one place the staged enforcement is applied. A fatal verdict tells the isolation adapter
   * first (root and slot retention); whatever that does, an exception included, it cannot undo
   * the verdict.
   */
  private _mapGroupOutcome(outcome: RetireGroupOutcome, scanCause: SurvivorCause | null): void {
    const verdict = judgeGroupOutcome(
      outcome,
      { untrusted: this._untrusted, mode: this._groupConfirm, key: this._sessionKey },
      scanCause,
    );
    if (!verdict.fatal) return;
    if (this._onGroupSurvived) {
      try {
        this._onGroupSurvived(this._pid, this._leaderStartMs, verdict.cause, {
          identity: this._identity,
          groupId: this._groupId,
          members: this._groupMembers,
        });
      } catch (err) {
        console.error(
          `[pty-process] ${this.label}: survivor hook threw (${(err as Error)?.message ?? "error"}); the retirement is rejected all the same`,
        );
      }
    }
    throw new PtyExitUnconfirmedError(this.label, this._pid);
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
      // those keys from process.env around the synchronous FFI call. An untrusted
      // spawn passes `opts.env` as the exact policy instead: every other key of the
      // parent environment is removed for the call (and `opts.env` has already had
      // the strip list applied, see the supervisor's untrustedChildEnv).
      pty = withCleanProcessEnv(
        () => {
          // #562 round 9, moved here by #581 cp6: the synchronous final word, on the line
          // before the native call and inside the environment callback, so nothing (env
          // preparation included) sits between it and the fork. Unconditional: an untrusted
          // one-shot names no CLI session id, so the key (its ephemeral key) is what the
          // fence matches. The ids are the ones the argv names, as `PtyProcessImpl` records.
          assertSessionSpawnable({
            sessionKey: opts.sessionKey,
            sessionId: opts.sessionId || opts.newSessionId,
          });
          return (opts._ptySpawn ?? ptySpawn)(cmd, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: opts.cwd,
            env: opts.env,
          });
        },
        opts.isolation === "untrusted" ? opts.env : undefined,
      );
    } catch (err) {
      // A fenced session is the caller's typed refusal (the supervisor maps it), not a
      // failed spawn: it must not be wrapped into a plain Error.
      if (err instanceof PtyQuarantinedError) {
        reject(err);
        return;
      }
      reject(
        new Error(
          `Failed to spawn PTY for ${cmd}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const proc = new PtyProcessImpl(pty, opts);

    if (opts._skipReadySettle) {
      proc._noteLiveGroup(); // the hand-over: see `_noteLiveGroup`
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
      proc._noteLiveGroup(); // the hand-over: see `_noteLiveGroup`
      resolve(proc);
    });
  });
}
