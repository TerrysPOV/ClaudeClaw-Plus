/**
 * Tests for createRotateAgent — the #227 restart-based session-rotation
 * orchestrator wired into the bus bridge's post-turn rotation gate.
 *
 * Run with: bun test src/__tests__/bus/rotate-agent.test.ts
 */

import { describe, it, expect } from "bun:test";
import { createRotateAgent, type RotateAgentDeps } from "../runtime-mount";

const silentLogger = { warn: () => {} };

interface Behaviour {
  /** Value peekSessionId resolves to. Default "old-session-id". */
  peekResult?: string | undefined;
  /** Make peekSessionId reject. */
  peekThrows?: boolean;
  /** Make restart reject. */
  restartThrows?: boolean;
  /** Make summarize reject (background failure). */
  summarizeThrows?: boolean;
  /** Configured summary dir. Default "/tmp/summaries"; "" disables summary. */
  summaryPath?: string;
}

/**
 * Build deps with call-order tracking. The call log is owned here so every
 * dep records consistently regardless of which behaviour flags are set.
 */
function makeDeps(b: Behaviour = {}) {
  const calls: string[] = [];
  const restartArgs: string[] = [];
  const summarizeArgs: Array<[string, string]> = [];
  const deps: RotateAgentDeps = {
    restart: async (id) => {
      calls.push("restart");
      restartArgs.push(id);
      if (b.restartThrows) throw new Error("restart failed");
    },
    peekSessionId: async () => {
      calls.push("peek");
      if (b.peekThrows) throw new Error("peek blew up");
      return "peekResult" in b ? b.peekResult : "old-session-id";
    },
    summarize: async (sid, path) => {
      calls.push("summarize");
      summarizeArgs.push([sid, path]);
      if (b.summarizeThrows) throw new Error("summary blew up");
    },
    getSummaryPath: () => b.summaryPath ?? "/tmp/summaries",
    logger: silentLogger,
  };
  return { deps, calls, restartArgs, summarizeArgs };
}

describe("createRotateAgent (#227 rotation orchestrator)", () => {
  it("peeks the old id BEFORE restart, then summarizes it AFTER restart", async () => {
    const { deps, calls, restartArgs, summarizeArgs } = makeDeps();
    const rotate = createRotateAgent(deps);

    await rotate("agent-1");

    // Order is the whole point: capture old id → restart → summarize old id.
    expect(calls).toEqual(["peek", "restart", "summarize"]);
    expect(restartArgs).toEqual(["agent-1"]);
    // Summarizes the OLD session id (now freed), never the live one.
    expect(summarizeArgs).toEqual([["old-session-id", "/tmp/summaries"]]);
  });

  it("skips summary when no summary path is configured but still restarts", async () => {
    const { deps, calls } = makeDeps({ summaryPath: "" });
    const rotate = createRotateAgent(deps);

    await rotate("agent-1");

    expect(calls).toEqual(["peek", "restart"]);
  });

  it("skips summary when the old session id is unknown but still restarts", async () => {
    const { deps, calls } = makeDeps({ peekResult: undefined });
    const rotate = createRotateAgent(deps);

    await rotate("agent-1");

    expect(calls).toEqual(["peek", "restart"]);
  });

  it("a peek failure does not block the restart (no old id → no summary)", async () => {
    const { deps, calls, restartArgs } = makeDeps({ peekThrows: true });
    const rotate = createRotateAgent(deps);

    await rotate("agent-1");

    // peek attempted then threw (swallowed); restart still ran; no summary.
    expect(calls).toEqual(["peek", "restart"]);
    expect(restartArgs).toEqual(["agent-1"]);
  });

  it("propagates a restart rejection and does NOT summarize", async () => {
    const { deps, calls } = makeDeps({ restartThrows: true });
    const rotate = createRotateAgent(deps);

    await expect(rotate("agent-1")).rejects.toThrow("restart failed");
    expect(calls).toEqual(["peek", "restart"]); // threw in restart, never summarized
  });

  it("a background summary failure does not reject rotate()", async () => {
    const { deps } = makeDeps({ summarizeThrows: true });
    const rotate = createRotateAgent(deps);

    // Must resolve cleanly — the summary is fire-and-forget.
    await expect(rotate("agent-1")).resolves.toBeUndefined();
  });
});
