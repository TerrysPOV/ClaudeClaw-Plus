import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillAccessEntry } from "../../hooks/log-skill-access.mjs";

const NOW = "2026-06-30T00:00:00Z";
const SKILLS = "/home/x/.claude/skills";
const HOOK = join(import.meta.dir, "..", "..", "hooks", "log-skill-access.mjs");

describe("skill_access producer — skillAccessEntry (pure)", () => {
  it("logs a Read under the skills dir", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: `${SKILLS}/foo/SKILL.md` } },
        SKILLS,
        NOW,
      ),
    ).toEqual({ skill_path: `${SKILLS}/foo/SKILL.md`, accessed_at: NOW });
  });
  it("ignores a Read OUTSIDE the skills dir", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: "/home/x/notes.md" } },
        SKILLS,
        NOW,
      ),
    ).toBeNull();
  });
  it("ignores a non-Read tool", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Edit", tool_input: { file_path: `${SKILLS}/foo.md` } },
        SKILLS,
        NOW,
      ),
    ).toBeNull();
  });
  it("rejects a prefix-coincidence (…/skills-evil)", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: `${SKILLS}-evil/x.md` } },
        SKILLS,
        NOW,
      ),
    ).toBeNull();
  });
  it("ignores a missing/blank file_path", () => {
    expect(skillAccessEntry({ tool_name: "Read", tool_input: {} }, SKILLS, NOW)).toBeNull();
    expect(skillAccessEntry({}, SKILLS, NOW)).toBeNull();
  });
});

describe("skill_access producer — hook integration", () => {
  let dir: string, log: string, skillsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skacc-"));
    log = join(dir, "access.jsonl");
    skillsDir = join(dir, "skills");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (payload: unknown) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDECLAW_SKILL_ACCESS_LOG: log, CLAUDECLAW_SKILLS_DIR: skillsDir },
      encoding: "utf8",
    });

  it("appends one line for a skill read, nothing for a non-skill read", () => {
    run({ tool_name: "Read", tool_input: { file_path: join(skillsDir, "a", "SKILL.md") } });
    run({ tool_name: "Read", tool_input: { file_path: "/tmp/other.md" } });
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).skill_path).toContain("SKILL.md");
  });

  it("never errors on malformed input (does not block the tool)", () => {
    const r = run("not json at all" as unknown);
    expect(r.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
