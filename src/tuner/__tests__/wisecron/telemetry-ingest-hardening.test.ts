/**
 * Regression tests for untrusted-input hardening in the telemetry ingest path.
 *
 * Two confirmed bugs, both from transcripts/logs the host does NOT control:
 *  (a) SessionJsonl `scanFile` iterated `message.content` with `for...of`; a
 *      non-array content (`{"message":{"content":{}}}`) threw TypeError that
 *      escaped scanFile/collect/query/capabilities — crashing the whole
 *      telemetry surface (capabilities() is sync and feeds the activation gate).
 *  (b) HookExec coerced `duration_ms` with `Number(...)` straight into a sample
 *      `value`; a non-numeric field yielded NaN, poisoning downstream mean/p95.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionJsonlTelemetryProducer } from "../../wisecron/session-jsonl-provider.js";
import { HookExecTelemetryProducer } from "../../wisecron/host-telemetry-provider.js";
import type { DateRange } from "../../../skills-tuner/core/telemetry.js";

const DAY_MS = 86_400_000;
const NOW_MS = Date.now();
const RANGE: DateRange = {
  start: new Date(NOW_MS - 9 * DAY_MS),
  end: new Date(NOW_MS - 1 * DAY_MS),
};
const IN = new Date(NOW_MS - 5 * DAY_MS); // inside RANGE and the 30d capability probe

describe("SessionJsonl hardening — non-array message.content does not throw", () => {
  let root: string;
  let sessionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sessions-harden-"));
    sessionDir = join(root, "-home-x-proj");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRawLines(name: string, lines: string[]): void {
    writeFileSync(join(sessionDir, name), `${lines.join("\n")}\n`);
  }

  it("does not throw when an assistant line's message.content is a non-array", async () => {
    // A malformed assistant line (object content) followed by a well-formed one.
    // Before the fix, `for (const block of {})` threw and took down the scan.
    const malformed = JSON.stringify({
      type: "assistant",
      timestamp: IN.toISOString(),
      message: { role: "assistant", content: {} }, // non-array — the poison
    });
    const nullContent = JSON.stringify({
      type: "assistant",
      timestamp: IN.toISOString(),
      message: { role: "assistant", content: null },
    });
    const good = JSON.stringify({
      type: "assistant",
      timestamp: IN.toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    });
    writeRawLines("s.jsonl", [malformed, nullContent, good]);

    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    // capabilities() is sync and must not throw (activation gate depends on it).
    expect(() => p.capabilities()).not.toThrow();
    // The malformed lines contribute nothing; the good line still yields its sample.
    const samples = await p.query("tool_call", RANGE);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels?.tool).toBe("Bash");
    // Contract: query returns [] (never throws) even for an all-malformed corpus.
    expect(await p.query("agent_dispatch", RANGE)).toEqual([]);
  });

  it("skips a bad file and still scans the rest (per-file tolerance)", async () => {
    // File 1: entirely poison. File 2: valid. One bad file must not lose the good one.
    writeRawLines("bad.jsonl", [
      JSON.stringify({
        type: "assistant",
        timestamp: IN.toISOString(),
        message: { role: "assistant", content: 42 }, // non-array
      }),
    ]);
    writeRawLines("good.jsonl", [
      JSON.stringify({
        type: "assistant",
        timestamp: IN.toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } }],
        },
      }),
    ]);

    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const samples = await p.query("tool_call", RANGE);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels?.tool).toBe("Read");
  });
});

describe("HookExec hardening — non-numeric duration_ms is dropped, not emitted as NaN", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-harden-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drops the sample whose duration_ms is non-numeric and keeps the finite ones", async () => {
    const poison = JSON.stringify({
      hook: "bad",
      exit_code: 0,
      duration_ms: "oops", // Number("oops") === NaN
      event: "PostToolUse",
      ts: IN.toISOString(),
    });
    const good = JSON.stringify({
      hook: "ok",
      exit_code: 0,
      duration_ms: 12,
      event: "PostToolUse",
      ts: IN.toISOString(),
    });
    writeFileSync(join(dir, "exec-log.jsonl"), `${poison}\n${good}\n`);

    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const samples = await p.query("hook_exec", RANGE);
    // Only the finite-duration sample survives; no NaN leaks into the stream.
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(12);
    expect(samples.some((s) => Number.isNaN(s.value))).toBe(false);
    // Sanity: an all-poison corpus yields no samples (not a NaN sample).
    writeFileSync(join(dir, "exec-log.jsonl"), `${poison}\n`);
    const p2 = new HookExecTelemetryProducer({ hooksDir: dir });
    expect(await p2.query("hook_exec", RANGE)).toEqual([]);
  });
});
