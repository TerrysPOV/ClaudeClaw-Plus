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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusCore, type BusCore } from "../core";
import type { EventEntryInput, EventRecord } from "../../event-log";
import {
  _setDefaultReceiptStoreForTests,
  createReceiptStore,
  hashPrompt,
  type ReceiptRecord,
  type ReceiptStore,
} from "../receipt";
import { streamBusPrompt } from "../webui-bridge";

// Redirect the process-wide default receipt store to a throwaway path for the
// duration of this file so the existing 11 streamBusPrompt tests (which
// do not pass receiptStore) do not append to the user real
// ~/.claude/claudeclaw/receipts.jsonl. The receipt-chain describe below
// passes an explicit per-test store so it is not affected by this redirection.
let _singletonTmpDir: string;
let _restoreSingleton: (() => void) | null = null;
beforeAll(() => {
  _singletonTmpDir = mkdtempSync(join(tmpdir(), "ccplus-bridge-singleton-"));
  const sink = createReceiptStore({ path: join(_singletonTmpDir, "receipts.jsonl") });
  _restoreSingleton = _setDefaultReceiptStoreForTests(sink);
});
afterAll(() => {
  _restoreSingleton?.();
  if (existsSync(_singletonTmpDir)) rmSync(_singletonTmpDir, { recursive: true, force: true });
});

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

  it("serializes concurrent prompts to the same agent (Codex P1 on #136)", async () => {
    // The bridge subscribes by agent_id only; without serialization a
    // second prompt's `final` could resolve the first caller. We assert
    // the second prompt does NOT start (no subscriber registered)
    // until the first one resolves.
    const bus = makeBus();
    const firstPending = streamBusPrompt(bus, "alpha", "first", { timeoutMs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.state().subscriberCount).toBe(1);

    const secondPending = streamBusPrompt(bus, "alpha", "second", { timeoutMs: 2000 });
    // Give the second call a tick to enter the queue.
    await Promise.resolve();
    await Promise.resolve();
    // First is still the only subscriber — second is parked on the
    // mutex tail.
    expect(bus.state().subscriberCount).toBe(1);

    // A reply lands. With unfiltered subscription this would resolve
    // whichever caller subscribed first; we assert it's the FIRST call
    // (the only one with an active subscriber).
    bus.ingestReply({ agent_id: "alpha", text: "first-reply", intent: "final" });
    const firstResult = await firstPending;
    expect(firstResult.output).toBe("first-reply");

    // Now the second call's subscriber registers.
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.state().subscriberCount).toBe(1);
    bus.ingestReply({ agent_id: "alpha", text: "second-reply", intent: "final" });
    const secondResult = await secondPending;
    expect(secondResult.output).toBe("second-reply");
    expect(bus.state().subscriberCount).toBe(0);
  });

  it("serialization is per-agent (different agents proceed in parallel)", async () => {
    const bus = makeBus();
    const aPending = streamBusPrompt(bus, "alpha", "to-alpha", { timeoutMs: 2000 });
    const bPending = streamBusPrompt(bus, "beta", "to-beta", { timeoutMs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    // Both subscribers active simultaneously — separate agents.
    expect(bus.state().subscriberCount).toBe(2);
    bus.ingestReply({ agent_id: "beta", text: "beta-reply", intent: "final" });
    bus.ingestReply({ agent_id: "alpha", text: "alpha-reply", intent: "final" });
    const [a, b] = await Promise.all([aPending, bPending]);
    expect(a.output).toBe("alpha-reply");
    expect(b.output).toBe("beta-reply");
  });
});

/**
 * Receipt-chain wiring: the bridge must open a receipt at entry, stamp
 * `agent_id` + `prompt_hash` + selected route, and close on the terminal
 * state observed (`turn_observed` / `timeout` / `wedged_prompt`). Issue #207.
 */
describe("streamBusPrompt — receipt chain", () => {
  let tmpDir: string;
  let logPath: string;
  let store: ReceiptStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccplus-bridge-receipt-"));
    logPath = join(tmpDir, "receipts.jsonl");
    store = createReceiptStore({ path: logPath });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function readReceipts(): ReceiptRecord[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ReceiptRecord);
  }

  it("closes a receipt as turn_observed on intent:final", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "hello world", {
      timeoutMs: 2000,
      receiptStore: store,
      originId: "test-msg-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    bus.ingestReply({ agent_id: "alpha", text: "reply", intent: "final" });
    await pending;
    // Wait for the receipt close fire-and-forget to flush to disk.
    for (let i = 0; i < 20 && readReceipts().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const recs = readReceipts();
    expect(recs).toHaveLength(1);
    expect(recs[0].final_state).toBe("turn_observed");
    expect(recs[0].agent_id).toBe("alpha");
    expect(recs[0].selected_route).toBe("agent=alpha");
    expect(recs[0].prompt_hash).toBe(hashPrompt("hello world"));
    expect(recs[0].message_id).toMatch(/^webui:test-msg-1:[0-9a-f]{8}$/);
    expect(typeof recs[0].duration_ms).toBe("number");
    expect(recs[0].notes).toMatchObject({ output_chars: 5, bus_send_ok: true });
  });

  it("closes a receipt as timeout when no final lands", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "stuck", {
      timeoutMs: 100,
      receiptStore: store,
    });
    await pending;
    for (let i = 0; i < 20 && readReceipts().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const recs = readReceipts();
    expect(recs).toHaveLength(1);
    expect(recs[0].final_state).toBe("timeout");
    expect(recs[0].notes?.timeout_ms).toBe(100);
  });

  it("indexes the open receipt by prompt_hash so the bus → PTY seam can patch", async () => {
    const bus = makeBus();
    const pending = streamBusPrompt(bus, "alpha", "lookup me", {
      timeoutMs: 1000,
      receiptStore: store,
    });
    await Promise.resolve();
    await Promise.resolve();
    // The receipt is open and indexed by hash — runtime-mount would find it here.
    const r = store.findByPromptHash(hashPrompt("lookup me"));
    expect(r).toBeDefined();
    expect(r?.record.agent_id).toBe("alpha");
    // Simulate the bus → PTY seam back-filling PID + generation.
    r?.patch({ process_pid: 12345, process_generation: 1 });
    bus.ingestReply({ agent_id: "alpha", text: "ok", intent: "final" });
    await pending;
    for (let i = 0; i < 20 && readReceipts().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const recs = readReceipts();
    expect(recs[0].process_pid).toBe(12345);
    expect(recs[0].process_generation).toBe(1);
    // After close, the hash index is cleared.
    expect(store.findByPromptHash(hashPrompt("lookup me"))).toBeUndefined();
  });
});
