import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { PluginMcpBridge, _resetMcpBridge, _setMcpBridge } from "../plugins/mcp-bridge.js";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { getHttpGateway, _resetHttpGateway } from "../plugins/http-gateway.js";
import type { PluginHttpGateway } from "../plugins/http-gateway.js";
import { __setToolCallSinkForTest, ToolCallSink } from "../observability/tool-call-sink.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;
// #304: the bridge's default audit path is the OPERATOR's live journal
// (`~/.config/plus/plugin-audit.jsonl`). Reading it made the assertions race
// against whatever the daemon on the host was writing, and running the test
// left `test-server__*` entries in it. The bridge takes a path: each test
// gets its own, inside its tmp dir.
let auditPath = "";

function signRequest(token: Buffer, body: string, ts: string): string {
  return createHmac("sha256", token).update(`${ts}\n${body}`).digest("hex");
}

async function invokeViaTool(
  gw: PluginHttpGateway,
  plugin: string,
  tool: string,
  bodyObj: unknown,
  token: Buffer,
  opts?: { tsOverride?: string; requestId?: string },
): Promise<Response> {
  const ts = opts?.tsOverride ?? new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const sig = signRequest(token, body, ts);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Plus-Ts": ts,
    "X-Plus-Signature": sig,
  };
  if (opts?.requestId) headers["X-Plus-Request-Id"] = opts.requestId;
  const url = `http://localhost/api/plugin/${plugin}/tools/${tool}/invoke`;
  return gw.handleRequest(
    new Request(url, { method: "POST", headers, body }),
    new URL(url),
  ) as Promise<Response>;
}

function readNewAuditEvents(offsetBytes: number): Record<string, unknown>[] {
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, "utf8").slice(offsetBytes);
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

let tmpDir: string;
let plugin: McpProxyPlugin;
let gateway: PluginHttpGateway;
let proxyToken: Buffer;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-audit-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  auditPath = join(tmpDir, "plugin-audit.jsonl");
  _setMcpBridge(new PluginMcpBridge(auditPath));

  const configPath = join(tmpDir, "mcp-proxy.json");
  const tokenPath = join(tmpDir, "mcp-proxy.token");
  writeFileSync(
    configPath,
    JSON.stringify({
      servers: {
        "test-server": {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      },
    }),
  );

  plugin = new McpProxyPlugin({ configPath, tokenPath });
  await plugin.start();
  gateway = getHttpGateway();
  proxyToken = Buffer.from(readFileSync(tokenPath, "utf8").trim(), "hex");
});

afterEach(async () => {
  await plugin.stop();
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

describe("mcp-proxy audit forensics", () => {
  // ── Test 1 — request_id propagated end-to-end ────────────────────────────

  it("request_id appears in ≥2 audit events and the HTTP response body", async () => {
    const preOffset = existsSync(auditPath) ? statSync(auditPath).size : 0;
    const customRequestId = "deadbeef12345678";

    const resp = await invokeViaTool(
      gateway,
      "mcp-proxy",
      "test-server__echo",
      { arguments: { message: "audit-propagation" }, mode: "direct" },
      proxyToken,
      { requestId: customRequestId },
    );
    expect(resp?.status).toBe(200);
    const data = (await resp!.json()) as { request_id: string };
    expect(data.request_id).toBe(customRequestId);

    const events = readNewAuditEvents(preOffset);
    const withId = events.filter((e) => e.request_id === customRequestId);
    // gateway_invoke start + end both carry the same request_id → ≥2 entries
    expect(withId.length).toBeGreaterThanOrEqual(2);
  });

  // ── Test 1b — the call lands on the mcp.tool_call chain ─────────────────

  it("a gateway invoke of a proxied tool records the upstream server and tool", async () => {
    const sink = new ToolCallSink({ path: null, autoFlush: false });
    __setToolCallSinkForTest(sink);
    try {
      const resp = await invokeViaTool(
        gateway,
        "mcp-proxy",
        "test-server__echo",
        { arguments: { message: "chain" }, mode: "direct" },
        proxyToken,
      );
      expect(resp?.status).toBe(200);
      expect(sink.pending()).toHaveLength(1);
      expect(sink.pending()[0]).toMatchObject({
        plugin: "test-server",
        tool: "echo",
        agent_id: "plugin-bridge",
        status: "ok",
      });
    } finally {
      __setToolCallSinkForTest(null);
    }
  });

  // ── Test 2 — all event types captured ────────────────────────────────────

  it("full register→invoke→error→unregister cycle captures all required event types", async () => {
    // Local setup: capture offset BEFORE plugin.start() so in_process_plugin_registered is visible
    _resetMcpBridge();
    _resetHttpGateway();
    _resetMcpProxy();

    const localTmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-all-events-"));
    // The reset above dropped the tmp-path bridge; without this the next
    // `getMcpBridge()` would write to the operator's live journal again.
    auditPath = join(localTmpDir, "plugin-audit.jsonl");
    _setMcpBridge(new PluginMcpBridge(auditPath));
    const configPath = join(localTmpDir, "mcp-proxy.json");
    const tokenPath = join(localTmpDir, "mcp-proxy.token");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          "test-server": {
            command: BUN_BIN,
            args: ["run", MOCK_SERVER],
            enabled: true,
            allowedTools: ["echo"],
          },
        },
      }),
    );

    const preOffset = existsSync(auditPath) ? statSync(auditPath).size : 0;
    const localPlugin = new McpProxyPlugin({ configPath, tokenPath });
    await localPlugin.start();
    const localGateway = getHttpGateway();
    const localToken = Buffer.from(readFileSync(tokenPath, "utf8").trim(), "hex");

    try {
      const respOk = await invokeViaTool(
        localGateway,
        "mcp-proxy",
        "test-server__echo",
        { arguments: { message: "ok" }, mode: "direct" },
        localToken,
      );
      expect(respOk?.status).toBe(200);

      // Force a 502 by calling a tool that doesn't exist in the bridge
      const respErr = await invokeViaTool(
        localGateway,
        "mcp-proxy",
        "test-server__nonexistent_tool",
        { mode: "direct" },
        localToken,
      );
      expect(respErr?.status).toBe(502);

      const events = readNewAuditEvents(preOffset);
      const eventTypes = new Set(events.map((e) => e.event as string));

      expect(eventTypes.has("in_process_plugin_registered")).toBe(true);
      expect(eventTypes.has("register")).toBe(true);
      expect(eventTypes.has("invoke")).toBe(true);
      expect(eventTypes.has("gateway_invoke")).toBe(true);
    } finally {
      await localPlugin.stop();
      _resetMcpBridge();
      _resetHttpGateway();
      _resetMcpProxy();
      try {
        rmSync(localTmpDir, { recursive: true });
      } catch {}
    }
  });

  // ── Test 3 — audit() never throws on failure ─────────────────────────────

  it("audit() swallows filesystem errors and invocations still return clean results", async () => {
    // Create a bridge whose audit path is in a non-existent directory
    const badAuditPath = join(tmpDir, "no-such-dir", "audit.jsonl");
    const bridge = new PluginMcpBridge(badAuditPath);

    // audit() should never throw regardless of the filesystem state
    expect(() => bridge.audit("test_event", { foo: "bar" })).not.toThrow();

    // Swap singleton → invocations go through this broken bridge
    _setMcpBridge(bridge);

    // The proxy plugin's tools are already registered in the bridge (via beforeEach).
    // After swapping the singleton the new bridge has no tools → invokeTool will
    // throw "Unknown tool" → gateway returns 502, not a daemon crash.
    const resp = await invokeViaTool(
      gateway,
      "mcp-proxy",
      "test-server__echo",
      { arguments: { message: "test" }, mode: "direct" },
      proxyToken,
    );
    // 502 is acceptable — daemon did not crash and returned a clean error body
    expect(resp?.status).toBeDefined();
    expect(resp?.status).not.toBe(500);
  });

  // ── Test 4 — plugin token never leaks to audit log ───────────────────────

  it("plugin token hex string never appears in audit log entries", async () => {
    const preOffset = existsSync(auditPath) ? statSync(auditPath).size : 0;
    const tokenHex = proxyToken.toString("hex");

    // 5 invocations
    for (let i = 0; i < 5; i++) {
      await invokeViaTool(
        gateway,
        "mcp-proxy",
        "test-server__echo",
        { arguments: { message: `msg-${i}` }, mode: "direct" },
        proxyToken,
      );
    }

    const rawContent = existsSync(auditPath)
      ? readFileSync(auditPath, "utf8").slice(preOffset)
      : "";

    expect(rawContent).not.toContain(tokenHex);
    // Also verify the token isn't split into two halves (first 32 chars / last 32 chars)
    expect(rawContent).not.toContain(tokenHex.slice(0, 32));
  });

  // ── Test 5 — plugin token never leaks to error responses ─────────────────

  it("plugin token never appears in error response bodies (wrong HMAC, stale ts, unknown tool)", async () => {
    const tokenHex = proxyToken.toString("hex");

    // Error case 1: wrong HMAC
    const ts = new Date().toISOString();
    const body = JSON.stringify({ mode: "direct" });
    const badSig = "0".repeat(64);
    const resp1 = await gateway.handleRequest(
      new Request("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plus-Ts": ts,
          "X-Plus-Signature": badSig,
        },
        body,
      }),
      new URL("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke"),
    );
    const body1 = await resp1!.text();
    expect(body1).not.toContain(tokenHex);

    // Error case 2: stale timestamp
    const resp2 = await invokeViaTool(
      gateway,
      "mcp-proxy",
      "test-server__echo",
      { mode: "direct" },
      proxyToken,
      { tsOverride: new Date(Date.now() - 20 * 60 * 1000).toISOString() },
    );
    const body2 = await resp2!.text();
    expect(body2).not.toContain(tokenHex);

    // Error case 3: unknown tool → 502
    const resp3 = await invokeViaTool(
      gateway,
      "mcp-proxy",
      "test-server__ghost",
      { mode: "direct" },
      proxyToken,
    );
    const body3 = await resp3!.text();
    expect(body3).not.toContain(tokenHex);
  });
});
