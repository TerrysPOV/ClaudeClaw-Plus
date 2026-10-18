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

  it("records busy / failed / throwing sessions without throwing itself", async () => {
    const send: Send = async (key) => {
      if (key === "global") return { status: "not-live", reason: "busy" };
      if (key === "agent:a")
        return { status: "failed", error: "boom", timedOut: false, aborted: false };
      throw new Error("kaboom");
    };

    const out = await saveMemoryAtShutdown(
      10_000,
      deps({ keys: ["global", "agent:a", "agent:b"], send }),
    );

    expect(out.saved).toEqual([]);
    expect(out.skipped).toEqual([{ key: "global", reason: "not-live: busy" }]);
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
