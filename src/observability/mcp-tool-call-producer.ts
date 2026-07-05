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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { forEachLineSync } from "../tuner/wisecron/line-reader.js";
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

    // Stream the append-only audit log line-by-line with a per-file byte cap
    // rather than slurping the whole file into one string. The log grows
    // unbounded on a long-running daemon, so a `readFileSync` here could OOM
    // before the MCP-layer sample cap can act. Same treatment the session /
    // journal readers already use (see line-reader.ts). Wrapped in try/catch to
    // tolerate a mid-read failure on one bad file.
    const out: MetricSample[] = [];
    try {
      forEachLineSync(
        this.path,
        (line) => {
          const l = line.trim();
          if (!l) return;
          let rec: ToolCallRecord;
          try {
            rec = JSON.parse(l) as ToolCallRecord;
          } catch {
            return; // skip a partial trailing write or a corrupt line
          }
          if (rec.event !== MCP_TOOL_CALL_STREAM) return;
          const detail = rec.detail ?? {};
          const tsStr = typeof detail.event_ts === "string" ? detail.event_ts : rec.ts;
          if (!tsStr) return;
          const ts = new Date(tsStr);
          if (Number.isNaN(ts.getTime())) return;
          if (ts < range.start || ts >= range.end) return;

          const labels: Record<string, string> = {
            plugin: String(rec.subject ?? ""),
            tool: String(detail.tool ?? ""),
            status: String(detail.status ?? ""),
            agent_id: String(detail.agent_id ?? ""),
          };
          if (filters && !Object.entries(filters).every(([k, v]) => labels[k] === v)) return;

          const duration = Number(detail.duration_ms ?? 0);
          out.push({ ts, value: Number.isFinite(duration) ? duration : 0, labels });
        },
        {
          onTruncate: (bytes) =>
            console.warn(
              `[mcp-tool-call] audit log read hit the ${bytes}-byte cap — query result is truncated`,
            ),
        },
      );
    } catch {
      // A read failure mid-scan returns whatever was parsed so far, matching the
      // "tolerate one bad file" contract of the other producers.
    }
    return out;
  }
}
