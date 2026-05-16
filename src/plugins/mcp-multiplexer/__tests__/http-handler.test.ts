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
import { _resetMcpBridge, _setMcpBridge } from "../../mcp-bridge.js";

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

  it("stateless handler does not have per-PTY buckets", async () => {
    await handler!.stop();
    handler = new McpHttpHandler({ serverName: "test", proc: proc!, stateless: true });
    // releasePty is a no-op for stateless
    await handler.releasePty("suzy");
    const h = handler.health();
    expect(h.stateless).toBe(true);
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
