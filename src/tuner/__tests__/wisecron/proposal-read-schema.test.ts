/**
 * Read path vs emit path for a persisted proposal.
 *
 * The bound on `alternatives` constrains what a subject may EMIT. While one
 * schema served both directions it also gated rehydration, so a row written
 * without that runtime check — `persistProposal` stringifies without
 * re-validating — became unreadable on the way back out. And, because the
 * listing path parsed rows eagerly, that single row failed every query walking
 * it, counts over unrelated valid rows included.
 *
 * These tests pin both halves: the emit bound is enforced at persist time, the
 * read schema no longer applies it, and a listing survives a row it cannot
 * parse while still naming it. Rows an older binary would have left behind are
 * seeded with a raw INSERT — a test for read-path tolerance must not depend on
 * the write path tolerating the same thing.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WisecronStateDB } from "../../wisecron/state-db.js";
import type { ProposalStatus } from "../../wisecron/state-db.js";
import {
  MAX_ALTERNATIVES,
  PersistedProposalSchema,
  ProposalSchema,
  UnsignedProposalSchema,
} from "../../../skills-tuner/core/types.js";
import type { Alternative, Proposal, UnsignedProposal } from "../../../skills-tuner/core/types.js";
import {
  computeProposalSignature,
  verifyProposalSignature,
} from "../../../skills-tuner/core/security.js";

let tmpDir: string;
let dbPath: string;
let db: WisecronStateDB;

/**
 * A row as an older binary left it: written BEHIND the current write path, which
 * is the only honest way to stand in for bytes already on disk. Seeding through
 * `persistProposal` would prove nothing — that path validates.
 */
function seedLegacyRow(proposal: Proposal, status: ProposalStatus = "pending"): void {
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  raw
    .prepare(
      "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(String(proposal.id), proposal.subject, status, JSON.stringify(proposal), now, now);
  raw.close();
}

function alts(n: number): Alternative[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i + 1}`,
    label: `alt ${i + 1}`,
    diff_or_content: `content ${i + 1}`,
    tradeoff: "",
  }));
}

function makeProposal(id: number, alternatives: Alternative[] = alts(2)): Proposal {
  return {
    id,
    cluster_id: `c${id}`,
    subject: "fake",
    kind: "noop",
    target_path: join(tmpDir, `target-${id}.txt`),
    pattern_signature: `sig:${id}`,
    created_at: new Date("2026-01-01T00:00:00Z"),
    alternatives,
    signature: "valid-sig",
  } as Proposal;
}

/** A row whose stored JSON no longer satisfies the read schema (empty signature). */
function makeCorrupt(id: number): Proposal {
  return { ...makeProposal(id), signature: "" } as Proposal;
}

/** Sorted ids of a listing, for order-independent assertions. */
function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
}

/** What `rowToStoredProposal` sees: the proposal after a JSON round-trip. */
function persistedJson(p: Proposal): unknown {
  return JSON.parse(JSON.stringify(p));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "proposal-read-schema-"));
  dbPath = join(tmpDir, "wisecron.db");
  db = new WisecronStateDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("proposal schemas — emit bound vs read bound", () => {
  it("the emit schemas still reject more alternatives than the bound allows", () => {
    // Expressed against the constant, not a literal. The bound is a runaway
    // guard whose value may move; what must hold is that going past it is
    // refused, and the error says which field.
    const over = MAX_ALTERNATIVES + 1;
    const { signature: _sig, ...unsigned } = makeProposal(1, alts(over));
    expect(() => UnsignedProposalSchema.parse(unsigned)).toThrow(/alternatives/);
    expect(() => ProposalSchema.parse(makeProposal(1, alts(over)))).toThrow(/alternatives/);
  });

  it("the emit schemas accept the counts real subjects actually emit", () => {
    // Four is not hypothetical: the `memory` subject emitted four on three
    // consecutive daily runs in production, and a capability with four
    // approved plugins produces four. An emit bound that rejects these
    // rejects honest work.
    expect(ProposalSchema.parse(makeProposal(1, alts(4))).alternatives).toHaveLength(4);
    expect(ProposalSchema.parse(makeProposal(1, alts(MAX_ALTERNATIVES))).alternatives).toHaveLength(
      MAX_ALTERNATIVES,
    );
  });

  it("the read schema accepts a row written under a looser bound", () => {
    const parsed = PersistedProposalSchema.parse(persistedJson(makeProposal(1, alts(4))));
    expect(parsed.alternatives).toHaveLength(4);
    expect(parsed.alternatives.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("the read schema keeps every other constraint (lower bound, signature, dates)", () => {
    expect(() => PersistedProposalSchema.parse(persistedJson(makeProposal(1, [])))).toThrow();
    expect(() => PersistedProposalSchema.parse(persistedJson(makeCorrupt(1)))).toThrow();
    const parsed = PersistedProposalSchema.parse(persistedJson(makeProposal(1)));
    expect(parsed.created_at).toBeInstanceOf(Date);
    expect(parsed.created_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("WisecronStateDB — the emit gate at persist time", () => {
  it("refuses a proposal carrying more alternatives than the emit bound allows", () => {
    expect(() => db.persistProposal(makeProposal(1, alts(MAX_ALTERNATIVES + 1)))).toThrow(
      /alternatives/,
    );
    expect(db.listProposalsDetailed().proposals).toEqual([]);
  });

  it("names the proposal in the refusal, not just the failing field", () => {
    // A bare ZodError dump gives an operator no way to find the culprit among
    // a whole propose cycle's worth of subjects.
    expect(() => db.persistProposal(makeProposal(77, alts(MAX_ALTERNATIVES + 1)))).toThrow(/77/);
  });

  it("accepts a proposal inside the bound", () => {
    db.persistProposal(makeProposal(1, alts(4)));
    expect(db.getStoredProposal("1")?.proposal.alternatives).toHaveLength(4);
  });
});

describe("WisecronStateDB — rehydrating persisted proposals", () => {
  it("reads back a legacy row carrying four alternatives", () => {
    seedLegacyRow(makeProposal(1, alts(4)), "refused");

    expect(db.getStoredProposal("1")?.proposal.alternatives).toHaveLength(4);
    expect(db.listProposalsDetailed().proposals).toHaveLength(1);
    expect(db.listProposalsDetailed("refused").proposals).toHaveLength(1);
  });

  it("reads back a well-formed store unchanged, with nothing reported unreadable", () => {
    db.persistProposal(makeProposal(1));
    db.persistProposal(makeProposal(2));
    db.setProposalStatus("2", "refused");

    const listing = db.listProposalsDetailed();
    expect(listing.unreadable).toEqual([]);
    expect(ids(listing.proposals)).toEqual(["1", "2"]);
    expect(ids(db.listProposalsDetailed("refused").proposals)).toEqual(["2"]);
    const alternatives = db.getStoredProposal("1")?.proposal.alternatives;
    expect(alternatives?.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("returns the good rows and names the one it skipped", () => {
    db.persistProposal(makeProposal(1));
    seedLegacyRow(makeCorrupt(2));
    seedLegacyRow(makeProposal(3, alts(4)), "refused");

    const listing = db.listProposalsDetailed();
    expect(ids(listing.proposals)).toEqual(["1", "3"]);
    expect(listing.unreadable).toHaveLength(1);
    expect(listing.unreadable[0]).toMatchObject({ id: "2", subject: "fake", status: "pending" });
    expect(listing.unreadable[0]?.error).toBeTruthy();
  });

  it("isolates the bad row on a status-filtered listing too", () => {
    db.persistProposal(makeProposal(1));
    seedLegacyRow(makeCorrupt(2));

    const listing = db.listProposalsDetailed("pending");
    expect(ids(listing.proposals)).toEqual(["1"]);
    expect(ids(listing.unreadable)).toEqual(["2"]);
  });

  it("still throws when a single-row fetch names the unreadable row", () => {
    seedLegacyRow(makeCorrupt(2));

    expect(() => db.getStoredProposal("2")).toThrow();
    expect(db.getStoredProposal("404")).toBeNull();
  });

  it("answers existence for an unreadable row without rehydrating it", () => {
    seedLegacyRow(makeCorrupt(2));

    expect(db.hasProposal("2")).toBe(true);
    expect(db.hasProposal("404")).toBe(false);
  });
});

// ── What the read schema must still guarantee ────────────────────────────────

describe("WisecronStateDB — the read schema's remaining strictness", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-schema-strict-"));
    dbPath = join(tmpDir, "wisecron.db");
    db = new WisecronStateDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed behind the write path so a row can be missing a field the emit
   * schema requires — which is the only way to stand in for bytes an older
   * binary left on disk.
   */
  function seedRaw(id: number, proposalJson: unknown, status = "pending"): void {
    const raw = new Database(dbPath);
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(String(id), "fake", status, JSON.stringify(proposalJson), now, now);
    raw.close();
  }

  // The whole thesis of the relaxation is "one bound goes, everything else
  // stays strict". Nothing pinned that: the read schema could be loosened on
  // any of these fields with the entire suite green.
  const REQUIRED_FIELDS = [
    "id",
    "cluster_id",
    "subject",
    "kind",
    "target_path",
    "pattern_signature",
    "created_at",
    "signature",
    "alternatives",
  ] as const;

  for (const field of REQUIRED_FIELDS) {
    it(`still refuses a row missing '${field}'`, () => {
      const { [field]: _dropped, ...withoutField } = persistedJson(makeProposal(1)) as Record<
        string,
        unknown
      >;
      seedRaw(1, withoutField);
      const { proposals, unreadable } = db.listProposalsDetailed();
      expect(proposals).toEqual([]);
      expect(unreadable).toHaveLength(1);
      // The diagnostic has to name the field. "something failed" leaves an
      // operator with a row they cannot act on and no idea why.
      expect(unreadable[0]?.error ?? "").toContain(field);
    });
  }

  it("keeps created_at a Date through the store, because the signature depends on it", () => {
    // `proposalCanonical` calls `created_at.toISOString()`, and the apply path
    // verifies the signature on the REHYDRATED proposal. Drop the coercion and
    // `created_at` comes back a string: verification throws
    // "toISOString is not a function" at apply time, far from the cause.
    db.persistProposal(makeProposal(1));
    const back = db.getStoredProposal("1");
    expect(back?.proposal.created_at).toBeInstanceOf(Date);
  });

  it("a proposal signed on the way in still verifies on the way out", () => {
    // End-to-end, not against the schema in isolation: sign, persist,
    // rehydrate, verify. This is the round-trip the apply path performs.
    const secret = Buffer.from("test-secret-for-round-trip");
    const { signature: _unused, ...unsigned } = makeProposal(1, alts(4));
    const signed = {
      ...unsigned,
      signature: computeProposalSignature(unsigned as UnsignedProposal, secret),
    } as Proposal;

    db.persistProposal(signed);
    const back = db.getStoredProposal("1");
    if (!back) throw new Error("the row did not round-trip at all");
    expect(verifyProposalSignature(back.proposal, secret)).toBe(true);
  });

  it("isolates a structurally alien row, not just a near-miss", () => {
    // Every other isolation test corrupts by emptying `signature`. A fixture
    // that shares one shape cannot show the isolation is general — relax that
    // one field and the fixture silently stops being corrupt.
    seedRaw(1, { not: "a proposal" });
    db.persistProposal(makeProposal(2));

    const { proposals, unreadable } = db.listProposalsDetailed();
    expect(proposals.map((p) => p.id)).toEqual(["2"]);
    expect(unreadable.map((r) => r.id)).toEqual(["1"]);
  });

  it("returns an empty listing rather than throwing when EVERY row is unreadable", () => {
    seedRaw(1, { not: "a proposal" });
    seedRaw(2, { also: "not one" });
    const { proposals, unreadable } = db.listProposalsDetailed();
    expect(proposals).toEqual([]);
    expect(unreadable).toHaveLength(2);
  });
});

// ── Degraded-store ergonomics ───────────────────────────────────────────────

describe("WisecronStateDB — what a caller is told when a row will not rehydrate", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-schema-degraded-"));
    dbPath = join(tmpDir, "wisecron.db");
    db = new WisecronStateDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRawRow(id: number, proposalJson: unknown): void {
    const raw = new Database(dbPath);
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO proposals(id, subject, status, proposal_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(String(id), "fake", "pending", JSON.stringify(proposalJson), now, now);
    raw.close();
  }

  it("the back-compat listing refuses rather than returning a short list", () => {
    db.persistProposal(makeProposal(1));
    seedRawRow(2, { not: "a proposal" });

    // The old shape has nowhere to say "and one row was skipped", so quietly
    // returning one row would hand a caller a truncated listing it has no
    // reason to distrust — the silent loss this store was changed to stop.
    expect(() => db.listProposals()).toThrow(/could not be rehydrated/);
    expect(() => db.listProposals()).toThrow(/listProposalsDetailed/);

    // Undegraded, it behaves exactly as before.
    const clean = new WisecronStateDB(join(tmpDir, "clean.db"));
    try {
      clean.persistProposal(makeProposal(3));
      expect(clean.listProposals().map((p) => p.id)).toEqual(["3"]);
    } finally {
      clean.close();
    }
  });

  it("names the row and its state when a lifecycle read fails", () => {
    seedRawRow(7, { not: "a proposal" });
    // apply/refuse both come through getStoredProposal, so this is the error
    // an operator actually meets. A bare schema dump gives them nothing.
    expect(() => db.getStoredProposal("7")).toThrow(/#7/);
    expect(() => db.getStoredProposal("7")).toThrow(/subject 'fake'/);
    expect(() => db.getStoredProposal("7")).toThrow(/status 'pending'/);
    // Still throws rather than returning null: null would read as "no such
    // proposal" for a row that is very much on disk.
    expect(db.getStoredProposal("404")).toBeNull();
  });
});
