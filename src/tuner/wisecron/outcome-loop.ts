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
      const subjectName = rows[0]!.subject;
      const subject = this.registry.getSubject(subjectName);
      if (!subject) continue;
      const declared = subject.fitnessSignals();
      const measured = await this.measureActive(subject, declared, asOf);

      // Compute post + delta for each matured row.
      const postByMetric = new Map<string, number>();
      for (const row of rows) {
        const post = measured[row.metric];
        if (post === undefined) continue;
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

      // The "target" metric = first declared metric that matured; remaining
      // matured metrics that are listed as its guardrails gate the verdict.
      const target = declared.find((m) => postByMetric.has(m.name));
      if (!target) continue;
      const guardrailDeltas = guardrailMetricsFor(target, declared)
        .filter((g) => postByMetric.has(g.name))
        .map((g) => this.toDelta(g, rows, postByMetric));
      const verdict = decideVerdict(this.toDelta(target, rows, postByMetric), guardrailDeltas);

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

  private toDelta(metric: Metric, rows: OutcomeRow[], postByMetric: Map<string, number>) {
    const row = rows.find((r) => r.metric === metric.name)!;
    return {
      metric: metric.name,
      direction: metric.direction,
      baseline: row.baseline ?? 0,
      post: postByMetric.get(metric.name) ?? row.baseline ?? 0,
    };
  }

  /** measureFitness for the subject, restricted to currently-active metrics. */
  private async measureActive(
    subject: TunableSubject,
    metrics: Metric[],
    asOf: Date,
  ): Promise<Record<string, number>> {
    if (metrics.length === 0) return {};
    // Widest declared window covers all metrics; per-metric reads slice it.
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
