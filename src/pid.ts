import { writeFile, unlink, readFile } from "fs/promises";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";

const PID_FILE = join(process.cwd(), ".claude", "claudeclaw", "daemon.pid");

export function getPidPath(): string {
  return PID_FILE;
}

/**
 * Whether a daemon runs here could not be determined: the PID lock could not
 * be taken and nobody live holds it, or `daemon.pid` kept changing under the
 * check. Thrown rather than reported as "no daemon": callers that act on that
 * answer must refuse instead.
 */
export class DaemonStateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonStateUnknownError";
  }
}

/**
 * Check if a daemon is already running in this directory.
 * A stale PID file (process dead, or naming this very process) is cleaned up.
 * Returns the running PID if alive, or null when there is none.
 * Throws `DaemonStateUnknownError` when that cannot be determined.
 */
export async function checkExistingDaemon(): Promise<number | null> {
  // #435: the whole check runs under the PID lock (re-entrant for `start`,
  // which already holds it), so a concurrent start cannot write between the
  // read and the stale cleanup. A start holding the lock past the wait is
  // reported as a running daemon: one is about to be.
  const lock = await acquirePidLock();
  if (!lock.ok) {
    if (lock.holder !== null) return lock.holder;
    throw new DaemonStateUnknownError(
      `could not take the PID lock (${getPidLockPath()} cannot be created, is unreadable, or a stale one could not be removed); if no claudeclaw start/stop runs here, remove it and its .steal and retry`,
    );
  }
  try {
    // Writers that predate the lock do not take it: if the file changed under
    // the cleanup, judge the new contents rather than report "none".
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string;
      try {
        raw = (await readFile(PID_FILE, "utf-8")).trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // no pid file
        // Present but unreadable: it may name a live daemon.
        throw new DaemonStateUnknownError(`${PID_FILE} could not be read: ${err}`);
      }

      const pid = Number(raw);
      // #420: EPERM means alive-but-not-ours — never treat it as stale, or a
      // `start` by another user removes a live daemon's file and starts over it.
      // Positive integers only: kill(-1, 0) succeeds and would name everyone.
      // #526: our own PID is a leftover, not a daemon — in a container the
      // daemon is PID 1 on every start, so the file from the last run names us.
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) return pid;
      // Corrupt, ours, or the process is dead: remove the file — still the one read.
      if ((await compareAndUnlink(pid, PID_FILE)) !== "foreign") return null;
    }
    throw new DaemonStateUnknownError(`${PID_FILE} kept changing while it was checked`);
  } finally {
    releasePidLock();
  }
}

export async function writePidFile(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid) + "\n");
}

/**
 * Wait until `pid` is gone, polling every `pollMs`, for at most `maxMs`.
 * Resolves true when the process exited (or never existed), false when it
 * is still alive at the deadline. Used by `stop` / `--replace-existing` so a
 * daemon draining its in-flight turns (#315) is not declared stopped — and
 * its PID file not removed — while it still owns the socket and the agents.
 */
export async function waitForPidExit(pid: number, maxMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * `kill(pid, 0)` throws for two different reasons: `ESRCH` (no such process —
 * gone) and `EPERM` (it exists but is not ours). Only the first means gone
 * (#420); treating a foreign live PID as exited would let `stop` /
 * `--replace-existing` remove its file and start another daemon over it.
 */
export function isPidAlive(pid: number): boolean {
  // kill(0, …) probes the caller's process group and kill(-1, …) every process it may
  // signal: both "succeed", so neither may be mistaken for "a daemon is alive".
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove `daemon.pid` only if it still names `expectedPid` (#420). Between
 * "the old daemon exited" and this unlink, a concurrent `start` may have
 * written its own PID into the file; unlinking unconditionally would drop
 * that daemon's file and let a later `start` launch a duplicate. Returns
 * whether the file was removed.
 */
export type PidFileCleanup = "removed" | "absent" | "foreign" | "locked";
export async function cleanupPidFileIf(
  expectedPid: number,
  pidFile: string = PID_FILE,
  lockWaitMs = PID_LOCK_WAIT_MS,
): Promise<PidFileCleanup> {
  // #435: read → compare → unlink under the project's PID lock, so it cannot
  // interleave with a `start` between `checkExistingDaemon()` and
  // `writePidFile()`. When the lock stays held (a `start` is mid-way), leave
  // the file: a PID file naming a dead process is cleaned up by the next
  // `checkExistingDaemon()`, while removing a live one starts a duplicate.
  const lock = await acquirePidLock(pidFile, lockWaitMs);
  if (!lock.ok) return "locked";
  try {
    return await compareAndUnlink(expectedPid, pidFile);
  } finally {
    releasePidLock(pidFile);
  }
}

async function compareAndUnlink(
  expectedPid: number,
  pidFile: string,
): Promise<Exclude<PidFileCleanup, "locked">> {
  let raw: string;
  try {
    raw = (await readFile(pidFile, "utf-8")).trim();
  } catch {
    // The daemon removes its own file on a clean exit; "absent" is the
    // normal outcome of a graceful stop, not a sign of anything.
    return "absent";
  }
  // A corrupt file (non-numeric) names nobody: remove it, as `checkExistingDaemon` does.
  const current = Number(raw);
  if (!Number.isInteger(current) || current <= 0) {
    await unlink(pidFile).catch(() => undefined);
    return "removed";
  }
  if (current !== expectedPid) return "foreign";
  // Every writer holds the PID lock too (#435), so nothing can write the file
  // between this read and the unlink.
  await unlink(pidFile).catch(() => undefined);
  return "removed";
}

// --- PID lock (#435) ---------------------------------------------------------
//
// One lock per project, `daemon.lock` next to `daemon.pid`, shared by every
// reader-that-removes, writer and remover of the PID file: `start` holds it
// from `checkExistingDaemon()` through `writePidFile()`, and every removal is
// a compare-and-unlink taken under it. Bun has no `flock`, so it is a file
// created atomically (`link(2)` of a temp file that already holds our PID:
// the lock never exists empty) and judged stale when the PID inside is gone.

/** How long removers and `start` wait for a lock someone else holds. */
export const PID_LOCK_WAIT_MS = 2_000;

/** Locks this process holds, by path, with a re-entry count. */
const heldLocks = new Map<string, number>();
let exitHookInstalled = false;

export function getPidLockPath(pidFile: string = PID_FILE): string {
  return join(dirname(pidFile), "daemon.lock");
}

/**
 * Who holds a lock file: its PID; "empty" when it holds nothing yet (an
 * O_EXCL create not yet written) or is gone; "unknown" when it cannot be read
 * or does not hold a PID. An unknown lock is never judged stale: it may be a
 * live holder's (#435).
 */
type LockHolder = number | "empty" | "unknown";
function readLockHolder(lockPath: string): LockHolder {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8").trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "empty" : "unknown";
  }
  if (raw === "") return "empty";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : "unknown";
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** `holder`: the live PID holding the lock when `ok` is false, null otherwise. */
export interface PidLockResult {
  ok: boolean;
  holder: number | null;
}

/**
 * Create `path` holding our PID, or fail if it exists. `link(2)` of a temp
 * file that already holds the PID, so the file never exists empty; where
 * hard links are not available, `O_CREAT|O_EXCL` then the PID — a reader
 * may then briefly see it empty, which the stale rule does not take for
 * stale until it is old. "unavailable": no lock file can be created here.
 */
function tryLink(path: string): "ok" | "busy" | "unavailable" {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    // A first `start` takes the lock before `initConfig()` creates the dir.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${process.pid}\n`);
  } catch {
    return "unavailable";
  }
  try {
    linkSync(tmp, path);
    return "ok";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "busy";
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return "ok";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EEXIST" ? "busy" : "unavailable";
  }
}

/**
 * One attempt. Not ok with a null holder: a stale lock was removed (retry),
 * or no lock can be taken right now (the caller fails at its deadline).
 */
function tryCreateLock(lockPath: string): PidLockResult {
  const r = tryLink(lockPath);
  if (r === "ok") return { ok: true, holder: null };
  // Fail closed: proceeding unlocked is exactly the race #435 closes.
  if (r === "unavailable") return { ok: false, holder: null };
  const holder = readLockHolder(lockPath);
  // Unreadable or not a PID: not ours to judge — fail closed.
  if (holder === "unknown") return { ok: false, holder: null };
  // Empty: possibly an O_EXCL lock between create and write.
  if (holder === "empty" && !olderThan(lockPath, 5_000)) return { ok: false, holder: null };
  // A holder that is gone (or a lock with our own PID that this process does
  // not hold: a dead predecessor whose PID was recycled) is stale.
  if (holder !== "empty" && holder !== process.pid && isPidAlive(holder)) {
    return { ok: false, holder };
  }
  stealStaleLock(lockPath, holder);
  return { ok: false, holder: null };
}

/**
 * Remove a stale lock. Two contenders may judge the same lock stale; if both
 * removed "it", the second could remove the first one's fresh lock. So the
 * removal happens under a second create-or-fail file, `daemon.lock.steal`,
 * after re-reading the holder: only one contender at a time checks and
 * removes, and a fresh lock (live holder) is never removed. The guard is held
 * for two syscalls; one left by a contender that died inside them is itself
 * judged stale by its PID and removed the same way.
 */
function stealStaleLock(lockPath: string, staleHolder: number | "empty"): void {
  const guard = `${lockPath}.steal`;
  const g = tryLink(guard);
  if (g === "busy") {
    const guardHolder = readLockHolder(guard);
    if (guardHolder === "unknown") return;
    // Held for two syscalls: one older than a few seconds was left by a
    // stealer that died, even if its PID has since been recycled. An empty one
    // is an O_EXCL create not yet written — fresh, it is someone's, as for
    // the lock itself.
    if ((guardHolder === "empty" || isPidAlive(guardHolder)) && !olderThan(guard, 5_000)) return;
    try {
      if (readLockHolder(guard) === guardHolder) unlinkSync(guard);
    } catch {}
    return; // retry from the top
  }
  if (g === "unavailable") return;
  try {
    if (readLockHolder(lockPath) === staleHolder) unlinkSync(lockPath);
  } catch {
    /* already gone */
  } finally {
    try {
      unlinkSync(guard);
    } catch {}
  }
}

/**
 * Take the project's PID lock, waiting up to `waitMs` for a live holder.
 * Re-entrant within a process. On failure, `holder` is the PID holding it.
 */
export async function acquirePidLock(
  pidFile: string = PID_FILE,
  waitMs = PID_LOCK_WAIT_MS,
): Promise<PidLockResult> {
  const lockPath = getPidLockPath(pidFile);
  const depth = heldLocks.get(lockPath);
  if (depth !== undefined) {
    heldLocks.set(lockPath, depth + 1);
    return { ok: true, holder: null };
  }
  const deadline = Date.now() + waitMs;
  let justStole = false;
  for (;;) {
    const r = tryCreateLock(lockPath);
    if (r.ok) {
      heldLocks.set(lockPath, 1);
      installExitHook();
      return r;
    }
    // A stale lock was just removed: retry at once — but only once in a row,
    // so a stale lock that cannot be removed does not spin.
    if (r.holder === null && !justStole) {
      justStole = true;
      continue;
    }
    justStole = false;
    if (Date.now() >= deadline) return r;
    await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

/** Release one level of the lock; the file goes when the count reaches zero. */
export function releasePidLock(pidFile: string = PID_FILE): void {
  const lockPath = getPidLockPath(pidFile);
  const depth = heldLocks.get(lockPath);
  if (depth === undefined) return;
  if (depth > 1) {
    heldLocks.set(lockPath, depth - 1);
    return;
  }
  heldLocks.delete(lockPath);
  removeOwnLock(lockPath);
}

function removeOwnLock(lockPath: string): void {
  if (readLockHolder(lockPath) !== process.pid) return; // not ours any more
  try {
    unlinkSync(lockPath);
  } catch {}
}

// `start` holds the lock across its setup and several `process.exit()` paths;
// none of them should leave it behind for the stale rule to clean up.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lockPath of heldLocks.keys()) removeOwnLock(lockPath);
    heldLocks.clear();
  });
}

/**
 * The shutdown memory save's own time slot (#549). It is NOT carved out of the drain
 * window: a turn still running at SIGTERM (the #315 restart case) can use the whole
 * drain, and `shutdown.drainTurnsMs: 0` ("stop at once") has no drain at all, yet the
 * save must still run. `claudeclaw stop` used to always run a 30s save of its own.
 */
export const SHUTDOWN_MEMORY_SAVE_MS = 30_000;

/**
 * How long `stop` / `--replace-existing` give a daemon to exit after SIGTERM:
 * its drain window, plus the memory save's own slot, plus a margin for the teardown
 * itself. Settings may not be loaded (or may belong to another project's daemon),
 * hence the default.
 */
export function stopGraceMs(drainTurnsMs?: number): number {
  return (drainTurnsMs ?? 30_000) + SHUTDOWN_MEMORY_SAVE_MS + 5_000;
}

/**
 * The `shutdown.drainTurnsMs` a daemon in `projectDir` is running with, read
 * straight from its `settings.json` (same validation as the loader: finite,
 * >= 0). `undefined` when the file or the field is absent or malformed, so
 * the caller falls back to the default grace. For `stopAll`, which stops
 * daemons of OTHER projects and must not under-run a longer drain they were
 * configured with, and for `stop` / `--replace-existing` before settings are
 * loaded.
 */
export async function readConfiguredDrainMs(projectDir: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(projectDir, ".claude", "claudeclaw", "settings.json"), "utf-8"),
    ) as { shutdown?: { drainTurnsMs?: unknown } };
    const v = raw?.shutdown?.drainTurnsMs;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A PID from a PID file, strictly: plain decimal digits, an integer in [1, 2^22].
 * `Number()` would accept "", "0x10", "1e3" and " "; `kill(0)` / `kill(-1)` address
 * process groups. Anything else is `null`.
 */
export function parseDaemonPid(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,8}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 && n <= 4_194_304 ? n : null;
}

/**
 * The command line of `pid` (`ps -o command=`), or null if it cannot be read. Slim
 * containers (ubuntu:24.04, #526/#527) have no `ps`, so fall back to
 * `/proc/<pid>/cmdline` (NUL-separated arguments, joined by spaces).
 */
export function readProcessCommand(
  pid: number,
  readProcCmdline: (pid: number) => string | null = readProcCmdlineFile,
): string | null {
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2_000,
    });
    if (!r.error && r.status === 0) {
      const out = String(r.stdout).trim();
      if (out !== "") return out;
    }
  } catch {
    // fall through to /proc
  }
  return readProcCmdline(pid);
}

/** `/proc/<pid>/cmdline` -> a command line: arguments are NUL-separated. */
export function parseProcCmdline(raw: string): string | null {
  const out = raw.replaceAll("\0", " ").trim();
  return out === "" ? null : out;
}

function readProcCmdlineFile(pid: number): string | null {
  try {
    return parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * What the daemon's command line looks like. `src/index.ts` runs the daemon for `start`
 * AND for any argument that is not one of the other subcommands it dispatches on (its
 * final `else` is `start()`), so the real launches carry no `start` token:
 * `bun run src/index.ts --web` (commands/start.md, docs/deploy-systemd-hardening.md),
 * `bun run src/index.ts` (package.json `start`), `bun --watch src/index.ts start ...`.
 * The `claudeclaw` shim follows the same rule (`claudeclaw start`, bare `claudeclaw`),
 * possibly behind an interpreter (`bun /usr/local/bin/claudeclaw start`,
 * `/usr/bin/env bun .../claudeclaw start`).
 *
 * So the entry (or shim) must be followed by the end of the line or by a first argument
 * that is NOT a non-daemon subcommand (`NON_DAEMON_SUBCOMMANDS`, mirroring src/index.ts).
 * A bare `bun` is NOT enough: any unrelated Bun app that inherits a stale PID would
 * otherwise be signalled. `src` must be a whole path component (so `fake-src/index.ts`
 * does not match) and the entry must be exactly `index.ts` (`src/index.tsx start` does
 * not match). `(?=\S)` makes `\s+` take the whole gap, so extra spaces cannot be
 * backtracked into to hide a subcommand.
 */
const NON_DAEMON_SUBCOMMANDS =
  "(?:--help|-h|help|--stop-all|--stop|--clear|status|telegram|discord|slack|send|fire)(?:\\s|$)";
const DAEMON_ARGS = `(?:\\s*$|\\s+(?=\\S)(?!${NON_DAEMON_SUBCOMMANDS}))`;
const INTERPRETER = "(?:\\S*\\/)?(?:env|bun|node)(?:\\s+(?:-\\S+|run))*\\s+";
const DAEMON_ENTRY = new RegExp(`(?:^|[\\s/])src\\/index\\.ts${DAEMON_ARGS}`);
const DAEMON_SHIM = new RegExp(`^(?:${INTERPRETER})*(?:\\S*\\/)?claudeclaw${DAEMON_ARGS}`);

/** The working directory of `pid` (Linux `/proc`, else `lsof`), or null if unreadable. */
export function readProcessCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // no /proc (macOS) or not ours: fall through to lsof
  }
  try {
    const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      timeout: 2_000,
    });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout)
      .split("\n")
      .find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export type StopTarget =
  | { kind: "ok"; pid: number }
  /** The PID file does not hold a usable PID. Nothing may be probed or signalled. */
  | { kind: "invalid" }
  /** Alive, but not this project's daemon: a recycled PID. */
  | { kind: "not-daemon"; pid: number; command: string }
  /** PID 1 with nothing confirming it is ours: init / the service manager. */
  | { kind: "refuse-pid1"; pid: 1 };

/**
 * Decide whether a PID file's contents may be treated as the daemon to stop.
 *
 * The command line must have the daemon's shape (`DAEMON_ENTRY` / `DAEMON_SHIM`), and,
 * when the process's working directory can be read, that directory must be `projectDir`:
 * the PID file lives under the project and the daemon never changes directory, so the
 * same entry script running elsewhere is another project's app. Where the command line
 * cannot be read (no `ps`, process gone) this falls back to trusting the PID file, as
 * before; where only the cwd cannot be read, the command shape alone decides. PID 1 is
 * the exception: in a container the daemon really is PID 1 (#526), on a host it is init,
 * so it needs the command line to say so.
 */
export function decideStopTarget(
  raw: string,
  readCommand: (pid: number) => string | null = readProcessCommand,
  readCwd: (pid: number) => string | null = readProcessCwd,
  projectDir: string = process.cwd(),
): StopTarget {
  const pid = parseDaemonPid(raw);
  if (pid === null) return { kind: "invalid" };
  const command = readCommand(pid);
  if (command === null) return pid === 1 ? { kind: "refuse-pid1", pid: 1 } : { kind: "ok", pid };
  if (!DAEMON_ENTRY.test(command) && !DAEMON_SHIM.test(command)) {
    return { kind: "not-daemon", pid, command };
  }
  const cwd = readCwd(pid);
  if (cwd !== null && !sameDir(cwd, projectDir)) return { kind: "not-daemon", pid, command };
  return { kind: "ok", pid };
}
