/**
 * Tier resolution + ordered fallback core for the LLM router (#70).
 *
 * Kept dispatch-agnostic: `callLlm` takes a `dispatch` function so the routing /
 * fallback logic is unit-tested without network. `server.ts` wires the real
 * OpenRouter dispatch + audit around it.
 */

import {
  type LlmCallParams,
  type LlmCallResult,
  type LlmRouterRuntimeConfig,
  ProviderError,
} from "./types.js";
import type { ChatCompletionResponse } from "./openrouter.js";

/** A bound chat-completion call for one model. */
export type Dispatch = (
  model: string,
  opts: {
    messages: LlmCallParams["messages"];
    schema?: Record<string, unknown>;
    maxTokens?: number;
    providerHint?: string;
  },
) => Promise<ChatCompletionResponse>;

/**
 * Resolve the ordered list of candidate models for a call.
 *   - explicit `model` → just that model (bypasses tiers, SPEC-DELTA D2)
 *   - `tier` → the operator's configured list (errors if empty, D1)
 *   - neither → error
 */
export function resolveModels(params: LlmCallParams, config: LlmRouterRuntimeConfig): string[] {
  if (params.model) return [params.model];
  if (params.tier) {
    const models = config.tiers[params.tier] ?? [];
    if (models.length === 0) {
      throw new Error(
        `tier "${params.tier}" has no models configured — search with the llm_models tool ` +
          `and add ids to settings.llmRouter.tiers.${params.tier}, or pass an explicit "model".`,
      );
    }
    return models;
  }
  throw new Error('llm_call requires either "tier" or "model".');
}

/** Provider slug = the part of an OpenRouter id before the first "/". */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

/**
 * Dispatch a call, falling over to the next candidate model on a retriable
 * provider error (429 / 5xx / network). A non-retriable error (e.g. 400) aborts
 * immediately — retrying a malformed request against another model is pointless.
 */
export async function callLlm(
  params: LlmCallParams,
  config: LlmRouterRuntimeConfig,
  dispatch: Dispatch,
): Promise<LlmCallResult> {
  const candidates = resolveModels(params, config);
  const opts = {
    messages: params.messages,
    schema: params.schema,
    maxTokens: params.maxTokens,
    providerHint: params.providerHint,
  };

  const fallbackFrom: string[] = [];
  let lastErr: unknown;

  for (const model of candidates) {
    try {
      const res = await dispatch(model, opts);
      return {
        content: res.content,
        model: res.model,
        provider: providerOf(res.model),
        usage: res.usage,
        ...(fallbackFrom.length > 0 ? { fallbackFrom } : {}),
        ...(params.schema ? { schemaApplied: res.schemaApplied } : {}),
      };
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderError && !err.retriable) throw err;
      // Retriable (or unknown) — record and try the next candidate.
      fallbackFrom.push(model);
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `all ${candidates.length} candidate model(s) failed (tried: ${fallbackFrom.join(", ")}). Last error: ${detail}`,
  );
}
