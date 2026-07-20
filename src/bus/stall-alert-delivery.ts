/**
 * Operator-alert delivery for the stall watchdog (#301).
 *
 * The watchdog's `notify` was log-only: a `suspected_false_positive` kill —
 * the case the operator most needs to see, because it means a ceiling is set
 * too tight and legitimate work is being killed — only reached `journalctl`
 * and `.claude/claudeclaw/stall-kills.jsonl`. Noticing it required reading
 * server logs.
 *
 * There is no `sendToOperator` primitive in the daemon; outbound chat is a
 * publish/subscribe fan-out (adapters subscribe to bus topics and translate
 * them). This module adds that missing primitive as a dedicated topic,
 * `system.operator_alert`, which the Discord and Telegram adapters render as
 * a standalone message.
 *
 * **Why a dedicated topic and NOT `response.text`.** Reusing the reply topic
 * looks simpler and is wrong: `response.text` *is* the agent's turn output, so
 * adapters apply turn semantics to it. On Telegram, a non-progress
 * `response.text` closes the open receipt as `turn_observed` and — when a turn
 * is live — is EDITED IN PLACE over the agent's current reply message
 * (`adapters/telegram/index.ts` `handleResponseText`). An out-of-band watchdog
 * alert would therefore destroy the in-flight reply of the very agent it is
 * reporting on, and corrupt that turn's receipt. The web UI bridge
 * (`bus/webui-bridge.ts`) also accumulates `response.text` into whatever
 * `/api/chat` response is in flight. A separate topic avoids all of this by
 * construction: nothing that consumes turn state subscribes to it.
 *
 * Three further choices:
 *
 * 1. **`ingestSessionEvent`, not `ingestReply`.** `ingestReply` maps only
 *    reply intents onto reply topics and stamps the agent's stale
 *    `lastPromptOrigin` onto the payload. `ingestSessionEvent` publishes the
 *    event verbatim, and for a `system.*` topic it hits none of the
 *    delivery-gate branches (`session.init`, `bus.events.replay_done`,
 *    `prompt`, `response.turn_end`), so it has no side effects on turn state.
 *
 * 2. **No `origin`.** This means BOTH adapters deliver the alert: Discord's
 *    filter passes an absent origin, and Telegram's `eventBelongsToTelegram`
 *    returns true for `origin === undefined`. So where both are mounted for an
 *    agent, one alert reaches one Discord channel and one Telegram chat.
 *    That is intended — an operator alert should reach the operator wherever
 *    they are watching — but it is fan-out across surfaces, not a single
 *    destination.
 *
 *    The two surfaces resolve their single target differently:
 *      - Discord prefers `primaryChannelByAgent` (the operator-designated
 *        channel), else the agent's first routed channel. The alert handler
 *        deliberately takes ONE channel rather than the reply fan-out.
 *      - Telegram has NO `primaryChannelByAgent` equivalent. `targetForAgent`
 *        returns the chat that last messaged the agent, else the first chat
 *        mapped to it — a conversational chat, not an operator-designated one.
 *
 * 3. **No rate limiting here.** The warn call sites are behind the per-tool
 *    `warned` latch and the restart-failure site behind `killing` +
 *    `restartFailedAt`/`restartFailureCooldownMs`. The two post-kill sites
 *    (false-positive and genuine-wedge) are NOT behind those — they fire after
 *    a successful restart, by which point `killing` is released and the
 *    session state holding the latch is deleted. What bounds them is
 *    one-alert-per-kill plus `SessionManager`'s own `MAX_RESTARTS_PER_WINDOW`
 *    limiter — a real guard, but downstream and in another file. The
 *    conclusion still holds (a limiter here would be redundant); the bound
 *    just isn't local.
 */

import type { BusEvent } from "./types";

/** The bus surface this needs — narrowed so tests don't build a whole BusCore. */
export interface StallAlertBus {
  ingestSessionEvent(e: BusEvent): void;
}

/** Log sink, matching the daemon logger's shape. */
export interface StallAlertLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Prefix so an alert is never mistaken for the agent's own reply. */
export const STALL_ALERT_PREFIX = "🛡️ **stall-watchdog**";

/**
 * Dedicated operator-alert topic. Matches the `system.${string}` arm of
 * `BusEventTopic`, so no type change is needed. Deliberately NOT a reply
 * topic — see the module header.
 */
export const OPERATOR_ALERT_TOPIC = "system.operator_alert" as const;

/** Payload shape adapters render. `level` lets a surface style by severity. */
export interface OperatorAlertPayload {
  level: "warn" | "critical";
  text: string;
  source: string;
}

/**
 * Cap the chat copy of an alert. The daemon log keeps the full text.
 *
 * This is VOLUME control, not a disclosure control. It bounds how much a
 * pathological `err.message` can dump into a chat channel; it does not
 * redact, and it cannot: the leak-y throws in `SessionManager.restart` (an
 * absolute socket path, a session id) are ~100-140 chars and so pass through
 * the cap untouched. If those need withholding from chat, that is redaction
 * at the message-construction site, not a length limit here.
 */
export const MAX_ALERT_CHARS = 600;

function clampForChat(message: string): string {
  // Count and slice in the SAME unit — code points, not UTF-16 code units.
  // Measuring in one and cutting in the other means an all-emoji message
  // trips the guard (2 units each) while the slice removes nothing, so we
  // would claim content was dropped when none was, and deliver ~2x the cap.
  const chars = Array.from(message);
  if (chars.length <= MAX_ALERT_CHARS) return message;
  // Slicing by code point also avoids cutting a surrogate pair in half,
  // which would emit a lone surrogate that renders as a replacement glyph.
  return `${chars.slice(0, MAX_ALERT_CHARS).join("")}… (rest in the daemon log)`;
}

export interface StallAlertNotifierOpts {
  bus: StallAlertBus;
  logger: StallAlertLogger;
  /** Injectable clock so tests get deterministic timestamps. */
  now?: () => number;
}

/**
 * Build the watchdog's `notify` dep: log as before, and additionally deliver
 * to the operator's chat surface.
 *
 * Delivery is strictly best-effort — a throw from the bus is swallowed and
 * logged, never propagated, because `notify` is called on the recovery path
 * (including from the restart-failure catch block) and must not be able to
 * interrupt it.
 */
export function createStallAlertNotifier(
  opts: StallAlertNotifierOpts,
): (level: "warn" | "critical", message: string, agentId: string) => void {
  const { bus, logger, now = () => Date.now() } = opts;

  return (level, message, agentId) => {
    // 1. Log first — the durable path, with the FULL message. If delivery
    //    below explodes, the operator still has journalctl + stall-kills.jsonl.
    //    Deliberately outside the try below so ordering is guaranteed.
    try {
      if (level === "critical") logger.error("[stall-watchdog]", message);
      else logger.warn("[stall-watchdog]", message);
    } catch {
      /* a throwing logger must not break recovery either */
    }

    // 2. Deliver to the operator's surface. Best-effort, never throws:
    //    notify() is called from the restart-failure catch block, so an
    //    escape here would reject the sweep and surface as an unhandled
    //    rejection.
    if (!agentId) return;
    try {
      const payload: OperatorAlertPayload = {
        level,
        text: `${STALL_ALERT_PREFIX} ${clampForChat(message)}`,
        source: "stall-watchdog",
        // No `origin` / `origin_id`: routes via primaryChannelByAgent.
      };
      bus.ingestSessionEvent({
        ts: now(),
        agent_id: agentId,
        session_id: "",
        topic: OPERATOR_ALERT_TOPIC,
        payload,
      });
    } catch (err) {
      try {
        logger.error(
          "[stall-watchdog]",
          `operator-alert delivery failed (recovery unaffected): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {
        /* nothing left to do — never rethrow onto the recovery path */
      }
    }
  };
}
