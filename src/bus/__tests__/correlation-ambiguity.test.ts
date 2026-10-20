/**
 * When an operation id cannot be trusted, the envelope has to say so.
 *
 * `promise_id` is per-agent, not per-operation, so a prompt arriving while the
 * previous turn has not reached its terminator would make every event after it
 * carry an id that may belong to the other turn. A client cannot detect that
 * from outside: correlation looks exact and is wrong, which is the failure
 * class §3.2 exists to keep out of this seam, arriving through a different
 * door.
 *
 * #239 closed that door for bus-opened turns: one active turn per agent, a
 * second prompt waits for the first's terminator. The flag is kept for the one
 * overlap that remains reachable — the turn deadline freeing a slot whose turn
 * may merely have been slow — and these tests pin both halves: the overlap
 * that no longer happens, and the flag on the one that still can.
 *
 * Run with: `bun test src/bus/__tests__/correlation-ambiguity.test.ts`
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import { createBusCore, type BusCore, type BusCoreOptions } from "../core";
import type { BusEvent } from "../types";

const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(opts: Partial<BusCoreOptions> = {}): { bus: BusCore; events: BusEvent[] } {
  const events: BusEvent[] = [];
  const bus = createBusCore({
    eventLogAppend: mockAppend,
    onError: () => {},
    turnEndSettleMs: 0,
    ...opts,
  });
  bus.subscribe({}, (e) => events.push(e));
  return { bus, events };
}

function prompt(bus: BusCore, agent_id: string, text: string) {
  return bus.sendPrompt({ agent_id, origin: "webui", origin_id: "http", user_id: "u", text });
}

function tailerEvent(agent_id: string, topic: BusEvent["topic"], payload: unknown = {}): BusEvent {
  return { ts: Date.now(), agent_id, session_id: "sess-1", topic, payload };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const flagged = (events: BusEvent[]) =>
  events.filter((e) => (e as { correlation_ambiguous?: true }).correlation_ambiguous === true);

describe("correlation ambiguity on the envelope", () => {
  it("a clean single turn is not flagged", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "hi" }));
    expect(flagged(events)).toEqual([]);
  });

  it("a second prompt while the first has not terminated waits — the overlap that used to flag no longer happens (#239)", async () => {
    const { bus, events } = makeBus();
    const { promise_id: p1 } = await prompt(bus, "a", "one");
    // No turn_end for the first: its slot is still occupied, so the second is
    // queued rather than admitted on top of it.
    const second = await prompt(bus, "a", "two");
    expect(second.queued).toBe(true);
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "hi" }));
    expect(flagged(events)).toEqual([]);
    const texts = events.filter((e) => e.topic === "response.text");
    for (const e of texts) expect(e.promise_id).toBe(p1);
  });

  it("the lagged-turn_end window is closed: the second prompt is admitted on the terminator, under its own id", async () => {
    // The sequential race (#217 finding 3): the first turn produces its final
    // reply, the second is submitted, and only then does the first turn's
    // `response.turn_end` arrive. Before #239 the second had already taken the
    // slot and that terminator was stamped with its id, flagged. Now the
    // second is admitted BY that terminator: nothing overlaps, nothing flags.
    const { bus, events } = makeBus();
    const { promise_id: p1 } = await prompt(bus, "a", "one");
    bus.ingestReply({ agent_id: "a", intent: "final", text: "done" } as never);
    const { promise_id: p2 } = await prompt(bus, "a", "two");
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end"));
    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd?.promise_id).toBe(p1); // the first turn's own terminator
    const prompts = events.filter((e) => e.topic === "prompt");
    expect(prompts.map((e) => e.promise_id)).toEqual([p2]); // admitted right after it
    expect(flagged(events)).toEqual([]);
  });

  it("one terminator drains the agent: the next turn starts clean", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    await prompt(bus, "a", "two"); // queued
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end")); // one ends, two admitted
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end")); // two ends
    const { promise_id: p3 } = await prompt(bus, "a", "three");
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "clean" }));
    expect(flagged(events)).toEqual([]);
    for (const e of events.filter((x) => x.topic === "response.text"))
      expect(e.promise_id).toBe(p3);
  });

  it("a lagged terminator does not strip the id of the turn still running", async () => {
    // P1 replies, P2 is submitted, P1's lagged `response.turn_end` lands. P2's
    // events must carry P2's id — before #239 because the count kept the slot
    // for P2, now because P2 only starts once that terminator has landed.
    const { bus, events } = makeBus();
    await prompt(bus, "a", "P1");
    bus.ingestReply({ agent_id: "a", intent: "final", text: "P1 done" } as never);
    const { promise_id: p2 } = await prompt(bus, "a", "P2");
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end")); // P1's, late
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "P2 still going" }));
    const seen = events.filter((e) => e.topic === "response.text");
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(e.promise_id).toBe(p2);
  });

  it("the one overlap left — a slot the deadline freed — flags the prompt admitted onto it, prompt event included", async () => {
    // The deadline releases a turn that showed no sign of life. That turn may
    // merely be slow, so the prompt admitted next can overlap it; its prompt
    // event mints its own id at the top level, and a stamper that returned
    // early on an id already present would skip the flag on the first event a
    // client sees for the operation.
    const { bus, events } = makeBus({ turnDeadlineMs: 50 });
    await prompt(bus, "a", "one");
    events.length = 0;
    await prompt(bus, "a", "two"); // queued behind "one"
    expect(events.filter((e) => e.topic === "prompt")).toHaveLength(0);
    await sleep(75); // > deadline: "one" released, "two" admitted (its own deadline not yet due)
    const prompts = events.filter((e) => e.topic === "prompt");
    expect(prompts.length).toBe(1);
    expect((prompts[0] as { correlation_ambiguous?: true }).correlation_ambiguous).toBe(true);
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "whose?" }));
    expect(flagged(events).length).toBeGreaterThan(1); // the taint lives with the id
  });

  it("a slot the deadline freed taints only the NEXT admission, not a later clean one", async () => {
    const { bus, events } = makeBus({ turnDeadlineMs: 30 });
    await prompt(bus, "a", "one");
    await sleep(80); // released; nothing queued
    await prompt(bus, "a", "two"); // admitted onto the freed slot: flagged
    // Admitted after an early release, "two" waits for its own transcript
    // line before a terminator counts as its own.
    bus.ingestSessionEvent(tailerEvent("a", "prompt", { text: "<channel>two</channel>" }));
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end")); // two ends normally
    events.length = 0;
    await prompt(bus, "a", "three");
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "clean again" }));
    expect(flagged(events)).toEqual([]);
  });

  it("agents stay apart — one agent's overlap does not taint another", async () => {
    const { bus, events } = makeBus({ turnDeadlineMs: 30 });
    await prompt(bus, "a", "one");
    await sleep(80);
    await prompt(bus, "a", "two"); // a is now ambiguous
    await prompt(bus, "b", "one"); // b is clean
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("b", "response.text", { text: "hi" }));
    expect(flagged(events)).toEqual([]);
  });

  it("the flag never rides alone — no operation id, no flag", async () => {
    // An event outside any turn has nothing for the flag to qualify. Emitting
    // it there would tell a client its correlation is uncertain when it has no
    // correlation at all.
    const { bus, events } = makeBus();
    bus.ingestSessionEvent(tailerEvent("never-prompted", "response.text", { text: "orphan" }));
    const orphans = events.filter((e) => e.agent_id === "never-prompted");
    expect(orphans.length).toBeGreaterThan(0);
    for (const e of orphans) {
      expect((e as { correlation_ambiguous?: true }).correlation_ambiguous).toBeUndefined();
      expect(e.promise_id).toBeUndefined();
    }
  });

  it("the caller's event object is not mutated", async () => {
    const { bus } = makeBus();
    await prompt(bus, "a", "one");
    await prompt(bus, "a", "two");
    const mine = tailerEvent("a", "response.text", { text: "hi" });
    bus.ingestSessionEvent(mine);
    expect((mine as { correlation_ambiguous?: true }).correlation_ambiguous).toBeUndefined();
    expect(mine.promise_id).toBeUndefined();
  });
});
