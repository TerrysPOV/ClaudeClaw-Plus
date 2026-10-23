/**
 * The quarantined sessions as chat text, for `/status` on every surface (#591).
 *
 * One line per session KEY (two processes stuck on one key are one session), with the reason
 * codes and the time since the oldest record. Pids, claude session ids and paths stay in the
 * daemon log: chat text carries none of them.
 */
import { type QuarantineInfo, quarantineSnapshot } from "./pty-quarantine.js";

const SHOWN = 5;

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatQuarantineStatus(
  list: QuarantineInfo[] = quarantineSnapshot(),
  now: number = Date.now(),
): string[] {
  const byKey = new Map<string, QuarantineInfo[]>();
  for (const q of list) byKey.set(q.sessionKey, [...(byKey.get(q.sessionKey) ?? []), q]);
  const lines = [`Quarantined sessions: ${byKey.size}`];
  const keys = [...byKey.keys()].sort();
  // Capped like the thread lists beside it: Discord refuses a reply over 2000 characters.
  for (const key of keys.slice(0, SHOWN)) {
    const recs = byKey.get(key)!;
    const reasons = [...new Set(recs.map((r) => r.reason))].join(", ");
    const since = Math.min(...recs.map((r) => r.since));
    const procs = recs.length > 1 ? ` (${recs.length} processes)` : "";
    lines.push(`  • \`${key}\` — ${reasons}${procs}, ${formatAge(now - since)} ago`);
  }
  if (keys.length > SHOWN) lines.push(`  ... and ${keys.length - SHOWN} more`);
  return lines;
}
