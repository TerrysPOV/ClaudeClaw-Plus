# Issue #547 Completion Report: README Accuracy

## Executive Summary
This task resolved all ten accuracy issues in `README.md` documented in issue #547 and aligned documentation with the official engine policy (#553, where interactive PTY is the official engine, `claude -p` remains a supported option, current defaults are `pty.enabled: false`, and a future release flips them via #550). Outdated claims regarding billing credit pools, hot-reload capabilities, web UI bind settings, Discord allowlists, slash commands, security levels under the bus runtime, and workflow restart persistence were updated and backed by verified code locations. Dead links into `.planning/*` were eliminated.

---

## What Changed

1. **Comparison Table (L56, L60-61):**
   - Corrected reliability claim: changed "survive restarts" to "multi-step workflows with topological DAGs".
   - Clarified that `MEMORY.md` dual-layer write guarantee and DAG task orchestrator operate on the legacy runner path.
2. **What's New in v2.0 (L65-80):**
   - Articulated the engine policy (#553): PTY is the official engine, `claude -p` remains a permanent option.
   - Removed unbacked claims about Anthropic credit pools ("Subscription billing covers daemon work; the Agent SDK credit pool stays untouched").
   - Clarified that cron and agent jobs follow `pty.enabled` via `runner.ts` (executing via `claude -p` under the current default `pty.enabled: false`, and via the PTY supervisor when `pty.enabled: true`).
   - Clarified that the Human-in-the-loop permission gate under the bus runtime is configured per-agent via `permission_mode` (default `bypassPermissions`).
3. **Getting Started Command (L94):**
   - Corrected `/claudeclaw:start` to `/claudeclaw-plus:start` per plugin manifest (`.claude-plugin/plugin.json`).
4. **Setup Choices at First Run (L103-172):**
   - Distinguished hot-reload-safe settings (~30s polling) from structural settings requiring daemon restart.
   - Updated adapter table to list `discord.busRouting.channels` requirement and warned that an empty `allowedUserIds` refuses all incoming messages. Clarified that `parseDiscordBusRouting` recognizes `channels`, `threads`, `dmAgentId`, and `primaryChannelByAgent` (`src/config.ts:1568-1591`), and `guilds` is not supported.
   - Split Web UI into Dashboard (`web.enabled: true`, `web.host:web.port`, default `127.0.0.1:4632`) and Bus Web Adapter (`web.bus.bind`, default `127.0.0.1:7878`).
   - Corrected model and fallback defaults (empty strings `""` in `settings.json`, wizard options `opus`, `sonnet`, `haiku`, `glm`).
   - Clarified fallback triggers on rate-limit text patterns detected in output (`you've hit your limit`, `out of extra usage`; `src/runner.ts:400, 586-593`) for legacy runner tasks, and Kimi routes to `https://api.kimi.com/coding/` rather than OpenRouter.
   - Clarified that bus agents default to `bypassPermissions`, and `security.level` applies to the legacy runner.
   - Updated security levels list to `locked`, `strict`, `moderate`, `unrestricted` (default `moderate`).
5. **Changing Decisions Later (L175-220):**
   - Corrected settings path from `~/.claude/claudeclaw/settings.json` to `<project>/.claude/claudeclaw/settings.json`.
   - Enumerated accurate hot-reload-safe items (heartbeat, legacy security level, MCP bridge policy, jobs, and `pty.enabled` toggle) vs restart-required items (adapters, agents, runtime switching between bus and pty, tokens, bind addresses).
   - Clarified slash commands: `/mode` is implemented in legacy Telegram only; bus adapters pass messages to `BusCore` and handle no slash commands.
   - Documented dashboard URL and auth token path `<project>/.claude/claudeclaw/web.token`.
   - Corrected adapter summary: removed references to non-existent `web.bind`.
6. **Execution Modes and Engine Policy (L223-280):**
   - Replaced `claude -p runtime` section with comprehensive Execution Modes matrix separating Bus Agent Turns from `runner.ts` paths (cron, agent jobs, rate-limit fallback, forks, and dashboard chat under legacy pty runtime).
   - Documented that bus agents do not consult `pty.enabled` (declared agents use `entry.supervision ?? "pty-stdin"`, undeclared spawns use `defaultSupervisionFor(origin)`), and real `SupervisionMode` values are `pty-stdin`, `process-stream-json`, `tmux`, and `process`.
   - Documented that dashboard chat routes directly through `streamBusPrompt()` to the default bus agent under `runtime: "bus"` (`src/commands/start.ts:1415-1439`) and does not consult `pty.enabled`; under `runtime: "pty"`, it falls back to `runner.ts` (`src/commands/start.ts:1432-1438`) and follows `pty.enabled`.
   - Clarified that `pty.enabled` is hot-reload-safe (re-evaluated per turn), while switching `runtime` requires a daemon restart (`src/commands/start.ts:606-607`).
   - Stated engine policy (#553) and transition roadmap (#550).
   - Removed dead planning links `.planning/pty-migration/SPEC.md` and `.planning/pty-migration/`.
7. **MCP Multiplexer (L283-340):**
   - Documented requirement for `web.enabled: true` to be persisted in `settings.json` (`src/commands/start.ts:1053`), as its proxy endpoints are registered on dashboard HTTP server.
   - Clarified that `--web` CLI flag alone is insufficient because startup evaluates `settings.web.enabled` before reconciling CLI flags (`src/commands/start.ts:1053, 1481`).
   - Removed dead link `.planning/mcp-multiplexer/SPEC.md`.
8. **Legacy Subsystems Scope (L342-420):**
   - Explicitly noted that Policy Engine, Governance Layer, Gateway & Escalation, Orchestrator, and Persistent Memory operate on the legacy runner pipeline and do not govern event-bus agents.
   - Removed claim that orchestrator workflows survive daemon restarts mid-execution.
9. **All the Things from Upstream (L441):**
   - Listed correct security level names (`locked`, `strict`, `moderate`, `unrestricted`) for the legacy runner.

---

## Codex PR #558 Review Findings & Verdicts

| Finding | Evidence File:Line | Verdict | Resolution |
|---|---|---|---|
| **1. Discord bus routing keys:** `discord.busRouting.guilds` claimed as valid routing key in README:117. | `src/config.ts:1568-1591`, `src/adapters/discord/index.ts:266-270` | **True** | Removed `guilds`; listed supported keys: `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent`. Noted that `parseDiscordBusRouting` ignores `guilds` and returns `null` if only `guilds` is present. |
| **2. Fallback trigger:** `fallback.model` claimed to trigger on "HTTP 429 errors only" in README:123. | `src/runner.ts:400, 586-593, 2125, 2334` | **True** | Corrected to rate-limit text patterns detected in stdout/stderr (`RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;`), which checks output text rather than HTTP 429 status codes. |
| **3. Dashboard chat under bus runtime:** Claimed dashboard chat routes through `runner.ts` and follows `pty.enabled` in README:237, 241-246. | `src/commands/start.ts:1415-1439` | **True** | Corrected line 237 and Execution Modes Matrix: under `runtime: "bus"`, dashboard chat routes via `streamBusPrompt()` to the default bus agent and does not follow `pty.enabled`. Only under `runtime: "pty"` does it fall back to `streamUserMessage()` in `runner.ts` and follow `pty.enabled`. |
| **4. `pty.enabled` hot-reload:** `pty.enabled` claimed to require a daemon restart in README:192, 276. | `src/runner/pty-supervisor.ts:36-39, 567, 909, 1124`, `src/runner.ts:742`, `src/commands/start.ts:1695` | **True** | Moved `pty.enabled` from restart-required to hot-reload-safe. Settings are polled every 30s and `pty.enabled` is checked per invocation. Clarified that only `runtime` switching requires daemon restart. |
| **5. MCP multiplexer activation:** Claimed multiplexer is activated by `--web` CLI flag in README:291. | `src/commands/start.ts:1053, 1481` | **True** | Documented that `web.enabled: true` must be persisted in `settings.json`. The startup check (`if (settings.mcp.shared.length > 0 && settings.web.enabled)`) evaluates settings before the `--web` CLI flag is reconciled at line 1481. |

---

## Verified Evidence Table

| README Line(s) | Claim / Statement | Evidence File:Line |
|---|---|---|
| L56 | Workflows use DAGs; mid-execution restart survival removed | `src/orchestrator/index.ts:1-25`, `src/orchestrator/task-graph.ts:1-40` |
| L60-61 | `MEMORY.md` dual-layer write guarantee & DAG orchestrator run on legacy runner | `src/runner.ts:69`, `src/runner.ts:39-62` |
| L67, L230-236 | Engine policy (#553): PTY official engine, `claude -p` supported; current default `pty.enabled: false` | `src/runner.ts:740-743`, `src/config.ts:140-148` |
| L71, L170 | Cron & agent jobs route through `runner.ts` and follow `pty.enabled` (`claude -p` when false, PTY supervisor when true) | `src/runner.ts:732-742, 2015, 2690` |
| L75, L129, L136 | Bus agents default to `bypassPermissions`; `security.level` does not restrict bus agents | `src/bus/agent-resolver.ts:73`, `src/bus/session-manager.ts:686-697`, `src/runner.ts:1501, 1512, 1999` |
| L94 | Slash command is `/claudeclaw-plus:start` | `.claude-plugin/plugin.json:2` |
| L103, L183-195 | Hot-reload polls every 30s for heartbeat, legacy security, MCP bridge, jobs, and `pty.enabled`; restarts required for adapters, agents, runtime, tokens, binds | `src/commands/start.ts:1693-1789`, `src/runner/pty-supervisor.ts:36-39`, `src/runner.ts:742`, `src/config.ts:734-735` |
| L111, L117 | Discord bus routing supports `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent` (not `guilds`); empty allowedUserIds refuses all messages | `src/config.ts:1568-1591`, `src/adapters/discord/index.ts:247, 266-270`, `src/allowlist.ts:25-35` |
| L114-115, L206-208 | Dashboard at `web.host:web.port` (4632); bus web adapter at `web.bus.bind` (7878); `web.bind` does not exist | `src/config.ts:203, 911-915`, `src/commands/start.ts:535-536, 1481-1501`, `src/adapters/webui/index.ts:8-12, 66, 495` |
| L121-125 | `model` and `fallback.model` default to `""`; wizard offers opus/sonnet/haiku/glm; fallback on rate-limit text patterns; Kimi endpoint | `src/config.ts:86-90`, `commands/start.md:61`, `src/runner.ts:400, 586-593, 643-644, 2125-2135` |
| L171, L441 | Security level names: `locked`, `strict`, `moderate`, `unrestricted` | `src/config.ts:454` |
| L181 | Settings path is `<project>/.claude/claudeclaw/settings.json` | `src/config.ts:23-24` |
| L201-202 | `/mode` only on legacy Telegram; bus adapters handle no slash commands | `src/commands/telegram.ts:1470-1513`, `src/bus/core.ts:2470-2475`, `src/adapters/discord/index.ts:646-647` |
| L206 | Dashboard auth token stored at `<project>/.claude/claudeclaw/web.token` | `src/ui/auth.ts:11`, `src/commands/start.ts:1481-1501` |
| L233-249 | Bus agent supervision uses `entry.supervision ?? "pty-stdin"`; undeclared spawns use `defaultSupervisionFor(origin)`; dashboard chat routes via bus under `runtime: "bus"` and via `runner.ts` under `runtime: "pty"`; `pty.enabled` governs `runner.ts` paths only | `src/bus/agent-resolver.ts:73`, `src/bus/types.ts:48-56, 77-85`, `src/commands/start.ts:1415-1439`, `src/runner.ts:732-742, 2015, 2070` |
| L239, L277 | Switching `runtime` requires daemon restart; `pty.enabled` is hot-reload-safe | `src/commands/start.ts:606-607`, `src/runner/pty-supervisor.ts:36-39`, `src/runner.ts:742`, `src/config.ts:734-735` |
| L291 | MCP multiplexer requires `web.enabled: true` in `settings.json` | `src/commands/start.ts:1053, 1111-1120, 1481` |
| L347 | Policy Engine runs on legacy runner | `src/runner.ts:39-62` |
| L359 | Governance Layer runs on legacy runner | `src/runner.ts:39-62` |
| L371 | Gateway and escalation framework run on legacy adapter pipeline | `src/commands/telegram.ts:31, 1742`, `src/commands/discord.ts:1333` |
| L383 | DAG Orchestrator runs on legacy runner; does not persist across restarts | `src/runner.ts:39-62`, `src/orchestrator/index.ts:1-35` |
| L405 | Memory dual-layer write guarantee runs on legacy runner | `src/runner.ts:69` |

---

## Audit Finding: Stale Comment in `src/job-loop.ts:1-8`

During the audit, a stale comment was identified at `src/job-loop.ts:1-8` stating:
> *Each due job runs as a one-shot `claude -p` through `run()`...*

Verification against the codebase confirmed that `job-loop.ts` calls `deps.run()` (`src/runner.ts:2690`) -> `execClaude` (`src/runner.ts:1807`) -> `resolveAgentTurnRoute` (`src/runner.ts:2070`), which branches on `settings.pty.enabled` at `src/runner.ts:732-742, 2015`. When `pty.enabled: true`, cron jobs run on the PTY supervisor rather than `claude -p`. Per instructions, source code was left untouched, but documentation in `README.md` and this report accurately reflects the code execution path rather than the stale comment.

---

## Test & Validation Results

1. **Markdown Link Check:**
   - Ran automated script checking all relative links and anchor fragments in `README.md`.
   - Results: All target files exist (`docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md`, `src/config.ts`, `docs/MULTI_SESSION.md`, `CONTRIBUTING.md`, images). Dead links `.planning/pty-migration/SPEC.md` and `.planning/mcp-multiplexer/SPEC.md` were eliminated. All anchor links (`#changing-decisions-later`, `#adapters`) resolve.
2. **Linting (`bun run lint`):**
   - Tool: Biome 2.4.15 (`biome check`).
   - Results: 0 errors across 515 files. Passed cleanly.
3. **Typecheck Ratchet (`bun run typecheck`):**
   - Command: `bun run scripts/typecheck-ratchet.ts`.
   - Baseline: 149 errors.
   - Current: 149 errors (no regression).
4. **Version Bumps:**
   - `bun run bump:plugin-version` -> `2.2.337`
   - `bun run bump:marketplace-version` -> `2.2.337`
5. **Prior Art Inspection:**
   - Checked `ultraassist/ClaudeClaw-Ultra` (local clone: `/Users/terrenceyodaiken/claude-workspace/claudeclaw-ultra`).
   - Verified that Ultra also has no one-shot module, no `sendToLiveSession`, and equivalent execution dispatch conventions. No specific phrasing or documentation patterns were borrowed as Plus's architecture has diverged significantly.

---

## Left Undone / Blockers
None. All 10 items from issue #547 and engine policy from #553 are fully addressed and verified.
