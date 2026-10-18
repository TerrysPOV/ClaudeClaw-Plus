/** Single Claude CLI isolation policy for calls containing untrusted text. */
export const UNTRUSTED_CLAUDE_ARGS = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--disable-slash-commands",
] as const;

/** Also applied by engine entry points, so direct calls cannot bypass it. */
export function validateIsolation(req: import("./engine.js").OneShotRequest): void {
  if (req.isolation !== "untrusted" && req.isolation !== "trusted-session")
    throw new Error("oneShot isolation is required");
  if (
    req.isolation === "untrusted" &&
    (req.resumeSessionId !== undefined || req.allowedTools !== undefined || req.cwd !== undefined)
  ) {
    throw new Error(
      "oneShot untrusted calls cannot specify resumeSessionId or allowedTools or cwd",
    );
  }
  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0)
    throw new Error("oneShot timeoutMs must be positive");
}
