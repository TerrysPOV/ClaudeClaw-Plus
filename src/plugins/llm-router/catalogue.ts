/**
 * OpenRouter model catalogue — cache + search backing the `llm_models` tool (#70,
 * SPEC-DELTA D3). The catalogue rarely changes, so we cache the full list
 * in-process and filter locally; searches never hit the network on a warm cache.
 */

import { listModels, type OpenRouterDeps } from "./openrouter.js";
import type { LlmModelsParams, OpenRouterModel } from "./types.js";

export const DEFAULT_CATALOGUE_TTL_MS = 60 * 60 * 1000; // 1h

const DEFAULT_LIMIT = 50;

/**
 * Pure filter + sort over a catalogue snapshot. Exported for unit testing.
 * Matches `query` (case-insensitive substring over id + name), applies the
 * optional price/context bounds, sorts by ascending prompt price (cheapest
 * first — the common "what's a cheap model for this tier" intent), and caps.
 */
export function filterModels(
  models: readonly OpenRouterModel[],
  params: LlmModelsParams = {},
): OpenRouterModel[] {
  const q = params.query?.trim().toLowerCase();
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT;

  const matched = models.filter((m) => {
    if (q && !`${m.id} ${m.name}`.toLowerCase().includes(q)) return false;
    if (params.maxPromptPrice !== undefined && m.pricing.prompt > params.maxPromptPrice) {
      return false;
    }
    if (params.minContext !== undefined && m.context_length < params.minContext) {
      return false;
    }
    return true;
  });

  matched.sort((a, b) => a.pricing.prompt - b.pricing.prompt || a.id.localeCompare(b.id));
  return matched.slice(0, limit);
}

/**
 * Caching catalogue. `now` is injectable so tests control TTL expiry without
 * touching the wall clock.
 */
export class ModelCatalogue {
  private snapshot: OpenRouterModel[] | null = null;
  private fetchedAt = 0;

  constructor(
    private readonly deps: OpenRouterDeps,
    private readonly ttlMs: number = DEFAULT_CATALOGUE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached models, refreshing if the snapshot is missing or stale. */
  async getAll(): Promise<{ models: OpenRouterModel[]; cachedAt: number }> {
    if (this.snapshot === null || this.now() - this.fetchedAt >= this.ttlMs) {
      this.snapshot = await listModels(this.deps);
      this.fetchedAt = this.now();
    }
    return { models: this.snapshot, cachedAt: this.fetchedAt };
  }

  /** Search the (cached) catalogue. */
  async search(params: LlmModelsParams): Promise<{ models: OpenRouterModel[]; cachedAt: number }> {
    const { models, cachedAt } = await this.getAll();
    return { models: filterModels(models, params), cachedAt };
  }
}
