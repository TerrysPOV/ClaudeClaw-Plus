/**
 * Provider aliases that select a base URL through `buildChildEnv` and are not
 * model names the `claude` CLI accepts. The one rule for every one-shot engine
 * and for PTY argv: never forward them as `--model`.
 */
const PROVIDER_ALIASES: ReadonlySet<string> = new Set(["glm", "kimi-k2p6"]);

/** The value for `--model`, or undefined when the flag must be omitted. */
export function cliModelFlag(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || PROVIDER_ALIASES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}
