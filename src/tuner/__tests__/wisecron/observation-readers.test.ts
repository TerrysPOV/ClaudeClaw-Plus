import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBenchmarkProvider } from "../../wisecron/observation-readers.js";
import { ATTRIBUTION } from "../../subjects/model-routing-benchmarks.js";

const NOW = 1_700_000_000_000;

// A shape-accurate Artificial Analysis /models/free response. The sonnet-5 row
// deliberately omits the coding eval so coding_index parses to null — the gap
// enrichWithAnthropicCoding is supposed to backfill from Anthropic's seed.
function aaResponse() {
  return {
    tier: "free",
    data: [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        evaluations: {
          artificial_analysis_intelligence_index: 71.5,
          // no coding index → null → should be filled to 72.7 by the seed
          artificial_analysis_agentic_index: 60.0,
        },
        pricing: { price_1m_input_tokens: 3, price_1m_output_tokens: 15 },
      },
    ],
  };
}

function mockFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    return { ok, status, json: async () => body };
  };
  return { impl, calls };
}

describe("makeBenchmarkProvider — research-scout feeder wiring", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-provider-"));
    cachePath = join(dir, "cache.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fetches published benchmarks and enriches Claude coding gaps from the Anthropic seed", async () => {
    const { impl, calls } = mockFetch(aaResponse());
    const provider = makeBenchmarkProvider({
      cachePath,
      apiKey: "test-key",
      fetchImpl: impl,
      nowMs: () => NOW,
    });

    const rows = await provider(["claude-sonnet-5"]);

    expect(calls.length).toBe(1);
    const sonnet = rows.find((r) => r.model_id === "claude-sonnet-5");
    expect(sonnet).toBeDefined();
    expect(sonnet?.intelligence_index).toBe(71.5);
    // null coding_index backfilled from ANTHROPIC_SWE_BENCH_VERIFIED
    expect(sonnet?.coding_index).toBe(72.7);
    // enrichment stamps the Anthropic source alongside AA attribution
    expect(sonnet?.source).toContain(ATTRIBUTION);
    expect(sonnet?.source.toLowerCase()).toContain("anthropic");
  });

  it("creates the cache directory and persists the fetched benchmarks", async () => {
    const nested = join(dir, "deep", "nested", "cache.json");
    const { impl } = mockFetch(aaResponse());
    const provider = makeBenchmarkProvider({
      cachePath: nested,
      apiKey: "test-key",
      fetchImpl: impl,
      nowMs: () => NOW,
    });

    await provider(["claude-sonnet-5"]);
    expect(existsSync(nested)).toBe(true);
    const body = JSON.parse(readFileSync(nested, "utf8"));
    expect(body.attribution).toBe(ATTRIBUTION);
    expect(Array.isArray(body.benchmarks)).toBe(true);
  });

  it("serves the second call from cache without re-fetching (cache-first)", async () => {
    const { impl, calls } = mockFetch(aaResponse());
    const provider = makeBenchmarkProvider({
      cachePath,
      apiKey: "test-key",
      fetchImpl: impl,
      nowMs: () => NOW,
    });

    await provider(["claude-sonnet-5"]);
    await provider(["claude-sonnet-5"]);
    expect(calls.length).toBe(1);
  });

  it("is graceful: an empty API key short-circuits to [] rather than throwing or fetching", async () => {
    // apiKey:"" forces the missing-key branch deterministically (fetchModelBenchmarks
    // treats a falsy key as "no key" before any fetch), independent of the ambient
    // ARTIFICIAL_ANALYSIS_API_KEY in the process env.
    const { impl, calls } = mockFetch(aaResponse());
    const provider = makeBenchmarkProvider({
      cachePath,
      apiKey: "",
      fetchImpl: impl,
      nowMs: () => NOW,
    });
    const rows = await provider(["claude-sonnet-5"]);
    expect(rows).toEqual([]);
    expect(calls.length).toBe(0);
  });
});
