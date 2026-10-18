# REPORT: #549 compact, memory saves and rotation summary in the live PTY session

Branch `feat/549-live-session-compact`, stacked on `povai/feat/548-oneshot-module` @ 0d636b6a
(which is on `povai/main` d81bd579). Spec: `.planning/549-live-session/SPEC.md`.

## What changed

| Area | Change |
|---|---|
| `src/runner/pty-supervisor.ts` | `sendToLiveSession(key, text, { timeoutMs, signal? })` -> `sent` / `not-live` (+reason) / `failed`; `liveSessionKeys()`; `PtyEntry.activeTurns` and a shared `installLock` so "idle" is observable. A live send holds the per-key lock (a user turn arriving mid-send queues behind it); an abort stops the wait but keeps the lock until the turn ends; a timeout retires the entry. |
| `src/runner/live-session-actions.ts` (new) | `actOnSession`: live session first, else `runOneShot({ isolation: "trusted-session", resumeSessionId, cwd, ... })`. No fallback after a *failed* live attempt (a second process would race the session). `looksLikeCommandError` for slash commands. |
| `src/runner.ts` | `runCompact` now takes an options object and goes through `actOnSession`; the three compact callers pass their supervisor key (`global`, `agent:<n>`, `thread:<id>`); the pre-compact memory save uses `actOnSession` with `skipLive` (the turn timed out, so the session is wedged) and `allowedTools: ["Write"]`. |
| `src/rotation.ts` | `generateSummary(sessionId, path, { sessionKey? })` via `actOnSession`; the one-shot fallback carries `allowedTools: ["Write"]` (no more full default tools). `rotateSession` asks the live global session, and after `resetSession()` retires the live `global` entry (without that a rotation does nothing in PTY mode). The bus path (`runtime-mount.ts:502`) is unchanged: it summarises an already-rotated session, so it is always the one-shot path. |
| `src/shutdown-memory-save.ts` (new) | `saveMemoryAtShutdown(budgetMs, deps)`: asks every live `global` / `agent:<n>` session to save (thread/fallback keys skipped), parallel cap 4, bounded by `budgetMs`, abortable, never throws. `saveGlobalMemoryOneShot` is the `memory.save.stop` one-shot. |
| `src/commands/shutdown-sequence.ts` (new) + `start.ts` | `shutdown()` is now drain -> **save memory** -> teardown -> `busRuntimeHandle.stop()` -> finalize. The save gets what is left of `shutdown.drainTurnsMs`, so `stopGraceMs` is unchanged. A second SIGTERM aborts the drain and the save through one controller. With no live PTY (legacy `-p` runtime, no bus runtime) the daemon falls back to the one-shot save so that runtime keeps what `stop` used to do. |
| `src/commands/stop.ts` | No `claude` spawn when a daemon is running. A one-shot save only when the PID file names a dead process. `stop(deps?)` takes injectable deps for the test. |
| `README.md` | One sentence in the drain paragraph. |
| `.claude-plugin/*.json` | 2.2.337 -> 2.2.338 (both bump scripts run). |

## Acceptance criteria -> tests

| Criterion | Test |
|---|---|
| `sendToLiveSession`: live idle entry writes one turn and resolves on end of turn; no entry -> `not-live`, no spawn | `pty-send-to-live.test.ts` "writes ONE turn…", "returns not-live without spawning…" |
| `runCompact`: live entry -> no spawn, `/compact` in the PTY; no entry -> `runOneShot` with `trusted-session` + session id | `live-session-actions.test.ts` `runCompact` (4 tests) |
| Shutdown order: saves after the drain resolves, before the bus stops; second SIGTERM skips remaining saves | `shutdown-sequence.test.ts` (order test with deferred drain/save; real `saveMemoryAtShutdown` + controller for the double signal) |
| `stop`: running daemon -> no `claude` spawned | `stop-no-spawn.test.ts` (real `sleep` child as the daemon, `Bun.spawn` spied, CLI saver spied) |
| Rotation: one-shot fallback carries `allowedTools: ["Write"]` | `live-session-actions.test.ts` `generateSummary` |
| Manual `ps` check | **Not run here**, procedure below |

## Test runs

New tests (43): `pty-send-to-live` 11, `shutdown-memory-save` 8, `shutdown-sequence` 5, `stop-no-spawn` 3, `live-session-actions` 16.

Scoped regression, 19 files (the new five plus runner, pty-supervisor, pty-supervisor-mcp, pty-backward-compat,
pty-enabled-routing, pty-integration, sessions, pid-lock, pid-wait, config-shutdown-drain, bus rotate-agent / shutdown-drain / runtime-mount, oneshot engine):

```
env -u ANTHROPIC_BASE_URL bun test <those 19 files>
 315 pass
 0 fail
Ran 315 tests across 19 files.
```

Without `env -u`, one pre-existing test fails here: `pty-supervisor.test.ts` "non-glm model with no api leaves
ANTHROPIC_AUTH_TOKEN unset" sees `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` inherited from this shell (a local
proxy). Environmental: the file passes 76/0 with the variable unset. Not related to this change.

The full suite was not run (known cross-test pollution), as instructed.

## Lint and typecheck

- `bun run lint` (whole repo): exit 0. Warnings 1233 (before) -> 1243 (after). The files I created have zero diagnostics.
  The +10 appeared when the branch was rebased onto #548; I did not break them down further. The existing diagnostics
  in files I edited (e.g. `useNodejsImportProtocol` on untouched import lines) are unchanged.
- `bun run typecheck` (ratchet): `149 error(s), baseline 149` before and after. Not re-baselined.

## Fault injection (RED lines)

One site at a time; the file was restored from a backup after each run and compared with `cmp`. Lines are the
runner's `(fail)` lines verbatim (timing suffix dropped). Four injections (F1, F5, G3, G7) go red by the 5 s test
timeout rather than an assertion, because the fake turn / abortable send never resolves once the guard is gone.

**Supervisor** (`pty-send-to-live.test.ts`)

| Fault | RED |
|---|---|
| F1 remove the `activeTurns > 0` busy refusal | `(fail) sendToLiveSession > returns not-live (busy) while a turn is running and does not write` |
| F2 do not take the lock in `sendToLiveSession` | `(fail) sendToLiveSession > holds the per-key lock: a runOnPty issued mid-send waits for the send to end` |
| F3 drop `previousLock.finally(release)` on `runOnPty`'s wait-timeout branch | `(fail) sendToLiveSession > is idle again after a send, and after a runOnPty that gave up waiting on its predecessor` (`Expected: "sent"` / `Received: "not-live"`) |
| F4 do not retire the entry on a timeout | `(fail) sendToLiveSession > on a turn timeout reports failed+timedOut and retires the entry (no fallback signal)` (`Expected: true` / `Received: false`) |
| F5 release the lock on abort | `(fail) sendToLiveSession > an abort stops the wait at once but keeps the lock until the turn really ends` |

**Daemon save** (`shutdown-memory-save.test.ts`)

| Fault | RED |
|---|---|
| G1 do not skip keys with no memory file | `(fail) saveMemoryAtShutdown > sends the save prompt, naming the memory file, to every global/agent live session` |
| G2 fallback even with a live global | `(fail) saveMemoryAtShutdown > uses the fallback for the global session only when no live global session exists` (`Expected: 1` / `Received: 2`) |
| G3 worker loop ignores the abort | `(fail) saveMemoryAtShutdown > a second SIGTERM aborts the in-flight wait and never starts the remaining saves` |
| G5 no "no time left" guard | `(fail) saveMemoryAtShutdown > issues nothing when no time is left (drain used the whole budget, or drainTurnsMs is 0)` (`Expected: 0` / `Received: 1`) |
| G6 per-send timeout = 2x budget | `(fail) saveMemoryAtShutdown > passes each send only the time that is left, never more than the budget` (`Expected: <= 5000` / `Received: 10000`) |
| G7 budget timer does not abort | `(fail) saveMemoryAtShutdown > stops waiting at the budget and aborts the sends it still has in flight` |

**Shutdown order** (`shutdown-sequence.test.ts`)

| Fault | RED |
|---|---|
| H1 save before drain | `(fail) runShutdownSequence > runs drain, then save, then teardown, then bus stop, then finalize` and `… > issues save requests only after the drain resolves, and the bus stops only after the save` |
| H2 stop the bus before the save | same two tests |
| H3 a throwing save propagates | `(fail) runShutdownSequence > a failing drain or save never prevents the teardown` |
| H4 second signal does not abort | `(fail) createShutdownController > the first request starts the shutdown, every later one aborts it` and `(fail) shutdown with the real memory save > a second SIGTERM mid-save skips the remaining saves and the teardown still runs` |

**`stop`** (`stop-no-spawn.test.ts`)

| Fault | RED |
|---|---|
| S1 CLI-side save unconditionally | `(fail) stop() > with a running daemon, spawns no claude and runs no CLI-side save` (`Expected: 0` / `Received: 1`) |
| S2 liveness check inverted | that test, and `(fail) stop() > with a PID file naming a dead process (no daemon), keeps the one-shot save` |
| S3 inline `Bun.spawn(["claude", ...])` before SIGTERM | `(fail) stop() > with a running daemon, spawns no claude and runs no CLI-side save` (`toEqual`) |

S3 really launched `claude -p "save memory"` once (the spy forwards to the real spawn). I checked afterwards:
no such process was left running and `git status` showed no stray changes.

**Live/fallback + rotation** (`live-session-actions.test.ts`)

| Fault | RED |
|---|---|
| L1 never try the live session | `(fail) runCompact > with a live entry: writes /compact into the PTY and spawns no claude of its own` (+3 more) |
| L2 fall back after a failed live attempt | `(fail) actOnSession > does NOT fall back after a live attempt failed: a second process would race the session` (`Expected: false` / `Received: true`) |
| L3 ignore `skipLive` | `(fail) actOnSession > memory.save.precompact: a wedged (timed-out) session skips the live path` (`Expected: "oneshot"` / `Received: "live"`) |
| L4 drop `allowedTools` from the one-shot | `(fail) generateSummary (rotation.summary) > the one-shot fallback carries allowedTools: ["Write"] and resumes the old session` (+ the precompact test) |
| L5 drop `cwd` | `(fail) runCompact > with no entry: calls runOneShot as a trusted-session resume of the session id` |
| L6 error heuristic off | `(fail) looksLikeCommandError > a live /compact that prints the error is a failed compact, not a success` |
| L10 `isolation: "untrusted"` | `(fail) runCompact > with no entry: calls runOneShot as a trusted-session resume of the session id` (+2) |
| L7 `rotateSession` does not retire the live entry | `(fail) rotateSession > summarises through the live session, resets, then retires the live global entry` |
| L8 `generateSummary` drops `sessionKey` | `(fail) generateSummary (rotation.summary) > with a live session, asks it for the summary and runs no one-shot` (`Expected: "live summary"` / `Received: "one-shot text"`) |
| L9 `rotateSession` passes no key | `(fail) rotateSession > summarises through the live session, resets, then retires the live global entry` |

## Decisions that went past the issue text (all in SPEC.md, "Frozen decisions")

- `OneShotRequest.cwd` was missing from the #548 interface and `claude --resume` finds a session by its cwd, so
  agent/thread compaction would have failed in the fallback. Asked the coordinator; answer was to add it to #548
  (it is there now at 0d636b6a and `print` honours it for `trusted-session`).
- One budget for drain + save (`drainTurnsMs`), so `stopGraceMs` and the systemd guidance stay valid. `drainTurnsMs: 0` skips the save.
- Only `global` and `agent:<name>` sessions are saved at shutdown (the ones with a memory file). Thread sessions are skipped.
- `rotateSession` now retires the live `global` entry. This is an adjacent fix to the rotation path, needed for the live summary to be sound.
- Memory saves pass `allowedTools: ["Write"]` (the old call forced `--dangerously-skip-permissions`). In the `print` engine that is `--tools Write --allowedTools Write`.

## Left undone / known limits

- **Manual `ps` check (required by #549): not run, cannot be run here.** Procedure below.
- **Not verified against a real claude:** that the sentinel round-trip behaves while `/compact` is running (the spike `docs/spikes/0.4-slash-stdin.md`
  shows `/compact\r` is processed by the TUI, but not the quiet-window/sentinel interaction during a long compaction), and that
  `looksLikeCommandError` matches the real TUI error text. Both are covered by the manual check.
- Auto-compact used to pass the routed `primaryConfig.api` to the spawn; the one-shot fallback now uses `settings.api` (the `print` engine derives it).
- The pre-compact save's live path exists in the helper and is tested, but its single call site (the exit-124 branch) always sets `skipLive`,
  so in production it is always the one-shot there. That is what the issue asks for ("on a timed-out session, skip the live path").
- Bus `pty-stdin` agents are not supervisor entries and get no shutdown save (they did not before either).
- The CLI-side `stop` path with a *stale* PID file keeps a one-shot save. `stopAll` never had one.
- Prior art: the brief says ClaudeClaw-Ultra has no equivalent (no one-shot module, no `sendToLiveSession`). I did not read it myself and reused nothing from it.
- `.swarm/` and `ruvector.db` appeared untracked in the worktree during the run (not created by this work); they are not committed.

## Manual check for the operator (`ps`)

Use a scratch project directory, not production.

1. Settings: `"pty": { "enabled": true }` in `.claude/claudeclaw/settings.json`. Start the daemon: `bun run src/index.ts start`.
2. Send 3 or 4 messages through a channel (Telegram/Discord) so a global PTY session exists with enough history to compact.
3. Baseline in a second terminal: `ps -axo pid,etime,command | grep '[c]laude'`. Expect one interactive `claude` (the PTY child) and **no** `claude -p`. Note its PID.
4. Start a watcher: `while true; do pgrep -fl 'claude.* -p' ; sleep 0.3; done` (prints nothing while healthy).
5. From the channel send `/compact`. Expect: the watcher stays silent, the PTY child keeps the same PID, the daemon log has
   `compact: done in the live session (global)` and **no** `[oneshot] {"route":"compact"...}` line.
6. One writer on the transcript: `lsof ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl` shows a single `claude` PID,
   and the JSONL gains a `<command-name>/compact</command-name>` entry.
7. Error text: on a brand-new session send `/compact` and confirm the reply is the failure message, not a success.
8. Shutdown: run `claudeclaw stop`. Expect no new `claude -p` in the watcher, daemon log lines
   `[shutdown] saving memory for 1 session(s) (global)` then `memory save done … 1 saved`, `MEMORY.md` mtime updated, then the daemon exits.
9. Negative control: `kill -9` the PTY child (no live session), send `/compact`. Expect `compact: global is not live (no-process) — one-shot resume`,
   a `[oneshot] {"route":"compact",…}` log line, and `claude -p /compact --resume …` visible in the watcher. That proves the fallback still works.
