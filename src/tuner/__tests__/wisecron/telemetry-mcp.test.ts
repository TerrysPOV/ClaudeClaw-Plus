/**
 * Telemetry over the MCP bridge: the host-served tools, the tuner-side
 * `McpTelemetryProvider` (in-process AND over a real MCP transport), graceful
 * degradation, and the audit provenance of served queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginMcpBridge, _resetMcpBridge, _setMcpBridge } from "../../../plugins/mcp-bridge.js";
import { AuditLog } from "../../../skills-tuner/core/audit-log.js";
import {
  type DateRange,
  type MetricSample,
  type TelemetryCapability,
  type TelemetryProvider,
  type TelemetryStream,
  TELEMETRY_CONTRACT_VERSION,
} from "../../../skills-tuner/core/telemetry.js";
import {
  bridgeToolCaller,
  McpTelemetryProvider,
  registerHostTelemetryTools,
  TELEMETRY_CAPABILITIES_TOOL,
  TELEMETRY_QUERY_TOOL,
  type TelemetryMcpClient,
} from "../../wisecron/telemetry-mcp.js";

const RANGE: DateRange = {
  start: new Date("2026-05-13T00:00:00Z"),
  end: new Date("2026-05-21T00:00:00Z"),
};
const IN = new Date("2026-05-20T12:00:00Z");

/** Deterministic host producer: advertises cron_run, answers queries for it. */
class StubHostProvider implements TelemetryProvider {
  queries: Array<{ stream: TelemetryStream; range: DateRange }> = [];
  constructor(private readonly available = true) {}
  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }
  capabilities(): TelemetryCapability[] {
    return [
      this.available
        ? { stream: "cron_run", schemaVersion: TELEMETRY_CONTRACT_VERSION, available: true }
        : {
            stream: "cron_run",
            schemaVersion: TELEMETRY_CONTRACT_VERSION,
            available: false,
            reason: "no wisecron units in this env",
          },
    ];
  }
  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    this.queries.push({ stream, range });
    if (stream !== "cron_run") return [];
    return [{ ts: IN, value: 0, labels: { unit: "wisecron-a.service", status: "success" } }];
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "telemetry-mcp-"));
  _resetMcpBridge();
  _setMcpBridge(new PluginMcpBridge(join(tmpDir, "bridge-audit.jsonl")));
});

afterEach(() => {
  _resetMcpBridge();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerHostTelemetryTools + bridgeToolCaller (in-process)", () => {
  it("round-trips capabilities + query through the bridge", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const host = new StubHostProvider();
    const reg = registerHostTelemetryTools(bridge, { provider: host });
    expect(reg.capabilitiesTool).toBe(TELEMETRY_CAPABILITIES_TOOL);
    expect(reg.queryTool).toBe(TELEMETRY_QUERY_TOOL);

    const provider = new McpTelemetryProvider(bridgeToolCaller(bridge));
    const conn = await provider.connect();
    expect(conn.ok).toBe(true);
    expect(provider.isConnected()).toBe(true);
    expect(provider.contractVersion()).toBe(TELEMETRY_CONTRACT_VERSION);

    const cap = provider.capabilities().find((c) => c.stream === "cron_run");
    expect(cap?.available).toBe(true);

    const samples = await provider.query("cron_run", RANGE);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(0);
    expect(samples[0]?.ts.toISOString()).toBe(IN.toISOString());
    expect(samples[0]?.labels).toEqual({ unit: "wisecron-a.service", status: "success" });

    // The host actually received the query over the boundary.
    expect(host.queries).toHaveLength(1);
    expect(host.queries[0]?.stream).toBe("cron_run");
  });

  it("re-registration replaces the prior tools (idempotent surface)", () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    registerHostTelemetryTools(bridge, { provider: new StubHostProvider() });
    expect(() =>
      registerHostTelemetryTools(bridge, { provider: new StubHostProvider() }),
    ).not.toThrow();
    const fqns = bridge.listTools().map((t) => t.fqn);
    expect(fqns.filter((f) => f === TELEMETRY_QUERY_TOOL)).toHaveLength(1);
  });
});

describe("McpTelemetryProvider — degrade gracefully", () => {
  it("empty capabilities + empty query when the endpoint is unreachable", async () => {
    const throwing: TelemetryMcpClient = {
      async callTool() {
        throw new Error("ECONNREFUSED: telemetry endpoint absent");
      },
    };
    const provider = new McpTelemetryProvider(throwing);

    // Before connect: empty cache, every stream degrades to proposal-only.
    expect(provider.capabilities()).toEqual([]);

    const conn = await provider.connect();
    expect(conn.ok).toBe(false);
    expect(conn.reason).toContain("ECONNREFUSED");
    expect(provider.isConnected()).toBe(false);
    expect(provider.capabilities()).toEqual([]);

    // Query never throws — returns [].
    expect(await provider.query("cron_run", RANGE)).toEqual([]);
  });

  it("empty capabilities when the host returns a malformed payload", async () => {
    const bad: TelemetryMcpClient = {
      async callTool() {
        return { contractVersion: "1.0.0" }; // no `capabilities` array
      },
    };
    const provider = new McpTelemetryProvider(bad);
    const conn = await provider.connect();
    expect(conn.ok).toBe(false);
    expect(provider.capabilities()).toEqual([]);
  });

  it("drops query samples with an invalid timestamp or non-finite value", async () => {
    const wire: TelemetryMcpClient = {
      async callTool() {
        return {
          samples: [
            { ts: RANGE.start.toISOString(), value: 1 }, // valid
            { ts: "not-a-date", value: 2 }, // bad ts → dropped
            { ts: RANGE.end.toISOString(), value: Number.NaN }, // NaN → dropped
            { ts: RANGE.end.toISOString(), value: "x" }, // non-number → dropped
            { ts: RANGE.end.toISOString(), value: 3 }, // valid
          ],
        };
      },
    };
    const provider = new McpTelemetryProvider(wire);
    const out = await provider.query("cron_run", RANGE);
    expect(out.map((s) => s.value)).toEqual([1, 3]);
    expect(out.every((s) => !Number.isNaN(s.ts.getTime()))).toBe(true);
  });
});

describe("telemetry_query audit provenance", () => {
  it("records each served query with stream/window/sample_count and keeps the chain intact", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const audit = new AuditLog(join(tmpDir, "outcome-audit.jsonl"));
    registerHostTelemetryTools(bridge, { provider: new StubHostProvider(), audit });

    const provider = new McpTelemetryProvider(bridgeToolCaller(bridge));
    await provider.connect();
    await provider.query("cron_run", RANGE);
    await provider.query("hook_exec", RANGE); // host owns no hook_exec → 0 samples

    const records = audit.all().filter((r) => r.event === "telemetry_query");
    expect(records).toHaveLength(2);
    expect(records[0]?.detail).toMatchObject({
      stream: "cron_run",
      window_start: RANGE.start.toISOString(),
      window_end: RANGE.end.toISOString(),
      sample_count: 1,
      contract_version: TELEMETRY_CONTRACT_VERSION,
    });
    expect(records[1]?.detail).toMatchObject({ stream: "hook_exec", sample_count: 0 });
    expect(audit.verifyChain().ok).toBe(true);

    // Tamper with an earlier record → chain breaks.
    const tampered = new AuditLog(join(tmpDir, "tamper.jsonl"));
    tampered.append({ event: "telemetry_query", detail: { stream: "cron_run" } });
    tampered.append({ event: "telemetry_query", detail: { stream: "hook_exec" } });
    const arr = tampered.all() as unknown as Array<{ detail?: Record<string, unknown> }>;
    arr[0]!.detail = { stream: "MUTATED" };
    expect(tampered.verifyChain().ok).toBe(false);
  });
});

// NOTE: end-to-end coverage over a real MCP transport (`startMcpServer`) and the
// full `serveTunerOverMcp` wiring (which also serves the mutating `tuner__*`
// gate) lives with the OutcomeLoop PR, not this read-only telemetry PR. The
// in-process bridge tests above exercise the host + client contract.
