/**
 * The proposal-gate MCP surface (`gate-mcp.ts`): the seven `tuner__*` tools
 * registered on a real `PluginMcpBridge` and driven through `invokeTool`, the
 * way any MCP consumer reaches them. The engine/pipeline/recorder are stubbed
 * (their behaviour is covered by their own suites) so these tests pin the GATE
 * wiring: status reads, lifecycle transitions on the real `WisecronStateDB`,
 * and the `gate_*` audit provenance.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginMcpBridge } from "../../../plugins/mcp-bridge.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import type { WisecronBundle } from "../../../skills-tuner/cli/wisecron-bootstrap.js";
import { MAX_ALTERNATIVES } from "../../../skills-tuner/core/types.js";
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
let dbPath: string;
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

/**
 * Seed a row BEHIND the write path, the way an older binary left it. Rows that
 * the current emit gate would reject cannot go through `persistProposal` — and
 * a test for read-path tolerance must not lean on the write path tolerating the
 * same thing.
 */
/**
 * `status` is a plain `string`, not `ProposalStatus`, deliberately. A
 * production store holds rows in status `rejected` — a value nothing in this
 * codebase writes any more and that the union does not contain. Typing this
 * parameter to the union made the suite structurally incapable of writing the
 * shape that is actually on disk, which is exactly how the phantom-bucket
 * defect reached a green build.
 */
function seedLegacyRow(id: number, overrides: Partial<Proposal> = {}, status = "pending"): void {
  const proposal = { ...makeUnsigned(id), signature: "valid-sig", ...overrides } as Proposal;
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  raw
    .prepare(
      "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(String(id), proposal.subject, status, JSON.stringify(proposal), now, now);
  raw.close();
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
  dbPath = join(tmpDir, "wisecron.db");
  db = new WisecronStateDB(dbPath);
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

    const pending = db.listProposalsDetailed("pending").proposals;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("7");
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

    const pending = db.listProposalsDetailed("pending").proposals;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposal.pattern_signature.startsWith("research:")).toBe(true);
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
    expect(db.listProposalsDetailed("pending").proposals).toHaveLength(1);
  });

  it("dedups against a row the read path cannot rehydrate", async () => {
    registerWisecronGateTools(bridge, makeBundle());
    const args = {
      subject: "fake",
      target_path: join(tmpDir, "config.yaml"),
      pattern_signature: "model-upgrade-opus48",
      alternatives: [{ id: "upgrade", diff_or_content: "after", label: "", tradeoff: "" }],
    };
    const first = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as { id: string };

    // Corrupt the stored row behind the API. Dedup asks an existence question,
    // so it must not rehydrate the row and hard-error on the re-injection.
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE proposals SET proposal_json = ? WHERE id = ?")
      .run(JSON.stringify({ not: "a proposal" }), first.id);
    raw.close();

    const again = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as {
      id: string;
      deduped: boolean;
    };
    expect(again.id).toBe(first.id);
    expect(again.deduped).toBe(true);
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

  it("rejects a target_path OUTSIDE the subject's declared managed surface (gate scope guard)", async () => {
    // A subject that declares its managed surface. The gate must reject an
    // injected target_path outside it BEFORE persisting+signing — the self-sign
    // means apply's signature check gives no protection here.
    const managedPath = join(tmpDir, "agentic.yaml");
    const registry = {
      allSubjects: () => [{ name: "guarded" }],
      getSubject: (n: string) =>
        n === "guarded" ? { name: "guarded", managedTargets: () => [managedPath] } : undefined,
    };
    registerWisecronGateTools(bridge, makeBundle({ registry }));

    await expect(
      bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, {
        subject: "guarded",
        target_path: join(tmpDir, "engine.ts"),
        pattern_signature: "malicious",
        alternatives: [{ id: "a", diff_or_content: "PWNED", label: "", tradeoff: "" }],
      }),
    ).rejects.toThrow(/outside the managed surface/);
    // Nothing persisted.
    expect(db.listProposalsDetailed("pending").proposals).toHaveLength(0);
  });

  it("accepts a target_path INSIDE the declared managed surface", async () => {
    const managedPath = join(tmpDir, "agentic.yaml");
    const registry = {
      allSubjects: () => [{ name: "guarded" }],
      getSubject: (n: string) =>
        n === "guarded" ? { name: "guarded", managedTargets: () => [managedPath] } : undefined,
    };
    registerWisecronGateTools(bridge, makeBundle({ registry }));

    const res = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, {
      subject: "guarded",
      target_path: managedPath,
      pattern_signature: "legit",
      alternatives: [{ id: "a", diff_or_content: "modes: {}\n", label: "", tradeoff: "" }],
    })) as { deduped: boolean };
    expect(res.deduped).toBe(false);
    expect(db.listProposalsDetailed("pending").proposals).toHaveLength(1);
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
    expect(counts).toEqual({ pending: 2, applied: 0, refused: 1, total: 3 });
  });
});

describe("propose — one bad proposal is not the run's problem", () => {
  /** More alternatives than the runaway guard permits. */
  const tooMany = Array.from({ length: MAX_ALTERNATIVES + 1 }, (_, i) => ({
    id: `a${i + 1}`,
    label: "",
    diff_or_content: "after",
    tradeoff: "",
  }));

  it("persists the good proposals, names the refused one, and still audits the run", async () => {
    registerWisecronGateTools(
      bridge,
      makeBundle({
        engine: {
          runCycle: async () => ({
            proposals: [
              makeUnsigned(10),
              makeUnsigned(11, { alternatives: tooMany }),
              makeUnsigned(12),
            ],
            observations: 3,
            clusters: 1,
          }),
        },
      }),
    );

    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ subject: string; proposed: number }>;
      rejected?: Array<{ subject: string; id: number; error: string }>;
    };

    // The two well-formed proposals landed. Without per-proposal isolation the
    // throw escapes mid-loop: #10 stays on disk, #12 never gets written, and
    // the caller sees a bare ZodError.
    expect(res.total_proposed).toBe(2);
    expect(
      db
        .listProposalsDetailed()
        .proposals.map((p) => p.id)
        .sort(),
    ).toEqual(["10", "12"]);

    // The refusal is reported with enough to find the culprit.
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected?.[0]?.id).toBe(11);
    expect(res.rejected?.[0]?.subject).toBe("fake");
    expect(res.rejected?.[0]?.error ?? "").toContain("alternatives");

    // And the run is in the audit chain. A cycle that refused something still
    // happened — that is precisely the one an auditor needs to find later.
    const propose = auditEvents.find((e) => e.event === "gate_propose");
    expect(propose).toBeDefined();
    expect(propose?.detail?.rejected).toBe(1);
  });

  it("a subject whose cycle throws does not take the other subjects down", async () => {
    registerWisecronGateTools(
      bridge,
      makeBundle({
        registry: {
          allSubjects: () => [{ name: "boom" }, { name: "fake" }],
          getSubject: (n: string) => ({ name: n }),
        },
        engine: {
          runCycle: async (name: string) => {
            if (name === "boom") throw new Error("subject exploded");
            return { proposals: [makeUnsigned(20)], observations: 1, clusters: 1 };
          },
        },
      }),
    );

    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ subject: string; proposed: number; error?: string }>;
    };

    expect(res.total_proposed).toBe(1);
    expect(res.subjects.find((sub) => sub.subject === "boom")?.error).toContain("exploded");
    expect(res.subjects.find((sub) => sub.subject === "fake")?.proposed).toBe(1);
    expect(auditEvents.find((e) => e.event === "gate_propose")).toBeDefined();
  });
});

describe("propose_external — dedup tells apart 'recorded' from 'usable'", () => {
  it("flags a dedup that matched a row the read path cannot rehydrate", async () => {
    registerWisecronGateTools(bridge, makeBundle(), { source: "research" });

    const args = {
      subject: "fake",
      kind: "noop",
      target_path: join(tmpDir, "target-ext.txt"),
      pattern_signature: "research:dup-check",
      alternatives: [{ id: "a1", label: "", diff_or_content: "after", tradeoff: "" }],
    };

    const first = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as {
      id: string;
      deduped: boolean;
      existing_unreadable?: boolean;
    };
    expect(first.deduped).toBe(false);
    expect(first.existing_unreadable).toBeUndefined();

    // Corrupt the stored row behind the write path, the way an older binary
    // would have left it.
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE proposals SET proposal_json = ? WHERE id = ?")
      .run(JSON.stringify({ not: "a proposal" }), first.id);
    raw.close();

    const again = (await bridge.invokeTool(TUNER_PROPOSE_EXTERNAL_TOOL, args)) as {
      deduped: boolean;
      existing_unreadable?: boolean;
    };
    // Dedup is still right — the row exists. But saying only that would tell
    // the caller its finding is queued for review when the row cannot be
    // listed, applied or refused, and the deterministic id means every future
    // re-injection lands on the same unusable bytes.
    expect(again.deduped).toBe(true);
    expect(again.existing_unreadable).toBe(true);
  });
});

describe("listing surfaces — rows the read path cannot rehydrate", () => {
  /** Written when the emit bound still allowed four alternatives. */
  const legacyAlts = ["a1", "a2", "a3", "a4"].map((id) => ({
    id,
    label: "",
    diff_or_content: `content ${id}`,
    tradeoff: "",
  }));

  it("lists a stored row that carries four alternatives", async () => {
    seedLegacyRow(9, { alternatives: legacyAlts });
    registerWisecronGateTools(bridge, makeBundle());

    const res = (await bridge.invokeTool(TUNER_LIST_TOOL, {})) as {
      count: number;
      proposals: Array<{ id: string; alternatives: string[] }>;
      unreadable?: unknown[];
    };
    expect(res.count).toBe(1);
    expect(res.proposals[0]).toMatchObject({ id: "9", alternatives: ["a1", "a2", "a3", "a4"] });
    expect(res.unreadable).toBeUndefined();
  });

  it("status counts the readable rows and reports how many it skipped", async () => {
    seedPending(1);
    seedPending(2);
    db.setProposalStatus("2", "refused");
    // The shape that motivated this: a terminal row nobody will act on again,
    // carrying four alternatives, sitting in the way of an unfiltered walk.
    seedLegacyRow(4, { alternatives: legacyAlts }, "refused");
    seedLegacyRow(3, { signature: "" }); // unreadable: fails the read schema
    registerWisecronGateTools(bridge, makeBundle());

    const counts = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as Record<string, number>;
    expect(counts).toEqual({ pending: 1, applied: 0, refused: 2, total: 4, unreadable: 1 });
  });

  it("buckets a status value outside the lifecycle union instead of dropping it", async () => {
    seedPending(1);
    // The real production shape: three rows the daily cron left in `rejected`,
    // a status this binary no longer writes. They parse fine — so `unreadable`
    // never fires — and `counts[row.status]++` on a missing key yields NaN,
    // which crosses the MCP wire as `null`. The rows vanish from every bucket
    // and nothing in the response says so.
    seedLegacyRow(2, {}, "rejected");
    seedLegacyRow(3, {}, "rejected");
    registerWisecronGateTools(bridge, makeBundle());

    const counts = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as Record<string, unknown>;
    expect(counts).toEqual({
      pending: 1,
      applied: 0,
      refused: 0,
      total: 3,
      unknown_status: { rejected: 2 },
    });
  });

  it("the buckets always sum to total, whatever the store holds", async () => {
    seedPending(1);
    seedPending(2);
    db.setProposalStatus("2", "applied");
    seedLegacyRow(3, {}, "rejected");
    seedLegacyRow(4, { alternatives: legacyAlts }, "refused");
    seedLegacyRow(5, { signature: "" });
    registerWisecronGateTools(bridge, makeBundle());

    const c = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as {
      pending: number;
      applied: number;
      refused: number;
      total: number;
      unknown_status?: Record<string, number>;
      unreadable?: number;
    };
    const bucketed =
      c.pending +
      c.applied +
      c.refused +
      Object.values(c.unknown_status ?? {}).reduce((a, b) => a + b, 0) +
      (c.unreadable ?? 0);
    // The arithmetic is the guarantee. A summary that loses a row stops adding
    // up instead of looking clean.
    expect(bucketed).toBe(c.total);
    expect(c.total).toBe(5);
  });

  it("does not collapse when EVERY row is unreadable", async () => {
    // The reported outage in its purest form. A version that throws here —
    // rather than returning zeros plus a count — passes every other test in
    // this file.
    seedLegacyRow(1, { signature: "" });
    seedLegacyRow(2, { signature: "" });
    registerWisecronGateTools(bridge, makeBundle());

    const counts = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as Record<string, unknown>;
    expect(counts).toEqual({ pending: 0, applied: 0, refused: 0, total: 2, unreadable: 2 });

    const listing = (await bridge.invokeTool(TUNER_LIST_TOOL, {})) as {
      count: number;
      unreadable?: unknown[];
    };
    expect(listing.count).toBe(0);
    expect(listing.unreadable).toHaveLength(2);
  });

  it("list and pending return the good rows and name the skipped one", async () => {
    seedPending(1);
    seedLegacyRow(2, { signature: "" }); // unreadable: fails the read schema
    registerWisecronGateTools(bridge, makeBundle());

    for (const tool of [TUNER_LIST_TOOL, TUNER_PENDING_TOOL]) {
      const res = (await bridge.invokeTool(tool, {})) as {
        count: number;
        proposals: Array<{ id: string }>;
        unreadable?: Array<{ id: string; subject: string; error: string }>;
      };
      expect(res.count).toBe(1);
      expect(res.proposals[0]?.id).toBe("1");
      expect(res.unreadable).toHaveLength(1);
      expect(res.unreadable?.[0]).toMatchObject({ id: "2", subject: "fake" });
      expect(res.unreadable?.[0]?.error).toBeTruthy();
    }
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
    expect(db.getStoredProposal("5")?.status).toBe("applied");
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

  it("re-apply after a crash before the status flip RECONCILES, it does not re-apply", async () => {
    // Proposal is still pending but a live revision already exists on disk (the
    // apply persisted, the status flip did not). A naive re-apply would corrupt
    // the .bak + inverse. The gate must reconcile to the existing revision.
    seedPending(30);
    const rev = db.recordApply({
      proposal_id: "30",
      subject: "fake",
      forward_patch: { target_path: join(tmpDir, "t.txt"), kind: "patch", applied_content: "new" },
      inverse_patch: { target_path: join(tmpDir, "t.txt"), kind: "patch", applied_content: "old" },
      applied_by: "mcp",
    });
    let reapplied = false;
    const pipeline = {
      apply: async () => {
        reapplied = true;
        throw new Error("must not re-apply over a live revision");
      },
      revert: async () => {},
    };
    registerWisecronGateTools(bridge, makeBundle({ pipeline }));

    const res = (await bridge.invokeTool(TUNER_APPLY_TOOL, { id: "30" })) as {
      revision_id: number;
    };
    expect(reapplied).toBe(false);
    expect(res.revision_id).toBe(rev);
    expect(db.getStoredProposal("30")?.status).toBe("applied");
    expect(auditEvents.some((e) => e.event === "gate_apply" && e.detail?.reconciled === true)).toBe(
      true,
    );
  });
});

describe("tuner__refuse", () => {
  it("marks a pending proposal refused", async () => {
    seedPending(8);
    registerWisecronGateTools(bridge, makeBundle());
    const res = (await bridge.invokeTool(TUNER_REFUSE_TOOL, { id: "8" })) as { status: string };
    expect(res.status).toBe("refused");
    expect(db.getStoredProposal("8")?.status).toBe("refused");
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

// ── The summary's guarantees under hostile status values ────────────────────

describe("status — the sum holds whatever the status column says", () => {
  // Values that name members of Object.prototype. With a plain `{}` as the
  // tally, `unknownStatus[status] ?? 0` returns the INHERITED member instead
  // of undefined: `toString` makes `fn + 1` a string, the total stops being a
  // number, `unknown_status` is never attached and the degradation audit
  // never fires — a response that looks perfectly clean while a row is gone.
  // `__proto__` is worse: the assignment is swallowed by the setter.
  const HOSTILE = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

  for (const status of HOSTILE) {
    it(`counts a row in status '${status}' instead of losing it`, async () => {
      seedPending(1);
      seedLegacyRow(2, {}, status);
      registerWisecronGateTools(bridge, makeBundle());

      const c = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as {
        pending: number;
        applied: number;
        refused: number;
        total: number;
        unknown_status?: Record<string, number>;
        unreadable?: number;
      };
      const bucketed =
        c.pending +
        c.applied +
        c.refused +
        Object.values(c.unknown_status ?? {}).reduce((a, b) => a + b, 0) +
        (c.unreadable ?? 0);
      expect(bucketed).toBe(c.total);
      expect(c.total).toBe(2);
      expect(c.unknown_status?.[status]).toBe(1);
    });
  }
});

describe("store degradation is audited, once per state", () => {
  it("emits gate_store_degraded and does not re-emit on an unchanged store", async () => {
    seedPending(1);
    seedLegacyRow(2, { signature: "" }); // unreadable
    registerWisecronGateTools(bridge, makeBundle());

    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    const first = auditEvents.filter((e) => e.event === "gate_store_degraded");
    expect(first).toHaveLength(1);
    expect(first[0]?.detail?.unreadable).toBe(1);

    // `status` is the health-dashboard tool — it gets polled. Degradation is a
    // state, not an event: re-appending on every poll would bury the real
    // provenance records in a chain that never rotates.
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(1);
  });

  it("re-emits when the degradation itself changes", async () => {
    seedLegacyRow(1, { signature: "" });
    registerWisecronGateTools(bridge, makeBundle());
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(1);

    seedLegacyRow(2, { signature: "" });
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(2);
  });
});

describe("propose — a storage failure is not a subject's bug", () => {
  it("fails the subject instead of filing a disk error as a refused proposal", async () => {
    const brokenDb = {
      ...db,
      persistProposal: () => {
        throw new Error("database or disk is full");
      },
      listProposalsDetailed: () => ({ proposals: [], unreadable: [] }),
    };
    registerWisecronGateTools(
      bridge,
      makeBundle({
        db: brokenDb,
        engine: {
          runCycle: async () => ({ proposals: [makeUnsigned(1)], observations: 5, clusters: 2 }),
        },
      }),
    );

    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ subject: string; error?: string; observations?: number }>;
      rejected?: unknown[];
    };

    // Reporting this under `rejected` would show a healthy run that proposed
    // nothing, with the storage layer's failure blamed on the subject.
    expect(res.rejected).toBeUndefined();
    expect(res.subjects[0]?.error).toContain("disk is full");
    // And no fabricated zero: the cycle observed 5 things before it failed.
    expect(res.subjects[0]?.observations).toBeUndefined();
  });
});

// ── What a run reports when storage fails partway ───────────────────────────

describe("propose — rows written before a failure are still counted", () => {
  it("reports what actually reached the store, not zero", async () => {
    let calls = 0;
    const flakyDb = {
      ...db,
      persistProposal: (p: Proposal) => {
        calls++;
        // Two land, the third hits a full disk.
        if (calls > 2) throw new Error("database or disk is full");
        return db.persistProposal(p);
      },
      listProposalsDetailed: () => db.listProposalsDetailed(),
    };
    registerWisecronGateTools(
      bridge,
      makeBundle({
        db: flakyDb,
        engine: {
          runCycle: async () => ({
            proposals: [makeUnsigned(1), makeUnsigned(2), makeUnsigned(3)],
            observations: 4,
            clusters: 1,
          }),
        },
      }),
    );

    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ proposed: number; error?: string; observations?: number }>;
    };

    // `persistProposal` is a bare autocommit INSERT — the two rows are
    // durably on disk and pending apply. Reporting 0 would be a summary that
    // loses rows while looking clean, which is the defect this whole change
    // set exists to remove.
    expect(
      db
        .listProposalsDetailed()
        .proposals.map((p) => p.id)
        .sort(),
    ).toEqual(["1", "2"]);
    expect(res.total_proposed).toBe(2);
    expect(res.subjects[0]?.proposed).toBe(2);
    expect(res.subjects[0]?.error).toContain("disk is full");
    // Still unknown, still omitted — unlike `proposed`, which is measured.
    expect(res.subjects[0]?.observations).toBeUndefined();
  });
});

describe("store degradation audit — per view, and it recovers", () => {
  it("does not suppress one tool's report because another tool reported first", async () => {
    seedPending(1);
    seedLegacyRow(2, {}, "rejected");
    seedLegacyRow(3, { signature: "" });
    registerWisecronGateTools(bridge, makeBundle());

    // A dashboard polls more than one tool. `status` walks every row and
    // carries unknown_status; `pending` sees only its filtered slice. With a
    // single shared slot the two thrash each other and nothing is suppressed.
    for (let i = 0; i < 4; i++) {
      await bridge.invokeTool(TUNER_STATUS_TOOL, {});
      await bridge.invokeTool(TUNER_PENDING_TOOL, {});
    }
    const records = auditEvents.filter((e) => e.event === "gate_store_degraded");
    // One per distinct view, not one per poll.
    expect(records).toHaveLength(2);
    // `pending` is keyed as the query it runs, not as its own tool name —
    // `tuner__pending` and `tuner__list(pending)` are the same query and must
    // not record one state twice.
    expect(new Set(records.map((r) => r.detail?.scope))).toEqual(
      new Set(["status", "list:pending"]),
    );
  });

  it("audits a degradation again after it was repaired", async () => {
    seedLegacyRow(1, { signature: "" });
    registerWisecronGateTools(bridge, makeBundle());
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(1);

    // Repaired: the healthy read must CLEAR what was remembered, otherwise an
    // identical recurrence matches the stale fingerprint and is never
    // recorded again — and the chain shows a degradation that never ended.
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM proposals WHERE id = ?").run("1");
    raw.close();
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});

    seedLegacyRow(1, { signature: "" });
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(2);
  });
});

// ── The three regressions the fourth review found ───────────────────────────

describe("store degradation audit — scope is the query, not the tool", () => {
  it("does not flood when one tool is polled with different filters", async () => {
    // `tuner__list` has four scopes: unfiltered, plus each status. Keying the
    // memory on the tool name puts all four in one slot, and a dashboard with
    // status tabs thrashes it — which is the exact flood the dedup exists to
    // stop, reproduced through a single tool.
    seedPending(1);
    seedLegacyRow(2, { signature: "" }); // unreadable, status pending
    seedLegacyRow(3, { signature: "" }, "applied"); // unreadable, status applied
    registerWisecronGateTools(bridge, makeBundle());

    for (let i = 0; i < 5; i++) {
      await bridge.invokeTool(TUNER_LIST_TOOL, { status: "pending" });
      await bridge.invokeTool(TUNER_LIST_TOOL, { status: "applied" });
    }
    // One per distinct scope, not one per poll.
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(2);
  });

  it("a healthy slice does not erase a degraded slice's memory", async () => {
    seedPending(1);
    seedLegacyRow(2, { signature: "" }); // only `pending` is degraded
    registerWisecronGateTools(bridge, makeBundle());

    for (let i = 0; i < 5; i++) {
      await bridge.invokeTool(TUNER_LIST_TOOL, { status: "pending" });
      // `applied` is clean. Clearing on a healthy read must clear only its
      // OWN scope: a clean answer to one question says nothing about another.
      await bridge.invokeTool(TUNER_LIST_TOOL, { status: "applied" });
    }
    expect(auditEvents.filter((e) => e.event === "gate_store_degraded")).toHaveLength(1);
  });
});

describe("a failing audit sink does not take the query down", () => {
  it("still answers status, pending and list when append throws", async () => {
    seedPending(1);
    seedLegacyRow(2, { signature: "" });
    registerWisecronGateTools(
      bridge,
      makeBundle({
        audit: {
          append: () => {
            throw new Error("ENOSPC: no space left on device, write");
          },
        },
      }),
    );

    // These are READS. Before this file started auditing them they could not
    // fail on a disk problem, and a decoration must not kill what it
    // decorates — least of all on a store that is already degraded.
    const st = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as { total: number };
    expect(st.total).toBe(2);
    const pend = (await bridge.invokeTool(TUNER_PENDING_TOOL, {})) as { count: number };
    expect(pend.count).toBe(1);
    const list = (await bridge.invokeTool(TUNER_LIST_TOOL, {})) as { count: number };
    expect(list.count).toBe(1);
  });
});

describe("propose — counts insertions, not presentations", () => {
  it("reports zero new proposals when the window is re-run", async () => {
    const bundle = makeBundle({
      engine: {
        runCycle: async () => ({
          proposals: [makeUnsigned(1), makeUnsigned(2)],
          observations: 3,
          clusters: 1,
        }),
      },
    });
    registerWisecronGateTools(bridge, bundle);

    const first = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ proposed: number; deduped?: number }>;
    };
    expect(first.total_proposed).toBe(2);
    expect(first.subjects[0]?.deduped).toBeUndefined();

    // `persistProposal` is idempotent — the same proposals present again and
    // nothing is written. Counting the calls would report a steady stream of
    // proposals from a cron that writes nothing.
    const second = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      total_proposed: number;
      subjects: Array<{ proposed: number; deduped?: number }>;
    };
    expect(second.total_proposed).toBe(0);
    expect(second.subjects[0]?.proposed).toBe(0);
    expect(second.subjects[0]?.deduped).toBe(2);
    expect(db.listProposalsDetailed().proposals).toHaveLength(2);
  });
});

// ── The fifth review's findings ─────────────────────────────────────────────

describe("status — capping the response never breaks the sum", () => {
  it("carries omitted statuses as a ROW count, not a name count", async () => {
    // 25 distinct out-of-union statuses, one row each. Only 20 names fit in
    // the response; the remaining rows must still be accounted for, or the
    // cap meant to stop a runaway response reintroduces the silent loss this
    // whole change set exists to remove.
    // 21 statuses over 25 rows: four of them hold two rows each, so a name
    // count and a row count cannot coincide. A fixture with one row per
    // status passes under either semantics and proves nothing about which
    // one is implemented.
    for (let i = 1; i <= 21; i++) seedLegacyRow(i, {}, `legacy-${i}`);
    for (let i = 22; i <= 25; i++) seedLegacyRow(i, {}, `legacy-${i - 21}`);
    registerWisecronGateTools(bridge, makeBundle());

    const c = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as {
      pending: number;
      applied: number;
      refused: number;
      total: number;
      unknown_status?: Record<string, number>;
      unknown_status_other?: number;
      unknown_status_names_omitted?: number;
      unreadable?: number;
    };
    const bucketed =
      c.pending +
      c.applied +
      c.refused +
      Object.values(c.unknown_status ?? {}).reduce((a, b) => a + b, 0) +
      (c.unknown_status_other ?? 0) +
      (c.unreadable ?? 0);
    expect(c.total).toBe(25);
    expect(bucketed).toBe(c.total);
    expect(Object.keys(c.unknown_status ?? {})).toHaveLength(20);
    // One status name omitted, but the rows behind the omission are what the
    // remainder must count.
    expect(c.unknown_status_names_omitted).toBe(1);
    expect(c.unknown_status_other).toBe(
      25 - Object.values(c.unknown_status ?? {}).reduce((a, b) => a + b, 0),
    );
  });

  it("counts ROWS, not names, when the omitted status is heavily populated", async () => {
    // The listing walks newest-first, so `created_at` decides which statuses
    // get named. Set it explicitly rather than relying on insert order at
    // millisecond resolution: the whole point is to force the HEAVY status to
    // be the one left out.
    const raw = new Database(dbPath);
    const ins = raw.prepare(
      "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    let id = 1;
    // 20 distinct statuses, one row each, newest — these fill the 20 slots.
    for (let i = 1; i <= 20; i++) {
      const ts = `2026-08-2${i % 10}T12:00:00.000Z`;
      ins.run(
        String(id),
        "fake",
        `s${i}`,
        JSON.stringify({ ...makeUnsigned(id), signature: "valid-sig" }),
        ts,
        ts,
      );
      id++;
    }
    // One status holding 50 rows, oldest — omitted from the names.
    for (let i = 0; i < 50; i++) {
      const ts = "2026-01-01T00:00:00.000Z";
      ins.run(
        String(id),
        "fake",
        "bulk",
        JSON.stringify({ ...makeUnsigned(id), signature: "valid-sig" }),
        ts,
        ts,
      );
      id++;
    }
    raw.close();
    registerWisecronGateTools(bridge, makeBundle());

    const c = (await bridge.invokeTool(TUNER_STATUS_TOOL, {})) as {
      total: number;
      unknown_status?: Record<string, number>;
      unknown_status_other?: number;
      unknown_status_names_omitted?: number;
    };
    const named = Object.values(c.unknown_status ?? {}).reduce((a, b) => a + b, 0);
    expect(c.total).toBe(70);
    // A name count would say "1 omitted" and hide 50 rows.
    expect(c.unknown_status_names_omitted).toBe(1);
    expect(c.unknown_status_other).toBe(50);
    expect(named + (c.unknown_status_other ?? 0)).toBe(70);
  });
});

describe("propose — deduped is reported wherever proposed is", () => {
  it("survives the error path and reaches the audit chain", async () => {
    const bundle = makeBundle({
      engine: {
        runCycle: async () => ({
          proposals: [makeUnsigned(1), makeUnsigned(2)],
          observations: 3,
          clusters: 1,
        }),
      },
    });
    registerWisecronGateTools(bridge, bundle);
    await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 });

    auditEvents.length = 0;
    const again = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      subjects: Array<{ deduped?: number }>;
    };
    expect(again.subjects[0]?.deduped).toBe(2);
    // An auditor reading the chain must be able to tell "produced nothing"
    // from "re-presented two known findings".
    const rec = auditEvents.find((e) => e.event === "gate_propose");
    expect(rec?.detail?.deduped).toBe(2);
  });

  it("keeps deduped on the subject row when the cycle then fails", async () => {
    // First run stores both.
    registerWisecronGateTools(
      bridge,
      makeBundle({
        engine: {
          runCycle: async () => ({
            proposals: [makeUnsigned(1), makeUnsigned(2)],
            observations: 2,
            clusters: 1,
          }),
        },
      }),
    );
    await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 });

    // Second run re-presents both — deduped — and then hits a storage
    // failure on a third. `deduped` is as measured as `proposed` at that
    // point, so dropping it is the same absence the code refuses next door.
    let calls = 0;
    const flaky = {
      ...db,
      persistProposal: (p: Proposal) => {
        calls++;
        if (calls > 2) throw new Error("database or disk is full");
        return db.persistProposal(p);
      },
      listProposalsDetailed: () => db.listProposalsDetailed(),
    };
    registerWisecronGateTools(
      bridge,
      makeBundle({
        db: flaky,
        engine: {
          runCycle: async () => ({
            proposals: [makeUnsigned(1), makeUnsigned(2), makeUnsigned(3)],
            observations: 2,
            clusters: 1,
          }),
        },
      }),
    );
    const res = (await bridge.invokeTool(TUNER_PROPOSE_TOOL, { sinceHours: 12 })) as {
      subjects: Array<{ proposed: number; deduped?: number; error?: string }>;
    };
    expect(res.subjects[0]?.error).toContain("disk is full");
    expect(res.subjects[0]?.proposed).toBe(0);
    expect(res.subjects[0]?.deduped).toBe(2);
  });
});

describe("the degradation record carries rows, like the response does", () => {
  it("records how many rows sit behind an omitted status name", async () => {
    // 20 statuses of one row, plus one holding fifty. The heavy one is the
    // one left out of the names — so a record that counts only names would
    // say "1 omitted" and lose fifty rows, with nothing to recover them from.
    const raw = new Database(dbPath);
    const ins = raw.prepare(
      "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    let id = 1;
    for (let i = 1; i <= 20; i++) {
      const ts = `2026-08-2${i % 10}T12:00:00.000Z`;
      ins.run(
        String(id),
        "fake",
        `s${i}`,
        JSON.stringify({ ...makeUnsigned(id), signature: "valid-sig" }),
        ts,
        ts,
      );
      id++;
    }
    for (let i = 0; i < 50; i++) {
      const ts = "2026-01-01T00:00:00.000Z";
      ins.run(
        String(id),
        "fake",
        "bulk",
        JSON.stringify({ ...makeUnsigned(id), signature: "valid-sig" }),
        ts,
        ts,
      );
      id++;
    }
    raw.close();
    registerWisecronGateTools(bridge, makeBundle());
    await bridge.invokeTool(TUNER_STATUS_TOOL, {});

    const rec = auditEvents.find((e) => e.event === "gate_store_degraded");
    expect(rec?.detail?.unknown_status_rows).toBe(70);
    expect(rec?.detail?.unknown_status_names_omitted).toBe(1);
  });
});
