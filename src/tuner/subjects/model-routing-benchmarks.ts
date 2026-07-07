/**
 * model-routing-benchmarks — Tier-A quality provenance for the proactive
 * model_routing face (#292, phase 1). Pulls PUBLISHED, objective, cross-provider
 * benchmark + pricing data (Artificial Analysis Intelligence Index) so a routing
 * proposal can be gated on QUALITY — not just local cost — before it ever reaches
 * the own-workload bench (#80). Kept OUT of model-routing-subject.ts to respect
 * the ≤800-line per-subject budget: this is a standalone provider the subject/
 * scout reads, not subject logic.
 *
 * Free API: GET /api/v2/language/models/free, header `x-api-key`, 1000 req/day.
 * Attribution to https://artificialanalysis.ai/ is REQUIRED for any use of the
 * free tier — see ATTRIBUTION. Network + clock are injectable so tests are
 * deterministic and never hit the wire.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const ATTRIBUTION = "https://artificialanalysis.ai/";
const DEFAULT_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
/** Benchmarks move on model releases, not minutes — refresh at most daily. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelBenchmark {
  /** Artificial Analysis slug, e.g. "claude-4-8-opus". */
  model_id: string;
  name: string;
  /** Composite quality index (higher = better). null when AA has no score. */
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  price_in_usd_per_mtok: number | null;
  price_out_usd_per_mtok: number | null;
  price_cache_hit_usd_per_mtok: number | null;
  /** Attribution — always ATTRIBUTION for AA-sourced rows. */
  source: string;
  /** ISO timestamp this row was fetched (for cache TTL + audit). */
  fetched_at: string;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FetchBenchmarksOptions {
  apiKey?: string;
  /** Restrict to these AA slugs (case-insensitive). Omit = all returned. */
  models?: string[];
  fetchImpl?: FetchLike;
  endpoint?: string;
  /** Injected clock (ms). Omit uses a fixed 0 — callers pass a real stamp. */
  nowMs?: number;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/**
 * Parse a raw AA list response (`{ data: [...] }`) into ModelBenchmark[].
 * Defensive: unknown shapes / missing fields degrade to null, never throw.
 */
export function parseArtificialAnalysis(raw: unknown, fetchedAtIso: string): ModelBenchmark[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelBenchmark[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug : typeof r.id === "string" ? r.id : null;
    if (!slug) continue;
    const pricing = (r.pricing ?? {}) as Record<string, unknown>;
    // Intelligence scores live under `evaluations` in the live v2 response
    // (the flat top-level form is kept as a fallback for older snapshots).
    const evals = (r.evaluations ?? {}) as Record<string, unknown>;
    out.push({
      model_id: slug,
      name: typeof r.name === "string" ? r.name : slug,
      intelligence_index: num(
        evals.artificial_analysis_intelligence_index ?? r.artificial_analysis_intelligence_index,
      ),
      coding_index: num(
        evals.artificial_analysis_coding_index ?? r.artificial_analysis_coding_index,
      ),
      agentic_index: num(
        evals.artificial_analysis_agentic_index ?? r.artificial_analysis_agentic_index,
      ),
      price_in_usd_per_mtok: num(pricing.price_1m_input_tokens),
      price_out_usd_per_mtok: num(pricing.price_1m_output_tokens),
      price_cache_hit_usd_per_mtok: num(pricing.price_1m_cache_hit_tokens),
      source: ATTRIBUTION,
      fetched_at: fetchedAtIso,
    });
  }
  return out;
}

/**
 * Fetch published benchmarks from Artificial Analysis. Graceful: returns [] on a
 * missing key, non-200, network error, or malformed body — a benchmark outage
 * must never stall the proactive loop (same contract as the cost signal reader).
 */
export async function fetchModelBenchmarks(
  opts: FetchBenchmarksOptions = {},
): Promise<ModelBenchmark[]> {
  const apiKey = opts.apiKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!apiKey) return [];
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return [];
  const fetchedAt = new Date(opts.nowMs ?? 0).toISOString();
  let rows: ModelBenchmark[] = [];
  try {
    const res = await doFetch(opts.endpoint ?? DEFAULT_ENDPOINT, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return [];
    rows = parseArtificialAnalysis(await res.json(), fetchedAt);
  } catch {
    return [];
  }
  if (opts.models && opts.models.length > 0) {
    const want = new Set(opts.models.map((m) => m.toLowerCase()));
    rows = rows.filter((r) => want.has(r.model_id.toLowerCase()));
  }
  return rows;
}

interface CacheFile {
  fetched_at_ms: number;
  attribution: string;
  benchmarks: ModelBenchmark[];
}

/** Read the on-disk cache if present AND fresh (< ttlMs old). null otherwise. */
export function readBenchmarkCache(
  path: string,
  ttlMs: number,
  nowMs: number,
): ModelBenchmark[] | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (!Array.isArray(parsed.benchmarks)) return null;
    if (typeof parsed.fetched_at_ms !== "number") return null;
    if (nowMs - parsed.fetched_at_ms > ttlMs) return null;
    return parsed.benchmarks;
  } catch {
    return null;
  }
}

export function writeBenchmarkCache(
  path: string,
  benchmarks: ModelBenchmark[],
  nowMs: number,
): void {
  try {
    const body: CacheFile = { fetched_at_ms: nowMs, attribution: ATTRIBUTION, benchmarks };
    writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
  } catch {
    // best-effort cache; a write failure must not break the fetch path.
  }
}

/**
 * Cache-first accessor: return fresh cache when available, else fetch, persist,
 * and return. On a fetch failure with a STALE cache present, prefer the stale
 * cache over nothing (benchmarks age slowly; stale beats empty for the gate).
 */
export async function getModelBenchmarks(
  opts: FetchBenchmarksOptions & { cachePath?: string; ttlMs?: number },
): Promise<ModelBenchmark[]> {
  const nowMs = opts.nowMs ?? 0;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (opts.cachePath) {
    const cached = readBenchmarkCache(opts.cachePath, ttlMs, nowMs);
    if (cached) return applyFilter(cached, opts.models);
  }
  const fresh = await fetchModelBenchmarks(opts);
  if (fresh.length > 0) {
    if (opts.cachePath) writeBenchmarkCache(opts.cachePath, fresh, nowMs);
    return fresh;
  }
  // Fetch yielded nothing — fall back to a stale cache (ignore TTL) if any.
  if (opts.cachePath && existsSync(opts.cachePath)) {
    try {
      const stale = JSON.parse(readFileSync(opts.cachePath, "utf8")) as CacheFile;
      if (Array.isArray(stale.benchmarks)) return applyFilter(stale.benchmarks, opts.models);
    } catch {
      // ignore
    }
  }
  return [];
}

function applyFilter(rows: ModelBenchmark[], models?: string[]): ModelBenchmark[] {
  if (!models || models.length === 0) return rows;
  const want = new Set(models.map((m) => m.toLowerCase()));
  return rows.filter((r) => want.has(r.model_id.toLowerCase()));
}

// Standalone smoke: `bun model-routing-benchmarks.ts [slug ...]`. Needs
// ARTIFICIAL_ANALYSIS_API_KEY in the env; prints the fetched rows as JSON.
if (import.meta.main) {
  const models = process.argv.slice(2);
  const rows = await fetchModelBenchmarks({
    models: models.length ? models : undefined,
    nowMs: Date.now(),
  });
  console.log(
    JSON.stringify({ attribution: ATTRIBUTION, count: rows.length, benchmarks: rows }, null, 2),
  );
}
