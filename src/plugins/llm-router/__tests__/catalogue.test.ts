/**
 * Catalogue search/filter + cache tests (#70).
 */
import { describe, it, expect } from "bun:test";
import { filterModels, ModelCatalogue } from "../catalogue";
import type { OpenRouterModel } from "../types";

const MODELS: OpenRouterModel[] = [
  {
    id: "anthropic/claude-opus",
    name: "Claude Opus",
    context_length: 200000,
    pricing: { prompt: 0.000015, completion: 0.000075 },
  },
  {
    id: "anthropic/claude-haiku",
    name: "Claude Haiku",
    context_length: 200000,
    pricing: { prompt: 0.0000008, completion: 0.000004 },
  },
  {
    id: "groq/llama-3",
    name: "Llama 3",
    context_length: 8192,
    pricing: { prompt: 0.0000001, completion: 0.0000001 },
  },
  {
    id: "deepseek/chat",
    name: "DeepSeek Chat",
    context_length: 64000,
    pricing: { prompt: 0.0000002, completion: 0.0000002 },
  },
];

describe("filterModels", () => {
  it("substring-matches query over id + name (case-insensitive)", () => {
    const r = filterModels(MODELS, { query: "claude" });
    expect(r.map((m) => m.id).sort()).toEqual(["anthropic/claude-haiku", "anthropic/claude-opus"]);
  });

  it("sorts by ascending prompt price (cheapest first)", () => {
    const r = filterModels(MODELS, {});
    expect(r[0].id).toBe("groq/llama-3");
    expect(r[r.length - 1].id).toBe("anthropic/claude-opus");
  });

  it("applies maxPromptPrice", () => {
    const r = filterModels(MODELS, { maxPromptPrice: 0.0000005 });
    expect(r.map((m) => m.id).sort()).toEqual(["deepseek/chat", "groq/llama-3"]);
  });

  it("applies minContext", () => {
    const r = filterModels(MODELS, { minContext: 100000 });
    expect(r.every((m) => m.context_length >= 100000)).toBe(true);
    expect(r).toHaveLength(2);
  });

  it("caps to limit", () => {
    expect(filterModels(MODELS, { limit: 2 })).toHaveLength(2);
  });
});

describe("ModelCatalogue cache", () => {
  it("fetches once and serves subsequent searches from cache within TTL", async () => {
    let fetchCount = 0;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: MODELS.map((m) => ({
            ...m,
            pricing: { prompt: String(m.pricing.prompt), completion: String(m.pricing.completion) },
          })),
        }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
    const reqCounter = (async (...args: Parameters<typeof fetch>) => {
      fetchCount++;
      return fetchImpl(...args);
    }) as unknown as typeof fetch;

    let clock = 1000;
    const cat = new ModelCatalogue(
      { apiKey: "k", baseUrl: "https://x/api/v1", fetchImpl: reqCounter },
      10_000,
      () => clock,
    );

    await cat.search({ query: "claude" });
    await cat.search({ query: "groq" });
    expect(fetchCount).toBe(1); // second search hit the cache

    clock += 20_000; // past TTL
    await cat.search({});
    expect(fetchCount).toBe(2); // refreshed
  });
});
