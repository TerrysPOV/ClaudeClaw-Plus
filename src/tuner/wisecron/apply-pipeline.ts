import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Registry } from "../../skills-tuner/core/registry.js";
import type { Patch, Proposal } from "../../skills-tuner/core/types.js";
import type { RiskTier, TunableSubject } from "../../skills-tuner/core/interfaces.js";
import { auditLog, loadSecret, verifyProposalSignature } from "../../skills-tuner/core/security.js";
import type { WisecronStateDB } from "./state-db.js";
import type {
  AppliedBy,
  ApplyOutcome,
  ObservationWindowResult,
  RevertibleSubject,
} from "./types.js";
import { HIGH_RISK_OBSERVATION_WINDOW_MS } from "./types.js";

const HIGH_RISK_TIERS: ReadonlySet<RiskTier> = new Set(["high", "critical"]);

type AuditFn = (event: string, payload: Record<string, unknown>) => void;
type VerifyFn = (proposal: Proposal) => boolean;
type HealthProbeFn = (
  subjectName: string,
  target: string,
) => Promise<{ failed: boolean; errors: string[] }>;
type ReadTargetFn = (path: string) => string | null;
type WriteTargetFn = (path: string, content: string) => void;
/**
 * OutcomeLoop hook (structural, to avoid coupling). When injected, the
 * baseline fitness snapshot is taken right after a successful apply. Optional
 * and default-off — absent it, the pipeline behaves exactly as before.
 */
type OutcomeRecorderHook = {
  snapshotBaseline(proposal: Proposal, commitSha?: string): Promise<void>;
};

/**
 * ApplyPipeline — single-action approval → apply with rollback history.
 *
 * Phase 1 contract (from SPEC):
 *   - Diff preview shown by ProposalEngine before this is called.
 *   - User confirms with one CLI command or one Telegram button.
 *   - Apply runs subject.apply() → produces forward Patch.
 *   - Subject is also responsible for computing inverse Patch (snapshot of
 *     pre-apply state). We persist both in rollback_history.
 *   - High-risk subjects (cron, hook): arm a 5-minute observation window.
 *     If errors detected in that window (systemd unit failed, hook crashed,
 *     exit code ≠ 0), auto-revert via subject.revert(inverse_patch).
 *   - Low/medium subjects: apply is final, revert only on explicit user action.
 */

/**
 * Commit a just-applied change to git when its target lives in a repo. Stages and
 * commits ONLY `targetPath` on the current branch (so the operator's other
 * uncommitted work is untouched), giving a `[tuner]` commit trail + `git revert`
 * recovery on top of the inverse_patch. Best-effort: returns the commit sha, or
 * null when the target is not in a repo / nothing changed / git is unavailable.
 */
function commitAppliedTarget(targetPath: string, message: string): string | null {
  const dir = dirname(targetPath);
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 20_000 });
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) return null;
    git(["add", "--", targetPath]);
    // Nothing staged for this path → nothing to commit (idempotent re-apply).
    if (git(["diff", "--cached", "--quiet", "--", targetPath]).status === 0) return null;
    const c = git(["commit", "--no-verify", "-m", message, "--", targetPath]);
    if (c.status !== 0) return null;
    const sha = git(["rev-parse", "HEAD"]);
    return sha.status === 0 ? sha.stdout.trim() : null;
  } catch {
    return null;
  }
}

export class ApplyPipeline {
  private readonly registry: Registry;
  private readonly db: WisecronStateDB;
  private readonly observationWindowMs: number;
  private readonly now: () => Date;
  private readonly audit: AuditFn;
  private readonly verify: VerifyFn;
  private readonly healthProbe: HealthProbeFn;
  private readonly readTarget: ReadTargetFn;
  private readonly writeTarget: WriteTargetFn;
  private readonly waitForWindow: boolean;
  private readonly outcomeRecorder?: OutcomeRecorderHook;
  // Per-target serialization queue. Each entry holds the current tail of
  // the lock chain plus the count of in-flight + queued waiters; the entry
  // is removed once the last waiter drains so the map cannot grow unbounded
  // across distinct target paths over a long-running process.
  private readonly locks = new Map<string, { tail: Promise<unknown>; waiters: number }>();

  constructor(
    registry: Registry,
    db: WisecronStateDB,
    opts: {
      observationWindowMs?: number;
      now?: () => Date;
      audit?: AuditFn;
      verify?: VerifyFn;
      healthProbe?: HealthProbeFn;
      readTarget?: ReadTargetFn;
      writeTarget?: WriteTargetFn;
      /** When false (default), high-risk apply schedules a deferred window
       *  via setTimeout and returns immediately. When true, await the
       *  observation-window result before returning ApplyOutcome. */
      waitForObservationWindow?: boolean;
      /** OutcomeLoop: when supplied, snapshot baseline fitness after apply. */
      outcomeRecorder?: OutcomeRecorderHook;
    } = {},
  ) {
    this.registry = registry;
    this.db = db;
    this.observationWindowMs = opts.observationWindowMs ?? HIGH_RISK_OBSERVATION_WINDOW_MS;
    this.now = opts.now ?? (() => new Date());
    this.audit = opts.audit ?? auditLog;
    if (opts.verify) {
      this.verify = opts.verify;
    } else {
      let cachedSecret: Buffer | null = null;
      this.verify = (proposal: Proposal): boolean => {
        if (!cachedSecret) cachedSecret = loadSecret();
        return verifyProposalSignature(proposal, cachedSecret);
      };
    }
    // An injected probe (operator override) wins. Absent one, dispatch to the
    // subject's own `healthProbe(target)` so the observation-window auto-revert
    // is actually ACTIVE for any subject that implements it — falling back to
    // the fail-open default only for subjects with no probe.
    this.healthProbe = opts.healthProbe ?? this.subjectHealthProbe.bind(this);
    this.readTarget = opts.readTarget ?? defaultReadTarget;
    this.writeTarget = opts.writeTarget ?? defaultWriteTarget;
    this.waitForWindow = opts.waitForObservationWindow ?? false;
    this.outcomeRecorder = opts.outcomeRecorder;
  }

  /**
   * Apply a signed proposal. Records forward + inverse patch, emits audit
   * event `wisecron_proposal_applied`. For high-risk subjects, arms an
   * observation window that may auto-revert.
   */
  async apply(
    proposal: Proposal,
    alternativeId: string,
    appliedBy: AppliedBy,
  ): Promise<ApplyOutcome> {
    const { revision_id, armed, subjectName, targetPath } = await this.withTargetLock(
      proposal.target_path,
      async () => {
        const subject = this.registry.getSubject(proposal.subject);
        if (!subject) {
          throw new Error(`ApplyPipeline: subject '${proposal.subject}' not registered`);
        }

        if (!this.verify(proposal)) {
          this.audit("wisecron_signature_mismatch", {
            proposal_id: proposal.id,
            subject: proposal.subject,
          });
          throw new Error("ApplyPipeline: proposal signature verification failed");
        }

        // Snapshot pre-apply state → inverse_patch BEFORE subject.apply mutates.
        const inverse_patch = await this.snapshotInverse(proposal, alternativeId);

        const forward_patch = await subject.apply(proposal, alternativeId);

        // Git-commit the applied target (when it lives in a repo) for a clean,
        // revertible trail alongside the .bak + inverse_patch.
        const commit_sha = commitAppliedTarget(
          forward_patch.target_path,
          `[tuner] ${proposal.subject} proposal #${proposal.id} (alt ${alternativeId}) via ${appliedBy}`,
        );

        const validation = await subject.validate(forward_patch);
        if (!validation.valid) {
          this.audit("wisecron_validate_failed", {
            proposal_id: proposal.id,
            subject: proposal.subject,
            reason: validation.reason,
          });
          throw new Error(`ApplyPipeline: forward_patch failed validation: ${validation.reason}`);
        }

        const id = this.db.recordApply({
          proposal_id: String(proposal.id),
          subject: proposal.subject,
          forward_patch,
          inverse_patch,
          applied_by: appliedBy,
        });

        this.audit("wisecron_proposal_applied", {
          proposal_id: proposal.id,
          revision_id: id,
          subject: proposal.subject,
          alternative_id: alternativeId,
          applied_by: appliedBy,
          risk_tier: subject.risk_tier,
          commit_sha,
        });

        return {
          revision_id: id,
          armed: this.isHighRisk(subject.risk_tier),
          subjectName: proposal.subject,
          targetPath: proposal.target_path,
        };
      },
    );

    // Observation window runs OUTSIDE the per-target lock so the auto-revert
    // can re-acquire it without deadlocking.
    let auto_reverted = false;
    if (armed) {
      if (this.waitForWindow) {
        const result = await this.armObservationWindow(revision_id, subjectName, targetPath);
        auto_reverted = result.reverted;
      } else {
        void this.armObservationWindow(revision_id, subjectName, targetPath);
      }
    }

    // OutcomeLoop step 5: snapshot baseline fitness. Fire-and-forget — never
    // blocks or fails the apply (observation-only). No-op when unconfigured.
    if (this.outcomeRecorder) {
      void this.outcomeRecorder.snapshotBaseline(proposal).catch((e) => {
        this.audit("wisecron_outcome_snapshot_failed", {
          proposal_id: proposal.id,
          subject: proposal.subject,
          error: (e as Error).message.slice(0, 160),
        });
      });
    }

    return {
      revision: this.db.getRevision(revision_id)!,
      observation_window_armed: armed,
      auto_reverted,
      audit_event_id: `wisecron_proposal_applied:${revision_id}`,
    };
  }

  /**
   * Revert a past apply by replaying its inverse_patch. Throws if already
   * rolled back or if the revision is missing.
   */
  async revert(revisionId: number, appliedBy: AppliedBy): Promise<void> {
    const revision = this.db.getRevision(revisionId);
    if (!revision) {
      throw new Error(`ApplyPipeline.revert: revision ${revisionId} not found`);
    }
    if (revision.rolled_back_at !== null) {
      throw new Error(
        `ApplyPipeline.revert: revision ${revisionId} already rolled back at ${revision.rolled_back_at.toISOString()}`,
      );
    }

    await this.withTargetLock(revision.inverse_patch.target_path, async () => {
      const subject = this.registry.getSubject(revision.subject);

      const inverse: Patch = {
        target_path: revision.inverse_patch.target_path,
        kind: revision.inverse_patch.kind,
        applied_content: revision.inverse_patch.applied_content,
      };

      const subjectWithRevert = subject as unknown as Partial<RevertibleSubject> | undefined;
      if (subjectWithRevert && typeof subjectWithRevert.revert === "function") {
        await subjectWithRevert.revert(inverse);
      } else {
        // Generic fallback: overwrite target_path with inverse content.
        this.writeTarget(inverse.target_path, inverse.applied_content);
      }

      this.db.markRolledBack(revisionId);
      this.audit("wisecron_rollback", {
        revision_id: revisionId,
        proposal_id: revision.proposal_id,
        subject: revision.subject,
        applied_by: appliedBy,
        original_applied_at: revision.applied_at.toISOString(),
      });
    });
  }

  /**
   * Arm an observation window after a high-risk apply. Schedules a check
   * after observationWindowMs that polls subject-specific health signals.
   *
   * Public for direct test access; in production runs called by apply().
   */
  async armObservationWindow(
    revisionId: number,
    subjectName: string,
    targetPath: string,
  ): Promise<ObservationWindowResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.observationWindowMs));

    let probe: { failed: boolean; errors: string[] };
    try {
      probe = await this.healthProbe(subjectName, targetPath);
    } catch (err) {
      probe = { failed: false, errors: [`probe_error: ${(err as Error).message}`] };
    }

    if (probe.failed) {
      try {
        await this.revert(revisionId, "auto-revert");
      } catch (err) {
        this.audit("wisecron_auto_revert_failed", {
          revision_id: revisionId,
          subject: subjectName,
          error: (err as Error).message,
        });
        return { reverted: false, reason: "revert-error", errors_detected: probe.errors };
      }
      this.audit("wisecron_auto_revert", {
        revision_id: revisionId,
        subject: subjectName,
        errors: probe.errors,
      });
      return { reverted: true, reason: "health-probe-failed", errors_detected: probe.errors };
    }
    return { reverted: false, reason: null, errors_detected: [] };
  }

  /**
   * Garbage-collect rollback_history beyond retention. Called by daily cron.
   */
  async purgeExpired(retentionDays: number): Promise<number> {
    return this.db.purgeExpiredRevisions(retentionDays);
  }

  /**
   * Default health probe: route to the registered subject's own
   * `healthProbe(target)`. This is what makes the observation-window
   * auto-revert real — the subject knows how to tell if its just-applied
   * artifact is broken (a JobSpec that no longer parses, a hook that lost its
   * shebang, a CLAUDE.md with fresh broken imports). Subjects without a probe
   * fall back to the fail-open default so the pipeline behaves exactly as
   * before for them.
   */
  private async subjectHealthProbe(
    subjectName: string,
    target: string,
  ): Promise<{ failed: boolean; errors: string[] }> {
    const subject = this.registry.getSubject(subjectName) as
      | (TunableSubject & {
          healthProbe?: (t: string) => Promise<{ failed: boolean; errors: string[] }>;
        })
      | undefined;
    if (subject && typeof subject.healthProbe === "function") {
      return subject.healthProbe(target);
    }
    return defaultHealthProbe(subjectName, target);
  }

  // ── Pure helpers (testable) ───────────────────────────────────────────────

  isHighRisk(riskTier: RiskTier): boolean {
    return HIGH_RISK_TIERS.has(riskTier);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Snapshot the pre-apply state of the proposal's target into an inverse
   * Patch. If the subject defines `snapshotInverse(target)`, the pipeline
   * routes through it (cron serializes the prior JobSpec, hook captures
   * disk bytes). Otherwise we read the target from disk; missing file
   * yields empty `applied_content` and revert() truncates.
   */
  private async snapshotInverse(proposal: Proposal, _alternativeId: string): Promise<Patch> {
    const subject = this.registry.getSubject(proposal.subject);
    let applied_content: string;
    if (subject?.snapshotInverse) {
      applied_content = await subject.snapshotInverse(proposal.target_path);
    } else {
      applied_content = this.readTarget(proposal.target_path) ?? "";
    }
    return {
      target_path: proposal.target_path,
      kind: `${proposal.kind}_inverse`,
      applied_content,
    };
  }

  /**
   * Serialize work touching the same target_path. Both apply() and revert()
   * go through this. The lock is keyed on target path; tests use it to
   * assert ordering guarantees.
   *
   * The map entry is reference-counted: each call increments `waiters` on
   * enqueue and decrements on release; when the count hits zero the entry
   * is deleted. Because JS is single-threaded, the increment and the
   * matched decrement live in the same async closure — every enqueue is
   * guaranteed exactly one decrement on its finally, so the count cannot
   * desync, and the map cannot accumulate stale entries.
   */
  private async withTargetLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(targetPath);
    const prev = existing?.tail ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const newTail = prev.then(() => gate);
    if (existing) {
      existing.tail = newTail;
      existing.waiters += 1;
    } else {
      this.locks.set(targetPath, { tail: newTail, waiters: 1 });
    }
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
      const entry = this.locks.get(targetPath);
      if (entry) {
        entry.waiters -= 1;
        if (entry.waiters <= 0) this.locks.delete(targetPath);
      }
    }
  }
}

// ── Default impls (production) ─────────────────────────────────────────────

async function defaultHealthProbe(
  _subject: string,
  _target: string,
): Promise<{ failed: boolean; errors: string[] }> {
  // Fail-open fallback used only when the subject implements no healthProbe.
  // Concrete probes live on the subjects and are reached via subjectHealthProbe.
  return { failed: false, errors: [] };
}

function defaultReadTarget(path: string): string | null {
  const resolved = path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
  if (!existsSync(resolved)) return null;
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteTarget(path: string, content: string): void {
  const resolved = path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}
