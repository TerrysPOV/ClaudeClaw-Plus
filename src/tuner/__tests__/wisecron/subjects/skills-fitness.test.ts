import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsSubject } from "../../../subjects/skills-subject.js";

let dir: string;
let logPath: string;
let qcPath: string;
const range = { start: new Date(0), end: new Date() } as never;
const stub = { query: async () => [], capabilities: async () => [] } as never;

/** Seed a directory-format skill (name + description in frontmatter). */
function skill(name: string, description: string): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
  );
}
function subject(): SkillsSubject {
  return new SkillsSubject({ scanDirs: [dir], skillAccessLog: logPath, qualityCachePath: qcPath });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skfit-"));
  logPath = join(dir, "no-access.jsonl");
  qcPath = join(dir, "quality.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SkillsSubject — fitnessSignals contract", () => {
  it("declares the 4 governed metrics with correct directions", () => {
    const sig = subject().fitnessSignals();
    const byName = Object.fromEntries(sig.map((m) => [m.name, m]));
    expect(byName.skills_description_context_cost.direction).toBe("lower_is_better");
    expect(byName.skills_count.direction).toBe("higher_is_better");
    expect(byName.skills_dead_ratio.direction).toBe("lower_is_better");
    expect(byName.skills_description_quality.direction).toBe("higher_is_better");
    // context_cost + dead_ratio are guarded by skills_count (can't game by deleting).
    expect(byName.skills_description_context_cost.guardrails).toContain("skills_count");
    expect(byName.skills_dead_ratio.guardrails).toContain("skills_count");
  });
});

describe("SkillsSubject — measureFitness (deterministic)", () => {
  it("counts skills and sums description tokens", async () => {
    skill("alpha", "Alpha does the alpha thing when you ask for alpha work");
    skill("beta", "Beta");
    const f = await subject().measureFitness(range, stub);
    expect(f.skills_count).toBe(2);
    expect(f.skills_description_context_cost).toBeGreaterThan(0);
  });

  it("context cost rises with longer descriptions", async () => {
    skill("short", "x");
    const low = (await subject().measureFitness(range, stub))
      .skills_description_context_cost as number;
    skill("long", "y".repeat(400));
    const high = (await subject().measureFitness(range, stub))
      .skills_description_context_cost as number;
    expect(high).toBeGreaterThan(low);
  });

  it("dead_ratio is 0 when the access log is not fresh (untrusted)", async () => {
    skill("alpha", "Alpha");
    skill("beta", "Beta");
    const f = await subject().measureFitness(range, stub);
    // No/absent access log → not fresh → we do not trust the ratio → 0.
    expect(f.skills_dead_ratio).toBe(0);
  });

  it("returns no scan fields for an empty skills dir", async () => {
    const f = await subject().measureFitness(range, stub);
    expect(f.skills_count).toBeUndefined();
    expect(f.skills_description_context_cost).toBeUndefined();
  });
});

describe("SkillsSubject — quality cache", () => {
  it("reads a cached median as skills_description_quality", async () => {
    skill("alpha", "Alpha");
    writeFileSync(
      qcPath,
      JSON.stringify({ ts: new Date().toISOString(), median: 4, sampleSize: 1, scores: [4] }),
    );
    const f = await subject().measureFitness(range, stub);
    expect(f.skills_description_quality).toBe(4);
  });

  it("omits skills_description_quality when no cache exists", async () => {
    skill("alpha", "Alpha");
    const f = await subject().measureFitness(range, stub);
    expect(f.skills_description_quality).toBeUndefined();
  });

  it("ignores a malformed quality cache without throwing", async () => {
    skill("alpha", "Alpha");
    writeFileSync(qcPath, "not json {{{");
    const f = await subject().measureFitness(range, stub);
    expect(f.skills_description_quality).toBeUndefined();
    expect(f.skills_count).toBe(1);
  });
});

describe("SkillsSubject — description quality judge (no LLM → null)", () => {
  it("returns null when no LLM is configured", async () => {
    skill("alpha", "Alpha");
    expect(await subject().measureDescriptionQuality(12)).toBeNull();
  });
});
