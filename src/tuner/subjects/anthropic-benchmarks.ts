/**
 * anthropic-benchmarks — Tier-A-for-Claude coding scores from Anthropic's OWN
 * published SWE-bench Verified figures, filling the gap where the Artificial
 * Analysis free tier leaves Claude (especially Opus) coding_index null.
 *
 * Scale: SWE-bench Verified % sits on ~the same 0-100 range as AA's coding_index
 * (e.g. Sonnet 5: AA coding 71.5 ≈ SWE 72.7), so it drops in cleanly for gating.
 *
 * ⚠️ CURATED SEED — verify + extend from Anthropic's official model cards. Public
 * sources report SWE-bench under different harnesses and disagree by several
 * points, so only high-confidence, single-version figures are seeded here; every
 * other model is left to the intelligence-composite fallback rather than guessed.
 * Keyed by Artificial Analysis slug. Last touched 2026-07.
 */
import type { ModelBenchmark } from "./model-routing-benchmarks.js";

export const ANTHROPIC_SWE_BENCH_VERIFIED: Record<string, number> = {
  // Opus 4.7 — Anthropic-reported SWE-bench Verified ≈ 82.0 (AA leaves this null).
  "claude-opus-4-7-non-reasoning": 82.0,
  // Sonnet 5 — already has an AA coding score (71.5); seeded for consistency (72.7).
  "claude-sonnet-5": 72.7,
};

export const ANTHROPIC_SOURCE = "https://www.anthropic.com/ (SWE-bench Verified, per model card)";

/**
 * Fill coding_index for Claude models from Anthropic's published SWE-bench where
 * AA left it null. Never OVERWRITES a value AA already provides (AA is the neutral
 * cross-provider measure); only fills gaps. Pure — returns a new array.
 */
export function enrichWithAnthropicCoding(benchmarks: ModelBenchmark[]): ModelBenchmark[] {
  return benchmarks.map((b) => {
    if (b.coding_index !== null) return b;
    const swe = ANTHROPIC_SWE_BENCH_VERIFIED[b.model_id.toLowerCase()];
    if (swe === undefined) return b;
    return { ...b, coding_index: swe, source: `${b.source} + ${ANTHROPIC_SOURCE}` };
  });
}
