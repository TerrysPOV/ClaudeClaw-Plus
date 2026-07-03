import { describe, it, expect } from "bun:test";
import type { BusEvent, BusEventTopic } from "../types";
import {
  classifyTool,
  ceilingFor,
  evaluateStall,
  newSessionState,
  StallWatchdog,
  DEFAULT_STALL_CONFIG,
  type StallWatchdogDeps,
  type ForensicSnapshot,
  type StallKillOutcome,
} from "../stall-watchdog";

const C = DEFAULT_STALL_CONFIG.ceilings;

function evt(
  topic: BusEventTopic,
  ts: number,
  payload: unknown,
  agent = "reg",
  session = "s1",
): BusEvent {
  return { ts, agent_id: agent, session_id: session, topic, payload };
}

function stateWith(tools: Array<{ id: string; name: string; startedAt: number }>) {
  const s = newSessionState("reg", "s1", 0);
  for (const t of tools) s.outstanding.set(t.id, { ...t, warned: false });
  return s;
}

/* ── classifyTool / ceilingFor ─────────────────────────────────────────── */

describe("classifyTool", () => {
  it("maps Bash → bash, fast tools → fast", () => {
    expect(classifyTool("Bash")).toBe("bash");
    for (const t of ["Read", "Edit", "Grep", "Glob", "Write", "LS", "MultiEdit", "NotebookEdit"]) {
      expect(classifyTool(t)).toBe("fast");
    }
  });
  it("maps agent-dispatch → task (generous, sub-agents run long)", () => {
    expect(classifyTool("Task")).toBe("task");
    expect(classifyTool("Agent")).toBe("task");
  });
  it("maps mcp__… → mcp, other unknown → default", () => {
    expect(classifyTool("mcp__playwright__navigate")).toBe("mcp");
    expect(classifyTool("mcp__deep-research__run")).toBe("mcp");
    expect(classifyTool("WebFetch")).toBe("default");
    expect(classifyTool("SomethingNew")).toBe("default");
  });
  it("ceilingFor returns the class ceiling", () => {
    expect(ceilingFor("Bash", C)).toEqual(C.bash);
    expect(ceilingFor("Read", C)).toEqual(C.fast);
    expect(ceilingFor("Task", C)).toEqual(C.task);
    expect(ceilingFor("mcp__x__y", C)).toEqual(C.mcp);
    expect(ceilingFor("WebFetch", C)).toEqual(C.default);
  });
  it("task ceiling is more generous than bash/default (no false-positive kill of long sub-agents)", () => {
    expect(C.task.killSeconds).toBeGreaterThan(C.bash.killSeconds);
    expect(C.task.killSeconds).toBeGreaterThan(C.default.killSeconds);
  });
});

/* ── evaluateStall (pure decision) ─────────────────────────────────────── */

describe("evaluateStall", () => {
  it("no outstanding tools → none", () => {
    expect(evaluateStall(stateWith([]), 10_000_000, C).action).toBe("none");
  });

  it("Bash under warn → none; past warn → warn; past kill → kill", () => {
    const s = stateWith([{ id: "b", name: "Bash", startedAt: 0 }]);
    expect(evaluateStall(s, 200_000, C).action).toBe("none"); // 200s < 300 warn
    expect(evaluateStall(s, 400_000, C).action).toBe("warn"); // 400s ≥ 300 warn
    expect(evaluateStall(s, 950_000, C).action).toBe("kill"); // 950s ≥ 900 kill
  });

  it("fast tools use the tight ceiling (kill at 120s)", () => {
    const s = stateWith([{ id: "r", name: "Read", startedAt: 0 }]);
    expect(evaluateStall(s, 90_000, C).action).toBe("warn"); // ≥60 warn
    const d = evaluateStall(s, 130_000, C); // ≥120 kill
    expect(d.action).toBe("kill");
    if (d.action !== "none") expect(d.tool).toBe("Read");
  });

  it("picks the most severe (kill > warn)", () => {
    const s = stateWith([
      { id: "b", name: "Bash", startedAt: 0 }, // now=400s → 400s: Bash warn band (300–900)
      { id: "r", name: "Read", startedAt: 270_000 }, // now=400s → 130s: Read kill band (>120)
    ]);
    const d = evaluateStall(s, 400_000, C);
    expect(d.action).toBe("kill");
    if (d.action !== "none") expect(d.tool).toBe("Read");
  });

  it("among two kills, reports the longest-outstanding", () => {
    const s = stateWith([
      { id: "r1", name: "Read", startedAt: 100_000 },
      { id: "r2", name: "Read", startedAt: 0 }, // older
    ]);
    const d = evaluateStall(s, 400_000, C);
    expect(d.action).toBe("kill");
    if (d.action !== "none") expect(d.toolUseId).toBe("r2");
  });
});

/* ── ingest (state transitions) ────────────────────────────────────────── */

describe("StallWatchdog.ingest state transitions", () => {
  // Each transition is observed via whether a far-future sweep restarts the session.
  it("a matching tool_result clears the outstanding tool (no kill)", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    wd.ingest(evt("tool_result", 100, { tool_use_id: "b1" }));
    await wd.sweep(950_000);
    expect(rec.restart).toHaveLength(0);
  });

  it("a NON-matching tool_result does not clear (still kills)", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    wd.ingest(evt("tool_result", 100, { tool_use_id: "other" }));
    await wd.sweep(950_000);
    expect(rec.restart).toHaveLength(1);
  });

  it("response.turn_end clears everything outstanding", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    wd.ingest(evt("response.turn_end", 5, {}));
    await wd.sweep(950_000);
    expect(rec.restart).toHaveLength(0);
  });

  it("session.init clears stale outstanding tools", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    wd.ingest(evt("session.init", 1, {}));
    await wd.sweep(950_000);
    expect(rec.restart).toHaveLength(0);
  });
});

/* ── sweep → handleKill (auto-discovery orchestration) ─────────────────── */

interface Recorder {
  restart: Array<{ agentId: string; opts: { reason: string; forensic?: unknown } }>;
  forensicCount: number;
  recordKill: number;
  notify: Array<{ level: string; message: string }>;
}

function recordingDeps(opts?: {
  snapshot?: ForensicSnapshot;
  outcome?: StallKillOutcome;
  restartThrows?: boolean;
}): { deps: StallWatchdogDeps; rec: Recorder } {
  const rec: Recorder = { restart: [], forensicCount: 0, recordKill: 0, notify: [] };
  const deps: StallWatchdogDeps = {
    subscribe: () => () => {},
    restart: async (agentId, o) => {
      rec.restart.push({ agentId, opts: o });
      if (opts?.restartThrows) throw new Error("restart failed");
    },
    captureForensic: async () => {
      rec.forensicCount++;
      return opts?.snapshot ?? { cpuAdvancing: false, outputRecencyMs: 9_000_000 };
    },
    recordKill: async () => {
      rec.recordKill++;
      return opts?.outcome ?? { classification: "genuine_wedge" };
    },
    notify: (level, message) => rec.notify.push({ level, message }),
    now: () => 0,
  };
  return { deps, rec };
}

describe("StallWatchdog kill orchestration", () => {
  it("stalled Bash → capture → restart(reason=stall) → recordKill", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000);
    expect(rec.forensicCount).toBe(1);
    expect(rec.restart).toHaveLength(1);
    expect(rec.restart[0]?.opts.reason).toBe("stall");
    expect(rec.recordKill).toBe(1);
    expect(rec.notify.some((n) => /genuine wedge/.test(n.message))).toBe(true);
  });

  it("suspected false positive flags a ceiling-raise suggestion", async () => {
    const { deps, rec } = recordingDeps({
      snapshot: { cpuAdvancing: true, outputRecencyMs: 500 },
      outcome: { classification: "suspected_false_positive", suggestedKillSeconds: 1800 },
    });
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000);
    const flag = rec.notify.find((n) => n.level === "critical");
    expect(flag).toBeDefined();
    const msg = flag?.message ?? "";
    expect(msg).toContain("raise");
    expect(msg).toContain("stallWatchdog.ceilings.bash.killSeconds");
    expect(msg).toContain("1800");
  });

  it("does not restart twice for the same session across overlapping sweeps", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await Promise.all([wd.sweep(950_000), wd.sweep(960_000)]);
    expect(rec.restart).toHaveLength(1);
  });

  it("action=warn never restarts, but still flags at the kill ceiling", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog({ ...DEFAULT_STALL_CONFIG, action: "warn" }, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000);
    expect(rec.restart).toHaveLength(0);
    expect(rec.notify.some((n) => n.level === "critical" && /NOT restarting/.test(n.message))).toBe(
      true,
    );
  });

  it("warns only once per outstanding tool", async () => {
    const { deps, rec } = recordingDeps();
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(400_000); // warn band
    await wd.sweep(500_000); // still warn band
    expect(rec.notify.filter((n) => n.level === "warn").length).toBe(1);
    expect(rec.restart).toHaveLength(0);
  });

  it("a failed restart is surfaced as critical, not swallowed", async () => {
    const { deps, rec } = recordingDeps({ restartThrows: true });
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000);
    expect(
      rec.notify.some((n) => n.level === "critical" && /FAILED to restart/.test(n.message)),
    ).toBe(true);
    expect(rec.recordKill).toBe(0); // classification skipped when restart failed
  });

  it("after a failed restart, backs off — no re-kill/re-notify within the cooldown", async () => {
    const { deps, rec } = recordingDeps({ restartThrows: true });
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000); // first kill attempt → restart throws, stamps cooldown
    // Second sweep 60s later — still inside the 300s cooldown → suppressed.
    await wd.sweep(1_010_000);
    expect(rec.restart).toHaveLength(1); // NOT retried
    const crit = rec.notify.filter(
      (n) => n.level === "critical" && /FAILED to restart/.test(n.message),
    );
    expect(crit).toHaveLength(1); // NOT re-alerted (no storm)
  });

  it("retries the kill once the cooldown elapses", async () => {
    const { deps, rec } = recordingDeps({ restartThrows: true });
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000); // fail → cooldown from t=950_000
    await wd.sweep(1_300_000); // +350s > 300s cooldown → retried
    expect(rec.restart).toHaveLength(2);
  });
});
