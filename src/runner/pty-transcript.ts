/**
 * The session transcript as the proof of a PTY turn (#562, rounds 2 to 5).
 *
 * The TUI's screen is a poor witness: a prompt that was never submitted, a repaint of
 * the old conversation and a prompt echoed into the input box all paint the same chrome
 * a running turn does. The transcript (`<config>/projects/<enc-cwd>/<session-id>.jsonl`)
 * is written by the CLI itself, not by the renderer, and the bus path already trusts it
 * (`src/bus/jsonl-tailer.ts`). This module reads it for ONE turn, and its verdict is one
 * of three: still running, finished OK (an answer) or finished FAILED (an error text):
 *
 *   - ACCEPTED: a record appended after the send shows the CLI took this prompt: a
 *     `queue-operation` `enqueue`, or a top-level `user` entry, whose payload IS this
 *     turn's prompt (`promptMatches`: the whole payload, not a substring). Only bytes
 *     appended AFTER the send are read, so an earlier entry (or an earlier identical
 *     prompt) can never satisfy it.
 *   - ANSWER: the text of the FINAL assistant message of that turn, as the print path's
 *     `result` is: the blocks of that one message join as-is. Narration between tool calls
 *     ("Let me look.") is not the answer. A final message with no text (a turn that ends on
 *     a tool-only message) leaves the last message that has text.
 *   - ENDED OK: a message of that turn carries a terminal `stop_reason`
 *     (`isTerminalStopReason`, the bus's own rule) AND the transcript shows an AUTHORITATIVE
 *     boundary after it: the CLI's `turn_duration` record, or the next real user prompt (not
 *     meta, not a tool result, not a compact summary, not a command's own output). Nothing
 *     else ends a turn: not a quiet file (the CLI can pause between the blocks of one
 *     message, and a timer cannot tell that from the end), and not a progress, hook,
 *     attachment or other bookkeeping record, which neither close the message nor cut it
 *     short: lines of the same message id after them still extend the answer. With no
 *     boundary the turn does not end; at the caller's timeout it is UNCERTAIN (`finalSeen`),
 *     never a success and never replayed.
 *   - ENDED FAILED: the CLI wrote an API-error line (`isApiErrorMessage` / `error`), a
 *     `local-command-stderr`, or something that makes the attribution uncertain (a second
 *     identical prompt, another prompt inside the turn), or the reply has no text at all
 *     (`empty-reply`). Error records are read FIRST, before any boundary decision: an API
 *     error anywhere after the final message and before the boundary fails the turn. A
 *     failed turn has no answer.
 *   - NOT EVIDENCE: a non-error `<synthetic>` placeholder ("No response requested.") is
 *     written BEFORE the real reply starts. It is neither text nor an end (the bus
 *     tailer makes the same distinction).
 *   - `/compact`: matched by its `<command-name>` user entry; ended by the
 *     `compact_boundary` system entry (or the `local_command` entry carrying its error).
 *
 * A turn is a WINDOW in the file: it opens at the matched `user` entry and closes at the
 * authoritative boundary. A later prompt (and whatever answers it) is never read into this
 * turn, whichever poll it arrives in.
 *
 * Late records: a turn that ends in anything but a proven OK may still have run, its
 * record arriving late from a process that is still writing. This module keeps no memory
 * of that. The supervisor does not let it arise: it kills the process and waits for its
 * exit before returning the error, and the next turn resumes the same session in a NEW
 * process (`pty-supervisor.ts`, `retireEntry`). Nothing that could write a late record for
 * the failed turn is alive when a later turn marks its offset, so the exact payload match
 * needs no per-submission identity (the transcript has none we could correlate: `uuid` /
 * `promptId` are assigned by the CLI after the submit).
 *
 * The file must stay the file `mark()` saw: a cut-short, replaced or removed transcript
 * fails the turn (`TranscriptReplacedError`) instead of re-reading retained history as
 * new evidence.
 *
 * Correlation: the matched entry's `uuid` / `promptId` identify "the same record", so a
 * line the CLI repeats is not mistaken for a second prompt. The `parentUuid` chain is NOT
 * used to attribute assistant lines: any other prompt inside the window already fails the
 * turn, and rejecting an unrecognised parent would turn a chain shape this code has not
 * seen into a hang.
 *
 * Pure apart from reading one file; no bus, no PTY. Callers poll.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types";
import { isTerminalStopReason } from "../bus/jsonl-tailer";

/** Cap on bytes read per poll, so one huge append cannot stall the event loop. */
const MAX_READ_PER_POLL = 4 * 1024 * 1024;

/** The failure text of a turn whose reply has no text (`TurnFailure.kind` `empty-reply`). */
export const EMPTY_REPLY_TEXT = "empty reply in transcript";

/** Why a turn with an id-less assistant line fails as `ambiguous` (`TurnFailure.text`). */
export const ID_LESS_TEXT =
  "an assistant line has no message id, so which lines make up the final message is uncertain";

/** Why a turn whose assistant messages interleave fails as `ambiguous` (`TurnFailure.text`). */
export const INTERLEAVED_TEXT =
  "assistant lines of different messages are interleaved, so which message answers this turn is uncertain";

/** `message.model` on assistant lines the CLI writes itself (API errors, placeholders). */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Where the CLI writes the transcript of `sessionId` run in `cwd`, or null when it
 * cannot be known: no session id, or an untrusted one-shot (`--no-session-persistence`).
 * There is no switch to turn this off: without a transcript a turn cannot succeed.
 *
 * The cwd is realpath'd because the CLI encodes the physical directory it was started in
 * (`/tmp` is `/private/tmp` on macOS), as the bus's session manager does.
 */
export function resolveTranscriptPath(opts: {
  cwd: string;
  sessionId: string;
  env: Record<string, string | undefined>;
  untrusted?: boolean;
}): string | null {
  if (opts.untrusted || !opts.sessionId) return null;
  const configDir = opts.env.CLAUDE_CONFIG_DIR || join(opts.env.HOME || homedir(), ".claude");
  let physicalCwd = opts.cwd;
  try {
    physicalCwd = realpathSync(opts.cwd);
  } catch {
    // The CLI would have failed to start in a missing directory; keep the logical path.
  }
  return join(
    configDir,
    "projects",
    encodeCwdForProjectsDir(physicalCwd),
    `${opts.sessionId}.jsonl`,
  );
}

/**
 * The CLI's own wrapper around a pasted prompt, when it is the WHOLE payload:
 * `<pasted_content id="..">..</pasted_content id="..">`. Only this outer wrapper is taken
 * off; a literal tag inside the text is the prompt's own.
 */
const OUTER_PASTE_WRAPPER = /^<pasted_content\b[^>]*>([\s\S]*)<\/pasted_content\b[^>]*>$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the transcript may have recorded of a user entry: the payload as is, then without an outer paste wrapper. */
function payloadForms(text: string): string[] {
  const raw = text.normalize("NFC").trim();
  const inner = OUTER_PASTE_WRAPPER.exec(raw)?.[1]?.trim();
  return inner === undefined ? [raw] : [raw, inner];
}

/** The `<command-name>` of a slash command the CLI recorded, or null. */
function commandNameOf(text: string): string | null {
  return /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1] ?? null;
}

/**
 * Whether the transcript's `entryText` IS the prompt we wrote: the whole payload, after the
 * CLI's paste wrapper and the whitespace around it are taken off, compared for equality.
 * Not containment and not whitespace-insensitive: `check status` is not `hourly check
 * status and restart failures`, and `a b` is not `ab`.
 *
 * The one disagreement between the wire and the transcript is a TAB. `sanitizePtyPromptText`
 * keeps it, but the TUI takes a typed 0x09 as a completion key (recorded as nothing) and a
 * pasted one as spaces (#362, #239). So a TAB in `written` may be recorded as nothing or as
 * a run of spaces, at that position only; every other character must be there as written.
 * An empty write matches nothing.
 */
export function promptMatches(entryText: string, written: string, replCommand: boolean): boolean {
  if (replCommand) {
    const name = commandNameOf(entryText);
    return name !== null && name === written.trim().split(/\s+/)[0];
  }
  const want = written.normalize("NFC").trim();
  if (want === "") return false;
  const tabbed = want.includes("\t")
    ? new RegExp(`^${want.split("\t").map(escapeRegExp).join(" *")}$`, "u")
    : null;
  // The payload as recorded comes first: a prompt that itself contains paste tags matches
  // as it is, and only a recognised OUTER wrapper is looked through.
  return payloadForms(entryText).some((got) => got === want || tabbed?.test(got) === true);
}

/** The text of a top-level user entry, or null for tool results and other array content. */
function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as Array<{ type?: string; text?: unknown }>;
  if (blocks.some((b) => b?.type === "tool_result")) return null;
  const texts = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return texts.length > 0 ? texts.join("\n") : null;
}

/** `<local-command-stdout>x</local-command-stdout>` → `x`. */
function stripCommandTags(text: string): string {
  return text.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();
}

const hasStderrTag = (text: string): boolean => text.includes("<local-command-stderr>");

/** Why a finished turn is NOT a success. */
export type TurnFailureKind = "api-error" | "command-error" | "ambiguous" | "empty-reply";

export interface TurnFailure {
  kind: TurnFailureKind;
  /** The CLI's own error text, or (ambiguous) what made the attribution uncertain. */
  text: string;
}

export interface TranscriptTurnState {
  /** The CLI took this prompt: an `enqueue` or the `user` entry for it was appended. */
  accepted: boolean;
  /** The turn is over, successfully or not (`failure` says which). */
  ended: boolean;
  /** Set when the turn ended in failure. A failed turn has no answer to return. */
  failure: TurnFailure | null;
  /** The final assistant message's text (the last one that has any); `/compact`'s result for a command. */
  answer: string;
  /**
   * A message of this turn carries a terminal `stop_reason`, but no authoritative boundary
   * (`turn_duration` or the next real prompt) has followed yet. A turn still in this state
   * at the caller's timeout is UNCERTAIN: the reply may be incomplete.
   */
  finalSeen: boolean;
  /** Top-level user entries appended after the send that were NOT this prompt. */
  foreignUserEntries: number;
  /** One line per tool call the assistant made this turn, in order (`● Name(input)`). */
  toolLines: readonly string[];
}

export interface TranscriptTurnOptions {
  path: string;
  /** Exactly what was written to the PTY (after sanitising / neutralising). */
  written: string;
  /** The turn is a deliberate `/compact`. */
  replCommand?: boolean;
}

/**
 * The transcript was cut short, replaced or removed after `mark()`. What is in the file
 * now may be a copy of history this turn already ruled out, so it is not read: the turn
 * fails (and the prompt may have run, so the caller must not resubmit).
 */
export class TranscriptReplacedError extends Error {
  constructor(
    public readonly path: string,
    public readonly why: string,
  ) {
    super(`session transcript ${path} ${why} during the turn`);
    this.name = "TranscriptReplacedError";
  }
}

/** A file's identity: the same path with a different one is a different file. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** Where the turn's window is. `terminal` = the final message was seen; `closed` = done. */
type Phase = "seeking" | "open" | "terminal" | "closed";

export class TranscriptTurn {
  private readonly path: string;
  private readonly written: string;
  private readonly replCommand: boolean;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private identity: FileIdentity | null = null;
  private phase: Phase = "seeking";
  private enqueued = false;
  private ended = false;
  private failure: TurnFailure | null = null;
  private foreign = 0;
  private toolLines: string[] = [];
  /**
   * This turn's assistant messages in order, WITH or without text; the blocks of one message
   * share an id. The last one is the final message, so a final message with no text is an
   * empty answer and never leaves an earlier message's text standing in for it.
   */
  private messages: Array<{ id: string | undefined; text: string }> = [];
  /** A non-synthetic assistant line carried no message id: it cannot be attributed. */
  private idlessSeen = false;
  private assistantLines = 0;
  private finalMessageId: string | undefined;
  /** Every message id seen on an assistant line, ignored ones included. */
  private seenIds = new Set<string>();
  /** The id of the previous assistant line (ignored ones included). */
  private lastLineId: string | undefined;
  private matchedUuid: string | undefined;
  private matchedPromptId: string | undefined;
  private commandResult = "";

  constructor(opts: TranscriptTurnOptions) {
    this.path = opts.path;
    this.written = opts.written;
    this.replCommand = opts.replCommand === true;
  }

  /** Call BEFORE the prompt is written: only what is appended after this counts. */
  mark(): void {
    const stat = this.stat();
    this.identity = stat ? { dev: stat.dev, ino: stat.ino } : null;
    this.offset = stat ? Number(stat.size) : 0;
    this.carry = Buffer.alloc(0);
  }

  /** How far into the file this turn has read. */
  readOffset(): number {
    return this.offset;
  }

  /**
   * Read what was appended since the last poll and fold it into the turn state. A turn that
   * has closed reads nothing more. Throws `TranscriptReplacedError` when the file is no
   * longer the one `mark()` saw.
   */
  poll(): TranscriptTurnState {
    if (this.phase === "closed") return this.state();
    const stat = this.stat();
    if (this.identity !== null) {
      if (stat === null) throw new TranscriptReplacedError(this.path, "was removed");
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
        throw new TranscriptReplacedError(this.path, "was replaced by a different file");
      }
      if (Number(stat.size) < this.offset) {
        throw new TranscriptReplacedError(this.path, "was cut short");
      }
    } else if (stat !== null) {
      // Absent at mark(): the CLI created it since, so everything in it is new.
      this.identity = { dev: stat.dev, ino: stat.ino };
    }
    const size = stat ? Number(stat.size) : 0;
    if (size > this.offset) this.ingestBytes(this.readFrom(this.offset, size));
    return this.state();
  }

  state(): TranscriptTurnState {
    return {
      accepted: this.enqueued || this.phase !== "seeking",
      ended: this.ended,
      failure: this.failure,
      answer: this.failure ? "" : this.replCommand ? this.commandResult : this.answerText(),
      finalSeen: this.phase === "terminal",
      foreignUserEntries: this.foreign,
      toolLines: this.toolLines,
    };
  }

  /**
   * The text of the final message, whether or not it has any: the message whose line carried
   * the terminal stop reason (all its blocks, found by id), else the last message to appear.
   * A final message with no text (tool-only, thinking-only) is an empty answer: the message
   * before it is narration, not the reply (#562 round 6).
   */
  private answerText(): string {
    const final =
      this.finalMessageId !== undefined
        ? this.messages.find((m) => m.id === this.finalMessageId)
        : undefined;
    return (final ?? this.messages[this.messages.length - 1])?.text ?? "";
  }

  private stat(): { dev: bigint; ino: bigint; size: bigint } | null {
    try {
      return statSync(this.path, { bigint: true });
    } catch {
      return null;
    }
  }

  private readFrom(from: number, to: number): Buffer {
    const want = Math.min(to - from, MAX_READ_PER_POLL);
    const buf = Buffer.alloc(want);
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return Buffer.alloc(0);
    }
    try {
      const n = readSync(fd, buf, 0, want, from);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  private ingestBytes(bytes: Buffer): void {
    this.offset += bytes.length;
    let data = this.carry.length === 0 ? bytes : Buffer.concat([this.carry, bytes]);
    for (;;) {
      // A closed window reads nothing further: whatever follows belongs to another turn.
      if (this.phase === "closed") {
        this.carry = Buffer.alloc(0);
        return;
      }
      const nl = data.indexOf(0x0a);
      if (nl < 0) break;
      const line = data.subarray(0, nl).toString("utf8").trim();
      data = data.subarray(nl + 1);
      if (line === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A torn or foreign line is not evidence of anything.
      }
      if (entry && typeof entry === "object") this.ingest(entry as Record<string, unknown>);
    }
    this.carry = Buffer.from(data);
  }

  private ingest(entry: Record<string, unknown>): void {
    if (entry.isSidechain === true) return; // a sub-agent's, not this session's turn
    switch (this.phase) {
      case "seeking":
        this.ingestSeeking(entry);
        return;
      case "open":
      case "terminal":
        this.ingestInTurn(entry);
        return;
      case "closed":
        return;
    }
  }

  /** Before the matched prompt: look for it. Nothing else here is this turn's. */
  private ingestSeeking(entry: Record<string, unknown>): void {
    if (entry.type === "queue-operation") {
      if (
        !this.enqueued &&
        entry.operation === "enqueue" &&
        typeof entry.content === "string" &&
        promptMatches(entry.content, this.written, this.replCommand)
      ) {
        this.enqueued = true;
      }
      return;
    }
    if (entry.type !== "user" || entry.isCompactSummary === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return;
    if (promptMatches(text, this.written, this.replCommand)) {
      this.phase = "open";
      this.matchedUuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
      this.matchedPromptId = typeof entry.promptId === "string" ? entry.promptId : undefined;
    } else {
      this.foreign++;
    }
  }

  /**
   * Inside the turn, before and after the final message. Error records are read FIRST: an
   * API error or a command's stderr anywhere in the window fails the turn, whatever else
   * the record would have done. Only then does a record count as an assistant line, bookkeeping
   * (ignored) or the turn's boundary.
   */
  private ingestInTurn(entry: Record<string, unknown>): void {
    switch (entry.type) {
      case "assistant":
        this.ingestAssistant(entry);
        return;
      case "user":
        this.ingestUserInTurn(entry);
        return;
      case "system":
        this.ingestSystem(entry);
        return;
      default:
        // progress, hook, attachment, queue-operation, snapshots: bookkeeping. They neither
        // close the final message nor cut it short.
        return;
    }
  }

  private ingestUserInTurn(entry: Record<string, unknown>): void {
    if (entry.isCompactSummary === true || entry.isMeta === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return; // a tool result: the turn's own
    if (hasStderrTag(text)) {
      this.fail("command-error", stripCommandTags(text));
      return;
    }
    // A command's own output is recorded as a user entry too; it is not a prompt.
    if (text.includes("<local-command-stdout>") || this.isSameRecord(entry)) return;
    const matches = promptMatches(text, this.written, this.replCommand);
    if (this.phase === "terminal" && !matches) {
      // The next real prompt: the authoritative end of this turn (boundary b).
      this.finish();
      return;
    }
    // Another prompt inside this turn (or this one a second time): whose answer is this?
    this.fail(
      "ambiguous",
      matches
        ? this.phase === "terminal"
          ? "the same prompt was recorded a second time after the reply"
          : "the same prompt was recorded a second time inside the turn"
        : "another prompt was recorded inside the turn",
    );
  }

  /** Whether `entry` is the very record we matched (the CLI can repeat a line). */
  private isSameRecord(entry: Record<string, unknown>): boolean {
    if (this.matchedUuid !== undefined && entry.uuid === this.matchedUuid) return true;
    return this.matchedPromptId !== undefined && entry.promptId === this.matchedPromptId;
  }

  private ingestAssistant(entry: Record<string, unknown>): void {
    const message = entry.message as
      | { id?: string; model?: string; content?: unknown; stop_reason?: unknown }
      | undefined;
    const content = message?.content;
    const blocks = Array.isArray(content)
      ? (content as Array<{ type?: string; text?: unknown }>)
      : [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (entry.isApiErrorMessage === true || entry.error) {
      // The CLI writes its own error lines as synthetic assistant messages: the turn is
      // over, and it did not produce a reply (the bus publishes it as `system.api_error`).
      // Before or after the final message alike: an error before the boundary is never a
      // success. Read on every assistant record whatever its shape, `message` absent
      // included (#562 round 6): the flags come first, nothing may return ahead of them.
      this.fail("api-error", text !== "" ? text : entry.error ? String(entry.error) : "API error");
      return;
    }
    if (!message) return;
    // A command's answer is its own output (`compact_boundary` / `local_command`), so the
    // assistant's ordinary text is not read for it; its error flags above still are.
    if (this.replCommand) return;
    // A placeholder ("No response requested.") is written BEFORE the real reply starts:
    // neither text nor an end.
    if (message.model === SYNTHETIC_MODEL) return;
    // After the final message only its own remaining lines extend the answer. A message
    // with another id (a background-task notification can start a reply of its own) is not
    // this turn's: it is neither appended nor a boundary. The turn still waits for one.
    if (this.phase === "terminal" && message.id === undefined) {
      // No id to say whether this line is another message or the rest of the final one.
      this.fail("ambiguous", ID_LESS_TEXT);
      return;
    }
    // One message's lines are not interleaved with another's. A, B, A means a message began,
    // another ran, and the first went on: the lines cannot be placed in one reply or the
    // other (a background-task reply starting inside the turn looks like this), so there is
    // no answer to name. Every line counts, the ignored ones too. (#562 round 7)
    if (message.id !== undefined) {
      if (message.id !== this.lastLineId && this.seenIds.has(message.id)) {
        this.fail("ambiguous", INTERLEAVED_TEXT);
        return;
      }
      this.seenIds.add(message.id);
    }
    this.lastLineId = message.id;
    if (this.phase === "terminal" && message.id !== this.finalMessageId) return;
    // Identity is what makes up the final message. A line with no id beside any other
    // assistant line of the turn cannot be placed in one message or another, and a partial
    // answer is worse than none: fail as uncertain (never a success, never replayed).
    this.assistantLines++;
    if (message.id === undefined) this.idlessSeen = true;
    if (this.idlessSeen && this.assistantLines > 1) {
      this.fail("ambiguous", ID_LESS_TEXT);
      return;
    }
    this.addAssistantLine(message.id, text, blocks);
    if (this.phase === "open" && isTerminalStopReason(message.stop_reason)) {
      // The final message is out, whether or not it has text (a thinking block is its own
      // line, and a tool-only or empty one has none). The turn ENDS only at an authoritative
      // boundary (`turn_duration`, the next real prompt), never on the first line with text
      // and never because the file went quiet.
      this.phase = "terminal";
      this.finalMessageId = message.id;
    }
  }

  private addAssistantLine(
    id: string | undefined,
    text: string,
    blocks: Array<{ type?: string; name?: string; input?: unknown }>,
  ): void {
    for (const b of blocks) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = JSON.stringify(b.input ?? {});
        this.toolLines.push(
          `● ${b.name}(${input.length > 120 ? `${input.slice(0, 120)}…` : input})`,
        );
      }
    }
    // Each content block is its own line; blocks of one message share its id and belong
    // together wherever they sit in the window (found by id, not only when adjacent). A
    // different id is another message of the same turn. A line without text still opens
    // (or joins) its message: that is how a textless final message is seen.
    const known = id !== undefined ? this.messages.find((m) => m.id === id) : undefined;
    if (known) known.text += text;
    else this.messages.push({ id, text });
  }

  private ingestSystem(entry: Record<string, unknown>): void {
    const subtype = entry.subtype;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (hasStderrTag(content)) {
      this.fail("command-error", stripCommandTags(content));
      return;
    }
    if (this.replCommand) {
      if (subtype === "compact_boundary" || subtype === "local_command") {
        const result = stripCommandTags(content);
        if (result !== "" || subtype === "compact_boundary") this.commandResult = result;
        this.finish();
      }
      return;
    }
    // The CLI's own record that the turn is over (boundary a). Every other system record is
    // bookkeeping.
    if (subtype === "turn_duration") this.finish();
  }

  /** The turn's authoritative boundary was seen. A reply with no text at all is not a success. */
  private finish(): void {
    if (!this.replCommand && this.answerText().trim() === "") {
      this.fail("empty-reply", EMPTY_REPLY_TEXT);
      return;
    }
    this.ended = true;
    this.phase = "closed";
  }

  private fail(kind: TurnFailureKind, text: string): void {
    this.failure = { kind, text };
    this.ended = true;
    this.phase = "closed";
  }
}
