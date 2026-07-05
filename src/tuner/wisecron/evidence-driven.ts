/**
 * evidence-driven — the SOCLE contract for proactive, evidence-backed improvement.
 *
 * Each tunable subject MAY implement `EvidenceDrivenSubject` to gain a second,
 * proactive face (alongside its reactive `detect()`): it declares WHAT to research,
 * exposes its own LOCAL signal (degradation history from telemetry/files), and
 * DECIDES from clean structured evidence + that signal whether to propose.
 *
 * Boundary (security): the subject NEVER touches the web. A separate sandboxed
 * feeder fetches untrusted sources (papers/blogs), extracts them with a strict
 * schema (anti prompt-injection), and produces `StructuredEvidence`. Only that
 * clean, verified evidence crosses into the governed tuner. Raw paper text never
 * enters the engine.
 */

/** What a subject wants researched. Declarative only — no fetching here. */
export interface ResearchSpec {
  subject: string;
  /** The topic the feeder should gather evidence on. */
  query: string;
  /** Trust tiers the feeder may use (high → low). */
  sourceTiers: Array<"enterprise" | "authoritative" | "papers" | "synthesis">;
  /** The candidate technique under evaluation (e.g. "vectorized-retrieval"). */
  technique: string;
}

/** Clean, structured evidence produced by the FEEDER (never raw paper text). */
export interface StructuredEvidence {
  technique: string;
  /** Count of INDEPENDENT confirmations (the core of "faisceau de preuves"). */
  independentSources: number;
  /** Subset coming from enterprise/authoritative tiers (highest trust). */
  highTrustSources: number;
  /** Demonstrated-elsewhere flag: proven in a production system, not just a paper. */
  provenInProduction: boolean;
  /** Claimed gain, verbatim from the source (e.g. "recall +13pp"). */
  claimedGain?: string;
  /** The condition under which the technique helps (for applicability matching). */
  applicableWhen?: string;
  /** Source URLs — the audit trail. */
  citations: string[];
}

/** A subject's local signal, read from telemetry/files. The degradation history. */
export interface LocalSignal {
  metric: string;
  value: number;
  unit: string;
  /** Has the metric crossed the subject's own degradation threshold? */
  degraded: boolean;
  /** Direction over the recent history window. */
  trend: "improving" | "stable" | "degrading";
  sampledAt: string;
}

/** The subject's decision, given evidence + signal. */
export interface EvidenceVerdict {
  propose: boolean;
  reason: string;
  /**
   * How the improvement is delivered — this drives the proactive router:
   *   • `patch` = a CONTENT/CONFIG change the subject applies itself, in its own
   *     confined dir (e.g. rewriting a skill description). A normal gated patch —
   *     NO plugin. The subject must implement `proposeEvidencePatch`.
   *   • `recommendation` = an ARCHITECTURAL capability (e.g. vectorised retrieval)
   *     the subject cannot deliver as content. It resolves to a gated PLUGIN
   *     install (technique-plugin-registry) or, if no plugin maps it, a
   *     detect-only note. NEVER engine code.
   */
  kind: "patch" | "recommendation";
  /** 0..1, from convergence × applicability × signal severity. */
  confidence: number;
}

/** A concrete, evidence-backed content patch the subject will apply (kind="patch"). */
export interface EvidencePatch {
  /** File the subject will write — must be inside the subject's own managed dir. */
  target_path: string;
  alternatives: Array<{ id: string; label: string; diff_or_content: string; tradeoff: string }>;
}

/**
 * Implemented by each subject that supports proactive, evidence-backed improvement.
 * The proactive cycle drives it; the feeder supplies the StructuredEvidence.
 */
export interface EvidenceDrivenSubject {
  /** Subject id (matches BaseSubject.name). */
  readonly name: string;
  /** Declare what to research (the feeder fetches; the subject never touches the web). */
  researchSpec(): ResearchSpec;
  /** Read the subject's own local signal (degradation history) from telemetry/files. */
  localSignal(): Promise<LocalSignal>;
  /** Decide, from CLEAN structured evidence + the local signal, whether/what to propose. */
  evaluate(evidence: StructuredEvidence, signal: LocalSignal): EvidenceVerdict;
  /**
   * For a `kind:"patch"` verdict: build the concrete CONTENT patch the subject
   * will apply itself (gated, in its own dir — never a plugin, never engine code).
   * Returns null when nothing actionable is found. Required only for subjects
   * whose evaluate() can return `kind:"patch"`.
   */
  proposeEvidencePatch?(
    evidence: StructuredEvidence,
    signal: LocalSignal,
  ): Promise<EvidencePatch | null>;
  /** After an apply, re-read the signal to confirm the change actually helped. */
  confirm(before: LocalSignal): Promise<boolean>;
}

/** Default convergence gate: enough independent + some high-trust + applicable. */
export function meetsEvidenceBar(
  e: StructuredEvidence,
  opts: { minIndependent?: number; minHighTrust?: number } = {},
): boolean {
  const minInd = opts.minIndependent ?? 3;
  const minHigh = opts.minHighTrust ?? 1;
  return e.independentSources >= minInd && (e.highTrustSources >= minHigh || e.provenInProduction);
}
