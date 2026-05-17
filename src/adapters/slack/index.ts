/**
 * Slack Bus adapter (Sprint 4 Agent A).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3 — Slack is
 * NOT on Anthropic's Channels allowlist, so the Bus MCP is permanent
 * plumbing for Slack regardless of Channels GA.
 *
 * Coordination: `src/bus/SPRINT_4_PLAN.md`. Behaviour parity with the
 * legacy PTY-coupled listener at `src/commands/slack.ts` (1950 LOC) for
 * the subset the Bus runtime needs.
 *
 * PR #113 review carryovers (don't repeat):
 *   1. Allow-list: empty = allow all (legacy `slack.ts:976`).
 *   2. Composite keying for pendingPermissions / pendingHumanAsks.
 *
 * Sprint 4.5+ TODOs at end of file.
 */

import type { BusCore, Subscription } from "../../bus/core";
import type { BusEvent, PermissionRequest } from "../../bus/types";
import { createSlackApi } from "./api";
import { buildPermissionBlocks } from "./blocks";
import { verifySlackSignature } from "./signature";
import {
  PERMISSION_ACTION_ID_REGEX,
  type SlackAdapterOptions,
  type SlackApi,
  type SlackBlock,
  type SlackBlockActionsPayload,
  type SlackEventsApiEnvelope,
  type SlackMessageEvent,
  type SlackSocketEnvelope,
  type SlackSocketLike,
} from "./types";

interface PendingPermission {
  agent_id: string;
  channel_id: string;
  /** Thread the prompt was rendered into, so the ack reply can thread back. */
  thread_ts?: string;
}

interface PendingHumanAsk {
  ask_id: string;
  agent_id: string;
  channel_id: string;
  thread_ts?: string;
}

export class SlackAdapter {
  private readonly bus: BusCore;
  private readonly token: string;
  private readonly signingSecret: string;
  private readonly api: SlackApi;
  private readonly socket: SlackSocketLike | null;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly channels: Record<string, string>;
  private readonly threadAgentId: string | undefined;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;

  /** Active bus subscriptions, one collection per routed agent. */
  private readonly subscriptions = new Map<string, Subscription[]>();
  /** Unsubscribe from Socket Mode envelopes; null until `start()`. */
  private socketOff: (() => void) | null = null;

  /**
   * Pending permissions, keyed `${agent_id}:${channel_id}:${request_id}`
   * — composite per PR #113 review (Telegram had chat-id-only keying).
   * Two agents prompting in the same channel never collide.
   */
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /**
   * Pending `system.request_human` asks keyed `${agent_id}:${channel_id}`.
   * First allowed-user reply in that channel resolves via `ingestAskAnswer`.
   */
  private readonly pendingHumanAsks = new Map<string, PendingHumanAsk>();

  /** Thread ownership cache keyed `${channel_id}:${thread_ts}`. */
  private readonly threadOwners = new Map<string, string>();

  private started = false;

  constructor(opts: SlackAdapterOptions) {
    if (!opts.bus) throw new Error("SlackAdapter: `bus` is required");
    if (!opts.token) throw new Error("SlackAdapter: `token` is required");
    if (!opts.signingSecret) throw new Error("SlackAdapter: `signingSecret` is required");
    if (!opts.routing) throw new Error("SlackAdapter: `routing` is required");

    this.bus = opts.bus;
    this.token = opts.token;
    this.signingSecret = opts.signingSecret;
    this.api = opts.api ?? createSlackApi(opts.token);
    this.socket = opts.socket ?? null;
    this.allowedUserIds = new Set(opts.allowedUserIds);
    this.channels = { ...opts.routing.channels };
    this.threadAgentId = opts.routing.threadAgentId;
    this.logger = opts.logger ?? console;
  }

  /* ──────────────────────────── lifecycle ─────────────────────────── */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Subscribe BEFORE wiring the socket so racey early events aren't
    // dropped (mirrors Discord `src/adapters/discord/index.ts:133-145`).
    for (const agentId of this.uniqueAgentIds()) {
      this.subscribeForAgent(agentId);
    }
    // Codex P2 fix on PR #117: if socket startup throws, roll back the
    // started flag + tear down subscriptions so callers can retry. Without
    // this, a transient socket auth/network failure leaves the adapter
    // stuck in a permanently-started-but-not-running state.
    if (this.socket) {
      try {
        this.socketOff = this.socket.onEnvelope((env) => {
          void this.handleSocketEnvelope(env);
        });
        await this.socket.start();
      } catch (err) {
        // Undo the partial bring-up.
        try {
          this.socketOff?.();
        } catch {
          /* ignore */
        }
        this.socketOff = null;
        for (const subs of this.subscriptions.values()) {
          for (const sub of subs) {
            try {
              sub.close();
            } catch {
              /* ignore */
            }
          }
        }
        this.subscriptions.clear();
        this.started = false;
        throw err;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Detach socket first so late envelopes don't reach a stopped adapter.
    if (this.socketOff) {
      try {
        this.socketOff();
      } catch (err) {
        this.logger.error("[slack-adapter] socket off failed", err);
      }
      this.socketOff = null;
    }
    if (this.socket) {
      try {
        await this.socket.stop();
      } catch (err) {
        this.logger.error("[slack-adapter] socket stop failed", err);
      }
    }

    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        try {
          sub.close();
        } catch (err) {
          this.logger.error("[slack-adapter] subscription.close failed", err);
        }
      }
    }
    this.subscriptions.clear();

    // Clear ALL pending maps — PR #113 review caught Telegram missing this.
    this.pendingPermissions.clear();
    this.pendingHumanAsks.clear();
    this.threadOwners.clear();
  }

  /* ──────────────────────────── inbound (Socket Mode) ───────────── */

  /** Dispatch a Socket Mode envelope. Tests can also call this directly. */
  async handleSocketEnvelope(env: SlackSocketEnvelope): Promise<void> {
    // Auto-ack within Slack's 3-second window (legacy line 1647). Bus
    // adapter never returns a response payload (always async via
    // chat.postMessage) so we ack as soon as we see envelope_id.
    if (env.envelope_id && this.socket) {
      try {
        this.socket.ack(env.envelope_id);
      } catch (err) {
        this.logger.error("[slack-adapter] socket ack failed", err);
      }
    }

    if (env.type === "events_api" && env.payload?.event) {
      await this.handleMessageEvent(env.payload.event);
      return;
    }
    if (env.type === "interactive" && env.payload?.type === "block_actions") {
      await this.handleBlockActions(env.payload as SlackBlockActionsPayload);
    }
  }

  /* ──────────────────────────── inbound (Events API HTTP) ───────── */

  /**
   * Process an Events API HTTP request. Caller verifies signature first
   * via `verifyEventsApiSignature`. Returns the body the HTTP handler
   * sends to Slack — challenge string for `url_verification`, else "".
   */
  async handleEventsApiRequest(envelope: SlackEventsApiEnvelope): Promise<string> {
    if (envelope.type === "url_verification" && envelope.challenge) {
      return envelope.challenge;
    }
    if (envelope.type === "event_callback" && envelope.event) {
      await this.handleMessageEvent(envelope.event);
    }
    return "";
  }

  /**
   * Process an interactivity HTTP request (button clicks). Caller must
   * decode Slack's `application/x-www-form-urlencoded` `payload` field
   * before calling. Same signing secret as Events API.
   */
  async handleInteractivityRequest(payload: SlackBlockActionsPayload): Promise<void> {
    if (payload.type !== "block_actions") return;
    await this.handleBlockActions(payload);
  }

  /** Verify `X-Slack-Signature`. Wraps `./signature.ts` with our secret. */
  verifyEventsApiSignature(opts: { body: string; timestamp: string; signature: string }): boolean {
    return verifySlackSignature({ ...opts, signingSecret: this.signingSecret });
  }

  /* ──────────────────────────── message handler ─────────────────── */

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    // Drop bots + non-file_share subtypes (legacy `slack.ts:940-950`). No
    // allowBots support in Sprint 4 — operators using that pattern stay on
    // the PTY runtime.
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== "file_share") return;
    if (!event.user) return;

    const userId = event.user;
    const channelId = event.channel;

    // Allow-list — empty = allow all (legacy `slack.ts:976` semantics; PR
    // #113 review caught Discord/Telegram regressing to "empty = deny").
    // Slack is multi-channel so we silent-skip — no "Unauthorized." DM.
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      return;
    }

    const agentId = this.resolveAgentId(event);
    if (!agentId) {
      this.logger.warn(`[slack-adapter] unrouted channel=${channelId} — skip`);
      return;
    }
    if (event.thread_ts) {
      this.threadOwners.set(`${channelId}:${event.thread_ts}`, agentId);
    }

    // Pending request_human → route reply as ask_answer. Composite key per
    // PR #113. Empty text gates the consume (matches Telegram parity:
    // `src/adapters/telegram/index.ts:274`).
    const askKey = `${agentId}:${channelId}`;
    const pendingAsk = this.pendingHumanAsks.get(askKey);
    if (pendingAsk && event.text && event.text.trim().length > 0) {
      this.pendingHumanAsks.delete(askKey);
      try {
        this.bus.ingestAskAnswer({
          agent_id: pendingAsk.agent_id,
          ask_id: pendingAsk.ask_id,
          answer: event.text.trim(),
        });
      } catch (err) {
        this.logger.error("[slack-adapter] ingestAskAnswer failed", err);
      }
      return;
    }

    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    const trimmed = (event.text ?? "").trim();
    if (!trimmed && !hasFiles) return;

    // Sprint 4 forwards file metadata only — download/transcription is a
    // Sprint 4+ attachment-pipeline task.
    const metadata: Record<string, unknown> = {
      ts: event.ts,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...(hasFiles && event.files
        ? {
            files: event.files.map((f) => ({
              id: f.id,
              name: f.name,
              mimetype: f.mimetype,
              filetype: f.filetype,
              size: f.size,
              url_private: f.url_private,
            })),
          }
        : {}),
    };

    try {
      await this.bus.sendPrompt({
        agent_id: agentId,
        origin: "slack",
        origin_id: channelId,
        user_id: userId,
        text: trimmed,
        metadata,
      });
    } catch (err) {
      this.logger.error("[slack-adapter] sendPrompt failed", err);
    }
  }

  /* ──────────────────────────── interactivity handler ───────────── */

  private async handleBlockActions(payload: SlackBlockActionsPayload): Promise<void> {
    const userId = payload.user?.id;
    if (!userId) return;

    // Allow-list — empty = allow all (legacy parity, `src/commands/slack.ts:1453`).
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      return;
    }

    const channelId = payload.channel?.id;
    if (!channelId) return;

    const action = payload.actions?.[0];
    if (!action) return;

    const match = action.action_id.match(PERMISSION_ACTION_ID_REGEX);
    if (!match) return;

    const behavior = match[1] as "allow" | "deny";
    const agentId = match[2];
    const requestId = match[3];
    if (!agentId || !requestId) return;

    // Codex P1 fix on PR #117: look up the EXACT composite key carried
    // on the wire (agent_id + channel_id + request_id). The earlier
    // scan-and-suffix-match approach risked picking the wrong agent's
    // pending request given the 5-char [a-km-z] request_id collision
    // space.
    const pendingKey = `${agentId}:${channelId}:${requestId}`;
    const pending = this.pendingPermissions.get(pendingKey);
    // Stale button (e.g. restart) — silent skip; envelope already auto-acked.
    if (!pending) return;
    this.pendingPermissions.delete(pendingKey);

    try {
      this.bus.ingestPermissionDecision({
        agent_id: pending.agent_id,
        request_id: requestId,
        behavior,
      });
    } catch (err) {
      this.logger.error("[slack-adapter] ingestPermissionDecision failed", err);
    }

    // Confirmation reply mirrors Telegram's `safeAnswerCallback` text.
    const ackText = behavior === "allow" ? "✅ Allowed" : "❌ Denied";
    await this.safePostMessage({
      channel: channelId,
      text: ackText,
      thread_ts: pending.thread_ts,
    });
  }

  /* ──────────────────────────── bus subscriptions ───────────────── */

  private subscribeForAgent(agentId: string): void {
    if (this.subscriptions.has(agentId)) return;
    const subs: Subscription[] = [
      this.bus.subscribe(
        { agent_id: agentId, topics: ["response.text"] },
        (event) => void this.handleResponseText(agentId, event),
      ),
      this.bus.subscribe(
        { agent_id: agentId, topics: ["channel.permission_request"] },
        (event) => void this.handlePermissionRequest(agentId, event),
      ),
      this.bus.subscribe(
        { agent_id: agentId, topics: ["system.request_human"] },
        (event) => void this.handleRequestHuman(agentId, event),
      ),
    ];
    this.subscriptions.set(agentId, subs);
  }

  private async handleResponseText(agentId: string, event: BusEvent): Promise<void> {
    const payload = event.payload as { text?: string };
    const text = typeof payload?.text === "string" ? payload.text : "";
    if (text.length === 0) return;

    // Fan-out to every routed channel — Bus runtime doesn't track
    // originating channel through events yet (Sprint 4 polish item shared
    // with Discord/Telegram).
    const channels = this.channelsForAgent(agentId);
    if (channels.length === 0) {
      this.logger.warn(`[slack-adapter] no channels for agent ${agentId}; dropping response.text`);
      return;
    }
    for (const channelId of channels) {
      await this.safePostMessage({ channel: channelId, text });
    }
  }

  private async handlePermissionRequest(agentId: string, event: BusEvent): Promise<void> {
    const req = event.payload as PermissionRequest | undefined;
    if (!req || typeof req.request_id !== "string") return;

    const channels = this.channelsForAgent(agentId);
    if (channels.length === 0) {
      this.logger.warn(
        `[slack-adapter] no channels for agent ${agentId}; dropping permission_request`,
      );
      return;
    }

    const blocks = buildPermissionBlocks(req, agentId);
    for (const channelId of channels) {
      this.pendingPermissions.set(`${agentId}:${channelId}:${req.request_id}`, {
        agent_id: agentId,
        channel_id: channelId,
      });
      await this.safePostMessage({
        channel: channelId,
        // `text` is a fallback for notifications when Block Kit can't render.
        text: `Permission request: ${req.tool_name}`,
        blocks,
      });
    }
  }

  private async handleRequestHuman(agentId: string, event: BusEvent): Promise<void> {
    const payload = event.payload as { ask_id?: string; question?: string };
    if (typeof payload?.ask_id !== "string" || typeof payload?.question !== "string") {
      return;
    }
    const channels = this.channelsForAgent(agentId);
    if (channels.length === 0) {
      this.logger.warn(`[slack-adapter] no channels for agent ${agentId}; dropping request_human`);
      return;
    }

    const text = `:thinking_face: *Needs a human:* ${payload.question}\n_Reply in this channel to answer._`;
    // One pending ask per (agent, channel) — newer supersedes older (§5.4).
    for (const channelId of channels) {
      this.pendingHumanAsks.set(`${agentId}:${channelId}`, {
        ask_id: payload.ask_id,
        agent_id: agentId,
        channel_id: channelId,
      });
      await this.safePostMessage({ channel: channelId, text });
    }
  }

  /* ──────────────────────────── helpers ─────────────────────────── */

  private uniqueAgentIds(): string[] {
    const set = new Set<string>();
    for (const agent of Object.values(this.channels)) set.add(agent);
    if (this.threadAgentId) set.add(this.threadAgentId);
    return Array.from(set);
  }

  private channelsForAgent(agentId: string): string[] {
    const out: string[] = [];
    for (const [chId, aid] of Object.entries(this.channels)) {
      if (aid === agentId) out.push(chId);
    }
    return out;
  }

  /**
   * Resolve agent_id: recorded thread owner → direct channel mapping →
   * threadAgentId (for thread replies in unrouted channels) → null.
   */
  private resolveAgentId(event: SlackMessageEvent): string | null {
    if (event.thread_ts) {
      const threadKey = `${event.channel}:${event.thread_ts}`;
      const owner = this.threadOwners.get(threadKey);
      if (owner) return owner;
    }
    const direct = this.channels[event.channel];
    if (direct) return direct;
    if (event.thread_ts && this.threadAgentId) return this.threadAgentId;
    return null;
  }

  /** Best-effort post — never throws, always logs failures. */
  private async safePostMessage(params: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: SlackBlock[];
  }): Promise<void> {
    try {
      const res = await this.api.postMessage(params);
      if (!res.ok) {
        this.logger.error(`[slack-adapter] chat.postMessage error: ${res.error ?? "unknown"}`);
      }
    } catch (err) {
      this.logger.error("[slack-adapter] chat.postMessage threw", err);
    }
  }
}

// Re-exports for ergonomic test imports.
export type {
  SlackAdapterOptions,
  SlackApi,
  SlackBlock,
  SlackBlockActionsPayload,
  SlackEventsApiEnvelope,
  SlackMessageEvent,
  SlackSocketEnvelope,
  SlackSocketLike,
} from "./types";
export { PERMISSION_ACTION_ID_REGEX } from "./types";
export { createSlackApi } from "./api";
export { buildPermissionBlocks } from "./blocks";
export { verifySlackSignature } from "./signature";

/* Sprint 4.5+ TODOs (deferred — coordinator tracks in SPRINT_4_PLAN.md):
 *  - Production Socket Mode WebSocket driver (`./socket.ts`); extract
 *    from `src/commands/slack.ts:1751-1830`.
 *  - Events API HTTP turn-key handler (`./http.ts`).
 *  - File download + voice transcription → `attachment.*` BusEvents
 *    (legacy `src/commands/slack.ts:1064-1110`).
 *  - Assistant Threads helpers (legacy lines 248-292).
 *  - Streaming/edit-in-place rendering via `chat.update` (legacy line 403+).
 *  - Slash command relay via `bus.invokeSlashCommand` (Sprint 4 Agent C).
 *  - `[react:<emoji>]` + `[[slack_buttons:…]]` / `[[slack_select:…]]`
 *    directive parity (legacy lines 332-356, 438-494).
 *  - Multi-workspace install routing (team_id → workspace token).
 *  - Retire `src/commands/slack.ts` once Sprint 5 flips `runtime: bus`.
 */
