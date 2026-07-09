import { timingSafeEqual, randomUUID } from "crypto";
import { readMemoryPressure } from "../observability/memory-pressure.js";
import { tmpdir } from "node:os";
import { htmlPage } from "./page/html";
import { clampInt, json } from "./http";
import { checkToken } from "./auth";
import type { StartWebUiOptions, WebServerHandle } from "./types";
import { buildState, buildTechnicalInfo, sanitizeSettings } from "./services/state";
import { readHeartbeatSettings, updateHeartbeatSettings } from "./services/settings";
import {
  readLlmRouterSettings,
  updateLlmRouterSettings,
  type LlmRouterTiers,
} from "./services/llm-router-settings";
import { ModelCatalogue } from "../plugins/llm-router/catalogue";
import type { LlmModelsParams } from "../plugins/llm-router/types";
import { createQuickJob, deleteJob } from "./services/jobs";
import { fireJob } from "../commands/fire";
import { readLogs } from "./services/logs";
import { listSessions, readSessionMessages, listAgents } from "./services/sessions";
import { getSessionUsage } from "./services/usage";
import { runUserMessage } from "../runner";
import { readKanban, writeKanban, type KanbanBoard } from "./services/kanban";
import { getHttpGateway } from "../plugins/http-gateway.js";

// --- Security: layered defenses ---
// The Web UI has several layers:
//   - A persisted 256-bit web token (`getOrCreateWebToken`, issue #164)
//     with byte-safe `checkToken`, ENFORCED on every `/api/*` route in
//     the fetch handler below (`/api/health` is the only pre-auth API
//     route; `/api/inject` also accepts the legacy `settings.apiToken`).
//     The dashboard reads the token from `?token=` on first load.
//   - Host-header validation + cross-origin POST/DELETE rejection in the
//     fetch handler (issue #164 items 2/3).
//   - Per-session CSRF tokens (below) on state-changing routes.
const CSRF_HEADER_NAME = "X-CSRF-Token";
const MAX_CSRF_TOKENS = 10000;

// LLM router catalogue cache (#70 Phase C). Lazy module-level singleton —
// rebuilt only when the API key or base URL changes between requests.
let _llmRouterCatalogue: { key: string; baseUrl: string; instance: ModelCatalogue } | null = null;
async function getLlmRouterCatalogue(apiKey: string, baseUrl: string): Promise<ModelCatalogue> {
  // A test-injected catalogue (key === "__test__") is sticky: routes hit the
  // stub regardless of the runtime key/baseUrl. Production paths only rebuild
  // when key or baseUrl changes.
  if (_llmRouterCatalogue?.key === "__test__") return _llmRouterCatalogue.instance;
  if (
    !_llmRouterCatalogue ||
    _llmRouterCatalogue.key !== apiKey ||
    _llmRouterCatalogue.baseUrl !== baseUrl
  ) {
    _llmRouterCatalogue = {
      key: apiKey,
      baseUrl,
      instance: new ModelCatalogue({ apiKey, baseUrl }),
    };
  }
  return _llmRouterCatalogue.instance;
}

/** Test seam — reset the singleton between tests (or inject a stub). */
export function __setLlmRouterCatalogueForTests(instance: ModelCatalogue | null): void {
  _llmRouterCatalogue = instance ? { key: "__test__", baseUrl: "__test__", instance } : null;
}

function parseLlmModelsQuery(url: URL): LlmModelsParams {
  const sp = url.searchParams;
  const num = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v === null || v === "") return undefined;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    ...(sp.get("query") ? { query: sp.get("query") as string } : {}),
    ...(num("maxPromptPrice") !== undefined ? { maxPromptPrice: num("maxPromptPrice") } : {}),
    ...(num("minContext") !== undefined ? { minContext: num("minContext") } : {}),
    ...(num("limit") !== undefined ? { limit: num("limit") } : {}),
  };
}

interface CsrfEntry {
  tokens: Array<{ token: string; expiresAt: number }>;
}

const csrfTokens = new Map<string, CsrfEntry>();

function generateCsrfToken(sessionId: string): string {
  // Evict expired tokens and enforce max size
  if (csrfTokens.size > MAX_CSRF_TOKENS) {
    const now = Date.now();
    for (const [key, entry] of csrfTokens) {
      const valid = entry.tokens.filter((t) => now <= t.expiresAt);
      if (valid.length === 0) {
        csrfTokens.delete(key);
      } else {
        csrfTokens.set(key, { tokens: valid });
      }
    }
    // If still over limit after cleanup, remove oldest entry
    if (csrfTokens.size > MAX_CSRF_TOKENS) {
      const firstKey = csrfTokens.keys().next().value;
      if (firstKey) csrfTokens.delete(firstKey);
    }
  }

  const token = randomUUID();
  const newToken = { token, expiresAt: Date.now() + 3600000 }; // 1 hour
  const existing = csrfTokens.get(sessionId);
  const tokens = existing ? [...existing.tokens.slice(-4), newToken] : [newToken];
  csrfTokens.set(sessionId, { tokens });
  return token;
}

function validateCsrfToken(sessionId: string, token: string): boolean {
  const entry = csrfTokens.get(sessionId);
  if (!entry) return false;
  const now = Date.now();
  const validTokens = entry.tokens.filter((t) => now <= t.expiresAt);
  if (validTokens.length === 0) {
    csrfTokens.delete(sessionId);
    return false;
  }
  const matchIndex = validTokens.findIndex((t) => {
    const a = Buffer.from(t.token);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  });
  if (matchIndex === -1) {
    // Update entry to only keep valid (non-expired) tokens
    csrfTokens.set(sessionId, { tokens: validTokens });
    return false;
  }
  // Consume the token to prevent replay attacks
  validTokens.splice(matchIndex, 1);
  if (validTokens.length === 0) {
    csrfTokens.delete(sessionId);
  } else {
    csrfTokens.set(sessionId, { tokens: validTokens });
  }
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getOrCreateSessionId(req: Request): { sessionId: string; setCookie?: string } {
  const existing = req.headers.get("Cookie")?.match(/session_id=([^;]+)/)?.[1];
  if (existing && UUID_RE.test(existing)) return { sessionId: existing };
  // Invalid format or missing — issue a new session
  const isSecure = req.headers.get("x-forwarded-proto") === "https" || req.url.startsWith("https");
  const securePart = isSecure ? "; Secure" : "";
  const newId = randomUUID();
  return {
    sessionId: newId,
    setCookie: `session_id=${newId}; Path=/; HttpOnly; SameSite=Strict${securePart}`,
  };
}

/**
 * Hostname allowlist check for DNS-rebinding defense (issue #164 item 2,
 * hotfixed after #189). Compares the Host header's HOSTNAME only (port
 * stripped) against the loopback names + the configured bind host. A
 * wildcard bind (0.0.0.0 / ::) returns `true` unconditionally — the
 * operator opted into remote access.
 *
 * Port is deliberately ignored: DNS-rebinding hinges on the hostname,
 * and matching the port broke tunnelled access (the Host carries the
 * client-side forwarded port, not the bind port).
 *
 * Exported for unit testing.
 */
export function isHostAllowed(hostHeader: string, bindHost: string): boolean {
  if (bindHost === "0.0.0.0" || bindHost === "::") return true;
  const hostname = hostnameOf(hostHeader);
  const allowed = new Set(["127.0.0.1", "localhost", "[::1]", "::1", bindHost.toLowerCase()]);
  return allowed.has(hostname);
}

/**
 * Extract the hostname from a Host header, dropping the optional `:port`.
 * IPv6-aware so a bare `::1` or a LAN bind like `fe80::1` isn't mangled
 * by a naive `:\d+$` strip (which would turn `::1` into `:`):
 *   - `[::1]:4632` / `[::1]`     → `[::1]`   (bracketed IPv6; strip after `]`)
 *   - `::1` / `fe80::1`          → unchanged (bare IPv6 — 2+ colons, no port)
 *   - `localhost:8080` / `1.2.3.4:80` / `host` → port stripped if present
 */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h : h.slice(0, close + 1);
  }
  // A valid Host header never carries a port on a bare (unbracketed) IPv6,
  // so 2+ colons means bare IPv6 — leave it intact.
  if ((h.match(/:/g)?.length ?? 0) > 1) return h;
  return h.replace(/:\d+$/, "");
}

/** Returns a 403 Response if the CSRF token is missing or invalid, otherwise null. */
function requireCsrf(req: Request): Response | null {
  const csrfToken = req.headers.get(CSRF_HEADER_NAME);
  const { sessionId } = getOrCreateSessionId(req);
  if (!csrfToken || !validateCsrfToken(sessionId, csrfToken)) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid CSRF token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Issue #164 item 2: DNS-rebinding defense via Host header
      // validation. A wildcard bind (0.0.0.0 / ::) means the operator
      // opted into remote access and the browser Host won't match the
      // bind address, so the check is skipped there. For a specific
      // bind (loopback / LAN IP) we enforce a HOSTNAME allowlist.
      //
      // We compare the hostname ONLY, ignoring the port — DNS-rebinding
      // turns on the malicious HOSTNAME (attacker.com resolving to
      // 127.0.0.1), never the port, so the port is irrelevant to the
      // defense. Matching host:port (the original #189 port) broke every
      // tunnelled / port-forwarded deployment: an `ssh -L 8080:…:4632`
      // or VS Code forward sends the CLIENT-side port (8080) in Host,
      // not the bind port (4632), so the daemon 421'd its own dashboard.
      // Runs before the plugin gateway so /mcp/* and /api/plugin/* are
      // covered too; the local MCP bridge calls with Host
      // `127.0.0.1:<port>`, whose hostname (127.0.0.1) is allowlisted.
      const host = req.headers.get("host") ?? "";
      if (!isHostAllowed(host, opts.host)) {
        return new Response("Bad Host", { status: 421 });
      }

      // Issue #164 item 3: CSRF defense-in-depth — reject cross-origin
      // state-changing requests. Only fires when an Origin header is
      // present (browsers set it on POST/DELETE; the local MCP bridge
      // and CLI clients don't, so they pass). This layers under the
      // existing per-session CSRF-token check (PR #75).
      if (req.method === "POST" || req.method === "DELETE") {
        const origin = req.headers.get("origin");
        if (origin) {
          const allowedOrigins = new Set([`http://${host}`, `https://${host}`]);
          if (!allowedOrigins.has(origin)) {
            return new Response("Bad Origin", { status: 403 });
          }
        }
      }

      // Plugin HTTP gateway — handles /api/plugin/* routes and
      // /mcp/<server>/* multiplexer routes (registered by the
      // McpMultiplexerPlugin at daemon startup).
      if (url.pathname.startsWith("/api/plugin/") || url.pathname.startsWith("/mcp/")) {
        try {
          const gatewayResp = await getHttpGateway().handleRequest(req, url);
          if (gatewayResp !== null) return gatewayResp;
        } catch (e) {
          return Response.json({ error: "gateway_error", message: String(e) }, { status: 500 });
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Issue #164 PR B (Codex P1): the dashboard is opened with the
            // web token in ?token=. no-referrer guarantees the token is
            // never sent in a Referer header to the Google Fonts (or any
            // cross-origin) subresource requests fired during head parse,
            // regardless of the browser's default Referrer-Policy. Safe
            // here — nothing in the dashboard relies on Referer (CSRF uses
            // X-CSRF-Token; the Origin gate uses the Origin header, which
            // this policy does not affect).
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      // Health check is intentionally pre-auth so monitors / load balancers
      // work unauthenticated.
      if (url.pathname === "/api/health") {
        // #178: expose the daemon cgroup memory state so external monitors
        // can tell a memory-freeze (cgroup over MemoryHigh — kill the hog,
        // do NOT restart-loop the daemon) apart from a dead daemon. See
        // docs/deploy-systemd-hardening.md.  stays true: the freeze
        // discriminator must not trip naive ok-based restart loops.
        const mem = readMemoryPressure();
        return json({
          ok: true,
          now: Date.now(),
          ...(mem.supported
            ? {
                memory: {
                  overHigh: mem.overHigh,
                  currentBytes: mem.currentBytes,
                  highBytes: mem.highBytes,
                  highEvents: mem.highEvents,
                },
              }
            : {}),
        });
      }

      // Issue #164 PR B: require the web token for every /api/* route.
      // The HTML shell ("/" above) and /api/health (above) stay pre-auth;
      // the dashboard JS reads the token from `?token=` on first load and
      // attaches it as `Authorization: Bearer` to every subsequent fetch.
      // /api/inject ALSO accepts the legacy settings.apiToken so existing
      // automation keeps working. (Plugin gateway + /mcp/* routes are
      // handled earlier in the fetch handler and never reach here.)
      if (url.pathname.startsWith("/api/")) {
        const validWebToken = checkToken(req, opts.token);
        const apiToken = opts.getSnapshot().settings.apiToken;
        const validApiToken =
          url.pathname === "/api/inject" && !!apiToken && checkToken(req, apiToken);
        if (!validWebToken && !validApiToken) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }

      if (url.pathname === "/api/csrf-token") {
        const { sessionId, setCookie } = getOrCreateSessionId(req);
        const token = generateCsrfToken(sessionId);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        };
        if (setCookie) headers["Set-Cookie"] = setCookie;
        return new Response(JSON.stringify({ token }), { headers });
      }

      if (url.pathname === "/api/state") {
        return json(await buildState(opts.getSnapshot()));
      }

      if (url.pathname === "/api/settings") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = await req.json();
          const payload = body as {
            enabled?: unknown;
            interval?: unknown;
            prompt?: unknown;
            excludeWindows?: unknown;
          };
          const patch: {
            enabled?: boolean;
            interval?: number;
            prompt?: string;
            excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
          } = {};

          if ("enabled" in payload) patch.enabled = Boolean(payload.enabled);
          if ("interval" in payload) {
            const iv = Number(payload.interval);
            if (!Number.isFinite(iv)) throw new Error("interval must be numeric");
            patch.interval = iv;
          }
          if ("prompt" in payload) patch.prompt = String(payload.prompt ?? "");
          if ("excludeWindows" in payload) {
            if (!Array.isArray(payload.excludeWindows)) {
              throw new Error("excludeWindows must be an array");
            }
            patch.excludeWindows = payload.excludeWindows
              .filter((entry) => entry && typeof entry === "object")
              .map((entry) => {
                const row = entry as Record<string, unknown>;
                const start = String(row.start ?? "").trim();
                const end = String(row.end ?? "").trim();
                const days = Array.isArray(row.days)
                  ? row.days
                      .map((d) => Number(d))
                      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
                  : undefined;
                return {
                  start,
                  end,
                  ...(days && days.length > 0 ? { days } : {}),
                };
              });
          }

          if (
            !("enabled" in patch) &&
            !("interval" in patch) &&
            !("prompt" in patch) &&
            !("excludeWindows" in patch)
          ) {
            throw new Error("no heartbeat fields provided");
          }

          const next = await updateHeartbeatSettings(patch);
          if (opts.onHeartbeatEnabledChanged && "enabled" in patch) {
            await opts.onHeartbeatEnabledChanged(Boolean(patch.enabled));
          }
          if (opts.onHeartbeatSettingsChanged) {
            await opts.onHeartbeatSettingsChanged(patch);
          }
          return json({ ok: true, heartbeat: next });
        } catch (err) {
          console.error("Heartbeat settings update failed:", err);
          return json({ ok: false, error: "Failed to update heartbeat settings" });
        }
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "GET") {
        try {
          return json({ ok: true, heartbeat: await readHeartbeatSettings() });
        } catch (err) {
          console.error("Heartbeat settings read failed:", err);
          return json({ ok: false, error: "Failed to read heartbeat settings" });
        }
      }

      // LLM router settings (#70 Phase C) — read + patch tiers.
      if (url.pathname === "/api/settings/llm-router" && req.method === "GET") {
        try {
          return json({ ok: true, llmRouter: await readLlmRouterSettings() });
        } catch (err) {
          console.error("LLM router settings read failed:", err);
          return json({ ok: false, error: "Failed to read llm-router settings" });
        }
      }

      if (url.pathname === "/api/settings/llm-router" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = (await req.json()) as { tiers?: Partial<LlmRouterTiers> };
          const tiersPatch: Partial<LlmRouterTiers> = {};
          if (body.tiers && typeof body.tiers === "object") {
            const keys = ["fast", "balanced", "reasoning"] as const;
            for (const k of keys) {
              const v = (body.tiers as Record<string, unknown>)[k];
              if (Array.isArray(v))
                tiersPatch[k] = v.filter((x): x is string => typeof x === "string");
            }
          }
          if (Object.keys(tiersPatch).length === 0) {
            return json({ ok: false, error: "no tier fields provided" }, 400);
          }
          const next = await updateLlmRouterSettings({ tiers: tiersPatch });
          return json({ ok: true, llmRouter: next });
        } catch (err) {
          console.error("LLM router settings update failed:", err);
          return json({ ok: false, error: "Failed to update llm-router settings" });
        }
      }

      // OpenRouter catalogue proxy backing the dashboard model picker (#70 D3).
      // Lazy singleton catalogue; reads OPENROUTER_API_KEY at request time so a
      // late-set env var works without a daemon restart.
      if (url.pathname === "/api/llm-router/models" && req.method === "GET") {
        try {
          const params = parseLlmModelsQuery(url);
          const apiKey = process.env.OPENROUTER_API_KEY ?? "";
          if (!apiKey) {
            return json(
              { ok: false, error: "OPENROUTER_API_KEY is not set in the daemon environment" },
              503,
            );
          }
          const settings = await readLlmRouterSettings();
          const catalogue = await getLlmRouterCatalogue(apiKey, settings.openRouterBaseUrl);
          const { models, cachedAt } = await catalogue.search(params);
          return json({ ok: true, models, cachedAt });
        } catch (err) {
          console.error("LLM router catalogue search failed:", err);
          return json({ ok: false, error: "catalogue search failed" }, 502);
        }
      }

      if (url.pathname === "/api/technical-info") {
        return json(await buildTechnicalInfo(opts.getSnapshot()));
      }

      if (url.pathname === "/api/jobs/quick" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = await req.json();
          const result = await createQuickJob(body as { time?: unknown; prompt?: unknown });
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true, ...result });
        } catch (err) {
          console.error("Quick job creation failed:", err);
          return json({ ok: false, error: "Failed to create job" });
        }
      }

      if (url.pathname.startsWith("/api/jobs/") && req.method === "DELETE") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const encodedName = url.pathname.slice("/api/jobs/".length);
          const name = decodeURIComponent(encodedName);
          await deleteJob(name);
          if (opts.onJobsChanged) await opts.onJobsChanged();
          return json({ ok: true });
        } catch (err) {
          console.error("Job deletion failed:", err);
          return json({ ok: false, error: "Failed to delete job" });
        }
      }

      if (url.pathname === "/api/jobs") {
        const jobs = opts.getSnapshot().jobs.map((j) => ({
          name: j.name,
          schedule: j.schedule,
          promptPreview: j.prompt.slice(0, 160),
          agent: j.agent,
          label: j.label,
          fireable: Boolean(j.agent && j.label),
        }));
        return json({ jobs });
      }

      if (url.pathname === "/api/jobs/fire" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = (await req.json()) as { agent?: unknown; label?: unknown };
          const agent = typeof body.agent === "string" ? body.agent.trim() : "";
          const label = typeof body.label === "string" ? body.label.trim() : "";
          if (!agent || !label) {
            return json({ ok: false, error: "agent and label are required" });
          }
          // Bus runtime: route the prompt through the live bus so claude
          // is driven by the existing per-agent session rather than a
          // sidecar PTY spawn (which would race the bus's own claude).
          // Inject a runner that maps `runner(name, prompt, agent)` to
          // `bus.sendPromptAndAwait(agent, prompt)` and keep `fireJob`'s
          // existing storage-lookup + prompt-resolution logic intact.
          //
          // Capture bus-mode failures (`ok: false` from the bridge —
          // timeout, dispatch error) in an out-of-band variable so we
          // can surface the error on the response. fireJob's `error`
          // field is only set when the agent/job isn't found; the
          // runner's failure mode is signalled via exit code + stderr,
          // which fireJob doesn't propagate up.
          let busRunnerError: string | undefined;
          const fireOpts = opts.bus
            ? {
                runner: async (name: string, prompt: string, jobAgent?: string) => {
                  const target = jobAgent ?? agent;
                  const out = await (opts.bus as NonNullable<typeof opts.bus>).sendPromptAndAwait(
                    target,
                    prompt,
                    { origin: "webui", originId: `job:${name}` },
                  );
                  if (!out.ok && out.error) busRunnerError = out.error;
                  return {
                    exitCode: out.exitCode,
                    stdout: out.output,
                    stderr: out.ok ? "" : (out.error ?? ""),
                  };
                },
              }
            : undefined;
          const result = await fireJob(agent, label, fireOpts);
          return json({
            ok: result.success,
            success: result.success,
            exitCode: result.exitCode,
            output: result.output,
            error: result.error ?? busRunnerError,
            agent,
            label,
          });
        } catch (err) {
          console.error("Fire job failed:", err);
          return json({ ok: false, error: "Failed to fire job" });
        }
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        try {
          return json(await listSessions());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/usage" && req.method === "GET") {
        try {
          const channelNames = opts.getSnapshot().settings.discord?.channelNames;
          return json(await getSessionUsage(channelNames));
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          return json(await listAgents());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (
        url.pathname.startsWith("/api/sessions/") &&
        url.pathname.endsWith("/messages") &&
        req.method === "GET"
      ) {
        const sessionId = url.pathname.slice("/api/sessions/".length, -"/messages".length);
        const limit = clampInt(url.searchParams.get("limit"), 10, 1, 2000);
        const rawOffset = url.searchParams.get("offset");
        const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 100_000);
        try {
          return json(await readSessionMessages(sessionId, limit, offset));
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/inject" && req.method === "POST") {
        // Auth already enforced by the /api/* block above (web token OR
        // the legacy settings.apiToken). No extra checkBearer here — it
        // would wrongly reject a valid web-token-only request.
        try {
          const body = await req.json();
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) return json({ ok: false, error: "message is required" }, 400);
          // Bus runtime: route the inject through the bus's default
          // agent so it lands in the same claude session the heartbeat
          // and adapters are driving. Legacy runtime falls back to the
          // PTY runner — `inject` was its "send a prompt into the
          // current session" path.
          let stdout: string;
          let exitCode: number;
          // Track bus-mode failure so we can surface it on the response
          // instead of returning `{ok: true}` with empty output —
          // companion to the chat-error surfacing in start.ts's onChat.
          let busError: string | undefined;
          let ok = true;
          if (opts.bus) {
            const out = await opts.bus.sendPromptAndAwait(opts.bus.defaultAgentId, message, {
              origin: "webui",
              originId: "inject",
            });
            stdout = out.output;
            exitCode = out.exitCode;
            if (!out.ok) {
              ok = false;
              busError = out.error;
            }
          } else {
            const result = await runUserMessage("inject", message);
            stdout = result.stdout;
            exitCode = result.exitCode;
          }
          const text = stdout.trim();
          const { telegram } = opts.getSnapshot().settings;
          if (text && telegram.token && telegram.allowedUserIds.length > 0) {
            const chatId = telegram.allowedUserIds[0];
            fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text }),
            }).catch(() => {});
          }
          return json({
            ok,
            result: stdout,
            exitCode,
            ...(busError ? { error: busError } : {}),
          });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!opts.onChat) return json({ ok: false, error: "chat not configured" });
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = await req.json();
          const message = String(body?.message ?? "").trim();

          interface Attachment {
            name: string;
            type: string;
            data: string; // base64
          }

          const rawAttachments = Array.isArray(body?.attachments)
            ? (body.attachments as unknown[])
            : [];

          // Validate attachments
          if (rawAttachments.length > 5) {
            return json({ ok: false, error: "too many attachments (max 5)" }, 400);
          }

          const attachments: Attachment[] = [];
          for (const raw of rawAttachments) {
            if (!raw || typeof raw !== "object") continue;
            const att = raw as Record<string, unknown>;
            const name = String(att.name ?? "");
            const type = String(att.type ?? "");
            const data = String(att.data ?? "");
            // base64 decoded size approximation
            const decodedSize = data.length * 0.75;
            if (decodedSize > 10 * 1024 * 1024) {
              return json({ ok: false, error: `attachment "${name}" exceeds 10 MB limit` }, 400);
            }
            attachments.push({ name, type, data });
          }

          if (!message && attachments.length === 0) {
            return json({ ok: false, error: "message required" });
          }

          const TEXT_EXTENSIONS = new Set([
            "js",
            "ts",
            "py",
            "json",
            "yaml",
            "yml",
            "md",
            "txt",
            "csv",
            "xml",
            "sh",
            "sql",
            "toml",
            "ini",
            "env",
            "log",
          ]);

          const tempImagePaths: string[] = [];
          const attachmentBlocks: string[] = [];

          for (const att of attachments) {
            const ext = att.name.includes(".") ? att.name.split(".").pop()!.toLowerCase() : "";
            if (att.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
              const content = Buffer.from(att.data, "base64").toString("utf-8");
              attachmentBlocks.push(
                `[Attached file: ${att.name}]\n\`\`\`${ext}\n${content}\n\`\`\``,
              );
            } else if (att.type.startsWith("image/")) {
              const uploadDir = `${tmpdir()}/claudeclaw-uploads`;
              await import("fs/promises")
                .then(({ mkdir }) => mkdir(uploadDir, { recursive: true }))
                .catch(() => {});
              const filePath = `${uploadDir}/${randomUUID()}.${ext || "bin"}`;
              const buffer = Buffer.from(att.data, "base64");
              await Bun.write(filePath, buffer);
              tempImagePaths.push(filePath);
              attachmentBlocks.push(
                `[Attached image: ${att.name} — file saved at ${filePath}, you can read it with your Read tool]`,
              );
            } else {
              attachmentBlocks.push(
                `[Attached file: ${att.name} — unsupported type, content not included]`,
              );
            }
          }

          const enrichedMessage =
            attachmentBlocks.length > 0
              ? attachmentBlocks.join("\n\n") + (message ? "\n\n" + message : "")
              : message;

          const encoder = new TextEncoder();
          const onChat = opts.onChat;
          const stream = new ReadableStream({
            async start(controller) {
              const send = (data: object) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              try {
                await onChat(
                  enrichedMessage,
                  (chunk) => send({ type: "chunk", text: chunk }),
                  () => send({ type: "unblock" }),
                  (ev) =>
                    send({
                      type: ev.type === "spawn" ? "agent_spawn" : "agent_done",
                      id: ev.id,
                      description: ev.description,
                      result: ev.result,
                    }),
                );
                send({ type: "done" });
              } catch (err) {
                console.error("Chat stream error:", err);
                send({ type: "error", message: "An internal error occurred" });
              } finally {
                controller.close();
                // Fire-and-forget cleanup of temp image files
                for (const p of tempImagePaths) {
                  Bun.file(p)
                    .exists()
                    .then((exists) => {
                      if (exists) {
                        import("fs").then(({ unlink }) => unlink(p, () => {})).catch(() => {});
                      }
                    })
                    .catch(() => {});
                }
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          console.error("Chat request failed:", err);
          return json({ ok: false, error: "Chat request failed" });
        }
      }

      if (url.pathname === "/api/kanban" && req.method === "GET") {
        return json(await readKanban());
      }

      if (url.pathname === "/api/kanban" && req.method === "POST") {
        const csrfError = requireCsrf(req);
        if (csrfError) return csrfError;
        try {
          const body = (await req.json()) as KanbanBoard;
          await writeKanban(body);
          return json({ ok: true });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(),
    host: opts.host,
    port: server.port,
  };
}
