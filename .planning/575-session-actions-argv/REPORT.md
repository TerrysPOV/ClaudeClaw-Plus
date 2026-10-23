# #575 review fix report

## Change

`src/__tests__/session-actions-argv.test.ts` now creates a temporary settings file for each test and explicitly sets `oneShot.default` to `print`. Teardown restores the settings path and removes the temporary directory. The existing argv assertions are unchanged.

## Base/head suite comparison

Both full suites ran with `ANTHROPIC_BASE_URL` unset and a failing `claude` stub first on `PATH`. The base worktree used a symlink to the installed `node_modules`; without it, module resolution failed, so that initial run was discarded. No Claude CLI process was added to the before/after PID snapshots; the stub intercepted one attempted CLI launch per full suite.

| Result | Base `fa2c625d` | Head `26e28d43` |
|---|---:|---:|
| Pass | 4,611 | 4,635 |
| Skip | 4 | 4 |
| Fail | 3 | 4 |
| Total across files | 4,618 tests / 252 files | 4,643 tests / 253 files |

- Failed on both: the two `gateway records the Claude session id the processor surfaces (#376)` tests.
- Failed on base, passed on head: `BusCore IPC > re-delivers an immediately-delivered prompt when the IPC send failed (MCP-blip wedge, #252)`.
- Failed on head, passed on base: `validateAgentName > accepts simple kebab-case names`; `onTurnObserved — tailer-confirmed turn with transcript offset (#212) > a sidechain prompt does not become the prompt the next boundary belongs to`.
- `session-actions-argv.test.ts` passed in both full runs because repository-local settings and suite order masked the clean-settings case. Running it from an isolated temporary cwd on the unmodified head reproduced four failures; after the fix it passes there.

The isolated failure evidence before the fix was:

```text
(fail) compact fallback argv > runs with no tools and without the permission-bypass or any default permission profile [3068.34ms]
(fail) rotation summary fallback argv > grants no tools: the summary comes back on stdout and the daemon writes the file [3034.10ms]
(fail) print engine with an explicit tool list only > does not fall back to the default permission profile (which can carry the bypass flag) [3026.90ms]
(fail) pre-compact memory save fallback argv > resumes with Read,Write available and only the memory file pre-approved [3050.39ms]
```

## Fault injection

Removed the single line writing the explicit print setting; the isolated test again failed with four intercepted PTY attempts. Restored the line immediately.

```text
(fail) compact fallback argv > runs with no tools and without the permission-bypass or any default permission profile [3053.58ms]
(fail) rotation summary fallback argv > grants no tools: the summary comes back on stdout and the daemon writes the file [3017.59ms]
(fail) print engine with an explicit tool list only > does not fall back to the default permission profile (which can carry the bypass flag) [3028.55ms]
(fail) pre-compact memory save fallback argv > resumes with Read,Write available and only the memory file pre-approved [3025.99ms]
```

## Verification

- `env -u ANTHROPIC_BASE_URL PATH=/tmp/575-stub-bin:$PATH bun test --cwd /tmp/575-isolated-run --preload <repo>/scripts/test-preload.ts <repo>/src/__tests__/session-actions-argv.test.ts` — 5 pass, 0 fail; Claude stub called 0 times after fix.
- `env -u ANTHROPIC_BASE_URL PATH=/tmp/575-stub-bin:$PATH bun test src/__tests__/session-actions-argv.test.ts` — 5 pass, 0 fail.
- Full base and head commands: `env -u ANTHROPIC_BASE_URL PATH=/tmp/575-stub-bin:$PATH bun test` — results listed above.
- `bun run lint` — exit 0; checked 554 files, 1,291 warnings and 324 infos, no errors.
- `bun run typecheck` — 149 errors, equal to the 149-error baseline.
- Other print-fake tests were reviewed: one-shot engine tests pin print in their temporary settings; PTY tests inject a fake; E2E tests force print; `live-session-actions.test.ts` injects the one-shot handler. No other setup combining an implicit PTY default and a print-only argv fake was found.

## Remaining

The three failures on the base suite and the two observed head-only full-suite failures are unrelated to this test setup and were not changed. Version files were not touched; version remains 2.2.344. No README, GitHub PR, or comment changes were made.
