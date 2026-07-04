import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
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
  // Cross-process apply lock tuning. The in-process `locks` map above only
  // serializes callers inside THIS process; two PROCESSES (the daemon plus a
  // CLI `apply`, or an overlapping restart) hitting the same target are guarded
  // by an O_EXCL lockfile next to the target (see withFileLock). A holder that
  // crashes mid-apply is recovered by stale-lock breaking (dead pid or mtime
  // older than fileLockStaleMs) so the lock can never deadlock forever.
  private readonly fileLockMaxWaitMs: number;
  private readonly fileLockPollMs: number;
  private readonly fileLockStaleMs: number;

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
      /** Max time to wait for a cross-process apply lock before failing cleanly. */
      fileLockMaxWaitMs?: number;
      /** Poll interval while waiting on a contended cross-process apply lock. */
      fileLockPollMs?: number;
      /** Age after which a held lockfile is treated as stale and broken. */
      fileLockStaleMs?: number;
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
    this.fileLockMaxWaitMs = opts.fileLockMaxWaitMs ?? 30_000;
    this.fileLockPollMs = opts.fileLockPollMs ?? 50;
    this.fileLockStaleMs = opts.fileLockStaleMs ?? 60_000;
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

        // Validate BEFORE committing or recording. subject.apply already wrote
        // the new content to disk, so on a validation failure we must roll the
        // on-disk state back to the pre-apply snapshot AND leave NO git commit
        // and NO rollback_history row behind — otherwise a broken config (the
        // very mistrigger these proposals fix) would be persisted + committed
        // with no DB revision to revert it.
        const validation = await subject.validate(forward_patch);
        if (!validation.valid) {
          await this.restoreInverse(subject, inverse_patch);
          this.audit("wisecron_validate_failed", {
            proposal_id: proposal.id,
            subject: proposal.subject,
            reason: validation.reason,
          });
          throw new Error(`ApplyPipeline: forward_patch failed validation: ${validation.reason}`);
        }

        // Only now that the change is known-valid: git-commit the applied target
        // (when it lives in a repo) for a clean, revertible trail alongside the
        // .bak + inverse_patch.
        const commit_sha = commitAppliedTarget(
          forward_patch.target_path,
          `[tuner] ${proposal.subject} proposal #${proposal.id} (alt ${alternativeId}) via ${appliedBy}`,
        );

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
        // Generic fallback: overwrite target_path with inverse content. This
        // path bypasses the subject's own revert()/assertManagedTarget guard,
        // so confine it here — refuse to write through a symlink, and enforce
        // the subject's declared managed surface when it exposes one.
        assertRevertTargetConfined(subject, inverse.target_path);
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
   * Roll a just-written-but-invalid apply back to its pre-apply snapshot. Used
   * on the validate-failure path so a rejected change is never left on disk.
   * Routes through the subject's own `revert()` (which re-asserts confinement)
   * when available, else the confined generic writeTarget. Best-effort: a
   * failure here is audited but never masks the original validation error — the
   * .bak the subject wrote remains on disk for manual recovery.
   */
  private async restoreInverse(subject: unknown, inversePatch: Patch): Promise<void> {
    const inverse: Patch = {
      target_path: inversePatch.target_path,
      kind: inversePatch.kind,
      applied_content: inversePatch.applied_content,
    };
    const subjectWithRevert = subject as unknown as Partial<RevertibleSubject> | undefined;
    try {
      if (subjectWithRevert && typeof subjectWithRevert.revert === "function") {
        await subjectWithRevert.revert(inverse);
      } else {
        assertRevertTargetConfined(subject, inverse.target_path);
        this.writeTarget(inverse.target_path, inverse.applied_content);
      }
    } catch (err) {
      this.audit("wisecron_validate_restore_failed", {
        target_path: inverse.target_path,
        error: (err as Error).message.slice(0, 160),
      });
    }
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
      // The in-process gate is held; now take the cross-process file lock so a
      // separate process (daemon vs CLI, overlapping restart) cannot run the
      // read→apply→commit→record sequence for the same target concurrently.
      return await this.withFileLock(targetPath, fn);
    } finally {
      release?.();
      const entry = this.locks.get(targetPath);
      if (entry) {
        entry.waiters -= 1;
        if (entry.waiters <= 0) this.locks.delete(targetPath);
      }
    }
  }

  /**
   * Cross-process guard around `fn`, keyed on the target path via an O_EXCL
   * lockfile next to the target. Complements the in-process `withTargetLock`
   * gate (which only serializes callers inside this process): here two distinct
   * PROCESSES touching the same target serialize — the second waits (bounded by
   * fileLockMaxWaitMs) and then fails cleanly rather than corrupting the target.
   *
   * Robustness:
   *   - A holder that crashed mid-apply is recovered by breakIfStale (dead pid
   *     or lockfile older than fileLockStaleMs) so we never deadlock forever.
   *   - Best-effort: if the target's directory can't host a lockfile (a
   *     synthetic/read-only path), we degrade to the in-process lock only and
   *     audit it, rather than failing the apply.
   */
  private async withFileLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = lockPathFor(targetPath);
    const acquired = await this.acquireFileLock(lockPath);
    try {
      return await fn();
    } finally {
      if (acquired) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Lock already gone (e.g. broken as stale by a peer): nothing to do.
        }
      }
    }
  }

  /**
   * Acquire the O_EXCL lockfile at `lockPath`, waiting (polling) up to
   * fileLockMaxWaitMs for a live holder to release it and breaking a stale
   * holder on the way. Returns true when the lock is held by us, or false when
   * the filesystem cannot host a lockfile (degrade to in-process lock only).
   * Throws a clear error if a live peer holds the lock past the wait budget.
   */
  private async acquireFileLock(lockPath: string): Promise<boolean> {
    const deadline = Date.now() + this.fileLockMaxWaitMs;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
        try {
          writeSync(
            fd,
            JSON.stringify({ pid: process.pid, host: hostname(), time: Date.now() }),
          );
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Contended. Break it if the holder is gone, else wait and retry.
          if (this.breakIfStale(lockPath)) continue;
          if (Date.now() >= deadline) {
            throw new Error(
              `ApplyPipeline: could not acquire apply lock ${lockPath} within ` +
                `${this.fileLockMaxWaitMs}ms — held by another process`,
            );
          }
          await sleep(this.fileLockPollMs);
          continue;
        }
        // The directory can't host a lockfile (missing/read-only/synthetic
        // path). Degrade to in-process locking only rather than failing apply.
        this.audit("wisecron_apply_lock_unavailable", {
          lock_path: lockPath,
          error: (err as Error).message.slice(0, 160),
        });
        return false;
      }
    }
  }

  /**
   * If the lockfile at `lockPath` is stale — its recorded holder pid is dead
   * (same host) or the file is older than fileLockStaleMs — remove it and
   * return true so the caller can retry the O_EXCL create. A corrupt/vanished
   * lockfile is also treated as breakable. Returns false when a live holder
   * legitimately owns it.
   */
  private breakIfStale(lockPath: string): boolean {
    let info: { pid?: number; host?: string; time?: number };
    let ageMs: number;
    try {
      info = JSON.parse(readFileSync(lockPath, "utf8")) as typeof info;
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // Unreadable or already removed by a peer → safe to (re)claim.
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
      return true;
    }
    const sameHost = !info.host || info.host === hostname();
    let holderAlive = true;
    if (sameHost && typeof info.pid === "number") {
      try {
        process.kill(info.pid, 0);
        holderAlive = true;
      } catch (e) {
        // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
        holderAlive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    const stale = !holderAlive || ageMs > this.fileLockStaleMs;
    if (!stale) return false;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
    this.audit("wisecron_apply_lock_broken", {
      lock_path: lockPath,
      holder_pid: info.pid ?? null,
      age_ms: Math.round(ageMs),
      reason: holderAlive ? "stale-mtime" : "dead-holder",
    });
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lockfile path next to a target: `<dir>/.<base>.tuner-apply.lock`. `~` is
 * expanded and the path resolved so two processes referring to the same file
 * by different spellings still contend on one lock.
 */
export function lockPathFor(targetPath: string): string {
  const expanded = targetPath.startsWith("~") ? targetPath.replace(/^~/, homedir()) : targetPath;
  const abs = resolve(expanded);
  return join(dirname(abs), `.${basename(abs)}.tuner-apply.lock`);
}

// ── Confinement helpers (revert path) ──────────────────────────────────────

/**
 * Confine a generic (subject-less) revert write. The subject's own revert()
 * enforces its managed surface; this fallback runs when the subject has none,
 * so it enforces what it safely can: (a) never write THROUGH a symlink (a
 * writeFileSync follows it, which could redirect the write into engine code),
 * and (b) membership in the subject's declared `managedTargets()` when exposed.
 */
function assertRevertTargetConfined(subject: unknown, target: string): void {
  if (isSymlinkPath(target)) {
    throw new Error(`ApplyPipeline.revert: refusing to write through symlink target: ${target}`);
  }
  const s = subject as { managedTargets?: () => string[] } | undefined;
  if (s && typeof s.managedTargets === "function") {
    const managed = s.managedTargets().map(realResolvePath);
    if (!managed.includes(realResolvePath(target))) {
      throw new Error(`ApplyPipeline.revert: target outside managed surface: ${target}`);
    }
  }
}

function realResolvePath(p: string): string {
  const abs = resolve(p);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

function isSymlinkPath(p: string): boolean {
  try {
    return lstatSync(resolve(p)).isSymbolicLink();
  } catch {
    return false;
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
