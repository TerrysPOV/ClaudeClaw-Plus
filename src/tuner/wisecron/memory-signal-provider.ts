/**
 * MemorySignalProducer — exposes the memory degradation signal (load latency /
 * size / dead-entry ratio) on the host telemetry surface as the `memory_signal`
 * stream, so it is queryable via `telemetry__query` alongside the other streams
 * (and visible in the observability UI). Reads the sampler history written by
 * `memory-signal.ts` (a local, tuner-side measurement — no web, no LLM).
 *
 * `value` defaults to load latency (ms); pass `filters.metric = bytes | entries |
 * dead_ratio` to series a different dimension. Labels always carry all dimensions.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type TelemetryProvider,
  type TelemetryCapability,
  type TelemetryStream,
  type MetricSample,
  type DateRange,
  TELEMETRY_CONTRACT_VERSION,
} from "../../skills-tuner/core/telemetry.js";

const STREAM: TelemetryStream = "memory_signal";

interface RawSample {
  ts: string;
  bytes: number;
  entries: number;
  deadRatio: number;
  loadMs: number;
}

export class MemorySignalProducer implements TelemetryProvider {
  private readonly historyPath: string;

  constructor(cfg: { historyPath?: string } = {}) {
    this.historyPath = cfg.historyPath ?? join(homedir(), ".config", "tuner", "memory-signal-history.jsonl");
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private readSamples(): RawSample[] {
    if (!existsSync(this.historyPath)) return [];
    const out: RawSample[] = [];
    for (const line of readFileSync(this.historyPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as RawSample;
        if (typeof s.ts === "string" && typeof s.loadMs === "number") out.push(s);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  capabilities(): TelemetryCapability[] {
    const has = this.readSamples().length > 0;
    if (has) return [{ stream: STREAM, schemaVersion: TELEMETRY_CONTRACT_VERSION, available: true }];
    return [
      {
        stream: STREAM,
        schemaVersion: TELEMETRY_CONTRACT_VERSION,
        available: false,
        reason: existsSync(this.historyPath)
          ? "memory-signal history is empty (sampler has not recorded yet)"
          : `memory-signal history not found at ${this.historyPath}`,
      },
    ];
  }

  async query(stream: TelemetryStream, range: DateRange, filters?: Record<string, string>): Promise<MetricSample[]> {
    if (stream !== STREAM) return [];
    const metric = filters?.metric ?? "loadMs";
    const pick = (s: RawSample): number =>
      metric === "bytes" ? s.bytes : metric === "entries" ? s.entries : metric === "dead_ratio" ? s.deadRatio : s.loadMs;
    const out: MetricSample[] = [];
    for (const s of this.readSamples()) {
      const ts = new Date(s.ts);
      if (Number.isNaN(ts.getTime()) || ts < range.start || ts >= range.end) continue;
      out.push({
        ts,
        value: pick(s),
        labels: {
          metric,
          bytes: String(s.bytes),
          entries: String(s.entries),
          dead_ratio: String(s.deadRatio),
          load_ms: String(s.loadMs),
        },
      });
    }
    return out;
  }
}
