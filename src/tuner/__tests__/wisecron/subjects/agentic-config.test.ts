import { describe, it, expect } from "bun:test";
import {
  toAaSlug,
  isRunnableModel,
  readAgenticModes,
  setAgenticModel,
} from "../../../subjects/agentic-config.js";
import type { ModelBenchmark } from "../../../subjects/model-routing-benchmarks.js";

const bm = (id: string): ModelBenchmark => ({
  model_id: id,
  name: id,
  intelligence_index: 1,
  coding_index: 1,
  agentic_index: 1,
  price_in_usd_per_mtok: 1,
  price_out_usd_per_mtok: 1,
  price_cache_hit_usd_per_mtok: null,
  source: "t",
  fetched_at: "t",
});

const SETTINGS = JSON.stringify(
  {
    model: "",
    agentic: {
      enabled: true,
      defaultMode: "implementation",
      modes: [
        { name: "planning", model: "claude-3-5-sonnet", keywords: ["design"] },
        { name: "implementation", model: "sonnet", keywords: ["code"] },
      ],
    },
    other: { keep: true },
  },
  null,
  2,
);

describe("agentic-config — real settings.json reconciliation (#292)", () => {
  it("aliases operator model names to AA slugs, passes unknown through", () => {
    expect(toAaSlug("sonnet")).toBe("claude-sonnet-5");
    expect(toAaSlug("claude-3-5-sonnet")).toBe("claude-35-sonnet");
    expect(toAaSlug("SomeFuture-Model")).toBe("somefuture-model");
  });

  it("constrains candidates to runnable (Claude) models", () => {
    expect(isRunnableModel(bm("claude-sonnet-5"))).toBe(true);
    expect(isRunnableModel(bm("minimax-m3"))).toBe(false);
    expect(isRunnableModel(bm("command-a-plus"))).toBe(false);
  });

  it("reads agentic.modes (list format) and attaches the AA slug", () => {
    expect(readAgenticModes(SETTINGS)).toEqual([
      { mode: "planning", model: "claude-3-5-sonnet", aaSlug: "claude-35-sonnet" },
      { mode: "implementation", model: "sonnet", aaSlug: "claude-sonnet-5" },
    ]);
  });

  it("returns [] gracefully on bad JSON / no agentic / disabled-without-modes", () => {
    expect(readAgenticModes("{not json")).toEqual([]);
    expect(readAgenticModes("{}")).toEqual([]);
    expect(readAgenticModes(JSON.stringify({ agentic: {} }))).toEqual([]);
  });

  it("setAgenticModel changes ONE mode's model, preserving the rest of settings.json", () => {
    const out = setAgenticModel(SETTINGS, "planning", "claude-sonnet-5");
    const parsed = JSON.parse(out);
    expect(parsed.agentic.modes[0].model).toBe("claude-sonnet-5"); // changed
    expect(parsed.agentic.modes[1].model).toBe("sonnet"); // untouched
    expect(parsed.other.keep).toBe(true); // rest intact
    expect(parsed.agentic.modes[0].keywords).toEqual(["design"]); // keywords kept
  });

  it("setAgenticModel is a safe no-op on absent mode / bad JSON", () => {
    expect(setAgenticModel(SETTINGS, "nonexistent", "x")).toBe(SETTINGS);
    expect(setAgenticModel("{bad", "planning", "x")).toBe("{bad");
  });
});
