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
 * Client-side hard-timeout buffer (ms) added on top of the `getUpdates`
 * server-side long-poll window. The long-poll itself can legitimately hold
 * the connection open for `timeoutSeconds`; we only want to abort a request
 * that is genuinely stuck (half-open socket after a gateway 502/504 or a
 * network blip), so the client timeout is `timeoutSeconds*1000 + BUFFER`.
 * Without this, a stuck `await getUpdates(...)` never resolves and never
 * rejects, freezing the poll loop silently — the bot goes deaf with no error
 * logged until a manual restart. See `index.ts` `pollLoop`: a TimeoutError
 * (distinct from stop()'s AbortError) falls through to the catch → sleep →
 * retry, so the loop self-heals.
 */
export const GETUPDATES_TIMEOUT_BUFFER_MS = 5_000;

/** Options for {@link createTelegramApi}. */
export interface TelegramApiOptions {
  /**
   * Override the {@link GETUPDATES_TIMEOUT_BUFFER_MS} buffer. Primarily for
   * tests that need a short client timeout; production uses the default.
   */
  getUpdatesTimeoutBufferMs?: number;
}

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
export function createTelegramApi(token: string, options: TelegramApiOptions = {}): TelegramApi {
  const getUpdatesBufferMs = options.getUpdatesTimeoutBufferMs ?? GETUPDATES_TIMEOUT_BUFFER_MS;
  // Per-chat flood cooldown. Telegram answers a flooded chat with HTTP 429 and
  // a `parameters.retry_after` (seconds). Until that window passes, every
  // further send to that chat is rejected too — and each rejected attempt can
  // extend the ban. We record the deadline and short-circuit subsequent sends
  // to that chat WITHOUT hitting the API, so a misbehaving caller (e.g. a
  // progress spinner) can't sustain the ban and it clears on its own.
  const floodUntil = new Map<string, number>();
  // Per-chat send serialization (#154). Telegram rate-limits per chat, so two
  // concurrent in-flight sends to the same chat would race the flood-cooldown
  // write (neither's 429 blocks the other) and risk a burst. Chaining sends per
  // chat keeps at most one in flight; `getUpdates` (no chat_id) is never chained.
  const chatTail = new Map<string, Promise<unknown>>();

  async function dispatch<T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    chatKey: string,
  ): Promise<T> {
    if (chatKey) {
      const until = floodUntil.get(chatKey);
      if (until !== undefined) {
        const remaining = until - Date.now();
        if (remaining > 0) {
          throw new Error(
            `Telegram API ${method}: 429 flood cooldown, ${Math.ceil(remaining / 1000)}s remaining for chat ${chatKey}`,
          );
        }
        // Cooldown elapsed — evict so the map doesn't grow unbounded (#154).
        floodUntil.delete(chatKey);
      }
    }
    const res = await fetch(`${API_BASE}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let retryAfter = 0;
      let description = "";
      try {
        const errBody = (await res.json()) as {
          description?: string;
          parameters?: { retry_after?: number };
        };
        retryAfter = errBody?.parameters?.retry_after ?? 0;
        // Surface Telegram's reason (e.g. "Bad Request: can't parse entities …")
        // so callers can tell a malformed-HTML 400 from a benign one.
        description = errBody?.description ?? "";
      } catch {
        /* error body was not JSON — ignore */
      }
      if (res.status === 429 && chatKey && retryAfter > 0) {
        floodUntil.set(chatKey, Date.now() + retryAfter * 1000);
      }
      throw new Error(
        `Telegram API ${method}: ${res.status} ${res.statusText}${
          retryAfter ? ` (retry_after ${retryAfter}s)` : ""
        }${description ? `: ${description}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const chatVal = (body as { chat_id?: unknown }).chat_id;
    const chatKey = chatVal === undefined || chatVal === null ? "" : String(chatVal);
    if (!chatKey) {
      return dispatch<T>(method, body, signal, "");
    }
    // Chain this send after the chat's previous one (success or failure).
    const prev = chatTail.get(chatKey) ?? Promise.resolve();
    const run = prev.then(
      () => dispatch<T>(method, body, signal, chatKey),
      () => dispatch<T>(method, body, signal, chatKey),
    );
    const tail = run.then(
      () => {},
      () => {},
    );
    chatTail.set(chatKey, tail);
    // Drop the tail once it settles and nothing newer chained (bounded growth).
    void tail.then(() => {
      if (chatTail.get(chatKey) === tail) chatTail.delete(chatKey);
    });
    return run;
  }

  return {
    async getUpdates(offset, timeoutSeconds, signal) {
      // `timeout` is the SERVER-side long-poll window; on its own there is no
      // client-side deadline, so a half-open connection makes this await hang
      // forever and freezes the poll loop. Layer a client hard-timeout that
      // fires `timeoutSeconds + buffer` later. `AbortSignal.timeout` aborts
      // with a TimeoutError (NOT the AbortError that stop()'s manual abort
      // produces), and `AbortSignal.any` forwards whichever source fires
      // first — so the loop's catch keeps treating stop() as a clean exit
      // while a genuine hang surfaces as a retryable error.
      const deadline = AbortSignal.timeout(timeoutSeconds * 1000 + getUpdatesBufferMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      return call(
        "getUpdates",
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "edited_message", "callback_query"],
        },
        combined,
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
