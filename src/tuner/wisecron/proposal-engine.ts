import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Registry } from "../../skills-tuner/core/registry.js";
import type { Observation, Proposal, UnsignedProposal } from "../../skills-tuner/core/types.js";
import {
  computeProposalSignature,
  loadSecret,
  sanitizeObservationContent,
  auditLog,
} from "../../skills-tuner/core/security.js";
import { renderDiff } from "./render-diff.js";
import type { WisecronStateDB } from "./state-db.js";
import type { ProposalCycleResult, ProposalSummary } from "./types.js";

/** Preview byte cap, shared with renderDiff's default — a proposal diff must fit
 *  a Telegram/Discord message and never dump a whole managed file. */
const DIFF_PREVIEW_MAX_BYTES = 2048;

type AuditFn = (event: string, payload: Record<string, unknown>) => void;
type SignFn = (proposal: UnsignedProposal) => string;

/**
 * ProposalEngine — orchestrates one collect → detect → propose cycle for a
 * single subject. Diff preview rendering for human review happens here too.
 *
 * No LLM is invoked at apply time: collect/propose use sonnet via core/llm.ts
 * (Phase 1, direct-SDK), apply is pure patch math.
 */
export class ProposalEngine {
  private readonly registry: Registry;
  private readonly db: WisecronStateDB;
  private readonly now: () => Date;
  private readonly audit: AuditFn;
  private readonly sign: SignFn;
  private readonly readTarget: (path: string) => string | null;

  constructor(
    registry: Registry,
    db: WisecronStateDB,
    opts: {
      now?: () => Date;
      audit?: AuditFn;
      sign?: SignFn;
      readTarget?: (path: string) => string | null;
    } = {},
  ) {
    this.registry = registry;
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.audit = opts.audit ?? auditLog;
    if (opts.sign) {
      this.sign = opts.sign;
    } else {
      let cachedSecret: Buffer | null = null;
      this.sign = (proposal: UnsignedProposal): string => {
        if (!cachedSecret) cachedSecret = loadSecret();
        return computeProposalSignature(proposal, cachedSecret);
      };
    }
    this.readTarget = opts.readTarget ?? defaultReadTarget;
  }

  /**
   * Run a full cycle for the named subject:
   *   1. collectObservations(since=last_run)
   *   2. detectProblems(observations)
   *   3. proposeChange(cluster) for each cluster
   *
   * Caches telemetry rows in wisecron.db.telemetry_cache. Emits audit events
   * `wisecron_cycle_start` and `wisecron_cycle_complete`.
   */
  async runCycle(subjectName: string, since: Date): Promise<ProposalCycleResult> {
    const subject = this.registry.getSubject(subjectName);
    if (!subject) {
      throw new Error(`ProposalEngine: subject '${subjectName}' not registered`);
    }

    const startedAt = this.now();
    this.audit("wisecron_cycle_start", { subject: subjectName, since: since.toISOString() });

    const observations = await subject.collectObservations(since);
    this.cacheObservations(subjectName, observations);

    const clusters = await subject.detectProblems(observations);
    const proposals: UnsignedProposal[] = [];
    for (const cluster of clusters) {
      proposals.push(await subject.proposeChange(cluster));
    }

    const duration_ms = this.now().getTime() - startedAt.getTime();
    this.audit("wisecron_cycle_complete", {
      subject: subjectName,
      observations: observations.length,
      clusters: clusters.length,
      proposals: proposals.length,
      duration_ms,
    });

    return {
      subject: subjectName,
      observations: observations.length,
      clusters: clusters.length,
      proposals,
      duration_ms,
    };
  }

  /**
   * Render a single proposal summary suitable for CLI / Telegram preview.
   * Includes the diff (unified format), alternatives, risk_tier, and target.
   */
  async renderProposalSummary(proposal: UnsignedProposal): Promise<ProposalSummary> {
    const subject = this.registry.getSubject(proposal.subject);
    if (!subject) {
      throw new Error(`ProposalEngine: subject '${proposal.subject}' not registered`);
    }
    const signature = this.sign(proposal);
    const signed: Proposal = { ...proposal, signature };

    // First alternative serves as the diff preview's proposed content.
    const preview = proposal.alternatives[0]?.diff_or_content ?? "";
    const diff_preview = this.computeDiff(proposal.target_path, preview);

    return {
      proposal: signed,
      subject: subject.name,
      risk_tier: subject.risk_tier,
      diff_preview,
    };
  }

  /**
   * Aggregate clusters and observations across multiple subjects for the
   * `tuner wisecron status` view.
   */
  async statusSnapshot(lookbackDays: number): Promise<
    Record<
      string,
      {
        last_run: Date | null;
        next_run: Date | null;
        observations: number;
        clusters: number;
        proposals: number;
      }
    >
  > {
    const lookbackMs = lookbackDays * 86_400_000;
    const sinceIso = new Date(this.now().getTime() - lookbackMs).toISOString();
    const result: Record<
      string,
      {
        last_run: Date | null;
        next_run: Date | null;
        observations: number;
        clusters: number;
        proposals: number;
      }
    > = {};

    const states = this.db.listScheduleStates();
    const stateBySubject = new Map(states.map((s) => [s.subject, s]));

    const subjects = new Set<string>([
      ...stateBySubject.keys(),
      ...this.registry.allSubjects().map((s) => s.name),
    ]);

    for (const subjectName of subjects) {
      const state = stateBySubject.get(subjectName);
      const obsRows = this.db.recentTelemetry(subjectName, sinceIso);
      result[subjectName] = {
        last_run: state?.last_run ?? null,
        next_run: state?.next_run ?? null,
        observations: obsRows.length,
        clusters: 0,
        proposals: state?.last_proposal_count ?? 0,
      };
    }
    return result;
  }

  /**
   * Compute a unified-style diff string between current file content and
   * the proposed content. Used by renderProposalSummary().
   *
   * Lightweight inline diff: shared prefix/suffix elided. Heavy-duty
   * diffing belongs in adapters/cli.ts, but tests assert this returns a
   * deterministic string and handles "file does not exist yet" cleanly.
   */
  computeDiff(targetPath: string, proposedContent: string): string {
    const current = this.readTarget(targetPath);
    if (current === null) {
      const out = [
        `--- ${targetPath} (new file)`,
        `+++ ${targetPath}`,
        ...proposedContent.split("\n").map((line) => `+${line}`),
      ].join("\n");
      // Even a brand-new file can be large — cap the preview.
      if (out.length <= DIFF_PREVIEW_MAX_BYTES) return out;
      return `${out.slice(0, DIFF_PREVIEW_MAX_BYTES - 22)}\n... [diff truncated]`;
    }
    if (current === proposedContent) {
      return `--- ${targetPath}\n+++ ${targetPath}\n(no changes)`;
    }
    // Delegate the change case to the capped unified-diff renderer: the previous
    // inline diff emitted every UNCHANGED line too, so a large managed file
    // (MEMORY.md ~50KB) produced a wall-of-text that silently truncates on
    // Telegram/Discord. renderDiff emits only removed/added lines under a byte cap.
    return renderDiff(current, proposedContent, {
      fromLabel: targetPath,
      toLabel: targetPath,
      maxBytes: DIFF_PREVIEW_MAX_BYTES,
    });
  }

  /**
   * Persist a list of observations in telemetry_cache. Sanitises via
   * core/security.sanitizeObservationContent() before write.
   */
  private cacheObservations(subject: string, observations: Observation[]): void {
    for (const obs of observations) {
      const sanitized: Observation = {
        ...obs,
        verbatim: sanitizeObservationContent(obs.verbatim, 500),
      };
      const obsId = stableObservationId(sanitized);
      this.db.cacheTelemetry(subject, obsId, sanitized);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultReadTarget(path: string): string | null {
  const resolved = path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
  if (!existsSync(resolved)) return null;
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function stableObservationId(obs: Observation): string {
  const h = createHash("sha256");
  h.update(obs.session_id);
  h.update("|");
  h.update(obs.observed_at.toISOString());
  h.update("|");
  h.update(obs.signal_type);
  h.update("|");
  h.update(obs.verbatim);
  return h.digest("hex").slice(0, 32);
}

export { stableObservationId };
