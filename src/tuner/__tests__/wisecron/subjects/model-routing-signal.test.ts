/**
 * Regression tests for model-routing-signal.ts (ultra-review #292 remediation):
 *  - a corrupt / non-SQLite / unreadable cost DB is graceful ([]/not-degraded),
 *    never a throw that stalls the proactive loop (constructor now inside try)
 *  - the absolute `recent > cap` degradation path honours the same >=4-day
 *    sample discipline as the trend path (no single-outlier flip)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readDailyCost, costSignal } from "../../../subjects/model-routing-signal.js";

function makeCostDb(path: string, rows: Array<[string, number]>): void {
  const db = new Database(path);
  db.run("CREATE TABLE session_costs (date TEXT, cost_usd REAL)");
  for (const [date, c] of rows)
    db.run("INSERT INTO session_costs (date, cost_usd) VALUES (?1, ?2)", [date, c]);
  db.close();
}

describe("model-routing-signal — graceful on a bad cost DB (no loop stall)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mr-signal-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a corrupt / non-SQLite existing file returns [] instead of throwing", () => {
    const bad = join(dir, "costs.db");
    writeFileSync(bad, "this is definitely not a sqlite database\n".repeat(10));
    // Constructor throws on this file; the fix keeps it inside the try.
    expect(() => readDailyCost(bad)).not.toThrow();
    expect(readDailyCost(bad)).toEqual([]);
    expect(() => costSignal(bad, 25)).not.toThrow();
    expect(costSignal(bad, 25).degraded).toBe(false);
  });

  it("a missing DB is still graceful", () => {
    expect(readDailyCost(join(dir, "nope.db"))).toEqual([]);
  });
});

describe("model-routing-signal — absolute-cost path needs >=4 days", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mr-signal-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a single outlier day over the cap does NOT set degraded", () => {
    const db = join(dir, "costs.db");
    makeCostDb(db, [["2026-06-30", 30]]); // one day, $30, cap 25
    const sig = costSignal(db, 25);
    expect(sig.days).toBe(1);
    expect(sig.degraded).toBe(false); // pre-fix this was true
  });

  it("recent-over-cap DOES degrade once >=4 days are present", () => {
    const db = join(dir, "costs.db");
    makeCostDb(db, [
      ["2026-06-27", 2],
      ["2026-06-28", 2],
      ["2026-06-29", 2],
      ["2026-06-30", 30], // recent day well over cap, with enough history
    ]);
    const sig = costSignal(db, 25);
    expect(sig.days).toBe(4);
    expect(sig.degraded).toBe(true);
  });
});
