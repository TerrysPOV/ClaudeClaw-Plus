# Plugin Review — budget-guard-mcp

Plugin: budget-guard
Reviewed at: 2026-05-16T11:00:00Z
Branch: feat/budget-guard-mcp (e49785e)
Worktree: /home/simon/Projects/ClaudeClaw-Plus

## Phase 1 — Typecheck baseline diff

- Main errors: 0
- Plugin branch errors: 0
- Delta: +0

**Typecheck: PASS**

## Phase 2 — Test pass-rate

- 31 pass / 0 fail across 2 files
- 55 expect() calls
- No regressions on existing suites

**Tests: PASS (31/31)**

## Phase 3 — Security checklist

| Item | Status |
|---|---|
| Token file mode 0600 | PASS — `chmodSync(this.tokenPath, 0o600)` at L283 |
| Bearer not in audit log | PASS — no secret/bearer/token/hex in audit payloads |
| Audit on lifecycle (started, stopped) | PASS — `budget_guard_started`, `budget_guard_stopped` events |
| Audit on deny/allow/threshold | PASS — `budget_guard_denied`, `budget_guard_allowed`, `budget_guard_threshold_crossed` |
| Crash recovery audit | PASS — lifecycle events cover crash scenarios |
| No SSRF / path traversal | PASS — no user-controlled URLs or paths |

**Security: PASS**

## Phase 4 — Code review checklist

| Item | Status |
|---|---|
| Singleton pattern with `_reset` export | PASS — `_resetBudgetGuard()` exported at L301 |
| ESM `.js` extensions consistent | PASS — `from "./db.js"` |
| No `unknown as Y` casts in prod | PASS — none found |
| Dead code / unused imports | PASS |
| Audit events fire AFTER status finalized | PASS |
| Comments explain WHY when non-obvious | PASS |

**Code review: PASS**

## Phase 5 — Performance smoke

N/A — in-process plugin, no HTTP server exposed.

## Phase 6 — Naming-leakage check

```
grep -rnE 'greg|archiviste|mistral.?brain|hubitat.?token|prodesk|simon|nibbler|caroline' src/plugins/budget-guard/
```

Result: clean (zero hits)

**Naming check: PASS**

## Phase 7 — PTY-safety

- SPEC declares `spawns_claude_cli: never`
- Grep for `claude -p` / `spawn.*claude`: zero hits
- Confirmed: no Claude CLI spawn

**PTY-safety: PASS**

## Phase 8 — Pipe+caller bundled

N/A — standalone plugin, no external API/bridge exposed.

## Verdict: APPROVE-WITH-CONDITIONS

### Conditions (must fix before publish)

1. **Weekly/monthly cap enforcement missing (BLOCKER)** — `_checkBudget` only evaluates `daily_cap_usd`. `weekly_cap_usd` and `monthly_cap_usd` are computed but never compared against caps for deny decisions. Operators relying on weekly/monthly ceilings get zero protection. Fix: add weekly/monthly breach checks in `_checkBudget` alongside the daily check, and add tests for weekly/monthly breach scenarios.

2. **Token file TOCTOU on creation (SECURITY)** — `writeFileSync` creates the file with default umask (typically 0644), then `chmodSync` tightens to 0600. Bearer token is briefly world-readable. Fix: pass `{ mode: 0o600 }` to `writeFileSync` so file is created restricted; keep chmod as belt-and-suspenders.

3. **Threshold array sort defensiveness (minor)** — `_fireThresholdEvents` resets `fired` when `fraction < thresholds[0]`, assuming ascending sort. User-supplied unsorted thresholds cause re-firing oddities. Fix: sort defensively on input.

### Non-blocking observations

- `record_usage` always invokes `_checkBudget`, emitting extra `budget_guard_allowed`/`denied` audit per record. Probably intentional — flag for awareness.
- First-start perm-check is dead code (perm check runs against pre-existing file on next `start()`). Move to after `_registerWithGateway`.
- `stop()` never unregisters/invalidates the bearer token — token file remains on disk. Add cleanup on stop.
- `getBudgetGuardPlugin` singleton exported but no consumer in this diff yet (config wiring reads settings but nothing constructs the plugin). Not a regression.

Ready for plugin-publish: no (fix conditions first)
