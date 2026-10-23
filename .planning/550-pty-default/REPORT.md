# Issue #550 implementation report

Implemented on `feat/550-pty-default` from `povai/main` at `d81bd579`. The testable requirements are implemented. Merge and rollout remain blocked on the independently owned #559 fix, the #548/#549 utility dependencies, and the operator's 48-hour soak. README.md is deliberately untouched because PR #558 owns its rewrite.

## Changes

- DEFAULT_SETTINGS.pty.enabled is true, including freshly generated settings. Missing values default true; literal false is preserved; invalid enabled values warn without logging the supplied value.
- defaultSupervisionFor selects pty-stdin for every BusOrigin (discord, telegram, slack, webui, cron, heartbeat, cli, rest). Explicit agent supervision, including process-stream-json, remains authoritative.
- Bootstrap now follows the same configured engine as other agent turns. Primary-corruption, stale-session and post-compaction retries route through a shared recovery helper. PTY recovery retires the old process before reading the reset session store or resuming the compacted transcript. Explicit print recovery remains supported and tested.
- Startup emits the effective runner-turn, cron-job and bus non-channel default engines, plus every declared agent's supervision override.
- docs/pty-migration.md explains upgrade behavior, both print opt-outs, restart requirements and startup/spawn/process verification. The job-loop comment and warning now accurately describe the configured engine.
- Print-specific bus fixtures explicitly request process-stream-json. Existing runner default/bootstrap assertions were updated. The #559 restoreDir defect was not changed; its routing suite was run in an isolated temporary cwd to protect developer state.
- Both plugin manifests were bumped with the prescribed scripts; the branch is at 2.2.341 (main is 2.2.340).

## Bus confirmation and cron proof

The due-job test drives createJobLoop.tick into the actual runner with freshly generated defaults. Its execution seams record a PTY call and zero print calls; the explicit-false control records one print call and zero PTY calls.

The cron and dispatched-job-result tests use createBusCore, createPromptStreamHandler, the real PtyAgentProcess confirmation loop, and receipt storage. A fake PTY records the submitted envelope and feeds an actual PromptIngestion observation back to the process. Both return turn-started and stamp that verdict in the receipt. Dispatched jobs currently return to their dispatcher using origin=cron and origin_id=agent-job:<id>; the test exercises deliverAgentJobResult rather than introducing a new job origin. The headless job-worker engine is separately covered by the existing #546 routing suite.

## Validation

All test runners were invoked directly, with output captured and summarized in context-mode; none were piped to head/tail. The full suite was not run because of the documented cross-test pollution.

| Command | Result |
| --- | --- |
| `bun test src/__tests__/pty-config.test.ts src/__tests__/pty-default-runner.test.ts src/__tests__/execution-engines.test.ts src/__tests__/job-loop.test.ts` | 105 pass, 0 fail |
| `bun test src/bus/__tests__/agent-resolver.test.ts src/bus/__tests__/pty-default-delivery.test.ts src/bus/__tests__/wiring.test.ts src/bus/__tests__/scheduler-wiring.test.ts` | 34 pass, 0 fail |
| `bun test src/bus/__tests__/build-claude-args.test.ts src/bus/__tests__/agent-job-delivery.test.ts src/bus/__tests__/runtime-mount.test.ts` | 43 pass, 0 fail |
| `bun test src/bus/__tests__/session-manager.test.ts` | 48 pass, 0 fail, 95.37 seconds |
| `bun test <absolute path>/src/__tests__/pty-enabled-routing.test.ts` in isolated temp cwd with src symlink | 18 pass, 0 fail |
| `bun test <absolute path>/src/__tests__/pty-backward-compat.test.ts` in isolated temp cwd with src symlink | 8 pass, 0 fail |
| `bun run lint` over the whole repository (JSON reporter for final diagnostic summary) | exit 0; 0 errors, advisory warnings remain |
| `bun run typecheck` | baseline and final: 149 diagnostics against baseline 149; exit 0 |
| `git diff --check` | clean |
| both version bump scripts | 2.2.341 |

The initial 55-second cap on the session-manager file was inadequate after lifecycle fixtures began using PTYs by default; the complete scoped rerun passed in 95.37 seconds. The earlier capped invocation was not counted as a pass. No live Claude model turn or production daemon check was performed. CLI 2.1.302 is installed, but #559 is an existing independently owned merge blocker; no claim of resolving or live-verifying it is made here.

## TDD and fault injection

Before implementation, config/default tests failed with Expected true / Received false, the non-channel origin test failed with Expected pty-stdin / Received process-stream-json, bootstrap reported legacy, and all three recovery route tests recorded zero PTY calls. The startup tests initially failed because execution-engines.js did not yet exist.

Seventeen independent faults were injected and reverted in finally blocks. Each regression below is a verbatim RED runner line. The duplicate startup-log probe was repeated after making its assertion produce compact failure output.

### generated default

```text
(fail) #550 default runner routing > a due cron job reaches PTY with freshly generated defaults [177.49ms]
```

### missing/invalid parser default

```text
(fail) parseSettings — pty defaults > applies all defaults when pty block is missing [8.67ms]
```

### explicit false opt-out

```text
(fail) parseSettings — pty defaults > respects an explicit pty.enabled = false [9.56ms]
```

### invalid setting warning

```text
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled="false" [22.18ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=0 [2.64ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=null [5.08ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled={} [1.95ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=[] [3.17ms]
```

### bus default every origin

```text
(fail) defaultSupervisionFor > returns pty-stdin for channel-driven origins [1.57ms]
(fail) defaultSupervisionFor > returns pty-stdin for non-channel origins [0.13ms]
```

### explicit bus agent print mode

```text
(fail) process-stream-json supervision > keeps explicit process-stream-json for cron origin [2231.85ms]
```

### bootstrap route

```text
(fail) #550 default runner routing > bootstrap follows PTY rather than an unconditional print exception [261.65ms]
```

### corruption retry

```text
(fail) #550 default runner routing > corrupt retry retires the old PTY and follows the configured engine [197.28ms]
```

### stale retry

```text
(fail) #550 default runner routing > stale retry retires the old PTY and follows the configured engine [131.74ms]
```

### post-compact retry

```text
(fail) #550 default runner routing > compact retry retires the old PTY and follows the configured engine [166.36ms]
```

### retire failed PTY before recovery

```text
(fail) #550 default runner routing > corrupt retry retires the old PTY and follows the configured engine [120.42ms]
(fail) #550 default runner routing > stale retry retires the old PTY and follows the configured engine [83.73ms]
(fail) #550 default runner routing > compact retry retires the old PTY and follows the configured engine [114.50ms]
```

### startup log wiring

```text
(fail) #550 startup engine summary > startup actually emits the summary [41.19ms]
```

### bus prompt-ingestion confirmation

```text
(fail) #550 non-channel PTY delivery > cron reaches the #361 loop and confirms from actual prompt ingestion [253.81ms]
(fail) #550 non-channel PTY delivery > agent-job reaches the #361 loop and confirms from actual prompt ingestion [224.21ms]
```

### startup effective engine values

```text
(fail) #550 startup engine summary > names the runner, cron and bus default engines [14.21ms]
```

### agent resolver print override

```text
(fail) resolveBusAgentConfig — defaults > keeps the explicit process-stream-json opt-out [10.83ms]
```

### startup log wiring (compact assertion)

```text
(fail) #550 startup engine summary > startup actually emits the summary [3.83ms]
```

### recovery explicit print selection

```text
(fail) #550 default runner routing > corrupt retry preserves the explicit print opt-out [217.24ms]
(fail) #550 default runner routing > stale retry preserves the explicit print opt-out [131.38ms]
(fail) #550 default runner routing > compact retry preserves the explicit print opt-out [120.82ms]
```

## Remaining print-path inventory

Line numbers below refer to the delivered source; utility migrations are not duplicated in this branch.

| Path | Remaining print behavior and reason |
| --- | --- |
| src/runner.ts:913, buildAgentJobArgs / runAgentJobHeadless | Explicit pty.enabled=false path only; default headless jobs take ephemeral PTY before the builder runs. |
| src/runner.ts:1927, primary args / runClaudeStream | Args are still constructed for compatibility; execution selects print only for explicit pty.enabled=false. Bootstrap follows this same guard. |
| src/runner.ts:2156, fallback args | Print only when the primary route is explicit legacy; the default fallback uses its own PTY/session store. |
| src/runner.ts, execRecovery | runClaudeStream is gated by the same explicit legacy selection. Corruption/stale/post-compaction retries use PTY by default. |
| src/runner.ts:2785, streamClaude | Explicit legacy branch only; default dashboard/chat streaming returns through execClaude on PTY before this print spawn. |
| src/runner.ts:3102, runFork | Explicit legacy branch only; default forks use an ephemeral PTY outside the main LRU/kill scope. |
| src/bus/session-manager.ts:669 | -p flags only for explicit process-stream-json supervision. Every origin now defaults PTY. |
| src/runner.ts:1581, runCompact | Trusted-session utility; #549 owns the live-PTY and runOneShot migration. This default flip does not duplicate it. |
| src/runner.ts:2554, precompact memory save | Trusted-session utility owned by #549. |
| src/rotation.ts:93 | Trusted-session rotation-summary utility owned by #549. |
| src/commands/stop.ts:54 | Shutdown memory-save utility owned by #549. |
| src/commands/discord.ts:592 | Untrusted classifier; #548 centralises it. Untrusted routes must stay print until the PTY isolation spike is green. |
| src/skills-tuner/core/llm.ts:38 | Untrusted tuner CLI backend; #548 centralises it and keeps claude_cli as the supported print alias. |
| tools/memory-search/memory_search/recall.py:79 | Untrusted standalone Python recall summarizer; #545 isolation must remain intact and #548 keeps parity. |

The historical -p mention in src/bus/agent-jobs.ts is a comment about old fire scripts, not a remaining spawn. The operator goal of no default print agent turns is implemented; utility print calls remain explicit scope/dependency exceptions, not silently converted to unverified untrusted PTYs.

## Exact operator 48-hour soak checklist

Do not start this soak until #559 is merged and verified and the #548/#549 dependencies are integrated.

1. Record deployment commit, plugin/marketplace versions, Claude CLI version, UTC start time and intended end time at least 48 hours later. Save the engine settings used. Use default PTY settings with no unintended process-stream-json overrides.
2. Restart the daemon. Capture the startup engine summary and per-agent spawn logs. Verify the declared overrides match the actual processes; record PIDs and whether a print flag is present, without copying whole command lines or credentials into the report.
3. On a fresh session, send ordinary channel chat through runUserMessage with its real timestamp prefix intact. Confirm submission, one reply and completion before the timeout. Repeat across configured channels. Any recurrence of #559 fails the soak.
4. Allow due cron jobs to execute repeatedly across the 48-hour window, including a scheduled daily job. Confirm each runs once on the configured model/timeout with the expected notify/retry behavior and reaches PTY. Compare job results, spawn PIDs and timestamps; no -p process may serve an agent or cron turn.
5. Dispatch an agent job. Confirm the worker starts on PTY, completes, and its result reaches the dispatcher once through agent-job:<id>. Inspect cron/job receipt delivery_outcome=turn-started and investigate any unconfirmed-idle, unconfirmed-live or stuck-compaction result.
6. Exercise a non-channel CLI/REST or heartbeat prompt on the bus. Confirm pty-stdin supervision and delivery confirmation. Check there are no duplicate prompt submissions or missing replies.
7. At approximately hour 24, restart the daemon. Recheck startup engines and PIDs, session continuity and newly due jobs. Repeat fresh chat after restart; confirm no lingering old writer owns the same transcript.
8. Run /compact on a live session, then another chat and a job. Verify the #549 live-session flow, preserved context and successful post-compaction turn; no print process may serve the agent retry. Deliberate trusted utility fallback is recorded separately.
9. Throughout the window, correlate process samples with spawn/turn logs. Record all timeouts, retries, unexpected exits, dropped/duplicate deliveries, rate-limit fallbacks and tool/MCP failures. Utility print calls must be distinguishable from agent turns and cron jobs using the inventory above.
10. At or after hour 48, record UTC end time, workload counts, restart/compaction evidence and failures. A pass requires the stated workload, no print agent/cron processes and no unresolved correctness failures. Attach the result summary to the coordinator's PR before rollout.
11. If the soak fails, retain the evidence, keep rollout blocked, set pty.enabled=false and the appropriate per-agent process-stream-json overrides, restart, and verify the fallback startup summary and processes.

## Review, prior art and handoff

Reviewed the diff for isolation and session-store boundaries: no critical or high security issue found. Recovery preserves model/API/security/system context and selects the fallback store when appropriate. No credential values, user prompts or environment dumps were added to startup logging.

No Ultra code was reused; the provided prior-art check found the same defaultSupervisionFor and no alternative implementation needed for this default change. README.md was not edited; the coordinator should add the migration-guide link and new defaults after #558 merges. No PR, merge or GitHub comment was created. The unrelated untracked #559 investigation SPEC and local memory/Serena scaffolding are excluded from task commits.

## Review-fix pass — task_016cc3fe4f34

This section supersedes the initial report where behavior changed. Applied the supplied Opus review (no CRITICAL/HIGH findings) as additional work on top of 451c9359, without rewriting branch history.

### Fixes and evidence

- M1: exhausted final PtyTurnTimeoutError now produces exit 124; unrelated errors remain exit 1. The compact fixture delegates to the real supervisor with a PTY double throwing the real timeout error, rather than fabricating a supervisor 124 result. Runner retirement and disposal precede the precompact memory-save and compact print utilities, eliminating the concurrent transcript writer. Its ordinary postcompact recovery retirement remains idempotent.
- Corrupted-session recovery now recognizes a line beginning API Error containing the thinking signature error even when the REPL returns exit 0. Primary and fallback-session paths both reset and retire their own stores/process keys. Tests use HTTP400 JSON with backticks around signature and thinking. This is executable PTY recovery, not a print-only exception; ordinary signature prose without the API-error line is not newly treated as failure.
- M2: normal startup schedules bootstrap in the background, logs success/failure, and proceeds to preflight, hot reload and job wiring. Bootstrap synchronously reserves the global runner queue before asynchronous session lookup, preserving context ordering with later global chat. It gets one turn attempt, no supervisor retries/respawns or rate-limit fallback, and a turn deadline of min(configured timeout, 30 seconds). Supervisor admission/serialization stages retain their existing individual deadlines; this is not a claim that every stage shares one total 30-second wall-clock budget. A never-settling bootstrap cannot block the next startup step, proved with a 40ms rejection bound. The runner fixture also proves the single timed-out attempt releases a later queued chat.
- M3/M4: recovery uses config.model || modelOverride, matching primary model choice; PTY rate-limit fallback forwards both chunk and tool-event callbacks.
- M5: invalid pty.enabled warnings are deduplicated for each distinct JSON value for the life of the process, including repeated reloads. The bad value itself is never logged.
- M6: migration guidance now states runner engine flips apply after the approximately 30-second settings reload; bus-agent supervision/runtime changes require restart. It narrows the origin fallback change to agents spawned without resolver-selected supervision, since resolved declared agents already defaulted to PTY.
- M7: startup logging is exercised through the actual logger helper called by start, replacing source-string inspection. Removed the bootstrap source prohibition covered by routing behavior. Added actual SessionManager.spawnAgent cron selection with no declared supervision, alongside the explicit print control.
- Both bump scripts ran twice, moving plugin and marketplace plugin entries from 2.2.337 through 2.2.338 to 2.2.339; merging main (2.2.340) and a further bump took the branch to **2.2.341**. Read-back asserted both equal 2.2.341.

### Final review validation

Tests ran with Bun directly, using absolute test paths and --preload <repo>/scripts/test-preload.ts in isolated temporary working directories with a src symlink. This protects state from the known routing/supervisor test cleanup behavior. No test output was piped into head/tail.

| Scope | Result |
| --- | --- |
| bun test pty-config, pty-default-runner, startup-initialization, execution-engines and job-loop | 114 pass, 0 fail |
| bun test pty-supervisor | 78 pass, 0 fail |
| bun test pty-integration, pty-enabled-routing and pty-backward-compat | 34 pass, 0 fail |
| bun test bus agent-resolver, pty-default-delivery, wiring and scheduler-wiring | 34 pass, 0 fail |
| bun test bus session-manager --test-name-pattern 'without declared supervision\|explicit process-stream-json' | 2 pass, 0 fail |
| Total scoped final tests | **262 pass, 0 fail** |
| bun run lint --reporter=json, whole repository | exit 0; 0 errors, 1235 advisory warnings, 323 informational diagnostics |
| bun run typecheck, repository ratchet | exit 0; 149 diagnostics, baseline 149, unchanged |
| git diff --check | clean |

Before implementing the review fixes, the new timeout test returned 1 instead of 124, the actual compact test showed retirement after utility invocation, rendered-error tests did not recover, model override was empty, callbacks were absent, and four reloads warned four times instead of twice. The new startup test initially failed to import the not-yet-created module. After implementation, **14 single-site fault injections** independently made the tests below go RED; each injection was reverted in a finally block before proceeding. All final results above were obtained after restoring the production code.

### timeout-status

```text
(fail) pty-supervisor retry and backoff > returns 124 when its final turn failure is a timeout [80.67ms]
```

### no-retries

```text
(fail) pty-supervisor retry and backoff > retry false permits exactly one turn and no respawn despite global retry settings [17.80ms]
```

### retire-before-utility

```text
(fail) #550 default runner routing > retires the actual timed-out PTY before memory save or compact can resume it [366.77ms]
```

### rendered-primary

```text
(fail) #550 default runner routing > recovers signature errors rendered by a PTY that returned exit zero [270.71ms]
```

### rendered-fallback

```text
(fail) #550 default runner routing > recovers a signature error rendered by the fallback PTY [269.26ms]
```

### recovery-model

```text
(fail) #550 default runner routing > keeps the model override when retrying a fallback whose configured model is empty [941.94ms]
```

### fallback-chunks

```text
(fail) #550 default runner routing > streams chunk and tool events during a rate-limit fallback [164.91ms]
```

### fallback-tools

```text
(fail) #550 default runner routing > streams chunk and tool events during a rate-limit fallback [159.94ms]
```

### dedup-warning

```text
(fail) parseSettings — pty defaults > warns once per distinct invalid enabled value across reloads [43.36ms]
```

### background-bootstrap

```text
(fail) background startup initialization > a never-completing bootstrap does not delay the next startup step [46.04ms]
```

### bootstrap-one-attempt

```text
(fail) #550 default runner routing > bootstrap reserves the queue, uses one bounded attempt, and releases a later chat [501.80ms]
```

### bootstrap-deadline

```text
(fail) #550 default runner routing > bootstrap reserves the queue, uses one bounded attempt, and releases a later chat [1881.51ms]
```

### startup-log

```text
(fail) #550 startup engine summary > startup actually emits the summary [16.49ms]
```

### spawn-origin-default

```text
(fail) pty-stdin supervision > spawnAgent selects PTY for cron without declared supervision [291.71ms]
```

### Remaining scope and manual checks

No requested review fix remains undone. README.md and issue #559 were not changed. No new Ultra code was reused: this pass adapts the existing Plus supervisor and runner rather than copying the diverged Ultra runner. The original remaining-print inventory and exact 48-hour operator soak checklist above remain applicable; trusted utility calls still await #549 integration. No live Claude or production-daemon verification was performed in this pass, and no fix for #559 is claimed. Keep the independent #559 and #548/#549 integration checks and the operator soak as rollout gates.

Security review of this follow-up found no CRITICAL/HIGH issue: retirement respects session keys, recovery separates primary/fallback stores, and logging adds no prompt, credential or environment values. Local memory checkpoint was appended by the memory worker; Graphiti ingestion was queued but not confirmed by immediate read-back.

## PR 562 Codex fallback-stream finding — task_d6cfe1f8b211

Fixed duplicate dashboard fallback replies. PTY fallback chunks were forwarded to the dashboard, then streamClaude unconditionally emitted the complete fallback stdout again because usedFallback was true. RunResult now tracks fallbackStreamedText independently of primary text; only a fallback that emitted no nonempty text gets its buffered stdout emitted at completion. Tracking resets for each fallback/recovery attempt. Empty chunks do not count as text. Non-streaming stdout and legacy print execution are unchanged.

The new isolated fixture drives the actual streamUserMessage("chat") path: its primary PTY streams a rate-limit notice, then its fallback PTY streams two reply chunks or emits only an empty chunk. The streamed-answer test failed before implementation:

```text
(fail) #550 default runner routing > dashboard emits a PTY fallback reply exactly once when it streams chunks [255.89ms]
```

Two independent single-site mutations of the final-emission decision proved both guards; each mutation was restored in a finally block before final validation:

1. Force final stdout emission despite streamed fallback chunks:

```text
(fail) #550 default runner routing > dashboard emits a PTY fallback reply exactly once when it streams chunks [148.10ms]
```

2. Suppress final stdout emission for a silent fallback after the primary notice:

```text
(fail) #550 default runner routing > dashboard emits silent fallback stdout once after the primary streamed its notice [288.89ms]
```

Final validation used Bun with --preload <repo>/scripts/test-preload.ts and absolute test paths in isolated temporary working directories with a src symlink. No runner output was piped into head/tail and no full suite was run.

| Command/scope | Result |
| --- | --- |
| bun test runner.test.ts pty-default-runner.test.ts | 50 pass, 0 fail |
| bun test pty-enabled-routing.test.ts pty-backward-compat.test.ts | 26 pass, 0 fail; includes PTY and legacy print fallback controls |
| Total | **76 pass, 0 fail** |
| bun run lint --reporter=json over whole repository | exit 0, 0 errors, 1235 warnings, 323 informational diagnostics |
| bun run typecheck ratchet | exit 0, 149 diagnostics against baseline 149, unchanged |
| git diff --check | clean |

No requested fix remains undone. Version 2.2.341 is deliberately unchanged under the explicit no-bump dispatch instruction. No new Ultra code was reused. No live Claude, browser or production SSE check was performed; dashboard delivery is proved at its runner stream callback boundary. README and issue 559 remain untouched, existing external integration/operator soak gates remain applicable, and no GitHub comment or thread resolution was posted.

## Hot-switch to print (connector P1)

Codex connector P1 on `docs/pty-migration.md:71` (thread PRRT_kwDOR1KQD86t-zcC): when `pty.enabled`
flips true → false, the next runner turn resumed the session on `claude -p --resume` while an idle
PTY still owned the session key, so two writers shared one transcript (or the CLI refused with
"Session ID ... is already in use").

**Fix.** `retireLivePtysBeforePrint(keys)` in `src/runner.ts`: reads `liveSessionKeys()` first (an
empty list returns at once, so a print-only install pays nothing), then `retirePtySession(key)` for
each of the turn's keys that is live. `retirePtySession` carries the round 8/9 fence and rejects
with `PtyQuarantinedError` when the exit is unconfirmed; nothing catches it, so the turn rejects and
no legacy process starts (the same propagation as the existing PTY recovery retire).

| Call site | Keys retired | Why |
| --- | --- | --- |
| `execClaude`, before the primary/recovery/fallback legacy spawns | `ptySessionKey` (global / `agent:<n>` / `thread:<id>`) and `fallback:<key>` | one retire covers `runClaudeStream` for the primary, `execRecovery` and `execFallback` |
| `streamClaude`, before its `spawnClaude` | `global` | the dashboard chat resumes the global session on print |

Not changed, because they never resume a session: `runFork` (fresh `fork:<uuid>`), `runAgentJobHeadless`
(fresh `job:<agent>:<id>`), and `bootstrap` (goes through `execClaude`). Bus agents stay out of scope.

**Tests** (`src/__tests__/pty-hot-switch-to-print.test.ts`, 5): live PTY on `global` and on
`agent:<name>` then `pty.enabled` false, the PTY is already disposed at the moment of the legacy
spawn; the dashboard chat does the same; a rejected retirement means no legacy spawn and the turn
rejects with `PtyQuarantinedError`; no PTY entry means `retirePtySession` is never called.

**Injections**, one site at a time on `git archive` copies (predicted before running):

| Injection | Predicted | Result |
| --- | --- | --- |
| remove the `execClaude` retire block | global, agent, quarantine tests RED | 3 fail: `Expected to contain: "global"  Received: []`; `Expected to contain: "agent:hotswitch-agent-30598"  Received: []`; `expect(received).rejects.toBeInstanceOf(expected)  Received promise that resolved` |
| move the `execClaude` retire block after the legacy exec | global, agent, quarantine RED | 3 fail: `expect(received).toEqual(expected)  [ - true, + false ]` (PTY not yet disposed at the spawn) on global and agent; `Expected length: 0  Received length: 1` on quarantine |
| remove the `streamClaude` retire call | dashboard test RED | 1 fail: dashboard chat test |
| move the `streamClaude` retire call after `spawnClaude` | dashboard test RED | 1 fail: `expect(received).toEqual(expected)  [ - true, + false ]` |

A first run of the injections also turned the "no PTY entry" test red, which exposed a test defect:
`spy.mockRestore()` at the end of a test is skipped when an assertion throws, so recorded calls leaked
into the next test. Spies are now restored in `afterEach` (`mock.restore()`), and the rerun above is
the clean one.

## Final round: pending spawns and fallback retirement

Terry's ruling (2026-10-22): one last round on #562 for Codex's review of `d55ed950` (HIGH, issue #592,
and a MEDIUM). Nothing else was changed; other observations are under Residuals.

### Fix 1 (HIGH, #592): retirement owns pending spawns

`retireEntry` fenced the session only when a PTY had landed and finished without joining
`entry.spawnInFlight`. A spawn or respawn still in its ready-settle (`spawnPty`, ~3 s) survived the
retirement; print, or a replacement admission, then resumed the same transcript before `landPty`
disposed the late arrival.

| Site | What |
| --- | --- |
| `src/runner/pty-quarantine.ts:118` `fenceKey(sessionKey, owner, sessionId?)` | key-level fence with no `PtyProcess`; the owner is the retiring entry, the session id is read at check time (`isFenced`, `:161`) |
| `src/runner/pty-quarantine.ts:135` `quarantineSession(..., alsoLift)` | the fence and the record change hands in one synchronous step for the entry owner too |
| `src/runner/pty-supervisor.ts:2056` `retireEntry` (fence at `:2066`) | fences the key before the first await whether or not `entry.pty` is set |
| `src/runner/pty-supervisor.ts:2090` | `joinPendingSpawns(entry)` is a third member of the disposal/release settle; the entry stays in the map and the fence is held until it ends |
| `src/runner/pty-supervisor.ts:2122` `joinPendingSpawns` | waits for `spawnInFlight` to settle (it is cleared only after `landPty` has disposed and confirmed the late arrival, or recorded its own quarantine), looping over a spawn started meanwhile |
| `src/runner/pty-supervisor.ts:2101`, `:2154` | bound exceeded: a stand-in `PtyProcess` (pid 0, `confirmExit` true only once the spawn has settled) becomes the quarantine record, reason `pending-spawn-unsettled`, in the same step that drops the entry fence |
| `src/runner/pty-supervisor.ts:452` `PENDING_SPAWN_BOUND_MS` | **15 000 ms** (injectable timer `injectPendingSpawnWait`, reset by `__resetSupervisorForTests`) |

**Bound.** No existing constant fits (`DEFAULT_EXIT_CAP_MS` 7 s bounds a disposal, not a spawn). 15 s is
the 3 s ready-settle plus the 7 s disposal cap a late arrival may need, plus margin for boot work ahead of
the spawn. It is derived, not measured. Past it the session is quarantined and stays so; the next gate
passes only once the spawn has settled (then `landPty` has disposed what it produced).

**Does a rejecting `spawnPty` leave a process?** Read `src/runner/pty-process.ts:1558`. The only
rejections after the OS process exists are "exited before TUI settled" (`:1630`), where the process
already reported its own exit, and nothing else; a failed `ptySpawn` throws before any child exists. So
no rejection path leaves a live child for the retirement to kill. The one thing not proved is that the
self-exit is OS-probed (it is the pty's exit event). Recorded as a residual, not changed.

**Item 4 (presence test).** `liveSessionKeys()` already counts an entry with `spawnInFlight`
(`pty-supervisor.ts`, `!entry.retiring && !entry.spawnInFlight && !entry.pty?.isAlive()`), and
`retirePtySession` looks the entry up in `state.ptys`. No change; a test pins it.

### Fix 2 (MEDIUM): retire the fallback key only where it is used

| Site | What |
| --- | --- |
| `src/runner.ts:2070` | before the primary legacy spawn only `ptySessionKey` is retired (was `[key, fallback:key]`) |
| `src/runner.ts:2240`-`2250` | inside the fallback branch, immediately before the fallback runs, `retireLivePtysBeforePrint([fallbackPtyKey])`; a `PtyQuarantinedError` there fails the fallback attempt only: the fallback outcome is `exitCode 1` with the error as stderr, the primary already ran |
| `streamClaude` (`src/runner.ts:2923`) | has no fallback path; still retires `["global"]` |

### Tests

`src/__tests__/pty-pending-spawn-retire.test.ts` (5): deferred first spawn (retirement unresolved,
`assertSessionSpawnable` by key and by session id throws synchronously, ends after the late PTY is
disposed, the next resume proceeds); a replacement admission waits for the retirement and does not
spawn beside the child; deferred respawn; late PTY dispose unconfirmed leaves the session quarantined
after the retirement; a spawn that never settles (fake timer asked for exactly 15 000 ms) is
quarantined, refused again by the gate while pending, and released by the next gate after it settles.
`src/__tests__/pty-hot-switch-to-print.test.ts` (+4, now 9): pending spawn on `global` then
`pty.enabled` false, print spawns only after the late PTY is disposed (order asserted); quarantined
`fallback:global` does not fail a healthy primary turn; a turn that needs the fallback has only the
fallback attempt refused (primary ran, `retirePtySession("fallback:global")` called once, after the
primary spawn); a live fallback PTY is retired after the primary and before the fallback spawn.

Existing tests whose scenario assumed `/kill` returns while a spawn is still held were adapted, not
weakened (`src/__tests__/pty-supervisor.test.ts`): the kill is now started, the held spawn released, and
the kill awaited (5 tests); `invariant 2` (a failed old spawn must not revoke the replacement's
identity) now starts the replacement while the old spawn is pending and asserts it waits, which is the
stronger property; `afterEach` expires the pending-spawn bound at once so a test that abandons a spawn
which never settles does not hold shutdown for 15 s.

### Injections

One site at a time on `git archive` copies of the fix commit, prediction written first. Verbatim RED lines:

| Injection | Predicted | RED lines |
| --- | --- | --- |
| (a) `joinPendingSpawns(entry)` -> `Promise.resolve(null)` | every pending-spawn test and the hot-switch order test RED | `(fail) a retirement while the first spawn is pending > is held, refuses a resume on the session synchronously, and ends after the late PTY is confirmed dead [261.03ms]`<br>`(fail) a retirement while the first spawn is pending > is fenced from its first step, and a replacement admission waits instead of resuming beside the child [103.83ms]`<br>`(fail) a retirement while a respawn is pending > is held until the late respawn is disposed [544.19ms]`<br>`(fail) a late PTY whose exit cannot be confirmed > quarantines the session after the retirement [114.23ms]`<br>`(fail) a pending spawn that never settles > is quarantined once the bound passes, never released [108.81ms]`<br>`(fail) #562 final round: a pending spawn is the retirement's to settle (#592) > global: print spawns only after the late PTY is confirmed dead [175.02ms]`<br>`6 fail` |
| (b) drop the `fenceKey(...)` call (the old `if (entry.pty)` only) | the three synchronous-fence tests RED | `(fail) a retirement while the first spawn is pending > is held, refuses a resume on the session synchronously, and ends after the late PTY is confirmed dead [6280.16ms]`<br>`(fail) a retirement while the first spawn is pending > is fenced from its first step, and a replacement admission waits instead of resuming beside the child [6070.24ms]`<br>`(fail) a retirement while a respawn is pending > is held until the late respawn is disposed [6553.86ms]`<br>`3 fail` |
| (c) bound exceeded: lift instead of quarantine | the never-settles test RED | `(fail) a pending spawn that never settles > is quarantined once the bound passes, never released [101.60ms]`<br>`1 fail` |
| (d) fallback key back in the primary retirement | the three fallback tests RED | `(fail) #562 final round: the fallback key is retired only where the fallback runs > a quarantined fallback does not fail a healthy primary turn [1.70ms]`<br>`(fail) #562 final round: the fallback key is retired only where the fallback runs > a turn that needs the fallback: only the fallback attempt is refused [1.24ms]`<br>`(fail) #562 final round: the fallback key is retired only where the fallback runs > a live fallback PTY is retired immediately before the fallback spawn, after the primary [10.67ms]`<br>`3 fail` |
| (f) ephemeral caller awaits the retirement even after its deadline (`src/runner/pty-supervisor.ts` finally of `runOnPty`) | the two one-shot deadline tests RED (the five `one-shot configuration` failures are a cascade of their timeouts) | `(fail) one-shot isolation contract > PTY deadline retires a process whose spawn lands late [6051.27ms]`<br>`(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the spawn never lands [6010.02ms]`<br>`(fail) one-shot configuration > rejects bad routing during settings load [6.95ms]`<br>`(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.judge":"pty"}} [7.73ms]`<br>`(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"default":"pty"} [6.00ms]`<br>`(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.*":"pty"}} [6.93ms]`<br>`(fail) one-shot configuration > the PTY engine does not advertise isolation until the spike is green [7.71ms]`<br>`51 pass`<br>`7 fail` |
| (e) `landPty` stops quarantining an unconfirmed late PTY | the unconfirmed-dispose test RED | `(fail) a late PTY whose exit cannot be confirmed > quarantines the session after the retirement [95.00ms]`<br>`1 fail` |

### Gates

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/final-src.txt 2>&1`: first run (head `19427777`) exit 1, 5006 pass / 9 fail.
  Two were caused by this change (`src/oneshot/engine.test.ts`: `PTY deadline retires a process whose spawn lands
  late`, `untrusted PTY temporary cwd > is removed when the spawn never lands`) and five more
  (`one-shot configuration`) cascaded from them. Cause: `runOnPty`'s ephemeral `finally` awaited the
  retirement, which now waits for the pending spawn, so a one-shot with a 30 ms deadline was held up to
  the 15 s bound. Fixed by not holding an aborted or timed-out ephemeral caller on a pending spawn
  (`src/runner/pty-supervisor.ts`, the `finally` of `runOnPty`); the retirement carries on in the
  background with the session fenced. `engine.test.ts` now expires the bound and resets the supervisor in
  `afterEach`. Injection (f) above proves the rule. The other two failures
  (`buildHostTelemetryProvider extraProducers` timeout, `SkillsSubject judge failure cooldown` 5 s timeout)
  pass on rerun alone (106 pass, 0 fail across the five host-telemetry and skills files).
  The full `src` run was not repeated after the fix: it takes ~6 min and the touched surface is covered
  by the wide set below. Say so if you want it re-run.
- Wide PTY set (`src/__tests__/pty-*.test.ts`, `oneshot-pty-tools`, `live-session-actions`, `runner`,
  `execution-engines`, `src/oneshot`, `session-manager-quarantine`): normal 898 pass / 0 fail, and with
  `CLAUDECLAW_TEST_PLATFORM=linux` 898 pass / 0 fail, both after the ephemeral fix.
- Touched suites again after the last edit: 194 pass / 0 fail.
- `bun run lint` exit 0. `bun run typecheck` exit 0, 149 against baseline 149 (a first run showed 150: my
  stand-in `PtyClosedError` call lacked its third argument; fixed).
- `git diff --check` clean. Version 2.2.354 unchanged: `povai/main` is 2.2.353 and the branch is 0 behind it.


### Residuals (not implemented)

- **Shared session lease through the print process's lifetime** (Codex's "hold a shared session lease
  through the print process's lifetime to exclude replacement admissions"). The retirement now holds
  the session until pending spawns settle, but nothing holds a lease while a `claude -p` child runs, so
  a PTY admission on a key during a long print turn is not excluded by the supervisor. Not done.
- The self-exit in `spawnPty`'s "exited before TUI settled" path is trusted from the pty's exit event,
  not probed with `process.kill(pid, 0)`.
- The 15 s bound is derived from the settle and disposal caps, not measured on a loaded host.
- A retirement now waits on a pending spawn, so `/kill`, shutdown and a hot-switched print turn can
  each be held up to the bound; the runner's global queue slot is held meanwhile.
- A one-shot that times out while its spawn is pending is no longer held by the retirement; its
  temporary cwd is removed while the late child may still run until `landPty` disposes it (as before
  this round).
- The stand-in quarantine record has no pid (`0`); a status listing shows it as `pending-spawn-unsettled`.
