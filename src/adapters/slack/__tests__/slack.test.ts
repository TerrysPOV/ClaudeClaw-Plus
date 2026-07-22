/**
 * Tests for `src/adapters/slack/index.ts` (Sprint 4 Agent A).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 *
 * Run with: `bun test src/adapters/slack/__tests__/slack.test.ts`
 *
 * Strategy mirrors the Telegram / Discord adapter suites:
 *   - `FakeBus` implements the public `BusCore` interface so we can assert
 *     on `sendPrompt` / `ingestPermissionDecision` / `ingestAskAnswer`
 *     calls without spinning up the real IPC stack.
 *   - `FakeSlackApi` implements the `SlackApi` seam — never touches
 *     `slack.com/api/*`.
 *   - `FakeSlackSocket` implements `SlackSocketLike` so we can drive
 *     inbound envelopes deterministically.
 *
 * Coverage targets (spec §5.5.3):
 *   - allow-list: empty = allow all; populated + match = allow; populated
 *     + miss = silent skip
 *   - Channel routing → correct agent_id
 *   - Thread routing
 *   - bus.sendPrompt shape correct
 *   - response.text posts back
 *   - Permission flow: block_actions click → ingestPermissionDecision
 *   - request_human first-reply-wins
 *   - Map composite keying: two agents in same channel don't collide
 *   - stop() cleans all maps
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID, createHmac } from "node:crypto";
import {
  SlackAdapter,
  buildPermissionBlocks,
  PERMISSION_ACTION_ID_REGEX,
  mdToSlackMrkdwn,
  defangSlackMentions,
} from "../index";
import type { BusCore, SendPromptRequest } from "../../../bus/core";
import type {
  Subscription,
  SubscriptionFilter,
  SubscriptionHandler,
} from "../../../bus/core-subscription";
import { type BusEvent, TAILER_EVENT_SOURCE } from "../../../bus/types";
import type {
  SlackApi,
  SlackBlock,
  SlackBlockActionsPayload,
  SlackMessageEvent,
  SlackSocketEnvelope,
  SlackSocketLike,
} from "../types";

// Test-only fake tokens. Slack's real prefixes are intentionally NOT used
// here so the secret-scanner pre-commit hook (block-secrets-in-code.sh)
// doesn't false-positive on the test file.
const FAKE_BOT_TOKEN = "fake-bot-token";
const FAKE_SIGNING_SECRET = "test-secret";

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
/* FakeSlackApi + FakeSlackSocket                                            */
/* ────────────────────────────────────────────────────────────────────── */

interface PostMessageCall {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
}

class FakeSlackApi implements SlackApi {
  public readonly sent: PostMessageCall[] = [];
  public forceError: string | null = null;

  async postMessage(params: PostMessageCall): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
  }> {
    this.sent.push(params);
    if (this.forceError) return { ok: false, error: this.forceError };
    return { ok: true, ts: `1234.${this.sent.length}` };
  }
}

class FakeSlackSocket implements SlackSocketLike {
  public started = false;
  public stopped = false;
  public readonly acks: Array<{ envelopeId: string; payload?: unknown }> = [];
  private handlers: Array<(env: SlackSocketEnvelope) => void> = [];

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.handlers = [];
  }
  onEnvelope(handler: (env: SlackSocketEnvelope) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  ack(envelopeId: string, payload?: unknown): void {
    this.acks.push({ envelopeId, payload });
  }
  /** Test-only: push an envelope as if it came over the wire. */
  push(env: SlackSocketEnvelope): void {
    for (const h of this.handlers) h(env);
  }
}

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/* ────────────────────────────────────────────────────────────────────── */
/* Harness                                                                   */
/* ────────────────────────────────────────────────────────────────────── */

let bus: FakeBus;
let api: FakeSlackApi;
let socket: FakeSlackSocket;
let adapter: SlackAdapter | null = null;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

async function startAdapter(
  opts: Partial<ConstructorParameters<typeof SlackAdapter>[0]> = {},
): Promise<SlackAdapter> {
  const a = new SlackAdapter({
    bus,
    token: FAKE_BOT_TOKEN,
    signingSecret: FAKE_SIGNING_SECRET,
    allowedUserIds: ["U42"],
    routing: { channels: { C100: "triage" } },
    api,
    socket,
    logger: SILENT_LOGGER,
    ...opts,
  });
  await a.start();
  return a;
}

function msg(over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  // Honour explicit `user: undefined` (used by bot-message tests) — `??`
  // would otherwise back-fill the default. `in` check distinguishes
  // "key absent" from "key present with undefined".
  const user = "user" in over ? over.user : "U42";
  return {
    type: over.type ?? "message",
    channel: over.channel ?? "C100",
    user,
    ts: over.ts ?? "1700000000.000100",
    text: over.text ?? "hello",
    thread_ts: over.thread_ts,
    bot_id: over.bot_id,
    subtype: over.subtype,
    files: over.files,
    // Issue #121 fields — forward when set so the new test cases can
    // exercise allowBots, block / attachment extraction, and per-bot
    // display-name routing.
    username: over.username,
    bot_profile: over.bot_profile,
    blocks: over.blocks,
    attachments: over.attachments,
  };
}

function eventsEnvelope(event: SlackMessageEvent): SlackSocketEnvelope {
  return {
    type: "events_api",
    envelope_id: `env-${randomUUID()}`,
    payload: { event } as SlackSocketEnvelope["payload"],
  };
}

function blockActionsEnvelope(payload: SlackBlockActionsPayload): SlackSocketEnvelope {
  return {
    type: "interactive",
    envelope_id: `env-${randomUUID()}`,
    payload: payload as unknown as SlackSocketEnvelope["payload"],
  };
}

beforeEach(() => {
  bus = new FakeBus();
  api = new FakeSlackApi();
  socket = new FakeSlackSocket();
});

afterEach(async () => {
  if (adapter) {
    await adapter.stop();
    adapter = null;
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/* buildPermissionBlocks                                                     */
/* ────────────────────────────────────────────────────────────────────── */

describe("buildPermissionBlocks", () => {
  it("produces section + actions with two perm:<behavior>:<agent>:<id> buttons", () => {
    const blocks = buildPermissionBlocks(
      {
        request_id: "abcde",
        tool_name: "bash",
        description: "run `ls`",
        input_preview: "ls -la",
      },
      "triage",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("section");
    const actions = blocks[1];
    if (actions?.type !== "actions") throw new Error("expected actions block");
    expect(actions.elements).toHaveLength(2);
    // Codex P1 fix on PR #117: agent_id embedded so the callback can
    // look up the exact pendingPermissions composite key without scanning.
    expect(actions.elements[0]?.action_id).toBe("perm:allow:triage:abcde");
    expect(actions.elements[1]?.action_id).toBe("perm:deny:triage:abcde");
  });

  it("PERMISSION_ACTION_ID_REGEX captures behavior, agent_id, request_id", () => {
    const allow = "perm:allow:triage:xyzab".match(PERMISSION_ACTION_ID_REGEX);
    expect(allow?.[1]).toBe("allow");
    expect(allow?.[2]).toBe("triage");
    expect(allow?.[3]).toBe("xyzab");
    const deny = "perm:deny:research:xyzab".match(PERMISSION_ACTION_ID_REGEX);
    expect(deny?.[1]).toBe("deny");
    expect(deny?.[2]).toBe("research");
    expect(deny?.[3]).toBe("xyzab");
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Allow-list (PR #113 review)                                               */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — allow-list semantics", () => {
  it("empty allowedUserIds = allow all (legacy parity)", async () => {
    adapter = await startAdapter({ allowedUserIds: [] });
    socket.push(eventsEnvelope(msg({ user: "U-stranger", text: "anyone home?" })));
    await flushMicrotasks();
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
    expect(bus.prompts[0]?.user_id).toBe("U-stranger");
  });

  it("populated allowedUserIds + match = allow", async () => {
    adapter = await startAdapter({ allowedUserIds: ["U42"] });
    socket.push(eventsEnvelope(msg({ user: "U42", text: "hi" })));
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
  });

  it("populated allowedUserIds + miss = silent skip (no Unauthorized reply)", async () => {
    adapter = await startAdapter({ allowedUserIds: ["U42"] });
    socket.push(eventsEnvelope(msg({ user: "U-stranger", text: "let me in" })));
    // Give the adapter time to silently skip.
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
    // Crucially, NO chat.postMessage reply — Slack is multi-channel so
    // we can't safely DM-bomb every unauthorised user.
    expect(api.sent).toHaveLength(0);
  });

  it("drops bot messages", async () => {
    adapter = await startAdapter();
    socket.push(eventsEnvelope(msg({ bot_id: "B-bot", user: undefined })));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
    expect(api.sent).toHaveLength(0);
  });

  it("drops message subtypes other than file_share (matches legacy line 945)", async () => {
    adapter = await startAdapter();
    socket.push(eventsEnvelope(msg({ subtype: "message_changed" })));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Routing                                                                    */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — routing", () => {
  it("maps channels[<channel>] to the right agent_id", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    socket.push(eventsEnvelope(msg({ channel: "C200", text: "research ping" })));
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.agent_id).toBe("research");
  });

  it("silent-drops messages from unrouted channels with no threadAgentId", async () => {
    adapter = await startAdapter({ routing: { channels: { C100: "triage" } } });
    socket.push(eventsEnvelope(msg({ channel: "C999", text: "drift" })));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });

  it("thread reply with no recorded owner uses parent channel mapping", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage" } },
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          text: "reply in thread",
          ts: "1700000000.000200",
          thread_ts: "1700000000.000100",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.agent_id).toBe("triage");
    const meta = bus.prompts[0]?.metadata as Record<string, unknown>;
    expect(meta.thread_ts).toBe("1700000000.000100");
  });

  it("threadAgentId routes thread-only traffic in unrouted channels", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage" }, threadAgentId: "threaded" },
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C999", // not in channels map
          thread_ts: "1700000000.000100",
          ts: "1700000000.000200",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.agent_id).toBe("threaded");
  });

  it("subsequent thread replies inherit the original thread owner", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    // First message in thread inside C100 → records "triage" ownership.
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          text: "kickoff",
          ts: "1700000000.000100",
          thread_ts: "1700000000.000100",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    // Second message — same thread_ts, same channel — should still go
    // to triage. (Trivial in this test but proves the cache is wired.)
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          text: "followup",
          ts: "1700000000.000200",
          thread_ts: "1700000000.000100",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length >= 2);
    expect(bus.prompts[1]?.agent_id).toBe("triage");
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* sendPrompt shape                                                           */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — bus.sendPrompt shape", () => {
  it("forwards origin=slack with channel as origin_id and trimmed text", async () => {
    adapter = await startAdapter();
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: "U42",
          text: "   please help   ",
          ts: "1700000000.000123",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    const sent = bus.prompts[0];
    if (!sent) throw new Error("expected prompt captured");
    expect(sent.origin).toBe("slack");
    expect(sent.origin_id).toBe("C100");
    expect(sent.user_id).toBe("U42");
    expect(sent.text).toBe("please help");
    expect(sent.agent_id).toBe("triage");
    const meta = sent.metadata as Record<string, unknown>;
    expect(meta.ts).toBe("1700000000.000123");
  });

  it("carries file metadata when present", async () => {
    adapter = await startAdapter();
    socket.push(
      eventsEnvelope(
        msg({
          text: "look at this",
          files: [
            {
              id: "F1",
              name: "shot.png",
              mimetype: "image/png",
              filetype: "png",
              size: 1024,
              url_private: "https://files.slack.com/F1",
            },
          ],
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    const meta = bus.prompts[0]?.metadata as Record<string, unknown>;
    const files = meta.files as Array<Record<string, unknown>>;
    expect(files).toBeDefined();
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe("F1");
    expect(files[0]?.mimetype).toBe("image/png");
  });

  it("drops empty messages with no files", async () => {
    adapter = await startAdapter();
    socket.push(eventsEnvelope(msg({ text: "   " })));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* response.text outbound                                                     */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — response.text outbound", () => {
  it("posts text via chat.postMessage to routed channels", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "on it" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.channel).toBe("C100");
    expect(api.sent[0]?.text).toBe("on it");
  });

  it("prefixes the synthesized notice on a safety-net delivery (#240)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "raw turn output", intent: "final", synthesized: true },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.text.startsWith("⚠️")).toBe(true);
    expect(api.sent[0]?.text).toContain("without sending a reply");
    expect(api.sent[0]?.text).toContain("raw turn output");
  });

  it("ignores response.text for an unrelated agent", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "other-agent",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "should not surface" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(api.sent).toHaveLength(0);
  });

  it("routes non-channel-driven origins to primaryChannelByAgent when configured", async () => {
    // Mirror of the discord fix: heartbeat/cron broadcasts to every routed
    // channel was spamming users in multi-channel setups. Opt-in primary
    // channel narrows the fan-out per agent.
    adapter = await startAdapter({
      routing: {
        channels: { C100: "triage", C200: "triage" },
        primaryChannelByAgent: { triage: "C100" },
      },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "heartbeat tick", origin: "heartbeat", origin_id: "hb" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent.map((m) => m.channel)).toEqual(["C100"]);
  });

  it("falls back to fan-out when primaryChannelByAgent is unset for the agent", async () => {
    adapter = await startAdapter({
      routing: {
        channels: { C100: "triage", C200: "triage" },
        primaryChannelByAgent: { other: "C100" }, // not for "triage"
      },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "cron tick", origin: "cron", origin_id: "job:morning" },
    });
    await waitFor(() => api.sent.length >= 2);
    expect(api.sent.map((m) => m.channel).sort()).toEqual(["C100", "C200"]);
  });

  it("subscribes agents listed only in primaryChannelByAgent (Codex P2 #151)", async () => {
    // Parser allows config that mentions an agent only in
    // primaryChannelByAgent. Adapter must subscribe that agent or outbound
    // events never reach Slack.
    adapter = await startAdapter({
      routing: {
        channels: { C100: "triage" },
        primaryChannelByAgent: { "scheduler-only": "C500" },
      },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "scheduler-only",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "scheduler tick", origin: "cron", origin_id: "job:nightly" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent.map((m) => m.channel)).toEqual(["C500"]);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Permission flow                                                            */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — permission flow", () => {
  it("renders Block Kit blocks on channel.permission_request", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "abcde",
        tool_name: "bash",
        description: "run ls",
        input_preview: "ls -la",
      },
    });
    await waitFor(() => api.sent.length > 0);
    const sent = api.sent[0];
    expect(sent?.channel).toBe("C100");
    expect(sent?.blocks).toBeDefined();
    const actions = sent?.blocks?.[1];
    if (actions?.type !== "actions") throw new Error("expected actions block");
    expect(actions.elements[0]?.action_id).toBe("perm:allow:triage:abcde");
    expect(actions.elements[1]?.action_id).toBe("perm:deny:triage:abcde");
  });

  it("routes block_actions click through bus.ingestPermissionDecision", async () => {
    adapter = await startAdapter();
    // Seed the pending permission.
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
    await waitFor(() => api.sent.length > 0);

    socket.push(
      blockActionsEnvelope({
        type: "block_actions",
        user: { id: "U42" },
        channel: { id: "C100" },
        message: { ts: "1700000000.000100" },
        actions: [{ action_id: "perm:allow:triage:qwert", type: "button", value: "allow" }],
      }),
    );
    await waitFor(() => bus.permissionDecisions.length > 0);
    const decision = bus.permissionDecisions[0];
    expect(decision?.agent_id).toBe("triage");
    expect(decision?.request_id).toBe("qwert");
    expect(decision?.behavior).toBe("allow");
    // Confirmation message posted as second send.
    expect(api.sent[1]?.text).toBe("✅ Allowed");
  });

  it("silently drops block_actions from non-allow-listed users", async () => {
    adapter = await startAdapter({ allowedUserIds: ["U42"] });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "stale",
        tool_name: "bash",
        description: "",
        input_preview: "",
      },
    });
    await waitFor(() => api.sent.length > 0);
    const seenBefore = api.sent.length;

    socket.push(
      blockActionsEnvelope({
        type: "block_actions",
        user: { id: "U-stranger" },
        channel: { id: "C100" },
        actions: [{ action_id: "perm:allow:triage:stale", type: "button", value: "allow" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.permissionDecisions).toHaveLength(0);
    // No confirmation message posted.
    expect(api.sent.length).toBe(seenBefore);
  });

  it("auto-acks every envelope back to socket", async () => {
    adapter = await startAdapter();
    const env = eventsEnvelope(msg({ text: "hi" }));
    socket.push(env);
    await flushMicrotasks();
    expect(socket.acks).toHaveLength(1);
    expect(socket.acks[0]?.envelopeId).toBe(env.envelope_id);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* request_human flow                                                         */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — request_human first-reply-wins", () => {
  it("posts the question and routes the next reply via ingestAskAnswer", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "Which env?" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.text).toContain("Which env?");

    socket.push(eventsEnvelope(msg({ user: "U42", text: "production" })));
    await waitFor(() => bus.askAnswers.length > 0);
    expect(bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-1",
      answer: "production",
    });
    // sendPrompt was NOT called — the reply consumed the ask.
    expect(bus.prompts).toHaveLength(0);
  });

  it("only the FIRST reply wins; subsequent replies fall through to sendPrompt", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.request_human",
      payload: { ask_id: "ask-99", question: "Yes or no?" },
    });
    await waitFor(() => api.sent.length > 0);

    socket.push(eventsEnvelope(msg({ text: "yes", ts: "1.001" })));
    await waitFor(() => bus.askAnswers.length > 0);
    socket.push(eventsEnvelope(msg({ text: "second message", ts: "1.002" })));
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.askAnswers).toHaveLength(1);
    expect(bus.prompts).toHaveLength(1);
    expect(bus.prompts[0]?.text).toBe("second message");
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Composite keying (PR #113 review)                                          */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — composite keying (PR #113 review)", () => {
  it("two agents in two channels: pendingHumanAsks don't collide", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage", C200: "research" } },
    });

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
    await waitFor(() => api.sent.length >= 2);

    socket.push(eventsEnvelope(msg({ channel: "C100", user: "U42", text: "triage-answer" })));
    await waitFor(() => bus.askAnswers.length >= 1);
    expect(bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-triage",
      answer: "triage-answer",
    });

    socket.push(eventsEnvelope(msg({ channel: "C200", user: "U42", text: "research-answer" })));
    await waitFor(() => bus.askAnswers.length >= 2);
    expect(bus.askAnswers[1]).toEqual({
      agent_id: "research",
      ask_id: "ask-research",
      answer: "research-answer",
    });
  });

  it("two pending permissions in two channels survive independently", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "req-1",
        tool_name: "bash",
        description: "",
        input_preview: "",
      },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "research",
      session_id: "s2",
      topic: "channel.permission_request",
      payload: {
        request_id: "req-2",
        tool_name: "bash",
        description: "",
        input_preview: "",
      },
    });
    await waitFor(() => api.sent.length >= 2);

    // Resolve req-1 from C100.
    socket.push(
      blockActionsEnvelope({
        type: "block_actions",
        user: { id: "U42" },
        channel: { id: "C100" },
        actions: [{ action_id: "perm:allow:triage:req-1", type: "button", value: "allow" }],
      }),
    );
    await waitFor(() => bus.permissionDecisions.length >= 1);
    expect(bus.permissionDecisions[0]).toEqual({
      agent_id: "triage",
      request_id: "req-1",
      behavior: "allow",
    });

    // Resolve req-2 from C200 — independent.
    socket.push(
      blockActionsEnvelope({
        type: "block_actions",
        user: { id: "U42" },
        channel: { id: "C200" },
        actions: [{ action_id: "perm:deny:research:req-2", type: "button", value: "deny" }],
      }),
    );
    await waitFor(() => bus.permissionDecisions.length >= 2);
    expect(bus.permissionDecisions[1]).toEqual({
      agent_id: "research",
      request_id: "req-2",
      behavior: "deny",
    });
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Events API HTTP path                                                       */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — Events API HTTP", () => {
  it("returns the challenge string for url_verification", async () => {
    adapter = await startAdapter();
    const result = await adapter.handleEventsApiRequest({
      type: "url_verification",
      challenge: "deadbeef",
    });
    expect(result).toBe("deadbeef");
    expect(bus.prompts).toHaveLength(0);
  });

  it("routes event_callback envelopes through the normal message handler", async () => {
    adapter = await startAdapter();
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event: msg({ text: "hi via http" }),
    });
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("hi via http");
  });

  it("verifyEventsApiSignature accepts a valid signature and rejects tampering", async () => {
    adapter = await startAdapter();
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const base = `v0:${timestamp}:${body}`;
    const good = `v0=${createHmac("sha256", FAKE_SIGNING_SECRET).update(base).digest("hex")}`;

    expect(adapter.verifyEventsApiSignature({ body, timestamp, signature: good })).toBe(true);

    // Tampered body — same signature, different body
    expect(
      adapter.verifyEventsApiSignature({
        body: `${body}x`,
        timestamp,
        signature: good,
      }),
    ).toBe(false);

    // Stale timestamp (>5 min) with valid signature for that stale body
    const stale = String(Math.floor(Date.now() / 1000) - 1000);
    const staleBase = `v0:${stale}:${body}`;
    const staleSig = `v0=${createHmac("sha256", FAKE_SIGNING_SECRET).update(staleBase).digest("hex")}`;
    expect(
      adapter.verifyEventsApiSignature({
        body,
        timestamp: stale,
        signature: staleSig,
      }),
    ).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* stop() cleanup                                                             */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — stop() cleanup", () => {
  it("closes every subscription so bus.state().subscriberCount returns to 0", async () => {
    adapter = await startAdapter({
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    // Two agents × three topics = six subscriptions.
    // 2 agents x 4 subscriptions (response.text, permission_request,
    // request_human, operator_alert #325).
    expect(bus.state().subscriberCount).toBe(8);
    await adapter.stop();
    adapter = null;
    expect(bus.state().subscriberCount).toBe(0);
  });

  it("clears every pending map (permissions, asks, thread owners)", async () => {
    adapter = await startAdapter();
    // Seed permission_request → fills pendingPermissions.
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "channel.permission_request",
      payload: {
        request_id: "abcde",
        tool_name: "bash",
        description: "",
        input_preview: "",
      },
    });
    // Seed a thread message → fills threadOwners.
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "1.001", ts: "1.001", text: "kickoff" })),
    );
    await waitFor(() => api.sent.length >= 1);
    await waitFor(() => bus.prompts.length >= 1);
    // Seed request_human AFTER the inbound so we don't accidentally
    // consume the pending ask with the kickoff message.
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "?" },
    });
    await waitFor(() => api.sent.length >= 2);

    await adapter.stop();
    adapter = null;
    expect(socket.stopped).toBe(true);
    // After stop, the subscription count should be 0 (asserted in the
    // previous test). Any further bus emits should NOT trigger API
    // calls because the subscriptions are closed.
    const sentBefore = api.sent.length;
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "post-stop" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.sent.length).toBe(sentBefore);
  });

  it("does not throw when stop() is called twice", async () => {
    adapter = await startAdapter();
    await adapter.stop();
    await adapter.stop();
    adapter = null;
  });

  it("stop() unwires the socket cleanly", async () => {
    adapter = await startAdapter();
    await adapter.stop();
    adapter = null;
    expect(socket.stopped).toBe(true);
    // Late envelopes should be silently dropped — FakeSlackSocket clears
    // its handlers on stop(), so push is a no-op.
    socket.push(eventsEnvelope(msg({ text: "post-stop event" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(bus.prompts).toHaveLength(0);
  });
});

describe("SlackAdapter — start() rollback on socket failure (PR #117 review)", () => {
  it("rolls back started state + tears down subscriptions when socket.start throws", async () => {
    // Codex P2 fix on PR #117: an earlier socket.start() rejection
    // left this.started=true and subscriptions registered, so retries
    // returned immediately and never reconnected.
    const failingSocket: SlackSocketLike = {
      async start() {
        throw new Error("transient auth glitch");
      },
      async stop() {},
      onEnvelope() {
        return () => {};
      },
      ack() {},
    };

    const opts: ConstructorParameters<typeof SlackAdapter>[0] = {
      bus,
      token: "fake-test-token",
      signingSecret: "shh",
      allowedUserIds: [],
      routing: { channels: { C100: "triage" } },
      api,
      socket: failingSocket,
      logger: SILENT_LOGGER,
    };
    const a = new SlackAdapter(opts);
    await expect(a.start()).rejects.toThrow(/transient auth glitch/);

    // After the failure, subscriptions should be cleared so the next
    // retry can subscribe fresh + reconnect.
    expect(bus.state().subscriberCount).toBe(0);

    // And retrying start() with a working socket should now succeed.
    const okSocket = new FakeSlackSocket();
    const a2 = new SlackAdapter({ ...opts, socket: okSocket });
    await a2.start();
    expect(okSocket.started).toBe(true);
    await a2.stop();
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* PR #117 review — Agent #2 HIGH findings                                  */
/* ────────────────────────────────────────────────────────────────────── */

describe("SlackAdapter — Events API retry dedup (PR #117 review)", () => {
  // Slack retries `event_callback` deliveries up to 3 times on 3xx/5xx
  // ack failures, replaying the same `event_id`. Agent #2 flagged that
  // the adapter had no dedup, so a slow `chat.postMessage` could fire
  // the same permission flow / sendPrompt twice.

  it("processes the first delivery and drops retries with the same event_id", async () => {
    adapter = await startAdapter();
    const envelope = {
      type: "event_callback" as const,
      event_id: "Ev01ABCDEF",
      event: msg({ text: "first delivery" }),
    };
    await adapter.handleEventsApiRequest(envelope);
    await adapter.handleEventsApiRequest(envelope);
    await adapter.handleEventsApiRequest(envelope);
    await flushMicrotasks();
    expect(bus.prompts).toHaveLength(1);
    expect(bus.prompts[0]?.text).toBe("first delivery");
  });

  it("returns the challenge for url_verification even if dedup cache is warm", async () => {
    adapter = await startAdapter();
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event_id: "Ev01",
      event: msg({ text: "warm" }),
    });
    const result = await adapter.handleEventsApiRequest({
      type: "url_verification",
      challenge: "deadbeef",
    });
    expect(result).toBe("deadbeef");
  });

  it("missing event_id falls through to processing (no defensive drop)", async () => {
    adapter = await startAdapter();
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event: msg({ text: "no event_id" }),
    });
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event: msg({ text: "still no event_id" }),
    });
    await flushMicrotasks();
    expect(bus.prompts).toHaveLength(2);
  });

  it("evicts oldest entries past maxSeenEventIds", async () => {
    adapter = await startAdapter({ maxSeenEventIds: 2 });
    // Three distinct event_ids; the first is evicted after the third
    // arrives. Re-delivering the first should now process again.
    for (const id of ["E1", "E2", "E3"]) {
      await adapter.handleEventsApiRequest({
        type: "event_callback",
        event_id: id,
        event: msg({ text: id, ts: `170000000${id}.0` }),
      });
    }
    // Re-deliver E1 — it should be processed again because evicted.
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event_id: "E1",
      event: msg({ text: "E1 redelivery", ts: "1700000001.0" }),
    });
    await flushMicrotasks();
    // 3 originals + 1 redelivery for E1 (evicted), but NOT the dedup
    // for E2/E3 which would still be live.
    expect(bus.prompts.length).toBe(4);
  });

  it("stop() clears the dedup cache so a restarted adapter forgets retries", async () => {
    adapter = await startAdapter();
    await adapter.handleEventsApiRequest({
      type: "event_callback",
      event_id: "Ev-restart",
      event: msg({ text: "before stop" }),
    });
    await adapter.stop();
    adapter = null;

    const a2 = await startAdapter();
    await a2.handleEventsApiRequest({
      type: "event_callback",
      event_id: "Ev-restart",
      event: msg({ text: "after restart" }),
    });
    await flushMicrotasks();
    // Two prompts total: one before stop, one after. Cache was cleared.
    expect(bus.prompts.length).toBe(2);
    expect(bus.prompts[1]?.text).toBe("after restart");
    await a2.stop();
  });
});

describe("SlackAdapter — threadOwners LRU bound (PR #117 review)", () => {
  // Agent #2 flagged unbounded growth of the thread-ownership cache for
  // long-running daemons. The adapter now enforces an LRU cap.

  it("evicts the oldest thread when size exceeds maxThreadOwners", async () => {
    adapter = await startAdapter({
      maxThreadOwners: 2,
      routing: { channels: { C100: "triage" } },
    });

    // Seed 3 distinct threads. After the 3rd, the 1st should be evicted.
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T1", ts: "T1.r1", text: "thread 1" })),
    );
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T2", ts: "T2.r1", text: "thread 2" })),
    );
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T3", ts: "T3.r1", text: "thread 3" })),
    );
    await waitFor(() => bus.prompts.length >= 3);

    // A reply in T1 (now evicted) still resolves via channel mapping
    // because channels[C100] = triage. We assert that the cache size
    // stays bounded — that's the load-bearing claim.
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T1", ts: "T1.r2", text: "back to T1" })),
    );
    await waitFor(() => bus.prompts.length >= 4);
    expect(bus.prompts[3]?.agent_id).toBe("triage");
    // Cap honoured.
    // @ts-expect-error — reach into private state for the size assertion.
    expect(adapter.threadOwners.size).toBeLessThanOrEqual(2);
  });

  it("touch-on-read keeps active threads warm", async () => {
    adapter = await startAdapter({
      maxThreadOwners: 2,
      routing: { channels: { C100: "triage", C200: "research" }, threadAgentId: "thread-only" },
    });

    // Establish T1 → triage (channel C100 → triage), T2 → research.
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T1", ts: "T1.r1", text: "kick T1" })),
    );
    socket.push(
      eventsEnvelope(msg({ channel: "C200", thread_ts: "T2", ts: "T2.r1", text: "kick T2" })),
    );
    await waitFor(() => bus.prompts.length >= 2);

    // Touch T1 (now newer than T2).
    socket.push(
      eventsEnvelope(msg({ channel: "C100", thread_ts: "T1", ts: "T1.r2", text: "touch T1" })),
    );
    await waitFor(() => bus.prompts.length >= 3);

    // Now insert T3 in an unrouted channel — to land it in threadOwners
    // we need the resolver to fire AND succeed via threadAgentId.
    socket.push(
      eventsEnvelope(msg({ channel: "C999", thread_ts: "T3", ts: "T3.r1", text: "kick T3" })),
    );
    await waitFor(() => bus.prompts.length >= 4);

    // T2 (least-recently-used) should have been evicted, T1 retained.
    // @ts-expect-error — reach into private state for assertion.
    expect(adapter.threadOwners.has("C100:T1")).toBe(true);
    // @ts-expect-error — reach into private state for assertion.
    expect(adapter.threadOwners.has("C200:T2")).toBe(false);
  });
});

describe("createSlackApi — fetch timeout (PR #117 review)", () => {
  // Agent #2 flagged that the original fetch had no AbortSignal, so a
  // stuck Slack edge could pin `await postMessage()` for minutes and
  // block the adapter's event loop.

  it("aborts the request after timeoutMs and surfaces a typed error", async () => {
    const realFetch = globalThis.fetch;
    let abortedFromOutside = false;
    // Stub a fetch that never resolves until the AbortController fires.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener("abort", () => {
            abortedFromOutside = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }
      });
    }) as typeof globalThis.fetch;

    try {
      const { createSlackApi } = await import("../api");
      const api = createSlackApi("fake-token", { timeoutMs: 25 });
      await expect(api.postMessage({ channel: "C1", text: "hi" })).rejects.toThrow(
        /timeout after 25ms/,
      );
      expect(abortedFromOutside).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* Issue #121 — upstream Slack feature port                                */
/* ────────────────────────────────────────────────────────────────────── */

import { extractTextFromAttachments, extractTextFromBlocks, sanitiseBotText } from "../index";

describe("Issue #121 — Codex P1 on PR #129: self-bot feedback-loop guard", () => {
  // Without this guard, our own chat.postMessage replies come back
  // as bot_message events. In an allowBots channel they would be
  // re-ingested as fresh prompts — feedback loop.

  it("drops events where event.bot_id === selfBotId, even in allowBots channels", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      selfBotId: "B-us",
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-us",
          text: "I just posted this myself!",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });

  it("drops events where event.user === selfUserId", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      selfUserId: "U-us",
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: "U-us",
          text: "we somehow got back our own user-authored msg",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });

  it("still passes through OTHER bots in allowBots channels", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      selfBotId: "B-us",
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "alert from another bot",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("alert from another bot");
  });

  it("warns at start when allowBots is set but neither selfBotId nor selfUserId is set", async () => {
    const warnings: string[] = [];
    const adapt = new SlackAdapter({
      bus,
      token: FAKE_BOT_TOKEN,
      signingSecret: FAKE_SIGNING_SECRET,
      allowedUserIds: [],
      allowBots: ["C100"],
      // selfBotId / selfUserId deliberately omitted
      routing: { channels: { C100: "triage" } },
      api,
      logger: { ...SILENT_LOGGER, warn: (m: string) => warnings.push(m) },
    });
    await adapt.start();
    await adapt.stop();
    expect(warnings.some((w) => w.includes("feedback loop"))).toBe(true);
  });

  it("does NOT warn when allowBots is empty (no loop risk)", async () => {
    const warnings: string[] = [];
    const adapt = new SlackAdapter({
      bus,
      token: FAKE_BOT_TOKEN,
      signingSecret: FAKE_SIGNING_SECRET,
      allowedUserIds: [],
      routing: { channels: { C100: "triage" } },
      api,
      logger: { ...SILENT_LOGGER, warn: (m: string) => warnings.push(m) },
    });
    await adapt.start();
    await adapt.stop();
    expect(warnings.some((w) => w.includes("feedback loop"))).toBe(false);
  });
});

describe("Issue #121 — upstream PR #210 allowBots + allowBotIds", () => {
  it("drops bot messages by default (no allowBots config)", async () => {
    adapter = await startAdapter();
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "alert: cpu pegged",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.prompts).toHaveLength(0);
  });

  it("passes through bot messages when channel is in allowBots", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "alert: cpu pegged",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("alert: cpu pegged");
    expect(bus.prompts[0]?.user_id).toBe("B-monitor");
    expect((bus.prompts[0]?.metadata as Record<string, unknown>).bot_id).toBe("B-monitor");
  });

  it("bypasses allowedUserIds for bot-allowed traffic", async () => {
    // Tight allow-list — would normally drop anyone but U42.
    adapter = await startAdapter({
      allowedUserIds: ["U42"],
      allowBots: ["C100"],
    });
    socket.push(
      eventsEnvelope(msg({ channel: "C100", user: undefined, bot_id: "B-monitor", text: "alert" })),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
  });

  it("allowBotIds narrows to specific bot ids when set", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      allowBotIds: ["B-trusted"],
    });
    // Allowed channel but the wrong bot id — drop.
    socket.push(
      eventsEnvelope(
        msg({ channel: "C100", user: undefined, bot_id: "B-stranger", text: "alert" }),
      ),
    );
    // Allowed channel + correct bot id — pass.
    socket.push(
      eventsEnvelope(
        msg({ channel: "C100", user: undefined, bot_id: "B-trusted", text: "trusted alert" }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
    expect(bus.prompts[0]?.text).toBe("trusted alert");
  });

  it("prefers bot_profile.name → username → bot_id for user_id label", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          bot_profile: { name: "Grafana" },
          username: "fallback-name",
          text: "alert",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.user_id).toBe("Grafana");
  });

  it("accepts bot_message subtype only for allowed bot channels", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          subtype: "bot_message",
          user: undefined,
          bot_id: "B-bot",
          text: "alert from bot_message",
        }),
      ),
    );
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C200",
          subtype: "bot_message",
          user: undefined,
          bot_id: "B-bot",
          text: "should be dropped — channel not in allowBots",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts).toHaveLength(1);
    expect(bus.prompts[0]?.text).toBe("alert from bot_message");
  });
});

describe("Issue #121 — upstream PR #211 block/attachment extraction", () => {
  it("extractTextFromBlocks walks text + fields + elements", () => {
    const result = extractTextFromBlocks([
      { type: "section", text: { type: "mrkdwn", text: "title" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "Status: red" },
          { type: "mrkdwn", text: "Host: web-01" },
        ],
      },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Ack" } }],
      },
    ]);
    expect(result).toContain("title");
    expect(result).toContain("Status: red");
    expect(result).toContain("Host: web-01");
    expect(result).toContain("Ack");
  });

  it("extractTextFromAttachments joins pretext + title + text + fields", () => {
    const result = extractTextFromAttachments([
      {
        pretext: "ALERT",
        title: "CPU > 90%",
        text: "web-01 has been over 90% for 5 minutes",
        fields: [
          { title: "Severity", value: "P1" },
          { title: "Host", value: "web-01" },
        ],
      },
    ]);
    expect(result).toContain("ALERT");
    expect(result).toContain("CPU > 90%");
    expect(result).toContain("web-01");
    expect(result).toContain("Severity:");
    expect(result).toContain("P1");
  });

  it("falls back to blocks when event.text is empty", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "from blocks" } }],
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("from blocks");
  });

  it("falls back to attachments when blocks AND text are empty", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "",
          attachments: [{ text: "from attachments" }],
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("from attachments");
  });

  it("text wins over blocks/attachments when all three present", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "primary text",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "block text" } }],
          attachments: [{ text: "attachment text" }],
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("primary text");
  });
});

describe("Issue #121 — upstream PR #214 replyThreadTs routing for bots", () => {
  it("non-thread bot message records owner under event.ts as the synthetic thread", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          ts: "1700000000.123",
          text: "alert",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    // @ts-expect-error — inspect private state for the assertion.
    expect(adapter.threadOwners.get("C100:1700000000.123")).toBe("triage");
  });

  it("subsequent reply in the bot's synthetic thread routes to the same agent", async () => {
    adapter = await startAdapter({
      allowBots: ["C100"],
      routing: { channels: { C100: "triage", C200: "research" } },
    });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          ts: "T100.alert",
          text: "alert",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length === 1);

    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: "U42",
          ts: "T100.reply",
          thread_ts: "T100.alert",
          text: "looking into it",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length === 2);
    expect(bus.prompts[1]?.agent_id).toBe("triage");
  });
});

describe("sanitiseBotText", () => {
  it("strips [react:emoji] directives", () => {
    expect(sanitiseBotText("hello [react:🔥] world")).toBe("hello  world");
  });

  it("replaces [[slack_buttons:...]] with a placeholder", () => {
    expect(sanitiseBotText("alert [[slack_buttons:ack,deny]]")).toContain("[buttons removed]");
  });

  it("trims trailing whitespace after removals", () => {
    expect(sanitiseBotText("alert [react:🔥]  ")).toBe("alert");
  });

  it("leaves plain text untouched", () => {
    expect(sanitiseBotText("CPU at 95%")).toBe("CPU at 95%");
  });

  it("sanitises bot-allowed prompts end-to-end", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: undefined,
          bot_id: "B-monitor",
          text: "alert [react:🔥]",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toBe("alert");
  });

  it("does NOT sanitise human messages (preserves operator intent)", async () => {
    adapter = await startAdapter({ allowBots: ["C100"] });
    socket.push(
      eventsEnvelope(
        msg({
          channel: "C100",
          user: "U42",
          text: "what's the latest [react:🔥]",
        }),
      ),
    );
    await waitFor(() => bus.prompts.length > 0);
    expect(bus.prompts[0]?.text).toContain("[react:🔥]");
  });
});

describe("SlackAdapter — tailer echo suppression (#217)", () => {
  it("IGNORES the JSONL tailer observability echo so replies are not double-posted", async () => {
    adapter = await startAdapter({ routing: { channels: { C100: "triage" } } });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "echo", _meta: { source: TAILER_EVENT_SOURCE } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.sent).toHaveLength(0);
  });

  it("STILL delivers a non-tailer response.text exactly once", async () => {
    adapter = await startAdapter({ routing: { channels: { C100: "triage" } } });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "recovered" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe("recovered");
  });

  it("delivers system.operator_alert as a standalone message (#325)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { text: "stall watchdog: possible false-positive kill" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.channel).toBe("C100");
    expect(api.sent[0]?.text).toContain("stall watchdog");
  });

  it("bounds system.operator_alert to the primary channel, not a fan-out (#325)", async () => {
    adapter = await startAdapter({
      routing: {
        channels: { C100: "triage", C200: "triage" },
        primaryChannelByAgent: { triage: "C200" },
      },
    });
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { text: "one alert" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.channel).toBe("C200");
  });

  it("drops an empty system.operator_alert (#325)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { text: "" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.sent).toHaveLength(0);
  });

  it("converts markdown bold to Slack mrkdwn in operator_alert (#325)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { text: "\u{1F6E1}\uFE0F **stall-watchdog** flagged a kill" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.text).toContain("*stall-watchdog*");
    expect(api.sent[0]?.text).not.toContain("**");
  });

  it("drops a payload-less system.operator_alert without an unhandled rejection (#325)", async () => {
    // The subscription callback is fire-and-forget (`void handleOperatorAlert`),
    // so a throw on a payload-less event surfaces as an UNHANDLED rejection, not
    // via api.sent. Capture it directly — a passing api.sent assertion alone
    // would not distinguish the pre-fix crash.
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      adapter = await startAdapter();
      bus.emit({
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "system.operator_alert",
      } as unknown as BusEvent);
      // A well-formed alert AFTER it must still deliver (handler survived).
      bus.emit({
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "system.operator_alert",
        payload: { text: "still alive" },
      });
      await waitFor(() => api.sent.length > 0);
      await new Promise((r) => setTimeout(r, 20)); // let any pending rejection settle
      expect(rejections).toHaveLength(0);
      expect(api.sent).toHaveLength(1);
      expect(api.sent[0]?.text).toBe("still alive");
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("drops a system.operator_alert whose payload has no text field (#325)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { other: 1 } as unknown as { text?: string },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.sent).toHaveLength(0);
  });

  it("skips a tailer-origin system.operator_alert (echo guard, #325)", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "system.operator_alert",
      payload: { text: "echo", _meta: { source: TAILER_EVENT_SOURCE } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.sent).toHaveLength(0);
  });
});

describe("mdToSlackMrkdwn — Markdown → Slack mrkdwn (#325)", () => {
  it("converts bold, strikethrough, links and headers; leaves compatible markup", () => {
    expect(mdToSlackMrkdwn("**b** and __b2__")).toBe("*b* and *b2*");
    expect(mdToSlackMrkdwn("~~gone~~")).toBe("~gone~");
    expect(mdToSlackMrkdwn("see [docs](https://x.io/y)")).toBe("see <https://x.io/y|docs>");
    expect(mdToSlackMrkdwn("# Title")).toBe("*Title*");
    // multi-line bold converts (dotAll); code/italic pass through unchanged.
    expect(mdToSlackMrkdwn("**two\nlines**")).toBe("*two\nlines*");
    expect(mdToSlackMrkdwn("`code` and _i_")).toBe("`code` and _i_");
  });
});

describe("defangSlackMentions — neutralise broadcast/user tokens (#336)", () => {
  it("defangs @channel/@here/@everyone broadcasts to inert text", () => {
    expect(defangSlackMentions("heads up <!channel> now")).toBe("heads up @channel now");
    expect(defangSlackMentions("<!here> and <!everyone>")).toBe("@here and @everyone");
  });

  it("defangs user and subteam mentions, preferring the display name", () => {
    expect(defangSlackMentions("ping <@U12345>")).toBe("ping @U12345");
    expect(defangSlackMentions("ping <@U12345|alice>")).toBe("ping @alice");
    expect(defangSlackMentions("cc <!subteam^S1|@oncall>")).toBe("cc @oncall");
    expect(defangSlackMentions("cc <!subteam^S1>")).toBe("cc @subteam");
  });

  it("leaves mrkdwn links and plain text untouched", () => {
    // Must not mangle mdToSlackMrkdwn output (`<url|label>`), nor inert `@foo`.
    expect(defangSlackMentions("see <https://x.io/y|docs>")).toBe("see <https://x.io/y|docs>");
    expect(defangSlackMentions("just @channel plain")).toBe("just @channel plain");
    expect(defangSlackMentions("no tokens here")).toBe("no tokens here");
  });
});

describe("SlackAdapter — outbound mention defang at the send boundary (#336)", () => {
  it("defangs a broadcast token in a response.text before posting", async () => {
    adapter = await startAdapter();
    bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s1",
      topic: "response.text",
      payload: { text: "deploy done <!channel>", origin: "slack", origin_id: "C100" },
    });
    await waitFor(() => api.sent.length > 0);
    expect(api.sent[0]?.text).toBe("deploy done @channel");
    expect(api.sent[0]?.text).not.toContain("<!channel>");
  });
});
