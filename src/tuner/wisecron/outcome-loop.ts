/**
 * OutcomeLoop recorder — closes the loop for wisecron (Phase 1, observation-only).
 *
 * Three composable steps over the `outcomes` ledger:
 *  5. baseline snapshot at apply  — `snapshotBaseline()`
 *  6. maturation pass             — `runMaturation()`  (post, delta, verdict)
 *  7. defensive revert by tier    — wired into `runMaturation` via `revert` cb
 *
 * The maturation pass and its defensive revert run only when `runMaturation()`
 * is explicitly invoked (the `tuner__mature` gate tool, or the CLI) — there is
 * NO autonomous timer/tick driving it in this phase. So auto-revert is a wired,
 * operator/cycle-triggered capability, not a self-driving one: "observation-only"
 * means nothing reverts unless something calls `runMaturation`.
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
  decideVerdictDetailed,
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
 * `count: undefined`, which the verdict treats as underpowered (conservative:
 * an untracked metric can't force a verdict or a revert).
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
      if (!subject) {
        this.closeUnregistered(proposalId, subjectName, asOf);
        continue;
      }
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
        postByMetric.set(row.metric, post);
      }
      // Persist post/delta before the verdict so a crash mid-pass still leaves
      // the measured posts recorded. Called only once the pass is going to
      // decide (or give up on) a target: a row finalized here leaves the
      // pending set.
      const persistPosts = (): void => {
        for (const row of rows) {
          const post = postByMetric.get(row.metric);
          if (post === undefined) continue;
          this.db.finalizeOutcome({
            proposal_id: proposalId,
            metric: row.metric,
            post,
            delta: post - (row.baseline ?? 0),
            verdict: "neutral",
          });
        }
      };

      // Pick the TARGET metric explicitly (by role/guardrail relationship), not
      // by declaration order — a subject that declares a guardrail first must
      // not have it treated as the target.
      const target = this.selectTarget(declared, postByMetric);
      if (!target) {
        // Only non-target rows matured. While the target's own row is still
        // pending (longer window, or unmeasurable inside its grace period), keep
        // them pending too, so the target is judged WITH its guardrails later.
        const intended = this.selectTarget(declared, new Map(declared.map((m) => [m.name, 0])));
        const targetPending =
          intended !== undefined &&
          this.db
            .getOutcomes(proposalId)
            .some((r) => r.metric === intended.name && r.verdict === null);
        if (targetPending) continue;
        // No target will ever mature for this proposal: record what was
        // measured and say so once, instead of dropping it silently.
        persistPosts();
        if (postByMetric.size > 0) {
          this.audit.append({
            event: "verdict",
            subject: subjectName,
            proposal_id: proposalId,
            detail: { verdict: "neutral", reason: "no_target", metrics: [...postByMetric.keys()] },
          });
        }
        continue;
      }
      persistPosts();
      const guardrailDeltas = guardrailMetricsFor(target, declared)
        .filter((g) => postByMetric.has(g.name))
        .map((g) => this.toDelta(g, rows, postByMetric, counts));
      const decision = decideVerdictDetailed(
        this.toDelta(target, rows, postByMetric, counts),
        guardrailDeltas,
        { minSamples: this.minSamples },
      );
      const verdict = decision.verdict;

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
          reason: decision.reason,
          baseline: targetRow.baseline,
          post: postByMetric.get(target.name),
          guardrails: target.guardrails ?? [],
          regressed_guardrails: decision.regressedGuardrails,
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

  /**
   * Rows whose subject is no longer registered (disabled after the proposal was
   * applied) can't be measured, and the subject that would revert the change is
   * gone. Keep the proposal's rows pending through the same grace period as an
   * un-measurable row — counted from its LAST row's window_end, so a subject
   * re-enabled in time still gets its target judged with its guardrails — then
   * finalize every open row together to a terminal `neutral` with an audit
   * record, so they leave the pending set instead of being re-selected and
   * dropped on every pass.
   */
  private closeUnregistered(proposalId: string, subjectName: string, asOf: Date): void {
    const open = this.db.getOutcomes(proposalId).filter((r) => r.verdict === null);
    const ends = open.map((r) => new Date(r.window_end).getTime());
    if (ends.length === 0 || !ends.every(Number.isFinite)) return;
    const graceMs = this.unmeasurableGraceDays * 86_400_000;
    if (!(asOf.getTime() >= Math.max(...ends) + graceMs)) return;
    for (const row of open) {
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
          reason: "subject_unregistered",
          grace_days: this.unmeasurableGraceDays,
        },
      });
    }
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
   * Only metrics that actually matured (present in `postByMetric`) are eligible.
   * A guardrail is never the target: when only guardrails matured this pass (the
   * target has a longer window, or could not be measured), there is no verdict.
   * Likewise when the declared `isTarget` metric has not matured yet.
   */
  private selectTarget(declared: Metric[], postByMetric: Map<string, number>): Metric | undefined {
    const flaggedDeclared = declared.find((m) => (m as FitnessMetric).isTarget === true);
    if (flaggedDeclared)
      return postByMetric.has(flaggedDeclared.name) ? flaggedDeclared : undefined;
    const matured = declared.filter((m) => postByMetric.has(m.name));
    if (matured.length === 0) return undefined;
    const declaresGuardrails = matured.find((m) => (m.guardrails?.length ?? 0) > 0);
    if (declaresGuardrails) return declaresGuardrails;
    const guardNames = new Set(declared.flatMap((m) => m.guardrails ?? []));
    return matured.find((m) => !guardNames.has(m.name));
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
