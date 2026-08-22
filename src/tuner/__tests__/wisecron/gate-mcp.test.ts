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
