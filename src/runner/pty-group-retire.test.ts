import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PtyProcessOptions, spawnPty } from "./pty-process.js";
import { processStartMs } from "./pty-proc-identity.js";

/**
 * #570 r12 (A): retiring a PTY child stops its whole process group and proves it. These run a
 * real shell through the real PTY path (no claude), with a background child that survives the
 * hangup bun-pty's close() delivers, the way a daemonised helper or a git clone would.
 */

let dir: string;
const strays: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-group-"));
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  for (const start = Date.now(); !condition(); ) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Spawn `sh -c script` as an untrusted PTY child; the script writes `$!` of its background job to `bg`. */
async function spawnShell(script: string, extra: Partial<PtyProcessOptions> = {}) {
  const bgFile = join(dir, "bg.pid");
  const child = await spawnPty({
    sessionId: "",
    cwd: dir,
    isolation: "untrusted",
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", script.replaceAll("$BG", bgFile)],
    _skipReadySettle: true,
    ...extra,
  });
  await until(() => existsSync(bgFile) && readFileSync(bgFile, "utf8").trim() !== "");
  const bg = Number(readFileSync(bgFile, "utf8").trim());
  strays.push(bg, child.pid);
  return { child, bg };
}

// The shell itself dies of the hangup; the background job ignores it and outlives the closed PTY.
const HUP_PROOF_BG = "(trap '' HUP; exec sleep 60) & echo $! > $BG; sleep 60";

// A shell that exits at once, leaving a HUP-proof background child. The shell does not exit until
// the child has installed its trap and said so: the pid file is written at the fork, before the
// trap, and a hangup that arrives first (the shell is a session leader) kills the child, which
// flaked these tests about 1 run in 8.
const BG_THEN_EXIT =
  "(trap '' HUP; : > $BG.ready; exec sleep 60) & echo $! > $BG; while [ ! -e $BG.ready ]; do sleep 0.02; done";

describe("retiring a PTY child", () => {
  it("is the leader of its own process group (pgid equals pid)", async () => {
    const { child } = await spawnShell(HUP_PROOF_BG);
    try {
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)]).toString());
      expect(pgid).toBe(child.pid);
    } finally {
      await child.dispose();
    }
  });

  it("leaves neither the shell nor its background child alive, on SIGTERM and without waiting out the grace", async () => {
    const { child, bg } = await spawnShell(HUP_PROOF_BG, {
      _groupTermination: { termGraceMs: 4000, killGraceMs: 2000, pollMs: 20 },
    });
    expect(alive(child.pid)).toBe(true);
    expect(alive(bg)).toBe(true);
    const started = Date.now();
    await child.dispose();
    // Went red (the sleep still alive) with the group signal sent to the leader only, or the
    // wait for the group dropped.
    expect(alive(child.pid)).toBe(false);
    expect(alive(bg)).toBe(false);
    // Went red at ~4.4 s with the SIGTERM removed: SIGKILL, after the grace, was doing the work.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("twin: with the group kill off the background child survives (so the test above can fail)", async () => {
    const { child, bg } = await spawnShell(HUP_PROOF_BG, { terminateGroup: false });
    await child.dispose();
    // bun-pty's kill() returns before the hangup has been delivered, so the shell is still
    // dying here; it does go. The background child does not.
    await until(() => !alive(child.pid));
    expect(alive(bg)).toBe(true); // cleaned up in afterEach
  });

  it("escalates to SIGKILL for a group that ignores SIGTERM and SIGHUP", async () => {
    const { child, bg } = await spawnShell(
      "(trap '' HUP TERM; exec sleep 60) & echo $! > $BG; sleep 60",
      {
        _groupTermination: { termGraceMs: 300, killGraceMs: 3000, pollMs: 20 },
      },
    );
    const started = Date.now();
    await child.dispose();
    // Went red (the sleep still alive) with the SIGKILL escalation removed.
    expect(alive(bg)).toBe(false);
    expect(alive(child.pid)).toBe(false);
    // The SIGTERM grace was spent before SIGKILL went out.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("sweeps the descendants of a child that already exited on its own", async () => {
    const { child, bg } = await spawnShell(BG_THEN_EXIT);
    await until(() => !child.isAlive());
    expect(alive(bg)).toBe(true); // the leader is gone, its background child is not
    await child.dispose();
    expect(alive(bg)).toBe(false);
  });

  it("signals the group, not the bare pid, of a child that exited on its own with no start time recorded, during the dispose that follows", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sent: Array<[number, unknown]> = [];
      // The pid still answers `kill(pid, 0)` and its start time cannot be read: the one case in
      // which only the first-termination flag lets `-pid` go out. Nothing is really signalled.
      const kernel = (pid: number, name: unknown): void => {
        if (name !== 0) sent.push([pid, name]);
      };
      const { child } = await spawnShell("echo $$ > $BG", {
        _groupTermination: {
          leaderStartMs: null,
          startMs: () => null,
          signal: kernel as never,
          termGraceMs: 40,
          killGraceMs: 40,
          pollMs: 20,
          liveMembers: () => undefined,
        },
      });
      await until(() => !child.isAlive());
      await child.dispose();
      // Went red ([] sent) with `firstTermination` not passed by dispose.
      expect(sent).toEqual([
        [-child.pid, "SIGTERM"],
        [-child.pid, "SIGKILL"],
      ]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not signal the group of a child that exited long ago (its pid may be someone else's now)", async () => {
    let clock = 1_000_000;
    const { child, bg } = await spawnShell(BG_THEN_EXIT, {
      _now: () => clock,
    });
    await until(() => !child.isAlive());
    clock += 120_000;
    await child.dispose();
    // Went red (the sleep killed) with the age guard removed.
    expect(alive(bg)).toBe(true); // cleaned up in afterEach
  });

  it("still looks for descendants that left the group when the child exited long ago", async () => {
    let clock = 1_000_000;
    let scans = 0;
    const { child } = await spawnShell(BG_THEN_EXIT, {
      _now: () => clock,
      reapEscapees: async () => {
        scans++;
        return [];
      },
    });
    await until(() => !child.isAlive());
    clock += 120_000; // past the window that guards the bare-pid signal
    await child.dispose();
    // Went red (0 scans) with the scan tied to the 30 s window again.
    expect(scans).toBe(1);
  });

  it("reports the pid when the group cannot be made to disappear, and does not claim success", async () => {
    const survived: number[] = [];
    // A kernel that always answers "still there" and ignores every signal.
    const stubborn = (_pid: number, _signal: unknown): void => {};
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => survived.push(pid),
      _groupTermination: {
        signal: stubborn as never,
        termGraceMs: 60,
        killGraceMs: 60,
        pollMs: 20,
        liveMembers: () => undefined,
      },
    });
    await child.dispose();
    // Went red ([] received) with the report to onGroupSurvived removed.
    expect(survived).toEqual([child.pid]);
  });

  it("calls no survivor hook when the group is gone", async () => {
    const survived: number[] = [];
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => survived.push(pid),
    });
    await child.dispose();
    expect(survived).toEqual([]);
  });
});

// #570 r13 (A, B, C): what retirement does with the recorded identity, a failing hook and the scan.
describe("retirement and the recorded identity", () => {
  it("signals nothing through the group path when the pid's start time is not the one recorded at spawn", async () => {
    const sent: Array<[number, unknown]> = [];
    const recorder = (pid: number, name: unknown): void => {
      if (name !== 0) sent.push([pid, name]);
      else process.kill(pid, 0);
    };
    const { child, bg } = await spawnShell(HUP_PROOF_BG, {
      _groupTermination: {
        signal: recorder as never,
        startMs: () => 1, // the pid "now" belongs to a process that started in 1970
        termGraceMs: 200,
        killGraceMs: 200,
        pollMs: 20,
      },
    });
    await child.dispose();
    expect(sent).toEqual([]);
    expect(alive(bg)).toBe(true); // nothing signalled it; cleaned up in afterEach
  });

  it("hands the survivor hook the start time recorded at spawn", async () => {
    const seen: Array<[number, number | null]> = [];
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid, startMs) => seen.push([pid, startMs]),
      _groupTermination: {
        signal: ((_pid: number, _name: unknown): void => {}) as never,
        termGraceMs: 60,
        killGraceMs: 60,
        pollMs: 20,
        liveMembers: () => undefined,
      },
    });
    const readNow = processStartMs(child.pid); // the same reader, while the child is alive
    await child.dispose();
    expect(seen.length).toBe(1);
    const [pid, startMs] = seen[0] as [number, number | null];
    expect(pid).toBe(child.pid);
    expect(startMs).not.toBeNull();
    expect(startMs).toBe(readNow);
  });

  it("fails closed when the survivor hook throws: it is logged and dispose rejects", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { child } = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: () => {
          throw new Error("could not record");
        },
        _groupTermination: {
          signal: ((_pid: number, _name: unknown): void => {}) as never,
          termGraceMs: 60,
          killGraceMs: 60,
          pollMs: 20,
          liveMembers: () => undefined,
        },
      });
      await expect(child.dispose()).rejects.toThrow(/survivor hook failed/);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(logged).toContain("survivor hook threw");
    } finally {
      error.mockRestore();
    }
  });

  it("reports a process outside the group that the scan could not stop, and a scan that threw", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reported: number[] = [];
      const left = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: (pid) => reported.push(pid),
        reapEscapees: async () => [7777],
      });
      await left.child.dispose();
      expect(reported).toEqual([left.child.pid]);

      reported.length = 0;
      const threw = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: (pid) => reported.push(pid),
        reapEscapees: async () => {
          throw new Error("scan failed");
        },
      });
      await threw.child.dispose();
      expect(reported).toEqual([threw.child.pid]);
    } finally {
      error.mockRestore();
    }
  });

  it("names the cause to the survivor hook: group, escapee, or a scan that could not tell", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const causes: string[] = [];
      const hook = (_pid: number, _start: number | null, cause: string): void => {
        causes.push(cause);
      };
      const stubborn = {
        signal: ((_pid: number, _name: unknown): void => {}) as never,
        termGraceMs: 60,
        killGraceMs: 60,
        pollMs: 20,
        liveMembers: () => undefined,
      };
      const group = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: hook,
        _groupTermination: stubborn,
      });
      await group.child.dispose();
      const escapee = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: hook,
        reapEscapees: async () => [7777],
      });
      await escapee.child.dispose();
      const unknown = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: hook,
        reapEscapees: async () => {
          throw new Error("could not read /proc");
        },
      });
      await unknown.child.dispose();
      // Went red with the escapee cause no longer set.
      expect(causes).toEqual(["group", "escapee", "scan-unknown"]);
    } finally {
      error.mockRestore();
    }
  });

  it("calls no survivor hook when the group is gone and the scan finds nothing", async () => {
    const reported: number[] = [];
    let scans = 0;
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => reported.push(pid),
      reapEscapees: async () => {
        scans++;
        return [];
      },
    });
    await child.dispose();
    expect(scans).toBe(1);
    expect(reported).toEqual([]);
  });
});
