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
 *   - no record: there is no process we own; resume.
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
   * ticks, 10 ms on a normal kernel). macOS/BSD: `ps -o lstart=`, which is SECOND precision.
   */
  identity: string;
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

/**
 * One targeted `ps` for ONE pid (never a table scan). The subprocess is killed at `timeoutMs`.
 * `ps` exits 1 with no output when the pid does not exist; any other failure rejects.
 */
export function readFromPs(
  pid: number,
  timeoutMs: number,
  psCommand = "ps",
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
        env: { ...process.env, LC_ALL: "C" },
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
        resolve({
          pid,
          uid: Number(m[2]),
          identity: m[3] as string,
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
  opts: { platform?: NodeJS.Platform; procRoot?: string; psCommand?: string } = {},
): ProcessProbe {
  const platform = opts.platform ?? process.platform;
  const procRoot = opts.procRoot ?? "/proc";
  return {
    read: (pid, timeoutMs) =>
      withDeadline(
        platform === "linux"
          ? readFromProc(pid, procRoot)
          : readFromPs(pid, timeoutMs, opts.psCommand),
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
 * Record that the daemon spawned `pid` for `agentId`'s `sessionId`. Returns null when the process is
 * already gone (nothing to own). Rejects when the identity cannot be read or the write fails; the
 * caller logs it and carries on, since a spawn must not fail for want of a record.
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
  const info = await a.probe.read(a.pid, a.timeoutMs ?? PROBE_TIMEOUT_MS);
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
  await a.store.write(record);
  return record;
}

/** True when the process the record names is no longer running (gone, a zombie, or the pid is reused). */
const departed = (info: ProcessInfo | null, rec: OwnershipRecord): boolean =>
  info === null || info.identity !== rec.identity || info.zombie;

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
      const reused = first !== null && first.identity !== owned.identity;
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
      const live = now as ProcessInfo;
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
    return { kind: "resume", reason: "orphan-reaped", reapedPid: owned.pid };
  } catch (err) {
    if (err instanceof RotateSignal) return { kind: "rotate", reason: err.reason };
    if (err instanceof GuardDeadlineError) return { kind: "rotate", reason: "guard-deadline" };
    return { kind: "rotate", reason: "owner-read-failed" };
  }
}
