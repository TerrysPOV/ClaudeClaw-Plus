/**
 * Agents Module
 *
 * Core scaffolding for ClaudeClaw agents. Provides validation, NL→cron parsing,
 * and file generation primitives used by the create-agent wizard and runtime.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile, stat, unlink, rm } from "fs/promises";
import { ensureMemoryFile } from "./memory";
import { cronMatches } from "./cron";
import { validateModelString } from "./jobs";

// Resolve dirs at call time (not module load) so tests and runtime
// pick up the current working directory.
function projectDir(): string {
  return process.cwd();
}

function agentsDir(): string {
  return join(projectDir(), "agents");
}

export function agentJobsDir(name: string): string {
  return join(agentsDir(), name, "jobs");
}

function jobFilePath(agentName: string, label: string): string {
  return join(agentJobsDir(agentName), `${label}.md`);
}

export interface AgentCreateOpts {
  name: string;
  role: string;
  personality: string;
  schedule?: string;
  discordChannels?: string[];
  dataSources?: string;
  defaultPrompt?: string;
  workflow?: string;
  defaultModel?: string;
}

export type PatchField<T = string> = T | { value: T; mode: "append" | "replace" };

export interface AgentUpdatePatch {
  workflow?: PatchField<string>;
  personality?: PatchField<string>;
  discordChannels?: string[];
  dataSources?: PatchField<string>;
  defaultModel?: PatchField<string>;
}

function normalizePatchField(
  field: PatchField<string> | undefined,
): { value: string; mode: "append" | "replace" } | undefined {
  if (field === undefined) return undefined;
  if (typeof field === "string") return { value: field, mode: "replace" };
  return { value: field.value, mode: field.mode ?? "replace" };
}

function readBetweenMarkers(text: string, start: string, end: string): string | null {
  const i = text.indexOf(start);
  if (i === -1) return null;
  const j = text.indexOf(end, i + start.length);
  if (j === -1) return null;
  // strip exactly one leading + trailing newline written by replaceBetweenMarkers
  return text
    .slice(i + start.length, j)
    .replace(/^\n/, "")
    .replace(/\n$/, "");
}

// ─── Section markers (Phase 17) ──────────────────────────────────────────────
const WORKFLOW_START = "<!-- claudeclaw:workflow:start -->";
const WORKFLOW_END = "<!-- claudeclaw:workflow:end -->";
const PERSONALITY_START = "<!-- claudeclaw:personality:start -->";
const PERSONALITY_END = "<!-- claudeclaw:personality:end -->";
const DISCORD_START = "<!-- claudeclaw:discord:start -->";
const DISCORD_END = "<!-- claudeclaw:discord:end -->";
const DATASOURCES_START = "<!-- claudeclaw:datasources:start -->";
const DATASOURCES_END = "<!-- claudeclaw:datasources:end -->";
const CLAUDE_MD_MODEL_START = "<!-- claudeclaw:model:start -->";
const CLAUDE_MD_MODEL_END = "<!-- claudeclaw:model:end -->";

function replaceBetweenMarkers(
  text: string,
  start: string,
  end: string,
  replacement: string,
): string | null {
  const i = text.indexOf(start);
  if (i === -1) return null;
  const j = text.indexOf(end, i + start.length);
  if (j === -1) return null;
  return text.slice(0, i + start.length) + "\n" + replacement + "\n" + text.slice(j);
}

function replaceLegacySection(text: string, heading: string, newBody: string): string {
  // Matches `## <heading>` block until next `## ` or EOF.
  const re = new RegExp(`(^|\\n)## ${heading}\\s*\\n[\\s\\S]*?(?=\\n## |$)`, "");
  const match = text.match(re);
  if (!match) return text;
  const replacement = `${match[1] ?? ""}## ${heading}\n\n${newBody}\n`;
  return text.replace(re, replacement);
}

function insertSectionAfterPersonality(text: string, sectionMarkdown: string): string {
  // Find Personality block, insert sectionMarkdown after its end (next `## ` or EOF).
  const re = /(^|\n)## Personality\s*\n[\s\S]*?(?=\n## |$)/;
  const match = text.match(re);
  if (!match) {
    // No Personality section — append at end.
    return text.replace(/\n*$/, "\n\n") + sectionMarkdown + "\n";
  }
  const end = (match.index ?? 0) + match[0].length;
  return text.slice(0, end) + "\n\n" + sectionMarkdown + text.slice(end);
}

export function applySoulPatch(soul: string, patch: AgentUpdatePatch): string {
  let out = soul;

  const personality = normalizePatchField(patch.personality);
  if (personality) {
    let value = personality.value;
    if (personality.mode === "append") {
      const current = readBetweenMarkers(out, PERSONALITY_START, PERSONALITY_END);
      if (current && current.length > 0) value = `${current}\n\n${value}`;
    }
    const replaced = replaceBetweenMarkers(out, PERSONALITY_START, PERSONALITY_END, value);
    if (replaced !== null) {
      out = replaced;
    } else {
      out = replaceLegacySection(out, "Personality", value);
    }
  }

  const workflow = normalizePatchField(patch.workflow);
  if (workflow) {
    let value = workflow.value;
    if (workflow.mode === "append") {
      const current = readBetweenMarkers(out, WORKFLOW_START, WORKFLOW_END);
      if (current && current.length > 0) value = `${current}\n\n${value}`;
    }
    const replaced = replaceBetweenMarkers(out, WORKFLOW_START, WORKFLOW_END, value);
    if (replaced !== null) {
      out = replaced;
    } else {
      const section = `## Workflow\n${WORKFLOW_START}\n${value}\n${WORKFLOW_END}`;
      out = insertSectionAfterPersonality(out, section);
    }
  }

  return out;
}

export function applyClaudeMdPatch(claudeMd: string, patch: AgentUpdatePatch): string {
  let out = claudeMd;

  if (patch.discordChannels !== undefined) {
    const body =
      patch.discordChannels.length > 0
        ? patch.discordChannels.map((c) => `- ${c}`).join("\n")
        : "_none specified_";
    const replaced = replaceBetweenMarkers(out, DISCORD_START, DISCORD_END, body);
    if (replaced !== null) {
      out = replaced;
    } else {
      out = replaceLegacySection(out, "Discord Channels", body);
    }
  }

  const dataSources = normalizePatchField(patch.dataSources);
  if (dataSources) {
    let value = dataSources.value;
    if (dataSources.mode === "append") {
      const current = readBetweenMarkers(out, DATASOURCES_START, DATASOURCES_END);
      if (current && current.length > 0 && current !== "_none specified_") {
        value = `${current}\n\n${value}`;
      }
    }
    const body = value.trim() || "_none specified_";
    const replaced = replaceBetweenMarkers(out, DATASOURCES_START, DATASOURCES_END, body);
    if (replaced !== null) {
      out = replaced;
    } else if (/\n## Data Sources\s*\n/.test(out) || /^## Data Sources\s*\n/.test(out)) {
      out = replaceLegacySection(out, "Data Sources", body);
    } else {
      // No section at all — append a new marked section at end.
      const section = `## Data Sources\n${DATASOURCES_START}\n${body}\n${DATASOURCES_END}\n`;
      out = out.replace(/\n*$/, "\n\n") + section;
    }
  }

  return out;
}

export interface AgentContext {
  name: string;
  dir: string;
  identityPath: string;
  soulPath: string;
  claudeMdPath: string;
  memoryPath: string;
  sessionPath: string;
  defaultModel?: string;
}

export interface AgentJob {
  label: string;
  cron: string;
  enabled: boolean;
  /** When true, the daemon keeps the cron schedule after each fire. When false,
   *  jobs.ts:clearJobSchedule() strips the schedule line on first run (one-shot). */
  recurring: boolean;
  model?: string;
  trigger: string;
  path: string;
}

const JOB_LABEL_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateJobLabel(label: string): { valid: boolean; error?: string } {
  if (!label || typeof label !== "string") {
    return { valid: false, error: "label required" };
  }
  if (label.includes("/") || label.includes("..") || label.includes("\\")) {
    return { valid: false, error: "must not contain path separators" };
  }
  if (!JOB_LABEL_RE.test(label)) {
    return { valid: false, error: "must be kebab-case" };
  }
  return { valid: true };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Name must be a non-empty string" };
  }
  if (!NAME_RE.test(name)) {
    return {
      valid: false,
      error:
        "Name must be kebab-case: lowercase letters, digits, hyphens; must start with a letter and not end with a hyphen",
    };
  }
  if (existsSync(join(agentsDir(), name))) {
    return { valid: false, error: `Agent "${name}" already exists` };
  }
  return { valid: true };
}

// ─── NL → cron ───────────────────────────────────────────────────────────────

const RAW_CRON_RE = /^([\d*,\-/]+)\s+([\d*,\-/]+)\s+([\d*,\-/]+)\s+([\d*,\-/]+)\s+([\d*,\-/]+)$/;

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseHour(timeStr: string): number | null {
  // Handles "9am", "9 am", "5pm", "12am", "12pm", "9", "09:00", "9:30",
  // plus named times: "noon", "midnight", "morning", "evening", "night"
  const s = timeStr.trim().toLowerCase();
  if (s === "noon") return 12;
  if (s === "midnight") return 0;
  if (s === "morning") return 9;
  if (s === "evening") return 18;
  if (s === "night") return 22;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "am") {
    if (h < 1 || h > 12) return null;
    if (h === 12) h = 0;
  } else if (ampm === "pm") {
    if (h < 1 || h > 12) return null;
    if (h !== 12) h += 12;
  }
  if (h < 0 || h > 23) return null;
  return h;
}

function safeCron(cron: string): string | null {
  try {
    cronMatches(cron, new Date());
    return cron;
  } catch {
    return null;
  }
}

export function parseScheduleToCron(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // Raw 5-field cron: validate via cronMatches
  if (RAW_CRON_RE.test(s)) {
    try {
      cronMatches(s, new Date());
      return s;
    } catch {
      return null;
    }
  }

  // Presets
  if (s === "hourly" || s === "every hour") return "0 * * * *";
  if (s === "daily" || s === "every day" || s === "every day at midnight") {
    return "0 0 * * *";
  }
  if (s === "weekly" || s === "every week") return "0 0 * * 0";

  // Phase 17 presets — N-times-daily (hard-coded standard slots)
  if (s === "twice daily") return safeCron("0 9,21 * * *");
  if (s === "thrice daily") return safeCron("0 9,13,17 * * *");
  if (s === "every weekend") return safeCron("0 0 * * 0,6");

  // every N minutes
  let m = s.match(/^every\s+(\d+)\s+minutes?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 60) return `*/${n} * * * *`;
    return null;
  }

  // every N hours (1..23)
  m = s.match(/^every\s+(\d+)\s+hours?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 23) return safeCron(`0 */${n} * * *`);
    return null;
  }

  // Multi-time per day: "every day at 7am and 7pm" / "daily at 9am, 1pm, 5pm"
  // Must come before single-time daily-at branch.
  m = s.match(/^(?:daily|every day)\s+at\s+(.+)$/);
  if (m) {
    const raw = m[1];
    if (/,| and /.test(raw)) {
      const parts = raw
        .split(/\s*,\s*|\s+and\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      const hours: number[] = [];
      for (const p of parts) {
        const h = parseHour(p);
        if (h === null) return null;
        hours.push(h);
      }
      if (hours.length >= 2) return safeCron(`0 ${hours.join(",")} * * *`);
    }
    // single time — fall through to existing daily-at branch below
  }

  // every weekday at <time>
  m = s.match(/^every\s+weekday(?:s)?(?:\s+at\s+(.+))?$/);
  if (m) {
    const t = m[1] ?? "9am";
    const h = parseHour(t);
    if (h === null) return null;
    return `0 ${h} * * 1-5`;
  }

  // daily at <time> / every day at <time>
  m = s.match(/^(?:daily|every day)\s+at\s+(.+)$/);
  if (m) {
    const h = parseHour(m[1]);
    if (h === null) return null;
    return `0 ${h} * * *`;
  }

  // every <dayname> [at <time>]
  m = s.match(/^every\s+(\w+?)s?(?:\s+at\s+(.+))?$/);
  if (m) {
    const day = DAY_NAMES[m[1]];
    if (day === undefined) return null;
    const h = m[2] ? parseHour(m[2]) : 0;
    if (h === null) return null;
    return `0 ${h} * * ${day}`;
  }

  return null;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function renderIdentity(name: string, role: string): string {
  return [
    `# Identity`,
    ``,
    `- **Name:** ${name}`,
    `- **Role:** ${role}`,
    `- **Creature:** A ClaudeClaw agent — a focused familiar with one job to do well.`,
    `- **Vibe:** Sharp, purposeful, gets things done.`,
    ``,
    `---`,
    ``,
    `This is who you are. Make it yours.`,
    ``,
  ].join("\n");
}

function renderSoul(personality: string, workflow?: string): string {
  const lines: string[] = [
    `_You're not a chatbot. You're becoming someone._`,
    ``,
    `## Personality`,
    PERSONALITY_START,
    personality,
    PERSONALITY_END,
    ``,
  ];
  if (workflow && workflow.trim()) {
    lines.push(`## Workflow`, WORKFLOW_START, workflow, WORKFLOW_END, ``);
  }
  lines.push(
    `## Core Truths`,
    ``,
    `**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.`,
    ``,
    `**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.`,
    ``,
    `**Be resourceful before asking.** Try to figure it out first.`,
    ``,
    `**Earn trust through competence.** Be careful with external actions, bold with internal ones.`,
    ``,
  );
  return lines.join("\n");
}

function renderClaudeMd(opts: AgentCreateOpts): string {
  const channels =
    opts.discordChannels && opts.discordChannels.length > 0
      ? opts.discordChannels.map((c) => `- ${c}`).join("\n")
      : "_none specified_";
  const sources =
    opts.dataSources && opts.dataSources.trim() ? opts.dataSources.trim() : "_none specified_";
  const lines = [
    `# Agent: ${opts.name}`,
    ``,
    `## Role`,
    ``,
    opts.role,
    ``,
    `## Discord Channels`,
    DISCORD_START,
    channels,
    DISCORD_END,
    ``,
    `## Data Sources`,
    DATASOURCES_START,
    sources,
    DATASOURCES_END,
    ``,
  ];
  const dm = opts.defaultModel ? opts.defaultModel.trim().toLowerCase() : "";
  if (dm) {
    lines.push(`## Default Model`, CLAUDE_MD_MODEL_START, dm, CLAUDE_MD_MODEL_END, ``);
  }
  return lines.join("\n");
}

function renderJobFile(
  label: string,
  cron: string,
  trigger: string,
  model?: string,
  recurring: boolean = true,
): string {
  const lines = [
    `---`,
    `label: ${label}`,
    `schedule: ${cron}`,
    `recurring: ${recurring}`,
    `enabled: true`,
  ];
  if (model) lines.push(`model: ${model}`);
  lines.push(`---`, ``, trigger, ``);
  return lines.join("\n");
}

function parseFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function parseJobFileContent(content: string): {
  label: string;
  cron: string;
  enabled: boolean;
  recurring: boolean;
  model?: string;
  trigger: string;
} | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1];
  const trigger = match[2].replace(/^\n+/, "").replace(/\n+$/, "");
  const lines = fm.split("\n").map((l) => l.trim());

  const labelLine = lines.find((l) => l.startsWith("label:"));
  // Accept both "schedule:" (canonical — matches native jobs.ts loader) and
  // legacy "cron:" (Phase 17 pre-fix files — supported for backward compatibility).
  const scheduleLine =
    lines.find((l) => l.startsWith("schedule:")) ?? lines.find((l) => l.startsWith("cron:"));
  if (!labelLine || !scheduleLine) return null;
  const label = parseFrontmatterValue(labelLine.replace("label:", ""));
  const cron = parseFrontmatterValue(
    scheduleLine.startsWith("schedule:")
      ? scheduleLine.replace("schedule:", "")
      : scheduleLine.replace("cron:", ""),
  );

  const enabledLine = lines.find((l) => l.startsWith("enabled:"));
  let enabled = true;
  if (enabledLine) {
    const v = parseFrontmatterValue(enabledLine.replace("enabled:", "")).toLowerCase();
    if (v === "false" || v === "no" || v === "0") enabled = false;
  }

  // Default false for legacy jobs without the field — preserves prior behaviour
  // where jobs.ts:clearJobSchedule() strips schedule: on first fire.
  const recurringLine = lines.find((l) => l.startsWith("recurring:"));
  let recurring = false;
  if (recurringLine) {
    const v = parseFrontmatterValue(recurringLine.replace("recurring:", "")).toLowerCase();
    recurring = v === "true" || v === "yes" || v === "1";
  }

  const modelLine = lines.find((l) => l.startsWith("model:"));
  const model = modelLine
    ? parseFrontmatterValue(modelLine.replace("model:", "")) || undefined
    : undefined;

  return { label, cron, enabled, recurring, model, trigger };
}

function validateCronOrThrow(cron: string): void {
  if (!cron || typeof cron !== "string") {
    throw new Error(`invalid cron expression: "${cron}"`);
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression: "${cron}" (expected 5 fields)`);
  }
  // Each field must contain only cron-valid chars
  const FIELD_RE = /^[\d*,\-/]+$/;
  for (const f of fields) {
    if (!FIELD_RE.test(f)) {
      throw new Error(`invalid cron expression: "${cron}"`);
    }
  }
  try {
    cronMatches(cron, new Date());
  } catch {
    throw new Error(`invalid cron expression: "${cron}"`);
  }
}

export async function addJob(
  agentName: string,
  label: string,
  cron: string,
  trigger: string,
  model?: string,
  recurring: boolean = true,
): Promise<AgentJob> {
  // Verify agent exists
  await loadAgent(agentName);

  const lv = validateJobLabel(label);
  if (!lv.valid) throw new Error(`invalid job label: ${lv.error}`);

  validateCronOrThrow(cron);

  await mkdir(agentJobsDir(agentName), { recursive: true });
  const path = jobFilePath(agentName, label);
  if (existsSync(path)) {
    throw new Error(`job ${label} already exists for agent ${agentName}`);
  }

  await writeFile(path, renderJobFile(label, cron, trigger, model, recurring), "utf8");

  return { label, cron, enabled: true, recurring, model, trigger, path };
}

export async function updateJob(
  agentName: string,
  label: string,
  patch: {
    cron?: string;
    trigger?: string;
    enabled?: boolean;
    recurring?: boolean;
    model?: string;
  },
): Promise<AgentJob> {
  const path = jobFilePath(agentName, label);
  if (!existsSync(path)) {
    throw new Error(`job ${label} does not exist for agent ${agentName}`);
  }
  const content = await readFile(path, "utf8");
  const parsed = parseJobFileContent(content);
  if (!parsed) throw new Error(`could not parse job file: ${path}`);

  const merged = {
    label: parsed.label,
    cron: patch.cron ?? parsed.cron,
    enabled: patch.enabled ?? parsed.enabled,
    recurring: patch.recurring ?? parsed.recurring,
    model: patch.model !== undefined ? patch.model : parsed.model,
    trigger: patch.trigger ?? parsed.trigger,
  };

  if (patch.cron !== undefined) validateCronOrThrow(merged.cron);

  // Render preserving recurring + enabled flags
  const lines = [
    `---`,
    `label: ${merged.label}`,
    `schedule: ${merged.cron}`,
    `recurring: ${merged.recurring}`,
    `enabled: ${merged.enabled}`,
  ];
  if (merged.model) lines.push(`model: ${merged.model}`);
  lines.push(`---`, ``, merged.trigger, ``);
  await writeFile(path, lines.join("\n"), "utf8");

  return { ...merged, path };
}

export async function removeJob(agentName: string, label: string): Promise<void> {
  await unlink(jobFilePath(agentName, label));
}

export async function listAgentJobs(agentName: string): Promise<AgentJob[]> {
  let files: string[];
  try {
    files = await readdir(agentJobsDir(agentName));
  } catch {
    return [];
  }
  const jobs: AgentJob[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const path = join(agentJobsDir(agentName), file);
    const content = await readFile(path, "utf8");
    const parsed = parseJobFileContent(content);
    if (parsed) {
      jobs.push({ ...parsed, path });
    }
  }
  jobs.sort((a, b) => a.label.localeCompare(b.label));
  return jobs;
}

export async function deleteAgent(name: string): Promise<void> {
  await rm(join(agentsDir(), name), { recursive: true, force: true });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createAgent(opts: AgentCreateOpts): Promise<AgentContext> {
  const v = validateAgentName(opts.name);
  if (!v.valid) {
    throw new Error(`Invalid agent name: ${v.error}`);
  }

  if (opts.defaultModel !== undefined && opts.defaultModel !== "") {
    validateModelString(opts.defaultModel, `agent:${opts.name}`);
  }

  const dir = join(agentsDir(), opts.name);
  await mkdir(dir, { recursive: true });

  const identityPath = join(dir, "IDENTITY.md");
  const soulPath = join(dir, "SOUL.md");
  const claudeMdPath = join(dir, "CLAUDE.md");
  const memoryPath = join(dir, "MEMORY.md");
  const sessionPath = join(dir, "session.json");
  const gitignorePath = join(dir, ".gitignore");

  await writeFile(identityPath, renderIdentity(opts.name, opts.role), "utf8");
  await writeFile(soulPath, renderSoul(opts.personality, opts.workflow), "utf8");
  await writeFile(claudeMdPath, renderClaudeMd(opts), "utf8");
  await ensureMemoryFile(opts.name);
  await writeFile(gitignorePath, "session.json\nMEMORY.md\n", "utf8");

  if (opts.schedule) {
    const cron = parseScheduleToCron(opts.schedule);
    if (!cron) {
      throw new Error(`Could not parse schedule: "${opts.schedule}"`);
    }
    // Validate the cron parses cleanly
    try {
      cronMatches(cron, new Date());
    } catch (e) {
      throw new Error(`Generated invalid cron "${cron}" from schedule "${opts.schedule}"`);
    }
    // Phase 17: scheduled tasks now live under agents/<name>/jobs/
    const body = opts.defaultPrompt ?? "Run your scheduled task per IDENTITY.md.";
    await addJob(opts.name, "default", cron, body, undefined);
  }

  return {
    name: opts.name,
    dir,
    identityPath,
    soulPath,
    claudeMdPath,
    memoryPath,
    sessionPath,
  };
}

/** Cheap existence check for a named agent (its config dir is present). */
export function agentExists(name: string): boolean {
  return typeof name === "string" && name.length > 0 && existsSync(join(agentsDir(), name));
}

export async function loadAgent(name: string): Promise<AgentContext> {
  const dir = join(agentsDir(), name);
  if (!existsSync(dir)) {
    throw new Error(`Agent "${name}" does not exist`);
  }
  const claudeMdPath = join(dir, "CLAUDE.md");
  let defaultModel: string | undefined;
  try {
    const cmd = await readFile(claudeMdPath, "utf8");
    const raw = readBetweenMarkers(cmd, CLAUDE_MD_MODEL_START, CLAUDE_MD_MODEL_END);
    if (raw !== null) {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed) defaultModel = trimmed;
    }
  } catch {
    // CLAUDE.md may not exist for agents created outside helpers
  }
  return {
    name,
    dir,
    identityPath: join(dir, "IDENTITY.md"),
    soulPath: join(dir, "SOUL.md"),
    claudeMdPath,
    memoryPath: join(dir, "MEMORY.md"),
    sessionPath: join(dir, "session.json"),
    defaultModel,
  };
}

/**
 * UPDATE-02 INVARIANT: updateAgent NEVER reads, writes, stats, or unlinks
 * agents/<name>/MEMORY.md, and NEVER touches agents/<name>/session.json.
 * Only SOUL.md and CLAUDE.md may be modified, via whole-file string transforms.
 */
function applyDefaultModelPatch(
  claudeMd: string,
  rawField: PatchField<string>,
  agentName: string,
): string {
  const norm = normalizePatchField(rawField);
  if (!norm) return claudeMd;
  if (norm.mode === "append") {
    throw new Error(
      "defaultModel is single-value; append mode is not supported (use replace or clear via empty string)",
    );
  }
  const value = norm.value.trim().toLowerCase();
  if (value !== "") {
    validateModelString(value, `agent:${agentName}`);
  }

  // If clearing: remove the marker block + optional `## Default Model` heading.
  if (value === "") {
    const i = claudeMd.indexOf(CLAUDE_MD_MODEL_START);
    if (i === -1) return claudeMd;
    const j = claudeMd.indexOf(CLAUDE_MD_MODEL_END, i + CLAUDE_MD_MODEL_START.length);
    if (j === -1) return claudeMd;
    const endOfBlock = j + CLAUDE_MD_MODEL_END.length;
    // Strip any preceding `## Default Model\n` heading
    const before = claudeMd.slice(0, i);
    const headingStripped = before.replace(/(?:^|\n)## Default Model\s*\n$/, "\n");
    // Remove trailing newline(s) after the end marker
    let after = claudeMd.slice(endOfBlock);
    after = after.replace(/^\n+/, "\n");
    return headingStripped + after;
  }

  // Replace existing block if present.
  const replaced = replaceBetweenMarkers(
    claudeMd,
    CLAUDE_MD_MODEL_START,
    CLAUDE_MD_MODEL_END,
    value,
  );
  if (replaced !== null) return replaced;

  // Append a new section at end.
  const section = `## Default Model\n${CLAUDE_MD_MODEL_START}\n${value}\n${CLAUDE_MD_MODEL_END}\n`;
  return claudeMd.replace(/\n*$/, "\n\n") + section;
}

export async function updateAgent(name: string, patch: AgentUpdatePatch): Promise<void> {
  const ctx = await loadAgent(name);
  const touchesSoul = patch.workflow !== undefined || patch.personality !== undefined;
  const touchesClaudeMd =
    patch.discordChannels !== undefined ||
    patch.dataSources !== undefined ||
    patch.defaultModel !== undefined;

  if (touchesSoul) {
    const soul = await readFile(ctx.soulPath, "utf8");
    const next = applySoulPatch(soul, patch);
    if (next !== soul) await writeFile(ctx.soulPath, next, "utf8");
  }

  if (touchesClaudeMd) {
    const claudeMd = await readFile(ctx.claudeMdPath, "utf8");
    let next = applyClaudeMdPatch(claudeMd, patch);
    if (patch.defaultModel !== undefined) {
      next = applyDefaultModelPatch(next, patch.defaultModel, name);
    }
    if (next !== claudeMd) await writeFile(ctx.claudeMdPath, next, "utf8");
  }
}

export async function listAgents(): Promise<string[]> {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const result: string[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(join(dir, entry));
      if (s.isDirectory()) result.push(entry);
    } catch {
      // skip
    }
  }
  return result.sort();
}
