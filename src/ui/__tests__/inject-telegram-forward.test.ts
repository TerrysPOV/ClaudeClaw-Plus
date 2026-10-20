/**
 * /api/inject forwards the agent's answer to the first allowed Telegram user.
 * An inject is the daemon talking to the agent, not a user waiting on one:
 * when the agent ends that turn without `reply`, the #215 safety net
 * synthesizes the raw turn text as the final. That text is internal and must
 * not be pushed to Telegram; a real `reply` still is.
 *
 * Run with: bun test src/ui/__tests__/inject-telegram-forward.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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
      telegram: { token: "bot-token", allowedUserIds: [42] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

// What the stubbed bus returns for the next inject.
let nextResult: { ok: boolean; output: string; exitCode: number; synthesized?: boolean };
const telegramCalls: string[] = [];
const realFetch = globalThis.fetch;

let handle: WebServerHandle;
let base: string;

beforeAll(() => {
  // Intercept only the Telegram Bot API; everything else (the test's own
  // requests to the server) goes through the real fetch.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.telegram.org/")) {
      telegramCalls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  handle = startWebUi({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    getSnapshot: snapshot,
    bus: {
      defaultAgentId: "agent-0",
      activeTurnAgents: () => [],
      sendPromptAndAwait: async () => nextResult,
    } as unknown as NonNullable<Parameters<typeof startWebUi>[0]["bus"]>,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
  globalThis.fetch = realFetch;
});

afterEach(() => {
  telegramCalls.length = 0;
});

async function inject(message: string) {
  const res = await fetch(`${base}/api/inject`, {
    method: "POST",
    headers: {
      Host: `127.0.0.1:${handle.port}`,
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });
  // The forward is fire-and-forget; let it run before asserting.
  await new Promise((r) => setTimeout(r, 10));
  return res.json();
}

describe("/api/inject → Telegram forward", () => {
  it("forwards a real reply to the first allowed user", async () => {
    nextResult = { ok: true, output: "the agent's answer", exitCode: 0 };
    const j = await inject("status?");
    expect(j.ok).toBe(true);
    expect(telegramCalls.length).toBe(1);
    expect(JSON.parse(telegramCalls[0])).toEqual({ chat_id: 42, text: "the agent's answer" });
  });

  it("does not forward a final synthesized by the silent-drop net", async () => {
    nextResult = { ok: true, output: "raw internal turn text", exitCode: 0, synthesized: true };
    const j = await inject("[daemon] rotation done");
    expect(telegramCalls.length).toBe(0);
    // The HTTP caller still gets the text: only the Telegram push is dropped.
    expect(j.ok).toBe(true);
    expect(j.result).toBe("raw internal turn text");
  });
});
