/**
 * Web UI WebSocket adapter — first external Bus adapter.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.4.
 * Sprint coordination: `src/bus/SPRINT_2_PLAN.md` (Agent C scope).
 *
 * Surface:
 *   - `GET  /health` (no auth) — liveness probe.
 *   - `POST /prompt`           — auth required; forwards to `bus.sendPrompt`.
 *   - `GET  /ws`  (WS upgrade) — auth required; client `subscribe` envelope
 *     starts a `bus.subscribe` and pipes every matching `BusEvent` over the
 *     socket as JSON.
 *
 * Why Bun.serve:
 *   - The existing `src/ui/server.ts` already uses `Bun.serve`, so adding a
 *     parallel adapter using the same runtime keeps dependency surface flat
 *     (no Express, no `ws` package — Bun's WebSocket support is built in).
 *   - `Bun.serve` returns a `server` handle with `server.upgrade(req, {data})`
 *     for WS handshake. Per-socket state lives on `ws.data`.
 *
 * Auth model:
 *   - If `token` option is set: every request needs it.
 *     HTTP — `Authorization: Bearer <token>`.
 *     WS   — `?token=<token>` (browser WebSocket API cannot set custom
 *            headers, so a query param is the de-facto standard).
 *   - If `token` is unset: dev mode, no auth, startup warning logged.
 *
 * Origin check (both modes):
 *   - A request carrying an `Origin` header (i.e. sent by a browser) is
 *     refused with 403 unless the origin is same-origin with a loopback or
 *     IP-literal host, or listed in `allowedOrigins`. Without it, any web
 *     page the operator visits could POST a `text/plain` "simple request"
 *     to `/prompt` (no CORS preflight) or open `/ws` and read agent events —
 *     the browser's same-origin policy does not cover either.
 *   - Same-origin is only trusted on loopback / IP-literal hosts: a DNS
 *     rebinding page makes `Origin` and `Host` agree on the attacker's own
 *     hostname, so agreement alone proves nothing.
 *   - Requests with no `Origin` (curl, native and server-side clients) are
 *     unaffected; they are still subject to the token when one is set.
 *
 * Lifecycle:
 *   - `start()` binds the port and returns the resolved bind tuple.
 *     `bind: '127.0.0.1:0'` is supported for tests — the OS picks a port.
 *   - `stop()` closes every active WS subscription before stopping the
 *     server. This prevents subscription leaks in `BusCore.state()` when
 *     the adapter is restarted (the test suite asserts this directly).
 */

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ServerWebSocket } from "bun";
import type { BusCore, Subscription } from "../../bus/core";
import type { BusEvent, BusEventTopic } from "../../bus/types";
import type {
  ErrorResponseBody,
  PromptRequestBody,
  PromptResponseBody,
  WsClientMessage,
  WsServerMessage,
} from "./types";

/** Public options surface — see file header for semantics. */
export interface WebUiAdapterOptions {
  bus: BusCore;
  /**
   * `host:port` to bind. Default `127.0.0.1:7878` per spec §5.5.4 sketch.
   * Port `0` requests an ephemeral OS-assigned port (tests rely on this).
   */
  bind?: string;
  /**
   * Session token for auth. The daemon wiring falls back to the
   * `CCAW_WEBUI_TOKEN` env when `web.bus.token` is unset. If undefined, the
   * adapter runs without auth and logs a startup warning.
   */
  token?: string;
  /**
   * Browser origins (`scheme://host[:port]`) allowed to call `/prompt` and
   * open `/ws` cross-origin. Requests from any other origin get 403. Empty
   * or unset = same-origin (loopback / IP-literal host) and non-browser
   * clients only.
   */
  allowedOrigins?: string[];
  /**
   * If non-empty, only these `agent_id`s are accessible. An attempt to
   * subscribe or prompt any other agent returns 403 / WS close 4403.
   */
  allowedAgentIds?: string[];
  /**
   * Bus event topics the adapter is willing to forward when the client
   * subscription does NOT specify a topic list. Defaults to `undefined`
   * which means "all topics" (consistent with `bus.subscribe` semantics).
   */
  defaultTopics?: BusEventTopic[];
  /** Optional logger override; defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/** Per-WebSocket state attached via `Bun.serve`'s `upgrade({data})`. */
interface WsContext {
  connectionId: string;
  /** Set after the first `subscribe` message; closed on disconnect. */
  subscription: Subscription | null;
  /** Token captured at upgrade time — propagated to `sendPrompt.user_id`. */
  tokenIdentity: string;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Adapter                                                                */
/* ────────────────────────────────────────────────────────────────────── */

export class WebUiAdapter {
  private readonly bus: BusCore;
  private readonly token: string | undefined;
  private readonly allowedAgentIds: ReadonlySet<string> | null;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly defaultTopics: BusEventTopic[] | undefined;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;
  private readonly bindHost: string;
  private readonly bindPort: number;

  /**
   * Track every live WS socket so `stop()` can close subscriptions
   * deterministically. Bun's `server.stop(true)` closes the sockets
   * but the `close` handler is fired asynchronously — we want the
   * `Subscription.close()` calls done before `stop()` resolves so
   * `bus.state().subscriberCount` is back to 0 by the time tests
   * assert on it.
   */
  private readonly activeSockets = new Set<ServerWebSocket<WsContext>>();

  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(opts: WebUiAdapterOptions) {
    if (!opts.bus) {
      throw new Error("WebUiAdapter: `bus` is required");
    }
    this.bus = opts.bus;
    this.token = opts.token;
    this.allowedAgentIds =
      opts.allowedAgentIds && opts.allowedAgentIds.length > 0
        ? new Set(opts.allowedAgentIds)
        : null;
    this.allowedOrigins = new Set(
      (opts.allowedOrigins ?? []).map(normalizeOrigin).filter((o): o is string => o !== null),
    );
    this.defaultTopics = opts.defaultTopics;
    this.logger = opts.logger ?? console;

    const { host, port } = parseBind(opts.bind);
    this.bindHost = host;
    this.bindPort = port;
  }

  /* ──────────────────────────── lifecycle ─────────────────────────── */

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      return { host: this.server.hostname, port: this.server.port };
    }
    if (!this.token) {
      this.logger.warn(
        "[webui-adapter] starting WITHOUT auth token — anyone reachable on " +
          `${this.bindHost}:${this.bindPort} can prompt and subscribe. ` +
          "Set `web.bus.token` (or the CCAW_WEBUI_TOKEN env) before exposing. " +
          "Cross-origin browser requests are refused either way.",
      );
    }
    this.server = Bun.serve<WsContext, undefined>({
      hostname: this.bindHost,
      port: this.bindPort,
      // 0 = never idle-out; long-lived WS connections rely on this.
      idleTimeout: 0,
      fetch: (req, server) => this.handleFetch(req, server),
      websocket: {
        open: (ws) => this.handleWsOpen(ws),
        message: (ws, raw) => this.handleWsMessage(ws, raw),
        close: (ws, code, reason) => this.handleWsClose(ws, code, reason),
      },
    });
    return { host: this.server.hostname, port: this.server.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // Close subscriptions BEFORE stopping the server so `bus.state()` is
    // clean by the time `stop()` resolves. We snapshot the set first
    // because `handleWsClose` will mutate it as sockets close.
    const sockets = Array.from(this.activeSockets);
    for (const ws of sockets) {
      const ctx = ws.data;
      if (ctx?.subscription) {
        try {
          ctx.subscription.close();
        } catch (err) {
          this.logger.error("[webui-adapter] subscription.close error", err);
        }
        ctx.subscription = null;
      }
      try {
        ws.close(1001, "adapter stopping");
      } catch {
        // already closed — fine.
      }
    }
    this.activeSockets.clear();
    this.server.stop(true);
    this.server = null;
  }

  /* ──────────────────────────── HTTP handlers ─────────────────────── */

  private handleFetch(req: Request, server: ReturnType<typeof Bun.serve>): Response | undefined {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return jsonOk({
        ok: true,
        version: ADAPTER_VERSION,
        capabilities: ADAPTER_CAPABILITIES,
        instance_id: INSTANCE_ID,
        started_at: STARTED_AT,
      });
    }

    if (url.pathname === "/prompt" && req.method === "POST") {
      return this.handlePromptRequest(req);
    }

    if (url.pathname === "/ws") {
      return this.handleWsUpgrade(req, server, url);
    }

    return jsonError(404, "not_found");
  }

  private async handlePromptRequest(req: Request): Promise<Response> {
    const originError = this.checkOrigin(req);
    if (originError) return originError;
    const authError = this.checkHttpAuth(req);
    if (authError) return authError;

    let body: PromptRequestBody;
    try {
      body = (await req.json()) as PromptRequestBody;
    } catch {
      return jsonError(400, "invalid_json");
    }
    if (!body || typeof body.agent_id !== "string" || typeof body.text !== "string") {
      return jsonError(400, "invalid_body");
    }
    if (!this.isAgentAllowed(body.agent_id)) {
      return jsonError(403, "agent_not_allowed");
    }

    const userId = this.token ? `webui:${this.token.slice(0, 8)}` : "anonymous";
    try {
      const { promise_id } = await this.bus.sendPrompt({
        agent_id: body.agent_id,
        origin: "webui",
        origin_id: "http",
        user_id: userId,
        text: body.text,
        metadata: body.metadata,
      });
      const payload: PromptResponseBody = { ok: true, promise_id };
      return jsonOk(payload);
    } catch (err) {
      this.logger.error("[webui-adapter] sendPrompt error", err);
      return jsonError(500, "send_prompt_failed");
    }
  }

  /* ──────────────────────────── WS upgrade ────────────────────────── */

  private handleWsUpgrade(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
    url: URL,
  ): Response | undefined {
    const originError = this.checkOrigin(req);
    if (originError) return originError;
    const provided = url.searchParams.get("token") ?? extractBearer(req);
    if (this.token && provided !== this.token) {
      return jsonError(401, "unauthorized");
    }
    const ctx: WsContext = {
      connectionId: randomUUID(),
      subscription: null,
      tokenIdentity: this.token ? `webui:${this.token.slice(0, 8)}` : "anonymous",
    };
    const upgraded = server.upgrade(req, { data: ctx });
    if (!upgraded) {
      return jsonError(400, "upgrade_failed");
    }
    return undefined; // Bun handles the 101 response.
  }

  /* ──────────────────────────── WS lifecycle ──────────────────────── */

  private handleWsOpen(ws: ServerWebSocket<WsContext>): void {
    this.activeSockets.add(ws);
  }

  private handleWsMessage(ws: ServerWebSocket<WsContext>, raw: string | Buffer): void {
    let msg: WsClientMessage;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      msg = JSON.parse(text) as WsClientMessage;
    } catch {
      this.sendWs(ws, { type: "error", error: "invalid_json" });
      return;
    }

    if (!msg || msg.type !== "subscribe") {
      this.sendWs(ws, { type: "error", error: "unsupported_message_type" });
      return;
    }
    if (typeof msg.agent_id !== "string" || msg.agent_id.length === 0) {
      this.sendWs(ws, { type: "error", error: "invalid_agent_id" });
      return;
    }
    if (!this.isAgentAllowed(msg.agent_id)) {
      this.sendWs(ws, { type: "error", error: "agent_not_allowed" });
      ws.close(4403, "agent_not_allowed");
      return;
    }
    if (ws.data.subscription) {
      // One subscription per WS connection — replacing it would orphan the
      // previous subscriber record. Tell the client and keep the existing.
      this.sendWs(ws, { type: "error", error: "already_subscribed" });
      return;
    }

    const topics = msg.topics ?? this.defaultTopics;
    const subscription = this.bus.subscribe(
      {
        agent_id: msg.agent_id,
        ...(topics && topics.length > 0 ? { topics } : {}),
      },
      (event: BusEvent) => {
        // `readyState` 1 = OPEN (Bun mirrors the browser constants).
        if (ws.readyState !== 1) return;
        this.sendWs(ws, { type: "event", event });
      },
    );
    ws.data.subscription = subscription;
    this.sendWs(ws, { type: "ready", subscription_id: subscription.id });
  }

  private handleWsClose(ws: ServerWebSocket<WsContext>, _code: number, _reason: string): void {
    const ctx = ws.data;
    if (ctx?.subscription) {
      try {
        ctx.subscription.close();
      } catch (err) {
        this.logger.error("[webui-adapter] subscription.close error", err);
      }
      ctx.subscription = null;
    }
    this.activeSockets.delete(ws);
  }

  /* ──────────────────────────── helpers ───────────────────────────── */

  /**
   * Refuse browser requests from a foreign origin — see "Origin check" in
   * the file header. Runs before auth so a cross-site page learns nothing
   * about whether a token is configured.
   */
  private checkOrigin(req: Request): Response | null {
    const raw = req.headers.get("origin");
    if (raw === null) return null;
    const origin = normalizeOrigin(raw);
    if (origin !== null && this.allowedOrigins.has(origin)) return null;
    if (origin !== null && isTrustedSameOrigin(origin, req.headers.get("host"))) return null;
    this.logger.warn(
      `[webui-adapter] refused request from origin ${JSON.stringify(raw.slice(0, 200))}`,
    );
    return jsonError(403, "origin_not_allowed");
  }

  private checkHttpAuth(req: Request): Response | null {
    if (!this.token) return null;
    const bearer = extractBearer(req);
    if (bearer !== this.token) return jsonError(401, "unauthorized");
    return null;
  }

  private isAgentAllowed(agentId: string): boolean {
    if (!this.allowedAgentIds) return true;
    return this.allowedAgentIds.has(agentId);
  }

  private sendWs(ws: ServerWebSocket<WsContext>, msg: WsServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.error("[webui-adapter] ws.send error", err);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Module-private helpers                                                 */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Version reported by `/health`. Surfaced separately so the build-time
 * version-bump scripts can update one place. Sprint 2 doesn't gate on a
 * specific version; the field exists for forward-compatible client checks.
 */
const ADAPTER_VERSION = "0.1.0";

/**
 * What this daemon supports, for clients that must detect capabilities rather
 * than sniff the version (a client branching on "0.1.0" is doing the brittle
 * thing).
 *
 * Entries name OBSERVABLE BEHAVIOUR, never internal module names: a consumer
 * vendoring this core sees behaviour that survives a refactor, where an
 * internal name would drift.
 *
 * The array grows; it does not reorder or repurpose entries. A client that
 * checks for membership keeps working as it fills.
 */
/**
 * Identity of this daemon PROCESS, minted once at module load.
 *
 * The only property that matters is the one a version cannot give: it changes
 * when the daemon restarts and does not change when it has not. A client that
 * reconnects and sees a different value knows its cached state — subscriptions,
 * in-flight operation ids, the sequence number it had reached — belongs to a
 * process that no longer exists, and can resynchronise instead of resuming
 * against a daemon that never heard of any of it.
 *
 * Version cannot answer that: a restart onto the same build reports the same
 * version, which is precisely the case a desktop must not mistake for
 * continuity.
 *
 * `started_at` rides along because it answers "how long has this been up"
 * without a second round trip, and it makes a restart legible in a log where a
 * random id is not.
 */
const INSTANCE_ID = randomUUID();
const STARTED_AT = new Date().toISOString();

const ADAPTER_CAPABILITIES = [
  /**
   * Events published for a turn carry `promise_id` — the value `POST /prompt`
   * returned — while the operation owns the agent's slot.
   *
   * Deliberately NOT "every event": `response.turn_end` reaches the bus from
   * the JSONL tailer with no identity of its own, so the slot is held by
   * counting the terminators an agent still owes. Counting cannot see turns the
   * bus did not start — an operator typing in the agent's own TUI, a cron tick
   * — so such a turn ends a live operation early.
   *
   * The consequence is worse than a missing id, and the `correlation_ambiguity`
   * note below spells it out: the freed slot is taken by the next submission
   * without being flagged, and the earlier operation's remaining events publish
   * under that later id. Read this capability as "ids are emitted and are
   * correct in the common case", never as a guarantee of attribution.
   */
  "events.operation_id",
  /**
   * An event whose `promise_id` is known to be untrustworthy carries
   * `correlation_ambiguous: true` — set when a submit lands while the slot is
   * still occupied, and held for the whole life of that operation.
   *
   * KNOWN, and stronger than it may read: the flag covers overlapping submits,
   * NOT the ambient-turn case above. There the slot is released early, so the
   * next submission finds it free and is not flagged — and the first
   * operation's remaining events, including its final answer, then publish
   * under the SECOND operation's id with no flag at all. A client following the
   * second operation receives the first one's answer as its own result, and the
   * envelope asserts certainty.
   *
   * So a present id is ADVISORY, not authoritative: it is trustworthy only
   * where the client has out-of-band evidence that no turn ran on that agent
   * other than the ones it submitted.
   *
   * #239 narrowed the overlapping-submit case to one path: the bus admits one
   * prompt per agent at a time, so a submit can only land on an occupied slot
   * when the turn deadline freed it — and that admission is flagged. The
   * ambient-turn case above is unchanged; session-per-conversation (#376) is
   * where the remaining identity work goes.
   */
  "events.correlation_ambiguity",
  /** `/health` reports `instance_id` and `started_at`, which change on restart. */
  "health.instance_identity",
] as const;

function parseBind(bind: string | undefined): { host: string; port: number } {
  // Default per spec §5.5.4 sketch.
  const raw = bind && bind.length > 0 ? bind : "127.0.0.1:7878";
  // Last colon split so IPv6 literals (`[::1]:7878`) parse cleanly.
  const idx = raw.lastIndexOf(":");
  if (idx < 0) {
    throw new Error(`WebUiAdapter: invalid bind "${raw}" — expected host:port`);
  }
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, "");
  const portStr = raw.slice(idx + 1);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`WebUiAdapter: invalid bind port "${portStr}"`);
  }
  return { host, port };
}

/**
 * Canonical `scheme://host[:port]` for an origin string, or null when it is
 * not an http(s) origin (`null`, `file://`, garbage). Default ports are
 * dropped by `URL`, so `http://x:80` and `http://x` compare equal.
 */
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Same-origin, and on a host DNS rebinding cannot take over: a loopback name
 * or an IP literal. Anything else must be listed in `allowedOrigins`.
 */
function isTrustedSameOrigin(origin: string, hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const o = new URL(origin);
  let h: URL;
  try {
    h = new URL(`${o.protocol}//${hostHeader}`);
  } catch {
    return false;
  }
  if (o.host !== h.host) return false;
  const name = o.hostname.replace(/^\[|\]$/g, "");
  return name === "localhost" || isIP(name) !== 0;
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? (m[1] ?? null) : null;
}

function jsonOk<T extends object>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, error: string): Response {
  const body: ErrorResponseBody = { ok: false, error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type { WsClientMessage, WsServerMessage } from "./types";
