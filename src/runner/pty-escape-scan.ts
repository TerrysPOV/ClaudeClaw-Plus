/**
 * Descendants of an untrusted claude that left its process group (a `setsid()` or `setpgid()`
 * helper, a daemonised git) escape both the leader check and the group check of pty-group-kill.
 * On Linux they are found by what they inherited: the throwaway `CLAUDE_CONFIG_DIR=<root>` in
 * their environment, or a cwd inside the throwaway temp cwd (#570 r13, C).
 *
 * macOS has no cheap equivalent (`ps eww` shows the environment of other processes only
 * partially and not at all for hardened binaries). There, containment is the process group plus
 * the remove-and-recheck loop of `removeUntrustedConfigRoot`; a process that leaves the group
 * and keeps writing is not stopped. This is a narrowed guarantee, recorded in the #570 report.
 *
 * Only pids and counts are ever returned or logged. An environment is read into memory, compared
 * with one exact entry and dropped.
 *
 * Which processes can be ours (#570 r14b): only those born after the PTY leader was spawned, read
 * from field 22 of `/proc/<pid>/stat`, which stays world-readable even for a non-dumpable process.
 * An older process of our uid (a CI runner's helpers, the shell the daemon was started from) is
 * foreign whether or not it can be read. Of the rest, one whose `environ` AND `cwd` both cannot be
 * read is "unknown": it is reported with its pid and start time so the caller keeps the root
 * while it lives, but it is not a positive match and does not fail the call.
 */

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { isSignalablePid } from "./pty-group-kill.js";
import { type StartMsReader, sameStart, procStartMs, processStartMs } from "./pty-proc-identity.js";

export interface EscapeScanTarget {
  /** The throwaway `CLAUDE_CONFIG_DIR`. Null: look only at working directories. */
  root: string | null;
  /** The throwaway cwd, in every form claude may see it (as given and resolved). */
  cwds: string[];
  /**
   * The PTY leader's start time recorded at spawn (same units as `/proc/<pid>/stat` field 22).
   * A process that started before it cannot be ours and is skipped. Null/undefined: not known,
   * so nothing is skipped on age.
   */
  leaderStartMs?: number | null;
}

export interface EscapeScanOptions {
  /** `/proc`; replaced by a fake tree in tests. */
  procDir?: string;
  /** Never reported: the daemon itself. */
  selfPid?: number;
  /** Replaces `process.getuid()`: only processes owned by this uid are ours to read. */
  uid?: number;
}

/**
 * A process born after the leader, of our uid, whose `environ` and `cwd` both could not be read:
 * it may be an escapee we cannot see. Metadata only (#570 r14b).
 */
export interface UnknownProc {
  pid: number;
  /** Its start time from `/proc/<pid>/stat`, to tell it from a process that later reuses the pid. */
  startMs: number | null;
  envErrno: string;
  cwdErrno: string;
  /** Whether the daemon is among its ancestors (an escapee that called `setsid()` is not). */
  descendant: boolean;
  /** How long after the leader it started, in ms; null when either time is unknown. */
  ageMs: number | null;
}

/**
 * What one pass over `/proc` found: the processes that positively match (`pids`), and the ones
 * that might (`unknown`). An empty `pids` with a non-empty `unknown` is not "nothing escaped".
 */
export interface EscapeScan {
  pids: number[];
  unknown: UnknownProc[];
}

const isLinuxProc = (procDir: string): boolean =>
  process.platform === "linux" || procDir !== "/proc";

/** True when `environ` (NUL-separated `KEY=value` entries) holds exactly `CLAUDE_CONFIG_DIR=<root>`. */
function environHasRoot(environ: Buffer, root: string | null): boolean {
  if (root === null) return false;
  const wanted = `CLAUDE_CONFIG_DIR=${root}`;
  for (const entry of environ.toString("utf8").split("\0")) {
    if (entry === wanted) return true;
  }
  return false;
}

function cwdInside(cwd: string, cwds: readonly string[]): boolean {
  return cwds.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`));
}

const isGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
};

const errnoOf = (error: unknown): string =>
  String((error as NodeJS.ErrnoException)?.code ?? "error").replace(/[^A-Za-z0-9_]/g, "");

/** True when `selfPid` is among the ancestors of `pid`, read from field 4 of each `stat`. */
function descendsFrom(pid: number, selfPid: number, procDir: string): boolean {
  let current = pid;
  for (let hops = 0; hops < 64 && current > 1; hops++) {
    try {
      const stat = readFileSync(`${procDir}/${current}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!Number.isInteger(parent)) return false;
      if (parent === selfPid) return true;
      current = parent;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Pids of live processes that carry this call's config root in their environment or run inside
 * its temp cwd; nothing where `/proc` is not available. Fails closed where it can: a `/proc`
 * that cannot be listed throws. Processes of other uids and processes that started before the
 * leader are skipped (see the header). A process of ours, born after the leader, whose
 * environment and cwd BOTH fail for any reason but its having gone (ENOENT, ESRCH) is `unknown`;
 * if only one of the two fails, the other decides.
 */
export function findEscapees(
  { root, cwds, leaderStartMs = null }: EscapeScanTarget,
  { procDir = "/proc", selfPid = process.pid, uid = process.getuid?.() }: EscapeScanOptions = {},
): EscapeScan {
  const found: number[] = [];
  const unknown: UnknownProc[] = [];
  if (!isLinuxProc(procDir)) return { pids: found, unknown };
  const names = readdirSync(procDir); // a throw here is "could not look": not an empty answer
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || !isSignalablePid(pid)) continue;
    try {
      if (uid !== undefined && statSync(`${procDir}/${name}`).uid !== uid) continue;
    } catch (error) {
      if (!isGone(error)) {
        unknown.push({
          pid,
          startMs: procStartMs(pid, procDir),
          envErrno: "-",
          cwdErrno: errnoOf(error),
          descendant: false,
          ageMs: null,
        }); // cannot even say whose it is
      }
      continue;
    }
    const startMs = procStartMs(pid, procDir);
    if (leaderStartMs !== null && startMs !== null && startMs < leaderStartMs) continue; // older than the leader: foreign
    let matched = false;
    let envError: unknown;
    let cwdError: unknown;
    try {
      matched = environHasRoot(readFileSync(`${procDir}/${name}/environ`), root);
    } catch (error) {
      if (!isGone(error)) envError = error;
    }
    if (!matched) {
      try {
        matched = cwdInside(readlinkSync(`${procDir}/${name}/cwd`), cwds);
      } catch (error) {
        if (!isGone(error)) cwdError = error;
      }
    }
    if (matched) found.push(pid);
    else if (envError !== undefined && cwdError !== undefined) {
      unknown.push({
        pid,
        startMs,
        envErrno: errnoOf(envError),
        cwdErrno: errnoOf(cwdError),
        descendant: descendsFrom(pid, selfPid, procDir),
        ageMs: leaderStartMs !== null && startMs !== null ? startMs - leaderStartMs : null,
      });
    }
  }
  return { pids: found, unknown };
}

export interface EscapeKillOptions extends EscapeScanOptions {
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  startMs?: StartMsReader;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  /**
   * Told, once, about the processes the final scan could not read (see `UnknownProc`). They are
   * not a failure of this call: the caller keeps the root while they live.
   */
  onUnknown?: (unknown: UnknownProc[]) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop every escapee of `target`: SIGTERM, then SIGKILL after `termGraceMs`, polling until the
 * scan comes back empty. A pid is signalled only while its start time is still the one read when
 * it was found, so a pid reused between the scan and the signal is left alone. Resolves the pids
 * still found after SIGKILL, or whose identity could not be checked; `[]` means none remain.
 * Processes that could not be read go to `onUnknown` and do not count as escapees. Throws when
 * `/proc` cannot be listed: "nothing found" is then not an answer.
 */
export async function terminateEscapees(
  target: EscapeScanTarget,
  opts: EscapeKillOptions = {},
): Promise<number[]> {
  const {
    signal = process.kill,
    sleep = defaultSleep,
    startMs = processStartMs,
    termGraceMs = 2000,
    killGraceMs = 2000,
    pollMs = 20,
    onUnknown,
  } = opts;
  const finish = (scan: EscapeScan): number[] => {
    if (scan.unknown.length > 0) onUnknown?.(scan.unknown);
    return scan.pids;
  };
  const first = findEscapees(target, opts);
  if (first.pids.length === 0) return finish(first);

  // The identity of each pid, fixed the moment it was found.
  const born = new Map(first.pids.map((pid) => [pid, startMs(pid)] as const));
  const sameProcess = (pid: number): boolean => {
    const then = born.get(pid) ?? null;
    const now = startMs(pid);
    return then !== null && now !== null && sameStart(now, then);
  };
  const send = (name: NodeJS.Signals): void => {
    for (const pid of findEscapees(target, opts).pids) {
      // A pid first seen now has no recorded identity: it is recorded, and signalled next round.
      if (!born.has(pid)) {
        born.set(pid, startMs(pid));
        continue;
      }
      if (!sameProcess(pid)) continue;
      try {
        signal(pid, name);
      } catch {
        /* gone */
      }
    }
  };
  const remaining = async (budgetMs: number): Promise<EscapeScan> => {
    for (let waited = 0; ; waited += pollMs) {
      const left = findEscapees(target, opts);
      if (left.pids.length === 0 || waited >= budgetMs) return left;
      await sleep(pollMs);
    }
  };

  send("SIGTERM");
  const afterTerm = await remaining(termGraceMs);
  if (afterTerm.pids.length === 0) return finish(afterTerm);
  send("SIGKILL");
  return finish(await remaining(killGraceMs));
}
