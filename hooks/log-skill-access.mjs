#!/usr/bin/env node
/**
 * skill_access PRODUCER — a PostToolUse(Read) hook that appends one line to the
 * skill-access log every time a skill file UNDER the skills directory is read.
 *
 * This is the producer the `skill_access` telemetry stream consumes (see the
 * SkillAccessTelemetryProducer, host telemetry). Without it the stream is declared
 * but inert. Zero dependencies (Node only). Never blocks or fails the tool.
 *
 *   log path:   $CLAUDECLAW_SKILL_ACCESS_LOG  (default ~/.config/tuner/skill_accesses.jsonl)
 *   skills dir: $CLAUDECLAW_SKILLS_DIR         (default ~/.claude/skills)
 *
 * OPT-IN — ships DISABLED. A PostToolUse(Read) matcher is tool-name only (it can't
 * pre-filter to skill paths), so registering it always-on would fork a node process
 * on EVERY Read just to return null — standing per-read latency on a lightweight
 * daemon, feeding a stream nothing consumes until the #286 host-telemetry consumer
 * is live. So hooks/hooks.json ships with no PostToolUse entry. Enable it once the
 * consumer lands by adding this to your hooks config:
 *
 *   "PostToolUse": [
 *     { "matcher": "Read", "hooks": [
 *       { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/log-skill-access.mjs\"" }
 *     ] }
 *   ]
 */
import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, sep, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The consumer's contract paths (must match SkillAccessTelemetryProducer). */
export const DEFAULT_SKILLS_DIR = join(homedir(), ".claude", "skills");
export const DEFAULT_LOG_PATH = join(homedir(), ".config", "tuner", "skill_accesses.jsonl");
/** The producer owns its own trim: rotate the append-only log to `<path>.1` once
 *  it passes this size so it can't grow unbounded (one prior segment retained). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Rotate the log to `<path>.1` if it has grown past MAX_LOG_BYTES. Best-effort:
 *  a stat/rename failure must never block the write (the log is telemetry). */
export function rotateIfNeeded(log, maxBytes = MAX_LOG_BYTES) {
  try {
    if (statSync(log).size >= maxBytes) renameSync(log, `${log}.1`);
  } catch {
    /* first write (no file yet) or a race — nothing to rotate */
  }
}

/**
 * Pure: the log entry for a PostToolUse payload, or null if it is not a SUCCESSFUL
 * skill read. Both paths are RESOLVED first (collapses `..`, trailing separators and
 * non-canonical segments) so the boundary test is exact, not a raw string prefix.
 */
export function skillAccessEntry(payload, skillsDir, nowIso) {
  if (!payload || payload.tool_name !== "Read") return null;
  // Don't inflate telemetry with FAILED reads.
  const resp = payload.tool_response;
  if (resp && (resp.is_error === true || typeof resp.error === "string")) return null;
  const fpRaw = payload.tool_input && typeof payload.tool_input.file_path === "string" ? payload.tool_input.file_path : "";
  if (!fpRaw) return null;
  const fp = resolve(fpRaw);
  const base = resolve(skillsDir);
  if (fp !== base && !fp.startsWith(base + sep)) return null;
  return { skill_path: fp, accessed_at: nowIso };
}

// Run as a hook (stdin = the PostToolUse JSON). The guard uses pathToFileURL so it
// is correct under percent-encoding (spaces) and on Windows — not a raw concat.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("error", () => {}); // a stream error must never crash the hook
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { input += c; });
  process.stdin.on("end", () => {
    try {
      let skillsDir = process.env.CLAUDECLAW_SKILLS_DIR || DEFAULT_SKILLS_DIR;
      try { skillsDir = realpathSync.native(skillsDir); } catch { /* dir may not exist yet */ }
      const payload = JSON.parse(input || "{}");
      // Resolve the read path's symlinks (the file exists post-read) so a symlink
      // pointing OUTSIDE the skills dir is correctly rejected; fall back to raw.
      if (payload.tool_input && typeof payload.tool_input.file_path === "string") {
        try { payload.tool_input.file_path = realpathSync.native(payload.tool_input.file_path); } catch { /* keep raw */ }
      }
      const entry = skillAccessEntry(payload, skillsDir, new Date().toISOString());
      if (!entry) return;
      const log = process.env.CLAUDECLAW_SKILL_ACCESS_LOG || DEFAULT_LOG_PATH;
      mkdirSync(dirname(log), { recursive: true });
      rotateIfNeeded(log);
      appendFileSync(log, JSON.stringify(entry) + "\n");
    } catch {
      /* never block or fail the tool on a logging error */
    }
  });
}
