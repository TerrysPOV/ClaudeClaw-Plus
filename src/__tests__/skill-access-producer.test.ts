import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  skillAccessEntry,
  DEFAULT_LOG_PATH,
  DEFAULT_SKILLS_DIR,
} from "../../hooks/log-skill-access.mjs";

const NOW = "2026-06-30T00:00:00Z";
const SKILLS = "/home/x/.claude/skills";
const HOOK = join(import.meta.dir, "..", "..", "hooks", "log-skill-access.mjs");

describe("skill_access producer — skillAccessEntry (pure)", () => {
  it("logs a Read under the skills dir (path resolved)", () => {
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
  it("rejects a …/skills-evil prefix coincidence", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: `${SKILLS}-evil/x.md` } },
        SKILLS,
        NOW,
      ),
    ).toBeNull();
  });
  it("rejects a `..` traversal escaping the skills dir", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: `${SKILLS}/../../../etc/passwd` } },
        SKILLS,
        NOW,
      ),
    ).toBeNull();
  });
  it("normalizes a TRAILING-SLASH skills dir (still logs)", () => {
    expect(
      skillAccessEntry(
        { tool_name: "Read", tool_input: { file_path: `${SKILLS}/foo.md` } },
        `${SKILLS}/`,
        NOW,
      ),
    ).toEqual({ skill_path: `${SKILLS}/foo.md`, accessed_at: NOW });
  });
  it("ignores a FAILED read (tool_response.is_error)", () => {
    expect(
      skillAccessEntry(
        {
          tool_name: "Read",
          tool_input: { file_path: `${SKILLS}/foo.md` },
          tool_response: { is_error: true },
        },
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

describe("skill_access producer — contract with the #286 consumer", () => {
  it("default paths match the consumer's read path", () => {
    expect(DEFAULT_LOG_PATH).toBe(join(homedir(), ".config", "tuner", "skill_accesses.jsonl"));
    expect(DEFAULT_SKILLS_DIR).toBe(join(homedir(), ".claude", "skills"));
  });
});

describe("skill_access producer — hook integration", () => {
  let dir: string, log: string, skillsDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skacc-"));
    log = join(dir, "access.jsonl");
    skillsDir = join(dir, "skills");
    mkdirSync(skillsDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (payload: unknown) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDECLAW_SKILL_ACCESS_LOG: log, CLAUDECLAW_SKILLS_DIR: skillsDir },
      encoding: "utf8",
    });

  it("appends one line for a skill read, nothing for a non-skill read", () => {
    const skill = join(skillsDir, "a.md");
    writeFileSync(skill, "skill");
    run({ tool_name: "Read", tool_input: { file_path: skill } });
    run({ tool_name: "Read", tool_input: { file_path: "/tmp/other.md" } });
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]!);
    expect(e.skill_path).toContain("a.md");
    expect(e.accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects a symlink under skills that points OUTSIDE (realpath resolution)", () => {
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    const link = join(skillsDir, "evil.md");
    symlinkSync(outside, link);
    run({ tool_name: "Read", tool_input: { file_path: link } });
    expect(existsSync(log)).toBe(false); // resolved target is outside skills → not logged
  });

  it("never errors on malformed input (does not block the tool)", () => {
    const r = run("not json at all" as unknown);
    expect(r.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
