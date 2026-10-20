---
description: Start daemon mode or run one-shot prompt/trigger
---

Start the heartbeat daemon for this project. Follow these steps exactly:

1. **Block home-directory starts (CRITICAL, BLOCKER)**:
   - Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP immediately.
   - Tell the user exactly:
     - "CRITICAL BLOCKER: For security reasons, close this session and start a new one from the folder you want to initialize ClaudeClaw in."
   - Do not continue with any other step until they restart from a non-home project directory.

2. **Runtime checker (Bun + Node)**:
   - Run:
     ```bash
     which bun
     which node
     ```
   - If `bun` is missing:
     - Tell the user Bun is required and will be auto-installed.
     - Run:
       ```bash
       curl -fsSL https://bun.sh/install | bash
       ```
     - Then source the shell profile to make `bun` available in the current session:
       ```bash
       source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
       ```
     - Verify again with `which bun`. If still not found, tell the user installation failed and to install manually from https://bun.sh, then exit.
     - Tell the user Bun was auto-installed successfully.
   - If `node` is missing:
     - Tell the user Node.js is required for the OGG converter helper.
     - Ask them to install Node.js LTS and rerun start, then exit.

3. **Check existing config**: Read `.claude/claudeclaw/settings.json` (if it exists). Determine which sections are already configured:
   - **Heartbeat configured** = `heartbeat.enabled` is `true` AND `heartbeat.prompt` is non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Discord configured** = `discord.token` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty
   - **Permissions configured** = `.claude/claudeclaw/permission-mode.json` exists. (This is the marker the wizard writes when the operator opts out of headless. Per-agent `permission_mode` overrides in `settings.agents` are independent operator-driven overrides — they do NOT count as "wizard configured" because they can be set without the wizard ever running, and the empty-agents first-setup state would otherwise be vacuously "configured" and the question would be skipped.)

4. **Interactive setup — smart mode** (BEFORE launching the daemon):

   **If ALL three sections are already configured**, show a summary of the current config and ask ONE question:

   Use AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 5a (orphan detection still runs — it's the most likely failure on re-runs of an existing setup) and then on to step 6.
   If they choose "Reconfigure", proceed to step 5 below as if nothing was configured.

   **If SOME sections are configured and others are not**, show the already-configured sections as a summary, then only ask about the unconfigured sections in step 5.

   **If NOTHING is configured** (fresh install), ask about all three sections in step 5.

5. **Ask setup questions**:

   Use **AskUserQuestion** to ask all unconfigured sections at once (up to 3 questions in one call):

   - **Model** (always ask if `model` is empty/unset): "Which Claude model should ClaudeClaw use?" (header: "Model", options: "opus (default)", "sonnet", "haiku", "glm")
   - **If heartbeat is NOT configured**: "Enable heartbeat? Example: I can remind you to drink water every 30 minutes, or you can fully customize what runs." (header: "Heartbeat", options: "Yes" / "No")
   - **If Telegram is NOT configured**: "Configure Telegram? Recommended if you want it 24/7 live." (header: "Telegram", options: "Yes" / "No")
   - **If Discord is NOT configured**: "Configure Discord? Connect your bot to Discord servers." (header: "Discord", options: "Yes" / "No")
   - **If security is NOT configured**: "What security level for Claude?" (header: "Security", options:
     - "Moderate (Recommended)" (description: "Full access scoped to project directory")
     - "Locked" (description: "Read-only — can only search and read files, no edits, bash, or web")
     - "Strict" (description: "Can edit files but no bash or web access")
     - "Unrestricted" (description: "Full access with no directory restriction — dangerous"))
   - **If permissions are NOT configured**: "Headless agents — should Claude run tool calls without asking for permission per call?" (header: "Permissions", options:
     - "Yes — headless (Recommended)" (description: "Tools execute without prompts. Security is enforced via the security level + project-directory scoping. This matches the legacy `claude -p` daemon behaviour.")
     - "No — confirm each Bash/Write call" (description: "Permission requests appear on the originating channel (Discord button, Telegram inline keyboard, Slack block) and the turn blocks until you click Allow/Deny."))

   Then, based on their answers:

   - **Model**: Set `model` in settings to their choice (e.g. `"opus"`, `"sonnet"`, `"haiku"`, `"glm"`). Default is `"opus"` if they don't pick.
   - **If model is `glm`**: Ask in normal free-form text for API token and set top-level `api` to that value (optional; user can skip). Only ask this token question when the selected model is `glm`.

   - **Agentic mode**: Use AskUserQuestion to ask:
     - "Enable agentic model routing? This automatically selects models based on task type using configurable modes." (header: "Agentic", options: "Yes — default modes (Recommended)", "No — use single model")
     - If "Yes": Set `agentic.enabled` to `true` with default modes (planning→opus, implementation→sonnet). The user can customize modes later via `/config`.
     - If "No": Set `agentic.enabled` to `false`.
   - Ask whether to set a fallback model. Recommend `glm` first so fallback uses a different provider path than the primary Claude model. If yes, set `fallback.model` and optionally `fallback.api`.
   - Ask whether to enable GLM fallback (kicks in automatically when your Claude token limit is hit). The fallback model is always `glm` — no other model is supported. Use AskUserQuestion: "Enable GLM fallback? Automatically switches to GLM when your Claude limit is hit." (header: "Fallback", options: "Yes — enable GLM fallback", "Skip"). If yes, ask in normal free-form text for the GLM API token (optional, user can skip). Set `fallback.model` to `"glm"` and `fallback.api` to the token if provided.

   - **If yes to heartbeat**: Use AskUserQuestion again with one question:
     - "How often should it run in minutes?" (header: "Interval", options: "5", "15", "30 (Recommended)", "60")
     - Set `heartbeat.enabled` to `true` and `heartbeat.interval` to their answer.
     - Ask for timezone as simple UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`) and set top-level `timezone`.
   - **If heartbeat is no but `timezone` is missing**: set top-level `timezone` to `UTC+0`.

   - **If yes to Telegram**: Do NOT use AskUserQuestion for Telegram fields. Ask in normal free-form text for two values (both optional, user can skip either):
     - Telegram bot token (hint: create/get it from `@BotFather`)
     - Allowed Telegram user IDs (hint: use `@userinfobot` to get your numeric ID)
     - Set `telegram.token` and `telegram.allowedUserIds` (as array of numbers) accordingly.
     - Note: Telegram bot runs in-process with the daemon. All components (heartbeat, cron, telegram, discord) share one Claude session.

   - **If yes to Discord**: Do NOT use AskUserQuestion for Discord fields. Ask in normal free-form text for two values (both optional, user can skip either):
     - Discord bot token (hint: create a bot at https://discord.com/developers/applications → Bot → Token. Enable **Message Content Intent** under Privileged Gateway Intents.)
     - Allowed Discord user IDs (hint: enable Developer Mode in Discord settings → right-click your profile → Copy User ID). These are large numbers — they will be stored as strings.
     - Set `discord.token` and `discord.allowedUserIds` (as array of strings) accordingly.
     - Listen channel IDs (optional — hint: right-click a channel in Discord with Developer Mode enabled → Copy Channel ID). Channels where the bot responds to all messages without requiring an @mention.
     - Set `discord.listenChannels` (as array of strings) accordingly.
     - Note: Discord bot connects via WebSocket gateway in-process with the daemon. It supports DMs, guild mentions/replies, slash commands (/start, /reset), voice messages, and image attachments. `discord.allowedUserIds` is an allowlist that applies to messages, slash commands, and button interactions.

   - **Security level mapping** — set `security.level` in settings based on their choice:
     - "Locked" → `"locked"`
     - "Strict" → `"strict"`
     - "Moderate" → `"moderate"`
     - "Unrestricted" → `"unrestricted"`

   - **If security is "Strict" or "Locked"**: Use AskUserQuestion to ask:
     - "Allow any specific tools on top of the security level? (e.g. Bash(git:*) to allow only git commands)" (header: "Allow tools", options: "None — use level defaults (Recommended)", "Bash(git:*) — git only", "Bash(git:*) Bash(npm:*) — git + npm")
     - If they pick an option with tools or type custom ones, set `security.allowedTools` to the list.

   - **Permission mode mapping** — apply the headless answer to settings:
     - "Yes — headless (Recommended)" → DO NOTHING. The bus resolver default (`bypassPermissions`) and the legacy `permission-mode.json` absence both already deliver headless behaviour. No explicit write is needed.
     - "No — confirm each Bash/Write call" → write `.claude/claudeclaw/permission-mode.json` with `{"mode": "plan"}` (the legacy `claude -p` runner reads this). AND, for each existing entry in `settings.agents` (if any), set the agent's `permission_mode` to `"plan"` so the bus runtime picks it up per-agent. If `settings.agents` is empty, only the legacy file needs writing — bus agents added later will need a manual `permission_mode` field (this is intentional; bus agents are explicit per-agent configs).

   Update `.claude/claudeclaw/settings.json` with their answers.

5a. **Detect orphan agent directories** (issue #167):

   The bus runtime only spawns processes for agents declared in `settings.agents[]`. If an `agents/<name>/` directory has scheduled jobs but `<name>` is not declared, the scheduler fires prompts to the bus with `agent_id: <name>` and they sit `status: "pending"` forever — silent job death. The daemon warns at startup (PR #168), but the wizard can offer to fix it inline.

   Run this scan (only counts `.md` files — matches what the daemon's loader and the orphan-detect warning treat as a "job"; see `src/bus/orphan-agent-detect.ts` + `src/jobs.ts:loadJobs`). Uses `ls -A | grep` so dot-prefixed `.md` files (e.g. `.draft.md`) are counted to match the daemon's `endsWith(".md")` check, but `.swp`/`.bak` editor files are excluded by the regex anchor:
   ```bash
   for d in agents/*/; do
     name=$(basename "$d")
     job_count=$(ls -1A "${d}jobs/" 2>/dev/null | grep -cE '\.md$' | tr -d ' ')
     [ "$job_count" -gt 0 ] && echo "${name}:${job_count}"
   done
   ```

   Read `.claude/claudeclaw/settings.json` and parse `settings.agents[].id` (treat missing/empty as `[]`). For each `<name>:<count>` from the scan, if `<name>` is NOT in the declared id list, it's an orphan candidate.

   **Validate each orphan candidate against the bus agent id regex** `^[a-z0-9][a-z0-9_-]{0,35}$` (the same pattern `src/config.ts:1044` rejects with; an invalid id would be silently skipped by the runtime, so adding it to settings.agents accomplishes nothing). Split candidates into two buckets:
   - **Valid orphans** — eligible to add via the AskUserQuestion below.
   - **Invalid orphans** — surface a single warning to the user listing each invalid dir name + why (uppercase / special char / too long / starts with dash or underscore) and instructing them to rename the directory before re-running the wizard. Do NOT offer to add these.

   **If no valid orphans found**, proceed to step 6 (after the invalid-name warning if any).

   **If valid orphans found**, show the list and use AskUserQuestion:
   - Question: "Found agent directories on disk with jobs but not declared in settings.agents. The bus runtime won't spawn them, so their scheduled jobs will silently fail. Add them?"
   - Header: "Orphan agents"
   - Options:
     - "Yes — add (Recommended)" (description: "Adds `{ id: <name> }` per orphan, mirroring step 5's permission-mode rule: nothing written for headless (resolver default applies), `permission_mode: \"plan\"` written if the headless answer was \"No — confirm each Bash/Write call\".")
     - "No — leave as-is" (description: "Jobs for the orphan agent(s) will continue to silently fail until you declare them manually.")

   Show the orphan list in the question body, e.g.:
   ```
   Orphans detected:
     - agents/reg/   (7 jobs)
     - agents/suzy/  (3 jobs)
   ```

   If "Yes": append each orphan to `settings.agents`. Match step 5's permission-mode convention exactly — every orphan gets the SAME `permission_mode` treatment that step 5 would apply to a new agent in the current wizard state:

   - **If the wizard asked about permissions this run AND the answer was "No — confirm each Bash/Write call"** → write `{ "id": "<name>", "permission_mode": "plan" }`.
   - **If the wizard asked about permissions this run AND the answer was "Yes — headless (Recommended)"** → write `{ "id": "<name>" }` with NO `permission_mode` field (resolver default delivers headless).
   - **If the wizard skipped the permissions question this run** (it was already configured), read `.claude/claudeclaw/permission-mode.json`. If it exists and `{ "mode": "plan" }`, write `{ "id": "<name>", "permission_mode": "plan" }` — matching what existing agents would have got under step 5's "No" branch on a prior run. Otherwise (file absent OR mode is anything else) write `{ "id": "<name>" }` with no `permission_mode` — resolver-default headless, matching prior-run "Yes".

   Write the updated `settings.json`. Tell the user "Added N orphan agent(s) to settings.agents."

   If "No": write nothing — the daemon's startup warning will continue to flag them on every restart.

6. **Launch/start action**:
   ```bash
   mkdir -p .claude/claudeclaw/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --web > .claude/claudeclaw/logs/daemon.log 2>&1 & echo $!
   ```
   Use the description "Starting ClaudeClaw server" for this command.
   Wait 1 second, then check `cat .claude/claudeclaw/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.
   - Read `.claude/claudeclaw/settings.json` for `web.port` (default `4632` if missing) and `web.host` (default `127.0.0.1`).
   - Then try to open the dashboard directly:
     - Linux: `xdg-open http://<HOST>:<PORT>`
     - macOS: `open http://<HOST>:<PORT>`
     - If open command fails, print the URL clearly so user can open it manually.

7. **Capture session ID**: Read `.claude/claudeclaw/session.json` and extract the `sessionId` field. This is the shared Claude session used by the daemon for heartbeat, jobs, Telegram, and Discord.

8. **Report**: Print the ASCII art below then show the PID, session, status info, Telegram bot next step, and the Web UI URL.

CRITICAL: Output the ASCII art block below EXACTLY as-is inside a markdown code block. Do NOT re-indent, re-align, or adjust ANY whitespace. Copy every character verbatim. Only replace `<PID>` and `<WORKING_DIR>` with actual values.

```
🦞         🦞
   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝
```

# HELLO, I AM YOUR CLAUDECLAW!
**Daemon is running! PID: \<PID> | Dir: \<WORKING_DIR>**

```
/heartbeat:status  - check status
/heartbeat:stop    - stop daemon
/heartbeat:clear   - back up session & restart fresh
/heartbeat:config  - show config
```

**To start chatting on Telegram**
Go to your bot, send `/start`, and start talking.

**To start chatting on Discord**
DM your bot directly — no server invite needed: `https://discord.com/users/<DISCORD_BOT_ID>`
Or mention it in any server it's in. Use `/start` and `/reset` slash commands.
To get `<DISCORD_BOT_ID>`: read the daemon log for the bot's user ID (shown in the "Ready as <name> (<ID>)" line).

**To talk to your agent directly on Claude Code**
`cd <WORKING_DIR> && claude --resume <SESSION_ID>`

Show this direct Web UI URL:
```bash
http://<WEB_HOST>:<WEB_PORT>
```
Defaults: `WEB_HOST=127.0.0.1`, `WEB_PORT=4632` unless changed via settings or `--web-port`.

---

## Reference: File Formats

### Settings — `.claude/claudeclaw/settings.json`
```json
{
  "model": "opus",
  "api": "",
  "fallback": {
    "model": "glm",
    "api": ""
  },
  "agentic": {
    "enabled": true,
    "defaultMode": "implementation",
    "modes": [
      {
        "name": "planning",
        "model": "opus",
        "keywords": ["plan", "design", "architect", "research", "analyze", "think", "evaluate", "review"],
        "phrases": ["how should i", "what's the best way to", "help me decide"]
      },
      {
        "name": "implementation",
        "model": "sonnet",
        "keywords": ["implement", "code", "write", "fix", "deploy", "test", "commit"]
      }
    ]
  },
  "timezone": "UTC+0",
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Check git status and summarize recent changes."
    // OR use a file path:
    // "prompt": "prompts/heartbeat.md"
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "discord": {
    "token": "MTIz...",
    "allowedUserIds": ["123456789012345678"],
    "listenChannels": ["987654321098765432"]
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  }
}
```
- `model` — Claude model to use (`opus`, `sonnet`, `haiku`, `glm`, or full model ID). Empty string uses default. Ignored when `agentic.enabled` is true.
- `api` — API token used when `model` is `glm` (passed as `ANTHROPIC_AUTH_TOKEN` for that provider path).
- `fallback.model` — backup model used automatically if the primary run returns a rate-limit message. Prefer `glm` for provider diversity.
- `fallback.api` — optional API token to use with `fallback.model`.
- `agentic.enabled` — when true, automatically routes tasks to appropriate models based on task type
- `agentic.defaultMode` — which mode to use when no keywords match (default: `"implementation"`)
- `agentic.modes` — array of routing modes, each with: `name` (string), `model` (string), `keywords` (string[]), optional `phrases` (string[], checked before keywords with higher priority). Old `planningModel`/`implementationModel` format is auto-converted.
- `timezone` — canonical app timezone as UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`). Heartbeat windows, jobs, and UI all use this timezone.
- `heartbeat.enabled` — whether the recurring heartbeat runs
- `heartbeat.interval` — minutes between heartbeat runs
- `heartbeat.prompt` — the prompt sent to Claude on each heartbeat. Can be an inline string or a file path ending in `.md`, `.txt`, or `.prompt` (relative to project root). File contents are re-read on each tick, so edits take effect without restarting the daemon.
- Heartbeat template override (optional) — create `.claude/claudeclaw/prompts/HEARTBEAT.md` to replace the built-in heartbeat template for this project.
- `telegram.token` — Telegram bot token from @BotFather
- `telegram.allowedUserIds` — array of numeric Telegram user IDs allowed to interact. **An empty list refuses everyone.**
- `discord.token` — Discord bot token from the Developer Portal
- `discord.allowedUserIds` — array of string Discord user IDs (snowflakes) allowed to interact. **An empty list refuses everyone.**
- `telegram.allowAllUsers` / `discord.allowAllUsers` / `slack.allowAllUsers` — `true` accepts every user of that platform regardless of `allowedUserIds`. Off by default; only for a deliberately public bot.
- `discord.listenChannels` — array of string channel IDs where the bot responds to all messages without requiring an @mention
- `security.level` — one of: `locked`, `strict`, `moderate`, `unrestricted`
- `security.allowedTools` — extra tools to allow on top of the level (e.g. `["Bash(git:*)"]`)
- `security.disallowedTools` — tools to block on top of the level
- `agents[N].permission_mode` (bus runtime) — one of: `"default"`, `"plan"`, `"acceptEdits"`, `"bypassPermissions"`, `"dontAsk"`, `"auto"` (full-parity with Claude Code's `--permission-mode` choices). Default is `"bypassPermissions"` (headless — no Allow/Deny prompts per tool call). Per-agent override; falls back to the resolver default if unset.
- `.claude/claudeclaw/permission-mode.json` (legacy `claude -p` runtime) — `{"mode": "..."}` file. Absent ≡ `"bypassPermissions"` (headless). Written by the wizard only when the user explicitly opts out of headless.

### Security Levels
The security level controls which tools are available; the headless behaviour is controlled separately via `permission_mode`. By default (`permission_mode: "bypassPermissions"`, set by the wizard or assumed when unset) all levels run without permission prompts, with security enforced via tool restrictions and project-directory scoping. Operators can opt into per-call confirmations by setting `permission_mode: "plan"` — useful for review-bot or compliance-bounded setups.

| Level | Tools available | Directory scoped |
|-------|----------------|-----------------|
| `locked` | Read, Grep, Glob only | Yes — project dir only |
| `strict` | Everything except Bash, WebSearch, WebFetch | Yes — project dir only |
| `moderate` | All tools | Yes — project dir only |
| `unrestricted` | All tools | No — full system access |

### Jobs — `.claude/claudeclaw/jobs/<name>.md`
Jobs are markdown files with cron schedule frontmatter and a prompt body:
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```
- Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`
- **Timezone-aware**: cron times are evaluated in the configured `timezone`. E.g. `0 9 * * *` with `timezone: "UTC+2"` fires at 9:00 AM local time.
- The filename (without `.md`) becomes the job name
- Jobs are loaded at daemon startup from `.claude/claudeclaw/jobs/`
