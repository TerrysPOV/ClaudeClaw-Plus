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
    expect(results[0]!.verdict).toBe("improved");
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
    expect(results[0]!.verdict).toBe("regressed");
    expect(routedTier).toBe("low");
    expect(results[0]!.reverted).toBe(true);
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
    expect(results[0]!.verdict).toBe("regressed");
    expect(results[0]!.reverted).toBe(false);
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
    expect(results[0]!.verdict).toBe("regressed");
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
    expect(db.getOutcomes("5")[0]!.verdict).toBeNull();
  });
});
