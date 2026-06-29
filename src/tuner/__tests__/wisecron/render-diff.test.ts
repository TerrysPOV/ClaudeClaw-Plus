import { describe, it, expect } from "bun:test";
import { renderDiff } from "../../wisecron/render-diff.js";

describe("renderDiff — header", () => {
  it('emits "--- a / +++ b" header with custom labels', () => {
    const d = renderDiff("x\n", "y\n", { fromLabel: "old", toLabel: "new" });
    expect(d.startsWith("--- old\n+++ new\n")).toBe(true);
  });

  it("summary line reports counts of removed, added, reordered", () => {
    const d = renderDiff("a\nb\nc\n", "a\nd\nc\n");
    expect(d).toMatch(/@@ 1 removed, 1 added, 0 reordered @@/);
  });
});

describe("renderDiff — empty inputs", () => {
  it("empty / empty → header only, zero counts", () => {
    const d = renderDiff("", "");
    expect(d).toMatch(/0 removed, 0 added, 0 reordered/);
  });

  it("equal / equal → zero counts", () => {
    const d = renderDiff("hello\nworld\n", "hello\nworld\n");
    expect(d).toMatch(/0 removed, 0 added, 0 reordered/);
  });
});

describe("renderDiff — additions / deletions", () => {
  it("additions only → only + lines, no - lines", () => {
    const d = renderDiff("a\n", "a\nb\nc\n");
    expect(d).toMatch(/@@ 0 removed, 2 added/);
    expect(d).toContain("+b");
    expect(d).toContain("+c");
    expect(d).not.toMatch(/^-[^-]/m);
  });

  it("deletions only → only - lines", () => {
    const d = renderDiff("a\nb\nc\n", "a\n");
    expect(d).toMatch(/@@ 2 removed, 0 added/);
    expect(d).toContain("-b");
    expect(d).toContain("-c");
    expect(d).not.toMatch(/^\+[^+]/m);
  });

  it("mixed adds and removes", () => {
    const d = renderDiff("a\nb\nc\n", "a\nx\nc\n");
    expect(d).toContain("-b");
    expect(d).toContain("+x");
  });
});

describe("renderDiff — truncation", () => {
  it("respects maxBytes cap with truncation marker", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const d = renderDiff("", big, { maxBytes: 256 });
    expect(d.length).toBeLessThanOrEqual(256);
    expect(d).toContain("[diff truncated]");
  });

  it("does not truncate when within cap", () => {
    const d = renderDiff("a\n", "b\n", { maxBytes: 2048 });
    expect(d).not.toContain("[diff truncated]");
  });
});

describe("renderDiff — reorder detection", () => {
  it("counts reordered lines (present in both at different positions)", () => {
    const d = renderDiff("a\nb\nc\n", "c\nb\na\n");
    // 'a' moved 0→2, 'c' moved 2→0 — count as 2 reordered (one pair).
    // 'b' stays put.
    expect(d).toMatch(/@@ 0 removed, 0 added, [12] reordered/);
  });
});
