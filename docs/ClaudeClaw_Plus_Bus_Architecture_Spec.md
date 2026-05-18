# ClaudeClaw+ Bus Architecture — Engineering Spec

**Status:** Draft v2.2 — incorporates Sprint 0 empirical findings
**Author:** Claude (POVIEW.AI engineering assist) — v1: 2 May 2026 — v2: 17 May 2026 — v2.1: 17 May 2026 (Nibbler review) — v2.2: 17 May 2026 (Sprint 0 spikes complete)
**Target audience:** Coding agent / engineer implementing the refactor; ClaudeClaw+ maintainers and contributors
**Supersedes:** PTY stdin/stdout runner (`src/runner.ts` PTY codepath, `src/runner/pty-*.ts` helpers)

### What changed in v2

- **Sprint 0 de-risking spikes** added (§10.0): permission-prompt flow, JSONL schema snapshot, IPC primitive choice — must complete before Sprint 1.
- **tmux moved from required to optional** (§5.3): process supervision + stdio control is the default; tmux is an opt-in operator convenience on Unix only. Removes Windows friction (was Open Q §14.4).
- **IPC mechanism hardened** (§5.4, §14.3): explicit UDS path conventions, permission bits, atomic create pattern, and a localhost-TCP+token fallback when UDS / named pipes are not viable.
- **Plugin API migration formalised** (§11.7, §12.5 new): translation shim spec, deprecation timeline, plugin-author migration guide as a Sprint 4 deliverable.
- **Sprint estimate revised** (§10, §13): ~3 weeks full-time / ~8–10 weeks at part-time cadence (was 5 sprints/5 weeks part-time — under-estimated Sprint 3 reality).
- **Empirical motivation** added (§2): three PTY-parser regressions in two months (issues #81, #84, #105), with #105 explicitly traceable to TUI markdown-code-fence rendering — the structural class the Bus eliminates.

### What changed in v2.2 (Sprint 0 spike findings — see PR #109)

All five Sprint 0 spikes complete. Each produced a finding doc + supporting probe scripts + JSONL/log fixtures. Cross-cutting empirical corrections:

- **§5.3 supervision default flips back to PTY-stdin.** `claude` gates the REPL on `process.stdin.isTTY` and `process.stdout.isTTY` (binary-confirmed via `strings` on 2.1.143). Plain `Bun.spawn({stdin:'pipe'})` auto-downshifts to `--print` mode in ~3 s with exit code 1 and discards the slash command. `bun-pty` works as expected. The default supervision uses `bun-pty` for stdin TTY emulation; `stdout: 'ignore'` ensures we never look at TUI bytes — reads still come from JSONL. The Bus's "no TUI byte parsing" claim survives intact; the PTY layer here is *control input only*.
- **§5.2 lifecycle markers don't exist as named JSONL types.** Empirically: `/compact` → `{type:'system', subtype:'compact_boundary', compactMetadata:{trigger, preTokens, postTokens, durationMs}}`. `/clear` is **rotation** (new session UUID, new JSONL, old file frozen with no marker) — detect via `fs.watch('add')` on project dir. `/quit` → `<command-name>/exit</command-name>` envelope + farewell. Drop `session.init`/`session.end`/`session.compact` line types; use the fallback inference logic per Spike 0.5.
- **§5.2 system is a container; subtype is the discriminator.** 9 subtypes captured: `compact_boundary`, `turn_duration`, `stop_hook_summary`, `away_summary`, `informational`, `local_command`, `scheduled_task_fire`, `bridge_status`, `api_error`. Tailer dispatches on `system.<subtype>`, not `system` alone.
- **§5.1 permission flow shape corrected** (Spike 0.1, validated against aerolalit's reference plugin). Outbound payload field is **`behavior`** not `decision`. `reason?` has no evidence — dropped. BOTH `claude/channel` AND `claude/channel/permission` capabilities required. `request_id` charset `[a-km-z]{5}`.
- **§5.4 IPC path budget off by 4 bytes** (Spike 0.3). Atomic-create's `<path>.tmp` overflows on a 100-byte path. Correct cap: final ≤ 96B. Windows default flips to TCP+token (Bun lacks SDDL API + open panic bug on busy pipes).
- **§5.2 tool_result extraction reuse.** `src/runner.ts:923-934` already does the inside-`user.message.content[]` extraction correctly — Sprint 2 ports verbatim.
- **§5.2 macOS `/tmp` symlink gotcha** — Tailer must `realpath` cwd before computing the encoded JSONL path. `/tmp/foo` and `/private/tmp/foo` are the same directory but encode differently.
- **§5.2 additional types** beyond Nibbler's list: `pr-link`, `agent-name`, `custom-title`, `queue-operation`. `tool_result.content` is **string OR array** (array when result includes images) — tailer needs `typeof === 'string'` guard.
- **§5.2 `permissionMode` is dual-nature** — a field on `user` lines AND a discrete `permission-mode` event type (latter only on actual changes, only in interactive sessions).

Sprint 0 deliverables live under `docs/spikes/` on PR #109. Finding docs, probes, and fixtures are reviewable independently of this spec PR.

### What changed in v2.1 (Nibbler review on PR #106)

All changes are empirical corrections from Nibbler running validation traces against `claude 2.1.126` and aerolalit's reference plugin.

- **§5.2 JSONL schema corrected**: `tool_result` is a content block inside a `user` message, not a top-level type (`runner.ts:891-909` already does this). Additional emitted types documented: `attachment`, `permission-mode`, `file-history-snapshot`, `ai-title`, `last-prompt`, `queue-operation` — `attachment` must not silently drop (UX regression).
- **§5.1 + §11.4 permission flow corrected** to two notifications: `permission_request` (Claude → plugin) and `permission` (plugin → Claude), carrying the same `request_id`. Declaring `claude/channel/permission` is a contract that the plugin authenticates the replier.
- **§5.1 `ask` tool added** to the Bus MCP tool set for parity with aerolalit's reference plugin (matters for §9 Channels GA migration).
- **§10.0 Spike 0.4 added**: slash commands via stdin — promoted from §14.2 Open Q because an `isatty(0)` check inside `claude` would force `tmux` back to required-on-Unix. Better to learn this before Sprint 1.
- **§10.0 Spike 0.5 added**: session lifecycle markers (`/compact`, `/clear`, `/quit`). The v2 spec assumed `session.init` / `session.end` / `session.compact` JSONL events exist; Nibbler couldn't find them in traces or binary strings. If they don't exist, the tailer needs fallback signals (process exit for end; line-delta or hook for compact).
- **§5.4 IPC tightened**: macOS-without-XDG path budget, multi-daemon collision via instance-id in socket name, `/proc/<pid>/environ` visibility of `CCAW_BUS_TOKEN`, rationale for the same-uid constraint.
- **§12.5 shim coverage**: all 9 events in `src/plugins.ts` mapped to Bus correspondence (was 4 of 9 in v2).
- **§4 / §5.4 reuse note**: Bus core extends Gateway (`src/gateway/`) + EventLog (`src/event-processor.ts`, `src/event-log.ts`) — `BusEvent` is the Bus-runtime shape of `NormalizedEvent` / `EventRecord`, not a parallel primitive.

---

## 1. Summary

Replace ClaudeClaw+'s default runtime — PTY stdin-write / stdout-parse — with a Plus-internal **Bus** that wraps two supported Claude Code primitives:

| Direction | Mechanism | What it replaces |
|---|---|---|
| **Write** (Plus → Claude) | Channels MCP notifications (`notifications/claude/channel`) | `pty.write(prompt + "\r")` |
| **Read** (Claude → Plus) | Live tail of Claude Code's session JSONL log + structured event stream | Sentinel-echo TUI parser |

This single Bus then feeds all external surfaces — Discord, Telegram, Slack, Web UI, REST/CLI — through a uniform internal API. The PTY runner is **retained behind a config flag (`runtime: pty`)** as a deprecated fallback path; the default for fresh installs is `runtime: bus`. A schema-compatibility test harness runs at startup and on `claude` version changes to detect Anthropic-side schema drift without requiring Plus to pin a `claude` version.

## 2. Why

The PTY runner has two structural risks that are unfixable in its current shape:

1. **TUI-rendering breakage risk.** Anthropic can change the interactive `claude` TUI at any time. The Bus architecture has zero dependence on TUI byte-level output.
2. **PTY scraping is the part of Plus that critics point at first.** Even if it's not a Consumer Terms §3 violation (see compliance proposal §1.6), it's the surface that invites the question. The Bus uses Anthropic-published structured primitives (Channels MCP + JSONL log), neither of which can be characterised as "scraping a human-facing UI."

### 2.1 Empirical evidence — three PTY-parser regressions in two months

The TUI-rendering risk is not theoretical. Between March and May 2026 the project shipped three sentinel-echo parser fixes, each addressing a distinct class of TUI rendering that the parser had previously handled correctly:

| Issue | Symptom | Root cause | Resolution |
|---|---|---|---|
| [#81](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/81) | Turn-boundary detection failing on `claude` 2.1.89 | OSC sequence emission semantics changed | Sentinel-echo parser rewrite ([#82](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/82)) |
| [#84](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/84) | `_waitForReadySettle` returning before TUI paint completed | Repaint timing race | Settle-detection retune ([#85](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/85)) |
| [#105](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/105) | DM-mode model output captured as `*\n↓\n1` glyphs | TUI rendering of markdown code-fence backticks produced framed code box; parser extracted box chrome instead of textual content | **Open** — band-aid in PTY mode (constrain assistant output to plain prose); structural fix is this Bus migration |

The #105 case is the cleanest demonstration. The model's actual assistant message in the canonical JSONL was:

```
Saved to `/home/claw/project/example-com-screenshot.png`
```

What the operator received through Discord was three control glyphs and three runs of blank lines. The tool call succeeded, the file was written, the session was healthy — only the user-visible reply was corrupted, and only because the PTY parser was looking at terminal output instead of the structured JSONL event the model already emitted.

Under the Bus runtime, #105 is impossible to reproduce: the JSONL tailer reads `message.content[].text` directly. There is no rendering layer between the model and Plus.

### 2.2 Side benefit — Channels GA path

When Anthropic GA's the Channels feature (and allowlists community channel plugins), the Bus's Discord/Telegram adapters can swap to Anthropic's official channel plugins as a configuration change rather than a rewrite. The Bus core, JSONL tailer, and Slack/Web UI adapters are unaffected. See §9.

### 2.3 Why "PTY for stdin" doesn't contradict the "no TUI parsing" guarantee

A reasonable challenge to v2.2: "you said the Bus runtime removes PTY-based parsing, but the default supervision is now `pty-stdin` — isn't that still a PTY?"

The answer is a structural distinction worth making explicit.

**Two separate things a PTY does:**

1. **TTY emulation** — gives a child process a `tty(4)` file descriptor on stdin/stdout so the child believes a real terminal is attached. POSIX-standard primitive. Used by `expect`, `script`, `tmux`, GNU `screen`, every CI runner that captures interactive output. Carries zero semantics about what the child does with that terminal.

2. **Stdout byte parsing** — the caller reads everything the child writes to stdout, parses ANSI escape sequences, terminal control codes, and screen-buffer-style rendered text, and interprets that byte stream as program output. This is what makes the PTY runner fragile: Anthropic owns the byte-level rendering and changes it (issues #81, #84, #105 are all this class).

The Bus runtime uses (1) and does not use (2). Concretely:

```ts
const proc = ptySpawn('claude', args, { /* TTY config */ });
// We only WRITE to the PTY master (for slash commands).
// stdout/stderr from the PTY slave is observed for crash signals only,
// NEVER parsed as model output. Model output comes from the JSONL tailer.
proc.onData((chunk) => observeForCrashSignals(chunk));
```

The "no TUI parsing" guarantee is about (2) — TUI rendering and byte interpretation. It survives intact. The PTY layer is doing TTY emulation only, which is the same job a PTY does for `expect` or `script` — POSIX plumbing, not protocol surface.

**Why this matters:** Anthropic's REPL has an `isatty()` gate (validated in Spike 0.4). Their native Channels architecture (the official Telegram plugin) sidesteps the gate by assuming a human operator runs `claude` in a real terminal with a real TTY. Plus is daemonised — there is no human at a terminal — so we provide the TTY ourselves via `bun-pty`. We're standing in for the absent human from claude's perspective, nothing more.

Anthropic's headless mode (`claude -p` / `--print` — same flag, long and short forms) is the other end of the spectrum: no TTY needed. The `--input-format=stream-json` flag is a modifier on that mode (changes how stdin is parsed) rather than a separate mode.

**Probe 0.6 outcome (`docs/spikes/0.6-stream-json-channels-probe.md`):** `claude -p --input-format=stream-json` IS multi-turn, supports JSONL output, and accepts slash commands — but **silently drops Channel notifications**. Binary inspection confirms the `case "channel"` handler dispatches with `{midTurn:true}`, i.e., channels are interjections aimed at the REPL's input prompt. `-p` mode has no input prompt to interject into, so notifications are no-ops.

This validates `pty-stdin` as the correct default for channel-driven agents and surfaces a strictly better runner for the non-channel case:

| Origin | Runner | Why |
|---|---|---|
| `discord`, `telegram`, `slack`, `webui` | `pty-stdin` (bun-pty) | Channel-driven; needs REPL; REPL needs TTY |
| `cron`, `heartbeat`, `cli`, `rest` | `process-stream-json` | Channel-free; PTY is overhead; same JSONL semantics |

Sprint 1 picks this up as a runner-selection branch keyed on `BusEvent.origin`. The two runners share the JSONL Tailer (same read path) and only differ in how the `claude` child is supervised. Operators don't see this distinction unless they look at `ps` output.

Re-probe `-p --input-format=stream-json` + Channels on each `claude` minor bump — if Anthropic surfaces channel events into the stream-json output mode in a future version, `process-stream-json` could expand to channel-driven origins and bun-pty could be deprecated entirely.

## 3. Design principles

1. **One Bus, many surfaces.** All Plus surfaces (Discord, Telegram, Slack, Web UI, REST/CLI) talk to one internal API. No surface ever talks directly to `claude`.
2. **Two primitives only.** Channels notifications (write) and JSONL tail (read). Anything that can't be expressed in those two primitives doesn't exist in this architecture.
3. **One `claude` process per Plus agent.** Matches the §1.6 Pattern A migration target. Each agent has its own session, JSONL log, system prompt, working directory, and channel plugin instance.
4. **No PTY in the Bus runtime.** The Bus runtime itself must not depend on terminal byte output. If a feature can't be served by structured JSONL events, it gets deprecated under `runtime: bus`. The PTY runtime is retained separately as a config-gated fallback (`runtime: pty`) and shares no code paths with the Bus runtime at execution time.
5. **Compatible with Channels GA.** The internal Channel plugin written for the Bus is structurally identical to Anthropic's official plugins (declares `experimental: { 'claude/channel': {} }`, sends `notifications/claude/channel`, exposes `reply` tool). When Anthropic GAs Channels, the Discord/Telegram surfaces can swap to the official plugins; the Bus continues to serve Slack and Web UI as a custom Channel.

## 4. High-level architecture

```
                    External Surfaces
    ┌───────────┬───────────┬─────────┬────────┬───────────┐
    │  Discord  │  Telegram │  Slack  │ Web UI │ REST/CLI  │
    └─────┬─────┴─────┬─────┴────┬────┴───┬────┴─────┬─────┘
          │           │          │        │          │
          └───────────┴──────────┴────────┴──────────┘
                              │
                              ▼
        ┌───────────────────────────────────────────────┐
        │                Plus Bus                       │
        │  ┌──────────────┐  ┌──────────────────────┐   │
        │  │ Prompt       │  │  Response broker     │   │
        │  │ router       │  │  + pub/sub event bus │   │
        │  └──────┬───────┘  └──────────┬───────────┘   │
        │         │                     │               │
        │  ┌──────▼────────┐    ┌──────▼─────────┐      │
        │  │ Bus MCP       │    │ JSONL tailer   │      │
        │  │ (channels svr)│    │ pool           │      │
        │  └──────┬────────┘    └──────┬─────────┘      │
        └─────────│────────────────────│────────────────┘
                  │                    │
                  │   ┌────────────────┘
                  │   │
            ┌─────▼───▼──────┐    ┌────────────────────┐
            │ claude (agent  │    │ ~/.claude/projects/│
            │   #1) — tmux   │    │  <enc-cwd>/        │
            │ --channels     │    │  <session-id>.jsonl│
            │ plus-bus@local │    └────────────────────┘
            └────────────────┘             ▲
                  │                        │
                  └─ writes ───────────────┘

            ┌────────────────┐
            │ claude (agent  │     (one process per Plus agent)
            │   #2) — tmux   │
            │ --channels     │
            │ plus-bus@local │
            └────────────────┘
```

Key points from the diagram:

- **External surfaces are stateless adapters.** Discord adapter speaks Discord; it does not know what `claude` is. It calls `bus.send_prompt(agent, user, text)` and subscribes to `bus.events(agent, session)`.
- **The Bus has two MCP-shaped components.** The Bus MCP (write path) is loaded by `claude` as a channel plugin. The JSONL tailer (read path) runs as a Plus-internal worker.
- **One `claude` process per agent.** Each process is wrapped in a tmux pane (for `/compact`, `/clear`, restart-on-crash). Each process loads the same Bus MCP plugin but identifies itself by `agent_id` in the plugin handshake.

## 5. Component specifications

### 5.1 Plus Bus MCP Server (`src/bus/mcp-server.ts`)

**Role:** Acts as a Claude Code Channel. Receives prompt events from the Plus Bus core and pushes them into the connected `claude` session via `notifications/claude/channel`. Exposes tools that Claude can call to reply or stream intermediate output back.

**MCP capability declaration:**
```js
capabilities: {
  experimental: {
    'claude/channel': {},               // required — base channel capability
    'claude/channel/permission': {}     // required for the permission flow
  }
}
```

Both capabilities are mandatory (validated empirically in Spike 0.1 against aerolalit's reference plugin at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts:388,394`). Omitting `claude/channel/permission` disables the structured permission flow and forces the operator-approve-via-plan-mode fallback path.

**Initialisation handshake:**
- The plugin reads a per-invocation env var `CCAW_AGENT_ID` (set by Session Manager when spawning `claude`).
- On `initialize` from Claude Code, the server registers itself with the Plus Bus core (over Unix domain socket at `~/.claudeclaw/bus.sock` or named pipe on Windows), tagged with `agent_id`.

**Inbound (from Plus Bus core → Claude session):**
- The Bus core sends a prompt to the MCP server via UDS: `{type: 'prompt', text, origin: 'discord|telegram|slack|webui|cli', origin_id, agent_id}`.
- The MCP server emits `notifications/claude/channel` with `params: {content: <prompt text>, meta: {origin, origin_id, ...}}`. **The shape is flat — `content` and `meta` at the top of `params`** — empirically the only shape `claude 2.1.x` will accept (Sprint 1 integration finding, validated against aerolalit's reference plugin). Earlier drafts of this spec described a nested `{channel_id, payload: {text, metadata}}` shape; that was speculation that would be rejected by claude at parse time.
- Claude Code receives the notification and treats it as a new turn in the conversation.

**Outbound (from Claude → Plus Bus core):**
- The MCP server exposes a `reply` tool with schema `{message: string, metadata?: { intent?: 'final' | 'progress' | 'tool_status' }}`.
- When Claude calls `reply`, the MCP server forwards to the Bus core: `{type: 'reply', text, agent_id, intent}`.
- The MCP server exposes an `ask` tool with schema `{question: string}` → returns `{ask_id: string}` immediately. The agent loop continues running other tools / thinking while waiting; the answer arrives asynchronously as a Bus event referencing the same `ask_id`. This matches aerolalit's reference plugin and is required for parity with the official Telegram channel plugin (§9 GA migration).
- `request_human` — synchronous clarifying-question tool (blocks the agent loop until a reply arrives). Use sparingly; prefer `ask` for non-blocking flows.
- `cancel` — graceful turn termination.

**Channel-side permission prompts (two notifications, same `request_id`):**

The Channels permission flow is bidirectional, modelled after the structure aerolalit's reference plugin demonstrates (`plugins/telegram/server.ts:599, 1171, 1402`) and confirmed in the `claude` binary strings:

| Direction | Notification | Payload (key fields) |
|---|---|---|
| Claude → plugin | `notifications/claude/channel/permission_request` | `request_id`, `tool_name`, `description`, `input_preview` (zod-validated at aerolalit `server.ts:420`) |
| plugin → Claude | `notifications/claude/channel/permission` | `request_id` (same), `behavior: 'allow' \| 'deny'` |

`request_id` is a 5-character lowercase string from `[a-km-z]` (charset confirmed empirically in Spike 0.1 via the reference plugin's regex at `server.ts:84,733`). Useful as a probe assertion and for test fixtures.

The outbound payload field is **`behavior`**, not `decision`. v2.1 of this spec incorrectly named it `decision` based on the textual description in Nibbler's review; the reference plugin's send-site at `server.ts:774,933` confirms `behavior`. Any earlier reference to a `reason?` field is also dropped — no evidence for it in the reference.

The Bus MCP receives the `permission_request` from Claude, forwards to the Bus core, which routes to whichever surface is currently active for that agent (Discord button, Telegram inline keyboard, Web UI banner). The surface's reply comes back through `bus.ingestPermissionDecision({request_id, behavior})`, which the Bus MCP turns into the outbound `permission` notification.

**Capability contract:** declaring `claude/channel/permission` in the MCP capabilities asserts that the plugin authenticates the replier. Plus's per-adapter allow-list (§7) is what satisfies that contract — only allow-listed users on each surface can submit a permission decision.

### 5.2 JSONL Tailer (`src/bus/jsonl-tailer.ts`)

**Role:** Continuously tails each agent's session JSONL file and emits structured events on the Bus pub/sub topic for that agent.

**Inputs:**
- File path: `~/.claude/projects/<url-encoded-cwd>/<session-id>.jsonl`. Discovered via Session Manager (which knows each agent's cwd and session-id).
- **The cwd must be `realpath`'d before encoding.** macOS `/tmp` is a symlink to `/private/tmp`; an agent started with `cwd: '/tmp/foo'` will have its JSONL under the encoded `/private/tmp/foo` path. The Tailer must call `fs.realpathSync(cwd)` before computing the encoded directory name. Without this, the Tailer watches the wrong directory and silently never receives events. Empirically discovered in Spike 0.5.
- One tailer goroutine/worker per agent.

**Implementation:**
- Use `fs.watchFile` (Node.js) or equivalent + a seek pointer per session. On new bytes: read, split on `\n`, JSON.parse each line, dispatch.
- On daemon restart: read from byte 0 to repopulate state; emit a `bus.events.replay_done` marker so subscribers can distinguish historical from live.

**JSONL line types to handle** (validated against `claude 2.1.143` traces in Spike 0.2; `runner.ts:923-934` is the working reference for `tool_result` extraction and ports verbatim into the Tailer):

| JSONL shape | Bus topic | Notes |
|---|---|---|
| `{type: 'user', message: {role:'user', content: <string \| Array>}}` | `prompt` | When `content` is a string, this correlates with what Bus MCP pushed in. When it's an Array, walk for tool-result blocks — see next row. |
| `{type: 'user', message: {role:'user', content: [{type: 'tool_result', tool_use_id, content, is_error?}, ...]}}` | `tool_result` (per block) | **Important: `tool_result` is NOT a top-level type.** It is a content block inside a `user` message. The tailer walks `message.content[]` and emits one `tool_result` Bus event per block, carrying the `tool_use_id`. **`content` is string OR array** (array when result includes images); tailer needs `typeof === 'string'` guard before any string ops. |
| `{type: 'assistant', message: {role:'assistant', content: [<block>...], usage: {...}}}` | `response.text` \| `response.tool_use` \| `response.thinking` (per block) | Walk `content[]`. `{type:'text', text}` → `response.text`. `{type:'tool_use', id, name, input}` → `response.tool_use`. `{type:'thinking', thinking}` → `response.thinking`. The `usage` block on the same line → also emit `usage`. Assistant lines may also carry `error`/`isApiErrorMessage`/`apiErrorStatus` fields on degraded turns. |
| `{type: 'attachment', subtype: <22-variant union>, ...}` | `attachment.<subtype>` | **Must not silently drop.** 22 distinct subtypes observed in Spike 0.2. Bus-critical ones: `hook_success`/`hook_cancelled`/`hook_blocking_error`, `edited_text_file`, `command_permissions`, `plan_mode`/`plan_mode_exit`, `task_reminder`. Sprint 1 builds the per-subtype topic mapping. |
| `{type: 'permission-mode', mode}` | `session.permission_mode_change` | Fires only on actual changes, only in interactive sessions (headless never emits). Note: `permissionMode` *also* appears as a field on `user` lines — same data in two places. |
| `{type: 'file-history-snapshot', ...}` | `session.file_snapshot` | Filesystem snapshot for restore semantics. |
| `{type: 'ai-title', title}` | `session.title` | Auto-generated session title — useful for Web UI sidebar. |
| `{type: 'agent-name', ...}` | `session.agent_name` | Agent identity assignment. |
| `{type: 'custom-title', ...}` | `session.custom_title` | Operator-set title. |
| `{type: 'pr-link', ...}` | `session.pr_link` | PR association. |
| `{type: 'last-prompt', ...}` | `session.last_prompt` | Marker line. |
| `{type: 'queue-operation', ...}` | `session.queue` | Internal Claude Code queue marker. |
| `{type: 'system', subtype: <one-of>, ...}` | `system.<subtype>` | **`system` is a container; `subtype` is the real discriminator.** Subtypes observed in Spike 0.2: `compact_boundary`, `turn_duration`, `stop_hook_summary`, `away_summary`, `informational`, `local_command`, `scheduled_task_fire`, `bridge_status`, `api_error`. The full union is open — Sprint 1 enumerates exhaustively. **`stop_hook_summary` payload shape** (PR #112 cross-validation, claude 2.1.143): `{hookCount, hookInfos: [{command, durationMs}], hookErrors: [], preventedContinuation, stopReason, hasOutput, level, toolUseID, uuid, version}` — emit as `system.stop_hook_summary` for per-turn hook telemetry. |
| Any line with a `usage` field containing `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` | `usage` | Update cache-hit dashboard. Co-located with the assistant message. |

**Session lifecycle markers — empirical findings (Spikes 0.2 + 0.5):**

The earlier hypothesis of named `session.init` / `session.end` / `session.compact` JSONL line types is **dropped**. None exist on `claude 2.1.143`. Real behaviour:

| Event | JSONL signal | Detection mechanism |
|---|---|---|
| **`session.init`** | First non-empty line in a previously-empty `<session-id>.jsonl` file | `fs.watch('change')` on the file; emit `session.init` once on the first byte observed |
| **`session.compact`** | `{type:'system', subtype:'compact_boundary', compactMetadata: {trigger, preTokens, postTokens, durationMs, preservedSegment: {headUuid, anchorUuid, tailUuid}}}` appended to the JSONL | Bus topic `session.compact` is mapped 1:1 from `system.compact_boundary`. `preservedSegment.{head,anchor,tail}Uuid` (PR #112 cross-validation) lets the Tailer correlate pre/post-compact transcript ranges — useful for adapters that want to scroll back across a compact boundary without losing context. |
| **`/clear` event** | **Rotation, not truncate.** A new `<new-session-id>.jsonl` file appears in the same project directory; the old file is frozen unchanged and carries no marker | `fs.watch('add')` on the project directory; treat as `session.end(old)` immediately followed by `session.init(new)`; re-bind subscribers to the new session_id |
| **`session.end` (process exit)** | `<command-name>/exit</command-name>` envelope in the JSONL on `/quit`; otherwise no JSONL signal | Session Manager observes process exit (PTY `onExit` or `Bun.spawn` exit promise); emit `session.end` from there. The JSONL `/exit` envelope is informational, not the authoritative signal. |

The Bus event topics (`session.init`, `session.compact`, `session.end`) remain stable in the Bus's external API regardless of detection source — adapters subscribe by topic name and don't care whether the event came from a JSONL marker, a directory watch, or process exit.

**Emit format (single normalised schema):**
```ts
type BusEvent = {
  ts: number;            // ms since epoch
  agent_id: string;
  session_id: string;
  topic: 'prompt' | 'response.text' | 'response.tool_use' | 'response.thinking' | 'tool_result' | 'usage' | 'session.init' | 'session.end' | 'channel.permission';
  payload: any;          // topic-specific
  raw?: any;             // original JSONL line, for audit log
};
```

### 5.3 Session Manager (`src/bus/session-manager.ts`)

**Role:** Spawns and supervises one `claude` process per Plus agent.

**Supervision modes (operator-selectable):**

| Mode | Implementation | Platforms | Use case |
|---|---|---|---|
| `pty-stdin` (default for channel-driven agents) | Spawn `claude` via `bun-pty` to satisfy the REPL's `isatty(0)` gate. **`stdout: 'ignore'`** — the Bus never reads stdout. Slash commands written to the PTY master. JSONL is the only read source. | macOS, Linux | Default for `discord`/`telegram`/`slack`/`webui` agents — anywhere Channel notifications drive turns |
| `process-stream-json` (default for non-channel origins) | `Bun.spawn(['claude', '-p', '--input-format=stream-json'])` with JSON turns written to stdin. No PTY needed — `-p` bypasses the isatty gate. JSONL still authoritative for reads. Channel notifications are NOT delivered in this mode (Probe 0.6); slash commands ARE. | macOS, Linux, Windows | Default for `cron`/`heartbeat`/`cli`/`rest` agents — channel-free invocations where PTY emulation is unnecessary overhead |
| `tmux` (opt-in) | Wraps `claude` in a detached tmux session; operator can `tmux attach` to inspect | macOS, Linux | Operators who want to attach into a running session for debugging or to issue commands by hand |
| `process` (Windows-only, channel-driven fallback) | Direct `Bun.spawn` with `stdin: 'pipe'` and no PTY — slash command relay does NOT work in this mode on `claude` 2.1.x (REPL downshifts to `--print`). Acceptable only on Windows where `bun-pty` is unavailable AND the agent needs channels. | Windows | Windows fallback when `bun-pty` is unavailable and `process-stream-json` is unsuitable (channel-driven origin) |

Default is `pty-stdin`. The earlier v2 spec made `process` the default; Spike 0.4 disproved this empirically. `claude` 2.1.143 gates the REPL on `process.stdin.isTTY` AND `process.stdout.isTTY` (binary-confirmed via `strings`: `if (isFirst && process.stdin.isTTY)`). Plain `Bun.spawn({stdin:'pipe'})` auto-downshifts to `--print` mode within ~3 s with exit code 1 and discards any slash command sent.

**This is not a return to the PTY runner.** The structural difference vs the current PTY runner:
- The PTY runner spawns `claude` via `bun-pty` AND reads stdout, parsing TUI bytes for content. That stdout-read is what the v2 spec is replacing.
- The Bus runtime spawns `claude` via `bun-pty` for *stdin TTY emulation only*. `stdout: 'ignore'` on the bun-pty handle. Reads come from JSONL.

The Bus's "no TUI byte parsing" claim survives intact. `bun-pty` is already in dependencies (powers the legacy PTY runner via `src/runner/pty-process.ts`), so this carries zero added dependency.

tmux remains an opt-in alternative for operators who want pane-attach inspection. The `process` mode is Windows-only fallback (because `bun-pty` is Unix-focused and `claude.exe` may behave differently than the macOS/Linux build — Sprint 0.3 + a Windows-host validation are required before any of those defaults are settled).

**Per-agent spawn (default `pty-stdin` mode):**
```ts
function spawnAgent(agent: AgentConfig): Promise<AgentProcess> {
  const args = [
    '--dangerously-load-development-channels', 'plugin:plus-bus@local',
    '--permission-mode', agent.permissionMode ?? 'plan',
    '--append-system-prompt', renderSystemPrompt(agent),
    '--mcp-config', agent.mcpConfigPath,
    '--session-id', agent.sessionId,   // stable across restarts
  ];
  const env = {
    ...sanitisedParentEnv(),           // cleanSpawnEnv equivalent for Bus runtime
    CCAW_AGENT_ID: agent.id,
    CCAW_BUS_SOCK: BUS_SOCK_PATH,
  };
  // Spike 0.4 confirmed: plain `Bun.spawn({stdin:'pipe'})` downshifts claude
  // to --print mode within ~3s because of the isatty(0) gate. Use bun-pty
  // for TTY emulation; stdout still ignored — the Bus does NOT scrape TUI.
  const { spawn: ptySpawn } = await import('bun-pty');
  const proc = ptySpawn('claude', args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: agent.cwd,
    env,
  });
  // We attach onData consumers ONLY for crash diagnostics (stderr-equivalent).
  // No parsing of the byte stream into model output — that's the PTY runner's
  // failure mode and the entire reason for this migration.
  proc.onData((chunk) => observeForCrashSignals(chunk));
  return { agentId: agent.id, proc, supervisor: makeSupervisor(proc) };
}
```

The `tmux` mode wraps the same `args` array under `tmux new-session -d -s claudeclaw-<agentId>` and uses `tmux send-keys` for slash commands. Selecting between modes is config: `bus.supervision: 'pty-stdin' | 'tmux' | 'process'` (last is Windows-only fallback).

**Lifecycle (all modes):**
- `start()` — spawn all configured agents.
- `stop(agent_id)` — send `/quit` via PTY write (`pty-stdin` mode), `send-keys` (`tmux` mode), or `proc.kill()` (`process` mode on Windows where slash commands don't work). Observe PTY/process exit; emit `session.end` from Session Manager.
- `restart(agent_id)` — stop then start, preserve `session_id` for `--resume` continuity.
- `health()` — for each agent, check process alive + JSONL file is receiving updates within the heartbeat interval. Optional: detect "alive but JSONL stalled" as a degraded state.

**Slash command relay:**
- `pty-stdin` mode: write `"/compact\n"` to the bun-pty master. Empirically validated in Spike 0.4 — slash commands fire and produce `system.local_command` JSONL envelopes on success or failure. Supported: `/compact`, `/clear`, `/model <name>`, `/quit` (`/quit` maps to `/exit` internally).
- `tmux` mode: keep the existing `tmux send-keys` path for operators who prefer it.
- `process` mode (Windows-only): slash commands not supported. Operator-facing commands must be routed through Web UI or REST + Session Manager `restart()` for state changes that would otherwise need `/clear` or `/compact`.
- **Never used for prompts** — prompts flow through the Bus MCP `notifications/claude/channel` path. Slash commands are the only PTY-write / `send-keys`.

### 5.4 Bus Core (`src/bus/core.ts`)

**Role:** In-process pub/sub broker that ties together: MCP server, JSONL tailer, all external adapters. Single source of truth for "which agent is connected to which Claude session" and "which surfaces care about which agent."

**Internal API (TypeScript, exposed via UDS to MCP server and via in-process imports to adapters):**

```ts
interface BusCore {
  // surface → Bus
  sendPrompt(req: {
    agent_id: string;
    origin: 'discord' | 'telegram' | 'slack' | 'webui' | 'cli' | 'cron' | 'heartbeat';
    origin_id: string;       // channel ID, chat ID, etc.
    user_id: string;         // allow-list checked here
    text: string;
    metadata?: Record<string, any>;
  }): Promise<{ promise_id: string }>;

  // surface ← Bus  (pub/sub)
  subscribe(filter: {
    agent_id?: string;
    topics?: BusEvent['topic'][];
    origin?: string;
  }, handler: (e: BusEvent) => void): Subscription;

  // surface → Bus, ops
  invokeSlashCommand(agent_id: string, cmd: '/compact' | '/clear' | '/quit' | string): Promise<void>;

  // Bus internal — called by MCP server when claude calls reply()
  ingestReply(req: { agent_id: string; text: string; intent: string }): void;

  // Bus internal — called by JSONL tailer
  ingestSessionEvent(e: BusEvent): void;

  // health / introspection
  state(): BusState;
}
```

**Concurrency model:**
- Single event loop. All ingest/dispatch is non-blocking.
- Backpressure: ringbuffer per subscriber (size N, drop-oldest with metric increment if exceeded).
- Audit log: every `BusEvent` written to append-only JSONL at `~/.claudeclaw/bus-audit.jsonl` (subset of the existing event log; integrates with Plus's current audit infrastructure).

**Relationship to existing infrastructure:** the Bus core is not a parallel primitive — it extends the existing Gateway (`src/gateway/`) and EventLog (`src/event-processor.ts`, `src/event-log.ts`). The Gateway's admission, dedupe, and sequence-number machinery covers most of what the Bus core's pub/sub broker needs at the ingress side; the EventLog already provides the audit-log persistence. `BusEvent` is the Bus-runtime shape of the existing `NormalizedEvent` / `EventRecord` types — Sprint 1 must integrate, not duplicate. The handoff is: Gateway handles "did this event arrive, is it new"; Bus core handles "which subscribers care, in which surface, with what filter".

**IPC transport (Bus core ↔ Bus MCP server):**

The Bus MCP runs inside the `claude` process (loaded as a plugin), so it is necessarily out-of-process from Bus core. Three transports, selected by capability detection in this order:

1. **Unix Domain Socket** (default on Linux). Path: `${XDG_RUNTIME_DIR:-$HOME/.claudeclaw/run}/bus-<instanceId>-<agentId>.sock`.
   - **`instanceId` disambiguates multi-daemon hosts.** Two daemons on the same host (dev + prod side-by-side, staging, container scenarios) would otherwise collide on `bus-<agentId>.sock` if their agent_ids overlap. `instanceId` is derived once at daemon start from `cwd-hash[:8] || pid` (stable across the daemon's lifetime, unique per daemon instance).
   - **macOS without `XDG_RUNTIME_DIR`:** macOS does not set this var by default, so the fallback `$HOME/.claudeclaw/run/...` is the default path on every macOS install. The 104-byte `sun_path` cap is the operative budget. **Atomic-create (`<path>.tmp` → rename → `<path>`) requires +4B headroom** because `<path>.tmp` must also fit. Empirically validated in Spike 0.3: a 100B *final* path fails to bind because the `.tmp` form overflows. Correct safe cap is **final ≤ 96B**, which on a typical macOS `$HOME` (~23B) caps agent-slug at ~36 chars. Startup validation measures the resolved final path and fails fast with a clear error if it exceeds 96 bytes.
   - **Permission bits:** `0600`, owner-only.
   - **Same-uid constraint (rationale):** Daemon and MCP server must run as the same UID. This is what `0600` permission bits enforce. The constraint also rejects multi-user-host attack surfaces (no separate `claudeclaw` system user with its own socket that other users could connect to). Operators running multi-tenant hosts must isolate per-user via OS-level user separation, not per-daemon UID separation.
   - **Atomic create:** bind to `<path>.tmp`, `chmod 0600`, then `rename` → `<path>`. Prevents races where the MCP server connects before the daemon has bound + chmod'd.
   - **Cleanup on exit:** SIGTERM handler unlinks the socket; orphaned sockets from crashed daemons are unlinked on next start after a `connect()` probe confirms no listener.

2. **Windows named pipe** (preferred when validated; **not default**). Path: `\\.\pipe\claudeclaw-bus-<instanceId>-<agentId>`.
   - Use Bun's `node:net` named-pipe support via `net.createServer({ allowHalfOpen: false })` listening on the pipe path.
   - Security descriptor: restrict to the current user SID. **Spike 0.3 finding: Bun 1.3.4 does not expose any SDDL/security-descriptor API for named pipes** — there is no way from Bun TS to restrict the pipe to the current user SID. Additionally, **open Bun bug #30265 panics on busy-pipe binding** instead of returning `EADDRINUSE`. Until both are resolved, named pipes on Windows are not safe as the default — operators may opt in once they've validated their Bun version, but new installs should default to transport #3.

3. **Localhost TCP + token** (default on Windows per Spike 0.3; fallback elsewhere). When UDS / named pipe are unavailable or known-broken in the current runtime:
   - Bus core binds to `127.0.0.1:<random-ephemeral-port>`.
   - Generates a 32-byte random token, writes it to `~/.claudeclaw/agents/<agentId>/bus-token` (mode `0600`).
   - MCP server reads token via env vars (`CCAW_BUS_PORT`, `CCAW_BUS_TOKEN`).
   - **Visibility caveat:** on Linux, env vars are readable in `/proc/<pid>/environ` by any process running as the same UID. This is the same threat-model boundary as the same-uid constraint above. The on-disk token at `~/.claudeclaw/agents/<id>/bus-token` is `0600` (owner-only) which keeps it private across UID boundaries; the env-var path is meant for inheritance to the spawned `claude` child only, and other same-UID processes can read it for the lifetime of that child. Operators who need stricter isolation can disable transport #3 in config and require transport #1/#2 — startup will fail closed if neither is available.
   - Token sent as `Authorization: Bearer <token>` on every request; rejected with `403` on mismatch.
   - **Never bind to `0.0.0.0` and never enable on a non-loopback interface.** Startup config validation enforces this.

The transport choice is logged at daemon start so operators can confirm which one is active. The Bus MCP uses identical protocol framing across all three (length-prefixed JSON).

### 5.5 External Adapters

Each external adapter is a self-contained module under `src/adapters/`. **None of them imports the runner. None of them spawns `claude`.** They speak only to `BusCore` and to their respective platform.

#### 5.5.1 Discord adapter (`src/adapters/discord.ts`)

- Auths to Discord via existing bot token.
- Inbound message:
  - Check sender against allow-list. Reject otherwise.
  - Determine `agent_id` from channel/thread mapping (config: `{discord_channel_id → agent_id}`).
  - Call `bus.sendPrompt({agent_id, origin: 'discord', origin_id: channel_id, user_id: discord_user_id, text})`.
- Outbound (subscription):
  - `bus.subscribe({agent_id, topics: ['response.text', 'response.tool_use', 'channel.permission']})`.
  - On `response.text`: post to Discord channel. Coalesce multi-block responses into a single message (Telegram-style "lazy streaming").
  - On `channel.permission`: post a permission prompt with Discord buttons; route the choice back via `bus.ingestReply` or a dedicated permission API.

#### 5.5.2 Telegram adapter (`src/adapters/telegram.ts`)

- Same shape as Discord. Different platform SDK. Allow-list per user ID, not per chat ID (Telegram is DM-only by default per the existing Plus single-user-bot pattern).

#### 5.5.3 Slack adapter (`src/adapters/slack.ts`)

- Same shape. Slack-side specifics (events API, socket mode, Block Kit for richer rendering). **Slack is not on Anthropic's Channels allowlist, so the Bus MCP is the only viable plumbing for Slack regardless of Channels GA.**

#### 5.5.4 Web UI adapter (`src/adapters/webui/`)

- Express/Fastify HTTP server + WebSocket.
- On user prompt submission: `bus.sendPrompt`.
- WebSocket subscriptions: `bus.subscribe({agent_id, topics: '*'})` — surface every event to the front-end.
- Real-time visibility:
  - Conversation view: subscribes to `response.text`, `prompt`, `tool_result`
  - Agent activity panel: subscribes to `response.tool_use`, `response.thinking`
  - Token / cache panel: subscribes to `usage`
  - System panel: subscribes to `session.init`, `session.end` + Plus governance events (existing)
- **Loses sub-message token streaming** (message-granularity from JSONL, not token-granularity from PTY). Acceptable trade per §1.6 of the compliance proposal.

#### 5.5.5 REST/CLI adapter (`src/adapters/rest.ts`)

- HTTP endpoint for scripted prompt submission, status queries, slash-command invocation. Existing CLI (`claudeclaw plus prompt …`) wraps this.

### 5.6 Cron / heartbeat / scheduler

- Replaces today's heartbeat / cron features. Internal scheduler emits prompts via `bus.sendPrompt({origin: 'cron' | 'heartbeat', user_id: 'system', …})`.
- The Bus auto-tags `system`-originated traffic so it can be routed differently by hybrid auth router in the compliance proposal §2.3 C.1 (e.g., autonomous traffic gets pushed to API key when configured).

## 6. Data flows

### 6.1 Inbound prompt (Discord → Claude)

```
1. User sends message in #triage Discord channel
2. Discord adapter receives event from Discord gateway
3. Discord adapter checks allow-list — passes
4. Discord adapter looks up channel → agent_id mapping → 'triage-agent'
5. Discord adapter calls bus.sendPrompt({agent_id: 'triage-agent', origin: 'discord', origin_id: <channel>, user_id: <userid>, text: 'fix the build'})
6. Bus core forwards to Bus MCP server (which is loaded inside triage-agent's claude session)
7. Bus MCP emits notifications/claude/channel with payload {text: 'fix the build', metadata: {origin: 'discord', origin_id: <channel>}}
8. claude (triage-agent) processes the new turn, possibly calls tools, emits text response
9. claude calls the reply() tool exposed by Bus MCP
10. Bus MCP forwards to Bus core → bus.ingestReply
11. Discord adapter (subscribed to topics for 'triage-agent') receives event → posts to channel
```

### 6.2 Outbound visibility (Web UI live updates)

```
A. User opens Web UI → WebSocket connects → bus.subscribe({agent_id: 'triage-agent', topics: '*'})
B. (Independently) Discord traffic arrives per 6.1 above
C. Bus core ingests events from BOTH MCP server (reply) AND JSONL tailer (assistant messages, tool calls, usage)
D. Bus core pushes every event to Web UI subscriber via WebSocket
E. Web UI renders conversation, tool calls, token usage live
```

### 6.3 Slash command execution

```
1. Operator clicks "Compact" in Web UI
2. Web UI calls bus.invokeSlashCommand('triage-agent', '/compact')
3. Session Manager invokes tmux send-keys '/compact' Enter on triage-agent's tmux pane
4. claude executes /compact, writes new session state to JSONL
5. JSONL tailer emits 'session.compact' event
6. Web UI shows completion status
```

### 6.4 Heartbeat tick

```
1. Plus scheduler (cron) fires heartbeat for triage-agent
2. bus.sendPrompt({agent_id: 'triage-agent', origin: 'heartbeat', user_id: 'system', text: <heartbeat prompt>})
3. Bus core consults hybrid auth router config:
   - If PLUS_AUTONOMY=on AND user has API key configured → route through API-key claude process
   - Otherwise → route through subscription-quota Claude session
4. Same downstream flow as 6.1 from step 6 onward
```

## 7. Identity & session model

- Each Plus agent has a stable `agent_id` (string slug) and a stable `session_id` (UUID). Both live in `~/.claudeclaw/agents/<agent_id>/state.json`.
- `session_id` is passed to `claude --session-id <uuid>` so the JSONL file path is deterministic and survives restarts.
- The MCP server identifies its agent via `CCAW_AGENT_ID` env var; this is the binding that lets a single Bus core multiplex many `claude` processes.
- Allow-list scoping is per-adapter (Discord/Telegram/Slack/Web UI each define their own user ID allow-list), enforced before `bus.sendPrompt` is called. The Bus core itself trusts callers — adapters are the security boundary.

## 8. Multi-agent scaling

- **N agents = N `claude` processes = N tmux panes = N JSONL files.** All routed through the single Bus core.
- Resource ceiling: practical limit is per-machine memory + Anthropic's per-account concurrency limits. Plus's existing watchdog (PR #72) becomes the enforcement layer.
- The Bus MCP server can be **a single process serving multiple agents** (via the `CCAW_AGENT_ID` env var routing), or **one Bus MCP process per agent** (simpler isolation). Recommendation: **one process, multi-agent multiplex** — less overhead, single audit log, easier to reason about. The MCP per-session handshake includes `CCAW_AGENT_ID`, so the Bus knows which agent each notification/reply is for.

## 9. Channels GA migration path

When Anthropic GAs Channels (drops the `--dangerously-load-development-channels` flag, allowlists community plugins):

1. **Discord & Telegram adapters become thin wrappers around Anthropic's official channel plugins.** Replace the Bus MCP's Discord-side adapter with `plugin:discord@claude-plugins-official`; replace the Telegram adapter with `plugin:telegram@claude-plugins-official`. Plus's job for these surfaces becomes: bot-token storage, allow-list management, agent routing (channel_id → agent_id).
2. **Slack and Web UI stay on the Bus MCP** (Slack because it's not on the Channels allowlist; Web UI because there's no official Anthropic plugin for it).
3. **The JSONL tailer is unchanged.** It's reading a file Claude Code writes — no Channels dependency.

**Net engineering cost of the GA migration:** ~1 sprint, mostly a config refactor and removing the `--dangerously-load-development-channels` flag.

## 10. Engineering plan

### Sprint 0 (pre-Sprint 1) — De-risking spikes ✅ COMPLETE

All five Sprint 0 spikes shipped on branch `spec/sprint-0-spikes` (PR #109). Findings folded into this spec as the v2.2 commit. Cross-cutting empirical outcomes are summarised at the top of this document under "What changed in v2.2."

Original spike specifications retained below for traceability:

**Spike 0.1 — Permission-prompt flow (both directions).** Manually load a minimal Channels plugin into `claude --dangerously-load-development-channels` and trigger a permission-gated tool call. Validate the two-direction flow per §5.1:
- Confirm `notifications/claude/channel/permission_request` fires from Claude with `request_id`, `tool_name`, `description`, `input_preview` payload fields.
- Confirm the plugin can respond with `notifications/claude/channel/permission` carrying the same `request_id` and `{decision, reason}` payload, and that the agent loop resumes correctly on `allow`.
- Confirm `claude/channel/permission` capability is required (and what failure mode looks like if omitted).

Findings:
- **Both directions work as documented:** §11.4 is unblocked, permission flow ships in Sprint 4.
- **Partial or different:** capture the exact shape and update §5.1; may force Sprint 4 changes.
- **No structured permission:** ship v1.0 with `--permission-mode plan` everywhere (Claude proposes, operator approves via slash command or Web UI button). Defer interactive permission flow.

**Spike 0.2 — JSONL schema snapshot.** Capture a complete JSONL trace of a representative session under the current `claude` version: text reply, single tool call, parallel tool calls, thinking blocks, `attachment` (image + text + voice upload), `permission-mode` change, `ai-title` emission, plus all event types listed in §5.2. Document every line type and field used. Outputs:
- `docs/spikes/0.2-jsonl-schema-snapshot.md` with annotated examples for each line type, including the corrected `tool_result`-inside-`user`-message shape.
- `src/bus/types.ts` skeleton populated with the discovered schema.
- Test fixtures (`src/__tests__/fixtures/jsonl/`) for the schema-probe harness to validate against.
- Per-type Bus topic mapping decision for the six newly-documented types (`attachment`, `permission-mode`, `file-history-snapshot`, `ai-title`, `last-prompt`, `queue-operation`). `attachment` must not silently drop.

**Spike 0.3 — IPC primitive choice.** Stand up a throwaway Bus core skeleton and connect a stub MCP server via each of the three transports (UDS, named pipe, localhost-TCP). Measure: connection establishment latency, message round-trip, behaviour under daemon crash + restart, behaviour under MCP-server crash + restart. Specifically validate:
- Bun's `node:net` named-pipe support on Windows (does the security descriptor restriction work; if not, mandatory fallback to transport #3).
- macOS `sun_path` budget under realistic `$HOME` lengths.
- Multi-daemon collision avoidance with `instanceId` in the socket name.

Output: `docs/spikes/0.3-ipc-primitive.md` with per-platform default + measured numbers.

**Spike 0.4 — Slash commands via stdin (`isatty` check).** Promoted from §14.2 Open Q. The `process` supervision mode (§5.3 default) writes slash commands like `"/compact\n"` to the supervised `claude` process's stdin. If `claude` performs an `isatty(0)` check before accepting interactive commands — common defensive pattern — then plain-stdin slash commands will be silently ignored and `process` mode loses slash-command relay. In that case, tmux quietly slides back to required-on-Unix and Windows loses slash commands entirely.

Validate: spawn `claude` with `Bun.spawn` (`stdin: 'pipe'`), write `"/compact\n"`, observe whether the compact actually runs (JSONL line-count delta, or status output to stdout/stderr, whichever the spike confirms exists).

- **If accepted on plain stdin:** §5.3 stays as-specified; `process` mode is the default everywhere.
- **If rejected:** options are (a) wrap with a pty layer for stdin only (`script -q` or equivalent) — still PTY-free for the Bus runtime's read path, only the slash-command stdin gets a tty; (b) require `tmux` mode on Unix and document Windows as "no slash commands without WSL+tmux"; (c) accept the limitation and ship without slash commands in `process` mode. Choice cascades into §5.3 default flip.

Output: `docs/spikes/0.4-slash-stdin.md`.

**Spike 0.5 — Session lifecycle markers (`/compact`, `/clear`, `/quit`).** The v2 spec assumed JSONL events `session.init`, `session.end`, `session.compact`. Nibbler's validation against `claude 2.1.126` could not find these in either JSONL traces or binary subtype strings.

Validate by running each command against a real session under the working `process` (or `tmux` per Spike 0.4 outcome) supervision mode and capturing the full JSONL diff before/after:
- `/compact` — does Claude rewrite the JSONL? Append a marker line? Or is the only signal a file-size shrink?
- `/clear` — same questions. Plus: is the session resumable after `/clear`, and what's the JSONL state?
- `/quit` — does Claude write any final line before exit, or is process exit the only signal?

- **If markers exist:** §5.2 lifecycle section updates with the exact shapes; Bus topics map 1:1.
- **If markers absent:** §5.2's fallback inference logic is the source-of-truth (process exit → `session.end`; JSONL prefix rewrite → `session.compact`; first non-empty line → `session.init`). Implement and test fallback in Sprint 2.

Output: `docs/spikes/0.5-lifecycle-markers.md`.

**Sprint 0 budget:** ~5–7 days full-time, ~2 weeks part-time (added two spikes vs v2). Sprint 1 cannot start until all five spikes are written up. Spikes 0.1, 0.2, 0.3 can run in parallel; 0.4 and 0.5 share fixture setup so are paired.

### Sprint 1 (week 1) — Bus skeleton + Bus MCP

- Implement Bus core (pub/sub, in-process API).
- Implement Bus MCP server (`claude/channel` capability, `notifications/claude/channel` emit, `reply` tool).
- Stand up Session Manager (spawns one agent with tmux, loads Bus MCP).
- End-to-end test: prompt-in → notification-emit → claude processes → reply tool → bus.ingestReply.

### Sprint 2 (week 2) — JSONL tailer + audit + dashboard

- Implement JSONL tailer with per-agent worker pool.
- Wire JSONL events into Bus pub/sub.
- Implement Web UI WebSocket subscriber rendering conversation + tool calls + usage.
- Wire existing cache-hit dashboard (compliance proposal Layer D) onto JSONL `usage` events.

### Sprint 3 (week 3) — Discord/Telegram adapters

- Port existing Discord/Telegram bot logic to talk to Bus core instead of PTY runner.
- Allow-list enforcement, channel → agent_id mapping.
- Per-adapter integration tests.

### Sprint 4 (week 4) — Slack adapter + cron/heartbeat + slash commands

- Port Slack bot logic.
- Reimplement cron/heartbeat scheduler on top of Bus.
- Wire slash command relay (limited tmux send-keys for `/compact`, `/clear`, `/quit`).

### Sprint 5 (week 5) — Bus default + PTY behind a flag + multi-agent + ship

- Set Bus as the default runtime (`runtime: bus` in config).
- **Retain** the PTY runner gated behind config: `runtime: pty` (legacy, off by default, documented as fallback only).
- All four PTY runner files (`pty-process.ts`, `pty-output-parser.ts`, `pty-supervisor.ts`, and the `-p`-path in `runner.ts`) stay in the tree but are unreachable unless the operator opts in via config.
- The two code paths share neither IPC nor state; the runtime switch happens at Session Manager spawn time.
- Multi-agent multiplex testing (5 agents, mixed Discord + Telegram + Web UI traffic).
- Documentation, migration guide, CHANGELOG.

**Total estimate (revised v2):**
- **~3 weeks full-time** with Claude Code-assisted development.
- **~8–10 weeks at part-time cadence** (1–2 hour daily blocks). v1 spec said 5 weeks part-time; that under-estimated Sprint 3 (Discord/Telegram port — most existing logic ends up needing rework, not just rewiring) and assumed zero schema-drift maintenance during the build. Add Sprint 0 (~1–2 weeks part-time) on top of either figure if running for the first time.
- Maintain a 20% time budget for unplanned schema-probe failures + parser additions during the build window; we expect at least one Anthropic-side change during a 10-week window based on the PR #82 / PR #85 / #105 cadence.

## 11. Risks & open questions

### 11.1 JSONL schema stability

Claude Code's session JSONL format is structured but not (as far as we know) formally versioned as a public API. The Bus depends on it. We're explicitly **not** version-pinning Claude Code — Plus should keep working as `claude` updates ship. The mitigation is a **schema-compatibility test harness** that runs on every Plus install and on every `claude` version change detected at startup.

**Schema-compatibility harness design (`src/bus/schema-probe.ts`):**

- **Trigger points:**
  - On daemon startup, capture `claude --version`. Compare against the last-known-good version stored in `~/.claudeclaw/schema-probe-cache.json`. If different, run the full probe before accepting traffic.
  - On `--force-probe` CLI flag (operator-invokable).
  - Optional: a daily cron-driven probe to detect silent in-place updates.

- **Probe procedure:**
  1. Spawn a disposable `claude` interactive session with `--session-id <ephemeral-uuid>`, an empty cwd, and the Bus MCP plugin loaded.
  2. Send a fixed canonical prompt via `notifications/claude/channel`: e.g. `"Reply with exactly the text TEST_OK and call no tools."`
  3. Wait for the corresponding JSONL file to appear at the predicted path. **Probe assertion 1:** JSONL path follows the expected `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` convention.
  4. Tail the JSONL and collect all emitted lines until the assistant message arrives.
  5. **Probe assertions 2–N:** validate each event line against the Bus's expected schema:
     - `user` event present, with `message.content` extractable
     - `assistant` event present, with `message.content` array of typed blocks (`text`, `tool_use`, `thinking`)
     - `usage` block present on the assistant event, containing `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
     - Field names and nesting match what the JSONL Tailer's parser expects
  6. Send a tool-use-eliciting prompt (e.g. invoke a known MCP tool the Bus exposes). Validate `tool_use` and `tool_result` event shapes.
  7. Test slash command relay: send `/clear` via tmux `send-keys`. Validate a `session.compact` or equivalent JSONL marker is emitted.
  8. Send `/quit`. Validate `session.end` event.

- **Probe outcomes (default mode: warn-only):**
  - **All assertions pass:** write `{claude_version, last_passed_at, schema_hash}` to `schema-probe-cache.json`. Daemon proceeds normally.
  - **Any assertion fails (default behaviour):** daemon emits a structured warning to stderr + log file + a prominent status on the Web UI dashboard, showing which assertions failed and the raw JSONL lines that triggered the failure. The daemon **continues to start in `runtime: bus` mode**, and the parser falls back to "best-effort" handling (unknown event types emit a `bus.event.unknown` topic with raw payload; missing expected fields default to `null` rather than crashing). Operator is informed but not blocked. This is the appropriate default while the parser is hardening and we're tracking `claude` updates.
  - **Optional fail-closed mode (`on_version_change: required`):** daemon refuses to start in `runtime: bus` mode on any probe failure. Available for operators who want stricter safety in production. Operator is directed to either: (a) downgrade `claude` to last-known-good version, (b) switch to `runtime: pty` legacy fallback, or (c) file an issue with the diagnostic for a Plus update.

  Recommendation: ship v1.0 with `warn-only` as the default. After a few releases of real-world parser hardening, evaluate whether to flip the default to `required`. The config is per-install, so individual operators can opt into stricter behaviour earlier.

- **Schema versioning of the parser itself:**
  - The Bus JSONL parser declares a `SCHEMA_VERSION` constant. Schema-probe cache stores the parser version that passed. If the parser is updated (e.g. to handle a new event type), the cache invalidates and the probe re-runs.
  - Parser additions are forward-compatible (unknown event types emit a `bus.event.unknown` topic with raw payload and don't crash); only structural changes to known event types break the probe.

- **Probe runtime:** budget under 5 seconds end-to-end. The probe is throwaway — its session-id is discarded immediately after, so it doesn't pollute the operator's session list.

This harness gives Plus the resilience to track Claude Code updates without manual intervention. In the default `warn-only` mode the daemon stays up and surfaces a visible diagnostic; operators who want stricter behaviour can flip to `required` and fail closed. Either way, schema drift is never silent: it always produces a structured warning that the operator can see and act on, rather than corrupted Bus events propagating downstream.

### 11.2 `notifications/claude/channel` protocol stability

Channels is research preview. The protocol contract may change before GA. **Mitigation:** keep the Bus MCP server thin, version-detect Claude Code, and treat the Channels API surface as a single point of contact behind which Plus's internal logic is isolated. When the protocol changes, only `src/bus/mcp-server.ts` needs updates.

### 11.3 Streaming granularity

Plus is not currently doing token-by-token streaming of Claude's responses through any surface, so the message-granularity of JSONL events is not a regression. Web UI and bridges receive completed responses + intermediate tool-call events at the same granularity they do today. Non-issue.

### 11.4 Permission prompts

Today, when `claude` asks for permission (e.g., "run this command?"), the PTY parser sees it in the TUI and surfaces to the user. The Channels flow per §5.1 is bidirectional:

- `notifications/claude/channel/permission_request` (Claude → plugin) — carries `request_id`, `tool_name`, `description`, `input_preview`.
- `notifications/claude/channel/permission` (plugin → Claude) — carries the same `request_id` and `{decision, reason}`.

Declaring `claude/channel/permission` in the MCP capabilities asserts that the plugin authenticates the replier — Plus's per-adapter allow-list (§7) is what satisfies that.

**Resolution path:** Spike 0.1 in Sprint 0 settles the structured-vs-TUI-only question empirically before Sprint 4 commits to the interactive flow:
- **Both directions work:** Sprint 4 ships the interactive flow as specified. Surface implementations: Discord buttons, Telegram inline keyboard, Web UI banner.
- **Different shape than documented:** spec updates with the captured shape; Sprint 4 builds against actuals.
- **No structured permission events:** v1.0 ships with `--permission-mode plan` everywhere as the documented mode. Plan mode means Claude proposes, operator approves explicitly via slash command (`/approve <id>`) or Web UI button. Interactive permission deferred until Anthropic exposes it on Channels.

In either case the Bus does not lose user-facing functionality vs the PTY runner — the PTY parser's "see permission prompt in TUI" path was already brittle and would have broken on the same TUI changes that broke #105.

### 11.5 Multi-channel-per-bot identity

This refactor uses Pattern A from §1.6 of the compliance proposal — one `claude` process per agent — which means one Discord bot identity per agent (or carefully scoped channel routing via Discord guild channel IDs). If preserving the single-bot-identity property is critical, run Plus's Discord adapter as a single bot that routes by channel ID to multiple `agent_id`s in Bus core. This is supported by the Bus design — the binding `channel_id → agent_id` is config in the Discord adapter.

### 11.6 Slack future

Slack is not on the Channels allowlist. If Anthropic later releases an official Slack channel plugin with a different shape (e.g., the cloud-spawned "Claude in Slack" model), the Slack adapter may need a rewrite. **Mitigation:** keep the Slack adapter's interface to the Bus narrow and stable — adapter swaps don't ripple.

### 11.7 Daemon plugin API (Plus PR #144)

The existing daemon plugin API was designed around the PTY model. `src/plugins.ts:25-33` declares 9 hooks; each must have a defined Bus-runtime correspondence so plugin authors aren't surprised:

| Legacy hook | Bus event / dispatch point | Notes |
|---|---|---|
| `gateway_start` | Bus core startup, before any adapter binds | Plugin receives Gateway-equivalent context (already wired through Bus core's reuse of Gateway per §5.4) |
| `session_start` | Session Manager `spawnAgent` returns | Per-agent context: `{agent_id, session_id, cwd}` |
| `before_agent_start` | Session Manager just before `Bun.spawn`/tmux invocation | Lets plugins mutate `args` or `env` |
| `before_prompt_build` | Bus core, before `bus.sendPrompt` dispatches | `ctx.text` and `ctx.metadata` mutable |
| `tool_result_persist` | JSONL tailer, on `tool_result` Bus event | Plugin gets the tool_result content before subscribers see it |
| `agent_end` | Session Manager `stop()` completion | `{agent_id, exit_code, duration_ms}` |
| `session_end` | JSONL tailer `session.end` Bus event (or fallback signal per §5.2) | Same payload as `agent_end` plus session-final stats |
| `message_received` | Bus core inbound `bus.sendPrompt` entry | Pre-dispatch, lets plugins reject or annotate before routing |
| `after_compaction` | JSONL tailer `session.compact` Bus event (or fallback signal per §5.2) | Plugin can re-prime context, refresh memory, etc. |

**New Bus-only hook (optional, not in legacy API):**
- `before_channel_notification` — fires inside Bus MCP between Bus core's prompt and the `notifications/claude/channel` emit. Lets plugins intercept the MCP-side push (e.g., redaction, rate limiting at the Channels boundary).

External plugin authors get a one-time migration. To minimise breakage, the daemon ships a **translation shim** (see §12.5) that exposes all 9 legacy hook signatures on top of the new Bus event topics. The shim is in-process, zero-config for plugin authors, and tagged for removal per the §12.5 deprecation timeline.

### 11.8 Hetzner production deployment notes

The current production daemon on Hetzner runs PTY-mode with one operator (Discord channels + DMs) and uses a long-lived OAuth token (PR #104). The Bus migration plan retains PTY runtime as `runtime: pty` fallback (§10 Sprint 5), so the Hetzner deployment can stay PTY-mode through the build and switch to Bus only after `runtime: bus` is verified on a staging deployment. Staging plan:
1. Deploy daemon with `runtime: bus` and one agent, no external surfaces. Verify schema-probe (§11.1) passes against the same `claude` version Hetzner runs.
2. Add Web UI adapter as the lowest-risk surface. Smoke test 5 prompts.
3. Add Discord adapter. Mirror the Hetzner channel routing config. Smoke test all 4 channels + DM in parallel for one day.
4. Cut over Hetzner: change one daemon at a time. Roll back is a config-line revert + daemon restart — no code change.

## 12. Files to add / modify / retain (gated)

### Add
```
src/bus/core.ts
src/bus/mcp-server.ts
src/bus/jsonl-tailer.ts
src/bus/session-manager.ts
src/bus/schema-probe.ts             # JSONL/notification schema compatibility harness (§11.1)
src/bus/types.ts                    # BusEvent, AgentConfig, etc.
src/bus/auth-router.ts              # Hybrid OAuth vs API-key routing (compliance proposal Layer C C.1)
src/adapters/discord.ts             # (rewrite, smaller)
src/adapters/telegram.ts            # (rewrite, smaller)
src/adapters/slack.ts               # (rewrite, smaller)
src/adapters/webui/                 # WebSocket + HTTP server
src/adapters/rest.ts
.claude-plugin/bus-mcp/             # Plus Bus MCP plugin (loaded by claude)
docs/BUS_ARCHITECTURE.md            # User-facing migration guide
docs/PTY_LEGACY_FALLBACK.md         # How to enable runtime: pty if the operator needs it
```

### Modify
```
src/commands/start.ts               # branch on config.runtime: 'bus' (default) | 'pty' (legacy)
src/commands/stop.ts                # graceful shutdown via Session Manager OR PTY supervisor depending on runtime
src/config.ts                       # AgentConfig schema, runtime selector, allow-list config
README.md                           # Architecture section rewrite, default runtime now Bus
src/runner.ts                       # add runtime-branch dispatch at the spawn boundary
```

### Retain (gated behind `runtime: pty`, not deleted)
```
src/runner/pty-process.ts           # only reachable when runtime == 'pty'
src/runner/pty-output-parser.ts     # only reachable when runtime == 'pty'
src/runner/pty-supervisor.ts        # only reachable when runtime == 'pty'
                                    # the legacy -p path stays in runner.ts as a sub-branch
```

**Why retained:** keeps a known-working escape hatch if the Bus runtime hits a problem in the field that the schema-probe (§11.1) doesn't catch (e.g. a regression in `notifications/claude/channel` protocol semantics). Operators can switch with a config change instead of a downgrade. The PTY code path is on a deprecation track but does not block v1.0.

### 12.5 Plugin translation shim

**Goal:** existing daemon plugins continue to load and run unchanged under the Bus runtime for one full minor-release cycle after the cutover.

**Scope:** all 9 hooks declared in `src/plugins.ts:25-33` are mapped (full table in §11.7). No legacy hook is dropped silently.

**Implementation:** `src/bus/plugin-shim.ts` registers the 9 legacy hook names and translates each invocation into a Bus event subscription or dispatch:

```ts
// Legacy hook signature (preserved):
//   pluginApi.on('before_prompt_build', async (ctx) => { ctx.text = transform(ctx.text); })
//
// Shim internals: registers a 'prompt' topic interceptor on the Bus core
// that builds the legacy `ctx` shape from the BusEvent and calls the
// legacy handler. Any mutations the handler makes to ctx.text are written
// back to the Bus event before dispatch continues.
```

**Deprecation timeline:**

| Release | Behaviour |
|---|---|
| First release with Bus default | Legacy API works via shim. Deprecation warning logged on each invocation: `"plugin '<name>' uses legacy hook 'before_prompt_build' — see docs/PLUGIN_MIGRATION.md"`. |
| +1 minor release | Warning becomes a stderr boot banner: legacy plugins still load, but a "PLUGINS_USING_LEGACY_API=[…]" line appears at daemon start. |
| +2 minor releases | Legacy hooks removed. Plugins not migrated by this point fail to load with a pointer to the migration guide. |

**Migration guide deliverable (Sprint 4):** `docs/PLUGIN_MIGRATION.md` — hook-by-hook rewrite recipes with before/after code snippets for each of the seven existing hooks. Shipped alongside the first Bus-default release.

**Out of scope:** the shim does not attempt to translate hooks that read TUI bytes (none of the existing seven do; flagged here as a forward-looking invariant — new legacy hooks must not be added).

## 13. Acceptance criteria for v1.0

- [ ] **Default runtime is Bus.** Fresh installs run `runtime: bus` with zero PTY-dependent code in the active call path.
- [ ] All four external surfaces (Discord, Telegram, Slack, Web UI) can send prompts and receive responses via the Bus.
- [ ] **Schema-compatibility harness (`src/bus/schema-probe.ts`) runs on startup against the current `claude` version**. Default mode is `warn-only` — failures surface as structured diagnostics to stderr / log / Web UI dashboard but do not block daemon startup. `required` mode (fail-closed) is available as a config opt-in and is verified to refuse startup when assertions fail.
- [ ] JSONL tailer reproduces conversation history accurately after daemon restart (replay test: 100 prompts, verify all events delivered).
- [ ] Cache-hit dashboard widget (compliance proposal Layer D D.3) renders live from JSONL `usage` events.
- [ ] Multi-agent test: 5 agents running concurrently, each on a distinct Discord channel, no cross-contamination of sessions.
- [ ] Slash command relay works for `/compact`, `/clear`, `/quit` via tmux send-keys under both `runtime: bus` and `runtime: pty`.
- [ ] Channels GA migration sketch verified: replace Bus MCP's Discord adapter with `plugin:discord@claude-plugins-official` in a staging branch and confirm Plus continues to function.
- [ ] **PTY runtime fallback verified:** with `runtime: pty` in config, all existing PTY-mode functionality continues to work unchanged. The two runtimes share no state at runtime; the switch is a daemon-restart config change.
- [ ] All existing Plus features pass regression under both runtimes: heartbeat, cron, MEMORY.md split (compliance proposal Layer D D.1), DAG executor (Layer D D.2), watchdog, policy engine, audit log.
- [ ] Documentation: migration guide + architecture doc + PTY legacy fallback doc + updated README.

## 14. Open implementation questions

### 14.1 Resolved in v2 / v2.1

- ~~JSONL schema snapshot~~ → Spike 0.2 (Sprint 0). Output: `docs/spikes/0.2-jsonl-schema-snapshot.md`. Corrected `tool_result` shape and added six new line types per Nibbler review.
- ~~IPC mechanism~~ → §5.4 IPC transport, defaults specified, fallback documented. Spike 0.3 validates empirically. Hardened with `instanceId` for multi-daemon, macOS path-budget validation, env-var visibility caveat.
- ~~tmux dependency~~ → §5.3 makes tmux optional; `process` supervision is default. Removes the Windows-friction concern (modulo Spike 0.4 outcome).
- ~~Permission flow~~ → Spike 0.1 validates two-direction structured flow; §11.4 has all branches documented including capability-contract semantics.
- ~~Slash commands via stdin~~ → Spike 0.4 (Sprint 0). Output: `docs/spikes/0.4-slash-stdin.md`.
- ~~Session lifecycle markers~~ → Spike 0.5 (Sprint 0). Output: `docs/spikes/0.5-lifecycle-markers.md`. Fallback inference logic specified in §5.2.

### 14.2 Still open — investigate during build

1. **`notifications/claude/channel` payload shape verification.** Confirm against Anthropic's `channels-reference` doc and aerolalit's working implementation (`plugins/telegram/server.ts:506-512` and surrounding). Sprint 1 deliverable.
2. **`claude --session-id` flag behaviour.** Verify it accepts a caller-supplied UUID and produces a stable JSONL filename. If not, capture the auto-assigned session ID from the first JSONL line and store it. Sprint 1 deliverable.

---

## Appendix A — Inter-component sequence (Discord prompt)

```
User                  Discord            DiscordAdapter      BusCore        BusMCPserver      Claude        JSONLfile     JSONLtailer    WebUIadapter
  |                      |                      |               |                |               |               |               |              |
  |--"fix the build"-->  |                      |               |                |               |               |               |              |
  |                      |--message event------>|               |                |               |               |               |              |
  |                      |                      |--sendPrompt-->|                |               |               |               |              |
  |                      |                      |               |--prompt msg--->|               |               |               |              |
  |                      |                      |               |                |--notifications/claude/channel->|              |               |              |
  |                      |                      |               |                |               | (processes)   |               |              |
  |                      |                      |               |                |               |--writes------>|               |              |
  |                      |                      |               |                |               |               |--tail event-->|              |
  |                      |                      |               |<--ingestEvent--|---------------|---------------|---------------|              |
  |                      |                      |<--event-------|                |               |               |               |--event------>|
  |                      |                      |               |                |               |--calls reply->|               |              |
  |                      |                      |               |                |<--reply tool--|               |               |              |
  |                      |                      |               |<--ingestReply--|               |               |               |              |
  |                      |                      |<--event-------|                |               |               |               |              |
  |                      |<-- bot post ---------|               |                |               |               |               |              |
  |<--"Build green"------|                      |               |                |               |               |               |              |
```

## Appendix B — Configuration sketch

```yaml
# ~/.claudeclaw/config.yaml
runtime: bus                        # 'bus' (default) | 'pty' (legacy fallback)

bus:
  socket: ~/.claudeclaw/bus.sock
  audit_log: ~/.claudeclaw/bus-audit.jsonl
  schema_probe:
    enabled: true
    on_version_change: warn-only    # 'warn-only' (default) | 'required' (fail-closed) | 'skip'
    daily_probe: false              # optional periodic re-validation
    cache_file: ~/.claudeclaw/schema-probe-cache.json

agents:
  - id: triage-agent
    cwd: ~/projects/triage
    session_id: 11111111-1111-1111-1111-111111111111
    permission_mode: plan
    system_prompt_file: ~/.claudeclaw/agents/triage/SYSTEM.md
    memory_file: ~/.claudeclaw/agents/triage/MEMORY.md
    mcp_config: ~/.claudeclaw/agents/triage/mcp.json

  - id: research-agent
    cwd: ~/projects/research
    session_id: 22222222-2222-2222-2222-222222222222
    permission_mode: bypassPermissions
    # ...

surfaces:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    allow_list_user_ids: [123456789]
    channel_routing:
      "987654321": triage-agent       # channel snowflake → agent_id
      "987654322": research-agent

  telegram:
    bot_token_env: TELEGRAM_BOT_TOKEN
    allow_list_user_ids: [987654321]
    chat_routing:
      "456789": triage-agent

  slack:
    bot_token_env: SLACK_BOT_TOKEN
    allow_list_user_ids: [U12345678]
    channel_routing:
      "C0123456": triage-agent

  webui:
    bind: 127.0.0.1:7878
    session_token_env: CCAW_WEBUI_TOKEN

  rest:
    bind: 127.0.0.1:7879

scheduler:
  heartbeat:
    triage-agent: 30m

cron_jobs:
  - agent: triage-agent
    schedule: "0 9 * * 1-5"
    prompt: "Daily standup: check overnight build failures, summarise PRs."
```
