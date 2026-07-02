/**
 * Wisecron bootstrap — wires the *complete* outcome loop for the 8 wisecron
 * subjects, separate from the legacy Engine bootstrap (`bootstrap.ts`).
 *
 * The legacy `bootstrapEngine` registers only SkillsSubject + WiseCronSubject
 * against the old `Engine` and has no outcome loop. THIS bootstrap registers
 * the wisecron subject set and closes the loop:
 *
 *   proposal (ProposalEngine.runCycle)
 *     → persist (WisecronStateDB.proposals)
 *     → apply (ApplyPipeline, recorder-armed)
 *     → baseline snapshot (OutcomeRecorder.snapshotBaseline, at apply)
 *     → maturation + verdict + defensive revert (OutcomeRecorder.runMaturation)
 *
 * The one gap the wisecron stack shipped with: `new OutcomeRecorder` was never
 * instantiated at runtime, and `registerWisecronSubjects` builds its internal
 * pipeline WITHOUT a recorder. So here we build a SECOND pipeline that carries
 * the recorder, and that is the one the CLI drives.
 *
 * Reads the top-level `wisecron:` block of `~/.config/tuner/config.yaml`
 * directly (the legacy `loadConfig` strips unknown top-level keys, so the block
 * is inert for the legacy path and parsed only here).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { Registry } from "../core/registry.js";
import { AuditLog } from "../core/audit-log.js";
import { AUDIT_PATH } from "../core/security.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../core/config.js";
import { makeLLMClient, type LLMClient } from "../core/llm.js";
import { ExternalProcessSubject } from "../subjects/external_process.js";
import { activateFitness } from "../core/fitness.js";
import type { Metric } from "../core/telemetry.js";
import type { ExternalSubjectSettings } from "../../tuner/wisecron/types.js";
import {
  registerWisecronSubjects,
  buildHostTelemetryProvider,
} from "../../tuner/wisecron/index.js";
import { ApplyPipeline } from "../../tuner/wisecron/apply-pipeline.js";
import { OutcomeRecorder } from "../../tuner/wisecron/outcome-loop.js";
import type { ProposalEngine } from "../../tuner/wisecron/proposal-engine.js";
import type { AdaptiveScheduler } from "../../tuner/wisecron/adaptive-scheduler.js";
import type { WisecronStateDB } from "../../tuner/wisecron/state-db.js";
import type { ScopeResolver } from "../core/scope.js";
import { WisecronSettingsSchema, type WisecronSettings } from "../../tuner/wisecron/types.js";
import type { TelemetryProvider } from "../core/telemetry.js";

export interface WisecronBundle {
  settings: WisecronSettings;
  registry: Registry;
  db: WisecronStateDB;
  engine: ProposalEngine;
  scheduler: AdaptiveScheduler;
  scopeResolver: ScopeResolver;
  /** The recorder-armed pipeline — drive apply() through THIS one. */
  pipeline: ApplyPipeline;
  recorder: OutcomeRecorder;
  audit: AuditLog;
}

/**
 * Parse the `wisecron:` block from the YAML config. Returns defaults
 * (enabled:false) when the file or block is absent. Throws on a malformed
 * block so a typo surfaces instead of silently disabling the loop.
 */
export function loadWisecronSettings(configPath = DEFAULT_CONFIG_PATH): WisecronSettings {
  if (!existsSync(configPath)) return WisecronSettingsSchema.parse({});
  const raw = (yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
  const block = raw.wisecron;
  return WisecronSettingsSchema.parse(block ?? {});
}

export interface BootstrapWisecronOpts {
  /** Pre-parsed settings (tests). When omitted, read from `configPath`. */
  settings?: WisecronSettings;
  configPath?: string;
  /** Telemetry surface. Defaults to the reference-host composite (direct, no MCP). */
  telemetry?: TelemetryProvider;
  /** Audit chain. Defaults to the file-backed tuner audit log. */
  audit?: AuditLog;
  /** LLM client. Defaults to best-effort `makeLLMClient`; undefined when no key. */
  llm?: LLMClient;
  /** Forwarded to registerWisecronSubjects — tests pass false to quiet console. */
  runHealthChecks?: boolean;
}

/**
 * Build the recorder-armed wisecron stack. Idempotent and side-effect-light:
 * opens the wisecron DB, registers enabled subjects, runs the activation gate
 * (when telemetry is wired), and returns the orchestration handles.
 */
export function bootstrapWisecron(opts: BootstrapWisecronOpts = {}): WisecronBundle {
  const settings = opts.settings ?? loadWisecronSettings(opts.configPath);
  const audit = opts.audit ?? new AuditLog(AUDIT_PATH);
  const provider = opts.telemetry ?? buildHostTelemetryProvider({});

  // Best-effort LLM: subjects that propose via the SDK need it, but cron-run
  // for artifact-only subjects (e.g. claude_md) and the whole apply/mature path
  // do not. Absent a key, we register without an LLM rather than hard-failing.
  let llm = opts.llm;
  if (!llm) {
    try {
      llm = makeLLMClient(loadConfig(opts.configPath));
    } catch {
      llm = undefined;
    }
  }

  const registry = new Registry();
  const ctx = registerWisecronSubjects(registry, settings, {
    telemetry: provider,
    audit,
    llm,
    runHealthChecks: opts.runHealthChecks,
  });

  // Config-driven external (subprocess-backed) subjects. Generic: the code
  // hardcodes none — operators declare them under `wisecron.external_subjects`.
  // Registered into the SAME registry the recorder/engine/cron-run consult, so
  // they participate in the full loop with no special-casing downstream.
  registerExternalSubjects(registry, ctx.scheduler, settings.external_subjects, provider, audit);

  const recorder = new OutcomeRecorder(
    registry,
    ctx.db,
    provider,
    audit,
    undefined,
    ctx.scopeResolver,
  );
  // A pipeline that carries the recorder — its apply() fires snapshotBaseline.
  // (ctx.pipeline has no recorder; we deliberately replace it.)
  const pipeline = new ApplyPipeline(registry, ctx.db, { outcomeRecorder: recorder });

  return {
    settings,
    registry,
    db: ctx.db,
    engine: ctx.engine,
    scheduler: ctx.scheduler,
    scopeResolver: ctx.scopeResolver,
    pipeline,
    recorder,
    audit,
  };
}

/** Expand a leading `~` to the home directory. Leaves other paths untouched. */
function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

/**
 * Instantiate + register one ExternalProcessSubject per enabled
 * `external_subjects` entry. Side-effects: registry.registerSubject,
 * scheduler.ensureRegistered, and a fitness-activation pass (so the artifact /
 * stream metrics they declare are logged + audited like the built-in subjects).
 *
 * Generic by construction — nothing here names a specific external program.
 */
function registerExternalSubjects(
  registry: Registry,
  scheduler: AdaptiveScheduler,
  entries: ExternalSubjectSettings[],
  provider: TelemetryProvider,
  audit: AuditLog,
): void {
  const registered: ExternalProcessSubject[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue;
    const subject = new ExternalProcessSubject({
      name: e.name,
      command: e.command.map(expandHome),
      cwd: e.cwd ? expandHome(e.cwd) : undefined,
      env: e.env,
      allowedRoots: e.allowedRoots?.map(expandHome),
      riskTier: e.riskTier,
      autoMergeDefault: e.autoMergeDefault,
      supportsCreation: e.supportsCreation,
      orphanMinObservations: e.orphanMinObservations,
      timeoutMs: e.timeoutMs,
      config: e.config,
      fitnessSignals: e.fitnessSignals as Metric[] | undefined,
    });
    registry.registerSubject(subject);
    scheduler.ensureRegistered(subject.name);
    registered.push(subject);
  }
  if (registered.length === 0) return;

  // Fitness activation for the external subjects (the gate ran inside
  // registerWisecronSubjects before these existed). Artifact-source metrics
  // always activate; stream metrics degrade per host capabilities — same rules.
  const activation = activateFitness(registered, provider, audit);
  for (const a of activation.active) {
    console.log(
      `[tuner] external subject '${a.subject}' fitness: active metric='${a.metric.name}' source=${a.metric.source}`,
    );
  }
  for (const i of activation.inactive) {
    console.log(
      `[tuner] external subject '${i.subject}' fitness: inactive metric='${i.metric.name}' reason="${i.reason}"`,
    );
  }
}
