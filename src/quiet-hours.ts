/**
 * Quiet hours for proactive messages (#512).
 *
 * `settings.quietHours.windows` holds proactive Telegram messages — job
 * results, heartbeat, trigger output, the usage-limit notice, operator
 * alerts — produced inside a window until it ends; the durable outbox
 * (`telegram-outbox.ts`) keeps them and delivers them then. A reply to a
 * message the user sent is never held: only callers that know a message is
 * unprompted mark it proactive.
 *
 * The windows are evaluated by `isHeartbeatExcludedAt`, so they mean exactly
 * what `heartbeat.excludeWindows` means — no second clock parser.
 */

import type { QuietHoursConfig, Settings } from "./config";
import { isHeartbeatExcludedAt } from "./heartbeat-windows";
import type { OutboxMessage, TelegramOutbox } from "./telegram-outbox";

export interface QuietHoursState extends QuietHoursConfig {
  timezoneOffsetMinutes: number;
}

export function quietHoursFrom(
  settings: Pick<Settings, "quietHours" | "timezoneOffsetMinutes">,
): QuietHoursState {
  return { ...settings.quietHours, timezoneOffsetMinutes: settings.timezoneOffsetMinutes };
}

const MINUTE_MS = 60_000;
/** Windows repeat weekly, so a window that has not ended a week on never will. */
const HORIZON_MS = 8 * 24 * 60 * MINUTE_MS;

function isQuietAt(quiet: QuietHoursState, at: Date): boolean {
  return isHeartbeatExcludedAt({ excludeWindows: quiet.windows }, quiet.timezoneOffsetMinutes, at);
}

/**
 * Milliseconds from `now` to the first whole minute outside every window,
 * `0` when not quiet now, `null` when the windows never end (a full-day
 * window on every day). Minute steps: windows are `HH:MM`.
 */
function msUntilQuietEnds(quiet: QuietHoursState, now: Date): number | null {
  if (!isQuietAt(quiet, now)) return 0;
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let t = start + MINUTE_MS; t - start <= HORIZON_MS; t += MINUTE_MS) {
    if (!isQuietAt(quiet, new Date(t))) return t - now.getTime();
  }
  return null;
}

/**
 * Epoch ms at which the quiet window holding `now` ends, or `null` when a
 * proactive message may go out now. Windows that never end (a whole-day
 * window on every day) also give `null`: holding would mean never delivering.
 */
export function quietHoldUntil(quiet: QuietHoursState | undefined, now: number): number | null {
  if (!quiet || quiet.windows.length === 0) return null;
  const ms = msUntilQuietEnds(quiet, new Date(now));
  return ms !== null && ms > 0 ? now + ms : null;
}

/**
 * Legacy runtime: everything `start.ts` sends through the outbox (heartbeat,
 * job results, trigger output, the usage-limit notice) is proactive — no reply
 * to a user message goes this way — so quiet hours hold all of it. `quiet` is
 * read on every send, so a settings reload applies without a restart.
 */
export function proactiveDeliver(
  outbox: TelegramOutbox,
  quiet: () => QuietHoursState | undefined,
): (msg: OutboxMessage) => Promise<boolean> {
  outbox.setQuietHours((now) => quietHoldUntil(quiet(), now));
  return (msg) => outbox.deliver(msg, { proactive: true });
}

/** Startup line for the daemon log. */
export function describeQuietHours(quiet: QuietHoursState): string {
  if (quiet.windows.length === 0) return "off";
  const windows = quiet.windows.map((w) => `${w.start}-${w.end}`).join(", ");
  return `${windows} (proactive Telegram messages held${quiet.urgentBypass ? ", critical alerts bypass" : ""})`;
}
