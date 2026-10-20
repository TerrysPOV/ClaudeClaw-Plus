import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordModeDispatch,
  setModeDispatchSink,
  resetModeDispatchSink,
  fileModeDispatchSink,
  type ModeDispatchEvent,
} from "../../governance/mode-dispatch-journal";
import { classifyTask, selectModel as legacySelectModel } from "../../model-router";
import {
  selectModel as governanceSelectModel,
  configureRouter,
} from "../../governance/model-router";
import type { AgenticMode } from "../../config";

const MODES: AgenticMode[] = [
  { name: "coding", model: "claude-3-5-sonnet", keywords: ["fix", "refactor"], phrases: [] },
  { name: "planning", model: "claude-3-opus", keywords: ["roadmap"], phrases: ["design the"] },
];

describe("mode-dispatch-journal", () => {
  afterEach(() => resetModeDispatchSink());

  it("is a no-op until a sink is installed (no accidental writes in tests/CLI)", () => {
    // Default sink is inert: this must not throw and must not touch disk.
    expect(() => recordModeDispatch({ mode: "coding", matched_keyword: "fix" })).not.toThrow();
  });

  it("fills ts (now) and defaults reclassified=false", () => {
    const seen: ModeDispatchEvent[] = [];
    setModeDispatchSink((e) => seen.push(e));
    const before = Date.now();
    recordModeDispatch({ mode: "planning", matched_keyword: "design" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe("planning");
    expect(seen[0]?.matched_keyword).toBe("design");
    expect(seen[0]?.reclassified).toBe(false);
    expect(new Date(seen[0]?.ts).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("honors an explicit reclassified flag and ts", () => {
    const seen: ModeDispatchEvent[] = [];
    setModeDispatchSink((e) => seen.push(e));
    recordModeDispatch({
      mode: "coding",
      matched_keyword: "refactor",
      reclassified: true,
      ts: "2026-05-20T00:00:00.000Z",
    });
    expect(seen[0]?.reclassified).toBe(true);
    expect(seen[0]?.ts).toBe("2026-05-20T00:00:00.000Z");
  });

  it("never throws even when the sink itself throws", () => {
    setModeDispatchSink(() => {
      throw new Error("sink boom");
    });
    expect(() => recordModeDispatch({ mode: "x", matched_keyword: "" })).not.toThrow();
  });

  describe("fileModeDispatchSink", () => {
    let dir: string;
    let path: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mode-dispatch-"));
      path = join(dir, "nested", "mode_dispatch.jsonl");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("appends one JSON line per event, creating the parent dir", () => {
      setModeDispatchSink(fileModeDispatchSink(path));
      recordModeDispatch({
        mode: "coding",
        matched_keyword: "bug",
        ts: "2026-05-20T01:00:00.000Z",
      });
      recordModeDispatch({
        mode: "planning",
        matched_keyword: "design",
        reclassified: true,
        ts: "2026-05-20T02:00:00.000Z",
      });
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] ?? "") as ModeDispatchEvent;
      expect(first).toEqual({
        ts: "2026-05-20T01:00:00.000Z",
        mode: "coding",
        matched_keyword: "bug",
        reclassified: false,
      });
      const second = JSON.parse(lines[1] ?? "") as ModeDispatchEvent;
      expect(second.reclassified).toBe(true);
    });
  });
});

describe("classifyTask matchedKeyword (dispatch-point provenance)", () => {
  it("surfaces the matched phrase", () => {
    const c = classifyTask("please design the new API", MODES, "coding");
    expect(c.mode).toBe("planning");
    expect(c.matchedKeyword).toBe("design the");
  });

  it("surfaces the first matched keyword for a keyword-scored route", () => {
    const r = legacySelectModel("can you refactor this", MODES, "coding");
    expect(r.taskType).toBe("coding");
    expect(r.matchedKeyword).toBe("refactor");
  });

  it("returns an empty matchedKeyword on a default fallback (no signal)", () => {
    const c = classifyTask("hello there", MODES, "coding");
    expect(c.matchedKeyword).toBe("");
  });

  it("returns an empty matchedKeyword on a tie fallback (the tie-break picked the mode)", () => {
    // "fix" (coding) and "roadmap" (planning) score one point each; defaultMode breaks the tie.
    const c = classifyTask("fix the roadmap", MODES, "coding");
    expect(c.mode).toBe("coding");
    expect(c.matchedKeyword).toBe("");
  });
});

describe("governance selectModel → recordModeDispatch (integration)", () => {
  afterEach(() => resetModeDispatchSink());

  it("emits one mode_dispatch event when a prompt is classified against modes", async () => {
    const seen: ModeDispatchEvent[] = [];
    setModeDispatchSink((e) => seen.push(e));
    configureRouter({
      modes: MODES,
      defaultMode: "coding",
      defaultProvider: "anthropic",
      defaultModel: "claude-3-5-sonnet",
    });

    await governanceSelectModel({ prompt: "please refactor the parser", taskType: "coding" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe("coding");
    expect(seen[0]?.matched_keyword).toBe("refactor");
    expect(seen[0]?.reclassified).toBe(false);
  });
});

describe("daemon wiring (runner.ts installs the file sink)", () => {
  // ensureGovernanceRouter is module-private and runner.ts is too heavy to
  // import here, so assert at source level (same approach as
  // pty-backward-compat.test.ts). Without this install, the sink stays a no-op
  // and mode_dispatch.jsonl is never written by the live daemon.
  it("ensureGovernanceRouter calls setModeDispatchSink(fileModeDispatchSink())", async () => {
    const src = await Bun.file(join(process.cwd(), "src", "runner.ts")).text();
    const start = src.indexOf("function ensureGovernanceRouter(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("setModeDispatchSink(fileModeDispatchSink())");
  });
});
