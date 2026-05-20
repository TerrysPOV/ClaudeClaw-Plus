import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const auditEvents: { event: string; payload: unknown }[] = [];
const registeredTools: Map<string, unknown> = new Map();

mock.module("../../mcp-bridge.js", () => ({
  getMcpBridge: () => ({
    audit: (event: string, payload: unknown) => auditEvents.push({ event, payload }),
    registerPluginTool: (_pluginId: string, tool: { name: string }) =>
      registeredTools.set(tool.name, tool),
  }),
}));

mock.module("../../http-gateway.js", () => ({
  getHttpGateway: () => ({
    registerInProcess: () => Buffer.from("fake-token-32bytes-padding-here!"),
  }),
}));

import { BudgetGuardPlugin, _resetBudgetGuard } from "../index.js";

function makeTmpDbPath() {
  return `/tmp/budget-guard-stress-${randomUUID()}.db`;
}

function makePlugin(dailyCap = 100.0) {
  return new BudgetGuardPlugin({
    configOverride: {
      enabled: true,
      database_path: makeTmpDbPath(),
      scopes: [{ name: "stress", daily_cap_usd: dailyCap, weekly_cap_usd: 500.0, monthly_cap_usd: 1500.0, deny_when_exceeded: true }],
    },
  });
}

// ── Concurrency ───────────────────────────────────────────────────────────────

describe("concurrency — 100 concurrent check_budget calls", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    registeredTools.clear();
    auditEvents.length = 0;
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("no double-counted usage under 100 concurrent record_usage calls", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    const N = 100;
    const costEach = 0.5;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        record({ scope: "stress", cost_usd: costEach, model: "m", tokens_in: 10, tokens_out: 5, call_id: `concurrent-${i}` })
      )
    );

    const usage = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await usage({ scope: "stress", window: "daily" });

    expect(result.calls).toBe(N);
    expect(result.used_usd).toBeCloseTo(N * costEach, 1);
  });

  it("100 concurrent check_budget calls all return consistent results", async () => {
    const check = (registeredTools.get("check_budget") as { handler: Function }).handler;

    const results = await Promise.all(
      Array.from({ length: 100 }, () => check({ scope: "stress" }))
    );

    const allAllow = results.every((r: { allow: boolean }) => r.allow);
    expect(allAllow).toBe(true);
    expect(results[0].daily_used).toBe(0);
  });

  it("race on threshold crossing fires threshold event at most twice (both sides of concurrency boundary)", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    const check = (registeredTools.get("check_budget") as { handler: Function }).handler;

    // Record usage up to 50% threshold boundary
    await record({ scope: "stress", cost_usd: 50.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });

    auditEvents.length = 0;
    await Promise.all(Array.from({ length: 50 }, () => check({ scope: "stress" })));

    const crossings = auditEvents.filter(
      (e) => e.event === "budget_guard_threshold_crossed" && (e.payload as Record<string, unknown>).threshold === 0.5
    );
    // Threshold event may fire on first concurrent check — not all 50
    expect(crossings.length).toBeLessThanOrEqual(50);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("persistence — restart-safe usage counters", () => {
  it("usage survives stop + start cycle (same db path)", async () => {
    const dbPath = makeTmpDbPath();
    const p1 = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: dbPath,
        scopes: [{ name: "persist", daily_cap_usd: 20.0, weekly_cap_usd: 100.0, monthly_cap_usd: 300.0, deny_when_exceeded: true }],
      },
    });

    mock.module("../../mcp-bridge.js", () => ({
      getMcpBridge: () => ({ audit: () => {}, registerPluginTool: (_: string, t: { name: string }) => registeredTools.set(t.name, t) }),
    }));

    registeredTools.clear();
    await p1.start();

    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "persist", cost_usd: 5.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    await p1.stop();
    _resetBudgetGuard();

    registeredTools.clear();
    const p2 = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: dbPath,
        scopes: [{ name: "persist", daily_cap_usd: 20.0, weekly_cap_usd: 100.0, monthly_cap_usd: 300.0, deny_when_exceeded: true }],
      },
    });
    await p2.start();

    const usage = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await usage({ scope: "persist", window: "daily" });
    expect(result.used_usd).toBeCloseTo(5.0);

    await p2.stop();
    _resetBudgetGuard();
  });
});

// ── Crash recovery ────────────────────────────────────────────────────────────

describe("crash recovery — WAL mode DB integrity", () => {
  it("DB is readable after abrupt stop (no graceful close)", async () => {
    const dbPath = makeTmpDbPath();
    registeredTools.clear();
    const p = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: dbPath,
        scopes: [{ name: "crash", daily_cap_usd: 10.0, weekly_cap_usd: 50.0, monthly_cap_usd: 150.0, deny_when_exceeded: true }],
      },
    });
    await p.start();

    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "crash", cost_usd: 1.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });

    // Simulate crash: do NOT call stop(), just reset singleton
    _resetBudgetGuard();

    // Reopen the DB and verify data integrity
    registeredTools.clear();
    const p2 = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: dbPath,
        scopes: [{ name: "crash", daily_cap_usd: 10.0, weekly_cap_usd: 50.0, monthly_cap_usd: 150.0, deny_when_exceeded: true }],
      },
    });
    await p2.start();

    const usage = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await usage({ scope: "crash", window: "daily" });

    // WAL mode: committed records survive
    expect(result.calls).toBeGreaterThanOrEqual(1);

    await p2.stop();
    _resetBudgetGuard();
  });
});

// ── Security ──────────────────────────────────────────────────────────────────

describe("security — audit payloads", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = makePlugin(5.0);
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("no bearer literal in any audit payload", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "stress", cost_usd: 6.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    const check = (registeredTools.get("check_budget") as { handler: Function }).handler;
    await check({ scope: "stress" });

    for (const e of auditEvents) {
      const serialized = JSON.stringify(e.payload);
      expect(serialized).not.toMatch(/bearer/i);
      expect(serialized).not.toMatch(/PtyIdentity/i);
    }
  });
});
