/**
 * #428: a prompt reaches the agent once.
 *
 * `sendPrompt` used to send the IPC `prompt` frame (which the MCP server turns
 * into a `notifications/claude/channel` push) AND type the same prompt into
 * the PTY. On current CLIs the channel push opens a turn by itself, so every
 * `/api/inject` reached the model twice; on a long prompt the typed copy was
 * pasted into that turn, the PTY confirm loop could not see its own line in
 * the transcript, and the turn-start verify re-delivered it — a second turn.
 *
 * An agent the PTY leg reaches now gets no `prompt` frame. One that it does
 * not reach (no stream handler, or a `process` / `tmux` agent whose PTY write
 * only rejects) keeps the frame, its only delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBusCore, encodeFrame, type BusCore } from "../core";
import { FrameDecoder } from "../core-ipc";
import { canStreamToAgent } from "../receipt-wiring";
import { mountBusRuntime } from "../runtime-mount";
import { SessionManager } from "../session-manager";
import type { AgentProcess } from "../session-agent-process";
import type { IpcMessage, PromptDeliveryOutcome } from "../types";
import type { EventEntryInput, EventRecord } from "../../event-log";

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

async function connectAgent(bus: BusCore, socketPath: string, agent_id: string) {
  const inbound: IpcMessage[] = [];
  const decoder = new FrameDecoder(
    (m) => inbound.push(m),
    () => {},
  );
  let opened!: () => void;
  const open = new Promise<void>((r) => {
    opened = r;
  });
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open() {
        opened();
      },
      data(_s, data) {
        decoder.push(data);
      },
      error() {},
      close() {},
    },
  });
  await open;
  socket.write(
    encodeFrame({
      type: "hello",
      agent_id,
      capabilities: ["claude/channel", "claude/channel/permission"],
    }),
  );
  const start = Date.now();
  while (!bus.state().connectedAgents.includes(agent_id)) {
    if (Date.now() - start > 2000) throw new Error(`hello for ${agent_id} never registered`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    prompts: () => inbound.filter((m) => m.type === "prompt"),
    close: () => socket.end(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tempDir: string;
let bus: BusCore | null = null;
let agent: { close(): void } | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bus-428-"));
});

afterEach(async () => {
  agent?.close();
  agent = null;
  await bus?.stop();
  bus = null;
  rmSync(tempDir, { recursive: true, force: true });
});

const prompt = (text: string) => ({
  agent_id: "alpha",
  origin: "webui" as const,
  origin_id: "inject",
  user_id: "u",
  text,
});

describe("single delivery (#428)", () => {
  it("a PTY-reachable agent gets the prompt over the PTY only — no IPC prompt frame", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
    });
    await bus.start();
    const typed: string[] = [];
    bus.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    const client = await connectAgent(bus, sockPath, "alpha");
    agent = client;

    const ack = await bus.sendPrompt(prompt("INJ-01"));
    await sleep(50);

    expect(typed).toHaveLength(1);
    expect(client.prompts()).toHaveLength(0);
    // The MCP connection is still checked: present → ipc_sent true (#390).
    expect(ack.ipc_sent).toBe(true);
  });

  it("an agent the PTY does not reach keeps the IPC prompt frame", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
    });
    await bus.start();
    bus.setStreamPromptHandler(async () => {});
    // A tmux agent: `send_prompt_stream` exists but only rejects.
    bus.setPtyReachableHandler?.(
      canStreamToAgent(() => ({
        pid: 1,
        supervision: "tmux",
        send_prompt_stream: async () => {
          throw new Error("not streamable");
        },
      })),
    );
    const client = await connectAgent(bus, sockPath, "alpha");
    agent = client;

    await bus.sendPrompt(prompt("INJ-02"));
    await sleep(50);

    expect(client.prompts()).toHaveLength(1);
    expect((client.prompts()[0] as { text: string }).text).toBe("INJ-02");
  });

  it("canStreamToAgent: reachable only when registered, streamable and in a mode that serves the write", () => {
    const proc = (supervision?: "pty-stdin" | "process-stream-json" | "tmux" | "process") => ({
      pid: 1,
      ...(supervision ? { supervision } : {}),
      send_prompt_stream: async () => {},
    });
    const reach = (p: ReturnType<typeof proc> | { pid: number } | undefined) =>
      canStreamToAgent(() => p)("alpha");
    expect(reach(proc("pty-stdin"))).toBe(true);
    expect(reach(proc("process-stream-json"))).toBe(true);
    expect(reach(proc())).toBe(true);
    expect(reach(proc("tmux"))).toBe(false);
    expect(reach(proc("process"))).toBe(false);
    expect(reach({ pid: 1 })).toBe(false);
    expect(reach(undefined)).toBe(false);
  });

  it("an agent the session manager does not know yet keeps the IPC prompt frame", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
    });
    await bus.start();
    bus.setStreamPromptHandler(async () => {});
    bus.setPtyReachableHandler?.(canStreamToAgent(() => undefined));
    const client = await connectAgent(bus, sockPath, "alpha");
    agent = client;

    await bus.sendPrompt(prompt("INJ-06"));
    await sleep(50);

    expect(client.prompts()).toHaveLength(1);
  });

  it("with no PTY handler wired the IPC frame is the delivery", async () => {
    const sockPath = join(tempDir, "bus.sock");
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
    });
    await bus.start();
    const client = await connectAgent(bus, sockPath, "alpha");
    agent = client;

    await bus.sendPrompt(prompt("INJ-03"));
    await sleep(50);

    expect(client.prompts()).toHaveLength(1);
  });

  it("a PTY-reachable agent with no MCP connection still reports it (#222 liveness unchanged)", async () => {
    const sockPath = join(tempDir, "bus.sock");
    const failed: string[] = [];
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
      onError: () => {},
      onMcpSendFailed: (id, ctx) => failed.push(`${id}:${ctx.reason}`),
    });
    await bus.start();
    const typed: string[] = [];
    bus.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });

    const ack = await bus.sendPrompt(prompt("INJ-04"));

    expect(ack.ipc_sent).toBe(false);
    expect(failed).toEqual(["alpha:sendPrompt:no-mcp-connection"]);
    expect(typed).toHaveLength(1);
  });

  it("a long prompt is not re-delivered as a second turn", async () => {
    // Models what the CLI did in the #428 measurement: a channel push opens a
    // turn of its own, and the typed copy that follows is pasted into that
    // turn (absorbed) — the PTY confirm loop never sees its line and reports
    // `unconfirmed-idle`. With no channel push, the typed copy opens the turn
    // and the transcript records it.
    const sockPath = join(tempDir, "bus.sock");
    const errors: string[] = [];
    bus = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
      flushVerifyMs: 60,
      flushVerifyGraceMs: 20,
      onError: (e) => errors.push(String(e)),
    });
    await bus.start();
    const client = await connectAgent(bus, sockPath, "alpha");
    agent = client;
    const b = bus;
    const typed: string[] = [];
    let turns = 0;
    b.setStreamPromptHandler(async (_a, text): Promise<PromptDeliveryOutcome> => {
      typed.push(text);
      await sleep(10);
      if (client.prompts().length > 0 && typed.length === 1) {
        // The channel push already opened the turn; the typed copy is absorbed.
        turns++;
        return "unconfirmed-idle";
      }
      turns++;
      b.ingestSessionEvent({
        ts: Date.now(),
        agent_id: "alpha",
        session_id: "s",
        topic: "prompt",
        payload: { text },
      });
      return "turn-started";
    });

    const pad = Array.from({ length: 45 }, (_, i) => `Context line ${i}.`).join(" ");
    await b.sendPrompt(prompt(`INJ-G1 : apply this decision. ${pad}`));
    await sleep(250);

    expect(errors.filter((e) => e.includes("re-delivering once"))).toHaveLength(0);
    expect(typed).toHaveLength(1);
    expect(turns).toBe(1);
  });

  it("the daemon mount wires the per-agent check: a tmux agent keeps its frame", async () => {
    // Without `setPtyReachableHandler(canStreamToAgent(...))` in
    // `mountBusRuntime`, the default check ("a PTY handler is wired") would
    // skip the frame for every agent, including one the PTY cannot reach.
    const sockPath = join(tempDir, "bus.sock");
    const sm = new SessionManager();
    sm.getAgent = () =>
      ({
        pid: 1,
        supervision: "tmux",
        send_prompt_stream: async () => {
          throw new Error("not streamable");
        },
      }) as unknown as AgentProcess;
    // A real bus with an in-memory event log, so the mount writes nothing
    // under the working directory.
    const mounted = createBusCore({
      eventLogAppend: mockEventLog(),
      turnEndSettleMs: 0,
      socketPath: sockPath,
      onError: () => {},
    });
    const handle = await mountBusRuntime({
      bus: mounted,
      socketPath: sockPath,
      sessionManager: sm,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    try {
      const client = await connectAgent(mounted, sockPath, "alpha");
      agent = client;
      await handle.bus.sendPrompt(prompt("INJ-05"));
      await sleep(50);
      expect(client.prompts()).toHaveLength(1);
    } finally {
      agent?.close();
      agent = null;
      await handle.stop();
    }
  });
});
