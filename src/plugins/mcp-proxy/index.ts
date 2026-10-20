import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getMcpBridge } from "../mcp-bridge.js";
import { getHttpGateway } from "../http-gateway.js";
import { McpServerProcess, type McpServerConfig } from "./server-process.js";

const MAX_RESULT_BYTES = Number(process.env.MCP_PROXY_MAX_RESULT_BYTES ?? 1_048_576);

// ── Config schema ─────────────────────────────────────────────────────────────

const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  allowedTools: z.array(z.string()).optional(),
});

const ProxyConfigSchema = z.object({
  servers: z.record(z.string(), ServerConfigSchema),
});

type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// ── McpProxyPlugin ────────────────────────────────────────────────────────────

export interface McpProxyPluginOpts {
  configPath?: string;
  tokenPath?: string;
  // For reasoned mode: inject into active Claude session
  reasonedInvokeFn?: (tool: string, args: unknown) => Promise<unknown>;
  /** TEST SEAM: override the resolver used to discover which servers the
   *  multiplexer is actively claiming. Production leaves this undefined →
   *  the resolver imports `mcp-multiplexer` and asks `getMcpMultiplexerPlugin()`.
   *  Tests can inject any set without spinning up a real multiplexer. */
  claimedByMultiplexer?: () => Set<string>;
}

export class McpProxyPlugin {
  private servers = new Map<string, McpServerProcess>();
  private configPath: string;
  private tokenPath: string;
  private reasonedInvokeFn?: (tool: string, args: unknown) => Promise<unknown>;
  private pluginToken: Buffer | null = null;
  private claimedByMultiplexer: () => Set<string>;

  constructor(opts: McpProxyPluginOpts = {}) {
    this.configPath = opts.configPath ?? join(homedir(), ".config", "claudeclaw", "mcp-proxy.json");
    this.tokenPath = opts.tokenPath ?? join(homedir(), ".config", "claudeclaw", "mcp-proxy.token");
    this.reasonedInvokeFn = opts.reasonedInvokeFn;
    this.claimedByMultiplexer = opts.claimedByMultiplexer ?? _sharedActuallyClaimedByMultiplexer;
  }

  async start(): Promise<void> {
    try {
      const stat = statSync(this.configPath);
      if (stat.mode & 0o077) {
        console.error(
          `[mcp-proxy] WARN: ${this.configPath} has permissive permissions (${(stat.mode & 0o777).toString(8)}); recommended 0600.`,
        );
      }
    } catch {} // missing config handled below with a clearer message

    const config = this._loadConfig();
    if (!config) {
      console.error(
        "[mcp-proxy] No config found — registering with zero tools (graceful degradation)",
      );
      this._registerWithGateway([]);
      return;
    }

    // SPEC §4.1 step 4 / §6.2: when a server is actively claimed by the
    // multiplexer (it's running AND has the server in its claimed set),
    // mcp-proxy must NOT spawn its own copy of that upstream child —
    // otherwise both plugins would each spawn the same MCP server
    // (double-process, defeats the whole point). The multiplexer mirrors
    // the FQN into the bridge so legacy `claude -p` callsites still
    // resolve `<server>__<tool>` against the shared child.
    //
    // Codex PR #71 P1: skip ONLY when the multiplexer is *actually* serving
    // the server. If the multiplexer went dormant for any reason (web
    // disabled, non-loopback host, zero claimed servers, missing config),
    // proxy continues to spawn the server so legacy flows keep working
    // instead of silently losing MCP functionality.
    const sharedClaimedByMultiplexer = this.claimedByMultiplexer();
    const skipped: string[] = [];
    const enabledServers = Object.entries(config.servers).filter(([name, s]) => {
      if (!s.enabled) return false;
      if (sharedClaimedByMultiplexer.has(name)) {
        skipped.push(name);
        return false;
      }
      return true;
    });
    if (skipped.length > 0) {
      console.error(
        `[mcp-proxy] skipping ${skipped.length} server(s) claimed by multiplexer: ${skipped.join(", ")}`,
      );
      getMcpBridge().audit("mcp_proxy_skip_shared", { servers: skipped });
    }
    const allTools: { name: string; description: string; schema: Record<string, unknown> }[] = [];

    await Promise.allSettled(
      enabledServers.map(async ([name, cfg]) => {
        const proc = new McpServerProcess(name, cfg as McpServerConfig, {
          onCrash: (n, reason) => this._onServerCrash(n, reason),
        });

        try {
          await proc.start();
          this.servers.set(name, proc);

          for (const tool of proc.tools) {
            const fqn = `${name}__${tool.name}`;
            try {
              getMcpBridge().registerPluginTool("mcp-proxy", {
                name: fqn,
                description: tool.description,
                upstream: { server: name, tool: tool.name },
                schema: z.object({
                  arguments: z.record(z.string(), z.unknown()).optional().default({}),
                  mode: z.enum(["direct", "reasoned"]).optional().default("direct"),
                }),
                handler: async (input) => {
                  const mode = input.mode ?? "direct";
                  const args = input.arguments ?? {};
                  if (mode === "reasoned") {
                    return this._invokeReasoned(fqn, args);
                  }
                  let result: unknown;
                  try {
                    result = await proc.call(tool.name, args);
                  } catch (err) {
                    // A child's error result is thrown with its text: same cap
                    // as a result, so an oversized one cannot slip past it.
                    const message = err instanceof Error ? err.message : String(err);
                    const errorBytes = Buffer.byteLength(message, "utf8");
                    if (errorBytes > MAX_RESULT_BYTES) {
                      throw new Error(
                        `Tool error exceeds ${MAX_RESULT_BYTES} bytes (got ${errorBytes})`,
                      );
                    }
                    throw err;
                  }
                  const resultStr = JSON.stringify(result);
                  const resultBytes = Buffer.byteLength(resultStr, "utf8");
                  if (resultBytes > MAX_RESULT_BYTES) {
                    throw new Error(
                      `Tool result exceeds ${MAX_RESULT_BYTES} bytes (got ${resultBytes})`,
                    );
                  }
                  return result;
                },
              });
              allTools.push({ name: fqn, description: tool.description, schema: tool.inputSchema });
            } catch {
              // duplicate or error — skip
            }
          }

          console.error(`[mcp-proxy] Server '${name}' ready — ${proc.tools.length} tools`);
        } catch (err) {
          console.error(
            `[mcp-proxy] Server '${name}' failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    this._registerWithGateway(allTools);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((p) => p.stop()));
    this.servers.clear();
  }

  health(): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    for (const [name, proc] of this.servers) {
      servers[name] = {
        status: proc.status,
        uptime_s: proc.startedAt
          ? Math.floor((Date.now() - proc.startedAt.getTime()) / 1000)
          : null,
        last_invocation_at: proc.lastInvocationAt?.toISOString() ?? null,
        tools: proc.tools.map((t) => t.name),
      };
    }
    return { servers };
  }

  private _loadConfig(): ProxyConfig | null {
    const paths = [this.configPath, join(homedir(), ".config", "claude", "mcp.json")];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        const result = ProxyConfigSchema.safeParse(raw);
        if (result.success) return result.data;
      } catch {}
    }
    return null;
  }

  private _registerWithGateway(
    tools: { name: string; description: string; schema: Record<string, unknown> }[],
  ): void {
    const gateway = getHttpGateway();
    this.pluginToken = gateway.registerInProcess("mcp-proxy", {
      version: "1.0.0",
      tools,
      healthFn: async () => this.health(),
    });

    const tokenDir = join(this.tokenPath, "..");
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(this.tokenPath, this.pluginToken.toString("hex"), { encoding: "utf8" });
    chmodSync(this.tokenPath, 0o600);

    console.error(
      `[mcp-proxy] Registered with gateway — ${tools.length} tools. Token stored at ${this.tokenPath}`,
    );
  }

  private _onServerCrash(name: string, reason: string): void {
    const proc = this.servers.get(name);
    if (!proc) return;

    // #72 item 4: emit distinct events for transient crashes vs terminal
    // failures so operators don't have to inspect the `status` field to
    // differentiate. The two are MUTUALLY EXCLUSIVE per incident:
    //   - `status === "failed"` → only `mcp_proxy_server_permanently_failed`
    //   - otherwise              → only `mcp_proxy_server_crashed` (auto-recovery
    //                              loop is still running)
    // Both payloads keep the legacy `{server, reason, status}` shape so
    // downstream dashboards / alert rules can keep filtering on
    // either name without a payload-shape migration.
    if (proc.status === "failed") {
      console.error(`[mcp-proxy] Server '${name}' permanently failed: ${reason}`);
      getMcpBridge().audit("mcp_proxy_server_permanently_failed", {
        server: name,
        reason,
        status: proc.status,
      });
      return;
    }
    console.error(`[mcp-proxy] Server '${name}' crashed: ${reason} — status: ${proc.status}`);
    getMcpBridge().audit("mcp_proxy_server_crashed", {
      server: name,
      reason,
      status: proc.status,
    });
  }

  private async _invokeReasoned(fqn: string, args: unknown): Promise<unknown> {
    if (!this.reasonedInvokeFn) {
      throw new Error(`reasoned mode not configured for ${fqn}`);
    }
    return this.reasonedInvokeFn(fqn, args);
  }
}

// ── Settings helpers ──────────────────────────────────────────────────────────

/** Names of servers the multiplexer is *actually* serving right now —
 *  NOT just the names listed in `settings.mcp.shared`. The two diverge
 *  whenever the multiplexer plugin is dormant (web disabled, non-loopback
 *  host, zero claimed servers, missing mcp-proxy.json). When dormant, the
 *  proxy must still spawn the servers so legacy bridge / tool-call flows
 *  keep working — see PR #71 Codex P1 finding. */
function _sharedActuallyClaimedByMultiplexer(): Set<string> {
  try {
    // Lazy require to avoid a circular import (`mcp-multiplexer` imports
    // `mcp-bridge`, `mcp-bridge` is a peer of `mcp-proxy`). The dynamic
    // require is fine — both modules are loaded by the time the proxy's
    // `start()` is called from `commands/start.ts`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../mcp-multiplexer/index.js") as {
      getMcpMultiplexerPlugin?: () => {
        isActive: () => boolean;
        sharedServerNames: () => string[];
      };
    };
    const factory = mod.getMcpMultiplexerPlugin;
    if (typeof factory !== "function") return new Set();
    const plugin = factory();
    if (!plugin.isActive()) return new Set();
    return new Set(plugin.sharedServerNames());
  } catch {
    // Module not present, plugin not built yet, or any other lookup error
    // → treat as dormant, proxy spawns everything as today.
    return new Set();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _proxy: McpProxyPlugin | null = null;

export function getMcpProxyPlugin(opts?: McpProxyPluginOpts): McpProxyPlugin {
  if (!_proxy) _proxy = new McpProxyPlugin(opts);
  return _proxy;
}

export function _resetMcpProxy(): void {
  _proxy = null;
}
