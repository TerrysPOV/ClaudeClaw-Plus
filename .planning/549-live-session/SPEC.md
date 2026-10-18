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
   text as one turn and resolve on end of turn with the turn text. A running turn, a spawn or
   a retirement in flight is waited out (within `timeoutMs`), never raced. `not-live` is
   returned only when no process holds the session; it spawns nothing. See decision 2.
2. `runCompact`, the pre-compact memory save and the rotation summary try the live
   session first; on `not-live` they call `runOneShot({ route, isolation: "trusted-session",
   resumeSessionId, ... })` from #548. The pre-compact save retires a wedged (timed-out)
   session and then resumes it one-shot. Fallback grants: compact and rotation summary none
   (`allowedTools: []`), memory saves Read/Write on the memory file only (decisions 12, 17-19).
3. The stop-time memory save moves into the daemon: after `drainActiveTurns`, before
   `busRuntimeHandle.stop()`, each live session is asked to save its memory, bounded by
   `shutdown.drainTurnsMs`. A second SIGTERM aborts the save as it aborts the drain.
4. `claudeclaw stop` spawns no `claude` when a daemon is running. It keeps a `runOneShot`
   save only when no daemon is running (PID file present, process dead).

## Frozen decisions

1. **Result shape.** `sendToLiveSession` returns a discriminated union:
   `sent` (text, sessionId, cleanBoundary) | `not-live` (reason: `no-entry`, `no-process`,
   `ephemeral`) | `failed` (error, `timedOut`, `aborted`). `not-live` means NO process holds
   the session, so the caller may resume it one-shot; `failed` means the live session could
   not be used and a fallback is forbidden. (Review fix; the first version also had `busy`,
   `retiring` and `shutting-down` as `not-live`.)
2. **A live process is never raced (review fix, HIGH).** If any process may still hold the
   session, `sendToLiveSession` waits for it instead of reporting `not-live`, and the
   one-shot is never taken. One budget (`timeoutMs`) covers the wait plus the turn. The
   decision for every state:

   | State of the key | Result | Why |
   |---|---|---|
   | no entry | `not-live` / `no-entry` | no process is tracked; a finished retirement removes the entry |
   | entry, `scope.ephemeral` | `not-live` / `ephemeral` | a one-shot stand-in running a *fresh* session; it cannot hold the conversation asked about |
   | `retiring` | wait for the retirement, re-evaluate; wait out -> `failed` | the old process may still be alive until dispose settles; afterwards it is `no-entry` (or a replacement entry, handled in turn) |
   | supervisor `shuttingDown`, entry still tracked | same as `retiring` | shutdown marks every entry `retiring` before its first await, so the same wait applies (a separate check was dead code and was removed) |
   | `spawnInFlight` (including one whose first caller gave up) | wait for the spawn, re-evaluate; wait out -> `failed` | the spawn will land a process that `--resume`s this session |
   | pty present and alive, turn running or queued (`activeTurns > 0`) | queue on the per-key lock, send after the in-flight turn ends; wait out or abort -> `failed` | the live process owns the transcript; the abandoned slot is released only once its predecessor ends, so the lock chain stays intact |
   | pty alive, idle | send | the normal path |
   | pty null/dead, nothing running or spawning | `not-live` / `no-process` | no process is alive |
   | entry/process changed while queued | released, re-evaluated | state is re-checked under the lock |

   Residual window (inherent, same as before this change): between `not-live` and the
   one-shot's spawn, a user message can create a fresh PTY that resumes the session. Closing
   it needs a supervisor-wide reservation and is out of scope here.
   `skipLive` (a caller that knows the session is wedged, e.g. the exit-124 pre-compact save)
   no longer means "resume beside it": `actOnSession` retires the live entry (dispose
   awaited) before the one-shot starts, so the two never overlap.
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
12. **Memory saves get a grant scoped to the memory file (review fix, MEDIUM).** The old stop-time
    save forced `--dangerously-skip-permissions`, and the first version of this branch
    replaced that with an unscoped `["Write"]`; a resumed session's transcript holds
    untrusted channel text, so that let it write any path. Now `memoryFileGrant(memPath)`
    returns `tools: ["Read", "Write"]` (for `--tools`) and
    `allowedTools: ["Edit(//<abs memPath>)", "Read(//<abs memPath>)"]` (for `--allowedTools`).
    The brief guessed `Write(//path)`; the docs say otherwise, verified at
    https://code.claude.com/docs/en/permissions.md on 2026-10-18: "`Edit` rules apply to all
    built-in tools that edit files", "Claude Code checks file permissions against `Edit(path)`
    and `Read(path)` rules only. If you write a path rule for `Write` ... Claude Code accepts
    the rule but never consults it", and `//path` is "Absolute path from filesystem root"
    while a single leading slash "anchors at the settings source". `Read` is granted because
    the Write tool refuses to overwrite a file the session has not read (not stated in those
    docs; observed behaviour, kept as cheap insurance on a one-file scope). A memory path
    containing `( ) * ? [ ] { } ,` or a newline cannot be pinned to one file, so
    `memoryFileGrant` throws and the save fails closed rather than widening the rule.
    `--tools` takes bare tool names only (`claude --help`, 2.1.302), hence the separate list.
13. **`runCompact` takes an options object** (`sessionId`, `sessionKey?`, `model`,
    `timeoutMs`, `cwd?`). Its old `api`, `baseEnv`, `securityArgs` parameters are gone: the
    `print` engine derives them from settings. Known narrowing: the auto-compact path used to
    pass the routed `primaryConfig.api`; the one-shot fallback now uses `settings.api`.
14. **A live slash command that prints `Error: …` is a failed command.** `claude -p` exits
    non-zero for e.g. "Not enough messages to compact"; a live turn ends cleanly either way
    (docs/spikes/0.4-slash-stdin.md shows the TUI's own error line). `looksLikeCommandError`
    is applied only to prompts that start with `/`, never to free-form model output.
    Unverified against a real claude here; part of the manual check.
15. **`stop()` takes injectable dependencies** (`StopDeps`: pid file, one-shot saver,
    statusline and heartbeat teardown), defaulting to the real ones, so the "no claude when a
    daemon runs" test runs the real SIGTERM/wait/cleanup path without touching the project dir.
16. **Shutdown order lives in `runShutdownSequence`**, with the first-vs-second-signal logic in
    `createShutdownController`; `start.ts` supplies the steps. This is what makes "save after
    drain, before the bus stops" and "a second SIGTERM aborts the save" testable.
17. **`OneShotRequest.tools?: string[]` (additive, touches #548's `engine.ts`, `isolation.ts`,
    `print.ts`).** The rule name (`Edit`) differs from the tool that needs to run (`Write`), so
    `--tools` cannot be derived from `allowedTools` here. `print` now emits
    `--tools <tools ?? unique bare names of allowedTools>` and `--allowedTools <rules as given>`;
    `allowedTools: []` is `--tools ""` with no `--allowedTools`; `tools` alone does not fall back
    to the default permission profile; `untrusted` rejects `tools` like `allowedTools`. The flag
    construction lives in ONE function, `trustedToolFlags` (`isolation.ts`), used by both the `print`
    and the `pty` engine (`runOnceOnPty`), so they cannot drift (the automated security review caught
    the `pty` engine still joining `allowedTools` into `--tools`; `docs/oneshot-engines.md` maps
    `memory.save.stop` to `pty`). Agreed
    with the coordinator (ask: "you do it in 549"); the stacked PR shows these #548 files.
18. **Rotation summary gets no tools (review fix, MEDIUM; deliberate deviation from the issue
    text, which says `["Write"]`).** The summary returns on stdout and the daemon writes the
    file (`generateSummary`), so the resumed session needs no Write. `allowedTools: []`.
19. **`/compact` gets no tools (review fix, LOW).** It needs none; without a grant the `print`
    engine applies `buildSecurityArgs`, which can include `--dangerously-skip-permissions`.
    `runCompact` passes `allowedTools: []`.
20. **The live path keeps the live session's permissions (review item 4).** A per-call grant
    cannot be applied to a running PTY, and this change does not try. `allowedTools` / `tools`
    restrict the one-shot fallback only; documented at `actOnSession`.
21. **`stop` validates the PID file before probing or signalling (review fix, LOW).**
    `parseDaemonPid`: plain decimal digits, an integer in [1, 2^22]; `0`, `-1`, `1.5`, `1e3`,
    hex, garbage and empty are rejected with exit 1, the file left alone and nothing signalled.
    `isPidAlive` is false for non-integers and `<= 0` (`kill(0, 0)` / `kill(-1, 0)` otherwise
    "succeed"). `decideStopTarget` then reads `ps -o command= -p <pid>` and requires the daemon's shape: `<anything>/src/index.ts start ...` (`src` a whole path component, `start` directly after the entry; `bun run /opt/claudeclaw/src/index.ts start --web`, `bun --watch src/index.ts start ...`) or `claudeclaw start`. A bare `bun` is not enough (Codex P1 on PR #561: any unrelated Bun app inheriting a stale PID would have been signalled). When the process's cwd is readable (`/proc/<pid>/cwd`, else `lsof`), it must also be this project's directory, compared after `realpath`: the PID file lives under the project and the daemon never calls `chdir`, so the same entry script running elsewhere is another project's app. cwd unreadable -> the command shape alone decides. A live process that fails either test is a recycled PID and is treated as "no daemon" (stale-file path, one-shot save, never signalled). Unreadable command line -> trust
    the PID file, as before. **PID 1** (brief: reject pid <= 1) is refused unless the command
    line positively looks like the daemon, because #526 documents that in a container the
    daemon is PID 1; on a host PID 1 is init, whose command line fails the check. `stopAll`
    applies the same rules per project.
22. **Global memory save falls back when the PTY is gone at send time (Codex P2 on PR #561).**
    `saveMemoryAtShutdown` snapshots `liveKeys()` and sends later; the global process can exit or finish
    retiring in between. `sendToLiveSession` then returns `not-live`, which by decision 1 means no process
    holds the session, so the one-shot resume cannot race it: the global job now runs `fallbackSave` (once,
    with the time left) instead of recording a lost save. `failed` still never falls back (a process may
    still be writing the transcript), agent keys never use it (they have no one-shot save), and with no
    `fallbackSave` (bus runtime) it is recorded as skipped, as before. The result is reported as
    `global (one-shot)`.
23. **`--permission-mode dontAsk` lives in `trustedToolFlags` (rebase onto #548 `e8d09870`).** #548's
    production pass added `dontAsk` to the `pty` one-shot only. Decision 17 already made
    `trustedToolFlags` the single place both engines build their grant, so `dontAsk` moved there: any
    explicit grant (including `allowedTools: []`) emits `--permission-mode dontAsk` ahead of
    `--tools` / `--allowedTools`, in `print` and `pty` alike (a tool outside the grant is denied instead
    of waiting at a prompt nobody answers). No grant still emits nothing, so the default permission
    profile is unchanged. `runOnceOnPty` otherwise keeps #548's body (`runEphemeralWithDeadline`).

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
  session and so stays on the one-shot path, now with no tools (`allowedTools: []`, decision 18).
- The manual `ps` check: needs a real claude on a real daemon; documented in REPORT.md for the operator.

## Addendum: Windows memory path in the scoped grant (Codex P2 on PR #561, head 2d389fcf)

### Problem

`memoryFileGrant` (`src/memory.ts:63`) required `resolve(memPath)` to start with `/`. On Windows
`resolve` yields `C:\project\MEMORY.md`, so every memory path was refused, and the pre-compact save and
the no-daemon shutdown fallback failed before claude ran.

### Rule (code.claude.com/docs/en/permissions, "Read and Edit" path patterns)

- "`//path`: absolute path from filesystem root", for example `Edit(//tmp/scratch.txt)` for `/tmp/scratch.txt`.
- "On Windows, paths are normalized to POSIX form before matching. `C:\Users\alice` becomes
  `/c/Users/alice`, so use `//c/**/.env` to match `.env` files anywhere on that drive."

So a Windows drive path is written `//<lowercase drive letter>/<forward-slash path>`:
`C:\project\MEMORY.md` -> `Edit(//c/project/MEMORY.md)` and `Read(//c/project/MEMORY.md)`.
Fetched 2026-10-18.

### Target behaviour

`memoryFileGrant(memPath, flavour?)` resolves with `node:path` `posix` or `win32` (default from
`process.platform`), converts the absolute result to POSIX form, then prefixes `/`. The flavour argument
lets the win32 branch be tested on macOS.

### Frozen decisions

- POSIX output is unchanged (`//abs/path`).
- Only `X:\...` drive-absolute paths convert. UNC (`\\server\share`), device (`\\?\C:`) and drive-less rooted
  (`\path`) paths are refused: the docs give no form for them, and no grant is better than a guessed one.
- A relative path is still resolved against the cwd first (existing behaviour and test). It is refused only
  when that does not give an absolute path of the flavour, which is the case for `win32` on a host whose cwd has no drive.
- The glob/separator character check runs on the converted POSIX form, so `*`, `?`, `[`, `(`, `{`, `,` and
  newlines stay refused on both flavours.

### Key files

`src/memory.ts` (`memoryFileGrant`, `winDriveToPosix`), `src/__tests__/memory-save-grant.test.ts`.
Callers are unchanged: `src/shutdown-memory-save.ts:228`, `src/runner/live-session-actions.ts:155`.

### Out of scope

- A backslash in a POSIX filename is a gitignore escape in a rule. It is not newly introduced, was not part of the finding, and is left alone (noted in REPORT.md).
- Whether claude on Windows honours the converted rule: not verifiable here (no Windows host).
