/**
 * #390: the dashboard chat SSE writer must survive a client that goes away
 * mid-turn. Before the fix every write after the browser aborted threw
 * `TypeError: Invalid state: Controller is already closed` out of the chunk
 * callback, and the `finally` close threw once more.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startWebUi } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";

const TOKEN = "test-web-token-abcdefghijklmnop";

function snapshot(): WebSnapshot {
  return {
    pid: 1234,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

let handle: WebServerHandle;
let base: string;
const auth = { Authorization: `Bearer ${TOKEN}` };

// The chat handler under test: emits one chunk, then waits for the test to
// release it, then keeps writing as if the turn had finished.
let release: () => void = () => undefined;
let lateWritesThrew: unknown = null;
let handlerFinished = false;

beforeAll(() => {
  handle = startWebUi({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    getSnapshot: snapshot,
    onChat: async (_message, onChunk, onUnblock) => {
      onChunk("first");
      await new Promise<void>((r) => {
        release = r;
      });
      try {
        onChunk("\n[chat error: timed out]\n");
        onUnblock();
      } catch (err) {
        lateWritesThrew = err;
      }
      handlerFinished = true;
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
});

async function csrf(): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base}/api/csrf-token`, { headers: auth });
  const data = (await res.json()) as { token: string };
  return { token: data.token, cookie: res.headers.get("set-cookie") ?? "" };
}

describe("/api/chat SSE — client cancels mid-turn (#390)", () => {
  it("late chunk/unblock/done writes after the client aborted do not throw", async () => {
    const { token, cookie } = await csrf();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        Cookie: cookie,
      },
      body: JSON.stringify({ message: "hello" }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"first"');
    // Browser goes away.
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    // Turn "finishes" and the handler writes into the dead stream.
    release();
    for (let i = 0; i < 100 && !handlerFinished; i++) await new Promise((r) => setTimeout(r, 10));
    expect(handlerFinished).toBe(true);
    expect(lateWritesThrew).toBeNull();
  });
});
