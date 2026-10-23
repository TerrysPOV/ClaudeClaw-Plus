# One-shot engines

Utility calls use `runOneShot` from `src/oneshot/engine.ts`. Every request must
declare `isolation: "untrusted"` or `isolation: "trusted-session"`, plus a positive
`timeoutMs`. With no explicit one-shot setting, the trusted resume routes
`compact`, `rotation.summary`, `memory.save.precompact` and `memory.save.stop`
use `pty` when `pty.enabled` is true, and `print` when false. All other routes
still default to `print`. `print` and `pty` are built in and
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
`oneShot.default`, then the implicit route default applies. A default of `pty`
must also explicitly route the untrusted families to an isolated engine such as
`print`; validation otherwise rejects it. Unknown engines and incompatible capabilities fail
settings load. Untrusted PTY routes fail both settings validation and execution
until the interactive CLI isolation spike is reviewed green: the PTY engine
advertises `caps.isolation: false`, and any untrusted route to an engine without
that capability is rejected. There is no settings switch that bypasses this gate.
Routes that carry untrusted text (`discord.classifier`, `tuner.*`,
`memory.recall`) also reject any isolation other than `untrusted`.

Trusted calls may supply `cwd` for session lookup, including named-agent working
directories. Both engines honour it. Untrusted calls cannot specify `cwd`, resume
sessions or specify allowed tools. The print engine
uses the canonical no-tools/no-MCP/no-settings flags, a fresh empty working
directory and cleanup after exit. Untrusted prompts are always delivered on stdin,
never in argv, so a prompt shaped like a flag cannot be parsed as one. The classifier preserves its environment
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
Claude authentication and can consume subscription quota. PTY isolation is
deliberately excluded until the separate spike is green.
