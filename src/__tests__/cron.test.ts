/**
 * Tests for `src/cron.ts` — `nextCronMatch`.
 *
 * Run with: `bun test src/__tests__/cron.test.ts`
 *
 * Regression coverage for issue #437: the scan used to stop after 48 hours
 * and return the scan-end date as if it were a match, so any schedule with
 * a gap over 48 hours fired on the wrong day.
 */

import { describe, expect, it } from "bun:test";
import { cronMatches, nextCronMatch } from "../cron";

describe("nextCronMatch", () => {
  it("finds the next match inside the first 48 hours (unchanged behaviour)", () => {
    const after = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const next = nextCronMatch("*/5 * * * *", after);
    expect(next?.getTime()).toBe(Date.UTC(2026, 0, 1, 0, 5, 0));
  });

  it("skips over a gap longer than 48 hours instead of returning the scan end (issue #437)", () => {
    // Thursday 2026-09-17 07:00 in UTC+2 == 05:00Z. Schedule: Tue/Thu 07:00.
    // Expected: Tuesday 2026-09-22 07:00 (+2) == 05:00Z, five days later.
    const after = new Date(Date.UTC(2026, 8, 17, 5, 0, 0));
    const next = nextCronMatch("0 7 * * 2,4", after, 120);
    expect(next?.getTime()).toBe(Date.UTC(2026, 8, 22, 5, 0, 0));
  });

  it("returns the real next run for a dated one-shot more than 48 hours ahead", () => {
    // Armed Fri 2026-09-18 10:11Z for `0 12 18 9 *` (Sep 18 12:00, UTC+2).
    // 2026-09-18 12:00+2 == 10:00Z is already past, so the next match is a year later.
    const after = new Date(Date.UTC(2026, 8, 18, 10, 11, 0));
    const next = nextCronMatch("0 12 18 9 *", after, 120);
    expect(next?.getTime()).toBe(Date.UTC(2027, 8, 18, 10, 0, 0));
  });

  it("handles a multi-year gap (Feb 29)", () => {
    const after = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
    const next = nextCronMatch("0 0 29 2 *", after);
    expect(next?.getTime()).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
  });

  it("finds Feb 29 on a given weekday (28-year cycle)", () => {
    // 2044-02-29 is a Monday.
    const after = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const next = nextCronMatch("0 0 29 2 1", after);
    expect(next?.getTime()).toBe(Date.UTC(2044, 1, 29, 0, 0, 0));
  });

  it("is not affected by the host's DST transitions (absolute-time arithmetic)", () => {
    // Under a DST-observing host zone, walking the calendar with local
    // setters lands an hour off across the fall-back night; the scan must
    // use absolute milliseconds. 2026-11-01 05:30Z is 01:30 EDT, thirty
    // minutes before the clocks go back in America/Toronto.
    const saved = process.env.TZ;
    process.env.TZ = "America/Toronto";
    try {
      const after = new Date(Date.UTC(2026, 10, 1, 5, 30, 0));
      expect(nextCronMatch("30 0 2 11 *", after)?.getTime()).toBe(Date.UTC(2026, 10, 2, 0, 30, 0));
      expect(nextCronMatch("30 6 * * *", after)?.getTime()).toBe(Date.UTC(2026, 10, 1, 6, 30, 0));
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("returns null for a well-formed expression that never matches", () => {
    const after = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(nextCronMatch("0 0 31 2 *", after)).toBeNull();
  });

  it("agrees with a minute-by-minute scan on the day skip", () => {
    // Day-of-week + day-of-month both restricted: 15th that is a Monday.
    const after = new Date(Date.UTC(2026, 0, 1, 12, 34, 0));
    const expr = "30 8 15 * 1";
    const next = nextCronMatch(expr, after, -300);
    const probe = new Date(after);
    probe.setSeconds(0, 0);
    probe.setMinutes(probe.getMinutes() + 1);
    while (!cronMatches(expr, probe, -300)) probe.setMinutes(probe.getMinutes() + 1);
    expect(next?.getTime()).toBe(probe.getTime());
  });

  it("does not mutate its input", () => {
    const after = new Date(Date.UTC(2026, 8, 17, 5, 0, 0));
    const copy = after.getTime();
    nextCronMatch("0 7 * * 2,4", after, 120);
    expect(after.getTime()).toBe(copy);
  });
});

describe("nextCronMatch — adversarial follow-ups on #437", () => {
  const after = new Date("2026-09-22T03:10:00Z");

  it("a time field that can never match returns null (the pre-check refuses it before any scan)", () => {
    // No wall-clock assertion: the cost is documented on the PR, and a
    // timing bound is a load-dependent flake in CI (see #304).
    for (const expr of ["0 24 * * *", "60 * * * *", "30-20 * * * *", "61 5 * * *"]) {
      expect(nextCronMatch(expr, after, -240)).toBeNull();
    }
  });

  it("covers the 40-year Feb-29 weekday gap across 2100 (2072 → 2112)", () => {
    const r = nextCronMatch("0 0 29 2 1", new Date("2072-03-01T00:00:00Z"), 0);
    expect(r?.toISOString()).toBe("2112-02-29T00:00:00.000Z");
  });

  it("day-of-week 7 is Sunday, like 0", () => {
    const seven = nextCronMatch("0 9 * * 7", after, -240);
    const zero = nextCronMatch("0 9 * * 0", after, -240);
    expect(seven).not.toBeNull();
    expect(seven?.getTime()).toBe(zero?.getTime());
    expect(cronMatches("0 9 * * 7", new Date("2026-09-27T13:00:00Z"), -240)).toBe(true); // a Sunday
    expect(cronMatches("0 9 * * 7", new Date("2026-09-28T13:00:00Z"), -240)).toBe(false); // Monday
  });
});
