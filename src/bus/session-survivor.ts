/**
 * #595 round 2: a claude that outlived its daemon must not share a transcript with the `--resume`
 * that replaces it. The CLI takes no lock on `--resume`, so two writers would both append to one
 * `<id>.jsonl`. Before a spawn resumes a stored session this module looks for a live process of
 * the same uid whose argv names that exact session id, ends it, and proves it gone. Anything it
 * cannot prove (the process table is unreadable, the process will not die) is reported, and the
 * caller rotates to a fresh id instead of resuming.
 *
 * Identity is pid AND start time, read from the process table both before a signal and when
 * confirming. A pid the OS has recycled for another process has a different start time, so it is
 * neither signalled nor mistaken for the survivor.
 */
import { execFile } from "node:child_process";

/** One row of the process table. `start` is the OS's start-time string, an identity beside `pid`. */
export interface ProcessEntry {
  pid: number;
  uid: number;
  start: string;
  args: string;
}

/** The two system calls the guard needs, injectable so tests can fake a table. */
export interface ProcessProbe {
  /** Every process on the host. Rejects when the table cannot be read. */
  list(): Promise<ProcessEntry[]>;
  /** Send `signal` to `pid`. */
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

export type SurvivorOutcome =
  | { kind: "none" }
  | { kind: "reaped"; pids: number[] }
  | { kind: "unconfirmed"; pids: number[] }
  | { kind: "table-unreadable" };

/** How long the survivor gets after SIGTERM, then after SIGKILL, before it counts as unconfirmed. */
export const SURVIVOR_TERM_MS = 3000;
export const SURVIVOR_KILL_MS = 2000;
const POLL_MS = 100;

/**
 * Matches `ps -axww -o pid=,uid=,lstart=,args=` rows. `lstart` is a fixed-shape date
 * ("Thu Oct 23 10:00:00 2026") on macOS and Linux with `LC_ALL=C`.
 */
const ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** The real process table: `ps`, no truncation (`-ww`), C locale so `lstart` has one shape. */
export const systemProcessProbe: ProcessProbe = {
  list: () =>
    new Promise((resolve, reject) => {
      execFile(
        "ps",
        ["-axww", "-o", "pid=,uid=,lstart=,args="],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          const rows: ProcessEntry[] = [];
          for (const line of stdout.split("\n")) {
            const m = ROW.exec(line);
            if (m) rows.push({ pid: Number(m[1]), uid: Number(m[2]), start: m[3], args: m[4] });
          }
          // A table with no rows is a failed read, never a quiet host: ps lists itself.
          if (rows.length === 0) reject(new Error("process table empty"));
          else resolve(rows);
        },
      );
    }),
  kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * Whether `args` is a claude invocation holding session `sessionId`: the id is a WHOLE argv token,
 * directly after `--resume` or `--session-id` (or glued as `--flag=<id>`). A longer id that merely
 * starts with, or contains, this one is not a match.
 */
export function holdsSession(args: string, sessionId: string): boolean {
  const tokens = args.split(/\s+/).filter(Boolean);
  // argv[0]/argv[1] name the program (`claude`, or `node .../claude-code/cli.js`).
  if (!/claude/i.test(tokens.slice(0, 2).join(" "))) return false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "--resume" || t === "--session-id") && tokens[i + 1] === sessionId) return true;
    if (t === `--resume=${sessionId}` || t === `--session-id=${sessionId}`) return true;
  }
  return false;
}

const sameProcess = (a: ProcessEntry, b: ProcessEntry): boolean =>
  a.pid === b.pid && a.start === b.start;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until none of `targets` is present (same pid AND start time) in a fresh table read, or
 * `withinMs` passes. Returns the ones still present; rejects if the table cannot be read.
 */
async function stillPresent(
  probe: ProcessProbe,
  targets: ProcessEntry[],
  withinMs: number,
): Promise<ProcessEntry[]> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const table = await probe.list();
    const left = targets.filter((t) => table.some((p) => sameProcess(p, t)));
    if (left.length === 0 || Date.now() >= deadline) return left;
    await sleep(POLL_MS);
  }
}

/**
 * Terminate every live claude holding `sessionId` and confirm each is gone.
 *
 * SIGTERM first, SIGKILL for what is still there after `termMs`, then `killMs` more to confirm.
 * Before each signal the table is re-read, so a pid that has since been recycled (different start
 * time) is left alone. Never throws: an unreadable table is its own outcome.
 */
export async function reapSessionSurvivors(
  sessionId: string,
  opts: { probe?: ProcessProbe; uid?: number; termMs?: number; killMs?: number } = {},
): Promise<SurvivorOutcome> {
  const probe = opts.probe ?? systemProcessProbe;
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const termMs = opts.termMs ?? SURVIVOR_TERM_MS;
  const killMs = opts.killMs ?? SURVIVOR_KILL_MS;

  // Signal only what the table still shows as the same process (pid AND start time).
  const signal = async (targets: ProcessEntry[], sig: "SIGTERM" | "SIGKILL"): Promise<void> => {
    const table = await probe.list();
    for (const t of targets) {
      if (!table.some((p) => sameProcess(p, t))) continue;
      try {
        probe.kill(t.pid, sig);
      } catch {
        // ESRCH: it exited between the read and the signal. The confirmation below decides.
      }
    }
  };

  try {
    const found = (await probe.list()).filter(
      (p) => p.uid === uid && p.pid !== process.pid && holdsSession(p.args, sessionId),
    );
    if (found.length === 0) return { kind: "none" };
    const pids = found.map((p) => p.pid);

    await signal(found, "SIGTERM");
    let left = await stillPresent(probe, found, termMs);
    if (left.length > 0) {
      await signal(left, "SIGKILL");
      left = await stillPresent(probe, left, killMs);
    }
    return left.length === 0 ? { kind: "reaped", pids } : { kind: "unconfirmed", pids };
  } catch {
    return { kind: "table-unreadable" };
  }
}
