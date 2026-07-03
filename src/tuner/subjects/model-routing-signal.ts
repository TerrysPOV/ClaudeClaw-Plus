/**
 * model-routing-signal — the model_routing subject's LOCAL degradation signal:
 * the trend of per-session cost. Rising cost = routing could be cheaper/better →
 * a trigger to research a routing technique. Reads the same `session_costs` store
 * the session_cost telemetry stream uses (date, cost_usd per session). Local only.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

export interface DayCost {
  date: string;
  medianUsd: number;
  sessions: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Per-day median session cost over the recent window (oldest first). Graceful: [] if no DB. */
export function readDailyCost(dbPath: string, limitDays = 30): DayCost[] {
  if (!existsSync(dbPath)) return [];
  // The constructor itself can throw (corrupt/partially-written DB, non-SQLite
  // file, EACCES from a differently-privileged writer) — keep it INSIDE the try
  // so the documented "graceful: [] on any failure" contract actually holds and
  // a bad cost DB can never stall the proactive loop (matches the sibling
  // session-cost / host-telemetry readers).
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT date, cost_usd FROM session_costs WHERE date >= date('now', '-' || ?1 || ' days') ORDER BY date",
      )
      .all(limitDays) as Array<{ date: string; cost_usd: number }>;
    const byDay = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byDay.get(r.date) ?? [];
      arr.push(r.cost_usd);
      byDay.set(r.date, arr);
    }
    return [...byDay.entries()]
      .map(([date, xs]) => ({ date, medianUsd: median(xs), sessions: xs.length }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}

/** Trend of the daily medians: recent half vs older half, with a relative + absolute floor. */
export function costTrend(
  days: DayCost[],
  tol = 0.15,
  minAbsUsd = 0.5,
): "improving" | "stable" | "degrading" {
  if (days.length < 4) return "stable";
  const mid = Math.floor(days.length / 2);
  const avg = (xs: DayCost[]) => xs.reduce((a, d) => a + d.medianUsd, 0) / xs.length;
  const older = avg(days.slice(0, mid));
  const recent = avg(days.slice(mid));
  if (Math.abs(recent - older) <= minAbsUsd) return "stable"; // below noise floor
  if (older === 0) return recent > 0 ? "degrading" : "stable";
  const delta = (recent - older) / older;
  if (delta > tol) return "degrading";
  if (delta < -tol) return "improving";
  return "stable";
}

export interface CostSignal {
  value: number; // recent median session cost (USD)
  trend: "improving" | "stable" | "degrading";
  degraded: boolean;
  days: number;
}

/** The degradation verdict: cost trending up (above noise floor) = degraded. */
export function costSignal(dbPath: string, maxRecentUsd = Infinity): CostSignal {
  const days = readDailyCost(dbPath);
  const lastDay = days.at(-1);
  const recent = lastDay ? lastDay.medianUsd : 0;
  const trend = costTrend(days);
  // Both degradation paths must share the same sample discipline: costTrend
  // already refuses a verdict below 4 days, and the absolute `recent > cap`
  // branch now does too — otherwise a single outlier day on a fresh/sparse DB
  // (e.g. one $30 batch job on day one) would flip `degraded` and fire a
  // spurious proactive proposal.
  const enoughSamples = days.length >= 4;
  const degraded = enoughSamples && (trend === "degrading" || recent > maxRecentUsd);
  return { value: Math.round(recent * 1e4) / 1e4, trend, degraded, days: days.length };
}

if (import.meta.main) {
  const dbPath = process.argv[2] ?? `${process.env.HOME}/agent/data/costs.db`;
  console.log(`[model-routing-signal] ${JSON.stringify(costSignal(dbPath))}`);
}
