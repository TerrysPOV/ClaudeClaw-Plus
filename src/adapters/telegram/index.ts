/**
 * Telegram Bot adapter (Sprint 3 Agent B). Spec §5.5.2; coordination
 * `src/bus/SPRINT_3_PLAN.md`. Mirrors `src/commands/telegram.ts` (legacy
 * PTY listener) but speaks only to `BusCore`. The legacy file stays;
 * Sprint 5 flips `runtime: bus` and retires it. Out of scope: file-bytes
 * upload pipeline (file_ids only); Markdown polish (plain text only).
 */

import type { BusCore, Subscription } from "../../bus/core";
import { openInboundReceipt } from "../../bus/receipt-wiring";
import { getDefaultReceiptStore, type OpenReceipt, type ReceiptStore } from "../../bus/receipt";
import {
  CHANNEL_DRIVEN_ORIGINS,
  type BusEvent,
  type BusOrigin,
  type PermissionRequest,
  isTailerOriginEvent,
} from "../../bus/types";
import { createTelegramApi } from "./api";
import { extractReactionDirectives } from "./directives";
import { buildPromptMetadata } from "./metadata";
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramInlineKeyboardButton,
  TelegramMessage,
  TelegramUpdate,
} from "./types";

export interface TelegramAdapterOptions {
  bus: BusCore;
  /** Bot token (`123:abc…`). Used for the default HTTP API client. */
  token: string;
  /**
   * Numeric user IDs allowed to talk to the bot. Empty list rejects all —
   * explicit allow-listing is a precondition under the Bus runtime.
   */
  allowedUserIds: number[];
  /** chat-id → agent_id routing. `defaultAgentId` covers fall-through. */
  routing: {
    chats: Record<string, string>;
    defaultAgentId?: string;
  };
  /** Poll interval ms between successive `getUpdates` calls. Default 1000. */
  pollIntervalMs?: number;
  /** Milliseconds before an unanswered turn's receipt (#211) auto-closes as
   *  `timeout`. Defaults to 5 min (RECEIPT_TIMEOUT_MS). Lowered in tests. */
  receiptTimeoutMs?: number;
  /** Receipt store (#211). Defaults to the process-wide singleton; tests
   *  inject an isolated store so they never touch the real receipts.jsonl. */
  receiptStore?: ReceiptStore;
  /** Override the API client (tests inject a fake). */
  api?: TelegramApi;
  /** Optional structured logger; defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/**
 * Per-agent target context. `[react:<emoji>]` UX needs the originating
 * message id, so we hold the last inbound per agent. One slot per agent
 * is enough for Sprint 3's single-user-bot pattern.
 */
interface PendingPrompt {
  chat_id: number;
  /** Telegram message id of the inbound user message — reaction target. */
  source_message_id: number;
  /** Optional forum-topic thread id, propagated to outbound sends. */
  message_thread_id?: number;
}

/** In-flight `system.request_human` correlation; next chat reply answers it. */
interface PendingHumanAsk {
  ask_id: string;
  agent_id: string;
}

/**
 * Reject bus events owned by a DIFFERENT channel-driven adapter.
 *
 * Post-#137 prod incident: webui-originated replies (`origin: "webui"`)
 * were leaking into Telegram (and Discord, Slack) because the adapters
 * only checked their own origin tag and otherwise fell back to fan-out.
 *
 * Codex P1 on #138: scheduler emits prompts with explicit
 * `origin: "cron" | "heartbeat"`, so a blunt "drop if origin is set"
 * rule would silently stop scheduler replies reaching any channel.
 * Only FOREIGN CHANNEL-DRIVEN origins (discord / slack / webui) drop;
 * non-channel origins (cron / heartbeat / cli / rest) fall through to
 * the normal fan-out path.
 */
function eventBelongsToTelegram(event: BusEvent): boolean {
  const origin = (event.payload as { origin?: string } | undefined)?.origin;
  if (origin === undefined || origin === "telegram") return true;
  return !CHANNEL_DRIVEN_ORIGINS.has(origin as BusOrigin);
}

export class TelegramAdapter {
  private readonly bus: BusCore;
  private readonly api: TelegramApi;
  private readonly allowedUserIds: ReadonlySet<number>;
  private readonly routingChats: Record<string, string>;
  private readonly defaultAgentId: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly receiptStore: ReceiptStore;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;

  /** getUpdates offset cursor — bumped past the highest processed update_id. */
  private nextOffset = 0;
  /** Generation counter — bumped by `stop()` to abort the long-poll loop. */
  private generation = 0;
  private running = false;
  /** AbortController for the in-flight `getUpdates` call. */
  private inflightAbort: AbortController | null = null;

  /** Live subscriptions keyed by agent_id. Cleaned up by `stop()`. */
  private readonly subscriptions = new Map<string, Subscription[]>();

  /** Last inbound per agent — target for outbound + reaction message id. */
  private readonly lastChatPerAgent = new Map<string, PendingPrompt>();
  /**
   * Last-known forum-topic id per chat. Codex review on #139: when chat A
   * (forum topic 5) and chat B share the same agent and prompts interleave,
   * `lastChatPerAgent` only holds one chat at a time, so the origin_id route
   * for the OTHER chat would drop its `message_thread_id` and reply to the
   * supergroup's general topic instead of the originating thread. Populated
   * on every inbound; read by {@link targetForOriginOrAgent} when the cache
   * doesn't match the origin_id chat. Holds `undefined` for non-forum chats
   * so the difference between "never seen" and "non-threaded" is observable.
   */
  private readonly lastTopicPerChat = new Map<number, number | undefined>();
  /** Last outbound bot message per agent — target for edit_message + spinner. */
  private readonly lastBotMessage = new Map<
    string,
    { chat_id: number; message_id: number; message_thread_id?: number }
  >();
  /** Active spinner animation per agent. */
  private readonly spinnerState = new Map<
    string,
    {
      baseText: string;
      frame: number;
      chat_id: number;
      message_id: number;
      timer: ReturnType<typeof setInterval>;
    }
  >();
  /** Agents with a live turn message (placeholder/progress) the next reply edits in place. */
  private readonly turnActive = new Set<string>();

  /** Open per-message receipts (#211) keyed by convKey. Closed on the
   *  first final reply (`turn_observed`) or by timeout (`timeout`), so an
   *  unanswered Telegram turn becomes legible in receipts.jsonl instead of
   *  the opaque silence that motivated #207. */
  private readonly openReceipts = new Map<
    string,
    { receipt: OpenReceipt; timer: ReturnType<typeof setTimeout> }
  >();

  /** Mirror of webui-bridge's DEFAULT_PROMPT_TIMEOUT_MS — a turn that never
   *  produces a final reply closes its receipt as `timeout` after this. */
  private static readonly RECEIPT_TIMEOUT_MS = 5 * 60 * 1000;
  /** request_id → context; callback_query routes back to `ingestPermissionDecision`. */
  private readonly pendingPermissions = new Map<string, { agent_id: string; chat_id: number }>();
  /** chat_id → pending ask. The next plain-text reply resolves it. */
  /**
   * Pending `request_human` keyed by `${agentId}:${chatId}` so multi-agent
   * configs sharing a chat don't collide. PR #113 review (agent #2):
   * earlier chat-id-only keying matched Telegram's documented single-user
   * pattern, but breaks the moment `routing.chats` maps multiple chats to
   * different agents AND the operator shares one chat across them. Discord
   * adapter already uses the composite key — symmetry restored.
   */
  private readonly pendingHumanAsks = new Map<string, PendingHumanAsk>();

  /** Loop promise so `stop()` can await graceful exit. */
  private loopPromise: Promise<void> | null = null;

  constructor(opts: TelegramAdapterOptions) {
    if (!opts.bus) throw new Error("TelegramAdapter: `bus` is required");
    if (!opts.token) throw new Error("TelegramAdapter: `token` is required");
    if (!opts.routing) throw new Error("TelegramAdapter: `routing` is required");

    this.bus = opts.bus;
    this.api = opts.api ?? createTelegramApi(opts.token);
    this.allowedUserIds = new Set(opts.allowedUserIds);
    this.routingChats = { ...opts.routing.chats };
    this.defaultAgentId = opts.routing.defaultAgentId;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? TelegramAdapter.RECEIPT_TIMEOUT_MS;
    this.receiptStore = opts.receiptStore ?? getDefaultReceiptStore();
    this.logger = opts.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.generation += 1;

    // Subscribe for every routed agent + the default, so fallback-only
    // agents still receive `response.text`.
    const agentIds = new Set<string>(Object.values(this.routingChats));
    if (this.defaultAgentId) agentIds.add(this.defaultAgentId);
    for (const agentId of agentIds) {
      this.subscribeForAgent(agentId);
    }

    const gen = this.generation;
    this.loopPromise = this.pollLoop(gen).catch((err) => {
      this.logger.error("[telegram-adapter] poll loop crashed", err);
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.generation += 1; // signal the loop to exit on next iteration

    // Abort the long-poll so stop() returns promptly (legacy waits 30s).
    if (this.inflightAbort) {
      try {
        this.inflightAbort.abort();
      } catch {
        // already aborted — fine.
      }
    }

    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        try {
          sub.close();
        } catch (err) {
          this.logger.error("[telegram-adapter] subscription.close failed", err);
        }
      }
    }
    this.subscriptions.clear();

    // Clear correlation maps so stop→start cycles don't reuse stale
    // request_id / ask_id / per-agent target state. PR #113 review
    // (agent #2): Discord adapter clears these; Telegram was missing
    // the symmetric cleanup.
    this.pendingPermissions.clear();
    this.pendingHumanAsks.clear();
    this.lastChatPerAgent.clear();
    this.lastBotMessage.clear();
    for (const id of Array.from(this.spinnerState.keys())) this.stopSpinner(id);
    this.turnActive.clear();
    // Receipt (#211): close any still-open receipts so their watchdog
    // timers do not leak across a stop->start cycle; the log records the
    // turn was cut short by adapter shutdown, not a silent hang.
    for (const key of Array.from(this.openReceipts.keys())) {
      this.closeTelegramReceipt(key, "timeout", { reason: "adapter_stopped" });
    }

    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch (err) {
        this.logger.error("[telegram-adapter] loop await failed", err);
      }
      this.loopPromise = null;
    }
  }

  /**
   * Long-poll loop — `getUpdates` → dispatch → repeat. Mirrors
   * `src/commands/telegram.ts:2172-2218`. Generation token (instead of
   * the legacy `running` boolean) cleanly aborts after rapid stop/start.
   */
  private async pollLoop(gen: number): Promise<void> {
    while (this.running && this.generation === gen) {
      const ac = new AbortController();
      this.inflightAbort = ac;
      try {
        const data = await this.api.getUpdates(this.nextOffset, 30, ac.signal);
        if (this.generation !== gen) break;
        if (!data.ok) {
          await this.sleep(this.pollIntervalMs);
          continue;
        }
        for (const update of data.result) {
          this.nextOffset = update.update_id + 1;
          try {
            await this.dispatchUpdate(update);
          } catch (err) {
            this.logger.error("[telegram-adapter] dispatch failed", err);
          }
        }
      } catch (err) {
        if (this.generation !== gen || !this.running) break;
        if ((err as { name?: string })?.name === "AbortError") break;
        this.logger.error("[telegram-adapter] getUpdates failed", err);
        await this.sleep(this.pollIntervalMs);
      } finally {
        this.inflightAbort = null;
      }
    }
  }

  /** Fan out by update kind. Edited messages reuse the message path (parity). */
  private async dispatchUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (message) {
      await this.handleMessage(message, update.update_id);
    }
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleMessage(message: TelegramMessage, updateId: number): Promise<void> {
    const chatId = message.chat.id;
    const userId = message.from?.id;

    // Drop bot-to-bot echoes (legacy gating + spec allow-list semantics).
    if (message.from?.is_bot) return;

    // Allow-list — telegram.ts:1131 semantics: empty list = "allow all"
    // (preserved for default-config parity per PR #113 review); non-empty
    // list with no match = named rejection in private chats / silent skip
    // in group chats. The earlier "empty = deny all" behaviour was a
    // silent regression for operators running default configs.
    const isPrivate = message.chat.type === "private";
    if (
      userId === undefined ||
      (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId))
    ) {
      if (isPrivate) {
        await this.safeSendMessage({
          chat_id: chatId,
          text: "Unauthorized.",
          message_thread_id: message.message_thread_id,
        });
      }
      return;
    }

    // TODO(sprint-4): port the legacy 30 msg/min per-user rate limit
    // (`src/commands/telegram.ts:264-275`). The Bus runtime hasn't settled
    // where rate limiting lives (per-adapter vs central Bus middleware),
    // so this adapter is currently unrate-limited. PR #113 review agent
    // #3 flagged the missing TODO marker — adding here so a future
    // operator grepping finds it.
    // TODO(sprint-4): port `[buttons:...]` directive + `buttonLabelMap`
    // TTL eviction from legacy (`telegram.ts` commits d845e02, a6c45aa).
    // Currently agent-emitted inline buttons UX is gone in Bus runtime.

    const agentId = this.resolveAgent(chatId);
    if (!agentId) return;

    // Telegram puts captioned-photo text in `caption` — accept either.
    const text = (message.text ?? message.caption ?? "").trim();
    const metadata = buildPromptMetadata(message);

    // Pending `request_human` for this (agent, chat)? Route the text-bearing
    // reply as ask_answer. Per PR #113 agent #5 finding: this path GATES
    // on `text.length > 0` — photo-only / document-only replies do NOT
    // resolve the pending ask. That's intentional (an ask needs prose) but
    // documented here so it's not a surprise.
    const pendingAskKey = `${agentId}:${chatId}`;
    const pendingAsk = this.pendingHumanAsks.get(pendingAskKey);
    if (pendingAsk && text.length > 0) {
      this.pendingHumanAsks.delete(pendingAskKey);
      this.bus.ingestAskAnswer({
        agent_id: pendingAsk.agent_id,
        ask_id: pendingAsk.ask_id,
        answer: text,
      });
      return;
    }

    // Empty payload with no attachments — nothing to do.
    const attachments = metadata.attachments as unknown[] | undefined;
    if (text.length === 0 && (!attachments || attachments.length === 0)) {
      return;
    }

    // Receipt (#211): open at the adapter boundary BEFORE delegating to the
    // bus. hashPrompt runs on the raw `text` (pre-<channel> wrapper) so the
    // bus -> PTY seam's findByPromptHash still hits the same receipt.
    this.openTelegramReceipt(agentId, chatId, updateId, text);

    await this.bus.sendPrompt({
      agent_id: agentId,
      origin: "telegram",
      origin_id: String(chatId),
      user_id: String(userId),
      text,
      metadata,
    });

    const pending: PendingPrompt = {
      chat_id: chatId,
      source_message_id: message.message_id,
      message_thread_id: message.message_thread_id,
    };
    this.lastChatPerAgent.set(agentId, pending);
    this.lastTopicPerChat.set(chatId, message.message_thread_id);

    // Typing indicator + auto-spinner: the instant a message arrives, post a
    // braille placeholder and animate it so the user sees activity before
    // claude emits its first reply. The first reply edits this message in place
    // (see handleResponseText). Guarantees visible feedback regardless of
    // whether claude takes the DIRECT or PROGRESSIVE pattern.
    const key = this.convKey(agentId, chatId);
    void this.api.sendChatAction({ chat_id: chatId, action: "typing" }).catch(() => {});
    this.stopSpinner(key);
    const FRAMES = TelegramAdapter.SPINNER_FRAMES;
    try {
      const res = await this.api.sendMessage({
        chat_id: chatId,
        text: `${FRAMES[0]} ...`,
        message_thread_id: message.message_thread_id,
      });
      const id = res?.ok && res.result ? res.result.message_id : null;
      if (id != null) {
        this.lastBotMessage.set(key, {
          chat_id: chatId,
          message_id: id,
          message_thread_id: message.message_thread_id,
        });
        this.turnActive.add(key);
        this.startSpinner(key, "...", chatId, id);
      }
    } catch (err) {
      this.logger.error(`[telegram-adapter] placeholder sendMessage failed`, err);
    }
  }

  /** Subscribe to the §5.5.2 topics for `agentId` (response, edit, perm, ask). */
  private subscribeForAgent(agentId: string): void {
    if (this.subscriptions.has(agentId)) return;
    const subs: Subscription[] = [];
    subs.push(
      this.bus.subscribe(
        { agent_id: agentId, topics: ["response.text"] },
        (event) => void this.handleResponseText(agentId, event),
      ),
      this.bus.subscribe(
        { agent_id: agentId, topics: ["response.edit_text"] },
        (event) => void this.handleResponseEditText(agentId, event),
      ),
      this.bus.subscribe(
        { agent_id: agentId, topics: ["channel.permission_request"] },
        (event) => void this.handlePermissionRequest(agentId, event),
      ),
      this.bus.subscribe(
        { agent_id: agentId, topics: ["system.request_human"] },
        (event) => void this.handleRequestHuman(agentId, event),
      ),
    );
    this.subscriptions.set(agentId, subs);
  }

  private async handleResponseText(agentId: string, event: BusEvent): Promise<void> {
    if (!eventBelongsToTelegram(event)) return;
    // Skip the JSONL tailer's per-block observability echo (#217): the
    // real delivery comes from the agent's `reply` tool (ingestReply),
    // which carries no tailer source marker. Delivering both double-posts.
    if (isTailerOriginEvent(event)) return;
    const payload = event.payload as { text?: string };
    const rawText = typeof payload?.text === "string" ? payload.text : "";
    if (rawText.length === 0) return;

    const target = this.targetForOriginOrAgent(agentId, event);
    if (!target) {
      this.logger.warn(
        `[telegram-adapter] no target chat for agent ${agentId}; dropping response.text`,
      );
      return;
    }

    const { cleanedText, emojis } = extractReactionDirectives(rawText);

    const intent = (event.payload as { intent?: string })?.intent;
    const isProgress = intent === "progress";
    const FRAMES = TelegramAdapter.SPINNER_FRAMES;
    const key = this.convKey(agentId, target.chat_id);
    // Every new reply replaces the active animated message — stop any prior spinner.
    this.stopSpinner(key);
    // Receipt (#211): a non-progress response.text is the turn-final
    // delivery — close as `turn_observed`. Closed even when cleanedText is
    // empty (a reaction-only final), since the turn WAS observed; the empty
    // rawText case already returned above. Idempotent (second final no-op);
    // progress replies leave it open; unprompted replies (cron/heartbeat)
    // with no open receipt no-op.
    if (intent !== "progress") {
      this.closeTelegramReceipt(key, "turn_observed");
    }
    if (cleanedText.length === 0) {
      // nothing textual; fall through to reactions.
    } else if (this.turnActive.has(key)) {
      // Live turn message exists (placeholder or earlier progress) — edit in place.
      const live = this.lastBotMessage.get(key);
      if (live) {
        const editText = isProgress ? `${FRAMES[0]} ${cleanedText}` : cleanedText;
        try {
          await this.api.editMessageText({
            chat_id: live.chat_id,
            message_id: live.message_id,
            text: editText,
          });
        } catch (err) {
          this.logger.error(`[telegram-adapter] turn edit failed`, err);
        }
        if (isProgress) {
          this.startSpinner(key, cleanedText, live.chat_id, live.message_id);
        } else {
          // Final — turn done. Evict so a later unprompted reply (cron /
          // heartbeat) doesn't edit this now-stale message id.
          this.turnActive.delete(key);
          this.lastBotMessage.delete(key);
        }
      }
    } else {
      // No live turn (unprompted reply / second final) — send fresh.
      const sendText = isProgress ? `${FRAMES[0]} ${cleanedText}` : cleanedText;
      try {
        const res = await this.api.sendMessage({
          chat_id: target.chat_id,
          text: sendText,
          message_thread_id: target.message_thread_id,
        });
        const id = res?.ok && res.result ? res.result.message_id : null;
        // Only retain the message for follow-up edits while a turn is live
        // (progress). A fresh final reply needs no future edit, so leaving no
        // entry avoids the stale-message_id edit bug.
        if (id != null && isProgress) {
          this.lastBotMessage.set(key, {
            chat_id: target.chat_id,
            message_id: id,
            message_thread_id: target.message_thread_id,
          });
          this.turnActive.add(key);
          this.startSpinner(key, cleanedText, target.chat_id, id);
        }
      } catch (err) {
        this.logger.error(`[telegram-adapter] sendMessage failed`, err);
      }
    }

    // Reactions target the inbound user message (CLAUDE.md UX). No source
    // message → nothing to react to.
    if (emojis.length > 0 && target.source_message_id) {
      for (const emoji of emojis) {
        await this.safeSetReaction({
          chat_id: target.chat_id,
          message_id: target.source_message_id,
          emoji,
        });
      }
    }
  }

  private async handleResponseEditText(agentId: string, event: BusEvent): Promise<void> {
    const payload = event.payload as { text?: string };
    const newText = typeof payload?.text === "string" ? payload.text : "";
    if (newText.length === 0) return;

    // edit_message carries no chat id — it targets the agent's current
    // conversation, i.e. the last chat it was talking to.
    const target = this.targetForAgent(agentId);
    if (!target) {
      this.logger.warn(`[telegram-adapter] edit_message with no target for ${agentId}`);
      return;
    }
    const key = this.convKey(agentId, target.chat_id);
    const FRAMES = TelegramAdapter.SPINNER_FRAMES;
    const last = this.lastBotMessage.get(key);
    if (!last) {
      // No prior outbound for this conversation — fall back to a new message.
      try {
        const res = await this.api.sendMessage({
          chat_id: target.chat_id,
          text: newText,
          message_thread_id: target.message_thread_id,
        });
        const id = res?.ok && res.result ? res.result.message_id : null;
        if (id != null) {
          this.lastBotMessage.set(key, {
            chat_id: target.chat_id,
            message_id: id,
            message_thread_id: target.message_thread_id,
          });
        }
      } catch (err) {
        this.logger.error(`[telegram-adapter] edit_message fallback send failed`, err);
      }
      return;
    }
    // Edit the live message; keep animating if a spinner was running.
    const wasSpinning = this.spinnerState.has(key);
    this.stopSpinner(key);
    const sendText = wasSpinning ? `${FRAMES[0]} ${newText}` : newText;
    try {
      await this.api.editMessageText({
        chat_id: last.chat_id,
        message_id: last.message_id,
        text: sendText,
      });
      if (wasSpinning) {
        this.startSpinner(key, newText, last.chat_id, last.message_id);
      }
    } catch (err) {
      this.logger.error(`[telegram-adapter] editMessageText failed`, err);
    }
  }

  /** Braille spinner frames — classic CLI animation. */
  private static readonly SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private static readonly SPINNER_INTERVAL_MS = 2500;
  /**
   * Max animation ticks per turn. Bounds total `editMessageText` calls so a
   * long claude turn can't fire an unbounded edit stream. At 1.1s/edit with no
   * cap, a multi-minute turn issued ~100+ edits and triggered an escalated
   * Telegram flood-ban (`retry_after` ~1730s) that blocked ALL replies. With
   * a 2.5s interval and a 12-tick cap the spinner animates for ~30s then goes
   * static; real text still arrives via `response.text` / `edit_message`.
   */
  private static readonly SPINNER_MAX_TICKS = 12;

  private stopSpinner(key: string): void {
    const s = this.spinnerState.get(key);
    if (s) {
      clearInterval(s.timer);
      this.spinnerState.delete(key);
    }
  }

  private startSpinner(key: string, baseText: string, chat_id: number, message_id: number): void {
    this.stopSpinner(key);
    const FRAMES = TelegramAdapter.SPINNER_FRAMES;
    let ticks = 0;
    this.spinnerState.set(key, {
      baseText,
      frame: 0,
      chat_id,
      message_id,
      timer: setInterval(() => {
        const cur = this.spinnerState.get(key);
        if (!cur) return;
        // Cap total animation so a long turn can't fire an unbounded edit
        // stream (Telegram flood-ban risk). After the cap the message stays
        // static; real text still arrives via response.text / edit_message.
        ticks += 1;
        if (ticks > TelegramAdapter.SPINNER_MAX_TICKS) {
          this.stopSpinner(key);
          return;
        }
        cur.frame = (cur.frame + 1) % FRAMES.length;
        void this.api
          .editMessageText({
            chat_id: cur.chat_id,
            message_id: cur.message_id,
            text: `${FRAMES[cur.frame]} ${cur.baseText}`,
          })
          .catch(() => {
            // Stop the spinner on ANY API error, 429 included. A periodic edit
            // loop on a rate-limited chat self-sustains the 429 and starves the
            // real reply; the per-chat flood cooldown in `createTelegramApi`
            // then short-circuits further sends until it clears.
            this.stopSpinner(key);
          });
      }, TelegramAdapter.SPINNER_INTERVAL_MS),
    });
  }

  /**
   * Conversation key for the per-turn outbound maps. Telegram routing can map
   * multiple chats to one agent (issue #139), so keying `lastBotMessage` /
   * `spinnerState` / `turnActive` by `agentId` alone lets chat B's reply edit
   * chat A's placeholder. Compose with `chat_id` so each conversation tracks
   * its own outbound message.
   */
  /** Open an inbound receipt for a Telegram turn and arm its timeout. */
  private openTelegramReceipt(
    agentId: string,
    chatId: number,
    updateId: number,
    rawText: string,
  ): void {
    const key = this.convKey(agentId, chatId);
    // A new prompt arrived before the previous turn replied — close the
    // stale receipt as `timeout` (note `superseded`) so it doesn't leak,
    // distinct from a genuine no-reply timeout.
    this.closeTelegramReceipt(key, "timeout", { superseded: true });
    const receipt = openInboundReceipt({
      store: this.receiptStore,
      messageId: `tg-${updateId}`,
      agentId,
      rawText,
      origin: "telegram",
      originId: String(chatId),
    });
    const timer = setTimeout(() => {
      this.closeTelegramReceipt(key, "timeout", {
        reason: "no_final_reply_within_timeout",
      });
    }, this.receiptTimeoutMs);
    // Never keep the event loop alive solely for this watchdog timer.
    if (typeof timer.unref === "function") timer.unref();
    this.openReceipts.set(key, { receipt, timer });
  }

  /** Close (idempotently) the open receipt for a conversation, if any. */
  private closeTelegramReceipt(
    key: string,
    state: "turn_observed" | "timeout",
    notes?: Record<string, unknown>,
  ): void {
    const entry = this.openReceipts.get(key);
    if (!entry) return;
    this.openReceipts.delete(key);
    clearTimeout(entry.timer);
    void entry.receipt.close(state, notes);
  }

  private convKey(agentId: string, chatId: number): string {
    return `${agentId}:${chatId}`;
  }

  private async handlePermissionRequest(agentId: string, event: BusEvent): Promise<void> {
    if (!eventBelongsToTelegram(event)) return;
    const req = event.payload as PermissionRequest | undefined;
    if (!req || typeof req.request_id !== "string") return;

    const target = this.targetForOriginOrAgent(agentId, event);
    if (!target) {
      this.logger.warn(
        `[telegram-adapter] no target chat for permission_request on agent ${agentId}`,
      );
      return;
    }

    this.pendingPermissions.set(req.request_id, { agent_id: agentId, chat_id: target.chat_id });

    const text = [
      `🔒 *Permission request*`,
      `Tool: ${req.tool_name}`,
      req.description ? req.description : "",
      req.input_preview ? `\n\`\`\`\n${req.input_preview}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // callback_data shape `perm:<allow|deny>:<request_id>` — legacy "type:id" pattern.
    const keyboard: TelegramInlineKeyboardButton[][] = [
      [
        { text: "✅ Allow", callback_data: `perm:allow:${req.request_id}` },
        { text: "❌ Deny", callback_data: `perm:deny:${req.request_id}` },
      ],
    ];

    await this.safeSendMessage({
      chat_id: target.chat_id,
      text,
      message_thread_id: target.message_thread_id,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  private async handleRequestHuman(agentId: string, event: BusEvent): Promise<void> {
    if (!eventBelongsToTelegram(event)) return;
    const payload = event.payload as { ask_id?: string; question?: string };
    if (typeof payload?.ask_id !== "string" || typeof payload?.question !== "string") {
      return;
    }
    const target = this.targetForOriginOrAgent(agentId, event);
    if (!target) {
      this.logger.warn(`[telegram-adapter] no target chat for request_human on agent ${agentId}`);
      return;
    }

    // One pending ask per chat; newer supersedes older (spec §5.4 flow).
    // Composite key: agent + chat. PR #113 review (agent #2).
    this.pendingHumanAsks.set(`${agentId}:${target.chat_id}`, {
      ask_id: payload.ask_id,
      agent_id: agentId,
    });

    await this.safeSendMessage({
      chat_id: target.chat_id,
      text: `🤔 ${payload.question}`,
      message_thread_id: target.message_thread_id,
    });
  }

  /**
   * Handle `perm:<allow|deny>:<id>` (the only pattern this adapter emits).
   * Legacy file's `btn:`, `pending:`, `sec_yes_` patterns are out of scope.
   */
  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data ?? "";
    const userId = query.from?.id;
    // Allow-list — empty = "allow all" (legacy parity, PR #113 review).
    if (
      userId === undefined ||
      (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId))
    ) {
      await this.safeAnswerCallback({
        callback_query_id: query.id,
        text: "Unauthorized.",
      });
      return;
    }

    const match = data.match(/^perm:(allow|deny):(.+)$/);
    if (!match) {
      // Unknown callback shape — ack so the spinner clears, then drop.
      await this.safeAnswerCallback({ callback_query_id: query.id });
      return;
    }

    const behavior = match[1] as "allow" | "deny";
    const requestId = match[2];
    if (!requestId) {
      await this.safeAnswerCallback({ callback_query_id: query.id });
      return;
    }
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      // Likely expired (daemon restart). Tell the user instead of silently
      // dropping — they'd otherwise wait forever for the underlying tool.
      await this.safeAnswerCallback({
        callback_query_id: query.id,
        text: "This permission request has expired.",
      });
      return;
    }
    this.pendingPermissions.delete(requestId);
    this.bus.ingestPermissionDecision({
      agent_id: pending.agent_id,
      request_id: requestId,
      behavior,
    });
    await this.safeAnswerCallback({
      callback_query_id: query.id,
      text: behavior === "allow" ? "✅ Allowed" : "❌ Denied",
    });
  }

  private resolveAgent(chatId: number): string | undefined {
    const explicit = this.routingChats[String(chatId)];
    if (explicit) return explicit;
    return this.defaultAgentId;
  }

  /**
   * Pick an outbound chat for the agent honoring the event's
   * `origin_id` when `origin === "telegram"` (issue #139). We always
   * zero out `source_message_id` because the cache tracks the *most
   * recent* inbound, not the one this reply corresponds to — letting it
   * leak would react on a newer (unrelated) message when two prompts
   * arrive from the same chat before the first response lands.
   *
   * For `message_thread_id`: prefer the cached `lastChatPerAgent[agent]`
   * value when its chat_id matches the origin_id (most accurate — same
   * agent, same chat, last inbound). Otherwise fall back to
   * `lastTopicPerChat[origin_id]` so forum threading still works when
   * two chats sharing the same agent interleave prompts (Codex P2 on
   * the original #139 commit). A perfect fix would carry the originating
   * thread id through the bus payload as `origin_thread_id`; that's
   * upstream work in BusCore + every adapter, and this two-level cache
   * covers the common-case routing without it.
   *
   * Falls back to {@link targetForAgent} for events without an origin
   * (cron / heartbeat / cli / rest) or when the origin isn't telegram.
   *
   * Mirrors Discord (`src/adapters/discord/index.ts` ~L411) and Slack
   * (`src/adapters/slack/index.ts` ~L615) — see issue #139 for context.
   */
  private targetForOriginOrAgent(agentId: string, event: BusEvent): PendingPrompt | null {
    const payloadWithOrigin = event.payload as { origin?: string; origin_id?: string } | undefined;
    const origin = payloadWithOrigin?.origin;
    const originId = payloadWithOrigin?.origin_id;
    if (origin === "telegram" && typeof originId === "string" && originId.length > 0) {
      const chatId = Number(originId);
      // Telegram chat ids are always integers (and can be negative for
      // groups/channels). `Number.isInteger` rejects NaN, floats, and
      // Infinity in one check — tighter than `isFinite`.
      if (Number.isInteger(chatId)) {
        const cached = this.lastChatPerAgent.get(agentId);
        const threadId =
          cached && cached.chat_id === chatId
            ? cached.message_thread_id
            : this.lastTopicPerChat.get(chatId);
        return {
          chat_id: chatId,
          source_message_id: 0,
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        };
      }
    }
    return this.targetForAgent(agentId);
  }

  /**
   * Pick an outbound chat for the agent based purely on routing —
   * used as the fallback when an event has no origin (cron, heartbeat,
   * cli, rest) or when origin-derived routing can't pin a chat.
   *
   * Prefers the last inbound for the agent (so replies thread back);
   * otherwise the first routed chat so spontaneous events still reach
   * a surface. Issue #139: outbound `response.text` /
   * `channel.permission_request` / `system.request_human` with
   * `origin === "telegram"` now route via {@link targetForOriginOrAgent}
   * which prefers `origin_id` over this fan-out cache, so two chats
   * routed to the same agent no longer cross-wire on interleaved
   * prompts.
   */
  private targetForAgent(agentId: string): PendingPrompt | null {
    const last = this.lastChatPerAgent.get(agentId);
    if (last) return last;
    for (const [chatIdStr, mappedAgent] of Object.entries(this.routingChats)) {
      if (mappedAgent === agentId) {
        const chatId = Number(chatIdStr);
        if (Number.isFinite(chatId)) {
          return { chat_id: chatId, source_message_id: 0 };
        }
      }
    }
    return null;
  }

  /** Best-effort API call — any throw is logged, never propagated. */
  private async safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`[telegram-adapter] ${label} failed`, err);
    }
  }

  private safeSendMessage(params: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
    reply_markup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
  }): Promise<void> {
    return this.safe("sendMessage", () => this.api.sendMessage(params));
  }

  private safeSetReaction(params: {
    chat_id: number;
    message_id: number;
    emoji: string;
  }): Promise<void> {
    return this.safe("setMessageReaction", () => this.api.setMessageReaction(params));
  }

  private safeAnswerCallback(params: { callback_query_id: string; text?: string }): Promise<void> {
    return this.safe("answerCallbackQuery", () => this.api.answerCallbackQuery(params));
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

// Re-exports so test files don't need to dig through the helper modules.
export { extractReactionDirectives } from "./directives";
export type { TelegramApi } from "./types";
