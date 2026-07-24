/**
 * Tests for schedule-ops.ts — the durable scheduled-task writer backing the
 * `schedule_task` / `list_scheduled_tasks` / `delete_scheduled_task` bus tools
 * (#342).
 *
 * The load-bearing test is the round-trip: a task written by `scheduleTask`
 * must be re-parsed by `loadJobs()` with a NON-NULL `schedule`. That is the
 * exact failure mode of the incident — a hand-written `reminder-*.md` missing
 * its `schedule:` field parsed to null and silently never scheduled.
 *
 * Run with: bun test src/bus/__tests__/schedule-ops.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scheduleTask, listScheduledTasks, deleteScheduledTask } from "../schedule-ops";
import { loadJobs } from "../../jobs";
import { getJobsDir, getAgentsDir } from "../../config";
import { BUS_MCP_TOOLS } from "../mcp-tools";

const createdFlat: string[] = [];
const createdAgents: string[] = [];

function uniq(suffix: string): string {
  return `tst-sched-${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

afterEach(async () => {
  for (const f of createdFlat.splice(0)) await rm(f, { force: true });
  for (const a of createdAgents.splice(0)) {
    await rm(join(getAgentsDir(), a), { recursive: true, force: true });
  }
});

describe("scheduleTask — write target", () => {
  it("writes to the flat jobs dir for a caller with no scaffolded agent dir (the default/global session)", async () => {
    const label = uniq("flat");
    const flatPath = join(getJobsDir(), `${label}.md`);
    createdFlat.push(flatPath);

    const summary = await scheduleTask({
      agentId: "default",
      label,
      cron: "0 8 24 7 *",
      prompt: "Send a Discord reminder to the user: call the GP for Ginna.",
    });

    expect(summary.scope).toBe("shared");
    expect(existsSync(flatPath)).toBe(true);
  });

  it("writes agent-scoped when the caller has a scaffolded agents/<id>/ dir", async () => {
    const agent = uniq("agent");
    await mkdir(join(getAgentsDir(), agent), { recursive: true });
    createdAgents.push(agent);

    const summary = await scheduleTask({
      agentId: agent,
      label: "morning-check",
      cron: "0 7 * * *",
      prompt: "Do the morning check.",
      recurring: true,
    });

    expect(summary.scope).toBe("agent");
    expect(existsSync(join(getAgentsDir(), agent, "jobs", "morning-check.md"))).toBe(true);
  });
});

describe("scheduleTask — round-trip (the incident guard)", () => {
  it("produces a file loadJobs() re-parses with a non-null schedule", async () => {
    const label = uniq("roundtrip");
    createdFlat.push(join(getJobsDir(), `${label}.md`));

    await scheduleTask({
      agentId: "default",
      label,
      cron: "30 8 * * 1",
      prompt: "Weekly Monday 08:30 reminder.",
      recurring: true,
    });

    const jobs = await loadJobs();
    const job = jobs.find((j) => (j.label ?? j.name) === label);
    expect(job).toBeDefined();
    // The exact bug: schedule must NOT be null/empty, else it never schedules.
    expect(job!.schedule).toBe("30 8 * * 1");
    expect(job!.recurring).toBe(true);
  });

  it("defaults recurring to false (one-off ad-hoc reminders)", async () => {
    const label = uniq("oneoff");
    createdFlat.push(join(getJobsDir(), `${label}.md`));

    const summary = await scheduleTask({
      agentId: "default",
      label,
      cron: "0 9 25 12 *",
      prompt: "One-off.",
    });

    expect(summary.recurring).toBe(false);
    const job = (await loadJobs()).find((j) => (j.label ?? j.name) === label);
    expect(job!.recurring).toBe(false);
  });
});

describe("scheduleTask — validation", () => {
  it("rejects path-traversal labels", async () => {
    for (const bad of ["../etc/passwd", "foo/bar", "..", "a\\b"]) {
      await expect(
        scheduleTask({ agentId: "default", label: bad, cron: "0 8 * * *", prompt: "x" }),
      ).rejects.toThrow(/label/i);
    }
  });

  it("rejects an invalid cron expression", async () => {
    await expect(
      scheduleTask({ agentId: "default", label: uniq("badcron"), cron: "not a cron", prompt: "x" }),
    ).rejects.toThrow(/cron/i);
    // 6 fields (too many) must also be rejected.
    await expect(
      scheduleTask({
        agentId: "default",
        label: uniq("badcron2"),
        cron: "0 8 * * * *",
        prompt: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty prompt", async () => {
    await expect(
      scheduleTask({
        agentId: "default",
        label: uniq("noprompt"),
        cron: "0 8 * * *",
        prompt: "  ",
      }),
    ).rejects.toThrow(/prompt/i);
  });

  it("rejects a duplicate label instead of silently overwriting", async () => {
    const label = uniq("dup");
    createdFlat.push(join(getJobsDir(), `${label}.md`));
    await scheduleTask({ agentId: "default", label, cron: "0 8 * * *", prompt: "first" });
    await expect(
      scheduleTask({ agentId: "default", label, cron: "0 9 * * *", prompt: "second" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("rejects a model value crafted to inject a forged frontmatter field", async () => {
    // A newline in `model` must not smuggle in e.g. `agent: reg` and reroute
    // the job — `validateModelString` rejects anything outside the model set.
    const label = uniq("modelinject");
    await expect(
      scheduleTask({
        agentId: "default",
        label,
        cron: "0 8 * * *",
        prompt: "x",
        model: "sonnet\nagent: reg",
      }),
    ).rejects.toThrow(/model/i);
    // Nothing should have been written.
    expect(existsSync(join(getJobsDir(), `${label}.md`))).toBe(false);
  });

  it("rejects a cron with an internal newline (passes 5-field check but corrupts the file)", async () => {
    // "0\n8 * * *" splits to 5 valid fields (\s matches \n) but would render an
    // unparseable `schedule:` — the newline guard rejects it outright.
    const label = uniq("cronnewline");
    await expect(
      scheduleTask({ agentId: "default", label, cron: "0\n8 * * *", prompt: "x" }),
    ).rejects.toThrow(/newline/i);
    expect(existsSync(join(getJobsDir(), `${label}.md`))).toBe(false);
  });
});

describe("listScheduledTasks / deleteScheduledTask", () => {
  it("lists then deletes a task for the default caller", async () => {
    const label = uniq("managed");
    createdFlat.push(join(getJobsDir(), `${label}.md`));
    await scheduleTask({ agentId: "default", label, cron: "0 8 * * *", prompt: "managed task" });

    const listed = await listScheduledTasks("default");
    expect(listed.some((t) => t.label === label)).toBe(true);

    await deleteScheduledTask("default", label);
    expect(existsSync(join(getJobsDir(), `${label}.md`))).toBe(false);
  });

  it("throws when deleting a task that does not exist", async () => {
    await expect(deleteScheduledTask("default", uniq("ghost"))).rejects.toThrow(
      /no scheduled task/i,
    );
  });

  it("rejects path-traversal labels on delete", async () => {
    await expect(deleteScheduledTask("default", "../../secret")).rejects.toThrow(/label/i);
  });
});

describe("schedule_task tool schema — structural guard", () => {
  it("advertises cron, label and prompt as required so the MCP layer rejects a missing schedule", () => {
    const tool = BUS_MCP_TOOLS.find((t) => t.name === "schedule_task");
    expect(tool).toBeDefined();
    const required = (tool as { inputSchema: { required?: string[] } }).inputSchema.required ?? [];
    expect(required).toContain("cron");
    expect(required).toContain("label");
    expect(required).toContain("prompt");
  });

  it("steers away from native cron tools in its description", () => {
    const tool = BUS_MCP_TOOLS.find((t) => t.name === "schedule_task");
    expect(tool!.description).toMatch(/CronCreate|ScheduleWakeup/);
  });
});
