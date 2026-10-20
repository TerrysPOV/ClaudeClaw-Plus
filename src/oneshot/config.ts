import { MIN_PTY_ISOLATION_CLAUDE_VERSION } from "./claude-version.js";
import { engines } from "./registry.js";

export interface OneShotSettings {
  /** Absent means the route's implicit default follows the runner PTY setting. */
  default?: string;
  engines: Record<string, Record<string, unknown>>;
  routes: Record<string, string>;
}

export const RESUME_ROUTES = [
  "compact",
  "memory.save.precompact",
  "rotation.summary",
  "memory.save.stop",
];
export const UNTRUSTED_ROUTES = [
  "discord.classifier",
  "tuner.propose",
  "tuner.judge",
  "memory.recall",
];

/**
 * Every route a caller passes to `runOneShot`; the only keys `oneShot.routes` accepts.
 * `memory.recall` is reserved: it is accepted here but has no `runOneShot` caller yet.
 */
export const KNOWN_ROUTES: readonly string[] = [...RESUME_ROUTES, ...UNTRUSTED_ROUTES];
/** `resolveOneShotEngine` falls back on `<first segment>.*`, so only those wildcards bind. */
const ROUTE_FAMILIES = new Set(KNOWN_ROUTES.map((route) => route.split(".")[0]));

function isKnownRouteKey(key: string): boolean {
  if (KNOWN_ROUTES.includes(key)) return true;
  return key.endsWith(".*") && ROUTE_FAMILIES.has(key.slice(0, -2));
}

/** Routes whose prompt carries text from outside the operator's trust boundary. */
export function isUntrustedRoute(route: string): boolean {
  return route.startsWith("tuner.") || UNTRUSTED_ROUTES.includes(route);
}

/**
 * The engine a route gets when nothing names one: pty when the runner PTY is on, and, for an
 * untrusted route, only while pty advertises isolation (the claude version gate, #570).
 */
function implicitEngine(route: string, ptyEnabled: boolean): string {
  if (!ptyEnabled) return "print";
  if (RESUME_ROUTES.includes(route)) return "pty";
  if (isUntrustedRoute(route)) return engines.get("pty")?.caps.isolation ? "pty" : "print";
  return "print";
}

export function resolveOneShotEngine(
  settings: OneShotSettings,
  route: string,
  ptyEnabled = false,
): string {
  return (
    settings.routes[route] ??
    settings.routes[`${route.split(".")[0]}.*`] ??
    settings.default ??
    implicitEngine(route, ptyEnabled)
  );
}

/**
 * The built-in engine `id` runs on: itself, or the `type` of its
 * `oneShot.engines` declaration (`engines.local = { type: "ollama", ... }`).
 */
export function engineType(id: string, declarations: OneShotSettings["engines"]): string {
  if (!Object.hasOwn(declarations, id)) return id;
  const type = declarations[id]!.type ?? id;
  if (typeof type !== "string" || !engines.has(type))
    throw new Error(`oneShot.engines.${id}.type must be one of: ${[...engines.keys()].join(", ")}`);
  if (engines.has(id) && type !== id)
    throw new Error(`oneShot.engines.${id} cannot change the type of a built-in engine`);
  return type;
}

/**
 * Whether load-time validation checks `route`'s isolation against engine `id`. The `pty`
 * engine's capability is set by the claude version gate AFTER settings load (`start.ts`), so
 * it is checked at the call (`runOneShot`, `runOnceOnPty`) only; every other engine's
 * capability is fixed and is checked at load.
 */
function isolationCheckedAtLoad(
  id: string,
  route: string,
  declarations: OneShotSettings["engines"],
): boolean {
  return isUntrustedRoute(route) && engineType(id, declarations) !== "pty";
}

/** `untrusted` is checked against the engine's isolation capability, here and at the call. */
export function validateRouteEngine(
  id: string,
  route: string,
  untrusted: boolean,
  resume: boolean,
  declarations: OneShotSettings["engines"] = {},
): void {
  const engine = engines.get(engineType(id, declarations));
  if (!engine) throw new Error(`Unknown oneShot engine '${id}' for route '${route}'`);
  if (resume && !engine.caps.resume)
    throw new Error(`oneShot route '${route}' requires resume; engine '${id}' cannot resume`);
  if (untrusted && !engine.caps.isolation) {
    throw new Error(
      `oneShot untrusted route '${route}' cannot use '${id}': engine does not advertise isolation` +
        (engineType(id, declarations) === "pty"
          ? ` (the interactive engine is isolated only on claude ${MIN_PTY_ISOLATION_CLAUDE_VERSION} or newer, and not on Windows, checked once at startup)`
          : ""),
    );
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`oneShot.${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Parse and validate at load time; never silently fall back from bad routing. */
export function parseOneShotSettings(raw: unknown): OneShotSettings {
  const input = raw === undefined ? {} : object(raw, "settings");
  const defaultId = input.default ?? "print";
  if (typeof defaultId !== "string") throw new Error("oneShot.default must be an engine id");
  const declarations = object(input.engines ?? {}, "engines");
  const routes = object(input.routes ?? {}, "routes");
  const engineDeclarations = declarations as OneShotSettings["engines"];
  for (const [id, config] of Object.entries(declarations)) {
    object(config, `engines.${id}`);
    validateRouteEngine(id, "engine declaration", false, false, engineDeclarations);
  }
  for (const [route, id] of Object.entries(routes)) {
    if (!isKnownRouteKey(route))
      throw new Error(
        `oneShot.routes.${route} is not a known route (known: ${KNOWN_ROUTES.join(", ")}, or <family>.*)`,
      );
    if (typeof id !== "string") throw new Error(`oneShot.routes.${route} must be an engine id`);
    validateRouteEngine(
      id,
      route,
      isolationCheckedAtLoad(id, route, engineDeclarations),
      RESUME_ROUTES.includes(route),
      engineDeclarations,
    );
  }
  const settings: OneShotSettings = {
    ...(input.default == null ? {} : { default: defaultId }),
    engines: engineDeclarations,
    routes: routes as Record<string, string>,
  };
  validateRouteEngine(defaultId, "default", false, false, engineDeclarations);
  for (const route of RESUME_ROUTES)
    validateRouteEngine(
      resolveOneShotEngine(settings, route),
      route,
      false,
      true,
      engineDeclarations,
    );
  for (const route of UNTRUSTED_ROUTES) {
    const id = resolveOneShotEngine(settings, route);
    validateRouteEngine(
      id,
      route,
      isolationCheckedAtLoad(id, route, engineDeclarations),
      false,
      engineDeclarations,
    );
  }
  // Engine settings (base URL, model, ...) are checked for every engine declared
  // or used, so a route to an unconfigured HTTP engine fails here, not on a call.
  for (const id of new Set([
    ...Object.keys(engineDeclarations),
    defaultId,
    ...Object.values(settings.routes),
  ])) {
    const config = Object.hasOwn(engineDeclarations, id) ? engineDeclarations[id]! : {};
    engines.get(engineType(id, engineDeclarations))!.checkConfig?.(config, id);
  }
  return settings;
}
