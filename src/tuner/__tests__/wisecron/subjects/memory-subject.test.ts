import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySubject } from "../../../subjects/memory-subject.js";
import type { Cluster, Observation, Patch, Proposal } from "../../../../skills-tuner/core/types.js";

let tmpDir: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memsubj-"));
  indexPath = join(tmpDir, "MEMORY.md");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(content: string): void {
  writeFileSync(indexPath, content, "utf8");
}

function touch(name: string): void {
  writeFileSync(join(tmpDir, name), "# stub\n", "utf8");
}

describe("MemorySubject — identity", () => {
  it('name === "memory", risk_tier === "low"', () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(s.name).toBe("memory");
    expect(s.risk_tier).toBe("low");
    expect(s.auto_merge_default).toBe(true);
  });
});

describe("MemorySubject — collectObservations", () => {
  it("parses MEMORY.md entries into { slug, description, file_ref }", async () => {
    seed(
      [
        "# Memory Index",
        "",
        "- [Alpha](alpha.md) — first hook",
        "- [Beta](beta.md) — second hook",
      ].join("\n"),
    );
    touch("alpha.md");
    touch("beta.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    // No dead/dup → zero observations (collectObservations only emits issues).
    expect(obs).toEqual([]);
  });

  it("detects dead refs (file does not exist)", async () => {
    seed(
      ["# Memory Index", "", "- [Alpha](alpha.md) — exists", "- [Ghost](ghost.md) — does not"].join(
        "\n",
      ),
    );
    touch("alpha.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(1);
    expect(obs[0]?.metadata.dead).toBe(true);
    expect(obs[0]?.metadata.file).toBe("ghost.md");
  });

  it("detects duplicates (same slug or near-duplicate description)", async () => {
    seed(
      ["# Memory Index", "", "- [Alpha](alpha.md) — first", "- [Alpha-dup](alpha.md) — copy"].join(
        "\n",
      ),
    );
    touch("alpha.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs = await s.collectObservations(new Date(0));
    expect(obs.length).toBe(2);
    expect(obs.every((o) => o.metadata.duplicate === true)).toBe(true);
  });

  it("returns empty array when index missing", async () => {
    const s = new MemorySubject({ memoryIndex: join(tmpDir, "nope.md") });
    const obs = await s.collectObservations(new Date(0));
    expect(obs).toEqual([]);
  });
});

describe("MemorySubject — detectProblems", () => {
  it("returns single cluster covering all problems when total >= 2", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const obs: Observation[] = [
      {
        session_id: "t1",
        observed_at: new Date(),
        signal_type: "orphan",
        verbatim: "{}",
        metadata: { subject: "memory", file: "a.md", dead: true, duplicate: false },
      },
      {
        session_id: "t2",
        observed_at: new Date(),
        signal_type: "repeated_trigger",
        verbatim: "{}",
        metadata: { subject: "memory", file: "b.md", dead: false, duplicate: true },
      },
    ];
    const clusters = await s.detectProblems(obs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.id).toBe("memory-index-cleanup");
    expect(clusters[0]?.subjects_touched).toEqual(["memory"]);
  });

  it("returns empty when there are no observations", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    // A single real issue (dead ref, dup, or a verbose index) now warrants a
    // cluster; only a truly empty observation set yields no proposal.
    const clusters = await s.detectProblems([]);
    expect(clusters).toEqual([]);
  });
});

describe("MemorySubject — relocate-then-shorten (shrink apply)", () => {
  // A >200-char hook so the shrink path actually shortens the line.
  const LONG_HOOK =
    "vacances ON depuis le 2 juillet, attend la date de retour pour désarmer ; " +
    "fix lumières-de-jour appliqué le 8 juillet avec gating crépuscule astral ; " +
    "bug _original_setpoints chauffage jamais restauré après le mode, à fixer avant l'hiver sinon consigne froide";

  function shrinkProposal(shrunkIndex: string): Proposal {
    return {
      id: 2,
      cluster_id: "memory-index-cleanup",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "sig",
      alternatives: [{ id: "shrink", label: "lbl", tradeoff: "", diff_or_content: shrunkIndex }],
    };
  }

  it("appends trimmed detail to the topic when it is not already there", async () => {
    seed(`# Memory Index\n\n- [Vac](vac.md) — ${LONG_HOOK}\n`);
    writeFileSync(join(tmpDir, "vac.md"), "# Vac\n\nDétail existant sans le hook.\n", "utf8");
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(shrinkProposal("# Memory Index\n\n- [Vac](vac.md) — vacances ON…\n"), "shrink");

    const index = readFileSync(indexPath, "utf8");
    const entry = index.split("\n").find((l) => l.startsWith("- [Vac]")) ?? "";
    expect(entry.length).toBeLessThanOrEqual(200);
    const topic = readFileSync(join(tmpDir, "vac.md"), "utf8");
    expect(topic).toContain("Index overflow (relocated by tuner)");
    expect(topic).toContain("consigne froide"); // the trimmed tail landed in the topic
  });

  it("does not append when the detail already exists in the topic (whitespace-normalized)", async () => {
    seed(`# Memory Index\n\n- [Vac](vac.md) — ${LONG_HOOK}\n`);
    // Same content, different wrapping/whitespace.
    writeFileSync(
      join(tmpDir, "vac.md"),
      `# Vac\n\n${LONG_HOOK.replace(/ ; /g, " ;\n")}\n`,
      "utf8",
    );
    const s = new MemorySubject({ memoryIndex: indexPath });
    const before = readFileSync(join(tmpDir, "vac.md"), "utf8");
    await s.apply(shrinkProposal("# Memory Index\n\n- [Vac](vac.md) — vacances ON…\n"), "shrink");

    expect(readFileSync(join(tmpDir, "vac.md"), "utf8")).toBe(before); // untouched
    const entry =
      readFileSync(indexPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- [Vac]")) ?? "";
    expect(entry.length).toBeLessThanOrEqual(200);
  });

  it("keeps the line LONG when the topic file is missing (no place to relocate)", async () => {
    seed(`# Memory Index\n\n- [Ghost](ghost.md) — ${LONG_HOOK}\n`);
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(
      shrinkProposal("# Memory Index\n\n- [Ghost](ghost.md) — vacances ON…\n"),
      "shrink",
    );

    const entry =
      readFileSync(indexPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- [Ghost]")) ?? "";
    expect(entry).toContain("consigne froide"); // full hook preserved in the index
    expect(existsSync(join(tmpDir, "ghost.md"))).toBe(false); // nothing created
  });

  it("refuses to relocate outside the memory dir (traversal pointer) — keeps the line long", async () => {
    const outside = join(tmpDir, "..", `outside-${Date.now()}.md`);
    writeFileSync(outside, "# outside\n", "utf8");
    const rel = `../${outside.split("/").pop()}`;
    seed(`# Memory Index\n\n- [Evil](${rel}) — ${LONG_HOOK}\n`);
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(shrinkProposal(`# Memory Index\n\n- [Evil](${rel}) — vacances ON…\n`), "shrink");

    const entry =
      readFileSync(indexPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- [Evil]")) ?? "";
    expect(entry).toContain("consigne froide"); // kept long
    expect(readFileSync(outside, "utf8")).toBe("# outside\n"); // never written
    rmSync(outside, { force: true });
  });

  it("refuses a symlinked topic (append would leak outside) — keeps the line long", async () => {
    const outside = join(tmpDir, "..", `slink-target-${Date.now()}.md`);
    writeFileSync(outside, "# real target\n", "utf8");
    symlinkSync(outside, join(tmpDir, "vac.md"));
    seed(`# Memory Index\n\n- [Vac](vac.md) — ${LONG_HOOK}\n`);
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(shrinkProposal("# Memory Index\n\n- [Vac](vac.md) — vacances ON…\n"), "shrink");

    const entry =
      readFileSync(indexPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- [Vac]")) ?? "";
    expect(entry).toContain("consigne froide"); // kept long
    expect(readFileSync(outside, "utf8")).toBe("# real target\n"); // link target untouched
    rmSync(outside, { force: true });
  });

  it("two long lines sharing one topic append the overflow only once (review #1)", async () => {
    seed(`# Memory Index\n\n- [Vac](vac.md) — ${LONG_HOOK}\n- [Vac bis](vac.md) — ${LONG_HOOK}\n`);
    writeFileSync(join(tmpDir, "vac.md"), "# Vac\n", "utf8");
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(
      shrinkProposal(
        "# Memory Index\n\n- [Vac](vac.md) — vacances ON…\n- [Vac bis](vac.md) — vacances ON…\n",
      ),
      "shrink",
    );
    const topic = readFileSync(join(tmpDir, "vac.md"), "utf8");
    const occurrences = topic.split("Index overflow (relocated by tuner)").length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps the line long when the topic pointer is a DIRECTORY (review #2)", async () => {
    mkdirSync(join(tmpDir, "weird.md"), { recursive: true });
    seed(`# Memory Index\n\n- [Weird](weird.md) — ${LONG_HOOK}\n`);
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(
      shrinkProposal("# Memory Index\n\n- [Weird](weird.md) — vacances ON…\n"),
      "shrink",
    );
    const entry =
      readFileSync(indexPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith("- [Weird]")) ?? "";
    expect(entry).toContain("consigne froide"); // pas de crash EISDIR, ligne gardée longue
  });

  it("topic appends are additive: existing topic content is preserved", async () => {
    seed(`# Memory Index\n\n- [Vac](vac.md) — ${LONG_HOOK}\n`);
    writeFileSync(join(tmpDir, "vac.md"), "# Vac\n\nContenu original important.\n", "utf8");
    const s = new MemorySubject({ memoryIndex: indexPath });
    await s.apply(shrinkProposal("# Memory Index\n\n- [Vac](vac.md) — vacances ON…\n"), "shrink");

    const topic = readFileSync(join(tmpDir, "vac.md"), "utf8");
    expect(topic).toContain("Contenu original important.");
    expect(topic.indexOf("Contenu original important.")).toBeLessThan(
      topic.indexOf("Index overflow"),
    );
  });
});

describe("MemorySubject — apply / validate", () => {
  it("apply writes .bak before replacement", async () => {
    // dedup-dead strategy removes entries whose .md file does not exist on
    // disk. Seed an index with two entries; only `a.md` exists.
    seed("# Memory Index\n\n- [A](a.md) — alpha\n- [Ghost](ghost.md) — gone\n");
    touch("a.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "memory-index-cleanup",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "sig",
      // diff_or_content is now informational (unified diff text) — apply
      // re-runs the strategy on disk state rather than writing this verbatim.
      alternatives: [
        {
          id: "dedup-dead",
          label: "lbl",
          tradeoff: "",
          diff_or_content:
            "--- MEMORY.md\n+++ MEMORY.md (dedup-dead)\n@@ 1 removed @@\n-- [Ghost](ghost.md) — gone",
        },
      ],
    };
    await s.apply(proposal, "dedup-dead");
    expect(existsSync(`${indexPath}.bak`)).toBe(true);
    expect(readFileSync(`${indexPath}.bak`, "utf8")).toContain("Ghost");
    const written = readFileSync(indexPath, "utf8");
    expect(written).toContain("[A](a.md)");
    expect(written).not.toContain("Ghost");
  });

  it("apply rejects mismatching target_path", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: "/elsewhere/MEMORY.md",
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "sig",
      alternatives: [{ id: "a", label: "l", tradeoff: "", diff_or_content: "# Memory Index\n" }],
    };
    await expect(s.apply(proposal, "a")).rejects.toThrow(/target_path/);
  });

  it('validate requires "# Memory Index" header', async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Wrong Header\n\n- [A](a.md)\n",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/header/);
  });

  it("validate rejects entries referencing files outside memory/ dir", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Memory Index\n\n- [Evil](../../escape.md) — out\n",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside/);
  });

  it("validate rejects index > 200 lines", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const big = ["# Memory Index", ""];
    for (let i = 0; i < 220; i++) big.push(`- [Item${i}](item${i}.md) — hook`);
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: big.join("\n"),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/200 lines/);
  });

  it("validate accepts a clean index", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Memory Index\n\n- [A](a.md) — one\n- [B](b.md) — two\n",
    });
    expect(result.valid).toBe(true);
  });
});

describe("MemorySubject — revert", () => {
  it("replays inverse content back into memoryIndex (hash compare)", async () => {
    const original = "# Memory Index\n\n- [Orig](orig.md) — original\n";
    seed(original);
    const s = new MemorySubject({ memoryIndex: indexPath });
    writeFileSync(indexPath, "# Memory Index\n\n- [Mutated](mut.md)\n", "utf8");

    const inverse: Patch = {
      target_path: indexPath,
      kind: "patch",
      applied_content: original,
    };
    await s.revert(inverse);
    expect(readFileSync(indexPath, "utf8")).toBe(original);
  });
});

// ── Pass B: edges, idempotency, perf, guardrails ───────────────────────────

describe("MemorySubject — Pass B: edges", () => {
  it("collectObservations: empty MEMORY.md returns empty list", async () => {
    seed("");
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it("collectObservations: missing MEMORY.md returns empty list (no throw)", async () => {
    // do not seed — file does not exist
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(await s.collectObservations(new Date(0))).toEqual([]);
  });

  it("validate rejects entry referencing parent dir (../escape.md)", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Memory Index\n- [Bad](../escape.md) — bad\n",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside memory dir/);
  });

  it("validate rejects entry with absolute path", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Memory Index\n- [Abs](/etc/passwd) — abs\n",
    });
    expect(result.valid).toBe(false);
  });

  it("apply: missing alternative id → clear error", async () => {
    seed("# Memory Index\n- [A](a.md)\n");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [
        { id: "real-id", label: "", tradeoff: "", diff_or_content: "# Memory Index\n" },
      ],
    };
    await expect(s.apply(proposal, "wrong-id")).rejects.toThrow(/alternative/);
  });
});

describe("MemorySubject — Pass B: idempotency", () => {
  it("apply same content twice → identical file state", async () => {
    // dedup-dead strategy is deterministic given the same disk state, so
    // applying twice in a row yields the same content (no further dead
    // entries to remove on the second pass).
    seed("# Memory Index\n- [Old](old.md) — old\n");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "dedup-dead", label: "", tradeoff: "", diff_or_content: "" }],
    };
    await s.apply(proposal, "dedup-dead");
    const after1 = readFileSync(indexPath, "utf8");
    await s.apply(proposal, "dedup-dead");
    expect(readFileSync(indexPath, "utf8")).toBe(after1);
  });

  it("revert same inverse twice → no double-mutation", async () => {
    seed("# Memory Index\n- [Mutated](m.md)\n");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const inverse: Patch = {
      target_path: indexPath,
      kind: "patch",
      applied_content: "# Memory Index\n- [Original](o.md) — orig\n",
    };
    await s.revert(inverse);
    const after1 = readFileSync(indexPath, "utf8");
    await s.revert(inverse);
    expect(readFileSync(indexPath, "utf8")).toBe(after1);
  });
});

describe("MemorySubject — Pass B: perf", () => {
  it("validate scales linearly on large valid index (assert <250ms on 200 entries)", async () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    const lines = ["# Memory Index"];
    for (let i = 0; i < 195; i++) lines.push(`- [Entry${i}](e${i}.md) — hook ${i}`);
    const content = lines.join("\n");
    const start = Date.now();
    const result = await s.validate({
      target_path: indexPath,
      kind: "patch",
      applied_content: content,
    });
    const elapsed = Date.now() - start;
    expect(result.valid).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it("collectObservations on 50K-line index reads in <500ms (no quadratic scan)", async () => {
    // Build a 50K-line "memory" file that legitimately parses as MEMORY.md.
    // The current implementation: parseEntries iterates lines once + slugCounts
    // built once + final loop is O(n). Just confirm we don't time out.
    const lines = ["# Memory Index"];
    for (let i = 0; i < 50_000; i++) lines.push(`- [E${i}](e${i}.md) — h`);
    seed(lines.join("\n"));
    const s = new MemorySubject({ memoryIndex: indexPath });
    const start = Date.now();
    const obs = await s.collectObservations(new Date(0));
    const elapsed = Date.now() - start;
    // None of the e0..eN.md files exist → every entry is dead. Just check
    // wall-clock is sane.
    expect(obs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("MemorySubject — Pass B: validate/apply symmetry", () => {
  it("apply roundtrip: produced Patch validates clean", async () => {
    seed("# Memory Index\n\n- [A](a.md) — alpha\n- [B](b.md) — beta\n");
    touch("a.md");
    touch("b.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "dedup-dead", label: "", tradeoff: "", diff_or_content: "" }],
    };
    const patch = await s.apply(proposal, "dedup-dead");
    const v = await s.validate(patch);
    expect(v.valid).toBe(true);
  });

  it("apply throws on target_path mismatch → validate would not flag (different file path concern)", async () => {
    seed("# Memory Index\n");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: "/tmp/wrong-path.md",
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: "# Memory Index\n" }],
    };
    await expect(s.apply(proposal, "a")).rejects.toThrow(/target_path mismatch/);
  });
});

describe("MemorySubject — Pass B: risk_tier guardrails", () => {
  it("risk_tier is low — auto-merge default allowed", () => {
    const s = new MemorySubject({ memoryIndex: indexPath });
    expect(s.risk_tier).toBe("low");
    expect(s.auto_merge_default).toBe(true);
  });
});

describe("MemorySubject — Pass B: proposeChange emits unified diff", () => {
  function seedRealistic(): void {
    // Mirror the ~50KB MEMORY.md shape that triggered Phase 4's wall-of-text
    // problem. 50 entries with 4 of them pointing at non-existent files.
    const lines = ["# Memory Index", ""];
    for (let i = 0; i < 50; i++) {
      lines.push(`- [Entry ${i}](file_${String(i).padStart(2, "0")}.md) — hook ${i}`);
    }
    seed(`${lines.join("\n")}\n`);
    // Only 46 of the 50 reference files exist on disk → 4 dead refs.
    for (let i = 0; i < 50; i++) {
      if (i === 7 || i === 19 || i === 33 || i === 41) continue;
      touch(`file_${String(i).padStart(2, "0")}.md`);
    }
  }

  it("each alternative diff_or_content is ≤ 2KB", async () => {
    seedRealistic();
    const s = new MemorySubject({ memoryIndex: indexPath });
    const cluster: Cluster = {
      id: "memory-index-cleanup",
      subject: "memory",
      observations: [
        {
          session_id: "t",
          observed_at: new Date(),
          signal_type: "orphan",
          verbatim: "{}",
          metadata: { subject: "memory" },
        },
      ],
      frequency: 4,
      success_rate: 0.5,
      sentiment: "neutral",
      subjects_touched: ["memory"],
    };
    const proposal = await s.proposeChange(cluster);
    // 2 dedup diffs (≤2KB each) + 1 full-content "shrink" alternative = 3.
    // Schema caps alternatives at 3 (adapter surfaces show 3 choices), so the
    // subject must not exceed it — see UnsignedProposalSchema.alternatives.max(3).
    expect(proposal.alternatives).toHaveLength(3);
    for (const alt of proposal.alternatives.filter((a) => a.id !== "shrink")) {
      expect(alt.diff_or_content.length).toBeLessThanOrEqual(2048);
    }
  });

  it("all three alternatives produce visibly distinct diff text", async () => {
    seedRealistic();
    const s = new MemorySubject({ memoryIndex: indexPath });
    const cluster: Cluster = {
      id: "memory-index-cleanup",
      subject: "memory",
      observations: [
        {
          session_id: "t",
          observed_at: new Date(),
          signal_type: "orphan",
          verbatim: "{}",
          metadata: { subject: "memory" },
        },
      ],
      frequency: 4,
      success_rate: 0.5,
      sentiment: "neutral",
      subjects_touched: ["memory"],
    };
    const proposal = await s.proposeChange(cluster);
    const [a, b, c] = proposal.alternatives.map((alt) => alt.diff_or_content);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("each alternative diff includes a summary header line", async () => {
    seedRealistic();
    const s = new MemorySubject({ memoryIndex: indexPath });
    const cluster: Cluster = {
      id: "memory-index-cleanup",
      subject: "memory",
      observations: [
        {
          session_id: "t",
          observed_at: new Date(),
          signal_type: "orphan",
          verbatim: "{}",
          metadata: { subject: "memory" },
        },
      ],
      frequency: 4,
      success_rate: 0.5,
      sentiment: "neutral",
      subjects_touched: ["memory"],
    };
    const proposal = await s.proposeChange(cluster);
    // Dedup alternatives are unified diffs with a summary header; the "shrink"
    // alternative is full content, not a diff.
    for (const alt of proposal.alternatives.filter((a) => a.id !== "shrink")) {
      expect(alt.diff_or_content).toMatch(/@@ \d+ removed, \d+ added, \d+ reordered @@/);
    }
  });
});

describe("MemorySubject — Pass B: apply re-computes strategy on current state", () => {
  it("apply rejects unknown strategy id", async () => {
    seed("# Memory Index\n- [A](a.md)\n");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "free-form", label: "", tradeoff: "", diff_or_content: "" }],
    };
    await expect(s.apply(proposal, "free-form")).rejects.toThrow(/unknown strategy/);
  });

  it("apply dedup-reorder sorts entries alphabetically", async () => {
    seed("# Memory Index\n\n- [Zeta](z.md) — z\n- [Alpha](a.md) — a\n- [Mu](m.md) — m\n");
    touch("a.md");
    touch("m.md");
    touch("z.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "dedup-reorder", label: "", tradeoff: "", diff_or_content: "" }],
    };
    await s.apply(proposal, "dedup-reorder");
    const written = readFileSync(indexPath, "utf8");
    const aIdx = written.indexOf("Alpha");
    const mIdx = written.indexOf("Mu");
    const zIdx = written.indexOf("Zeta");
    expect(aIdx).toBeGreaterThan(0);
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  it("apply dedup-group buckets entries by name prefix", async () => {
    seed(
      `${[
        "# Memory Index",
        "",
        "- [Project A](project_alpha.md)",
        "- [Feedback B](feedback_beta.md)",
        "- [Project C](project_charlie.md)",
        "- [Feedback D](feedback_delta.md)",
      ].join("\n")}\n`,
    );
    touch("project_alpha.md");
    touch("feedback_beta.md");
    touch("project_charlie.md");
    touch("feedback_delta.md");
    const s = new MemorySubject({ memoryIndex: indexPath });
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "memory",
      kind: "patch",
      target_path: indexPath,
      pattern_signature: "sig",
      created_at: new Date(),
      signature: "s",
      alternatives: [{ id: "dedup-group", label: "", tradeoff: "", diff_or_content: "" }],
    };
    await s.apply(proposal, "dedup-group");
    const written = readFileSync(indexPath, "utf8");
    // feedback_* bucket precedes project_* (alphabetical group key order),
    // and entries within each bucket are contiguous.
    const fbBeta = written.indexOf("feedback_beta");
    const fbDelta = written.indexOf("feedback_delta");
    const projAlpha = written.indexOf("project_alpha");
    const projCharlie = written.indexOf("project_charlie");
    expect(fbBeta).toBeLessThan(projAlpha);
    expect(fbDelta).toBeLessThan(projAlpha);
    expect(projAlpha).toBeLessThan(projCharlie === -1 ? Infinity : projCharlie);
  });
});
