/**
 * model-routing-quality — the QUALITY-FIRST reroute gate for the proactive
 * model_routing face (#292, phase "P4 core"). Pure decision logic kept out of
 * model-routing-subject.ts (≤800-line budget). Combines the published quality
 * signal (Artificial Analysis Intelligence Index, via model-routing-benchmarks)
 * with cost. The rule Simon set: QUALITY is the veto, cost is only the tiebreaker
 * — never propose a reroute that regresses quality, even if it is cheaper.
 *
 * This is the Tier-A gate (published, objective, cross-provider). A candidate
 * that survives it goes to the own-workload bench (#80) for Tier-B confirmation
 * before anything is applied.
 */
import type { ModelBenchmark } from "./model-routing-benchmarks.js";

export interface RerouteVerdict {
  /** Whether to surface this reroute as a candidate at all. */
  propose: boolean;
  /** Machine tag for the reason (telemetry + tests). */
  code:
    | "quality_regression" // candidate is meaningfully worse → vetoed
    | "not_cheaper" // quality ok but no cost win → nothing to gain
    | "insufficient_data" // missing index/pricing → cannot gate, stay put
    | "quality_win" // candidate is better AND not more expensive
    | "cost_win_quality_held"; // quality within tolerance AND cheaper
  reason: string;
  /** candidate.intelligence_index − current.intelligence_index (null if unknown). */
  quality_delta: number | null;
  /** Blended $/Mtok saved (current − candidate), null if pricing unknown. */
  projected_savings_usd_per_mtok: number | null;
}

export interface RerouteGateOptions {
  /**
   * How much Intelligence-Index drop is tolerable in exchange for a cost win.
   * 0 = zero tolerance (candidate must be ≥ current). Small positive = allow a
   * marginally-lower-quality-but-cheaper swap. Default 0 (quality strict).
   */
  qualityTolerance?: number;
  /** Blend weight for input vs output tokens when estimating $/Mtok. */
  inputOutputRatio?: number; // e.g. 3 → price ≈ (3*in + out) / 4
  /** Minimum blended $/Mtok saving to bother proposing. */
  minSavingsUsdPerMtok?: number;
}

function blendedPrice(b: ModelBenchmark, ratio: number): number | null {
  const pin = b.price_in_usd_per_mtok;
  const pout = b.price_out_usd_per_mtok;
  if (pin === null || pout === null) return null;
  return (ratio * pin + pout) / (ratio + 1);
}

/**
 * Decide whether rerouting `current` → `candidate` is worth proposing, quality
 * first. Never proposes a quality regression beyond tolerance; among quality-safe
 * options, requires a real cost win above the noise floor.
 */
export function evaluateReroute(
  current: ModelBenchmark,
  candidate: ModelBenchmark,
  opts: RerouteGateOptions = {},
): RerouteVerdict {
  const tol = opts.qualityTolerance ?? 0;
  const ratio = opts.inputOutputRatio ?? 3;
  const minSavings = opts.minSavingsUsdPerMtok ?? 0;

  const qCur = current.intelligence_index;
  const qCand = candidate.intelligence_index;
  const pCur = blendedPrice(current, ratio);
  const pCand = blendedPrice(candidate, ratio);

  // Cannot gate on quality without both indices, nor on cost without pricing.
  if (qCur === null || qCand === null || pCur === null || pCand === null) {
    return {
      propose: false,
      code: "insufficient_data",
      reason:
        "Missing Intelligence Index or pricing for one of the models — cannot gate on quality, staying put.",
      quality_delta: qCur !== null && qCand !== null ? qCand - qCur : null,
      projected_savings_usd_per_mtok: pCur !== null && pCand !== null ? pCur - pCand : null,
    };
  }

  const qualityDelta = qCand - qCur;
  const savings = pCur - pCand;

  // VETO: quality regression beyond tolerance — reject even if cheaper.
  if (qualityDelta < -tol) {
    return {
      propose: false,
      code: "quality_regression",
      reason: `Candidate Intelligence Index ${qCand} is ${(-qualityDelta).toFixed(
        1,
      )} below current ${qCur} (tolerance ${tol}). Quality is the veto — not proposed even though it saves $${savings.toFixed(2)}/Mtok.`,
      quality_delta: qualityDelta,
      projected_savings_usd_per_mtok: savings,
    };
  }

  // Quality is safe. Now cost is the tiebreaker: require a real saving.
  if (savings <= minSavings) {
    return {
      propose: false,
      code: "not_cheaper",
      reason: `Quality holds (Δ ${qualityDelta.toFixed(1)}) but no cost win above the floor ($${savings.toFixed(
        2,
      )}/Mtok ≤ $${minSavings}/Mtok) — nothing to gain.`,
      quality_delta: qualityDelta,
      projected_savings_usd_per_mtok: savings,
    };
  }

  // Propose. Distinguish a strict quality win from a within-tolerance cost win.
  const strictWin = qualityDelta >= 0;
  return {
    propose: true,
    code: strictWin ? "quality_win" : "cost_win_quality_held",
    reason: strictWin
      ? `Candidate is at least as good (Δ ${qualityDelta.toFixed(1)}) AND saves $${savings.toFixed(2)}/Mtok.`
      : `Candidate is within tolerance (Δ ${qualityDelta.toFixed(1)}, ≤ ${tol}) and saves $${savings.toFixed(2)}/Mtok.`,
    quality_delta: qualityDelta,
    projected_savings_usd_per_mtok: savings,
  };
}
