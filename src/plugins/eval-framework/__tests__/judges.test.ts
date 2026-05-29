import { describe, it, expect, mock } from "bun:test";

// Mock provider SDKs
mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => ({
        content: [{ type: "text", text: "PASS - output matches criteria" }],
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    };
  },
}));

mock.module("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "PASS - matches" } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
      },
    };
    embeddings = {
      create: async () => ({
        data: [{ embedding: [0.9, 0.1, 0.0] }, { embedding: [0.9, 0.1, 0.0] }],
        usage: { total_tokens: 20 },
      }),
    };
  },
}));

import { judgeExactSet } from "../judges/exact-set.js";
import { judgeRegex } from "../judges/regex.js";
import { judgeJsonSchema } from "../judges/json-schema.js";
import { judgeLlm } from "../judges/llm-judge.js";
import { judgeEmbeddingSimilarity, cosineSimilarity } from "../judges/embedding-similarity.js";

// ── exact_set ─────────────────────────────────────────────────────────────────

describe("judge: exact_set", () => {
  it("passes on exact match (string)", () => {
    expect(judgeExactSet("hello world", "hello world")).toBe(true);
  });

  it("passes when actual matches one of expected array", () => {
    expect(judgeExactSet("b", ["a", "b", "c"])).toBe(true);
  });

  it("fails on no match", () => {
    expect(judgeExactSet("d", ["a", "b", "c"])).toBe(false);
  });

  it("trims whitespace", () => {
    expect(judgeExactSet("  hello  ", "hello")).toBe(true);
  });
});

// ── regex ─────────────────────────────────────────────────────────────────────

describe("judge: regex", () => {
  it("passes on pattern match", () => {
    expect(judgeRegex("hello world 123", "\\d+")).toBe(true);
  });

  it("passes when one of multiple patterns matches", () => {
    expect(judgeRegex("test output", ["^fail", "^test"])).toBe(true);
  });

  it("fails on no match", () => {
    expect(judgeRegex("hello", "^world")).toBe(false);
  });

  it("supports multiline with s flag", () => {
    expect(judgeRegex("line1\nline2", "line1.*line2")).toBe(true);
  });
});

// ── json_schema ───��───────────────────────────────────────────────────────────

describe("judge: json_schema", () => {
  it("passes when output is valid JSON with expected keys", () => {
    const actual = JSON.stringify({ name: "test", value: 42 });
    expect(judgeJsonSchema(actual, { name: "", value: 0 })).toBe(true);
  });

  it("fails on invalid JSON", () => {
    expect(judgeJsonSchema("not json", { key: "" })).toBe(false);
  });

  it("fails when expected keys are missing", () => {
    const actual = JSON.stringify({ name: "test" });
    expect(judgeJsonSchema(actual, { name: "", value: 0 })).toBe(false);
  });

  it("passes with string expected (parsed as JSON)", () => {
    const actual = JSON.stringify({ a: 1 });
    expect(judgeJsonSchema(actual, JSON.stringify({ a: 0 }))).toBe(true);
  });
});

// ── llm_judge ─────���───────────────────────────────────────────────────────────

describe("judge: llm_judge", () => {
  it("passes when LLM responds with PASS", async () => {
    const result = await judgeLlm(
      "input text",
      "actual output",
      "should be correct",
      { model: "claude-opus-4-7", apiKey: "fake-key", provider: "anthropic" },
    );
    expect(result.pass).toBe(true);
    expect(result.latency_ms).toBeGreaterThan(0);
    expect(result.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("works with openai provider", async () => {
    const result = await judgeLlm(
      "input text",
      "actual output",
      "should be correct",
      { model: "gpt-4", apiKey: "fake-key", provider: "openai" },
    );
    expect(result.pass).toBe(true);
  });

  it("works with array expected", async () => {
    const result = await judgeLlm(
      "input",
      "output",
      ["criteria 1", "criteria 2"],
      { model: "claude-opus-4-7", apiKey: "fake-key", provider: "anthropic" },
    );
    expect(typeof result.pass).toBe("boolean");
  });
});

// ── embedding_similarity ──���───────────────────────────────────────────────────

describe("judge: embedding_similarity", () => {
  it("cosine similarity of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("cosine similarity of orthogonal vectors is 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("cosine similarity of empty vectors is 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("passes with simple overlap when no provider configured", async () => {
    const result = await judgeEmbeddingSimilarity(
      "hello world test",
      "hello world test",
      { threshold: 0.5 },
    );
    expect(result.pass).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.5);
    expect(result.cost_usd).toBe(0);
  });

  it("fails when texts are completely different (no overlap)", async () => {
    const result = await judgeEmbeddingSimilarity(
      "alpha beta gamma",
      "one two three",
      { threshold: 0.5 },
    );
    expect(result.pass).toBe(false);
    expect(result.similarity).toBe(0);
  });

  it("works with openai embedding provider", async () => {
    const result = await judgeEmbeddingSimilarity(
      "hello world",
      "hello world",
      { threshold: 0.5, provider: "openai", apiKey: "fake-key" },
    );
    expect(result.pass).toBe(true);
    expect(result.cost_usd).toBeGreaterThanOrEqual(0);
  });
});
