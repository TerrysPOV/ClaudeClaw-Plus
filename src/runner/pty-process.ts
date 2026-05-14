/**
 * Single-PTY wrapper around one `claude` interactive process.
 *
 * Knows nothing about supervisors, sessions, or adapters. Stateless beyond
 * the PTY handle it owns. Implements the contract from SPEC §3.1 verbatim.
 *
 * OR-6 decision (newSessionId vs scrape):
 *   We use `--session-id <uuid>` for fresh spawns when `opts.newSessionId` is
 *   provided. The TUI does NOT print a session UUID at startup (verified
 *   against the v2.1.141 capture in turn-boundary-sample.txt — no
 *   UUID-shaped substring anywhere in the first 5530 bytes / pre-prompt
 *   region). Scraping would therefore require parsing a framed box ("/status"
 *   panel or similar) which is brittle and version-dependent. Pre-allocating
 *   the UUID via crypto.randomUUID() on the caller's side and passing it via
 *   `--session-id` is deterministic, supports persistence-before-first-turn,
 *   and avoids any TUI-dependent parsing for the session-ID path.
 *
 *   When neither sessionId nor newSessionId is provided, we spawn without
 *   any session flag — Claude allocates internally. PtyProcess.sessionId
 *   then remains an empty string until the supervisor (which knows the
 *   intended UUID, since it generated it) updates it. Callers that need the
 *   session ID before runTurn returns MUST pass newSessionId.
 */
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { SecurityConfig } from "../config";
import {
  createParser,
  feed,
  decodeTurn,
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
   * them from `security`. This is the canonical path — the supervisor passes
   * this to honour the operator's `permissionMode` and locked-mode Write tool
   * inclusion. (Phase D fix #3 for MAJOR-2/MAJOR-3.) */
  securityArgs?: string[];
  /**
   * Optional system prompt to append via `--append-system-prompt <text>`.
   * The supervisor assembles this from the same parts execClaude builds for
   * the legacy `claude -p` path (CLAUDE.md, MEMORY.md, agent IDENTITY.md /
   * SOUL.md, dir-scope guard, update-memory instruction). Without this flag
   * threaded through, named agents become naked Claude with no memory.
   * (Phase D fix #2 for CRITICAL-1.) */
  appendSystemPrompt?: string;
  /** Env vars to pass to the child. Caller is responsible for a sanitised env. */
  env: Record<string, string>;
  /** Initial PTY columns. Default 100. */
  cols?: number;
  /** Initial PTY rows. Default 30. */
  rows?: number;
  /** Idle-timeout safety net for runTurn. Default 5000ms. */
  turnIdleTimeoutMs?: number;
  /**
   * INTERNAL TEST HOOK: command path to spawn instead of `claude`.
   * Used by unit tests to substitute /bin/cat etc. NOT a public API and
   * not part of the SPEC contract. If unset, defaults to "claude".
   */
  _commandOverride?: string;
  /**
   * INTERNAL TEST HOOK: when true, do NOT append the standard claude flags
   * (security, --resume, --session-id, --model). Used for tests that spawn
   * non-claude binaries.
   */
  _skipClaudeArgs?: boolean;
  /**
   * INTERNAL TEST HOOK: alternative arg list to use instead of the
   * claude-args built from the options. Used in tests; not part of SPEC.
   */
  _argsOverride?: string[];
  /**
   * INTERNAL TEST HOOK: injectable clock for deterministic idle-timeout
   * tests. Returns ms-epoch like Date.now(). Default: Date.now.
   */
  _now?: () => number;
  /**
   * INTERNAL TEST HOOK: injectable setTimeout for deterministic idle-timeout
   * tests. Default: global setTimeout.
   */
  _setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * INTERNAL TEST HOOK: injectable clearTimeout. Default: global clearTimeout.
   */
  _clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * INTERNAL TEST HOOK: skip waiting for first OSC-end at spawn (some test
   * targets like /bin/cat never emit OSC sequences). Default false.
   */
  _skipReadySettle?: boolean;
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
    }
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
    public readonly elapsedMs: number
  ) {
    super(`PTY turn timed out for ${label} after ${elapsedMs}ms`);
    this.name = "PtyTurnTimeoutError";
  }
}

export class PtyClosedError extends Error {
  constructor(
    public readonly label: string,
    public readonly exitCode: number | null,
    public readonly signal: string | null
  ) {
    super(
      `PTY closed during turn for ${label} (exit=${exitCode} signal=${signal})`
    );
    this.name = "PtyClosedError";
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_TURN_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_PERMISSION_MODE_ARGS = ["--dangerously-skip-permissions"];

/** Build the argv for spawning `claude` based on options.
 *  When `opts.securityArgs` is provided (the canonical Phase D path), those
 *  flags are used verbatim — they come from runner.ts:`buildSecurityArgs`,
 *  which is the single source of truth for permission-mode + tool gating.
 *  Otherwise this falls back to a minimal local derivation kept for tests
 *  that exercise the security-config path directly. */
function buildClaudeArgs(opts: PtyProcessOptions): string[] {
  if (opts._argsOverride) return opts._argsOverride;
  if (opts._skipClaudeArgs) return [];

  const args: string[] = [];

  if (opts.securityArgs && opts.securityArgs.length > 0) {
    // Canonical path: trust runner.ts:buildSecurityArgs verbatim.
    args.push(...opts.securityArgs);
  } else {
    // Fallback: legacy local derivation. Note this branch is reached only
    // when callers (typically unit tests) skip the supervisor and pass a
    // bare PtyProcessOptions. The supervisor ALWAYS sets securityArgs.
    args.push(...DEFAULT_PERMISSION_MODE_ARGS);

    switch (opts.security.level) {
      case "locked":
        // Include Write so memory-persistence still works in locked mode —
        // matches runner.ts:buildSecurityArgs.
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

  // Phase D fix #2 (CRITICAL-1): append the assembled system-prompt payload
  // (CLAUDE.md, MEMORY.md, agent identity, dir-scope guard, etc.) so PTY-mode
  // agents have the same context as the legacy `claude -p` path. Interactive
  // claude accepts --append-system-prompt (verified via `claude --help`).
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  return args;
}

/**
 * Test-only re-export of `buildClaudeArgs`. NOT part of the SPEC §3.1 public
 * contract — exists so Phase D fixes #2 and #3 can pin the argv shape
 * deterministically (verifying `--append-system-prompt` is emitted, that
 * `securityArgs` is used verbatim, etc.).
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
  private readonly _now: () => number;
  private readonly _setTimeout: (
    cb: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (
    handle: ReturnType<typeof setTimeout>
  ) => void;

  /** Accumulated bytes for the in-flight turn, OR all bytes when no turn
   *  is in flight (kept so idle-fallback can produce a defensible response). */
  private _turnBuf: Uint8Array[] = [];
  private _turnBufLen = 0;
  private _parser: Parser;

  /** Last raw chunk arrival time, used for idle-timeout. */
  private _lastChunkAt = 0;
  /** Whether we are currently inside a runTurn call. */
  private _turnInProgress = false;
  /** Resolver for the current runTurn promise. */
  private _turnResolve:
    | ((result: PtyTurnResult) => void)
    | null = null;
  private _turnReject: ((err: Error) => void) | null = null;
  private _turnHardTimeoutHandle:
    | ReturnType<typeof setTimeout>
    | null = null;
  private _turnIdleTimerHandle:
    | ReturnType<typeof setTimeout>
    | null = null;
  private _turnStartedAt = 0;
  private _disposed = false;
  /** Listener disposables from bun-pty. */
  private _onDataDisposable: { dispose(): void } | null = null;
  private _onExitDisposable: { dispose(): void } | null = null;
  /** Optional callbacks from the current runTurn. */
  private _onChunk?: (text: string) => void;
  private _onToolEvent?: (line: string) => void;
  /** Decoder shared across chunks for onChunk emission (UTF-8 stream). */
  private _streamDecoder = new TextDecoder("utf-8");

  constructor(pty: IPty, opts: PtyProcessOptions) {
    this._pty = pty;
    this._pid = pty.pid;
    this._sessionId = (opts.sessionId && opts.sessionId.length > 0)
      ? opts.sessionId
      : (opts.newSessionId ?? "");
    this.cwd = opts.cwd;
    this.label = `${opts.agentName ?? "pty"}:${pty.pid}`;
    this._idleTimeoutMs = opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    this._now = opts._now ?? (() => Date.now());
    this._setTimeout = opts._setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout =
      opts._clearTimeout ?? ((h) => clearTimeout(h));
    this._parser = createParser();

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
    // We do this once per chunk; chunks are typically small (kb-scale).
    const bytes = new TextEncoder().encode(data);
    this._lastChunkAt = this._now();

    // Buffer for the current turn (so idle-fallback can return content).
    this._turnBuf.push(bytes);
    this._turnBufLen += bytes.length;

    const events = feed(this._parser, bytes);

    // onChunk streaming — opportunistic delta delivery. We strip ANSI
    // per-chunk; this is not perfect mid-multibyte but TextDecoder handles
    // UTF-8 streaming, so we keep the raw decode separate.
    if (this._turnInProgress && this._onChunk) {
      const decoded = this._streamDecoder.decode(bytes, { stream: true });
      // Strip ANSI inline so the callback sees plain text.
      const stripped = decoded
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
        .replace(/\x1b/g, "");
      if (stripped.length > 0) {
        try {
          this._onChunk(stripped);
        } catch {
          // Caller bug; never let it kill the PTY pipeline.
        }
      }
    }

    // onToolEvent — best-effort detection of `⏺ <ToolName>(<args>)` and
    // `  ⎿ <result>` lines. We don't try to be clever here; v1 emits them
    // as raw lines as they cross newlines.
    if (this._turnInProgress && this._onToolEvent) {
      const text = new TextDecoder().decode(bytes);
      const stripped = text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
        .replace(/\x1b/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "");
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

    // Reset idle timer on every chunk.
    if (this._turnInProgress) {
      this._resetIdleTimer();
    }

    // Did this chunk close out a turn?
    for (const ev of events) {
      if (ev.type === "turn-end" && this._turnInProgress) {
        this._completeTurn(true);
        return;
      }
    }
  }

  private _handleExit(info: { exitCode: number; signal?: number | string }): void {
    this._alive = false;
    // NOTE: Do NOT dispose listeners here. bun-pty's EventEmitter iterates
    // its listener array by index inside `fire()`, and disposing a listener
    // from within its own callback mutates the array under the iterator,
    // which causes subsequent listeners to be skipped (see
    // node_modules/bun-pty/src/interfaces.ts EventEmitter.fire). Disposal
    // happens lazily in `dispose()` once the process is gone.

    if (this._turnInProgress) {
      const err = new PtyClosedError(
        this.label,
        info.exitCode ?? null,
        info.signal != null ? String(info.signal) : null
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
    }
  ): Promise<PtyTurnResult> {
    if (this._disposed) {
      return Promise.reject(
        new PtyClosedError(this.label, null, null)
      );
    }
    if (!this._alive) {
      return Promise.reject(
        new PtyClosedError(this.label, null, null)
      );
    }
    if (this._turnInProgress) {
      return Promise.reject(
        new Error(
          `runTurn called concurrently on ${this.label}; supervisor must serialise`
        )
      );
    }

    this._turnInProgress = true;
    this._onChunk = opts.onChunk;
    this._onToolEvent = opts.onToolEvent;
    this._turnBuf = [];
    this._turnBufLen = 0;
    this._streamDecoder = new TextDecoder("utf-8");
    this._turnStartedAt = this._now();
    this._lastChunkAt = this._turnStartedAt;

    // Write prompt + CR (TUI submits on Enter).
    try {
      this._pty.write(prompt + "\r");
    } catch (err) {
      this._turnInProgress = false;
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err))
      );
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

      this._resetIdleTimer();
    });
  }

  /** Reset the idle-timeout countdown. Called on every chunk arrival. */
  private _resetIdleTimer(): void {
    if (this._turnIdleTimerHandle != null) {
      this._clearTimeout(this._turnIdleTimerHandle);
    }
    if (this._idleTimeoutMs <= 0) return;
    this._turnIdleTimerHandle = this._setTimeout(() => {
      // Idle-timeout fired: complete the turn with cleanBoundary=false.
      if (this._turnInProgress) {
        this._completeTurn(false);
      }
    }, this._idleTimeoutMs);
  }

  private _completeTurn(cleanBoundary: boolean): void {
    if (!this._turnInProgress) return;

    const bytes = concatBytes(this._turnBuf, this._turnBufLen);
    const { text } = decodeTurn(bytes);

    this._turnInProgress = false;
    this._lastTurnEndedAt = this._now();
    this._onChunk = undefined;
    this._onToolEvent = undefined;

    if (this._turnHardTimeoutHandle != null) {
      this._clearTimeout(this._turnHardTimeoutHandle);
      this._turnHardTimeoutHandle = null;
    }
    if (this._turnIdleTimerHandle != null) {
      this._clearTimeout(this._turnIdleTimerHandle);
      this._turnIdleTimerHandle = null;
    }

    const result: PtyTurnResult = {
      text,
      bytesCaptured: bytes.length,
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
    if (this._turnIdleTimerHandle != null) {
      this._clearTimeout(this._turnIdleTimerHandle);
      this._turnIdleTimerHandle = null;
    }
    const reject = this._turnReject;
    this._turnResolve = null;
    this._turnReject = null;
    if (reject) reject(err);
  }

  // ─── dispose ────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    // If a turn is in progress, reject it before killing.
    if (this._turnInProgress) {
      this._rejectTurn(new PtyClosedError(this.label, null, "SIGTERM"));
    }

    if (this._alive) {
      // Wait for exit (SIGTERM first, SIGKILL after 2s if needed).
      // We use a dedicated `_alive` watcher via the EXISTING onExit handler
      // (which flips `_alive` to false). Polling here is bounded by SIGKILL.
      const exited = new Promise<void>((resolve) => {
        if (!this._alive) {
          resolve();
          return;
        }
        // Add a fresh listener that resolves on exit. We do NOT dispose it
        // from within its own callback (see _handleExit note).
        const sub = this._pty.onExit(() => resolve());
        // Defensive: if exit somehow already happened in the gap, resolve.
        if (!this._alive) {
          resolve();
          try { sub.dispose(); } catch {}
        }
      });

      try {
        this._pty.kill("SIGTERM");
      } catch {
        // Already dead.
      }

      const killTimer = this._setTimeout(() => {
        try { this._pty.kill("SIGKILL"); } catch {}
      }, 2000);

      await exited;
      this._clearTimeout(killTimer);
    }

    // Now safe to clean up listeners — process is gone, no fire() in flight.
    try { this._onDataDisposable?.dispose(); } catch {}
    try { this._onExitDisposable?.dispose(); } catch {}
    this._onDataDisposable = null;
    this._onExitDisposable = null;
  }

  // ─── internal: used only by spawnPty to await TUI settle ─────────────

  /** Promise that resolves on the first OSC progress-END seen since spawn
   *  (the "TUI is settled" signal), OR after `timeoutMs` if no END arrives. */
  _waitForReadySettle(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      const timer = this._setTimeout(done, timeoutMs);

      // Patch _handleData to also resolve once the parser sees the first END.
      const originalHandler = this._handleData.bind(this);
      this._handleData = (data: string) => {
        originalHandler(data);
        // After original handler runs, check if the parser flipped working
        // (it won't have, but the START/END markers reset its state) — we
        // resolve once we've seen the first progress-END marker, which
        // corresponds to the TUI's init paint completion.
        // The parser ignores pre-turn ENDs while working===false, so we
        // can't observe them via events; we look at totalBytes/markers via
        // a probe on the raw bytes here.
        if (data.includes("\x1b]9;4;0;\x07")) {
          done();
          this._clearTimeout(timer);
        }
      };
    });
  }
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
 * Spawn one Claude interactive PTY and wait for the TUI to settle (initial
 * render complete = first `]9;4;0;` OR 3 seconds, whichever sooner).
 *
 * On success, returns a ready-to-use PtyProcess. On failure (claude binary
 * missing, immediate crash), rejects with a descriptive Error.
 *
 * Caller is responsible for resolving cwd, sanitising env, and providing a
 * valid sessionId or newSessionId.
 *
 * This function does NOT touch session storage — persisting the session ID
 * is the supervisor's job after runTurn resolves and PtyProcess.sessionId
 * is populated.
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
          `Failed to spawn PTY for ${cmd}: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

    const proc = new PtyProcessImpl(pty, opts);

    // If a test target has no concept of TUI settle, skip the wait entirely.
    if (opts._skipReadySettle) {
      resolve(proc);
      return;
    }

    // Wait up to 3s for the TUI to paint, OR the first progress-END marker.
    proc._waitForReadySettle(3000).then(() => {
      if (!proc.isAlive()) {
        reject(
          new Error(
            `PTY for ${cmd} exited before TUI settled (pid=${pty.pid})`
          )
        );
        return;
      }
      resolve(proc);
    });
  });
}
