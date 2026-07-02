import { writeFile, copyFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_SKILLS_DIR } from "../../skills-tuner/core/config.js";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import {
  type EvidenceDrivenSubject,
  type ResearchSpec,
  type LocalSignal,
  type StructuredEvidence,
  type EvidenceVerdict,
  type EvidencePatch,
  meetsEvidenceBar,
} from "../wisecron/evidence-driven.js";
import { skillsHealth, accessedSkills } from "./skills-signal.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { median } from "../../skills-tuner/core/aggregate.js";

const SKILLS_MIN = 4; // need a few skills before "dead ratio" means anything
const SKILLS_MAX_DEAD_RATIO = 0.5;
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import { ORPHAN_SUBJECT, CREATE_KINDS } from "../../skills-tuner/core/interfaces.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";

export const DEFAULT_NEGATIVE_PATTERNS: RegExp[] = [
  /\bnope\b/i,
  /\bwrong\b/i,
  /not right/i,
  /try again/i,
  /\bno\b/i,
  /that's not/i,
  /i don't like/i,
  /frustrat/i,
  /not what i/i,
  /\bnon\b/i,
  /pas comme/i,
  /c'est pas/i,
  /recommence/i,
  /oublie/i,
];
export const DEFAULT_POSITIVE_PATTERNS: RegExp[] = [
  /\bperfect\b/i,
  /\bnice\b/i,
  /\bexactly\b/i,
  /\bgood\b/i,
  /\bthanks\b/i,
  /\bgreat\b/i,
  /that.*right/i,
  /that.*works/i,
  /\bparfait\b/i,
  /\bmerci\b/i,
  /c'est bon/i,
  /bien fait/i,
];
export const DEFAULT_EMOTIONAL_PATTERNS: RegExp[] = [
  /\bmoney\b/i,
  /\bcash\b/i,
  /at stake/i,
  /\bdamn\b/i,
  /\bhell\b/i,
  /\bfuck\b/i,
  /\bshit\b/i,
  /\bbroken\b/i,
  /frustrating/i,
  /\bangry\b/i,
];

export const ORPHAN_SKILL = ORPHAN_SUBJECT;

export interface SkillEntry {
  path: string;
  dirPath: string | null; // set for directory format, null for flat
  format: "flat" | "directory";
  frontmatter: Record<string, unknown>;
  content: string;
  triggers: string[]; // resolved: config overrides > frontmatter > name
}

export interface SkillOverride {
  triggers?: string[];
  risk_tier?: string;
  auto_merge_default?: boolean;
}

export interface SkillsSubjectConfig {
  /** skill_access log (the proactive signal source). Default ~/.config/tuner/skill_accesses.jsonl */
  skillAccessLog?: string;
  /** LLM-judged description-quality cache. Default ~/.config/tuner/skills-quality-cache.json */
  qualityCachePath?: string;
  llm?: LLMClient;
  scanDirs?: string[];
  emotionalPatterns?: RegExp[];
  negativePatterns?: RegExp[];
  positivePatterns?: RegExp[];
  // Skills-tuner-specific metadata for Anthropic-format skills (no frontmatter pollution)
  overrides?: Record<string, SkillOverride>;
  /**
   * Agent-scope bound: when set, session scanning is restricted to
   * `~/.claude/projects/<dir>` whose name starts with one of these prefixes
   * (the agent's encoded project dirs). Omit (= all scope) to scan every
   * project's sessions. See core/scope.ts `AgentSurface.sessionProjectDirs`.
   */
  sessionProjectDirs?: string[];
  /** Session-transcript root. Defaults to `~/.claude/projects`. Injectable for tests. */
  projectsDir?: string;
}

function combineRegex(patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map((p) => p.source).join("|"), "i");
}

function stripFences(text: string): string {
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text.slice(3);
    if (text.endsWith("```")) text = text.slice(0, text.lastIndexOf("```"));
  }
  return text.trim();
}

export class SkillsSubject extends BaseSubject implements EvidenceDrivenSubject {
  readonly name = "skills";
  readonly risk_tier = "low" as const;
  readonly auto_merge_default = true;
  readonly supports_creation = true;
  readonly orphan_min_observations = 2;

  private readonly llm?: LLMClient;
  private readonly scanDirs: string[];
  private readonly skillAccessLog: string;
  private readonly negRe: RegExp;
  private readonly posRe: RegExp;
  private readonly emotRe: RegExp;
  private readonly overrides: Record<string, SkillOverride>;
  private readonly sessionProjectDirs?: string[];
  private readonly projectsDir: string;
  private readonly qualityCachePath: string;
  private skillsCache: Map<string, SkillEntry> | null = null;

  constructor(opts: SkillsSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.scanDirs = opts.scanDirs ?? [DEFAULT_SKILLS_DIR];
    this.skillAccessLog =
      opts.skillAccessLog ?? join(homedir(), ".config", "tuner", "skill_accesses.jsonl");
    this.qualityCachePath =
      opts.qualityCachePath ?? join(homedir(), ".config", "tuner", "skills-quality-cache.json");
    this.negRe = combineRegex(opts.negativePatterns ?? DEFAULT_NEGATIVE_PATTERNS);
    this.posRe = combineRegex(opts.positivePatterns ?? DEFAULT_POSITIVE_PATTERNS);
    this.emotRe = combineRegex(opts.emotionalPatterns ?? DEFAULT_EMOTIONAL_PATTERNS);
    this.overrides = opts.overrides ?? {};
    this.sessionProjectDirs =
      opts.sessionProjectDirs && opts.sessionProjectDirs.length > 0
        ? opts.sessionProjectDirs
        : undefined;
    this.projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  }

  // ── Proactive face: EvidenceDrivenSubject (dead-skill signal + faisceau preuves) ──

  researchSpec(): ResearchSpec {
    return {
      subject: "skills",
      query: "agent skill design discoverability tool description consolidation",
      sourceTiers: ["enterprise", "authoritative", "papers"],
      technique: "skill-description-optimization",
    };
  }

  async localSignal(): Promise<LocalSignal> {
    const h = skillsHealth(this.scanDirs, this.skillAccessLog);
    // Guard: never flag degradation from a STALE access log (broken telemetry, not unused skills).
    const degraded =
      h.logFresh && h.totalSkills >= SKILLS_MIN && h.deadRatio > SKILLS_MAX_DEAD_RATIO;
    return {
      metric: "skills_dead_ratio",
      value: Math.round(h.deadRatio * 1000) / 1000,
      unit: "ratio",
      degraded,
      trend: degraded ? "degrading" : "stable",
      sampledAt: new Date().toISOString(),
    };
  }

  evaluate(evidence: StructuredEvidence, signal: LocalSignal): EvidenceVerdict {
    if (!signal.degraded) {
      return {
        propose: false,
        reason: `skill set healthy (dead_ratio=${signal.value})`,
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
    const confidence = Math.round(Math.min(1, evidence.independentSources / 5) * 100) / 100;
    // kind="patch": optimising a skill description is a CONTENT change this subject
    // applies itself (in scan_dirs) — a normal gated patch, never a plugin/engine code.
    return {
      propose: true,
      reason: `dead-skill ratio ${signal.value} + ${evidence.independentSources} independent sources for '${evidence.technique}'`,
      kind: "patch",
      confidence,
    };
  }

  /**
   * Build the concrete content patch for a kind="patch" verdict: pick the worst
   * dead skill (present but never accessed) and propose description-optimisation
   * alternatives via the same generator the reactive path uses (LLM-optional,
   * deterministic fallback). The patch targets a file inside scan_dirs only —
   * apply() re-checks containment. Returns null when nothing is actionable.
   */
  async proposeEvidencePatch(
    evidence: StructuredEvidence,
    signal: LocalSignal,
  ): Promise<EvidencePatch | null> {
    const skills = await this.loadSkillsMap();
    if (skills.size === 0) return null;
    const accessed = accessedSkills(this.skillAccessLog);
    const deadName = [...skills.keys()].find((n) => !accessed.has(n));
    if (!deadName) return null; // no dead skill → nothing to optimise
    const cluster: Cluster = {
      id: `evidence:skill-description-optimization`,
      subject: "skills",
      observations: [
        {
          session_id: "evidence",
          observed_at: new Date(),
          signal_type: "orphan",
          verbatim: sanitizeObservationContent(
            `evidence-backed: ${evidence.technique} — ${evidence.independentSources} independent sources` +
              `${evidence.claimedGain ? `, gain ${evidence.claimedGain}` : ""}; local dead-skill ratio ${signal.value}`,
            500,
          ),
          metadata: { subject: "skills", skill: deadName },
        } as Observation,
      ],
      frequency: 1,
      success_rate: 0,
      sentiment: "neutral",
      subjects_touched: [deadName],
    };
    const proposal = await this.proposePatchForExistingSkill(cluster, deadName);
    if (!proposal.alternatives.length) return null;
    return { target_path: proposal.target_path, alternatives: proposal.alternatives };
  }

  async confirm(before: LocalSignal): Promise<boolean> {
    const after = await this.localSignal();
    return after.value < before.value;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const skills = await this.loadSkillsMap();
    if (skills.size === 0) return [];
    // Out-of-band, best-effort: refresh the LLM description-quality cache if stale
    // (gated on an LLM → dormant + zero cost by default).
    await this.refreshQualityIfStale();

    const observations: Observation[] = [];
    const sessionFiles = await this.findSessionFiles(since);

    for (const filePath of sessionFiles) {
      try {
        const obs = await this.scanSession(filePath, skills, since);
        observations.push(...obs);
      } catch {
        // skip unreadable session
      }
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const bySkill = new Map<string, Observation[]>();
    for (const obs of observations) {
      const skillName = (obs.metadata?.["skill_name"] as string | undefined) ?? "unknown";
      const list = bySkill.get(skillName) ?? [];
      list.push(obs);
      bySkill.set(skillName, list);
    }

    const clusters: Cluster[] = [];
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    for (const [skillName, obsList] of bySkill) {
      if (skillName === ORPHAN_SKILL) {
        if (obsList.length >= this.orphan_min_observations) {
          clusters.push({
            id: "skills-" + ORPHAN_SKILL + "-" + now,
            subject: "skills",
            observations: obsList,
            frequency: obsList.length,
            success_rate: 0,
            sentiment: "negative",
            subjects_touched: [ORPHAN_SKILL],
          });
        }
        continue;
      }

      const neg = obsList.filter((o) => o.signal_type !== "positive_feedback");
      const pos = obsList.filter((o) => o.signal_type === "positive_feedback");
      const total = obsList.length;
      const successRate = total > 0 ? pos.length / total : 0;
      const frequency = neg.length;

      if (frequency < 2) continue;
      if (successRate > 0.8) continue;

      clusters.push({
        id: "skills-" + skillName + "-" + now,
        subject: "skills",
        observations: obsList,
        frequency,
        success_rate: successRate,
        sentiment: successRate < 0.3 ? "negative" : "neutral",
        subjects_touched: [skillName],
      });
    }

    clusters.sort((a, b) => b.frequency - a.frequency);
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const skillName = cluster.subjects_touched[0] ?? "unknown";
    if (skillName === ORPHAN_SKILL) {
      return this.proposeNewSkill(cluster);
    }
    return this.proposePatchForExistingSkill(cluster, skillName);
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw new Error("Alternative " + alternativeId + " not found");

    const expandHome = (p: string) => p.replace(/^~/, homedir());
    const allowed = this.scanDirs.map((d) => resolve(expandHome(d)));

    if (CREATE_KINDS.has(proposal.kind as never)) {
      const slug =
        alt.label
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-+|-+$/, "") || "new-skill";
      const baseDir = resolve(expandHome(this.scanDirs[0]!));

      // Default to directory format (Anthropic standard)
      let actualDir = resolve(baseDir, slug);
      let target = join(actualDir, "SKILL.md");

      // Collision: append timestamp
      if (existsSync(actualDir)) {
        const ts = Math.floor(Date.now() / 1000);
        actualDir = actualDir + "-" + ts;
        target = join(actualDir, "SKILL.md");
      }

      // Path containment guard
      const targetReal = resolve(target);
      if (
        !allowed.some(
          (d) =>
            targetReal === d || targetReal.startsWith(d + sep) || targetReal.startsWith(d + "/"),
        )
      ) {
        throw new Error("Target " + targetReal + " outside scan_dirs");
      }

      await mkdir(actualDir, { recursive: true });
      // M3: never write THROUGH a planted symlink (lexical containment above
      // doesn't resolve symlinks; writeFile follows them).
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error("Refusing to write through a symlink: " + target);
      }
      await writeFile(target, alt.diff_or_content, "utf8");
      this.skillsCache = null;
      return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
    }

    const target = resolve(expandHome(proposal.target_path));
    if (
      !allowed.some((d) => target.startsWith(d + sep) || target.startsWith(d + "/") || target === d)
    ) {
      throw new Error("Target " + target + " outside scan_dirs");
    }
    if (!existsSync(target)) {
      throw new Error("Target " + target + " does not exist for kind=" + proposal.kind);
    }
    // M3: refuse a symlinked target — copyFile/writeFile would follow it out of the tree.
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error("Refusing to write through a symlink: " + target);
    }
    await copyFile(target, target + ".bak");
    await writeFile(target, alt.diff_or_content, "utf8");
    this.skillsCache = null;
    return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    if (CREATE_KINDS.has(patch.kind as never)) {
      const content = patch.applied_content ?? "";
      if (!content.startsWith("---")) {
        return { valid: false, reason: "Created skill missing frontmatter" };
      }
      const fm = content.split("---")[1] ?? "";
      if (!fm.includes("name:")) {
        return {
          valid: false,
          reason: "Created skill missing name: in frontmatter (Anthropic format requires name)",
        };
      }
      if (!fm.includes("description:")) {
        return {
          valid: false,
          reason:
            "Created skill missing description: in frontmatter (Anthropic format requires description for discovery)",
        };
      }
      // Note: triggers: is optional — configure in ~/.config/tuner/config.yaml under subjects.skills.overrides
    }
    return { valid: true };
  }

  scoreSignal(
    verbatim: string,
    attributedTo: string,
    knownEntities: Record<string, unknown>,
  ): number {
    const textLower = verbatim.toLowerCase();
    const triggersMatched = new Set<string>();
    for (const [name, info] of Object.entries(knownEntities)) {
      const triggers: string[] = (info as { triggers?: string[] } | null)?.triggers ?? [name];
      for (const trigger of triggers) {
        if (textLower.includes(trigger.toLowerCase())) {
          triggersMatched.add(name);
          break;
        }
      }
    }
    let score = 0;
    if (triggersMatched.has(attributedTo)) score += 2;
    const others = [...triggersMatched].filter((n) => n !== attributedTo);
    if (others.length > 0) score -= 3;
    if (triggersMatched.size === 0 && this.emotRe.test(verbatim)) score -= 1;
    return score;
  }

  reclassifySignal(verbatim: string, knownEntities: Record<string, unknown>): string {
    const textLower = verbatim.toLowerCase();
    for (const [name, info] of Object.entries(knownEntities)) {
      const triggers: string[] = (info as { triggers?: string[] } | null)?.triggers ?? [name];
      for (const trigger of triggers) {
        if (textLower.includes(trigger.toLowerCase())) return name;
      }
    }
    return ORPHAN_SUBJECT;
  }

  // ── Private helpers ──

  /**
   * OutcomeLoop fitness for the skills subject — the governed measurement the v1
   * skills-tuner lacked. Target `skills_description_context_cost` (Tier 1b
   * artifact): the tokens of ALL skill descriptions the matcher loads to route a
   * task — lower is better, but gameable by deleting skills, so guarded by
   * `skills_count` (higher_is_better). `skills_dead_ratio` (fraction of skills
   * never accessed, trusted only when the access log is fresh).
   * `skills_description_quality` (LLM judge, cached out-of-band): descriptions
   * must stay discoverable — the anti-Goodhart pair to context cost.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "skills_description_context_cost",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
        guardrails: ["skills_count"],
      },
      {
        name: "skills_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
      {
        name: "skills_dead_ratio",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
        guardrails: ["skills_count"],
      },
      {
        name: "skills_description_quality",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Artifact-based fitness: scan the skill set (descriptions + count + dead
   * ratio) and read the cached description-quality. No telemetry stream needed —
   * fast + deterministic, so the OutcomeLoop can keep/revert a skills change.
   */
  async measureFitness(
    _range: DateRange,
    _provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const scan = await this.scanSkills();
    if (scan !== null) {
      out.skills_count = scan.count;
      out.skills_description_context_cost = scan.descriptionTokens;
      // M5: omit dead_ratio when the access log is not fresh — 0 is the OPTIMAL
      // value (lower_is_better), so emitting it would let broken telemetry read
      // as a perfect score and bias the OutcomeLoop toward keeping changes.
      if (scan.deadRatio !== null) out.skills_dead_ratio = scan.deadRatio;
    }
    const q = this.readQualityCache();
    if (q !== null) out.skills_description_quality = q;
    return out;
  }

  /** Scan the skill set: count + total description tokens (~4 chars/token) + dead ratio. */
  private async scanSkills(): Promise<{
    count: number;
    descriptionTokens: number;
    deadRatio: number | null;
  } | null> {
    const skills = await this.loadSkillsMap();
    if (skills.size === 0) return null;
    let descChars = 0;
    for (const e of skills.values()) {
      const d = e.frontmatter?.description;
      if (typeof d === "string") descChars += d.length;
    }
    const h = skillsHealth(this.scanDirs, this.skillAccessLog);
    return {
      count: skills.size,
      descriptionTokens: Math.ceil(descChars / 4),
      // null (not 0) when the access log is stale → measureFitness omits it (M5).
      deadRatio: h.logFresh ? h.deadRatio : null,
    };
  }

  /** Read the cached median description-quality (1–5), or null if absent/malformed. */
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
   * Gated on an LLM (default: none → no-op), so the judge is reachable from the
   * normal cycle without adding cost by default.
   */
  private async refreshQualityIfStale(maxAgeDays = 7): Promise<void> {
    if (!this.llm) return;
    try {
      if (existsSync(this.qualityCachePath)) {
        const ageMs = Date.now() - statSync(this.qualityCachePath).mtimeMs;
        let cooldownMs = maxAgeDays * 86_400_000;
        try {
          const c = JSON.parse(readFileSync(this.qualityCachePath, "utf8"));
          if (c && c.failed === true) cooldownMs = 6 * 3_600_000; // short retry after failure (L8)
        } catch {
          /* unreadable → refresh */
        }
        if (ageMs < cooldownMs) return;
      }
      await this.measureDescriptionQuality();
    } catch {
      /* best-effort; never block observation collection */
    }
  }

  /**
   * LLM-judge a SAMPLE of skill descriptions (1–5 for how discoverable +
   * discriminative each is to the matcher), cache the median. Expensive (one LLM
   * call) → run out-of-band, NOT inside measureFitness. The anti-Goodhart pair
   * to context cost: tightening descriptions must not make them vaguer. Returns
   * the median, or null when there's no LLM or nothing to judge.
   */
  async measureDescriptionQuality(sampleSize = 12): Promise<number | null> {
    if (!this.llm) return null;
    const skills = await this.loadSkillsMap();
    const items = [...skills.entries()]
      .map(([name, e]) => ({
        name,
        desc:
          typeof e.frontmatter?.description === "string"
            ? (e.frontmatter.description as string)
            : "",
      }))
      .filter((x) => x.desc.length > 0);
    if (items.length === 0) return null;
    const step = Math.max(1, Math.floor(items.length / sampleSize));
    const sample = items.filter((_, i) => i % step === 0).slice(0, sampleSize);
    const system =
      "You review AGENT SKILL descriptions used by a matcher to route a task to the " +
      "right skill. Rate EACH 1-5 on how discoverable + discriminative it is (5 = crisp, " +
      "says exactly what it does AND when to use it, easy to match; 1 = vague/generic/" +
      "overlapping/noise). Reply ONLY with a JSON array of integers, one per line, in order.";
    const user = sample.map((s) => `- ${s.name}: ${s.desc}`).join("\n");
    try {
      const raw = await this.llm.call("judge", system, [{ role: "user", content: user }], 400);
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

  /** L8: short-TTL failure stamp so refreshQualityIfStale won't re-fire a blocking
   * LLM call every cycle after an error/timeout/unparseable reply. */
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

  private async loadSkillsMap(): Promise<Map<string, SkillEntry>> {
    if (this.skillsCache) return this.skillsCache;
    const map = new Map<string, SkillEntry>();

    for (const dir of this.scanDirs) {
      const expanded = dir.replace(/^~/, homedir());
      if (!existsSync(expanded)) continue;

      let entries: Awaited<ReturnType<typeof readdir>>;
      try {
        entries = await readdir(expanded, { withFileTypes: true });
      } catch {
        continue;
      }

      // Pass 1: directory format (Anthropic standard — higher priority)
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(expanded, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        const { frontmatter, body } = await this.loadFrontmatter(skillMdPath);
        const name = (frontmatter["name"] as string | undefined) ?? entry.name;
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride)
          ? configOverride
          : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: skillMdPath,
          dirPath: join(expanded, entry.name),
          format: "directory",
          frontmatter,
          content: body,
          triggers,
        });
      }

      // Pass 2: flat format — skipped if directory format already loaded for same name
      for (const entry of entries) {
        if (entry.isDirectory() || !entry.name.endsWith(".md") || entry.name.includes(".bak"))
          continue;
        const filePath = join(expanded, entry.name);
        const { frontmatter, body } = await this.loadFrontmatter(filePath);
        const name = (frontmatter["name"] as string | undefined) ?? entry.name.replace(/\.md$/, "");
        if (map.has(name)) continue; // directory format wins
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride)
          ? configOverride
          : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: filePath,
          dirPath: null,
          format: "flat",
          frontmatter,
          content: body,
          triggers,
        });
      }
    }

    this.skillsCache = map;
    return map;
  }

  private parseTriggers(frontmatter: Record<string, unknown>, fallback: string): string[] {
    const raw = frontmatter["triggers"] ?? frontmatter["trigger"];
    if (typeof raw === "string")
      return raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    if (Array.isArray(raw)) return raw.map(String);
    return [fallback];
  }

  private matchSkill(text: string, skills: Map<string, { triggers: string[] }>): string | null {
    const textLower = text.toLowerCase();
    for (const [name, info] of skills) {
      for (const trigger of info.triggers) {
        if (textLower.includes(trigger.toLowerCase())) return name;
      }
    }
    return null;
  }

  private async findSessionFiles(since: Date): Promise<string[]> {
    const files: string[] = [];

    const projectsDir = this.projectsDir;
    if (existsSync(projectsDir)) {
      try {
        const projects = await readdir(projectsDir, { withFileTypes: true });
        for (const project of projects) {
          if (!project.isDirectory()) continue;
          // Agent scope: only the agent's own project dirs are scanned.
          if (
            this.sessionProjectDirs &&
            !this.sessionProjectDirs.some((p) => project.name.startsWith(p))
          )
            continue;
          const projectPath = join(projectsDir, project.name);
          const direct = await readdir(projectPath).catch(() => [] as string[]);
          for (const f of direct) {
            if (f.endsWith(".jsonl")) files.push(join(projectPath, f));
          }
          const sessionsPath = join(projectPath, "sessions");
          if (existsSync(sessionsPath)) {
            const sesFiles = await readdir(sessionsPath).catch(() => [] as string[]);
            for (const f of sesFiles) {
              if (f.endsWith(".jsonl")) files.push(join(sessionsPath, f));
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    const sinceMs = since.getTime();
    return files
      .filter((f) => {
        try {
          return statSync(f).mtimeMs >= sinceMs;
        } catch {
          return false;
        }
      })
      .map((f) => {
        try {
          return { f, mtime: statSync(f).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f)
      .slice(0, 50);
  }

  private async scanSession(
    filePath: string,
    skills: Map<string, SkillEntry>,
    since: Date,
  ): Promise<Observation[]> {
    const observations: Observation[] = [];
    const messages: Array<Record<string, unknown>> = [];

    const rl = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip */
      }
    }

    const sessionId = basename(filePath, ".jsonl");

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg["type"] !== "user") continue;
      const text = this.extractText(msg);
      if (!text) continue;

      const matchedSkill = this.matchSkill(text, skills);
      if (!matchedSkill) continue;

      let nextUserText = "";
      for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
        if (messages[j]!["type"] === "user") {
          nextUserText = this.extractText(messages[j]!) ?? "";
          break;
        }
      }

      const ts = this.parseTs(msg);
      const skillsAsEntities: Record<string, unknown> = {};
      for (const [k, v] of skills) skillsAsEntities[k] = { triggers: v.triggers };

      if (nextUserText && this.negRe.test(nextUserText)) {
        const score = this.scoreSignal(nextUserText, matchedSkill, skillsAsEntities);
        const attributed =
          score < 0 ? this.reclassifySignal(nextUserText, skillsAsEntities) : matchedSkill;
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: "correction",
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: attributed, trigger: text.slice(0, 100) },
        });
      } else if (nextUserText && this.posRe.test(nextUserText)) {
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: "positive_feedback",
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: matchedSkill },
        });
      }
    }
    return observations;
  }

  private extractText(msg: Record<string, unknown>): string | null {
    try {
      const content = (msg["message"] as Record<string, unknown> | undefined)?.["content"];
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts = (content as Array<Record<string, unknown>>)
          .filter((c) => c["type"] === "text")
          .map((c) => String(c["text"] ?? ""));
        return parts.join(" ") || null;
      }
    } catch {
      /* skip */
    }
    return null;
  }

  private parseTs(msg: Record<string, unknown>): Date {
    const ts = msg["timestamp"];
    if (typeof ts === "string") {
      try {
        return new Date(ts);
      } catch {
        /* fall through */
      }
    }
    return new Date();
  }

  private async proposeNewSkill(cluster: Cluster): Promise<UnsignedProposal> {
    const evidence = cluster.observations
      .slice(0, 6)
      .map((o) => "- " + sanitizeObservationContent(o.verbatim))
      .join("\n");
    const targetPath = join(this.scanDirs[0]!.replace(/^~/, homedir()), ORPHAN_SKILL + ".md");

    const alternatives = this.llm
      ? await this.llmProposeNewSkill(evidence, cluster).catch(() =>
          this.fallbackNewSkillAlternatives(),
        )
      : this.fallbackNewSkillAlternatives();

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: "skills",
      kind: "new_skill",
      target_path: targetPath,
      alternatives,
      pattern_signature: cluster.id + ":new_skill",
      created_at: new Date(),
    };
  }

  private async proposePatchForExistingSkill(
    cluster: Cluster,
    skillName: string,
  ): Promise<UnsignedProposal> {
    const skills = await this.loadSkillsMap();
    const skillInfo = skills.get(skillName);
    const skillPath = skillInfo?.path ?? join(this.scanDirs[0]!, skillName + ".md");
    const rawSkillContent = skillInfo?.content ?? "(content not found)";
    const skillContent = sanitizeObservationContent(rawSkillContent, 10_000);
    const evidence = cluster.observations
      .slice(0, 6)
      .map((o) => "- [" + o.signal_type + "] " + sanitizeObservationContent(o.verbatim))
      .join("\n");

    const alternatives = this.llm
      ? await this.llmPropose(skillName, skillContent, evidence, cluster).catch(() =>
          this.fallbackAlternatives(skillName, skillInfo),
        )
      : this.fallbackAlternatives(skillName, skillInfo);

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: "skills",
      kind: "patch",
      target_path: skillPath,
      alternatives,
      pattern_signature: cluster.id + ":" + skillPath + ":patch",
      created_at: new Date(),
    };
  }

  private async llmProposeNewSkill(evidence: string, cluster: Cluster) {
    const system =
      'Generate a Claude Code skill in the Anthropic standard directory format. The output should be the contents of SKILL.md (a single markdown file with frontmatter name: and description:, body in markdown). The description should be discoverable — start with what the skill does and when to use it, since Claude Code skill matcher uses descriptions to choose which skills to load. Do NOT include triggers: or risk_tier: in the frontmatter — those go in the user config. Reply ONLY with a JSON array of 3 objects: [{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."},...]';
    const user =
      "Unattributed signals (" +
      cluster.frequency +
      " occurrences):\n" +
      evidence +
      "\n\nIdentify the implicit need and propose 3 skill templates in Anthropic directory format (SKILL.md content).";
    const raw = await this.llm!.call("proposer", system, [{ role: "user", content: user }], 4000);
    const data = JSON.parse(stripFences(raw)) as Array<{
      id: string;
      label: string;
      diff_or_content: string;
      tradeoff?: string;
    }>;
    return data.slice(0, 3).map((a) => ({
      id: a.id,
      label: a.label,
      diff_or_content: a.diff_or_content,
      tradeoff: a.tradeoff ?? "",
    }));
  }

  private async llmPropose(
    skillName: string,
    skillContent: string,
    evidence: string,
    cluster: Cluster,
  ) {
    const system =
      'You are an expert in prompt improvement for AI agents. Propose 3 concrete alternatives to improve a markdown skill file. Reply ONLY with a JSON array: [{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."},...]. Each diff_or_content must be the COMPLETE revised skill.';
    const user =
      "Skill: " +
      skillName +
      "\n\nCurrent content:\n```\n" +
      skillContent.slice(0, 3000) +
      "\n```\n\nNegative signals (" +
      cluster.frequency +
      " occurrences):\n" +
      evidence +
      "\n\nPropose 3 improvement alternatives.";
    const raw = await this.llm!.call("proposer", system, [{ role: "user", content: user }], 4000);
    const data = JSON.parse(stripFences(raw)) as Array<{
      id: string;
      label: string;
      diff_or_content: string;
      tradeoff?: string;
    }>;
    return data.slice(0, 3).map((a) => ({
      id: a.id,
      label: a.label,
      diff_or_content: a.diff_or_content,
      tradeoff: a.tradeoff ?? "",
    }));
  }

  private fallbackNewSkillAlternatives() {
    // Anthropic standard format: name + description in frontmatter, no triggers (go in config)
    return [
      {
        id: "A",
        label: "new-skill",
        diff_or_content:
          "---\nname: new-skill\ndescription: Describe what this skill does and when to use it. This description is used by Claude Code skill matcher.\n---\n\n# New Skill\n\nDescribe the skill here.\n",
        tradeoff: "Minimal Anthropic-format starting point",
      },
      {
        id: "B",
        label: "system-monitor",
        diff_or_content:
          "---\nname: system-monitor\ndescription: Check the state of services, disk usage, and system health. Use when asked about infrastructure status.\n---\n\n# System Monitor\n\nCheck the state of services.\n",
        tradeoff: "Useful if signals relate to infra",
      },
      {
        id: "C",
        label: "assistant-context",
        diff_or_content:
          "---\nname: assistant-context\ndescription: Provides context about the assistant persona, preferences, and collaboration style. Use for onboarding or preference discussions.\n---\n\n# Assistant Context\n\nContext about the assistant.\n",
        tradeoff: "Useful if signals relate to general assistance",
      },
    ];
  }

  private fallbackAlternatives(skillName: string, skillInfo: SkillEntry | undefined) {
    const fm = skillInfo?.frontmatter ?? {};
    const triggersList = Array.isArray(fm["triggers"])
      ? fm["triggers"]
      : fm["triggers"]
        ? [fm["triggers"]]
        : [skillName];
    const fmBlock =
      "---\nname: " +
      (fm["name"] ?? skillName) +
      (fm["description"] ? "\ndescription: " + JSON.stringify(fm["description"]) : "") +
      (triggersList.length > 0 && fm["triggers"]
        ? "\ntriggers: " + JSON.stringify(triggersList)
        : "") +
      "\n---\n\n";
    const body = skillInfo?.content ?? "";
    return [
      {
        id: "A",
        label: "Concise version",
        diff_or_content: fmBlock + "# " + skillName + "\n\n" + body.slice(0, 500).trim() + "\n",
        tradeoff: "Reduces noise, keeps the essentials",
      },
      {
        id: "B",
        label: "Original + examples",
        diff_or_content: fmBlock + body + "\n\n## Examples\n- Example 1\n- Example 2\n",
        tradeoff: "More context, but longer",
      },
      {
        id: "C",
        label: "With explicit triggers (verbose)",
        diff_or_content: fmBlock + body,
        tradeoff: "Frontmatter normalized; body unchanged",
      },
    ];
  }

  // ── Migration helpers ──

  /** List skills that are still in legacy flat format — migration candidates. */
  async listMigrationCandidates(): Promise<string[]> {
    const skills = await this.loadSkillsMap();
    return [...skills.values()]
      .filter((s) => s.format === "flat")
      .map((s) => (s.frontmatter["name"] as string | undefined) ?? basename(s.path, ".md"));
  }

  /**
   * Convert a flat skill file to Anthropic directory format (<name>/SKILL.md).
   * Strips tuner-specific fields (triggers, risk_tier, auto_merge*) from frontmatter.
   * Returns the stripped fields so the caller can persist them to config.yaml.
   * Backs up the original flat file with a .pre-migration-<ts>.bak suffix before removing it.
   */
  async migrateSkillToDirectory(skillName: string): Promise<Record<string, unknown>> {
    // Validate skillName before any FS operations
    if (/[/\\]/.test(skillName) || skillName === ".." || skillName === ".") {
      throw new Error("Invalid skill name for migration: " + skillName);
    }

    const skills = await this.loadSkillsMap();
    const skill = skills.get(skillName);
    if (!skill) throw new Error("Skill " + skillName + " not found");
    if (skill.format === "directory") return {}; // already migrated

    const flatPath = skill.path;
    const baseDir = dirname(flatPath);
    const newDir = join(baseDir, skillName);
    const newPath = join(newDir, "SKILL.md");

    // Path containment: newDir must be inside an allowed scanDir
    const allowed = this.scanDirs.map((d) => resolve(d.replace(/^~/, homedir())));
    const newDirReal = resolve(newDir);
    if (
      !allowed.some(
        (d) => newDirReal === d || newDirReal.startsWith(d + sep) || newDirReal.startsWith(d + "/"),
      )
    ) {
      throw new Error("Migration target " + newDirReal + " outside scan_dirs");
    }

    if (existsSync(newDir)) {
      throw new Error("Cannot migrate: " + newDir + " already exists");
    }

    const TUNER_FIELDS = ["triggers", "trigger", "risk_tier", "auto_merge", "auto_merge_default"];
    const cleanedFrontmatter: Record<string, unknown> = {};
    const movedToConfig: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(skill.frontmatter)) {
      if (TUNER_FIELDS.includes(k)) {
        movedToConfig[k] = v;
      } else {
        cleanedFrontmatter[k] = v;
      }
    }

    // Serialize cleaned frontmatter to YAML (simple key: value, arrays as JSON for safety)
    const fmLines = Object.entries(cleanedFrontmatter).map(([k, v]) => {
      if (typeof v === "string" && !v.includes("\n") && !v.includes(":") && !v.includes('"')) {
        return k + ": " + v;
      }
      return k + ": " + JSON.stringify(v);
    });
    const newContent = "---\n" + fmLines.join("\n") + "\n---\n\n" + skill.content;

    // Write backup BEFORE making any changes (if write fails later, original is intact)
    const backupPath = flatPath + ".pre-migration-" + Date.now() + ".bak";
    await copyFile(flatPath, backupPath);

    // Create directory and write SKILL.md
    await mkdir(newDir, { recursive: true });
    await writeFile(newPath, newContent, "utf8");

    // Remove original flat file — backup already safe
    const { unlink } = await import("node:fs/promises");
    await unlink(flatPath);

    this.skillsCache = null;
    return movedToConfig;
  }

  currentStateHash(): string {
    const items: string[] = [];
    for (const dir of this.scanDirs) {
      const expanded = dir.replace(/^~/, homedir());
      if (!existsSync(expanded)) continue;
      const entries = walkSkillFiles(expanded);
      for (const e of entries) {
        items.push(`${e.relPath}\t${e.mtimeMs}\t${e.size}`);
      }
    }
    items.sort();
    return createHash("sha256").update(items.join("\n")).digest("hex");
  }
}

function walkSkillFiles(dir: string): Array<{ relPath: string; mtimeMs: number; size: number }> {
  const result: Array<{ relPath: string; mtimeMs: number; size: number }> = [];
  function recurse(current: string, prefix: string) {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (typeof name !== "string") continue;
      const full = join(current, name);
      const rel = prefix ? join(prefix, name) : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        recurse(full, rel);
      } else if (name.endsWith(".md") && !name.includes(".bak")) {
        try {
          const st = statSync(full);
          result.push({ relPath: rel, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  recurse(dir, "");
  return result;
}
