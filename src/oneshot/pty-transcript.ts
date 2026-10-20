import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Transcript lag behind the rendered screen is milliseconds; this only bounds a stuck turn. */
export const TRANSCRIPT_WAIT_MS = 15_000;
const POLL_MS = 100;
const SETTLE_MS = 300;

interface TranscriptBlock {
  type?: unknown;
  text?: unknown;
}
interface TranscriptEntry {
  type?: unknown;
  isApiErrorMessage?: unknown;
  message?: { id?: unknown; model?: unknown; content?: unknown };
}

function transcriptFiles(projectDir: string): string[] {
  // Never throws (scanTranscript's contract): a directory that vanishes or cannot be
  // listed between the existence check and the read supplies no evidence.
  try {
    if (!existsSync(projectDir)) return [];
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(projectDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** The model's own text blocks, or undefined for user, synthetic and API-error entries. */
function replyText(entry: TranscriptEntry): string | undefined {
  if (entry.type !== "assistant" || entry.isApiErrorMessage === true) return undefined;
  if (entry.message?.model === "<synthetic>") return undefined;
  if (!Array.isArray(entry.message?.content)) return undefined;
  const text = (entry.message.content as TranscriptBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text === "" ? undefined : text;
}

/** A synthetic or API-error assistant entry: the CLI's own failure record, not a model reply. */
function isFailureEntry(entry: TranscriptEntry): boolean {
  return (
    entry.type === "assistant" &&
    (entry.isApiErrorMessage === true || entry.message?.model === "<synthetic>")
  );
}

export interface TranscriptScan {
  /** Text of the last real assistant message, if any. */
  reply?: string;
  /**
   * The last assistant record is a synthetic or API-error entry. A failure that a later
   * real reply followed (the CLI retried) does not count; a real reply with a failure
   * AFTER it does: the turn did not end well, so the reply is not a success.
   */
  failed: boolean;
}

/**
 * Scan the transcripts under `projectDir`. One API message can span several entries
 * (thinking, then text); entries sharing the last reply's `message.id` are joined.
 * A partial trailing line is skipped. Never throws: an unreadable file supplies no evidence.
 */
export function scanTranscript(projectDir: string): TranscriptScan {
  const replies: Array<{ id: string | undefined; text: string }> = [];
  let failed = false;
  for (const file of transcriptFiles(projectDir)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (isFailureEntry(entry)) failed = true;
        const text = replyText(entry);
        if (text === undefined) continue;
        failed = false; // a real reply after an earlier failure: the CLI recovered
        const id = entry.message?.id;
        replies.push({ id: typeof id === "string" ? id : undefined, text });
      } catch {
        /* partial trailing line */
      }
    }
  }
  const last = replies.at(-1);
  if (!last) return { failed };
  if (last.id === undefined) return { reply: last.text, failed };
  return {
    reply: replies
      .filter((reply) => reply.id === last.id)
      .map((reply) => reply.text)
      .join(""),
    failed,
  };
}

/** Text of the last real assistant message under `projectDir`, if any. */
export function readLastAssistantReply(projectDir: string): string | undefined {
  return scanTranscript(projectDir).reply;
}

/**
 * How long the transcript wait may take: what is left of the caller's `timeoutMs` after
 * the turn, capped at `capMs`, never below a small floor so a turn that used its whole
 * budget still gets one look at a transcript that is about to land.
 */
export const TRANSCRIPT_WAIT_FLOOR_MS = 1_000;
export function transcriptWaitBudget(
  timeoutMs: number,
  elapsedMs: number,
  capMs = TRANSCRIPT_WAIT_MS,
): number {
  return Math.min(capMs, Math.max(TRANSCRIPT_WAIT_FLOOR_MS, timeoutMs - elapsedMs));
}

export interface AwaitReplyOptions {
  waitMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
  /** Injectable clock and sleep, so latency is testable without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AwaitReplyResult {
  text?: string;
  /**
   * Why there is no text: the CLI ended the turn on a failure record, nothing appeared in
   * time, or the caller aborted.
   */
  failure?: "api-error" | "timeout" | "aborted";
}

/**
 * Poll for the reply until it appears or `waitMs` passes, then settle briefly and
 * re-read so a text entry written just after the first is not missed. If the transcript
 * already ends on a synthetic or API-error entry, the turn has failed and waiting longer
 * cannot help: return at once, even when a real reply came first. The caller must never
 * substitute screen text for a missing reply.
 */
export async function awaitLastAssistantReply(
  projectDir: string,
  options: AwaitReplyOptions = {},
): Promise<AwaitReplyResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (options.waitMs ?? TRANSCRIPT_WAIT_MS);
  for (;;) {
    const scan = scanTranscript(projectDir);
    if (scan.failed) return { failure: "api-error" };
    if (scan.reply !== undefined) break;
    if (options.signal?.aborted) return { failure: "aborted" };
    if (now() >= deadline) return { failure: "timeout" };
    await sleep(POLL_MS);
  }
  await sleep(options.settleMs ?? SETTLE_MS);
  // Re-read after the settle: an error record that landed just after the reply still fails it.
  const settled = scanTranscript(projectDir);
  if (settled.failed) return { failure: "api-error" };
  return settled.reply === undefined ? { failure: "timeout" } : { text: settled.reply };
}
