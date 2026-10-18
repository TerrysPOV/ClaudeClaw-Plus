/**
 * Daemon-side memory save at shutdown (#549): ask each live session to write its
 * memory, in the daemon, inside what is left of `shutdown.drainTurnsMs`.
 */
import { describe, expect, it } from "bun:test";
import type { LiveSendResult } from "../runner/pty-supervisor";
import {
  type MemorySaveDeps,
  memoryPathForSessionKey,
  saveMemoryAtShutdown,
} from "../shutdown-memory-save";

type Send = MemorySaveDeps["send"];

const sent = (text = "saved"): LiveSendResult => ({
  status: "sent",
  text,
  sessionId: "s",
  cleanBoundary: true,
});

function deps(over: Partial<MemorySaveDeps> & { keys: string[] }): MemorySaveDeps {
  const { keys, ...rest } = over;
  return {
    liveKeys: () => keys,
    memoryPathFor: (k) => (k === "global" || k.startsWith("agent:") ? `/mem/${k}.md` : null),
    send: async () => sent(),
    log: () => {},
    ...rest,
  };
}

describe("memoryPathForSessionKey", () => {
  it("maps global and agent keys to a memory file, and nothing else", () => {
    expect(memoryPathForSessionKey("global")).toMatch(/MEMORY\.md$/);
    expect(memoryPathForSessionKey("agent:suzy")).toMatch(/suzy.*MEMORY\.md$/);
    expect(memoryPathForSessionKey("thread:42")).toBeNull();
    expect(memoryPathForSessionKey("fallback:global")).toBeNull();
  });
});

describe("saveMemoryAtShutdown", () => {
  it("sends the save prompt, naming the memory file, to every global/agent live session", async () => {
    const calls: Array<{ key: string; text: string }> = [];
    const send: Send = async (key, text) => {
      calls.push({ key, text });
      return sent();
    };

    const out = await saveMemoryAtShutdown(
      10_000,
      deps({ keys: ["agent:suzy", "global", "thread:42", "fallback:global"], send }),
    );

    expect(calls.map((c) => c.key).sort()).toEqual(["agent:suzy", "global"]);
    expect(calls.find((c) => c.key === "global")?.text).toContain("/mem/global.md");
    expect(calls.find((c) => c.key === "agent:suzy")?.text).toContain("/mem/agent:suzy.md");
    expect(out.saved.sort()).toEqual(["agent:suzy", "global"]);
    expect(out.skipped.map((s) => s.key).sort()).toEqual(["fallback:global", "thread:42"]);
  });

  it("issues nothing when no time is left (drain used the whole budget, or drainTurnsMs is 0)", async () => {
    let called = 0;
    const out = await saveMemoryAtShutdown(
      0,
      deps({
        keys: ["global"],
        send: async () => {
          called++;
          return sent();
        },
      }),
    );

    expect(called).toBe(0);
    expect(out.saved).toEqual([]);
    expect(out.skipped).toEqual([
      { key: "global", reason: "no time left in shutdown.drainTurnsMs" },
    ]);
  });

  it("records not-live / failed / throwing sessions without throwing itself", async () => {
    const send: Send = async (key) => {
      if (key === "global") return { status: "not-live", reason: "no-process" };
      if (key === "agent:a")
        return { status: "failed", error: "boom", timedOut: false, aborted: false };
      throw new Error("kaboom");
    };

    const out = await saveMemoryAtShutdown(
      10_000,
      deps({ keys: ["global", "agent:a", "agent:b"], send }),
    );

    expect(out.saved).toEqual([]);
    expect(out.skipped).toEqual([{ key: "global", reason: "not-live: no-process" }]);
    expect(out.failed.map((f) => f.key).sort()).toEqual(["agent:a", "agent:b"]);
  });

  it("a second SIGTERM aborts the in-flight wait and never starts the remaining saves", async () => {
    const ac = new AbortController();
    const started: string[] = [];
    const send: Send = (key, _text, o) =>
      new Promise((resolve) => {
        started.push(key);
        // abort fires while the first save is in flight
        o.signal.addEventListener("abort", () =>
          resolve({ status: "failed", error: "aborted", timedOut: false, aborted: true }),
        );
        queueMicrotask(() => ac.abort());
      });

    const out = await saveMemoryAtShutdown(
      10_000,
      deps({ keys: ["agent:a", "agent:b", "global"], send, signal: ac.signal, concurrency: 1 }),
    );

    expect(started).toEqual(["agent:a"]);
    expect(out.aborted).toBe(true);
    expect(out.skipped.map((s) => s.key).sort()).toEqual(["agent:b", "global"]);
  });

  it("stops waiting at the budget and aborts the sends it still has in flight", async () => {
    let sawAbort = false;
    const send: Send = (_k, _t, o) =>
      new Promise((resolve) => {
        o.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve({ status: "failed", error: "aborted", timedOut: false, aborted: true });
        });
      });

    const t0 = performance.now();
    const out = await saveMemoryAtShutdown(60, deps({ keys: ["global"], send }));

    expect(performance.now() - t0).toBeLessThan(1000);
    expect(sawAbort).toBe(true);
    expect(out.saved).toEqual([]);
    expect(out.failed.map((f) => f.key)).toEqual(["global"]);
  });

  it("passes each send only the time that is left, never more than the budget", async () => {
    const seen: number[] = [];
    const send: Send = async (_k, _t, o) => {
      seen.push(o.timeoutMs);
      return sent();
    };

    await saveMemoryAtShutdown(5_000, deps({ keys: ["global"], send }));

    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(5_000);
  });

  it("uses the fallback for the global session only when no live global session exists", async () => {
    let fallbackCalls = 0;
    const fallbackSave: NonNullable<MemorySaveDeps["fallbackSave"]> = async () => {
      fallbackCalls++;
      return "saved";
    };

    const none = await saveMemoryAtShutdown(10_000, deps({ keys: [], fallbackSave }));
    expect(fallbackCalls).toBe(1);
    expect(none.saved).toEqual(["global (one-shot)"]);

    await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], fallbackSave }));
    expect(fallbackCalls).toBe(1); // live global: the fallback would be a second writer
  });
});

describe("the global PTY disappears between the snapshot and the send (Codex P2)", () => {
  const countingFallback = () => {
    const calls: Array<{ timeoutMs: number }> = [];
    const fallbackSave: NonNullable<MemorySaveDeps["fallbackSave"]> = async (o) => {
      calls.push({ timeoutMs: o.timeoutMs });
      return "saved";
    };
    return { calls, fallbackSave };
  };

  it("snapshot has global, send says not-live -> the fallback runs exactly once", async () => {
    const { calls, fallbackSave } = countingFallback();
    const send: Send = async () => ({ status: "not-live", reason: "no-entry" });

    const out = await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], send, fallbackSave }));

    expect(calls.length).toBe(1);
    expect(out.saved).toEqual(["global (one-shot)"]);
    expect(out.skipped).toEqual([]); // not recorded as a lost save
    expect(out.failed).toEqual([]);
  });

  it("the fallback gets only the time that is left, never more than the budget", async () => {
    const { calls, fallbackSave } = countingFallback();
    const send: Send = async () => ({ status: "not-live", reason: "no-process" });

    await saveMemoryAtShutdown(5_000, deps({ keys: ["global"], send, fallbackSave }));

    expect(calls[0].timeoutMs).toBeGreaterThan(0);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("send says failed (the live turn was attempted) -> NO fallback: a process may still hold the session", async () => {
    const { calls, fallbackSave } = countingFallback();
    const send: Send = async () => ({
      status: "failed",
      error: "waited for the running turn",
      timedOut: true,
      aborted: false,
    });

    const out = await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], send, fallbackSave }));

    expect(calls.length).toBe(0);
    expect(out.failed.map((f) => f.key)).toEqual(["global"]);
    expect(out.saved).toEqual([]);
  });

  it("send says sent -> no fallback", async () => {
    const { calls, fallbackSave } = countingFallback();

    const out = await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], fallbackSave }));

    expect(calls.length).toBe(0);
    expect(out.saved).toEqual(["global"]);
  });

  it("an AGENT session that is not-live never uses the global fallback", async () => {
    const { calls, fallbackSave } = countingFallback();
    const send: Send = async (key) =>
      key === "agent:a" ? { status: "not-live", reason: "no-entry" } : sent();

    const out = await saveMemoryAtShutdown(
      10_000,
      deps({ keys: ["agent:a", "global"], send, fallbackSave }),
    );

    expect(calls.length).toBe(0);
    expect(out.skipped).toEqual([{ key: "agent:a", reason: "not-live: no-entry" }]);
  });

  it("not-live with no fallback available (bus runtime): recorded as skipped, as before", async () => {
    const send: Send = async () => ({ status: "not-live", reason: "no-entry" });

    const out = await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], send }));

    expect(out.skipped).toEqual([{ key: "global", reason: "not-live: no-entry" }]);
  });

  it("a fallback that fails is a failed save, and is not retried", async () => {
    let calls = 0;
    const fallbackSave: NonNullable<MemorySaveDeps["fallbackSave"]> = async () => {
      calls++;
      return "failed";
    };
    const send: Send = async () => ({ status: "not-live", reason: "no-entry" });

    const out = await saveMemoryAtShutdown(10_000, deps({ keys: ["global"], send, fallbackSave }));

    expect(calls).toBe(1);
    expect(out.failed.map((f) => f.key)).toEqual(["global (one-shot)"]);
  });
});
