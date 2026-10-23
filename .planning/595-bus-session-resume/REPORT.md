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
