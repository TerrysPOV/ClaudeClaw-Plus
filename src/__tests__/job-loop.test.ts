/**
 * The cron job loop: under `runtime: "bus"` a job runs once, not once from the
 * legacy 60 s loop and again as a prompt typed into the bus agent's session.
 * The loop keeps retry/retryDelay, timeoutSeconds, model, notify and the result
 * forwarding, and its results still reach Telegram/Discord under the bus.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusCore } from "../bus/core";
import { wireBusScheduler } from "../bus/scheduler-wiring";
import type { HeartbeatConfig } from "../config";
import { busSchedulerJobs, createJobLoop, type JobRunResult } from "../job-loop";
import { busJobRelay } from "../job-relay";
import type { Job } from "../jobs";
import { getTelegramOutbox, type OutboxChunk, TelegramOutbox } from "../telegram-outbox";

const START = Date.UTC(2026, 9, 7, 3, 0, 0); // a round minute
const flush = () => new Promise((r) => setTimeout(r, 0));
const START_TS = readFileSync(join(import.meta.dir, "..", "commands", "start.ts"), "utf8");

function job(over: Partial<Job>): Job {
  return {
    name: "j",
    schedule: "*/5 * * * *",
    prompt: "p",
    recurring: true,
    notify: true,
    ...over,
  };
}

interface RunCall {
  name: string;
  threadId: string;
  model: string | undefined;
  timeoutMs: number | undefined;
  agent: string | undefined;
}

interface LoopOpts {
  rateLimited?: boolean;
  busAgentIds?: () => readonly string[];
  hasLegacyPersona?: (agent: string) => Promise<boolean>;
  resolveJobModel?: (job: Job) => Promise<string | undefined>;
}

function loop(results: JobRunResult[] = [], opts: LoopOpts = {}) {
  let now = START;
  const runs: RunCall[] = [];
  const forwarded: { label: string; result: JobRunResult }[] = [];
  const warnings: string[] = [];
  const cleared: string[] = [];
  const logs: string[] = [];
  const l = createJobLoop({
    run: async (name, _prompt, threadId, model, timeoutMs, agent) => {
      runs.push({ name, threadId, model, timeoutMs, agent });
      return results.shift() ?? { exitCode: 0, stdout: "done", stderr: "" };
    },
    resolvePrompt: async (p) => p,
    resolveJobModel: opts.resolveJobModel ?? (async () => undefined),
    snapshotJobFrontmatter: async () => async () => false,
    clearJobSchedule: async (name) => {
      cleared.push(name);
    },
    forward: (label, result) => {
      forwarded.push({ label, result });
    },
    busAgentIds: opts.busAgentIds ?? (() => []),
    hasLegacyPersona: opts.hasLegacyPersona ?? (async () => false),
    isRateLimited: () => opts.rateLimited ?? false,
    timezoneOffsetMinutes: () => 0,
    now: () => now,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    logError: () => {},
  });
  return {
    l,
    runs,
    forwarded,
    warnings,
    cleared,
    logs,
    at: (ms: number) => {
      now = ms;
    },
  };
}

const HEARTBEAT: HeartbeatConfig = {
  enabled: false,
  interval: 15,
  prompt: "",
  excludeWindows: [],
  forwardToTelegram: false,
  forwardToDiscord: false,
};

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

describe("one runner per job under the bus runtime", () => {
  it("a due job runs once: the legacy loop runs it, the bus scheduler registers no trigger for it", async () => {
    const jobs = [job({ name: "daily" })];
    const legacy = loop();
    const bus = { sendPrompt: async () => ({ promise_id: "p" }) } as unknown as BusCore;
    // The two runners start.ts wires under `runtime: "bus"`, with the jobs it gives each.
    const handle = await wireBusScheduler({
      bus,
      defaultAgentId: "main",
      heartbeat: HEARTBEAT,
      jobs: busSchedulerJobs(jobs),
      logger: QUIET,
    });
    legacy.l.tick(jobs, new Date(START));
    await flush();

    const busCron = handle.scheduled.filter((s) => s.label.startsWith("cron:"));
    expect(legacy.runs.length + busCron.length).toBe(1);
    expect(legacy.runs.map((r) => r.name)).toEqual(["daily"]);
    await handle.stop();
  });

  it("the heartbeat stays on the bus scheduler", async () => {
    const bus = { sendPrompt: async () => ({ promise_id: "p" }) } as unknown as BusCore;
    const handle = await wireBusScheduler({
      bus,
      defaultAgentId: "main",
      heartbeat: { ...HEARTBEAT, enabled: true, prompt: "hb" },
      jobs: busSchedulerJobs([job({ name: "daily" })]),
      logger: QUIET,
    });
    expect(handle.scheduled.map((s) => s.label)).toEqual(["heartbeat"]);
    await handle.stop();
  });

  it("start.ts hands the bus scheduler busSchedulerJobs() at boot and on hot-reload", () => {
    const calls = START_TS.split("wireBusScheduler({").slice(1);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const jobsLine = call.split("\n").find((l) => l.trim().startsWith("jobs:"));
      expect(jobsLine?.trim()).toMatch(/^jobs: busSchedulerJobs\(/);
    }
  });

  it("the 60 s loop is not behind skipLegacyAdapters: it is the job runner under the bus too", () => {
    const tick = START_TS.indexOf("jobLoop.tick(currentJobs)");
    expect(tick).toBeGreaterThan(0);
    const interval = START_TS.lastIndexOf("setInterval(", tick);
    expect(START_TS.slice(interval, tick)).not.toContain("skipLegacyAdapters");
  });
});

describe("job loop (unchanged outside the bus)", () => {
  it("runs a job whose schedule matches, and only that one", async () => {
    const t = loop();
    t.l.tick(
      [job({ name: "due" }), job({ name: "later", schedule: "7 * * * *" })],
      new Date(START),
    );
    await flush();
    expect(t.runs.map((r) => r.name)).toEqual(["due"]);
    expect(t.l.lastResult.get("due")?.result).toBe("ok");
  });

  it("rate-limited: nothing runs, the due job is recorded as skipped", async () => {
    const t = loop([], { rateLimited: true });
    t.l.tick([job({ name: "due" })], new Date(START));
    await flush();
    expect(t.runs).toEqual([]);
    expect(t.l.lastResult.get("due")?.result).toBe("skipped");
  });

  it("an agent job runs in the agent's thread", async () => {
    const t = loop();
    await t.l.runJob(job({ name: "reg/daily", agent: "reg", label: "daily" }));
    expect(t.runs[0]).toMatchObject({ threadId: "agent:reg", agent: "reg" });
  });
});

describe("job fields the loop applies", () => {
  it("retry / retryDelay: a failure is retried after retryDelay, then given up", async () => {
    const fail = { exitCode: 1, stdout: "", stderr: "boom" };
    const t = loop([fail, fail]);
    const j = job({ name: "r", schedule: "0 0 1 1 *", retry: 1, retryDelay: 60 });
    await t.l.runJob(j);
    expect(t.l.retryState.get("r")).toEqual({ failCount: 1, retryAt: START + 60_000 });

    t.at(START + 30_000);
    t.l.tick([j], new Date(START + 30_000));
    await flush();
    expect(t.runs.length).toBe(1);

    t.at(START + 60_000);
    t.l.tick([j], new Date(START + 60_000));
    await flush();
    await flush();
    expect(t.runs.length).toBe(2);
    expect(t.l.retryState.has("r")).toBe(false);
  });

  it("a retry in flight is not fired again by the next tick", async () => {
    const t = loop([{ exitCode: 1, stdout: "", stderr: "" }]);
    const j = job({ name: "r", schedule: "0 0 1 1 *", retry: 2, retryDelay: 1 });
    await t.l.runJob(j);
    t.at(START + 1_000);
    t.l.tick([j], new Date(START + 1_000));
    t.l.tick([j], new Date(START + 1_000));
    await flush();
    expect(t.runs.length).toBe(2);
  });

  it("retryDelay defaults to 300 s", async () => {
    const t = loop([{ exitCode: 1, stdout: "", stderr: "" }]);
    await t.l.runJob(job({ name: "r", retry: 1 }));
    expect(t.l.retryState.get("r")?.retryAt).toBe(START + 300_000);
  });

  it("timeoutSeconds becomes the run's timeout", async () => {
    const t = loop();
    await t.l.runJob(job({ timeoutSeconds: 90 }));
    expect(t.runs[0].timeoutMs).toBe(90_000);
  });

  it("model: the resolved model wins, the frontmatter model is the fallback", async () => {
    const t = loop();
    await t.l.runJob(job({ model: "haiku" }));
    expect(t.runs[0].model).toBe("haiku");
    const r = loop([], { resolveJobModel: async () => "opus" });
    await r.l.runJob(job({ model: "haiku" }));
    expect(r.runs[0].model).toBe("opus");
  });

  it("notify: true forwards every result, labelled with the job (agent: label for agent jobs)", async () => {
    const t = loop();
    await t.l.runJob(job({ name: "plain" }));
    await t.l.runJob(job({ name: "reg/daily", agent: "reg", label: "daily" }));
    expect(t.forwarded.map((f) => f.label)).toEqual(["plain", "reg: daily"]);
  });

  it("notify: false forwards nothing", async () => {
    const t = loop();
    await t.l.runJob(job({ notify: false }));
    expect(t.forwarded).toEqual([]);
  });

  it('notify: "error" forwards failures only', async () => {
    const t = loop([
      { exitCode: 0, stdout: "ok", stderr: "" },
      { exitCode: 2, stdout: "", stderr: "x" },
    ]);
    await t.l.runJob(job({ notify: "error" }));
    await t.l.runJob(job({ notify: "error" }));
    expect(t.forwarded.map((f) => f.result.exitCode)).toEqual([2]);
  });

  it("a one-time job clears its schedule, unless a retry is pending", async () => {
    const fail = { exitCode: 1, stdout: "", stderr: "" };
    const t = loop([fail, fail]);
    await t.l.runJob(job({ name: "once", recurring: false }));
    await t.l.runJob(job({ name: "once-retry", recurring: false, retry: 1 }));
    expect(t.cleared).toEqual(["once"]);
  });
});

describe("#562 round 9 add-on: cron does not retry a PTY turn that may have completed", () => {
  const cases = [
    ["uncertain", "uncertain"],
    ["timeout", "timed out"],
  ] as const;
  for (const [failureKind, words] of cases) {
    it(`${failureKind}: retry: 2 is not used, the failure is forwarded, a one-time job's schedule is cleared`, async () => {
      // Fault: ignore failureKind in the loop and retryState gets { failCount: 1 }, the
      // schedule is kept for the pending retry, and no "not retried" line is logged.
      const failed = {
        exitCode: failureKind === "timeout" ? 124 : 1,
        stdout: "",
        stderr: "x",
        failureKind,
      };
      const t = loop([failed, failed]);
      await t.l.runJob(job({ name: "once", recurring: false, retry: 2 }));
      expect(t.l.retryState.has("once")).toBe(false);
      expect(t.cleared).toEqual(["once"]);
      expect(t.forwarded.map((f) => f.result.exitCode)).toEqual([failed.exitCode]);
      expect(
        t.logs.some((l) =>
          l.endsWith(`Job once not retried: PTY turn ${words}, it may have completed`),
        ),
      ).toBe(true);
      expect(t.l.lastResult.get("once")?.result).toBe("error");
    });
  }

  it("a recurring job keeps no retry debt and runs again only on its schedule", async () => {
    const failed = { exitCode: 1, stdout: "", stderr: "", failureKind: "uncertain" as const };
    const t = loop([failed, failed]);
    const j = job({ name: "r", schedule: "0 0 1 1 *", retry: 2, retryDelay: 1 });
    await t.l.runJob(j);
    t.at(START + 5_000);
    t.l.tick([j], new Date(START + 5_000));
    await flush();
    expect(t.runs.length).toBe(1);
  });

  it("a definite PTY failure (no failureKind) still retries as configured", async () => {
    const fail = { exitCode: 1, stdout: "", stderr: "[pty-supervisor] PTY closed during turn" };
    const t = loop([fail]);
    await t.l.runJob(job({ name: "once-retry", recurring: false, retry: 2, retryDelay: 60 }));
    expect(t.l.retryState.get("once-retry")).toEqual({ failCount: 1, retryAt: START + 60_000 });
    expect(t.cleared).toEqual([]);
    expect(t.logs.some((l) => l.includes("not retried"))).toBe(false);
  });

  it("a timeout exit code (124) without failureKind is not PTY-specific and still retries", async () => {
    const t = loop([{ exitCode: 124, stdout: "", stderr: "timed out" }]);
    await t.l.runJob(job({ name: "r", retry: 1 }));
    expect(t.l.retryState.get("r")?.failCount).toBe(1);
  });
});

describe("job.agent naming a bus-only agent", () => {
  it("warns when job.agent is a bus agent with no legacy persona, once per job, and still runs it", async () => {
    const t = loop([], { busAgentIds: () => ["ops"] });
    const j = job({ name: "nightly", agent: "ops" });
    await t.l.runJob(j);
    await t.l.runJob(j);
    expect(t.runs.length).toBe(2);
    expect(t.warnings.length).toBe(1);
    expect(t.warnings[0]).toContain('agent "ops" is a bus agent');
    expect(t.warnings[0]).toContain("the default model");
  });

  it("no warning for a legacy agent with a persona, a non-bus agent, or a job without an agent", async () => {
    const t = loop([], { busAgentIds: () => ["ops"], hasLegacyPersona: async () => true });
    await t.l.runJob(job({ agent: "ops" }));
    const u = loop([], { busAgentIds: () => ["ops"] });
    await u.l.runJob(job({ agent: "reg" }));
    await u.l.runJob(job({}));
    expect([...t.warnings, ...u.warnings]).toEqual([]);
  });

  it("the warning names the model the job will actually run on", async () => {
    const t = loop([], { busAgentIds: () => ["ops"] });
    await t.l.runJob(job({ agent: "ops", model: "haiku" }));
    expect(t.warnings[0]).toContain('model "haiku"');
  });

  it("start.ts gives the loop the bus agent ids only while the bus runtime is mounted", () => {
    expect(START_TS).toMatch(
      /busAgentIds: \(\) => \(busRuntimeHandle \? currentSettings\.agents\.map\(\(a\) => a\.id\) : \[\]\)/,
    );
  });
});

describe("job results reach Telegram/Discord under the bus runtime", () => {
  it("Telegram: send-only sender with the configured token, no polling", async () => {
    const sent: { token: string; chatId: number; text: string }[] = [];
    const dir = mkdtempSync(join(tmpdir(), "job-relay-"));
    const relay = await busJobRelay({
      telegramToken: "tg",
      discordToken: "",
      telegramSend: async (token, chatId, text) => {
        sent.push({ token, chatId, text });
      },
      outbox: new TelegramOutbox({ path: join(dir, "outbox.json"), send: async () => {} }),
    });
    rmSync(dir, { recursive: true, force: true });
    expect(relay.discordSendToUser).toBeNull();
    await relay.telegramSend?.(42, "[daily]\ndone");
    expect(sent).toEqual([{ token: "tg", chatId: 42, text: "[daily]\ndone" }]);
  });

  // #512: job results under the bus go through the durable outbox, like the
  // legacy runtime's: a failed send is retried, quiet hours hold it.
  describe("Telegram job results through the outbox", () => {
    let dir = "";
    const quietAllDay = { windows: [{ start: "00:00", end: "23:59" }], urgentBypass: false };
    const make = (send: (chatId: number, chunk: OutboxChunk) => Promise<void>, now = START) => {
      dir = mkdtempSync(join(tmpdir(), "job-relay-"));
      return new TelegramOutbox({
        path: join(dir, "outbox.json"),
        send,
        now: () => now,
        logger: { info() {}, warn() {}, error() {} },
      });
    };
    const relayWith = (outbox: TelegramOutbox, quiet?: typeof quietAllDay) =>
      busJobRelay({
        telegramToken: "tg",
        discordToken: "",
        telegramSend: async () => {},
        outbox,
        quietHours: () => (quiet ? { ...quiet, timezoneOffsetMinutes: 0 } : undefined),
      });

    it("delivers through the outbox when it is not quiet", async () => {
      const sent: string[] = [];
      const outbox = make(async (chatId, chunk) => void sent.push(`${chatId}|${chunk.text}`));
      const relay = await relayWith(outbox);
      expect(await relay.telegramDeliver?.(42, "done", "daily")).toBe(true);
      expect(sent).toEqual(["42|done"]);
      outbox.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("queues a failed send for retry instead of dropping it", async () => {
      const outbox = make(async () => {
        throw new Error("Telegram API sendMessage: 502 Bad Gateway");
      });
      const relay = await relayWith(outbox);
      expect(await relay.telegramDeliver?.(42, "done", "daily")).toBe(false);
      expect(outbox.list()).toHaveLength(1);
      expect(outbox.list()[0].label).toBe("daily");
      outbox.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("holds a job result during quiet hours", async () => {
      const sent: string[] = [];
      const outbox = make(async (_c, chunk) => void sent.push(chunk.text));
      const relay = await relayWith(outbox, quietAllDay);
      expect(await relay.telegramDeliver?.(42, "done", "daily")).toBe(false);
      expect(sent).toEqual([]);
      expect(outbox.list()[0].heldAt).toBe(START);
      outbox.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("a held job result is not delivered to a user removed meanwhile (#525)", async () => {
      const sent: string[] = [];
      const outbox = make(async (chatId, chunk) => void sent.push(`${chatId}|${chunk.text}`));
      // Replaced, not mutated: a settings reload hands the getter a new object.
      let live = { allowedUserIds: [42, 7] };
      const relay = await busJobRelay({
        telegramToken: "tg",
        discordToken: "",
        telegramSend: async () => {},
        outbox,
        quietHours: () => ({ ...quietAllDay, timezoneOffsetMinutes: 0 }),
        telegramAllowlist: () => live,
      });
      expect(await relay.telegramDeliver?.(42, "for 42", "daily")).toBe(false);
      expect(await relay.telegramDeliver?.(7, "for 7", "daily")).toBe(false);
      expect(outbox.list().map((e) => [e.chatId, e.userId])).toEqual([
        [42, 42],
        [7, 7],
      ]);

      live = { allowedUserIds: [7] };
      outbox.setQuietHours(null);
      await outbox.drain(START);
      expect(sent).toEqual(["7|for 7"]);
      expect(outbox.list()).toHaveLength(0);
      outbox.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("start.ts hands busJobRelay the live Telegram allow-list (#525)", () => {
      expect(START_TS).toMatch(
        /await busJobRelay\(\{[^}]*telegramAllowlist: \(\) => currentSettings\.telegram,/,
      );
    });

    it("keeps the sender of the outbox the Telegram adapter already opened", async () => {
      dir = mkdtempSync(join(tmpdir(), "job-relay-"));
      const path = join(dir, "outbox.json");
      const viaAdapter: string[] = [];
      const shared = getTelegramOutbox(
        path,
        async (_c, chunk) => void viaAdapter.push(chunk.text),
        {
          info() {},
          warn() {},
          error() {},
        },
      );
      const relay = await busJobRelay({
        telegramToken: "tg",
        discordToken: "",
        telegramSend: async () => {},
        outboxPath: path,
      });
      expect(await relay.telegramDeliver?.(42, "done", "daily")).toBe(true);
      expect(viaAdapter).toEqual(["done"]);
      shared.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("start.ts takes the outbox sender from busJobRelay, with the quiet hours", () => {
      expect(START_TS).toMatch(
        /\(\{ telegramSend, telegramDeliver, discordSendToUser \} = await busJobRelay\(\{[^}]*quietHours: \(\) => quietHoursFrom\(currentSettings\)/,
      );
    });
  });

  it("Discord: a job result is sent as a DM with the configured token", async () => {
    const sent: string[] = [];
    const relay = await busJobRelay({
      telegramToken: "",
      discordToken: "dc",
      discordSend: async (token, userId, text) => {
        sent.push(`${token}|${userId}|${text}`);
      },
    });
    expect(relay.telegramSend).toBeNull();
    await relay.discordSendToUser?.("u1", "hi");
    expect(sent).toEqual(["dc|u1|hi"]);
  });

  it("start.ts sets the job senders from busJobRelay once the bus adapters are attached", () => {
    const attach = START_TS.indexOf("busRuntimeHandle.attachAdapters(adapters)");
    const relay = START_TS.indexOf("await busJobRelay(");
    const scheduler = START_TS.indexOf("wireBusScheduler({");
    expect(attach).toBeGreaterThan(0);
    expect(relay).toBeGreaterThan(attach);
    expect(relay).toBeLessThan(scheduler);
  });
});

describe("Bus staging guide", () => {
  it("does not tell operators to route cron work with job.agent", () => {
    const guide = readFileSync(
      join(import.meta.dir, "..", "..", "docs", "Bus_Runtime_Staging_Guide.md"),
      "utf8",
    );
    expect(guide).not.toContain('job.agent: "cron-haiku"');
    expect(guide).not.toContain("Per-job model / timeout overrides not honoured");
  });
});
