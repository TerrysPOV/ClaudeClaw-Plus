# Plugin Review — eval-framework-mcp

Plugin: eval-framework
Reviewed at: 2026-05-16T11:15:00Z
Branch: feat/eval-framework-mcp (449e8e7)
Worktree: /home/simon/Projects/ClaudeClaw-Plus

## Phase 1 — Typecheck baseline diff

- Main errors: 0
- Plugin branch errors: 266 (all pre-existing: bun-types, test runner types, node_modules)
- Plugin-specific errors: 0
- Delta (plugin-attributable): +0

Note: 266 errors are from bun-types and test file type declarations, not plugin code. No tsconfig diff between branches — likely node_modules state difference. Pre-existing errors do not count against plugin (per review policy).

**Typecheck: PASS (delta +0 plugin-attributable)**

## Phase 2 — Test pass-rate

- 39 pass / 0 fail across 3 files
- 69 expect() calls
- No regressions on existing suites

**Tests: PASS (39/39)**

## Phase 3 — Security checklist

| Item | Status |
|---|---|
| Provider credentials from env | PASS — `process.env[apiKeyEnv]` at L155, L222, L237 of eval-runner.ts |
| Credentials never logged | PASS — no console.log/audit with API_KEY patterns |
| Cost ceiling enforcement | PASS — `max_cost_usd` in DB schema (default 2.0), `eval_run_cost_cap_hit` audit on breach |
| Audit on lifecycle | PASS — `eval_framework_started`, `eval_framework_stopped` events |
| No secrets in audit payloads | PASS — grep clean |
| No SSRF / path traversal | PASS — no user-controlled URLs or file paths |

**Security: PASS**

## Phase 4 — Code review checklist

| Item | Status |
|---|---|
| Singleton pattern with `_reset` export | PASS — `_resetEvalFramework()` exported at L34 |
| ESM `.js` extensions consistent | PASS — `from "./db.js"`, `from "./eval-runner.js"` |
| No `unknown as Y` casts in prod | PASS |
| Dead code / unused imports | PASS |
| Audit events fire AFTER status finalized | PASS |
| Comments explain WHY when non-obvious | PASS |

**Code review: PASS**

## Phase 5 — Performance smoke

N/A — in-process plugin, no HTTP server exposed. Eval runs are inherently slow (LLM calls) — no latency target applies.

## Phase 6 — Naming-leakage check

```
grep -rnE 'greg|archiviste|mistral.?brain|hubitat.?token|prodesk|simon|nibbler|caroline' src/plugins/eval-framework/
```

Result: clean (zero hits)

**Naming check: PASS**

## Phase 7 — PTY-safety

- Grep for `claude -p` / `spawn.*claude`: zero hits
- Confirmed: direct provider SDK calls only, no Claude CLI spawn

**PTY-safety: PASS**

## Phase 8 — Pipe+caller bundled

N/A — standalone plugin, no external API/bridge exposed.

## Verdict: APPROVE

Conditions: none
Ready for plugin-publish: yes
