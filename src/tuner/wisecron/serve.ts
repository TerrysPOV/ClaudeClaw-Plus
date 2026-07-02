/**
 * Serve the tuner with telemetry flowing THROUGH the MCP bridge.
 *
 * This is the wiring the design mandates: the host produces telemetry and
 * exposes it on the MCP surface (`registerHostTelemetryTools`); the tuner
 * consumes it via an `McpTelemetryProvider` that calls those tools — never
 * reading journalctl/files in-process. The activation gate + every subject's
 * `measureFitness` therefore reach the host only through MCP, and the bridge's
 * invoke-audit plus the OutcomeLoop `telemetry_query` chain together trace each
 * measurement.
 *
 * On top of the telemetry surface, this also exposes the proposal GATE over the
 * same bridge (`registerWisecronGateTools` — the `tuner__*` tools). That closes
 * the convergence: the canonical wisecron engine is reachable end-to-end over
 * MCP — measurement IN (`telemetry__*`) and lifecycle OUT (`tuner__*`) — so the
 * `wisecron <sub>` CLI commands have an MCP-native equivalent any consumer can
 * drive. The gate's apply path is armed with an OutcomeRecorder bound to the
 * SAME MCP telemetry provider, so a baseline snapshot taken at apply measures
 * through MCP exactly like the rest of the loop.
 *
 * In-process (`bridgeToolCaller`) the MCP boundary is a function call across the
 * bridge — same auditing, same decoupling. Over a real transport, swap in
 * `mcpClientToolCaller(client)`; the tuner code is identical either way.
 */

import type { Registry } from "../../skills-tuner/core/registry.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import type { TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { getMcpBridge } from "../../plugins/mcp-bridge.js";
import type { PluginMcpBridge } from "../../plugins/mcp-bridge.js";
import { buildHostTelemetryProvider, type HostTelemetryConfig } from "./host-telemetry-provider.js";
import {
  bridgeToolCaller,
  McpTelemetryProvider,
  registerHostTelemetryTools,
  type TelemetryMcpClient,
} from "./telemetry-mcp.js";
import { registerWisecronSubjects, type WisecronContext } from "./index.js";
import { OutcomeRecorder } from "./outcome-loop.js";
import { ApplyPipeline } from "./apply-pipeline.js";
import { registerWisecronGateTools } from "./gate-mcp.js";
import type { AppliedBy } from "./types.js";
import type { WisecronSettings } from "./types.js";

export interface ServeTunerOverMcpOpts {
  /** Host-side producer. Defaults to the reference-host composite. */
  hostProvider?: TelemetryProvider;
  /** Config forwarded to the default reference-host producer. */
  hostConfig?: HostTelemetryConfig;
  /** Bridge to host the telemetry tools on. Defaults to the process singleton. */
  bridge?: PluginMcpBridge;
  /**
   * Consumer transport to the telemetry tools. Defaults to an in-process
   * caller over the same bridge. Pass `mcpClientToolCaller(client)` to consume
   * over a real MCP transport.
   */
  client?: TelemetryMcpClient;
  /** Shared OutcomeLoop audit chain (host query records + activation gate). */
  audit?: AuditLog;
  llm?: LLMClient;
  runHealthChecks?: boolean;
  /**
   * Register the `tuner__*` proposal-gate tools on the bridge (default true).
   * Set false to serve telemetry only (the pre-convergence surface).
   */
  registerGate?: boolean;
  /** Actor stamped on gate apply/audit records (default "mcp"). */
  gateSource?: AppliedBy;
}

export interface ServedTuner extends WisecronContext {
  /** The host-side producer registered on the bridge. */
  hostProvider: TelemetryProvider;
  /** The MCP-backed provider the subjects consume. */
  mcpProvider: McpTelemetryProvider;
  /** The audit chain telemetry queries + activations are written to. */
  audit: AuditLog;
  /** FQNs of the proposal-gate tools registered (empty when registerGate=false). */
  gateTools: string[];
}

/**
 * Register the host telemetry surface on the bridge, connect an
 * `McpTelemetryProvider` to it, register the wisecron subjects consuming that
 * provider, and (by default) expose the proposal gate over the same bridge.
 * Returns the orchestration handles plus the wired providers.
 */
export async function serveTunerOverMcp(
  registry: Registry,
  settings: WisecronSettings,
  opts: ServeTunerOverMcpOpts = {},
): Promise<ServedTuner> {
  const bridge = opts.bridge ?? getMcpBridge();
  const audit = opts.audit ?? new AuditLog();
  const hostProvider = opts.hostProvider ?? buildHostTelemetryProvider(opts.hostConfig ?? {});

  // HOST: expose telemetry on the MCP surface, recording served queries.
  registerHostTelemetryTools(bridge, { provider: hostProvider, audit });

  // TUNER: consume telemetry only through MCP.
  const client = opts.client ?? bridgeToolCaller(bridge);
  const mcpProvider = new McpTelemetryProvider(client);
  await mcpProvider.connect();

  const ctx = registerWisecronSubjects(registry, settings, {
    llm: opts.llm,
    runHealthChecks: opts.runHealthChecks,
    telemetry: mcpProvider,
    audit,
  });

  // GATE: expose the proposal lifecycle over the same bridge. Arm a recorder
  // bound to the MCP telemetry provider (ctx.pipeline carries none), so apply's
  // baseline snapshot measures through MCP like the rest of the loop.
  let gateTools: string[] = [];
  if (opts.registerGate !== false) {
    const recorder = new OutcomeRecorder(
      registry,
      ctx.db,
      mcpProvider,
      audit,
      undefined,
      ctx.scopeResolver,
    );
    const gatePipeline = new ApplyPipeline(registry, ctx.db, { outcomeRecorder: recorder });
    gateTools = registerWisecronGateTools(
      bridge,
      {
        settings,
        registry,
        db: ctx.db,
        engine: ctx.engine,
        scheduler: ctx.scheduler,
        scopeResolver: ctx.scopeResolver,
        pipeline: gatePipeline,
        recorder,
        audit,
      },
      { source: opts.gateSource },
    ).tools;
  }

  return { ...ctx, hostProvider, mcpProvider, audit, gateTools };
}
