# #595 — bus agent session not resumed after a restart ("already in use")

Branch `fix/595-bus-session-resume`, off `4e491076` (the #562 soak head). Nothing is pushed to `feat/550-pty-default`.

## Verdict

**Cause 1 is the verified cause. Causes 2 and 3 are ruled out as the source of this symptom.**
The fault is inside ClaudeClaw, and the fix needs no change to the #562 fence/quarantine design, so the stop condition does not apply.

The bus spawns every agent with `--session-id <stored id>` (create). The CLI treats `--session-id <id>` as "create this session" and refuses it when the transcript file for that id already exists. After any restart where the agent had held a conversation, the transcript exists, so the first spawn dies with `code=1`. The "already in use" recovery then mints a fresh id, which discards the conversation.

## Evidence

### Cause 1 — verified: restart builds `--session-id` (create), never `--resume`

- `src/bus/session-manager.ts:708` — `buildClaudeArgs` ends with `args.push("--session-id", agent.session_id)`. It has no resume branch, and it is the only place the bus builds the flag. `spawnAgentInternal` (`:832`) calls it for every spawn, first boot and restart alike.
- The legacy PTY path does this correctly: `src/runner/pty-process.ts:627-631` emits `--resume <id>` for an existing session and `--session-id <id>` only for a new one. The bus never got that distinction.
- The CLI's own check, from the installed binary (`~/.local/share/claude/versions/2.1.309`, grepped with `rg -a`). In the `--session-id` argument handling:
  `if(Oe){if(!ke){let s=zt(Oe);if(!s)return fn("Error: Invalid session ID. Must be a valid UUID.");if(!(o.forkSession&&o.resume===s)&&kzn(s))return fn(\`Error: Session ID ${s} is already in use.\`,Fvn)}}`
  and the predicate:
  `function kzn(e){if(J())return!1;let n=C8(),r=Lc(n,\`${e}.jsonl\`),s=ie();try{return s.statSync(r),!0}catch{return!1}}`
  So **"already in use" means "`<projects>/<cwd-slug>/<id>.jsonl` exists"**. It is a `statSync` and nothing else. `J()` is the diskless-mode switch, which skips the check; ClaudeClaw never sets it.
- `--resume <id>` is the correct way to continue an existing transcript. When the transcript is missing the CLI exits 1 with `No conversation found with session ID: <id>` (`failure_reason: not_found_explicit_id`).
- This matches the soak report: one `code=1` exit, the retry works, and the conversation is gone. The retry works because the fresh id has no transcript.

Consequence beyond restart: `restart(id, { freshSession: false })` is documented as "resume the same transcript" (`session-manager.ts:1319`), but it too goes through `buildClaudeArgs`, so it hits the same refusal and silently rotates.

### Cause 3 — ruled out: stale per-session lock or marker

- The check above is the only source of "already in use" for a session id, and it reads no lock, pid or registry. The other "already in use" strings in the binary are unrelated (port `EADDRINUSE`, OAuth callback ports, a scheduler id validator).
- The resume failure reasons the binary reports are `not_found_explicit_id`, `processing_error`, `worker_state_unread`, `drop_guard_refused`, `not_found_picker`. None is a lock or liveness refusal. `--resume` does not consult any process state.
- Corollary: the comment at `session-manager.ts:1315` ("claude's locked-`--resume` refusal") is not supported by 2.1.309. I left it alone: it is a comment, and the version the soak server runs is pinned older (2.1.220), which I could not inspect.

### Cause 2 — ruled out as the cause of this symptom; a related hazard remains

- A surviving previous-daemon `claude` cannot produce "already in use": the check never looks at processes. With every old process dead, the refusal still happens.
- Shutdown path, for the record: `runtime-mount.ts:750-756` calls `sessionManager.stop(id)` for each spawned agent. `stop()` (`session-manager.ts:1254-1300`) sends `/quit`, then SIGTERMs after 2 s via `PtyAgentProcess._kill` (`session-agent-process.ts:1302`), which calls the raw `pty.kill()` on the bun-pty handle. It resolves on the exit **event**, and bun-pty fires that event at once without proving the process gone. Bus PTYs are not in the `pty-quarantine` registry, so nothing confirms their exit.
- **Residual hazard (not fixed here):** the CLI has no lock on `--resume`, so a `claude` that outlives its daemon (daemon SIGKILLed, or a `/quit`/SIGTERM that did not land) and a new `--resume`d `claude` would both append to one transcript. Before this change that case was masked, because the create-refusal forced a fresh id. Closing it means bringing bus PTYs under the confirmed-exit/quarantine machinery, or reaping orphans by pid at boot. Either one touches the #562 round-9 design, which this task must not change, so I am reporting it rather than patching it.

### Other residual

- After `/clear` the CLI writes a new transcript, but the stored id stays the pre-clear one (`jsonl-tailer.ts:167`). A restart now resumes the **pre-clear** conversation (before, it silently started empty). I did not change the stored-id handling.

## Fix (smallest change that closes cause 1)

1. `buildClaudeArgs(agent, mode, { resume })` emits `--resume <id>` when `resume` is true, otherwise `--session-id <id>` as before (default, so existing callers and tests keep their argv).
2. `spawnAgentInternal` decides `resume` from the transcript: the same file the CLI stats, resolved with the existing `resolveTranscriptPath` (honours the child's `CLAUDE_CONFIG_DIR`; realpath'd cwd) or `options.projectsDir` in tests. The decision is a filesystem fact, not screen text.
3. Rotation only when resume genuinely fails: a resumed spawn that exits non-zero inside the detection window **and** whose last output names `No conversation found with session ID` (the CLI's own refusal). The screen is used only to fail the spawn over to a fresh id, never to mark anything successful. The log line carries a fixed reason code, never screen text. Rotation happens at most once (existing `retry` guard).
4. The existing `--session-id` collision rotation stays for the create path, now logged with a reason code as well.

Nothing under `src/runner/pty-quarantine.ts` or the supervisor changes: `assertSessionWritable` and `assertSessionSpawnable` still run in the same places, in the same order.

## Tests, injections, gates

## Sites changed

| Site | Change |
|---|---|
| `src/bus/session-manager.ts` `RESUME_NOT_FOUND_PATTERN` | claude's `No conversation found with session ID` refusal |
| `session-manager.ts` `detectSessionIdCollision` | new optional 4th arg `pattern` (default: the id-collision marker) |
| `session-manager.ts` `buildClaudeArgs` | optional `{ resume }`; emits `--resume <id>` or `--session-id <id>` |
| `session-manager.ts` `sessionTranscriptExists` (new, exported) | the file the CLI `stat`s: `<projects>/<encoded real cwd>/<id>.jsonl` |
| `session-manager.ts` `spawnAgentInternal` | decides `resume` from the transcript; arms the detector with the matching pattern; rotation log carries `reason=resume-rejected-no-conversation` or `reason=session-id-in-use`; the exit log does not quote the screen for a refused resume |
| `src/bus/__tests__/session-resume.test.ts` (new) | 11 tests |

`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: 2.2.354 -> 2.2.355.

## Tests

`src/bus/__tests__/session-resume.test.ts`, 11 tests. The spawn tests start a stand-in command with the **real** argv `buildClaudeArgs` builds, and read the argv back from disk, so the flag is asserted exactly.

- restart with a stored session whose transcript exists: `--resume <id>`, no `--session-id`, no rotation
- first boot (no transcript): `--session-id <id>`, no `--resume`
- genuine resume failure: rotates exactly once, new argv is `--session-id <fresh>`, the log line has `reason=resume-rejected-no-conversation` and the screen text is absent from every logged line
- any other boot failure of a resumed spawn (here `not logged in`, exit 1): **no** rotation, the conversation is kept
- a created spawn that collides: still rotates once, `reason=session-id-in-use`
- `restart({ freshSession: false })` resumes the same transcript
- the #562 gate still stands for a resumed session (quarantined writer: the stand-in is never started)
- `buildClaudeArgs` flag unit tests (2), `sessionTranscriptExists` unit tests (2)

## Fault injections (one site at a time, each on its own `git archive` copy of the final fix commit)

Each prediction was written down before the run. The RED lines are verbatim from the run output.

| # | Fault | Predicted RED | Observed RED |
|---|---|---|---|
| I1 | `resume` decision forced false (`spawnAgentInternal`) | restart-resume, genuine-failure, `freshSession:false` | the same 3; `8 pass / 3 fail` |
| I2 | `buildClaudeArgs` flag reverted to `--session-id` | flag unit test, restart-resume, genuine-failure, `freshSession:false` | the same 4; `7 pass / 4 fail` |
| I3 | detector not given the resume pattern | genuine-failure only | that 1; `10 pass / 1 fail` |
| I4 | rotation widened to any output on a resumed spawn | "other boot failure does not rotate" only | that 1; `10 pass / 1 fail` |
| I5 | `await assertSessionWritable(...)` removed | (see below) | **stays green**, `11 pass / 0 fail` |
| I5b | `assertSessionWritable` and all three `assertSessionSpawnable` removed | the gate test | that 1; `10 pass / 1 fail` |
| I6 | `$CLAUDE_CONFIG_DIR` ignored in `sessionTranscriptExists` | the `$CLAUDE_CONFIG_DIR` unit test only | that 1; `10 pass / 1 fail` |
| I7 | exit log quotes the screen for a refused resume | genuine-failure only (the "no screen text" assertion) | that 1; `10 pass / 1 fail` |

RED lines, verbatim:

```
I1  Expected: "5b7d1c2e-0000-4000-8000-0000000005a5"
    Received: undefined
    (fail) SessionManager.spawnAgent — resume on restart (#595) > restart with a stored session whose transcript exists: --resume <id>, no --session-id, no rotation
I2  (fail) buildClaudeArgs — session flag (#595) > resumes the session with --resume when told its transcript exists
    Expected: "5b7d1c2e-0000-4000-8000-0000000005a5"
    Received: undefined
I3  Expected length: 1
    Received length: 0
    (fail) SessionManager.spawnAgent — resume on restart (#595) > a genuine resume failure rotates exactly once, and the log carries a reason code, not the screen
I4  Expected length: 0
    Received length: 1
    (fail) SessionManager.spawnAgent — resume on restart (#595) > any other boot failure of a resumed spawn does not rotate (the conversation is kept)
I5b Expected promise that rejects
    Received promise that resolved: Promise { <resolved> }
    (fail) SessionManager.spawnAgent — resume on restart (#595) > the #562 gate still stands: a resumed session with an unconfirmed writer is not started
I6  Expected: true
    Received: false
    (fail) sessionTranscriptExists (#595) > looks under $CLAUDE_CONFIG_DIR/projects when no projects root is given
I7  Expected to not contain: "No conversation found"
    (fail) SessionManager.spawnAgent — resume on restart (#595) > a genuine resume failure rotates exactly once, and the log carries a reason code, not the screen
```

**I5 is not a miss in the test, it is overlap in the guards.** For a quarantined session, `assertSessionSpawnable` (synchronous, in `spawnChild`) throws even when the async `assertSessionWritable` is gone, and the reverse holds too. Each guard is covered on its own by `session-manager-quarantine.test.ts` (fence-only case for the sync check, confirm-exit case for the async one); the new test shows the gate still applies on the **resume** path, which only I5b (both removed) can falsify. I report it as such and do not count I5 as evidence.

Earlier runs of two injections showed an unpredicted failure; both were test-side and are fixed in the committed file: the collision test's 600 ms detection window missed the stand-in's exit on a loaded host (now 1500 ms), and the `restart` test then exceeded bun's 5 s default timeout (now 30 s). The `restart` REDs in I1/I2 were checked to be assertion failures, and the flag assertions were rewritten (`flagValue`) so that RED reads `Received: undefined` and not an unrelated argv entry.

## Gates

Run on `a60c07d7` (the code is identical to the final commit; only this report changed after):

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/595-src.txt 2>&1`: **exit 0, 5026 pass, 5 skip, 0 fail** (272 files). No flakes seen in the full run.
- `bun run lint`: exit 0 (1296 warnings, 323 infos, all pre-existing; 0 errors).
- `bun run typecheck`: 149 errors, baseline 149 (no worse).
- Versions: `plugin.json` and `marketplace.json` both 2.2.355 (> 2.2.354, equal).
- The new test file alone passed 6/6 repeated runs on the clean tree before the final tweaks, and 11/11 after.

## Not done / for the coordinator

- Residual hazard from cause 2 (orphan `claude` surviving its daemon, now able to share a resumed transcript; no CLI lock). Needs a follow-up issue; it touches the #562 round-9 design, so it is out of scope here.
- After `/clear`, a restart resumes the pre-clear conversation (stored id is not updated on `/clear`). Decide whether that is wanted.
- Not verified against the soak server's pinned CLI (2.1.220); the evidence is from 2.1.309. The `--session-id` refusal and the resume `not found` message are old behaviour, but that is an inference.
- No live end-to-end run with a real `claude` (it would need authentication, which the brief forbids).

---

# Round 2

Branch `fix/595-bus-session-resume`, on top of `4015a298`. Commit `726fe00b` (code + tests); this report in the commit after it. Nothing is pushed to `feat/550-pty-default`. The #562 round-9 fence, quarantine and synchronous spawn-check are untouched: `assertSessionWritable` and the three `assertSessionSpawnable` calls are in the same places in the same order.

## Fix 1 — a surviving claude and the `--resume`d one are two writers

New helper `src/bus/session-survivor.ts` (`reapSessionSurvivors`), one call site in `spawnAgentInternal` (`src/bus/session-manager.ts`, right after the `resume` decision and before the argv is built), one private helper `rotateStoredSession`.

How it works, in the order it runs, only when `resume` is true and the platform is not win32:

1. Read the process table (`ps -axww -o pid=,uid=,lstart=,args=`, `LC_ALL=C`, `-ww` so a long argv is not cut: `--resume <id>` is the LAST flag `buildClaudeArgs` pushes). Rows with a different uid, our own pid, or a program that is not claude (argv[0..1] must contain `claude`) are ignored.
2. A survivor holds the session when the exact id is a whole argv token directly after `--resume` or `--session-id` (or glued as `--flag=<id>`). `<id>9`, `x<id>`, `<id>-old` do not match.
3. SIGTERM each survivor, then re-read the table until it is gone. Not gone after the bound: SIGKILL, then re-read again.
4. "Gone" means no row with the same **pid AND start time**. The table is re-read before each signal as well, so a pid recycled by another process (different start time) is never signalled and never mistaken for the survivor.
5. Outcomes: `none` (resume as before), `reaped` (one log line, `reason=resume-survivor-reaped pids=...`, then resume), `unconfirmed` (still there after both bounds) and `table-unreadable` (the `ps` read failed, or returned nothing). The last two rotate to a fresh id via `rotateStoredSession`, log one line with the code `resume-survivor-unconfirmed` or `resume-process-table-unreadable` (never any text from the process), persist, and re-enter `spawnAgentInternal`. The fresh id has no transcript, so the re-entry spawns with `--session-id` and never reads the table again (no loop).

**Bound chosen: 3000 ms after SIGTERM, then 2000 ms after SIGKILL (5 s worst case), polling the table every 100 ms.** SIGTERM gets 3 s because a `claude` being told to quit flushes its transcript; the SIGKILL leg is short because it cannot be refused, only delayed by the OS. Both are options (`survivorTermMs`, `survivorKillMs`) so tests do not wait.

The unreadable-table rule fails closed on purpose: not knowing whether a second writer exists is treated like knowing there is one.

## Fix 2 — `/clear` leaves the pre-clear id stored

**Chose the fallback: a fresh id is stored when `/clear` is relayed.** `wiring.ts` calls the new `SessionManager.noteSessionCleared(agentId)` after `send_slash("clear")` succeeds; it persists a fresh id (`rotateStoredSession`, reason `session-cleared`) and adopts it on the live config. No transcript exists for it, so the next spawn creates a clean session.

Why not the preferred option (update the stored id to the CLI's new one): this process never learns the new id. The tailer is one session id wide and stays on the old file (`jsonl-tailer.ts:17-18`, `:167`); the only way to learn it is to watch the project directory for a new `*.jsonl` and adopt one. That watcher would have to tell this agent's new file from one written by another claude in the same cwd (agent jobs, the legacy runner) and would widen the tailer's design, which the brief rules out. A wrong adoption would resume somebody else's conversation, which is worse than starting clean.

Consequence: `restart({ freshSession: false })` after a `/clear` creates a new session instead of resuming the post-clear one. That is the correct reading of "resume the same transcript" when the transcript the stored id names is the one the operator cleared.

## Check 3 — CLI versions (evidence only, no code)

Method: `npm pack` into new empty directories under the scratch dir. The `@anthropic-ai/claude-code` wrapper package of 2.1.296 and 2.1.220 has **no bundle** (`bin/claude.exe` is a 500-byte stub, `install.cjs` fetches the binary); the native binary is in the platform package, so I packed `@anthropic-ai/claude-code-darwin-arm64@<v>` as well. Text grep only (`rg -a`); nothing was executed or installed.

| Behaviour | 2.1.309 (round 1) | 2.1.296 (soak) | 2.1.220 (pinned in production) |
|---|---|---|---|
| `--session-id` refusal is `statSync(<projects>/<id>.jsonl)`, message `Session ID <id> is already in use` | yes | **yes** (`eRn`: `rc(q2(),`${e}.jsonl`)` + `statSync`) | **yes** (`wfn`: `QS.join(dW()??tS(gn()),`${e}.jsonl`)` + `statSync`) |
| `--resume` of a missing id: `No conversation found with session ID:` | yes | **yes** | **yes** |
| A `--resume` refusal because the session is held by a live process | none | none | **yes, narrow**: `_Pe(id)` refuses only when a live session with that id, another pid, has a `kind` that is set and **not `"interactive"`** (message `... is currently running as a background agent (<kind>)`) |

So the round-1 premise holds on all three: `--session-id` on an existing transcript is refused by a plain `stat`, and `--resume` is the right flag. The soak and production versions behave like 2.1.309 here.

The third row matters for Fix 1. On 2.1.220 a surviving **non-interactive** claude (the `-p` stream-json mode) would make the resume fail with the background-agent message, which our resume-refusal detector does not match (it rotates only on `No conversation found`), so the spawn would exit non-zero without rotating. A surviving **interactive** claude (the PTY mode, `kind: "interactive"`) is not refused by any version, which is the two-writers case Fix 1 closes. Fix 1 ends both kinds before the resume.

**Comment at `session-manager.ts` ~1315 ("claude's locked-`--resume` refusal"): left as is.** The brief says to fix it only if the evidence contradicts it for every version checked; 2.1.220 does have a (narrow) live-session refusal, so it is not contradicted everywhere. It is wrong for 2.1.309 and 2.1.296.

## Sites changed

| Site | Change |
|---|---|
| `src/bus/session-survivor.ts` (new) | `reapSessionSurvivors`, `holdsSession`, `systemProcessProbe`, bounds 3000/2000 ms |
| `session-manager.ts` `spawnAgentInternal` (after the `resume` decision) | the one call site; `reaped` logs, `unconfirmed` / `table-unreadable` rotate and re-enter |
| `session-manager.ts` `rotateStoredSession` (new, private) | mint, log reason code, persist, adopt |
| `session-manager.ts` `noteSessionCleared` (new, public) | Fix 2 |
| `session-manager.ts` `SessionManagerOptions` | test seams `processProbe`, `survivorTermMs`, `survivorKillMs` |
| `src/bus/wiring.ts` | `noteSessionCleared` after a relayed `/clear` |
| `src/bus/__tests__/session-survivor.test.ts` (new) | 17 tests |
| `src/bus/__tests__/wiring.test.ts` | the fake session manager gains `noteSessionCleared` |

## Tests (17 new)

`holdsSession` (3): exact token after either flag or glued; no match for an id that starts with or contains the stored one; the flag and a claude program are both required.
`reapSessionSurvivors` on a scripted table (7): no survivor; dies on SIGTERM (reaped, no SIGKILL); ignores SIGTERM then SIGKILL, still there (`unconfirmed`); unreadable table; pid recycled after the signal; pid recycled before the signal (nothing signalled); id-prefix decoy, another uid and a non-claude line.
`SessionManager` (7), real stand-in `claude` that records its argv and whether the survivor pid was alive when it started:
- a **real** surviving process (`sh fake-claude.sh --resume <id>`, read through the real `ps`) is ended and confirmed gone BEFORE the resume spawn (`survivor.state.1` is `gone`), then `--resume <id>`, no rotation, one `resume-survivor-reaped` line
- survivor that cannot be confirmed dead: SIGTERM then SIGKILL, no `--resume`, one persisted fresh id, `--session-id <fresh>`, `reason=resume-survivor-unconfirmed`, no second spawn
- process table unreadable: rotation, `reason=resume-process-table-unreadable`, and the `ps` error text is not in the log
- no survivor: `--resume`, no rotation, nothing signalled
- first boot: the table is never read
- `/clear` then `restart({ freshSession: false })`: `--session-id <fresh>`, no `--resume <pre-clear>`
- other slash commands (`/compact`) leave the stored id alone

## Fault injections (one site, one `git archive` copy of `726fe00b`)

Predictions were written before the run. All seven matched exactly; RED lines are verbatim from the run output.

| # | Fault | Predicted RED | Observed RED |
|---|---|---|---|
| I1 | drop the guard call (`if (resume && ...)` -> `if (false)`) | survivor-before-resume, unconfirmed, unreadable | those 3; `23 pass / 3 fail` |
| I2 | `unconfirmed` reported as `reaped` (helper return) | stubborn unit, unconfirmed manager | those 2; `24 pass / 2 fail` |
| I3 | substring instead of exact token (`tokens[i + 1]?.startsWith(sessionId)`) | `holdsSession` no-match test, decoy reap | those 2; `24 pass / 2 fail` |
| I4 | revert the `/clear` fix (call removed from `wiring.ts`) | `/clear` manager test only | that 1; `25 pass / 1 fail` |
| I5 | identity by pid only (`sameProcess`) | recycled-after, recycled-before | those 2; `24 pass / 2 fail` |
| I6 | manager treats `unconfirmed` as gone (`session-manager.ts` branch) | unconfirmed manager only | that 1; `25 pass / 1 fail` |
| I7 | unreadable table treated as `none` | unreadable unit, unreadable manager | those 2; `24 pass / 2 fail` |

```
I1  Expected: "gone"
    Received: "alive"
    (fail) ... > surviving claude ended confirmed gone BEFORE session resumed
    Expected length: 1 / Received length: 0   (cannot be confirmed dead; unreadable table)
I2  expect(out).toEqual({ kind: "unconfirmed", pids: [900] })   (fail) ... survivor ignores SIGTERM ...
    Expected length: 1 / Received length: 0                      (fail) ... survivor cannot be confirmed dead ...
I3  Expected: false
    Received: true                                               (fail) holdsSession > does not match id merely starts with ...
    expect(...).toEqual({ kind: "none" })                        (fail) reapSessionSurvivors > id-prefix decoy ...
I4  Expected length: 1 / Received length: 0                      (fail) ... /clear restart keeps id ...
I5  expect(out).toEqual({ kind: "reaped", pids: [900] })         (fail) ... pid recycled by another process ...
                                                                 (fail) ... pid recycled BEFORE signal never signalled
I6  Expected length: 1 / Received length: 0                      (fail) ... survivor cannot be confirmed dead ...
I7  expect(...).toEqual({ kind: "table-unreadable" })            (fail) ... unreadable process table is its own outcome ...
    Expected length: 1 / Received length: 0                      (fail) ... unreadable process table fails closed ...
```

## Gates

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/595r2-src.txt 2>&1`: **exit 1, 5042 pass, 5 skip, 1 fail** (273 files). The one failure is `JsonlTailer — live tail > picks up new bytes appended after start()` (`waitFor timed out after 750ms`), in `jsonl-tailer.test.ts`, a file this change does not touch. Rerun alone it passes; across 3 + 6 reruns on this branch it failed 2 of 9, and 0 of 6 on the round-1 head, with machine load averaging ~21 (other agents are running). Same file shows a second timing-sensitive failure (`a CLI continuation ... starts a turn nobody's receipt owns`) in one of the failing runs. Load flake, not caused by this change; I did not change the file.
- `bun run lint`: exit 0 (584 files checked, no errors).
- `bun run typecheck`: **149 errors, baseline 149** (no worse).
- Versions: `plugin.json` and `marketplace.json` both 2.2.355 (unchanged).

## Residuals

- A `/clear` typed as ordinary prompt text (not relayed through `bus.invokeSlashCommand`) is not seen by `noteSessionCleared`. Adapters that route slash commands go through the relay; plain-text delivery would need the same hook in the prompt path.
- `noteSessionCleared` runs after `send_slash` resolves, which only proves the keystrokes were written. If the CLI did not act on `/clear`, the next restart starts clean although the conversation still exists. Chosen over the opposite error (resuming a cleared conversation).
- If persisting the fresh id fails after `/clear`, the old id stays (the pre-fix behaviour) and a warning is logged.
- The guard identifies a claude by `argv[0..1]` containing `claude` plus the exact flag/id pair. A claude started through a wrapper whose first two argv entries do not contain `claude` would not be found; production starts it as `claude` or the platform package binary.
- A survivor owned by a different uid is not touched (and so cannot be confirmed): the resume then goes ahead. The daemon and its agents run as one user.
- No live end-to-end run with the real CLI (authentication is out of scope for this task). The real `ps` read, real signals and the real confirmation are exercised against a real process in the first manager test.
- 2.1.220 refuses `--resume` for a session held by a live non-interactive claude with a message our resume-refusal detector does not recognise (see Check 3). Fix 1 removes the survivor first, so the case should not arise; if one slips past, that spawn exits without rotating. Not changed here.


---

# Round 3

Branch `fix/595-bus-session-resume`, on top of `3fffb9f8`. Code + tests in `7949c109`; this report in the commit after it. Nothing is pushed to `feat/550-pty-default`. The #562 round-9 fence, quarantine and synchronous spawn-check design is unchanged: `assertSessionWritable` and the three `assertSessionSpawnable` calls are in the same places in the same order (`session-manager.ts`, `:1116` and the three spawn sites).

Codex's round-2 review (2 HIGH, 3 MEDIUM, 1 LOW) was Not clean. Coordinator ruling: **the daemon kills only a process it can prove it spawned.** A session id is not permission to kill. `session-survivor.ts` (the process-table search) and its test file are deleted; nothing replaces the search.

## The ownership model

New module `src/bus/session-ownership.ts`.

**At spawn.** `spawnAgentInternal` calls `recordSpawnOwnership` right after the process is registered (`session-manager.ts:1166`). It reads the process's start identity and writes `<agents>/<id>/owner.json` (mode 0600, temp file + rename, serialised per agent): agent id, session id, pid, start identity, **daemon boot id**, executable basename, spawn time. The boot id is `DAEMON_BOOT_ID`, a `randomUUID()` minted once per daemon start. A failed write is logged (`reason=ownership-record-failed`) and never fails the spawn. tmux is not recorded: its pid is a client that exits at once.

**At exit.** The record is cleared only after the OS confirms the process gone (`confirmGoneAndClear`, polling the probe), not on bun-pty's exit event. `clear` compares pid and identity first, so a late exit of an old process cannot delete a newer spawn's record. A process still alive or unreadable keeps its record, so the next start examines it.

**At restart, before resuming** (`decideResume`, only when the transcript exists, the store is wired and the platform is not win32). It reads only the record for that agent:

| Record | Process | Action |
|---|---|---|
| none | - | resume (`no-record`) |
| for another session id | - | resume (`record-other-session`) |
| any | gone, a zombie, or alive with a **different** start identity | no signal, drop the record, resume (`owner-gone` / `pid-reused`) |
| this boot | alive, same identity | **never signalled**, rotate (`current-boot-owner-alive`) |
| previous boot | alive, same identity | our orphan: revalidate, SIGTERM, revalidate, SIGKILL if needed, confirm gone, then resume (`orphan-reaped`) |
| unreadable / corrupt | - | rotate (`ownership-record-unreadable`) |
| any | read fails | rotate (`owner-read-failed`) |
| previous boot | uid differs / argv no longer names our claude + the id | no signal, rotate (`owner-uid-mismatch` / `owner-argv-mismatch`) |
| previous boot | still there after SIGTERM and SIGKILL | rotate (`orphan-unconfirmed`) |
| any | deadline passes | rotate (`guard-deadline`) |

"Revalidate" means a fresh single-pid read immediately before **each** signal: same start identity, same uid, and the argv still names the executable recorded at spawn and the session id.

**An unrecorded claude that names the id is never looked for and never signalled** (operator's interactive session, another tool). I took the optional detection out rather than keep a `ps args` parse that can be fooled (Codex HIGH 2). The cost: if such a process exists, the daemon resumes beside it, as it did before round 2. See residuals.

**argv.** On Linux the probe reads `/proc/<pid>/cmdline`, so argument boundaries are real and `claude --print "explain --resume <id>"` is ONE argument and cannot match. On macOS `ps` prints flat text and the boundaries are guessed from spaces; there the argv check is only a confirming check on a process the record and start identity already prove ours, never what makes it ours. The program must be the recorded executable's basename (or an interpreter running a script of that name), not "anything containing `claude`".

## Identity precision per platform

| Platform | Source | Precision |
|---|---|---|
| Linux | `/proc/stat` `btime` + `/proc/<pid>/stat` field 22 (start time in clock ticks) | 10 ms on a normal kernel (`CONFIG_HZ=100`), boot-qualified |
| macOS | `ps -ww -o stat=,uid=,lstart=,command= -p <pid>` | **1 s** (`lstart` has second resolution; `etime` has no better) |

I found no higher-resolution source on macOS without a native read (`proc_pidinfo`), and the brief forbids a native dependency; nothing in the repo reads it. Because second precision alone cannot distinguish a pid reused within the same second, the macOS path leans on the extra checks the ruling asked for: the record (a pid with no record is never touched), the previous-boot rule (a current-boot process is never signalled, so a reuse can only matter for a process of a dead daemon), the uid check, and the argv check, all repeated immediately before each signal. The Linux identity is read with plain file reads, no subprocess.

## The deadline

**`GUARD_DEADLINE_MS = 5000`** for the whole guard: the record read, every process read, both signals and both confirmations share one deadline, checked **including subprocess time** (`withDeadline` wraps every await; Codex's finding was that each `ps` was awaited before the deadline was looked at). On expiry the session rotates (`guard-deadline`) and nothing more is signalled.

Inside it: each `ps` is killed by `execFile`'s own `timeout` at `PROBE_TIMEOUT_MS = 1500` (capped by what is left of the deadline); SIGTERM gets `ORPHAN_TERM_MS = 3000`, then `ORPHAN_KILL_MS = 2000`, each capped by the deadline. **Worst case: 5.0 s plus timer slack, at most one probe overrun under 1.5 s, so ≤ 6.5 s hard ceiling and in practice ≤ 5.1 s; the brief's ≤ 6 s holds for the guard itself** (the unit test pins the constants; the stalled-read tests measure 300 ms deadlines returning in < 900 ms). The `/clear` retirement has its own bound, below.

## `/clear` is a controlled restart

`wiring.ts:55`: a relayed `/clear` calls `SessionManager.clearSession(agentId)` and **returns**; it no longer calls `send_slash` at all, so the `process`-mode case where `send_slash` resolves without clearing cannot report success. Everything else is relayed as before.

`clearSession` (`session-manager.ts:908`, joined if one is already running):

1. `fenceKey("bus:<id>", record, () => oldId)` as the first synchronous step: the #562 fence, so nothing spawns on the old session while it retires.
2. `stop()` (`/quit`, then SIGTERM after 2 s), bounded at 8 s.
3. The OS must confirm the old process gone: `confirmRetired` polls the probe, revalidates, and sends **one SIGKILL to the recorded process** (same identity) if it is still there. With no record it accepts only "pid no longer exists".
4. **Unconfirmed:** `quarantineSession` (the fence becomes the quarantine record in one step, with a `confirmExit` that re-asks the OS), a logged `reason=clear-retire-unconfirmed`, and the call **rejects**. The stored id is unchanged and nothing is spawned. The existing `assertSessionWritable` gate then refuses the session until the OS confirms, and releases it when it does.
5. **Confirmed:** mint a fresh id, persist it, set `agent.session_id`, log `reason=session-cleared`, and `spawnAgent` again. The new process starts with `--session-id <fresh>` (no transcript exists for it, so it is a create), so **the stored id equals the live transcript's id**. If persisting fails, the old session is restarted and the call rejects (`clear-persist-failed`): the agent is not left down and success is not reported.

Not available under tmux (the daemon does not own that claude): it rejects. Residual below.

## LOW — each gate gets its own fixture

`session-resume.test.ts`: the old test was satisfied by either gate. Now:
- **Gate 1** (`assertSessionWritable`): a quarantined writer whose confirmation now succeeds. Only the async gate re-asks the writer, so the spawn succeeds and `confirmCalls === 1`. Without the gate, the unchanged synchronous check still sees the record and the spawn rejects.
- **Gate 2** (`assertSessionSpawnable`): a **fence** with nothing quarantined. `assertSessionWritable` ignores fences, so only the synchronous check refuses the spawn.
- A writer that stays unconfirmed is closed by either gate (kept as a third test, no mutation claim).

## Sites changed

| Site | Change |
|---|---|
| `src/bus/session-ownership.ts` (new) | ownership record + file store, probes (`/proc`, targeted `ps`), `decideResume`, `confirmGoneAndClear`, `confirmRetired`, `namesOwnedClaude`, deadlines |
| `src/bus/session-manager.ts:1056` | `decideResume` replaces `reapSessionSurvivors`; `rotate` -> `rotateStoredSession` + re-enter |
| `session-manager.ts:1166`, `:1375` | `recordSpawnOwnership` at spawn |
| `session-manager.ts:~1227` | exit handler: `confirmGoneAndClear` |
| `session-manager.ts:908-1010` | `clearSession` / `clearSessionInternal` (replaces `noteSessionCleared`) |
| `session-manager.ts` options | `ownershipStore`, `processProbe`, `bootId`, `ownershipGuardMs`, `ownershipTermMs` |
| `src/bus/wiring.ts:55` | `/clear` -> `clearSession`, no keystroke relay |
| `src/commands/start.ts:~660` | the daemon wires `createFileOwnershipStore()` |
| deleted | `src/bus/session-survivor.ts`, `__tests__/session-survivor.test.ts` |

## Tests (new)

`session-ownership.test.ts` (36): decisions (no record; unrecorded claude never touched; previous-boot orphan with the **event order** `read, read, kill SIGTERM, read, clear`; SIGKILL stage; unconfirmed; pid reused; dead; zombie; other-session record; identity changing between the read and the signal; current-boot never signalled; current-boot exited; unreadable record; read failure; other uid; argv mismatch), deadlines (stalled process read, stalled record read, stall after SIGTERM, shipped constants), `namesOwnedClaude` (decoy prompt, id prefix, impostor program, interpreter, flat text), the file store (round trip + 0600, guarded clear, corrupt file, path-shaped agent id), and the real readers (fake `/proc` tree incl. `comm` with `) (`, zombie, this very process, fake `ps`: parse, exit 1, failure, stall).

`session-ownership-manager.test.ts` (16): real orphan processes read by the production probe: reaped before the resume (`orphan.state.1` is `gone`), pid reuse, current-boot, unrecorded claude, unreadable record, stalled read, first boot, no store, record written/cleared, unwritable record, same-boot restart; `/clear`: old process gone before the new spawn (`prev.state.2`), `--session-id <new id>`, stored id equals it; unconfirmed -> rejects, quarantined, id unchanged, no second spawn, lifts once the OS confirms; persist failure restores the old session; not-running rejects; other commands untouched.

`wiring.test.ts` (+3): `/clear` goes to `clearSession` and never to `send_slash`; a failed clear rejects to the caller; other commands relay. `session-resume.test.ts`: the two gate fixtures.

## Fault injections (one site, one `git archive` copy of `7949c109`, pristine file restored after each)

Predictions were written into the tests before the run (each test carries its `Fault ... Predicted result` comment). All matched; no injection went RED in a test other than the ones named. Verbatim from the run output (`error:` line is the assertion that failed, `(fail)` the test):

| Injection | RED |
|---|---|
| signal without the ownership check (the boot-id / record gate: guard call removed, `session-manager.ts:1055` -> `if (false)`) | M3: 4 fail / 12 pass |
| signal a current-boot record (the `bootId` rotate line removed) | I2: 1 fail / 35 pass; M2: 1 fail / 15 pass |
| skip revalidation (per-signal `read()` replaced by the first read) | I3: 2 fail / 34 pass |
| drop the subprocess timeout (`ps`: `timeout:` removed) | I4b: 1 fail / 35 pass |
| drop the guard deadline (`bounded` = identity) | I4a: 3 fail / 33 pass |
| `/clear` without the restart (round-2 behaviour: the wiring branch removed) | M4: 5 fail / 23 pass |
| gate 1 alone (`assertSessionWritable` removed) | G1: 1 fail / 12 pass |
| gate 2 alone (one `assertSessionSpawnable` removed, `spawnChild`) | G2: 1 fail / 12 pass |
| extras: identity compare, uid check, argv check, `clear` guard, record not written, clear confirmation ignored | I1, I7, I8, I9, M6, M5: 1-3 fail each |

```
--- G1-assertSessionWritable-removed
    error: (timeout)
    (fail) SessionManager.spawnAgent — resume on restart (#595) > gate 1 (`assertSessionWritable`): a quarantined writer whose exit the OS now confirms is released, then the session starts [8.19ms]
    12 pass
    1 fail
--- G2-assertSessionSpawnable-removed-spawnChild
    error: expect(received).rejects.toThrow(expected)
    (fail) SessionManager.spawnAgent — resume on restart (#595) > gate 2 (`assertSessionSpawnable`): a retirement in progress on the session refuses the spawn, though nothing is quarantined [3507.78ms]
    12 pass
    1 fail
--- I1-identity-compare-removed
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > pid reused (alive with a different start identity): not signalled, resumed [315.54ms]
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > the identity changes between the read and the signal: no signal is sent [304.76ms]
    34 pass
    2 fail
--- I2-current-boot-signalled
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > a record from THIS boot whose process is alive is never signalled: rotate [0.30ms]
    35 pass
    1 fail
--- I3-revalidation-skipped
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > a previous-boot orphan with the same identity: revalidated, killed, confirmed gone, THEN resumed [0.41ms]
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > the identity changes between the read and the signal: no signal is sent [0.21ms]
    34 pass
    2 fail
--- I4a-guard-deadline-dropped
    error: (timeout)
    (fail) decideResume — one deadline for the whole guard (#595 r3) > a process read that never returns: rotates within the bound, nothing signalled [5000.01ms]
    error: (timeout)
    (fail) decideResume — one deadline for the whole guard (#595 r3) > a record read that never returns is bounded too [5000.01ms]
    error: (timeout)
    (fail) decideResume — one deadline for the whole guard (#595 r3) > a stall AFTER the SIGTERM is bounded by the same deadline [5000.02ms]
    33 pass
    3 fail
--- I4b-ps-timeout-dropped
    error: expect(received).toBeLessThan(expected)
    (fail) the real process readers (#595 r3) > ps: a stalled subprocess is killed at its timeout and rejects [8167.25ms]
    35 pass
    1 fail
--- I7-uid-check-removed
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > another user's process under a recorded pid: not signalled, rotate [301.84ms]
    35 pass
    1 fail
--- I8-argv-check-removed
    error: expect(received).toEqual(expected)
    (fail) decideResume — what a restart may do (#595 r3) > a recorded pid whose argv no longer names our claude and the session: not signalled, rotate [302.34ms]
    35 pass
    1 fail
--- I9-store-clear-compare-removed
    error: expect(received).toBe(expected)
    (fail) createFileOwnershipStore (#595 r3) > clear drops the record it was asked about but keeps a newer spawn's [2.76ms]
    35 pass
    1 fail
--- M1-identity-compare-removed
    error: expect(received).toBe(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > pid reused by another process (different start identity): not signalled, session resumed [3653.93ms]
    15 pass
    1 fail
--- M2-current-boot-signalled
    error: expect(received).toBe(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > a record from THIS boot whose process is alive: never signalled, the session rotates [3665.61ms]
    15 pass
    1 fail
--- M3-guard-call-removed
    error: expect(received).toBe(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > a previous-boot orphan is revalidated, ended and confirmed gone BEFORE the session is resumed [3027.00ms]
    error: expect(received).toHaveLength(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > a record from THIS boot whose process is alive: never signalled, the session rotates [3019.69ms]
    error: expect(received).toHaveLength(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > an unreadable record: nothing is signalled, the session rotates, the reason is logged [3027.04ms]
    error: expect(received).toHaveLength(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > a process read that times out: nothing is signalled, the session rotates within the guard deadline [2608.42ms]
    12 pass
    4 fail
--- M4-clear-without-restart-r2
    error: expect(received).toEqual(expected)
    (fail) wireSlashCommands — /clear is a controlled restart (#595 r3) > /clear goes to SessionManager.clearSession, never to send_slash [5.64ms]
    error: expect(received).rejects.toThrow(expected)
    (fail) wireSlashCommands — /clear is a controlled restart (#595 r3) > a failed clear rejects to the caller: success is never reported for a clear that did not happen [0.51ms]
    error: expect(received).toHaveLength(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > /clear retires the old process BEFORE the new spawn, on `--session-id <new id>`, and stores that id [2617.24ms]
    error: expect(received).rejects.toThrow(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > /clear whose old process cannot be confirmed gone fails, quarantines the session, and leaves the stored id [2608.47ms]
    error: expect(received).rejects.toThrow(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > /clear whose new id cannot be stored fails and brings the old session back [2608.33ms]
    23 pass
    5 fail
--- M5-clear-confirmation-ignored
    error: expect(received).rejects.toThrow(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > /clear whose old process cannot be confirmed gone fails, quarantines the session, and leaves the stored id [5521.56ms]
    15 pass
    1 fail
--- M6-ownership-record-not-written
    error: expect(received).toBe(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > spawn writes an ownership record for the process it started, and it is cleared once the OS confirms the exit [7676.87ms]
    error: expect(received).toHaveLength(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > a record that cannot be written does not fail the spawn [7629.00ms]
    error: expect(received).toEqual(expected)
    (fail) SessionManager — ownership guard and /clear (#595 r3) > /clear whose old process cannot be confirmed gone fails, quarantines the session, and leaves the stored id [7667.74ms]
    13 pass
    3 fail
```

Notes on the lines: G1 and I4a read `error: (timeout)` because the failure is the rejection / the 5 s test timeout rather than an assertion (G1's rejection is `PtyQuarantinedError: ... is quarantined`, the spawn refused by the unchanged gate 2). I4b's `Expected: < 2000 / Received: 8164` is the stand-in `ps` running its full 8 s.

## Gates

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/595r3-src.txt 2>&1`: **exit 1, 5082 pass, 5 skip, 1 fail** (274 files, 5088 tests). The one failure is `startAt: 'end' (issue #215 runtime wiring) > does NOT replay historical turn_end, but live-tails new ones` (`waitFor timed out after 750ms`) in `jsonl-tailer.test.ts`, a file and a module (`jsonl-tailer.ts`) this branch does not touch (`git diff 3fffb9f8` shows neither). Same family as round 2's tailer timing flake. Rerun alone **3 of 3 passed, 52 pass / 0 fail**. Machine load average was 27 (other agents running) during the full run. Not caused by this change; reported, not fixed.
- `src/bus` alone (the directory this change lives in): exit 0, 1043 pass, 0 fail, before the report commit.
- `bun run lint`: exit 0 (no errors; the 1296 warnings and 323 infos are the repo's existing ones).
- `bun run typecheck` equivalent (`tsc --noEmit -p .`): **154 errors in total = 149 in `src` + 5 in `node_modules/bun-types`; 154 at `3fffb9f8` as well.** No new error, none in a file this change touches except the pre-existing `wiring.test.ts` `FakeAgentProcess` `lastDataAt` one that was already there.
- Versions: `plugin.json` and `marketplace.json` both 2.2.355 (unchanged).

## Residuals

- **The read-to-signal race remains.** Every signal is preceded by a fresh read of identity, uid and argv, but there is no identity-bound process handle on either platform (no `pidfd_send_signal` from Bun/Node, nothing equivalent on macOS), so a process can exit and its pid be reused between the last read and `kill`. On Linux the window is microseconds and the identity is 10 ms; on macOS the identity is 1 s, so a same-second reuse would pass the identity check and rest on the uid and argv checks. The signal can only ever reach a process that was this daemon's child in a previous boot at the moment of the read.
- **macOS argv is flat text** (see above). A reused pid, same second, same uid, whose command line also names our executable and the session id would be signalled. That is a process that is, by construction, a claude on this session.
- **A claude we did not spawn is no longer detected.** If an operator's interactive `claude --resume <id>`, or a tool, holds the session, the daemon resumes beside it (two writers) exactly as before round 2. The ruling prefers this to killing it. The optional rotate-on-detection was dropped because it needed the flattened `ps args` parse.
- **No record -> resume.** After an upgrade, or if `owner.json` was deleted, an orphan from the previous daemon is not found. Orphans from here on are covered.
- **`exe` is a basename** (`claude` in production, resolved through `PATH`). A launch through an interpreter is matched only for `node`, `bun` and POSIX shells.
- **tmux** agents are neither recorded nor `/clear`-able; `/clear` rejects loudly.
- **A `/clear` typed as ordinary prompt text** (not relayed through `bus.invokeSlashCommand`) still moves the CLI to a new transcript and is not seen; plain-text delivery would need the same hook.
- **`clearSession` cannot make a hung `stop()` safe on its own:** it waits at most 8 s, then lets the OS confirmation (and one SIGKILL of the recorded process) decide; if that fails it quarantines, as designed.
- The soak-version caveat from round 2 (2.1.220 refuses `--resume` for a live non-interactive claude with a message our detector does not match) still applies to a claude we did not spawn.
- No live end-to-end run with the real CLI (authentication is out of scope). The real `/proc`/`ps` reads, real signals and real confirmation run against real processes in the manager tests.

---

# Round 4

Branch `fix/595-bus-session-resume`, on top of `f7e4c5ed`. Code + tests in `ee44b7a0`; this report in the commit after it. Nothing is pushed to `feat/550-pty-default`. The #562 round-9 fence, quarantine and synchronous spawn-check design is unchanged: `assertSessionWritable` and the three `assertSessionSpawnable` calls (`session-manager.ts:1583`, `:1610`, `:1651`) are in the same places with no await between each and its spawn. The five findings Codex closed in round 3 stay closed (no test of theirs changed except one assertion that now also carries `lowPrecision: false`).

Codex's round-3 review: 1 HIGH, 2 MEDIUM, and the macOS identity precision still open.

## Fix 1 — HIGH: an unrecorded child never runs

Ruling: make "no record" mean "nothing of ours holds the session" TRUE, instead of rotating on every absent record (which would drop each agent's conversation on the first restart after the upgrade). `decideResume` still resumes on no record.

- A spawn whose process cannot be recorded is **fatal**: the identity read or the write rejecting (`OwnershipRecordError`, stage `identity-read` or `write`; each step is bounded at 4 s, `RECORD_STEP_MS`) ends the child and fails the spawn with `SpawnUnrecordedError` (`code: "ownership-record-failed"`).
- The child is ended through the **same retirement as `/clear`**: `retireLive` (extracted from `clearSessionInternal`, `session-manager.ts:984`). The session is fenced from the first synchronous step, `stop()` then the OS confirmation with one SIGKILL of the recorded process, and an exit that cannot be confirmed **quarantines** the session (`bus-spawn-unrecorded-exit-unconfirmed`) and the error says so (`retired: false`). When only the write failed the in-memory record (identity was read) is what the SIGKILL is bound to; when the identity read failed, only a pid that no longer exists counts as gone.
- One log line, no screen text: `reason=ownership-record-failed stage=<stage> cause=<errno code> session_id= pid=` (`failUnrecordedSpawn`, `:1519`). The error's message is not logged. The test pins that a secret in the error message does not reach the line.
- **Ordering.** The write starts in the very next statement after the process exists (`const recording = this.recordSpawnOwnership(...)`, `:1232`); the record is awaited right after the collision detector is armed (`:1382`), before `spawnAgent` returns. `getAgent()` hides the process (`deliverable: false`, `:846`, `:1929`) until the record exists, so the bus resolves no delivery target for it: no prompt reaches an unrecorded claude. `stop()` and the exit handler still see it.
- **The remaining crash window**, stated plainly: from `fork` to the end of the atomic `rename` of `owner.json`. In it a daemon death (SIGKILL, power loss) leaves a claude with no record. What fills the window: the identity read (Linux: one `/proc` read, ~ms; macOS: one targeted `ps`, ~10-50 ms, bounded at 4 s) plus the write (`mkdir`, temp file, `rename`, ~ms). There is no `await` I/O between process creation and the start of the read: for PTY the only gap is the microtask hop of `await this.spawnPty(...)`. It cannot be zero (a pid does not exist before the fork, and the identity is read from the process). It could be closed by writing an intent record before the fork and treating "intent without pid" as unknown; I did not, because it changes the record schema and `decideResume`'s contract, which the coordinator ruling did not ask for.
- **One-time upgrade residual:** a claude left by a **pre-upgrade** daemon has no record, so the first restart after the upgrade resumes beside it (the round-3 residual "no record -> resume", unchanged). Every claude spawned by this build is recorded or its spawn failed. tmux agents are never recorded (as before).

## Fix 2 — MEDIUM: one lifecycle queue per agent

`enqueueLifecycle` (`session-manager.ts:887`) chains operations per agent id. `spawnAgent` (`:930`), `clearSession` (`:965`) and `restart` (`:1778`) all run through it, so a second operation waits for the first; it does not run beside it. Inside a queued operation the internal `spawnAgentInternal` is called (never the queued public one: no re-entry, no deadlock). The existing coalescing is kept (a second `/clear` joins the first, a second `restart` joins the first). Each operation reads `this.agents` when it **runs**, not when it was queued, so a restart queued behind a clear retires the clear's replacement, not the process the clear already retired. After any interleaving the stored id equals the live process's id (tests below, both orders).

## Fix 3 — MEDIUM: `/clear` succeeds only on a live replacement

`clearSessionInternal` (`:1052`) no longer takes `spawnAgent()` completion as success. After the replacement's spawn returns (which is after the startup window: the collision detector waits up to `sessionCollisionDetectMs`, 2 s by default, and returns early on an exit), the clear checks that the replacement is still the registered, un-exited process. If not: `ClearReplacementExitedError` (`code: "clear-replacement-exited"`), one error line with that reason, and **no** `reason=session-cleared` line (that line moved to after the check). The persisted fresh id stays (it names a session that never started; the next start creates it), and the old session was retired, so the agent is down and the caller is told so.

## Fix 4 — MEDIUM (macOS): sub-second birth identity

`session-ownership.ts`. The macOS identity was `ps lstart` (1 s). It is now `<lstart>+<microseconds>` when libproc answers.

- `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info)` through `bun:ffi` (built in, loaded lazily with `require`, like `runner.ts:259`; `libSystem.B.dylib`, then `/usr/lib/libSystem.B.dylib`). No new dependency.
- **Struct layout and source.** `struct proc_bsdinfo` in the macOS SDK header `<sys/proc_info.h>` (read from `MacOSX26.5.sdk`): `PROC_PIDTBSDINFO` = 3, `PROC_PIDTBSDINFO_SIZE` = `sizeof(struct proc_bsdinfo)` = 136. Twelve 4-byte fields `pbi_flags .. rfu_1` = bytes 0..47 (so `pbi_status` at 4, **`pbi_pid` at 12**, `pbi_uid` at 20); `pbi_comm[16]` at 48; `pbi_name[32]` at 64; seven 4-byte fields `pbi_nfiles .. pbi_nice` at 96..119; **`pbi_start_tvsec` (uint64) at 120; `pbi_start_tvusec` (uint64) at 128**; total 136, naturally aligned, no padding. Little-endian (arm64 and x86_64 agree). Constants: `BSDINFO_OFFSETS = { pid: 12, startSec: 120, startUsec: 128 }`, `PROC_BSDINFO_SIZE = 136`.
- **Checked on this machine** (Darwin 25.6, arm64) with a scratch script before the code: `proc_pidinfo` returned 136; `pbi_pid@12` equalled the pid, `pbi_uid@20` was 501, `pbi_start_tvsec@120` was 1792761049 against `date +%s` 1792761049 and `ps lstart` "14:10:49", `pbi_start_tvusec@128` was 464209; a nonexistent pid returned 0.
- **Decode guards:** the struct is rejected (null) unless it is >= 136 bytes, its `pbi_pid` is the pid asked about, and `tvusec` is in `[0, 1e6)`. The identity uses it only when it also agrees with `ps` on the second (|diff| <= 1 s); a struct that disagrees leaves the identity second-precise.
- **`ps` now runs with `TZ=UTC`** (`readFromPs`). Found while testing: under `bun test` the JS zone is UTC while `ps` printed local time, so libproc's epoch seconds could never be compared with `lstart`. UTC makes the string independent of the daemon's zone and of a DST change. Records written by a round-3 build (local-time `lstart`) would read as a reused pid after this change; round 3 is unmerged, so there are none in the field.
- **FFI fails -> `lstart` alone, marked low-precision** (`ProcessInfo.lowPrecision`). `sameStart(a, b)` is the only comparison: equal strings match; otherwise they match at second precision **only** when one side has no microseconds; two microsecond identities must be equal. This is what tells a replacement born in the same second apart (test: `…+111111` vs `…+222222` -> `pid-reused`, nothing signalled).
- **A low-precision identity may still authorise a signal, and only with the existing revalidation:** before every signal `decideResume` re-reads the process and requires the same uid and an argv/command that still names the executable we launched and the session id (`namesOwnedClaude`). Nothing about a low-precision match skips or weakens those. The reap log line says `identity_precision=low-1s(uid+argv revalidated)` when either side was second-precise. The macOS argv is still flat `ps` text (round-3 residual, unchanged): libproc supplies the start time, not the argument vector.
- Linux unchanged (`/proc` btime + field 22, 10 ms).

## Sites changed

| Site | Change |
|---|---|
| `session-manager.ts:593`, `:609` | `SpawnUnrecordedError`, `ClearReplacementExitedError` (reason codes) |
| `session-manager.ts:846`, `:1929` | `AgentRecord.deliverable`; `getAgent` hides an unrecorded process |
| `session-manager.ts:887`, `:930`, `:965`, `:1778`, `:1900` | `enqueueLifecycle`; spawn, clear, restart queued; queued ops call `spawnAgentInternal` |
| `session-manager.ts:984` | `retireLive` extracted from `clearSessionInternal` and shared with the failed spawn |
| `session-manager.ts:1052-1105` | `/clear`: liveness check, success log after it |
| `session-manager.ts:1232`, `:1382`, `:1496`, `:1519` | record starts right after creation; failure fatal; `recordSpawnOwnership` no longer swallows; `failUnrecordedSpawn` |
| `session-ownership.ts:48`, `:492`, `:509` | `RECORD_STEP_MS`, `OwnershipRecordError`, `recordOwnership` throws it, steps bounded |
| `session-ownership.ts:234-345` | `BSDINFO_OFFSETS`, `decodeBsdInfoStart`, lazy `bun:ffi` `proc_pidinfo`, `libprocStartTime`, `startIdentity`, `sameStart` |
| `session-ownership.ts:348-365` | `readFromPs` takes the start-time reader; `TZ=UTC` |
| `session-ownership.ts:545`, `:721` | `departed` uses `sameStart`; reap reports `lowPrecision` |
| tests | `session-ownership-manager.test.ts` (+6 net: unwritable record x3, delivery gate, queue x2 orders, replacement exit; the old "does not fail the spawn" test is replaced), `session-ownership.test.ts` (+9: struct decode x2, ps+libproc, fallback x3 cases, `sameStart`, real libproc on darwin, same-second pid, low-precision reap, low-precision still gated), `ownership-fakes.ts` (`stallPid`) |

## Fault injections (one site per `git archive` copy of `ee44b7a0`)

Each test carries its `Fault … Predicted result` comment, written before the run. Verbatim from the run output:

| Injection | RED |
|---|---|
| **write failure tolerated again** (`if (recordFailure)` -> `if (recordFailure && false)`) | `error: expect(received).toBeInstanceOf(expected)` x3: `(fail) … > a record that cannot be written ends the child and fails the spawn: no record, and nothing of ours left`, `… AND a child that is not confirmed gone: the session is quarantined`, `… an identity that cannot be read fails the spawn the same way`. 19 pass / 3 fail |
| **lifecycle queue removed** (`prev.then(op, op)` -> `op()`) | `-  "fulfilled",` / `+  "rejected",` in `(fail) … /clear and restart issued together (clear-then-restart) run one after the other and leave one live process on the stored id` and in `(restart-then-clear)`. 0 pass / 2 fail |
| **spawn completion accepted as clear success** (liveness check -> `if (false)`) | `error: expect(received).toBeInstanceOf(expected)` / `(fail) … > a /clear whose replacement exits during startup rejects with its reason, and logs no success`. 0 pass / 1 fail |
| **tvusec decoded as 0** | `-   "usec": 464209,` / `+   "usec": 0,` in `(fail) … > libproc struct: the start time is read at offsets 120 and 128 (pid at 12) of a 136-byte struct`, and `Received: { sec: 1792761049, usec: 0 }` in `(fail) … another pid's struct, a short buffer and an out-of-range usec decode to null`. 43 pass / 2 fail |
| delivery gate removed (`getAgent` returns the process while unrecorded) | `Expected: false` / `Received: true` in `(fail) … > the agent is not reported spawned, and gets no prompt, before its record exists`. 0 pass / 1 fail |
| same-second identity (`departed` back to lstart-only equality, the round-3 behaviour) | `-"kind": "resume", -"reason": "pid-reused"` / `+"kind": "rotate", +"reason": "orphan-unconfirmed"` (the replacement was signalled) in `(fail) decideResume — identity precision … a replacement born in the SAME SECOND … is told apart by its microseconds`. 0 pass / 1 fail |
| retirement confirmation ignored for the failed spawn | `error: expect(received).toBe(expected)` / `(fail) … AND a child that is not confirmed gone: the session is quarantined`. 0 pass / 1 fail |
| libproc second-agreement check removed | `Expected: "Thu Oct 23 10:00:00 2026"` / `Received: "Thu Oct 23 10:00:00 2026+000001"` in `(fail) … libproc unavailable, throwing, or disagreeing with ps on the second`. 0 pass / 1 fail |

The first four are the ones the coordinator required. A fifth-to-eighth row was added for the sites the new tests were written to guard. No injection went RED in a test other than the ones named.

## Gates

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/595r4-src.txt 2>&1`: **exit 0, 5098 pass, 5 skip, 0 fail** (274 files, 5103 tests). No load flake this run.
- `src/bus` alone: exit 0, 1058 pass, 0 fail.
- `bun run lint`: **exit 0** (warnings/infos are the repo's existing ones). The five touched files were also run through `biome check --write` first.
- Typecheck (`tsc --noEmit -p .`): **154 errors, 154 at `f7e4c5ed`**; none in a file this change touches.
- Versions: `plugin.json` and `marketplace.json` both 2.2.355 (unchanged).

## Residuals

- **Crash window (Fix 1):** fork to the end of the atomic `rename` of `owner.json` (identity read + write, ms on Linux, tens of ms on macOS). A daemon death inside it leaves an unrecorded claude. Closing it needs an intent record written before the fork; not done (schema and `decideResume` contract change).
- **Pre-upgrade claude:** a child left by a pre-upgrade daemon has no record; the first restart after the upgrade resumes beside it. Later spawns are all recorded or failed.
- **A failed unrecorded-spawn whose identity could not be read** can only be confirmed gone by the pid no longer existing (no record to bind a SIGKILL to); if that cannot be confirmed the session is quarantined.
- **macOS low-precision identity** (libproc unavailable, e.g. a non-Bun runtime or a failed `dlopen`): second-precision `lstart`. It may still authorise a signal, only with the existing uid + argv revalidation immediately before each signal; the reap log says `identity_precision=low-1s`. macOS argv remains flat `ps` text (libproc gives the start time, not argv).
- **Read-to-signal race** remains (no identity-bound handle on either platform); it is now microseconds wide on macOS too.
- **A failed `/clear`** (replacement exited) leaves the agent down with the fresh id stored; recovery is the next start/restart, which creates that session. Not auto-retried: a crashing boot should not loop.
- `getAgent()` returns undefined for the 0-4 s a new process is awaiting its record; callers treat that as "not spawned yet", which is the intent.
- No live end-to-end run with the real CLI (authentication out of scope); real processes, real `ps`/libproc reads and real signals run in the manager tests.

# Round 5

Branch `fix/595-bus-session-resume`, on top of `fc2e1fa5`. Code + tests in `1f3b788a`; this report in the commit after it. Nothing is pushed to `feat/550-pty-default`. The #562 round-9 fence, quarantine and synchronous spawn-check design is unchanged (no edit near `assertSessionWritable` / `assertSessionSpawnable`). The eight findings Codex closed in round 4 stay closed; the only existing assertions that changed are the three that encoded "a second-precise match may signal" (Fix 2) and one that carried `lowPrecision: false`.

Codex's round-4 review: 1 HIGH (win32), 2 MEDIUM (macOS low precision still signals; prompt before the record exists).

## Fix 1 — HIGH: no ownership record on win32

The record is written on every platform, the probe reads POSIX state (`ps`), and since round 4 a failed write is fatal, so every Windows spawn would have been retired.

Ruling applied: one shared predicate, `ownershipGuardApplies(platform)` (`session-ownership.ts:41`, false only for `win32`), used by BOTH halves: the restart-time decision (`session-manager.ts:1164`, which replaced the inline `process.platform !== "win32"`) and the spawn-time record (`recordSpawnOwnership`, `session-manager.ts:1528`). `SessionManagerOptions.platform` is the test seam. Windows keeps its pre-#595 behaviour: no record written, none read, no probe.

## Fix 2 — MEDIUM: a second-precise identity never authorises a signal

`decideResume` (`session-ownership.ts:735-739`) now throws `RotateSignal("resume-identity-low-precision")` before the uid and argv checks when the live read is flagged `lowPrecision`, or when exactly one of the record and the live identity carries microseconds. Both-high (Linux `btime:ticks`, or macOS `<lstart>+<usec>` on both sides) is the only path to a signal, and uid + argv are still weighed after it. `sameStart` is unchanged: a second-precise match still answers "gone or reused?" (a different second resumes as `pid-reused`), and a same-second one reads as alive, which now rotates instead of being killed. `ResumeDecision.lowPrecision` and the `identity_precision=low-1s` log text are gone (the case cannot occur); `RotateReason` gained the new code.

## Fix 3 — MEDIUM: no prompt before the record exists

"Recording pending" is a state of its own, not "unavailable".

- `SessionManager.recordingPending(agentId)` (`session-manager.ts:1967`): non-null while the agent's claude is spawned and not yet `deliverable`; the promise (`AgentRecord.recorded`, `:857`) resolves with `deliverable` (`:1407`) and REJECTS when the record failed (`:1403`, before the retirement starts, so waiters fail at once). `getAgent()` still hides the process (slash relay and other callers unchanged).
- `BusCore.sendPrompt` (`core.ts:1248-1249`) asks `RecordingPendingCheck` first. A pending agent goes to `sendWhenRecorded` (`core.ts:1299`): the prompt waits for the record, at most `deliveryBackstopMs` (the bus's existing delivery timer, 4 s default), then goes through the normal path, so BOTH transports (PTY typing and the IPC `prompt` frame) only ever see an agent that is recorded. Prompts held for one agent resume in arrival order. An agent with nothing pending takes the same synchronous path as before (ack tick count unchanged).
- Recording fails, or the wait runs out: the prompt is delivered nowhere and rejects with `AgentNotRecordedError` (`core.ts:248`), `reason` `recording-failed` or `recording-timeout`; one `[bus-ipc] undeliverable` line carries the reason.
- Wired in `runtime-mount.ts:423` (detached at both teardown sites, `:745`, `:778`).

## Sites changed

| Site | Change |
|---|---|
| `session-ownership.ts:41` | `ownershipGuardApplies` |
| `session-ownership.ts:647`, `:735-739` | `resume-identity-low-precision` code; refusal before the uid/argv gate; `lowPrecision` removed from the resume decision |
| `session-manager.ts:1164`, `:1528` | both halves keyed on the shared predicate; `options.platform` seam |
| `session-manager.ts:857`, `:1255-1270`, `:1403-1407`, `:1967` | `recorded` / `settleRecorded`, settle points, `recordingPending()` |
| `core.ts:241`, `:248`, `:411`, `:480`, `:1248-1249`, `:1299`, `:2558` | `RecordingPendingCheck`, `AgentNotRecordedError`, setter, gate in `sendPrompt`, `sendWhenRecorded` |
| `runtime-mount.ts:423`, `:745`, `:778` | wiring and detach |
| tests | `session-ownership.test.ts` (3 rewritten + 4 added: both-sides low precision, record-side low, live-side low, refusal ahead of uid/argv, both-high signals, both-high still uid/argv gated, different second still resumes), `session-ownership-manager.test.ts` (+1: win32), new `prompt-before-record.test.ts` (8: six at the bus with a manual pending promise, two end to end with a real `SessionManager` whose `store.write` is a manual promise and a real IPC client) |

## Fault injections (one site per `git archive` copy of `1f3b788a`)

Each test carries its `Fault … Predicted result` comment, written before the run. Verbatim from the run output:

| Injection | RED |
|---|---|
| **win32 gate dropped** (`!ownershipGuardApplies(...)` removed from `recordSpawnOwnership`) | `SpawnUnrecordedError: agent a: the spawned claude could not be recorded (identity-read), so it was ended and the spawn failed; it is not confirmed gone, so its session is quarantined` in `(fail) … > win32 keeps its pre-#595 behaviour: no record is written, none is read, the spawn succeeds and the session is resumed`. 0 pass / 1 fail |
| **seconds-only match authorises a signal** (the whole refusal removed) | `-"kind": "rotate", -"reason": "resume-identity-low-precision"` / `+"kind": "resume", +"reapedPid": 900, +"reason": "orphan-reaped"` in 4 tests: `a second-precise LIVE read of a process recorded at microsecond precision is not signalled`, `a second-precise RECORD against a microsecond live read is not signalled either`, `second precision on both sides is not signalled`, `second precision refuses before uid and argv are even weighed`. 46 pass / 4 fail |
| record-side clause dropped (only the `includes("+")` mismatch) | `(fail) … > a second-precise RECORD against a microsecond live read is not signalled either: rotate`. 49 pass / 1 fail |
| live-side flag dropped (only `lowPrecision === true`) | `(fail) … > second precision on both sides is not signalled` and `… > second precision refuses before uid and argv are even weighed`. 48 pass / 2 fail |
| **pending treated as unavailable again** (bus: `pendingRecord = null`) | `expect(typed).toEqual([])` `- Expected - 1 / + Received + 3` (PTY typed at once) and `expect(client.prompts()).toEqual([])` `- Expected - 1 / + Received + 10` (IPC frame sent at once); also `expect(err).toBeInstanceOf(AgentNotRecordedError)` `Received value: null`. 1 pass / 7 fail |
| manager reports nothing pending (`recordingPending` returns null) | `expect(mgr?.recordingPending("a")).not.toBeNull()` `Received: null`; the failing-write test gets `SpawnUnrecordedError` only. 6 pass / 2 fail |
| failure never settles the held prompts (`settleRecorded.fail` removed) | `expect((sendErr as AgentNotRecordedError).reason).toBe("recording-failed")` `Expected: "recording-failed"` / `Received: "recording-timeout"`. 7 pass / 1 fail |

## Gates

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/595r5-src.txt 2>&1`: **NOT a clean exit 0 on this machine. Two full runs, both exit 1, all failures timing-dependent.** Run 1 (load 65 to 437): 5110 pass, 5 skip, 2 fail (`core.test.ts` stuck-compaction re-delivery, `jsonl-tailer` startAt live-tail). Run 2 (load ~90 falling to 33): 5102 pass, 5 skip, 10 fail (`pty-process` approval-dialog timer, two `session-ownership-manager` real-process tests that wait ~3 s for a stand-in `claude` to start, six `host-telemetry-provider` and one `skills-fitness` tuner test at their 5000 ms timeout). The failing set differs on every run.
- **Rerun alone:** every `src/bus` and `pty-process` failure passed on rerun (`core.test.ts` file 157/0; the stuck-compaction test 2 of 2; `pty-process.test.ts` 0 fail; the named `session-ownership-manager` tests 3 of 3). The two tuner files (`host-telemetry-provider.test.ts`, `skills-fitness.test.ts`) still failed alone at load ~65, and **they fail the same way (5000 ms timeouts) on a `git archive` of `fc2e1fa5`**: unrelated to this change (nothing under `src/tuner` is touched).
- `src/bus` alone (last run, load ~37): 1068 pass, 4 fail, all timing: `inject-turn-net` (#215), two `jsonl-tailer` `onTurnObserved`, one real-process ownership-manager test. `inject-turn-net.test.ts` is itself flaky on `fc2e1fa5`: 3 of 4 runs failed there with no change of mine. The seven files this round touches or sits beside (`session-ownership`, `session-ownership-manager`, `prompt-before-record`, `session-resume`, `core`, `session-manager`, `jsonl-tailer`) ran together once: 354 pass, 1 fail (a `core.test.ts` 256 ms timer test that passes alone, 3 of 3, on both trees).
- The new `prompt-before-record.test.ts` (8) and the rewritten `session-ownership.test.ts` (50) were green on every run they were in. The win32 test passed alone.
- `bun run lint`: **exit 0** (the repo's existing warnings; the seven touched files are clean). Typecheck (`bun run typecheck`): **149 errors, baseline 149**.
- Versions: `plugin.json` 2.2.355 (unchanged).

## Residuals

- **win32 has no ownership guard at all** (named as required): no record, no orphan check, no `resume-identity-low-precision`. A claude left by a previous daemon can still be resumed beside. Same as before #595; the bus PTY is off by default there.
- **macOS without libproc now rotates where it used to reap.** A second-precise identity (non-Bun runtime, failed `dlopen`, or a record written that way) is never killed, so that restart loses the conversation (fresh id) and the orphan is left running. The cost of "no signal on a second-precise match"; Linux and macOS-with-libproc are unaffected.
- **Only `sendPrompt` is gated.** The other IPC sends (`ask_answer`, `permission_response`, `job_result`, the reply nudge) answer the child's own requests or follow a turn, so an unrecorded child has none outstanding; `getAgent()` callers (slash relay) still see "not spawned" during the window.
- **The wait is bounded by `deliveryBackstopMs` (4 s), the record by two 4 s steps (`RECORD_STEP_MS`).** On a very slow disk or `ps` a prompt can fail with `recording-timeout` while the record is still pending; it is not delivered, a later prompt works once the record exists. Callers that need to retry must.
- Held prompts do not count against the per-agent queue caps while they wait (bounded by the 4 s window).
- Round-4 residuals otherwise unchanged (crash window fork-to-`rename`, pre-upgrade claude, read-to-signal race, flat macOS argv).
- Test timing: the machine was at load average 65 to 437 for this round (84+ users, other agents). Real-process manager tests and a few timer tests in `core.test.ts` / `jsonl-tailer.test.ts` flake under it; every flake named in the gate passed rerun alone.
