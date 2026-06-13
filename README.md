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
  <a href="https://github.com/moazbuilds/claudeclaw">
    <img src="https://img.shields.io/badge/synced%20from-moazbuilds%2Fclaudeclaw-2da44e?style=flat-square" alt="Synced from moazbuilds/claudeclaw" />
  </a>
</p>

<p align="center"><b>ClaudeClaw, plus the heavy stuff. Governance, orchestration, persistent memory, hardened web UI.</b></p>

ClaudeClaw+ is a sister project to [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) — the lightweight Claude Code daemon you already know. Plus exists to house the features that are too heavy or too opinionated for the core repo: a full governance and policy layer, durable multi-step orchestration, persistent cross-session memory, and a hardened web UI.

Everything from upstream lives here too. ClaudeClaw+ syncs from upstream automatically every day, so you never fall behind.

> Note: Please don't use ClaudeClaw+ for hacking any bank system or doing anything illegal. Same rules apply.

---

## Standing on the shoulders of giants

ClaudeClaw+ is built on top of the original [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw), created by [@moazbuilds](https://github.com/moazbuilds). The core daemon, Telegram/Discord adapters, heartbeat, web dashboard, skills system — all of that comes from upstream and the amazing contributors who built it.

**Upstream contributors — thank you:**

<a href="https://github.com/moazbuilds/claudeclaw/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=moazbuilds/claudeclaw" />
</a>

### How the sync works

A GitHub Actions workflow (`.github/workflows/sync-upstream.yml`) runs at 07:00 UTC every day. It pulls `moazbuilds/claudeclaw master` and opens a PR if there are new commits. Every fix and feature that lands upstream is here within a day.

If you see a PR titled **"chore: sync upstream"** — that's the robot doing its job. Review it, resolve any conflicts if needed, and merge.

---

## Why ClaudeClaw+?

| Category | ClaudeClaw | ClaudeClaw+ | OpenClaw |
| --- | --- | --- | --- |
| Anthropic Will Come After You | No | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Same | Nightmare |
| Setup & Installation | ~5 minutes | ~5 minutes | Nightmare |
| Isolation | Folder-based and isolated as needed | Folder-based + per-agent scope | Nightmare |
| Reliability | Simple reliable system | Simple + durable workflows that survive restarts | Nightmare |
| Feature Scope | Lightweight features you actually use | Everything in ClaudeClaw, plus governance and orchestration | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Policy engine, audit log, CSRF protection | Nightmare |
| Cost Control | Manual | Automatic token budgets + model routing per task type | Nightmare |
| Memory | Claude internal memory + `CLAUDE.md` | Persistent cross-session `MEMORY.md` with dual-layer write guarantee | Nightmare |
| Multi-step Jobs | Cron + heartbeat | DAG orchestrator with dependency resolution and resumable state | Nightmare |

---

## What's new in v2.0 — Bus runtime is the default

As of v2.0 (May 2026), ClaudeClaw+ runs on a new **event-bus architecture** by default. The `claude -p` subprocess path (`runtime: "pty"`) remains a **permanent first-class option** — especially for enterprise deployments where API billing is the safer or only viable route (audit trails, cost ceilings, regulatory constraints). Operators pick per deployment: bus for subscription-billed interactive work, `claude -p` for API-billed programmatic work. Both are fully supported, side by side.

Here's what changes when you pick the bus runtime:

- **One long-lived `claude` process per declared agent**, not a fresh subprocess per event. Subscription billing covers daemon work; the Agent SDK credit pool stays untouched.
- **Typed event bus (`BusCore`)** sits between adapters (Discord, Telegram, Slack, web UI, cron, REST, CLI) and agents. Inbound events publish to topics; agents subscribe; replies flow back as `response.text`, `channel.permission_request`, or `system.request_human`.
- **Origin-aware routing** — a Discord reply goes back to the Discord channel that triggered it, not fanned out across every channel the agent is wired to.
- **Per-agent process isolation** — agents have separate working directories, permission modes, system prompts, and memory files.
- **Human-in-the-loop permission gate** — privileged tool calls (Bash, Edit, etc.) prompt the operator inline. Approve or deny from any connected channel.
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
/claudeclaw:start
```

The setup wizard covers the choices listed below. Your daemon is live in under five minutes.

---

## Setup choices at first run

The wizard (and `settings.json`) asks you to decide six things. None of them are permanent — every one is editable in `settings.json` and picked up on hot-reload (within ~30s, no restart).

### 1. Which adapters to enable

Pick the surfaces you want the daemon to listen on. Multiple adapters can run at once.

| Adapter | Status | Where to enable |
|---|---|---|
| **Discord** | Production-tested | `discord.token`, `discord.busRouting.channels` |
| **Telegram** | Production-tested | `telegram.token`, `telegram.busRouting.chats` |
| **Slack** | ⚠️ Less tested than Discord/Telegram — see [Adapters](#adapters) | `slack.botToken`, `slack.busRouting.channels` |
| **Web UI** | Production-tested | `web.enabled: true`, `web.bus.bind` |

### 2. Primary model + fallback

`model` is the headline choice (default `"sonnet"`). `fallback.model` is the rescue (default `"kimi-k2p6"` via OpenRouter). Routing kicks in automatically when the primary 401s or rate-limits.

### 3. Permission mode per agent

The most consequential setup choice. Each agent declares one:

- **`bypassPermissions`** — runs without prompting (the recommended default for headless deployments where you trust the agent's scope)
- **`plan`** — drafts a plan first, you approve before execution
- **`acceptEdits`** — auto-allows file edits, prompts for shell/network
- **`default`** — Claude Code's interactive default (prompts inline on every tool call)
- **`dontAsk`** — never prompts, denies anything that needs approval
- **`auto`** — Claude decides per-tool

Set per-agent in `settings.agents[].permission_mode`. The wizard picks `bypassPermissions` if you don't choose explicitly.

### 4. Agents

At least one agent is **required** under bus runtime — without it the daemon mounts the bus but spawns no processes. The minimal entry is just an `id`:

```json
"agents": [
  { "id": "default" }
]
```

Each agent has its own working directory, system prompt file, and memory file. See `BusAgentSettings` in [`src/config.ts`](src/config.ts) for the full per-agent shape.

> ⚠ **Important if you have an `agents/` directory on disk.** Every directory under `agents/<name>/` with jobs in it MUST have a matching entry in `settings.agents[]`. If not, the bus runtime publishes prompts targeting `agent_id: <name>` but no process is subscribed, and your jobs silently fail. The daemon now logs `[bus-runtime] WARN: agent dir "<name>" has N scheduled job(s) ... but is not declared in settings.agents` at startup when a mismatch is detected — fix the warning either by adding `{ "id": "<name>" }` to `settings.agents` or by removing the orphan `agents/<name>/jobs/` directory.

## Upgrading

### v1.0.26 — Allowlist behavior change (Telegram & Discord)

Prior to this release, an empty `allowedUserIds` list meant **allow everyone**. That was a potential security vulnerability; any Telegram or Discord user could drive the daemon.

**New behavior:** an empty list means **block everyone**. The daemon will refuse to start if a bot token is configured without at least one allowed user ID.

**Migration:** add your user ID(s) to `settings.json` before upgrading:

```json
"telegram": { "allowedUserIds": [123456789] },
"discord":  { "allowedUserIds": ["987654321012345678"] }
```

Run `claudeclaw config` for guided setup if you're unsure of your user ID.

### v1.1.0 — Web UI bearer token gate

All `/api/*` routes (except `/api/health`) now require an `Authorization: Bearer <token>` header. The token is auto-generated on first start and written to `.claude/claudeclaw/web.token`. The daemon also prints the full URL with the token embedded when the web UI starts.

**Migration:** update any scripts that call `/api/state` or other API routes to pass the token:

```
Authorization: Bearer <contents of .claude/claudeclaw/web.token>
```

Existing `/api/inject` users who configured `settings.apiToken` are unaffected; that fallback still works.

### v1.1.0 — Discord text-attachment truncation limit reduced

Text attachments sent to the Discord bot are now truncated at **2,048 bytes** (previously 51,200). Payloads over that limit have `…[truncated]` appended silently; there is no config knob to restore the old limit.

**Migration:** if you rely on passing large text files through Discord attachments, switch to gists or another file-sharing mechanism and paste the URL instead.

---

## What Would Be Built Next?

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
- **Cron jobs** — see `commands/` and the wizard's cron setup step.
- **`security.level`** — `unrestricted` / `moderate` / `strict` / `read-only`. Default `moderate`. Per-tool overrides via `allowedTools` / `disallowedTools`.

---

## Changing decisions later

Every setup choice is editable. There are three update paths:

### A. Edit `settings.json` directly

Located at `~/.claude/claudeclaw/settings.json` (per-user). The daemon watches this file and reloads within ~30 seconds — no restart needed for most fields.

Hot-reload-safe changes:
- Adapter routing (`discord.busRouting`, `telegram.busRouting`, `slack.busRouting`, `web.bus`)
- Agent declarations (`agents[]`)
- Primary channel per agent
- Heartbeat interval and exclude windows
- Security level
- MCP shared/perPtyOnly/stateless lists
- Permission mode

Restart-required changes (rare):
- Telegram/Discord token rotation
- Web UI bind address change

### B. Slash commands in any connected channel

- **`/mode <mode>`** — flip the daemon's per-agent permission mode without editing settings
- **`/heartbeat on|off`** — toggle the heartbeat
- **`/agents`** — list active agents
- **`/help`** — full command list

Slash commands work from Discord, Telegram, Slack, and the web UI.

### C. Web UI

Browse to `http://<bind>:4632` (default). Manage jobs, monitor runs, inspect logs, toggle the heartbeat from the dashboard.

---

## Adapters

Adapter coverage as of v2.0:

- **Discord** — full production support. Multi-channel routing, threads, DMs, permission flow, inline progress UX, primary-channel-per-agent for cron/heartbeat. Tested daily on a live Hetzner deployment.
- **Telegram** — full production support. Per-chat routing, bracketed-paste prompt delivery, bounded spinner edits with per-chat 429 cooldown, voice/image input via Whisper.
- **Slack** — ⚠️ **less tested than Discord and Telegram.** The code paths are implemented (channels, threads, signing-secret verification, permission flow, primary-channel-per-agent), but the v2.0 soak ran without a daily Slack deployment. **Please file [issues](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) or PRs as you encounter them — we'll review and ship fixes promptly.**
- **Web UI** — production-tested. CSRF-protected, mobile-responsive, runs at the configured `web.bind`.

---

## What's in Plus that isn't in claudeclaw

These features originated as PRs to `moazbuilds/claudeclaw` and have been closed upstream — they're out of scope for the lightweight core and live here permanently. Links below point to the originating PRs so you can read the full rationale.

### `claude -p` runtime — permanent first-class option for API-billed deployments

**Tracking issue: [#61](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/61) · Merged PR: [#62](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/62)**

`runtime: "pty"` selects the `claude -p` subprocess path — one `claude -p` invocation per event. From 2026-06-15 onwards this routes through Anthropic's Agent SDK credit pool (API billing), separate from the Pro/Max subscription pool used by interactive sessions.

This path is **not** going away. For many production deployments — particularly enterprise installs with audit, cost-ceiling, or regulatory constraints — API billing is the safer or only viable route. We keep `claude -p` as a permanent, fully supported first-class option:

```json
"runtime": "pty"
```

**When to pick `claude -p` over bus:**

- **Audit / compliance**: every invocation is its own subprocess with a clean stdin/stdout boundary — easier to log, intercept, and reason about than a long-lived interactive session.
- **Predictable cost ceilings**: API billing is metered per-token; subscription billing is harder to attribute per-request.
- **Regulatory / data-residency**: some setups require the API path specifically because of vendor contract scope.
- **No long-lived processes**: each event is a clean subprocess; no per-agent state to manage, no PTY supervision, no MCP multiplexer.

**When to pick bus over `claude -p`:**

- **Subscription billing**: daemon work bills against your existing Pro/Max subscription, not the Agent SDK pool.
- **Lower latency**: long-lived `claude` sessions skip the per-event cold start.
- **Multi-channel routing**: same agent reachable from Discord/Telegram/Slack/web UI with origin-aware replies.
- **Permission gate inline**: tool calls prompt for approval in whichever channel you're on.

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

Hot-reload picks up `settings.json` changes within 30 seconds — no daemon restart needed to flip between runtimes.

#### References

- Architecture: [`.planning/pty-migration/SPEC.md`](.planning/pty-migration/SPEC.md)
- Phase D audit reports: [`.planning/pty-migration/`](.planning/pty-migration/)
- Bus runtime spec (the recommended path): [`docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`](docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md)

---

### MCP multiplexer — shared MCP-server processes across PTYs

**Tracking issue: [#72](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/72) · Lands across [#71](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/71), [#78](https://github.com/TerrysPOV/ClaudeClaw-Plus/pull/78), and a series of v1.1 hardening PRs (#91–#97)**

The multiplexer hosts each shared MCP server child **once** and demultiplexes per-PTY traffic over a loopback HTTP route (`/mcp/<server>`). Each PTY claude gets a synthesized `--mcp-config` JSON pointing at that route with a per-PTY bearer + identity headers. Without this, every PTY would spawn its own copy of every MCP server — N × M subprocesses for N PTYs × M servers — which OOMs even a modest Hetzner box at moderate concurrency.

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
- `stateless` — subset of `shared` for servers with no per-session state; one upstream session shared across all PTYs.
- `rateLimit` — per-bearer (= per-PTY) sliding-window cap on `/mcp/<server>` requests. Defense-in-depth for a leaked bearer.

#### Surface coverage: tools only (no resources / prompts / completions)

The multiplexer currently proxies **`ListTools` + `CallTool` only**. MCP servers can also expose `resources/*`, `prompts/*`, and `completions/*` per the MCP spec — those surfaces are **not** forwarded through the multiplexer. If a shared server defines them, PTY claudes won't see them through the multiplexed `/mcp/<server>` route.

**Practical impact:** none for the MCP servers we ship with by default (graphiti, codegraph, sentrux, etc. — all tool-only). Servers that depend on resource attachments (file-pinning workflows) or prompt templates won't surface that surface through a multiplexed mount.

**Workarounds if you need resources / prompts from a specific server:**

1. **Drop it from `settings.mcp.shared`** — claude will then spawn it per-PTY via the normal stdio path (the explosion concern applies; only worth it for the server that needs the extra surfaces).
2. **Wait for the feature extension** — tracked as #72 item 12. Would require new `ListResourcesRequestSchema` / `ReadResourceRequestSchema` / `ListPromptsRequestSchema` / `GetPromptRequestSchema` handlers wired through the SDK transport. No design blockers, just unbuilt.

#### References

- Architecture: [`.planning/mcp-multiplexer/SPEC.md`](.planning/mcp-multiplexer/SPEC.md)
- v1.1 follow-ups: [#72](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/72)

---

### Policy Engine — fine-grained tool governance

**[PR #71 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/71)**

Every tool call (Bash, Read, Edit, etc.) is evaluated against deterministic rules before execution. Rules can allow, deny, or gate behind operator approval — scoped by channel, user, skill, and source. Includes an audit log and a bounded LRU approval cache.

**Why:** Replaces blanket `--dangerously-skip-permissions` with actual governance. Operators can deny destructive tools in public channels, require approval for high-risk operations, and keep a tamper-evident audit trail for compliance.

---

### Governance Layer — model routing, budgets, watchdog

**[PR #72 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/72)**

Sits between the daemon and Claude CLI. Automatically routes planning tasks to Opus and implementation tasks to Sonnet. Tracks token and cost spend per session and globally, with configurable warn/throttle/block states. Watchdog kills runaway sessions before they drain your credits.

**Why:** Stops cost overruns before they happen. Makes ClaudeClaw safe to leave unattended — the thing that needs a babysitter becomes the babysitter.

---

### Gateway, Events & Escalation — unified ingestion and replayable event log

**[PR #73 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/73)**

Unified message ingestion pipeline normalises Discord/Telegram messages to a common format. Crash-safe append-only event log, retry queue with exponential backoff, dead-letter queue, full event replay, and an escalation framework (pause session, hand off to a human, notify across channels).

**Why:** Eliminates duplicated per-adapter logic and gives you an audit trail you can replay. When something goes wrong at 3am, you can see exactly what happened and re-run it.

---

### Orchestrator — DAG task graph and resumable jobs

**[PR #74 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/74)**

Multi-step task execution via dependency graph with topological sort. Durable workflow state with atomic writes. Jobs survive daemon restarts mid-execution. Governance-integrated executor with configurable parallelism.

**Why:** Complex requests decompose into dependent subtasks that run in parallel where possible and resume exactly where they left off after a crash. No more lost work.

---

### CSRF Protection for Web UI

**[PR #75 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/75)**

Cryptographically random single-use UUID tokens per session, timing-safe comparison, conditional `Secure` cookie flag, and a client-side `mutatingFetch()` wrapper that auto-retries on 403.

**Why:** Prevents malicious cross-origin pages from triggering heartbeat toggles, job runs, or chat actions in an operator's logged-in browser — hardening on top of whatever reverse-proxy auth you're running.

---

### Persistent Memory — cross-session `MEMORY.md`

**[PR #77 — closed upstream — lives here](https://github.com/moazbuilds/claudeclaw/pull/77)**

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
- **Security Levels** — four access levels from read-only to full system access
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
    No. ClaudeClaw+ syncs from <a href="https://github.com/moazbuilds/claudeclaw">moazbuilds/claudeclaw</a> every day.
    Upstream fixes land here within 24 hours. It's a sister project — same foundation, wider scope.
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
