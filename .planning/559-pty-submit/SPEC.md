# Problem

Issue #559 reports that a fresh PTY chat turn with the clock prefix added by runUserMessage never submits (rc 124), blocking the #550 default-engine change.

# Current behaviour

- `src/runner.ts:3005`: prefixUserMessageWithClock puts a newline between the clock prefix and user message; runUserMessage calls run with that prompt.
- `src/runner/pty-process.ts:658`: runTurn writes the sanitised prompt plus CR in one write and assumes submission.
- `src/runner/pty-process.ts:940`: readiness uses a quiet window / hard timer, with bypass and project MCP dialog detection.
- `src/__tests__/pty-enabled-routing.test.ts:61`: restoreDir only visits remaining files, losing any snapshot file deleted during the tests.

# Target behaviour

Fresh runner PTY chat turns submit the actual timestamp-prefixed prompt and complete. Test state restoration recreates deleted files/directories. Regression coverage exercises runUserMessage("chat", ...) through the real PTY process layer.

# Frozen decisions

- Investigate before patching: verify each candidate with a probe; do not infer the leading bracket is causal from correlation.
- Minimum candidates: (a) leading bracket interpreted as input control; (b) first-submit/readiness timing; (c) boot trust/project MCP dialog consumes input. Also compare newline/multiline paste handling.
- Real CLI available: 2.1.302; base d81bd579. Live checks use an isolated temporary project and bounded simple prompts. No production daemon/settings changes.
- No PTY default flip or bus redesign. Preserve slash commands, original prompt content and existing turn detection.
- Inspect Ultra commits ad37d730, 29ab7f58, 16c0472e, 2ae9c37e, 8f81c629d6, af3b314e44, 515321b427 against their actual git objects, not the divergent local checkout.

# Probes and results

Pending: runner prefix/no-prefix baseline; same-line bracket control; delayed first input; boot-dialog trace; separated input/Enter control. Results will be recorded here before implementation.

# Key files

src/runner.ts; src/runner/pty-process.ts; src/__tests__/pty-enabled-routing.test.ts; src/__tests__/pty-process.test.ts; tests/integration/pty-real-claude.test.ts.

# Out of scope

#550 defaults and 48-hour soak; bus first-delivery redesign; optional cosmetic duplicate rate-limit notice unless directly necessary.
