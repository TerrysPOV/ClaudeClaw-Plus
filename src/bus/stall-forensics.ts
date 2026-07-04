/**
 * Stall-watchdog auto-discovery forensics.
 *
 * When the stall watchdog kills a wedged session it first captures a best-effort
 * liveness snapshot, then classifies the kill as a genuine wedge vs a suspected
 * false positive (a legit long-running tool we killed too early). A false
 * positive flags the operator with a suggestion to raise the exact ceiling — so
 * conservative defaults self-correct instead of silently harming.
 *
 * OS-specific bits (the `/proc` CPU probe) live here, isolated behind a
 * degrade-to-`null` contract so nothing depends on `/proc` existing (dev/mac).
 * `classifyKill` is pure. SPEC: `.planning/stall-watchdog/SPEC.md` §3.4.
 */

import { readdir, readFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForensicSnapshot, StallKillOutcome, ToolCeiling } from "./stall-watchdog";

/** CPU-tree advance (clock ticks) over the probe window above which we call it "active".
 *  USER_HZ is typically 100 (10ms/tick); 2 ticks ≈ 20ms of CPU distinguishes work
 *  from idle scheduler noise. */
export const CPU_FLOOR_TICKS = 2;

/** Raw output seen within this window ⇒ the tool was alive when we killed it. */
export const RECENT_OUTPUT_MS = 60_000;

/* ── /proc CPU probe (Linux; null elsewhere) ─────────────────────────────── */

interface ProcStat {
  ppid: number;
  /** utime + stime in clock ticks. */
  cpu: number;
}

async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    const txt = await readFile(`/proc/${pid}/stat`, "utf8");
    // `comm` (field 2) is parenthesised and may contain spaces/parens — parse
    // everything after the LAST ')'. Then rest[0]=state(f3), rest[1]=ppid(f4),
    // rest[11]=utime(f14), rest[12]=stime(f15).
    const rparen = txt.lastIndexOf(")");
    if (rparen < 0) return null;
    const rest = txt
      .slice(rparen + 1)
      .trim()
      .split(/\s+/);
    const ppid = Number.parseInt(rest[1] ?? "", 10);
    const utime = Number.parseInt(rest[11] ?? "", 10);
    const stime = Number.parseInt(rest[12] ?? "", 10);
    if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { ppid, cpu: utime + stime };
  } catch {
    return null;
  }
}

/** Sum utime+stime (ticks) across `root` and all its descendants. null if `/proc`
 *  is unavailable or `root` is gone. */
async function sampleTreeCpu(root: number): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null; // non-Linux — no /proc
  }
  const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
  const stats = new Map<number, ProcStat>();
  await Promise.all(
    pids.map(async (p) => {
      const s = await readProcStat(p);
      if (s) stats.set(p, s);
    }),
  );
  if (!stats.has(root)) return null; // the session process is already gone

  const children = new Map<number, number[]>();
  for (const [p, s] of stats) {
    const arr = children.get(s.ppid);
    if (arr) arr.push(p);
    else children.set(s.ppid, [p]);
  }

  const tree = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    if (p === undefined) break;
    for (const c of children.get(p) ?? []) {
      if (!tree.has(c)) {
        tree.add(c);
        stack.push(c);
      }
    }
  }

  let sum = 0;
  for (const p of tree) sum += stats.get(p)?.cpu ?? 0;
  return sum;
}

/**
 * Sample the CPU of the process tree rooted at `pid` twice, `probeMs` apart.
 * Returns `true` if it advanced past the floor (the tool tree is doing work),
 * `false` if flat (idle/blocked), or `null` if unmeasurable (non-Linux / pid gone).
 * Best-effort — never throws.
 */
export async function probeProcessTreeCpu(pid: number, probeMs: number): Promise<boolean | null> {
  const a = await sampleTreeCpu(pid);
  if (a === null) return null;
  await new Promise((r) => setTimeout(r, probeMs));
  const b = await sampleTreeCpu(pid);
  if (b === null) return null;
  return b - a > CPU_FLOOR_TICKS;
}

/* ── Classification (pure) ───────────────────────────────────────────────── */

/** Round up to the next whole minute (seconds). */
function ceilToMinute(seconds: number): number {
  return Math.ceil(seconds / 60) * 60;
}

/**
 * Pure: was the kill justified? A wedge is idle (flat CPU, no recent output); a
 * legit-long tool shows CPU progress OR recent output. When unmeasurable we say
 * `unknown` (never claim a wedge we couldn't confirm). For a suspected false
 * positive, suggest a ceiling ~2× the observed runtime (min 2× current kill).
 */
export function classifyKill(
  snapshot: ForensicSnapshot,
  outstandingMs: number,
  ceiling: ToolCeiling,
): StallKillOutcome {
  const recentOutput =
    snapshot.outputRecencyMs !== null && snapshot.outputRecencyMs < RECENT_OUTPUT_MS;

  if (snapshot.cpuAdvancing === true || recentOutput) {
    const suggestedKillSeconds = Math.max(
      ceiling.killSeconds * 2,
      ceilToMinute((outstandingMs / 1000) * 2),
    );
    return { classification: "suspected_false_positive", suggestedKillSeconds };
  }
  if (snapshot.cpuAdvancing === false) {
    return { classification: "genuine_wedge" };
  }
  return { classification: "unknown" };
}

/* ── Audit log ───────────────────────────────────────────────────────────── */

export interface StallKillAuditRecord {
  ts: string;
  agentId: string;
  sessionId: string;
  tool: string;
  outstandingMs: number;
  killSeconds: number;
  classification: StallKillOutcome["classification"];
  cpuAdvancing: boolean | null;
  outputRecencyMs: number | null;
  suggestedKillSeconds?: number;
}

const AUDIT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const AUDIT_FILE = join(AUDIT_DIR, "stall-kills.jsonl");

/** Append one kill record to `.claude/claudeclaw/stall-kills.jsonl`. Best-effort. */
export async function appendStallKillAudit(
  record: StallKillAuditRecord,
  file: string = AUDIT_FILE,
): Promise<void> {
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* auditing must never break recovery */
  }
}
