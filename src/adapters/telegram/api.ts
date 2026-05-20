/**
 * Telegram adapter — fetch-backed Bot API client.
 *
 * Split out of `index.ts` so the main adapter file stays under the
 * file-size ceiling and so the HTTP surface can be swapped/mocked
 * without touching the adapter wiring.
 *
 * Mirrors `callApi()` in `src/commands/telegram.ts:422-440`. We
 * re-implement here (rather than importing) so the Bus adapter has zero
 * dependency on the legacy file. Sprint 5 can consolidate once the
 * PTY path is retired.
 */

import type { TelegramApi } from "./types";

const API_BASE = "https://api.telegram.org/bot";

/**
 * Build a `TelegramApi` instance bound to a particular bot token.
 *
 * `allowed_updates` differences vs `src/commands/telegram.ts:2177`:
 *   - Bus adapter requests `["message", "edited_message", "callback_query"]`.
 *   - Legacy requests `["message", "my_chat_member", "callback_query"]`.
 *   - Bus ADDS `edited_message` (lets adapter react to message edits in
 *     Sprint 4+ without re-subscribing).
 *   - Bus DROPS `my_chat_member` (group-join semantics not yet wired into
 *     the Bus; Sprint 4 follow-up if the surface needs it).
 * Both sets are intentional; PR #113 review (agent #5) flagged the
 * earlier comment for framing the diff as one-sided.
 *
 * Other notes:
 *   - `setMessageReaction` wraps a single emoji in the expected
 *     `[{type:"emoji", emoji:"…"}]` array shape per Bot API 7.x.
 *   - Errors throw with `${method}: ${status} ${statusText}` so the
 *     adapter's `safe*` wrappers can log a useful one-liner.
 */
export function createTelegramApi(token: string): TelegramApi {
  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${API_BASE}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Telegram API ${method}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  return {
    async getUpdates(offset, timeoutSeconds, signal) {
      return call(
        "getUpdates",
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "edited_message", "callback_query"],
        },
        signal,
      );
    },
    async sendMessage(params) {
      return call("sendMessage", params as unknown as Record<string, unknown>);
    },
    async editMessageText(params) {
      return call("editMessageText", params as unknown as Record<string, unknown>);
    },
    async sendChatAction(params) {
      return call("sendChatAction", params as unknown as Record<string, unknown>);
    },
    async setMessageReaction(params) {
      return call("setMessageReaction", {
        chat_id: params.chat_id,
        message_id: params.message_id,
        reaction: [{ type: "emoji", emoji: params.emoji }],
      });
    },
    async answerCallbackQuery(params) {
      return call("answerCallbackQuery", params as unknown as Record<string, unknown>);
    },
  };
}
