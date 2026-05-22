/**
 * Slack adapter — config + wire-shape types.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 *   "Same shape [as Discord]. Slack-side specifics (events API, socket mode,
 *    Block Kit for richer rendering). Slack is not on Anthropic's Channels
 *    allowlist, so the Bus MCP is the only viable plumbing for Slack
 *    regardless of Channels GA."
 *
 * These shapes mirror the subset of Slack's Web API / Events API / Socket
 * Mode envelopes that the legacy PTY listener (`src/commands/slack.ts`,
 * 1950 LOC) consumes. We re-declare them here (rather than importing) so
 * the Bus adapter is decoupled from the legacy file — Sprint 5 will retire
 * that path for `runtime: bus`.
 *
 * Sprint 3 review parallels (PR #113):
 *   - Adapter takes `gateway` / `api` seams the same way Discord/Telegram
 *     do, so tests can inject `FakeSlackApi` without hitting `slack.com`.
 *   - Block Kit button `action_id` uses the cleaner colon-separated form
 *     `perm:<allow|deny>:<request_id>` (spec §5.5.3) — Discord still uses
 *     `ccaw_perm_<…>_<…>` underscores; convergence is a separate Sprint 4
 *     task.
 */

import type { BusCore } from "../../bus/core";

/* ────────────────────────────────────────────────────────────────────── */
/* Public adapter options                                                  */
/* ────────────────────────────────────────────────────────────────────── */

export interface SlackAdapterOptions {
  bus: BusCore;
  /** Bot User OAuth token (`xoxb-…`). */
  token: string;
  /**
   * Signing secret for Events API HTTP request verification. Required for
   * the HTTP transport even if `appToken` is set, because tests/operators
   * may switch modes without restarting.
   */
  signingSecret: string;
  /**
   * Slack user IDs (`U…`) allowed to talk to the bot. Empty list = allow
   * all (legacy parity per `src/commands/slack.ts:976` — the existing
   * `allowedUserIds.length > 0` gate). PR #113 review on Discord/Telegram
   * caught the same regression; we preserve the documented semantics here.
   */
  allowedUserIds: string[];
  /**
   * Channel ids where messages from OTHER bots (event.bot_id set) are
   * passed through to claude instead of being silently dropped. Issue
   * #121 port of upstream PR #210. Empty list (default) preserves the
   * original Sprint 4 behaviour — all bot-authored events are dropped.
   */
  allowBots?: string[];
  /**
   * Optional bot-id allow-list (`B…` ids). When non-empty, both the
   * channel AND the bot id must match before pass-through. Empty list
   * (default) accepts any bot in an allowBots channel.
   */
  allowBotIds?: string[];
  /**
   * The bot id (`B…`) of THIS adapter's own Slack app. Issue #121
   * Codex P1 fold-in: when `allowBots` is non-empty, our own
   * `chat.postMessage` replies come back as `bot_message` events
   * and — without this guard — would be re-ingested as fresh
   * prompts, creating a feedback loop. Set this to the value Slack's
   * `auth.test` returns for `bot_id`. The adapter skips any inbound
   * event where `event.bot_id === selfBotId` BEFORE any pass-through
   * check.
   */
  selfBotId?: string;
  /**
   * The bot user id (`U…`) of THIS adapter's own Slack app. Same
   * loop-prevention purpose as `selfBotId` — covers events where
   * Slack only sets `user` (not `bot_id`) for app-authored messages.
   */
  selfUserId?: string;
  /** Routing config. Slack has no DMs-as-channels distinction the same way
   * Discord does — DMs are just channels of type `im`. We map by channel
   * id flat. Thread routing inherits the parent channel's agent_id unless
   * `threadAgentId` is set (an explicit override that pins thread-only
   * traffic to a dedicated agent). */
  routing: {
    channels: Record<string, string>;
    threadAgentId?: string;
    /**
     * `agent_id → channel_id`. When set for an agent, non-channel-driven
     * origins (cron / heartbeat / cli / rest / no origin) deliver ONLY to
     * this channel rather than fanning out to every routed channel.
     */
    primaryChannelByAgent?: Record<string, string>;
  };
  /**
   * App-level token (`xapp-…`) for Socket Mode. When present, the adapter
   * opens a WebSocket via `apps.connections.open`; when absent it falls
   * back to the Events API HTTP path (caller must wire an HTTP listener
   * and pipe envelopes through `handleEventsApiRequest` — see Sprint 4
   * TODO at the bottom of `index.ts`).
   */
  appToken?: string;
  /** Optional logger; defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
  /**
   * Optional injected Slack Web API client. Tests pass a `FakeSlackApi`;
   * production callers can omit this and the adapter will build its own
   * fetch-backed client from `token`. Same seam as Telegram (`./api.ts`).
   */
  api?: SlackApi;
  /**
   * Optional Socket Mode driver. When absent and `appToken` is set, the
   * adapter constructs a real WebSocket driver via `createSocketModeDriver`.
   * Tests inject a `FakeSlackSocket`.
   *
   * Sprint 4 ships the production WebSocket driver as a deferred follow-up
   * (see TODO at the bottom of `index.ts`). For now operators wanting
   * Socket Mode must inject one; the Events API HTTP entry-point
   * (`handleEventsApiRequest`) is the fully-supported path.
   */
  socket?: SlackSocketLike;
  /**
   * LRU cap on the Events API `event_id` dedup cache. Defaults to 5000.
   * Tests set this to 2-3 to exercise eviction. PR #117 review (Agent #2).
   */
  maxSeenEventIds?: number;
  /**
   * LRU cap on the `threadOwners` cache (one entry per active thread).
   * Defaults to 10000. Tests set this to 2-3 to exercise eviction.
   * PR #117 review (Agent #2).
   */
  maxThreadOwners?: number;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Wire shapes — subset of the real Slack payloads                         */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * `message` Event payload — mirrors what Slack delivers inside
 * `event_callback.event`. Only the fields the adapter needs are declared.
 * Reference: `src/commands/slack.ts:925` (handleMessage event shape).
 */
export interface SlackMessageEvent {
  type: "message" | "app_mention";
  channel: string;
  /** Sender user id (`U…`). Absent for some bot-message subtypes. */
  user?: string;
  /** Message ts (Slack's per-channel monotonic id, `1234.5678`). */
  ts: string;
  /** Parent thread ts if this message is a thread reply. */
  thread_ts?: string;
  text: string;
  /** Slack sets this for bot-authored messages. */
  bot_id?: string;
  /**
   * Bot-friendly display name when present (Issue #121 port of upstream
   * PR #210 review-feedback commit). Falls through username → bot_id
   * for the prompt's `user_id` tag when no human `user` is set.
   */
  username?: string;
  /** Slack's nested bot profile; we read `bot_profile.name` for display. */
  bot_profile?: { name?: string };
  /** `message_changed`, `file_share`, `bot_message`, etc. */
  subtype?: string;
  /** File attachments (images, voice, docs). */
  files?: SlackFile[];
  /**
   * Block Kit blocks — Slack's modern rich-content format. Issue #121
   * port of upstream PR #211: when `text` is empty, we walk these to
   * recover the human-readable content from monitoring tools (Gatus,
   * Grafana, etc.) that post via blocks instead of `text`.
   */
  blocks?: SlackBlockKitMessageBlock[];
  /**
   * Legacy attachments — older bots (PagerDuty, some Datadog flows)
   * post structured payloads here. Same fallback path as `blocks`.
   */
  attachments?: SlackInboundAttachment[];
}

/**
 * Subset of Slack's Block Kit shape that holds human-readable text.
 * Distinct from `SlackBlock` (outbound — for the permission Block Kit
 * builders) because inbound block payloads use slightly different
 * field names + recursive `elements`.
 */
export interface SlackBlockKitMessageBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type?: string; text: string }>;
  elements?: Array<{ type: string; text?: { type: string; text: string } }>;
}

/** Legacy `attachments[]` shape — the chain a bot might fill. */
export interface SlackInboundAttachment {
  text?: string;
  fallback?: string;
  pretext?: string;
  title?: string;
  fields?: Array<{ title: string; value: string }>;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  /** Slack file type slug (`png`, `mp3`, etc). */
  filetype?: string;
  /** Authenticated URL — needs Bearer token to fetch. */
  url_private?: string;
  size?: number;
}

/**
 * `block_actions` interactivity payload (a button click). Mirrors the
 * shape used by `handleBlockAction` in `src/commands/slack.ts:1438`.
 */
export interface SlackBlockActionsPayload {
  type: "block_actions";
  user: { id: string; username?: string };
  /** Present when the action originated from a channel message. */
  channel?: { id: string };
  /** The message the buttons were attached to. */
  message?: { ts: string; thread_ts?: string };
  actions: SlackBlockAction[];
  /** Trigger id for opening modals — not used by the Bus adapter. */
  trigger_id?: string;
  /** Response URL for delayed responses (3 sec to ack window). */
  response_url?: string;
}

export interface SlackBlockAction {
  action_id: string;
  type: string;
  value?: string;
}

/** Inbound Events API HTTP body envelope. */
export interface SlackEventsApiEnvelope {
  type: "url_verification" | "event_callback";
  /** Challenge token (only present for `url_verification`). */
  challenge?: string;
  /** The wrapped event when `type === "event_callback"`. */
  event?: SlackMessageEvent;
  /** Slack team id (for multi-workspace installs). */
  team_id?: string;
  /**
   * Per-delivery event id Slack assigns to every `event_callback`. Repeats
   * verbatim on retries (3xx/5xx ack failures), so the adapter dedups on
   * this. PR #117 review (Agent #2): the adapter previously had no retry
   * guard, so a slow `chat.postMessage` could trigger a permission flow
   * twice.
   */
  event_id?: string;
}

/** Socket Mode envelope shape — top-level WebSocket frames the bus cares about. */
export interface SlackSocketEnvelope {
  /** `hello`, `events_api`, `interactive`, `disconnect`, etc. */
  type: string;
  envelope_id?: string;
  accepts_response_payload?: boolean;
  payload?: {
    event?: SlackMessageEvent;
  } & Partial<SlackBlockActionsPayload>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Block Kit output shapes (outbound)                                      */
/* ────────────────────────────────────────────────────────────────────── */

export interface SlackSectionBlock {
  type: "section";
  text: { type: "mrkdwn" | "plain_text"; text: string };
}

export interface SlackActionsBlock {
  type: "actions";
  elements: SlackBlockElement[];
}

export interface SlackBlockElement {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
}

export type SlackBlock = SlackSectionBlock | SlackActionsBlock;

/* ────────────────────────────────────────────────────────────────────── */
/* Web API surface (interface seam for tests)                              */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Minimal Slack Web API surface used by the adapter. Real implementation
 * is `createSlackApi()` in `./api.ts`. Tests substitute a `FakeSlackApi`
 * to avoid hitting `slack.com/api/*`.
 *
 * Shape mirrors the calls in `src/commands/slack.ts` — only what the
 * Bus adapter actually invokes is declared.
 */
export interface SlackApi {
  /** `chat.postMessage` — used for `response.text` and permission prompts. */
  postMessage(params: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: SlackBlock[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Socket Mode driver abstraction                                          */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Socket Mode transport seam — tests inject a `FakeSlackSocket`; production
 * implementation lives in (future) `./socket.ts`. The adapter consumes
 * decoded envelopes and emits acks back; transport details (WebSocket
 * reconnect, proactive 30-min refresh per legacy line 1814) are the
 * driver's concern.
 */
export interface SlackSocketLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Subscribe to inbound envelopes. Returns an unsubscribe fn. */
  onEnvelope(handler: (env: SlackSocketEnvelope) => void): () => void;
  /** Ack an envelope back to Slack. No-op when `envelope_id` is missing. */
  ack(envelopeId: string, payload?: unknown): void;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Permission button encoding                                              */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * `action_id` shape used for permission-prompt buttons. Format:
 *   `perm:<allow|deny>:<request_id>`
 *
 * Spec choice (§5.5.3): Slack uses the colon-separated form that
 * Telegram already uses. Discord's underscore form (`ccaw_perm_…`) will
 * converge in a follow-up — keeping both adapters drift-free is a
 * separate task.
 *
 * Block Kit `action_id` limit is 255 characters; `perm:<5>:abcde` is 16,
 * leaving plenty of headroom for future correlation ids.
 */
export const PERMISSION_ACTION_ID_PREFIX = "perm:";
/**
 * `perm:<allow|deny>:<agent_id>:<request_id>` — `agent_id` embedded so
 * the callback can look up the exact `${agent_id}:${channel_id}:
 * ${request_id}` pendingPermissions key directly. PR #117 review (Codex
 * P1): scanning by channel + suffix risks collision because request_id
 * is a 5-char `[a-km-z]` string.
 */
export const PERMISSION_ACTION_ID_REGEX = /^perm:(allow|deny):([^:]+):(.+)$/;
