# budget-guard-mcp — SPEC

## Problem

LLM calls fanning out from agents, plugins, and scheduled jobs can drain credit budgets unexpectedly. Without a hard ceiling on daily/weekly spend, a misbehaving plugin or a runaway loop in an eval run can exhaust the operator's Anthropic Agent SDK pool (\$100/\$200/mo on Max plans) or extra-usage API rates in hours, not days. The 2026-06-15 Agent SDK billing split makes this risk material — the new pool is smaller and drains faster.

The current ecosystem has no built-in circuit breaker. Operators discover the drain only when usage stops working or the bill arrives.

## W-point reference

W16 — Budget guard / circuit breaker. Plugin-shaped per the W-point classification matrix. Pure interceptor pattern on the LLM call dispatch path.

## Scope

### In

- Per-scope budget rules (`daily_cap_usd`, `weekly_cap_usd`, `monthly_cap_usd`) declared in settings.
- Pre-flight check on every LLM call: `check_budget(scope) → { allow, remaining_usd, reset_at }`.
- Hard deny when budget exceeded (deny is structured response, not exception).
- Per-scope usage tracking (caller-id, daily / weekly / monthly windows, rolling).
- Audit events on every grant / deny / threshold-crossed (50%, 80%, 95%, 100%).
- Operator query tools: `current_usage(scope)`, `list_scopes()`, `reset_scope(scope)` (admin).
- Threshold warnings broadcast via the bridge audit bus before hard-cap.
- Persistence: SQLite at `~/.config/claudeclaw/budget-guard.db` (survives restart).

### Out (deferred to follow-up)

- Cost prediction before call (estimate token count → predict cost). v1 enforces post-hoc accounting only.
- Cross-tenant aggregation. v1 is single-operator.
- Refund-on-error (partial credit if call fails mid-stream). v1 charges optimistically.
- UI dashboard. v1 is MCP tools + audit log only.

## Architecture

### Layer + pattern

Interceptor plugin in the MCP layer. Sits on the dispatch path between LLM-consumer plugins and the llm-router plugin (#70). When #70 lands: hooks the router's pre-dispatch. Before #70: intercepts any `*_llm_call` MCP tool invocation observable on the bridge audit bus.

PTY-safe by design — pure MCP plugin, no `claude` CLI involvement.

### Dependencies

- Strong: #71 (mcp-multiplexer) merged — needs the bridge audit bus to subscribe to LLM call events.
- Strong: #68 (cost-tracking metrics) for upstream cost-per-call attribution. Until #68 lands, plugin falls back to its own LiteLLM-derived cost table.
- Soft: #70 (llm-router) — cleanest integration point. Plugin works without it via audit bus subscription, but with #70 the pre-dispatch hook is more precise.

## API surface

### Tools

| Tool | Args | Returns | Idempotency |
|---|---|---|---|
| `check_budget` | `{ scope: string }` | `{ allow: boolean, remaining_usd: number, daily_used: number, weekly_used: number, reset_at_iso: string }` | stateless |
| `current_usage` | `{ scope: string, window?: "daily"|"weekly"|"monthly" }` | `{ scope, window, used_usd, cap_usd, calls, last_call_iso }` | stateless |
| `list_scopes` | `{}` | `Array<{ scope, daily_cap_usd, weekly_cap_usd }>` | stateless |
| `reset_scope` | `{ scope: string, window: "daily"|"weekly"|"monthly"|"all" }` | `{ scope, resets: string[] }` | per-pty-only (admin) |
| `record_usage` | `{ scope, cost_usd, model, tokens_in, tokens_out, call_id }` | `{ recorded: true, scope_status }` | per-pty-only (write) |

### Settings schema

```yaml
mcp.budget-guard:
  enabled: false                                  # opt-in
  database_path: ~/.config/claudeclaw/budget-guard.db
  default_warning_thresholds: [0.5, 0.8, 0.95]    # fraction of cap
  scopes:
    - name: default
      daily_cap_usd: 5.00
      weekly_cap_usd: 25.00
      monthly_cap_usd: 80.00
      deny_when_exceeded: true                    # false = warn only
    - name: eval-framework
      daily_cap_usd: 10.00
      weekly_cap_usd: 30.00
      monthly_cap_usd: 100.00
      deny_when_exceeded: true
    - name: scheduled-jobs
      daily_cap_usd: 3.00
      weekly_cap_usd: 15.00
      monthly_cap_usd: 50.00
      deny_when_exceeded: false                   # critical jobs: warn don't deny
```

## Integration points

- **MCP servers callés** — none directly. Plugin is callee, not caller.
- **Audit events émis** — `budget_guard_allowed`, `budget_guard_denied`, `budget_guard_threshold_crossed` (with fraction = 0.5/0.8/0.95/1.0), `budget_guard_scope_reset`, `budget_guard_started`, `budget_guard_stopped`, `budget_guard_crashed`.
- **Health endpoint** — `{ status, uptime_s, db_size_bytes, scope_count, total_calls_24h, total_denied_24h, oldest_record_iso, last_invocation_at }`.
- **Multiplexer interaction** — `stateless` classification (no per-PTY state — usage is per-scope, scopes are operator-defined).
- **LLM router plugin call** — none directly. Subscribes to the router's dispatch events via audit bus when #70 is in place.

## Success criteria

- Functional — when `check_budget` is called with daily-spent = cap, returns `allow: false`. When spent < cap, returns `allow: true` with accurate `remaining_usd`.
- Performance — `check_budget` p95 latency < 10ms (in-process SQLite lookup, ~1KB indexed read).
- Resilience — restart-safe via SQLite persistence. State survives daemon bounce. Atomic writes prevent partial-update corruption.
- Security — `reset_scope` requires a `per-pty-only` capability marker (admin gesture, audit-trailed with caller ptyId).
- Audit completeness — every dispatch-side decision (allow / deny / threshold-cross) generates a structured event. No silent enforcement.
- Compliance — full per-call audit trail with timestamp, scope, cost, model, caller. Sufficient for spend-review and cost-attribution in regulated environments.

## Test matrix

| Test class | Scenarios |
|---|---|
| Unit | check_budget allow/deny edges, current_usage windows (daily / weekly / monthly), list_scopes enumeration, reset_scope semantics |
| Schema | Settings validation (invalid cap shape, missing required, negative caps), arg validation per tool |
| Concurrency | 100 concurrent check_budget calls — no race in counter increment, no double-counted usage |
| Persistence | restart mid-day: usage counter survives, daily window doesn't reset until calendar boundary |
| Threshold events | crossing 0.5/0.8/0.95/1.0 fires exactly once per window (no spam) |
| Audit | denial events never include sensitive caller context (no model output content, no LLM prompts) |
| Security | `reset_scope` rejected when caller bearer lacks admin scope; audit fires on rejection |
| Crash recovery | SIGKILL mid-write → DB integrity preserved (WAL mode), no orphan records |

## Effort + risk

- **Effort:** small-medium, 1–2 days. Pure MCP plugin, in-process SQLite, no subprocess spawning, no HTTP transport of its own.
- **Risk class:** Medium. Decisions affect downstream behaviour (deny-blocks calls). False-deny is operationally annoying but not destructive. False-allow defeats the purpose.

## Naming check passed: yes

Generic vocabulary throughout — no personal project names. Scope names in default settings are pattern-level (`default`, `eval-framework`, `scheduled-jobs`), no operator-identifying strings.

## PTY compatibility

```yaml
pty_aware: false
llm_call_path: none                       # plugin is a callee, never originates LLM calls
spawns_claude_cli: never
reads_pty_stdout: never
blocks_event_loop: never
notes: |
  Plugin operates entirely in the MCP layer. SQLite operations are sync but
  fast (<10ms p95) and run on the bridge dispatch thread. Audit subscriptions
  are async streams. Zero coupling to PTY runtime.
```
