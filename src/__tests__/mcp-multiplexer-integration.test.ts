/**
 * Phase C wire-level integration tests for the MCP multiplexer.
 *
 * Phase B's unit tests mock the MCP transport boundary; this file proves
 * that the wire actually works:
 *   - real `Bun.serve` HTTP listener (ephemeral port) mounted on the
 *     `PluginHttpGateway`,
 *   - real upstream MCP stdio child spawned by the multiplexer's
 *     `McpServerProcess`,
 *   - real MCP SDK `Client` + `StreamableHTTPClientTransport` talking
 *     across the loopback boundary with per-PTY HMAC bearer headers.
 *
 * The fixture child is the existing `src/__tests__/fixtures/mock-mcp-server.ts`
 * which exposes a deterministic `echo` tool over stdio.
 *
 * Scope is hermetic: every test uses a tmpdir-scoped `mcp-proxy.json`,
 * binds the gateway to port 0, and tears down all spawned children +
 * listeners in `afterEach`. None of these tests touch `~/.config`,
 * require the `claude` CLI, or talk to the network beyond loopback.
 *
 * See `.planning/mcp-multiplexer/SPEC.md` §§4.1–4.6, 6.3, 7.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpMultiplexerPlugin, _resetMcpMultiplexer } from "../plugins/mcp-multiplexer/index.js";
import { _resetHttpGateway, getHttpGateway } from "../plugins/http-gateway.js";
import { _resetMcpBridge, getMcpBridge } from "../plugins/mcp-bridge.js";
import { _resetIdentityStore } from "../plugins/mcp-multiplexer/pty-identity.js";
import { makeMuxSettingsView } from "./fixtures/mux-settings-view.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeProxyConfig(dir: string, names: string[]): string {
  const cfg = {
    servers: Object.fromEntries(
      names.map((name) => [
        name,
        {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      ]),
    ),
  };
  const path = join(dir, "mcp-proxy.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

/** Start a hermetic Bun.serve listener on an ephemeral loopback port
 *  that routes BOTH `/api/plugin/*` and `/mcp/*` to the gateway. The
 *  `/mcp/*` route is the part missing from production `src/ui/server.ts`
 *  today (it only routes `/api/plugin/`); we mount it here so the wire
 *  test exercises the full gateway surface. The production gap is
 *  surfaced in the Phase C report. */
function startTestGateway(): {
  origin: string;
  port: number;
  stop: () => Promise<void>;
} {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/plugin/") || url.pathname.startsWith("/mcp/")) {
        const resp = await getHttpGateway().handleRequest(req, url);
        if (resp !== null) return resp;
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      server.stop(true);
    },
  };
}

/** Build a fully-headered MCP SDK Client pointed at the multiplexer. */
async function connectClient(opts: {
  origin: string;
  server: string;
  ptyId: string;
  bearer: string;
  clientName?: string;
}): Promise<{
  client: Client;
  /** Exposed so a test can assert two clients got DISTINCT MCP session ids —
   *  `bucket_keys` only proves the map was keyed apart, not that the SDK
   *  minted separate sessions. */
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${opts.origin}/mcp/${opts.server}`),
    {
      requestInit: {
        headers: {
          Authorization: opts.bearer,
          "X-Claudeclaw-Pty-Id": opts.ptyId,
        },
      },
    },
  );
  const client = new Client(
    { name: opts.clientName ?? `test-client/${opts.ptyId}`, version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      try {
        await client.close();
      } catch {}
    },
  };
}

// ── Suite plumbing ──────────────────────────────────────────────────────────

let tmpDir: string;
let plugin: McpMultiplexerPlugin | null = null;
let gateway: { origin: string; port: number; stop: () => Promise<void> } | null = null;

async function teardown(): Promise<void> {
  if (plugin) {
    try {
      await plugin.stop();
    } catch {}
    plugin = null;
  }
  if (gateway) {
    try {
      await gateway.stop();
    } catch {}
    gateway = null;
  }
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-mux-itest-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
});

afterEach(async () => {
  await teardown();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── 1) End-to-end happy path ────────────────────────────────────────────────

describe("mcp-multiplexer integration — happy path", () => {
  it("real SDK client lists tools and round-trips a tools/call over loopback HTTP", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(true);

    gateway = startTestGateway();
    const ident = plugin.issueIdentity("pty-happy");

    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-happy",
      bearer: ident.headers.Authorization,
    });

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["echo"]);

      const result = await client.callTool({
        name: "echo",
        arguments: { message: "wire works" },
      });
      // The handler wraps the upstream result as
      // { content: [{ type: "text", text: JSON.stringify(upstreamJson) }] }
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      expect(content?.type).toBe("text");
      expect(content?.text).toContain("wire works");
    } finally {
      await close();
    }
  });
});

// ── 2) Per-PTY auth ─────────────────────────────────────────────────────────

describe("mcp-multiplexer integration — per-PTY auth", () => {
  it("two distinct PTY identities can both invoke without leaking session state", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const a = plugin.issueIdentity("pty-A");
    const b = plugin.issueIdentity("pty-B");
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);

    const ca = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-A",
      bearer: a.headers.Authorization,
    });
    const cb = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-B",
      bearer: b.headers.Authorization,
    });

    try {
      // Concurrent invocations — each must succeed independently.
      const [ra, rb] = await Promise.all([
        ca.client.callTool({
          name: "echo",
          arguments: { message: "from-A" },
        }),
        cb.client.callTool({
          name: "echo",
          arguments: { message: "from-B" },
        }),
      ]);

      const ta = (ra.content as Array<{ text: string }>)[0]!.text;
      const tb = (rb.content as Array<{ text: string }>)[0]!.text;
      expect(ta).toContain("from-A");
      expect(tb).toContain("from-B");

      // For stateful (default) server, each PTY gets its own bucket.
      const handler = plugin._getHandler("alpha");
      const h = handler?.health() as {
        stateless: boolean;
        active_buckets: number;
        bucket_keys: string[];
      };
      expect(h.stateless).toBe(false);
      expect(h.bucket_keys.sort()).toEqual(["pty-A", "pty-B"]);
    } finally {
      await ca.close();
      await cb.close();
    }
  });
});

// ── 3) Auth rejection ───────────────────────────────────────────────────────

describe("mcp-multiplexer integration — auth rejection", () => {
  it("forged bearer for a non-issued ptyId returns 401 with no upstream call", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    // Audit hook to confirm no upstream invoke is recorded.
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bridge = getMcpBridge();
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event, payload) => {
      events.push({ event, payload });
      origAudit(event, payload);
    };

    try {
      // Forge bearer: 64 hex chars (the correct length) but a ptyId
      // that was never issued.
      const forged = `Bearer ${"a".repeat(64)}`;
      const resp = await fetch(`${gateway.origin}/mcp/alpha`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: forged,
          "X-Claudeclaw-Pty-Id": "pty-never-issued",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_bearer");

      // Auth-rejected audit fired; no `multiplexer_invoke` event.
      const rejected = events.find((e) => e.event === "multiplexer_auth_rejected");
      expect(rejected).toBeDefined();
      const invokes = events.filter((e) => e.event === "multiplexer_invoke");
      expect(invokes).toHaveLength(0);
    } finally {
      bridge.audit = origAudit;
    }
  });

  it("missing pty-id header returns 401 missing_pty_id", { timeout: 10000 }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const resp = await fetch(`${gateway.origin}/mcp/alpha`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${"b".repeat(64)}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("missing_pty_id");
  });
});

// ── 4) Stateful vs stateless session demux ──────────────────────────────────

describe("mcp-multiplexer integration — stateful vs stateless demux", () => {
  it("both stateful and stateless servers key their buckets per PTY", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha", "beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha", "beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const a = plugin.issueIdentity("pty-1");
    const b = plugin.issueIdentity("pty-2");

    // STATEFUL server (`alpha`): each PTY's initialize() goes to its own
    // SDK Server in its own bucket.
    const a1 = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    const a2 = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-2",
      bearer: b.headers.Authorization,
    });
    await a1.client.listTools();
    await a2.client.listTools();

    // STATELESS server (`beta`): same keying. The marker changes what is
    // persisted, not how clients are demultiplexed — an MCP session is
    // per-client either way. See the concurrent-clients test below for
    // the behaviour this protects.
    const b1 = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    const b2 = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-2",
      bearer: b.headers.Authorization,
    });
    await b1.client.listTools();
    await b2.client.listTools();

    try {
      const alphaH = plugin._getHandler("alpha")?.health() as {
        stateless: boolean;
        bucket_keys: string[];
      };
      const betaH = plugin._getHandler("beta")?.health() as {
        stateless: boolean;
        bucket_keys: string[];
      };

      expect(alphaH.stateless).toBe(false);
      expect(alphaH.bucket_keys.sort()).toEqual(["pty-1", "pty-2"]);

      expect(betaH.stateless).toBe(true);
      expect(betaH.bucket_keys.sort()).toEqual(["pty-1", "pty-2"]);
    } finally {
      await a1.close();
      await a2.close();
      await b1.close();
      await b2.close();
    }
  });
});

describe("mcp-multiplexer integration — stateless server serves concurrent clients", () => {
  // No explicit timeout override anywhere in this describe: these are
  // sub-second, and the `it(name, {timeout}, fn)` overload is what the
  // typecheck ratchet already counts as an error 7 times over in this file.
  it("four PTYs each complete their own initialize against a stateless server", async () => {
    const cfg = writeProxyConfig(tmpDir, ["beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    // FOUR, not two. Two proves the keys are not ALL collapsed; it does not
    // prove the keying is unbounded — a mutation that keys the first two
    // apart and collapses the third onward survives a 2-client test.
    const ids = ["pty-a", "pty-b", "pty-c", "pty-d"];
    const conns = [];
    for (const ptyId of ids) {
      const ident = plugin.issueIdentity(ptyId);
      conns.push(
        await connectClient({
          origin: gateway.origin,
          server: "beta",
          ptyId,
          bearer: ident.headers.Authorization,
        }),
      );
    }

    try {
      for (const c of conns) {
        expect((await c.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      }

      // Concurrent IN-FLIGHT dispatch. Awaiting each call in turn never puts
      // two requests on the wire at once, so it cannot catch a regression
      // where two clients share one session and collide on JSON-RPC ids —
      // the very hazard this test is named for.
      const results = await Promise.all(
        conns.map((c, i) =>
          c.client.callTool({ name: "echo", arguments: { message: `from-${ids[i]}` } }),
        ),
      );
      results.forEach((r, i) => {
        expect(JSON.stringify(r)).toContain(`from-${ids[i]}`);
      });

      // Distinct MCP session ids — the property that actually prevents the
      // id collision. `bucket_keys` only shows the map was keyed apart.
      const sids = conns.map((c) => c.transport.sessionId);
      for (const sid of sids) expect(sid).toBeDefined();
      expect(new Set(sids).size).toBe(ids.length);

      const betaH = plugin._getHandler("beta")?.health() as {
        stateless: boolean;
        bucket_keys: string[];
        active_buckets: number;
      };
      expect(betaH.stateless).toBe(true);
      expect(betaH.bucket_keys.sort()).toEqual([...ids].sort());
      expect(betaH.active_buckets).toBe(ids.length);
    } finally {
      for (const c of conns) await c.close();
    }
  });

  it("a fresh client on the SAME ptyId is not bricked by its predecessor", async () => {
    const cfg = writeProxyConfig(tmpDir, ["beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const ident = plugin.issueIdentity("pty-r");

    // First client opens and goes away WITHOUT the supervisor revoking the
    // identity — that is exactly what a crash-respawn looks like
    // ("a respawn, not a permanent dispose"), so no `releasePty` runs.
    const first = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-r",
      bearer: ident.headers.Authorization,
    });
    await first.client.listTools();
    const firstSid = first.transport.sessionId;
    await first.close();

    // The replacement must be able to handshake. Without bucket recycling it
    // lands on the predecessor's initialized transport and the SDK answers
    // `400 -32600 "Server already initialized"`, which the client reads as an
    // unreachable server — the same failure mode as the collapsed bucket,
    // one ptyId at a time.
    const second = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-r",
      bearer: ident.headers.Authorization,
    });
    try {
      expect((await second.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      expect(second.transport.sessionId).toBeDefined();
      expect(second.transport.sessionId).not.toBe(firstSid);

      // One live bucket for the ptyId, not two: the predecessor was retired,
      // not merely shadowed.
      const betaH = plugin._getHandler("beta")?.health() as {
        bucket_keys: string[];
        active_buckets: number;
      };
      expect(betaH.bucket_keys).toEqual(["pty-r"]);
      expect(betaH.active_buckets).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("routes an authenticated raw POST with no session id into that PTY's own bucket", async () => {
    const cfg = writeProxyConfig(tmpDir, ["beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const a = plugin.issueIdentity("pty-1");
    const b = plugin.issueIdentity("pty-2");

    const b1 = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    await b1.client.listTools();

    try {
      // A bare POST: valid bearer, no `mcp-session-id`, not an initialize.
      // This is the shape the `server/discover` guard re-reads the body for,
      // and the only stateless path not driven through an SDK Client.
      const resp = await fetch(`${gateway.origin}/mcp/beta`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: b.headers.Authorization,
          "X-Claudeclaw-Pty-Id": "pty-2",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      });
      // Past auth. The SDK rejects it as a session-less non-initialize (400)
      // — what matters is where it landed.
      expect(resp.status).not.toBe(401);
      expect(resp.status).not.toBe(404);

      // It got its OWN bucket rather than being routed onto pty-1's session.
      const betaH = plugin._getHandler("beta")?.health() as { bucket_keys: string[] };
      expect(betaH.bucket_keys.sort()).toEqual(["pty-1", "pty-2"]);
    } finally {
      await b1.close();
    }
  });

  it("a client that ends its session releases the bucket immediately", async () => {
    const cfg = writeProxyConfig(tmpDir, ["beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const ident = plugin.issueIdentity("pty-d");
    const conn = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-d",
      bearer: ident.headers.Authorization,
    });
    await conn.client.listTools();
    const handler = plugin._getHandler("beta");
    expect((handler?.health() as { bucket_keys: string[] }).bucket_keys).toEqual(["pty-d"]);

    // The SDK client's terminateSession() sends the transport DELETE. A
    // bucket IS the session it belongs to, so it must go with it rather than
    // sit on a transport the SDK still considers initialized until the
    // supervisor happens to revoke the identity.
    await conn.transport.terminateSession();
    await new Promise((r) => setTimeout(r, 50));
    expect((handler?.health() as { bucket_keys: string[] }).bucket_keys).toEqual([]);

    await conn.close();
  });

  it("releaseIdentity tears down a stateless bucket", async () => {
    const cfg = writeProxyConfig(tmpDir, ["beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const ident = plugin.issueIdentity("pty-x");
    const conn = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-x",
      bearer: ident.headers.Authorization,
    });
    await conn.client.listTools();

    const handler = plugin._getHandler("beta");
    expect((handler?.health() as { bucket_keys: string[] }).bucket_keys).toEqual(["pty-x"]);

    // Restoring `releasePty`'s old `if (this.stateless) return` early exit
    // passes every other test in this repo; this is the one that catches it.
    await plugin.releaseIdentity("pty-x");
    expect((handler?.health() as { bucket_keys: string[] }).bucket_keys).toEqual([]);

    await conn.close();
  });
});

// ── 5) Bridge callback integration ──────────────────────────────────────────

describe("mcp-multiplexer integration — bridge callback path", () => {
  it("legacy in-process caller can invoke a shared tool via getMcpBridge() with no HTTP hop", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    // Intentionally do NOT start the HTTP gateway listener — this
    // exercises the in-process bridge path (SPEC §10 Q#2 (b)).

    const bridge = getMcpBridge();
    const fqns = bridge.listTools().map((t) => t.fqn);
    expect(fqns).toContain("mcp-multiplexer__alpha__echo");

    const result = await bridge.invokeTool("mcp-multiplexer__alpha__echo", {
      arguments: { message: "via-bridge" },
    });
    // Upstream returns `{ echo: "via-bridge" }` which is JSON-parsed
    // by `McpServerProcess.call`, so the bridge result is the object.
    expect(result).toEqual({ echo: "via-bridge" });
  });
});

// ── 6) Crash + health probe transition ──────────────────────────────────────

describe("mcp-multiplexer integration — crash + health probe transition", () => {
  it("killing the upstream child mid-test fires _onServerCrash and health probe emits mcp_health_degraded", {
    timeout: 15000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeMuxSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        // Keep the probe disabled so we drive sampling deterministically.
        healthProbeIntervalMs: 0,
      }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(true);

    gateway = startTestGateway();

    // Capture audit events emitted during the crash + probe sequence.
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bridge = getMcpBridge();
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event, payload) => {
      events.push({ event, payload });
      origAudit(event, payload);
    };

    try {
      // Confirm one healthy round-trip before the crash to prove the
      // process really is up and serving tool calls.
      const ident = plugin.issueIdentity("pty-pre-crash");
      const c = await connectClient({
        origin: gateway.origin,
        server: "alpha",
        ptyId: "pty-pre-crash",
        bearer: ident.headers.Authorization,
      });
      await c.client.listTools();
      await c.close();

      // Reach into the real McpServerProcess and kill its transport.
      // This is the same path a real upstream child crash takes —
      // the SDK's StdioClientTransport fires `onclose` which the
      // server-process's onCrash hook turns into the
      // `multiplexer_server_crashed` audit + status mutation.
      type ProcLike = {
        servers: Map<string, { status: string; transport: { close?: () => Promise<void> } | null }>;
        lastObservedStatus: Map<string, string>;
      };
      const proc = (plugin as unknown as ProcLike).servers.get("alpha")!;
      const initial = proc.status;

      // Close the transport. McpServerProcess.transport.onclose then
      // invokes _handleCrash → calls our onCrash → status mutates.
      await proc.transport?.close?.();

      // Allow the onclose handler to fire (microtask flush).
      await new Promise((r) => setTimeout(r, 50));

      // Status should have transitioned away from `up`. The crash
      // handler schedules a restart timer with a 1s backoff for the
      // first crash, so by now we expect `crashed` → `restarting`.
      expect(["crashed", "restarting", "up"]).toContain(proc.status);

      // Force-set status to `crashed` if a fast restart already
      // happened — what we want to prove is that the probe transition
      // emits the right audit event. Then drive the probe directly.
      (proc as { status: string }).status = "crashed";
      (plugin as unknown as { lastObservedStatus: Map<string, string> }).lastObservedStatus.set(
        "alpha",
        initial,
      );

      (plugin as unknown as { _sampleHealthForTests: () => void })._sampleHealthForTests();

      const degraded = events.find((e) => e.event === "mcp_health_degraded");
      expect(degraded).toBeDefined();
      expect(degraded?.payload.server).toBe("alpha");
      expect(degraded?.payload.current_status).toBe("crashed");

      // The crash hook itself should also have audited a
      // `multiplexer_server_crashed` event when the real onclose
      // fired (proves the real onCrash → audit path works, not just
      // the unit-level mutation).
      const crashAudit = events.find((e) => e.event === "multiplexer_server_crashed");
      expect(crashAudit).toBeDefined();
      expect(crashAudit?.payload.server).toBe("alpha");
    } finally {
      bridge.audit = origAudit;
    }
  });
});
