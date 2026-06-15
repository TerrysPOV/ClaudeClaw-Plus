import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getMcpBridge } from "./mcp-bridge.js";
import { getMetricsRegistry } from "./mcp-multiplexer/metrics.js";

const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "name must be lowercase kebab-case"),
  version: z.string(),
  schema_version: z.number().int().default(1),
  callback_url: z.string().url(),
  health_url: z.string().url().optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      schema: z.record(z.string(), z.unknown()),
    }),
  ),
  capabilities: z.array(z.string()).default(["tools"]),
});

const REPLAY_WINDOW_MS = 15 * 60 * 1000;
const PLUGIN_INVOKE_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = Number(process.env.PLUS_PLUGIN_MAX_BODY_BYTES ?? 1_048_576);

interface RegisteredPlugin {
  manifest: z.infer<typeof PluginManifestSchema>;
  pluginToken: Buffer;
  registeredAt: Date;
  lastHealthCheck?: { ts: Date; healthy: boolean; status?: number; error?: string };
  // Set for daemon-internal plugins that don't use a callback URL
  inProcessHealthFn?: () => Promise<Record<string, unknown>>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Per-server MCP request handler signature. Registered by the
 *  multiplexer; consumed by the `/mcp/<server-name>` route delegation
 *  below. See `mcp-multiplexer/index.ts`. */
export type McpRouteHandler = (req: Request) => Promise<Response>;

export class PluginHttpGateway {
  private plugins = new Map<string, RegisteredPlugin>();
  private bootstrapToken: Buffer;
  private allowedCallbackHosts: Set<string>;
  /** Invoke HMAC signatures seen within the replay window → reject a captured
   *  request resent before its ts ages out (the HMAC + ts-window alone accept
   *  it repeatedly). Maps signature → expiry epoch ms; pruned opportunistically
   *  so it stays bounded by the window, not by total request volume. */
  private seenInvokeSigs = new Map<string, number>();
  /** Per-server-name MCP route handlers registered by the multiplexer.
   *  Key is the lowercase kebab server name (matches `mcp-proxy.json`). */
  private mcpHandlers = new Map<string, McpRouteHandler>();

  constructor(opts: { allowedHosts?: string[] } = {}) {
    this.allowedCallbackHosts = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      ...(opts.allowedHosts ?? []),
    ]);
    this.bootstrapToken = this.loadOrCreateBootstrapToken();
  }

  /** Route an incoming Request. Returns Response if handled, null if not a plugin endpoint. */
  async handleRequest(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;

    // MCP multiplexer routes — delegate to the per-server handler the
    // multiplexer registered via `registerMcpHandler`. Path may be either
    // bare (`/mcp/<server>`) or sub-pathed (`/mcp/<server>/...`); the SDK
    // transport handles internal routing.
    if (path.startsWith("/mcp/")) {
      const segments = path.slice("/mcp/".length).split("/");
      const serverName = segments[0] ?? "";
      const handler = this.mcpHandlers.get(serverName);
      if (handler) return handler(req);
      return json({ error: { code: "mcp_server_not_registered", server: serverName } }, 404);
    }

    if (path === "/api/plugin/register" && method === "POST") return this.handleRegister(req);
    if (path === "/api/plugin/list" && method === "GET") return this.handleList(req);

    // /api/multiplexer/metrics — operator-only metrics snapshot
    // (issue #68). Authenticated with the bootstrap token, same
    // pattern as plugin registration. Returns the current counters +
    // latency percentiles for every (server, bucket, tool) tuple the
    // multiplexer has dispatched against since start.
    if (path === "/api/multiplexer/metrics" && method === "GET") {
      return this.handleMultiplexerMetrics(req);
    }

    // /api/plugin/:name/tools/:tool/invoke
    const invokeM = path.match(/^\/api\/plugin\/([^/]+)\/tools\/([^/]+)\/invoke$/);
    if (invokeM && method === "POST") return this.handleInvoke(req, invokeM[1]!, invokeM[2]!);

    // /api/plugin/:name/health
    const healthM = path.match(/^\/api\/plugin\/([^/]+)\/health$/);
    if (healthM && method === "GET") return this.handleHealthCheck(req, healthM[1]!);

    // /api/plugin/:name (DELETE)
    const nameM = path.match(/^\/api\/plugin\/([^/]+)$/);
    if (nameM && method === "DELETE") return this.handleUnregister(req, nameM[1]!);

    return null; // not a plugin endpoint
  }

  /**
   * Register a per-server MCP route handler. The multiplexer
   * (`mcp-multiplexer/index.ts`) calls this at startup for each
   * upstream child it brings up. The route mounted is
   * `/mcp/<serverName>` (and any sub-paths).
   *
   * Server names must match `mcp-proxy.json` keys (lowercase kebab).
   * Re-registering a name replaces the previous handler.
   */
  registerMcpHandler(serverName: string, handler: McpRouteHandler): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(serverName)) {
      throw new Error(`invalid mcp server name: ${JSON.stringify(serverName)}`);
    }
    this.mcpHandlers.set(serverName, handler);
  }

  /** Inverse of `registerMcpHandler`. Idempotent. */
  unregisterMcpHandler(serverName: string): void {
    this.mcpHandlers.delete(serverName);
  }

  /** Test seam — exposed for the multiplexer test slice. */
  hasMcpHandler(serverName: string): boolean {
    return this.mcpHandlers.has(serverName);
  }

  private requestId(req: Request): string {
    return req.headers.get("x-plus-request-id") ?? randomBytes(8).toString("hex");
  }

  private errorBody(code: string, message: string, requestId: string, plugin?: string) {
    return {
      error: {
        code,
        message,
        plugin: plugin ?? null,
        request_id: requestId,
        ts: new Date().toISOString(),
      },
    };
  }

  private loadOrCreateBootstrapToken(): Buffer {
    const path = join(homedir(), ".config", "plus", "plugin-bootstrap.secret");
    mkdirSync(join(path, ".."), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32));
      chmodSync(path, 0o600);
      console.error(
        `[plus-plugin-gateway] Bootstrap token initialized at ${path}. Use bun run src/plugins/cli.ts print-bootstrap-token to retrieve.`,
      );
    }
    return readFileSync(path);
  }

  private async handleRegister(req: Request): Promise<Response> {
    const requestId = this.requestId(req);
    const authToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!this.verifyBootstrap(authToken)) {
      return json(
        this.errorBody("invalid_bootstrap", "Invalid or missing Bearer token", requestId),
        401,
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(this.errorBody("invalid_body", "Could not parse JSON body", requestId), 400);
    }

    let manifest: z.infer<typeof PluginManifestSchema>;
    try {
      manifest = PluginManifestSchema.parse(body);
    } catch (e) {
      return json(this.errorBody("invalid_manifest", String(e), requestId), 400);
    }

    // Strip the brackets URL.hostname puts around IPv6 literals ("[::1]") so the
    // comparison matches the bare-form allowlist entries ("::1") (#255 self-review).
    const callbackHost = new URL(manifest.callback_url).hostname.replace(/^\[|\]$/g, "");
    if (!this.allowedCallbackHosts.has(callbackHost)) {
      return json(
        this.errorBody(
          "callback_host_not_allowed",
          `Host ${callbackHost} not in allowlist`,
          requestId,
          manifest.name,
        ),
        400,
      );
    }
    // health_url is fetched on demand by the (unauthenticated) health endpoint,
    // so it MUST be host-allowlisted exactly like callback_url — otherwise a
    // registered plugin could point it at an internal host/metadata endpoint and
    // turn the health check into an SSRF probe (MCP-bridge security audit).
    if (manifest.health_url) {
      const healthHost = new URL(manifest.health_url).hostname.replace(/^\[|\]$/g, "");
      if (!this.allowedCallbackHosts.has(healthHost)) {
        return json(
          this.errorBody(
            "health_host_not_allowed",
            `Host ${healthHost} not in allowlist`,
            requestId,
            manifest.name,
          ),
          400,
        );
      }
    }

    if (this.plugins.has(manifest.name)) {
      // Clean up stale tools from bridge before re-registering
      try {
        getMcpBridge().unregisterPlugin(manifest.name);
      } catch {}
      this.plugins.delete(manifest.name);
    }

    const pluginToken = randomBytes(32);
    const bridge = getMcpBridge();

    for (const toolDef of manifest.tools) {
      try {
        bridge.registerPluginTool(manifest.name, {
          name: toolDef.name,
          description: toolDef.description,
          schema: z.record(z.string(), z.unknown()),
          handler: async (args) => {
            const invokeRequestId = randomBytes(8).toString("hex");
            return this.invokeViaCallback(
              manifest.name,
              toolDef.name,
              args,
              pluginToken,
              manifest.callback_url,
              invokeRequestId,
            );
          },
        });
      } catch {
        // graceful: skip duplicates, continue
      }
    }

    this.plugins.set(manifest.name, { manifest, pluginToken, registeredAt: new Date() });
    try {
      bridge.audit("http_plugin_registered", {
        plugin: manifest.name,
        tools_count: manifest.tools.length,
        request_id: requestId,
      });
    } catch {}

    return json({
      plugin_name: manifest.name,
      plugin_token: pluginToken.toString("hex"),
      registered_tools: manifest.tools.map((t) => `${manifest.name}__${t.name}`),
      capabilities_acknowledged: manifest.capabilities,
      request_id: requestId,
    });
  }

  private async handleInvoke(req: Request, name: string, tool: string): Promise<Response> {
    const requestId = this.requestId(req);
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return json(
        this.errorBody("plugin_not_registered", `Plugin '${name}' not registered`, requestId, name),
        404,
      );
    }

    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json(
        this.errorBody(
          "body_too_large",
          `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          requestId,
          name,
        ),
        413,
      );
    }

    const ts = req.headers.get("x-plus-ts") ?? "";
    const sig = req.headers.get("x-plus-signature") ?? "";
    // Use raw body bytes for HMAC — re-serialization changes byte order (breaks Python default separators)
    const rawBuf = await req.arrayBuffer();
    if (rawBuf.byteLength > MAX_BODY_BYTES) {
      return json(
        this.errorBody(
          "body_too_large",
          `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          requestId,
          name,
        ),
        413,
      );
    }
    const rawBody = new TextDecoder().decode(rawBuf);
    const bodyStr = rawBody || "{}";
    let body: unknown;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      body = {};
    }

    if (!ts || !sig || !this.verifyHmac(plugin.pluginToken, bodyStr, ts, sig)) {
      return json(
        this.errorBody("invalid_signature", "HMAC verification failed", requestId, name),
        401,
      );
    }

    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) {
      return json(
        this.errorBody(
          "stale_or_future_timestamp",
          `ts outside ${REPLAY_WINDOW_MS / 1000}s window`,
          requestId,
          name,
        ),
        401,
      );
    }

    // Replay guard: the HMAC + ts-window above accept a captured request as many
    // times as it is resent within the window. Reject a signature already used,
    // and prune entries past the window so the map stays bounded (#255 follow-up).
    const nowMs = Date.now();
    for (const [s, exp] of this.seenInvokeSigs) {
      if (exp <= nowMs) this.seenInvokeSigs.delete(s);
    }
    if (this.seenInvokeSigs.has(sig)) {
      return json(
        this.errorBody("replayed_signature", "request signature already used", requestId, name),
        401,
      );
    }
    this.seenInvokeSigs.set(sig, tsMs + REPLAY_WINDOW_MS);

    const fqn = `${name}__${tool}`;
    const bridge = getMcpBridge();
    // Gateway-level audit carries request_id through the invoke lifecycle
    try {
      bridge.audit("gateway_invoke", { fqn, request_id: requestId, plugin: name, phase: "start" });
    } catch {}
    try {
      const result = await bridge.invokeTool(fqn, body);
      try {
        bridge.audit("gateway_invoke", {
          fqn,
          request_id: requestId,
          plugin: name,
          phase: "end",
          success: true,
        });
      } catch {}
      return json({ result, request_id: requestId });
    } catch (e) {
      try {
        bridge.audit("gateway_invoke", {
          fqn,
          request_id: requestId,
          plugin: name,
          phase: "end",
          success: false,
        });
      } catch {}
      return json(
        this.errorBody(
          "invoke_failed",
          e instanceof Error ? e.message : String(e),
          requestId,
          name,
        ),
        502,
      );
    }
  }

  private async invokeViaCallback(
    pluginName: string,
    toolName: string,
    args: unknown,
    pluginToken: Buffer,
    callbackUrl: string,
    requestId: string,
  ): Promise<unknown> {
    const ts = new Date().toISOString();
    const body = JSON.stringify({ tool: toolName, args });
    const signature = this.signHmac(pluginToken, body, ts);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PLUGIN_INVOKE_TIMEOUT_MS);
    try {
      const resp = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plus-Ts": ts,
          "X-Plus-Signature": signature,
          "X-Plus-Request-Id": requestId,
        },
        body,
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        throw new Error(
          `Plugin ${pluginName} callback ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
        );
      }
      const result = (await resp.json()) as { result?: unknown; error?: unknown };
      if (result.error) throw new Error(`Plugin error: ${JSON.stringify(result.error)}`);
      return result.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleUnregister(req: Request, name: string): Promise<Response> {
    const requestId = this.requestId(req);
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return json(
        this.errorBody("plugin_not_registered", `Plugin '${name}' not registered`, requestId, name),
        404,
      );
    }
    const authToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
    const tokenBuf = Buffer.from(authToken, "hex");
    const validBootstrap = this.verifyBootstrap(authToken);
    const validPlugin =
      tokenBuf.length === plugin.pluginToken.length &&
      timingSafeEqual(tokenBuf, plugin.pluginToken);
    if (!validBootstrap && !validPlugin) {
      return json(
        this.errorBody("unauthorized", "Bootstrap or plugin token required", requestId, name),
        401,
      );
    }
    this.plugins.delete(name);
    try {
      getMcpBridge().unregisterPlugin(name);
    } catch {}
    getMcpBridge().audit("http_plugin_unregistered", { plugin: name, request_id: requestId });
    return json({ unregistered: name, request_id: requestId });
  }

  private async handleList(req: Request): Promise<Response> {
    const requestId = this.requestId(req);
    // The plugin/tool inventory is sensitive (it maps the agent's capability
    // surface); gate it behind the bootstrap token like /register and
    // /multiplexer/metrics, rather than leaving it world-readable on the bind.
    const authToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!this.verifyBootstrap(authToken)) {
      return json(
        this.errorBody("invalid_bootstrap", "Invalid or missing Bearer token", requestId),
        401,
      );
    }
    const list = [...this.plugins.values()].map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      schema_version: p.manifest.schema_version,
      tools: p.manifest.tools.map((t) => t.name),
      capabilities: p.manifest.capabilities,
      registered_at: p.registeredAt.toISOString(),
      last_health_check: p.lastHealthCheck ?? null,
    }));
    return json({ plugins: list, request_id: requestId });
  }

  /**
   * /api/multiplexer/metrics — snapshot of multiplexer dispatch
   * counters + latency percentiles. Issue #68. Bootstrap-token
   * authenticated (same auth gate as `/api/plugin/register`).
   *
   * When `settings.mcp.metricsEnabled` is `false` (the default), the
   * registry is disabled and the snapshot returns
   * `{ enabled: false, tuples: [] }` — the endpoint stays reachable
   * so operators can probe the flag from any tooling.
   */
  private async handleMultiplexerMetrics(req: Request): Promise<Response> {
    const requestId = this.requestId(req);
    const authToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!this.verifyBootstrap(authToken)) {
      return json(
        this.errorBody("invalid_bootstrap", "Invalid or missing Bearer token", requestId),
        401,
      );
    }
    const snapshot = getMetricsRegistry().snapshot();
    return json({ ...snapshot, request_id: requestId });
  }

  private async handleHealthCheck(req: Request, name: string): Promise<Response> {
    const requestId = this.requestId(req);
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return json(
        this.errorBody("plugin_not_registered", `Plugin '${name}' not registered`, requestId, name),
        404,
      );
    }
    if (plugin.inProcessHealthFn) {
      try {
        const health = await plugin.inProcessHealthFn();
        return json({ name, healthy: true, ...health, request_id: requestId });
      } catch (e) {
        return json({ name, healthy: false, error: String(e), request_id: requestId });
      }
    }
    if (!plugin.manifest.health_url) {
      return json({
        name,
        healthy: true,
        note: "No health_url declared — plugin assumed healthy",
        request_id: requestId,
      });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      // redirect:"manual" so an allowlisted health_url cannot 3xx-redirect the
      // request to an internal host (SSRF via redirect). Raw error strings are
      // NOT reflected to the caller — they can leak internal network topology;
      // a generic "unreachable" is returned instead (MCP-bridge security audit).
      const r = await fetch(plugin.manifest.health_url, {
        signal: ctrl.signal,
        redirect: "manual",
      });
      // A 3xx (redirect:"manual" surfaces it as an opaque/normal response, not a
      // throw) means the host RESPONDED, so the service is up — don't equate a
      // redirect-fronted health_url with "down" (#255 self-review). We still
      // never follow the redirect (SSRF safety).
      const healthy = r.ok || (r.status >= 300 && r.status < 400);
      plugin.lastHealthCheck = { ts: new Date(), healthy, status: r.status };
      return json({ name, healthy, status: r.status, request_id: requestId });
    } catch (e) {
      plugin.lastHealthCheck = { ts: new Date(), healthy: false, error: String(e) };
      return json({ name, healthy: false, error: "unreachable", request_id: requestId });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── HMAC + bootstrap ──────────────────────────────────────────────────────

  private verifyBootstrap(token: string): boolean {
    try {
      const tokenBuf = Buffer.from(token, "hex");
      if (tokenBuf.length !== this.bootstrapToken.length) return false;
      return timingSafeEqual(tokenBuf, this.bootstrapToken);
    } catch {
      return false;
    }
  }

  signHmac(secret: Buffer, body: string, ts: string): string {
    return createHmac("sha256", secret).update(`${ts}\n${body}`).digest("hex");
  }

  verifyHmac(secret: Buffer, body: string, ts: string, sig: string): boolean {
    try {
      const expected = this.signHmac(secret, body, ts);
      if (expected.length !== sig.length) return false;
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
    } catch {
      return false;
    }
  }

  /**
   * Register a daemon-internal plugin that handles its own tool invocations via the
   * PluginMcpBridge (no HTTP callback required). Returns the plugin token for callers.
   *
   * Tools must be pre-registered on getMcpBridge() before calling this. The gateway
   * handles auth (HMAC with the returned token) and routes invocations to the bridge.
   */
  registerInProcess(
    name: string,
    opts: {
      version: string;
      tools: { name: string; description: string; schema: Record<string, unknown> }[];
      healthFn?: () => Promise<Record<string, unknown>>;
    },
  ): Buffer {
    if (this.plugins.has(name)) {
      try {
        getMcpBridge().unregisterPlugin(name);
      } catch {}
      this.plugins.delete(name);
    }

    const pluginToken = randomBytes(32);
    const syntheticManifest = {
      name,
      version: opts.version,
      schema_version: 1,
      callback_url: "http://localhost:0/noop",
      health_url: undefined,
      tools: opts.tools,
      capabilities: ["tools"] as string[],
    };

    this.plugins.set(name, {
      manifest: syntheticManifest as z.infer<typeof PluginManifestSchema>,
      pluginToken,
      registeredAt: new Date(),
      inProcessHealthFn: opts.healthFn,
    });

    getMcpBridge().audit("in_process_plugin_registered", {
      plugin: name,
      tools_count: opts.tools.length,
    });
    return pluginToken;
  }

  /** Expose for tests */
  get pluginCount(): number {
    return this.plugins.size;
  }
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }
  getPluginToken(name: string): Buffer | undefined {
    return this.plugins.get(name)?.pluginToken;
  }
}

let _gateway: PluginHttpGateway | null = null;

export function getHttpGateway(opts?: { allowedHosts?: string[] }): PluginHttpGateway {
  if (!_gateway) _gateway = new PluginHttpGateway(opts);
  return _gateway;
}

export function _resetHttpGateway(): void {
  _gateway = null;
}
