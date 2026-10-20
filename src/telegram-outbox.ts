/**
 * Durable retry for outbound Telegram messages.
 *
 * A proactive message (cron job result, heartbeat, operator alert) that fails
 * to send used to be logged and dropped: nothing ever tried again. Typical
 * causes are transient (network outage, 5xx, a 429 flood window) or fixed by
 * the user later (403/400 "chat not found" until the user presses /start).
 *
 * This module keeps the chunks that were NOT delivered in a small JSON file
 * and re-sends them on a backoff of 2, 4, 8, 16, 32 minutes (or Telegram's
 * `retry_after`, whichever is longer). Six attempts in total, the first one
 * being the original send; after that the entry is dropped with one log line.
 *
 * Chunks already delivered are not re-sent: the file is rewritten after each
 * delivered chunk, so a restart resumes at the first undelivered one. Delivery
 * is at-least-once: a chunk is sent twice only if the process dies between a
 * send and that write, or the write itself fails (logged).
 *
 * A 400 that rejects the text itself (too long, empty) is abandoned at once.
 *
 * Quiet hours (#512): a message marked `proactive` that is produced inside the
 * user's quiet window is held — queued with its next attempt at the window's
 * end, no send made, no attempt counted. A proactive entry that comes due while
 * a window is open (a retry, or a daemon that was down across the end) is
 * pushed to the end of that window. Unmarked messages are never held.
 *
 * Revoked recipients (#525): a message routed to a chat only because a user
 * wrote there last carries that user's id (`userId`). The drain asks the
 * recipient check before each send; a user no longer allowed loses the entry,
 * with one log line, instead of receiving output held or retried after their
 * removal. Entries without `userId` (configured chats, files written before
 * the field existed) are delivered as before.
 *
 * Single owner: one instance per file per process ({@link getTelegramOutbox}),
 * and only the process that owns the bot token drains it (the daemon). Both
 * Telegram runtimes register their sender on the same instance; whichever is
 * active last is the one that drains.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** One Telegram message (<= 4096 chars). `plain` is the fallback for a malformed-HTML chunk. */
export interface OutboxChunk {
  text: string;
  parseMode?: "HTML";
  plain?: string;
}

export interface OutboxEntry {
  id: string;
  chatId: number;
  threadId?: number;
  label?: string;
  /** Undelivered chunks, in order. Delivered chunks are removed. */
  chunks: OutboxChunk[];
  /** Send attempts made so far, the original send included. */
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  firstFailedAt: number;
  /** Subject to quiet hours (#512): an unprompted message, never a reply. */
  proactive?: true;
  /** Epoch ms the entry was first held by quiet hours, for the delivery log. */
  heldAt?: number;
  /** User whose message made `chatId` the target; re-checked before each send (#525). */
  userId?: number;
}

export interface OutboxMessage {
  chatId: number;
  threadId?: number;
  label?: string;
  chunks: OutboxChunk[];
  /** See {@link OutboxEntry.userId}. */
  userId?: number;
}

/** Sends one chunk; must throw on failure (message carrying the HTTP status / description). */
export type OutboxSender = (chatId: number, chunk: OutboxChunk, threadId?: number) => Promise<void>;

/** False when `userId` may no longer receive messages (live allow-list, #525). */
export type RecipientCheck = (userId: number) => boolean;

type Logger = Pick<Console, "info" | "warn" | "error">;

/** Epoch ms at which the current quiet window ends, or `null` when not quiet. */
export type QuietUntil = (now: number) => number | null;

export interface OutboxDeliverOptions {
  /** Unprompted message (job result, alert…): held during quiet hours. */
  proactive?: boolean;
}

export const OUTBOX_MAX_ATTEMPTS = 6;
export const OUTBOX_MAX_ENTRIES = 200;
export const OUTBOX_DRAIN_INTERVAL_MS = 60_000;
/** First drain after start: lets the network settle, and a short-lived start/stop never drains. */
export const OUTBOX_FIRST_DRAIN_DELAY_MS = 5_000;
/** Chunks kept per message (~200 KB of text); the rest is dropped with a log line. */
export const OUTBOX_MAX_CHUNKS = 50;
/** A send that has not settled by then counts as failed, so one hung request cannot stall the queue. */
export const OUTBOX_SEND_TIMEOUT_MS = 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_ERROR_LEN = 300;

export function defaultOutboxPath(): string {
  return join(process.cwd(), ".claude", "claudeclaw", "retry", "telegram-outbox.json");
}

/** Delay after the `attempts`-th failure: 2, 4, 8, 16, 32 min for attempts 1..5. */
export function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** Math.max(1, attempts);
}

/** Telegram's flood window, from either runtime's error text. 0 when absent. */
export function retryAfterMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /retry_after (\d+)s/.exec(msg) ?? /flood cooldown, (\d+)s remaining/.exec(msg);
  return m ? Number(m[1]) * 1000 : 0;
}

/**
 * Errors no retry can fix: the text itself is rejected. "chat not found" and
 * 403 are NOT here — they clear once the user presses /start.
 */
export function isPermanentSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    / 400\b/.test(msg) &&
    /message is too long|text must be non-empty|message text is empty/i.test(msg)
  );
}

/** Error text for the file and the logs: bounded, and never carrying a bot token. */
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>").slice(0, MAX_ERROR_LEN);
}

function isEntry(v: unknown): v is OutboxEntry {
  const e = v as OutboxEntry;
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.chatId === "number" &&
    Array.isArray(e.chunks) &&
    e.chunks.every((c) => c && typeof c.text === "string") &&
    typeof e.attempts === "number" &&
    typeof e.nextAttemptAt === "number" &&
    (e.userId === undefined || Number.isInteger(e.userId))
  );
}

export interface TelegramOutboxOptions {
  path: string;
  send: OutboxSender;
  now?: () => number;
  maxAttempts?: number;
  maxEntries?: number;
  sendTimeoutMs?: number;
  logger?: Logger;
  quietUntil?: QuietUntil | null;
}

export class TelegramOutbox {
  readonly path: string;
  private send: OutboxSender;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly maxEntries: number;
  private readonly sendTimeoutMs: number;
  private readonly logger: Logger;
  private entries: OutboxEntry[];
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstDrain: ReturnType<typeof setTimeout> | null = null;
  private quietUntil: QuietUntil | null;
  private recipientAllowed: RecipientCheck | null = null;

  constructor(opts: TelegramOutboxOptions) {
    this.path = opts.path;
    this.send = opts.send;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.maxEntries = opts.maxEntries ?? OUTBOX_MAX_ENTRIES;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? OUTBOX_SEND_TIMEOUT_MS;
    this.logger = opts.logger ?? console;
    this.quietUntil = opts.quietUntil ?? null;
    this.entries = this.load();
  }

  setSender(send: OutboxSender): void {
    this.send = send;
  }

  /** Re-check of an entry's `userId` before each send; `null` sends every entry. */
  setRecipientCheck(check: RecipientCheck | null): void {
    this.recipientAllowed = check;
  }

  /** Quiet hours for proactive messages; `null` turns holding off. */
  setQuietHours(quietUntil: QuietUntil | null): void {
    this.quietUntil = quietUntil;
  }

  /** Epoch ms the current quiet window ends, or `null` when proactive messages may go out. */
  quietEndsAt(): number | null {
    if (!this.quietUntil) return null;
    const until = this.quietUntil(this.now());
    return until !== null && until > this.now() ? until : null;
  }

  /**
   * Hold `msg` until the quiet window ends, when one is open. True when held
   * (nothing sent; the drain delivers it then), false when not quiet now.
   */
  hold(msg: OutboxMessage): boolean {
    const until = this.quietEndsAt();
    if (until === null) return false;
    const chunks = this.boundChunks(msg);
    if (chunks.length === 0) return true;
    const now = this.now();
    const kept = this.push({
      id: randomUUID(),
      chatId: msg.chatId,
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      ...(msg.label ? { label: msg.label } : {}),
      ...(msg.userId !== undefined ? { userId: msg.userId } : {}),
      chunks,
      attempts: 0,
      nextAttemptAt: until,
      lastError: "",
      firstFailedAt: now,
      proactive: true,
      heldAt: now,
    });
    if (!kept) return true;
    this.logger.info(
      `[telegram-outbox] quiet hours: held message to chat ${msg.chatId}${msg.label ? ` [${msg.label}]` : ""} until ${new Date(until).toISOString()}`,
    );
    this.persist();
    return true;
  }

  /**
   * Deliver the held messages for `chatId` whose window has ended, before a
   * newer proactive message to that chat goes out: the drain only runs once a
   * minute, and the newer one must not overtake them.
   */
  async releaseHeld(chatId: number): Promise<void> {
    // Twice at most: a drain already in flight took its due list before these
    // came due, so the first await may deliver none of them.
    for (let pass = 0; pass < 2; pass++) {
      const now = this.now();
      if (!this.entries.some((e) => e.chatId === chatId && this.isReleasable(e, now))) return;
      await this.drain(now);
    }
  }

  /** Held and never sent, and its window has ended or quiet hours were switched off. */
  private isReleasable(e: OutboxEntry, now: number): boolean {
    return (
      e.heldAt !== undefined &&
      e.attempts === 0 &&
      (e.nextAttemptAt <= now || this.quietEndsAt() === null)
    );
  }

  list(): readonly OutboxEntry[] {
    return this.entries;
  }

  /**
   * Send `msg` chunk by chunk. On the first failure, the chunks not yet
   * delivered are queued for retry. Never throws; true when fully delivered.
   */
  async deliver(msg: OutboxMessage, opts: OutboxDeliverOptions = {}): Promise<boolean> {
    if (opts.proactive) {
      if (this.hold(msg)) return false;
      await this.releaseHeld(msg.chatId);
    }
    const chunks = msg.chunks.filter((c) => c.text.length > 0);
    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.sendOnce(msg.chatId, chunks[i], msg.threadId);
      } catch (err) {
        this.enqueueFailed({ ...msg, chunks: chunks.slice(i) }, err, opts);
        return false;
      }
    }
    return true;
  }

  /** Queue a message whose first send attempt (made by the caller) failed with `err`. */
  enqueueFailed(msg: OutboxMessage, err: unknown, opts: OutboxDeliverOptions = {}): void {
    const chunks = this.boundChunks(msg);
    if (chunks.length === 0) return;
    const now = this.now();
    const entry: OutboxEntry = {
      id: randomUUID(),
      chatId: msg.chatId,
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      ...(msg.label ? { label: msg.label } : {}),
      ...(msg.userId !== undefined ? { userId: msg.userId } : {}),
      chunks,
      attempts: 1,
      nextAttemptAt: now,
      lastError: describeError(err),
      firstFailedAt: now,
      ...(opts.proactive ? { proactive: true as const } : {}),
    };
    if (entry.attempts >= this.maxAttempts || isPermanentSendError(err)) {
      this.logAbandoned(entry);
      return;
    }
    entry.nextAttemptAt = now + Math.max(backoffMs(entry.attempts), retryAfterMs(err));
    if (!this.push(entry)) return;
    this.logger.warn(
      `[telegram-outbox] send to chat ${entry.chatId} failed, ${chunks.length} chunk(s) queued for retry in ${Math.round((entry.nextAttemptAt - now) / 1000)}s: ${entry.lastError}`,
    );
    this.persist();
  }

  /** Retry every entry due at `at`. Concurrent calls share one pass. */
  drain(at?: number): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainOnce(at ?? this.now()).finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  /** Drain shortly after start, then every `intervalMs`. Idempotent. */
  start(intervalMs = OUTBOX_DRAIN_INTERVAL_MS, firstDelayMs = OUTBOX_FIRST_DRAIN_DELAY_MS): void {
    if (this.timer) return;
    this.firstDrain = setTimeout(() => void this.drain(), firstDelayMs);
    this.firstDrain.unref?.();
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstDrain) clearTimeout(this.firstDrain);
    this.timer = null;
    this.firstDrain = null;
  }

  private boundChunks(msg: OutboxMessage): OutboxChunk[] {
    const chunks = msg.chunks.filter((c) => c.text.length > 0);
    if (chunks.length <= OUTBOX_MAX_CHUNKS) return chunks;
    this.logger.warn(
      `[telegram-outbox] message to chat ${msg.chatId} too long to queue whole; keeping ${OUTBOX_MAX_CHUNKS} of ${chunks.length} chunks`,
    );
    return chunks.slice(0, OUTBOX_MAX_CHUNKS);
  }

  /** False when `entry` itself was dropped: a full queue of failed replies keeps them. */
  private push(entry: OutboxEntry): boolean {
    while (this.entries.length >= this.maxEntries) {
      // A proactive message goes first: a full queue never costs a failed reply
      // its place to a night of held job results.
      const proactive = this.entries.findIndex((e) => e.proactive);
      if (proactive < 0 && entry.proactive) {
        this.logger.warn(
          `[telegram-outbox] queue full (${this.maxEntries}) of failed replies; dropped new message for chat ${entry.chatId}${entry.label ? ` [${entry.label}]` : ""}`,
        );
        return false;
      }
      const [dropped] = this.entries.splice(proactive >= 0 ? proactive : 0, 1);
      if (dropped) {
        this.logger.warn(
          `[telegram-outbox] queue full (${this.maxEntries}); dropped oldest message for chat ${dropped.chatId}${dropped.label ? ` [${dropped.label}]` : ""}: ${dropped.lastError || "held by quiet hours"}`,
        );
      }
    }
    this.entries.push(entry);
    return true;
  }

  private async sendOnce(chatId: number, chunk: OutboxChunk, threadId?: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`send timed out after ${this.sendTimeoutMs / 1000}s`)),
        this.sendTimeoutMs,
      );
    });
    try {
      await Promise.race([this.send(chatId, chunk, threadId), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async drainOnce(at: number): Promise<void> {
    // A chat that failed in this pass is skipped for the rest of it, so later
    // messages to that chat do not overtake an earlier one.
    const failedChats = new Set<number>();
    const quietEnd = this.quietEndsAt();
    const due = this.entries.filter((e) => e.nextAttemptAt <= at || this.isReleasable(e, at));
    for (const entry of due) {
      if (failedChats.has(entry.chatId) || !this.entries.includes(entry)) continue;
      if (entry.proactive && quietEnd !== null) {
        // Due inside a quiet window: wait for its end, no attempt counted.
        entry.nextAttemptAt = quietEnd;
        this.persist();
        continue;
      }
      while (entry.chunks.length > 0) {
        // Asked before every chunk: a removal during a long message stops it.
        const recipient = this.recipientStatus(entry);
        if (recipient === "unknown") {
          // Kept in place: later messages to that chat wait behind it.
          failedChats.add(entry.chatId);
          break;
        }
        if (recipient === "revoked") {
          this.remove(entry);
          this.logger.warn(
            `[telegram-outbox] dropped message to chat ${entry.chatId}${entry.label ? ` [${entry.label}]` : ""}: user ${entry.userId} is no longer allowed (telegram.allowedUserIds)`,
          );
          break;
        }
        try {
          await this.sendOnce(entry.chatId, entry.chunks[0], entry.threadId);
        } catch (err) {
          failedChats.add(entry.chatId);
          this.recordFailure(entry, err);
          break;
        }
        entry.chunks.shift();
        this.persist();
      }
      if (entry.chunks.length === 0) {
        this.remove(entry);
        this.logger.info(
          entry.attempts === 0 && entry.heldAt !== undefined
            ? `[telegram-outbox] delivered message held by quiet hours to chat ${entry.chatId}${entry.label ? ` [${entry.label}]` : ""} (held since ${new Date(entry.heldAt).toISOString()})`
            : `[telegram-outbox] delivered queued message to chat ${entry.chatId}${entry.label ? ` [${entry.label}]` : ""} after ${entry.attempts + 1} attempt(s)`,
        );
      }
    }
  }

  /**
   * #525: may `entry` still go to its recipient? Entries without `userId`, or
   * no check installed: yes. A check that throws (a settings reload gone
   * wrong) neither sends nor drops: `unknown`, and the next pass asks again.
   */
  private recipientStatus(entry: OutboxEntry): "allowed" | "revoked" | "unknown" {
    if (entry.userId === undefined || !this.recipientAllowed) return "allowed";
    try {
      return this.recipientAllowed(entry.userId) ? "allowed" : "revoked";
    } catch (err) {
      this.logger.error(
        `[telegram-outbox] recipient check failed for chat ${entry.chatId}; kept for the next pass`,
        err,
      );
      return "unknown";
    }
  }

  private recordFailure(entry: OutboxEntry, err: unknown): void {
    entry.attempts += 1;
    entry.lastError = describeError(err);
    if (entry.attempts >= this.maxAttempts || isPermanentSendError(err)) {
      this.remove(entry);
      this.logAbandoned(entry);
      return;
    }
    entry.nextAttemptAt = this.now() + Math.max(backoffMs(entry.attempts), retryAfterMs(err));
    this.persist();
  }

  private logAbandoned(entry: OutboxEntry): void {
    this.logger.error(
      `[telegram-outbox] abandoned message to chat ${entry.chatId}${entry.label ? ` [${entry.label}]` : ""} after ${entry.attempts} attempt(s), ${entry.chunks.length} chunk(s) undelivered: ${entry.lastError}`,
    );
  }

  private remove(entry: OutboxEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
    this.persist();
  }

  private load(): OutboxEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isEntry) : [];
      return entries.slice(-this.maxEntries);
    } catch (err) {
      this.logger.error(`[telegram-outbox] unreadable ${this.path}, starting empty`, err);
      return [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), {
        mode: 0o600,
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      this.logger.error(`[telegram-outbox] could not write ${this.path}`, err);
    }
  }
}

const instances = new Map<string, TelegramOutbox>();

/**
 * The process-wide outbox for `path`, created on first use. A later caller's
 * `send` replaces the previous one, so the runtime that currently owns the
 * token is the one that delivers, and two runtimes never drain the same file.
 */
/** The outbox already open for `path`, if any; its sender is left as is. */
export function findTelegramOutbox(path: string): TelegramOutbox | undefined {
  return instances.get(path);
}

export function getTelegramOutbox(
  path: string,
  send: OutboxSender,
  logger?: Logger,
): TelegramOutbox {
  const existing = instances.get(path);
  if (existing) {
    existing.setSender(send);
    return existing;
  }
  const created = new TelegramOutbox({ path, send, logger });
  instances.set(path, created);
  return created;
}
