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

/** Every route a caller passes to `runOneShot`; the only keys `oneShot.routes` accepts. */
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

export function resolveOneShotEngine(
  settings: OneShotSettings,
  route: string,
  ptyEnabled = false,
): string {
  return (
    settings.routes[route] ??
    settings.routes[`${route.split(".")[0]}.*`] ??
    settings.default ??
    (ptyEnabled && RESUME_ROUTES.includes(route) ? "pty" : "print")
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
      `oneShot untrusted route '${route}' cannot use '${id}': engine does not advertise isolation (spike is not green)`,
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
      isUntrustedRoute(route),
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
  for (const route of UNTRUSTED_ROUTES)
    validateRouteEngine(
      resolveOneShotEngine(settings, route),
      route,
      true,
      false,
      engineDeclarations,
    );
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
