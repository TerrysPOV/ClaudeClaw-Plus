/**
 * technique-plugin-registry — the curated map from a RESEARCH technique to an
 * installable PLUGIN. This is the keystone of the hard boundary: the self-tuner
 * never writes engine code, so an architectural capability surfaced by the
 * evidence layer (e.g. "vectorized-retrieval") is delivered ONLY as a gated
 * plugin install, never as a "go implement this in code" recommendation.
 *
 * Resolution: a technique resolves to a `PluginEntry` if (a) a built-in seed
 * maps it, or (b) the operator curated it in `~/.config/tuner/technique-plugins.json`.
 * Operator entries win on id collision. A technique with NO entry resolves to
 * `null` → the proactive cycle emits a detect-only NOTE (nothing to write),
 * never a code change.
 *
 * Security: every entry carries `verified`. Seeds ship `verified: false` — the
 * registry only *proposes* an install; a human verifies the package/source at
 * the gate before apply. Install itself is confined + reversible (see
 * mcp-plugin-subject).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How the plugin is fetched + installed. Both confined to the managed dir. */
export type PluginManager = "npm" | "git";

/** A curated technique → installable plugin mapping. */
export interface PluginEntry {
  /** The research technique this plugin implements (matches ResearchSpec.technique). */
  technique: string;
  /**
   * Optional capability tag (e.g. "web_search"). Lets a plugin be resolved by a
   * detected behavioural NEED (capability-gap detection), not only by a research
   * technique — a detected gap resolves to the entries carrying this capability.
   */
  capability?: string;
  /** Stable id; also the `mcpServers` key written into settings. */
  pluginId: string;
  /** npm = `npm install <source>` into the managed dir; git = `git clone <source>`. */
  manager: PluginManager;
  /** npm package spec (e.g. "pkg@1.2.3") or a clone URL (https git only). */
  source: string;
  /** The MCP server entry written into settings.mcpServers[pluginId]. */
  server: { command: string; args: string[] };
  /** Human-readable capability description (shown in the proposal). */
  description: string;
  /** false on seeds: the operator MUST verify the package/source at the gate. */
  verified: boolean;
  /** Provenance / verification note shown alongside the proposal. */
  note?: string;
}

/**
 * Built-in seeds. Deliberately conservative + `verified: false`: they exist to
 * demonstrate the path and to give the operator a starting point, not to be
 * auto-trusted. Curate real, pinned entries in the operator file.
 */
export const BUILTIN_REGISTRY: readonly PluginEntry[] = [
  {
    technique: "vectorized-retrieval",
    pluginId: "mcp-server-qdrant",
    manager: "git",
    source: "https://github.com/qdrant/mcp-server-qdrant",
    server: { command: "uvx", args: ["--from", ".", "mcp-server-qdrant"] },
    description: "Vector retrieval over a Qdrant store — vectorised memory recall.",
    verified: false,
    note: "Seed (UNVERIFIED): confirm the repo + pin a commit before approving.",
  },
  {
    technique: "web-search",
    capability: "web_search",
    pluginId: "brave-search",
    manager: "npm",
    source: "@modelcontextprotocol/server-brave-search",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"] },
    description:
      "Web search via the Brave Search API — answer research questions with fresh results.",
    verified: false,
    note: "Seed (UNVERIFIED): pin the package version + set BRAVE_API_KEY before approving.",
  },
  {
    technique: "web-search",
    capability: "web_search",
    pluginId: "perplexity-ask",
    manager: "npm",
    source: "@modelcontextprotocol/server-perplexity-ask",
    server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-perplexity-ask"] },
    description: "Web research via the Perplexity API — synthesised answers with citations.",
    verified: false,
    note: "Seed (UNVERIFIED): pin the package version + set PERPLEXITY_API_KEY before approving.",
  },
];

/** Default operator-curated registry file (JSON array of PluginEntry). */
export function defaultRegistryPath(): string {
  return join(homedir(), ".config", "tuner", "technique-plugins.json");
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

/** Load + validate operator entries. Malformed file → [] (never throws). */
export function loadOperatorEntries(path = defaultRegistryPath()): PluginEntry[] {
  const resolved = expandHome(path);
  if (!existsSync(resolved)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidEntry);
}

function isValidEntry(e: unknown): e is PluginEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  const server = o.server as Record<string, unknown> | undefined;
  return (
    typeof o.technique === "string" &&
    (o.capability === undefined || typeof o.capability === "string") &&
    typeof o.pluginId === "string" &&
    (o.manager === "npm" || o.manager === "git") &&
    typeof o.source === "string" &&
    typeof o.description === "string" &&
    typeof o.verified === "boolean" &&
    typeof server === "object" &&
    server !== null &&
    typeof server.command === "string" &&
    Array.isArray(server.args) &&
    server.args.every((a) => typeof a === "string")
  );
}

/**
 * Resolve a technique to its installable plugin, or null. Operator entries
 * override built-in seeds with the same pluginId. The first matching entry for
 * the technique wins (operator file scanned first).
 */
export function lookupPlugin(
  technique: string,
  opts: { registryPath?: string; includeBuiltins?: boolean } = {},
): PluginEntry | null {
  const operator = loadOperatorEntries(opts.registryPath);
  const builtins = opts.includeBuiltins === false ? [] : BUILTIN_REGISTRY;
  const overridden = new Set(operator.map((e) => e.pluginId));
  const merged = [...operator, ...builtins.filter((e) => !overridden.has(e.pluginId))];
  return merged.find((e) => e.technique === technique) ?? null;
}

/**
 * Resolve a detected capability NEED (e.g. "web_search") to its APPROVED
 * installable options. Unlike `lookupPlugin` (one technique → one plugin), a
 * need can have several options (Brave OR Perplexity), so this returns all
 * matches. By default only `verified` (operator-approved) entries are returned —
 * the approved-list gate — since a capability-gap proposal is an install
 * recommendation, not a demo. Pass `includeUnverified: true` to also surface the
 * conservative seeds (shown as UNVERIFIED, still human-gated at apply).
 * Operator entries override built-in seeds on pluginId collision.
 */
export function lookupCapability(
  capability: string,
  opts: { registryPath?: string; includeBuiltins?: boolean; includeUnverified?: boolean } = {},
): PluginEntry[] {
  const operator = loadOperatorEntries(opts.registryPath);
  const builtins = opts.includeBuiltins === false ? [] : BUILTIN_REGISTRY;
  const overridden = new Set(operator.map((e) => e.pluginId));
  const merged = [...operator, ...builtins.filter((e) => !overridden.has(e.pluginId))];
  return merged.filter(
    (e) => e.capability === capability && (opts.includeUnverified === true || e.verified),
  );
}
