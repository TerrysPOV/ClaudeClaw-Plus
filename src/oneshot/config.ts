import { engines } from "./registry.js";

export interface OneShotSettings {
  default: string;
  engines: Record<string, Record<string, unknown>>;
  routes: Record<string, string>;
}

// No user-facing override: only a reviewed interactive isolation spike can
// enable this. HTTP engines can advertise isolation without this restriction.
export const PTY_ISOLATION_SPIKE_GREEN = false;
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

export function resolveOneShotEngine(settings: OneShotSettings, route: string): string {
  return settings.routes[route] ?? settings.routes[`${route.split(".")[0]}.*`] ?? settings.default;
}

export function validateRouteEngine(
  id: string,
  route: string,
  untrusted: boolean,
  resume: boolean,
): void {
  const engine = engines.get(id);
  if (!engine) throw new Error(`Unknown oneShot engine '${id}' for route '${route}'`);
  if (resume && !engine.caps.resume)
    throw new Error(`oneShot route '${route}' requires resume; engine '${id}' cannot resume`);
  if (untrusted && (!engine.caps.isolation || (id === "pty" && !PTY_ISOLATION_SPIKE_GREEN))) {
    throw new Error(
      `oneShot untrusted route '${route}' cannot use '${id}': isolation spike is not green`,
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
  for (const [id, config] of Object.entries(declarations)) {
    validateRouteEngine(id, "engine declaration", false, false);
    object(config, `engines.${id}`);
  }
  for (const [route, id] of Object.entries(routes)) {
    if (typeof id !== "string") throw new Error(`oneShot.routes.${route} must be an engine id`);
    validateRouteEngine(
      id,
      route,
      route.startsWith("tuner.") || UNTRUSTED_ROUTES.includes(route),
      RESUME_ROUTES.includes(route),
    );
  }
  const settings: OneShotSettings = {
    default: defaultId,
    engines: declarations as OneShotSettings["engines"],
    routes: routes as Record<string, string>,
  };
  validateRouteEngine(defaultId, "default", false, false);
  for (const route of RESUME_ROUTES)
    validateRouteEngine(resolveOneShotEngine(settings, route), route, false, true);
  for (const route of UNTRUSTED_ROUTES)
    validateRouteEngine(resolveOneShotEngine(settings, route), route, true, false);
  return settings;
}
