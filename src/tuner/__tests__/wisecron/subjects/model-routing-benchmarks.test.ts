import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTRIBUTION,
  DEFAULT_TTL_MS,
  parseArtificialAnalysis,
  fetchModelBenchmarks,
  readBenchmarkCache,
  writeBenchmarkCache,
  getModelBenchmarks,
} from "../../../subjects/model-routing-benchmarks.js";

const NOW = 1_700_000_000_000;

// A trimmed but shape-accurate Artificial Analysis /models/free row.
function aaResponse() {
  return {
    tier: "free",
    intelligence_index_version: 4.1,
    data: [
      {
        id: "m1",
        name: "Claude Opus 4.8",
        slug: "claude-4-8-opus",
        evaluations: {
          artificial_analysis_intelligence_index: 71.2,
          artificial_analysis_coding_index: 68.0,
          artificial_analysis_agentic_index: 55.4,
        },
        pricing: {
          price_1m_input_tokens: 15,
          price_1m_output_tokens: 75,
          price_1m_cache_hit_tokens: 1.5,
        },
      },
      {
        name: "No-slug model",
        evaluations: { artificial_analysis_intelligence_index: 40 },
      }, // dropped: no slug/id
      {
        slug: "haiku-cheap",
        name: "Haiku",
        evaluations: { artificial_analysis_intelligence_index: 50 },
        // no pricing, no coding/agentic → null, not throw
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

describe("model-routing-benchmarks — parse", () => {
  it("maps AA rows to ModelBenchmark with correct fields", () => {
    const rows = parseArtificialAnalysis(aaResponse(), new Date(NOW).toISOString());
    expect(rows.length).toBe(2); // no-slug row dropped
    const opus = rows.find((r) => r.model_id === "claude-4-8-opus")!;
    expect(opus.intelligence_index).toBe(71.2);
    expect(opus.coding_index).toBe(68.0);
    expect(opus.price_in_usd_per_mtok).toBe(15);
    expect(opus.price_out_usd_per_mtok).toBe(75);
    expect(opus.price_cache_hit_usd_per_mtok).toBe(1.5);
    expect(opus.source).toBe(ATTRIBUTION);
    expect(opus.fetched_at).toBe(new Date(NOW).toISOString());
  });

  it("degrades missing fields to null without throwing", () => {
    const rows = parseArtificialAnalysis(aaResponse(), "t");
    const haiku = rows.find((r) => r.model_id === "haiku-cheap")!;
    expect(haiku.coding_index).toBeNull();
    expect(haiku.agentic_index).toBeNull();
    expect(haiku.price_in_usd_per_mtok).toBeNull();
    expect(haiku.intelligence_index).toBe(50);
  });

  it("returns [] on a non-array / malformed body", () => {
    expect(parseArtificialAnalysis({}, "t")).toEqual([]);
    expect(parseArtificialAnalysis({ data: "nope" }, "t")).toEqual([]);
    expect(parseArtificialAnalysis(null, "t")).toEqual([]);
  });
});

describe("model-routing-benchmarks — fetch", () => {
  it("sends x-api-key to the free endpoint and parses the result", async () => {
    const { impl, calls } = mockFetch(aaResponse());
    const rows = await fetchModelBenchmarks({ apiKey: "k", fetchImpl: impl, nowMs: NOW });
    expect(rows.length).toBe(2);
    expect(calls[0]?.headers?.["x-api-key"]).toBe("k");
    expect(calls[0]?.url).toContain("/language/models/free");
  });

  it("returns [] with no API key (no call made)", async () => {
    const { impl, calls } = mockFetch(aaResponse());
    const rows = await fetchModelBenchmarks({ fetchImpl: impl });
    expect(rows).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("returns [] on non-200, on a thrown network error, and on malformed JSON", async () => {
    const non200 = mockFetch(aaResponse(), false, 503);
    expect(await fetchModelBenchmarks({ apiKey: "k", fetchImpl: non200.impl })).toEqual([]);

    const thrower = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await fetchModelBenchmarks({ apiKey: "k", fetchImpl: thrower as never })).toEqual([]);

    const badJson = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    expect(await fetchModelBenchmarks({ apiKey: "k", fetchImpl: badJson as never })).toEqual([]);
  });

  it("filters to the requested model slugs (case-insensitive)", async () => {
    const { impl } = mockFetch(aaResponse());
    const rows = await fetchModelBenchmarks({
      apiKey: "k",
      fetchImpl: impl,
      models: ["Claude-4-8-Opus"],
    });
    expect(rows.map((r) => r.model_id)).toEqual(["claude-4-8-opus"]);
  });
});

describe("model-routing-benchmarks — cache", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aa-bench-"));
    cachePath = join(dir, "benchmarks.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns fresh cache and null once past TTL", () => {
    const rows = parseArtificialAnalysis(aaResponse(), "t");
    writeBenchmarkCache(cachePath, rows, NOW);
    expect(readBenchmarkCache(cachePath, DEFAULT_TTL_MS, NOW + 1000)?.length).toBe(2);
    expect(readBenchmarkCache(cachePath, DEFAULT_TTL_MS, NOW + DEFAULT_TTL_MS + 1)).toBeNull();
  });

  it("returns null for a missing or corrupt cache file", () => {
    expect(readBenchmarkCache(join(dir, "nope.json"), DEFAULT_TTL_MS, NOW)).toBeNull();
    writeFileSync(cachePath, "{not json", "utf8");
    expect(readBenchmarkCache(cachePath, DEFAULT_TTL_MS, NOW)).toBeNull();
  });

  it("getModelBenchmarks serves fresh cache without fetching", async () => {
    writeBenchmarkCache(cachePath, parseArtificialAnalysis(aaResponse(), "t"), NOW);
    const { impl, calls } = mockFetch(aaResponse());
    const rows = await getModelBenchmarks({
      apiKey: "k",
      fetchImpl: impl,
      cachePath,
      nowMs: NOW + 1000,
    });
    expect(rows.length).toBe(2);
    expect(calls.length).toBe(0); // cache hit → no network
  });

  it("getModelBenchmarks fetches + persists on a cold/stale cache", async () => {
    const { impl, calls } = mockFetch(aaResponse());
    const rows = await getModelBenchmarks({ apiKey: "k", fetchImpl: impl, cachePath, nowMs: NOW });
    expect(rows.length).toBe(2);
    expect(calls.length).toBe(1);
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(persisted.attribution).toBe(ATTRIBUTION);
    expect(persisted.benchmarks.length).toBe(2);
  });

  it("falls back to STALE cache when a refresh fetch fails", async () => {
    // seed a stale cache (older than TTL)
    writeBenchmarkCache(cachePath, parseArtificialAnalysis(aaResponse(), "t"), NOW);
    const failing = mockFetch(aaResponse(), false, 500);
    const rows = await getModelBenchmarks({
      apiKey: "k",
      fetchImpl: failing.impl,
      cachePath,
      nowMs: NOW + DEFAULT_TTL_MS + 5000, // cache is stale
    });
    // fresh fetch failed → stale beats empty
    expect(rows.length).toBe(2);
  });
});
