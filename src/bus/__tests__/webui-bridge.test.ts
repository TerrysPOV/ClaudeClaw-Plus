/**
 * Tests for `streamBusPrompt` — the bridge the legacy webui uses to
 * route its trigger paths (`/api/jobs/fire`, `/api/inject`, `/api/chat`)
 * through the bus's per-agent claude session instead of spawning a
 * sidecar PTY that would race the bus.
 *
 * Strategy: build a real `BusCoreImpl` against an in-memory mock event
 * log + no IPC server (just the in-process pub/sub surface). Drive the
 * reply path by calling `bus.ingestReply` directly — that's how the
 * plus-bus MCP server normally publishes claude's responses.
 */
import { describe, expect, it } from "bun:test";
import { createBusCore, type BusCore } from "../core";
import type { EventEntryInput, EventRecord } from "../../event-log";
import { streamBusPrompt } from "../webui-bridge";

function mockEventLog() {
  let seq = 0;
  return async (entry: EventEntryInput): Promise<EventRecord> => {
    seq += 1;
    const now = new Date().toISOString();
    return {
      id: `mock-${seq}`,
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

function makeBus(): BusCore {
  return createBusCore({ eventLogAppend: mockEventLog() });
}

describe("streamBusPrompt", () => {
  it("resolves with the final reply text when claude emits a single 'final' event", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hi", { timeoutMs: 2000 });
    // Give bus.sendPrompt a microtask to run + register the subscriber
    // before we ingest the reply.
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "hello back", intent: "final" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello back");
    expect(result.exitCode).toBe(0);
  });

  it("accumulates progress + final events into the returned output", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hi", { timeoutMs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "chunk-1 ", intent: "progress" });
    bus.ingestReply({ agent_id: "alpha", text: "chunk-2 ", intent: "progress" });
    bus.ingestReply({ agent_id: "alpha", text: "done", intent: "final" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toBe("chunk-1 chunk-2 done");
  });

  it("invokes onChunk for every response.text event", async () => {
    const bus = makeBus();
    const chunks: string[] = [];
    const pending = streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 2000,
      onChunk: (t) => chunks.push(t),
    });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "one", intent: "progress" });
    bus.ingestReply({ agent_id: "alpha", text: "two", intent: "final" });
    await pending;
    expect(chunks).toEqual(["one", "two"]);
  });

  it("does NOT receive events for other agents", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hi", { timeoutMs: 500 });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "beta", text: "wrong-agent", intent: "final" });
    const result = await pending;
    // beta's reply is ignored — alpha's stream times out empty.
    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toMatch(/timed out/);
  });

  it("times out with whatever was accumulated when no final lands", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hi", { timeoutMs: 300 });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "partial-", intent: "progress" });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("partial-");
    expect(result.error).toMatch(/timed out after 300ms/);
  });

  it("survives a chunk callback that throws", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hi", {
      timeoutMs: 2000,
      onChunk: () => {
        throw new Error("chunk handler exploded");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "hello", intent: "final" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("propagates a custom BusOrigin tag on the outgoing prompt", async () => {
    // Subscribe to the `prompt` topic so we can read back what
    // sendPrompt published.
    const bus = makeBus();
    const promptEvents: Array<{ origin: string; origin_id: string; text: string }> = [];
    bus.subscribe({ agent_id: "alpha", topics: ["prompt"] }, (event) => {
      const payload = event.payload as { origin: string; origin_id: string; text: string };
      promptEvents.push({
        origin: payload.origin,
        origin_id: payload.origin_id,
        text: payload.text,
      });
    });
    const pending = streamBusPrompt(bus, "alpha", "do a thing", {
      timeoutMs: 500,
      origin: "cron",
      originId: "job:morning-digest",
    });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "done", intent: "final" });
    await pending;
    expect(promptEvents).toHaveLength(1);
    expect(promptEvents[0]).toEqual({
      origin: "cron",
      origin_id: "job:morning-digest",
      text: "do a thing",
    });
  });

  it("cleans up subscriber + timer on resolution (no leaked listeners)", async () => {
    const bus = makeBus();
    expect(bus.state().subscriberCount).toBe(0);
    const pending = streamBusPrompt(bus, "alpha", "hi", { timeoutMs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    // One subscriber active during the prompt flow.
    expect(bus.state().subscriberCount).toBe(1);
    bus.ingestReply({ agent_id: "alpha", text: "done", intent: "final" });
    await pending;
    // Subscriber should be closed after resolution.
    expect(bus.state().subscriberCount).toBe(0);
  });
});
