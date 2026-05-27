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
| 5 | Toggle a cron job's `enabled: true → false` in its `.md` frontmatter | Within 30s daemon logs `Bus scheduler reloaded — N trigger(s)`; job stops firing. |
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
- **Per-job model / timeout overrides not honoured.** Under Bus, route
  the job to a different agent instead (declare a second agent with the
  model you want, set `job.agent: "<that-id>"`). Cleaner architectural
  fit; documented in PR #126. The global per-session cap defaults to
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
heartbeat + jobs lacking an explicit `job.agent`. Example: a haiku agent
for cheap routine cron work + a sonnet agent for inbound traffic:

```jsonc
"agents": [
  { "id": "inbound", "permission_mode": "plan" },
  { "id": "cron-haiku", "permission_mode": "default" }
],
"discord": {
  "busRouting": {
    "channels": { "1234...": "inbound" },
    "dmAgentId": "inbound"
  }
}
```

Set `job.agent: "cron-haiku"` in each job's frontmatter to route cron
to the cheap agent.
