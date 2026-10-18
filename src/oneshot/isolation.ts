/** Single Claude CLI isolation policy for calls containing untrusted text. */
export const UNTRUSTED_CLAUDE_ARGS = [
  "--tools", "", "--strict-mcp-config", "--setting-sources", "",
  "--no-session-persistence", "--disable-slash-commands",
] as const;
