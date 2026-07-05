/**
 * Hardening regression tests for skills-tuner/core/audit-log.ts.
 *
 * Covers the ultra-review remediation:
 *  - a torn/partial final line never bricks construction (fail-open on read,
 *    fail-closed only on write — the MCP gateway must not wedge on a crash tail)
 *  - `maxRecords` bounds the in-memory window without disturbing the chain
 *  - `rotateBytes` rotates to `<path>.1` and starts a fresh verifiable segment
 *  - a concurrent second writer chains off the real on-disk tail (no fork)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditRecord } from "../../../skills-tuner/core/audit-log.js";

let dir: string;
const logPath = () => join(dir, "chain.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-hardening-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AuditLog — torn-line tolerance (CRITICAL: gateway must not wedge)", () => {
  it("constructs and keeps appending when the existing file ends in a partial line", () => {
    const first = new AuditLog(logPath());
    first.append({ event: "mcp.tool_call", subject: "p" });
    // Simulate a crash mid-appendFileSync: a truncated JSON line at the tail.
    appendFileSync(logPath(), '{"seq":2,"event":"mcp.tool_call","ha');

    // Previously this threw in loadTail -> constructor -> permanent gateway wedge.
    const reopened = new AuditLog(logPath());
    expect(() => reopened.append({ event: "mcp.tool_call", subject: "p" })).not.toThrow();
    // The valid record survived; the torn line was skipped.
    expect(reopened.all().some((r) => r.seq === 1)).toBe(true);
  });

  it("skips a corrupt middle line without throwing", () => {
    writeFileSync(
      logPath(),
      `${[
        '{"seq":1,"hash":"a","event":"proposal"}',
        "not json at all",
        '{"seq":2,"hash":"b","event":"verdict"}',
      ].join("\n")}\n`,
    );
    const reopened = new AuditLog(logPath());
    // Both valid records loaded, garbage dropped.
    expect(reopened.all()).toHaveLength(2);
  });

  it("still fails closed on a genuine write failure (unwritable path)", () => {
    // A path whose parent is a file, not a dir, makes appendFileSync throw.
    const notADir = join(dir, "afile");
    writeFileSync(notADir, "x");
    const bad = new AuditLog(join(notADir, "nested", "chain.jsonl"));
    expect(() => bad.append({ event: "mcp.tool_call_intent", subject: "p" })).toThrow();
  });
});

describe("AuditLog — resyncFromDisk verifies the last link before adopting a tail", () => {
  it("refuses a forged tail that doesn't chain, keeping the genuine head", () => {
    const alog = new AuditLog(logPath());
    const r1 = alog.append({ event: "proposal", subject: "p" });
    // Another writer forges a higher-seq tail whose prev_hash doesn't link to r1
    // and whose hash isn't self-consistent — a fabricated chain head.
    appendFileSync(
      logPath(),
      `${JSON.stringify({
        seq: 2,
        ts: "2020-01-01T00:00:00.000Z",
        prev_hash: "0".repeat(64),
        hash: "f".repeat(64),
        event: "verdict",
        actor: "attacker",
      })}\n`,
    );
    // Our next append must chain off the REAL r1, not the forgery.
    const r2 = alog.append({ event: "verdict", subject: "p" });
    expect(r2.prev_hash).toBe(r1.hash);
    expect(r2.seq).toBe(2); // did not jump to seq 3 off the forged tail
  });

  it("still adopts a genuine cross-writer append (multi-writer chain intact)", () => {
    const a = new AuditLog(logPath());
    const r1 = a.append({ event: "proposal", subject: "p" });
    // A second instance (another process) resyncs onto r1 and appends legitimately.
    const b = new AuditLog(logPath());
    const r2 = b.append({ event: "verdict", subject: "p" });
    expect(r2.prev_hash).toBe(r1.hash);
    // Back in `a`: it must adopt b's genuine record and chain off it.
    const r3 = a.append({ event: "revert", subject: "p" });
    expect(r3.prev_hash).toBe(r2.hash);
    expect(r3.seq).toBe(3);
  });
});

describe("AuditLog — maxRecords bounds memory without breaking the chain", () => {
  it("retains only the last N in memory but keeps seq/hash monotonic on disk", () => {
    const cap = 10;
    const alog = new AuditLog(logPath(), { maxRecords: cap });
    for (let i = 0; i < 50; i++) alog.append({ event: "mcp.tool_call", subject: "p" });

    expect(alog.all().length).toBeLessThanOrEqual(cap);
    // On-disk chain has all 50, still a valid chain from genesis.
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(50);
    const parsed = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(parsed[0].seq).toBe(1);
    expect(parsed[49].seq).toBe(50);
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i].prev_hash).toBe(parsed[i - 1].hash);
    }
  });
});

describe("AuditLog — rotateBytes bounds file size with verifiable segments", () => {
  it("rotates to <path>.1 and the new active segment verifies from genesis", () => {
    const alog = new AuditLog(logPath(), { rotateBytes: 400 });
    for (let i = 0; i < 40; i++)
      alog.append({ event: "mcp.tool_call", subject: "plugin-with-a-longish-name" });

    expect(existsSync(`${logPath()}.1`)).toBe(true);
    // Active file is bounded (well under the pre-rotation total).
    const activeLines = readFileSync(logPath(), "utf8").trim().split("\n");
    expect(activeLines.length).toBeLessThan(40);
    // The active segment restarts at genesis and chains intact.
    const parsed = activeLines.map((l) => JSON.parse(l) as AuditRecord);
    expect(parsed[0].prev_hash).toBe("0".repeat(64));
    expect(parsed[0].seq).toBe(1);
    const reopened = new AuditLog(logPath(), { rotateBytes: 400 });
    expect(reopened.verifyChain().ok).toBe(true);
  });
});

describe("AuditLog — concurrent writers chain off the on-disk tail (no fork)", () => {
  it("a second instance resyncs to the tail written by the first", () => {
    const a = new AuditLog(logPath());
    const b = new AuditLog(logPath()); // opened at the same (empty) point
    a.append({ event: "proposal", subject: "s" }); // a: seq 1
    a.append({ event: "verdict", subject: "s" }); // a: seq 2

    // b still thinks seq=0; without resync it would fork a duplicate seq=1.
    b.append({ event: "revert", subject: "s" });

    const parsed = readFileSync(logPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditRecord);
    const seqs = parsed.map((r) => r.seq);
    // No duplicate seq — b chained off a's tail (seq 3, prev = a's last hash).
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(parsed[parsed.length - 1].seq).toBe(3);
    expect(new AuditLog(logPath()).verifyChain().ok).toBe(true);
  });
});
