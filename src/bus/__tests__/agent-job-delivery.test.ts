/**
 * deliverAgentJobResult — job-result delivery that never clobbers a mid-turn
 * dispatcher's prompt-origin (#296 PR 3, Codex review).
 *
 * Verifies: idle dispatcher → deliver immediately; mid-turn dispatcher → defer
 * to its next `response.turn_end`; deliver at most once.
 */

import { describe, it, expect } from "bun:test";
import { deliverAgentJobResult } from "../runtime-mount";
import type { BusCore, SendPromptRequest } from "../core";
import type { JobView } from "../agent-jobs";
import type { SubscriptionHandler } from "../core-subscription";

function jobView(over: Partial<JobView> = {}): JobView {
  return {
    jobId: "job-1",
    agent: "reg",
    dispatcher: "claw",
    status: "done",
    createdAt: 0,
    resultText: "done!",
    ...over,
  };
}

/** Minimal fake bus satisfying the slice `deliverAgentJobResult` depends on. */
function fakeBus(turnActive: boolean) {
  const prompts: SendPromptRequest[] = [];
  let active = turnActive;
  let handler: SubscriptionHandler | null = null;
  let closed = false;
  const bus: Pick<BusCore, "sendPrompt" | "isAgentTurnActive" | "subscribe"> = {
    isAgentTurnActive: () => active,
    async sendPrompt(req) {
      prompts.push(req);
      return { promise_id: "x" };
    },
    subscribe(_filter, h) {
      handler = h;
      return {
        id: "s",
        close() {
          closed = true;
        },
        get overflowCount() {
          return 0;
        },
        get depth() {
          return 0;
        },
      };
    },
  };
  return {
    bus,
    prompts,
    endTurn: () => {
      active = false;
    },
    fireTurnEnd: () =>
      handler?.({
        ts: 0,
        agent_id: "claw",
        session_id: "",
        topic: "response.turn_end",
        payload: {},
      }),
    isSubClosed: () => closed,
  };
}

const logger = { warn() {} };

describe("deliverAgentJobResult (#296 PR 3 Codex review)", () => {
  it("delivers immediately when the dispatcher is idle", () => {
    const f = fakeBus(false);
    deliverAgentJobResult(f.bus, jobView(), logger);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0].agent_id).toBe("claw");
    expect(f.prompts[0].origin).toBe("cron");
    expect(f.prompts[0].user_id).toBe("system");
  });

  it("defers until the dispatcher's next turn_end when it's mid-turn (no origin clobber)", () => {
    const f = fakeBus(true);
    deliverAgentJobResult(f.bus, jobView(), logger);
    expect(f.prompts).toHaveLength(0); // NOT delivered while a turn is live
    f.endTurn();
    f.fireTurnEnd();
    expect(f.prompts).toHaveLength(1); // delivered when the turn ends
    expect(f.isSubClosed()).toBe(true); // one-shot subscription closed
  });

  it("delivers at most once even if turn_end fires repeatedly", () => {
    const f = fakeBus(true);
    deliverAgentJobResult(f.bus, jobView(), logger);
    f.fireTurnEnd();
    f.fireTurnEnd();
    expect(f.prompts).toHaveLength(1);
  });
});
