import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { PluginMcpBridge, _resetMcpBridge, getMcpBridge } from "../../plugins/mcp-bridge.js";
import { __setToolCallSinkForTest, ToolCallSink } from "../../observability/tool-call-sink.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBridge(): { bridge: PluginMcpBridge; auditPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
  const auditPath = join(tmpDir, "audit.jsonl");
  const bridge = new PluginMcpBridge(auditPath);
  return { bridge, auditPath, tmpDir };
}

function readAuditLines(auditPath: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const echoTool = {
  name: "echo",
  description: "Echo input back",
  schema: z.object({ message: z.string() }),
  handler: async (args: { message: string }) => args.message,
};

const addTool = {
  name: "add",
  description: "Add two numbers",
  schema: z.object({ a: z.number(), b: z.number() }),
  handler: async (args: { a: number; b: number }) => args.a + args.b,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PluginMcpBridge", () => {
  describe("registerPluginTool + listTools", () => {
    it("registers a tool and returns it in listTools with correct FQN", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      const tools = bridge.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].fqn).toBe("my-plugin__echo");
      expect(tools[0].description).toBe("Echo input back");
      expect(tools[0].inputSchema).toMatchObject({ type: "object" });
    });

    it("registers multiple tools from different plugins", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("plugin-a", echoTool);
      bridge.registerPluginTool("plugin-b", addTool);
      const tools = bridge.listTools();

      expect(tools).toHaveLength(2);
      const fqns = tools.map((t) => t.fqn);
      expect(fqns).toContain("plugin-a__echo");
      expect(fqns).toContain("plugin-b__add");
    });
  });

  describe("duplicate registration", () => {
    it("throws on duplicate tool FQN", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      expect(() => bridge.registerPluginTool("my-plugin", echoTool)).toThrow(
        /Duplicate tool registration/,
      );
    });

    it("allows same tool name for different plugins", () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("plugin-a", echoTool);
      expect(() => bridge.registerPluginTool("plugin-b", echoTool)).not.toThrow();
    });
  });

  describe("invokeTool", () => {
    it("calls handler with valid args and returns result", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("calc", addTool);
      const result = await bridge.invokeTool("calc__add", { a: 3, b: 4 });
      expect(result).toBe(7);
    });

    it("throws on invalid args (zod validation failure)", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("my-plugin", echoTool);
      await expect(bridge.invokeTool("my-plugin__echo", { message: 42 })).rejects.toThrow(
        /Invalid args/,
      );
    });

    it("throws on unknown tool name", async () => {
      const { bridge } = makeBridge();

      await expect(bridge.invokeTool("nonexistent__tool", {})).rejects.toThrow(/Unknown tool/);
    });

    it("propagates handler errors", async () => {
      const { bridge } = makeBridge();

      bridge.registerPluginTool("failing", {
        name: "fail",
        description: "Always fails",
        schema: z.object({}),
        handler: async () => {
          throw new Error("handler exploded");
        },
      });
      await expect(bridge.invokeTool("failing__fail", {})).rejects.toThrow("handler exploded");
    });
  });

  // #230/#232: the bridge is the second dispatch path; its calls belong on the
  // same `mcp.tool_call` chain as the multiplexer's, one event per call.
  describe("mcp.tool_call chain", () => {
    let sink: ToolCallSink;
    beforeEach(() => {
      sink = new ToolCallSink({ path: null, autoFlush: false });
      __setToolCallSinkForTest(sink);
    });
    afterEach(() => __setToolCallSinkForTest(null));

    it("records a successful call with plugin, tool, status and duration", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("calc", addTool);
      await bridge.invokeTool("calc__add", { a: 1, b: 2 });

      expect(sink.pending()).toHaveLength(1);
      const [e] = sink.pending();
      expect(e).toMatchObject({
        plugin: "calc",
        tool: "add",
        agent_id: "plugin-bridge",
        status: "ok",
      });
      expect(e.error).toBeUndefined();
      expect(typeof e.duration_ms).toBe("number");
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    });

    it("records a handler failure with its message", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("failing", {
        name: "fail",
        description: "Always fails",
        schema: z.object({}),
        handler: async () => {
          throw new Error("handler exploded");
        },
      });
      await expect(bridge.invokeTool("failing__fail", {})).rejects.toThrow("handler exploded");

      expect(sink.pending()).toHaveLength(1);
      expect(sink.pending()[0]).toMatchObject({
        plugin: "failing",
        tool: "fail",
        status: "error",
        error: "handler exploded",
      });
    });

    it("records a validation refusal without the args", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("my-plugin", echoTool);
      await expect(
        bridge.invokeTool("my-plugin__echo", { message: 42, secret: "hunter2" }),
      ).rejects.toThrow(/Invalid args/);

      expect(sink.pending()).toHaveLength(1);
      const [e] = sink.pending();
      expect(e).toMatchObject({
        plugin: "my-plugin",
        tool: "echo",
        status: "error",
        error: "invalid_args",
      });
      expect(JSON.stringify(e)).not.toContain("hunter2");
    });

    it("records a call to an unknown tool without taking its prefix as a plugin", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("calc", addTool);
      await expect(bridge.invokeTool("calc__missing", {})).rejects.toThrow(/Unknown tool/);

      expect(sink.pending()).toHaveLength(1);
      expect(sink.pending()[0]).toMatchObject({
        plugin: "unknown",
        tool: "calc__missing",
        status: "error",
        error: "unknown_tool",
      });
    });

    it("names the upstream server and tool for a proxied tool", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("mcp-multiplexer", {
        name: "github__search",
        description: "proxied",
        upstream: { server: "github", tool: "search" },
        schema: z.object({}),
        handler: async () => "hit",
      });
      await bridge.invokeTool("mcp-multiplexer__github__search", {});

      expect(sink.pending()[0]).toMatchObject({ plugin: "github", tool: "search", status: "ok" });
    });

    it("records a call that throws before the handler runs", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("strict", {
        name: "refined",
        description: "refine throws",
        schema: z.object({ v: z.string() }).refine((a) => {
          throw new Error(`refine saw ${a.v}`);
        }),
        handler: async () => "unreachable",
      });
      bridge.registerPluginTool("calc", addTool);
      bridge.signCall = () => {
        throw new Error("secret store unavailable");
      };
      await expect(bridge.invokeTool("strict__refined", { v: "hunter2" })).rejects.toThrow(
        "refine saw hunter2",
      );
      await expect(bridge.invokeTool("calc__add", { a: 1, b: 2 })).rejects.toThrow(
        "secret store unavailable",
      );

      expect(sink.pending()).toHaveLength(2);
      expect(sink.pending()[0]).toMatchObject({
        plugin: "strict",
        status: "error",
        error: "invalid_args",
      });
      expect(JSON.stringify(sink.pending()[0])).not.toContain("hunter2");
      expect(sink.pending()[1]).toMatchObject({
        plugin: "calc",
        tool: "add",
        status: "error",
        error: "secret store unavailable",
      });
    });
  });

  // #230: per-plugin kill switch, `settings.mcp.bridge.plugins.<id>`.
  describe("tool policy", () => {
    const safeTool = {
      name: "safe",
      description: "read-only",
      schema: z.object({}),
      handler: async () => "safe-ran",
    };
    const dangerTool = {
      name: "danger",
      description: "side effect",
      schema: z.object({}),
      handler: async () => "danger-ran",
    };
    let sink: ToolCallSink;
    beforeEach(() => {
      sink = new ToolCallSink({ path: null, autoFlush: false });
      __setToolCallSinkForTest(sink);
    });
    afterEach(() => __setToolCallSinkForTest(null));

    function demoBridge(): { bridge: PluginMcpBridge; auditPath: string } {
      const { bridge, auditPath } = makeBridge();
      bridge.registerPluginTool("demo", safeTool);
      bridge.registerPluginTool("demo", dangerTool);
      bridge.registerPluginTool("other", echoTool);
      return { bridge, auditPath };
    }

    it("absent policy keeps every tool callable and listed", async () => {
      const { bridge } = demoBridge();
      bridge.setToolPolicy(undefined);
      expect(await bridge.invokeTool("demo__danger", {})).toBe("danger-ran");
      expect(bridge.listTools().map((t) => t.fqn)).toEqual([
        "demo__safe",
        "demo__danger",
        "other__echo",
      ]);
    });

    it("deniedTools refuses one tool without touching the rest of the plugin", async () => {
      const { bridge, auditPath } = demoBridge();
      bridge.setToolPolicy({ plugins: { demo: { deniedTools: ["danger"] } } });

      await expect(bridge.invokeTool("demo__danger", {})).rejects.toThrow(/tool_denied/);
      expect(await bridge.invokeTool("demo__safe", {})).toBe("safe-ran");
      expect(await bridge.invokeTool("other__echo", { message: "hi" })).toBe("hi");
      expect(bridge.listTools().map((t) => t.fqn)).toEqual(["demo__safe", "other__echo"]);

      const denied = readAuditLines(auditPath).filter((l) => l.event === "policy_denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        fqn: "demo__danger",
        pluginId: "demo",
        toolName: "danger",
        reason: "tool_denied",
      });
      expect(
        readAuditLines(auditPath).some((l) => l.event === "invoke" && l.fqn === "demo__danger"),
      ).toBe(false);
      expect(sink.pending()[0]).toMatchObject({
        plugin: "demo",
        tool: "danger",
        status: "error",
        error: "tool_denied",
      });
    });

    it("allowedTools limits the plugin to the listed tools; deniedTools wins over it", async () => {
      const { bridge } = demoBridge();
      bridge.setToolPolicy({
        plugins: { demo: { allowedTools: ["safe", "danger"], deniedTools: ["danger"] } },
      });
      await expect(bridge.invokeTool("demo__danger", {})).rejects.toThrow(/tool_denied/);

      bridge.setToolPolicy({ plugins: { demo: { allowedTools: ["safe"] } } });
      await expect(bridge.invokeTool("demo__danger", {})).rejects.toThrow(/not_in_allowed_set/);
      expect(await bridge.invokeTool("demo__safe", {})).toBe("safe-ran");
    });

    it("enabled: false refuses and hides every tool of the plugin", async () => {
      const { bridge } = demoBridge();
      bridge.setToolPolicy({ plugins: { demo: { enabled: false } } });
      await expect(bridge.invokeTool("demo__safe", {})).rejects.toThrow(/plugin_disabled/);
      await expect(bridge.invokeTool("demo__danger", {})).rejects.toThrow(/plugin_disabled/);
      expect(bridge.listTools().map((t) => t.fqn)).toEqual(["other__echo"]);
    });

    it("a new policy takes effect on the next call (hot reload), no re-registration", async () => {
      const { bridge } = demoBridge();
      bridge.setToolPolicy({ plugins: { demo: { deniedTools: ["danger"] } } });
      await expect(bridge.invokeTool("demo__danger", {})).rejects.toThrow(/tool_denied/);
      bridge.setToolPolicy({ plugins: {} });
      expect(await bridge.invokeTool("demo__danger", {})).toBe("danger-ran");
    });

    it("fences a proxied tool by its upstream server or by its wrapper plugin", async () => {
      const { bridge, auditPath } = makeBridge();
      bridge.registerPluginTool("mcp-proxy", {
        name: "github__delete_repo",
        description: "proxied",
        upstream: { server: "github", tool: "delete_repo" },
        schema: z.object({}),
        handler: async () => "deleted",
      });
      bridge.registerPluginTool("mcp-proxy", {
        name: "github__search",
        description: "proxied",
        upstream: { server: "github", tool: "search" },
        schema: z.object({}),
        handler: async () => "found",
      });

      bridge.setToolPolicy({ plugins: { github: { deniedTools: ["delete_repo"] } } });
      await expect(bridge.invokeTool("mcp-proxy__github__delete_repo", {})).rejects.toThrow(
        /tool_denied/,
      );
      expect(await bridge.invokeTool("mcp-proxy__github__search", {})).toBe("found");
      expect(readAuditLines(auditPath).find((l) => l.event === "policy_denied")).toMatchObject({
        pluginId: "mcp-proxy",
        toolName: "github__delete_repo",
        upstream: { server: "github", tool: "delete_repo" },
      });

      bridge.setToolPolicy({ plugins: { "mcp-proxy": { deniedTools: ["github__delete_repo"] } } });
      await expect(bridge.invokeTool("mcp-proxy__github__delete_repo", {})).rejects.toThrow(
        /tool_denied/,
      );

      // Either key can refuse: the wrapper allows it, the server entry does not.
      bridge.setToolPolicy({
        plugins: {
          "mcp-proxy": { allowedTools: ["github__delete_repo", "github__search"] },
          github: { enabled: false },
        },
      });
      await expect(bridge.invokeTool("mcp-proxy__github__search", {})).rejects.toThrow(
        /plugin_disabled/,
      );
      expect(bridge.listTools()).toEqual([]);
    });

    it("defaultDeny refuses and hides every plugin that has no entry", async () => {
      const { bridge, auditPath } = makeBridge();
      bridge.registerPluginTool("thirdparty", {
        name: "anything",
        description: "freshly registered",
        schema: z.record(z.string(), z.unknown()),
        handler: async () => "executed",
      });
      bridge.registerPluginTool("calc", addTool);
      bridge.setToolPolicy({ plugins: { calc: {} }, defaultDeny: true });

      await expect(bridge.invokeTool("thirdparty__anything", {})).rejects.toThrow(/default_deny/);
      expect(await bridge.invokeTool("calc__add", { a: 1, b: 1 })).toBe(2);
      expect(bridge.listTools().map((t) => t.fqn)).toEqual(["calc__add"]);
      expect(readAuditLines(auditPath).find((l) => l.event === "policy_denied")).toMatchObject({
        fqn: "thirdparty__anything",
        reason: "default_deny",
      });
      expect(sink.pending()[0]).toMatchObject({
        plugin: "thirdparty",
        status: "error",
        error: "default_deny",
      });

      bridge.setToolPolicy({ plugins: { calc: {} }, defaultDeny: false });
      expect(await bridge.invokeTool("thirdparty__anything", {})).toBe("executed");
      // Each flip of the posture is audited, an unchanged one is not.
      bridge.setToolPolicy({ plugins: { calc: {} } });
      expect(
        readAuditLines(auditPath)
          .filter((l) => l.event === "policy_default_deny")
          .map((l) => [l.enabled, l.entries]),
      ).toEqual([
        [true, 1],
        [false, 1],
      ]);
    });

    it("defaultDeny lets a proxied tool through when its server or its wrapper is listed", async () => {
      const { bridge } = makeBridge();
      bridge.registerPluginTool("mcp-proxy", {
        name: "github__search",
        description: "proxied",
        upstream: { server: "github", tool: "search" },
        schema: z.object({}),
        handler: async () => "found",
      });
      bridge.setToolPolicy({ plugins: {}, defaultDeny: true });
      await expect(bridge.invokeTool("mcp-proxy__github__search", {})).rejects.toThrow(
        /default_deny/,
      );
      bridge.setToolPolicy({ plugins: { github: {} }, defaultDeny: true });
      expect(await bridge.invokeTool("mcp-proxy__github__search", {})).toBe("found");
      bridge.setToolPolicy({ plugins: { "mcp-proxy": {} }, defaultDeny: true });
      expect(await bridge.invokeTool("mcp-proxy__github__search", {})).toBe("found");
      // Listed, and still fenced by its own entry.
      bridge.setToolPolicy({ plugins: { github: { deniedTools: ["search"] } }, defaultDeny: true });
      await expect(bridge.invokeTool("mcp-proxy__github__search", {})).rejects.toThrow(
        /tool_denied/,
      );
    });

    it("refuses before validating or running anything", async () => {
      const { bridge } = makeBridge();
      let ran = false;
      bridge.registerPluginTool("demo", {
        name: "strict",
        description: "",
        schema: z.object({ v: z.string() }),
        handler: async () => {
          ran = true;
        },
      });
      bridge.setToolPolicy({ plugins: { demo: { deniedTools: ["strict"] } } });
      await expect(bridge.invokeTool("demo__strict", { v: 1 })).rejects.toThrow(/tool_denied/);
      expect(ran).toBe(false);
      expect(sink.pending()[0]).toMatchObject({ error: "tool_denied" });
    });
  });

  // #232: settings.mcp.audit "enforce" on the bridge path — no log, no action.
  describe("mandatory audit (enforce)", () => {
    afterEach(() => __setToolCallSinkForTest(null));

    it("refuses before the handler runs when the intent cannot be logged", async () => {
      const sink = new ToolCallSink({
        path: null,
        policy: "enforce",
        autoFlush: false,
        logFactory: () => ({
          append() {
            throw new Error("chain unwritable");
          },
        }),
      });
      __setToolCallSinkForTest(sink);
      const { bridge, auditPath } = makeBridge();
      let ran = false;
      bridge.registerPluginTool("demo", {
        name: "act",
        description: "side effect",
        schema: z.object({}),
        handler: async () => {
          ran = true;
          return "done";
        },
      });

      await expect(bridge.invokeTool("demo__act", {})).rejects.toThrow(/audit log is unavailable/);
      expect(ran).toBe(false);
      const lines = readAuditLines(auditPath);
      expect(lines.find((l) => l.event === "audit_enforced_reject")).toMatchObject({
        fqn: "demo__act",
        pluginId: "demo",
        error: "chain unwritable",
      });
      expect(lines.some((l) => l.event === "invoke")).toBe(false);
      expect(sink.pending()[0]).toMatchObject({ status: "error", error: "audit_unavailable" });
    });

    it("appends the intent, then runs the call, when the chain is writable", async () => {
      const appended: Array<{ event: string; subject?: string; detail?: unknown }> = [];
      __setToolCallSinkForTest(
        new ToolCallSink({
          path: null,
          policy: "enforce",
          autoFlush: false,
          logFactory: () => ({
            append(e: { event: string; subject?: string; detail?: unknown }) {
              appended.push(e);
            },
          }),
        }),
      );
      const { bridge } = makeBridge();
      bridge.registerPluginTool("calc", addTool);
      expect(await bridge.invokeTool("calc__add", { a: 2, b: 3 })).toBe(5);
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        event: "mcp.tool_call_intent",
        subject: "calc",
        detail: { tool: "add", agent_id: "plugin-bridge" },
      });
    });

    it("best-effort never blocks a call on an unwritable chain", async () => {
      __setToolCallSinkForTest(
        new ToolCallSink({
          path: null,
          policy: "best-effort",
          autoFlush: false,
          logFactory: () => ({
            append() {
              throw new Error("chain unwritable");
            },
          }),
        }),
      );
      const { bridge } = makeBridge();
      bridge.registerPluginTool("calc", addTool);
      expect(await bridge.invokeTool("calc__add", { a: 2, b: 3 })).toBe(5);
    });
  });

  describe("HMAC signing", () => {
    it("signCall + verifyCall round-trip returns true", () => {
      const { bridge } = makeBridge();

      const body = { foo: "bar", count: 42 };
      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", body, ts);
      expect(bridge.verifyCall("test-plugin", body, ts, sig)).toBe(true);
    });

    it("verifyCall rejects tampered signature", () => {
      const { bridge } = makeBridge();

      const body = { foo: "bar" };
      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", body, ts);
      // Flip the last hex char to a guaranteed-different one. A fixed suffix
      // (e.g. "00") equals the real signature 1 time in 256 and flakes.
      const tampered = sig.slice(0, -1) + (sig.at(-1) === "0" ? "1" : "0");
      expect(tampered).not.toBe(sig);
      expect(bridge.verifyCall("test-plugin", body, ts, tampered)).toBe(false);
    });

    it("verifyCall rejects tampered signature even when the real one ends in 00 or 0/1", () => {
      for (const real of ["ab".repeat(31) + "00", "ab".repeat(31) + "01", "ab".repeat(31) + "ff"]) {
        const { bridge } = makeBridge();
        bridge.signCall = () => real;
        const body = { foo: "bar" };
        const ts = Date.now();
        const sig = bridge.signCall("test-plugin", body, ts);
        const tampered = sig.slice(0, -1) + (sig.at(-1) === "0" ? "1" : "0");
        expect(tampered).not.toBe(sig);
        expect(bridge.verifyCall("test-plugin", body, ts, sig)).toBe(true);
        expect(bridge.verifyCall("test-plugin", body, ts, tampered)).toBe(false);
      }
    });

    it("verifyCall rejects tampered body", () => {
      const { bridge } = makeBridge();

      const ts = Date.now();
      const sig = bridge.signCall("test-plugin", { foo: "bar" }, ts);
      expect(bridge.verifyCall("test-plugin", { foo: "TAMPERED" }, ts, sig)).toBe(false);
    });

    it("verifyCall rejects tampered ts", () => {
      const { bridge } = makeBridge();

      const ts = Date.now();
      const body = { x: 1 };
      const sig = bridge.signCall("test-plugin", body, ts);
      expect(bridge.verifyCall("test-plugin", body, ts + 1, sig)).toBe(false);
    });
  });

  describe("audit log", () => {
    it("writes a register entry when a tool is registered", () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      const lines = readAuditLines(auditPath);

      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("register");
      expect(lines[0].fqn).toBe("audit-test__echo");
    });

    it("writes invoke + success entries when tool is called", async () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      await bridge.invokeTool("audit-test__echo", { message: "hello" });
      const lines = readAuditLines(auditPath);

      const invokeEntry = lines.find((l) => l.event === "invoke");
      expect(invokeEntry).toBeDefined();
      expect(invokeEntry?.success).toBe(true);
    });

    it("bounds a handler error in the audit line, not for the caller", async () => {
      const { bridge, auditPath } = makeBridge();
      const long = `child said: ${"x".repeat(100_000)}`;
      bridge.registerPluginTool("audit-test", {
        name: "fails",
        description: "Throws a long error",
        schema: z.object({}),
        handler: async () => {
          throw new Error(long);
        },
      });

      await expect(bridge.invokeTool("audit-test__fails", {})).rejects.toThrow(long);

      const errorEntry = readAuditLines(auditPath).find((l) => l.event === "error");
      expect(errorEntry?.phase).toBe("handler");
      const recorded = errorEntry?.error as string;
      expect(recorded.startsWith("child said: x")).toBe(true);
      expect(recorded.length).toBeLessThan(2_100);
      expect(recorded).toContain(`…[truncated ${long.length - 2_000} chars]`);
    });

    it("writes error entry on validation failure", async () => {
      const { bridge, auditPath } = makeBridge();

      bridge.registerPluginTool("audit-test", echoTool);
      try {
        await bridge.invokeTool("audit-test__echo", { message: 999 });
      } catch {
        // expected
      }

      const lines = readAuditLines(auditPath);
      const errorEntry = lines.find((l) => l.event === "error");
      expect(errorEntry).toBeDefined();
      expect(errorEntry?.phase).toBe("validation");
    });
  });

  describe("per-plugin secret", () => {
    it("auto-creates a 32-byte secret for a plugin", () => {
      const { bridge } = makeBridge();

      const secret = bridge.loadOrCreateSecret("new-plugin");
      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.length).toBe(32);
    });

    it("returns the same secret on subsequent calls (cached)", () => {
      const { bridge } = makeBridge();

      const a = bridge.loadOrCreateSecret("plugin-x");
      const b = bridge.loadOrCreateSecret("plugin-x");
      expect(a.equals(b)).toBe(true);
    });

    it("different plugins get different secrets", () => {
      const { bridge } = makeBridge();

      const a = bridge.loadOrCreateSecret("plugin-alpha");
      const b = bridge.loadOrCreateSecret("plugin-beta");
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("getMcpBridge singleton", () => {
    it("returns the same instance on multiple calls", () => {
      _resetMcpBridge();
      const a = getMcpBridge();
      const b = getMcpBridge();
      expect(a).toBe(b);
      _resetMcpBridge();
    });
  });
});

describe("path traversal protection (pluginId validation)", () => {
  it("rejects pluginId with .. segments", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("../../evil")).toThrow(/invalid pluginId/);
    expect(() =>
      bridge.registerPluginTool("../../evil", {
        name: "x",
        description: "",
        schema: {},
        handler: async () => ({}),
      }),
    ).toThrow(/invalid pluginId/);
    expect(() => bridge.unregisterPlugin("../../evil")).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId with path separators", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("a/b")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a\\b")).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId with dots or special chars", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret(".hidden")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a.b")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a b")).toThrow(/invalid pluginId/);
  });

  it("accepts valid pluginId (lowercase + digits + dashes, starts with letter)", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt-valid.jsonl");
    // Should not throw
    bridge.loadOrCreateSecret("mcp-proxy");
    bridge.loadOrCreateSecret("archiviste");
    bridge.loadOrCreateSecret("plugin-a1");
  });

  it("rejects empty / too-long pluginId", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("a".repeat(65))).toThrow(/invalid pluginId/);
  });

  it("rejects pluginId starting with digit or dash", () => {
    const bridge = new PluginMcpBridge("/tmp/test-audit-pt.jsonl");
    expect(() => bridge.loadOrCreateSecret("1plugin")).toThrow(/invalid pluginId/);
    expect(() => bridge.loadOrCreateSecret("-plugin")).toThrow(/invalid pluginId/);
  });
});
