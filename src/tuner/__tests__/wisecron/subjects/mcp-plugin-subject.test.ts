import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPluginSubject } from "../../../subjects/mcp-plugin-subject.js";
import type { Observation, Patch, Proposal } from "../../../../skills-tuner/core/types.js";

let tmpRoot: string;
let auditPath: string;
let settingsPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mcpsubj-"));
  auditPath = join(tmpRoot, "operations.jsonl");
  settingsPath = join(tmpRoot, "settings.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("McpPluginSubject — identity", () => {
  it('name === "mcp_plugin", risk_tier === "medium"', () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    expect(s.name).toBe("mcp_plugin");
    expect(s.risk_tier).toBe("medium");
  });
});

describe("McpPluginSubject — collectObservations", () => {
  it("streams operations.jsonl filtering type=mcp_tool_call", async () => {
    const events = [
      { type: "mcp_tool_call", server: "foo", tool: "bar", success: true, ts: Date.now() },
      { type: "other", server: "foo", tool: "bar", ts: Date.now() }, // ignored
      { type: "mcp_tool_call", server: "foo", tool: "bar", success: false, ts: Date.now() },
    ];
    const s = new McpPluginSubject({
      auditLog: auditPath,
      settingsPath,
      auditReader: () => events,
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]?.metadata.calls).toBe(2);
  });

  it("aggregates call_count + success_rate + blocked_count per (server, tool)", async () => {
    const now = Date.now();
    const events = [
      { type: "mcp_tool_call", server: "s", tool: "t", success: true, ts: now },
      { type: "mcp_tool_call", server: "s", tool: "t", success: false, blocked: true, ts: now },
      { type: "mcp_tool_call", server: "s", tool: "t", success: true, ts: now },
    ];
    const s = new McpPluginSubject({
      auditLog: auditPath,
      settingsPath,
      auditReader: () => events,
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs[0]?.metadata.calls).toBe(3);
    expect(obs[0]?.metadata.success_rate).toBeCloseTo(2 / 3, 2);
    expect(obs[0]?.metadata.blocked).toBe(1);
  });

  it("returns empty when no audit events", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath, auditReader: () => [] });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });
});

describe("McpPluginSubject — detectProblems", () => {
  it("flags broken tools (calls > 100 && success < 0.5)", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "correction",
        verbatim: "{}",
        metadata: {
          subject: "mcp_plugin",
          server: "s",
          tool: "t",
          calls: 150,
          success_rate: 0.3,
          blocked: 0,
          trust_score: 0,
          age_days: 1,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "mcp-broken")).toBe(true);
  });

  it("flags dead tools (zero calls last 90d)", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "orphan",
        verbatim: "{}",
        metadata: {
          subject: "mcp_plugin",
          server: "s",
          tool: "t",
          calls: 5,
          success_rate: 1,
          blocked: 0,
          trust_score: 0,
          age_days: 120,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "mcp-dead")).toBe(true);
  });

  it("flags blocked tools with high trust score", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "repeated_trigger",
        verbatim: "{}",
        metadata: {
          subject: "mcp_plugin",
          server: "s",
          tool: "t",
          calls: 10,
          success_rate: 1,
          blocked: 5,
          trust_score: 0.9,
          age_days: 1,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "mcp-blocked-allow")).toBe(true);
  });
});

describe("McpPluginSubject — apply / validate", () => {
  it("apply preserves stable JSON key order", async () => {
    writeFileSync(settingsPath, JSON.stringify({ b: 1, a: 2, allowedTools: ["x"] }), "utf8");
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "sig",
      alternatives: [
        {
          id: "remove-tool",
          label: "l",
          tradeoff: "",
          diff_or_content: JSON.stringify({ zlast: 1, allowedTools: [], aFirst: "first" }),
        },
      ],
    };
    await s.apply(proposal, "remove-tool");
    const written = readFileSync(settingsPath, "utf8");
    const keys = Object.keys(JSON.parse(written));
    expect(keys).toEqual(["aFirst", "allowedTools", "zlast"]);
    expect(existsSync(`${settingsPath}.bak`)).toBe(true);
  });

  it("validate parses applied_content as JSON", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const bad = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: "not-json",
    });
    expect(bad.valid).toBe(false);
  });

  it("validate rejects allowedTools not a string array", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const r1 = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{"allowedTools": "not-an-array"}',
    });
    expect(r1.valid).toBe(false);

    const r2 = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{"allowedTools": [1, 2, 3]}',
    });
    expect(r2.valid).toBe(false);
  });

  it("validate accepts a well-formed settings object", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const r = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{"allowedTools": ["a", "b"]}',
    });
    expect(r.valid).toBe(true);
  });
});

describe("McpPluginSubject — revert", () => {
  it("writes inverse JSON back to target_path", async () => {
    writeFileSync(settingsPath, '{"a":2}', "utf8");
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const inverse: Patch = {
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{\n  "a": 1\n}',
    };
    await s.revert(inverse);
    expect(readFileSync(settingsPath, "utf8")).toBe('{\n  "a": 1\n}');
  });

  it("revert throws on malformed inverse content", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const inverse: Patch = { target_path: settingsPath, kind: "patch", applied_content: "bogus" };
    await expect(s.revert(inverse)).rejects.toThrow();
  });
});

// ── Pass B: edges, idempotency, guardrails ─────────────────────────────────

describe("McpPluginSubject — Pass B: edges", () => {
  it("validate: empty string fails JSON parse with clear reason", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const r = await s.validate({ target_path: settingsPath, kind: "patch", applied_content: "" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/JSON/);
  });

  it("validate: top-level array rejected (must be object)", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const r = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: "[1,2,3]",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/object/);
  });

  it("validate: allowedTools with non-string entry rejected", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const r = await s.validate({
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{"allowedTools": ["ok", 42]}',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/strings/);
  });

  it("apply: missing alternative id → clear error", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "real", label: "", tradeoff: "", diff_or_content: '{"a":1}' }],
    };
    await expect(s.apply(proposal, "wrong")).rejects.toThrow(/alternative/);
  });
});

describe("McpPluginSubject — Pass B: idempotency", () => {
  it("apply same alt twice → stable bytes (parse+stableJson normalises)", async () => {
    writeFileSync(settingsPath, '{"a":1}', "utf8");
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: '{"b":2,"a":1}' }],
    };
    const patch1 = await s.apply(proposal, "a");
    const after1 = readFileSync(settingsPath, "utf8");
    const patch2 = await s.apply(proposal, "a");
    expect(readFileSync(settingsPath, "utf8")).toBe(after1);
    expect(patch2.applied_content).toBe(patch1.applied_content);
  });

  it("revert same inverse twice → no double-mutation", async () => {
    writeFileSync(settingsPath, '{"a":2}', "utf8");
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const inverse: Patch = {
      target_path: settingsPath,
      kind: "patch",
      applied_content: '{"a":1}',
    };
    await s.revert(inverse);
    const after1 = readFileSync(settingsPath, "utf8");
    await s.revert(inverse);
    expect(readFileSync(settingsPath, "utf8")).toBe(after1);
  });
});

describe("McpPluginSubject — Pass B: validate/apply symmetry", () => {
  it("apply roundtrip: produced Patch validates clean", async () => {
    writeFileSync(settingsPath, "{}", "utf8");
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [
        { id: "a", label: "", tradeoff: "", diff_or_content: '{"allowedTools":["x"]}' },
      ],
    };
    const patch = await s.apply(proposal, "a");
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });

  it("apply throws on malformed JSON in alt content (mirrors validate rejection)", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: "not-json" }],
    };
    await expect(s.apply(proposal, "a")).rejects.toThrow();
  });
});

describe("McpPluginSubject — Pass B: risk_tier guardrails", () => {
  it("risk_tier is medium — no observation window in ApplyPipeline", () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    expect(s.risk_tier).toBe("medium");
    expect(s.auto_merge_default).toBe(false);
  });
});

describe("McpPluginSubject — healthCheck", () => {
  it("returns producer_found=false when auditLog does not exist", async () => {
    const s = new McpPluginSubject({ auditLog: join(tmpRoot, "missing.jsonl") });
    const h = await s.healthCheck!();
    expect(h.producer_found).toBe(false);
    expect(h.reason).toMatch(/auditLog does not exist/);
  });

  it("returns producer_found=false when no events in 7d window", async () => {
    writeFileSync(auditPath, "", "utf8");
    const s = new McpPluginSubject({
      auditLog: auditPath,
      auditReader: () => [],
    });
    const h = await s.healthCheck!();
    expect(h.producer_found).toBe(false);
    expect(h.reason).toMatch(/no audit events/);
  });

  it("returns match_rate=0 with reason when audit log has events but none are mcp_tool_call", async () => {
    writeFileSync(auditPath, "{}\n", "utf8");
    const s = new McpPluginSubject({
      auditLog: auditPath,
      auditReader: () => [{ type: "skill_run" }, { type: "session_start" }],
    });
    const h = await s.healthCheck!();
    expect(h.producer_found).toBe(true);
    expect(h.sample_event_match_rate).toBe(0);
    expect(h.reason).toMatch(/instrumentation missing/);
  });

  it("returns match_rate>0 when mcp_tool_call entries are present", async () => {
    writeFileSync(auditPath, "{}\n", "utf8");
    const s = new McpPluginSubject({
      auditLog: auditPath,
      auditReader: () => [{ type: "mcp_tool_call", server: "s", tool: "t" }, { type: "skill_run" }],
    });
    const h = await s.healthCheck!();
    expect(h.producer_found).toBe(true);
    expect(h.sample_event_match_rate).toBe(0.5);
  });
});

describe("McpPluginSubject — healthProbe (post-apply artifact check)", () => {
  it("valid JSON settings with allowedTools[] → failed:false", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: ["mcp__a__b"] }), "utf8");
    const probe = await s.healthProbe!(settingsPath);
    expect(probe.failed).toBe(false);
    expect(probe.errors).toEqual([]);
  });

  it("malformed JSON → failed:true + errors", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    writeFileSync(settingsPath, "{ not json", "utf8");
    const probe = await s.healthProbe!(settingsPath);
    expect(probe.failed).toBe(true);
    expect(probe.errors.length).toBeGreaterThan(0);
  });

  it("schema regression (allowedTools not an array) → failed:true", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: "nope" }), "utf8");
    const probe = await s.healthProbe!(settingsPath);
    expect(probe.failed).toBe(true);
  });

  it("settings file absent after apply → not a break", async () => {
    const s = new McpPluginSubject({ auditLog: auditPath, settingsPath });
    const probe = await s.healthProbe!(settingsPath);
    expect(probe.failed).toBe(false);
  });
});
