import { describe, it, expect } from "bun:test";
import type { BusEvent, BusEventTopic } from "../types";
import { KanbanTracker, DEFAULT_KANBAN_CONFIG, type KanbanTrackerDeps } from "../kanban-tracker";
import { capDoneColumn, type KanbanBoard, type KanbanCard } from "../../ui/services/kanban";

function evt(
  topic: BusEventTopic,
  ts: number,
  payload: unknown,
  agent = "reg",
  session = "s1",
): BusEvent {
  return { ts, agent_id: agent, session_id: session, topic, payload };
}

interface Recorder {
  added: Array<{ column: string; card: KanbanCard }>;
  moved: Array<{ id: string; column: string; patch?: Partial<KanbanCard> }>;
  capped: number[];
  /** Records completion ORDER of the serialized async ops. */
  order: string[];
}

/** Deps whose async mutators resolve on a microtask, so overlapping enqueues
 *  would interleave if the tracker did NOT serialize them. */
function recordingDeps(delayFirst?: boolean): {
  deps: KanbanTrackerDeps;
  rec: Recorder;
} {
  const rec: Recorder = { added: [], moved: [], capped: [], order: [] };
  let firstAdd = true;
  const deps: KanbanTrackerDeps = {
    subscribe: () => () => {},
    addCard: async (column, card) => {
      // First add is deliberately slow (two extra microtasks) to prove ops are
      // serialized: a second add must still land AFTER this one completes.
      if (delayFirst && firstAdd) {
        firstAdd = false;
        await Promise.resolve();
        await Promise.resolve();
      }
      rec.added.push({ column, card });
      rec.order.push(`add:${card.id}`);
    },
    moveCard: async (id, column, patch) => {
      rec.moved.push({ id, column, patch });
      rec.order.push(`move:${id}`);
    },
    capDone: async (max) => {
      rec.capped.push(max);
    },
    now: () => 123,
    log: () => {},
  };
  return { deps, rec };
}

const ISO0 = new Date(0).toISOString();

describe("KanbanTracker — subagent lifecycle", () => {
  it("Agent spawn → addCard(in_progress) with started_at + agent_type", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(
      evt("response.tool_use", 0, {
        id: "a1",
        name: "Agent",
        input: { description: "do a thing", subagent_type: "Explore" },
      }),
    );
    await wd.flush();
    expect(rec.added).toHaveLength(1);
    expect(rec.added[0]?.column).toBe("in_progress");
    expect(rec.added[0]?.card).toMatchObject({
      id: "a1",
      title: "do a thing",
      started_at: ISO0,
      agent_type: "Explore",
    });
  });

  it("Task tool is tracked too; title falls back to prompt then truncates to 120", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    const long = "x".repeat(300);
    wd.ingest(evt("response.tool_use", 0, { id: "t1", name: "Task", input: { prompt: long } }));
    await wd.flush();
    expect(rec.added[0]?.card.title).toHaveLength(120);
    expect(rec.added[0]?.card.agent_type).toBe("subagent"); // no subagent_type/name → default
  });

  it("matching tool_result → moveCard(done, completed_at) + caps done", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "a1", name: "Agent", input: {} }));
    wd.ingest(evt("tool_result", 5000, { tool_use_id: "a1" }));
    await wd.flush();
    expect(rec.moved).toHaveLength(1);
    expect(rec.moved[0]).toMatchObject({
      id: "a1",
      column: "done",
      patch: { completed_at: new Date(5000).toISOString() },
    });
    expect(rec.capped).toEqual([DEFAULT_KANBAN_CONFIG.maxDoneCards]);
  });

  it("a non-Agent tool_use is ignored (no card)", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash", input: { command: "ls" } }));
    await wd.flush();
    expect(rec.added).toHaveLength(0);
  });

  it("a tool_result with an unknown/untracked id is ignored", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    // Bash result, and an unrelated agent result — neither was tracked.
    wd.ingest(evt("tool_result", 100, { tool_use_id: "bash-xyz" }));
    wd.ingest(evt("tool_result", 200, { tool_use_id: "never-spawned" }));
    await wd.flush();
    expect(rec.moved).toHaveLength(0);
  });

  it("session.end sweeps an open card to done (orphaned)", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(
      evt("response.tool_use", 0, { id: "a1", name: "Agent", input: { subagent_type: "Plan" } }),
    );
    wd.ingest(evt("session.end", 9000, {}));
    await wd.flush();
    expect(rec.moved).toHaveLength(1);
    expect(rec.moved[0]).toMatchObject({
      id: "a1",
      column: "done",
      patch: { completed_at: new Date(9000).toISOString(), agent_type: "Plan (orphaned)" },
    });
    // A later stray result for the swept card is now ignored (dropped from live set).
    wd.ingest(evt("tool_result", 9500, { tool_use_id: "a1" }));
    await wd.flush();
    expect(rec.moved).toHaveLength(1);
  });

  it("session.init also sweeps orphans of that session", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "a1", name: "Agent", input: {} }));
    wd.ingest(evt("session.init", 7000, {}));
    await wd.flush();
    expect(rec.moved).toHaveLength(1);
    expect(rec.moved[0]?.patch?.agent_type).toBe("subagent (orphaned)");
  });

  it("only sweeps orphans of the ENDING session, not other sessions", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "s1a", name: "Agent", input: {} }, "reg", "s1"));
    wd.ingest(evt("response.tool_use", 0, { id: "s2a", name: "Agent", input: {} }, "reg", "s2"));
    wd.ingest(evt("session.end", 9000, {}, "reg", "s1"));
    await wd.flush();
    expect(rec.moved).toHaveLength(1);
    expect(rec.moved[0]?.id).toBe("s1a");
  });

  it("session.agent_name cache is used as agent_type fallback", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("session.agent_name", 0, { agentName: "suzy" }));
    wd.ingest(evt("response.tool_use", 1, { id: "a1", name: "Agent", input: {} }));
    await wd.flush();
    expect(rec.added[0]?.card.agent_type).toBe("suzy");
  });

  it("a duplicate spawn for a live id is ignored (idempotent)", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "a1", name: "Agent", input: {} }));
    wd.ingest(evt("response.tool_use", 1, { id: "a1", name: "Agent", input: {} }));
    await wd.flush();
    expect(rec.added).toHaveLength(1);
  });

  it("writes are serialized — a slow add still completes before the next op (no lost update)", async () => {
    const { deps, rec } = recordingDeps(/* delayFirst */ true);
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    // Fire two spawns back-to-back; the first add is artificially slow.
    wd.ingest(evt("response.tool_use", 0, { id: "a1", name: "Agent", input: {} }));
    wd.ingest(evt("response.tool_use", 1, { id: "a2", name: "Agent", input: {} }));
    await wd.flush();
    // Despite a1's add being slow, ops applied strictly in enqueue order.
    expect(rec.order).toEqual(["add:a1", "add:a2"]);
  });

  it("ingest never throws even on a malformed payload", async () => {
    const { deps } = recordingDeps();
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, deps);
    expect(() => wd.ingest(evt("response.tool_use", 0, null))).not.toThrow();
    expect(() => wd.ingest(evt("tool_result", 0, undefined))).not.toThrow();
    await wd.flush();
  });

  it("disabled tracker does not subscribe", () => {
    const { deps } = recordingDeps();
    let subscribed = false;
    const wd = new KanbanTracker(
      { ...DEFAULT_KANBAN_CONFIG, enabled: false },
      {
        ...deps,
        subscribe: () => {
          subscribed = true;
          return () => {};
        },
      },
    );
    wd.start();
    expect(subscribed).toBe(false);
  });

  it("start() wires ingest to the bus; stop() unsubscribes + clears state", async () => {
    const { deps, rec } = recordingDeps();
    let handler: ((e: BusEvent) => void) | null = null;
    let closed = false;
    const wd = new KanbanTracker(DEFAULT_KANBAN_CONFIG, {
      ...deps,
      subscribe: (h) => {
        handler = h;
        return () => {
          closed = true;
        };
      },
    });
    wd.start();
    expect(handler).not.toBeNull();
    (handler as unknown as (e: BusEvent) => void)(
      evt("response.tool_use", 0, { id: "a1", name: "Agent", input: {} }),
    );
    await wd.flush();
    expect(rec.added).toHaveLength(1);
    wd.stop();
    expect(closed).toBe(true);
  });
});

/* ── capDoneColumn (pure) ──────────────────────────────────────────────────── */

describe("capDoneColumn", () => {
  const board = (n: number): KanbanBoard => ({
    columns: {
      todo: [],
      in_progress: [],
      done: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: `d${i}` })),
    },
  });

  it("keeps the newest `max` (head) cards and drops the rest", () => {
    const b = capDoneColumn(board(5), 2);
    expect(b.columns.done.map((c) => c.id)).toEqual(["d0", "d1"]);
  });

  it("leaves the board unchanged when already at/under max", () => {
    const b = capDoneColumn(board(2), 5);
    expect(b.columns.done).toHaveLength(2);
  });

  it("defaults to 50", () => {
    const b = capDoneColumn(board(60));
    expect(b.columns.done).toHaveLength(50);
  });
});
