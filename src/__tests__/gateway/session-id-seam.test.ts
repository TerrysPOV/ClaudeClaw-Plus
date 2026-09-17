/**
 * #376: the real Claude session id travels RunResult → ProcessingResult →
 * gateway → resume mapping, so `--resume` is actually emitted. Before, the
 * field was declared and never populated: every turn started a fresh session.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Gateway, type GatewayDependencies } from "../../gateway/index";
import { initGovernanceClient } from "../../governance/client";
import type { NormalizedEvent } from "../../gateway/normalizer";

function makeDeps(
  processorResult: { success: boolean; claudeSessionId?: string },
  recorded: Array<[string, string, string]>,
): GatewayDependencies {
  const now = new Date().toISOString();
  return {
    eventLog: {
      append: async () => ({
        id: randomUUID(),
        seq: 1,
        type: "inbound:telegram",
        source: "telegram",
        timestamp: now,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        channelId: "telegram:123",
        threadId: "default",
        payload: {},
        dedupeKey: "test",
        retryCount: 0,
        nextRetryAt: null,
        correlationId: null,
        causationId: null,
        replayedFromEventId: null,
        lastError: null,
      }),
    },
    processor: { processPersistedEvent: async () => processorResult },
    resume: {
      getOrCreateSessionMapping: async () => ({
        mappingId: "mapping-1",
        channelId: "telegram:123",
        threadId: "default",
        claudeSessionId: null,
        lastSeq: 0,
        turnCount: 0,
        status: "pending",
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      getResumeArgsForEvent: async () => ({
        mappingId: "mapping-1",
        claudeSessionId: null,
        args: [],
        isNewMapping: true,
        canResume: false,
      }),
      updateSessionAfterProcessing: async () => undefined,
      recordClaudeSessionId: async (channelId: string, threadId: string, id: string) => {
        recorded.push([channelId, threadId, id]);
      },
    },
  } as unknown as GatewayDependencies;
}

function event(): NormalizedEvent {
  return {
    id: randomUUID(),
    channel: "telegram",
    sourceEventId: "msg-1",
    channelId: "telegram:123",
    threadId: "default",
    userId: "456",
    text: "Hello",
    attachments: [],
    timestamp: Date.now(),
    metadata: {},
  } as NormalizedEvent;
}

let warnings: string[];
let origWarn: typeof console.warn;
beforeEach(() => {
  // The policy engine is not under test: allow everything so the event reaches the processor.
  initGovernanceClient({ policyEnabled: false, approvalEnabled: false });
  warnings = [];
  origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = origWarn;
  initGovernanceClient();
});

describe("gateway records the Claude session id the processor surfaces (#376)", () => {
  it("a successful turn with a session id records it on the mapping", async () => {
    const recorded: Array<[string, string, string]> = [];
    const gw = new Gateway({}, makeDeps({ success: true, claudeSessionId: "sess-abc" }, recorded));
    await gw.start();
    const r = await gw.processInboundEvent(event());
    expect(r.success).toBe(true);
    expect(recorded).toEqual([["telegram:123", "default", "sess-abc"]]);
    expect(warnings.filter((w) => w.includes("no Claude session id"))).toHaveLength(0);
    await gw.stop();
  });

  it("a successful turn with NO session id records nothing and says so once per conversation", async () => {
    const recorded: Array<[string, string, string]> = [];
    const gw = new Gateway({}, makeDeps({ success: true }, recorded));
    await gw.start();
    await gw.processInboundEvent(event());
    await gw.processInboundEvent(event());
    expect(recorded).toEqual([]);
    const w = warnings.filter((x) => x.includes("no Claude session id"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("channel=telegram:123");
    expect(w[0]).toContain("keeps no id until a turn reports one");
    await gw.stop();
  });

  it("a failed turn neither records nor warns", async () => {
    const recorded: Array<[string, string, string]> = [];
    const gw = new Gateway({}, makeDeps({ success: false, claudeSessionId: "sess-x" }, recorded));
    await gw.start();
    await gw.processInboundEvent(event());
    expect(recorded).toEqual([]);
    expect(warnings.filter((x) => x.includes("no Claude session id"))).toHaveLength(0);
    await gw.stop();
  });
});
