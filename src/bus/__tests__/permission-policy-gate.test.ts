import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import { createBusCore, type BusCore, type BusCoreOptions } from "../core";
import type { PolicyDecision } from "../../policy/engine";

// Minimal event-log stub so the bus never touches disk.
const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(evaluatePolicy: BusCoreOptions["evaluatePolicy"]): {
  bus: BusCore;
  events: Array<{ topic: string; payload: unknown }>;
} {
  const events: Array<{ topic: string; payload: unknown }> = [];
  const bus = createBusCore({ eventLogAppend: mockAppend, evaluatePolicy });
  bus.subscribe({}, (e) => events.push(e as { topic: string; payload: unknown }));
  return { bus, events };
}

function feed(bus: BusCore, tool: string, requestId: string): void {
  (bus as unknown as { handleIpcMessage(a: string, m: unknown): void }).handleIpcMessage("alpha", {
    type: "permission_request",
    agent_id: "alpha",
    request: { request_id: requestId, tool_name: tool, description: "", input_preview: "" },
  });
}

const explicitDeny = (ruleId: string): PolicyDecision =>
  ({
    requestId: "r",
    action: "deny",
    matchedRuleId: ruleId,
    reason: "explicit deny",
    evaluatedAt: "t",
    cacheable: false,
  }) as PolicyDecision;

// The engine returns action:"deny" with NO matchedRuleId when nothing matches.
const defaultDeny = (): PolicyDecision =>
  ({
    requestId: "r",
    action: "deny",
    reason: "No matching policy rule - default deny",
    evaluatedAt: "t",
    cacheable: false,
  }) as PolicyDecision;

const topics = (events: Array<{ topic: string; payload: unknown }>, topic: string) =>
  events.filter((e) => e.topic === topic);

describe("Bus permission policy gate (#258 item 3)", () => {
  it("auto-denies (deny-wins) when an explicit deny rule matches — no operator card", () => {
    const { bus, events } = makeBus((ctx) =>
      ctx.toolName === "Bash" ? explicitDeny("deny-bash") : defaultDeny(),
    );
    feed(bus, "Bash", "abcde");
    const responses = topics(events, "channel.permission_response");
    expect(responses).toHaveLength(1);
    expect((responses[0].payload as { behavior: string }).behavior).toBe("deny");
    expect(topics(events, "channel.permission_request")).toHaveLength(0);
  });

  it("falls through to the operator card on the engine's no-match default-deny (no matchedRuleId)", () => {
    const { bus, events } = makeBus(() => defaultDeny());
    feed(bus, "Read", "fghij");
    expect(topics(events, "channel.permission_request")).toHaveLength(1);
    expect(topics(events, "channel.permission_response")).toHaveLength(0);
  });

  it("threads inbound userId + skillName (metadata.command) into the policy request (#258 slice 2)", async () => {
    let captured: { userId?: string; skillName?: string; channelId?: string } | undefined;
    const { bus } = makeBus((ctx) => {
      captured = { userId: ctx.userId, skillName: ctx.skillName, channelId: ctx.channelId };
      return defaultDeny(); // don't auto-deny — we only assert the threaded context
    });
    await bus.sendPrompt({
      agent_id: "alpha",
      origin: "telegram",
      origin_id: "chat-1",
      user_id: "user-9",
      text: "/quant do the thing",
      metadata: { command: "/quant" },
    });
    feed(bus, "Bash", "abcde");
    expect(captured).toBeDefined();
    expect(captured!.userId).toBe("user-9");
    expect(captured!.skillName).toBe("quant");
    expect(captured!.channelId).toBe("chat-1");
  });

  it("fails OPEN to the operator card when policy evaluation throws", () => {
    const { bus, events } = makeBus(() => {
      throw new Error("engine boom");
    });
    feed(bus, "Bash", "klmno");
    expect(topics(events, "channel.permission_request")).toHaveLength(1);
    expect(topics(events, "channel.permission_response")).toHaveLength(0);
  });
});
