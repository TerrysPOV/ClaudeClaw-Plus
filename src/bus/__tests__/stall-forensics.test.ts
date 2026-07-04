import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyKill,
  probeProcessTreeCpu,
  appendStallKillAudit,
  RECENT_OUTPUT_MS,
  type StallKillAuditRecord,
} from "../stall-forensics";
import type { ForensicSnapshot, ToolCeiling } from "../stall-watchdog";

const BASH: ToolCeiling = { warnSeconds: 300, killSeconds: 900 };
const snap = (cpuAdvancing: boolean | null, outputRecencyMs: number | null): ForensicSnapshot => ({
  cpuAdvancing,
  outputRecencyMs,
});

/* ── classifyKill truth table ──────────────────────────────────────────── */

describe("classifyKill", () => {
  it("CPU advancing → suspected_false_positive", () => {
    const o = classifyKill(snap(true, null), 950_000, BASH);
    expect(o.classification).toBe("suspected_false_positive");
    expect(o.suggestedKillSeconds).toBeDefined();
  });

  it("recent output (< RECENT_OUTPUT_MS) → suspected_false_positive even if CPU flat/unknown", () => {
    expect(classifyKill(snap(false, RECENT_OUTPUT_MS - 1), 950_000, BASH).classification).toBe(
      "suspected_false_positive",
    );
    expect(classifyKill(snap(null, 500), 950_000, BASH).classification).toBe(
      "suspected_false_positive",
    );
  });

  it("CPU flat + no recent output → genuine_wedge", () => {
    expect(classifyKill(snap(false, null), 950_000, BASH).classification).toBe("genuine_wedge");
    expect(classifyKill(snap(false, RECENT_OUTPUT_MS + 1), 950_000, BASH).classification).toBe(
      "genuine_wedge",
    );
  });

  it("CPU unmeasurable + no recent output → unknown (never claim an unconfirmed wedge)", () => {
    expect(classifyKill(snap(null, null), 950_000, BASH).classification).toBe("unknown");
    expect(classifyKill(snap(null, RECENT_OUTPUT_MS + 1), 950_000, BASH).classification).toBe(
      "unknown",
    );
  });

  it("suggested ceiling is a whole-minute value ≥ 2× the current kill ceiling", () => {
    const o = classifyKill(snap(true, null), 950_000, BASH);
    const suggested = o.suggestedKillSeconds ?? 0;
    expect(suggested % 60).toBe(0);
    expect(suggested).toBeGreaterThanOrEqual(BASH.killSeconds * 2);
  });
});

/* ── probeProcessTreeCpu (degrades gracefully) ─────────────────────────── */

describe("probeProcessTreeCpu", () => {
  it("returns null for a non-existent pid (or when /proc is absent) — never throws", async () => {
    const r = await probeProcessTreeCpu(2_147_483_600, 1);
    expect(r).toBeNull();
  });

  it("returns a boolean or null for a live pid, never throws", async () => {
    const r = await probeProcessTreeCpu(process.pid, 5);
    expect(r === null || typeof r === "boolean").toBe(true);
  });
});

/* ── appendStallKillAudit ──────────────────────────────────────────────── */

describe("appendStallKillAudit", () => {
  const rec = (over?: Partial<StallKillAuditRecord>): StallKillAuditRecord => ({
    ts: "2026-07-03T00:00:00Z",
    agentId: "reg",
    sessionId: "s1",
    tool: "Bash",
    outstandingMs: 950_000,
    killSeconds: 900,
    classification: "genuine_wedge",
    cpuAdvancing: false,
    outputRecencyMs: null,
    ...over,
  });

  it("appends one JSON line per record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stallaudit-"));
    const file = join(dir, "stall-kills.jsonl");
    try {
      await appendStallKillAudit(rec(), file);
      await appendStallKillAudit(
        rec({ classification: "suspected_false_positive", suggestedKillSeconds: 1920 }),
        file,
      );
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const second = JSON.parse(lines[1] ?? "{}");
      expect(second.classification).toBe("suspected_false_positive");
      expect(second.suggestedKillSeconds).toBe(1920);
      expect(second.tool).toBe("Bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws on an unwritable path (best-effort)", async () => {
    await appendStallKillAudit(rec(), "/proc/definitely-not-writable/x.jsonl");
    expect(true).toBe(true); // reached here → no throw
  });
});
