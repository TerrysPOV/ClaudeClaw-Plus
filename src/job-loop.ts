/**
 * The 60 s cron loop that runs jobs (moved out of `commands/start.ts`).
 *
 * Each due job runs as a one-shot `claude -p` through `run()`, with the job's
 * own model, timeout, retry/retryDelay and notify, and its result forwarded
 * to Telegram/Discord. Under `runtime: "bus"` it is still the only job runner:
 * `busSchedulerJobs()` keeps the jobs off the bus scheduler, so a job never runs
 * once here and once more as a prompt typed into the agent's live session.
 */
import { cronMatches } from "./cron";
import type { Job } from "./jobs";
import { buildClockPromptPrefix } from "./timezone";

export interface JobRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface JobLoopDeps {
  /** `runner.run` — the positional arguments the loop passes. */
  run: (
    name: string,
    prompt: string,
    threadId: string,
    modelOverride: string | undefined,
    timeoutMs: number | undefined,
    agentName: string | undefined,
    timeoutCategory: string,
  ) => Promise<JobRunResult>;
  resolvePrompt: (prompt: string) => Promise<string>;
  resolveJobModel: (job: Job) => Promise<string | undefined>;
  snapshotJobFrontmatter: (jobName: string) => Promise<() => Promise<boolean>>;
  clearJobSchedule: (jobName: string) => Promise<void>;
  /** Sends a job result to the operator's channels (Telegram, Discord), as `[label]`. */
  forward: (label: string, result: JobRunResult) => void;
  /** Agent ids of the mounted bus runtime (`settings.agents`); `[]` when it is not mounted. */
  busAgentIds: () => readonly string[];
  /** Whether `agents/<name>/` holds a legacy persona (IDENTITY.md, SOUL.md or CLAUDE.md). */
  hasLegacyPersona: (agent: string) => Promise<boolean>;
  isRateLimited: () => boolean;
  /** Read on every run and tick, so a settings reload applies. */
  timezoneOffsetMinutes: () => number;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  logError?: (line: string, err: unknown) => void;
}

export interface JobLoop {
  /** Runs one job now. Resolves once its result is handled. */
  runJob(job: Job): Promise<void>;
  /** One pass of the 60 s loop: due retries, then cron matches. */
  tick(jobs: readonly Job[], now?: Date): void;
  /** In-memory retry state: resets on daemon restart (no stale debt across restarts). */
  readonly retryState: Map<string, { failCount: number; retryAt: number }>;
  /** Each job's most recent outcome, for state.json. In-memory only. */
  readonly lastResult: Map<string, { result: "ok" | "error" | "skipped"; ranAt: number }>;
}

/**
 * The jobs the bus scheduler registers. None: this loop owns every job under
 * every runtime. The bus path has no retry, per-job timeout, per-job model or
 * notify, so handing it the jobs as well ran each one twice.
 */
export function busSchedulerJobs(_jobs: readonly Job[]): readonly Job[] {
  return [];
}

export function createJobLoop(deps: JobLoopDeps): JobLoop {
  const now = deps.now ?? Date.now;
  const ts = () => new Date(now()).toLocaleTimeString();
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const logError = deps.logError ?? ((line: string, err: unknown) => console.error(line, err));
  // Jobs already warned about a bus-only `job.agent`: once per job and agent per daemon run.
  const warnedBusAgent = new Set<string>();
  const retryState = new Map<string, { failCount: number; retryAt: number }>();
  const lastResult = new Map<string, { result: "ok" | "error" | "skipped"; ranAt: number }>();

  /**
   * `job.agent` names a legacy agent (`agents/<name>/`): its persona and model
   * marker. A bus agent id (`settings.agents`) is not one, and this loop does
   * not send jobs to bus agents, so such a job runs as a plain `claude -p` —
   * say so instead of dropping the routing silently.
   */
  async function warnIfBusOnlyAgent(job: Job, model: string | undefined): Promise<void> {
    const agent = job.agent;
    if (!agent || !deps.busAgentIds().includes(agent)) return;
    const key = `${job.name}\u0000${agent}`;
    if (warnedBusAgent.has(key)) return;
    if (await deps.hasLegacyPersona(agent)) return;
    warnedBusAgent.add(key);
    const modelText = model ? `model ${JSON.stringify(model)}` : "the default model";
    warn(
      `[${ts()}] Job ${JSON.stringify(job.name)}: agent ${JSON.stringify(agent)} is a bus agent (settings.agents) with no legacy persona in agents/${agent}/. Jobs do not run in bus agent sessions; this one runs as a plain claude -p on ${modelText}. Set model: in the job's frontmatter to choose its model.`,
    );
  }

  function runJob(job: Job): Promise<void> {
    const timeoutMs = job.timeoutSeconds ? job.timeoutSeconds * 1000 : undefined;
    return deps.snapshotJobFrontmatter(job.name).then((restoreFrontmatter) =>
      deps
        .resolvePrompt(job.prompt)
        .then(async (prompt) => {
          const model = (await deps.resolveJobModel(job)) ?? job.model;
          // A warning, never a reason to skip the run.
          await warnIfBusOnlyAgent(job, model).catch((err) =>
            logError(`[${ts()}] Job ${job.name}: agent check failed:`, err),
          );
          const clock = buildClockPromptPrefix(new Date(now()), deps.timezoneOffsetMinutes());
          return deps.run(
            job.name,
            `${clock}\n${prompt}`,
            job.agent ? `agent:${job.agent}` : job.name,
            model,
            timeoutMs,
            job.agent,
            "job",
          );
        })
        .then(async (r) => {
          const restored = await restoreFrontmatter();
          if (restored) log(`[${ts()}] Restored frontmatter for job: ${job.name}`);
          lastResult.set(job.name, {
            result: r.exitCode === 0 ? "ok" : "error",
            ranAt: now(),
          });
          if (r.exitCode === 0) {
            retryState.delete(job.name);
          } else if (job.retry && job.retry > 0) {
            // Preserve existing state so failCount accumulates correctly across retries.
            const state = retryState.get(job.name) ?? { failCount: 0, retryAt: 0 };
            state.failCount += 1;
            if (state.failCount <= job.retry) {
              const delayMs = (job.retryDelay ?? 300) * 1000;
              state.retryAt = now() + delayMs;
              retryState.set(job.name, state);
              log(
                `[${ts()}] Job ${job.name} failed (attempt ${state.failCount}/${job.retry}), retrying in ${job.retryDelay ?? 300}s`,
              );
            } else {
              retryState.delete(job.name);
              log(`[${ts()}] Job ${job.name} exhausted ${job.retry} retries`);
            }
          }
          if (job.notify === false) return;
          if (job.notify === "error" && r.exitCode === 0) return;
          const forwardLabel = job.agent && job.label ? `${job.agent}: ${job.label}` : job.name;
          deps.forward(forwardLabel, r);
        })
        .finally(async () => {
          if (job.recurring) return;
          // Only clear one-shot schedule when no retry is pending.
          if (retryState.has(job.name)) return;
          try {
            await deps.clearJobSchedule(job.name);
            log(`[${ts()}] Cleared schedule for one-time job: ${job.name}`);
          } catch (err) {
            logError(`[${ts()}] Failed to clear schedule for ${job.name}:`, err);
          }
        }),
    );
  }

  function tick(jobs: readonly Job[], at: Date = new Date(now())): void {
    const tz = deps.timezoneOffsetMinutes();
    if (!deps.isRateLimited()) {
      for (const job of jobs) {
        // Fire pending retries before checking the cron schedule.
        const state = retryState.get(job.name);
        if (state && state.retryAt <= now()) {
          // Push retryAt to sentinel so subsequent cron ticks don't re-fire while in flight.
          // runJob's .then() handler overwrites this with the real next-retry time (or deletes it).
          state.retryAt = Number.MAX_SAFE_INTEGER;
          log(`[${ts()}] Retrying job: ${job.name} (attempt ${state.failCount + 1}/${job.retry})`);
          void runJob(job);
          continue;
        }
        if (cronMatches(job.schedule, at, tz)) {
          void runJob(job);
        }
      }
    } else {
      const skippedAt = now();
      for (const job of jobs) {
        const state = retryState.get(job.name);
        const retryDue = !!state && state.retryAt <= skippedAt;
        const scheduleDue = cronMatches(job.schedule, at, tz);
        if (retryDue || scheduleDue) {
          lastResult.set(job.name, { result: "skipped", ranAt: skippedAt });
        }
      }
    }
  }

  return { runJob, tick, retryState, lastResult };
}
