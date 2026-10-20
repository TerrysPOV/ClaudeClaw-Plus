/**
 * Tests for src/commands/fire.ts — Phase 17 GAP-02 manual fire command.
 *
 * Run with: bun test src/__tests__/fire.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { readdir, readFile, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import {
  fireJob,
  runFireCommand,
  parseFireArgs,
  restorePendingFrontmatter,
} from "../commands/fire";
import type { Job } from "../jobs";
import { initConfig, loadSettings } from "../config";
import * as runnerMod from "../runner";
import { createThreadSession, removeThreadSession } from "../sessionManager";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");

const TEST_PREFIX = "tst-fire-";
const createdAgents: string[] = [];

function uniq(suffix: string): string {
  return `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

async function writeAgentJob(
  agent: string,
  label: string,
  frontmatter: string,
  body = "do the thing",
): Promise<void> {
  const dir = join(AGENTS_DIR, agent, "jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.md`), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  if (!createdAgents.includes(agent)) createdAgents.push(agent);
}

afterEach(async () => {
  for (const a of createdAgents.splice(0)) {
    await rm(join(AGENTS_DIR, a), { recursive: true, force: true });
  }
});

// A fake runner/prompt resolver keeps tests hermetic (no real `claude` exec).
type RunCall = {
  name: string;
  prompt: string;
  agent?: string;
  extras?: { timeoutMs?: number; modelOverride?: string };
};
function fakeRunner(calls: RunCall[], exitCode = 0) {
  return async (
    name: string,
    prompt: string,
    agent?: string,
    extras?: { timeoutMs?: number; modelOverride?: string },
  ) => {
    calls.push({ name, prompt, agent, extras });
    return { exitCode, stdout: `ran:${name}`, stderr: "" };
  };
}
// #344: the fired prompt carries the scheduled path's clock prefix; the body is its last line.
const bodyOf = (prompt: string) => prompt.split("\n").at(-1);
const CLOCK_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d+(?::\d{2})?\]$/;

const passthroughResolver = async (p: string) => p;

describe("parseFireArgs", () => {
  it("parses agent:label form", () => {
    expect(parseFireArgs(["reg:daily-research"])).toEqual({
      agent: "reg",
      label: "daily-research",
    });
  });
  it("parses agent label form", () => {
    expect(parseFireArgs(["reg", "daily-research"])).toEqual({
      agent: "reg",
      label: "daily-research",
    });
  });
  it("rejects empty args", () => {
    expect(parseFireArgs([])).toBeNull();
  });
  it("rejects single token without colon", () => {
    expect(parseFireArgs(["reg"])).toBeNull();
  });
  it("rejects empty agent or label", () => {
    expect(parseFireArgs([":foo"])).toBeNull();
    expect(parseFireArgs(["foo:"])).toBeNull();
  });
});

describe("fireJob", () => {
  it("loads and fires a matching agent job via run() with agent scoping", async () => {
    const agent = uniq("ok");
    await writeAgentJob(
      agent,
      "daily-research",
      "schedule: 0 9 * * *\nrecurring: true",
      "research briefing",
    );

    const calls: RunCall[] = [];
    const result = await fireJob(agent, "daily-research", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe(agent);
    expect(bodyOf(calls[0].prompt)).toBe("research briefing");
    const lines = calls[0].prompt.split("\n");
    expect(lines).toHaveLength(2); // clock line + body, like the cron loop
    expect(lines[0]).toMatch(CLOCK_LINE);
    expect(calls[0].name).toBe(`${agent}/daily-research`);
    // no timeout/model in the frontmatter → none passed, the runner falls back to its defaults
    expect(calls[0].extras?.timeoutMs).toBeUndefined();
  });

  it("errors clearly when agent directory does not exist", async () => {
    const result = await fireJob("no-such-agent-xyz-1234", "anything", {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("no-such-agent-xyz-1234");
    expect(result.error).toContain("not found");
  });

  it("errors clearly when label file does not exist within an agent", async () => {
    const agent = uniq("missing-label");
    await writeAgentJob(agent, "daily", "schedule: 0 9 * * *\nrecurring: true");

    const result = await fireJob(agent, "weekly", {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(`${agent}:weekly`);
    expect(result.error).toContain("not found");
  });

  it("passes the job's own timeout and model to the runner, as the scheduled path does (#344)", async () => {
    const agent = uniq("fire-extras");
    await writeAgentJob(
      agent,
      "long-research",
      "schedule: 0 9 * * *\nrecurring: true\ntimeout: 1200\nmodel: opus",
      "deep research",
    );
    const calls: RunCall[] = [];
    const result = await fireJob(agent, "long-research", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(true);
    expect(calls[0].extras).toEqual({ timeoutMs: 1_200_000, modelOverride: "opus" });
  });

  // #344: the default runner is observed end to end through the primary-exec
  // seam (`_setPrimaryExecForTests`), not a `mock.module("../runner")` — bun
  // module mocks are process-wide and would leak into runner.test.ts. The seam
  // sees the resolved model, the timeout, the agent cwd and the argv; a seeded
  // `agent:<name>` thread session shows up as `--resume`, which is the point of
  // the issue: a manual fire lands in the scheduled turn's session.
  it("the default runner reaches the exec exactly as the cron loop does: agent:<name> session, model, timeout, agent cwd (#344)", async () => {
    await initConfig();
    await loadSettings();
    const agent = uniq("fire-default");
    await writeAgentJob(
      agent,
      "nightly",
      "schedule: 0 2 * * *\nrecurring: true\ntimeout: 900\nmodel: haiku",
      "tidy up",
    );
    const threadId = `agent:${agent}`;
    const SESSION = "sess-344-fire-e2e";
    const SENTINEL = "FIRE_344_E2E_SENTINEL";
    await createThreadSession(threadId, SESSION);
    // The run reaches `recordInvocationStart` before the seam throws: put the
    // usage directory back byte-for-byte afterwards (see model-override.test.ts).
    const usageDir = join(process.cwd(), ".claude", "claudeclaw", "usage");
    const usageBefore = new Map<string, string>();
    for (const f of await readdir(usageDir).catch(() => [] as string[])) {
      usageBefore.set(f, await readFile(join(usageDir, f), "utf8"));
    }
    const seen: { name: string; args: string[]; model: string; cwd?: string; timeoutMs: number }[] =
      [];
    runnerMod._setPrimaryExecForTests(async ({ name, args, model, cwd, timeoutMs }) => {
      seen.push({ name, args, model, cwd, timeoutMs });
      throw new Error(SENTINEL);
    });
    try {
      await expect(
        fireJob(agent, "nightly", { promptResolver: passthroughResolver }),
      ).rejects.toThrow(SENTINEL);
    } finally {
      runnerMod._setPrimaryExecForTests(null);
      await removeThreadSession(threadId);
      try {
        for (const f of await readdir(usageDir)) {
          const before = usageBefore.get(f);
          if (before === undefined) await rm(join(usageDir, f), { recursive: true, force: true });
          else await writeFile(join(usageDir, f), before);
        }
      } catch {
        /* directory may not exist */
      }
    }
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.name).toBe(`${agent}/nightly`);
    expect(call.model).toBe("haiku");
    expect(call.timeoutMs).toBe(900_000);
    expect(call.cwd).toBe(join(AGENTS_DIR, agent));
    const prompt = call.args[call.args.indexOf("-p") + 1];
    expect(bodyOf(prompt)).toBe("tidy up");
    expect(prompt.split("\n")[0]).toMatch(CLOCK_LINE);
    const resumeAt = call.args.indexOf("--resume");
    expect(resumeAt).toBeGreaterThan(-1);
    expect(call.args[resumeAt + 1]).toBe(SESSION);
  });

  it("refuses a job whose model: is invalid, as the cron loader does (#344)", async () => {
    const agent = uniq("fire-badmodel");
    await writeAgentJob(
      agent,
      "typo",
      "schedule: 0 2 * * *\nrecurring: true\nmodel: opus-4.5",
      "x",
    );
    const calls: RunCall[] = [];
    const result = await fireJob(agent, "typo", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid model");
    expect(calls).toHaveLength(0);
  });

  it("can fire a disabled job (bypasses enabled filter)", async () => {
    const agent = uniq("disabled");
    await writeAgentJob(
      agent,
      "off-job",
      "schedule: 0 9 * * *\nrecurring: true\nenabled: false",
      "disabled prompt",
    );

    const calls: RunCall[] = [];
    const result = await fireJob(agent, "off-job", {
      runner: fakeRunner(calls),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0].prompt)).toBe("disabled prompt");
  });

  // #436: in bus mode the runner returns when the bridge WAIT ends (reply or
  // timeout); the agent's turn can run on and rewrite its own job file. The
  // snapshot must be restored when the turn is over, not when the wait is.
  it("restores the frontmatter when the turn settles, not when the bus runner's wait returns (#436)", async () => {
    const agent = uniq("tail");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    let settle: () => void = () => undefined;
    const turnSettled = new Promise<void>((res) => {
      settle = res;
    });
    const result = await fireJob(agent, "nightly", {
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "timed out", turnSettled }),
      promptResolver: passthroughResolver,
    });
    expect(result.exitCode).toBe(1);
    // The turn's tail, after the wait timed out: it rewrites its job file and drops `schedule:`.
    await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
    await Bun.sleep(20);
    expect(await readFile(jobFile, "utf8")).not.toContain("schedule:"); // not restored yet
    settle();
    await Bun.sleep(50);
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
  });

  it("a second fire while the first turn runs on shares the first snapshot (#436)", async () => {
    const agent = uniq("twice");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    const settles: Array<() => void> = [];
    const runner = async () => {
      const turnSettled = new Promise<void>((res) => settles.push(res));
      return { exitCode: 1, stdout: "", stderr: "timed out", turnSettled };
    };
    await fireJob(agent, "nightly", { runner, promptResolver: passthroughResolver });
    // First turn's tail rewrites its frontmatter before the second fire
    // snapshots (a file with no `schedule:` would not load for a fire at all).
    await writeFile(jobFile, "---\nschedule: 0 5 * * *\nrecurring: false\n---\ntidy up\n", "utf8");
    await fireJob(agent, "nightly", { runner, promptResolver: passthroughResolver });
    expect(settles).toHaveLength(2);
    settles[0]();
    await Bun.sleep(30);
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 5 * * *"); // second turn still running
    settles[1]();
    await Bun.sleep(50);
    // The pre-fire frontmatter, not the rewritten one the second fire found.
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
  });

  it("a fire arriving while a restore is in flight snapshots the restored file (#436)", async () => {
    const agent = uniq("inflight");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    let settle: () => void = () => undefined;
    const turnSettled = new Promise<void>((res) => {
      settle = res;
    });
    await fireJob(agent, "nightly", {
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "timed out", turnSettled }),
      promptResolver: passthroughResolver,
    });
    await writeFile(jobFile, "---\nschedule: 0 5 * * *\nrecurring: false\n---\ntidy up\n", "utf8");
    settle(); // the restore starts...
    // ...and a second fire lands before it has written the file back.
    await fireJob(agent, "nightly", {
      runner: async () => {
        await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      promptResolver: passthroughResolver,
    });
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
  });

  it("a restore still waiting on its turn is flushed at daemon shutdown (#436)", async () => {
    const agent = uniq("flush");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    let settle: () => void = () => undefined;
    const turnSettled = new Promise<void>((res) => {
      settle = res;
    });
    await fireJob(agent, "nightly", {
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "timed out", turnSettled }),
      promptResolver: passthroughResolver,
    });
    await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
    await restorePendingFrontmatter();
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
    // The turn settling afterwards does not restore a second time.
    await writeFile(jobFile, "---\nschedule: 0 4 * * *\n---\ntidy up\n", "utf8");
    settle();
    await Bun.sleep(30);
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 4 * * *");
  });

  it("restores at once when the runner carries no turn signal (the run() path)", async () => {
    const agent = uniq("sync");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    await fireJob(agent, "nightly", {
      runner: async () => {
        await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      promptResolver: passthroughResolver,
    });
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
  });

  it("releases the snapshot when the runner throws", async () => {
    const agent = uniq("throw");
    await writeAgentJob(agent, "nightly", "schedule: 0 2 * * *\nrecurring: true", "tidy up");
    const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");
    await expect(
      fireJob(agent, "nightly", {
        runner: async () => {
          await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
          throw new Error("bridge down");
        },
        promptResolver: passthroughResolver,
      }),
    ).rejects.toThrow("bridge down");
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
    // Not left pending: a later fire takes a fresh snapshot.
    await writeFile(jobFile, "---\nschedule: 0 3 * * *\n---\ntidy up\n", "utf8");
    await fireJob(agent, "nightly", {
      runner: async () => {
        await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      promptResolver: passthroughResolver,
    });
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 3 * * *");
  });

  it("propagates runner exitCode on failure", async () => {
    const agent = uniq("fail");
    await writeAgentJob(agent, "bad", "schedule: 0 9 * * *\nrecurring: true");

    const result = await fireJob(agent, "bad", {
      runner: fakeRunner([], 7),
      promptResolver: passthroughResolver,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(7);
  });
});

describe("runFireCommand", () => {
  it("returns 2 on usage error", async () => {
    let errText = "";
    const code = await runFireCommand([], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(2);
    expect(errText).toContain("Usage");
  });

  it("returns 1 when agent missing", async () => {
    let errText = "";
    const code = await runFireCommand(["no-such-agent-zzz:whatever"], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(1);
    expect(errText).toContain("not found");
  });

  it("returns 1 when label missing", async () => {
    const agent = uniq("cli-missing");
    await writeAgentJob(agent, "alpha", "schedule: 0 9 * * *\nrecurring: true");

    let errText = "";
    const code = await runFireCommand([`${agent}:beta`], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: () => {},
      stderr: (s) => {
        errText += s;
      },
    });
    expect(code).toBe(1);
    expect(errText).toContain(`${agent}:beta`);
  });

  it("returns 0 on success and streams output", async () => {
    const agent = uniq("cli-ok");
    await writeAgentJob(agent, "go", "schedule: 0 9 * * *\nrecurring: true", "fire me");

    let outText = "";
    const code = await runFireCommand([agent, "go"], {
      runner: fakeRunner([]),
      promptResolver: passthroughResolver,
      stdout: (s) => {
        outText += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(outText).toContain(`Firing ${agent}:go`);
    expect(outText).toContain(`ran:${agent}/go`);
    expect(outText).toContain("Done.");
  });
});
