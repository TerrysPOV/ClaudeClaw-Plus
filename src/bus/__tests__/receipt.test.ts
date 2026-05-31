/**
 * Tests for the per-message receipt chain (issue #207).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReceiptStore,
  hashPrompt,
  defaultReceiptLogPath,
  type ReceiptRecord,
} from "../receipt";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeclaw-receipt-test-"));
  logPath = join(tmpDir, "receipts.jsonl");
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function readReceipts(): ReceiptRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ReceiptRecord);
}

describe("hashPrompt", () => {
  test("produces a stable sha256-prefixed short hash", () => {
    const h1 = hashPrompt("hello");
    const h2 = hashPrompt("hello");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[a-f0-9]{16}$/);
  });

  test("different inputs produce different hashes", () => {
    expect(hashPrompt("foo")).not.toBe(hashPrompt("bar"));
  });
});

describe("defaultReceiptLogPath", () => {
  test("ends with .claude/claudeclaw/receipts.jsonl under homedir", () => {
    const p = defaultReceiptLogPath();
    expect(p.endsWith("/.claude/claudeclaw/receipts.jsonl")).toBe(true);
  });
});

describe("ReceiptStore", () => {
  test("opens a receipt, closes it, and appends one JSONL line", async () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("tg-1", { selected_route: "agent=default", agent_id: "default" });
    expect(r.message_id).toBe("tg-1");
    expect(r.record.final_state).toBe("message_polled"); // sentinel until close
    await r.close("turn_observed");

    const recs = readReceipts();
    expect(recs.length).toBe(1);
    expect(recs[0].message_id).toBe("tg-1");
    expect(recs[0].final_state).toBe("turn_observed");
    expect(recs[0].selected_route).toBe("agent=default");
    expect(typeof recs[0].duration_ms).toBe("number");
  });

  test("patch() merges fields but cannot override identity or final state", async () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("tg-2");
    r.patch({ session_id: "abc", process_pid: 4242 });
    // attempt to clobber identity — must be ignored
    r.patch({ message_id: "EVIL", received_at: "1970-01-01", final_state: "wedged_prompt" });
    await r.close("turn_observed");

    const [rec] = readReceipts();
    expect(rec.message_id).toBe("tg-2");
    expect(rec.session_id).toBe("abc");
    expect(rec.process_pid).toBe(4242);
    expect(rec.final_state).toBe("turn_observed"); // patch did not change it
  });

  test("close() is idempotent — second call is a no-op", async () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("tg-3");
    await r.close("turn_observed");
    await r.close("wedged_prompt"); // should be ignored

    const recs = readReceipts();
    expect(recs.length).toBe(1);
    expect(recs[0].final_state).toBe("turn_observed");
  });

  test("open() with same message_id returns the same receipt and merges new fields", async () => {
    const store = createReceiptStore({ path: logPath });
    const r1 = store.open("tg-4", { agent_id: "default" });
    const r2 = store.open("tg-4", { session_id: "sid-1" });
    expect(r1).toBe(r2);
    expect(r1.record.session_id).toBe("sid-1");
    expect(r1.record.agent_id).toBe("default");
  });

  test("find() returns an open receipt without creating one", () => {
    const store = createReceiptStore({ path: logPath });
    expect(store.find("ghost")).toBeUndefined();
    const r = store.open("tg-5");
    expect(store.find("tg-5")).toBe(r);
  });

  test("drain() closes every open receipt with the given final state", async () => {
    const store = createReceiptStore({ path: logPath });
    store.open("a");
    store.open("b");
    store.open("c");
    await store.drain("timeout");
    const recs = readReceipts();
    expect(recs.length).toBe(3);
    expect(recs.every((r) => r.final_state === "timeout")).toBe(true);
    expect(recs.every((r) => r.notes?.drained === true)).toBe(true);
  });

  test("missing parent directory is created on first append", async () => {
    const deep = join(tmpDir, "a", "b", "c", "receipts.jsonl");
    const store = createReceiptStore({ path: deep });
    await store.open("x").close("turn_observed");
    expect(existsSync(deep)).toBe(true);
  });

  test("write failures surface to onError and never throw", async () => {
    const errs: { err: Error; ctx: string }[] = [];
    const store = createReceiptStore({
      path: "/dev/null/nope/receipts.jsonl",
      onError: (err, ctx) => errs.push({ err, ctx }),
    });
    await expect(store.open("tg-x").close("turn_observed")).resolves.toBeUndefined();
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.ctx === "append" || e.ctx === "mkdir")).toBe(true);
  });

  test("duration_ms reflects the time between open and close", async () => {
    let t = 0;
    const fakeNow = () => new Date(t);
    const store = createReceiptStore({ path: logPath, now: fakeNow });
    const r = store.open("tg-time");
    t += 1234;
    await r.close("turn_observed");
    const [rec] = readReceipts();
    expect(rec.duration_ms).toBe(1234);
  });

  test("notes from patch and close are merged on the final record", async () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("tg-notes");
    r.patch({ notes: { stage1: "ok" } });
    await r.close("turn_observed", { stage2: "done" });
    const [rec] = readReceipts();
    expect(rec.notes).toEqual({ stage1: "ok", stage2: "done" });
  });
});
