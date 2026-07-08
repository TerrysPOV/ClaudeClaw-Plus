import { z } from "zod";

// ── Path-safe identifiers ─────────────────────────────────────────────────────
// task_id/set_id are joined into filesystem paths under evals_root, and the
// eval tools are invocable by the agent loop itself — so a prompt-injected
// "../../../etc" must be rejected at the schema boundary. Mirrors the
// allowlist approach of mcp-bridge._validatePluginId.

export const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export const SafeIdSchema = z
  .string()
  .regex(SAFE_ID_RE, "must be a plain identifier: [a-zA-Z0-9_-], max 64 chars, no path separators");

// ── Judge modes ───────────────────────────────────────────────────────────────

export const JudgeModeSchema = z.enum([
  "exact_set",
  "regex",
  "json_schema",
  "llm_judge",
  "embedding_similarity",
]);
export type JudgeMode = z.infer<typeof JudgeModeSchema>;

// ── Eval example ──────────────────────────────────────────────────────────────

export const EvalExampleSchema = z.object({
  id: z.string().optional(),
  input: z.string(),
  expected_output: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]),
  judge_mode: JudgeModeSchema,
  judge_config: z.record(z.string(), z.unknown()).optional(),
  sensitive: z.boolean().optional(),
});
export type EvalExample = z.infer<typeof EvalExampleSchema>;

// ── Eval set ──────────────────────────────────────────────────────────────────

export const EvalSetSchema = z.object({
  task_id: z.string(),
  set_id: z.string(),
  description: z.string().optional(),
  examples: z.array(EvalExampleSchema).min(1),
});
export type EvalSet = z.infer<typeof EvalSetSchema>;

// ── Plugin settings ───────────────────────────────────────────────────────────

export const ProviderCredentialsEnvSchema = z.record(z.string(), z.string()).default({
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
});

export const EvalFrameworkSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  evals_root: z.string().default("~/agent/evals"),
  database_path: z.string().default("~/agent/evals/runs.db"),
  reports_dir: z.string().default("~/agent/evals/reports"),
  default_max_cost_usd: z.number().nonnegative().default(2.0),
  default_judge_model: z.string().default("claude-opus-4-7"),
  provider_credentials_env: ProviderCredentialsEnvSchema,
  budget_guard_scope: z.string().default("eval-framework"),
});
export type EvalFrameworkSettings = z.infer<typeof EvalFrameworkSettingsSchema>;

// ── Tool args ─────────────────────────────────────────────────────────────────

export const RunEvalArgsSchema = z.object({
  task_id: SafeIdSchema,
  model_id: z.string(),
  set_id: SafeIdSchema.optional(),
  max_cost_usd: z.number().nonnegative().optional(),
});

export const CompareModelsArgsSchema = z.object({
  task_id: SafeIdSchema,
  model_ids: z.array(z.string()).min(1),
  set_id: SafeIdSchema.optional(),
  max_cost_usd: z.number().nonnegative().optional(),
});

export const RunCascadeArgsSchema = z.object({
  task_id: SafeIdSchema,
  cheap_model: z.string(),
  escalation_model: z.string(),
  set_id: SafeIdSchema.optional(),
  max_cost_usd: z.number().nonnegative().optional(),
});

export const RecommendTierArgsSchema = z.object({
  task_id: z.string(),
});

export const ListRunsArgsSchema = z.object({
  task_id: z.string().optional(),
  since_iso: z.string().optional(),
  limit: z.number().int().positive().default(50),
});

export const GetRunReportArgsSchema = z.object({
  run_id: z.string(),
});

export const ValidateEvalSetArgsSchema = z.object({
  set_path: z.string(),
});

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface RunMetrics {
  pass_rate: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  cost_usd: number;
  n_examples: number;
}

export interface ExampleResult {
  example_id: string;
  input_hash: string;
  model: string;
  latency_ms: number;
  cost_usd: number;
  judge_verdict: boolean;
  judge_mode: JudgeMode;
  error?: string;
}

/**
 * Cascade validation (SPEC "cheap → escalate on judge-fail"): per-tier cost
 * split + effective pass rate, so an operator can see whether a cheap default
 * with escalation beats a single-tier strategy on both quality and cost.
 */
export interface CascadeMetrics {
  effective_pass_rate: number;
  cheap_pass_rate: number;
  escalation_rate: number;
  n_examples: number;
  n_escalated: number;
  cost_usd_total: number;
  cost_usd_cheap_tier: number;
  cost_usd_escalation_tier: number;
}

export type RunStatus = "running" | "completed" | "failed" | "cost_cap_hit" | "budget_denied";

export interface RunRecord {
  run_id: string;
  task_id: string;
  set_id: string;
  model: string;
  status: RunStatus;
  started_at: string;
  completed_at?: string;
  metrics?: RunMetrics;
  max_cost_usd: number;
  cost_accumulated: number;
}

export interface RunReport {
  run_id: string;
  full_metrics: RunMetrics | null;
  per_example_results: ExampleResult[];
  errors: string[];
}

export interface Recommendation {
  recommended_default_tier: string;
  escalation_rule: string;
  validated_at_iso: string;
  basis_run_id: string;
}
