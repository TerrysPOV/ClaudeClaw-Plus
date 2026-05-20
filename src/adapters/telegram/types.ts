/**
 * Telegram adapter — config + wire-shape types.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.2.
 * Coordination: `src/bus/SPRINT_3_PLAN.md` Agent B scope.
 *
 * These mirror the subset of the Telegram Bot API the existing PTY-coupled
 * listener at `src/commands/telegram.ts` uses. We re-declare them here
 * (rather than import from `src/commands/telegram.ts`) so the adapter is
 * decoupled from the legacy file — Sprint 5 will retire that path entirely
 * for `runtime: bus`. Field names track the upstream Bot API verbatim.
 */

/* ──────────────────────────────────────────────────────────────────────── */
/* Bot-API wire shapes                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

export interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface TelegramChat {
  id: number;
  /**
   * Telegram-side chat type. The Bus adapter accepts every type the existing
   * single-user-bot pattern accepts (`private`, `group`, `supergroup`).
   */
  type: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_name?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  /** Optional — only set for forum/topic threads. */
  message_thread_id?: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  /** Opaque payload set by the inline-keyboard button. */
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramGetUpdatesResult {
  ok: boolean;
  result: TelegramUpdate[];
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Bot-API surface the adapter calls (interface seam for tests)              */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Minimal Telegram API surface used by the adapter. Real implementation is
 * `createTelegramApi()` in `./api.ts`; tests substitute a `FakeTelegramApi`
 * to avoid hitting `api.telegram.org` (see `__tests__/telegram.test.ts`).
 *
 * Shape mirrors the calls in `src/commands/telegram.ts` — only the methods
 * the adapter actually invokes are declared.
 */
export interface TelegramApi {
  /** Long-poll `getUpdates`. `signal` lets `stop()` abort an in-flight wait. */
  getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<TelegramGetUpdatesResult>;
  sendMessage(params: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
    reply_markup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
  }): Promise<{ ok: boolean; result?: { message_id: number } }>;
  /** Edit the text of a message the bot previously sent. */
  editMessageText(params: {
    chat_id: number;
    message_id: number;
    text: string;
  }): Promise<{ ok: boolean; result?: { message_id: number } | true }>;
  /** Show a chat action (e.g. typing) — expires after ~5s. */
  sendChatAction(params: {
    chat_id: number;
    action: "typing";
  }): Promise<{ ok: boolean }>;
  /** Sets a single emoji reaction on a message (mirrors §5.5.2 reaction model). */
  setMessageReaction(params: {
    chat_id: number;
    message_id: number;
    emoji: string;
  }): Promise<{ ok: boolean }>;
  answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
  }): Promise<{ ok: boolean }>;
}
