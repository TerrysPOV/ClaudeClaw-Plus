/**
 * Tests for the per-message receipt chain (issue #207).
 */
import { describe, test, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReceiptStore,
  hashPrompt,
  defaultReceiptLogPath,
  getDefaultReceiptStore,
  _setDefaultReceiptStoreForTests,
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
    expect(recs.every((r) => r.notes?.reason === "drained")).toBe(true);
  });

  test("a timeout closed without a reason is stamped reason=unspecified", async () => {
    const store = createReceiptStore({ path: logPath });
    await store.open("bare").close("timeout");
    await store.open("noted").close("timeout", { timeout_ms: 5 });
    await store.open("why").close("timeout", { reason: "superseded" });
    await store.open("blank").close("timeout", { reason: "" });
    await store.open("ok").close("turn_observed");
    const byId = Object.fromEntries(readReceipts().map((r) => [r.message_id, r]));
    expect(byId.bare.notes?.reason).toBe("unspecified");
    expect(byId.noted.notes).toEqual({ timeout_ms: 5, reason: "unspecified" });
    expect(byId.why.notes?.reason).toBe("superseded");
    expect(byId.blank.notes?.reason).toBe("unspecified");
    expect(byId.ok.notes).toBeUndefined();
  });

  test("missing parent directory is created on first append", async () => {
    const deep = join(tmpDir, "a", "b", "c", "receipts.jsonl");
    const store = createReceiptStore({ path: deep });
    await store.open("x").close("turn_observed");
    expect(existsSync(deep)).toBe(true);
  });

  test("receipts.jsonl is tightened to 0600 after the first write", async () => {
    const { statSync } = await import("node:fs");
    const store = createReceiptStore({ path: logPath });
    await store.open("mode").close("turn_observed");
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("patch() cannot inject duration_ms — it's always computed at close", async () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("dur-protect");
    r.patch({ duration_ms: 999_999 });
    await r.close("turn_observed");
    const [rec] = readReceipts();
    expect(rec.duration_ms).toBeLessThan(999_999);
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

describe("findByPromptHash", () => {
  test("indexes a receipt opened with a prompt_hash", () => {
    const store = createReceiptStore({ path: logPath });
    const h = hashPrompt("the prompt");
    const r = store.open("tg-h1", { prompt_hash: h });
    expect(store.findByPromptHash(h)).toBe(r);
  });

  test("returns undefined for an unknown hash", () => {
    const store = createReceiptStore({ path: logPath });
    expect(store.findByPromptHash("sha256:0000000000000000")).toBeUndefined();
  });

  test("indexes a receipt that gets its prompt_hash via patch()", () => {
    const store = createReceiptStore({ path: logPath });
    const r = store.open("tg-h2");
    const h = hashPrompt("late hash");
    r.patch({ prompt_hash: h });
    expect(store.findByPromptHash(h)).toBe(r);
  });

  test("close() removes the receipt from the hash index", async () => {
    const store = createReceiptStore({ path: logPath });
    const h = hashPrompt("zap");
    const r = store.open("tg-h3", { prompt_hash: h });
    expect(store.findByPromptHash(h)).toBe(r);
    await r.close("turn_observed");
    expect(store.findByPromptHash(h)).toBeUndefined();
  });

  test("patching prompt_hash to a new value re-indexes", () => {
    const store = createReceiptStore({ path: logPath });
    const h1 = hashPrompt("one");
    const h2 = hashPrompt("two");
    const r = store.open("tg-h4", { prompt_hash: h1 });
    r.patch({ prompt_hash: h2 });
    expect(store.findByPromptHash(h1)).toBeUndefined();
    expect(store.findByPromptHash(h2)).toBe(r);
  });
});

describe("getDefaultReceiptStore", () => {
  test("returns the same instance across calls (singleton)", () => {
    const a = getDefaultReceiptStore();
    const b = getDefaultReceiptStore();
    expect(a).toBe(b);
  });

  test("_setDefaultReceiptStoreForTests swaps the singleton + restores", () => {
    const original = getDefaultReceiptStore();
    const fake = createReceiptStore({ path: logPath });
    const restore = _setDefaultReceiptStoreForTests(fake);
    expect(getDefaultReceiptStore()).toBe(fake);
    restore();
    expect(getDefaultReceiptStore()).toBe(original);
  });
});

describe("confirmTurn — tailer proof on a receipt (#212)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccplus-receipt-turn-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const rows = (p: string) =>
    existsSync(p)
      ? readFileSync(p, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it("patches an open receipt with the transcript path and offset", async () => {
    const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
    const r = store.open("m1", { prompt_hash: hashPrompt("allô") });
    const where = await store.confirmTurn(hashPrompt("allô"), {
      claude_jsonl_path: "/x/s.jsonl",
      turn_event_offset: 4242,
      message_id: "msg_T",
    });
    expect(where).toBe("patched");
    expect(r.record.claude_jsonl_path).toBe("/x/s.jsonl");
    expect(r.record.turn_event_offset).toBe(4242);
    await r.close("turn_observed");
    const [rec] = rows(join(dir, "receipts.jsonl"));
    expect(rec.final_state).toBe("turn_observed");
    expect(rec.turn_event_offset).toBe(4242);
    expect(existsSync(join(dir, "receipt-turns.jsonl"))).toBe(false);
  });

  it("a receipt already closed is not reopened: the proof goes to the side table, joined by message_id", async () => {
    const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
    const r = store.open("m2", { prompt_hash: hashPrompt("late") });
    await r.close("timeout"); // the bridge gave up first
    const where = await store.confirmTurn(hashPrompt("late"), {
      claude_jsonl_path: "/x/s.jsonl",
      turn_event_offset: 99,
    });
    expect(where).toBe("side-table");
    const [rec] = rows(join(dir, "receipts.jsonl"));
    expect(rec.final_state).toBe("timeout"); // close is still the end
    expect(rec.turn_event_offset).toBeUndefined();
    const [side] = rows(join(dir, "receipt-turns.jsonl"));
    expect(side).toMatchObject({
      kind: "turn_confirmed",
      message_id: "m2",
      prompt_hash: hashPrompt("late"),
      claude_jsonl_path: "/x/s.jsonl",
      turn_event_offset: 99,
    });
    expect(typeof side.confirmed_at).toBe("string");
  });

  it("the two boundary lines of one message write ONE side-table row", async () => {
    const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
    const r = store.open("m3", { prompt_hash: hashPrompt("two lines") });
    await r.close("timeout");
    await store.confirmTurn(hashPrompt("two lines"), {
      claude_jsonl_path: "/x",
      turn_event_offset: 10,
      message_id: "msg_X",
    });
    await store.confirmTurn(hashPrompt("two lines"), {
      claude_jsonl_path: "/x",
      turn_event_offset: 20,
      message_id: "msg_X",
    });
    await store.confirmTurn(hashPrompt("two lines"), {
      claude_jsonl_path: "/x",
      turn_event_offset: 30,
      message_id: "msg_Y",
    });
    const side = rows(join(dir, "receipt-turns.jsonl"));
    expect(side.map((s) => s.transcript_message_id)).toEqual(["msg_X", "msg_Y"]);
  });

  it("a hash no receipt ever carried is recorded as unknown, still with the proof", async () => {
    const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
    const where = await store.confirmTurn(hashPrompt("never seen"), {
      claude_jsonl_path: "/x/s.jsonl",
      turn_event_offset: 7,
    });
    expect(where).toBe("unknown");
    const [side] = rows(join(dir, "receipt-turns.jsonl"));
    expect(side.message_id).toBeNull();
    expect(side.turn_event_offset).toBe(7);
  });
});
