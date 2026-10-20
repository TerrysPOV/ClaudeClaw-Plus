import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBootId } from "../runner/pty-proc-identity.js";
import {
  ONESHOT_CONFIG_PREFIX,
  ONESHOT_SURVIVOR_FILE,
  ONESHOT_SWEEP_MAX_AGE_MS,
  UNTRUSTED_ONESHOT_MAX_CONCURRENT,
  acquireUntrustedOneShotSlot,
  lateSlotCeilingMsForTests,
  markGroupSurvivor,
  markUnknownProcs,
  resetGroupSurvivorsForTests,
  resetUntrustedSlotsForTests,
  retrySurvivingGroups,
  setHeldAliveForTests,
  setLateSlotCeilingMsForTests,
  sweepStaleOneShotDirs,
  unknownHoldCount,
  untrustedOneShotsInFlight,
} from "./pty-cleanup.js";

/**
 * #570 r15e/r15f: a concurrency slot is held while a process of its call may still be alive (a
 * recorded survivor or an unknown hold alike), and is freed only on positive evidence that it is
 * gone. Pure: no PTY, no real signal. The worst case
 * in every test EXCEEDS the cap (three or more callers against two slots).
 */

const CAP = UNTRUSTED_ONESHOT_MAX_CONCURRENT;
const CEILING_MS = 5;
/** Held (unreadable) pids a test has declared exited. */
const exited = new Set<number>();
const PAST_CEILING_MS = CEILING_MS * 10;
let savedCeiling: number;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  savedCeiling = lateSlotCeilingMsForTests();
  setLateSlotCeilingMsForTests(CEILING_MS);
  exited.clear();
  setHeldAliveForTests((proc) => !exited.has(proc.pid)); // no real pid is probed
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setLateSlotCeilingMsForTests(savedCeiling);
  setHeldAliveForTests(null);
  warn.mockRestore();
  resetGroupSurvivorsForTests();
  resetUntrustedSlotsForTests();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const CEILING_LINE = "[pty-supervisor] one-shot slot held past ceiling: retirement pending";
const ceilingLines = (): number =>
  warn.mock.calls.filter((call: unknown[]) => String(call[0]) === CEILING_LINE).length;

/** Take `n` slots; every one must be granted. */
function take(n: number) {
  return Array.from({ length: n }, () => {
    const slot = acquireUntrustedOneShotSlot();
    if (!slot) throw new Error("slot refused");
    return slot;
  });
}

/** Ask for `n` more and release whatever was granted; returns how many were granted. */
function granted(n: number): number {
  const got = Array.from({ length: n }, () => acquireUntrustedOneShotSlot()).filter(
    (s) => s !== undefined,
  );
  for (const s of got) s.free();
  return got.length;
}

/**
 * The sweeper's identity-checked retry, with the groups named in `gone` confirmed gone and the
 * held (unreadable) processes named in `heldGone` confirmed exited.
 */
const retry = (gone: number[], heldGone: number[] = []): Promise<number> => {
  for (const pid of heldGone) exited.add(pid);
  return retrySurvivingGroups({
    terminate: async (pid) => gone.includes(pid),
    reap: async () => [],
  });
};

/** A process the escape scan could not read. */
const unreadable = (pid: number) => ({
  pid,
  startMs: 9,
  envErrno: "EACCES",
  cwdErrno: "EACCES",
  descendant: true,
  ageMs: 5,
});
const LEADER = { pid: 1, startMs: 1 };

describe("a survivor keeps the slot of the call that left it", () => {
  it("holds both slots with two survivors, refuses the 3rd and 4th, and hands one back when one is confirmed gone", async () => {
    const [a, b] = take(CAP);
    markGroupSurvivor("/root/a", 101, { startMs: 1 });
    markGroupSurvivor("/root/b", 102, { startMs: 1 });
    a!.settle("/root/a");
    b!.settle("/root/b");

    // Went red (3rd and 4th granted) with the unconditional `free()` restored in `settle`.
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(untrustedOneShotsInFlight()).toBe(CAP);

    expect(await retry([101])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(granted(CAP + 1)).toBe(1); // one free, and the other still held by the second survivor
    expect(await retry([102])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(0);
    expect(granted(CAP + 1)).toBe(CAP);
  });

  it("a survivor that is still alive after a retry keeps its slot", async () => {
    const [a] = take(1);
    markGroupSurvivor("/root/a", 101, { startMs: 1 });
    a!.settle("/root/a");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await retry([])).toBe(0);
    } finally {
      error.mockRestore();
    }
    expect(untrustedOneShotsInFlight()).toBe(1);
  });

  it("a call with no survivor frees its slot at once", () => {
    const [a, b] = take(CAP);
    a!.settle("/root/clean");
    b!.settle("/root/clean-too");
    expect(untrustedOneShotsInFlight()).toBe(0);
  });

  it("a survivor confirmed gone before the call settles does not hold the slot", async () => {
    const [a] = take(1);
    markGroupSurvivor("/root/a", 101, { startMs: 1 });
    expect(await retry([101])).toBe(1);
    a!.settle("/root/a");
    expect(untrustedOneShotsInFlight()).toBe(0);
  });
});

describe("the ceiling does not free a slot whose retirement is pending", () => {
  it("keeps two late retirements counted past the ceiling, logs once each, and frees one when it settles", async () => {
    const [a, b] = take(CAP);
    let retireA!: () => void;
    const lateA = new Promise<void>((resolve) => {
      retireA = resolve;
    });
    const lateB = new Promise<void>(() => {}); // never settles
    a!.settle("/root/a", lateA);
    b!.settle("/root/b", lateB);

    await sleep(PAST_CEILING_MS);

    // Went red (3rd and 4th granted) with `setTimeout(free, …)` restored at the ceiling.
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(untrustedOneShotsInFlight()).toBe(CAP);
    expect(ceilingLines()).toBe(CAP); // one fixed line per held slot, nothing else

    retireA();
    await flush();
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(granted(CAP + 1)).toBe(1);
  });

  it("a retirement that rejects frees its slot too: a held slot is never a wedge without a reason", async () => {
    const [a, b] = take(CAP);
    a!.settle("/root/a", Promise.reject(new Error("retire failed")));
    b!.settle("/root/b", Promise.resolve());
    await flush();
    expect(untrustedOneShotsInFlight()).toBe(0);
    expect(granted(CAP + 1)).toBe(CAP);
  });

  it("a late retirement that left a survivor hands its slot to the survivor, not back to the pool", async () => {
    const [a] = take(1);
    let retire!: () => void;
    const late = new Promise<void>((resolve) => {
      retire = resolve;
    });
    a!.settle("/root/a", late);
    markGroupSurvivor("/root/a", 101, { startMs: 1 }); // recorded while the retirement ran
    retire();
    await flush();
    expect(untrustedOneShotsInFlight()).toBe(1);
    expect(await retry([101])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(0);
  });
});

describe("a reservation is freed once and only once", () => {
  it("a survivor confirmed gone plus a late settle and a stray free on the same call free it once", async () => {
    const [a] = take(1);
    markGroupSurvivor("/root/a", 101, { startMs: 1 });
    a!.settle("/root/a");
    expect(await retry([101])).toBe(1);
    a!.free(); // the late settle
    a!.settle("/root/a", Promise.resolve());
    await flush();

    // Went red (in flight -2, not 0) with the `held` guard removed.
    expect(untrustedOneShotsInFlight()).toBe(0);
    const got = Array.from({ length: CAP + 1 }, () => acquireUntrustedOneShotSlot());
    expect(got.filter((s) => s !== undefined)).toHaveLength(CAP);
  });

  it("two calls on one root cannot both leave a reservation behind", async () => {
    const [a, b] = take(CAP);
    markGroupSurvivor("/root/shared", 101, { startMs: 1 });
    a!.settle("/root/shared");
    b!.settle("/root/shared");
    expect(untrustedOneShotsInFlight()).toBe(1); // the second was redundant: one root, one hold
    expect(await retry([101])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(0);
  });
});

describe("survivors adopted from survivor.json after a restart count against the cap", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "slot-adopt-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A config root a previous daemon run left with a recorded survivor. */
  function persisted(name: string, pid: number): string {
    const path = join(base, `${ONESHOT_CONFIG_PREFIX}${name}`);
    mkdirSync(path);
    writeFileSync(
      join(path, ONESHOT_SURVIVOR_FILE),
      JSON.stringify({ pid, startMs: 7, bootId: currentBootId(), cwds: [] }),
    );
    const old = (Date.now() - ONESHOT_SWEEP_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    return path;
  }
  const adopt = (): number =>
    sweepStaleOneShotDirs(base, Date.now(), ONESHOT_SWEEP_MAX_AGE_MS, {
      groupGone: () => false, // alive
      scan: () => ({ pids: [], unknown: [] }),
      anotherBoot: () => false,
    });

  it("three adopted survivors hold the pool until enough are confirmed gone", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      persisted("one", 201);
      persisted("two", 202);
      persisted("three", 203);
      expect(adopt()).toBe(0);

      // Went red (0 counted, not 3) with the reservation skipped on adopt.
      expect(untrustedOneShotsInFlight()).toBe(3);
      expect(acquireUntrustedOneShotSlot()).toBeUndefined();

      expect(await retry([201])).toBe(1); // 2 left: still at the cap
      expect(acquireUntrustedOneShotSlot()).toBeUndefined();
      expect(await retry([202])).toBe(1); // 1 left: one slot is free
      expect(granted(CAP + 1)).toBe(1);
      expect(await retry([203])).toBe(1);
      expect(untrustedOneShotsInFlight()).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  it("adopting the same root on a later pass does not reserve a second time", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      persisted("one", 201);
      adopt();
      adopt();
      expect(untrustedOneShotsInFlight()).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe("an unknown hold keeps the slot as a survivor does (r15f)", () => {
  it("a survivor retry that finds the group gone but records an unknown hold keeps the slot, then frees it once", async () => {
    const [a, b] = take(CAP);
    markGroupSurvivor("/root/a", 101, { startMs: 1 });
    markGroupSurvivor("/root/b", 102, { startMs: 1 });
    a!.settle("/root/a");
    b!.settle("/root/b");

    // The real reap records what it could not read and leaves it out of the escapees it returns.
    const error = spyOn(console, "error").mockImplementation(() => {});
    let cleared: number;
    try {
      cleared = await retrySurvivingGroups({
        terminate: async (pid) => pid === 101,
        reap: async (target) => {
          if (target.root === "/root/a") markUnknownProcs("/root/a", LEADER, [unreadable(301)]);
          return [];
        },
      });
    } finally {
      error.mockRestore();
    }

    // Went red (CAP - 1 counted, 3rd granted) with the unconditional `releaseSurvivorSlot` restored at the retry.
    expect(cleared).toBe(1);
    expect(unknownHoldCount()).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(CAP);
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();

    expect(await retry([], [301])).toBe(0); // the hold's process is confirmed gone
    expect(unknownHoldCount()).toBe(0);
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(await retry([], [301])).toBe(0); // and a second pass does not release it again
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(granted(CAP + 1)).toBe(1); // b's survivor still holds the other
  });

  it("a call whose cleanup leaves an unknown hold keeps its slot, and frees it when the process is gone", async () => {
    const [a, b] = take(CAP);
    markUnknownProcs("/root/a", LEADER, [unreadable(301)]);
    markUnknownProcs("/root/b", LEADER, [unreadable(302)]);
    a!.settle("/root/a");
    b!.settle("/root/b");

    // Went red (both slots freed, 3rd and 4th granted) with `handOver` reverted to survivor-only.
    expect(untrustedOneShotsInFlight()).toBe(CAP);
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();

    await retry([], [301]);
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(granted(CAP + 1)).toBe(1);
    await retry([], [301, 302]);
    expect(untrustedOneShotsInFlight()).toBe(0);
  });

  it("a hold whose processes are already gone when the call settles does not hold the slot", () => {
    const [a] = take(1);
    markUnknownProcs("/root/a", LEADER, [unreadable(301)]);
    exited.add(301);
    a!.settle("/root/a");
    expect(untrustedOneShotsInFlight()).toBe(0);
  });

  it("a late retirement that leaves an unknown hold hands its slot to the hold", async () => {
    const [a] = take(1);
    let retire!: () => void;
    const late = new Promise<void>((resolve) => {
      retire = resolve;
    });
    a!.settle("/root/a", late);
    markUnknownProcs("/root/a", LEADER, [unreadable(301)]); // recorded while the retirement ran
    retire();
    await flush();
    expect(untrustedOneShotsInFlight()).toBe(1);
    await retry([], [301]);
    expect(untrustedOneShotsInFlight()).toBe(0);
  });

  it("a root with a survivor and an unknown hold keeps the slot until both are clear, then frees it once", async () => {
    const [a, b] = take(CAP);
    for (const [root, pid, held] of [
      ["/root/a", 101, 301],
      ["/root/b", 102, 302],
    ] as const) {
      markGroupSurvivor(root, pid, { startMs: 1 });
      markUnknownProcs(root, LEADER, [unreadable(held)]);
    }
    a!.settle("/root/a");
    b!.settle("/root/b");
    expect(untrustedOneShotsInFlight()).toBe(CAP);

    // Root a: the survivor first. Went red (CAP - 1) with the retry's release unconditional.
    expect(await retry([101])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(CAP);
    expect(acquireUntrustedOneShotSlot()).toBeUndefined();
    await retry([], [301]); // then its hold
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);

    // Root b: the hold first. Went red (CAP - 2) with the hold pruning's release unconditional.
    await retry([], [302]);
    expect(untrustedOneShotsInFlight()).toBe(CAP - 1);
    expect(granted(CAP + 1)).toBe(1);
    expect(await retry([102])).toBe(1);
    expect(untrustedOneShotsInFlight()).toBe(0);
    expect(granted(CAP + 1)).toBe(CAP);
  });
});

describe("unknown holds adopted from survivor.json after a restart count against the cap (r15f)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "slot-adopt-hold-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A config root a previous run left with only unreadable processes recorded: its group is gone. */
  function persistedHold(name: string, held: number): string {
    const path = join(base, `${ONESHOT_CONFIG_PREFIX}${name}`);
    mkdirSync(path);
    writeFileSync(
      join(path, ONESHOT_SURVIVOR_FILE),
      JSON.stringify({
        pid: 5,
        startMs: 7,
        bootId: currentBootId(),
        cwds: [],
        unknown: [{ pid: held, startMs: 9 }],
      }),
    );
    const old = (Date.now() - ONESHOT_SWEEP_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    return path;
  }
  const adopt = (): number =>
    sweepStaleOneShotDirs(base, Date.now(), ONESHOT_SWEEP_MAX_AGE_MS, {
      groupGone: () => true,
      scan: () => ({ pids: [], unknown: [] }),
      anotherBoot: () => false,
    });

  it("three adopted holds hold the pool until enough of their processes are gone", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      persistedHold("one", 401);
      persistedHold("two", 402);
      persistedHold("three", 403);
      expect(adopt()).toBe(0);

      // Went red (0 counted, not 3) with the reservation skipped when a hold is adopted.
      expect(untrustedOneShotsInFlight()).toBe(3);
      expect(acquireUntrustedOneShotSlot()).toBeUndefined();

      adopt(); // adopting again reserves nothing more
      expect(untrustedOneShotsInFlight()).toBe(3);

      await retry([], [401]);
      expect(untrustedOneShotsInFlight()).toBe(2);
      await retry([], [401, 402]);
      expect(granted(CAP + 1)).toBe(1);
      await retry([], [401, 402, 403]);
      expect(untrustedOneShotsInFlight()).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
