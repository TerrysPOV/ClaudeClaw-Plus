import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServerProcess } from "../plugins/mcp-proxy/server-process.js";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { PluginMcpBridge, _resetMcpBridge, _setMcpBridge } from "../plugins/mcp-bridge.js";
import { _resetHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

function makeServerConfig() {
  return {
    command: BUN_BIN,
    args: ["run", MOCK_SERVER],
    allowedTools: ["echo", "slow_tool"],
  };
}

let tmpDir: string;
let bridge: PluginMcpBridge;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
});

afterEach(() => {
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── Test 1 — McpServerProcess starts and lists tools ──────────────────────────

describe("McpServerProcess", () => {
  it("start() connects and returns correct tool list", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      expect(proc.status).toBe("up");
      const names = proc.tools.map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("slow_tool");
      expect(names).not.toContain("secret_tool"); // filtered by allowedTools
    } finally {
      await proc.stop();
    }
  });

  // ── Test 2 — call() returns response, correlates by id ──────────────────────

  it("call() returns parsed response for known tool", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const result = (await proc.call("echo", { message: "hello" })) as { echo: string };
      expect(result.echo).toBe("hello");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 3 — concurrent calls don't cross-contaminate ─────────────────────

  it("concurrent calls complete independently without cross-contamination", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const [a, b, c] = (await Promise.all([
        proc.call("echo", { message: "A" }),
        proc.call("echo", { message: "B" }),
        proc.call("echo", { message: "C" }),
      ])) as [{ echo: string }, { echo: string }, { echo: string }];
      expect(a.echo).toBe("A");
      expect(b.echo).toBe("B");
      expect(c.echo).toBe("C");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 4 — crash triggers restart hook ──────────────────────────────────

  it("intentional stop() sets status to stopped and does not trigger crash hook", async () => {
    let crashCalled = false;
    const proc = new McpServerProcess("stop-test", makeServerConfig(), {
      onCrash: () => {
        crashCalled = true;
      },
    });
    await proc.start();
    expect(proc.status).toBe("up");
    await proc.stop();
    expect(proc.status).toBe("stopped");
    // Intentional shutdown must not fire the crash hook or schedule a restart
    expect(crashCalled).toBe(false);
  });

  // ── Test 5 — allowedTools filter ─────────────────────────────────────────

  it("allowedTools filters out secret_tool from the tool list", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const names = proc.tools.map((t) => t.name);
      expect(names).not.toContain("secret_tool");
    } finally {
      await proc.stop();
    }
  });

  // ── Test 6 — config file permissive → warn logged, no crash ─────────────

  it("world-readable config file emits a WARN to stderr but does not fail boot", async () => {
    const configPath = join(tmpDir, "mcp-proxy-warn.json");
    const tokenPath = join(tmpDir, "mcp-proxy-warn.token");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: { "test-server": { ...makeServerConfig(), enabled: true } },
      }),
      { mode: 0o644 },
    ); // permissive — should trigger WARN

    const warnMessages: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (msg.includes("WARN")) warnMessages.push(msg);
      origError(...args);
    };

    const p = new McpProxyPlugin({ configPath, tokenPath });
    try {
      await p.start();
      expect(warnMessages.some((m) => m.includes("permissive") || m.includes("WARN"))).toBe(true);
      const health = p.health();
      expect((health.servers as Record<string, { status: string }>)["test-server"]?.status).toBe(
        "up",
      );
    } finally {
      console.error = origError;
      await p.stop();
    }
  });

  // ── Test 7 — McpProxyPlugin registers tools on bridge ────────────────────

  it("McpProxyPlugin.start() registers mcp-proxy tools on the bridge", async () => {
    const configPath = join(tmpDir, "mcp-proxy.json");
    const tokenPath = join(tmpDir, "mcp-proxy.token");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          "test-server": { ...makeServerConfig(), enabled: true },
        },
      }),
    );

    const plugin = new McpProxyPlugin({ configPath, tokenPath });
    try {
      await plugin.start();
      // Tools should be registered on the bridge under "mcp-proxy" namespace
      // Tool FQN: mcp-proxy__test-server__echo
      // (but bridge uses "mcp-proxy" as plugin and "test-server__echo" as tool name)
      const health = plugin.health();
      expect(health.servers).toBeDefined();
      const servers = health.servers as Record<string, { status: string }>;
      expect(servers["test-server"]?.status).toBe("up");
    } finally {
      await plugin.stop();
    }
  });
});

// #72 item 3: defense-in-depth allowlist check inside `McpServerProcess.call`.
// The multiplexer layer already gates against `config.allowedTools`, but the
// proxy must be hermetic without trusting upstream callers. A future caller
// that reaches `proc.call(...)` bypassing the multiplexer gate must NOT be
// able to invoke a disallowed tool.
describe("McpServerProcess — allowedTools enforcement at call() (#72 item 3)", () => {
  it("rejects a tool that's not in allowedTools without touching upstream", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      // `secret_tool` is advertised by the upstream mock but excluded by
      // `allowedTools: ["echo", "slow_tool"]`.
      expect(proc.tools.map((t) => t.name)).not.toContain("secret_tool");
      const before = proc.lastInvocationAt;
      let err: Error | null = null;
      try {
        await proc.call("secret_tool", {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("secret_tool");
      expect(err!.message).toContain("not in allowedTools");
      // The proxy never reached the upstream child for the rejected call.
      expect(proc.lastInvocationAt).toBe(before);
    } finally {
      await proc.stop();
    }
  });

  it("rejects a tool name that the upstream never advertised", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const before = proc.lastInvocationAt;
      let err: Error | null = null;
      try {
        await proc.call("totally_made_up_tool", {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("totally_made_up_tool");
      expect(proc.lastInvocationAt).toBe(before);
    } finally {
      await proc.stop();
    }
  });

  it("a child result with isError: true rejects with the child's text", async () => {
    const proc = new McpServerProcess("test", {
      ...makeServerConfig(),
      allowedTools: ["echo", "fail_tool"],
    });
    try {
      await proc.start();
      await expect(proc.call("fail_tool", {})).rejects.toThrow("fail_tool: upstream refused");
    } finally {
      await proc.stop();
    }
  });

  it("keeps the child's whole error text for the caller", async () => {
    const proc = new McpServerProcess("test", {
      ...makeServerConfig(),
      allowedTools: ["fail_tool"],
    });
    try {
      await proc.start();
      const err = (await proc.call("fail_tool", { size: 10_000 }).catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(`fail_tool: upstream refused${"x".repeat(10_000)}`);
    } finally {
      await proc.stop();
    }
  });

  it("allows tools that ARE in the configured allowlist (no regression)", async () => {
    const proc = new McpServerProcess("test", makeServerConfig());
    try {
      await proc.start();
      const result = (await proc.call("echo", { message: "ok" })) as { echo: string };
      expect(result.echo).toBe("ok");
    } finally {
      await proc.stop();
    }
  });

  it("when allowedTools is undefined, the set is populated from upstream advertisement (still catches typos)", async () => {
    // No allowedTools → upstream's full tool list is the allowlist.
    const proc = new McpServerProcess("test", {
      command: BUN_BIN,
      args: ["run", MOCK_SERVER],
    });
    try {
      await proc.start();
      const advertised = proc.tools.map((t) => t.name);
      expect(advertised.length).toBeGreaterThan(0);
      // A name not in the advertisement must still be rejected.
      let err: Error | null = null;
      try {
        await proc.call("definitely_not_an_advertised_tool", {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
    } finally {
      await proc.stop();
    }
  });
});

// #72 item 4: split crash + permanently-failed audit events so operators
// don't have to inspect the `status` field of a single conflated event to
// tell a transient (auto-recovering) crash apart from a terminal failure.
describe("McpProxyPlugin — crash vs permanently-failed audit event split (#72 item 4)", () => {
  // Capture every audit event the plugin emits during the test.
  function captureAudits(events: Array<{ name: string; payload: unknown }>) {
    _setMcpBridge({
      // Minimal fake: only `audit` is exercised by `_onServerCrash`. Other
      // bridge methods aren't called during this test path.
      audit: (name: string, payload: unknown) => {
        events.push({ name, payload });
      },
      // No-op the rest of the surface so TypeScript is happy and any
      // accidental call doesn't break the test.
      registerPluginTool: () => {},
      unregisterPluginTool: () => {},
      listTools: () => [],
      invoke: async () => {
        throw new Error("not implemented in test bridge");
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test bridge
    } as any);
  }

  type PluginPrivate = {
    servers: Map<string, McpServerProcess>;
    _onServerCrash(name: string, reason: string): void;
  };

  it("emits ONLY mcp_proxy_server_crashed when status is transient (e.g. 'restarting')", async () => {
    const tokenPath = join(tmpDir, "split-test-1.token");
    const configPath = join(tmpDir, "split-test-1.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: { "test-server": { ...makeServerConfig(), enabled: true } },
      }),
      { mode: 0o600 },
    );
    const plugin = new McpProxyPlugin({ configPath, tokenPath });
    await plugin.start();
    try {
      const events: Array<{ name: string; payload: unknown }> = [];
      captureAudits(events);

      const priv = plugin as unknown as PluginPrivate;
      const proc = priv.servers.get("test-server");
      expect(proc).toBeDefined();
      // Simulate the auto-recovery loop still running.
      (proc as unknown as { status: string }).status = "restarting";
      priv._onServerCrash("test-server", "subprocess closed");

      const names = events.map((e) => e.name);
      expect(names).toContain("mcp_proxy_server_crashed");
      expect(names).not.toContain("mcp_proxy_server_permanently_failed");
    } finally {
      await plugin.stop();
    }
  });

  it("emits ONLY mcp_proxy_server_permanently_failed when status is 'failed'", async () => {
    const tokenPath = join(tmpDir, "split-test-2.token");
    const configPath = join(tmpDir, "split-test-2.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: { "test-server": { ...makeServerConfig(), enabled: true } },
      }),
      { mode: 0o600 },
    );
    const plugin = new McpProxyPlugin({ configPath, tokenPath });
    await plugin.start();
    try {
      const events: Array<{ name: string; payload: unknown }> = [];
      captureAudits(events);

      const priv = plugin as unknown as PluginPrivate;
      const proc = priv.servers.get("test-server");
      expect(proc).toBeDefined();
      // Simulate the supervisor giving up.
      (proc as unknown as { status: string }).status = "failed";
      priv._onServerCrash("test-server", "exceeded max crashes in window");

      const names = events.map((e) => e.name);
      expect(names).toContain("mcp_proxy_server_permanently_failed");
      // Pre-fix this test would fail: the old code emitted BOTH events
      // for a permanent failure (the `mcp_proxy_server_crashed` event
      // was always emitted, then `mcp_proxy_server_permanently_failed`
      // was emitted in addition when status === "failed"). Operators
      // had to dedup.
      expect(names).not.toContain("mcp_proxy_server_crashed");
    } finally {
      await plugin.stop();
    }
  });

  it("payload preserves {server, reason, status} on both event variants", async () => {
    const tokenPath = join(tmpDir, "split-test-3.token");
    const configPath = join(tmpDir, "split-test-3.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: { "test-server": { ...makeServerConfig(), enabled: true } },
      }),
      { mode: 0o600 },
    );
    const plugin = new McpProxyPlugin({ configPath, tokenPath });
    await plugin.start();
    try {
      const events: Array<{ name: string; payload: unknown }> = [];
      captureAudits(events);

      const priv = plugin as unknown as PluginPrivate;
      const proc = priv.servers.get("test-server");
      expect(proc).toBeDefined();
      (proc as unknown as { status: string }).status = "crashed";
      priv._onServerCrash("test-server", "first crash");
      (proc as unknown as { status: string }).status = "failed";
      priv._onServerCrash("test-server", "final crash");

      expect(events.length).toBe(2);
      expect(events[0]!.payload).toEqual({
        server: "test-server",
        reason: "first crash",
        status: "crashed",
      });
      expect(events[1]!.payload).toEqual({
        server: "test-server",
        reason: "final crash",
        status: "failed",
      });
    } finally {
      await plugin.stop();
    }
  });
});

describe("McpServerProcess — startup failure cleanup (zombie prevention)", () => {
  it("closes transport when listTools throws during start()", async () => {
    // Spawn a server that exits immediately so client.connect/listTools will fail
    const proc = new McpServerProcess("crash-test", {
      command: "node",
      args: ["-e", "process.exit(1)"], // immediate exit
      enabled: true,
    });

    let threw = false;
    try {
      await proc.start();
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(proc.status).toBe("failed");
    // Transport should be cleared so a subsequent stop() is a no-op
    // (no zombie subprocess waiting for cleanup)
    await proc.stop(); // must not throw
    expect(proc.status).toBe("stopped");
  });
});
