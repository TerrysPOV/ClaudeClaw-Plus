/**
 * Is this pid still the process we recorded? A pid is reused once its process has been reaped,
 * so a signal sent to a remembered pid can hit a stranger. Everything that signals an untrusted
 * claude (pty-group-kill, the escapee scan, the sweeper's survivor retry) checks the start time
 * recorded at spawn first (#570 r13, B), and again immediately before each signal (r14, B).
 *
 * This narrows pid reuse to a very small window; it cannot close it. Between the check and the
 * `kill()` the process can still exit and its pid be reused, and only a native process handle
 * (a pidfd) would make "check and signal" one step. Node and Bun offer none, and none is built
 * here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** `ps -o lstart=` has 1 s resolution, so two readings of one process can differ by a second. */
export const START_TIME_TOLERANCE_MS = 2000;

export type StartMsReader = (pid: number) => number | null;

/** Clock ticks per second of `/proc/<pid>/stat` times. 100 on every Linux build in use. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/**
 * Do two start times, read by `processStartMs`, belong to one process? On Linux they come from
 * `/proc` (ticks * 10 ms), so two reads of one process are identical and a different process in
 * the next tick differs by 10: they compare exactly, and any window only lets a recycled pid read
 * as the same process (#570 r14e, H1). Elsewhere they come from `ps -o lstart=`, which has 1 s
 * resolution, and the window is `START_TIME_TOLERANCE_MS`. Every comparison of a recorded start
 * time with a fresh reading goes through here.
 */
export function sameStart(a: number, b: number, platform: string = process.platform): boolean {
  if (platform === "linux") return a === b;
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}

/**
 * Linux: the start time from field 22 of `/proc/<pid>/stat` (ticks since boot), in ms since boot.
 * A wall-clock step moves `ps -o lstart=` but not this. The value restarts from zero at every
 * boot, so it is only comparable with another read on the same boot. A recorded start time that
 * outlives the daemon (an owner file, `survivor.json`) can be read again after a reboot, so it
 * is stored with the boot id and compared only when that matches (`recordedOnAnotherBoot`,
 * #570 r15, A1). Null when the stat cannot be read or parsed. `comm` (field 2) may hold spaces
 * and parens, so fields are split after the last `)`, where field 3 is the first.
 */
export function procStartMs(pid: number, procDir = "/proc"): number | null {
  try {
    const stat = readFileSync(`${procDir}/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]); // field 22 is index 19 after field 3
    return Number.isFinite(ticks) ? (ticks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND : null;
  } catch {
    return null;
  }
}

/**
 * Start time of `pid`, or null when it cannot be read. Linux: `/proc` (monotonic, 10 ms
 * resolution). Elsewhere: `ps -o lstart=` (1 s resolution).
 */
export function processStartMs(pid: number): number | null {
  if (process.platform === "linux") return procStartMs(pid);
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (out.status !== 0) return null;
    const ms = Date.parse(out.stdout.trim());
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

export type BootIdReader = () => string | null;

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** The boot id the test-only Linux switch reports (`linuxUnderTest`). */
export const TEST_BOOT_ID = "00000000-test-boot-id";

/**
 * Test-only switch: `CLAUDECLAW_TEST_PLATFORM=linux` under `bun test` (NODE_ENV=test) makes the
 * boot-id seam defaults below behave as on Linux with a fixed boot id, so the Linux path of the
 * sweep and survivor suites runs on a Mac (#570 r15b). It touches nothing else: `/proc` reads and
 * `sameStart` keep the real platform. Outside a test run it is never read as set.
 */
function linuxUnderTest(): boolean {
  return process.env.NODE_ENV === "test" && process.env.CLAUDECLAW_TEST_PLATFORM === "linux";
}

function bootIdPlatform(): string {
  return linuxUnderTest() ? "linux" : process.platform;
}

/**
 * Linux: the kernel's id for this boot, fixed until the next one. (Not `btime` from `/proc/stat`,
 * which can drift between reads.) Null when it cannot be read.
 */
export function readBootId(path?: string): string | null {
  if (path === undefined && linuxUnderTest()) return TEST_BOOT_ID;
  try {
    const id = readFileSync(path ?? BOOT_ID_PATH, "utf8").trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/** The id to store beside a start time that outlives this process: Linux only, null elsewhere. */
export function currentBootId(platform: string = bootIdPlatform()): string | null {
  return platform === "linux" ? readBootId() : null;
}

/**
 * Was a persisted start time recorded on a boot other than this one? Then no process it names
 * can be alive: every one of them is gone, and nothing may be signalled on its account. Only
 * Linux needs this (its start times count from boot; macOS `ps lstart` is epoch time). A
 * Linux record with no boot id predates the field and is treated as another boot's. When this
 * boot's id cannot be read the answer is no: nothing can be shown to differ.
 */
export function recordedOnAnotherBoot(
  recorded: string | null | undefined,
  {
    platform = bootIdPlatform(),
    bootId = readBootId,
  }: { platform?: string; bootId?: BootIdReader } = {},
): boolean {
  if (platform !== "linux") return false;
  const now = bootId();
  if (now === null) return false;
  return recorded == null || recorded !== now;
}

/** A reader that asks `ps` once per pid: for one sweep pass, which looks at the same pid several times. */
export function cachedStartMs(read: StartMsReader = processStartMs): StartMsReader {
  const seen = new Map<number, number | null>();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, read(pid));
    return seen.get(pid) ?? null;
  };
}

/**
 * What a recorded pid is now: the process we recorded (`same`), nothing (`gone`), another
 * process that was given the pid after ours was reaped (`recycled`), or a pid that exists while
 * either start time is unknown (`unknown`: it cannot be told from a stranger).
 */
export type PidIdentity = "same" | "gone" | "recycled" | "unknown";

export function pidIdentity(
  pid: number,
  expectedStartMs: number | null | undefined,
  { exists, read }: { exists: (pid: number) => boolean; read: StartMsReader },
): PidIdentity {
  if (!exists(pid)) return "gone";
  const now = read(pid);
  if (expectedStartMs == null || now === null) return "unknown";
  return sameStart(now, expectedStartMs) ? "same" : "recycled";
}
