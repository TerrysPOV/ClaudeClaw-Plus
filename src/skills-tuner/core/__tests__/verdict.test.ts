import { describe, it, expect } from "bun:test";
import { decideVerdict, type MetricDelta } from "../verdict.js";

/** Convenience builder for a target/guardrail delta. */
function delta(p: Partial<MetricDelta> & Pick<MetricDelta, "baseline" | "post">): MetricDelta {
  return {
    metric: p.metric ?? "m",
    direction: p.direction ?? "lower_is_better",
    baseline: p.baseline,
    post: p.post,
    ...(p.noiseFraction !== undefined ? { noiseFraction: p.noiseFraction } : {}),
    ...(p.minBaseline !== undefined ? { minBaseline: p.minBaseline } : {}),
    ...(p.absoluteNoise !== undefined ? { absoluteNoise: p.absoluteNoise } : {}),
    ...(p.count !== undefined ? { count: p.count } : {}),
  };
}

describe("decideVerdict — zero-baseline regression (fix 1)", () => {
  it("catches an error-rate going 0 → material (lower_is_better)", () => {
    // baseline ~0, post 0.05 (a 5pp error rate). Old relative math divided by a
    // collapsed denominator-of-1 → move -0.05, NOT strictly < -0.05 → 'flat' →
    // regression missed. Absolute regime now classifies it as a real move.
    expect(
      decideVerdict(delta({ baseline: 0, post: 0.05, direction: "lower_is_better", count: 2 })),
    ).toBe("regressed");
  });

  it("catches a rate going 0 → material for higher_is_better as an improvement", () => {
    expect(
      decideVerdict(delta({ baseline: 0, post: 0.05, direction: "higher_is_better", count: 2 })),
    ).toBe("improved");
  });

  it("a near-zero baseline move within the absolute floor stays neutral", () => {
    expect(
      decideVerdict(delta({ baseline: 0, post: 0.005, direction: "lower_is_better", count: 2 })),
    ).toBe("neutral");
  });

  it("catches a guardrail rate regressing from ~0", () => {
    const target = delta({ baseline: 100, post: 70, direction: "lower_is_better", count: 2 }); // improved
    const guard = delta({
      metric: "error_rate",
      baseline: 0,
      post: 0.05,
      direction: "lower_is_better",
      count: 2,
    });
    expect(decideVerdict(target, [guard])).toBe("regressed");
  });

  it("leaves non-zero baseline behaviour unchanged", () => {
    expect(
      decideVerdict(delta({ baseline: 100, post: 70, direction: "lower_is_better", count: 2 })),
    ).toBe("improved");
    expect(
      decideVerdict(delta({ baseline: 100, post: 130, direction: "lower_is_better", count: 2 })),
    ).toBe("regressed");
    expect(
      decideVerdict(delta({ baseline: 100, post: 101, direction: "lower_is_better", count: 2 })),
    ).toBe("neutral"); // within 5% relative floor
  });
});

describe("decideVerdict — sample-size guard (fix 2)", () => {
  it("does not decide on N=1 (falls back to neutral)", () => {
    const improving = delta({ baseline: 100, post: 50, direction: "lower_is_better", count: 1 });
    expect(decideVerdict(improving, [], { minSamples: 2 })).toBe("neutral");
  });

  it("decides once N reaches the floor", () => {
    const improving = delta({ baseline: 100, post: 50, direction: "lower_is_better", count: 2 });
    expect(decideVerdict(improving, [], { minSamples: 2 })).toBe("improved");
  });

  it("treats an empty window (count 0) as no-data → neutral, even at default minSamples", () => {
    const improving = delta({ baseline: 100, post: 50, direction: "lower_is_better", count: 0 });
    expect(decideVerdict(improving)).toBe("neutral");
  });

  it("treats an unknown count as underpowered → neutral (safe default, fix)", () => {
    // A metric with no sample tracking (count undefined) can't be trusted to
    // decide — it must NOT clear the gate just because N is unknown.
    const improving = delta({ baseline: 100, post: 50, direction: "lower_is_better" });
    expect(decideVerdict(improving)).toBe("neutral");
    expect(decideVerdict(improving, [], { minSamples: 5 })).toBe("neutral");
  });

  it("an unknown-count guardrail cannot force a regression/revert (fix)", () => {
    // The exact hazard: a well-powered target improved, but an untracked
    // guardrail (count undefined) moved down. It must be skipped as underpowered
    // rather than force `regressed` (which would trigger a revert on no evidence).
    const target = delta({ baseline: 100, post: 50, direction: "lower_is_better", count: 10 });
    const untrackedGuard = delta({
      metric: "g",
      baseline: 1.0,
      post: 0.4,
      direction: "higher_is_better",
    }); // no count → underpowered
    expect(decideVerdict(target, [untrackedGuard])).toBe("improved");
  });

  it("an underpowered guardrail cannot claim a regression", () => {
    const target = delta({ baseline: 100, post: 50, direction: "lower_is_better", count: 10 });
    const guard = delta({
      metric: "g",
      baseline: 1.0,
      post: 0.4,
      direction: "higher_is_better",
      count: 1,
    });
    expect(decideVerdict(target, [guard], { minSamples: 2 })).toBe("improved");
  });
});
