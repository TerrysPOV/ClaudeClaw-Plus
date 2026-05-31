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
import { type AgentProcessLike, createPromptStreamHandler } from "../receipt-wiring";

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

function fakeAgent(pid: number, sendImpl?: (line: string) => Promise<void>): AgentProcessLike {
  return {
    pid,
    send_prompt_stream: sendImpl ?? (() => Promise.resolve()),
  };
}

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

  test("does not crash when no receipt AND PTY write fails", async () => {
    const handler = createPromptStreamHandler(
      () => fakeAgent(1, () => Promise.reject(new Error("boom"))),
      { store },
    );
    await expect(handler("alpha", "no-receipt")).rejects.toThrow("boom");
    expect(readReceipts()).toHaveLength(0);
  });
});
