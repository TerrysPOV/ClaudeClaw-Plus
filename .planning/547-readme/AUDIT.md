# AUDIT: README claims vs. code (#547, PR #558)

Audited on branch `review/558` (head `7bcb673c` + this pass). `src/` on this branch is byte-identical to `povai/main` (d81bd579), so every citation is against main.

**80 claims audited, 38 fixed, 1 added, 41 confirmed as written.** Three of the fixes are the open Codex round-3 findings (tokens, `web.enabled`, marketplace version); the other fixes were found by this audit.

**Round 4 (Codex on head 0f35d801):** the restart and hot-reload lists were incomplete. Both findings were valid (`slack.appToken`/`slack.signingSecret`, `mcp.perPtyOnly`) and led to a full enumeration of the settings keys: see the second table, one row per setting (R-rows).

Method: for each added or changed sentence, table cell and code block in `git diff povai/main...HEAD -- README.md`, read the cited code (and, where a negative claim was made, grepped the whole tree), then fixed the README where the code disagreed. Citations that moved were corrected; `README line` is resolved mechanically from the claim text. Mechanical checks at the end of the run: every relative link and anchor resolves, and every `file:line` citation in the README points inside its file.

| # | Claim | README line | Evidence | Verdict |
|---|---|---|---|---|
| 1 | Reliability row: DAG workflows with restart recovery | 56 | No production caller submits a workflow: `scheduleJob`/`executeJobNow`/`processCronTrigger`/`registerJobHandlers` have none outside tests (repo-wide grep); only `start.ts:527-528` → `resumable-jobs.ts:246-290` resumes persisted ones | fixed: was "(legacy runner)"; the engine is not driven by the runner. Now "engine only", with a link to the Orchestrator section |
| 2 | Memory row: MEMORY.md dual-layer guarantee is runner-path only | 60 | `runner.ts:1945-1949, 1990-1997, 2490-2500`; `agent-resolver.ts:77` copies `memory_file`, nothing reads it | fixed: "(legacy runner)" kept in spirit, wording now "runner path only" + working anchor |
| 3 | Multi-step jobs row | 61 | same as Reliability row | fixed: "engine only: no job path submits workflows yet" |
| 4 | PTY is the official engine; `claude -p` stays a permanent supported option | 67 | Policy statement from issue #553 (OPEN); `pty.enabled` default is `false` today (`config.ts:221-225`), which the README states in the matrix | ok |
| 5 | Operators pick: bus/PTY for continuous work, `claude -p` for isolated subprocess work | 67 | `config.ts:744, 1346-1350` (supervision values), `runner.ts:740-743` | ok |
| 6 | One long-lived `claude` per declared agent under `pty-stdin` | 71 | `agent-resolver.ts:74` (default `pty-stdin`), `session-manager.ts:812` | ok |
| 7 | Cron/agent jobs route through `runner.ts` and follow `pty.enabled` | 71 | `job-loop.ts:1-9, 61-68`, `runner.ts:740-743, 959, 2690` | ok |
| 8 | Per-agent isolation: working dirs, permission modes, system prompts (not memory files) | 74 | `config.ts:1434` parses `memory_file`, `agent-resolver.ts:77` copies it, no other reader (repo-wide grep; the issue also lists it as parsed-but-unused) | fixed: "and memory files" removed |
| 9 | Permission gate prompts operator inline per `permission_mode`; default `bypassPermissions` | 75 | `agent-resolver.ts:73`; gate: `bus/core.ts:3820-3843` | ok |
| 10 | Start command is `/claudeclaw-plus:start` | 94 | `.claude-plugin/plugin.json` name `claudeclaw-plus`; `commands/start.md` (no `/claudeclaw:` left in README) | ok |
| 11 | Which settings reload within ~30s vs need restart (intro sentence) | 103 | Whole reload trace below (rows under "Changing decisions later") | fixed: said tokens always need a restart; now "tokens under the bus runtime", plus `pty.enabled` and allow-lists |
| 12 | Discord needs a non-empty `busRouting` destination under bus | 111 | `config.ts:1568-1591`, `adapter-wiring.ts:197`, `discord/index.ts:266-270` | ok |
| 13 | Empty `allowedUserIds` refuses everyone unless `allowAllUsers: true` | 111 | `allowlist.ts:1-9, 13-21, 33-35`, `discord/index.ts:244-256` | ok |
| 14 | Web UI dashboard: `web.enabled`, `web.host:web.port`, default 127.0.0.1:4632 | 114 | `config.ts:203`, `start.ts:535-536` | ok |
| 15 | Web UI bus adapter: `web.bus.bind`, default 127.0.0.1:7878 | 115 | `adapters/webui/index.ts:66, 495` | ok |
| 16 | `guilds` is not a routing key | 117 | `DiscordBusRouting` fields `config.ts:357-368`: channels, threads, dmAgentId, primaryChannelByAgent; no `guilds` anywhere in discord adapter or config | ok |
| 17 | `model`/`fallback.model` default to empty, inheriting Claude Code's model | 121 | `config.ts:85-91`; `--model` only added when non-empty (`runner.ts:1022`) | ok |
| 18 | Wizard offers opus (default), sonnet, haiku, glm | 121 | `commands/start.md:61, 76` | ok |
| 19 | `fallback.model` triggers on rate-limit text only | 123 | `runner.ts:400, 586-593, 2125-2135` | ok |
| 20 | Fallback does not apply to bus agents | 123 | nothing under `src/bus` or `src/adapters` reads `fallback` (grep) | ok |
| 21 | `kimi-k2p6` goes to api.kimi.com/coding, not OpenRouter | 123 | `runner.ts:643-644` | ok |
| 22 | `bypassPermissions` is the default for bus agents | 129 | `agent-resolver.ts:73` | ok |
| 23 | Where the default comes from (was: "the wizard picks") | 136 | `agent-resolver.ts:73`; wizard "headless" choice "DO NOTHING" at `commands/start.md:117` | fixed: attributed to the wizard; it is the bus resolver's default |
| 24 | `security.level` does not restrict bus agents | 136 | grep: no `security.`/`buildSecurityArgs` use in `src/bus` (only a comment, `session-manager.ts:461`) | ok |
| 25 | Cron jobs run via `runner.ts` under both runtimes and follow `pty.enabled` | 170 | `job-loop.ts:1-9, 61-68`, `runner.ts:740-743, 2070, 2690` | ok (cites refined: `2015` is the prompt constraint, not routing) |
| 26 | `security.level` values and what each does; `locked` is not read-only | 171 | `runner.ts:1501-1509` (`--tools Read,Grep,Glob,Write`), `:1512-1516`, `:1517-1522`, `:1999`; `config.ts:202, 454, 989` | fixed: "locked (read-only searching/reading)" is wrong, Write is allowed (the wizard text at `start.md` also says read-only; not touched here). Added: strict/moderate/unrestricted behaviour, `disallowedTools` ignored under locked |
| 27 | Settings live at `<project>/.claude/claudeclaw/settings.json` | 181 | `config.ts:23-24` | ok |
| 28 | Daemon re-reads the file every 30 s | 181 | `start.ts:1693-1799`, `config.ts:2131-2136` | fixed: cite said `1693-1789`, the interval closes at 1799 |
| 29 | Hot: heartbeat interval/prompt/excludeWindows/timezone | 184 | `start.ts:1707-1736` (hbChanged → `scheduleHeartbeat`), `:1768-1790` (bus scheduler rebuilt) | fixed: cite said `1700-1707`; also covers enabled/prompt/timezone and the bus path |
| 30 | Hot: job list | 185 | `start.ts:1742-1757` | fixed: cite said `1725-1748` |
| 31 | Hot: security level / allowed / disallowed tools (legacy runner) | 186 | `runner.ts:1847-1848, 1911` read per run; `start.ts:1716-1726` only logs | fixed: cite said `1709-1715`; now includes the tool lists |
| 32 | Hot: MCP bridge tool policy + audit policy | 189 | `start.ts:1698-1703` | fixed: cite said `1717-1723`; audit policy added |
| 33 | Hot: `pty.enabled` for `runner.ts` paths | 190 | `runner.ts:740-743` (`getSettings().pty.enabled` per call), `pty-supervisor.ts:36-39` | ok |
| 34 | Hot: channel allow-lists (bus and legacy) | 191 | `allowlist.ts:23-27`, `adapter-wiring.ts:81-86, 120-135`, `start.ts:1152` (`liveSettings: () => currentSettings`) | added: real hot-reload behaviour missing from the list (#520) |
| 35 | Hot: tokens, legacy runtime only (Codex P2, round 3) | 194 | `start.ts:885-1022` (`initTelegram`/`initDiscord`/`initSlack` start, restart, stop on token change; Telegram `receiveEnabled` toggle), `:1759-1767` (called in the reload loop when `!skipLegacyAdapters`) | fixed: tokens were listed as restart-required universally |
| 36 | Restart: adapter routing | 197 | `start.ts:1791-1795` ("Bus ADAPTER changes (routing, tokens) still require a daemon restart") | ok |
| 37 | Restart: tokens under the bus runtime | 198 | same comment, `start.ts:1791-1795`; reload loop skips `initX` when `skipLegacyAdapters` | fixed: scoped to bus |
| 38 | Restart: `agents[]` and `permission_mode` | 199 | `start.ts:613` (`resolveBusAgentConfigs(settings.agents)` once at mount) | ok |
| 39 | Restart: `runtime` | 200 | `start.ts:606`, `config.ts:734-735` | fixed: cite was `606-607`; second line is inside the try |
| 40 | Restart: `web.enabled`/`web.host`/`web.port` (Codex P2, round 3) | 201 | `start.ts:535-536` (startup-only `webEnabled`/`webPort`), `:1480` (server created once), `:1737-1740` (reload only pins `enabled`/`port` to the running server) | fixed: `web.enabled` was missing from the restart list |
| 41 | Restart: `web.bus.bind` | 202 | bus adapters mounted once, `start.ts:1791-1795` | ok |
| 42 | Restart: shared MCP servers | 203 | `start.ts:1053` (multiplexer started once) | ok |
| 43 | Marketplace manifest: top-level `version` and `plugins[].version` agree (Codex P2, round 3) | `.claude-plugin/marketplace.json` 11, 25 | `jq` of the file: both `2.2.337` (plugin.json `2.2.337`); history shows every earlier bump moved both (`f86d1435` 2.2.335→2.2.336 touched both lines); `scripts/bump-marketplace-version.ts` bumps only `plugins[].version` | fixed: top-level was left at 2.2.336 |
| 44 | `/mode` toggles permission mode on legacy Telegram only | 213 | `telegram.ts:1470-1513`; no `/mode` in `discord.ts`/`slack.ts` (grep) | ok |
| 45 | Bus adapters do not implement `/mode`, `/heartbeat`, `/agents`, `/help` | 214 | `bus/core.ts:2469-2476` (hook only), `discord/index.ts:645-647` and `slack/index.ts:960` ("not yet ported"); no adapter calls `invokeSlashCommand` | fixed: wording said adapters "intercept"; cites pointed at an unrelated range |
| 46 | Dashboard URL/default; `--web` flag or `web.enabled` | 218 | `config.ts:203`, `start.ts:267-301, 535` | ok |
| 47 | Dashboard auth token at `<project>/.claude/claudeclaw/web.token` | 218 | `ui/auth.ts:10-12`; enforcement `start.ts:1482-1486` | ok |
| 48 | Bus web adapter exposes `/health`, `/prompt`, `/ws` | 220 | `adapters/webui/index.ts:215-229` | fixed: `/ws` is not GET-only in code (path match); cite added |
| 49 | `web.bind` is not a setting | 231 | `WebConfig` `config.ts:911-917` | fixed: cite `203, 911-915` → `203, 911-917` |
| 50 | Tracking-issue links #61 #546 #550 #553 exist | 241 | `gh issue view` (#61, #546 closed; #550, #553 open) | ok |
| 51 | Two runtimes, two engines | 243 | `config.ts:737`, `runner.ts:740-743` | ok |
| 52 | Bus agent turns never consult `pty.enabled` | 248 | grep: no `pty.enabled`/`settings.pty` in `src/bus` | ok |
| 53 | Declared agents get `entry.supervision ?? "pty-stdin"` | 248 | `agent-resolver.ts:74` | fixed: cite said `:73` (that is `permission_mode`) |
| 54 | Fallback to `defaultSupervisionFor(origin)` for configs without `supervision` | 248 | `session-manager.ts:812`; `types.ts:38-43, 54-56` | fixed: cite `types.ts:77-85` is the event-topic list; "undeclared spawns" reworded |
| 55 | Valid `supervision` values | 248 | `config.ts:744, 1346-1350`; `types.ts:48-52` | ok |
| 56 | `pty.enabled` scope: one decision, five call sites | 249 | `runner.ts:729-743, 959, 2070, 2727, 3091` | fixed: cites replaced; `2015` is a prompt constraint |
| 57 | Agent jobs exist only under bus; forks only under legacy Telegram | 249 | `bus/runtime-mount.ts:43, 465-471` is the only caller; `runFork` only at `telegram.ts:1446` | fixed: said "agent jobs, ... and forks under either runtime" |
| 58 | Dashboard chat under bus: `streamBusPrompt`; falls back to runner without an agent | 249 | `start.ts:1415-1438`, fallback `:1439` | fixed: cite `1415-1439` hid the fallback; caveat added |
| 59 | Defaults: `pty.enabled` false; #550 flips it | 250 | `config.ts:221-225`; #550 OPEN | ok |
| 60 | Runtime switch needs a restart; runtimes share no IPC/state | 251 | `start.ts:606`, `config.ts:734-735` | ok |
| 61 | Matrix row 1: bus, `pty.enabled` false | 257 | `config.ts:285` (runtime default `bus`), `:225`; `runner.ts:959, 2070`; `job-loop.ts:1-9` | fixed: `(process-stream-json)` label (a bus SupervisionMode) removed from runner paths; "forks" removed (legacy Telegram only) |
| 62 | Matrix row 2: bus, `pty.enabled` true | 258 | `runner.ts:729-743, 959, 2070` | fixed: same label/forks fix |
| 63 | Matrix row 3: pty runtime, false | 259 | `start.ts:1439`, `runner.ts:2727, 3091` | fixed: "agent job" removed (bus only); cites `start.ts:1432-1438` were inside the bus branch |
| 64 | Matrix row 4: pty runtime, true | 260 | `runner.ts:729-743, 2070, 2727, 3091` | fixed: same |
| 65 | When to pick `claude -p`: audit, cost ceilings, stateless | 264 | qualitative guidance (no code claim); consistent with `job-loop.ts:4-6` one-shot per job | ok |
| 66 | When to pick PTY/Bus: multi-channel routing with origin-aware replies | 272 | `bus/types.ts:23-31` (origins), `bus/core.ts:113, 152-177` (`origin_id` carried on replies) | ok |
| 67 | Per-agent supervision: dirs and system prompts (not memory files) | 273 | `memory_file` unused (see Per-agent isolation row) | fixed: "and memory files" removed |
| 68 | `pty.enabled` hot-reload note | 288 | `runner.ts:740-743`, `pty-supervisor.ts:36-39`, `start.ts:606` | ok |
| 69 | `pty` settings block shows the defaults | 281 | `config.ts:221-237` | ok |
| 70 | Multiplexer needs `mcp.shared` non-empty AND persisted `web.enabled`; `--web` alone is not enough | 303 | `start.ts:1053` (gate), `:1111-1120` (warning branch), `:1480-1481`; routes mounted by `ui/server.ts:257-267` | fixed: cite `1111-1120` was the warning, not route registration; added the `mcp.shared` condition |
| 71 | Policy engine: where it is consulted | 361 | `bus/core.ts:3369-3393, 3820-3832`, `gateway/index.ts:233-244`, `orchestrator/executor.ts:133-139`; `runner.ts:1638` `evaluateToolForExecution` is never called | fixed: said "legacy runner only" (`runner.ts:39-62` are governance imports); the bus gate does consult it, the runner helper is dead code |
| 72 | Policy engine "Why" line | 365 | same | fixed: "for legacy runner invocations" was wrong; "Every tool call is evaluated" (unchanged text) corrected to "requests that reach the engine" |
| 73 | Governance layer wired into `runner.ts`, not bus | 373 | `runner.ts:36-62`; no governance reference under `src/bus`/`src/adapters`; `start.ts:454-482` configures the watchdog at startup | fixed: cite `39-62` → `36-62`; watchdog startup config noted |
| 74 | Gateway/escalation are legacy-adapter, opt-in | 385 | `telegram.ts:31, 1741-1742`, `discord.ts:1333` (`USE_GATEWAY_*` flags); importers of `escalation`: gateway, event-processor, runner watchdog, orchestrator; none under bus | fixed: opt-in env flags were not mentioned |
| 75 | Orchestrator is an engine with one live wiring (startup resume); restart handling | 397 | `executor.ts:83-95, 155-193`; `resumable-jobs.ts:174-215, 246-290`; `workflow-state.ts:282-314`; repo-wide grep of callers | fixed: said it "operates on the legacy runner.ts pipeline"; it does not |
| 76 | Orchestrator body: atomic writes, resume across restarts | 399 | `workflow-state.ts:56-72` (temp file + rename; the code notes it is atomic but not fsync-durable, which matches the README wording); resume `executor.ts:378-411` | ok |
| 77 | Memory note: persistence is runner-path; `memory_file` unused | 419 | `runner.ts:1945-1949, 1990-1997, 2490-2500`; `config.ts:1434`, `agent-resolver.ts:77` | fixed: said bus agents use `memory_file`; cite `runner.ts:69` was an import line |
| 78 | Memory body: pre-compact, pre-shutdown, 200-line cap, per-agent paths | 421 | `runner.ts:2544-2570`; `stop.ts:36-84` (global session only, CLI side); `runner.ts:2514`, `prompts/MEMORY_INSTRUCTIONS.md:42`; `memory.ts:40-45` | fixed: unchanged sentence overstated; conditions added |
| 79 | Security Levels bullet: `locked`/`strict`/`moderate`/`unrestricted`, legacy runner | 455 | `config.ts:454, 989`, `runner.ts:1501-1522` | ok |
| 80 | Removed dead links `.planning/pty-migration/SPEC.md`, `.planning/mcp-multiplexer/SPEC.md` | 292 | `ls`: neither file exists; remaining references resolve (link check) | ok |


## Restart and hot-reload contract: one row per setting (round 4)

Method: the Settings interface has 33 top-level keys (`config.ts:779-838`). Every read of `settings` / `currentSettings` / `newSettings` / `getSettings()` in `start.ts` was extracted (126 sites), then each remaining consumer (adapter mounts in `bus/adapter-wiring.ts`, `bus/runtime-mount.ts`, the multiplexer plugin, `runner.ts`, the PTY supervisor, the legacy adapters, the web server) was read to see whether it takes the value once (startup, mount, first use, constructor) or on every use. The reload loop (`start.ts:1693-1799`) re-applies only: MCP bridge/audit policy, jobs, heartbeat, security (log only), the legacy adapter tokens, and the bus scheduler; everything else is either read live by its consumer or fixed at startup. `README line` is the first line carrying the setting.

| # | Setting | Mode | README line | Evidence | Verdict |
|---|---|---|---|---|---|
| R1 | `slack.appToken` under the bus runtime (Codex round 4) | restart | 198 | `adapter-wiring.ts:308` passes it into the `SlackAdapter` constructor once (mount), so a change is only applied by a restart. BUT no code under `src/adapters/slack` reads `.appToken` (grep): `types.ts:108-126` says Socket Mode is a deferred follow-up and `index.ts:209` takes only an injected `socket`. Codex's "Socket Mode connection keeps the old credential" does not happen on the bus today; the legacy runtime does use it (`commands/slack.ts:1765-1842`) and reloads it live (`start.ts:995-1013`) | added: listed, with the qualification that it has no effect under bus yet |
| R2 | `slack.signingSecret` and `slack.busRouting.signingSecret` under bus (Codex round 4) | restart | 198 | `adapter-wiring.ts:287-297` (resolved once; stored at `adapters/slack/index.ts:207`, used for the HMAC check at `adapters/slack/signature.ts:44`, `index.ts:426`); the legacy Slack runtime never uses it (`commands/slack.ts` has only `appToken` for Socket Mode, grep) | added |
| R3 | `telegram.receiveEnabled` under bus | restart | 198 | `adapter-wiring.ts:240` (gates the token-only mount), `:264` (constructor option); legacy runtime toggles it live in `initTelegram` (`start.ts:911-920`) | added |
| R4 | `telegram.busRouting.defaultAgentId`, `slack.busRouting.*`, `discord.busRouting.*` | restart | 197 | routing objects are built at mount: `adapter-wiring.ts:254-261, 301-307, 205`; `start.ts:1791-1795` | ok (listed before; sub-keys spelled out) |
| R5 | `mcp.perPtyOnly` (Codex round 4) | restart | 203 | `config.ts:1747-1757` (a name in both lists is removed from `shared`, so `perPtyOnly` edits change the effective shared set); the multiplexer and bus synthesizer fix that set at startup (`start.ts:1053-1095`, `plugins/mcp-multiplexer/index.ts:289`); legacy PTY spawns re-read `settings.mcp.shared` each time (`pty-supervisor.ts:1276`), so a live edit would also leave the two out of step | added |
| R6 | `mcp.shared`, `mcp.stateless` | restart | 203 | `plugins/mcp-multiplexer/index.ts:121-165` (`_readSettings`), `:289` (only call, in `start()`), `start.ts:1053` | ok (listed before) |
| R7 | `mcp.healthProbeIntervalMs` | restart | 203 | `plugins/mcp-multiplexer/index.ts:128-135, 289` | added |
| R8 | `mcp.sessionPersistenceEnabled`, `mcp.sessionMaxAgeSeconds`, `mcp.sessionPersistencePath` | restart | 203 | `plugins/mcp-multiplexer/index.ts:136-147, 289` | added |
| R9 | `mcp.rateLimit` | restart | 203 | `plugins/mcp-multiplexer/index.ts:426` (`rateLimit: settings.rateLimit` from the start-time view), `http-handler.ts:259-260` | added |
| R10 | `mcp.metricsEnabled` | restart | 203 | `plugins/mcp-multiplexer/index.ts:148, 289` | added |
| R11 | `mcp.cache.*` | restart | 203 | `plugins/mcp-multiplexer/index.ts:149-165, 289` | added |
| R12 | `mcp.bridge`, `mcp.audit` | hot | 189 | `start.ts:1698-1703` | ok (listed before) |
| R13 | `web.bus.bind` | restart | 202 | `adapter-wiring.ts:341-347`; adapter mounted once | ok (listed before) |
| R14 | `web.bus.token` and `CCAW_WEBUI_TOKEN` | restart | 202 | `adapter-wiring.ts:324-341` (`resolveWebUiToken(cfg.bus)` at mount) | added |
| R15 | `web.bus.allowedAgentIds`, `web.bus.allowedOrigins` | restart | 202 | `adapter-wiring.ts:346-347` | added |
| R16 | `agentJobs.*` | restart | 204 | `bus/runtime-mount.ts:447` (`getSettings().agentJobs` once, at mount) | added |
| R17 | `stallWatchdog.*` | restart | 204 | `bus/runtime-mount.ts:595` (once, after a successful mount) | added |
| R18 | `kanban.enabled` | restart | 204 | `start.ts:1197` (tracker created once; the only field is `enabled`, `config.ts:841-843`) | added |
| R19 | `plugins` | restart | 205 | `start.ts:565-566` (`pluginManager.loadAll(settings.plugins)` once) | added |
| R20 | `governance.watchdog.*` | restart | 205 | `start.ts:452-486` (`configureWatchdog` once at startup; not in the reload loop); `config.ts:877-881` (`GovernanceConfig` has only `watchdog` and `evalFramework`) | added |
| R21 | `governance.evalFramework.*` | restart | 205 | `plugins/eval-framework/server.ts:80-90` (`loadSettings()` once when that server process starts) | added |
| R22 | `agentic.modes`, `agentic.defaultMode` | restart | 206 | `runner.ts:88-103` (`governanceInitialized` flag: configured once), `:1867-1868` (first run with `agentic.enabled`) | added |
| R23 | `pty.idleReapMinutes`, `pty.namedAgentsAlwaysAlive` | restart | 207 | `pty-supervisor.ts:543-553` (`ensureSupervisorInitialised` returns early once initialised), `:566-583` (`opts` captured in the reaper's `setInterval` closure) | added |
| R24 | `runtime`, `agents[]`, `agents[].permission_mode`, `web.enabled/host/port` | restart | 200 | `start.ts:606, 613, 535, 1480` | ok (listed before) |
| R25 | `model`, `api`, `fallback`, `agentic.enabled`, `watchdog`, `security.*` | hot | 187 | `runner.ts:1847-1848` (`const settings = getSettings(); const { security, model, api, fallback, agentic, watchdog } = settings`) | added |
| R26 | `timeouts.*` | hot | 187 | `runner.ts:668-669` (`resolveTimeoutMs` reads `getSettings().timeouts` per call) | added |
| R27 | `session.*` (`autoRotate`, `maxMessages`, `maxAgeHours`, `summaryPath`, `gatewayScope`) | hot | 187 | `runner.ts:1831`; `start.ts:943-949` (gateway scope read per turn); `bus/runtime-mount.ts:506` | added |
| R28 | `sessionTimeoutMs` | hot | 187 | `runner.ts:1616, 1746` (`getSettings()` per compact call) | added |
| R29 | `jobsDir` | hot | 187 | `config.ts:74-75` (`cached?.jobsDir` per call; `reloadSettings` replaces `cached`, `:2131-2136`) | added |
| R30 | `quietHours.*` | hot | 188 | `start.ts:901, 1150, 1166` (getters over `currentSettings`), `quiet-hours.ts:23-27`, `adapter-wiring.ts:77-80` | added |
| R31 | `llmRouter.*` | hot | 189 | `plugins/llm-router/server.ts:90-98, 219-227` (`reloadSettings()` per call) | added |
| R32 | `pty.maxRetries`, `pty.respawnRetries`, `pty.backoffMs` | hot | 190 | `pty-supervisor.ts:803, 908-918` (`readSupervisorOptions()` at each `runOnPty`) | added |
| R33 | `pty.maxConcurrent` | hot | 190 | `pty-supervisor.ts:1078-1082` (`getSettings().pty.maxConcurrent` per admission) | added |
| R34 | `pty.cols`, `rows`, `turnIdleTimeoutMs`, `quietWindowMs`, `sentinelMaxWaitMs` | hot | 190 | `pty-supervisor.ts:1248-1252` (read in `buildSpawnOptions`; a live PTY keeps what it was spawned with) | added |
| R35 | `pty.enabled` | hot | 190 | `runner.ts:740-743` | ok (listed before) |
| R36 | `telegram.listenChats`, `dmIsolation`, `whisperModel` (legacy only) | hot | 192 | `commands/telegram.ts:914, 1046, 1117` (`getSettings().telegram` per event); not passed to the bus adapter (`adapter-wiring.ts:255-267`) | added |
| R37 | `discord.listenChannels`, `listenGuilds`, `channelNames`, `imageOutputRoots`, `streaming` (legacy only) | hot | 192 | `commands/discord.ts:558, 923, 1479, 1690, 1898` (`getSettings().discord` per event); not passed to the bus adapter (`adapter-wiring.ts:199-207`) | added |
| R38 | `slack.listenChannels`, `allowBots`, `allowBotIds` (legacy only) | hot | 192 | `commands/slack.ts:933, 1453, 1577` (`getSettings().slack` per event); not passed to the bus adapter (`adapter-wiring.ts:294-310`) | added |
| R39 | `stt.*` | hot | 193 | `whisper.ts:384`, `commands/telegram.ts:1636, 1713` (`getSettings().stt` per call) | added |
| R40 | `apiToken` | hot | 193 | `ui/server.ts:352` reads `getSnapshot().settings`, which returns `currentSettings` (`start.ts:1348-1354`), replaced on every reload (`:1732, 1735`) | added |
| R41 | `shutdown.drainTurnsMs` | hot | 193 | `start.ts:740` (read when the signal arrives) | added |
| R42 | `memorySearch.*` | hot | 193 | `runner.ts:2661` per run; the boot-time index (`start.ts:512`) uses the value at boot, which is its only use | added |
| R43 | `attachments.*` (Discord adapter) | hot | 193 | `adapters/discord/index.ts:356` (falls back to `getSettings().attachments` at message time; the bus mount passes none, `adapter-wiring.ts:199-207`). Other consumers not traced, so not claimed | added |
| R44 | `slack.appToken` under the legacy runtime | hot | 194 | `start.ts:995-1013` (`initSlack` restarts when either Slack token changes) | added |
| R45 | `telegram.receiveEnabled` under the legacy runtime | hot | 194 | `start.ts:911-920` (`startPolling`/`stopPolling`) | added |

45 rows: 39 settings added to the README's lists, 6 already listed and re-verified.

## Things found that are not README claims (not changed here)

- `.claude-plugin/marketplace.json` has a top-level `version` as well as `plugins[].version`. `scripts/bump-marketplace-version.ts` only bumps the nested one, and earlier bumps (e.g. f86d1435) edited both by hand. This is Codex round-3 finding 3; fixed here by hand (top-level `2.2.337`). The script should bump both, or the top-level field should go. Any branch that runs only the script ends up with the two out of step.
- `commands/start.md` describes the `locked` level as "Read-only" in the wizard; the code allows `Write` (`runner.ts:1505`). The README now follows the code; the wizard text was left alone.
- `runner.ts:1638` `evaluateToolForExecution` is dead code (defined, never called).
- `agents[].memory_file` is parsed and copied but unused; `system_prompt_file` is passed as text (both already listed as out of scope in #547).
- The unchanged "Drain" paragraph (`shutdown.drainTurnsMs`) was not part of the diff and was not re-audited.
