/**
 * Slack adapter — config + wire-shape types.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 *   "Same shape [as Discord]. Slack-side specifics (events API, socket mode,
 *    Block Kit for richer rendering). Slack is not on Anthropic's Channels
 *    allowlist, so the Bus MCP is the only viable plumbing for Slack
 *    regardless of Channels GA."
 *
 * Sprint coordination: `src/bus/SPRINT_4_PLAN.md` (Agent A scope).
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
 *     `perm:<allow|deny>:<request_id>` per SPRINT_4_PLAN.md — Discord
 *     still uses `ccaw_perm_<…>_<…>` underscores; convergence is a
 *     separate Sprint 4 task.
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
  /** Routing config. Slack has no DMs-as-channels distinction the same way
   * Discord does — DMs are just channels of type `im`. We map by channel
   * id flat. Thread routing inherits the parent channel's agent_id unless
   * `threadAgentId` is set (an explicit override that pins thread-only
   * traffic to a dedicated agent). */
  routing: {
    channels: Record<string, string>;
    threadAgentId?: string;
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
  /** `message_changed`, `file_share`, etc. */
  subtype?: string;
  /** File attachments (images, voice, docs). */
  files?: SlackFile[];
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
 * Spec choice (SPRINT_4_PLAN.md §"Component-by-component scope"): Slack
 * uses the colon-separated form that Telegram already uses. Discord's
 * underscore form (`ccaw_perm_…`) will converge in a follow-up — keeping
 * both adapters drift-free is a separate task.
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
