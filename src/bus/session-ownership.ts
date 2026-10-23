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
 *     match, the process will not die, the deadline passes): signal nothing more and rotate.
 * A claude that names the id but has no matching record is never looked for and never signalled.
 *
 * One deadline bounds the whole guard, subprocess time included.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentsDir } from "../config";

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
const POLL_MS = 100;

/* ── Ownership record ───────────────────────────────────────────────────── */

export interface OwnershipRecord {
  agentId: string;
  sessionId: string;
  pid: number;
  /** Start identity of `pid` when it was spawned: see `ProcessInfo.identity`. */
  identity: string;
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

const isRecord = (v: unknown): v is OwnershipRecord => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.agentId === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.pid === "number" &&
    Number.isSafeInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.identity === "string" &&
    typeof r.bootId === "string" &&
    typeof r.exe === "string" &&
    typeof r.spawnedAt === "string"
  );
};

/**
 * The daemon's own state, next to the agent's `session.json`: `<agents>/<id>/owner.json`, mode 0600,
 * written atomically (temp file + rename). Operations on one agent are serialised.
 */
export function createFileOwnershipStore(agentsDir: () => string = getAgentsDir): OwnershipStore {
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(agentId: string, run: () => Promise<T>): Promise<T> => {
    const next = (chains.get(agentId) ?? Promise.resolve()).then(run, run);
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
      raw = await readFile(pathFor(agentId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("ownership record: unrecognised shape");
    return parsed;
  };
  return {
    read: (agentId) => serial(agentId, () => load(agentId)),
    write: (record) =>
      serial(record.agentId, async () => {
        const file = pathFor(record.agentId);
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await rename(tmp, file);
      }),
    clear: (agentId, expect) =>
      serial(agentId, async () => {
        const current = await load(agentId).catch(() => null);
        if (current && (current.pid !== expect.pid || current.identity !== expect.identity)) return;
        await rm(pathFor(agentId), { force: true });
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

/**
 * One targeted `ps` for ONE pid (never a table scan). The subprocess is killed at `timeoutMs`.
 * `ps` exits 1 with no output when the pid does not exist; any other failure rejects. `startTime`
 * supplies the sub-second start (libproc); it never decides whether the process exists.
 */
export function readFromPs(
  pid: number,
  timeoutMs: number,
  psCommand = "ps",
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

/** `p`, or `GuardDeadlineError` when `ms` passes first. `p` is not cancelled; its outcome is absorbed. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    p.catch(() => {});
    return Promise.reject(new GuardDeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GuardDeadlineError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    bootId: a.bootId ?? DAEMON_BOOT_ID,
    exe: a.exe,
    spawnedAt: new Date().toISOString(),
  };
  try {
    await withDeadline(a.store.write(record), a.timeoutMs ?? RECORD_STEP_MS);
  } catch (err) {
    throw new OwnershipRecordError("write", record, err);
  }
  return record;
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
}): Promise<"cleared" | "alive" | "unknown"> {
  try {
    if (!(await pollDeparted(a.probe, a.record, a.withinMs ?? 2000))) return "alive";
    await a.store.clear(a.record.agentId, a.record);
    return "cleared";
  } catch {
    return "unknown";
  }
}

/**
 * Retire a process the daemon is deliberately ending (a controlled restart): confirm with the OS
 * that it is gone, SIGKILLing it once if it is not. The signal goes only to the process the record
 * names, revalidated (same start identity) immediately before it. True only when the OS confirms.
 */
export async function confirmRetired(a: {
  store: OwnershipStore;
  probe: ProcessProbe;
  record: OwnershipRecord;
  graceMs?: number;
  killMs?: number;
}): Promise<boolean> {
  const { probe, record } = a;
  try {
    let gone = await pollDeparted(probe, record, a.graceMs ?? 2000);
    if (!gone) {
      // Revalidate immediately before the signal: only the process that was spawned.
      if (!departed(await probe.read(record.pid, PROBE_TIMEOUT_MS), record)) {
        try {
          probe.kill(record.pid, "SIGKILL");
        } catch {
          // ESRCH: it exited between the read and the signal; the poll below decides.
        }
      }
      gone = await pollDeparted(probe, record, a.killMs ?? 2000);
    }
    if (gone) await a.store.clear(record.agentId, record);
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
  | "guard-deadline";

export type ResumeDecision =
  | { kind: "resume"; reason: ResumeReason; reapedPid?: number; lowPrecision?: boolean }
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
}): Promise<ResumeDecision> {
  const bootId = a.bootId ?? DAEMON_BOOT_ID;
  const uid = a.uid ?? process.getuid?.() ?? -1;
  const end = Date.now() + (a.deadlineMs ?? GUARD_DEADLINE_MS);
  const left = (): number => end - Date.now();
  const bounded = <T>(p: Promise<T>): Promise<T> => withDeadline(p, left());

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
    // Second-precise identity (either side) authorises nothing by itself: the uid and argv
    // revalidation below is what stands between a same-second pid reuse and a signal.
    let lowPrecision = false;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const now = await read();
      if (departed(now, owned)) {
        gone = true;
        break;
      }
      const live = now as ProcessInfo;
      lowPrecision ||=
        live.lowPrecision === true ||
        (live.identity.includes("+") && !owned.identity.includes("+"));
      if (live.uid !== uid) throw new RotateSignal("owner-uid-mismatch");
      if (!namesOwnedClaude(live, owned)) throw new RotateSignal("owner-argv-mismatch");
      try {
        a.probe.kill(owned.pid, signal);
      } catch {
        // ESRCH: it exited between the read and the signal; the confirmation below decides.
      }
      const stageMs =
        signal === "SIGTERM" ? (a.termMs ?? ORPHAN_TERM_MS) : (a.killMs ?? ORPHAN_KILL_MS);
      const until = Math.min(end, Date.now() + stageMs);
      for (;;) {
        if (departed(await read(), owned)) {
          gone = true;
          break;
        }
        if (Date.now() >= until) break;
        await bounded(sleep(Math.min(POLL_MS, Math.max(1, until - Date.now()))));
      }
      if (gone) break;
    }
    if (!gone) throw new RotateSignal("orphan-unconfirmed");
    await clearRecord();
    return { kind: "resume", reason: "orphan-reaped", reapedPid: owned.pid, lowPrecision };
  } catch (err) {
    if (err instanceof RotateSignal) return { kind: "rotate", reason: err.reason };
    if (err instanceof GuardDeadlineError) return { kind: "rotate", reason: "guard-deadline" };
    return { kind: "rotate", reason: "owner-read-failed" };
  }
}
