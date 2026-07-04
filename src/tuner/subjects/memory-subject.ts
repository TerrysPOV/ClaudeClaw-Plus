import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { RevertibleSubject } from "../wisecron/types.js";
import { renderDiff } from "../wisecron/render-diff.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { median } from "../../skills-tuner/core/aggregate.js";
import {
  type EvidenceDrivenSubject,
  type ResearchSpec,
  type LocalSignal,
  type StructuredEvidence,
  type EvidenceVerdict,
  meetsEvidenceBar,
} from "../wisecron/evidence-driven.js";
import { measureMemorySignal, loadHistory, trendOf } from "./memory-signal.js";

/** Memory load cost (ms) above which the index is "slow". */
const MEMORY_MAX_LOAD_MS = 50;
/** Dead-pointer ratio above which memory hygiene is degraded. */
const MEMORY_MAX_DEAD_RATIO = 0.05;
/** Only treat index GROWTH as degradation once the index is genuinely sizable. */
const MEMORY_SIZE_FLOOR = 18_000;

/** Derive Claude Code's per-user memory index location.
 * Mirrors Claude Code's pattern: `~/.claude/projects/-home-<basename>/memory/MEMORY.md`.
 */
function defaultMemoryIndex(): string {
  const home = homedir();
  const slug = `-home-${basename(home)}`;
  return `${home}/.claude/projects/${slug}/memory/MEMORY.md`;
}

const MAX_INDEX_LINES = 200;
/** One-line budget per index entry (CLAUDE.md memory spec ~200 chars). */
const MAX_INDEX_LINE_CHARS = 200;
const HEADER = "# Memory Index";

/** A memory index starts with the "# Memory Index" header OR (headerless live format) a "- [" entry. */
function hasValidIndexStart(content: string): boolean {
  const first = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.startsWith(HEADER) || first.startsWith("- [");
}

/** One `.md` pointer of an entry line, or null if not exactly one. */
function entryPointer(line: string): string | null {
  const m = [...line.matchAll(/\]\(([^)]+\.md)\)/g)].map((x) => x[1]);
  return m.length === 1 ? (m[0] as string) : null;
}

/**
 * Reconcile a proposed (possibly stale) index against the LIVE index. Iterate
 * the LIVE lines so no current entry is ever dropped: reuse the proposed
 * shortened line where the entry still exists (by pointer), else deterministically
 * shorten the new/changed live line. Non-entry lines come from live. Result's
 * pointer set == live's pointer set (no loss), with propose-time shortening kept.
 */
function reconcileToLive(snapshot: string, live: string): string {
  const shortByPtr = new Map<string, string>();
  for (const l of snapshot.split("\n")) {
    if (!l.startsWith("- [")) continue;
    const p = entryPointer(l);
    if (p) shortByPtr.set(p, l);
  }
  const liveLines = live.split("\n");
  // Count live pointer occurrences so a duplicated slug never collapses two
  // distinct live lines into one snapshot line (L1).
  const ptrCount = new Map<string, number>();
  for (const l of liveLines) {
    if (!l.startsWith("- [")) continue;
    const p = entryPointer(l);
    if (p) ptrCount.set(p, (ptrCount.get(p) ?? 0) + 1);
  }
  return liveLines
    .map((l) => {
      if (!l.startsWith("- [")) return l;
      // Within budget → KEEP the live line verbatim. This preserves any edit the
      // operator made between propose-time and approve-time (M4): only over-budget
      // lines are touched, and shortening is exactly what needs doing there.
      if (l.length <= MAX_INDEX_LINE_CHARS) return l;
      const p = entryPointer(l);
      // Over-budget + a UNIQUE pointer → use the proposed shortened line;
      // duplicated pointers shorten each occurrence individually (no collapse).
      if (p && (ptrCount.get(p) ?? 0) === 1 && shortByPtr.has(p))
        return shortByPtr.get(p) as string;
      return shortenIndexLine(l);
    })
    .join("\n");
}

/** Deterministic shrink of one over-long index line: keep the link, trim the hook to budget. */
function shortenIndexLine(line: string): string {
  if (!line.startsWith("- [") || line.length <= MAX_INDEX_LINE_CHARS) return line;
  const m = line.match(/^(- \[[^\]]*\]\([^)]+\.md\)\s*—\s*)([\s\S]*)$/);
  if (!m) return `${line.slice(0, MAX_INDEX_LINE_CHARS - 1)}…`;
  const head = m[1] as string;
  const budget = MAX_INDEX_LINE_CHARS - head.length - 1;
  if (budget <= 0) return `${line.slice(0, MAX_INDEX_LINE_CHARS - 1)}…`;
  const hook = (m[2] as string).slice(0, budget).replace(/\s+\S*$/, "");
  return `${head}${hook}…`;
}
// `- [Title](file.md) — hook` shape — em-dash or ASCII hyphen separator.
const ENTRY_RE = /^- \[([^\]]+)\]\(([^)]+\.md)\)(?:\s+[—-]\s+(.+))?$/;

interface MemoryEntry {
  raw: string;
  title: string;
  file: string;
  hook: string | null;
}

/**
 * MemorySubject — wisecron-managed MEMORY.md index tuner (LOW).
 *
 * What it tunes: MEMORY.md (auto-memory index) at
 * `~/.claude/projects/-home-<user>/memory/MEMORY.md`. Detects:
 *  - duplicate entries (same slug or near-duplicate description)
 *  - dead entries (referenced .md file no longer exists)
 *  - stale ordering (most-referenced entries should be on top)
 *  - bloated index (>200 lines per CLAUDE.md spec)
 *
 * Telemetry: count of memory file reads per UserPromptSubmit hook log.
 * Risk class: LOW — index reorder/dedup, no content removed from per-file
 * memory bodies (only the index pointers shift).
 */
export interface MemorySubjectConfig {
  llm?: LLMClient;
  /** Path to MEMORY.md index. */
  memoryIndex?: string;
  /** UserPromptSubmit hook log for read-frequency telemetry. */
  hookLog?: string;
  /** Path to the memory-signal sampler history (the local degradation signal). */
  signalHistoryPath?: string;
  /** Path to the entry-quality judge cache (LLM-judged, sampled, cached). */
  qualityCachePath?: string;
}

export class MemorySubject extends BaseSubject implements RevertibleSubject, EvidenceDrivenSubject {
  readonly name = "memory";
  readonly risk_tier = "low" as const;
  readonly auto_merge_default = true;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly memoryIndex: string;
  private readonly hookLog?: string;
  private readonly signalHistoryPath: string;
  private readonly qualityCachePath: string;

  constructor(opts: MemorySubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    // Expand a leading `~` (config files pass `~/.claude/...`; without this
    // existsSync(this.memoryIndex) is false and collectObservations returns
    // [] -> the subject silently produces 0 observations).
    this.memoryIndex = (opts.memoryIndex ?? defaultMemoryIndex()).replace(/^~(?=\/|$)/, homedir());
    this.hookLog = opts.hookLog;
    this.signalHistoryPath = (
      opts.signalHistoryPath ?? `${homedir()}/.config/tuner/memory-signal-history.jsonl`
    ).replace(/^~(?=\/|$)/, homedir());
    this.qualityCachePath = (
      opts.qualityCachePath ?? `${homedir()}/.config/tuner/memory-quality-cache.json`
    ).replace(/^~(?=\/|$)/, homedir());
  }

  // ── Proactive face: EvidenceDrivenSubject (faisceau de preuves + signal local) ──

  researchSpec(): ResearchSpec {
    return {
      subject: "memory",
      query: "agent long-term memory scaling vectorized retrieval RAG forgetting curve",
      sourceTiers: ["enterprise", "authoritative", "papers"],
      technique: "vectorized-retrieval",
    };
  }

  /** The local degradation signal: load latency (primary), with size/dead-ratio. */
  async localSignal(): Promise<LocalSignal> {
    const current = measureMemorySignal(this.memoryIndex, new Date().toISOString());
    const history = [...loadHistory(this.signalHistoryPath), current];
    // Drive the trend off a STABLE metric (index size) with a 1KB noise floor — NOT
    // sub-millisecond load latency, which is pure FS jitter on a small file.
    const trend = trendOf(history, (sample) => sample.bytes, 0.1, 1000);
    const degraded =
      current.deadRatio > MEMORY_MAX_DEAD_RATIO ||
      (trend === "degrading" && current.bytes > MEMORY_SIZE_FLOOR) ||
      current.loadMs > MEMORY_MAX_LOAD_MS;
    return {
      metric: "memory_load_ms",
      value: current.loadMs,
      unit: "ms",
      degraded,
      trend,
      sampledAt: current.ts,
    };
  }

  /**
   * Decide from CLEAN structured evidence (from the feeder) + the local signal.
   * An architectural technique (e.g. vectorized retrieval) is a detect-only
   * RECOMMENDATION carrying its proof — never an auto-applied infra change.
   */
  evaluate(evidence: StructuredEvidence, signal: LocalSignal): EvidenceVerdict {
    if (!signal.degraded) {
      return {
        propose: false,
        reason: `memory signal healthy (${signal.metric}=${signal.value}${signal.unit}, ${signal.trend})`,
        kind: "recommendation",
        confidence: 0,
      };
    }
    if (!meetsEvidenceBar(evidence)) {
      return {
        propose: false,
        reason: `evidence below bar for '${evidence.technique}' (${evidence.independentSources} independent, ${evidence.highTrustSources} high-trust)`,
        kind: "recommendation",
        confidence: 0.2,
      };
    }
    // Confidence = convergence (clamped). meetsEvidenceBar already guarantees a
    // high-trust/prod source, so a separate trustBoost factor would be a no-op (L2).
    const confidence = Math.round(Math.min(1, evidence.independentSources / 5) * 100) / 100;
    return {
      propose: true,
      reason: `memory degrading (${signal.trend}, ${signal.value}${signal.unit}) + ${evidence.independentSources} independent sources for '${evidence.technique}'${evidence.provenInProduction ? " (proven in production)" : ""}`,
      kind: "recommendation",
      confidence,
    };
  }

  /** Post-apply confirmation: re-read the signal — did latency improve? */
  async confirm(before: LocalSignal): Promise<boolean> {
    const after = await this.localSignal();
    return after.value < before.value;
  }

  async collectObservations(_since: Date): Promise<Observation[]> {
    if (!existsSync(this.memoryIndex)) return [];
    // Out-of-band, best-effort: refresh the LLM entry-quality cache if it's stale
    // (gated on an LLM being configured → dormant + zero cost by default).
    await this.refreshQualityIfStale();
    const content = readFileSync(this.memoryIndex, "utf8");
    const entries = parseEntries(content);
    if (entries.length === 0) return [];

    const memoryDir = dirname(this.memoryIndex);
    const observations: Observation[] = [];
    const now = new Date();

    const slugCounts = new Map<string, number>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }

    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      const refPath = resolve(memoryDir, e.file);
      const dead = !existsSync(refPath);
      const duplicate = (slugCounts.get(slug) ?? 0) > 1;
      if (!dead && !duplicate) continue;

      const issues: string[] = [];
      if (dead) issues.push("dead_ref");
      if (duplicate) issues.push("duplicate_slug");

      observations.push({
        session_id: `memory-${slug}-${now.getTime()}`,
        observed_at: now,
        signal_type: dead ? "orphan" : "repeated_trigger",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            slug,
            file: e.file,
            title: e.title,
            issues,
          }),
          500,
        ),
        metadata: {
          subject: "memory",
          slug,
          file: e.file,
          dead,
          duplicate,
        },
      });
    }

    // Verbose-index signal: entries over the one-line budget bloat the per-session
    // context cost. Emit one observation so a shrink is proposed even with 0 dead/dup.
    const longLines = content.split("\n").filter((l) => l.length > MAX_INDEX_LINE_CHARS).length;
    if (longLines > 0) {
      observations.push({
        session_id: `memory-verbose-${now.getTime()}`,
        observed_at: now,
        signal_type: "correction",
        verbatim: sanitizeObservationContent(
          JSON.stringify({ longLines, bytes: content.length }),
          200,
        ),
        metadata: { subject: "memory", verbose: true, longLines, bytes: content.length },
      });
    }

    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    return [
      {
        id: "memory-index-cleanup",
        subject: "memory",
        observations,
        frequency: observations.length,
        success_rate: 0.5,
        sentiment: "neutral",
        subjects_touched: ["memory"],
      },
    ];
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    if (!existsSync(this.memoryIndex)) {
      throw new Error("memory-subject.proposeChange: index missing");
    }
    const current = readFileSync(this.memoryIndex, "utf8");
    const dedupDead = applyStrategy(current, this.memoryIndex, "dedup-dead");
    const dedupReorder = applyStrategy(current, this.memoryIndex, "dedup-reorder");
    // Shrink: rewrite over-long entries to one line each (LLM, deterministic
    // fallback). Unknown-strategy id → apply() writes this content verbatim.
    const shrunk = await this.rewriteShort(current);

    // Emit unified diffs (≤2KB each) so the three alternatives stay visually
    // distinct in adapter surfaces. apply() re-runs the strategy against the
    // live file rather than blindly writing what's in diff_or_content.
    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "memory",
      kind: "patch",
      target_path: this.memoryIndex,
      alternatives: [
        {
          id: "shrink",
          label: "Shrink: rewrite over-long entries to one line (detail stays in topics)",
          diff_or_content: shrunk,
          tradeoff:
            "Cuts per-session context cost + long-line count toward 0; keeps every entry + link.",
        },
        {
          id: "dedup-dead",
          label: "Dedup + remove dead refs",
          diff_or_content: renderDiff(current, dedupDead, {
            fromLabel: "MEMORY.md",
            toLabel: "MEMORY.md (dedup-dead)",
          }),
          tradeoff: "Smallest diff, removes only confirmed-dead pointers.",
        },
        {
          id: "dedup-reorder",
          label: "Dedup + reorder alphabetically",
          diff_or_content: renderDiff(current, dedupReorder, {
            fromLabel: "MEMORY.md",
            toLabel: "MEMORY.md (dedup-reorder)",
          }),
          tradeoff: "Easier visual scan; reorder churn in git blame.",
        },
      ],
      pattern_signature: `memory:dedup:${parseEntries(current).length}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    if (proposal.target_path !== this.memoryIndex) {
      throw new Error(
        `memory-subject.apply: target_path mismatch (${proposal.target_path} vs ${this.memoryIndex})`,
      );
    }
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw new Error(`memory-subject.apply: alternative ${alternativeId} not found`);

    const current = existsSync(this.memoryIndex) ? readFileSync(this.memoryIndex, "utf8") : "";
    // A KNOWN strategy id -> re-run the strategy on the live index (the alternative's
    // diff_or_content is then an informational unified diff, NOT content to write).
    // An UNKNOWN id -> an external/research proposal carrying the full new index in
    // diff_or_content. validate() gates the result either way.
    let newContent: string;
    if (isKnownStrategy(alternativeId)) {
      newContent = applyStrategy(current, this.memoryIndex, alternativeId);
    } else {
      const explicit = (alt as { diff_or_content?: string }).diff_or_content;
      if (typeof explicit !== "string" || explicit.trim().length === 0) {
        throw new Error(
          `memory-subject.apply: unknown strategy '${alternativeId}' and no diff_or_content`,
        );
      }
      // Accept both the "# Memory Index" header AND the headerless entry-first
      // format the live auto-memory files actually use.
      if (!hasValidIndexStart(explicit)) {
        throw new Error(
          "memory-subject.apply: external content is not a memory index (no header/entry start)",
        );
      }
      // Reconcile the (possibly stale) proposed index against the LIVE index at
      // APPLY time: the proposal froze a snapshot at propose-time, but the user
      // may have edited the memory before tapping Approve. Keep every current
      // entry — using the proposed shortened line where the entry still exists,
      // and deterministically shortening any new/changed entry — so Approve
      // always succeeds on the current state and NEVER drops a live pointer.
      newContent = reconcileToLive(explicit, current);
      const memDir = dirname(this.memoryIndex);
      const liveBefore = [...current.matchAll(/\]\(([^)]+\.md)\)/g)]
        .map((m) => m[1] as string)
        .filter((file) => existsSync(resolve(memDir, file)));
      const afterPtrs = new Set(
        [...newContent.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1] as string),
      );
      const dropped = liveBefore.filter((file) => !afterPtrs.has(file));
      // After reconciliation this should never fire; kept as a hard safety net.
      if (dropped.length > 0) {
        throw new Error(
          `memory-subject.apply: reconciled content still drops ${dropped.length} live pointer(s): ${dropped.slice(0, 3).join(", ")}`,
        );
      }
    }

    // M3: refuse to operate on a symlinked index (defence-in-depth — the rename
    // below replaces the link rather than following it, but a planted symlink
    // still signals tampering).
    if (existsSync(this.memoryIndex) && lstatSync(this.memoryIndex).isSymbolicLink()) {
      throw new Error(`memory-subject.apply: index is a symlink, refusing: ${this.memoryIndex}`);
    }
    if (existsSync(this.memoryIndex)) {
      copyFileSync(this.memoryIndex, `${this.memoryIndex}.bak`);
    }
    // Atomic: write a temp then rename so a mid-write failure can't truncate the index.
    const tmpPath = `${this.memoryIndex}.tmp`;
    writeFileSync(tmpPath, newContent, "utf8");
    renameSync(tmpPath, this.memoryIndex);

    return {
      target_path: this.memoryIndex,
      kind: "patch",
      applied_content: newContent,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    const content = patch.applied_content;
    if (!hasValidIndexStart(content)) {
      return {
        valid: false,
        reason: `not a memory index (no "${HEADER}" header or "- [" entry start)`,
      };
    }
    const lines = content.split("\n");
    if (lines.length > MAX_INDEX_LINES) {
      return { valid: false, reason: `index exceeds ${MAX_INDEX_LINES} lines (${lines.length})` };
    }
    const memoryDir = dirname(this.memoryIndex);
    for (const line of lines) {
      if (!line.startsWith("- ")) continue;
      const m = line.match(ENTRY_RE);
      if (!m) return { valid: false, reason: `malformed entry: ${line}` };
      const file = m[2]!;
      if (file.includes("..") || file.startsWith("/")) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
      const resolved = resolve(memoryDir, file);
      if (!resolved.startsWith(`${memoryDir}/`) && resolved !== memoryDir) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    if (inversePatch.target_path !== this.memoryIndex) {
      throw new Error(`memory-subject.revert: target_path mismatch`);
    }
    writeFileSync(this.memoryIndex, inversePatch.applied_content, "utf8");
  }

  /**
   * OutcomeLoop fitness for the memory subject (LOW risk).
   *
   * Target — `memory_median_reads_per_entry` (Tier 1, `memory_access`): the
   * typical index entry's read frequency (median per-entry access count over the
   * window). Higher is better — a well-curated index gets used. Median, so one
   * hot entry can't dominate. The gameable shortcut is to delete entries to lift
   * the per-entry median, so it is guarded by `memory_index_entry_count`
   * (Tier 1b artifact, higher_is_better). `memory_index_defect_count`
   * (Tier 1b artifact): always-on scan for dead-ref + duplicate-slug entries.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "memory_median_reads_per_entry",
        source: "memory_access",
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
        guardrails: ["memory_index_entry_count"],
      },
      {
        name: "memory_index_defect_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
      },
      {
        name: "memory_index_entry_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
      {
        // Context tax: MEMORY.md loads into context EVERY session, so its token
        // footprint is a recurring cost. Lower is better. Gameable by deleting
        // entries → guarded by memory_index_entry_count (higher_is_better).
        name: "memory_index_context_cost",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
        guardrails: ["memory_index_entry_count"],
      },
      {
        // Entry-verbosity defect: index lines over the one-line budget
        // (~200 chars). Lower is better; the shrink strategy drives it to 0
        // without dropping entries (entry_count guardrail).
        name: "memory_index_long_line_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
        guardrails: ["memory_index_entry_count"],
      },
      {
        // Semantic quality: an LLM judge rates a SAMPLE of entries 1–5 for
        // clarity+specificity+actionability; the median is cached (sampled by a
        // refresh, not measured inline — measureFitness stays fast). Higher is
        // better. The anti-Goodhart pair to context_cost: shrinking must not
        // gut the entries' usefulness.
        name: "memory_entry_quality",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Telemetry read ONLY via `provider.query("memory_access", …)`; aggregated as
   * a median of per-entry read counts (outlier-robust). Artifact metrics parse
   * the managed index and are omitted only when the index file is absent.
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: memory_access stream (one sample per read, labels.file) ─────
    const samples = await provider.query("memory_access", range);
    if (samples.length > 0) {
      const perFile = new Map<string, number>();
      for (const s of samples) {
        const file = s.labels?.file ?? "unknown";
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
      }
      out.memory_median_reads_per_entry = median([...perFile.values()]);
    }

    // ── Tier 1b: artifact scan of the index ─────────────────────────────────
    const scan = this.scanIndex();
    if (scan !== null) {
      out.memory_index_entry_count = scan.entries;
      out.memory_index_defect_count = scan.defects;
      out.memory_index_context_cost = scan.contextCostTokens;
      out.memory_index_long_line_count = scan.longLines;
    }

    // ── Tier 2: cached LLM entry-quality (judged out-of-band; read fast here) ─
    const q = this.readQualityCache();
    if (q !== null) out.memory_entry_quality = q;

    return out;
  }

  /** Read the cached median entry-quality (1–5), or null if absent/malformed. */
  private readQualityCache(): number | null {
    if (!existsSync(this.qualityCachePath)) return null;
    try {
      const c = JSON.parse(readFileSync(this.qualityCachePath, "utf8"));
      return typeof c.median === "number" ? c.median : null;
    } catch {
      return null;
    }
  }

  /**
   * Wire for the quality judge: refresh the cache if older than `maxAgeDays`.
   * Gated on an LLM being configured (default: none → no-op, zero cost), so the
   * judge is reachable from the normal cycle without adding cost by default.
   */
  private async refreshQualityIfStale(maxAgeDays = 7): Promise<void> {
    if (!this.llm) return;
    try {
      if (existsSync(this.qualityCachePath)) {
        const ageMs = Date.now() - statSync(this.qualityCachePath).mtimeMs;
        let cooldownMs = maxAgeDays * 86_400_000;
        try {
          const c = JSON.parse(readFileSync(this.qualityCachePath, "utf8"));
          if (c && c.failed === true) cooldownMs = 6 * 3_600_000; // short retry after a failure (L8)
        } catch {
          /* unreadable → treat as stale, refresh */
        }
        if (ageMs < cooldownMs) return;
      }
      await this.measureEntryQuality();
    } catch {
      /* best-effort; never block observation collection */
    }
  }

  /**
   * LLM-judge a random SAMPLE of index entries (1–5 for clarity + specificity +
   * actionability), cache the median. Expensive (one LLM call) → run out-of-band
   * (a refresh timer / on demand), NOT inside measureFitness. Returns the median,
   * or null when there's no LLM or nothing to judge.
   */
  async measureEntryQuality(sampleSize = 12): Promise<number | null> {
    if (!this.llm || !existsSync(this.memoryIndex)) return null;
    const entryLines = readFileSync(this.memoryIndex, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- ["));
    if (entryLines.length === 0) return null;
    // Deterministic-ish sample: evenly spaced across the index.
    const step = Math.max(1, Math.floor(entryLines.length / sampleSize));
    const sample = entryLines.filter((_, i) => i % step === 0).slice(0, sampleSize);
    const system =
      "You are a strict memory-index reviewer. For EACH line, rate the entry 1-5 on " +
      "clarity + specificity + actionability (5 = crisp, specific, immediately useful; " +
      "1 = vague/redundant/noise). Reply ONLY with a JSON array of integers, one per " +
      "line, in order. No prose.";
    try {
      const raw = await this.llm.call(
        "judge",
        system,
        [{ role: "user", content: sample.join("\n") }],
        400,
      );
      const nums = JSON.parse((raw.match(/\[[\s\S]*\]/) ?? ["[]"])[0]) as unknown[];
      const scores = nums.filter((n): n is number => typeof n === "number" && n >= 1 && n <= 5);
      if (scores.length === 0) {
        this.stampQualityFailure();
        return null;
      }
      const med = median(scores);
      writeFileSync(
        this.qualityCachePath,
        JSON.stringify({
          ts: new Date().toISOString(),
          median: med,
          sampleSize: scores.length,
          scores,
        }),
        "utf8",
      );
      return med;
    } catch {
      this.stampQualityFailure();
      return null;
    }
  }

  /** L8: record a short-TTL failure stamp so refreshQualityIfStale won't re-fire a
   * blocking LLM call every cycle after an error/timeout/unparseable reply. */
  private stampQualityFailure(): void {
    try {
      writeFileSync(
        this.qualityCachePath,
        JSON.stringify({ ts: new Date().toISOString(), median: null, failed: true }),
        "utf8",
      );
    } catch {
      /* best-effort */
    }
  }

  /** Rough per-session context cost of the index in tokens (~4 chars/token). */
  private estimateContextTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * Produce a shrunk index: each over-long entry becomes one line ≤200 chars,
   * keeping its exact `[Title](file.md)` link (detail lives in the topic file).
   * LLM rewrite when available (better prose); deterministic truncation as the
   * fallback AND as the guard — if the LLM drops/adds an entry or a pointer, we
   * fall back so the result always preserves every entry + link.
   */
  private async rewriteShort(content: string): Promise<string> {
    const lines = content.split("\n");
    if (!this.llm) return lines.map(shortenIndexLine).join("\n");
    // Only over-long entry lines need rewriting; batch them so each LLM call is
    // small + fast (a one-shot rewrite of a big index times out). Per-line guard:
    // the output line must keep the SAME single pointer as its input, else that
    // whole batch falls back to deterministic truncation. Non-entry + short lines
    // are untouched and order is preserved.
    const targets = lines
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.startsWith("- [") && x.l.length > MAX_INDEX_LINE_CHARS)
      .map((x) => x.i);
    if (targets.length === 0) return content;
    const onePtr = (s: string) => {
      const m = [...s.matchAll(/\]\(([^)]+\.md)\)/g)].map((x) => x[1]);
      return m.length === 1 ? m[0] : null;
    };
    const system =
      'You tighten memory-index lines of the form "- [Title](file.md) — hook". For EACH input ' +
      "line, shorten the hook so the whole line is <=200 characters, KEEP the exact " +
      '"[Title](file.md)" link, and return exactly ONE line per input line, in the SAME order. ' +
      "Do NOT drop, add, merge, or reorder. Reply ONLY with the revised lines, nothing else.";
    const BATCH = 15;
    for (let b = 0; b < targets.length; b += BATCH) {
      const idxs = targets.slice(b, b + BATCH);
      const src = idxs.map((i) => lines[i] as string);
      let ok = false;
      try {
        const raw = await this.llm.call(
          "proposer",
          system,
          [{ role: "user", content: src.join("\n") }],
          4000,
        );
        const out = raw
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("- ["));
        ok =
          out.length === src.length &&
          // Preserve pointers AND actually shorten: an LLM line that keeps the
          // pointer but stays over-budget must not pass (L2) — else the shrink
          // reports success while long_line_count never reaches 0.
          out.every(
            (o, k) =>
              onePtr(o) !== null &&
              onePtr(o) === onePtr(src[k] as string) &&
              o.length <= MAX_INDEX_LINE_CHARS,
          );
        if (ok) {
          idxs.forEach((i, k) => {
            lines[i] = out[k] as string;
          });
        }
      } catch {
        ok = false;
      }
      if (!ok) {
        idxs.forEach((i) => {
          lines[i] = shortenIndexLine(lines[i] as string);
        });
      }
    }
    return lines.join("\n");
  }

  /**
   * Scan MEMORY.md: defects = entries whose referenced file is missing (dead) +
   * duplicate-slug entries. Returns null when the index file is absent.
   */
  private scanIndex(): {
    entries: number;
    defects: number;
    contextCostTokens: number;
    longLines: number;
  } | null {
    if (!existsSync(this.memoryIndex)) return null;
    let content: string;
    try {
      content = readFileSync(this.memoryIndex, "utf8");
    } catch {
      return null;
    }
    const entries = parseEntries(content);
    const memoryDir = dirname(this.memoryIndex);
    const slugCounts = new Map<string, number>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }
    let defects = 0;
    const countedDupSlugs = new Set<string>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      if (!existsSync(resolve(memoryDir, e.file))) defects += 1;
      // A duplicated slug is ONE defect, not one per occurrence (L9).
      else if ((slugCounts.get(slug) ?? 0) > 1 && !countedDupSlugs.has(slug)) {
        defects += 1;
        countedDupSlugs.add(slug);
      }
    }
    // Entry lines over the ~200-char one-line budget (CLAUDE.md memory spec).
    const longLines = content.split("\n").filter((l) => l.length > MAX_INDEX_LINE_CHARS).length;
    return {
      entries: entries.length,
      defects,
      contextCostTokens: this.estimateContextTokens(content),
      longLines,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    out.push({
      raw: line,
      title: m[1]!,
      file: m[2]!,
      hook: m[3] ?? null,
    });
  }
  return out;
}

function dedupe(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    out.push(e);
  }
  return out;
}

function renderIndex(entries: MemoryEntry[]): string {
  const lines: string[] = [HEADER, ""];
  for (const e of entries) {
    if (e.hook) lines.push(`- [${e.title}](${e.file}) — ${e.hook}`);
    else lines.push(`- [${e.title}](${e.file})`);
  }
  return `${lines.join("\n")}\n`;
}

type Strategy = "dedup-dead" | "dedup-reorder" | "dedup-group";

function isKnownStrategy(s: string): s is Strategy {
  return s === "dedup-dead" || s === "dedup-reorder" || s === "dedup-group";
}

function applyStrategy(current: string, indexPath: string, strategy: Strategy): string {
  const entries = parseEntries(current);
  const memoryDir = dirname(indexPath);
  const live = entries.filter((e) => existsSync(resolve(memoryDir, e.file)));
  const deduped = dedupe(live);

  switch (strategy) {
    case "dedup-dead":
      return renderIndex(deduped);
    case "dedup-reorder":
      return renderIndex([...deduped].sort((a, b) => a.title.localeCompare(b.title)));
    case "dedup-group": {
      // Group by leading slug-prefix (e.g. `feedback_`, `project_`, `user_`);
      // entries without an underscore prefix go to a final 'misc' bucket.
      const groups = new Map<string, MemoryEntry[]>();
      for (const e of deduped) {
        const m = e.file.match(/^([a-zA-Z][a-zA-Z0-9]*)_/);
        const key = m ? m[1]! : "misc";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(e);
      }
      const orderedKeys = [...groups.keys()].sort();
      const out: MemoryEntry[] = [];
      for (const k of orderedKeys) {
        const bucket = groups.get(k)!;
        bucket.sort((a, b) => a.title.localeCompare(b.title));
        out.push(...bucket);
      }
      return renderIndex(out);
    }
  }
}
