/**
 * Telemetry over the MCP bridge — the single auditable telemetry surface.
 *
 * Host-provided telemetry contract (option A) — the host exposes ONE
 * telemetry surface over the MCP bridge"), the HOST produces telemetry and
 * serves it as two MCP tools; the TUNER consumes it THROUGH those tools and
 * never reads journalctl/files in-process. This module has the two halves:
 *
 *   HOST side  — `registerHostTelemetryTools(bridge, { provider, audit })`
 *     registers `telemetry__capabilities` + `telemetry__query` on the
 *     PluginMcpBridge, backed by an in-process `TelemetryProvider` (the
 *     reference-host producer `buildHostTelemetryProvider()`). Every served
 *     query appends a `telemetry_query` record to the tamper-evident AuditLog,
 *     so the provenance of each measured number is in the chain (on top of the
 *     bridge's own invoke audit).
 *
 *   TUNER side — `McpTelemetryProvider` implements `TelemetryProvider` by
 *     calling those two tools through a `TelemetryMcpClient`. It talks MCP only.
 *     Backed in-process by `bridgeToolCaller(bridge)`, or over a real MCP
 *     transport by `mcpClientToolCaller(client)`. Degrades gracefully: an
 *     unreachable endpoint yields empty capabilities (every stream → proposal-
 *     only) and empty query results, never a throw.
 */

import { z } from "zod";
import type { PluginMcpBridge } from "../../plugins/mcp-bridge.js";
import type { AuditLog } from "../../skills-tuner/core/audit-log.js";
import {
  type DateRange,
  type MetricSample,
  type TelemetryCapability,
  type TelemetryProvider,
  type TelemetryStream,
  TELEMETRY_CONTRACT_VERSION,
  TELEMETRY_STREAMS,
} from "../../skills-tuner/core/telemetry.js";

// ── Wire contract ────────────────────────────────────────────────────────────

/** Bridge pluginId for the host telemetry surface (FQN prefix `telemetry__`). */
export const TELEMETRY_PLUGIN_ID = "telemetry";
export const TELEMETRY_CAPABILITIES_TOOL = `${TELEMETRY_PLUGIN_ID}__capabilities`;
export const TELEMETRY_QUERY_TOOL = `${TELEMETRY_PLUGIN_ID}__query`;

/** Wire shape of a sample: `ts` is ISO-8601 over the boundary, Date in memory. */
interface WireSample {
  ts: string;
  value: number;
  labels?: Record<string, string>;
}

interface CapabilitiesResult {
  contractVersion: string;
  capabilities: TelemetryCapability[];
}

interface QueryResult {
  stream: TelemetryStream;
  contractVersion: string;
  samples: WireSample[];
  /** True when the range was clamped and/or the sample array was capped (below).
   *  Absent means the full requested window is represented. */
  truncated?: boolean;
}

const QueryArgsSchema = z.object({
  stream: z.enum(TELEMETRY_STREAMS),
  start: z.string(),
  end: z.string(),
  filters: z.record(z.string(), z.string()).optional(),
});

const DAY_MS = 86_400_000;
/**
 * Resource guards for the socket-exposed `telemetry__query`. Both are CLAMP,
 * not reject, so a slightly-too-wide query still returns useful bounded data
 * (flagged `truncated`) instead of erroring.
 *  - MAX window: an unbounded [2020,2030) range would pull all history into one
 *    in-memory MCP response. Cap it; keep the most recent window.
 *  - MAX samples: cap the returned array regardless of window so a dense stream
 *    can't blow the response size either.
 */
export const MAX_QUERY_WINDOW_DAYS = 90;
export const MAX_QUERY_SAMPLES = 5_000;

// ── HOST side ──────────────────────────────────────────────────────────────--

export interface RegisterHostTelemetryOpts {
  /** The in-process producer that actually reads the host's sources. */
  provider: TelemetryProvider;
  /** Tamper-evident chain. When supplied, every served query is recorded. */
  audit?: AuditLog;
}

/**
 * Register the host telemetry surface on the MCP bridge. Idempotent per bridge
 * for the same pluginId — re-registration first unregisters the prior tools.
 * Returns the FQNs registered.
 */
export function registerHostTelemetryTools(
  bridge: PluginMcpBridge,
  opts: RegisterHostTelemetryOpts,
): { capabilitiesTool: string; queryTool: string } {
  const { provider, audit } = opts;

  // Re-register cleanly so a served process can rebuild the surface.
  bridge.unregisterPlugin(TELEMETRY_PLUGIN_ID);

  bridge.registerPluginTool(TELEMETRY_PLUGIN_ID, {
    name: "capabilities",
    description:
      "Telemetry contract: which streams the host advertises in this environment, " +
      "with availability + schema version. No args.",
    schema: z.object({}),
    handler: (): CapabilitiesResult => ({
      contractVersion: provider.contractVersion(),
      capabilities: provider.capabilities(),
    }),
  });

  bridge.registerPluginTool(TELEMETRY_PLUGIN_ID, {
    name: "query",
    description:
      "Pull telemetry samples for one stream over a half-open [start,end) window, " +
      "optionally filtered by labels. start/end are ISO-8601 timestamps.",
    schema: QueryArgsSchema,
    handler: async (args: z.infer<typeof QueryArgsSchema>): Promise<QueryResult> => {
      const start = new Date(args.start);
      const end = new Date(args.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error(`invalid range: start=${args.start} end=${args.end}`);
      }
      // Guard the window: clamp anything wider than MAX_QUERY_WINDOW_DAYS to the
      // most-recent slice so a runaway [2020,2030) can't pull all history into
      // one in-memory response.
      let truncated = false;
      let effectiveStart = start;
      if (end.getTime() - start.getTime() > MAX_QUERY_WINDOW_DAYS * DAY_MS) {
        effectiveStart = new Date(end.getTime() - MAX_QUERY_WINDOW_DAYS * DAY_MS);
        truncated = true;
      }
      const range: DateRange = { start: effectiveStart, end };
      let samples = await provider.query(args.stream, range, args.filters);
      // Guard the response size: cap the array regardless of window.
      if (samples.length > MAX_QUERY_SAMPLES) {
        samples = samples.slice(0, MAX_QUERY_SAMPLES);
        truncated = true;
      }
      // Provenance into the tamper-evident chain: which stream, which (clamped)
      // window, how many samples answered the measurement, whether it was
      // truncated, at which schema version.
      audit?.append({
        event: "telemetry_query",
        detail: {
          stream: args.stream,
          window_start: range.start.toISOString(),
          window_end: range.end.toISOString(),
          ...(args.filters ? { filters: args.filters } : {}),
          sample_count: samples.length,
          ...(truncated ? { truncated: true } : {}),
          contract_version: provider.contractVersion(),
        },
      });
      return {
        stream: args.stream,
        contractVersion: provider.contractVersion(),
        samples: samples.map((s) => ({
          ts: s.ts.toISOString(),
          value: s.value,
          ...(s.labels ? { labels: s.labels } : {}),
        })),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  });

  return { capabilitiesTool: TELEMETRY_CAPABILITIES_TOOL, queryTool: TELEMETRY_QUERY_TOOL };
}

// ── TUNER side ─────────────────────────────────────────────────────────────--

/**
 * The transport the tuner uses to reach the host telemetry tools. `callTool`
 * resolves to the tool handler's RETURN VALUE (already a JS object) — adapters
 * normalise away any transport envelope. Throws are caught by the provider and
 * degrade to empty.
 */
export interface TelemetryMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** In-process caller: invoke through the bridge (HMAC-signed + invoke-audited). */
export function bridgeToolCaller(bridge: PluginMcpBridge): TelemetryMcpClient {
  return {
    callTool: (name, args) => bridge.invokeTool(name, args),
  };
}

/** Minimal shape of the MCP SDK Client `callTool` we depend on. */
interface McpSdkClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Caller over a real MCP transport. Unwraps the standard
 * `{ content: [{ type: "text", text }], isError? }` envelope that
 * `mcp-server.ts` emits and re-parses the JSON the host serialised.
 */
export function mcpClientToolCaller(client: McpSdkClientLike): TelemetryMcpClient {
  return {
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const text = res?.content?.find((c) => c.type === "text")?.text;
      if (res?.isError) {
        throw new Error(text ?? `MCP tool ${name} returned isError`);
      }
      if (text === undefined) {
        throw new Error(`MCP tool ${name} returned no text content`);
      }
      return JSON.parse(text);
    },
  };
}

/**
 * `TelemetryProvider` that reads the host telemetry surface over the MCP
 * bridge. `capabilities()` is synchronous (the activation gate calls it sync),
 * so capabilities are fetched once via `connect()` and cached; before connect,
 * or if the endpoint is unreachable, the cache is empty and every stream-based
 * metric degrades to proposal-only — exactly the absent-host behaviour.
 */
export class McpTelemetryProvider implements TelemetryProvider {
  private cachedCapabilities: TelemetryCapability[] = [];
  private cachedContractVersion = TELEMETRY_CONTRACT_VERSION;
  private connected = false;

  constructor(private readonly client: TelemetryMcpClient) {}

  /**
   * Fetch + cache capabilities from the host over MCP. Call once at wire time
   * before the activation gate runs. Never throws — a failure leaves the cache
   * empty (degrade to proposal-only) and is reported in the return value.
   */
  async connect(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = (await this.client.callTool(TELEMETRY_CAPABILITIES_TOOL, {})) as
        | CapabilitiesResult
        | undefined;
      if (!res || !Array.isArray(res.capabilities)) {
        return { ok: false, reason: "telemetry capabilities endpoint returned no capabilities" };
      }
      this.cachedCapabilities = res.capabilities;
      if (typeof res.contractVersion === "string") {
        this.cachedContractVersion = res.contractVersion;
      }
      this.connected = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** True once `connect()` has populated the capability cache. */
  isConnected(): boolean {
    return this.connected;
  }

  contractVersion(): string {
    return this.cachedContractVersion;
  }

  capabilities(): TelemetryCapability[] {
    return this.cachedCapabilities;
  }

  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    try {
      const res = (await this.client.callTool(TELEMETRY_QUERY_TOOL, {
        stream,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        ...(filters ? { filters } : {}),
      })) as QueryResult | undefined;
      if (!res || !Array.isArray(res.samples)) return [];
      // The wire payload is untrusted (a remote host / transport-unwrap). Drop
      // samples with a malformed timestamp (→ Invalid Date) or a non-finite value
      // (NaN/Infinity) rather than propagating them into fitness math.
      const out: MetricSample[] = [];
      for (const s of res.samples) {
        const ts = new Date(s.ts);
        if (Number.isNaN(ts.getTime())) continue;
        if (typeof s.value !== "number" || !Number.isFinite(s.value)) continue;
        out.push({ ts, value: s.value, ...(s.labels ? { labels: s.labels } : {}) });
      }
      return out;
    } catch {
      return [];
    }
  }
}
