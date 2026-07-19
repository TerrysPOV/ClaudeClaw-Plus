import { describe, it, expect } from "bun:test";
import { reconcile, type Finding, type LedgerEntry } from "../../wisecron/finding-ledger.js";

const T0 = "2026-07-19T00:00:00.000Z";
const T1 = "2026-07-19T04:00:00.000Z";
const T2 = "2026-07-19T08:00:00.000Z";
const T3 = "2026-07-19T12:00:00.000Z";

const f = (fingerprint: string, meta?: Record<string, unknown>): Finding => ({ fingerprint, meta });

describe("finding-ledger — reconcile (level-triggered lifecycle)", () => {
  it("a first sighting is pending, not firing (debounce)", () => {
    const r = reconcile([], [f("a")], T0, { forCycles: 2 });
    expect(r.entries[0]?.state).toBe("pending");
    expect(r.newlyFiring).toHaveLength(0);
  });

  it("crosses to firing after `forCycles` consecutive sightings", () => {
    const r1 = reconcile([], [f("a")], T0, { forCycles: 2 });
    const r2 = reconcile(r1.entries, [f("a")], T1, { forCycles: 2 });
    expect(r2.entries[0]?.state).toBe("firing");
    expect(r2.newlyFiring.map((e) => e.fingerprint)).toEqual(["a"]);
  });

  it("forCycles=1 fires immediately on first sighting", () => {
    const r = reconcile([], [f("a")], T0, { forCycles: 1 });
    expect(r.entries[0]?.state).toBe("firing");
    expect(r.newlyFiring).toHaveLength(1);
  });

  it("a firing finding stays firing without re-emitting newlyFiring", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 1 }); // fires
    s = reconcile(s.entries, [f("a")], T1, { forCycles: 1 }); // still present
    expect(s.entries[0]?.state).toBe("firing");
    expect(s.newlyFiring).toHaveLength(0); // no duplicate open edge
  });

  it("goes resolving (not resolved) after a single miss", () => {
    const open = reconcile([], [f("a")], T0, { forCycles: 1 });
    const r = reconcile(open.entries, [], T1, { resolveAfterCycles: 2 });
    expect(r.entries[0]?.state).toBe("resolving");
    expect(r.newlyResolved).toHaveLength(0);
  });

  it("resolves after `resolveAfterCycles` consecutive misses and drops the entry", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 1, resolveAfterCycles: 2 });
    s = reconcile(s.entries, [], T1, { resolveAfterCycles: 2 }); // miss 1 → resolving
    s = reconcile(s.entries, [], T2, { resolveAfterCycles: 2 }); // miss 2 → resolved
    expect(s.newlyResolved.map((e) => e.fingerprint)).toEqual(["a"]);
    expect(s.entries).toHaveLength(0); // emitted once, then dropped
  });

  it("re-fires when a resolving finding reappears", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 1, resolveAfterCycles: 3 });
    s = reconcile(s.entries, [], T1, { forCycles: 1, resolveAfterCycles: 3 }); // resolving
    s = reconcile(s.entries, [f("a")], T2, { forCycles: 1, resolveAfterCycles: 3 }); // back
    expect(s.entries[0]?.state).toBe("firing");
    expect(s.newlyFiring.map((e) => e.fingerprint)).toEqual(["a"]);
  });

  it("suppresses a flap: appear/miss/appear under the debounce never fires", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 3, resolveAfterCycles: 3 });
    s = reconcile(s.entries, [], T1, { forCycles: 3, resolveAfterCycles: 3 }); // miss → resolving
    s = reconcile(s.entries, [f("a")], T2, { forCycles: 3, resolveAfterCycles: 3 }); // back, seenStreak=1
    s = reconcile(s.entries, [], T3, { forCycles: 3, resolveAfterCycles: 3 }); // miss again
    // Never crossed forCycles=3 consecutive → never fired, never spammed.
    expect(s.newlyFiring).toHaveLength(0);
  });

  it("tracks multiple fingerprints independently and carries meta", () => {
    const r1 = reconcile([], [f("a", { severity: "high" }), f("b")], T0, { forCycles: 1 });
    const r2 = reconcile(r1.entries, [f("a", { severity: "high" })], T1, {
      forCycles: 1,
      resolveAfterCycles: 1,
    });
    const a = r2.entries.find((e) => e.fingerprint === "a");
    expect(a?.state).toBe("firing");
    expect(a?.meta?.severity).toBe("high");
    expect(a?.firstSeen).toBe(T0); // first_seen preserved across cycles
    expect(r2.newlyResolved.map((e) => e.fingerprint)).toEqual(["b"]); // b absent, resolveAfter=1
  });

  it("preserves firstSeen but advances lastSeen", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 1 });
    s = reconcile(s.entries, [f("a")], T2, { forCycles: 1 });
    expect(s.entries[0]?.firstSeen).toBe(T0);
    expect(s.entries[0]?.lastSeen).toBe(T2);
  });
});

// Type-level: LedgerEntry is exported and structural.
const _typecheck: LedgerEntry = {
  fingerprint: "x",
  state: "firing",
  firstSeen: T0,
  lastSeen: T0,
  seenStreak: 1,
  missStreak: 0,
};
void _typecheck;
