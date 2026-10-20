# One-shot engines

Utility calls use `runOneShot` from `src/oneshot/engine.ts`. Every request must
declare `isolation: "untrusted"` or `isolation: "trusted-session"`, plus a positive
`timeoutMs`. With no explicit one-shot setting, the trusted resume routes
`compact`, `rotation.summary`, `memory.save.precompact` and `memory.save.stop`
use `pty` when `pty.enabled` is true, and `print` when false. The untrusted
routes (`discord.classifier`, `tuner.*`) follow `pty.enabled` too, but
only on a claude CLI at least 2.1.304, the build the interactive isolation was measured
on, and never on Windows; below that, when the version cannot be read at startup, or on
win32, they stay on `print` (one startup warning). `print` and `pty` are built in and
need no declaration. The HTTP engines below are built in too, and need their
settings.

These defaults are resolved at each call from the current settings, including
the daemon's approximately 30-second reload of `pty.enabled`. Parsed/generated
settings preserve an absent `oneShot.default`; an existing explicit `"print"`
default keeps print until you remove it or override its routes.

For example, this settings block explicitly selects ephemeral PTYs for trusted fallbacks:

```json
{
  "oneShot": {
    "default": "print",
    "engines": {},
    "routes": {
      "compact": "pty",
      "memory.save.precompact": "pty",
      "rotation.summary": "pty",
      "memory.save.stop": "pty",
      "tuner.*": "print"
    }
  }
}
```

These route settings apply only to one-shot fallbacks: trusted session actions
first ask the live PTY and resume one-shot only when no live process holds the
session. Each ephemeral PTY resumes the supplied session id in its supplied working
directory, uses an overall timeout, and is disposed afterwards. `/compact` is sent
as an exact bare REPL command; ordinary slash-shaped prompts retain the PTY guard.
The no-daemon shutdown save uses the stored global session id with a 30-second
budget. Exact routes override a namespace wildcard, then an explicit
`oneShot.default`, then the implicit route default applies. The implicit default
is `pty` when `pty.enabled` is true (`print` otherwise, including the Windows
default) for the trusted resume routes **and** for the untrusted routes
(`discord.classifier`, `tuner.*`) while the claude version gate
below holds. `claude -p` still runs in the default configuration whenever the
gate or `pty.enabled` says print, for the tuner's `claude_cli` backend, which
always selects print, and for memory recall, which does not go through `runOneShot`
at all: it runs in Python (#545) and spawns `claude -p` itself. Unknown engines and incompatible capabilities fail settings
load.

The PTY engine advertises `caps.isolation: true` (#570). The interactive isolation
spike ([`docs/spikes/0.7-interactive-isolation.md`](spikes/0.7-interactive-isolation.md))
ran against Claude Code 2.1.304 and every property held with its control present and
failed with its control removed: tools, MCP, settings/hooks, user memory, the
slash-command flag, transcript cleanup and the child environment. A plain
interactive spawn with no controls fired every canary, so the fixtures are
discoverable. Any untrusted route to an engine without the capability is still
rejected, and an HTTP engine stays an explicit opt-in. Reverting the flag in
`src/oneshot/registry.ts` does not close the gate, because `applyPtyIsolationVersionGate`
(`src/oneshot/claude-version.ts`) overwrites `pty.caps.isolation` at startup. To roll the
untrusted routes back to print, pin them in settings and restart the daemon:
`"oneShot": { "routes": { "discord.classifier": "print", "tuner.*": "print" } }`
(an explicit route beats the implicit default, and `print` advertises isolation, so settings
load accepts it). Alternatively, raise `MIN_PTY_ISOLATION_CLAUDE_VERSION` in
`src/oneshot/claude-version.ts` above the installed claude and restart, which is a code
change. One caveat is recorded in the
spike: a prompt that tells a tool-less session to run a tool sometimes gets no reply.
It is bounded by the caller's timeout and fails closed: the classifier (the `haiku` alias)
allows 12 s per attempt and retries exactly once, and only when an attempt timed out or got no
reply (a diagnostic reason of `timeout` or `no-reply*`; on `print`, exit 124). Every other
failure (`not-ready:*`, `config-dir`, `config-root`, `turn-error`, `busy`) repeats itself, so it
stands after one attempt. A call is bounded at about 24 s plus teardown, and a failure that
stands is treated as "not a thread command". Retiring the child (an abort, a deadline) or the
child exiting ends the REPL-ready wait at once. A call that throws (a cleanup that could not
remove the prompt) is not retried. At most 2 untrusted PTY one-shots run at once
(`UNTRUSTED_ONESHOT_MAX_CONCURRENT`, in process, not a setting): a third returns `busy` without
spawning anything, and the classifier gets null for it. A slot follows the child, not the call:
it is held while a claude of that call may still be alive and freed only on positive evidence
that it is gone. A call whose claude is still being admitted when its deadline passes keeps the
slot until that claude has landed and been retired (past `UNTRUSTED_LATE_SLOT_CEILING_MS` it only
logs `one-shot slot held past ceiling: retirement pending`; it does not free). A call whose claude
survived retirement, or left a process the escape scan could not read (an unknown hold), hands its
slot to that record. The slot is released once, when neither a survivor nor an unknown hold is left
for the root: the sweeper's identity-checked retry confirms the survivor gone, and prunes a hold
whose processes have exited. Survivors and holds a restarted daemon adopts from `survivor.json`
(holds are persisted in its `unknown` list) count against the cap the same way. A held slot makes a new call `busy`
(fail closed); one whose retirement never settles stays held until the daemon restarts.

An API-key-only host is not covered: untrusted routes carry no API-key defaults, and the
throwaway config root has no login, so on claude 2.1.304 or later with `pty.enabled` the
spawn stops at `not-ready:login-required` and the classifier returns null for every message.
That is by design. The fix for such a host is the rollback pin above (`print` for
`discord.classifier` and `tuner.*`). An untrusted
PTY call returns the model's reply read from the session transcript, never the rendered
screen (which echoes the prompt); if no reply appears it exits 1, or 124 when the caller
aborted or its own deadline ran out during the wait. Trusted routes keep the screen text.
Routes that carry untrusted text also reject any isolation other than `untrusted`.

What an untrusted PTY call does that print does not need to (all measured, see the spike
doc): it runs in a throwaway config root, so it writes nothing about the call under the
operator's own (`~/.claude`, `~/.claude.json`). The one write outside the throwaway root
is claude's own refresh of the operator's OAuth token into the operator's credential store
(no prompt data; it takes the same `.oauth_refresh.lock` as the daemon's own claude, see
the spike doc). Each call makes a `claudeclaw-oneshot-cfg-*` directory
(0700, next to the temp cwd) with a minimal `.claude.json` (onboarding done, the temp cwd
trusted), sets `CLAUDE_CONFIG_DIR` to it, and sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to the
operator's own config directory (`""` when none is set) so claude still logs in as the
operator; no credential is copied. Everything claude writes about the prompt (transcript,
history, paste cache, session files) lands in that root, and the root is removed in the
call's `finally` and again after a late spawn settles. The call's claude is retired with
its whole process group (SIGTERM, then SIGKILL after 2 s, each awaited until `kill(-pid, 0)`
answers ESRCH) before the root is removed. Immediately before every signal the pid's start
time (Linux: `/proc/<pid>/stat` field 22, which a clock step does not move; macOS: `ps`) is
compared with the one recorded at spawn, and the group is signalled once, not the bare pid as
well. That narrows pid reuse to the instant between the check and the `kill()`; it cannot
close it without a native process handle, and none is built. On
Linux a descendant that left the group (`setsid()`, `setpgid()`) is found afterwards by the
throwaway `CLAUDE_CONFIG_DIR` in its environment, or a cwd inside the throwaway temp cwd, and
stopped the same way. Only a process that started after the child can be ours: its start time
is read from `/proc/<pid>/stat` field 22, which stays readable even for a non-dumpable process,
and an older process of our uid is foreign whether or not it can be read. The scan fails closed
where it can: a `/proc` that cannot be listed counts as a survivor. A process born after the
child whose `environ` and `cwd` both cannot be read is "unknown": it is logged (pid, errno of
each read, whether the daemon is an ancestor, age relative to the child; nothing else), the call
still returns its reply, and the root and temp cwd are kept, with the process and its start time
in `survivor.json`, until it is gone (a dead or recycled pid counts as gone). A process that
positively matches and will not die still fails the call. **On macOS there is no cheap equivalent: containment there is the
process group plus the remove-and-recheck loop, and a process that leaves the group and keeps
writing is not stopped.** If the group, or anything outside it, will not die, the call fails
and the root and temp cwd are kept, with a `survivor.json` (pid, start time, cwds) in the root;
the sweeper signals the survivor again every pass and never sweeps them while it is recorded.
After a daemon restart the sweep reads `survivor.json` before it removes anything: a recorded
group (checked with its identity) or an escapee still running, or a `/proc` it cannot list, puts
the root back on the survivor list; a recorded unreadable process still alive puts it back as a
hold instead of removing it. The prompt is written only into a REPL that is ready
(footer on the current screen, no login, onboarding or trust screen after one quiet window);
otherwise the spawn fails and nothing is sent. If the root cannot be created or removed the call fails (the error is logged by step
and code, never content). Each root and temp cwd holds an owner file (daemon pid, start time,
instance). A daemon start, and then every ten minutes, removes leftover
`claudeclaw-oneshot-cfg-*` and `claudeclaw-oneshot-pty-*` temp directories that are older
than ten minutes, belong to this uid, are not a running call of this daemon, and whose
owner is dead (a directory with no owner file at all falls back to the age rule; one whose
owner file or `survivor.json` cannot be read or understood is quarantined: logged once by
name, and removed only after 24 h and only if the escape scan finds no matching process in it). It applies the spawn strip list (`ANTHROPIC_API_KEY`,
`CLAUDECODE`, short-lived OAuth tokens) to the caller's env, because an interactive
claude with an API key in its env stops at a "custom API key" gate; it replaces every `@`
in the prompt with U+FF20, because the REPL expands `@path` mentions itself, anywhere in a
prompt, which `--tools ""` does not stop. The reply gets its `@` back (U+FF20 becomes `@`)
for every untrusted call on print and pty, in one place, so a skill file the tuner proposes
keeps `@scope/pkg`, e-mail addresses and decorators. With `CLAUDECLAW_PTY_DUMP` set, an
untrusted PTY traces metadata only (tag and length), never the prompt or the screen. The
`req.system` text is passed as `--system-prompt`, as print does.

Settings load does not depend on the startup probe: an explicit `pty` route for an untrusted
route is accepted at load, and refused at the call while the version gate has not enabled
isolation (the gate needs claude 2.1.304 or newer, and not Windows, and runs once, at startup).

Trusted calls may supply `cwd` for session lookup, including named-agent working
directories. Both engines honour it. Untrusted calls cannot specify `cwd`, resume
sessions or specify allowed tools. The print engine
uses the canonical no-tools/no-MCP/no-settings flags, a fresh empty working
directory and cleanup after exit. On print, untrusted prompts are always delivered on
stdin, never in argv, so a prompt shaped like a flag cannot be parsed as one; on pty the
prompt is typed into the REPL, never put in argv either. The classifier preserves its environment
allowlist; the tuner preserves `cleanSpawnEnv()`. Python memory recall retains
the #545 implementation, with a test checking exact isolation-flag parity.

The tuner accepts `llm.backend: "oneshot"` to follow route settings.
`llm.backend: "claude_cli"` is a compatibility alias that always selects print.
The per-call limit is `llm.timeout_ms` (default 600000, ten minutes); a failed
call reports `claude CLI exited <code>` with the first 200 characters of stderr,
with credentials masked.
Claude CLI engines accept `maxTokens` for interface compatibility but have no
CLI flag to enforce it. Each dispatched call logs route, engine, model, isolation,
elapsed milliseconds, exit code and usage counts when the engine reports them.

## HTTP engines

Three stateless engines run the untrusted routes without the `claude` CLI. Today
that means `discord.classifier` and `tuner.*`; `memory.recall` accepts an HTTP
engine in settings but still runs in Python on the CLI (#545), so the route has no
effect yet.

- `openai-compatible`: `POST {baseUrl}/chat/completions` with `model`, `messages`
  (`system` + `user`) and `max_tokens` when the caller sets `maxTokens`. Covers
  OpenRouter, vLLM, LM Studio, llama.cpp server and Ollama `/v1`.
- `ollama`: the same engine with `baseUrl` defaulting to `http://127.0.0.1:11434/v1`.
- `llm-router`: delegates to the router's `callLlm` with a `tier` (`fast`, the
  default, `balanced` or `reasoning`), so it uses the `llmRouter` tiers and base URL
  the web UI edits, with the same model fallback on 429/5xx.

All three advertise `caps = { resume: false, tools: false, isolation: true }`:
a resume route (`compact`, `memory.save.*`, `rotation.summary`) or a default that
resolves to one of them fails settings load. The request body has no `tools` or
`tool_choice`; only the text content of the reply is read, and any `tool_calls`
is ignored, never executed. The engine uses its configured model; the Claude model
a caller names is not sent. `timeoutMs` and the caller's `signal` abort the request
(exit code 124, as with `print`); a non-2xx reply, a network error or empty content
returns exit code 1 and logs one `[oneshot]` line with the route, engine and status,
never the request, the reply body or a key.

A key is never written to `settings.json`: `apiKeyEnv` names the environment variable
that holds it. Unset or empty, no `Authorization` header is sent (local servers);
set, it is sent as `Bearer <value>`. `llm-router` reads `OPENROUTER_API_KEY` unless
`apiKeyEnv` says otherwise.

`oneShot.engines.<name>` configures an engine. Under a built-in name it configures
that engine; under any other name, `type` names the built-in it runs on, so one
install can have several:

```json
{
  "oneShot": {
    "engines": {
      "local": { "type": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:4b" },
      "openrouter": {
        "type": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "model": "google/gemini-2.5-flash",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      },
      "llm-router": { "tier": "fast" }
    },
    "routes": {
      "discord.classifier": "local",
      "tuner.*": "openrouter"
    }
  }
}
```

Settings load checks every engine declared or used: an unknown `type`, a missing
`baseUrl` or `model`, a URL that is not http(s), an `apiKeyEnv` that is not a
variable name, or any unknown key (an `apiKey` included) fails the load. Route keys
are a closed list: a route not in `KNOWN_ROUTES` (or a family wildcard such as
`tuner.*`) fails the load instead of being ignored.

Run unit contracts with `bun test src/oneshot`. The adversarial live CLI test is
opt-in: `ONESHOT_E2E=1 bun test src/oneshot/e2e.test.ts`. It checks actual CLI tool
events and newly created `/tmp/oneshot-canary-*` files. It uses the operator's
Claude authentication and can consume subscription quota. It covers print only.
PTY isolation is covered by `tests/integration/untrusted-pty-isolation.test.ts`, which
runs on a real claude in the integration workflow.
