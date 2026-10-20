/**
 * Env scrubbing for spawned `claude` processes. A leaf module (no imports) so
 * callers outside the runner, such as the skills-tuner CLI backend, can use it
 * without loading `runner.ts` and its dependencies. `runner.ts` re-exports
 * `cleanSpawnEnv` and `shouldStripSpawnEnvKey`.
 */

/**
 * Canonical strip list shared by `cleanSpawnEnv` and `withCleanProcessEnv`.
 * Keep these in sync — both helpers MUST agree, or one will reintroduce a
 * leak the other prevents.
 *
 * Exception: `CLAUDE_CODE_OAUTH_TOKEN` values that start with `sk-ant-oat01-`
 * are 1-year long-lived tokens minted via `claude setup-token`. These do NOT
 * carry the frozen-session refresh-failure risk that motivated stripping
 * short-lived OAuth tokens, so they are preserved into spawned PTY claudes
 * (intentional: operators wire the token via the daemon env file and expect
 * it to flow through to the subscription-pool claudes). The exception is
 * implemented by `shouldStripSpawnEnvKey` below.
 */
export const SPAWN_ENV_STRIP_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_API_KEY", // see comment above — prevents accidental API-key billing
] as const;

/**
 * Decide whether a strip-list key should actually be stripped for the given
 * value. Long-lived `sk-ant-oat01-*` OAuth tokens are kept; everything else
 * on the strip list is removed unconditionally.
 */
export function shouldStripSpawnEnvKey(key: string, value: string | undefined): boolean {
  if (
    key === "CLAUDE_CODE_OAUTH_TOKEN" &&
    typeof value === "string" &&
    value.startsWith("sk-ant-oat01-")
  ) {
    return false;
  }
  return true;
}

export function cleanSpawnEnv(): Record<string, string> {
  const stripped = new Set<string>(SPAWN_ENV_STRIP_KEYS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key) && shouldStripSpawnEnvKey(key, value)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
