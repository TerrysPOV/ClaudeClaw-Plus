import { describe, it, expect } from "bun:test";
import { OperatorAlertBuffer, DEFAULT_MAX_OPERATOR_ALERTS } from "../operator-alert-buffer.js";
import type { BusEvent } from "../types";

function alert(text: string, level: "warn" | "critical" = "warn", ts = 1, agent = "reg"): BusEvent {
  return {
    ts,
    agent_id: agent,
    session_id: "s1",
    topic: "system.operator_alert",
    payload: { level, text, source: "stall-watchdog" },
  };
}

describe("OperatorAlertBuffer (#325)", () => {
  it("records alerts oldest-first with level/source/agent", () => {
    const buf = new OperatorAlertBuffer();
    buf.ingest(alert("first", "warn", 10, "reg"));
    buf.ingest(alert("second", "critical", 20, "suzy"));
    const recent = buf.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toEqual({
      ts: 10,
      agentId: "reg",
      level: "warn",
      text: "first",
      source: "stall-watchdog",
    });
    expect(recent[1]?.level).toBe("critical");
    expect(recent[1]?.agentId).toBe("suzy");
  });

  it("drops an alert with no usable text", () => {
    const buf = new OperatorAlertBuffer();
    buf.ingest({
      ts: 1,
      agent_id: "reg",
      session_id: "s",
      topic: "system.operator_alert",
    } as unknown as BusEvent);
    buf.ingest({
      ts: 2,
      agent_id: "reg",
      session_id: "s",
      topic: "system.operator_alert",
      payload: { level: "warn", source: "x" },
    } as BusEvent);
    expect(buf.recent()).toHaveLength(0);
  });

  it("defaults a non-critical/absent level to warn", () => {
    const buf = new OperatorAlertBuffer();
    buf.ingest({
      ts: 1,
      agent_id: "reg",
      session_id: "s",
      topic: "system.operator_alert",
      payload: { text: "no level" },
    } as BusEvent);
    expect(buf.recent()[0]?.level).toBe("warn");
  });

  it("evicts oldest-first past the cap", () => {
    const buf = new OperatorAlertBuffer(3);
    for (let i = 1; i <= 5; i++) buf.ingest(alert(`a${i}`, "warn", i));
    const recent = buf.recent();
    expect(recent.map((r) => r.text)).toEqual(["a3", "a4", "a5"]); // 3 newest
  });

  it("attaches a single topic subscription and detaches it", () => {
    let closed = false;
    let filter: unknown = null;
    const fakeBus = {
      subscribe(f: unknown) {
        filter = f;
        return { id: "1", close: () => (closed = true), overflowCount: 0, depth: 0 };
      },
    };
    const buf = new OperatorAlertBuffer();
    // biome-ignore lint/suspicious/noExplicitAny: minimal BusCore seam for the subscribe/close contract.
    buf.attach(fakeBus as any);
    expect(filter).toEqual({ topics: ["system.operator_alert"] });
    // biome-ignore lint/suspicious/noExplicitAny: idempotent re-attach must not double-subscribe.
    buf.attach(fakeBus as any); // idempotent
    buf.detach();
    expect(closed).toBe(true);
    expect(DEFAULT_MAX_OPERATOR_ALERTS).toBeGreaterThan(0);
  });
});
