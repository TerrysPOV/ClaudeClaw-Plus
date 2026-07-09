/**
 * Memory-pressure probe (#178): detect the cgroup "freeze zone" from inside
 * the daemon.
 *
 * When anything in the service cgroup pushes usage above systemd's
 * `MemoryHigh`, the kernel throttles the WHOLE cgroup
 * (`mem_cgroup_handle_over_high`, processes stuck in D state) without
 * OOM-killing anything. With swap absorbing the growth, `memory.current`
 * can sit between High and Max indefinitely: the daemon is neither dead nor
 * alive — the gateway port LISTENs but handlers never run, and liveness
 * heuristics see trickling progress. Restarting the daemon is futile (the
 * fresh process lands in the same saturated cgroup). Observed in production
 * 2026-07-08: one runaway grep spawned by an agent Bash tool call froze the
 * whole tree for hours.
 *
 * This module reads the daemon's own cgroup v2 memory files so the health
 * surface can EXPOSE the condition — external monitors then know to kill the
 * hog inside the cgroup instead of restart-looping the daemon. See
 * docs/deploy-systemd-hardening.md for the unit limits that prevent the
 * freeze zone in the first place (MemoryHigh/MemoryMax/**MemorySwapMax**).
 *
 * Cgroup v1 or non-Linux hosts report `supported: false` and cost nothing.
 */

import { readFileSync } from "node:fs";

export interface MemoryPressure {
  /** false when the cgroup v2 memory files aren't readable (v1, macOS, container quirks). */
  supported: boolean;
  /** The freeze-zone signal: memory.current above memory.high. */
  overHigh: boolean;
  currentBytes: number | null;
  /** null = "max" (no soft limit configured — no freeze zone possible). */
  highBytes: number | null;
  maxBytes: number | null;
  swapCurrentBytes: number | null;
  swapMaxBytes: number | null;
  /** memory.events "high" counter: how many times the high boundary was crossed. */
  highEvents: number | null;
}

export interface MemoryPressureDeps {
  /** Override for tests. Default: /sys/fs/cgroup. */
  cgroupRoot?: string;
  /** Override for tests. Default: /proc/self/cgroup. */
  procSelfCgroup?: string;
}

const UNSUPPORTED: MemoryPressure = {
  supported: false,
  overHigh: false,
  currentBytes: null,
  highBytes: null,
  maxBytes: null,
  swapCurrentBytes: null,
  swapMaxBytes: null,
  highEvents: null,
};

function readNum(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw === "max") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readHighEvents(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^high (\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function readMemoryPressure(deps: MemoryPressureDeps = {}): MemoryPressure {
  const cgroupRoot = deps.cgroupRoot ?? "/sys/fs/cgroup";
  const procSelfCgroup = deps.procSelfCgroup ?? "/proc/self/cgroup";

  // cgroup v2 unified hierarchy: a single "0::<path>" line.
  let cgPath: string | null = null;
  try {
    const lines = readFileSync(procSelfCgroup, "utf-8").split("\n");
    for (const line of lines) {
      if (line.startsWith("0::")) {
        cgPath = line.slice(3).trim();
        break;
      }
    }
  } catch {
    return UNSUPPORTED;
  }
  if (!cgPath) return UNSUPPORTED;

  const base = `${cgroupRoot}${cgPath}`;
  const currentBytes = readNum(`${base}/memory.current`);
  if (currentBytes === null) return UNSUPPORTED;

  const highBytes = readNum(`${base}/memory.high`);
  const maxBytes = readNum(`${base}/memory.max`);
  const swapCurrentBytes = readNum(`${base}/memory.swap.current`);
  const swapMaxBytes = readNum(`${base}/memory.swap.max`);
  const highEvents = readHighEvents(`${base}/memory.events`);

  return {
    supported: true,
    overHigh: highBytes !== null && currentBytes > highBytes,
    currentBytes,
    highBytes,
    maxBytes,
    swapCurrentBytes,
    swapMaxBytes,
    highEvents,
  };
}
