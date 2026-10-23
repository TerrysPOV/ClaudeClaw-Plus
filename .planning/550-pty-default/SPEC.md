# Problem

Issue #550 makes PTY the default for agent turns, cron jobs and every bus origin while preserving explicit print overrides. Current defaults and recovery paths still select print. #559 is a known merge blocker owned by another contributor.

# Current behaviour

- `src/config.ts:221`: DEFAULT_SETTINGS.pty.enabled is false, with an obsolete rollout comment; parser at :1227 enables PTY only for literal true.
- `src/bus/types.ts:54`: defaultSupervisionFor picks process-stream-json for cron/heartbeat/CLI/REST. `src/bus/session-manager.ts:812` uses it when no explicit agent supervision is set.
- `src/runner.ts:740`: bootstrap always routes to legacy. Primary-corruption :2262, stale-session :2317 and post-compaction :2588 retries directly call runClaudeStream.
- `src/commands/start.ts:606`: runtime selection happens during startup; current startup summary does not name all effective engines.
- `src/job-loop.ts`: due jobs use the shared run function under either runtime. Bus non-channel PTY delivery uses #361 confirmation.

# Target behaviour

Missing PTY settings default true; literal false is preserved; invalid enabled values warn and default true. Every bus origin defaults to pty-stdin; explicit agent process-stream-json continues to work. Bootstrap and recovery turns follow the engine setting. Startup states agent-turn/cron/bus engine choices. Tests demonstrate cron and job delivery confirmation and a due job reaching PTY with defaults. Document migration and operator soak.

# Frozen decisions

- Work is based on povai/main d81bd579, on feat/550-pty-default; read #550, #553 and #559.
- Preserve explicit legacy paths and their tests. Retire a failed/stale PTY before fresh recovery; after compaction retire the old process before resuming the changed transcript.
- A retirement holds the session until every spawn or respawn still pending on the entry has settled and the process it produced is confirmed dead (past a 15 s bound the session is quarantined, never released; #592). The fallback key is retired only immediately before the fallback runs.
- Preserve the #361 confirmation mechanism; exercise it for actual cron and job dispatch surfaces without inventing a new BusOrigin value if jobs use an existing origin.
- Utilities (classifier, tuner, recall, compact, memory saves, rotation summaries) are owned by #548/#549 and stay outside this change. Inventory their remaining print calls in REPORT.md.
- Do not fix #559, alter README.md (PR #558 owns it), or perform the operator's 48-hour soak. Record dependencies and exact soak checklist.
- Ordered work: defaults and config tests; bus origins/delivery tests; runner routing and job test; startup/migration guide; fault injection and scoped validation; version bumps/report/commit/push.

# Key files

src/config.ts; src/bus/types.ts; src/bus/session-manager.ts; src/bus/session-agent-process.ts; src/bus/agent-resolver.ts; src/runner.ts; src/job-loop.ts; src/commands/start.ts; corresponding tests; docs/pty-migration.md.

# Out of scope

#559 fresh-input bug; #548/#549 utility migrations; README rewrite; HTTP engines; production rollout and live 48-hour soak; PR creation/merge.

# Review-fix pass (task_016cc3fe4f34)

- Preserve final PtyTurnTimeoutError as exit 124; retire the timed-out PTY before memory save/compact. Drive the compact fixture using the real supervisor result, not invented PTY exit codes.
- Detect an API signature error rendered by a successful PTY result, or identify any print-only recovery condition.
- Background bootstrap through the serial runner queue, bounded to one attempt and a finite startup-specific timeout. Startup continuation and engine logging get behavioural tests.
- Align retry model fallback and stream callbacks; deduplicate invalid enabled warnings by distinct bad value; correct hot-reload and resolver-origin migration wording.
- Replace source assertions with behaviour and verify actual SessionManager cron default selection.
- Add commits without force-pushing. Both manifest versions are 2.2.341 (main is 2.2.340). README/#559 and live soak remain out of scope.

# PR 562 fallback stream follow-up (task_d6cfe1f8b211)

- Problem/current behavior: runner.ts:2200 streams PTY fallback chunks, but streamClaude at runner.ts:2770 re-emits the complete fallback stdout whenever usedFallback is true.
- Target behavior: dashboard chat delivers streamed fallback text once; a silent fallback still emits its stdout once even after the primary streamed a rate-limit notice.
- Frozen decisions: track text emitted by the fallback separately from primary text, preserve buffered/non-streaming and legacy print behavior, and keep version 2.2.341 per the explicit dispatch instruction.
- Key files: src/runner.ts and the isolated pty-default-runner fixture/tests; REPORT.md records RED probes and validation.
- Out of scope: README, issue 559, version bump, GitHub comments/thread resolution, deployment and operator soak.
