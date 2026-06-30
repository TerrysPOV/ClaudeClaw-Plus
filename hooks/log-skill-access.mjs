#!/usr/bin/env node
/**
 * skill_access PRODUCER — a PostToolUse(Read) hook that appends one line to the
 * skill-access log every time a skill file under the skills directory is read.
 *
 * This is the producer the `skill_access` telemetry stream consumes (see the
 * SkillAccessTelemetryProducer, host telemetry). Without it the stream is declared
 * but inert: the host advertises `skill_access` yet never emits. The hook closes
 * that gap with zero dependencies (Node only) and never blocks the tool.
 *
 *   log path:   $CLAUDECLAW_SKILL_ACCESS_LOG  (default ~/.config/tuner/skill_accesses.jsonl)
 *   skills dir: $CLAUDECLAW_SKILLS_DIR         (default ~/.claude/skills)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, sep } from "node:path";

/** Pure: the log entry for a PostToolUse payload, or null if it is not a skill read. */
export function skillAccessEntry(payload, skillsDir, nowIso) {
  if (!payload || payload.tool_name !== "Read") return null;
  const fp = payload.tool_input && typeof payload.tool_input.file_path === "string" ? payload.tool_input.file_path : "";
  if (!fp) return null;
  // only reads UNDER the skills dir count (a real subdir/file boundary, not a prefix coincidence)
  if (fp !== skillsDir && !fp.startsWith(skillsDir + sep)) return null;
  return { skill_path: fp, accessed_at: nowIso };
}

// Run as a hook (stdin = the PostToolUse JSON). Importable for tests via the guard.
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => {
    try {
      const skillsDir = process.env.CLAUDECLAW_SKILLS_DIR || join(homedir(), ".claude", "skills");
      const entry = skillAccessEntry(JSON.parse(input || "{}"), skillsDir, new Date().toISOString());
      if (!entry) return;
      const log = process.env.CLAUDECLAW_SKILL_ACCESS_LOG || join(homedir(), ".config", "tuner", "skill_accesses.jsonl");
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, JSON.stringify(entry) + "\n");
    } catch {
      /* never block or fail the tool on a logging error */
    }
  });
}
