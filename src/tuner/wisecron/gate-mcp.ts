/**
 * The proposal GATE over the MCP bridge — the lifecycle counterpart to
 * `telemetry-mcp.ts`.
 *
 * Where `telemetry-mcp.ts` exposes the measurement INPUT (capabilities/query),
 * THIS module exposes the proposal LIFECYCLE (propose → pending → apply →
 * mature) as MCP tools backed by the live `WisecronStateDB`. That is the
 * convergence the design mandates: the canonical wisecron engine — until now
 * reachable only through the `wisecron <sub>` CLI commands — becomes
 * MCP-native. Same operations, one auditable surface, callable through the
 * bridge by any consumer (cron runner, Telegram notifier, a future dashboard)
 * exactly the way the telemetry tools already are.
 *
 * FQN prefix `tuner__` (mirrors `telemetry__`):
 *   tuner__propose  — run detect+propose for each enabled subject, persist (pending)
 *   tuner__pending  — list pending proposals
 *   tuner__list     — list proposals by status (pending|applied|refused)
 *   tuner__apply    — apply a pending proposal (+ fitness baseline snapshot)
 *   tuner__refuse   — mark a pending proposal refused (no apply)
 *   tuner__mature   — run the maturation pass (verdicts + defensive auto-revert)
 *   tuner__status   — counts summary across statuses
 *
 * The handlers are the CLI subcommand bodies, verbatim in behaviour: they drive
 * the SAME `WisecronBundle` (db/engine/recorder-armed pipeline/registry) that
 * `bootstrapWisecron` builds for the CLI, so there is one engine and one
 * wisecron.db — not a parallel copy. Every state-changing call appends a
 * `gate_<action>` record to the shared audit chain for provenance, the way the
 * telemetry surface audits each served query.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { PluginMcpBridge } from "../../plugins/mcp-bridge.js";
import type { WisecronBundle } from "../../skills-tuner/cli/wisecron-bootstrap.js";
import { computeProposalSignature, loadSecret } from "../../skills-tuner/core/security.js";
import type {
  ProposalListing,
  ProposalStatus,
  StoredProposal,
  UnreadableProposalRow,
} from "./state-db.js";
import type { AppliedBy } from "./types.js";
import type { UnsignedProposal } from "../../skills-tuner/core/types.js";

/** Provenance tag carried in pattern_signature for research-sourced proposals. */
export const RESEARCH_PREFIX = "research:";

/**
 * Enforce a subject's declared managed surface for an externally-injected
 * proposal. When the subject exposes `managedTargets()`, the injected
 * `target_path` MUST resolve to one of them; otherwise the gate would let a
 * self-signed caller point a subject's apply at an arbitrary file. Subjects
 * without a declared surface are not constrained here (they must still enforce
 * their own confinement in apply()), so this never weakens existing behaviour.
 */
function assertTargetInManagedSurface(subject: unknown, targetPath: string): void {
  const s = subject as { managedTargets?: () => string[]; name?: string };
  if (typeof s.managedTargets !== "function") return;
  const managed = s.managedTargets().map(realResolvePath);
  if (!managed.includes(realResolvePath(targetPath))) {
    throw new Error(
      `target_path '${targetPath}' is outside the managed surface of subject '${s.name ?? "?"}'`,
    );
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

/**
 * Deterministic proposal id from a research provenance signature. Re-injecting
 * the same finding yields the same id, so `persistProposal` (ON CONFLICT DO
 * NOTHING) dedups it — the anti-noise discipline the scout's allow-list wants.
 * 6 bytes → ≤2^48, well inside Number.MAX_SAFE_INTEGER and SQLite INTEGER.
 */
function researchProposalId(subject: string, signature: string): number {
  return createHash("sha256").update(`${subject} ${signature}`).digest().readUIntBE(0, 6);
}

// ── Wire contract ────────────────────────────────────────────────────────────

/** Bridge pluginId for the proposal-gate surface (FQN prefix `tuner__`). */
export const GATE_PLUGIN_ID = "tuner";

export const TUNER_PROPOSE_TOOL = "tuner__propose";
export const TUNER_PROPOSE_EXTERNAL_TOOL = "tuner__propose_external";
export const TUNER_PENDING_TOOL = "tuner__pending";
export const TUNER_LIST_TOOL = "tuner__list";
export const TUNER_APPLY_TOOL = "tuner__apply";
export const TUNER_REFUSE_TOOL = "tuner__refuse";
export const TUNER_MATURE_TOOL = "tuner__mature";
export const TUNER_STATUS_TOOL = "tuner__status";

const ProposeArgs = z.object({
  sinceHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(24)
    .describe("observation window in hours (default 24)"),
  subject: z.string().optional().describe("run only this subject (default: all enabled)"),
});

const ExternalArgs = z.object({
  subject: z.string().describe("registered subject the proposal targets (e.g. model_routing)"),
  target_path: z.string().describe("file the alternatives rewrite (the subject's apply target)"),
  kind: z.string().default("patch"),
  pattern_signature: z
    .string()
    .describe("stable provenance/dedup key; a 'research:' prefix is added if absent"),
  alternatives: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().default(""),
        diff_or_content: z.string(),
        tradeoff: z.string().default(""),
      }),
    )
    .min(1)
    .max(3),
});

const ListArgs = z.object({
  status: z
    .enum(["pending", "applied", "refused"])
    .optional()
    .describe("filter by lifecycle status (default: all)"),
});

const ApplyArgs = z.object({
  id: z.string().describe("proposal id (see tuner__pending)"),
  alt: z.string().optional().describe("alternative id to apply (default: first)"),
});

const RefuseArgs = z.object({
  id: z.string().describe("proposal id to refuse"),
});

const MatureArgs = z.object({
  asOf: z.string().optional().describe("ISO timestamp to evaluate maturation as of (default: now)"),
});

// ── Result shapes ────────────────────────────────────────────────────────────

interface ProposeResult {
  window_hours: number;
  total_proposed: number;
  subjects: Array<{ subject: string; observations: number; clusters: number; proposed: number }>;
}

/** A compact view of a stored proposal for the wire (full Proposal omitted). */
interface ProposalView {
  id: string;
  subject: string;
  status: ProposalStatus;
  target_path: string;
  kind: string;
  alternatives: string[];
  created_at: string;
}

function toView(p: StoredProposal): ProposalView {
  return {
    id: p.id,
    subject: p.subject,
    status: p.status,
    target_path: p.proposal.target_path,
    kind: p.proposal.kind,
    alternatives: p.proposal.alternatives.map((a) => a.id),
    created_at: p.created_at.toISOString(),
  };
}

/**
 * A listing result. `unreadable` is present only when a stored row failed to
 * rehydrate: the good rows still come back, and the rows that were skipped are
 * named here rather than dropped without a trace.
 */
interface ListResult {
  count: number;
  proposals: ProposalView[];
  unreadable?: UnreadableProposalRow[];
}

function toListResult(listing: ProposalListing): ListResult {
  const result: ListResult = {
    count: listing.proposals.length,
    proposals: listing.proposals.map(toView),
  };
  if (listing.unreadable.length > 0) result.unreadable = listing.unreadable;
  return result;
}

export interface RegisterGateOpts {
  /**
   * Actor stamped on the apply/revision row and on gate audit records — which
   * surface drove the call. "research" lets chantier-2 research-sourced
   * proposals be told apart downstream. Defaults to "mcp".
   */
  source?: AppliedBy;
}

/**
 * Register the proposal-gate tools on the bridge, backed by `bundle`. Re-registers
 * cleanly (a served process can rebuild the surface). Returns the FQNs registered.
 */
export function registerWisecronGateTools(
  bridge: PluginMcpBridge,
  bundle: WisecronBundle,
  opts: RegisterGateOpts = {},
): { tools: string[] } {
  const { db, engine, registry, pipeline, recorder, audit } = bundle;
  const source: AppliedBy = opts.source ?? "mcp";

  // Re-register cleanly so a served process can rebuild the surface.
  bridge.unregisterPlugin(GATE_PLUGIN_ID);

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "propose",
    description:
      "Run detect+propose for each enabled wisecron subject over the last sinceHours, " +
      "sign and persist any proposals as pending. Returns per-subject counts.",
    schema: ProposeArgs,
    handler: async (args: z.infer<typeof ProposeArgs>): Promise<ProposeResult> => {
      const since = new Date(Date.now() - args.sinceHours * 3600_000);
      const names = args.subject ? [args.subject] : registry.allSubjects().map((s) => s.name);
      const secret = loadSecret();
      const subjects: ProposeResult["subjects"] = [];
      let total = 0;
      for (const name of names) {
        if (!registry.getSubject(name)) continue;
        const result = await engine.runCycle(name, since);
        for (const unsigned of result.proposals) {
          const signed = { ...unsigned, signature: computeProposalSignature(unsigned, secret) };
          db.persistProposal(signed);
        }
        total += result.proposals.length;
        subjects.push({
          subject: name,
          observations: result.observations,
          clusters: result.clusters,
          proposed: result.proposals.length,
        });
      }
      audit?.append({
        event: "gate_propose",
        detail: { source, window_hours: args.sinceHours, total_proposed: total },
      });
      return { window_hours: args.sinceHours, total_proposed: total, subjects };
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "propose_external",
    description:
      "Inject an externally-sourced (research) proposal: sign it and persist as " +
      "pending so it flows through the same human-gate + outcome-measure loop as a " +
      "telemetry proposal. The id is derived from the provenance signature, so " +
      "re-injecting the same finding dedups. The subject must be registered (apply " +
      "routes to it).",
    schema: ExternalArgs,
    handler: async (args: z.infer<typeof ExternalArgs>) => {
      const targetSubject = registry.getSubject(args.subject);
      if (!targetSubject) {
        throw new Error(
          `subject '${args.subject}' not registered — a research proposal must target an applicable subject`,
        );
      }
      // Scope guard AT THE GATE. A propose_external caller supplies both the
      // target_path and the alternatives' content, and we SELF-SIGN with the
      // tuner secret — so apply's signature check always passes and gives zero
      // protection against an arbitrary file write. Enforce the target subject's
      // declared managed surface HERE, before persisting+signing, so a future
      // subject that forgets its own apply-time guard still can't be driven to
      // write outside its surface.
      assertTargetInManagedSurface(targetSubject, args.target_path);
      const sig = args.pattern_signature.startsWith(RESEARCH_PREFIX)
        ? args.pattern_signature
        : `${RESEARCH_PREFIX}${args.pattern_signature}`;
      const id = researchProposalId(args.subject, sig);
      // Existence only: dedup does not need the row's contents, and a row the
      // read schema cannot parse must not turn a re-injection into a hard error.
      const deduped = db.hasProposal(String(id));
      const unsigned: UnsignedProposal = {
        id,
        cluster_id: sig,
        subject: args.subject,
        kind: args.kind,
        target_path: args.target_path,
        alternatives: args.alternatives,
        pattern_signature: sig,
        created_at: new Date(),
      };
      const signed = { ...unsigned, signature: computeProposalSignature(unsigned, loadSecret()) };
      db.persistProposal(signed);
      audit?.append({
        event: "gate_propose",
        detail: {
          source: "research",
          injected: true,
          id: String(id),
          subject: args.subject,
          deduped,
        },
      });
      return { id: String(id), subject: args.subject, pattern_signature: sig, deduped };
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "pending",
    description:
      "List persisted proposals awaiting apply (status=pending). Rows that fail to " +
      "parse are reported under 'unreadable' instead of failing the listing.",
    schema: z.object({}),
    handler: (): ListResult => toListResult(db.listProposalsDetailed("pending")),
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "list",
    description:
      "List proposals, optionally filtered by status (pending|applied|refused). Rows " +
      "that fail to parse are reported under 'unreadable' instead of failing the listing.",
    schema: ListArgs,
    handler: (args: z.infer<typeof ListArgs>): ListResult =>
      toListResult(db.listProposalsDetailed(args.status)),
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "apply",
    description:
      "Apply a pending proposal (snapshots a fitness baseline at apply). " +
      "Refuses if the proposal is not pending.",
    schema: ApplyArgs,
    handler: async (args: z.infer<typeof ApplyArgs>) => {
      const stored = db.getStoredProposal(args.id);
      if (!stored) throw new Error(`proposal #${args.id} not found`);
      if (stored.status !== "pending") {
        throw new Error(
          `proposal #${args.id} is '${stored.status}', not pending — refusing to re-apply`,
        );
      }
      const altId = args.alt ?? stored.proposal.alternatives[0]?.id;
      // Thread research provenance through to the revision/outcome: a proposal
      // tagged research is applied AS "research", so a later quality metric can
      // compare research-sourced outcomes against telemetry-sourced ones by
      // applied_by — no schema change needed.
      const actor: AppliedBy = stored.proposal.pattern_signature.startsWith(RESEARCH_PREFIX)
        ? "research"
        : source;

      // Crash-idempotency. pipeline.apply() (write + .bak + rollback_history row)
      // and the status flip below are not atomic: a crash between them leaves the
      // proposal `pending` with a live revision already on disk. A naive re-apply
      // would re-snapshot the ALREADY-applied target — overwriting the pristine
      // .bak with applied content and capturing a wrong inverse, silently losing
      // the rollback target and duplicating the revision. If a live revision
      // already exists for this proposal, do NOT re-apply: just reconcile the
      // status and return the existing revision.
      const existingRev = db.getActiveRevisionByProposal(args.id);
      if (existingRev) {
        db.setProposalStatus(args.id, "applied");
        await recorder.snapshotBaseline(stored.proposal);
        const rows = db.getOutcomes(args.id);
        audit?.append({
          event: "gate_apply",
          detail: {
            source: actor,
            id: args.id,
            subject: stored.subject,
            alt: altId,
            reconciled: true,
          },
        });
        return {
          id: args.id,
          subject: stored.subject,
          alt: altId,
          revision_id: existingRev.id,
          observation_window_armed: false,
          baselines: rows.map((r) => ({
            metric: r.metric,
            baseline: r.baseline,
            matures_at: r.window_end,
          })),
        };
      }

      const outcome = await pipeline.apply(stored.proposal, altId, actor);
      db.setProposalStatus(args.id, "applied");
      // Await the baseline explicitly so it is durable before a short-lived
      // caller exits (idempotent — ON CONFLICT refreshes).
      await recorder.snapshotBaseline(stored.proposal);
      const rows = db.getOutcomes(args.id);
      audit?.append({
        event: "gate_apply",
        detail: { source: actor, id: args.id, subject: stored.subject, alt: altId },
      });
      return {
        id: args.id,
        subject: stored.subject,
        alt: altId,
        revision_id: outcome.revision.id,
        observation_window_armed: outcome.observation_window_armed,
        baselines: rows.map((r) => ({
          metric: r.metric,
          baseline: r.baseline,
          matures_at: r.window_end,
        })),
      };
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "refuse",
    description: "Mark a pending proposal refused (no apply, no baseline).",
    schema: RefuseArgs,
    handler: (args: z.infer<typeof RefuseArgs>) => {
      const stored = db.getStoredProposal(args.id);
      if (!stored) throw new Error(`proposal #${args.id} not found`);
      if (stored.status !== "pending") {
        throw new Error(`proposal #${args.id} is '${stored.status}', not pending`);
      }
      db.setProposalStatus(args.id, "refused");
      audit?.append({
        event: "gate_refuse",
        detail: { source, id: args.id, subject: stored.subject },
      });
      return { id: args.id, status: "refused" as ProposalStatus };
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "mature",
    description:
      "Run the maturation pass: compute post/delta/verdict for matured baselines; " +
      "LOW-risk regressions auto-revert, higher tiers enqueue for human approval.",
    schema: MatureArgs,
    handler: async (args: z.infer<typeof MatureArgs>) => {
      const asOf = args.asOf ? new Date(args.asOf) : new Date();
      if (Number.isNaN(asOf.getTime())) throw new Error("asOf must be a valid ISO timestamp");
      const results = await recorder.runMaturation({
        asOf,
        revert: async (proposalId: string, tier: string) => {
          if (tier !== "low") return false;
          const rev = db.getActiveRevisionByProposal(proposalId);
          if (!rev) return false;
          await pipeline.revert(rev.id, "auto-revert");
          return true;
        },
      });
      audit?.append({ event: "gate_mature", detail: { source, matured: results.length } });
      return {
        matured: results.length,
        outcomes: results.map((r) => ({
          id: r.proposal_id,
          subject: r.subject,
          metric: r.target_metric,
          verdict: r.verdict,
          reverted: r.reverted,
        })),
      };
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "status",
    description:
      "Counts of proposals by lifecycle status (pending/applied/refused), plus an " +
      "'unreadable' count when some stored row could not be parsed.",
    schema: z.object({}),
    handler: (): Record<ProposalStatus, number> & { unreadable?: number } => {
      const counts: Record<ProposalStatus, number> = { pending: 0, applied: 0, refused: 0 };
      // Per-row isolation: this walks EVERY row, including terminal ones no
      // caller will ever act on again, so one unparseable row must not be able
      // to take the whole summary down with it. Skipped rows are counted out
      // loud rather than folded into a status bucket.
      const { proposals, unreadable } = db.listProposalsDetailed();
      for (const p of proposals) counts[p.status]++;
      return unreadable.length > 0 ? { ...counts, unreadable: unreadable.length } : counts;
    },
  });

  return {
    tools: [
      TUNER_PROPOSE_TOOL,
      TUNER_PROPOSE_EXTERNAL_TOOL,
      TUNER_PENDING_TOOL,
      TUNER_LIST_TOOL,
      TUNER_APPLY_TOOL,
      TUNER_REFUSE_TOOL,
      TUNER_MATURE_TOOL,
      TUNER_STATUS_TOOL,
    ],
  };
}
