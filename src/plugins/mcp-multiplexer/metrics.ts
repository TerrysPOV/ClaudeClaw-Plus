/**
 * Cost-tracking metrics for the MCP multiplexer dispatch path.
 *
 * Issue #68 follow-up to #64. Every `tools/call` going through the
 * multiplexer's per-server bucket already passes through one place
 * (`CallToolRequestSchema` handler in `http-handler.ts`). Wrap that
 * dispatch with `record()` / `end()` and we get per-tuple counters +
 * latency samples for free, with no metrics-pipeline dependency.
 *
 * Granularity (per acceptance criteria on issue #68):
 *   - Tuple key: `(serverName, bucketKey, toolName)` — bucketKey is the
 *     ptyId-equivalent in the multiplexer (one bucket per spawning PTY).
 *   - Counters: invocations, successes, errors.
 *   - Latencies: ring buffer of recent samples (~1000 per tuple) for
 *     p50 / p95 / p99 computation at snapshot time.
 *
 * Disabled by default. Operators opt in via `settings.mcp.metricsEnabled`
 * once they've validated the schema. When disabled, `record()` returns
 * a no-op timer and `snapshot()` returns an empty record — zero cost.
 *
 * No persistence: metrics are in-memory and reset on daemon restart.
 * That's intentional for the MVP — operators who want durability
 * subscribe via the `health()` enrichment hook (see future work).
 */

/** Most recent N samples kept per tuple. Bounded to keep memory
 *  predictable on a long-running daemon. ~1000 doubles ≈ 8 KB per
 *  tuple; 100 tuples → ~800 KB worst case. */
const MAX_SAMPLES_PER_KEY = 1000;

interface MetricsRecord {
  invocations: number;
  successes: number;
  errors: number;
  /** Ring buffer of latency samples (ms). Oldest evicted at cap. */
  latencies: number[];
}

export interface ToolMetricsSnapshot {
  server: string;
  bucket: string;
  tool: string;
  invocations: number;
  successes: number;
  errors: number;
  /** Number of samples retained; ≤ MAX_SAMPLES_PER_KEY. */
  sampleCount: number;
  /** Latency in ms. `null` when no samples yet. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Mean latency in ms across the retained sample set. */
  meanMs: number | null;
}

export interface MetricsRegistrySnapshot {
  enabled: boolean;
  takenAt: string;
  tuples: ToolMetricsSnapshot[];
}

export interface MetricsTimer {
  /** Mark the dispatch finished. `success: false` increments the
   *  error counter; latency is recorded either way. No-op if metrics
   *  are disabled. */
  end(success: boolean): void;
}

const NOOP_TIMER: MetricsTimer = { end: () => undefined };

/**
 * Compute a percentile from a numeric sample array.
 *
 * Uses the nearest-rank method (deterministic, no interpolation —
 * matches what operators typically expect from p50/p95/p99 dashboards).
 * Returns `null` for empty input so the snapshot caller can render a
 * "no data yet" cell instead of zero (misleading).
 */
function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))] ?? null;
}

export class MetricsRegistry {
  private enabled = false;
  private readonly records = new Map<string, MetricsRecord>();

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start timing a dispatch. Returns a timer to be `end()`-ed once the
   * call resolves or throws. The timer is captured at registry level so
   * an interleaved disable mid-call still completes cleanly — disabling
   * stops NEW recordings but doesn't poison in-flight ones.
   */
  record(serverName: string, bucketKey: string, toolName: string): MetricsTimer {
    if (!this.enabled) return NOOP_TIMER;
    const key = `${serverName}::${bucketKey}::${toolName}`;
    const startedAt = performance.now();
    // Idempotency guard (5-agent review Agent 2 finding): if a refactor
    // or test ever double-calls `end()` on the same timer (e.g. a
    // `finally` added alongside the existing try/catch arms), each call
    // would otherwise increment the counters again — silently corrupting
    // invocations/successes/errors. Latch-once on first invocation,
    // ignore subsequent calls.
    let done = false;
    return {
      end: (success: boolean) => {
        if (done) return;
        done = true;
        const latency = performance.now() - startedAt;
        let rec = this.records.get(key);
        if (!rec) {
          rec = { invocations: 0, successes: 0, errors: 0, latencies: [] };
          this.records.set(key, rec);
        }
        rec.invocations += 1;
        if (success) rec.successes += 1;
        else rec.errors += 1;
        rec.latencies.push(latency);
        if (rec.latencies.length > MAX_SAMPLES_PER_KEY) {
          // Evict oldest. Splice is O(N) but N is bounded by
          // MAX_SAMPLES_PER_KEY; this fires at most once per call, so
          // the overhead is one shift per dispatch in steady state.
          rec.latencies.splice(0, rec.latencies.length - MAX_SAMPLES_PER_KEY);
        }
      },
    };
  }

  /**
   * Drop every tuple whose `bucketKey` matches the given PTY id. Called
   * by the handler's `releasePty` on identity revocation so stale
   * percentiles from a reaped PTY don't bleed into the next bucket
   * issued under the same id.
   *
   * 5-agent review Agent 4 finding (class concern from PR #91 P2): the
   * handler clears `_rlWindows` on `releasePty`; the metrics registry
   * needs the same hygiene.
   */
  releasePty(serverName: string, bucketKey: string): void {
    const prefix = `${serverName}::${bucketKey}::`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }

  /** Aggregate snapshot for the `/api/multiplexer/metrics` endpoint. */
  snapshot(): MetricsRegistrySnapshot {
    const tuples: ToolMetricsSnapshot[] = [];
    for (const [key, rec] of this.records.entries()) {
      const [server = "", bucket = "", tool = ""] = key.split("::");
      const sum = rec.latencies.reduce((s, x) => s + x, 0);
      const mean = rec.latencies.length > 0 ? sum / rec.latencies.length : null;
      tuples.push({
        server,
        bucket,
        tool,
        invocations: rec.invocations,
        successes: rec.successes,
        errors: rec.errors,
        sampleCount: rec.latencies.length,
        p50: percentile(rec.latencies, 50),
        p95: percentile(rec.latencies, 95),
        p99: percentile(rec.latencies, 99),
        meanMs: mean,
      });
    }
    return {
      enabled: this.enabled,
      takenAt: new Date().toISOString(),
      tuples,
    };
  }

  /** Reset all counters and samples. Used by tests; not exposed to
   *  the operator API. */
  reset(): void {
    this.records.clear();
  }
}

let registry: MetricsRegistry | null = null;

export function getMetricsRegistry(): MetricsRegistry {
  if (!registry) registry = new MetricsRegistry();
  return registry;
}

/** Test seam — swap in a fresh registry for isolation. */
export function __setMetricsRegistryForTest(r: MetricsRegistry | null): void {
  registry = r;
}
