/**
 * Heartbeat exclusion-window evaluator.
 *
 * Extracted from `src/commands/start.ts` (Sprint 5.2d, PR #126) so the
 * Bus runtime's `wireBusScheduler` can honour `settings.heartbeat.
 * excludeWindows` without duplicating the legacy semantics.
 *
 * Window semantics:
 *   - Each window has `start: "HH:MM"` and `end: "HH:MM"` in the
 *     daemon's configured timezone (offset minutes).
 *   - When `start < end`, the window is same-day (e.g. 22:00–07:00 is
 *     NOT same-day; 09:00–17:00 IS).
 *   - When `start > end`, the window wraps midnight (22:00–07:00 ⇒ from
 *     22:00 today through 07:00 tomorrow). The previous-day membership
 *     of `days` is consulted for the post-midnight half.
 *   - When `start === end`, the entire matching day is excluded.
 *   - `days` is a list of weekday numbers (0=Sun … 6=Sat). Empty /
 *     missing = every day.
 */

import type { HeartbeatConfig } from "./config";
import { getDayAndMinuteAtOffset } from "./timezone";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseClockMinutes(value: string): number | null {
  const match = TIME_RE.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Convenience wrapper using `new Date()`. */
export function isHeartbeatExcludedNow(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
): boolean {
  return isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date());
}

/**
 * Check whether a given `Date` falls inside any configured exclusion
 * window in the daemon's timezone.
 */
export function isHeartbeatExcludedAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  at: Date,
): boolean {
  if (!Array.isArray(config.excludeWindows) || config.excludeWindows.length === 0) return false;
  const local = getDayAndMinuteAtOffset(at, timezoneOffsetMinutes);

  for (const window of config.excludeWindows) {
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start == null || end == null) continue;
    const days = Array.isArray(window.days) && window.days.length > 0 ? window.days : ALL_DAYS;
    const sameDay = start < end;

    if (sameDay) {
      if (days.includes(local.day) && local.minute >= start && local.minute < end) return true;
      continue;
    }

    if (start === end) {
      if (days.includes(local.day)) return true;
      continue;
    }

    // Wrap-around: post-midnight half belongs to the PREVIOUS day's
    // window membership (e.g. a Friday 22:00–Saturday 07:00 window
    // excludes Saturday 03:00 even though the window's `days` lists
    // Friday).
    if (local.minute >= start && days.includes(local.day)) return true;
    const previousDay = (local.day + 6) % 7;
    if (local.minute < end && days.includes(previousDay)) return true;
  }

  return false;
}
