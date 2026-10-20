/**
 * Tests for the bus → PTY receipt wiring helper (issue #207). Verifies the
 * pid/generation back-fill and the stale_session rollback paths without
 * booting the full bus runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, hashPrompt, type ReceiptRecord, type ReceiptStore } from "../receipt";
import {
  type AgentProcessLike,
  confirmTurnReceipt,
  createPromptStreamHandler,
  openInboundReceipt,
  unwrapChannelText,
} from "../receipt-wiring";
import type { PromptDeliveryOutcome } from "../types";

let tmpDir: string;
let logPath: string;
let store: ReceiptStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "receipt-wiring-"));
  logPath = join(tmpDir, "receipts.jsonl");
  store = createReceiptStore({ path: logPath });
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

function fakeAgent(
  pid: number,
  sendImpl?: (line: string) => Promise<PromptDeliveryOutcome | void>,
): AgentProcessLike {
  return {
    pid,
    send_prompt_stream: sendImpl ?? (() => Promise.resolve()),
  };
}

describe("unwrapChannelText", () => {
  test("passes through plain text unchanged", () => {
    expect(unwrapChannelText("hello world")).toBe("hello world");
  });

  test("extracts inner text from a channel wrapper", () => {
    const wrapped =
      '<channel source="webui" chat_id="inject" user_id="webui" ts="2026-05-31T00:00:00Z">hello world</channel>';
    expect(unwrapChannelText(wrapped)).toBe("hello world");
  });

  test("decodes XML entities (`<`, `>`, `&`) in the inner text", () => {
    const wrapped =
      '<channel source="webui" chat_id="x" user_id="x" ts="t">a &amp; b &lt; c &gt; d</channel>';
    expect(unwrapChannelText(wrapped)).toBe("a & b < c > d");
  });

  test("matches hashPrompt of the unwrapped form", () => {
    const original = "Réponds: ok";
    const wrapped = `<channel source="webui" chat_id="inject" user_id="webui" ts="2026-05-31T00:00:00Z">${original}</channel>`;
    expect(hashPrompt(unwrapChannelText(wrapped))).toBe(hashPrompt(original));
  });
});

describe("createPromptStreamHandler", () => {
  test("writes to the PTY when no receipt is open (back-compat)", async () => {
    let captured: string | null = null;
    const handler = createPromptStreamHandler(
      () =>
        fakeAgent(111, async (t) => {
          captured = t;
        }),
      { store },
    );
    await handler("alpha", "hi");
    expect(captured).toBe("hi");
    expect(readReceipts()).toHaveLength(0);
  });

  test("back-fills pid + generation + route_resolved_at when a receipt is open", async () => {
    const r = store.open("m1", { agent_id: "alpha", prompt_hash: hashPrompt("hi") });
    const handler = createPromptStreamHandler(() => fakeAgent(2222), { store });
    await handler("alpha", "hi");
    expect(r.record.process_pid).toBe(2222);
    expect(r.record.process_generation).toBe(1);
    expect(r.record.notes?.route_resolved_at).toBeDefined();
    expect(r.record.notes?.stdin_written_at).toBeDefined();
  });

  test("stamps delivery_outcome and passes the verdict through when the process reports one (#361)", async () => {
    const r = store.open("m-v", { agent_id: "alpha", prompt_hash: hashPrompt("hi") });
    const handler = createPromptStreamHandler(
      () => fakeAgent(3333, async () => "unconfirmed-live"),
      { store },
    );
    await expect(handler("alpha", "hi")).resolves.toBe("unconfirmed-live");
    expect(r.record.notes?.stdin_written_at).toBeDefined();
    expect(r.record.notes?.delivery_outcome).toBe("unconfirmed-live");
  });

  test("a re-delivery keeps the first verdict and records its own as redelivery_outcome (#361)", async () => {
    const r = store.open("m-rd", { agent_id: "alpha", prompt_hash: hashPrompt("hi") });
    const verdicts = ["unconfirmed-live", "turn-started"] as const;
    let n = 0;
    const handler = createPromptStreamHandler(() => fakeAgent(3335, async () => verdicts[n++]), {
      store,
    });
    await handler("alpha", "hi");
    await expect(handler("alpha", "hi")).resolves.toBe("turn-started");
    expect(r.record.notes?.delivery_outcome).toBe("unconfirmed-live");
    expect(r.record.notes?.redelivery_outcome).toBe("turn-started");
  });

  test("no delivery_outcome note, and a void result, when the process reports nothing", async () => {
    const r = store.open("m-void", { agent_id: "alpha", prompt_hash: hashPrompt("hi") });
    const handler = createPromptStreamHandler(() => fakeAgent(3334), { store });
    await expect(handler("alpha", "hi")).resolves.toBeUndefined();
    expect(r.record.notes?.stdin_written_at).toBeDefined();
    expect(r.record.notes).not.toHaveProperty("delivery_outcome");
  });

  test("generation bumps when the same agent_id is seen with a different pid", async () => {
    const handler = createPromptStreamHandler(() => fakeAgent(currentPid), { store });
    let currentPid = 100;
    const r1 = store.open("m-a", { agent_id: "alpha", prompt_hash: hashPrompt("a") });
    await handler("alpha", "a");
    expect(r1.record.process_generation).toBe(1);
    expect(r1.record.process_pid).toBe(100);

    currentPid = 200;
    const r2 = store.open("m-b", { agent_id: "alpha", prompt_hash: hashPrompt("b") });
    await handler("alpha", "b");
    expect(r2.record.process_generation).toBe(2);
    expect(r2.record.process_pid).toBe(200);
  });

  test("generation stays stable when the same pid is observed twice", async () => {
    const handler = createPromptStreamHandler(() => fakeAgent(777), { store });
    const r1 = store.open("m-1", { agent_id: "alpha", prompt_hash: hashPrompt("one") });
    await handler("alpha", "one");
    const r2 = store.open("m-2", { agent_id: "alpha", prompt_hash: hashPrompt("two") });
    await handler("alpha", "two");
    expect(r1.record.process_generation).toBe(1);
    expect(r2.record.process_generation).toBe(1);
  });

  test("closes receipt as stale_session on PTY write error and re-throws", async () => {
    const handler = createPromptStreamHandler(
      () => fakeAgent(42, () => Promise.reject(new Error("pty closed"))),
      { store },
    );
    store.open("m-err", { agent_id: "alpha", prompt_hash: hashPrompt("zap") });
    await expect(handler("alpha", "zap")).rejects.toThrow("pty closed");
    // Allow the close fire-and-forget to flush.
    await new Promise((r) => setTimeout(r, 10));
    const recs = readReceipts();
    expect(recs).toHaveLength(1);
    expect(recs[0].final_state).toBe("stale_session");
    expect(recs[0].notes?.stage).toBe("pty_write");
    expect(recs[0].notes?.error).toBe("pty closed");
  });

  test("closes receipt as stale_session when agent is not registered", async () => {
    const handler = createPromptStreamHandler(() => undefined, { store });
    store.open("m-unreg", { agent_id: "ghost", prompt_hash: hashPrompt("hello") });
    await handler("ghost", "hello");
    await new Promise((r) => setTimeout(r, 10));
    const recs = readReceipts();
    expect(recs).toHaveLength(1);
    expect(recs[0].final_state).toBe("stale_session");
    expect(recs[0].notes?.reason).toBe("agent_not_registered");
  });

  test("closes receipt as stale_session when agent has no send_prompt_stream", async () => {
    const handler = createPromptStreamHandler(() => ({ pid: 9 }) as AgentProcessLike, { store });
    store.open("m-nostream", { agent_id: "alpha", prompt_hash: hashPrompt("x") });
    await handler("alpha", "x");
    await new Promise((r) => setTimeout(r, 10));
    const recs = readReceipts();
    expect(recs).toHaveLength(1);
    expect(recs[0].final_state).toBe("stale_session");
    expect(recs[0].notes?.reason).toBe("no_send_prompt_stream");
  });

  test("matches receipt by hash of unwrapped channel text (real bus path)", async () => {
    // Mirrors what `BusCoreImpl.sendPrompt` actually delivers: the prompt is
    // wrapped in a <channel ...>...</channel> block. The handler must unwrap
    // before hashing so the receipt opened with the *raw* prompt hash is
    // found.
    const raw = "réponds: ok";
    const wrapped = `<channel source="webui" chat_id="inject" user_id="webui" ts="t0">${raw}</channel>`;
    const r = store.open("m-wrap", { agent_id: "alpha", prompt_hash: hashPrompt(raw) });
    const handler = createPromptStreamHandler(() => fakeAgent(31415), { store });
    await handler("alpha", wrapped);
    expect(r.record.process_pid).toBe(31415);
    expect(r.record.notes?.stdin_written_at).toBeDefined();
  });

  test("does not crash when no receipt AND PTY write fails", async () => {
    const handler = createPromptStreamHandler(
      () => fakeAgent(1, () => Promise.reject(new Error("boom"))),
      { store },
    );
    await expect(handler("alpha", "no-receipt")).rejects.toThrow("boom");
    expect(readReceipts()).toHaveLength(0);
  });
});

describe("openInboundReceipt (#211 — adapter boundary open)", () => {
  test("opens at message_polled with raw prompt_hash + origin notes", () => {
    const raw = "what's the weather";
    const receipt = openInboundReceipt({
      store,
      messageId: "tg-7",
      agentId: "triage",
      rawText: raw,
      origin: "telegram",
      originId: "100",
    });
    expect(receipt.record.message_id).toBe("tg-7");
    expect(receipt.record.final_state).toBe("message_polled");
    expect(receipt.record.agent_id).toBe("triage");
    expect(receipt.record.selected_route).toBe("agent=triage");
    // Hash invariant: computed on the RAW text (pre-<channel> wrapper), so the
    // bus -> PTY seam's findByPromptHash (which unwraps first) hits the same one.
    expect(receipt.record.prompt_hash).toBe(hashPrompt(raw));
    expect(receipt.record.notes).toMatchObject({ origin: "telegram", origin_id: "100" });
  });

  test("findByPromptHash on the raw text resolves the open receipt", () => {
    const raw = "deploy the thing";
    openInboundReceipt({
      store,
      messageId: "tg-8",
      agentId: "a1",
      rawText: raw,
      origin: "telegram",
      originId: "1",
    });
    expect(store.findByPromptHash(hashPrompt(raw))?.record.message_id).toBe("tg-8");
  });
});

describe("confirmTurnReceipt — tailer → receipt seam (#212)", () => {
  test("hashes the unwrapped channel text, so the tailer's proof lands on the adapter's receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccplus-turn-seam-"));
    try {
      const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
      const r = store.open("tg:1:abcd", { prompt_hash: hashPrompt("allô") });
      const where = await confirmTurnReceipt(
        {
          promptText: '<channel source="telegram" chat_id="1" user_id="u" ts="t">allô</channel>',
          jsonlPath: "/x/s.jsonl",
          offset: 512,
          messageId: "msg_1",
          stopReason: "end_turn",
          synthetic: false,
        },
        store,
      );
      expect(where).toBe("patched");
      expect(r.record.turn_event_offset).toBe(512);
      expect(r.record.claude_jsonl_path).toBe("/x/s.jsonl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a synthetic boundary (CLI-written API error) is not a model turn and is skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccplus-turn-seam-"));
    try {
      const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
      const r = store.open("m", { prompt_hash: hashPrompt("x") });
      const where = await confirmTurnReceipt(
        {
          promptText: "x",
          jsonlPath: "/x",
          offset: 1,
          stopReason: "stop_sequence",
          synthetic: true,
        },
        store,
      );
      expect(where).toBe("skipped");
      expect(r.record.turn_event_offset).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
