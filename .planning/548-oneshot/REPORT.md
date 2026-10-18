# Issue #548 implementation report

Implemented on `feat/548-oneshot-module`, based on `povai/main`. Frozen interface checkpoint `dede882b` was committed and pushed first, including SPEC.md, engine types, runOneShot signature and canonical isolation flags.

## Changes

- Shared engine dispatcher and registry, print engine and ephemeral PTY helper. Requests require explicit isolation and a positive timeout. Calls log route, engine, model, isolation, milliseconds, exit code and available token counts.
- One canonical TypeScript CLI isolation sequence. Classifier and tuner builders reuse it. Python recall remains the independently deployable #545 implementation; an exact flag-parity test prevents drift.
- Print uses clean child environment handling, isolated temporary cwd for untrusted requests, bounded output, cancellation/deadline handling, child-exit tracking and finally cleanup.
- PTY utility calls own a fresh process/session or explicitly resume, run a turn using existing detection, dispose once and never enter the supervisor's keyed session map/LRU. Late spawns after deadlines are retired.
- oneShot.default / engines / routes settings are parsed at load. Built-ins need no declaration. Exact route, namespace wildcard and default resolution are supported. Unknown engines, incompatible resume routes, malformed declarations and untrusted PTY mappings are rejected.
- Untrusted PTY remains blocked in configuration and execution. PTY argv is prepared to strip MCP, resume, persona and permission flags and use the canonical sequence, but no successful interactive isolation spike is claimed.
- Discord classifier now calls runOneShot with the existing model, 15-second timeout, env allowlist, stdin prompt delivery and JSON parsing. Its original tests are unchanged.
- Tuner now calls runOneShot using tuner.propose/tuner.judge; claude_cli always selects print. New oneshot backend follows route settings. Existing tests, model mapping, trimmed text and cleanSpawnEnv behavior remain unchanged. The CLI cannot enforce maxTokens; this is documented.
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
