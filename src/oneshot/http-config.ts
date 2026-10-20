/**
 * Settings of the HTTP engines (#551), checked at settings load. No runtime
 * imports: configuration validation loads this module.
 */

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_ROUTER_KEY_ENV = "OPENROUTER_API_KEY";
const TIERS = ["fast", "balanced", "reasoning"] as const;
export type RouterTier = (typeof TIERS)[number];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChatEngineConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}

export interface RouterEngineConfig {
  tier: RouterTier;
  apiKeyEnv: string;
}

function onlyKeys(config: Record<string, unknown>, name: string, allowed: string[]): void {
  for (const key of Object.keys(config)) {
    if (allowed.includes(key)) continue;
    const hint =
      key === "apiKey"
        ? "; the key is never stored in settings, name its env variable in apiKeyEnv"
        : ` (allowed: ${allowed.join(", ")})`;
    throw new Error(`oneShot.engines.${name}.${key} is not a setting of this engine${hint}`);
  }
}

function optionalString(
  config: Record<string, unknown>,
  name: string,
  key: string,
): string | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`oneShot.engines.${name}.${key} must be a non-empty string`);
  return value.trim();
}

function apiKeyEnv(config: Record<string, unknown>, name: string): string | undefined {
  const value = optionalString(config, name, "apiKeyEnv");
  if (value !== undefined && !ENV_NAME.test(value))
    throw new Error(
      `oneShot.engines.${name}.apiKeyEnv must be the name of an environment variable, not the key`,
    );
  return value;
}

/** `openai-compatible`, and `ollama` with its default base URL. */
export function chatEngineConfig(
  config: Record<string, unknown>,
  name: string,
  defaultBaseUrl?: string,
): ChatEngineConfig {
  onlyKeys(config, name, ["type", "baseUrl", "model", "apiKeyEnv"]);
  const baseUrl = optionalString(config, name, "baseUrl") ?? defaultBaseUrl;
  if (!baseUrl) throw new Error(`oneShot.engines.${name}.baseUrl is required`);
  let protocol = "";
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    /* reported below */
  }
  if (protocol !== "http:" && protocol !== "https:")
    throw new Error(`oneShot.engines.${name}.baseUrl must be an http(s) URL`);
  const model = optionalString(config, name, "model");
  if (!model) throw new Error(`oneShot.engines.${name}.model is required`);
  const keyEnv = apiKeyEnv(config, name);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) };
}

/** `llm-router`: a tier of `settings.llmRouter`; the key defaults to the router's own. */
export function routerEngineConfig(
  config: Record<string, unknown>,
  name: string,
): RouterEngineConfig {
  onlyKeys(config, name, ["type", "tier", "apiKeyEnv"]);
  const tier = optionalString(config, name, "tier") ?? "fast";
  if (!(TIERS as readonly string[]).includes(tier))
    throw new Error(`oneShot.engines.${name}.tier must be one of: ${TIERS.join(", ")}`);
  return {
    tier: tier as RouterTier,
    apiKeyEnv: apiKeyEnv(config, name) ?? DEFAULT_ROUTER_KEY_ENV,
  };
}
