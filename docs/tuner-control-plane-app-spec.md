# Tuner Control-Plane App — Consolidated Spec (delta over #285 / #288)

Consolidates: **#285** (control-surface RFC — the framing) + **#288**
(`docs/tuner-implementation-and-telemetry.md` — the AUTHORITATIVE spec for the
core) + **everything that landed in recent PRs** (new surfaces). Goal: a single
app that makes the whole self-improvement + governance system visible and
steerable, behind the human gate.

> ⚠️ **The core is ALREADY specified in #288** — do not reinvent:
> - **§4** telemetry contract `1.2.0` (11 streams + schemas + producers + the
>   **view-manifest** joining proposals→outcomes).
> - **§5** proposal payload (alternatives + tradeoffs + signed audit chain).
> - **§6** gate surface — including the **"discuss path" = inject full proposal
>   context into the agent** (= the discussion page below).
> - **§9** the "what the app renders" table: Health dashboard · Pending
>   decisions · Approve/choose/refuse/**discuss** · Outcomes · Visual git ·
>   Per-subject drill-down.
> - **§10** scheduling (adaptive daily sweep 24h→168h backoff · `mature`
>   keep/auto-revert · weekly cheap-first proactive pass).
>
> **This doc = the DELTA on top of #288/#285**: the surfaces from recent PRs
> not covered by §9 (watchdog/forensics, agent-jobs, eval/bench, kanban), a
> build-fast blueprint borrowed from a battle-tested internal ops dashboard,
> and the **Config** + **Discussion** pages (the latter = #288 §6's discuss
> path extended into a chat page).

---

## 0. Stack decision (reuse a proven blueprint, don't reinvent)

Same stack as a battle-tested internal operations dashboard (18 pages in
production on the same class of data: feeds, automations, alerts, jobs, roles):

- **Frontend**: SvelteKit 5 + Vite + TS. Reusable component library:
  `StatusBadge`, per-entity `*Card`, `DashboardSummaryCard`, `FeedItemCard`,
  **`PermissionGate`** (role-gated mutations).
- **Backend**: FastAPI + SQLite, one router per domain (`/tuner/*`).
- **Auth**: `PermissionGate` + token pattern (see #220/#231 for the httpOnly
  cookie discussion).
- **Live**: WS `tuner.events` (new proposal / apply / revert) — same pattern as
  a live feed.
- **Tauri**: optional desktop wrapper over the same frontend (#285), later
  phase.

---

## 1. Surface INVENTORY (updated with merged PRs)

### Already LIVE (merged) — what the app must read/steer

| Surface | PR | What the app exposes |
|---|---|---|
| **Telemetry `telemetry__*`** (read-only) | #286 | streams + `capabilities`/`query` → Observability panel |
| **skill_access producer** | #289 | one more stream (skill access) |
| **Gate `tuner__*`** (propose/pending/apply/refuse/mature/propose_external) | #287 | Gate queue + Outcomes |
| **OutcomeLoop + model_routing** (reactive) | #287 | outcomes baseline→verdict, auto-revert |
| **mcp_plugin subject** (capability-gap, gated install) | #290 | Subjects panel + gated plugin install |
| **memory subject** (hygiene + proactive) | #291 | Subjects + memory proposals |
| **skills subject** (content patch) | #293 | Subjects + skill patch |
| **Stall watchdog + forensics** | #297/#300 | **NEW Watchdog/Forensics panel** (wedged sessions, kill escalation #298) |
| **Kill escalation governance** | #298 | kill/flagged status per invocation |
| **Bash-exec guard (PreToolUse)** | #302 | **NEW**: active hooks/guards + refusals |
| **Agent-job primitive `dispatch_job`** | #303 | **NEW Agent-jobs panel** (dispatch/status/list/cancel) |
| **Kanban subagent activity** | #299 | Kanban panel (UI exists, integrate) |
| **git-commit in apply** | #287+ | visual git tracking |

### In review (integrate as they merge)

| Surface | PR | Panel |
|---|---|---|
| **model_routing proactive** (benchmark reroute, quality-gated) | #292 | Scouts + reroute proposals + benchmark provenance |
| **eval-framework-mcp** (offline bench: pass-rate/cost/latency, recommend_tier) | #80 | **NEW Bench/Eval panel** (eval sets, runs, recommended tier) |

### Scouts (external research feeders)

Scheduled scout runs (model_routing #292 / mcp_plugin / memory / hook /
prompt_template / agent) + registry refresh (drift `⚠ DRIFT` / `✚ NEW`) feeding
`tuner__propose_external` → Scouts panel (weekly cadence via cron/systemd).

---

## 2. PANELS (the 7 from #285 + 4 new from recent PRs + 3 new asks)

**From #285 (kept):**

1. 🚪 **Human gate queue** — pending proposals (subject, source
   research/telemetry, diff preview, ✅/⏸/❌). ← `tuner__pending`.
2. 🔁 **Outcomes / OutcomeLoop** — baseline→fitness→verdict, observation
   window, auto-revert. ← `outcomes`+`priors`.
3. 📊 **Telemetry observability** — streams, availability/reason, fitness
   curves per subject. ← `telemetry__*`.
4. 🧩 **Subjects** — enabled/risk_tier/last cycle/# proposals. ← `subject_state`.
5. 🔬 **Scouts** — registry freshness, drift report, adversarial-verification
   rejects, source:research. ← registry `_meta`+logs.
6. 🔒 **Audit chain** — tamper-evident log, provenance, verify-chain ✓/✗. ← audit log.
7. 🌳 **Visual git tracking** — `[tuner]` commit timeline, before/after diff,
   blame, revert (3 layers), outcome↔commit link.

**NEW (from recent PRs):**

8. 🐕 **Watchdog / Forensics** — wedged PTY sessions (#297/#300), escalation
   warn→suspend→kill (#298), forensics dump, kill/flagged per invocation. The
   "safety" core of governance.
9. ⚙️ **Agent-jobs** — `dispatch_job`/`job_status`/`list_jobs`/`cancel_job`
   (#303): in-flight jobs per agent, state, results.
10. 🧪 **Bench / Eval** — eval-framework (#80): eval sets, runs (pass-rate +
    p50/95/99 + cost/call), `recommend_tier`, regression vs last run. The
    Tier-B that confirms #292 reroutes.
11. 🗂️ **Kanban** — subagent activity (#299), UI exists, integrate as a native
    panel.

*(A Hooks/Guards panel for #302 fits as a sub-view of Watchdog or Subjects —
PreToolUse refusals.)*

**NEW (operator asks):**

12. ⚙️ **Config** — a "variables" style settings page. Steer: subjects
    (enable/disable, risk_tier), per-subject degradation thresholds, scout
    cadence, reroute `qualityMetric`/tolerance, benchmark API key presence,
    gate auto-merge defaults. Writes to settings + `subject_state`
    (role-gated).
13. 🔌 **MCP traffic** — live + historical view of every MCP tool call
    crossing the gateway, from the hash-chained `mcp.tool_call` audit stream
    (#286): per-server (plugin) call volume, error rate, p50/p95 latency;
    per-tool breakdown; last-N calls table (ts, agent, tool, status,
    duration, error message); "server silent since X" staleness badges.
    Args are never captured by design, so nothing sensitive can leak into
    the UI. This is the operator's first stop for "X ne marche pas" — see
    which server stopped answering before touching anything.

    **Interaction model (filter → drill → investigate):**
    - *Filters* (composable, URL-addressable so a view can be shared/bookmarked):
      server, tool, agent, status (ok/error), time window, free-text search
      over error messages.
    - *Click a call row* → detail sheet: the full audit record (ts, server,
      tool, agent, duration, status, full error text), its hash-chain
      position with a verify-chain ✓/✗ badge, and a "context strip" of the
      N surrounding calls from the same agent — the seconds before and after
      a failure usually tell the story.
    - *Click a server* → server page: volume/error/latency time series,
      per-tool table, proxy/multiplexer registration state, current health.
    - *"Investigate" button* (on a call or a server) → reuses #288 §6's
      discuss path: injects the selected record + surrounding context +
      server stats into the agent's session, which runs the diagnosis and
      answers in the chat page. The operator never copy-pastes logs.
    - Honest limit: call args are never captured, so investigation works on
      metadata + correlated events (watchdog, bus turns, audit) around the
      same timestamps — not on payload content.

14. 💬 **Discussion / Chat** — converse with the agent from the app: inject →
    agent session (the "discuss" pattern that keeps context), streamed
    replies. A **"Discuss" button** on a proposal routes to the agent WITH the
    diff/context — this is exactly #288 §6's discuss path, extended into a
    page. GitHub Discussions available as a second channel.

## 2b. Whole features adoptable from the same blueprint

Beyond components, the reference dashboard has entire features that map 1:1:

| blueprint feature | → tuner app |
|---|---|
| variables page | **Config page** (§12) |
| alerts (rules + history) | **tuner alerts**: fitness regression, auto-revert, wedged session, registry drift |
| machines (+detail) | **host health** — tuner+scouts across hosts |
| members (roles) | **gate roles** (who can approve/refuse) = PermissionGate |
| sources | the scouts' **`sources.yaml`** (research allow-list, tiers) |
| skills page | **skills panel** (the skills subject has a face) |
| connectors / subscriptions | integrations + notification subscriptions |
| chat-bridge + discussions clients | messenger buttons already drive the gate; Discussions = 2nd chat channel |
| pipelines / projects | orchestration / grouping (optional) |

---

## 3. API CONTRACTS (single `/tuner/*` gateway)

- `GET /tuner/dashboard/summary` — summary cards: # pending, # applied 24h,
  # auto-reverts, stream health, wedged sessions, in-flight jobs.
- `GET /tuner/proposals?status=&source=` ← proposals joined with outcomes.
  `POST /tuner/apply/:id` · `/refuse/:id`.
- `GET /tuner/outcomes/:id` ← baseline/measured/verdict/commit_sha.
- `GET /tuner/telemetry/:stream` ← `telemetry__query` (read-only, #286).
- `GET /tuner/subjects` ← `subject_state` (enabled/risk_tier/cycle).
- `GET /tuner/scouts` ← registry `_meta` + drift + runs + verification rejects.
- `GET /tuner/audit?since=` ← audit chain + verify-chain.
- `GET /tuner/git/:repo/log` · `/diff/:sha` · `POST /tuner/git/revert/:sha`.
- `GET /tuner/watchdog/sessions` · `/forensics/:id` ← #297/#300/#298.
- `GET /tuner/jobs` · `POST /tuner/jobs/:id/cancel` ← `dispatch_job` #303.
- `GET /tuner/eval/sets` · `/runs` · `GET /tuner/eval/recommend/:task` ← #80.
- `GET /tuner/mcp/traffic?server=&tool=&agent=&status=&since=&q=` ←
  `mcp.tool_call` stream: volumes, error rates, latency percentiles, last-N
  calls; filters match the panel's interaction model (q = free-text over
  error messages).
- `GET /tuner/feed` (unified chronology) ← audit + outcomes + scouts +
  watchdog events.
- **WS `tuner.events`** ← live (proposal / apply / revert / kill / job).

---

## 4. Blueprint reuse (components + patterns, 1:1)

| blueprint | → tuner app |
|---|---|
| `DashboardSummaryCard` + summary endpoint | tuner summary (§3) |
| `FeedItemCard` + feed endpoint | **unified Feed** (audit+outcomes+scouts+watchdog) |
| entity card (CRUD + results) | **SubjectCard** / **ProposalCard** (+ outcome result) |
| `JobCard` | **Agent-job card** (#303) |
| `StatusBadge` | pending/applied/refused/reverted, healthy/degraded, wedged/killed |
| `PermissionGate` | the human gate = mutations behind a role (approve/refuse) |
| workflows (steps/import/save) | proposal→apply→outcome pipeline (visualisation) |
| token/auth pattern (#220/#231) | tuner app auth |

---

## 5. PHASING (slots onto what is live)

- **Phase 1 — read-only** (low risk): Dashboard summary + Observability (3) +
  Outcomes (2) + Audit (6) + unified Feed + MCP traffic (13 — read-only, high
  operator value). Every source already exists
  (`telemetry__*`, engine DB, audit log). = Phase 1 of #285.
- **Phase 2 — gate**: gate queue (1) approve/refuse + diff preview (already
  wired to a messenger — the app becomes the 2nd canonical surface).
- **Phase 3 — visual git + scouts**: Git (7) + Scouts (5) panels —
  timeline/diff/revert/drift.
- **Phase 4 — safety + jobs + bench**: Watchdog/Forensics (8) + Agent-jobs (9)
  + Bench/Eval (10) + Kanban (11) + Subjects (4).

---

## 6. Governance angle (unchanged, reinforced)

Everything mutating sits behind the **human gate**; the app makes
**provenance** visible (audit + verify-chain) + the **git trail** (clean
revert) + **safety** (watchdog/kill/forensics) — read-only first, mutating
surface second. The Watchdog/Forensics layer (8) is a new and strong
governance argument: kills/escalations visible and gated.
