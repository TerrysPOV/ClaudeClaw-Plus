# Deploying under systemd — cgroup hardening that actually fires

This is the companion to issue #178. It covers the two failure modes found in
production:

1. **The limits don't apply at all** — `su` re-parenting moves the daemon out
   of the service cgroup (#178's original finding).
2. **The limits apply but freeze instead of kill** — the "memory freeze zone":
   a runaway child pushes the cgroup above `MemoryHigh`, swap absorbs the
   growth so `MemoryMax` never fires, and the kernel throttles the whole tree
   indefinitely (observed in production 2026-07-08).

## Recommended unit (Option A of #178 — no `su` indirection)

```ini
[Unit]
Description=ClaudeClaw daemon
After=network-online.target
Wants=network-online.target

[Service]
User=claw
Group=claw
# If secrets come from a manager (e.g. Doppler), fetch them as an
# ExecStartPre step or run the manager directly as the service user —
# never via `su`, which re-parents the daemon into a session scope and
# silently disables every limit below.
ExecStart=/bin/bash -c 'set -a; source /home/claw/.claudeclaw-env; set +a; exec bun run /opt/claudeclaw/src/index.ts start --web'
Restart=on-failure
RestartSec=10
# Graceful drain (#315): SIGTERM must reach the daemon ONLY, so the `claude`
# children outlive the signal while the daemon waits (up to
# settings.shutdown.drainTurnsMs, default 30 s) for in-flight turns. With the
# default KillMode=control-group every child dies at the same instant and the
# drain has nothing left to protect. `mixed` SIGKILLs whatever remains at
# TimeoutStopSec, so keep that above the drain window.
KillMode=mixed
TimeoutStopSec=90

# ── Tier 1 hardening ────────────────────────────────────────────────────────
TasksMax=100
CPUQuota=150%
# Soft limit: kernel starts reclaim/throttling above this.
MemoryHigh=1536M
# Hard limit: OOM-kill above this.
MemoryMax=2560M
# THE LINE THAT PREVENTS THE FREEZE ZONE — see below. Without it, a runaway
# child spills its growth into swap, sits between High and Max forever, and
# the whole service freezes instead of the hog dying.
MemorySwapMax=1G

[Install]
WantedBy=multi-user.target
```

## Credential store warnings at startup

At startup, before any agent is spawned and for every runtime, the daemon reads
two numbers from the Claude credential store — `claudeAiOauth.expiresAt` and
`claudeAiOauth.refreshTokenExpiresAt` in `$CLAUDE_CONFIG_DIR/.credentials.json`,
or `~/.claude/.credentials.json` when that is unset — and never a token value
(`src/bus/credential-readiness.ts`). It warns in the daemon log in two cases,
then keeps booting:

- **A long-lived `CLAUDE_CODE_OAUTH_TOKEN` (`sk-ant-oat01-…`, from
  `claude setup-token`) and a `claudeAiOauth` login in the store.** Agents run
  the interactive `claude` REPL under a PTY, and the REPL uses the stored login
  instead of the env token: agents run on that login's account, and once its
  access token expires they 401 while `claude -p` with the same env token keeps
  working. Fix: move the store aside (`mv <path> <path>.bak`, the warning names
  the path it checked) and restart. Don't run `/login`, or `claude` as the
  daemon user without the env token set, because either recreates it.
- **No long-lived env token, and the store's refresh token has expired.**
  Nothing can refresh it; spawned agents will 401. Fix: `claude setup-token` on
  any machine with a browser, set `CLAUDE_CODE_OAUTH_TOKEN` to the result in
  whatever populates the daemon's environment, and restart. If an
  `ExecStartPre` rebuilds the env file from a secrets manager on every start,
  edit the manager — a direct edit of the file is discarded on the next restart.

Silent otherwise: a long-lived env token with no stored login, no store, an
unreadable or malformed store, and an access token whose `expiresAt` is in the
past (normal between lazy refreshes). A healthy store logs one line,
`Credential store: refresh token valid (…)`.

## Why `MemorySwapMax` is not optional

`MemoryHigh`/`MemoryMax` bound **RAM**, not swap. The gap between them is
supposed to be a graceful-degradation band, but with unlimited swap it becomes
a stable freeze state:

- A runaway child (production case: a `grep` variant an agent Bash tool call
  ran over a multi-hundred-MB JSONL ballooned to 1.3 GB RSS + **3.9 GB
  swap**) drives `memory.current` just past `MemoryHigh`.
- The kernel throttles every process in the cgroup
  (`mem_cgroup_handle_over_high`, `D` state) to force reclaim — but the
  reclaimed pages go to swap, so the hog keeps growing there and
  `memory.current` never reaches `MemoryMax`. **Nothing is ever OOM-killed.**
- Symptoms: gateway port LISTENs but handlers never run (`/api/health`
  timeout with the port open), every liveness heuristic sees "slow but
  progressing" (throttled I/O trickles), and restarting the daemon is
  futile — the fresh process lands in the same saturated cgroup.

With `MemorySwapMax` capped, the runaway hits the hard boundary quickly and
the kernel OOM-kills **the hog only**; the daemon keeps running.

## Verifying the limits actually apply

```bash
# 1. The daemon must live in the service cgroup, NOT a user/session scope:
cat /proc/$(systemctl show <unit> -p MainPID --value)/cgroup
#    → .../claudeclaw.service   ✓
#    → .../session-N.scope      ✗ limits are NOT applying (#178 su re-parenting)

# 2. The cgroup actually tracks the processes:
systemctl status <unit>   # Tasks/Memory lines non-zero
cat /sys/fs/cgroup/<ControlGroup>/pids.current   # > 0

# 3. The limits are what you declared:
systemctl show <unit> -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax
```

## Detecting the freeze zone from outside

The daemon exposes its own cgroup state on `/api/health` (pre-auth, so
monitors can read it):

Unauthenticated (the pre-auth surface carries only the boolean signal):

```json
{ "ok": true, "now": 1751980000000, "memory": { "overHigh": false } }
```

With the web token (`Authorization: Bearer <token>` or `?token=`), the
diagnostic detail appears:

```json
{ "ok": true, "now": 1751980000000,
  "memory": { "overHigh": false, "currentBytes": 474525696,
              "highBytes": 1610612736, "highEvents": 0 } }
```

`memory.overHigh: true` — or a health **timeout while the port still
accepts connections** — means: do **not** restart-loop the daemon. Find and
kill the largest child inside the cgroup instead:

```bash
CG=/sys/fs/cgroup$(systemctl show <unit> -p ControlGroup --value)
MAIN=$(systemctl show <unit> -p MainPID --value)
# largest RSS+swap process in the cgroup, excluding the daemon itself:
find "$CG" -name cgroup.procs -exec cat {} + | sort -u | while read -r p; do
  [ "$p" = "$MAIN" ] && continue
  awk -v p="$p" '/^VmRSS:|^VmSwap:/ {s+=$2} END {print s+0, p}' "/proc/$p/status" 2>/dev/null
done | sort -rn | head -1
# → "<kb> <pid>"; kill -9 the pid, the throttle lifts instantly.
```

Killing the cause beats restarting the victim: a daemon restart lands in the
same saturated cgroup and freezes again (two futile restarts observed before
the root cause was identified).
