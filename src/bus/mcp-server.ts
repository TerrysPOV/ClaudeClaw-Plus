/**
 * ClaudeClaw+ Bus MCP server — the Channels plugin claude loads.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.1.
 * Empirical reference: aerolalit's telegram plugin at
 *   ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts
 *   (Spike 0.1 — `server.ts:388,394` capabilities, `:420` zod schema,
 *   `:774,933` permission send-site).
 *
 * Wire shape (Sprint 1):
 *   claude ↔ this plugin: JSON-RPC over MCP stdio transport.
 *   this plugin ↔ Bus core: length-prefixed JSON (`<uint32-be><bytes>`) over
 *     Unix domain socket (or localhost TCP as fallback).
 *
 * The plugin is registered by the daemon when spawning each agent:
 *   claude --plugin-dir <claudeclaw-plus repo root> \
 *          --dangerously-load-development-channels plugin:claudeclaw-plus@inline
 * `--plugin-dir` points claude at the repo so it discovers the channel
 * definitions in `.claude-plugin/`, and the `@inline` tag matches the
 * plugin name registered there. Note the pre-#133 form
 * `plugin:plus-bus@local` no longer works.
 *
 * Env vars (set by Session Manager when spawning claude):
 *   CCAW_AGENT_ID  — stable slug for the agent; tags every outbound IPC frame
 *   CCAW_BUS_SOCK  — absolute UDS path (preferred)
 *   CCAW_BUS_PORT  — fallback TCP port (used only if CCAW_BUS_SOCK is unset)
 *   CCAW_BUS_TOKEN — required for TCP fallback (HMAC handshake; TODO Sprint 2)
 *
 * This file is gated by `runtime: bus` config — DO NOT import from
 * `src/runner.ts` or `src/commands/start.ts` (spec §12.5 plugin shim is
 * Sprint 4).
 */

import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  NotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BUS_MCP_TOOLS } from "./mcp-tools.js";
import {
  REQUEST_ID_PATTERN,
  type IpcAskAnswer,
  type IpcCancel,
  type IpcHello,
  type IpcMessage,
  type IpcPermissionRequest,
  type IpcPermissionResponse,
  type IpcPrompt,
  type IpcReply,
  type IpcRequestHuman,
  type PermissionRequest,
} from "./types.js";

/* ───────────────────────────────────────────────────────────────────── */
/* Capability constants (§5.1)                                           */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * BOTH capability strings are mandatory. Spike 0.1 binary check: aerolalit's
 * plugin at `server.ts:388,394` declares both. Omitting `claude/channel`
 * silently disables prompt delivery; omitting `claude/channel/permission`
 * disables the structured permission flow.
 */
export const CHANNEL_BASE_CAPABILITY = "claude/channel";
export const CHANNEL_PERMISSION_CAPABILITY = "claude/channel/permission";

/**
 * Legacy constant retained for reference. The Bus MCP notifications use the
 * flat `{content, meta}` shape per aerolalit (Sprint 1 integration correction)
 * which has no `channel_id` field. Kept exported so external tests or future
 * code paths that genuinely need a stable channel identifier have one place
 * to import from rather than repeating the magic string.
 */
export const CHANNEL_ID = "plus-bus";

/* ───────────────────────────────────────────────────────────────────── */
/* IPC transport contract                                                */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Abstract IPC transport — production uses UDS via `node:net`, tests inject
 * an in-memory fake. Length-prefixed framing is the transport's concern.
 */
export interface IpcTransport {
  send(msg: IpcMessage): void;
  onMessage(handler: (msg: IpcMessage) => void): void;
  close(): Promise<void>;
}

/* ───────────────────────────────────────────────────────────────────── */
/* UDS / TCP transport — length-prefixed JSON framing (§5.4)             */
/* ───────────────────────────────────────────────────────────────────── */

const LENGTH_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB sanity cap

/**
 * Open an IPC connection to Bus core. Prefers UDS (`CCAW_BUS_SOCK`); falls
 * back to TCP (`CCAW_BUS_PORT`) if UDS is unset. TCP path is stubbed for
 * Sprint 1 — HMAC token validation is TODO Sprint 2 (spec §5.4).
 */
export async function connectBusIpc(env: NodeJS.ProcessEnv = process.env): Promise<IpcTransport> {
  const sock = env.CCAW_BUS_SOCK?.trim();
  const port = env.CCAW_BUS_PORT?.trim();

  if (sock) {
    return await openSocketTransport({ path: sock });
  }
  if (port) {
    // TODO(Sprint 2): integrate CCAW_BUS_TOKEN HMAC handshake (§5.4).
    return await openSocketTransport({ port: Number(port), host: "127.0.0.1" });
  }
  throw new Error("Bus MCP: neither CCAW_BUS_SOCK nor CCAW_BUS_PORT set — cannot reach Bus core");
}

interface SocketOpts {
  path?: string;
  port?: number;
  host?: string;
}

function openSocketTransport(opts: SocketOpts): Promise<IpcTransport> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(opts as Parameters<typeof connect>[0]);
    sock.once("error", reject);
    sock.once("connect", () => {
      // Replace the connect-time `reject` handler with a post-connect handler
      // that surfaces socket errors instead of letting them become unhandled
      // 'error' events that crash the plugin process. Codex P1 on PR #110:
      // after the connect listener removed the only error handler, an
      // emitted socket error (Bus core restart, UDS unlinked, peer reset)
      // would propagate unhandled and tear the process down.
      sock.removeListener("error", reject);
      sock.on("error", (err) => {
        process.stderr.write(`Bus MCP: IPC socket error: ${String(err)}\n`);
      });
      resolve(wrapSocket(sock));
    });
  });
}

/**
 * Wrap a connected socket with length-prefixed JSON framing.
 * Frame: `<uint32-be length><utf8 json>`.
 */
export function wrapSocket(sock: Socket): IpcTransport {
  let buffer = Buffer.alloc(0);
  const handlers: Array<(msg: IpcMessage) => void> = [];

  sock.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= LENGTH_PREFIX_BYTES) {
      const len = buffer.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) {
        // Bad framing — drop the connection rather than risk OOM.
        sock.destroy(new Error(`Bus MCP: invalid frame length ${len}`));
        return;
      }
      if (buffer.length < LENGTH_PREFIX_BYTES + len) return; // wait for more
      const json = buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + len).toString("utf8");
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + len);
      try {
        const msg = JSON.parse(json) as IpcMessage;
        for (const h of handlers) h(msg);
      } catch (err) {
        process.stderr.write(`Bus MCP: dropped malformed IPC frame: ${String(err)}\n`);
      }
    }
  });

  return {
    send(msg: IpcMessage) {
      const json = Buffer.from(JSON.stringify(msg), "utf8");
      const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + json.length);
      frame.writeUInt32BE(json.length, 0);
      json.copy(frame, LENGTH_PREFIX_BYTES);
      sock.write(frame);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      return new Promise((resolve) => {
        sock.end(() => resolve());
      });
    },
  };
}

/* ───────────────────────────────────────────────────────────────────── */
/* MCP notification schemas                                              */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Inbound permission_request schema — empirically mirrored from aerolalit
 * `server.ts:420`. Field names and types are exact; Spike 0.1 is the
 * authoritative reference.
 */
const PermissionRequestNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

/* ───────────────────────────────────────────────────────────────────── */
/* Tool input schemas                                                    */
/* ───────────────────────────────────────────────────────────────────── */

const ReplyArgsSchema = z.object({
  message: z.string(),
  metadata: z
    .object({
      intent: z.enum(["final", "progress", "tool_status"]).optional(),
    })
    .optional(),
});

const AskArgsSchema = z.object({
  question: z.string(),
});

const CancelArgsSchema = z.object({
  reason: z.string().optional(),
});

const RequestHumanArgsSchema = z.object({
  question: z.string(),
});

/* ───────────────────────────────────────────────────────────────────── */
/* BusMcpServer — wiring logic, transport-agnostic                       */
/* ───────────────────────────────────────────────────────────────────── */

export interface BusMcpServerOptions {
  agentId: string;
  ipc: IpcTransport;
  /** Optional injected MCP server (tests pass a Server bound to InMemoryTransport). */
  mcp?: Server;
}

/**
 * Pending tool-call resolvers keyed by `ask_id`. `ask` returns immediately
 * with the id; `request_human` blocks on the promise. Both rely on the
 * Bus core delivering an `IpcAskAnswer` that references the same id.
 */
interface PendingAnswer {
  /** True for request_human (blocking); false for ask (already returned to model). */
  blocking: boolean;
  resolve: (answer: string) => void;
}

export class BusMcpServer {
  readonly mcp: Server;
  readonly ipc: IpcTransport;
  readonly agentId: string;

  private readonly pendingAnswers = new Map<string, PendingAnswer>();

  constructor(opts: BusMcpServerOptions) {
    this.agentId = opts.agentId;
    this.ipc = opts.ipc;
    this.mcp = opts.mcp ?? buildMcpServer();
    this.wireMcp();
    this.wireIpc();
  }

  /**
   * Run the handshake — call once after MCP transport is connected. Sends
   * `IpcHello` declaring both capability strings (Spike 0.1).
   */
  sendHello(): void {
    const hello: IpcHello = {
      type: "hello",
      agent_id: this.agentId,
      capabilities: [CHANNEL_BASE_CAPABILITY, CHANNEL_PERMISSION_CAPABILITY],
    };
    this.ipc.send(hello);
  }

  /** Test/inspection hook. */
  hasPendingAnswer(askId: string): boolean {
    return this.pendingAnswers.has(askId);
  }

  /* ── MCP → IPC plumbing ─────────────────────────────────────────── */

  private wireMcp(): void {
    // List tools — exposes the 4 outbound surfaces from §5.1 (defs in mcp-tools.ts).
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: BUS_MCP_TOOLS as unknown as Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>,
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      switch (name) {
        case "reply":
          return this.handleReply(rawArgs);
        case "edit_message":
          return this.handleEditMessage(rawArgs);
        case "ask":
          return this.handleAsk(rawArgs);
        case "cancel":
          return this.handleCancel(rawArgs);
        case "request_human":
          return this.handleRequestHuman(rawArgs);
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    });

    // Permission flow inbound — forwarded to Bus core (§5.1).
    this.mcp.setNotificationHandler(PermissionRequestNotificationSchema, async ({ params }) => {
      // Defence-in-depth: assert charset before forwarding so a malformed
      // upstream request fails fast with a useful Bus-side error instead
      // of polluting the audit log.
      if (!REQUEST_ID_PATTERN.test(params.request_id)) {
        process.stderr.write(
          `Bus MCP: dropping permission_request with invalid request_id "${params.request_id}"\n`,
        );
        return;
      }
      const request: PermissionRequest = {
        request_id: params.request_id,
        tool_name: params.tool_name,
        description: params.description,
        input_preview: params.input_preview,
      };
      const ipcMsg: IpcPermissionRequest = {
        type: "permission_request",
        agent_id: this.agentId,
        request,
      };
      this.ipc.send(ipcMsg);
    });
  }

  /* ── IPC → MCP plumbing ─────────────────────────────────────────── */

  private wireIpc(): void {
    this.ipc.onMessage((msg) => {
      switch (msg.type) {
        case "prompt":
          this.deliverPrompt(msg);
          return;
        case "ask_answer":
          this.deliverAskAnswer(msg);
          return;
        case "permission_response":
          this.deliverPermissionResponse(msg);
          return;
        // Bus core never sends these to the plugin in normal operation;
        // log and ignore for forward-compat.
        default:
          return;
      }
    });
  }

  private deliverPrompt(msg: IpcPrompt): void {
    // §5.1 (corrected): `notifications/claude/channel` uses the FLAT shape
    // `params: {content, meta}` per aerolalit's reference plugin — empirically
    // the only shape `claude 2.1.143` accepts. The earlier nested
    // `{channel_id, payload: {text, metadata}}` shape from the v2 spec was
    // unverified speculation and would be rejected by the runtime. Sprint 1
    // integration corrected the spec to match aerolalit.
    void this.mcp
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            origin: msg.origin,
            origin_id: msg.origin_id,
            ...(msg.metadata ?? {}),
          },
        },
      })
      .catch((err: unknown) => {
        process.stderr.write(`Bus MCP: prompt notification failed: ${String(err)}\n`);
      });
  }

  private deliverAskAnswer(msg: IpcAskAnswer): void {
    const pending = this.pendingAnswers.get(msg.ask_id);
    if (pending?.blocking) {
      // request_human resolves the awaiting tool-call promise.
      this.pendingAnswers.delete(msg.ask_id);
      pending.resolve(msg.answer);
      return;
    }

    // Non-blocking `ask`: deliver the answer through the same channel
    // notification the model is already listening to, tagged with ask_id.
    // The model correlates by id to its earlier ask() call.
    if (pending) this.pendingAnswers.delete(msg.ask_id);
    void this.mcp
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.answer,
          meta: { ask_id: msg.ask_id, kind: "ask_answer" },
        },
      })
      .catch((err: unknown) => {
        process.stderr.write(`Bus MCP: ask_answer notification failed: ${String(err)}\n`);
      });
  }

  private deliverPermissionResponse(msg: IpcPermissionResponse): void {
    const { request_id, behavior } = msg.response;
    // §5.1: payload field is `behavior` — NOT `decision`. NO `reason`. Spike 0.1.
    void this.mcp
      .notification({
        method: "notifications/claude/channel/permission",
        params: { request_id, behavior },
      })
      .catch((err: unknown) => {
        process.stderr.write(`Bus MCP: permission notification failed: ${String(err)}\n`);
      });
  }

  /* ── Tool handlers ──────────────────────────────────────────────── */

  private handleReply(raw: unknown) {
    const args = ReplyArgsSchema.parse(raw ?? {});
    const ipcMsg: IpcReply = {
      type: "reply",
      agent_id: this.agentId,
      text: args.message,
      intent: args.metadata?.intent ?? "progress",
    };
    this.ipc.send(ipcMsg);
    return {
      content: [{ type: "text", text: "delivered" }],
    };
  }

  private handleEditMessage(raw: unknown) {
    const args = raw as { message?: unknown };
    if (typeof args.message !== "string") {
      return {
        content: [{ type: "text", text: "edit_message requires 'message' (string)" }],
        isError: true,
      };
    }
    this.ipc.send({
      type: "edit_message",
      agent_id: this.agentId,
      text: args.message,
    });
    return { content: [{ type: "text", text: "edited" }] };
  }

  private handleAsk(raw: unknown) {
    const args = AskArgsSchema.parse(raw ?? {});
    const askId = randomUUID();
    this.pendingAnswers.set(askId, {
      blocking: false,
      // Non-blocking ask never awaits; resolve is a no-op kept for shape parity.
      resolve: () => undefined,
    });
    this.ipc.send({
      type: "ask",
      agent_id: this.agentId,
      ask_id: askId,
      question: args.question,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ ask_id: askId }) }],
    };
  }

  private handleCancel(raw: unknown) {
    const args = CancelArgsSchema.parse(raw ?? {});
    const ipcMsg: IpcCancel = {
      type: "cancel",
      agent_id: this.agentId,
      ...(args.reason ? { reason: args.reason } : {}),
    };
    this.ipc.send(ipcMsg);
    return {
      content: [{ type: "text", text: "cancelled" }],
    };
  }

  private async handleRequestHuman(raw: unknown) {
    const args = RequestHumanArgsSchema.parse(raw ?? {});
    // Reuse the ask-answer pipeline — request_human is structurally `ask`
    // with blocking semantics (the tool call awaits the promise instead of
    // returning the id immediately).
    //
    // The same `ask_id` MUST flow out on the IpcRequestHuman so the adapter
    // knows which id to echo on its IpcAskAnswer. Without it the answer
    // pipeline can't route back here and the tool call blocks forever
    // (Codex P1 on PR #110).
    const askId = randomUUID();
    const answerPromise = new Promise<string>((resolve) => {
      this.pendingAnswers.set(askId, { blocking: true, resolve });
    });
    const ipcMsg: IpcRequestHuman = {
      type: "request_human",
      agent_id: this.agentId,
      ask_id: askId,
      question: args.question,
    };
    this.ipc.send(ipcMsg);
    const answer = await answerPromise;
    return {
      content: [{ type: "text", text: answer }],
    };
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* MCP server factory                                                    */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Build the underlying MCP Server with the §5.1 capabilities. Exported so
 * tests can construct a server, wire it to InMemoryTransport, and inject
 * into BusMcpServer without standing up a real stdio pipe.
 */
export function buildMcpServer(): Server {
  return new Server(
    { name: "plus-bus", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: {
          [CHANNEL_BASE_CAPABILITY]: {},
          [CHANNEL_PERMISSION_CAPABILITY]: {},
        },
      },
      instructions:
        "ClaudeClaw+ Bus channel. Messages from a surface (Telegram/Discord/Slack/Web) " +
        "arrive as <channel source=\"...\" chat_id=\"...\" user_id=\"...\" ts=\"...\">text</channel> " +
        "blocks typed into your REPL. Your transcript output is NOT visible to the user — " +
        "only the `reply` and `edit_message` tools reach them. You MUST answer with `reply`.\n\n" +
        "Pick ONE pattern per turn:\n" +
        "  • DIRECT (chat / simple Q&A, no tools): a single `reply` intent:'final'.\n" +
        "  • PROGRESSIVE (you'll run tools, read files, search or analyze): call `reply` " +
        "    intent:'progress' first with a 1-line ack of what you're doing, then " +
        "    `edit_message` to update that same message as you go (edits don't notify), " +
        "    and finish with `reply` intent:'final' for the user-visible answer (this " +
        "    push-notifies).\n" +
        "Default to PROGRESSIVE whenever you use ANY tool; DIRECT only for pure chat. " +
        "Use `ask` for non-blocking clarifying questions; `request_human` blocks the loop.",
    },
  );
}

/* ───────────────────────────────────────────────────────────────────── */
/* Production entrypoint                                                 */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Boot the Bus MCP server for production use. Reads env, connects to Bus
 * core, wires MCP stdio transport, sends the IpcHello handshake.
 *
 * Not imported from anywhere in the legacy runner — gated behind
 * `runtime: bus` config (§12).
 */
export async function startBusMcpServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BusMcpServer> {
  const agentId = env.CCAW_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error("Bus MCP: CCAW_AGENT_ID env var is required");
  }
  const ipc = await connectBusIpc(env);
  const bus = new BusMcpServer({ agentId, ipc });
  const transport = new StdioServerTransport();
  await bus.mcp.connect(transport);
  bus.sendHello();
  return bus;
}

if (import.meta.main) {
  // When this server is auto-loaded by `claude --plugin-dir <root>` from
  // the ClaudeClaw+ plugin's `.mcp.json`, it gets invoked in TWO
  // contexts:
  //
  //   1. Daemon-spawned agent (Bus runtime active): `CCAW_BUS_SOCK` and
  //      `CCAW_AGENT_ID` are set by SessionManager — boot the server.
  //   2. Operator's own interactive claude with the plugin installed
  //      but no daemon running: env vars absent — silently exit. Without
  //      this guard, every claude session would log a noisy "Bus MCP:
  //      fatal startup error" from a server they didn't ask for.
  //
  // Partial-set (exactly one of the two env vars present) is a real
  // operator error — a half-finished bootstrap or a stale env. Treat it
  // as a fatal misconfiguration so it surfaces in the operator's claude
  // log instead of silently no-op'ing.
  const hasSock = !!process.env.CCAW_BUS_SOCK;
  const hasAgent = !!process.env.CCAW_AGENT_ID;
  if (!hasSock && !hasAgent) {
    process.exit(0);
  }
  if (hasSock !== hasAgent) {
    const set = hasSock ? "CCAW_BUS_SOCK" : "CCAW_AGENT_ID";
    const missing = hasSock ? "CCAW_AGENT_ID" : "CCAW_BUS_SOCK";
    process.stderr.write(
      `Bus MCP: ${set} is set but ${missing} is not — refusing to boot. ` +
        `Both env vars must be set together (daemon path) or both unset (operator path).\n`,
    );
    process.exit(2);
  }
  startBusMcpServer().catch((err: unknown) => {
    process.stderr.write(`Bus MCP: fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}
