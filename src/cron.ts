import { shiftDateToOffset } from "./timezone";

function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

/** Day-of-week as cron writes it: `7` is Sunday like `0` (POSIX allows
 *  both), while `Date#getUTCDay` only ever yields 0..6. Without this a
 *  standard `* * 7` never matched — and, once the scan stopped inventing a
 *  match, was refused at creation with a message about the scan window. */
function matchDayOfWeek(field: string, day: number): boolean {
  return matchCronField(field, day) || (day === 0 && matchCronField(field, 7));
}

/** Whether a time field can match at all within its range (minute 0..59,
 *  hour 0..23). A field that cannot — `60 * * * *`, `0 24 * * *`, an
 *  inverted range — turns the day-by-day scan into a full minute walk of
 *  every candidate day (a 6–10 s synchronous stall, reachable from a typo'd
 *  legacy job file on every status tick), so it is checked once up front. */
function fieldCanMatch(field: string, max: number): boolean {
  for (let v = 0; v <= max; v++) if (matchCronField(field, v)) return true;
  return false;
}

export function cronMatches(expr: string, date: Date, timezoneOffsetMinutes = 0): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };

  return (
    matchCronField(minute, d.minute) &&
    matchCronField(hour, d.hour) &&
    matchCronField(dayOfMonth, d.dayOfMonth) &&
    matchCronField(month, d.month) &&
    matchDayOfWeek(dayOfWeek, d.dayOfWeek)
  );
}

/**
 * Upper bound on the forward scan, in days. A valid expression can
 * legitimately have a multi-year gap between matches: `0 0 29 2 *` fires
 * every four years, and Feb 29 on a given weekday recurs every 28 years —
 * 40 across a century year that is not leap (2072 → 2112, the longest gap
 * the Gregorian calendar produces). The bound covers that gap from any
 * start; beyond it the expression is treated as never matching and `null`
 * is returned. Only date fields are checked on skipped days, and a time
 * field that can never match is refused before the scan, so a full scan is
 * ~15k cheap comparisons.
 */
const MAX_SCAN_DAYS = 366 * 41;

/**
 * Next instant strictly after `after` that matches `expr`, or `null` when
 * nothing matches within `MAX_SCAN_DAYS`.
 *
 * The scan works day by day: a day whose date fields (day-of-month, month,
 * day-of-week) cannot match is skipped in one step, and only candidate days
 * are walked minute by minute. Both checks reuse `matchCronField` /
 * `cronMatches`, so the result is exactly what a minute-by-minute scan
 * would return — without the 48-hour cap that used to make this function
 * return the scan-end date as if it were a match (issue #437).
 */
export function nextCronMatch(expr: string, after: Date, timezoneOffsetMinutes = 0): Date | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  if (!fieldCanMatch(minute, 59) || !fieldCanMatch(hour, 23)) return null;
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setTime(d.getTime() + 60_000);
  for (let day = 0; day < MAX_SCAN_DAYS; day++) {
    const shifted = shiftDateToOffset(d, timezoneOffsetMinutes);
    // Minutes left in the current day of the target offset, from `d` inclusive.
    const remaining = 24 * 60 - (shifted.getUTCHours() * 60 + shifted.getUTCMinutes());
    const dateMatches =
      matchCronField(dayOfMonth, shifted.getUTCDate()) &&
      matchCronField(month, shifted.getUTCMonth() + 1) &&
      matchDayOfWeek(dayOfWeek, shifted.getUTCDay());
    // Advance in absolute milliseconds, never through the process-local
    // calendar (`setMinutes`): on a host whose zone observes DST, a local
    // hour is skipped or repeated once a year and the walk would land an
    // hour off. The configured offset is fixed, so wall-clock math is not
    // needed here.
    if (dateMatches) {
      for (let i = 0; i < remaining; i++) {
        if (cronMatches(expr, d, timezoneOffsetMinutes)) return d;
        d.setTime(d.getTime() + 60_000);
      }
    } else {
      d.setTime(d.getTime() + remaining * 60_000);
    }
  }
  return null;
}
