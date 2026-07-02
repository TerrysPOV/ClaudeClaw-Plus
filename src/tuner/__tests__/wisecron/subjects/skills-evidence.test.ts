import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsSubject } from "../../../subjects/skills-subject.js";
import type { StructuredEvidence, LocalSignal } from "../../../wisecron/evidence-driven.js";

describe("SkillsSubject — EvidenceDrivenSubject (proactive)", () => {
  let dir: string, log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sk-"));
    log = join(dir, "access.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = (skills: string[], accessed: string[]) => {
    for (const s of skills) writeFileSync(join(dir, `${s}.md`), "skill");
    writeFileSync(
      log,
      accessed.map((s) => JSON.stringify({ skill_path: join(dir, `${s}.md`) })).join("\n") + "\n",
    );
  };
  const subj = () => new SkillsSubject({ scanDirs: [dir], skillAccessLog: log });
  const ev = (o: Partial<StructuredEvidence> = {}): StructuredEvidence => ({
    technique: "skill-description-optimization",
    independentSources: 5,
    highTrustSources: 2,
    provenInProduction: false,
    citations: ["a", "b"],
    ...o,
  });
  const degraded: LocalSignal = {
    metric: "skills_dead_ratio",
    value: 0.8,
    unit: "ratio",
    degraded: true,
    trend: "degrading",
    sampledAt: "2026-06-30T00:00:00Z",
  };

  it("researchSpec declares the skills topic + technique", () => {
    const spec = subj().researchSpec();
    expect(spec.subject).toBe("skills");
    expect(spec.technique).toBe("skill-description-optimization");
  });
  it("localSignal: most skills DEAD → degraded", async () => {
    setup(["a", "b", "c", "d", "e", "f"], ["a"]); // 5/6 dead > 0.5
    const sig = await subj().localSignal();
    expect(sig.metric).toBe("skills_dead_ratio");
    expect(sig.degraded).toBe(true);
  });
  it("localSignal: most skills USED → not degraded", async () => {
    setup(["a", "b", "c", "d"], ["a", "b", "c", "d"]);
    expect((await subj().localSignal()).degraded).toBe(false);
  });
  it("localSignal: STALE/empty access log → not degraded (broken telemetry, not unused skills)", async () => {
    for (const sk of ["a", "b", "c", "d", "e", "f"]) writeFileSync(join(dir, sk + ".md"), "s");
    writeFileSync(log, ""); // empty/stale log
    expect(
      (await new SkillsSubject({ scanDirs: [dir], skillAccessLog: log }).localSignal()).degraded,
    ).toBe(false);
  });
  it("localSignal: too few skills → not degraded (below floor)", async () => {
    setup(["a", "b"], []);
    expect((await subj().localSignal()).degraded).toBe(false);
  });
  it("evaluate: degraded + convergent → recommendation", () => {
    const v = subj().evaluate(ev(), degraded);
    expect(v.propose).toBe(true);
    expect(v.kind).toBe("patch"); // optimising a description = content the subject applies itself
  });
  it("evaluate: weak evidence → no proposal", () => {
    expect(
      subj().evaluate(ev({ independentSources: 1, highTrustSources: 0 }), degraded).propose,
    ).toBe(false);
  });
  it("proposeEvidencePatch: builds a real content patch targeting a dead skill inside scan_dirs", async () => {
    setup(["a", "b", "c", "d", "e", "f"], ["a"]); // b..f dead
    const patch = await subj().proposeEvidencePatch(ev(), degraded);
    expect(patch).not.toBeNull();
    expect(patch!.target_path.startsWith(dir)).toBe(true); // confined to scan_dirs
    expect(patch!.alternatives.length).toBeGreaterThan(0);
  });
  it("proposeEvidencePatch: no dead skill → null (nothing to optimise, never invents)", async () => {
    setup(["a", "b", "c", "d"], ["a", "b", "c", "d"]); // all accessed
    expect(await subj().proposeEvidencePatch(ev(), degraded)).toBeNull();
  });
});
