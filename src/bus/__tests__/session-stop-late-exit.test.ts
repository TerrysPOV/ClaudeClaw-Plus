/**
 * #595 round 8: a late exit callback of a STOPPED process must not touch its replacement.
 *
 * `/clear` and a preserving restart confirm the old pid gone through the OS (not through the
 * wrapper's exit event) and then spawn the replacement. The old `AgentProcess` may deliver its exit
 * callback after that. `stop()`'s bookkeeping is keyed by the agent id, so run late it used to delete
 * the replacement's registry entry (prompts then saw no agent and a later spawn made a second
 * process), revoke its MCP identity and reset its restart budget.
 *
 * No process is spawned: the registry holds fake records and the test fires the old callbacks itself.
 */
import { describe, expect, it } from "bun:test";
import { type AgentProcess, SessionManager } from "../session-manager";

interface FakeProc {
  pid: number;
  exited: boolean;
  handlers: Array<(code: number) => void>;
  proc: AgentProcess;
}

function fakeProc(pid: number): FakeProc {
  const f = { pid, exited: false, handlers: [] as Array<(code: number) => void> } as FakeProc;
  f.proc = {
    pid,
    _isExited: () => f.exited,
    onExit: (cb: (code: number) => void) => void f.handlers.push(cb),
    send_slash: async () => {},
    _kill: () => {},
  } as unknown as AgentProcess;
  return f;
}

type Registry = Map<string, { proc: AgentProcess; mcpConfigCwd?: string; stopping?: boolean }>;

function harness() {
  const mgr = new SessionManager({});
  const priv = mgr as unknown as {
    agents: Registry;
    restartHistory: Map<string, number[]>;
    cleanupAgentMcpConfig: (cwd: string | undefined, agentId: string) => void;
  };
  const cleaned: Array<[string | undefined, string]> = [];
  priv.cleanupAgentMcpConfig = (cwd, agentId) => void cleaned.push([cwd, agentId]);
  return { mgr, priv, cleaned };
}

describe("stop() and a late exit callback (#595 r9)", () => {
  it("the old process's callback arrives after the replacement is registered: the replacement survives", async () => {
    // Fault (site: the identity check in `stop()`'s `finalise`, removed: the unconditional
    // `agents.delete`): the replacement's entry is dropped. Predicted result: `_list()` is `[]` and
    // `getAgent("a")` is undefined.
    const { mgr, priv, cleaned } = harness();
    const old = fakeProc(100);
    priv.agents.set("a", { proc: old.proc, mcpConfigCwd: "/old/cwd" });
    const stopped = mgr.stop("a");
    expect(old.handlers).toHaveLength(1);

    // The replacement is spawned and registered before the old process's callback arrives.
    const replacement = fakeProc(200);
    priv.agents.set("a", { proc: replacement.proc, mcpConfigCwd: "/new/cwd" });
    priv.restartHistory.set("a", [1, 2]);

    old.exited = true;
    for (const h of old.handlers) h(0);
    await stopped;

    expect(mgr._list()).toEqual(["a"]);
    expect(mgr.getAgent("a")?.pid).toBe(200);
    // Nothing keyed by the agent id was released on the replacement's behalf.
    expect(cleaned).toEqual([]);
    expect(priv.restartHistory.get("a")).toEqual([1, 2]);
  });

  it("a stop() that still owns the id releases it, as before", async () => {
    const { mgr, priv, cleaned } = harness();
    const old = fakeProc(100);
    priv.agents.set("a", { proc: old.proc, mcpConfigCwd: "/old/cwd" });
    priv.restartHistory.set("a", [1]);
    const stopped = mgr.stop("a");
    old.exited = true;
    for (const h of old.handlers) h(0);
    await stopped;

    expect(mgr._list()).toEqual([]);
    expect(cleaned).toEqual([["/old/cwd", "a"]]);
    expect(priv.restartHistory.has("a")).toBe(false);
  });

  it("a stop() of a process that already exited resolves at once and frees the slot", async () => {
    const { mgr, priv } = harness();
    const old = fakeProc(100);
    old.exited = true;
    priv.agents.set("a", { proc: old.proc });
    await mgr.stop("a");
    expect(mgr._list()).toEqual([]);
  });
});
