/**
 * Outlier-robust aggregation for fitness windows.
 *
 * Cost and latency telemetry is spiky and skewed by atypical debug/migration
 * sessions (validated on a self-hosted agent fixture). A raw sum or mean lets one
 * outlier session dominate a verdict — so fitness aggregation MUST use a
 * median or trimmed mean, never a raw sum.
 */

/** Median of `xs`. Returns 0 for an empty input. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Mean after dropping the top and bottom `trim` fraction (each side).
 * `trim` is clamped to [0, 0.49]. Falls back to the median when trimming
 * would empty the sample.
 */
export function trimmedMean(xs: readonly number[], trim = 0.1): number {
  if (xs.length === 0) return 0;
  const t = Math.min(Math.max(trim, 0), 0.49);
  const s = [...xs].sort((a, b) => a - b);
  const drop = Math.floor(s.length * t);
  const kept = s.slice(drop, s.length - drop);
  if (kept.length === 0) return median(s);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** Rate of samples whose value is non-zero (e.g. error/failure rate). */
export function nonzeroRate(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.filter((x) => x !== 0).length / xs.length;
}
