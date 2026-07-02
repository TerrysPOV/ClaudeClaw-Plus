import {
  computeProposalSignature,
  verifyProposalSignature,
  loadSecret,
  auditLog,
} from "./security.js";
import { subjectConfig } from "./config.js";
import type { TunerConfig } from "./config.js";
import type { Proposal, UnsignedProposal } from "./types.js";
import type { TunableSubject } from "./interfaces.js";
import type { Registry } from "./registry.js";
import type { ProposalsStore } from "../storage/proposals.js";
import type { RefusedStore } from "../storage/refused.js";
import { BranchManager } from "../git_ops/branches.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const STATE_HASHES_PATH = join(homedir(), ".config", "tuner", "state-hashes.jsonl");

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * @deprecated v1 tuner engine. Superseded by the wisecron OutcomeLoop
 * (src/tuner/wisecron/outcome-loop.ts + apply-pipeline.ts, #287): detect -> human
 * gate -> apply -> measure fitness -> auto-revert. Scheduled for removal after the
 * wisecron tuner lands. See docs/skills-tuner-to-tuner-migration.md.
 */
export class Engine {
  private secret: Buffer;
  private readonly _applying = new Set<number>(); // in-memory lock: prevents concurrent double-apply
  private readonly _branchManagers = new Map<string, BranchManager>();

  constructor(
    public readonly config: TunerConfig,
    public readonly registry: Registry,
    public readonly proposals: ProposalsStore,
    public readonly refused: RefusedStore,
    private readonly defaultBranches: BranchManager,
  ) {
    this.secret = loadSecret();
  }

  // Lazily instantiate a BranchManager per-subject, falling back to defaultBranches.
  private getBranchManager(subjectName: string): BranchManager {
    const cached = this._branchManagers.get(subjectName);
    if (cached) return cached;
    const subjectCfg = this.config.subjects?.[subjectName];
    const repoPath = subjectCfg?.git_repo
      ? subjectCfg.git_repo.replace(/^~/, homedir())
      : this.defaultBranches.repoPath;
    const bm =
      repoPath === this.defaultBranches.repoPath
        ? this.defaultBranches
        : new BranchManager(repoPath);
    this._branchManagers.set(subjectName, bm);
    return bm;
  }

  async runCycle(
    opts: { since?: Date; subjectName?: string; dryRun?: boolean } = {},
  ): Promise<{ proposed: number; autoApplied: number }> {
    const windowDays =
      ((this.config.detection as unknown as Record<string, unknown>)["window_days"] as
        | number
        | undefined) ?? 7;
    const since = opts.since ?? new Date(Date.now() - windowDays * 86_400_000);
    const totals = { proposed: 0, autoApplied: 0 };

    const subjects: TunableSubject[] = opts.subjectName
      ? [this.registry.getSubject(opts.subjectName)].filter((s): s is TunableSubject => s != null)
      : this.registry.enabledSubjects(this.config);

    for (const subject of subjects) {
      try {
        const r = await this._runSubject(subject.name, since, opts.dryRun ?? false);
        totals.proposed += r.proposed;
        totals.autoApplied += r.autoApplied;
      } catch (err) {
        console.error(`Error running subject ${subject.name}:`, err);
      }
    }
    // Drift detection: compare each subject's state hash vs last recorded value
    const allSubjects = opts.subjectName
      ? [this.registry.getSubject(opts.subjectName)].filter((s): s is TunableSubject => s != null)
      : this.registry.enabledSubjects(this.config);
    for (const subject of allSubjects) {
      try {
        const currentHash = subject.currentStateHash();
        if (!currentHash) continue; // subject opted out (empty string = no-op)
        const prevHash = this._lastStateHash(subject.name);
        if (prevHash === currentHash) continue; // no drift
        auditLog("subject_state_drift_detected", {
          subject: subject.name,
          prev_hash: prevHash || null,
          current_hash: currentHash,
        });
        this._recordStateHash(subject.name, currentHash);
      } catch (err) {
        auditLog("drift_detection_error", { subject: subject.name, error: String(err) });
        // Non-fatal: drift detection is opportunistic, never crashes runCycle
      }
    }

    return totals;
  }

  private _lastStateHash(subjectName: string): string {
    if (!existsSync(STATE_HASHES_PATH)) return "";
    const lines = readFileSync(STATE_HASHES_PATH, "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!);
        if (entry.subject === subjectName) return entry.hash || "";
      } catch {
        /* skip corrupted line */
      }
    }
    return "";
  }

  private _recordStateHash(subjectName: string, hash: string): void {
    mkdirSync(dirname(STATE_HASHES_PATH), { recursive: true });
    const entry = { ts: new Date().toISOString(), subject: subjectName, hash };
    appendFileSync(STATE_HASHES_PATH, JSON.stringify(entry) + "\n");
  }

  private async _runSubject(
    subjectName: string,
    since: Date,
    dryRun: boolean,
  ): Promise<{ proposed: number; autoApplied: number }> {
    const subject = this.registry.getSubject(subjectName);
    if (!subject) return { proposed: 0, autoApplied: 0 };

    const maxPerRun = this.config.detection.max_proposals_per_run;
    const refusedSigs = this.refused.activeSignatures();
    const appliedSigs = this.proposals.appliedSignatures({ withinDays: 30 });
    const pendingSigs = this.proposals.pendingSignatures({ subject: subjectName });

    const observations = await subject.collectObservations(since);
    const clusters = await subject.detectProblems(observations);

    let proposed = 0;
    let autoApplied = 0;

    for (const cluster of clusters) {
      if (proposed >= maxPerRun) break;

      const rawProposal: UnsignedProposal = await subject.proposeChange(cluster);

      // Dedup checks (anti-spam — bug fix 2351440)
      if (refusedSigs.has(rawProposal.pattern_signature)) continue;
      if (appliedSigs.has(rawProposal.pattern_signature)) continue;
      if (pendingSigs.has(rawProposal.pattern_signature)) continue;

      if (dryRun) {
        proposed++;
        continue;
      }

      // Assign ID and sign
      const existingRecords = this.proposals.readAll();
      // Use reduce instead of Math.max(...spread) to avoid stack overflow at ~10k+ records
      const nextId = existingRecords.reduce((max, r) => Math.max(max, r?.proposal?.id ?? 0), 0) + 1;
      const unsignedProposal: UnsignedProposal = { ...rawProposal, id: nextId };
      const sig = computeProposalSignature(unsignedProposal, this.secret);
      const signedProposal: Proposal = { ...unsignedProposal, signature: sig };

      this.proposals.append({
        proposal: signedProposal,
        event: "created",
        ts: new Date().toISOString(),
      });
      auditLog("proposal_created", {
        proposal_id: signedProposal.id,
        subject: signedProposal.subject,
        pattern_signature: signedProposal.pattern_signature,
      });
      proposed++;

      // Auto-merge check — high/critical risk_tier subjects never auto-merge
      const subjectCfg = subjectConfig(this.config, subjectName);
      const autoMerge = subjectCfg.auto_merge;
      const shouldAutoMerge =
        autoMerge === true || (Array.isArray(autoMerge) && autoMerge.includes(signedProposal.kind));
      if (subject.risk_tier === "high" || subject.risk_tier === "critical") {
        if (shouldAutoMerge) {
          console.warn(
            `[Engine] Auto-merge blocked: subject ${subjectName} has risk_tier=${subject.risk_tier}`,
          );
          auditLog("auto_merge_blocked", {
            proposal_id: signedProposal.id,
            subject: subjectName,
            risk_tier: subject.risk_tier,
          });
        }
      } else if (shouldAutoMerge && signedProposal.alternatives.length > 0) {
        try {
          await this.applyProposal(signedProposal.id, signedProposal.alternatives[0]!.id);
          autoApplied++;
        } catch (err) {
          console.error(`Auto-merge failed for proposal ${signedProposal.id}:`, err);
        }
      }
    }
    return { proposed, autoApplied };
  }

  async applyProposal(proposalId: number, alternativeId: string): Promise<void> {
    // In-memory lock prevents concurrent double-apply from two simultaneous calls
    if (this._applying.has(proposalId)) {
      throw new Error(
        `Proposal #${proposalId} is already being applied — concurrent apply rejected`,
      );
    }
    this._applying.add(proposalId);
    try {
      return await this._applyProposalInner(proposalId, alternativeId);
    } finally {
      this._applying.delete(proposalId);
    }
  }

  private async _applyProposalInner(proposalId: number, alternativeId: string): Promise<void> {
    const all = this.proposals.readAll();
    const alreadyApplied = all.find((r) => r?.proposal?.id === proposalId && r.event === "applied");
    if (alreadyApplied)
      throw new Error(`Proposal #${proposalId} already applied — cannot re-apply`);
    const alreadyRefused = all.find((r) => r?.proposal?.id === proposalId && r.event === "refused");
    if (alreadyRefused) throw new Error(`Proposal #${proposalId} already refused — cannot apply`);
    const record = all.find((r) => r?.proposal?.id === proposalId && r.event === "created");
    if (!record) throw new Error(`Proposal #${proposalId} not found or not pending`);
    const proposal = record.proposal;

    const subject = this.registry.getSubject(proposal.subject);
    if (!subject) throw new Error(`Subject ${proposal.subject} not registered`);

    const branches = this.getBranchManager(proposal.subject);
    auditLog("apply_attempted", {
      proposal_id: proposalId,
      alternative_id: alternativeId,
      repo_path: branches.repoPath,
    });

    if (!verifyProposalSignature(proposal, this.secret)) {
      auditLog("signature_mismatch", { proposal_id: proposalId });
      throw new SecurityError(`Proposal #${proposalId} signature mismatch — tamper detected`);
    }

    const patch = await subject.apply(proposal, alternativeId);
    const validation = await subject.validate(patch);

    if (!validation.valid) {
      auditLog("apply_invalid", { proposal_id: proposalId, reason: validation.reason });
      throw new Error(`Validation failed: ${validation.reason ?? "unknown"}`);
    }

    await branches.createProposalBranch(proposalId);
    const commitSha = await branches.commitPatch(patch, proposal, alternativeId);

    this.proposals.append({
      proposal,
      event: "applied",
      ts: new Date().toISOString(),
      alternative_id: alternativeId,
      commit_sha: commitSha,
      applied_target_path: patch.target_path,
    });
    auditLog("apply_success", {
      proposal_id: proposalId,
      alternative_id: alternativeId,
      commit_sha: commitSha,
      repo_path: branches.repoPath,
    });
  }

  async refuseProposal(proposalId: number, reason = "refuse"): Promise<void> {
    const record = this.proposals.readAll().find((r) => r?.proposal?.id === proposalId);
    if (!record) throw new Error(`Proposal #${proposalId} not found`);
    const proposal = record.proposal;

    this.refused.add(proposal.pattern_signature, proposal.subject, reason);
    this.proposals.append({ proposal, event: "refused", ts: new Date().toISOString() });
    auditLog("refused", { proposal_id: proposalId, pattern_signature: proposal.pattern_signature });
  }

  async revertProposal(proposalId: number): Promise<void> {
    const appliedRecord = this.proposals
      .readAll()
      .find((r) => r?.proposal?.id === proposalId && r.event === "applied");
    if (!appliedRecord) throw new Error(`No applied record found for proposal #${proposalId}`);

    const commitSha = (appliedRecord as typeof appliedRecord & { commit_sha?: string }).commit_sha;
    if (!commitSha) throw new Error(`No commit SHA recorded for proposal #${proposalId}`);

    const proposal = appliedRecord.proposal;
    const branches = this.getBranchManager(proposal.subject);

    try {
      // Checkout the proposal branch so revert applies in the right context
      await branches.checkoutProposalBranch(proposalId);
      await branches.revertPatch(commitSha);
      auditLog("reverted", {
        proposal_id: proposalId,
        commit_sha: commitSha,
        repo_path: branches.repoPath,
      });
    } catch (err) {
      auditLog("revert_failed", {
        proposal_id: proposalId,
        commit_sha: commitSha,
        error: String(err),
      });
      throw err;
    }
  }
}
