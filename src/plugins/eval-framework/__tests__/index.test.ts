import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dump as yamlStringify } from "js-yaml";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const auditEvents: { event: string; payload: unknown }[] = [];
const registeredTools: Map<string, { name: string; handler: Function }> = new Map();

mock.module("../../mcp-bridge.js", () => ({
  getMcpBridge: () => ({
    audit: (event: string, payload: unknown) => auditEvents.push({ event, payload }),
    registerPluginTool: (_pluginId: string, tool: { name: string; handler: Function }) =>
      registeredTools.set(tool.name, tool),
  }),
}));

mock.module("../../http-gateway.js", () => ({
  getHttpGateway: () => ({
    registerInProcess: () => Buffer.from("fake-token-32bytes-padding-here!"),
  }),
}));

import { EvalFrameworkPlugin, _resetEvalFramework } from "../index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TMP_BASE = `/tmp/eval-framework-test-${process.pid}`;

function makeTmpDirs() {
  const evalsRoot = join(TMP_BASE, randomUUID());
  const dbPath = join(TMP_BASE, `${randomUUID()}.db`);
  mkdirSync(evalsRoot, { recursive: true });
  return { evalsRoot, dbPath };
}

function writeEvalSet(evalsRoot: string, taskId: string, setId: string, examples: unknown[]) {
  const dir = join(evalsRoot, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${setId}.yaml`), yamlStringify({
    task_id: taskId,
    set_id: setId,
    examples,
  }));
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  const { evalsRoot, dbPath } = makeTmpDirs();
  return {
    plugin: new EvalFrameworkPlugin({
      configOverride: {
        enabled: true,
        evals_root: evalsRoot,
        database_path: dbPath,
        ...overrides,
      },
    }),
    evalsRoot,
    dbPath,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("start emits eval_framework_started audit event", async () => {
    auditEvents.length = 0;
    const { plugin } = makePlugin();
    await plugin.start();
    expect(auditEvents.some((e) => e.event === "eval_framework_started")).toBe(true);
    await plugin.stop();
  });

  it("stop emits eval_framework_stopped audit event", async () => {
    const { plugin } = makePlugin();
    await plugin.start();
    auditEvents.length = 0;
    await plugin.stop();
    expect(auditEvents.some((e) => e.event === "eval_framework_stopped")).toBe(true);
  });

  it("double start is idempotent", async () => {
    auditEvents.length = 0;
    const { plugin } = makePlugin();
    await plugin.start();
    await plugin.start();
    const starts = auditEvents.filter((e) => e.event === "eval_framework_started");
    expect(starts.length).toBe(1);
    await plugin.stop();
  });

  it("registers 6 tools with bridge", async () => {
    registeredTools.clear();
    const { plugin } = makePlugin();
    await plugin.start();
    expect(registeredTools.has("run_eval")).toBe(true);
    expect(registeredTools.has("compare_models")).toBe(true);
    expect(registeredTools.has("recommend_tier")).toBe(true);
    expect(registeredTools.has("list_runs")).toBe(true);
    expect(registeredTools.has("get_run_report")).toBe(true);
    expect(registeredTools.has("validate_eval_set")).toBe(true);
    await plugin.stop();
  });
});

// ── Health ────────────────────────────────────────────────────────────────────

describe("health", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("returns status:up after start", async () => {
    const { plugin } = makePlugin();
    await plugin.start();
    const h = plugin.health();
    expect(h.status).toBe("up");
    expect(typeof h.uptime_s).toBe("number");
    await plugin.stop();
  });

  it("returns status:stopped before start", () => {
    const { plugin } = makePlugin();
    const h = plugin.health();
    expect(h.status).toBe("stopped");
  });
});

// ── validate_eval_set ─���───────────────────────────────────────────────────────

describe("validate_eval_set tool", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("validates a correct eval set", async () => {
    registeredTools.clear();
    const { plugin, evalsRoot } = makePlugin();
    writeEvalSet(evalsRoot, "test-task", "basic", [
      { input: "hello", expected_output: "world", judge_mode: "exact_set" },
    ]);
    await plugin.start();
    const handler = registeredTools.get("validate_eval_set")!.handler;
    const result = await handler({ set_path: join(evalsRoot, "test-task", "basic.yaml") });
    expect(result.valid).toBe(true);
    expect(result.n_examples).toBe(1);
    expect(result.judge_modes_used).toContain("exact_set");
    await plugin.stop();
  });

  it("rejects invalid eval set", async () => {
    registeredTools.clear();
    const { plugin, evalsRoot } = makePlugin();
    const dir = join(evalsRoot, "bad-task");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.yaml"), "not_valid: true\n");
    await plugin.start();
    const handler = registeredTools.get("validate_eval_set")!.handler;
    const result = await handler({ set_path: join(dir, "bad.yaml") });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    await plugin.stop();
  });
});

// ── list_runs ─────────────────────────────────────────────────────────────────

describe("list_runs tool", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("returns empty array when no runs exist", async () => {
    registeredTools.clear();
    const { plugin } = makePlugin();
    await plugin.start();
    const handler = registeredTools.get("list_runs")!.handler;
    const result = await handler({});
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    await plugin.stop();
  });
});

// ── recommend_tier ────────────────────────────────────────────────────────────

describe("recommend_tier tool", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("returns null fields when no recommendation exists", async () => {
    registeredTools.clear();
    const { plugin } = makePlugin();
    await plugin.start();
    const handler = registeredTools.get("recommend_tier")!.handler;
    const result = await handler({ task_id: "nonexistent" });
    expect(result.recommended_default_tier).toBeNull();
    await plugin.stop();
  });
});

// ── Audit events ──��───────────────────────────────────────────────────────────

describe("audit events", () => {
  afterEach(() => { _resetEvalFramework(); });

  it("audit payloads never contain credentials", async () => {
    auditEvents.length = 0;
    const { plugin } = makePlugin();
    await plugin.start();
    await plugin.stop();
    for (const e of auditEvents) {
      const serialized = JSON.stringify(e.payload);
      expect(serialized).not.toMatch(/bearer/i);
      expect(serialized).not.toMatch(/api.?key/i);
      expect(serialized).not.toMatch(/secret/i);
    }
  });
});

// Cleanup
afterEach(() => {
  try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch {}
});
