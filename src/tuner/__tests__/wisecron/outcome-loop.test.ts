import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import { OutcomeRecorder } from "../../wisecron/outcome-loop.js";
import { Registry } from "../../../skills-tuner/core/registry.js";
import { AuditLog } from "../../../skills-tuner/core/audit-log.js";
import { TunableSubject, type RiskTier } from "../../../skills-tuner/core/interfaces.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../../skills-tuner/core/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../../skills-tuner/core/telemetry.js";

class NullProvider implements TelemetryProvider {
  contractVersion() {
    return "1.0.0";
  }
  capabilities() {
    return [];
  }
  async query() {
    return [];
  }
}

/** Subject whose measureFitness returns scripted values per measurement call. */
class ScriptedSubject extends TunableSubject {
  measureCalls = 0;
  constructor(
    readonly name: string,
    readonly risk_tier: RiskTier,
    private readonly metrics: Metric[],
    private readonly script: Array<Record<string, number>>,
  ) {
    super();
  }
  override fitnessSignals(): Metric[] {
    return this.metrics;
  }
  override async measureFitness(
    _r: DateRange,
    _p: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const v = this.script[Math.min(this.measureCalls, this.script.length - 1)]!;
    this.measureCalls += 1;
    return v;
  }
  // Report a plausible N per declared metric by default so pipeline tests
  // exercise verdict *direction*, not the underpowered gate (an untracked metric
  // — undefined count — is now treated as underpowered). Tests that target the
  // gate itself use a no-count subject or a direct decideVerdict unit test.
  async measureFitnessCounts(): Promise<Record<string, number>> {
    return Object.fromEntries(this.metrics.map((m) => [m.name, 2]));
  }
  async collectObservations(): Promise<Observation[]> {
    return [];
  }
  async detectProblems(): Promise<Cluster[]> {
    return [];
  }
  async proposeChange(): Promise<UnsignedProposal> {
    throw new Error("n/a");
  }
  async apply(): Promise<Patch> {
    throw new Error("n/a");
  }
  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }
}

/** ScriptedSubject that also reports a fixed sample count per metric. */
class CountingScriptedSubject extends ScriptedSubject {
  constructor(
    name: string,
    risk_tier: RiskTier,
    metrics: Metric[],
    script: Array<Record<string, number>>,
    private readonly counts: Record<string, number>,
  ) {
    super(name, risk_tier, metrics, script);
  }
  async measureFitnessCounts(): Promise<Record<string, number>> {
    return this.counts;
  }
}

function proposal(id: number, subject: string): Proposal {
  return {
    id,
    cluster_id: `c-${id}`,
    subject,
    kind: "patch",
    target_path: `/tmp/${subject}`,
    alternatives: [{ id: "a", label: "a", diff_or_content: "x", tradeoff: "" }],
    pattern_signature: `${subject}:${id}`,
    created_at: new Date(),
    signature: "sig",
  };
}

const cost: Metric = {
  name: "cron_cost",
  source: "session_cost",
  kind: "verifiable",
  direction: "lower_is_better",
  windowDays: 7,
  guardrails: ["critical_fire_success"],
};
const guardrail: Metric = {
  name: "critical_fire_success",
  source: "cron_run",
  kind: "verifiable",
  direction: "higher_is_better",
  windowDays: 7,
};

let dir: string;
let db: WisecronStateDB;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outcome-loop-"));
  db = new WisecronStateDB(join(dir, "wisecron.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("OutcomeRecorder — baseline → maturation → verdict", () => {
  it("snapshots a baseline row per active metric at apply", async () => {
    const registry = new Registry();
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [cost, guardrail],
      [{ cron_cost: 100, critical_fire_success: 1 }],
    );
    registry.registerSubject(subj);
    const rec = new OutcomeRecorder(
      registry,
      db,
      new NullProvider(),
      new AuditLog(),
      () => new Date("2026-05-01T00:00:00Z"),
    );

    // session_cost stream NOT advertised → cost inactive; cron_run NOT advertised → guardrail inactive.
    // So with NullProvider, no baseline rows are written (both are stream metrics).
    await rec.snapshotBaseline(proposal(1, "cron"));
    expect(db.getOutcomes("1").length).toBe(0);
  });

  it("verdict=improved when target drops and guardrail holds", async () => {
    const registry = new Registry();
    // Provider advertising both streams so metrics activate.
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        { stream: "session_cost", schemaVersion: "1.0.0", available: true },
        { stream: "cron_run", schemaVersion: "1.0.0", available: true },
      ],
      query: async () => [],
    };
    // call 1 = baseline (cost 100, guard 1.0), call 2 = post (cost 70, guard 1.0)
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [cost, guardrail],
      [
        { cron_cost: 100, critical_fire_success: 1.0 },
        { cron_cost: 70, critical_fire_success: 1.0 },
      ],
    );
    registry.registerSubject(subj);
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, audit, () => t);

    await rec.snapshotBaseline(proposal(1, "cron"), "abc123");
    expect(db.getOutcomes("1").length).toBe(2); // cost + guardrail

    // advance past the 7d window
    t = new Date("2026-05-10T00:00:00Z");
    const reverts: string[] = [];
    const results = await rec.runMaturation({
      revert: async (id) => {
        reverts.push(id);
        return true;
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe("improved");
    expect(reverts).toEqual([]); // no revert on improvement
    expect(audit.all().some((r) => r.event === "verdict" && r.detail?.verdict === "improved")).toBe(
      true,
    );
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("verdict=regressed and LOW-risk auto-reverts", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const lowCost: Metric = { ...cost, guardrails: [] };
    const subj = new ScriptedSubject(
      "memory",
      "low",
      [lowCost],
      [{ cron_cost: 100 }, { cron_cost: 150 }],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);

    await rec.snapshotBaseline(proposal(2, "memory"));
    t = new Date("2026-05-10T00:00:00Z");
    let routedTier: RiskTier | null = null;
    const results = await rec.runMaturation({
      revert: async (_id, tier) => {
        routedTier = tier;
        return tier === "low"; // low auto-reverts
      },
    });
    expect(results[0]?.verdict).toBe("regressed");
    expect(routedTier).toBe("low");
    expect(results[0]?.reverted).toBe(true);
  });

  it("verdict=regressed and HIGH-risk enqueues for human (no auto-revert)", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const highCost: Metric = { ...cost, guardrails: [] };
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [highCost],
      [{ cron_cost: 100 }, { cron_cost: 150 }],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const audit = new AuditLog();
    const rec = new OutcomeRecorder(registry, db, provider, audit, () => t);

    await rec.snapshotBaseline(proposal(3, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({
      revert: async (_id, tier) => tier === "low", // high → false (enqueued)
    });
    expect(results[0]?.verdict).toBe("regressed");
    expect(results[0]?.reverted).toBe(false);
    expect(
      audit.all().some((r) => r.event === "revert" && r.actor === "system:enqueued-for-human"),
    ).toBe(true);
  });

  it("guardrail regression overrides an improved target", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        { stream: "session_cost", schemaVersion: "1.0.0", available: true },
        { stream: "cron_run", schemaVersion: "1.0.0", available: true },
      ],
      query: async () => [],
    };
    // cost drops 100→50 (good) but guardrail 1.0→0.4 (bad) → regressed
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [cost, guardrail],
      [
        { cron_cost: 100, critical_fire_success: 1.0 },
        { cron_cost: 50, critical_fire_success: 0.4 },
      ],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(4, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results[0]?.verdict).toBe("regressed");
  });

  it("a flat target is neutral and not reverted when a guardrail drifts (low tier)", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        { stream: "session_cost", schemaVersion: "1.0.0", available: true },
        { stream: "cron_run", schemaVersion: "1.0.0", available: true },
      ],
      query: async () => [],
    };
    // cost unchanged 100→100 (no effect) while guardrail drifts 1.0→0.4
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [cost, guardrail],
      [
        { cron_cost: 100, critical_fire_success: 1.0 },
        { cron_cost: 100, critical_fire_success: 0.4 },
      ],
    );
    registry.registerSubject(subj);
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, audit, () => t);
    await rec.snapshotBaseline(proposal(5, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const reverts: string[] = [];
    const results = await rec.runMaturation({
      revert: async (id) => {
        reverts.push(id);
        return true;
      },
    });
    expect(results[0]?.verdict).toBe("neutral");
    expect(reverts).toEqual([]);
    // The drift is not attributed to the change, but it stays visible.
    const v = audit.all().find((r) => r.event === "verdict");
    expect(v?.detail?.reason).toBe("target_flat");
    expect(v?.detail?.regressed_guardrails).toEqual(["critical_fire_success"]);
  });

  it("does not mature rows before their window_end", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const c: Metric = { ...cost, guardrails: [] };
    const subj = new ScriptedSubject("cron", "high", [c], [{ cron_cost: 100 }, { cron_cost: 50 }]);
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(5, "cron"));
    // only 2 days later — window is 7d
    t = new Date("2026-05-03T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results).toEqual([]);
    expect(db.getOutcomes("5")[0]?.verdict).toBeNull();
  });

  // ── fix 2: minimum-N guard threaded end-to-end ────────────────────────────
  it("does not decide on N=1 even when the target improved (sample-size guard)", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const c: Metric = { ...cost, guardrails: [] };
    // cost drops 100→50 (would be 'improved') but only 1 sample backs it.
    const subj = new CountingScriptedSubject(
      "cron",
      "high",
      [c],
      [{ cron_cost: 100 }, { cron_cost: 50 }],
      { cron_cost: 1 },
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    // minSamples defaults to 2.
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(6, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results[0]?.verdict).toBe("neutral");
  });

  // ── fix 3: un-measurable row finalizes after the grace period ─────────────
  it("finalizes an un-measurable row to neutral after grace so it exits pending", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const c: Metric = { ...cost, guardrails: [] };
    // baseline measures, but the post window yields NOTHING (telemetry gap).
    const subj = new ScriptedSubject("cron", "high", [c], [{ cron_cost: 100 }, {}]);
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    // grace = 0 days → finalize as soon as window_end passes.
    const rec = new OutcomeRecorder(
      registry,
      db,
      provider,
      new AuditLog(),
      () => t,
      undefined,
      2,
      0,
    );
    await rec.snapshotBaseline(proposal(7, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results).toEqual([]); // no target to decide
    expect(db.getOutcomes("7")[0]?.verdict).toBe("neutral"); // terminal, not NULL
    expect(db.listMaturableOutcomes(t)).toHaveLength(0); // exited the pending set
  });

  it("keeps an un-measurable row pending while still inside the grace period", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    const c: Metric = { ...cost, guardrails: [] };
    const subj = new ScriptedSubject("cron", "high", [c], [{ cron_cost: 100 }, {}]);
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    // grace = 30 days.
    const rec = new OutcomeRecorder(
      registry,
      db,
      provider,
      new AuditLog(),
      () => t,
      undefined,
      2,
      30,
    );
    await rec.snapshotBaseline(proposal(8, "cron"));
    // window_end = 05-08; asOf = 05-10 is past it but well within 30d grace.
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results).toEqual([]);
    expect(db.getOutcomes("8")[0]?.verdict).toBeNull(); // still pending
    expect(db.listMaturableOutcomes(t)).toHaveLength(1);
  });

  // ── fix 4: explicit target selection, not declaration order ───────────────
  it("selects the target by guardrail relationship, not declaration order", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        { stream: "session_cost", schemaVersion: "1.0.0", available: true },
        { stream: "cron_run", schemaVersion: "1.0.0", available: true },
      ],
      query: async () => [],
    };
    // Guardrail metric declared FIRST — under declaration order it would wrongly
    // be treated as the target. `cost` declares guardrails → it is the target.
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [guardrail, cost],
      [
        { cron_cost: 100, critical_fire_success: 1.0 },
        { cron_cost: 70, critical_fire_success: 1.0 },
      ],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(9, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results[0]?.target_metric).toBe("cron_cost");
    expect(results[0]?.verdict).toBe("improved");
  });

  it("honors an explicit isTarget flag over declaration order", async () => {
    const registry = new Registry();
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async () => [],
    };
    // Two bare metrics, neither declares/uses guardrails. `alpha` is declared
    // first but `beta` carries isTarget → beta must be the decided metric.
    const alpha: Metric = {
      name: "alpha",
      source: "session_cost",
      kind: "verifiable",
      direction: "lower_is_better",
      windowDays: 7,
    };
    const beta: Metric & { isTarget?: boolean } = {
      name: "beta",
      source: "session_cost",
      kind: "verifiable",
      direction: "lower_is_better",
      windowDays: 7,
      isTarget: true,
    };
    const subj = new ScriptedSubject(
      "cron",
      "high",
      [alpha, beta],
      [
        { alpha: 100, beta: 100 },
        { alpha: 100, beta: 70 }, // alpha flat, beta improves
      ],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(10, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results[0]?.target_metric).toBe("beta");
    expect(results[0]?.verdict).toBe("improved");
  });
});

describe("OutcomeRecorder — a guardrail never becomes the verdict target", () => {
  const artifactProvider: TelemetryProvider = {
    contractVersion: () => "1.0.0",
    capabilities: () => [
      { stream: "session_cost", schemaVersion: "1.0.0", available: true },
      { stream: "cron_run", schemaVersion: "1.0.0", available: true },
    ],
    query: async () => [],
  };

  it("a guardrail that matures without its target is not judged or reverted", async () => {
    const registry = new Registry();
    // The target is un-measurable this pass; only the guardrail has a post value.
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [cost, guardrail],
      [{ cron_cost: 100, critical_fire_success: 171 }, { critical_fire_success: 102 }],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, artifactProvider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(21, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    const reverted: string[] = [];
    const results = await rec.runMaturation({
      revert: async (id) => {
        reverted.push(id);
        return true;
      },
    });
    expect(results).toEqual([]);
    expect(reverted).toEqual([]);
    // The target is still inside its grace period: the guardrail waits for it.
    const g = db.getOutcomes("21").find((r) => r.metric === "critical_fire_success");
    expect(g?.verdict).toBeNull();
  });

  it("judges the target with a guardrail that matured on an earlier pass", async () => {
    const registry = new Registry();
    const longCost: Metric = { ...cost, windowDays: 14 };
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [longCost, guardrail],
      [
        { cron_cost: 100, critical_fire_success: 1.0 },
        { cron_cost: 100, critical_fire_success: 0.4 },
        { cron_cost: 50, critical_fire_success: 0.4 },
      ],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, artifactProvider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(40, "cron"));
    t = new Date("2026-05-09T00:00:00Z"); // guardrail (7 d) matured, target (14 d) not yet
    expect(await rec.runMaturation({})).toEqual([]);
    const g = db.getOutcomes("40").find((r) => r.metric === "critical_fire_success");
    expect(g?.verdict).toBeNull();
    t = new Date("2026-05-16T00:00:00Z");
    const results = await rec.runMaturation({});
    expect(results[0]?.target_metric).toBe("cron_cost");
    expect(results[0]?.verdict).toBe("regressed"); // improved target, vetoed by the guardrail
  });

  it("does not fall back to another metric while the isTarget metric is pending", async () => {
    const registry = new Registry();
    const alpha: Metric = { ...cost, name: "alpha", guardrails: undefined };
    const beta: Metric & { isTarget?: boolean } = {
      ...cost,
      name: "beta",
      guardrails: undefined,
      windowDays: 14,
      isTarget: true,
    };
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [alpha, beta],
      [
        { alpha: 100, beta: 100 },
        { alpha: 150, beta: 100 }, // alpha (not the target) regressed
      ],
    );
    registry.registerSubject(subj);
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, artifactProvider, new AuditLog(), () => t);
    await rec.snapshotBaseline(proposal(42, "cron"));
    t = new Date("2026-05-09T00:00:00Z"); // alpha (7 d) matured, beta (14 d) not yet
    expect(await rec.runMaturation({})).toEqual([]);
    expect(db.getOutcomes("42").every((r) => r.verdict === null)).toBe(true);
  });

  it("says so when a proposal's rows matured but none of them is a target", async () => {
    const registry = new Registry();
    const bare: Metric = { ...guardrail, name: "only_guard" };
    const owner: Metric = { ...cost, name: "owner", guardrails: ["only_guard"] };
    // `owner` is declared but never measured → its row never exists.
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [owner, bare],
      [{ only_guard: 1 }, { only_guard: 1 }],
    );
    registry.registerSubject(subj);
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, artifactProvider, audit, () => t);
    await rec.snapshotBaseline(proposal(41, "cron"));
    t = new Date("2026-05-10T00:00:00Z");
    expect(await rec.runMaturation({})).toEqual([]);
    const v = audit.all().filter((r) => r.event === "verdict" && r.proposal_id === "41");
    expect((v[0]?.detail as Record<string, unknown>).reason).toBe("no_target");
    expect(db.getOutcomes("41").every((r) => r.verdict === "neutral")).toBe(true);
  });

  it("closes a held guardrail without a verdict once its target times out", async () => {
    const registry = new Registry();
    // The target is never measurable after apply; the guardrail regressed.
    const subj = new ScriptedSubject(
      "cron",
      "low",
      [cost, guardrail],
      [{ cron_cost: 100, critical_fire_success: 171 }, { critical_fire_success: 102 }],
    );
    registry.registerSubject(subj);
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, artifactProvider, audit, () => t);
    await rec.snapshotBaseline(proposal(43, "cron"));
    const reverted: string[] = [];
    const revert = async (id: string): Promise<boolean> => {
      reverted.push(id);
      return true;
    };
    t = new Date("2026-05-10T00:00:00Z"); // inside the 7 d grace: guardrail held
    expect(await rec.runMaturation({ revert })).toEqual([]);
    t = new Date("2026-05-16T00:00:00Z"); // past window_end + grace: target closed
    expect(await rec.runMaturation({ revert })).toEqual([]);
    expect(reverted).toEqual([]);
    expect(db.getOutcomes("43").every((r) => r.verdict === "neutral")).toBe(true);
    const reasons = audit
      .all()
      .filter((r) => r.event === "verdict" && r.proposal_id === "43")
      .map((r) => (r.detail as Record<string, unknown>).reason);
    expect(reasons).toEqual(["unmeasurable_after_grace", "no_target"]);
  });
});
