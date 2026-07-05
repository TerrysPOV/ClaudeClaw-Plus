import { describe, it, expect } from "bun:test";
import {
  AgentJobRunner,
  DEFAULT_AGENT_JOB_CONFIG,
  type AgentJobConfig,
  type AgentJobDeps,
  type JobRunResult,
  type JobView,
} from "../agent-jobs";

const flush = () => new Promise((r) => setTimeout(r, 0));

interface FakeRun {
  input: { jobId: string; agent: string; prompt: string; timeoutMs: number; signal: AbortSignal };
  resolve: (r: JobRunResult) => void;
  reject: (e: unknown) => void;
  aborted: boolean;
}

/** Index into the recorded runs, throwing (not `!`) if the run isn't there. */
function at(runs: FakeRun[], i: number): FakeRun {
  const r = runs[i];
  if (!r) throw new Error(`expected a run at index ${i}`);
  return r;
}

function harness(config: AgentJobConfig = DEFAULT_AGENT_JOB_CONFIG) {
  let idCounter = 0;
  let clock = 0;
  const delivered: JobView[] = [];
  const runs: FakeRun[] = [];
  const deps: AgentJobDeps = {
    runAgentJob: (input) =>
      new Promise<JobRunResult>((resolve, reject) => {
        const run: FakeRun = { input, resolve, reject, aborted: false };
        input.signal.addEventListener("abort", () => {
          run.aborted = true;
          reject(new Error("aborted")); // a killed process settles the promise
        });
        runs.push(run);
      }),
    isKnownAgent: (a) => a === "reg" || a === "suzy",
    deliverResult: (v) => delivered.push(v),
    now: () => clock,
    genId: () => `job-${++idCounter}`,
  };
  const runner = new AgentJobRunner(config, deps);
  return { runner, runs, delivered, setClock: (n: number) => (clock = n) };
}

const jobIdOf = (r: { jobId: string } | { error: string }) => ("jobId" in r ? r.jobId : "");

/* ── dispatch (fire-and-return + validation) ───────────────────────────── */

describe("AgentJobRunner.dispatch", () => {
  it("registers a job and returns its id immediately (running under the cap)", () => {
    const { runner, runs } = harness();
    const r = runner.dispatch({ agent: "reg", prompt: "research x", dispatcher: "claw" });
    expect("jobId" in r).toBe(true);
    if ("jobId" in r) expect(r.status).toBe("running");
    expect(runs).toHaveLength(1); // started synchronously, not awaited
  });

  it("rejects unknown agent and empty agent/prompt/dispatcher", () => {
    const { runner } = harness();
    // Security review #296 PR 3: the error must NOT echo the raw caller input.
    expect(runner.dispatch({ agent: "nope", prompt: "x", dispatcher: "claw" })).toEqual({
      error: "unknown agent",
    });
    expect(runner.dispatch({ agent: "", prompt: "x", dispatcher: "claw" })).toEqual({
      error: "agent is required",
    });
    expect(runner.dispatch({ agent: "reg", prompt: "  ", dispatcher: "claw" })).toEqual({
      error: "prompt is required",
    });
    expect(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "  " })).toEqual({
      error: "dispatcher is required",
    });
  });

  it("rejects a prompt over maxPromptChars (DoS bound)", () => {
    const { runner } = harness({ ...DEFAULT_AGENT_JOB_CONFIG, maxPromptChars: 10 });
    const r = runner.dispatch({ agent: "reg", prompt: "x".repeat(11), dispatcher: "claw" });
    expect(r).toEqual({ error: "prompt exceeds 10-char limit" });
  });

  it("rejects dispatch once the queue is full (maxQueued)", () => {
    // maxConcurrent 1 → 1 running; maxQueued 1 → 1 waiting; the 3rd is rejected.
    const { runner } = harness({ ...DEFAULT_AGENT_JOB_CONFIG, maxConcurrent: 1, maxQueued: 1 });
    expect("jobId" in runner.dispatch({ agent: "reg", prompt: "a", dispatcher: "claw" })).toBe(
      true,
    );
    expect("jobId" in runner.dispatch({ agent: "reg", prompt: "b", dispatcher: "claw" })).toBe(
      true,
    );
    expect(runner.dispatch({ agent: "reg", prompt: "c", dispatcher: "claw" })).toEqual({
      error: "job queue is full (max 1)",
    });
  });

  it("cancelling a queued job frees a maxQueued slot while the worker stays busy (Codex review)", () => {
    const { runner } = harness({ ...DEFAULT_AGENT_JOB_CONFIG, maxConcurrent: 1, maxQueued: 1 });
    runner.dispatch({ agent: "reg", prompt: "a", dispatcher: "claw" }); // running (fills worker)
    const q = jobIdOf(runner.dispatch({ agent: "reg", prompt: "b", dispatcher: "claw" })); // queued
    // Queue is full → a third is rejected.
    expect(runner.dispatch({ agent: "reg", prompt: "c", dispatcher: "claw" })).toEqual({
      error: "job queue is full (max 1)",
    });
    // Cancelling the queued job must remove it from the queue so capacity frees
    // up — even though the single worker is STILL running job "a".
    expect(runner.cancel(q)).toEqual({ ok: true });
    expect("jobId" in runner.dispatch({ agent: "reg", prompt: "c", dispatcher: "claw" })).toBe(
      true,
    );
  });

  it("evicts oldest TERMINAL records past maxRetained (never a live one)", async () => {
    // maxConcurrent 1, maxRetained 2. Run 3 jobs to completion sequentially.
    const { runner, runs } = harness({
      ...DEFAULT_AGENT_JOB_CONFIG,
      maxConcurrent: 1,
      maxRetained: 2,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(jobIdOf(runner.dispatch({ agent: "reg", prompt: `p${i}`, dispatcher: "claw" })));
      at(runs, i).resolve({ exitCode: 0, resultText: `r${i}` });
      await flush();
    }
    // Registry bounded to 2; the oldest (job-1) was evicted, newest two remain.
    expect(runner.list()).toHaveLength(2);
    expect(runner.status(ids[0])).toBeNull();
    expect(runner.status(ids[2])?.status).toBe("done");
  });
});

/* ── terminal outcomes → status + delivery ─────────────────────────────── */

describe("AgentJobRunner outcomes", () => {
  it("a completed job → done + resultText, delivered to the dispatcher", async () => {
    const { runner, runs, delivered } = harness();
    const id = jobIdOf(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" }));
    at(runs, 0).resolve({ exitCode: 0, resultText: "3 proposals written" });
    await flush();
    expect(runner.status(id)?.status).toBe("done");
    expect(runner.status(id)?.resultText).toBe("3 proposals written");
    const d = delivered.find((x) => x.jobId === id);
    expect(d?.status).toBe("done");
    expect(d?.dispatcher).toBe("claw");
  });

  it("a rejected run → failed", async () => {
    const { runner, runs } = harness();
    const id = jobIdOf(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" }));
    at(runs, 0).reject(new Error("spawn failed"));
    await flush();
    expect(runner.status(id)?.status).toBe("failed");
    expect(runner.status(id)?.error).toContain("spawn failed");
  });

  it("a timed-out run → timeout", async () => {
    const { runner, runs } = harness();
    const id = jobIdOf(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" }));
    at(runs, 0).resolve({ exitCode: 124, timedOut: true });
    await flush();
    expect(runner.status(id)?.status).toBe("timeout");
  });
});

/* ── concurrency cap ───────────────────────────────────────────────────── */

describe("AgentJobRunner concurrency", () => {
  it("caps running jobs and queues the excess, starting the next on completion", async () => {
    const { runner, runs } = harness({ ...DEFAULT_AGENT_JOB_CONFIG, maxConcurrent: 2 });
    const a = runner.dispatch({ agent: "reg", prompt: "a", dispatcher: "claw" });
    const b = runner.dispatch({ agent: "reg", prompt: "b", dispatcher: "claw" });
    const c = runner.dispatch({ agent: "reg", prompt: "c", dispatcher: "claw" });
    expect("jobId" in a && a.status).toBe("running");
    expect("jobId" in b && b.status).toBe("running");
    expect("jobId" in c && c.status).toBe("queued");
    expect(runs).toHaveLength(2); // only 2 spawned

    at(runs, 0).resolve({ exitCode: 0, resultText: "a" });
    await flush();
    expect(runs).toHaveLength(3); // c starts as a slot frees
    expect(runner.status(jobIdOf(c))?.status).toBe("running");
  });
});

/* ── cancel + stop ─────────────────────────────────────────────────────── */

describe("AgentJobRunner cancel/stop", () => {
  it("cancels a running job (aborts the signal) and delivers cancelled", async () => {
    const { runner, runs, delivered } = harness();
    const id = jobIdOf(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" }));
    expect(runner.cancel(id)).toEqual({ ok: true });
    expect(at(runs, 0).aborted).toBe(true);
    expect(runner.status(id)?.status).toBe("cancelled");
    await flush();
    expect(delivered.find((x) => x.jobId === id)?.status).toBe("cancelled");
  });

  it("cancels a queued job without ever starting it", () => {
    const { runner, runs, delivered } = harness({ ...DEFAULT_AGENT_JOB_CONFIG, maxConcurrent: 1 });
    runner.dispatch({ agent: "reg", prompt: "a", dispatcher: "claw" }); // running
    const q = jobIdOf(runner.dispatch({ agent: "reg", prompt: "b", dispatcher: "claw" })); // queued
    expect(runner.status(q)?.status).toBe("queued");
    expect(runner.cancel(q)).toEqual({ ok: true });
    expect(runner.status(q)?.status).toBe("cancelled");
    expect(runs).toHaveLength(1); // never spawned
    expect(delivered.find((x) => x.jobId === q)?.status).toBe("cancelled");
  });

  it("cancelling a terminal job errors; unknown job errors", async () => {
    const { runner, runs } = harness();
    const id = jobIdOf(runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" }));
    at(runs, 0).resolve({ exitCode: 0, resultText: "done" });
    await flush();
    expect(runner.cancel(id)).toEqual({ ok: false, error: "job already done" });
    expect(runner.cancel("nope")).toEqual({ ok: false, error: "unknown job" });
  });

  it("stop() aborts everything in flight and refuses new dispatch", () => {
    const { runner, runs } = harness();
    runner.dispatch({ agent: "reg", prompt: "x", dispatcher: "claw" });
    runner.stop();
    expect(at(runs, 0).aborted).toBe(true);
    expect(runner.dispatch({ agent: "reg", prompt: "y", dispatcher: "claw" })).toEqual({
      error: "job runner is stopped",
    });
  });
});
