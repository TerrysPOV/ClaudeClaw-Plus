import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WisecronStateDB } from "../../wisecron/state-db.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("outcomes ledger — migration + ops", () => {
  it("migration is idempotent: reopening the DB does not error or drop data", () => {
    const path = join(dir, "wisecron.db");
    const a = new WisecronStateDB(path);
    a.snapshotBaseline({
      proposal_id: "1",
      metric: "cron_cost",
      subject: "cron",
      baseline: 100,
      window_start: new Date("2026-05-01"),
      window_end: new Date("2026-05-08"),
    });
    a.close();
    // reopen → CREATE TABLE IF NOT EXISTS must be a no-op and data survives
    const b = new WisecronStateDB(path);
    expect(b.getOutcomes("1")).toHaveLength(1);
    expect(b.getOutcomes("1")[0]!.baseline).toBe(100);
    b.close();
  });

  it("snapshotBaseline upsert refreshes baseline, leaves verdict null", () => {
    const db = new WisecronStateDB(join(dir, "w.db"));
    const win = { window_start: new Date("2026-05-01"), window_end: new Date("2026-05-08") };
    db.snapshotBaseline({ proposal_id: "1", metric: "m", subject: "cron", baseline: 100, ...win });
    db.snapshotBaseline({ proposal_id: "1", metric: "m", subject: "cron", baseline: 120, ...win });
    const rows = db.getOutcomes("1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.baseline).toBe(120);
    expect(rows[0]!.verdict).toBeNull();
    db.close();
  });

  it("listMaturableOutcomes returns only NULL-verdict rows past window_end", () => {
    const db = new WisecronStateDB(join(dir, "w.db"));
    db.snapshotBaseline({
      proposal_id: "1",
      metric: "m",
      subject: "cron",
      baseline: 1,
      window_start: new Date("2026-05-01"),
      window_end: new Date("2026-05-08"),
    });
    db.snapshotBaseline({
      proposal_id: "2",
      metric: "m",
      subject: "cron",
      baseline: 1,
      window_start: new Date("2026-05-01"),
      window_end: new Date("2026-06-01"),
    });
    const due = db.listMaturableOutcomes(new Date("2026-05-09"));
    expect(due.map((r) => r.proposal_id)).toEqual(["1"]);
    db.finalizeOutcome({ proposal_id: "1", metric: "m", post: 2, delta: 1, verdict: "improved" });
    expect(db.listMaturableOutcomes(new Date("2026-05-09"))).toHaveLength(0);
    db.close();
  });

  it("priors EWMA-update accumulates n and blends delta", () => {
    const db = new WisecronStateDB(join(dir, "w.db"));
    db.upsertPrior("cron", "patch", 1.0, 0.5);
    db.upsertPrior("cron", "patch", 0.0, 0.5);
    const p = db.getPrior("cron", "patch")!;
    expect(p.n).toBe(2);
    expect(p.ewma_delta).toBeCloseTo(0.5, 5); // 0.5*0 + 0.5*1.0
    expect(db.getPrior("cron", "missing")).toBeNull();
    db.close();
  });
});
