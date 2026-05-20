/**
 * Tests for `src/adapters/telegram/index.ts` (Sprint 3 Agent B).
 *
 * Run with: `bun test src/adapters/telegram/__tests__/telegram.test.ts`
 *
 * Strategy mirrors the WebUI adapter suite:
 *   - `FakeBus` implements the public `BusCore` interface so we can assert
 *     on `sendPrompt` / `ingestPermissionDecision` / `ingestAskAnswer`
 *     calls without spinning up the real IPC stack.
 *   - `FakeTelegramApi` implements the `TelegramApi` seam — never touches
 *     `api.telegram.org`. `getUpdates` blocks on an internal queue so we
 *     can deterministically feed updates into the long-poll loop.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { TelegramAdapter, extractReactionDirectives } from "../index";
import type { BusCore, SendPromptRequest } from "../../../bus/core";
import type {
  Subscription,
  SubscriptionFilter,
  SubscriptionHandler,
} from "../../../bus/core-subscription";
import type { BusEvent } from "../../../bus/types";
import type {
  TelegramApi,
  TelegramGetUpdatesResult,
  TelegramInlineKeyboardButton,
  TelegramUpdate,
} from "../types";

/* ────────────────────────────────────────────────────────────────────── */
/* FakeBus                                                                  */
/* ────────────────────────────────────────────────────────────────────── */

interface FakeSubscription extends Subscription {
  filter: SubscriptionFilter;
  handler: SubscriptionHandler;
  closedFlag: boolean;
}

class FakeBus implements BusCore {
  public readonly prompts: SendPromptRequest[] = [];
  public readonly permissionDecisions: Array<{
    agent_id: string;
    request_id: string;
    behavior: "allow" | "deny";
  }> = [];
  public readonly askAnswers: Array<{ agent_id: string; ask_id: string; answer: string }> = [];
  public readonly subscriptions = new Map<string, FakeSubscription>();

  async sendPrompt(req: SendPromptRequest): Promise<{ promise_id: string }> {
    this.prompts.push(req);
    return { promise_id: randomUUID() };
  }

  subscribe(filter: SubscriptionFilter, handler: SubscriptionHandler): Subscription {
    const id = randomUUID();
    const record: FakeSubscription = {
      id,
      filter,
      handler,
      closedFlag: false,
      close: () => {
        record.closedFlag = true;
        this.subscriptions.delete(id);
      },
      get overflowCount() {
        return 0;
      },
      get depth() {
        return 0;
      },
    };
    this.subscriptions.set(id, record);
    return record;
  }

  /** Push a synthetic event to every matching live subscription. */
  emit(event: BusEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.closedFlag) continue;
      if (sub.filter.agent_id && sub.filter.agent_id !== event.agent_id) continue;
      if (sub.filter.topics && sub.filter.topics.length > 0) {
        if (!sub.filter.topics.includes(event.topic)) continue;
      }
      sub.handler(event);
    }
  }

  async invokeSlashCommand(): Promise<void> {}
  ingestReply(): void {}
  ingestSessionEvent(): void {}
  ingestPermissionDecision(req: {
    agent_id: string;
    request_id: string;
    behavior: "allow" | "deny";
  }): void {
    this.permissionDecisions.push(req);
  }
  ingestAskAnswer(req: { agent_id: string; ask_id: string; answer: string }): void {
    this.askAnswers.push(req);
  }
  state() {
    return {
      subscriberCount: this.subscriptions.size,
      connectedAgents: [],
      totalOverflows: 0,
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/* ────────────────────────────────────────────────────────────────────── */
/* FakeTelegramApi                                                          */
/* ────────────────────────────────────────────────────────────────────── */

interface SendMessageCall {
  chat_id: number;
  text: string;
  message_thread_id?: number;
  reply_markup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
}

interface SetReactionCall {
  chat_id: number;
  message_id: number;
  emoji: string;
}

interface AnswerCallbackCall {
  callback_query_id: string;
  text?: string;
}

/**
 * Drives the adapter's long-poll without hitting the network. `getUpdates`
 * resolves to whatever batch is queued; if the queue is empty the call
 * waits on `signal` aborting (which `stop()` triggers) or a tiny tick so
 * tests can pump updates with `enqueueUpdates(...)`.
 */
class FakeTelegramApi implements TelegramApi {
  public readonly sendMessages: SendMessageCall[] = [];
  public readonly reactions: SetReactionCall[] = [];
  public readonly callbackAcks: AnswerCallbackCall[] = [];

  private nextUpdateId = 1;
  private readonly pending: TelegramUpdate[][] = [];
  /** Resolver for the in-flight `getUpdates` waiter (single-flight). */
  private waiter: ((batch: TelegramUpdate[]) => void) | null = null;

  async getUpdates(
    _offset: number,
    _timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<TelegramGetUpdatesResult> {
    const batch = this.pending.shift();
    if (batch !== undefined) {
      return { ok: true, result: batch };
    }
    // No batch ready — wait until either a batch is enqueued or the
    // adapter aborts the call from `stop()`.
    return new Promise<TelegramGetUpdatesResult>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.waiter = null;
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = (delivered: TelegramUpdate[]) => {
        signal.removeEventListener("abort", onAbort);
        this.waiter = null;
        resolve({ ok: true, result: delivered });
      };
    });
  }

  async sendMessage(
    params: SendMessageCall,
  ): Promise<{ ok: boolean; result?: { message_id: number } }> {
    this.sendMessages.push(params);
    return { ok: true, result: { message_id: 1000 + this.sendMessages.length } };
  }

  async setMessageReaction(params: SetReactionCall): Promise<{ ok: boolean }> {
    this.reactions.push(params);
    return { ok: true };
  }

  async answerCallbackQuery(params: AnswerCallbackCall): Promise<{ ok: boolean }> {
    this.callbackAcks.push(params);
    return { ok: true };
  }

  /**
   * Push a batch of updates into the queue. If a `getUpdates` call is
   * waiting, deliver to it immediately so the adapter loop unblocks.
   */
  enqueueUpdates(updates: Array<Omit<TelegramUpdate, "update_id">>): void {
    const stamped: TelegramUpdate[] = updates.map((u) => ({
      ...u,
      update_id: this.nextUpdateId++,
    }));
    if (this.waiter) {
      const w = this.waiter;
      w(stamped);
      return;
    }
    this.pending.push(stamped);
  }
}

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/* ────────────────────────────────────────────────────────────────────── */
/* Test harness                                                             */
/* ────────────────────────────────────────────────────────────────────── */

let bus: FakeBus;
let api: FakeTelegramApi;
let adapter: TelegramAdapter | null = null;

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

async function startAdapter(
  opts: Partial<ConstructorParameters<typeof TelegramAdapter>[0]> = {},
): Promise<TelegramAdapter> {
  const a = new TelegramAdapter({
    bus,
    token: "test-token",
    allowedUserIds: [42],
    routing: { chats: { "100": "triage" } },
    api,
    logger: SILENT_LOGGER,
    pollIntervalMs: 5,
    ...opts,
  });
  await a.start();
  return a;
}

beforeEach(() => {
  bus = new FakeBus();
  api = new FakeTelegramApi();
});

afterEach(async () => {
  if (adapter) {
    await adapter.stop();
    adapter = null;
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/* Pure helper                                                              */
/* ────────────────────────────────────────────────────────────────────── */

describe("extractReactionDirectives", () => {
  it("strips a single tag and surfaces the emoji", () => {
    const { cleanedText, emojis } = extractReactionDirectives("hello [react:👍] world");
    expect(cleanedText).toBe("hello  world");
    expect(emojis).toEqual(["👍"]);
  });

  it("strips multiple tags and surfaces every emoji", () => {
    const { cleanedText, emojis } = extractReactionDirectives(
      "[react:🦅]first line\nsecond [react:🪶]line",
    );
    expect(cleanedText).toBe("first line\nsecond line");
    expect(emojis).toEqual(["🦅", "🪶"]);
  });

  it("returns empty emojis array when no tag present", () => {
    const { cleanedText, emojis } = extractReactionDirectives("plain text");
    expect(cleanedText).toBe("plain text");
    expect(emojis).toEqual([]);
  });

  it("collapses runs of blank lines after tag removal", () => {
    const { cleanedText } = extractReactionDirectives("a\n\n\n\nb [react:👌]");
    expect(cleanedText).toBe("a\n\nb");
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Allow-list + routing                                                     */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — allow-list", () => {
  it("replies 'Unauthorized.' on private chat when sender is not allow-listed", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 999, is_bot: false },
          chat: { id: 100, type: "private" },
          text: "hi",
        },
      },
    ]);
    await waitFor(() => api.sendMessages.length > 0);
    const sent = api.sendMessages[0];
    expect(sent).toBeDefined();
    expect(sent?.text).toBe("Unauthorized.");
    expect(bus.prompts).toHaveLength(0);
  });

  it("silently drops messages from non-allow-listed users in non-private chats", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        message: {
          message_id: 2,
          from: { id: 999, is_bot: false },
          chat: { id: 100, type: "group" },
          text: "hi",
        },
      },
    ]);
    // Give the loop time to process — no reply should appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(api.sendMessages).toHaveLength(0);
    expect(bus.prompts).toHaveLength(0);
  });

  it("drops bot messages", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        message: {
          message_id: 3,
          from: { id: 42, is_bot: true },
          chat: { id: 100, type: "private" },
          text: "hi",
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.prompts).toHaveLength(0);
    expect(api.sendMessages).toHaveLength(0);
  });
});

describe("TelegramAdapter — routing", () => {
  it("uses chats[<chat_id>] when configured", async () => {
    adapter = await startAdapter({
      routing: { chats: { "100": "triage", "200": "research" } },
    });
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 200, type: "private" },
          text: "ping",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.agent_id).toBe("research");
  });

  it("falls back to defaultAgentId for unmapped chats", async () => {
    adapter = await startAdapter({
      routing: { chats: { "100": "triage" }, defaultAgentId: "global" },
    });
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 999, type: "private" },
          text: "ping",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.agent_id).toBe("global");
  });

  it("silent-drops when no route matches and no default agent set", async () => {
    adapter = await startAdapter({ routing: { chats: { "100": "triage" } } });
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 999, type: "private" },
          text: "ping",
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.prompts).toHaveLength(0);
    expect(api.sendMessages).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* sendPrompt shape                                                         */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — bus.sendPrompt shape", () => {
  it("forwards origin, ids, text and metadata", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        message: {
          message_id: 77,
          from: { id: 42, username: "terry" },
          chat: { id: 100, type: "private" },
          message_thread_id: 5,
          text: "  please help  ",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
    const sent = bus.prompts[0];
    expect(sent).toBeDefined();
    if (!sent) throw new Error("expected prompt captured");
    expect(sent.origin).toBe("telegram");
    expect(sent.origin_id).toBe("100");
    expect(sent.user_id).toBe("42");
    expect(sent.text).toBe("please help");
    expect(sent.agent_id).toBe("triage");
    expect(sent.metadata).toBeDefined();
    const meta = sent.metadata as Record<string, unknown>;
    expect(meta.message_id).toBe(77);
    expect(meta.message_thread_id).toBe(5);
  });

  it("carries photo + document + voice attachments in metadata", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          caption: "look at this",
          photo: [
            { file_id: "small", width: 100, height: 100, file_size: 1000 },
            { file_id: "big", width: 1000, height: 1000, file_size: 100_000 },
          ],
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
    const meta = bus.prompts[0]?.metadata as Record<string, unknown>;
    const attachments = meta.attachments as Array<Record<string, unknown>>;
    expect(attachments).toBeDefined();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.kind).toBe("photo");
    expect(attachments[0]?.file_id).toBe("big");
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* response.text → sendMessage                                              */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — response.text outbound", () => {
  async function feedInbound(): Promise<void> {
    api.enqueueUpdates([
      {
        message: {
          message_id: 50,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "hello",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
  }

  it("posts plain text via sendMessage", async () => {
    adapter = await startAdapter();
    await feedInbound();

    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "hi there" },
    });
    await waitFor(() => api.sendMessages.length > 0);
    const sent = api.sendMessages[0];
    expect(sent).toBeDefined();
    expect(sent?.text).toBe("hi there");
    expect(sent?.chat_id).toBe(100);
  });

  it("strips [react:<emoji>] tags and applies them via setMessageReaction", async () => {
    adapter = await startAdapter();
    await feedInbound();

    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "on it [react:🪶]" },
    });
    await waitFor(() => api.sendMessages.length > 0 && api.reactions.length > 0);
    expect(api.sendMessages[0]?.text).toBe("on it");
    const reaction = api.reactions[0];
    expect(reaction).toBeDefined();
    expect(reaction?.emoji).toBe("🪶");
    expect(reaction?.message_id).toBe(50);
    expect(reaction?.chat_id).toBe(100);
  });

  it("ignores response.text for an unrelated agent", async () => {
    adapter = await startAdapter();
    await feedInbound();
    bus.emit({
      ts: Date.now(),
      agent_id: "other-agent",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "should not surface" },
    });
    // Tiny tick; the bus shouldn't deliver to our adapter's filter.
    await new Promise((r) => setTimeout(r, 30));
    expect(api.sendMessages).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Permission flow                                                          */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — permission flow", () => {
  it("sends an inline keyboard for channel.permission_request", async () => {
    adapter = await startAdapter();
    // Seed a chat target so the adapter knows where to render the prompt.
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "ping",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);

    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "abcde",
        tool_name: "bash",
        description: "run `ls`",
        input_preview: "ls -la",
      },
    });
    await waitFor(() => api.sendMessages.length >= 1);
    const prompt = api.sendMessages[0];
    expect(prompt).toBeDefined();
    expect(prompt?.reply_markup?.inline_keyboard).toBeDefined();
    const buttons = prompt?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.callback_data).toBe("perm:allow:abcde");
    expect(buttons[1]?.callback_data).toBe("perm:deny:abcde");
  });

  it("routes callback_query through bus.ingestPermissionDecision", async () => {
    adapter = await startAdapter();
    // Inbound prompt to anchor target chat.
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "ping",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);

    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "qwert",
        tool_name: "bash",
        description: "",
        input_preview: "",
      },
    });
    await waitFor(() => api.sendMessages.length >= 1);

    api.enqueueUpdates([
      {
        callback_query: {
          id: "cb1",
          from: { id: 42 },
          data: "perm:allow:qwert",
          message: {
            message_id: 9999,
            chat: { id: 100, type: "private" },
          },
        },
      },
    ]);
    await waitFor(() => bus.permissionDecisions.length > 0);
    const decision = bus.permissionDecisions[0];
    expect(decision).toBeDefined();
    expect(decision?.agent_id).toBe("triage");
    expect(decision?.request_id).toBe("qwert");
    expect(decision?.behavior).toBe("allow");

    // Confirm the spinner was answered.
    expect(api.callbackAcks).toHaveLength(1);
    expect(api.callbackAcks[0]?.callback_query_id).toBe("cb1");
  });

  it("rejects callback_query from non-allow-listed users", async () => {
    adapter = await startAdapter();
    api.enqueueUpdates([
      {
        callback_query: {
          id: "cb2",
          from: { id: 999 },
          data: "perm:allow:qwert",
        },
      },
    ]);
    await waitFor(() => api.callbackAcks.length > 0);
    expect(api.callbackAcks[0]?.text).toBe("Unauthorized.");
    expect(bus.permissionDecisions).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* request_human flow                                                       */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — allow-list semantics (PR #113 review)", () => {
  it("empty allowedUserIds = allow all (legacy parity)", async () => {
    adapter = await startAdapter({ allowedUserIds: [] });
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 9999 }, // not in any list
          chat: { id: 100, type: "private" },
          text: "anyone home?",
        },
      },
    ]);
    // Should reach the bus (allowed because list is empty), NOT bounce
    // with "Unauthorized.".
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
    const unauthorisedReplies = api.sendMessages.filter((m) => m.text === "Unauthorized.");
    expect(unauthorisedReplies).toHaveLength(0);
  });

  it("non-empty allowedUserIds with no match still rejects", async () => {
    adapter = await startAdapter({ allowedUserIds: [42] });
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 9999 },
          chat: { id: 100, type: "private" },
          text: "trying again",
        },
      },
    ]);
    await waitFor(() => api.sendMessages.length > 0);
    expect(api.sendMessages[0]?.text).toBe("Unauthorized.");
    expect(bus.prompts).toHaveLength(0);
  });
});

describe("TelegramAdapter — request_human keying (PR #113 review)", () => {
  it("uses composite (agent_id, chat_id) key so multi-agent doesn't collide", async () => {
    // Two agents routed to two different chats. Each agent gets its own
    // pending ask; resolving one doesn't clear the other.
    adapter = await startAdapter({
      routing: { chats: { "100": "triage", "200": "research" } },
    });
    // Seed a prompt for each agent so `lastChatPerAgent` is populated.
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "p1",
        },
      },
      {
        message: {
          message_id: 2,
          from: { id: 42 },
          chat: { id: 200, type: "private" },
          text: "p2",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length >= 2);

    // Two simultaneous request_human, one per agent, both visible at the
    // same time — keying by chat_id alone would clobber one of them.
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.request_human",
      payload: { ask_id: "ask-triage", question: "Q1?" },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "research",
      session_id: "s2",
      topic: "system.request_human",
      payload: { ask_id: "ask-research", question: "Q2?" },
    });
    await waitFor(() => api.sendMessages.length >= 2);

    // Resolve triage's ask via chat 100 — research's ask should remain.
    api.enqueueUpdates([
      {
        message: {
          message_id: 3,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "triage-answer",
        },
      },
    ]);
    await waitFor(() => bus.askAnswers.length >= 1);
    expect(bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-triage",
      answer: "triage-answer",
    });

    // Now resolve research's ask via chat 200.
    api.enqueueUpdates([
      {
        message: {
          message_id: 4,
          from: { id: 42 },
          chat: { id: 200, type: "private" },
          text: "research-answer",
        },
      },
    ]);
    await waitFor(() => bus.askAnswers.length >= 2);
    expect(bus.askAnswers[1]).toEqual({
      agent_id: "research",
      ask_id: "ask-research",
      answer: "research-answer",
    });
  });
});

describe("TelegramAdapter — request_human flow", () => {
  it("emits a question message and routes the next operator reply via ingestAskAnswer", async () => {
    adapter = await startAdapter();
    // Anchor a target chat for the agent.
    api.enqueueUpdates([
      {
        message: {
          message_id: 1,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "ping",
        },
      },
    ]);
    await waitFor(() => bus.prompts.length > 0);
    const initialPromptCount = bus.prompts.length;

    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "Which env?" },
    });
    await waitFor(() => api.sendMessages.length >= 1);
    expect(api.sendMessages[0]?.text).toContain("Which env?");

    // Operator replies — should resolve the ask, NOT spawn a new prompt.
    api.enqueueUpdates([
      {
        message: {
          message_id: 2,
          from: { id: 42 },
          chat: { id: 100, type: "private" },
          text: "production",
        },
      },
    ]);
    await waitFor(() => bus.askAnswers.length > 0);
    expect(bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-1",
      answer: "production",
    });
    // No new sendPrompt was issued (still at the seed count).
    expect(bus.prompts.length).toBe(initialPromptCount);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* stop() cleanup                                                           */
/* ────────────────────────────────────────────────────────────────────── */

describe("TelegramAdapter — stop()", () => {
  it("closes every subscription so bus.state().subscriberCount returns to 0", async () => {
    adapter = await startAdapter({
      routing: { chats: { "100": "triage", "200": "research" } },
    });
    // Two agents × four topics (text, edit_text, permission, request_human) = eight.
    expect(bus.state().subscriberCount).toBe(8);
    await adapter.stop();
    adapter = null;
    expect(bus.state().subscriberCount).toBe(0);
  });

  it("does not throw when stop() is called twice", async () => {
    adapter = await startAdapter();
    await adapter.stop();
    await adapter.stop();
    adapter = null;
  });

  it("aborts an in-flight long-poll so stop() returns promptly", async () => {
    adapter = await startAdapter({ pollIntervalMs: 50 });
    // No updates queued — the loop is now parked in `getUpdates`.
    const start = Date.now();
    await adapter.stop();
    const elapsed = Date.now() - start;
    adapter = null;
    expect(elapsed).toBeLessThan(500);
  });
});
