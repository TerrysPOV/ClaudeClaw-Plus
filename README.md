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
| Reliability | Simple reliable system | Simple + a DAG workflow engine (topological order, restart recovery; engine only, see [DAG Orchestrator](#orchestrator--dag-task-graph-and-resumable-jobs)) | Nightmare |
| Feature Scope | Lightweight features you actually use | Everything in ClaudeClaw, plus governance and orchestration | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Policy engine, audit log, CSRF protection | Nightmare |
| Cost Control | Manual | Automatic token budgets + model routing per task type | Nightmare |
| Memory | Claude internal memory + `CLAUDE.md` | Persistent cross-session `MEMORY.md` with dual-layer write guarantee (runner path only, see [Persistent Memory](#persistent-memory--cross-session-memorymd)) | Nightmare |
| Multi-step Jobs | Cron + heartbeat | DAG workflow engine with dependency resolution and resumable state (engine only: no job path submits workflows yet) | Nightmare |

---

## What's new in v2.0 — Bus runtime is the default

As of v2.0 (May 2026), ClaudeClaw+ runs on a new **event-bus architecture** by default. PTY is the official execution engine ([#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)), while the `claude -p` subprocess path remains a **permanent first-class option** — especially for enterprise deployments with audit trails, cost ceilings, or scripting constraints. Operators pick per deployment: interactive event-bus or PTY supervision for continuous agent workflows, or `claude -p` for isolated subprocess work. Both are fully supported, side by side.

Here's what changes when you pick the bus runtime:

- **One long-lived `claude` process per declared agent** when using interactive supervision (`pty-stdin`), rather than a fresh subprocess per event. (Cron jobs and agent jobs route through `runner.ts` and follow `pty.enabled`: running on the PTY supervisor under the current default `pty.enabled: true` (`false` on Windows), and via `claude -p` only when `pty.enabled: false` is set explicitly).
- **Typed event bus (`BusCore`)** sits between adapters (Discord, Telegram, Slack, web UI, cron, REST, CLI) and agents. Inbound events publish to topics; agents subscribe; replies flow back as `response.text`, `channel.permission_request`, or `system.request_human`.
- **Origin-aware routing** — a Discord reply goes back to the Discord channel that triggered it, not fanned out across every channel the agent is wired to.
- **Per-agent process isolation** — agents have separate working directories, permission modes, and system prompts.
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

The wizard (and `settings.json`) asks you to decide six things. None of them are permanent — every one is editable in `settings.json`. Operational parameters (heartbeat, jobs, the legacy security level, MCP bridge policy, `pty.enabled`, channel allow-lists) reload automatically within ~30s; structural changes (adapter routing, agents, runtime, the web dashboard and bind settings, and tokens under the bus runtime) require a daemon restart (see [Changing decisions later](#changing-decisions-later)).

### 1. Which adapters to enable

Pick the surfaces you want the daemon to listen on. Multiple adapters can run at once.

| Adapter | Status | Where to enable |
|---|---|---|
| **Discord** | Production-tested | `discord.token`, `discord.busRouting` (at least one of `channels`, `threads`, `dmAgentId`, or `primaryChannelByAgent` required under bus; non-empty `discord.allowedUserIds` required unless `discord.allowAllUsers: true`) |
| **Telegram** | Production-tested | `telegram.token`, `telegram.busRouting.chats` |
| **Slack** | ⚠️ Less tested than Discord/Telegram — see [Adapters](#adapters) | `slack.botToken`, `slack.busRouting.channels` |
| **Web UI (Dashboard)** | Production-tested | `web.enabled: true`, `web.host:web.port` (default `127.0.0.1:4632`) |
| **Web UI (Bus Adapter)** | Production-tested | `web.bus.bind` (default `127.0.0.1:7878`) |

> ⚠ **Discord Note:** Under the event-bus runtime, `discord.busRouting` must configure at least one routing destination (`channels`, `threads`, `dmAgentId`, or `primaryChannelByAgent`) to mount the adapter (`src/config.ts:1621-1628`, `src/bus/adapter-wiring.ts:197`, `src/adapters/discord/index.ts:266-270`). Note that `guilds` is not a supported routing key. In addition, an empty `allowedUserIds` fails closed and refuses all incoming messages unless intentionally configured as a public bot with `discord.allowAllUsers: true` (`src/allowlist.ts:13-21, 33-35`, `src/adapters/discord/index.ts:247`).

### 2. Primary model + fallback

In `settings.json`, `model` and `fallback.model` default to empty strings `""` (`src/config.ts:86-90`), inheriting Claude Code's active model. The setup wizard offers `opus` (default), `sonnet`, `haiku`, and `glm`.

When configured, `fallback.model` triggers on rate-limit messages detected in output (`you've hit your limit`, `out of extra usage`; `src/runner.ts:400, 646-653`), executing via `runner.ts` (`src/runner.ts:2150-2189`) for legacy tasks (fallback routing does not apply to bus agents). `kimi-k2p6` routes directly to Kimi's Coding API at `https://api.kimi.com/coding/` (`src/runner.ts:703-705`), not OpenRouter.

### 3. Permission mode per agent

The most consequential setup choice. Each agent declares one:

- **`bypassPermissions`** — runs without prompting (the default for bus agents; recommended for headless deployments where you trust the agent's scope)
- **`plan`** — drafts a plan first, you approve before execution
- **`acceptEdits`** — auto-allows file edits, prompts for shell/network
- **`default`** — Claude Code's interactive default (prompts inline on every tool call)
- **`dontAsk`** — never prompts, denies anything that needs approval
- **`auto`** — Claude decides per-tool

Set per-agent in `settings.agents[].permission_mode`. If you leave `permission_mode` out, the bus resolver uses `bypassPermissions` (`src/bus/agent-resolver.ts:88`); the wizard's "headless" choice writes nothing (`commands/start.md`). `security.level` applies to the legacy `runner.ts` path and does not restrict bus agents (nothing in `src/bus` reads it).

### 4. Agents

Bus runtime needs at least one agent. A `settings.json` with no `agents` key (for example one carried over from the original claudeclaw) gets one `{ "id": "default" }`; an explicit `"agents": []` mounts the bus with no agent, and startup logs a warning. The minimal entry is just an `id`:

```json
"agents": [
  { "id": "default" }
]
```

Each agent has its own working directory and system prompt file (`memory_file` is parsed but not used by the bus yet). See `BusAgentSettings` in [`src/config.ts`](src/config.ts) for the full per-agent shape.

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
- **Cron jobs** — see `commands/` and the wizard's cron setup step. Note that cron jobs execute via `runner.ts` under both runtimes and follow `pty.enabled` (the PTY supervisor under the current default `pty.enabled: true` (`false` on Windows), or `claude -p` subprocesses when `pty.enabled: false` is set explicitly; `src/job-loop.ts:1-9, 66-73`, `src/runner.ts:803-805, 1997, 2715`).
- **`security.level`** — `locked`, `strict`, `moderate`, `unrestricted` (default `moderate`, `src/config.ts:204`). `locked` allows only the `Read`, `Grep`, `Glob` and `Write` tools (`Write` stays so memory can be saved; `src/runner.ts:1432-1441`); `strict` additionally denies `Bash`, `WebSearch` and `WebFetch` (`:1443-1447`); `moderate` and `unrestricted` pass the same tool arguments and differ only in that `moderate` adds a directory-scope instruction to the prompt (`:1936`, advisory, not enforced). It applies to the legacy `runner.ts` path; bus agents are governed by `permission_mode` per agent. Per-tool overrides via `allowedTools` / `disallowedTools` (`disallowedTools` is ignored under `locked`).

---

## Changing decisions later

Every setup choice is editable. There are three update paths:

### A. Edit `settings.json` directly

Located at `<project>/.claude/claudeclaw/settings.json` (per-project configuration). The daemon re-reads this file every 30 seconds (`src/commands/start.ts:1751-1858`, `src/config.ts:2174-2179`).

**Hot-reload-safe changes (applied within ~30s without restart):**
- `heartbeat.*` (`enabled`, `interval`, `prompt`, `excludeWindows`) and `timezone` / `timezoneOffsetMinutes`: the legacy scheduler is rebuilt, or the bus scheduler under the bus runtime (`src/commands/start.ts:1758-1766, 1780-1788, 1820-1842`)
- Scheduled job list, `enabled` and `agent` included (`src/commands/start.ts:1794-1809`)
- `security.level`, `allowedTools` and `disallowedTools`, for the legacy runner: read on every run (`src/runner.ts:1785, 1848`; the reload loop only logs a change, `src/commands/start.ts:1775-1785`)
- Also read on every legacy run: `model`, `api`, `fallback`, `agentic.enabled`, `watchdog` (`src/runner.ts:1784-1785`), `timeouts` (`:728-729`), `session.*` (`:1768-1769`), `sessionTimeoutMs` (`:1556, 1680`) and `jobsDir` (`src/config.ts:74-78`)
- `quietHours`: the Telegram outbox and the bus adapters take a getter over the current settings (`src/commands/start.ts:938, 1201, 1217`, `src/quiet-hours.ts:23-27`)
- MCP bridge tool policy and audit policy (`src/commands/start.ts:1748-1755`); `llmRouter.*` is re-read on every tool call (`src/plugins/llm-router/server.ts:90-98, 219-227`)
- `pty.enabled`, for `runner.ts` paths only: read on every call (`src/runner.ts:803-805`). The other `pty.*` settings apply per call or per new PTY: `maxRetries`, `respawnRetries`, `backoffMs` and `maxConcurrent` on each call (`src/runner/pty-supervisor.ts:1409-1414, 1589`), `cols`, `rows`, `turnIdleTimeoutMs`, `quietWindowMs` and `sentinelMaxWaitMs` for PTYs spawned afterwards (`:1756-1760`)
- Channel allow-lists (`allowedUserIds`, `allowAllUsers`) of the Telegram, Discord and Slack adapters, bus and legacy alike (`src/allowlist.ts:23-27`, `src/bus/adapter-wiring.ts:81-86`, `src/commands/start.ts:1203`)
- Options only the legacy adapters take (`telegram.listenChats`, `dmIsolation`, `whisperModel`; `discord.listenChannels`, `listenGuilds`, `channelNames`, `imageOutputRoots`, `streaming`; `slack.listenChannels`, `allowBots`, `allowBotIds`) are read from the current settings on each event (`src/commands/telegram.ts:1046`, `src/commands/discord.ts:558`, `src/commands/slack.ts:933`); the bus adapters do not receive them (`src/bus/adapter-wiring.ts:199-207, 255-267, 294-310`)
- `stt.*` (`src/whisper.ts:626`), `apiToken` (`src/ui/server.ts:362`, via the live snapshot at `src/commands/start.ts:1406-1412`), `shutdown.drainTurnsMs` (`src/commands/start.ts:749`), `memorySearch.reindexEveryNTurns` (`src/runner.ts:2687`) and, for the Discord adapter, `attachments.*` (`src/adapters/discord/index.ts:356`)
- **Authentication tokens, legacy runtime only** (`runtime: "pty"`, or the bus failed to mount): the reload loop calls `initTelegram`, `initDiscord` and `initSlack`, which start, restart or stop the adapter when its token changes; `slack.appToken` and `telegram.receiveEnabled` are handled the same way (`src/commands/start.ts:922, 993, 1032, 1813-1819`). Under a mounted bus runtime the same changes need a restart (below).

**Restart-required changes (require restarting the daemon):** everything below is read once, at startup or at mount, and the reload loop (`src/commands/start.ts:1744-1851`) never re-applies it.
- Adapter routing: `discord.busRouting`, `telegram.busRouting` (including `defaultAgentId`), `slack.busRouting` (including `busRouting.signingSecret`). Bus adapters are mounted once (`src/commands/start.ts:1843-1847`).
- Credentials and receive mode **under the bus runtime**: `discord.token`, `telegram.token`, `telegram.receiveEnabled`, `slack.botToken`, `slack.signingSecret` (the request-verification secret, also `slack.busRouting.signingSecret`) and `slack.appToken`. `mountSlack()` and `mountTelegram()` pass them to the adapter constructor once (`src/bus/adapter-wiring.ts:240, 264, 287-308`; the Slack secret is stored at `src/adapters/slack/index.ts:207`). `slack.appToken` is the odd one out: the bus Slack adapter accepts it but has no Socket Mode driver yet, so it currently has no effect there (`src/adapters/slack/types.ts:108-126`); the legacy Slack runtime uses it and reloads it live.
- Agent declarations (`agents[]`) and agent `permission_mode`: resolved once at mount (`src/commands/start.ts:626`)
- Runtime mode (`runtime`) — switching between `"bus"` and `"pty"` (`src/commands/start.ts:601-619`, `src/config.ts:740-741`)
- Web dashboard: `web.enabled`, `web.host`, `web.port` — the dashboard is created once from the startup value (`src/commands/start.ts:548, 1395, 1531`); the reload loop never starts or stops it
- Bus web adapter: `web.bus.bind`, `web.bus.token` (or `CCAW_WEBUI_TOKEN`), `web.bus.allowedAgentIds`, `web.bus.allowedOrigins` (`src/bus/adapter-wiring.ts:324-347`)
- MCP multiplexer and shared servers: `mcp.shared`, `mcp.perPtyOnly`, `mcp.stateless`, `mcp.healthProbeIntervalMs`, `mcp.sessionPersistenceEnabled`, `mcp.sessionMaxAgeSeconds`, `mcp.sessionPersistencePath`, `mcp.rateLimit`, `mcp.metricsEnabled` and `mcp.cache`. The multiplexer reads them once in `start()` (`src/plugins/mcp-multiplexer/index.ts:121-165, 289, 426`) and claims its servers then (`src/commands/start.ts:1099-1158`). `mcp.perPtyOnly` counts too: a server listed in both `shared` and `perPtyOnly` is removed from `shared` when the settings are parsed (`src/config.ts:1790-1799`), so editing `perPtyOnly` changes the shared set the running multiplexer and the bus session manager fixed at startup.
- Bus runtime services: `agentJobs.*` and `stallWatchdog.*` (`src/bus/runtime-mount.ts:447, 595`), and `kanban.enabled` (`src/commands/start.ts:1248`)
- `plugins` (`src/commands/start.ts:578-579`); `governance.watchdog.*` (`src/commands/start.ts:467-496`); `governance.evalFramework.*`, read when the eval-framework server process starts (`src/plugins/eval-framework/server.ts:80-90`)
- `agentic.modes` and `agentic.defaultMode`: the governance router is configured once, on the first run with `agentic.enabled` (`src/runner.ts:106-119, 1804-1805`)
- `pty.idleReapMinutes` and `pty.namedAgentsAlwaysAlive`: the idle reaper keeps the options captured when the supervisor first initialises (`src/runner/pty-supervisor.ts:670-677, 684-689`)

Restarting while an agent is mid-turn: `GET /api/health` reports `busy: true` while any turn is active, so a deploy script can wait for it to clear. If you restart anyway, the daemon drains on `SIGTERM`/`SIGINT` — it waits up to `shutdown.drainTurnsMs` (default `30000`, `0` to stop at once) until the bus owes the model nothing (no turn in flight, no prompt still queued, held through a compaction or being verified), gives the last reply a second to leave the adapter (an idle daemon therefore takes about a second to exit, so a prompt accepted right after the signal is still seen), and logs which turns finished, which agents lost their connection before `turn_end`, and what was still busy when it gave up. A second signal stops the wait. After the drain the daemon asks each live `global` and `agent:<name>` PTY session to save its memory (`MEMORY.md`), in the session it already has, with its own 30 s budget on top of the drain (`SHUTDOWN_MEMORY_SAVE_MS`, `src/pid.ts:390`), so `claudeclaw stop` waits up to `shutdown.drainTurnsMs` + 35 s; a second signal skips the rest. `claudeclaw stop` therefore no longer runs its own `claude -p` while a daemon is running (it keeps a one-shot save only for a stale PID file). Two conditions for the drain to protect anything: keep the value under your service manager's stop timeout (systemd `TimeoutStopSec` defaults to 90 s), and make sure the signal reaches only the daemon — with systemd's default `KillMode=control-group` the `claude` children die at the same instant and there is nothing left to drain; use `KillMode=mixed` (see `docs/deploy-systemd-hardening.md`). New prompts are still accepted during the drain, so under steady traffic it runs to the window.

### B. Slash commands

- **`/mode <mode>`** — toggles permission mode on the **legacy Telegram adapter only** (`src/commands/telegram.ts:1470-1513`).
- **Bus runtime:** the bus adapters do not implement ClaudeClaw slash commands (`/mode`, `/heartbeat`, `/agents`, `/help` do not exist there). `BusCore.invokeSlashCommand` is only a hook for a handler (`src/bus/core.ts:2469-2476`), and the adapters list slash-command relay as not yet ported (`src/adapters/discord/index.ts:645-647`, `src/adapters/slack/index.ts:960`).

### C. Web UI

Browse to `http://<web.host>:<web.port>` (default `http://127.0.0.1:4632`). Enabled with the `--web` CLI flag or `web.enabled: true` in `settings.json`. Authentication requires the token stored in `<project>/.claude/claudeclaw/web.token` (`src/ui/auth.ts:10-12`). Manage jobs, monitor runs, inspect logs, and toggle the heartbeat from the dashboard.

For headless programmatic access to the event bus, the bus web adapter binds separately to `web.bus.bind` (default `127.0.0.1:7878`), exposing `GET /health`, `POST /prompt`, and `/ws` (`src/adapters/webui/index.ts:215-229`).

---

## Adapters

Adapter coverage as of v2.0:

- **Discord** — full production support. Multi-channel routing, threads, DMs, permission flow, inline progress UX, primary-channel-per-agent for cron/heartbeat. Tested daily on a live Hetzner deployment.
- **Telegram** — full production support. Per-chat routing, bracketed-paste prompt delivery, bounded spinner edits with per-chat 429 cooldown, voice/image input via Whisper.
- **Slack** — ⚠️ **less tested than Discord and Telegram.** The code paths are implemented (channels, threads, signing-secret verification, permission flow, primary-channel-per-agent), but the v2.0 soak ran without a daily Slack deployment. **Please file [issues](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) or PRs as you encounter them — we'll review and ship fixes promptly.**
- **Web UI** — production-tested. The web dashboard provides CSRF protection and mobile responsiveness at `http://<web.host>:<web.port>` (default `127.0.0.1:4632`), while the bus web adapter serves HTTP and WebSocket endpoints at `web.bus.bind` (default `127.0.0.1:7878`). Note that `web.bind` is not a valid setting: `WebConfig` has only `enabled`, `host`, `port` and `bus` (`src/config.ts:205, 919-925`).

---

## What's in Plus that isn't in claudeclaw

These features originated as PRs to `moazbuilds/claudeclaw` and have been closed upstream — they're out of scope for the lightweight core and live here permanently. Links below point to the originating PRs so you can read the full rationale.

### Execution Modes and Engine Policy

**Tracking issues: [#61](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/61), [#546](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/546), [#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550), [#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)**

ClaudeClaw+ supports two distinct runtimes (`runtime: "bus"` and `runtime: "pty"`) and two execution engines: interactive PTY supervision and non-interactive `claude -p` subprocess execution.

**Engine Policy ([#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)):**
- **Interactive PTY** is the official execution engine of ClaudeClaw+.
- **`claude -p`** remains a permanently supported option for programmatic execution, scriptable environments, or headless subprocess tasks (`pty.enabled: false`, `supervision: "process-stream-json"`).
- **Still on print:** the utility one-shots run through `claude -p` by default, because the one-shot module defaults to its `print` engine and the PTY engine does not yet advertise isolation for untrusted text (`src/oneshot/registry.ts`, `docs/oneshot-engines.md`). That covers the Discord classifier, the tuner, memory recall (the Python recall script still spawns `claude -p` itself), and the not-live fallback for `/compact`, the rotation summary and memory saves (when the agent has a live PTY session those run in it). Windows also defaults to print (`pty.enabled` is `false` there, see below). Tracked in [#570](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/570) (interactive isolation spike so untrusted routes can leave `claude -p`), [#571](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/571) (memory recall through the one-shot module), [#572](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/572) (trusted session routes default to PTY) and [#573](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/573) (validate PTY on Windows and drop the win32 print default).
- **Bus Supervision vs. `pty.enabled`:** Bus agent turns do not consult `pty.enabled` (nothing in `src/bus` reads it). Under `runtime: "bus"`, declared agents get `entry.supervision ?? "pty-stdin"` (`src/bus/agent-resolver.ts:49-56`). An `AgentConfig` with no `supervision` falls back to `defaultSupervisionFor(origin)` at spawn (`src/bus/session-manager.ts:1192`): `pty-stdin` for every origin since [#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550). The one exception is Windows (`process.platform === "win32"`), where the non-channel origins (`cron`, `heartbeat`, `cli`, `rest`) keep `process-stream-json`, because nothing in the codebase shows the PTY path working there; the channel-driven origins `discord`, `telegram`, `slack` and `webui` stay on `pty-stdin` (`src/bus/types.ts:38-43, 54-75`). The valid `supervision` values in `settings.json` are `pty-stdin`, `tmux`, `process` and `process-stream-json` (`src/config.ts:750, 1388-1394`; semantics in `src/bus/types.ts:48-52`).
- **Scope of `pty.enabled`:** `pty.enabled` governs `runner.ts` paths only, through one decision, `resolveAgentTurnRoute()` (`src/runner.ts:803-805`; call sites `:1026` agent jobs, `:1997` primary turn and rate-limit fallback, `:2752` dashboard chat stream, `:3119` fork). Under every runtime that includes cron jobs, which always run through `run()` (`src/job-loop.ts:1-9, 66-73`, `src/runner.ts:2715`). Agent jobs (`runAgentJobHeadless`) exist only under the bus runtime (`src/bus/runtime-mount.ts:43, 468-474`). Forks are a legacy-Telegram feature (`src/commands/telegram.ts:1507`), so only with `runtime: "pty"` (or after a failed bus mount). Under `runtime: "bus"`, dashboard chat goes through `streamBusPrompt()` to the default bus agent and does not consult `pty.enabled` (`src/commands/start.ts:1473-1496`); if no bus agent was spawned it falls back to the runner stream (`:1497`).
- **Current Defaults:** `pty.enabled` defaults to `true` ([#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550)): `runner.ts` paths run on the PTY supervisor, and an explicit `pty.enabled: false` selects `claude -p`. The exception is Windows (`win32`), where `pty.enabled` defaults to `false` and runner turns stay on `claude -p` until you set `pty.enabled: true`, for the same reason as the bus exception above (`defaultPtyEnabled`, `src/config.ts`). A settings file that does not mention `pty.enabled` gets the PTY engine, except on Windows; see [`docs/pty-migration.md`](docs/pty-migration.md) for what changes and how to opt out.
- **Runtime Isolation:** Switching between `runtime: "bus"` and `runtime: "pty"` requires a full daemon restart (`src/commands/start.ts:601-619`). The two runtimes share neither IPC nor runtime state (`src/config.ts:740-741`).

#### Execution Modes Matrix

| Runtime | `pty.enabled` | Bus Agent Turns (Supervision) | `runner.ts` Paths (Cron Jobs, Rate-limit Fallback; Agent Jobs under bus; Dashboard Chat and Telegram Forks under legacy `pty` runtime) | Details & Architecture |
|---|---|---|---|---|
| `runtime: "bus"` (default) | `true` (current default; `false` on Windows) | `pty-stdin` (or declared `supervision`) | Interactive PTY supervisor | Bus agents run with `pty-stdin` (or per-agent `supervision`); `pty.enabled` does not change them. Dashboard chat goes through `streamBusPrompt()` to the default bus agent (`src/commands/start.ts:1473-1496`). Cron jobs (`src/job-loop.ts:1-9`), agent jobs (`src/runner.ts:1026`) and the rate-limit fallback (`:1997`) go through `runner.ts` and run on the PTY supervisor (`src/runner.ts:803-805`). |
| `runtime: "bus"` | `false` (explicit opt-out) | `pty-stdin` (or declared `supervision`) | `claude -p` | Same bus behaviour. Cron jobs, agent jobs and the rate-limit fallback run as `claude -p` (`src/runner.ts:803-805, 1026, 1997`). |
| `runtime: "pty"` | `true` (current default; `false` on Windows) | N/A (bus runtime not mounted) | Interactive PTY supervisor | The legacy runner runs each inbound event, cron job, rate-limit fallback, dashboard chat (`src/commands/start.ts:1497`, `src/runner.ts:2752`) and Telegram fork (`:3119`) on the interactive PTY supervisor (`src/runner.ts:803-805, 1997`). |
| `runtime: "pty"` | `false` (explicit opt-out) | N/A (bus runtime not mounted) | `claude -p` | The same legacy-runner paths spawn a fresh `claude -p` per call (`src/runner.ts:803-805, 1997, 2752, 3119`). |

#### When to pick `claude -p` vs. PTY / Bus

**When to pick `claude -p` execution:**
- **Audit / compliance**: Every invocation is its own subprocess with a clean stdin/stdout boundary — easier to log, intercept, and reason about than a long-lived interactive session.
- **Predictable cost ceilings**: Clean subprocess boundaries allow precise metering per command.
- **Stateless environments**: No long-lived process management or terminal state to maintain.

**When to pick interactive PTY / Bus:**
- **Full tool interactivity**: Long-lived interactive sessions with real-time streaming, interactive approvals, and persistent state.
- **Lower latency**: Avoids per-turn subprocess cold start.
- **Multi-channel routing**: The event bus routes between Discord, Telegram, Slack, and the Web UI with origin-aware replies.
- **Per-agent supervision**: Distinct working directories and system prompts per declared agent.

#### Settings block (defaults shown)

```json
"pty": {
  "enabled": true,
  "idleReapMinutes": 30,
  "maxConcurrent": 32,
  "maxRetries": 5,
  "backoffMs": [1000, 2000, 4000, 8000, 16000],
  "namedAgentsAlwaysAlive": true
}
```

> **Note on hot-reload:** Switching `runtime` between `"bus"` and `"pty"` requires restarting the daemon (`src/commands/start.ts:601-619`). In contrast, `pty.enabled` is read on every call, so a change in `settings.json` applies to the next `runner.ts` invocation after the ~30s reload (`src/runner.ts:803-805`, `src/runner/pty-supervisor.ts:50-52`).

#### References

- Bus architecture spec: [`docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`](docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md)
- Tracking issues: [#61](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/61), [#546](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/546), [#550](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/550), [#553](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/553)

---

### MCP multiplexer — shared MCP-server processes across PTYs

**Tracking issue: [#72](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/72) · Lands across [#71](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/71), [#78](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/78), and a series of v1.1 hardening PRs (#91–#97)**

The multiplexer hosts each shared MCP server child **once** and demultiplexes per-PTY traffic over a loopback HTTP route (`/mcp/<server>`). Each PTY claude gets a synthesized `--mcp-config` JSON pointing at that route with a per-PTY bearer + identity headers. Without this, every PTY would spawn its own copy of every MCP server — N × M subprocesses for N PTYs × M servers — which OOMs even a modest Hetzner box at moderate concurrency.

> **Requirement:** The MCP multiplexer starts only when `mcp.shared` is non-empty **and** `web.enabled: true` is persisted in `settings.json` (`src/commands/start.ts:1092`); with `mcp.shared` set and the dashboard off, startup logs a warning and bus agents spawn without `--mcp-config` (`:1152-1162`). Its `/mcp/<server>` routes are served by the dashboard HTTP server's plugin gateway (`src/ui/server.ts:257-267`). Passing the `--web` CLI flag alone is not enough: the check reads `settings.web.enabled` (`src/commands/start.ts:1092`), and the flag only sets `currentSettings.web.enabled` later (`src/commands/start.ts:1531-1532`).

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

> **Note:** Where the policy engine is consulted today: (1) the bus permission gate — when an agent forwards a tool-permission request, an explicit matching **deny** rule (global, per-user or skill overlay) auto-denies it before the operator card appears; no match, or an evaluation error, falls through to the card (`src/bus/core.ts:3544-3568, 4009-4021`). The gate only sees requests Claude Code forwards for approval, and under `bypassPermissions` Claude Code does not ask. (2) Gateway-routed inbound events (`src/gateway/index.ts:233-244`, opt-in, see below). (3) Orchestrator task execution (`src/orchestrator/executor.ts:133-139`). The legacy `runner.ts` carries an `evaluateToolForExecution` helper but nothing calls it (`src/runner.ts:1569`), and a `claude -p` run cannot be intercepted per tool call.

Tool requests that reach the engine are evaluated against deterministic rules. Rules can allow, deny, or gate behind operator approval — scoped by channel, user, skill, and source. Includes an audit log and a bounded LRU approval cache.

**Why:** Gives operators rules in place of blanket `--dangerously-skip-permissions`, on the paths listed above. Operators can deny destructive tools in public channels, require approval for high-risk operations, and keep a tamper-evident audit trail for compliance.

---

### Governance Layer — model routing, budgets, watchdog

**[PR #72 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/72)**

> **Note:** Model routing, usage tracking, budgets and the watchdog are wired into the legacy `runner.ts` path (`src/runner.ts:37-62`); nothing under `src/bus` or `src/adapters` references the governance modules, so they do not govern bus agents. The daemon still configures the watchdog from `settings.governance.watchdog` at startup under either runtime (`src/commands/start.ts:467-496`).

Sits between the daemon and Claude CLI. Automatically routes planning tasks to Opus and implementation tasks to Sonnet. Tracks token and cost spend per session and globally, with configurable warn/throttle/block states. Watchdog kills runaway sessions before they drain your credits.

**Why:** Stops cost overruns before they happen. Makes ClaudeClaw safe to leave unattended — the thing that needs a babysitter becomes the babysitter.

---

### Gateway, Events & Escalation — unified ingestion and replayable event log

**[PR #73 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/73)**

> **Note:** The gateway, event log and escalation framework sit on the legacy adapter pipeline and are opt-in per adapter with `USE_GATEWAY_TELEGRAM=true` / `USE_GATEWAY_DISCORD=true` (`src/commands/telegram.ts:31, 1741-1742`, `src/commands/discord.ts:1333`); nothing under `src/bus` or `src/adapters` imports the gateway or the escalation framework — the event-bus runtime uses `BusCore` topics and subscriptions instead, and only borrows the event log's `append` to write its own `bus:*` audit records (`src/bus/core.ts:31`).

Unified message ingestion pipeline normalises Discord/Telegram messages to a common format. Crash-safe append-only event log, retry queue with exponential backoff, dead-letter queue, full event replay, and an escalation framework (pause session, hand off to a human, notify across channels).

**Why:** Eliminates duplicated per-adapter logic and gives you an audit trail you can replay. When something goes wrong at 3am, you can see exactly what happened and re-run it.

---

### Orchestrator — DAG task graph and resumable jobs

**[PR #74 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/74)**

> **Note:** `src/orchestrator/` is a workflow engine that runs registered action handlers (`src/orchestrator/executor.ts:83-95, 155-193`). No production code path submits a workflow to it today: `scheduleJob`, `executeJobNow`, `processCronTrigger` and `registerJobHandlers` have no callers outside tests, and cron jobs run through `src/job-loop.ts`. Its one live wiring is at daemon startup, under either runtime: `initializeJobSystem()` resumes any workflow already persisted as pending (`src/commands/start.ts:540-541`, `src/orchestrator/resumable-jobs.ts:174-215, 246-286`, `src/orchestrator/executor.ts:378-411`). A task that was running when the daemon died is re-queued if it has retries left, otherwise failed with "Task interrupted by restart" (`src/orchestrator/workflow-state.ts:282-314`).

Multi-step task execution via dependency graph with topological sort. Durable workflow state with atomic writes during active execution. Governance-integrated executor with configurable parallelism.

**Why:** Complex requests decompose into dependent subtasks that run in parallel where possible and resume execution across daemon restarts.

---

### CSRF Protection for Web UI

**[PR #75 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/75)**

Cryptographically random single-use UUID tokens per session, timing-safe comparison, conditional `Secure` cookie flag, and a client-side `mutatingFetch()` wrapper that auto-retries on 403.

**Why:** Prevents malicious cross-origin pages from triggering heartbeat toggles, job runs, or chat actions in an operator's logged-in browser — hardening on top of whatever reverse-proxy auth you're running.

---

### Persistent Memory — cross-session `MEMORY.md`

**[PR #77 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/77)**

> **Note:** Memory persistence is part of the legacy `runner.ts` path: the write instruction and the `MEMORY.md` content are added to every prompt (`src/runner.ts:1927-1934`; the mtime snapshot is at `:1983-1991`), and the daemon-side fallback appends a log entry when the file is unchanged (`:2507-2539`). Bus agents do not get this: `agents[].memory_file` is parsed (`src/config.ts:1477-1479`) and copied into the agent config (`src/bus/agent-resolver.ts:92`) but nothing reads it.

`MEMORY.md` loaded into `--append-system-prompt` on every invocation. Dual-layer write guarantee: Claude is instructed to write after each task, and a daemon-side fallback appends a log entry if `MEMORY.md` is unchanged after a run. A pre-compact save runs when a print (`claude -p`) turn times out with exit 124 and triggers auto-compact (`src/runner.ts:2561-2603`); a PTY turn timeout is also exit 124, but the supervisor retires the PTY and the runner neither saves memory, compacts nor re-runs, a pre-shutdown save runs from `claudeclaw stop` for the global session only (`src/commands/stop.ts:44-45, 57, 108-114`), the fallback trims to 200 lines (`src/runner.ts:2531`), and agents have their own memory paths (`src/memory.ts:40-45`).

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
