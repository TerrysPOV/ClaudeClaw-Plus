/**
 * Embedding similarity judge (skeleton): computes cosine similarity between
 * actual output embedding and expected output embedding. Passes if above threshold.
 *
 * Full implementation requires an embedding provider (OpenAI ada-002 or similar).
 * This skeleton provides the cosine math and a pluggable embedding interface.
 */

import { OPENAI_COMPAT_BASE_URLS, openAiEmbeddings } from "../providers.js";

export interface EmbeddingSimilarityConfig {
  threshold: number; // 0.0 - 1.0, default 0.85
  provider?: "openai"; // future: more providers
  apiKey?: string;
  model?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function judgeEmbeddingSimilarity(
  actual: string,
  expected: string | string[],
  config: EmbeddingSimilarityConfig,
): Promise<{ pass: boolean; similarity: number; latency_ms: number; cost_usd: number }> {
  const expectedStr = Array.isArray(expected) ? expected.join(" ") : expected;
  const threshold = config.threshold ?? 0.85;
  const startMs = performance.now();

  // Skeleton: when no provider configured, use simple character overlap as proxy
  if (!config.apiKey || !config.provider) {
    const similarity = simpleOverlap(actual, expectedStr);
    return {
      pass: similarity >= threshold,
      similarity,
      latency_ms: performance.now() - startMs,
      cost_usd: 0,
    };
  }

  // OpenAI embeddings over fetch — no SDK dependency (providers.ts)
  const model = config.model ?? "text-embedding-3-small";
  const response = await openAiEmbeddings({
    baseUrl: OPENAI_COMPAT_BASE_URLS.openai,
    apiKey: config.apiKey,
    model,
    input: [actual, expectedStr],
    fetchImpl: config.fetchImpl,
  });

  const similarity = cosineSimilarity(response.embeddings[0] ?? [], response.embeddings[1] ?? []);
  const latencyMs = performance.now() - startMs;
  // Approximate cost for embedding
  const costUsd = (response.total_tokens * 0.00002) / 1000;

  return { pass: similarity >= threshold, similarity, latency_ms: latencyMs, cost_usd: costUsd };
}

function simpleOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
