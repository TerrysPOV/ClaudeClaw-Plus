/**
 * Tests for `src/heartbeat-windows.ts` (Sprint 5.2d).
 *
 * The window evaluator was previously a private helper in `start.ts`
 * and had only indirect coverage via daemon-level integration tests.
 * Extracted in PR #126 so `wireBusScheduler` can reuse it; the same
 * extraction gives us a clean unit-test seam here.
 */

import { describe, it, expect } from "bun:test";
import { isHeartbeatExcludedAt } from "../heartbeat-windows";
import type { HeartbeatConfig } from "../config";

function cfg(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    enabled: true,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: false,
    forwardToDiscord: false,
    ...over,
  };
}

/** Convenience: 2026-05-19 is a Tuesday (UTC). */
const TUE_NOON = new Date("2026-05-19T12:00:00Z");
const TUE_3AM = new Date("2026-05-19T03:00:00Z");
const TUE_10PM = new Date("2026-05-19T22:00:00Z");

describe("isHeartbeatExcludedAt", () => {
  it("returns false when no windows configured", () => {
    expect(isHeartbeatExcludedAt(cfg(), 0, TUE_NOON)).toBe(false);
  });

  it("excludes inside a same-day window (09:00 → 17:00)", () => {
    const config = cfg({ excludeWindows: [{ start: "09:00", end: "17:00" }] });
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(true);
    // 03:00 falls outside.
    expect(isHeartbeatExcludedAt(config, 0, TUE_3AM)).toBe(false);
  });

  it("excludes inside a wrap-around window (22:00 → 07:00)", () => {
    const config = cfg({ excludeWindows: [{ start: "22:00", end: "07:00" }] });
    // Tuesday 22:00 — start of the window.
    expect(isHeartbeatExcludedAt(config, 0, TUE_10PM)).toBe(true);
    // Tuesday 03:00 — inside the previous-day half (Mon 22:00 → Tue 07:00).
    expect(isHeartbeatExcludedAt(config, 0, TUE_3AM)).toBe(true);
    // Tuesday 12:00 — outside both halves.
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(false);
  });

  it("respects per-window day filter", () => {
    // Mon-Fri only.
    const config = cfg({
      excludeWindows: [{ start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }],
    });
    // Tuesday noon is excluded.
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(true);
    // Sunday noon is NOT.
    const SUN_NOON = new Date("2026-05-17T12:00:00Z");
    expect(isHeartbeatExcludedAt(config, 0, SUN_NOON)).toBe(false);
  });

  it("start === end excludes the whole matching day", () => {
    const config = cfg({ excludeWindows: [{ start: "00:00", end: "00:00", days: [2] }] });
    expect(isHeartbeatExcludedAt(config, 0, TUE_3AM)).toBe(true);
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(true);
    expect(isHeartbeatExcludedAt(config, 0, TUE_10PM)).toBe(true);
    // Monday is NOT excluded.
    const MON_NOON = new Date("2026-05-18T12:00:00Z");
    expect(isHeartbeatExcludedAt(config, 0, MON_NOON)).toBe(false);
  });

  it("malformed time strings are ignored without crashing", () => {
    const config = cfg({
      excludeWindows: [
        { start: "not-a-time", end: "17:00" },
        { start: "09:00", end: "also bad" },
        { start: "09:00", end: "17:00" }, // valid
      ],
    });
    // Only the valid window applies.
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(true);
    expect(isHeartbeatExcludedAt(config, 0, TUE_3AM)).toBe(false);
  });

  it("respects timezoneOffsetMinutes", () => {
    // 12:00 UTC = 13:00 in UTC+1. A 13:00 window catches it.
    const config = cfg({ excludeWindows: [{ start: "13:00", end: "14:00" }] });
    expect(isHeartbeatExcludedAt(config, 0, TUE_NOON)).toBe(false);
    expect(isHeartbeatExcludedAt(config, 60, TUE_NOON)).toBe(true);
  });
});
