# #562: a PTY turn reported "done" when the prompt never reached the model

Branch `feat/550-pty-default`, PR #562. Pre-fix head `fa2c625d`. Soak evidence:
Nibbler, 48 h, Linux, CLI 2.1.296, default settings (runner 3/49 and cron 6/50 false
completions).

## Summary

The turn was reported done because the parser's "quiet" gate could be opened by a
**repaint of the previous conversation**, with no evidence that this turn had started.
A paste that was never submitted sat in claude's input box, the TUI repainted its old
screen (spinner glyph, `✻ … done 16:36` summary, `✳` title, idle footer), the gate
opened, the sentinel echoed into the input box, and the last `●` block of the repaint
came back as the answer: exit 0, 2-3 s, no transcript entry. Reproduced against the
unpatched code with a fake TUI (below). The fix makes a turn-start edge a precondition
of completion, retries the submit once, fails the turn if it still was not accepted, and
slices the answer from the edge instead of the send.

Not verified against a real claude (see "Real PTY").

## Diagnosis

The brief's H1 talks about a "footer". The detector is not footer-only: it is a
sentinel echo gated by `tick()` (`src/runner/pty-output-parser.ts:399-436` at
`fa2c625d`), and the footer is one of four completion signals.

### H1: done detection matches stale evidence with no "turn began" edge. CONFIRMED

`tick()` fires `quiet` (the cue to write the sentinel) when all of these hold:

| Gate | Line (`fa2c625d`) | Can a repaint of the old screen satisfy it? |
|---|---|---|
| a byte arrived since `startTurn` | `pty-output-parser.ts:409` | yes, any repaint byte |
| a spinner glyph `✻✶✳✢✽✺✷◉` since `startTurn` | `:420`, scan at `:546` | yes: the old turn's `✻ Sautéed for 1s · done` line |
| idle footer, done-summary OR `✳` title in the 2048-byte tail | `:430`, `hasTurnDoneSummary` `:381`, `hasIdleTitle` `:342` | yes: all three belong to the old, finished turn |
| quiet window elapsed | `:433` | yes |

None of them says "this prompt was accepted". `startTurn` empties `footerTail`
(`:211`), which only guards against evidence from BEFORE the send; the repaint arrives
AFTER it. A resumed session redraws its whole screen when a paste lands, which is why
8 of 9 failures were on long-resumed sessions.

Probe (pre-fix code, `/bin/sh` fake TUI that reads the paste line, repaints
`● OLD-ANSWER-R15x` + `✻ Sautéed for 1s · done 16:36` + `shift+tab to cycle`, and never
submits; kernel echo stands in for the input box):

```
RESOLVED after 111 ms clean= true text= "OLD-ANSWER-R15x"
```

Exit 0 (`pty-supervisor.ts:2289-2294` ignores `cleanBoundary`), 111 ms, the old answer as
the result. Same shape as the soak (2-3 s there: 500 ms quiet window plus real latency).

The returned text is the last `●` block of the repaint: `extractResponseText`
(`pty-output-parser.ts:701-747`, `markerRe` `:714`) takes the LAST line-anchored `●` in
the turn buffer, and the slice starts at the send (`pty-process.ts:856`), so the old
screen is inside it.

### H2: the submit key is sent before the TUI consumed the paste. PLAUSIBLE TRIGGER, NOT MEASURED

`runTurn` writes `ESC[200~ prompt ESC[201~ CR` in ONE `write`
(`pty-process.ts:752-753`). If the TUI handles the paste asynchronously the CR can be
dropped or folded into the paste, leaving the text unsubmitted. That is consistent with
"no new user entry in the transcript", and with #559 (the previous instance of this). I
cannot measure it without a real authenticated claude, so H2 is treated as the likely
TRIGGER and H1 as the reason it was REPORTED as done. The fix covers both: a second CR
after `submitConfirmMs` if no turn started, and a loud failure if that fails too.

### H3: resumed sessions corrupt the output offset bookkeeping. REFUTED

`_turnBuf` is reset at `runTurn` (`pty-process.ts:724`) and `turnStartOffset` is set from
`totalBytes` in the same synchronous step (`pty-output-parser.ts:199`);
`_completeTurn`'s slice arithmetic (`pty-process.ts:856-865`) is consistent with that
(and has a regression test for the pre-turn-banner case, `pty-process.test.ts`, "Codex PR
#82 P1"). In the probe above the fake prints the old screen only AFTER it reads the
prompt, so the stale text really arrived after the send: the slice started in the right
place, the repaint was inside it. The long-resumed correlation is explained by H1: a
longer conversation means more old chrome to repaint.

## What I took from ClaudeClaw-Ultra (`3750fbe0`, #500)

- **Principle** (from `docs/standards/driving-the-claude-tui.md` in that repo, which the
  commit amends): the screen is spoofable, so "the prompt was submitted" must come from
  positive evidence, not from the screen being in an idle-looking state. Ultra gets it
  from the transcript's user line. I did not port that tracker: a fresh session has no
  transcript yet, and untrusted one-shots run with `--no-session-persistence`, so the
  transcript cannot be the only proof on this path. The byte-stream edge is available on
  every path. A transcript check remains a possible second line of defence.
- **Footer region anchoring + "busy marker after the footer withdraws idle"**: I looked
  at it and did NOT port it. It fixes a different bug (model text quoting "tab to cycle"
  mid-turn). It would not have stopped this one: the stale footer in a repaint IS in the
  footer region. Plus already judges the footer per line against `esc to interrupt`
  (#369).

## Fix

`src/runner/pty-output-parser.ts`
- New `sawTurnStartEdge` / `turnEdgeOffset`. The edge is what claude paints only while a
  turn runs: a running window title (`◐◑◒◓` or a braille glyph, not the idle `✳`), the busy
  footer `esc to interrupt` (CUF/CHA gaps tolerated), or `Compacting conversation` (what
  the allowed `/compact` paints). All three are captured shapes from #369's tests and the
  `sentinel-turn-sample.bin` fixture, not guesses.
- `tick()` withholds `quiet` until the edge is seen. When it latches, `footerTail` is cut
  to the edge chunk, so completion evidence (summary, footer, `✳` title) must POSTDATE it:
  a repainted summary still in the tail cannot open the gate for a turn that has only just
  started (the #316 hole again).
- The edge is scanned over the chunk plus a 96-byte carry, not the capped 2048-byte tail,
  so a marker split across chunks or at the start of a large repaint chunk is not lost.

`src/runner/pty-process.ts`
- `submitConfirmMs` (default 3000). No edge by then: write one bare CR (harmless on an
  empty input box if the first one WAS accepted). No edge after another window: write
  Ctrl-U (so the NEXT turn's CR cannot submit the orphaned paste) and reject with the new
  `PtyPromptNotAcceptedError`.
- The response is sliced from the chunk holding the edge, not from the send, so a repaint
  that preceded the turn is never the answer. Chunk granularity on purpose: cutting at the
  marker itself could drop the first words of an answer painted ahead of the busy footer
  in one frame.
- `onChunk` / `onToolEvent` stream only after the edge, so a streaming caller never shows
  the old screen as this turn's output.

`src/runner/pty-supervisor.ts`
- `PtyPromptNotAcceptedError` is exit 1 (never 0), is NOT retried (a re-sent prompt could
  land twice) and retires the entry, as a timeout does, so the next call respawns and
  resumes. Same in `sendToLiveSession`.

Cron consequence from the soak: a lost turn is now a failed job (exit 1, "PTY prompt not
accepted"), not a pass on stale scrollback.

## Tests

New `src/__tests__/pty-false-completion.test.ts` (7), parser edge tests (7) in
`pty-output-parser.test.ts`, one test each in `pty-supervisor.test.ts` and
`pty-send-to-live.test.ts`. Fake TUIs are real `/bin/sh` children; no real claude.

| Test | What it pins |
|---|---|
| stale footer + summary, paste never submitted | not done; `PtyPromptNotAcceptedError` |
| paste swallowed once, retry lands | completes with only the new output |
| output isolation | the repainted old `●` answer is not the result |
| resumed session, 30 old turns repainted | not mistaken for completion; not the answer |
| accepted on first CR, turn outlasts `submitConfirmMs` | no retry in the PTY trace |
| never accepted | Ctrl-U (0x15) reaches the TUI before the failure |
| `onChunk` on a turn that never started | old screen not streamed |
| parser: repaint never opens the gate; evidence before the edge does not count; edge shapes; split marker; large chunk; offset; reset | |
| supervisor / live: not-accepted | exit 1, one turn, entry retired |

Existing tests whose fake TUIs never painted running chrome (cat-echo prompts, the
`#460/#469` boot-dialog scripts, parser synthetic feeds, `fixtures/paste-burst-tui.ts`)
were updated to paint it. That is the new contract (a real claude paints it every turn),
not a weakened assertion: none of their assertions changed.

### Fault injection (one site at a time, on a `git archive` copy)

Every injection below went RED with the lines shown (verbatim from the run). Two sites
(F8, F12) did NOT go red on the first pass: my first versions of those two tests could
not fail (one used `read -t`, which dash does not have, so it was vacuous on CI; the
other never observed the Ctrl-U). They were rewritten (PTY trace for the retry, a raw-mode
byte read for Ctrl-U) and re-injected; the lines below are from the rewritten tests.

**F1: drop the turn-start gate from `tick` (`pty-output-parser.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > stale footer + summary on screen, paste never submitted: the turn is NOT done
(fail) #562 — a turn completes only on evidence the prompt was accepted > paste swallowed once, the submit retry lands: completes with only the new output
(fail) #562 — a turn completes only on evidence the prompt was accepted > output isolation: the previous turn's answer, repainted before this turn starts, is not the result
(fail) #562 — a turn completes only on evidence the prompt was accepted > resumed session: a repaint of thirty old turns is neither the answer nor mistaken for completion
(fail) pty-output-parser — turn-start edge (#562) > a repaint of the old conversation (spinner + summary + ✳ title + footer) never opens the gate
```

**F2: delete the submit-retry `write("\r")` (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > paste swallowed once, the submit retry lands: completes with only the new output
```

**F3: slice the response from the send instead of the edge (`pty-process.ts` `_completeTurn`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > output isolation: the previous turn's answer, repainted before this turn starts, is not the result
(fail) #562 — a turn completes only on evidence the prompt was accepted > resumed session: a repaint of thirty old turns is neither the answer nor mistaken for completion
```

**F4: keep pre-edge bytes in `footerTail` when the edge latches (`pty-output-parser.ts`)**
```
(fail) pty-output-parser — turn-start edge (#562) > completion evidence painted BEFORE the edge does not count; evidence after it does
```

**F5: stream `onChunk` before the edge (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > onChunk is not fed the stale repaint of a turn that never started
```

**F6: supervisor treats `PtyPromptNotAcceptedError` as retryable (`runTurnWithRetries`)**
```
(fail) pty-supervisor retry and backoff > #562: a prompt claude never accepted is an error (exit 1, never 0), runs once, and retires the entry
```

**F7: `sendToLiveSession` does not retire the entry on not-accepted**
```
(fail) sendToLiveSession > #562: a prompt claude never accepted reports failed (not sent) and retires the entry
```

**F8: the confirm timer ignores the edge and retries anyway (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > a prompt accepted on the first CR is not re-submitted, even when the turn outlasts submitConfirmMs
```

**F9: scan the chunk only, no carry (marker split across chunks)**
```
(fail) pty-output-parser — turn-start edge (#562) > a marker split across two chunks is found
(fail) pty-output-parser — turn-start edge (#562) > the response slice starts at the chunk that holds the edge, not at the send
```

**F10: scan the capped footer tail instead of the chunk (marker in a large chunk)**
```
(fail) pty-output-parser — turn-start edge (#562) > a marker at the start of a chunk larger than the footer window is not lost to the tail cap
```

**F11: `runTurnWithRetries` does not retire the entry on not-accepted**
```
(fail) pty-supervisor retry and backoff > #562: a prompt claude never accepted is an error (exit 1, never 0), runs once, and retires the entry
```

**F12: final failure does not clear the input box (Ctrl-U)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it
```

## Verification runs

- New + affected PTY suites (22 files: every test importing the PTY runner/supervisor/parser):
  normally 564 pass / 0 fail, and with `CLAUDECLAW_TEST_PLATFORM=linux` the same.
  (The two `#559` failures seen mid-way were `fixtures/paste-burst-tui.ts` not painting
  running chrome; fixed, `pty-enabled-routing.test.ts` 21/21.)
- `bun run lint` (full repo, `biome check`): 0 errors (1289 warnings and 324 infos are
  pre-existing; the 7 errors that appeared mid-way were mine: 4 control-char regex and 3
  unformatted files, fixed).
- `bun run typecheck` (ratchet): 149 errors, baseline 149, no new ones.
- Run with `env -u ANTHROPIC_BASE_URL`; test output went to files, never a pipe.

## Real PTY

Not done. A real turn needs an authenticated claude; a throwaway `CLAUDE_CONFIG_DIR` has
no credentials, and the brief rules out the operator's `~/.claude`. The edge markers come
from captured 2.1.269 bytes (#369) and the 2.1.89 fixture, not from a fresh 2.1.296 /
2.1.306 capture.

## Residual risk and follow-ups (not done here)

1. **A CLI that stops painting the running chrome** would fail EVERY turn, after ~6 s, with
   `PtyPromptNotAcceptedError`. That is loud, not silent, but it is a new way for turns to
   fail. Nibbler's rerun on the fix is the check: it should show no
   `PtyPromptNotAcceptedError` on healthy turns. `submitConfirmMs` is the knob.
2. **A prompt that contains `esc to interrupt`** is echoed into the input box and forges
   the edge, for that prompt only. That is the pre-fix behaviour, not worse.
3. **`cleanBoundary=false`** (sentinel never echoed after a started turn) still returns
   partial text with exit 0 (`pty-supervisor.ts:2289`; nothing consumes the flag). The
   prompt WAS accepted, so it is not this bug, but it is the same fail-open shape.
4. **Restart: "session already in use"** (soak note) is a separate bug; untouched.
5. If the byte-stream edge proves flaky on some CLI version, Ultra's transcript user-line
   confirmation is the stronger signal for sessions that have a transcript.

No rebase and no version bump (coordinator's). No PR comments.


---

# Round 2: Codex review of `5c28206b` (4 HIGH, 2 MEDIUM) and the operator addendum

Round 2 commits on `feat/550-pty-default`: `f7cc53c9`, `0b9fdeea`, `79bd483d`, and the final
cleanup/report commit. The addendum (Terry, 2026-10-21) is binding: **the screen is never
evidence that a prompt was accepted, that a turn finished, or of what the answer was. Only
the session transcript is.** That supersedes the brief's "keep the screen for TUI-idle
timing" and its step-5 fallback, so round 1's screen-based edge detection is gone, not
patched.

## Round 2 design

### Feasibility verdict (brief step 1): small, done

| Question | Answer |
|---|---|
| Does the PTY path know the session id at turn time? | Yes, for every trusted entry: `--resume <id>` or `--session-id <uuid>` is always passed (`pty-process.ts:buildClaudeArgs`, supervisor mints one when there is none, `pty-supervisor.ts` ~1476). |
| Can the transcript path be derived? | Yes: `<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<encodeCwdForProjectsDir(realpath(cwd))>/<id>.jsonl`. The env is the child's own env, so a throwaway config dir is honoured. |
| Does `--resume` append to the same file? | The bus path relies on it (`#402`: the transcript's session id is the stable UUID across a `--resume` restart). Not re-measured here: no authenticated claude. If it were false, every turn would fail loudly with `PtyPromptNotAcceptedError` after ~6 s, never succeed. |
| Reusable without a bus dependency? | The tailer class is bound to `BusCore`; I did not use it. `pty-transcript.ts` (new, ~300 lines) reuses two leaf exports, `encodeCwdForProjectsDir` and `isTerminalStopReason`, and reads the file itself. |
| Untrusted one-shots | `UNTRUSTED_CLAUDE_ARGS` carry `--no-session-persistence`: **there is no transcript.** Coordinator ruling A: fail closed. See "Untrusted PTY turns". |

### What a turn is now (`pty-process.ts`, `pty-transcript.ts`)

1. `TranscriptTurn.mark()` records the transcript size, THEN the prompt is written (bracketed
   paste + CR). Only bytes appended after the mark are read, so an earlier entry, even a
   byte-identical earlier prompt, can never satisfy acceptance.
2. **Accepted** = a top-level `user` entry (or a `queue-operation` `enqueue`) whose text
   matches what was written. Matching is the bus path's (`normalizePromptForMatch`):
   whitespace dropped, containment (a `<pasted_content>` wrapper is tolerated). Sub-agent
   (`isSidechain`), tool-result and compact-summary entries never match. `/compact` is matched
   by its `<command-name>`.
3. **Answer** = the assistant text of the last assistant message appended after that `user`
   entry (blocks sharing a `message.id` are joined, so an answer split across appends is
   whole). `onChunk` streams that text; `onToolEvent` streams `● Name(input)` lines from
   `tool_use` blocks.
4. **Done** = that turn's final assistant entry has a terminal `stop_reason`
   (`isTerminalStopReason`, the bus's own rule), or the CLI wrote `turn_duration`, or a
   CLI-written API-error line. `/compact`: `compact_boundary` (answer "Conversation
   compacted") or the `local_command` entry carrying the CLI's error text.
5. The submit retry and `PtyPromptNotAcceptedError` are keyed on (2): after `submitConfirmMs`
   the transcript is read once more, and only then is one bare CR written (never the prompt
   again); after another window, Ctrl-U and the error. The error says when the transcript
   held user entries that did not match.
6. The resolve waits for the screen to be quiet for `quietWindowMs`, **capped at
   `settleCapMs` (2 s)**. That is the only thing the screen still contributes to a turn and
   it is delay-only: it cannot complete a turn, change the answer, or turn a success into a
   failure (test and injection below).
7. A process with no transcript path fails in `runTurn` **before anything is written** with
   `PtyTranscriptUnavailableError`.

Removed: the sentinel round trip, `tick`/`feed`/`startTurn` use in `pty-process.ts`, the
turn-start edge, the footer/summary/title gate, `extractResponseText`/`decodeTurn` for the
answer, the `sentinelMaxWaitMs` deadline. `pty-output-parser.ts` is untouched and still
exported (it is unit-tested and the bus imports `expandCursorForwardToSpaces`/`stripAnsi`
from it); nothing that decides a turn imports its completion/answer API (guard test below).

### How each finding is closed

| # | Finding | Closed by |
|---|---|---|
| 1 | Edge markers match in echo / old text | There is no screen edge. Acceptance needs a transcript entry for this prompt; the forgery tests put each phrase in the prompt and in old assistant text. |
| 2 | Pre-edge evidence survives in the same chunk | No chunk-granular offset exists. The transcript is read by byte offset from the pre-send mark; the same bytes in any partition give the same verdict (table-driven tests). |
| 3 | Answer painted before the edge chunk is dropped | The answer is the transcript's assistant text, not a screen slice. A message split across appends is joined. |
| 4 | `cleanBoundary=false` is exit 0 | See below. |
| 5 | Fast turn / `/compact` / different chrome paints no running marker | Acceptance does not read the screen. Tests: no chrome at all, SGR inside the footer, `/compact`. |
| 6 | Tests manufacture acceptance through the prompt echo | Rewritten: fake TUIs write a real JSONL transcript (`fixtures/fake-claude-tui.ts`), prompts carry no marker phrase except in the forgery tests, and most tests put screen and transcript in disagreement. |

### Finding 4: `cleanBoundary=false` is a failure (I chose: return a complete reply, otherwise fail)

With the sentinel gone a real process now resolves only when the transcript shows the reply
complete, so `cleanBoundary` is `true` and `replyComplete` is `true` from `PtyProcess`. The
failure path is kept for any `PtyProcess` that reports otherwise, in BOTH callers, via one
shared `boundaryVerdict(result)`:

- `cleanBoundary=false` and no `replyComplete`: **failure**, entry retired, never resubmitted
  (the turn may have run). `runTurnWithRetries`: exit 1, "boundary unconfirmed".
  `sendToLiveSession`: `status: "failed"`, which `live-session-actions.ts` already maps to
  `ok: false`.
- `cleanBoundary=false` and `replyComplete: true` (the transcript shows a complete reply):
  **success with the answer, and the entry is still retired**, because the TUI never
  confirmed it was idle. This is the "return it as success" option the brief allowed; I
  chose it because a complete assistant reply is the answer and discarding it would be
  silent loss the other way.

### Untrusted PTY turns (coordinator ruling A)

A PTY turn with no transcript fails closed with `PtyTranscriptUnavailableError`
(`"... an untrusted one-shot runs with --no-session-persistence"`). Nothing is written to the
PTY first, so the input box is untouched. This breaks nothing live on this branch: the PTY
engine has `caps.isolation=false` (`src/oneshot/registry.ts:21-23`), so untrusted one-shots
route to `print`. **Follow-up for #570 / #581** (which enable untrusted PTY): untrusted calls
must be given a transcript, i.e. run in the throwaway `CLAUDE_CONFIG_DIR` with session
persistence on, instead of `--no-session-persistence`. Not done here (ruling: not B).

## Remaining screen uses, by permitted category (addendum point 5)

| Use | Where | Category | Can it complete a turn? |
|---|---|---|---|
| Boot readiness: wait for the TUI to settle, "tab to cycle" footer | `pty-process.ts` `_waitForReadySettle` (~1100-1200) | readiness | No: before any turn |
| Boot dialogs: Bypass Permissions, project-MCP approval, trust prompt; answered with a key | `_waitForReadySettle`, `pty-trust-prompt.ts` | dialogs | No |
| PTY exit and the credential-redacted tail for the "exited before TUI settled" error | `_handleExit`, `_appendToTail`, `_readTailSnapshot` | liveness | No: it can only FAIL a turn (`PtyClosedError`) |
| Last-paint timestamp, to wait for a repaint to quiet before resolving | `_handleData` `_lastDataAt`, `_tick` | timing / readiness | **No.** Gated by the transcript; waits at most `settleCapMs`; delay-only |
| Ctrl-U to empty the input box after a failed turn | `_clearInputBox` | input hygiene on failure | No |
| `CLAUDECLAW_PTY_DUMP` raw trace | `dumpPtyTrace` | diagnostics | No |
| Bus: boot-dialog gates, idle footer latch | `src/bus/session-agent-process.ts` (not touched) | readiness / dialogs | Out of scope: not the runner's turn path |

`pty-process.ts` imports exactly one thing from the screen parser: `stripAnsi`, for the boot
text. The guard test lists the rest as forbidden.

## Guard test (addendum point 4)

`src/__tests__/pty-turn-evidence-guard.test.ts` reads the source of
`pty-process.ts`, `pty-transcript.ts`, `pty-supervisor.ts` and `live-session-actions.ts` and
fails if any imports, re-exports, `require`s or dynamic-imports the screen parser's
completion/answer API. Forbidden symbols: `createParser`, `startTurn`, `feed`, `tick`,
`markSentinelWritten`, `resetTurn`, `buildSentinel`, `encodeSentinel`, `extractResponseText`,
`decodeTurn`, `normaliseNewlines`, `Parser`, `ParserEvent`, `ParserState`. Allowed readiness
helpers: `stripAnsi`, `DEFAULT_QUIET_WINDOW_MS`. It scans text rather than the module graph
so a barrel cannot hide a re-export. It also tests itself (10 shapes it must flag, one it
must allow). Injection I15 below adds `feed` to the `pty-process.ts` import: RED.

The rule is recorded in `.planning/pty-migration/SPEC.md` (new file, frozen decision 1;
the long-form SPEC the global rules mention is not in this tree) and in `CLAUDE.md`
("PTY turn evidence", rule verbatim).

## Round 2: fault injection (one site at a time, on a `git archive` copy of the commit)

Each injection was applied with an exact-match assertion (the driver fails if the text to
change is not found exactly once), then the named test files were run. Lines are verbatim
from those runs (first four failures of each; the count is the total). Every injection went
RED. One did not on its first try, and was fixed first: I19 (a "strip the
`<pasted_content>` wrapper" step survived the injection because containment already tolerates
the wrapper, so the step was dead code and was deleted; the injection now targets
containment itself).

```
## I1 screen marker forges acceptance + end: exit=1 failing=16
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "esc to interrupt": the turn is NOT done [192.41ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "esc cancel": the turn is NOT done [114.42ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "Compacting conversation": the turn is NOT done [118.76ms]
```

```
## I2 mark() at offset 0 (earlier entries count): exit=1 failing=3
   (fail) TranscriptTurn — acceptance > an EARLIER identical prompt does not count: only bytes after the mark are read [2.43ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > an earlier identical prompt and its answer in the transcript are not this turn [133.33ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [635.66ms]
```

```
## I3 torn trailing line is dropped, not carried: exit=1 failing=6
   (fail) TranscriptTurn — delivery shape never changes the verdict > two halves: same verdict and answer as one write [0.89ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > five parts: same verdict and answer as one write [0.55ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > a cut inside every line: same verdict and answer as one write [0.54ms]
```

```
## I4 repeated message id replaces instead of joining: exit=1 failing=10
   (fail) TranscriptTurn — answer and end of reply > blocks of ONE message arriving over separate polls are joined, in full [4.23ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > one write: same verdict and answer as one write [0.45ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > two halves: same verdict and answer as one write [0.40ms]
```

```
## I5 assistant lines count before the user entry: exit=1 failing=1
   (fail) TranscriptTurn — answer and end of reply > an assistant entry BEFORE the user entry is not this turn's answer [4.66ms]
```

```
## I6 screen quiet after acceptance completes the turn: exit=1 failing=14
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [755.41ms]
   (fail) #562 — a turn is over only when the transcript says so > accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done [120.72ms]
   (fail) #562 — a turn is over only when the transcript says so > the answer is the transcript's, not the screen's [116.30ms]
```

```
## I7 submit retry ignores the transcript (acceptance): exit=1 failing=6
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [620.11ms]
   (fail) #562 — a turn is over only when the transcript says so > accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done [824.99ms]
   (fail) #562 — the same transcript, delivered in any shape, gives the same verdict and answer > byte-sized fragments over the last block [818.21ms]
```

```
## I8 submit retry re-writes the prompt: exit=1 failing=1
   (fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission [406.86ms]
```

```
## I9 submit retry CR deleted: exit=1 failing=3
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [671.89ms]
   (fail) #562 — the submit retry > paste swallowed once, the retry lands: completes with only the new output [461.77ms]
   (fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission [457.77ms]
```

```
## I10 Ctrl-U not sent on not-accepted: exit=1 failing=1
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [3427.27ms]
```

```
## I11 quiet window gates completion (no cap): exit=1 failing=1
   (fail) #562 — the screen's only say is timing, and it can only delay > a screen that never goes quiet still resolves with the transcript answer after the cap [5001.17ms]
```

```
## I12 no-transcript refusal removed: exit=1 failing=3
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [624.27ms]
   (fail) #562 — a process with no transcript cannot succeed > an untrusted PTY turn errors before anything is written and never resolves from the screen [1052.53ms]
   (fail) #562 — a process with no transcript cannot succeed > a hooked process given no transcriptPath is refused the same way [818.45ms]
```

```
## I13a runTurnWithRetries ignores cleanBoundary: exit=1 failing=2
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed turn boundary is an error (exit 1), runs once, and retires the entry [1.71ms]
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed boundary whose transcript shows a COMPLETE reply is returned, and the entry is retired [1.73ms]
```

```
## I13b sendToLiveSession ignores cleanBoundary: exit=1 failing=2
   (fail) sendToLiveSession > #562 round 2: an unconfirmed turn boundary reports failed (not sent) and retires the entry [2.16ms]
   (fail) sendToLiveSession > #562 round 2: an unconfirmed boundary with a COMPLETE transcript reply is sent, and the entry is retired [1.93ms]
```

```
## I14a runTurnWithRetries does not retire on unconfirmed: exit=1 failing=2
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed turn boundary is an error (exit 1), runs once, and retires the entry [0.95ms]
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed boundary whose transcript shows a COMPLETE reply is returned, and the entry is retired [0.86ms]
```

```
## I14b sendToLiveSession does not retire on unconfirmed: exit=1 failing=2
   (fail) sendToLiveSession > #562 round 2: an unconfirmed turn boundary reports failed (not sent) and retires the entry [0.90ms]
   (fail) sendToLiveSession > #562 round 2: an unconfirmed boundary with a COMPLETE transcript reply is sent, and the entry is retired [0.59ms]
```

```
## I15 guard: parser completion API imported into pty-process: exit=1 failing=1
   (fail) PTY turn evidence: the modules that decide success do not read the screen parser's completion API > src/runner/pty-process.ts imports nothing from the parser's completion/answer API [5.18ms]
```

```
## I16 /compact never matches its command entry: exit=1 failing=3
   (fail) TranscriptTurn — /compact > accepted by the command entry, ended by compact_boundary [0.49ms]
   (fail) TranscriptTurn — /compact > a failed compact ends on its local_command error, carrying the CLI's text [0.35ms]
   (fail) #562 — acceptance does not depend on the screen painting anything > /compact: accepted by its command entry, ended by compact_boundary, not re-submitted or rejected [421.83ms]
```

```
## I17 onChunk not fed from the transcript: exit=1 failing=1
   (fail) #562 — a turn is over only when the transcript says so > onChunk streams the assistant's own text from the transcript [280.82ms]
```

```
## I18 whitespace collapsed to one space instead of dropped: exit=1 failing=1
   (fail) TranscriptTurn — acceptance > a TAB in the prompt, which the TUI turns into a completion key, does not stop it matching [9.11ms]
```

```
## I19 containment replaced by equality (wrapped prompt no longer matches): exit=1 failing=2
   (fail) TranscriptTurn — acceptance > the prompt may arrive wrapped (a paste wrapper, a prefix): containment, whitespace-insensitive [0.39ms]
   (fail) TranscriptTurn — acceptance > a prompt the CLI recorded as a paste is wrapped in pasted_content tags and still matches [0.29ms]
```

## Round 2: verification

- Affected suites: every test importing the PTY runner/supervisor/parser plus the new files
  and the gateway seam test (27 files), on the final commit: **663 pass / 0 fail**, both
  normally and with `CLAUDECLAW_TEST_PLATFORM=linux`. Earlier runs on this branch hit two
  timing-sensitive tests under parallel load, neither a regression: the #469 "dialog that
  paints late" test (a fake dialog script exited 1 when its Esc was late; `_waitForReadySettle`
  is untouched by round 2; it passed 3/3 alone) and the Ctrl-U test (racy because the fake
  was disposed with the error; rewritten to keep it alive until the byte is recorded, 5/5
  after, and its injection is still RED).
- A full-repo `bun test` run before the final fixes showed 5 failures: the two #559 tests
  (the stand-in TUI wrote no transcript; fixed, 21/21), the late-dialog flake above, and two
  gateway tests failing with "System is paused": an escalation test in the full run had
  written `.claude/claudeclaw/paused.json` ("Watchdog suspend: Test") into this worktree. It
  is gitignored runtime state, not code; I deleted it and the tests pass. It will recur on
  any full-suite run in this worktree (pre-existing cross-test pollution).
- `bun run lint` (full repo): 0 errors (1291 warnings, 324 infos, pre-existing).
  `bun run typecheck`: 149 errors, baseline 149.
- Run with `env -u ANTHROPIC_BASE_URL`; test output went to files, never a pipe.

## Not done / risks

1. **No real claude.** Nothing here was run against an authenticated CLI. The assumptions
   that only a real run can confirm: `--resume` appends to the same transcript file; the
   transcript records a pasted prompt in a form the bus-style containment match accepts;
   the final assistant line of a turn carries a terminal `stop_reason` (or `turn_duration`
   follows). Each fails LOUD: `PtyPromptNotAcceptedError` after ~6 s, or a turn that runs to
   its own `timeoutMs`; none can succeed falsely. Nibbler's rerun should show no
   `PtyPromptNotAcceptedError` on healthy turns.
2. A turn whose terminal marker is never written would now wait for the caller's
   `timeoutMs`, where the screen used to end it early. That is the cost of the ruling.
3. `submitConfirmMs` (3 s) assumes the CLI writes the `user` entry within that. The bus
   measured p95 0.25 s for an idle session; a prompt queued behind a running turn has an
   `enqueue` record (also accepted) but its `user` entry can be minutes late. The runner
   serialises turns per session, so this should not arise.
4. Untrusted PTY (above) is a follow-up for #570 / #581.
5. `sentinelMaxWaitMs`, `turnIdleTimeoutMs` and `quietWindowMs` remain in settings so
   existing files parse; `sentinelMaxWaitMs` is now unused and `quietWindowMs` is the
   readiness wait.

# Round 3: Codex review of `4ef9379f` (5 HIGH, 4 MEDIUM)

Branch `feat/550-pty-default`. The operator rule stands (the screen is never success,
acceptance or answer evidence; only the session transcript). Codex closed round-1 findings
1, 2, 3, 5, 6; this round fixes the transcript reader itself. No real `claude` was run.

## Round 3: summary

| Finding | What changed | Where |
|---|---|---|
| H1 placeholder is not an answer | a non-error `<synthetic>` line is neither text nor an end (the bus tailer's rule) | `pty-transcript.ts` `ingestAssistant` |
| H2 + M2 success vs failure | the reader returns running / OK / FAILED (`api-error`, `command-error`, `ambiguous`); a failure rejects `runTurn` with `PtyTurnFailedError`; both callers fail on it; `boundaryVerdict` has no `ok-retire` | `pty-transcript.ts`, `pty-process.ts`, `pty-supervisor.ts` |
| H3 exact match | `promptMatches` compares the whole payload for equality after the CLI's paste wrapper and the padding it adds are taken off; internal whitespace is kept; a TAB may be recorded as nothing or spaces at its own position only; a second identical prompt fails the turn as `ambiguous` | `pty-transcript.ts` |
| H4 frozen window | the matched turn is a window: it closes at the first entry that is not part of it; the answer is all the window's assistant text | `pty-transcript.ts` |
| H5 commit, then settle | `_commitTurn` cancels the hard timeout when the transcript establishes the outcome; a PTY exit after the commit completes the turn instead of rejecting | `pty-process.ts` |
| M1 file identity | `mark()` records dev+inode and the size; a removed, replaced or cut-short file throws `TranscriptReplacedError`, which fails the turn | `pty-transcript.ts`, `pty-process.ts`, `pty-supervisor.ts` |
| M3 guard follows the graph | the guard builds the TypeScript module graph from the four modules and resolves every identifier through its alias chain | `pty-turn-evidence-guard.test.ts` |
| M4 executions, not bytes | fake TUIs count the user entries they execute | `pty-false-completion.test.ts` |

## Round 3: decisions

**API errors: matched to the print path, not the bus path.** Read first:
`src/runner.ts` (`signatureErrorWarrantsReset`, ~2246) and `src/bus/jsonl-tailer.ts` (~785).
On the print path an API error is a non-zero exit, the CLI's text is the output the runner
scans, a corrupt session is reset by the RUNNER (not by the process layer), and nothing
retries. The bus path publishes `system.api_error`, releases the turn with EMPTY text and
does not retry either. So an API error is now: `runTurn` rejects with `PtyTurnFailedError`
(`kind: "api-error"`); `runOnPty` returns exit 1, no retry, the entry retired, and
`rawStdout` = the CLI's error text. That text is deliberate: `signatureErrorWarrantsReset`
reads the output and the transcript's own `isApiErrorMessage` entry, whatever the exit code,
so a corrupt-session reset still happens (the exit-0 path used to feed it the same text).
`sendToLiveSession` returns `failed`, not `sent`, and retires the entry. An `ambiguous` or
`command-error` outcome carries NO output (`rawStdout` is empty): its text is a description,
not a reply.

**Answer = the FINAL assistant message of the matched turn (operator ruling after round 3,
`7d56b209`).** Same as the print path's `result`: PTY is a drop-in, so Telegram/Discord/cron
output must not start carrying between-tool narration ("Let me look."). The blocks of that one
message join as-is. If the final message has no text but an earlier one does (a turn that ends
on a tool-only message), the answer is the LAST message that has text; if none has any, it is
empty. Round 3 first returned every message joined by a blank line; that was reverted. H4's
defect was crossing into the NEXT turn, which the frozen window fixes; choosing the final
message inside the window is independent of it. (Streaming `onChunk` is unchanged: it still
emits assistant text as it appears, as the print path's stream does.)

**When the outcome is committed.** At the first terminal-`stop_reason` line that has text. A
final message whose first line has no text (the CLI writes a thinking block as its own line
and repeats the stop reason) waits for the rest of that SAME message, and the window closes
on the next entry that is not part of it. After the commit only lines of the final message's
own id can still extend the answer; a later prompt, another message id or `turn_duration`
closes the window. A final message with no text at all and nothing after it never ends
(the hard timeout does; before this round the bare stop reason ended it).

**Uncertainty fails closed.** Inside the window a non-meta user text that is not this prompt
(`isMeta`, tool results, compaction summaries and `<local-command-stdout>` are the turn's own)
fails the turn as `ambiguous`; so does a second copy of this prompt, inside the window or as
the first entry after the final message. A copy that arrives after `runTurn` returned cannot be
seen. Correlation ids: the matched entry's `uuid`/`promptId` identify "the same record" so a
line the CLI repeats is not a duplicate. The `parentUuid` chain is NOT used to attribute
assistant lines: another prompt inside the window already fails the turn, and rejecting an
unrecognised parent would turn a chain shape I have not seen into a hang.

**A failed turn skips the screen settle.** The entry is retired anyway, so there is no next
paste to wait for.

## Round 3: tests

- `pty-transcript.test.ts`: 57 tests (the `4ef9379f` file ran about 28): exact match incl. the two required negatives and
  the TAB rule, duplicate and foreign prompts, failure kinds, placeholder, window/freeze
  (A,B in one poll; B after the commit; B during the settle), file identity (bigger and smaller
  replacement holding an earlier identical prompt+answer, cut short, removed, created later),
  message join.
- `pty-false-completion.test.ts`: H5 (a deadline inside the settle; a deadline with the reply
  unread; a PTY exit during the settle; a PTY exit before the last read; B arriving during the
  settle), failure and replaced transcript at the process level, and M4 (below).
- M4: `a TUI that would execute twice on the retry Enter` counts the `user` entries the fake
  writes (2) and asserts the turn is `ambiguous`, not a success; the late-flush TUI asserts
  exactly ONE `user` entry and one reply.
- `pty-supervisor.test.ts` / `pty-send-to-live.test.ts`: the two exception tests (`~537`,
  `~479`) now require a FAILURE; new tests for api-error (exit 1, output = the CLI's text, run
  once, entry retired), ambiguous (exit 1, no output), replaced transcript.
- `pty-turn-evidence-guard.test.ts`: 23 tests; the real module graph is clean, and 19 negative
  fixtures: a named/aliased/type-only/namespace/multi-line import, a dynamic import (result
  used and unused), a require, a renamed re-export (one and two barrels deep), a namespace
  barrel (`export * as P`), a star barrel used through a namespace and destructured, a dynamic
  import of a barrel, and two wrapper modules.

### Round 3: fault injection (one site at a time, on a `git archive` copy)

Each fault was named and its failing test predicted before the run; the first failing assertion of each run is quoted below with the source line, the expected and the received value. Raw output of every run: `fi-<id>.txt` in the session scratchpad. `git archive` of the final code commit, `node_modules` symlinked, pristine file restored after each run.

```
H1-placeholder-terminal: H1: treat a non-error `<synthetic>` placeholder as the end and as text   [2 failing]
   assertion: 586 
        expect(s.ended).toBe(false);
   (fail) error: expect(received).toBe(expected) ; Expected: false ; Received: true

H2-apierror-no-failure: H2: an API error sets only `ended` (the round-2 shape), no `failure`   [4 failing]
   assertion: 249 
        expect(s.failure).toEqual({ kind: "api-error", text: "API Error: 529" });
   (fail) error: expect(received).toEqual(expected) ; - { ; -   "kind": "api-error", ; -   "text": "API Error: 529", ; - }

H2-stderr-ignored: H2/M2: ignore `<local-command-stderr>` on system entries   [2 failing]
   assertion: 320 
        expect(s.failure).toEqual({
   (fail) error: expect(received).toEqual(expected) ; - { ; -   "kind": "command-error", ; -   "text": "Error: Not enough messages to compact.", ; - }

H2-process-failure-resolves: H2: `_completeTurn` resolves instead of rejecting a failed turn   [2 failing]
   assertion: 563 
        expect(out.text).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: ""

H2-supervisor-failed-branch: H2: drop the `PtyTurnFailedError` branch in `runOnPty`   [2 failing]
   assertion: 581 
        expect(result.rawStdout).toBe("API Error: 529 overloaded");
   (fail) error: expect(received).toBe(expected) ; Expected: "API Error: 529 overloaded" ; Received: ""

H2-supervisor-apitext-dropped: H2: an api-error exits 1 but without the CLI's text as output   [1 failing]
   assertion: 581 
        expect(result.rawStdout).toBe("API Error: 529 overloaded");
   (fail) error: expect(received).toBe(expected) ; Expected: "API Error: 529 overloaded" ; Received: ""

H2-supervisor-ambiguous-text-leaks: H2: an uncertain outcome's text is put in `rawStdout`   [1 failing]
   assertion: 603 
        expect(result.rawStdout).toBe("");
   (fail) error: expect(received).toBe(expected) ; Expected: "" ; Received: "another prompt was recorded"

H2-live-no-retire-failed: H2: `sendToLiveSession` does not retire the entry after a failed turn   [2 failing]
   assertion: 518 
          expect(spawned[spawned.length - 1].disposed).toBe(true);
   (fail) error: expect(received).toBe(expected) ; Expected: true ; Received: false

M2-exception-restored: M2: restore the `replyComplete` exception in `boundaryVerdict`   [2 failing]
   assertion: 556 
        expect(result.exitCode).toBe(1);
   (fail) error: expect(received).toBe(expected) ; Expected: 1 ; Received: 0

H3-containment: H3: `includes` instead of equality   [2 failing]
   assertion: 373 
        expect(promptMatches("hourly check status and restart failures", "check status", false)).toBe(
   (fail) error: expect(received).toBe(expected) ; Expected: false ; Received: true

H3-whitespace-insensitive: H3: strip all whitespace before comparing   [1 failing]
   assertion: 381 
        expect(promptMatches("ab", "a b", false)).toBe(false);
   (fail) error: expect(received).toBe(expected) ; Expected: false ; Received: true

H3-tab-rule-dropped: H3: compare a TAB as written (drop the tab rule)   [2 failing]
   assertion: 157 
        expect(turn_.poll().accepted).toBe(true);
   (fail) error: expect(received).toBe(expected) ; Expected: true ; Received: false

H3-dup-in-window: H3: a second matching/foreign prompt inside the window is ignored   [3 failing]
   assertion: 428 
        expect(s.failure?.kind).toBe("ambiguous");
   (fail) error: expect(received).toBe(expected) ; Expected: "ambiguous" ; Received: undefined

H3-dup-after-reply: H3: a duplicate right after the reply does not downgrade it   [1 failing]
   assertion: 439 
        expect(s.failure?.kind).toBe("ambiguous");
   (fail) error: expect(received).toBe(expected) ; Expected: "ambiguous" ; Received: undefined

H3-uuid-dedupe-dropped: H3: a repeated line (same uuid) is treated as a second prompt   [1 failing]
   assertion: 453 
        expect(s.failure).toBeNull();
   (fail) error: expect(received).toBeNull() ; Received: { ; kind: "ambiguous", ; text: "the same prompt was recorded a second time inside the turn", ; }

H4-terminal-accepts-any-message: H4: the final-message phase accepts any later assistant message   [1 failing]
   assertion: 713 
        expect(s.answer).toBe("ANSWER-A");
   (fail) error: expect(received).toBe(expected) ; - "ANSWER-A" ; + "ANSWER-A ; + ; + UNRELATED-NOTIFICATION-REPLY"

H4-window-never-closes: H4: `finish()` no longer closes the window   [2 failing]
   assertion: 727 
        expect(s.answer).toBe("A");
   (fail) error: expect(received).toBe(expected) ; Expected: "A" ; Received: "ALATE"

H4-keep-ingesting-after-end: H4: both of the above (the headline A/B tests need both removed)   [6 failing]
   assertion: 627 
        expect(s.answer).toBe("ANSWER-A");
   (fail) error: expect(received).toBe(expected) ; - "ANSWER-A" ; + "ANSWER-A ; + ; + ANSWER-B"

H4-join-last-wins: H4: the answer is the last message only   [2 failing]
   assertion: 212 
        expect(s.answer).toBe("Let me look.\n\nFINAL");
   (fail) error: expect(received).toBe(expected) ; - "Let me look. ; - ; - FINAL" ; + "FINAL"

H4-terminal-without-text-ends: H4: a final line with no text ends the turn at once   [2 failing]
   assertion: 674 
        expect(s.ended).toBe(false);
   (fail) error: expect(received).toBe(expected) ; Expected: false ; Received: true

M1-no-identity-check: M1: no dev+inode comparison   [2 failing]
   assertion: 745 
        expect(() => turn_.poll()).toThrow(TranscriptReplacedError);
   (fail) error: expect(received).toThrow(expected) ; Expected constructor: TranscriptReplacedError ; Received function did not throw ; Received value: { ; accepted: false,

M1-no-shrink-check: M1: no size-below-offset check   [1 failing]
   assertion: 766 
        expect(() => turn_.poll()).toThrow(/cut short/);
   (fail) error: expect(received).toThrow(expected) ; Expected pattern: /cut short/ ; Received function did not throw ; Received value: { ; accepted: false,

M1-removed-ignored: M1: a removed file is treated as nothing new   [1 failing]
   assertion: 774 
        expect(() => turn_.poll()).toThrow(/removed/);
   (fail) error: expect(received).toThrow(expected) ; Expected pattern: /removed/ ; Received function did not throw ; Received value: { ; accepted: false,

M1-process-replaced-swallowed: M1: `_pollTurn` swallows `TranscriptReplacedError`   [1 failing]
   assertion: 581 
        expect(out.err).toBeInstanceOf(TranscriptReplacedError);
   (fail) error: expect(received).toBeInstanceOf(expected) ; Expected constructor: [class TranscriptReplacedError extends Error] ; Received value: 987 

M1-supervisor-replaced-no-retire: M1: the supervisor does not retire after `TranscriptReplacedError`   [1 failing]
   assertion: 626 
        expect(spawned[0]?.disposed).toBe(true);
   (fail) error: expect(received).toBe(expected) ; Expected: true ; Received: false

H5-clear-and-guard: H5: no clear in `_commitTurn` AND no committed-guard in the deadline callback   [2 failing]
   assertion: 472 
        expect(out.err).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: 937 

H5-clear-only: H5: no clear in `_commitTurn` (the callback guard stays)
   GREEN (no failure)  <- see 'Redundant sites' below

H5-guard-only: H5: no committed-guard in the deadline callback (the clear stays)   [1 failing]
   assertion: 493 
        expect(out.err).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: 941 

H5-deadline-poll: H5: no read in the deadline callback   [1 failing]
   assertion: 493 
        expect(out.err).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: 940 

H5-exit-committed: H5: a PTY exit rejects `PtyClosedError` even when committed   [2 failing]
   assertion: 503 
        expect(out.err).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: 846 

H5-exit-final-read: H5: no final read on exit   [1 failing]
   assertion: 518 
        expect(out.err).toBeUndefined();
   (fail) error: expect(received).toBeUndefined() ; Received: 848 

G1-no-alias-following: M3: the guard does not follow alias chains   [11 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G2-no-dynamic-import-check: M3: the guard ignores `import()` / `require()`   [2 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G3-roots-only: M3: the guard looks at the four modules only, not the graph they reach   [17 failing]
   assertion: 386 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G4-no-destructure-check: M3: the guard ignores destructuring of a namespace   [1 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G5-no-use-check: M3: the guard ignores identifier uses   [2 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G6-no-import-specifier-check: M3: the guard ignores import specifiers   [1 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G9-match-by-local-name: M3: the guard matches the local name, not the name it resolves to   [4 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G10-no-use-and-no-specifier: M3: the guard ignores both uses and import specifiers   [13 failing]
   assertion: 385 
          expect(violationsOf(files, opts).length).toBeGreaterThan(0);
   (fail) error: expect(received).toBeGreaterThan(expected) ; Expected: > 0 ; Received: 0

G7-real-code-renamed-import: M3 (real code): `import { feed as quietly }` added to pty-supervisor.ts   [1 failing]
   assertion: 226 
        expect(violations).toEqual([]);
   (fail) error: expect(received).toEqual(expected) ; - [] ; + [ ; +   { ; +     "file": "/private/tmp/claude-501/-Users-terrenceyodaiken-orca-workspaces-claudeclaw-plus-Sonnet/e154f5e4-2fcf-41b0-b6e5-48376d0cf59b/scratchpad/inj/src/runner/pty-supervisor.ts",

G8-real-code-via-barrel: M3 (real code): `import { tick as calm } from "./index"` added to pty-process.ts   [1 failing]
   assertion: 226 
        expect(violations).toEqual([]);
   (fail) error: expect(received).toEqual(expected) ; - [] ; + [ ; +   { ; +     "file": "/private/tmp/claude-501/-Users-terrenceyodaiken-orca-workspaces-claudeclaw-plus-Sonnet/e154f5e4-2fcf-41b0-b6e5-48376d0cf59b/scratchpad/inj/src/runner/pty-process.ts",

```

### Redundant sites (said plainly)

- **H5 clear vs guard.** Dropping the clear in `_commitTurn` alone stays GREEN
  (`H5-clear-only`): the deadline callback also refuses to reject a committed turn, so the
  two back each other. Dropping the guard alone is RED (`H5-guard-only`, unread-at-deadline
  test, which also needs the read in the callback, `H5-deadline-poll`). The settle test is
  RED only when both are removed (`H5-clear-and-guard`). Kept both on purpose; the clear is
  the stated mechanism and the guard is what the callback's own read needs.
- **H4 id match vs window closure.** `H4-terminal-accepts-any-message` and
  `H4-window-never-closes` each leave the headline "A, B in one poll" and "B during the
  settle" tests GREEN, because either site alone still keeps B out. Both removed together
  (`H4-keep-ingesting-after-end`) turns them RED. Each site has its own RED test too (a later
  assistant message with no prompt between; a closed window reads nothing more).
- **Guard shapes.** Several fixtures are caught by more than one path (an import specifier AND
  an identifier use). The matrix below shows every fixture goes RED under at least one
  sabotage of the guard; the namespace barrel needs both the use check and the specifier check
  removed (`G10`).

| Fixture | RED under |
|---|---|
| named import (guarded module / reached module) | G1 alias following, G10, G3 (reached) |
| aliased import | G1, G9 local-name matching, G10, G3 |
| renamed re-export through a barrel / two barrels deep | G1, G9, G10, G3 |
| namespace barrel `export * as P` | G10, G3 |
| star barrel via namespace import / dynamic import of a barrel | G5 use check, G10, G3 |
| star barrel destructured | G4 destructuring check, G3 |
| dynamic import, result unused | G2 `import()` check, G3 |
| require | G2, G3 |
| wrapper module / wrapper through a renamed barrel | G1, G3 roots-only, G9, G10 |
| helper off the allow-list in a guarded module | G1, G6 specifier check, G10 |

`G3` = "look at the four modules only, not the graph they reach": 17 of 19 fixtures go RED, which
is the whole point of the change. `G7` / `G8` put a renamed import and a barrel import into the
REAL `pty-supervisor.ts` / `pty-process.ts`: the real-graph test goes RED on both.

## Round 3: verification

- Every test file that imports the PTY runner, supervisor, transcript reader, `runOnPty` or
  `sendToLiveSession` (20 files, incl. the oneshot engine and the gateway seam): **623 pass / 0
  fail**, normally and with `CLAUDECLAW_TEST_PLATFORM=linux`. An earlier normal run of the
  13-file subset hit one failure: the #469 "a dialog that paints late gets a fresh hard-timeout
  window" test (a 5 s turn timeout under load; `_waitForReadySettle` is untouched this round;
  it passes alone, 70/70 in `pty-process.test.ts`, and in the two later full runs). It is the
  same timing-sensitive test round 2 recorded.
- `bun run lint` (full repo): 0 errors (1292 warnings, 325 infos, pre-existing).
  `bun run typecheck`: 149 errors, baseline 149.
- `env -u ANTHROPIC_BASE_URL` throughout; test output went to files; no
  `.claude/claudeclaw/paused.json` left behind.
- Nothing touched `~/.claude` or `~/.claude.json`; no real `claude`, no throwaway config dir.

## Round 3: not done / risks

1. **No real claude, again.** What only a real run can confirm: (a) the CLI records a pasted
   prompt as exactly the written text inside its `<pasted_content>` wrapper, with no change to
   internal whitespace beyond a TAB. If it normalises anything else (collapsed runs of spaces,
   re-expanded newlines), equality fails and the turn ends in `PtyPromptNotAcceptedError`
   after ~6 s. That fails LOUD and never falsely succeeds, but Nibbler's rerun is where it
   would show; (b) a final assistant message is followed by `turn_duration` or another entry,
   so a text-less final message still closes; (c) a healthy turn never has a non-meta user
   text inside its window.
2. A user typing into the live TUI mid-turn, or `[Request interrupted by user]`, now fails the
   turn as `ambiguous` instead of being folded into the answer.
3. The answer is the final message, or the last one with text when the turn ends on a tool-only message (see the decision above).
4. A duplicate of the prompt that is recorded after `runTurn` has returned is not detected.
5. M4's "executes twice" TUI is a model of a CLI that does not exist; it shows what the reader
   does if it did, not that claude does.

---

# Round 4: final Codex review of `fa2c625d..da096758` (H2 `/compact`, H3, H4, M3 open; 2 new MEDIUM; 1 LOW)

Code commit: `fc147101` (this report and the SPEC / CLAUDE.md lines are in the commit that follows it).
Binding rule unchanged: the screen never decides acceptance, completion or the answer, and
never how much of the answer is returned.

## Round 4: summary

| # | Finding | Fix | Where |
|---|---|---|---|
| 1 / H3 | delayed identical submission supplies this one's answer | a turn that ends in ANY non-ok outcome is remembered (`abandon()`, called from `_rejectTurn`) per transcript file; an identical payload that matches while one is unresolved fails `ambiguous` | `pty-transcript.ts` `unresolved`, `pty-process.ts` `_rejectTurn` |
| 2 / H4 + 3 | screen settle decides how much of the final message; text-less final hangs | ONE definition: a terminal `stop_reason` opens `terminal`; the turn ENDS at `turn_duration`, the next entry that is not a line of that message, or `TRANSCRIPT_SETTLE_MS` without file growth. Text no longer matters. | `ingestAssistant`, `ingestTerminal`, `poll` |
| 4 | literal paste tags reject a healthy prompt | compare the payload unchanged first, then strip only an OUTER wrapper | `payloadForms`, `promptMatches` |
| 5 / H2 | `/compact` assistant API error ignored | a command still processes the assistant error flags; only ordinary text is not read | `ingestAssistant` |
| 6 / M3 | element access through a namespace barrel bypasses the guard | resolve literal keys, flag unresolvable computed keys and computed destructuring on a namespace that exposes the API, flag a namespace used whole | `pty-turn-evidence-guard.test.ts` |
| 7 LOW | single-execution count predetermined | the fake keeps reading and records every executed turn on its own | `pty-false-completion.test.ts` |

## Round 4: decisions

**The end of the final message (H4 + finding 3).** `ended` is no longer set when a terminal
line is read. The turn is `terminal` until the transcript shows the message is over; the next
poll that sees `turn_duration`, a different message id, a `user` entry or any other record
closes the window (`finish()`), and the closed window is what freezes the answer. The
screen's quiet window runs only after that and can only delay the return. A final message
with no text (thinking-only, tool-only, empty) takes the same path: the answer is the last
message that has text, or empty. A message with no `id` is never "the same message" as a later
line (`finalMessageId !== undefined`).

**Markers seen in real captures and which I assumed.**
- SEEN (all of `docs/spikes/fixtures/**/*.jsonl` that contain `turn_duration`, 16 distinct
  messages in the lifecycle fixtures): every final message is ONE `text` block with
  `stop_reason: end_turn`, and a `system` / `turn_duration` entry is the very next record.
  `turn_duration` is the marker the CLI writes in interactive sessions.
- ASSUMED, not in any capture: a final message split over several lines that all carry a
  terminal `stop_reason` (the reviewer's shape; the fixtures only show single-block finals);
  a thinking-only or tool-only terminal final; a terminal reason other than `end_turn`
  (`max_tokens`, `stop_sequence`, `refusal`) followed by `turn_duration`; and that nothing can
  come between a message's lines except lines of that message.

**Transcript-side settle: `TRANSCRIPT_SETTLE_MS = 1500`.** For a CLI that writes neither
marker after a terminal line. Measured from the last growth of the file (a late block restarts
it), by the injected clock `now` (pty-process passes its `_now`), so it is transcript time,
not screen time. 1500 ms because the CLI writes the lines of one message as it streams them, so a gap this long
is far past the spacing I could measure: in the 21 end_turn -> `turn_duration` pairs in the
fixtures the marker is written 4 ms to 117 ms after the final line (median 50 ms). I could not
measure the spacing between blocks of one message, because no fixture has a multi-block final.
It stays under the 2 s ceiling and far inside every hard timeout, so a turn never
waits out the deadline. The cost: if a CLI really writes B more than 1.5 s after A with no
marker in between, the answer is A alone. That is a transcript-timing limit, stated, and the
same on a quiet and a repainting screen.

**Paste tags.** `payloadForms` yields the payload unchanged, then (only if the WHOLE payload is
one `<pasted_content …>…</pasted_content …>`) its inner text. Literal tags inside the text
survive in both forms. The match is greedy to the last closing tag, so a payload that is two
wrappers concatenated unwraps to everything between the first open and the last close; that is
not a shape the CLI writes.

**`/compact` errors.** `ingestOpen` hands every assistant record to `ingestAssistant`; for a
command it returns after the `isApiErrorMessage` / `error` check and before any text is read.

**Unresolved identical submissions (H3).** Size: about 95 lines of code and comments in
`pty-transcript.ts` plus 4 in `pty-process.ts`, so within "a small registry"; nothing was
stopped.
- `promptKey` = sha256 of the NFC-trimmed payload (a command: its name). A module-level
  `Map<transcriptPath, Map<key, entry>>`, at most 8 entries per file, entry = `{written, offset at
  mark, file identity, time}`.
- Registered by `abandon()` from `_rejectTurn`, which every non-ok outcome goes through: not
  accepted, timeout, `PtyClosedError`, replaced transcript, API error, stderr, ambiguous.
  A turn that ended OK is never registered, so a normal hourly cron sequence never touches it.
- Consulted at `mark()` (`openUnresolvedKeys`), which first drops entries that are over:
  another file (identity differs, or the file is shorter than the entry's offset), expired
  (`UNRESOLVED_TTL_MS = 120 s`), or RESOLVED. Resolved = a probe `TranscriptTurn` started at the
  entry's offset finds its record and its end (`ended` and not `ambiguous`), i.e. both are
  already in the file and so cannot arrive late. A missing file is not "another file": the late
  record may be what creates it.
- A match (the `enqueue` or the `user` record) while the key is open fails `ambiguous` at once.
- Why a TTL: a prompt that was never submitted (Ctrl-U cleared it) never gets a record; without
  an expiry every later identical prompt would fail for the life of the session. 120 s: the
  supervisor retires the process after any of these failures, so a late record can only come
  from writes already in flight when it died.
- `promptId` / `uuid` cannot be used instead: the CLI assigns them after the submit, so there
  is nothing of OURS to correlate. The registry is the available identity.
- The supervisor respawns with `--resume` on the SAME session id (same transcript path), so
  the registry outlives the process; a rotated or reset session is another path.

**Guard (M3).** Three additions, each with a negative fixture: (1) `B["literal"]` is resolved
on the value's type and judged like `B.literal`; (2) any other key on a value whose type
exposes a forbidden symbol is a violation, as is a computed destructuring pattern
(`{ [k]: f } = B`); (3) a module namespace that exposes the API and is used other than as
`B.x`, `B["x"]` or a destructuring source (cast, passed on, spread) is a violation. The real
graph stays clean.

**Fixture change.** `fakeTurn` now writes `turn_duration` after the answer, as the real CLI
does. Several older hand-written fakes still end on the final line with no marker; they pass on
the 1.5 s settle and so exercise it.

## Round 4: tests

New, all in the files they belong to:
- `pty-transcript.test.ts`: not ended before block B / A+B answer; the next foreign entry ends
  it; thinking-only and tool-only finals end on the settle (answer = last text / empty); the
  settle restarts on growth; no settle while a `tool_use` message is current; literal paste
  tags bare, inside an outer wrapper, and not equal to a stripped record; `/compact` + assistant
  API error; the unresolved registry (turn 1 late, enqueue-only, other prompt unaffected,
  already-resolved earlier turn, earlier record without its end, TTL, rotated file, four
  sequential resolved identical prompts all succeed).
- `pty-false-completion.test.ts`: quiet and repainting screens return the same answer for a late
  block B; thinking-only final ends without the hard timeout; turn 1 not accepted then turn 2
  with the identical prompt through a real PTY (`PtyTurnFailedError` `ambiguous`); the
  single-execution test rewritten (finding 7).
- `pty-turn-evidence-guard.test.ts`: six bad fixtures, one precision fixture.
- Existing tests that assumed "ended on the first terminal line" now close with `turn_duration`
  (they assert it is NOT ended before it).

## Round 4: fault injection (one site at a time, on a `git archive` copy)

Each fault was named and its failing test predicted before the run. `git archive` of `fc147101`,
`node_modules` symlinked, a fresh copy per fault. First failing assertion of each run, quoted
from the run's own output (source line, caret, expected, received). Raw output:
`inj/<id>/out.txt` in the session scratchpad. `[n fail]` is the number of failing tests of the
files named in the run.

```
I1-commit-on-first-text: H4/3: commit (`ended = true`) on the first terminal line that has text (the round-3 shape)   [5 fail]
  183 |     let s = turn_.poll();
  184 |     expect(s.answer).toBe("NEW-ANSWER");
  185 |     // The final message is out, but the transcript has not yet said it is over.
  186 |     expect(s.ended).toBe(false);
                            ^
  error: expect(received).toBe(expected)
  Expected: false
  Received: true
        at <anonymous> (src/__tests__/pty-transcript.test.ts:186:21)
  (fail) TranscriptTurn — answer and end of reply > the answer is the assistant text after the matched user entry, and the terminal stop ends it

I2-require-text: F3: a terminal message only counts as terminal when it has text   [3 fail]
  934 |     expect(turn_.poll().ended).toBe(false);
  935 |     now += 1;
  936 |     const s = turn_.poll();
  937 |     expect(s.ended).toBe(true);
                            ^
  error: expect(received).toBe(expected)
  Expected: true
  Received: false
        at <anonymous> (src/__tests__/pty-transcript.test.ts:937:21)
  (fail) TranscriptTurn — one definition of 'the final message is complete' (round 4, H4 + finding 3) > a terminal thinking-only final message with nothing after it ends the turn on the transcript settle, answering with the last message that has text

I3-no-settle: F3: remove the transcript-side settle (no marker ever closes a thinking-only final)   [11 fail]
  934 |     expect(turn_.poll().ended).toBe(false);
  935 |     now += 1;
  936 |     const s = turn_.poll();
  937 |     expect(s.ended).toBe(true);
                            ^
  error: expect(received).toBe(expected)
  Expected: true
  Received: false
        at <anonymous> (src/__tests__/pty-transcript.test.ts:937:21)
  (fail) TranscriptTurn — one definition of 'the final message is complete' (round 4, H4 + finding 3) > a terminal thinking-only final message with nothing after it ends the turn on the transcript settle, answering with the last message that has text

I4-settle-from-terminal-line: F3: the settle clock stops restarting on growth after the terminal line   [1 fail]
  970 |     appendFileSync(t.path, nl(assistantLine("B", ids("m1"))));
  971 |     expect(turn_.poll().ended).toBe(false);
  972 |     now += TRANSCRIPT_SETTLE_MS - 1;
  973 |     expect(turn_.poll().ended).toBe(false);
                                       ^
  error: expect(received).toBe(expected)
  Expected: false
  Received: true
        at <anonymous> (src/__tests__/pty-transcript.test.ts:973:32)
  (fail) TranscriptTurn — one definition of 'the final message is complete' (round 4, H4 + finding 3) > the settle runs from the last growth of the file: a late block of the final message restarts it

I5-global-paste-strip: F4: strip every paste tag from the recorded side (the round-3 shape)   [3 fail]
  155 |         ),
  156 |       ),
  157 |     );
  158 |     expect(turn_.poll().accepted).toBe(true);
                                          ^
  error: expect(received).toBe(expected)
  Expected: true
  Received: false
        at <anonymous> (src/__tests__/pty-transcript.test.ts:158:35)
  (fail) TranscriptTurn — acceptance > a prompt the CLI recorded as a paste is wrapped in pasted_content tags and still matches

I6-compact-skips-assistant: F5/H2: skip every assistant record for a REPL command, error flags included   [1 fail]
  1031 |     const turn_ = turn(t, "/compact", true);
  1032 |     appendFileSync(t.path, nl(userLine(cmd), apiErrorLine("API Error: 529 overloaded")));
  1033 |     const s = turn_.poll();
  1034 |     expect(s.ended).toBe(true);
                             ^
  error: expect(received).toBe(expected)
  Expected: true
  Received: false
        at <anonymous> (src/__tests__/pty-transcript.test.ts:1034:21)
  (fail) TranscriptTurn — /compact API errors (round 4, finding 5) > an assistant API-error record after /compact fails the turn promptly, with no local_command stderr

I7-no-registry-check: F1/H3: drop the unresolved-earlier-submission check   [4 fail]
  1072 |       nl(userLine("R17x please"), assistantLine("ANSWER-OF-TURN-1"), systemLine("turn_duration")),
  1073 |     );
  1074 |     const s = second.poll();
  1075 |     expect(s.failure?.kind).toBe("ambiguous");
                                     ^
  error: expect(received).toBe(expected)
  Expected: "ambiguous"
  Received: undefined
        at <anonymous> (src/__tests__/pty-transcript.test.ts:1075:29)
  (fail) TranscriptTurn — an earlier identical submission that is unresolved (round 4, finding 1) > turn 1 not accepted, turn 2 sends the identical prompt, turn 1's record and answer arrive: turn 2 does NOT succeed with them

I8-no-ttl: F1/H3: unresolved submissions never expire   [1 fail]
  1143 |     const s = second.poll();
  1144 |     expect(s.failure).toBeNull();
                               ^
  error: expect(received).toBeNull()
  Received: {
    kind: "ambiguous",
    text: "an earlier submission of this identical prompt in this session is unresolved: its record may be the one that arrived",
  }
        at <anonymous> (src/__tests__/pty-transcript.test.ts:1144:23)
  (fail) TranscriptTurn — an earlier identical submission that is unresolved (round 4, finding 1) > an unresolved submission expires: its record cannot still be late

I9-never-resolved: F1/H3: an unresolved submission is never resolved by its record + end being in the file   [1 fail]
  1113 |     const s = second.poll();
  1114 |     expect(s.failure).toBeNull();
                               ^
  error: expect(received).toBeNull()
  Received: {
    kind: "ambiguous",
    text: "an earlier submission of this identical prompt in this session is unresolved: its record may be the one that arrived",
  }
        at <anonymous> (src/__tests__/pty-transcript.test.ts:1114:23)
  (fail) TranscriptTurn — an earlier identical submission that is unresolved (round 4, finding 1) > an earlier submission whose record AND turn end are already in the file is resolved: the identical prompt succeeds

I10-no-abandon-call: F1/H3: `_rejectTurn` does not register the turn as unresolved   [1 fail]
  715 |       const second = await proc.runTurn(PROMPT, { timeoutMs: 5000 }).then(
  716 |         (r) => ({ text: r.text }),
  717 |         (e: unknown) => ({ err: e }),
  718 |       );
  719 |       expect((second as { text?: string }).text).toBeUndefined();
                                                         ^
  error: expect(received).toBeUndefined()
  Received: "ANSWER-OF-TURN-1"
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:719:50)
  (fail) #562 round 4 — an earlier identical submission that was not accepted > turn 1 is not accepted, turn 2 sends the identical prompt, turn 1's record and answer then arrive: turn 2 is NOT a success

I12-resubmit-on-retry: F7: the submit retry writes the whole prompt again instead of a bare CR   [2 fail]
  405 |         .filter((x, i, a) => i < a.length - 1);
  406 |       // One paste (the prompt text, once) and exactly one bare CR. Fault: a retry that
  407 |       // re-writes the prompt makes the text appear twice.
  408 |       expect(lines.filter((x) => x.includes(PROMPT)).length).toBe(1);
                                                                     ^
  error: expect(received).toBe(expected)
  Expected: 1
  Received: 2
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:408:62)
  (fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission

G1-no-element-access-branch: F6/M3: the guard ignores element access   [3 fail]
  470 |   ];
  471 |   for (const [label, files, opts] of bad) {
  472 |     test(`flags ${label}`, () => {
  473 |       expect(violationsOf(files, opts).length).toBeGreaterThan(0);
                                                       ^
  error: expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received: 0
        at <anonymous> (src/__tests__/pty-turn-evidence-guard.test.ts:473:48)
  (fail) the guard itself can fail > flags element access through a star-barrel namespace import

G2-no-computed-branch: F6/M3: the guard does not flag an unresolvable computed key   [1 fail]
  470 |   ];
  471 |   for (const [label, files, opts] of bad) {
  472 |     test(`flags ${label}`, () => {
  473 |       expect(violationsOf(files, opts).length).toBeGreaterThan(0);
                                                       ^
  error: expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received: 0
        at <anonymous> (src/__tests__/pty-turn-evidence-guard.test.ts:473:48)
  (fail) the guard itself can fail > flags a key built at run time on a star-barrel namespace

G3-no-whole-namespace-rule: F6/M3: the guard does not flag a namespace used whole (cast, passed on)   [1 fail]
  471 |   ];
  472 |   for (const [label, files, opts] of bad) {
  473 |     test(`flags ${label}`, () => {
  474 |       expect(violationsOf(files, opts).length).toBeGreaterThan(0);
                                                       ^
  error: expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received: 0
        at <anonymous> (src/__tests__/pty-turn-evidence-guard.test.ts:474:48)
  (fail) the guard itself can fail > flags an unresolvable computed access on a namespace that exposes the parser's API

G4-no-computed-destructure: F6/M3: the guard ignores computed destructuring `{ [k]: f } = B`   [1 fail]
  470 |   ];
  471 |   for (const [label, files, opts] of bad) {
  472 |     test(`flags ${label}`, () => {
  473 |       expect(violationsOf(files, opts).length).toBeGreaterThan(0);
                                                       ^
  error: expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received: 0
        at <anonymous> (src/__tests__/pty-turn-evidence-guard.test.ts:473:48)
  (fail) the guard itself can fail > flags computed destructuring of a namespace that exposes the parser's API

G5-literal-key-unresolved: F6/M3: a literal key is not resolved to its member (every key is treated as computed)   [1 fail]
  +   {
  +     "file": "/var/folders/hj/x3pkkchs389fhmt3hyyn5gkc0000gn/T/pty-guard-TYHETt/mid.ts",
  +     "line": 5,
  +     "what": "computed access on a value that exposes the parser's completion API",
  +   },
  + ]
  - Expected  - 1
  + Received  + 12
        at <anonymous> (src/__tests__/pty-turn-evidence-guard.test.ts:502:7)
  (fail) the guard itself can fail > element access that names a harmless member, or on a value that exposes nothing forbidden, is not a violation
```

PTY level (a real `/bin/sh` child on a real PTY, same faults):

```
I1-commit-on-first-text (PTY level):
  663 |     );
  664 |     expect(quietOut.err).toBeUndefined();
  665 |     expect(noisyOut.err).toBeUndefined();
  666 |     expect(quietOut.text).toBe("A-BLOCK B-BLOCK");
                                  ^
  error: expect(received).toBe(expected)
  Expected: "A-BLOCK B-BLOCK"
  Received: "A-BLOCK "
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:666:27)
  (fail) #562 round 4 — the transcript alone decides how much of the answer, and when the turn ends > a quiet screen and a repainting screen return the SAME answer for a final message whose block B arrives late

I2-require-text (PTY level):
  952 |           if (!this._turnInProgress || this._endedAt !== 0) return;
  953 |           const elapsed = this._now() - this._turnStartedAt;
  954 |           this._rejectTurn(new PtyTurnTimeoutError(this.label, elapsed));
                                   ^
  PtyTurnTimeoutError: PTY turn timed out for test:89863 after 4002ms
       label: "test:89863",
   elapsedMs: 4002,
        at <anonymous> (src/runner/pty-process.ts:954:28)
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:686:21)
  (fail) #562 round 4 — the transcript alone decides how much of the answer, and when the turn ends > a terminal thinking-only final message with no record after it ends the turn: no hard-timeout wait, no replay

I7-no-registry-check (PTY level):
  715 |       const second = await proc.runTurn(PROMPT, { timeoutMs: 5000 }).then(
  716 |         (r) => ({ text: r.text }),
  717 |         (e: unknown) => ({ err: e }),
  718 |       );
  719 |       expect((second as { text?: string }).text).toBeUndefined();
                                                         ^
  error: expect(received).toBeUndefined()
  Received: "ANSWER-OF-TURN-1"
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:719:50)
  (fail) #562 round 4 — an earlier identical submission that was not accepted > turn 1 is not accepted, turn 2 sends the identical prompt, turn 1's record and answer then arrive: turn 2 is NOT a success

I10-no-abandon-call (PTY level):
  715 |       const second = await proc.runTurn(PROMPT, { timeoutMs: 5000 }).then(
  716 |         (r) => ({ text: r.text }),
  717 |         (e: unknown) => ({ err: e }),
  718 |       );
  719 |       expect((second as { text?: string }).text).toBeUndefined();
                                                         ^
  error: expect(received).toBeUndefined()
  Received: "ANSWER-OF-TURN-1"
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:719:50)
  (fail) #562 round 4 — an earlier identical submission that was not accepted > turn 1 is not accepted, turn 2 sends the identical prompt, turn 1's record and answer then arrive: turn 2 is NOT a success

I12-resubmit-on-retry (PTY level):
  609 |     // Count what the CLI executed, not what we wrote. Fault: a retry that resubmits the
  610 |     // prompt makes the fake run it a second time and this is 2 (the first assertion on
  611 |     // purpose: it must be the count that goes red, not the outcome after it).
  612 |     expect(userEntries(t.path)).toBe(1);
                                        ^
  error: expect(received).toBe(expected)
  Expected: 1
  Received: 2
        at <anonymous> (src/__tests__/pty-false-completion.test.ts:612:33)
  (fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > accepted at once, the record flushes late: ONE executed turn, one reply
```

Two things the runs showed that were not predicted:
- `G1` (guard ignores element access) did not turn the `export * as P` fixture red: `P["feed"]`
  is already caught by the older "uses the parser module's namespace" rule. The star-barrel and
  dynamic-import fixtures carry that rule.
- `I3` (no settle) turned 11 tests red, not 3: eight older tests end on the final line with no
  marker and depend on the settle. They are covered by it, not written for it.
- The first `I4` was a bad injection (dropping the clock update made the settle fire at once, 7
  red); it was redone as the stated fault (the clock stops restarting after the terminal line).

## Round 4: verification

- 86 test files that mention the PTY runner, supervisor, transcript reader, `runOnPty`,
  `sendToLiveSession` or the gateway (everything under `src/__tests__` and `tests/` with `pty`,
  `live-session` or `gateway` in it, minus `tests/integration/*`, which needs a real claude):
  **1875 pass / 0 fail**, normally and with `CLAUDECLAW_TEST_PLATFORM=linux`.
- `bun run lint` (full repo): exit 0 (1292 warnings, 325 infos, pre-existing).
  `bun run typecheck`: 149 errors, baseline 149.
- `env -u ANTHROPIC_BASE_URL` throughout; test output went to files, never a pipe;
  `.claude/claudeclaw/paused.json` was left by a run and deleted.
- Nothing touched `~/.claude` or `~/.claude.json`; no real `claude`, no throwaway config dir.

## Round 4: not done / risks

1. **No real claude.** Still unconfirmed against a live CLI: (a) a multi-block final message is
   written as several lines of one id, all in a row; (b) `turn_duration` follows a thinking-only
   or tool-only terminal message; (c) a terminal reason other than `end_turn` is followed by it.
   If (a) is wrong in the direction of a long gap, the settle returns A alone.
2. **The settle adds up to 1.5 s** to a turn whose CLI writes no `turn_duration`. Captured CLIs
   do write it, so this is the backstop, not the common path.
3. **The unresolved registry is process-memory.** A restart of the daemon forgets it; the
   transcript offsets would be stale anyway. A record that arrives later than 120 s after a
   failed identical submission is not caught.
4. An identical prompt can now fail `ambiguous` once after a non-ok turn, while the earlier
   submission is still open (up to 120 s or until its record and end are in the file). It fails
   loud and the supervisor retires the process; it never succeeds with the wrong answer.
5. A namespace laundered through something the checker cannot type (`Reflect.get(B, name)` on an
   `any`-typed alias of it) is not seen by the guard; the three rules above close the forms
   Codex named and their direct variants, not every possible indirection.
6. A turn that ends with an empty answer (a terminal text-less message and no earlier text) now
   resolves as success with `""`. The brief asks for that. I did not check how each caller
   (runner, cron, gateway) treats an empty reply.

# Round 5: Codex review of `2066150c` (5 HIGH, 1 MEDIUM, 1 LOW) and the operator rulings

Binding rule unchanged: the screen never decides acceptance, completion or the answer. The
rulings below supersede round 4's design where they conflict (the settle and the registry are
gone).

## Round 5: summary

| # | Finding | Ruling | Where |
|---|---|---|---|
| 1 HIGH | the 1.5 s inactivity settle commits a partial answer | a turn ends only at an authoritative boundary: `turn_duration`, or the next real user prompt. `TRANSCRIPT_SETTLE_MS`, the `now` / `settleMs` options and `lastGrowthAt` are deleted. No boundary by the timeout: `PtyTranscriptUncertainError` (no answer, no replay) | `pty-transcript.ts` `ingestInTurn` / `finish`, `pty-process.ts` hard timeout |
| 2 HIGH | any other record closes the final message; a following API error is a success | error records are read first (`ingestAssistant`, `ingestUserInTurn`, `ingestSystem`), in the `open` and the `terminal` phase alike; progress, hook, attachment, snapshot and other system records are bookkeeping: they neither close nor cut the message, and later lines of the same id still extend it | `pty-transcript.ts` |
| 3, 4, 5 HIGH, 7 LOW | the unresolved registry (TTL, eviction, restart, text-keyed resolution, TAB-narrower key, unbounded outer map) | the registry is deleted whole: `UNRESOLVED_TTL_MS`, the 8-entry cap, the outer map, `submissionResolved`, the hash key, `abandon()` and its caller, the probe. Kill-and-resume replaces it | `pty-supervisor.ts` `runTurnWithRetries`, `sendToLiveSession`, `retireEntry` |
| 6 MEDIUM | an empty reply is a silent success on the gateway Telegram path, pending resumes and cron | an answer that is empty after trim fails the turn with `empty reply in transcript` (`TurnFailure.kind` `empty-reply`), so every caller gets exit 1. `/compact`'s own output is exempt | `pty-transcript.ts` `finish` |

## Round 5: decisions

**Boundary (findings 1 + 2).** A terminal `stop_reason` still opens the `terminal` phase, but
nothing but these ends it: `system` `turn_duration`; the next top-level `user` entry that is not
meta, not a compact summary, not a tool result, not a sub-agent line, not the matched record
repeated and not a command's own `<local-command-stdout>`. A user entry that IS this prompt is
`ambiguous`, as before. Two choices the ruling did not spell out:
- An assistant line with a DIFFERENT message id after the final message (a background-task
  notification starting a reply of its own, round 3) is ignored: not appended, and not a
  boundary. The turn keeps waiting for one. Treating it as a boundary would be a rule the
  ruling removed ("any other record"); appending it would give the notification's text to this
  turn.
- `turn_duration` while still `open` (no terminal message seen) also ends the turn, as before.
  With no assistant text at all that is now an `empty-reply` failure.

The reader has no clock any more. `state()` gains `finalSeen` (the `terminal` phase). At the
hard timeout `pty-process.ts` raises `PtyTranscriptUncertainError` when `finalSeen`, and
`PtyTurnTimeoutError` otherwise. They are different outcomes: a turn still running versus a
reply that ended without proof it is complete.

**Kill-and-resume (findings 3, 4, 5, 7).** The existing removal primitive, `retireEntry`, is the
mechanism; no second one was added. It disposes `entry.pty` (or joins `entry.disposing`),
releases the MCP identity, and takes the entry out of the map, with `retiring` set before the
first await. `runTurnWithRetries` and `sendToLiveSession` now call it for every turn that is
not a proven OK and AWAIT it before returning the error:
- retried: only a `PtyClosedError` whose prompt was never written (`promptSent` false, the
  process was already gone). Nothing ran, so a replay cannot double anything.
- everything else, including `PtyTurnTimeoutError` (exit 124 still), `PtyTranscriptUncertainError`,
  `PtyPromptNotAcceptedError`, `PtyTurnFailedError` (incl. `empty-reply`), `TranscriptReplacedError`,
  a `PtyClosedError` raised after the prompt went out (`promptSent` true: the exit handler and
  `dispose()` mid-turn set it) and any unknown error: retire, await, return. Only
  `PtyTranscriptUnavailableError` skips the retire (refused before anything was written).
- The next call on the key finds the entry gone, `admitEntry` waits on `retiring` if it is
  still in progress, then `spawnEntry` builds new options from the STORED session id
  (persisted at the first spawn), so `--resume <same id>`; a first-ever spawn that never
  completed a turn still resumes the pre-allocated id if its transcript exists
  (`_isSessionResumable`), which is the existing phantom-session guard.
- Why it closes 3 to 5, 7: the only writer that could append a late record for the failed
  turn is dead before any later turn marks its offset, so the exact payload match is safe
  without per-submission ids. There is no state to expire, evict, lose on restart, mis-resolve
  by text equality or leak (finding 7).

**`dispose()` really waits.** `PtyProcessImpl.dispose` sends `kill`, arms a SIGKILL timer for
2 s and `await`s the PTY's `onExit`. Finding: bun-pty ignores the signal argument (`kill(signal
= "SIGTERM")` calls `bun_pty_kill(handle)`), and a shell that traps TERM / HUP / INT died within
~6 ms, so the kill is effectively immediate and the 2 s SIGKILL is only a backstop. The wait is
the `onExit` event. I could not make a real process exit late, so the `await exited` itself is
not separately testable at the process level (see injection `R2g`, which survives); the
supervisor-level tests use a fake PTY whose `dispose()` resolves on a gate, and those do pin
the ordering (`R2a`, `R2h`).

**Orphans after a daemon crash.** `grep -i orphan` in `pty-supervisor.ts` finds only comments
about its own double-spawn guard. Nothing in `src/commands/start.ts`, `src/pid.ts` or
`src/commands/shutdown-sequence.ts` reaps claude processes left by an earlier daemon, and the
"orphan scan" in `bus/runtime-mount.ts` is `detectOrphanAgents`, which looks for agent
directories with no config, not processes. A graceful shutdown retires every entry
(`shutdownSupervisor`). After a hard crash (SIGKILL, power loss) an old claude could still be
alive and, if it has a pending write, append a late record to the session file the new daemon
then resumes. Whether the PTY master closing on parent death hangs it up is not verified
against the real CLI. **Residual, not built this round**: an orphan reaper (kill any claude
whose cwd and session id match a session about to be resumed) would close it.

**Empty reply (finding 6).** Done in the reader, not per caller, so there is no delivery policy
to keep in step across the runner, cron, Telegram direct and gateway, Discord and the pending
resumes: they all see exit 1 and the supervisor's stderr. The failure also takes the
kill-and-resume path. Not changed: a turn whose FINAL message has no text but an EARLIER message
in the turn has text still answers with the earlier text (round 4 decision, not revisited).

## Round 5: tests

- `pty-transcript.test.ts`: block B arriving 5 s later (`setSystemTime`) is included and the
  quiet file does not end the turn; `finalSeen`; progress / hook / attachment / snapshot /
  `queue-operation` / non-boundary system records between blocks; meta, tool-result,
  compact-summary and sidechain user entries are not the next prompt; the next real prompt is a
  boundary; API error after the final text, with the final's id, and a stderr line after it all
  fail; empty reply (tool-only, whitespace, no assistant at all, earlier text kept, `/compact`
  exempt). The registry and settle tests are removed.
- `pty-false-completion.test.ts` (real `/bin/sh` fakes through `spawnPty`): block B 1.8 s later;
  `PtyTranscriptUncertainError` at the timeout; plain timeout when no final message; API error
  before `turn_duration`; empty reply; a process stopped by `dispose()` writes nothing more;
  turn 1 not accepted, process stopped, a new process on the same transcript answers with its
  own reply and never turn 1's late one (the old fake would have written 0.8 s in). The round 4
  registry test is removed. Hand-written fakes now write `turn_duration`.
- `pty-supervisor.test.ts`: six non-ok outcomes each run once, dispose, and are not replayed
  (timeout stays 124); the error comes back only after a gated `dispose()` resolves; a second call
  issued while the first process is still being stopped does not spawn until the exit and
  resumes the same session id (`newSessionId` on spawn 1, `sessionId` on spawn 2); a turn refused
  before the write has nothing to kill; a `PtyClosedError` before the prompt went out is still
  retried; and two end-to-end tests through the real process and reader (empty reply = exit 1,
  final message with no boundary = exit 1 not 124).
- `pty-integration.test.ts`: the old "timeout is retryable" test now asserts exit 124, one spawn,
  and a new process on the next call.
- `fixtures/paste-burst-tui.ts` writes `turn_duration`.

## Round 5: fault injection (one site at a time, on a copy of the tree)

Method: the tracked files copied to a scratch directory (`node_modules` linked), one edit to
one production file, the named test files run, output to a file, the file restored. The lines
below are the `(fail)` lines the runs printed, verbatim. `pty-supervisor model + provider env
threading ... non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset` fails at HEAD
without my change (baseline, environment); it appears in every run that includes
`pty-supervisor.test.ts` and is not a result of the injection. Where a line is a timing test that
is red for unrelated reasons under load (`invariant 2: ...`, `accepted at once, the record
flushes late`), it is shown anyway and called out below.

Faults, in the order of the rulings: R1a settle reinstated; R1b a bookkeeping record closes the
window; R1c API error after the final ignored; R1d terminal `stop_reason` ends the turn; R1e
next prompt is not a boundary; R1f meta user entry is a boundary; R1g no uncertain error;
R2a retirement not awaited; R2b no retirement on uncertain; R2c resume with a new session id;
R2d timeout retried; R2e post-send close retried; R2f dispose does not kill; R2g dispose does
not await the exit; R2h `retireEntry` does not await the disposal; R3a empty accepted;
R3b `/compact` held to the empty rule.

```
## R1b any bookkeeping record after the final message closes the window: exit=1 77 pass 1 fail
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > progress, hook, attachment and snapshot records between the blocks neither close nor cut the final message [38.44ms]

## R1e the next real user prompt is not a boundary: exit=1 75 pass 3 fail
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > A prompt, A answer, B prompt, B answer in ONE poll: the result is A's [10.56ms]
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > B arriving AFTER the poll that saw A's end cannot change the result [6.32ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > the next real user prompt is a boundary: the turn ends and that prompt's reply is never read [3.59ms]

## R1f meta user entries count as the next prompt: exit=1 76 pass 2 fail
(fail) TranscriptTurn — a second identical prompt is uncertain, never a success (round 3, H3) > meta entries and tool results inside the turn are the turn's own [3.18ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > meta entries, tool results, compact summaries and sub-agent lines after the final message are not the next prompt [8.54ms]

## R3b /compact is held to the empty-reply rule too: exit=1 74 pass 4 fail
(fail) TranscriptTurn — /compact > accepted by the command entry, ended by compact_boundary [131.33ms]
(fail) TranscriptTurn — failure is not success (round 3, H2) > a command's own stdout, recorded as a user entry, is not another prompt [30.16ms]
(fail) TranscriptTurn — an empty reply is a failure (round 5, MEDIUM) > /compact with an empty completion marker is still a success: its result is its own output [1.19ms]
(fail) TranscriptTurn — /compact API errors (round 4, finding 5) > a command's ordinary assistant text is still not its answer [3.20ms]

## R1a quiet-file settle reinstated (1.5 s without growth ends a terminal turn): exit=1 119 pass 5 fail
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > block B of the final message arriving 5 s after block A is in the answer: a quiet file is not an end [16.73ms]
(fail) #562 — acceptance does not depend on the screen painting anything > a fast turn that paints NO running chrome is accepted, once, and not re-submitted [1027.02ms]
(fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission [496.50ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > a TUI that would execute twice on the retry Enter: two executions, and the turn is NOT a success [603.89ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > block B arriving 1.8 s after block A, past the old 1.5 s settle, is in the answer [1730.91ms]

## R1c API error after the final message is ignored (error flags read after the terminal check): exit=1 121 pass 3 fail
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > an API error after the final text and before turn_duration fails the turn, with no answer [10.19ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > an API error that reuses the final message's id is still an error, not a block of it [3.11ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > an API error after the final text, before turn_duration, rejects as api-error [179.86ms]

## R1d the terminal stop_reason itself ends the turn (no boundary needed): exit=1 106 pass 18 fail
(fail) TranscriptTurn — answer and end of reply > the answer is the assistant text after the matched user entry, and the terminal stop ends it [3.95ms]
(fail) TranscriptTurn — a second identical prompt is uncertain, never a success (round 3, H3) > the same prompt appended right after the reply (before the boundary) downgrades it to ambiguous [6.00ms]
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > a final message written as a thinking line first still gets its text line [4.37ms]
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > a final message with no text at all ends when the next entry closes the window [3.16ms]
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > a later assistant message with NO prompt between is not this turn's: the turn still ends only at its boundary [2.82ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > block B of the final message arriving 5 s after block A is in the answer: a quiet file is not an end [3.40ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > a final message with no boundary never ends: finalSeen says so, there is no success [2.15ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > progress, hook, attachment and snapshot records between the blocks neither close nor cut the final message [2.38ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > meta entries, tool results, compact summaries and sub-agent lines after the final message are not the next prompt [1.75ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > an API error after the final text and before turn_duration fails the turn, with no answer [2.90ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > an API error that reuses the final message's id is still an error, not a block of it [1.82ms]
(fail) TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2) > a command's stderr after the final message fails the turn too [1.34ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > accepted at once, the record flushes late: ONE executed turn, one reply [1090.45ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > a TUI that would execute twice on the retry Enter: two executions, and the turn is NOT a success [998.71ms]
(fail) #562 round 4 — the transcript alone decides how much of the answer, and when the turn ends > a quiet screen and a repainting screen return the SAME answer for a final message whose block B arrives late [876.26ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > block B arriving 1.8 s after block A, past the old 1.5 s settle, is in the answer [209.87ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > a final message and no boundary by the timeout: PtyTranscriptUncertainError, no answer [157.96ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > an API error after the final text, before turn_duration, rejects as api-error [298.59ms]

## R1g no uncertain error: a final message with no boundary times out as a plain timeout: exit=1 138 pass 7 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [14.07ms]
(fail) #562 round 5 — through the supervisor, with the real process and transcript reader > a final message with no boundary is exit 1 (not 124), no output, and the process is stopped [1262.72ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 2: a retirement joins a failed spawn's identity release, so the replacement's config is not deleted under it [5080.97ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 2: a spawn that fails after its entry was retired does not release the replacement's identity [279.56ms]
(fail) #562 round 3 — once the transcript commits the outcome, nothing the screen does changes it > the deadline passing with the reply already in the file, unread, is not a timeout [403.37ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > a TUI that would execute twice on the retry Enter: two executions, and the turn is NOT a success [466.42ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > a final message and no boundary by the timeout: PtyTranscriptUncertainError, no answer [1364.36ms]

## R2a retirement not awaited (void retireEntry) before the error is returned: exit=1 97 pass 2 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [5.35ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > the error is returned only AFTER the old process has exited [5073.93ms]

## R2b no retirement for an uncertain turn: exit=1 94 pass 5 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [7.07ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > uncertain (final message, no boundary): one turn, no replay, the process disposed, exit 1 [3.70ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > the error is returned only AFTER the old process has exited [5063.73ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > a new process is not spawned until the old one has exited, and it resumes the SAME session id [214.82ms]
(fail) #562 round 5 — through the supervisor, with the real process and transcript reader > a final message with no boundary is exit 1 (not 124), no output, and the process is stopped [1278.68ms]

## R2c resume with a new session id (stored id dropped on spawn): exit=1 94 pass 5 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [6.39ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > a new process is not spawned until the old one has exited, and it resumes the SAME session id [135.72ms]
(fail) pty-supervisor fresh-session persistence (Codex Phase D #2) > simulated daemon restart: persisted UUID is used as --resume on next runOnPty [67.14ms]
(fail) pty-supervisor fresh-session persistence (Codex Phase D #2) > does not pre-allocate when stored sessionId exists [46.98ms]
(fail) pty-supervisor fresh-session persistence (Codex Phase D #2) > issue #89: a resumable stored sessionId is honoured (no regression) [49.36ms]

## R2d timeout is retried and replayed again: exit=1 101 pass 6 fail
(fail) PTY integration — crash + retry (synthetic) > PtyTurnTimeoutError is NOT retried: 124, the process is stopped, the next call spawns a new one (#562 round 5) [2.52ms]
(fail) pty-supervisor retry and backoff > does NOT retry a PtyTurnTimeoutError: 124, one turn, the process stopped (#562 round 5) [4.07ms]
(fail) pty-supervisor retry and backoff > a final turn timeout returns 124 and retires the entry, so the next call respawns [4.66ms]
(fail) pty-supervisor retry and backoff > retry false permits exactly one turn and no respawn despite global retry settings [1.71ms]
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [6.02ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > timeout: one turn, no replay, the process disposed, exit 124 [7.26ms]

## R2e a process that closed after the prompt went out is retried and replayed: exit=1 97 pass 2 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [2.92ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > closed after the prompt went out: one turn, no replay, the process disposed, exit 1 [1.98ms]

## R2f dispose() does not stop the process: exit=1 42 pass 4 fail
(fail) #562 — a turn is over only when the transcript says so > resumed session: thirty old turns repainted are neither the answer nor mistaken for completion [5001.57ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > accepted at once, the record flushes late: ONE executed turn, one reply [2532.76ms]
(fail) #562 round 4 — the transcript alone decides how much of the answer, and when the turn ends > a quiet screen and a repainting screen return the SAME answer for a final message whose block B arrives late [5017.40ms]
(fail) #562 round 5 — a stopped process cannot write a late record > turn 1 not accepted, process stopped, a new process on the same transcript: turn 2 answers with its OWN reply, never turn 1's late one [3381.06ms]

## R3a an empty reply is treated as OK: exit=1 214 pass 9 fail
(fail) TranscriptTurn — an empty reply is a failure (round 5, MEDIUM) > a turn whose only message is tool-only fails with the fixed text, and has no answer [12.14ms]
(fail) TranscriptTurn — an empty reply is a failure (round 5, MEDIUM) > a whitespace-only reply is empty [2.88ms]
(fail) TranscriptTurn — an empty reply is a failure (round 5, MEDIUM) > a turn_duration with no assistant message at all is empty too [2.56ms]
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [8.42ms]
(fail) #562 round 5 — through the supervisor, with the real process and transcript reader > an empty reply is exit 1 on the supervisor result, with no output, and the process is stopped [431.29ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 2: a retirement joins a failed spawn's identity release, so the replacement's config is not deleted under it [5073.84ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 2: a spawn that fails after its entry was retired does not release the replacement's identity [105.93ms]
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > accepted at once, the record flushes late: ONE executed turn, one reply [443.25ms]
(fail) #562 round 5 — a turn ends only at an authoritative boundary > a reply with no text rejects as an empty-reply failure [160.37ms]

## R2g dispose() does not wait for the process exit: exit=1 45 pass 1 fail
(fail) #562 round 3 — executions, not bytes: a late transcript record is one turn > accepted at once, the record flushes late: ONE executed turn, one reply [659.76ms]

## R2h retireEntry does not wait for the PTY disposal: exit=1 92 pass 7 fail
(fail) pty-supervisor model + provider env threading (Codex Phase D #1) > non-glm model with no api leaves ANTHROPIC_AUTH_TOKEN unset [12.22ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > the error is returned only AFTER the old process has exited [63.08ms]
(fail) #562 round 5 — a turn that is not a proven OK kills the process and resumes the session > a new process is not spawned until the old one has exited, and it resumes the SAME session id [125.58ms]
(fail) pty-supervisor bounded respawn (issue #385) > a retirement racing a respawn's dispose of the dead PTY waits for that dispose [1028.21ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 7: an admission that was evicting a neighbour while the supervisor shut down does not create an entry the shutdown never saw [86.90ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 7: an admission queued on the global lock behind an eviction the shutdown joined is refused after the shutdown returned [74.48ms]
(fail) pty-supervisor retirement — the map's invariants (issue #394) > invariant 2: a retirement joins a failed spawn's identity release, so the replacement's config is not deleted under it [5350.69ms]

```

Notes on what the runs showed:
- Every injection except `R2g` turned at least one test of its own red.
- `R2g` (drop `await exited` in `dispose()`) is a SURVIVOR at the process level: the only red
  line is the unrelated load-sensitive timing test. bun-pty's kill is immediate, so a real
  process is gone before the next statement and no observable difference exists. The ordering is
  pinned one level up (`R2a`, `R2h`), with a fake whose `dispose()` is gated.
- `R2f` (dispose does not kill) is not caught by "once dispose() has returned, nothing reaches
  the file": the 2 s SIGKILL backstop kills the process anyway and that test has a 10 s budget.
  It is caught by the test where the first process would write 0.8 s in.
- `R2c` (resume dropped) also turned red three older session-persistence tests that assert the
  same `--resume` behaviour; the new one is among the red lines.
- `R1g` and `R3a` list `invariant 2: a retirement joins a failed spawn's identity release` and
  `accepted at once, the record flushes late`. Both are timing-sensitive and went red only in
  runs that executed several test files back to back; each passes alone, and neither mentions
  the injected fault.

## Round 5: verification

- PTY / runner / live-session / gateway / one-shot test files (list built by `find ... | rg
  'pty|live-session|gateway'`, minus `tests/integration`, plus `src/oneshot/engine.test.ts`):
  34 files, run file by file with up to 3 attempts each (the machine ran at load average ~55, and
  several timing tests in these files flake under that load at HEAD too).
  - normal: **914 pass / 0 fail** (every file green on its first attempt).
  - `CLAUDECLAW_TEST_PLATFORM=linux`: **913 pass / 1 fail**. The one red is `PtyProcess - project
    MCP server approval dialog (#469) > a dialog that paints late gets a fresh hard-timeout
    window...` in `pty-process.test.ts`, red in 3 of 3 attempts inside the gate run, then green in
    2 of 3 standalone reruns on this tree, and red at the untouched round-4 HEAD in 2 of 5 runs
    (normal platform). It exercises the boot-screen settle, which round 5 did not touch. I call
    it a load-sensitive flake, not a regression, but it is a red I did not make green.
    `pty-false-completion.test.ts` (`accepted at once, the record flushes late`) and
    `pty-supervisor.test.ts` (`invariant 2`) each needed a second attempt under linux; both are
    timing tests, and the first was loosened in this round (record delay 0.5 s, confirm 300 ms).
- `bun run lint` (full repo) exit 0; `bun run typecheck`: 149 errors, baseline 149.
- The ANTHROPIC_BASE_URL variable was unset for the runs; test output went to files, never a pipe.
- Nothing touched `~/.claude` or `~/.claude.json`; no real `claude`.

## Round 5: not done / risks

1. **Orphan claude after a daemon crash** (above). Not reaped; residual.
2. **No real claude.** Still unconfirmed against a live CLI: (a) `turn_duration` follows EVERY
   terminal message (including thinking-only, tool-only and a terminal reason other than
   `end_turn`) on 2.1.296; if it does not, such a turn now ends `PtyTranscriptUncertainError`
   at the timeout instead of returning after 1.5 s; (b) a multi-block final message is written
   as several lines of one id; (c) a background-notification reply after the final message
   uses another message id.
3. **A turn that really did finish but whose `turn_duration` never comes** is an error and a
   process kill, not a success. That is the ruling; the cost is one lost reply and one
   respawn-and-resume.
4. **A `PtyClosedError` before the prompt was written is still replayed** (up to `maxRetries`).
   That is the one retry left. The prompt was never sent, so nothing can run twice.
5. **`sendToLiveSession` and an abort.** `LiveSendAborted` still returns without retiring (the
   caller's abort path owns that, as before); I did not change it.
6. `dispose()` has no bound on the wait for the exit event. If the OS never delivers it the
   retire hangs. It never did in any run; unchanged.

---

# Round 6: Codex review of `e42e67a3` (1 HIGH, 2 MEDIUM, 1 LOW)

Input: the Codex round-5 review (`codex-562r5-review.md`). Worktree `Sonnet`, branch
`feat/550-pty-default`. Round-5 rulings stay in force (boundary-only turn end, kill-and-resume
on every non-OK turn, empty = failure, no retry or replay after the prompt was sent).

## Fix 1 (HIGH): an abort after the send now retires the entry and waits for the exit

Cause: `sendToLiveSession` returned at once on `LiveSendAborted`; the abandoned turn's rejection
handler only released the lock. The live writer survived and could feed delayed records to the next
identical prompt (Codex probe: disposals 0, entry retained).

Change (`pty-supervisor.ts`, `sendToLiveSession`):

- An `abort` listener is installed synchronously right after `runTurn` is called (no await
  between), so the entry is retiring before the abandoned turn can settle. It starts
  `retireEntry(entry)`; the `LiveSendAborted` branch AWAITS it before returning `aborted`.
- The lock is released only after that retirement finished: the release chain is
  `persisted -> abortRetirement -> release`, so an abandoned turn that rejects first does not free
  the lock while the process is still exiting.
- An abort before anything was written is unchanged (nothing to kill). One gap closed: a signal
  that fired while queued on the lock, between the wait and the write, is now re-checked under the
  lock and returns `aborted before send` without writing.

### Early-return audit (any return after the send that does not retire and await)

`sendToLiveSession`:

1. loop-top `signal.aborted` (`aborted before send`): before any write. Fine.
2. `not-live` (`no-entry`, `ephemeral`, `no-process`): no write. Fine.
3. `gaveUp` waiting on `entry.retiring` or `entry.spawnInFlight`: no write. Fine.
4. `gaveUp("the running turn to end")` (timeout or abort while queued behind another turn): no write
   by us, and the entry belongs to the OTHER turn, so it must NOT be retired. Pinned by a new test.
5. re-check under the lock (`!isCurrentEntry`, ...): `release(); continue`. No write. Fine.
6. new: abort re-check under the lock: `release()` then return. No write. Fine.
7. `runTurn` throwing synchronously: `runTurn` returns rejected promises for every pre-write
   refusal (disposed, dead, concurrent, no transcript) and does not throw before the write
   (`preparePtyPromptForWrite` has no `throw`). Fine.
8. `boundaryVerdict(result) === "failed"`: `await retireEntry`. Already correct.
9. generic `catch` (timeout, uncertain, not accepted, failed, replaced, closed): `await retireEntry`.
   Already correct. Note: it also retires on `PtyTranscriptUnavailableError`, which
   `runTurnWithRetries` deliberately does not. Conservative (kills a process nothing was written
   to); left alone.
10. `LiveSendAborted` (the finding): was `return` with no retire. Now awaits the retirement.
11. success `sent`: a proven OK, nothing to retire.

`runTurnWithRetries` / `runOnPty`:

1. spawn wait `DeadlineExceeded` / spawn failure -> `errorResult`: before any write.
2. `!entry.pty` after spawn -> `errorResult`: before any write.
3. success with `boundaryVerdict === "failed"`: `await retireEntry`. Fine.
4. non-retryable + `PtyClosedError` + `signal.aborted`: `await retireEntry`. Fine. (`runOnPty`'s
   own abort listener also starts `retireEntry`; this joins it.)
5. non-retryable, everything else: `await retireEntry` unless `PtyTranscriptUnavailableError`
   (refused before the write). Fine.
6. retryable (`PtyClosedError` with `promptSent === false`) then `signal.aborted` -> `errorResult`
   with no retire: the prompt was never written, and the abort listener has already started the
   retirement. Fine.
7. retries exhausted / respawn failure -> `errorResult`: only reachable through (6)'s retryable
   class, i.e. nothing was sent.
8. `runOnPty` aborted before `runOnAdmittedEntry`: `await retireEntry`. Fine.

No other post-send return without a retire-and-await was found.

### Tests (`pty-send-to-live.test.ts`)

- Replaced "an abort stops the wait at once but keeps the lock until the turn really ends". It
  asserted the old behaviour (after an abort the entry stays and a second send fails) and was the
  finding itself. This is a deliberate reversal, not a weakened guard.
- New, send -> abort: the disposal starts at the abort, the call does not return until the exit is
  released, the entry is gone, and the next call spawns a new process that resumes the stored
  session id (`sess-1`).
- New: a turn queued behind the live send is not let go until the disposal finished, even when the
  abandoned turn rejects first.
- New: an abort while queued behind another turn, before anything was written, retires nothing.
- The already-aborted test now also asserts nothing was disposed.

## Fix 2 (MEDIUM): a textless final message is an empty reply

Cause: `addAssistantLine` dropped messages with no text, so `answerText()` returned the last
message WITH text ("Let me check") when the final message was thinking-only or tool-only.

Change (`pty-transcript.ts`): every non-synthetic assistant line opens or joins its message,
text or not. The answer is the last message's text (the final message by identity); empty after
trim -> `empty-reply` at the boundary.

Deliberate reversals (the old expectation was the bug, ruling 3):

- `pty-transcript.test.ts` "a turn that ends on a tool-only message returns the last message that
  has text" (round 3) -> now expects `empty-reply` and answer `""`.
- `pty-transcript.test.ts` "an earlier message with text and a tool-only final message is NOT
  empty: the last message that has text answers" (round 5, the test at :1114) -> replaced by
  Codex's sequence (narration + tool_use, thinking-only terminal message, `turn_duration`), which
  fails as `empty-reply`. A companion test pins that a real-text final message still answers with
  itself only.

## Fix 3 (MEDIUM): incomplete assistant shapes no longer fail open

- Error flags (`isApiErrorMessage`, `error`) are read FIRST on every assistant record, before the
  `message` check. Codex's sequence (final -> `{type:"assistant", isApiErrorMessage:true,
  error:"529"}` -> boundary) now fails `api-error` with text `529`. No `message`, no text, no
  `error` string -> the fixed text `API error`, never `undefined`.
- Message identity decides what the final message is. An id-less assistant line in the terminal
  phase, or any id-less line beside another assistant line of the turn, fails the turn as
  `ambiguous` ("an assistant line has no message id, so which lines make up the final message is
  uncertain"). A lone id-less final line is a complete message and answers.
  Choice: I used the existing `ambiguous` failure kind (surfaces as `PtyTurnFailedError`, text
  "outcome uncertain", kill-and-resume, never replayed) instead of waiting for the timeout to
  raise `PtyTranscriptUncertainError`. Both are non-success, non-replayed, kill-and-resume; this
  one answers at once instead of after the whole turn timeout, for a shape the real CLI is not
  known to produce.

## R2g (LOW)

Not pinnable with a real child through bun-pty, and that is shown, not assumed: a `trap '' TERM`
shell under bun-pty had its exit event delivered ~6 ms after `kill("SIGTERM")` while `kill -0`
still found the pid alive 400 ms later. bun-pty reports the exit when kill is called, whether or
not the child obeyed, so `await exited` in `dispose()` is satisfied immediately for any real
child. It IS pinned with a fake `bun-pty` (`mock.module`, its own file
`pty-process-dispose.test.ts`): a child that ignores SIGTERM and exits only after SIGKILL, with the
kill timer driven by hand. `dispose()` must stay pending until the timer fires and SIGKILL took
the child. The injection (drop `await exited`) now goes RED.

## Round 6: fault injection (one site at a time, on a `git archive` copy of the committed fix)

Each fault was predicted before it was run; the test file named is the only one run on that copy.
RED lines are pasted from the run output.

### I1a — live-send abort: retirement started but the abort branch does not await it (site: `await (abortRetirement ?? retireEntry(entry));` removed)

Predicted: the call returns while the exit is still held, so `returned` is logged before the
disposal ends. Exit 1, 1 failing.

```
604 |       expect(events).toEqual(["dispose-start"]);
error: expect(received).toEqual(expected)
@@ -2,2 +2,3 @@
    "dispose-start",
+   "returned",
(fail) sendToLiveSession > an abort after the prompt was sent (#562 round 6, Fix 1) > retires the entry and returns only after the process has exited; the next call resumes the same session in a new process
```

### I1b — live-send abort: the original bug (listener retirement and the awaited retire both removed)

Predicted: no disposal ever starts. Exit 1, 2 failing.

```
604 |       expect(events).toEqual(["dispose-start"]);
error: expect(received).toEqual(expected)
  [
-   "dispose-start",
+   "returned",
  ]
(fail) sendToLiveSession > an abort after the prompt was sent (#562 round 6, Fix 1) > retires the entry and returns only after the process has exited; the next call resumes the same session in a new process
(fail) sendToLiveSession > an abort after the prompt was sent (#562 round 6, Fix 1) > keeps the lock until the disposal has finished, even when the abandoned turn rejects first
```

### I1c — release chain ungated (site: `persisted.then(() => abortRetirement?.catch(...)).then(release, release)` -> `persisted.then(release, release)`)

Predicted: the turn queued behind is let go while the old process is still exiting. Exit 1, 1 failing.

```
650 |       expect(behindReturned).toBe(false);
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) sendToLiveSession > an abort after the prompt was sent (#562 round 6, Fix 1) > keeps the lock until the disposal has finished, even when the abandoned turn rejects first
```

### I1d — retire on an abort that came while queued, before any write (site: `gaveUp("the running turn to end")` path)

Predicted: the entry running the other turn is killed. Exit 1, 2 failing (the new test and the
existing "busy past the timeout" test).

```
675 |       expect(spawned[0].disposed).toBe(false);
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) sendToLiveSession > an abort after the prompt was sent (#562 round 6, Fix 1) > an abort while queued behind another turn, before anything was written, retires nothing
(fail) sendToLiveSession > busy past the timeout: failed (no not-live), and the abandoned send is never written later
```

### I2 — textless messages dropped again (site: `addAssistantLine`, `if (text === "") return;` restored)

Predicted: the thinking-only final message vanishes and "Let me check" answers. Exit 1, 2 failing.

```
1148 |     expect(s.failure).toEqual({ kind: "empty-reply", text: EMPTY_REPLY_TEXT });
error: expect(received).toEqual(expected)
- {
-   "kind": "empty-reply",
-   "text": "empty reply in transcript",
- }
+ null
(fail) TranscriptTurn — an empty reply is a failure (round 5, MEDIUM) > narration, then a thinking-only terminal message, then the boundary: fails as empty, the narration is not the answer (round 6)
(fail) TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4) > a turn that ends on a tool-only message is an empty reply, whatever the narration before it said
```

### I3a — `if (!message) return;` ahead of the error flags

Predicted: the message-less error record is skipped and the final answers. Exit 1, 2 failing.

```
1213 |     expect(s.failure).toEqual({ kind: "api-error", text: "529" });
error: expect(received).toEqual(expected)
- {
-   "kind": "api-error",
-   "text": "529",
- }
+ null
(fail) TranscriptTurn — incomplete assistant shapes (round 6, Fix 3) > an error-flagged assistant record with NO message, after the final message, fails the turn
(fail) TranscriptTurn — incomplete assistant shapes (round 6, Fix 3) > an error flag with no message and no text still fails, with a fixed text
```

### I3b — an id-less line in the terminal phase dropped silently again

Predicted: A is returned alone. Exit 1, 1 failing.

```
1258 |     expect(s.failure?.kind).toBe("ambiguous");
error: expect(received).toBe(expected)
Expected: "ambiguous"
Received: undefined
(fail) TranscriptTurn — incomplete assistant shapes (round 6, Fix 3) > id-less lines A then B, A carrying the terminal stop: uncertain, never A alone
```

### I3c — the id-less counter never fails (site: `if (this.idlessSeen && this.assistantLines > 1)` -> `if (false)`)

Predicted: two id-less lines become two messages, B answers. Exit 1, 2 failing.

```
1273 |     expect(s.failure?.kind).toBe("ambiguous");
error: expect(received).toBe(expected)
Expected: "ambiguous"
Received: undefined
(fail) TranscriptTurn — incomplete assistant shapes (round 6, Fix 3) > id-less lines A (open) then B (terminal): uncertain, never B alone
(fail) TranscriptTurn — incomplete assistant shapes (round 6, Fix 3) > an id-less line beside an id'd message is uncertain too
```

### I2g — R2g: `await exited;` removed from `dispose()` (file `pty-process.ts`)

Predicted: dispose returns right after SIGTERM, `settled` is true before the kill timer. Exit 1.

```
100 |     expect(settled).toBe(false);
error: expect(received).toBe(expected)

Expected: false
Received: true
(fail) PtyProcess.dispose — waits for the process to exit (R2g) > a child that ignores SIGTERM keeps dispose pending until SIGKILL has taken it
```

(No test in this round is left as an unfailable shape: every new assertion above was watched going
red before its comment was written.)

## Cron retry (reported, not changed)

`job-loop.ts:131`: a job with `retry > 0` is re-run after `retryDelay` when its result has
`exitCode !== 0`, and nothing else is looked at. Every PTY failure maps to a non-zero exit
(timeout 124, uncertain, empty reply, API error, ambiguous, aborted, all 1), so **an
uncertain or timed-out PTY turn DOES go through the cron retry** and is replayed as a fresh run of
the same prompt, even though the prompt may already have run. The runner/supervisor never replays
it; the cron layer does, when the operator configured `retry`. Left as is, matching the print
path. The coordinator will raise it with the operator.

## Round 6: a fourth stale test, found by the gate

`pty-false-completion.test.ts` "a terminal thinking-only final message ends at turn_duration,
answering with the last message that has text" (round 4) asserted the old behaviour through the
real process and reader, and was the only red in the wide gate. Reversed on purpose (ruling 3): it
now expects `PtyTurnFailedError` kind `empty-reply`. Injection (I2 again, drop textless messages)
against this file:

```
704 |     expect(out.text).toBeUndefined();
error: expect(received).toBeUndefined()

Received: "THE-LAST-TEXT"
(fail) #562 round 4 — ... > a terminal thinking-only final message ends at turn_duration as an empty reply, not with the narration before it
```

## Round 6: verification

- Wide gate: every `.test.ts` under `src/` and `tests/` (minus `tests/integration`) whose content
  matches `\bpty\b|Pty[A-Z]|runOnPty|pty-[a-z]|live-session|LiveSession|[Gg]ateway`: **96 files**,
  file by file, up to 3 attempts each, ANTHROPIC_BASE_URL unset, output to files.
  - normal: 95 files green on the first attempt; `pty-false-completion.test.ts` red (the stale test
    above, 3 of 3 attempts) and, after the reversal, **46 pass / 0 fail** in both modes.
  - `CLAUDECLAW_TEST_PLATFORM=linux`: same one red, same fix; `skills-fitness.test.ts` needed a
    second attempt (the known pre-existing red "does not call the judge again within the failure
    cooldown" was green on attempt 2, so it is a flake, not a regression).
  - About 2,219 passing tests per mode across the 96 files.
- `bun run lint` (full repo) exit 0; `bun run typecheck`: 149 errors, baseline 149.
- No real `claude`; nothing touched `~/.claude`.

## Round 6: not done / risks

1. **No real claude.** Still unconfirmed against a live CLI: (a) `turn_duration` follows every
   terminal message on 2.1.296; (b) the real CLI never omits `message.id` on an assistant line
   (if it does, such turns now fail `ambiguous` instead of answering); (c) a multi-block final
   message is one id across lines.
2. **Orphan claude after a daemon crash:** no reaper, per the brief. Residual.
3. **Cron retry replays a failed PTY job** when `retry` is configured (see above).
4. **`PtyTranscriptUnavailableError` in `sendToLiveSession`** retires a process nothing was written
   to; `runTurnWithRetries` does not. Harmless and conservative; not changed.


## Round 7: Codex r6 findings

Input: Codex round-6 review of `f25a0272` (one HIGH, one MEDIUM). Both closed; the commits are
`a882a8de` (Fix 1) and `cc92ff74` (Fix 2).

### Fix 1 (HIGH): retirement proves the OS process exited

**What was wrong, measured.** bun-pty 0.4.9 `kill()` (`node_modules/bun-pty/src/terminal.ts:216`)
takes a `signal` argument and ignores it, closes the handle, fires `onExit` synchronously, and
returns at once on every later call (`_closing`). So round 6's `await exited` resolved the moment
`kill("SIGTERM")` returned, and its 2 s `kill("SIGKILL")` escalation was a literal no-op. Probe
against the real library (`/bin/sh -c 'trap "" TERM HUP; sleep 300 & while :; do sleep 1; done'`):

```
exit events right after kill: 1
alive after 600ms: true
alive after 2nd kill(SIGKILL): true
group kill sent
alive after group kill: false
```

A child that traps only TERM dies (closing the pty master sends it SIGHUP), so the old R2g note
("a `trap '' TERM` shell was still alive 400ms later") needs HUP trapped too. Both are ignored in
the new tests.

**Process-group finding (not guessed).** The child is its own process-group leader:
`ps -o pid,ppid,pgid` shows `pgid == pid` for the spawned shell, and its `sleep` children share
that pgid. `process.kill(-pid, "SIGKILL")` reaches them (the real test checks the grandchild is
dead). A group signal is only ever sent while the leader is still alive after the grace period, so
a recycled pgid is not a practical risk; the pid is guarded (`> 1`, integer) so `kill(-1)`/`kill(0)`
can never be issued from a bad `pid`.

**The change.**
- `PtyProcessImpl.dispose()` (`src/runner/pty-process.ts`): SIGTERM through bun-pty, then poll
  `process.kill(pid, 0)` (ESRCH = gone, EPERM or anything else = alive) every 20 ms. After the 2 s
  grace it sends SIGKILL itself, to `-pid` then `pid`, never through bun-pty. At 7 s total it rejects
  with `PtyExitUnconfirmedError`. A rejected disposal is not cached: the next `dispose()` or
  `confirmExit()` runs a fresh attempt. Concurrent callers share one attempt. Polling uses the wall
  clock and real timers on purpose (a frozen injected clock must not hang retirement).
- win32 (no signal 0) and an unusable pid keep the old wait-for-exit-event behaviour.
- Supervisor (`src/runner/pty-supervisor.ts`): `retireEntry` puts a key whose disposal rejected into
  `state.quarantine`, in the same synchronous step before the entry leaves the map, so there is no
  window to admit a replacement. `admitEntry` calls `releaseQuarantine` (asks the process to prove
  death again) and throws `PtyQuarantinedError` while it lives. `respawnEntry` no longer swallows a
  rejected dispose: it quarantines and throws, and `respawnEntryWithRetries` does not retry it.
  `landPty` quarantines too. `sendToLiveSession` answers `failed`, not `not-live`, for a quarantined
  key (so no caller resumes the transcript in a one-shot). `liveSessionKeys` lists quarantined keys.

**Tests.**
- `pty-process-dispose-real.test.ts`: the real library and a real child that traps TERM and HUP with
  a grandchild in its group. `process.kill(pid, 0)` throws ESRCH for both when `dispose()` resolves;
  a second `dispose()` joins the first; EPERM from the OS is "unconfirmed", not "gone".
- `pty-process-dispose.test.ts` (rewritten): a bun-pty stand-in that behaves like 0.4.9 (first
  `kill()` fires exit and ignores the signal, later calls do nothing) plus a stand-in OS: dispose
  stays pending while the OS still shows the pid; SIGKILL reaches the OS group-then-pid; an immune
  process rejects, and `confirmExit()` succeeds later; a pid of -1/0/1 is never signalled.
- `pty-quarantine.test.ts`: retire with unconfirmed exit quarantines and spawns nothing; lifting;
  `sendToLiveSession` failed; crash respawn; a confirmed retirement quarantines nothing.

**Injections (one site each, on `git archive` copies of `a882a8de`, RED lines verbatim):**

| # | Fault (site) | Result |
|---|---|---|
| a | `_retire`: skip the pid confirmation (trust bun-pty's exit event) | 3 of 4 mock tests, 3 of 3 real tests RED |
| b | `_confirmGoneByPid`: no direct SIGKILL | 3 of 4 mock, 2 of 3 real RED |
| b2 | `_confirmGoneByPid`: return instead of throwing at the cap | 1 mock, 1 real RED |
| g | SIGKILL the leader only, not the group | 1 mock, 1 real RED |
| c | `retireEntry`: drop `quarantinePty` | 3 of 5 RED |
| c2 | `respawnEntry`: swallow the dispose rejection | 1 RED |
| c3 | `sendToLiveSession`: `!entry` branch ignores quarantine | 1 RED |
| c4 | `admitEntry`: drop `releaseQuarantine` | 1 RED (the lift test; the `has()` check below it still refuses) |

```
a   error: expect(received).toBe(expected)   Expected: false   Received: true
    (fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a child that outlives SIGTERM keeps dispose pending until SIGKILL has taken it [65.43ms]
b   (fail) PtyProcess.dispose — real child that ignores SIGTERM and SIGHUP > is dead, with its group, by the time dispose() resolves [1945.84ms]
b2  error: expect(received).rejects.toBeInstanceOf(expected)
    Expected promise that rejects
    Received promise that resolved: Promise { <resolved> }
    (fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a process that survives SIGKILL makes dispose() reject, and a later confirmation succeeds [610.34ms]
g   error: expect(received).toBe(expected)   Expected: false   Received: true
    (fail) PtyProcess.dispose — real child that ignores SIGTERM and SIGHUP > is dead, with its group, by the time dispose() resolves [793.48ms]
c   error: expect(received).toContain(expected)   Expected to contain: "global"   Received: []
    (fail) quarantine of a key whose process is not proven dead > retiring an unconfirmed process quarantines the key: no replacement is spawned [10.05ms]
c2  error: expect(received).toBe(expected)   Expected: 1   Received: 2
    (fail) quarantine of a key whose process is not proven dead > a crash-recovery respawn does not resume over a process that is not proven dead [0.92ms]
c3  error: expect(received).toBe(expected)   Expected: "failed"   Received: "not-live"
    (fail) quarantine of a key whose process is not proven dead > sendToLiveSession on a quarantined key is failed, never not-live (no one-shot resume) [0.82ms]
c4  error: expect(received).toBeGreaterThan(expected)   Expected: > 0   Received: 0
    (fail) quarantine of a key whose process is not proven dead > the quarantine lifts once the OS confirms the exit, and then the key spawns again [0.66ms]
```

### Fix 2 (MEDIUM): final-message attribution is order-dependent

**Decision.** The final message is the one whose line carried the first terminal stop reason, with
all its blocks joined by id wherever they sit (`messages` is searched by id, not only the last
entry). Any return to an earlier message after another message's line (A, B, A) fails the turn as
`ambiguous` (`INTERLEAVED_TEXT`), in any phase and counting the lines that are otherwise ignored
after the final message. Rationale: with a background reply running inside the turn, the lines
cannot be placed in one reply or the other; "the full A" would be a guess about a message whose
sibling never closed, and both Codex shapes then return something that is not provably the reply.
Uncertain is never replayed. The round-5 ruling stays: a message that starts AFTER the final one
and never returns is ignored, neither appended nor a boundary.

Honest note: with the interleave check in place, same-id lines are always adjacent when a turn
succeeds, so aggregation by id and the old adjacent merge give the same answer. The by-id lookup
is kept so the answer does not depend on the check's placement; no test can tell them apart.

**Tests** (`pty-transcript.test.ts`, "round 7, Fix 2"): shape (i), shape (ii), resuming after an
ignored line, the same across polls, the normal tool loop (tool_use, result, tool_use, result,
final), a message split by a bookkeeping record and a tool result, and a trailing background reply.

| # | Fault | Result |
|---|---|---|
| i1 | remove the interleave check | 4 RED (both Codex shapes, resume-after-ignored, across polls) |
| i2 | check only while the turn is open | 2 RED (shape (i), resume-after-ignored) |
| i3 | `seenIds.has(id)` made `size > 0` (over-strict) | 11 RED, every tool loop |
| i4 | `seenIds.clear()` on every poll | 1 RED (across polls) |

```
i1  error: expect(received).toEqual(expected)
    (fail) TranscriptTurn — interleaved messages are uncertain, not attributed (round 7, Fix 2) > A starts, B terminates, A finishes: uncertain, never B alone [18.17ms]
    (fail) ... > A-prefix, a non-terminal B, A-suffix: uncertain, never the suffix alone [0.81ms]
    (fail) ... > the final message resumes after another message's line that was ignored: uncertain [0.60ms]
i2  (fail) ... > A starts, B terminates, A finishes: uncertain, never B alone [0.68ms]
    (fail) ... > the final message resumes after another message's line that was ignored: uncertain [0.53ms]
i3  (fail) TranscriptTurn — answer and end of reply > a tool_use stop does not end the turn; the final end_turn message does and is the answer [1.05ms]
    (fail) ... > the normal tool loop still answers with the final message [0.57ms]
i4  error: expect(received).toBe(expected)   Expected: "ambiguous"   Received: undefined
    (fail) ... > interleaving across polls is the same verdict as within one [0.76ms]
```

### Round 7: verification

- Wide gate: every `.test.ts` under `src/` and `tests/` (minus `tests/integration`) whose content
  matches `\bpty\b|Pty[A-Z]|runOnPty|pty-[a-z]|live-session|LiveSession|[Gg]ateway`: **98 files**
  (96 + the two new ones; `pty-process-dispose.test.ts` was rewritten), file by file, up to 3
  attempts, ANTHROPIC_BASE_URL unset, output to files.
  - normal: 98 of 98 green on the first attempt, 2,238 passing tests.
  - `CLAUDECLAW_TEST_PLATFORM=linux`: 98 of 98 green on the first attempt, 2,238 passing tests
    (the known `skills-fitness.test.ts` judge-cooldown flake did not fire).
- `bun run lint` (full repo) exit 0; `bun run typecheck`: 149 errors, baseline 149.
- No real `claude` started; nothing touched `~/.claude`. The real-child tests spawn `/bin/sh` and
  `/bin/cat` only and kill what they start.

### Round 7: not done / risks

1. **Orphan claude after a daemon crash:** still no reaper (round-4 HIGH 3 stays open for the
   crash case; the retirement gap that Codex tied to it is closed). Residual.
2. **Quarantine is in memory.** A daemon restart forgets it. After a restart the old process is an
   orphan, which is the case above.
3. **A zombie that is never reaped would read as alive** to `process.kill(pid, 0)`. In the probes
   the child was reaped promptly; if it ever is not, the key stays quarantined and the turn fails
   rather than resuming. Fail-closed, not fail-open.
4. **Quarantine release is lazy:** it is tried when something asks for the key (admission), not on a
   timer. A key nobody asks for stays quarantined.
5. **Windows:** no signal-0 probe; keeps the exit-event wait (and bun-pty's no-op SIGKILL there).
   Linux and macOS are the targets.
6. **Real-CLI prevalence of interleaved messages is unverified** (Codex said the same). The cost of
   being wrong is a turn failing `ambiguous` where a reply was in fact fine, never a wrong answer.
7. Cron `retry` still replays a failed PTY job (operator decision, round 6 item 3).

## Round 8 (Codex round-7 findings: quarantine on every writer start, pid identity, visibility)

Input: Codex round-7 review of `f7e3937c`. Head before this round `f7e3937c`; commits
`93d1a7db` (pid identity), `75f929db` (session-keyed gate, visibility), `92892878` (`_ptySpawn`
seam, no more `mock.module("bun-pty")`) and `7dfc5530` (pause-controller reset in `triggers.test.ts`). Binding rules unchanged:
the screen is never evidence; no production guard weakened to make a test red; every injection
below was one site at a time on a copy.

### What was wrong (verified before fixing)

1. **HIGH.** Round 7 fenced `runOnPty` admission only. (a) `respawnEntry` quarantines the process of
   a failed crash recovery but keeps the entry; `sendToLiveSession` checked quarantine only when the
   entry was ABSENT, the retained process reported dead, so it answered `not-live` and
   `actOnSession` resumed the same session in a one-shot. (b) `skipLive` awaited
   `retirePtySession`, whose retirement absorbed the disposal rejection into a quarantine and
   returned normally, so the one-shot started beside the unconfirmed writer. Both read off the code
   at `f7e3937c`; the regression tests for them go red when the gates are removed (I1a, I1c, I1d).
2. **MEDIUM.** `confirmExit()` could run long after quarantine and signalled `-pid` and `pid` on
   existence alone; a reused pid would be killed.
3. **MEDIUM.** `/kill`, shutdown and status read `state.ptys` only; an idle retirement vanished from
   status, and nothing retried a quarantine except admission of the same key.

### Design (smallest that closes each finding)

- New `src/runner/pty-quarantine.ts` (about 120 lines). A record holds the process, the supervisor
  key, a short fixed reason code and a time. A record matches a target by supervisor key OR by the
  process's claude session id, read live from the process. One gate:
  `assertSessionWritable({sessionKey?, sessionId?})` asks each matching process to prove its exit
  again (`confirmExit`, identity-checked) and throws `PtyQuarantinedError` while one lives. It IS the
  recovery path: the next use of a session from any path releases it, with no timer. The shutdown
  and `/kill` paths call `confirmAllQuarantined()`.
- `retirePtySession` now rejects with `PtyQuarantinedError` when the exit is unconfirmed, so a
  caller that forgets the result still cannot fall through to a resume.
- `PtyProcessImpl` reads the child's birth identity at spawn (Linux `/proc/<pid>/stat` field 22, a
  plain file read; macOS/BSD `ps -o lstart=`, one spawn of about 10-20 ms, once at spawn and once per
  signal, never per poll. Chosen over a handle because bun-pty exposes only the pid). The existence
  probe becomes a four-way state: `gone`, `replaced` (a different identity holds the pid; both mean
  the original exited and NOTHING is signalled), `same`, `unknown`. A signal is sent only for `same`,
  or for `unknown` when no identity was ever recorded AND this is the initial retirement. A later
  `confirmExit()` with no readable identity sends nothing and stays quarantined. The SIGTERM through
  bun-pty is skipped for `replaced`.

### Every call site that can start a claude on a session id

`assertSessionWritable` (A) is at the line given; "via" means the path reaches a gated site.

| Call site | Gate |
|---|---|
| `pty-supervisor.ts` `spawnEntry` -> `spawn(spawnOpts)` | A at `:2078`, by key and `spawnOpts.sessionId` (the stored or resumed id) |
| `pty-supervisor.ts` `respawnEntry` -> `spawn(opts)` | A at `:2242`, by key and the resume id |
| `pty-supervisor.ts` `admitEntry` (every `runOnPty`, incl. ephemeral and `runOnceOnPty`) | A at `:1449` (retry), plus the sync check under the admission lock `:1460`, by key and `resumeSessionId` |
| `pty-supervisor.ts` `sendToLiveSession` | A via `sessionBlocked` at `:1108`, FIRST in the loop (before any alive/no-entry decision) and again under the lock |
| `live-session-actions.ts` `actOnSession` one-shot (the `not-live` path, the `skipLive` path, a call with no live key) | A at `:123`, by key and session id; `skipLive` also goes through `retirePtySession` (`:752`) |
| `oneshot/engine.ts` `runOneShot` with `resumeSessionId` (live-session fallback, `shutdown-memory-save.ts:261`, `commands/discord.ts:661`) | A at `:61` |
| `oneshot/print.ts:40` `--resume` | via `runOneShot` only (the registry's `print` engine is not called anywhere else outside tests) |
| `oneshot` `pty` engine -> `runOnceOnPty` -> `runEphemeralWithDeadline` -> `runOnPty` | via `admitEntry` and `spawnEntry` |
| `runner.ts` `spawnClaude` (legacy `claude -p`): `runClaudeOnce`, `runClaudeStream`, the streamed turn, `runFork` | A in `gateResume` `:791` (reads `--resume <id>` from argv) |
| `runner.ts` `runClaudeStreaming` direct `Bun.spawn` | A at `:1193`; the function has no callers (dead code), gated anyway |
| `runner.ts` `runOnPty` calls (primary, recovery, fallback), `runOneShotOnPty` (`:953`, fork) | via `admitEntry` and `spawnEntry`; `execRecovery`'s `retirePtySession` now rejects on an unconfirmed exit |
| `bus/session-manager.ts` spawn (`spawnPty` / `spawnChild` / `spawnTmux`, `--session-id <agent.session_id>`) | A at `:869`, before all three, inside the cleanup `try` |
| `runner.ts:166` `claude --version`, `commands/start.ts:1573`, `preflight.ts:195`, `commands/plugin-cli.ts:59`, `skills-tuner/core/llm.ts:75` (`runOneShot` without a resume id) | start no claude on a session id; not gated, nothing to gate |

Found by grepping `--resume`, `resumeSessionId`, `runOneShot(`, `runOnPty(`, `spawnPty`, `Bun.spawn(`
over `src` minus tests.

### Tests added or changed

- `pty-quarantine-gate.test.ts` (new, 11 tests): both Codex paths end to end through `actOnSession`
  (no one-shot started); the under-lock re-check with a process that stays alive after a failed
  dispose; the gate by session id under ANOTHER key (one-shot, `runOneShot`, legacy `--resume`,
  first spawn from a stored id, crash-recovery respawn); recovery from any path once the pid is
  gone; status lists the session; `/kill` and shutdown count unconfirmed exits; the `/kill` entry
  count includes quarantined sessions.
- `session-manager-quarantine.test.ts` (new): the bus spawn is refused and the stand-in never starts.
- `pty-process-dispose.test.ts`: the fake OS gained an identity; three new tests (a reused pid is
  confirmed gone and not signalled; a later confirmation with an unreadable identity sends
  nothing; no identity at spawn means initial retirement may signal, a later one may not).
- `pty-process-dispose-real.test.ts`: `readPidIdentity` against real processes.
- `pty-quarantine.test.ts`: `retirePtySession` now rejects on an unconfirmed exit (round-7 tests
  updated to the new contract, assertions unchanged otherwise).
- `runner.test.ts`: the `SupervisorSnapshot` mock gained `quarantined: []` (type only).

### Round 8: red-line evidence (one site per injection, `git archive`-style copy of the working tree)

Every line below is copied from the test output file of that injection, not retyped. Each injection was run on a copy, the edit applied by exact-match replace (it refuses unless exactly one match), the copy discarded afterwards; the real tree was never edited for an injection.

**I1a** `src/runner/pty-supervisor.ts` — `sendToLiveSession`: the gate at the top of the loop (Codex path 1, retained entry)

```
(fail) the retained entry of a failed crash recovery > sendToLiveSession answers failed, and no one-shot resumes the transcript [131.53ms]
(fail) quarantine of a key whose process is not proven dead > sendToLiveSession on a quarantined key is failed, never not-live (no one-shot resume) [1.98ms]
12 pass / 2 fail
```

**I1b** `src/runner/pty-supervisor.ts` — `sendToLiveSession`: the re-check under the lock

```
(fail) a send queued behind a turn whose crash recovery quarantines the process > is checked again under the lock and never writes to the process [157.52ms]
13 pass / 1 fail
```

**I1c** `src/runner/live-session-actions.ts` — `actOnSession`: the gate before `_runOneShot` (the `not-live` path, and any key-less call)

```
(fail) the one-shot fallback is gated by session id as well as key > a transcript quarantined under another key is not resumed one-shot [63.02ms]
13 pass / 1 fail
```

**I1d** `src/runner/pty-supervisor.ts` — `retirePtySession`: propagate an unconfirmed exit (Codex path 2, `skipLive`)

```
(fail) skipLive after a retirement that could not prove the exit > fails the call as a retirement failure and starts no one-shot [10.71ms]
(fail) quarantine of a key whose process is not proven dead > retiring an unconfirmed process quarantines the key: no replacement is spawned [36.24ms]
12 pass / 2 fail
```

**I1e** `src/oneshot/engine.ts` — `runOneShot`: the `resumeSessionId` gate

```
(fail) the one-shot fallback is gated by session id as well as key > runOneShot refuses a resume of a quarantined transcript before any engine runs [50.81ms]
13 pass / 1 fail
```

**I1f** `src/runner.ts` — `gateResume`: legacy `claude -p --resume`

```
(fail) the one-shot fallback is gated by session id as well as key > the legacy `claude -p --resume` is refused too [37.54ms]
13 pass / 1 fail
```

**I1g** `src/runner/pty-supervisor.ts` — `admitEntry`: the confirmation-retry gate

```
(fail) quarantine of a key whose process is not proven dead > the quarantine lifts once the OS confirms the exit, and then the key spawns again [1.33ms]
13 pass / 1 fail
```

**I1h** `src/runner/pty-supervisor.ts` — `spawnEntry`: the gate before `spawn` (stored session id of another key)

```
(fail) a session id held under another key > a first spawn that would resume the stored session id of a quarantined key is refused [2.59ms]
15 pass / 1 fail
```

**I1i** `src/runner/pty-supervisor.ts` — `respawnEntry`: the gate before `spawn`

```
(fail) a session id held under another key > a crash-recovery respawn that would resume a quarantined session id is refused [3.41ms]
15 pass / 1 fail
```

**I1k** `src/bus/session-manager.ts` — bus `spawnAgentInternal`: the gate before the spawn

```
(fail) SessionManager.spawnAgent and the quarantine gate > does not start claude on a session id with an unconfirmed writer [2221.69ms]
0 pass / 1 fail
```

**I2a** `src/runner/pty-process.ts` — `_pidState`: skip the identity comparison

```
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a pid the OS has handed to another process counts as exited and is never signalled [169.82ms]
6 pass / 1 fail
```

**I2b** `src/runner/pty-process.ts` — `_maySignal`: signal on "unknown" always

```
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a later confirmation whose identity cannot be read sends no signal and stays unconfirmed [767.34ms]
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > with no identity recorded at spawn the initial retirement may signal, a later one may not [760.16ms]
5 pass / 2 fail
```

**I2c** `src/runner/pty-process.ts` — `_maySignal`: drop the initial-window branch

```
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > with no identity recorded at spawn the initial retirement may signal, a later one may not [602.89ms]
6 pass / 1 fail
```

**I2d** `src/runner/pty-process.ts` — SIGTERM through bun-pty: drop the `replaced` guard

```
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a pid the OS has handed to another process counts as exited and is never signalled [2.18ms]
6 pass / 1 fail
```

**I2f** `src/runner/pty-process.ts` — `_originalGone`: a replaced pid does not count as gone

```
(fail) PtyProcess.dispose — the OS decides, not bun-pty's exit event > a pid the OS has handed to another process counts as exited and is never signalled [605.17ms]
6 pass / 1 fail
```

**I2e** `src/runner/pty-process.ts` — `readPidIdentity`: return a constant (real reader, `-real` file alone)

```
(fail) readPidIdentity — the birth identity that tells a reused pid from the original > a live process has a stable identity; a pid nobody holds has none [11.06ms]
(fail) readPidIdentity — the birth identity that tells a reused pid from the original > two different live processes do not share an identity once their start differs [64.07ms]
3 pass / 2 fail
```

**I3a** `src/runner/pty-quarantine.ts` — `tryRelease`: no confirmation retry

```
(fail) recovery and visibility > the next use from ANY path releases the quarantine once the pid is gone [5.13ms]
(fail) quarantine of a key whose process is not proven dead > the quarantine lifts once the OS confirms the exit, and then the key spawns again [0.76ms]
14 pass / 2 fail
```

**I3b** `src/runner/pty-supervisor.ts` — `snapshotSupervisor`: leave `quarantined` empty

```
(fail) recovery and visibility > the next use from ANY path releases the quarantine once the pid is gone [1.11ms]
(fail) recovery and visibility > status lists a quarantined session with its key, pid, reason and time [0.57ms]
14 pass / 2 fail
```

**I3c** `src/runner/pty-supervisor.ts` — `killAllPtysReport`: no final confirmation / count

```
(fail) recovery and visibility > /kill and shutdown count the exits they could not confirm [0.77ms]
15 pass / 1 fail
```

**I3d** `src/runner/pty-supervisor.ts` — `shutdownSupervisor`: no final confirmation / count

```
(fail) recovery and visibility > /kill and shutdown count the exits they could not confirm [0.68ms]
15 pass / 1 fail
```

**I3e** `src/runner/pty-supervisor.ts` — `supervisorEntryCount`: ignore quarantined sessions

```
(fail) recovery and visibility > status lists a quarantined session with its key, pid, reason and time [1.39ms]
15 pass / 1 fail
```

**X1** `src/__tests__/escalation/triggers.test.ts` — drop the `afterAll` pause-controller reset (run with `session-id-seam.test.ts` after it, one process)

```
(fail) gateway records the Claude session id the processor surfaces (#376) > a successful turn with a session id records it on the mapping [3.09ms]
(fail) gateway records the Claude session id the processor surfaces (#376) > a successful turn with NO session id records nothing and says so once per conversation [0.21ms]
33 pass / 2 fail
```

Notes on the injections, stated plainly:

- **Two gates were shadowed at first.** I1h (`spawnEntry`) and I1i (`respawnEntry`) went GREEN
  on the first run: admission already refused the same key, so no test could tell the spawn-site
  gates from nothing. They exist for a session id held under ANOTHER key (a stored id of the new
  key, a respawn resuming a quarantined id), which no test covered. The two "session id held under
  another key" tests were added and the injections rerun; the lines above are from that rerun.
- **The `skipLive` path is double-covered on purpose.** Removing the `retirePtySession`
  propagation alone (I1d) leaves the one-shot blocked by the gate in `actOnSession` (I1c); the test
  therefore asserts the failure is attributed to the retirement
  (`could not retire the wedged session`), which is what goes red. It does not prove the one-shot
  would start with only that gate removed. With BOTH removed the one-shot does start, which is the
  `f7e3937c` behaviour; that two-site combination was not run as an injection.
- **I1a also turns a round-7 test red** (the `!entry` branch), as predicted: the gate replaced it.
- Running `pty-process-dispose.test.ts` and `pty-process-dispose-real.test.ts` in ONE bun process
  failed the real-child tests (`mock.module("bun-pty")` from the first file leaked into the second).
  It failed the same way on the `f7e3937c` archive (5 pass / 2 fail), so it predates this round's
  code. Fixed below (the `_ptySpawn` seam); the two files now pass together, 12 of 12. The injections
  above were run with those files in separate processes, which is why their counts differ from the
  combined run.

### Round 8: not done / risks

1. **Quarantine is in memory.** A daemon restart forgets it; the old process is then an orphan
   (round-4 HIGH 3, still open for the crash case, no reaper).
2. **A zombie stays quarantined** (its pid exists and its identity matches, and no signal reaps it).
   Fail-closed and visible in `snapshotSupervisor()`, never fail-open. A pid whose identity cannot be
   read on a LATER confirmation also stays quarantined (nothing is signalled): on Windows the
   retirement is still event-based, so there is no identity at all.
3. **The confirmation retry is not bounded by the caller's budget.** `assertSessionWritable` inside
   `sendToLiveSession` or the legacy spawn waits for `confirmExit()` (up to the 2 s grace plus 5 s,
   so 7 s) and does not look at `timeoutMs` or the abort signal. Only a session that IS
   quarantined pays it, once per use.
4. **Identity resolution.** macOS `ps -o lstart=` has one-second resolution; Linux `/proc` starttime
   is in clock ticks. A reused pid that started in the same tick as the original would read as
   `same`; that needs the pid counter to wrap inside that tick.
5. **`/kill` has no room for a count in its synchronous boolean reply.** The unconfirmed count is
   returned by `killAllPtysReport()` and logged as `[pty-supervisor] /kill: N process exit(s) still
   unconfirmed (quarantined)`; no chat text changed. Shutdown returns the count and logs the same way.
6. **Group kill still keys on the leader.** If the leader has exited and MCP children survive in its
   group, the state is `gone` and the group is not signalled (unchanged, not in this round).
7. **Real-CLI background/interleaving compatibility is unproved** (Codex said the same).
8. The engine-level gate does not run when a test injects `_runOneShot`; `actOnSession` has its own
   gate for that reason, and the engine gate has its own test.

### Round 8: the CI-equivalent gate (single process)

CI (`test.yml:62`) runs `bun test src` in ONE process, so file-by-file runs do not prove CI green.
`env -u ANTHROPIC_BASE_URL bun test src`, on `git archive` copies:

| Head | pass | skip | fail | notes |
|---|---|---|---|---|
| `2066150c` (round 4, coordinator) | 4775 | | 2 | the two `gateway ... (#376)` tests |
| `f7e3937c` (round 7, coordinator) | 4754 | | 70 | none of the 70 in the round-4 list |
| `75f929db` (round 8 code, mine) | 4781 | 4 | 60 + 4 errors | almost all #562 PTY suites |
| `92892878` (+ `_ptySpawn` seam) | 4839 | 4 | 2 | the same two `gateway (#376)` tests as round 4 |
| `7dfc5530` (+ pause-controller reset), run 1 | 4840 | 4 | 1 | `pty-process.test.ts` "a dialog that paints late..." (6 s, `PtyClosedError exit=1`) |
| `7dfc5530`, run 2 (same archive) | **4841** | 4 | **0** | exit 0 |

Leaks found and fixed at the source:

1. **`mock.module("bun-pty")` in `pty-process-dispose.test.ts`** (rounds 5-7). `mock.module` is
   process-wide in bun and `mock.restore` does not undo it, so every later file that spawns a real
   child through `bun-pty` got the fake. This was the source of the PTY failures. `PtyProcessOptions`
   gained `_ptySpawn` (like `_signalPid`) and the test passes its fake through it. Proof the pair
   now coexists: `pty-process-dispose.test.ts` and `pty-process-dispose-real.test.ts` in ONE process
   passed 12/12; before, the real-child tests failed there (also on the `f7e3937c` archive).
2. **The two `gateway (#376)` failures (present since round 4, not caused by this PR).**
   `escalation/triggers.test.ts` really pauses the system in its last describe and never reset the
   controller, whose state is cached in the module; later `Gateway.processInboundEvent` calls
   refuse admission. Bisected by running each of the four escalation-touching files before
   `session-id-seam.test.ts` in one process: only `triggers.test.ts` reproduces it. Fixed with a
   file-level `afterAll` (injection X1: remove it, the two tests fail again).
3. Other `mock.module` users (`eval-runner`, `judges`, `index` in `plugins/eval-framework`) restore
   the real module in the same file; none changed.

The one failure in run 1 is a wall-clock test (a 2.5 s boot stream against a 3 s hard timeout whose
fake CLI exits 1 on any stray byte). It is in `pty-process.test.ts`, which this round did not
touch, passes alone 3 of 3, passed in both file-by-file passes, and did not recur in run 2 on the
identical archive. I read it as a load flake, not a leak, but I did not prove that beyond those
runs; a third single-process run was not made.

### Round 8: verification

- **File-by-file wide gate** at `7dfc5530` (every `.test.ts` under `src/` and `tests/` minus
  `tests/integration` whose content matches `\bpty\b|Pty[A-Z]|runOnPty|pty-[a-z]|live-session|LiveSession|[Gg]ateway`;
  each file in its own process, up to 3 attempts, `ANTHROPIC_BASE_URL` unset, output to files):
  - normal: **101 of 101 green on the first attempt**, 2,287 passing tests.
  - `CLAUDECLAW_TEST_PLATFORM=linux`: **101 of 101 green on the first attempt**, 2,287 passing tests
    (the known `skills-fitness.test.ts` judge-cooldown flake did not fire in this pass).
  - An earlier pair of passes at `75f929db` (before the `_ptySpawn` seam) was 100/100 normal and
    99/100 linux; the one linux miss was that same known flake (3 attempts). `jsonl-tailer.test.ts`
    needed a second attempt once there (a 2.2 s timing test, not touched by this round). Both passes
    were redone on the final head because `pty-process.ts` changed after them.
- **Single process (what CI runs)**: see the table above. Final head: 4841 pass / 4 skip / 0 fail
  (exit 0) on the second run; the first run had one load-sensitive failure, discussed there. The
  gate the coordinator set is "fail no test outside the round-4 list"; the round-4 list is the two
  `gateway (#376)` tests, now fixed, so the final head fails nothing.
- `bun run lint` (full repo) exit 0; `bun run typecheck`: 149 errors, baseline 149.
- No real `claude` started; nothing touched `~/.claude`. The real-child tests spawn `/bin/sh` and
  `/bin/cat` and `/bin/sleep` only and kill what they start.

## Round 9 (FINAL: Codex round-8 HIGH check-to-spawn race, MEDIUM confirmation ignores deadline and abort)

Input: Codex round-8 review of `cebf8bdb`. Commit `b48ae31c` (code and tests), then this report and the
SPEC and CLAUDE.md sentences. Scope per Terry's ruling: these two findings and nothing else. Quarantine
visibility (Telegram `/status`, `/kill` wording) and cron retries are untouched.

### What was wrong (verified before fixing)

1. **HIGH, check-to-spawn race.** `assertSessionWritable` is async. `spawnClaude` awaited `gateResume`
   and then called `Bun.spawn` with nothing in between that could notice a retirement that failed in the
   meantime (and `runPrint` awaits two dynamic imports after the engine-level gate). Reproduced by the
   new tests with the quarantine landing inside that gap: before the fix the stub spawn ran.
2. **MEDIUM, gate ignores the caller's deadline and abort.** `sessionBlocked` and `runOneShot` awaited
   the confirmation (up to ~7 s in production) with no look at `timeoutMs` or the signal.

### Fix 1: fence at retirement start, synchronous check at each spawn

All in `src/runner/pty-quarantine.ts`, one registry:

- `fenceSession(sessionKey, pty)` / `liftFence(pty)`. The fence is a map pty -> key. `quarantineSession`
  deletes the fence and adds the record in one synchronous step, so an unconfirmed exit goes from
  fenced to quarantined with no gap; `liftFence` after that is a no-op.
- `assertSessionSpawnable(target)`: SYNCHRONOUS, throws `PtyQuarantinedError` for a quarantined or
  fenced session (matched by supervisor key or claude session id, like the gate). The async gate stays
  (it does the confirmation retry); the sync check is the final word.

**Fence entry points** (`pty-supervisor.ts`): `retireEntry` (:2027, before the first await; covers
supervisor reap, LRU, `/kill`, shutdown, abort/timeout retirement, `retirePtySession`, all of which
call it), `landPty` late-PTY disposal (:1989), `respawnEntry` crash-recovery disposal (:2270). The
`retireEntry` finally lifts the fence (:2055-2056); the other two lift in their own `finally`.

**Sync-check sites** (every one is on the line before process creation, no await in between; each has a
one-line comment saying so):

| Site | Where |
|---|---|
| runner `spawnClaude` (legacy `claude -p`; `runClaudeOnce`, stream, fork) | `runner.ts:807` via `assertResumeSpawnable`, before `_claudeSpawnForTests`/`Bun.spawn` |
| runner `runClaudeStreaming` direct `Bun.spawn` | `runner.ts:1211` |
| print engine | `oneshot/print.ts:81`, inside the promise, right before `spawn("claude", ...)`, after the config/runner imports (not for untrusted: no resume) |
| PTY first spawn | `pty-supervisor.ts:2127`, before `spawn(spawnOpts)` (covers the one-shot `pty` engine, `runOnceOnPty`, `runEphemeralWithDeadline`) |
| PTY respawn | `pty-supervisor.ts:2299`, before `spawn(opts)` |
| `spawnPty` itself (any caller that names a session) | `pty-process.ts:1563`, before the `_ptySpawn` call |
| bus PTY / child / tmux | `bus/session-manager.ts:1137`, `:1164`, `:1205`, each in its spawn function after the `bun-pty` import |

### Fix 2: the gate honours the caller's deadline and abort

`assertSessionWritable(target, { deadline?, signal? })` races the confirmation against the deadline
and the signal (`waitBounded`). On either it throws `SessionGateInterrupted` (`how: "timeout" | "aborted"`).
The confirmation is NOT cancelled and the record is not released on a timeout; if it later succeeds
the session is writable again. `sessionBlocked` passes the `sendToLiveSession` deadline and signal and
maps the interruption to `timedOut:true` / `aborted:true`; `signal.aborted` is re-checked after the gate
(top of the loop and under the lock) before anything is written. `runOneShot` passes `req.timeoutMs`
and `req.signal`: timeout returns an exit-124 result with `engine: "quarantine-gate"`, abort rejects
with the signal's reason.

### Tests

New `src/__tests__/pty-spawn-fence.test.ts` (11 tests) and one added to `session-manager-quarantine.test.ts`:
quarantine landing inside the awaited gap for `spawnClaude` and `runPrint` (Codex's repro shape);
fence refused synchronously while a retirement is in flight and lifted when it confirms; fence becomes
the record on an unconfirmed exit; a first spawn resuming the session of a key mid-retirement is refused;
bus spawn refused on a fenced session; Codex's timing shape (5 ms budget, abort at 10 ms, 200 ms
confirmation) for `sendToLiveSession` and `runOneShot`, with the quarantine still present afterwards and
a gone pid released later by the abandoned confirmation.

### Round 9: red-line evidence (one site per injection, `git archive` copy of `b48ae31c`)

Each injection is one edit on a fresh `git archive HEAD | tar -x` copy, with `pty-spawn-fence.test.ts` and `session-manager-quarantine.test.ts` run in it. The predictions are the `Fault ... Predicted result` comments in the tests, written before the run. Lines are verbatim from the run output (stack frames omitted).

**I1. runner.ts `spawnClaude`: delete `assertResumeSpawnable(args);` (line 807)**

```
error: expect(received).toThrow(expected)
Expected substring: "quarantined"
Received message: "must not spawn"
(fail) a session quarantined during the awaited gap before a spawn > the legacy `claude -p --resume` does not spawn (runner spawnClaude) [15.97ms]
 12 pass
 1 fail
```

**I2. print.ts: delete the `assertSessionSpawnable` block before `spawn("claude")` (line 81)**

```
error: expect(received).toThrow(expected)
Expected substring: "quarantined"
Received message: "must not spawn"
(fail) a session quarantined during the awaited gap before a spawn > the print engine does not spawn after its config and runner imports (print.ts) [1.84ms]
 12 pass
 1 fail
```

**I3. pty-supervisor.ts `retireEntry`: delete the `fenceSession` at the start (line 2027)**

```
error: expect(received).toThrow(expected)
Expected constructor: PtyQuarantinedError
Received function did not throw
Received value: undefined
(fail) the retirement fence > is refused synchronously from the moment a retirement begins, and lifted when it confirms [5003.65ms]
error: expect(received).toContain(expected)
Expected to contain: "quarantined"
Received: "{\"rawStdout\":\"echo:hello\",\"stderr\":\"\",\"exitCode\":0,\"sessionId\":\"sess-fresh\"}"
(fail) the retirement fence > refuses a first spawn that would resume the session of a key whose retirement is in flight [5001.17ms]
 11 pass
 2 fail
```

**I4. pty-supervisor.ts `spawnEntry`: delete `assertSessionSpawnable` (line 2127)**

```
error: expect(received).toContain(expected)
Expected to contain: "quarantined"
Received: "{\"rawStdout\":\"echo:hello\",\"stderr\":\"\",\"exitCode\":0,\"sessionId\":\"sess-fresh\"}"
(fail) the retirement fence > refuses a first spawn that would resume the session of a key whose retirement is in flight [5000.64ms]
 12 pass
 1 fail
```

**I5. bus/session-manager.ts `spawnPty`: delete `assertSessionSpawnable` (line 1137)**

```
error: expect(received).rejects.toThrow(expected)
Expected promise that rejects
Received promise that resolved: Promise { <resolved> }
(fail) SessionManager.spawnAgent and the quarantine gate > does not start claude on a session whose retirement began after the async gate passed [2261.63ms]
 12 pass
 1 fail
```

**I6. pty-quarantine.ts `assertSessionWritable`: `await confirmation` directly (drop the deadline/signal race)**

```
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > sendToLiveSession returns within its budget and keeps the quarantine [405.77ms]
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > sendToLiveSession returns aborted when the signal fires first [403.06ms]
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > the confirmation keeps running after the caller gave up, and releases a gone pid [52.74ms]
(fail) the gate honours the caller's deadline and abort > runOneShot gives the timed-out result within its budget and keeps the quarantine [404.12ms]
error: expect(received).toBeLessThan(expected)
Expected: < 100
Received: 202
(fail) the gate honours the caller's deadline and abort > runOneShot rejects with the abort when the signal fires first [405.44ms]
 8 pass
 5 fail
```

**I7. oneshot/engine.ts: call the gate with `{}` (no deadline, no signal)**

```
(fail) the gate honours the caller's deadline and abort > runOneShot gives the timed-out result within its budget and keeps the quarantine [404.99ms]
error: expect(received).toBeLessThan(expected)
Expected: < 100
Received: 201
(fail) the gate honours the caller's deadline and abort > runOneShot rejects with the abort when the signal fires first [404.00ms]
 11 pass
 2 fail
```

**I8. pty-supervisor.ts `sessionBlocked`: call the gate with `{}`**

```
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > sendToLiveSession returns within its budget and keeps the quarantine [404.23ms]
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > sendToLiveSession returns aborted when the signal fires first [404.37ms]
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) the gate honours the caller's deadline and abort > the confirmation keeps running after the caller gave up, and releases a gone pid [51.92ms]
 10 pass
 3 fail
```

Note: the fence is tested by I3 and I4 together; I3 alone reds two tests (the fence test and the
mid-retirement first-spawn test).

### Round 9: gates

- **Single process (CI)**: `env -u ANTHROPIC_BASE_URL bun test src > /tmp/r9-src.txt 2>&1`, final run
  exit 0, **4853 pass / 4 skip / 0 fail** (4857 tests, 261 files). It took five runs. None of the
  failures touched a file this round changed, and each run's failure differed:

  | Run | Failure(s) | Reading |
  |---|---|---|
  | 1 | `pty-config.test.ts` warn-once; `inject-turn-net.test.ts` (#215) | see below; second is a timing test |
  | 2 | `pty-config.test.ts` warn-once | stale settings file |
  | 3 | `jsonl-tailer.test.ts` `startAt: 'end'` (#215) | timing; 3 of 3 green alone |
  | 4 | `pty-process.test.ts` "a dialog that paints late..." (#469) | the same wall-clock flake round 8 hit once |
  | 5 | none | exit 0 |

  `pty-config.test.ts` fails on the round-8 head `cebf8bdb` too (same assertion, run in a `git archive`
  copy seeded with the same settings dir), so it is not round 9. Cause: `.claude/claudeclaw/settings.json`
  in the worktree (gitignored) held `{"pty":{"enabled":"review-550-invalid-a"}}`, a value left by an
  earlier aborted run of that very test (it restores from a backup in `afterAll`; an aborted run leaves
  the poisoned file, and the next run backs the poisoned file up and restores it). The warn-once cache
  then already counted that value. Deleting the file fixed it. CI starts from a clean checkout, so this
  was local state, not a CI risk. The remaining flakes are wall-clock tests under load (machine load
  average 5 to 11 from other workers throughout); I did not change them.
- **Wide PTY set** (every `.test.ts` under `src/` and `tests/` minus `tests/integration` matching the
  round-8 pattern, one process per file, `ANTHROPIC_BASE_URL` unset): normal **102 of 102** green on
  the first attempt (2,299 tests); `CLAUDECLAW_TEST_PLATFORM=linux` **102 of 102** green on the first
  attempt (2,299 tests). The `skills-fitness` judge-cooldown flake did not fire.
- `bun run lint` (full repo) exit 0; `bun run typecheck`: 149 errors, baseline 149.
- No real `claude` started.

### Round 9: not done / residuals (do not fix here)

1. **Quarantine is not in Telegram `/status`, and `/kill` reports before confirmation** (Codex round-8
   MEDIUM). Follow-up issue, filed by the coordinator.
2. Everything in "Round 8: not done / risks" still stands, except item 3 (the confirmation retry is now
   bounded by the caller's deadline and signal). The abandoned confirmation still runs to its end in
   the background.
3. The fence is keyed by the process object. A retirement of an entry whose `pty` is still null (spawn
   in flight) fences nothing; that case is covered by `isCurrentEntry`/`EntryRemovedError` and `landPty`,
   which fences the late PTY at its disposal.
4. `Date.now()` is used for the gate's deadline (the supervisor's `_clock` is converted at the call), so
   an injected test clock does not drive the gate's timer.

## Round 9 add-on: cron retries

Operator ruling (Terry, 2026-10-22): cron must not apply a job's `retry` to a PTY turn that failed
UNCERTAIN or TIMED OUT. Such a turn may have completed and done its side effects, and a retry can
repeat them. A definite failure still retries as configured.

### What changed

- `src/runner/pty-supervisor.ts`: `RunOnPtyResult.failureKind?: "uncertain" | "timeout"`, set where the
  supervisor maps the error to a result (`errorResult(message, exitCode, failureKind)`):

  | Outcome | exit | `failureKind` |
  |---|---|---|
  | `PtyTurnTimeoutError` | 124 | `timeout` |
  | `PtyTranscriptUncertainError` (no turn boundary), `PtyTurnFailedError` `ambiguous`, `TranscriptReplacedError`, `PtyPromptNotAcceptedError`, `PtyClosedError` with `promptSent`, unconfirmed boundary | 1 | `uncertain` |
  | `PtyTurnFailedError` `api-error` / `command-error` / `empty-reply`, `PtyTranscriptUnavailableError`, `PtyClosedError` never sent (respawn exhausted), spawn failure, quarantine refusal | 1 | absent |

- `src/runner.ts`: `RunResult.failureKind` carries it from the exec that produced the result, and only
  while `exitCode !== 0` (both the normal result and the post-compact retry result). The print engine
  never sets it. A named `ExecOutcome` type now covers `exec` and `execRecovery`'s return.
- `src/job-loop.ts`: when `r.failureKind` is set the job's `retry` is skipped, `retryState` is cleared,
  one line is logged (`Job <name> not retried: PTY turn <uncertain|timed out>, it may have completed`),
  and the failure is forwarded as before. A one-time job's schedule is cleared as for an exhausted
  retry. The loop reads only the structured field: no error-text match, no exit-code inference (124
  without the field still retries, and a test pins that).

### Tests (19 new)

- `job-loop.test.ts`: uncertain and timeout with `retry: 2` on a one-time job (no retry state, schedule
  cleared, failure forwarded, log line, `lastResult` error); recurring job keeps no retry debt; a
  definite failure with no field retries as before; exit 124 without the field retries.
- `runner.test.ts`: the field reaches `RunResult` from a failed exec, and is absent on a definite
  failure and on a success that carried it.
- `pty-supervisor.test.ts`: 11-row mapping table (6 marked, 5 definite), plus an unconfirmed boundary
  is `uncertain` and a success carries no field.

### Red-line evidence (one site per injection, `git archive` copy of `3d5b73c9`)

- **A. Ignore the field in the job loop** (`} else if (false && r.failureKind) {`), `job-loop.test.ts`:
  3 fail, 33 pass. First failure: `Expected: false` / `Received: true` (the retry state exists).
  Failing: both "retry: 2 is not used" rows and "a recurring job keeps no retry debt".
- **B. Do not set the field at the PTY mapping site** (`...(false && failureKind ? { failureKind } : {})`
  in `errorResult`), `pty-supervisor.test.ts -t "round 9 add-on"`: 7 fail, 5 pass. First failure:
  `Expected: "uncertain"` / `Received: undefined`. The 5 passing are the definite rows, which is right.
- **C. Do not carry the field into `RunResult`** (`...(false && exec.failureKind ? ...)`),
  `runner.test.ts -t "round 9 add-on"`: 1 fail, 1 pass. `Expected: "timeout"` / `Received: undefined`.

The real tree was never modified by an injection; its tests are GREEN (gates below).

### Gates (head `84a93994`)

- `env -u ANTHROPIC_BASE_URL bun test src > /tmp/cron-src.txt 2>&1`: exit 0, **4872 pass / 4 skip / 0 fail**.
- Wide PTY set (round-8 pattern, one process per file, `ANTHROPIC_BASE_URL` unset): normal **102 of 102**
  green on the first attempt (2,318 tests); `CLAUDECLAW_TEST_PLATFORM=linux` **102 of 102** green on the
  first attempt (2,318 tests).
- `bun run lint` exit 0 (the new tests first needed `biome format`; applied to the files I touched only).
  `bun run typecheck`: 149, baseline 149. The first version added 2 errors in `runner.ts` because
  `execRecovery`'s inferred return type was a union without the field; the `ExecOutcome` type fixed it.
- No real `claude` started. No rebase, no version bump.

### Not done / residuals

1. `execEphemeral`/one-shot and live-session paths do not go through the job loop; they are unchanged.
2. A `PtyClosedError` after the send is `uncertain` even when the process died instantly. We cannot tell
   from the error whether the prompt ran, so the safe reading is the one taken.
3. The 48-hour soak checklist (item 4, "expected notify/retry behavior") is not edited here; an uncertain or timed-out cron turn is now expected to show the "not retried" log line instead of a retry.
