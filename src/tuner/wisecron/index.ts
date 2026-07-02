/**
 * wisecron — TunableSubject scheduler integrated inside the tuner.
 *
 * Public surface for registering the 8 new wisecron-managed subjects and
 * wiring the adaptive scheduler + apply pipeline against the tuner Registry.
 *
 * Not standalone, not MCP. See SPEC at ~/agent/plugin-specs/wisecron/SPEC.md.
 *
 * Phase 1 — fork Nibbler1250, opt-in via wisecron.enabled in config.yaml.
 */

import type { Registry } from "../../skills-tuner/core/registry.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type { TunableSubject } from "../../skills-tuner/core/interfaces.js";
import type { TelemetryProvider, TelemetryStream } from "../../skills-tuner/core/telemetry.js";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import { activateFitness } from "../../skills-tuner/core/fitness.js";
import {
  type AgentSurface,
  type Scope,
  ScopeResolver,
  defaultAgentSurface,
} from "../../skills-tuner/core/scope.js";
import { WisecronStateDB } from "./state-db.js";
import { AdaptiveScheduler } from "./adaptive-scheduler.js";
import { ProposalEngine } from "./proposal-engine.js";
import { ApplyPipeline } from "./apply-pipeline.js";
import type { WisecronSettings } from "./types.js";

import { ModelRoutingSubject } from "../subjects/model-routing-subject.js";
import { MemorySubject } from "../subjects/memory-subject.js";
// #275 staging: this brick ships the OutcomeLoop + ONLY the model-routing subject
// (reversible, measurable) as the single-subject proof. The other 7 wisecron
// subjects (cron, claude_md, hook, mcp_plugin, prompt_template, memory, agent)
// land in their own follow-up bricks once the loop has earned its keep.
import { makeModeDispatchReader } from "./observation-readers.js";

export interface WisecronContext {
  db: WisecronStateDB;
  scheduler: AdaptiveScheduler;
  engine: ProposalEngine;
  pipeline: ApplyPipeline;
  /**
   * Resolves + applies each subject's effective tuning scope. Pass into the
   * OutcomeRecorder so agent-scoped subjects measure only agent-originated
   * telemetry. Built from `settings.scope` + per-subject `scope` overrides.
   */
  scopeResolver: ScopeResolver;
}

/**
 * Register all 8 wisecron-managed subjects against the tuner registry, and
 * return the orchestrator handles for the CLI layer to drive.
 *
 * Honours per-subject `enabled` flags in settings.subjects.
 */
/** Maps each producer-dependent subject to the telemetry stream it consumes. */
const SUBJECT_STREAM: Partial<Record<string, TelemetryStream>> = {
  cron: "cron_run",
  hook: "hook_exec",
  mcp_plugin: "tool_call",
  model_routing: "mode_dispatch",
  prompt_template: "template_feedback",
  memory: "memory_access",
  skills: "skill_access",
  agent: "agent_dispatch",
};

export function registerWisecronSubjects(
  registry: Registry,
  settings: WisecronSettings,
  opts: {
    llm?: LLMClient;
    runHealthChecks?: boolean;
    /** Host telemetry surface. When supplied, the fitness activation gate runs. */
    telemetry?: TelemetryProvider;
    /** Audit sink for the gate's fitness_active/inactive records. */
    audit?: AuditLog;
    /** Agent-surface definition for `agent` scope. Defaults to the `~/agent` layout. */
    agentSurface?: AgentSurface;
  } = {},
): WisecronContext {
  const db = new WisecronStateDB(settings.db_path);
  const scheduler = new AdaptiveScheduler(db, {
    initialHours: settings.initial_interval_hours,
    maxHours: settings.max_interval_hours,
  });
  const engine = new ProposalEngine(registry, db);
  const pipeline = new ApplyPipeline(registry, db);

  const enabled = (name: string) => settings.subjects?.[name]?.enabled !== false;
  const cfg = (name: string): Record<string, unknown> => settings.subjects?.[name]?.config ?? {};

  const registerWithProbeCheck = (subject: TunableSubject): void => {
    registry.registerSubject(subject);
    scheduler.ensureRegistered(subject.name);
    warnIfMissingHealthProbe(subject);
  };

  // Single-subject proof (#275): only model-routing is wired in this brick.
  if (enabled("model_routing"))
    registerWithProbeCheck(
      new ModelRoutingSubject({
        llm: opts.llm,
        ...cfg("model_routing"),
        // Read observations from the dedicated mode_dispatch journal (the
        // subject's default dispatchReader is `() => []` → obs=0).
        dispatchReader: makeModeDispatchReader(
          cfg("model_routing").observation_log as string | undefined,
        ),
      }),
    );

  // memory subject: reactive index hygiene + proactive evidence face.
  if (enabled("memory")) registerWithProbeCheck(new MemorySubject({ ...cfg("memory") }));

  // Resolve the active tuning scope (global + per-subject overrides) and record
  // it in the audit chain at registration — the certifier reads "the tuner
  // operated at scope=X (subject Y at Z)" from one immutable record. Built even
  // when no telemetry is wired, so scope provenance is always attributable.
  const perSubjectScope: Record<string, Scope> = {};
  for (const [name, sc] of Object.entries(settings.subjects ?? {})) {
    if (sc?.scope) perSubjectScope[name] = sc.scope;
  }
  const scopeResolver = new ScopeResolver(
    settings.scope ?? "all",
    perSubjectScope,
    opts.agentSurface ?? defaultAgentSurface(),
  );
  if (opts.audit) {
    const snap = scopeResolver.snapshot(registry.allSubjects().map((s) => s.name));
    opts.audit.append({
      event: "scope_registration",
      detail: { global: snap.global, per_subject: snap.per_subject },
    });
  }

  // Producer-presence reporting. Default ON; tests can opt-out to keep their
  // console.warn assertions tight. Fire-and-forget — never blocks register.
  if (opts.runHealthChecks !== false) {
    void runHealthChecks(registry);
  }

  // OutcomeLoop fitness activation gate. Runs ONLY when the host wires a
  // TelemetryProvider — absent one, every subject runs proposal-only exactly
  // as before (degrade-gracefully). Emits a distinct `fitness:` boot line so
  // it never collides with the `health:` producer log above.
  if (opts.telemetry) {
    const audit = opts.audit ?? new AuditLog();
    const activation = activateFitness(registry.allSubjects(), opts.telemetry, audit);
    for (const a of activation.active) {
      console.log(
        `[tuner] subject '${a.subject}' fitness: active metric='${a.metric.name}' source=${a.metric.source}`,
      );
    }
    for (const i of activation.inactive) {
      console.log(
        `[tuner] subject '${i.subject}' fitness: inactive metric='${i.metric.name}' reason="${i.reason}"`,
      );
    }
  }

  return { db, scheduler, engine, pipeline, scopeResolver };
}

/**
 * Boot-time log of each subject's producer presence. Five subjects (cron,
 * hook, mcp_plugin, model_routing, prompt_template) silently emit zero
 * observations when their telemetry source is absent; this surfaces the
 * gap so operators can spot a misconfigured ProDesk-style deployment
 * (~/.claude/* vs ~/agent/*).
 *
 * High/medium-risk subjects with `producer_found=false` escalate to
 * console.warn. Low-risk subjects are info-level only.
 */
async function runHealthChecks(registry: Registry): Promise<void> {
  for (const subject of registry.allSubjects()) {
    const fn = (
      subject as TunableSubject & {
        healthCheck?: () => Promise<{
          producer_found: boolean;
          sample_event_match_rate: number;
          reason?: string;
        }>;
      }
    ).healthCheck;
    if (typeof fn !== "function") continue;
    let result: { producer_found: boolean; sample_event_match_rate: number; reason?: string };
    try {
      result = await fn.call(subject);
    } catch (e) {
      console.warn(
        `[tuner] subject '${subject.name}' healthCheck threw: ${(e as Error).message.slice(0, 120)}`,
      );
      continue;
    }
    const tail = result.reason ? `, reason="${result.reason}"` : "";
    const line =
      `[tuner] subject '${subject.name}' health: ` +
      `producer_found=${result.producer_found}, ` +
      `match_rate=${result.sample_event_match_rate.toFixed(2)}${tail}`;
    const escalate =
      !result.producer_found && (subject.risk_tier === "high" || subject.risk_tier === "medium");
    if (escalate) console.warn(line);
    else console.log(line);
  }
}

/**
 * Emit a one-time console.warn when a high/medium-risk subject ships without
 * a healthProbe implementation. The ApplyPipeline's default probe is
 * fail-open, so a missing probe silently disables the observation-window
 * auto-revert path; this warning surfaces that so operators can wire one in.
 *
 * Resolution order at apply time: pipeline's injected `healthProbe` option
 * wins over the subject's own `healthProbe()`. The warning fires on the
 * subject side; if the operator wires a pipeline-level probe, the warning
 * is informational only.
 */
function warnIfMissingHealthProbe(subject: TunableSubject): void {
  if (subject.risk_tier !== "high" && subject.risk_tier !== "medium") return;
  if (typeof (subject as TunableSubject & { healthProbe?: unknown }).healthProbe === "function")
    return;
  console.warn(
    `[tuner] subject '${subject.name}' (risk=${subject.risk_tier}) has no healthProbe — ` +
      `auto-revert disabled. Wire a probe via ApplyPipeline opts or apply only with explicit observe=false.`,
  );
}

export { SUBJECT_STREAM };
// Scope control surface (config → resolver → scoped telemetry provider).
export {
  type AgentSurface,
  type Scope,
  ScopeResolver,
  ScopedTelemetryProvider,
  defaultAgentSurface,
  resolveScope,
} from "../../skills-tuner/core/scope.js";
// The reference-host telemetry surface. Pass into
// `registerWisecronSubjects(registry, settings, { telemetry: buildHostTelemetryProvider() })`
// to run the fitness activation gate and let subjects measure real outcomes.
export {
  buildHostTelemetryProvider,
  CompositeTelemetryProvider,
  CronRunTelemetryProducer,
  HookExecTelemetryProducer,
  SkillAccessTelemetryProducer,
  JournalTelemetryProducer,
} from "./host-telemetry-provider.js";
// Telemetry over the MCP bridge: host-side tools + the tuner-side consumer.
export {
  McpTelemetryProvider,
  registerHostTelemetryTools,
  bridgeToolCaller,
  mcpClientToolCaller,
  TELEMETRY_PLUGIN_ID,
  TELEMETRY_CAPABILITIES_TOOL,
  TELEMETRY_QUERY_TOOL,
  type TelemetryMcpClient,
} from "./telemetry-mcp.js";
export { serveTunerOverMcp, type ServedTuner, type ServeTunerOverMcpOpts } from "./serve.js";
export { WisecronStateDB } from "./state-db.js";
export { AdaptiveScheduler } from "./adaptive-scheduler.js";
export { ProposalEngine } from "./proposal-engine.js";
export { ApplyPipeline } from "./apply-pipeline.js";
export type {
  ScheduleState,
  RevisionRecord,
  AppliedBy,
  ProposalSummary,
  ProposalCycleResult,
  ApplyOutcome,
  ObservationWindowResult,
  WisecronSettings,
  RevertibleSubject,
} from "./types.js";
