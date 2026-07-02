/**
 * OutcomeLoop verdict rule (anti-Goodhart). Applies to EVERY subject.
 *
 * A change is `improved` iff its TARGET metric moved in the metric's
 * `direction` beyond noise AND no `guardrails` companion metric regressed
 * beyond noise. No-regression, NOT maximise — single-number maximisation is
 * the gameable shape and is forbidden. (Reward Hacking Benchmark
 * arXiv:2605.02964: Goodhart exploit rates 0–13.9% are real.)
 */

import type { Metric, MetricDirection } from "./telemetry.js";

export type Verdict = "improved" | "regressed" | "neutral";

export interface MetricDelta {
  metric: string;
  direction: MetricDirection;
  baseline: number;
  post: number;
  /** Absolute fraction below which a move is treated as noise. Default 5%. */
  noiseFraction?: number;
}

/** Signed improvement in the metric's preferred direction (post vs baseline). */
function relativeMove(d: MetricDelta): number {
  const denom = Math.abs(d.baseline) > 1e-9 ? Math.abs(d.baseline) : 1;
  const raw = (d.post - d.baseline) / denom;
  // For lower_is_better, a decrease (negative raw) is an improvement.
  return d.direction === "lower_is_better" ? -raw : raw;
}

function classifyMove(d: MetricDelta): "up" | "down" | "flat" {
  const noise = d.noiseFraction ?? 0.05;
  const move = relativeMove(d);
  if (move > noise) return "up"; // improved in preferred direction
  if (move < -noise) return "down"; // regressed
  return "flat";
}

/**
 * Decide the verdict for one applied change.
 *
 * @param target   delta for the metric the change was meant to improve
 * @param guardrails deltas for companion metrics that must not regress
 *
 * - any guardrail regressed (`down`) → `regressed` (no-regression overrides)
 * - else target improved (`up`) → `improved`
 * - else → `neutral`
 */
export function decideVerdict(target: MetricDelta, guardrails: MetricDelta[] = []): Verdict {
  for (const g of guardrails) {
    if (classifyMove(g) === "down") return "regressed";
  }
  const t = classifyMove(target);
  if (t === "up") return "improved";
  if (t === "down") return "regressed";
  return "neutral";
}

/** Pull a metric's guardrail metric objects from a subject's declared signals. */
export function guardrailMetricsFor(metric: Metric, all: readonly Metric[]): Metric[] {
  if (!metric.guardrails || metric.guardrails.length === 0) return [];
  const byName = new Map(all.map((m) => [m.name, m]));
  return metric.guardrails.map((n) => byName.get(n)).filter((m): m is Metric => m !== undefined);
}
