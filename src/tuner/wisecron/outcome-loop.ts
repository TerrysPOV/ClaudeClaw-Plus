/**
 * OutcomeLoop recorder — closes the loop for wisecron (Phase 1, observation-only).
 *
 * Three composable steps over the `outcomes` ledger:
 *  5. baseline snapshot at apply  — `snapshotBaseline()`
 *  6. maturation pass             — `runMaturation()`  (post, delta, verdict)
 *  7. defensive revert by tier    — wired into `runMaturation` via `revert` cb
 *
 * Verifiable metrics only (Tier 1 streams the host advertises + Tier 1b
 * artifact). No judge, no generative change to proposal generation. Every
 * step writes an audit record.
 */

import type { Registry } from "../../skills-tuner/core/registry.js";
import type { Proposal } from "../../skills-tuner/core/types.js";
import type { RiskTier, TunableSubject } from "../../skills-tuner/core/interfaces.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { isMetricActive } from "../../skills-tuner/core/fitness.js";
import {
  decideVerdict,
  guardrailMetricsFor,
  type MetricDelta,
  type Verdict,
} from "../../skills-tuner/core/verdict.js";
import type { AuditLog } from "../../skills-tuner/core/audit-log.js";
import type { ScopeResolver } from "../../skills-tuner/core/scope.js";
import type { WisecronStateDB, OutcomeRow } from "./state-db.js";

function windowEndingAt(end: Date, windowDays: number): DateRange {
  const days = windowDays > 0 ? windowDays : 1;
  return { start: new Date(end.getTime() - days * 86_400_000), end };
}

/** Outcome of a single proposal's maturation, for callers/tests. */
export interface MaturationResult {
  proposal_id: string;
  subject: string;
  target_metric: string;
  verdict: Verdict;
  reverted: boolean;
}

/**
 * A fitness metric that may carry the explicit `isTarget` role marker. The core
 * `Metric` type lives in the telemetry contract (telemetry.ts); we extend it
 * STRUCTURALLY here so a subject can mark the metric a change is meant to
 * improve without a contract change. Subjects that don't set it fall back to the
 * guardrail-declaration relationship (see `selectTarget`).
 */
export type FitnessMetric = Metric & { isTarget?: boolean };

/**
 * A subject that can OPTIONALLY report the sample count behind each fitness
 * value (so the maturation pass can gate on minimum-N and not decide on a single
 * session). Detected structurally — subjects that don't implement it degrade to
 * `count: undefined` (no gate), preserving Phase-1 behaviour.
 */
type CountingSubject = TunableSubject & {
  measureFitnessCounts?: (
    range: DateRange,
    provider: TelemetryProvider,
  ) => Promise<Record<string, number>>;
};

export class OutcomeRecorder {
  constructor(
    private readonly registry: Registry,
    private readonly db: WisecronStateDB,
    private readonly provider: TelemetryProvider,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
    /**
     * Optional scope control. When supplied, each subject's `measureFitness`
     * reads a provider scoped to that subject's effective scope, so an
     * agent-scoped subject only ever measures agent-originated telemetry. When
     * omitted, every subject measures unscoped (`all`) — backward-compatible.
     */
    private readonly scopeResolver?: ScopeResolver,
    /**
     * Minimum sample count required before a verdict may be `improved`/
     * `regressed` (threaded into `decideVerdict`). Only bites when the subject
     * reports counts via `measureFitnessCounts`; otherwise counts are unknown
     * and the guard is a no-op. Default 2 — one session can't decide.
     */
    private readonly minSamples: number = 2,
    /**
     * Grace period (days) past a row's `window_end` after which an
     * un-measurable row (post can't be read — telemetry gap) is finalized to a
     * terminal `neutral` verdict, so it exits the pending set instead of being
     * re-selected and re-measured on every maturation pass forever. Default 7.
     */
    private readonly unmeasurableGraceDays: number = 7,
  ) {}

  /**
   * Step 5. At apply: snapshot baseline = measureFitness(pre-window) for each
   * ACTIVE fitness metric of the proposal's subject. Window per metric =
   * [now - windowDays, now]. Stores one ledger row per (proposal, metric).
   */
  async snapshotBaseline(proposal: Proposal, commitSha?: string): Promise<void> {
    const subject = this.registry.getSubject(proposal.subject);
    if (!subject) return;
    const metrics = subject.fitnessSignals();
    if (metrics.length === 0) return;

    const now = this.now();
    // measure once over the widest window, then read per-metric values.
    const measured = await this.measureActive(subject, metrics, now);

    for (const metric of metrics) {
      const activation = isMetricActive(metric, this.provider);
      if (!activation.active) continue;
      const value = measured[metric.name];
      if (value === undefined) continue; // subject declared but didn't measure it
      const window = windowEndingAt(now, metric.windowDays);
      // The post-window matures windowDays AFTER apply.
      const matureAt = new Date(
        now.getTime() + (metric.windowDays > 0 ? metric.windowDays : 1) * 86_400_000,
      );
      this.db.snapshotBaseline({
        proposal_id: String(proposal.id),
        metric: metric.name,
        commit_sha: commitSha,
        subject: subject.name,
        baseline: value,
        window_start: window.start,
        window_end: matureAt,
      });
      this.audit.append({
        event: "baseline_snapshot",
        subject: subject.name,
        metric: metric.name,
        proposal_id: String(proposal.id),
        ...(commitSha ? { commit_sha: commitSha } : {}),
        detail: { baseline: value, source: metric.source, matures_at: matureAt.toISOString() },
      });
    }
  }

  /**
   * Step 6 + 7. For every ledger row whose window has matured (verdict NULL,
   * window_end <= asOf): recompute post, compute delta, decide the verdict
   * under the no-regression rule, finalize the row, audit it. On `regressed`,
   * route a revert by risk tier (step 7) using the supplied `revert` callback.
   *
   * `revert(proposalId, tier)` returns true if an automatic revert was
   * performed (low risk within policy), false if it was enqueued for human
   * approval (medium/high/critical — engine already blocks their auto-merge).
   */
  async runMaturation(
    opts: { asOf?: Date; revert?: (proposalId: string, tier: RiskTier) => Promise<boolean> } = {},
  ): Promise<MaturationResult[]> {
    const asOf = opts.asOf ?? this.now();
    const pending = this.db.listMaturableOutcomes(asOf);

    // Group rows by proposal so target + guardrail metrics are judged together.
    const byProposal = new Map<string, OutcomeRow[]>();
    for (const row of pending) {
      const arr = byProposal.get(row.proposal_id) ?? [];
      arr.push(row);
      byProposal.set(row.proposal_id, arr);
    }

    const results: MaturationResult[] = [];
    for (const [proposalId, rows] of byProposal) {
      const subjectName = rows[0]?.subject;
      const subject = this.registry.getSubject(subjectName);
      if (!subject) continue;
      const declared = subject.fitnessSignals();
      const measured = await this.measureActive(subject, declared, asOf);
      const counts = await this.measureCounts(subject, declared, asOf);

      // Compute post + delta for each matured row.
      const postByMetric = new Map<string, number>();
      for (const row of rows) {
        const post = measured[row.metric];
        if (post === undefined) {
          // Un-measurable this pass (telemetry gap). After a grace period past
          // window_end, finalize to a terminal `neutral` so the row leaves the
          // pending set — otherwise listMaturableOutcomes returns it (and
          // re-invokes measureFitness) on EVERY future pass forever.
          const windowEndMs = new Date(row.window_end).getTime();
          const graceMs = this.unmeasurableGraceDays * 86_400_000;
          if (Number.isFinite(windowEndMs) && asOf.getTime() >= windowEndMs + graceMs) {
            this.db.finalizeOutcome({
              proposal_id: proposalId,
              metric: row.metric,
              post: row.baseline ?? 0,
              delta: 0,
              verdict: "neutral",
            });
            this.audit.append({
              event: "verdict",
              subject: subjectName,
              metric: row.metric,
              proposal_id: proposalId,
              ...(row.commit_sha ? { commit_sha: row.commit_sha } : {}),
              detail: {
                verdict: "neutral",
                reason: "unmeasurable_after_grace",
                grace_days: this.unmeasurableGraceDays,
              },
            });
          }
          continue;
        }
        const delta = post - (row.baseline ?? 0);
        postByMetric.set(row.metric, post);
        // delta finalized below alongside verdict, but persist post/delta now
        // so a crash mid-pass still leaves the measured post recorded.
        this.db.finalizeOutcome({
          proposal_id: proposalId,
          metric: row.metric,
          post,
          delta,
          verdict: "neutral",
        });
      }

      // Pick the TARGET metric explicitly (by role/guardrail relationship), not
      // by declaration order — a subject that declares a guardrail first must
      // not have it treated as the target.
      const target = this.selectTarget(declared, postByMetric);
      if (!target) continue;
      const guardrailDeltas = guardrailMetricsFor(target, declared)
        .filter((g) => postByMetric.has(g.name))
        .map((g) => this.toDelta(g, rows, postByMetric, counts));
      const verdict = decideVerdict(
        this.toDelta(target, rows, postByMetric, counts),
        guardrailDeltas,
        { minSamples: this.minSamples },
      );

      // Persist final verdict on the target row.
      const targetRow = rows.find((r) => r.metric === target.name)!;
      this.db.finalizeOutcome({
        proposal_id: proposalId,
        metric: target.name,
        post: postByMetric.get(target.name)!,
        delta: postByMetric.get(target.name)! - (targetRow.baseline ?? 0),
        verdict,
      });

      let reverted = false;
      if (verdict === "regressed" && opts.revert) {
        reverted = await opts.revert(proposalId, subject.risk_tier);
      }
      this.audit.append({
        event: "verdict",
        subject: subjectName,
        metric: target.name,
        proposal_id: proposalId,
        ...(targetRow.commit_sha ? { commit_sha: targetRow.commit_sha } : {}),
        detail: {
          verdict,
          baseline: targetRow.baseline,
          post: postByMetric.get(target.name),
          guardrails: target.guardrails ?? [],
          risk_tier: subject.risk_tier,
        },
      });
      if (verdict === "regressed" && opts.revert) {
        this.audit.append({
          event: "revert",
          subject: subjectName,
          proposal_id: proposalId,
          actor: reverted ? "system" : "system:enqueued-for-human",
          detail: { auto: reverted, risk_tier: subject.risk_tier },
        });
      }

      results.push({
        proposal_id: proposalId,
        subject: subjectName,
        target_metric: target.name,
        verdict,
        reverted,
      });
    }
    return results;
  }

  private toDelta(
    metric: Metric,
    rows: OutcomeRow[],
    postByMetric: Map<string, number>,
    counts: Record<string, number>,
  ): MetricDelta {
    const row = rows.find((r) => r.metric === metric.name)!;
    return {
      metric: metric.name,
      direction: metric.direction,
      baseline: row.baseline ?? 0,
      post: postByMetric.get(metric.name) ?? row.baseline ?? 0,
      count: counts[metric.name],
    };
  }

  /**
   * Pick the metric a verdict is decided on. Explicit, NOT declaration order:
   *  1. a metric flagged `isTarget` (the fitness declaration's explicit target)
   *  2. else a metric that declares guardrails (the target-with-companions shape)
   *  3. else a matured metric that is nobody's guardrail (a bare target)
   *  4. else the first matured metric (last-resort fallback)
   * Only metrics that actually matured (present in `postByMetric`) are eligible.
   */
  private selectTarget(declared: Metric[], postByMetric: Map<string, number>): Metric | undefined {
    const matured = declared.filter((m) => postByMetric.has(m.name));
    if (matured.length === 0) return undefined;
    const flagged = matured.find((m) => (m as FitnessMetric).isTarget === true);
    if (flagged) return flagged;
    const declaresGuardrails = matured.find((m) => (m.guardrails?.length ?? 0) > 0);
    if (declaresGuardrails) return declaresGuardrails;
    const guardNames = new Set(declared.flatMap((m) => m.guardrails ?? []));
    const nonGuard = matured.find((m) => !guardNames.has(m.name));
    if (nonGuard) return nonGuard;
    return matured[0];
  }

  /**
   * Optional per-metric sample counts for the minimum-N guard. Uses the
   * subject's `measureFitnessCounts` when present (structural, no interface
   * change); absent → `{}` so counts are unknown and the guard is a no-op.
   */
  private async measureCounts(
    subject: TunableSubject,
    metrics: Metric[],
    asOf: Date,
  ): Promise<Record<string, number>> {
    const s = subject as CountingSubject;
    if (metrics.length === 0 || typeof s.measureFitnessCounts !== "function") return {};
    const widest = metrics.reduce((mx, m) => Math.max(mx, m.windowDays > 0 ? m.windowDays : 1), 1);
    const range = windowEndingAt(asOf, widest);
    const provider = this.scopeResolver
      ? this.scopeResolver.scopedProvider(subject.name, this.provider)
      : this.provider;
    try {
      return await s.measureFitnessCounts(range, provider);
    } catch {
      return {};
    }
  }

  /** measureFitness for the subject, restricted to currently-active metrics. */
  private async measureActive(
    subject: TunableSubject,
    metrics: Metric[],
    asOf: Date,
  ): Promise<Record<string, number>> {
    if (metrics.length === 0) return {};
    // TODO(ultra): per-metric windowing. This measures ONCE over the widest
    // declared window and reads every metric's value from that single range, so
    // a short-window metric (e.g. a 1d artifact scan) is diluted by the widest
    // metric's window (e.g. 7d) and a long-window metric may be measured before
    // it has matured. Correct fix = measure each metric over its OWN windowDays.
    // Deferred for design review: measureFitness returns ALL metrics per call,
    // so per-metric windowing means N calls with cherry-picked values and a
    // baseline-side change too; not shipped half-done. Fixes 1–5 materially
    // reduce the harm in the meantime.
    const widest = metrics.reduce((mx, m) => Math.max(mx, m.windowDays > 0 ? m.windowDays : 1), 1);
    const range = windowEndingAt(asOf, widest);
    const provider = this.scopeResolver
      ? this.scopeResolver.scopedProvider(subject.name, this.provider)
      : this.provider;
    try {
      return await subject.measureFitness(range, provider);
    } catch {
      return {};
    }
  }
}
