/**
 * Daemon shutdown order (#549): drain -> memory save -> teardown -> bus stop -> finalize,
 * and a second SIGTERM aborting the save as it aborts the drain.
 */
import { describe, expect, it } from "bun:test";
import {
  createShutdownController,
  runShutdownSequence,
  type ShutdownSteps,
} from "../commands/shutdown-sequence";
import type { LiveSendResult } from "../runner/pty-supervisor";
import { saveMemoryAtShutdown } from "../shutdown-memory-save";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function steps(events: string[], over: Partial<ShutdownSteps> = {}): ShutdownSteps {
  const step = (name: string) => async () => {
    events.push(name);
  };
  return {
    drain: step("drain"),
    saveMemory: step("save"),
    teardown: step("teardown"),
    stopBus: step("bus.stop"),
    finalize: step("finalize"),
    onStepError: (name) => events.push(`error:${name}`),
    ...over,
  };
}

describe("runShutdownSequence", () => {
  it("runs drain, then save, then teardown, then bus stop, then finalize", async () => {
    const events: string[] = [];
    await runShutdownSequence(steps(events));
    expect(events).toEqual(["drain", "save", "teardown", "bus.stop", "finalize"]);
  });

  it("issues save requests only after the drain resolves, and the bus stops only after the save", async () => {
    const events: string[] = [];
    const drainGate = deferred();
    const saveGate = deferred();
    const running = runShutdownSequence(
      steps(events, {
        drain: async () => {
          events.push("drain.start");
          await drainGate.promise;
          events.push("drain.end");
        },
        saveMemory: async () => {
          events.push("save.start");
          await saveGate.promise;
          events.push("save.end");
        },
      }),
    );
    await Bun.sleep(10);
    expect(events).toEqual(["drain.start"]); // no save request while the drain runs

    drainGate.resolve();
    await Bun.sleep(10);
    expect(events).toEqual(["drain.start", "drain.end", "save.start"]); // bus still up

    saveGate.resolve();
    await running;
    expect(events).toEqual([
      "drain.start",
      "drain.end",
      "save.start",
      "save.end",
      "teardown",
      "bus.stop",
      "finalize",
    ]);
  });

  it("a failing drain or save never prevents the teardown", async () => {
    const events: string[] = [];
    await runShutdownSequence(
      steps(events, {
        drain: async () => {
          throw new Error("drain boom");
        },
        saveMemory: async () => {
          throw new Error("save boom");
        },
      }),
    );
    expect(events).toEqual(["error:drain", "error:saveMemory", "teardown", "bus.stop", "finalize"]);
  });
});

describe("createShutdownController", () => {
  it("the first request starts the shutdown, every later one aborts it", () => {
    const ctl = createShutdownController();
    expect(ctl.aborted).toBe(false);
    expect(ctl.request()).toBe("start");
    expect(ctl.aborted).toBe(false);
    expect(ctl.request()).toBe("abort");
    expect(ctl.aborted).toBe(true);
    expect(ctl.signal.aborted).toBe(true);
  });
});

describe("shutdown with the real memory save", () => {
  it("a second SIGTERM mid-save skips the remaining saves and the teardown still runs", async () => {
    const events: string[] = [];
    const ctl = createShutdownController();
    expect(ctl.request()).toBe("start"); // the first SIGTERM, as start.ts handles it
    const started: string[] = [];
    const send = (key: string, _t: string, o: { signal: AbortSignal }): Promise<LiveSendResult> =>
      new Promise((resolve) => {
        started.push(key);
        o.signal.addEventListener("abort", () =>
          resolve({ status: "failed", error: "aborted", timedOut: false, aborted: true }),
        );
      });

    const running = runShutdownSequence(
      steps(events, {
        saveMemory: async () => {
          await saveMemoryAtShutdown(10_000, {
            liveKeys: () => ["agent:a", "agent:b", "global"],
            memoryPathFor: (k) => `/mem/${k}`,
            send,
            signal: ctl.signal,
            concurrency: 1,
          });
          events.push("save.done");
        },
      }),
    );
    await Bun.sleep(10);
    expect(started).toEqual(["agent:a"]);

    expect(ctl.request()).toBe("abort"); // the second SIGTERM, mid-save
    await running;

    expect(started).toEqual(["agent:a"]); // b and global were never asked
    expect(events).toEqual(["drain", "save.done", "teardown", "bus.stop", "finalize"]);
  });
});
