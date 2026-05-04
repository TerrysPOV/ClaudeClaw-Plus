/**
 * Tests for jobs.ts — Phase 17 multi-job loader extension.
 *
 * Run with: bun test src/__tests__/jobs.test.ts
 */

import { describe, it, expect, afterEach, test, beforeEach, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { loadJobs, validateModelString, resolveJobModel, VALID_MODEL_STRINGS, type Job } from "../jobs";
import { spyOn } from "bun:test";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");
const JOBS_DIR = join(PROJECT, ".claude", "claudeclaw", "jobs");

const TEST_PREFIX = "tst-jobs-";
const createdAgents: string[] = [];
const createdJobFiles: string[] = [];

function uniq(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  return name;
}

async function writeAgentJob(agent: string, label: string, frontmatter: string, body = "do the thing"): Promise<void> {
  const dir = join(AGENTS_DIR, agent, "jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.md`), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  createdAgents.push(agent);
}

async function writeFlatJob(name: string, frontmatter: string, body = "flat thing"): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
  const path = join(JOBS_DIR, `${name}.md`);
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  createdJobFiles.push(path);
}

afterEach(async () => {
  for (const a of createdAgents.splice(0)) {
    await rm(join(AGENTS_DIR, a), { recursive: true, force: true });
  }
  for (const f of createdJobFiles.splice(0)) {
    await rm(f, { force: true });
  }
});

describe("Phase 17: loadJobs multi-source", () => {
  it("loads agent job from agents/<name>/jobs/<label>.md", async () => {
    const agent = uniq("multi");
    await writeAgentJob(agent, "foo", "schedule: 0 9 * * *\nrecurring: true");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/foo`);
    expect(job).toBeDefined();
    expect(job!.agent).toBe(agent);
    expect(job!.label).toBe("foo");
    expect(job!.schedule).toBe("0 9 * * *");
  });

  it("loads standalone flat-dir job without agent field", async () => {
    const name = uniq("standalone");
    await writeFlatJob(name, "schedule: 0 10 * * *\nrecurring: false");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === name);
    expect(job).toBeDefined();
    expect(job!.agent).toBeUndefined();
    expect(job!.label).toBe(name);
  });

  it("excludes jobs with enabled: false", async () => {
    const agent = uniq("dis");
    await writeAgentJob(agent, "off", "schedule: 0 9 * * *\nrecurring: true\nenabled: false");

    const jobs = await loadJobs();
    expect(jobs.find((j) => j.name === `${agent}/off`)).toBeUndefined();
  });

  it("parses model field", async () => {
    const agent = uniq("model");
    await writeAgentJob(agent, "x", "schedule: 0 9 * * *\nrecurring: true\nmodel: opus");

    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/x`);
    expect(job!.model).toBe("opus");
  });

  it("does not throw when agents/<name>/jobs/ missing for an agent", async () => {
    const agent = uniq("empty");
    await mkdir(join(AGENTS_DIR, agent), { recursive: true });
    createdAgents.push(agent);

    const jobs = await loadJobs();
    expect(Array.isArray(jobs)).toBe(true);
  });

  it("directory location overrides any frontmatter agent: field", async () => {
    const agent = uniq("auth");
    await writeAgentJob(agent, "bar", `schedule: 0 9 * * *\nrecurring: true\nagent: someone-else`);
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.name === `${agent}/bar`);
    expect(job!.agent).toBe(agent);
  });
});

describe("Phase 18: validateModelString", () => {
  it("allows undefined", () => {
    expect(() => validateModelString(undefined, "ctx")).not.toThrow();
  });
  it("allows empty string", () => {
    expect(() => validateModelString("", "ctx")).not.toThrow();
  });
  it("allows opus/sonnet/haiku/glm", () => {
    for (const m of ["opus", "sonnet", "haiku", "glm"]) {
      expect(() => validateModelString(m, "ctx")).not.toThrow();
    }
  });
  it("is case-insensitive and trimmed", () => {
    expect(() => validateModelString("  OPUS  ", "ctx")).not.toThrow();
  });
  it("rejects unknown model with context + allowed list in message", () => {
    let caught: Error | null = null;
    try {
      validateModelString("opuz", "reg/digest-scan");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("opuz");
    expect(caught!.message).toContain("reg/digest-scan");
    expect(caught!.message).toContain("opus");
    expect(caught!.message).toContain("sonnet");
    expect(caught!.message).toContain("haiku");
    expect(caught!.message).toContain("glm");
  });
  it("VALID_MODEL_STRINGS contains exactly the four models", () => {
    expect(VALID_MODEL_STRINGS.size).toBe(4);
    expect([...VALID_MODEL_STRINGS].sort()).toEqual(["glm", "haiku", "opus", "sonnet"]);
  });
});

describe("Phase 18: resolveJobModel", () => {
  const baseJob: Job = {
    name: "x",
    schedule: "0 9 * * *",
    prompt: "",
    recurring: true,
    notify: true,
  };
  it("returns lowercased trimmed model when set", async () => {
    expect(await resolveJobModel({ ...baseJob, model: "OPUS " })).toBe("opus");
  });
  it("returns undefined when model is undefined", async () => {
    expect(await resolveJobModel({ ...baseJob })).toBeUndefined();
  });
  it("returns undefined when model is empty string", async () => {
    expect(await resolveJobModel({ ...baseJob, model: "" })).toBeUndefined();
  });
});

describe("Phase 18 Plan 02: resolveJobModel cascade to agent defaultModel", () => {
  const baseJob: Job = {
    name: "x",
    schedule: "0 9 * * *",
    prompt: "",
    recurring: true,
    notify: true,
  };

  it("job.model wins over agent defaultModel", async () => {
    const { createAgent } = await import("../agents");
    const agent = uniq("cascade-win");
    await createAgent({
      name: agent,
      role: "tester",
      personality: "calm",
      defaultModel: "opus",
    } as any);
    createdAgents.push(agent);
    const resolved = await resolveJobModel({ ...baseJob, agent, model: "sonnet" });
    expect(resolved).toBe("sonnet");
  });

  it("falls back to agent defaultModel when job has no model", async () => {
    const { createAgent } = await import("../agents");
    const agent = uniq("cascade-fallback");
    await createAgent({
      name: agent,
      role: "tester",
      personality: "calm",
      defaultModel: "opus",
    } as any);
    createdAgents.push(agent);
    const resolved = await resolveJobModel({ ...baseJob, agent });
    expect(resolved).toBe("opus");
  });

  it("returns undefined when job has no model and agent has no defaultModel", async () => {
    const { createAgent } = await import("../agents");
    const agent = uniq("cascade-none");
    await createAgent({ name: agent, role: "tester", personality: "calm" });
    createdAgents.push(agent);
    const resolved = await resolveJobModel({ ...baseJob, agent });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for standalone job (no agent) with no model", async () => {
    const resolved = await resolveJobModel({ ...baseJob });
    expect(resolved).toBeUndefined();
  });

  it("returns model for standalone job (no agent) with model set", async () => {
    const resolved = await resolveJobModel({ ...baseJob, model: "haiku" });
    expect(resolved).toBe("haiku");
  });

  it("falls through to undefined when loadAgent throws (nonexistent agent)", async () => {
    const resolved = await resolveJobModel({ ...baseJob, agent: "zz-does-not-exist-xyz" });
    expect(resolved).toBeUndefined();
  });
});

describe("Phase 18: loadJobs invalid model rejection", () => {
  it("skips agent job with invalid model and logs error; valid sibling still loads", async () => {
    const agent = uniq("badmodel");
    await writeAgentJob(agent, "bad", "schedule: 0 9 * * *\nrecurring: true\nmodel: opuz");
    await writeAgentJob(agent, "good", "schedule: 0 9 * * *\nrecurring: true\nmodel: opus");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const jobs = await loadJobs();
      const bad = jobs.find((j) => j.name === `${agent}/bad`);
      const good = jobs.find((j) => j.name === `${agent}/good`);
      expect(bad).toBeUndefined();
      expect(good).toBeDefined();
      expect(good!.model).toBe("opus");
      const logged = errSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes(`Skipping job ${agent}:bad`),
      );
      expect(logged).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ─── Integration tests (upstream sandbox-based) ──────────────────────────────

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-jobs");
const LEGACY_JOBS_DIR = join(TEST_ROOT, ".claude", "claudeclaw", "jobs");
const SANDBOX_AGENTS_DIR = join(TEST_ROOT, "agents");

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(LEGACY_JOBS_DIR, { recursive: true });
  await mkdir(join(SANDBOX_AGENTS_DIR, "suzy", "jobs"), { recursive: true });
  await mkdir(join(SANDBOX_AGENTS_DIR, "reg", "jobs"), { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function jobMd(schedule: string, prompt: string, extra = ""): string {
  const extras = extra ? extra + "\n" : "";
  return `---\nschedule: ${schedule}\nrecurring: true\n${extras}---\n${prompt}\n`;
}

/** Run loadJobs() in the sandbox dir via a child bun process (so process.cwd() == TEST_ROOT). */
async function loadJobsInSandbox(): Promise<import("../jobs").Job[]> {
  const script = `
import { loadJobs } from ${JSON.stringify(join(import.meta.dir, "..", "jobs"))};
const jobs = await loadJobs();
process.stdout.write(JSON.stringify(jobs));
`;
  const scriptPath = join(TEST_ROOT, "_run.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out || "[]");
}

describe("loadJobs (sandbox integration)", () => {
  beforeEach(resetSandbox);

  test("empty dirs → zero jobs, no throw", async () => {
    const jobs = await loadJobsInSandbox();
    expect(jobs).toEqual([]);
  });

  test("loads job from legacy .claude/claudeclaw/jobs/", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "nightly.md"),
      jobMd("0 3 * * *", "Run nightly report")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "nightly");
    expect(job).toBeDefined();
    expect(job?.agent).toBeUndefined(); // not agent-scoped
    expect(job?.schedule).toBe("0 3 * * *");
    expect(job?.prompt).toBe("Run nightly report");
  });

  test("loads job from agents/<name>/jobs/ (Phase 17 path)", async () => {
    await writeFile(
      join(SANDBOX_AGENTS_DIR, "suzy", "jobs", "daily-digest.md"),
      jobMd("0 9 * * *", "Summarise today's news")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "suzy/daily-digest");
    expect(job).toBeDefined();
    expect(job?.agent).toBe("suzy");
    expect(job?.label).toBe("daily-digest");
    expect(job?.schedule).toBe("0 9 * * *");
    expect(job?.prompt).toBe("Summarise today's news");
  });

  test("directory location overrides frontmatter agent field", async () => {
    // Even if the .md file says agent: wrong, the enclosing dir wins.
    await writeFile(
      join(SANDBOX_AGENTS_DIR, "reg", "jobs", "seo.md"),
      jobMd("30 10 * * *", "SEO review", "agent: wrong-agent")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "reg/seo");
    expect(job?.agent).toBe("reg");
  });

  test("enabled: false excludes job", async () => {
    await writeFile(
      join(SANDBOX_AGENTS_DIR, "suzy", "jobs", "disabled.md"),
      jobMd("0 12 * * *", "Disabled", "enabled: false")
    );
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/disabled")).toBeUndefined();
  });

  test("returns jobs from both legacy and agent-scoped locations together", async () => {
    await writeFile(join(LEGACY_JOBS_DIR, "nightly.md"), jobMd("0 3 * * *", "Nightly"));
    await writeFile(join(SANDBOX_AGENTS_DIR, "suzy", "jobs", "morning.md"), jobMd("0 9 * * *", "Morning"));
    const jobs = await loadJobsInSandbox();
    const names = jobs.map((j) => j.name);
    expect(names).toContain("nightly");
    expect(names).toContain("suzy/morning");
  });

  test("missing agents/ dir is silently ignored (no throw)", async () => {
    await rm(SANDBOX_AGENTS_DIR, { recursive: true, force: true });
    const jobs = await loadJobsInSandbox();
    expect(Array.isArray(jobs)).toBe(true);
  });

  test("agent dir without jobs/ subdir is skipped", async () => {
    // publisher/ exists but has no jobs/ subdirectory
    await mkdir(join(SANDBOX_AGENTS_DIR, "publisher"), { recursive: true });
    const jobs = await loadJobsInSandbox();
    expect(jobs.filter((j) => j.name.startsWith("publisher/"))).toEqual([]);
  });

  test("job file without schedule: field is skipped gracefully", async () => {
    await writeFile(
      join(SANDBOX_AGENTS_DIR, "suzy", "jobs", "bad.md"),
      "---\nprompt: test\n---\nNo schedule line.\n"
    );
    // Should not throw, should return other valid jobs
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/bad")).toBeUndefined();
  });
});

// ─── Unit: Job type and session path assertions ───────────────────────────────

describe("Job type", () => {
  test("includes agent, label, enabled fields", () => {
    const job: import("../jobs").Job = {
      name: "agent/job",
      schedule: "0 9 * * *",
      prompt: "test",
      recurring: true,
      notify: true,
      agent: "myagent",
      label: "myjob",
      enabled: true,
    };
    expect(job.agent).toBe("myagent");
    expect(job.label).toBe("myjob");
    expect(job.enabled).toBe(true);
  });
});

describe("sessions — agent-scoped paths", () => {
  test("getSession/createSession/incrementTurn accept optional agentName", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // All public functions should have agentName? param
    expect(src).toContain("getSession(\n  agentName?: string");
    expect(src).toContain("createSession(sessionId: string, agentName?: string)");
    expect(src).toContain("incrementTurn(agentName?: string)");
    expect(src).toContain("markCompactWarned(agentName?: string)");
  });

  test("agent sessions stored outside .claude/", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // Verify path uses getAgentsDir() (project root) not HEARTBEAT_DIR (.claude/...)
    expect(src).toContain('join(getAgentsDir(), agentName, "session.json")');
  });

  test("fallback sessions can be scoped by thread id", async () => {
    const sessionsSrc = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    const runnerSrc = await Bun.file(join(import.meta.dir, "../runner.ts")).text();
    const discordSrc = await Bun.file(join(import.meta.dir, "../commands/discord.ts")).text();

    expect(sessionsSrc).toContain('join(HEARTBEAT_DIR, "fallback-sessions", `${encodeURIComponent(threadId)}.json`)');
    expect(sessionsSrc).toContain("getFallbackSession(\n  agentName?: string,\n  threadId?: string");
    expect(runnerSrc).toContain("getFallbackSession(agentName, threadId)");
    expect(runnerSrc).toContain("createFallbackSession(exec.sessionId, agentName, threadId)");
    expect(discordSrc).toContain("resetFallbackSession(undefined, interaction.channel_id!)");
  });
});

// ─── Unit: protection-bug validation (the core motivation) ───────────────────

describe("write-protection bug validation", () => {
  test("agent-scoped job path is outside .claude/ (key property)", () => {
    // The Claude Code CLI hardcodes a protection list for .claude/ paths.
    // Agent-scoped jobs live at agents/<name>/jobs/<job>.md — no .claude/ prefix.
    // This test documents the requirement explicitly.
    const legacyPath = join(process.cwd(), ".claude", "claudeclaw", "jobs", "job.md");
    const agentPath = join(process.cwd(), "agents", "suzy", "jobs", "daily.md");
    expect(legacyPath).toContain("/.claude/");
    expect(agentPath).not.toContain("/.claude/");
  });
});
