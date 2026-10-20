/**
 * Stop a PTY child and everything it started, and prove it.
 *
 * bun-pty's `kill()` is not a proof of death: it returns at once when it has already run,
 * otherwise it closes the master side, fires `onExit` synchronously with exit code 0 and
 * returns. So an awaited exit event only means "we asked", the SIGKILL escalation after it
 * is a no-op, and a descendant of claude (a git clone, a helper that ignores SIGHUP) is never
 * signalled at all (#570 r12, Codex HIGH).
 *
 * The PTY child is a session leader, so its process group id equals its pid (checked on
 * macOS and Linux, see the r12 section of the #570 report). Signalling `-pid` therefore
 * reaches the whole tree that did not leave the group, and `kill(-pid, 0)` answers whether
 * any of it is left.
 */

import { readFileSync, readdirSync } from "node:fs";
import { type StartMsReader, pidIdentity, processStartMs } from "./pty-proc-identity.js";

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * Why a retired child is recorded as a survivor, so the call's failure says what happened:
 * its process group was still alive, a process outside the group was, the escape scan could not
 * say, or the disposal itself rejected.
 */
export type SurvivorCause = "group" | "escapee" | "scan-unknown" | "dispose-rejected";

export interface GroupTerminationOptions {
  /** `process.kill`. Replaced in tests. */
  signal?: SignalFn;
  sleep?: (ms: number) => Promise<void>;
  /** How long after SIGTERM the group may take to disappear before SIGKILL. */
  termGraceMs?: number;
  /** How long after SIGKILL the group may take to disappear before the call fails. */
  killGraceMs?: number;
  pollMs?: number;
  /**
   * Live (non-zombie) members of the group; 0 only on positive evidence that every member is a
   * zombie; undefined when this platform cannot say or cannot see every member.
   */
  liveMembers?: (pid: number) => number | undefined;
  /** The leader's start time, recorded at spawn. Null/undefined: it could not be read. */
  leaderStartMs?: number | null;
  /** Reads a pid's start time. Replaced in tests. */
  startMs?: StartMsReader;
  /**
   * Whether the PTY still owns the leader (it has not exited and been reaped), so its pid cannot
   * have been reused. Default false: once the child is gone only `-pid` is signalled, and only
   * while the group still has a member.
   */
  leaderAlive?: () => boolean;
  /**
   * This is the first termination of a call, run while the call disposes its own PTY: the leader
   * was spawned moments ago, so a group that has a member is ours even when no start time could
   * be recorded for it. Only then may `-pid` be signalled for an unrecorded start time. A retry
   * of a survivor minutes later, or the sweeper, leaves it unset: by then group membership no
   * longer proves the group is ours, and nothing is signalled without a recorded start time
   * (#570 r14d, H2). Passed by the caller; never inferred from timing here.
   */
  firstTermination?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A pid that can be signalled as `-pid` without reaching init, our own group or every process. */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

/** `kill(target, 0)`: ESRCH is the only proof of absence. EPERM means it exists. */
function exists(signal: SignalFn, target: number): boolean {
  try {
    signal(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Linux only: how many members of group `pid` are not zombies, read from `/proc/<n>/stat`
 * (`pid (comm) state ppid pgrp ...`; comm may hold spaces and parens, so split after the last
 * `)`). `kill(pid, 0)` and `kill(-pid, 0)` also succeed for a zombie nobody has reaped yet, which
 * must not read as a survivor. A positive count is returned as soon as a live member is seen.
 * Zero needs positive evidence: at least one member, and every one of them `Z` or `X`. A stat
 * that cannot be read for any reason but its process having gone (a permissions error, say) is a
 * member we could not see, so the answer is then undefined, not zero (#570 r13, D). Undefined
 * off Linux or when `/proc` cannot be read.
 */
export function procLiveMembers(pid: number, procDir = "/proc"): number | undefined {
  if (process.platform !== "linux" && procDir === "/proc") return undefined;
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return undefined;
  }
  let live = 0;
  let zombies = 0;
  let unseen = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procDir}/${name}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") unseen++; // gone between readdir and read: not unseen
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if (Number(name) !== pid && pgrp !== pid) continue;
    if (state === "Z" || state === "X") zombies++;
    else live++;
  }
  if (live > 0) return live;
  return unseen === 0 && zombies > 0 ? 0 : undefined;
}

/** Both the leader and its group are gone (a zombie that is only waiting to be reaped is gone). */
export function processGroupGone(
  pid: number,
  signal: SignalFn = process.kill,
  liveMembers: (pid: number) => number | undefined = procLiveMembers,
): boolean {
  if (!exists(signal, pid) && !exists(signal, -pid)) return true;
  return liveMembers(pid) === 0;
}

/**
 * `kill(2)` with the zero-signal answers made safe against pid reuse. Everything here reads the
 * leader's identity first (#570 r13, B): a pid that now belongs to a process with another start
 * time is a stranger, and neither it nor `-pid` is touched (a process group id cannot be
 * reused while the group has a member, so a recycled leader means the group is long gone).
 * The identity is read again immediately before every signal (r14, B). That narrows pid reuse to
 * the instant between the read and the `kill()`; it cannot close it without a native process
 * handle, which is not built here (see pty-proc-identity).
 */
class GroupTarget {
  private readonly leaderStartMs: number | null;
  private readonly read: StartMsReader;
  private readonly owned: () => boolean;
  private readonly firstTermination: boolean;
  private loggedUnreadable = false;

  constructor(
    private readonly pid: number,
    private readonly signal: SignalFn,
    private readonly liveMembers: (pid: number) => number | undefined,
    opts: GroupTerminationOptions,
  ) {
    this.leaderStartMs = opts.leaderStartMs ?? null;
    this.read = opts.startMs ?? processStartMs;
    this.owned = opts.leaderAlive ?? (() => false);
    this.firstTermination = opts.firstTermination === true;
  }

  identity() {
    return pidIdentity(this.pid, this.leaderStartMs, {
      exists: (p) => exists(this.signal, p),
      read: this.read,
    });
  }

  private polls = 0;

  /**
   * Both the leader and its group are gone, or the pid is no longer ours to ask about. The start
   * time is read on the first poll and then every tenth, not every one: it costs a `ps` spawn,
   * and a pid is not reused within 20 ms of being asked about.
   */
  gone(): boolean {
    if (this.polls++ % 10 === 0 && this.identity() === "recycled") return true;
    return processGroupGone(this.pid, this.signal, this.liveMembers);
  }

  /**
   * Signal what is provably ours, the group first. Once the group has been signalled the bare pid
   * is not: the leader is a member of its own group, so a second signal adds nothing and would be
   * one more chance to hit a reused pid. The bare pid is signalled only when the group could not
   * be (a leader that moved itself out of its group), while the PTY still owns it.
   */
  send(name: NodeJS.Signals): void {
    if (this.sendGroup(name)) return;
    this.sendBare(name);
  }

  /** `-pid`, while the group has a member and the leader is not a stranger. True when it was sent. */
  private sendGroup(name: NodeJS.Signals): boolean {
    const identity = this.identity(); // read now, not earlier: this is the last look before kill()
    if (identity === "recycled") return false;
    // A start time that was never recorded cannot tell a stranger from the leader. During the
    // first termination of a call the leader was spawned moments ago, and a process group id
    // cannot be reused while the group has a member, so `-pid` is ours while `kill(-pid, 0)`
    // shows one (#570 r14, B). A later retry has no such proof and signals nothing (r14d, H2).
    const unrecordedOk = this.leaderStartMs === null && this.firstTermination;
    if (identity === "unknown" && unrecordedOk && !this.loggedUnreadable) {
      this.loggedUnreadable = true;
      console.warn(
        `[pty-group-kill] start time of pid ${this.pid} was not recorded; signalling its group on group membership alone`,
      );
    }
    // `gone` is read before the recorded start time is looked at, so it says only that the leader
    // pid is absent. A live `-pid` group beside an absent leader is ours only if we recorded the
    // leader, or this is the first termination (r14e, H2).
    const known =
      identity === "same" ||
      (identity === "gone" && (this.leaderStartMs !== null || unrecordedOk)) ||
      (identity === "unknown" && (this.owned() || unrecordedOk));
    if (!known || !exists(this.signal, -this.pid)) return false;
    try {
      this.signal(-this.pid, name);
      return true;
    } catch {
      return false; // ESRCH: nothing there to signal
    }
  }

  private sendBare(name: NodeJS.Signals): void {
    const identity = this.identity();
    if (!this.owned() || (identity !== "same" && identity !== "unknown")) return;
    try {
      this.signal(this.pid, name);
    } catch {
      /* ESRCH: nothing there to signal */
    }
  }
}

/**
 * Whether the group of `pid` (and its leader) is gone right now, by the same rules as the
 * termination: a recycled leader means the group is long gone, a group made only of zombies is
 * gone. For a caller that has to decide on a recorded survivor without signalling it (the sweep).
 */
export function groupGoneNow(pid: number, opts: GroupTerminationOptions = {}): boolean {
  const { signal = process.kill, liveMembers = procLiveMembers } = opts;
  if (!isSignalablePid(pid)) return false; // not a pid to reason about: not proof of absence
  return new GroupTarget(pid, signal, liveMembers, opts).gone();
}

/**
 * SIGTERM the group, wait for the leader and the group to disappear, escalate to SIGKILL after
 * `termGraceMs`, wait again for up to `killGraceMs`. Resolves true only when both `kill(pid, 0)`
 * and `kill(-pid, 0)` have answered ESRCH (or the pid was reused, so the group is gone). Resolves
 * false when something outlived SIGKILL, or when the pid is not one that may be signalled.
 * Before every signal, the escalation included, the leader's start time is checked against
 * `leaderStartMs`, so a pid that was reaped and reused in the meantime is never signalled.
 */
export async function terminateProcessGroup(
  pid: number,
  opts: GroupTerminationOptions = {},
): Promise<boolean> {
  const {
    signal = process.kill,
    sleep = defaultSleep,
    termGraceMs = 2000,
    killGraceMs = 2000,
    pollMs = 20,
    liveMembers = procLiveMembers,
  } = opts;
  if (!isSignalablePid(pid)) return false;
  const target = new GroupTarget(pid, signal, liveMembers, opts);

  const waitGone = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; ; waited += pollMs) {
      if (target.gone()) return true;
      if (waited >= budgetMs) return false;
      await sleep(pollMs);
    }
  };

  target.send("SIGTERM");
  if (await waitGone(termGraceMs)) return true;
  target.send("SIGKILL");
  return waitGone(killGraceMs);
}
