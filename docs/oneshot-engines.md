# One-shot engines

Utility calls use `runOneShot` from `src/oneshot/engine.ts`. Every request must
declare `isolation: "untrusted"` or `isolation: "trusted-session"`, plus a positive
`timeoutMs`. The default engine is `print`; `print` and `pty` are built in and
need no declaration.

For example, this settings block selects ephemeral PTYs for trusted fallbacks:

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

These route settings apply when callers use `runOneShot`; migrating the trusted
live-session callers belongs to #549. Exact routes override a namespace wildcard,
then the default applies. Unknown engines and incompatible capabilities fail
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

Run unit contracts with `bun test src/oneshot`. The adversarial live CLI test is
opt-in: `ONESHOT_E2E=1 bun test src/oneshot/e2e.test.ts`. It checks actual CLI tool
events and newly created `/tmp/oneshot-canary-*` files. It uses the operator's
Claude authentication and can consume subscription quota. PTY isolation is
deliberately excluded until the separate spike is green.
