import { writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { BaseSubject } from './base.js';
import { sanitizeObservationContent } from '../core/security.js';
import { ORPHAN_SUBJECT, CREATE_KINDS } from '../core/interfaces.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../core/types.js';
import type { LLMClient } from '../core/llm.js';

export const DEFAULT_NEGATIVE_PATTERNS: RegExp[] = [
  /\bnope\b/i, /\bwrong\b/i, /not right/i, /try again/i,
  /\bno\b/i, /that's not/i, /i don't like/i, /frustrat/i, /not what i/i,
  /\bnon\b/i, /pas comme/i, /c'est pas/i, /recommence/i, /oublie/i,
];
export const DEFAULT_POSITIVE_PATTERNS: RegExp[] = [
  /\bperfect\b/i, /\bnice\b/i, /\bexactly\b/i, /\bgood\b/i,
  /\bthanks\b/i, /\bgreat\b/i, /that.*right/i, /that.*works/i,
  /\bparfait\b/i, /\bmerci\b/i, /c'est bon/i, /bien fait/i,
];
export const DEFAULT_EMOTIONAL_PATTERNS: RegExp[] = [
  /\bmoney\b/i, /\bcash\b/i, /at stake/i,
  /\bdamn\b/i, /\bhell\b/i, /\bfuck\b/i, /\bshit\b/i,
  /\bbroken\b/i, /frustrating/i, /\bangry\b/i,
];

export const ORPHAN_SKILL = ORPHAN_SUBJECT;

export interface SkillEntry {
  path: string;
  dirPath: string | null;           // set for directory format, null for flat
  format: 'flat' | 'directory';
  frontmatter: Record<string, unknown>;
  content: string;
  triggers: string[];               // resolved: config overrides > frontmatter > name
}

export interface SkillOverride {
  triggers?: string[];
  risk_tier?: string;
  auto_merge_default?: boolean;
}

export interface SkillsSubjectConfig {
  llm?: LLMClient;
  scanDirs?: string[];
  emotionalPatterns?: RegExp[];
  negativePatterns?: RegExp[];
  positivePatterns?: RegExp[];
  // Skills-tuner-specific metadata for Anthropic-format skills (no frontmatter pollution)
  overrides?: Record<string, SkillOverride>;
}

function combineRegex(patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map(p => p.source).join('|'), 'i');
}

function stripFences(text: string): string {
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));
  }
  return text.trim();
}


export class SkillsSubject extends BaseSubject {
  readonly name = 'skills';
  readonly risk_tier = 'low' as const;
  readonly auto_merge_default = true;
  readonly supports_creation = true;
  readonly orphan_min_observations = 2;

  private readonly llm?: LLMClient;
  private readonly scanDirs: string[];
  private readonly negRe: RegExp;
  private readonly posRe: RegExp;
  private readonly emotRe: RegExp;
  private readonly overrides: Record<string, SkillOverride>;
  private skillsCache: Map<string, SkillEntry> | null = null;

  constructor(opts: SkillsSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.scanDirs = opts.scanDirs ?? [join(homedir(), 'agent', 'skills')];
    this.negRe = combineRegex(opts.negativePatterns ?? DEFAULT_NEGATIVE_PATTERNS);
    this.posRe = combineRegex(opts.positivePatterns ?? DEFAULT_POSITIVE_PATTERNS);
    this.emotRe = combineRegex(opts.emotionalPatterns ?? DEFAULT_EMOTIONAL_PATTERNS);
    this.overrides = opts.overrides ?? {};
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const skills = await this.loadSkillsMap();
    if (skills.size === 0) return [];

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
      const skillName = (obs.metadata?.['skill_name'] as string | undefined) ?? 'unknown';
      const list = bySkill.get(skillName) ?? [];
      list.push(obs);
      bySkill.set(skillName, list);
    }

    const clusters: Cluster[] = [];
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    for (const [skillName, obsList] of bySkill) {
      if (skillName === ORPHAN_SKILL) {
        if (obsList.length >= this.orphan_min_observations) {
          clusters.push({
            id: 'skills-' + ORPHAN_SKILL + '-' + now,
            subject: 'skills',
            observations: obsList,
            frequency: obsList.length,
            success_rate: 0,
            sentiment: 'negative',
            subjects_touched: [ORPHAN_SKILL],
          });
        }
        continue;
      }

      const neg = obsList.filter(o => o.signal_type !== 'positive_feedback');
      const pos = obsList.filter(o => o.signal_type === 'positive_feedback');
      const total = obsList.length;
      const successRate = total > 0 ? pos.length / total : 0;
      const frequency = neg.length;

      if (frequency < 2) continue;
      if (successRate > 0.8) continue;

      clusters.push({
        id: 'skills-' + skillName + '-' + now,
        subject: 'skills',
        observations: obsList,
        frequency,
        success_rate: successRate,
        sentiment: successRate < 0.3 ? 'negative' : 'neutral',
        subjects_touched: [skillName],
      });
    }

    clusters.sort((a, b) => b.frequency - a.frequency);
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const skillName = cluster.subjects_touched[0] ?? 'unknown';
    if (skillName === ORPHAN_SKILL) {
      return this.proposeNewSkill(cluster);
    }
    return this.proposePatchForExistingSkill(cluster, skillName);
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error('Alternative ' + alternativeId + ' not found');

    const expandHome = (p: string) => p.replace(/^~/, homedir());
    const allowed = this.scanDirs.map(d => resolve(expandHome(d)));

    if (CREATE_KINDS.has(proposal.kind as never)) {
      const slug = (alt.label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/, '') || 'new-skill');
      const baseDir = resolve(expandHome(this.scanDirs[0]!));

      // Default to directory format (Anthropic standard)
      let actualDir = resolve(baseDir, slug);
      let target = join(actualDir, 'SKILL.md');

      // Collision: append timestamp
      if (existsSync(actualDir)) {
        const ts = Math.floor(Date.now() / 1000);
        actualDir = actualDir + '-' + ts;
        target = join(actualDir, 'SKILL.md');
      }

      // Path containment guard
      const targetReal = resolve(target);
      if (!allowed.some(d => targetReal === d || targetReal.startsWith(d + sep) || targetReal.startsWith(d + '/'))) {
        throw new Error('Target ' + targetReal + ' outside scan_dirs');
      }

      await mkdir(actualDir, { recursive: true });
      await writeFile(target, alt.diff_or_content, 'utf8');
      this.skillsCache = null;
      return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
    }

    const target = resolve(expandHome(proposal.target_path));
    if (!allowed.some(d => target.startsWith(d + sep) || target.startsWith(d + '/') || target === d)) {
      throw new Error('Target ' + target + ' outside scan_dirs');
    }
    if (!existsSync(target)) {
      throw new Error('Target ' + target + ' does not exist for kind=' + proposal.kind);
    }
    await copyFile(target, target + '.bak');
    await writeFile(target, alt.diff_or_content, 'utf8');
    this.skillsCache = null;
    return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    if (CREATE_KINDS.has(patch.kind as never)) {
      const content = patch.applied_content ?? '';
      if (!content.startsWith('---')) {
        return { valid: false, reason: 'Created skill missing frontmatter' };
      }
      const fm = content.split('---')[1] ?? '';
      if (!fm.includes('name:')) {
        return { valid: false, reason: 'Created skill missing name: in frontmatter (Anthropic format requires name)' };
      }
      if (!fm.includes('description:')) {
        return { valid: false, reason: 'Created skill missing description: in frontmatter (Anthropic format requires description for discovery)' };
      }
      // Note: triggers: is optional — configure in ~/.config/tuner/config.yaml under subjects.skills.overrides
    }
    return { valid: true };
  }

  scoreSignal(verbatim: string, attributedTo: string, knownEntities: Record<string, unknown>): number {
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
    const others = [...triggersMatched].filter(n => n !== attributedTo);
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

  private async loadSkillsMap(): Promise<Map<string, SkillEntry>> {
    if (this.skillsCache) return this.skillsCache;
    const map = new Map<string, SkillEntry>();

    for (const dir of this.scanDirs) {
      const expanded = dir.replace(/^~/, homedir());
      if (!existsSync(expanded)) continue;

      let entries;
      try {
        entries = await readdir(expanded, { withFileTypes: true });
      } catch { continue; }

      // Pass 1: directory format (Anthropic standard — higher priority)
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(expanded, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;
        const { frontmatter, body } = await this.loadFrontmatter(skillMdPath);
        const name = (frontmatter['name'] as string | undefined) ?? entry.name;
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride) ? configOverride : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: skillMdPath,
          dirPath: join(expanded, entry.name),
          format: 'directory',
          frontmatter,
          content: body,
          triggers,
        });
      }

      // Pass 2: flat format — skipped if directory format already loaded for same name
      for (const entry of entries) {
        if (entry.isDirectory() || !entry.name.endsWith('.md') || entry.name.includes('.bak')) continue;
        const filePath = join(expanded, entry.name);
        const { frontmatter, body } = await this.loadFrontmatter(filePath);
        const name = (frontmatter['name'] as string | undefined) ?? entry.name.replace(/\.md$/, '');
        if (map.has(name)) continue; // directory format wins
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride) ? configOverride : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: filePath,
          dirPath: null,
          format: 'flat',
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
    const raw = frontmatter['triggers'] ?? frontmatter['trigger'];
    if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean);
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

    const home = homedir();
    const projectsDir = join(home, '.claude', 'projects');
    if (existsSync(projectsDir)) {
      try {
        const projects = await readdir(projectsDir, { withFileTypes: true });
        for (const project of projects) {
          if (!project.isDirectory()) continue;
          const projectPath = join(projectsDir, project.name);
          const direct = await readdir(projectPath).catch(() => [] as string[]);
          for (const f of direct) {
            if (f.endsWith('.jsonl')) files.push(join(projectPath, f));
          }
          const sessionsPath = join(projectPath, 'sessions');
          if (existsSync(sessionsPath)) {
            const sesFiles = await readdir(sessionsPath).catch(() => [] as string[]);
            for (const f of sesFiles) {
              if (f.endsWith('.jsonl')) files.push(join(sessionsPath, f));
            }
          }
        }
      } catch { /* skip */ }
    }

    const sinceMs = since.getTime();
    return files
      .filter(f => {
        try { return statSync(f).mtimeMs >= sinceMs; } catch { return false; }
      })
      .map(f => { try { return { f, mtime: statSync(f).mtimeMs }; } catch { return { f, mtime: 0 }; } })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.f)
      .slice(0, 50);
  }

  private async scanSession(filePath: string, skills: Map<string, SkillEntry>, since: Date): Promise<Observation[]> {
    const observations: Observation[] = [];
    const messages: Array<Record<string, unknown>> = [];

    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
    }

    const sessionId = basename(filePath, '.jsonl');

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg['type'] !== 'user') continue;
      const text = this.extractText(msg);
      if (!text) continue;

      const matchedSkill = this.matchSkill(text, skills);
      if (!matchedSkill) continue;

      let nextUserText = '';
      for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
        if (messages[j]!['type'] === 'user') {
          nextUserText = this.extractText(messages[j]!) ?? '';
          break;
        }
      }

      const ts = this.parseTs(msg);
      const skillsAsEntities: Record<string, unknown> = {};
      for (const [k, v] of skills) skillsAsEntities[k] = { triggers: v.triggers };

      if (nextUserText && this.negRe.test(nextUserText)) {
        const score = this.scoreSignal(nextUserText, matchedSkill, skillsAsEntities);
        const attributed = score < 0 ? this.reclassifySignal(nextUserText, skillsAsEntities) : matchedSkill;
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: 'correction',
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: attributed, trigger: text.slice(0, 100) },
        });
      } else if (nextUserText && this.posRe.test(nextUserText)) {
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: 'positive_feedback',
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: matchedSkill },
        });
      }
    }
    return observations;
  }

  private extractText(msg: Record<string, unknown>): string | null {
    try {
      const content = (msg['message'] as Record<string, unknown> | undefined)?.['content'];
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = (content as Array<Record<string, unknown>>)
          .filter(c => c['type'] === 'text')
          .map(c => String(c['text'] ?? ''));
        return parts.join(' ') || null;
      }
    } catch { /* skip */ }
    return null;
  }

  private parseTs(msg: Record<string, unknown>): Date {
    const ts = msg['timestamp'];
    if (typeof ts === 'string') {
      try { return new Date(ts); } catch { /* fall through */ }
    }
    return new Date();
  }

  private async proposeNewSkill(cluster: Cluster): Promise<UnsignedProposal> {
    const evidence = cluster.observations.slice(0, 6).map(o => '- ' + sanitizeObservationContent(o.verbatim)).join('\n');
    const targetPath = join(this.scanDirs[0]!.replace(/^~/, homedir()), ORPHAN_SKILL + '.md');

    const alternatives = this.llm
      ? await this.llmProposeNewSkill(evidence, cluster).catch(() => this.fallbackNewSkillAlternatives())
      : this.fallbackNewSkillAlternatives();

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: 'skills',
      kind: 'new_skill',
      target_path: targetPath,
      alternatives,
      pattern_signature: cluster.id + ':new_skill',
      created_at: new Date(),
    };
  }

  private async proposePatchForExistingSkill(cluster: Cluster, skillName: string): Promise<UnsignedProposal> {
    const skills = await this.loadSkillsMap();
    const skillInfo = skills.get(skillName);
    const skillPath = skillInfo?.path ?? join(this.scanDirs[0]!, skillName + '.md');
    const rawSkillContent = skillInfo?.content ?? '(content not found)';
    const skillContent = sanitizeObservationContent(rawSkillContent, 10_000);
    const evidence = cluster.observations.slice(0, 6)
      .map(o => '- [' + o.signal_type + '] ' + sanitizeObservationContent(o.verbatim)).join('\n');

    const alternatives = this.llm
      ? await this.llmPropose(skillName, skillContent, evidence, cluster).catch(() => this.fallbackAlternatives(skillName, skillInfo))
      : this.fallbackAlternatives(skillName, skillInfo);

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: 'skills',
      kind: 'patch',
      target_path: skillPath,
      alternatives,
      pattern_signature: cluster.id + ':' + skillPath + ':patch',
      created_at: new Date(),
    };
  }

  private async llmProposeNewSkill(evidence: string, cluster: Cluster) {
    const system = 'Generate a Claude Code skill in the Anthropic standard directory format. The output should be the contents of SKILL.md (a single markdown file with frontmatter name: and description:, body in markdown). The description should be discoverable — start with what the skill does and when to use it, since Claude Code skill matcher uses descriptions to choose which skills to load. Do NOT include triggers: or risk_tier: in the frontmatter — those go in the user config. Reply ONLY with a JSON array of 3 objects: [{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."},...]';
    const user = 'Unattributed signals (' + cluster.frequency + ' occurrences):\n' + evidence + '\n\nIdentify the implicit need and propose 3 skill templates in Anthropic directory format (SKILL.md content).';
    const raw = await this.llm!.call('proposer', system, [{ role: 'user', content: user }], 4000);
    const data = JSON.parse(stripFences(raw)) as Array<{ id: string; label: string; diff_or_content: string; tradeoff?: string }>;
    return data.slice(0, 3).map(a => ({ id: a.id, label: a.label, diff_or_content: a.diff_or_content, tradeoff: a.tradeoff ?? '' }));
  }

  private async llmPropose(skillName: string, skillContent: string, evidence: string, cluster: Cluster) {
    const system = 'You are an expert in prompt improvement for AI agents. Propose 3 concrete alternatives to improve a markdown skill file. Reply ONLY with a JSON array: [{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."},...]. Each diff_or_content must be the COMPLETE revised skill.';
    const user = 'Skill: ' + skillName + '\n\nCurrent content:\n```\n' + skillContent.slice(0, 3000) + '\n```\n\nNegative signals (' + cluster.frequency + ' occurrences):\n' + evidence + '\n\nPropose 3 improvement alternatives.';
    const raw = await this.llm!.call('proposer', system, [{ role: 'user', content: user }], 4000);
    const data = JSON.parse(stripFences(raw)) as Array<{ id: string; label: string; diff_or_content: string; tradeoff?: string }>;
    return data.slice(0, 3).map(a => ({ id: a.id, label: a.label, diff_or_content: a.diff_or_content, tradeoff: a.tradeoff ?? '' }));
  }

  private fallbackNewSkillAlternatives() {
    // Anthropic standard format: name + description in frontmatter, no triggers (go in config)
    return [
      { id: 'A', label: 'new-skill', diff_or_content: '---\nname: new-skill\ndescription: Describe what this skill does and when to use it. This description is used by Claude Code skill matcher.\n---\n\n# New Skill\n\nDescribe the skill here.\n', tradeoff: 'Minimal Anthropic-format starting point' },
      { id: 'B', label: 'system-monitor', diff_or_content: '---\nname: system-monitor\ndescription: Check the state of services, disk usage, and system health. Use when asked about infrastructure status.\n---\n\n# System Monitor\n\nCheck the state of services.\n', tradeoff: 'Useful if signals relate to infra' },
      { id: 'C', label: 'assistant-context', diff_or_content: '---\nname: assistant-context\ndescription: Provides context about the assistant persona, preferences, and collaboration style. Use for onboarding or preference discussions.\n---\n\n# Assistant Context\n\nContext about the assistant.\n', tradeoff: 'Useful if signals relate to general assistance' },
    ];
  }

  private fallbackAlternatives(skillName: string, skillInfo: SkillEntry | undefined) {
    const fm = skillInfo?.frontmatter ?? {};
    const triggersList = Array.isArray(fm['triggers']) ? fm['triggers'] : (fm['triggers'] ? [fm['triggers']] : [skillName]);
    const fmBlock = '---\nname: ' + (fm['name'] ?? skillName) + (fm['description'] ? '\ndescription: ' + JSON.stringify(fm['description']) : '') + (triggersList.length > 0 && fm['triggers'] ? '\ntriggers: ' + JSON.stringify(triggersList) : '') + '\n---\n\n';
    const body = skillInfo?.content ?? '';
    return [
      { id: 'A', label: 'Concise version', diff_or_content: fmBlock + '# ' + skillName + '\n\n' + body.slice(0, 500).trim() + '\n', tradeoff: 'Reduces noise, keeps the essentials' },
      { id: 'B', label: 'Original + examples', diff_or_content: fmBlock + body + '\n\n## Examples\n- Example 1\n- Example 2\n', tradeoff: 'More context, but longer' },
      { id: 'C', label: 'With explicit triggers (verbose)', diff_or_content: fmBlock + body, tradeoff: 'Frontmatter normalized; body unchanged' },
    ];
  }
}
