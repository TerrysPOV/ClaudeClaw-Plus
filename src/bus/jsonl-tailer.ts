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
  extractToolResults,
  type AssistantLine,
  type AttachmentLine,
  type JsonlLine,
  type SystemLine,
  type ToolResultBlock,
  type UserLine,
} from "./jsonl-line-types";
import type { BusEvent, BusEventTopic } from "./types";

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
  /** Error sink. Defaults to console.error. */
  onError?: (err: unknown, ctx?: Record<string, unknown>) => void;
}

export class JsonlTailer {
  private readonly bus: BusCore;
  private readonly agent_id: string;
  private readonly session_id: string;
  private readonly cwd: string;
  private readonly projectsDir: string;
  private readonly schemaVersion: string;
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  private readonly filePath: string;

  private offset = 0;
  private buffer = "";
  /** Set true once the first non-empty line emits `session.init`. */
  private initEmitted = false;
  private watcher: FSWatcher | null = null;
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
    this.cwd = opts.cwd;
    this.projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
    this.schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
    this.onError = opts.onError ?? ((err, ctx) => console.error("[jsonl-tailer]", err, ctx));
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
      await this.drainFromOffset();
    }
    this.emitReplayDone();

    // Live tail. fs.watch on macOS is generally reliable for append-only
    // files in our scenarios; if we ever see drops on Linux network FS
    // we'll fall back to fs.watchFile polling. Spec §5.2 explicitly
    // allows either.
    try {
      this.watcher = watch(this.filePath, { persistent: false }, () => {
        this.scheduleDrain();
      });
      this.watcher.on("error", (err) => this.onError(err, { ctx: "fs-watch" }));
    } catch (err) {
      // ENOENT — file not yet created. Poll the parent dir minimally:
      // schedule a one-shot retry. In practice Session Manager has
      // already spawned `claude` and the file appears within ms.
      this.onError(err, { ctx: "watch-setup", path: this.filePath });
    }
  }

  /** Stop and release watchers. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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
  private dispatch(line: JsonlLine, raw: string): void {
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
    // Turn-boundary surfacing — when the API stops with `end_turn`, the
    // agent has signalled "I'm done with this turn". Emit a single event
    // carrying the concatenated text blocks of this turn so downstream
    // subscribers (silent-drop safety net in bus core) can detect the
    // pattern where the agent ended the turn with text but never called
    // the `reply` tool to deliver it to the user. `tool_use` stop_reason
    // means the agent intends to continue after a tool result, so we
    // don't emit on those.
    if (line.message?.stop_reason === "end_turn") {
      const turnText = blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("\n")
        .trim();
      this.publish(
        "response.turn_end",
        {
          stop_reason: "end_turn",
          text: turnText,
        },
        line,
      );
    }
    // Degraded-turn surfacing — §5.2 mentions `error` / `isApiErrorMessage` /
    // `apiErrorStatus` on assistant lines. Forward as `system.api_error`.
    if (line.error || line.isApiErrorMessage) {
      this.publish("system.api_error", { error: line.error, status: line.apiErrorStatus }, line);
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
      payload: metadata ? { ...(payload as object), _meta: metadata } : payload,
      raw: rawLine,
    };
    try {
      this.bus.ingestSessionEvent(event);
    } catch (err) {
      this.onError(err, { ctx: "publish", topic });
    }
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
      },
    };
    try {
      this.bus.ingestSessionEvent(event);
    } catch (err) {
      this.onError(err, { ctx: "replay-done" });
    }
  }
}
