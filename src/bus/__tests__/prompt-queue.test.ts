/**
 * #239 — one active turn per agent.
 *
 * Every per-turn structure in the bus is a single slot keyed by agent, and
 * two prompts interleaving on one agent clobbered each other's: the second
 * `sendPrompt` rewrote the origin mid-turn, and the first turn's reply — or
 * the reply the silent-drop net synthesised for it — reached the wrong chat.
 * The bus now serializes: a prompt arriving while the agent still owes a
 * terminator waits in a fair queue (FIFO per origin, round-robin across
 * origins, a cap per origin) and is admitted when the slot frees.
 *
 * The structure that serializes needs its own release (#372): a turn that
 * never produces its terminator would otherwise leave the agent deaf to every
 * origin. An admitted turn therefore carries an idle deadline, re-armed by
 * every sign of life, that releases the slot loudly.
 *
 * Run with: `bun test src/bus/__tests__/prompt-queue.test.ts`
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import {
  createBusCore,
  PromptQueueFullError,
  type BusCore,
  type BusCoreOptions,
  type SendPromptAck,
} from "../core";
import type { BusEvent, BusOrigin } from "../types";

const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(opts: Partial<BusCoreOptions> = {}) {
  const events: BusEvent[] = [];
  const errors: Array<{ err: unknown; ctx?: Record<string, unknown> }> = [];
  const delivered: string[] = [];
  const bus = createBusCore({
    eventLogAppend: mockAppend,
    turnEndSettleMs: 0,
    onError: (err, ctx) => errors.push({ err, ctx }),
    streamPromptHandler: async (_a, text) => {
      delivered.push(text);
    },
    ...opts,
  });
  bus.subscribe({}, (e) => events.push(e));
  return { bus, events, errors, delivered };
}

function send(
  bus: BusCore,
  agent_id: string,
  text: string,
  origin: BusOrigin = "telegram",
  origin_id = "chat-1",
): Promise<SendPromptAck> {
  return bus.sendPrompt({ agent_id, origin, origin_id, user_id: "u", text });
}

function tailer(agent_id: string, topic: BusEvent["topic"], payload: unknown = {}): BusEvent {
  return { ts: Date.now(), agent_id, session_id: "sess-1", topic, payload };
}

const turnEnd = (bus: BusCore, agent: string, text = "") =>
  bus.ingestSessionEvent(tailer(agent, "response.turn_end", { text, message_id: randomUUID() }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The <channel> payloads the PTY handler received, in order (a nudge's
 *  <system-reminder> is not a prompt and is left out). */
const texts = (delivered: string[]) =>
  delivered
    .filter((w) => w.startsWith("<channel"))
    .map((w) => w.replace(/^<channel[^>]*>/, "").replace(/<\/channel>$/, ""));

describe("one active turn per agent (#239)", () => {
  it("a prompt sent while a turn is in flight is queued, not delivered, and keeps its promise_id", async () => {
    const { bus, events, delivered } = makeBus();
    const first = await send(bus, "a", "one");
    expect(first.queued).toBeUndefined();
    const second = await send(bus, "a", "two");
    expect(second.queued).toBe(true);
    expect(second.ipc_sent).toBeUndefined();
    expect(texts(delivered)).toEqual(["one"]);
    expect(bus.queuedPrompts("a")).toEqual([
      { promise_id: second.promise_id, origin: "telegram", origin_id: "chat-1" },
    ]);
    // No prompt event until admission — subscribers see prompts in the order
    // the model does.
    expect(events.filter((e) => e.topic === "prompt")).toHaveLength(1);
    turnEnd(bus, "a");
    expect(texts(delivered)).toEqual(["one", "two"]);
    const prompts = events.filter((e) => e.topic === "prompt");
    expect(prompts.map((e) => e.promise_id)).toEqual([first.promise_id, second.promise_id]);
    expect(bus.queuedPrompts("a")).toEqual([]);
  });

  it("the running turn's origin is not rewritten by the newcomer: its reply reaches its own chat", async () => {
    const { bus, events, delivered } = makeBus();
    await send(bus, "a", "from A", "telegram", "chat-A");
    await send(bus, "a", "from B", "webui", "chat-B");
    // The agent answers the turn it is in — without naming the chat.
    bus.ingestReply({ agent_id: "a", text: "answer for A", intent: "final" });
    const replies = events.filter((e) => e.topic === "response.text");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({ origin: "telegram", origin_id: "chat-A" });
    turnEnd(bus, "a");
    expect(texts(delivered)).toEqual(["from A", "from B"]);
    bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" });
    expect(events.filter((e) => e.topic === "response.text")[1]?.payload).toMatchObject({
      origin: "webui",
      origin_id: "chat-B",
    });
  });

  it("the silent-drop net synthesises to the chat whose turn ended, never to the one waiting", async () => {
    const { bus, events, delivered } = makeBus({ replyNudge: false });
    await send(bus, "a", "from A", "telegram", "chat-A");
    await send(bus, "a", "from B", "telegram", "chat-B");
    // A's turn ends with text and no `reply` call: the net delivers it — to A.
    turnEnd(bus, "a", "ambient text meant for A");
    const replies = events.filter((e) => e.topic === "response.text");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({ origin_id: "chat-A", synthesized: true });
    // And only then does B's turn start.
    expect(texts(delivered)).toEqual(["from A", "from B"]);
  });

  it("serializes per agent: another agent is not held", async () => {
    const { bus, delivered } = makeBus();
    await send(bus, "a", "a1");
    const b = await send(bus, "b", "b1");
    expect(b.queued).toBeUndefined();
    expect(texts(delivered)).toEqual(["a1", "b1"]);
  });

  it("non-channel origins queue too — one active writer, whoever writes", async () => {
    const { bus, delivered } = makeBus();
    await send(bus, "a", "user", "telegram");
    const tick = await send(bus, "a", "tick", "cron", "job-1");
    expect(tick.queued).toBe(true);
    turnEnd(bus, "a");
    expect(texts(delivered)).toEqual(["user", "tick"]);
  });

  describe("fairness", () => {
    it("FIFO within one origin", async () => {
      const { bus, delivered } = makeBus();
      await send(bus, "a", "0");
      for (const n of ["1", "2", "3"]) await send(bus, "a", n);
      for (let i = 0; i < 3; i++) turnEnd(bus, "a");
      expect(texts(delivered)).toEqual(["0", "1", "2", "3"]);
    });

    it("round-robin across origins: a chatty chat cannot starve a quiet one", async () => {
      const { bus, delivered } = makeBus();
      await send(bus, "a", "running");
      await send(bus, "a", "A1", "telegram", "chat-A");
      await send(bus, "a", "A2", "telegram", "chat-A");
      await send(bus, "a", "A3", "telegram", "chat-A");
      await send(bus, "a", "B1", "webui", "chat-B");
      await send(bus, "a", "C1", "discord", "chat-C");
      await send(bus, "a", "B2", "webui", "chat-B");
      expect(bus.queuedPrompts("a").map((q) => q.origin_id)).toEqual([
        "chat-A",
        "chat-B",
        "chat-C",
        "chat-A",
        "chat-B",
        "chat-A",
      ]);
      for (let i = 0; i < 6; i++) turnEnd(bus, "a");
      expect(texts(delivered)).toEqual(["running", "A1", "B1", "C1", "A2", "B2", "A3"]);
    });

    it("the rotation advances by admission, so a lane that empties gives its place up", async () => {
      const { bus, delivered } = makeBus();
      await send(bus, "a", "running");
      await send(bus, "a", "A1", "telegram", "chat-A");
      await send(bus, "a", "B1", "webui", "chat-B");
      turnEnd(bus, "a"); // A1 admitted; rotation now B, A
      await send(bus, "a", "A2", "telegram", "chat-A");
      turnEnd(bus, "a"); // B1
      turnEnd(bus, "a"); // A2
      expect(texts(delivered)).toEqual(["running", "A1", "B1", "A2"]);
    });

    it("a per-origin cap refuses the newest prompt of that origin and leaves the others intact", async () => {
      const { bus, delivered } = makeBus({ promptQueueCapPerOrigin: 2 });
      await send(bus, "a", "running");
      await send(bus, "a", "A1", "telegram", "chat-A");
      await send(bus, "a", "A2", "telegram", "chat-A");
      let refused: unknown;
      await send(bus, "a", "A3", "telegram", "chat-A").catch((e) => {
        refused = e;
      });
      expect(refused).toBeInstanceOf(PromptQueueFullError);
      expect((refused as PromptQueueFullError).origin_id).toBe("chat-A");
      // Another origin has its own cap.
      const b = await send(bus, "a", "B1", "webui", "chat-B");
      expect(b.queued).toBe(true);
      for (let i = 0; i < 3; i++) turnEnd(bus, "a");
      expect(texts(delivered)).toEqual(["running", "A1", "B1", "A2"]);
    });

    it("a per-agent cap bounds the queue across origins, and a refused newcomer leaves no empty lane behind", async () => {
      const { bus, delivered } = makeBus({ promptQueueCapPerAgent: 2 });
      await send(bus, "a", "running");
      await send(bus, "a", "A1", "telegram", "chat-A");
      await send(bus, "a", "B1", "webui", "chat-B");
      let refused: unknown;
      await send(bus, "a", "C1", "discord", "chat-C").catch((e) => {
        refused = e;
      });
      expect(refused).toBeInstanceOf(PromptQueueFullError);
      expect(String(refused)).toContain("agent cap 2");
      expect(bus.queuedPrompts("a").map((q) => q.origin_id)).toEqual(["chat-A", "chat-B"]);
      for (let i = 0; i < 2; i++) turnEnd(bus, "a");
      expect(texts(delivered)).toEqual(["running", "A1", "B1"]);
      expect(bus.queuedPrompts("a")).toEqual([]);
      // The refused origin's empty lane did not survive: a free slot with an
      // "empty but present" queue would have parked every later prompt.
      turnEnd(bus, "a");
      const later = await send(bus, "a", "after", "discord", "chat-C");
      expect(later.queued).toBeUndefined();
    });
  });

  describe("release sites admit the next prompt", () => {
    function ipc(bus: BusCore, agent_id: string, msg: unknown): void {
      (bus as unknown as { handleIpcMessage(a: string, m: unknown): void }).handleIpcMessage(
        agent_id,
        msg,
      );
    }

    it("a cancelled turn", async () => {
      const { bus, delivered } = makeBus();
      await send(bus, "a", "one");
      await send(bus, "a", "two");
      ipc(bus, "a", { type: "cancel", agent_id: "a", reason: "user" });
      expect(texts(delivered)).toEqual(["one", "two"]);
    });

    it("an errored turn", async () => {
      const { bus, delivered } = makeBus();
      await send(bus, "a", "one");
      await send(bus, "a", "two");
      ipc(bus, "a", { type: "error", agent_id: "a", code: "E", message: "boom" });
      expect(texts(delivered)).toEqual(["one", "two"]);
    });

    it("a new session generation (replay_done) — after the held prompt it flushes", async () => {
      const { bus, delivered } = makeBus();
      bus.ingestSessionEvent(tailer("a", "session.init"));
      await send(bus, "a", "held by the init gate");
      await send(bus, "a", "waiting in the bus");
      expect(delivered).toHaveLength(0);
      bus.ingestSessionEvent(tailer("a", "bus.events.replay_done"));
      // The held prompt is flushed; the waiting one still owes it a turn_end.
      expect(texts(delivered)).toEqual(["held by the init gate"]);
      turnEnd(bus, "a");
      expect(texts(delivered)).toEqual(["held by the init gate", "waiting in the bus"]);
    });

    it("a stuck streaming flag cleared by a new generation", async () => {
      const { bus, delivered } = makeBus();
      bus.ingestSessionEvent(tailer("a", "prompt", { text: "<channel>foreign</channel>" }));
      await send(bus, "a", "waits behind a turn the bus did not open");
      expect(delivered).toHaveLength(0);
      bus.ingestSessionEvent(tailer("a", "bus.events.replay_done"));
      expect(delivered).toHaveLength(1);
    });
  });

  it("a reply nudge holds admission: the nudged turn answers the PREVIOUS prompt", async () => {
    const { bus, events, delivered } = makeBus({ replyNudge: true });
    await send(bus, "a", "from A", "telegram", "chat-A");
    await send(bus, "a", "from B", "telegram", "chat-B");
    // A's turn ends with text but no reply → the bus nudges the agent, and the
    // nudged turn will answer A. Admitting B now would point the origin at B.
    turnEnd(bus, "a", "text A never sent");
    expect(texts(delivered)).toEqual(["from A"]); // the nudge went out, B did not
    expect(delivered).toHaveLength(2); // the nudge itself rode the PTY
    expect(delivered[1]).toContain("system-reminder");
    bus.ingestReply({ agent_id: "a", text: "here is A", intent: "final" });
    expect(events.filter((e) => e.topic === "response.text")[0]?.payload).toMatchObject({
      origin_id: "chat-A",
    });
    turnEnd(bus, "a"); // the nudged turn ends → B admitted
    expect(texts(delivered)).toEqual(["from A", "from B"]);
  });

  describe("the turn deadline (#239 / #372)", () => {
    it("releases a turn that shows no sign of life, loudly, and admits the next prompt flagged", async () => {
      const { bus, events, errors, delivered } = makeBus({ turnDeadlineMs: 40 });
      const one = await send(bus, "a", "one");
      const two = await send(bus, "a", "two");
      await sleep(70);
      expect(texts(delivered)).toEqual(["one", "two"]);
      const release = errors.find((e) => e.ctx?.ctx === "turn-deadline");
      expect(release).toBeDefined();
      expect(release?.ctx).toMatchObject({ agent_id: "a", operation: one.promise_id, waiting: 1 });
      const p2 = events.filter((e) => e.topic === "prompt")[1];
      expect(p2?.promise_id).toBe(two.promise_id);
      expect((p2 as { correlation_ambiguous?: true }).correlation_ambiguous).toBe(true);
    });

    it("is idle-based: a turn that keeps publishing is never released", async () => {
      const { bus, errors, delivered } = makeBus({ turnDeadlineMs: 80 });
      await send(bus, "a", "long");
      await send(bus, "a", "next");
      for (let i = 0; i < 8; i++) {
        await sleep(20);
        bus.ingestSessionEvent(tailer("a", "tool_result", { i }));
      }
      // 160 ms > 80 ms, but never 80 ms of silence (20 ms beats, 60 ms of margin).
      expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toEqual([]);
      expect(texts(delivered)).toEqual(["long"]);
      for (let i = 0; i < 30 && texts(delivered).length < 2; i++) await sleep(10); // now silent → released
      expect(texts(delivered)).toEqual(["long", "next"]);
    });

    it("a delivery-layer transition is a sign of life too", async () => {
      // A prompt held through a stuck compaction publishes nothing for the
      // length of the hold; the hold itself re-arms the deadline.
      const delivered: string[] = [];
      const errors: Array<{ ctx?: Record<string, unknown> }> = [];
      const bus = createBusCore({
        eventLogAppend: mockAppend,
        turnEndSettleMs: 0,
        onError: (_e, ctx) => errors.push({ ctx }),
        turnDeadlineMs: 120,
        stuckCompactionResolveMs: 100_000,
        flushVerifyMs: 30,
        streamPromptHandler: async (_a, text) => {
          delivered.push(text);
          await sleep(60); // the PTY layer's own compaction budget, scaled down
          return "stuck-compaction";
        },
      });
      await send(bus, "a", "held"); // t=0: deadline at 120
      await sleep(150); // t≈60: the hold was taken → re-armed to ≈180; t=150 is past the first deadline
      expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toEqual([]);
      for (
        let i = 0;
        i < 40 && errors.filter((e) => e.ctx?.ctx === "turn-deadline").length === 0;
        i++
      )
        await sleep(10); // silent since the hold → released
      expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toHaveLength(1);
    });

    it("covers a reply nudge whose turn never ends: the gate is released, not just the slot", async () => {
      const { bus, errors, delivered } = makeBus({ turnDeadlineMs: 40, replyNudge: true });
      await send(bus, "a", "from A", "telegram", "chat-A");
      await send(bus, "a", "from B", "telegram", "chat-B");
      turnEnd(bus, "a", "text never sent"); // slot released, nudge out → gate still held
      expect(texts(delivered)).toEqual(["from A"]);
      await sleep(70); // the nudged turn never answers
      const release = errors.find((e) => e.ctx?.ctx === "turn-deadline");
      expect(release?.ctx?.held).toBe("reply-nudge outstanding");
      expect(texts(delivered)).toEqual(["from A", "from B"]);
    });

    it("covers a streaming flag stuck by a turn the bus did not open", async () => {
      const { bus, errors, delivered } = makeBus({ turnDeadlineMs: 40 });
      bus.ingestSessionEvent(tailer("a", "prompt", { text: "<channel>foreign</channel>" })); // no turn_end ever
      await send(bus, "a", "waits");
      expect(delivered).toHaveLength(0);
      await sleep(70);
      expect(errors.find((e) => e.ctx?.ctx === "turn-deadline")?.ctx?.held).toBe("turn streaming");
      expect(texts(delivered)).toEqual(["waits"]);
    });

    it("is cleared by the terminator: a turn that ended is not released later", async () => {
      const { bus, errors } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "one");
      turnEnd(bus, "a");
      await sleep(70);
      expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toEqual([]);
    });

    it("is cleared with the slot on an abnormal terminator", async () => {
      const { bus, errors } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "one");
      (bus as unknown as { handleIpcMessage(a: string, m: unknown): void }).handleIpcMessage("a", {
        type: "cancel",
        agent_id: "a",
        reason: "user",
      });
      await sleep(70);
      expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toEqual([]);
    });
  });

  it("a prompt neither leg could take never holds the slot (#372 source A)", async () => {
    // An IPC server with no connection for the agent, and no PTY handler: the
    // prompt reaches nothing, so no turn and no terminator are coming.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sock = join(mkdtempSync(join(tmpdir(), "bus-239-")), "bus.sock");
    const events: BusEvent[] = [];
    const bus = createBusCore({ eventLogAppend: mockAppend, onError: () => {}, socketPath: sock });
    bus.subscribe({}, (e) => events.push(e));
    await bus.start();
    try {
      const one = await send(bus, "a", "one");
      expect(one.ipc_sent).toBe(false);
      const two = await send(bus, "a", "two");
      // Not queued: "one" released its slot the moment it proved undeliverable.
      expect(two.queued).toBeUndefined();
      expect(events.filter((e) => e.topic === "prompt").map((e) => e.promise_id)).toEqual([
        one.promise_id,
        two.promise_id,
      ]);
    } finally {
      await bus.stop();
    }
  });

  it("busyAgents reports an agent whose only work is prompts waiting", async () => {
    const { bus } = makeBus();
    const b = bus as unknown as { busyAgents(): string[]; agentTurnActive: Set<string> };
    await send(bus, "a", "one");
    turnEnd(bus, "a"); // slot free, nothing waiting
    await sleep(0); // the delivery handler's own bookkeeping settles
    expect(b.busyAgents()).toEqual([]);
    b.agentTurnActive.add("a"); // a foreign turn holds the gate
    await send(bus, "a", "two"); // queued behind it
    b.agentTurnActive.delete("a"); // ...and only the queued prompt is left to count
    expect(b.busyAgents()).toEqual(["a"]);
  });

  it("stop() drops the queue and its deadlines", async () => {
    const { bus, errors, delivered } = makeBus({ turnDeadlineMs: 30 });
    await send(bus, "a", "one");
    await send(bus, "a", "two");
    expect(bus.queuedPrompts("a")).toHaveLength(1);
    await bus.stop();
    expect(bus.queuedPrompts("a")).toEqual([]);
    await sleep(60);
    expect(texts(delivered)).toEqual(["one"]);
    expect(errors.filter((e) => e.ctx?.ctx === "turn-deadline")).toEqual([]);
  });

  it("a newcomer never jumps a non-empty queue, even when the gate is momentarily free", async () => {
    // A nudge cleared by a `final` reply frees the gate without an admission
    // running (the nudged turn's own turn_end admits later). A prompt sent in
    // that window must join the back of the queue, not be admitted over it.
    const { bus, delivered } = makeBus({ replyNudge: true });
    await send(bus, "a", "from A", "telegram", "chat-A");
    await send(bus, "a", "from B", "telegram", "chat-B"); // queued
    turnEnd(bus, "a", "text never sent"); // nudge out: gate held by the nudge
    bus.ingestReply({ agent_id: "a", text: "here is A", intent: "final" }); // nudge cleared, gate free, B not admitted yet
    const c = await send(bus, "a", "from C", "telegram", "chat-C");
    expect(c.queued).toBe(true);
    expect(texts(delivered)).toEqual(["from A", "from B"]); // the queue's head went, not the newcomer
    turnEnd(bus, "a");
    expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
  });

  describe("adversarial findings on the first cut", () => {
    it("#405 two-line terminator: the net runs for the turn that ended, the next prompt is admitted after the settle", async () => {
      // The CLI writes one line per content block and repeats the terminal
      // stop_reason on each: a thinking+text final message is TWO turn_end
      // lines with one message_id, the first with empty text. Admitting on
      // the first ran the silent-drop net for the second against the
      // newcomer's origin and flags — A's text synthesised into chat-B.
      const { bus, events, delivered } = makeBus({ turnEndSettleMs: 30, replyNudge: false });
      await send(bus, "a", "from A", "telegram", "chat-A");
      await send(bus, "a", "from B", "telegram", "chat-B");
      const mid = randomUUID();
      bus.ingestSessionEvent(tailer("a", "response.turn_end", { text: "", message_id: mid })); // thinking line
      expect(texts(delivered)).toEqual(["from A"]); // not admitted yet
      bus.ingestSessionEvent(
        tailer("a", "response.turn_end", { text: "A's answer", message_id: mid }),
      ); // text line
      const replies = events.filter((e) => e.topic === "response.text");
      expect(replies).toHaveLength(1);
      expect(replies[0]?.payload).toMatchObject({ origin_id: "chat-A", synthesized: true });
      await sleep(60); // settle
      expect(texts(delivered)).toEqual(["from A", "from B"]);
      // B's turn starts clean: its own silent end synthesises to B, once.
      bus.ingestSessionEvent(
        tailer("a", "response.turn_end", { text: "B's answer", message_id: randomUUID() }),
      );
      const second = events.filter((e) => e.topic === "response.text")[1]?.payload;
      expect(second).toMatchObject({ origin_id: "chat-B" });
    });

    it("#405 with a nudge: the nudge goes to the turn that ended, the newcomer waits for the nudged turn", async () => {
      const { bus, events, delivered } = makeBus({ turnEndSettleMs: 30, replyNudge: true });
      await send(bus, "a", "from A", "telegram", "chat-A");
      await send(bus, "a", "from B", "telegram", "chat-B");
      const mid = randomUUID();
      bus.ingestSessionEvent(tailer("a", "response.turn_end", { text: "", message_id: mid }));
      bus.ingestSessionEvent(
        tailer("a", "response.turn_end", { text: "A's answer", message_id: mid }),
      );
      await sleep(60);
      expect(texts(delivered)).toEqual(["from A"]); // the nudge holds B
      bus.ingestReply({ agent_id: "a", text: "here is A", intent: "final" });
      expect(events.filter((e) => e.topic === "response.text")[0]?.payload).toMatchObject({
        origin_id: "chat-A",
      });
      turnEnd(bus, "a"); // the nudged turn ends
      await sleep(60);
      expect(texts(delivered)).toEqual(["from A", "from B"]);
    });

    it("a settle-window admission cannot be jumped by a direct prompt either", async () => {
      const { bus, delivered } = makeBus({ turnEndSettleMs: 30 });
      await send(bus, "a", "one");
      await send(bus, "a", "two");
      turnEnd(bus, "a");
      const three = await send(bus, "a", "three"); // during the settle
      expect(three.queued).toBe(true);
      await sleep(60);
      expect(texts(delivered)).toEqual(["one", "two"]);
    });

    it("an early release does not shift the queue: the released turn's late terminator frees nothing", async () => {
      // Deadline releases A while A's turn still runs; B is typed into it.
      // A's real turn_end then lands BEFORE B's own prompt line. Taken as B's
      // terminator it would admit C into B's turn, and D into C's — the whole
      // queue one turn ahead of the CLI. It is A's: nothing is freed, C waits
      // for B's line and B's end.
      const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
      await send(bus, "a", "from B", "telegram", "chat-B");
      await send(bus, "a", "from C", "telegram", "chat-C");
      await sleep(70); // A released, B admitted (typed into A's live turn)
      expect(texts(delivered)).toEqual(["from A", "from B"]);
      // A's turn finishes normally: its unnamed final still reaches chat-A —
      // the slot is not B's until B's own line proves the REPL moved on.
      bus.ingestReply({ agent_id: "a", text: "answer for A", intent: "final" });
      turnEnd(bus, "a", "answer for A"); // A's real end, late
      expect(texts(delivered)).toEqual(["from A", "from B"]); // C NOT admitted
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] })); // B's own line: the CLI took it
      bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" });
      turnEnd(bus, "a", "answer for B"); // B's end → C admitted
      expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[2] }));
      bus.ingestReply({ agent_id: "a", text: "answer for C", intent: "final" });
      const routes = events
        .filter((e) => e.topic === "response.text")
        .map((e) => e.payload as { text: string; origin_id?: string })
        .map((p) => `${p.text} -> ${p.origin_id}`);
      expect(routes).toEqual([
        "answer for A -> chat-A",
        "answer for B -> chat-B",
        "answer for C -> chat-C",
      ]);
    });

    it("an early release keeps the origin: a slow single-chat turn still gets its answer home", async () => {
      const { bus, events } = makeBus({ turnDeadlineMs: 40, replyNudge: false });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: "<channel>from A</channel>" }));
      await sleep(70); // released; nothing queued
      // (a) the late real reply
      bus.ingestReply({ agent_id: "a", text: "late answer", intent: "final" });
      expect(events.filter((e) => e.topic === "response.text")[0]?.payload).toMatchObject({
        origin_id: "chat-A",
      });
    });

    it("an early release keeps the origin: the net still routes a silent slow turn's text", async () => {
      const { bus, events } = makeBus({ turnDeadlineMs: 40, replyNudge: false });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: "<channel>from A</channel>" }));
      await sleep(70);
      turnEnd(bus, "a", "text A never sent"); // ends with text, no reply
      expect(events.filter((e) => e.topic === "response.text")[0]?.payload).toMatchObject({
        origin_id: "chat-A",
        synthesized: true,
      });
    });

    describe("second pass", () => {
      it("the newcomer's line is matched whitespace-agnostically: the CLI records a pasted TAB as spaces", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40 });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "col1\tcol2  end", "telegram", "chat-B");
        await send(bus, "a", "from C", "telegram", "chat-C");
        await sleep(70); // A released, B typed into A's live turn
        turnEnd(bus, "a"); // A's late end: stale
        // B's own line, as the CLI records it: the TAB became four spaces.
        bus.ingestSessionEvent(
          tailer("a", "prompt", { text: (delivered[1] as string).replace("\t", "    ") }),
        );
        bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" });
        expect(events.filter((e) => e.topic === "response.text").at(-1)?.payload).toMatchObject({
          origin_id: "chat-B",
        });
        turnEnd(bus, "a"); // B's end counts as B's
        expect(texts(delivered)).toEqual(["from A", "col1\tcol2  end", "from C"]);
      });

      it("a line for ANOTHER text does not stand in for the newcomer's own", async () => {
        const { bus, delivered } = makeBus({ turnDeadlineMs: 40 });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await send(bus, "a", "from C", "telegram", "chat-C");
        await sleep(70);
        bus.ingestSessionEvent(
          tailer("a", "prompt", { text: "<channel>operator typed this</channel>" }),
        );
        turnEnd(bus, "a"); // that foreign turn's end frees nothing of B's
        expect(texts(delivered)).toEqual(["from A", "from B"]);
      });

      it("absorption into the running turn stands in for the newcomer's own line", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40, flushVerifyMs: 30 });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await send(bus, "a", "from C", "telegram", "chat-C");
        await sleep(70);
        bus.ingestSessionEvent(
          tailer("a", "session.queue", {
            type: "queue-operation",
            operation: "remove",
            reason: "absorbed_mid_turn",
            content: delivered[1],
          }),
        );
        bus.ingestReply({ agent_id: "a", text: "answer for A and B", intent: "final" });
        expect(events.filter((e) => e.topic === "response.text").at(-1)?.payload).toMatchObject({
          origin_id: "chat-B",
        });
        turnEnd(bus, "a"); // the absorbing turn's end is now B's too → C admitted
        expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
        await sleep(100);
        expect(texts(delivered)).toEqual(["from A", "from B", "from C"]); // B not re-delivered
      });

      it("a newcomer the live turn swallowed is re-delivered once after that turn ends", async () => {
        const { bus, delivered } = makeBus({ turnDeadlineMs: 40, flushVerifyMs: 30 });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await sleep(70); // B typed into A's live turn
        turnEnd(bus, "a"); // A ends; B never got a line
        await sleep(100); // > verify + grace
        expect(texts(delivered)).toEqual(["from A", "from B", "from B"]);
      });

      it("a cancel from the process is an early release too: the turn's late terminator frees nothing", async () => {
        const { bus, delivered } = makeBus();
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await send(bus, "a", "from C", "telegram", "chat-C");
        (bus as unknown as { handleIpcMessage(a: string, m: unknown): void }).handleIpcMessage(
          "a",
          {
            type: "cancel",
            agent_id: "a",
            reason: "tool",
          },
        );
        expect(texts(delivered)).toEqual(["from A", "from B"]);
        turnEnd(bus, "a"); // the cancelled turn still ends on its own
        expect(texts(delivered)).toEqual(["from A", "from B"]);
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] }));
        turnEnd(bus, "a");
        expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
      });

      it("a direct prompt during the settle waits too, queue empty or not", async () => {
        const { bus, delivered } = makeBus({ turnEndSettleMs: 30 });
        await send(bus, "a", "one");
        turnEnd(bus, "a");
        const two = await send(bus, "a", "two");
        expect(two.queued).toBe(true);
        expect(texts(delivered)).toEqual(["one"]);
        await sleep(60);
        expect(texts(delivered)).toEqual(["one", "two"]);
      });

      it("a boundary line that still arrives after the settle admitted the next prompt is dropped, not routed to it", async () => {
        const { bus, events, delivered } = makeBus({ turnEndSettleMs: 20, replyNudge: false });
        await send(bus, "a", "from A", "telegram", "chat-A");
        await send(bus, "a", "from B", "telegram", "chat-B");
        const mid = randomUUID();
        bus.ingestSessionEvent(tailer("a", "response.turn_end", { text: "", message_id: mid }));
        await sleep(50); // settle passed: B admitted
        expect(texts(delivered)).toEqual(["from A", "from B"]);
        // B's turn is streaming by now; the late line must leave it alone.
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] }));
        await send(bus, "a", "from C", "telegram", "chat-C");
        const before = events.length;
        bus.ingestSessionEvent(
          tailer("a", "response.turn_end", { text: "A's text", message_id: mid }),
        );
        expect(events.filter((e) => e.topic === "response.text")).toEqual([]);
        expect(bus.isAgentTurnActive("a")).toBe(true); // B still streaming
        expect(texts(delivered)).toEqual(["from A", "from B"]); // C not admitted into B's turn
        await sleep(40); // > settle: still not
        expect(texts(delivered)).toEqual(["from A", "from B"]);
        // Published for the record, flagged, and not stamped as B's.
        const late = events.slice(before).find((e) => e.topic === "response.turn_end");
        expect(late?.correlation_ambiguous).toBe(true);
        expect(late?.promise_id).toBeUndefined();
      });

      it("a new generation un-parks the gate; a backstop or same-generation marker does not", async () => {
        const { bus, delivered } = makeBus();
        const b = bus as unknown as { gateParked: Set<string> };
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 1 }));
        await send(bus, "a", "one");
        b.gateParked.add("a"); // as an IPC close with the turn live would
        await send(bus, "a", "two");
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 1 })); // re-emitted marker
        expect(b.gateParked.has("a")).toBe(true);
        expect(texts(delivered)).toEqual(["one"]);
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 2 })); // a replacement
        expect(b.gateParked.has("a")).toBe(false);
        // The interrupted turn's count is deliberately left to the deadline
        // (#372); the gate is what the generation frees.
      });
    });

    describe("third pass", () => {
      it("the released turn's two-line end on the stale path still routes its text to its own chat", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40, replyNudge: false });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await sleep(70); // A released, B typed into A's live turn
        const mid = randomUUID();
        bus.ingestSessionEvent(tailer("a", "response.turn_end", { text: "", message_id: mid }));
        bus.ingestSessionEvent(
          tailer("a", "response.turn_end", { text: "answer for A", message_id: mid }),
        );
        expect(events.filter((e) => e.topic === "response.text").at(-1)?.payload).toMatchObject({
          text: "answer for A",
          origin_id: "chat-A",
          synthesized: true,
        });
      });

      it("a TAB prompt admitted after an early release is not re-delivered by its verify once the CLI ran it", async () => {
        const { bus, delivered } = makeBus({ turnDeadlineMs: 40, flushVerifyMs: 30 });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "col1\tcol2 from B", "telegram", "chat-B");
        await send(bus, "a", "from C", "telegram", "chat-C");
        await sleep(70);
        turnEnd(bus, "a"); // A's stale end
        bus.ingestSessionEvent(
          tailer("a", "prompt", { text: (delivered[1] as string).replace("\t", "    ") }),
        );
        turnEnd(bus, "a"); // B's end → C
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[2] }));
        turnEnd(bus, "a");
        await sleep(120); // > verify + grace
        expect(texts(delivered).filter((t) => t.includes("from B"))).toHaveLength(1);
      });

      it("a carried re-delivery parks the gate until its turn ends: the queue does not drain into its REPL", async () => {
        const { bus, delivered } = makeBus();
        const b = bus as unknown as {
          pendingRedelivery: Map<string, string[]>;
          agentTurnActive: Set<string>;
        };
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 1 }));
        await send(bus, "a", "from A", "telegram", "chat-A");
        turnEnd(bus, "a");
        // A close with the agent idle carried "from A" (a late give-up, still
        // unproven): nothing parked the gate. Meanwhile a foreign turn holds
        // it just long enough for "from F" to be queued, then vanishes
        // without a turn_end (its flag is cleared by the generation below).
        b.pendingRedelivery.set("a", [delivered[0] as string]);
        b.agentTurnActive.add("a");
        await send(bus, "a", "from F", "telegram", "chat-F");
        expect(bus.queuedPrompts("a")).toHaveLength(1);
        delivered.length = 0;
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 2 }));
        expect(texts(delivered)).toEqual(["from A"]); // re-delivered; F not admitted behind it
        // A newcomer would trigger an admission if the gate were free — it is parked.
        await send(bus, "a", "from G", "telegram", "chat-G");
        expect(texts(delivered)).toEqual(["from A"]);
        turnEnd(bus, "a"); // the re-delivered turn ends → F
        expect(texts(delivered)).toEqual(["from A", "from F"]);
      });

      it("a newcomer that will not run in the new session does not leave its chat in the slot", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40, replyNudge: false });
        const b = bus as unknown as {
          pendingOrigin: Map<string, unknown>;
          awaitOwnPromptLine: Map<string, string | null>;
        };
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 1 }));
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await sleep(70); // B admitted onto A's live turn: origin pending, own line awaited
        expect(b.pendingOrigin.has("a")).toBe(true);
        // The process dies: the close clears the routing slot (#138), B is NOT
        // carried (nothing left to re-deliver), and a replacement comes up.
        (bus as unknown as { lastPromptOrigin: Map<string, unknown> }).lastPromptOrigin.delete("a");
        bus.ingestSessionEvent(tailer("a", "bus.events.replay_done", { generation: 2 }));
        expect(b.pendingOrigin.has("a")).toBe(false);
        expect(b.awaitOwnPromptLine.has("a")).toBe(false);
        // An ambient turn in the fresh session ends with text and no reply:
        // nothing to route it to, so it is dropped — not sent to chat-B.
        turnEnd(bus, "a", "internal note");
        expect(events.filter((e) => e.topic === "response.text")).toEqual([]);
      });
    });

    it("a released turn that then ends normally leaves nothing behind: the next prompt is a clean admission", async () => {
      // CodeRabbit on the PR: the early-release flag is consumed by the next
      // admission; with nothing queued at the release it must be cleared by
      // the terminator, else a prompt hours later waits for its own line and
      // its IPC final — arriving before that line — routes by a stale slot.
      const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
      await sleep(70); // released, nothing queued
      turnEnd(bus, "a"); // A ends normally
      const b = await send(bus, "a", "from B", "telegram", "chat-B");
      // Nothing to overlap: B's prompt event is not flagged (CodeRabbit, minor).
      const bPrompt = events.find((e) => e.topic === "prompt" && e.promise_id === b.promise_id);
      expect((bPrompt as { correlation_ambiguous?: true })?.correlation_ambiguous).toBeUndefined();
      bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" }); // before B's line
      expect(events.filter((e) => e.topic === "response.text").at(-1)?.payload).toMatchObject({
        origin_id: "chat-B",
      });
      turnEnd(bus, "a"); // B's end counts as B's without a line
      await send(bus, "a", "from C", "telegram", "chat-C");
      expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
    });

    it("the released turn's late terminator does not un-park a re-delivery still outstanding", async () => {
      // CodeRabbit on the PR: B, admitted after a deadline, is carried over an
      // IPC-only close and re-delivered on the reconnect (parked, still
      // awaiting its own line). A's late end must not free the gate for C —
      // B's turn is the one the park is for.
      const { bus, delivered } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
      await send(bus, "a", "from B", "telegram", "chat-B");
      await sleep(70); // B typed into A's live turn, awaiting its own line
      const b = bus as unknown as {
        currentOperation: Map<string, string>;
        noteRedelivered(agent: string, wrapped: string): void;
      };
      b.currentOperation.delete("a"); // the close freed B's slot...
      b.noteRedelivered("a", delivered[1] as string); // ...and the reconnect re-delivered B
      await send(bus, "a", "from C", "telegram", "chat-C");
      turnEnd(bus, "a"); // A's late end: stale
      await send(bus, "a", "from D", "telegram", "chat-D"); // a newcomer would admit C if the gate were free
      expect(texts(delivered)).toEqual(["from A", "from B"]); // C still waits
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] })); // B's own line
      turnEnd(bus, "a"); // B's end
      expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
    });

    it("a re-delivery's own line recorded as a paste still un-parks the gate", async () => {
      // Same sequence as above, but B is long enough that the CLI records it
      // wrapped in `<pasted_content id="…">` (CLI 2.1.28x and later). That line is still
      // B's own: missing it leaves C parked behind a turn that already ran.
      const { bus, delivered } = makeBus({ turnDeadlineMs: 40 });
      await send(bus, "a", "from A", "telegram", "chat-A");
      bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
      await send(bus, "a", "from B", "telegram", "chat-B");
      await sleep(70);
      const b = bus as unknown as {
        currentOperation: Map<string, string>;
        noteRedelivered(agent: string, wrapped: string): void;
      };
      b.currentOperation.delete("a");
      b.noteRedelivered("a", delivered[1] as string);
      await send(bus, "a", "from C", "telegram", "chat-C");
      turnEnd(bus, "a"); // A's late end: stale
      expect(texts(delivered)).toEqual(["from A", "from B"]);
      const pasted = `<pasted_content id="c678">\n${delivered[1]}\n</pasted_content id="c678">`;
      bus.ingestSessionEvent(tailer("a", "prompt", { text: pasted })); // B's own line
      turnEnd(bus, "a"); // B's end
      expect(texts(delivered)).toEqual(["from A", "from B", "from C"]);
    });

    describe("the early-release window belongs to the released turn (CodeRabbit)", () => {
      it("an unanswered released turn ending with text is synthesised to its chat — no nudge into the newcomer's REPL, newcomer's flags untouched", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40, replyNudge: true });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await sleep(70); // B typed into A's live turn
        turnEnd(bus, "a", "A's unsent text"); // A ends, never called reply
        const replies = () =>
          events
            .filter((e) => e.topic === "response.text")
            .map((e) => e.payload as { text: string; origin_id?: string });
        expect(replies()).toEqual([
          expect.objectContaining({ text: "A's unsent text", origin_id: "chat-A" }),
        ]);
        expect(delivered.filter((w) => w.includes("system-reminder"))).toEqual([]); // no nudge
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] })); // B's own line
        turnEnd(bus, "a", "B's unsent text"); // B ends silently too: ITS net runs — flags were clean
        expect(delivered.filter((w) => w.includes("system-reminder"))).toHaveLength(1); // B's own nudge
        bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" });
        expect(replies().at(-1)).toEqual(
          expect.objectContaining({ text: "answer for B", origin_id: "chat-B" }),
        );
      });

      it("a final in the window is the released turn's: routed to its chat, deduplicated on its state, and the newcomer's own final still goes out", async () => {
        const { bus, events, delivered } = makeBus({ turnDeadlineMs: 40, replyNudge: false });
        await send(bus, "a", "from A", "telegram", "chat-A");
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
        await send(bus, "a", "from B", "telegram", "chat-B");
        await sleep(70);
        bus.ingestReply({ agent_id: "a", text: "answer for A", intent: "final" });
        bus.ingestReply({ agent_id: "a", text: "answer for A again", intent: "final" }); // race loser
        turnEnd(bus, "a", "answer for A"); // A's stale end: already answered → nothing synthesised
        bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[1] }));
        bus.ingestReply({ agent_id: "a", text: "answer for B", intent: "final" });
        const routes = events
          .filter((e) => e.topic === "response.text")
          .map((e) => e.payload as { text: string; origin_id?: string })
          .map((p) => `${p.text} -> ${p.origin_id}`);
        expect(routes).toEqual(["answer for A -> chat-A", "answer for B -> chat-B"]);
      });
    });

    describe("an IPC socket close", () => {
      async function ipcBus() {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { encodeFrame } = await import("../core");
        const sock = join(mkdtempSync(join(tmpdir(), "bus-239-")), "bus.sock");
        const delivered: string[] = [];
        const errors: Array<{ ctx?: Record<string, unknown> }> = [];
        const bus = createBusCore({
          eventLogAppend: mockAppend,
          turnEndSettleMs: 0,
          turnDeadlineMs: 80,
          onError: (_e, ctx) => errors.push({ ctx }),
          socketPath: sock,
          streamPromptHandler: async (_a, text) => {
            delivered.push(text);
          },
        });
        await bus.start();
        let opened!: () => void;
        const isOpen = new Promise<void>((r) => {
          opened = r;
        });
        const socket = await Bun.connect({
          unix: sock,
          socket: {
            open() {
              opened();
            },
            data() {},
            error() {},
            close() {},
          },
        });
        await isOpen;
        socket.write(
          encodeFrame({
            type: "hello",
            agent_id: "a",
            capabilities: ["claude/channel", "claude/channel/permission"],
          } as never),
        );
        for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") !== true; i++) await sleep(10);
        expect(bus.hasIpcConnection?.("a")).toBe(true);
        const client = { destroy: () => socket.end() };
        return { bus, client, delivered, errors };
      }

      it("with a turn live parks the queue: nothing is typed into the (probably still running) turn", async () => {
        const { bus, client, delivered } = await ipcBus();
        try {
          await send(bus, "a", "from A", "telegram", "chat-A");
          bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
          await send(bus, "a", "from B", "telegram", "chat-B");
          client.destroy();
          for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") === true; i++) await sleep(10);
          expect(bus.hasIpcConnection?.("a")).toBe(false);
          expect(texts(delivered)).toEqual(["from A"]); // parked
          turnEnd(bus, "a"); // the tailer proves A over
          expect(texts(delivered)).toEqual(["from A", "from B"]);
        } finally {
          await bus.stop();
        }
      });

      it("with a turn live is bounded by the deadline", async () => {
        const { bus, client, delivered, errors } = await ipcBus();
        try {
          await send(bus, "a", "from A", "telegram", "chat-A");
          bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
          await send(bus, "a", "from B", "telegram", "chat-B");
          client.destroy();
          for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") === true; i++) await sleep(10);
          expect(bus.hasIpcConnection?.("a")).toBe(false);
          expect(texts(delivered)).toEqual(["from A"]);
          await sleep(100);
          expect(errors.find((e) => e.ctx?.ctx === "turn-deadline")?.ctx?.held).toContain("parked");
          expect(texts(delivered)).toEqual(["from A", "from B"]);
        } finally {
          await bus.stop();
        }
      });

      it("while parked with the agent gone, a new prompt wakes the reconciler like a failed send used to", async () => {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { encodeFrame } = await import("../core");
        const sock = join(mkdtempSync(join(tmpdir(), "bus-239-")), "bus.sock");
        const delivered: string[] = [];
        const reconcile: string[] = [];
        const bus = createBusCore({
          eventLogAppend: mockAppend,
          turnEndSettleMs: 0,
          onError: () => {},
          socketPath: sock,
          onMcpSendFailed: (_a, ctx) => reconcile.push(ctx.reason),
          streamPromptHandler: async (_a, text) => {
            delivered.push(text);
          },
        });
        await bus.start();
        let opened!: () => void;
        const isOpen = new Promise<void>((r) => {
          opened = r;
        });
        const socket = await Bun.connect({
          unix: sock,
          socket: {
            open() {
              opened();
            },
            data() {},
            error() {},
            close() {},
          },
        });
        await isOpen;
        socket.write(
          encodeFrame({
            type: "hello",
            agent_id: "a",
            capabilities: ["claude/channel", "claude/channel/permission"],
          } as never),
        );
        for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") !== true; i++) await sleep(10);
        try {
          await send(bus, "a", "from A", "telegram", "chat-A");
          bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
          socket.end(); // the process died mid-turn
          for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") === true; i++) await sleep(10);
          expect(reconcile).toEqual([]);
          const b = await send(bus, "a", "from B", "telegram", "chat-B");
          expect(b.queued).toBe(true);
          expect(reconcile).toEqual(["sendPrompt:parked-no-mcp-connection"]);
          expect(texts(delivered)).toEqual(["from A"]); // still not typed into the PTY
        } finally {
          await bus.stop();
        }
      });

      it("an IPC-only blip during the early-release window keeps the guard: the released turn's late end still frees nothing", async () => {
        const { bus, client, delivered } = await ipcBus();
        try {
          await send(bus, "a", "from A", "telegram", "chat-A");
          bus.ingestSessionEvent(tailer("a", "prompt", { text: delivered[0] }));
          await send(bus, "a", "from B", "telegram", "chat-B");
          await send(bus, "a", "from C", "telegram", "chat-C");
          // deadline (80): B typed into A's live turn
          for (let i = 0; i < 40 && texts(delivered).length < 2; i++) await sleep(10);
          expect(texts(delivered)).toEqual(["from A", "from B"]);
          client.destroy(); // blip
          for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") === true; i++) await sleep(10);
          turnEnd(bus, "a"); // A's late end
          expect(texts(delivered)).toEqual(["from A", "from B"]); // C not admitted into B's turn
        } finally {
          await bus.stop();
        }
      });

      it("with the agent idle admits the next prompt as a direct one would have been delivered", async () => {
        const { bus, client, delivered } = await ipcBus();
        try {
          await send(bus, "a", "one");
          turnEnd(bus, "a");
          (bus as unknown as { agentTurnActive: Set<string> }).agentTurnActive.add("a"); // foreign turn
          await send(bus, "a", "two");
          (bus as unknown as { agentTurnActive: Set<string> }).agentTurnActive.delete("a");
          // gate free but "two" still queued (no admission ran); the close finds no live turn
          client.destroy();
          for (let i = 0; i < 50 && bus.hasIpcConnection?.("a") === true; i++) await sleep(10);
          expect(bus.hasIpcConnection?.("a")).toBe(false);
          expect(texts(delivered)).toEqual(["one", "two"]);
        } finally {
          await bus.stop();
        }
      });
    });
  });
});
