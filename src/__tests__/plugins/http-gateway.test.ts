import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PluginHttpGateway, _resetHttpGateway } from "../../plugins/http-gateway.js";
import { getMcpBridge, _resetMcpBridge } from "../../plugins/mcp-bridge.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGateway(opts?: { allowedHosts?: string[] }): PluginHttpGateway {
  return new PluginHttpGateway(opts);
}

function bootstrapToken(gw: PluginHttpGateway): string {
  // Access via the file created at init; easier to read from the bridge's perspective
  // Instead, we use the fact that verifyBootstrap is tested indirectly via registration
  // For test isolation, patch the gateway's bootstrapToken via a subclass trick
  return (gw as any).bootstrapToken.toString("hex");
}

function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const url = `http://localhost:3000${path}`;
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function url(path: string): URL {
  return new URL(`http://localhost:3000${path}`);
}

const validManifest = {
  name: "greg-voice",
  version: "1.0.0",
  schema_version: 1,
  callback_url: "http://localhost:8765/callback",
  health_url: "http://localhost:8765/health",
  tools: [{ name: "send_tts", description: "Play TTS in active call", schema: { type: "object" } }],
  capabilities: ["tools"],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PluginHttpGateway", () => {
  let gw: PluginHttpGateway;
  let token: string;

  beforeEach(() => {
    _resetHttpGateway();
    _resetMcpBridge();
    gw = makeGateway();
    token = bootstrapToken(gw);
  });

  afterEach(() => {
    _resetHttpGateway();
    _resetMcpBridge();
  });

  // 1. register valid
  test("register valid — returns plugin_token", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as any;
    expect(body.plugin_name).toBe("greg-voice");
    expect(body.plugin_token).toHaveLength(64); // 32 bytes hex
    expect(body.registered_tools).toContain("greg-voice__send_tts");
    expect(gw.hasPlugin("greg-voice")).toBe(true);
  });

  // 2. register invalid bootstrap
  test("register with invalid bootstrap token → 401", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: "Bearer deadbeef",
    });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(401);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("invalid_bootstrap");
  });

  // 3. register malformed manifest
  test("register malformed manifest → 400", async () => {
    const bad = {
      name: "BAD NAME!!!",
      version: "1.0.0",
      tools: [],
      callback_url: "http://localhost:8765/cb",
    };
    const r = req("POST", "/api/plugin/register", bad, { Authorization: `Bearer ${token}` });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(400);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("invalid_manifest");
  });

  // 4. register non-localhost callback
  test("register with external callback host → 400", async () => {
    const m = { ...validManifest, callback_url: "http://evil.com/callback" };
    const r = req("POST", "/api/plugin/register", m, { Authorization: `Bearer ${token}` });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(400);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("callback_host_not_allowed");
  });

  // 4a. register with an internal health_url is rejected (SSRF guard): health_url
  // is fetched on demand by the unauthenticated health endpoint, so it must be
  // host-allowlisted exactly like callback_url.
  test("register with external/internal health_url → 400 (SSRF guard)", async () => {
    const m = { ...validManifest, health_url: "http://169.254.169.254/latest/meta-data/" };
    const r = req("POST", "/api/plugin/register", m, { Authorization: `Bearer ${token}` });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(400);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("health_host_not_allowed");
  });

  // 4b. register external host allowed via constructor allowedHosts
  test("register with allowedHosts override passes", async () => {
    const gwCustom = makeGateway({ allowedHosts: ["192.168.1.10"] });
    const customToken = bootstrapToken(gwCustom);
    const m = {
      ...validManifest,
      name: "trusted-plugin",
      callback_url: "http://192.168.1.10:9000/cb",
    };
    const r = req("POST", "/api/plugin/register", m, { Authorization: `Bearer ${customToken}` });
    const resp = await gwCustom.handleRequest(r, url("/api/plugin/register"));
    expect(resp?.status).toBe(200);
  });

  // 5. re-register replaces existing
  test("re-register same name replaces plugin", async () => {
    const r1 = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r1, url("/api/plugin/register"));
    const firstToken = gw.getPluginToken("greg-voice")!.toString("hex");

    const r2 = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r2, url("/api/plugin/register"));
    const secondToken = gw.getPluginToken("greg-voice")!.toString("hex");

    // Token is re-rolled on re-register
    expect(firstToken).not.toBe(secondToken);
    expect(gw.pluginCount).toBe(1); // still one plugin
  });

  // 6. invoke HMAC tamper
  test("invoke with tampered HMAC → 401", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));

    const path = "/api/plugin/greg-voice/tools/send_tts/invoke";
    const invokeBody = { text: "hello" };
    const ts = new Date().toISOString();
    const fakeReq = req("POST", path, invokeBody, {
      "x-plus-ts": ts,
      "x-plus-signature": "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
    });
    const resp = await gw.handleRequest(fakeReq, url(path));
    expect(resp?.status).toBe(401);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("invalid_signature");
  });

  // 7. invoke stale timestamp
  test("invoke with stale timestamp (>15 min) → 401", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));
    const pluginToken = gw.getPluginToken("greg-voice")!;

    const staleTs = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const path = "/api/plugin/greg-voice/tools/send_tts/invoke";
    const bodyStr = JSON.stringify({ text: "hello" });
    const sig = gw.signHmac(pluginToken, bodyStr, staleTs);

    const invokeReq = req(
      "POST",
      path,
      { text: "hello" },
      {
        "x-plus-ts": staleTs,
        "x-plus-signature": sig,
      },
    );
    const resp = await gw.handleRequest(invokeReq, url(path));
    expect(resp?.status).toBe(401);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("stale_or_future_timestamp");
  });

  // 8. invoke sends correct headers to plugin callback
  test("invoke calls plugin callback with correct HMAC headers", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));
    const pluginToken = gw.getPluginToken("greg-voice")!;

    let capturedHeaders: Record<string, string> = {};
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    };

    const path = "/api/plugin/greg-voice/tools/send_tts/invoke";
    const now = new Date().toISOString();
    const bodyStr = JSON.stringify({ text: "hello" });
    const sig = gw.signHmac(pluginToken, bodyStr, now);

    const invokeReq = req(
      "POST",
      path,
      { text: "hello" },
      {
        "x-plus-ts": now,
        "x-plus-signature": sig,
      },
    );
    await gw.handleRequest(invokeReq, url(path));
    (globalThis as any).fetch = origFetch;

    expect(capturedHeaders["x-plus-ts"]).toBeDefined();
    expect(capturedHeaders["x-plus-signature"]).toHaveLength(64);
    expect(capturedHeaders["x-plus-request-id"]).toBeDefined();
  });

  // 9. invoke timeout
  test("invoke timeout → 502", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));
    const pluginToken = gw.getPluginToken("greg-voice")!;

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      // Abort immediately to simulate timeout
      init.signal.throwIfAborted();
      return new Response("", { status: 200 });
    };

    const path = "/api/plugin/greg-voice/tools/send_tts/invoke";
    const now = new Date().toISOString();
    const bodyStr = JSON.stringify({ text: "hi" });
    const sig = gw.signHmac(pluginToken, bodyStr, now);

    const invokeReq = req(
      "POST",
      path,
      { text: "hi" },
      {
        "x-plus-ts": now,
        "x-plus-signature": sig,
      },
    );
    const resp = await gw.handleRequest(invokeReq, url(path));
    (globalThis as any).fetch = origFetch;

    expect(resp?.status).toBe(502);
    const body = (await resp!.json()) as any;
    expect(body.error.code).toBe("invoke_failed");
  });

  // 10. list returns registered plugins
  test("list returns registered plugins with metadata", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));

    const listResp = await gw.handleRequest(
      req("GET", "/api/plugin/list", undefined, { Authorization: `Bearer ${token}` }),
      url("/api/plugin/list"),
    );
    expect(listResp?.status).toBe(200);
    const body = (await listResp!.json()) as any;
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0].name).toBe("greg-voice");
    expect(body.plugins[0].tools).toContain("send_tts");
    expect(body.plugins[0].last_health_check).toBeNull();
  });

  test("list requires the bootstrap token (no longer world-readable)", async () => {
    const listResp = await gw.handleRequest(
      req("GET", "/api/plugin/list"),
      url("/api/plugin/list"),
    );
    expect(listResp?.status).toBe(401);
    const body = (await listResp!.json()) as any;
    expect(body.error.code).toBe("invalid_bootstrap");
  });

  // 11. health endpoint
  test("health check — plugin with health_url, healthy response", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response("ok", { status: 200 });

    const healthResp = await gw.handleRequest(
      req("GET", "/api/plugin/greg-voice/health"),
      url("/api/plugin/greg-voice/health"),
    );
    (globalThis as any).fetch = origFetch;

    expect(healthResp?.status).toBe(200);
    const body = (await healthResp!.json()) as any;
    expect(body.healthy).toBe(true);
    expect(body.status).toBe(200);
  });

  // 12. unregister authenticated by bootstrap OR plugin token
  test("unregister with bootstrap token succeeds", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    await gw.handleRequest(r, url("/api/plugin/register"));
    expect(gw.hasPlugin("greg-voice")).toBe(true);

    const delResp = await gw.handleRequest(
      req("DELETE", "/api/plugin/greg-voice", undefined, { Authorization: `Bearer ${token}` }),
      url("/api/plugin/greg-voice"),
    );
    expect(delResp?.status).toBe(200);
    expect(gw.hasPlugin("greg-voice")).toBe(false);
  });

  test("unregister with plugin token succeeds", async () => {
    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    const regResp = await gw.handleRequest(r, url("/api/plugin/register"));
    const regBody = (await regResp!.json()) as any;
    const pluginTokenHex = regBody.plugin_token;

    const delResp = await gw.handleRequest(
      req("DELETE", "/api/plugin/greg-voice", undefined, {
        Authorization: `Bearer ${pluginTokenHex}`,
      }),
      url("/api/plugin/greg-voice"),
    );
    expect(delResp?.status).toBe(200);
    expect(gw.hasPlugin("greg-voice")).toBe(false);
  });

  // 13. graceful degradation: audit failure doesn't crash
  test("graceful degradation — audit log fail does not crash handleRequest", async () => {
    const bridge = getMcpBridge();
    // Monkey-patch audit to throw
    (bridge as any).audit = () => {
      throw new Error("disk full");
    };

    const r = req("POST", "/api/plugin/register", validManifest, {
      Authorization: `Bearer ${token}`,
    });
    const resp = await gw.handleRequest(r, url("/api/plugin/register"));
    // Should still succeed despite audit failure
    expect(resp?.status).toBe(200);
  });

  // 14. non-plugin path returns null
  test("non-plugin path returns null (not handled)", async () => {
    const resp = await gw.handleRequest(req("GET", "/api/state"), url("/api/state"));
    expect(resp).toBeNull();
  });

  // 15. HMAC verify: tampered body detected
  test("HMAC verification — tampered body is rejected", async () => {
    const secret = Buffer.from("a".repeat(64), "hex");
    const body = '{"text":"hello"}';
    const ts = new Date().toISOString();
    const validSig = gw.signHmac(secret, body, ts);
    expect(gw.verifyHmac(secret, body, ts, validSig)).toBe(true);
    expect(gw.verifyHmac(secret, '{"text":"tampered"}', ts, validSig)).toBe(false);
  });
});
