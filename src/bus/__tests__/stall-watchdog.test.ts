import { describe, it, expect } from "bun:test";
import type { BusEvent, BusEventTopic } from "../types";
import {
  classifyTool,
  ceilingFor,
  evaluateStall,
  newSessionState,
  StallWatchdog,
  DEFAULT_STALL_CONFIG,
  parseStallWatchdogConfig,
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
  for (const t of tools) s.outstanding.set(t.id, { ...t, warned: false, criticalWarned: false });
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

/* ── parseStallWatchdogConfig ──────────────────────────────────────────── */

describe("parseStallWatchdogConfig", () => {
  it("returns defaults for missing/invalid input", () => {
    expect(parseStallWatchdogConfig(undefined)).toEqual(DEFAULT_STALL_CONFIG);
    expect(parseStallWatchdogConfig(null)).toEqual(DEFAULT_STALL_CONFIG);
    expect(parseStallWatchdogConfig("nope")).toEqual(DEFAULT_STALL_CONFIG);
  });

  it("applies valid overrides and falls back per-field on garbage", () => {
    const c = parseStallWatchdogConfig({
      enabled: false,
      sweepIntervalMs: 5000,
      action: "warn",
      ceilings: { bash: { warnSeconds: 120, killSeconds: 600 }, fast: { killSeconds: "bad" } },
      autoDiscovery: { enabled: false, cpuProbeMs: 2000 },
      restartFailureCooldownMs: 60_000,
    });
    expect(c.enabled).toBe(false);
    expect(c.sweepIntervalMs).toBe(5000);
    expect(c.action).toBe("warn");
    expect(c.ceilings.bash).toEqual({ warnSeconds: 120, killSeconds: 600 });
    // fast.killSeconds was garbage → whole field falls back to the default ceiling.
    expect(c.ceilings.fast).toEqual(DEFAULT_STALL_CONFIG.ceilings.fast);
    expect(c.autoDiscovery).toEqual({ enabled: false, cpuProbeMs: 2000 });
    expect(c.restartFailureCooldownMs).toBe(60_000);
  });

  it("rejects out-of-range / wrong-type scalars", () => {
    const c = parseStallWatchdogConfig({
      sweepIntervalMs: 10, // below the 1000ms floor → default
      action: "explode", // invalid enum → default
      autoDiscovery: { cpuProbeMs: 5 }, // below the 100ms floor → default
    });
    expect(c.sweepIntervalMs).toBe(DEFAULT_STALL_CONFIG.sweepIntervalMs);
    expect(c.action).toBe(DEFAULT_STALL_CONFIG.action);
    expect(c.autoDiscovery.cpuProbeMs).toBe(DEFAULT_STALL_CONFIG.autoDiscovery.cpuProbeMs);
  });

  it("clamps a per-tool warnSeconds above its killSeconds down to kill", () => {
    // warn > kill would be a dead warn (kill fires first) — pin it to the kill line.
    const c = parseStallWatchdogConfig({
      ceilings: { bash: { warnSeconds: 5000, killSeconds: 900 } },
    });
    expect(c.ceilings.bash).toEqual({ warnSeconds: 900, killSeconds: 900 });
  });

  it("floors restartFailureCooldownMs at sweepIntervalMs (no per-sweep alert storm)", () => {
    const c = parseStallWatchdogConfig({ sweepIntervalMs: 30_000, restartFailureCooldownMs: 500 });
    // 500ms < one sweep → rejected → default (which is ≥ one sweep).
    expect(c.restartFailureCooldownMs).toBe(DEFAULT_STALL_CONFIG.restartFailureCooldownMs);
    // A cooldown ≥ the sweep is kept as-is.
    expect(
      parseStallWatchdogConfig({ sweepIntervalMs: 30_000, restartFailureCooldownMs: 45_000 })
        .restartFailureCooldownMs,
    ).toBe(45_000);
  });
});

/* ── restartFailedAt reset invariant (#297 review follow-up) ───────────── */

describe("restartFailedAt does not leak across a failed→succeeded restart cycle", () => {
  it("a re-observed session kills cleanly after an earlier failed restart recovered", async () => {
    const calls: string[] = [];
    let failNext = true;
    const deps: StallWatchdogDeps = {
      subscribe: () => () => {},
      restart: async () => {
        calls.push("restart");
        if (failNext) {
          failNext = false;
          throw new Error("rate-limited");
        }
      },
      captureForensic: async () => ({ cpuAdvancing: false, outputRecencyMs: 9_000_000 }),
      recordKill: async () => ({ classification: "genuine_wedge" }),
      notify: () => {},
      now: () => 0,
    };
    const cfg = { ...DEFAULT_STALL_CONFIG, restartFailureCooldownMs: 10_000 };
    const wd = new StallWatchdog(cfg, deps);

    // t=950s: Bash stalled → kill → restart THROWS → cooldown armed, session kept.
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    await wd.sweep(950_000);
    expect(calls).toHaveLength(1);

    // within cooldown (Δ5s < 10s) → suppressed.
    await wd.sweep(955_000);
    expect(calls).toHaveLength(1);

    // after cooldown (Δ15s > 10s) → retry succeeds → session dropped.
    await wd.sweep(965_000);
    expect(calls).toHaveLength(2);

    // Re-observe the SAME session id with a fresh stalled tool. It must rebuild a
    // clean state (no leftover restartFailedAt/cooldown) and kill normally.
    wd.ingest(evt("response.tool_use", 970_000, { id: "b2", name: "Bash" }));
    await wd.sweep(970_000 + 950_000);
    expect(calls).toHaveLength(3);
  });
});

/* ── stop() during an in-flight kill (Codex P2 on #300) ────────────────── */

describe("stop() while a kill is mid-flight", () => {
  it("does not restart after stop() resolves, and stop() awaits the in-flight kill", async () => {
    let releaseForensic!: () => void;
    const forensicGate = new Promise<void>((r) => {
      releaseForensic = r;
    });
    const calls = { restart: 0, forensic: 0, recordKill: 0 };
    const deps: StallWatchdogDeps = {
      subscribe: () => () => {},
      restart: async () => {
        calls.restart++;
      },
      captureForensic: async () => {
        calls.forensic++;
        await forensicGate; // block the kill mid-flight, at the forensic snapshot
        return { cpuAdvancing: false, outputRecencyMs: 9_000_000 };
      },
      recordKill: async () => {
        calls.recordKill++;
        return { classification: "genuine_wedge" };
      },
      notify: () => {},
      now: () => 0,
    };
    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));

    // Fire a sweep that enters handleKill and blocks at captureForensic.
    const sweepP = wd.sweep(950_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.forensic).toBe(1); // kill is in flight
    expect(calls.restart).toBe(0);

    // Begin teardown while the kill is blocked; stop() must await the in-flight kill.
    const stopP = wd.stop();
    let stopResolved = false;
    void stopP.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false); // stop() is waiting on the in-flight kill

    // Release the snapshot: handleKill resumes and must bail at the stopped-check.
    releaseForensic();
    await stopP;
    await sweepP;

    expect(calls.restart).toBe(0); // no restart started after stop() began
    expect(calls.recordKill).toBe(0); // and the kill aborted before recording
  });

  it("warn-only mode fires BOTH warn and critical for one tool crossing both ceilings (#322)", async () => {
    const { deps, rec } = recordingDeps();
    const warnOnly = { ...DEFAULT_STALL_CONFIG, action: "warn" as const };
    const wd = new StallWatchdog(warnOnly, deps);
    wd.ingest(evt("response.tool_use", 0, { id: "b1", name: "Bash" }));
    // cross the warn ceiling (past 300s, before the 900s kill ceiling) → soft warn
    await wd.sweep((C.bash.warnSeconds + 1) * 1000);
    // later cross the kill ceiling → the critical "NOT restarting" escalation must
    // still fire, even though the soft warn already latched (the #322 bug).
    await wd.sweep((C.bash.killSeconds + 1) * 1000);
    expect(rec.notify.some((n) => n.level === "warn")).toBe(true);
    const crit = rec.notify.find((n) => n.level === "critical");
    expect(crit).toBeDefined();
    expect(crit?.message).toContain("NOT restarting");
  });
});
