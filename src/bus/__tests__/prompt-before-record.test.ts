/**
 * #595 round 5: no prompt reaches a claude before its ownership record exists.
 *
 * Round 4 hid an unrecorded process from `getAgent()`. The bus read that as "the PTY is
 * unreachable" and sent the prompt over IPC instead, which the MCP server turns into a channel
 * notification that starts a turn: the child could be mid-turn when a failed write retired it.
 * "Recording pending" is now a state of its own: BOTH transports wait for the record (at most
 * `deliveryBackstopMs`); a failed record fails the prompt with a reason code and delivers nothing.
 *
 * Part 1 drives the bus with a scripted pending promise. Part 2 drives a real `SessionManager`
 * whose ownership write is a manual promise, with a real IPC client standing in for the MCP server.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEntryInput, EventRecord } from "../../event-log";
import { __resetQuarantineForTests } from "../../runner/pty-quarantine";
import { AgentNotRecordedError, type BusCore, createBusCore, encodeFrame } from "../core";
import { FrameDecoder } from "../core-ipc";
import { canStreamToAgent } from "../receipt-wiring";
import { resolveAgentCwd, SessionManager, SpawnUnrecordedError } from "../session-manager";
import type { AgentConfig, IpcMessage } from "../types";
import { MemoryStore, OsProbe } from "./ownership-fakes";

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
    if (Date.now() - start > 60_000) throw new Error(`hello for ${agent_id} never registered`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    prompts: () => inbound.filter((m) => m.type === "prompt"),
    frames: () => inbound,
    close: () => socket.end(),
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

const prompt = (text: string) => ({
  agent_id: "alpha",
  origin: "webui" as const,
  origin_id: "inject",
  user_id: "u",
  text,
});

/** A promise the test settles by hand. */
function manual<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let tempDir: string;
let bus: BusCore | null = null;
let client: { prompts(): IpcMessage[]; frames(): IpcMessage[]; close(): void } | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bus-595r5-"));
  __resetQuarantineForTests();
});

afterEach(async () => {
  client?.close();
  client = null;
  await bus?.stop();
  bus = null;
  __resetQuarantineForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

async function startBus(
  over: { deliveryBackstopMs?: number; onError?: (err: unknown, ctx?: unknown) => void } = {},
) {
  const sockPath = join(tempDir, "bus.sock");
  bus = createBusCore({
    eventLogAppend: mockEventLog(),
    turnEndSettleMs: 0,
    socketPath: sockPath,
    // The 4 s default races a loaded machine; the one test of the backstop passes its own.
    deliveryBackstopMs: 120_000,
    onError: () => {},
    ...over,
  });
  await bus.start();
  return { bus, sockPath };
}

describe("recording pending holds prompts on both transports (#595 r5), at the bus", () => {
  it("a PTY-reachable agent: nothing is typed or sent until the record exists, then the PTY gets it", async () => {
    // Fault (site: `sendPrompt`'s pending check, ignored, i.e. pending treated as unavailable as in
    // round 4): the prompt is typed at once. Predicted result: `typed` has the prompt before release.
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(() => true);
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    client = await connectAgent(b, sockPath, "alpha");

    let settled = false;
    const sent = b.sendPrompt(prompt("hello")).then((ack) => {
      settled = true;
      return ack;
    });
    await sleep(150);
    expect(typed).toEqual([]);
    expect(client.prompts()).toEqual([]);
    expect(settled).toBe(false);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    const ack = await sent;
    expect(ack.promise_id).toBeTruthy();
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("hello");
    // Delivered once: a PTY-reachable agent gets no IPC frame (#428).
    await sleep(50);
    expect(client.prompts()).toEqual([]);
  });

  it("an IPC-only agent: no frame and no typing until the record exists, then the frame", async () => {
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(() => false);
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    client = await connectAgent(b, sockPath, "alpha");

    const sent = b.sendPrompt(prompt("hello"));
    await sleep(150);
    expect(client.prompts()).toEqual([]);
    expect(typed).toEqual([]);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await sent;
    await until(() => client?.prompts().length === 1);
    expect(client.prompts()).toHaveLength(1);
  });

  it("a record that failed: the prompt rejects with its reason and reaches neither transport", async () => {
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    client = await connectAgent(b, sockPath, "alpha");

    const sent = b.sendPrompt(prompt("hello")).then(
      () => null,
      (e: unknown) => e,
    );
    pending.reject(new Error("ENOSPC"));
    const err = await sent;

    expect(err).toBeInstanceOf(AgentNotRecordedError);
    expect((err as AgentNotRecordedError).reason).toBe("recording-failed");
    expect((err as AgentNotRecordedError).agent_id).toBe("alpha");
    await sleep(150);
    expect(typed).toEqual([]);
    expect(client.prompts()).toEqual([]);
  });

  it("a record that never settles: the wait is bounded by the delivery backstop, then the prompt fails", async () => {
    const { bus: b, sockPath } = await startBus({ deliveryBackstopMs: 120 });
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setRecordingPendingHandler?.(() => new Promise<void>(() => {}));
    client = await connectAgent(b, sockPath, "alpha");

    const err = await b.sendPrompt(prompt("hello")).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AgentNotRecordedError);
    expect((err as AgentNotRecordedError).reason).toBe("recording-timeout");
    expect(typed).toEqual([]);
    expect(client.prompts()).toEqual([]);
    // A backstop that is not applied never settles the prompt, and the test times out.
  }, 30_000);

  it("prompts held for one agent are delivered in the order they arrived", async () => {
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(() => true);
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    client = await connectAgent(b, sockPath, "alpha");

    const first = b.sendPrompt({ ...prompt("first"), origin_id: "c1" });
    const second = b.sendPrompt({ ...prompt("second"), origin_id: "c2" });
    await sleep(50);
    expect(typed).toEqual([]);
    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await Promise.all([first, second]);
    await until(() => typed.length >= 1);
    expect(typed[0]).toContain("first");
  });

  it("an agent with nothing pending is untouched: the handler returning null changes nothing", async () => {
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(() => true);
    b.setRecordingPendingHandler?.(() => null);
    client = await connectAgent(b, sockPath, "alpha");

    await b.sendPrompt(prompt("hello"));
    expect(typed).toHaveLength(1);
  });
});

describe("recording pending, end to end with a real SessionManager (#595 r5)", () => {
  const sid = randomUUID();
  let mgr: SessionManager | undefined;

  function standIn(): string {
    const script = join(tempDir, "claude.sh");
    writeFileSync(script, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(script, 0o755);
    return script;
  }

  const agentConfig = (cwd: string): AgentConfig => ({
    id: "a",
    cwd,
    session_id: sid,
    permission_mode: "bypassPermissions",
    supervision: "process",
  });

  async function wire(store: MemoryStore) {
    const { bus: b, sockPath } = await startBus();
    const cwd = resolveAgentCwd(join(tempDir, "cwd"));
    mkdirSync(cwd, { recursive: true });
    mgr = new SessionManager({
      commandOverride: standIn(),
      busSocketPath: join(tempDir, "sm.sock"),
      projectsDir: join(tempDir, "projects"),
      sessionCollisionDetectMs: 100,
      postMortemDir: join(tempDir, "post-mortem"),
      ownershipStore: store,
      bootId: "boot-now",
      // The real probe with no per-read timeout, and a record bound far above a loaded `ps`.
      processProbe: new OsProbe(),
      ownershipRecordMs: 120_000,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    const m = mgr;
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(canStreamToAgent((id) => m.getAgent(id)));
    b.setRecordingPendingHandler?.((id) => m.recordingPending(id));
    client = await connectAgent(b, sockPath, "a");
    return { b, typed, cwd };
  }

  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    mgr = undefined;
  });

  it("a prompt arriving while the ownership write is pending is not delivered until the write resolves", async () => {
    // Fault (site: `sendPrompt`'s pending check, ignored: pending read as 'unavailable' again): the
    // agent is hidden, the PTY is 'unreachable', and the IPC frame goes out at once.
    // Predicted result: `client.prompts()` has the frame before the write is released.
    const store = new MemoryStore();
    const gate = manual();
    let writeStarted = false;
    const write = store.write.bind(store);
    store.write = async (r) => {
      writeStarted = true;
      await gate.promise;
      await write(r);
    };
    const { b, typed, cwd } = await wire(store);

    const spawning = mgr?.spawnAgent(agentConfig(cwd), "cli") as Promise<unknown>;
    await until(() => writeStarted);
    expect(writeStarted).toBe(true);
    expect(mgr?.recordingPending("a")).not.toBeNull();
    expect(mgr?.getAgent("a")).toBeUndefined();

    const sent = b.sendPrompt({ ...prompt("hello"), agent_id: "a" });
    await sleep(250);
    expect(client?.prompts()).toEqual([]);
    expect(typed).toEqual([]);

    gate.resolve();
    await spawning;
    await sent;
    expect(store.rec.has("a")).toBe(true);
    expect(mgr?.recordingPending("a")).toBeNull();
    await until(() => client?.prompts().length === 1);
    // The process-supervised agent's only transport is the IPC frame, and it arrives after the record.
    expect(client?.prompts()).toHaveLength(1);
  }, 30_000);

  it("a write that fails: the spawn fails, the waiting prompt fails with its reason, and nothing was delivered", async () => {
    const store = new MemoryStore();
    const gate = manual();
    let writeStarted = false;
    store.write = async () => {
      writeStarted = true;
      await gate.promise;
    };
    const { b, typed, cwd } = await wire(store);

    const spawning = (mgr?.spawnAgent(agentConfig(cwd), "cli") as Promise<unknown>).then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => writeStarted);
    const sent = b.sendPrompt({ ...prompt("hello"), agent_id: "a" }).then(
      () => null,
      (e: unknown) => e,
    );
    await sleep(100);
    gate.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    const sendErr = await sent;
    const spawnErr = await spawning;
    expect(spawnErr).toBeInstanceOf(SpawnUnrecordedError);
    expect(sendErr).toBeInstanceOf(AgentNotRecordedError);
    expect((sendErr as AgentNotRecordedError).reason).toBe("recording-failed");
    await sleep(150);
    expect(client?.prompts()).toEqual([]);
    expect(typed).toEqual([]);
  }, 30_000);
});

/**
 * #595 round 6: the two delivery paths round 5 missed. A queued prompt is admitted by `admitNext`,
 * and the reply nudge sends its own IPC frame; neither goes through `sendPrompt`'s pending check.
 * Real BusCore on a real Unix socket with a real hello, as in Codex's r5 probe.
 *
 * Absence is proven with a barrier, not a sleep: the bus writes one socket in order, so once a
 * later `ask_answer` frame has arrived every earlier frame has too.
 */
let barrierSeq = 0;
async function barrier(b: BusCore, agent_id: string): Promise<void> {
  const ask_id = `barrier-${++barrierSeq}`;
  b.ingestAskAnswer({ agent_id, ask_id, answer: "x" });
  await until(() =>
    (client?.frames() ?? []).some(
      (m) => m.type === "ask_answer" && (m as { ask_id?: string }).ask_id === ask_id,
    ),
  );
}

function endTurn(b: BusCore, agent_id: string, text = ""): void {
  b.ingestSessionEvent({
    ts: Date.now(),
    agent_id,
    session_id: "old",
    topic: "response.turn_end",
    payload: { text, message_id: randomUUID() },
  });
}

/** The agent has a first prompt in flight and a second queued behind it. */
async function queuedBehindATurn(b: BusCore, sockPath: string) {
  const typed: string[] = [];
  b.setStreamPromptHandler(async (_a, text) => {
    typed.push(text);
  });
  b.setPtyReachableHandler?.(() => false);
  client = await connectAgent(b, sockPath, "alpha");
  await b.sendPrompt(prompt("first"));
  await until(() => client?.prompts().length === 1);
  const ack = await b.sendPrompt(prompt("queued-before-restart"));
  expect(ack.queued).toBe(true);
  return { typed, queuedId: ack.promise_id };
}

describe("a queued prompt waits for the record too (#595 r6), at the bus", () => {
  it("held while the record is pending: no frame and no typing, the prompt keeps its id and its place", async () => {
    // Fault (site: `admitNext`'s pending check, removed): the turn's release admits the queued prompt
    // straight to IPC. Predicted result: the frame is in `prompts()` before the record exists.
    const { bus: b, sockPath } = await startBus();
    const { typed, queuedId } = await queuedBehindATurn(b, sockPath);
    const events: Array<{ promise_id?: string; text: string }> = [];
    b.subscribe({ agent_id: "alpha", topics: ["prompt"] }, (e) =>
      events.push({
        promise_id: e.promise_id,
        text: (e.payload as { text: string }).text,
      }),
    );
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);

    endTurn(b, "alpha");
    await barrier(b, "alpha");

    expect(client?.prompts()).toHaveLength(1);
    expect(typed.some((t) => t.includes("queued-before-restart"))).toBe(false);
    expect(events).toEqual([]);
    expect(b.queuedPrompts("alpha").map((q) => q.promise_id)).toEqual([queuedId]);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await until(() => client?.prompts().length === 2);
    await barrier(b, "alpha");
    // Delivered once, with the id it was acknowledged under.
    expect(client?.prompts()).toHaveLength(2);
    expect((client?.prompts()[1] as { text: string }).text).toBe("queued-before-restart");
    expect(events).toEqual([{ promise_id: queuedId, text: "queued-before-restart" }]);
    expect(b.queuedPrompts("alpha")).toEqual([]);
  }, 30_000);

  it("a newcomer during the hold queues behind the held prompt, never ahead of it", async () => {
    const { bus: b, sockPath } = await startBus();
    await queuedBehindATurn(b, sockPath);
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);
    endTurn(b, "alpha");
    const newcomer = b.sendPrompt({ ...prompt("newcomer"), origin_id: "other" });

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await newcomer;
    await until(() => client?.prompts().length === 2);
    await barrier(b, "alpha");
    // The held prompt took the slot; the newcomer waits for its turn to end.
    expect(client?.prompts().map((m) => (m as { text: string }).text)).toEqual([
      "first",
      "queued-before-restart",
    ]);
    endTurn(b, "alpha");
    await until(() => client?.prompts().length === 3);
    expect((client?.prompts()[2] as { text: string }).text).toBe("newcomer");
  }, 30_000);

  it("a record that failed: the queued prompt fails with its reason and id, and no frame is ever sent", async () => {
    const errors: Array<{ err: unknown; ctx: unknown }> = [];
    const { bus: b, sockPath } = await startBus({
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    const { typed, queuedId } = await queuedBehindATurn(b, sockPath);
    const pending = manual();
    pending.promise.catch(() => {});
    b.setRecordingPendingHandler?.(() => pending.promise);

    endTurn(b, "alpha");
    pending.reject(new Error("ENOSPC"));
    await until(() => errors.length > 0);
    await barrier(b, "alpha");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.err).toBeInstanceOf(AgentNotRecordedError);
    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-failed");
    expect((errors[0]?.ctx as { promise_id?: string }).promise_id).toBe(queuedId);
    expect(client?.prompts()).toHaveLength(1);
    expect(typed.some((t) => t.includes("queued-before-restart"))).toBe(false);
    expect(b.queuedPrompts("alpha")).toEqual([]);
  }, 30_000);

  it("a record that never settles: the queue fails at the backstop with recording-timeout", async () => {
    const errors: Array<{ err: unknown; ctx: unknown }> = [];
    const { bus: b, sockPath } = await startBus({
      deliveryBackstopMs: 100,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    const { typed, queuedId } = await queuedBehindATurn(b, sockPath);
    b.setRecordingPendingHandler?.(() => new Promise<void>(() => {}));

    endTurn(b, "alpha");
    await until(() => errors.length > 0);
    await barrier(b, "alpha");

    expect((errors[0]?.err as AgentNotRecordedError).reason).toBe("recording-timeout");
    expect((errors[0]?.ctx as { promise_id?: string }).promise_id).toBe(queuedId);
    expect(client?.prompts()).toHaveLength(1);
    expect(typed.some((t) => t.includes("queued-before-restart"))).toBe(false);
  }, 30_000);

  it("a PTY-reachable agent: the drained prompt is not typed before the record either", async () => {
    const { bus: b, sockPath } = await startBus();
    const typed: string[] = [];
    b.setStreamPromptHandler(async (_a, text) => {
      typed.push(text);
    });
    b.setPtyReachableHandler?.(() => true);
    client = await connectAgent(b, sockPath, "alpha");
    await b.sendPrompt(prompt("first"));
    await b.sendPrompt(prompt("queued-before-restart"));
    const typedBefore = typed.length;
    const pending = manual();
    b.setRecordingPendingHandler?.(() => pending.promise);

    endTurn(b, "alpha");
    await barrier(b, "alpha");
    expect(typed).toHaveLength(typedBefore);
    expect(client?.prompts()).toEqual([]);

    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await until(() => typed.length === typedBefore + 1);
    expect(typed[typedBefore]).toContain("queued-before-restart");
  }, 30_000);
});

describe("the reply nudge waits for nothing and sends nothing while pending (#595 r6), at the bus", () => {
  const channelPrompt = {
    agent_id: "alpha",
    origin: "telegram" as const,
    origin_id: "chat",
    user_id: "u",
    text: "first",
  };

  /** Run one turn end carrying text with no reply tool call, while `pending` holds the record. */
  async function turnEndsWithoutReply(pending: Promise<void>) {
    const { bus: b, sockPath } = await startBus();
    client = await connectAgent(b, sockPath, "alpha");
    await b.sendPrompt(channelPrompt);
    await until(() => client?.prompts().length === 1);
    const texts: string[] = [];
    b.subscribe({ agent_id: "alpha", topics: ["response.text"] }, (e) =>
      texts.push((e.payload as { text: string }).text),
    );
    const lines: string[] = [];
    const warn = console.warn;
    const error = console.error;
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => JSON.stringify(x)).join(" "));
    console.warn = capture;
    console.error = capture;
    try {
      b.setRecordingPendingHandler?.(() => pending);
      endTurn(b, "alpha", "old answer");
      await barrier(b, "alpha");
    } finally {
      console.warn = warn;
      console.error = error;
    }
    return { b, texts, lines };
  }

  it("pending: no nudge frame, the turn's text is delivered by synthesis, one reason-coded line", async () => {
    // Fault (site: `nudgeForReply`'s pending check, removed): the reminder goes out as an IPC frame.
    // Predicted result: a prompt frame with metadata.nudge = "reply-tool" while the record is pending.
    const pending = manual();
    const { b, texts, lines } = await turnEndsWithoutReply(pending.promise);

    expect(client?.prompts()).toHaveLength(1);
    expect(texts).toEqual(["old answer"]);
    const undeliverable = lines.filter((l) => l.includes("reply nudge undeliverable"));
    expect(undeliverable).toHaveLength(1);
    expect(undeliverable[0]).toContain("recording-pending");
    expect(undeliverable[0]).not.toContain("old answer");

    // Recorded afterwards: the dropped nudge is not sent late.
    b.setRecordingPendingHandler?.(null);
    pending.resolve();
    await barrier(b, "alpha");
    expect(client?.prompts()).toHaveLength(1);
  }, 30_000);

  it("a record that failed: still no nudge frame, ever", async () => {
    const pending = manual();
    pending.promise.catch(() => {});
    const { b, texts } = await turnEndsWithoutReply(pending.promise);
    b.setRecordingPendingHandler?.(null);
    pending.reject(new Error("ENOSPC"));
    await barrier(b, "alpha");

    expect(client?.prompts()).toHaveLength(1);
    expect(texts).toEqual(["old answer"]);
  }, 30_000);

  it("nothing pending: the nudge is sent as before", async () => {
    const { bus: b, sockPath } = await startBus();
    client = await connectAgent(b, sockPath, "alpha");
    await b.sendPrompt(channelPrompt);
    await until(() => client?.prompts().length === 1);
    b.setRecordingPendingHandler?.(() => null);

    endTurn(b, "alpha", "old answer");
    await until(() => client?.prompts().length === 2);
    expect((client?.prompts()[1] as { metadata?: { nudge?: string } }).metadata?.nudge).toBe(
      "reply-tool",
    );
  }, 30_000);
});
