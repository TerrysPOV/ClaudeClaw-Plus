/**
 * Slack Bus adapter (Sprint 4 Agent A).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3 — Slack is
 * NOT on Anthropic's Channels allowlist, so the Bus MCP is permanent
 * plumbing for Slack regardless of Channels GA.
 *
 * Behaviour parity with the legacy PTY-coupled listener at
 * `src/commands/slack.ts` (1950 LOC) for the subset the Bus runtime needs.
 *
 * PR #113 review carryovers (don't repeat):
 *   1. Allow-list: empty = allow all (legacy `slack.ts:976`).
 *   2. Composite keying for pendingPermissions / pendingHumanAsks.
 *
 * Sprint 4.5+ TODOs at end of file.
 */

import type { BusCore, Subscription } from "../../bus/core";
import {
  CHANNEL_DRIVEN_ORIGINS,
  type BusEvent,
  type BusOrigin,
  type PermissionRequest,
  isTailerOriginEvent,
} from "../../bus/types";
import { createSlackApi } from "./api";
import { buildPermissionBlocks } from "./blocks";
import { verifySlackSignature } from "./signature";
import {
  PERMISSION_ACTION_ID_REGEX,
  type SlackAdapterOptions,
  type SlackApi,
  type SlackBlock,
  type SlackBlockActionsPayload,
  type SlackBlockKitMessageBlock,
  type SlackEventsApiEnvelope,
  type SlackInboundAttachment,
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

/**
 * Reject bus events owned by a DIFFERENT channel-driven adapter.
 *
 * Post-#137 prod incident: webui-originated replies (`origin: "webui"`)
 * fanned out across every Slack channel routed to the agent because
 * the slack adapter had no origin filter at all.
 *
 * Codex P1 on #138: scheduler emits prompts with explicit
 * `origin: "cron" | "heartbeat"`. A blunt "drop if origin is set" rule
 * would silently stop scheduler replies reaching any channel. Only
 * FOREIGN CHANNEL-DRIVEN origins (discord / telegram / webui) drop;
 * non-channel origins (cron / heartbeat / cli / rest) fall through to
 * the normal fan-out path.
 */
function eventBelongsToSlack(event: BusEvent): boolean {
  const origin = (event.payload as { origin?: string } | undefined)?.origin;
  if (origin === undefined || origin === "slack") return true;
  return !CHANNEL_DRIVEN_ORIGINS.has(origin as BusOrigin);
}

/**
 * Cap on the `seenEventIds` LRU. Slack retries every ~1s up to 3 times,
 * so a 5k entry cap covers >1h of traffic at 1 event/sec — far beyond
 * the retry window — while bounding memory to ~5k strings (~200kB).
 * PR #117 review (Agent #2).
 */
const DEFAULT_MAX_SEEN_EVENT_IDS = 5_000;

/**
 * Cap on the `threadOwners` map. Each entry is `${channel}:${thread_ts}`
 * → agent_id (~80 bytes). 10k cap → ~800kB worst case. PR #117 review
 * (Agent #2) flagged unbounded growth for long-running daemons.
 */
const DEFAULT_MAX_THREAD_OWNERS = 10_000;

export class SlackAdapter {
  private readonly bus: BusCore;
  private readonly token: string;
  private readonly signingSecret: string;
  private readonly api: SlackApi;
  private readonly socket: SlackSocketLike | null;
  private readonly allowedUserIds: ReadonlySet<string>;
  /** Issue #121 port of upstream PR #210: per-channel bot pass-through. */
  private readonly allowBots: ReadonlySet<string>;
  private readonly allowBotIds: ReadonlySet<string>;
  /**
   * Self-id guard — drop events authored by this adapter's own Slack
   * app to prevent a feedback loop when `allowBots` is enabled
   * (Issue #121 Codex P1).
   */
  private readonly selfBotId: string | null;
  private readonly selfUserId: string | null;
  private readonly channels: Record<string, string>;
  private readonly threadAgentId: string | undefined;
  /**
   * Optional `agent_id → channel_id` for narrowing non-channel-driven origin
   * fan-out (cron / heartbeat / cli / rest / no origin) to a single channel
   * per agent. Opt-in: agents without an entry fan out to every routed
   * channel as before.
   */
  private readonly primaryChannelByAgent: Record<string, string> | undefined;
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

  /**
   * Thread ownership cache keyed `${channel_id}:${thread_ts}`. Bounded
   * LRU — see `recordThreadOwner` / `lookupThreadOwner`. Entries past
   * `maxThreadOwners` are evicted oldest-first.
   */
  private readonly threadOwners = new Map<string, string>();
  private readonly maxThreadOwners: number;

  /**
   * LRU of Events API `event_id`s already processed. Slack retries on
   * 3xx/5xx ack failure with the same `event_id`; without this guard a
   * slow `chat.postMessage` could cause the adapter to fire the same
   * permission flow / sendPrompt twice. PR #117 review (Agent #2).
   */
  private readonly seenEventIds = new Map<string, true>();
  private readonly maxSeenEventIds: number;

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
    this.allowBots = new Set(opts.allowBots ?? []);
    this.allowBotIds = new Set(opts.allowBotIds ?? []);
    this.selfBotId = opts.selfBotId ?? null;
    this.selfUserId = opts.selfUserId ?? null;
    // Codex P1 on PR #129: warn loudly when allowBots is on but no
    // self-id is configured. Without it, our own chat.postMessage
    // replies feed back as bot_message events and would re-ingest as
    // fresh prompts. We can't safely refuse to start (operator may
    // not be using bot pass-through), but the warning makes the
    // failure mode obvious before it bites in production.
    if (this.allowBots.size > 0 && !this.selfBotId && !this.selfUserId) {
      (opts.logger ?? console).warn(
        "[slack-adapter] allowBots is configured but neither selfBotId nor selfUserId is set — our own chat.postMessage replies will be re-ingested as fresh prompts, creating a feedback loop. Set slack.selfBotId (from auth.test).",
      );
    }
    this.channels = { ...opts.routing.channels };
    this.threadAgentId = opts.routing.threadAgentId;
    this.primaryChannelByAgent = opts.routing.primaryChannelByAgent
      ? { ...opts.routing.primaryChannelByAgent }
      : undefined;
    this.logger = opts.logger ?? console;
    this.maxSeenEventIds = opts.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS;
    this.maxThreadOwners = opts.maxThreadOwners ?? DEFAULT_MAX_THREAD_OWNERS;
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
    this.seenEventIds.clear();
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
      // Slack retry-dedup: if this event_id is already in our LRU we still
      // return 200 (the operative ack), but we DO NOT re-fire the message
      // handler. PR #117 review (Agent #2).
      if (envelope.event_id && this.markEventIdSeen(envelope.event_id)) {
        return "";
      }
      await this.handleMessageEvent(envelope.event);
    }
    return "";
  }

  /**
   * Record an Events API `event_id` in the bounded LRU. Returns `true`
   * when the id was already present (i.e. this is a Slack retry that
   * should be deduped); `false` when the id is new.
   *
   * Eviction is oldest-first because `Map` iterates in insertion order.
   * "Touch on read" isn't useful here — retries arrive within seconds of
   * the original, well inside the LRU window.
   */
  private markEventIdSeen(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return true;
    this.seenEventIds.set(eventId, true);
    if (this.seenEventIds.size > this.maxSeenEventIds) {
      const oldest = this.seenEventIds.keys().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
    return false;
  }

  /**
   * Record `(channel, thread) → agent_id` with LRU eviction. Touches on
   * write so an active thread stays warm in the cache. PR #117 review
   * (Agent #2) caught unbounded growth.
   */
  private recordThreadOwner(key: string, agentId: string): void {
    if (this.threadOwners.has(key)) this.threadOwners.delete(key);
    this.threadOwners.set(key, agentId);
    if (this.threadOwners.size > this.maxThreadOwners) {
      const oldest = this.threadOwners.keys().next().value;
      if (oldest !== undefined) this.threadOwners.delete(oldest);
    }
  }

  /**
   * Look up a thread owner and touch it (delete + reinsert) so active
   * threads survive eviction. Returns `undefined` for unknown keys.
   */
  private lookupThreadOwner(key: string): string | undefined {
    const owner = this.threadOwners.get(key);
    if (owner !== undefined) {
      this.threadOwners.delete(key);
      this.threadOwners.set(key, owner);
    }
    return owner;
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
    // Issue #121 port of upstream PRs #210, #211, #214.
    //
    // PR #210: per-channel bot pass-through. Replace the blanket
    // `event.bot_id → drop` gate with allowBots-aware logic.
    // PR #211: when `event.text` is empty, fall through to blocks /
    // attachments before discarding.
    // PR #214: non-thread bot messages route via
    // `replyThreadTs = event.thread_ts ?? event.ts` so subsequent
    // replies in the synthetic thread find the agent owner.

    // Self-bot guard FIRST (Codex P1 on PR #129). Drop any event
    // authored by this adapter's own Slack app to prevent a feedback
    // loop where our `chat.postMessage` replies get re-ingested as
    // fresh prompts. Must run BEFORE the allowBots logic — otherwise
    // an unprotected allowBots channel would loop forever.
    if (this.selfBotId && event.bot_id === this.selfBotId) return;
    if (this.selfUserId && event.user === this.selfUserId) return;

    const channelId = event.channel;
    const channelAllowsBots = !!event.bot_id && this.allowBots.has(channelId);
    const botIdAllowed =
      this.allowBotIds.size === 0 || (!!event.bot_id && this.allowBotIds.has(event.bot_id));
    const isBotAllowed = channelAllowsBots && botIdAllowed;

    // Bot gate. Drop bot traffic unless the channel + bot id both
    // match the allow-list. Empty-`user` events with no `bot_id`
    // remain dropped (system events, join/leave, etc).
    if (event.bot_id) {
      if (!isBotAllowed) return;
    } else if (!event.user) {
      return;
    }

    // Subtype gate. `file_share` always allowed; `bot_message` allowed
    // only when this event is an allowed bot.
    if (
      event.subtype &&
      event.subtype !== "file_share" &&
      !(isBotAllowed && event.subtype === "bot_message")
    ) {
      return;
    }

    // userId fallback chain: human user → bot display name → bot id.
    // Used for the `sendPrompt.user_id` tag.
    const userId = event.user ?? event.bot_profile?.name ?? event.username ?? event.bot_id ?? "";

    // Allow-list — empty = allow all (legacy `slack.ts:976` semantics).
    // Bot-allowed traffic bypasses this gate per upstream PR #210 — bots
    // don't have a human userId to check.
    if (!isBotAllowed && this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      return;
    }

    const agentId = this.resolveAgentId(event);
    if (!agentId) {
      this.logger.warn(`[slack-adapter] unrouted channel=${channelId} — skip`);
      return;
    }

    // PR #214 fold-in: for bot messages NOT in a thread, the bot's reply
    // will create a thread under event.ts. Record owner under
    // replyThreadTs so subsequent replies in that synthetic thread route
    // to the same agent.
    const replyThreadTs = event.thread_ts ?? event.ts;
    if (event.thread_ts) {
      this.recordThreadOwner(`${channelId}:${event.thread_ts}`, agentId);
    } else if (isBotAllowed) {
      this.recordThreadOwner(`${channelId}:${replyThreadTs}`, agentId);
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

    // PR #211 fold-in: when `text` is empty, recover content from
    // blocks → attachments before discarding. Bot alerts (Gatus,
    // Grafana, etc) often post via blocks with empty `text`.
    let textBody = event.text ?? "";
    if (textBody.length === 0 && event.blocks && event.blocks.length > 0) {
      textBody = extractTextFromBlocks(event.blocks);
    }
    if (textBody.length === 0 && event.attachments && event.attachments.length > 0) {
      textBody = extractTextFromAttachments(event.attachments);
    }
    // Sanitize bot-sourced text — the prompt-injection surface is real
    // when arbitrary monitoring tools post into our channels. Matches
    // upstream PR #210's `sanitizeUserInput` treatment.
    if (isBotAllowed) textBody = sanitiseBotText(textBody);

    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    const trimmed = textBody.trim();
    if (!trimmed && !hasFiles) return;

    // Sprint 4 forwards file metadata only — download/transcription is a
    // Sprint 4+ attachment-pipeline task.
    const metadata: Record<string, unknown> = {
      ts: event.ts,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...(isBotAllowed ? { bot_id: event.bot_id ?? "", bot_name: userId } : {}),
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
    if (!eventBelongsToSlack(event)) return;
    // Skip the JSONL tailer's per-block observability echo (#217): the
    // real delivery comes from the agent's `reply` tool (ingestReply),
    // which carries no tailer source marker. Delivering both double-posts.
    if (isTailerOriginEvent(event)) return;
    const payload = event.payload as { text?: string; origin?: string; origin_id?: string };
    const text = typeof payload?.text === "string" ? payload.text : "";
    if (text.length === 0) return;

    // If the event names its origin channel, route there only. Otherwise
    // fan-out (cron / heartbeat / scheduler with no inbound prompt).
    const originChannel =
      payload.origin === "slack" && typeof payload.origin_id === "string"
        ? payload.origin_id
        : null;
    const channels = this.resolveTargetChannels(agentId, originChannel);
    if (channels.length === 0) {
      this.logger.warn(`[slack-adapter] no channels for agent ${agentId}; dropping response.text`);
      return;
    }
    for (const channelId of channels) {
      await this.safePostMessage({ channel: channelId, text });
    }
  }

  private async handlePermissionRequest(agentId: string, event: BusEvent): Promise<void> {
    if (!eventBelongsToSlack(event)) return;
    const req = event.payload as
      | (PermissionRequest & { origin?: string; origin_id?: string })
      | undefined;
    if (!req || typeof req.request_id !== "string") return;

    const originChannel =
      req.origin === "slack" && typeof req.origin_id === "string" ? req.origin_id : null;
    const channels = this.resolveTargetChannels(agentId, originChannel);
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
    if (!eventBelongsToSlack(event)) return;
    const payload = event.payload as {
      ask_id?: string;
      question?: string;
      origin?: string;
      origin_id?: string;
    };
    if (typeof payload?.ask_id !== "string" || typeof payload?.question !== "string") {
      return;
    }
    const originChannel =
      payload.origin === "slack" && typeof payload.origin_id === "string"
        ? payload.origin_id
        : null;
    const channels = this.resolveTargetChannels(agentId, originChannel);
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
    // Include agents listed only in `primaryChannelByAgent`. Codex P2 on
    // PR #151: parser accepts that shape; subscription set must too,
    // otherwise outbound events never reach the adapter.
    if (this.primaryChannelByAgent) {
      for (const a of Object.keys(this.primaryChannelByAgent)) set.add(a);
    }
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
   * Resolve the target channel set for an outbound event.
   *
   *   1. originChannel set      → that channel only (slack-originated reply)
   *   2. primaryChannelByAgent  → that channel only (non-channel-driven origin,
   *                                operator opted in for this agent)
   *   3. fallback               → every channel routed to the agent (legacy
   *                                fan-out, back-compat)
   *
   * The primary-channel path narrows cron/heartbeat/cli/rest broadcasts so
   * they don't spam every channel routed to the agent. Opt-in.
   */
  private resolveTargetChannels(agentId: string, originChannel: string | null): string[] {
    if (originChannel) return [originChannel];
    const primary = this.primaryChannelByAgent?.[agentId];
    if (primary) return [primary];
    return this.channelsForAgent(agentId);
  }

  /**
   * Resolve agent_id: recorded thread owner → direct channel mapping →
   * threadAgentId (for thread replies in unrouted channels) → null.
   */
  private resolveAgentId(event: SlackMessageEvent): string | null {
    if (event.thread_ts) {
      const threadKey = `${event.channel}:${event.thread_ts}`;
      const owner = this.lookupThreadOwner(threadKey);
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

/* ────────────────────────────────────────────────────────────────────── */
/* Issue #121 — upstream Slack feature helpers                             */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Walk a Block Kit message-block tree and return the human-readable
 * text concatenated with newlines. Recovers content from bot alerts
 * that post via `event.blocks` with an empty `event.text` (Gatus,
 * Grafana, etc). Issue #121 port of upstream PR #211.
 *
 * Exported for unit testing.
 */
export function extractTextFromBlocks(blocks: readonly SlackBlockKitMessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.text?.text) parts.push(block.text.text);
    if (block.fields) {
      for (const f of block.fields) {
        if (f.text) parts.push(f.text);
      }
    }
    if (block.elements) {
      for (const el of block.elements) {
        if (el.text?.text) parts.push(el.text.text);
      }
    }
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

/**
 * Legacy attachments-shape text recovery. Joined chain:
 * `pretext` → `title` → `text` → each field as `title:\nvalue`.
 * Issue #121 port of upstream PR #211.
 *
 * Exported for unit testing.
 */
export function extractTextFromAttachments(attachments: readonly SlackInboundAttachment[]): string {
  return attachments
    .map((a) =>
      [a.pretext, a.title, a.text, ...(a.fields?.map((f) => `${f.title}:\n${f.value}`) ?? [])]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .join("\n"),
    )
    .filter((p) => p.length > 0)
    .join("\n");
}

/**
 * Strip directive-like markers that could be used by a third-party bot
 * (or a compromised one) to inject control sequences the Bus adapter
 * understands. Currently scrubs:
 *   - `[react:<emoji>]` — Telegram-style reaction directive
 *   - `[[slack_buttons:...]]` / `[[slack_select:...]]` — legacy Slack
 *     interactivity hints
 *
 * Matches upstream `sanitizeUserInput` in `src/commands/slack.ts`.
 * Exported for unit testing.
 */
export function sanitiseBotText(text: string): string {
  return text
    .replace(/\[react:[^\]]*\]/gi, "")
    .replace(/\[\[slack_buttons:[^\]]*\]\]/gi, "[buttons removed]")
    .replace(/\[\[slack_select:[^\]]*\]\]/gi, "[select removed]")
    .trim();
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

/* Sprint 4.5+ TODOs (deferred — tracked in PR follow-ups):
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
