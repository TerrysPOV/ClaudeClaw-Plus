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

  it("uses an explicit model and ignores a bogus tier when both are given (D2)", async () => {
    const h = createLlmRouterHandlers({ config: config(), apiKey: "k", fetchImpl: routingFetch() });
    const r = (await h.llmCall({
      model: "groq/llama",
      tier: "not-a-tier",
      messages: [{ role: "user", content: "hi" }],
    })) as { content: string };
    expect(r.content).toBe("answer");
  });

  it("emits llm_call_fallback_taken when the first tier model fails retriably", async () => {
    const events: string[] = [];
    // First model 429s, second succeeds — keyed off the model in the request body.
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/chat/completions")) {
        const model = JSON.parse(init.body as string).model;
        if (model === "x/down")
          return new Response(JSON.stringify({ error: "rate" }), { status: 429 });
        return new Response(
          JSON.stringify({
            model,
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const h = createLlmRouterHandlers({
      config: config({ tiers: { fast: ["x/down", "x/up"], balanced: [], reasoning: [] } }),
      apiKey: "k",
      fetchImpl,
      audit: (e) => events.push(e),
    });
    const r = (await h.llmCall({ tier: "fast", messages: [{ role: "user", content: "hi" }] })) as {
      model: string;
    };
    expect(r.model).toBe("x/up");
    expect(events).toContain("llm_call_fallback_taken");
  });
});

describe("createLlmRouterHandlers — live-reload via getConfig (#70 Phase C)", () => {
  it("uses the live openRouterBaseUrl from getConfig (Codex P2 on PR #204)", async () => {
    // Regression: when only getConfig was passed, baseUrl fell back to the
    // hardcoded OpenRouter default, so an operator-set proxy URL was ignored.
    let chatUrl = "";
    let modelsUrl = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/chat/completions")) {
        chatUrl = url;
        return new Response(
          JSON.stringify({
            model: "x/y",
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/models")) {
        modelsUrl = url;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const h = createLlmRouterHandlers({
      getConfig: async () => ({
        tiers: { fast: ["x/y"], balanced: [], reasoning: [] },
        openRouterBaseUrl: "https://proxy.example.test/v1",
      }),
      apiKey: "k",
      fetchImpl,
    });
    await h.llmCall({ tier: "fast", messages: [{ role: "user", content: "hi" }] });
    await h.llmModels({});
    expect(chatUrl).toBe("https://proxy.example.test/v1/chat/completions");
    expect(modelsUrl).toBe("https://proxy.example.test/v1/models");
  });

  it("invokes getConfig per llm_call so dashboard tier edits take effect without restart", async () => {
    let configCalls = 0;
    const tierLists: Array<string[]> = [["x/first"], ["x/second"]];
    const getConfig = async () => {
      const fast = tierLists[Math.min(configCalls, tierLists.length - 1)];
      configCalls++;
      return {
        tiers: { fast, balanced: [], reasoning: [] },
        openRouterBaseUrl: "https://or.test/api/v1",
      };
    };
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/chat/completions")) {
        const model = JSON.parse(init.body as string).model;
        seen.push(model);
        return new Response(
          JSON.stringify({
            model,
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    const h = createLlmRouterHandlers({ getConfig, apiKey: "k", fetchImpl });
    await h.llmCall({ tier: "fast", messages: [{ role: "user", content: "1" }] });
    await h.llmCall({ tier: "fast", messages: [{ role: "user", content: "2" }] });
    expect(seen).toEqual(["x/first", "x/second"]); // second call saw the updated tier
    expect(configCalls).toBeGreaterThanOrEqual(2);
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
