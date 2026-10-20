import { isUntrustedRoute } from "./config.js";

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

/** Explicit interactive exceptions; each needs a compensating control. */
export const PRINT_ONLY_UNTRUSTED_ARGS = [
  // Interactive sessions persist: runOnceOnPty's finally removes the whole throwaway config root
  // (transcripts included), or keeps it while a claude that outlived its retirement may write.
  "--no-session-persistence",
] as const;

export function untrustedInteractiveArgs(): string[] {
  return UNTRUSTED_CLAUDE_ARGS.filter(
    (arg) => !(PRINT_ONLY_UNTRUSTED_ARGS as readonly string[]).includes(arg),
  );
}

/** Also applied by engine entry points, so direct calls cannot bypass it. */
export function validateIsolation(req: import("./engine.js").OneShotRequest): void {
  if (req.isolation !== "untrusted" && req.isolation !== "trusted-session")
    throw new Error("oneShot isolation is required");
  if (isUntrustedRoute(req.route) && req.isolation !== "untrusted") {
    throw new Error(
      `oneShot route '${req.route}' carries untrusted text and requires isolation "untrusted"`,
    );
  }
  if (
    req.isolation === "untrusted" &&
    (req.resumeSessionId !== undefined ||
      req.allowedTools !== undefined ||
      req.tools !== undefined ||
      req.cwd !== undefined)
  ) {
    throw new Error(
      "oneShot untrusted calls cannot specify resumeSessionId or allowedTools or tools or cwd",
    );
  }
  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0)
    throw new Error("oneShot timeoutMs must be positive");
}

/** `Edit(//p)` -> `Edit`: the unique bare tool names of a list of permission rules. */
function bareToolNames(rules: string[]): string[] {
  const names = rules.map((r) => r.replace(/\(.*$/s, "").trim()).filter((n) => n !== "");
  return [...new Set(names)];
}

/**
 * The `--tools` / `--allowedTools` flags for a trusted-session request, shared by every
 * engine that starts a claude CLI so they cannot drift apart. `--tools` takes BARE tool
 * names (`req.tools`, else the names of the `allowedTools` rules); permission rules,
 * path-scoped or not, go in `--allowedTools`. `allowedTools: []` is "no tools":
 * `--tools ""` and no `--allowedTools`. `undefined` when the caller gave no grant at all,
 * which means "use the default permission profile".
 *
 * A grant also sets `--permission-mode dontAsk`: a tool outside the list is denied, where
 * the default mode would leave the TUI waiting at a permission prompt nobody answers.
 */
export function trustedToolFlags(req: {
  allowedTools?: string[];
  tools?: string[];
}): string[] | undefined {
  if (req.allowedTools === undefined && req.tools === undefined) return undefined;
  const flags = [
    "--permission-mode",
    "dontAsk",
    "--tools",
    (req.tools ?? bareToolNames(req.allowedTools ?? [])).join(","),
  ];
  if (req.allowedTools && req.allowedTools.length > 0) {
    flags.push("--allowedTools", req.allowedTools.join(","));
  }
  return flags;
}
