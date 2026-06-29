import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCostTelemetryProvider } from "../../wisecron/session-cost-provider.js";
import { TELEMETRY_CONTRACT_VERSION } from "../../../skills-tuner/core/telemetry.js";

let dir: string;
let dbPath: string;

function seed(rows: Array<{ date: string; job: string; model: string; cost: number }>): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL, job TEXT NOT NULL, model TEXT NOT NULL,
    cost_usd REAL DEFAULT 0
  );`);
  const ins = db.prepare(
    "INSERT INTO session_costs(session_id, date, job, model, cost_usd) VALUES (?,?,?,?,?)",
  );
  rows.forEach((r, i) => {
    ins.run(`s-${i}`, r.date, r.job, r.model, r.cost);
  });
  db.close();
}

const range = (startDay: string, endDay: string) => ({
  start: new Date(`${startDay}T00:00:00.000Z`),
  end: new Date(`${endDay}T00:00:00.000Z`),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-cost-"));
  dbPath = join(dir, "costs.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionCostTelemetryProvider — capabilities", () => {
  it("advertises session_cost available when the store has rows", () => {
    seed([{ date: "2026-05-20", job: "bootstrap", model: "sonnet", cost: 1.5 }]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    const caps = p.capabilities();
    const cost = caps.find((c) => c.stream === "session_cost")!;
    expect(cost.available).toBe(true);
    expect(cost.schemaVersion).toBe(TELEMETRY_CONTRACT_VERSION);
    p.close();
  });

  it("degrades session_cost to unavailable with a reason when the store is absent", () => {
    const p = new SessionCostTelemetryProvider({ dbPath: join(dir, "nope.db") });
    const cost = p.capabilities().find((c) => c.stream === "session_cost")!;
    expect(cost.available).toBe(false);
    expect(cost.reason).toMatch(/not found/);
    p.close();
  });

  it("degrades to unavailable with a reason when the table is empty", () => {
    seed([]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    const cost = p.capabilities().find((c) => c.stream === "session_cost")!;
    expect(cost.available).toBe(false);
    expect(cost.reason).toMatch(/empty/);
    p.close();
  });

  it("advertises every other contract stream as unavailable (no producer)", () => {
    seed([{ date: "2026-05-20", job: "x", model: "opus", cost: 1 }]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    const caps = p.capabilities();
    const others = caps.filter((c) => c.stream !== "session_cost");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.available === false && !!c.reason)).toBe(true);
    p.close();
  });
});

describe("SessionCostTelemetryProvider — query", () => {
  it("returns samples in the window with value=cost and labels={job,model}", async () => {
    seed([
      { date: "2026-05-18", job: "bootstrap", model: "sonnet", cost: 2.0 },
      { date: "2026-05-20", job: '<channel source="cron" id=1>', model: "opus", cost: 5.0 },
      { date: "2026-06-01", job: "later", model: "opus", cost: 99 }, // out of window
    ]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    const samples = await p.query("session_cost", range("2026-05-17", "2026-05-25"));
    expect(samples).toHaveLength(2);
    expect(samples[1]!.value).toBe(5.0);
    expect(samples[1]!.labels).toEqual({ job: '<channel source="cron" id=1>', model: "opus" });
    p.close();
  });

  it("applies exact label filters on job and model when supplied", async () => {
    seed([
      { date: "2026-05-20", job: "gmail", model: "sonnet", cost: 1 },
      { date: "2026-05-20", job: "gmail", model: "opus", cost: 2 },
      { date: "2026-05-20", job: "diag", model: "opus", cost: 3 },
    ]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    const r = await p.query("session_cost", range("2026-05-19", "2026-05-21"), {
      job: "gmail",
      model: "opus",
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe(2);
    p.close();
  });

  it("returns [] for any non-session_cost stream (no producer)", async () => {
    seed([{ date: "2026-05-20", job: "x", model: "opus", cost: 1 }]);
    const p = new SessionCostTelemetryProvider({ dbPath });
    expect(await p.query("cron_run", range("2026-05-19", "2026-05-21"))).toEqual([]);
    expect(await p.query("hook_exec", range("2026-05-19", "2026-05-21"))).toEqual([]);
    p.close();
  });

  it("returns [] (does not throw) when the store is absent", async () => {
    const p = new SessionCostTelemetryProvider({ dbPath: join(dir, "missing.db") });
    expect(await p.query("session_cost", range("2026-05-19", "2026-05-21"))).toEqual([]);
    p.close();
  });
});
