/**
 * Discord Bus adapter.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.1 + §6.1.
 * Sprint coordination: `src/bus/SPRINT_3_PLAN.md` (Agent A scope).
 *
 * Surface:
 *   - Inbound  Discord gateway → `bus.sendPrompt({origin: 'discord', …})`
 *   - Outbound `bus.subscribe({agent_id, …})` →
 *       `response.text`              → `sendMessage(channel, text)`
 *       `channel.permission_request` → button-row prompt
 *       `system.request_human`       → "needs a human" message; first
 *                                       channel reply → `ingestAskAnswer`
 *
 * Behaviour parity is intentional with the legacy PTY-coupled listener
 * at `src/commands/discord.ts` (~2052 LOC). Key parallels:
 *   - Allow-list: `discord.ts:882`. DM → "Unauthorized.", guild → silent.
 *   - Rate limit: `discord.ts:148` `checkDiscordRateLimit`.
 *   - Attachment detection: `discord.ts:604` `isImageAttachment` + friends.
 *   - Channel/thread/DM identity: `discord.ts:527` `guildTriggerReason`
 *     + `knownThreads` (188). Externalised here as `router.ts`.
 *   - Gateway connect/heartbeat/reconnect: ported into
 *     `./gateway.ts` (`DiscordGateway` class). Adapter depends on the
 *     `DiscordGatewayLike` abstraction so tests can inject
 *     `FakeDiscordGateway`; production constructs `DiscordGateway`
 *     from the token automatically when no `gateway` is passed.
 *   - REST surface: ported into `./rest-api.ts`. Same injection /
 *     auto-construct pattern as the gateway.
 *
 * Sprint 4 follow-ups (legacy parity not yet ported into the Bus path):
 * thread rejoin (GUILD_CREATE), slash-command registration, attachment
 * download + voice transcription, streaming edit-in-place renderer.
 * These are independent of the gateway lifecycle and can land
 * incrementally; the staging guide flags which are required for full
 * legacy parity vs. acceptable-for-staging.
 */

import type { BusCore, Subscription } from "../../bus/core";
import {
  CHANNEL_DRIVEN_ORIGINS,
  type BusEvent,
  type BusOrigin,
  type PermissionRequest,
} from "../../bus/types";
import { createDiscordGateway } from "./gateway";
import {
  attachmentMeta,
  buildPermissionButtons,
  formatPermissionPrompt,
  makeDefaultRateLimit,
  parsePermissionCustomId,
  summariseAttachments,
} from "./helpers";
import { createDiscordRestApi } from "./rest-api";
import { resolveAgentId, uniqueAgentIds, type RoutingConfig } from "./router";
import type {
  DiscordAdapterOptions,
  DiscordGatewayLike,
  DiscordInboundInteraction,
  DiscordInboundMessage,
  DiscordRestApiLike,
  GatewayEvent,
} from "./types";

/* ────────────────────────────────────────────────────────────────────── */
/* Adapter                                                                */
/* ────────────────────────────────────────────────────────────────────── */

export class DiscordAdapter {
  private readonly bus: BusCore;
  private readonly token: string;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly routing: RoutingConfig;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;
  private readonly rateLimitCheck: (userId: string) => boolean;
  private readonly gateway: DiscordGatewayLike;
  private readonly restApi: DiscordRestApiLike;

  /** Active bus subscriptions, one per unique routed agent. */
  private subscriptions: Subscription[] = [];
  /** Unsubscribe from gateway events; null until `start()`. */
  private gatewayOff: (() => void) | null = null;

  /**
   * Permission requests we've forwarded to Discord. Keyed by
   * `request_id` — when a button click arrives we look up the
   * `agent_id` so `ingestPermissionDecision` can route correctly.
   *
   * Sprint 3 keeps this map in-process. Sprint 5 (durable Bus state)
   * may persist it so an adapter restart doesn't orphan in-flight
   * permission prompts.
   */
  private readonly pendingPermissions = new Map<string, { agent_id: string }>();

  /**
   * Outstanding `system.request_human` asks, keyed by `(agent_id,
   * channel_id)`. The first allowed user reply in that channel
   * resolves it via `bus.ingestAskAnswer`.
   *
   * The legacy listener didn't have this concept — `request_human` is
   * new in the Bus runtime. Contract documented in
   * `src/bus/core.ts:411` (PR #110 fix carrying `ask_id`).
   */
  private readonly pendingHumanAsks = new Map<string, { ask_id: string; agent_id: string }>();

  private started = false;

  constructor(opts: DiscordAdapterOptions) {
    if (!opts.bus) throw new Error("DiscordAdapter: `bus` is required");
    if (!opts.token) throw new Error("DiscordAdapter: `token` is required");
    if (!opts.routing) throw new Error("DiscordAdapter: `routing` is required");

    this.bus = opts.bus;
    this.token = opts.token;
    this.allowedUserIds = new Set(opts.allowedUserIds);
    this.routing = opts.routing;
    this.logger = opts.logger ?? console;
    this.rateLimitCheck = opts.rateLimitCheck ?? makeDefaultRateLimit();

    // Production callers pass `bus + token + routing`; the adapter
    // constructs its own real gateway + REST client. Tests inject
    // `FakeDiscordGateway` / `FakeDiscordRestApi` to bypass the network.
    this.gateway = opts.gateway ?? createDiscordGateway({ token: this.token, logger: this.logger });
    this.restApi = opts.restApi ?? createDiscordRestApi({ token: this.token, logger: this.logger });
  }

  /* ──────────────────────────── lifecycle ─────────────────────────── */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. Subscribe to bus events BEFORE wiring the gateway so any racey
    //    early bus event (e.g. a `request_human` from a session that
    //    came up just before the adapter) doesn't fall on the floor.
    for (const agentId of uniqueAgentIds(this.routing)) {
      const sub = this.bus.subscribe(
        {
          agent_id: agentId,
          topics: ["response.text", "channel.permission_request", "system.request_human"],
        },
        (event) => this.handleBusEvent(agentId, event),
      );
      this.subscriptions.push(sub);
    }

    // 2. Wire gateway → adapter ingestion.
    this.gatewayOff = this.gateway.onEvent((e) => this.handleGatewayEvent(e));
    await this.gateway.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // 1. Unsubscribe from gateway first — a late `MESSAGE_CREATE` must
    //    not trigger a `sendPrompt` after `stop()` returned.
    if (this.gatewayOff) {
      try {
        this.gatewayOff();
      } catch (err) {
        this.logger.error("[discord-adapter] gateway off error", err);
      }
      this.gatewayOff = null;
    }
    try {
      await this.gateway.stop();
    } catch (err) {
      this.logger.error("[discord-adapter] gateway stop error", err);
    }

    // 2. Close every bus subscription. Order matters: doing this AFTER
    //    the gateway is silent guarantees we drain cleanly. The success
    //    signal is `bus.state().subscriberCount === 0`, asserted by the
    //    test suite.
    for (const sub of this.subscriptions) {
      try {
        sub.close();
      } catch (err) {
        this.logger.error("[discord-adapter] subscription.close error", err);
      }
    }
    this.subscriptions = [];
    this.pendingPermissions.clear();
    this.pendingHumanAsks.clear();
  }

  /* ──────────────────────────── inbound (gateway) ─────────────────── */

  private handleGatewayEvent(e: GatewayEvent): void {
    if (e.type === "MESSAGE_CREATE") {
      void this.handleMessageCreate(e.message);
      return;
    }
    if (e.type === "INTERACTION_CREATE") {
      void this.handleInteraction(e.interaction);
      return;
    }
  }

  /**
   * Mirrors `handleMessageCreate` in `src/commands/discord.ts:824`,
   * collapsed to the subset the Bus runtime needs.
   */
  private async handleMessageCreate(message: DiscordInboundMessage): Promise<void> {
    // 1. Drop bot messages — discord.ts:832.
    if (message.author.bot) return;

    const userId = message.author.id;
    const channelId = message.channel_id;
    const isDM = !message.guild_id;

    // 2. Allow-list — discord.ts:882 semantics:
    //    * empty list = "allow all" (legacy `allowedUserIds.length > 0`
    //      gate — preserved for default-config parity; operators with
    //      `discord.allowedUserIds: []` should NOT see their bot stop
    //      responding after the Bus runtime flip).
    //    * non-empty list, member match = allow.
    //    * non-empty list, no match = DM "Unauthorized." reply,
    //      guild = silent skip.
    //    Sprint 3 review (PR #113 agent #3): the earlier "empty = deny
    //    all" behaviour was a silent regression. Restored here.
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      if (isDM) {
        try {
          await this.restApi.sendMessage(channelId, "Unauthorized.");
        } catch (err) {
          this.logger.error("[discord-adapter] sendMessage(unauth) failed", err);
        }
      }
      return;
    }

    // 3. Rate-limit — discord.ts:876.
    if (!this.rateLimitCheck(userId)) {
      this.logger.warn(`[discord-adapter] rate-limited userId=${userId}`);
      return;
    }

    // 4. Resolve agent_id. Unknown channel → silent skip (parity with
    //    `guildTriggerReason() === null`, discord.ts:864).
    const agentId = resolveAgentId(this.routing, { isDM, channelId });
    if (!agentId) {
      this.logger.warn(`[discord-adapter] unrouted channel=${channelId} — skip`);
      return;
    }

    // 5. Detect attachments and pin metadata to the BusEvent so future
    //    surfaces can render them. Sprint 3 does NOT download or
    //    transcribe — that's `discord.ts:980+` legacy behaviour and
    //    belongs in a Sprint 4 attachment-pipeline component. Forward
    //    URLs + flags only.
    const { images, voices, texts, hasAny } = summariseAttachments(message.attachments);

    // 6. Drop empty messages with no attachments.
    if (!message.content.trim() && !hasAny) return;

    // 7. Special-case: pending `request_human` for this (agent, channel).
    //    If one exists, route this message text as the answer rather
    //    than a brand-new prompt. The legacy listener doesn't have
    //    this hook; per spec §5.5.1 it's the adapter's job to bridge.
    const askKey = `${agentId}:${channelId}`;
    const pendingAsk = this.pendingHumanAsks.get(askKey);
    if (pendingAsk) {
      this.pendingHumanAsks.delete(askKey);
      try {
        this.bus.ingestAskAnswer({
          agent_id: pendingAsk.agent_id,
          ask_id: pendingAsk.ask_id,
          answer: message.content,
        });
      } catch (err) {
        this.logger.error("[discord-adapter] ingestAskAnswer failed", err);
      }
      return;
    }

    // 8. Forward to bus.
    try {
      await this.bus.sendPrompt({
        agent_id: agentId,
        origin: "discord",
        origin_id: channelId,
        user_id: userId,
        text: message.content,
        metadata: {
          message_id: message.id,
          username: message.author.username,
          ...(hasAny
            ? {
                attachments: {
                  images: images.map(attachmentMeta),
                  voices: voices.map(attachmentMeta),
                  texts: texts.map(attachmentMeta),
                },
              }
            : {}),
        },
      });
    } catch (err) {
      this.logger.error("[discord-adapter] sendPrompt failed", err);
      return;
    }
    // Visible "Bot is typing..." indicator so users get immediate
    // feedback that the prompt was received. Fire-and-forget — Discord
    // auto-clears after ~10 seconds; if the agent reply takes longer
    // the indicator just lapses and reappears on the next typing call.
    // Failures are logged but don't block prompt processing.
    void this.restApi.sendTyping(channelId).catch((err) => {
      this.logger.warn("[discord-adapter] sendTyping failed", err);
    });
  }

  /**
   * Mirrors `handleInteractionCreate` in `src/commands/discord.ts:1351`,
   * but only the MESSAGE_COMPONENT button branch. Slash commands are
   * Sprint 4 surface work.
   */
  private async handleInteraction(interaction: DiscordInboundInteraction): Promise<void> {
    // Only button clicks (type 3). Slash commands are out of scope.
    if (interaction.type !== 3 || !interaction.data?.custom_id) return;
    const parsed = parsePermissionCustomId(interaction.data.custom_id);
    if (!parsed) return;

    // Allow-list — discord.ts:1358. Same semantics as the message path:
    // empty = "allow all", non-empty = membership check. PR #113 review
    // restored legacy parity.
    const actorId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!actorId || (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(actorId))) {
      try {
        await this.restApi.respondToInteraction(interaction.id, interaction.token, {
          content: "Unauthorized.",
          flags: 64, // EPHEMERAL
        });
      } catch (err) {
        this.logger.error("[discord-adapter] respondToInteraction(unauth) failed", err);
      }
      return;
    }

    const { behavior, request_id } = parsed;
    const pending = this.pendingPermissions.get(request_id);
    if (!pending) {
      // Stale button — likely a restart. Ack so the UI doesn't show
      // "interaction failed", then bail.
      try {
        await this.restApi.respondToInteraction(interaction.id, interaction.token, {
          content: "This permission prompt is no longer active.",
          flags: 64,
        });
      } catch (err) {
        this.logger.error("[discord-adapter] respondToInteraction(stale) failed", err);
      }
      return;
    }
    this.pendingPermissions.delete(request_id);

    try {
      this.bus.ingestPermissionDecision({
        agent_id: pending.agent_id,
        request_id,
        behavior,
      });
    } catch (err) {
      this.logger.error("[discord-adapter] ingestPermissionDecision failed", err);
    }

    try {
      await this.restApi.respondToInteraction(interaction.id, interaction.token, {
        content: behavior === "allow" ? "Allowed." : "Denied.",
        flags: 64,
      });
    } catch (err) {
      this.logger.error("[discord-adapter] respondToInteraction(ack) failed", err);
    }
  }

  /* ──────────────────────────── outbound (bus → discord) ──────────── */

  private handleBusEvent(agentId: string, event: BusEvent): void {
    // Determine the destination channel set based on the event's origin
    // surface (populated by BusCore from the originating prompt).
    //
    // Three classes of origin:
    //   1. "discord"                    → route ONLY to origin_id channel
    //   2. Another channel-driven origin ("telegram" / "slack" / "webui")
    //                                   → DROP — owned by that adapter.
    //                                     The post-#137 prod incident was
    //                                     this case silently fanning out,
    //                                     mirroring webui chat into every
    //                                     Discord channel routed to the
    //                                     agent.
    //   3. No origin OR a non-channel origin ("cron" / "heartbeat" /
    //      "cli" / "rest")              → fan-out via channelsForAgent.
    //                                     Codex P1 on #138: scheduler
    //                                     emits prompts with explicit
    //                                     origin: "cron" | "heartbeat",
    //                                     so a blunt "drop if origin is
    //                                     present" filter would silently
    //                                     stop scheduler replies reaching
    //                                     any channel. Only drop foreign
    //                                     CHANNEL-DRIVEN origins.
    const payloadWithOrigin = event.payload as { origin?: string; origin_id?: string } | undefined;
    const origin = payloadWithOrigin?.origin;
    if (
      origin !== undefined &&
      origin !== "discord" &&
      CHANNEL_DRIVEN_ORIGINS.has(origin as BusOrigin)
    )
      return;
    const originChannel =
      origin === "discord" && typeof payloadWithOrigin?.origin_id === "string"
        ? payloadWithOrigin.origin_id
        : null;
    // For non-channel-driven origins (cron / heartbeat / cli / rest / no
    // origin) prefer the operator-configured primary channel for the agent
    // when one is set. Without this, a heartbeat fans out to every routed
    // channel — observed in production as "heartbeat delivered to every
    // channel routed to suzy", including `daily-digest-suzy`. Opt-in: agents
    // without an entry keep the legacy fan-out behaviour.
    const primaryChannel = !originChannel
      ? this.routing.primaryChannelByAgent?.[agentId]
      : undefined;
    const targetChannels = originChannel
      ? [originChannel]
      : primaryChannel
        ? [primaryChannel]
        : this.channelsForAgent(agentId);
    if (targetChannels.length === 0) return;

    if (event.topic === "response.text") {
      const payload = event.payload as { text?: string };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text) return;
      for (const channelId of targetChannels) {
        void this.safeSendMessage(channelId, text);
      }
      return;
    }

    if (event.topic === "channel.permission_request") {
      const req = event.payload as PermissionRequest;
      this.pendingPermissions.set(req.request_id, { agent_id: agentId });
      const prompt = formatPermissionPrompt(req);
      const components = buildPermissionButtons(req.request_id);
      for (const channelId of targetChannels) {
        void this.safeSendMessage(channelId, prompt, components);
      }
      return;
    }

    if (event.topic === "system.request_human") {
      const payload = event.payload as { ask_id?: string; question?: string };
      const askId = typeof payload.ask_id === "string" ? payload.ask_id : null;
      const question = typeof payload.question === "string" ? payload.question : "";
      if (!askId || !question) {
        this.logger.warn("[discord-adapter] request_human missing ask_id or question");
        return;
      }
      const prompt = `**Needs a human:** ${question}\n_(Reply in this channel to answer.)_`;
      for (const channelId of targetChannels) {
        this.pendingHumanAsks.set(`${agentId}:${channelId}`, { ask_id: askId, agent_id: agentId });
        void this.safeSendMessage(channelId, prompt);
      }
      return;
    }
  }

  private async safeSendMessage(
    channelId: string,
    text: string,
    components?: unknown[],
  ): Promise<void> {
    try {
      await this.restApi.sendMessage(channelId, text, components);
    } catch (err) {
      this.logger.error("[discord-adapter] sendMessage failed", err);
    }
  }

  /**
   * Channels (and thread ids) owned by `agentId`. DM channel resolution
   * is deferred to Sprint 4 (see TODO below).
   */
  private channelsForAgent(agentId: string): string[] {
    const out: string[] = [];
    for (const [chId, aid] of Object.entries(this.routing.channels)) {
      if (aid === agentId) out.push(chId);
    }
    if (this.routing.threads) {
      for (const [thId, aid] of Object.entries(this.routing.threads)) {
        if (aid === agentId) out.push(thId);
      }
    }
    return out;
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Re-exports                                                             */
/* ────────────────────────────────────────────────────────────────────── */

export type {
  DiscordAdapterOptions,
  DiscordGatewayLike,
  DiscordRestApiLike,
  DiscordInboundMessage,
  DiscordInboundInteraction,
  GatewayEvent,
} from "./types";
export { resolveAgentId, uniqueAgentIds } from "./router";

/* ────────────────────────────────────────────────────────────────────── */
/* Sprint 4 TODOs                                                         */
/* ────────────────────────────────────────────────────────────────────── */
/*
 * Origin-id routing landed in #133: `handleBusEvent` reads
 * `event.payload.origin_id` and replies on the originating Discord
 * channel only. `channelsForAgent` remains the fallback for events
 * with no origin (cron / scheduler ticks), so multi-channel agents
 * still receive scheduled output everywhere.
 *
 *  - DM channel resolution: legacy `sendMessageToUser` requires a
 *    `/users/@me/channels` POST to create the DM channel. Surface DM
 *    response routing via `dmAgentId` once that helper is extracted.
 *  - Attachment download + voice transcription parity (`discord.ts:980+`).
 *    Bus runtime needs these surfaced as `attachment.*` BusEvents.
 *  - Slash command relay (`/reset`, `/compact`, `/status`, `/context`)
 *    via `bus.invokeSlashCommand` — Session Manager hook.
 *  - Forward-message coalescing (`pendingForwards`, `discord.ts:817`).
 *  - Stream "typing" placeholder + edit-in-place rendering
 *    (`makeDiscordStreamCallback`, `discord.ts:707`).
 */
