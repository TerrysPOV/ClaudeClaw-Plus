import { describe, it, expect } from "bun:test";
import type { ModelBenchmark } from "../../../subjects/model-routing-benchmarks.js";
import { evaluateReroute } from "../../../subjects/model-routing-quality.js";

function bench(p: Partial<ModelBenchmark>): ModelBenchmark {
  return {
    model_id: "x",
    name: "X",
    intelligence_index: 60,
    coding_index: null,
    agentic_index: null,
    price_in_usd_per_mtok: 3,
    price_out_usd_per_mtok: 15,
    price_cache_hit_usd_per_mtok: null,
    source: "t",
    fetched_at: "t",
    ...p,
  };
}

describe("model-routing-quality — evaluateReroute (quality is the veto)", () => {
  it("proposes a strict quality win that is also cheaper", () => {
    const cur = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const cand = bench({
      intelligence_index: 65,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 5,
    });
    const v = evaluateReroute(cur, cand);
    expect(v.propose).toBe(true);
    expect(v.code).toBe("quality_win");
    expect(v.quality_delta).toBe(5);
    expect(v.projected_savings_usd_per_mtok).toBeGreaterThan(0);
  });

  it("VETOES a cheaper candidate that regresses quality", () => {
    const cur = bench({ intelligence_index: 60 });
    const cand = bench({
      intelligence_index: 50,
      price_in_usd_per_mtok: 0.5,
      price_out_usd_per_mtok: 2,
    });
    const v = evaluateReroute(cur, cand);
    expect(v.propose).toBe(false);
    expect(v.code).toBe("quality_regression");
    // savings are real but irrelevant — quality wins
    expect(v.projected_savings_usd_per_mtok).toBeGreaterThan(0);
  });

  it("does NOT propose when quality holds but there is no cost win", () => {
    const cur = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const cand = bench({
      intelligence_index: 62,
      price_in_usd_per_mtok: 4,
      price_out_usd_per_mtok: 20,
    });
    const v = evaluateReroute(cur, cand);
    expect(v.propose).toBe(false);
    expect(v.code).toBe("not_cheaper");
  });

  it("allows a within-tolerance quality dip when it buys a cost win", () => {
    const cur = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const cand = bench({
      intelligence_index: 58,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 5,
    });
    const v = evaluateReroute(cur, cand, { qualityTolerance: 3 });
    expect(v.propose).toBe(true);
    expect(v.code).toBe("cost_win_quality_held");
    expect(v.quality_delta).toBe(-2);
  });

  it("with zero tolerance (default), even a tiny quality dip is vetoed", () => {
    const cur = bench({ intelligence_index: 60 });
    const cand = bench({
      intelligence_index: 59.5,
      price_in_usd_per_mtok: 0.1,
      price_out_usd_per_mtok: 0.5,
    });
    const v = evaluateReroute(cur, cand);
    expect(v.propose).toBe(false);
    expect(v.code).toBe("quality_regression");
  });

  it("respects the minimum-savings floor", () => {
    const cur = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const cand = bench({
      intelligence_index: 61,
      price_in_usd_per_mtok: 2.99,
      price_out_usd_per_mtok: 14.9,
    });
    const v = evaluateReroute(cur, cand, { minSavingsUsdPerMtok: 1 });
    expect(v.propose).toBe(false);
    expect(v.code).toBe("not_cheaper");
  });

  it("cannot gate without both indices or pricing → insufficient_data", () => {
    const cur = bench({ intelligence_index: null });
    const cand = bench({ intelligence_index: 65 });
    expect(evaluateReroute(cur, cand).code).toBe("insufficient_data");

    const cur2 = bench({ price_in_usd_per_mtok: null });
    const cand2 = bench({ intelligence_index: 65 });
    const v2 = evaluateReroute(cur2, cand2);
    expect(v2.propose).toBe(false);
    expect(v2.code).toBe("insufficient_data");
  });

  it("computes blended savings with the input/output ratio", () => {
    // ratio 3 → blended = (3*in + out)/4
    const cur = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 4,
      price_out_usd_per_mtok: 4,
    }); // blended 4
    const cand = bench({
      intelligence_index: 60,
      price_in_usd_per_mtok: 2,
      price_out_usd_per_mtok: 2,
    }); // blended 2
    const v = evaluateReroute(cur, cand, { inputOutputRatio: 3 });
    expect(v.projected_savings_usd_per_mtok).toBe(2);
    expect(v.propose).toBe(true);
  });
});

import { proposeBenchmarkReroute } from "../../../subjects/model-routing-quality.js";

describe("model-routing-quality — proposeBenchmarkReroute (Tier-A pipeline)", () => {
  const benches: ModelBenchmark[] = [
    bench({
      model_id: "opus",
      intelligence_index: 70,
      price_in_usd_per_mtok: 15,
      price_out_usd_per_mtok: 75,
    }),
    bench({
      model_id: "sonnet",
      intelligence_index: 65,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    }),
    bench({
      model_id: "haiku",
      intelligence_index: 55,
      price_in_usd_per_mtok: 0.8,
      price_out_usd_per_mtok: 4,
    }),
  ];

  it("proposes the best quality-gated reroute per assignment", () => {
    // 'fast' is on opus (overkill+pricey). sonnet keeps most quality much cheaper;
    // haiku is cheaper still but regresses quality more. With tolerance 6, sonnet
    // (Δ-5) passes and haiku (Δ-15) is vetoed → sonnet wins.
    const props = proposeBenchmarkReroute([{ key: "fast", model: "opus" }], benches, {
      qualityTolerance: 6,
    });
    expect(props.length).toBe(1);
    expect(props[0]!.to_model).toBe("sonnet");
    expect(props[0]!.verdict.propose).toBe(true);
  });

  it("skips an assignment whose current model has no benchmark", () => {
    const props = proposeBenchmarkReroute([{ key: "x", model: "unknown-model" }], benches);
    expect(props).toEqual([]);
  });

  it("proposes nothing when the current model is already the quality leader and nothing is a safe cheaper swap", () => {
    // opus is top quality; with strict tolerance 0 every cheaper model regresses.
    const props = proposeBenchmarkReroute([{ key: "hard", model: "opus" }], benches, {
      qualityTolerance: 0,
    });
    expect(props).toEqual([]);
  });

  it("upgrades toward higher quality when it is also not more expensive", () => {
    // 'cheap' sits on haiku; a same-or-lower-price higher-quality model would win,
    // but here everything better is pricier → no proposal (quality can't be bought
    // with a cost regression). Confirms cost-safety on the upgrade direction.
    const props = proposeBenchmarkReroute([{ key: "cheap", model: "haiku" }], benches);
    expect(props).toEqual([]);
  });

  it("handles several assignments independently", () => {
    const props = proposeBenchmarkReroute(
      [
        { key: "fast", model: "opus" },
        { key: "cheap", model: "haiku" },
      ],
      benches,
      { qualityTolerance: 6 },
    );
    expect(props.map((p) => p.key).sort()).toEqual(["fast"]); // only 'fast' has a safe cheaper swap
  });
});
