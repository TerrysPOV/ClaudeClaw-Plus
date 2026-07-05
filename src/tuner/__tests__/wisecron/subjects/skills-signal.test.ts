/**
 * accessedSkills must derive the SAME skill name that listSkillNames advertises,
 * for both skill layouts, or a dir-format skill's reads never match its name and
 * it looks perpetually unused (inflated dead-ratio → spurious "dead skill"
 * proposal). Copilot review on #293.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessedSkills } from "../../../subjects/skills-signal.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-signal-"));
  logPath = join(dir, "skill_accesses.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("accessedSkills — name derivation matches listSkillNames", () => {
  it("directory-format skill (<skill>/SKILL.md) → parent dir name, not 'SKILL'", () => {
    writeFileSync(
      logPath,
      `${JSON.stringify({ skill_path: "/home/x/.claude/skills/deploy-helper/SKILL.md" })}\n`,
    );
    const set = accessedSkills(logPath);
    expect(set.has("deploy-helper")).toBe(true);
    expect(set.has("SKILL")).toBe(false);
  });

  it("single-file skill (<skill>.md) → basename without extension", () => {
    writeFileSync(
      logPath,
      `${JSON.stringify({ skill_path: "/home/x/.claude/skills/quick-note.md" })}\n`,
    );
    const set = accessedSkills(logPath);
    expect(set.has("quick-note")).toBe(true);
  });

  it("mixed log + a malformed line is skipped", () => {
    writeFileSync(
      logPath,
      [
        JSON.stringify({ skill_path: "/s/alpha/SKILL.md" }),
        "not json",
        JSON.stringify({ skill: "/s/beta.md" }),
      ].join("\n"),
    );
    const set = accessedSkills(logPath);
    expect([...set].sort()).toEqual(["alpha", "beta"]);
  });
});
