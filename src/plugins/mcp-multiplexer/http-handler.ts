/**
 * Streamable HTTP MCP handler for the multiplexer.
 *
 * One handler instance per upstream MCP server (one of the children
 * spawned by the multiplexer at startup — see `./index.ts`). The handler
 * speaks the MCP Streamable HTTP transport (revision 2024-11-05) back
 * out to the per-PTY `claude` clients and proxies every `tools/call`
 * request to the in-process `McpServerProcess.call(tool, args)`.
 *
 * Per-PTY isolation:
 *   - Each (server, ptyId) pair gets its own ephemeral SDK `Server` +
 *     transport pair, lazily created on first request.
 *   - For servers in `settings.mcp.stateless`, the (ptyId) dimension is
 *     collapsed — a single `Server` + transport pair is shared across
 *     all PTYs. Per-PTY HMAC verification still gates access.
 *   - Identity teardown (`McpMultiplexerPlugin.releaseIdentity(ptyId)`)
 *     calls `releasePty(ptyId)` here to tear down the per-PTY transport.
 *
 * Auth model: see `./pty-identity.ts` and `../../planning/mcp-multiplexer/W1-COORD.md`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { getMcpBridge } from "../mcp-bridge.js";
import type { McpServerProcess } from "../mcp-proxy/server-process.js";
import { AUTH_HEADER, PTY_ID_HEADER, verifyBearer } from "./pty-identity.js";
import type { SessionPersistenceStore } from "./session-persistence.js";

/** Sentinel used when a server is declared stateless: all PTYs collapse
 *  to a single (server, *) bucket so they share one upstream session.
 *  Per-PTY auth verification still happens before any routing. */
const STATELESS_BUCKET = "__stateless__";

/** Pair of objects making up a live MCP session against this server. */
interface ServerBucket {
  /** Owner ptyId or `STATELESS_BUCKET`. */
  bucketKey: string;
  sdkServer: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Last-touched timestamp, for diagnostics. */
  lastUsed: number;
}

export interface McpHttpHandlerOpts {
  /** Server name (matches the key in `mcp-proxy.json`). */
  serverName: string;
  /** Upstream child to which `tools/call` is proxied. */
  proc: McpServerProcess;
  /** When `true`, all PTYs share a single upstream MCP session for this
   *  server. Defaults to `false` (per-PTY isolation). */
  stateless?: boolean;
  /** Optional persistence layer. When provided, `_createBucket` records a
   *  (serverName, ptyId, sessionId) tuple on the SDK transport's
   *  `onsessioninitialized` callback; `releasePty` drops it; bucket
   *  reuse touches `lastUsedAt`. Stateless buckets are never persisted
   *  (no per-PTY identity to bind to). When undefined, the handler is
   *  byte-identical to PR #71. */
  persistence?: SessionPersistenceStore;
  /** Optional per-bearer rate limit config (#72 item 1). When omitted or
   *  `maxRequestsPerWindow <= 0`, no limit is enforced. */
  rateLimit?: {
    maxRequestsPerWindow: number;
    windowMs: number;
  };
  /** Injectable clock for tests. Default: `Date.now`. */
  _now?: () => number;
}

/** Maximum request body size accepted by the multiplexer. Matches the
 *  cap on `/api/plugin/*` in the HTTP gateway. Rejects 4 GB POSTs that
 *  would OOM the daemon. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Helper: read raw body bytes once. Phase D #2 (security): enforce a
 *  hard byte cap so a malicious or buggy client can't OOM the daemon
 *  with a multi-GB JSON POST. */
async function _readBody(req: Request): Promise<unknown> {
  // The SDK transport parses JSON itself from the Request — we just pass
  // the raw Request through. This helper exists so the auth path can
  // peek without consuming the body stream.
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("json")) return undefined;
  try {
    const cloned = req.clone();
    return await cloned.json();
  } catch {
    return undefined;
  }
}

/** Check whether a request's declared/streamed body exceeds the cap.
 *  Reads `Content-Length` if provided (rejects oversize before the body is
 *  consumed). For unknown-length requests, materialises into an ArrayBuffer
 *  and rejects if it exceeds the cap. Returns the safe-to-replay Request
 *  on success, or a 413 Response on failure. */
async function _enforceBodyCap(req: Request): Promise<Request | Response> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return _errResponse(
        413,
        "body_too_large",
        `request body ${n}B exceeds ${MAX_BODY_BYTES}B limit`,
      );
    }
    // Content-Length present and within cap → safe to forward.
    return req;
  }
  // No Content-Length (chunked transfer or HTTP/2). Materialise once so we
  // can both enforce the cap and replay to the SDK transport.
  let buf: ArrayBuffer;
  try {
    buf = await req.arrayBuffer();
  } catch {
    return _errResponse(400, "body_read_failed", "could not read request body");
  }
  if (buf.byteLength > MAX_BODY_BYTES) {
    return _errResponse(
      413,
      "body_too_large",
      `request body ${buf.byteLength}B exceeds ${MAX_BODY_BYTES}B limit`,
    );
  }
  // Rebuild a Request the SDK transport can consume. Headers preserved.
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: buf,
  });
}

/**
 * Per-server HTTP handler. Construct one per upstream MCP child;
 * register on the `PluginHttpGateway` via `registerMcpHandler(name, ...)`.
 */
export class McpHttpHandler {
  readonly serverName: string;
  private readonly proc: McpServerProcess;
  private readonly stateless: boolean;
  private readonly buckets = new Map<string, ServerBucket>();
  private readonly persistence: SessionPersistenceStore | undefined;
  private closed = false;
  /**
   * Per-bearer (= per-`ptyId`) sliding-window request timestamps. Each
   * entry is the list of request-receipt epoch-ms values within the
   * current `windowMs`. `_checkRateLimit` evicts entries older than
   * `now - windowMs` and rejects when the remaining count would exceed
   * `maxRequestsPerWindow`. #72 item 1.
   *
   * Memory is bounded by `maxRequestsPerWindow * ptyCount` numbers. At
   * default 600/PTY and 32 PTYs (settings.pty.maxConcurrent default),
   * that's ~150KB worst case. Acceptable.
   */
  private readonly _rlWindows = new Map<string, number[]>();
  private readonly _rlMax: number;
  private readonly _rlWindowMs: number;
  private readonly _now: () => number;

  constructor(opts: McpHttpHandlerOpts) {
    this.serverName = opts.serverName;
    this.proc = opts.proc;
    this.stateless = opts.stateless === true;
    // Persistence is only meaningful for per-PTY (stateful) buckets — the
    // stateless bucket has no per-PTY identity to bind to. Even if the
    // operator wires a store, we skip it for stateless servers.
    this.persistence = this.stateless ? undefined : opts.persistence;
    this._rlMax = opts.rateLimit?.maxRequestsPerWindow ?? 0;
    this._rlWindowMs = opts.rateLimit?.windowMs ?? 60_000;
    this._now = opts._now ?? (() => Date.now());
  }

  /**
   * Sliding-window check for `/mcp/<server>` requests under a given
   * bearer (`ptyId`). Returns `null` when the request is allowed and
   * records its timestamp; returns a `Retry-After` value (in seconds,
   * rounded up, minimum 1) when the request must be rejected.
   *
   * When `_rlMax <= 0` the limit is disabled and every request is
   * allowed without touching the window state. #72 item 1.
   */
  _checkRateLimit(ptyId: string): { rejected: false } | { rejected: true; retryAfterSec: number } {
    if (this._rlMax <= 0) return { rejected: false };
    const now = this._now();
    const cutoff = now - this._rlWindowMs;
    let win = this._rlWindows.get(ptyId);
    if (!win) {
      win = [];
      this._rlWindows.set(ptyId, win);
    }
    // Evict timestamps outside the window. Cheap on a sorted list.
    while (win.length > 0 && win[0]! < cutoff) win.shift();
    if (win.length >= this._rlMax) {
      // Retry-After = milliseconds until the oldest in-window request
      // ages out, rounded up to seconds and floored at 1.
      const oldest = win[0]!;
      const waitMs = oldest + this._rlWindowMs - now;
      const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
      return { rejected: true, retryAfterSec };
    }
    win.push(now);
    return { rejected: false };
  }

  /**
   * Handle a single inbound HTTP request from a PTY `claude`.
   * Returns a `Response`. Never throws — errors are converted to
   * `Response`s with appropriate status codes and a small JSON body.
   */
  async handle(req: Request): Promise<Response> {
    if (this.closed) {
      return new Response(JSON.stringify({ error: "multiplexer_stopped" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }

    // ── Body cap (Phase D security #2) ────────────────────────────────
    // Enforce before auth so we don't read multi-GB bodies on unauth'd
    // requests. `_enforceBodyCap` returns either a safe-to-forward Request
    // (possibly rebuilt) or a 413 Response.
    const guarded = await _enforceBodyCap(req);
    if (guarded instanceof Response) return guarded;
    const safeReq = guarded;

    // ── Authentication ────────────────────────────────────────────────
    const ptyId = safeReq.headers.get(PTY_ID_HEADER);
    const bearer = safeReq.headers.get(AUTH_HEADER);
    if (!ptyId) {
      return _errResponse(401, "missing_pty_id", `missing ${PTY_ID_HEADER} header`);
    }
    if (!bearer || !verifyBearer(ptyId, bearer)) {
      // Audit, but only the failure event — do not log the bearer itself.
      try {
        getMcpBridge().audit("multiplexer_auth_rejected", {
          server: this.serverName,
          pty_id: ptyId,
        });
      } catch {}
      return _errResponse(401, "invalid_bearer", "HMAC verification failed");
    }

    // ── Per-bearer rate limit (#72 item 1) ────────────────────────────
    // Defense-in-depth: a leaked bearer is bounded by the rate limit
    // even before the issuing PTY respawns and rotates the secret.
    const rl = this._checkRateLimit(ptyId);
    if (rl.rejected) {
      try {
        getMcpBridge().audit("multiplexer_rate_limited", {
          server: this.serverName,
          pty_id: ptyId,
          max_per_window: this._rlMax,
          window_ms: this._rlWindowMs,
          retry_after_sec: rl.retryAfterSec,
        });
      } catch {}
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: `request limit exceeded for pty ${ptyId} on /mcp/${this.serverName}`,
          retry_after_seconds: rl.retryAfterSec,
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(rl.retryAfterSec),
          },
        },
      );
    }

    // ── Upstream readiness ────────────────────────────────────────────
    // If the upstream child is mid-restart we return 503 immediately so
    // the MCP client retries instead of hanging on a dead session.
    if (this.proc.status !== "up") {
      return _errResponse(
        503,
        "upstream_unavailable",
        `server ${this.serverName} status=${this.proc.status}`,
      );
    }

    // ── Dispatch to per-(server, pty) bucket ──────────────────────────
    const bucketKey = this.stateless ? STATELESS_BUCKET : ptyId;
    let bucket = this.buckets.get(bucketKey);
    const isNewBucket = !bucket;
    if (!bucket) {
      try {
        bucket = await this._createBucket(bucketKey);
        this.buckets.set(bucketKey, bucket);
      } catch (err) {
        return _errResponse(
          500,
          "bucket_init_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    bucket.lastUsed = Date.now();
    // Touch the persisted record on bucket reuse so the GC sweep keeps
    // it. Best-effort, never blocks request dispatch. Skipped on
    // first-create — the `onsessioninitialized` callback handles the
    // initial `record()` once the SDK transport mints the sessionId.
    if (!isNewBucket && this.persistence && !this.stateless) {
      this.persistence.touch(this.serverName, bucketKey).catch(() => {});
    }

    // Peek at the body for audit observability without consuming the
    // request stream (the transport needs to re-read it).
    const peek = await _readBody(safeReq);

    try {
      getMcpBridge().audit("multiplexer_invoke", {
        server: this.serverName,
        pty_id: ptyId,
        stateless: this.stateless,
        rpc_method: _peekRpcMethod(peek),
      });
    } catch {}

    // Hand off to the SDK transport. It will read the body, dispatch
    // to the registered handlers on the SDK Server, and return a
    // Web-Standard Response with framing.
    try {
      return await bucket.transport.handleRequest(safeReq);
    } catch (err) {
      // Ensure the bucket is torn down if the transport itself errored;
      // future calls will lazily reinitialise.
      this.buckets.delete(bucketKey);
      // Drop the persisted record so we don't replay a known-broken
      // sessionId on next daemon start. The new bucket created on next
      // request will record afresh with a new UUID.
      if (this.persistence && !this.stateless) {
        this.persistence.drop(this.serverName, bucketKey).catch(() => {});
      }
      try {
        await bucket.transport.close();
      } catch {}
      try {
        await bucket.sdkServer.close();
      } catch {}
      return _errResponse(500, "transport_error", err instanceof Error ? err.message : String(err));
    }
  }

  /** Tear down a per-PTY bucket. Called by the plugin's
   *  `releaseIdentity(ptyId)`. Idempotent.
   *
   *  Also drops the persisted record for this (server, pty) tuple if a
   *  persistence layer is wired. A reaped/released PTY's binding must
   *  not be replayed on next daemon start — the next time this ptyId
   *  appears the supervisor will mint fresh identity + sessionId. */
  async releasePty(ptyId: string): Promise<void> {
    // Codex PR #91 P2: clear the per-PTY rate-limit window FIRST. When a
    // PTY is reaped and a new identity is issued for the same ptyId
    // (the normal `releaseIdentity` → `issueIdentity` rotation in
    // index.ts), the fresh bearer would otherwise inherit the prior
    // session's timestamps and immediately hit 429s based on traffic
    // it didn't originate. Cleared unconditionally — stateless handlers
    // still keyed the window by ptyId (we use `STATELESS_BUCKET` for
    // the SDK session, but `_checkRateLimit` keys on the actual ptyId).
    this._rlWindows.delete(ptyId);
    if (this.stateless) return; // no per-PTY bucket exists
    // Drop the persisted record FIRST so that even if the bucket's
    // already gone (race with transport_error path) the disk state is
    // still cleaned up.
    if (this.persistence) {
      await this.persistence.drop(this.serverName, ptyId).catch(() => {});
    }
    const bucket = this.buckets.get(ptyId);
    if (!bucket) return;
    this.buckets.delete(ptyId);
    try {
      await bucket.transport.close();
    } catch {}
    try {
      await bucket.sdkServer.close();
    } catch {}
  }

  /** Tear down every bucket and refuse further requests.
   *
   *  Note: `stop()` is the daemon-shutdown path. We do NOT drop persisted
   *  records here — the whole point of persistence is to survive
   *  shutdown so `start()` can replay them. Records are only dropped on
   *  per-PTY `releasePty()` (operator-initiated identity revocation,
   *  idle-reap, etc) or transport-error cleanup. SPEC §3 frozen
   *  decision #4. */
  async stop(): Promise<void> {
    this.closed = true;
    const buckets = [...this.buckets.values()];
    this.buckets.clear();
    await Promise.allSettled(
      buckets.map(async (b) => {
        try {
          await b.transport.close();
        } catch {}
        try {
          await b.sdkServer.close();
        } catch {}
      }),
    );
  }

  /** Diagnostics snapshot. */
  health(): Record<string, unknown> {
    return {
      server: this.serverName,
      stateless: this.stateless,
      active_buckets: this.buckets.size,
      bucket_keys: [...this.buckets.keys()],
      closed: this.closed,
    };
  }

  /**
   * Public test/replay seam — install a bucket carrying a previously-
   * persisted sessionId. Called from `McpMultiplexerPlugin._replay
   * PersistedSessions()` after `start()` finishes the spawn loop.
   *
   * Per SPEC §4.5: the SDK transport's `sessionIdGenerator` is overridden
   * to return the persisted UUID, then the bucket is inserted into
   * `this.buckets` so the PTY-side claude's first post-restart request
   * (which still carries the OLD `mcp-session-id` header) routes to the
   * pre-installed bucket. Returns the new sessionId for audit payload
   * use; throws if the upstream child is not `up`.
   *
   * **`transport.sessionId` activation lag (Phase C finding):** immediately
   * after this call returns, `bucket.transport.sessionId` is `undefined` —
   * the SDK only materialises it when an `initialize` request actually
   * hits the transport (`webStandardStreamableHttp.js` L433 in the SDK).
   * Production is fine because the PTY-side claude's first request
   * carries the cached `mcp-session-id` header, which triggers init and
   * populates `transport.sessionId` with the persisted UUID via the
   * armed generator. Tests that need to assert the sessionId is wired
   * BEFORE a request lands should invoke `bucket.transport.sessionIdGenerator()`
   * (the generator is pre-armed) rather than read `transport.sessionId`
   * (which only activates on first init).
   */
  async installResumedBucket(ptyId: string, sessionId: string): Promise<string> {
    if (this.closed) {
      throw new Error(`handler ${this.serverName} is closed`);
    }
    if (this.stateless) {
      throw new Error(`server ${this.serverName} is stateless — cannot resume per-PTY`);
    }
    if (this.proc.status !== "up") {
      throw new Error(`upstream ${this.serverName} status=${this.proc.status}`);
    }
    const existing = this.buckets.get(ptyId);
    if (existing) {
      // Already a bucket for this ptyId — nothing to do. The supervisor
      // released identity on shutdown so this shouldn't happen, but be
      // defensive.
      return existing.transport.sessionId ?? sessionId;
    }
    const bucket = await this._createBucket(ptyId, sessionId);
    this.buckets.set(ptyId, bucket);
    return bucket.transport.sessionId ?? sessionId;
  }

  private async _createBucket(bucketKey: string, resumedSessionId?: string): Promise<ServerBucket> {
    // Each bucket gets its own SDK Server + transport pair. The SDK
    // assigns a fresh MCP session ID per bucket via sessionIdGenerator.
    const sdkServer = new Server(
      { name: `mcp-multiplexer/${this.serverName}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    // tools/list — exposes only the tools the upstream child advertises
    // (already filtered by `allowedTools` in `mcp-proxy.json`).
    sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.proc.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
        },
      })),
    }));

    // Defense-in-depth (Phase D #6): build the allowed-tool set from the
    // already-filtered `proc.tools`. tools/list returns only this set, and
    // tools/call rejects anything not in it — so a caller forging a non-
    // allowed name fails inside the multiplexer instead of relying on the
    // upstream child's own rejection.
    const allowedNames = new Set(this.proc.tools.map((t) => t.name));

    // tools/call — proxy through to the upstream child after gating.
    sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!allowedNames.has(name)) {
        try {
          getMcpBridge().audit("multiplexer_tool_rejected", {
            server: this.serverName,
            tool: name,
            reason: "not_in_allowed_set",
          });
        } catch {}
        return {
          content: [
            {
              type: "text",
              text: `Error: tool '${name}' is not exposed by server '${this.serverName}'`,
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await this.proc.call(name, args ?? {});
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    });

    // Capture this for the closure — `this.serverName` etc. are read
    // synchronously inside callbacks but TS narrowing through `this` in
    // callbacks is unreliable.
    const serverName = this.serverName;
    const persistence = this.persistence;
    const stateless = this.stateless;

    const transport = new WebStandardStreamableHTTPServerTransport({
      // SPEC §4.5: replay overrides the UUID generator with the
      // persisted sessionId so the SDK transport hands the SAME id back
      // to the PTY-side claude that's still caching the pre-restart
      // value. Fresh buckets use a new UUID.
      sessionIdGenerator: () => resumedSessionId ?? randomUUID(),
      enableJsonResponse: true, // simpler for HTTP-only callers
      // Persist the (server, ptyId, sessionId) binding the moment the
      // SDK transport mints it on first `initialize`. For replayed
      // buckets the callback still fires once the synthetic init runs;
      // re-recording the same tuple is a no-op upsert. Stateless
      // buckets skip persistence entirely.
      onsessioninitialized: (sessionId: string) => {
        if (!persistence || stateless) return;
        // Fire-and-forget; SDK callback is sync-or-async tolerant. We
        // never block initialize on disk I/O.
        persistence.record(serverName, bucketKey, sessionId).catch(() => {
          // Persistence-layer audits surface failures; suppress here to
          // avoid masking the initialize success.
        });
      },
      // Symmetric drop on transport DELETE. The supervisor's
      // releaseIdentity → releasePty path covers the dominant case;
      // this catches a PTY-side claude that DELETEs without supervisor
      // teardown (e.g. claude restarted in-place).
      onsessionclosed: (_sessionId: string) => {
        if (!persistence || stateless) return;
        persistence.drop(serverName, bucketKey).catch(() => {});
      },
    });
    await sdkServer.connect(transport);

    return {
      bucketKey,
      sdkServer,
      transport,
      lastUsed: Date.now(),
    };
  }
}

function _errResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function _peekRpcMethod(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "method" in body &&
    typeof (body as { method: unknown }).method === "string"
  ) {
    return (body as { method: string }).method;
  }
  return undefined;
}
