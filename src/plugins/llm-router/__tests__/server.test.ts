/**
 * Server handler tests (#70) — exercise createLlmRouterHandlers without stdio,
 * using an injected fetch that routes by URL.
 */
import { describe, it, expect } from "bun:test";
import { buildRuntimeConfig, createLlmRouterHandlers } from "../server";
import type { LlmRouterRuntimeConfig } from "../types";

const config = (over: Partial<LlmRouterRuntimeConfig> = {}): LlmRouterRuntimeConfig => ({
  tiers: { fast: ["groq/llama"], balanced: [], reasoning: [] },
  openRouterBaseUrl: "https://or.test/api/v1",
  ...over,
});

function routingFetch(): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          model: "groq/llama",
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "groq/llama",
              name: "Llama",
              context_length: 8192,
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("buildRuntimeConfig", () => {
  it("defaults empty tiers + the OpenRouter base when llmRouter is absent", () => {
    const c = buildRuntimeConfig({});
    expect(c.tiers).toEqual({ fast: [], balanced: [], reasoning: [] });
    expect(c.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("createLlmRouterHandlers.llmCall", () => {
  it("dispatches via tier and audits the call", async () => {
    const events: string[] = [];
    const h = createLlmRouterHandlers({
      config: config(),
      apiKey: "k",
      fetchImpl: routingFetch(),
      audit: (e) => events.push(e),
    });
    const r = (await h.llmCall({ tier: "fast", messages: [{ role: "user", content: "hi" }] })) as {
      content: string;
      provider: string;
    };
    expect(r.content).toBe("answer");
    expect(r.provider).toBe("groq");
    expect(events).toContain("llm_call_dispatched");
  });

  it("errors (and audits failure) for an unconfigured tier", async () => {
    const events: string[] = [];
    const h = createLlmRouterHandlers({
      config: config(),
      apiKey: "k",
      fetchImpl: routingFetch(),
      audit: (e) => events.push(e),
    });
    await expect(
      h.llmCall({ tier: "balanced", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/no models configured/);
    expect(events).toContain("llm_call_failed");
  });

  it("throws when OPENROUTER_API_KEY is missing", async () => {
    const h = createLlmRouterHandlers({ config: config(), apiKey: "", fetchImpl: routingFetch() });
    await expect(
      h.llmCall({ tier: "fast", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("rejects a non-array messages payload", async () => {
    const h = createLlmRouterHandlers({ config: config(), apiKey: "k", fetchImpl: routingFetch() });
    await expect(h.llmCall({ tier: "fast", messages: "nope" })).rejects.toThrow(/non-empty array/);
  });
});

describe("createLlmRouterHandlers.llmModels", () => {
  it("searches the catalogue and audits", async () => {
    const events: string[] = [];
    const h = createLlmRouterHandlers({
      config: config(),
      apiKey: "k",
      fetchImpl: routingFetch(),
      audit: (e) => events.push(e),
    });
    const r = (await h.llmModels({ query: "llama" })) as { models: Array<{ id: string }> };
    expect(r.models.map((m) => m.id)).toEqual(["groq/llama"]);
    expect(events).toContain("llm_models_listed");
  });
});
