/**
 * AgentJobRunner — a first-class background "agent job" primitive for the bus.
 *
 * The root cause of the #295 outage: an agent (Claw) needed to run another agent
 * (reg/suzy) as a long autonomous BATCH job, but the bus only offers interactive
 * turn-based sessions and no dispatch tool, so Claw hand-rolled `/tmp` fire-scripts
 * that `Bun.spawn(["claude","-p",…])` and backgrounded them with `nohup … &` — which
 * held the tool's pipe and wedged the session for ~11h.
 *
 * This gives jobs a supported home: `dispatch()` registers a job and returns its id
 * IMMEDIATELY (fire-and-return — the caller never awaits, which is exactly what
 * wedged #295). The job runs headless in its own tracked process (injected
 * `runAgentJob`, wired to `runClaudeOnce` + `loadAgentPrompts`), bounded by a
 * concurrency cap, cancellable, and its result delivered back to the dispatcher
 * AND kept queryable. In-memory only (a restart cancels in-flight jobs — matches
 * the scheduler + restart-rotation model). SPEC: `.planning/agent-job-primitive/SPEC.md`.
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "timeout";

const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled", "timeout"]);

interface JobRecord {
  jobId: string;
  agent: string;
  dispatcher: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  resultText?: string;
  error?: string;
}

/** Public snapshot of a job (omits the prompt/model to keep it lean). */
export interface JobView {
  jobId: string;
  agent: string;
  dispatcher: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  resultText?: string;
  error?: string;
}

export interface AgentJobConfig {
  /** Max jobs running at once; excess queue (a low-spec box can't be swamped). */
  maxConcurrent: number;
  /** Default per-job wall-clock, when the caller doesn't specify one. */
  defaultTimeoutMs: number;
  /** Hard cap on any job's wall-clock, even if the caller asks for more. */
  maxTimeoutMs: number;
  /**
   * Max jobs allowed to sit in the queue at once. A dispatch past this is
   * rejected rather than queued (security review #296 PR 3: an agent looping
   * `dispatch_job` must not grow the queue unbounded → OOM).
   */
  maxQueued: number;
  /**
   * Max total job RECORDS retained in the registry. Terminal jobs are evicted
   * oldest-first past this cap so completed records (which hold prompt +
   * resultText) can't accumulate for the daemon's lifetime.
   */
  maxRetained: number;
  /** Max characters in a job prompt; a longer dispatch is rejected. */
  maxPromptChars: number;
}

export const DEFAULT_AGENT_JOB_CONFIG: AgentJobConfig = {
  maxConcurrent: 3,
  defaultTimeoutMs: 30 * 60_000, // 30 min
  maxTimeoutMs: 60 * 60_000, // 60 min hard cap
  maxQueued: 50,
  maxRetained: 200,
  maxPromptChars: 100_000,
};

/**
 * Parse `settings.agentJobs` from raw JSON, clamping to sane bounds and
 * falling back to {@link DEFAULT_AGENT_JOB_CONFIG} for any missing/invalid
 * field. Mirrors `parseStallWatchdogConfig` — the bus module owns its config
 * shape so `config.ts` just imports this. `defaultTimeoutMs` is never allowed
 * to exceed `maxTimeoutMs` (an operator raising only the default shouldn't
 * silently blow past the hard cap).
 */
export function parseAgentJobConfig(raw: unknown): AgentJobConfig {
  const r = (raw ?? {}) as Partial<Record<keyof AgentJobConfig, unknown>>;
  const num = (v: unknown, fallback: number, min: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;
  const maxConcurrent = Math.floor(num(r.maxConcurrent, DEFAULT_AGENT_JOB_CONFIG.maxConcurrent, 1));
  const maxTimeoutMs = num(r.maxTimeoutMs, DEFAULT_AGENT_JOB_CONFIG.maxTimeoutMs, 1_000);
  const defaultTimeoutMs = Math.min(
    num(r.defaultTimeoutMs, DEFAULT_AGENT_JOB_CONFIG.defaultTimeoutMs, 1_000),
    maxTimeoutMs,
  );
  const maxQueued = Math.floor(num(r.maxQueued, DEFAULT_AGENT_JOB_CONFIG.maxQueued, 1));
  const maxRetained = Math.floor(num(r.maxRetained, DEFAULT_AGENT_JOB_CONFIG.maxRetained, 1));
  const maxPromptChars = Math.floor(
    num(r.maxPromptChars, DEFAULT_AGENT_JOB_CONFIG.maxPromptChars, 1),
  );
  return { maxConcurrent, defaultTimeoutMs, maxTimeoutMs, maxQueued, maxRetained, maxPromptChars };
}

/**
 * The daemon-facing surface of the job runner — the four operations Bus core
 * routes an `IpcJobRequest` to. {@link AgentJobRunner} implements it; Bus core
 * depends only on this interface so it stays decoupled from the runner's
 * process-spawning internals (and tests can inject a fake).
 */
export interface AgentJobHandler {
  dispatch(input: {
    agent: string;
    prompt: string;
    dispatcher: string;
    model?: string;
    timeoutMs?: number;
  }): { jobId: string; status: JobStatus } | { error: string };
  status(jobId: string): JobView | null;
  list(): JobView[];
  cancel(jobId: string): { ok: boolean; error?: string };
}

export interface JobRunResult {
  exitCode: number;
  resultText?: string;
  error?: string;
  /** True if the run hit its wall-clock timeout. */
  timedOut?: boolean;
}

export interface AgentJobDeps {
  /** Run the agent headless (wraps `runClaudeOnce` + `loadAgentPrompts`). MUST honour
   *  the AbortSignal — kill the process when it aborts (cancel / stop). */
  runAgentJob(input: {
    jobId: string;
    agent: string;
    prompt: string;
    model?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<JobRunResult>;
  /** Is `agent` a known agent that can run a job? */
  isKnownAgent(agent: string): boolean;
  /** Deliver a finished job's result back to the dispatcher (decision 1a). Best-effort. */
  deliverResult(job: JobView): void;
  /** Clock seam (tests inject a deterministic clock). */
  now(): number;
  /** Job-id generator (test seam). */
  genId(): string;
}

export class AgentJobRunner implements AgentJobHandler {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  private stopped = false;

  constructor(
    private readonly config: AgentJobConfig,
    private readonly deps: AgentJobDeps,
  ) {}

  /**
   * Register a job and return its id IMMEDIATELY. The job runs in the background
   * (or queues if at the concurrency cap). Never awaits the job.
   */
  dispatch(input: {
    agent: string;
    prompt: string;
    dispatcher: string;
    model?: string;
    timeoutMs?: number;
  }): { jobId: string; status: JobStatus } | { error: string } {
    if (this.stopped) return { error: "job runner is stopped" };
    const dispatcher = (input.dispatcher ?? "").trim();
    const agent = (input.agent ?? "").trim();
    const prompt = (input.prompt ?? "").trim();
    if (!dispatcher) return { error: "dispatcher is required" };
    if (!agent) return { error: "agent is required" };
    if (!prompt) return { error: "prompt is required" };
    if (prompt.length > this.config.maxPromptChars) {
      return { error: `prompt exceeds ${this.config.maxPromptChars}-char limit` };
    }
    if (!this.deps.isKnownAgent(agent)) return { error: "unknown agent" };
    // Bound the queue so a caller looping dispatch can't grow it unbounded
    // (security review #296 PR 3). Running jobs are capped separately by
    // maxConcurrent; this caps the WAITING backlog.
    if (this.queue.length >= this.config.maxQueued) {
      return { error: `job queue is full (max ${this.config.maxQueued})` };
    }

    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? this.config.defaultTimeoutMs, 1_000),
      this.config.maxTimeoutMs,
    );
    const jobId = this.deps.genId();
    this.jobs.set(jobId, {
      jobId,
      agent,
      dispatcher,
      prompt,
      model: input.model,
      timeoutMs,
      status: "queued",
      createdAt: this.deps.now(),
    });
    this.queue.push(jobId);
    this.evictOldTerminal();
    this.maybeStart();
    return { jobId, status: this.jobs.get(jobId)?.status ?? "queued" };
  }

  /**
   * Bound registry memory: when total records exceed `maxRetained`, drop the
   * OLDEST terminal records (never a queued/running one — those are live).
   * Terminal records hold prompt + resultText, so without this they'd
   * accumulate for the daemon's lifetime (security review #296 PR 3).
   */
  private evictOldTerminal(): void {
    let overBy = this.jobs.size - this.config.maxRetained;
    if (overBy <= 0) return;
    // Map preserves insertion order → iterating yields oldest-first.
    for (const [id, rec] of this.jobs) {
      if (overBy <= 0) break;
      if (TERMINAL.has(rec.status)) {
        this.jobs.delete(id);
        overBy--;
      }
    }
  }

  status(jobId: string): JobView | null {
    const rec = this.jobs.get(jobId);
    return rec ? this.view(rec) : null;
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((r) => this.view(r));
  }

  /** Cancel a queued or running job. Terminal jobs return an error. */
  cancel(jobId: string): { ok: boolean; error?: string } {
    const rec = this.jobs.get(jobId);
    if (!rec) return { ok: false, error: "unknown job" };
    if (TERMINAL.has(rec.status)) return { ok: false, error: `job already ${rec.status}` };

    const wasRunning = rec.status === "running";
    rec.status = "cancelled";
    rec.endedAt = this.deps.now();
    const controller = this.controllers.get(jobId);
    if (controller) {
      controller.abort(); // running → the runAgentJob rejection/resolution flows into finish()
    } else if (!wasRunning) {
      // queued cancel: it never started, so finish() won't run — deliver + move on here.
      this.deliver(rec);
      this.maybeStart();
    }
    return { ok: true };
  }

  /** Stop the runner: cancel everything in flight + clear the queue. */
  stop(): void {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
    this.queue.length = 0;
  }

  private maybeStart(): void {
    while (
      !this.stopped &&
      this.runningCount < this.config.maxConcurrent &&
      this.queue.length > 0
    ) {
      const jobId = this.queue.shift();
      if (jobId === undefined) break;
      const rec = this.jobs.get(jobId);
      if (!rec || rec.status !== "queued") continue; // cancelled while queued → skip
      this.startJob(rec);
    }
  }

  private startJob(rec: JobRecord): void {
    rec.status = "running";
    rec.startedAt = this.deps.now();
    this.runningCount++;
    const controller = new AbortController();
    this.controllers.set(rec.jobId, controller);
    this.deps
      .runAgentJob({
        jobId: rec.jobId,
        agent: rec.agent,
        prompt: rec.prompt,
        model: rec.model,
        timeoutMs: rec.timeoutMs,
        signal: controller.signal,
      })
      .then(
        (r) => this.finish(rec.jobId, r),
        (err) =>
          this.finish(rec.jobId, {
            exitCode: -1,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
  }

  private finish(jobId: string, r: JobRunResult): void {
    const rec = this.jobs.get(jobId);
    if (!rec) return;
    this.controllers.delete(jobId);
    // A cancel that raced in already set the terminal state — don't overwrite it.
    if (rec.status !== "cancelled") {
      rec.status = r.timedOut ? "timeout" : r.error ? "failed" : "done";
      rec.exitCode = r.exitCode;
      rec.resultText = r.resultText;
      rec.error = r.error;
    }
    if (rec.endedAt === undefined) rec.endedAt = this.deps.now();
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.deliver(rec);
    this.evictOldTerminal();
    this.maybeStart();
  }

  private deliver(rec: JobRecord): void {
    try {
      this.deps.deliverResult(this.view(rec));
    } catch {
      /* delivery is best-effort — never let it break the runner */
    }
  }

  private view(rec: JobRecord): JobView {
    return {
      jobId: rec.jobId,
      agent: rec.agent,
      dispatcher: rec.dispatcher,
      status: rec.status,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      exitCode: rec.exitCode,
      resultText: rec.resultText,
      error: rec.error,
    };
  }
}
