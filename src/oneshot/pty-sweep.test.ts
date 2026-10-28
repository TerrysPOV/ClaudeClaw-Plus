import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EscapeScan } from "../runner/pty-escape-scan.js";
import { retireProcessGroup } from "../runner/pty-group-kill.js";
import { retireFake, retireOutcome } from "../runner/pty-retire-fakes.js";
import { currentBootId, recordedOnAnotherBoot } from "../runner/pty-proc-identity.js";
import { withPlatform } from "../runner/pty-test-platform.js";
import {
  DAEMON_INSTANCE,
  ONESHOT_CONFIG_PREFIX,
  ONESHOT_CWD_PREFIX,
  ONESHOT_OWNER_FILE,
  ONESHOT_QUARANTINE_MAX_AGE_MS,
  ONESHOT_SURVIVOR_FILE,
  ONESHOT_SWEEP_INTERVAL_MS,
  ONESHOT_SWEEP_MAX_AGE_MS,
  type OwnerRecord,
  unknownHoldCount,
  createUntrustedConfigRoot,
  createUntrustedTempCwd,
  groupSurvivorCount,
  groupSurvivorOf,
  heldProcAlive,
  isOwnerDead,
  markGroupSurvivor,
  markUnknownProcs,
  markOneShotDirActive,
  operatorSecureStorageDir,
  processStartMs,
  readOwnerFile,
  releaseOneShotDir,
  resetGroupSurvivorsForTests,
  resetOneShotSweeperForTests,
  retrySurvivingGroups,
  startOneShotSweeper,
  sweepStaleOneShotDirs,
} from "./pty-cleanup.js";

/**
 * #570 r12 (B): the sweep never removes a live call's directories; (F2): secure-storage resolution.
 *
 * Each assertion below went red under its own one-site fault (see the r12 section of the #570
 * report): owner check removed or inverted, ESRCH and reused-pid reads, unknown start time, the
 * uid, age and active-call guards, the fallback for a missing owner file, the timer's
 * registration, unref, interval and error handling, the two owner-file writes, and each
 * daemon-env fallback.
 */

const NOW = Date.now();
const OLD = (NOW - ONESHOT_SWEEP_MAX_AGE_MS - 60_000) / 1000;
const YOUNG = (NOW - 60_000) / 1000;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sweep-test-"));
});
afterEach(() => {
  resetOneShotSweeperForTests();
  resetGroupSurvivorsForTests();
  rmSync(base, { recursive: true, force: true });
});

function leftover(name: string, mtime: number, owner?: OwnerRecord | "garbage"): string {
  const path = join(base, name);
  mkdirSync(path);
  writeFileSync(join(path, "prompt.jsonl"), "PROMPT_TEXT");
  if (owner === "garbage") writeFileSync(join(path, ONESHOT_OWNER_FILE), "{not json");
  else if (owner) writeFileSync(join(path, ONESHOT_OWNER_FILE), JSON.stringify(owner));
  utimesSync(path, mtime, mtime);
  return path;
}

const sweep = (deps: Parameters<typeof sweepStaleOneShotDirs>[3] = {}): number =>
  sweepStaleOneShotDirs(base, NOW, ONESHOT_SWEEP_MAX_AGE_MS, deps);

/** A pid that existed and is gone. */
function deadPid(): number {
  const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(child.stdout.trim());
}

const selfStart = processStartMs(process.pid);
// Stamped with this boot's id, as the writer does: on Linux a record with none is another boot's
// and is swept before its pid is looked at (#570 r15b).
const live = (over: Partial<OwnerRecord> = {}): OwnerRecord => ({
  pid: process.pid,
  startMs: selfStart,
  bootId: currentBootId(),
  instance: "another-daemon",
  ...over,
});

describe("sweepStaleOneShotDirs: who may be removed", () => {
  it("keeps an old directory whose owner is still running", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}live`, OLD, live());
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("removes an old directory whose owner is dead", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}dead`, OLD, live({ pid: deadPid() }));
    expect(sweep()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("removes one whose pid now belongs to a process that started later", () => {
    const path = leftover(
      `${ONESHOT_CWD_PREFIX}reused`,
      OLD,
      live({ startMs: NOW - 90 * 86_400_000 }),
    );
    expect(sweep()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps one when the owner's start time cannot be compared", () => {
    const path = leftover(`${ONESHOT_CWD_PREFIX}unknown`, OLD, live({ startMs: null }));
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("skips a directory owned by another uid, whatever its owner file says", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}foreign`, OLD, live({ pid: deadPid() }));
    expect(sweep({ uid: statSync(path).uid + 1 })).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a young directory even when its owner is dead", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}young`, YOUNG, live({ pid: deadPid() }));
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("falls back to the age rule for a directory with no owner file at all (made before r12)", () => {
    const none = leftover(`${ONESHOT_CONFIG_PREFIX}none`, OLD);
    const young = leftover(`${ONESHOT_CWD_PREFIX}young-none`, YOUNG);
    expect(sweep()).toBe(1);
    expect(existsSync(none)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  // #570 r13 (A5): an owner file that is there but cannot be understood may belong to a live call.
  it("quarantines a directory whose owner file is malformed or unreadable: logged once, never removed", () => {
    const broken = leftover(`${ONESHOT_CWD_PREFIX}broken`, OLD, "garbage");
    const noPid = leftover(`${ONESHOT_CWD_PREFIX}no-pid`, OLD);
    writeFileSync(join(noPid, ONESHOT_OWNER_FILE), JSON.stringify({ instance: "x" }));
    const unreadable = leftover(`${ONESHOT_CWD_PREFIX}unreadable`, OLD);
    mkdirSync(join(unreadable, ONESHOT_OWNER_FILE)); // a directory where the file should be
    for (const dir of [noPid, unreadable]) utimesSync(dir, OLD, OLD); // writing touched them
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(sweep()).toBe(0);
      expect(sweep()).toBe(0);
      for (const dir of [broken, noPid, unreadable]) expect(existsSync(dir)).toBe(true);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(logged.filter((line) => line.includes("quarantined")).length).toBe(3); // once each
      expect(logged.join("\n")).not.toContain(base);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a call of this daemon that is still running, and removes one it has finished with", () => {
    const own = live({ pid: process.pid, instance: DAEMON_INSTANCE });
    const running = leftover(`${ONESHOT_CONFIG_PREFIX}running`, OLD, own);
    const failed = leftover(`${ONESHOT_CONFIG_PREFIX}failed`, OLD, own);
    markOneShotDirActive(running);
    try {
      expect(sweep()).toBe(1);
    } finally {
      releaseOneShotDir(running);
    }
    expect(existsSync(running)).toBe(true);
    expect(existsSync(failed)).toBe(false);
  });

  it("leaves symlinks and plain files with the prefix alone", () => {
    const target = join(base, "target");
    mkdirSync(target);
    utimesSync(target, OLD, OLD);
    symlinkSync(target, join(base, `${ONESHOT_CONFIG_PREFIX}link`));
    writeFileSync(join(base, `${ONESHOT_CWD_PREFIX}file`), "x");
    utimesSync(join(base, `${ONESHOT_CWD_PREFIX}file`), OLD, OLD);
    expect(sweep()).toBe(0);
    expect(existsSync(target)).toBe(true);
  });
});

describe("owner files", () => {
  it("are written into the config root and the temp cwd when they are created", () => {
    const cwd = createUntrustedTempCwd();
    const root = createUntrustedConfigRoot([cwd]);
    try {
      for (const dir of [cwd, root]) {
        const owner = JSON.parse(
          readFileSync(join(dir, ONESHOT_OWNER_FILE), "utf8"),
        ) as OwnerRecord;
        expect(owner.pid).toBe(process.pid);
        expect(owner.instance).toBe(DAEMON_INSTANCE);
        expect(statSync(join(dir, ONESHOT_OWNER_FILE)).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("startOneShotSweeper", () => {
  it("sweeps now and registers one unref'd 10-minute timer, however often it is called", () => {
    const registered: number[] = [];
    let unrefs = 0;
    let passes = 0;
    let tick: (() => void) | undefined;
    const deps = {
      sweep: () => ++passes,
      setInterval: (callback: () => void, ms: number) => {
        registered.push(ms);
        tick = callback;
        return { unref: () => void unrefs++ };
      },
    };
    expect(startOneShotSweeper(deps)).toBe(1);
    startOneShotSweeper(deps);
    expect(registered).toEqual([ONESHOT_SWEEP_INTERVAL_MS]);
    expect(ONESHOT_SWEEP_INTERVAL_MS).toBe(10 * 60_000);
    expect(unrefs).toBe(1);
    tick?.();
    expect(passes).toBe(3); // two starts and one timer tick
  });

  it("survives a pass that throws, so the next tick still runs, and says so", () => {
    let tick: (() => void) | undefined;
    let passes = 0;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      startOneShotSweeper({
        sweep: () => {
          passes++;
          if (passes === 2) throw new Error("boom");
          return 0;
        },
        retrySurvivors: async () => 0,
        setInterval: (callback) => {
          tick = callback;
          return {};
        },
      });
      expect(() => tick?.()).not.toThrow();
      tick?.();
      expect(passes).toBe(3);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(logged.some((line) => line.includes("sweeper pass failed"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("signals recorded survivors again on every tick, and logs a retry that throws", async () => {
    let tick: (() => void) | undefined;
    let retries = 0;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      startOneShotSweeper({
        sweep: () => 0,
        retrySurvivors: async () => {
          retries++;
          throw new Error("boom");
        },
        setInterval: (callback) => {
          tick = callback;
          return {};
        },
      });
      tick?.();
      tick?.();
      await new Promise((r) => setTimeout(r, 10));
      expect(retries).toBe(2);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(logged.filter((line) => line.includes("survivor retry failed")).length).toBe(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("operatorSecureStorageDir with the daemon's own env", () => {
  it("takes the operator's CLAUDE_CONFIG_DIR from the daemon when print's policy env lacks it", () => {
    expect(
      operatorSecureStorageDir({ PATH: "/usr/bin" }, { CLAUDE_CONFIG_DIR: "/home/op/claude" }),
    ).toBe("/home/op/claude");
  });

  it("lets the policy env win over the daemon's", () => {
    expect(
      operatorSecureStorageDir(
        { CLAUDE_CONFIG_DIR: "/policy/dir" },
        { CLAUDE_CONFIG_DIR: "/home/op/claude" },
      ),
    ).toBe("/policy/dir");
    expect(
      operatorSecureStorageDir(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/policy/store" },
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/daemon/store", CLAUDE_CONFIG_DIR: "/home/op/claude" },
      ),
    ).toBe("/policy/store");
  });

  it("takes an explicit CLAUDE_SECURESTORAGE_CONFIG_DIR from the daemon too", () => {
    expect(operatorSecureStorageDir({}, { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/daemon/store" })).toBe(
      "/daemon/store",
    );
  });

  it("is the default store ('') when neither env names a directory", () => {
    expect(operatorSecureStorageDir({}, {})).toBe("");
  });

  it("fails closed on a relative directory from the daemon env", () => {
    expect(() => operatorSecureStorageDir({}, { CLAUDE_CONFIG_DIR: "relative/dir" })).toThrow(
      /absolute/,
    );
  });
});

describe("group survivors", () => {
  it("are recorded per root", () => {
    markGroupSurvivor("/tmp/root-a", 4242);
    expect(groupSurvivorOf("/tmp/root-a")).toBe(4242);
    expect(groupSurvivorOf("/tmp/root-b")).toBeUndefined();
  });

  // #570 r13 (A4): the root of a call whose claude could not be stopped is not swept from under it.
  it("keep their root and temp cwd out of the sweep, however old and however dead the owner", () => {
    const own = live({ pid: process.pid, instance: DAEMON_INSTANCE });
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}survived`, OLD, own);
    const cwd = leftover(`${ONESHOT_CWD_PREFIX}survived`, OLD, own);
    const other = leftover(`${ONESHOT_CONFIG_PREFIX}finished`, OLD, own);
    markGroupSurvivor(root, 4242, { tempCwd: cwd, startMs: 1, cwds: [cwd] });
    expect(sweep()).toBe(1);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("are swept once the survivor is gone", async () => {
    const own = live({ pid: process.pid, instance: DAEMON_INSTANCE });
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}later`, OLD, own);
    markGroupSurvivor(root, 4242, { startMs: 1 });
    utimesSync(root, OLD, OLD); // recording the survivor wrote survivor.json into it
    // The escape scan is faked, as in the other sweeps of this file: left real, on Linux a leader
    // start of 1 ms makes every process of the host a candidate, and one the scan cannot read holds
    // the root, so the result would depend on what else runs on the machine.
    const quiet = { scan: () => ({ pids: [], unknown: [] }) as EscapeScan };
    expect(sweep(quiet)).toBe(0);
    await retrySurvivingGroups({ retire: retireFake(() => true), reap: async () => [] });
    expect(groupSurvivorCount()).toBe(0);
    expect(sweep(quiet)).toBe(1);
    expect(existsSync(root)).toBe(false);
  });
});

describe("retrySurvivingGroups", () => {
  it("retires each recorded survivor again, with the identity, group id and members recorded at spawn and no first-termination privilege", async () => {
    const members = [{ pid: 4243, identity: "m-1" }];
    markGroupSurvivor("/tmp/root-a", 4242, {
      startMs: 1_700_000_000_000,
      cwds: ["/tmp/cwd-a"],
      identity: "id-4242",
      groupId: 4242,
      members,
    });
    const seen: Array<{
      pid: number;
      identity: string | null;
      groupId: number | null;
      members: unknown;
      initial: boolean;
      allowUnrecordedInitial: boolean;
    }> = [];
    const reaped: Array<{ root: string | null; cwds: string[]; leaderStartMs?: number | null }> =
      [];
    const cleared = await retrySurvivingGroups({
      retire: async (input) => {
        seen.push({
          pid: input.pid,
          identity: input.identity,
          groupId: input.groupId,
          members: input.members,
          initial: input.initial,
          allowUnrecordedInitial: input.allowUnrecordedInitial,
        });
        return retireOutcome(true);
      },
      reap: async (target) => {
        reaped.push(target);
        return [];
      },
    });
    expect(cleared).toBe(1);
    // Went red (initial true) with the retry given the first-termination privilege; went red
    // (members []) with the recorded members no longer handed to the retirement.
    expect(seen).toEqual([
      {
        pid: 4242,
        identity: "id-4242",
        groupId: 4242,
        members,
        initial: false,
        allowUnrecordedInitial: false,
      },
    ]);
    expect(reaped).toEqual([
      // Went red (no leaderStartMs) with the survivor's start time no longer handed to the scan.
      { root: "/tmp/root-a", cwds: ["/tmp/cwd-a"], leaderStartMs: 1_700_000_000_000 },
    ]);
    expect(groupSurvivorOf("/tmp/root-a")).toBeUndefined();
  });

  it("keeps an entry whose group is still alive, or that still has a process outside it, and logs metadata only", async () => {
    markGroupSurvivor("/tmp/secret-root-a", 4242, { startMs: 1, cwds: ["/tmp/secret-cwd"] });
    markGroupSurvivor("/tmp/secret-root-b", 4343, { startMs: 1, cwds: ["/tmp/secret-cwd"] });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cleared = await retrySurvivingGroups({
        retire: retireFake((input) => input.pid === 4343), // 4242's group survives again
        reap: async (target) => (target.root.endsWith("-b") ? [999] : []),
      });
      expect(cleared).toBe(0);
      expect(groupSurvivorCount()).toBe(2);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(logged).toContain("pid 4242");
      expect(logged).toContain("pid 4343");
      expect(logged).not.toContain("secret");
    } finally {
      error.mockRestore();
    }
  });

  it("keeps going when one retry throws, and keeps that entry", async () => {
    markGroupSurvivor("/tmp/root-a", 4242, { startMs: 1 });
    markGroupSurvivor("/tmp/root-b", 4343, { startMs: 1 });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cleared = await retrySurvivingGroups({
        retire: async (input) => {
          if (input.pid === 4242) throw new Error("boom");
          return retireOutcome(true);
        },
        reap: async () => [],
      });
      expect(cleared).toBe(1);
      expect(groupSurvivorOf("/tmp/root-a")).toBe(4242);
      expect(groupSurvivorOf("/tmp/root-b")).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });

  // #570 r13 (F): the same owner pid names many directories; ask `ps` about it once per pass.
  it("asks for each owner pid's start time once per sweep pass", () => {
    const own = live();
    for (const n of [1, 2, 3]) leftover(`${ONESHOT_CWD_PREFIX}same-owner-${n}`, OLD, own);
    const asked: number[] = [];
    const startMs = (pid: number): number | null => {
      asked.push(pid);
      return selfStart;
    };
    expect(sweep({ startMs })).toBe(0); // the owner is alive: all three are kept
    expect(asked).toEqual([process.pid]);
    asked.length = 0;
    sweep({ startMs }); // a new pass asks again
    expect(asked).toEqual([process.pid]);
  });
});

// #570 r14 (C): a survivor outlives a daemon restart.
describe("survivor.json", () => {
  const own = (): OwnerRecord =>
    live({ pid: deadPid(), instance: "the-daemon-before-the-restart" });
  const restart = (): void => resetGroupSurvivorsForTests(); // the in-memory map dies with the daemon
  const warnSpy = () => spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = () => spyOn(console, "error").mockImplementation(() => {});

  it("is written into the root with the pid, start time and cwds, mode 0600", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}record`, OLD, own());
    markGroupSurvivor(root, 4242, { startMs: 1_700_000_000_000, cwds: ["/tmp/a", "/tmp/b"] });
    const file = join(root, ONESHOT_SURVIVOR_FILE);
    // Went red (no such file) with the write removed.
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      pid: 4242,
      startMs: 1_700_000_000_000,
      cwds: ["/tmp/a", "/tmp/b"],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("carries the identity, group id and identified members across a restart into the retry (#581 cp8, H1)", async () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}members`, OLD, own());
    const members = [
      { pid: 4243, identity: "m-1" },
      { pid: 4244, identity: "m-2" },
    ];
    markGroupSurvivor(root, 4242, {
      startMs: 7,
      identity: "id-4242",
      groupId: 4242,
      members,
      cwds: [],
    });
    // Went red (members [] in the file) with the members left out of the persisted record.
    expect(JSON.parse(readFileSync(join(root, ONESHOT_SURVIVOR_FILE), "utf8"))).toMatchObject({
      identity: "id-4242",
      groupId: 4242,
      members,
    });
    utimesSync(root, OLD, OLD);
    restart();
    const error = errorSpy();
    try {
      expect(sweep({ groupGone: () => false })).toBe(0); // adopts it back, removes nothing
    } finally {
      error.mockRestore();
    }
    const seen: Array<{ identity: string | null; groupId: number | null; members: unknown }> = [];
    await retrySurvivingGroups({
      retire: async (input) => {
        seen.push({ identity: input.identity, groupId: input.groupId, members: input.members });
        return retireOutcome(false);
      },
      reap: async () => [],
    });
    expect(seen).toEqual([{ identity: "id-4242", groupId: 4242, members }]);
  });

  it("does not make recording the survivor throw when it cannot be written, and says so", () => {
    const error = errorSpy();
    try {
      const notADir = join(base, "a-file");
      writeFileSync(notADir, "x");
      expect(() => markGroupSurvivor(notADir, 4242, { startMs: 1 })).not.toThrow();
      expect(groupSurvivorOf(notADir)).toBe(4242); // still held in memory
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(logged).toContain("not persisted");
      expect(logged).not.toContain(base);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps a root whose recorded group is still alive across a restart, and re-registers it", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}alive`, OLD, own());
    const cwd = leftover(`${ONESHOT_CWD_PREFIX}alive`, OLD, own());
    markGroupSurvivor(root, 4242, { startMs: 7, tempCwd: cwd, cwds: [cwd] });
    for (const dir of [root, cwd]) utimesSync(dir, OLD, OLD);
    restart();
    const error = errorSpy();
    try {
      const asked: Array<{ pid: number; startMs: number | null }> = [];
      expect(
        sweep({
          groupGone: (survivor) => {
            asked.push({ pid: survivor.pid, startMs: survivor.startMs });
            return false;
          },
        }),
      ).toBe(0);
      // Went red (2 removed, expected 0) with the adoption pre-pass removed.
      expect(asked).toEqual([{ pid: 4242, startMs: 7 }]); // asked with the recorded identity
    } finally {
      error.mockRestore();
    }
    expect(existsSync(root)).toBe(true);
    expect(existsSync(cwd)).toBe(true); // its temp cwd too, though it carries no record itself
    expect(groupSurvivorOf(root)).toBe(4242); // the timer will signal it again
  });

  it("keeps a root, as a survivor, when the group is gone but the escape scan finds a process or throws", () => {
    const error = errorSpy();
    try {
      const scans: Record<string, () => EscapeScan> = {
        found: () => ({ pids: [999], unknown: [] }),
        threw: () => {
          throw new Error("no /proc");
        },
      };
      for (const [name, scan] of Object.entries(scans)) {
        const root = leftover(`${ONESHOT_CONFIG_PREFIX}scan-${name}`, OLD, own());
        markGroupSurvivor(root, 4242, { startMs: 7, cwds: [] });
        utimesSync(root, OLD, OLD);
        restart();
        expect(sweep({ groupGone: () => true, scan })).toBe(0);
        expect(existsSync(root)).toBe(true);
        expect(groupSurvivorOf(root)).toBe(4242);
      }
    } finally {
      error.mockRestore();
    }
  });

  it("removes a root once its recorded group is gone and the scan comes back clean", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}done`, OLD, own());
    markGroupSurvivor(root, 4242, { startMs: 7, cwds: [] });
    utimesSync(root, OLD, OLD);
    restart();
    expect(sweep({ groupGone: () => true, scan: () => ({ pids: [], unknown: [] }) })).toBe(1);
    expect(existsSync(root)).toBe(false);
    expect(groupSurvivorCount()).toBe(0);
  });

  it("reads the recorded identity: a leader pid that now has another start time is a group that is gone", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}recycled`, OLD, own());
    // The parent process is alive, with a start time that is not 1970's.
    markGroupSurvivor(root, process.ppid, { startMs: 1, cwds: [] });
    utimesSync(root, OLD, OLD);
    restart();
    // Went red (0 removed, expected 1) with the recorded identity ignored.
    expect(sweep({ scan: () => ({ pids: [], unknown: [] }) })).toBe(1);
    expect(existsSync(root)).toBe(false);
  });

  it("keeps a root whose recorded leader is alive with the recorded start time", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}same`, OLD, own());
    markGroupSurvivor(root, process.ppid, { startMs: processStartMs(process.ppid), cwds: [] });
    utimesSync(root, OLD, OLD);
    restart();
    const error = errorSpy();
    try {
      expect(sweep({ scan: () => ({ pids: [], unknown: [] }) })).toBe(0);
    } finally {
      error.mockRestore();
    }
    expect(existsSync(root)).toBe(true);
    expect(groupSurvivorOf(root)).toBe(process.ppid);
  });

  it("quarantines a root whose survivor.json is unreadable: named in the log, not removed before 24 h", () => {
    const root = leftover(`${ONESHOT_CONFIG_PREFIX}bad-record`, OLD, own());
    writeFileSync(join(root, ONESHOT_SURVIVOR_FILE), "{not json");
    utimesSync(root, OLD, OLD);
    const warn = warnSpy();
    try {
      expect(sweep({ scan: () => ({ pids: [], unknown: [] }) })).toBe(0);
      expect(existsSync(root)).toBe(true);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      // Went red with the directory's name left out of the log.
      expect(logged).toContain(`${ONESHOT_CONFIG_PREFIX}bad-record`); // the basename
      expect(logged).not.toContain(base);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("quarantine (#570 r14, M4)", () => {
  const ancient = (NOW - ONESHOT_QUARANTINE_MAX_AGE_MS - 60_000) / 1000;
  const broken = (name: string, mtime: number): string => {
    const path = leftover(name, mtime, "garbage");
    utimesSync(path, mtime, mtime);
    return path;
  };

  it("is removed after 24 h when the escape scan finds nothing", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = broken(`${ONESHOT_CWD_PREFIX}ancient-clean`, ancient);
      expect(sweep({ scan: () => ({ pids: [], unknown: [] }) })).toBe(1);
      expect(existsSync(path)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("is kept after 24 h when the scan finds a process or throws", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const found = broken(`${ONESHOT_CWD_PREFIX}ancient-found`, ancient);
      const threw = broken(`${ONESHOT_CONFIG_PREFIX}ancient-threw`, ancient);
      const scan = (target: { root: string | null }) => {
        if (target.root?.endsWith("ancient-threw")) throw new Error("no /proc");
        return { pids: [4242], unknown: [] };
      };
      expect(sweep({ scan })).toBe(0);
      for (const path of [found, threw]) expect(existsSync(path)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("is not kept for ever by a process the scan merely could not read (it cannot be attributed)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = broken(`${ONESHOT_CONFIG_PREFIX}ancient-unreadable`, ancient);
      const unreadable = {
        pid: 4242,
        startMs: 1,
        envErrno: "EACCES",
        cwdErrno: "EACCES",
        descendant: false,
        ageMs: null,
      };
      expect(sweep({ scan: () => ({ pids: [], unknown: [unreadable] }) })).toBe(1);
      expect(existsSync(path)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("scans a config root by its root and a temp cwd by its cwd, never by an empty root", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = broken(`${ONESHOT_CONFIG_PREFIX}scanned`, ancient);
      const cwd = broken(`${ONESHOT_CWD_PREFIX}scanned`, ancient);
      const seen: Array<{ root: string | null; cwds: string[] }> = [];
      sweep({
        scan: (target) => {
          seen.push(target);
          return { pids: [], unknown: [] };
        },
      });
      expect(seen.find((t) => t.root === root)?.cwds).toEqual([]);
      const forCwd = seen.find((t) => t.root === null);
      expect(forCwd?.cwds).toContain(cwd);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("retrySurvivingGroups with no recorded identity or members (r14d, H2; #581 cp8, H1)", () => {
  it("is never told it is the first termination, keeps the root registered, and says so once with metadata only", async () => {
    markGroupSurvivor("/tmp/secret-root-x", 4242, { startMs: null, cwds: ["/tmp/secret-cwd"] });
    const told: Array<[boolean, boolean]> = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 3; pass++) {
        const cleared = await retrySurvivingGroups({
          retire: async (input) => {
            told.push([input.initial, input.allowUnrecordedInitial]);
            return retireOutcome(false); // the group is alive and was not signalled
          },
          reap: async () => [],
        });
        expect(cleared).toBe(0);
      }
      // Went red ([true, true] x3) with the first-termination privilege added to the retry.
      expect(told).toEqual([
        [false, false],
        [false, false],
        [false, false],
      ]);
      expect(groupSurvivorOf("/tmp/secret-root-x")).toBe(4242);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0]));
      // Went red (3 lines) with the once-per-root set removed.
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain("pid 4242");
      expect(logged[0]).toContain("no recorded identity or members");
      expect(logged[0]).toContain("secret-root-x");
      expect(logged[0]).not.toContain("/tmp/");
      expect(logged[0]).not.toContain("secret-cwd");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  // #581 cp8, H1: a LEGACY record (a historical group id and the leader's birth time, no identity,
  // no members) once signalled a group whose leader was long gone: the group id may be a stranger's.
  it("sends no signal at all to a live group whose leader is absent, with the real retirement", async () => {
    markGroupSurvivor("/tmp/root-null", 4242, { startMs: 1_700_000_000_000, cwds: [] });
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    const kernel = (target: number, name: NodeJS.Signals | 0): void => {
      sent.push([target, name]);
      // The leader is gone (ESRCH); the group id answers: someone else's group is there.
      if (name === 0 && target === 4242) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cleared = await retrySurvivingGroups({
        retire: (input) =>
          retireProcessGroup({
            ...input,
            signal: kernel,
            readIdentity: () => null,
            readMembers: () => ({ members: [{ pid: 9001, identity: "stranger" }], complete: true }),
            readGroupId: (pid) => pid,
            daemonGroupId: 1000,
            sleep: async () => {},
            liveMembers: () => undefined,
            describe: () => ({ count: undefined, comm: [] }),
          }),
        reap: async () => [],
        capMs: 50,
      });
      expect(cleared).toBe(0);
      // Went red (SIGTERM then SIGKILL to -4242 sent) with the old rule restored: a recorded
      // leader birth time authorising a group signal for a leader that is absent.
      expect(sent.filter(([, name]) => name !== 0)).toEqual([]);
      expect(groupSurvivorOf("/tmp/root-null")).toBe(4242);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("retrySurvivingGroups with the real retirement (#570 r14, B and E; #581 cp8, H1)", () => {
  it("signals the group of the recorded leader with a recording kernel, and carries the members on", async () => {
    markGroupSurvivor("/tmp/root-real", 4242, {
      startMs: 1_700_000_000_000,
      cwds: [],
      identity: "id-4242",
      groupId: 4242,
      members: [{ pid: 4243, identity: "m-1" }],
    });
    const sent: Array<[number, NodeJS.Signals]> = [];
    let alive = true;
    const kernel = (target: number, name: NodeJS.Signals | 0): void => {
      if (name === 0) {
        if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return;
      }
      sent.push([target, name]);
      alive = false;
    };
    const cleared = await retrySurvivingGroups({
      retire: (input) =>
        retireProcessGroup({
          ...input,
          signal: kernel,
          readIdentity: () => "id-4242", // the leader is the one recorded
          readMembers: () => ({ members: [{ pid: 4243, identity: "m-1" }], complete: true }),
          readGroupId: (pid) => pid,
          daemonGroupId: 1000,
          sleep: async () => {},
          liveMembers: () => undefined,
        }),
      reap: async () => [],
    });
    // Went red (cleared 0, expected 1) with the `-pid` send deleted from GroupTarget.send.
    expect(cleared).toBe(1);
    expect(sent).toEqual([[-4242, "SIGTERM"]]);
  });

  it("signals a group whose leader is gone only while a recorded member is still in it", async () => {
    const record = (): void =>
      markGroupSurvivor("/tmp/root-member", 4242, {
        startMs: 1_700_000_000_000,
        cwds: [],
        identity: "id-4242",
        groupId: 4242,
        members: [{ pid: 4243, identity: "m-1" }],
      });
    const sent: Array<[number, NodeJS.Signals]> = [];
    let alive = true;
    let memberIdentity = "m-1";
    const kernel = (target: number, name: NodeJS.Signals | 0): void => {
      if (target === 4242 && name === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (name === 0) {
        if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return;
      }
      sent.push([target, name]);
      alive = false;
    };
    const run = (): Promise<number> =>
      retrySurvivingGroups({
        retire: (input) =>
          retireProcessGroup({
            ...input,
            signal: kernel,
            readIdentity: () => null,
            readMembers: () => ({
              members: [{ pid: 4243, identity: memberIdentity }],
              complete: true,
            }),
            readGroupId: (pid) => pid,
            daemonGroupId: 1000,
            sleep: async () => {},
            liveMembers: () => undefined,
            describe: () => ({ count: 1, comm: [] }),
          }),
        reap: async () => [],
        capMs: 50,
      });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      // The group id was reused: pid 4243 is another process now. Nothing vouches for the group.
      record();
      memberIdentity = "someone-else";
      expect(await run()).toBe(0);
      // Went red ([[-4242, "SIGTERM"]]) with the members no longer read again before the signal.
      expect(sent).toEqual([]);
      // The recorded member is still there with its identity: the group is ours.
      record();
      memberIdentity = "m-1";
      expect(await run()).toBe(1);
      expect(sent).toEqual([[-4242, "SIGTERM"]]);
    } finally {
      error.mockRestore();
    }
  });
});

// #570 r14b: a process the escape scan could not read keeps the root while it lives, and is not a failure.
describe("unknown holds (r14b)", () => {
  const own = (): OwnerRecord =>
    live({ pid: deadPid(), instance: "the-daemon-before-the-restart" });
  const unreadable = (pid: number, startMs: number | null) => ({
    pid,
    startMs,
    envErrno: "EACCES",
    cwdErrno: "EACCES",
    descendant: false,
    ageMs: 120,
  });
  const leader = { pid: 4242, startMs: 7 };
  const spawned: ReturnType<typeof Bun.spawn>[] = [];
  afterEach(() => {
    for (const child of spawned.splice(0)) child.kill("SIGKILL");
  });
  const stray = (): { pid: number; startMs: number | null } => {
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    spawned.push(child);
    return { pid: child.pid, startMs: processStartMs(child.pid) };
  };
  async function died(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    child.kill("SIGKILL");
    await child.exited;
  }

  it("keeps the root and the temp cwd while the unreadable process lives with the same start time, then removes them", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = leftover(
        `${ONESHOT_CONFIG_PREFIX}held`,
        OLD,
        live({ instance: DAEMON_INSTANCE }),
      );
      const cwd = leftover(`${ONESHOT_CWD_PREFIX}held`, OLD, live({ instance: DAEMON_INSTANCE }));
      const proc = stray();
      markUnknownProcs(root, leader, [unreadable(proc.pid, proc.startMs)], {
        tempCwd: cwd,
        cwds: [cwd],
      });
      for (const dir of [root, cwd]) utimesSync(dir, OLD, OLD);

      expect(groupSurvivorCount()).toBe(0); // an unknown is not a group survivor
      expect(unknownHoldCount()).toBe(1);
      // Went red (both removed) with the hold ignored by the sweep.
      expect(sweep()).toBe(0);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(cwd)).toBe(true);

      await died(spawned[0] as never);
      // Went red (root kept for ever) with the hold never dropped once the process died.
      expect(sweep()).toBe(2);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(cwd)).toBe(false);
      expect(unknownHoldCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("counts a recycled pid as gone: the same pid with another start time does not keep the root", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = leftover(
        `${ONESHOT_CONFIG_PREFIX}recycled-hold`,
        OLD,
        live({ instance: DAEMON_INSTANCE }),
      );
      const proc = stray();
      markUnknownProcs(root, leader, [unreadable(proc.pid, (proc.startMs ?? 0) - 3_600_000)]);
      utimesSync(root, OLD, OLD);
      // Went red (0 removed) with the start time ignored when checking the held process.
      expect(sweep()).toBe(1);
      expect(existsSync(root)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("writes the unknown pids and their start times into survivor.json, with the leader", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = leftover(`${ONESHOT_CONFIG_PREFIX}persisted`, OLD, own());
      markUnknownProcs(root, leader, [unreadable(5151, 123_450)], { cwds: ["/tmp/c"] });
      const record = JSON.parse(readFileSync(join(root, ONESHOT_SURVIVOR_FILE), "utf8"));
      // Went red (no unknown list) with the held processes left out of the record.
      expect(record).toMatchObject({
        pid: 4242,
        startMs: 7,
        cwds: ["/tmp/c"],
        unknown: [{ pid: 5151, startMs: 123_450 }],
      });
      expect(JSON.stringify(record)).not.toContain("EACCES");
    } finally {
      warn.mockRestore();
    }
  });

  it("is re-registered after a restart while a recorded process lives, and removed once it is gone", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const root = leftover(`${ONESHOT_CONFIG_PREFIX}restart-hold`, OLD, own());
      markUnknownProcs(root, leader, [unreadable(5151, 123_450)]);
      utimesSync(root, OLD, OLD);
      resetGroupSurvivorsForTests(); // the daemon restarted
      const quiet = { groupGone: () => true, scan: () => ({ pids: [], unknown: [] }) };
      // Went red (removed) with the recorded unknown list not read on adoption.
      expect(sweep({ ...quiet, heldAlive: () => true })).toBe(0);
      expect(existsSync(root)).toBe(true);
      expect(unknownHoldCount()).toBe(1);
      expect(groupSurvivorCount()).toBe(0);

      resetGroupSurvivorsForTests();
      expect(sweep({ ...quiet, heldAlive: () => false })).toBe(1);
      expect(existsSync(root)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs metadata only: pid, errnos, ancestry and age, and nothing else", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      markUnknownProcs("/tmp/secret-root-path", leader, [unreadable(5151, 123_450)]);
      markUnknownProcs("/tmp/secret-root-path", leader, [unreadable(5151, 123_450)]);
      const logged = warn.mock.calls.map((call: unknown[]) => String(call[0]));
      // Went red (2 lines) with the once-per-process dedupe removed.
      expect(logged).toHaveLength(1); // once per process
      expect(logged[0]).toContain("pid 5151");
      expect(logged[0]).toContain("environ EACCES, cwd EACCES");
      expect(logged[0]).toContain("descendant of the daemon: no");
      expect(logged[0]).toContain("120 ms after the leader");
      expect(logged[0]).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });
});

// #570 r14d (H1), #581 cp2: a recorded start time is compared exactly on every platform, so a
// process that started one or two seconds after the recorded one is another process, under `ps`
// as under `/proc`. The 2000 ms window #570 kept for `ps` is gone.
describe("start-time comparison on every platform (r14d, H1; #581 cp2)", () => {
  const alive = () => {};
  const platforms: Array<"linux" | "darwin"> = ["linux", "darwin"];

  it("a held process whose start moved by one or two seconds is gone, on every platform", () => {
    const held = { pid: 4242, startMs: 10_000 };
    for (const platform of platforms) {
      for (const now of [11_000, 12_000]) {
        const deps = { kill: alive, startMs: () => now };
        expect(withPlatform(platform, () => heldProcAlive(held, deps))).toBe(false);
      }
      // The twin: the recorded start time itself is still the held process.
      const same = { kill: alive, startMs: () => 10_000 };
      expect(withPlatform(platform, () => heldProcAlive(held, same))).toBe(true);
    }
  });

  it("an owner whose start moved by one or two seconds is dead, on every platform", () => {
    const owner = live({ pid: 4242, startMs: 10_000, instance: "an-earlier-daemon" });
    for (const platform of platforms) {
      for (const now of [11_000, 12_000]) {
        const deps = { kill: alive, startMs: () => now, anotherBoot: () => false };
        expect(withPlatform(platform, () => isOwnerDead(owner, deps))).toBe(true);
      }
      const same = { kill: alive, startMs: () => 10_000, anotherBoot: () => false };
      expect(withPlatform(platform, () => isOwnerDead(owner, same))).toBe(false);
    }
  });

  it("macOS: a whole-second start an older daemon recorded is still the held process and the owner, read in that second (#581 decision 2)", () => {
    // Before libproc, macOS start times were `ps lstart` whole seconds. A reading in the same
    // second cannot show the record names another process, so nothing is swept on its account.
    const legacy = 1_793_106_335_000;
    const held = { pid: 4242, startMs: legacy };
    const owner = live({ pid: 4242, startMs: legacy, instance: "an-earlier-daemon" });
    const deps = { kill: alive, startMs: () => legacy + 845.98, anotherBoot: () => false };
    expect(withPlatform("darwin", () => heldProcAlive(held, deps))).toBe(true);
    expect(withPlatform("darwin", () => isOwnerDead(owner, deps))).toBe(false);
    // Linux start times are exact, whole seconds or not: the same numbers there are another process.
    expect(withPlatform("linux", () => heldProcAlive(held, deps))).toBe(false);
    expect(withPlatform("linux", () => isOwnerDead(owner, deps))).toBe(true);
  });
});

// #570 r15 (A1): a Linux start time counts from boot, so a record written before a reboot can
// show a live pid whose start time matches by coincidence. Records carry the boot id, and one
// from another boot names nothing that can be running: nothing is probed or signalled.
describe("a persisted record from another boot is gone", () => {
  const onBoot = (current: string) => (recorded: string | null | undefined) =>
    recordedOnAnotherBoot(recorded, { platform: "linux", bootId: () => current });
  const restart = (): void => resetGroupSurvivorsForTests();
  const quiet = () => [
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];

  it("isOwnerDead: a live pid with a matching start time is dead when the boot id differs", () => {
    const owner = live({ bootId: "boot-A" }); // this very process, same start time
    expect(isOwnerDead(owner, { anotherBoot: onBoot("boot-B") })).toBe(true);
    // The twin: the same record on the boot that wrote it is still the live owner.
    expect(isOwnerDead(owner, { anotherBoot: onBoot("boot-A") })).toBe(false);
    // A Linux record with no boot id is from before the field existed.
    expect(isOwnerDead(live({ bootId: null }), { anotherBoot: onBoot("boot-B") })).toBe(true);
  });

  it("the sweep removes a directory whose owner file is from another boot", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}old-boot`, OLD, live({ bootId: "boot-A" }));
    expect(sweep({ anotherBoot: onBoot("boot-A") })).toBe(0); // same boot: the owner lives
    expect(existsSync(path)).toBe(true);
    expect(sweep({ anotherBoot: onBoot("boot-B") })).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  /** A root left by a daemon that died; its survivor.json names a leader and one held process (probes are stubbed). */
  function persisted(bootId: string | null): string {
    const root = leftover(
      `${ONESHOT_CONFIG_PREFIX}survivor-${bootId}`,
      OLD,
      live({ pid: deadPid(), instance: "the-daemon-before-the-restart", bootId }),
    );
    writeFileSync(
      join(root, ONESHOT_SURVIVOR_FILE),
      JSON.stringify({
        pid: 4242,
        startMs: selfStart,
        bootId,
        cwds: [],
        unknown: [{ pid: 4343, startMs: selfStart }],
      }),
    );
    utimesSync(root, OLD, OLD);
    return root;
  }

  it("survivor.json from another boot: no group probe, no scan, no hold, and the root is swept", () => {
    const root = persisted("boot-A");
    const groupGone = spyOn({ f: (_r: unknown) => true }, "f");
    const scan = spyOn({ f: (_t: unknown) => ({ pids: [], unknown: [] }) as EscapeScan }, "f");
    const heldAlive = spyOn({ f: (_p: unknown) => true }, "f");
    const logs = quiet();
    try {
      restart();
      expect(
        sweep({
          anotherBoot: onBoot("boot-B"),
          groupGone: groupGone as never,
          scan: scan as never,
          heldAlive: heldAlive as never,
        }),
      ).toBe(1);
      expect(groupGone).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(heldAlive).not.toHaveBeenCalled();
      expect(groupSurvivorOf(root)).toBeUndefined();
      expect(unknownHoldCount()).toBe(0);
      expect(existsSync(root)).toBe(false);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("twin: the same record on the boot that wrote it is still a survivor and is kept", () => {
    const root = persisted("boot-A");
    const logs = quiet();
    try {
      restart();
      const asked: Array<{ pid: number; startMs: number | null }> = [];
      expect(
        sweep({
          anotherBoot: onBoot("boot-A"),
          groupGone: (r) => {
            asked.push({ pid: r.pid, startMs: r.startMs });
            return false;
          },
          scan: () => ({ pids: [], unknown: [] }) as EscapeScan,
          heldAlive: () => true,
        }),
      ).toBe(0);
      expect(asked).toEqual([{ pid: 4242, startMs: selfStart }]); // asked with the recorded identity
      expect(groupSurvivorOf(root)).toBe(4242);
      expect(existsSync(root)).toBe(true);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  // #581 cp2: a record written before the boot id existed has no `bootId` KEY at all (not null).
  // It stays readable, and on Linux it never authorises a probe or a signal: with no boot id there
  // is no way to know its start time was read on this boot.
  function persistedLegacy(): string {
    const root = leftover(
      `${ONESHOT_CONFIG_PREFIX}survivor-legacy`,
      OLD,
      live({ pid: deadPid(), instance: "the-daemon-before-the-restart" }),
    );
    const { bootId: _owner, ...legacyOwner } = live({
      pid: deadPid(),
      instance: "the-daemon-before-the-restart",
    });
    writeFileSync(join(root, ONESHOT_OWNER_FILE), JSON.stringify(legacyOwner));
    writeFileSync(
      join(root, ONESHOT_SURVIVOR_FILE),
      JSON.stringify({
        pid: 4242,
        startMs: selfStart,
        cwds: [],
        unknown: [{ pid: 4343, startMs: selfStart }],
      }),
    );
    expect("bootId" in JSON.parse(readFileSync(join(root, ONESHOT_SURVIVOR_FILE), "utf8"))).toBe(
      false,
    );
    utimesSync(root, OLD, OLD);
    return root;
  }

  it("legacy survivor.json with no bootId key: stays readable, but on Linux nothing is probed, signalled or held", () => {
    const root = persistedLegacy();
    const groupGone = spyOn({ f: (_r: unknown) => true }, "f");
    const scan = spyOn({ f: (_t: unknown) => ({ pids: [], unknown: [] }) as EscapeScan }, "f");
    const heldAlive = spyOn({ f: (_p: unknown) => true }, "f");
    const logs = quiet();
    try {
      restart();
      expect(
        sweep({
          anotherBoot: onBoot("boot-B"),
          groupGone: groupGone as never,
          scan: scan as never,
          heldAlive: heldAlive as never,
        }),
      ).toBe(1);
      expect(groupGone).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(heldAlive).not.toHaveBeenCalled();
      expect(groupSurvivorOf(root)).toBeUndefined();
      expect(unknownHoldCount()).toBe(0);
      expect(existsSync(root)).toBe(false);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("legacy survivor.json off Linux (no boot id exists to compare) is still a survivor, probed with its recorded start time", () => {
    const root = persistedLegacy();
    const logs = quiet();
    try {
      restart();
      const asked: Array<{ pid: number; startMs: number | null }> = [];
      expect(
        sweep({
          anotherBoot: (recorded) =>
            recordedOnAnotherBoot(recorded, { platform: "darwin", bootId: () => "boot-B" }),
          groupGone: (r) => {
            asked.push({ pid: r.pid, startMs: r.startMs });
            return false;
          },
          scan: () => ({ pids: [], unknown: [] }) as EscapeScan,
          heldAlive: () => true,
        }),
      ).toBe(0);
      expect(asked).toEqual([{ pid: 4242, startMs: selfStart }]);
      expect(groupSurvivorOf(root)).toBe(4242);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("a legacy owner file with no bootId key is a dead owner on Linux, however live its pid", () => {
    const { bootId: _dropped, ...legacy } = live();
    const owner = legacy as OwnerRecord; // the key is absent, not set to undefined
    expect(isOwnerDead(owner, { anotherBoot: onBoot("boot-B") })).toBe(true);
  });

  it("writes the boot id into the owner file and into survivor.json", () => {
    const cwd = createUntrustedTempCwd();
    const root = createUntrustedConfigRoot([cwd]);
    try {
      // null off Linux (nothing to compare), the kernel's id on Linux. Either way the key is
      // there: on a plain Mac run both sides are null, so `toBe` alone cannot see it missing.
      const owner = readOwnerFile(root);
      expect(typeof owner).toBe("object");
      const rawOwner = JSON.parse(readFileSync(join(root, ONESHOT_OWNER_FILE), "utf8"));
      expect("bootId" in rawOwner).toBe(true);
      expect((owner as OwnerRecord).bootId).toBe(currentBootId());
      markGroupSurvivor(root, 4242, { startMs: 7, cwds: [cwd] });
      const record = JSON.parse(readFileSync(join(root, ONESHOT_SURVIVOR_FILE), "utf8"));
      expect("bootId" in record).toBe(true);
      expect(record.bootId).toBe(currentBootId());
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
