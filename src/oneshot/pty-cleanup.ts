import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types.js";
import {
  type EscapeScan,
  type EscapeScanTarget,
  type UnknownProc,
  findEscapees,
  terminateEscapees,
} from "../runner/pty-escape-scan.js";
import {
  type GroupTerminationOptions,
  type SurvivorCause,
  groupGoneNow,
  isSignalablePid,
  terminateProcessGroup,
} from "../runner/pty-group-kill.js";
import {
  type StartMsReader,
  cachedStartMs,
  currentBootId,
  processStartMs,
  recordedOnAnotherBoot,
  sameStart,
} from "../runner/pty-proc-identity.js";

export { processStartMs };

/**
 * An untrusted PTY one-shot writes nothing about the call under the operator's Claude config
 * root. Each call gets its own throwaway `CLAUDE_CONFIG_DIR`, so everything an interactive
 * claude writes about the prompt (transcript, history, paste cache, session files) lands
 * there and goes with it.
 * Credentials are not copied: `CLAUDE_SECURESTORAGE_CONFIG_DIR` points claude at the
 * operator's own credential store (read out of claude 2.1.304; see the spike doc).
 *
 * The only write outside the throwaway root is claude's own credential refresh into the
 * operator's credential store: claude refreshing the operator's own OAuth token, with no
 * prompt data in it. It is accepted. Its lock is `<credential dir>/.oauth_refresh.lock`, the one
 * the daemon's own claude takes, not a file under the throwaway root (spike doc, r12).
 */

/** Prefix of the per-call throwaway config root, a sibling of the temp cwd. */
export const ONESHOT_CONFIG_PREFIX = "claudeclaw-oneshot-cfg-";
/** Prefix of the per-call temp cwd. */
export const ONESHOT_CWD_PREFIX = "claudeclaw-oneshot-pty-";

/** Leftovers older than this are removed at daemon start, and by the sweep every `ONESHOT_SWEEP_INTERVAL_MS` after it. */
export const ONESHOT_SWEEP_MAX_AGE_MS = 10 * 60_000;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * The directory claude should read credentials from, so the throwaway config root
 * authenticates as the operator does. An explicit `CLAUDE_SECURESTORAGE_CONFIG_DIR` in the
 * caller's env is passed through as given. Otherwise it is the operator's
 * `CLAUDE_CONFIG_DIR`, or `""` when that is unset or empty: `""` means the default
 * (`~/.claude`, and the unsuffixed keychain service name on macOS). A relative directory
 * would resolve against whatever cwd the caller has, so it fails closed before any spawn.
 *
 * `env` is the child's env after the caller's policy (print's override replaces the whole
 * env, so it can lack the operator's `CLAUDE_CONFIG_DIR`); `daemonEnv` is the daemon's own,
 * consulted for what the policy env does not name. Without it an operator with a custom
 * config root would be sent to the default store.
 */
export function operatorSecureStorageDir(
  env: Record<string, string | undefined>,
  daemonEnv: Record<string, string | undefined> = {},
): string {
  const explicit = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? daemonEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir =
    explicit !== undefined
      ? explicit
      : (nonEmpty(env.CLAUDE_CONFIG_DIR) ?? nonEmpty(daemonEnv.CLAUDE_CONFIG_DIR) ?? "");
  if (dir !== "" && !isAbsolute(dir)) {
    throw new Error("untrusted PTY one-shot requires an absolute Claude config root");
  }
  return dir;
}

/** The cwd as given and as resolved: claude may record either. */
export function untrustedCwdForms(cwd: string): string[] {
  const forms = new Set([cwd]);
  try {
    forms.add(realpathSync(cwd));
  } catch {
    /* already gone */
  }
  return [...forms];
}

/** Where an interactive claude with this config root keeps the transcripts of `cwd`. */
export function untrustedPtyProjectDir(cwd: string, configRoot: string): string {
  return join(configRoot, "projects", encodeCwdForProjectsDir(realpathSync(cwd)));
}

/** Written into every root and temp cwd when it is created, so a sweep can tell a live call from a leftover. */
export const ONESHOT_OWNER_FILE = ".oneshot-owner.json";

/** Distinguishes this daemon run from an earlier one that had the same pid. */
export const DAEMON_INSTANCE = randomUUID();

export interface OwnerRecord {
  pid: number;
  /**
   * When the owner process started, from `processStartMs`: epoch ms off Linux, ms since boot on
   * Linux (so only comparable under the same `bootId`). Null when it could not be read.
   */
  startMs: number | null;
  instance: string;
  /** Linux boot id the start time was read on; null off Linux, or when unreadable. */
  bootId?: string | null;
}

let selfOwner: OwnerRecord | undefined;
function selfOwnerRecord(): OwnerRecord {
  selfOwner ??= {
    pid: process.pid,
    startMs: processStartMs(process.pid),
    instance: DAEMON_INSTANCE,
    bootId: currentBootId(),
  };
  return selfOwner;
}

/** Record this daemon as the owner of `dir`. Throws if it cannot be written. */
export function writeOwnerFile(dir: string): void {
  writeFileSync(join(dir, ONESHOT_OWNER_FILE), `${JSON.stringify(selfOwnerRecord())}\n`, {
    mode: 0o600,
  });
}

/**
 * What a directory's owner file says: a record, `missing` (no such file: a directory made before
 * the owner file existed), or `unreadable` (the file is there but cannot be read or understood).
 * The two must not be confused: a leftover with no owner file is swept by age, but one whose
 * owner file is damaged may belong to a live call, so it is quarantined (#570 r13, A).
 */
export type OwnerFile = OwnerRecord | "missing" | "unreadable";

export function readOwnerFile(dir: string): OwnerFile {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ONESHOT_OWNER_FILE), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as OwnerRecord;
    if (!Number.isInteger(parsed.pid) || typeof parsed.instance !== "string") return "unreadable";
    return {
      pid: parsed.pid,
      startMs: typeof parsed.startMs === "number" ? parsed.startMs : null,
      instance: parsed.instance,
      bootId: typeof parsed.bootId === "string" ? parsed.bootId : null,
    };
  } catch {
    return "unreadable";
  }
}

/** Calls of this daemon that have not finished: their directories are never swept. */
const activeDirs = new Set<string>();
export function markOneShotDirActive(dir: string): void {
  activeDirs.add(dir);
}
export function releaseOneShotDir(dir: string): void {
  activeDirs.delete(dir);
}
/** Test seam: how many directories of unfinished calls are registered. */
export function activeOneShotDirCount(): number {
  return activeDirs.size;
}

/**
 * Untrusted PTY one-shots that may run at once. In-process, not a setting: each is an interactive
 * claude, and the ephemeral scope sits outside the supervisor's `maxConcurrent`. Over it a call
 * returns `busy` without spawning (the classifier treats that like any other failure: null, no
 * retry). A slot stays counted while a survivor or an unknown hold stands for its call. #570 r15, A4.
 */
export const UNTRUSTED_ONESHOT_MAX_CONCURRENT = 2;

/**
 * How long a call that returned its deadline while its claude was still being admitted waits on
 * that claude's retirement before saying so. The slot is NOT freed at the ceiling: a claude that
 * has not been confirmed retired may still be running, and freeing its reservation would let the
 * next calls start beside it. The ceiling only logs, once, that the slot is held past it. #570 r15e.
 */
export const UNTRUSTED_LATE_SLOT_CEILING_MS = 60_000;
let lateSlotCeilingMs = UNTRUSTED_LATE_SLOT_CEILING_MS;
/** Test seam: shorten the late-slot ceiling (the test preload does). `null` restores it. */
export function setLateSlotCeilingMsForTests(ms: number | null): void {
  lateSlotCeilingMs = ms ?? UNTRUSTED_LATE_SLOT_CEILING_MS;
}
/** Test seam: the ceiling in force, so a test that changes it can put it back. */
export function lateSlotCeilingMsForTests(): number {
  return lateSlotCeilingMs;
}

let untrustedInFlight = 0;
/** Bumped by `resetUntrustedSlotsForTests`: a reservation from an earlier epoch no longer counts. */
let slotEpoch = 0;
/** Test seam: how many untrusted one-shots hold a slot. */
export function untrustedOneShotsInFlight(): number {
  return untrustedInFlight;
}

/**
 * Slots whose call has returned while a process of it may still be alive, keyed by config root:
 * a recorded survivor or an unknown hold (a process the escape scan could not read). The
 * reservation follows the child: it is released once, by `releaseIfClear`, when neither map has
 * the root any more. Not a second counter: each entry is the `free` of a reservation already
 * counted in `untrustedInFlight`.
 */
const survivorSlots = new Map<string, () => void>();

/** One counted reservation. `free` is idempotent, so a second release cannot inflate capacity. */
function reserveCount(): () => void {
  untrustedInFlight++;
  const epoch = slotEpoch;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (epoch === slotEpoch) untrustedInFlight--;
  };
}

export interface OneShotSlot {
  /** No child of this call can be alive (none spawned, or it was retired): free the slot now. Idempotent. */
  free(): void;
  /**
   * The call has returned and the slot follows its child. Waits for `retired` when a late claude
   * may still land (never freeing at the ceiling), then keeps the slot while `root` is a recorded
   * survivor or an unknown hold, and frees it otherwise.
   */
  settle(root: string, retired?: Promise<unknown>): void;
}

/** Take a slot, or `undefined` when `UNTRUSTED_ONESHOT_MAX_CONCURRENT` calls are already running. */
export function acquireUntrustedOneShotSlot(): OneShotSlot | undefined {
  if (untrustedInFlight >= UNTRUSTED_ONESHOT_MAX_CONCURRENT) return undefined;
  const free = reserveCount();
  // Transfer the reservation to the root's survivor or unknown hold, or free it when nothing of
  // the call is left. `unknownHoldActive` first: it prunes a hold whose processes are gone.
  const handOver = (root: string): void => {
    const held = unknownHoldActive(root) || survivingGroups.has(root);
    if (held && !survivorSlots.has(root)) survivorSlots.set(root, free);
    else free();
  };
  return {
    free,
    settle(root, retired) {
      if (!retired) return handOver(root);
      const ceiling = setTimeout(() => {
        console.warn("[pty-supervisor] one-shot slot held past ceiling: retirement pending");
      }, lateSlotCeilingMs);
      ceiling.unref?.();
      void retired
        .then(
          () => {},
          () => {},
        )
        .then(() => {
          clearTimeout(ceiling);
          handOver(root);
        });
    },
  };
}

/** Release the reservation that followed `root`. Once only; a root with no reservation is a no-op. */
function releaseSurvivorSlot(root: string): void {
  const free = survivorSlots.get(root);
  if (!free) return;
  survivorSlots.delete(root);
  free();
}

/**
 * The one release rule: a root's reservation is owned by it while a recorded survivor OR an
 * unknown hold stands, and is released when neither does. Called wherever either map loses its
 * entry for a root. Reads the maps, not `unknownHoldActive`: callers have just pruned.
 */
function releaseIfClear(root: string): void {
  if (survivingGroups.has(root) || unknownHolds.has(root)) return;
  releaseSurvivorSlot(root);
}

/**
 * A survivor or hold adopted from `survivor.json` after a restart counts against the cap like one
 * this run recorded, until it is confirmed gone. It may take the count past the cap: the cap only
 * refuses new calls.
 */
function reserveSurvivorSlot(root: string): void {
  if (!survivorSlots.has(root)) survivorSlots.set(root, reserveCount());
}

/** Test seam: forget every reservation, held or in flight, so a call that never settles cannot leak into the next test. */
export function resetUntrustedSlotsForTests(): void {
  slotEpoch++;
  untrustedInFlight = 0;
  survivorSlots.clear();
}

/**
 * What is needed to stop a claude that outlived its retirement, and to keep its directories safe
 * meanwhile: the leader's pid with the start time it had at spawn, the temp cwd and its forms.
 */
export interface GroupSurvivor {
  pid: number;
  /** The leader's start time at spawn, null when it could not be read. */
  startMs: number | null;
  tempCwd?: string;
  cwds: string[];
  /** Retries made by the sweeper so far. */
  retries: number;
  /** Why it is recorded: what the failed call reports. */
  cause: SurvivorCause;
}

/** Written into a survivor's config root, so a daemon restart still knows what to keep and stop. */
export const ONESHOT_SURVIVOR_FILE = "survivor.json";

/** A process the escape scan could not read: kept while it lives with the same start time. */
export interface HeldProc {
  pid: number;
  startMs: number | null;
}

interface SurvivorFileRecord {
  /** The PTY leader. Its group is checked (with `startMs`) when a restart reads this. */
  pid: number;
  startMs: number | null;
  /**
   * The Linux boot id every start time in this record was read on. A restart that finds another
   * one (or none) treats every process named here as gone and signals none (#570 r15, A1).
   */
  bootId?: string | null;
  cwds: string[];
  tempCwd?: string;
  /** Processes the scan could not read (#570 r14b); the root stays while any of them lives. */
  unknown?: HeldProc[];
}

/**
 * Roots whose claude process group could not be stopped (the root may still be written into).
 * Keyed by root path. The sweeper signals them again every pass and drops an entry only once
 * the group, and anything that left it, is gone; until then neither directory is swept.
 */
const survivingGroups = new Map<string, GroupSurvivor>();

/**
 * Roots kept only because the escape scan could not read some process born after the leader
 * (#570 r14b). Not a failure: the call returned its reply. Nothing is signalled; the sweep drops
 * the hold once none of the processes is alive with the same start time.
 */
interface UnknownHold {
  leaderPid: number;
  leaderStartMs: number | null;
  tempCwd?: string;
  cwds: string[];
  procs: HeldProc[];
}
const unknownHolds = new Map<string, UnknownHold>();
const loggedUnknown = new Set<string>();
const loggedUnrecorded = new Set<string>();

/** Persist what a restart needs next to what it protects (mode 0600). Logged, never thrown. */
function writeSurvivorFile(root: string): void {
  const survivor = survivingGroups.get(root);
  const hold = unknownHolds.get(root);
  const base = survivor
    ? {
        pid: survivor.pid,
        startMs: survivor.startMs,
        cwds: survivor.cwds,
        tempCwd: survivor.tempCwd,
      }
    : hold
      ? { pid: hold.leaderPid, startMs: hold.leaderStartMs, cwds: hold.cwds, tempCwd: hold.tempCwd }
      : undefined;
  if (!base) return;
  const record: SurvivorFileRecord = {
    ...base,
    bootId: currentBootId(),
    ...(hold ? { unknown: hold.procs } : {}),
  };
  try {
    writeFileSync(join(root, ONESHOT_SURVIVOR_FILE), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // no root: nothing for a restart to protect
    console.error(
      `[oneshot] survivor of pid ${base.pid} not persisted (${code ?? "error"}): a daemon restart will not know to keep its root`,
    );
  }
}

export function markGroupSurvivor(
  root: string,
  pid: number,
  extra: {
    startMs?: number | null;
    tempCwd?: string;
    cwds?: string[];
    cause?: SurvivorCause;
  } = {},
): void {
  const survivor: GroupSurvivor = {
    pid,
    startMs: extra.startMs ?? null,
    tempCwd: extra.tempCwd,
    cwds: extra.cwds ?? [],
    retries: survivingGroups.get(root)?.retries ?? 0,
    cause: extra.cause ?? "group",
  };
  survivingGroups.set(root, survivor);
  writeSurvivorFile(root);
}

/**
 * Keep `root` (and the temp cwd) while any of these processes lives, without failing the call.
 * Writes them into `survivor.json` for a restart. Logs metadata only, once per process: pid, the
 * errno of each read, whether it descends from the daemon, and its age relative to the leader.
 */
export function markUnknownProcs(
  root: string,
  leader: { pid: number; startMs: number | null },
  procs: readonly UnknownProc[],
  extra: { tempCwd?: string; cwds?: string[] } = {},
): void {
  if (procs.length === 0) return;
  const known = unknownHolds.get(root)?.procs ?? [];
  const merged = [...known];
  for (const proc of procs) {
    if (!merged.some((m) => m.pid === proc.pid && m.startMs === proc.startMs)) {
      merged.push({ pid: proc.pid, startMs: proc.startMs });
    }
    const key = `${root}:${proc.pid}:${proc.startMs}`;
    if (!loggedUnknown.has(key)) {
      loggedUnknown.add(key);
      console.warn(
        `[oneshot] escape scan could not read pid ${proc.pid} (environ ${proc.envErrno}, cwd ${proc.cwdErrno}, descendant of the daemon: ${proc.descendant ? "yes" : "no"}, started ${proc.ageMs === null ? "unknown" : `${proc.ageMs} ms`} after the leader); config root kept while it lives`,
      );
    }
  }
  unknownHolds.set(root, {
    leaderPid: leader.pid,
    leaderStartMs: leader.startMs,
    tempCwd: extra.tempCwd ?? unknownHolds.get(root)?.tempCwd,
    cwds: extra.cwds ?? unknownHolds.get(root)?.cwds ?? [],
    procs: merged,
  });
  writeSurvivorFile(root);
}

/** Was a persisted start time read on another boot than this one (`recordedOnAnotherBoot`)? */
type AnotherBoot = (recordedBootId: string | null | undefined) => boolean;

/**
 * The process is alive with the start time recorded for it. A dead or recycled pid is gone.
 * The caller has already established that the record was made on this boot: a Linux start time
 * from another one is not comparable (see `adoptPersistedSurvivors`).
 */
export function heldProcAlive(
  proc: HeldProc,
  deps: { kill?: (pid: number, signal: 0) => void; startMs?: StartMsReader } = {},
): boolean {
  try {
    (deps.kill ?? process.kill)(proc.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: it exists, and is not ours to signal; fall through to the identity check
  }
  const now = (deps.startMs ?? processStartMs)(proc.pid);
  if (proc.startMs === null || now === null) return true; // cannot tell: assume it is the same
  return sameStart(now, proc.startMs);
}

let heldAliveDefault: (proc: HeldProc) => boolean = (proc) => heldProcAlive(proc);
/** Test seam: replace the liveness check every hold uses unless a sweep names its own. `null` restores it. */
export function setHeldAliveForTests(check: ((proc: HeldProc) => boolean) | null): void {
  heldAliveDefault = check ?? ((proc) => heldProcAlive(proc));
}

/** Drop the dead processes of a hold, and the hold itself when none is left. True while it stands. */
function holdStands(root: string, deps: SweepDeps = {}): boolean {
  const hold = unknownHolds.get(root);
  if (!hold) return false;
  const alive = deps.heldAlive ?? heldAliveDefault;
  const procs = hold.procs.filter((p) => alive(p));
  if (procs.length === 0) {
    unknownHolds.delete(root);
    releaseIfClear(root);
    return false;
  }
  if (procs.length !== hold.procs.length) {
    unknownHolds.set(root, { ...hold, procs });
    writeSurvivorFile(root);
  }
  return true;
}

/** Whether `root` is kept only for processes the scan could not read (and that still live). */
export function unknownHoldActive(root: string): boolean {
  return holdStands(root);
}
export function groupSurvivorOf(root: string): number | undefined {
  return survivingGroups.get(root)?.pid;
}
/** Why `root` is held as a survivor, for the failure message of the call that left it. */
export function groupSurvivorCauseOf(root: string): SurvivorCause | undefined {
  return survivingGroups.get(root)?.cause;
}
/** Test seam: how many roots have an unstopped survivor. */
export function groupSurvivorCount(): number {
  return survivingGroups.size;
}
/** Test seam: how many roots are held for unreadable processes. */
export function unknownHoldCount(): number {
  return unknownHolds.size;
}
/** Test seam: forget every recorded survivor and hold. */
export function resetGroupSurvivorsForTests(): void {
  for (const root of [...survivorSlots.keys()]) releaseSurvivorSlot(root);
  survivingGroups.clear();
  unknownHolds.clear();
  loggedUnknown.clear();
  loggedUnrecorded.clear();
}
const protectedBySurvivor = (path: string, deps: SweepDeps = {}): boolean => {
  for (const [root, survivor] of survivingGroups) {
    if (root === path || survivor.tempCwd === path) return true;
  }
  for (const [root, hold] of [...unknownHolds]) {
    if ((root === path || hold.tempCwd === path) && holdStands(root, deps)) return true;
  }
  return false;
};

/** What a root's `survivor.json` says: a record, `missing`, or `unreadable` (there but not understood). */
function readSurvivorFile(root: string): SurvivorFileRecord | "missing" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(join(root, ONESHOT_SURVIVOR_FILE), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as SurvivorFileRecord;
    const cwdsOk = Array.isArray(parsed.cwds) && parsed.cwds.every((c) => typeof c === "string");
    const unknownOk =
      parsed.unknown === undefined ||
      (Array.isArray(parsed.unknown) &&
        parsed.unknown.every(
          (u) =>
            Number.isInteger(u?.pid) &&
            u.pid > 1 &&
            (u.startMs === null || typeof u.startMs === "number"),
        ));
    if (!isSignalablePid(parsed.pid) || !cwdsOk || !unknownOk) return "unreadable";
    return {
      pid: parsed.pid,
      startMs: typeof parsed.startMs === "number" ? parsed.startMs : null,
      bootId: typeof parsed.bootId === "string" ? parsed.bootId : null,
      cwds: parsed.cwds,
      tempCwd: typeof parsed.tempCwd === "string" ? parsed.tempCwd : undefined,
      ...(parsed.unknown
        ? { unknown: parsed.unknown.map((u) => ({ pid: u.pid, startMs: u.startMs })) }
        : {}),
    };
  } catch {
    return "unreadable";
  }
}

export interface SurvivorRetryDeps {
  terminate?: (pid: number, opts: GroupTerminationOptions) => Promise<boolean>;
  reap?: (target: EscapeScanTarget) => Promise<number[]>;
  startMs?: StartMsReader;
}

/**
 * Signal every recorded survivor again. Each is checked against the start time recorded at
 * spawn immediately before every signal, so a pid that was reused is not touched (narrowed to
 * the instant between the check and the kill, which only a native process handle could close); the leader is no longer
 * ours, so only its group is signalled. An entry is dropped once the group and everything that
 * left it are gone. A retry that fails is logged as metadata (pid, retry count, how many
 * processes), never paths or environment. Returns how many entries were cleared.
 */
export async function retrySurvivingGroups(deps: SurvivorRetryDeps = {}): Promise<number> {
  const terminate = deps.terminate ?? terminateProcessGroup;
  let cleared = 0;
  for (const [root, survivor] of [...survivingGroups]) {
    survivor.retries++;
    // Without a recorded start time nothing is signalled (the termination below is not told it is
    // the first): the root stays registered, and this says so once, as metadata only.
    if (survivor.startMs === null && !loggedUnrecorded.has(root)) {
      loggedUnrecorded.add(root);
      console.warn(
        `[oneshot] survivor of pid ${survivor.pid} not signalled again: start time not recorded (${basename(root)}); root kept`,
      );
    }
    try {
      // The start time is read fresh before every signal, not from the sweep pass's cache: this
      // runs seconds after the pass began, and a cached reading is how a reused pid is signalled.
      const groupGone = await terminate(survivor.pid, {
        leaderStartMs: survivor.startMs,
        startMs: deps.startMs,
        leaderAlive: () => false,
      });
      const target: EscapeScanTarget = {
        root,
        cwds: survivor.cwds,
        leaderStartMs: survivor.startMs,
      };
      // Unreadable processes are not a failure here either: they become a hold on the root.
      const escapees = await (
        deps.reap ??
        ((t: EscapeScanTarget) =>
          terminateEscapees(t, {
            onUnknown: (unknown) =>
              markUnknownProcs(root, { pid: survivor.pid, startMs: survivor.startMs }, unknown, {
                tempCwd: survivor.tempCwd,
                cwds: survivor.cwds,
              }),
          }))
      )(target);
      if (groupGone && escapees.length === 0) {
        survivingGroups.delete(root);
        releaseIfClear(root); // an unknown hold the reap just recorded keeps the slot
        cleared++;
      } else {
        console.error(
          `[oneshot] survivor of pid ${survivor.pid} still alive after retry ${survivor.retries} (group ${groupGone ? "gone" : "alive"}, ${escapees.length} outside it)`,
        );
      }
    } catch (error) {
      console.error(
        `[oneshot] survivor retry for pid ${survivor.pid} failed (${(error as NodeJS.ErrnoException)?.code ?? "error"})`,
      );
    }
  }
  // A hold is pruned here too, so the slot that follows it comes back on the timer, not only when
  // the sweep happens to look at an old directory. Nothing is signalled for a hold.
  for (const root of [...unknownHolds.keys()]) holdStands(root);
  return cleared;
}

/**
 * The owner is gone: no such pid, the pid now belongs to a process that started later, or the
 * record is from another boot (nothing it names can be running; its pid and start time are no
 * longer evidence of anything, #570 r15, A1).
 */
export function isOwnerDead(
  owner: OwnerRecord,
  deps: {
    kill?: (pid: number, signal: 0) => void;
    startMs?: (pid: number) => number | null;
    anotherBoot?: AnotherBoot;
  } = {},
): boolean {
  if (owner.instance === DAEMON_INSTANCE) return false; // this daemon; `activeDirs` decides
  if ((deps.anotherBoot ?? recordedOnAnotherBoot)(owner.bootId)) return true;
  const kill = deps.kill ?? process.kill;
  try {
    kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const now = (deps.startMs ?? processStartMs)(owner.pid);
  if (owner.startMs === null || now === null) return false; // cannot tell: assume it is the owner
  return !sameStart(now, owner.startMs);
}

/** Create the per-call temp cwd (mode 0700, owner file inside). Removed again on error. */
export function createUntrustedTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), ONESHOT_CWD_PREFIX));
  try {
    chmodSync(dir, 0o700);
    writeOwnerFile(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * Create the per-call config root (mode 0700, next to the temp cwd) with the smallest
 * `.claude.json` that gets an interactive claude to its prompt: onboarding done, and the
 * throwaway cwd trusted in both of its forms. Throws if the root cannot be written; the
 * caller fails the call before any spawn. A root that was created is removed again on error.
 */
export function createUntrustedConfigRoot(cwds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), ONESHOT_CONFIG_PREFIX));
  try {
    chmodSync(root, 0o700);
    writeOwnerFile(root);
    const projects: Record<string, unknown> = {};
    for (const cwd of cwds) {
      projects[cwd] = { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 };
    }
    writeFileSync(
      join(root, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", numStartups: 10, projects })}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_QUIET_MS = 200;
let quietMsDefault = DEFAULT_QUIET_MS;
/** Test seam: shorten the quiet wait of every removal (the test preload does). `null` restores it. */
export function setRootRemovalQuietMsForTests(ms: number | null): void {
  quietMsDefault = ms ?? DEFAULT_QUIET_MS;
}

export interface RemoveRootOptions {
  /** How long the root must stay gone before the removal counts. */
  quietMs?: number;
  /** Removal attempts before giving up. */
  maxPasses?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Remove the throwaway config root, and prove it stays removed. This is the second line of
 * defence. The first is retiring claude's whole process group and waiting for it to be gone
 * before this runs (pty-group-kill): bun-pty's kill() reports an exit it has not waited for,
 * so a dying claude or a git clone it started could write into the directory afterwards and
 * re-create it (seen live, r11 run 1). Here: remove, wait `quietMs`, look again, and repeat
 * while it comes back. Throws if it never stays gone (or the last removal failed), so a call
 * never reports an isolated success while prompt text sits on disk.
 */
export async function removeUntrustedConfigRoot(
  root: string,
  { quietMs = quietMsDefault, maxPasses = 12, sleep = defaultSleep }: RemoveRootOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let pass = 0; pass < maxPasses; pass++) {
    try {
      rmSync(root, { recursive: true, force: true });
      lastError = undefined;
    } catch (error) {
      lastError = error; // a writer added files mid-removal (ENOTEMPTY): try again
    }
    await sleep(quietMs);
    if (!existsSync(root)) return;
  }
  throw lastError ?? new Error("throwaway config root kept reappearing");
}

export interface SweepDeps {
  /** Replaces `process.getuid()`. */
  uid?: number;
  isOwnerDead?: (owner: OwnerRecord) => boolean;
  /** Replaces `ps` for the owners' start times; asked once per pid per pass. */
  startMs?: StartMsReader;
  /** Replaces the check of a recorded survivor's group (with identity). True: it is gone. */
  groupGone?: (survivor: { pid: number; startMs: number | null }) => boolean;
  /** Replaces the escape scan (Linux). May throw. */
  scan?: (target: EscapeScanTarget) => EscapeScan;
  /** Replaces the check that a held unreadable process is still alive with the same start time. */
  heldAlive?: (proc: HeldProc) => boolean;
  /** Replaces the check that a persisted record was made on another boot (Linux). */
  anotherBoot?: AnotherBoot;
}

/** A quarantined directory is considered for removal only once it is this old. */
export const ONESHOT_QUARANTINE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * True when the scan finds a process that positively matches, or throws (cannot list `/proc`).
 * Processes it could not read are not counted: a quarantined directory has no leader time to tell
 * a stranger from a candidate, and would otherwise be kept for ever on a host with any
 * non-dumpable process of our uid.
 */
function scanFindsSomething(target: EscapeScanTarget, deps: SweepDeps): boolean {
  try {
    const scan = (deps.scan ?? ((t: EscapeScanTarget) => findEscapees(t)))(target);
    return scan.pids.length > 0;
  } catch {
    return true;
  }
}

/**
 * Before anything is removed: a config root with a `survivor.json` whose group, or whose escapees,
 * may still be running goes back into the in-memory survivor map, so the timer keeps signalling it
 * and neither it nor its temp cwd is swept (#570 r14, C). A recorded process the scan could not
 * read (r14b) that is still alive with its recorded start time, or one the scan cannot read now,
 * puts the root back as a hold instead, which signals nothing. This ignores age: a restart a
 * minute after a failed disposal must not lose the record.
 */
function adoptPersistedSurvivors(
  dir: string,
  names: readonly string[],
  uid: number | undefined,
  deps: SweepDeps,
): void {
  const alive = deps.heldAlive ?? heldAliveDefault;
  for (const name of names) {
    if (!name.startsWith(ONESHOT_CONFIG_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      if (survivingGroups.has(path) || unknownHolds.has(path) || activeDirs.has(path)) continue;
      const record = readSurvivorFile(path);
      if (record === "missing" || record === "unreadable") continue; // unreadable: quarantined below
      // Written on another boot: every process it names is gone, so nothing is probed or signalled
      // (a new-boot process with the same pid and uptime would read as the recorded one). The root
      // is then swept like one whose owner is dead.
      if ((deps.anotherBoot ?? recordedOnAnotherBoot)(record.bootId)) {
        console.warn(
          `[oneshot] survivor record of ${name} is from an earlier boot; nothing signalled`,
        );
        continue;
      }

      // The group of the recorded leader (with identity), and what the scan sees now.
      let groupAlive = true; // cannot tell: not gone
      try {
        const gone = deps.groupGone ?? ((r) => groupGoneNow(r.pid, { leaderStartMs: r.startMs }));
        groupAlive = !gone(record);
      } catch {
        /* stays alive */
      }
      let scan: EscapeScan | undefined;
      try {
        scan = (deps.scan ?? ((t: EscapeScanTarget) => findEscapees(t)))({
          root: path,
          cwds: record.cwds,
          leaderStartMs: record.startMs,
        });
      } catch {
        /* /proc could not be listed: cannot tell, so it is a survivor */
      }
      const survivor = groupAlive || scan === undefined || scan.pids.length > 0;
      const procs: HeldProc[] = [...(record.unknown ?? []).filter((p) => alive(p))];
      for (const proc of scan?.unknown ?? []) {
        if (!procs.some((p) => p.pid === proc.pid))
          procs.push({ pid: proc.pid, startMs: proc.startMs });
      }

      if (survivor) {
        survivingGroups.set(path, {
          pid: record.pid,
          startMs: record.startMs,
          tempCwd: record.tempCwd,
          cwds: record.cwds,
          retries: 0,
          cause: "group",
        });
        reserveSurvivorSlot(path);
        console.error(
          `[oneshot] survivor of pid ${record.pid} found after a restart; ${name} kept and signalled again`,
        );
      }
      if (procs.length > 0) {
        unknownHolds.set(path, {
          leaderPid: record.pid,
          leaderStartMs: record.startMs,
          tempCwd: record.tempCwd,
          cwds: record.cwds,
          procs,
        });
        reserveSurvivorSlot(path); // a hold reserves a slot as a survivor does
        console.warn(
          `[oneshot] ${procs.length} unreadable process(es) of ${name} still alive after a restart; root kept while they live`,
        );
      }
    } catch (error) {
      console.warn(
        `[oneshot] survivor record not checked (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
  }
}

/**
 * Remove `claudeclaw-oneshot-cfg-*` and `claudeclaw-oneshot-pty-*` directories under `dir`
 * that a crashed or failed call left behind. A directory is swept only when ALL hold:
 * it is older than `maxAgeMs`; it belongs to this uid; no call of this daemon is still using
 * it; no claude of this daemon that outlived its retirement may still write into it, nor one
 * recorded in a `survivor.json` by an earlier daemon run; and its owner (the daemon whose pid
 * and start time its owner file names) is dead. A directory with no owner file at all (made
 * before the owner file existed) falls back to the age rule. One whose owner file (or
 * `survivor.json`) is there but cannot be read or understood is quarantined: logged once by name,
 * and removed only once it is 24 h old and the escape scan finds nothing in it, because it may
 * belong to a live call. Symlinks and plain files with the prefix are left alone. Returns how
 * many were removed; a failure on one entry does not stop the rest.
 */
export function sweepStaleOneShotDirs(
  dir = tmpdir(),
  now = Date.now(),
  maxAgeMs = ONESHOT_SWEEP_MAX_AGE_MS,
  deps: SweepDeps = {},
): number {
  const uid = deps.uid ?? process.getuid?.();
  // One `ps` per pid for the whole pass: the same owner pid names many directories.
  const startMs = cachedStartMs(deps.startMs);
  const ownerDead =
    deps.isOwnerDead ??
    ((owner: OwnerRecord) => isOwnerDead(owner, { startMs, anotherBoot: deps.anotherBoot }));
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  adoptPersistedSurvivors(dir, names, uid, deps);
  for (const name of names) {
    if (!name.startsWith(ONESHOT_CONFIG_PREFIX) && !name.startsWith(ONESHOT_CWD_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
      if (uid !== undefined && stat.uid !== uid) continue; // not ours to remove
      if (activeDirs.has(path) || protectedBySurvivor(path, deps)) continue;
      // Another live daemon's call is kept. This daemon's own finished call (not `activeDirs`)
      // whose removal failed is a leftover too, so its owner file does not protect it.
      const owner = readOwnerFile(path);
      const survivorFile = name.startsWith(ONESHOT_CONFIG_PREFIX)
        ? readSurvivorFile(path)
        : "missing";
      if (owner === "unreadable" || survivorFile === "unreadable") {
        const what = owner === "unreadable" ? "owner file" : "survivor record";
        if (!quarantined.has(path)) {
          quarantined.add(path);
          console.warn(`[oneshot] temp dir ${name} quarantined: ${what} unreadable, not removed`);
        }
        const target: EscapeScanTarget = name.startsWith(ONESHOT_CONFIG_PREFIX)
          ? { root: path, cwds: [] }
          : { root: null, cwds: untrustedCwdForms(path) };
        if (
          now - stat.mtimeMs > ONESHOT_QUARANTINE_MAX_AGE_MS &&
          !scanFindsSomething(target, deps)
        ) {
          rmSync(path, { recursive: true, force: true });
          quarantined.delete(path);
          removed++;
        }
        continue;
      }
      if (owner !== "missing" && owner.instance !== DAEMON_INSTANCE && !ownerDead(owner)) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.warn(
        `[oneshot] stale temp dir not removed (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
  }
  return removed;
}

/** Directories already reported as quarantined, so a pass every ten minutes does not repeat itself. */
const quarantined = new Set<string>();

/** How often a running daemon looks for leftovers. */
export const ONESHOT_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface SweeperDeps {
  setInterval?: (callback: () => void, ms: number) => { unref?: () => unknown };
  sweep?: () => number;
  /** Signals recorded survivors again; started at each timed pass beside the sweep, not before it. */
  retrySurvivors?: () => Promise<number>;
}

let sweeper: { unref?: () => unknown } | undefined;

/**
 * Sweep once now, then every `ONESHOT_SWEEP_INTERVAL_MS` while the daemon is up (unref'd, so
 * it never keeps the process alive). A late cleanup that failed is retried by a later pass
 * instead of waiting for the next daemon start. Registers the timer once. Returns how many
 * directories the first pass removed.
 */
export function startOneShotSweeper(deps: SweeperDeps = {}): number {
  const sweep = deps.sweep ?? (() => sweepStaleOneShotDirs());
  const first = sweep();
  if (sweeper === undefined) {
    const register = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const retry = deps.retrySurvivors ?? (() => retrySurvivingGroups());
    const failed = (what: string, error: unknown): void =>
      console.error(
        `[oneshot] ${what} failed (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "error"})`,
      );
    const timer = register(() => {
      // Survivors are signalled again on every pass. A root with a recorded survivor is skipped
      // by the sweep below, so the two need not run in order.
      void retry()
        .then((stopped) => {
          if (stopped > 0) console.log(`[oneshot] stopped ${stopped} surviving claude group(s)`);
        })
        .catch((error) => failed("survivor retry", error));
      try {
        const n = sweep();
        if (n > 0) console.log(`[oneshot] removed ${n} stale one-shot temp dir(s)`);
      } catch (error) {
        // The next pass retries it; this says so instead of staying silent.
        failed("sweeper pass", error);
      }
    }, ONESHOT_SWEEP_INTERVAL_MS);
    timer.unref?.();
    sweeper = timer;
  }
  return first;
}

/** Test seam: forget the registered timer so the next `startOneShotSweeper` registers again. */
export function resetOneShotSweeperForTests(): void {
  sweeper = undefined;
  quarantined.clear();
}
