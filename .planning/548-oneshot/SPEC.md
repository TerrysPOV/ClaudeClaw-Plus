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
