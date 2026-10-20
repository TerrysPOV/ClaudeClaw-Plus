/**
 * Tests for `src/adapters/webui/index.ts` (Sprint 2 Agent C).
 *
 * Run with: `bun test src/adapters/webui/__tests__/webui.test.ts`
 *
 * Strategy:
 *   - The adapter is exercised end-to-end against a `FakeBus` that
 *     implements the public `BusCore` interface (per spec §5.4 the
 *     adapter only needs `subscribe` + `sendPrompt`, but the type
 *     forces us to stub the rest). The fake captures invocations so
 *     we can assert on adapter→bus traffic without a real IPC server.
 *   - HTTP is hit with `fetch()` (Bun's native client).
 *   - WS is hit with the global `WebSocket` constructor — same API
 *     the browser front-end will use.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { WebUiAdapter } from "../index";
import type { BusCore, SendPromptRequest } from "../../../bus/core";
import type {
  Subscription,
  SubscriptionFilter,
  SubscriptionHandler,
} from "../../../bus/core-subscription";
import type { BusEvent } from "../../../bus/types";

/* ────────────────────────────────────────────────────────────────────── */
/* FakeBus — minimal BusCore implementation for assertions               */
/* ────────────────────────────────────────────────────────────────────── */

interface FakeSubscription extends Subscription {
  filter: SubscriptionFilter;
  handler: SubscriptionHandler;
  closedFlag: boolean;
}

class FakeBus implements BusCore {
  public readonly prompts: SendPromptRequest[] = [];
  public readonly subscriptions = new Map<string, FakeSubscription>();
  /** When true, `sendPrompt` throws. */
  public failPrompts = false;

  async sendPrompt(req: SendPromptRequest): Promise<{ promise_id: string }> {
    if (this.failPrompts) throw new Error("forced failure");
    this.prompts.push(req);
    return { promise_id: randomUUID() };
  }

  subscribe(filter: SubscriptionFilter, handler: SubscriptionHandler): Subscription {
    const id = randomUUID();
    const record: FakeSubscription = {
      id,
      filter,
      handler,
      closedFlag: false,
      close: () => {
        record.closedFlag = true;
        this.subscriptions.delete(id);
      },
      get overflowCount() {
        return 0;
      },
      get depth() {
        return 0;
      },
    };
    this.subscriptions.set(id, record);
    return record;
  }

  /** Push a synthetic event to every matching subscription. */
  emit(event: BusEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.closedFlag) continue;
      if (sub.filter.agent_id && sub.filter.agent_id !== event.agent_id) continue;
      if (sub.filter.topics && sub.filter.topics.length > 0) {
        if (!sub.filter.topics.includes(event.topic)) continue;
      }
      sub.handler(event);
    }
  }

  // Unused by the adapter but required by the interface.
  async invokeSlashCommand(): Promise<void> {}
  ingestReply(): void {}
  ingestSessionEvent(): void {}
  ingestPermissionDecision(): void {}
  state() {
    return {
      subscriberCount: this.subscriptions.size,
      connectedAgents: [],
      totalOverflows: 0,
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/* ────────────────────────────────────────────────────────────────────── */
/* Test harness                                                           */
/* ────────────────────────────────────────────────────────────────────── */

let bus: FakeBus;
let adapter: WebUiAdapter | null = null;
let baseUrl: string;
let wsUrl: string;

/** Wait until `predicate()` returns truthy or fail after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

/** Open a WS, run `fn`, then close — handles the open-promise dance. */
async function withWs(
  url: string,
  fn: (ws: WebSocket, recv: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const ws = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  ws.addEventListener("message", (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      parsed = ev.data;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws open failed")), {
      once: true,
    });
  });
  const recv = (): Promise<unknown> =>
    new Promise((resolve) => {
      if (queue.length > 0) {
        resolve(queue.shift());
      } else {
        waiters.push(resolve);
      }
    });
  try {
    await fn(ws, recv);
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.addEventListener("close", () => resolve(), { once: true });
    });
  }
}

/** Silent logger so the dev-mode "no auth" warning doesn't spam test output. */
const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

async function startAdapter(
  opts: Partial<ConstructorParameters<typeof WebUiAdapter>[0]> = {},
): Promise<WebUiAdapter> {
  const a = new WebUiAdapter({
    bus,
    bind: "127.0.0.1:0",
    logger: SILENT_LOGGER,
    ...opts,
  });
  const { host, port } = await a.start();
  baseUrl = `http://${host}:${port}`;
  wsUrl = `ws://${host}:${port}/ws`;
  return a;
}

beforeEach(() => {
  bus = new FakeBus();
});

afterEach(async () => {
  if (adapter) {
    await adapter.stop();
    adapter = null;
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/* Tests                                                                  */
/* ────────────────────────────────────────────────────────────────────── */

describe("WebUiAdapter — lifecycle", () => {
  it("start binds an ephemeral port; stop releases it", async () => {
    adapter = await startAdapter();
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    // After stop, the port should refuse connections quickly.
    const portMatch = baseUrl.match(/:(\d+)$/);
    expect(portMatch).not.toBeNull();
    await adapter.stop();
    adapter = null;
    // Re-binding the same port string should succeed (best-effort proof
    // that the old listener released it). We don't reuse the explicit
    // port — just confirm a new adapter on an ephemeral port works.
    const next = new WebUiAdapter({ bus, bind: "127.0.0.1:0", logger: SILENT_LOGGER });
    const handle = await next.start();
    expect(handle.port).toBeGreaterThan(0);
    await next.stop();
  });

  it("rejects invalid bind strings", () => {
    expect(() => new WebUiAdapter({ bus, bind: "no-colon" })).toThrow();
    expect(() => new WebUiAdapter({ bus, bind: "127.0.0.1:abc" })).toThrow();
    expect(() => new WebUiAdapter({ bus, bind: "127.0.0.1:99999" })).toThrow();
  });
});

describe("WebUiAdapter — /health", () => {
  it("returns ok and a version field without auth", async () => {
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("advertises a capability set, so a client detects instead of sniffing the version", async () => {
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/health`);
    const body = (await r.json()) as { capabilities?: string[] };

    expect(Array.isArray(body.capabilities)).toBe(true);
    // Membership, never index or ordering: the array grows, and a client that
    // depended on a position would break the first time an entry is added.
    expect(body.capabilities).toContain("events.operation_id");
  });

  it("serves capabilities without auth, like the rest of /health", async () => {
    // A client has to be able to ask what the daemon supports BEFORE it can
    // present a credential — otherwise capability detection is unreachable
    // for exactly the clients that need it.
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { capabilities?: string[] };
    expect(body.capabilities?.length).toBeGreaterThan(0);
  });
  it("reports an instance identity that changes when the daemon restarts", async () => {
    adapter = await startAdapter({ token: "sekret" });
    // A version cannot answer this: a restart onto the same build reports the
    // same version, which is exactly the case a desktop must not mistake for
    // continuity. A client that reconnects and sees a different instance knows
    // its cached subscriptions, in-flight operation ids and sequence position
    // belong to a process that no longer exists.
    const r = await fetch(`${baseUrl}/health`);
    const body = (await r.json()) as { instance_id?: string; started_at?: string };
    expect(typeof body.instance_id).toBe("string");
    expect(body.instance_id?.length).toBeGreaterThan(0);
    expect(typeof body.started_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.started_at ?? ""))).toBe(false);
  });

  it("reports the SAME instance across calls while the process lives", async () => {
    adapter = await startAdapter({ token: "sekret" });
    // The other half of the property, and the one a naive implementation
    // breaks: an id minted per request changes on every call, which reads as a
    // restart on every poll.
    const a = (await (await fetch(`${baseUrl}/health`)).json()) as { instance_id?: string };
    const b = (await (await fetch(`${baseUrl}/health`)).json()) as { instance_id?: string };
    expect(a.instance_id).toBe(b.instance_id);
  });

  it("advertises the instance-identity and ambiguity capabilities", async () => {
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/health`);
    const body = (await r.json()) as { capabilities?: string[] };
    expect(body.capabilities).toContain("health.instance_identity");
    expect(body.capabilities).toContain("events.correlation_ambiguity");
  });
});

describe("WebUiAdapter — POST /prompt", () => {
  it("with valid token forwards to bus.sendPrompt and returns promise_id", async () => {
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sekret",
      },
      body: JSON.stringify({ agent_id: "triage", text: "hello", metadata: { tag: "x" } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; promise_id: string };
    expect(body.ok).toBe(true);
    expect(typeof body.promise_id).toBe("string");
    expect(bus.prompts).toHaveLength(1);
    const sent = bus.prompts[0];
    if (!sent) throw new Error("expected prompt captured");
    expect(sent.agent_id).toBe("triage");
    expect(sent.text).toBe("hello");
    expect(sent.origin).toBe("webui");
    expect(sent.origin_id).toBe("http");
    expect(sent.metadata).toEqual({ tag: "x" });
  });

  it("returns 401 when token is configured but missing/wrong", async () => {
    adapter = await startAdapter({ token: "sekret" });

    const noToken = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "triage", text: "hi" }),
    });
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong",
      },
      body: JSON.stringify({ agent_id: "triage", text: "hi" }),
    });
    expect(wrongToken.status).toBe(401);
    expect(bus.prompts).toHaveLength(0);
  });

  it("returns 400 on invalid body", async () => {
    adapter = await startAdapter();
    const r1 = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(r1.status).toBe(400);

    const r2 = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "triage" }),
    });
    expect(r2.status).toBe(400);
  });

  it("returns 403 when agent is not in allowedAgentIds", async () => {
    adapter = await startAdapter({ allowedAgentIds: ["triage"] });
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "other", text: "hi" }),
    });
    expect(r.status).toBe(403);
    expect(bus.prompts).toHaveLength(0);
  });

  it("returns 500 when bus.sendPrompt throws", async () => {
    adapter = await startAdapter({
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    bus.failPrompts = true;
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "triage", text: "hi" }),
    });
    expect(r.status).toBe(500);
  });
});

describe("WebUiAdapter — WebSocket /ws", () => {
  it("subscribes and forwards matching events", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws, recv) => {
      ws.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      const ready = (await recv()) as { type: string; subscription_id: string };
      expect(ready.type).toBe("ready");
      expect(typeof ready.subscription_id).toBe("string");
      expect(bus.subscriptions.size).toBe(1);

      const event: BusEvent = {
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "response.text",
        payload: { text: "hello" },
      };
      bus.emit(event);

      const forwarded = (await recv()) as { type: string; event: BusEvent };
      expect(forwarded.type).toBe("event");
      expect(forwarded.event.topic).toBe("response.text");
      expect(forwarded.event.agent_id).toBe("triage");

      // Events for OTHER agents must NOT be forwarded.
      bus.emit({
        ts: Date.now(),
        agent_id: "other",
        session_id: "s2",
        topic: "response.text",
        payload: { text: "nope" },
      });
      // Then send a matching event and assert the next message is the
      // matching one (proves "other" was filtered out by the subscription).
      bus.emit({
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "response.text",
        payload: { text: "world" },
      });
      const next = (await recv()) as { type: string; event: BusEvent };
      expect(next.type).toBe("event");
      expect(next.event.agent_id).toBe("triage");
      expect((next.event.payload as { text: string }).text).toBe("world");
    });
  });

  it("filters by topic list when client passes one", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws, recv) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          agent_id: "triage",
          topics: ["response.text"],
        }),
      );
      const ready = (await recv()) as { type: string };
      expect(ready.type).toBe("ready");

      bus.emit({
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "usage",
        payload: {},
      });
      bus.emit({
        ts: Date.now(),
        agent_id: "triage",
        session_id: "s1",
        topic: "response.text",
        payload: { text: "passes filter" },
      });
      const got = (await recv()) as { type: string; event: BusEvent };
      expect(got.event.topic).toBe("response.text");
    });
  });

  it("rejects WS upgrade with wrong token (401)", async () => {
    adapter = await startAdapter({ token: "sekret" });
    // Browser WebSocket constructor on a 401 fires `error`, not `open`.
    const ws = new WebSocket(`${wsUrl}?token=wrong`);
    const outcome = await new Promise<"open" | "error">((resolve) => {
      ws.addEventListener("open", () => resolve("open"), { once: true });
      ws.addEventListener("error", () => resolve("error"), { once: true });
      ws.addEventListener("close", () => resolve("error"), { once: true });
    });
    expect(outcome).toBe("error");
    try {
      ws.close();
    } catch {}
  });

  it("accepts WS upgrade with correct ?token=", async () => {
    adapter = await startAdapter({ token: "sekret" });
    await withWs(`${wsUrl}?token=sekret`, async (ws, recv) => {
      ws.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      const ready = (await recv()) as { type: string };
      expect(ready.type).toBe("ready");
    });
  });

  it("unsubscribes on close — bus.state().subscriberCount returns to 0", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws, recv) => {
      ws.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      const ready = (await recv()) as { type: string };
      expect(ready.type).toBe("ready");
      expect(bus.state().subscriberCount).toBe(1);
    });
    await waitFor(() => bus.state().subscriberCount === 0);
    expect(bus.state().subscriberCount).toBe(0);
  });

  it("blocks WS subscribe to a disallowed agent", async () => {
    adapter = await startAdapter({ allowedAgentIds: ["triage"] });
    await withWs(wsUrl, async (ws, recv) => {
      ws.send(JSON.stringify({ type: "subscribe", agent_id: "intruder" }));
      const reply = (await recv()) as { type: string; error: string };
      expect(reply.type).toBe("error");
      expect(reply.error).toBe("agent_not_allowed");
      // The adapter then closes the socket with 4403 — just confirm no
      // subscription leaked into the fake bus.
      await waitFor(() => bus.state().subscriberCount === 0);
    });
  });

  it("emits a typed error on malformed JSON", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws, recv) => {
      ws.send("not json");
      const reply = (await recv()) as { type: string; error: string };
      expect(reply.type).toBe("error");
      expect(reply.error).toBe("invalid_json");
    });
  });

  it("rejects a second subscribe on the same socket", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws, recv) => {
      ws.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      const ready = (await recv()) as { type: string };
      expect(ready.type).toBe("ready");

      ws.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      const dup = (await recv()) as { type: string; error: string };
      expect(dup.type).toBe("error");
      expect(dup.error).toBe("already_subscribed");
      // Still exactly one subscription on the bus.
      expect(bus.state().subscriberCount).toBe(1);
    });
  });
});

describe("WebUiAdapter — multi-connection", () => {
  it("each WS connection gets its own subscription", async () => {
    adapter = await startAdapter();
    await withWs(wsUrl, async (ws1, recv1) => {
      ws1.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
      await recv1(); // ready
      await withWs(wsUrl, async (ws2, recv2) => {
        ws2.send(JSON.stringify({ type: "subscribe", agent_id: "triage" }));
        await recv2(); // ready
        expect(bus.state().subscriberCount).toBe(2);

        bus.emit({
          ts: Date.now(),
          agent_id: "triage",
          session_id: "s1",
          topic: "response.text",
          payload: { text: "fan-out" },
        });
        const got1 = (await recv1()) as { type: string; event: BusEvent };
        const got2 = (await recv2()) as { type: string; event: BusEvent };
        expect(got1.event.topic).toBe("response.text");
        expect(got2.event.topic).toBe("response.text");
      });
      // After ws2 closes, count goes back to 1.
      await waitFor(() => bus.state().subscriberCount === 1);
    });
    await waitFor(() => bus.state().subscriberCount === 0);
  });
});

describe("WebUiAdapter — Origin check", () => {
  const promptBody = JSON.stringify({ agent_id: "triage", text: "hi" });

  /** Resolves "open" if the upgrade succeeded, "error" if it was refused. */
  async function wsOutcome(url: string, headers: Record<string, string>) {
    // Bun's WebSocket client accepts a `headers` option; the DOM type does not know it.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    const outcome = await new Promise<"open" | "error">((resolve) => {
      ws.addEventListener("open", () => resolve("open"), { once: true });
      ws.addEventListener("error", () => resolve("error"), { once: true });
      ws.addEventListener("close", () => resolve("error"), { once: true });
    });
    try {
      ws.close();
    } catch {}
    return outcome;
  }

  it("refuses a cross-origin text/plain POST /prompt when no token is set", async () => {
    adapter = await startAdapter();
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://attacker.example" },
      body: promptBody,
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("origin_not_allowed");
    expect(bus.prompts).toHaveLength(0);
  });

  it("refuses a cross-origin POST /prompt even with a valid token", async () => {
    adapter = await startAdapter({ token: "sekret" });
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sekret",
        Origin: "https://attacker.example",
      },
      body: promptBody,
    });
    expect(r.status).toBe(403);
    expect(bus.prompts).toHaveLength(0);
  });

  it("refuses a cross-origin WS upgrade when no token is set", async () => {
    adapter = await startAdapter();
    expect(await wsOutcome(wsUrl, { Origin: "https://attacker.example" })).toBe("error");
    expect(bus.subscriptions.size).toBe(0);
  });

  it("refuses an opaque `null` origin (sandboxed iframe, file://)", async () => {
    adapter = await startAdapter();
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "null" },
      body: promptBody,
    });
    expect(r.status).toBe(403);
    expect(bus.prompts).toHaveLength(0);
  });

  it("refuses a DNS-rebound page whose Origin and Host agree on a foreign name", async () => {
    adapter = await startAdapter();
    const port = new URL(baseUrl).port;
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: `http://rebind.attacker.example:${port}`,
        Host: `rebind.attacker.example:${port}`,
      },
      body: promptBody,
    });
    expect(r.status).toBe(403);
    expect(bus.prompts).toHaveLength(0);
  });

  it("accepts a same-origin loopback request", async () => {
    adapter = await startAdapter();
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: promptBody,
    });
    expect(r.status).toBe(200);
    expect(bus.prompts).toHaveLength(1);
  });

  it("accepts an origin listed in allowedOrigins, on POST and on WS", async () => {
    adapter = await startAdapter({ allowedOrigins: ["https://console.example/"] });
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://console.example" },
      body: promptBody,
    });
    expect(r.status).toBe(200);
    expect(await wsOutcome(wsUrl, { Origin: "https://console.example" })).toBe("open");
  });

  it("leaves non-browser clients (no Origin header) unaffected", async () => {
    adapter = await startAdapter();
    const r = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: promptBody,
    });
    expect(r.status).toBe(200);
  });
});
