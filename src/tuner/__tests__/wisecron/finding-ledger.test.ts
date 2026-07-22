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

  it("a resolving finding that reappears returns to firing WITHOUT a new open edge", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 1, resolveAfterCycles: 3 });
    s = reconcile(s.entries, [], T1, { forCycles: 1, resolveAfterCycles: 3 }); // resolving (not resolved)
    s = reconcile(s.entries, [f("a")], T2, { forCycles: 1, resolveAfterCycles: 3 }); // back
    expect(s.entries[0]?.state).toBe("firing");
    // It never emitted a matching newlyResolved, so returning is NOT a new open
    // — re-emitting newlyFiring would be an unbalanced edge (Alertmanager keeps
    // it continuously firing). The alert stays open with its original firstSeen.
    expect(s.newlyFiring).toHaveLength(0);
    expect(s.entries[0]?.firstSeen).toBe(T0);
  });

  it("an alternating (present/absent) finding emits exactly one open edge across the oscillation", () => {
    let opens = 0;
    let s = reconcile([], [f("a")], T0, { forCycles: 1, resolveAfterCycles: 3 }); // open #1
    opens += s.newlyFiring.length;
    for (const [present, t] of [
      [false, T1],
      [true, T2],
      [false, T3],
      [true, T0],
    ] as const) {
      s = reconcile(s.entries, present ? [f("a")] : [], t, { forCycles: 1, resolveAfterCycles: 3 });
      opens += s.newlyFiring.length;
    }
    expect(opens).toBe(1); // no re-spam while it stays open (never resolved)
  });

  it("clamps a non-finite debounce config to the default instead of poisoning the threshold", () => {
    // Math.max(1, NaN) === NaN would make `seenStreak >= NaN` always false → nothing
    // ever fires. NaN must fall back to the default (2): pending, then firing.
    const r1 = reconcile([], [f("a")], T0, { forCycles: Number.NaN });
    expect(r1.entries[0]?.state).toBe("pending");
    const r2 = reconcile(r1.entries, [f("a")], T1, { forCycles: Number.NaN });
    expect(r2.entries[0]?.state).toBe("firing");
  });

  it("dedups a duplicate-fingerprint prior on resolve (one close edge, not two)", () => {
    const dup: LedgerEntry[] = [
      {
        fingerprint: "a",
        state: "firing",
        firstSeen: T0,
        lastSeen: T0,
        seenStreak: 3,
        missStreak: 0,
      },
      {
        fingerprint: "a",
        state: "firing",
        firstSeen: T0,
        lastSeen: T0,
        seenStreak: 3,
        missStreak: 0,
      },
    ];
    const r = reconcile(dup, [], T1, { resolveAfterCycles: 1 });
    expect(r.newlyResolved).toHaveLength(1);
  });

  it("suppresses a flap: appear/miss/appear under the debounce never fires", () => {
    let s = reconcile([], [f("a")], T0, { forCycles: 3, resolveAfterCycles: 3 });
    s = reconcile(s.entries, [], T1, { forCycles: 3, resolveAfterCycles: 3 }); // miss → resolving
    s = reconcile(s.entries, [f("a")], T2, { forCycles: 3, resolveAfterCycles: 3 }); // back, seenStreak=1
    s = reconcile(s.entries, [], T3, { forCycles: 3, resolveAfterCycles: 3 }); // miss again
    // Never crossed forCycles=3 consecutive → never fired, never spammed.
    expect(s.newlyFiring).toHaveLength(0);
  });

  it("a firing finding survives a single-cycle blip without dropping out of firing (#320 review)", () => {
    // Defaults: forCycles=2, resolveAfterCycles=2.
    let s = reconcile([], [f("a")], T0); // pending (seen=1)
    s = reconcile(s.entries, [f("a")], T1); // firing (seen=2)
    expect(s.entries[0]?.state).toBe("firing");
    s = reconcile(s.entries, [], T2); // one miss → resolving (still open, < resolveAfter)
    expect(s.entries[0]?.state).toBe("resolving");
    s = reconcile(s.entries, [f("a")], T3); // back after the blip
    // Pre-fix bug: demoted to `pending` (seenStreak reset on entering resolving),
    // so it fell out of the firing set and needed a full re-debounce. Fixed:
    // a confirmed-open finding that reappears stays firing.
    expect(s.entries[0]?.state).toBe("firing");
  });

  it("a still-pending finding that vanishes emits no resolve edge (never opened) (#320 review)", () => {
    // forCycles=3 keeps it pending; it never fires, so a disappearance must not
    // synthesize a `resolved` close-edge for an alert that never opened.
    let s = reconcile([], [f("a")], T0, { forCycles: 3, resolveAfterCycles: 2 }); // pending
    s = reconcile(s.entries, [], T1, { forCycles: 3, resolveAfterCycles: 2 }); // gone
    s = reconcile(s.entries, [], T2, { forCycles: 3, resolveAfterCycles: 2 }); // still gone
    expect(s.newlyResolved).toHaveLength(0); // never fired → no close edge
    expect(s.entries).toHaveLength(0); // simply dropped
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
