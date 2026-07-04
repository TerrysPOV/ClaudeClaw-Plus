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
  /** Relative fraction below which a move is treated as noise when the baseline
   *  is materially non-zero. Default 5%. */
  noiseFraction?: number;
  /**
   * Baseline magnitude below which the RELATIVE comparison is unreliable and the
   * absolute regime takes over. Rate / fraction / count metrics routinely have a
   * ~0 baseline (e.g. an error/failure rate over a clean window); dividing by a
   * collapsed denominator-of-1 and applying the 5% relative floor to a raw
   * fraction silently swallows a real 0→material jump. Default 1e-9.
   */
  minBaseline?: number;
  /**
   * Absolute move floor applied when |baseline| <= `minBaseline` (the near-zero
   * regime). A signed move beyond this counts as a real move. Default 0.01 —
   * i.e. a rate jumping from 0 to ≥1 percentage point is a move, not noise.
   * Configure per metric for domains where "material" differs.
   */
  absoluteNoise?: number;
  /**
   * Number of samples the aggregate was computed from. `undefined` = unknown
   * (treated as underpowered — the safe default, so an untracked metric can't
   * force a verdict/revert); `0` = empty window (no data). Used by
   * `decideVerdict`'s minimum-N guard so a single lucky session can't decide.
   */
  count?: number;
}

const DEFAULT_MIN_BASELINE = 1e-9;
const DEFAULT_ABSOLUTE_NOISE = 0.01;

/**
 * Classify a metric's move in its preferred direction: "up" (improved), "down"
 * (regressed), or "flat" (within noise).
 *
 * Two regimes. Non-zero baseline → relative move vs `noiseFraction` (unchanged
 * behaviour). Near-zero baseline (|baseline| <= `minBaseline`) → ABSOLUTE signed
 * move vs `absoluteNoise`, so a rate/error-count going 0 → material is caught
 * instead of being divided down and swallowed by the relative floor.
 */
function classifyMove(d: MetricDelta): "up" | "down" | "flat" {
  const minBaseline = d.minBaseline ?? DEFAULT_MIN_BASELINE;
  // For lower_is_better, a decrease is an improvement (flip the sign).
  const sign = d.direction === "lower_is_better" ? -1 : 1;

  if (Math.abs(d.baseline) > minBaseline) {
    const noise = d.noiseFraction ?? 0.05;
    const move = (sign * (d.post - d.baseline)) / Math.abs(d.baseline);
    if (move > noise) return "up";
    if (move < -noise) return "down";
    return "flat";
  }

  const absNoise = d.absoluteNoise ?? DEFAULT_ABSOLUTE_NOISE;
  const absMove = sign * (d.post - d.baseline);
  if (absMove > absNoise) return "up";
  if (absMove < -absNoise) return "down";
  return "flat";
}

export interface VerdictOptions {
  /**
   * Minimum sample count required to emit `improved`/`regressed`. A delta whose
   * `count` is below this (including 0 = empty window) OR unknown (`undefined`)
   * falls back to neutral/inconclusive — unknown is treated as underpowered, the
   * safe default. Default 1 — so an empty window (count 0) is "no data →
   * neutral", but callers that can supply real N should raise it (e.g. 2) so one
   * lucky/fast session can't clear the noise floor and decide on N=1.
   */
  minSamples?: number;
}

/** A delta we can't trust as evidence: an unknown (`undefined`) count, or a
 *  known count below the floor (including 0 = empty window). Unknown count is
 *  treated as underpowered — the safe default — so a metric with no sample
 *  tracking can't force a verdict (and, as a guardrail, a revert) off one
 *  unlucky sample. Metrics that supply a real `count` gate on it as before. */
function underpowered(d: MetricDelta, minSamples: number): boolean {
  return d.count === undefined || d.count < minSamples;
}

/**
 * Decide the verdict for one applied change.
 *
 * @param target   delta for the metric the change was meant to improve
 * @param guardrails deltas for companion metrics that must not regress
 * @param opts     sample-size guard (`minSamples`)
 *
 * - a guardrail with enough samples that regressed (`down`) → `regressed`
 *   (no-regression overrides; an underpowered guardrail can't CLAIM a regression)
 * - else target underpowered (too few samples / empty window) → `neutral`
 * - else target improved (`up`) → `improved`
 * - else target regressed (`down`) → `regressed`
 * - else → `neutral`
 */
export function decideVerdict(
  target: MetricDelta,
  guardrails: MetricDelta[] = [],
  opts: VerdictOptions = {},
): Verdict {
  const minSamples = opts.minSamples ?? 1;
  for (const g of guardrails) {
    // Too few samples to trust the guardrail as evidence of a regression.
    if (underpowered(g, minSamples)) continue;
    if (classifyMove(g) === "down") return "regressed";
  }
  // Too few samples on the target (or an empty window) → inconclusive.
  if (underpowered(target, minSamples)) return "neutral";
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
