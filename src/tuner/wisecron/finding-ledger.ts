/**
 * finding-ledger — a fingerprint-keyed lifecycle ledger for finding-based tuner
 * subjects. Producers emit INSTANTANEOUS findings (a system advisory, a degraded
 * signal, a low-ROI plugin); this ledger owns the state ACROSS runs so a subject
 * acts on stable transitions, not on every raw sighting.
 *
 * Level-triggered (Kubernetes-reconcile style, not edge-triggered): each cycle
 * passes the CURRENT set of findings + the prior ledger and gets the next ledger.
 * A crashed/restarted producer simply re-reads current state and resumes — no
 * memory of "where it was" is required. Model mirrors Prometheus/Alertmanager's
 * `inactive → pending(for) → firing → resolved`: the `for`/debounce suppresses
 * flapping, and a finding auto-resolves once its fingerprint stops recurring.
 *
 * Pure + I/O-free: `reconcile()` takes state and a caller-supplied `nowIso`,
 * returns the next state + the transitions (newly firing / newly resolved) the
 * caller reacts to. Persistence (jsonl) is the caller's concern.
 */

/** `pending` = seen but under the debounce; `firing` = confirmed open;
 *  `resolving` = was open, now absent but under the resolve debounce;
 *  `resolved` = confirmed gone (emitted once, then dropped by the caller). */
export type FindingState = "pending" | "firing" | "resolving" | "resolved";

export interface LedgerEntry {
  fingerprint: string;
  state: FindingState;
  firstSeen: string;
  lastSeen: string;
  /** Consecutive cycles the fingerprint was present. */
  seenStreak: number;
  /** Consecutive cycles the fingerprint was absent. */
  missStreak: number;
  /** Opaque last-seen metadata (category, severity, detail…), carried through. */
  meta?: Record<string, unknown>;
}

export interface Finding {
  fingerprint: string;
  meta?: Record<string, unknown>;
}

export interface LedgerConfig {
  /** `pending → firing` after this many consecutive sightings (debounce). Default 2. */
  forCycles?: number;
  /** `resolving → resolved` after this many consecutive misses (debounce). Default 2. */
  resolveAfterCycles?: number;
}

export interface ReconcileResult {
  /** The next ledger (resolved entries are dropped — emitted once via `newlyResolved`). */
  entries: LedgerEntry[];
  /** Entries that crossed into `firing` this cycle — the "alert opens" edge. */
  newlyFiring: LedgerEntry[];
  /** Entries that crossed into `resolved` this cycle — the "alert closes" edge. */
  newlyResolved: LedgerEntry[];
}

const DEFAULT_FOR = 2;
const DEFAULT_RESOLVE_AFTER = 2;

/**
 * Advance the ledger by one cycle. `prior` = the persisted ledger; `current` =
 * every finding the producers emit THIS cycle. Level-triggered: identity is the
 * fingerprint; the full current set drives every transition.
 */
export function reconcile(
  prior: readonly LedgerEntry[],
  current: readonly Finding[],
  nowIso: string,
  cfg: LedgerConfig = {},
): ReconcileResult {
  const forCycles = Math.max(1, cfg.forCycles ?? DEFAULT_FOR);
  const resolveAfter = Math.max(1, cfg.resolveAfterCycles ?? DEFAULT_RESOLVE_AFTER);

  const priorByFp = new Map(prior.map((e) => [e.fingerprint, e]));
  // Last-writer-wins if a producer emits a fingerprint twice in one cycle.
  const currentByFp = new Map(current.map((f) => [f.fingerprint, f]));

  const next: LedgerEntry[] = [];
  const newlyFiring: LedgerEntry[] = [];
  const newlyResolved: LedgerEntry[] = [];

  // 1) Present fingerprints: advance toward firing.
  for (const [fp, finding] of currentByFp) {
    const prev = priorByFp.get(fp);
    if (!prev || prev.state === "resolved") {
      // New (or re-opened after a prior resolve).
      const seenStreak = 1;
      const state: FindingState = seenStreak >= forCycles ? "firing" : "pending";
      const entry: LedgerEntry = {
        fingerprint: fp,
        state,
        firstSeen: nowIso,
        lastSeen: nowIso,
        seenStreak,
        missStreak: 0,
        meta: finding.meta,
      };
      next.push(entry);
      if (state === "firing") newlyFiring.push(entry);
      continue;
    }
    const seenStreak = prev.seenStreak + 1;
    const wasOpen = prev.state === "firing";
    const state: FindingState = seenStreak >= forCycles ? "firing" : "pending";
    const entry: LedgerEntry = {
      ...prev,
      state,
      lastSeen: nowIso,
      seenStreak,
      missStreak: 0,
      meta: finding.meta ?? prev.meta,
    };
    next.push(entry);
    if (state === "firing" && !wasOpen) newlyFiring.push(entry); // pending→firing or resolving→firing (re-fire)
  }

  // 2) Absent fingerprints: advance toward resolved.
  for (const prev of prior) {
    if (currentByFp.has(prev.fingerprint) || prev.state === "resolved") continue;
    const missStreak = prev.missStreak + 1;
    if (missStreak >= resolveAfter) {
      newlyResolved.push({ ...prev, state: "resolved", missStreak, seenStreak: 0 });
      // dropped from `next` — emitted once, caller prunes.
      continue;
    }
    next.push({ ...prev, state: "resolving", missStreak, seenStreak: 0 });
  }

  return { entries: next, newlyFiring, newlyResolved };
}
