/**
 * fire.ts — manual fire-once for agent jobs.
 *
 * Usage:
 *   claudeclaw fire <agent>:<label>
 *   claudeclaw fire <agent> <label>
 *
 * Fires a single agent job immediately via the same `run()` code path as the
 * cron loop. Disabled jobs (enabled: false) CAN be fired manually — the
 * enabled flag only gates cron scheduling.
 *
 * Closes GAP-17-05: no more waiting on cron to smoke-test a new job.
 */

import { loadAgentJobsUnfiltered, agentDirExists, type Job } from "../jobs";
import { run as defaultRun } from "../runner";
import { resolvePrompt as defaultResolvePrompt, initConfig, loadSettings } from "../config";

export interface FireResult {
  success: boolean;
  exitCode: number;
  output?: string;
  stderr?: string;
  error?: string;
  agent?: string;
  label?: string;
}

export interface FireJobOptions {
  /** Injectable runner for tests. Defaults to runner.run. */
  runner?: (
    name: string,
    prompt: string,
    agent?: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Injectable prompt resolver for tests. Defaults to config.resolvePrompt. */
  promptResolver?: (prompt: string) => Promise<string>;
  /** Injectable agent-job loader for tests. Defaults to loadAgentJobsUnfiltered. */
  jobLoader?: (agentName: string) => Promise<Job[]>;
  /** Injectable agent-dir existence check for tests. */
  agentExists?: (agentName: string) => Promise<boolean>;
}

/**
 * Fire a single agent job once, bypassing the cron loop and the enabled
 * filter. Uses the same `run()` signature as the scheduled path to guarantee
 * storage/exec format parity.
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

  // Mirror cron-loop pattern: resolvePrompt then run(name, prompt, agent)
  const resolved = await promptResolver(job.prompt);
  const result = await runner(job.name, resolved, job.agent);
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    output: result.stdout,
    stderr: result.stderr,
    agent,
    label,
  };
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
