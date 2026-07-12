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
