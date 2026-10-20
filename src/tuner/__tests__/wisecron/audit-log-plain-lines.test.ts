/**
 * Regression tests for #472: the tuner audit file has two writers — the
 * hash-chained `AuditLog` and the plain `auditLog()` in core/security.ts, which
 * appends `{ts, event, ...payload}` with no seq/prev_hash/hash. A plain line
 * must never be adopted as the chain head, on reopen (loadTail) or on the
 * multi-writer resync before each append.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditRecord } from "../../../skills-tuner/core/audit-log.js";

let dir: string;
const logPath = () => join(dir, "audit.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-plain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A line exactly as `auditLog()` in core/security.ts writes it. */
function appendPlain(event: string, payload: Record<string, unknown> = {}): void {
  appendFileSync(
    logPath(),
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
}

function chainedRecords(): AuditRecord[] {
  return readFileSync(logPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Partial<AuditRecord>)
    .filter((r): r is AuditRecord => "hash" in r) as AuditRecord[];
}

/** Re-derive the chain over the chained records only, with the real verifier. */
function chainedVerifies(): boolean {
  const only = join(dir, "chained-only.jsonl");
  writeFileSync(
    only,
    `${chainedRecords()
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  );
  return new AuditLog(only).verifyChain().ok;
}

describe("AuditLog — plain auditLog() lines are never the chain head (#472)", () => {
  it("reopening a file whose last line is plain chains off the last chained record", () => {
    // The engine's plain lines interleave with the chained ones, so the last
    // chained record is separated from its predecessor by a plain line too.
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendPlain("apply_attempted", { subject: "s" });
    const r2 = first.append({ event: "verdict", subject: "s" });
    appendPlain("proposal_created", { subject: "s", proposal_id: "p1" });

    const r3 = new AuditLog(logPath()).append({ event: "revert", subject: "s" });

    expect(r3.seq).toBe(3);
    expect(r3.prev_hash).toBe(r2.hash);
    expect(chainedRecords().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(chainedVerifies()).toBe(true);
  });

  it("every later chained record keeps a numeric seq (no seq:null on disk)", () => {
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendPlain("apply_attempted", { subject: "s" });
    first.append({ event: "verdict", subject: "s" });
    appendPlain("subject_state_drift_detected", { subject: "s" });
    const reopened = new AuditLog(logPath());
    reopened.append({ event: "revert", subject: "s" });
    appendPlain("proposal_created", { subject: "s" });
    reopened.append({ event: "gate_mature", subject: "s" });

    expect(readFileSync(logPath(), "utf8")).not.toContain('"seq":null');
    expect(chainedRecords().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(chainedVerifies()).toBe(true);
  });

  it("a second writer's append past a plain line is adopted, not forked", () => {
    const a = new AuditLog(logPath());
    a.append({ event: "proposal", subject: "s" });
    a.append({ event: "verdict", subject: "s" });
    appendPlain("proposal_created", { subject: "s" });
    // Another process appends a genuine chained record after the plain line.
    const b3 = new AuditLog(logPath()).append({ event: "gate_apply", subject: "s" });
    expect(b3.seq).toBe(3);

    // `a` must chain off b's record, not re-issue seq 3 off its stale state.
    const a4 = a.append({ event: "revert", subject: "s" });
    expect(a4.seq).toBe(4);
    expect(a4.prev_hash).toBe(b3.hash);
    expect(chainedVerifies()).toBe(true);
  });

  it("a file already carrying seq:null records resumes from the last numeric seq", () => {
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendPlain("apply_attempted", { subject: "s" });
    const good = first.append({ event: "verdict", subject: "s" });
    // What the bug left behind: a plain line, then chained records with seq:null.
    appendPlain("proposal_created", { subject: "s" });
    appendFileSync(
      logPath(),
      `${JSON.stringify({ seq: null, ts: new Date().toISOString(), hash: "e".repeat(64), event: "revert", actor: "system" })}\n`,
    );

    const next = new AuditLog(logPath()).append({ event: "revert", subject: "s" });
    expect(typeof next.seq).toBe("number");
    expect(next.seq).toBe(good.seq + 1);
    expect(next.prev_hash).toBe(good.hash);
  });

  it("when the resync cannot verify the tail's link, the reopened head is still the last chained record", () => {
    // A torn middle line (crash mid-append) ends the resync's backward walk, so
    // the resync keeps the head the reopen computed — it must not be a plain line.
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendFileSync(logPath(), '{"seq":2,"event":"verdict","ha\n');
    appendPlain("apply_attempted", { subject: "s" });
    const tail = first.append({ event: "verdict", subject: "s" });
    appendPlain("proposal_created", { subject: "s" });

    const next = new AuditLog(logPath()).append({ event: "revert", subject: "s" });
    expect(next.seq).toBe(tail.seq + 1);
    expect(next.prev_hash).toBe(tail.hash);
  });

  it("a line with a numeric seq but no hash is not a chain head", () => {
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendPlain("apply_attempted", { subject: "s" });
    const good = first.append({ event: "verdict", subject: "s" });
    appendPlain("proposal_created", { subject: "s", seq: 9 });

    const next = new AuditLog(logPath()).append({ event: "revert", subject: "s" });
    expect(next.seq).toBe(good.seq + 1);
    expect(next.prev_hash).toBe(good.hash);
  });

  it("a line that parses to a non-object JSON value neither throws nor becomes the head", () => {
    const first = new AuditLog(logPath());
    first.append({ event: "proposal", subject: "s" });
    appendPlain("apply_attempted", { subject: "s" });
    const good = first.append({ event: "verdict", subject: "s" });
    appendFileSync(logPath(), "null\n42\n");

    let next: AuditRecord | undefined;
    expect(() => {
      next = new AuditLog(logPath()).append({ event: "revert", subject: "s" });
    }).not.toThrow();
    expect(next?.seq).toBe(good.seq + 1);
    expect(next?.prev_hash).toBe(good.hash);
  });

  it("a seq that cannot be continued (non-integer, out of range, not positive) is not a head", () => {
    // Written as JSON text: "1e999" parses to Infinity, which no JS literal can spell without lint noise.
    for (const seq of ["1e999", "2.5", "-5", "0", String(Number.MAX_SAFE_INTEGER + 2)]) {
      rmSync(logPath(), { force: true });
      const first = new AuditLog(logPath());
      first.append({ event: "proposal", subject: "s" });
      appendPlain("apply_attempted", { subject: "s" });
      const good = first.append({ event: "verdict", subject: "s" });
      appendFileSync(logPath(), `{"seq":${seq},"hash":"${"d".repeat(64)}","event":"revert"}\n`);

      const next = new AuditLog(logPath()).append({ event: "revert", subject: "s" });
      expect(next.seq).toBe(good.seq + 1);
      expect(next.prev_hash).toBe(good.hash);
    }
  });

  it("plain lines spanning more than the first resync read window still let a second writer's record be adopted", () => {
    const a = new AuditLog(logPath());
    a.append({ event: "proposal", subject: "s" });
    const r2 = a.append({ event: "verdict", subject: "s" });
    // ~150 KB of plain lines: more than the resync's first 64 KB window.
    for (let i = 0; i < 1500; i++)
      appendPlain("proposal_created", { subject: "s", note: "x".repeat(60) });
    const b3 = new AuditLog(logPath()).append({ event: "gate_apply", subject: "s" });
    expect(b3.seq).toBe(3);
    expect(b3.prev_hash).toBe(r2.hash);
    for (let i = 0; i < 1500; i++)
      appendPlain("apply_attempted", { subject: "s", note: "y".repeat(60) });

    const a4 = a.append({ event: "revert", subject: "s" });
    expect(a4.seq).toBe(4);
    expect(a4.prev_hash).toBe(b3.hash);
  });
});
