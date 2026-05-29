/**
 * OpenRouter client tests (#70) — mocked fetch, no network.
 */
import { describe, it, expect } from "bun:test";
import { chatCompletion, listModels, type OpenRouterDeps } from "../openrouter";
import { ProviderError } from "../types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const deps = (fetchImpl: typeof fetch): OpenRouterDeps => ({
  apiKey: "test-key",
  baseUrl: "https://openrouter.test/api/v1",
  fetchImpl,
});

describe("chatCompletion", () => {
  it("posts to /chat/completions and maps the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({
        model: "a/b",
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      });
    }) as unknown as typeof fetch;

    const r = await chatCompletion(
      "a/b",
      { messages: [{ role: "user", content: "hi" }] },
      deps(fetchImpl),
    );
    expect(r.content).toBe("hello");
    expect(r.model).toBe("a/b");
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    expect(captured!.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
  });

  it("sends response_format when a schema is supplied", async () => {
    let bodyStr = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodyStr = init.body as string;
      return jsonResponse({ model: "a/b", choices: [{ message: { content: "{}" } }] });
    }) as unknown as typeof fetch;
    const r = await chatCompletion(
      "a/b",
      { messages: [{ role: "user", content: "hi" }], schema: { type: "object" } },
      deps(fetchImpl),
    );
    expect(bodyStr).toContain("response_format");
    expect(bodyStr).toContain("json_schema");
    expect(r.schemaApplied).toBe(true);
  });

  it("throws a retriable ProviderError on 429", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "slow down" }, 429)) as unknown as typeof fetch;
    try {
      await chatCompletion("a/b", { messages: [{ role: "user", content: "hi" }] }, deps(fetchImpl));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(429);
      expect((err as ProviderError).retriable).toBe(true);
    }
  });

  it("throws a non-retriable ProviderError on 400", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "bad" }, 400)) as unknown as typeof fetch;
    try {
      await chatCompletion("a/b", { messages: [{ role: "user", content: "hi" }] }, deps(fetchImpl));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retriable).toBe(false);
    }
  });

  it("maps a network throw to a retriable 503 ProviderError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      await chatCompletion("a/b", { messages: [{ role: "user", content: "hi" }] }, deps(fetchImpl));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(503);
      expect((err as ProviderError).retriable).toBe(true);
    }
  });
});

describe("listModels", () => {
  it("maps string pricing to numbers and skips entries without ids", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: [
          {
            id: "a/b",
            name: "A B",
            context_length: 8000,
            pricing: { prompt: "0.0000015", completion: "0.000006" },
          },
          { name: "no id — skipped", pricing: { prompt: "0", completion: "0" } },
        ],
      })) as unknown as typeof fetch;
    const models = await listModels(deps(fetchImpl));
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "a/b",
      name: "A B",
      context_length: 8000,
      pricing: { prompt: 0.0000015, completion: 0.000006 },
    });
  });

  it("throws ProviderError on a non-2xx catalogue fetch", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "nope" }, 500)) as unknown as typeof fetch;
    await expect(listModels(deps(fetchImpl))).rejects.toBeInstanceOf(ProviderError);
  });
});
