import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsSubject } from "../../../subjects/skills-subject.js";
import { ClaudeCliBackend, type LLMClient } from "../../../../skills-tuner/core/llm.js";

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

  it("OMITS dead_ratio when the access log is not fresh (untrusted, not 0)", async () => {
    skill("alpha", "Alpha");
    skill("beta", "Beta");
    const f = await subject().measureFitness(range, stub);
    // M5: not fresh → omit (0 would read as the OPTIMAL value and reward broken telemetry).
    expect(f.skills_dead_ratio).toBeUndefined();
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

describe("SkillsSubject — description quality judge failure reason", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  /** A CLI backend whose `claude` cannot be found: spawn with an empty PATH → real ENOENT. */
  function missingCli(): ClaudeCliBackend {
    const emptyBin = join(dir, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const spawnNoPath = ((cmd: string, args: string[], opts: object) =>
      spawn(cmd, args, { ...opts, env: { PATH: emptyBin } })) as unknown as typeof spawn;
    return new ClaudeCliBackend({ models: {} } as never, spawnNoPath);
  }
  function judged(llm: LLMClient): SkillsSubject {
    return new SkillsSubject({
      scanDirs: [dir],
      skillAccessLog: logPath,
      qualityCachePath: qcPath,
      llm,
    });
  }
  function cache(): {
    median: unknown;
    failed?: boolean;
    reason?: { code?: string; message: string };
  } {
    return JSON.parse(readFileSync(qcPath, "utf8"));
  }
  function warned(): string {
    return warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  it("records and logs spawn ENOENT instead of a bare median null", async () => {
    skill("alpha", "Alpha does alpha");
    expect(await judged(missingCli()).measureDescriptionQuality(12)).toBeNull();
    const c = cache();
    expect(c.median).toBeNull();
    expect(c.failed).toBe(true);
    expect(c.reason?.code).toBe("ENOENT");
    expect(c.reason?.message).toContain("claude");
    expect(warned()).toContain("skills quality judge failed: ENOENT");
  });

  it("keeps the cycle going: collectObservations does not throw and leaves the reason", async () => {
    skill("alpha", "Alpha does alpha");
    const obs = await judged(missingCli()).collectObservations(new Date(0));
    expect(Array.isArray(obs)).toBe(true);
    expect(cache().reason?.code).toBe("ENOENT");
  });

  it("an unparseable reply gets a reason without the reply text", async () => {
    skill("alpha", "Alpha does alpha");
    const llm: LLMClient = {
      call: async () => "secret-ish reply with no scores",
      modelFor: () => "m",
    };
    expect(await judged(llm).measureDescriptionQuality(12)).toBeNull();
    expect(cache().reason?.code).toBe("UNPARSEABLE");
    expect(readFileSync(qcPath, "utf8")).not.toContain("secret-ish");
    expect(warned()).toContain("UNPARSEABLE");
  });

  function throwing(message: string): LLMClient {
    return {
      call: async () => {
        throw new Error(message);
      },
      modelFor: () => "m",
    };
  }

  it("a malformed score array gets UNPARSEABLE, not the parser's message quoting the reply", async () => {
    skill("alpha", "Alpha does alpha");
    const llm: LLMClient = { call: async () => "[secretish token]", modelFor: () => "m" };
    expect(await judged(llm).measureDescriptionQuality(12)).toBeNull();
    expect(cache().reason?.code).toBe("UNPARSEABLE");
    expect(readFileSync(qcPath, "utf8")).not.toContain("secretish");
    expect(warned()).not.toContain("secretish");
  });

  it("keeps only the first line of an error", async () => {
    skill("alpha", "Alpha does alpha");
    await judged(throwing("spawn failed: boom\nsecond line")).measureDescriptionQuality(12);
    const r = cache().reason;
    expect(r?.code).toBeUndefined();
    expect(r?.message).toBe("spawn failed: boom");
  });

  it("redacts token-shaped text from the reason", async () => {
    skill("alpha", "Alpha does alpha");
    // Built at runtime so the fixture never reads as a committed credential.
    const key = ["sk", "ant", "api03", "AbCdEfGhIjKlMnOp_qrstuv"].join("-");
    await judged(
      throwing(`401 invalid x-api-key ${key} (Bearer abc.def)`),
    ).measureDescriptionQuality(12);
    const r = cache().reason;
    expect(r?.message.startsWith("401 invalid x-api-key [redacted]")).toBe(true);
    expect(readFileSync(qcPath, "utf8")).not.toContain("AbCdEf");
    expect(readFileSync(qcPath, "utf8")).not.toContain("abc.def");
    expect(warned()).not.toContain("AbCdEf");
  });

  it("caps a long error message", async () => {
    skill("alpha", "Alpha does alpha");
    await judged(throwing(`spawn failed: ${"word ".repeat(80)}`)).measureDescriptionQuality(12);
    expect(cache().reason?.message.length).toBe(200);
  });

  it("survives an unprintable thrown value and still stamps the failure", async () => {
    skill("alpha", "Alpha does alpha");
    const llm: LLMClient = {
      call: async () => {
        throw Object.create(null);
      },
      modelFor: () => "m",
    };
    expect(await judged(llm).measureDescriptionQuality(12)).toBeNull();
    expect(cache().reason?.message).toBe("unprintable error");
  });

  it("does not call the judge again within the failure cooldown", async () => {
    skill("alpha", "Alpha does alpha");
    let calls = 0;
    const llm: LLMClient = {
      call: async () => {
        calls++;
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
      modelFor: () => "m",
    };
    await judged(llm).collectObservations(new Date(0));
    await judged(llm).collectObservations(new Date(0));
    expect(calls).toBe(1);
    expect(cache().reason?.code).toBe("ETIMEDOUT");
  });
});
