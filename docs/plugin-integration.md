# Plugin Integration Guide

ClaudeClaw-Plus supports three tiers of plugin integration:

| Tier | Style | Use case |
|---|---|---|
| 1 | In-process TypeScript | Skills-tuner, compiled-in features |
| 2 | Subprocess JSON-RPC | ML backends (Optuna), Python scripts |
| 3 | HTTP daemon | voice-driven agent, retrieval daemon, cross-process tools |

---

## Tier 3 — HTTP Plugin (daemon-style)

Daemon-style plugins register themselves over HTTP and serve tool calls via a callback URL. Plus communicates with them via HMAC-signed POST requests.

### API endpoints (mounted when `--web` is active)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/plugin/register` | Bearer bootstrap | Register plugin + tools |
| `POST` | `/api/plugin/<n>/tools/<t>/invoke` | HMAC + timestamp | Invoke tool via callback |
| `DELETE` | `/api/plugin/<n>` | Bootstrap or plugin token | Unregister |
| `GET` | `/api/plugin/list` | Bearer bootstrap | List registered plugins + health |
| `GET` | `/api/plugin/<n>/health` | None | Proxy to plugin health_url |

### Security model

- **Bootstrap token**: 32-byte secret at `~/.config/plus/plugin-bootstrap.secret` (0600). Printed once at first start. Retrieve with `bun run src/plugins/cli.ts print-bootstrap-token`.
- **Per-plugin token**: returned at registration time, used for HMAC signing on subsequent invocations. Store securely in the daemon process.
- **HMAC**: `HMAC-SHA256(secret, "{ts}\n{body}")` where `ts` is ISO-8601 UTC, `body` is JSON-serialized raw. Sent in headers `x-plus-ts` (the timestamp string) and `x-plus-signature` (hex-encoded digest).
- **Replay window**: 15 minutes, bidirectional (`Math.abs(now - ts) > 900_000ms` rejected as `stale_or_future_timestamp`).
- **Callback allowlist**: by default, only `localhost` / `127.0.0.1` / `::1` are allowed as callback hosts.

### Authentication contract

Every `/invoke` call must include:
- Header `x-plus-ts`: ISO 8601 UTC timestamp (e.g. `2026-05-11T12:34:56.000Z`)
- Header `x-plus-signature`: hex-encoded SHA-256 HMAC of `<ts>\n<body>` using the per-plugin token returned at register time

Reference implementations:
- TypeScript: `` createHmac('sha256', token).update(`${ts}\n${body}`).digest('hex') ``
- Python: `hmac.new(token_bytes, (ts + "\n" + body).encode(), hashlib.sha256).hexdigest()`

The body is signed **raw** — do not re-serialize the JSON between signing and sending, or
byte-order differences (e.g. Python default separators vs JS) will break verification.

### Standard error format

All errors return JSON:

```json
{
  "error": {
    "code": "invalid_signature",
    "message": "HMAC verification failed",
    "plugin": "voice-agent",
    "request_id": "a1b2c3d4e5f6a7b8",
    "ts": "2026-05-09T20:00:00.000Z"
  }
}
```

`request_id` is echoed from `X-Plus-Request-Id` if provided, or generated. Include it in bug reports for cross-process forensics.

---

## Voice agent plugin — Python example

```python
import os, json, hmac, hashlib, requests
from flask import Flask, request, jsonify

# ── Registration ──────────────────────────────────────────────────────────────

PLUS_URL = "http://localhost:3000"
BOOTSTRAP_SECRET_PATH = os.path.expanduser("~/.config/plus/plugin-bootstrap.secret")

manifest = {
    "name": "voice-agent",
    "version": "1.0.0",
    "schema_version": 1,
    "callback_url": "http://localhost:8765/plus-callback",
    "health_url": "http://localhost:8765/health",
    "tools": [
        {
            "name": "send_tts",
            "description": "Play TTS in active call",
            "schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        },
        {
            "name": "get_call_status",
            "description": "Return current call status",
            "schema": {"type": "object", "properties": {}},
        },
    ],
    "capabilities": ["tools"],
}

bootstrap_token = open(BOOTSTRAP_SECRET_PATH, "rb").read().hex()
resp = requests.post(
    f"{PLUS_URL}/api/plugin/register",
    headers={"Authorization": f"Bearer {bootstrap_token}"},
    json=manifest,
)
resp.raise_for_status()
data = resp.json()
PLUGIN_TOKEN_HEX = data["plugin_token"]
print(f"Registered {data['plugin_name']} — tools: {data['registered_tools']}")

# ── Callback server ───────────────────────────────────────────────────────────

app = Flask(__name__)

def verify_plus_hmac(body_bytes: bytes, ts: str, sig: str) -> bool:
    secret = bytes.fromhex(PLUGIN_TOKEN_HEX)
    expected = hmac.new(secret, f"{ts}\n{body_bytes.decode()}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

@app.route("/plus-callback", methods=["POST"])
def handle_callback():
    ts = request.headers.get("X-Plus-Ts", "")
    sig = request.headers.get("X-Plus-Signature", "")
    body_bytes = request.get_data()
    if not verify_plus_hmac(body_bytes, ts, sig):
        return jsonify({"error": "invalid_signature"}), 401
    payload = json.loads(body_bytes)
    tool = payload["tool"]
    args = payload.get("args", {})
    if tool == "send_tts":
        # ... your TTS logic here ...
        return jsonify({"result": {"played": True, "text": args.get("text")}})
    elif tool == "get_call_status":
        return jsonify({"result": {"status": "idle"}})
    return jsonify({"error": "unknown_tool"}), 400

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(port=8765)
```

---

## Archiviste plugin — Python example

```python
import os, json, hmac, hashlib, requests
from flask import Flask, request, jsonify

PLUS_URL = "http://localhost:3000"
BOOTSTRAP_SECRET_PATH = os.path.expanduser("~/.config/plus/plugin-bootstrap.secret")

manifest = {
    "name": "retrieval-daemon",
    "version": "1.0.0",
    "schema_version": 1,
    "callback_url": "http://localhost:8766/plus-callback",
    "health_url": "http://localhost:8766/health",
    "tools": [
        {
            "name": "search",
            "description": "Full-text search across archived documents",
            "schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "trusted_only": {"type": "boolean", "default": True},
                },
                "required": ["query"],
            },
        },
    ],
    "capabilities": ["tools"],
}

bootstrap_token = open(BOOTSTRAP_SECRET_PATH, "rb").read().hex()
resp = requests.post(
    f"{PLUS_URL}/api/plugin/register",
    headers={"Authorization": f"Bearer {bootstrap_token}"},
    json=manifest,
)
resp.raise_for_status()
PLUGIN_TOKEN_HEX = resp.json()["plugin_token"]

app = Flask(__name__)

def verify_plus_hmac(body_bytes: bytes, ts: str, sig: str) -> bool:
    secret = bytes.fromhex(PLUGIN_TOKEN_HEX)
    expected = hmac.new(secret, f"{ts}\n{body_bytes.decode()}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

@app.route("/plus-callback", methods=["POST"])
def handle_callback():
    ts = request.headers.get("X-Plus-Ts", "")
    sig = request.headers.get("X-Plus-Signature", "")
    body_bytes = request.get_data()
    if not verify_plus_hmac(body_bytes, ts, sig):
        return jsonify({"error": "invalid_signature"}), 401
    payload = json.loads(body_bytes)
    tool = payload["tool"]
    args = payload.get("args", {})
    if tool == "search":
        import subprocess
        result = subprocess.check_output([
            "python3",
            os.path.expanduser("<retrieval-daemon>/vectorize.py"),
            "--search", args["query"],
            *(["--trusted-only"] if args.get("trusted_only", True) else []),
        ]).decode()
        return jsonify({"result": {"hits": result}})
    return jsonify({"error": "unknown_tool"}), 400

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(port=8766)
```

---

## mcp-proxy: fast path for non-Claude consumers

For non-Claude daemon-resident integrations (voice agents, retrieval systems, automation
bridges), the inject path is too slow (~3000ms per call). The `mcp-proxy` plugin provides
a warm-pooled fast path: long-lived stdio connections to configured MCP servers, exposed
as `/api/plugin/mcp-proxy/tools/{server}__{tool}/invoke`.

| Path | Latency | Auth | Audit |
|---|---|---|---|
| Direct API call | ~50ms | None | None |
| `/api/inject` (Claude in loop) | ~3000ms | Bearer apiToken | No |
| mcp-proxy (this release) | ~200ms | HMAC plugin token | Yes |

See `docs/mcp-proxy.md` for configuration and routing mode details.

---

## Deferred to follow-up PRs

The following features are known gaps but explicitly deferred:

| Feature | Rationale |
|---|---|
| Hash-chained audit log | Nice-to-have for tamper evidence; no concrete demand yet |
| Strict capability enforcement | Currently declared but not enforced; no capability-based blocking needed at v0 |
| TLS enforcement for non-localhost | All current use cases are local; add when cross-machine relay is needed |
| Token rotation endpoint | Re-register replaces the plugin token; no separate endpoint needed at v0 |

File issues on this repo to promote any of these.
