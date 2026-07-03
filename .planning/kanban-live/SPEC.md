# SPEC — Live Kanban board of subagent activity (#294 option B)

## 1. Problem statement

The Web UI ships a **half-built Kanban board**: `src/ui/services/kanban.ts` defines the
`KanbanBoard`/`KanbanCard` model, the `readKanban`/`writeKanban` persistence, and two
mutators — `addCardToColumn(column, card)` and `moveCard(id, toColumn, patch?)` — but those
two mutators have **zero callers**. The only writes today come from the manual `POST /api/kanban`
"+ Add task" path (`src/ui/server.ts:825`). So the board is a static scratchpad, not a view of
anything the daemon is actually doing. Issue #294 option B: make it a **live view of subagent
(Task/Agent) activity** driven off the bus, reusing the mutators that already exist.

## 2. Current behaviour (as-is, with refs)

- **The mutators are unwired.** `addCardToColumn` / `moveCard` (`src/ui/services/kanban.ts:49,58`)
  each do a read-modify-write of `.claude/claudeclaw/kanban.json`. Nothing in the codebase calls
  them; the board only changes when a human POSTs a whole board to `/api/kanban`.
- **The bus already observes every subagent spawn/finish.** The JSONL tailer emits
  `response.tool_use` (`{id, name, input}`) and `tool_result` (`{tool_use_id, …}`) per session
  (`src/bus/jsonl-tailer.ts`), plus `session.agent_name`, `session.init`, `session.end`.
  `BusCore.subscribe(filter, handler)` (`src/bus/core.ts:897`) fans these to any subscriber.
  A subagent dispatch surfaces as a `response.tool_use` with `name === "Agent"` (or `"Task"`),
  and its completion as the matching `tool_result` (`tool_use_id === id`).
- **The proven signal, but per-chat only.** `src/ui/server.ts:778` already maps the runner's
  `AgentStreamEvent` to SSE `agent_spawn`/`agent_done` — but only for the single interactive
  chat runner, not globally. The bus path sees *every* session, which is what a board wants.
- **No serialization guard exists** on the two file mutators: two near-simultaneous bus events
  would each read-modify-write the same JSON and lose one update.

## 3. Target behaviour (to-be)

A new **`KanbanTracker`** (`src/bus/kanban-tracker.ts`), a pure `BusCore` subscriber (mirrors
`StallWatchdog`'s structure/quality), that turns subagent lifecycle into board cards:

1. **Spawn → card in `in_progress`.** On `response.tool_use` where `payload.name` is `"Agent"`
   or `"Task"`: create `{ id: payload.id, title: (input.description ?? input.prompt ?? "subagent").slice(0,120),
   started_at: ISO(ts), agent_type }` and `addCard("in_progress", card)`. The tool_use `id` is
   tracked in an in-memory live set keyed by id, and remembered against its session.
2. **Finish → card to `done`.** On `tool_result` whose `tool_use_id` matches a **tracked** live
   agent card: `moveCard(id, "done", { completed_at: ISO(ts) })` and drop it from the live set.
   A `tool_result` for any non-agent tool (unknown id) is ignored — the live set is the filter.
3. **Orphan sweep.** On `session.end` / `session.init` for a session, every still-open agent card
   belonging to that session is swept to `done` with `{ completed_at: ISO(ts),
   agent_type: <type> + " (orphaned)" }` and dropped — the board never accumulates zombie
   in-progress cards from a crashed/rotated/restarted session (mirrors StallWatchdog's
   `outstanding.clear()` on the same events).
4. **`agent_type` resolution (cheap, no over-engineering).** Prefer `input.subagent_type` (the
   Task/Agent tool's own parameter — the most accurate); else the parent session's cached
   `session.agent_name`; else the literal `"subagent"`.
5. **Done-column retention.** After every move-to-done, cap the `done` column to the newest
   `maxDoneCards` (default 50) via `capDoneColumn` so the board file can't grow unbounded.

**Safety (load-bearing):**

- **Never throw into the bus.** `ingest()` wraps its body; any error is swallowed + logged so a
  kanban failure can never break the bus handler / take down a session's event flow.
- **Serialized writes.** `addCardToColumn`/`moveCard`/cap are each a read-modify-write on one
  JSON file; concurrent bus events race and lose updates. All kanban ops are chained through a
  single in-tracker promise queue (a tiny mutex), so they apply strictly in order with no lost
  update. `ingest()` stays synchronous (like StallWatchdog) and merely *enqueues* the async write.

Net: the board becomes a live, self-cleaning view of subagent activity for free off the existing
bus events, reusing the already-written (but unused) mutators, with the manual "+ Add task" path
untouched.

## 4. Architecture decisions (frozen)

- **V1 feed = subagent (Task/Agent) lifecycle ONLY, via a global `BusCore` subscriber.** No cron
  cards, no per-session/main-agent cards — those are **phase 2** (deferred). Rationale: the
  Task/Agent tool_use → tool_result pair is the cleanest, already-proven start/finish signal, and
  a global bus subscriber sees every session (unlike the per-chat runner SSE path). Structure/
  quality mirrors `StallWatchdog`: pure `ingest`, injected deps for testability, never throws into
  the bus, no unref'd timer needed.
- **Injected deps, bound in production to bus + kanban service.** Ctor takes
  `{ subscribe(handler), addCard(col, card), moveCard(id, col, patch), capDone(max), now(), log? }`
  so tests feed a fake bus + recorder mutators + injected clock; production binds them to
  `bus.subscribe(...)`, the kanban service functions, and `Date.now`.
- **Card lifecycle = one card per subagent tool_use id.** `in_progress` on spawn → `done` on the
  matching `tool_result`, or `done (orphaned)` on session end/init. Card `id` **is** the
  `tool_use` id, so spawn/finish correlate with zero extra bookkeeping and re-adds are idempotent
  (a duplicate tool_use for a live id is ignored).
- **Orphan policy = sweep-on-session-boundary, not a timer.** `session.end`/`session.init` are the
  authoritative "this session's in-flight work is gone" signals (same ones StallWatchdog clears
  on); sweeping there is deterministic and needs no periodic tick. In-memory state is intentionally
  ephemeral — a daemon restart legitimately starts with no live cards.
- **Single-writer via an in-tracker promise queue.** The kanban JSON is a single shared file and
  the mutators are read-modify-write; the tracker is the one component issuing bus-driven writes,
  so serializing *inside* the tracker (chain every op on one promise) is sufficient and keeps the
  mutator signatures unchanged. (Rejected: a file lock / changing the mutators to be atomic — more
  surface than needed for one writer.)
- **Retention = cap `done` to newest N on each move (default 50), not a timer.** Capping on write
  bounds file growth without a sweep loop. `capDoneColumn(board, max)` is a pure fn added to the
  kanban service; `capDoneCards(max)` is its read-cap-write convenience, called through the same
  serialized queue.
- **Gated ON by default, overridable** via `settings.kanban.enabled` (mirrors how bus features
  flag). Absent config ⇒ enabled. `enabled:false` ⇒ `start()` is a no-op subscriber-wise.
- **In-memory only.** Matches `StallWatchdog` / `src/watchdog.ts`: a restarted daemon has no live
  subagents to track, so nothing is persisted beyond the board file itself.

## 5. Key file references

**New:**
- `src/bus/kanban-tracker.ts` — the `KanbanTracker` subscriber: config
  (`KanbanTrackerConfig { enabled, maxDoneCards }` + `DEFAULT_KANBAN_CONFIG`), injected
  `KanbanTrackerDeps`, synchronous `ingest(BusEvent)` (never throws), serialized write queue,
  live-card + per-session tracking, orphan sweep, `agent_type` resolution, `start()`/`stop()`.
- `src/bus/__tests__/kanban-tracker.test.ts` — fake bus + recorder `addCard`/`moveCard`/`capDone`
  + injected clock. Covers spawn→in_progress, finish→done, non-Agent tool_use ignored, unknown
  tool_result ignored, session.end orphan sweep, write serialization / no lost update, plus a
  `capDoneColumn` unit test.

**Modify:**
- `src/ui/services/kanban.ts` — add `capDoneColumn(board, max=50)` (pure; keep newest `max`) and
  `capDoneCards(max=50)` (read-cap-write convenience). Existing helper signatures unchanged.
- `src/commands/start.ts` — instantiate `KanbanTracker` in the deferred-spawn block right after
  `attachScheduler` (bus + agents up), deps bound to `bus.subscribe(...)` + the kanban service +
  `Date.now`; `start()` it; `stop()` it in `shutdown()` alongside `busRuntimeHandle.stop()` and in
  the deferred-spawn rollback. Gated on `currentSettings.kanban?.enabled !== false`.
- `src/config.ts` — add optional `kanban?: KanbanSettings { enabled: boolean }` to `Settings` and
  parse it (default enabled when the block is present but `enabled` isn't `false`).

**Reference (reuse, do not duplicate):**
- `src/bus/stall-watchdog.ts` — the structural/quality template (pure ingest, injected deps,
  session-keyed state, `outstanding.clear()` on session.end/init, `start()/stop()`).
- `src/bus/core.ts:897` (`subscribe`), `src/bus/core-subscription.ts` (`SubscriptionFilter`
  topic filter), `src/bus/jsonl-tailer.ts` (event topics/shapes).
- `src/ui/services/kanban.ts:49,58` (`addCardToColumn` / `moveCard` — the mutators being wired).

## 6. Out of scope (deferred)

- **Cron/scheduled-job cards** and **per-session / main-agent cards** — phase 2. V1 is
  subagent-only.
- **A `todo` feed.** V1 never writes `todo`; cards are born `in_progress`. (The manual "+ Add task"
  path can still create `todo` cards and is left working.)
- **Live push to the browser** (SSE/websocket board updates). The board file is updated live;
  the UI still polls `GET /api/kanban`. Real-time push is a later UI concern.
- **Persisting tracker state across daemon restarts** — intentionally not done (in-memory only).
- **Reconciling manual cards with tracked cards** — the manual POST path owns whatever the human
  puts there; the tracker only ever touches cards keyed by a real subagent tool_use id.
