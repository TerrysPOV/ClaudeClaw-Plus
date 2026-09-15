/**
 * JSONL Tailer — read path for the ClaudeClaw+ Bus runtime.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.2
 * Spikes:
 *   - 0.2 (`docs/spikes/0.2-jsonl-schema-snapshot.md`) — line-type table
 *   - 0.5 (`docs/spikes/0.5-lifecycle-markers.md`) — lifecycle inference
 *
 * Responsibilities:
 *   - Tail a single agent's `~/.claude/projects/<enc-cwd>/<session-id>.jsonl`.
 *   - On start(), replay from byte 0 (historical events flagged via the
 *     `bus.events.replay_done` marker emitted afterwards). Then live-tail.
 *   - Dispatch each JSONL line to one or more `BusEvent`s via
 *     `bus.ingestSessionEvent`.
 *
 * Non-responsibilities (per spec §5.2 + Spike 0.5):
 *   - Detecting `/clear` rotation — Session Manager owns the project-dir
 *     watcher. The Tailer is one session_id wide.
 *   - Emitting `session.end` — Session Manager observes process exit.
 *   - Realpath'ing the cwd — Session Manager has already done it.
 *   - Inferring `session.init` lifecycle outside this Tailer's file —
 *     emitted ONCE here when first non-empty line lands in a
 *     previously-empty file (§5.2 lifecycle table).
 */

import { type FSWatcher, watch, statSync, existsSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BusCore } from "./core";
import {
  BUS_CRITICAL_ATTACHMENT_SUBTYPES,
  encodeCwdForProjectsDir,
  type PromptIngestion,
  extractToolResults,
  type AssistantLine,
  type AttachmentLine,
  type JsonlLine,
  type SystemLine,
  type ToolResultBlock,
  type UserLine,
} from "./jsonl-line-types";
import { type BusEvent, type BusEventTopic, TAILER_EVENT_SOURCE } from "./types";

/**
 * Parser schema version. Bump whenever line-type handling changes in a
 * way the schema-probe harness (Sprint 2 Agent B) must re-validate.
 * Format: `MAJOR.MINOR.PATCH-sprint-N`.
 */
export const SCHEMA_VERSION = "1.0.0-sprint-2";

/**
 * Dispatch table for line types whose handling is just "rename `type`
 * to a Bus topic and pass through one or two fields". Anything that
 * needs to walk content arrays or fan out to multiple topics lives in
 * its own method.
 */
const SIMPLE_DISPATCH: Record<
  string,
  { topic: BusEventTopic; extract: (line: Record<string, unknown>) => unknown }
> = {
  "permission-mode": {
    topic: "session.permission_mode_change",
    extract: (l) => ({ permissionMode: l.permissionMode, sessionId: l.sessionId }),
  },
  "file-history-snapshot": {
    topic: "session.file_snapshot",
    extract: (l) => l,
  },
  "ai-title": {
    topic: "session.title",
    extract: (l) => ({ title: l.aiTitle }),
  },
  "agent-name": {
    topic: "session.agent_name",
    extract: (l) => ({ agentName: l.agentName }),
  },
  "custom-title": {
    topic: "session.custom_title",
    extract: (l) => l,
  },
  "pr-link": {
    topic: "session.pr_link",
    extract: (l) => l,
  },
  "last-prompt": {
    topic: "session.last_prompt",
    extract: (l) => ({ lastPrompt: l.lastPrompt }),
  },
  "queue-operation": {
    topic: "session.queue",
    extract: (l) => l,
  },
};

export type { PromptIngestion };

export interface JsonlTailerOptions {
  bus: BusCore;
  agent_id: string;
  session_id: string;
  /** Resolved cwd — Session Manager has already realpath'd this. */
  cwd: string;
  /**
   * Override the projects dir root. Defaults to `<homedir>/.claude/projects`.
   * Tests pass a temp dir.
   */
  projectsDir?: string;
  /** Surfaced via schema-probe cache (Sprint 2 Agent B). */
  schemaVersion?: string;
  /**
   * Which tailer this is for the agent, in order of construction (the session
   * manager counts per agent). Carried on `bus.events.replay_done` and
   * `session.compact` so bus core can tell a marker from a replaced tailer's
   * last reads apart from the live one — the transcript's `session_id` cannot
   * serve: it is the stable Claude UUID and survives a `--resume` restart
   * (#402). Omitted (tests, other wiring) → the bus treats ordering as unknown.
   */
  generation?: number;
  /**
   * Where to begin tailing when the session file already exists.
   * `"begin"` (default) replays from byte 0 — used by tests and any
   * consumer that wants historical events. `"end"` seeks to EOF and
   * live-tails new lines only — used by the runtime wiring (issue #215)
   * so a resumed session never re-emits historical `response.turn_end`
   * events (which could synthesize a stale reply).
   */
  startAt?: "begin" | "end";
  /** Error sink. Defaults to console.error. */
  onError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  /**
   * Called when the transcript records that the CLI actually ingested a
   * top-level user prompt (issue #362). This is the only delivery signal that
   * originates outside the terminal rendering: on the PTY surface "the CLI
   * submitted my text" and "the CLI repainted something" are the same bytes,
   * so every screen heuristic can be fooled by a post-compaction repaint.
   * The session manager wires this to the agent's `notePromptIngested`.
   */
  onPromptIngested?: (ingestion: PromptIngestion) => void;
  /**
   * Called once, on the first line this tailer actually reads (issue #362).
   *
   * Being constructed is NOT evidence that a transcript is readable: the path
   * is derived from the cwd encoding, and a mismatch there leaves the tailer
   * pointed at a file that never appears — silently, since a missing session
   * file is a normal startup state. Anything that hardens behaviour on the
   * assumption that the transcript will speak must key off this, not off the
   * wiring, or it degrades every agent whose transcript is unreachable.
   */
  onTranscriptAlive?: () => void;
}

/** `message.model` on assistant lines the CLI writes itself (errors, placeholders). */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Stop reasons after which the CLI continues the same turn: `tool_use` (the
 * model resumes after the tool result) and `pause_turn` (a server-tool turn
 * the client resumes by sending the response back). Neither is a boundary.
 */
const CONTINUING_STOP_REASONS: ReadonlySet<string> = new Set(["tool_use", "pause_turn"]);

/**
 * A `stop_reason` that ends the turn. A `null`/`undefined` reason is a
 * content-block line still streaming, and {@link CONTINUING_STOP_REASONS}
 * resume the turn. Everything else the API can return (`end_turn`,
 * `max_tokens`, `stop_sequence`, `refusal`, …) is terminal for the transcript:
 * the CLI writes no further assistant line for that turn (#401). Observed live
 * so far: `tool_use`, `end_turn`, `stop_sequence`.
 */
export function isTerminalStopReason(stopReason: unknown): stopReason is string {
  return (
    typeof stopReason === "string" &&
    stopReason.length > 0 &&
    !CONTINUING_STOP_REASONS.has(stopReason)
  );
}

export class JsonlTailer {
  private readonly bus: BusCore;
  private readonly agent_id: string;
  private readonly session_id: string;
  private readonly generation: number | undefined;
  private readonly cwd: string;
  private readonly projectsDir: string;
  private readonly schemaVersion: string;
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  private readonly onPromptIngested?: (ingestion: PromptIngestion) => void;
  private readonly onTranscriptAlive?: () => void;
  private sawAnyLine = false;
  private readonly filePath: string;
  private readonly startAt: "begin" | "end";

  private offset = 0;
  /**
   * Set when the startup seek-to-EOF (`startAt: "end"`) could not `statSync`
   * the file (transient perm flip / NFS hiccup / rotation). While true, the
   * next `drainFromOffset` re-seeks to current EOF instead of reading from
   * offset 0 — otherwise it would replay the entire history and synthesize a
   * stale reply, the exact failure `startAt: "end"` exists to prevent
   * (#217 review).
   */
  private seekToEndPending = false;
  private buffer = "";
  /** Set true once the first non-empty line emits `session.init`. */
  private initEmitted = false;
  private watcher: FSWatcher | null = null;
  /** Set while polling for a not-yet-created session file. Cleared by stop(). */
  private createPollTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  /**
   * Serialises live-tail reads so an `fs.watch` storm can't trigger
   * overlapping reads from the same offset (which would double-emit).
   */
  private readGate: Promise<void> = Promise.resolve();

  constructor(opts: JsonlTailerOptions) {
    this.bus = opts.bus;
    this.agent_id = opts.agent_id;
    this.session_id = opts.session_id;
    this.generation = opts.generation;
    this.cwd = opts.cwd;
    this.projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
    this.schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
    this.onError = opts.onError ?? ((err, ctx) => console.error("[jsonl-tailer]", err, ctx));
    this.startAt = opts.startAt ?? "begin";
    this.onPromptIngested = opts.onPromptIngested;
    this.onTranscriptAlive = opts.onTranscriptAlive;
    this.filePath = join(
      this.projectsDir,
      encodeCwdForProjectsDir(this.cwd),
      `${this.session_id}.jsonl`,
    );
  }

  /** Resolved JSONL path. Useful for tests + diagnostics. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Start tailing. Performs initial replay from byte 0 → emits
   * `bus.events.replay_done` → begins live tail. Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Initial replay. If the file doesn't exist yet that's fine — we
    // emit the replay-done marker (with offset=0) and the live-tail
    // path picks up the first byte when it appears.
    if (existsSync(this.filePath)) {
      if (this.startAt === "end") {
        // Issue #215 runtime wiring: live-tail NEW turns only. Replaying
        // from byte 0 on a resumed session would re-emit historical
        // `response.turn_end` events and, with a prompt in flight, could
        // synthesize a stale reply. Seek to EOF and watch forward.
        try {
          this.offset = statSync(this.filePath).size;
        } catch (err) {
          this.onError(err, { ctx: "start-eof-stat" });
          // Couldn't establish EOF. Do NOT let the follow-up drain read from
          // offset 0 — that replays the whole history and synthesizes a stale
          // reply. Defer the seek: the next drainFromOffset re-seeks to the
          // then-current EOF and tails forward (#217 review).
          this.seekToEndPending = true;
        }
      } else {
        await this.drainFromOffset();
      }
      this.emitReplayDone();
      this.attachFileWatcher();
      // Close the startup TOCTOU on the existing-file path (review #217).
      // `fs.watch` only fires on changes AFTER it attaches, so bytes written
      // in the window between the `statSync` seek-to-EOF above and
      // `attachFileWatcher()` are not delivered by the watcher and stay unread
      // until the NEXT write triggers `scheduleDrain`. If those missed bytes
      // contain an `end_turn` line and the agent then goes idle — the exact
      // pattern this safety net exists to recover — synthesis is delayed
      // indefinitely. Schedule a follow-up drain to sweep the gap immediately,
      // mirroring what `awaitFileCreation` already does after its attach.
      this.scheduleDrain();
      return;
    }

    // File not created yet. A fresh agent session has claude write the
    // JSONL lazily (on the first turn), so at spawn time the path — and
    // even its parent dir — may not exist. Emit replay-done at offset 0,
    // then poll for the file's appearance and attach. Without this the
    // tailer is inert for every fresh session (issue #215 runtime wiring:
    // the common case — the original code only logged the ENOENT from
    // `watch()` and gave up, so no events ever flowed in production).
    this.emitReplayDone();
    this.awaitFileCreation();
  }

  /** Attach the live fs.watch to an already-existing session file. */
  private attachFileWatcher(): void {
    if (this.stopped || this.watcher) return;
    try {
      this.watcher = watch(this.filePath, { persistent: false }, () => {
        this.scheduleDrain();
      });
      this.watcher.on("error", (err) => this.onError(err, { ctx: "fs-watch" }));
    } catch (err) {
      this.onError(err, { ctx: "watch-setup", path: this.filePath });
    }
  }

  /**
   * Poll (unref'd) until the session file appears, then attach the watcher
   * and drain whatever has been written. A brand-new file has offset 0 ==
   * EOF, so `startAt: "end"` and `"begin"` coincide for it. Cleared by stop().
   */
  private awaitFileCreation(): void {
    const poll = (): void => {
      if (this.stopped) return;
      if (existsSync(this.filePath)) {
        // File appeared — the await-creation poll is done; clear its handle so
        // the tailer's state isn't misleading and stop() doesn't clear a stale
        // timer (Copilot review #217).
        this.createPollTimer = null;
        this.attachFileWatcher();
        this.scheduleDrain();
        return;
      }
      this.createPollTimer = setTimeout(poll, 150);
      this.createPollTimer.unref?.();
    };
    poll();
  }

  /** Stop and release watchers. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.createPollTimer) {
      clearTimeout(this.createPollTimer);
      this.createPollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Let any in-flight read settle before returning so callers know
    // there are no more publishes coming on this Tailer.
    await this.readGate.catch(() => undefined);
  }

  /* ──────────────────────────── replay + drain ──────────────────────────── */

  private scheduleDrain(): void {
    // Chain onto readGate to serialise reads.
    this.readGate = this.readGate
      .catch(() => undefined)
      .then(() => this.drainFromOffset())
      .catch((err) => this.onError(err, { ctx: "live-drain" }));
  }

  /**
   * Read all bytes from `this.offset` to EOF, split on `\n`, parse and
   * dispatch each line. Updates `this.offset` to current EOF.
   */
  private async drainFromOffset(): Promise<void> {
    if (this.stopped) return;
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch (err) {
      // File missing or unreadable; surface and bail. Live watcher will
      // re-fire when bytes appear (or won't, if the file truly never
      // gets created — that's a higher-layer concern).
      this.onError(err, { ctx: "drain-stat" });
      return;
    }
    if (this.seekToEndPending) {
      // Startup seek-to-EOF was deferred because the initial statSync failed.
      // Establish EOF now and tail forward — a startAt:"end" tailer must never
      // replay history (#217 review).
      this.offset = size;
      this.seekToEndPending = false;
      return;
    }
    if (size <= this.offset) return;

    let fh: FileHandle | null = null;
    try {
      fh = await open(this.filePath, "r");
      const length = size - this.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, this.offset);
      this.offset = size;
      this.buffer += buf.toString("utf8");
      this.flushBufferedLines();
    } catch (err) {
      this.onError(err, { ctx: "drain-read" });
    } finally {
      if (fh) await fh.close().catch(() => undefined);
    }
  }

  private flushBufferedLines(): void {
    let nl: number;
    // Note: we keep any trailing partial line in `this.buffer` for the
    // next drain — JSONL writers can append a line in multiple syscalls.
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic newline scan
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (raw.length === 0) continue;
      this.handleRawLine(raw);
    }
  }

  private handleRawLine(raw: string): void {
    let line: JsonlLine;
    try {
      line = JSON.parse(raw) as JsonlLine;
    } catch (err) {
      this.onError(err, { ctx: "json-parse", raw });
      return;
    }

    // First non-empty line in the file emits `session.init` once
    // (§5.2 lifecycle table). We treat ANY parseable line as
    // "non-empty" — the queue-operation line that often appears first
    // still counts as "session has started writing".
    if (!this.initEmitted) {
      this.initEmitted = true;
      this.publish("session.init", { schema_version: this.schemaVersion }, line);
    }

    this.dispatch(line, raw);
  }

  /* ──────────────────────────── dispatch ──────────────────────────── */

  /**
   * Route a parsed JSONL line to topic-specific publishers. The
   * "simple" types (single field extraction) are handled via the
   * `SIMPLE_DISPATCH` table to keep this method small.
   */
  /**
   * Issue #363 — a queued prompt's acceptance, reported the moment the CLI
   * takes the keystrokes rather than when it gets round to running them. The
   * line is already dispatched to `session.queue` via SIMPLE_DISPATCH; this is
   * an additional consumer of the same record, not new parsing.
   *
   * `operation` takes other values too (`"dequeue"` / `"remove"` depending on
   * CLI version), so the test is positive rather than a blocklist.
   */
  private notifyEnqueue(line: Record<string, unknown>): void {
    if (!this.onPromptIngested) return;
    // Only `enqueue`. A `dequeue` is NOT the queue giving the prompt back — the
    // fixtures in `docs/spikes/fixtures/jsonl/` show it firing 1 ms after the
    // enqueue and 13 ms before the `user` line of a normal delivery, i.e. the
    // queue handing the prompt to the runner. A round of review read it as a
    // cancellation and this forwarded it as one; every delivery it touched
    // would have been un-confirmed. Positive test, so any other operation a
    // future CLI adds is ignored rather than guessed at.
    if (line.operation !== "enqueue") return;
    const content = line.content;
    if (typeof content !== "string") return;
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    try {
      this.onPromptIngested({
        text: content,
        source: "enqueue",
        ingestedAtMs: Number.isFinite(ts) ? ts : 0,
      });
    } catch (err) {
      this.onError(err, { where: "onPromptIngested(enqueue)", agent_id: this.agent_id });
    }
  }

  private dispatch(line: JsonlLine, raw: string): void {
    if (!this.sawAnyLine) {
      this.sawAnyLine = true;
      try {
        this.onTranscriptAlive?.();
      } catch (err) {
        this.onError(err, { where: "onTranscriptAlive", agent_id: this.agent_id });
      }
    }
    switch (line.type) {
      case "user":
        this.dispatchUser(line as UserLine, raw);
        return;
      case "assistant":
        this.dispatchAssistant(line as AssistantLine);
        return;
      case "attachment":
        this.dispatchAttachment(line as AttachmentLine);
        return;
      case "system":
        this.dispatchSystem(line as SystemLine);
        return;
      default: {
        if (line.type === "queue-operation") {
          this.notifyEnqueue(line as unknown as Record<string, unknown>);
        }
        const simple = SIMPLE_DISPATCH[line.type];
        if (simple) {
          this.publish(simple.topic, simple.extract(line as Record<string, unknown>), line);
          return;
        }
        // Forward-compat per §11.1 — unknown line types surface as
        // `bus.event.unknown` so the schema probe + dashboards can
        // alert without the daemon crashing.
        this.publish("bus.event.unknown", { raw, type: line.type }, line);
      }
    }
  }

  private dispatchUser(line: UserLine, raw: string): void {
    const content = line.message?.content;
    if (typeof content === "string") {
      // Top-level user prompt. This correlates with what Bus MCP
      // pushed in via `notifications/claude/channel` (§5.2).
      this.publish(
        "prompt",
        {
          text: content,
          permissionMode: line.permissionMode,
          promptId: line.promptId,
        },
        line,
      );
      // Issue #362: the transcript writing this line IS the CLI acknowledging
      // it ingested the prompt, which is what the PTY delivery-confirm loop
      // has no way to observe. Notify out-of-band so a failure in a consumer
      // cannot take down the tail — the publish above is the contract, this is
      // a side-channel.
      // Sub-agent prompts and harness meta lines are recorded the same way but
      // are not this process's delivery. Excluded at the source so no consumer
      // has to know the distinction.
      if (
        this.onPromptIngested &&
        line.isSidechain !== true &&
        !(line as { isMeta?: boolean }).isMeta
      ) {
        const ts = line.timestamp ? Date.parse(line.timestamp) : Number.NaN;
        try {
          this.onPromptIngested({
            text: content,
            source: "user",
            promptId: line.promptId,
            ingestedAtMs: Number.isFinite(ts) ? ts : 0,
          });
        } catch (err) {
          this.onError(err, { where: "onPromptIngested", agent_id: this.agent_id });
        }
      }
      return;
    }
    if (Array.isArray(content)) {
      // tool_result blocks live inside user messages — §5.2 + Spike 0.2.
      // Mirrors `src/runner.ts` tool_result extraction inside `onToolEvent`
      // (the `if (block.type === 'tool_result')` loop — search by name as
      // line numbers drift).
      const results = extractToolResults(content);
      if (results.length === 0) {
        // Array content with no tool_results — unusual but observed
        // when claude carries other block types here. Forward-compat:
        // emit unknown so we don't drop silently.
        this.publish("bus.event.unknown", { raw, type: "user.array-no-tool-result" }, line);
        return;
      }
      for (const block of results) {
        this.publishToolResult(block, line);
      }
    }
  }

  private publishToolResult(block: ToolResultBlock, line: UserLine): void {
    // Per Spike 0.2 finding 6 — `tool_result.content` is string OR
    // array. Surface BOTH shapes through the payload (consumers
    // doing string ops MUST use the helper); we keep `contentRaw` so
    // image-bearing results aren't lossy.
    const isString = typeof block.content === "string";
    this.publish(
      "tool_result",
      {
        tool_use_id: block.tool_use_id,
        content: isString ? (block.content as string) : null,
        contentRaw: block.content,
        contentIsString: isString,
        is_error: block.is_error ?? false,
      },
      line,
    );
  }

  private dispatchAssistant(line: AssistantLine): void {
    const blocks = line.message?.content ?? [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          this.publish("response.text", { text: (block as { text?: string }).text ?? "" }, line);
          break;
        case "tool_use":
          this.publish(
            "response.tool_use",
            {
              id: (block as { id?: string }).id,
              name: (block as { name?: string }).name,
              input: (block as { input?: unknown }).input,
            },
            line,
          );
          break;
        case "thinking":
          this.publish(
            "response.thinking",
            { thinking: (block as { thinking?: string }).thinking ?? "" },
            line,
          );
          break;
        default:
          // Unknown content block — keep going. The line still carries
          // a usage block which we want to emit, so don't return early.
          this.publish(
            "bus.event.unknown",
            { reason: "assistant-block", blockType: block.type, block },
            line,
          );
      }
    }
    if (line.message?.usage) {
      this.publish("usage", line.message.usage, line);
    }
    // Degraded-turn surfacing — §5.2 mentions `error` / `isApiErrorMessage` /
    // `apiErrorStatus` on assistant lines. Forward as `system.api_error`.
    // Published BEFORE the turn boundary below: bus core releases the
    // operation slot on `response.turn_end`, and the error is the one event a
    // client most needs stamped with the failed prompt's `promise_id` (#401).
    if (line.error || line.isApiErrorMessage) {
      this.publish("system.api_error", { error: line.error, status: line.apiErrorStatus }, line);
    }
    // Turn-boundary surfacing — when the API stops for any terminal reason
    // (`end_turn`, but also `max_tokens`, `stop_sequence`, `refusal`, …) the
    // turn is over: the CLI writes no further assistant line for it and the
    // next line is the next prompt. Emit a single event carrying the real
    // `stop_reason` and the concatenated text blocks of this turn so
    // downstream subscribers (silent-drop safety net in bus core, the
    // `agentTurnActive` flag, the operation slot, the reconciler) all see the
    // terminator. `tool_use`/`pause_turn` mean the turn resumes after the
    // tool result, and a missing/null stop_reason is a partial line still
    // streaming, so none of those is a turn boundary (#401 — previously only
    // `end_turn` was surfaced, and a turn stopping on any other reason left
    // `agentTurnActive` set until the next clean turn).
    //
    // Synthetic lines (`model: "<synthetic>"`) are written by the CLI, not the
    // API, and all stop with `stop_sequence`. Two kinds, both observed live:
    //  - an API error ("Prompt is too long …", "You've hit your session limit …",
    //    `isApiErrorMessage: true`): the turn IS over — surface the boundary so
    //    the flag and the operation slot release, but with empty text, so the
    //    #215 net neither nudges an agent that cannot answer nor ships the raw
    //    error string as a reply (the error is already published as
    //    `system.api_error` above);
    //  - a placeholder ("No response requested.", no error) that the CLI writes
    //    for an SDK-enqueued prompt BEFORE that prompt's real turn starts: not a
    //    boundary at all — emitting one would nudge the agent and free the slot
    //    while the real turn is about to begin, so it is skipped as before.
    const stopReason = line.message?.stop_reason;
    const synthetic = line.message?.model === SYNTHETIC_MODEL;
    const apiError = Boolean(line.error || line.isApiErrorMessage);
    if (isTerminalStopReason(stopReason) && (!synthetic || apiError)) {
      const turnText = synthetic
        ? ""
        : blocks
            .filter((b) => b.type === "text")
            .map((b) => (b as { text?: string }).text ?? "")
            .join("\n")
            .trim();
      // The CLI writes one line per content block and repeats the message's
      // stop_reason on every line, so a thinking+text message yields TWO
      // boundary lines for one turn. Each is still published (the text line is
      // the one the #215 net needs), tagged with the message id so bus core
      // releases the operation slot once per message, not once per line (#405).
      this.publish(
        "response.turn_end",
        {
          stop_reason: stopReason,
          text: turnText,
          message_id: line.message?.id,
          ...(synthetic ? { synthetic: true } : {}),
        },
        line,
      );
    }
  }

  private dispatchAttachment(line: AttachmentLine): void {
    const subtype = line.attachment?.type;
    if (!subtype) {
      this.publish("bus.event.unknown", { reason: "attachment-no-subtype" }, line);
      return;
    }
    // §5.2 — emit `attachment.<subtype>` for every variant; unknown
    // subtypes still go through (forward-compat). We don't gate on
    // `BUS_CRITICAL_ATTACHMENT_SUBTYPES` — that set is for downstream
    // filtering, not for dropping events here.
    const topic = `attachment.${subtype}` as BusEventTopic;
    this.publish(topic, line.attachment, line, {
      bus_critical: BUS_CRITICAL_ATTACHMENT_SUBTYPES.has(subtype),
    });
  }

  private dispatchSystem(line: SystemLine): void {
    const subtype = line.subtype;
    if (!subtype) {
      this.publish("bus.event.unknown", { reason: "system-no-subtype" }, line);
      return;
    }
    const topic = `system.${subtype}` as BusEventTopic;
    this.publish(topic, line, line);
    // Spike 0.5: compact_boundary maps 1:1 to session.compact. We emit
    // BOTH so subscribers wanting raw system events still see them,
    // and adapters subscribing to the stable `session.compact` topic
    // don't have to know about the JSONL detail.
    if (subtype === "compact_boundary") {
      const m = line.compactMetadata ?? {};
      this.publish(
        "session.compact",
        {
          trigger: m.trigger,
          preTokens: m.preTokens,
          postTokens: m.postTokens,
          durationMs: m.durationMs,
          ...(this.generation !== undefined ? { generation: this.generation } : {}),
        },
        line,
      );
    }
  }

  /* ──────────────────────────── publish ──────────────────────────── */

  private publish(
    topic: BusEventTopic,
    payload: unknown,
    rawLine?: unknown,
    metadata?: Record<string, unknown>,
  ): void {
    const tsField = (rawLine as { timestamp?: string } | undefined)?.timestamp;
    const ts = tsField ? Date.parse(tsField) || Date.now() : Date.now();
    const sessionFromLine = (rawLine as { sessionId?: string } | undefined)?.sessionId;
    const event: BusEvent = {
      ts,
      agent_id: this.agent_id,
      session_id: sessionFromLine ?? this.session_id,
      topic,
      // Stamp the tailer source marker (#217) into `_meta` so delivery
      // adapters can tell this observability echo apart from a real
      // `ingestReply` delivery (otherwise every reply double-posts).
      // Merge with any caller-supplied metadata. Only object (non-array)
      // payloads carry `_meta`; primitive/array payloads are never
      // adapter-deliverable, so leave them untouched.
      payload: this.withTailerMeta(payload, metadata),
      raw: rawLine,
    };
    try {
      this.bus.ingestSessionEvent(event);
    } catch (err) {
      this.onError(err, { ctx: "publish", topic });
    }
  }

  /**
   * Merge the tailer source marker (#217) — and any caller metadata —
   * into an object payload's `_meta`. Primitive/array payloads are
   * returned unchanged (they are never adapter-deliverable, so they
   * don't need the marker, and spreading them would be lossy).
   */
  private withTailerMeta(payload: unknown, metadata?: Record<string, unknown>): unknown {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return payload;
    }
    return {
      ...(payload as object),
      _meta: { ...metadata, source: TAILER_EVENT_SOURCE },
    };
  }

  private emitReplayDone(): void {
    const event: BusEvent = {
      ts: Date.now(),
      agent_id: this.agent_id,
      session_id: this.session_id,
      topic: "bus.events.replay_done",
      payload: {
        offset: this.offset,
        schema_version: this.schemaVersion,
        path: this.filePath,
        ...(this.generation !== undefined ? { generation: this.generation } : {}),
      },
    };
    try {
      this.bus.ingestSessionEvent(event);
    } catch (err) {
      this.onError(err, { ctx: "replay-done" });
    }
  }
}
