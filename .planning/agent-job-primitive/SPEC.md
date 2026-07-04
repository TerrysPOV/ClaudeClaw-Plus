# SPEC — First-class agent-job primitive (PR 3/3 of #296)

Fixes the *root smell* behind #295; PR 3 of the 3-PR path in #296. PR 1 (stall watchdog) recovers a wedged session; PR 2 (Bash guard) blocks the unsafe `&` pattern; **this PR removes the need to improvise jobs at all.**

## 1. Problem statement

The deepest cause of #295: Claw needed to run `reg`/`suzy` as long **autonomous batch jobs** (60-min research/draft runs), but the bus only offers **interactive, turn-based** agent sessions and gives an agent no tool to dispatch work to another agent. So Claw hand-rolled `/tmp/fire-reg-aissure-*.ts` that `Bun.spawn(["claude","-p", …])` — bypassing the bus (untracked, unobservable, uncancellable) and launching them with `nohup … &` (which wedged the session). PR 1/2 make that improvisation *survivable*; this PR makes it *unnecessary* by giving agent jobs a proper, supported home in the bus.

## 2. Current behaviour (as-is)

- **Agents have no dispatch tool.** `BUS_MCP_TOOLS` (`src/bus/mcp-tools.ts:12`) exposes `reply` / `edit_message` / `ask` / `cancel` / `request_human` — nothing to run a job on another agent. An agent that needs background work has no supported path.
- **The execution + persona primitives already exist, unused for this.** `runClaudeOnce(args, model, api, env, timeoutMs, cwd)` (`src/runner.ts:739`) spawns claude headless with the sanitised child env, a wall-clock timeout, and process tracking (`mainActiveProcs`). `loadAgentPrompts(agentName)` (`src/runner.ts:1517`, via `loadAgent`/`AgentContext`) assembles an agent's IDENTITY/SOUL/CLAUDE.md. **Claw's fire-script re-implemented both by hand** (`Bun.spawn(claude -p)` + `readFileSafe` of IDENTITY/SOUL/MEMORY).
- The bus MCP `CallTool` handler (`src/bus/mcp-server.ts:430`, `switch (name)`) is where a new tool is wired.
- The scheduler (`src/bus/scheduler.ts`) is a cron/heartbeat prompt-emitter (fires `bus.sendPrompt`), not a job runner — a reference for trigger→dispatch, not the execution model.

## 3. Target behaviour (to-be)

A **`dispatch_job` MCP tool** on the bus + a **job runner/registry** so an agent can fire a background job to a named agent, get an id back immediately, and have the result delivered when done.

1. **`dispatch_job({ agent, prompt, model?, timeoutMs? })`** (new `BUS_MCP_TOOLS` entry + `mcp-server.ts` case) → validates `agent` is a known agent, enqueues the job, and **returns `{ job_id, status: "running" }` immediately** (fire-and-return — never blocks the caller's turn).
2. **Job runner** (`src/bus/agent-jobs.ts`): runs the agent headless via `runClaudeOnce` with `loadAgentPrompts(agent)` as `--append-system-prompt`, the job `prompt` as `-p`, `--output-format stream-json`, and the job's `timeoutMs` (default e.g. 30 min, hard-capped). One process per job, tracked so it can be killed. Best-effort; a job failure never affects the daemon.
3. **Registry** (in-memory, mirrors the scheduler's no-persistence model): `job_id → { agent, status: running|done|failed|cancelled|timeout, startedAt, endedAt?, exitCode?, resultText?, dispatcher }`.
4. **Result delivery (see §4 for the decision):** when a job finishes, its final text is delivered back to the **dispatching agent** via the bus (a synthetic notification/prompt: "job <id> for <agent> finished: <result>"), so the dispatcher can act on it — closing the loop the fire-scripts faked by tailing a log. Also queryable (below).
5. **Observability + control:** `job_status({ job_id })` and `list_jobs()` (registry snapshot); `cancel_job({ job_id })` kills the tracked process and marks it `cancelled`.

Net acceptance: **the reg/suzy batch-job pattern runs through `dispatch_job`, not `/tmp` fire-scripts** — tracked, observable, cancellable, and incapable of wedging the caller (fire-and-return; the headless job is its own process, not the caller's pipe).

## 4. Architecture decisions

- **FROZEN — dedicated headless job (via `runClaudeOnce` + `loadAgentPrompts`), NOT a prompt to the agent's PTY.** Rationale: a 60-min autonomous job must not block the target agent's interactive session, and this exactly matches (and replaces) the fire-script pattern while reusing the runner's env/timeout/tracking. (Rejected: `bus.sendPrompt` to the agent's live PTY — blocks its interactive turn for the job's duration and forces a turn model onto a batch job.)
- **FROZEN — fire-and-return.** The tool returns a `job_id` synchronously; the job runs in the background. The caller never awaits the job (that awaiting is exactly what wedged #295).
- **FROZEN — in-memory registry, no cross-restart persistence.** Matches the scheduler's model; a daemon restart cancels in-flight jobs (acceptable — the stall watchdog + restart rotation already assume restart-clears-state). Persisting/resuming jobs is out of scope.
- **DECISION NEEDED — result delivery.** Options: **(a)** deliver the finished job's text back to the *dispatching agent* as a bus notification (Claw dispatched → gets the result → reports to Terry — matches actual use); **(b)** post the result to a channel/thread directly; **(c)** results only queryable via `job_status` (caller polls). **Recommendation: (a) + (c)** — deliver to the dispatcher AND keep it queryable. (a) closes the loop the fire-scripts faked (tailing a log for the result); (c) covers observability + a dispatcher that's since rotated.
- **DECISION NEEDED — concurrency cap.** A small max-concurrent-jobs limit (e.g. 3) so a low-spec box can't be swamped by parallel `claude -p` processes; excess jobs queue. Recommend yes, default 3, configurable.

## 5. Key file references

**New:**
- `src/bus/agent-jobs.ts` — the `AgentJobRunner`: `dispatch()` (spawn via `runClaudeOnce`+`loadAgentPrompts`, register, fire-and-return), `status()`/`list()`, `cancel()`, result-delivery callback, concurrency cap. Pure registry-state helpers split out for unit testing.
- `src/bus/__tests__/agent-jobs.test.ts` — unit (registry transitions; dispatch returns id immediately; cancel kills + marks; timeout → status; concurrency cap queues) with an injected fake `runClaudeOnce` so no real claude spawns.

**Modify:**
- `src/bus/mcp-tools.ts` — add `dispatch_job` / `job_status` / `list_jobs` / `cancel_job` to `BUS_MCP_TOOLS` (name + description + input schema).
- `src/bus/mcp-server.ts` — `switch (name)` cases wiring the tools to the `AgentJobRunner`; inject the runner where the server is constructed.
- Wiring point (`src/bus/runtime-mount.ts`) — instantiate `AgentJobRunner`, bind `runClaudeOnce`/`loadAgentPrompts` + the result-delivery callback (via `bus.sendPrompt`/`ingestReply`), start/stop with the handle.

**Reference (reuse, do not duplicate):**
- `src/runner.ts:739` (`runClaudeOnce`), `:1517` (`loadAgentPrompts`), `loadAgent`/`AgentContext` (`src/agents.ts:199`).
- `src/bus/mcp-server.ts:430` (CallTool switch), `src/bus/mcp-tools.ts:12` (`BUS_MCP_TOOLS`).

## 6. Out of scope (deferred)

- **Cross-restart job persistence / resume** — in-memory only (§4).
- **Streaming job progress** back to the dispatcher — v1 delivers the final result; live progress is a follow-up.
- **Retries / backoff on job failure** — the dispatcher decides whether to re-dispatch.
- **Removing the existing `/tmp` fire-scripts on the server** — operational cleanup once the primitive ships; not code in this PR.
- **A general "run arbitrary command as a job"** — this is *agent* jobs (named agent + prompt) only.
