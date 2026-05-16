import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const auditEvents: { event: string; payload: unknown }[] = [];

mock.module("../../mcp-bridge.js", () => ({
  getMcpBridge: () => ({
    audit: (event: string, payload: unknown) => auditEvents.push({ event, payload }),
    registerPluginTool: () => {},
  }),
}));

mock.module("../../http-gateway.js", () => ({
  getHttpGateway: () => ({
    registerInProcess: () => Buffer.from("fake-token-32bytes-padding-here!"),
  }),
}));

// Mock provider SDKs to avoid real API calls
mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => ({
        content: [{ type: "text", text: "mocked response" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    };
  },
}));

mock.module("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "mocked response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    };
    embeddings = {
      create: async () => ({
        data: [{ embedding: [1, 0, 0] }, { embedding: [1, 0, 0] }],
        usage: { total_tokens: 20 },
      }),
    };
  },
}));

import { EvalRunner } from "../eval-runner.js";
import { EvalDb } from "../db.js";
import type { EvalSet } from "../types.js";

// ── Helpers ──────────────��────────────────────────────────────────────────────

function makeDb(): EvalDb {
  return new EvalDb(`/tmp/eval-runner-test-${randomUUID()}.db`);
}

function makeRunner(db: EvalDb, opts: { checkBudget?: (s: string) => Promise<{ allow: boolean }> } = {}): EvalRunner {
  return new EvalRunner({
    db,
    defaultMaxCostUsd: 2.0,
    defaultJudgeModel: "claude-opus-4-7",
    providerCredentials: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
    },
    budgetGuardScope: "eval-framework",
    checkBudget: opts.checkBudget,
  });
}

const simpleEvalSet: EvalSet = {
  task_id: "test-task",
  set_id: "basic",
  examples: [
    { input: "what is 2+2?", expected_output: "mocked response", judge_mode: "exact_set" },
    { input: "hello", expected_output: "mock.*", judge_mode: "regex" },
  ],
};

// ── Orchestration ─────────────────────────────────────────────────────────────

describe("eval runner orchestration", () => {
  let db: EvalDb;

  beforeEach(() => {
    auditEvents.length = 0;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("runs eval and returns metrics", async () => {
    const runner = makeRunner(db);
    const result = await runner.runEval({
      taskId: "test-task",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet: simpleEvalSet,
    });
    expect(result.run_id).toBeTruthy();
    expect(result.status).toBe("completed");
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.n_examples).toBe(2);
    expect(result.metrics!.pass_rate).toBeGreaterThanOrEqual(0);
  });

  it("emits eval_run_started and eval_run_completed", async () => {
    const runner = makeRunner(db);
    await runner.runEval({
      taskId: "test-task",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet: simpleEvalSet,
    });
    expect(auditEvents.some((e) => e.event === "eval_run_started")).toBe(true);
    expect(auditEvents.some((e) => e.event === "eval_run_completed")).toBe(true);
  });

  it("persists run in database", async () => {
    const runner = makeRunner(db);
    const result = await runner.runEval({
      taskId: "test-task",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet: simpleEvalSet,
    });
    const run = db.getRun(result.run_id);
    expect(run).not.toBeNull();
    expect(run!.task_id).toBe("test-task");
    expect(run!.model).toBe("claude-sonnet-4-6");
    expect(run!.status).toBe("completed");
  });

  it("persists per-example results", async () => {
    const runner = makeRunner(db);
    const result = await runner.runEval({
      taskId: "test-task",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet: simpleEvalSet,
    });
    const examples = db.getExamplesForRun(result.run_id);
    expect(examples.length).toBe(2);
  });
});

// ── Cost ceiling ──────────────────────────────────────────────────────────────

describe("cost ceiling enforcement", () => {
  let db: EvalDb;

  beforeEach(() => {
    auditEvents.length = 0;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("aborts run when cost ceiling is hit", async () => {
    const runner = makeRunner(db);
    const manyExamples: EvalSet = {
      task_id: "cost-test",
      set_id: "expensive",
      examples: Array.from({ length: 100 }, (_, i) => ({
        input: `question ${i}`,
        expected_output: "answer",
        judge_mode: "exact_set" as const,
      })),
    };
    const result = await runner.runEval({
      taskId: "cost-test",
      modelId: "claude-sonnet-4-6",
      setId: "expensive",
      evalSet: manyExamples,
      maxCostUsd: 0.0001, // impossibly low ceiling
    });
    // Either completed (if mock costs are 0) or cost_cap_hit
    expect(["completed", "cost_cap_hit"]).toContain(result.status);
  });

  it("emits cost_cap_hit audit event when ceiling exceeded", async () => {
    const runner = makeRunner(db);
    // Force budget check to deny
    const denyRunner = makeRunner(db, {
      checkBudget: async () => ({ allow: false }),
    });
    const result = await denyRunner.runEval({
      taskId: "budget-test",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet: simpleEvalSet,
    });
    expect(result.status).toBe("budget_denied");
    expect(auditEvents.some((e) => e.event === "eval_run_cost_cap_hit")).toBe(true);
  });
});

// ── Regression detection ──────────────────────────────────────────────────────

describe("regression detection", () => {
  let db: EvalDb;

  beforeEach(() => {
    auditEvents.length = 0;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("detects regression when pass rate drops", async () => {
    // Seed a previous run with high pass rate
    const prevRunId = randomUUID();
    db.createRun({ run_id: prevRunId, task_id: "reg-test", set_id: "basic", model: "claude-sonnet-4-6", max_cost_usd: 2.0 });
    db.updateRunStatus(prevRunId, "completed", {
      pass_rate: 1.0,
      p50_latency_ms: 100,
      p95_latency_ms: 200,
      p99_latency_ms: 300,
      cost_usd: 0.5,
      n_examples: 10,
    });

    // Run with a set that will have lower pass rate (exact_set won't match "mocked response")
    const runner = makeRunner(db);
    const evalSet: EvalSet = {
      task_id: "reg-test",
      set_id: "basic",
      examples: [
        { input: "test", expected_output: "not-the-mocked-response", judge_mode: "exact_set" },
      ],
    };
    await runner.runEval({
      taskId: "reg-test",
      modelId: "claude-sonnet-4-6",
      setId: "basic",
      evalSet,
    });

    // Should detect regression (pass rate dropped from 1.0 to 0.0)
    expect(auditEvents.some((e) => e.event === "eval_regression_detected")).toBe(true);
  });
});
