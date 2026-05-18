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

  it("stop() is idempotent — second call is a no-op (handle-level dedupe)", async () => {
    // Sprint 5.2a tightened the idempotency guard: the handle now tracks
    // a `stopped` flag so a second stop() call returns immediately
    // without re-stopping agents or the bus. This protects against
    // double-stop noise in shutdown paths (SIGTERM + SIGINT racing).
    const bus = createFakeBus();
    const sm = new SessionManager();
    const h = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });
    await h.stop();
    await h.stop();
    expect(bus.stopCalls()).toBe(1);
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

/* ────────────────────────────────────────────────────────────────────── */
/* Auto-spawn (Sprint 5.2a)                                                */
/* ────────────────────────────────────────────────────────────────────── */

import type { AgentConfig, BusOrigin } from "../types";
import type { AgentProcess } from "../session-agent-process";

interface FakeSessionManagerOptions {
  /** Index (0-based) at which spawnAgent should throw. */
  failSpawnAtIndex?: number;
}

interface FakeAgentRecord {
  config: AgentConfig;
  origin: BusOrigin;
  stopped: boolean;
}

class FakeSessionManager extends SessionManager {
  public readonly spawnLog: FakeAgentRecord[] = [];
  public readonly stopLog: string[] = [];
  private spawnIndex = 0;
  constructor(private fakeOpts: FakeSessionManagerOptions = {}) {
    super();
  }
  async spawnAgent(agent: AgentConfig, origin: BusOrigin): Promise<AgentProcess> {
    const i = this.spawnIndex++;
    if (this.fakeOpts.failSpawnAtIndex === i) {
      throw new Error(`fake spawn failure at index ${i}`);
    }
    const record: FakeAgentRecord = { config: agent, origin, stopped: false };
    this.spawnLog.push(record);
    return {
      onData: () => () => {},
      onExit: () => () => {},
      send_prompt: async () => {},
      send_slash: async () => {},
      kill: async () => {},
    } as unknown as AgentProcess;
  }
  async stop(agent_id: string): Promise<void> {
    this.stopLog.push(agent_id);
    const rec = this.spawnLog.find((r) => r.config.id === agent_id);
    if (rec) rec.stopped = true;
  }
  getAgent(): undefined {
    return undefined;
  }
}

function cfg(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    cwd: "/tmp/proj",
    session_id: `sess-${id}`,
    permission_mode: "plan",
    ...overrides,
  };
}

describe("mountBusRuntime — auto-spawn happy path", () => {
  let handle: BusRuntimeHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it("spawns every declared agent in order and reports them on the handle", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      agents: [cfg("triage"), cfg("research"), cfg("ops")],
      logger: SILENT_LOGGER,
    });
    expect(sm.spawnLog.map((r) => r.config.id)).toEqual(["triage", "research", "ops"]);
    expect(handle.spawnedAgentIds).toEqual(["triage", "research", "ops"]);
  });

  it("defaults spawnOrigin to 'cli' — a real BusOrigin (Codex P1 fold-in from PR #122)", async () => {
    // PR #122 Codex review caught that the previous default "system" is
    // NOT a valid BusOrigin. Beyond the type lie, it also broke the
    // channel-notification path because `defaultSupervisionFor` falls
    // through to `process-stream-json` for unknown origins. We now
    // default to "cli" (valid BusOrigin) AND default `supervision:
    // "pty-stdin"` at resolve time so the picker is origin-independent.
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      agents: [cfg("triage")],
      logger: SILENT_LOGGER,
    });
    expect(sm.spawnLog[0]?.origin).toBe("cli");
  });

  it("honours spawnOrigin override", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      agents: [cfg("discord-agent")],
      spawnOrigin: "discord",
      logger: SILENT_LOGGER,
    });
    expect(sm.spawnLog[0]?.origin).toBe("discord");
  });

  it("scaffold mode (no agents) leaves spawnedAgentIds empty", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    handle = await mountBusRuntime({ bus, sessionManager: sm, logger: SILENT_LOGGER });
    expect(handle.spawnedAgentIds).toEqual([]);
    expect(sm.spawnLog).toEqual([]);
  });
});

describe("mountBusRuntime — auto-spawn rollback", () => {
  it("stops successfully-spawned agents in reverse order when a later spawn throws", async () => {
    const bus = createFakeBus();
    // Fail the THIRD spawn — agents 0 + 1 should be stopped on the way out.
    const sm = new FakeSessionManager({ failSpawnAtIndex: 2 });
    await expect(
      mountBusRuntime({
        bus,
        sessionManager: sm,
        agents: [cfg("a"), cfg("b"), cfg("c"), cfg("d")],
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/failed to spawn agent="c"/);
    // Rollback order is reverse-construction.
    expect(sm.stopLog).toEqual(["b", "a"]);
    // Bus was started, then torn down via the outer catch.
    expect(bus.startCalls()).toBe(1);
    expect(bus.stopCalls()).toBe(1);
  });

  it("does not call sessionManager.stop when the first spawn fails immediately", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager({ failSpawnAtIndex: 0 });
    await expect(
      mountBusRuntime({
        bus,
        sessionManager: sm,
        agents: [cfg("only")],
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/failed to spawn agent="only"/);
    expect(sm.stopLog).toEqual([]);
    // Bus still has to be stopped — it was started before the spawn loop.
    expect(bus.stopCalls()).toBe(1);
  });
});

describe("mountBusRuntime — stop() with agents", () => {
  it("stops every spawned agent in reverse order before bus.stop", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    const h = await mountBusRuntime({
      bus,
      sessionManager: sm,
      agents: [cfg("a"), cfg("b"), cfg("c")],
      logger: SILENT_LOGGER,
    });
    await h.stop();
    expect(sm.stopLog).toEqual(["c", "b", "a"]);
    expect(bus.stopCalls()).toBe(1);
  });

  it("stop() is idempotent — second call is a no-op", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    const h = await mountBusRuntime({
      bus,
      sessionManager: sm,
      agents: [cfg("a")],
      logger: SILENT_LOGGER,
    });
    await h.stop();
    await h.stop();
    expect(sm.stopLog).toEqual(["a"]); // stopped exactly once
    expect(bus.stopCalls()).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────── */
/* attachAdapters — PR #123 Codex P1+P2 fold-in                            */
/* ────────────────────────────────────────────────────────────────────── */

describe("mountBusRuntime — attachAdapters", () => {
  it("attached adapters are stopped on handle.stop in reverse registration order", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    const stopOrder: string[] = [];
    const mk = (name: "discord" | "telegram" | "slack" | "webui") => ({
      name,
      stop: async () => {
        stopOrder.push(name);
      },
    });
    const handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      logger: SILENT_LOGGER,
    });
    handle.attachAdapters([mk("discord"), mk("telegram")]);
    handle.attachAdapters([mk("slack")]);
    expect(handle.mountedAdapterNames).toEqual(["discord", "telegram", "slack"]);
    await handle.stop();
    // Reverse registration order: slack first, then telegram, then discord.
    expect(stopOrder).toEqual(["slack", "telegram", "discord"]);
  });

  it("mixes opts.adapters with attachAdapters cleanly", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    const stopOrder: string[] = [];
    const mk = (name: "discord" | "telegram" | "slack" | "webui") => ({
      name,
      stop: async () => {
        stopOrder.push(name);
      },
    });
    const handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      adapters: [mk("discord")],
      logger: SILENT_LOGGER,
    });
    handle.attachAdapters([mk("telegram")]);
    expect(handle.mountedAdapterNames).toEqual(["discord", "telegram"]);
    await handle.stop();
    expect(stopOrder).toEqual(["telegram", "discord"]);
  });

  it("attachAdapters after stop() schedules teardown so adapters don't leak", async () => {
    const bus = createFakeBus();
    const sm = new FakeSessionManager();
    const stopped: string[] = [];
    const mk = (name: "discord" | "telegram" | "slack" | "webui") => ({
      name,
      stop: async () => {
        stopped.push(name);
      },
    });
    const handle = await mountBusRuntime({
      bus,
      sessionManager: sm,
      logger: SILENT_LOGGER,
    });
    await handle.stop();
    // Now attach AFTER stop — the handle isn't tracking lifecycles
    // anymore, but it must still avoid leaking the late adapter.
    handle.attachAdapters([mk("discord"), mk("telegram")]);
    // Stop is scheduled on microtask queue; flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped.sort()).toEqual(["discord", "telegram"]);
  });
});
