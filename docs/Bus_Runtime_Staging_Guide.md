# Bus Runtime Staging Guide (Sprint 5.3)

After Sprint 5.2 (PRs #122 / #123 / #125 / #126 / #127), the Bus runtime is
feature-complete for operator-visible surfaces. This guide walks through
opting a single daemon (e.g. Hetzner staging) into `runtime: "bus"` for a
24-48h soak before Sprint 5.4 flips the default repo-wide.

The guide is sized for the **single-global-agent + Discord + Web UI**
topology. Other surfaces (Telegram, Slack, multi-agent) follow the same
pattern — see the *Other surfaces* section at the bottom.

## Pre-flight

Before changing anything, do these three things on the staging host:

1. **Stop the daemon cleanly** — `claudeclaw stop` (or SIGTERM the PID).
   Verify no `claude` children survived (`pgrep claude`).

2. **Back up the current settings + session state** so a rollback is one
   `cp` away:

   ```sh
   cd /home/claw/project
   cp .claude/claudeclaw/settings.json \
      .claude/claudeclaw/settings.json.bak-pre-bus-$(date +%Y%m%d-%H%M%S)
   # Optional but cheap: snapshot the global session.json too.
   cp .claude/claudeclaw/session.json \
      .claude/claudeclaw/session.json.bak-pre-bus-$(date +%Y%m%d-%H%M%S)
   ```

3. **Confirm the upgrade is at the right version** — `2.2.57` or
   higher contains every Sprint 5.2 sub-PR plus the Codex P1 digest fix.
   ```sh
   jq -r .version .claude-plugin/plugin.json
   ```

## Step 1 — add the Bus block to `settings.json`

Append the fields below to your existing `.claude/claudeclaw/settings.json`.
Keep everything else as-is — tokens, allowedUserIds, web.host/port, etc.
stay shared with the legacy stack.

```jsonc
{
  // ... your existing fields stay untouched ...

  "runtime": "bus",
  "agents": [
    {
      "id": "default",
      "permission_mode": "plan"
      // cwd defaults to process.cwd(); leave it off unless you need an override.
      // supervision defaults to "pty-stdin" — what you want for adapter traffic.
    }
  ],

  "discord": {
    "token": "...your existing token...",
    "allowedUserIds": ["...your existing list..."],
    // NEW — every Discord channel where you want messages to reach `default`:
    "busRouting": {
      "channels": {
        // "<channel-snowflake>": "default",
        // example placeholders — replace with your channel IDs:
        "1234567890123456789": "default"
      },
      // DMs catch-all:
      "dmAgentId": "default"
    }
  },

  "web": {
    "enabled": false,                  // legacy dashboard off — Bus serves the UI
    "host": "127.0.0.1",
    "port": 4632,
    // NEW — bind + auth for the Bus Web UI adapter:
    "bus": {
      "bind": "127.0.0.1:4632",
      "token": "...generate a random token...",
      "allowedAgentIds": ["default"]
    }
  }
}
```

### Channel-ID lookup

Open Discord with developer mode on, right-click each channel where the
bot should receive messages, choose `Copy Channel ID`, and paste under
`busRouting.channels`. Pre-cutover the bot listens on every channel in
the legacy `listenChannels` array; the Bus adapter only fires on
channels mapped explicitly in `busRouting.channels` (plus DMs caught by
`dmAgentId`). Map the full set you want — anything missing is silently
dropped.

### Web UI bind

Two non-obvious points:

- `web.enabled: false` switches off the legacy dashboard. The Bus
  Web UI adapter mounts INSTEAD when `web.bus` is set — different code
  path entirely.
- `web.bus.bind` can re-use the legacy port (4632) since the legacy
  listener is off. **Side-by-side legacy + Bus Web UI is NOT
  supported** — when the Bus mount succeeds, `start.ts` gates off
  every legacy adapter (including `startWebUi`) regardless of
  `web.enabled`. If you want to compare behaviour, do it across
  daemon restarts (flip `runtime`, restart, compare) rather than in
  one process.
- The adapter refuses any browser request (one carrying an `Origin`
  header) from a foreign origin with `403 origin_not_allowed`, on
  `POST /prompt` and on the `/ws` upgrade, token or not. A browser
  client served from another origin must be listed in
  `web.bus.allowedOrigins` (e.g. `["https://console.example"]`).
  curl and native clients send no `Origin` and are unaffected.
- `web.bus.token` can be left out of `settings.json` and supplied as
  the `CCAW_WEBUI_TOKEN` environment variable instead.

## Step 2 — restart the daemon

```sh
cd /home/claw/project
claudeclaw start
```

The startup banner should now include:

```
  Runtime: bus (Bus stack mounted, agents=[default], adapters=[discord, webui])
```

That `adapters=[discord, webui]` line confirms `wireBusAdapters` saw the
token + routing for each platform and mounted them. **If you see
`Bus mount failed; legacy surfaces only`**, the daemon fell back —
inspect the preceding log lines for the cause. To roll back, restore
the backup from step 1 (full path because the daemon was launched from
`/home/claw/project`, so the timestamped backups live under
`.claude/claudeclaw/`):

```sh
cd /home/claw/project
cp .claude/claudeclaw/settings.json.bak-pre-bus-<timestamp> \
   .claude/claudeclaw/settings.json
claudeclaw stop && claudeclaw start
```

## Step 3 — smoke tests

Run these in order. Each should produce the documented behaviour
within a few seconds.

| # | Action | Expected |
|---|---|---|
| 1 | Send a Discord DM to the bot | Bot acknowledges, claude responds, no echo of the prompt envelope. Spaces between words intact (PRs #119/#120/#124). |
| 2 | Send a Discord message in a routed guild channel | Same as DM but in the channel. |
| 3 | Send a message in an UNROUTED channel (or one not in `busRouting.channels`) | Silently dropped. No legacy fallback. |
| 4 | Open the Bus Web UI at `http://127.0.0.1:4632` with the `web.bus.token` | Conversation view shows agent activity; subscribing to `default` works. |
| 5 | Toggle a cron job's `enabled: true → false` in its `.md` frontmatter | Within 30s daemon logs `Jobs reloaded: N job(s)`; job stops firing. Jobs run from the 60 s job loop under every runtime, so the bus scheduler's trigger count covers the heartbeat only. |
| 6 | Change `heartbeat.interval` in `settings.json` | Same — within 30s daemon logs the reload. |
| 7 | Add an `excludeWindows` entry (e.g. `"22:00"–"07:00"`) for quiet hours | Heartbeat skips inside that window. Verifies PR #126 wiring. |
| 8 | Send SIGTERM (`kill <pid>`) | Banner logs `[bus-runtime] mounted; …` order in reverse: adapters → scheduler → agents → bus. No orphan `claude` children (`pgrep claude` empty). |

## Step 4 — watch for 24-48h

Monitor:

- **Heartbeat cadence** — `journalctl -u claudeclaw -f | grep heartbeat`
  (or wherever the daemon logs). Should fire every `interval` minutes
  outside any exclusion window.
- **Discord round-trip times** — operators have reported the PTY
  long-lived session is *faster* than legacy `claude -p` because of
  warm-process reuse. Note any regressions vs the pre-cutover baseline.
- **Spacing regression** — every reply from claude should have proper
  word spacing (PR #120 fixed the CUF-stripping bug). If you see a
  reply that runs words together, capture the raw fixture and file an
  issue.
- **Stale-turn regression** — long-idle (>1h) replies should not echo
  the previous turn's content. PR #124 fixed the premature-sentinel
  bug; verify it holds over the soak.

## Known limitations during the soak

These are documented in PR descriptions but worth restating here so you
don't waste time investigating:

- **Bus ADAPTER hot-reload not implemented.** Changing Discord
  `busRouting.channels`, the Web UI bind, or platform tokens requires
  a daemon restart. The scheduler reloads on heartbeat / jobs changes
  (PR #126), but adapter reload would invalidate pending permission /
  ask maps — deferred until a session-migration story exists.
  Allow-lists are the exception: `allowedUserIds` and `allowAllUsers`
  are read on every inbound event, so an edit applies to incoming messages
  and button taps within 30 s (#520).
- **Jobs run outside the bus agents' sessions.** Under Bus the 60 s job
  loop still runs each job as its own `claude -p`, so per-job
  `model:`, `timeoutSeconds`, `retry` / `retryDelay` and `notify` apply
  as on the legacy runtime, and `job.agent` does not route a job to a
  bus agent (see *Multi-agent fan-out*). The global per-session cap defaults to
  **120 minutes** (`sessionTimeoutMs`); override in the daemon's
  project-local settings file (`<cwd>/.claude/claudeclaw/settings.json`
  — for the Hetzner staging flow that's
  `/home/claw/project/.claude/claudeclaw/settings.json`) if you want a
  tighter or looser cap. The `~/.claude/` path is the Claude CLI's
  user-scope config, not where this daemon reads.
- **Upstream Slack features pending.** Issue #121 (allowBots, block /
  attachment text extraction, replyThreadTs) is queued as a separate
  port into the Bus Slack adapter. Not blocking for the
  Discord-only staging.

## Rollback procedure

If anything misbehaves and you want to revert:

```sh
claudeclaw stop
cd /home/claw/project
cp .claude/claudeclaw/settings.json.bak-pre-bus-<timestamp> \
   .claude/claudeclaw/settings.json
claudeclaw start
```

Banner returns to `Runtime: pty` (or whatever was in your backup). The
agent session.json under `agents/default/` was created during the Bus
soak — keep it for next time, no need to delete. The legacy heartbeat
path will re-spawn its own `claude -p` chain.

## After a clean soak

Hand the result to me with a short report:

- Confirmed working surfaces (Discord, Web UI, etc.)
- Any unexpected behaviour observed
- Restart count over the soak window

I'll then prep **Sprint 5.4** — flip the repo-wide default for
`parseRuntimeMode` from `"pty"` to `"bus"`, migration guide for other
deployments, CHANGELOG entry.

## Other surfaces (reference)

If a future staging adds Telegram / Slack / multi-agent, the additions
look like:

### Telegram

```jsonc
"telegram": {
  "token": "...",
  "allowedUserIds": [12345678],
  "busRouting": {
    "chats": { "12345678": "default" },
    "defaultAgentId": "default"
  }
}
```

### Slack

```jsonc
"slack": {
  "botToken": "xoxb-...",
  "appToken": "xapp-...",
  "signingSecret": "...",  // REQUIRED for Bus runtime — top-level or under busRouting
  "allowedUserIds": ["U..."],
  "busRouting": {
    "channels": { "C12345": "default" },
    "threadAgentId": "default"
  }
}
```

### Multi-agent fan-out

Once the single-global soak is stable, you can split topics across
agents by adding more entries to `settings.agents` and mapping channels
to them. The first agent in the array is still the default for the
heartbeat. Example: a plan-mode agent for inbound traffic + a second
agent for other channels:

```jsonc
"agents": [
  { "id": "inbound", "permission_mode": "plan" },
  { "id": "ops", "permission_mode": "default" }
],
"discord": {
  "busRouting": {
    "channels": { "1234...": "inbound" },
    "dmAgentId": "inbound"
  }
}
```

Jobs do not run in these agents' sessions: the 60 s job loop runs each
job as its own `claude -p` under every runtime. `job.agent` names a
legacy agent directory (`agents/<name>/`, its persona and model), not an
entry of `settings.agents`; when it names a bus agent with no such
directory, the daemon logs a warning and the job runs on the default
model. To run routine cron work on a cheap model, set `model:` in each
job's frontmatter, e.g. `model: haiku`.

## Allow-lists: an empty list now refuses everyone

`telegram.allowedUserIds`, `discord.allowedUserIds` and `slack.allowedUserIds`
used to mean "everyone" when left empty. A bot token plus a skipped optional
field therefore exposed the agent, and every tool it has, to any user of the
platform. An empty list now refuses every user, on the Bus runtime and on the
legacy runtime alike.

**Migration.** If your bot answered people while the list was empty, it stops
answering them after this upgrade. The daemon says so at startup:

```
  WARNING: telegram.allowedUserIds is empty, so every telegram user is REFUSED (an empty list used to allow everyone). ...
```

Fix it one of two ways:

- list the people who may talk to the bot (recommended):
  `"telegram": { "allowedUserIds": [12345678] }`
- or, for a bot that is meant to be public, opt in explicitly:
  `"telegram": { "allowAllUsers": true }` (same key under `discord` / `slack`).

Slack bot traffic admitted through `allowBots` is unaffected.

Both keys are hot-reloaded on both runtimes: removing an id, or switching
`allowAllUsers` back off, refuses that user's next message or button tap
within 30 s, without a restart (#520). On the Bus runtime, Telegram output
that is not tied to a chat (heartbeat, alerts, scheduled tasks) goes to the
last chat that wrote to the agent; that chat is re-checked against the
current list before each such send, so a removed user stops receiving it
too, and it falls back to the `telegram.busRouting.chats` entries (#521). A
group is treated the same way: its cache entry belongs to the user who last
wrote there. A chat listed in `busRouting.chats` is configuration and keeps
receiving: remove a revoked user's DM from it too. Output already waiting in
the outbox (held by quiet hours, or a failed send queued for retry) is
re-checked the same way when it drains (Bus runtime): a message sent to the
last chat, or a job result sent to a listed user, is dropped with a `[telegram-outbox]
dropped message to chat …` warning if that user was removed meanwhile
(#525). Output for a chat listed in `busRouting.chats` is not tied to its
last writer and is delivered (#542). Entries queued before this check existed carry no user and drain as
before. Discord and Slack send such output to their configured channels,
not to the last sender.

**Buttons follow the same rule.** A Telegram button press — a tool permission
prompt (`perm:allow|deny`, Bus runtime), a pending action
(`pending:<id>:<value>`, both runtimes), a reply button (`btn:`, legacy
runtime) — is accepted only from a user the list accepts, in a private chat
and in a group alike; anyone else gets "Unauthorized." and the press has no
effect. With `allowAllUsers: true`, anyone who can reach the bot — in a DM or
in any group it is in — can approve a tool permission request: on a bot that
sits in a group, list the people who should answer the agent's prompts
instead.
