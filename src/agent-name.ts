/**
 * The agent-name shape `agents/<name>/` accepts: kebab-case, starting with a
 * letter. Narrower than a bus agent id (`AGENT_ID_PATTERN` in config.ts allows
 * `_` and a leading digit). A leaf module so the bus MCP server, which runs in
 * the agent's own process, can check it without loading the agent registry.
 */
export const AGENT_NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function isAgentName(name: string): boolean {
  return typeof name === "string" && AGENT_NAME_RE.test(name);
}
