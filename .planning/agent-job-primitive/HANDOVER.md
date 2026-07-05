# HANDOVER — PR 3/3 of #296: first-class agent-job primitive

Resume point for a clean session. Everything below is current as of branch
`feat/agent-job-primitive` @ `cb5cf22` (pushed to remote `povai` =
`TerrysPOV/ClaudeClaw-Plus`). Read the SPEC next to this file first:
`.planning/agent-job-primitive/SPEC.md`.

## 0. How to resume (the worktree is in ephemeral /tmp and may be gone)

The branch is pushed; recreate a worktree from it:

```bash
cd /Users/terrenceyodaiken/claude-workspace/claudeclaw-plus
git fetch povai
git worktree add /path/to/wt-jobs feat/agent-job-primitive   # tracks povai/feat/agent-job-primitive
cd /path/to/wt-jobs && ln -s /Users/terrenceyodaiken/claude-workspace/claudeclaw-plus/node_modules node_modules
```

Operator is **Terrence** (GitHub `TerrysPOV`). This is his own fork/PR, so PR
creation is allowed; the SDC gate (`gh pr create`) needs the four markers or
`ALLOW_PR_PUBLISH=1`. Never `gh pr merge` without his explicit per-merge word.

## 1. What this is

Epic **#296** = the 3-PR fix for the #295 daemon outage (an agent hand-rolled
`/tmp/fire-*.ts` that `Bun.spawn(claude -p …)` + `nohup … &`, which held the
Bash tool's pipe and wedged the session ~11h).

- **PR 1 — stall watchdog (recovery):** MERGED (#297 + #300). Live on the daemon.
- **PR 2 — Bash-exec guard (prevention):** MERGED (#302).
- **PR 3 — agent-job primitive (root-smell fix): THIS BRANCH, in progress.**
  Gives agent jobs a supported home so no agent ever hand-rolls `claude -p` again.

## 2. Design decisions (frozen — do not re-litigate)

- Dedicated **headless job** via `runClaudeOnce` + `loadAgentPrompts` (NOT a prompt
  to the agent's live PTY).
- **Fire-and-return** — the tool returns a `job_id` immediately, never awaits the job.
- **In-memory registry**, no cross-restart persistence (matches the scheduler).
- **Result delivery = Terry's call "1 a + c":** deliver the finished result back to
  the *dispatching agent* via the bus AND keep it queryable via `job_status`.
- **Concurrency cap = Terry's call "2 yes":** default 3, configurable; excess queue.

## 3. What is DONE (committed on this branch, type-clean, tests green)

- **`src/bus/agent-jobs.ts`** — `AgentJobRunner` (the heart). Dependency-injected:
  `dispatch()` (fire-and-return, validates via `isKnownAgent`, returns `{jobId,status}`
  or `{error}`), in-memory registry, concurrency cap + queue, `cancel()` (running via
  `AbortSignal`, queued without spawning), `stop()`, `status()`/`list()`, and
  `deliverResult` on every terminal state. **10 unit tests** in
  `src/bus/__tests__/agent-jobs.test.ts` (fake `runAgentJob`, no real claude). Green.
- **`src/runner.ts`**:
  - `runClaudeOnce` gained an optional 7th param `signal?: AbortSignal` — aborts like a
    timeout (rejects the race → existing catch kills the proc). Backward-compatible.
  - New exported **`runAgentJobHeadless({agent, prompt, model?, timeoutMs, signal})`** →
    `{exitCode, resultText?, error?, timedOut?}`. Loads persona via `loadAgentPrompts`,
    runs `claude -p` in the agent's dir (`loadAgent().dir`) with plain output, maps
    exit 124→timedOut. This is the real fire-script replacement.
- **`src/agents.ts`** — exported `agentExists(name): boolean` (dispatch-time validation).
- **`src/bus/mcp-tools.ts`** — added the 4 tool defs to `BUS_MCP_TOOLS`:
  `dispatch_job` / `job_status` / `list_jobs` / `cancel_job`.

## 4. THE REMAINING WORK — daemon-side IPC wiring (the hard, security-sensitive part)

**Key architecture fact that reshapes this:** `BusMcpServer` is a **per-agent
SUBPROCESS** that connects to the daemon's `BusCore` over a **unix socket**
(`connectBusIpc`/`wrapSocket`, `src/bus/mcp-server.ts:150-200,753`). So the
`AgentJobRunner` **must live in the daemon** (only it can spawn/track processes),
and the 4 tools must **route over the socket IPC as request/response**. The
`AgentJobRunner` cannot be held by the MCP subprocess.

**Mirror the `request_human` round-trip** (`src/bus/mcp-server.ts:667-694`): mint an
id → register a pending-response promise in a map (like `pendingAnswers`, field at
`mcp-server.ts:386`) → `this.ipc.send(msg)` → `await` the promise → return
`{content:[{type:"text", text: JSON.stringify(result)}]}`. The reply comes back as a
correlated IPC message that resolves the pending promise.

Steps (each is testable; keep the DI seams):

1. **`src/bus/types.ts`** (IPC union, interfaces ~lines 221-304) — add a bidirectional
   pair. Recommend ONE generic pair with a correlation id rather than 8 types:
   - `IpcJobRequest { type:"job_request"; agent_id; req_id; op:"dispatch"|"status"|"list"|"cancel"; payload }`
   - `IpcJobResult { type:"job_result"; req_id; ok; result?; error? }`
   Add both to whatever discriminated-union type aggregates IPC messages.

2. **`src/bus/mcp-server.ts`** — add cases in the `switch(name)` at **:432** for the 4
   tools → handlers `handleDispatchJob/handleJobStatus/handleListJobs/handleCancelJob`.
   Each: mint `req_id = randomUUID()`, register in a new `pendingJobRequests` map,
   `this.ipc.send({type:"job_request", agent_id:this.agentId, req_id, op, payload})`,
   `await` the reply, return the JSON. Route the inbound `job_result` in `wireIpc()`
   (the IPC `onMessage` switch at ~:515) to resolve the pending promise. `this.agentId`
   is the **dispatcher**. Add `RequestHuman`-style zod arg schemas.

3. **`src/bus/core-ipc.ts`** — handle inbound `job_request`: call the daemon's
   `AgentJobRunner` method for `op`, send back `{type:"job_result", req_id, ok, result/error}`
   on that agent's socket. (See how it handles `ask`/`request_human`/`reply` today,
   e.g. the error-send at `core-ipc.ts:257`.)

4. **`src/bus/runtime-mount.ts`** — instantiate the runner in the daemon:
   ```ts
   const jobRunner = new AgentJobRunner(parseAgentJobConfig(settings) ?? DEFAULT_AGENT_JOB_CONFIG, {
     runAgentJob: (i) => runAgentJobHeadless(i),
     isKnownAgent: agentExists,
     deliverResult: (job) => { void bus.sendPrompt({ /* origin:"system", agent: job.dispatcher, text: formatResult(job) */ }); },
     now: Date.now,
     genId: () => randomUUID(),
   });
   ```
   Wire `jobRunner` into `core-ipc` (so step 3 can reach it). **Stop it in the handle's
   `stop()`** next to the stall watchdog stop (search `stallWatchdog.stop()` in
   `runtime-mount.ts` — put `jobRunner.stop()` beside it). Confirm `bus.sendPrompt`
   signature at `src/bus/core.ts:162,471` (`SendPromptRequest`) and pick the right
   `origin`/agent fields for delivering a system message to the dispatcher.

5. **Config** — `src/config.ts`: add `AgentJobConfig` parse (`parseAgentJobConfig`, mirror
   `parseAgenticConfig`/`parseMcpConfig`) + `DEFAULT_SETTINGS.agentJobs`, wired into
   `parseSettings`. Reuse the `AgentJobConfig` interface already exported from
   `agent-jobs.ts` (fields: `maxConcurrent`, `defaultTimeoutMs`, `maxTimeoutMs`;
   `DEFAULT_AGENT_JOB_CONFIG` also exported there).

6. **Integration test** — a socket round-trip test: dispatch_job over IPC → daemon runner
   (inject a fake `runAgentJob`) → job_result back → status/cancel. Model on
   `src/bus/__tests__/sprint-1-e2e.test.ts` and `mcp-server.test.ts` (both construct
   `BusMcpServer` with an in-memory transport).

7. **Ship** — `bun run bump:plugin-version && bun run bump:marketplace-version`, commit,
   push, open PR for **@Nibbler1250** (base `main`). Body: what it is, the topology note,
   the security posture (daemon spawns agent processes on IPC message — call out the
   validation: `agentExists` + concurrency cap + timeout hard-cap + the persona/dir it
   runs under). Refs #296, #295.

## 5. Verify before shipping

```bash
bun test src/bus/__tests__/agent-jobs.test.ts        # core (should stay 10 green)
bun test src/bus/                                     # + the new integration test
bunx tsc --noEmit -p .                                # type-clean
bunx biome check <edited files>                       # lint-clean
```
Then the SDC markers (`~/.claude/scripts/sdc/mark-*.sh`, `TEST_ARGS` scoped to touched
paths — see project CLAUDE.md) or `ALLOW_PR_PUBLISH=1 gh pr create …`.

## 6. Gotchas learned this session

- `settings` in `runner.ts` = `getSettings()` (imported :28), NOT a module global.
- Biome forbids non-null `!` (`lint/style/noNonNullAssertion`) — use a throwing accessor
  or `?.`/`??` in tests (see `at()` helper in `agent-jobs.test.ts`).
- The Edit tool sometimes fails to match a short line verbatim (hit on a `const … = " ";`
  line) — match with surrounding context or a `replace_all` on a longer unique token.
- Version guard: branch version must exceed `main`'s (main is `2.2.171`; branch already
  bumped? check `.claude-plugin/plugin.json` — if not, run both bump scripts before PR).
- Commit with `SKIP_SIMPLIFY=1` (pre-commit simplify hook) unless running the simplifier.
- `mark-tests-passing.sh` always needs `TEST_ARGS="<paths>"` (full-suite has pre-existing
  cross-test flakes).

## 7. Definition of done for PR #3

An agent can call `dispatch_job({agent:"reg", prompt:"…"})`, get a `job_id` back without
its turn blocking, the daemon runs reg headless (tracked, capped, cancellable), and the
result is delivered back to the dispatcher + queryable — i.e. **the reg/suzy batch-job
pattern runs through the primitive, not `/tmp` fire-scripts.**
