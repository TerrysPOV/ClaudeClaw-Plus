# SPEC: Fix README Contradictions and Accuracy (#547, #553)

## Problem

The README describes the legacy `runtime: "pty"` path in several places as if it applied to the default `bus` runtime, and multiple claims contradict the code (as analyzed in issue #547 and tracking issue #553). Specifically:
1. Execution modes: `runtime: "pty"` was described as `claude -p` only, but with `pty.enabled: true` it runs the interactive PTY supervisor. The bus runtime has its own `claude -p` mode (`agents[].supervision: "process-stream-json"`). Following PR #556 / #546, rate-limit fallback, dashboard chat, forks, and bus agent jobs follow `pty.enabled`. Cron jobs run through `run()` under every runtime. Changing `runtime` requires a daemon restart.
2. Billing: The claim "The Agent SDK credit pool stays untouched" is not true today because cron jobs and agent jobs run as `claude -p` under every runtime. Claims about billing pools must not exceed public Anthropic documentation.
3. Security under bus: Bus agents run with `bypassPermissions` by default and `security.level` does not restrict them (it is enforced in legacy runner and prompt assembly). The security level names are `locked` (not `read-only`), `strict`, `moderate`, and `unrestricted`.
4. Hot reload: Adapter routing (`discord.busRouting`, `telegram.busRouting`, `slack.busRouting`, `web.bus`), `agents[]`, `mcp.*` (except bridge tool policy), permission mode, and `runtime` require a daemon restart.
5. Settings path: Settings file is at `<project>/.claude/claudeclaw/settings.json`, not `~/.claude/claudeclaw/settings.json`.
6. Web UI: The dashboard (`web.host:web.port`, default `127.0.0.1:4632`, `--web` or `web.enabled`, token in `.claude/claudeclaw/web.token`) is distinct from the bus web adapter (`web.bus.bind`, default `127.0.0.1:7878`, `/health`, `/prompt`, `/ws`). `web.bind` does not exist in settings.
7. Slash commands: `/heartbeat`, `/agents`, `/help` are not implemented. `/mode` is legacy Telegram only. Under the bus runtime, adapters handle no slash commands.
8. Model and fallback: Default `model` and `fallback.model` are empty strings `""` in code. In the setup wizard, default model offered is `opus` (with `glm`, `sonnet`, `haiku` options). Fallback kicks in on rate-limit only and has no effect on bus agents. Kimi goes through `https://api.kimi.com/coding/` (not OpenRouter).
9. First start: The plugin name is `claudeclaw-plus` (`.claude-plugin/plugin.json`), so the start command is `/claudeclaw-plus:start`. Discord under bus requires `busRouting`. An empty `allowedUserIds` list refuses everyone (issue #519).
10. Orchestrator, memory, gateway: Remove "survive restarts" claim for orchestrator workflows. Memory, governance, and gateway run on the `runner.ts` / legacy path only. Dead links: `.planning/pty-migration/SPEC.md` and `.planning/mcp-multiplexer/SPEC.md` must be removed or fixed. Note that MCP multiplexer requires `web.enabled: true`.

## Current Behaviour (file:line)

- Execution modes & pty.enabled:
  - `src/runner.ts:740-743`: `resolveAgentTurnRoute` resolves engine based on `pty.enabled`.
  - `src/bus/types.ts:48-56`: Bus supervision modes (`pty-stdin`, `process-stream-json`, `tmux`, `process`). Default for non-channel is `process-stream-json`.
  - `src/job-loop.ts:4-8`: Cron jobs run through `run()` under every runtime.
  - `src/config.ts:734-735`, `src/commands/start.ts:606`: Runtime switch happens at daemon startup.
- Billing:
  - `src/job-loop.ts:4-8`, `src/runner.ts:865`: Jobs invoke `claude -p` via `run()` or one-shot PTY.
- Security under bus:
  - `src/config.ts:454`: `SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted"`.
  - `src/bus/agent-resolver.ts:73`, `src/bus/session-manager.ts:686-697`: Bus agents default to `bypassPermissions`.
  - `src/runner.ts:1501, 1512, 1999`: `security.level` enforces tools in legacy runner path.
- Hot reload:
  - `src/commands/start.ts:1706-1795`: Hot reload loop every 30s only updates heartbeat, jobs, tool policy, security level. Adapter routing and agent declarations require restart.
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
  - `src/runner.ts:643-644`: `kimi-k2p6` rewrites `ANTHROPIC_BASE_URL` to `https://api.kimi.com/coding/`.
  - `src/runner.ts:2131-2135`: Fallback triggers on rate-limit only and is in `runner.ts` (legacy / PTY turn path), not bus.
- First start:
  - `.claude-plugin/plugin.json:2`: `"name": "claudeclaw-plus"`. Command is `/claudeclaw-plus:start`.
  - `src/allowlist.ts`, `src/adapters/discord/index.ts:247`: Empty `allowedUserIds` refuses everyone.
  - `src/adapters/discord/index.ts:266-270`: Discord under bus requires `busRouting`.
- Links, orchestrator, memory, gateway:
  - `.planning/pty-migration/SPEC.md` and `.planning/mcp-multiplexer/SPEC.md` do not exist.
  - `src/commands/start.ts:1053, 1111-1120`: MCP multiplexer requires `web.enabled: true`.
  - `src/runner.ts:39-69`: Governance and memory are wired into `runner.ts`.

## Target Behaviour

Update `README.md` to:
1. Replace lines 223-262 with an "Execution modes" table (`runtime` × `pty.enabled` × `supervision` × cron/agent jobs, with what actually runs and whether restart is needed).
2. State the engine policy of the PTY migration (#553): PTY is the official engine; `claude -p` stays a supported option (`pty.enabled: false`, `supervision: "process-stream-json"`). Keep enterprise/API-billing rationale for `-p`, reworded as an option rather than default. Describe current default (`pty.enabled: false`) and state that a future release (#550) flips defaults.
3. Fix items 2-10 in place:
   - Billing: Remove unsubstantiated credit pool claims. Note that cron and agent jobs run as `claude -p` under both runtimes today.
   - Security under bus: Accurately state that bus agents run with `bypassPermissions` by default and `security.level` does not restrict bus agents. Fix security level names (`locked` instead of `read-only`).
   - Hot reload: Accurately list restart-required changes vs hot-reloadable changes.
   - Settings path: Correct to `<project>/.claude/claudeclaw/settings.json`.
   - Web UI: Distinguish dashboard (`web.host:web.port`, default `127.0.0.1:4632`, token in `.claude/claudeclaw/web.token`) from bus web adapter (`web.bus.bind`, default `127.0.0.1:7878`). Note `web.bind` does not exist.
   - Slash commands: Accurately document slash commands (note `/mode` is legacy Telegram only; `/heartbeat`, `/agents`, `/help` are not implemented; bus adapters do not handle slash commands).
   - Model and fallback: Document defaults (`""`), wizard choices (opus/GLM/sonnet/haiku), Kimi URL (`https://api.kimi.com/coding/`), and that fallback triggers on rate-limit only and does not affect bus agents.
   - First start: Command is `/claudeclaw-plus:start`, Discord under bus needs `busRouting`, empty `allowedUserIds` refuses everyone.
   - Orchestrator, memory, gateway: Remove "survive restarts" claim for orchestrator workflows. Clarify that memory, governance, and gateway run on the `runner.ts` path only. Remove dead `.planning/*` links. Note multiplexer requires `web.enabled: true`.
4. Ensure all internal links resolve.
5. Pass `bun run lint` and maintain typescript typecheck ratchet.

## Frozen Decisions

1. Scope: Documentation changes only (`README.md`, `.planning/547-readme/*`). No source code changes.
2. Engine policy (#553): Explicitly document that PTY is the official engine; `claude -p` remains a supported option. State that currently `pty.enabled` defaults to `false` and issue #550 will flip the default to `true`.
3. Anthropic billing: Strictly follow public Anthropic documentation; do not assert private pool behavior.

## Key Files

- `README.md`
- `.planning/547-readme/SPEC.md`
- `.planning/547-readme/REPORT.md`

## Out of Scope

- Migration guide (`claude -p` -> PTY and back), which is tracked for #550.
- Source code bug fixes observed during audit (e.g. `system_prompt_file` handling, unused config comments).
