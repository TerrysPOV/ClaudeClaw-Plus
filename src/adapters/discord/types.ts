/**
 * Discord adapter — config + wire shapes.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.1.
 * Sprint coordination: `src/bus/SPRINT_3_PLAN.md` (Agent A scope).
 *
 * These shapes are intentionally minimal. The full Discord wire surface
 * lives in `src/commands/discord.ts` (~2052 LOC, PTY-coupled). The Bus
 * adapter only needs the subset required for `MESSAGE_CREATE` ingress,
 * `INTERACTION_CREATE` button clicks, and outbound message + reaction
 * posting.
 *
 * NOTE: when Sprint 4 splits more of the existing discord.ts into a
 * shared `src/discord/api.ts` module (see Sprint 3 TODOs in
 * `index.ts`), these types should move there. Keep them local for now
 * to avoid the circular dependency Sprint 3 was instructed to avoid.
 */

import type { BusCore } from "../../bus/core";

/* ────────────────────────────────────────────────────────────────────── */
/* Public adapter options                                                 */
/* ────────────────────────────────────────────────────────────────────── */

export interface DiscordAdapterOptions {
  bus: BusCore;
  /** Bot token (same source as `settings.discord.token` in legacy). */
  token: string;
  /** Discord user ID allow-list. Empty → silent-deny everything. */
  allowedUserIds: string[];
  /**
   * Routing: which agent owns each Discord channel / thread / DM.
   *
   * - `channels`  — guild channel id → agent_id
   * - `threads`   — thread id → agent_id (else inherit parent channel)
   * - `dmAgentId` — default for DMs (recommended `"global"` to match
   *                  the legacy single-session DM behaviour)
   */
  routing: {
    channels: Record<string, string>;
    threads?: Record<string, string>;
    dmAgentId?: string;
    /**
     * `agent_id → channel_id`. When set for an agent, non-channel-driven
     * origins (cron / heartbeat / cli / rest / no origin) deliver ONLY to
     * this channel rather than fanning out to every routed channel.
     */
    primaryChannelByAgent?: Record<string, string>;
  };
  /** Optional logger; defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
  /**
   * Optional injected gateway. Tests pass a `FakeDiscordGateway`; in
   * production the adapter constructs a real WS gateway from `token`.
   *
   * The interface is deliberately small — enough for the adapter to
   * subscribe to inbound events and call back into Discord. The real
   * REST surface is exposed via `restApi`, also injectable for tests.
   */
  gateway?: DiscordGatewayLike;
  /** Optional injected REST client. Tests pass a stub. */
  restApi?: DiscordRestApiLike;
  /**
   * Rate-limit override — mirrors `checkDiscordRateLimit` in
   * `src/commands/discord.ts:148`. Pass `() => true` in tests to disable.
   */
  rateLimitCheck?: (userId: string) => boolean;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Wire shapes — subset of the real Discord gateway/API payloads          */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Minimal `MESSAGE_CREATE` shape. Mirrors `DiscordMessage` in
 * `src/commands/discord.ts:77` but only the fields the adapter uses.
 */
export interface DiscordInboundMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  attachments: DiscordAttachment[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  size: number;
  /** Discord IS_VOICE_MESSAGE flag is bit 13 — see `isVoiceAttachment`. */
  flags?: number;
}

/**
 * Minimal `INTERACTION_CREATE` shape for button (MESSAGE_COMPONENT)
 * interactions. Mirrors `DiscordInteraction` in
 * `src/commands/discord.ts:92`.
 */
export interface DiscordInboundInteraction {
  id: string;
  /** 2 = APPLICATION_COMMAND, 3 = MESSAGE_COMPONENT. Adapter cares about 3. */
  type: number;
  data?: { custom_id?: string };
  channel_id?: string;
  guild_id?: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  token: string;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Gateway / REST abstractions — allow FakeDiscordGateway in tests        */
/* ────────────────────────────────────────────────────────────────────── */

export type GatewayEvent =
  | { type: "MESSAGE_CREATE"; message: DiscordInboundMessage }
  | { type: "INTERACTION_CREATE"; interaction: DiscordInboundInteraction };

export interface DiscordGatewayLike {
  /** Start the gateway (connect WS, authenticate, etc.). */
  start(): Promise<void>;
  /** Stop and clean up the connection. */
  stop(): Promise<void>;
  /** Subscribe to inbound events. Returns an unsubscribe fn. */
  onEvent(handler: (e: GatewayEvent) => void): () => void;
}

export interface DiscordRestApiLike {
  /** Post a plain text message (auto-chunked at 2000 chars). */
  sendMessage(channelId: string, text: string, components?: unknown[]): Promise<void>;
  /**
   * Respond to a `MESSAGE_COMPONENT` interaction. Used to ack permission
   * button clicks so Discord doesn't show "interaction failed".
   */
  respondToInteraction(
    interactionId: string,
    interactionToken: string,
    body: { content: string; flags?: number },
  ): Promise<void>;
  /**
   * Fire-and-forget typing indicator. Discord shows "Bot is typing..."
   * for ~10 seconds after this call returns. The adapter triggers one on
   * every accepted inbound prompt so users get visible feedback while
   * the agent generates a reply.
   */
  sendTyping(channelId: string): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Permission button custom_id encoding                                   */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * `custom_id` shape used for permission-prompt buttons. Format:
 *   `ccaw_perm_<allow|deny>_<request_id>`
 *
 * Discord limits `custom_id` to 100 chars; `request_id` is 5 lowercase
 * chars per `REQUEST_ID_PATTERN` (Spike 0.1), so we have plenty of room.
 *
 * Encoding inline (not a parser fn) because the adapter only reads them
 * in one place — `handleInteraction` — and a regex is clearer than a
 * helper hop.
 */
export const PERMISSION_BUTTON_PREFIX = "ccaw_perm_";
