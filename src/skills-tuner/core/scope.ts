/**
 * Tuning scope — the operator's control over the tuner's blast radius.
 *
 * The tuner operates on the GENERAL Claude Code surface (`~/.claude/*` config +
 * ALL session transcripts), so a change reaches the operator's whole Claude Code
 * setup, not just the autonomous agent. Some deployments must NOT grant that. So
 * scope is an explicit, audited product control, not an implementation detail:
 *
 *   - `all`   (default) — tune everything. scan_dirs span `~/.claude/*` and every
 *                         telemetry stream is read unfiltered. The current,
 *                         backward-compatible behaviour.
 *   - `agent` — restrict every subject to the AGENT's own surface: its skills /
 *               hooks / agents dirs under `~/agent/*`, and telemetry filtered to
 *               agent-originated rows (agent sessions, cron/cost rows the agent
 *               produced). A change can then only touch what the agent owns.
 *
 * Scope is set globally and may be overridden per subject. The effective scope of
 * a subject is `per-subject ?? global ?? all`. Subjects never read raw sources —
 * they only call `provider.query(...)`, so agent-scoping a stream is done by the
 * single `ScopedTelemetryProvider` wrapper here (inject filters + post-filter by
 * an attribution predicate), keeping every subject scope-agnostic.
 *
 * AMBIGUITY (flagged, see `defaultAgentSurface`): on a single-operator host the
 * agent and the general user share the same home, so "the agent's surface" cannot
 * always be cleanly separated from the general one by path or label alone. Where
 * it can't, we take the CONSERVATIVE bound (narrow — never tune outside the
 * agent) and document it on the relevant field/predicate below.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import type {
  DateRange,
  MetricSample,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
} from "./telemetry.js";

export const SCOPES = ["all", "agent"] as const;
export type Scope = (typeof SCOPES)[number];

/** Default when neither a per-subject nor a global scope is set: optimise everything. */
export const DEFAULT_SCOPE: Scope = "all";

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

/**
 * Effective scope of a subject: per-subject override wins over the global setting,
 * which wins over the `all` default. Mirrors the `subjectConfig` precedence rule.
 */
export function resolveScope(global: Scope | undefined, perSubject: Scope | undefined): Scope {
  return perSubject ?? global ?? DEFAULT_SCOPE;
}

/**
 * The concrete definition of "the agent's surface" — what `agent` scope restricts
 * to. Conservative by construction: every field names a STRICT SUBSET of the
 * general surface, so an `agent`-scoped subject can only ever see less than an
 * `all`-scoped one.
 */
export interface AgentSurface {
  /** Filesystem roots the agent owns; scan_dirs + file-labelled samples are bounded to these. */
  roots: string[];
  /** The agent's skills dir(s) — the SkillsSubject scan surface under `agent` scope. */
  skillsDirs: string[];
  /**
   * Encoded `~/.claude/projects/<enc-cwd>` dir-name prefixes that hold agent
   * sessions. Session-derived streams (tool_call / agent_dispatch / memory_access)
   * are restricted to transcripts under these dirs.
   */
  sessionProjectDirs: string[];
  /**
   * Substrings that mark a `session_cost` / `cron_run` row as agent-originated
   * (matched against the `job` / `unit` label). The cost store's `job` is
   * free-text, so attribution is substring-based, mirroring CronSubject.costJobMatch.
   *
   * MUST be AGENT-SPECIFIC markers only (e.g. the bus-scheduler tag the agent's
   * own cron jobs carry, or the agent root path a unit name is anchored under).
   * A GENERIC tag every cron row carries (e.g. `source="cron"`) does NOT narrow
   * anything — it attributes the whole cron/cost stream to the agent, defeating
   * the scope. Empty markers are ignored (they would match every row).
   */
  jobMarkers: string[];
}

/**
 * Claude Code encodes a project cwd into a `~/.claude/projects` dir name by
 * replacing path separators and dots with `-` (e.g. `/home/user/agent` →
 * `-home-user-agent`). We match dir-name PREFIXES with this, so a deeper agent
 * cwd still resolves under its root.
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

/**
 * Default agent surface for a host whose agent lives under `~/agent` (the
 * The agent layout in this repo: `~/agent/skills`, `~/agent/agents`, cron jobs the
 * agent schedules via the bus-scheduler).
 *
 * FLAGGED AMBIGUITY — agent sessions: the autonomous agent and interactive Claude
 * Code sessions can both run with cwd `~` (project dir `-home-user`), which would
 * make the two indistinguishable by directory. We therefore bound agent sessions
 * to project dirs encoding a path UNDER `~/agent` (a strict subset). If the agent
 * actually runs from `~`, this UNDER-includes its sessions — the conservative
 * direction (we never tune on general-surface sessions), but it means agent-scoped
 * session fitness may see fewer rows than truly exist. Override `sessionProjectDirs`
 * when the deployment pins the agent to a dedicated cwd.
 */
export function defaultAgentSurface(home: string = homedir()): AgentSurface {
  const agentRoot = join(home, "agent");
  return {
    roots: [agentRoot],
    skillsDirs: [join(agentRoot, "skills")],
    sessionProjectDirs: [encodeProjectDir(agentRoot)],
    // AGENT-SPECIFIC markers only. `bus-scheduler` is the tag the agent's own
    // cron jobs carry; `agentRoot` matches a unit/job label anchored under the
    // agent's home. The generic `source="cron"` tag was REMOVED — nearly every
    // cron row carries it, so including it attributed the entire cron/cost
    // stream to the agent and made `scope: agent` a no-op for those streams.
    jobMarkers: ["bus-scheduler", agentRoot],
  };
}

// ── Telemetry filter keys ─────────────────────────────────────────────────────
//
// `provider.query` carries scope hints in its `filters` map (a `Record<string,
// string>`), so a scope-aware producer can self-restrict at the source (e.g. the
// session producer scans only agent project dirs). Keys are namespaced so they
// never collide with a real label filter.

/** Filter key carrying the active scope ("agent"); absent ⇒ "all" (no restriction). */
export const SCOPE_FILTER_KEY = "__scope";
/** Filter key carrying a comma-joined list of agent session-project-dir prefixes. */
export const AGENT_SESSION_DIRS_FILTER_KEY = "__agent_session_dirs";

/**
 * Label a scope-aware producer stamps on the samples it returns to ATTEST that
 * it already restricted them to the agent surface at the source (e.g. after
 * honouring the `__agent_session_dirs` hint). This is the explicit ack that lets
 * a stream WITHOUT a label-based attribution predicate still pass agent scope —
 * instead of failing closed. Value must equal the active scope ("agent").
 */
export const SCOPE_ACK_LABEL = "__scoped";

/**
 * Streams whose returned samples carry a REAL, label-based agent-attribution
 * predicate applied post-hoc in `sampleInAgentScope`. These narrow by data.
 */
export const PREDICATE_STREAMS: ReadonlySet<TelemetryStream> = new Set<TelemetryStream>([
  "session_cost",
  "cron_run",
  "memory_access",
]);

/**
 * Streams narrowed at the SOURCE by the injected `__agent_session_dirs` filter,
 * whose host producer (`SessionJsonlTelemetryProducer`) is known to honour it:
 * the rows it returns are already agent-only, so a post-filter would be
 * redundant. This is a CLOSED allowlist — any stream not named here and lacking
 * a predicate fails closed rather than being kept.
 */
export const SOURCE_SCOPED_STREAMS: ReadonlySet<TelemetryStream> = new Set<TelemetryStream>([
  "tool_call",
  "agent_dispatch",
]);

/** True when `file` lives at or under one of `roots` on a path-SEGMENT boundary
 * (so root `/home/user/agent` does NOT match `/home/user/agent-backup/...`). */
function fileUnderRoot(file: string, roots: readonly string[]): boolean {
  if (file === "") return false;
  return roots.some((r) => {
    if (r === "") return false;
    const root = r.endsWith(sep) ? r.slice(0, -1) : r;
    return file === root || file.startsWith(root + sep);
  });
}

/**
 * Per-stream agent-attribution predicate applied to a sample AFTER the inner
 * provider returns it. Decides whether `sample` belongs to the agent surface.
 * FAILS CLOSED: a sample is kept only when it can be POSITIVELY attributed.
 *
 *  - `session_cost` / `cron_run` — attributed by a job/unit-label substring match
 *    against `surface.jobMarkers` (agent-specific markers only). Real narrowing.
 *  - `memory_access` — attributed by `file` label living under an agent root,
 *    matched on a path-segment boundary (see `fileUnderRoot`).
 *  - `tool_call` / `agent_dispatch` (SOURCE_SCOPED_STREAMS) — already narrowed
 *    upstream by the injected session-dir filter, whose producer honours it, so
 *    they are kept without a post-filter.
 *  - everything else (hook_exec / skill_access / template_feedback /
 *    mode_dispatch / mcp.tool_call …) — carries NO agent-vs-general signal in its
 *    labels AND is not a trusted source-scoped stream. Previously these were
 *    KEPT (return true), which made `scope: agent` a SILENT NO-OP whenever the
 *    producer ignored the injected hint (e.g. the mode-dispatch reader). Now they
 *    fail CLOSED — DROPPED unless the producer stamped the explicit
 *    `SCOPE_ACK_LABEL` ack asserting it already scoped the row itself.
 */
export function sampleInAgentScope(
  stream: TelemetryStream,
  sample: MetricSample,
  surface: AgentSurface,
): boolean {
  const labels = sample.labels ?? {};
  switch (stream) {
    case "session_cost":
    case "cron_run": {
      const hay = `${labels.job ?? ""} ${labels.unit ?? ""}`;
      return surface.jobMarkers.some((m) => m !== "" && hay.includes(m));
    }
    case "memory_access":
      return fileUnderRoot(labels.file ?? "", surface.roots);
    default:
      // Trusted source-scoped streams were already narrowed at the producer.
      if (SOURCE_SCOPED_STREAMS.has(stream)) return true;
      // No predicate + not source-scoped ⇒ fail closed. A producer that scoped
      // the row itself opts in by echoing the ack label.
      return labels[SCOPE_ACK_LABEL] === "agent";
  }
}

/**
 * Scope-aware decorator over a host `TelemetryProvider`. For `all` scope it is a
 * pure pass-through. For `agent` scope it (1) injects scope hints into the
 * `filters` map so scope-aware producers self-restrict at the source, and (2)
 * post-filters the returned samples through `sampleInAgentScope`. Subjects still
 * only ever call `query(...)` — they never learn they were scoped.
 *
 * `capabilities()` is intentionally NOT scoped: stream availability answers "can
 * this environment emit this stream at all", which is a host property, not a
 * per-subject one. Scope narrows the DATA a subject sees, not which streams exist.
 */
export class ScopedTelemetryProvider implements TelemetryProvider {
  constructor(
    private readonly inner: TelemetryProvider,
    private readonly scope: Scope,
    private readonly surface: AgentSurface,
  ) {}

  contractVersion(): string {
    return this.inner.contractVersion();
  }

  capabilities(): TelemetryCapability[] {
    return this.inner.capabilities();
  }

  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    if (this.scope === "all") {
      return this.inner.query(stream, range, filters);
    }
    const scoped: Record<string, string> = {
      ...(filters ?? {}),
      [SCOPE_FILTER_KEY]: "agent",
      [AGENT_SESSION_DIRS_FILTER_KEY]: this.surface.sessionProjectDirs.join(","),
    };
    const samples = await this.inner.query(stream, range, scoped);
    return samples.filter((s) => sampleInAgentScope(stream, s, this.surface));
  }
}

/**
 * Resolves + applies scope for a set of subjects. Built once at registration from
 * the global + per-subject config and the host's agent surface; handed to the
 * OutcomeRecorder so each subject's `measureFitness` reads a provider scoped to
 * ITS effective scope. `snapshot()` produces the record written to the audit chain.
 */
export class ScopeResolver {
  constructor(
    private readonly global: Scope,
    private readonly perSubject: Readonly<Record<string, Scope>>,
    readonly surface: AgentSurface,
  ) {}

  /** Effective scope for a subject (per-subject override ?? global ?? all). */
  for(subjectName: string): Scope {
    return resolveScope(this.global, this.perSubject[subjectName]);
  }

  /** Wrap `inner` so the subject sees only its in-scope telemetry. Identity for `all`. */
  scopedProvider(subjectName: string, inner: TelemetryProvider): TelemetryProvider {
    const scope = this.for(subjectName);
    return scope === "all" ? inner : new ScopedTelemetryProvider(inner, scope, this.surface);
  }

  /**
   * Provenance snapshot for the audit chain: the active global scope plus the
   * effective scope of each named subject. An auditor reads "the tuner operated
   * at scope=X (subject Y at Z)" from one record.
   */
  snapshot(subjectNames: readonly string[]): {
    global: Scope;
    per_subject: Record<string, Scope>;
  } {
    const per_subject: Record<string, Scope> = {};
    for (const name of subjectNames) per_subject[name] = this.for(name);
    return { global: this.global, per_subject };
  }
}
