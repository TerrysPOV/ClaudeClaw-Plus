# Migration: `skills-tuner` → `tuner` (wisecron)

Status: **DRAFT / direction-setting.** Answers the consolidation question from #275
("is this the unification of `skills-tuner` + #116 into ONE framework, or a parallel
stack?"). Answer: **ONE stack.** `src/skills-tuner/` is the v1; the wisecron `tuner`
(landing via #286 telemetry + #287 OutcomeLoop) supersedes it. This doc is the map +
the deprecation markers; the code moves land AFTER #286/#287 so nothing breaks.

## Why
`skills-tuner` (v1) and the wisecron `tuner` overlap on purpose during the carve-out.
Keeping both long-term means maintaining two tuner/governance engines. They converge
into one: a single engine behind a single MCP surface, with `skills-tuner` retired.

## What the wisecron `tuner` replaces (v1 → canonical)
| v1 (`skills-tuner/`) | Replaced by (wisecron `tuner/`) | Lands in |
|---|---|---|
| `core/engine.ts` (`Engine` — detect→propose→apply loop) | `tuner/wisecron/outcome-loop.ts` + `proposal-engine.ts` + `apply-pipeline.ts` (detect → **human gate** → apply → **measure fitness** → **auto-revert**) | #287 |
| `adapters/*` (cli/discord/slack/telegram surfaces) | the `tuner__*` MCP gate (`gate-mcp.ts`) + the pending→Telegram notifier/worker (inline approve/skip/reject) | #287 + ops scripts |
| `subjects/skills.ts` (the single "skills" subject) | the 8 wisecron `TunableSubject`s (model_routing, mcp_plugin, memory, hook, prompt_template, agent, cron, claude_md) | #116/#287 |
| ad-hoc measurement | the `telemetry__*` MCP surface (10 streams, one per subject) | #286 |

## What is SHARED (kept, not duplicated)
The wisecron `tuner` reuses these v1 core primitives as-is (they are foundational,
not the v1 engine): `core/{interfaces,types,registry,security,scope,audit-log}`,
`storage/{proposals,refused}`, `git_ops/branches.ts`. After the move they become the
canonical `tuner/core` (re-exported from `skills-tuner/core` for one release for
back-compat), so the tuner no longer depends on a `skills-tuner` slated for removal.

## Staging (no big-bang)
1. **#286** — telemetry surface (measurement IN). *(open, draft)*
2. **#287** — OutcomeLoop + model_routing subject + `tuner__*` gate. *(open, draft, stacked)*
3. **THIS PR (draft)** — the map + `@deprecated` markers on the v1 `Engine`, v1 adapters,
   and the v1 `skills` subject, pointing at their wisecron replacements. No behavior change.
4. **Follow-up (after #286/#287 merge)** — relocate shared core to `tuner/core`
   (re-export from `skills-tuner/core`), repoint the MCP gate from the legacy
   `proposals.jsonl` engine to the wisecron engine, add the remaining subjects, then
   **delete the v1 `Engine`/adapters/skills-subject**.

## Safety posture (for the governance review)
- Every mutation stays behind the **human gate**; proposals are signed + audited
  (tamper-evident chain).
- Apply is revertible **3 ways**: `.bak` (immediate) · `inverse_patch` (auto-revert on
  measured regression) · **git commit** (`[tuner] …` on git-tracked targets → `git revert`).
- Read-only first, mutating surface after — same staging as the app in #285/#275.
