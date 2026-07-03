# SPEC — Stall Watchdog for bus PTY sessions (PR #1 of #296)

Resolves the outage class in **#295**; PR #1 of the 3-PR path in **#296**.

## 1. Problem statement

A persistent bus PTY session (the main Discord session, or a named agent like `reg`/`suzy`) can block **indefinitely inside a single tool call that never returns** — e.g. a `Bash` call whose `&`-backgrounded children hold the persistent shell's output stream open, so the tool never sees EOF. Because each session drives a **single-threaded** event loop, a wedged tool call makes that session ignore *all* subsequent messages. In the 2026-07-02 incident this took the whole daemon unresponsive for ~11h until a manual `systemctl restart`.

Nothing detects or recovers this. The `#272` governance watchdog is a **runaway** guard (trips on *too much* activity) and is structurally blind to an idle stall; `src/watchdog.ts` only guards the **one-shot** `runClaudeOnce` path, not the long-lived bus PTY sessions. We need a **liveness/stall watchdog** that detects a session stuck mid-tool-call and self-heals it, so a single hung tool can never take the daemon offline.

## 2. Current behaviour (as-is, with refs)

- **Bus PTY sessions are long-lived and unguarded.** `SessionManager` (`src/bus/session-manager.ts:534`) spawns each agent as a persistent `PtyAgentProcess` / `ChildAgentProcess` (`src/bus/session-agent-process.ts:86,470`) that runs continuously. There is no wall-clock or stall guard on these sessions.
- **The only existing timeouts are invocation-scoped.** `src/watchdog.ts` tracks `maxConsecutiveTimeouts` / `maxRuntimeSeconds` for the one-shot `runClaudeOnce` flow (exit `TIMEOUT_EXIT_CODE=124`); `settings.sessionTimeoutMs` caps a single `claude -p` call. Neither applies to a bus PTY session blocked mid-tool-call.
- **The bus already observes every session event.** `JsonlTailer` (`src/bus/jsonl-tailer.ts`) tails each session's transcript and emits `response.tool_use` (~`:468`), `tool_result` (~`:449`), `response.turn_end`, `session.init`, etc. via `bus.ingestSessionEvent` (`:598`). `BusCore.subscribe(filter, handler)` (`src/bus/core.ts:163,837`) fans these to any subscriber.
- **A shared respawn primitive already exists.** `SessionManager.restart(agent, opts)` (`src/bus/session-manager.ts:146`) is the canonical kill+respawn: it rotates or resumes the session id, writes a post-mortem stamped with `opts.reason`, dedups concurrent restarts (`restartInFlight` `:547`), and enforces a **restart rate-limiter** (`MAX_RESTARTS_PER_WINDOW`, `restartHistory` `:386,545`) so failure-driven respawns can't infinite-loop. It is already invoked by "three triggers"; `createRotateAgent` (`src/bus/runtime-mount.ts`) wraps it for the `#227` rotation.

## 3. Target behaviour (to-be)

A new **`StallWatchdog`** (`src/bus/stall-watchdog.ts`) that:

1. **Observes** via `BusCore.subscribe()`. Per session/agent it tracks `{ lastActivityAt, awaitingToolResult, outstandingToolName, toolUseStartedAt }`:
   - `response.tool_use` → `awaitingToolResult=true`, `outstandingToolName=<name>`, `toolUseStartedAt=lastActivityAt=now`.
   - `tool_result` → `awaitingToolResult=false`, `lastActivityAt=now`.
   - any other session event (text, usage, turn_end, init) → `lastActivityAt=now` (activity ⇒ alive; also clears a lingering awaiting flag on turn_end).
2. **Sweeps** on a timer (`sweepIntervalMs`, default 30s). For each session with `awaitingToolResult`, compute `outstanding = now - toolUseStartedAt` and the **ceiling for that tool** (per-tool map, below):
   - `outstanding ≥ killSeconds(tool)` → **STALL** → `SessionManager.restart(agent, { reason: "stall", … })` + a **loud** notice (Discord/critical log) naming the session + stuck tool.
   - `warnSeconds(tool) ≤ outstanding < killSeconds(tool)` → emit a **warn once** (notify, no kill).
3. **Distinguishes stall from legit-long tool by the tool's own bound**, not silence (silence is identical for both at the transcript level). Ceilings are keyed on the `tool_use` name via a **fixed 5-class model** (`classifyTool`), precedence `bash → fast → task → mcp → default`:
   - `fast` (`Read`/`Edit`/`MultiEdit`/`Write`/`Grep`/`Glob`/`LS`/`NotebookEdit`) → warn 60s / kill 120s.
   - `bash` (`Bash`) → warn 300s / kill 900s (its 10-min max + grace).
   - `task` (`Task`/`Agent` sub-agent dispatch) → warn 1800s / kill 3600s (≈ the `claude -p` 60-min cap from #295 — a real sub-agent job isn't killed; also the class PR #3's agent-job primitive maps onto). *(Review finding 1.)*
   - `mcp` (`mcp__…` workflow/research tools) → warn 600s / kill 1800s.
   - `default` (truly unknown) → warn 300s / kill 900s.
4. **Auto-discovery (self-correcting kill audit).** The fixed ceilings stay conservative; every kill is audited so a *wrong* kill loosens the limit rather than silently harming. On each kill:
   1. **Capture a liveness snapshot immediately before restart** (you cannot probe a dead process): `cpuAdvancing` — aggregate CPU jiffies of the session's process tree (`/proc/<pid>/stat` utime+stime over descendants) sampled twice ~1s apart, true if it moved past a noise floor (Linux-only; `null` elsewhere); `outputRecencyMs` — ms since the process wrapper's `DataHandler` last saw raw output (recent output ⇒ alive); `outstandingMs`, `toolName`.
   2. **Restart** the session (snapshot stamped onto the post-mortem via `restart({ reason: "stall", forensic })`).
   3. **Classify (investigate):**
      - `genuine_wedge` — `cpuAdvancing===false` **and** output stale since the tool started → recover quietly (info + audit).
      - `suspected_false_positive` — `cpuAdvancing===true` **or** recent output (the tool looked alive) → recover **and flag Terry**: a critical/Discord notice — *"Stall-killed {session} on {tool} after {outstanding}s, but it looked alive ({evidence}). If this tool legitimately runs that long, raise `stallWatchdog.ceilings.{class}.killSeconds` (suggest ~2×{outstanding})."*
      - `unknown` — probe unavailable (non-Linux / PID gone) → recover, audit as unknown, no flag.
   4. **Audit** every kill to `.claude/claudeclaw/stall-kills.jsonl` (session, tool, outstandingMs, classification, evidence, suggestedKillSeconds, ts) — a durable record the operator (and, later, the #275 tuner) can review.
   Auto-discovery **suggests, never auto-applies** — raising a ceiling stays a human decision (and a natural future input to the gated #275 self-tuning layer).
5. **Ships enabled** with the above defaults (unlike the runaway limits, which are null/off). Fully overridable via settings.
6. Is **in-memory** (mirrors `src/watchdog.ts`): a daemon restart resets tracking, which is correct — a fresh daemon has no outstanding stalls.

Net: a hung tool call self-heals within its ceiling (~minutes) instead of hanging forever; a legit long tool that finishes under its ceiling is untouched; a recurring stall is bounded by the existing restart rate-limiter; and any *mistaken* kill produces a flagged, evidence-backed suggestion to loosen the exact ceiling that was too tight — so the conservative defaults self-correct instead of silently harming.

## 4. Architecture decisions (frozen)

- **Live in the bus layer as a `BusCore` subscriber + timer sweep.** Rationale: the tailer already emits the exact events; subscribing is zero-surgery to the tailer/core and keeps the watchdog decoupled and independently testable. (Rejected: hooking the JSONL tailer or `runner.ts` stream reader — more invasive, and `runner.ts` is the one-shot path, not the PTY path.)
- **Recover via `SessionManager.restart({ reason: "stall" })` — do not build a new kill path.** Rationale: inherits kill+respawn, session rotation, post-mortem, in-flight dedup, and (critically) the `MAX_RESTARTS_PER_WINDOW` rate-limiter, so a repeating stall can't become an infinite respawn loop. Adds `"stall"` as a fourth restart `reason`.
- **Per-tool ceilings keyed on the `tool_use` name, with a warn→kill ladder.** Rationale: at the transcript level a legit long tool and a stall are indistinguishable by silence; the tool's own bound is the only reliable discriminator. Warn-first means a legit job that runs long triggers a heads-up, never a surprise kill. (PR #2 will *enforce* these caps daemon-side, making the kill-line exact; PR #1 uses generous ceilings so it is safe even before PR #2.)
- **A fixed 5-class ceiling model (`fast/bash/task/mcp/default`), not an open per-tool record.** Rationale: a bounded, named class surface is easier to reason about and tune than an unbounded `Record<toolName, …>`, and it captures the real risk tiers (near-instant vs shell vs sub-agent vs MCP). `task`/`mcp` are split out specifically so a legitimate 10–30-min sub-agent or research tool is not false-positive-killed at the `default` 900s ceiling (review finding 1).
- **A per-session restart-failure cooldown (`restartFailureCooldownMs`, default 300s).** Rationale: the `MAX_RESTARTS_PER_WINDOW` rate-limiter bounds *respawns* but not *notifications* — without a cooldown, an unrecoverable wedge (rate-limiter exhausted) would re-kill+re-`critical`-notify every sweep, flooding Discord. After a failed restart the session backs off for the cooldown before it is re-evaluated (review finding 2).
- **Auto-discovery: every kill is audited and self-corrects; it suggests, never auto-applies.** Rationale: fixed ceilings are a guess; a wrong kill must teach us to loosen, not silently harm. A pre-kill liveness snapshot (CPU-tree progress + output recency) classifies the kill; a `suspected_false_positive` flags Terry with the exact ceiling to raise and a suggested value. Auto-*applying* the change is deliberately excluded — that belongs to the human (and later the gated #275 tuner), keeping the watchdog honest. The probe is best-effort and degrades to `unknown` off-Linux (dev/mac), so nothing depends on it being available.
- **Ships enabled by default.** Rationale: an off-by-default safety net wouldn't have prevented the incident (the runaway watchdog was null/off). Defaults are generous enough not to touch legit work, and auto-discovery backstops any that are still too tight.
- **In-memory tracking only.** Rationale: matches `src/watchdog.ts`; a restarted daemon legitimately has no live stalls to track. (Rejected: persisting to disk — needless complexity for state that is only meaningful within one daemon lifetime.)
- **Process-CPU liveness is out of v1.** Time+tool-based detection is sufficient and simple; CPU/IO corroboration is a later enhancement (noted in §6).

## 5. Key file references

**New:**
- `src/bus/stall-watchdog.ts` — the `StallWatchdog` (subscriber, per-session state, sweep, decision logic). Pure decision fn (`evaluateStall(state, now, ceilings)`) split out for unit testing.
- `src/bus/stall-forensics.ts` — the auto-discovery pieces, kept separate so they're pure/testable and the OS-specific probe is isolated: `probeProcessTreeCpu(pid)` (best-effort `/proc` sampler, returns `null` off-Linux), `classifyKill(snapshot, ceiling)` → `"genuine_wedge" | "suspected_false_positive" | "unknown"` + `suggestedKillSeconds`, and `appendStallKillAudit(record)` (→ `.claude/claudeclaw/stall-kills.jsonl`).
- `src/bus/__tests__/stall-watchdog.test.ts` — unit (event stream + injected clock → warn/kill/none; per-tool ceilings; turn_end clears awaiting) + integration (fake bus + fake `restart` dep → restart called once on stall, rate-limit respected, not called for legit-under-ceiling).
- `src/bus/__tests__/stall-forensics.test.ts` — `classifyKill` truth table (cpuAdvancing × outputRecency → classification + suggestion); audit-record shape; probe returns `null`/`unknown` gracefully when `/proc` is absent.

**Modify:**
- `src/config.ts` — add a `stallWatchdog` settings block + `parseStallWatchdogConfig` (mirror `parseWatchdogConfig` in `src/watchdog.ts:136`), wire into `parseSettings` and `DEFAULT_SETTINGS` (near the existing `watchdog:` at `~:218`/`~:1010`). Shape (as landed — a fixed 5-class model, not an open `perTool` record): `{ enabled, sweepIntervalMs, ceilings: { fast, bash, task, mcp, default } (each { warnSeconds, killSeconds }), action: "restart"|"warn", autoDiscovery: { enabled, cpuProbeMs }, restartFailureCooldownMs }`. Parser must clamp/validate each numeric and fall back to `DEFAULT_STALL_CONFIG` per field.
- `src/bus/session-agent-process.ts` — track `lastDataAt` on the existing `DataHandler` path (one timestamp write per chunk on `PtyAgentProcess`/`ChildAgentProcess`) so the forensic probe can read "ms since last raw output". Expose it via the `AgentProcess` interface (+ the process `pid` for the CPU probe).
- Wiring point (where the bus + SessionManager are constructed — `src/bus/runtime-mount.ts` / `wiring.ts`): instantiate `StallWatchdog`, give it `subscribe` + a `restart(agentId, {reason, forensic})` callback (reuse the same dep shape as `createRotateAgent`'s `RotateAgentDeps`) + a notifier, start its sweep.

**Reference (reuse, do not duplicate):**
- `src/bus/session-manager.ts:146` (`restart()` + `RestartOptions.reason`), `:386` (rate-limiter).
- `src/bus/core.ts:163,837` (`subscribe`), `src/bus/jsonl-tailer.ts:449,468` (event names/shapes).
- `src/bus/runtime-mount.ts` (`createRotateAgent` / `RotateAgentDeps` — dep-injection pattern to copy).
- `src/watchdog.ts:136` (`parseWatchdogConfig` — validation pattern; `injectClock` test seam to copy).

## 6. Out of scope (deferred)

- **Enforcing per-tool wall-clock caps on tool execution** (kill the command at its cap; detach `&`-backgrounded jobs) → **PR #2**. PR #1 only *detects+recovers*; PR #2 makes the ceiling exact and prevents the specific footgun.
- **A first-class non-blocking agent-job primitive** (so Claw stops `Bun.spawn`-ing `claude -p` from Bash) → **PR #3** (own SPEC).
- **Process-CPU liveness in the *live* kill decision** — the live sweep decision stays purely time+tool-based; CPU is used only *post-kill* in the auto-discovery forensic (§3.4). Folding it into the live decision is a later refinement.
- **Auto-*applying* a ceiling change** — auto-discovery only flags + suggests; applying is a human decision now, and a natural future input to the gated #275 self-tuning layer. Explicitly not built here.
- **Persisting stall state across daemon restarts** — intentionally not done (see §4). (The `stall-kills.jsonl` audit *is* persisted; the in-memory per-session tracking is not.)

## 7. Follow-ups captured from the #297 review

The #297 checkpoint (detection core) merges with review findings 1–3 already fixed in `c3a8d5f` (task/mcp classes, restart-failure cooldown, NUL strip). One deferred item remains:

- **`restartFailedAt` reset-path invariant** (from the `@claude` review). `restartFailedAt` is only cleared implicitly by dropping the `SessionStallState` on a *successful* restart; a fresh `session.init` always produces a new `newSessionState`, so the cooldown never leaks **as long as no code reuses a `SessionStallState` across a wedge→recovery cycle without going through `ingest`**. Action: **assert/verify this invariant when the wiring lands** (add a test that a re-observed session after a failed-then-succeeded restart starts clean).
  - **Placement: the stall-watchdog *completion* PR** — i.e. the remaining PR #1 plumbing (`stall-forensics.ts` + `config.ts` + `session-agent-process.ts` + the wiring point), which is a **new PR**, *not* #296's PR #2 (Bash-exec hardening) or PR #3 (agent-job primitive). Those keep their scope. (The reviewers loosely called the config-wiring "PR #2"; to avoid renumbering, it is tracked as the completion of PR #1.)
