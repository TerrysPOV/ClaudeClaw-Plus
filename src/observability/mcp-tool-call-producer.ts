/**
 * Reads the hash-chained `mcp.tool_call` audit log back as queryable telemetry.
 *
 * This closes the loop: the gateway WRITES the audited chain (least privilege —
 * it only emits), and this producer READS it (least privilege — read-only, no
 * lock, no god-mode). Out-of-band: it tolerates a concurrently-appending sink by
 * parsing line-by-line and skipping a malformed trailing partial write.
 *
 * `value` carries the call's `duration_ms`; everything else (plugin, tool,
 * status, agent_id) rides in `labels` so a reader can reconstruct the universal
 * metrics without a second source. Call args are never captured (not even a
 * hash — see tool-call.ts), so there is nothing sensitive to surface here.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type DateRange,
  type MetricSample,
  type TelemetryCapability,
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryProvider,
  type TelemetryStream,
} from "../skills-tuner/core/telemetry.js";
import { MCP_TOOL_CALL_STREAM } from "./tool-call.js";
import { DEFAULT_TOOL_CALL_LOG } from "./tool-call-sink.js";

interface ToolCallRecord {
  event?: string;
  ts?: string;
  subject?: string;
  detail?: Record<string, unknown>;
}

export class McpToolCallTelemetryProducer implements TelemetryProvider {
  private readonly path: string;

  constructor(opts: { logPath?: string } = {}) {
    // Default to the same log ToolCallSink writes, so the producer is available
    // out of the box (matching the sink) instead of permanently returning [] when
    // a caller forgets to pass a path.
    this.path = (opts.logPath ?? DEFAULT_TOOL_CALL_LOG).replace(/^~/, homedir());
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  capabilities(): TelemetryCapability[] {
    const has = this.path !== "" && existsSync(this.path);
    return [
      {
        stream: MCP_TOOL_CALL_STREAM,
        schemaVersion: TELEMETRY_CONTRACT_VERSION,
        available: has,
        ...(has ? {} : { reason: "no mcp.tool_call log on this host" }),
      },
    ];
  }

  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    if (stream !== MCP_TOOL_CALL_STREAM) return [];
    if (this.path === "" || !existsSync(this.path)) return [];

    const text = readFileSync(this.path, "utf8");
    const out: MetricSample[] = [];
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      let rec: ToolCallRecord;
      try {
        rec = JSON.parse(l) as ToolCallRecord;
      } catch {
        continue; // skip a partial trailing write or a corrupt line
      }
      if (rec.event !== MCP_TOOL_CALL_STREAM) continue;
      const detail = rec.detail ?? {};
      const tsStr = typeof detail.event_ts === "string" ? detail.event_ts : rec.ts;
      if (!tsStr) continue;
      const ts = new Date(tsStr);
      if (Number.isNaN(ts.getTime())) continue;
      if (ts < range.start || ts >= range.end) continue;

      const labels: Record<string, string> = {
        plugin: String(rec.subject ?? ""),
        tool: String(detail.tool ?? ""),
        status: String(detail.status ?? ""),
        agent_id: String(detail.agent_id ?? ""),
      };
      if (filters && !Object.entries(filters).every(([k, v]) => labels[k] === v)) continue;

      const duration = Number(detail.duration_ms ?? 0);
      out.push({ ts, value: Number.isFinite(duration) ? duration : 0, labels });
    }
    return out;
  }
}
