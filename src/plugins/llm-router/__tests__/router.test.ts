/**
 * Tier resolution + fallback tests for the LLM router (#70).
 */
import { describe, it, expect } from "bun:test";
import { callLlm, resolveModels, providerOf, type Dispatch } from "../router";
import { ProviderError, type LlmRouterRuntimeConfig } from "../types";

const cfg = (over: Partial<LlmRouterRuntimeConfig> = {}): LlmRouterRuntimeConfig => ({
  tiers: { fast: ["groq/llama"], balanced: ["a/b", "c/d"], reasoning: [] },
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  ...over,
});

const okResp = (model: string) => ({
  content: "hi",
  model,
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  schemaApplied: false,
});

describe("resolveModels", () => {
  it("returns the explicit model when provided (bypasses tiers)", () => {
    expect(resolveModels({ model: "x/y", messages: [] }, cfg())).toEqual(["x/y"]);
  });

  it("returns the tier's ordered list", () => {
    expect(resolveModels({ tier: "balanced", messages: [] }, cfg())).toEqual(["a/b", "c/d"]);
  });

  it("throws an actionable error for an empty tier", () => {
    expect(() => resolveModels({ tier: "reasoning", messages: [] }, cfg())).toThrow(
      /no models configured/,
    );
  });

  it("throws when neither tier nor model is given", () => {
    expect(() => resolveModels({ messages: [] }, cfg())).toThrow(/requires either/);
  });
});

describe("providerOf", () => {
  it("takes the id prefix before the slash", () => {
    expect(providerOf("anthropic/claude-opus")).toBe("anthropic");
    expect(providerOf("bare-model")).toBe("bare-model");
  });
});

describe("callLlm fallback", () => {
  it("returns the first model that succeeds", async () => {
    const dispatch: Dispatch = async (model) => okResp(model);
    const r = await callLlm({ tier: "balanced", messages: [] }, cfg(), dispatch);
    expect(r.model).toBe("a/b");
    expect(r.provider).toBe("a");
    expect(r.fallbackFrom).toBeUndefined();
  });

  it("falls over to the next model on a retriable (429) error and records the trail", async () => {
    const dispatch: Dispatch = async (model) => {
      if (model === "a/b") throw new ProviderError("rate limited", 429, model);
      return okResp(model);
    };
    const r = await callLlm({ tier: "balanced", messages: [] }, cfg(), dispatch);
    expect(r.model).toBe("c/d");
    expect(r.fallbackFrom).toEqual(["a/b"]);
  });

  it("aborts immediately on a non-retriable (400) error", async () => {
    let calls = 0;
    const dispatch: Dispatch = async (model) => {
      calls++;
      throw new ProviderError("bad request", 400, model);
    };
    await expect(callLlm({ tier: "balanced", messages: [] }, cfg(), dispatch)).rejects.toThrow(
      /bad request/,
    );
    expect(calls).toBe(1); // did NOT try the second model
  });

  it("throws an aggregate error when all candidates fail retriably", async () => {
    const dispatch: Dispatch = async (model) => {
      throw new ProviderError("server error", 503, model);
    };
    await expect(callLlm({ tier: "balanced", messages: [] }, cfg(), dispatch)).rejects.toThrow(
      /all 2 candidate model\(s\) failed/,
    );
  });

  it("propagates schemaApplied only when a schema was requested", async () => {
    const dispatch: Dispatch = async (model) => ({ ...okResp(model), schemaApplied: true });
    const withSchema = await callLlm(
      { model: "x/y", messages: [], schema: { type: "object" } },
      cfg(),
      dispatch,
    );
    expect(withSchema.schemaApplied).toBe(true);
    const noSchema = await callLlm({ model: "x/y", messages: [] }, cfg(), dispatch);
    expect(noSchema.schemaApplied).toBeUndefined();
  });
});
