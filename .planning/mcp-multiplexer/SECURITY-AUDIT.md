# MCP Multiplexer — Phase D Security Audit

**Worktree**: `feat/mcp-multiplexer-integration` at HEAD `d89a956`
**Auditor**: security-auditor (read-only review, no source changes)
**Date**: 2026-05-15
**Issue**: TerrysPOV/ClaudeClaw-Plus#64
**Scope**: pre-code-review security pass; gates "Approve / Approve with conditions / Reject" before operator merge.

> Note on inputs. `.planning/mcp-multiplexer/SPEC.md` was referenced in the task brief but is not present in this worktree (only `W1-COORD.md` ships here, and git shows it has never been committed under any branch in this repo). The audit is therefore grounded in W1-COORD.md + the code as it stands. Where I cite "SPEC §X" I am quoting the inline source comments that pin the contract.

---

## Executive verdict

**APPROVE WITH CONDITIONS.**

The bearer-as-secret + loopback-only + 0600-at-rest envelope holds under the stated threat model. Implementation is tighter than W1-COORD.md promises: timing-safe comparison, strict `ptyId` regex, dormant-by-default activation, defense-in-depth on host binding, and complete identity/route teardown on every dispose path. No critical findings.

Three medium-severity items must be addressed (or consciously deferred to a follow-up) before flipping `pty.enabled: true` in production:
1. The `bearer` string is included in the `PtyIdentity` object exposed by `issueIdentity()` and is therefore reachable by any future code path that logs the identity object. Right now nothing does — but there is no defensive `toJSON`/redaction guard. **Medium / NEEDS-WORK.**
2. `/mcp/<server>` has no rate-limit, request-size, or per-bearer flood-control. `/api/plugin/*` has HMAC + 15-min replay window; `/mcp/*` has bearer-only. The exposure surface is loopback-only, so the realistic attacker is a same-UID misbehaver, but the operator should agree this is acceptable for v1. **Medium / NEEDS-WORK.**
3. The `.claudeclaw/` directory at PTY `cwd` is created with `0700` only on first write — if the directory already exists with looser perms, the writer "doesn't fight the operator" (comment in `pty-mcp-config-writer.ts:172-176`). That means a pre-existing `.claudeclaw/` at e.g. `0755` will silently host `mcp-pty-<id>.json` files (the *file* mode 0600 still protects the bearer), but the directory listing leaks ptyIds to other UIDs. Tighten or document. **Low / NEEDS-WORK.**

**Traffic light per audit-checklist item:**

| # | Item | Verdict |
|---|------|---------|
| 1 | Bearer-as-secret envelope | PASS |
| 2 | Constant-time bearer comparison | PASS |
| 3 | `ptyId` validation | PASS |
| 4 | Replay-window drop | PASS (acceptable) |
| 5 | `/mcp/*` rate-limit gap | NEEDS-WORK (Medium) |
| 6 | Loopback enforcement | PASS |
| 7 | Plain HTTP on loopback | PASS |
| 8 | Outbound routes | PASS |
| 9 | Config-file mode 0600 | PASS-with-caveat (file mode is right; directory hardening is best-effort) |
| 10 | Secret-in-memory leak surface | NEEDS-WORK (Medium — `PtyIdentity.bearer` is reachable) |
| 11 | Identity revocation completeness | PASS |
| 12 | Synthesised config cleanup | PASS |
| 13 | Upstream child trust | PASS (env inheritance is SDK-filtered) |
| 14 | `allowedTools` filter | PASS |
| 15 | Crash audit events | PASS |
| 16 | Identity issuance/release audit | PASS |
| 17 | No bearer in audit | PASS |
| 18 | Dormant-by-default | PASS |
| 19 | Activation gate | PASS |
| 20 | Rollback path | PASS |
| 21 | DoS-via-spawn | PASS (5-crashes-in-5-min → permanent failure) |
| 22 | Spawn-time poisoning | OUT-OF-SCOPE (same-UID attacker) |
| 23 | FQN collision | PASS |

---

## Findings

### #1 Bearer-as-secret envelope is defensible — but document the assumption explicitly  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-multiplexer/pty-identity.ts:1-58`, `.planning/mcp-multiplexer/W1-COORD.md:9-58`

The original SPEC §4.3 required a per-request HMAC over `(method, path, ts, body-sha256)`. Claude Code's stock MCP HTTP client only sends a static `headers` map, so per-request signing is not implementable client-side. The team fell back to:

- Per-PTY 32-byte secret minted on `issueIdentity()`.
- Bearer = `Bearer <hex(secret)>` — the literal secret IS the credential.
- Rotation on every PTY respawn (`pty-supervisor.ts:993-1001`) and on every fresh spawn (`pty-supervisor.ts:785, 834`).
- Constant-time comparison server-side.

The realistic exploitation paths against this envelope are:

| Path | Mitigated by | Residual risk |
|------|--------------|---------------|
| Network sniff of bearer | Loopback-only bind + plain HTTP is fine on lo0 | None |
| Bearer at rest in synthesised config | File mode 0600, parent dir 0700 | Same-UID attacker only (already game over) |
| Bearer in process memory (core dump) | Secret rotation on respawn | Brief window between crash and respawn (`pty-supervisor.ts:993-995` correctly documents this) |
| Cross-PTY replay (PTY A's bearer hits PTY B's route) | `verifyBearer(ptyId, ...)` looks up the secret bound to `ptyId` from the asserted `X-Claudeclaw-Pty-Id` header — wrong ptyId → no match | None (well-designed) |
| Stolen bearer used by a long-running script | No timestamp window; rotation only on respawn (`pty.idleReapMinutes`, default 30) | Bearer is valid for up to 30 min after theft from a same-UID attacker. Acceptable per the stated trust boundary. |

**Recommendation**: keep the design. Add a one-line comment on `verifyBearer` confirming the cross-PTY-replay defense ("the asserted ptyId scopes the lookup; a stolen `(bearer, ptyIdA)` pair cannot pivot to ptyIdB") so a future reviewer doesn't accidentally remove that lookup.

---

### #2 Constant-time bearer comparison via `timingSafeEqual` — confirmed  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/pty-identity.ts:148-173`

`verifyBearer` uses `crypto.timingSafeEqual` on equal-length `Buffer`s. Length-mismatch short-circuits to `false` before the constant-time call, which is the standard Node.js pattern and acceptable (the length is not secret material). Hex decoding tolerates case-insensitive `bearer` scheme prefix and rejects malformed hex via `try/catch`.

One micro-nit: the regex `/^bearer\s+([0-9a-f]+)$/i` accepts any non-empty hex string, then `Buffer.from(hex, "hex")` silently truncates odd-length input. The length comparison at L167 still catches it (truncation → wrong length → false), so the early-exit semantics are correct. No change needed.

---

### #3 `ptyId` validation is restrictive enough  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/pty-identity.ts:74-81`

Regex `^[A-Za-z0-9_.:-]+$`, 1–128 chars. This is enforced both at `issueIdentity` and via the HTTP-handler path (the handler receives `ptyId` from the `X-Claudeclaw-Pty-Id` header but only uses it as a Map key for `identities.get(ptyId)` and as an audit field — no path component, no shell interpolation).

Path-traversal surface in the synthesised config file (`pty-mcp-config-writer.ts:90`):
```
join(cwd, ".claudeclaw", `mcp-pty-${ptyId}.json`)
```
The regex rejects `/`, `\`, `..`, and whitespace, so `mcp-pty-../../etc/passwd.json` cannot be constructed. **PASS.**

Header-injection surface: `X-Claudeclaw-Pty-Id` is set on every request from the synthesised config; allowed chars don't include CR/LF, so no header smuggling. **PASS.**

One observation: the `.` and `:` characters are in the allowed set. `.` enables `.` and `..` as full strings IF they were not blocked by the `^[A-Za-z0-9_.:-]+$` anchored match — let me re-check: `.` matches the regex (the `.` character is literal inside a character class). So `ptyId = "."` or `".."` is technically a valid ptyId. The resulting filename `mcp-pty-..json` and `mcp-pty-...json` are still safely inside `.claudeclaw/`. No traversal possible. **PASS.**

---

### #4 Replay window dropped — defensible given rotation semantics  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-multiplexer/pty-identity.ts:36-40, 92`, W1-COORD.md §"Issuance timestamp"

SPEC originally specified a ±5-minute replay window on `X-Claudeclaw-Ts`. W1 dropped enforcement because the stock client re-sends the same headers verbatim for the lifetime of the PTY, so the window would expire tokens within seconds. The timestamp is now carried only for audit observability (`audit("multiplexer_identity_issued", { issued_at })`).

This shifts replay protection entirely to rotation:
- Fresh spawn → new secret (`pty-supervisor.ts:785, 834` via `issueIdentity`).
- Respawn → new secret (`pty-supervisor.ts:1000-1010` calls `synthesizeMcpConfigIfActive` which re-issues).
- Idle-reap → `releaseMcpIdentityFor` revokes the secret (`pty-supervisor.ts:1177`).
- Operator `/kill` → `killAllPtys` revokes every secret (`pty-supervisor.ts:484`).

The trade-off (longer-lived bearer in exchange for client-side compatibility) is reasonable. **PASS.**

One observability gap: `X-Claudeclaw-Ts` is *audited* on issuance but NOT on inbound request — `multiplexer_invoke` audit (`http-handler.ts:154-160`) does not include the timestamp the client sent. Forensics could not later prove "this invocation used a bearer issued at T". Low-priority but worth filing. **Recommendation**: add `ts: req.headers.get(PTY_TS_HEADER)` to the `multiplexer_invoke` payload.

---

### #5 `/mcp/<server>` has no rate-limit or body-size cap  [SEVERITY: Medium] [VERDICT: NEEDS-WORK]

**Files**: `src/plugins/mcp-multiplexer/http-handler.ts:97-184`, `src/plugins/http-gateway.ts:66-72`

`/api/plugin/*/invoke` has:
- `MAX_BODY_BYTES = 1_048_576` cap (`http-gateway.ts:24, 207-217`).
- HMAC body signing (`http-gateway.ts:224-226`).
- `REPLAY_WINDOW_MS = 15 * 60_000` (`http-gateway.ts:22, 228-231`).
- 30s invoke timeout (`PLUGIN_INVOKE_TIMEOUT_MS`).

`/mcp/<server>` has:
- Bearer comparison.
- 30s upstream call timeout (`server-process.ts:25, 132-147`).
- **No body-size cap.** `http-handler.ts:60-73` (`_readBody`) clones the request for audit peek but does not enforce a cap; the SDK's `WebStandardStreamableHTTPServerTransport.handleRequest()` parses JSON without an explicit cap.
- **No rate limit per bearer.** A misbehaving PTY-resident `claude` (or a same-UID attacker holding a stolen bearer) can flood `/mcp/<server>/tools/call` until the upstream child's 30s timeout fires repeatedly.

**Realistic exploitation**: the attacker is same-UID, so they could simply spawn `bun src/...` directly and bypass everything. Defense-in-depth would still help by capping resource exhaustion (memory: a 4 GB POST body would OOM the daemon; CPU: a tight loop of `tools/call` against graphiti could saturate Neo4j).

**Recommendation**:
1. Add a body-size cap mirroring `MAX_BODY_BYTES` at the top of `McpHttpHandler.handle()` (before the auth check or right after, so we don't burn the read for unauthenticated requests). Reject with `413 body_too_large`.
2. Add a minimal per-bearer token-bucket (e.g. 100 req/s, burst 200). One in-memory `Map<ptyId, { tokens, lastRefillMs }>`; ~30 LOC.

Either action defensible to defer to a v1.1 follow-up — but the body-size cap is cheap enough that it should land before flipping `pty.enabled: true`.

---

### #6 Loopback enforcement — absolute  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/index.ts:166-178`

```ts
if (settings.webHost !== "127.0.0.1" && settings.webHost !== "localhost") {
  console.error(`[mcp-multiplexer] dormant — gateway host '${...}' is non-loopback; refusing to expose MCP routes externally.`);
  getMcpBridge().audit("multiplexer_refused_non_loopback", { host: settings.webHost });
  return;
}
```

The refusal is absolute — there is no escape hatch via env var or settings flag. Even if `settings.web.host = "0.0.0.0"`, the multiplexer goes dormant and audits the rejection. The HTTP gateway itself still binds on whatever `web.host` is set to (a separate concern), but `/mcp/*` routes are not registered and `mcpHandlers` map is empty → `handleRequest` returns `404 mcp_server_not_registered`. **PASS.**

One minor: `"localhost"` is allowed but resolves dynamically. On a host where `/etc/hosts` has been tampered with by a same-UID attacker, `localhost` could in theory resolve to a non-loopback address. That would be a same-UID compromise scenario (out of scope) — but if you want belt-and-braces, you could resolve at startup and refuse anything outside `127.0.0.0/8` and `::1`. Low priority.

---

### #7 Plain HTTP on loopback — defensible  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/index.ts:201-202`

```ts
this.cachedBridgeBaseUrl = this.bridgeBaseUrlOverride ?? `http://${settings.webHost}:${settings.webPort}`;
```

Loopback traffic is process-local; TLS would add startup latency and certificate management overhead with no realistic threat to defend against (same-UID attackers can read socket buffers regardless). **PASS.**

---

### #8 No outbound network calls from the multiplexer  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-multiplexer/index.ts`, `src/plugins/mcp-multiplexer/http-handler.ts`, `src/plugins/mcp-proxy/server-process.ts`

`McpHttpHandler.handle()` proxies straight through to `this.proc.call(name, args)` (`http-handler.ts:246-249`), which dispatches over the upstream child's stdio transport (`server-process.ts:137-147`). No `fetch`, no socket, no third-party HTTP client. The only "outbound" path is the upstream child itself, which is bounded by what the operator put in `mcp-proxy.json`.

`getHttpGateway().registerInProcess` (`http-gateway.ts:371-401`) and the bridge-callback path (`index.ts:479-502`) also stay in-process. **PASS.**

---

### #9 Synthesised config file mode  [SEVERITY: Low] [VERDICT: PASS-with-caveat]

**File**: `src/runner/pty-mcp-config-writer.ts:80-188`

- File: `writeFileSync(path, ..., { mode: 0o600 })` (L185-188). On first write the file is created with 0600.
- Directory: `mkdirSync(dir, { recursive: true, mode: 0o700 })` (L173-176) — but only IF the directory doesn't exist. The writer explicitly chooses not to `chmod` an existing `.claudeclaw/` directory (comment L171-176).
- Re-writes: when the file already exists, `writeFileSync` overwrites the bytes but doesn't change the mode. Comment L178-184 documents this and reasons it's safe because the file we created in a prior turn already has 0600.

**Caveat**: if an operator (or an attacker who already has same-UID) deliberately runs `chmod 0644 ${cwd}/.claudeclaw/mcp-pty-<id>.json`, the next `writeConfigForPty` call will overwrite the contents WITHOUT restoring 0600. The file-mode flag is "create-time only" on most platforms (the comment correctly says so). Same-UID attacker = out of scope, but...

**Recommendation (low priority)**: defensively `chmodSync(path, 0o600)` after `writeFileSync`. Three lines, removes the entire "what if perms got loosened" branch.

**On the directory**: if `.claudeclaw/` already exists with looser perms (e.g. 0755 from some prior tooling), the directory listing is world-readable. The bearer secret is inside the FILE (still 0600), but the directory listing reveals ptyIds and timestamps, which are minor. **Recommendation**: `chmodSync(dir, 0o700)` after the existence check would close this. ~2 lines.

---

### #10 `PtyIdentity.bearer` is reachable on the exposed object  [SEVERITY: Medium] [VERDICT: NEEDS-WORK]

**File**: `src/plugins/mcp-multiplexer/pty-identity.ts:44-95`

```ts
export interface PtyIdentity {
  ptyId: string;
  issuedAt: number;
  bearer: string;            // `Bearer <hex>` — the secret in cleartext
  headers: Record<string, string>;
}
```

`issueIdentity` returns this object to the supervisor; the supervisor passes it to `writeConfigForPty` which embeds `identity.headers` (containing the bearer) into the on-disk JSON. That path is correct.

The risk surface is **other callers** that might receive the same object:
1. `getMcpMultiplexerPlugin().issueIdentity(ptyId)` (`index.ts:404-413`) — the public method also audits `{ pty_id, issued_at }` with NO bearer. Good.
2. `getIdentity(ptyId)` (`pty-identity.ts:121-124`) — exported, returns the full public identity including bearer. No callers in tree today, but exposed.
3. If a future debug/dump-state path adds `JSON.stringify(getIdentity(ptyId))`, the bearer leaks to disk/logs.

**Verification done**: no audit-event payload anywhere in the tree includes `bearer`, `secret`, or `identity` verbatim. `rg -n "audit\(" src/plugins/mcp-multiplexer/` shows only `multiplexer_identity_issued { pty_id, issued_at }`, `multiplexer_identity_released { pty_id }`, `multiplexer_auth_rejected { server, pty_id }`, `multiplexer_invoke { server, pty_id, stateless, rpc_method }`. **No bearer in any audit.** **PASS** for #17.

**But** the surface remains: `PtyIdentity` is a plain object and `bearer` is enumerable. A future reviewer who adds `console.error('[debug]', getIdentity(ptyId))` ships the secret to stderr → daemon log → potentially Sentry → possibly shared with developers.

**Recommendation**: one of:
- (a) Replace the `bearer` field with a `getBearer()` accessor and make the public type not expose it directly.
- (b) Add a `toJSON()` method on the `PtyIdentity` (use a class instead of an interface) that returns `{ ptyId, issuedAt, '[bearer]': '<redacted>' }`. The supervisor and writer already access `identity.headers` (which still has the cleartext bearer in the headers map), so `toJSON` won't affect them as long as they don't `JSON.stringify(identity)`.
- (c) Stop returning `bearer` separately — the writer only reads `identity.headers`, and the bearer string is already in there. Drop the `bearer` field entirely from the public interface; keep it as a derived value internal to `_toPublic`. This is the cleanest fix.

Option (c) is the most defensible: it makes the type-system enforce "you don't get the bearer on its own" while the on-the-wire path is unchanged.

---

### #11 Identity revocation drops secret AND per-PTY transport buckets  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-multiplexer/index.ts:415-425`, `src/plugins/mcp-multiplexer/http-handler.ts:186-199`

```ts
async releaseIdentity(ptyId: string): Promise<void> {
  const removed = _revokeIdentity(ptyId);                                    // drops secret
  await Promise.allSettled(
    [...this.handlers.values()].map((h) => h.releasePty(ptyId)),             // drops per-PTY transports
  );
  if (removed) {
    getMcpBridge().audit("multiplexer_identity_released", { pty_id: ptyId });
  }
}
```

`releasePty(ptyId)` (`http-handler.ts:186-199`) deletes the bucket from the map and closes both the SDK server and the transport. Idempotent — safe to call for a never-issued ptyId.

~~For stateless servers, `releasePty` is a no-op because the bucket is keyed on `STATELESS_BUCKET` not `ptyId`.~~ **Superseded.** The bucket collapse this described was removed: a bucket is the client-facing MCP session, and an MCP session cannot be shared by two clients, so a collapsed bucket made a stateless server single-client (the second client's `initialize` drew `400 -32600 "Server already initialized"` and it dropped the server). Buckets are now keyed on `ptyId` for every server, `stateless` included, and `releasePty` tears them down uniformly.

The residual worth knowing is unchanged and unrelated to keying: the upstream child is a single shared process for every bucket either way, so if a shared server holds per-PTY state inside its own process (e.g. graphiti's `group_id`), that state outlives any one PTY.

`stop()` (`index.ts:287-307`) tears down everything in order: stop probe → unregister plugin from bridge → unregister gateway routes → stop handlers → stop server processes → clear caches. **PASS.**

---

### #12 Synthesised config cleanup  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/runner/pty-supervisor.ts:866-891`, `pty-mcp-config-writer.ts:199-209`

`releaseMcpIdentityFor(entry)` is called from:
- L297 — `__resetSupervisorForTests` (fire-and-forget; tests only)
- L439 — `shutdownSupervisor` (daemon shutdown)
- L484 — `killAllPtys` (operator `/kill`)
- L696 — LRU eviction
- L959 — failed spawn cleanup
- L1177 — idle reap

`deleteConfigForPty` (`pty-mcp-config-writer.ts:199-209`) swallows ENOENT (file already gone) and re-throws other errors (which the supervisor catches and ignores at the call sites with `try/catch`). Idempotent.

**Orphan-file scenarios checked**:
- Daemon crash with files left behind: yes, the files persist on disk with mode 0600 — the secrets in them are dead (in-memory store is gone, so verifyBearer will fail), so no security impact. Cosmetic.
- PTY dispose during respawn: `respawnEntry` (L981-1031) does NOT call `releaseMcpIdentityFor` — correct, because the ptyId is the same and the next write idempotently overwrites the file.
- spawnEntry throws AFTER synthesis but BEFORE pty.dispose: L955-961 catches this and calls `releaseMcpIdentityFor`. Good.

**One subtle thing**: `deleteConfigForPty(cwd, ptyId)` requires the cached `cwd` (`pty-supervisor.ts:868`). If the entry has no cached cwd (mid-spawn before `entry.spawnOpts` is set), the path is computed-but-never-deleted and there's nothing to delete (because nothing was written). The guard at L884 (`if (cfgPath && cwd)`) handles this correctly. **PASS.**

---

### #13 Upstream child trust — env inheritance is SDK-filtered  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-proxy/server-process.ts:60-67`, `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:8-41`

The `StdioClientTransport` from `@modelcontextprotocol/sdk` does NOT inherit `process.env` wholesale. It uses `DEFAULT_INHERITED_ENV_VARS` — a sudo-style allowlist (HOME, PATH, USER, LANG, LC_*, TERM, TMPDIR on Unix; the equivalent set on Windows) merged with the explicit `this.config.env`. **`ANTHROPIC_API_KEY` is NOT in the default-inherited set** — confirmed via grep.

Practical implication: a compromised graphiti server cannot reach the operator's Anthropic API key through its environment. It CAN read whatever the operator put in `mcp-proxy.json`'s `env:` block for that server (which is intentional — that's how operators pass NEO4J_URI, OPENAI_API_KEY for embeddings, etc.).

The child runs under the operator's UID with the operator's filesystem access — so a malicious child can read any file the operator can read. That's the inherent trust boundary of running third-party code, and it's unchanged by this milestone (mcp-proxy had the same exposure pre-multiplexer).

**Cross-PTY data exposure**: a stateful upstream child (non-stateless) sees one `(ptyId)` bucket per PTY (`http-handler.ts:225-282`). Each bucket has its own SDK Server instance and a fresh `randomUUID()` session ID. The bucket is isolated at the JSON-RPC session level, but the underlying upstream process is shared — so if graphiti aggregates by group_id internally, that aggregation is cross-PTY. **This is by design** (the whole point of the multiplexer) but should be in the operator-facing docs: "shared MCP servers share state across PTYs at the upstream-process level".

**PASS.**

---

### #14 `allowedTools` filter — enforced at the upstream layer, inherited by the multiplexer  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-proxy/server-process.ts:113-120`

```ts
const allowed = this.config.allowedTools;
this.tools = tools
  .filter((t) => !allowed || allowed.includes(t.name))
  .map(...);
```

`McpServerProcess.tools` is filtered at startup. The multiplexer's `tools/list` handler (`http-handler.ts:235-243`) reads `this.proc.tools.map(...)`, so the filter is inherited automatically. `tools/call` (`http-handler.ts:246-268`) calls `this.proc.call(name, args)` which dispatches via the SDK client — the upstream child sees the tool name, but `McpServerProcess.call` doesn't re-check `allowedTools`. If a malicious PTY-resident `claude` tries to call a non-allowed tool, the upstream child receives the call and either responds with "unknown tool" or executes it (if the allowlist is purely advisory).

**Risk**: defense-in-depth would re-check `allowedTools` in `McpServerProcess.call()` before dispatching to the upstream. Currently the only enforcement is at `listTools` time. If the upstream child added a tool dynamically (uncommon) or honored a name the allowlist excluded (depends on upstream), the filter could be bypassed.

**Recommendation (low priority)**: add a defensive check in `McpServerProcess.call()`:
```ts
if (this.config.allowedTools && !this.config.allowedTools.includes(tool)) {
  throw new Error(`Tool '${tool}' is not in allowedTools for ${this.name}`);
}
```
Three lines, eliminates the bypass surface.

**Verdict for this PR**: PASS (the inheritance is correct; the bypass surface is a pre-existing mcp-proxy property, not a multiplexer regression).

---

### #15 Crash audit events — covered  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-multiplexer/index.ts:341-366, 465-477`, `src/plugins/mcp-proxy/index.ts:190-201`, `src/plugins/mcp-proxy/server-process.ts:174-198`

State transitions and their audit events:

| Transition | Event | File:Line |
|------------|-------|-----------|
| Server first comes up (multiplexer) | `multiplexer_server_ready` | `index.ts:254-258` |
| Server crash (multiplexer) | `multiplexer_server_crashed` | `index.ts:467-473` |
| Health degraded (multiplexer probe) | `mcp_health_degraded` | `index.ts:351-359` |
| Health transition (multiplexer probe) | `mcp_health_transition` | `index.ts:351-359` |
| Server crash (mcp-proxy) | `mcp_proxy_server_crashed` | `mcp-proxy/index.ts:194` |
| Server permanently failed (mcp-proxy) | `mcp_proxy_server_permanently_failed` | `mcp-proxy/index.ts:199` |
| Identity issued | `multiplexer_identity_issued` | `index.ts:407-411` |
| Identity released | `multiplexer_identity_released` | `index.ts:422-424` |
| Auth rejected | `multiplexer_auth_rejected` | `http-handler.ts:114-117` |
| Invocation | `multiplexer_invoke` | `http-handler.ts:155-160` |
| Refused non-loopback | `multiplexer_refused_non_loopback` | `index.ts:173-176` |
| Dormant (web disabled) | `multiplexer_dormant_web_disabled` | `index.ts:185-187` |
| Dormant (empty shared) | `multiplexer_dormant_empty_shared` | `index.ts:192-194` |
| No config | `multiplexer_no_config` | `index.ts:209-211` |
| mcp-proxy skip-shared | `mcp_proxy_skip_shared` | `mcp-proxy/index.ts:86` |

Coverage is complete. The crash chain `transport.onclose → _handleCrash → onCrash hook → audit` is wired (`server-process.ts:87-95 → 174-198`, `mcp-proxy/index.ts:190-201`, `index.ts:228-231 → 465-477`).

Missing a permanent-failure audit for the multiplexer specifically — `mcp-proxy` emits `mcp_proxy_server_permanently_failed` but the multiplexer doesn't have an equivalent `multiplexer_server_permanently_failed`. The crash hook (`index.ts:465`) is called for both crash and failed states, so the audit fires for failure but uses the same `multiplexer_server_crashed` event with `status: "failed"`. That's serviceable but harder to alert on.

**Recommendation (low priority)**: split the audit into `multiplexer_server_crashed` (transient) and `multiplexer_server_permanently_failed` (terminal), mirroring `mcp-proxy`. Or, document that operators should grep for `status: "failed"` in `multiplexer_server_crashed` events.

---

### #16 Identity issuance/release audit — covered  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/index.ts:404-425`

Every public `issueIdentity` call audits `multiplexer_identity_issued`. Every public `releaseIdentity` call audits `multiplexer_identity_released` (but only if a secret was actually removed — `removed` flag at L420 prevents spurious events for unknown ptyIds).

Bypass paths to check:
- Direct calls to the underlying `_issueIdentity` (`pty-identity.ts:106`) — exported as `issueIdentity` from the module. If a future caller imports `issueIdentity` directly from `pty-identity.ts` (not from `index.ts`), it bypasses the audit. **Recommendation**: rename the bare function to `_issueIdentityRaw` or move the audit into the bare function. Keep the public API in `index.ts` as the only audited path.
- `_resetIdentityStore()` (`pty-identity.ts:185-187`) — clears the entire map without auditing each release. Test-only, so acceptable.

---

### #17 No bearer/secret in any audit payload  [SEVERITY: Info] [VERDICT: PASS]

**Verification**:
```
rg -n "audit\(" src/plugins/mcp-multiplexer/ src/plugins/mcp-proxy/ src/runner/pty-supervisor.ts
```
All audit calls inspected. No occurrence of `bearer`, `secret`, `record.secret`, or `identity.headers` in any audit payload. `identity` (the full object) is never passed to `audit()`. **PASS.**

---

### #18 Dormant-by-default  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/config.ts:105-112`, `src/plugins/mcp-multiplexer/index.ts:190-196`

Default `settings.mcp.shared = []` (`config.ts:108`). Multiplexer `start()` checks this at L190-196 and bails before spawning anything, before mounting any route, before issuing any identity. The supervisor's `synthesizeMcpConfigIfActive` (`pty-supervisor.ts:813-855`) returns `undefined` on empty `shared` (L818-819), so the PTY path is byte-identical to the pre-milestone code.

**Code-trace verification**: walked from `start()` to confirm three short-circuits exist (loopback, web-enabled, shared non-empty), each emitting an audit event before returning. No early-return path leaves zombie state. `this.active = false`, `this.started = true` (so a second `start()` is idempotent), `this.cachedSharedNames = []`. **PASS.**

---

### #19 Activation gate — settings.web.enabled + settings.mcp.shared + 127.0.0.1  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/index.ts:166-196`

Three checks, in this order:
1. `settings.webHost !== "127.0.0.1" && settings.webHost !== "localhost"` → audit + return (L166-178).
2. `!settings.webEnabled` → audit + return (L180-188).
3. `settings.shared.length === 0` → audit + return (L190-196).

All three must pass before any spawn happens. The supervisor's `synthesizeMcpConfigIfActive` independently checks `shared.length > 0 && web.enabled && _mcpIssueIdentity != null` (`pty-supervisor.ts:818-833`) — three-of-three before synthesis. **PASS.**

---

### #20 Rollback — flipping `settings.mcp.shared = []` and reloading  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-multiplexer/index.ts:287-307`

`stop()` performs ordered teardown:
1. `started = false`, `active = false`
2. Stop health probe + clear `lastObservedStatus`
3. Unregister plugin from mcp-bridge (drops bridge-callback FQNs)
4. Unregister every `/mcp/<server>` route from the gateway
5. Stop every handler (closes buckets, transports, SDK servers)
6. Stop every upstream child process
7. Clear caches

No zombie state: no leftover routes, no orphan child processes (all `stop()`s are awaited via `Promise.allSettled`), no leftover identities (the supervisor independently revokes via `releaseMcpIdentityFor` when each PTY disposes).

However: this is `stop()`, called on daemon shutdown or a hot-restart of the plugin. Operator-flipping `settings.mcp.shared = []` mid-daemon would require either a daemon restart or a `_reset → start` cycle on the plugin singleton. The current code has `_resetMcpMultiplexer` (`index.ts:514-517`) for tests only — there's no operator-facing "reload" path. **This is fine for v1** (operators bounce the daemon to apply config changes anyway) but worth knowing.

**Recommendation (info)**: document in the operator-facing settings reference that `settings.mcp.shared` changes require a daemon restart. **PASS.**

---

### #21 DoS-via-spawn — bounded by crash-window logic  [SEVERITY: Info] [VERDICT: PASS]

**File**: `src/plugins/mcp-proxy/server-process.ts:21-24, 174-198`

```ts
const BACKOFF_MS = [1_000, 5_000, 30_000, 60_000];
const CRASH_WINDOW_MS = 5 * 60 * 1_000;
const MAX_CRASHES_IN_WINDOW = 5;
```

5 crashes in 5 minutes → `status = "failed"` permanently. No restart timer scheduled. Restart-loop saturation is impossible.

The generation counter (`server-process.ts:45, 82-96`) prevents double-restart from stale `onclose`/`onerror` handlers — verified at L86 (`crashHandled` flag) + L88 (`this.generation !== gen` guard). **PASS.**

---

### #22 Spawn-time poisoning of `mcp-proxy.json` — out of scope (same-UID)  [SEVERITY: Out-of-scope] [VERDICT: N/A]

**File**: `src/plugins/mcp-multiplexer/index.ts:155, 445-454`

Config path defaults to `~/.config/claudeclaw/mcp-proxy.json`. The file is owned by the operator's UID. An attacker who can rewrite it has same-UID access, which is already game-over. The file is read once at `start()` via `JSON.parse(readFileSync(...))`; if parse fails, `safeParse` returns failure and the multiplexer goes dormant (`index.ts:204-213`). No injection surface from the parse path (Zod validates the schema).

---

### #23 FQN namespace collision — impossible by construction  [SEVERITY: Info] [VERDICT: PASS]

**Files**: `src/plugins/mcp-bridge.ts:65`, W1-COORD.md §"FQN namespacing"

The bridge always prefixes registered tool names with `pluginId__`. The multiplexer registers under `pluginId = "mcp-multiplexer"`, so all its FQNs are `mcp-multiplexer__<server>__<tool>`. The mcp-proxy plugin registers under `pluginId = "mcp-proxy"`, so its FQNs are `mcp-proxy__<server>__<tool>`. The two namespaces cannot overlap.

The skip-shared rule (`mcp-proxy/index.ts:71-88`) is a structural belt-and-braces: when a server name appears in `settings.mcp.shared`, mcp-proxy explicitly skips spawning it so the upstream child isn't double-spawned. **PASS.**

---

## Threat model validation

The stated trust boundary is correct and the implementation respects it:

**Trusted**: daemon process + operator UID. Anyone with that level of access already owns everything; no defense is meaningful.

**Untrusted**:
- Other UIDs on the same host. Defended by file mode 0600, parent dir 0700 (when newly created), and `verifyBearer` constant-time comparison.
- Network beyond loopback. Defended by absolute refusal to mount when `webHost` isn't `127.0.0.1`/`localhost`.
- Third-party MCP server children. Defended by SDK's `DEFAULT_INHERITED_ENV_VARS` allowlist (no API-key leak) and the operator-controlled `env:` block in `mcp-proxy.json`. Upstream child can still misbehave inside its allocated capability surface — but the same was true pre-milestone.
- Processes that can read files the daemon writes. Defended by 0600 on the synthesised config; the bearer is the only secret-at-rest and it rotates on respawn.

**Realistic exploitation paths considered**:

1. *Network attacker scans loopback ports.* → 401 immediately (no bearer). Not exploitable.
2. *Another local user reads `mcp-pty-<id>.json`.* → File mode 0600 blocks read. Directory listing of `.claudeclaw/` (if dir is 0755) leaks ptyIds — minor info disclosure, not a credential leak.
3. *Same-UID attacker reads `mcp-pty-<id>.json`.* → Bearer in cleartext, valid for up to 30 min (idle-reap default). Out of scope per the stated trust boundary.
4. *Compromised upstream MCP child (e.g. malicious graphiti).* → Bounded by `DEFAULT_INHERITED_ENV_VARS`; cannot reach Anthropic API key. Can still misuse `mcp-proxy.json`-supplied secrets (NEO4J_URI etc.) and read operator's files. Unchanged from pre-milestone.
5. *Replay of stolen bearer from a long-running script.* → Valid until next PTY respawn / reap. Worst case ~30 min. Mitigation: tighten `pty.idleReapMinutes` in deployment.
6. *DoS via repeated `tools/call`.* → Upstream call has 30s timeout, but no rate-limit at the multiplexer layer. **See finding #5.**
7. *DoS via large request body.* → No body-size cap on `/mcp/*`. **See finding #5.**
8. *Bearer leaks via daemon log or audit.* → No audit path includes the bearer, but the `PtyIdentity.bearer` field is reachable on the public object. **See finding #10.**
9. *PTY crash leaves orphan config file with valid bearer.* → No: secret rotates on respawn and the in-memory store is gone on daemon crash, so the on-disk bearer is dead the moment the daemon dies. Cosmetic file litter only.

The envelope holds.

---

## Conditions for production rollout (`pty.enabled: true`)

Issue #64 is already documented as blocking prod. Before flipping the switch:

**Must-fix (before merge or in a fast follow-up):**
1. **Finding #10**: drop `PtyIdentity.bearer` from the public interface; expose only via `headers`. This forecloses an entire class of "future contributor adds a `console.log(identity)`" leaks. 5-10 LOC.
2. **Finding #5 (partial)**: add a body-size cap at the top of `McpHttpHandler.handle()`. Mirroring `MAX_BODY_BYTES = 1_048_576` from the gateway is fine. ~15 LOC.

**Should-fix (v1.1 or before scaling beyond a single operator):**
3. **Finding #5 (partial)**: per-bearer rate-limit (token bucket). ~30 LOC.
4. **Finding #14**: defensive `allowedTools` recheck in `McpServerProcess.call()`. 3 LOC.
5. **Finding #9**: defensive `chmodSync(path, 0o600)` after writeFileSync; `chmodSync(dir, 0o700)` after the existence check. 4 LOC.
6. **Finding #4**: include the client-asserted `X-Claudeclaw-Ts` in `multiplexer_invoke` audit payload. 1 LOC.
7. **Finding #15**: split `multiplexer_server_crashed` into a terminal `multiplexer_server_permanently_failed` event. 5 LOC.

**Should-document:**
- Operator-facing note: `settings.mcp.shared` changes require a daemon restart.
- Operator-facing note: stateless shared MCP servers share state across PTYs at the upstream-process level.
- Threat model: bearer-as-secret + loopback + 0600 envelope; secret valid until PTY respawn (max ~`pty.idleReapMinutes`).

---

## Summary for operator

**Verdict: APPROVE WITH CONDITIONS.** The bearer-as-secret + loopback + 0600 envelope is sound: constant-time auth, strict `ptyId` regex, dormant-by-default, three-of-three activation gates, complete teardown on every dispose path, full audit coverage with no bearer leakage. No critical findings.

**Top two actions before flipping `pty.enabled: true`:** (1) drop the `bearer` field from the public `PtyIdentity` interface so a future `console.log(identity)` can't leak the secret (Finding #10, ~5 LOC); (2) add a body-size cap on `/mcp/*` matching the `1 MiB` cap already enforced on `/api/plugin/*` (Finding #5, ~15 LOC). Everything else is shoulds and documentation.
