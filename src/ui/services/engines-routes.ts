/**
 * Dashboard routes for the Engines settings (#552). Reached after the web
 * token check in `server.ts`; every POST also needs the CSRF token.
 *
 *   GET/POST /api/settings/oneshot   the `oneShot` block (routes, default, HTTP engines)
 *   GET/POST /api/settings/engines   the agent-turn engine (`pty.enabled`, supervision)
 *   POST     /api/oneshot/test       canary probe of one engine
 *
 * A POST the loader would refuse answers 400 with the loader's reason and
 * leaves settings.json untouched. No response carries a key: engines are
 * reported with the NAME of their key variable and `keyPresent`.
 */
import type { Settings } from "../../config";
import { ProbeRefusedError, probeEngine } from "../../oneshot/probe";
import {
  type AgentEngineView,
  type OneShotPatch,
  readAgentEngineView,
  readOneShotSettings,
  readOneShotView,
  updateOneShotSettings,
  updatePtyEnabled,
} from "../../oneshot/settings-store";
import { json } from "../http";

let probeRunning = false;

/** A settings.json read/write failure, as opposed to a refused value. */
function isIoError(err: unknown): boolean {
  return !!err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string";
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new Error("request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** What the daemon started with: bus agents keep their supervision until a restart. */
export function startupEngines(settings: Partial<Settings> | undefined): AgentEngineView {
  return {
    pty: { enabled: settings?.pty?.enabled === true },
    agents: (settings?.agents ?? []).map((a) => ({
      id: a.id,
      supervision: a.supervision ?? "pty-stdin",
    })),
  };
}

function restartRequired(saved: AgentEngineView, running: AgentEngineView): boolean {
  return JSON.stringify(saved) !== JSON.stringify(running);
}

export async function handleEnginesRoute(
  req: Request,
  url: URL,
  ctx: { requireCsrf: (req: Request) => Response | null; startup: () => AgentEngineView },
): Promise<Response | null> {
  const path = url.pathname;
  if (
    path !== "/api/settings/oneshot" &&
    path !== "/api/settings/engines" &&
    path !== "/api/oneshot/test"
  )
    return null;

  if (req.method === "POST") {
    const csrfError = ctx.requireCsrf(req);
    if (csrfError) return csrfError;
  } else if (req.method !== "GET" || path === "/api/oneshot/test") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  try {
    if (path === "/api/settings/oneshot") {
      if (req.method === "GET") return json({ ok: true, oneShot: await readOneShotView() });
      const patch = await body(req);
      const { default: def, routes, engines } = patch;
      if (def === undefined && routes === undefined && engines === undefined)
        return json(
          { ok: false, error: "no oneShot fields provided (default, routes, engines)" },
          400,
        );
      const next = await updateOneShotSettings({ default: def, routes, engines } as OneShotPatch);
      return json({ ok: true, oneShot: next, applies: "next call (no restart)" });
    }

    if (path === "/api/settings/engines") {
      if (req.method === "POST") {
        const pty = (await body(req)).pty as { enabled?: unknown } | undefined;
        if (!pty || typeof pty.enabled !== "boolean")
          return json({ ok: false, error: "pty.enabled must be true or false" }, 400);
        await updatePtyEnabled(pty.enabled);
      }
      const saved = await readAgentEngineView();
      const running = ctx.startup();
      return json({
        ok: true,
        saved,
        running,
        restartRequired: restartRequired(saved, running),
      });
    }

    // POST /api/oneshot/test — reads the file, so an engine just saved can be tested before the reload.
    const { engine } = await body(req);
    if (typeof engine !== "string" || !engine)
      return json({ ok: false, error: "engine must be an engine id" }, 400);
    const settings = await readOneShotSettings();
    // One probe at a time: each one spawns a CLI or calls a remote engine.
    if (probeRunning) return json({ ok: false, error: "a test is already running" }, 409);
    probeRunning = true;
    let result: Awaited<ReturnType<typeof probeEngine>>;
    try {
      result = await probeEngine(engine, settings);
    } catch (err) {
      return json({ ok: false, error: message(err) }, err instanceof ProbeRefusedError ? 400 : 502);
    } finally {
      probeRunning = false;
    }
    return json({ ok: true, ...result });
  } catch (err) {
    if (isIoError(err)) {
      console.error("Engines settings I/O failed:", err);
      return json({ ok: false, error: "Failed to read or write settings.json" }, 500);
    }
    return json({ ok: false, error: message(err) }, 400);
  }
}
