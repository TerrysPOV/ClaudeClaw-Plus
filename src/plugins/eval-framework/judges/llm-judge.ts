/**
 * LLM judge: uses a premium-tier model to evaluate whether actual output
 * meets the expected criteria. Returns pass/fail based on model verdict.
 *
 * Anthropic goes through @anthropic-ai/sdk (already a repo dependency);
 * OpenAI-compatible providers go through plain fetch (providers.ts) — no
 * `openai` SDK dependency.
 */

import { OPENAI_COMPAT_BASE_URLS, openAiCompatChat } from "../providers.js";

export interface LlmJudgeConfig {
  model: string;
  apiKey: string;
  provider: "anthropic" | "openai" | "groq" | "deepseek";
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface LlmJudgeResult {
  pass: boolean;
  latency_ms: number;
  cost_usd: number;
}

export async function judgeLlm(
  input: string,
  actual: string,
  expected: string | string[],
  config: LlmJudgeConfig,
): Promise<LlmJudgeResult> {
  const expectedStr = Array.isArray(expected) ? expected.join("\n") : expected;
  const startMs = performance.now();

  const systemPrompt = `You are an eval judge. Given the original input, expected output criteria, and actual output, determine if the actual output meets the criteria. Respond with exactly "PASS" or "FAIL" followed by a brief reason.`;

  const userPrompt = `Input: ${input}\n\nExpected criteria: ${expectedStr}\n\nActual output: ${actual}\n\nVerdict:`;

  let responseText: string;
  let costUsd = 0;

  if (config.provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    responseText = response.content[0]?.type === "text" ? response.content[0].text : "";
    // Approximate cost from usage
    const inTokens = response.usage?.input_tokens ?? 0;
    const outTokens = response.usage?.output_tokens ?? 0;
    costUsd = (inTokens * 0.015 + outTokens * 0.075) / 1000;
  } else {
    // openai / groq / deepseek — OpenAI-compatible wire format over fetch
    const response = await openAiCompatChat({
      baseUrl: OPENAI_COMPAT_BASE_URLS[config.provider],
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: 100,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      fetchImpl: config.fetchImpl,
    });
    responseText = response.text;
    costUsd =
      config.provider === "openai"
        ? (response.prompt_tokens * 0.01 + response.completion_tokens * 0.03) / 1000
        : 0.001; // Approximate for groq/deepseek
  }

  const latencyMs = performance.now() - startMs;
  const pass = responseText.trim().toUpperCase().startsWith("PASS");

  return { pass, latency_ms: latencyMs, cost_usd: costUsd };
}
