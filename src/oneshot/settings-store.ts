/**
 * Read and edit the `oneShot` block and the agent-turn engine (`pty.enabled`)
 * of settings.json, for the dashboard (#552) and `claudeclaw oneshot`. Both
 * go through `applyOneShotPatch`, so a forbidden combination is refused with
 * the same message the loader gives, before anything is written.
 */
import { readFile } from "node:fs/promises";
import { getSettingsFile } from "../config.js";
import { parseSettingsForRewrite, writeSettingsAtomic } from "../settings-json.js";
import {
  KNOWN_ROUTES,
  type OneShotSettings,
  parseOneShotSettings,
  RESUME_ROUTES,
  resolveOneShotEngine,
  UNTRUSTED_ROUTES,
} from "./config.js";
import { DEFAULT_ROUTER_KEY_ENV } from "./http-config.js";
import { engines } from "./registry.js";

/** `null` removes a route or an engine; an absent key leaves it as it is. */
export interface OneShotPatch {
  default?: string;
  routes?: Record<string, string | null>;
  engines?: Record<string, Record<string, unknown> | null>;
}

export interface EngineView {
  name: string;
  type: string;
  baseUrl?: string;
  model?: string;
  tier?: string;
  /** The NAME of the env variable holding the key, never its value. */
  apiKeyEnv?: string;
  keyPresent: boolean;
}

export interface OneShotView {
  default: string;
  /** True when `oneShot.default` is absent: resume routes then follow `pty.enabled` (#572). */
  defaultImplicit: boolean;
  routes: Record<string, string>;
  /** Route → engine a call on it uses now (explicit route, `<family>.*`, else default). */
  effective: Record<string, string>;
  /** Route (and `default`) → every engine id the loader would accept there. */
  choices: Record<string, string[]>;
  engines: EngineView[];
  knownRoutes: readonly string[];
  resumeRoutes: readonly string[];
  untrustedRoutes: readonly string[];
}

const ENGINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SUPERVISION_MODES = new Set(["pty-stdin", "tmux", "process", "process-stream-json"]);
const ENV_NAME_STRICT = /^[A-Z_][A-Z0-9_]{0,63}$/;
const VIEW_KEYS = ["baseUrl", "model", "tier", "apiKeyEnv"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readSettingsDoc(): Promise<Record<string, unknown>> {
  return parseSettingsForRewrite(await readFile(getSettingsFile(), "utf-8"));
}

// One writer at a time: two saves racing would each read the file before the
// other's rename and the second would drop the first one's change.
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/** Credentials a URL can carry (user, password, query values) → `***`. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password && !parsed.search) return url;
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    for (const key of [...new Set(parsed.searchParams.keys())]) parsed.searchParams.set(key, "***");
    const masked = parsed.toString();
    return !url.endsWith("/") && masked.endsWith("/") && !parsed.search
      ? masked.slice(0, -1)
      : masked;
  } catch {
    return url;
  }
}

/**
 * The `oneShot` block with `patch` applied, validated as the loader would.
 * Throws the loader's message; returns the raw block to store (keys the
 * patch does not touch are kept as written).
 */
export function applyOneShotPatch(
  current: unknown,
  patch: OneShotPatch,
): { raw: Record<string, unknown>; parsed: OneShotSettings } {
  const raw: Record<string, unknown> = isObject(current) ? structuredClone(current) : {};
  if (patch.default !== undefined) {
    if (typeof patch.default !== "string" || !patch.default)
      throw new Error("oneShot.default must be an engine id");
    raw.default = patch.default;
  }
  if (patch.routes !== undefined) {
    if (!isObject(patch.routes)) throw new Error("oneShot.routes must be an object");
    const routes: Record<string, unknown> = isObject(raw.routes) ? raw.routes : {};
    for (const [route, id] of Object.entries(patch.routes)) {
      if (id === null) delete routes[route];
      else routes[route] = id;
    }
    raw.routes = routes;
  }
  if (patch.engines !== undefined) {
    if (!isObject(patch.engines)) throw new Error("oneShot.engines must be an object");
    const declared: Record<string, unknown> = isObject(raw.engines) ? raw.engines : {};
    for (const [name, config] of Object.entries(patch.engines)) {
      if (!ENGINE_NAME.test(name))
        throw new Error(
          `oneShot engine name '${name}' must be 1-64 letters, digits, '.', '_' or '-'`,
        );
      if (config === null) {
        delete declared[name];
        continue;
      }
      if (!isObject(config)) throw new Error(`oneShot.engines.${name} must be an object`);
      const previous = declared[name];
      const next = { ...config };
      // The dashboard gets a masked base URL back; saving it unchanged keeps the stored one.
      if (
        isObject(previous) &&
        typeof previous.baseUrl === "string" &&
        next.baseUrl === maskUrl(previous.baseUrl)
      )
        next.baseUrl = previous.baseUrl;
      // The loader accepts any identifier; a NEW value written here is checked
      // harder so a key pasted into the field is refused, and not echoed. The
      // stored value saved back unchanged stays editable.
      const keptKeyEnv = isObject(previous) && next.apiKeyEnv === previous.apiKeyEnv;
      if (
        next.apiKeyEnv !== undefined &&
        !keptKeyEnv &&
        !ENV_NAME_STRICT.test(String(next.apiKeyEnv))
      )
        throw new Error(
          `oneShot.engines.${name}.apiKeyEnv must be the NAME of an environment variable (upper case, e.g. OPENAI_API_KEY), not the key`,
        );
      declared[name] = next;
    }
    raw.engines = declared;
  }
  return { raw, parsed: parseOneShotSettings(raw) };
}

function engineView(name: string, config: Record<string, unknown>): EngineView {
  const type = typeof config.type === "string" ? config.type : name;
  const view: EngineView = { name, type, keyPresent: false };
  // Only known, non-secret fields leave the server; anything else in the
  // declaration (the loader refuses an `apiKey`) is never echoed.
  for (const key of VIEW_KEYS) {
    const value = config[key];
    if (typeof value === "string") view[key] = key === "baseUrl" ? maskUrl(value) : value;
  }
  const keyEnv = view.apiKeyEnv ?? (type === "llm-router" ? DEFAULT_ROUTER_KEY_ENV : undefined);
  view.keyPresent = !!keyEnv && !!process.env[keyEnv];
  return view;
}

function accepted(raw: Record<string, unknown>, patch: OneShotPatch): boolean {
  try {
    applyOneShotPatch(raw, patch);
    return true;
  } catch {
    return false;
  }
}

/** What the dashboard and `oneshot list` show; built from a block the loader accepts. */
export function oneShotView(rawBlock: unknown, ptyEnabled = false): OneShotView {
  const raw = isObject(rawBlock) ? rawBlock : {};
  const settings = parseOneShotSettings(raw);
  const ids = [...new Set([...engines.keys(), ...Object.keys(settings.engines)])];
  const choices: Record<string, string[]> = {
    default: ids.filter((id) => accepted(raw, { default: id })),
  };
  for (const route of KNOWN_ROUTES)
    choices[route] = ids.filter((id) => accepted(raw, { routes: { [route]: id } }));
  const effective: Record<string, string> = {};
  for (const route of KNOWN_ROUTES)
    effective[route] = resolveOneShotEngine(settings, route, ptyEnabled);
  return {
    default: settings.default ?? "print",
    defaultImplicit: settings.default === undefined,
    routes: { ...settings.routes },
    effective,
    choices,
    engines: Object.entries(settings.engines).map(([name, config]) => engineView(name, config)),
    knownRoutes: KNOWN_ROUTES,
    resumeRoutes: RESUME_ROUTES,
    untrustedRoutes: UNTRUSTED_ROUTES,
  };
}

/** The block as the loader would parse it from the file now (it may be newer than the daemon's copy). */
export async function readOneShotSettings(): Promise<OneShotSettings> {
  return parseOneShotSettings((await readSettingsDoc()).oneShot);
}

export async function readOneShotView(): Promise<OneShotView> {
  const doc = await readSettingsDoc();
  return oneShotView(doc.oneShot, agentEngineView(doc).pty.enabled);
}

/** Validate, then write settings.json atomically; nothing is written when validation fails. */
export function updateOneShotSettings(patch: OneShotPatch): Promise<OneShotView> {
  return serialized(async () => {
    const doc = await readSettingsDoc();
    const { raw } = applyOneShotPatch(doc.oneShot, patch);
    doc.oneShot = raw;
    await writeSettingsAtomic(getSettingsFile(), doc);
    return oneShotView(raw, agentEngineView(doc).pty.enabled);
  });
}

export interface AgentEngineView {
  pty: { enabled: boolean };
  /** Effective supervision of each declared bus agent (`agents[].supervision ?? "pty-stdin"`). */
  agents: Array<{ id: string; supervision: string }>;
}

/** The agent-turn engine as settings.json holds it (the loader's defaults applied). */
export function agentEngineView(doc: Record<string, unknown>): AgentEngineView {
  const pty = isObject(doc.pty) ? doc.pty : {};
  const list = Array.isArray(doc.agents) ? doc.agents : [{ id: "default" }];
  return {
    pty: { enabled: pty.enabled === true },
    agents: list
      .filter((a): a is Record<string, unknown> => isObject(a) && typeof a.id === "string")
      .map((a) => ({
        id: a.id as string,
        // Same reading as the loader: an unknown value is dropped, the resolver defaults it.
        supervision:
          typeof a.supervision === "string" && SUPERVISION_MODES.has(a.supervision.trim())
            ? a.supervision.trim()
            : "pty-stdin",
      })),
  };
}

export async function readAgentEngineView(): Promise<AgentEngineView> {
  return agentEngineView(await readSettingsDoc());
}

export function updatePtyEnabled(enabled: boolean): Promise<AgentEngineView> {
  return serialized(async () => {
    if (typeof enabled !== "boolean") throw new Error("pty.enabled must be true or false");
    const doc = await readSettingsDoc();
    doc.pty = { ...(isObject(doc.pty) ? doc.pty : {}), enabled };
    await writeSettingsAtomic(getSettingsFile(), doc);
    return agentEngineView(doc);
  });
}
