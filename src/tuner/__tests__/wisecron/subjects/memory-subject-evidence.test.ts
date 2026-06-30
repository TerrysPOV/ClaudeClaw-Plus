import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySubject } from "../../../subjects/memory-subject.js";
import type { StructuredEvidence, LocalSignal } from "../../../wisecron/evidence-driven.js";

describe("MemorySubject — EvidenceDrivenSubject (proactive face)", () => {
  let dir: string;
  let indexPath: string;
  let historyPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memsubj-"));
    indexPath = join(dir, "MEMORY.md");
    historyPath = join(dir, "hist.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const subj = () => new MemorySubject({ memoryIndex: indexPath, signalHistoryPath: historyPath });

  const evidence = (over: Partial<StructuredEvidence> = {}): StructuredEvidence => ({
    technique: "vectorized-retrieval",
    independentSources: 5,
    highTrustSources: 2,
    provenInProduction: false,
    citations: ["u1", "u2", "u3"],
    ...over,
  });
  const signal = (over: Partial<LocalSignal> = {}): LocalSignal => ({
    metric: "memory_load_ms",
    value: 80,
    unit: "ms",
    degraded: true,
    trend: "degrading",
    sampledAt: "2026-06-30T00:00:00Z",
    ...over,
  });

  it("researchSpec declares the memory topic + high-trust tiers + technique", () => {
    const spec = subj().researchSpec();
    expect(spec.subject).toBe("memory");
    expect(spec.technique).toBe("vectorized-retrieval");
    expect(spec.sourceTiers).toContain("enterprise");
  });

  it("localSignal: healthy index (all pointers resolve) → not degraded", async () => {
    writeFileSync(join(dir, "a.md"), "x");
    writeFileSync(join(dir, "b.md"), "y");
    writeFileSync(indexPath, "- [A](a.md) — x\n- [B](b.md) — y\n");
    const sig = await subj().localSignal();
    expect(sig.metric).toBe("memory_load_ms");
    expect(sig.unit).toBe("ms");
    expect(sig.degraded).toBe(false);
  });

  it("localSignal: dead pointers above ratio → degraded", async () => {
    writeFileSync(indexPath, "- [A](missing1.md) — x\n- [B](missing2.md) — y\n");
    const sig = await subj().localSignal();
    expect(sig.degraded).toBe(true);
  });

  it("evaluate: healthy signal → no proposal", () => {
    const v = subj().evaluate(evidence(), signal({ degraded: false }));
    expect(v.propose).toBe(false);
    expect(v.confidence).toBe(0);
  });

  it("evaluate: degraded but evidence below bar → no proposal", () => {
    const v = subj().evaluate(evidence({ independentSources: 1, highTrustSources: 0 }), signal());
    expect(v.propose).toBe(false);
    expect(v.reason).toContain("below bar");
  });

  it("evaluate: degraded + convergent high-trust evidence → RECOMMENDATION carrying proof", () => {
    const v = subj().evaluate(evidence(), signal());
    expect(v.propose).toBe(true);
    expect(v.kind).toBe("recommendation"); // architectural = detect-only, never auto-applied
    expect(v.confidence).toBeGreaterThan(0);
    expect(v.reason).toContain("independent sources");
  });

  it("evaluate: production-proven evidence lifts confidence even without high-trust sources", () => {
    const v = subj().evaluate(
      evidence({ highTrustSources: 0, provenInProduction: true }),
      signal(),
    );
    expect(v.propose).toBe(true);
    expect(v.reason).toContain("proven in production");
  });

  it("confirm: latency improved (after < before) → true", async () => {
    writeFileSync(indexPath, "- [A](missing.md) — x\n"); // tiny index → low load latency
    const improved = await subj().confirm(signal({ value: 9999 }));
    expect(improved).toBe(true);
  });
});
