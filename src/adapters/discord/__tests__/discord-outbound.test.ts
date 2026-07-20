/**
 * Discord adapter — outbound (bus → Discord) behavioural tests.
 *
 * Covers `response.text` delivery, `channel.permission_request` button
 * flow, and `system.request_human` round-trip. Inbound (gateway → bus)
 * lives in `discord-inbound.test.ts`.
 *
 * Run: `bun test src/adapters/discord/__tests__/discord-outbound.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DiscordAdapter } from "../index";
import { type PermissionRequest, TAILER_EVENT_SOURCE } from "../../../bus/types";
import {
  type AdapterHarness,
  flushMicrotasks,
  makeHarness,
  makeInteraction,
  makeMessage,
  startAdapter,
} from "./fixtures";

let h: AdapterHarness;
let adapter: DiscordAdapter | null = null;

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  if (adapter) {
    await adapter.stop();
    adapter = null;
  }
});

describe("DiscordAdapter — outbound response.text", () => {
  it("posts bus response.text to all channels for the agent", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "done" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
    expect(h.rest.sent[0]?.text).toBe("done");
  });

  it("prefixes the synthesized notice on a safety-net delivery (#240)", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "raw turn output", intent: "final", synthesized: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.rest.sent[0]?.text.startsWith("⚠️")).toBe(true);
    expect(h.rest.sent[0]?.text).toContain("without sending a reply");
    expect(h.rest.sent[0]?.text).toContain("raw turn output");
  });

  it("IGNORES the JSONL tailer's observability echo so replies aren't double-posted (#217)", async () => {
    // The silent-drop net (#217) wires the JSONL tailer into the live bus.
    // The tailer re-emits a raw per-block `response.text` for every assistant
    // text block, stamped with `_meta.source = "jsonl-tailer"`. The real
    // delivery comes from the agent's `reply` tool (ingestReply), which has
    // NO source marker. If the adapter delivered both, every reply would
    // double-post. Assert the tailer echo produces ZERO sends.
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "done", _meta: { source: TAILER_EVENT_SOURCE } },
    });
    expect(h.rest.sent).toHaveLength(0);
  });

  it("STILL delivers a real ingestReply (no tailer marker) exactly once (#217)", async () => {
    // Companion to the echo-suppression test: a genuine reply — or the
    // safety net's SYNTHESIZED final, both produced via ingestReply and
    // therefore carrying no tailer source marker — must still deliver.
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "recovered", intent: "final", origin: "discord", origin_id: "dm-9" },
    });
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["dm-9"]);
    expect(h.rest.sent[0]?.text).toBe("recovered");
  });

  it("skips empty response.text payloads", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "" },
    });
    expect(h.rest.sent).toHaveLength(0);
  });

  it("routes response.text ONLY to the originating channel when origin is preserved", async () => {
    // BusCore now stamps the originating prompt's `origin` + `origin_id`
    // onto outbound `response.text` events so adapters can reply to the
    // same surface (DM / specific channel) instead of fanning out.
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "scoped reply", origin: "discord", origin_id: "dm-42" },
    });
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["dm-42"]);
    expect(h.rest.sent[0]?.text).toBe("scoped reply");
  });

  it("falls back to channelsForAgent when no origin in payload", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "broadcast" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
  });

  it("DROPS response.text whose origin belongs to another adapter (post-#137 regression)", async () => {
    // Production incident on 2026-05-20: webui-originated replies were
    // mirroring into every Discord channel routed to the agent because
    // the old branch fell back to `channelsForAgent` when origin didn't
    // match "discord". Foreign CHANNEL-DRIVEN origins must be dropped
    // silently; fan-out is reserved for events with NO origin OR with
    // a NON-CHANNEL origin (cron / heartbeat / cli / rest).
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "webui reply", origin: "webui", origin_id: "webui-42" },
    });
    expect(h.rest.sent).toHaveLength(0);
  });

  it("KEEPS response.text with origin 'cron' — Codex P1 on #138", async () => {
    // Codex caught this on #138: scheduler emits prompts with explicit
    // origin: "cron" | "heartbeat". A blunt "drop if origin is set"
    // rule would silently stop scheduler replies reaching any channel.
    // Only foreign CHANNEL-DRIVEN origins drop; non-channel origins
    // fall through to fan-out.
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "cron tick reply", origin: "cron", origin_id: "job:morning" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
  });

  it("KEEPS response.text with origin 'heartbeat' — Codex P1 on #138", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "heartbeat reply", origin: "heartbeat", origin_id: "hb" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
  });

  it("routes non-channel-driven origins to primaryChannelByAgent when configured", async () => {
    // Production bug 2026-05-21: every heartbeat fans out to every channel
    // routed to the agent (e.g. both #general and #daily-digest-suzy for
    // agent `suzy`). Opt-in primaryChannelByAgent narrows the fan-out to a
    // single designated channel per agent.
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-2": "ops" },
        threads: { "th-1": "ops" },
        dmAgentId: "global",
        primaryChannelByAgent: { ops: "ch-2" },
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "heartbeat tick", origin: "heartbeat", origin_id: "hb" },
    });
    // Without the primary-channel narrowing, this would broadcast to BOTH
    // "ch-2" and "th-1". With it, only "ch-2" gets the heartbeat.
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["ch-2"]);
  });

  it("falls back to fan-out when primaryChannelByAgent is unset for the agent", async () => {
    // Back-compat: agents without a primaryChannelByAgent entry keep the
    // legacy fan-out behaviour.
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-2": "ops" },
        threads: { "th-1": "ops" },
        dmAgentId: "global",
        primaryChannelByAgent: { other: "ch-1" }, // not for "ops"
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "cron tick", origin: "cron", origin_id: "job:morning" },
    });
    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-2", "th-1"]);
  });

  it("subscribes agents listed only in primaryChannelByAgent (Codex P2 #151)", async () => {
    // An operator who sets a primary channel for an agent without listing
    // the agent in channels/threads/dmAgentId must still get a subscription.
    // Without this, the parser accepts the config but the adapter mounts
    // with zero subscriptions and the routed event never arrives.
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-2": "ops" },
        threads: { "th-1": "ops" },
        primaryChannelByAgent: { "scheduler-only": "ch-9" },
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "scheduler-only",
      session_id: "s",
      topic: "response.text",
      payload: { text: "scheduler tick", origin: "cron", origin_id: "job:nightly" },
    });
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["ch-9"]);
  });

  it("DROPS channel.permission_request whose origin belongs to another adapter", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "channel.permission_request",
      payload: {
        request_id: "fghij",
        tool_name: "Bash",
        description: "run command",
        input_preview: "echo hi",
        origin: "webui",
        origin_id: "webui-42",
      } as PermissionRequest & { origin: string; origin_id: string },
    });
    expect(h.rest.sent).toHaveLength(0);
  });

  it("routes channel.permission_request ONLY to origin_id channel when origin is discord", async () => {
    // Bug B fix: BusCore now attaches origin/origin_id from the
    // triggering prompt onto permission_request events so the button
    // prompt lands on the channel that asked for the tool call.
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "channel.permission_request",
      payload: {
        request_id: "klmno",
        tool_name: "Write",
        description: "write a file",
        input_preview: "{path: ...}",
        origin: "discord",
        origin_id: "ch-2",
      } as PermissionRequest & { origin: string; origin_id: string },
    });
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["ch-2"]);
  });
});

describe("DiscordAdapter — permission flow", () => {
  it("posts a button-row prompt on channel.permission_request and routes the click back", async () => {
    adapter = await startAdapter(h);
    const req: PermissionRequest = {
      request_id: "abcde",
      tool_name: "Write",
      description: "write a file",
      input_preview: "{path: ...}",
    };
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "channel.permission_request",
      payload: req,
    });
    expect(h.rest.sent).toHaveLength(1);
    const sent = h.rest.sent[0];
    if (!sent) throw new Error("expected sent message");
    expect(sent.channelId).toBe("ch-1");
    expect(sent.components).toBeDefined();
    const row = sent.components?.[0] as { components: Array<{ custom_id: string; label: string }> };
    expect(row.components).toHaveLength(2);
    expect(row.components[0]?.custom_id).toBe("ccaw_perm_allow_abcde");
    expect(row.components[1]?.custom_id).toBe("ccaw_perm_deny_abcde");

    // Click "Allow".
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({ data: { custom_id: "ccaw_perm_allow_abcde" } }),
    });
    await flushMicrotasks();

    expect(h.bus.permissionDecisions).toHaveLength(1);
    expect(h.bus.permissionDecisions[0]).toEqual({
      agent_id: "triage",
      request_id: "abcde",
      behavior: "allow",
    });
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toBe("Allowed.");
  });

  it("ignores unknown permission button click (stale prompt)", async () => {
    adapter = await startAdapter(h);
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({ data: { custom_id: "ccaw_perm_deny_zzzzz" } }),
    });
    await flushMicrotasks();
    expect(h.bus.permissionDecisions).toHaveLength(0);
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toContain("no longer active");
  });

  it("rejects permission click from non-allowlisted user", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "channel.permission_request",
      payload: {
        request_id: "abcde",
        tool_name: "Write",
        description: "",
        input_preview: "",
      },
    });
    h.gateway.push({
      type: "INTERACTION_CREATE",
      interaction: makeInteraction({
        user: { id: "intruder", username: "evil" },
        data: { custom_id: "ccaw_perm_allow_abcde" },
      }),
    });
    await flushMicrotasks();
    expect(h.bus.permissionDecisions).toHaveLength(0);
    expect(h.rest.acks).toHaveLength(1);
    expect(h.rest.acks[0]?.body.content).toBe("Unauthorized.");
  });
});

describe("DiscordAdapter — request_human flow", () => {
  it("posts a question on system.request_human and routes the first reply via ingestAskAnswer", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "what next?" },
    });
    expect(h.rest.sent).toHaveLength(1);
    expect(h.rest.sent[0]?.channelId).toBe("ch-1");
    expect(h.rest.sent[0]?.text).toContain("what next?");

    // Operator replies in the same channel.
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        channel_id: "ch-1",
        guild_id: "g-1",
        content: "ship it",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.askAnswers).toHaveLength(1);
    expect(h.bus.askAnswers[0]).toEqual({
      agent_id: "triage",
      ask_id: "ask-1",
      answer: "ship it",
    });
    // And the reply must NOT also be forwarded as a prompt.
    expect(h.bus.prompts).toHaveLength(0);
  });

  it("only the first reply is consumed; the second reply is a fresh prompt", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "system.request_human",
      payload: { ask_id: "ask-1", question: "?" },
    });
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({ channel_id: "ch-1", guild_id: "g-1", content: "answer" }),
    });
    await flushMicrotasks();
    h.gateway.push({
      type: "MESSAGE_CREATE",
      message: makeMessage({
        id: "msg-2",
        channel_id: "ch-1",
        guild_id: "g-1",
        content: "another",
      }),
    });
    await flushMicrotasks();
    expect(h.bus.askAnswers).toHaveLength(1);
    expect(h.bus.prompts).toHaveLength(1);
    expect(h.bus.prompts[0]?.text).toBe("another");
  });
});

describe("DiscordAdapter — multi-agent fan-out", () => {
  it("each agent gets independent response delivery", async () => {
    adapter = await startAdapter(h);
    h.bus.emit({
      ts: Date.now(),
      agent_id: "triage",
      session_id: "s",
      topic: "response.text",
      payload: { text: "for triage" },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "for ops" },
    });
    const byCh = new Map(h.rest.sent.map((m) => [m.channelId, m.text]));
    expect(byCh.get("ch-1")).toBe("for triage");
    expect(byCh.get("ch-2")).toBe("for ops");
    expect(byCh.get("th-1")).toBe("for ops");
  });
  /* #301 — out-of-band operator alerts (stall watchdog). */

  it("renders a system.operator_alert to the agent's primary channel", async () => {
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-2": "ops" },
        threads: { "th-1": "ops" },
        dmAgentId: "global",
        primaryChannelByAgent: { ops: "ch-2" },
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "",
      topic: "system.operator_alert",
      payload: {
        level: "critical",
        text: "stall-watchdog: looked ALIVE",
        source: "stall-watchdog",
      },
    });
    // Narrowed to the operator's primary channel, not fanned out to th-1.
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["ch-2"]);
    expect(h.rest.sent[0]?.text).toContain("looked ALIVE");
  });

  it("never routes an alert for agent A to a channel owned only by agent B", async () => {
    adapter = await startAdapter(h, {
      routing: { channels: { "ch-1": "triage", "ch-2": "ops" }, dmAgentId: "global" },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "",
      topic: "system.operator_alert",
      payload: { level: "warn", text: "ops alert", source: "stall-watchdog" },
    });
    expect(h.rest.sent.map((m) => m.channelId)).toEqual(["ch-2"]);
  });

  it("posts an alert to ONE channel even when the agent owns several and no primary is set", async () => {
    // #151's fan-out containment is opt-in: without a primaryChannelByAgent
    // entry, targetChannels degrades to every channel AND thread mapped to
    // the agent. Tolerable for a periodic heartbeat; an alert storm for a
    // stall alert, whose guards bound per session, not per channel.
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-1": "ops", "ch-2": "ops" },
        threads: { "th-1": "ops" },
        dmAgentId: "global",
        // deliberately NO primaryChannelByAgent — the documented default
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "",
      topic: "system.operator_alert",
      payload: { level: "critical", text: "wedged", source: "stall-watchdog" },
    });

    // A reply would fan out to all three; an alert must not.
    expect(h.rest.sent).toHaveLength(1);
  });

  it("still fans a normal reply out to every routed channel (alert narrowing is alert-only)", async () => {
    adapter = await startAdapter(h, {
      routing: {
        channels: { "ch-1": "ops", "ch-2": "ops" },
        threads: { "th-1": "ops" },
        dmAgentId: "global",
      },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "s",
      topic: "response.text",
      payload: { text: "a normal reply" },
    });

    expect(h.rest.sent.map((m) => m.channelId).sort()).toEqual(["ch-1", "ch-2", "th-1"]);
  });

  it("drops an alert with no text rather than posting an empty message", async () => {
    adapter = await startAdapter(h, {
      routing: { channels: { "ch-2": "ops" }, dmAgentId: "global" },
    });
    h.bus.emit({
      ts: Date.now(),
      agent_id: "ops",
      session_id: "",
      topic: "system.operator_alert",
      payload: { level: "warn", source: "stall-watchdog" },
    });
    expect(h.rest.sent).toHaveLength(0);
  });
});
