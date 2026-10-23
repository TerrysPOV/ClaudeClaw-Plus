# Issue 572 implementation report

Implemented on feat/572-oneshot-pty-routes, stacked on povai/feat/550-pty-default at fa2c625d32e5. The four trusted resume routes now implicitly follow the current runner PTY setting; explicit route, wildcard and default choices still win. No untrusted routing capability changed.

## Changes

| File | Change |
| --- | --- |
| [config.ts](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/config.ts:4) | Preserve an absent explicit default rather than manufacture print; settings serialize without accidentally pinning print. |
| [resolver](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/config.ts:38) | Exact route, family wildcard, explicit default, then PTY for the four trusted resume routes only when enabled; otherwise print. |
| [engine.ts](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/engine.ts:60) | Read pty.enabled alongside the current loaded settings on each call, so daemon hot reload affects dispatch. Standalone unloaded tuner behavior stays print. |
| [trusted-routes.test.ts](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/trusted-routes.test.ts:32) | Four routes × both enable states, explicit overrides, wildcards, serialization, untrusted default/rejection, live reload, real not-live compact dispatch and shutdown deadline. |
| [engine contracts](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/src/oneshot/engine.test.ts:99) | Explicit print settings for print-engine contracts; updated absent-default parser contract. |
| [one-shot guide](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/docs/oneshot-engines.md:3) | New defaults, override precedence, existing explicit-print migration, resume/timeout/bare compact. |
| [migration guide](/Users/terrenceyodaiken/orca/workspaces/claudeclaw-plus/Sol/docs/pty-migration.md:43) | Trusted utility defaults and hot reload, untrusted gate unchanged. |
| Plugin and marketplace manifests | Plugin, marketplace plugin and marketplace top-level version all set to 2.2.344 as requested. |

OneShotRequest, OneShotResult and engine capability contracts are unchanged. Only the internal OneShotSettings.default becomes optional to distinguish absence from explicit print. With existing explicit oneShot.default=print, print remains selected; remove that setting or add route overrides to opt into the new defaults.

## Caller/session audit

- Compact: runner runCompact forwards the explicit session id, cwd and model through actOnSession. Agent and thread entry points already supply their own cwd/key. actOnSession only falls back after not-live, or after awaited skipLive retirement; failed live sends still never start a second writer.
- The integration test seeds a different primary session plus an agent fallback store, then calls runCompact on fallback:agent:suzy. The real runOneShot and PTY supervisor spawn receive fallback-to-resume and the supplied agent cwd, not the primary id or a new conversation. The fallback store remains unchanged. A throwing print spawn prevents any accidental real CLI call.
- Ephemeral PTYs use resumeSessionId directly (pty-supervisor.ts:1429); they do not select a primary/fallback session store or infer identity from the ephemeral key. No agentName addition to the frozen one-shot request is needed: callers supply session id and cwd explicitly.
- Compact already sets allowReplCommand only for its route (pty-supervisor.ts:1708); the existing PTY process exact-match guard makes only /compact bare. The integration asserts the exact prompt and flag; existing trusted PTY tests retain the slash-command guard proof.
- Rotation generateSummary acts on its explicit old session id with no tools. Its current rotation caller is global, with the repository cwd. Precompact memory/compact recovery in this stacked base is print-path-only after timeouts; callers pass their existing session id, spawn cwd, model and tool grant. The new implicit behavior preserves their print route when pty.enabled=false; explicit one-shot overrides remain possible.
- Stop: CLI invokes saveGlobalMemoryOneShot with 30,000ms when its daemon PID is stale/reused; the missing-PID early exit is unchanged. The save helper loads settings and resumes the stored global session in the project cwd. The new test exercises that production helper with no daemon and a hung PTY double: it resumes stored-stop-session, reaches its total deadline and disposes once. The initial dummy never rejected on disposal and was corrected to model real PTY disposal before validation; no production timeout change was needed.
- The existing [oneshot] structured log already includes route and selected engine; implicit PTY dispatch uses that same log.
- No Ultra implementation was reused. This change fits the existing Plus resolver and resume support.

## Validation

Tests ran with ANTHROPIC_BASE_URL unset and output redirected to logs; no runner output was piped into head/tail. Temporary cwd plus a src symlink protects local runtime state from existing cleanup behavior. Scope was src/oneshot and the three caller files below; no full suite or paid CLI calls.

| Command | Result |
| --- | --- |
| env -u ANTHROPIC_BASE_URL bun test --cwd <temporary> --preload <repo>/scripts/test-preload.ts <repo>/src/oneshot <repo>/src/__tests__/live-session-actions.test.ts <repo>/src/__tests__/pty-default-runner.test.ts <repo>/src/__tests__/shutdown-memory-save.test.ts | **227 pass, 4 skip, 0 fail** |
| Whole repo bun run lint --reporter=json | exit 0; 0 errors, 1291 warnings, 324 informational diagnostics |
| bun run typecheck | exit 0; 149 errors against baseline 149, no regression |
| git diff --check | clean |
| mark-tests-written.sh | successful |
| TEST_ARGS=<the scoped paths> mark-tests-passing.sh, TEST_CMD selecting isolated Bun cwd; whole repo lint included | successful; log /tmp/572-sdc.log |

One preliminary gate invocation used Bun's unsupported ordering before the test subcommand and failed with Script not found test. It was rerun as bun test --cwd and the complete gate passed. The first typecheck found a missing required model in the integration test; adding the fixture model restored the ratchet without changing its baseline.

## TDD and fault injection

Before implementation, the four enabled route defaults, hot reload, real not-live compact dispatch and no-daemon save tests failed (17 pass / 7 fail). After implementation, twelve independent single-site mutations made the assertions below fail as predicted, then were restored. Five intermediate probes invalidated by an ambiguous capability restoration failed during import; they were discarded, both original capability lines were restored and diff-verified, and all five probes were rerun to produce the valid assertion RED lines below. Final combined tests and gates ran on restored production code; registry.ts and pty-supervisor.ts have no diff.

### implicit-pty

```text
(fail) #572 trusted route defaults > compact: pty.enabled=true selects pty [8.81ms]
(fail) #572 trusted route defaults > memory.save.precompact: pty.enabled=true selects pty [0.32ms]
(fail) #572 trusted route defaults > rotation.summary: pty.enabled=true selects pty [0.08ms]
(fail) #572 trusted route defaults > memory.save.stop: pty.enabled=true selects pty [0.05ms]
```

### implicit-print

```text
(fail) #572 trusted route defaults > compact: pty.enabled=false selects print [0.60ms]
(fail) #572 trusted route defaults > memory.save.precompact: pty.enabled=false selects print [0.08ms]
(fail) #572 trusted route defaults > rotation.summary: pty.enabled=false selects print [0.06ms]
(fail) #572 trusted route defaults > memory.save.stop: pty.enabled=false selects print [0.04ms]
```

### route-override

```text
(fail) #572 trusted route defaults > compact: explicit route overrides either PTY setting and default [0.55ms]
(fail) #572 trusted route defaults > memory.save.precompact: explicit route overrides either PTY setting and default [0.08ms]
(fail) #572 trusted route defaults > rotation.summary: explicit route overrides either PTY setting and default [0.06ms]
(fail) #572 trusted route defaults > memory.save.stop: explicit route overrides either PTY setting and default [0.05ms]
```

### default-override

```text
(fail) #572 trusted route defaults > compact: explicit default overrides either PTY setting [1.00ms]
(fail) #572 trusted route defaults > memory.save.precompact: explicit default overrides either PTY setting [0.08ms]
(fail) #572 trusted route defaults > rotation.summary: explicit default overrides either PTY setting [0.06ms]
(fail) #572 trusted route defaults > memory.save.stop: explicit default overrides either PTY setting [0.05ms]
```

### wildcard-override

```text
(fail) #572 trusted route defaults > explicit family wildcard overrides the implicit default [23.02ms]
```

### untrusted-default

```text
(fail) #572 trusted route defaults > discord.classifier: stays print and rejects PTY [0.46ms]
(fail) #572 trusted route defaults > tuner.propose: stays print and rejects PTY [0.06ms]
(fail) #572 trusted route defaults > tuner.judge: stays print and rejects PTY [0.05ms]
(fail) #572 trusted route defaults > memory.recall: stays print and rejects PTY [0.05ms]
```

### untrusted-isolation

```text
(fail) #572 trusted route defaults > discord.classifier: stays print and rejects PTY [2.61ms]
(fail) #572 trusted route defaults > tuner.propose: stays print and rejects PTY [0.17ms]
(fail) #572 trusted route defaults > tuner.judge: stays print and rejects PTY [0.08ms]
(fail) #572 trusted route defaults > memory.recall: stays print and rejects PTY [0.06ms]
```

### settings-roundtrip

```text
(fail) #572 trusted route defaults > serialized implicit settings do not become an explicit print default [7.59ms]
```

### hot-reload

```text
(fail) #572 trusted fallback dispatch > reload changes implicit dispatch without re-parsing an explicit default [78.50ms]
```

### compact-resume

```text
(fail) #572 trusted fallback dispatch > not-live compact uses PTY with the supplied agent/fallback session and bare command [81.86ms]
```

### compact-command

```text
(fail) #572 trusted fallback dispatch > not-live compact uses PTY with the supplied agent/fallback session and bare command [85.62ms]
```

### shutdown-deadline

```text
(fail) #572 trusted fallback dispatch > no-daemon shutdown save resumes the stored session and bounds a hung PTY [2127.20ms]
```

## Remaining and manual checks

No requested implementation remains. No PR commands, GitHub writes or Orca lifecycle messages were used. README and the unrelated untracked 559 SPEC remain untouched. No live Claude, production stop or platform-specific session verification was performed; the four skipped tests require opt-in CLI usage. Operator smoke/soak and parent-branch rollout gates remain external. Security review found no critical/high issue: implicit PTY applies only to trusted known resume routes, validation still rejects untrusted PTY, and no prompt/credential logging was added.
