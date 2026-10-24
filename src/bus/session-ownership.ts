/**
 * #595 round 3: the daemon ends only a process it can PROVE it spawned.
 *
 * The CLI takes no lock on `--resume`, so a claude that outlived its daemon would append to the
 * same transcript as the one about to be resumed. Round 2 found such a process by searching the
 * process table for the session id; a session id is not permission to kill (it also names an
 * operator's interactive session, or a PTY another part of this daemon manages), and `ps` args are
 * flattened text, not argv.
 *
 * Round 3 replaces the search with an OWNERSHIP RECORD written when the bus spawns claude: agent,
 * session id, pid, process start identity, and the daemon's boot id. A restart looks only at that
 * record:
 *   - no record: there is no process we own; resume. (This holds because a spawn whose record cannot be
 *     written is ended and fails, #595 r4: a live claude of ours without a record cannot exist, apart
 *     from the crash window between fork and the write and a child of a pre-upgrade daemon.)
 *   - the pid is gone, or alive with a different start identity (reused): nothing to signal; resume.
 *   - a record from THIS boot whose process is alive: a process the daemon manages; never signalled;
 *     rotate to a fresh id.
 *   - a record from a PREVIOUS boot whose process is alive with the same identity: our orphan. It is
 *     revalidated immediately before each signal (same start identity, same uid, argv still the
 *     executable we launched and the session id), SIGTERM, SIGKILL after a bound, then confirmed gone.
 *   - anything that cannot be proved (the record or the process cannot be read, the argv does not
 *     match, the start identity is only second-precise on either side, the process will not die, the
 *     deadline passes): signal nothing more and rotate.
 * A claude that names the id but has no matching record is never looked for and never signalled.
 *
 * One deadline bounds the whole guard, subprocess time included.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentsDir } from "../config";

/**
 * Whether the ownership guard applies on this platform (#595 r5). It reads POSIX process state
 * (`/proc`, `ps`, libproc), which win32 has none of, and the bus PTY is off by default there. One
 * predicate for both halves, so the restart-time decision and the spawn-time record cannot disagree:
 * a platform that records nothing must not be asked to decide from a record, and the reverse.
 */
export const ownershipGuardApplies = (platform: NodeJS.Platform = process.platform): boolean =>
  platform !== "win32";

/** Minted once per daemon start: a record carrying another boot id was written by a dead daemon. */
export const DAEMON_BOOT_ID = randomUUID();

/** The whole guard (reads, signals, confirmation) returns within this, or the session rotates. */
export const GUARD_DEADLINE_MS = 5000;
/** The most the orphan gets after SIGTERM before SIGKILL, and then after SIGKILL before it counts as unconfirmed. */
export const ORPHAN_TERM_MS = 3000;
export const ORPHAN_KILL_MS = 2000;
/** The most one process read may take (also capped by what is left of the deadline). */
export const PROBE_TIMEOUT_MS = 1500;
/**
 * The most the identity read and the write of a NEW record may each take. Longer than a restart-time
 * read: a record that is late is a spawn that fails (#595 r4), so a loaded machine gets a margin.
 */
export const RECORD_STEP_MS = 4000;
/**
 * The most ONE operation of the file ownership store may take (#595 r10). Shorter than every caller's
 * bound (`RECORD_STEP_MS`, `GUARD_DEADLINE_MS`), so the operation queued behind a stalled one still has
 * time to run once the stalled one is let go. A local file read or write takes milliseconds.
 */
export const STORE_OP_MS = 2000;
/**
 * The most a retirement waits for `store.clear`, whatever store it is given: one stalled predecessor
 * (`STORE_OP_MS`), its own operation (`STORE_OP_MS`), and a margin.
 */
export const CLEAR_BOUND_MS = 3 * STORE_OP_MS;
const POLL_MS = 100;

/* ── Ownership record ───────────────────────────────────────────────────── */

export interface OwnershipRecord {
  agentId: string;
  sessionId: string;
  pid: number;
  /** Start identity of `pid` when it was spawned: see `ProcessInfo.identity`. */
  identity: string;
  /**
   * True when `identity` was only second-precise at spawn (macOS, libproc unavailable). Such a record
   * can answer 'is it still there?' but never authorises a signal: see `mayAuthoriseSignal` (#595 r9).
   */
  lowPrecision?: boolean;
  bootId: string;
  /** Basename of the executable the daemon launched (what argv must still name). */
  exe: string;
  spawnedAt: string;
}

/** Where ownership records live. Injectable so tests never touch the operator's agents dir. */
export interface OwnershipStore {
  /** The agent's record, or null if none. Rejects when the record exists but cannot be read. */
  read(agentId: string): Promise<OwnershipRecord | null>;
  write(record: OwnershipRecord): Promise<void>;
  /** Delete the agent's record, but only if it still names `expect` (a newer spawn keeps its own). */
  clear(agentId: string, expect: { pid: number; identity: string }): Promise<void>;
}

/** Linux `pid_max` ceiling (0x400000): no live process has a larger pid. */
const MAX_PID = 4194304;

const isRecord = (v: unknown): v is OwnershipRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.agentId === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.pid === "number" &&
    Number.isSafeInteger(r.pid) &&
    // Never pid 0/1 (a signal to them is a group / init), beyond Linux's pid_max ceiling (0x400000),
    // or the daemon itself: a planted record must not aim a signal at any of those (#595 r7c).
    r.pid > 1 &&
    r.pid <= MAX_PID &&
    r.pid !== process.pid &&
    typeof r.identity === "string" &&
    (r.lowPrecision === undefined || typeof r.lowPrecision === "boolean") &&
    typeof r.bootId === "string" &&
    typeof r.exe === "string" &&
    typeof r.spawnedAt === "string"
  );
};

/** A file operation of the ownership store did not settle within `STORE_OP_MS`. Always an error, never "no record". */
export class OwnershipStoreTimeoutError extends Error {
  readonly code = "ownership-store-timeout";
  constructor(readonly opMs: number) {
    super(`ownership store operation did not settle within ${opMs} ms`);
    this.name = "OwnershipStoreTimeoutError";
  }
}

/** The file system calls the store makes. TEST SEAM: production uses `node:fs/promises`. */
export interface StoreFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, opts: { mode: number; flag: string }): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
}

const REAL_FS: StoreFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, opts) => writeFile(path, data, opts),
  mkdir: (path, opts) => mkdir(path, opts),
  rename: (from, to) => rename(from, to),
  rm: (path, opts) => rm(path, opts),
};

/**
 * The daemon's own state, next to the agent's `session.json`: `<agents>/<id>/owner.json`, mode 0600,
 * written atomically (temp file + rename). Operations on one agent are serialised.
 *
 * Each operation is bounded on its own by `opMs` (#595 r10). The agent's queue advances when the
 * operation settles OR that bound passes, so a file operation that never settles costs the operations
 * behind it at most one bound each and never holds them for good. A timed-out operation rejects with
 * `OwnershipStoreTimeoutError` (an error: callers treat it as unreadable / not recorded, never as "no
 * record"), and whatever it does afterwards is discarded: it publishes (renames) and deletes nothing,
 * so a late result cannot overwrite newer state. (A single `rename` or `rm` already handed to the
 * kernel when the bound passes cannot be recalled; that is the one residual.)
 */
export function createFileOwnershipStore(
  agentsDir: () => string = getAgentsDir,
  /** TEST SEAM: the temp-file name suffix. Production uses a fresh random one per write. */
  tmpSuffix: () => string = randomUUID,
  /** TEST SEAM: the per-operation bound, the timer it runs on and the file system. Inert when unset. */
  seams: { opMs?: number; clock?: GuardClock; fs?: StoreFs } = {},
): OwnershipStore {
  const opMs = seams.opMs ?? STORE_OP_MS;
  const clock = seams.clock ?? REAL_CLOCK;
  const fs = seams.fs ?? REAL_FS;
  /** Handed to a running operation: false once its bound has passed. */
  interface Gate {
    assertLive(): void;
  }
  const bounded = <T>(run: (gate: Gate) => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let open = true;
      const timer = clock.setTimeout(() => {
        open = false;
        reject(new OwnershipStoreTimeoutError(opMs));
      }, opMs);
      const settle = (done: () => void): void => {
        if (!open) return; // timed out: the late outcome is discarded
        open = false;
        clock.clearTimeout(timer);
        done();
      };
      run({
        assertLive: () => {
          if (!open) throw new OwnershipStoreTimeoutError(opMs);
        },
      }).then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e)),
      );
    });
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(agentId: string, run: (gate: Gate) => Promise<T>): Promise<T> => {
    const next = (chains.get(agentId) ?? Promise.resolve()).then(() => bounded(run));
    // `next` settles at the latest when its bound passes, so the queue never waits on a stalled file call.
    chains.set(
      agentId,
      next.catch(() => {}),
    );
    return next;
  };
  const pathFor = (agentId: string): string => {
    if (!agentId || basename(agentId) !== agentId || agentId === "." || agentId === "..") {
      throw new Error("ownership record: unusable agent id");
    }
    return join(agentsDir(), agentId, "owner.json");
  };
  const load = async (agentId: string): Promise<OwnershipRecord | null> => {
    let raw: string;
    try {
      raw = await fs.readFile(pathFor(agentId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("ownership record: unrecognised shape");
    // A record under this agent's directory that names another agent is not this agent's: treat it as
    // unreadable (the guard rotates) and never let `clear` act on it (#595 r7c).
    if (parsed.agentId !== agentId) throw new Error("ownership record: names another agent");
    return parsed;
  };
  return {
    read: (agentId) => serial(agentId, () => load(agentId)),
    write: (record) =>
      serial(record.agentId, async (gate) => {
        const file = pathFor(record.agentId);
        await fs.mkdir(dirname(file), { recursive: true });
        gate.assertLive();
        // Unpredictable name, created exclusively ("wx": O_EXCL fails on anything already there, a
        // planted symlink included, and never follows one). A failed create fails the record write,
        // which already ends the spawn (#595 r4) (#595 r7c).
        const tmp = `${file}.${tmpSuffix()}.tmp`;
        try {
          await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
          gate.assertLive(); // a write that outlived its bound must not publish over newer state
          await fs.rename(tmp, file);
        } catch (err) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
      }),
    clear: (agentId, expect) =>
      serial(agentId, async (gate) => {
        // Only a true ENOENT (load -> null) is "no record". Any other failure (EIO, EACCES, a malformed
        // record, the store timeout) rejects and deletes nothing: a failed compare-read must never read as
        // absent, or a delayed clear from an old process deletes its replacement's record (#596 r11).
        const current = await load(agentId);
        gate.assertLive(); // a read that outlived its bound must not delete a newer record
        if (current && (current.pid !== expect.pid || current.identity !== expect.identity)) return;
        await fs.rm(pathFor(agentId), { force: true });
      }),
  };
}

/* ── Process probe ──────────────────────────────────────────────────────── */

/** What the probe reads of ONE pid. */
export interface ProcessInfo {
  pid: number;
  uid: number;
  /**
   * A birth identity a reused pid cannot share with the process that held it before.
   * Linux: boot time (`/proc/stat` btime) + field 22 of `/proc/<pid>/stat` (start time in clock
   * ticks, 10 ms on a normal kernel). macOS: `ps -o lstart=` plus, when libproc answers, `+` and the
   * start time's microseconds (`<lstart>+<usec>`); without it, `ps -o lstart=` alone is SECOND precision
   * (`lowPrecision`). Compare identities with `sameStart`, never `===`.
   */
  identity: string;
  /** True when `identity` is only second-precise (macOS with libproc unavailable or unconvincing). */
  lowPrecision?: boolean;
  /** Exited and awaiting its parent's wait(): the process no longer runs. */
  zombie: boolean;
  /** The real argument vector (Linux `/proc/<pid>/cmdline`), or null when only flat text exists. */
  argv: string[] | null;
  /** `argv` joined with spaces, or the flat command text `ps` printed (argument boundaries lost). */
  command: string;
}

export interface ProcessProbe {
  /** The process `pid`, or null if there is none. Rejects when it cannot be read within `timeoutMs`. */
  read(pid: number, timeoutMs: number): Promise<ProcessInfo | null>;
  /** Send `signal` to `pid`. */
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

const isGone = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
};

let cachedBtime: string | null = null;

async function bootTime(procRoot: string): Promise<string> {
  if (cachedBtime) return cachedBtime;
  const text = await readFile(join(procRoot, "stat"), "utf8");
  const m = /^btime\s+(\d+)/m.exec(text);
  if (!m) throw new Error("no btime in /proc/stat");
  cachedBtime = m[1] as string;
  return cachedBtime;
}

async function readFromProc(pid: number, procRoot: string): Promise<ProcessInfo | null> {
  try {
    const dir = join(procRoot, String(pid));
    const statLine = await readFile(join(dir, "stat"), "utf8");
    // `comm` (field 2) may hold spaces and parens: the fields start after the LAST ")".
    const fields = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const ticks = fields[19]; // field 22 = index 19 once fields 1-2 are cut
    if (!state || !ticks) throw new Error("unparseable /proc stat");
    const [btime, cmdline, st] = await Promise.all([
      bootTime(procRoot),
      readFile(join(dir, "cmdline"), "utf8"),
      stat(dir),
    ]);
    const argv = cmdline.split("\0");
    if (argv[argv.length - 1] === "") argv.pop();
    return {
      pid,
      uid: st.uid,
      identity: `${btime}:${ticks}`,
      zombie: state === "Z" || state === "X",
      argv,
      command: argv.join(" "),
    };
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
}

/** `ps -ww -o stat=,uid=,lstart=,command=` rows: lstart is a fixed-shape date under LC_ALL=C. */
const PS_ROW = /^\s*(\S+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/;

/* ── macOS: sub-second birth time through libproc ───────────────────────── */

/**
 * `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info)` fills a `struct proc_bsdinfo`.
 * Source: the macOS SDK header `<sys/proc_info.h>` (checked against MacOSX26.5.sdk): `PROC_PIDTBSDINFO`
 * is 3, `PROC_PIDTBSDINFO_SIZE` is `sizeof(struct proc_bsdinfo)` = 136. Layout (little-endian; arm64 and
 * x86_64 agree): twelve 4-byte fields `pbi_flags`..`rfu_1` (0..47, so `pbi_status` is at 4, `pbi_pid` at
 * 12, `pbi_uid` at 20), `pbi_comm[16]` (48), `pbi_name[32]` (64), seven 4-byte fields `pbi_nfiles`..
 * `pbi_nice` (96..119), then the two `uint64_t` fields `pbi_start_tvsec` (120) and `pbi_start_tvusec`
 * (128), which sit on their natural 8-byte alignment with no padding.
 */
export const PROC_PIDTBSDINFO = 3;
export const PROC_BSDINFO_SIZE = 136;
export const BSDINFO_OFFSETS = { pid: 12, startSec: 120, startUsec: 128 } as const;

export interface StartTime {
  sec: number;
  usec: number;
}

/** Decode `pbi_start_tvsec` / `pbi_start_tvusec` from a `proc_bsdinfo` buffer; null if it is not `pid`'s. */
export function decodeBsdInfoStart(buf: Uint8Array, pid: number): StartTime | null {
  if (buf.byteLength < PROC_BSDINFO_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(BSDINFO_OFFSETS.pid, true) !== pid) return null;
  const sec = Number(view.getBigUint64(BSDINFO_OFFSETS.startSec, true));
  const usec = Number(view.getBigUint64(BSDINFO_OFFSETS.startUsec, true));
  if (!Number.isSafeInteger(sec) || sec <= 0 || !(usec >= 0 && usec < 1_000_000)) return null;
  return { sec, usec };
}

type ProcPidInfo = (
  pid: number,
  flavor: number,
  arg: bigint,
  buf: Uint8Array,
  size: number,
) => number;
let procPidInfo: ProcPidInfo | null | undefined;

/** `proc_pidinfo` from libSystem through `bun:ffi` (built in; loaded lazily like runner.ts does). */
function loadProcPidInfo(): ProcPidInfo | null {
  if (procPidInfo !== undefined) return procPidInfo;
  procPidInfo = null;
  try {
    const ffi = require("bun:ffi") as {
      // biome-ignore lint/suspicious/noExplicitAny: bun:ffi is untyped under tsc
      dlopen: (name: string, symbols: Record<string, unknown>) => { symbols: any };
      FFIType: Record<string, number>;
    };
    for (const name of ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]) {
      try {
        const lib = ffi.dlopen(name, {
          proc_pidinfo: {
            args: [
              ffi.FFIType.i32,
              ffi.FFIType.i32,
              ffi.FFIType.u64,
              ffi.FFIType.ptr,
              ffi.FFIType.i32,
            ],
            returns: ffi.FFIType.i32,
          },
        });
        procPidInfo = lib.symbols.proc_pidinfo as ProcPidInfo;
        break;
      } catch {
        // try the next name
      }
    }
  } catch {
    // no bun:ffi (not Bun): the caller falls back to second precision
  }
  return procPidInfo;
}

/** The microsecond start time of `pid` from libproc, or null when it cannot be had (never throws). */
export function libprocStartTime(pid: number): StartTime | null {
  if (process.platform !== "darwin") return null;
  const call = loadProcPidInfo();
  if (!call) return null;
  try {
    const buf = new Uint8Array(PROC_BSDINFO_SIZE);
    if (call(pid, PROC_PIDTBSDINFO, 0n, buf, PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE) return null;
    return decodeBsdInfoStart(buf, pid);
  } catch {
    return null;
  }
}

/**
 * `<lstart>` or `<lstart>+<usec>`. libproc's answer is used only when it agrees with `ps` on the
 * second (and on the pid, in the decode); anything else leaves the identity second-precise, marked so.
 */
function startIdentity(
  lstart: string,
  start: StartTime | null,
): { identity: string; low: boolean } {
  // `ps` runs with TZ=UTC (see `readFromPs`), so lstart is UTC whatever zone this process has.
  const psSec = Date.parse(`${lstart} UTC`) / 1000;
  if (start && Number.isFinite(psSec) && Math.abs(start.sec - psSec) <= 1) {
    return { identity: `${lstart}+${String(start.usec).padStart(6, "0")}`, low: false };
  }
  return { identity: lstart, low: true };
}

/**
 * Whether two start identities name the same process birth. Equal strings do. Otherwise they match
 * only at second precision, and only when one side has no microseconds (libproc was unavailable when
 * that side was read): `<lstart>` against `<lstart>+<usec>`. Two microsecond identities must be equal.
 * A second-precise match answers 'gone or reused?' (so: alive, rotate rather than resume beside it)
 * and never authorises a signal: `decideResume` refuses to kill on it (#595 r5).
 */
export function sameStart(a: string, b: string): boolean {
  if (a === b) return true;
  const split = (v: string): [string, string | undefined] => {
    const at = v.indexOf("+");
    return at < 0 ? [v, undefined] : [v.slice(0, at), v.slice(at + 1)];
  };
  const [sa, ua] = split(a);
  const [sb, ub] = split(b);
  return sa === sb && (ua === undefined || ub === undefined);
}

/** Absolute, so a `ps` earlier on a poisoned PATH is never run (#595 r7c). macOS and Linux both ship `/bin/ps`. */
export const PS_PATH = "/bin/ps";

/**
 * One targeted `ps` for ONE pid (never a table scan). The subprocess is killed at `timeoutMs`.
 * `ps` exits 1 with no output when the pid does not exist; any other failure rejects. `startTime`
 * supplies the sub-second start (libproc); it never decides whether the process exists.
 */
export function readFromPs(
  pid: number,
  timeoutMs: number,
  psCommand = PS_PATH,
  startTime: (pid: number) => StartTime | null = libprocStartTime,
): Promise<ProcessInfo | null> {
  return new Promise((resolve, reject) => {
    execFile(
      psCommand,
      ["-ww", "-o", "stat=,uid=,lstart=,command=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        // TZ=UTC: lstart is local time otherwise, which is ambiguous across a DST change and cannot
        // be read back against libproc's epoch seconds without knowing the zone.
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (err, stdout) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          if (code === 1 && String(stdout).trim() === "") resolve(null);
          else reject(err);
          return;
        }
        const m = PS_ROW.exec(String(stdout).split("\n")[0] ?? "");
        if (!m) {
          reject(new Error("unparseable ps row"));
          return;
        }
        let start: StartTime | null = null;
        try {
          start = startTime(pid);
        } catch {
          // second precision
        }
        const { identity, low } = startIdentity(m[3] as string, start);
        resolve({
          pid,
          uid: Number(m[2]),
          identity,
          ...(low ? { lowPrecision: true } : {}),
          zombie: (m[1] as string).startsWith("Z"),
          argv: null,
          command: (m[4] ?? "").trim(),
        });
      },
    );
  });
}

/** The real probe: `/proc` on Linux (real argv), one targeted `ps` elsewhere (flat command text). */
export function createSystemProbe(
  opts: {
    platform?: NodeJS.Platform;
    procRoot?: string;
    psCommand?: string;
    startTime?: (pid: number) => StartTime | null;
  } = {},
): ProcessProbe {
  const platform = opts.platform ?? process.platform;
  const procRoot = opts.procRoot ?? "/proc";
  return {
    read: (pid, timeoutMs) =>
      withDeadline(
        platform === "linux"
          ? readFromProc(pid, procRoot)
          : readFromPs(pid, timeoutMs, opts.psCommand, opts.startTime),
        timeoutMs,
      ),
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

/* ── Deadline ───────────────────────────────────────────────────────────── */

/** The guard's single deadline passed. */
export class GuardDeadlineError extends Error {
  constructor() {
    super("session ownership guard deadline");
    this.name = "GuardDeadlineError";
  }
}

/**
 * TEST SEAM: the clock and timer `decideResume` runs on. Unset, the guard uses the real `Date.now`
 * and `setTimeout`, so production behaviour is exactly what it was; a test passes a fake to move the
 * deadline by hand instead of racing it against a loaded machine.
 */
export interface GuardClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: GuardClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `p`, or `GuardDeadlineError` when `ms` passes first. `p` is not cancelled; its outcome is absorbed. */
function withDeadline<T>(p: Promise<T>, ms: number, clock: GuardClock = REAL_CLOCK): Promise<T> {
  if (ms <= 0) {
    p.catch(() => {});
    return Promise.reject(new GuardDeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new GuardDeadlineError()), ms);
    p.then(
      (v) => {
        clock.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clock.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number, clock: GuardClock = REAL_CLOCK): Promise<void> =>
  new Promise((r) => clock.setTimeout(r, ms));

/* ── What the argv must still say ───────────────────────────────────────── */

const INTERPRETERS = new Set(["node", "bun", "sh", "bash", "dash", "zsh"]);

/**
 * Whether the process is still the claude the daemon launched for this session: argv[0] (or the
 * script after an interpreter) is the executable recorded at spawn, and the session id is a WHOLE
 * argument directly after `--resume` / `--session-id` (or glued as `--flag=<id>`).
 *
 * With a real argv (Linux) a prompt that merely contains the text is one argument and cannot
 * match. Without one (macOS: `ps` prints flat text) the boundaries are guessed from spaces, so this
 * is a confirming check on a process the record and start identity already prove ours, never the
 * thing that makes it ours.
 */
export function namesOwnedClaude(info: ProcessInfo, rec: OwnershipRecord): boolean {
  const tokens = info.argv ?? info.command.split(/\s+/).filter(Boolean);
  const prog = basename(tokens[0] ?? "");
  const script = basename(tokens[1] ?? "");
  const program = prog === rec.exe || (INTERPRETERS.has(prog) && script === rec.exe);
  if (!program) return false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "--resume" || t === "--session-id") && tokens[i + 1] === rec.sessionId) return true;
    if (t === `--resume=${rec.sessionId}` || t === `--session-id=${rec.sessionId}`) return true;
  }
  return false;
}

/* ── The one gate before any signal ─────────────────────────────────────── */

/** Why a signal was refused. A subset of `RotateReason`, so `decideResume` rotates on it unchanged. */
export type SignalRefusal =
  | "resume-identity-low-precision"
  | "owner-uid-mismatch"
  | "owner-argv-mismatch";

/**
 * May the daemon signal `live` as the process `owned` names? `null` means yes; otherwise the reason it
 * may not. EVERY signal this module sends goes through here (`signalOwned` is the only caller of
 * `ProcessProbe.kill`), on a read taken immediately before the signal (#595 r5, r9):
 *  - a microsecond birth identity on BOTH sides. A second-precise match (macOS without libproc, on the
 *    live read or on the record) can still be a pid reused within that second, and uid + argv cannot
 *    tell those apart. It was good enough to say 'still there', never to kill;
 *  - the same uid as the daemon;
 *  - an argv that still names the executable we launched and the session id.
 */
export function mayAuthoriseSignal(a: {
  live: ProcessInfo;
  owned: OwnershipRecord;
  uid: number;
}): SignalRefusal | null {
  const { live, owned, uid } = a;
  if (
    live.lowPrecision === true ||
    owned.lowPrecision === true ||
    live.identity.includes("+") !== owned.identity.includes("+")
  )
    return "resume-identity-low-precision";
  if (live.uid !== uid) return "owner-uid-mismatch";
  if (!namesOwnedClaude(live, owned)) return "owner-argv-mismatch";
  return null;
}

/**
 * Signal `owned.pid` once `mayAuthoriseSignal` allows it. Returns the refusal (nothing was sent) or
 * null (sent; an ESRCH because it exited in between is absorbed, the caller's confirmation decides).
 */
function signalOwned(a: {
  probe: ProcessProbe;
  signal: "SIGTERM" | "SIGKILL";
  live: ProcessInfo;
  owned: OwnershipRecord;
  uid: number;
}): SignalRefusal | null {
  const refusal = mayAuthoriseSignal(a);
  if (refusal) return refusal;
  try {
    a.probe.kill(a.owned.pid, a.signal);
  } catch {
    // ESRCH: it exited between the read and the signal.
  }
  return null;
}

/* ── Writing and clearing the record ────────────────────────────────────── */

/**
 * The daemon could not record a process it just spawned (#595 r4). The process is alive and
 * unrecorded, so the spawn must end it and fail: "no record" is only safe to read as "nothing of ours
 * holds the session" if this never goes unhandled. `record` is set when the identity was read but the
 * write failed (the in-memory record still lets the retirement signal exactly that process).
 */
export class OwnershipRecordError extends Error {
  readonly code = "ownership-record-failed";
  constructor(
    readonly stage: "identity-read" | "write",
    readonly record: OwnershipRecord | null,
    override readonly cause: unknown,
  ) {
    super(`ownership record not written (${stage})`);
    this.name = "OwnershipRecordError";
  }
}

/**
 * Record that the daemon spawned `pid` for `agentId`'s `sessionId`. Returns null when the process is
 * already gone (nothing to own). Rejects with `OwnershipRecordError` when the identity cannot be read
 * or the write fails: the caller ends the process and fails the spawn.
 */
export async function recordOwnership(a: {
  store: OwnershipStore;
  probe: ProcessProbe;
  agentId: string;
  sessionId: string;
  pid: number;
  exe: string;
  bootId?: string;
  timeoutMs?: number;
}): Promise<OwnershipRecord | null> {
  let info: ProcessInfo | null;
  try {
    const ms = a.timeoutMs ?? RECORD_STEP_MS;
    info = await withDeadline(a.probe.read(a.pid, ms), ms);
  } catch (err) {
    throw new OwnershipRecordError("identity-read", null, err);
  }
  if (!info || info.zombie) return null;
  const record: OwnershipRecord = {
    agentId: a.agentId,
    sessionId: a.sessionId,
    pid: a.pid,
    identity: info.identity,
    ...(info.lowPrecision ? { lowPrecision: true } : {}),
    bootId: a.bootId ?? DAEMON_BOOT_ID,
    exe: a.exe,
    spawnedAt: new Date().toISOString(),
  };
  try {
    const ms = a.timeoutMs ?? RECORD_STEP_MS;
    await refuseLiveRecord(a, record, info, ms);
    await withDeadline(a.store.write(record), ms);
  } catch (err) {
    throw new OwnershipRecordError("write", record, err);
  }
  return record;
}

/** A record for a different process of the same session is still live: it is never overwritten (#595 r10). */
export class LiveOwnerRecordError extends Error {
  readonly code = "owner-record-live";
  constructor(readonly livePid: number) {
    super("an ownership record for another live process of this session exists");
    this.name = "LiveOwnerRecordError";
  }
}

/**
 * Never overwrite the record of a live process: it is the only way a later start can find that
 * process again, and the bus has just started a second one on the same session id (#595 r10).
 * `decideResume` rotates or reaps before a spawn, so this is the backstop for whatever it could not
 * see (a record written between its read and the spawn). A record that cannot be read is replaced
 * (a corrupt file heals); a live process whose read fails is treated as live.
 */
async function refuseLiveRecord(
  a: { store: OwnershipStore; probe: ProcessProbe; agentId: string; sessionId: string },
  record: OwnershipRecord,
  info: ProcessInfo,
  ms: number,
): Promise<void> {
  let existing: OwnershipRecord | null;
  try {
    existing = await withDeadline(a.store.read(a.agentId), ms);
  } catch {
    return;
  }
  if (!existing || existing.sessionId !== a.sessionId) return;
  if (existing.pid === record.pid && sameStart(existing.identity, info.identity)) return;
  const live = await withDeadline(a.probe.read(existing.pid, ms), ms).catch(() => undefined);
  if (live === undefined || !departed(live, existing)) throw new LiveOwnerRecordError(existing.pid);
}

/** True when the process the record names is no longer running (gone, a zombie, or the pid is reused). */
const departed = (info: ProcessInfo | null, rec: OwnershipRecord): boolean =>
  info === null || !sameStart(info.identity, rec.identity) || info.zombie;

/** Poll until the record's process has departed (true) or `withinMs` passes (false). Rejects on a read failure. */
async function pollDeparted(
  probe: ProcessProbe,
  rec: OwnershipRecord,
  withinMs: number,
): Promise<boolean> {
  const end = Date.now() + withinMs;
  for (;;) {
    const info = await probe.read(
      rec.pid,
      Math.max(1, Math.min(PROBE_TIMEOUT_MS, end - Date.now())),
    );
    if (departed(info, rec)) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(POLL_MS, Math.max(1, end - Date.now())));
  }
}

/** Where a failed `store.clear` is reported. `console` unless the caller passes its own. */
export interface OwnershipLogger {
  warn(message: string): void;
}

/**
 * One reason-coded line for a `store.clear` that failed. The record is left in place (fail closed): the
 * next start's guard sees it, re-checks the process and either reaps or rotates (#596 r11). Only the
 * error's code or name is logged, never its message (which can carry a path).
 */
function warnClearFailed(
  logger: OwnershipLogger | undefined,
  agentId: string,
  op: string,
  err: unknown,
): void {
  const e = err as { code?: unknown; name?: unknown } | null;
  const kind = String(e?.code ?? e?.name ?? "unknown");
  (logger ?? console).warn(
    `[bus-session] agent=${agentId} reason=ownership-clear-failed op=${op} error=${kind} — the ownership record is left in place; the next start re-checks the process`,
  );
}

/**
 * After the process reported its exit: ask the OS (the exit event is not proof, bun-pty fires it at
 * once), and clear the record only when the OS confirms. Alive or unreadable keeps the record, so
 * the next start sees it. Never throws.
 */
export async function confirmGoneAndClear(a: {
  store: OwnershipStore;
  probe: ProcessProbe;
  record: OwnershipRecord;
  withinMs?: number;
  /** The most `store.clear` may take (default `CLEAR_BOUND_MS`); past it the answer is "unknown". */
  clearMs?: number;
  /** TEST SEAM (`GuardClock`): inert when unset. */
  clock?: GuardClock;
  logger?: OwnershipLogger;
}): Promise<"cleared" | "alive" | "unknown"> {
  try {
    if (!(await pollDeparted(a.probe, a.record, a.withinMs ?? 2000))) return "alive";
    try {
      await withDeadline(
        a.store.clear(a.record.agentId, a.record),
        a.clearMs ?? CLEAR_BOUND_MS,
        a.clock,
      );
    } catch (err) {
      warnClearFailed(a.logger, a.record.agentId, "confirm-gone", err);
      return "unknown";
    }
    return "cleared";
  } catch {
    return "unknown";
  }
}

/**
 * Retire a process the daemon is deliberately ending (a controlled restart): confirm with the OS
 * that it is gone, SIGKILLing it once if it is not. The signal goes only to the process the record
 * names, revalidated immediately before it and authorised by the same gate `decideResume` uses
 * (`mayAuthoriseSignal`): a refused signal leaves the process unconfirmed. True only when the OS
 * confirms.
 */
export async function confirmRetired(a: {
  store: OwnershipStore;
  probe: ProcessProbe;
  record: OwnershipRecord;
  graceMs?: number;
  killMs?: number;
  uid?: number;
  /** The most `store.clear` may take (default `CLEAR_BOUND_MS`); past it the process counts as unconfirmed. */
  clearMs?: number;
  /** TEST SEAM (`GuardClock`): inert when unset. */
  clock?: GuardClock;
  logger?: OwnershipLogger;
}): Promise<boolean> {
  const { probe, record } = a;
  const uid = a.uid ?? process.getuid?.() ?? -1;
  try {
    let gone = await pollDeparted(probe, record, a.graceMs ?? 2000);
    if (!gone) {
      // Revalidate immediately before the signal: only the process that was spawned.
      const live = await probe.read(record.pid, PROBE_TIMEOUT_MS);
      if (!departed(live, record)) {
        const refused = signalOwned({
          probe,
          signal: "SIGKILL",
          live: live as ProcessInfo,
          owned: record,
          uid,
        });
        if (refused) return false;
      }
      gone = await pollDeparted(probe, record, a.killMs ?? 2000);
    }
    if (gone) {
      try {
        await withDeadline(
          a.store.clear(record.agentId, record),
          a.clearMs ?? CLEAR_BOUND_MS,
          a.clock,
        );
      } catch (err) {
        // Gone, but the record could not be cleared (or compared): not cleanly recorded, so unconfirmed.
        warnClearFailed(a.logger, record.agentId, "confirm-retired", err);
        return false;
      }
    }
    return gone;
  } catch {
    return false;
  }
}

/* ── The restart-time decision ──────────────────────────────────────────── */

export type ResumeReason =
  | "no-record"
  | "record-other-session"
  | "owner-gone"
  | "pid-reused"
  | "orphan-reaped";

export type RotateReason =
  | "ownership-record-unreadable"
  | "owner-read-failed"
  | "current-boot-owner-alive"
  | "owner-uid-mismatch"
  | "owner-argv-mismatch"
  | "orphan-unconfirmed"
  | "resume-identity-low-precision"
  | "guard-deadline";

export type ResumeDecision =
  | { kind: "resume"; reason: ResumeReason; reapedPid?: number }
  | { kind: "rotate"; reason: RotateReason };

class RotateSignal extends Error {
  constructor(readonly reason: RotateReason) {
    super(reason);
  }
}

/**
 * May `agentId` resume `sessionId`, or must it rotate to a fresh id? See the file header for the
 * cases. Never throws; signals only a process the record proves the daemon spawned in a previous
 * boot, and returns within `deadlineMs` (default 5 s), subprocess time included.
 */
export async function decideResume(a: {
  agentId: string;
  sessionId: string;
  store: OwnershipStore;
  probe: ProcessProbe;
  bootId?: string;
  uid?: number;
  deadlineMs?: number;
  termMs?: number;
  killMs?: number;
  /** TEST SEAM (`GuardClock`): inert when unset. */
  clock?: GuardClock;
  logger?: OwnershipLogger;
}): Promise<ResumeDecision> {
  const bootId = a.bootId ?? DAEMON_BOOT_ID;
  const uid = a.uid ?? process.getuid?.() ?? -1;
  const clock = a.clock ?? REAL_CLOCK;
  const end = clock.now() + (a.deadlineMs ?? GUARD_DEADLINE_MS);
  const left = (): number => end - clock.now();
  const bounded = <T>(p: Promise<T>): Promise<T> => withDeadline(p, left(), clock);

  try {
    let rec: OwnershipRecord | null;
    try {
      rec = await bounded(a.store.read(a.agentId));
    } catch (err) {
      if (err instanceof GuardDeadlineError) throw err;
      throw new RotateSignal("ownership-record-unreadable");
    }
    if (!rec) return { kind: "resume", reason: "no-record" };
    if (rec.sessionId !== a.sessionId) return { kind: "resume", reason: "record-other-session" };
    const owned: OwnershipRecord = rec;

    const read = async (): Promise<ProcessInfo | null> => {
      try {
        return await bounded(
          a.probe.read(owned.pid, Math.max(1, Math.min(PROBE_TIMEOUT_MS, left()))),
        );
      } catch (err) {
        if (err instanceof GuardDeadlineError) throw err;
        throw new RotateSignal("owner-read-failed");
      }
    };
    const clearRecord = async (): Promise<void> => {
      try {
        await bounded(a.store.clear(owned.agentId, owned));
      } catch (err) {
        if (err instanceof GuardDeadlineError) throw err;
        // A record that will not clear is re-examined (and cleared) by the next start.
        warnClearFailed(a.logger, owned.agentId, "decide-resume", err);
      }
    };

    const first = await read();
    if (departed(first, owned)) {
      await clearRecord();
      const reused = first !== null && !sameStart(first.identity, owned.identity);
      return { kind: "resume", reason: reused ? "pid-reused" : "owner-gone" };
    }
    // Alive with the recorded identity. A process of THIS boot is one the daemon manages.
    if (owned.bootId === bootId) throw new RotateSignal("current-boot-owner-alive");

    // A previous boot's process: our orphan. Signal only after revalidating, each time.
    let gone = false;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const now = await read();
      if (departed(now, owned)) {
        gone = true;
        break;
      }
      const refused = signalOwned({
        probe: a.probe,
        signal,
        live: now as ProcessInfo,
        owned,
        uid,
      });
      if (refused) throw new RotateSignal(refused);
      const stageMs =
        signal === "SIGTERM" ? (a.termMs ?? ORPHAN_TERM_MS) : (a.killMs ?? ORPHAN_KILL_MS);
      const until = Math.min(end, clock.now() + stageMs);
      for (;;) {
        if (departed(await read(), owned)) {
          gone = true;
          break;
        }
        if (clock.now() >= until) break;
        await bounded(sleep(Math.min(POLL_MS, Math.max(1, until - clock.now())), clock));
      }
      if (gone) break;
    }
    if (!gone) throw new RotateSignal("orphan-unconfirmed");
    await clearRecord();
    return { kind: "resume", reason: "orphan-reaped", reapedPid: owned.pid };
  } catch (err) {
    if (err instanceof RotateSignal) return { kind: "rotate", reason: err.reason };
    if (err instanceof GuardDeadlineError) return { kind: "rotate", reason: "guard-deadline" };
    return { kind: "rotate", reason: "owner-read-failed" };
  }
}
