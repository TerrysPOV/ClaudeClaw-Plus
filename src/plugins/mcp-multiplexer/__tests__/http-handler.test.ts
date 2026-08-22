import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { McpServerProcess } from "../../mcp-proxy/server-process.js";
import { McpHttpHandler } from "../http-handler.js";
import {
  issueIdentity,
  revokeIdentity,
  _resetIdentityStore,
  AUTH_HEADER,
  PTY_ID_HEADER,
  PTY_TS_HEADER,
} from "../pty-identity.js";
import { _resetMcpBridge, _setMcpBridge, getMcpBridge } from "../../mcp-bridge.js";

const MOCK_SERVER = fileURLToPath(
  new URL("../../../__tests__/fixtures/mock-mcp-server.ts", import.meta.url),
);
const BUN_BIN = process.execPath;

function makeServerConfig() {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: ["echo"],
  };
}

/** Wrap a JSON-RPC message in a Web-standard Request shaped the way the
 *  Streamable HTTP transport expects (POST + content-type json + Accept). */
function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4632/mcp/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("McpHttpHandler — auth", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  it("rejects requests missing X-Claudeclaw-Pty-Id with 401", async () => {
    const resp = await handler!.handle(rpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_pty_id");
  });

  it("rejects requests missing Authorization header with 401", async () => {
    issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { [PTY_ID_HEADER]: "suzy" }),
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_bearer");
  });

  it("rejects requests with a bad bearer with 401", async () => {
    issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          [PTY_ID_HEADER]: "suzy",
          [AUTH_HEADER]: "Bearer " + "00".repeat(32),
        },
      ),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects requests for an unknown ptyId with 401", async () => {
    const id = issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          [PTY_ID_HEADER]: "reg",
          [AUTH_HEADER]: id.headers[AUTH_HEADER],
        },
      ),
    );
    expect(resp.status).toBe(401);
  });

  it("auth-rejected requests do not reach the upstream MCP process", async () => {
    const beforeCallCount = proc!.lastInvocationAt;
    const resp = await handler!.handle(rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(resp.status).toBe(401);
    // upstream `lastInvocationAt` must not have been touched
    expect(proc!.lastInvocationAt).toBe(beforeCallCount);
  });
});

describe("McpHttpHandler — successful auth + RPC dispatch", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  it("503 when upstream child is not 'up'", async () => {
    issueIdentity("suzy");
    await proc!.stop();
    const id = issueIdentity("suzy");
    const resp = await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
      ),
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
  });

  it("releasePty tears down only the requested PTY bucket", async () => {
    const a = issueIdentity("suzy");
    const b = issueIdentity("reg");

    // Force bucket creation by sending an initialize/ping for each PTY.
    // Even if the SDK can't fully complete (mock server is minimal),
    // the bucket creation happens inside `handle()` before the transport
    // takes over.
    await handler!.handle(
      rpcRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: a.headers[AUTH_HEADER] },
      ),
    );
    await handler!.handle(
      rpcRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { [PTY_ID_HEADER]: "reg", [AUTH_HEADER]: b.headers[AUTH_HEADER] },
      ),
    );

    const before = handler!.health();
    expect((before.active_buckets as number) >= 1).toBe(true);

    await handler!.releasePty("suzy");
    const after = handler!.health();
    const remaining = after.bucket_keys as string[];
    expect(remaining).not.toContain("suzy");
  });

  it("stateless handler keys buckets per PTY and releasePty tears them down", async () => {
    await handler!.stop();
    handler = new McpHttpHandler({ serverName: "test", proc: proc!, stateless: true });
    const a = issueIdentity("suzy");

    await handler.handle(
      rpcRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: a.headers[AUTH_HEADER] },
      ),
    );

    const before = handler.health();
    expect(before.stateless).toBe(true);
    // The marker does not collapse the key space: a stateless server owns a
    // bucket per PTY like any other.
    expect(before.bucket_keys as string[]).toEqual(["suzy"]);

    // And that bucket is genuinely reclaimed on identity teardown. This is
    // the half of the per-PTY fix that an earlier `if (this.stateless)
    // return` in `releasePty` would silently skip — leaking the transport
    // and leaving the next identity for this ptyId to collide with a stale
    // initialized session.
    await handler.releasePty("suzy");
    expect(handler.health().bucket_keys as string[]).toEqual([]);
  });
});

describe("McpHttpHandler — closed state", () => {
  it("returns 503 after stop()", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    const handler = new McpHttpHandler({ serverName: "test", proc });
    await handler.stop();
    const id = issueIdentity("suzy");
    const resp = await handler.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
      ),
    );
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("multiplexer_stopped");
    await proc.stop();
    revokeIdentity("suzy");
  });
});

// ─── Per-bearer rate limit (#72 item 1) ──────────────────────────────────────
//
// The /mcp/<server> route is bearer-only — no HMAC + replay window like the
// /api/plugin/* routes. A leaked bearer could permit unlimited replay against
// the shared upstream until the issuing PTY respawns. Defense-in-depth: cap
// requests per (server, ptyId) per sliding window.

describe("McpHttpHandler — per-bearer rate limit (#72 item 1)", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  it("disabled by default (no rateLimit opt → no cap)", async () => {
    handler = new McpHttpHandler({ serverName: "test", proc: proc! });
    // 50 calls in a tight loop — none should be rate-limited.
    issueIdentity("suzy");
    const id = issueIdentity("suzy");
    for (let i = 0; i < 50; i++) {
      const resp = await handler.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: i, method: "tools/list" },
          { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
        ),
      );
      // Pass through to upstream (not 429); status could be 200 or 4xx from
      // the transport, but MUST NOT be 429.
      expect(resp.status).not.toBe(429);
    }
  });

  it("returns 429 + Retry-After once the per-window cap is exceeded", async () => {
    // Inject a fixed clock so the window timing is deterministic.
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 3, windowMs: 10_000 },
      _now: () => t,
    });
    const id = issueIdentity("suzy");
    const send = () =>
      handler!.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
        ),
      );

    // First 3 requests within the window: allowed (not 429).
    for (let i = 0; i < 3; i++) {
      const resp = await send();
      expect(resp.status).not.toBe(429);
    }
    // 4th request: rejected with 429 + Retry-After header.
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = (await blocked.json()) as {
      error: string;
      retry_after_seconds: number;
    };
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(body.retry_after_seconds).toBeLessThanOrEqual(10);
  });

  it("does not consume upstream when rate-limited", async () => {
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 1, windowMs: 10_000 },
      _now: () => t,
    });
    const id = issueIdentity("suzy");
    const send = () =>
      handler!.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
        ),
      );
    await send();
    const before = proc!.lastInvocationAt;
    const blocked = await send();
    expect(blocked.status).toBe(429);
    // Upstream MUST NOT have been hit by the rejected request.
    expect(proc!.lastInvocationAt).toBe(before);
  });

  it("window slides — old requests age out and new ones are allowed", async () => {
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 2, windowMs: 1_000 },
      _now: () => t,
    });
    const id = issueIdentity("suzy");
    const send = () =>
      handler!.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
        ),
      );

    await send(); // t=1_000_000
    await send(); // t=1_000_000
    const blocked = await send(); // exceeds cap
    expect(blocked.status).toBe(429);

    // Advance past the window.
    t += 1_500;
    const allowed = await send();
    expect(allowed.status).not.toBe(429);
  });

  it("rate limit is per-ptyId (a leaked bearer for `suzy` doesn't starve `reg`)", async () => {
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 2, windowMs: 10_000 },
      _now: () => t,
    });
    const idSuzy = issueIdentity("suzy");
    const idReg = issueIdentity("reg");
    const sendAs = (pty: string, bearer: string) =>
      handler!.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { [PTY_ID_HEADER]: pty, [AUTH_HEADER]: bearer },
        ),
      );

    // Exhaust suzy's window.
    await sendAs("suzy", idSuzy.headers[AUTH_HEADER]);
    await sendAs("suzy", idSuzy.headers[AUTH_HEADER]);
    const suzyBlocked = await sendAs("suzy", idSuzy.headers[AUTH_HEADER]);
    expect(suzyBlocked.status).toBe(429);

    // reg's window is independent — should still pass.
    const regAllowed = await sendAs("reg", idReg.headers[AUTH_HEADER]);
    expect(regAllowed.status).not.toBe(429);
  });

  // Codex PR #91 P2: when an identity is released and re-issued for the
  // same ptyId (the normal releaseIdentity → issueIdentity rotation on
  // PTY respawn / operator-initiated revoke), the rate-limit window must
  // NOT leak across the rotation — the fresh bearer is a fresh session
  // and should start with an empty bucket.
  it("releasePty clears the rate-limit window so a re-issued identity isn't pre-throttled", async () => {
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 2, windowMs: 10_000 },
      _now: () => t,
    });
    const send = (bearer: string) =>
      handler!.handle(
        rpcRequest(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: bearer },
        ),
      );

    // Exhaust the window under the first identity.
    const id1 = issueIdentity("suzy");
    await send(id1.headers[AUTH_HEADER]);
    await send(id1.headers[AUTH_HEADER]);
    const blocked1 = await send(id1.headers[AUTH_HEADER]);
    expect(blocked1.status).toBe(429);

    // Release the identity (mirrors plugin.releaseIdentity → handler.releasePty).
    await handler.releasePty("suzy");
    revokeIdentity("suzy");

    // Issue a fresh identity for the same ptyId — same window has not
    // elapsed yet (clock unchanged). Pre-fix the new bearer would still
    // see the old 3 timestamps and get 429 immediately. Post-fix the
    // bucket is empty and the first request is allowed.
    const id2 = issueIdentity("suzy");
    const fresh = await send(id2.headers[AUTH_HEADER]);
    expect(fresh.status).not.toBe(429);
  });

  it("rate-limit check runs AFTER bearer verification (bad bearer → 401, not 429)", async () => {
    let t = 1_000_000;
    handler = new McpHttpHandler({
      serverName: "test",
      proc: proc!,
      rateLimit: { maxRequestsPerWindow: 1, windowMs: 10_000 },
      _now: () => t,
    });
    issueIdentity("suzy");
    // Bad bearer — should be 401 even though we're below the rate limit.
    const resp = await handler.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: `Bearer ${"00".repeat(32)}` },
      ),
    );
    expect(resp.status).toBe(401);
  });
});

// #72 item 5: include the client-asserted X-Claudeclaw-Ts header in the
// `multiplexer_invoke` audit payload so operators can correlate calls
// back to a specific identity-issuance window (forensics, replay
// detection across rotations).
describe("McpHttpHandler — multiplexer_invoke audit carries X-Claudeclaw-Ts (#72 item 5)", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc: proc! });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
    _resetMcpBridge();
  });

  function captureAudits(events: Array<{ name: string; payload: Record<string, unknown> }>) {
    _setMcpBridge({
      audit: (name: string, payload: Record<string, unknown>) => {
        events.push({ name, payload });
      },
      registerPluginTool: () => {},
      unregisterPluginTool: () => {},
      listTools: () => [],
      invoke: async () => {
        throw new Error("not in test");
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test bridge
    } as any);
  }

  it("includes client_ts (parsed epoch ms) on successful auth", async () => {
    const id = issueIdentity("suzy");
    // `issueIdentity` populates headers with X-Claudeclaw-Ts = issuance ms.
    const issuedAtRaw = id.headers[PTY_TS_HEADER];
    expect(issuedAtRaw).toBeTruthy();
    const issuedAt = Number(issuedAtRaw);

    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          [PTY_ID_HEADER]: "suzy",
          [AUTH_HEADER]: id.headers[AUTH_HEADER],
          [PTY_TS_HEADER]: issuedAtRaw,
        },
      ),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.client_ts).toBe(issuedAt);
    expect(invoke!.payload.pty_id).toBe("suzy");
    expect(invoke!.payload.server).toBe("test");
    revokeIdentity("suzy");
  });

  it("client_ts is null when the header is missing (defensive — never throws)", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    // Pass auth headers but omit X-Claudeclaw-Ts. Pre-#71 clients
    // wouldn't send it; we shouldn't break on the missing field.
    await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          [PTY_ID_HEADER]: "suzy",
          [AUTH_HEADER]: id.headers[AUTH_HEADER],
        },
      ),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.client_ts).toBeNull();
    revokeIdentity("suzy");
  });

  it("client_ts is null when the header is non-numeric (malformed input)", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          [PTY_ID_HEADER]: "suzy",
          [AUTH_HEADER]: id.headers[AUTH_HEADER],
          [PTY_TS_HEADER]: "not-a-number",
        },
      ),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.client_ts).toBeNull();
    revokeIdentity("suzy");
  });
});

// #72 item 11: skip the body-peek clone when the request body exceeds
// PEEK_MAX_BYTES (4 KiB). Saves a full body duplicate + JSON-parse pass
// for tool calls with large arguments (file contents, image attachments,
// etc). The `rpc_method` audit field becomes undefined for those calls
// — forensic-only loss, no security/correctness impact.
describe("McpHttpHandler — body-peek threshold for audit (#72 item 11)", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc: proc! });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
    _resetMcpBridge();
  });

  function captureAudits(events: Array<{ name: string; payload: Record<string, unknown> }>) {
    _setMcpBridge({
      audit: (name: string, payload: Record<string, unknown>) => {
        events.push({ name, payload });
      },
      registerPluginTool: () => {},
      unregisterPluginTool: () => {},
      listTools: () => [],
      invoke: async () => {
        throw new Error("not in test");
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test bridge
    } as any);
  }

  /** Build a Request with an explicit content-length so the peek logic
   *  can short-circuit. The body JSON is constructed to be roughly
   *  `targetSize` bytes (close enough for the 4 KiB threshold). */
  function bigRpcRequest(targetBodyBytes: number, headers: Record<string, string>): Request {
    // The method field is what _peekRpcMethod would extract — fill the
    // rest with padding to push past PEEK_MAX_BYTES.
    const padding = "x".repeat(Math.max(0, targetBodyBytes - 80));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { padding },
    });
    return new Request("http://127.0.0.1:4632/mcp/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    });
  }

  it("includes rpc_method in audit when body is below the peek threshold", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    // Default small request (~80 bytes JSON) — well under 4 KiB.
    await handler!.handle(
      rpcRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { [PTY_ID_HEADER]: "suzy", [AUTH_HEADER]: id.headers[AUTH_HEADER] },
      ),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.rpc_method).toBe("tools/list");
    revokeIdentity("suzy");
  });

  it("omits rpc_method (sets to undefined) when body exceeds PEEK_MAX_BYTES", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    // 8 KiB body — comfortably above the 4 KiB peek threshold.
    await handler!.handle(
      bigRpcRequest(8192, {
        [PTY_ID_HEADER]: "suzy",
        [AUTH_HEADER]: id.headers[AUTH_HEADER],
      }),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    // The clone+parse path was skipped → no method extracted.
    expect(invoke!.payload.rpc_method).toBeUndefined();
    // Everything else still recorded — server, pty_id, stateless,
    // client_ts (when present) are all available without the body peek.
    expect(invoke!.payload.server).toBe("test");
    expect(invoke!.payload.pty_id).toBe("suzy");
    revokeIdentity("suzy");
  });

  it("still includes rpc_method when content-length declared is just under threshold", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    // 3 KiB body — under the 4 KiB cap, so the peek runs.
    await handler!.handle(
      bigRpcRequest(3000, {
        [PTY_ID_HEADER]: "suzy",
        [AUTH_HEADER]: id.headers[AUTH_HEADER],
      }),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.rpc_method).toBe("tools/list");
    revokeIdentity("suzy");
  });

  it("the peek skip does not affect the audit fire path (only rpc_method is dropped)", async () => {
    const id = issueIdentity("suzy");
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    captureAudits(events);

    // 8 KiB body — peek will be skipped, but the rest of the dispatch
    // path must continue normally. The `multiplexer_invoke` audit still
    // fires (auth + rate-limit + bucket-init all reached); only
    // `rpc_method` is absent.
    await handler!.handle(
      bigRpcRequest(8192, {
        [PTY_ID_HEADER]: "suzy",
        [AUTH_HEADER]: id.headers[AUTH_HEADER],
      }),
    );

    const invoke = events.find((e) => e.name === "multiplexer_invoke");
    expect(invoke).toBeDefined();
    expect(invoke!.payload.server).toBe("test");
    expect(invoke!.payload.pty_id).toBe("suzy");
    expect(invoke!.payload.rpc_method).toBeUndefined();
    revokeIdentity("suzy");
  });
});

describe("McpHttpHandler — session-less discovery probe", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc });
  });

  afterEach(async () => {
    if (handler) await handler.stop();
    if (proc) await proc.stop();
    proc = null;
    handler = null;
    _resetIdentityStore();
  });

  function authed(body: unknown): Request {
    const id = issueIdentity("suzy");
    return rpcRequest(body, {
      [PTY_ID_HEADER]: "suzy",
      [PTY_TS_HEADER]: String(Date.now()),
      ...id.headers,
    });
  }

  // A client on MCP revision 2026-07-28 probes with `server/discover` before
  // it holds a session id. The session-ful SDK transport answers that with a
  // transport-level 400, which the client reads as "server unreachable" and
  // drops the server. A JSON-RPC "method not found" keeps the connection
  // usable and lets the client fall back to `initialize`.
  it("answers server/discover with a JSON-RPC error, not a transport 400", async () => {
    const resp = await handler!.handle(
      authed({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover" }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe("server-discover-probe-1");
  });

  it("echoes a null id back when the probe carries none", async () => {
    const resp = await handler!.handle(authed({ jsonrpc: "2.0", method: "server/discover" }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: unknown; error?: { code: number } };
    // Assert the error too: without it this passes on the unpatched
    // transport as well, which would make the test prove nothing.
    expect(body.error?.code).toBe(-32601);
    expect(body.id).toBeNull();
  });

  /** Same as `authed`, but with an explicit `content-length` header and a
   *  body padded past PEEK_MAX_BYTES. `new Request(url, { body })` sets no
   *  content-length of its own, so without this the peek's declared-size
   *  branch — the one production actually takes over a socket — is never
   *  exercised. Mirrors `bigRpcRequest` in the #72 item 11 block. */
  function authedBig(method: string, targetBodyBytes: number): Request {
    const id = issueIdentity("suzy");
    const padding = "x".repeat(Math.max(0, targetBodyBytes - 80));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { padding } });
    return new Request("http://127.0.0.1:4632/mcp/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(body.length),
        [PTY_ID_HEADER]: "suzy",
        [PTY_TS_HEADER]: String(Date.now()),
        ...id.headers,
      },
      body,
    });
  }

  // Regression: the audit peek skips bodies over PEEK_MAX_BYTES, so gating
  // the probe answer on that peek alone let a >4 KiB probe fall through to
  // the transport and 400 — the exact failure this guard exists to prevent.
  // Reproduced over a real socket before the fix; in-process it needs the
  // declared content-length that `authedBig` supplies.
  it("answers a probe larger than the audit peek threshold", async () => {
    const req = authedBig("server/discover", 8192);
    expect(req.headers.get("content-length")).not.toBeNull();
    expect(Number(req.headers.get("content-length"))).toBeGreaterThan(4096);

    const resp = await handler!.handle(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("does not divert other large methods onto the probe path", async () => {
    const resp = await handler!.handle(authedBig("tools/list", 8192));
    expect(resp.status).not.toBe(401);
    expect(await resp.text()).not.toContain("-32601");
  });

  it("still authenticates the probe — no bearer, no answer", async () => {
    const resp = await handler!.handle(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    );
    expect(resp.status).toBe(401);
  });

  it("leaves every other method on the transport path", async () => {
    const resp = await handler!.handle(authed({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(resp.status).not.toBe(401);
    const body = (await resp.text()) as string;
    expect(body).not.toContain("-32601");
  });
});

// ── Orphaned buckets (issue #355) ───────────────────────────────────────────

describe("McpHttpHandler — a bucket orphaned by a mid-request release", () => {
  let proc: McpServerProcess | null = null;
  let handler: McpHttpHandler | null = null;

  beforeEach(async () => {
    _resetIdentityStore();
    _resetMcpBridge();
    proc = new McpServerProcess("test", makeServerConfig());
    await proc.start();
    handler = new McpHttpHandler({ serverName: "test", proc, stateless: true });
  });

  afterEach(async () => {
    await handler?.stop();
    await proc?.stop();
    _resetIdentityStore();
    _resetMcpBridge();
  });

  function initialize(ptyId: string, bearer: string): Request {
    return rpcRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { [PTY_ID_HEADER]: ptyId, [AUTH_HEADER]: bearer },
    );
  }

  it("is not inserted after its own teardown", async () => {
    const ident = issueIdentity("job-1");

    // Start the request but do NOT await it. `handle()` yields on the body
    // cap read, then authenticates, then yields again on the audit peek and
    // on the bucket build before `buckets.set` runs.
    const inFlight = handler!.handle(initialize("job-1", ident.headers[AUTH_HEADER]!));

    // Land the teardown INSIDE that window. Measured against this handler
    // with the guard removed, the window is microtask turns 2-6: turns 0-1
    // are still pre-auth (the request just 401s, nothing is built), and
    // from turn 7 the transport is already serving the request. Four sits
    // in the middle.
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Production order: `releaseIdentity` revokes the identity first, then
    // tears down the handlers.
    revokeIdentity("job-1");
    await handler!.releasePty("job-1");

    const resp = await inFlight;

    // The request loses — correctly. Its PTY is gone.
    expect(resp.status).toBe(401);
    // Assert the REASON, not just the status. 401 is reachable three ways on
    // this path, and the pre-auth one (`invalid_bearer`, turns 0-1) satisfies
    // both of the other assertions here while proving nothing: no bucket was
    // ever built, so of course none was stranded. Pin `pty_released` and the
    // test can no longer drift into that window silently — add an `await`
    // upstream of the auth check and this fails loudly with the wrong code,
    // which is the signal to retune the turn count above.
    expect((await resp.json()).error.code).toBe("pty_released");
    // And crucially it did not resurrect the bucket. Before the guard, the
    // `delete` above found nothing (the key was not in the map yet) and
    // this insert landed afterwards, stranding a bucket under a ptyId that
    // — being a one-shot job key — no request would ever look up again.
    expect(handler!.health().bucket_keys as string[]).toEqual([]);
  });

  it("is not inserted when the key was revoked and RE-ISSUED mid-request", async () => {
    const dead = issueIdentity("job-3");

    const inFlight = handler!.handle(initialize("job-3", dead.headers[AUTH_HEADER]!));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Teardown, then a NEW identity minted under the same key before the
    // in-flight request resumes. This is not hypothetical: the bus session
    // manager revokes fire-and-forget and re-issues under the same agent id
    // on its collision-retry and respawn paths, so both halves land inside
    // one request's window.
    revokeIdentity("job-3");
    await handler!.releasePty("job-3");
    issueIdentity("job-3");

    const resp = await inFlight;

    // Asking "does SOME identity exist for this key" answers yes here and
    // lets the dead PTY's request install a bucket under the live key —
    // initialized with a session id only the dead client holds. Asking
    // "does the identity honour THIS bearer" is the question that matters.
    expect(resp.status).toBe(401);
    expect((await resp.json()).error.code).toBe("pty_released");
    expect(handler!.health().bucket_keys as string[]).toEqual([]);
  });

  it("bounds the swept-bucket audit's ptyId list and counts what it omits", async () => {
    // 25 orphans, cap is 20. An audit line that names every reclaimed key
    // grows with the number of PTYs the daemon has ever seen; an unbounded
    // audit payload was a blocking finding on the sibling PR.
    const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bridge = getMcpBridge();
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event, payload) => {
      audits.push({ event, payload });
    };
    try {
      for (let i = 0; i < 25; i++) {
        const id = issueIdentity(`job-mass-${i}`);
        await handler!.handle(initialize(`job-mass-${i}`, id.headers[AUTH_HEADER]!));
        revokeIdentity(`job-mass-${i}`);
      }

      expect(await handler!.sweepOrphanedBuckets()).toBe(25);

      const swept = audits.find((a) => a.event === "multiplexer_buckets_swept");
      expect(swept).toBeDefined();
      // The COUNT stays exact — that is the number an operator acts on.
      expect(swept!.payload.reclaimed).toBe(25);
      // The NAMES are a capped sample, and the shortfall is stated rather
      // than left for the reader to infer from a short array.
      expect((swept!.payload.pty_ids as string[]).length).toBe(20);
      expect(swept!.payload.pty_ids_omitted).toBe(5);
    } finally {
      bridge.audit = origAudit;
    }
  });

  it("is reclaimed by the sweep when it slips through anyway", async () => {
    const live = issueIdentity("pty-live");
    const doomed = issueIdentity("job-2");

    await handler!.handle(initialize("pty-live", live.headers[AUTH_HEADER]!));
    await handler!.handle(initialize("job-2", doomed.headers[AUTH_HEADER]!));
    expect((handler!.health().bucket_keys as string[]).sort()).toEqual(["job-2", "pty-live"]);

    // Simulate the orphan directly: identity gone, bucket still in the map.
    // This is the state the race produces, and also what any caller that
    // reaches `releasePty` without going through `releaseIdentity` leaves.
    revokeIdentity("job-2");

    // Seed the rate-limit windows directly. The test handler runs with the
    // limiter disabled (`_rlMax <= 0`), so `handle()` never creates an entry
    // and asserting on an empty map would pass no matter what the sweep did.
    const windows = (handler as unknown as { _rlWindows: Map<string, number[]> })._rlWindows;
    windows.set("job-2", [Date.now()]);
    windows.set("pty-live", [Date.now()]);

    expect(await handler!.sweepOrphanedBuckets()).toBe(1);
    // The live PTY is untouched — the sweep keys on identity, not on idle
    // time, so a healthy session that simply went quiet is never reaped.
    expect(handler!.health().bucket_keys as string[]).toEqual(["pty-live"]);

    // The bucket is not the only thing keyed by ptyId. `releasePty` clears
    // the rate-limit window too, and the sweep has to be symmetric with it:
    // reclaiming 21 KB of bucket while leaving a window entry per one-shot
    // `agent-job-<uuid>` moves the unbounded growth instead of stopping it.
    expect(windows.has("job-2")).toBe(false);
    expect(windows.has("pty-live")).toBe(true);

    // Idempotent: a second pass finds nothing left to do.
    expect(await handler!.sweepOrphanedBuckets()).toBe(0);
  });
});
