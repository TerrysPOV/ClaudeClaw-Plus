import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
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
  rotateIfNeeded,
  DEFAULT_LOG_PATH,
  DEFAULT_SKILLS_DIR,
} from "../../hooks/log-skill-access.mjs";

const NOW = "2026-06-30T00:00:00Z";
const SKILLS = "/home/x/.claude/skills";
const HOOK = join(import.meta.dir, "..", "..", "hooks", "log-skill-access.mjs");
// Hook-integration cases spawn node (several times in one case). Cold start on a slow CI
// runner blew bun's 5 s default (#577), so give them headroom above the poll bound.
const POLL_STEP_MS = 50;
const POLL_MAX_MS = 10_000;
const HOOK_TEST_TIMEOUT_MS = 20_000;

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
  const run = (payload: unknown) => runRaw(JSON.stringify(payload));
  // Sends the stdin bytes verbatim (no JSON.stringify) so we can feed genuinely
  // malformed JSON, not a valid JSON string. Resolves only once the hook process has
  // EXITED ("close"), so any "nothing was written" assertion made afterwards is made
  // against a finished hook, not a fixed sleep. A spawn failure rejects loudly rather
  // than looking like "the hook chose not to log".
  const runRaw = (input: string) =>
    new Promise<{ status: number | null; stderr: string }>((resolveRun, reject) => {
      const child = spawn("node", [HOOK], {
        env: { ...process.env, CLAUDECLAW_SKILL_ACCESS_LOG: log, CLAUDECLAW_SKILLS_DIR: skillsDir },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
      });
      child.on("error", reject);
      child.on("close", (status) => resolveRun({ status, stderr }));
      child.stdin.on("error", () => {}); // the hook may exit before reading all of stdin
      child.stdin.end(input);
    });
  // Poll (bounded) rather than assert once: node cold start on a loaded CI runner is
  // far slower than the ~0.3 s seen locally (#577).
  const waitFor = async (pred: () => boolean, maxMs = POLL_MAX_MS) => {
    for (let waited = 0; !pred() && waited < maxMs; waited += POLL_STEP_MS) {
      await new Promise((r) => setTimeout(r, POLL_STEP_MS));
    }
    return pred();
  };

  it(
    "appends one line for a skill read, nothing for a non-skill read",
    async () => {
      const skill = join(skillsDir, "a.md");
      writeFileSync(skill, "skill");
      const first = await run({ tool_name: "Read", tool_input: { file_path: skill } });
      const second = await run({ tool_name: "Read", tool_input: { file_path: "/tmp/other.md" } });
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(await waitFor(() => existsSync(log))).toBe(true);
      const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const e = JSON.parse(lines[0]!);
      expect(e.skill_path).toContain("a.md");
      expect(e.accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    },
    HOOK_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a symlink under skills that points OUTSIDE (realpath resolution)",
    async () => {
      const outside = join(dir, "secret.txt");
      writeFileSync(outside, "secret");
      const link = join(skillsDir, "evil.md");
      symlinkSync(outside, link);
      const r = await run({ tool_name: "Read", tool_input: { file_path: link } });
      expect(r.status).toBe(0); // hook has exited, so a missing log means "rejected", not "not yet"
      expect(existsSync(log)).toBe(false); // resolved target is outside skills → not logged
    },
    HOOK_TEST_TIMEOUT_MS,
  );

  it(
    "never errors on genuinely malformed JSON (does not block the tool)",
    async () => {
      // Raw bytes, NOT JSON.stringify'd — this actually breaks JSON.parse (a bare
      // stringified value would have parsed fine and not exercised the catch).
      // Independent inputs, so spawn them together: sequential cold starts would multiply.
      const results = await Promise.all(["{ broken", "not json at all", "", "{"].map(runRaw));
      for (const r of results) expect(r.status).toBe(0);
      expect(existsSync(log)).toBe(false);
    },
    HOOK_TEST_TIMEOUT_MS,
  );
});

describe("skill_access producer — log rotation (producer owns the trim)", () => {
  let dir: string, log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skacc-rot-"));
    log = join(dir, "access.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rotates to <path>.1 once the log passes the cap", () => {
    writeFileSync(log, "x".repeat(200));
    rotateIfNeeded(log, 100); // cap below current size → rotate
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(existsSync(log)).toBe(false); // next append recreates a fresh file
  });

  it("does not rotate below the cap, and is a no-op when the file is absent", () => {
    writeFileSync(log, "x".repeat(50));
    rotateIfNeeded(log, 100);
    expect(existsSync(`${log}.1`)).toBe(false);
    // absent file: must not throw
    expect(() => rotateIfNeeded(join(dir, "nope.jsonl"), 100)).not.toThrow();
  });
});
