import { createHash, randomUUID } from "node:crypto";
import { getMcpBridge } from "../mcp-bridge.js";
import { EvalDb } from "./db.js";
import type { EvalExample, EvalSet, ExampleResult, JudgeMode, RunMetrics, RunStatus } from "./types.js";
import { judgeExactSet } from "./judges/exact-set.js";
import { judgeRegex } from "./judges/regex.js";
import { judgeJsonSchema } from "./judges/json-schema.js";
import { judgeLlm, type LlmJudgeConfig } from "./judges/llm-judge.js";
import { judgeEmbeddingSimilarity, type EmbeddingSimilarityConfig } from "./judges/embedding-similarity.js";

export interface EvalRunnerConfig {
  db: EvalDb;
  defaultMaxCostUsd: number;
  defaultJudgeModel: string;
  providerCredentials: Record<string, string>;
  budgetGuardScope: string;
  checkBudget?: (scope: string) => Promise<{ allow: boolean }>;
}

export interface RunEvalOpts {
  taskId: string;
  modelId: string;
  setId: string;
  evalSet: EvalSet;
  maxCostUsd?: number;
}

export class EvalRunner {
  private config: EvalRunnerConfig;
  private abortControllers = new Map<string, AbortController>();

  constructor(config: EvalRunnerConfig) {
    this.config = config;
  }

  async runEval(opts: RunEvalOpts): Promise<{ run_id: string; status: RunStatus; metrics: RunMetrics | null }> {
    const runId = randomUUID();
    const maxCost = opts.maxCostUsd ?? this.config.defaultMaxCostUsd;
    const bridge = getMcpBridge();
    const ac = new AbortController();
    this.abortControllers.set(runId, ac);

    this.config.db.createRun({
      run_id: runId,
      task_id: opts.taskId,
      set_id: opts.setId,
      model: opts.modelId,
      max_cost_usd: maxCost,
    });

    bridge.audit("eval_run_started", { run_id: runId, task_id: opts.taskId, model: opts.modelId, set_id: opts.setId });

    const results: ExampleResult[] = [];
    let costAccumulated = 0;
    let finalStatus: RunStatus = "completed";

    try {
      for (const example of opts.evalSet.examples) {
        if (ac.signal.aborted) {
          finalStatus = "failed";
          break;
        }

        // Budget guard check before each LLM call
        if (this.config.checkBudget) {
          const budgetResult = await this.config.checkBudget(this.config.budgetGuardScope);
          if (!budgetResult.allow) {
            finalStatus = "budget_denied";
            bridge.audit("eval_run_cost_cap_hit", { run_id: runId, reason: "budget_guard_denied", cost_accumulated: costAccumulated });
            break;
          }
        }

        // Cost ceiling check
        if (costAccumulated >= maxCost) {
          finalStatus = "cost_cap_hit";
          bridge.audit("eval_run_cost_cap_hit", { run_id: runId, reason: "max_cost_exceeded", cost_accumulated: costAccumulated, max_cost_usd: maxCost });
          break;
        }

        const result = await this.evaluateExample(example, opts.modelId, runId);
        results.push(result);
        costAccumulated += result.cost_usd;
        this.config.db.updateRunCost(runId, costAccumulated);
        this.config.db.insertExample({ ...result, run_id: runId });
      }
    } catch (err) {
      finalStatus = "failed";
      bridge.audit("eval_run_failed", { run_id: runId, error: (err as Error).message });
    }

    const metrics = this.computeMetrics(results);
    this.config.db.updateRunStatus(runId, finalStatus, finalStatus === "completed" ? metrics : undefined);

    if (finalStatus === "completed") {
      bridge.audit("eval_run_completed", { run_id: runId, metrics });
      await this.checkRegression(opts.taskId, opts.setId, runId, metrics);
    }

    this.abortControllers.delete(runId);
    return { run_id: runId, status: finalStatus, metrics: finalStatus === "completed" ? metrics : null };
  }

  abortRun(runId: string): void {
    const ac = this.abortControllers.get(runId);
    if (ac) ac.abort();
  }

  private async evaluateExample(example: EvalExample, modelId: string, _runId: string): Promise<ExampleResult> {
    const exampleId = example.id ?? randomUUID();
    const inputHash = createHash("sha256").update(example.input).digest("hex").slice(0, 16);
    const startMs = performance.now();

    // Simulate LLM call for the model under evaluation
    // In production this calls the provider SDK directly
    let actualOutput: string;
    let callCost = 0;

    try {
      const result = await this.callProvider(modelId, example.input);
      actualOutput = result.output;
      callCost = result.cost_usd;
    } catch (err) {
      return {
        example_id: exampleId,
        input_hash: inputHash,
        model: modelId,
        latency_ms: performance.now() - startMs,
        cost_usd: 0,
        judge_verdict: false,
        judge_mode: example.judge_mode,
        error: (err as Error).message,
      };
    }

    // Judge the response
    const judgeResult = await this.judge(example, actualOutput);
    const latencyMs = performance.now() - startMs;

    return {
      example_id: exampleId,
      input_hash: inputHash,
      model: modelId,
      latency_ms: latencyMs,
      cost_usd: callCost + judgeResult.cost_usd,
      judge_verdict: judgeResult.pass,
      judge_mode: example.judge_mode,
    };
  }

  private async callProvider(modelId: string, input: string): Promise<{ output: string; cost_usd: number }> {
    // Determine provider from model ID pattern
    const provider = this.inferProvider(modelId);
    const apiKeyEnv = this.config.providerCredentials[provider];
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

    if (!apiKey) {
      throw new Error(`No API key found for provider "${provider}" (env: ${apiKeyEnv})`);
    }

    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 1024,
        messages: [{ role: "user", content: input }],
      });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      const inTokens = response.usage?.input_tokens ?? 0;
      const outTokens = response.usage?.output_tokens ?? 0;
      const cost = (inTokens * 0.003 + outTokens * 0.015) / 1000;
      return { output: text, cost_usd: cost };
    }

    // OpenAI-compatible providers
    const { default: OpenAI } = await import("openai");
    const baseUrls: Record<string, string | undefined> = {
      openai: undefined,
      groq: "https://api.groq.com/openai/v1",
      deepseek: "https://api.deepseek.com",
    };
    const client = new OpenAI({ apiKey, baseURL: baseUrls[provider] });
    const response = await client.chat.completions.create({
      model: modelId,
      max_tokens: 1024,
      messages: [{ role: "user", content: input }],
    });
    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    const cost = ((usage?.prompt_tokens ?? 0) * 0.005 + (usage?.completion_tokens ?? 0) * 0.015) / 1000;
    return { output: text, cost_usd: cost };
  }

  private inferProvider(modelId: string): string {
    if (modelId.startsWith("claude") || modelId.includes("anthropic")) return "anthropic";
    if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
    if (modelId.startsWith("llama") || modelId.startsWith("mixtral") || modelId.includes("groq")) return "groq";
    if (modelId.startsWith("deepseek")) return "deepseek";
    return "openai"; // default fallback
  }

  private async judge(example: EvalExample, actualOutput: string): Promise<{ pass: boolean; cost_usd: number }> {
    const expected = example.expected_output;

    switch (example.judge_mode) {
      case "exact_set": {
        const expectedVal = typeof expected === "string" ? expected : Array.isArray(expected) ? expected : JSON.stringify(expected);
        return { pass: judgeExactSet(actualOutput, expectedVal as string | string[]), cost_usd: 0 };
      }
      case "regex": {
        const pattern = typeof expected === "string" ? expected : Array.isArray(expected) ? expected : [JSON.stringify(expected)];
        return { pass: judgeRegex(actualOutput, pattern as string | string[]), cost_usd: 0 };
      }
      case "json_schema": {
        const schema = typeof expected === "string" ? expected : expected as Record<string, unknown>;
        return { pass: judgeJsonSchema(actualOutput, schema), cost_usd: 0 };
      }
      case "llm_judge": {
        const provider = "anthropic";
        const apiKeyEnv = this.config.providerCredentials[provider];
        const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
        if (!apiKey) throw new Error("No API key for LLM judge");
        const config: LlmJudgeConfig = {
          model: this.config.defaultJudgeModel,
          apiKey,
          provider,
        };
        const expectedStr = typeof expected === "string" ? expected : Array.isArray(expected) ? expected : [JSON.stringify(expected)];
        const result = await judgeLlm(example.input, actualOutput, expectedStr as string | string[], config);
        return { pass: result.pass, cost_usd: result.cost_usd };
      }
      case "embedding_similarity": {
        const embConfig: EmbeddingSimilarityConfig = {
          threshold: (example.judge_config?.threshold as number) ?? 0.85,
          provider: (example.judge_config?.provider as "openai") ?? undefined,
          apiKey: example.judge_config?.provider ? process.env[this.config.providerCredentials[example.judge_config.provider as string] ?? ""] : undefined,
          model: example.judge_config?.model as string,
        };
        const expectedStr = typeof expected === "string" ? expected : Array.isArray(expected) ? expected.join(" ") : JSON.stringify(expected);
        const result = await judgeEmbeddingSimilarity(actualOutput, expectedStr, embConfig);
        return { pass: result.pass, cost_usd: result.cost_usd };
      }
      default:
        return { pass: false, cost_usd: 0 };
    }
  }

  private computeMetrics(results: ExampleResult[]): RunMetrics {
    if (results.length === 0) {
      return { pass_rate: 0, p50_latency_ms: 0, p95_latency_ms: 0, p99_latency_ms: 0, cost_usd: 0, n_examples: 0 };
    }

    const passed = results.filter((r) => r.judge_verdict).length;
    const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
    const totalCost = results.reduce((sum, r) => sum + r.cost_usd, 0);

    return {
      pass_rate: passed / results.length,
      p50_latency_ms: percentile(latencies, 0.5),
      p95_latency_ms: percentile(latencies, 0.95),
      p99_latency_ms: percentile(latencies, 0.99),
      cost_usd: totalCost,
      n_examples: results.length,
    };
  }

  private async checkRegression(taskId: string, setId: string, currentRunId: string, currentMetrics: RunMetrics): Promise<void> {
    const runs = this.config.db.listRuns(taskId, undefined, 10);
    const previousRun = runs.find((r) => r.run_id !== currentRunId && r.set_id === setId && r.status === "completed");
    if (!previousRun) return;

    const prevRun = this.config.db.getRun(previousRun.run_id);
    if (!prevRun?.metrics) return;

    const prev = prevRun.metrics;
    const passRateDrop = prev.pass_rate - currentMetrics.pass_rate;
    const latencyIncrease = prev.p95_latency_ms > 0 ? (currentMetrics.p95_latency_ms - prev.p95_latency_ms) / prev.p95_latency_ms : 0;
    const costIncrease = prev.cost_usd > 0 ? (currentMetrics.cost_usd - prev.cost_usd) / prev.cost_usd : 0;

    if (passRateDrop > 0.03 || latencyIncrease > 0.3 || costIncrease > 0.1) {
      getMcpBridge().audit("eval_regression_detected", {
        task_id: taskId,
        set_id: setId,
        current_run_id: currentRunId,
        previous_run_id: previousRun.run_id,
        pass_rate_drop: passRateDrop,
        latency_increase_pct: latencyIncrease,
        cost_increase_pct: costIncrease,
      });
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
