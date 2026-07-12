import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { load as parseYaml } from "js-yaml";
import { getMcpBridge } from "../mcp-bridge.js";
import { EvalDb } from "./db.js";
import { EvalRunner } from "./eval-runner.js";
import {
  EvalFrameworkSettingsSchema,
  EvalSetSchema,
  RunEvalArgsSchema,
  CompareModelsArgsSchema,
  RunCascadeArgsSchema,
  RecommendTierArgsSchema,
  ListRunsArgsSchema,
  GetRunReportArgsSchema,
  ValidateEvalSetArgsSchema,
  SAFE_ID_RE,
  type EvalFrameworkSettings,
  type EvalSet,
} from "./types.js";

const PLUGIN_ID = "eval-framework";

function resolvePath(raw: string): string {
  return raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
}

export interface EvalFrameworkPluginOpts {
  configOverride?: Partial<EvalFrameworkSettings>;
}

let _singleton: EvalFrameworkPlugin | null = null;

export function _resetEvalFramework(): void {
  _singleton = null;
}

export class EvalFrameworkPlugin {
  private settings: EvalFrameworkSettings;
  private db: EvalDb | null = null;
  private runner: EvalRunner | null = null;
  private startedAt: Date | null = null;
  private started = false;

  constructor(opts: EvalFrameworkPluginOpts = {}) {
    this.settings = EvalFrameworkSettingsSchema.parse(opts.configOverride ?? {});
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.db = new EvalDb(this.settings.database_path);
    this.runner = new EvalRunner({
      db: this.db,
      defaultMaxCostUsd: this.settings.default_max_cost_usd,
      defaultJudgeModel: this.settings.default_judge_model,
      providerCredentials: this.settings.provider_credentials_env,
      budgetGuardScope: this.settings.budget_guard_scope,
      checkBudget: this._getBudgetChecker(),
    });

    this._registerTools();

    this.startedAt = new Date();
    this.started = true;
    _singleton = this;

    getMcpBridge().audit("eval_framework_started", {
      evals_root: this.settings.evals_root,
      db_path: this.settings.database_path,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.db?.close();
    this.db = null;
    this.runner = null;
    getMcpBridge().audit("eval_framework_stopped", {});
  }

  health(): Record<string, unknown> {
    if (!this.started || !this.db) {
      return { status: "stopped" };
    }
    const uptimeMs = Date.now() - (this.startedAt?.getTime() ?? Date.now());
    const evalSets = this._discoverEvalSets();
    return {
      status: "up",
      uptime_s: Math.floor(uptimeMs / 1000),
      runs_db_size_bytes: this.db.getDbSizeBytes(),
      eval_sets_discovered: evalSets.length,
      last_run_at_iso: null, // populated from DB in production
      total_runs_30d: 0,
      total_cost_30d_usd: 0,
    };
  }

  /**
   * Tool table shared by the two hosting paths: in-process registration on
   * the MCP bridge (_registerTools) and the standalone stdio server
   * (server.ts → callTool).
   */
  private _tools(): Array<{
    name: string;
    description: string;
    schema:
      | typeof RunEvalArgsSchema
      | typeof CompareModelsArgsSchema
      | typeof RunCascadeArgsSchema
      | typeof RecommendTierArgsSchema
      | typeof ListRunsArgsSchema
      | typeof GetRunReportArgsSchema
      | typeof ValidateEvalSetArgsSchema;
    handler: (args: unknown) => Promise<unknown>;
  }> {
    return [
      {
        name: "run_eval",
        description: "Run eval set against a model, returns metrics",
        schema: RunEvalArgsSchema,
        handler: async (args: unknown) => {
          const parsed = RunEvalArgsSchema.parse(args);
          const evalSet = this._loadEvalSet(parsed.task_id, parsed.set_id);
          if (!evalSet)
            throw new Error(`Eval set not found: ${parsed.task_id}/${parsed.set_id ?? "default"}`);
          return this.runner?.runEval({
            taskId: parsed.task_id,
            modelId: parsed.model_id,
            setId: parsed.set_id ?? "default",
            evalSet,
            maxCostUsd: parsed.max_cost_usd,
          });
        },
      },
      {
        name: "run_cascade_eval",
        description:
          "Validate a cheap->escalation cascade strategy on an eval set: cheap model first, " +
          "escalate to the premium model when the cheap answer fails its judge. Returns " +
          "effective pass rate + cost split between tiers.",
        schema: RunCascadeArgsSchema,
        handler: async (args: unknown) => {
          const parsed = RunCascadeArgsSchema.parse(args);
          const evalSet = this._loadEvalSet(parsed.task_id, parsed.set_id);
          if (!evalSet)
            throw new Error(`Eval set not found: ${parsed.task_id}/${parsed.set_id ?? "default"}`);
          return this.runner?.runCascadeEval({
            taskId: parsed.task_id,
            setId: parsed.set_id ?? "default",
            evalSet,
            cheapModel: parsed.cheap_model,
            escalationModel: parsed.escalation_model,
            maxCostUsd: parsed.max_cost_usd,
          });
        },
      },
      {
        name: "compare_models",
        description: "Compare multiple models on same eval set",
        schema: CompareModelsArgsSchema,
        handler: async (args: unknown) => {
          const parsed = CompareModelsArgsSchema.parse(args);
          const evalSet = this._loadEvalSet(parsed.task_id, parsed.set_id);
          if (!evalSet)
            throw new Error(`Eval set not found: ${parsed.task_id}/${parsed.set_id ?? "default"}`);

          const maxCostPerModel =
            (parsed.max_cost_usd ?? this.settings.default_max_cost_usd) / parsed.model_ids.length;
          const runResults = await Promise.all(
            parsed.model_ids.map((modelId) =>
              this.runner?.runEval({
                taskId: parsed.task_id,
                modelId,
                setId: parsed.set_id ?? "default",
                evalSet,
                maxCostUsd: maxCostPerModel,
              }),
            ),
          );

          const ranking = runResults
            .map((r, i) => ({
              model: parsed.model_ids[i],
              run_id: r.run_id,
              pass_rate: r.metrics?.pass_rate ?? 0,
              p95: r.metrics?.p95_latency_ms ?? 0,
              cost: r.metrics?.cost_usd ?? 0,
              status: r.status,
            }))
            .sort((a, b) => b.pass_rate - a.pass_rate || a.cost - b.cost);

          const recommendation = ranking[0]
            ? `${ranking[0].model} (pass_rate=${(ranking[0].pass_rate * 100).toFixed(1)}%, cost=$${ranking[0].cost.toFixed(4)})`
            : "no recommendation";

          return {
            run_ids: runResults.map((r) => r.run_id),
            ranking,
            recommendation,
          };
        },
      },
      {
        name: "recommend_tier",
        description: "Get tier recommendation for a task based on historical runs",
        schema: RecommendTierArgsSchema,
        handler: async (args: unknown) => {
          const parsed = RecommendTierArgsSchema.parse(args);
          const rec = this.db?.getRecommendation(parsed.task_id);
          if (!rec) {
            return {
              recommended_default_tier: null,
              escalation_rule: null,
              validated_at_iso: null,
              basis_run_id: null,
            };
          }
          return rec;
        },
      },
      {
        name: "list_runs",
        description: "List historical eval runs with optional filters",
        schema: ListRunsArgsSchema,
        handler: async (args: unknown) => {
          const parsed = ListRunsArgsSchema.parse(args);
          return this.db?.listRuns(parsed.task_id, parsed.since_iso, parsed.limit);
        },
      },
      {
        name: "get_run_report",
        description: "Get full report for a specific run including per-example results",
        schema: GetRunReportArgsSchema,
        handler: async (args: unknown) => {
          const parsed = GetRunReportArgsSchema.parse(args);
          const run = this.db?.getRun(parsed.run_id);
          if (!run) throw new Error(`Run not found: ${parsed.run_id}`);
          const examples = this.db?.getExamplesForRun(parsed.run_id);
          const errors = examples.filter((e) => e.error).map((e) => `${e.example_id}: ${e.error}`);
          return {
            run_id: parsed.run_id,
            full_metrics: run.metrics ?? null,
            per_example_results: examples,
            errors,
          };
        },
      },
      {
        name: "validate_eval_set",
        description: "Validate an eval set YAML file for correctness",
        schema: ValidateEvalSetArgsSchema,
        handler: async (args: unknown) => {
          const parsed = ValidateEvalSetArgsSchema.parse(args);
          // Same class of guard as _loadEvalSet, but realpath-based: this tool
          // reads an ARBITRARY caller-supplied path, and it's agent-invocable —
          // a prompt-injected `/etc/passwd` or `../../…` (or a symlink planted
          // under evals_root) must never be readable through it. realpathSync
          // resolves symlinks BEFORE the containment check, so a link escaping
          // the root fails startsWith even though its literal path is inside.
          const evalsRoot = realpathSync(resolvePath(this.settings.evals_root));
          let resolvedPath: string;
          try {
            resolvedPath = realpathSync(resolve(evalsRoot, resolvePath(parsed.set_path)));
          } catch {
            return { valid: false, n_examples: 0, judge_modes_used: [], errors: ["set not found"] };
          }
          if (!resolvedPath.startsWith(evalsRoot + sep)) {
            return {
              valid: false,
              n_examples: 0,
              judge_modes_used: [],
              errors: [`set_path escapes evals_root (${this.settings.evals_root}) — refused`],
            };
          }
          try {
            const content = readFileSync(resolvedPath, "utf-8");
            const raw = parseYaml(content);
            const result = EvalSetSchema.safeParse(raw);
            if (!result.success) {
              return {
                valid: false,
                n_examples: 0,
                judge_modes_used: [],
                errors: result.error.issues.map((e: { message: string }) => e.message),
              };
            }
            const modes = [...new Set(result.data.examples.map((e) => e.judge_mode))];
            return {
              valid: true,
              n_examples: result.data.examples.length,
              judge_modes_used: modes,
              errors: [],
            };
          } catch (err) {
            return {
              valid: false,
              n_examples: 0,
              judge_modes_used: [],
              errors: [(err as Error).message],
            };
          }
        },
      },
    ];
  }

  private _registerTools(): void {
    const bridge = getMcpBridge();
    for (const tool of this._tools()) {
      bridge.registerPluginTool(PLUGIN_ID, {
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        handler: tool.handler,
      });
    }
  }

  /** Direct dispatch for the standalone stdio server (server.ts). */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this._tools().find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(args);
  }

  /** Tool metadata for the stdio server's list_tools response. */
  toolDescriptors(): Array<{ name: string; description: string }> {
    return this._tools().map((t) => ({ name: t.name, description: t.description }));
  }

  private _getBudgetChecker(): ((scope: string) => Promise<{ allow: boolean }>) | undefined {
    // Integration with budget-guard plugin via MCP bridge channel
    // Returns undefined if budget-guard is not available
    try {
      const bridge = getMcpBridge();
      const channel = (
        bridge as unknown as { runtime?: { channel?: Record<string, Record<string, Function>> } }
      ).runtime?.channel;
      if (channel?.["budget-guard"]?.check_budget) {
        return async (scope: string) => channel["budget-guard"].check_budget({ scope });
      }
    } catch {}
    return undefined;
  }

  private _loadEvalSet(taskId: string, setId?: string): EvalSet | null {
    const targetSetId = setId ?? "default";
    // Defense in depth behind the zod SafeIdSchema at the tool boundary:
    // these ids are joined into a filesystem path, and the eval tools are
    // callable by the agent loop itself — reject anything that isn't a plain
    // identifier, then verify the resolved path stayed under evals_root.
    if (!SAFE_ID_RE.test(taskId) || !SAFE_ID_RE.test(targetSetId)) return null;
    const evalsRoot = resolve(resolvePath(this.settings.evals_root));
    const filePath = resolve(join(evalsRoot, taskId, `${targetSetId}.yaml`));
    if (!filePath.startsWith(evalsRoot + sep)) return null;
    try {
      const content = readFileSync(filePath, "utf-8");
      const raw = parseYaml(content) as Record<string, unknown> | null;
      const parsed = EvalSetSchema.safeParse({ ...raw, task_id: taskId, set_id: targetSetId });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private _discoverEvalSets(): string[] {
    const evalsRoot = resolvePath(this.settings.evals_root);
    const sets: string[] = [];
    try {
      const taskDirs = readdirSync(evalsRoot);
      for (const taskDir of taskDirs) {
        const taskPath = join(evalsRoot, taskDir);
        if (!statSync(taskPath).isDirectory()) continue;
        const files = readdirSync(taskPath).filter(
          (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
        );
        for (const file of files) {
          sets.push(`${taskDir}/${file}`);
        }
      }
    } catch {}
    return sets;
  }
}
