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

/** A concrete, quality-gated reroute the proactive face can surface. */
export interface RerouteProposal {
  /** The config key / mode whose model would change. */
  key: string;
  from_model: string;
  to_model: string;
  verdict: RerouteVerdict;
}

/** Rank two accepted verdicts: more savings first, then higher quality delta. */
function betterProposal(a: RerouteVerdict, b: RerouteVerdict): boolean {
  const sa = a.projected_savings_usd_per_mtok ?? -Infinity;
  const sb = b.projected_savings_usd_per_mtok ?? -Infinity;
  if (sa !== sb) return sa > sb;
  return (a.quality_delta ?? -Infinity) > (b.quality_delta ?? -Infinity);
}

/**
 * The Tier-A pipeline: for each current model assignment, find the best
 * quality-gated reroute among the published benchmarks. Returns at most one
 * proposal per key (the best by savings, then quality). An assignment whose
 * current model has no benchmark is skipped (can't gate → stay put). Pure:
 * assignments + benchmarks in, proposals out — no I/O, no web, fully testable.
 */
export function proposeBenchmarkReroute(
  assignments: Array<{ key: string; model: string }>,
  benchmarks: ModelBenchmark[],
  opts: RerouteGateOptions = {},
): RerouteProposal[] {
  const byId = new Map(benchmarks.map((b) => [b.model_id.toLowerCase(), b]));
  const proposals: RerouteProposal[] = [];
  for (const a of assignments) {
    const current = byId.get(a.model.toLowerCase());
    if (!current) continue;
    let best: RerouteProposal | null = null;
    for (const cand of benchmarks) {
      if (cand.model_id.toLowerCase() === a.model.toLowerCase()) continue;
      const verdict = evaluateReroute(current, cand, opts);
      if (!verdict.propose) continue;
      if (!best || betterProposal(verdict, best.verdict)) {
        best = { key: a.key, from_model: a.model, to_model: cand.model_id, verdict };
      }
    }
    if (best) proposals.push(best);
  }
  return proposals;
}

import type { EvidencePatch } from "../wisecron/evidence-driven.js";

function escapeReQuality(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract `mode → model` assignments from an agentic.yaml `modes:` block. Tracks
 * the (indented) mode header and pairs it with its `model:` line. Indent-aware so
 * a comment or sibling never mis-binds (same discipline as the YAML editors).
 */
export function parseModelAssignments(content: string): Array<{ key: string; model: string }> {
  const lines = content.split("\n");
  const out: Array<{ key: string; model: string }> = [];
  let mode: string | null = null;
  let modeIndent = "";
  for (const line of lines) {
    const header = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      mode = header[2] ?? null;
      modeIndent = header[1] ?? "";
      continue;
    }
    const m = line.match(/^(\s*)model:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/);
    if (m && mode && (m[1]?.length ?? 0) > modeIndent.length) {
      out.push({ key: mode, model: m[2]! });
      mode = null;
    }
  }
  return out;
}

/**
 * Set the `model:` for a specific mode block to `newModel`, preserving comments +
 * ordering. Indent-aware block scope (exits on a sibling/dedent) so a reroute of
 * one mode never rewrites another — the #306 hazard, avoided by construction.
 */
export function setModelInYaml(content: string, mode: string, newModel: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inMode = false;
  let modeIndent = "";
  const header = new RegExp(`^(\\s*)${escapeReQuality(mode)}:\\s*$`);
  for (const line of lines) {
    const h = line.match(header);
    if (h) {
      inMode = true;
      modeIndent = h[1] ?? "";
      out.push(line);
      continue;
    }
    if (
      inMode &&
      line.trim().length > 0 &&
      !line.trim().startsWith("#") &&
      !line.startsWith(`${modeIndent} `)
    )
      inMode = false;
    if (inMode) {
      const m = line.match(/^(\s*model:\s*)["']?[A-Za-z0-9._-]+["']?\s*$/);
      if (m) {
        out.push(`${m[1]}${newModel}`);
        inMode = false;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Turn quality-gated reroute proposals into an EvidencePatch the subject applies
 * itself (a CONFIG patch, in its own modes file — never a plugin, never engine
 * code). One alternative per proposal so the operator picks which mode to reroute.
 */
export function buildRerouteEvidencePatch(
  content: string,
  proposals: RerouteProposal[],
  targetPath: string,
): EvidencePatch | null {
  if (proposals.length === 0) return null;
  return {
    target_path: targetPath,
    alternatives: proposals.map((p) => ({
      id: `reroute-${p.key}-to-${p.to_model}`,
      label: `Route '${p.key}' ${p.from_model} → ${p.to_model}`,
      diff_or_content: setModelInYaml(content, p.key, p.to_model),
      tradeoff: p.verdict.reason,
    })),
  };
}
