# PTY is the default engine

On upgrade, a missing `pty.enabled` setting now selects the interactive Claude
PTY engine for runner agent turns and scheduled jobs. Bootstrap, model fallback
and the one-attempt retry after a stale session follow that setting too. An
existing literal `false` is preserved. Invalid values such as `"false"` warn and
use the platform default (`true`, or `false` on Windows).

Two recovery behaviours differ from print mode:

- **No auto-compact on timeout.** A PTY turn that times out returns exit 124 and
  the supervisor retires that PTY, but the runner does not save memory, run
  `/compact` or re-run the prompt. A PTY timeout is often a missed turn-end on a
  healthy session, so re-running could repeat tool side effects, and the
  interactive REPL compacts its own context. The save, `/compact` and re-run
  recovery applies to the print path only.
- **Corrupted-session reset needs two signals.** A session is reset after an
  "Invalid signature in thinking block" error on the PTY only when the rendered
  error ends the turn AND the session transcript's last entry is the CLI's own
  API-error entry (`isApiErrorMessage`). Reply text that merely quotes the error
  does not reset it, whatever the exit code. The print path keeps its non-zero
  exit rule.

Prompts that start with `/`, `!`, `#` or `@`: on the PTY engine a prompt whose
first non-space character is one of these is sent with a leading space, so the
REPL does not read it as a slash command, a shell command, a memory note or a
file mention. Only the daemon's own `/compact` is exempt. Chat prompts normally
start with the clock line anyway, so this matters mainly for scheduled-job and
dispatched-job prompts.

On Windows (`win32`) runner turns also stay on print (`claude -p`) by default,
for the same reason as the bus fallback below: nothing in this codebase shows
the PTY path working there, and `claude` resolves to a `.cmd` wrapper. Opt in
with an explicit `pty.enabled: true`. The default is `defaultPtyEnabled` in
`src/config.ts`. This does not touch declared bus agents: they already run
`pty-stdin` on Windows, as on every platform (the resolver default).

Agents spawned without the settings resolver now default to `pty-stdin` for
every origin, including cron, heartbeat, CLI and REST. The exception is Windows:
nothing in this codebase shows the PTY path working there, so the non-channel
origins keep `process-stream-json` on `win32` (`defaultSupervisionFor` in
`src/bus/types.ts`). Declared agents processed
by `resolveBusAgentConfig` already defaulted to PTY; this change affects agents
that relied on the origin fallback to select print. Non-channel
deliveries use the existing delivery-confirmation loop: typing Enter alone does
not count as successful delivery. Dispatched-job results use the `cron` origin
and an `agent-job:` identifier and pass through the same loop.

## Keep print mode

Trusted one-shot fallbacks follow `pty.enabled` too: `/compact`, rotation summaries,
precompact memory saves and shutdown memory saves use ephemeral PTYs when no live
PTY holds their session. With `pty.enabled: false` they default to print. Explicit
`oneShot.routes` (including family wildcards) and `oneShot.default` settings take
precedence; remove an existing `oneShot.default: "print"` to adopt these defaults.
These choices follow the same approximately 30-second hot reload as runner turns.
Untrusted classifier and tuner routes follow `pty.enabled` too on a
claude CLI at least 2.1.304 (not on Windows), where the interactive isolation spike is green; on an
older or unreadable version they stay on print. Memory recall is not one of them: it does not
reach `runOneShot`, and runs in Python (#545), which still spawns `claude -p`. See [One-shot engines](oneshot-engines.md).

`claude -p` remains supported. Set both the runner opt-out and explicit bus-agent
supervision overrides in `.claude/claudeclaw/settings.json`:

```json
{
  "pty": { "enabled": false },
  "agents": [
    { "id": "default", "supervision": "process-stream-json" }
  ]
}
```

Preserve the other fields in your settings and repeat the supervision override
for every bus agent you want on print. `pty.enabled` controls runner turns and
cron jobs; each bus agent's `supervision` controls that bus agent independently.
Changing one does not change the other.

Runner paths read `pty.enabled` on each turn. The daemon reloads settings about
every 30 seconds, so a flip applies to subsequent runner turns and cron jobs
after that reload. Bus-agent supervision and runtime selection require a
restart: changing settings on disk does not replace their existing processes.
Restarting also produces a fresh startup summary of the engine choices.

## Verify the switch

With defaults, the startup summary contains:

```text
Engines: agent turns=pty; cron jobs=pty; bus non-channel default=pty-stdin; bus agents=default=pty-stdin
```

Explicit print settings appear as `print` and `process-stream-json` respectively.
The agent list reflects each declared override. Check the actual bus spawn lines
and PTY-supervisor spawn/turn logs after sending a chat message and running a due
job; a startup setting alone does not prove a successful turn.

Inspect process flags locally. This command reports PID and mode while keeping
the rest of the command line out of the output:

```sh
uv run --no-project python - <<'PY'
import os, shlex, subprocess
for row in subprocess.check_output(["ps", "-axo", "pid=,args="], text=True).splitlines():
    try:
        pid, command = row.strip().split(None, 1)
        argv = shlex.split(command)
    except ValueError:
        continue
    if argv and os.path.basename(argv[0]) == "claude":
        print(pid, "print" if any(a in ("-p", "--print") for a in argv[1:]) else "no print flag")
PY
```

The Claude processes serving default agent turns and cron jobs should have no
`-p` or `--print` flag. Match the PID to the corresponding spawn log. Explicit
print overrides and utility one-shot calls can legitimately show print mode.
Utility migrations are managed separately by #548/#549; they are not controlled
by this default change.

## MCP servers are per PTY unless the multiplexer runs

With PTY as the default, every PTY session loads your own MCP servers in its own
process. The shared MCP multiplexer avoids that, but it is opt-in and dormant by
default: it needs servers listed in `settings.mcp.shared`, matching entries in
`~/.config/claudeclaw/mcp-proxy.json` (see [`mcp-proxy.md`](mcp-proxy.md)) and
`web.enabled: true`. When `pty.enabled` is true and the multiplexer is not
running (shared list empty, web disabled, or it started dormant), startup logs
one `[mcp-multiplexer] pty.enabled is true but the multiplexer is not running`
warning naming the reason. It is logged once at startup, not per turn. On a
small machine, enable sharing or set `pty.enabled: false`.

## Rollout requirements

Issue #559 (fresh PTY chat input with the runner's timestamp prefix could stay
unsubmitted until timeout) is fixed by #563, which this branch contains. One
visible side effect of that fix: every prompt is submitted to the Claude TUI as a
bracketed paste (`runTurn` wraps each one in the paste markers), so the terminal
may show it as a pasted block instead of as typed text. The turn is still
submitted and runs as normal.

The operator must complete the 48-hour soak in the issue #550 implementation
report, covering chat, cron jobs, dispatched jobs, a restart and compaction, and
confirm the #559 fix live. The README's "Execution Modes and Engine Policy"
section documents the new defaults.
