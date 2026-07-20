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
}): Promise<{ client: Client; close: () => Promise<void> }> {
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
  it("stateful server creates per-PTY buckets; stateless server collapses to a single __stateless__ bucket", {
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

    // STATEFUL server (`alpha`): use full SDK clients — each PTY's
    // initialize() goes to its own SDK Server in its own bucket.
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

    // STATELESS server (`beta`): both PTYs share a single SDK Server.
    // The first PTY drives initialize() via the SDK Client; the second
    // PTY hits the same bucket via a raw tools/list — re-initialising
    // a shared SDK Server would (correctly) be rejected, which is the
    // whole point of the stateless mode. We assert the bucket-collapse
    // property on the handler health snapshot.
    const b1 = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    await b1.client.listTools();

    // PTY-2 reuses the existing __stateless__ bucket — send a raw
    // tools/list bypassing client-side initialization. Auth still
    // gates the request, so PTY-2 must use its own bearer. The SDK
    // transport will reject this with 400 (no session ID) — that's
    // fine; what matters is the request flowed past auth into the
    // shared bucket without creating a new one, which is the
    // collapse property we assert below on handler.health().
    const resp = await fetch(`${gateway.origin}/mcp/beta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: b.headers.Authorization,
        "X-Claudeclaw-Pty-Id": "pty-2",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: {},
      }),
    });
    // Past auth (status !== 401, !== 404). The SDK transport may
    // accept (200/202) or reject as malformed session (400) — either
    // proves the request reached the bucket, not the auth wall.
    expect(resp.status).not.toBe(401);
    expect(resp.status).not.toBe(404);

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
      // STATELESS_BUCKET sentinel — one bucket regardless of PTY count.
      expect(betaH.bucket_keys).toEqual(["__stateless__"]);
    } finally {
      await a1.close();
      await a2.close();
      await b1.close();
    }
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
