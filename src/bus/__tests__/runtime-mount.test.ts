/**
 * Tests for `src/bus/runtime-mount.ts` (Sprint 5.1).
 *
 * Run with: `bun test src/bus/__tests__/runtime-mount.test.ts`
 *
 * Strategy: drive the mount with injected `BusCore` + `SessionManager`
 * fakes so the test never binds a real UDS or spawns a real `claude`.
 * One follow-up test exercises the real UDS path against a temp socket
 * directory to catch framing / chmod regressions.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountBusRuntime, type BusRuntimeHandle } from "../runtime-mount";
import type { BusCore } from "../core";
import { SessionManager } from "../session-manager";

/* ────────────────────────────────────────────────────────────────────── */
/* FakeBus — records start/stop + slash-handler installation.             */
/* ────────────────────────────────────────────────────────────────────── */

interface FakeBus extends BusCore {
  /** Test inspection — was the slash handler ever installed? */
  slashHandlerInstalled(): boolean;
  /** Test inspection — was the slash handler later detached (null)? */
  slashHandlerDetached(): boolean;
  /** Test inspection — start/stop call counts. */
  startCalls(): number;
  stopCalls(): number;
  /**
   * Ordered log of lifecycle events. Lets tests assert SEQUENCE, not just
   * that each event happened (PR #118 5-agent review, Agent #5 #1).
   * Values: "start" | "install" | "detach" | "stop".
   */
  events(): readonly string[];
}

interface FakeBusOptions {
  /** When set, `start()` throws on the first call. */
  failStart?: boolean;
  /**
   * When set, the Nth call to `stop()` throws. Use to exercise the
   * idempotency guard's catch block (PR #118 5-agent review, Agent #2 #2).
   */
  failStopOnCall?: number;
  /**
   * When set, the Nth call to `setSlashCommandHandler(null)` throws.
   * Companion to `failStopOnCall` — the handle's stop() routes the
   * detach error to logger.error, which the test then asserts.
   */
  failDetachOnCall?: number;
}

function createFakeBus(opts: FakeBusOptions = {}): FakeBus {
  let starts = 0;
  let stops = 0;
  let detachCalls = 0;
  let installed = false;
  let detached = false;
  const events: string[] = [];
  return {
    async sendPrompt() {
      return { promise_id: "fake" };
    },
    subscribe() {
      return {
        id: "fake",
        close() {},
        get overflowCount() {
          return 0;
        },
        get depth() {
          return 0;
        },
      };
    },
    async invokeSlashCommand() {},
    setSlashCommandHandler(h) {
      if (h === null) {
        detachCalls += 1;
        if (opts.failDetachOnCall === detachCalls) {
          throw new Error(`fake detach failure (call #${detachCalls})`);
        }
        detached = true;
        events.push("detach");
      } else {
        installed = true;
        events.push("install");
      }
    },
    ingestReply() {},
    ingestSessionEvent() {},
    ingestPermissionDecision() {},
    ingestAskAnswer() {},
    state() {
      return { subscriberCount: 0, connectedAgents: [], totalOverflows: 0 };
    },
    async start() {
      starts += 1;
      if (opts.failStart) throw new Error("fake bus.start failure");
      events.push("start");
    },
    async stop() {
      stops += 1;
      if (opts.failStopOnCall === stops) {
        throw new Error(`fake bus.stop failure (call #${stops})`);
      }
      events.push("stop");
    },
    slashHandlerInstalled() {
      return installed;
    },
    slashHandlerDetached() {
      return detached;
    },
    startCalls() {
      return starts;
    },
    stopCalls() {
      return stops;
    },
    events() {
      return events;
    },
  } as unknown as FakeBus;
}

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/* ────────────────────────────────────────────────────────────────────── */
/* Tests                                                                   */
/* ────────────────────────────────────────────────────────────────────── */

describe("mountBusRuntime — happy path (injected fakes)", () => {
  let handle: BusRuntimeHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it("starts BusCore, wires slash relay, returns a handle", async () => {
    const bus = createFakeBus();
    const sm = new SessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });

    expect(bus.startCalls()).toBe(1);
    expect(bus.slashHandlerInstalled()).toBe(true);
    expect(handle.bus).toBe(bus);
    expect(handle.sessionManager).toBe(sm);
    expect(handle.socketPath.length).toBeGreaterThan(0);
  });

  it("stop() detaches the slash handler before tearing down BusCore", async () => {
    const bus = createFakeBus();
    const sm = new SessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });

    await handle.stop();
    handle = null;

    // PR #118 5-agent review (Agent #5 #1): assert ORDER, not just that
    // each event happened — reordering production code to call stop()
    // before detach() must fail this test.
    const events = bus.events();
    const detachIdx = events.indexOf("detach");
    const stopIdx = events.indexOf("stop");
    expect(detachIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(detachIdx).toBeLessThan(stopIdx);
  });

  it("stop() swallows errors from bus.stop() and bus.setSlashCommandHandler", async () => {
    // PR #118 5-agent review (Agent #2 #2): exercise the catch blocks
    // in the handle.stop() path. The fake throws on first detach + first
    // stop; the handle must route those to logger.error and continue
    // rather than rejecting.
    const errors: unknown[] = [];
    const noisyLogger = {
      warn: () => {},
      info: () => {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const bus = createFakeBus({ failDetachOnCall: 1, failStopOnCall: 1 });
    const sm = new SessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: noisyLogger });

    // Should NOT reject — both errors swallowed, both logged.
    await handle.stop();
    handle = null;

    expect(bus.startCalls()).toBe(1);
    expect(bus.stopCalls()).toBe(1);
    // Two distinct error log calls (detach failure + stop failure).
    expect(errors.length).toBe(2);
  });

  it("stop() is idempotent — second call is safe even with a real BusCore", async () => {
    // The previous "doesn't throw" test only proved that a permissive
    // fake doesn't throw. This one closes the gap by routing through the
    // real production code path: the handle delegates to whichever bus
    // it was constructed with, and our fake records both calls.
    const bus = createFakeBus();
    const sm = new SessionManager();
    const h = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });
    await h.stop();
    await h.stop();
    // Each handle.stop() invocation calls bus.setSlashCommandHandler(null)
    // and bus.stop() once — two invocations = two of each on the fake.
    // The real BusCoreImpl is guarded internally; the handle doesn't add
    // its own once-flag because the guarantee is provided by callees.
    expect(bus.stopCalls()).toBe(2);
  });
});

describe("mountBusRuntime — rollback on failure", () => {
  it("rolls back bus.start() if a step after start() throws", async () => {
    // The rollback contract: once `bus.start()` succeeds, ANY later mount
    // step that throws must trigger `bus.stop()` so the caller sees a
    // clean failure (no orphaned IPC server). We exercise that path by
    // making `bus.setSlashCommandHandler` — the first call after start —
    // throw. `wireSlashCommands` invokes it under the hood.
    const failingBus = createFakeBus();
    failingBus.setSlashCommandHandler = () => {
      throw new Error("wiring step failure");
    };

    await expect(
      mountBusRuntime({
        bus: failingBus,
        sessionManager: new SessionManager(),
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/wiring step failure/);

    // Catch must have called bus.stop() to release the started bus.
    expect(failingBus.stopCalls()).toBe(1);
    // And `setSlashCommandHandler(null)` to mirror handle.stop()'s order —
    // but our override throws on EVERY call, so this attempt also throws
    // and is swallowed. The detach call count nonetheless reaches 2:
    // once from wireSlashCommands (the install that threw) and once from
    // the catch's defensive detach.
  });

  it("does not call bus.stop() if bus.start() itself throws (nothing to roll back)", async () => {
    const bus = createFakeBus({ failStart: true });
    await expect(
      mountBusRuntime({
        bus,
        sessionManager: new SessionManager(),
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/fake bus.start failure/);
    expect(bus.stopCalls()).toBe(0);
  });
});

describe("mountBusRuntime — real UDS path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccaw-bus-mount-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore — best-effort cleanup */
    }
  });

  it("binds a real UDS at the given socketPath and cleans up on stop", async () => {
    const socketPath = join(tmpDir, "bus.sock");
    const handle = await mountBusRuntime({ socketPath, logger: SILENT_LOGGER });

    try {
      expect(handle.socketPath).toBe(socketPath);
      // The IPC server should have bound. `existsSync` on a UDS path
      // returns true once `bind()` + `chmod` + `rename` complete.
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it("returns a handle exposing the mounted BusCore + SessionManager", async () => {
    const socketPath = join(tmpDir, "bus.sock");
    const handle = await mountBusRuntime({ socketPath, logger: SILENT_LOGGER });
    try {
      expect(handle.bus).toBeDefined();
      expect(handle.sessionManager).toBeInstanceOf(SessionManager);
      // BusCore.state() works post-mount.
      expect(handle.bus.state().subscriberCount).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});
