import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSignalablePid,
  procLiveMembers,
  processGroupGone,
  terminateProcessGroup,
  type SignalFn,
} from "./pty-group-kill.js";
import { withPlatformAsync } from "./pty-test-platform.js";

/** #570 r12 (A): a retired PTY child must be proven gone, with its group. */

const PID = 424242;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** A process table: the group dies on the given signal (or never). */
function fakeKernel(diesOn: NodeJS.Signals | null, { visible = true } = {}) {
  const calls: Array<[number, NodeJS.Signals | 0]> = [];
  let alive = true;
  const signal: SignalFn = (target, name) => {
    calls.push([target, name]);
    if (name === 0) {
      if (!alive || !visible) throw errno("ESRCH");
      return;
    }
    if (name === diesOn) alive = false;
  };
  return { signal, calls };
}

/** The leader is ours: the PTY still owns it, and its start time is the one recorded at spawn. */
const START = 1_700_000_000_000;
const ours = { leaderStartMs: START, startMs: () => START, leaderAlive: () => true };
const instant = { sleep: async () => {}, liveMembers: () => undefined, pollMs: 100, ...ours };

describe("terminateProcessGroup", () => {
  it("SIGTERMs the group once, not the bare pid as well, and is done once both answer ESRCH", async () => {
    const k = fakeKernel("SIGTERM");
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(true);
    // The leader is a member of its own group: a second signal to the bare pid adds nothing and
    // is one more chance to hit a reused pid (#570 r14, B).
    expect(k.calls.filter(([, n]) => n === "SIGTERM")).toEqual([[-PID, "SIGTERM"]]);
    expect(k.calls.some(([, n]) => n === "SIGKILL")).toBe(false);
  });

  it("escalates to SIGKILL when the group outlives SIGTERM", async () => {
    const k = fakeKernel("SIGKILL");
    // Went red (false, then no SIGKILL calls) with the escalation removed.
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(true);
    expect(k.calls.filter(([, n]) => n === "SIGKILL")).toEqual([[-PID, "SIGKILL"]]);
  });

  it("reports failure, never success, when the group survives SIGKILL", async () => {
    const k = fakeKernel(null);
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(false);
  });

  it("does not take the leader's disappearance for the group's", async () => {
    // kill(pid, 0) says ESRCH (leader reaped) but the group still has a member.
    const signal: SignalFn = (target, name) => {
      if (name === 0 && target === PID) throw errno("ESRCH");
    };
    // Went red (true) with only the leader checked.
    expect(await terminateProcessGroup(PID, { signal, ...instant })).toBe(false);
  });

  it("reads EPERM as alive, not gone", async () => {
    const signal: SignalFn = (_target, name) => {
      if (name === 0) throw errno("EPERM");
    };
    // Went red (true) with every error read as "gone".
    expect(await terminateProcessGroup(PID, { signal, ...instant })).toBe(false);
  });

  it("counts an unreaped zombie as gone where /proc can tell, and not otherwise", () => {
    const zombie: SignalFn = () => {}; // kill(.., 0) succeeds for a zombie
    // Went red (false) with the /proc answer ignored.
    expect(processGroupGone(PID, zombie, () => 0)).toBe(true);
    expect(processGroupGone(PID, zombie, () => 1)).toBe(false);
    expect(processGroupGone(PID, zombie, () => undefined)).toBe(false);
  });

  describe("pid identity (#570 r13, B)", () => {
    const signalled = (calls: Array<[number, NodeJS.Signals | 0]>) =>
      calls.filter(([, name]) => name !== 0);

    it("signals nothing when the pid now has a different start time", async () => {
      const k = fakeKernel("SIGKILL");
      // Went red with the start-time check removed from `send` (signals went to the stranger),
      // and with the poll not noticing the reuse (false, the call waited out and failed).
      const reused = { ...instant, startMs: () => START + 3_600_000 };
      expect(await terminateProcessGroup(PID, { signal: k.signal, ...reused })).toBe(true);
      expect(signalled(k.calls)).toEqual([]);
    });

    it("checks again before the SIGKILL: a pid reused after the SIGTERM is not killed", async () => {
      const k = fakeKernel(null);
      let reads = 0;
      // The first readings (before SIGTERM) are ours; every later one is a stranger's.
      const startMs = () => (reads++ < 2 ? START : START + 3_600_000);
      // A short SIGTERM grace, so the escalation is reached before any poll can notice the reuse.
      const result = await terminateProcessGroup(PID, {
        signal: k.signal,
        ...instant,
        startMs,
        termGraceMs: 100,
      });
      // Went red (a SIGKILL among the signals) when the escalation reused the identity read
      // before the SIGTERM instead of reading it again.
      expect(signalled(k.calls).every(([, name]) => name === "SIGTERM")).toBe(true);
      // Went red (2 signals) with the bare pid signalled after the group, and (a SIGKILL among
      // them) with the identity cached instead of read again.
      expect(signalled(k.calls).length).toBe(1);
      expect(result).toBe(true); // a reused pid means the group we started is gone
    });

    it("signals only the group, never the bare pid, once the child has exited", async () => {
      const k = fakeKernel("SIGKILL");
      const exited = { ...instant, leaderAlive: () => false };
      await terminateProcessGroup(PID, { signal: k.signal, ...exited });
      // Went red ([PID, ...] among the signals) with the ownership check removed.
      expect(signalled(k.calls).length).toBeGreaterThan(0);
      expect(signalled(k.calls).every(([target]) => target === -PID)).toBe(true);
    });

    it("signals nothing when the leader is gone and the group has no member either", async () => {
      const k = fakeKernel("SIGKILL", { visible: false });
      // Went red with the identity check removed, and with the bare pid signalled after "gone".
      expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(true);
      expect(signalled(k.calls)).toEqual([]);
    });

    it("signals the group of a pid whose start time was never recorded, during the first termination, while it has a member, never the bare pid, and says so once", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const k = fakeKernel("SIGKILL");
        const unrecorded = {
          ...instant,
          leaderStartMs: null,
          leaderAlive: () => false,
          firstTermination: true,
        };
        // The leader was spawned moments ago, so a group with a member is ours. Went red (false,
        // nothing sent) with the group refused for an unrecorded start time.
        expect(await terminateProcessGroup(PID, { signal: k.signal, ...unrecorded })).toBe(true);
        expect(signalled(k.calls).length).toBeGreaterThan(0);
        expect(signalled(k.calls).every(([target]) => target === -PID)).toBe(true);
        const logged = warn.mock.calls.filter((call: unknown[]) =>
          String(call[0]).includes("start time"),
        );
        // Went red (2 lines) with the once-only flag removed.
        expect(logged.length).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("signals nothing for an unrecorded start time on a later retry, however live the group, and logs nothing", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const k = fakeKernel("SIGKILL");
        const retry = { ...instant, leaderStartMs: null, leaderAlive: () => false };
        // Group membership no longer proves the group is ours minutes later. Went red (signals
        // sent to -PID, and true) with the first-termination check dropped from sendGroup.
        expect(await terminateProcessGroup(PID, { signal: k.signal, ...retry })).toBe(false);
        expect(signalled(k.calls)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    /** The leader pid is absent; the group `-PID` has a member. Every non-zero signal is recorded. */
    const leaderGoneGroupLive = () => {
      const calls: Array<[number, NodeJS.Signals | 0]> = [];
      const signal: SignalFn = (target, name) => {
        calls.push([target, name]);
        if (name === 0 && target === PID) throw errno("ESRCH");
      };
      return { signal, calls };
    };

    it("signals nothing for a leader that is absent when its start time was never recorded, on a later retry, however live the group (r14e, H2)", async () => {
      const k = leaderGoneGroupLive();
      const retry = { ...instant, leaderStartMs: null, leaderAlive: () => false };
      // A live `-PID` beside an absent leader may be someone else's group. Went red (signals sent
      // to -PID) with `gone` accepted on its own again.
      expect(await terminateProcessGroup(PID, { signal: k.signal, ...retry })).toBe(false);
      expect(signalled(k.calls)).toEqual([]);
    });

    it("still signals the group of an absent leader during the first termination, and when the start time was recorded", async () => {
      const first = leaderGoneGroupLive();
      const unrecorded = {
        ...instant,
        leaderStartMs: null,
        leaderAlive: () => false,
        firstTermination: true,
      };
      await terminateProcessGroup(PID, { signal: first.signal, ...unrecorded });
      // Went red (nothing sent) with the first-termination case dropped from the `gone` rule.
      expect(signalled(first.calls).length).toBeGreaterThan(0);
      expect(signalled(first.calls).every(([target]) => target === -PID)).toBe(true);

      const recorded = leaderGoneGroupLive();
      await terminateProcessGroup(PID, { signal: recorded.signal, ...instant });
      // Went red (nothing sent) with the recorded-start case dropped from the `gone` rule.
      expect(signalled(recorded.calls).length).toBeGreaterThan(0);
      expect(signalled(recorded.calls).every(([target]) => target === -PID)).toBe(true);
    });

    it("on Linux a start time one tick off is another process: nothing is signalled (r14e, H1)", async () => {
      const k = fakeKernel("SIGKILL");
      // Recorded 10000, now 10010: the next tick, so a recycled pid. Went red (signals sent to
      // -PID) with `<= 10` put back in sameStart.
      const next = { ...instant, leaderStartMs: 10_000, startMs: () => 10_010 };
      const result = await withPlatformAsync("linux", () =>
        terminateProcessGroup(PID, { signal: k.signal, ...next }),
      );
      expect(signalled(k.calls)).toEqual([]);
      expect(result).toBe(true); // a recycled leader means the group we started is gone
    });

    it("signals nothing for an unrecorded start time when the group has no member (the bare pid may be a stranger)", async () => {
      const calls: Array<[number, NodeJS.Signals | 0]> = [];
      // The leader's pid answers (someone holds it now); the group does not exist.
      const signal: SignalFn = (target, name) => {
        calls.push([target, name]);
        if (target < 0) throw errno("ESRCH");
      };
      const unrecorded = {
        ...instant,
        leaderStartMs: null,
        leaderAlive: () => false,
        firstTermination: true,
      };
      expect(await terminateProcessGroup(PID, { signal, ...unrecorded })).toBe(false);
      expect(signalled(calls)).toEqual([]);
    });
  });

  it("never signals a pid that could reach init, itself, or every process", async () => {
    for (const pid of [0, 1, -1, -PID, Number.NaN, 1.5, process.pid]) {
      const k = fakeKernel("SIGTERM");
      // Went red (true) with the pid guard removed.
      expect(isSignalablePid(pid)).toBe(false);
      expect(await terminateProcessGroup(pid, { signal: k.signal, ...instant })).toBe(false);
      expect(k.calls).toEqual([]);
    }
  });
});

describe("procLiveMembers", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const entry = (pid: number, comm: string, state: string, pgrp: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(
      join(proc, String(pid), "stat"),
      `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0\n`,
    );
  };

  it("counts live members of the group, not zombies or other groups", () => {
    entry(PID, "sh", "Z", PID); // the leader, dead and unreaped
    entry(PID + 1, "sleep", "S", PID); // a live member
    entry(PID + 2, "other", "S", 777); // another group
    mkdirSync(join(proc, "self")); // not a pid
    expect(procLiveMembers(PID, proc)).toBe(1);
  });

  it("parses a command name that contains spaces and parentheses", () => {
    entry(PID + 1, "a) S 1 1 (b", "S", PID);
    expect(procLiveMembers(PID, proc)).toBe(1);
  });

  it("is zero when only zombies are left", () => {
    entry(PID, "sh", "Z", PID);
    expect(procLiveMembers(PID, proc)).toBe(0);
  });

  it("is unknown, not zero, when no member can be seen at all", () => {
    entry(PID + 2, "other", "S", 777);
    // Went red (0) with zero allowed without a zombie having been seen.
    expect(procLiveMembers(PID, proc)).toBeUndefined();
  });

  // #570 r13, D: an entry whose stat cannot be read may be a live member.
  it("counts an unreadable entry as unknown, so a zombie beside it does not make the group gone", () => {
    entry(PID, "sh", "Z", PID);
    mkdirSync(join(proc, String(PID + 1)));
    mkdirSync(join(proc, String(PID + 1), "stat")); // reading a directory fails with EISDIR
    // Went red (0, "gone") with a failed read skipped, as before r13.
    expect(procLiveMembers(PID, proc)).toBeUndefined();
  });

  it("still counts a live member it can see when another entry is unreadable", () => {
    entry(PID + 1, "sleep", "S", PID);
    mkdirSync(join(proc, String(PID + 2)));
    mkdirSync(join(proc, String(PID + 2), "stat"));
    expect(procLiveMembers(PID, proc)).toBe(1);
  });

  it("does not take X (dead) state for alive", () => {
    entry(PID, "sh", "X", PID);
    expect(procLiveMembers(PID, proc)).toBe(0);
  });
});
