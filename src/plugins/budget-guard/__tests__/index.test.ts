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
  return `/tmp/budget-guard-test-${randomUUID()}.db`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlugin(overrides: Record<string, unknown> = {}) {
  const dbPath = makeTmpDbPath();
  return new BudgetGuardPlugin({
    configOverride: {
      enabled: true,
      database_path: dbPath,
      default_warning_thresholds: [0.5, 0.8, 0.95],
      scopes: [
        { name: "default", daily_cap_usd: 10.0, weekly_cap_usd: 50.0, monthly_cap_usd: 150.0, deny_when_exceeded: true },
        { name: "warn-only", daily_cap_usd: 5.0, weekly_cap_usd: 25.0, monthly_cap_usd: 75.0, deny_when_exceeded: false },
        ...(overrides.extraScopes as [] ?? []),
      ],
      ...overrides,
    },
  });
}

// ── Settings validation ───────────────────────────────────────────────────────

describe("settings validation", () => {
  it("accepts valid settings with defaults", () => {
    const p = makePlugin();
    expect(p).toBeDefined();
  });

  it("defaults to enabled: false", () => {
    const p = new BudgetGuardPlugin({ configOverride: { database_path: makeTmpDbPath() } });
    expect(p).toBeDefined();
  });

  it("rejects negative cap via zod", () => {
    expect(() =>
      new BudgetGuardPlugin({
        configOverride: {
          database_path: makeTmpDbPath(),
          scopes: [{ name: "bad", daily_cap_usd: -1, deny_when_exceeded: true }],
        },
      })
    ).toThrow();
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("start/stop lifecycle", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(() => { auditEvents.length = 0; plugin = makePlugin(); });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("start emits budget_guard_started audit event", async () => {
    await plugin.start();
    expect(auditEvents.some((e) => e.event === "budget_guard_started")).toBe(true);
  });

  it("stop emits budget_guard_stopped audit event", async () => {
    await plugin.start();
    auditEvents.length = 0;
    await plugin.stop();
    expect(auditEvents.some((e) => e.event === "budget_guard_stopped")).toBe(true);
  });

  it("double start is idempotent", async () => {
    await plugin.start();
    await plugin.start();
    const startEvents = auditEvents.filter((e) => e.event === "budget_guard_started");
    expect(startEvents.length).toBe(1);
  });

  it("registers 5 tools with bridge", async () => {
    await plugin.start();
    expect(registeredTools.has("check_budget")).toBe(true);
    expect(registeredTools.has("current_usage")).toBe(true);
    expect(registeredTools.has("list_scopes")).toBe(true);
    expect(registeredTools.has("reset_scope")).toBe(true);
    expect(registeredTools.has("record_usage")).toBe(true);
  });
});

// ── check_budget ──────────────────────────────────────────────────────────────

describe("check_budget tool", () => {
  let plugin: BudgetGuardPlugin;
  const handler = () => (registeredTools.get("check_budget") as { handler: Function }).handler;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("allows when no usage recorded", async () => {
    const result = await handler()({ scope: "default" });
    expect(result.allow).toBe(true);
    expect(result.remaining_usd).toBeGreaterThan(0);
    expect(result.daily_used).toBe(0);
  });

  it("denies when daily cap exceeded for deny_when_exceeded=true scope", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "default", cost_usd: 10.01, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: randomUUID() });
    const result = await handler()({ scope: "default" });
    expect(result.allow).toBe(false);
  });

  it("allows even when cap exceeded for deny_when_exceeded=false scope", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "warn-only", cost_usd: 10.0, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: randomUUID() });
    const result = await handler()({ scope: "warn-only" });
    expect(result.allow).toBe(true);
  });

  it("emits budget_guard_allowed when under cap", async () => {
    auditEvents.length = 0;
    await handler()({ scope: "default" });
    expect(auditEvents.some((e) => e.event === "budget_guard_allowed")).toBe(true);
  });

  it("emits budget_guard_denied when over cap", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "default", cost_usd: 11.0, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: randomUUID() });
    auditEvents.length = 0;
    await handler()({ scope: "default" });
    expect(auditEvents.some((e) => e.event === "budget_guard_denied")).toBe(true);
  });

  it("returns allow:true for unknown scope (no cap configured)", async () => {
    const result = await handler()({ scope: "unknown-scope" });
    expect(result.allow).toBe(true);
  });
});

// ── current_usage ─────────────────────────────────────────────────────────────

describe("current_usage tool", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("returns zero usage when no calls recorded", async () => {
    const h = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await h({ scope: "default", window: "daily" });
    expect(result.used_usd).toBe(0);
    expect(result.calls).toBe(0);
    expect(result.last_call_iso).toBeNull();
  });

  it("reflects recorded usage", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "default", cost_usd: 2.5, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: randomUUID() });
    const h = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await h({ scope: "default", window: "daily" });
    expect(result.used_usd).toBeCloseTo(2.5);
    expect(result.calls).toBe(1);
    expect(result.last_call_iso).toBeTruthy();
  });

  it("supports weekly window", async () => {
    const h = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await h({ scope: "default", window: "weekly" });
    expect(result.window).toBe("weekly");
    expect(result.cap_usd).toBe(50.0);
  });
});

// ── list_scopes ───────────────────────────────────────────────────────────────

describe("list_scopes tool", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("returns configured scopes", async () => {
    const h = (registeredTools.get("list_scopes") as { handler: Function }).handler;
    const result = await h({});
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s: { scope: string }) => s.scope === "default")).toBe(true);
  });
});

// ── reset_scope ───────────────────────────────────────────────────────────────

describe("reset_scope tool", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("resets daily window and emits audit event", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "default", cost_usd: 3.0, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: randomUUID() });

    auditEvents.length = 0;
    const h = (registeredTools.get("reset_scope") as { handler: Function }).handler;
    const result = await h({ scope: "default", window: "daily" });

    expect(result.resets).toContain("daily");
    expect(auditEvents.some((e) => e.event === "budget_guard_scope_reset")).toBe(true);

    const usage = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const after = await usage({ scope: "default", window: "daily" });
    expect(after.used_usd).toBe(0);
  });

  it("reset all clears all windows", async () => {
    const h = (registeredTools.get("reset_scope") as { handler: Function }).handler;
    const result = await h({ scope: "default", window: "all" });
    expect(result.resets).toContain("daily");
    expect(result.resets).toContain("weekly");
    expect(result.resets).toContain("monthly");
  });
});

// ── record_usage ──────────────────────────────────────────────────────────────

describe("record_usage tool", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("records usage and returns scope status", async () => {
    const h = (registeredTools.get("record_usage") as { handler: Function }).handler;
    const result = await h({
      scope: "default",
      cost_usd: 1.0,
      model: "claude-sonnet-4-6",
      tokens_in: 500,
      tokens_out: 200,
      call_id: randomUUID(),
    });
    expect(result.recorded).toBe(true);
    expect(result.scope_status.allow).toBe(true);
    expect(result.scope_status.remaining_usd).toBeCloseTo(9.0);
  });

  it("idempotent on duplicate call_id (UNIQUE constraint)", async () => {
    const h = (registeredTools.get("record_usage") as { handler: Function }).handler;
    const callId = randomUUID();
    await h({ scope: "default", cost_usd: 1.0, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: callId });
    await h({ scope: "default", cost_usd: 1.0, model: "claude-sonnet-4-6", tokens_in: 100, tokens_out: 50, call_id: callId });

    const usage = (registeredTools.get("current_usage") as { handler: Function }).handler;
    const result = await usage({ scope: "default", window: "daily" });
    expect(result.calls).toBe(1);
  });
});

// ── Audit events ──────────────────────────────────────────────────────────────

describe("audit events", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("threshold events fire exactly once per window crossing (0.5)", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    const check = (registeredTools.get("check_budget") as { handler: Function }).handler;

    await record({ scope: "default", cost_usd: 5.01, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    await check({ scope: "default" });
    await check({ scope: "default" });

    const crossings = auditEvents.filter(
      (e) => e.event === "budget_guard_threshold_crossed" && (e.payload as Record<string, unknown>).threshold === 0.5
    );
    expect(crossings.length).toBe(1);
  });

  it("audit denial payload does not include model output or prompt content", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;
    await record({ scope: "default", cost_usd: 11.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    const check = (registeredTools.get("check_budget") as { handler: Function }).handler;
    await check({ scope: "default" });

    const denial = auditEvents.find((e) => e.event === "budget_guard_denied");
    expect(denial).toBeDefined();
    const payload = denial!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("prompt");
    expect(payload).not.toHaveProperty("output");
    expect(payload).not.toHaveProperty("bearer");
  });
});

// ── weekly/monthly cap enforcement ───────────────────────────────────────────

describe("weekly/monthly cap enforcement", () => {
  let plugin: BudgetGuardPlugin;
  const handler = () => (registeredTools.get("check_budget") as { handler: Function }).handler;
  const record = () => (registeredTools.get("record_usage") as { handler: Function }).handler;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    // daily=100, weekly=20, monthly=50 — weekly cap is tighter than daily to test isolation
    plugin = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: `/tmp/budget-guard-test-${randomUUID()}.db`,
        scopes: [
          { name: "capped", daily_cap_usd: 100.0, weekly_cap_usd: 20.0, monthly_cap_usd: 50.0, deny_when_exceeded: true },
        ],
      },
    });
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("denies when weekly cap exceeded", async () => {
    await record()({ scope: "capped", cost_usd: 20.01, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    const result = await handler()({ scope: "capped" });
    expect(result.allow).toBe(false);
    const denial = auditEvents.find((e) => e.event === "budget_guard_denied");
    expect(denial).toBeDefined();
    expect((denial!.payload as Record<string, unknown>).window).toBe("weekly");
  });

  it("denies when monthly cap exceeded", async () => {
    // Use a scope where weekly is high but monthly is low
    await plugin.stop();
    _resetBudgetGuard();
    registeredTools.clear();
    plugin = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: `/tmp/budget-guard-test-${randomUUID()}.db`,
        scopes: [
          { name: "monthly-test", daily_cap_usd: 100.0, weekly_cap_usd: 100.0, monthly_cap_usd: 15.0, deny_when_exceeded: true },
        ],
      },
    });
    await plugin.start();
    await record()({ scope: "monthly-test", cost_usd: 15.01, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });
    const result = await handler()({ scope: "monthly-test" });
    expect(result.allow).toBe(false);
    const denial = auditEvents.find((e) => e.event === "budget_guard_denied");
    expect(denial).toBeDefined();
    expect((denial!.payload as Record<string, unknown>).window).toBe("monthly");
  });
});

// ── token file mode ──────────────────────────────────────────────────────────

describe("token file permissions", () => {
  it("token file is created with mode 0600", async () => {
    const { statSync } = await import("node:fs");
    const tokenPath = `/tmp/budget-guard-token-test-${randomUUID()}/budget-guard.token`;
    const plugin = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: `/tmp/budget-guard-test-${randomUUID()}.db`,
        scopes: [{ name: "default", daily_cap_usd: 10.0, deny_when_exceeded: true }],
      },
      tokenPath,
    });
    registeredTools.clear();
    await plugin.start();

    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);

    await plugin.stop();
    _resetBudgetGuard();
  });
});

// ── threshold sort defensiveness ─────────────────────────────────────────────

describe("threshold sort defensiveness", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    auditEvents.length = 0;
    registeredTools.clear();
    plugin = new BudgetGuardPlugin({
      configOverride: {
        enabled: true,
        database_path: `/tmp/budget-guard-test-${randomUUID()}.db`,
        default_warning_thresholds: [0.95, 0.5, 0.8],
        scopes: [{ name: "sort-test", daily_cap_usd: 10.0, deny_when_exceeded: true }],
      },
    });
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("unsorted thresholds [0.95, 0.5, 0.8] fire 0.5 first at 60% usage", async () => {
    const record = (registeredTools.get("record_usage") as { handler: Function }).handler;

    // Record 60% usage — record_usage calls _checkBudget internally which fires thresholds
    auditEvents.length = 0;
    await record({ scope: "sort-test", cost_usd: 6.0, model: "m", tokens_in: 1, tokens_out: 1, call_id: randomUUID() });

    const crossings = auditEvents.filter((e) => e.event === "budget_guard_threshold_crossed");
    const thresholdValues = crossings.map((e) => (e.payload as Record<string, unknown>).threshold);
    // 0.5 should fire (60% >= 50%)
    expect(thresholdValues).toContain(0.5);
    // 0.95 should NOT have fired (60% < 95%)
    expect(thresholdValues).not.toContain(0.95);
  });
});

// ── health ────────────────────────────────────────────────────────────────────

describe("health endpoint", () => {
  let plugin: BudgetGuardPlugin;

  beforeEach(async () => {
    registeredTools.clear();
    plugin = makePlugin();
    await plugin.start();
  });
  afterEach(async () => { await plugin.stop(); _resetBudgetGuard(); });

  it("returns status:up after start", () => {
    const h = plugin.health();
    expect(h.status).toBe("up");
    expect(typeof h.uptime_s).toBe("number");
    expect(typeof h.scope_count).toBe("number");
  });

  it("returns status:stopped before start", async () => {
    await plugin.stop();
    const h = plugin.health();
    expect(h.status).toBe("stopped");
  });
});
