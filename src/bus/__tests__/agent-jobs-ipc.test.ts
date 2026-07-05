/**
 * Agent-job IPC round-trip test (#296 PR 3).
 *
 * Verifies the daemon-side wiring end-to-end over a REAL UDS, the way a
 * spawned `claude` reaches Bus core:
 *
 *   agent's dispatch_job tool  → IpcJobRequest over UDS → BusCore.handleJobRequest
 *     → AgentJobRunner.dispatch → IpcJobResult back over UDS → tool result
 *
 * The `AgentJobRunner` is REAL (so dispatch validation, the registry, the
 * concurrency/queue path, cancel, and deliverResult all run); only
 * `runAgentJob` is faked (a controllable deferred) so no real `claude -p`
 * spawns. Covers: dispatch returns an id immediately, status/list reflect the
 * registry, a finished job delivers to the dispatcher, cancel kills a running
 * job, unknown-agent + not-enabled error paths.
 *
 * Modelled on `sprint-1-e2e.test.ts` (same UDS + InMemoryTransport harness).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BusMcpServer, buildMcpServer, connectBusIpc } from "../mcp-server.js";
import { createBusCore, type BusCore } from "../core.js";
import {
  AgentJobRunner,
  DEFAULT_AGENT_JOB_CONFIG,
  type JobRunResult,
  type JobView,
} from "../agent-jobs.js";

interface Deferred {
  promise: Promise<JobRunResult>;
  resolve: (r: JobRunResult) => void;
  aborted: () => boolean;
}

interface Harness {
  bus: BusCore;
  mcp: BusMcpServer;
  client: Client;
  runner: AgentJobRunner | null;
  /** Jobs delivered back to the dispatcher (decision 1a). */
  delivered: JobView[];
  /** Per-jobId deferred controlling when the fake run resolves. */
  runs: Map<string, Deferred>;
  cleanup: () => Promise<void>;
}

/** Read + JSON.parse the single text block an agent-job tool returns. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ parsed: unknown; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { parsed: JSON.parse(res.content[0].text), isError: res.isError === true };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Throwing accessor — biome forbids the `!` non-null assertion (noNonNullAssertion). */
function mustRun(h: Harness, jobId: string): Deferred {
  const d = h.runs.get(jobId);
  if (!d) throw new Error(`no fake run registered for ${jobId}`);
  return d;
}

async function setupHarness(opts: { withJobHandler: boolean }): Promise<Harness> {
  const agentId = "dispatcher-agent";
  const tmpDir = mkdtempSync(join(tmpdir(), "bus-jobs-ipc-"));
  const socketPath = join(tmpDir, "bus.sock");

  const delivered: JobView[] = [];
  const runs = new Map<string, Deferred>();
  let idSeq = 0;

  let runner: AgentJobRunner | null = null;
  if (opts.withJobHandler) {
    runner = new AgentJobRunner(DEFAULT_AGENT_JOB_CONFIG, {
      // Fake run: park a resolver so the test decides when a job finishes.
      runAgentJob: (input) => {
        let resolve!: (r: JobRunResult) => void;
        const promise = new Promise<JobRunResult>((res) => {
          resolve = res;
        });
        runs.set(input.jobId, {
          promise,
          resolve,
          aborted: () => input.signal.aborted,
        });
        return promise;
      },
      isKnownAgent: (a) => a === "reg" || a === "suzy",
      deliverResult: (job) => delivered.push(job),
      now: () => 1_000 + idSeq,
      genId: () => `job-${++idSeq}`,
    });
  }

  const bus = createBusCore({
    socketPath,
    eventLogAppend: async (entry) =>
      ({ eventId: "test", sequence: 0, timestamp: Date.now(), ...entry }) as never,
    ...(runner ? { jobHandler: runner } : {}),
  });
  await bus.start();

  process.env.CCAW_BUS_SOCK = socketPath;
  const ipc = await connectBusIpc(process.env);
  const mcpServer = buildMcpServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  const mcp = new BusMcpServer({ agentId, ipc, mcp: mcpServer });
  mcp.sendHello();

  await waitFor(() => bus.state().connectedAgents.includes(agentId));

  const client = new Client({ name: "jobs-ipc-client", version: "0" });
  await client.connect(clientSide);

  return {
    bus,
    mcp,
    client,
    runner,
    delivered,
    runs,
    async cleanup() {
      try {
        await client.close();
      } catch {}
      try {
        await mcpServer.close();
      } catch {}
      try {
        mcp.ipc.close();
      } catch {}
      await bus.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.CCAW_BUS_SOCK;
    },
  };
}

describe("Agent-job IPC round-trip — dispatch_job over UDS (#296 PR 3)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("dispatch returns a job_id immediately; status + list reflect the registry", async () => {
    h = await setupHarness({ withJobHandler: true });

    const { parsed, isError } = await callTool(h.client, "dispatch_job", {
      agent: "reg",
      prompt: "research the thing",
    });
    expect(isError).toBe(false);
    const dispatch = parsed as { jobId: string; status: string };
    expect(dispatch.jobId).toBe("job-1");
    expect(dispatch.status).toBe("running");
    // Fire-and-return: the job is still running (its fake run hasn't resolved).
    expect(h.runs.has("job-1")).toBe(true);

    const status = (await callTool(h.client, "job_status", { job_id: "job-1" })).parsed as JobView;
    expect(status.jobId).toBe("job-1");
    expect(status.agent).toBe("reg");
    expect(status.dispatcher).toBe("dispatcher-agent"); // stamped from the socket, not the client
    expect(status.status).toBe("running");

    const list = (await callTool(h.client, "list_jobs")).parsed as JobView[];
    expect(list).toHaveLength(1);
    expect(list[0].jobId).toBe("job-1");
  });

  it("a finished job transitions to done and is delivered back to the dispatcher", async () => {
    h = await setupHarness({ withJobHandler: true });
    await callTool(h.client, "dispatch_job", { agent: "reg", prompt: "go" });

    // Resolve the fake run → the runner finishes + delivers.
    mustRun(h, "job-1").resolve({ exitCode: 0, resultText: "the answer is 42" });
    await waitFor(() => h.delivered.length > 0);

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].jobId).toBe("job-1");
    expect(h.delivered[0].status).toBe("done");
    expect(h.delivered[0].resultText).toBe("the answer is 42");
    expect(h.delivered[0].dispatcher).toBe("dispatcher-agent");

    const status = (await callTool(h.client, "job_status", { job_id: "job-1" })).parsed as JobView;
    expect(status.status).toBe("done");
    expect(status.resultText).toBe("the answer is 42");
  });

  it("cancel_job aborts a running job and marks it cancelled", async () => {
    h = await setupHarness({ withJobHandler: true });
    await callTool(h.client, "dispatch_job", { agent: "reg", prompt: "long job" });

    const cancel = (await callTool(h.client, "cancel_job", { job_id: "job-1" })).parsed as {
      ok: boolean;
    };
    expect(cancel.ok).toBe(true);
    // The runner aborted the run's signal.
    expect(mustRun(h, "job-1").aborted()).toBe(true);

    const status = (await callTool(h.client, "job_status", { job_id: "job-1" })).parsed as JobView;
    expect(status.status).toBe("cancelled");
  });

  it("dispatch to an unknown agent returns an error result (no job spawned)", async () => {
    h = await setupHarness({ withJobHandler: true });
    const { parsed } = await callTool(h.client, "dispatch_job", {
      agent: "nobody",
      prompt: "x",
    });
    expect((parsed as { error: string }).error).toContain("unknown agent");
    expect(h.runs.size).toBe(0);
  });

  it("cancel of an unknown job_id returns ok:false with a reason", async () => {
    h = await setupHarness({ withJobHandler: true });
    const { parsed } = await callTool(h.client, "cancel_job", { job_id: "does-not-exist" });
    expect(parsed as { ok: boolean; error?: string }).toMatchObject({ ok: false });
  });

  it("with no job handler wired, job tools return a clean 'not enabled' error (never hang)", async () => {
    h = await setupHarness({ withJobHandler: false });
    const { parsed, isError } = await callTool(h.client, "dispatch_job", {
      agent: "reg",
      prompt: "x",
    });
    expect(isError).toBe(true);
    expect((parsed as { error: string }).error).toContain("not enabled");
  });
});
