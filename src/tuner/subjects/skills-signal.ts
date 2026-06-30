/**
 * skills-signal — the skills subject's LOCAL degradation signal: the ratio of DEAD
 * skills (present on disk but never accessed). Read from the skills dir(s) + the
 * skill_access log. High dead-ratio = the skill set is bloated/undiscoverable → a
 * trigger to research skill-design (consolidation / description optimization).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/** A skill_access log older than this is treated as STALE (logging broken) → untrusted. */
export const SKILL_LOG_MAX_AGE_MS = 14 * 86_400_000;
import { join, basename } from "node:path";

export interface SkillsHealth {
  totalSkills: number;
  deadSkills: number;
  deadRatio: number;
  logFresh: boolean;
}

export function listSkillNames(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) {
        names.add(f.replace(/\.md$/, ""));
        continue;
      }
      try {
        if (statSync(join(dir, f)).isDirectory() && existsSync(join(dir, f, "SKILL.md")))
          names.add(f);
      } catch {
        /* skip */
      }
    }
  }
  return [...names];
}

export function accessedSkills(accessLog: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(accessLog)) return out;
  for (const line of readFileSync(accessLog, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const p = String(o.skill_path ?? o.skill ?? "");
      if (p) out.add(basename(p).replace(/\.md$/, ""));
    } catch {
      /* skip */
    }
  }
  return out;
}

export function skillsHealth(dirs: string[], accessLog: string, nowMs = Date.now()): SkillsHealth {
  const skills = listSkillNames(dirs);
  const accessed = accessedSkills(accessLog);
  const dead = skills.filter((s) => !accessed.has(s)).length;
  // The dead-ratio is only meaningful if the access log is actively being written.
  // A stale/missing log means BROKEN logging, not unused skills — never trust it.
  let logFresh = false;
  if (existsSync(accessLog)) {
    try {
      logFresh = nowMs - statSync(accessLog).mtimeMs < SKILL_LOG_MAX_AGE_MS && accessed.size > 0;
    } catch {
      logFresh = false;
    }
  }
  return {
    totalSkills: skills.length,
    deadSkills: dead,
    deadRatio: skills.length ? dead / skills.length : 0,
    logFresh,
  };
}
