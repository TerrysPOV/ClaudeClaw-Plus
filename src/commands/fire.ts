/**
 * fire.ts — manual fire-once for agent jobs.
 *
 * Usage:
 *   claudeclaw fire <agent>:<label>
 *   claudeclaw fire <agent> <label>
 *
 * Fires a single agent job immediately via the same `run()` code path as the
 * cron loop (legacy and PTY runtimes). Disabled jobs (enabled: false) CAN be
 * fired manually — the enabled flag only gates cron scheduling.
 *
 * Two things worth knowing (#344):
 * - the fired turn runs AS the agent, on the agent's own session
 *   (`agent:<name>`, the same one its scheduled runs use). A `claudeclaw fire`
 *   from a second process therefore resumes the same session as the daemon's
 *   cron tick — do not fire a job at the minute it is due.
 * - under `runtime: "bus"` the scheduled turn still comes from the 60 s job
 *   loop (`job-loop.ts`: a one-shot `claude -p` on the job's model, #506); a
 *   fire through the web UI's bus runner sends the clock-prefixed prompt to the
 *   bus agent and bounds its wait with the job's timeout — the model stays the
 *   agent's.
 *
 * Closes GAP-17-05: no more waiting on cron to smoke-test a new job.
 */

import {
  loadAgentJobsUnfiltered,
  agentDirExists,
  resolveJobModel,
  snapshotJobFrontmatter,
  validateModelString,
  type Job,
} from "../jobs";
import { run } from "../runner";
import {
  resolvePrompt as defaultResolvePrompt,
  getSettings,
  initConfig,
  loadSettings,
} from "../config";
import { buildClockPromptPrefix } from "../timezone";

export interface FireResult {
  success: boolean;
  exitCode: number;
  output?: string;
  stderr?: string;
  error?: string;
  agent?: string;
  label?: string;
}

/**
 * What the scheduled path (`runJob` in start.ts) derives from the job before it
 * calls `run()`, so a manual fire is the same turn (#344): the job's own
 * `timeout:` frontmatter (seconds → ms), its resolved model, and the `"job"`
 * timeout category. Before #344 a fire passed none of these — it ran on the
 * default 5-minute cap and on a different session key — which is how a job
 * that legitimately runs 20 minutes "timed out" only when fired by hand.
 */
export interface FireRunExtras {
  timeoutMs?: number;
  modelOverride?: string;
}

export interface FireRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * #436: resolves when the agent's turn is over, when that is later than the
   * runner's return — the bus runner returns when its WAIT ends (reply or
   * timeout) and the turn can run on. The job's frontmatter is restored then,
   * not before. Absent: the turn ended with the runner (the `run()` path
   * kills the child at `timeout:`).
   */
  turnSettled?: Promise<unknown>;
}

/**
 * #436: one frontmatter snapshot per job while any fired turn of it may still
 * write. A second fire of the same job while the first turn runs on must not
 * snapshot the file that turn may already have rewritten — it shares the
 * first snapshot, and the restore runs when the last of them settles.
 */
const pendingRestores = new Map<
  string,
  { restore: () => Promise<boolean>; holders: number; restoring?: Promise<void> }
>();

async function holdFrontmatterSnapshot(jobName: string): Promise<() => Promise<void>> {
  let entry = pendingRestores.get(jobName);
  // A restore in flight: wait for it, so this fire snapshots the restored
  // file rather than the one the previous turn rewrote.
  while (entry?.restoring) {
    await entry.restoring.catch(() => undefined);
    entry = pendingRestores.get(jobName);
  }
  if (entry) {
    entry.holders++;
  } else {
    // Two first fires can both reach this await: whichever publishes its
    // snapshot first wins, the other joins it.
    const restore = await snapshotJobFrontmatter(jobName);
    entry = pendingRestores.get(jobName);
    if (entry && !entry.restoring) entry.holders++;
    else {
      entry = { restore, holders: 1 };
      pendingRestores.set(jobName, entry);
    }
  }
  const held = entry;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (pendingRestores.get(jobName) !== held) return; // already flushed at shutdown
    if (--held.holders > 0) return;
    // The entry stays until the restore lands (see the wait above).
    held.restoring = (async () => {
      try {
        if (await held.restore()) console.log(`Restored frontmatter for job: ${jobName}`);
      } finally {
        if (pendingRestores.get(jobName) === held) pendingRestores.delete(jobName);
      }
    })();
    await held.restoring;
  };
}

/**
 * #436: restore every snapshot still waiting on a turn. For daemon shutdown:
 * the in-flight turns have been drained (or abandoned) by then, and a restore
 * held in memory would otherwise be lost with the process.
 */
export async function restorePendingFrontmatter(): Promise<void> {
  const entries = [...pendingRestores.entries()];
  pendingRestores.clear();
  for (const [jobName, entry] of entries) {
    if (entry.restoring) {
      await entry.restoring.catch(() => undefined); // already restoring
      continue;
    }
    entry.holders = 0;
    try {
      if (await entry.restore()) console.log(`Restored frontmatter for job: ${jobName}`);
    } catch (err) {
      console.error(`[fire] frontmatter restore failed for ${jobName}:`, err);
    }
  }
}

export interface FireJobOptions {
  /** Injectable runner for tests. Defaults to the scheduled path's `run()` call. */
  runner?: (
    name: string,
    prompt: string,
    agent?: string,
    extras?: FireRunExtras,
  ) => Promise<FireRunnerResult>;
  /** Injectable prompt resolver for tests. Defaults to config.resolvePrompt. */
  promptResolver?: (prompt: string) => Promise<string>;
  /** Injectable agent-job loader for tests. Defaults to loadAgentJobsUnfiltered. */
  jobLoader?: (agentName: string) => Promise<Job[]>;
  /** Injectable agent-dir existence check for tests. */
  agentExists?: (agentName: string) => Promise<boolean>;
}

/**
 * The scheduled path's `run()` call, exactly (`runJob` in start.ts): the
 * session key `agent:<name>`, the job's model and timeout, the `"job"` timeout
 * category, the agent name for its memory/identity.
 */
async function defaultRun(
  name: string,
  prompt: string,
  agent?: string,
  extras: FireRunExtras = {},
): Promise<FireRunnerResult> {
  return run(
    name,
    prompt,
    agent ? `agent:${agent}` : name,
    extras.modelOverride,
    extras.timeoutMs,
    agent,
    "job",
  );
}

/**
 * Fire a single agent job once, bypassing the cron loop and the enabled
 * filter. Derives the same arguments as the scheduled path (`runJob` in
 * start.ts) — clock prefix, model, timeout, session key — so the fired turn is
 * the scheduled turn, storage and exec included.
 */
export async function fireJob(
  agent: string,
  label: string,
  opts: FireJobOptions = {},
): Promise<FireResult> {
  const runner = opts.runner ?? defaultRun;
  const promptResolver = opts.promptResolver ?? defaultResolvePrompt;
  const jobLoader = opts.jobLoader ?? loadAgentJobsUnfiltered;
  const agentExists = opts.agentExists ?? agentDirExists;

  if (!agent || !label) {
    return {
      success: false,
      exitCode: 2,
      error: "fire: agent and label are required",
    };
  }

  if (!(await agentExists(agent))) {
    return {
      success: false,
      exitCode: 1,
      error: `agent '${agent}' not found`,
      agent,
      label,
    };
  }

  const jobs = await jobLoader(agent);
  const job = jobs.find((j) => j.label === label);
  if (!job) {
    return {
      success: false,
      exitCode: 1,
      error: `job '${agent}:${label}' not found`,
      agent,
      label,
    };
  }

  // The cron loop's loader skips a job whose `model:` is invalid (#378); the
  // unfiltered loader used here does not. Since a fire now honours `model:`,
  // refuse the same way instead of handing claude a bad `--model`.
  try {
    validateModelString(job.model, `job '${agent}:${label}'`);
  } catch (err) {
    return {
      success: false,
      exitCode: 1,
      error: err instanceof Error ? err.message : String(err),
      agent,
      label,
    };
  }

  // Mirror the cron loop (`runJob`): clock prefix, resolved prompt, the job's
  // own model and timeout, and the frontmatter snapshot — the agent's cwd is
  // its own directory, and a turn that rewrites its job file must not drop
  // `schedule:`. Settings may not be loaded (tests): the clock then carries
  // no offset.
  const releaseSnapshot = await holdFrontmatterSnapshot(job.name);
  let result: FireRunnerResult;
  try {
    result = await runFired(job, promptResolver, runner);
  } catch (err) {
    // The runner's error is the one to surface, not a failed restore's.
    await releaseSnapshot().catch((e) =>
      console.error(`[fire] frontmatter restore failed for ${job.name}:`, e),
    );
    throw err;
  }
  if (result.turnSettled) {
    // #436: the bus runner's wait is over; the turn may not be. Restore when
    // it is — in the background, the caller has its result already.
    void result.turnSettled
      .catch(() => undefined)
      .then(releaseSnapshot)
      .catch((err) => console.error(`[fire] frontmatter restore failed for ${job.name}:`, err));
  } else {
    await releaseSnapshot();
  }
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    output: result.stdout,
    stderr: result.stderr,
    agent,
    label,
  };
}

async function runFired(
  job: Job,
  promptResolver: (prompt: string) => Promise<string>,
  runner: NonNullable<FireJobOptions["runner"]>,
): Promise<FireRunnerResult> {
  const resolved = await promptResolver(job.prompt);
  let tzOffset = 0;
  try {
    tzOffset = getSettings().timezoneOffsetMinutes;
  } catch {
    /* settings not loaded */
  }
  const prompt = `${buildClockPromptPrefix(new Date(), tzOffset)}\n${resolved}`;
  const extras: FireRunExtras = {
    timeoutMs: job.timeoutSeconds ? job.timeoutSeconds * 1000 : undefined,
    modelOverride: await resolveJobModel(job),
  };
  return runner(job.name, prompt, job.agent, extras);
}

/**
 * Parse CLI args for `fire` subcommand.
 * Accepts:
 *   ["reg:daily-research"]            -> ["reg", "daily-research"]
 *   ["reg", "daily-research"]         -> ["reg", "daily-research"]
 * Returns null on usage error.
 */
export function parseFireArgs(args: string[]): { agent: string; label: string } | null {
  if (args.length === 0) return null;
  if (args.length === 1) {
    const parts = args[0].split(":");
    if (parts.length !== 2) return null;
    const [agent, label] = parts;
    if (!agent.trim() || !label.trim()) return null;
    return { agent: agent.trim(), label: label.trim() };
  }
  if (args.length >= 2) {
    const agent = args[0].trim();
    const label = args[1].trim();
    if (!agent || !label) return null;
    // Reject "agent:label extra" form for determinism
    if (agent.includes(":")) return null;
    return { agent, label };
  }
  return null;
}

const USAGE = [
  "Usage: claudeclaw fire <agent>:<label>",
  "       claudeclaw fire <agent> <label>",
  "",
  "Fires a single agent job immediately, using the same code path as the cron loop.",
  "Disabled jobs (enabled: false) can be fired manually.",
].join("\n");

/**
 * CLI entry point for the `fire` subcommand.
 * Exit codes:
 *   0 — success
 *   1 — agent/job missing OR runner failed
 *   2 — usage error
 */
export async function runFireCommand(
  args: string[],
  opts: FireJobOptions & { stdout?: (s: string) => void; stderr?: (s: string) => void } = {},
): Promise<number> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const parsed = parseFireArgs(args);
  if (!parsed) {
    err(`${USAGE}\n`);
    return 2;
  }

  const { agent, label } = parsed;
  out(`Firing ${agent}:${label}...\n`);

  // The daemon's fire path (discord/telegram → fireJob) runs with config
  // already loaded, but the standalone `claudeclaw fire` CLI does not —
  // without this, fireJob → execClaude → getSettings() throws
  // "Settings not loaded". Mirror send.ts and init before dispatching.
  // Skipped when a test injects its own runner (no real claude spawn).
  if (!opts.runner) {
    await initConfig();
    await loadSettings();
  }

  const result = await fireJob(agent, label, opts);

  if (!result.success) {
    err(`Error: ${result.error ?? "fire failed"}\n`);
    return result.exitCode || 1;
  }

  if (result.output) out(result.output);
  if (!result.output?.endsWith("\n")) out("\n");
  out(`Done. (${agent}:${label})\n`);
  return 0;
}
