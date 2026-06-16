import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initUsageTracker,
  recordInvocationStart,
  recordInvocationCompletion,
  recordInvocationFailure,
  recordInvocationKilled,
  getInvocation,
  getSessionUsage,
  getChannelUsage,
  getAggregates,
  getUsageStats,
  resetUsageTracker,
  extractTranscriptUsage,
} from "../../governance/usage-tracker";
import { join } from "path";
import { homedir } from "os";
import { mkdir, writeFile, rm } from "fs/promises";
import { randomUUID } from "crypto";

// The usage tracker uses .claude/claudeclaw/usage/ - clean this for test isolation
const USAGE_DIR = join(process.cwd(), ".claude", "claudeclaw", "usage");

describe("UsageTracker", () => {
  beforeEach(async () => {
    resetUsageTracker();
    // Clear usage data directory for test isolation
    try {
      const { rm, readdir } = await import("fs/promises");
      const files = await readdir(USAGE_DIR);
      for (const file of files) {
        if (file !== ".gitkeep") {
          await rm(join(USAGE_DIR, file), { recursive: true, force: true });
        }
      }
    } catch {
      // Directory might not exist yet
    }
  });

  afterEach(async () => {
    resetUsageTracker();
  });

  test("should initialize without error", async () => {
    await initUsageTracker();
    const stats = await getUsageStats();
    expect(stats.totalRecords).toBe(0);
  });

  test("should record invocation start", async () => {
    await initUsageTracker();

    const context = {
      sessionId: "session-123",
      channelId: "telegram:12345",
      source: "telegram",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    const record = await recordInvocationStart(context);

    expect(record.invocationId).toBeDefined();
    expect(record.sessionId).toBe("session-123");
    expect(record.channelId).toBe("telegram:12345");
    expect(record.provider).toBe("anthropic");
    expect(record.model).toBe("claude-3-5-sonnet");
    expect(record.status).toBe("started");
    expect(record.startedAt).toBeDefined();
  });

  test("should record invocation completion with usage", async () => {
    await initUsageTracker();

    const context = {
      sessionId: "session-123",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    const startRecord = await recordInvocationStart(context);

    const usage = {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 300,
    };

    const estimatedCost = {
      currency: "USD",
      inputCost: 0.003,
      outputCost: 0.03,
      cacheCost: 0.002,
      totalCost: 0.035,
      pricingVersion: "1.0.0",
    };

    const completed = await recordInvocationCompletion(
      startRecord.invocationId,
      usage,
      estimatedCost,
    );

    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
    expect(completed!.completedAt).toBeDefined();
    expect(completed!.usage).toEqual(usage);
    expect(completed!.estimatedCost).toEqual(estimatedCost);
  });

  test("should record invocation failure", async () => {
    await initUsageTracker();

    const context = {
      provider: "anthropic",
      model: "claude-3-haiku",
    };

    const startRecord = await recordInvocationStart(context);

    const error = { type: "rate_limit", message: "Rate limit exceeded" };

    const failed = await recordInvocationFailure(startRecord.invocationId, error);

    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toEqual(error);
  });

  test("should record invocation killed by watchdog", async () => {
    await initUsageTracker();

    const context = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    const startRecord = await recordInvocationStart(context);

    const killed = await recordInvocationKilled(startRecord.invocationId, "maxToolCalls exceeded");

    expect(killed).not.toBeNull();
    expect(killed!.status).toBe("killed");
    expect(killed!.error?.type).toBe("watchdog");
    expect(killed!.error?.message).toBe("maxToolCalls exceeded");
  });

  test("should get invocation by id", async () => {
    await initUsageTracker();

    const context = {
      provider: "openai",
      model: "gpt-4o",
    };

    const startRecord = await recordInvocationStart(context);
    const retrieved = await getInvocation(startRecord.invocationId);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.invocationId).toBe(startRecord.invocationId);
  });

  test("should get session usage", async () => {
    await initUsageTracker();

    const sessionId = "session-session-test";

    // Create multiple invocations for the same session
    for (let i = 0; i < 3; i++) {
      await recordInvocationStart({
        sessionId,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    }

    const usage = await getSessionUsage(sessionId);
    expect(usage.length).toBe(3);
  });

  test("should get channel usage", async () => {
    await initUsageTracker();

    const channelId = "telegram:channel-test";

    // Create invocations for the same channel
    for (let i = 0; i < 2; i++) {
      await recordInvocationStart({
        channelId,
        provider: "anthropic",
        model: "claude-3-haiku",
      });
    }

    const usage = await getChannelUsage(channelId);
    expect(usage.length).toBe(2);
  });

  test("should compute aggregates correctly", async () => {
    await initUsageTracker();

    // Create invocations with usage
    for (let i = 0; i < 3; i++) {
      const start = await recordInvocationStart({
        sessionId: "agg-session",
        channelId: "telegram:agg",
        source: "telegram",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });

      await recordInvocationCompletion(
        start.invocationId,
        {
          inputTokens: 1000,
          outputTokens: 2000,
        },
        {
          currency: "USD",
          totalCost: 0.035,
        },
      );
    }

    const aggregates = await getAggregates({});

    expect(aggregates.totalInvocations).toBe(3);
    expect(aggregates.completedInvocations).toBe(3);
    expect(aggregates.totalInputTokens).toBe(3000);
    expect(aggregates.totalOutputTokens).toBe(6000);
    expect(aggregates.totalEstimatedCost).toBeCloseTo(0.105);
    expect(aggregates.byProvider["anthropic"]).toBeDefined();
    expect(aggregates.byProvider["anthropic"].count).toBe(3);
  });

  test("should handle missing invocation gracefully", async () => {
    await initUsageTracker();

    const result = await getInvocation("non-existent-id");
    expect(result).toBeNull();
  });

  test("should track failed and killed invocations separately", async () => {
    await initUsageTracker();

    // Create one of each status
    const started = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });

    await recordInvocationCompletion(started.invocationId);

    const failedStart = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    await recordInvocationFailure(failedStart.invocationId, {
      type: "error",
      message: "Test error",
    });

    const killedStart = await recordInvocationStart({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    await recordInvocationKilled(killedStart.invocationId, "Watchdog triggered");

    const aggregates = await getAggregates({});

    expect(aggregates.completedInvocations).toBe(1);
    expect(aggregates.failedInvocations).toBe(1);
    expect(aggregates.killedInvocations).toBe(1);
  });
});

describe("extractTranscriptUsage (budget wiring)", () => {
  test("sums assistant usage from the session transcript, excluding turns before startedAt", async () => {
    const cwd = `/tmp/claudeclaw-test-${randomUUID()}`;
    const sessionId = randomUUID();
    const dir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    const jsonl = join(dir, `${sessionId}.jsonl`);
    await mkdir(dir, { recursive: true });
    const lines = [
      // before sinceIso → must be EXCLUDED
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-15T22:00:00.000Z",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 100,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-15T22:00:01.000Z",
        message: { usage: { input_tokens: 3, output_tokens: 7 } },
      }),
      JSON.stringify({ type: "user", timestamp: "2026-06-15T22:00:02.000Z", message: {} }),
    ].join("\n");
    await writeFile(jsonl, lines);
    try {
      const u = await extractTranscriptUsage(cwd, sessionId, "2026-06-15T12:00:00.000Z");
      expect(u).not.toBeNull();
      expect(u?.inputTokens).toBe(13); // 10+3 (the 999 turn predates startedAt)
      expect(u?.outputTokens).toBe(27); // 20+7
      expect(u?.cacheCreationInputTokens).toBe(5);
      expect(u?.cacheReadInputTokens).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null for an unknown/missing session (no throw, finalize stays safe)", async () => {
    expect(await extractTranscriptUsage("/tmp/x", "unknown", new Date().toISOString())).toBeNull();
    expect(
      await extractTranscriptUsage(
        `/tmp/${randomUUID()}`,
        randomUUID(),
        "2020-01-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });
});
