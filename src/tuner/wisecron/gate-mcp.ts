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
import { isKnownProposalStatus, ProposalRejectedError } from "./state-db.js";
import type {
  ProposalListing,
  ProposalStatus,
  StoredProposal,
  UnreadableProposalRow,
} from "./state-db.js";
import type { AppliedBy } from "./types.js";
import { MAX_ALTERNATIVES } from "../../skills-tuner/core/types.js";
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
    // Same runaway guard as the in-tree emit path — one bound, one meaning.
    // An external subject that legitimately has five options for a capability
    // should not be held to a stricter shape than a built-in one.
    .max(MAX_ALTERNATIVES),
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

/** How many individual refusals a propose response will name before it starts
 *  counting them instead. */
const MAX_REJECTED_REPORTED = 20;

/** Same bound for the degradation audit's id and status lists. */
const MAX_DEGRADED_IDS_REPORTED = 20;

interface ProposeResult {
  window_hours: number;
  total_proposed: number;
  subjects: Array<{
    subject: string;
    /** Absent when the subject's cycle threw — unknown, not zero. */
    observations?: number;
    clusters?: number;
    /** Rows actually INSERTED. A proposal already on disk is not counted here
     *  — see `deduped`. */
    proposed: number;
    /** Proposals presented again that were already stored. Absent when zero. */
    deduped?: number;
    /** Present when this subject's cycle failed outright; the rest of the run
     *  continued without it. */
    error?: string;
  }>;
  /** Proposals the emit gate refused, named so an operator can find the
   *  culprit. A refusal is one subject's bug, not the run's — a storage
   *  failure is NOT reported here, it fails the subject. Capped; see
   *  `rejected_truncated`. */
  rejected?: Array<{ subject: string; id: number; error: string }>;
  /** How many refusals beyond the reported ones were dropped from the list. */
  rejected_truncated?: number;
}

interface ProposeExternalResult {
  id: string;
  subject: string;
  pattern_signature: string;
  deduped: boolean;
  /** Set when the dedup matched a row that no longer rehydrates: the proposal
   *  is on disk but unusable, so `deduped: true` alone would overstate it. */
  existing_unreadable?: boolean;
}

/** A compact view of a stored proposal for the wire (full Proposal omitted). */
interface ProposalView {
  id: string;
  subject: string;
  /** Verbatim, so a caller sees `rejected` rather than a value silently
   *  reshaped to fit a union it never belonged to. */
  status: string;
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
 * Summary shape for `tuner__status`.
 *
 * Every row on disk lands in exactly one bucket and the buckets sum to
 * `total`, so a summary that quietly loses rows stops adding up rather than
 * looking clean. `unknown_status` and `unreadable` are the two ways a row can
 * fall outside the lifecycle union — a status column value this binary no
 * longer writes, and stored JSON that no longer parses.
 */
interface StatusResult {
  pending: number;
  applied: number;
  refused: number;
  total: number;
  unknown_status?: Record<string, number>;
  /** ROWS whose status is outside the union and whose status name is not
   *  listed individually in `unknown_status`. Counted so the buckets still
   *  sum to `total`. */
  unknown_status_other?: number;
  /** How many distinct status names were left out of `unknown_status`. This
   *  one is a name count, and it is never part of the sum. */
  unknown_status_names_omitted?: number;
  unreadable?: number;
}

/**
 * Record store degradation in the audit chain.
 *
 * Without this, an unreadable or unknown-status row is discoverable only if a
 * human happens to call a listing tool and happens to read past `count`. Every
 * other gate event is audited; a store quietly rotting should be too, so there
 * is a trail to read afterwards instead of a live query to catch in the act.
 */
function auditStoreDegraded(
  audit: WisecronBundle["audit"],
  source: string,
  /** Tool name plus the filter it was asked for — the scope this fingerprint
   *  describes. See the keying note below. */
  scope: string,
  unreadable: readonly UnreadableProposalRow[],
  unknownStatus: Record<string, number> = {},
  seen?: Record<string, string>,
): void {
  // Degradation is a STATE, not an event: the rows stay broken until someone
  // repairs them, and `status` is the health-dashboard tool, so it gets
  // polled. Appending on every poll would write thousands of identical
  // records a year into a chain that never rotates and is re-read whole on
  // every construction — burying the gate_apply/gate_refuse provenance it
  // exists to protect. Emit on change only.
  //
  // Keyed on the QUERY SCOPE, not the tool. Each caller sees a different
  // slice — `status` walks every row, `pending` sees one status, `list` sees
  // whichever status it was asked for — and two slices that disagree must not
  // overwrite each other's memory. Keying on the tool name looked like enough
  // and was not: `list` alone has four scopes (unfiltered plus three
  // statuses), so a dashboard with status tabs reproduced the flood exactly,
  // and a healthy slice erased the memory of a degraded one.
  const fingerprint =
    unreadable.length === 0 && Object.keys(unknownStatus).length === 0
      ? ""
      : JSON.stringify({
          unreadable: [...unreadable.map((r) => r.id)].sort(),
          unknown: Object.entries(unknownStatus).sort(),
        });

  // A healthy read CLEARS this scope's slot rather than returning early:
  // otherwise a degradation that is repaired and then recurs identically
  // matches the stale fingerprint and is never audited again, and the chain
  // shows a degradation that started and never ended. It clears only its OWN
  // scope — a healthy `list(applied)` says nothing about `list(pending)`.
  if (fingerprint === "") {
    if (seen) delete seen[scope];
    return;
  }
  if (seen && seen[scope] === fingerprint) return;

  // Bounded for the same reason `rejected[]` is: a degraded store is exactly
  // where these lists get long, and this one is written into a chain that is
  // never rotated and re-read whole on every construction.
  const ids = unreadable.slice(0, MAX_DEGRADED_IDS_REPORTED).map((r) => r.id);
  const statuses = Object.fromEntries(
    Object.entries(unknownStatus).slice(0, MAX_DEGRADED_IDS_REPORTED),
  );
  // Best-effort. `AuditLog.append` reads, stats, renames, mkdirs and appends —
  // five throwable syscalls — and this is a decoration on a READ. Letting it
  // out would mean a full disk takes down `status`/`pending`/`list`, which
  // could not fail that way before this file started auditing them: the
  // observability killing the query it observes, on a store already degraded.
  try {
    audit?.append({
      event: "gate_store_degraded",
      detail: {
        source,
        scope,
        unreadable: unreadable.length,
        unreadable_ids: ids,
        unreadable_ids_truncated: unreadable.length - ids.length,
        unknown_status: statuses,
        // ROWS, like the response carries. Naming only the omitted STATUSES
        // would let one omitted name hide any number of rows with nothing in
        // the record to recover them from — the same silent loss this whole
        // change set removes, and the chain is the surface that has to
        // survive the query. Note the neighbouring `unreadable` pair already
        // gets this right; the two must not disagree.
        unknown_status_rows: Object.values(unknownStatus).reduce((a, b) => a + b, 0),
        unknown_status_names_omitted:
          Object.keys(unknownStatus).length - Object.keys(statuses).length,
      },
    });
  } catch {
    // Nothing landed, so nothing is remembered as reported — the next read
    // tries again rather than staying silent about a state never recorded.
    return;
  }
  // Recorded only AFTER the append lands. Marking it first meant a throw from
  // `append` — the full-disk case this file treats as first class — left the
  // state remembered as reported with nothing on disk to show for it.
  //
  // Only when there IS an audit sink: with none configured, remembering a
  // state as reported would suppress the first real record if one is wired
  // later in the process's life.
  if (seen && audit) seen[scope] = fingerprint;
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
  /** Unreadable rows beyond the reported ones. `status` always carries the
   *  full count. */
  unreadable_truncated?: number;
}

function toListResult(listing: ProposalListing): ListResult {
  const result: ListResult = {
    count: listing.proposals.length,
    proposals: listing.proposals.map(toView),
  };
  if (listing.unreadable.length > 0) {
    // Capped for the same reason `rejected[]` is, and the reason applies more
    // here: each entry carries a full schema error, these tools are called by
    // an autonomous agent, and a badly degraded store is exactly when the
    // list is long. Bounding the audit record while returning the whole thing
    // over the wire would have been the same rule enforced in one direction.
    result.unreadable = listing.unreadable.slice(0, MAX_DEGRADED_IDS_REPORTED);
    const dropped = listing.unreadable.length - result.unreadable.length;
    if (dropped > 0) result.unreadable_truncated = dropped;
  }
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
  // Scoped to this registration so a rebuilt surface re-reports the current
  // state once, rather than staying silent because a previous process had
  // already seen it.
  const degradedSeen: Record<string, string> = {};

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
      const rejected: NonNullable<ProposeResult["rejected"]> = [];
      let rejectedTotal = 0;
      let dedupedTotal = 0;
      let total = 0;
      // Isolation at BOTH loop levels, for the same reason the read path has
      // it: one subject's bad output must not decide the fate of the run.
      // Without it a single refusal aborts the cycle mid-flight — subjects
      // already walked keep their persisted rows, subjects after it never run,
      // and the `gate_propose` record below never lands, so the audit chain
      // shows no propose attempt at all despite rows having been written.
      for (const name of names) {
        if (!registry.getSubject(name)) continue;
        // Declared OUTSIDE the try. `persistProposal` is a bare autocommit
        // INSERT with no transaction around the loop, so a proposal written
        // before a later failure is durably on disk and pending apply.
        // Counting inside the try discarded those rows the moment the throw
        // jumped to the catch — a summary reporting zero while rows sit in
        // the store, which is the exact defect this PR exists to remove.
        let persisted = 0;
        let deduped = 0;
        try {
          const result = await engine.runCycle(name, since);
          for (const unsigned of result.proposals) {
            const signed = { ...unsigned, signature: computeProposalSignature(unsigned, secret) };
            try {
              // Counts INSERTS, not calls. `persistProposal` is idempotent by
              // design (`ON CONFLICT DO NOTHING`), so a cron re-running an
              // overlapping window presents the same proposals again — and
              // counting presentations would report a stream of proposals
              // while writing nothing, which is the same summary-that-lies
              // this change set exists to remove.
              if (db.persistProposal(signed)) persisted++;
              else {
                deduped++;
                dedupedTotal++;
              }
            } catch (err) {
              // ONLY an emit-gate refusal is the subject's own bug. Anything
              // else here — a full disk, a locked database — is the run's
              // problem, and filing it under `rejected` would report a
              // healthy cycle that proposed nothing while blaming the
              // subject for the storage layer. Let it out to the per-subject
              // catch, which records the subject as errored.
              if (!(err instanceof ProposalRejectedError)) throw err;
              if (rejected.length < MAX_REJECTED_REPORTED) {
                rejected.push({ subject: name, id: unsigned.id, error: err.reason });
              }
              rejectedTotal++;
            }
          }
          total += persisted;
          subjects.push({
            subject: name,
            observations: result.observations,
            clusters: result.clusters,
            proposed: persisted,
            ...(deduped > 0 ? { deduped } : {}),
          });
        } catch (err) {
          // `observations`/`clusters` are omitted because they are genuinely
          // unknown — the cycle may have collected plenty before it failed.
          // `proposed` is NOT unknown: it is what actually reached the store
          // before the failure, and reporting 0 there would be a measurable
          // lie rather than an absence.
          total += persisted;
          subjects.push({
            subject: name,
            proposed: persisted,
            // `deduped` is known here for exactly the reason `proposed` is —
            // both were counted before the throw. Dropping it would be the
            // same measurable absence the comment above refuses for its
            // sibling.
            ...(deduped > 0 ? { deduped } : {}),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Appended unconditionally: a run that refused everything still happened,
      // and that is precisely the run an auditor needs to find later.
      audit?.append({
        event: "gate_propose",
        detail: {
          source,
          window_hours: args.sinceHours,
          total_proposed: total,
          // An auditor reading the chain must be able to tell "the subject
          // produced nothing" from "the subject re-presented findings already
          // stored". Recording it in the response only would repeat, in the
          // other direction, the mistake of bounding the audit record while
          // leaving the response beside it unbounded.
          deduped: dedupedTotal,
          rejected: rejectedTotal,
          failed_subjects: subjects.filter((sub) => sub.error).map((sub) => sub.subject),
        },
      });
      const out: ProposeResult = { window_hours: args.sinceHours, total_proposed: total, subjects };
      if (rejectedTotal > 0) {
        out.rejected = rejected;
        // A looping subject is exactly what the emit guard exists to catch;
        // handing the operator every one of its refusals over the wire would
        // trade a runaway proposal for a runaway response.
        if (rejectedTotal > rejected.length) {
          out.rejected_truncated = rejectedTotal - rejected.length;
        }
      }
      return out;
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
      // But "already recorded" and "already usable" are not the same claim. If
      // the existing row no longer rehydrates, a bare `deduped: true` tells the
      // caller its finding is queued for review when in fact the row cannot be
      // listed, applied, or refused — and the deterministic id means every
      // future re-injection dedups against the same unusable bytes. Say so.
      const existingUnreadable = deduped && !db.isProposalReadable(String(id));
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
          // A COUNT, not a boolean. `tuner__propose` writes `deduped` as a
          // number under this same event name, and a chain where one key
          // holds two types is a trap for whoever queries it: `deduped > 0`
          // silently drops every boolean record, `=== true` drops every
          // numeric one. The tool's own response keeps its boolean shape —
          // this is the chain's contract, not the wire's.
          deduped: deduped ? 1 : 0,
          existing_unreadable: existingUnreadable,
        },
      });
      const out: ProposeExternalResult = {
        id: String(id),
        subject: args.subject,
        pattern_signature: sig,
        deduped,
      };
      if (existingUnreadable) out.existing_unreadable = true;
      return out;
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "pending",
    description:
      "List persisted proposals awaiting apply (status=pending). Rows that fail to " +
      "parse are reported under 'unreadable' instead of failing the listing.",
    schema: z.object({}),
    handler: (): ListResult => {
      const listing = db.listProposalsDetailed("pending");
      // `tuner__pending` IS `list(status=pending)` — same query, same rows.
      // Keying it under its own name put the tool back into a key that is
      // supposed to describe the QUERY, and produced two records with
      // byte-identical fingerprints for one degradation.
      auditStoreDegraded(audit, source, "list:pending", listing.unreadable, {}, degradedSeen);
      return toListResult(listing);
    },
  });

  bridge.registerPluginTool(GATE_PLUGIN_ID, {
    name: "list",
    description:
      "List proposals, optionally filtered by status (pending|applied|refused). Rows " +
      "that fail to parse are reported under 'unreadable' instead of failing the listing.",
    schema: ListArgs,
    handler: (args: z.infer<typeof ListArgs>): ListResult => {
      const listing = db.listProposalsDetailed(args.status);
      auditStoreDegraded(
        audit,
        source,
        // The filter IS part of the scope: `list(pending)` and `list(applied)`
        // are different questions and must not share a memory slot.
        `list:${args.status ?? "all"}`,
        listing.unreadable,
        {},
        degradedSeen,
      );
      return toListResult(listing);
    },
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
      "Counts of proposals by lifecycle status (pending/applied/refused), plus 'total' " +
      "and, when present, 'unknown_status' (rows whose status column is outside the " +
      "lifecycle union), 'unknown_status_other' (rows in such a status whose name is not " +
      "listed individually) and 'unreadable' (rows whose stored JSON could not be parsed). " +
      "pending + applied + refused + unknown_status values + unknown_status_other + " +
      "unreadable always equals 'total'. 'unknown_status_names_omitted' is a count of " +
      "status NAMES left out of 'unknown_status' and is NOT part of that sum — the rows " +
      "behind them are already counted in 'unknown_status_other'.",
    schema: z.object({}),
    handler: (): StatusResult => {
      // Per-row isolation: this walks EVERY row, including terminal ones no
      // caller will ever act on again, so one unparseable row must not be able
      // to take the whole summary down with it. Skipped rows are counted out
      // loud rather than folded into a status bucket.
      const { proposals, unreadable } = db.listProposalsDetailed();

      const counts = { pending: 0, applied: 0, refused: 0 };
      // The status COLUMN is legacy drift's other surface, and it is not
      // covered by the JSON read schema. A production store holds rows in
      // status 'rejected' — a value nothing in this codebase writes any more
      // and that `ProposalStatus` does not contain. Incrementing
      // `counts[row.status]` for it yields `undefined + 1 = NaN`, which
      // serialises over the MCP wire as `null`: a phantom bucket, three rows
      // silently missing from the totals, and no `unreadable` entry to hint
      // at it, because the row parsed perfectly well. Bucket it by name
      // instead, so an operator sees what the value is and how many.
      //
      // `Object.create(null)`, not `{}`: the keys here are status values read
      // off disk, and a plain object inherits from `Object.prototype`. A row
      // in status `toString` would make `unknownStatus[status] ?? 0` return
      // the inherited FUNCTION, `fn + 1` a string, and the reduce below
      // concatenate rather than add — so the row would vanish from the
      // summary AND suppress the degradation audit, with the response
      // looking perfectly clean. `__proto__` is worse: the assignment is
      // swallowed by the setter outright. A prototype-less map has no such
      // keys to inherit.
      const unknownStatus: Record<string, number> = Object.create(null);
      let unknownTotal = 0;
      for (const p of proposals) {
        if (isKnownProposalStatus(p.status)) {
          counts[p.status]++;
        } else {
          unknownStatus[p.status] = (unknownStatus[p.status] ?? 0) + 1;
          // Counted here rather than re-derived from the object, so the total
          // cannot disagree with the walk no matter what the keys are.
          unknownTotal++;
        }
      }
      const result: StatusResult = {
        ...counts,
        // `total` is the arithmetic the caller can check. Every row on disk
        // lands in exactly one bucket, so a summary that loses rows stops
        // adding up instead of looking clean.
        total: proposals.length + unreadable.length,
      };
      if (unknownTotal > 0) {
        // Capped by NAME, never by rows. Bounding the response cannot be
        // allowed to break the one arithmetic this summary promises: the
        // buckets must still sum to `total`, so whatever is not named
        // individually is carried in `unknown_status_other` — a row count,
        // not a key count. Reporting "5 statuses omitted" would hide however
        // many rows those statuses held, which is the silent loss this whole
        // change set exists to remove, reintroduced by a cap meant to prevent
        // a different one.
        const shown = Object.entries(unknownStatus).slice(0, MAX_DEGRADED_IDS_REPORTED);
        result.unknown_status = Object.fromEntries(shown);
        const named = shown.reduce((a, [, n]) => a + n, 0);
        if (named < unknownTotal) {
          result.unknown_status_other = unknownTotal - named;
          result.unknown_status_names_omitted = Object.keys(unknownStatus).length - shown.length;
        }
      }
      if (unreadable.length > 0) result.unreadable = unreadable.length;
      // Called unconditionally: a healthy read is what CLEARS the remembered
      // fingerprint, so a degradation that is repaired and later recurs is
      // audited again rather than matching a stale entry forever.
      auditStoreDegraded(audit, source, "status", unreadable, unknownStatus, degradedSeen);
      return result;
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
