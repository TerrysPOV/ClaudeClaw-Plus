# Plugin Review — budget-guard-mcp

Plugin: budget-guard
Reviewed at: 2026-05-16T12:15:00Z
Branch: feat/budget-guard-mcp (c9fb6d5)
Worktree: /home/simon/Projects/ClaudeClaw-Plus

## Phase 1 — Typecheck baseline diff

- Main errors: 266
- Plugin branch errors: 266
- Delta: +0

**Typecheck: PASS**

## Phase 2 — Test pass-rate

- 35 pass / 0 fail across 2 files
- 64 expect() calls
- 4 new tests (weekly deny, monthly deny, token mode 0600, threshold sort)
- No regressions on existing 31 tests

**Tests: PASS (35/35)**

## Phase 3 — Security checklist

| Item | Status |
|---|---|
| Token file mode 0600 | PASS — `writeFileSync(..., { mode: 0o600 })` at L297 (atomic, no TOCTOU) |
| Bearer not in audit log | PASS — test asserts no bearer/PtyIdentity in serialized payloads |
| Audit on lifecycle (started, stopped) | PASS — `budget_guard_started`, `budget_guard_stopped` events |
| Audit on deny/allow/threshold | PASS — `budget_guard_denied` (with `window` field), `budget_guard_allowed`, `budget_guard_threshold_crossed` |
| Crash recovery audit | PASS — lifecycle events cover crash scenarios |
| No SSRF / path traversal | PASS — no user-controlled URLs or paths |

**Security: PASS**

## Phase 4 — Code review checklist

| Item | Status |
|---|---|
| Singleton pattern with `_reset` export | PASS — `_resetBudgetGuard()` exported at L303 |
| ESM `.js` extensions consistent | PASS — all relative imports use `.js` |
| No `unknown as Y` casts in prod | PASS — none found |
| Dead code / unused imports | PASS — removed `chmodSync` import after TOCTOU fix |
| Audit events fire AFTER status finalized | PASS |
| Weekly/monthly cap enforcement | PASS — `_checkBudget` checks daily → weekly → monthly caps in order |
| Denial audit includes window field | PASS — `window: "daily"|"weekly"|"monthly"` in `budget_guard_denied` payload |
| Threshold sort defensive | PASS — `.sort((a, b) => a - b)` before iteration |

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

## Conditions from prior review (d9e6f53) — resolution

1. **BLOCKER — Weekly/monthly cap enforcement**: FIXED in c9fb6d5. `_checkBudget` now checks `weekly_cap_usd` and `monthly_cap_usd` after daily. Denial audit includes `window` field. 2 new tests cover weekly + monthly deny scenarios.

2. **SECURITY — Token file TOCTOU**: FIXED in c9fb6d5. `writeFileSync` now passes `{ mode: 0o600 }` directly, eliminating the race window. Unused `chmodSync` import removed. New test asserts file mode == 0o600 immediately after `start()`.

3. **MINOR — Threshold array sort**: FIXED in c9fb6d5. Thresholds defensively sorted with `.sort((a, b) => a - b)` before iteration. New test passes unsorted `[0.95, 0.5, 0.8]` and verifies 0.5 fires at 60% usage.

## Non-blocking observations (carried forward)

- `record_usage` always invokes `_checkBudget`, emitting extra audit per record. Intentional design.
- `remaining_usd` always derived from daily cap even when weekly/monthly is the binding constraint — minor misleading return value. Follow-up candidate.
- `_fireThresholdEvents` only fires on daily ratio — weekly/monthly breaches won't trigger 50/80/95% warnings, only the terminal denial. Follow-up candidate.
- `stop()` never invalidates the bearer token file on disk. Follow-up candidate.

## Verdict: APPROVE

All 3 conditions from prior review addressed. No new blockers or security issues introduced.

Ready for plugin-publish: yes
