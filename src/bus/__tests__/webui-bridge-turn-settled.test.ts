/**
 * #436: `streamBusPrompt` resolves when its WAIT ends — on the reply, or on
 * `timeoutMs` — and the timeout does not end the agent's turn. A caller that
 * must act when the turn is over (the web UI's `fire`, which restores the
 * job's frontmatter snapshot) gets `onTurnSettled`, fired on that turn's own
 * `response.turn_end` and never before the wait resolves.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBusCore, type BusCore } from "../core";
import { _setDefaultReceiptStoreForTests, createReceiptStore } from "../receipt";
import type { BusEvent } from "../types";
import { streamBusPrompt, type TurnSettleReason } from "../webui-bridge";

let tmp: string;
let restoreStore: (() => void) | null = null;
beforeAll(() => {
  // Never the operator's real receipts.jsonl.
  tmp = mkdtempSync(join(tmpdir(), "ccplus-turn-settled-"));
  restoreStore = _setDefaultReceiptStoreForTests(
    createReceiptStore({ path: join(tmp, "receipts.jsonl") }),
  );
});
afterAll(() => {
  restoreStore?.();
  rmSync(tmp, { recursive: true, force: true });
});

const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(): BusCore {
  return createBusCore({ eventLogAppend: mockAppend, onError: () => {}, turnEndSettleMs: 0 });
}

/** A tailer-shaped event: the bus stamps the running turn's promise_id on it. */
function tailerEvent(agent_id: string, topic: BusEvent["topic"], payload: unknown): BusEvent {
  return { ts: Date.now(), agent_id, session_id: "sess-1", topic, payload };
}

function recorder() {
  const reasons: TurnSettleReason[] = [];
  return { reasons, onTurnSettled: (r: TurnSettleReason) => reasons.push(r) };
}

const tick = () => Bun.sleep(5);

describe("streamBusPrompt onTurnSettled (#436)", () => {
  it("after a wait timeout, settles on the turn's own turn_end — not at the timeout", async () => {
    const bus = makeBus();
    const rec = recorder();
    const result = await streamBusPrompt(bus, "alpha", "long job", {
      timeoutMs: 30,
      onTurnSettled: rec.onTurnSettled,
    });
    expect(result.ok).toBe(false); // the wait gave up
    await tick();
    expect(rec.reasons).toEqual([]); // the turn has not ended
    bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "still working" }));
    await tick();
    expect(rec.reasons).toEqual([]);
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await tick();
    expect(rec.reasons).toEqual(["turn_end"]);
  });

  it("after a final reply, still waits for the turn_end (a turn can write after replying)", async () => {
    const bus = makeBus();
    const rec = recorder();
    const pending = streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 2000,
      onTurnSettled: rec.onTurnSettled,
    });
    await tick();
    bus.ingestReply({ agent_id: "alpha", text: "done", intent: "final" });
    const result = await pending;
    expect(result.ok).toBe(true);
    await tick();
    expect(rec.reasons).toEqual([]);
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await tick();
    expect(rec.reasons).toEqual(["turn_end"]);
  });

  it("a turn_end seen before the wait resolves is reported only after the caller has its result", async () => {
    const bus = makeBus();
    const order: string[] = [];
    const pending = streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 60,
      onTurnSettled: (r) => order.push(`settled:${r}`),
    }).then((r) => {
      order.push("result");
      return r;
    });
    await tick();
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await tick();
    expect(order).toEqual([]);
    await pending;
    await tick();
    expect(order).toEqual(["result", "settled:turn_end"]);
  });

  it("a released earlier turn's late turn_end, stamped with our id, does not settle ours", async () => {
    // The earlier turn's slot is released by the turn deadline; ours is then
    // admitted, and the earlier turn's terminator arrives late.
    const bus = createBusCore({
      eventLogAppend: mockAppend,
      onError: () => {},
      turnEndSettleMs: 0,
      turnDeadlineMs: 30,
    });
    await bus.sendPrompt({
      agent_id: "alpha",
      origin: "webui",
      origin_id: "other",
      user_id: "u",
      text: "earlier",
    });
    await Bun.sleep(60);
    const rec = recorder();
    const result = await streamBusPrompt(bus, "alpha", "fire job", {
      timeoutMs: 20,
      onTurnSettled: rec.onTurnSettled,
    });
    expect(result.ok).toBe(false);
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await Bun.sleep(20);
    expect(rec.reasons).toEqual([]);
  });

  it("a prompt still queued at the timeout is withdrawn and settles with no_turn", async () => {
    const bus = makeBus();
    const rec = recorder();
    // Another chat's turn is running; ours queues behind it.
    await bus.sendPrompt({
      agent_id: "alpha",
      origin: "webui",
      origin_id: "other",
      user_id: "u",
      text: "first",
    });
    const result = await streamBusPrompt(bus, "alpha", "ours", {
      timeoutMs: 30,
      onTurnSettled: rec.onTurnSettled,
    });
    expect(result.ok).toBe(false);
    await tick();
    // The queued prompt was withdrawn at the timeout: no turn of ours will run.
    expect(rec.reasons).toEqual(["no_turn"]);
  });

  it("settles with no_turn when the send itself fails", async () => {
    const rec = recorder();
    const bus = {
      subscribe: () => ({ close: () => undefined }),
      sendPrompt: async () => {
        throw new Error("agent not mounted");
      },
      activeTurnAgents: () => [],
    } as unknown as BusCore;
    const result = await streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 1000,
      onTurnSettled: rec.onTurnSettled,
    });
    expect(result.ok).toBe(false);
    await tick();
    expect(rec.reasons).toEqual(["no_turn"]);
  });

  it("idleness alone does not settle (a deadline-released slow turn may still run); idle after our own turn_end does", async () => {
    const rec = recorder();
    let busy = false;
    const handlers: Array<(e: BusEvent) => void> = [];
    const bus = {
      subscribe: (_f: unknown, h: (e: BusEvent) => void) => {
        handlers.push(h);
        return { close: () => handlers.splice(handlers.indexOf(h), 1) };
      },
      sendPrompt: async () => ({ promise_id: "p1", queued: false }),
      busyAgents: () => (busy ? ["alpha"] : []),
      activeTurnAgents: () => [],
    } as unknown as BusCore;
    const result = await streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 20,
      turnSettlePollMs: 10,
      onTurnSettled: rec.onTurnSettled,
    });
    expect(result.ok).toBe(false);
    await Bun.sleep(60);
    expect(rec.reasons).toEqual([]); // idle, but no turn_end: not over
    // Our turn_end lands while another prompt keeps the agent busy.
    busy = true;
    for (const h of [...handlers]) {
      h({
        ts: Date.now(),
        agent_id: "alpha",
        session_id: "s",
        topic: "response.turn_end",
        payload: {},
        promise_id: "p1",
      } as BusEvent);
    }
    await Bun.sleep(50);
    expect(rec.reasons).toEqual([]);
    busy = false;
    await Bun.sleep(50);
    expect(rec.reasons).toEqual(["idle"]);
    expect(handlers).toHaveLength(0); // both subscriptions closed
  });

  it("is armed only once streamBusPrompt itself resolves (after the rotation work)", async () => {
    const bus = makeBus();
    const order: string[] = [];
    const pending = streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 2000,
      onTurnSettled: (r) => order.push(`settled:${r}`),
    }).then(() => order.push("result"));
    await tick();
    bus.ingestReply({ agent_id: "alpha", text: "done", intent: "final" });
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await pending;
    await tick();
    expect(order).toEqual(["result", "settled:turn_end"]);
  });

  it("settles at the ceiling when the turn never ends", async () => {
    const bus = makeBus();
    const rec = recorder();
    await streamBusPrompt(bus, "alpha", "forever", {
      timeoutMs: 20,
      turnSettleCeilingMs: 40,
      onTurnSettled: rec.onTurnSettled,
    });
    await Bun.sleep(10);
    expect(rec.reasons).toEqual([]);
    await Bun.sleep(60);
    expect(rec.reasons).toEqual(["ceiling"]);
    // A late turn_end does not fire it twice.
    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    await tick();
    expect(rec.reasons).toEqual(["ceiling"]);
  });
});
