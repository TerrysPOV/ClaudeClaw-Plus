/**
 * #595 round 7: every IPC frame the MCP server turns into model input leaves Bus core through ONE
 * gate (`emitModelInput`). Rounds 5 and 6 each closed a caller that sent a prompt before the claude
 * was recorded as ours; round 6 left `ask_answer` (a channel notification, so a turn) open.
 *
 * Part 1 drives a real BusCore and a raw Unix-socket client (`ask_answer` held, failed, timed out).
 * Part 2 puts a real `BusMcpServer` and an MCP SDK client behind the same socket, as in Codex's r6
 * probe, and covers pending, success, failure, timeout and a stale ask id end to end.
 * Part 3 pins the shape from the syntax tree (model-input-shape.ts): `IpcServer.send` has two callers,
 * `recordingPending` one reader, and no alias, destructure or second sender can exist.
 *
 * Absence is proven with a barrier, not a sleep: the bus writes one socket in order, so once a later
 * CONTROL frame (`permission_response`: it answers a request the claude made and starts no turn, and
 * is never held) has arrived, every earlier frame has too.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EventEntryInput, EventRecord } from "../../event-log";
import { AgentNotRecordedError, type BusCore, createBusCore, encodeFrame } from "../core";
import { FrameDecoder } from "../core-ipc";
import { BusMcpServer, buildMcpServer } from "../mcp-server";
import type { IpcMessage } from "../types";
import { type BusSource, checkModelInputBoundary } from "./model-input-shape";

function mockEventLog() {
  let seq = 0;
  return async (entry: EventEntryInput): Promise<EventRecord> => {
    seq += 1;
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      seq,
      type: entry.type,
      source: entry.source,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      status: "done",
      channelId: entry.channelId,
      threadId: entry.threadId,
      payload: entry.payload,
      dedupeKey: entry.dedupeKey,
      retryCount: 0,
      nextRetryAt: null,
      correlationId: entry.correlationId ?? null,
      causationId: entry.causationId ?? null,
      replayedFromEventId: entry.replayedFromEventId ?? null,
      lastError: null,
    };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for a cheap local condition, far longer than a loaded machine needs; a miss FAILS. */
const until = async (cond: () => boolean, ms = 90_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await sleep(10);
  }
};

function manual<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Errors = Array<{ err: unknown; ctx: Record<string, unknown> }>;

let tempDir: string;
let bus: BusCore | null = null;
let closers: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bus-595r7-"));
});

afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers = [];
  await bus?.stop();
  bus = null;
  rmSync(tempDir, { recursive: true, force: true });
});

async function startBus(over: { deliveryBackstopMs?: number } = {}) {
  const errors: Errors = [];
  const sockPath = join(tempDir, "bus.sock");
  bus = createBusCore({
    eventLogAppend: mockEventLog(),
    turnEndSettleMs: 0,
    socketPath: sockPath,
    // The 4 s default races a loaded machine; the timeout tests pass their own.
    deliveryBackstopMs: 120_000,
    onError: (err, ctx) => errors.push({ err, ctx: (ctx ?? {}) as Record<string, unknown> }),
    ...over,
  });
  await bus.start();
  return { bus, sockPath, errors };
}

/** Everything the socket receives, plus a hook so a harness can feed a BusMcpServer. */
async function connectSocket(sockPath: string) {
  const frames: IpcMessage[] = [];
  const listeners: Array<(m: IpcMessage) => void> = [];
  const decoder = new FrameDecoder(
    (m) => {
      frames.push(m);
      for (const fn of listeners) fn(m);
    },
    () => {},
  );
  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      open() {},
      data(_s, data) {
        decoder.push(data);
      },
      error() {},
      close() {},
    },
  });
  closers.push(() => {
    socket.end();
  });
  return { socket, frames, listeners };
}

async function barrier(frames: IpcMessage[], b: BusCore, agent_id: string): Promise<void> {
  const request_id = `barrier-${randomUUID()}`;
  b.ingestPermissionDecision({ agent_id, request_id, behavior: "allow" });
  await until(() =>
    frames.some(
      (m) =>
        m.type === "permission_response" &&
        (m as { response?: { request_id?: string } }).response?.request_id === request_id,
    ),
  );
}

const askAnswers = (frames: IpcMessage[]) => frames.filter((m) => m.type === "ask_answer");

describe("ask_answer waits for the record (#595 r7), at the bus", () => {
  async function rawAgent(over: { deliveryBackstopMs?: number } = {}) {
    const started = await startBus(over);
    const c = await connectSocket(started.sockPath);
    c.socket.write(
      encodeFrame({
        type: "hello",
        agent_id: "alpha",
        capabilities: ["claude/channel", "claude/channel/permission"],
      }),
    );
    await until(() => started.bus.state().connectedAgents.includes("alpha"));
    return { ...started, frames: c.frames };
  }

  it("held while the record is pending, then sent once with the ask_id it was given", async () => {
    // Fault (site: the pending check in `emitModelInput`, removed): the frame is written at once.
    // Predicted result: an ask_answer is in `frames` before the record exists.
    const { bus: b, frames, errors } = await rawAgent();
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);

    b.ingestAskAnswer({ agent_id: "alpha", ask_id: "ask-1", answer: "the answer" });
    await barrier(frames, b, "alpha");
    expect(askAnswers(frames)).toEqual([]);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await until(() => askAnswers(frames).length === 1);
    await barrier(frames, b, "alpha");
    expect(askAnswers(frames)).toEqual([
      { type: "ask_answer", agent_id: "alpha", ask_id: "ask-1", answer: "the answer" },
    ]);
    expect(errors).toEqual([]);
  }, 30_000);

  it("a record that failed: nothing is sent, and the failure names the ask_id", async () => {
    const { bus: b, frames, errors } = await rawAgent();
    const pending = manual();
    pending.promise.catch(() => {});
    b.setRecordingPendingHandler?.(() => pending.promise);

    b.ingestAskAnswer({ agent_id: "alpha", ask_id: "ask-2", answer: "never delivered" });
    pending.reject(new Error("ENOSPC"));
    await until(() => errors.length > 0);
    await barrier(frames, b, "alpha");

    expect(askAnswers(frames)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.err).toBeInstanceOf(AgentNotRecordedError);
    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-failed");
    expect(errors[0]?.ctx).toMatchObject({
      ctx: "ingestAskAnswer:recording-pending",
      agent_id: "alpha",
      ask_id: "ask-2",
    });
  }, 30_000);

  it("a record that never settles: the backstop fails it with recording-timeout", async () => {
    const { bus: b, frames, errors } = await rawAgent({ deliveryBackstopMs: 100 });
    b.setRecordingPendingHandler?.(() => new Promise<void>(() => {}));

    b.ingestAskAnswer({ agent_id: "alpha", ask_id: "ask-3", answer: "late" });
    await until(() => errors.length > 0);
    await barrier(frames, b, "alpha");

    expect(askAnswers(frames)).toEqual([]);
    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-timeout");
    expect(errors[0]?.ctx).toMatchObject({ ask_id: "ask-3" });
  }, 30_000);

  it("nothing pending: sent at once, as before (no added wait)", async () => {
    const { bus: b, frames } = await rawAgent();
    b.ingestAskAnswer({ agent_id: "alpha", ask_id: "ask-4", answer: "now" });
    await until(() => askAnswers(frames).length === 1);
  }, 30_000);
});

/** A real BusMcpServer and MCP SDK client behind the bus's socket, as in Codex's r6 probe. */
async function mcpAgent(over: { deliveryBackstopMs?: number } = {}) {
  const started = await startBus(over);
  const c = await connectSocket(started.sockPath);
  const mcp = buildMcpServer();
  const server = new BusMcpServer({
    agentId: "alpha",
    mcp,
    ipc: {
      send(m) {
        c.socket.write(encodeFrame(m));
      },
      onMessage(fn) {
        c.listeners.push(fn);
      },
      async close() {
        c.socket.end();
      },
    },
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r7", version: "1" }, { capabilities: {} });
  const notifications: Array<{ params: { content: string; meta: Record<string, string> } }> = [];
  client.setNotificationHandler(
    NotificationSchema.extend({ method: z.literal("notifications/claude/channel") }),
    async (n) => {
      notifications.push(n as unknown as (typeof notifications)[number]);
    },
  );
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  closers.push(async () => {
    await client.close();
    await mcp.close();
  });
  server.sendHello();
  await until(() => started.bus.isAgentConnected("alpha"));
  /** The agent asks a question; returns the ask_id the MCP server allocated. */
  const ask = async (): Promise<string> => {
    const r = await client.callTool({ name: "ask", arguments: { question: "which file?" } });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? "{}";
    return (JSON.parse(text) as { ask_id: string }).ask_id;
  };
  return { ...started, frames: c.frames, server, client, notifications, ask };
}

describe("ask_answer socket-to-MCP (#595 r7)", () => {
  it("pending: no frame and no channel notification until the record exists; then exactly one", async () => {
    const { bus: b, frames, server, notifications, ask } = await mcpAgent();
    const ask_id = await ask();
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);

    b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "src/foo.ts" });
    await barrier(frames, b, "alpha");
    expect(askAnswers(frames)).toEqual([]);
    expect(notifications).toEqual([]);
    expect(server.hasPendingAnswer(ask_id)).toBe(true);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await until(() => notifications.length === 1);
    expect(notifications[0]?.params.content).toBe("src/foo.ts");
    expect(notifications[0]?.params.meta).toMatchObject({ ask_id, kind: "ask_answer" });
    expect(server.hasPendingAnswer(ask_id)).toBe(false);
    await barrier(frames, b, "alpha");
    expect(notifications).toHaveLength(1);
  }, 30_000);

  it("pending: a request_human tool call stays blocked until the record exists, then returns the answer", async () => {
    const { bus: b, frames, client } = await mcpAgent();
    const asked = manual<string>();
    b.subscribe({ agent_id: "alpha", topics: ["system.request_human"] }, (e) => {
      asked.resolve((e.payload as { ask_id: string }).ask_id);
    });
    const call = client.callTool({ name: "request_human", arguments: { question: "approve?" } });
    let settled = false;
    void call.then(() => {
      settled = true;
    });
    const ask_id = await asked.promise;

    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "yes" });
    await barrier(frames, b, "alpha");
    expect(askAnswers(frames)).toEqual([]);
    expect(settled).toBe(false);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    const result = await call;
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe("yes");
  }, 30_000);

  it("failure: the answer is never delivered, the ask stays outstanding, and the failure names it", async () => {
    const { bus: b, frames, errors, server, notifications, ask } = await mcpAgent();
    const ask_id = await ask();
    const pending = manual();
    pending.promise.catch(() => {});
    b.setRecordingPendingHandler?.(() => pending.promise);

    b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "lost" });
    pending.reject(new Error("ENOSPC"));
    await until(() => errors.length > 0);
    await barrier(frames, b, "alpha");

    expect(askAnswers(frames)).toEqual([]);
    expect(notifications).toEqual([]);
    expect(server.hasPendingAnswer(ask_id)).toBe(true);
    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-failed");
    expect(errors[0]?.ctx).toMatchObject({ ask_id });
  }, 30_000);

  it("timeout: the backstop fails the answer with recording-timeout and nothing reaches the model", async () => {
    const {
      bus: b,
      frames,
      errors,
      notifications,
      ask,
    } = await mcpAgent({ deliveryBackstopMs: 100 });
    const ask_id = await ask();
    b.setRecordingPendingHandler?.(() => new Promise<void>(() => {}));

    b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "too late" });
    await until(() => errors.length > 0);
    await barrier(frames, b, "alpha");

    expect(askAnswers(frames)).toEqual([]);
    expect(notifications).toEqual([]);
    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-timeout");
    expect(errors[0]?.ctx).toMatchObject({ ask_id });
  }, 30_000);

  it("stale ask id: dropped at the MCP boundary with a reason-coded line, never a channel notification", async () => {
    // Fault (site: the unknown-ask-id drop in `deliverAskAnswer`, removed): the answer becomes an
    // unsolicited channel notification. Predicted result: `notifications` has one entry.
    const { bus: b, frames, notifications, ask } = await mcpAgent();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // An answer to a question a previous process asked, nothing pending on the bus.
      b.ingestAskAnswer({ agent_id: "alpha", ask_id: "ask-from-prior-process", answer: "stale" });
      await until(() => askAnswers(frames).length === 1);
      await barrier(frames, b, "alpha");
      await sleep(50);
      expect(notifications).toEqual([]);

      // A second answer to a question this process did ask, once the first has been delivered.
      const ask_id = await ask();
      b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "first" });
      await until(() => notifications.length === 1);
      b.ingestAskAnswer({ agent_id: "alpha", ask_id, answer: "second" });
      await until(() => askAnswers(frames).length === 3);
      await barrier(frames, b, "alpha");
      await sleep(50);
      expect(notifications).toHaveLength(1);

      const dropped = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("reason=no-pending-ask"));
      expect(dropped.filter((l) => l.includes("ask-from-prior-process"))).toHaveLength(1);
      expect(dropped.filter((l) => l.includes(ask_id))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  }, 30_000);
});

/** Every non-test `.ts` file under `src/bus/`, named relative to it. */
function readBusSources(dir = join(import.meta.dir, ".."), prefix = ""): BusSource[] {
  const out: BusSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        out.push(...readBusSources(join(dir, entry.name), `${prefix}${entry.name}/`));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push({
        name: `${prefix}${entry.name}`,
        text: readFileSync(join(dir, entry.name), "utf8"),
      });
    }
  }
  return out;
}

/** A BusCoreImpl cut down to the shapes the real one uses; `ingestAskAnswer` takes the injected code. */
const BASELINE_CORE = `
export class BusCoreImpl {
  private ipcServer: IpcServer | null = null;
  private recordingPending: RecordingPendingCheck | null = null;
  async start() {
    if (this.ipcServer || !this.socketPath) return;
    this.ipcServer = await bindUdsServer(this.socketPath, {});
  }
  async stop() {
    if (this.ipcServer) {
      await this.ipcServer.stop();
      this.ipcServer = null;
    }
  }
  status(id: string) {
    const n = this.ipcServer?.connectionCount() ?? 0;
    const gated = this.parked.has(id) && this.ipcServer && !this.ipcServer.hasConnection(id);
    return { n, gated, up: this.ipcServer ? true : undefined, live: this.ipcServer?.hasConnection(id) ?? false };
  }
  setRecordingPendingHandler(handler: RecordingPendingCheck | null) {
    this.recordingPending = handler;
  }
  private modelInputPending(agent_id: string) {
    return this.recordingPending?.(agent_id) ?? null;
  }
  private emitModelInput(frame: Frame) {
    const pending = this.modelInputPending(frame.agent_id);
    if (pending) return { status: "recording-pending", pending };
    const sent = this.ipcServer?.send(frame.agent_id, frame) === true;
    return { status: sent ? "sent" : "no-connection" };
  }
  private emitControl(agent_id: string, frame: Frame) {
    return this.ipcServer?.send(agent_id, frame) === true;
  }
  ingestAskAnswer(req: Req) {
    /*INJECT*/
  }
}
`;

const coreWith = (inject: string): BusSource => ({
  name: "core.ts",
  text: BASELINE_CORE.replace("/*INJECT*/", inject),
});

describe("one boundary for model input (#595 r7b), shape, read from the syntax tree", () => {
  it("the real src/bus passes: two send sites, one recordingPending reader, no other shape", () => {
    const sources = readBusSources();
    expect(sources.map((s) => s.name)).toContain("core.ts");
    const report = checkModelInputBoundary(sources);
    expect(report.violations).toEqual([]);
    expect(report.sendSites).toEqual([
      "core.ts#BusCoreImpl.emitControl",
      "core.ts#BusCoreImpl.emitModelInput",
    ]);
    expect(report.pendingReaders).toEqual(["core.ts#BusCoreImpl.modelInputPending"]);
    // A floor, so a scan that saw nothing cannot pass: core.ts names ipcServer ~17 times.
    expect(report.ipcServerReferences).toBeGreaterThanOrEqual(10);
  });

  it("the baseline fixture passes, with every allowed shape in it", () => {
    const report = checkModelInputBoundary([coreWith("return;")]);
    expect(report.violations).toEqual([]);
    expect(report.sendSites).toHaveLength(2);
    expect(report.pendingReaders).toHaveLength(1);
  });

  // Each injects one bypass into ingestAskAnswer (or another file) and must be rejected for the
  // stated reason. `regexBlind` marks the ones the round-7 regex could not see.
  const round7Regex = /ipcServer\??\.send\(/;
  const rejected: Array<{
    label: string;
    sources: BusSource[];
    reason: string;
    regexBlind?: string;
  }> = [
    {
      label: "a comment between send and (",
      sources: [coreWith("this.ipcServer?.send /* added bypass */ (req.agent_id, frame);")],
      reason: "ipcServer.send called from core.ts#BusCoreImpl.ingestAskAnswer",
      regexBlind: "this.ipcServer?.send /* added bypass */ (req.agent_id, frame);",
    },
    {
      label: "a newline between send and (",
      sources: [coreWith("this.ipcServer?.send\n(req.agent_id, frame);")],
      reason: "ipcServer.send called from core.ts#BusCoreImpl.ingestAskAnswer",
      regexBlind: "this.ipcServer?.send\n(req.agent_id, frame);",
    },
    {
      label: "an alias variable",
      sources: [coreWith("const s = this.ipcServer; s?.send(req.agent_id, frame);")],
      reason: "ipcServer escapes",
    },
    {
      label: "a destructured send",
      sources: [coreWith("const { send } = this.ipcServer!; send(req.agent_id, frame);")],
      reason: "ipcServer escapes",
    },
    {
      label: "the field destructured out of this",
      sources: [coreWith("const { ipcServer } = this; ipcServer?.send(req.agent_id, frame);")],
      reason: "ipcServer destructured out of an object",
    },
    {
      label: "an element access",
      sources: [coreWith('this["ipcServer"]?.send(req.agent_id, frame);')],
      reason: "ipcServer.send called from core.ts#BusCoreImpl.ingestAskAnswer",
    },
    {
      label: "a cast around the receiver",
      sources: [coreWith("(this.ipcServer as any).send(req.agent_id, frame);")],
      reason: "ipcServer.send called from core.ts#BusCoreImpl.ingestAskAnswer",
    },
    {
      label: "send.call",
      sources: [coreWith("this.ipcServer?.send.call(this, req.agent_id, frame);")],
      reason: "ipcServer.send used other than as a call",
    },
    {
      label: "the server passed to another function",
      sources: [coreWith("leak(this.ipcServer);")],
      reason: "ipcServer escapes",
    },
    {
      label: "the string name used for reflection",
      sources: [coreWith('Reflect.get(this, "ipcServer");')],
      reason: 'the string "ipcServer" outside',
    },
    {
      label: "a third send, in emitControl",
      sources: [
        {
          name: "core.ts",
          text: BASELINE_CORE.replace(
            "return this.ipcServer?.send(agent_id, frame) === true;",
            "this.ipcServer?.send(agent_id, frame); return this.ipcServer?.send(agent_id, frame) === true;",
          ),
        },
      ],
      reason: "expected exactly",
    },
    {
      label: "an extra sender in another bus file",
      sources: [
        coreWith("return;"),
        {
          name: "other.ts",
          text: "export class Other { private ipcServer: any; go(a: string, b: unknown) { this.ipcServer?.send(a, b); } }",
        },
      ],
      reason: "ipcServer.send called from other.ts#Other.go",
    },
    {
      label: "a second server built in another bus file",
      sources: [
        coreWith("return;"),
        {
          name: "other.ts",
          text: "export async function go(p: string) { const s = await bindUdsServer(p, {}); s.send('a', {}); }",
        },
      ],
      reason: "bindUdsServer outside core.ts / core-ipc.ts",
    },
    {
      label: "a second recordingPending reader",
      sources: [coreWith("this.recordingPending?.(req.agent_id);")],
      reason: "only modelInputPending may read it",
    },
    {
      label: "recordingPending aliased",
      sources: [coreWith("const r = this.recordingPending; r?.(req.agent_id);")],
      reason: "recordingPending escapes",
    },
    {
      label: "recordingPending destructured",
      sources: [coreWith("const { recordingPending } = this;")],
      reason: "recordingPending destructured out of an object",
    },
    {
      label: "emitModelInput that no longer consults modelInputPending",
      sources: [
        {
          name: "core.ts",
          text: BASELINE_CORE.replace("this.modelInputPending(frame.agent_id)", "null"),
        },
      ],
      reason: "emitModelInput does not call this.modelInputPending()",
    },
  ];

  for (const c of rejected) {
    it(`rejects ${c.label}`, () => {
      if (c.regexBlind !== undefined) expect(round7Regex.test(c.regexBlind)).toBe(false);
      const { violations } = checkModelInputBoundary(c.sources);
      expect(violations.some((v) => v.includes(c.reason))).toBe(true);
    });
  }
});
