/**
 * Tests for `src/bus/scheduler-wiring.ts` (Sprint 5.2c).
 *
 * Strategy: stub `createBusScheduler` indirectly by spying on the
 * returned handle. The wiring is a thin glue layer between settings +
 * jobs and the `BusScheduler` interface, so we drive it with a fake
 * BusCore and assert on the schedule calls.
 */

import { describe, it, expect } from "bun:test";
import { wireBusScheduler } from "../scheduler-wiring";
import type { BusCore } from "../core";
import type { HeartbeatConfig } from "../../config";
import type { Job } from "../../jobs";

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/** Minimal BusCore stub — the wiring only constructs a scheduler against it. */
function stubBus(): BusCore {
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
    setSlashCommandHandler() {},
    ingestReply() {},
    ingestSessionEvent() {},
    ingestPermissionDecision() {},
    ingestAskAnswer() {},
    state() {
      return { subscriberCount: 0, connectedAgents: [], totalOverflows: 0 };
    },
    async start() {},
    async stop() {},
  } as unknown as BusCore;
}

function baseHeartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: false,
    forwardToDiscord: false,
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    name: over.name ?? "test-job",
    schedule: over.schedule ?? "*/5 * * * *",
    prompt: over.prompt ?? "do the thing",
    recurring: over.recurring ?? true,
    notify: over.notify ?? false,
    ...over,
  };
}

describe("wireBusScheduler — heartbeat", () => {
  it("schedules a heartbeat when enabled and a defaultAgentId is provided", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat({ enabled: true, interval: 15, prompt: "tick" }),
      jobs: [],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["heartbeat"]);
    await handle.stop();
  });

  it("skips the heartbeat when enabled but no defaultAgentId", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: null,
      heartbeat: baseHeartbeat({ enabled: true }),
      jobs: [],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled).toHaveLength(0);
    await handle.stop();
  });

  it("skips the heartbeat when not enabled", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat({ enabled: false }),
      jobs: [],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled).toHaveLength(0);
    await handle.stop();
  });

  it("schedules with shouldFire filter when excludeWindows are set (Sprint 5.2d)", async () => {
    // No more warning — `wireBusScheduler` now honours excludeWindows
    // via the scheduler's `shouldFire` filter. The log line includes
    // the window count so operators can confirm it's wired.
    const infos: string[] = [];
    const warnings: string[] = [];
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat({
        enabled: true,
        excludeWindows: [{ start: "22:00", end: "07:00" }],
      }),
      jobs: [],
      logger: {
        ...SILENT_LOGGER,
        warn: (m: string) => warnings.push(m),
        info: (m: string) => infos.push(m),
      },
    });
    expect(handle.scheduled).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(infos.some((m) => m.includes("exclusion window"))).toBe(true);
    await handle.stop();
  });
});

describe("wireBusScheduler — cron jobs", () => {
  it("schedules every enabled job against the resolved agent", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat(),
      jobs: [job({ name: "a", schedule: "0 9 * * *" }), job({ name: "b", schedule: "0 21 * * *" })],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["cron:a", "cron:b"]);
    await handle.stop();
  });

  it("respects job.enabled === false", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat(),
      jobs: [
        job({ name: "active", schedule: "*/10 * * * *", enabled: true }),
        job({ name: "off", schedule: "*/10 * * * *", enabled: false }),
      ],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["cron:active"]);
    await handle.stop();
  });

  it("agent override: job.agent wins over defaultAgentId", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat(),
      jobs: [job({ name: "research-only", schedule: "*/30 * * * *", agent: "research" })],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["cron:research-only"]);
    await handle.stop();
  });

  it("skips jobs with no explicit agent when defaultAgentId is null", async () => {
    const warnings: string[] = [];
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: null,
      heartbeat: baseHeartbeat(),
      jobs: [
        job({ name: "no-agent", schedule: "*/5 * * * *" }),
        job({ name: "explicit-agent", schedule: "*/5 * * * *", agent: "ops" }),
      ],
      logger: { ...SILENT_LOGGER, warn: (m: string) => warnings.push(m) },
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["cron:explicit-agent"]);
    expect(warnings.some((w) => w.includes("no-agent"))).toBe(true);
    await handle.stop();
  });

  it("logs but does not crash on an invalid cron expression", async () => {
    const warnings: string[] = [];
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat(),
      jobs: [
        job({ name: "ok", schedule: "*/5 * * * *" }),
        job({ name: "bad", schedule: "totally not a cron expression" }),
      ],
      logger: { ...SILENT_LOGGER, warn: (m: string) => warnings.push(m) },
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["cron:ok"]);
    expect(warnings.some((w) => w.includes('"bad"'))).toBe(true);
    await handle.stop();
  });
});

describe("wireBusScheduler — stop()", () => {
  it("cancels every trigger and stops the scheduler", async () => {
    const handle = await wireBusScheduler({
      bus: stubBus(),
      defaultAgentId: "triage",
      heartbeat: baseHeartbeat({ enabled: true }),
      jobs: [job({ name: "a", schedule: "0 9 * * *" })],
      logger: SILENT_LOGGER,
    });
    expect(handle.scheduled).toHaveLength(2); // heartbeat + 1 job
    await handle.stop();
    // After stop, scheduler is torn down — calling stop again is a no-op
    // (idempotent).
    await handle.stop();
  });
});
