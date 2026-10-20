import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffMs,
  describeError,
  type OutboxChunk,
  retryAfterMs,
  TelegramOutbox,
} from "../telegram-outbox";
import { buildTelegramChunks, sendTelegramChunk } from "../commands/telegram";

const MIN = 60_000;

let dir: string;
let path: string;
let clock: number;
let sent: Array<{ chatId: number; text: string; threadId?: number }>;
let failWith: ((chunk: OutboxChunk) => Error | undefined) | null;
let logs: { info: string[]; warn: string[]; error: string[] };

const logger = {
  info: (...a: unknown[]) => void logs.info.push(a.map(String).join(" ")),
  warn: (...a: unknown[]) => void logs.warn.push(a.map(String).join(" ")),
  error: (...a: unknown[]) => void logs.error.push(a.map(String).join(" ")),
};

async function send(chatId: number, chunk: OutboxChunk, threadId?: number): Promise<void> {
  const err = failWith?.(chunk);
  if (err) throw err;
  sent.push({ chatId, text: chunk.text, threadId });
}

function make(opts: { maxEntries?: number } = {}): TelegramOutbox {
  return new TelegramOutbox({ path, send, now: () => clock, logger, ...opts });
}

function onDisk(): {
  entries: Array<{ chatId: number; userId?: number; chunks: OutboxChunk[]; attempts: number }>;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

const forbidden = () =>
  new Error("Telegram API sendMessage: 403 Forbidden: Forbidden: bot was blocked by the user");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-outbox-"));
  path = join(dir, "retry", "telegram-outbox.json");
  clock = 1_000_000;
  sent = [];
  failWith = null;
  logs = { info: [], warn: [], error: [] };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TelegramOutbox", () => {
  it("a failed send is queued on disk with the reason, 0600", async () => {
    failWith = forbidden;
    const ob = make();
    const ok = await ob.deliver({ chatId: 7, threadId: 3, label: "job", chunks: [{ text: "hi" }] });

    expect(ok).toBe(false);
    const [entry] = ob.list();
    expect(entry.chatId).toBe(7);
    expect(entry.threadId).toBe(3);
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toContain("403");
    expect(entry.lastError).toContain("bot was blocked");
    expect(entry.nextAttemptAt).toBe(clock + 2 * MIN);
    expect(onDisk().entries).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("drain delivers a due entry and removes it", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "hi" }] });

    failWith = null;
    await ob.drain(); // not due yet
    expect(sent).toHaveLength(0);

    clock += 2 * MIN;
    await ob.drain();
    expect(sent).toEqual([{ chatId: 7, text: "hi", threadId: undefined }]);
    expect(ob.list()).toHaveLength(0);
    expect(onDisk().entries).toHaveLength(0);
  });

  it("chunk 1 delivered + chunk 2 failed: only chunk 2 (and later) is retried", async () => {
    failWith = (c) =>
      c.text === "two" ? new Error("Telegram API sendMessage: 502 Bad Gateway") : undefined;
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "one" }, { text: "two" }, { text: "three" }] });

    expect(sent.map((s) => s.text)).toEqual(["one"]);
    expect(ob.list()[0].chunks.map((c) => c.text)).toEqual(["two", "three"]);

    failWith = null;
    clock += 2 * MIN;
    await ob.drain();
    expect(sent.map((s) => s.text)).toEqual(["one", "two", "three"]);
  });

  it("partial progress during a drain is persisted, so delivered chunks are not re-sent", async () => {
    failWith = () => new Error("Telegram API sendMessage: 502 Bad Gateway");
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "a" }, { text: "b" }] });

    failWith = (c) =>
      c.text === "b" ? new Error("Telegram API sendMessage: 502 Bad Gateway") : undefined;
    clock += 2 * MIN;
    await ob.drain();
    expect(sent.map((s) => s.text)).toEqual(["a"]);
    expect(onDisk().entries[0].chunks.map((c) => c.text)).toEqual(["b"]);
    expect(onDisk().entries[0].attempts).toBe(2);
  });

  it("backs off 2,4,8,16,32 min and abandons after 6 attempts with one log line", async () => {
    failWith = () => new Error("Telegram API sendMessage: 400 Bad Request: chat not found");
    const ob = make();
    await ob.deliver({ chatId: 7, label: "nightly", chunks: [{ text: "x" }] });

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const entry = ob.list()[0];
      delays.push((entry.nextAttemptAt - clock) / MIN);
      clock = entry.nextAttemptAt;
      await ob.drain();
    }
    expect(delays).toEqual([2, 4, 8, 16, 32]);
    expect(ob.list()).toHaveLength(0);
    expect(onDisk().entries).toHaveLength(0);
    const abandoned = logs.error.filter((l) => l.includes("abandoned"));
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toContain("6 attempt(s)");
    expect(abandoned[0]).toContain("chat not found");
    expect(abandoned[0]).toContain("[nightly]");
  });

  it("a new instance reading the file resumes the queue (restart)", async () => {
    failWith = forbidden;
    await make().deliver({ chatId: 9, chunks: [{ text: "p1" }, { text: "p2" }] });

    failWith = null;
    const restarted = make();
    expect(restarted.list()).toHaveLength(1);
    clock += 2 * MIN;
    await restarted.drain();
    expect(sent.map((s) => s.text)).toEqual(["p1", "p2"]);
    expect(restarted.list()).toHaveLength(0);
  });

  it("honours a 429 retry_after longer than the backoff", async () => {
    failWith = () =>
      new Error(
        "Telegram API sendMessage: 429 Too Many Requests (retry_after 600s): Too Many Requests",
      );
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "x" }] });
    expect(ob.list()[0].nextAttemptAt).toBe(clock + 600_000);

    clock += 2 * MIN;
    failWith = null;
    await ob.drain();
    expect(sent).toHaveLength(0);
    clock += 8 * MIN;
    await ob.drain();
    expect(sent).toHaveLength(1);
  });

  it("drops the oldest entry when the queue is full", async () => {
    failWith = forbidden;
    const ob = make({ maxEntries: 2 });
    await ob.deliver({ chatId: 1, chunks: [{ text: "1" }] });
    await ob.deliver({ chatId: 2, chunks: [{ text: "2" }] });
    await ob.deliver({ chatId: 3, chunks: [{ text: "3" }] });
    expect(ob.list().map((e) => e.chatId)).toEqual([2, 3]);
    expect(logs.warn.some((l) => l.includes("queue full") && l.includes("chat 1"))).toBe(true);
  });

  it("a chat that fails in a drain does not let its later message overtake", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "first" }] });
    await ob.deliver({ chatId: 7, chunks: [{ text: "second" }] });

    failWith = (c) => (c.text === "first" ? forbidden() : undefined);
    clock += 2 * MIN;
    await ob.drain();
    expect(sent).toHaveLength(0);
  });

  it("a permanent 400 (text rejected) is abandoned at once, not retried", async () => {
    failWith = () => new Error("Telegram API sendMessage: 400 Bad Request: message is too long");
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "x" }] });
    expect(ob.list()).toHaveLength(0);
    expect(logs.error.some((l) => l.includes("abandoned") && l.includes("too long"))).toBe(true);
  });

  it("a send that never settles counts as failed, so the drain moves on", async () => {
    const ob = new TelegramOutbox({
      path,
      send: (chatId, chunk) => (chatId === 1 ? new Promise(() => {}) : send(chatId, chunk)),
      now: () => clock,
      logger,
      sendTimeoutMs: 20,
    });
    await ob.deliver({ chatId: 1, chunks: [{ text: "hung" }] });
    expect(ob.list()[0].lastError).toContain("timed out");
  });

  it("keeps at most 50 chunks of one message", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({
      chatId: 7,
      chunks: Array.from({ length: 80 }, (_, i) => ({ text: `c${i}` })),
    });
    expect(ob.list()[0].chunks).toHaveLength(50);
  });

  it("start() does not drain immediately; stop() before the first drain sends nothing", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "x" }] });
    failWith = null;
    clock += 3 * MIN;
    ob.start(60_000, 30);
    ob.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(0);
    ob.start(60_000, 10);
    await new Promise((r) => setTimeout(r, 60));
    ob.stop();
    expect(sent).toHaveLength(1);
  });

  it("a corrupt file starts empty instead of throwing", () => {
    writeFileSync(join(dir, "bad.json"), "{nope");
    const ob = new TelegramOutbox({ path: join(dir, "bad.json"), send, logger });
    expect(ob.list()).toHaveLength(0);
    expect(logs.error.some((l) => l.includes("unreadable"))).toBe(true);
  });

  it("helpers: backoff, retry_after from both runtimes, token redaction", () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(n) / MIN)).toEqual([2, 4, 8, 16, 32]);
    expect(
      retryAfterMs(new Error("Telegram API sendMessage: 429 Too Many Requests (retry_after 30s)")),
    ).toBe(30_000);
    expect(
      retryAfterMs(
        new Error("Telegram API sendMessage: 429 flood cooldown, 12s remaining for chat 5"),
      ),
    ).toBe(12_000);
    expect(retryAfterMs(new Error("Telegram API sendMessage: 502 Bad Gateway"))).toBe(0);
    expect(
      describeError(new Error("fetch https://api.telegram.org/bot123:AbC-d_e/sendMessage failed")),
    ).not.toContain("AbC");
  });
});

describe("TelegramOutbox — recipient re-check at drain (#525)", () => {
  it("persists the sender with held and retried entries, and reads it back", async () => {
    const ob = make();
    ob.setQuietHours(() => clock + 60 * MIN);
    expect(ob.hold({ chatId: 500, userId: 7, chunks: [{ text: "held" }] })).toBe(true);
    failWith = forbidden;
    ob.setQuietHours(null);
    await ob.deliver({ chatId: 501, userId: 8, chunks: [{ text: "retried" }] });

    expect(onDisk().entries.map((e) => [e.chatId, e.userId])).toEqual([
      [500, 7],
      [501, 8],
    ]);
    expect(
      make()
        .list()
        .map((e) => e.userId),
    ).toEqual([7, 8]);
  });

  it("drops an entry whose sender is no longer allowed, with one log line", async () => {
    failWith = forbidden;
    const ob = make();
    const allowed = new Set([7, 8]);
    ob.setRecipientCheck((id) => allowed.has(id));
    await ob.deliver({ chatId: 500, userId: 7, label: "job", chunks: [{ text: "a" }] });
    await ob.deliver({ chatId: 501, userId: 8, chunks: [{ text: "b" }] });
    failWith = null;

    allowed.delete(7);
    await ob.drain(clock + 3 * MIN);
    expect(sent).toEqual([{ chatId: 501, text: "b", threadId: undefined }]);
    expect(ob.list()).toHaveLength(0);
    expect(onDisk().entries).toHaveLength(0);
    expect(logs.warn.filter((w) => w.includes("user 7 is no longer allowed"))).toHaveLength(1);
    expect(logs.warn.some((w) => w.includes("chat 500 [job]"))).toBe(true);
  });

  it("an entry written before the sender was persisted still loads and is delivered", async () => {
    mkdirSync(join(dir, "retry"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "old-1",
            chatId: 500,
            chunks: [{ text: "from before the upgrade", parseMode: "HTML" }],
            attempts: 0,
            nextAttemptAt: clock,
            lastError: "",
            firstFailedAt: clock - MIN,
            proactive: true,
            heldAt: clock - MIN,
          },
        ],
      }),
    );
    const ob = make();
    ob.setRecipientCheck(() => false);
    expect(ob.list()).toHaveLength(1);
    await ob.drain(clock);
    expect(sent.map((m) => [m.chatId, m.text])).toEqual([[500, "from before the upgrade"]]);
    expect(ob.list()).toHaveLength(0);
  });

  it("an entry whose sender is not an integer is refused at load", () => {
    mkdirSync(join(dir, "retry"), { recursive: true });
    const base = { chunks: [{ text: "x" }], attempts: 1, nextAttemptAt: clock, lastError: "" };
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { ...base, id: "bad", chatId: 500, userId: "7" },
          { ...base, id: "ok", chatId: 501, userId: 8 },
        ],
      }),
    );
    expect(
      make()
        .list()
        .map((e) => e.id),
    ).toEqual(["ok"]);
  });

  it("a user removed while a long message drains gets no further chunk", async () => {
    failWith = forbidden;
    const ob = make();
    const allowed = new Set([7]);
    ob.setRecipientCheck((id) => allowed.has(id));
    await ob.deliver({ chatId: 500, userId: 7, chunks: [{ text: "c1" }, { text: "c2" }] });
    failWith = (chunk) => {
      if (chunk.text === "c1") allowed.delete(7);
      return undefined;
    };

    await ob.drain(clock + 3 * MIN);
    expect(sent.map((m) => m.text)).toEqual(["c1"]);
    expect(ob.list()).toHaveLength(0);
    expect(logs.warn.filter((w) => w.includes("user 7 is no longer allowed"))).toHaveLength(1);
  });

  it("a recipient check that throws neither sends nor drops; the next pass asks again", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({ chatId: 500, userId: 7, chunks: [{ text: "a" }] });
    await ob.deliver({ chatId: 500, chunks: [{ text: "a2" }] });
    await ob.deliver({ chatId: 501, chunks: [{ text: "b" }] });
    failWith = null;
    let broken = true;
    ob.setRecipientCheck(() => {
      if (broken) throw new Error("settings unreadable");
      return true;
    });

    // The kept entry also holds back the later message to its chat.
    await ob.drain(clock + 3 * MIN);
    expect(sent.map((m) => m.text)).toEqual(["b"]);
    expect(ob.list().map((e) => e.chunks[0].text)).toEqual(["a", "a2"]);
    expect(logs.error.some((e) => e.includes("recipient check failed for chat 500"))).toBe(true);

    broken = false;
    await ob.drain(clock + 3 * MIN);
    expect(sent.map((m) => m.text)).toEqual(["b", "a", "a2"]);
    expect(ob.list()).toHaveLength(0);
  });

  it("without a recipient check, an entry with a sender is delivered", async () => {
    failWith = forbidden;
    const ob = make();
    await ob.deliver({ chatId: 500, userId: 7, chunks: [{ text: "a" }] });
    failWith = null;
    await ob.drain(clock + 3 * MIN);
    expect(sent.map((m) => m.chatId)).toEqual([500]);
  });
});

describe("legacy Telegram chunk helpers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("buildTelegramChunks splits into 4096-char HTML chunks with a plain fallback", () => {
    const chunks = buildTelegramChunks("a".repeat(5000));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].parseMode).toBe("HTML");
    expect(chunks[0].text).toHaveLength(4096);
    expect(chunks[1].plain).toBe("a".repeat(904));
  });

  const reply = (status: number, statusText: string, description: string) =>
    new Response(JSON.stringify({ ok: false, description }), { status, statusText });

  it("a 429 on the HTML send is not resent as plain text right away", async () => {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return reply(429, "Too Many Requests", "Too Many Requests: retry after 5");
    }) as unknown as typeof fetch;
    const chunk: OutboxChunk = { text: "<b>x</b>", parseMode: "HTML", plain: "x" };
    await expect(sendTelegramChunk("t", 1, chunk)).rejects.toThrow("429");
    expect(calls).toHaveLength(1);
  });

  it("an HTML parse error is resent once as plain text", async () => {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return calls.length === 1
        ? reply(400, "Bad Request", "Bad Request: can't parse entities: unclosed tag")
        : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await sendTelegramChunk("t", 1, { text: "<b>x", parseMode: "HTML", plain: "x" });
    expect(calls.map((c) => [c.text, c.parse_mode])).toEqual([
      ["<b>x", "HTML"],
      ["x", undefined],
    ]);
  });

  it("a failed send keeps the HTTP status, description and retry_after", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          description: "Too Many Requests: retry after 45",
          parameters: { retry_after: 45 },
        }),
        { status: 429, statusText: "Too Many Requests" },
      )) as unknown as typeof fetch;
    const err = await sendTelegramChunk("t", 1, { text: "x", parseMode: "HTML", plain: "x" }).catch(
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("429");
    expect((err as Error).message).toContain("retry_after 45s");
    expect(retryAfterMs(err)).toBe(45_000);
  });
});
