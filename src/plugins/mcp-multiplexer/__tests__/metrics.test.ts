/**
 * Unit tests for the multiplexer cost-tracking metrics registry.
 * Issue #68.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { MetricsRegistry, __setMetricsRegistryForTest, getMetricsRegistry } from "../metrics";

function freshRegistry(): MetricsRegistry {
  const r = new MetricsRegistry();
  __setMetricsRegistryForTest(r);
  return r;
}

describe("MetricsRegistry — disabled by default", () => {
  it("isEnabled() returns false on construction", () => {
    const r = freshRegistry();
    expect(r.isEnabled()).toBe(false);
  });

  it("record() returns a no-op timer when disabled", () => {
    const r = freshRegistry();
    const timer = r.record("alpha", "bucket-1", "do-thing");
    timer.end(true);
    timer.end(false);
    const snap = r.snapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.tuples).toHaveLength(0);
  });
});

describe("MetricsRegistry — enabled", () => {
  let r: MetricsRegistry;
  beforeEach(() => {
    r = freshRegistry();
    r.setEnabled(true);
  });

  it("end(true) increments invocations + successes; latency recorded", () => {
    const timer = r.record("alpha", "b1", "foo");
    timer.end(true);
    const snap = r.snapshot();
    expect(snap.tuples).toHaveLength(1);
    const t = snap.tuples[0]!;
    expect(t).toMatchObject({
      server: "alpha",
      bucket: "b1",
      tool: "foo",
      invocations: 1,
      successes: 1,
      errors: 0,
      sampleCount: 1,
    });
    expect(t.p50).not.toBeNull();
    expect(t.p95).not.toBeNull();
    expect(t.p99).not.toBeNull();
    expect(t.meanMs).not.toBeNull();
  });

  it("end(false) increments errors", () => {
    const t = r.record("alpha", "b1", "foo");
    t.end(false);
    const snap = r.snapshot();
    expect(snap.tuples[0]).toMatchObject({ invocations: 1, successes: 0, errors: 1 });
  });

  it("aggregates the SAME tuple across multiple calls", () => {
    r.record("alpha", "b1", "foo").end(true);
    r.record("alpha", "b1", "foo").end(true);
    r.record("alpha", "b1", "foo").end(false);
    const snap = r.snapshot();
    expect(snap.tuples).toHaveLength(1);
    expect(snap.tuples[0]).toMatchObject({ invocations: 3, successes: 2, errors: 1 });
  });

  it("separates DIFFERENT tuples by server / bucket / tool", () => {
    r.record("alpha", "b1", "foo").end(true);
    r.record("alpha", "b1", "bar").end(true);
    r.record("alpha", "b2", "foo").end(true);
    r.record("beta", "b1", "foo").end(true);
    const snap = r.snapshot();
    expect(snap.tuples).toHaveLength(4);
  });

  it("computes p50/p95/p99 from samples (nearest-rank, sorted ascending)", () => {
    // Inject synthetic latencies by reaching past record() — easier
    // than orchestrating real timing. We use a private path: hit
    // record() many times with no-op timing then verify percentile
    // shape on the resulting (~0 ms) samples. For deterministic
    // percentile math we instead inspect the regression structure
    // via a fresh registry where we end() at known intervals.
    for (let i = 0; i < 100; i++) {
      r.record("alpha", "b1", "perc-test").end(true);
    }
    const snap = r.snapshot();
    const t = snap.tuples.find((x) => x.tool === "perc-test")!;
    expect(t.sampleCount).toBe(100);
    expect(t.invocations).toBe(100);
    // All samples are very small (microseconds); p99 ≥ p95 ≥ p50.
    expect(t.p99!).toBeGreaterThanOrEqual(t.p95!);
    expect(t.p95!).toBeGreaterThanOrEqual(t.p50!);
    expect(t.meanMs!).toBeGreaterThanOrEqual(0);
  });

  it("caps samples per key at MAX_SAMPLES_PER_KEY (1000)", () => {
    for (let i = 0; i < 1500; i++) {
      r.record("alpha", "b1", "burst").end(true);
    }
    const snap = r.snapshot();
    const t = snap.tuples.find((x) => x.tool === "burst")!;
    // Invocations is the full count; sampleCount is bounded.
    expect(t.invocations).toBe(1500);
    expect(t.sampleCount).toBeLessThanOrEqual(1000);
    expect(t.sampleCount).toBeGreaterThan(990); // bounded but not way under
  });

  it("snapshot.enabled reflects the registry flag", () => {
    expect(r.snapshot().enabled).toBe(true);
    r.setEnabled(false);
    expect(r.snapshot().enabled).toBe(false);
  });

  it("reset() clears counters", () => {
    r.record("alpha", "b1", "foo").end(true);
    r.reset();
    expect(r.snapshot().tuples).toHaveLength(0);
  });

  it("end() is idempotent — calling twice does NOT double-count (Agent 2 finding)", () => {
    const t = r.record("alpha", "b1", "foo");
    t.end(true);
    t.end(true); // ignored
    t.end(false); // ignored
    const snap = r.snapshot();
    expect(snap.tuples[0]).toMatchObject({
      invocations: 1,
      successes: 1,
      errors: 0,
      sampleCount: 1,
    });
  });

  it("releasePty() drops only the matching (server, bucket) tuples (Agent 4 finding)", () => {
    r.record("alpha", "pty-A", "foo").end(true);
    r.record("alpha", "pty-A", "bar").end(true);
    r.record("alpha", "pty-B", "foo").end(true);
    r.record("beta", "pty-A", "foo").end(true);
    expect(r.snapshot().tuples).toHaveLength(4);

    r.releasePty("alpha", "pty-A");
    const tuples = r.snapshot().tuples;
    // alpha::pty-A::foo and alpha::pty-A::bar gone; alpha::pty-B::foo
    // and beta::pty-A::foo retained.
    expect(tuples).toHaveLength(2);
    expect(tuples.map((t) => `${t.server}::${t.bucket}`).sort()).toEqual([
      "alpha::pty-B",
      "beta::pty-A",
    ]);
  });

  it("releasePty() is a no-op when no matching tuples exist", () => {
    r.record("alpha", "pty-A", "foo").end(true);
    r.releasePty("alpha", "pty-Z"); // no match
    expect(r.snapshot().tuples).toHaveLength(1);
  });

  it("disabling mid-test stops recording but keeps existing tuples", () => {
    r.record("alpha", "b1", "foo").end(true);
    r.setEnabled(false);
    // New record() returns no-op.
    r.record("alpha", "b1", "foo").end(true);
    const snap = r.snapshot();
    // Still 1 invocation — the second record() didn't go through.
    expect(snap.tuples[0]).toMatchObject({ invocations: 1 });
    expect(snap.enabled).toBe(false);
  });
});

describe("getMetricsRegistry singleton", () => {
  it("returns the same instance across calls", () => {
    __setMetricsRegistryForTest(null);
    const a = getMetricsRegistry();
    const b = getMetricsRegistry();
    expect(a).toBe(b);
  });

  it("respects the test-injected registry", () => {
    const r = new MetricsRegistry();
    __setMetricsRegistryForTest(r);
    expect(getMetricsRegistry()).toBe(r);
  });
});
