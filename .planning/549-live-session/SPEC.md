# SPEC: compact, memory saves and rotation summary in the live PTY session (#549)

Issue: TerrysPOV/ClaudeClaw-Plus#549. Part of #553. Depends on #548 (`runOneShot`, `trusted-session`). Blocks #550.
Base: `povai/main` @ d81bd579. Line numbers below are for that commit and have drifted from the issue's.
Prior verdicts consulted: `docs/spikes/0.4-slash-stdin.md` (a `/compact\r` written to a PTY is processed by the TUI; plain stdin is not).

## Problem

Calls that act on an existing Claude session resume it in a separate `claude -p`
process even when a PTY supervisor session for the same conversation is alive. Two
processes then write the same transcript, and the live session never sees the
compaction or the memory save it was asked for. Separately, the memory save at stop
runs in the `claudeclaw stop` CLI process, not in the daemon, so the daemon has no
point where a live session is asked to save before it goes away.

## Current behaviour

| Route | Code | Mechanism |
|---|---|---|
| `compact` | `src/runner.ts:1573` `runCompact` (`-p /compact --resume`, spawn through `runClaudeOnce`) | callers: `compactCurrentSession` `:1607`, `compactCurrentThreadSession` `:1736`, auto-compact `:2573` |
| `memory.save.precompact` | `src/runner.ts:2552` (`runClaudeOnce` with `-p --resume`) | only inside the exit-124 auto-compact branch `:2545` |
| `rotation.summary` | `src/rotation.ts:78` `generateSummary`, spawn `:92`, no tool restriction | `rotateSession` `:39` (callers `runner.ts:1835`, `:2775`); the bus path `src/bus/runtime-mount.ts:502` passes the already-rotated (not live) session id |
| `memory.save.stop` | `src/commands/stop.ts:36` `preShutdownMemorySave`, called at `:84` before SIGTERM | `claude -p --resume --dangerously-skip-permissions` from the CLI process |

Daemon `shutdown()` (`src/commands/start.ts:721`): drain (`drainActiveTurns`, `:744`)
-> plugins/adapters/web/kanban/alert buffer -> `busRuntimeHandle.stop()` (`:786`) ->
`process.exit`. A second SIGTERM sets `abortDrain` (`:725-728`). No step asks a live
PTY session to save memory. `stopGraceMs(drainMs) = drainMs + 5000` (`src/pid.ts:376`)
is how long `claudeclaw stop` waits before SIGKILL.

Supervisor (`src/runner/pty-supervisor.ts`): `runOnPty` (`:752`) is the only way to run
a turn on an entry; per-key serial lock in `runOnAdmittedEntry` (`:853`); no
read-only "is this key live and idle" accessor. PTY session keys are `thread:<id>`,
`agent:<name>`, `global` (`runner.ts:2071`).

## Target behaviour

1. `sendToLiveSession(sessionKey, text, { timeoutMs, signal? })` in the supervisor. When an
   entry exists for the key, has a live process, is not retiring/ephemeral/busy, write the
   text as one turn and resolve on end of turn with the turn text. Otherwise return
   `not-live` (with a reason) and spawn nothing.
2. `runCompact`, the pre-compact memory save and the rotation summary try the live
   session first; on `not-live` they call `runOneShot({ route, isolation: "trusted-session",
   resumeSessionId, ... })` from #548. The pre-compact save skips the live path when the
   session is wedged (timed out). The rotation one-shot fallback carries
   `allowedTools: ["Write"]`.
3. The stop-time memory save moves into the daemon: after `drainActiveTurns`, before
   `busRuntimeHandle.stop()`, each live session is asked to save its memory, bounded by
   `shutdown.drainTurnsMs`. A second SIGTERM aborts the save as it aborts the drain.
4. `claudeclaw stop` spawns no `claude` when a daemon is running. It keeps a `runOneShot`
   save only when no daemon is running (PID file present, process dead).

## Frozen decisions

1. **Result shape.** `sendToLiveSession` returns a discriminated union:
   `sent` (text, sessionId, cleanBoundary) | `not-live` (reason: `no-entry`, `no-process`,
   `busy`, `retiring`, `ephemeral`, `shutting-down`) | `failed` (error, `timedOut`, `aborted`).
   Rationale: callers must tell "fall back to one-shot" (`not-live`) from "the live turn was
   attempted and failed" (`failed`: do not start a second process on the same transcript).
2. **Busy means `not-live`.** The helper never queues behind a running turn. Spec says
   "idle, otherwise `not-live`"; the caller falls back, as before this change.
3. **Idle is tracked, not inferred.** `PtyEntry.activeTurns` counts lock holders, incremented
   where the per-key lock is installed and decremented exactly once on release. The lock
   promise alone cannot be inspected synchronously.
4. **A timed-out live send retires the entry.** A turn timeout can leave the sentinel in
   claude's input buffer (the Ctrl-U cleanup only runs on a completed turn). Retiring makes
   the next `runOnPty` on the key spawn fresh and `--resume` from disk, which is what
   `runTurnWithRetries` already does after a timeout. No one-shot fallback after `failed`.
5. **One budget for drain plus save.** The memory save gets what is left of
   `shutdown.drainTurnsMs` after the drain. `stopGraceMs` (`drainMs + 5s`) is unchanged, so
   `claudeclaw stop`, `stopAll` and `--replace-existing` still wait long enough and the
   documented systemd `TimeoutStopSec` guidance still holds. `drainTurnsMs = 0` ("stop at
   once") also skips the save, consistent with that setting's meaning.
6. **Which sessions are saved.** Live supervisor entries keyed `global` or `agent:<name>`
   (the two kinds with a memory file: `getMemoryPath(agentName?)`). `thread:*` and
   `fallback:*` entries are skipped: they have no memory file of their own and writing the
   shared one from a thread would clobber it. Bus `pty-stdin` agents are not supervisor
   entries and are out of scope (#361/#402 untouched), as they were not saved at stop before.
7. **Saves run in parallel with a cap of 4** (dependency-injectable), so "a second SIGTERM
   skips the remaining saves" means: in-flight waits are abandoned and unstarted ones never start.
8. **Legacy runtime keeps its memory save.** With `pty.enabled: false` there is no live
   session, so the daemon falls back to `runOneShot({ route: "memory.save.stop" })` for the
   global session (no process holds it, so no second writer). Skipped when the bus runtime is
   mounted, whose agents own their sessions.
9. **Rotation retires the live entry.** After the summary and `resetSession()`,
   `rotateSession` calls `retirePtySession("global")`. Without it a live PTY keeps the old
   conversation and the rotation does nothing in PTY mode (adjacent fix, required for the
   live summary to be sound: the live session now also holds the summary exchange).
10. **Prompts are unchanged.** The existing memory-save, compact and summary prompt texts are
    reused verbatim; only the transport changes.
11. **`runOneShot` is consumed from #548; no local copy.** The interface frozen at `dede882b`
    has no `cwd`, but `claude --resume` finds a session by its working directory and
    `runCompact` resumes agent/thread sessions with `cwd = agents/<name>`. Asked the
    coordinator (answer: add it to #548): `OneShotRequest.cwd?: string`, honoured only for
    `trusted-session`, rejected by `runOneShot` for `untrusted`. There is no `api`/`baseEnv`
    field: the `print` engine derives api, env and security args from settings, as
    `runClaudeOnce` does today. #549 codes against `cwd?: string`.
12. **Memory saves pass `allowedTools: ["Write"]`.** The old stop-time save forced
    `--dangerously-skip-permissions` so the write could not be refused. The one-shot
    engine builds its own permission flags, so the Write the save needs is requested
    explicitly instead of relying on a bypass.

## Key files

- `src/runner/pty-supervisor.ts`: `sendToLiveSession`, `liveSessionKeys`, `activeTurns`.
- `src/runner/live-session-actions.ts` (new): live-then-fallback helpers for compact,
  memory save and summary.
- `src/runner.ts`: `runCompact`, callers, pre-compact save.
- `src/rotation.ts`: `generateSummary`, `rotateSession`.
- `src/shutdown-memory-save.ts` (new): the daemon-side save.
- `src/commands/shutdown-sequence.ts` (new): ordered teardown, used by `start.ts`.
- `src/commands/start.ts`: `shutdown()` delegates ordering.
- `src/commands/stop.ts`: no spawn when a daemon is running.
- Tests: `src/__tests__/pty-send-to-live.test.ts`, `live-session-actions.test.ts`,
  `shutdown-memory-save.test.ts`, `shutdown-sequence.test.ts`, `stop-no-spawn.test.ts`,
  `rotation-summary.test.ts`.

## Out of scope

- Changing defaults (`pty.enabled`): #550.
- Bus `pty-stdin` agents' own compaction handling (#361 / #402).
- The `oneshot` module itself, engine selection, HTTP engines: #548, #551.
- Bus restart-based rotation (`runtime-mount.ts:502`): it summarises the old, no-longer-live
  session and so stays on the one-shot path, now with `allowedTools: ["Write"]`.
- The manual `ps` check: needs a real claude on a real daemon; documented in REPORT.md for the operator.
