# Problem

Issue #548 centralises utility Claude calls and their isolation policy with print and ephemeral PTY engines.

# Current behaviour

- `src/commands/discord.ts:589` defines classifier flags; `:670` executes in an empty directory.
- `src/skills-tuner/core/llm.ts:37` builds CLI flags; `:85` executes the isolated tuner.
- `tools/memory-search/memory_search/recall.py:31` provides #545 Python isolation.
- `src/runner.ts:828` implements runClaudeOnce; the supervisor supports ephemeral sessions.

# Target behaviour

Expose the frozen OneShotRequest, OneShotResult, OneShotEngine and runOneShot API; centralise UNTRUSTED_CLAUDE_ARGS; implement print and ephemeral PTY engines, config capability validation and call logging. Migrate classifier and tuner. Add registry-wide contracts, argv, configuration and optional adversarial e2e tests.

# Frozen decisions

- Isolation is required. Untrusted rejects resume and allowedTools.
- Coordinator ruling `msg_59da082b6bfa` (2026-10-18): add optional `cwd?: string`, honoured only for trusted-session calls by both engines. Untrusted cwd is rejected. This approved addition supports #549 named-agent session lookup. No api or baseEnv fields are added.
- All routes default to print. Untrusted PTY stays disabled until an independently green isolation spike; no spike success is claimed here.
- Engine IDs are print and pty; capabilities resume/tools/isolation are booleans.
- Request strings: route, prompt, optional system/model/resumeSessionId. allowedTools is string[], maxTokens/timeoutMs are numbers, signal is AbortSignal. Result text/engine/model are strings, exitCode is number; optional sessionId and numeric usage counts.
- Preserve existing caller compatibility helpers and injected spawn seams.
- Keep Python recall independently executable and test flag parity with TypeScript.

# Key files

`src/oneshot/`, `src/runner/pty-supervisor.ts`, `src/runner/pty-process.ts`, `src/config.ts`, `src/commands/discord.ts`, `src/skills-tuner/core/{llm,config}.ts`.

# Out of scope

Issue #549 live session consumers (compact, saves, rotation, stop), HTTP engines #551, UI/CLI #552, defaults #550. The previously reviewed Ultra clone supplies no reusable one-shot implementation.


## Review-fix pass on 0d636b6a (Opus deep review + security review)

### Current behaviour (as reviewed)
- `src/skills-tuner/core/llm.ts:41,80` passed `timeoutMs: 60000`; main had no tuner timeout, so slow proposer/judge calls exited 124.
- `src/oneshot/print.ts:26` put an untrusted prompt after `-p` unless the caller set `stdinPrompt`.
- `src/oneshot/config.ts:39,453` gated untrusted PTY by `id === "pty"`.
- `src/runner/pty-supervisor.ts` (`runOnceOnPty`) created the untrusted temp cwd before its `try` and removed it only once `work` settled.
- `src/commands/discord.ts` exported a `CLASSIFIER_ARGS` constant that the classifier no longer used.

### Target behaviour
- Tuner timeout is `llm.timeout_ms` in the tuner config, default 600000 (10 min). A non-zero exit throws `claude CLI exited <code>: <first 200 chars of masked stderr>`.
- Untrusted prompts are always delivered on stdin; argv never carries them.
- Untrusted routing is gated by `caps.isolation`; the PTY engine advertises `isolation: false` until the spike is green.
- `validateIsolation` rejects any isolation other than `untrusted` on routes carrying untrusted text (`discord.classifier`, `tuner.*`, `memory.recall`).
- Untrusted PTY temp cwd is created inside the `try` and removed in the `finally`.

### Frozen decisions (this pass)
- The stderr excerpt travels through the `printRuntime` seam (`onStderr`), not a new `OneShotResult` field, so the frozen request/result interfaces stay as published.
- `PTY_ISOLATION_SPIKE_GREEN` is removed; `caps.isolation` in `registry.ts` is the single switch. The runtime check in `runOnceOnPty` stays and now rejects through the same capability test.
- `isUntrustedRoute` in `config.ts` is the one definition of an untrusted-text route, shared by settings validation and `validateIsolation`.
- `CLASSIFIER_ARGS` is deleted; `buildPrintArgs` is the one source of the classifier argv.

### Out of scope (noted, no code)
L1 untrusted PTY path gaps (trust dialog in the mkdtemp cwd, `--session-id` not added, bun-pty env merge) belong to the spike. L4 unknown `oneShot` keys are dropped. L5 a bad `oneShot` block now fails `parseSettings`, which also affects `llm-router` `reloadSettings` (`src/plugins/llm-router/server.ts:225`).


## Second follow-up: trusted-route PTY engine (production grade)

### Problem
The `pty` engine becomes the default for trusted routes (compact, memory.save.*, rotation.summary) in #550, so findings that were latent on `runOnceOnPty` go live.

### Current behaviour (as reviewed, 7898a063)
- `src/runner/pty-supervisor.ts:1417` builds `PtyProcessOptions` by hand: no `settings.pty` cols/rows/timeouts, no synthesized multiplexer `mcpConfigPath`.
- The PTY is spawned outside `state.ptys` (`:1450`), so `shutdownSupervisor` / `killAllPtys` cannot reach it.
- No `PTY_OUTPUT_FORMAT_CONSTRAINT` in the system prompt (`runner.ts:1372`, used by #546 forks).
- Timeout and TUI failure throw (`:1440`); `print` returns exitCode 124 / non-zero.
- `--model kimi-k2p6` forwarded (`pty-process.ts:327,359`; Codex P2 on #560); `print.ts` forwarded it for untrusted calls only.
- `ensureOneShotTrust` is called unwrapped (`:1448`), unlike `spawnEntry` (`:1616`).
- `allowedTools` on PTY waits at a permission prompt for a tool outside the list.
- `oneShot.routes` keys that are not routes are accepted (`config.ts` parse loop).

### Target behaviour
- `runOnceOnPty` delegates to `runOnPty` with the #546 ephemeral scope, so spawn options come from `buildSpawnOptions`, trust healing from `spawnEntry`, and the entry lives in `state.ptys` until it returns.
- exit contract: timeout and abort mid-flight return `exitCode: 124`; a failed turn / spawn returns a non-zero code. Already-aborted requests still throw `AbortError` (engine pre-check).
- trusted + `allowedTools`: `--permission-mode dontAsk --tools X --allowedTools X` (deny, never prompt).
- one model-alias rule (`src/oneshot/model.ts`) for print and PTY argv.
- unknown route names in `oneShot.routes` fail at load (`KNOWN_ROUTES` in `config.ts`).

### Frozen decisions
- `OneShotRequest` / `OneShotResult` / `OneShotEngine` unchanged (stacked #549).
- Two optional `PtyRunScope` fields: `resumeSessionId` (ephemeral only; used verbatim, no resumability probe, so a missing conversation fails instead of silently starting a different one) and `isolation` (forwarded to `PtyProcessOptions`; `untrusted` skips trust healing for the throwaway cwd, as before).
- One-shot entries are registered in `state.ptys` under `oneshot:<route>:<uuid>` and follow #546: `scope.ephemeral`, outside the `maxConcurrent` cap / LRU / reaper, `retireEntry` on return. They are NOT `survivesKill`: `/kill` and shutdown dispose them. Admission (serialised, refused during shutdown) applies; the cap does not count them, matching the #546 forks and jobs. Counting them would make a compaction burst evict keyed sessions.
- Default model for a one-shot with no `req.model` is `settings.model` (as keyed sessions); `print` leaves the CLI default. Known divergence, kept out of this PR.
- `PTY_OUTPUT_FORMAT_CONSTRAINT` moves to `src/runner/pty-output-format.ts` (leaf module, no circular import); `runner.ts` imports it.
- Default engines are NOT changed here (#550).

### Key files
`src/runner/pty-supervisor.ts`, `src/runner/pty-process.ts`, `src/runner/pty-output-format.ts`, `src/runner.ts`, `src/oneshot/{model,config,engine.test,pty-trusted.test}.ts`, `src/commands/discord.ts`, `src/skills-tuner/core/llm.ts`.

### Out of scope
Untrusted PTY (spike), engine default flip (#550), keyed-session `--model` for legacy `-p` paths in `runner.ts`, HTTP engines.
