import { describe, test, expect, beforeEach } from "bun:test";
import {
  initWatchdog,
  recordExecutionMetric,
  incrementToolCall,
  incrementTurnCount,
  checkLimits,
  handleTrigger,
  getActiveInvocation,
  getSessionActiveInvocations,
  clearInvocation,
  getWatchdogStats,
  configureWatchdog,
  getWatchdogConfig,
  resetWatchdog,
} from "../../governance/watchdog";
import { join } from "path";

const WATCHDOG_DIR = join(process.cwd(), ".claude", "claudeclaw", "watchdog");

describe("Watchdog", () => {
  beforeEach(async () => {
    resetWatchdog();

    // Clear watchdog directory for test isolation
    try {
      const { rm, readdir } = await import("fs/promises");
      const files = await readdir(WATCHDOG_DIR);
      for (const file of files) {
        if (file !== ".gitkeep") {
          await rm(join(WATCHDOG_DIR, file), { recursive: true, force: true });
        }
      }
    } catch {
      // Directory might not exist yet
    }

    await initWatchdog();

    // Configure with relaxed limits for testing
    configureWatchdog({
      limits: {
        maxToolCalls: 10,
        maxTurns: 5,
        maxRuntimeSeconds: 60,
        maxRepeatedTools: 3,
        repeatedToolThreshold: 2,
      },
      enabled: true,
    });
  });

  test("should initialize with config", async () => {
    const config = getWatchdogConfig();
    expect(config.enabled).toBe(true);
    expect(config.limits.maxToolCalls).toBe(10);
  });

  test("should configure watchdog limits", () => {
    configureWatchdog({
      limits: {
        maxToolCalls: 50,
        maxTurns: 20,
      },
    });

    const config = getWatchdogConfig();
    expect(config.limits.maxToolCalls).toBe(50);
    expect(config.limits.maxTurns).toBe(20);
  });

  test("should record execution metrics", async () => {
    const invocationId = "test-invocation-1";

    await recordExecutionMetric(
      {
        invocationId,
        sessionId: "test-session",
      },
      {
        toolCallCount: 5,
        turnCount: 2,
      },
    );

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics).not.toBeNull();
    expect(metrics!.toolCallCount).toBe(5);
    expect(metrics!.turnCount).toBe(2);
    expect(metrics!.invocationId).toBe(invocationId);
  });

  test("should increment tool call count", async () => {
    const invocationId = "test-invocation-2";

    await incrementToolCall(invocationId, "read_file", { path: "/tmp/test.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/test.txt" });
    await incrementToolCall(invocationId, "write_file", { path: "/tmp/output.txt" });

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics!.toolCallCount).toBe(3);
    expect(metrics!.toolCalls.length).toBe(3);
  });

  test("should increment turn count", async () => {
    const invocationId = "test-invocation-3";

    await incrementTurnCount(invocationId);
    await incrementTurnCount(invocationId);

    const metrics = await getActiveInvocation(invocationId);
    expect(metrics!.turnCount).toBe(2);
  });

  test("should return healthy when under limits", async () => {
    const invocationId = "test-invocation-healthy";

    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 3,
        turnCount: 2,
      },
    );

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("healthy");
    expect(decision.triggeredLimits.length).toBe(0);
  });

  test("should warn at 80% of tool call limit", async () => {
    const invocationId = "test-invocation-warn";

    // 8 out of 10 = 80%
    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 8,
        turnCount: 1,
      },
    );

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("warn");
    expect(decision.triggeredLimits.length).toBeGreaterThan(0);
  });

  test("should trigger suspend at tool call limit", async () => {
    const invocationId = "test-invocation-suspend";

    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 10, // At limit
        turnCount: 1,
      },
    );

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("suspend");
    expect(decision.triggeredLimits.some((l) => l.includes("maxToolCalls"))).toBe(true);
  });

  test("should detect repeated tool patterns", async () => {
    const invocationId = "test-invocation-repeat";

    // Make same tool call 3 times with same input
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });
    await incrementToolCall(invocationId, "read_file", { path: "/tmp/same.txt" });

    const decision = await checkLimits({ invocationId });

    expect(decision.state).toBe("suspend");
    expect(decision.triggeredLimits.some((l) => l.includes("Repeated"))).toBe(true);
  });

  test("should handle trigger for warn state", async () => {
    const invocationId = "test-invocation-warn-handle";

    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 8, // Warning level
      },
    );

    const decision = await checkLimits({ invocationId });
    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(["warning_logged", "no_action"]).toContain(result.action);
  });

  test("should handle trigger for suspend state", async () => {
    const invocationId = "test-invocation-suspend-handle";

    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 10, // At limit
      },
    );

    const decision = await checkLimits({ invocationId });
    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(["suspended", "paused"]).toContain(result.action);
  });

  test("should handle trigger for kill state", async () => {
    const invocationId = "test-invocation-kill";

    await recordExecutionMetric(
      {
        invocationId,
      },
      {
        toolCallCount: 100, // Way over
      },
    );

    const decision = await checkLimits({ invocationId });
    decision.state = "kill"; // Force kill state for testing

    const result = await handleTrigger({ invocationId }, decision);

    expect(result.success).toBe(true);
    expect(result.action).toBe("terminated");

    // Should be cleared from active invocations
    const metrics = await getActiveInvocation(invocationId);
    expect(metrics).toBeNull();
  });

  test("should get session active invocations", async () => {
    const sessionId = "test-session-watchdog";

    await recordExecutionMetric({ invocationId: "inv-1", sessionId }, { toolCallCount: 1 });
    await recordExecutionMetric({ invocationId: "inv-2", sessionId }, { toolCallCount: 2 });
    await recordExecutionMetric(
      { invocationId: "inv-3", sessionId: "other" },
      { toolCallCount: 3 },
    );

    const invocations = await getSessionActiveInvocations(sessionId);

    expect(invocations.length).toBe(2);
    expect(invocations.find((i) => i.invocationId === "inv-1")).toBeDefined();
    expect(invocations.find((i) => i.invocationId === "inv-2")).toBeDefined();
  });

  test("should clear invocation", async () => {
    const invocationId = "inv-to-clear";

    await recordExecutionMetric({ invocationId }, { toolCallCount: 5 });

    let metrics = await getActiveInvocation(invocationId);
    expect(metrics).not.toBeNull();

    await clearInvocation(invocationId);

    metrics = await getActiveInvocation(invocationId);
    expect(metrics).toBeNull();
  });

  test("clearInvocation is idempotent and a no-op on an unknown id (finally guard, #268)", async () => {
    // runner.ts now calls clearInvocation in a `finally` on EVERY exit path, so
    // it can fire on an id whose record was already removed or never created.
    await recordExecutionMetric({ invocationId: "inv-twice" }, { toolCallCount: 2 });
    await clearInvocation("inv-twice");
    expect(await getActiveInvocation("inv-twice")).toBeNull();

    // Second clear (e.g. a finally after an early return that already cleared) — no throw.
    await clearInvocation("inv-twice");

    // Clearing a never-seen id is a no-op and must not disturb other records.
    await recordExecutionMetric({ invocationId: "inv-keep" }, { toolCallCount: 1 });
    await clearInvocation("never-existed");
    expect(await getActiveInvocation("inv-keep")).not.toBeNull();
  });

  test("should get watchdog stats", async () => {
    await recordExecutionMetric({ invocationId: "stats-inv-1" }, { toolCallCount: 5 });
    await recordExecutionMetric({ invocationId: "stats-inv-2" }, { toolCallCount: 3 });

    // Trigger a watchdog decision to log an event
    await checkLimits({ invocationId: "stats-inv-1" });

    const stats = await getWatchdogStats();

    expect(stats.activeInvocations).toBe(2);
    expect(stats.config.enabled).toBe(true);
    expect(stats.eventsLogged).toBeGreaterThan(0);
  });

  test("should return healthy for unknown invocation", async () => {
    const decision = await checkLimits({ invocationId: "unknown-invocation" });

    expect(decision.state).toBe("healthy");
    expect(decision.reason).toContain("No execution metrics");
  });

  // ---- #268 lifecycle leak fix ----

  describe("#268 leak fix — populator short-circuit when disabled", () => {
    test("recordExecutionMetric is a no-op when enabled=false", async () => {
      configureWatchdog({ enabled: false });
      await recordExecutionMetric(
        { invocationId: "leak-test-record", sessionId: "s" },
        { toolCallCount: 7, turnCount: 3 },
      );
      const record = await getActiveInvocation("leak-test-record");
      expect(record).toBeNull();
    });

    test("incrementToolCall is a no-op when enabled=false", async () => {
      configureWatchdog({ enabled: false });
      await incrementToolCall("leak-test-tc", "bash", { cmd: "ls" });
      const record = await getActiveInvocation("leak-test-tc");
      expect(record).toBeNull();
    });

    test("incrementTurnCount is a no-op when enabled=false", async () => {
      configureWatchdog({ enabled: false });
      await incrementTurnCount("leak-test-turn");
      const record = await getActiveInvocation("leak-test-turn");
      expect(record).toBeNull();
    });

    test("populators resume writing once re-enabled", async () => {
      configureWatchdog({ enabled: false });
      await recordExecutionMetric(
        { invocationId: "leak-test-resume", sessionId: "s" },
        { toolCallCount: 1 },
      );
      expect(await getActiveInvocation("leak-test-resume")).toBeNull();

      configureWatchdog({ enabled: true });
      await recordExecutionMetric(
        { invocationId: "leak-test-resume", sessionId: "s" },
        { toolCallCount: 2 },
      );
      const record = await getActiveInvocation("leak-test-resume");
      expect(record).not.toBeNull();
      expect(record!.toolCallCount).toBe(2);
    });
  });

  describe("#268 leak fix — startup eviction of stale records", () => {
    test("initWatchdog evicts records older than 24h on load", async () => {
      // Seed a stale record on disk by writing the index directly.
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(WATCHDOG_DIR, { recursive: true });
      const indexPath = join(WATCHDOG_DIR, "watchdog-index.json");
      const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const fresh = new Date().toISOString();
      await writeFile(
        indexPath,
        JSON.stringify(
          {
            version: 1,
            activeInvocations: {
              "stale-rec": {
                invocationId: "stale-rec",
                toolCallCount: 0,
                turnCount: 0,
                toolCalls: [],
                startedAt: stale,
                lastActivityAt: stale,
              },
              "fresh-rec": {
                invocationId: "fresh-rec",
                toolCallCount: 0,
                turnCount: 0,
                toolCalls: [],
                startedAt: fresh,
                lastActivityAt: fresh,
              },
            },
            updatedAt: fresh,
          },
          null,
          2,
        ),
      );

      resetWatchdog();
      await initWatchdog();

      expect(await getActiveInvocation("stale-rec")).toBeNull();
      expect(await getActiveInvocation("fresh-rec")).not.toBeNull();
    });

    test("evicts a malformed lastActivityAt and respects the 24h boundary", async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir(WATCHDOG_DIR, { recursive: true });
      const indexPath = join(WATCHDOG_DIR, "watchdog-index.json");
      const fresh = new Date().toISOString();
      const justUnder = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      const mk = (id: string, last: string) => ({
        invocationId: id,
        toolCallCount: 0,
        turnCount: 0,
        toolCalls: [],
        startedAt: last,
        lastActivityAt: last,
      });
      await writeFile(
        indexPath,
        JSON.stringify(
          {
            version: 1,
            activeInvocations: {
              "nan-rec": { ...mk("nan-rec", fresh), lastActivityAt: "not-a-date" },
              "under-24h": mk("under-24h", justUnder),
            },
            updatedAt: fresh,
          },
          null,
          2,
        ),
      );

      resetWatchdog();
      await initWatchdog();

      expect(await getActiveInvocation("nan-rec")).toBeNull(); // malformed → evicted
      expect(await getActiveInvocation("under-24h")).not.toBeNull(); // ~23h → retained
    });
  });

  describe("#268 — checkLimits escalation + disabled-state cleanup", () => {
    test("a hard limit reached after a warning escalates to suspend (worstState fix)", async () => {
      configureWatchdog({
        limits: { maxToolCalls: 10, maxTurns: 5, maxRuntimeSeconds: 60 },
        enabled: true,
      });
      const invocationId = "escalation-rec";
      // 8/10 tool calls => warn (80%); 5/5 turns => hard suspend. The old guard
      // left worstState stuck at "warn"; it must now escalate to "suspend".
      await recordExecutionMetric({ invocationId }, { toolCallCount: 8, turnCount: 5 });

      const decision = await checkLimits({ invocationId });
      expect(decision.state).toBe("suspend");
    });

    test("clearInvocation purges a record created while enabled even after disabling", async () => {
      const invocationId = "clear-after-disable";
      await recordExecutionMetric({ invocationId }, { toolCallCount: 1 });
      expect(await getActiveInvocation(invocationId)).not.toBeNull();

      // Disable AFTER the record exists — clearInvocation must NOT be gated by
      // `enabled` (the runner's finally still has to purge it).
      configureWatchdog({ enabled: false });
      await clearInvocation(invocationId);
      expect(await getActiveInvocation(invocationId)).toBeNull();
    });
  });
});
