/**
 * The proposal-gate MCP surface (`gate-mcp.ts`): the seven `tuner__*` tools
 * registered on a real `PluginMcpBridge` and driven through `invokeTool`, the
 * way any MCP consumer reaches them. The engine/pipeline/recorder are stubbed
 * (their behaviour is covered by their own suites) so these tests pin the GATE
 * wiring: status reads, lifecycle transitions on the real `WisecronStateDB`,
 * and the `gate_*` audit provenance.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginMcpBridge } from "../../../plugins/mcp-bridge.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import type { WisecronBundle } from "../../../skills-tuner/cli/wisecron-bootstrap.js";
import type { Proposal, UnsignedProposal } from "../../../skills-tuner/core/types.js";
import {
  registerWisecronGateTools,
  GATE_PLUGIN_ID,
  TUNER_PROPOSE_TOOL,
  TUNER_PROPOSE_EXTERNAL_TOOL,
  TUNER_PENDING_TOOL,
  TUNER_LIST_TOOL,
  TUNER_APPLY_TOOL,
  TUNER_REFUSE_TOOL,
  TUNER_MATURE_TOOL,
  TUNER_STATUS_TOOL,
} from "../../wisecron/gate-mcp.js";

let tmpDir: string;
let db: WisecronStateDB;
let bridge: PluginMcpBridge;
let auditEvents: Array<{ event: string; detail?: Record<string, unknown> }>;

function makeUnsigned(id: number, overrides: Partial<UnsignedProposal> = {}): UnsignedProposal {
  return {
    id,
    cluster_id: `c${id}`,
    subject: "fake",
    kind: "noop",
    target_path: join(tmpDir, `target-${id}.txt`),
    pattern_signature: `sig:${id}`,
    created_at: new Date("2026-01-01T00:00:00Z"),
    alternatives: [{ id: "a1", label: "", diff_or_content: "after", tradeoff: "" }],
    ...overrides,
  } as UnsignedProposal;
}

/** Seed a pending proposal directly (persistProposal does not verify signatures). */
function seedPending(id: number, overrides: Partial<Proposal> = {}): void {
  db.persistProposal({ ...makeUnsigned(id), signature: "valid-sig", ...overrides } as Proposal);
}

function makeBundle(overrides: Record<string, unknown> = {}): WisecronBundle {
  const engine = {
    runCycle: async () => ({ proposals: [], observations: 0, clusters: 0 }),
  };
  const pipeline = {
    apply: async () => ({ revision: { id: 1 }, observation_window_armed: true }),
    revert: async () => {},
  };
  const recorder = {
    snapshotBaseline: async () => {},
    runMaturation: async () => [],
  };
  const registry = {
    allSubjects: () => [{ name: "fake" }],
    getSubject: (n: string) => (n === "fake" ? { name: "fake" } : undefined),
  };
  const audit = {
    append: (e: { event: string; detail?: Record<string, unknown> }) => auditEvents.push(e),
  };
  return {
    db,
    engine,
    pipeline,
    recorder,
    registry,
    audit,
    ...overrides,
  } as unknown as WisecronBundle;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gate-mcp-"));
  db = new WisecronStateDB(join(tmpDir, "wisecron.db"));
  bridge = new PluginMcpBridge(join(tmpDir, "plugin-audit.jsonl"));
  auditEvents = [];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerWisecronGateTools — registration", () => {
  it("registers all eight tuner__* tools on the bridge", () => {
    const { tools } = registerWisecronGateTools(bridge, makeBundle());
    expect(tools).toHaveLength(8);
    const fqns = bridge.listTools().map((t) => t.fqn);
    for (const t of tools) expect(fqns).toContain(t);
  });

  it("re-registers cleanly (no duplicate-registration throw)", () => {
    registerWisecronGateTools(bridge, makeBundle());
    expect(() => registerWisecronGateTools(bridge, makeBundle())).not.toThrow();
    expect(bridge.listTools().filter((t) => t.fqn.startsWith(`${GATE_PLUGIN_ID}__`))).toHaveLength(
      8,
    );
  });
});

describe("tuner__propose", () => {
  it("runs the engine per subject, signs + persists proposals as pending", async () => {
    const engine = {
      runCycle: async () => ({ proposals: [makeUnsigned(7)], observations: 3, clusters: 1 }),
    };
    registerWisecronGateTools(bridge, makeBundle({ engine }));

    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      window_hours: number;
      subjects: Array<{ subject: string; proposed: number }>;
    };
    expect(res.total_proposed).toBe(1);
    expect(res.window_hours).toBe(12);
    expect(res.subjects[0]).toMatchObject({ subject: "fake", proposed: 1 });

    const pending = db.listProposals("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("7");
    expect(auditEvents.some((e) => e.event === "gate_propose")).toBe(true);
  });

  it("defaults the window to 24h", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, {})) as { window_hours: number };
    expect(res.window_hours).toBe(24);
  });
});

describe("tuner__propose_external (research injection)", () => {
  it("injects a research proposal as pending, tagged research: and dedup-stable", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    const args = {
      subject: "fake",
      target_path: join(tmpDir, "config.yaml"),
      pattern_signature: "model-upgrade-opus48",
      alternatives: [{ id: "upgrade", diff_or_content: "after", label: "", tradeoff: "" }],
    };
    const res = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as {
      id: string;
      pattern_signature: string;
      deduped: boolean;
    };
    expect(res.deduped).toBe(false);
    expect(res.pattern_signature).toBe("research:model-upgrade-opus48");

    const pending = db.listProposals("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposal.pattern_signature.startsWith("research:")).toBe(true);
    expect(
      auditEvents.some((e) => e.event === "gate_propose" && e.detail?.source === "research"),
    ).toBe(true);

    // Re-inject the same finding → same id, deduped (still one pending).
    const again = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as {
      id: string;
      deduped: boolean;
    };
    expect(again.id).toBe(res.id);
    expect(again.deduped).toBe(true);
    expect(db.listProposals("pending")).toHaveLength(1);
  });

  it("rejects an unregistered subject", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    await expect(
      bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, {
        subject: "nope",
        target_path: join(tmpDir, "x.yaml"),
        pattern_signature: "s",
        alternatives: [{ id: "a", diff_or_content: "c" }],
      }),
    ).rejects.toThrow(/not registered/);
  });
});

describe("tuner__pending / tuner__list / tuner__status", () => {
  it("pending lists only pending proposals with a compact view", async () => {
    seedPending(1);
    registerWisecronGateTools(bridge, makeBundle());
    const res = (await bridge.invokeTool(TUNER_PENDING_TOOL, {})) as {
      count: number;
      proposals: Array<{
        id: string;
        subject: string;
        target_path: string;
        alternatives: string[];
      }>;
    };
    expect(res.count).toBe(1);
    expect(res.proposals[0]).toMatchObject({ id: "1", subject: "fake", alternatives: ["a1"] });
  });

  it("list filters by status", async () => {
    seedPending(1);
    seedPending(2);
    db.setProposalStatus("2", "applied");
    registerWisecronGateTools(bridge, makeBundle());
    const applied = (await bridge.invokeTool(TUNER_LIST_TOOL, { status: "applied" })) as {
      count: number;
    };
    expect(applied.count).toBe(1);
    const all = (await bridge.invokeTool(TUNER_LIST_TOOL, {})) as { count: number };
    expect(all.count).toBe(2);
  });

  it("status returns counts per lifecycle status", async () => {
    seedPending(1);
    seedPending(2);
    seedPending(3);
    db.setProposalStatus("3", "refused");
    registerWisecronGateTools(bridge, makeBundle());
    const counts = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as Record<string, number>;
    expect(counts).toEqual({ pending: 2, applied: 0, refused: 1 });
  });
});

describe("tuner__apply", () => {
  it("applies a pending proposal, transitions it to applied, audits gate_apply", async () => {
    seedPending(5);
    const pipeline = {
      apply: async () => ({ revision: { id: 42 }, observation_window_armed: true }),
      revert: async () => {},
    };
    registerWisecronGateTools(bridge, makeBundle({ pipeline }));

    const res = (await bridge.invokeTool(TUNER_APPLY_TOOL, { id: "5" })) as {
      revision_id: number;
      alt: string;
    };
    expect(res.revision_id).toBe(42);
    expect(res.alt).toBe("a1");
    expect(db.getStoredProposal("5")!.status).toBe("applied");
    expect(auditEvents.some((e) => e.event === "gate_apply")).toBe(true);
  });

  it('applies a research-tagged proposal AS "research" (provenance threads to the revision)', async () => {
    seedPending(7, { pattern_signature: "research:model-upgrade" });
    let seenActor: string | undefined;
    const pipeline = {
      apply: async (_p: unknown, _alt: string, actor: string) => {
        seenActor = actor;
        return { revision: { id: 1 }, observation_window_armed: true };
      },
      revert: async () => {},
    };
    registerWisecronGateTools(bridge, makeBundle({ pipeline }));
    await bridge.invokeTool(TUNER_APPLY_TOOL, { id: "7" });
    expect(seenActor).toBe("research");
    expect(
      auditEvents.some((e) => e.event === "gate_apply" && e.detail?.source === "research"),
    ).toBe(true);
  });

  it("refuses to apply a non-pending proposal", async () => {
    seedPending(6);
    db.setProposalStatus("6", "applied");
    registerWisecronGateTools(bridge, makeBundle());
    await expect(bridge.invokeTool(TUNER_APPLY_TOOL, { id: "6" })).rejects.toThrow(/not pending/);
  });

  it("throws on an unknown proposal id", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    await expect(bridge.invokeTool(TUNER_APPLY_TOOL, { id: "999" })).rejects.toThrow(/not found/);
  });
});

describe("tuner__refuse", () => {
  it("marks a pending proposal refused", async () => {
    seedPending(8);
    registerWisecronGateTools(bridge, makeBundle());
    const res = (await bridge.invokeTool(TUNER_REFUSE_TOOL, { id: "8" })) as { status: string };
    expect(res.status).toBe("refused");
    expect(db.getStoredProposal("8")!.status).toBe("refused");
    expect(auditEvents.some((e) => e.event === "gate_refuse")).toBe(true);
  });
});

describe("tuner__mature", () => {
  it("runs maturation and reports the outcomes", async () => {
    const recorder = {
      snapshotBaseline: async () => {},
      runMaturation: async () => [
        {
          proposal_id: "5",
          subject: "fake",
          target_metric: "m",
          verdict: "improved",
          reverted: false,
        },
      ],
    };
    registerWisecronGateTools(bridge, makeBundle({ recorder }));
    const res = (await bridge.invokeTool(TUNER_MATURE_TOOL, {})) as {
      matured: number;
      outcomes: Array<{ id: string; verdict: string }>;
    };
    expect(res.matured).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ id: "5", verdict: "improved" });
    expect(auditEvents.some((e) => e.event === "gate_mature")).toBe(true);
  });

  it("rejects an invalid asOf timestamp", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    await expect(bridge.invokeTool(TUNER_MATURE_TOOL, { asOf: "not-a-date" })).rejects.toThrow(
      /valid ISO/,
    );
  });
});
