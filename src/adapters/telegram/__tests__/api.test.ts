/**
 * Tests for the per-chat flood cooldown in `createTelegramApi`.
 *
 * Background (#141 incident 2026-05-21): the progress spinner edited a message
 * ~1/s for the duration of a turn; Telegram escalated to a flood-ban with
 * `retry_after` ~1730s, and every further send 429'd, blocking all replies.
 * The cooldown records the `retry_after` deadline per chat and short-circuits
 * subsequent sends WITHOUT hitting the API until it clears.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createTelegramApi } from "../api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub429(retryAfter: number, counter: { n: number }): void {
  globalThis.fetch = (async () => {
    counter.n += 1;
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: retryAfter },
      }),
      { status: 429, statusText: "Too Many Requests" },
    );
  }) as typeof fetch;
}

describe("createTelegramApi — per-chat flood cooldown", () => {
  it("short-circuits a flooded chat without re-hitting the API", async () => {
    const counter = { n: 0 };
    stub429(100, counter);
    const api = createTelegramApi("test-token");

    // First send reaches Telegram and gets the 429 (records the cooldown).
    await expect(api.sendMessage({ chat_id: 42, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(1);

    // Second send to the SAME chat is rejected locally — no new fetch.
    await expect(api.sendMessage({ chat_id: 42, text: "again" })).rejects.toThrow(/flood cooldown/);
    expect(counter.n).toBe(1);
  });

  it("does not block a different chat", async () => {
    const counter = { n: 0 };
    stub429(100, counter);
    const api = createTelegramApi("test-token");

    await expect(api.sendMessage({ chat_id: 42, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(1);

    // A different chat is unaffected — it still reaches the API.
    await expect(api.sendMessage({ chat_id: 99, text: "hi" })).rejects.toThrow(/429/);
    expect(counter.n).toBe(2);
  });

  it("surfaces retry_after in the thrown error for observability", async () => {
    const counter = { n: 0 };
    stub429(1730, counter);
    const api = createTelegramApi("test-token");
    await expect(api.editMessageText({ chat_id: 7, message_id: 1, text: "x" })).rejects.toThrow(
      /retry_after 1730s/,
    );
  });
});
