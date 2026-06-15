---
name: mcp
description: Manage the ClaudeClaw-Plus MCP bridge — register plugins, monitor health, audit invocations, debug cross-process calls, generate plugin templates. Use when configuring/troubleshooting the plugin gateway, when adding a new daemon plugin (voice-agent, retrieval-daemon, ML pipelines), when investigating audit log events, or when diagnosing plugin connectivity issues.
---

# MCP — Plus plugin gateway companion skill

Multi-mode skill for the ClaudeClaw-Plus MCP bridge. Connects to Plus's HTTP gateway at `http://localhost:4632/api/plugin/*` and the audit log at `~/.config/plus/plugin-audit.jsonl`.

## Mode dispatch

Read user intent from the trigger / first message:

- `/mcp` (no arg) or first-time use → **setup**
- `/mcp list` or "what plugins are registered" → **list**
- `/mcp inspect <plugin>` or "tell me about <plugin>" → **inspect**
- `/mcp diagnose` or "are my plugins healthy" → **diagnose**
- `/mcp audit` or "show recent plugin events" → **audit**
- `/mcp trace <request_id>` or "find this request" → **trace**
- `/mcp register` or "add a new plugin" → **register**
- `/mcp test <plugin> <tool>` or "test <plugin>'s <tool>" → **test**
- `/mcp report` or "this looks like an MCP bug" → **report**
- `/mcp proxy-status` or "show MCP server pool" → **proxy-status**
- `/mcp proxy-restart <server>` or "restart <server> MCP server" → **proxy-restart**

If unclear, ask.

---

## Mode: setup

Goal: prepare a new plugin install — print bootstrap token, walk through Plus config, suggest first plugin registration.

### Step 1 — Welcome

Tell the user in 3 sentences:
1. The MCP bridge lets daemon-style plugins (Python, Rust, etc.) register tools that Claude Code can call.
2. Each plugin needs a bootstrap token (one-time) and a per-plugin secret (auto-generated at register).
3. The bridge runs HTTP endpoints under `/api/plugin/*` and an MCP server at `bun run src/plugins/mcp-server.ts`.

### Step 2 — Print bootstrap token

```bash
bun run src/plugins/cli.ts print-bootstrap-token
```

If file doesn't exist (first run), Plus auto-creates it at `~/.config/plus/plugin-bootstrap.secret` (0600, 32 bytes). Display the token to the user. Tell them:

> Save this token — your plugin install scripts need it for the `register` call. You can re-print it any time with the same command.

### Step 3 — Verify Plus is running

```bash
curl -s -H "Authorization: Bearer $(bun run src/plugins/cli.ts print-bootstrap-token)" http://localhost:4632/api/plugin/list
```

A `200` (JSON plugin list) means Plus is up. A `401` also means it's UP — just a
bootstrap-token mismatch (re-print the token). Only `404` / connection refused
means the daemon isn't running with the `--web` flag. Suggest restart:
```bash
systemctl --user restart claudeclaw.service
```

If returns `{"plugins": []}` → bridge is up, no plugins yet.

### Step 4 — Suggest next steps

> Ready to register your first plugin?
>   1. Generate a Python plugin template (`/mcp register`)
>   2. Manual: see `docs/plugin-integration.md` for examples (voice-driven agents, retrieval daemons)
>   3. Skip (already have a plugin scripted)

### Step 5 — Detect mcp-proxy config

```bash
test -f ~/.config/claudeclaw/mcp-proxy.json && echo "exists" || echo "missing"
```

If exists:
> An mcp-proxy config exists. Run `/mcp proxy-status` to see pooled servers and their health.

If missing:
> No mcp-proxy config detected. Copy `mcp-proxy.json.example` to `~/.config/claudeclaw/mcp-proxy.json` and configure your MCP servers to enable warm-pool routing (~200ms direct calls vs ~3000ms inject path).

### Step 5b — Auth contract reference

For the canonical authentication contract (header names, HMAC signing scope, ISO 8601 timestamp format, replay window semantics), point the user to:

👉 [`docs/plugin-integration.md`](https://github.com/TerrysPOV/ClaudeClaw-Plus/blob/main/docs/plugin-integration.md#authentication-contract)

This is the source of truth — do not paraphrase the headers (`x-plus-ts` / `x-plus-signature`) or scope (`<ts>\n<body>`) from memory; a single character mismatch returns 401 `invalid_signature`.

End setup.

---

## Mode: list

Goal: show all registered plugins with their health status.

### Step 1 — Fetch list

```bash
curl -s -H "Authorization: Bearer $(bun run src/plugins/cli.ts print-bootstrap-token)" http://localhost:4632/api/plugin/list
```

### Step 2 — Render table

```
Registered plugins:

| Plugin       | Version | Tools                          | Health | Registered |
|--------------|---------|--------------------------------|--------|------------|
| daemon-A | 0.1.0   | pending, apply, refuse         | ✅ ok  | 2h ago     |
| voice-agent   | 1.0.0   | send_tts, transcribe_audio     | ⚠️ deg | 2d ago     |
| retrieval-daemon   | 2.1.0   | search_docs, index_doc         | ❌ down| 5d ago     |
```

For health:
- ✅ ok — last_health_check.healthy = true within last 5 min
- ⚠️ degraded — healthy but slow (>1s response) or stale check (>10 min)
- ❌ down — last_health_check.healthy = false or no manifest health_url
- ❓ unknown — no health_url declared

### Step 3 — Suggest next actions

If any ❌ or ⚠️:
> Run `/mcp inspect <plugin>` for details, or `/mcp diagnose` to refresh health checks.

### Step 4 — Proxied MCP servers (conditional)

If `mcp-proxy` appears in the plugin list, fetch pool state and render a second table:

```bash
curl -s http://localhost:4632/api/plugin/mcp-proxy/health
```

```
Proxied MCP servers (via mcp-proxy):

| Server           | Tools | Status      | Last invocation |
|------------------|-------|-------------|-----------------|
| home-automation  | 4     | ✅ up        | 2 min ago       |
| brave-search     | 1     | ✅ up        | 14 min ago      |
| momentum-trader  | 3     | ❌ crashed   | 1h ago          |
```

Status values: `up` / `starting` / `restarting` / `crashed` / `failed` / `stopped`.
For `crashed` or `failed`: suggest `/mcp proxy-restart <server>`.

End list.

---

## Mode: inspect <plugin>

Goal: deep dive on one plugin.

### Step 1 — Fetch plugin info

```bash
curl -s -H "Authorization: Bearer $(bun run src/plugins/cli.ts print-bootstrap-token)" http://localhost:4632/api/plugin/list | jq '.plugins[] | select(.name == "<plugin>")'
```

### Step 2 — Force health check

```bash
curl -s http://localhost:4632/api/plugin/<plugin>/health
```

### Step 3 — Show recent audit events for this plugin

Read `~/.config/plus/plugin-audit.jsonl`, filter by `plugin == "<plugin>"`, last 20 entries.

### Step 4 — Render report

```
## Plugin: voice-agent

### Manifest
- Version: 1.0.0 (schema_version 1)
- Capabilities: tools
- Callback: http://localhost:8765/plus-callback
- Health: http://localhost:8765/health
- Tools: send_tts, transcribe_audio

### Health
- Last check: 2 min ago — degraded (response time 1.4s, target <500ms)
- HTTP: 200 OK

### Recent activity (last 20)
- 14:32:18 invoke tool=send_tts request_id=abc123 (success, 312ms)
- 14:31:50 invoke tool=transcribe_audio request_id=def456 (success, 1.2s)
- 14:30:12 health_check (healthy)
- ...

### Suggested actions
- Investigate slow responses (1.2s on transcribe vs target 500ms)
- Run `/mcp test voice-agent send_tts` to verify functionality
```

### Step 5 — mcp-proxy drill-down (conditional)

If `<plugin> == mcp-proxy`, skip Step 4 and render this instead:

```bash
curl -s http://localhost:4632/api/plugin/mcp-proxy/health
cat ~/.config/claudeclaw/mcp-proxy.json
```

Render per-server detail:

```
## Plugin: mcp-proxy (in-process warm pool)

| Server          | Status      | Crashes (5min) | Tools | p50 latency | Stderr log |
|-----------------|-------------|----------------|-------|-------------|------------|
| home-automation | ✅ up        | 0              | 4     | 180ms       | ~/.cache/claudeclaw/mcp-proxy/home-automation.log |
| brave-search    | ✅ up        | 0              | 1     | 210ms       | ~/.cache/claudeclaw/mcp-proxy/brave-search.log    |
| momentum-trader | ❌ failed    | 5              | 3     | —           | ~/.cache/claudeclaw/mcp-proxy/momentum-trader.log |
```

For servers in `failed` state: surface the last 10 lines of their stderr log and suggest
`/mcp proxy-restart <server>` or daemon restart if restart is exhausted.

End inspect.

---

## Mode: diagnose

Goal: full health sweep + config validation.

### Step 1 — Check Plus is running

```bash
# Liveness probe: /api/plugin/list now requires the bootstrap token, so a 401
# still proves the daemon is UP (it responded). Treat 200 OR 401 as alive;
# only a connection failure (code 000) means the daemon is down.
code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4632/api/plugin/list)
case "$code" in 200 | 401) ;; *) echo "Plus daemon down" ;; esac
```

### Step 2 — Check bootstrap token exists

```bash
ls -la ~/.config/plus/plugin-bootstrap.secret
```

Verify perms 0600. If missing, suggest `bun run src/plugins/cli.ts print-bootstrap-token` to auto-create.

### Step 3 — Health check all plugins

For each plugin in list:
```bash
curl -s http://localhost:4632/api/plugin/<name>/health
```

### Step 4 — Audit log recent errors

Read last 100 entries from `plugin-audit.jsonl`. Filter for `event` containing `error`, `failed`, `denied`, `mismatch`.

### Step 5 — Render report

```
## Diagnose report — 2026-05-10 14:35

### Daemon
✅ Plus daemon responding on :3000
✅ Bootstrap token present (0600 perms)
✅ Bridge initialized (3 plugins registered)

### Per-plugin health
- daemon-A: ✅ ok
- voice-agent:   ⚠️ degraded (slow callback)
- retrieval-daemon:   ❌ down (connection refused on :9090)

### Recent errors (last 100 audit entries)
- 14:30:12 retrieval-daemon search_docs invoke_failed (callback unreachable, 5 occurrences)
- 14:25:33 voice-agent send_tts invalid_args (zod error: missing 'text' field)

### Recommendations
1. retrieval-daemon: process not running. Start with `systemctl --user start retrieval-daemon.service`.
2. voice-agent: caller passing invalid args — check the voice-agent's callback handler validation.
```

### Step 6 — Common 401 causes

If invoke returns 401 `invalid_signature`, the usual suspects:

1. **Wrong header names** — must be `x-plus-ts` and `x-plus-signature` (lowercase, `x-plus-` namespace). `X-Timestamp`/`X-Signature` are silently ignored.
2. **Wrong HMAC scope** — signature covers `<ts>\n<body>`, not just `<body>`. Re-serializing the body between signing and sending breaks verification.
3. **Wrong timestamp format** — must be ISO 8601 UTC (`2026-05-11T12:34:56.000Z`). Unix epoch seconds get parsed as milliseconds and land in year 4xxx.
4. **Clock skew > 15 min** — 401 with code `stale_or_future_timestamp` (different code than HMAC failure).

Full troubleshooting:
👉 [`docs/plugin-integration.md`](https://github.com/TerrysPOV/ClaudeClaw-Plus/blob/main/docs/plugin-integration.md#authentication-contract)

End diagnose.

---

## Mode: audit [filter]

Goal: tail recent plugin-audit.jsonl events with optional filter.

### Step 1 — Read audit log

```bash
tail -200 ~/.config/plus/plugin-audit.jsonl | jq -c .
```

### Step 2 — Filter

If user provided keyword (e.g. `audit error`, `audit voice-agent`, `audit invoke_failed`):
- Filter entries by event matching keyword OR plugin matching keyword.

### Step 2.5 — Routing mode filter (conditional)

If user asks "audit direct" or "audit reasoned":
```bash
tail -200 ~/.config/plus/plugin-audit.jsonl | jq -c 'select(.payload.mode == "direct")'
# or: select(.payload.mode == "reasoned")
```

Surface ratio anomalies: if `reasoned` calls spike above 10% of mcp-proxy invocations, flag it —
a spike in `reasoned` typically means a warm-pool server is returning errors and callers are
routing around it. Suggest `/mcp proxy-status` to diagnose.

### Step 3 — Group + render

Group by event type, show counts + sample entries. Highlight security-relevant events: `invalid_signature`, `stale_or_future_timestamp`, `capability_denied`, `callback_host_not_allowed`.

```
## Audit summary — last 200 entries

By event type:
- tool_invoked × 142
- tool_success × 138
- tool_error × 4 (3 retrieval-daemon callback_unreachable, 1 greg invalid_args)
- http_plugin_registered × 3
- invalid_signature × 0 ✅
- stale_or_future_timestamp × 0 ✅

Security-relevant entries: 0 (audit healthy)

Recent errors:
14:30:12 retrieval-daemon tool_error: callback unreachable (request_id=abc789)
14:25:33 voice-agent tool_error: zod validation (request_id=def012)
```

### Step 4.5 — Drift since last cron

Check `~/.config/tuner/state-hashes.jsonl` for recent `subject_state_drift_detected` entries with `subject == "mcp"` (if `MCPSubject` is implemented) or related plugin subjects.

If MCPSubject not yet implemented, note:
> Drift detection for MCP plugins requires a future `MCPSubject` implementation. Manual `/mcp audit` invocation surfaces current state — automatic drift between audits will land when MCPSubject is added and `currentStateHash()` is implemented to hash `/api/plugin/list`.

End audit.

---

## Mode: trace <request_id>

Goal: follow a request_id through audit log + plugin health to debug intermittent issues.

### Step 1 — Find all entries with that request_id

```bash
grep -E "\"request_id\":\"<id>\"" ~/.config/plus/plugin-audit.jsonl | jq -c .
```

### Step 2 — Sequence them chronologically

### Step 3 — Annotate timeline

```
## Trace: request_id=abc789

[14:30:10.123] http_invoke_received (daemon-A__pending args=...)
[14:30:10.125] tool_invoked plugin=daemon-A tool=pending
[14:30:10.128] tool_success duration_ms=3 (returned 4 proposals)
[14:30:10.130] http_response_sent status=200

Total: 7ms end-to-end. ✅ Clean.
```

If trace shows error chain, surface it:
```
[14:25:33.450] http_invoke_received (voice-agent__send_tts args=...)
[14:25:33.451] tool_invoked plugin=voice-agent tool=send_tts
[14:25:33.452] tool_error error="zod validation: 'text' is required"

Root cause: caller passed empty args. Check voice-agent client code.
```

End trace.

---

## Mode: register

Goal: interactive wizard — create a new plugin manifest and (optionally) scaffold plugin code.

### Step 1 — Plugin name

Prompt: "What's the plugin name? (lowercase, kebab-case)"

Validate: matches `^[a-z][a-z0-9-]*$`.

### Step 2 — Callback URL

Prompt: "Where will Plus call your plugin? (default: http://localhost:8765/plus-callback)"

Default `localhost:NNNN`. If non-localhost, warn user about allowlist requirement.

### Step 3 — Tools

Prompt loop: "Add a tool? (name + description, or 'done')"

For each tool: name, description, args schema (simple — type + required fields).

### Step 4 — Capabilities

Prompt: "Capabilities: tools (default), hooks, session_read, session_write?" Default tools.

### Step 5 — Generate

Two outputs:

**a. Manifest JSON** for the user to POST:
```json
{
  "name": "<name>",
  "version": "0.1.0",
  "schema_version": 1,
  "callback_url": "http://localhost:8765/plus-callback",
  "tools": [...],
  "capabilities": ["tools"]
}
```

**b. Python plugin scaffold** (in `<plugin-root>/<name>/server.py`):
```python
import requests, hmac, hashlib, json
from http.server import BaseHTTPRequestHandler, HTTPServer

PLUGIN_TOKEN = "<set after register>"

def verify_hmac(token: bytes, ts: str, body: str, sig: str) -> bool:
    # Reference: docs/plugin-integration.md#authentication-contract
    # https://github.com/TerrysPOV/ClaudeClaw-Plus/blob/main/docs/plugin-integration.md
    expected = hmac.new(token, (ts + "\n" + body).encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        ts = self.headers.get("x-plus-ts", "")
        sig = self.headers.get("x-plus-signature", "")
        if not verify_hmac(bytes.fromhex(PLUGIN_TOKEN), ts, body, sig):
            self.send_response(401); self.end_headers(); return
        # Dispatch by tool name, return JSON {result: ...}
        pass

if __name__ == '__main__':
    HTTPServer(('localhost', 8765), Handler).serve_forever()
```

### Step 6 — Register

If user confirms, do the POST:
```bash
BOOTSTRAP=$(bun run src/plugins/cli.ts print-bootstrap-token)
curl -X POST http://localhost:4632/api/plugin/register \
  -H "Authorization: Bearer $BOOTSTRAP" \
  -H "Content-Type: application/json" \
  -d @manifest.json
```

Save returned `plugin_token` to `~/.config/plus/plugins/<name>/.secret` (0600).

End register.

---

## Mode: test <plugin> <tool>

Goal: invoke a tool with sample args to verify functionality.

### Step 1 — Get tool schema

From plugin's manifest in `/api/plugin/list`.

### Step 2 — Build args

Prompt user for required fields, with sensible defaults shown. Reject invalid types.

### Step 3 — Sign + invoke

Build ISO 8601 ts (`new Date().toISOString()`), compute `HMAC-SHA256(plugin_token, ts + "\n" + body)`, POST to `/api/plugin/<name>/tools/<tool>/invoke` with headers `x-plus-ts` and `x-plus-signature`. Show response, audit entry, request_id.

### Step 4 — Show result

Pretty-print result + suggest follow-up if error (rerun with different args, check `/mcp inspect`).

End test.

---

## Mode: report

Goal: file a sanitized upstream issue if MCP bridge has a real bug.

Same flow as `tuner report` mode (see tuner.md):
1. User describes the symptom
2. Categorize (Critical / Perf / Detection / Doc)
3. Sanitize logs (paths, IPs, tokens)
4. Show draft, ask Post Now / Edit / Cancel
5. POST via `gh issue create --repo TerrysPOV/ClaudeClaw-Plus --label mcp-report`

End report.

---

## Mode: proxy-status

Goal: overview of the mcp-proxy warm pool — server states, crash counts, latency.

### Step 1 — Verify mcp-proxy registered

```bash
curl -s -H "Authorization: Bearer $(bun run src/plugins/cli.ts print-bootstrap-token)" http://localhost:4632/api/plugin/list | jq '.plugins[] | select(.name == "mcp-proxy")'
```

If not found: "mcp-proxy plugin not registered — daemon may be starting or mcp-proxy.json missing."

### Step 2 — Read pool state

```bash
curl -s http://localhost:4632/api/plugin/mcp-proxy/health
```

### Step 3 — Render table

```
## mcp-proxy pool status

| Server           | Status      | Crashes (5min) | Invocations today | p50 latency |
|------------------|-------------|----------------|-------------------|-------------|
| home-automation  | ✅ up        | 0              | 142               | 185ms       |
| brave-search     | ✅ up        | 0              | 17                | 220ms       |
| momentum-trader  | ❌ failed    | 5              | 0 (since failure) | —           |
```

### Step 4 — Suggest actions

- `crashed`: suggest `/mcp proxy-restart <server>`
- `failed` (5 crashes in 5 min, permanently stopped): daemon restart required — `systemctl --user restart claudeclaw.service`
- High p50 (>500ms): check server stderr log at `~/.cache/claudeclaw/mcp-proxy/<server>.log`
- Low invocations on an expected server: confirm callers are using `mode: "direct"` (not `reasoned`)

End proxy-status.

---

## Mode: proxy-restart <server>

Goal: restart a single crashed MCP server in the warm pool without restarting the full daemon.

### Step 1 — Confirm intent

> Restarting `<server>` will fail any in-flight tool calls for that server. Continue?

If no: End.

### Step 2 — Attempt restart

Check if the daemon exposes an admin restart tool via the bridge:
```bash
curl -s -H "Authorization: Bearer $(bun run src/plugins/cli.ts print-bootstrap-token)" http://localhost:4632/api/plugin/list | jq '.plugins[] | select(.name == "mcp-proxy") | .tools'
```

If a `mcp-proxy__restart_server` tool is listed: invoke it with `{"arguments": {"server": "<server>"}}`.

If not available (current release does not expose a restart tool): inform the user:
> In-process server restart requires daemon restart. Run:
> `systemctl --user restart claudeclaw.service`
> After restart, run `/mcp proxy-status` to verify the server comes up.

### Step 3 — Verify recovery

```bash
curl -s http://localhost:4632/api/plugin/mcp-proxy/health | jq '.servers["<server>"].status'
```

Wait up to 30s for status to go from `restarting` → `up`. Report final state.

End proxy-restart.

---

## Test catalog

Substrate guarantees are covered by 40+ tests. Browse them in the repo:

👉 [`src/__tests__/`](https://github.com/TerrysPOV/ClaudeClaw-Plus/tree/main/src/__tests__)

- `mcp_proxy_basic.test.ts` — register, call, concurrent, crash hook, allowedTools
- `mcp_proxy_security.test.ts` — HMAC, replay, stderr isolation, path traversal, body size cap
- `mcp_proxy_load.test.ts` — 50 concurrent, 200 sequential, slow-tool isolation
- `mcp_proxy_mode.test.ts` — direct/reasoned routing
- `mcp_proxy_audit_forensics.test.ts` — request_id propagation, event coverage, token leak prevention
- `mcp_proxy_crash_edges.test.ts` — counter reset boundary, backoff timing, shutdown race
- `mcp_proxy_reregister.test.ts` — atomicity, token invalidation during re-register
- `mcp_proxy_replay_precision.test.ts` — replay window edges (+1s, +14m59s, +15m01s, …)
- `plugins/http-gateway.test.ts` — register flow, HMAC verification, replay rejection, error format

Pointers to specific tests are more useful than reproducing assertions here — the suite is the source of truth.

## Reporting bugs or requesting features

For non-interactive reports (GUI/browser flow):

👉 [Open an issue](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues/new?labels=mcp)

Or use the `report` mode in this skill for assisted/sanitized issue creation through `gh issue create`.

---

## Self-improvement notes (for the framework that watches this skill)

Like the `tuner` skill, this `mcp` skill lives in the user's tunable surface and is itself a `TunableSubject` member. Frequent confusion or correction patterns on `/mcp` invocations would trigger framework proposals to refine these modes.

Special safeguards (same as tuner):
- `risk_tier: critical` (config override) — never auto-merge changes
- 30-day cool-down between accepted self-modifications
- Diff-mandatory on proposals
- Audit log entries tagged `event: meta_mcp_self_modify`

If you (Claude Code, reading this skill) are asked to modify mcp.md itself, surface the safeguards explicitly to the user before applying.

---

## Closing note

If you're unsure which mode applies, say so and ask the user. Modes can be combined (`/mcp list` then `/mcp inspect <picked>`) — sequential, not nested. The bridge endpoints are localhost-only by default — if user reports "can't reach plugin", first check that Plus daemon runs `--web` on :3000.
