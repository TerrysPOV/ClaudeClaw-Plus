/**
 * Unit tests for `DiscordRestApi` — the small subset of Discord REST
 * the Bus adapter needs (chunked message POST + interaction callback).
 * Uses an injected `fetchImpl` so the suite stays offline.
 */
import { describe, expect, it } from "bun:test";
import { DiscordRestApi } from "../rest-api";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFakeFetch(): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
  setResponse: (resp: Response) => void;
} {
  const calls: CapturedCall[] = [];
  // Real Discord POSTs return a JSON message body; the fake mirrors that
  // so `res.json()` in the impl doesn't choke. Override per test for 4xx/5xx.
  let nextResponse: Response = new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return nextResponse.clone();
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    setResponse: (r) => {
      nextResponse = r;
    },
  };
}

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

describe("DiscordRestApi", () => {
  it("sendMessage POSTs a single chunk for short text", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.sendMessage("c1", "hello world");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls[0]?.headers.Authorization).toBe("Bot tok");
    expect(JSON.parse(fake.calls[0]?.body ?? "{}").content).toBe("hello world");
  });

  it("sendMessage chunks at 2000 chars and attaches components only to the last chunk", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    const text = "a".repeat(2500);
    await api.sendMessage("c1", text, [{ x: 1 }]);
    expect(fake.calls).toHaveLength(2);
    const body0 = JSON.parse(fake.calls[0]?.body ?? "{}");
    const body1 = JSON.parse(fake.calls[1]?.body ?? "{}");
    expect(body0.content.length).toBe(2000);
    expect(body0.components).toBeUndefined();
    expect(body1.content.length).toBe(500);
    expect(body1.components).toEqual([{ x: 1 }]);
  });

  it("sendMessage strips [react:…] tags before chunking", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.sendMessage("c1", "hi [react:👍] there");
    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(fake.calls[0]?.body ?? "{}").content).toBe("hi  there");
  });

  it("sendMessage skips empty content entirely", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.sendMessage("c1", "   ");
    expect(fake.calls).toHaveLength(0);
  });

  it("respondToInteraction posts CHANNEL_MESSAGE_WITH_SOURCE payload", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.respondToInteraction("int-1", "int-tok", { content: "Allowed.", flags: 64 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(
      "https://discord.com/api/v10/interactions/int-1/int-tok/callback",
    );
    const body = JSON.parse(fake.calls[0]?.body ?? "{}");
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("Allowed.");
    expect(body.data.flags).toBe(64);
  });

  it("call() raises on non-OK response", async () => {
    const fake = makeFakeFetch();
    fake.setResponse(new Response("nope", { status: 403, statusText: "Forbidden" }));
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await expect(api.sendMessage("c1", "x")).rejects.toThrow(/403/);
  });

  it("sendMessage denies all mention parsing (#323)", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.sendMessage("c1", "hello @everyone");
    const body = JSON.parse(fake.calls[0]?.body ?? "{}");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("respondToInteraction denies all mention parsing (#323)", async () => {
    const fake = makeFakeFetch();
    const api = new DiscordRestApi({ token: "tok", logger: SILENT, fetchImpl: fake.fetchImpl });
    await api.respondToInteraction("i1", "t1", { content: "ack @here" });
    const body = JSON.parse(fake.calls[0]?.body ?? "{}");
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
    expect(body.data.content).toBe("ack @here");
  });
});
