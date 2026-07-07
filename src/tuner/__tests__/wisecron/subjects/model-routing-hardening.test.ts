import { describe, it, expect } from "bun:test";
import {
  parseArtificialAnalysis,
  type ModelBenchmark,
} from "../../../subjects/model-routing-benchmarks.js";
import {
  evaluateReroute,
  proposeBenchmarkReroute,
  parseModelAssignments,
  setModelInYaml,
} from "../../../subjects/model-routing-quality.js";

const bm = (p: Partial<ModelBenchmark>): ModelBenchmark => ({
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
});

// ─────────────────────────── parser: adversarial ───────────────────────────
describe("HARD parseArtificialAnalysis — hostile / messy input", () => {
  it("survives prototype-pollution keys in the payload", () => {
    const raw = JSON.parse(
      '{"data":[{"slug":"m","__proto__":{"polluted":true},"evaluations":{"artificial_analysis_intelligence_index":5}}]}',
    );
    const rows = parseArtificialAnalysis(raw, "t");
    expect(rows.length).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global pollution
  });

  it("coerces wrong-typed scores/prices to null (string, bool, NaN, Infinity, object)", () => {
    const raw = {
      data: [
        {
          slug: "weird",
          evaluations: { artificial_analysis_intelligence_index: "12.3" }, // string → null
          pricing: {
            price_1m_input_tokens: true, // bool → null
            price_1m_output_tokens: Number.POSITIVE_INFINITY, // → null
          },
        },
      ],
    };
    const r = parseArtificialAnalysis(raw, "t")[0]!;
    expect(r.intelligence_index).toBeNull();
    expect(r.price_in_usd_per_mtok).toBeNull();
    expect(r.price_out_usd_per_mtok).toBeNull();
  });

  it("skips null / non-object / slug-less rows without throwing", () => {
    const raw = { data: [null, 42, "str", {}, { id: 7 }, { slug: "ok" }] };
    const rows = parseArtificialAnalysis(raw, "t");
    expect(rows.map((r) => r.model_id)).toEqual(["ok"]);
  });

  it("handles a large payload (1000 rows) and negative prices pass through as numbers", () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({
      slug: `m${i}`,
      evaluations: { artificial_analysis_intelligence_index: i % 100 },
      pricing: { price_1m_input_tokens: -1, price_1m_output_tokens: 0 },
    }));
    const rows = parseArtificialAnalysis({ data }, "t");
    expect(rows.length).toBe(1000);
    expect(rows[0]!.price_in_usd_per_mtok).toBe(-1); // negative is a real (if odd) number
  });
});

// ─────────────────────── YAML editors: the #306 class ───────────────────────
const MULTI = [
  "modes:",
  "  fast:",
  "    model: claude-sonnet",
  "    keywords:",
  "      - quick",
  "  slow:",
  "    model: claude-opus",
  "  balanced:",
  "    model: claude-haiku",
].join("\n");

describe("HARD setModelInYaml — must never corrupt a sibling mode", () => {
  it("changes ONLY the target mode's model line — every other byte identical", () => {
    const out = setModelInYaml(MULTI, "slow", "gpt-5");
    const inLines = MULTI.split("\n");
    const outLines = out.split("\n");
    expect(outLines.length).toBe(inLines.length);
    const changed = inLines.map((l, i) => (l !== outLines[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed.length).toBe(1); // exactly one line changed
    expect(outLines[changed[0]!]).toContain("gpt-5");
    expect(out).toContain("model: claude-sonnet"); // fast untouched
    expect(out).toContain("model: claude-haiku"); // balanced untouched
  });

  it("a comment indented at exactly modeIndent does NOT prematurely close the block (#307)", () => {
    const cfg = [
      "modes:",
      "  fast:",
      "  # a stray comment at mode indent",
      "    model: sonnet",
    ].join("\n");
    const out = setModelInYaml(cfg, "fast", "haiku");
    expect(out).toContain("model: haiku"); // still found + swapped despite the comment
  });

  it("does not mis-target a mode whose name is a prefix of another (fast vs fastest)", () => {
    const cfg = ["modes:", "  fast:", "    model: a", "  fastest:", "    model: b"].join("\n");
    const out = setModelInYaml(cfg, "fast", "Z");
    expect(out).toContain("model: Z"); // fast changed
    expect(out).toContain("model: b"); // fastest untouched
    expect(out).not.toContain("  fastest:\n    model: Z");
  });

  it("treats a regex-metachar mode name literally", () => {
    const cfg = ["modes:", "  fa.st:", "    model: a", "  faXst:", "    model: b"].join("\n");
    const out = setModelInYaml(cfg, "fa.st", "Z");
    expect(out).toContain("model: Z");
    expect(out).toContain("model: b"); // faXst must NOT match fa.st
  });

  it("preserves quoted model values by replacing the whole value", () => {
    const cfg = ["modes:", "  fast:", '    model: "claude-sonnet"'].join("\n");
    const out = setModelInYaml(cfg, "fast", "haiku");
    expect(out).toContain("model: haiku");
    expect(out).not.toContain("claude-sonnet");
  });

  it("no-ops safely on a mode with no model line / absent mode / empty input", () => {
    expect(setModelInYaml("modes:\n  fast:\n    keywords: [a]\n", "fast", "z")).toContain(
      "keywords: [a]",
    );
    expect(setModelInYaml(MULTI, "nonexistent", "z")).toBe(MULTI);
    expect(setModelInYaml("", "fast", "z")).toBe("");
  });

  it("round-trips: parse(set(cfg)) reflects exactly the one change", () => {
    const out = setModelInYaml(MULTI, "balanced", "grok-4");
    const asg = parseModelAssignments(out);
    expect(asg).toEqual([
      { key: "fast", model: "claude-sonnet" },
      { key: "slow", model: "claude-opus" },
      { key: "balanced", model: "grok-4" },
    ]);
  });
});

describe("HARD parseModelAssignments — messy configs", () => {
  it("ignores a top-level model: not inside any mode", () => {
    const cfg = ["model: orphan", "modes:", "  fast:", "    model: real"].join("\n");
    // the orphan is at col0 with no mode header before it at deeper indent
    const asg = parseModelAssignments(cfg);
    expect(asg).toEqual([{ key: "fast", model: "real" }]);
  });

  it("handles CRLF line endings", () => {
    const cfg = ["modes:", "  fast:", "    model: sonnet"].join("\r\n");
    const asg = parseModelAssignments(cfg);
    expect(asg.length).toBe(1);
    expect(asg[0]!.model).toBe("sonnet");
  });
});

// ─────────────────────── quality gate: boundaries ───────────────────────
describe("HARD evaluateReroute — exact boundaries + degenerate numbers", () => {
  it("quality delta EXACTLY at -tolerance is allowed (not vetoed)", () => {
    const cur = bm({ intelligence_index: 60 });
    const cand = bm({
      intelligence_index: 57,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 1,
    });
    const v = evaluateReroute(cur, cand, { qualityTolerance: 3 }); // delta = -3 == -tol
    expect(v.code).not.toBe("quality_regression");
    expect(v.propose).toBe(true);
  });

  it("just past tolerance (-tol - ε) IS vetoed", () => {
    const cur = bm({ intelligence_index: 60 });
    const cand = bm({
      intelligence_index: 56.9,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 1,
    });
    const v = evaluateReroute(cur, cand, { qualityTolerance: 3 });
    expect(v.code).toBe("quality_regression");
  });

  it("savings EXACTLY at the floor does not propose (strict >)", () => {
    const cur = bm({ intelligence_index: 60, price_in_usd_per_mtok: 2, price_out_usd_per_mtok: 2 });
    const cand = bm({
      intelligence_index: 60,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 1,
    });
    // blended saving = 1.0 exactly
    const v = evaluateReroute(cur, cand, { minSavingsUsdPerMtok: 1 });
    expect(v.propose).toBe(false);
    expect(v.code).toBe("not_cheaper");
  });

  it("identical model (same IQ, same price) → not_cheaper, never proposes", () => {
    const m = bm({ intelligence_index: 50 });
    expect(evaluateReroute(m, m).propose).toBe(false);
  });

  it("zero-priced candidate still gated on quality (free but worse = vetoed)", () => {
    const cur = bm({ intelligence_index: 60 });
    const cand = bm({
      intelligence_index: 40,
      price_in_usd_per_mtok: 0,
      price_out_usd_per_mtok: 0,
    });
    expect(evaluateReroute(cur, cand).code).toBe("quality_regression");
  });
});

describe("HARD proposeBenchmarkReroute — scale + ties + all-vetoed", () => {
  it("with 200 candidates picks the max-savings quality-safe one, deterministically", () => {
    const cands = Array.from({ length: 200 }, (_, i) =>
      bm({
        model_id: `c${i}`,
        intelligence_index: 60 + (i % 5), // all >= current, quality-safe
        price_in_usd_per_mtok: 10 - i * 0.01, // cheaper as i grows
        price_out_usd_per_mtok: 10 - i * 0.01,
      }),
    );
    const cur = bm({
      model_id: "cur",
      intelligence_index: 60,
      price_in_usd_per_mtok: 10,
      price_out_usd_per_mtok: 10,
    });
    const props = proposeBenchmarkReroute([{ key: "k", model: "cur" }], [cur, ...cands]);
    expect(props.length).toBe(1);
    expect(props[0]!.to_model).toBe("c199"); // cheapest quality-safe
  });

  it("returns [] when every candidate regresses quality (strict veto holds at scale)", () => {
    const cur = bm({ model_id: "top", intelligence_index: 99 });
    const cands = Array.from({ length: 50 }, (_, i) =>
      bm({
        model_id: `c${i}`,
        intelligence_index: i,
        price_in_usd_per_mtok: 0.1,
        price_out_usd_per_mtok: 0.1,
      }),
    );
    expect(proposeBenchmarkReroute([{ key: "k", model: "top" }], [cur, ...cands])).toEqual([]);
  });
});

describe("HARD gate corrections found by the Greg test (#292)", () => {
  it("qualityMetric='coding' can REJECT what 'intelligence' would accept (the Greg trap)", () => {
    // command-a-plus: higher general IQ, LOWER coding, than the current model.
    const cur = bm({
      intelligence_index: 9.9,
      coding_index: 30.2,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const cand = bm({
      intelligence_index: 22.5,
      coding_index: 27.8,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 5,
    });
    // general index → looks like a win
    expect(evaluateReroute(cur, cand, { qualityMetric: "intelligence" }).propose).toBe(true);
    // coding index → correctly VETOED (candidate is worse at code)
    const coded = evaluateReroute(cur, cand, { qualityMetric: "coding" });
    expect(coded.propose).toBe(false);
    expect(coded.code).toBe("quality_regression");
  });

  it("gates on coding and prefers the real coding leader (sonnet-5 over command-a-plus)", () => {
    const cur = bm({
      model_id: "old-sonnet",
      intelligence_index: 9.9,
      coding_index: 30.2,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const commandA = bm({
      model_id: "command-a-plus",
      intelligence_index: 22.5,
      coding_index: 27.8,
      price_in_usd_per_mtok: 0,
      price_out_usd_per_mtok: 0,
    });
    const sonnet5 = bm({
      model_id: "sonnet-5",
      intelligence_index: 53.4,
      coding_index: 71.5,
      price_in_usd_per_mtok: 2,
      price_out_usd_per_mtok: 10,
    });
    const props = proposeBenchmarkReroute(
      [{ key: "greg", model: "old-sonnet" }],
      [cur, commandA, sonnet5],
      { qualityMetric: "coding" },
    );
    expect(props.length).toBe(1);
    expect(props[0]!.to_model).toBe("sonnet-5"); // NOT command-a-plus
  });

  it("a $0/$0 (missing-pricing) candidate never yields a bogus cost win", () => {
    const cur = bm({
      intelligence_index: 50,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const freebie = bm({
      intelligence_index: 55,
      price_in_usd_per_mtok: 0,
      price_out_usd_per_mtok: 0,
    });
    const v = evaluateReroute(cur, freebie); // quality safe, but pricing is 0/0
    expect(v.propose).toBe(false);
    expect(v.code).toBe("insufficient_data");
  });

  it("quality veto still fires on a $0 candidate that is WORSE (veto before pricing)", () => {
    const cur = bm({
      intelligence_index: 60,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const worse = bm({
      intelligence_index: 40,
      price_in_usd_per_mtok: 0,
      price_out_usd_per_mtok: 0,
    });
    expect(evaluateReroute(cur, worse).code).toBe("quality_regression");
  });

  it("negative prices are treated as missing (not a giant saving)", () => {
    const cur = bm({
      intelligence_index: 50,
      price_in_usd_per_mtok: 3,
      price_out_usd_per_mtok: 15,
    });
    const neg = bm({
      intelligence_index: 55,
      price_in_usd_per_mtok: -1,
      price_out_usd_per_mtok: -1,
    });
    expect(evaluateReroute(cur, neg).code).toBe("insufficient_data");
  });
});

import { enrichWithAnthropicCoding } from "../../../subjects/anthropic-benchmarks.js";

describe("HARD metric fallback (A) + Anthropic enrichment (B) — the opus-null fix", () => {
  it("A: falls back to the intelligence composite when coding is null for a model", () => {
    // opus has intelligence but NO coding (AA gap); candidate has both.
    const opus = bm({ intelligence_index: 42.7, coding_index: null });
    const cand = bm({
      intelligence_index: 53.4,
      coding_index: 71.5,
      price_in_usd_per_mtok: 1,
      price_out_usd_per_mtok: 5,
    });
    // coding requested, but opus lacks it → fallback to intelligence for BOTH → 42.7 vs 53.4 = win
    const v = evaluateReroute(opus, cand, { qualityMetric: "coding" });
    expect(v.propose).toBe(true);
    expect(v.quality_delta).toBeCloseTo(53.4 - 42.7, 5); // compared on intelligence, not coding
  });

  it("A: metricFallback:false keeps the strict coding gate (opus → insufficient_data)", () => {
    const opus = bm({ intelligence_index: 42.7, coding_index: null });
    const cand = bm({ intelligence_index: 53.4, coding_index: 71.5 });
    expect(
      evaluateReroute(opus, cand, { qualityMetric: "coding", metricFallback: false }).code,
    ).toBe("insufficient_data");
  });

  it("B: enrichment fills a null Claude coding_index from the Anthropic table, never overwrites AA", () => {
    const rows = [
      bm({ model_id: "claude-opus-4-7-non-reasoning", coding_index: null }),
      bm({ model_id: "claude-sonnet-5", coding_index: 71.5 }), // AA already has it
      bm({ model_id: "some-other-model", coding_index: null }), // not in table → stays null
    ];
    const out = enrichWithAnthropicCoding(rows);
    expect(out[0]!.coding_index).toBe(82.0); // filled from Anthropic
    expect(out[1]!.coding_index).toBe(71.5); // AA value untouched
    expect(out[2]!.coding_index).toBeNull(); // unknown → left null (fallback A covers it)
  });
});
