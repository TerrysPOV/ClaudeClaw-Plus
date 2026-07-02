/**
 * memory-signal — the memory subject's LOCAL signal (no web, no LLM). Measures the
 * cost + health of the memory index and keeps a history so degradation shows as a
 * trend. This is what `memory-subject.localSignal()` will read; it is also the cheap
 * post-apply CONFIRMATION (re-measure → did it improve?).
 *
 * Signals: load+parse+resolve latency (ms), index size (bytes/entries), dead-entry
 * ratio (pointers to missing files). All from local files — safe inside the tuner.
 *
 *   bun memory-signal.ts <MEMORY.md> [--record]
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MemorySample {
  ts: string;
  bytes: number;
  entries: number;
  deadRatio: number;
  loadMs: number;
}

/** Measure one sample: time the work a recall does (load → parse → resolve pointers). */
export function measureMemorySignal(indexPath: string, nowIso: string): MemorySample {
  const t0 = performance.now();
  const md = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const dir = dirname(indexPath);
  const pointers = [...md.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]!);
  let dead = 0;
  for (const f of pointers) if (!existsSync(join(dir, f))) dead++;
  const loadMs = performance.now() - t0;
  return {
    ts: nowIso,
    bytes: md.length,
    entries: pointers.length,
    deadRatio: pointers.length ? dead / pointers.length : 0,
    loadMs: Math.round(loadMs * 1000) / 1000,
  };
}

/** Append a sample to the history log (one JSON object per line). */
export function recordSample(historyPath: string, sample: MemorySample): void {
  appendFileSync(historyPath, JSON.stringify(sample) + "\n", "utf8");
}

/** Load recent samples (most recent last). Tolerates a missing/corrupt history. */
export function loadHistory(historyPath: string, limit = 30): MemorySample[] {
  if (!existsSync(historyPath)) return [];
  const lines = readFileSync(historyPath, "utf8").trim().split("\n").filter(Boolean);
  const out: MemorySample[] = [];
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/**
 * Trend of a metric over the history: compare the recent half vs the older half.
 * "degrading" if the metric rose by more than `tol` (fractional), etc.
 */
export function trendOf(
  history: MemorySample[],
  pick: (s: MemorySample) => number,
  tol = 0.1,
  minAbsDelta = 0,
): "improving" | "stable" | "degrading" {
  if (history.length < 4) return "stable";
  const mid = Math.floor(history.length / 2);
  const avg = (xs: MemorySample[]) => xs.reduce((a, s) => a + pick(s), 0) / xs.length;
  const older = avg(history.slice(0, mid));
  const recent = avg(history.slice(mid));
  // Noise floor: ignore changes below a minimum ABSOLUTE delta (sub-ms jitter, etc.).
  if (Math.abs(recent - older) <= minAbsDelta) return "stable";
  if (older === 0) return recent > 0 ? "degrading" : "stable";
  const delta = (recent - older) / older;
  if (delta > tol) return "degrading";
  if (delta < -tol) return "improving";
  return "stable";
}

/** The degradation verdict the subject exposes (latency is the primary signal). */
export function memorySignalSummary(
  indexPath: string,
  historyPath: string,
  nowIso: string,
  thresholds: { maxLoadMs?: number; maxDeadRatio?: number } = {},
): { sample: MemorySample; trend: "improving" | "stable" | "degrading"; degraded: boolean } {
  const sample = measureMemorySignal(indexPath, nowIso);
  const history = [...loadHistory(historyPath), sample];
  const trend = trendOf(history, (s) => s.loadMs);
  const degraded =
    trend === "degrading" ||
    sample.loadMs > (thresholds.maxLoadMs ?? Infinity) ||
    sample.deadRatio > (thresholds.maxDeadRatio ?? 0.05);
  return { sample, trend, degraded };
}

if (import.meta.main) {
  const indexPath =
    process.argv[2] ?? `${process.env.HOME}/.claude/projects/-home-simon-agent/memory/MEMORY.md`;
  const historyPath = `${process.env.HOME}/.config/tuner/memory-signal-history.jsonl`;
  const nowIso = new Date().toISOString();
  const { sample, trend, degraded } = memorySignalSummary(indexPath, historyPath, nowIso, {
    maxLoadMs: 50,
    maxDeadRatio: 0.05,
  });
  if (process.argv.includes("--record")) recordSample(historyPath, sample);
  console.log(`[memory-signal] ${JSON.stringify(sample)}`);
  console.log(
    `[memory-signal] trend(loadMs)=${trend} degraded=${degraded} (history: ${loadHistory(historyPath).length} samples)`,
  );
}
