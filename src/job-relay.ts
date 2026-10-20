/**
 * Send-only channels for job results under `runtime: "bus"`.
 *
 * The job loop (`job-loop.ts`) runs every job under the bus too, but start.ts
 * skips `initTelegram` / `initDiscord` there: the bus adapters own Telegram
 * polling and the Discord gateway. That left `forwardToTelegram` /
 * `forwardToDiscord` with nothing to send through. These senders only send:
 * no polling, no gateway, no second consumer of either channel.
 *
 * Telegram job results also go through the durable outbox, as under the legacy
 * runtime: a failed send is retried later, and quiet hours hold it.
 */

import { type AllowlistState, isAllowedBy } from "./allowlist";
import { proactiveDeliver, type QuietHoursState } from "./quiet-hours";
import {
  defaultOutboxPath,
  findTelegramOutbox,
  getTelegramOutbox,
  type TelegramOutbox,
} from "./telegram-outbox";

export interface JobRelay {
  telegramSend: ((chatId: number, text: string) => Promise<void>) | null;
  /**
   * Proactive send through the outbox. Never throws; true when delivered now.
   * `chatId` is an allowed user's private chat (`forwardToTelegram` sends one
   * per `telegram.allowedUserIds` entry), so it is recorded as the recipient:
   * a result held or retried is dropped if that user is removed meanwhile (#525).
   */
  telegramDeliver: ((chatId: number, text: string, label?: string) => Promise<boolean>) | null;
  discordSendToUser: ((userId: string, text: string) => Promise<void>) | null;
}

export interface BusJobRelayOptions {
  telegramToken: string;
  discordToken: string;
  /** Defaults to the Telegram Bot API `sendMessage`. */
  telegramSend?: (token: string, chatId: number, text: string) => Promise<void>;
  /**
   * Defaults to the process-wide outbox at `outboxPath`. Tests pass their own.
   */
  outbox?: TelegramOutbox;
  /** Defaults to the daemon's state dir. */
  outboxPath?: string;
  /** Quiet hours, read on every send so a settings reload applies. */
  quietHours?: () => QuietHoursState | undefined;
  /**
   * Telegram allow-list, read when a held or retried result drains (#525). Set
   * here too because the Telegram adapter, which installs the same check, does
   * not mount in send-only setups.
   */
  telegramAllowlist?: () => AllowlistState<number>;
  /** Defaults to the Discord REST DM send. */
  discordSend?: (token: string, userId: string, text: string) => Promise<void>;
}

export async function busJobRelay(opts: BusJobRelayOptions): Promise<JobRelay> {
  let telegramSend: JobRelay["telegramSend"] = null;
  let telegramDeliver: JobRelay["telegramDeliver"] = null;
  if (opts.telegramToken) {
    const token = opts.telegramToken;
    const telegram = await import("./commands/telegram");
    const send = opts.telegramSend ?? telegram.sendMessage;
    telegramSend = (chatId, text) => send(token, chatId, text);
    // The Telegram bus adapter mounts first and owns this outbox: keep its
    // sender, which goes through its per-chat send chain and flood cooldown.
    const path = opts.outboxPath ?? defaultOutboxPath();
    const outbox =
      opts.outbox ??
      findTelegramOutbox(path) ??
      getTelegramOutbox(path, (chatId, chunk, threadId) =>
        telegram.sendTelegramChunk(token, chatId, chunk, threadId),
      );
    const allowlist = opts.telegramAllowlist;
    if (allowlist) outbox.setRecipientCheck((userId) => isAllowedBy(allowlist(), userId));
    outbox.start();
    const deliver = proactiveDeliver(outbox, opts.quietHours ?? (() => undefined));
    telegramDeliver = (chatId, text, label) =>
      deliver({ chatId, userId: chatId, chunks: telegram.buildTelegramChunks(text), label });
  }

  let discordSendToUser: JobRelay["discordSendToUser"] = null;
  if (opts.discordToken) {
    const token = opts.discordToken;
    const send = opts.discordSend ?? (await import("./commands/discord")).sendMessageToUser;
    discordSendToUser = (userId, text) => send(token, userId, text);
  }

  return { telegramSend, telegramDeliver, discordSendToUser };
}
