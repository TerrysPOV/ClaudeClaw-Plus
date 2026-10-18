<p align="center">
  <img src="images/claudeclaw-banner.svg" alt="ClaudeClaw+ Banner" />
</p>
<p align="center">
  <img src="images/claudeclaw-plus-wordmark.svg" alt="ClaudeClaw+ Wordmark" />
</p>

<p align="center">
  <a href="https://github.com/TerrysPOV/ClaudeClaw-Plus/stargazers">
    <img src="https://img.shields.io/github/stars/TerrysPOV/ClaudeClaw-Plus?style=flat-square&color=f59e0b" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/TerrysPOV/ClaudeClaw-Plus/commits/main">
    <img src="https://img.shields.io/github/last-commit/TerrysPOV/ClaudeClaw-Plus?style=flat-square&color=0ea5e9" alt="Last Commit" />
  </a>
  <a href="https://github.com/TerrysPOV/ClaudeClaw-Plus/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/TerrysPOV/ClaudeClaw-Plus?style=flat-square&color=a855f7" alt="Contributors" />
  </a>
</p>

<p align="center"><b>ClaudeClaw, plus the heavy stuff. Governance, orchestration, persistent memory, hardened web UI.</b></p>

ClaudeClaw+ is a sister project to [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) — the lightweight Claude Code daemon you already know. Plus exists to house the features that are too heavy or too opinionated for the core repo: a full governance and policy layer, durable multi-step orchestration, persistent cross-session memory, and a hardened web UI.

Everything from upstream lives here too. Plus has now diverged significantly from upstream, so alignment is maintained on a best-effort manual basis rather than via an automated sync.

> Note: Please don't use ClaudeClaw+ for hacking any bank system or doing anything illegal. Same rules apply.

---

## Standing on the shoulders of giants

ClaudeClaw+ is built on top of the original [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw), created by [@moazbuilds](https://github.com/moazbuilds). The core daemon, Telegram/Discord adapters, heartbeat, web dashboard, skills system — all of that comes from upstream and the amazing contributors who built it.

**Upstream contributors — thank you:**

<a href="https://github.com/moazbuilds/claudeclaw/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=moazbuilds/claudeclaw" />
</a>

### Staying aligned with upstream

Plus has diverged significantly from `moazbuilds/claudeclaw`, so the previous automated daily sync has been retired. Alignment is now best-effort and manual: upstream fixes and features are reviewed and ported by hand when they make sense for Plus.

There is no guaranteed turnaround on upstream changes landing here. If you need a specific upstream commit applied to Plus, open an issue.

---

## Why ClaudeClaw+?

| Category | ClaudeClaw | ClaudeClaw+ | OpenClaw |
| --- | --- | --- | --- |
| Anthropic Will Come After You | No | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Same | Nightmare |
| Setup & Installation | ~5 minutes | ~5 minutes | Nightmare |
| Isolation | Folder-based and isolated as needed | Folder-based + per-agent scope | Nightmare |
| Reliability | Simple reliable system | Simple + multi-step workflows with topological DAGs | Nightmare |
| Feature Scope | Lightweight features you actually use | Everything in ClaudeClaw, plus governance and orchestration | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Policy engine, audit log, CSRF protection | Nightmare |
| Cost Control | Manual | Automatic token budgets + model routing per task type | Nightmare |
| Memory | Claude internal memory + `CLAUDE.md` | Persistent cross-session `MEMORY.md` with dual-layer write guarantee (legacy runner) | Nightmare |
| Multi-step Jobs | Cron + heartbeat | DAG orchestrator with dependency resolution (legacy runner) | Nightmare |

---

## What's new in v2.0 — Bus runtime is the default

As of v2.0 (May 2026), ClaudeClaw+ runs on a new **event-bus architecture** by default. PTY is the official execution engine ([#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)), while the `claude -p` subprocess path remains a **permanent first-class option** — especially for enterprise deployments with audit trails, cost ceilings, or scripting constraints. Operators pick per deployment: interactive event-bus or PTY supervision for continuous agent workflows, or `claude -p` for isolated subprocess work. Both are fully supported, side by side.

Here's what changes when you pick the bus runtime:

- **One long-lived `claude` process per declared agent** when using interactive supervision (`pty-stdin`), rather than a fresh subprocess per event. (Cron jobs and agent jobs route through `runner.ts` and follow `pty.enabled`: running via `claude -p` under the current default `pty.enabled: false`, and via the PTY supervisor when `pty.enabled: true`).
- **Typed event bus (`BusCore`)** sits between adapters (Discord, Telegram, Slack, web UI, cron, REST, CLI) and agents. Inbound events publish to topics; agents subscribe; replies flow back as `response.text`, `channel.permission_request`, or `system.request_human`.
- **Origin-aware routing** — a Discord reply goes back to the Discord channel that triggered it, not fanned out across every channel the agent is wired to.
- **Per-agent process isolation** — agents have separate working directories, permission modes, system prompts, and memory files.
- **Human-in-the-loop permission gate** — privileged tool calls (Bash, Edit, etc.) prompt the operator inline when configured via per-agent `permission_mode` (default is `bypassPermissions`). Approve or deny from any connected channel.
- **MCP multiplexer** fronts shared MCP servers behind a single HTTP endpoint with per-agent identity tokens — no per-PTY process explosion.

Architecture spec: [`docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`](docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md).

Huge thanks to [@Nibbler1250](https://github.com/Nibbler1250) for landing many of the heavy adapter pieces that made the bus runtime production-ready — composite-keyed routing, inline progress UX, the per-chat flood protection, the Windows host validation, and the getUpdates timeout recovery. The bus is shipping today because of that work.

---

## Getting Started in 5 Minutes

```bash
claude plugin marketplace add TerrysPOV/ClaudeClaw-Plus
claude plugin install claudeclaw-plus
```

Then open a Claude Code session and run:

```
/claudeclaw-plus:start
```

The setup wizard covers the choices listed below. Your daemon is live in under five minutes.

---

## Setup choices at first run

The wizard (and `settings.json`) asks you to decide six things. None of them are permanent — every one is editable in `settings.json`. Certain operational parameters (heartbeat, legacy security level, MCP bridge policy, jobs) reload automatically within ~30s; structural changes (adapters, agents, runtime, tokens, bind addresses) require a daemon restart (see [Changing decisions later](#changing-decisions-later)).

### 1. Which adapters to enable

Pick the surfaces you want the daemon to listen on. Multiple adapters can run at once.

| Adapter | Status | Where to enable |
|---|---|---|
| **Discord** | Production-tested | `discord.token`, `discord.busRouting.channels` (required under bus; non-empty `discord.allowedUserIds` required) |
| **Telegram** | Production-tested | `telegram.token`, `telegram.busRouting.chats` |
| **Slack** | ⚠️ Less tested than Discord/Telegram — see [Adapters](#adapters) | `slack.botToken`, `slack.busRouting.channels` |
| **Web UI (Dashboard)** | Production-tested | `web.enabled: true`, `web.host:web.port` (default `127.0.0.1:4632`) |
| **Web UI (Bus Adapter)** | Production-tested | `web.bus.bind` (default `127.0.0.1:7878`) |

> ⚠ **Discord Note:** Under the event-bus runtime, `discord.busRouting` (`channels`, `threads`, `dmAgentId`, or `primaryChannelByAgent`) must be configured (`src/config.ts:1568-1591`, `src/adapters/discord/index.ts:266-270`). Note that `guilds` is not a supported routing key. In addition, `discord.allowedUserIds` must not be empty; an empty allowlist refuses all incoming messages (`src/adapters/discord/index.ts:247`, `src/allowlist.ts`).

### 2. Primary model + fallback

In `settings.json`, `model` and `fallback.model` default to empty strings `""` (`src/config.ts:86-90`), inheriting Claude Code's active model. The setup wizard offers `opus` (default), `sonnet`, `haiku`, and `glm`.

When configured, `fallback.model` triggers on rate-limit messages detected in output (`you've hit your limit`, `out of extra usage`; `src/runner.ts:400, 586-593`), executing via `runner.ts` (`src/runner.ts:2125-2135`) for legacy tasks (fallback routing does not apply to bus agents). `kimi-k2p6` routes directly to Kimi's Coding API at `https://api.kimi.com/coding/` (`src/runner.ts:643-644`), not OpenRouter.

### 3. Permission mode per agent

The most consequential setup choice. Each agent declares one:

- **`bypassPermissions`** — runs without prompting (the default for bus agents; recommended for headless deployments where you trust the agent's scope)
- **`plan`** — drafts a plan first, you approve before execution
- **`acceptEdits`** — auto-allows file edits, prompts for shell/network
- **`default`** — Claude Code's interactive default (prompts inline on every tool call)
- **`dontAsk`** — never prompts, denies anything that needs approval
- **`auto`** — Claude decides per-tool

Set per-agent in `settings.agents[].permission_mode`. The wizard picks `bypassPermissions` if you don't choose explicitly (`src/bus/agent-resolver.ts:73`). Note that `security.level` applies to the legacy `runner.ts` path and does not restrict bus agents.

### 4. Agents

Bus runtime needs at least one agent. A `settings.json` with no `agents` key (for example one carried over from the original claudeclaw) gets one `{ "id": "default" }`; an explicit `"agents": []` mounts the bus with no agent, and startup logs a warning. The minimal entry is just an `id`:

```json
"agents": [
  { "id": "default" }
]
```

Each agent has its own working directory, system prompt file, and memory file. See `BusAgentSettings` in [`src/config.ts`](src/config.ts) for the full per-agent shape.

> ⚠ **Important if you have an `agents/` directory on disk.** Every directory under `agents/<name>/` with jobs in it MUST have a matching entry in `settings.agents[]`. If not, the bus runtime publishes prompts targeting `agent_id: <name>` but no process is subscribed, and your jobs silently fail. The daemon now logs `[bus-runtime] WARN: agent dir "<name>" has N scheduled job(s) ... but is not declared in settings.agents` at startup when a mismatch is detected — fix the warning either by adding `{ "id": "<name>" }` to `settings.agents` or by removing the orphan `agents/<name>/jobs/` directory.

### 5. Primary channel per agent (Discord + Slack)

Without this, cron/heartbeat replies fan out to **every** channel routed to the agent. With it, those non-channel-driven events go to one designated channel only. Highly recommended on Discord/Slack with multi-channel setups:

```json
"discord": {
  "busRouting": {
    "channels": { "<id1>": "default", "<id2>": "default" },
    "primaryChannelByAgent": { "default": "<id1>" }
  }
}
```

Telegram already routes one chat per agent, so this setting is Discord/Slack only.

### 6. Heartbeat, cron, security

- **`heartbeat.enabled`** + `interval` (minutes) + `excludeWindows` for quiet hours. Off by default.
- **Cron jobs** — see `commands/` and the wizard's cron setup step. Note that cron jobs execute via `runner.ts` under both runtimes and follow `pty.enabled` (`claude -p` subprocesses under the current default `pty.enabled: false`, or the PTY supervisor when `pty.enabled: true`; `src/runner.ts:2015, 2690`).
- **`security.level`** — `locked` (read-only searching/reading), `strict`, `moderate`, `unrestricted` (default `moderate`). Applies to the legacy `runner.ts` execution engine and prompt construction (`src/runner.ts:1501, 1512, 1999`); bus agents are governed by `permission_mode` per agent. Per-tool overrides via `allowedTools` / `disallowedTools`.

---

## Changing decisions later

Every setup choice is editable. There are three update paths:

### A. Edit `settings.json` directly

Located at `<project>/.claude/claudeclaw/settings.json` (per-project configuration). The daemon polls this file every 30 seconds (`src/commands/start.ts:1693-1789`).

**Hot-reload-safe changes (applied within ~30s without restart):**
- Heartbeat interval and exclude windows (`src/commands/start.ts:1700-1707`)
- Security level for legacy runner (`src/commands/start.ts:1709-1715`)
- MCP bridge tool policy (`src/commands/start.ts:1717-1723`)
- Scheduled job list (`src/commands/start.ts:1725-1748`)
- PTY execution mode toggle (`pty.enabled`) for `runner.ts` paths (`src/runner/pty-supervisor.ts:36-39`, `src/runner.ts:742`)

**Restart-required changes (require restarting the daemon):**
- Adapter routing (`discord.busRouting`, `telegram.busRouting`, `slack.busRouting`, `web.bus`)
- Agent declarations (`agents[]`) and agent `permission_mode`
- Runtime mode (`runtime`) — switching between `"bus"` and `"pty"` (`src/commands/start.ts:606-607`)
- Authentication tokens (`discord.token`, `telegram.token`, `slack.botToken`)
- Web UI bind addresses (`web.host`, `web.port`, `web.bus.bind`)
- MCP shared and stateless server processes

Restarting while an agent is mid-turn: `GET /api/health` reports `busy: true` while any turn is active, so a deploy script can wait for it to clear. If you restart anyway, the daemon drains on `SIGTERM`/`SIGINT` — it waits up to `shutdown.drainTurnsMs` (default `30000`, `0` to stop at once) until the bus owes the model nothing (no turn in flight, no prompt still queued, held through a compaction or being verified), gives the last reply a second to leave the adapter (an idle daemon therefore takes about a second to exit, so a prompt accepted right after the signal is still seen), and logs which turns finished, which agents lost their connection before `turn_end`, and what was still busy when it gave up. A second signal stops the wait. Two conditions for the drain to protect anything: keep the value under your service manager's stop timeout (systemd `TimeoutStopSec` defaults to 90 s), and make sure the signal reaches only the daemon — with systemd's default `KillMode=control-group` the `claude` children die at the same instant and there is nothing left to drain; use `KillMode=mixed` (see `docs/deploy-systemd-hardening.md`). New prompts are still accepted during the drain, so under steady traffic it runs to the window.

### B. Slash commands

- **`/mode <mode>`** — toggles permission mode on the **legacy Telegram adapter only** (`src/commands/telegram.ts:1470-1513`).
- **Commands under bus runtime**: Under the default event-bus runtime, adapters forward messages directly to `BusCore` as inbound events; slash commands (`/mode`, `/heartbeat`, `/agents`, `/help`) are **not** intercepted or handled by bus adapters (`src/bus/core.ts:2470-2475`, `src/adapters/discord/index.ts:646-647`).

### C. Web UI

Browse to `http://<web.host>:<web.port>` (default `http://127.0.0.1:4632`). Enabled with the `--web` CLI flag or `web.enabled: true` in `settings.json`. Authentication requires the token stored in `<project>/.claude/claudeclaw/web.token`. Manage jobs, monitor runs, inspect logs, and toggle the heartbeat from the dashboard.

For headless programmatic access to the event bus, the bus web adapter binds separately to `web.bus.bind` (default `127.0.0.1:7878`), exposing `GET /health`, `POST /prompt`, and `GET /ws`.

---

## Adapters

Adapter coverage as of v2.0:

- **Discord** — full production support. Multi-channel routing, threads, DMs, permission flow, inline progress UX, primary-channel-per-agent for cron/heartbeat. Tested daily on a live Hetzner deployment.
- **Telegram** — full production support. Per-chat routing, bracketed-paste prompt delivery, bounded spinner edits with per-chat 429 cooldown, voice/image input via Whisper.
- **Slack** — ⚠️ **less tested than Discord and Telegram.** The code paths are implemented (channels, threads, signing-secret verification, permission flow, primary-channel-per-agent), but the v2.0 soak ran without a daily Slack deployment. **Please file [issues](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) or PRs as you encounter them — we'll review and ship fixes promptly.**
- **Web UI** — production-tested. The web dashboard provides CSRF protection and mobile responsiveness at `http://<web.host>:<web.port>` (default `127.0.0.1:4632`), while the bus web adapter serves HTTP and WebSocket endpoints at `web.bus.bind` (default `127.0.0.1:7878`). Note that `web.bind` is not a valid setting (`src/config.ts:203, 911-915`).

---

## What's in Plus that isn't in claudeclaw

These features originated as PRs to `moazbuilds/claudeclaw` and have been closed upstream — they're out of scope for the lightweight core and live here permanently. Links below point to the originating PRs so you can read the full rationale.

### Execution Modes and Engine Policy

**Tracking issues: [#61](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/61), [#546](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/546), [#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550), [#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)**

ClaudeClaw+ supports two distinct runtimes (`runtime: "bus"` and `runtime: "pty"`) and two execution engines: interactive PTY supervision and non-interactive `claude -p` subprocess execution.

**Engine Policy ([#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)):**
- **Interactive PTY** is the official execution engine of ClaudeClaw+.
- **`claude -p`** remains a permanently supported option for programmatic execution, scriptable environments, or headless subprocess tasks (`pty.enabled: false`, `supervision: "process-stream-json"`).
- **Bus Supervision vs. `pty.enabled`:** Bus agent turns do not consult `pty.enabled`. Under `runtime: "bus"`, declared agents receive `entry.supervision ?? "pty-stdin"` (`src/bus/agent-resolver.ts:73`). Undeclared spawns fall back to `defaultSupervisionFor(origin)` (`pty-stdin` for channel-driven origins, `process-stream-json` for others; `src/bus/types.ts:54-56, 77-85`). The valid `SupervisionMode` values are `pty-stdin`, `process-stream-json`, `tmux`, and `process` (`src/bus/types.ts:48-52`).
- **Scope of `pty.enabled`:** `pty.enabled` governs `runner.ts` paths only (`src/runner.ts:732-742, 2015, 2070`): agent turns and dashboard chat under `runtime: "pty"`, plus cron jobs (`job-loop.ts`), agent jobs, rate-limit fallback, and forks under either runtime. Under `runtime: "bus"`, dashboard chat routes directly through `streamBusPrompt()` to the default bus agent (`src/commands/start.ts:1415-1439`) and does not consult `pty.enabled`.
- **Current Defaults:** In the current release, `pty.enabled` defaults to `false` (meaning `runner.ts` paths fall back to `claude -p`). A future release ([#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550)) will flip the default to `pty.enabled: true`.
- **Runtime Isolation:** Switching between `runtime: "bus"` and `runtime: "pty"` requires a full daemon restart (`src/commands/start.ts:606-607`). The two runtimes share neither IPC nor runtime state.

#### Execution Modes Matrix

| Runtime | `pty.enabled` | Bus Agent Turns (Supervision) | `runner.ts` Paths (Cron, Agent Jobs, Fallback, Forks; Dashboard Chat under legacy pty runtime) | Details & Architecture |
|---|---|---|---|---|
| `runtime: "bus"` (default) | `false` (current default) | `pty-stdin` (or declared `supervision`) | `claude -p` (`process-stream-json`) | Bus agents run with `pty-stdin` (or per-agent `supervision`); undeclared spawns follow `defaultSupervisionFor(origin)`. `pty.enabled` does not change bus agent supervision. Dashboard chat routes through `streamBusPrompt()` to the default bus agent (`src/commands/start.ts:1415-1439`). Cron jobs (`job-loop.ts:21-30`), agent jobs, fallback, and forks route through `runner.ts` and run as `claude -p` (`src/runner.ts:732-742, 2015, 2070, 2690`). |
| `runtime: "bus"` | `true` (upcoming default) | `pty-stdin` (or declared `supervision`) | Interactive PTY supervisor | Bus agents run with `pty-stdin` (or per-agent `supervision`). Dashboard chat routes through `streamBusPrompt()` to the default bus agent (`src/commands/start.ts:1415-1439`). Cron jobs, agent jobs, fallback, and forks route through `runner.ts` and run on the PTY supervisor (`src/runner.ts:732-742, 2015, 2070, 2690`). |
| `runtime: "pty"` | `false` (current default) | N/A (bus runtime not mounted) | `claude -p` (`process-stream-json`) | Legacy runner spawns a fresh `claude -p` subprocess per inbound event, cron job, agent job, fallback, or dashboard chat (`src/commands/start.ts:1432-1438`, `src/runner.ts:732-742, 2015, 2070`). |
| `runtime: "pty"` | `true` (upcoming default) | N/A (bus runtime not mounted) | Interactive PTY supervisor | Legacy runner routes agent turns, cron jobs, agent jobs, fallback, and dashboard chat to the interactive PTY supervisor (`src/commands/start.ts:1432-1438`, `src/runner.ts:732-742, 2015, 2070`). |

#### When to pick `claude -p` vs. PTY / Bus

**When to pick `claude -p` execution:**
- **Audit / compliance**: Every invocation is its own subprocess with a clean stdin/stdout boundary — easier to log, intercept, and reason about than a long-lived interactive session.
- **Predictable cost ceilings**: Clean subprocess boundaries allow precise metering per command.
- **Stateless environments**: No long-lived process management or terminal state to maintain.

**When to pick interactive PTY / Bus:**
- **Full tool interactivity**: Long-lived interactive sessions with real-time streaming, interactive approvals, and persistent state.
- **Lower latency**: Avoids per-turn subprocess cold start.
- **Multi-channel routing**: The event bus routes between Discord, Telegram, Slack, and the Web UI with origin-aware replies.
- **Per-agent supervision**: Distinct working directories, system prompts, and memory files per declared agent.

#### Settings block (defaults shown)

```json
"pty": {
  "enabled": false,
  "idleReapMinutes": 30,
  "maxConcurrent": 32,
  "maxRetries": 5,
  "backoffMs": [1000, 2000, 4000, 8000, 16000],
  "namedAgentsAlwaysAlive": true
}
```

> **Note on hot-reload:** Switching `runtime` between `"bus"` and `"pty"` requires restarting the daemon (`src/commands/start.ts:606-607`). In contrast, `pty.enabled` is hot-reload-safe: changes in `settings.json` take effect on the next invocation within ~30s (`src/runner/pty-supervisor.ts:36-39`, `src/runner.ts:742`).

#### References

- Bus architecture spec: [`docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`](docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md)
- Tracking issues: [#61](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/61), [#546](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/546), [#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550), [#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)

---

### MCP multiplexer — shared MCP-server processes across PTYs

**Tracking issue: [#72](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/72) · Lands across [#71](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/71), [#78](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/78), and a series of v1.1 hardening PRs (#91–#97)**

The multiplexer hosts each shared MCP server child **once** and demultiplexes per-PTY traffic over a loopback HTTP route (`/mcp/<server>`). Each PTY claude gets a synthesized `--mcp-config` JSON pointing at that route with a per-PTY bearer + identity headers. Without this, every PTY would spawn its own copy of every MCP server — N × M subprocesses for N PTYs × M servers — which OOMs even a modest Hetzner box at moderate concurrency.

> **Requirement:** The MCP multiplexer requires `web.enabled: true` to be persisted in `settings.json` (`src/commands/start.ts:1053`), as its proxy endpoints (`/mcp/<server>`) are registered on the dashboard HTTP server (`src/commands/start.ts:1111-1120`). Note that passing the `--web` CLI flag alone is not sufficient to activate the multiplexer at startup because the daemon evaluates `settings.web.enabled` before reconciling CLI flags (`src/commands/start.ts:1053, 1481`).

#### Operator footgun: `mcp-proxy.json` ↔ `~/.claude/mcp.json` collisions

claude's `--mcp-config` flag is **additive** to its own `~/.claude/mcp.json` discovery. The two configs MERGE by server name. If a server name appears in **both** `~/.config/claudeclaw/mcp-proxy.json` (or whichever path you configured) **and** `~/.claude/mcp.json`, claude will:

1. **Spawn the stdio entry** from `~/.claude/mcp.json` on every PTY — one extra subprocess per PTY per colliding name.
2. **Also make HTTP calls** to the multiplexer's `/mcp/<server>` for the same name from the synthesized config.

Net effect: you get the per-PTY process explosion the multiplexer was designed to prevent, but for the colliding servers specifically — silently, with no visible error.

**Fix:** for every server name you list in `settings.mcp.shared` (and define in `mcp-proxy.json`), **remove that name from `~/.claude/mcp.json`**. The multiplexer is now the single source of truth for those servers across PTY claudes.

**Detection:** at startup, the multiplexer reads `~/.claude/mcp.json` (best-effort) and logs a `WARN [mcp-multiplexer]` line listing the colliding names. It also emits a `multiplexer_user_mcp_collision` audit event with `{path, collisions: [...]}` so dashboards can alert on it. The warning is observability — the multiplexer still starts, claude still spawns the duplicates, but you know what's happening.

#### Settings block (defaults shown)

```json
"mcp": {
  "shared": [],
  "perPtyOnly": [],
  "stateless": [],
  "healthProbeIntervalMs": 30000,
  "sessionPersistenceEnabled": true,
  "sessionMaxAgeSeconds": 3600,
  "sessionPersistencePath": "",
  "rateLimit": {
    "maxRequestsPerWindow": 600,
    "windowMs": 60000
  }
}
```

- `shared` — server names (must also exist in `mcp-proxy.json`) the multiplexer hosts. Empty list = dormant; PTY claudes fall back to per-PTY stdio spawns (no protection from the explosion).
- `stateless` — subset of `shared` for servers with no per-session state; the multiplexer keeps no session binding on disk for them and replays none at restart. It does **not** change client demultiplexing: every PTY still gets its own MCP session against the multiplexer (a session cannot be shared by two clients), and the upstream child is a single shared process for every server either way.
- `rateLimit` — per-bearer (= per-PTY) sliding-window cap on `/mcp/<server>` requests. Defense-in-depth for a leaked bearer.

#### Surface coverage: tools only (no resources / prompts / completions)

The multiplexer currently proxies **`ListTools` + `CallTool` only**. MCP servers can also expose `resources/*`, `prompts/*`, and `completions/*` per the MCP spec — those surfaces are **not** forwarded through the multiplexer. If a shared server defines them, PTY claudes won't see them through the multiplexed `/mcp/<server>` route.

**Practical impact:** none for the MCP servers we ship with by default (graphiti, codegraph, sentrux, etc. — all tool-only). Servers that depend on resource attachments (file-pinning workflows) or prompt templates won't surface that surface through a multiplexed mount.

**Workarounds if you need resources / prompts from a specific server:**

1. **Drop it from `settings.mcp.shared`** — claude will then spawn it per-PTY via the normal stdio path (the explosion concern applies; only worth it for the server that needs the extra surfaces).
2. **Wait for the feature extension** — tracked as #72 item 12. Would require new `ListResourcesRequestSchema` / `ReadResourceRequestSchema` / `ListPromptsRequestSchema` / `GetPromptRequestSchema` handlers wired through the SDK transport. No design blockers, just unbuilt.

#### References

- v1.1 follow-ups: [#72](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/72)

---

### Policy Engine — fine-grained tool governance

**[PR #71 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/71)**

> **Note:** The Policy Engine operates on the legacy `runner.ts` execution pipeline (`src/runner.ts:39-62`). Under the default event-bus runtime, agent permissions are governed per-agent via `settings.agents[].permission_mode`.

Every tool call (Bash, Read, Edit, etc.) is evaluated against deterministic rules before execution. Rules can allow, deny, or gate behind operator approval — scoped by channel, user, skill, and source. Includes an audit log and a bounded LRU approval cache.

**Why:** Replaces blanket `--dangerously-skip-permissions` with actual governance for legacy runner invocations. Operators can deny destructive tools in public channels, require approval for high-risk operations, and keep a tamper-evident audit trail for compliance.

---

### Governance Layer — model routing, budgets, watchdog

**[PR #72 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/72)**

> **Note:** The Governance Layer operates on the legacy `runner.ts` execution pipeline (`src/runner.ts:39-62`) and does not govern bus agents.

Sits between the daemon and Claude CLI. Automatically routes planning tasks to Opus and implementation tasks to Sonnet. Tracks token and cost spend per session and globally, with configurable warn/throttle/block states. Watchdog kills runaway sessions before they drain your credits.

**Why:** Stops cost overruns before they happen. Makes ClaudeClaw safe to leave unattended — the thing that needs a babysitter becomes the babysitter.

---

### Gateway, Events & Escalation — unified ingestion and replayable event log

**[PR #73 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/73)**

> **Note:** The Gateway and escalation framework operate on the legacy adapter pipeline (`src/commands/telegram.ts:31, 1742`, `src/commands/discord.ts:1333`); the event-bus runtime uses `BusCore` topics and subscriptions instead.

Unified message ingestion pipeline normalises Discord/Telegram messages to a common format. Crash-safe append-only event log, retry queue with exponential backoff, dead-letter queue, full event replay, and an escalation framework (pause session, hand off to a human, notify across channels).

**Why:** Eliminates duplicated per-adapter logic and gives you an audit trail you can replay. When something goes wrong at 3am, you can see exactly what happened and re-run it.

---

### Orchestrator — DAG task graph and resumable jobs

**[PR #74 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/74)**

> **Note:** The DAG Orchestrator operates on the legacy `runner.ts` execution pipeline and does not govern bus agent turns. Workflows do not persist across daemon restarts mid-execution.

Multi-step task execution via dependency graph with topological sort. Durable workflow state with atomic writes during active execution. Governance-integrated executor with configurable parallelism.

**Why:** Complex requests decompose into dependent subtasks that run in parallel where possible.

---

### CSRF Protection for Web UI

**[PR #75 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/75)**

Cryptographically random single-use UUID tokens per session, timing-safe comparison, conditional `Secure` cookie flag, and a client-side `mutatingFetch()` wrapper that auto-retries on 403.

**Why:** Prevents malicious cross-origin pages from triggering heartbeat toggles, job runs, or chat actions in an operator's logged-in browser — hardening on top of whatever reverse-proxy auth you're running.

---

### Persistent Memory — cross-session `MEMORY.md`

**[PR #77 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/77)**

> **Note:** The dual-layer memory write guarantee operates on the legacy `runner.ts` invocation pipeline (`src/runner.ts:69`). Bus agents use per-agent memory files configured in `settings.agents[].memory_file`.

`MEMORY.md` loaded into `--append-system-prompt` on every invocation. Dual-layer write guarantee: Claude is instructed to write after each task, and a daemon-side fallback appends a log entry if `MEMORY.md` is unchanged after a run. Pre-compact and pre-shutdown saves, 200-line cap with auto-trim, per-agent memory paths.

**Why:** Sessions stop being amnesiac. Claude remembers prior work across restarts, compactions, and crashes — making long-running deployments coherent.

---

### Multi-Session Discord Threads

Each Discord thread gets its own Claude CLI session, fully isolated. Thread conversations run concurrently without blocking each other. First message in a new thread bootstraps a fresh session automatically.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for technical details.

---

### Daemon Plugin API

**[PR #144 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/144)**

OpenClaw-compatible lifecycle events at the daemon level — `gateway_start`, `before_agent_start`, `before_prompt_build`, `tool_result_persist`, `agent_end`, and more. Plugins hook in via `api.on()`, `api.registerService()`, and `api.registerCommand()`. Includes path traversal prevention, SSRF-safe health checks, and fire-and-forget async emission.

**Why:** Lets external code extend the daemon without modifying it — memory systems, observability, custom routing, anything.

---

## All the things from upstream

Everything ClaudeClaw ships, Plus ships too:

- **Heartbeat** — periodic check-ins, configurable intervals, quiet hours
- **Cron Jobs** — timezone-aware schedules, one-time and repeating
- **Telegram** — text, image, and voice support
- **Discord** — DMs, server mentions/replies, slash commands, voice, images
- **GLM Fallback** — continue with GLM models when your primary limit is hit
- **Web Dashboard** — manage jobs, monitor runs, inspect logs in real time
- **Security Levels** — four access levels (`locked`, `strict`, `moderate`, `unrestricted`) for the legacy runner
- **Skills & Plugins** — folder-based, isolated as needed

---

## Contributing

**Scope matters here.** ClaudeClaw+ is for heavy, opinionated, and architecturally significant work. If your idea fits the lightweight upstream repo, it should go to [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) — that's still the right home for bug fixes, small improvements, and new integrations. Work submitted here that belongs upstream won't be merged; it'll be redirected back.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full scope guide and how to decide where your contribution belongs.

Short version for ClaudeClaw+: open an issue first, then the PR. Large refactors fine. New subsystems fine. Multi-file stacks fine. Just talk first, code second.

### Linting

Linting and formatting are handled by [Biome](https://biomejs.dev/). One tool, no ESLint/Prettier split. Run `bun run lint` to check, `bun run lint:fix` to auto-fix safe rules, or `bun run format` for formatter-only. CI fails on ERROR-level findings via `.github/workflows/lint.yml`.

A few rules are relaxed to `warn` because the patterns are pervasive and defensible: `noNonNullAssertion`, `noExplicitAny`, `useTemplate`, and `noUnusedVariables/Imports`. `noConsole` and `noUnusedFunctionParameters` are off entirely — the daemon legitimately logs to stdout, and interface implementations often accept parameters they don't use. See `biome.json` for the full config.

---

## Roadmap

Watch the [Issues](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) tab for upcoming work. Want to propose something? Open a discussion — all ideas welcome.

---

## FAQ

<details open>
  <summary><strong>Is this a hard fork?</strong></summary>
  <p>
    It's a sister project — same foundation, wider scope. Plus has diverged enough from <a href="https://github.com/moazbuilds/claudeclaw">moazbuilds/claudeclaw</a> that the previous daily automated sync has been retired; alignment is now maintained on a best-effort manual basis, with no guaranteed turnaround on upstream changes.
  </p>
</details>

<details open>
  <summary><strong>Will features here go back upstream?</strong></summary>
  <p>
    Unlikely for the Plus-exclusive features — they've been closed upstream as out-of-scope for the lightweight core.
    <a href="https://github.com/moazbuilds">@moazbuilds</a> decides what fits the lightweight core.
    Whether they get merged upstream or not, they're available here today.
  </p>
</details>

<details open>
  <summary><strong>Why not just keep these as PRs upstream?</strong></summary>
  <p>
    Six PRs totalling ~55,000 lines of additions need a home where they can actually be used.
    Sitting as open PRs with no activity doesn't help anyone.
    ClaudeClaw+ is that home.
  </p>
</details>

<details open>
  <summary><strong>Is this breaking Anthropic ToS?</strong></summary>
  <p>
    No. Same answer as upstream: ClaudeClaw+ is local usage inside the Claude Code ecosystem.
    It wraps Claude Code directly and does not require third-party OAuth outside that flow.
  </p>
</details>

<details open>
  <summary><strong>Will Anthropic / @moazbuilds sue you for building ClaudeClaw+?</strong></summary>
  <p>
    I hope not.
  </p>
</details>

---

## Screenshots

### Web Dashboard
![Cool UI to manage and check your ClaudeClaw](images/dashboard.png)

### Claude Code Status Bar
![Claude Code folder-based status bar](images/bar.png)

---

## Contributors

Thanks for building ClaudeClaw+.

<a href="https://github.com/TerrysPOV/ClaudeClaw-Plus/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=TerrysPOV/ClaudeClaw-Plus" />
</a>
</content>
