/**
 * Durable scheduled-task operations for the bus runtime.
 *
 * These back the `schedule_task` / `list_scheduled_tasks` /
 * `delete_scheduled_task` bus MCP tools. They run in the DAEMON process
 * (routed there over IPC by `core.ts:handleJobRequest`), never in the agent's
 * MCP-server process — the daemon's cwd is the project root, so the job files
 * land where `loadJobs()` actually scans and the 30s hot-reload picks them up.
 *
 * Why this exists at all: the #342 incident had the agent reach for Claude
 * Code's native `CronCreate`, whose wakeup is session-scoped and silently died
 * before the overnight reminder fired. ClaudeClaw+'s file-backed jobs are
 * durable across session/restart boundaries; this module is the validated
 * writer for them, so the agent can no longer produce a broken job file by
 * hand (the other half of that incident: a `reminder-*.md` missing its
 * required `schedule:` field, silently never scheduled).
 *
 * Write target mirrors the existing on-disk convention:
 *   - a named agent (a scaffolded `agents/<id>/` dir exists) → its own
 *     `agents/<id>/jobs/` dir, where `loadJobs()` tags `job.agent = <id>` from
 *     the directory (authoritative) and the scheduler routes the fire back to
 *     that same agent.
 *   - the default/global session (no `agents/default/` scaffold) → the flat
 *     `getJobsDir()`, exactly where its `reminder-*.md` files already live. A
 *     flat job carries no `agent:` field, so the scheduler routes it to
 *     `defaultAgentId` — which is that same global session.
 * This keeps the round-trip correct for either caller without a magic
 * "is this the default agent" string check.
 */

import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentsDir, getJobsDir } from "../config";
import { validateJobLabel } from "../agents";
import { loadJobs, validateModelString } from "../jobs";
import { validateCronExpression } from "./scheduler";

export interface ScheduleTaskInput {
  /** The calling agent's id (from `CCAW_AGENT_ID` / the IPC frame). */
  agentId: string;
  /** kebab-case job label; becomes the `.md` filename. */
  label: string;
  /** 5-field cron expression (`minute hour day-of-month month day-of-week`). */
  cron: string;
  /** Instruction to run when the task fires (delivered as a fresh session prompt). */
  prompt: string;
  /** Repeat on every cron match (`true`) vs fire once then self-disable (`false`, default). */
  recurring?: boolean;
  /** Optional per-job model override (opus/sonnet/haiku/glm). */
  model?: string;
}

export interface ScheduledTaskSummary {
  label: string;
  cron: string;
  recurring: boolean;
  /** `"agent"` = written under `agents/<id>/jobs/`; `"shared"` = flat jobs dir. */
  scope: "agent" | "shared";
}

function resolveTarget(agentId: string): { dir: string; scope: "agent" | "shared" } {
  const agentDir = join(getAgentsDir(), agentId);
  if (existsSync(agentDir)) return { dir: join(agentDir, "jobs"), scope: "agent" };
  return { dir: getJobsDir(), scope: "shared" };
}

function renderTaskFile(input: ScheduleTaskInput): string {
  const lines = [
    "---",
    `label: ${input.label}`,
    `schedule: ${input.cron}`,
    `recurring: ${input.recurring === true}`,
    "enabled: true",
    ...(input.model && input.model.trim() !== "" ? [`model: ${input.model.trim()}`] : []),
    "---",
    "",
    input.prompt.trim(),
    "",
  ];
  return lines.join("\n");
}

/**
 * Create a durable scheduled task. Throws (never silently no-ops) on an
 * invalid label, invalid cron, empty prompt, or a duplicate label — the
 * caller surfaces the thrown message to the agent as an error tool result.
 */
export async function scheduleTask(input: ScheduleTaskInput): Promise<ScheduledTaskSummary> {
  const lv = validateJobLabel(input.label);
  if (!lv.valid) {
    throw new Error(`invalid label "${input.label}": ${lv.error}`);
  }
  if (!input.prompt || input.prompt.trim() === "") {
    throw new Error(
      "prompt is required — say what to do when the task fires, and where to deliver it",
    );
  }
  // `model` is the only other value written into the frontmatter, and unlike
  // `label`/`cron` it is otherwise free text. Validate it against the allowed
  // model set (throws on anything else) so a crafted value containing a newline
  // cannot inject a forged frontmatter field (e.g. `agent:` to reroute the job).
  validateModelString(input.model, "schedule_task model");
  // Throws on malformed cron (wrong field count / out-of-range / junk chars).
  validateCronExpression(input.cron);
  // Belt-and-braces: every value interpolated into the frontmatter is checked
  // here for newlines regardless of the field-specific validators above, so a
  // newline can never smuggle in a forged field (`agent:`, `enabled:`) or
  // silently corrupt the block (a `\n` in `cron` passes the 5-field check —
  // `\s` matches newlines — but would render an unparseable `schedule:`).
  for (const [field, value] of [
    ["label", input.label],
    ["cron", input.cron],
    ["model", input.model ?? ""],
  ] as const) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${field} must not contain newlines`);
    }
  }

  const { dir, scope } = resolveTarget(input.agentId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${input.label}.md`);
  // Exclusive create ("wx") IS the duplicate check — atomic, so two concurrent
  // schedule_task calls with the same label can't both pass a separate
  // existsSync() and race to overwrite one another. EEXIST maps to the friendly
  // "already exists" error; any other error propagates.
  try {
    await writeFile(path, renderTaskFile(input), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `a scheduled task named "${input.label}" already exists — delete it first or choose another label`,
      );
    }
    throw err;
  }
  return { label: input.label, cron: input.cron, recurring: input.recurring === true, scope };
}

/**
 * List the caller's scheduled tasks. Reuses `loadJobs()` (the canonical
 * parser) and filters to the caller's scope: a named agent sees its own
 * `agents/<id>/jobs/`; the default/global session sees the flat (un-agented)
 * jobs.
 */
export async function listScheduledTasks(agentId: string): Promise<ScheduledTaskSummary[]> {
  const { scope } = resolveTarget(agentId);
  const jobs = await loadJobs();
  const mine = jobs.filter((j) => (scope === "agent" ? j.agent === agentId : !j.agent));
  return mine.map((j) => ({
    label: j.label ?? j.name,
    cron: j.schedule,
    recurring: j.recurring,
    scope,
  }));
}

/**
 * Delete one scheduled task by label from the caller's scope. Throws if the
 * label is invalid or no such task exists.
 */
export async function deleteScheduledTask(agentId: string, label: string): Promise<void> {
  const lv = validateJobLabel(label);
  if (!lv.valid) {
    throw new Error(`invalid label "${label}": ${lv.error}`);
  }
  const { dir } = resolveTarget(agentId);
  const path = join(dir, `${label}.md`);
  if (!existsSync(path)) {
    throw new Error(`no scheduled task named "${label}"`);
  }
  await unlink(path);
}
