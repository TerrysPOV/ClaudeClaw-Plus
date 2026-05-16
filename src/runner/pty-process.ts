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
 *   without any session flag and Claude allocates internally.
 */
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { SecurityConfig } from "../config";
import {
  createParser,
  decodeTurn,
  encodeSentinel,
  feed,
  buildSentinel,
  markSentinelWritten,
  resetTurn,
  startTurn,
  tick,
  type Parser,
} from "./pty-output-parser";

// ─── Public types (FROZEN per SPEC §3.1) ────────────────────────────────────

export interface PtyProcessOptions {
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

export interface PtyProcess {
  readonly label: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  lastTurnEndedAt(): number;
  runTurn(
    prompt: string,
    opts: {
      timeoutMs: number;
      onChunk?: (text: string) => void;
      onToolEvent?: (line: string) => void;
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

const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_QUIET_WINDOW_MS = 500;
const DEFAULT_SENTINEL_MAX_WAIT_MS = 30_000;
const DEFAULT_QUIET_TICK_MS = 50;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_PERMISSION_MODE_ARGS = ["--dangerously-skip-permissions"];

/** Build the argv for spawning `claude` based on options. See header. */
function buildClaudeArgs(opts: PtyProcessOptions): string[] {
  if (opts._argsOverride) return opts._argsOverride;
  if (opts._skipClaudeArgs) return [];

  const args: string[] = [];

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

  const model = (opts.modelOverride ?? "").trim();
  if (model.length > 0 && model.toLowerCase() !== "glm") {
    args.push("--model", model);
  }

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
  private readonly _idleTimeoutMs: number;
  private readonly _quietWindowMs: number;
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

  constructor(pty: IPty, opts: PtyProcessOptions) {
    this._pty = pty;
    this._pid = pty.pid;
    this._sessionId =
      opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : (opts.newSessionId ?? "");
    this.cwd = opts.cwd;
    this.label = `${opts.agentName ?? "pty"}:${pty.pid}`;
    this._idleTimeoutMs = opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    this._quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    this._sentinelMaxWaitMs = opts.sentinelMaxWaitMs ?? DEFAULT_SENTINEL_MAX_WAIT_MS;
    this._now = opts._now ?? (() => Date.now());
    this._setTimeout = opts._setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout = opts._clearTimeout ?? ((h) => clearTimeout(h));
    this._setInterval = opts._setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this._clearInterval = opts._clearInterval ?? ((h) => clearInterval(h));
    this._sentinelUuidGen = opts._sentinelUuidOverride ?? (() => crypto.randomUUID());
    this._parser = createParser({ quietWindowMs: this._quietWindowMs });

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

  // ─── data flow ────────────────────────────────────────────────────────

  private _handleData(data: string): void {
    // bun-pty delivers strings; re-encode for the byte-level parser.
    const bytes = new TextEncoder().encode(data);
    const now = this._now();
    if (this._firstDataAt === 0) this._firstDataAt = now;

    // Buffer for the current turn (so idle-fallback can return content).
    this._turnBuf.push(bytes);
    this._turnBufLen += bytes.length;

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
    // NOTE: Do NOT dispose listeners here. bun-pty's EventEmitter iterates
    // its listener array by index inside `fire()`, and disposing a listener
    // from within its own callback mutates the array under the iterator,
    // which causes subsequent listeners to be skipped.

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

    // Write prompt + CR (TUI submits on Enter).
    try {
      this._pty.write(prompt + "\r");
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
        this._completeTurn(false, this._turnBufLen);
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

    try {
      this._onDataDisposable?.dispose();
    } catch {}
    try {
      this._onExitDisposable?.dispose();
    } catch {}
    this._onDataDisposable = null;
    this._onExitDisposable = null;
  }

  // ─── internal: used only by spawnPty to await TUI settle ─────────────

  /**
   * Resolve once the TUI shows signs of life — either the first chunk of
   * data has arrived OR `timeoutMs` has elapsed. Without OSC 9;4 markers
   * we can't distinguish "TUI fully painted" from "TUI starting paint", so
   * we use first-byte arrival as a lightweight readiness proxy.
   */
  _waitForReadySettle(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      if (this._firstDataAt > 0) {
        // Data already arrived before this was called.
        done();
        return;
      }

      const timer = this._setTimeout(done, timeoutMs);
      // Patch _handleData to resolve on first byte.
      const originalHandler = this._handleData.bind(this);
      this._handleData = (data: string) => {
        originalHandler(data);
        if (this._firstDataAt > 0) {
          this._clearTimeout(timer);
          done();
        }
      };
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
      pty = ptySpawn(cmd, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: opts.cwd,
        env: opts.env,
      });
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
        reject(new Error(`PTY for ${cmd} exited before TUI settled (pid=${pty.pid})`));
        return;
      }
      resolve(proc);
    });
  });
}
