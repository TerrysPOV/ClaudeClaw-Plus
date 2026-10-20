import { describe, it, expect } from "bun:test";
import { AuditLog, type AuditRecord } from "../../skills-tuner/core/audit-log.js";
import { ToolCallSink } from "../tool-call-sink.js";
import type { ToolCallEvent } from "../tool-call.js";

function ev(over: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    ts: "2026-05-25T12:00:00.000Z",
    plugin: "alpha",
    tool: "echo",
    agent_id: "pty-1",
    status: "ok",
    duration_ms: 10,
    ...over,
  };
}

/** Flush `events` through a sink backed by an in-memory chain; return what landed. */
function flushed(events: ToolCallEvent[]): readonly AuditRecord[] {
  const log = new AuditLog(":memory:");
  const sink = new ToolCallSink({ path: null, autoFlush: false, logFactory: () => log });
  for (const e of events) sink.record(e);
  sink.flush();
  return log.all();
}

describe("ToolCallSink — caller-supplied strings are bounded before they are persisted", () => {
  it("keeps a tool name at the cap and truncates one past it", () => {
    const atCap = "t".repeat(256);
    const overCap = `${"u".repeat(256)}${"x".repeat(1_000_000)}`;
    const [kept, cut] = flushed([ev({ tool: atCap }), ev({ tool: overCap, status: "error" })]);
    expect(kept?.detail?.tool).toBe(atCap);
    expect(cut?.detail?.tool).toBe(`${"u".repeat(256)}…[truncated 1000000 chars]`);
  });

  it("bounds the tool name on the enforce-mode intent record too", () => {
    const log = new AuditLog(":memory:");
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      policy: "enforce",
      logFactory: () => log,
    });
    sink.recordIntent({
      ts: "2026-05-25T12:00:00.000Z",
      plugin: "alpha",
      tool: "v".repeat(257),
      agent_id: "pty-1",
    });
    expect(log.all()[0]?.detail?.tool).toBe(`${"v".repeat(256)}…[truncated 1 chars]`);
  });

  it("truncates an error string past its own cap, independently of the tool cap", () => {
    const [rec] = flushed([ev({ status: "error", error: "e".repeat(2_001) })]);
    expect(rec?.detail?.error).toBe(`${"e".repeat(2_000)}…[truncated 1 chars]`);
  });
});

describe("ToolCallSink.applyPolicy — settings.mcp.audit at boot and on reload (#232)", () => {
  function recordingSink() {
    const appended: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append(e: { event: string; detail?: Record<string, unknown> }) {
          appended.push(e);
        },
      }),
    });
    return { sink, appended };
  }

  it("boot under best-effort writes nothing", () => {
    const { sink, appended } = recordingSink();
    sink.applyPolicy("best-effort");
    expect(sink.getPolicy()).toBe("best-effort");
    expect(appended).toEqual([]);
  });

  it("boot under enforce records the policy once; an unchanged reload writes nothing", () => {
    const { sink, appended } = recordingSink();
    sink.applyPolicy("enforce");
    sink.applyPolicy("enforce");
    expect(sink.getPolicy()).toBe("enforce");
    expect(appended.map((e) => [e.event, e.detail?.policy])).toEqual([
      ["mcp.audit_policy", "enforce"],
    ]);
  });

  it("records every later change, the switch to best-effort included", () => {
    const { sink, appended } = recordingSink();
    sink.applyPolicy("enforce");
    sink.applyPolicy("best-effort");
    sink.applyPolicy("enforce");
    expect(appended.map((e) => [e.detail?.policy, e.detail?.previous])).toEqual([
      ["enforce", undefined],
      ["best-effort", "enforce"],
      ["enforce", "best-effort"],
    ]);
  });

  it("keeps a change it could not record and writes it, in order, once the chain is back", () => {
    let down = false;
    const appended: Array<{ detail?: Record<string, unknown> }> = [];
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append(e: { detail?: Record<string, unknown> }) {
          if (down) throw new Error("chain unwritable");
          appended.push(e);
        },
      }),
    });
    sink.applyPolicy("enforce");
    down = true;
    sink.applyPolicy("best-effort");
    sink.applyPolicy("best-effort");
    expect(sink.getPolicy()).toBe("best-effort");
    down = false;
    // An unchanged reload retries what is pending.
    sink.applyPolicy("best-effort");
    sink.applyPolicy("enforce");
    sink.applyPolicy("enforce");
    expect(appended.map((e) => [e.detail?.policy, e.detail?.previous])).toEqual([
      ["enforce", undefined],
      ["best-effort", "enforce"],
      ["enforce", "best-effort"],
    ]);
    expect(typeof appended[1]?.detail?.changed_at).toBe("string");
  });

  it("writes a pending change before the next result batch or intent, not at the next reload", () => {
    let down = false;
    const appended: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append(e: { event: string; detail?: Record<string, unknown> }) {
          if (down) throw new Error("chain unwritable");
          appended.push(e);
        },
      }),
    });
    sink.applyPolicy("enforce");
    down = true;
    sink.applyPolicy("best-effort");
    down = false;
    sink.record({
      ts: "2026-01-01T00:00:00.000Z",
      plugin: "p",
      tool: "t",
      agent_id: "a",
      status: "ok",
      duration_ms: 1,
    });
    sink.flush();
    expect(appended.map((e) => [e.event, e.detail?.policy ?? null])).toEqual([
      ["mcp.audit_policy", "enforce"],
      ["mcp.audit_policy", "best-effort"],
      ["mcp.tool_call", null],
    ]);

    down = true;
    sink.applyPolicy("enforce");
    down = false;
    sink.recordIntent({ ts: "2026-01-01T00:00:01.000Z", plugin: "p", tool: "t", agent_id: "a" });
    expect(appended.slice(3).map((e) => [e.event, e.detail?.policy ?? null])).toEqual([
      ["mcp.audit_policy", "enforce"],
      ["mcp.tool_call_intent", null],
    ]);
  });

  it("refuses an intent, and holds results, while a policy record is still pending", () => {
    let failures = 0;
    const appended: Array<{ event: string }> = [];
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append(e: { event: string }) {
          if (failures > 0) {
            failures--;
            throw new Error("chain unwritable");
          }
          appended.push(e);
        },
      }),
    });
    sink.applyPolicy("best-effort");
    failures = 1;
    sink.applyPolicy("enforce"); // change record fails, stays pending
    failures = 1; // the drain at the next intent fails once more
    expect(() =>
      sink.recordIntent({ ts: "2026-01-01T00:00:00.000Z", plugin: "p", tool: "t", agent_id: "a" }),
    ).toThrow(/policy record pending/);
    expect(appended).toEqual([]);
    sink.record({
      ts: "2026-01-01T00:00:00.000Z",
      plugin: "p",
      tool: "t",
      agent_id: "a",
      status: "ok",
      duration_ms: 1,
    });
    failures = 1;
    sink.flush();
    expect(appended).toEqual([]);
    expect(sink.pending()).toHaveLength(1);
    sink.flush();
    expect(appended.map((e) => e.event)).toEqual(["mcp.audit_policy", "mcp.tool_call"]);
  });

  it("retries a boot record that could not be written, and counts what overflowed", () => {
    let down = true;
    const appended: Array<{ detail?: Record<string, unknown> }> = [];
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append(e: { detail?: Record<string, unknown> }) {
          if (down) throw new Error("chain unwritable");
          appended.push(e);
        },
      }),
    });
    sink.applyPolicy("enforce");
    for (let i = 0; i < 70; i++) sink.applyPolicy(i % 2 === 0 ? "best-effort" : "enforce");
    down = false;
    sink.applyPolicy("enforce");
    expect(appended).toHaveLength(64);
    expect(appended[0]?.detail?.dropped_before).toBe(7);
    expect(appended.slice(1).some((e) => e.detail?.dropped_before !== undefined)).toBe(false);
  });

  it("never throws when the chain cannot be written", () => {
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw new Error("chain unwritable");
        },
      }),
    });
    expect(() => sink.applyPolicy("enforce")).not.toThrow();
    expect(() => sink.applyPolicy("best-effort")).not.toThrow();
    expect(sink.getPolicy()).toBe("best-effort");
  });
});
