# eval-framework-mcp — SPEC

## Problem

Switching the default model for any LLM-call workflow (e.g. `sonnet` → `haiku`, `opus` → `sonnet`, or to a non-Anthropic provider via the upcoming llm-router plugin) is currently flying blind. Operators have no offline mechanism to compare candidate models against task-specific ground truth before committing to a default. The 2026-06-15 billing split makes this acute — the cost incentive to switch defaults is now strong, but switching without measurement risks silent quality regression.

The current ecosystem has no canonical eval framework. Per-project ad-hoc scripts duplicate effort and produce inconsistent metrics.

## W-point reference

W14 — Eval framework. Plugin-shaped per the W-point classification matrix. Background-callable MCP server exposing eval-run tools and persisting historical metrics.

This plugin is **the safety net** for every default-model switch downstream. Without it, the Sonnet-by-default migration recommended in the operator plan is risk-blind.

## Scope

### In

- Eval set discovery from YAML files under `~/agent/evals/<task-id>/<set-id>.yaml`.
- Eval set schema: examples with `input`, `expected_output`, `judge_mode` (exact_set | regex | json_schema | llm_judge | embedding_similarity).
- Tool `run_eval(task_id, model_id, set_id?)` — runs single tier, returns metrics.
- Tool `compare_models(task_id, model_ids[], set_id?)` — runs N tiers side-by-side, returns ranked table.
- Tool `recommend_tier(task_id)` — returns JSON `{ recommended_default_tier, escalation_rule, validated_at }` for downstream plugin-publish.
- Tool `list_runs(task_id?, since?)` — historical run query.
- Tool `get_run_report(run_id)` — full metrics for a specific run.
- Metrics: pass rate (per judge mode), latency p50/p95/p99, cost-per-call (from #68 attribution or LiteLLM-derived), per-model comparison.
- Cascade strategy validation: simulates "cheap → escalate on schema-invalid OR confidence < threshold" and reports effective pass rate + effective cost.
- Regression detection: compare against last run for same (task_id, set_id) — flag pass-rate drop > 3%, p95 latency increase > 30%, cost increase > 10%.
- Hard cost ceiling: `max_cost_usd` arg on run_eval aborts mid-run if hit.

### Out (deferred to follow-up)

- Live A/B traffic shadow-comparison. v1 is offline-only against fixed corpus.
- Cross-provider streaming response comparison. v1 measures completed responses only.
- Eval set generation from production traffic. v1 requires hand-curated sets.
- Cost prediction. v1 measures actual cost from upstream attribution.
- Web UI / dashboard. v1 is MCP tools + markdown report files.

## Architecture

### Layer + pattern

Background daemon + MCP server pattern. Eval runs are async (can take minutes for large sets), kicked off via MCP call, results polled or pushed to audit on completion.

PTY-safe by design — invokes LLMs via direct provider SDKs (Anthropic API, OpenAI, Groq, DeepSeek) initially, migrates to llm-router-mcp (#70) when available. Never spawns claude CLI.

### Dependencies

- Strong: #71 (mcp-multiplexer) merged — for MCP registration and audit bus.
- Soft: #70 (llm-router) — eventual integration point for unified LLM call dispatch. Until then, direct SDK calls.
- Strong: budget-guard-mcp (W16, same sprint) — enforces `max_cost_usd` ceiling. Eval runs would otherwise be the riskiest cost-burner in the stack.

## API surface

### Tools

| Tool | Args | Returns | Idempotency |
|---|---|---|---|
| `run_eval` | `{ task_id, model_id, set_id?, max_cost_usd? }` | `{ run_id, status, metrics: {pass_rate, p50_latency_ms, p95_latency_ms, p99_latency_ms, cost_usd, n_examples} }` | per-pty-only (write) |
| `compare_models` | `{ task_id, model_ids: string[], set_id?, max_cost_usd? }` | `{ run_ids: string[], ranking: Array<{model, pass_rate, p95, cost}>, recommendation: string }` | per-pty-only (write) |
| `recommend_tier` | `{ task_id }` | `{ recommended_default_tier, escalation_rule, validated_at_iso, basis_run_id }` | stateless (read) |
| `list_runs` | `{ task_id?, since_iso?, limit? }` | `Array<{ run_id, task_id, model, started_at, pass_rate, cost_usd }>` | stateless |
| `get_run_report` | `{ run_id }` | `{ run_id, full_metrics, per_example_results, errors }` | stateless |
| `validate_eval_set` | `{ set_path }` | `{ valid, n_examples, judge_modes_used, errors }` | stateless |

### Settings schema

```yaml
mcp.eval-framework:
  enabled: false                                    # opt-in
  evals_root: ~/agent/evals
  database_path: ~/agent/evals/runs.db
  reports_dir: ~/agent/evals/reports
  default_max_cost_usd: 2.00                        # per-run safety cap
  default_judge_model: claude-opus-4-7              # for llm_judge mode
  provider_credentials_env:
    anthropic: ANTHROPIC_API_KEY
    openai: OPENAI_API_KEY
    groq: GROQ_API_KEY
    deepseek: DEEPSEEK_API_KEY
  budget_guard_scope: eval-framework                # link to W16 plugin scope
```

## Integration points

- **MCP servers callés** — llm-router-mcp (#70) once available. Pre-#70: direct provider SDK calls via env-credential lookup.
- **Audit events émis** — `eval_run_started`, `eval_run_completed`, `eval_run_failed`, `eval_run_cost_cap_hit`, `eval_regression_detected`, `eval_recommendation_updated`.
- **Health endpoint** — `{ status, uptime_s, runs_db_size_bytes, eval_sets_discovered, last_run_at_iso, total_runs_30d, total_cost_30d_usd }`.
- **Multiplexer interaction** — `stateful-demux` classification. Per-PTY isolation for in-flight runs (avoid one operator's eval cancelling another's), but persisted results in shared SQLite.
- **LLM router plugin call** — yes when #70 lands. Eval invokes `llm_call(tier, messages, schema?)` with explicit `providerHint` per tier under test. Cost attribution flows back via #68.
- **Budget guard interaction** — eval invokes `check_budget(scope: "eval-framework")` before each LLM call; aborts run if denied. `max_cost_usd` per-run cap layered on top.

## Success criteria

- Functional — `run_eval` against a 50-example set produces metrics within 30s for fast tier, within 3min for premium tier. `recommend_tier` returns JSON consumable by plugin-publish for default-tier decision.
- Performance — eval set with 50 examples completes inside operator-set cost cap (\$2 default). p95 LLM call latency surfaced in report.
- Resilience — interrupted run (SIGKILL mid-set) preserves completed example results in DB; resume-friendly via `run_eval --resume <run_id>`.
- Quality — at least 3 of the 5 judge modes (exact_set, regex, json_schema, llm_judge, embedding_similarity) production-ready in v1. `llm_judge` uses premium tier to avoid circular bias.
- Audit completeness — every example result is logged with input hash, model, latency, cost, judge_verdict. Sufficient for spot-checking and regression-investigation.
- Compliance — full traceable trail of which model decided what on which input. Eval-driven default-tier decisions are auditable in regulated contexts.

## Test matrix

| Test class | Scenarios |
|---|---|
| Unit | judge mode functions (exact_set, regex, json_schema, llm_judge mock, embedding_similarity mock), run_eval state machine, cost ceiling enforcement |
| Schema | YAML eval set parsing, settings validation, malformed example rejection |
| Integration | end-to-end `run_eval` against a mocked provider (faux Anthropic SDK), metrics computation, SQLite persistence |
| Cascade | simulate cheap→escalate path; verify effective pass-rate matches escalation logic; cost accounting splits between tiers |
| Regression detection | second run against same set with degraded mock model → `eval_regression_detected` fires |
| Cost ceiling | run with `max_cost_usd: 0.10` against an expensive mock; verify abort + clean state |
| Budget guard interaction | mock budget_guard denying mid-run → eval aborts cleanly with audit event |
| Crash recovery | SIGKILL mid-set → partial run preserved; `run_eval --resume` picks up from last example |
| Audit | every example result logs without exposing raw model output content if marked sensitive |

## Effort + risk

- **Effort:** medium-large, 2–3 days. SQLite schema + run orchestration + 5 judge modes + cost integration + report rendering. Larger than budget-guard.
- **Risk class:** Medium. Eval results inform default-tier decisions downstream; bad eval logic produces bad defaults. Cost ceiling protects against runaway spend.

## Naming check passed: yes

Generic vocabulary throughout — no personal project names, no operator-identifying strings in default settings or example task IDs.

## PTY compatibility

```yaml
pty_aware: false
llm_call_path: direct-sdk (interim) → llm-router (post-#70)
spawns_claude_cli: never
reads_pty_stdout: never
blocks_event_loop: never
notes: |
  Eval runs are async — orchestrator returns run_id immediately, work happens
  in background task. Provider SDK calls are Promise-based. Migration to
  llm-router-mcp (#70) is a one-line dispatch change once #70 lands; existing
  call shape is preserved.

  Interim direct-SDK mode reads provider credentials from env vars listed in
  settings.mcp.eval-framework.provider_credentials_env. Credentials are never
  logged in audit events.
```
