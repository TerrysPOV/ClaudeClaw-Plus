# PTY parser rewrite — sentinel-echo round-trip (issue #81)

## Summary

Claude 2.1.89 dropped the OSC 9;4 progress markers earlier versions emitted around each turn, breaking the original PTY parser (zero turn boundaries → empty response). This branch replaces the OSC-marker detection with a sentinel-echo round-trip and adds a trust-prompt self-heal for the parallel failure mode (trust-dialog blocks first invocation).

Approach (3) from the issue: write a unique sentinel into claude's TUI input buffer after a quiet window, watch for the echo, slice the response between turn-start and sentinel-found.

## What changed

| File | LOC | Purpose |
|---|---:|---|
| `src/runner/pty-output-parser.ts` | rewritten (~325) | New state machine: `idle → accumulating → awaiting-sentinel → complete`. Emits `turn-start`, `quiet`, `sentinel-found`. Per-turn UUID prevents stale-sentinel matches across turns. |
| `src/runner/pty-process.ts` | rewritten (~615) | runTurn drives the sentinel flow: write prompt → quiet-poll → write sentinel → wait for echo → slice response → Ctrl-U cleanup. New options: `quietWindowMs`, `sentinelMaxWaitMs`, `_sentinelUuidOverride`. Idle-timeout removed in favour of sentinel max-wait. `_skipReadySettle` now resolves on first-byte-arrival instead of OSC 9;4. |
| `src/runner/pty-trust-prompt.ts` | new (130) | `ensureTrustAccepted(cwd)` idempotently writes `projects[<cwd>].hasTrustDialogAccepted: true` to `~/.claude.json`. Non-throwing — returns `{ ok, changed, reason? }`. |
| `src/runner/pty-supervisor.ts` | +20 | Calls `ensureTrustAccepted(spawnOpts.cwd)` before each spawn; passes `quietWindowMs` / `sentinelMaxWaitMs` to spawn options. |
| `src/runner/index.ts` | rewritten exports | Drops `PROGRESS_MARKERS`; exports new parser surface (`startTurn`, `tick`, `markSentinelWritten`, `resetTurn`, `buildSentinel`, `encodeSentinel`, `DEFAULT_QUIET_WINDOW_MS`). |
| `src/config.ts` | +24 | New settings: `pty.quietWindowMs` (default 500), `pty.sentinelMaxWaitMs` (default 30000). |
| `src/__tests__/pty-output-parser.test.ts` | rewritten (350) | 23 tests against new event model + golden fixture from claude 2.1.89. |
| `src/__tests__/pty-process.test.ts` | partial rewrite | Replaced OSC-based clean-boundary test with sentinel-echo round-trip against /bin/cat. New fallback test using `stty -echo; sleep 5`. |
| `src/__tests__/pty-config.test.ts` | +24 | Tests for new `quietWindowMs` / `sentinelMaxWaitMs` parsing + default round-trip. |
| `src/__tests__/pty-integration.test.ts` | +60 | Two new gated real-claude tests verifying sentinel doesn't leak into response + cleanup works across sequential turns. |
| `src/__tests__/pty-trust-prompt.test.ts` | new (165) | 8 tests covering create / idempotent / preserve-existing / malformed-JSON / relative-cwd-resolve. |
| `scripts/capture-sentinel-fixture.ts` | new (140) | Captures `.bin` + `.markers.json` from a live claude 2.1.89 PTY. Used to regenerate the fixture when claude updates. |
| `.planning/pty-migration/fixtures/sentinel-turn-sample.bin` | 16 KB | Real claude 2.1.89 byte stream captured on Hetzner. |
| `.planning/pty-migration/fixtures/sentinel-turn-sample.markers.json` | new | `{ sentinel, promptWrite: 1661, sentinelWrite: 16271, sentinelEchoFound: 16296, totalBytes: 16382 }`. |

## Fixture capture details

- Captured against `claude 2.1.89` running on the Hetzner production daemon (`ssh claw`), cwd `/home/claw/project`.
- Sentinel UUID: `841af0c2-d914-4b99-9f38-3360e4560a3b`.
- Bytes captured: 16382.
- Sentinel echo arrived 25 bytes after our write (very fast — claude's raw-mode echo is sub-millisecond). 
- The post-process step in `capture-sentinel-fixture.ts` re-finds the echo offset in the captured bytes via `Buffer.indexOf` so the markers file is self-validating.

## Cleanup primitive choice — Ctrl-U over backspace

Tested both primitives live on Hetzner against claude 2.1.89:

- **Backspace × N**: cursor walks back to start of line, but stale bytes remain in claude's TUI input state — sentinel was still visible in stdout tail after cleanup.
- **Ctrl-U (0x15)**: kill-line; wipes pending input entirely. Sentinel disappeared cleanly from the visible TUI state.

Both let the next prompt complete successfully, but Ctrl-U produces a strictly cleaner state. `_writeSentinelCleanup` uses Ctrl-U.

## Test results

| Suite | Pass | Fail | Skip | Notes |
|---|---:|---:|---:|---|
| pty-output-parser.test.ts | 23 | 0 | 0 | Includes golden-fixture test against real claude 2.1.89 capture |
| pty-trust-prompt.test.ts | 8 | 0 | 0 | All trust-heal scenarios |
| pty-process.test.ts | 25 | 0 | 0 | /bin/cat + sentinel flow + Ctrl-U cleanup |
| pty-config.test.ts | 41 | 0 | 0 | +new defaults / overrides for quietWindowMs, sentinelMaxWaitMs |
| pty-integration.test.ts | 8 | 0 | 5 | 5 skipped pending `CLAUDECLAW_PTY_INTEGRATION_TESTS=1` |
| pty-* (full) | 173 | 0 | 3 | All pty-*.test.ts files |

**Full repo:** 1210 pass / 28 fail (all 28 pre-existing — verified by stash & re-run against `povai/main@8894698`). Zero regressions introduced.

## Sharp edges for code review

1. **`onChunk` streaming behaviour**: still emits per-chunk stripped text. The sentinel echo IS chunked through onChunk before `sentinel-found` fires. Consumers that concat onChunk output should be aware they may see the sentinel string in the stream (we strip it from the final `result.text` belt-and-braces). If this matters operationally, we should filter onChunk to drop bytes from the parser's `pending` carry-over too — not done in this PR.

2. **TUI cooked-mode echo**: The synthetic /bin/cat tests work because PTY kernel cooked-mode echoes every write. With real claude in raw mode, the prompt itself is NOT echoed back — only the sentinel (which claude treats as user-typing-into-prompt-area) is. The response slice math correctly handles both cases via `turnStartOffset`.

3. **Quiet window tuning**: 500ms is a guess. Real claude can pause mid-response for tool use or thinking. The integration-test default bumps it to 1500ms. Operators on slow networks or with claude-thinking-mode enabled may need to bump higher. We should monitor `cleanBoundary=false` rates in production to calibrate.

4. **`_waitForReadySettle` is weaker now**: was "first OSC 9;4 END marker"; now is "first byte arrived". This means a PTY that emits a single byte before fully painting could falsely settle. In practice claude paints its whole TUI in one burst so this is fine, but if startup turns regress we should add a minimum-bytes threshold.

5. **Trust self-heal failure path**: `ensureTrustAccepted` writes to `~/.claude.json` via tmp-file + `Bun.$ mv`. If `mv` fails (e.g. permission error on a NFS share, ENOSPC), we log a warning and continue — the next claude spawn may still stall at the trust prompt. Production has writable home so this is unlikely, but worth flagging.

6. **Capture script in `scripts/`**: not run by CI, only by humans regenerating the fixture. The non-null assertion lint warning is intentional given the simple arg-parser shape.

## Open questions (none blocking)

- None. Operator answers received mid-task: `\b` vs Ctrl-U (chose Ctrl-U via on-host test), trust self-heal scope (shipped together), integration-test rework (added two sentinel-specific tests, kept supervisor-contract tests intact).
