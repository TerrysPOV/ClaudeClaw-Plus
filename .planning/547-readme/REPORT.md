# Issue #547 Completion Report: README Accuracy

## Executive Summary
This task resolved all ten accuracy issues in `README.md` documented in issue #547, addressed all feedback across two rounds of Codex review on PR #558, and aligned documentation with the official engine policy (#553, where interactive PTY is the official engine, `claude -p` remains a supported option, current defaults are `pty.enabled: false`, and a future release flips them via #550). Outdated claims regarding billing credit pools, hot-reload capabilities, web UI bind settings, Discord routing and allowlists, slash commands, security levels under the bus runtime, and workflow restart recovery were updated and backed by verified code locations. Dead links into `.planning/*` were eliminated.

---

## What Changed

1. **Comparison Table (L56, L60-61):**
   - Corrected reliability claim: "Simple + multi-step workflows with topological DAGs and restart recovery (legacy runner)".
   - Clarified that `MEMORY.md` dual-layer write guarantee and DAG task orchestrator resumable state operate on the legacy runner path.
2. **What's New in v2.0 (L65-80):**
   - Articulated the engine policy (#553): PTY is the official engine, `claude -p` remains a permanent option.
   - Removed unbacked claims about Anthropic credit pools ("Subscription billing covers daemon work; the Agent SDK credit pool stays untouched").
   - Clarified that cron and agent jobs follow `pty.enabled` via `runner.ts` (executing via `claude -p` under the current default `pty.enabled: false`, and via the PTY supervisor when `pty.enabled: true`).
   - Clarified that the Human-in-the-loop permission gate under the bus runtime is configured per-agent via `permission_mode` (default `bypassPermissions`).
3. **Getting Started Command (L94):**
   - Corrected `/claudeclaw:start` to `/claudeclaw-plus:start` per plugin manifest (`.claude-plugin/plugin.json`).
4. **Setup Choices at First Run (L103-172):**
   - Distinguished hot-reload-safe settings (~30s polling) from structural settings requiring daemon restart.
   - Updated adapter table to list `discord.busRouting` requirement (any of `channels`, `threads`, `dmAgentId`, or `primaryChannelByAgent`), and warned that an empty `allowedUserIds` refuses all incoming messages unless `allowAllUsers: true` is configured for a public bot. Clarified that `parseDiscordBusRouting` recognizes `channels`, `threads`, `dmAgentId`, and `primaryChannelByAgent` (`src/config.ts:1568-1591`), and `guilds` is not supported.
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
   - Accurately described Orchestrator restart recovery: `initializeJobSystem()` on daemon startup automatically resumes pending workflows across both runtimes (`src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210`), and interrupted tasks are reclassified based on `maxRetries` (`src/orchestrator/workflow-state.ts:282-315`).
9. **All the Things from Upstream (L441):**
   - Listed correct security level names (`locked`, `strict`, `moderate`, `unrestricted`) for the legacy runner.

---

## Codex PR #558 Review Findings & Verdicts

### Round 1 Review Findings

| Finding | Evidence File:Line | Verdict | Resolution |
|---|---|---|---|
| **1. Discord bus routing keys:** `discord.busRouting.guilds` claimed as valid routing key in README:117. | `src/config.ts:1568-1591`, `src/adapters/discord/index.ts:266-270` | **True** | Removed `guilds`; listed supported keys: `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent`. Noted that `parseDiscordBusRouting` ignores `guilds` and returns `null` if only `guilds` is present. |
| **2. Fallback trigger:** `fallback.model` claimed to trigger on "HTTP 429 errors only" in README:123. | `src/runner.ts:400, 586-593, 2125, 2334` | **True** | Corrected to rate-limit text patterns detected in stdout/stderr (`RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;`), which checks output text rather than HTTP 429 status codes. |
| **3. Dashboard chat under bus runtime:** Claimed dashboard chat routes through `runner.ts` and follows `pty.enabled` in README:237, 241-246. | `src/commands/start.ts:1415-1439` | **True** | Corrected line 237 and Execution Modes Matrix: under `runtime: "bus"`, dashboard chat routes via `streamBusPrompt()` to the default bus agent and does not follow `pty.enabled`. Only under `runtime: "pty"` does it fall back to `streamUserMessage()` in `runner.ts` and follow `pty.enabled`. |
| **4. `pty.enabled` hot-reload:** `pty.enabled` claimed to require a daemon restart in README:192, 276. | `src/runner/pty-supervisor.ts:36-39, 567, 909, 1124`, `src/runner.ts:742`, `src/commands/start.ts:1695` | **True** | Moved `pty.enabled` from restart-required to hot-reload-safe. Settings are polled every 30s and `pty.enabled` is checked per invocation. Clarified that only `runtime` switching requires daemon restart. |
| **5. MCP multiplexer activation:** Claimed multiplexer is activated by `--web` CLI flag in README:291. | `src/commands/start.ts:1053, 1481` | **True** | Documented that `web.enabled: true` must be persisted in `settings.json`. The startup check (`if (settings.mcp.shared.length > 0 && settings.web.enabled)`) evaluates settings before the `--web` CLI flag is reconciled at line 1481. |

### Round 2 Review Findings

| Finding | Evidence File:Line | Verdict | Resolution |
|---|---|---|---|
| **6. Workflow restart recovery:** Claimed in README:386 that workflows do not persist across daemon restarts mid-execution. | `src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210`, `src/orchestrator/executor.ts:378-411`, `src/orchestrator/workflow-state.ts:282-315` | **True** | Corrected README lines 56, 61, and 386-390: `initializeJobSystem()` runs unconditionally on daemon startup before runtime branching and invokes `resumePending()` -> `resumeWorkflow()` to resume workflows. Interrupted running tasks are re-queued to `ready`/`pending` if attempts remain under `maxRetries`, or marked `failed` with "Task interrupted by restart" if exhausted. |
| **7. Discord bus routing required keys:** Adapter table in README:111 claimed `discord.busRouting.channels` is required under bus. | `src/config.ts:1568-1591`, `src/bus/adapter-wiring.ts:197`, `src/adapters/discord/index.ts:266-270` | **True** | Corrected line 111: `discord.busRouting` requires at least one nonempty routing destination among `channels`, `threads`, `dmAgentId`, or `primaryChannelByAgent`; `channels` specifically is not mandatory if another routing target is supplied. |
| **8. Discord allowAllUsers alternative:** Claimed in README:111 & 117 that empty `discord.allowedUserIds` unconditionally refuses all messages without noting `allowAllUsers: true`. | `src/allowlist.ts:13-21, 33-35`, `src/adapters/discord/index.ts:247` | **True** | Qualified lines 111 and 117: empty `allowedUserIds` fails closed and refuses all incoming messages unless intentionally configured as a public bot with `discord.allowAllUsers: true`. |

---

## Round 4: the restart and hot-reload contract, completed (branch `review/558`, from head 0f35d801)

Codex's fourth pass found two holes in the lists (README ~194 and ~199). Both were real, so instead of adding two entries this pass enumerated every setting and classified it as read once (startup, mount, first use) or read on use. Per-setting rows with evidence: the second table in [`AUDIT.md`](AUDIT.md) (45 rows, 39 settings new to the README's lists).

| Codex round 4 finding | Verdict | What changed |
|---|---|---|
| ~194: add `slack.appToken` and `slack.signingSecret` to the bus restart list | `signingSecret` valid; `appToken` valid only as "applied at mount" | `mountSlack()` passes both once (`adapter-wiring.ts:287-308`). `signingSecret` is stored at `adapters/slack/index.ts:207` and used for HMAC verification (`signature.ts:44`). `appToken` is **not read by anything in the bus Slack adapter**: Socket Mode is a deferred follow-up there (`types.ts:108-126`, `index.ts:209` takes only an injected `socket`), so Codex's "Socket Mode connection keeps the old credential" cannot happen on the bus today. Both are listed as restart-bound; `appToken` carries that qualification. The legacy runtime uses it and reloads it live. |
| ~199: add `mcp.perPtyOnly` | Valid | `config.ts:1747-1757` removes a name that is in both lists from `shared`, so `perPtyOnly` changes the effective shared set the multiplexer and the bus session manager fixed at startup (`start.ts:1053-1095`). The legacy PTY supervisor re-reads `mcp.shared` on each spawn (`pty-supervisor.ts:1276`), so a live edit would also split the two. |

**Restart-required settings added** (read once): `slack.appToken`, `slack.signingSecret` (+ `slack.busRouting.signingSecret`), `telegram.receiveEnabled` (bus), `mcp.perPtyOnly`, `mcp.healthProbeIntervalMs`, `mcp.sessionPersistenceEnabled`, `mcp.sessionMaxAgeSeconds`, `mcp.sessionPersistencePath`, `mcp.rateLimit`, `mcp.metricsEnabled`, `mcp.cache`, `web.bus.token` (+ `CCAW_WEBUI_TOKEN`), `web.bus.allowedAgentIds`, `web.bus.allowedOrigins`, `agentJobs.*`, `stallWatchdog.*`, `kanban.enabled`, `plugins`, `governance.watchdog.*`, `governance.evalFramework.*`, `agentic.modes`, `agentic.defaultMode`, `pty.idleReapMinutes`, `pty.namedAgentsAlwaysAlive`.

**Hot-reload settings added** (read on use): `model`, `api`, `fallback`, `agentic.enabled`, `watchdog`, `timeouts`, `session.*`, `sessionTimeoutMs`, `jobsDir`, `quietHours`, `llmRouter.*`, `pty.maxRetries`/`respawnRetries`/`backoffMs`/`maxConcurrent` (per call), `pty.cols`/`rows`/`turnIdleTimeoutMs`/`quietWindowMs`/`sentinelMaxWaitMs` (per new PTY), the legacy-only adapter options (`telegram.listenChats`/`dmIsolation`/`whisperModel`, `discord.listenChannels`/`listenGuilds`/`channelNames`/`imageOutputRoots`/`streaming`, `slack.listenChannels`/`allowBots`/`allowBotIds`), `stt.*`, `apiToken`, `shutdown.drainTurnsMs`, `memorySearch.reindexEveryNTurns`, `attachments.*` (Discord adapter only), and `slack.appToken` / `telegram.receiveEnabled` under the legacy runtime.

How it was done: all 33 keys of the `Settings` interface (`config.ts:779-838`); every settings read in `start.ts` (126 sites) extracted and grouped; then each other consumer read for "once or on use". The reload loop re-applies only MCP bridge/audit policy, jobs, heartbeat, the legacy adapter tokens, and the bus scheduler; `security` is only logged there because the runner reads it live.

Checks: `bun run lint` (whole repo) exit 0; the README link, anchor and citation check passes (41 links, 120 citations in range). A new key-coverage script confirms all 33 top-level keys are named in the two lists, and fails when one is removed (shown by deleting `kanban`). It found a real gap in my own first draft (`heartbeat` and `timezone` were not named with the key spelling), fixed.

Judgement calls: `memorySearch` is listed as hot, because only a one-off index at boot uses the boot value. `attachments.*` is claimed only for the Discord adapter, the one consumer I traced. `governance.evalFramework` is described as read when that server process starts, since it calls `loadSettings()` itself. `mcp-proxy.json` is a separate file, not part of `settings.json`, and is not listed. No version bump (the branch carries 2.2.337).

Not done: no runtime test of the reload behaviour, only code reading. A live check would be to change each restart-bound value, wait 30 s, and confirm the process behaves as before.

---

## Round 3: Codex findings and full code audit (branch `review/558`, from head 7bcb673c)

Round 3 had three open Codex findings. Because every round had found new claims the code contradicts, this pass also re-audited the whole README diff against the code: **80 claims, 38 fixed, 1 added, 41 confirmed**. Row by row, with `file:line` evidence: [`AUDIT.md`](AUDIT.md). That table supersedes the "Verified Evidence Table" below, whose citations were not all right (see the list of wrong cites in AUDIT.md).

| Codex round 3 finding | Verdict | Fix |
|---|---|---|
| README ~194: token hot-reload differs by runtime | Valid | Under the legacy runtime (`runtime: "pty"`, or a failed bus mount) `initTelegram`/`initDiscord`/`initSlack` start, restart and stop adapters on a token change (`start.ts:885-1022, 1759-1767`); under a mounted bus runtime a restart is needed (`:1791-1795`). Both lists say so, and the line-103 intro no longer says tokens always need a restart. |
| README ~195: `web.enabled` missing from the restart list | Valid | Added with `web.host`/`web.port`: the dashboard is created once from the startup value (`start.ts:535, 1480`). |
| `marketplace.json` ~11: top-level `version` stale | Valid | The file has a top-level `version` (line 25) and `plugins[].version` (line 11); `scripts/bump-marketplace-version.ts` bumps only the nested one and earlier bumps edited both by hand. Top-level set to 2.2.337. Not a version bump: no new version. |

Errors the audit found that Codex had not (details and evidence in AUDIT.md):

- **Policy engine "legacy runner only" was wrong.** The bus permission gate consults it (`bus/core.ts:3369-3393, 3820-3832`), the gateway and orchestrator do too; `runner.ts`'s own `evaluateToolForExecution` is never called.
- **DAG orchestrator "(legacy runner)" was wrong.** Nothing in production submits a workflow to it; its one live wiring is the startup resume.
- **`memory_file` was documented as used by bus agents; it is parsed and copied, never read.**
- **`security.level: locked` is not read-only** (`Write` stays allowed, `runner.ts:1505`); `disallowedTools` is ignored under it.
- **The wizard does not pick `bypassPermissions`**; the bus resolver defaults to it.
- **Execution-modes matrix:** forks are legacy-Telegram only, agent jobs bus only, and `process-stream-json` (a bus supervision mode) was mislabelled onto the runner.
- Citations that pointed at the wrong lines: reload loop blocks, `agent-resolver.ts:73` (supervision is `:74`), `types.ts:77-85`, `start.ts:1111-1120` and `1432-1438`, `runner.ts:69`, `runner.ts:39-62`.
- **Added:** channel allow-lists hot-reload (`allowlist.ts:23-27`, `start.ts:1152`).

Checks run: `bun run lint` (whole repo) and a script that resolves every relative link and anchor in the README (41 links) and checks that every `file:line` citation (90) lies inside its file; the script was shown to fail on an injected broken link, anchor, citation range and missing file. It checks that a citation points inside the file, not that it says what the README claims; the second is what the per-row reading in AUDIT.md covers.

Not done: the "Drain" paragraph (`shutdown.drainTurnsMs`) is not part of this PR's diff and was not re-audited. Prior art (ClaudeClaw-Ultra) not consulted for this pass. No version bump (the branch carries 2.2.337).

---

## Verified Evidence Table

| README Line(s) | Claim / Statement | Evidence File:Line |
|---|---|---|
| L56 | Workflows use DAGs with crash recovery (legacy runner) | `src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210`, `src/orchestrator/workflow-state.ts:282-315` |
| L60-61 | `MEMORY.md` dual-layer write guarantee & DAG orchestrator resumable state run on legacy runner | `src/runner.ts:69`, `src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210` |
| L67, L230-236 | Engine policy (#553): PTY official engine, `claude -p` supported; current default `pty.enabled: false` | `src/runner.ts:740-743`, `src/config.ts:140-148` |
| L71, L170 | Cron & agent jobs route through `runner.ts` and follow `pty.enabled` (`claude -p` when false, PTY supervisor when true) | `src/runner.ts:732-742, 2015, 2690` |
| L75, L129, L136 | Bus agents default to `bypassPermissions`; `security.level` does not restrict bus agents | `src/bus/agent-resolver.ts:73`, `src/bus/session-manager.ts:686-697`, `src/runner.ts:1501, 1512, 1999` |
| L94 | Slash command is `/claudeclaw-plus:start` | `.claude-plugin/plugin.json:2` |
| L103, L183-195 | Hot-reload polls every 30s for heartbeat, legacy security, MCP bridge, jobs, and `pty.enabled`; restarts required for adapters, agents, runtime, tokens, binds | `src/commands/start.ts:1693-1789`, `src/runner/pty-supervisor.ts:36-39`, `src/runner.ts:742`, `src/config.ts:734-735` |
| L111, L117 | Discord bus routing requires at least one of `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent` (not `guilds`); empty allowedUserIds refuses all messages unless `allowAllUsers: true` | `src/config.ts:1568-1591`, `src/bus/adapter-wiring.ts:197`, `src/adapters/discord/index.ts:247, 266-270`, `src/allowlist.ts:13-21, 33-35` |
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
| L383-388 | DAG Orchestrator runs on legacy runner; resumes workflows across restarts via `initializeJobSystem()`; interrupted tasks reclassified per retry budget | `src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210`, `src/orchestrator/executor.ts:378-411`, `src/orchestrator/workflow-state.ts:282-315` |
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
   - `bun run bump:marketplace-version` -> `2.2.337` (nested `plugins[].version` only; the top-level `version` was left at 2.2.336 until round 3)
5. **Prior Art Inspection:**
   - Checked `ultraassist/ClaudeClaw-Ultra` (local clone: `/Users/terrenceyodaiken/claude-workspace/claudeclaw-ultra`).
   - Verified that Ultra also has no one-shot module, no `sendToLiveSession`, and equivalent execution dispatch conventions. No specific phrasing or documentation patterns were borrowed as Plus's architecture has diverged significantly.

---

## Left Undone / Blockers
None. All 10 items from issue #547 and engine policy from #553 are fully addressed and verified.
