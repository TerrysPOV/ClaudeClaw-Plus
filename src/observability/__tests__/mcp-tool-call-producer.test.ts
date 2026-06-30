import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpToolCallTelemetryProducer } from "../mcp-tool-call-producer.js";
import { ToolCallSink } from "../tool-call-sink.js";
import type { ToolCallEvent } from "../tool-call.js";

const RANGE = {
  start: new Date("2026-05-25T00:00:00.000Z"),
  end: new Date("2026-05-26T00:00:00.000Z"),
};

function seed(logPath: string, events: ToolCallEvent[]): void {
  const sink = new ToolCallSink({ path: logPath, autoFlush: false });
  for (const e of events) sink.record(e);
  sink.flush();
}

function ev(over: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    ts: "2026-05-25T12:00:00.000Z",
    plugin: "alpha",
    tool: "echo",
    agent_id: "pty-1",
    status: "ok",
    duration_ms: 10,
    args_hash: "aaaa",
    ...over,
  };
}

describe("McpToolCallTelemetryProducer", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-tc-producer-"));
    logPath = join(dir, "mcp-tool-calls.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advertises mcp.tool_call unavailable when no log exists", () => {
    const p = new McpToolCallTelemetryProducer({ logPath });
    const cap = p.capabilities()[0]!;
    expect(cap.stream).toBe("mcp.tool_call");
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no mcp\.tool_call log/);
  });

  it("reads the audited log back as duration-valued samples with full labels", async () => {
    seed(logPath, [
      ev({ tool: "echo", status: "ok", duration_ms: 12 }),
      ev({ tool: "fetch", status: "error", duration_ms: 99, error: "nope" }),
    ]);
    const p = new McpToolCallTelemetryProducer({ logPath });
    expect(p.capabilities()[0]!.available).toBe(true);

    const samples = await p.query("mcp.tool_call", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([12, 99]);
    const echo = samples.find((s) => s.labels?.tool === "echo")!;
    expect(echo.labels).toMatchObject({
      plugin: "alpha",
      tool: "echo",
      status: "ok",
      agent_id: "pty-1",
      args_hash: "aaaa",
    });
  });

  it("returns [] for a stream it does not own", async () => {
    seed(logPath, [ev({})]);
    const p = new McpToolCallTelemetryProducer({ logPath });
    expect(await p.query("session_cost", RANGE)).toEqual([]);
  });

  it("honours the time window (half-open [start, end))", async () => {
    seed(logPath, [
      ev({ ts: "2026-05-25T12:00:00.000Z" }), // in
      ev({ ts: "2026-05-24T23:59:59.000Z" }), // before
      ev({ ts: "2026-05-26T00:00:00.000Z" }), // == end → excluded
    ]);
    const p = new McpToolCallTelemetryProducer({ logPath });
    const samples = await p.query("mcp.tool_call", RANGE);
    expect(samples).toHaveLength(1);
  });

  it("applies label filters", async () => {
    seed(logPath, [ev({ plugin: "alpha", tool: "echo" }), ev({ plugin: "beta", tool: "echo" })]);
    const p = new McpToolCallTelemetryProducer({ logPath });
    const samples = await p.query("mcp.tool_call", RANGE, { plugin: "beta" });
    expect(samples).toHaveLength(1);
    expect(samples[0]!.labels?.plugin).toBe("beta");
  });

  it("tolerates a malformed trailing line (concurrent partial write)", async () => {
    seed(logPath, [ev({})]);
    // Simulate a torn append: a partial JSON line at the tail.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(logPath, '{"event":"mcp.tool_call","detail":{"dur');
    const p = new McpToolCallTelemetryProducer({ logPath });
    const samples = await p.query("mcp.tool_call", RANGE);
    expect(samples).toHaveLength(1);
  });
});
