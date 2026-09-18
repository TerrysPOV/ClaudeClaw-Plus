/**
 * Bus MCP server tests.
 *
 * Tests inject a fake IpcTransport (no real socket) and use the MCP SDK's
 * InMemoryTransport linked pair to drive the MCP side as if Claude were the
 * remote peer.
 *
 * Spec refs: §5.1, Spike 0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BusMcpServer,
  CHANNEL_BASE_CAPABILITY,
  CHANNEL_PERMISSION_CAPABILITY,
  buildMcpServer,
  decidePermission,
  type IpcTransport,
} from "../mcp-server.js";
import { REQUEST_ID_PATTERN, type IpcMessage } from "../types.js";

/* ───────────────────────────────────────────────────────────────────── */
/* Fake IpcTransport — captures outbound, lets tests push inbound        */
/* ───────────────────────────────────────────────────────────────────── */

interface FakeIpcTransport extends IpcTransport {
  readonly sent: IpcMessage[];
  /** Push an inbound IPC message as if Bus core had sent it. */
  push(msg: IpcMessage): void;
  /** Wait until at least `n` messages have been sent. */
  awaitSent(n: number, timeoutMs?: number): Promise<void>;
}

function makeFakeIpc(): FakeIpcTransport {
  const sent: IpcMessage[] = [];
  const handlers: Array<(msg: IpcMessage) => void> = [];

  return {
    sent,
    send(msg) {
      sent.push(msg);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    push(msg) {
      for (const h of handlers) h(msg);
    },
    async close() {
      // no-op
    },
    async awaitSent(n, timeoutMs = 1000) {
      const start = Date.now();
      while (sent.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`awaitSent: timed out waiting for ${n} messages (got ${sent.length})`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

/* ───────────────────────────────────────────────────────────────────── */
/* Channel notification schemas — what a real Claude client would parse  */
/* ───────────────────────────────────────────────────────────────────── */

const ChannelNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel"),
  // Flat shape per aerolalit (Sprint 1 integration correction): claude 2.1.x
  // only accepts {content, meta}; the v2 spec's {channel_id, payload:{...}}
  // would be rejected at parse time.
  params: z
    .object({
      content: z.string(),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

const PermissionNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission"),
  params: z
    .object({
      request_id: z.string(),
      behavior: z.enum(["allow", "deny"]),
    })
    .passthrough(),
});

/* ───────────────────────────────────────────────────────────────────── */
/* Harness                                                               */
/* ───────────────────────────────────────────────────────────────────── */

interface Harness {
  bus: BusMcpServer;
  ipc: FakeIpcTransport;
  client: Client;
  channelNotifs: Array<z.infer<typeof ChannelNotificationSchema>>;
  permissionNotifs: Array<z.infer<typeof PermissionNotificationSchema>>;
  /** Wait until at least `n` channel notifications have been received. */
  awaitChannelNotifs(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function makeHarness(agentId = "test-agent", permissionMode?: string): Promise<Harness> {
  const ipc = makeFakeIpc();
  const mcp = buildMcpServer();
  const bus = new BusMcpServer({ agentId, ipc, mcp, permissionMode });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

  const channelNotifs: Array<z.infer<typeof ChannelNotificationSchema>> = [];
  const permissionNotifs: Array<z.infer<typeof PermissionNotificationSchema>> = [];
  client.setNotificationHandler(ChannelNotificationSchema, async (n) => {
    channelNotifs.push(n);
  });
  client.setNotificationHandler(PermissionNotificationSchema, async (n) => {
    permissionNotifs.push(n);
  });

  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  return {
    bus,
    ipc,
    client,
    channelNotifs,
    permissionNotifs,
    async awaitChannelNotifs(n, timeoutMs = 1000) {
      const start = Date.now();
      while (channelNotifs.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `awaitChannelNotifs: timed out waiting for ${n} (got ${channelNotifs.length})`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async close() {
      await client.close();
      await mcp.close();
    },
  };
}

/** Narrowing helper — fails the test if value is missing. */
function take<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected value: ${label}`);
  return value;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Tests                                                                 */
/* ───────────────────────────────────────────────────────────────────── */

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("BusMcpServer — handshake", () => {
  beforeEach(async () => {
    h = await makeHarness("agent-handshake");
  });

  it("sendHello() emits IpcHello with both required capability strings", () => {
    h.bus.sendHello();
    expect(h.ipc.sent.length).toBe(1);
    const hello = take(h.ipc.sent[0], "hello");
    expect(hello.type).toBe("hello");
    if (hello.type !== "hello") throw new Error("type narrowing");
    expect(hello.agent_id).toBe("agent-handshake");
    expect(hello.capabilities).toContain(CHANNEL_BASE_CAPABILITY);
    expect(hello.capabilities).toContain(CHANNEL_PERMISSION_CAPABILITY);
    expect(hello.capabilities.length).toBe(2);
  });

  it("sendHello() emits both capabilities regardless of permission_mode (#172 — core-ipc gate is mandatory)", async () => {
    for (const mode of ["bypassPermissions", "dontAsk", "acceptEdits", "plan", "default", "auto"]) {
      const localH = await makeHarness("agent-mode-test", mode);
      localH.bus.sendHello();
      const hello = take(localH.ipc.sent[0], "hello");
      if (hello.type !== "hello") throw new Error("type narrowing");
      expect(hello.capabilities).toContain(CHANNEL_BASE_CAPABILITY);
      expect(hello.capabilities).toContain(CHANNEL_PERMISSION_CAPABILITY);
      expect(hello.capabilities.length).toBe(2);
      await localH.close();
    }
  });
});

describe("decidePermission — tool-aware mode routing (#172, Codex P1 on #173)", () => {
  // The IpcHello capability set is fixed at both required strings (Bus core
  // gates the handshake on both — see core-ipc.ts:REQUIRED_MCP_CAPABILITIES).
  // The mode + tool gate is applied inside the permission_request
  // notification handler. These tests pin the helper logic that drives it.

  it("bypassPermissions → allow for every tool", () => {
    expect(decidePermission("bypassPermissions", "Edit")).toBe("allow");
    expect(decidePermission("bypassPermissions", "Bash")).toBe("allow");
    expect(decidePermission("bypassPermissions", "WebFetch")).toBe("allow");
    expect(decidePermission("bypassPermissions", "UnknownTool")).toBe("allow");
  });

  it("dontAsk → deny for every tool", () => {
    expect(decidePermission("dontAsk", "Edit")).toBe("deny");
    expect(decidePermission("dontAsk", "Bash")).toBe("deny");
    expect(decidePermission("dontAsk", "WebFetch")).toBe("deny");
    expect(decidePermission("dontAsk", "UnknownTool")).toBe("deny");
  });

  it("acceptEdits → allow ONLY for edit-class tools; forward shell/network/other", () => {
    // Edit-class tools auto-allowed.
    expect(decidePermission("acceptEdits", "Edit")).toBe("allow");
    expect(decidePermission("acceptEdits", "Write")).toBe("allow");
    expect(decidePermission("acceptEdits", "NotebookEdit")).toBe("allow");
    expect(decidePermission("acceptEdits", "MultiEdit")).toBe("allow");
    expect(decidePermission("acceptEdits", "Update")).toBe("allow");
    // Shell / network / other tools must still go to the operator.
    expect(decidePermission("acceptEdits", "Bash")).toBe("forward");
    expect(decidePermission("acceptEdits", "WebFetch")).toBe("forward");
    expect(decidePermission("acceptEdits", "WebSearch")).toBe("forward");
    expect(decidePermission("acceptEdits", "Read")).toBe("forward");
    expect(decidePermission("acceptEdits", "UnknownTool")).toBe("forward");
  });

  it("default / plan / auto / unset / unrecognised → forward for every tool", () => {
    for (const mode of [undefined, "default", "plan", "auto", "nonsense"]) {
      expect(decidePermission(mode, "Edit")).toBe("forward");
      expect(decidePermission(mode, "Bash")).toBe("forward");
    }
  });

  it("BusMcpServer stores the permissionMode for handler-time decisions", () => {
    const ipc = makeFakeIpc();
    const mcp = buildMcpServer();
    const bus = new BusMcpServer({ agentId: "a", ipc, mcp, permissionMode: "acceptEdits" });
    expect(bus.permissionMode).toBe("acceptEdits");
  });
});

describe("BusMcpServer — inbound prompt", () => {
  beforeEach(async () => {
    h = await makeHarness("agent-prompt");
  });

  it("forwards an IpcPrompt as notifications/claude/channel", async () => {
    h.ipc.push({
      type: "prompt",
      agent_id: "agent-prompt",
      origin: "discord",
      origin_id: "chan-123",
      user_id: "user-42",
      text: "fix the build",
    });

    await h.awaitChannelNotifs(1);
    const n = take(h.channelNotifs[0], "channel notification");
    // Flat shape per aerolalit (Sprint 1 integration correction): params is
    // {content, meta}, not nested {channel_id, payload: {text, metadata}}.
    expect(n.params.content).toBe("fix the build");
    expect(n.params.meta).toMatchObject({
      origin: "discord",
      origin_id: "chan-123",
    });
  });
});

describe("BusMcpServer — outbound tools", () => {
  beforeEach(async () => {
    h = await makeHarness("agent-tools");
  });

  it("`reply` tool emits IpcReply with the requested intent", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "done", metadata: { intent: "final" } },
    });
    expect(result.isError).toBeFalsy();
    expect(h.ipc.sent.length).toBe(1);
    const reply = take(h.ipc.sent[0], "reply");
    expect(reply.type).toBe("reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.text).toBe("done");
    expect(reply.intent).toBe("final");
    expect(reply.agent_id).toBe("agent-tools");
  });

  it("`reply` tool defaults intent to 'progress' when omitted", async () => {
    await h.client.callTool({ name: "reply", arguments: { message: "thinking..." } });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.intent).toBe("progress");
  });

  it("`reply` tool honours a top-level `intent` (the form its description shows)", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "done", intent: "final" },
    });
    expect(result.isError).toBeFalsy();
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.intent).toBe("final");
  });

  it("`reply` tool honours a top-level `in_reply_to` like metadata.in_reply_to", async () => {
    await h.client.callTool({
      name: "reply",
      arguments: { message: "for chat A", intent: "final", in_reply_to: 100 },
    });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.in_reply_to).toBe("100");
  });

  it("`reply` tool lets metadata.in_reply_to win when both forms are given", async () => {
    await h.client.callTool({
      name: "reply",
      arguments: { message: "x", in_reply_to: 1, metadata: { in_reply_to: 2 } },
    });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.in_reply_to).toBe("2");
  });

  it("`reply` tool refuses an empty `in_reply_to` instead of routing it as unnamed", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "x", intent: "final", in_reply_to: "" },
    });
    expect(result.isError).toBe(true);
    expect(h.ipc.sent).toHaveLength(0);
  });

  it("`reply` tool lets metadata.intent win when both forms are given", async () => {
    await h.client.callTool({
      name: "reply",
      arguments: { message: "x", intent: "progress", metadata: { intent: "final" } },
    });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.intent).toBe("final");
  });

  it("`reply` tool treats null optionals as unset (models write null for 'not applicable')", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "done", intent: "final", in_reply_to: null, metadata: null },
    });
    expect(result.isError).toBeFalsy();
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.intent).toBe("final");
    expect("in_reply_to" in reply).toBe(false);
  });

  it("`reply` tool: a null metadata.intent does not shadow a top-level intent", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "done", intent: "final", metadata: { intent: null } },
    });
    expect(result.isError).toBeFalsy();
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.intent).toBe("final");
  });

  it("`reply` tool rejects an unknown key inside metadata too", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "x", metadata: { intent: "final", chat_id: "100" } },
    });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text?: string }>)[0]?.text)).toContain("chat_id");
    expect(h.ipc.sent.length).toBe(0);
  });

  it("`reply` tool rejects an unknown argument instead of delivering it as progress", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "x", intnet: "final" },
    });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text?: string }>)[0]?.text)).toContain("intnet");
    expect(h.ipc.sent.length).toBe(0);
  });

  it("`reply` tool forwards metadata.in_reply_to on the IpcReply (#224)", async () => {
    await h.client.callTool({
      name: "reply",
      arguments: { message: "for chat A", metadata: { intent: "final", in_reply_to: "100" } },
    });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.in_reply_to).toBe("100");
  });

  it("`reply` tool omits in_reply_to when the agent did not set it", async () => {
    await h.client.callTool({ name: "reply", arguments: { message: "x" } });
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect("in_reply_to" in reply).toBe(false);
  });

  it("`reply` tool accepts a numeric in_reply_to and forwards it as a string (#224)", async () => {
    const result = await h.client.callTool({
      name: "reply",
      arguments: { message: "x", metadata: { in_reply_to: -1001234567890 } },
    });
    expect(result.isError).toBeFalsy();
    const reply = take(h.ipc.sent[0], "reply");
    if (reply.type !== "reply") throw new Error("type narrowing");
    expect(reply.in_reply_to).toBe("-1001234567890");
  });

  it("`edit_message` tool emits IpcEditMessage", async () => {
    const result = await h.client.callTool({
      name: "edit_message",
      arguments: { message: "reading files..." },
    });
    expect(result.isError).toBeFalsy();
    expect(h.ipc.sent.length).toBe(1);
    const edit = take(h.ipc.sent[0], "edit_message");
    expect(edit.type).toBe("edit_message");
    if (edit.type !== "edit_message") throw new Error("type narrowing");
    expect(edit.text).toBe("reading files...");
    expect(edit.agent_id).toBe("agent-tools");
  });

  it("`cancel` tool emits IpcCancel with reason when provided", async () => {
    await h.client.callTool({
      name: "cancel",
      arguments: { reason: "user requested" },
    });
    const cancel = take(h.ipc.sent[0], "cancel");
    expect(cancel.type).toBe("cancel");
    if (cancel.type !== "cancel") throw new Error("type narrowing");
    expect(cancel.reason).toBe("user requested");
  });

  it("`ask` tool returns an ask_id and emits IpcAsk", async () => {
    const result = await h.client.callTool({
      name: "ask",
      arguments: { question: "which file?" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const first = take(content[0], "tool result content[0]");
    const payload = JSON.parse(first.text) as { ask_id: string };
    expect(typeof payload.ask_id).toBe("string");
    expect(payload.ask_id.length).toBeGreaterThan(0);

    expect(h.ipc.sent.length).toBe(1);
    const ask = take(h.ipc.sent[0], "ask");
    expect(ask.type).toBe("ask");
    if (ask.type !== "ask") throw new Error("type narrowing");
    expect(ask.ask_id).toBe(payload.ask_id);
    expect(ask.question).toBe("which file?");

    expect(h.bus.hasPendingAnswer(payload.ask_id)).toBe(true);
  });

  it("`ask` answer arrives via channel notification with matching ask_id", async () => {
    const callResult = await h.client.callTool({
      name: "ask",
      arguments: { question: "which file?" },
    });
    const content = callResult.content as Array<{ type: string; text: string }>;
    const first = take(content[0], "ask tool result content[0]");
    const { ask_id } = JSON.parse(first.text) as { ask_id: string };

    h.ipc.push({
      type: "ask_answer",
      agent_id: "agent-tools",
      ask_id,
      answer: "src/foo.ts",
    });

    await h.awaitChannelNotifs(1);
    const n = take(h.channelNotifs[0], "ask answer notification");
    expect(n.params.content).toBe("src/foo.ts");
    expect(n.params.meta).toMatchObject({ ask_id, kind: "ask_answer" });
    expect(h.bus.hasPendingAnswer(ask_id)).toBe(false);
  });

  it("`request_human` blocks until IpcAskAnswer arrives, then returns the answer", async () => {
    const callPromise = h.client.callTool({
      name: "request_human",
      arguments: { question: "approve deploy?" },
    });

    // Wait for the IpcRequestHuman to be sent so we know it's pending.
    await h.ipc.awaitSent(1);
    const reqHuman = take(h.ipc.sent[0], "request_human");
    expect(reqHuman.type).toBe("request_human");
    if (reqHuman.type !== "request_human") throw new Error("type narrowing");
    expect(reqHuman.question).toBe("approve deploy?");
    // ask_id is now carried on the wire (Codex P1 fix on PR #110) — adapter
    // echoes it back on IpcAskAnswer for correlation.
    expect(typeof reqHuman.ask_id).toBe("string");
    expect(reqHuman.ask_id.length).toBeGreaterThan(0);

    h.ipc.push({
      type: "ask_answer",
      agent_id: "agent-tools",
      ask_id: reqHuman.ask_id,
      answer: "yes",
    });

    const result = await callPromise;
    const content = result.content as Array<{ type: string; text: string }>;
    const first = take(content[0], "request_human result content[0]");
    expect(first.text).toBe("yes");
  });
});

describe("BusMcpServer — permission flow", () => {
  beforeEach(async () => {
    h = await makeHarness("agent-perm");
  });

  it("round-trip: permission_request in → IpcPermissionRequest out → IpcPermissionResponse in → permission notification out", async () => {
    // Inbound permission_request from claude.
    await h.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "rm -rf /tmp/cache",
        input_preview: '{"command":"rm -rf /tmp/cache"}',
      },
    });

    await h.ipc.awaitSent(1);
    const out = take(h.ipc.sent[0], "permission_request");
    expect(out.type).toBe("permission_request");
    if (out.type !== "permission_request") throw new Error("type narrowing");
    expect(out.request.request_id).toBe("abcde");
    expect(out.request.tool_name).toBe("Bash");
    expect(out.agent_id).toBe("agent-perm");

    // Bus core responds.
    h.ipc.push({
      type: "permission_response",
      agent_id: "agent-perm",
      response: { request_id: "abcde", behavior: "allow" },
    });

    // Permission notification reaches the client.
    const start = Date.now();
    while (h.permissionNotifs.length < 1) {
      if (Date.now() - start > 1000) throw new Error("permission notification not delivered");
      await new Promise((r) => setTimeout(r, 5));
    }
    const n = take(h.permissionNotifs[0], "permission notification");
    expect(n.params.request_id).toBe("abcde");
    expect(n.params.behavior).toBe("allow");
    // Field must be `behavior` not `decision`; no `reason` (§5.1 / Spike 0.1).
    expect(n.params).not.toHaveProperty("decision");
    expect(n.params).not.toHaveProperty("reason");
  });

  it("permission response payload uses 'behavior' (not 'decision') and has no 'reason'", async () => {
    h.ipc.push({
      type: "permission_response",
      agent_id: "agent-perm",
      response: { request_id: "qwert", behavior: "deny" },
    });
    const start = Date.now();
    while (h.permissionNotifs.length < 1) {
      if (Date.now() - start > 1000) throw new Error("notification not delivered");
      await new Promise((r) => setTimeout(r, 5));
    }
    const params = take(h.permissionNotifs[0], "permission notification").params;
    expect(Object.keys(params).sort()).toEqual(["behavior", "request_id"]);
    expect(params.behavior).toBe("deny");
  });

  it("short-circuits (auto-allow, no IPC forward) when permission_mode=bypassPermissions (#172)", async () => {
    await h.close(); // close the default-mode harness from beforeEach
    const localH = await makeHarness("agent-bypass", "bypassPermissions");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "x",
        input_preview: "{}",
      },
    });
    // Wait for the auto-allow notification round-trip.
    const start = Date.now();
    while (localH.permissionNotifs.length < 1) {
      if (Date.now() - start > 1000) throw new Error("auto-allow notification not delivered");
      await new Promise((r) => setTimeout(r, 5));
    }
    // Must NOT have been forwarded to Bus core.
    expect(localH.ipc.sent.length).toBe(0);
    // Must have auto-responded `allow`.
    const params = take(localH.permissionNotifs[0], "permission notification").params;
    expect(params.request_id).toBe("abcde");
    expect(params.behavior).toBe("allow");
    h = localH; // afterEach will close
  });

  it("short-circuits with `deny` when permission_mode=dontAsk (#172)", async () => {
    await h.close();
    const localH = await makeHarness("agent-dontask", "dontAsk");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "qwert",
        tool_name: "Write",
        description: "x",
        input_preview: "{}",
      },
    });
    const start = Date.now();
    while (localH.permissionNotifs.length < 1) {
      if (Date.now() - start > 1000) throw new Error("auto-deny notification not delivered");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(localH.ipc.sent.length).toBe(0);
    const params = take(localH.permissionNotifs[0], "permission notification").params;
    expect(params.behavior).toBe("deny");
    h = localH;
  });

  it("acceptEdits short-circuits with `allow` for edit tools (Edit)", async () => {
    await h.close();
    const localH = await makeHarness("agent-accept", "acceptEdits");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "fghij",
        tool_name: "Edit",
        description: "x",
        input_preview: "{}",
      },
    });
    const start = Date.now();
    while (localH.permissionNotifs.length < 1) {
      if (Date.now() - start > 1000) throw new Error("auto-allow notification not delivered");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(localH.ipc.sent.length).toBe(0);
    const params = take(localH.permissionNotifs[0], "permission notification").params;
    expect(params.behavior).toBe("allow");
    h = localH;
  });

  it("acceptEdits FORWARDS shell/network tools to Bus core (Codex P1 on #173)", async () => {
    // Critical: under acceptEdits mode, only file-edit tools are
    // auto-allowed. Bash, WebFetch, etc. must still go to the operator.
    // A blanket short-circuit would silently widen acceptEdits to act
    // like bypassPermissions for shell + network.
    await h.close();
    const localH = await makeHarness("agent-accept-bash", "acceptEdits");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "bashm",
        tool_name: "Bash",
        description: "rm -rf /tmp/cache",
        input_preview: '{"command":"rm -rf /tmp/cache"}',
      },
    });
    await localH.ipc.awaitSent(1);
    // Forwarded to Bus core, NOT auto-responded.
    const out = take(localH.ipc.sent[0], "permission_request");
    expect(out.type).toBe("permission_request");
    if (out.type !== "permission_request") throw new Error("type narrowing");
    expect(out.request.tool_name).toBe("Bash");
    expect(out.request.request_id).toBe("bashm");
    // No auto-response — operator must decide.
    expect(localH.permissionNotifs.length).toBe(0);
    h = localH;
  });

  it("acceptEdits forwards WebFetch (network tool) to Bus core", async () => {
    await h.close();
    const localH = await makeHarness("agent-accept-net", "acceptEdits");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "fetcm",
        tool_name: "WebFetch",
        description: "fetch example.com",
        input_preview: '{"url":"https://example.com"}',
      },
    });
    await localH.ipc.awaitSent(1);
    expect(localH.permissionNotifs.length).toBe(0);
    h = localH;
  });

  it("short-circuit path also rejects a permission_request with invalid request_id charset", async () => {
    await h.close();
    const localH = await makeHarness("agent-bypass-bad", "bypassPermissions");
    await localH.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        // Contains 'l' (excluded by REQUEST_ID_PATTERN) and is too long.
        request_id: "BAD\nINJECT",
        tool_name: "Bash",
        description: "x",
        input_preview: "{}",
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    // Must be dropped — no IPC forward AND no echo-back notification.
    expect(localH.ipc.sent.length).toBe(0);
    expect(localH.permissionNotifs.length).toBe(0);
    h = localH;
  });

  it("rejects a permission_request with a request_id outside the [a-km-z]{5} charset", async () => {
    // Send a bad request_id — implementation must drop and NOT forward.
    await h.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        // Contains 'l' (excluded by REQUEST_ID_PATTERN) AND too long.
        request_id: "TOO_LONG_AND_BAD",
        tool_name: "Bash",
        description: "x",
        input_preview: "{}",
      },
    });

    // Give the notification a moment to be processed.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.ipc.sent.length).toBe(0);
  });

  it("REQUEST_ID_PATTERN invariant: valid examples accepted, invalid rejected", () => {
    // Charset is `[a-km-z]{5}` — only `l` excluded from a-z. Lowercase only.
    // (Spike 0.1 prose mentioned `i/n/o` but the regex in aerolalit `server.ts:84`
    // and our types.ts both exclude only `l`. Regex is the source of truth.)
    expect(REQUEST_ID_PATTERN.test("abcde")).toBe(true);
    expect(REQUEST_ID_PATTERN.test("qwert")).toBe(true);
    expect(REQUEST_ID_PATTERN.test("mnopq")).toBe(true); // n and o ARE in the set
    expect(REQUEST_ID_PATTERN.test("abcdl")).toBe(false); // contains 'l'
    expect(REQUEST_ID_PATTERN.test("ABCDE")).toBe(false); // uppercase
    expect(REQUEST_ID_PATTERN.test("abcd")).toBe(false); // 4 chars
    expect(REQUEST_ID_PATTERN.test("abcdef")).toBe(false); // 6 chars
    expect(REQUEST_ID_PATTERN.test("ab cd")).toBe(false); // whitespace
  });
});
