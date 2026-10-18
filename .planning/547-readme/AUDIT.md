# AUDIT: README claims vs. code (#547, PR #558)

Audited on branch `review/558` (head `7bcb673c` + this pass). `src/` on this branch is byte-identical to `povai/main` (d81bd579), so every citation is against main.

**80 claims audited, 38 fixed, 1 added, 41 confirmed as written.** Three of the fixes are the open Codex round-3 findings (tokens, `web.enabled`, marketplace version); the other fixes were found by this audit.

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
| 32 | Hot: MCP bridge tool policy + audit policy | 187 | `start.ts:1698-1703` | fixed: cite said `1717-1723`; audit policy added |
| 33 | Hot: `pty.enabled` for `runner.ts` paths | 188 | `runner.ts:740-743` (`getSettings().pty.enabled` per call), `pty-supervisor.ts:36-39` | ok |
| 34 | Hot: channel allow-lists (bus and legacy) | 189 | `allowlist.ts:23-27`, `adapter-wiring.ts:81-86, 120-135`, `start.ts:1152` (`liveSettings: () => currentSettings`) | added: real hot-reload behaviour missing from the list (#520) |
| 35 | Hot: tokens, legacy runtime only (Codex P2, round 3) | 190 | `start.ts:885-1022` (`initTelegram`/`initDiscord`/`initSlack` start, restart, stop on token change; Telegram `receiveEnabled` toggle), `:1759-1767` (called in the reload loop when `!skipLegacyAdapters`) | fixed: tokens were listed as restart-required universally |
| 36 | Restart: adapter routing | 193 | `start.ts:1791-1795` ("Bus ADAPTER changes (routing, tokens) still require a daemon restart") | ok |
| 37 | Restart: tokens under the bus runtime | 194 | same comment, `start.ts:1791-1795`; reload loop skips `initX` when `skipLegacyAdapters` | fixed: scoped to bus |
| 38 | Restart: `agents[]` and `permission_mode` | 195 | `start.ts:613` (`resolveBusAgentConfigs(settings.agents)` once at mount) | ok |
| 39 | Restart: `runtime` | 196 | `start.ts:606`, `config.ts:734-735` | fixed: cite was `606-607`; second line is inside the try |
| 40 | Restart: `web.enabled`/`web.host`/`web.port` (Codex P2, round 3) | 197 | `start.ts:535-536` (startup-only `webEnabled`/`webPort`), `:1480` (server created once), `:1737-1740` (reload only pins `enabled`/`port` to the running server) | fixed: `web.enabled` was missing from the restart list |
| 41 | Restart: `web.bus.bind` | 198 | bus adapters mounted once, `start.ts:1791-1795` | ok |
| 42 | Restart: shared MCP servers | 199 | `start.ts:1053` (multiplexer started once) | ok |
| 43 | Marketplace manifest: top-level `version` and `plugins[].version` agree (Codex P2, round 3) | `.claude-plugin/marketplace.json` 11, 25 | `jq` of the file: both `2.2.337` (plugin.json `2.2.337`); history shows every earlier bump moved both (`f86d1435` 2.2.335→2.2.336 touched both lines); `scripts/bump-marketplace-version.ts` bumps only `plugins[].version` | fixed: top-level was left at 2.2.336 |
| 44 | `/mode` toggles permission mode on legacy Telegram only | 205 | `telegram.ts:1470-1513`; no `/mode` in `discord.ts`/`slack.ts` (grep) | ok |
| 45 | Bus adapters do not implement `/mode`, `/heartbeat`, `/agents`, `/help` | 206 | `bus/core.ts:2469-2476` (hook only), `discord/index.ts:645-647` and `slack/index.ts:960` ("not yet ported"); no adapter calls `invokeSlashCommand` | fixed: wording said adapters "intercept"; cites pointed at an unrelated range |
| 46 | Dashboard URL/default; `--web` flag or `web.enabled` | 210 | `config.ts:203`, `start.ts:267-301, 535` | ok |
| 47 | Dashboard auth token at `<project>/.claude/claudeclaw/web.token` | 210 | `ui/auth.ts:10-12`; enforcement `start.ts:1482-1486` | ok |
| 48 | Bus web adapter exposes `/health`, `/prompt`, `/ws` | 212 | `adapters/webui/index.ts:215-229` | fixed: `/ws` is not GET-only in code (path match); cite added |
| 49 | `web.bind` is not a setting | 223 | `WebConfig` `config.ts:911-917` | fixed: cite `203, 911-915` → `203, 911-917` |
| 50 | Tracking-issue links #61 #546 #550 #553 exist | 233 | `gh issue view` (#61, #546 closed; #550, #553 open) | ok |
| 51 | Two runtimes, two engines | 235 | `config.ts:737`, `runner.ts:740-743` | ok |
| 52 | Bus agent turns never consult `pty.enabled` | 240 | grep: no `pty.enabled`/`settings.pty` in `src/bus` | ok |
| 53 | Declared agents get `entry.supervision ?? "pty-stdin"` | 240 | `agent-resolver.ts:74` | fixed: cite said `:73` (that is `permission_mode`) |
| 54 | Fallback to `defaultSupervisionFor(origin)` for configs without `supervision` | 240 | `session-manager.ts:812`; `types.ts:38-43, 54-56` | fixed: cite `types.ts:77-85` is the event-topic list; "undeclared spawns" reworded |
| 55 | Valid `supervision` values | 240 | `config.ts:744, 1346-1350`; `types.ts:48-52` | ok |
| 56 | `pty.enabled` scope: one decision, five call sites | 241 | `runner.ts:729-743, 959, 2070, 2727, 3091` | fixed: cites replaced; `2015` is a prompt constraint |
| 57 | Agent jobs exist only under bus; forks only under legacy Telegram | 241 | `bus/runtime-mount.ts:43, 465-471` is the only caller; `runFork` only at `telegram.ts:1446` | fixed: said "agent jobs, ... and forks under either runtime" |
| 58 | Dashboard chat under bus: `streamBusPrompt`; falls back to runner without an agent | 241 | `start.ts:1415-1438`, fallback `:1439` | fixed: cite `1415-1439` hid the fallback; caveat added |
| 59 | Defaults: `pty.enabled` false; #550 flips it | 242 | `config.ts:221-225`; #550 OPEN | ok |
| 60 | Runtime switch needs a restart; runtimes share no IPC/state | 243 | `start.ts:606`, `config.ts:734-735` | ok |
| 61 | Matrix row 1: bus, `pty.enabled` false | 249 | `config.ts:285` (runtime default `bus`), `:225`; `runner.ts:959, 2070`; `job-loop.ts:1-9` | fixed: `(process-stream-json)` label (a bus SupervisionMode) removed from runner paths; "forks" removed (legacy Telegram only) |
| 62 | Matrix row 2: bus, `pty.enabled` true | 250 | `runner.ts:729-743, 959, 2070` | fixed: same label/forks fix |
| 63 | Matrix row 3: pty runtime, false | 251 | `start.ts:1439`, `runner.ts:2727, 3091` | fixed: "agent job" removed (bus only); cites `start.ts:1432-1438` were inside the bus branch |
| 64 | Matrix row 4: pty runtime, true | 252 | `runner.ts:729-743, 2070, 2727, 3091` | fixed: same |
| 65 | When to pick `claude -p`: audit, cost ceilings, stateless | 256 | qualitative guidance (no code claim); consistent with `job-loop.ts:4-6` one-shot per job | ok |
| 66 | When to pick PTY/Bus: multi-channel routing with origin-aware replies | 264 | `bus/types.ts:23-31` (origins), `bus/core.ts:113, 152-177` (`origin_id` carried on replies) | ok |
| 67 | Per-agent supervision: dirs and system prompts (not memory files) | 265 | `memory_file` unused (see Per-agent isolation row) | fixed: "and memory files" removed |
| 68 | `pty.enabled` hot-reload note | 280 | `runner.ts:740-743`, `pty-supervisor.ts:36-39`, `start.ts:606` | ok |
| 69 | `pty` settings block shows the defaults | 273 | `config.ts:221-237` | ok |
| 70 | Multiplexer needs `mcp.shared` non-empty AND persisted `web.enabled`; `--web` alone is not enough | 295 | `start.ts:1053` (gate), `:1111-1120` (warning branch), `:1480-1481`; routes mounted by `ui/server.ts:257-267` | fixed: cite `1111-1120` was the warning, not route registration; added the `mcp.shared` condition |
| 71 | Policy engine: where it is consulted | 353 | `bus/core.ts:3369-3393, 3820-3832`, `gateway/index.ts:233-244`, `orchestrator/executor.ts:133-139`; `runner.ts:1638` `evaluateToolForExecution` is never called | fixed: said "legacy runner only" (`runner.ts:39-62` are governance imports); the bus gate does consult it, the runner helper is dead code |
| 72 | Policy engine "Why" line | 357 | same | fixed: "for legacy runner invocations" was wrong; "Every tool call is evaluated" (unchanged text) corrected to "requests that reach the engine" |
| 73 | Governance layer wired into `runner.ts`, not bus | 365 | `runner.ts:36-62`; no governance reference under `src/bus`/`src/adapters`; `start.ts:454-482` configures the watchdog at startup | fixed: cite `39-62` → `36-62`; watchdog startup config noted |
| 74 | Gateway/escalation are legacy-adapter, opt-in | 377 | `telegram.ts:31, 1741-1742`, `discord.ts:1333` (`USE_GATEWAY_*` flags); importers of `escalation`: gateway, event-processor, runner watchdog, orchestrator; none under bus | fixed: opt-in env flags were not mentioned |
| 75 | Orchestrator is an engine with one live wiring (startup resume); restart handling | 389 | `executor.ts:83-95, 155-193`; `resumable-jobs.ts:174-215, 246-290`; `workflow-state.ts:282-314`; repo-wide grep of callers | fixed: said it "operates on the legacy runner.ts pipeline"; it does not |
| 76 | Orchestrator body: atomic writes, resume across restarts | 391 | `workflow-state.ts:56-72` (temp file + rename; the code notes it is atomic but not fsync-durable, which matches the README wording); resume `executor.ts:378-411` | ok |
| 77 | Memory note: persistence is runner-path; `memory_file` unused | 411 | `runner.ts:1945-1949, 1990-1997, 2490-2500`; `config.ts:1434`, `agent-resolver.ts:77` | fixed: said bus agents use `memory_file`; cite `runner.ts:69` was an import line |
| 78 | Memory body: pre-compact, pre-shutdown, 200-line cap, per-agent paths | 413 | `runner.ts:2544-2570`; `stop.ts:36-84` (global session only, CLI side); `runner.ts:2514`, `prompts/MEMORY_INSTRUCTIONS.md:42`; `memory.ts:40-45` | fixed: unchanged sentence overstated; conditions added |
| 79 | Security Levels bullet: `locked`/`strict`/`moderate`/`unrestricted`, legacy runner | 447 | `config.ts:454, 989`, `runner.ts:1501-1522` | ok |
| 80 | Removed dead links `.planning/pty-migration/SPEC.md`, `.planning/mcp-multiplexer/SPEC.md` | 284 | `ls`: neither file exists; remaining references resolve (link check) | ok |

## Things found that are not README claims (not changed here)

- `.claude-plugin/marketplace.json` has a top-level `version` as well as `plugins[].version`. `scripts/bump-marketplace-version.ts` only bumps the nested one, and earlier bumps (e.g. f86d1435) edited both by hand. This is Codex round-3 finding 3; fixed here by hand (top-level `2.2.337`). The script should bump both, or the top-level field should go. Any branch that runs only the script ends up with the two out of step.
- `commands/start.md` describes the `locked` level as "Read-only" in the wizard; the code allows `Write` (`runner.ts:1505`). The README now follows the code; the wizard text was left alone.
- `runner.ts:1638` `evaluateToolForExecution` is dead code (defined, never called).
- `agents[].memory_file` is parsed and copied but unused; `system_prompt_file` is passed as text (both already listed as out of scope in #547).
- The unchanged "Drain" paragraph (`shutdown.drainTurnsMs`) was not part of the diff and was not re-audited.
