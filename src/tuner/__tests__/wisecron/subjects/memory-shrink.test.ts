import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySubject } from "../../../subjects/memory-subject.js";

let dir: string;
let idx: string;
const stub = { query: async () => [], capabilities: async () => [] } as never;
const range = { start: new Date(0), end: new Date() } as never;
const longHook = (n: number) => "x".repeat(n);

/** Seed a MEMORY.md + matching topic files (so no dead refs). */
function seed(entries: Array<{ name: string; hook: string }>): void {
  for (const e of entries) writeFileSync(join(dir, `${e.name}.md`), "topic body");
  const lines = entries.map((e) => `- [${e.name}](${e.name}.md) — ${e.hook}`);
  writeFileSync(idx, `${lines.join("\n")}\n`);
}
async function proposeShrink(m: MemorySubject) {
  const obs = await m.collectObservations(new Date(0));
  const clusters = await m.detectProblems(obs);
  return m.proposeChange(clusters[0]!);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memshrink-"));
  idx = join(dir, "MEMORY.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemorySubject — context-cost + long-line metrics", () => {
  it("measures long_line_count, context_cost, entry_count", async () => {
    seed([
      { name: "a", hook: longHook(300) },
      { name: "b", hook: "short" },
    ]);
    const f = await new MemorySubject({ memoryIndex: idx }).measureFitness(range, stub);
    expect(f.memory_index_long_line_count).toBe(1);
    expect(f.memory_index_entry_count).toBe(2);
    expect(f.memory_index_context_cost).toBeGreaterThan(0);
  });
});

describe("MemorySubject — deterministic shrink", () => {
  it("drives long_lines to 0, preserves entries, lowers context_cost", async () => {
    seed([
      { name: "a", hook: longHook(300) },
      { name: "b", hook: longHook(300) },
      { name: "c", hook: "ok" },
    ]);
    const m = new MemorySubject({ memoryIndex: idx }); // no llm → deterministic
    const before = await m.measureFitness(range, stub);
    const p = await proposeShrink(m);
    expect(p.alternatives.some((a) => a.id === "shrink")).toBe(true);
    await m.apply(p as never, "shrink");
    const after = await m.measureFitness(range, stub);
    expect(after.memory_index_long_line_count).toBe(0);
    expect(after.memory_index_entry_count).toBe(3); // no entry dropped
    expect(after.memory_index_context_cost).toBeLessThan(
      before.memory_index_context_cost as number,
    );
  });
});

describe("MemorySubject — drift-safe apply (reconcile)", () => {
  it("keeps an entry added between propose and apply (no dropped-pointer error)", async () => {
    seed([{ name: "a", hook: longHook(300) }]);
    const m = new MemorySubject({ memoryIndex: idx });
    const p = await proposeShrink(m); // freezes a snapshot
    // user edits memory AFTER the proposal
    writeFileSync(join(dir, "newone.md"), "x");
    writeFileSync(idx, `${readFileSync(idx, "utf8")}- [New](newone.md) — added after propose\n`);
    await m.apply(p as never, "shrink"); // must NOT throw
    expect(readFileSync(idx, "utf8")).toContain("newone.md");
  });
});

describe("MemorySubject — quality cache", () => {
  it("reads a cached median as memory_entry_quality", async () => {
    seed([{ name: "a", hook: "ok" }]);
    const qc = join(dir, "q.json");
    writeFileSync(
      qc,
      JSON.stringify({ ts: new Date().toISOString(), median: 4, sampleSize: 1, scores: [4] }),
    );
    const f = await new MemorySubject({ memoryIndex: idx, qualityCachePath: qc }).measureFitness(
      range,
      stub,
    );
    expect(f.memory_entry_quality).toBe(4);
  });
  it("omits memory_entry_quality when no cache exists", async () => {
    seed([{ name: "a", hook: "ok" }]);
    const qc = join(dir, "absent.json");
    const f = await new MemorySubject({ memoryIndex: idx, qualityCachePath: qc }).measureFitness(
      range,
      stub,
    );
    expect(f.memory_entry_quality).toBeUndefined();
  });
});
