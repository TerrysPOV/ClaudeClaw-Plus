# SPEC: Fix README Contradictions and Accuracy (#547, #553)

## Problem

The README describes the legacy `runtime: "pty"` path in several places as if it applied to the default `bus` runtime, and multiple claims contradict the code (as analyzed in issue #547 and tracking issue #553). Specifically:
1. Execution modes: `runtime: "pty"` was described as `claude -p` only, but with `pty.enabled: true` it runs the interactive PTY supervisor. The bus runtime has its own `claude -p` mode (`agents[].supervision: "process-stream-json"`). Following PR #556 / #546, rate-limit fallback, forks, and bus agent jobs follow `pty.enabled`. Cron jobs run through `run()` under every runtime. Dashboard chat under the bus runtime routes to the default bus agent via `streamBusPrompt()` and does not follow `pty.enabled`. Switching `runtime` requires a daemon restart, but `pty.enabled` hot-reloads within ~30s.
2. Billing: The claim "The Agent SDK credit pool stays untouched" is not true today because cron jobs and agent jobs run as `claude -p` under every runtime. Claims about billing pools must not exceed public Anthropic documentation.
3. Security under bus: Bus agents run with `bypassPermissions` by default and `security.level` does not restrict them (it is enforced in legacy runner and prompt assembly). The security level names are `locked` (not `read-only`), `strict`, `moderate`, and `unrestricted`.
4. Hot reload: Adapter routing (`discord.busRouting`, `telegram.busRouting`, `slack.busRouting`, `web.bus`), `agents[]`, `mcp.*` (except bridge tool policy), permission mode, and switching `runtime` require a daemon restart. `pty.enabled` is hot-reload-safe.
5. Settings path: Settings file is at `<project>/.claude/claudeclaw/settings.json`, not `~/.claude/claudeclaw/settings.json`.
6. Web UI: The dashboard (`web.host:web.port`, default `127.0.0.1:4632`, `--web` or `web.enabled`, token in `.claude/claudeclaw/web.token`) is distinct from the bus web adapter (`web.bus.bind`, default `127.0.0.1:7878`, `/health`, `/prompt`, `/ws`). `web.bind` does not exist in settings.
7. Slash commands: `/heartbeat`, `/agents`, `/help` are not implemented. `/mode` is legacy Telegram only. Under the bus runtime, adapters handle no slash commands.
8. Model and fallback: Default `model` and `fallback.model` are empty strings `""` in code. In the setup wizard, default model offered is `opus` (with `glm`, `sonnet`, `haiku` options). Fallback kicks in on rate-limit text patterns in output (`you've hit your limit`, `out of extra usage`) only and has no effect on bus agents. Kimi goes through `https://api.kimi.com/coding/` (not OpenRouter).
9. First start: The plugin name is `claudeclaw-plus` (`.claude-plugin/plugin.json`), so the start command is `/claudeclaw-plus:start`. Discord under bus requires `busRouting` (at least one of `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent`; `guilds` is not supported). An empty `allowedUserIds` list refuses everyone unless `allowAllUsers: true` is configured for a public bot.
10. Orchestrator, memory, gateway, MCP: Accurately specify orchestrator restart recovery (workflows are resumed on daemon startup under both runtimes via `initializeJobSystem()`, with interrupted tasks reclassified per retry policy). Memory, governance, and gateway run on the `runner.ts` / legacy path only. Dead links: `.planning/pty-migration/SPEC.md` and `.planning/mcp-multiplexer/SPEC.md` must be removed or fixed. Note that MCP multiplexer requires `web.enabled: true` in `settings.json` (`--web` CLI flag alone is insufficient because startup evaluates settings before reconciling flags).

## Current Behaviour (file:line)

- Execution modes & pty.enabled:
  - `src/runner.ts:732-742, 2015, 2070`: `resolveAgentTurnRoute` resolves engine based on `pty.enabled` for runner.ts paths (agent turns under legacy pty runtime, cron jobs, agent jobs, rate-limit fallback, and dashboard chat under legacy runtime, forks).
  - `src/commands/start.ts:1415-1439`: Dashboard chat under bus runtime routes to default bus agent via `streamBusPrompt()`. Only under `runtime: "pty"` does it fall back to `runner.ts` (`src/commands/start.ts:1432-1438`).
  - `src/runner/pty-supervisor.ts:36-39, 567, 909, 1124`, `src/runner.ts:742`: `pty.enabled` is read per invocation and is hot-reload-safe (~30s polling).
  - `src/bus/agent-resolver.ts:73`: Declared bus agents get `entry.supervision ?? "pty-stdin"`.
  - `src/bus/types.ts:48-56, 77-85`: Real `SupervisionMode` values are `pty-stdin`, `process-stream-json`, `tmux`, and `process`. Undeclared spawns fall back to `defaultSupervisionFor(origin)` (`pty-stdin` for channels, `process-stream-json` for others). Bus supervision does not consult `pty.enabled`.
  - `src/runner.ts:2690`, `src/job-loop.ts:21-30`: Cron jobs run through `runner.run()`, which routes through `execClaude` and follows `pty.enabled`. Note stale comment in `src/job-loop.ts:1-8`.
  - `src/config.ts:734-735`, `src/commands/start.ts:606-607`: Switching `runtime` between `"bus"` and `"pty"` requires daemon restart.
- Billing:
  - `src/job-loop.ts:4-8`, `src/runner.ts:865`: Jobs invoke `claude -p` via `run()` or one-shot PTY.
- Security under bus:
  - `src/config.ts:454`: `SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted"`.
  - `src/bus/agent-resolver.ts:73`, `src/bus/session-manager.ts:686-697`: Bus agents default to `bypassPermissions`.
  - `src/runner.ts:1501, 1512, 1999`: `security.level` enforces tools in legacy runner path.
- Hot reload:
  - `src/commands/start.ts:1706-1795`: Hot reload loop every 30s updates heartbeat, jobs, tool policy, security level, and reloads settings for `pty.enabled`. Adapter routing, agent declarations, and runtime switching require restart.
- Settings path:
  - `src/config.ts:23-24`: `HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw")`, `DEFAULT_SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json")`.
- Web UI:
  - `src/config.ts:203`: `web: { enabled: false, host: "127.0.0.1", port: 4632 }`.
  - `src/ui/auth.ts:11`: `.claude/claudeclaw/web.token`.
  - `src/adapters/webui/index.ts:66, 495`: Web UI bus adapter binds to `web.bus.bind` (default `127.0.0.1:7878`).
- Slash commands:
  - `src/commands/telegram.ts:1470`: `/mode` is only implemented in legacy Telegram.
  - `src/bus/core.ts:2470-2475`: Bus adapters do not implement slash commands directly.
- Model and fallback:
  - `src/config.ts:86, 89`: `model: ""`, `fallback: { model: "", api: "" }`.
  - `src/runner.ts:400, 586-593`: `RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;`.
  - `src/runner.ts:643-644`: `kimi-k2p6` rewrites `ANTHROPIC_BASE_URL` to `https://api.kimi.com/coding/`.
  - `src/runner.ts:2131-2135`: Fallback triggers on rate-limit text patterns only and is in `runner.ts` (legacy / PTY turn path), not bus.
- First start:
  - `.claude-plugin/plugin.json:2`: `"name": "claudeclaw-plus"`. Command is `/claudeclaw-plus:start`.
  - `src/allowlist.ts`, `src/adapters/discord/index.ts:247`: Empty `allowedUserIds` refuses everyone unless `allowAllUsers: true`.
  - `src/config.ts:1568-1591`, `src/bus/adapter-wiring.ts:197`, `src/adapters/discord/index.ts:266-270`: Discord under bus requires `busRouting` (at least one of `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent`; ignores `guilds`).
- Links, orchestrator, memory, gateway, MCP:
  - `.planning/pty-migration/SPEC.md` and `.planning/mcp-multiplexer/SPEC.md` do not exist.
  - `src/commands/start.ts:527-528`, `src/orchestrator/resumable-jobs.ts:174-210`, `src/orchestrator/workflow-state.ts:282-315`: On daemon startup under both runtimes, `initializeJobSystem()` resumes pending workflows, reclassifying interrupted tasks per `maxRetries`.
  - `src/commands/start.ts:1053, 1111-1120, 1481`: MCP multiplexer requires `web.enabled: true` in `settings.json` (`--web` CLI flag alone is insufficient because startup evaluates settings before reconciling flags).
  - `src/runner.ts:39-69`: Governance and memory are wired into `runner.ts`.

## Target Behaviour

Update `README.md` to:
1. Replace lines 223-262 with an "Execution modes" table (`runtime` × `pty.enabled` × `supervision` × cron/agent jobs/dashboard chat, with what actually runs and whether restart is needed).
2. State the engine policy of the PTY migration (#553): PTY is the official engine; `claude -p` stays a supported option (`pty.enabled: false`, `supervision: "process-stream-json"`). Keep enterprise/API-billing rationale for `-p`, reworded as an option rather than default. Describe current default (`pty.enabled: false`) and state that a future release (#550) flips defaults.
3. Fix items 2-10 in place:
   - Billing: Remove unsubstantiated credit pool claims. Note that cron and agent jobs route through runner.ts and follow pty.enabled (claude -p under current default pty.enabled: false, PTY supervisor when pty.enabled: true).
   - Security under bus: Accurately state that bus agents run with `bypassPermissions` by default and `security.level` does not restrict bus agents. Fix security level names (`locked` instead of `read-only`).
   - Hot reload: Accurately list restart-required changes (switching runtime, adapters, agents, tokens, bind addresses) vs hot-reloadable changes (`pty.enabled`, heartbeat, jobs, tool policy, security level).
   - Settings path: Correct to `<project>/.claude/claudeclaw/settings.json`.
   - Web UI: Distinguish dashboard (`web.host:web.port`, default `127.0.0.1:4632`, token in `.claude/claudeclaw/web.token`) from bus web adapter (`web.bus.bind`, default `127.0.0.1:7878`). Note `web.bind` does not exist.
   - Slash commands: Accurately document slash commands (note `/mode` is legacy Telegram only; `/heartbeat`, `/agents`, `/help` are not implemented; bus adapters do not handle slash commands).
   - Model and fallback: Document defaults (`""`), wizard choices (opus/GLM/sonnet/haiku), Kimi URL (`https://api.kimi.com/coding/`), and that fallback triggers on rate-limit text patterns in output only and does not affect bus agents.
   - First start: Command is `/claudeclaw-plus:start`, Discord under bus needs `busRouting` (at least one of `channels`, `threads`, `dmAgentId`, `primaryChannelByAgent`), empty `allowedUserIds` refuses everyone unless `allowAllUsers: true`.
   - Orchestrator, memory, gateway, MCP: Accurately document orchestrator restart recovery (resuming pending jobs on startup via `initializeJobSystem()`, retrying interrupted tasks per retry budget). Clarify that memory, governance, and gateway run on the `runner.ts` path only. Remove dead `.planning/*` links. Note multiplexer requires `web.enabled: true` in `settings.json`.
4. Ensure all internal links resolve.
5. Pass `bun run lint` and maintain typescript typecheck ratchet.

## Frozen Decisions

1. Scope: Documentation changes only (`README.md`, `.planning/547-readme/*`). No source code changes.
2. Engine policy (#553): Explicitly document that PTY is the official engine; `claude -p` remains a supported option. State that currently `pty.enabled` defaults to `false` and issue #550 will flip the default to `true`.
3. Anthropic billing: Strictly follow public Anthropic documentation; do not assert private pool behavior.

### Added in round 3 (code wins over the issue text)

- **Orchestrator wording:** the README says the DAG engine exists and resumes persisted workflows at startup, and that no job path submits workflows to it. The issue item 10 says "run on the runner.ts path only"; that is not what the code does.
- **Policy engine wording:** lists the three places that consult it (bus permission gate, gateway, orchestrator) instead of "legacy runner".
- **Hot reload is described per setting and per runtime**, from what the 30 s loop in `start.ts` actually re-applies; tokens are the case that differs by runtime. Allow-lists are included because they do hot-reload.
- **Matrix columns** list only the paths that exist under each runtime (agent jobs: bus; dashboard chat and forks: legacy).
- **`locked`** is described by its tool list, not as read-only, even though the wizard text says "Read-only".
- **`marketplace.json`:** both version fields are set by hand to match; fixing `scripts/bump-marketplace-version.ts` is out of scope here.

### Added in round 4

- **The reload contract is complete by construction, not by patching.** Every key of the `Settings` interface is classified as read-once (restart) or read-on-use (hot), with a per-setting row in AUDIT.md. A script checks that all top-level keys are named in the two README lists.
- **`slack.appToken` is listed as restart-bound with a qualification**, because applying it requires a restart but the bus Slack adapter does not use it yet. Codex's stale-connection scenario does not occur on the bus.
- **"Read once" includes first use** (`agentic.*` router, the PTY reaper), not only startup.
- **Options a runtime does not take are called out as such**, not listed as restart-bound: the bus adapters ignore the legacy-only Telegram/Discord/Slack options.

## Key Files

- `README.md`
- `.planning/547-readme/SPEC.md`
- `.planning/547-readme/REPORT.md`

## Out of Scope

- Migration guide (`claude -p` -> PTY and back), which is tracked for #550.
- Source code bug fixes observed during audit (e.g. `system_prompt_file` handling, unused config comments).
