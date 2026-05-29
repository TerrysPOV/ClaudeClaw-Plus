/**
 * Embedding similarity judge (skeleton): computes cosine similarity between
 * actual output embedding and expected output embedding. Passes if above threshold.
 *
 * Full implementation requires an embedding provider (OpenAI ada-002 or similar).
 * This skeleton provides the cosine math and a pluggable embedding interface.
 */

export interface EmbeddingSimilarityConfig {
  threshold: number; // 0.0 - 1.0, default 0.85
  provider?: "openai"; // future: more providers
  apiKey?: string;
  model?: string;
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

  // OpenAI embeddings path
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: config.apiKey });
  const model = config.model ?? "text-embedding-3-small";

  const response = await client.embeddings.create({
    model,
    input: [actual, expectedStr],
  });

  const embA = response.data[0].embedding;
  const embB = response.data[1].embedding;
  const similarity = cosineSimilarity(embA, embB);
  const latencyMs = performance.now() - startMs;
  // Approximate cost for embedding
  const totalTokens = (response.usage?.total_tokens ?? 0);
  const costUsd = (totalTokens * 0.00002) / 1000;

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
