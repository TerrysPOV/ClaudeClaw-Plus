/**
 * Phase 18 Plan 03 Task 2 — End-to-end model override integration test
 *
 * Walks the full chain: createAgent + addJob → loadJobs → resolveJobModel → run → runClaudeOnce spy.
 * Uses real filesystem fixtures scoped by a unique agent-name prefix to avoid colliding
 * with real agents or other tests (matching the pattern established in agents.test.ts).
 *
 * Run with: bun test src/__tests__/integration/model-override.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { createAgent } from "../../agents";
import { loadJobs, resolveJobModel, type Job } from "../../jobs";
import * as runnerMod from "../../runner";
import { initConfig, loadSettings } from "../../config";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");
const TEST_PREFIX = "tst-p1803-";
const created: string[] = [];

function uniq(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  created.push(name);
  return name;
}

async function cleanup(): Promise<void> {
  for (const name of created) {
    await rm(join(AGENTS_DIR, name), { recursive: true, force: true });
  }
  created.length = 0;
}

/**
 * Write a job file directly, bypassing addJob validation.
 * Used to inject invalid model strings that addJob would reject.
 */
async function writeJobFileRaw(agentName: string, label: string, body: string): Promise<void> {
  const dir = join(AGENTS_DIR, agentName, "jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.md`), body, "utf8");
}

beforeAll(async () => {
  // See runner.test.ts: initConfig seeds the gitignored settings file that
  // loadSettings would otherwise ENOENT on in a clean checkout.
  await initConfig();
  await loadSettings();
});

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("Phase 18 end-to-end model override", () => {
  it("job.model wins over agent.defaultModel", async () => {
    const name = uniq("joboveragent");
    await createAgent({
      name,
      role: "r",
      personality: "p",
      defaultModel: "sonnet",
    });
    await writeJobFileRaw(
      name,
      "draft",
      "---\nlabel: draft\nschedule: 0 9 * * *\nenabled: true\nmodel: opus\n---\n\nwrite\n",
    );

    const jobs = await loadJobs();
    const draft = jobs.find((j) => j.agent === name && j.label === "draft");
    expect(draft).toBeDefined();
    expect(await resolveJobModel(draft as Job)).toBe("opus");
  });

  it("agent.defaultModel fills in when job has no model field", async () => {
    const name = uniq("agentfills");
    await createAgent({
      name,
      role: "r",
      personality: "p",
      defaultModel: "sonnet",
    });
    await writeJobFileRaw(
      name,
      "digest",
      "---\nlabel: digest\nschedule: 0 9 * * *\nenabled: true\n---\n\nscan\n",
    );

    const jobs = await loadJobs();
    const digest = jobs.find((j) => j.agent === name && j.label === "digest");
    expect(digest).toBeDefined();
    expect(await resolveJobModel(digest as Job)).toBe("sonnet");
  });

  it("agent with no defaultModel and job with no model → undefined", async () => {
    const name = uniq("bothempty");
    await createAgent({ name, role: "r", personality: "p" });
    await writeJobFileRaw(
      name,
      "plain",
      "---\nlabel: plain\nschedule: 0 9 * * *\nenabled: true\n---\n\ngo\n",
    );

    const jobs = await loadJobs();
    const plain = jobs.find((j) => j.agent === name && j.label === "plain");
    expect(plain).toBeDefined();
    expect(await resolveJobModel(plain as Job)).toBeUndefined();
  });

  it("loadJobs filters jobs with invalid model strings (typo rejection)", async () => {
    const name = uniq("badmodel");
    await createAgent({ name, role: "r", personality: "p" });
    // Invalid (typo) — should be filtered at load time
    await writeJobFileRaw(
      name,
      "bad",
      "---\nlabel: bad\nschedule: 0 9 * * *\nenabled: true\nmodel: opuz\n---\n\nx\n",
    );
    // Valid sibling — should still load
    await writeJobFileRaw(
      name,
      "good",
      "---\nlabel: good\nschedule: 0 9 * * *\nenabled: true\nmodel: haiku\n---\n\ny\n",
    );

    const jobs = await loadJobs();
    expect(jobs.find((j) => j.agent === name && j.label === "bad")).toBeUndefined();
    const good = jobs.find((j) => j.agent === name && j.label === "good");
    expect(good).toBeDefined();
    expect(await resolveJobModel(good as Job)).toBe("haiku");
  });

  it("resolved model reaches runClaudeOnce via run() (end-to-end)", async () => {
    const name = uniq("e2e");
    await createAgent({
      name,
      role: "r",
      personality: "p",
      defaultModel: "sonnet",
    });
    await writeJobFileRaw(
      name,
      "draft",
      "---\nlabel: draft\nschedule: 0 9 * * *\nenabled: true\nmodel: opus\n---\n\nwrite\n",
    );

    const jobs = await loadJobs();
    const draft = jobs.find((j) => j.agent === name && j.label === "draft") as Job;
    const model = await resolveJobModel(draft);
    expect(model).toBe("opus");

    const captured: string[] = [];
    const SENTINEL = "P18_03_E2E_SENTINEL";
    const spy = spyOn(runnerMod, "runClaudeOnce").mockImplementation((async (
      _args: string[],
      model: string,
    ) => {
      captured.push(model);
      throw new Error(SENTINEL);
    }) as any);

    try {
      await runnerMod.run("e2e-test", "prompt", undefined, { modelOverride: model });
    } catch (e: any) {
      if (!String(e?.message ?? e).includes(SENTINEL)) throw e;
    } finally {
      spy.mockRestore();
    }

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]).toBe("opus");
  });
});
