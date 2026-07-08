import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRoutingSubject } from "../../../subjects/model-routing-subject.js";
import type { Observation, Patch, Proposal } from "../../../../skills-tuner/core/types.js";

let tmpRoot: string;
let configPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mrsubj-"));
  configPath = join(tmpRoot, "agentic.yaml");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ModelRoutingSubject — identity", () => {
  it('name === "model_routing", risk_tier === "medium"', () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    expect(s.name).toBe("model_routing");
    expect(s.risk_tier).toBe("medium");
  });
});

describe("ModelRoutingSubject — collectObservations", () => {
  it("reads mode dispatch audit events", async () => {
    const now = Date.now();
    const s = new ModelRoutingSubject({
      modesConfigPath: configPath,
      dispatchReader: () => [
        {
          type: "mode_dispatched",
          mode: "fast",
          keyword: "quick",
          cost_usd: 0.01,
          task_class: "qa",
          ts: now,
        },
        {
          type: "mode_dispatched",
          mode: "fast",
          keyword: "quick",
          cost_usd: 0.01,
          task_class: "qa",
          ts: now,
        },
      ],
    });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]?.metadata.triggers).toBe(2);
  });

  it("joins cost rows per (mode, keyword) and detects expensive ratio", async () => {
    const now = Date.now();
    const s = new ModelRoutingSubject({
      modesConfigPath: configPath,
      dispatchReader: () => [
        // cheap baseline
        {
          type: "mode_dispatched",
          mode: "haiku",
          keyword: "k1",
          cost_usd: 0.001,
          task_class: "qa",
          ts: now,
        },
        {
          type: "mode_dispatched",
          mode: "haiku",
          keyword: "k1",
          cost_usd: 0.001,
          task_class: "qa",
          ts: now,
        },
        // expensive comparison
        {
          type: "mode_dispatched",
          mode: "opus",
          keyword: "k2",
          cost_usd: 0.05,
          task_class: "qa",
          ts: now,
        },
        {
          type: "mode_dispatched",
          mode: "opus",
          keyword: "k2",
          cost_usd: 0.05,
          task_class: "qa",
          ts: now,
        },
      ],
    });
    const obs = await s.collectObservations(new Date(0));
    const opus = obs.find((o) => o.metadata.mode === "opus");
    expect(opus).toBeDefined();
    expect(opus?.metadata.expensive).toBe(true);
  });

  it("returns empty when no events", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath, dispatchReader: () => [] });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });
});

describe("ModelRoutingSubject — detectProblems", () => {
  it("flags dead keywords (0 triggers in 90d)", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "orphan",
        verbatim: "{}",
        metadata: {
          subject: "model_routing",
          mode: "m",
          keyword: "k",
          triggers: 0,
          reclassify_rate: 0,
          expensive: false,
          age_days: 200,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "routing-dead-keyword")).toBe(true);
  });

  it("flags mis-trigger keywords (reclassify_rate > 0.3)", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "correction",
        verbatim: "{}",
        metadata: {
          subject: "model_routing",
          mode: "m",
          keyword: "k",
          triggers: 10,
          reclassify_rate: 0.6,
          expensive: false,
          age_days: 1,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "routing-mistrigger")).toBe(true);
  });

  it("flags expensive modes", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "repeated_trigger",
        verbatim: "{}",
        metadata: {
          subject: "model_routing",
          mode: "m",
          keyword: "k",
          triggers: 5,
          reclassify_rate: 0,
          expensive: true,
          age_days: 1,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters.some((c) => c.id === "routing-expensive")).toBe(true);
  });
});

describe("ModelRoutingSubject — apply / validate", () => {
  it("apply preserves YAML comments via line-based editor", async () => {
    const yaml = [
      "# top comment",
      "modes:",
      "  fast:",
      "    model: claude-haiku",
      "    keywords:",
      "      - quick",
      "      - rapid",
    ].join("\n");
    writeFileSync(configPath, yaml, "utf8");
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "model_routing",
      kind: "patch",
      target_path: configPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "sig",
      alternatives: [
        {
          id: "remove-keyword",
          label: "l",
          tradeoff: "",
          diff_or_content:
            "# top comment\nmodes:\n  fast:\n    model: claude-haiku\n    keywords:\n      - rapid\n",
        },
      ],
    };
    await s.apply(proposal, "remove-keyword");
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("# top comment");
    expect(written).not.toContain("quick");
    expect(existsSync(`${configPath}.bak`)).toBe(true);
  });

  it("validate parses YAML and verifies schema", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  fast:\n    keywords: [quick, rapid]\n",
    });
    expect(r.valid).toBe(true);
  });

  it("validate rejects duplicate keyword across modes", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  fast:\n    keywords: [shared]\n  slow:\n    keywords: [shared]\n",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/duplicate/);
  });

  it("validate rejects malformed YAML", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "this: : not yaml\n  - bad",
    });
    expect(r.valid).toBe(false);
  });

  it("validate rejects non-string keywords", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  fast:\n    keywords: [1, 2]\n",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/string\[\]/);
  });
});

describe("ModelRoutingSubject — revert", () => {
  it("writes inverse YAML back to target_path", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const inverse: Patch = {
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  fast:\n    keywords: [pristine]\n",
    };
    await s.revert(inverse);
    expect(readFileSync(configPath, "utf8")).toContain("pristine");
  });
});

// ── Pass B: edges, idempotency, guardrails ─────────────────────────────────

describe("ModelRoutingSubject — Pass B: edges", () => {
  it("validate: empty content fails (not a mapping)", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({ target_path: configPath, kind: "patch", applied_content: "" });
    expect(r.valid).toBe(false);
  });

  it("validate: top-level YAML scalar rejected", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "just-a-string\n",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/mapping/);
  });

  it("validate: duplicate keyword across modes flagged", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const r = await s.validate({
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  fast:\n    keywords: [dup]\n  slow:\n    keywords: [dup]\n",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/duplicate/);
  });

  it("apply: missing alternative id → clear error", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "model_routing",
      kind: "patch",
      target_path: configPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [
        {
          id: "real",
          label: "",
          tradeoff: "",
          diff_or_content: "modes:\n  a:\n    keywords: [x]\n",
        },
      ],
    };
    await expect(s.apply(proposal, "wrong")).rejects.toThrow(/alternative/);
  });
});

describe("ModelRoutingSubject — Pass B: idempotency", () => {
  it("apply same alt twice → identical file content", async () => {
    writeFileSync(configPath, "modes:\n  old:\n    keywords: [old]\n", "utf8");
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const newYaml = "modes:\n  new:\n    keywords: [new]\n";
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "model_routing",
      kind: "patch",
      target_path: configPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: newYaml }],
    };
    await s.apply(proposal, "a");
    const after1 = readFileSync(configPath, "utf8");
    await s.apply(proposal, "a");
    expect(readFileSync(configPath, "utf8")).toBe(after1);
  });

  it("revert same inverse twice → no double-mutation", async () => {
    writeFileSync(configPath, "modes:\n  m:\n    keywords: [m]\n", "utf8");
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const inverse: Patch = {
      target_path: configPath,
      kind: "patch",
      applied_content: "modes:\n  o:\n    keywords: [orig]\n",
    };
    await s.revert(inverse);
    const after1 = readFileSync(configPath, "utf8");
    await s.revert(inverse);
    expect(readFileSync(configPath, "utf8")).toBe(after1);
  });
});

describe("ModelRoutingSubject — Pass B: validate/apply symmetry", () => {
  it("apply roundtrip: produced Patch validates clean", async () => {
    writeFileSync(configPath, "modes:\n  a:\n    keywords: [x]\n", "utf8");
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const newYaml = "modes:\n  a:\n    keywords: [y]\n";
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "model_routing",
      kind: "patch",
      target_path: configPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: newYaml }],
    };
    const patch = await s.apply(proposal, "a");
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });
});

describe("ModelRoutingSubject — Pass B: risk_tier guardrails", () => {
  it("risk_tier is medium — no observation window", () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    expect(s.risk_tier).toBe("medium");
  });
});

describe("ModelRoutingSubject — healthCheck", () => {
  it("returns producer_found=false when dispatchReader is not injected", async () => {
    // Default ctor: dispatchReader=() => [], i.e. not configured.
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const h = await s.healthCheck?.();
    expect(h.producer_found).toBe(false);
    expect(h.reason).toMatch(/dispatchReader not configured/);
  });

  it("returns producer_found=true match_rate=0 when reader returns no events", async () => {
    const s = new ModelRoutingSubject({
      modesConfigPath: configPath,
      dispatchReader: () => [],
    });
    const h = await s.healthCheck?.();
    expect(h.producer_found).toBe(true);
    expect(h.sample_event_match_rate).toBe(0);
    expect(h.reason).toMatch(/0 events/);
  });

  it("returns match_rate>0 when reader emits dispatch events", async () => {
    const s = new ModelRoutingSubject({
      modesConfigPath: configPath,
      dispatchReader: () => [{ type: "dispatch", mode: "code-fix" }, { type: "other" }],
    });
    const h = await s.healthCheck?.();
    expect(h.producer_found).toBe(true);
    expect(h.sample_event_match_rate).toBeGreaterThan(0);
  });
});

describe("ModelRoutingSubject — healthProbe (post-apply artifact check)", () => {
  it("valid modes YAML with unique keywords → failed:false", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    writeFileSync(
      configPath,
      "modes:\n  fast:\n    keywords: [quick, q]\n  deep:\n    keywords: [research]\n",
      "utf8",
    );
    const probe = await s.healthProbe?.(configPath);
    expect(probe.failed).toBe(false);
    expect(probe.errors).toEqual([]);
  });

  it("duplicate keyword across modes → failed:true + errors", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    writeFileSync(
      configPath,
      "modes:\n  fast:\n    keywords: [quick]\n  deep:\n    keywords: [quick]\n",
      "utf8",
    );
    const probe = await s.healthProbe?.(configPath);
    expect(probe.failed).toBe(true);
    expect(probe.errors.join(" ")).toMatch(/duplicate keyword/);
  });

  it("invalid YAML → failed:true", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    writeFileSync(configPath, "modes:\n  fast: [unclosed\n", "utf8");
    const probe = await s.healthProbe?.(configPath);
    expect(probe.failed).toBe(true);
  });

  it("config absent after apply → not a break", async () => {
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const probe = await s.healthProbe?.(configPath);
    expect(probe.failed).toBe(false);
  });
});

describe("ModelRoutingSubject — YAML editors don't corrupt sibling modes (#306)", () => {
  it("proposeChange edits only the target mode in a multi-mode block", async () => {
    const yaml = [
      "modes:",
      "  fast:",
      "    model: claude-sonnet",
      "    keywords:",
      "      - quick",
      "      - rapid",
      "  slow:",
      "    model: claude-opus",
      "    keywords:",
      "      - quick",
      "      - deep",
    ].join("\n");
    writeFileSync(configPath, yaml, "utf8");
    const s = new ModelRoutingSubject({ modesConfigPath: configPath });
    const obs: Observation[] = [
      {
        session_id: "t",
        observed_at: new Date(),
        signal_type: "orphan",
        verbatim: "{}",
        metadata: {
          subject: "model_routing",
          mode: "fast",
          keyword: "quick",
          triggers: 0,
          reclassify_rate: 0,
          expensive: false,
          age_days: 200,
        },
      },
    ];
    const clusters = await s.detectProblems(obs);
    const cluster = clusters.find((c) => c.id === "routing-dead-keyword");
    expect(cluster).toBeDefined();
    const proposal = await s.proposeChange(cluster!);
    const alt = (id: string) =>
      proposal.alternatives.find((a) => a.id === id)?.diff_or_content ?? "";

    // swap-model: fast sonnet -> haiku; slow's opus MUST survive (the #306 repro:
    // the bug left inMode set and swapped slow's model to sonnet too).
    const swapped = alt("swap-model");
    expect(swapped).toContain("model: claude-haiku");
    expect(swapped).toContain("model: claude-opus");

    // remove-keyword: fast's 'quick' removed; slow's 'quick' + 'deep' untouched.
    const removed = alt("remove-keyword");
    expect((removed.match(/^\s*- quick$/gm) ?? []).length).toBe(1);
    expect(removed).toContain("- rapid");
    expect(removed).toContain("- deep");

    // narrow-keyword: fast's 'quick' renamed; slow's 'quick' left as-is.
    const narrowed = alt("narrow-keyword");
    expect(narrowed).toContain("- quick-specific");
    expect((narrowed.match(/^\s*- quick$/gm) ?? []).length).toBe(1);
  });
});
