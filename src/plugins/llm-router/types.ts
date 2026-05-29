/**
 * Shared types for the LLM router MCP plugin (#70).
 *
 * The router exposes two tools over MCP:
 *   - `llm_call`   — dispatch a chat completion by tier (or explicit model)
 *   - `llm_models` — search the OpenRouter model catalogue
 *
 * See `.planning/llm-router/SPEC.md` + `SPEC-DELTA-2026-05-29.md`.
 */

/** Cost/capability tier. Operator maps each tier to an ordered model list. */
export type Tier = "fast" | "balanced" | "reasoning";

export const TIERS: readonly Tier[] = ["fast", "balanced", "reasoning"];

/** One chat message in the OpenAI-compatible shape OpenRouter accepts. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Arguments to the `llm_call` tool. `tier` and `model` are mutually exclusive;
 *  `model` (any OpenRouter id) wins if both are supplied (SPEC-DELTA D2). */
export interface LlmCallParams {
  tier?: Tier;
  /** Explicit OpenRouter model id — bypasses tier resolution. */
  model?: string;
  messages: ChatMessage[];
  /** JSON schema for structured output — best-effort `response_format` (D5). */
  schema?: Record<string, unknown>;
  /** Reserved: hint a provider preference for OpenRouter routing. */
  providerHint?: string;
  /** Upper bound on output tokens. */
  maxTokens?: number;
}

export interface LlmCallResult {
  content: string;
  /** The model that actually answered (after any fallback). */
  model: string;
  /** Provider slug derived from the model id prefix (e.g. "anthropic"). */
  provider: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Models tried before the one that answered (fallback trail), if any. */
  fallbackFrom?: string[];
  /** False when `schema` was requested but not applied (D5). */
  schemaApplied?: boolean;
}

/** One entry from OpenRouter's `GET /api/v1/models` catalogue (subset we use). */
export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: number; completion: number };
}

export interface LlmModelsParams {
  /** Case-insensitive substring match over id + name. */
  query?: string;
  /** Keep only models whose prompt price (USD/token) is ≤ this. */
  maxPromptPrice?: number;
  /** Keep only models whose context window is ≥ this. */
  minContext?: number;
  /** Cap the number of returned models (default 50). */
  limit?: number;
}

export interface LlmModelsResult {
  models: OpenRouterModel[];
  /** Epoch ms when the catalogue snapshot was fetched. */
  cachedAt: number;
}

/** Non-secret router configuration (the secret `OPENROUTER_API_KEY` is env-only). */
export interface LlmRouterRuntimeConfig {
  /** Ordered model ids per tier. Empty by default (SPEC-DELTA D1). */
  tiers: Record<Tier, string[]>;
  /** OpenRouter API base, default https://openrouter.ai/api/v1. */
  openRouterBaseUrl: string;
  /** Optional local Ollama base (e.g. http://127.0.0.1:11434/v1). */
  ollamaBaseUrl?: string;
}

/** A provider error carrying the HTTP status so the router can decide to fall
 *  over (429 / 5xx) vs. abort (4xx that isn't rate-limit). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly model: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Transient — worth trying the next model in the tier. */
  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
