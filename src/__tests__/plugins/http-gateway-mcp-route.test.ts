/**
 * Tests for the multiplexer-related additions to `PluginHttpGateway`:
 * `/mcp/<server>` route delegation, `registerMcpHandler`, and
 * `unregisterMcpHandler`. See `mcp-multiplexer/index.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PluginHttpGateway, _resetHttpGateway } from "../../plugins/http-gateway.js";
import { _resetMcpBridge } from "../../plugins/mcp-bridge.js";

function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(`http://localhost:4632${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function url(path: string): URL {
  return new URL(`http://localhost:4632${path}`);
}

describe("PluginHttpGateway — /mcp/<server> route delegation", () => {
  let gw: PluginHttpGateway;

  beforeEach(() => {
    _resetHttpGateway();
    _resetMcpBridge();
    gw = new PluginHttpGateway();
  });

  afterEach(() => {
    _resetHttpGateway();
    _resetMcpBridge();
  });

  it("registers and dispatches to per-server handlers", async () => {
    let calls = 0;
    gw.registerMcpHandler("alpha", async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    expect(gw.hasMcpHandler("alpha")).toBe(true);

    const r = await gw.handleRequest(req("POST", "/mcp/alpha"), url("/mcp/alpha"));
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("returns 404 for an unregistered server name", async () => {
    const r = await gw.handleRequest(req("POST", "/mcp/missing"), url("/mcp/missing"));
    expect(r?.status).toBe(404);
    const body = (await r!.json()) as { error: { code: string; server: string } };
    expect(body.error.code).toBe("mcp_server_not_registered");
    expect(body.error.server).toBe("missing");
  });

  it("dispatches sub-paths to the same handler", async () => {
    const seen: string[] = [];
    gw.registerMcpHandler("alpha", async (r) => {
      seen.push(new URL(r.url).pathname);
      return new Response("ok", { status: 200 });
    });

    await gw.handleRequest(req("POST", "/mcp/alpha"), url("/mcp/alpha"));
    await gw.handleRequest(req("POST", "/mcp/alpha/sub"), url("/mcp/alpha/sub"));
    await gw.handleRequest(req("GET", "/mcp/alpha/foo/bar"), url("/mcp/alpha/foo/bar"));

    expect(seen).toEqual(["/mcp/alpha", "/mcp/alpha/sub", "/mcp/alpha/foo/bar"]);
  });

  it("does not interfere with /api/plugin/* routing", async () => {
    gw.registerMcpHandler("alpha", async () => new Response("from-mcp", { status: 200 }));
    // /api/plugin/list now requires the bootstrap token; the point of this test
    // is that the gateway HANDLES the route (rather than delegating it to the
    // mcp handler), so authenticate and assert the real list response.
    const token = (gw as unknown as { bootstrapToken: Buffer }).bootstrapToken.toString("hex");
    const r = await gw.handleRequest(
      req("GET", "/api/plugin/list", undefined, { Authorization: `Bearer ${token}` }),
      url("/api/plugin/list"),
    );
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { plugins: unknown[] };
    expect(Array.isArray(body.plugins)).toBe(true);
  });

  it("unregisterMcpHandler removes the handler", async () => {
    gw.registerMcpHandler("alpha", async () => new Response("ok", { status: 200 }));
    expect(gw.hasMcpHandler("alpha")).toBe(true);
    gw.unregisterMcpHandler("alpha");
    expect(gw.hasMcpHandler("alpha")).toBe(false);

    const r = await gw.handleRequest(req("POST", "/mcp/alpha"), url("/mcp/alpha"));
    expect(r?.status).toBe(404);
  });

  it("re-registering replaces the previous handler", async () => {
    gw.registerMcpHandler("alpha", async () => new Response("v1", { status: 200 }));
    gw.registerMcpHandler("alpha", async () => new Response("v2", { status: 200 }));
    const r = await gw.handleRequest(req("POST", "/mcp/alpha"), url("/mcp/alpha"));
    expect(await r!.text()).toBe("v2");
  });

  it("rejects invalid server names at registration", () => {
    expect(() => gw.registerMcpHandler("Bad Name", async () => new Response())).toThrow();
    expect(() => gw.registerMcpHandler("../escape", async () => new Response())).toThrow();
    expect(() => gw.registerMcpHandler("", async () => new Response())).toThrow();
    expect(() => gw.registerMcpHandler("ok-name", async () => new Response())).not.toThrow();
  });
});
