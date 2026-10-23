/**
 * #595 round 7: every IPC frame the MCP server turns into model input leaves Bus core through ONE
 * gate (`emitModelInput`). Rounds 5 and 6 each closed a caller that sent a prompt before the claude
 * was recorded as ours; round 6 left `ask_answer` (a channel notification, so a turn) open.
 *
 * Part 1 drives a real BusCore and a raw Unix-socket client (`ask_answer` held, failed, timed out).
 * Part 2 puts a real `BusMcpServer` and an MCP SDK client behind the same socket, as in Codex's r6
 * probe, and covers pending, success, failure, timeout and a stale ask id end to end.
 * Part 3 pins the shape: `IpcServer.send` has two callers, `recordingPending` one reader.
 *
 * Absence is proven with a barrier, not a sleep: the bus writes one socket in order, so once a later
 * CONTROL frame (`permission_response`: it answers a request the claude made and starts no turn, and
 * is never held) has arrived, every earlier frame has too.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("one boundary for model input (#595 r7), shape", () => {
  const src = readFileSync(join(import.meta.dir, "../core.ts"), "utf8");
  const start = (name: string): number => {
    const at = src.indexOf(`private ${name}(`);
    expect(at).toBeGreaterThan(-1);
    return at;
  };
  const body = (name: string): string => {
    const at = start(name);
    return src.slice(at, src.indexOf("\n  }\n", at));
  };

  it("IpcServer.send is called from emitModelInput and emitControl and nowhere else", () => {
    const callSites = [...src.matchAll(/ipcServer\??\.send\(/g)].map((m) => m.index ?? -1);
    expect(callSites).toHaveLength(2);
    const inside = (name: string) =>
      callSites.filter((i) => i > start(name) && i < start(name) + body(name).length);
    expect(inside("emitModelInput")).toHaveLength(1);
    expect(inside("emitControl")).toHaveLength(1);
  });

  it("recordingPending has one reader, modelInputPending, and emitModelInput consults it", () => {
    const reads = [...src.matchAll(/this\.recordingPending\?\.\(/g)];
    expect(reads).toHaveLength(1);
    expect(body("modelInputPending")).toContain("this.recordingPending?.(");
    expect(body("emitModelInput")).toContain("this.modelInputPending(");
  });
});
