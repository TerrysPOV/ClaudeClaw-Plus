# #575: Isolate print argv tests from PTY defaults

## Problem

The session-action argv tests wrap the print engine's process spawn with a fake, but after #572 an omitted `oneShot.default` can route trusted fallback calls to PTY. The print fake then cannot capture the arguments and the tests may attempt to start the real CLI.

## Current behaviour (file:line)

`src/__tests__/session-actions-argv.test.ts:49-55` loads the ambient settings with no explicit one-shot engine, then clears the test injection to call the real `runOneShot`. In a clean non-Windows configuration, the trusted fallback routes can resolve to PTY instead of the print engine whose argv the tests assert.

## Target behaviour

The test setup owns a temporary settings file that explicitly pins `oneShot.default` to `print`, and the teardown restores the settings path and removes the temporary directory. Existing argv assertions remain unchanged.

## Frozen decisions

- Keep these tests as print-engine argv tests; do not convert their assertions to PTY behavior.
- Use the test-only settings-path override and a per-test temporary file, so developer settings and suite order cannot choose the engine.

## Key files

- `src/__tests__/session-actions-argv.test.ts`
- `src/oneshot/engine.test.ts` (reference setup that pins print)
- `src/config.ts` (`_setSettingsFileForTests`)

## Out of scope

- Changing the PTY default or one-shot routing behavior.
- Fixing unrelated failures from the full-suite comparison.
- README or runtime code changes.
