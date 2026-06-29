/**
 * OutcomeLoop telemetry contract (Phase 1, observation-only).
 *
 * The OutcomeLoop measures whether an *applied* tuning change improved the
 * system. Fitness signals come from telemetry, NOT from the observation
 * collector (`collectObservations` yields qualitative correction/feedback
 * signals, not numeric metrics — see `~/simon-memory/decisions/tuner-outcome-loop.md`).
 *
 * Decision (host-provided telemetry contract, option A): the ClaudeClaw-Plus
 * HOST exposes ONE standard, versioned telemetry surface that every subject
 * consumes via `provider.query(...)`. Subjects never embed file/DB adapters
 * or hardcoded paths. Rationale: a single surface to certify and audit (one
 * schema, one provenance point) — decisive for a commercial auditable product.
 *
 * Portability: a `Metric.source` is a `TelemetryStream` NAME (Tier 1) or the
 * literal `"artifact"` (Tier 1b, a static scan of the managed file — always
 * available, no capability gate). At registration the loop intersects each
 * subject's declared `fitnessSignals()` sources with `provider.capabilities()`
 * and activates fitness ONLY for streams the host advertises in THIS
 * environment; missing streams degrade to proposal-only, logged as
 * `fitness_inactive(reason)`. Never design fitness for telemetry an
 * environment may not emit.
 */

/**
 * Canonical telemetry streams the host may advertise. Adding a stream here is
 * a contract change (bump `TELEMETRY_CONTRACT_VERSION`). `agent_dispatch` is
 * declared but not yet emitted by any reference host — AgentSubject's fitness
 * stays proposal-only until a producer lands (see producer-wiring follow-ups).
 */
export const TELEMETRY_STREAMS = [
  "session_cost",
  "tool_call",
  "hook_exec",
  "skill_access",
  "cron_run",
  "mode_dispatch",
  "template_feedback",
  "memory_access",
  "agent_dispatch",
  // Phase A observability hub: the universal MCP boundary stream the gateway
  // (mcp-multiplexer) emits for EVERY plugin's tool I/O. Labelled by `plugin`
  // so the hub auto-discovers plugins with zero per-plugin code. `value` is the
  // call's `duration_ms`. Added in contract 1.1.0.
  "mcp.tool_call",
] as const;

export type TelemetryStream = (typeof TELEMETRY_STREAMS)[number];

/**
 * The whole contract surface is versioned per host release for certification.
 * 1.1.0 adds the `mcp.tool_call` stream + the optional view-manifest surface
 * (`viewManifest`/`viewData`) — both additive, older consumers unaffected.
 */
export const TELEMETRY_CONTRACT_VERSION = "1.1.0";

/** Half-open time window [start, end) for a fitness measurement. */
export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * One observation pulled from a stream. `value` is the metric-bearing number;
 * `labels` carry dimensions a subject filters/groups on (model, unit, tool…).
 * Aggregation into a single fitness number is the subject's job and MUST be
 * outlier-robust (median / trimmed mean, never a raw sum — cost is spiky).
 */
export interface MetricSample {
  ts: Date;
  value: number;
  labels?: Record<string, string>;
}

/**
 * The host advertises, per stream, whether it is emitting in this environment
 * and at which schema version. This is the single auditable surface that
 * folds in the role the per-subject `healthCheck()` producer-probe used to
 * play: "is this subject's producer present?" is now answered by intersecting
 * `fitnessSignals()` sources against `capabilities()`.
 */
export interface TelemetryCapability {
  stream: TelemetryStream;
  schemaVersion: string;
  available: boolean;
  /** Optional diagnostic when `available` is false (mirrors healthCheck.reason). */
  reason?: string;
}

/**
 * Implemented by the HOST. Owns telemetry PRODUCTION + schema + provenance.
 * The tuner owns CONSUMPTION + fitness logic only. Versioned: a customer host
 * at vX advertises its streams; the tuner degrades for missing/older ones.
 */
export interface TelemetryProvider {
  /** Contract version this provider implements. */
  contractVersion(): string;
  /** Which streams this environment advertises, with availability + schema. */
  capabilities(): TelemetryCapability[];
  /** Pull samples for a stream over a window, optionally filtered by labels. */
  query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]>;
  /**
   * OPTIONAL (contract 1.1.0). A plugin advertises a view-manifest to declare
   * its own specialized observability page. Providers that don't implement this
   * (or return `undefined`) get the universal boundary page only — the hub
   * never hardcodes a plugin's page.
   */
  viewManifest?(): ViewManifest | undefined;
  /**
   * OPTIONAL (contract 1.1.0). Fill one panel declared by `viewManifest()` over
   * a window. Returns `undefined` when this provider doesn't own `panelId`.
   * READ-ONLY: it must never mutate plugin state.
   */
  viewData?(panelId: string, range: DateRange): Promise<PanelData | undefined>;
}

// ── View-manifest surface (Phase A observability hub) ───────────────────────
//
// A plugin OPTIONALLY advertises a view-manifest: pure data describing the
// domain metrics it wants surfaced and a layout of panel primitives the hub
// renders generically. The hub renders whatever the manifest declares and
// nothing more — it never embeds plugin-specific rendering. A plugin with no
// manifest still gets the universal boundary page (volume / p95 latency /
// error-rate / cost) the reader derives from the `mcp.tool_call` stream.

/** The generic panel renderers the hub provides. A manifest composes these. */
export type PanelKind = "timeline" | "table" | "metric-cards" | "log";

/** A domain metric a plugin wants shown. `direction` is a colouring hint only —
 *  the hub never optimises on it (no Goodhart surface here). */
export interface ManifestMetric {
  name: string;
  /** Display unit, e.g. "ms", "USD", "count", "ratio". */
  unit?: string;
  direction?: "up_good" | "down_good" | "neutral";
  description?: string;
}

/**
 * One panel in a plugin's page. `kind` selects a generic renderer; `columns`
 * orders the fields shown for row-shaped panels (table/timeline/log). The hub
 * passes `id` back to `viewData(id, …)` and never interprets panel internals.
 */
export interface PanelSpec {
  id: string;
  kind: PanelKind;
  title: string;
  /** Field order for row-shaped panels (table/timeline/log). */
  columns?: string[];
}

/** A plugin's declared page: domain metrics + a layout of panels. Pure data. */
export interface ViewManifest {
  /** The plugin this belongs to — matched against discovered `plugin` labels. */
  plugin: string;
  /** Manifest schema version, independent of the telemetry contract version. */
  schemaVersion: string;
  metrics?: ManifestMetric[];
  panels: PanelSpec[];
}

/** Rows that fill one panel. Shape is generic; the hub renders per `PanelSpec.kind`. */
export interface PanelData {
  panelId: string;
  rows: Array<Record<string, unknown>>;
}

/**
 * A surface that aggregates multiple plugins' view-manifests. The hub's reader
 * consumes this to discover specialized pages without knowing any plugin.
 * Implemented by `CompositeTelemetryProvider`.
 */
export interface ViewManifestSource {
  /** Every declared manifest — one per plugin that advertises one. */
  viewManifests(): ViewManifest[];
  /**
   * Fill a panel for a named plugin. `undefined` for an unknown plugin/panel.
   * Distinct from a provider's own `viewData(panelId, range)` — this aggregator
   * dispatches by plugin to the provider that declared the manifest.
   */
  panelData(plugin: string, panelId: string, range: DateRange): Promise<PanelData | undefined>;
}

/** RLVR axis: a fitness signal is either programmatically verifiable or needs a judge. */
export type MetricKind = "verifiable" | "judge" | "proxy_state";
export type MetricDirection = "lower_is_better" | "higher_is_better";

/** Tier 1b: artifact metrics scan the managed file directly — no stream gate. */
export const ARTIFACT_SOURCE = "artifact" as const;
export type MetricSource = TelemetryStream | typeof ARTIFACT_SOURCE;

/**
 * A fitness metric declared by a subject via `fitnessSignals()`.
 * `guardrails` names companion metrics that must NOT regress beyond noise for
 * a verdict of `improved` — the anti-Goodhart no-regression rule. Single-number
 * maximisation is forbidden (it's the gameable shape).
 */
export interface Metric {
  name: string;
  source: MetricSource;
  kind: MetricKind;
  direction: MetricDirection;
  windowDays: number;
  guardrails?: string[];
}

/** True when a metric reads a static artifact and so is always activatable. */
export function isArtifactMetric(m: Metric): boolean {
  return m.source === ARTIFACT_SOURCE;
}

/**
 * A host that advertises NO streams. Artifact (Tier 1b) metrics still
 * activate; every stream-based metric degrades to proposal-only. Useful as a
 * safe default and in tests.
 */
export class NullTelemetryProvider implements TelemetryProvider {
  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }
  capabilities(): TelemetryCapability[] {
    return [];
  }
  async query(): Promise<MetricSample[]> {
    return [];
  }
}
