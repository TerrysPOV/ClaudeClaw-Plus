# REPORT: #549 compact, memory saves and rotation summary in the live PTY session

Branch `feat/549-live-session-compact`, stacked on `povai/feat/548-oneshot-module` @ 0d636b6a
(which is on `povai/main` d81bd579). Spec: `.planning/549-live-session/SPEC.md`.

## Review-fix pass (Codex deep review + security review; no CRITICAL)

Rebased onto the **final** #548 (`povai/feat/548-oneshot-module` @ 7898a063, PR #560), which already had stdin-only untrusted prompts and
capability gating, then new commits on top.

**History note.** That rebase rewrote the first-pass commits. The remote tip before this pass was **8975876c**; the coordinator approved
`git push --force-with-lease=feat/549-live-session-compact:8975876c povai HEAD:feat/549-live-session-compact` (no PR existed for the branch).
The old tip stays recoverable from this machine's reflog. `git log povai/feat/548-oneshot-module..HEAD` shows only #549 commits.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | HIGH | A busy live session fell back to a one-shot resume of the same session: two writers, the bug #549 exists to fix | `sendToLiveSession` waits instead (per-key lock, in-flight spawn, retirement), one `timeoutMs` budget for wait + turn; wait out / abort -> `failed`, **no fallback**; `not-live` only when no process holds the session. `skipLive` now retires the live entry (dispose awaited) before the one-shot. Per-state decision table: SPEC.md decision 2 | `pty-send-to-live.test.ts` (20), `live-session-actions.test.ts` busy cases |
| 2 | MEDIUM | `allowedTools: ["Write"]` was unscoped | `memoryFileGrant`: `--tools Read,Write`, `--allowedTools Edit(//<abs memPath>),Read(//<abs memPath>)`. **The brief's `Write(//path)` is wrong**: the docs say path rules are checked as `Edit(path)`/`Read(path)` only and a `Write(path)` rule is accepted but never consulted (verified at code.claude.com/docs/en/permissions.md, 2026-10-18). A path with glob/paren/comma/newline characters fails the save closed | `memory-save-grant.test.ts`, `session-actions-argv.test.ts` |
| 3 | MEDIUM | Rotation summary did not need Write (the daemon writes the file) | `allowedTools: []`. **Deliberate deviation from the issue text (`["Write"]`); narrower and safer** | `session-actions-argv.test.ts`, `live-session-actions.test.ts` |
| 4 | MEDIUM | The live path keeps the live session's full permissions | Not changed, as instructed. Documented at `actOnSession` and in SPEC decision 20: `allowedTools`/`tools` restrict the one-shot fallback only | comment only |
| 5 | LOW | `stop` could signal pid 0 / -1 / a recycled PID | `parseDaemonPid` (digits only, 1..2^22), `isPidAlive` false for `<= 0`/non-integers, `decideStopTarget` checks `ps -o command= -p` for `claudeclaw`/`bun`/`index.ts`; a non-daemon is treated as "no daemon" and never signalled; unreadable command line -> old behaviour. `stopAll` likewise | `stop-pid-validation.test.ts` (21) |
| 6 | LOW | Compact fallback could run with the bypass flag | `allowedTools: []` | `session-actions-argv.test.ts` |
| sec | MEDIUM | Automated security review of the pushed commit: #548's `pty` engine (`runOnceOnPty`) still joined `allowedTools` into `--tools` and treated `[]` as a grant of one empty entry, so scoped rules would break (or fail open) when a route is mapped to `pty`; `docs/oneshot-engines.md` maps `memory.save.stop` to `pty` | One shared `trustedToolFlags` in `isolation.ts`, used by `print` **and** `pty`; `[]` there now also means no tools and no default profile | `oneshot-pty-tools.test.ts` (5), incl. "matches the print engine flag for flag" |

**Things to know**

- **PID 1 refinement (item 5).** The brief says reject pid <= 1. #526 documents that in a container the daemon *is* PID 1, so a flat
  rejection would break `claudeclaw stop` there. PID 1 is refused unless its command line positively looks like the daemon; on a host it is
  init and fails the check. 0, -1, 1.5, hex, garbage and empty are rejected outright.
- **New optional field `OneShotRequest.tools?: string[]` (touches #548 files).** `--tools` takes bare tool names only (`claude --help`, 2.1.302),
  but the rule that scopes Write is named `Edit`, so `--tools` cannot be derived from `allowedTools` here. `src/oneshot/engine.ts`,
  `isolation.ts` and `print.ts` changed accordingly (untrusted still never takes a grant). The coordinator agreed to patch `print.ts` on this branch
  ("you do it in 549"); **the stacked PR will show these #548 files**. The explicit `tools` field was my addition on top of that instruction.
- `Read(//path)` is granted because the Write tool refuses to overwrite a file the session has not read. The docs I could read do not state
  that, so it is observed behaviour kept as insurance on a one-file scope.
- **Not verified against a real claude:** that `claude -p --tools "" ...` (empty value) and `--allowedTools "Edit(//path),Read(//path)"` behave as the
  docs describe. The argv is asserted, the CLI is not run. Add to the manual check.
- A wrapper bug of mine invalidated one batch of fault injections (the test paths were passed as one quoted argument, so no test ran). I noticed
  because no `(fail)` lines came back, discarded the batch and re-ran it; every RED line below is from a run that actually executed tests.
- Fault injection found two dead-code / untested spots: the separate `shuttingDown` check was unreachable (shutdown marks every entry `retiring` first),
  so it was removed, and the lock chain after an abandoned wait had no test, so one was added (A8).

**Tests (this pass)**

```
env -u ANTHROPIC_BASE_URL bun test <the 19 original files + session-actions-argv, memory-save-grant, oneshot-print-tools,
  oneshot-pty-tools, stop-pid-validation + the other oneshot importers: oneshot e2e, agents, discord-classifier-isolation,
  tuner skills-fitness and memory-quality-judge>
 527 pass, 1 skip (the opt-in e2e), 0 fail  (29 files)
```
`bun run lint` (whole repo): exit 0, 1252 warnings (1243 before the rebase onto the final #548; none are on lines I changed). One formatting error in a new test file was caught and fixed before the final run. Typecheck ratchet: `149 error(s), baseline 149`, unchanged.
Version: this branch is 2.2.338; `povai/main` is 2.2.336 and #548 is 2.2.337, so no re-bump was needed.

**Fault injections, one site at a time** (file restored from a backup and `cmp`-checked after each; first `(fail)` line per run)

| Site | Fault | RED |
|---|---|---|
| 1 | A1 wait timeout returns `not-live` | `(fail) sendToLiveSession > busy past the timeout: failed (no not-live), and the abandoned send is never written later` |
| 1 | A3 skip the retirement wait | `(fail) sendToLiveSession > an entry being retired: waits until its process is gone; then no-entry (safe to fall back)` |
| 1 | A4 skip the in-flight spawn wait | `(fail) sendToLiveSession > a spawn whose caller gave up is still in flight: waits for it, never not-live` |
| 1 | A5 no re-check under the lock | `(fail) sendToLiveSession > the process dies while the send is queued: not-live, nothing written to the dead PTY` |
| 1 | A6 give the turn the full budget | `(fail) sendToLiveSession > the wait and the turn share ONE budget: the turn gets only what the wait left` |
| 1 | A7 busy -> `not-live` | `(fail) sendToLiveSession > busy: queues behind the running turn, then sends live; never reports not-live` (+4) |
| 1 | A8 release the abandoned slot at once | `(fail) sendToLiveSession > busy past the timeout: failed (no not-live), and the abandoned send is never written later` |
| 1 | B1 no retire before the wedged one-shot | `(fail) actOnSession > memory.save.precompact: a wedged (timed-out) session skips the live path, and its process is gone BEFORE the one-shot` |
| 1 | B2 timed-out wait falls back | `(fail) actOnSession > busy past the timeout: ok:false with a clear detail and ZERO one-shot calls` |
| 1 | B3 any `failed` falls back | same test, plus `(fail) actOnSession > does NOT fall back after a live attempt failed: a second process would race the session` |
| 2 | M1 single slash instead of `//` | `(fail) memoryFileGrant > scopes Edit and Read rules to the absolute memory path (double slash = filesystem root)` (+4) |
| 2 | M2 `Write(...)` rule instead of `Edit(...)` | `(fail) memoryFileGrant > never emits a bare tool name or a Write(...) path rule` (+4) |
| 2 | M3 drop the `Read(...)` rule | `(fail) memoryFileGrant > scopes Edit and Read rules to the absolute memory path (double slash = filesystem root)` (+2) |
| 2 | M4 no refusal of unscopable paths | `(fail) memoryFileGrant > refuses a path the rule syntax cannot pin to one file (glob, parenthesis, comma, newline)` |
| 2 | M5 request builder drops `tools` | `(fail) memory save one-shot request -> argv > resumes the session with Read,Write available and only the memory file pre-approved` |
| 2 | M6 pre-compact helper drops `tools` | `(fail) pre-compact memory save fallback argv > resumes with Read,Write available and only the memory file pre-approved` |
| 2 | M7 pre-compact helper drops `allowedTools` | same test |
| 2 | M8 pre-compact helper skips the scope check | same test, plus `(fail) pre-compact memory save fallback argv > a memory path that cannot be scoped fails the save and spawns nothing` |
| 2 | M9 `actOnSession` drops `tools` | `(fail) pre-compact memory save fallback argv > resumes with Read,Write available and only the memory file pre-approved` |
| engine | P0 tools-only falls back to the default profile | `(fail) print engine with an explicit tool list only > does not fall back to the default permission profile (which can carry the bypass flag)` |
| engine | P1 rules passed to `--tools` | `(fail) buildPrintArgs tool flags (trusted-session) > without explicit tools, --tools is the unique bare names of the allowed entries` |
| engine | P2 `[]` still emits `--allowedTools` | `(fail) buildPrintArgs tool flags (trusted-session) > allowedTools [] means no tools: --tools '' and no --allowedTools at all` |
| engine | P3 ignore explicit `tools` | `(fail) buildPrintArgs tool flags (trusted-session) > explicit tools + scoped rules: --tools is the bare list, --allowedTools the rules as given` (+1) |
| engine | P4 no de-duplication | `(fail) buildPrintArgs tool flags (trusted-session) > without explicit tools, --tools is the unique bare names of the allowed entries` |
| engine | P5 untrusted accepts `tools` | `(fail) buildPrintArgs untrusted > rejects tools just like allowedTools: untrusted calls never take a grant` |
| sec | Q1 `pty` engine builds its own flags again | `(fail) pty engine tool flags > explicit tools + scoped rules: --tools is the bare list, --allowedTools the rules` (+3) |
| sec | Q2 `pty` engine always uses the default profile | same four tests |
| sec | Q3 shared helper puts rules in `--tools` | `(fail) buildPrintArgs tool flags (trusted-session) > without explicit tools, --tools is the unique bare names of the allowed entries` and `(fail) pty engine tool flags > a rule list without explicit tools derives unique bare names` |
| sec | Q4 shared helper emits `--allowedTools` for `[]` | `(fail) buildPrintArgs tool flags (trusted-session) > allowedTools [] means no tools: --tools '' and no --allowedTools at all` and the `pty` twin |
| sec | Q5 shared helper turns "no grant" into `--tools ""` | `(fail) buildPrintArgs tool flags (trusted-session) > no grant given: neither flag (the caller gets the default permission profile)` and `(fail) pty engine tool flags > no grant at all: the default permission profile applies, as before` |
| 3, 6 | (RED before the fix) rotation granted `Write`; compact passed no `--tools` | `Expected: ""` / `Received: "Write"` (rotation) and `Expected: ""` / `Received: undefined` (compact), in `session-actions-argv.test.ts` before the change |
| 5 | N1 drop the `isPidAlive` guard | `(fail) isPidAlive > is false for pids that would address a process group or everyone` |
| 5 | N2 lenient parse | `(fail) parseDaemonPid > rejects 0, negatives, fractions, exponents, hex, garbage, empty and huge values` |
| 5 | N3 accept 0 | same, plus `(fail) stop() with a bad PID file > PID file "0": nothing is probed or signalled, no save, exit 1, file left alone` |
| 5 | N4 no command-line check | `(fail) decideStopTarget > some other program -> not-daemon (a recycled PID), never ok` (+2) |
| 5 | N5 trust PID 1 | `(fail) decideStopTarget > pid 1 is only ever the daemon when its command line says so (container case, #526)` (+1) |
| 5 | N6 refuse when the command is unreadable | `(fail) decideStopTarget > command line unreadable -> ok (falls back to the PID file alone, as before)` |
| 5 | N7 `stop` ignores an invalid PID | `(fail) stop() with a bad PID file > PID file "0": ...` (+5) |
| 5 | N8 `stop` signals a recycled PID | `(fail) stop() with a bad PID file > a live process whose command line is not the daemon: not signalled, treated as no daemon` |
| 5 | N9 recycled PID skips the one-shot save | same test |

Two of the `stop()` injections (N4, N8) go red through the 5 s test timeout, not an assertion: the test's `process.kill` mock never really signals, so the
`waitForPidExit` that follows the injected fault never sees the process leave.

**Still not done / for the operator**

- The manual `ps` check (procedure below) was not run. Add: confirm a busy session's `/compact` waits and then runs in the live PTY with no `claude -p`
  in the watcher, and that `--tools "" ` / the scoped `Edit(//...)` rule are accepted by the installed `claude`.
- The residual window noted in SPEC decision 2 (a user message creating a fresh PTY between `not-live` and the one-shot's spawn) is unchanged.
- Prior art (ClaudeClaw-Ultra): still not read; nothing reused.

---

## What changed

| Area | Change |
|---|---|
| `src/runner/pty-supervisor.ts` | `sendToLiveSession(key, text, { timeoutMs, signal? })` -> `sent` / `not-live` (+reason) / `failed`; `liveSessionKeys()`; `PtyEntry.activeTurns` and a shared `installLock` so "idle" is observable. A live send holds the per-key lock (a user turn arriving mid-send queues behind it); an abort stops the wait but keeps the lock until the turn ends; a timeout retires the entry. |
| `src/runner/live-session-actions.ts` (new) | `actOnSession`: live session first, else `runOneShot({ isolation: "trusted-session", resumeSessionId, cwd, ... })`. No fallback after a *failed* live attempt (a second process would race the session). `looksLikeCommandError` for slash commands. |
| `src/runner.ts` | `runCompact` now takes an options object and goes through `actOnSession`; the three compact callers pass their supervisor key (`global`, `agent:<n>`, `thread:<id>`); the pre-compact memory save uses `actOnSession` with `skipLive` (the turn timed out, so the session is wedged) and `allowedTools: ["Write"]`. |
| `src/rotation.ts` | `generateSummary(sessionId, path, { sessionKey? })` via `actOnSession`; the one-shot fallback now grants NO tools (`allowedTools: []`; see the review-fix section: narrower than the issue's `["Write"]` on purpose). `rotateSession` asks the live global session, and after `resetSession()` retires the live `global` entry (without that a rotation does nothing in PTY mode). The bus path (`runtime-mount.ts:502`) is unchanged: it summarises an already-rotated session, so it is always the one-shot path. |
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
| Rotation: one-shot fallback carries a narrowed tool grant | `live-session-actions.test.ts` `generateSummary` + `session-actions-argv.test.ts`. **Deviation:** the issue says `["Write"]`; it is now `[]` (no tools), see the review-fix section |
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
| F1 *(first pass; the busy->not-live behaviour was a bug and was replaced, see the review-fix section)* remove the `activeTurns > 0` busy refusal | `(fail) sendToLiveSession > returns not-live (busy) while a turn is running and does not write` |
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
| L4 *(first pass; superseded: the rotation grant is now `[]`)* drop `allowedTools` from the one-shot | `(fail) generateSummary (rotation.summary) > the one-shot fallback carries allowedTools: ["Write"] and resumes the old session` (+ the precompact test) |
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
- Memory saves: superseded by the review fix. They get Read/Write on the one memory file only (`Edit(//<abs path>)` + `Read(//<abs path>)`), not a bare `Write`.

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
