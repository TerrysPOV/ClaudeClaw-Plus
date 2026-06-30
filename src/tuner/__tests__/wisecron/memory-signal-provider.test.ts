import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySignalProducer } from "../../wisecron/memory-signal-provider.ts";

const range = (a: string, b: string) => ({ start: new Date(a), end: new Date(b) });
const HISTORY = [
  { ts: "2026-06-28T00:00:00.000Z", bytes: 10000, entries: 100, deadRatio: 0, loadMs: 1.0 },
  { ts: "2026-06-29T00:00:00.000Z", bytes: 14000, entries: 122, deadRatio: 0.02, loadMs: 1.6 },
  { ts: "2026-06-30T00:00:00.000Z", bytes: 20000, entries: 150, deadRatio: 0.05, loadMs: 2.4 },
].map((s) => JSON.stringify(s)).join("\n") + "\n";

describe("MemorySignalProducer — memory_signal telemetry stream", () => {
  let dir: string;
  let historyPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memsig-"));
    historyPath = join(dir, "memory-signal-history.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advertises memory_signal UNAVAILABLE when no history file", () => {
    const caps = new MemorySignalProducer({ historyPath }).capabilities();
    expect(caps[0]!.stream).toBe("memory_signal");
    expect(caps[0]!.available).toBe(false);
    expect(caps[0]!.reason).toContain("not found");
  });

  it("advertises AVAILABLE once samples exist", () => {
    writeFileSync(historyPath, HISTORY);
    const caps = new MemorySignalProducer({ historyPath }).capabilities();
    expect(caps[0]!.available).toBe(true);
  });

  it("queries the latency series (default metric=loadMs) within a range", async () => {
    writeFileSync(historyPath, HISTORY);
    const p = new MemorySignalProducer({ historyPath });
    const rows = await p.query("memory_signal", range("2026-06-28T00:00:00Z", "2026-07-01T00:00:00Z"));
    expect(rows.map((r) => r.value)).toEqual([1.0, 1.6, 2.4]);
    expect(rows[0]!.ts).toBeInstanceOf(Date);
    expect(rows[2]!.labels!.dead_ratio).toBe("0.05");
  });

  it("respects the half-open time window [start, end)", async () => {
    writeFileSync(historyPath, HISTORY);
    const rows = await new MemorySignalProducer({ historyPath }).query(
      "memory_signal",
      range("2026-06-29T00:00:00Z", "2026-06-30T00:00:00Z"),
    );
    expect(rows).toHaveLength(1); // 06-29 in, 06-30 excluded (end is open)
    expect(rows[0]!.value).toBe(1.6);
  });

  it("series a different dimension via filters.metric", async () => {
    writeFileSync(historyPath, HISTORY);
    const p = new MemorySignalProducer({ historyPath });
    const r = range("2026-06-28T00:00:00Z", "2026-07-01T00:00:00Z");
    expect((await p.query("memory_signal", r, { metric: "bytes" })).map((x) => x.value)).toEqual([10000, 14000, 20000]);
    expect((await p.query("memory_signal", r, { metric: "dead_ratio" })).map((x) => x.value)).toEqual([0, 0.02, 0.05]);
  });

  it("returns nothing for a different stream", async () => {
    writeFileSync(historyPath, HISTORY);
    const rows = await new MemorySignalProducer({ historyPath }).query(
      "memory_access",
      range("2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    );
    expect(rows).toEqual([]);
  });

  it("tolerates a corrupt line without throwing", async () => {
    writeFileSync(historyPath, HISTORY + "{not json}\n");
    const rows = await new MemorySignalProducer({ historyPath }).query(
      "memory_signal",
      range("2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    );
    expect(rows).toHaveLength(3);
  });
});
