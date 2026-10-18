# Issue #548 implementation report

Implemented on `feat/548-oneshot-module`, based on `povai/main`. Frozen interface checkpoint `dede882b` was committed and pushed first, including SPEC.md, engine types, runOneShot signature and canonical isolation flags.

## Changes

- Shared engine dispatcher and registry, print engine and ephemeral PTY helper. Requests require explicit isolation and a positive timeout. Calls log route, engine, model, isolation, milliseconds, exit code and available token counts.
- One canonical TypeScript CLI isolation sequence. Classifier and tuner builders reuse it. Python recall remains the independently deployable #545 implementation; an exact flag-parity test prevents drift.
- Print uses clean child environment handling, isolated temporary cwd for untrusted requests, bounded output, cancellation/deadline handling, child-exit tracking and finally cleanup.
- PTY utility calls own a fresh process/session or explicitly resume, run a turn using existing detection, dispose once and never enter the supervisor's keyed session map/LRU. Late spawns after deadlines are retired.
- oneShot.default / engines / routes settings are parsed at load. Built-ins need no declaration. Exact route, namespace wildcard and default resolution are supported. Unknown engines, incompatible resume routes, malformed declarations and untrusted PTY mappings are rejected.
- Untrusted PTY remains blocked in configuration and execution. PTY argv is prepared to strip MCP, resume, persona and permission flags and use the canonical sequence, but no successful interactive isolation spike is claimed.
- Discord classifier now calls runOneShot with the existing model, 15-second timeout, env allowlist, stdin prompt delivery and JSON parsing. Its tests were changed in the review passes (see "Existing tests changed" below): `discord-classifier-isolation.test.ts` now reads `buildPrintArgs` output, and a later pass drives `classifyThreadIntent` itself.
- Tuner now calls runOneShot using tuner.propose/tuner.judge; claude_cli always selects print. New oneshot backend follows route settings. Model mapping, trimmed text and cleanSpawnEnv behavior are preserved; the existing tuner tests were adjusted (see "Existing tests changed" below). The CLI cannot enforce maxTokens; this is documented.
- No #549 consumer call sites were modified. Documentation explains configuration and opt-in e2e usage.
- Both plugin manifests bumped to 2.2.337 with the required scripts.

## Coordinator-approved interface addition

Message `msg_59da082b6bfa` explicitly instructed adding `cwd?: string` for #549. Both engines honour it for trusted-session requests. Untrusted requests reject cwd, resumeSessionId and allowedTools. There are no api or baseEnv fields; print derives API routing, child environment and security arguments from settings. Separate tests and fault injections cover trusted print cwd, trusted PTY cwd and untrusted cwd rejection.

## Validation

| Command | Result |
| --- | --- |
| `bun test src/oneshot src/__tests__/discord-classifier-isolation.test.ts src/skills-tuner/core/__tests__/llm.test.ts` | 47 pass, 1 opt-in skip, 0 fail |
| `bun test src/__tests__/pty-process.test.ts` | 55 pass |
| `bun test src/__tests__/pty-supervisor.test.ts` | 76 pass |
| `bun test src/__tests__/pty-supervisor-mcp.test.ts` | 7 pass |
| `bun test src/__tests__/pty-config.test.ts src/__tests__/runtime-config.test.ts src/__tests__/skills-tuner-config.test.ts` | 112 pass |
| `bun test src/skills-tuner/core/__tests__` | 61 pass |
| `bun run lint` (whole repository; JSON reporter used for final diagnostic summary) | exit 0, 0 errors; existing advisory warnings remain |
| `bun run typecheck` | exit 0; 149 diagnostics against baseline 149 |
| `bunx tsc --noEmit` | raw diagnostic count 154 before and after; no regression |
| `git diff --check` | clean |
| `bun run bump:plugin-version`, `bun run bump:marketplace-version` | both 2.2.337 |

Dependencies were initially absent; `bun install --frozen-lockfile` installed the locked dependencies without tracked lockfile changes. Tests were scoped; the full suite was not run because of the reported cross-test pollution.

## TDD and fault injection

The initial test run failed before implementation:

```text
error: Cannot find module './registry.js' from '/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/engine.test.ts'
```

The deadline test then caught a real double disposal (Expected: 1, Received: 2), fixed with a shared disposal promise. The cwd tests were written first and all three failed against the old implementation before the approved addition was made.

Each fault below was applied separately, observed RED, and reverted through a finally block before moving to the next fault. These are verbatim runner lines, including measured durations.

### isolation privileges

```text
(fail) one-shot isolation contract > print: rejects untrusted resume and tools before executing [12.35ms]
(fail) one-shot isolation contract > pty: rejects untrusted resume and tools before executing [0.77ms]
```

### print argv

```text
(fail) one-shot isolation contract > print: argv contains canonical isolation sequence without privileged flags [6.68ms]
```

### pty argv

```text
(fail) one-shot isolation contract > pty: argv contains canonical isolation sequence without privileged flags [8.04ms]
```

### print cleanup

```text
(fail) one-shot isolation contract > print removes its empty temporary cwd after exit 0 [4.49ms]
(fail) one-shot isolation contract > print removes its empty temporary cwd after exit 1 [0.76ms]
```

### resume capability

```text
(fail) one-shot configuration > rejects resume routes on engines without resume capability [3.09ms]
```

### PTY spike gate

```text
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.judge":"pty"}} [2.02ms]
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"default":"pty"} [0.45ms]
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.*":"pty"}} [0.71ms]
```

### PTY disposal

```text
(fail) one-shot isolation contract > PTY uses a fresh process and disposes it without LRU admission [3.69ms]
```

### untrusted allowedTools guard

```text
(fail) one-shot isolation contract > print: rejects untrusted resume and tools before executing [12.84ms]
(fail) one-shot isolation contract > pty: rejects untrusted resume and tools before executing [0.80ms]
```

### untrusted resume guard

```text
(fail) one-shot isolation contract > print: rejects untrusted resume and tools before executing [3.64ms]
(fail) one-shot isolation contract > pty: rejects untrusted resume and tools before executing [0.64ms]
```

### explicit isolation

```text
(fail) one-shot isolation contract > print: isolation must be explicit and deadline positive [1316.64ms]
(fail) one-shot isolation contract > pty: isolation must be explicit and deadline positive [1005.87ms]
```

### deadline validation

```text
(fail) one-shot isolation contract > print: isolation must be explicit and deadline positive [9.14ms]
(fail) one-shot isolation contract > pty: isolation must be explicit and deadline positive [0.87ms]
```

### PTY late disposal

```text
(fail) one-shot isolation contract > PTY deadline retires a process whose spawn lands late [48.03ms]
```

### stdin delivery

```text
(fail) one-shot isolation contract > preserves classifier stdin delivery and environment [6.02ms]
```

### call logging

```text
(fail) one-shot configuration > routes trusted requests to the selected engine and logs once [4.03ms]
```

### unknown engine validation

```text
(fail) one-shot configuration > rejects unknown engines [3.22ms]
```

### untrusted cwd guard

```text
(fail) one-shot isolation contract > rejects cwd on untrusted calls [16.65ms]
```

### trusted print cwd

```text
(fail) one-shot isolation contract > trusted print honours the requested cwd [5.05ms]
```

### trusted PTY cwd

```text
(fail) one-shot isolation contract > trusted PTY honours the requested cwd [3.55ms]
```

### claude_cli alias

```text
(fail) one-shot configuration > tuner oneshot follows routing while claude_cli remains a print alias [4.45ms]
```

## Security review and remaining checks

Applied the security-review skill to the changed boundaries. No critical or high issue remains in this diff: untrusted privilege combinations reject before spawning, isolation arguments are centralized, cwd is isolated and removed, shell execution is not used, classifier environment and stdin behavior are preserved, and logs omit prompts, stderr and credentials.

The live adversarial test is implemented behind ONESHOT_E2E=1 and was not run as an opt-in live model check. It inspects actual stream-json tool_use events and canary files. The interactive PTY trust/isolation spike is also not run; the hard gate remains false. No live daemon or production process inspection was required or performed for this module; #549 owns its manual single-transcript-writer check.

No prior-art code was reused: the previously reviewed read-only Ultra clone has no one-shot module or equivalent helper. No PR, merge or GitHub comment was created. Initial local memory/Serena scaffolding remains outside the task commits.


---

# Review-fix pass (worker: Claude, after Codex Sol's 0d636b6a)

Branch `feat/548-oneshot-module`, review worktree branch `review/548-fixes`. Work commit `074a4773, 3219bd62`; history was not rewritten. Design and naming from Sol's implementation are kept.

## What changed

| # | Severity | Change |
|---|---|---|
| 1 | HIGH | Tuner timeout restored to main's generosity: `llm.timeout_ms` in the tuner config (default 600000 ms, `DEFAULT_LLM_TIMEOUT_MS`; falls back to the default when `llm` is `{}`). The `claude CLI exited N` error now carries a masked excerpt of the first 200 characters of stderr (`src/oneshot/redact.ts`), as main did. |
| 2 | MEDIUM | `buildPrintArgs` and `runPrint` deliver every untrusted prompt on stdin (`--print --output-format text`); argv never carries it. |
| 3 | MEDIUM | `pty` registers `caps.isolation: false`; `validateRouteEngine` rejects untrusted routes to any engine without `caps.isolation`; the `id === "pty"` special case and `PTY_ISOLATION_SPIKE_GREEN` are gone. Runtime check in `runOnceOnPty` kept. |
| 4 | MEDIUM | Abort test asserts `name === "AbortError"` and that nothing spawned; both engines get a spawn that would succeed. |
| 5 | MEDIUM | `CLASSIFIER_ARGS` deleted; `discord-classifier-isolation.test.ts` builds the argv with `buildPrintArgs` for route `discord.classifier`, untrusted. Comments in `discord.ts`, `llm.ts` and `recall.py` point at `UNTRUSTED_CLAUDE_ARGS`. `cliArgs` in `llm.ts` (unused outside the module) is removed. |
| 6 | LOW | `validateIsolation` rejects non-`untrusted` isolation on `isUntrustedRoute(route)` routes (`discord.classifier`, `tuner.*`, `memory.recall`). |
| 7 | LOW | `runOnceOnPty` creates the untrusted temp cwd inside the `try` and removes it in the `finally`, after disposal, whether or not `work` ever settles. |
| 8 | LOW | Untrusted-cwd rejection moved into the registry-wide loop; the argv test iterates `engines` against an `argvBuilders` map and fails for any engine without a builder. |

## Behaviour change to record (item 1)

- **Tuner timeout.** Main: none. 0d636b6a: hard 60 s, exit 124 on slow calls. Now: 10 minutes by default, configurable per config via `llm.timeout_ms`. Applies to the `claude_cli` and `oneshot` tuner backends.
- **Error text.** Non-zero exit is `claude CLI exited <code>: <excerpt>`. The excerpt is the first 200 characters after masking (`sk-` keys, `Bearer` tokens, JWTs, `*token|key|secret|password*` assignments, and any 40+ character opaque run), so a secret cut by the limit is still masked. Masking is applied to the captured text before the cut. The heuristic can over-mask a long path-like string; that is accepted.
- **Untrusted prompts leave argv.** The classifier already delivered on stdin; the tuner previously passed `-p <prompt>` and now uses stdin too, so its prompt no longer shows in `ps` and its argv tests changed (below).
- **Seam, not interface.** The excerpt is reported through `printRuntime().onStderr`, so the frozen `OneShotResult` is unchanged. The `oneshot` tuner backend routed to a non-print engine has no excerpt (the error ends `: `).

## Existing tests changed (the earlier "original tests unchanged" claim no longer holds)

- `llm.test.ts`: fake spawn child gained `stdin`; `KNOWN_FLAGS` now lists `--print` and `--output-format` instead of `-p`; "keeps the prompt right after -p" replaced by "delivers the prompt on stdin, never in argv".
- `discord-classifier-isolation.test.ts`: reads `buildPrintArgs` output instead of the deleted constant, plus an assertion that the message is not in argv.
- `engine.test.ts`: trusted-session cases use route `compact` (a `tuner.judge` route now correctly rejects trusted isolation); child mocks for untrusted print gained `stdin`.

## Tests run

| Command | Result |
|---|---|
| `bun test src/oneshot src/__tests__/discord-classifier-isolation.test.ts src/skills-tuner/core/__tests__/llm.test.ts` | 64 pass, 1 skip (opt-in e2e), 0 fail |
| `bun test src/__tests__/pty-process.test.ts` | 55 pass |
| `bun test src/__tests__/pty-supervisor.test.ts` | 76 pass with `ANTHROPIC_BASE_URL` unset; 75 pass, 1 fail with it set (see below) |
| `bun test src/__tests__/pty-supervisor-mcp.test.ts` | 7 pass |
| `bun test src/__tests__/pty-config.test.ts src/__tests__/runtime-config.test.ts src/__tests__/skills-tuner-config.test.ts` | 112 pass |
| `bun test src/skills-tuner/core/__tests__` | 67 pass |
| `bun run lint` (whole repo) | exit 0, 0 errors, 1252 warnings and 323 infos (existing advisory) |
| `bun run typecheck` | exit 0; 149 against baseline 149 |
| `bunx tsc --noEmit` | 154 diagnostics, same as before this pass |

Flake note: `pty-process.test.ts` "a dialog that paints late gets a fresh hard-timeout window" (a real-timer test, unrelated to argv) failed in 2 of 3 runs immediately after heavy runs (typecheck, a 12-file combined run, which also tripped `pty-supervisor.test.ts` invariant 2 from cross-test pollution), then passed 4 of 4 runs alternating with a detached worktree at 7898a063, which itself passed 4 of 4. Treat it as load-sensitive timing; the combined single-process run is the known-polluted default and is not used as evidence.

The one `pty-supervisor.test.ts` failure ("non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset") reads `ANTHROPIC_BASE_URL` from the ambient shell, which this Orca session sets (`http://127.0.0.1:8787`). It passes with `env -u ANTHROPIC_BASE_URL`. Not caused by this pass; the test does not scrub its environment.

Full suite not run (known cross-test pollution). First lint run found 5 errors in my own files (4 unformatted, one `noAssignInExpressions`); fixed and re-run clean.

## Fault injection (single site each, reverted after)

Each fault was applied alone to the committed tree, `bun test` run over `src/oneshot`, the classifier test and `llm.test.ts`, then reverted with `git checkout -- <file>`; the tree was clean after the last one. Verbatim runner lines:

```text
### 1 tuner timeout back to 60 s (llm.ts)
exit=1
(fail) ClaudeCliBackend — call timeout (#548 review: main had none) > defaults to ten minutes, not the 60 s that made slow calls exit 124 [2.94ms]
(fail) ClaudeCliBackend — call timeout (#548 review: main had none) > honours llm.timeout_ms from the tuner config [0.54ms]

### 1b tuner ignores llm.timeout_ms (llm.ts)
exit=1
(fail) ClaudeCliBackend — call timeout (#548 review: main had none) > honours llm.timeout_ms from the tuner config [0.59ms]

### 1c stderr excerpt not truncated (redact.ts)
exit=1
(fail) ClaudeCliBackend — stderr excerpt on non-zero exit > includes the first 200 characters of stderr [0.64ms]

### 1d stderr not masked (redact.ts)
exit=1
(fail) ClaudeCliBackend — stderr excerpt on non-zero exit > masks credentials before they reach the error [0.34ms]
(fail) ClaudeCliBackend — stderr excerpt on non-zero exit > masks a credential that straddles the 200-character cut [0.25ms]

### 1e stderr cut before masking (redact.ts)
exit=1
(fail) ClaudeCliBackend — stderr excerpt on non-zero exit > masks a credential that straddles the 200-character cut [0.34ms]

### 2 argv carries untrusted prompt (print.ts buildPrintArgs)
exit=1
(fail) one-shot isolation contract > untrusted prompts go to stdin, never argv, even when a flag-shaped prompt asks for one [0.55ms]
(fail) classifyThreadIntent isolation > disables every built-in tool and every MCP server [0.16ms]
(fail) classifyThreadIntent isolation > keeps the message out of argv (it is delivered on stdin) [0.05ms]

### 2b untrusted stdin not piped (print.ts runPrint)
exit=1
(fail) one-shot isolation contract > untrusted prompts go to stdin, never argv, even when a flag-shaped prompt asks for one [2.24ms]
(fail) ClaudeCliBackend — CLI arguments > delivers the prompt on stdin, never in argv [0.92ms]

### 3 pty advertises isolation (registry.ts)
exit=1
(fail) one-shot configuration > rejects bad routing during settings load [1.38ms]
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.judge":"pty"}} [0.52ms]
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"default":"pty"} [0.34ms]
(fail) one-shot configuration > rejects untrusted PTY before the isolation spike: {"routes":{"tuner.*":"pty"}} [0.33ms]
(fail) one-shot configuration > the PTY engine does not advertise isolation until the spike is green [0.37ms]

### 3b gate keyed on engine id again (config.ts)
exit=1
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the turn never settles [1.40ms]
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the spawn never lands [0.57ms]
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed after a normal turn [0.59ms]
(fail) one-shot configuration > rejects untrusted routes on any engine without the isolation capability [0.46ms]

### 4 print drops the pre-spawn abort check (print.ts)
exit=1
(fail) one-shot isolation contract > print: rejects an already aborted request with AbortError before spawning [2.23ms]

### 4b pty drops the pre-spawn abort check (pty-supervisor.ts)
exit=1
(fail) one-shot isolation contract > pty: rejects an already aborted request with AbortError before spawning [0.51ms]

### 5 isolation flag dropped from the single argv source (isolation.ts)
exit=1
(fail) one-shot isolation contract > keeps the Python recall isolation flags in parity [1.17ms]
(fail) classifyThreadIntent isolation > disables every built-in tool and every MCP server [0.13ms]
(fail) ClaudeCliBackend — CLI arguments > disables built-in tools and MCP servers [0.28ms]
(fail) ClaudeCliBackend — isolation of the untrusted call > loads no settings, hooks, session or slash commands [0.28ms]

### 6 route-level isolation check removed (isolation.ts)
exit=1
(fail) one-shot isolation contract > print: rejects trusted-session calls on routes carrying untrusted text [0.76ms]
(fail) one-shot isolation contract > pty: rejects trusted-session calls on routes carrying untrusted text [0.48ms]
(fail) one-shot isolation contract > dispatcher rejects trusted-session on untrusted-text routes before routing [1916.73ms]

### 7 pty temp dir not removed (pty-supervisor.ts)
exit=1
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the turn never settles [33.89ms]
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the spawn never lands [33.24ms]
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed after a normal turn [0.84ms]

### 7b pty temp dir removed only when no process spawned (pty-supervisor.ts)
exit=1
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed when the turn never settles [31.63ms]
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed after a normal turn [1.12ms]

### 8 untrusted cwd accepted (isolation.ts)
exit=1
(fail) one-shot isolation contract > print: rejects cwd on untrusted calls [0.68ms]
(fail) one-shot isolation contract > pty: rejects cwd on untrusted calls [0.33ms]

### 8b engine without argv coverage joins the registry (registry.ts)
exit=1
(fail) one-shot isolation contract > extra: isolation must be explicit and deadline positive [0.47ms]
(fail) one-shot isolation contract > extra: rejects an already aborted request with AbortError before spawning [1.23ms]
(fail) one-shot isolation contract > extra: rejects cwd on untrusted calls [0.33ms]
(fail) one-shot isolation contract > extra: rejects trusted-session calls on routes carrying untrusted text [0.34ms]
(fail) one-shot isolation contract > extra: rejects untrusted resume and tools before executing [0.41ms]
(fail) one-shot isolation contract > extra: argv contains canonical isolation sequence without privileged flags [0.38ms]
```

Note on 3b: with the gate keyed on `id === "pty"` again, the temp-dir tests also go red because they open the PTY capability to reach `runOnceOnPty`. The predicted line is the `noiso` test; the other three are a side effect. Note on 7b: it leaves the "spawn never lands" case green on purpose, which shows the hung-turn case is covered by a different assertion from the never-spawned case. Note on 8b: `expect(build).toBeDefined()` is what fails for an engine with no argv builder; the other `extra:` lines fail because an unconfigured engine honestly cannot satisfy the contracts.

## Noted, no code (as instructed)

- **L1** Untrusted PTY path gaps: trust dialog in the `mkdtemp` cwd, `--session-id` not added, bun-pty env merge. All belong to the interactive isolation spike; the PTY engine stays at `isolation: false`.
- **L4** Unknown `oneShot` keys are dropped by `parseOneShotSettings`.
- **L5** A bad `oneShot` block now fails `parseSettings`, which also affects `llm-router` `reloadSettings` (`src/plugins/llm-router/server.ts:225`).
- Observation, not changed: trusted calls still pass the prompt as the positional after `-p`, so a trusted caller that forwards user text could hit the same flag-shaped-prompt problem. All untrusted-text routes are now stdin-only and trusted routes may not carry untrusted text, so no current caller is exposed.

## Version

`git fetch povai` shows `povai/main` at 2.2.336 for both manifests; this branch is at 2.2.337, so no further bump was needed and none was made.

## Not performed

- The opt-in live adversarial e2e (`ONESHOT_E2E=1`) was not run; it spends subscription quota. Its PTY skip now keys on `caps.isolation`.
- The interactive PTY isolation spike.
- Prior art: ultraassist/ClaudeClaw-Ultra was not re-checked; nothing reused.
- No PR, merge or GitHub comment.


---

# Second follow-up: trusted-route PTY engine (production grade)

Branch `review/548-fixes` on `povai/feat/548-oneshot-module` (7898a063). Spec: `SPEC.md` § "Second follow-up". `OneShotRequest` is unchanged (stacked #549); no default engine is changed (#550).

## What changed

| # | Finding | Change |
|---|---|---|
| 5 | kimi-k2p6 alias (Codex P2 on #560, fixed first, commit 3e4674bd) | `src/oneshot/model.ts` `cliModelFlag()` is the one rule (`glm`, `kimi-k2p6`, any case, never forwarded). `print.ts` and both `pty-process.ts` argv branches use it. `print` used to forward kimi for untrusted calls only. |
| 1 | hand-built `PtyProcessOptions` | `runOnceOnPty` now calls `runOnPty` with the #546 ephemeral scope, so options come from `buildSpawnOptions`: `settings.pty` cols/rows/turnIdleTimeoutMs/quietWindowMs/sentinelMaxWaitMs and the synthesized multiplexer `mcpConfigPath` (released on retire). Untrusted calls keep `mcpConfig: { path: undefined }`. |
| 2 | child spawned outside `state.ptys` | Entry `oneshot:<route>:<uuid>` lives in `state.ptys` while it runs: `shutdownSupervisor` and `killAllPtys` dispose it, admission refuses it during shutdown. Still `scope.ephemeral`: never reused, outside the LRU and the `maxConcurrent` cap, `retireEntry` on return. |
| 3 | no output-format constraint | `PTY_OUTPUT_FORMAT_CONSTRAINT` moved to the leaf module `src/runner/pty-output-format.ts` (no circular import; `runner.ts` imports it) and is appended to the trusted system prompt. |
| 4 | exit contract | Timeout and abort resolve `exitCode: 124`; a failed spawn or turn resolves non-zero (logged). Already-aborted requests still throw `AbortError` from the engine pre-check. The registry-wide contract test runs the same two scenarios on every engine. |
| 6 | trust self-heal | Falls out of delegation: `spawnEntry`'s try/catch + `heal.ok === false` warning. `injectOneShotTrustForTests` now seams `spawnEntry`. Untrusted skips healing (throwaway cwd), as before. |
| 7 | allowedTools on PTY | `--permission-mode dontAsk --tools X --allowedTools X` (`claude --help`: `dontAsk` is a valid mode; it denies instead of prompting). No `--dangerously-skip-permissions`. |
| 8 | unknown route names | `KNOWN_ROUTES` in `config.ts`; `parseOneShotSettings` rejects any `oneShot.routes` key that is not a known route or a `<family>.*` wildcard that `resolveOneShotEngine` can reach. |
| 9 | drift | llm.ts maxTokens comment; `classifyThreadIntent` JSDoc moved off `CLASSIFIER_ENV_KEYS`; OR-6 comment now covers the untrusted branch; REPORT.md lines 13-14 no longer claim unchanged tests. |
| 10 | classifier test | `classifyThreadIntent(text, { spawn })` is exported with a spawn seam; the new test drives it and asserts untrusted argv, stdin delivery, the `classifierSpawnEnv` allowlist (a `DISCORD_TOKEN` in `process.env` is absent in the child) and a throwaway cwd. |

Supporting supervisor changes: `PtyRunScope` gained `resumeSessionId` (ephemeral resume, used as given, no resumability probe) and `isolation`; the #546 wrapper `runOneShotOnPty` moved from `runner.ts` to `runEphemeralWithDeadline` in the supervisor and is shared.

## Tests run

| Command | Result |
|---|---|
| `bun test src/oneshot src/__tests__/discord-classifier-isolation.test.ts src/skills-tuner/core/__tests__` | 134 pass, 1 opt-in skip, 0 fail |
| `bun test src/__tests__/pty-process.test.ts` | 55 pass |
| `bun test src/__tests__/pty-supervisor.test.ts` | 76 pass with `env -u ANTHROPIC_BASE_URL`; 75 pass + 1 fail without (see below) |
| `bun test src/__tests__/pty-supervisor-mcp.test.ts src/__tests__/pty-mcp-config-writer.test.ts` | 25 pass |
| `bun test src/__tests__/pty-config.test.ts src/__tests__/runtime-config.test.ts src/__tests__/skills-tuner-config.test.ts` | 112 pass |
| `bun test src/__tests__/runner.test.ts src/__tests__/pty-enabled-routing.test.ts` (#546 fork/job callers of the moved wrapper) | 50 pass |
| `bun run lint` (whole repo) | exit 0; 0 errors (biome format applied to three touched files); existing advisory warnings remain |
| `bun run typecheck` | 149 errors, baseline 149 (unchanged) |

The one `pty-supervisor.test.ts` failure ("non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset") is environmental: this shell exports `ANTHROPIC_BASE_URL`, which the test does not clear. It passes with the variable unset, and the test is not touched by this change.

## Fault injection (one site at a time, each reverted with `git checkout`)

Each fault was applied alone to the committed tree (43fed058) and the owning test file run. RED lines are verbatim from the run.

| Fault | Result | RED line |
|---|---|---|
| 1a spawn options drop settings.pty.cols | 18 pass, 1 fail | `(fail) trusted-route PTY engine > builds spawn options like keyed sessions: settings.pty values and the multiplexer config [29.90ms]` |
| 1b no multiplexer config | 18 pass, 1 fail | `(fail) trusted-route PTY engine > builds spawn options like keyed sessions: settings.pty values and the multiplexer config [6.63ms]` |
| 2a one-shot entry not registered in state.ptys | 11 pass, 8 fail | `(fail) trusted-route PTY engine > builds spawn options like keyed sessions: settings.pty values and the multiplexer config [4.38ms]` |
| 2b one-shot admitted through the LRU cap | 18 pass, 1 fail | `(fail) trusted-route PTY engine > is never reused and never evicts a keyed session, even at the concurrency cap [4.98ms]` |
| 2c resumeSessionId ignored | 42 pass, 1 fail | `(fail) one-shot isolation contract > PTY uses a fresh process, registered while it runs and gone after, outside the LRU [2.51ms]` |
| 3 output constraint dropped | 18 pass, 1 fail | `(fail) trusted-route PTY engine > appends the plain-prose output constraint to the system prompt [6.93ms]` |
| 4a timeout returns 1 not 124 | 18 pass, 1 fail | `(fail) exit contract is the same for every engine > pty: a timeout resolves with exitCode 124 [58.66ms]` |
| 4b failed turn reported as success | 16 pass, 3 fail | `(fail) trusted-route PTY engine > registers the child in the supervisor: shutdown during an in-flight one-shot disposes it [3.54ms]` |
| 6a trust self-heal unwrapped (no try/catch) | 18 pass, 1 fail | `(fail) trusted-route PTY engine > survives a throwing or failing trust self-heal, and says so [1.49ms]` |
| 6b trust failure not logged | 18 pass, 1 fail | `(fail) trusted-route PTY engine > survives a throwing or failing trust self-heal, and says so [2.77ms]` |
| 7 allowedTools without dontAsk | 18 pass, 1 fail | `(fail) trusted-route PTY engine > denies tools outside allowedTools instead of waiting at a permission prompt [3.69ms]` |
| 8 unknown route not rejected | 42 pass, 1 fail | `(fail) one-shot configuration > rejects unknown route names at load instead of dropping them [1.18ms]` |
| 10 classifier env allowlist dropped | 4 pass, 1 fail | `(fail) classifyThreadIntent itself (not a hand-built request) > runs the real classifier untrusted: stdin delivery, no tools, allowlisted env, empty cwd [2.72ms]` |

Fault 4b also reddens the registry-wide "failed turn" case; fault 2a reddens eight tests (the registration contract underpins most of the file). The earlier kimi injection (alias dropped from the set): `Expected not contain: "--model"` / `Received: [ "-p", "p", "--model", "kimi-k2p6" ]`.

## Decisions and deviations to review

- **`maxConcurrent` does not count one-shots.** The brief says registered entries should be counted by "admission/maxConcurrent" and also to follow #546. They conflict: #546 ephemeral entries are deliberately outside the cap (`admitEntry`, `enforceMaxConcurrent`). I followed #546 and recorded it in SPEC.md. Counting them would let a compaction burst evict keyed sessions; the test "never evicts a keyed session, even at the concurrency cap" pins it. Admission serialisation and the shutdown refusal do apply.
- **Default model.** With no `req.model` the PTY engine uses `settings.model` (as keyed sessions do); `print` leaves the CLI default. They differ for a real model name set in settings. Not changed here.
- **Legacy `-p` paths.** `runner.ts` `runClaudeOnce` skips kimi, but the two other `-p` argv builders skip only `glm`. Untouched (out of scope); `pty-process.ts` now also omits kimi for keyed PTY sessions, since it shares `buildClaudeArgs`.
- **`dispose()` must settle a pending turn** (the real `PtyProcessImpl.dispose` does). A PTY double that ignores that would hang the call, so the old engine tests were rewritten around a double that honours it (`ptyDouble`).
- **Not hardened:** a turn that ends with `cleanBoundary: false` is still reported as exit 0, as `runOnPty` does for keyed sessions.

## Existing tests changed

`engine.test.ts`: the PTY deadline/late-spawn/untrusted-cwd cases now assert `exitCode: 124` instead of a thrown "timed out"; the fresh-process case expects the child registered during the turn (`before + 1`) and gone after; PTY doubles go through `ptyDouble`. `discord-classifier-isolation.test.ts` gained the `classifyThreadIntent` test.

## Not done / not performed

- No live `claude` PTY run (no real TUI turn, no real permission prompt under `dontAsk`): argv is asserted, behaviour of the flag is from `claude --help`. The issue's manual check for live-TUI behaviour remains open.
- Untrusted PTY stays disabled (`caps.isolation: false`); no spike run.
- ClaudeClaw-Ultra clone: nothing concrete found to reuse, nothing taken.
- Version bumped to 2.2.338 (plugin and marketplace).

