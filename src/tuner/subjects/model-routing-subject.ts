import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { RevertibleSubject } from "../wisecron/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { nonzeroRate } from "../../skills-tuner/core/aggregate.js";
import {
  type EvidenceDrivenSubject,
  type ResearchSpec,
  type LocalSignal,
  type StructuredEvidence,
  type EvidenceVerdict,
  type EvidencePatch,
  meetsEvidenceBar,
} from "../wisecron/evidence-driven.js";
import { costSignal } from "./model-routing-signal.js";
import { getModelBenchmarks, type ModelBenchmark } from "./model-routing-benchmarks.js";
import {
  buildRerouteEvidencePatch,
  parseModelAssignments,
  proposeBenchmarkReroute,
  type RerouteGateOptions,
} from "./model-routing-quality.js";

/** Recent median session cost (USD) above which routing is "expensive" regardless of trend. */
const MODEL_ROUTING_MAX_RECENT_USD = 25;

const DEAD_DAYS = 90;
const MISTRIGGER_RATE = 0.3;
const EXPENSIVE_RATIO = 5.0;

interface RoutingStats {
  mode: string;
  keyword: string;
  triggers: number;
  reclassifies: number;
  totalCost: number;
  taskClass: string | null;
  lastTriggerAt: Date | null;
}

/**
 * ModelRoutingSubject — wisecron-managed agentic modes / model-router tuner (MEDIUM).
 */
export interface ModelRoutingSubjectConfig {
  llm?: LLMClient;
  /** Path to the session-cost SQLite store (the proactive signal source). */
  costDbPath?: string;
  /** Modes config path. Default: ~/.claude/agentic.yaml. */
  modesConfigPath?: string;
  /** Injected dispatch-event reader. */
  dispatchReader?: (since: Date) => Array<Record<string, unknown>>;
  /** Injected published-benchmark provider (Artificial Analysis by default). */
  benchmarkProvider?: (models: string[]) => Promise<ModelBenchmark[]>;
  /** Quality/cost gate tuning for the benchmark reroute. */
  rerouteGate?: RerouteGateOptions;
}

export class ModelRoutingSubject
  extends BaseSubject
  implements RevertibleSubject, EvidenceDrivenSubject
{
  readonly name = "model_routing";
  readonly risk_tier = "medium" as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly modesConfigPath: string;
  private readonly dispatchReader: (since: Date) => Array<Record<string, unknown>>;
  private readonly dispatchReaderInjected: boolean;
  private readonly costDbPath: string;
  private readonly benchmarkProvider: (models: string[]) => Promise<ModelBenchmark[]>;
  private readonly rerouteGate: RerouteGateOptions;

  constructor(opts: ModelRoutingSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.modesConfigPath = expandHome(
      opts.modesConfigPath ?? join(homedir(), ".claude", "agentic.yaml"),
    );
    this.dispatchReaderInjected = opts.dispatchReader !== undefined;
    this.dispatchReader = opts.dispatchReader ?? (() => []);
    this.costDbPath = expandHome(opts.costDbPath ?? join(homedir(), "agent", "data", "costs.db"));
    this.benchmarkProvider =
      opts.benchmarkProvider ?? ((models) => getModelBenchmarks({ models, nowMs: Date.now() }));
    this.rerouteGate = opts.rerouteGate ?? {};
  }

  // ── Proactive face: EvidenceDrivenSubject (cost signal + faisceau de preuves) ──

  researchSpec(): ResearchSpec {
    return {
      subject: "model_routing",
      query: "llm routing cost quality model cascade speculative decoding semantic router",
      sourceTiers: ["enterprise", "authoritative", "papers"],
      technique: "cost-aware-routing",
    };
  }

  async localSignal(): Promise<LocalSignal> {
    const c = costSignal(this.costDbPath, MODEL_ROUTING_MAX_RECENT_USD);
    return {
      metric: "session_cost_usd",
      value: c.value,
      unit: "usd",
      degraded: c.degraded,
      trend: c.trend,
      sampledAt: new Date().toISOString(),
    };
  }

  evaluate(evidence: StructuredEvidence, signal: LocalSignal): EvidenceVerdict {
    if (!signal.degraded) {
      return {
        propose: false,
        reason: `routing cost healthy (${signal.value}${signal.unit}, ${signal.trend})`,
        kind: "recommendation",
        confidence: 0,
      };
    }
    if (!meetsEvidenceBar(evidence)) {
      return {
        propose: false,
        reason: `evidence below bar for '${evidence.technique}' (${evidence.independentSources} independent, ${evidence.highTrustSources} high-trust)`,
        kind: "recommendation",
        confidence: 0.2,
      };
    }
    const confidence = Math.round(Math.min(1, evidence.independentSources / 5) * 100) / 100;
    return {
      propose: true,
      reason: `routing cost ${signal.trend} (${signal.value}${signal.unit}) + ${evidence.independentSources} independent sources for '${evidence.technique}'`,
      kind: "recommendation",
      confidence,
    };
  }

  async confirm(before: LocalSignal): Promise<boolean> {
    const after = await this.localSignal();
    return after.value < before.value;
  }

  /**
   * Proactive benchmark reroute (kind:"patch"). When the local cost signal is
   * degraded, read the operator's current model assignments, pull PUBLISHED
   * quality+cost benchmarks (Tier A), and propose the best quality-gated reroute
   * as a CONFIG patch the subject applies in its own modes file — quality is the
   * veto (never a reroute that regresses quality). null when nothing is degraded,
   * no benchmark data is available (no key/offline), or no safe reroute exists.
   * A survivor is confirmed on the own-workload bench (#80) before apply.
   */
  async proposeEvidencePatch(
    _evidence: StructuredEvidence,
    signal: LocalSignal,
  ): Promise<EvidencePatch | null> {
    if (!signal.degraded) return null;
    let content = "";
    try {
      content = readFileSync(this.modesConfigPath, "utf8");
    } catch {
      return null;
    }
    const assignments = parseModelAssignments(content);
    if (assignments.length === 0) return null;
    const benchmarks = await this.benchmarkProvider(assignments.map((a) => a.model));
    if (benchmarks.length === 0) return null;
    const proposals = proposeBenchmarkReroute(assignments, benchmarks, this.rerouteGate);
    return buildRerouteEvidencePatch(content, proposals, this.modesConfigPath);
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const events = this.dispatchReader(since);
    if (events.length === 0) return [];

    const stats = new Map<string, RoutingStats>();
    for (const ev of events) {
      if (ev.type !== "mode_dispatched") continue;
      const mode = String(ev.mode ?? "unknown");
      const keyword = String(ev.keyword ?? "");
      const key = `${mode}::${keyword}`;
      let s = stats.get(key);
      if (!s) {
        s = {
          mode,
          keyword,
          triggers: 0,
          reclassifies: 0,
          totalCost: 0,
          taskClass: null,
          lastTriggerAt: null,
        };
        stats.set(key, s);
      }
      s.triggers += 1;
      if (ev.reclassified === true) s.reclassifies += 1;
      if (typeof ev.cost_usd === "number") s.totalCost += ev.cost_usd;
      if (typeof ev.task_class === "string") s.taskClass = ev.task_class;
      const ts = ev.ts;
      if (typeof ts === "string" || typeof ts === "number") {
        const tsDate = new Date(ts);
        if (!s.lastTriggerAt || tsDate > s.lastTriggerAt) s.lastTriggerAt = tsDate;
      }
    }

    const now = new Date();

    // Compute per-task-class minimum avg cost (for "expensive" comparison).
    const minCostByClass = new Map<string, number>();
    for (const s of stats.values()) {
      if (!s.taskClass || s.triggers === 0) continue;
      const avg = s.totalCost / s.triggers;
      const prev = minCostByClass.get(s.taskClass);
      if (prev === undefined || avg < prev) minCostByClass.set(s.taskClass, avg);
    }

    const observations: Observation[] = [];
    for (const s of stats.values()) {
      const reclassifyRate = s.triggers === 0 ? 0 : s.reclassifies / s.triggers;
      const avgCost = s.triggers === 0 ? 0 : s.totalCost / s.triggers;
      const ageDays = s.lastTriggerAt
        ? (now.getTime() - s.lastTriggerAt.getTime()) / 86_400_000
        : Infinity;
      const expensiveBaseline = s.taskClass ? (minCostByClass.get(s.taskClass) ?? 0) : 0;
      const expensive = expensiveBaseline > 0 && avgCost > expensiveBaseline * EXPENSIVE_RATIO;

      observations.push({
        session_id: `routing-${s.mode}-${s.keyword}-${now.getTime()}`,
        observed_at: now,
        signal_type:
          reclassifyRate > MISTRIGGER_RATE
            ? "correction"
            : s.triggers === 0
              ? "orphan"
              : "repeated_trigger",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            mode: s.mode,
            keyword: s.keyword,
            triggers: s.triggers,
            reclassify_rate: Math.round(reclassifyRate * 100) / 100,
            avg_cost_usd: Math.round(avgCost * 1e4) / 1e4,
            task_class: s.taskClass,
            age_days: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
            expensive,
          }),
          500,
        ),
        metadata: {
          subject: "model_routing",
          mode: s.mode,
          keyword: s.keyword,
          triggers: s.triggers,
          reclassify_rate: reclassifyRate,
          avg_cost_usd: avgCost,
          task_class: s.taskClass,
          age_days: Number.isFinite(ageDays) ? ageDays : null,
          expensive,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const dead: Observation[] = [];
    const mistrigger: Observation[] = [];
    const expensive: Observation[] = [];

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const triggers = (meta.triggers as number) ?? 0;
      const ageDays = meta.age_days as number | null;
      const reclassifyRate = (meta.reclassify_rate as number) ?? 0;
      const isExpensive = (meta.expensive as boolean) ?? false;

      if (triggers === 0 || (ageDays !== null && ageDays > DEAD_DAYS)) dead.push(obs);
      if (reclassifyRate > MISTRIGGER_RATE) mistrigger.push(obs);
      if (isExpensive) expensive.push(obs);
    }

    const clusters: Cluster[] = [];
    if (dead.length > 0) clusters.push(mk("routing-dead-keyword", dead, 0.0, "neutral"));
    if (mistrigger.length > 0) clusters.push(mk("routing-mistrigger", mistrigger, 0.3, "negative"));
    if (expensive.length > 0) clusters.push(mk("routing-expensive", expensive, 0.5, "neutral"));
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error("model-routing-subject.proposeChange: cluster empty");
    const meta = firstObs.metadata as Record<string, unknown>;
    const mode = meta.mode as string;
    const keyword = meta.keyword as string;

    let current = "";
    if (existsSync(this.modesConfigPath)) {
      try {
        current = readFileSync(this.modesConfigPath, "utf8");
      } catch {
        current = "";
      }
    }
    const withoutKeyword = removeKeywordFromYaml(current, mode, keyword);
    const renamedKeyword = renameKeywordInYaml(current, mode, keyword, `${keyword}-specific`);
    const swappedModel = swapModelInYaml(current, mode);

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "model_routing",
      kind: "patch",
      target_path: this.modesConfigPath,
      alternatives: [
        {
          id: "remove-keyword",
          label: `Remove keyword '${keyword}' from mode '${mode}'`,
          diff_or_content: withoutKeyword,
          tradeoff: "Stops mis-trigger; may miss legitimate hits.",
        },
        {
          id: "narrow-keyword",
          label: `Narrow keyword to '${keyword}-specific'`,
          diff_or_content: renamedKeyword,
          tradeoff: "Keeps mode but reduces collisions.",
        },
        {
          id: "swap-model",
          label: `Swap mode '${mode}' to cheaper model tier`,
          diff_or_content: swappedModel,
          tradeoff: "Lower cost; may regress quality.",
        },
      ],
      pattern_signature: `model_routing:${cluster.id}:${mode}:${keyword}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt)
      throw new Error(`model-routing-subject.apply: alternative ${alternativeId} not found`);
    // Confinement: the only file this subject may write is its managed modes
    // config — never engine code or anything outside it.
    this.assertManagedTarget(proposal.target_path);

    // Never overwrite an existing .bak. On a double-apply (e.g. an operator
    // re-applies after a crash between apply and the gate's status flip) the
    // target already holds applied content — re-copying would destroy the
    // pristine original backup and make a later revert restore applied-not-
    // original. Keep the first .bak as the true pre-apply snapshot.
    const bak = `${proposal.target_path}.bak`;
    if (existsSync(proposal.target_path) && !existsSync(bak)) {
      copyFileSync(proposal.target_path, bak);
    }
    writeFileSync(proposal.target_path, alt.diff_or_content, "utf8");
    return {
      target_path: proposal.target_path,
      kind: "patch",
      applied_content: alt.diff_or_content,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    let parsed: unknown;
    try {
      const yaml = await import("js-yaml");
      parsed = yaml.load(patch.applied_content);
    } catch (e) {
      return { valid: false, reason: `not valid YAML: ${(e as Error).message}` };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { valid: false, reason: "YAML must be a mapping" };
    }
    const root = parsed as Record<string, unknown>;
    const modes = (root.modes ?? root) as Record<string, unknown>;
    if (typeof modes !== "object" || modes === null) {
      return { valid: false, reason: "modes section missing or not a mapping" };
    }

    const seenKeywords = new Set<string>();
    for (const [name, def] of Object.entries(modes)) {
      if (typeof def !== "object" || def === null) continue;
      const kws = (def as Record<string, unknown>).keywords;
      if (kws === undefined) continue;
      if (!Array.isArray(kws) || !kws.every((k) => typeof k === "string")) {
        return { valid: false, reason: `mode '${name}'.keywords must be string[]` };
      }
      for (const kw of kws as string[]) {
        if (seenKeywords.has(kw)) {
          return { valid: false, reason: `duplicate keyword '${kw}' across modes` };
        }
        seenKeywords.add(kw);
      }
    }
    return { valid: true };
  }

  /**
   * Artifact health probe: re-reads the modes config and re-runs validate() —
   * the config must still parse as YAML and carry no duplicate keyword across
   * modes (the exact collision that causes mis-routing). Reports a parse error
   * or a duplicate-keyword regression. Deterministic; a file gone from disk is
   * not a break.
   *
   * NOTE: this subject is MEDIUM risk, and the ApplyPipeline only arms the
   * post-apply observation-window auto-revert for HIGH/critical tiers. So this
   * probe is NOT invoked automatically after apply — it is an explicit/operator
   * check (and shares its logic with the validate() gate and the
   * duplicate-keyword fitness signal). It is deliberately not wired to
   * auto-revert; do not read the presence of this method as "medium auto-reverts".
   */
  async healthProbe(target: string): Promise<{ failed: boolean; errors: string[] }> {
    if (!existsSync(target)) return { failed: false, errors: [] };
    let content: string;
    try {
      content = readFileSync(target, "utf8");
    } catch (e) {
      return { failed: true, errors: [`unreadable config: ${(e as Error).message.slice(0, 120)}`] };
    }
    const validation = await this.validate({
      target_path: target,
      kind: "patch",
      applied_content: content,
    });
    return validation.valid
      ? { failed: false, errors: [] }
      : { failed: true, errors: [validation.reason ?? "validation failed"] };
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertManagedTarget(inversePatch.target_path);
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, "utf8");
  }

  /**
   * The subject's declared managed surface — the ONLY path it may write. The
   * wisecron gate reads this to reject an externally-injected proposal whose
   * target_path falls outside it, so a self-signed research proposal cannot be
   * driven to an arbitrary file write even if a subject forgot its own guard.
   * Returned real-path-resolved (parent dir dereferenced) for a stable compare.
   */
  managedTargets(): string[] {
    return [realResolvePath(this.modesConfigPath)];
  }

  /**
   * The only writable file: the managed modes config. Anything else -> throw.
   *
   * Hardened against symlink redirection: `resolve()` normalises `../` but does
   * NOT dereference symlinks, and writeFileSync/copyFileSync FOLLOW links — so a
   * managed path that is (or sits behind) a symlink pointing at engine code
   * would pass a naive compare yet write THROUGH the link. We (a) refuse a
   * target that is itself a symlink (O_NOFOLLOW semantics) and (b) compare
   * REAL paths (parent dir dereferenced via realpath) so a symlinked parent
   * cannot smuggle the write outside the managed config.
   */
  /** The only writable file: the managed modes config. Anything else → throw. */
  private assertManagedTarget(target: string): void {
    if (isSymlinkPath(target)) {
      throw new Error(`target_path is a symlink — refusing to write through it: ${target}`);
    }
    if (realResolvePath(target) !== realResolvePath(this.modesConfigPath)) {
      throw new Error(`target_path is not the managed modes config: ${target}`);
    }
  }

  async healthCheck(): Promise<{
    producer_found: boolean;
    sample_event_match_rate: number;
    reason?: string;
  }> {
    if (!this.dispatchReaderInjected) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason:
          "dispatchReader not configured — default returns []; no dispatch telemetry available",
      };
    }
    const since = new Date(Date.now() - 7 * 86_400_000);
    let events: Array<Record<string, unknown>>;
    try {
      events = this.dispatchReader(since);
    } catch (e) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `dispatchReader failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
    if (events.length === 0) {
      return {
        producer_found: true,
        sample_event_match_rate: 0,
        reason: "dispatchReader returned 0 events in last 7d",
      };
    }
    const dispatched = events.filter((e) => e.type === "dispatch" || e.mode !== undefined).length;
    return {
      producer_found: true,
      sample_event_match_rate: dispatched / events.length,
    };
  }

  /**
   * OutcomeLoop fitness for the model_routing subject (MEDIUM risk).
   *
   * Target — `routing_reclassify_rate` (Tier 1, `mode_dispatch`): fraction of
   * mode dispatches the orchestrator later reclassified (a mis-route). Lower is
   * better. The gameable shortcut is to delete modes so nothing dispatches, so
   * it is guarded by `routing_active_mode_count` (Tier 1b artifact,
   * higher_is_better). `routing_duplicate_keyword_count` (Tier 1b artifact):
   * always-on scan for keywords claimed by more than one mode — the exact
   * collision `validate()` rejects, and a direct cause of mis-routing.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "routing_reclassify_rate",
        source: "mode_dispatch",
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
        guardrails: ["routing_active_mode_count"],
      },
      {
        name: "routing_duplicate_keyword_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
      },
      {
        name: "routing_active_mode_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Telemetry read ONLY via `provider.query("mode_dispatch", …)`; reclassify
   * rate is a rate, not a sum. The artifact metrics parse the managed modes
   * config and are omitted when that file is absent (degrade gracefully).
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: mode_dispatch stream (value 1 = reclassified) ───────────────
    const samples = await provider.query("mode_dispatch", range);
    if (samples.length > 0) {
      out.routing_reclassify_rate = nonzeroRate(samples.map((s) => s.value));
    }

    // ── Tier 1b: artifact scan of the modes config ──────────────────────────
    const scan = await this.scanModes();
    if (scan !== null) {
      out.routing_active_mode_count = scan.modes;
      out.routing_duplicate_keyword_count = scan.duplicateKeywords;
    }

    return out;
  }

  /**
   * Parse the managed modes YAML; count modes + keywords claimed by >1 mode.
   * Returns null when the config is absent or unparseable (metric doesn't
   * measure rather than reporting a misleading 0).
   */
  private async scanModes(): Promise<{ modes: number; duplicateKeywords: number } | null> {
    if (!existsSync(this.modesConfigPath)) return null;
    let parsed: unknown;
    try {
      const yaml = await import("js-yaml");
      parsed = yaml.load(readFileSync(this.modesConfigPath, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const root = parsed as Record<string, unknown>;
    const modes = (root.modes ?? root) as Record<string, unknown>;
    if (typeof modes !== "object" || modes === null) return null;

    const keywordCounts = new Map<string, number>();
    let modeCount = 0;
    for (const def of Object.values(modes)) {
      if (typeof def !== "object" || def === null) continue;
      modeCount += 1;
      const kws = (def as Record<string, unknown>).keywords;
      if (!Array.isArray(kws)) continue;
      for (const kw of kws) {
        if (typeof kw !== "string") continue;
        keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1);
      }
    }
    let duplicateKeywords = 0;
    for (const n of keywordCounts.values()) if (n > 1) duplicateKeywords += 1;
    return { modes: modeCount, duplicateKeywords };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a path to its REAL location: dereference the (existing) parent
 * directory via realpath, then re-attach the basename. This normalises `../`
 * AND collapses symlinked parent dirs, without dereferencing a final-component
 * symlink (that is refused separately). Falls back to a plain resolve() when
 * the parent does not exist yet (a not-yet-created target).
 */
function realResolvePath(p: string): string {
  const abs = resolve(expandHome(p));
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** True when `p` exists and is a symbolic link (write would follow it). */
function isSymlinkPath(p: string): boolean {
  try {
    return lstatSync(resolve(expandHome(p))).isSymbolicLink();
  } catch {
    return false;
  }
}

function mk(
  id: string,
  obs: Observation[],
  successRate: number,
  sentiment: "negative" | "neutral" | "positive",
): Cluster {
  return {
    id,
    subject: "model_routing",
    observations: obs,
    frequency: obs.length,
    success_rate: successRate,
    sentiment,
    subjects_touched: obs.map(
      (o) =>
        `${(o.metadata as Record<string, unknown>).mode}::${(o.metadata as Record<string, unknown>).keyword}`,
    ),
  };
}

// Conservative line-based YAML editors: preserve comments + ordering by
// operating on raw text rather than round-tripping through a parser.

function removeKeywordFromYaml(content: string, mode: string, keyword: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inMode = false;
  let modeIndent = "";
  for (const line of lines) {
    const modeHeader = line.match(new RegExp(`^(\\s*)${escapeRe(mode)}:\\s*$`));
    if (modeHeader) {
      inMode = true;
      modeIndent = modeHeader[1] ?? "";
      out.push(line);
      continue;
    }
    // Exit the target mode's block on the first non-blank line indented no deeper
    // than the header (a sibling mode or a dedent) — NOT only at column 0, which
    // let edits bleed into sibling modes in an indented `modes:` block (#306).
    if (inMode && line.trim().length > 0 && !line.startsWith(`${modeIndent} `)) inMode = false;
    if (inMode && new RegExp(`^\\s*-\\s+["']?${escapeRe(keyword)}["']?\\s*$`).test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

function renameKeywordInYaml(
  content: string,
  mode: string,
  keyword: string,
  replacement: string,
): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inMode = false;
  let modeIndent = "";
  for (const line of lines) {
    const modeHeader = line.match(new RegExp(`^(\\s*)${escapeRe(mode)}:\\s*$`));
    if (modeHeader) {
      inMode = true;
      modeIndent = modeHeader[1] ?? "";
      out.push(line);
      continue;
    }
    // Exit the target mode's block on the first non-blank line indented no deeper
    // than the header (a sibling mode or a dedent) — NOT only at column 0, which
    // let edits bleed into sibling modes in an indented `modes:` block (#306).
    if (inMode && line.trim().length > 0 && !line.startsWith(`${modeIndent} `)) inMode = false;
    if (inMode) {
      const m = line.match(new RegExp(`^(\\s*-\\s+)["']?${escapeRe(keyword)}["']?\\s*$`));
      if (m) {
        out.push(`${m[1]}${replacement}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function swapModelInYaml(content: string, mode: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inMode = false;
  let modeIndent = "";
  for (const line of lines) {
    const modeHeader = line.match(new RegExp(`^(\\s*)${escapeRe(mode)}:\\s*$`));
    if (modeHeader) {
      inMode = true;
      modeIndent = modeHeader[1] ?? "";
      out.push(line);
      continue;
    }
    // Exit the target mode's block on the first non-blank line indented no deeper
    // than the header (a sibling mode or a dedent) — NOT only at column 0, which
    // let edits bleed into sibling modes in an indented `modes:` block (#306).
    if (inMode && line.trim().length > 0 && !line.startsWith(`${modeIndent} `)) inMode = false;
    if (inMode && /^\s*model:\s*/.test(line)) {
      out.push(line.replace(/sonnet/g, "haiku").replace(/opus/g, "sonnet"));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
