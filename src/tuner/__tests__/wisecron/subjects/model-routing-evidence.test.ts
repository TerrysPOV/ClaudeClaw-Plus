import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ModelRoutingSubject } from "../../../subjects/model-routing-subject.js";
import type { StructuredEvidence, LocalSignal } from "../../../wisecron/evidence-driven.js";

function makeCostDb(path: string, rows: Array<[string, number]>): void {
  const db = new Database(path);
  db.run("CREATE TABLE session_costs (date TEXT, job TEXT, model TEXT, cost_usd REAL)");
  for (const [date, c] of rows)
    db.run("INSERT INTO session_costs (date, cost_usd) VALUES (?1, ?2)", [date, c]);
  db.close();
}

// Seed dates RELATIVE to today: readDailyCost filters `date >= date('now','-30
// days')`, so hard-coded fixtures would drift out of the window over time and
// make these tests flaky (Copilot review on #292).
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const ev = (o: Partial<StructuredEvidence> = {}): StructuredEvidence => ({
  technique: "cost-aware-routing",
  independentSources: 5,
  highTrustSources: 2,
  provenInProduction: false,
  citations: ["a", "b"],
  ...o,
});
const degraded: LocalSignal = {
  metric: "session_cost_usd",
  value: 8,
  unit: "usd",
  degraded: true,
  trend: "degrading",
  sampledAt: "2026-06-30T00:00:00Z",
};

describe("ModelRoutingSubject — EvidenceDrivenSubject (proactive)", () => {
  let dir: string, dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mr-"));
    dbPath = join(dir, "costs.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const subj = () => new ModelRoutingSubject({ costDbPath: dbPath });

  it("researchSpec declares the routing topic + technique + tiers", () => {
    const spec = subj().researchSpec();
    expect(spec.subject).toBe("model_routing");
    expect(spec.technique).toBe("cost-aware-routing");
    expect(spec.sourceTiers).toContain("enterprise");
  });

  it("localSignal: RISING cost trend → degraded", async () => {
    makeCostDb(dbPath, [
      [daysAgo(7), 1],
      [daysAgo(6), 1],
      [daysAgo(5), 1],
      [daysAgo(4), 1],
      [daysAgo(3), 5],
      [daysAgo(2), 6],
      [daysAgo(1), 7],
      [daysAgo(0), 8],
    ]);
    const sig = await subj().localSignal();
    expect(sig.metric).toBe("session_cost_usd");
    expect(sig.degraded).toBe(true);
    expect(sig.trend).toBe("degrading");
  });

  it("localSignal: FLAT cost → not degraded", async () => {
    makeCostDb(dbPath, [
      [daysAgo(5), 2],
      [daysAgo(4), 2],
      [daysAgo(3), 2],
      [daysAgo(2), 2],
      [daysAgo(1), 2],
      [daysAgo(0), 2],
    ]);
    expect((await subj().localSignal()).degraded).toBe(false);
  });

  it("localSignal: missing DB → graceful (not degraded)", async () => {
    expect(
      (await new ModelRoutingSubject({ costDbPath: join(dir, "nope.db") }).localSignal()).degraded,
    ).toBe(false);
  });

  it("evaluate: degraded + convergent → recommendation", () => {
    const v = subj().evaluate(ev(), degraded);
    expect(v.propose).toBe(true);
    expect(v.kind).toBe("recommendation");
    expect(v.confidence).toBeGreaterThan(0);
  });
  it("evaluate: healthy signal → no proposal", () => {
    expect(subj().evaluate(ev(), { ...degraded, degraded: false }).propose).toBe(false);
  });
  it("evaluate: weak evidence → no proposal", () => {
    expect(
      subj().evaluate(ev({ independentSources: 1, highTrustSources: 0 }), degraded).propose,
    ).toBe(false);
  });
  it("confirm: cost improved (after < before) → true", async () => {
    makeCostDb(dbPath, [
      [daysAgo(1), 1],
      [daysAgo(0), 1],
    ]);
    expect(await subj().confirm({ ...degraded, value: 999 })).toBe(true);
  });
});
