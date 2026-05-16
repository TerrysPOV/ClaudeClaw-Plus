/**
 * McpMultiplexerPlugin — daemon-side MCP server multiplexer.
 *
 * Spawns shared MCP-server children once at daemon startup and
 * republishes them over local-loopback Streamable HTTP to each PTY-
 * resident `claude` (replacing per-PTY stdio spawns). Footprint reduction
 * is the entire point — see `.planning/mcp-multiplexer/SPEC.md` §1.
 *
 * This plugin is dormant by default. It "activates" only when:
 *   - `settings.web.enabled === true`, AND
 *   - `settings.mcp.shared` is a non-empty list of server names that
 *     exist in `mcp-proxy.json`.
 *
 * When dormant the supervisor sees `isActive() === false` and skips the
 * `--mcp-config` synthesis step (`pty-mcp-config-writer.ts`, W2). The
 * runtime behaviour reduces to PR #62's stock PTY path.
 *
 * Cross-worktree contract published to W2 (`pty-mcp-config-writer.ts`):
 *   - `isActive(): boolean`
 *   - `sharedServerNames(): string[]`
 *   - `issueIdentity(ptyId): PtyIdentity`
 *   - `releaseIdentity(ptyId): Promise<void>`
 *   - `bridgeBaseUrl(): string`
 *
 * See `.planning/mcp-multiplexer/W1-COORD.md` for the published signatures.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getHttpGateway } from "../http-gateway.js";
import { getMcpBridge } from "../mcp-bridge.js";
import { McpServerProcess, type McpServerConfig } from "../mcp-proxy/server-process.js";
import { getSettings } from "../../config.js";
import { McpHttpHandler } from "./http-handler.js";
import {
  issueIdentity as _issueIdentity,
  revokeIdentity as _revokeIdentity,
  _resetIdentityStore,
  type PtyIdentity,
} from "./pty-identity.js";
import { SessionPersistenceStore } from "./session-persistence.js";

/** Same plugin id used for audit + bridge-callback registration.
 *  Must satisfy `PluginMcpBridge._validatePluginId` (lowercase kebab). */
const PLUGIN_ID = "mcp-multiplexer";

/** Builds the `name` argument we pass to `registerPluginTool` for a given
 *  (server, tool) pair. NOT the stored FQN — the bridge prefixes every
 *  registered tool with its pluginId (mcp-bridge.ts L65
 *  `${pluginId}__${tool.name}`), so the stored FQN ends up
 *  `mcp-multiplexer__<server>__<tool>`. Per the operator's constraint the
 *  pluginId is fixed at `"mcp-multiplexer"`, which partitions the FQN
 *  namespace cleanly from mcp-proxy's `mcp-proxy__<server>__<tool>` tools
 *  — no possible collision even before the skip-shared rule (which is a
 *  separate structural guarantee anyway). */
function _toBridgeToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

// Config schema for `~/.config/claudeclaw/mcp-proxy.json` — reused from
// `mcp-proxy/index.ts` so we read the operator's single source of truth.
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

/** Subset of `Settings` that the multiplexer cares about. Read defensively
 *  because the `mcp` block is added to `Settings` by W2; until then it
 *  may be absent at runtime.
 *
 *  Exported as a test seam — production constructs the view from the
 *  global `getSettings()`; tests pass a pre-built view via
 *  `McpMultiplexerPluginOpts.settingsView`. */
export interface MuxSettingsView {
  webEnabled: boolean;
  webHost: string;
  webPort: number;
  shared: string[];
  stateless: string[];
  /** Health probe interval in milliseconds. 0 disables the probe. Default
   *  derives from `settings.mcp.healthProbeIntervalMs` (30s). */
  healthProbeIntervalMs: number;
  /** Master switch for session-map persistence. Default true (always-
   *  resume per SPEC-DELTA-2026-05-16). When false the multiplexer
   *  never constructs the persistence store and behaves exactly as
   *  PR #71. */
  sessionPersistenceEnabled: boolean;
  /** Max age (seconds) of a persisted record. Default 3600. */
  sessionMaxAgeSeconds: number;
  /** Storage directory. Empty string means "compute from homedir at
   *  start time" — multiplexer resolves to
   *  `~/.config/claudeclaw/mcp-sessions/`. */
  sessionPersistencePath: string;
}

function _readSettings(): MuxSettingsView {
  const s = getSettings();
  // Settings.mcp is added by W2 (`feat/mcp-multiplexer-pty-wiring`).
  // Until that lands we tolerate its absence.
  const mcpRaw = (s as unknown as { mcp?: unknown }).mcp;
  const shared = _stringArray(mcpRaw, "shared");
  const stateless = _stringArray(mcpRaw, "stateless");
  const probeRaw =
    mcpRaw && typeof mcpRaw === "object"
      ? (mcpRaw as Record<string, unknown>).healthProbeIntervalMs
      : undefined;
  const healthProbeIntervalMs =
    typeof probeRaw === "number" && Number.isFinite(probeRaw) && probeRaw >= 0
      ? Math.floor(probeRaw)
      : 30000;
  const mcpObj = mcpRaw && typeof mcpRaw === "object" ? (mcpRaw as Record<string, unknown>) : {};
  // SPEC-DELTA-2026-05-16 always-resume default: true unless explicitly
  // set to false (kill-switch).
  const sessionPersistenceEnabled = mcpObj.sessionPersistenceEnabled === false ? false : true;
  const rawMaxAge = mcpObj.sessionMaxAgeSeconds;
  const sessionMaxAgeSeconds =
    typeof rawMaxAge === "number" && Number.isFinite(rawMaxAge) && rawMaxAge > 0
      ? Math.max(60, Math.floor(rawMaxAge))
      : 3600;
  const rawPath = mcpObj.sessionPersistencePath;
  const sessionPersistencePath =
    typeof rawPath === "string" && rawPath.length > 0 && rawPath.startsWith("/") ? rawPath : "";
  return {
    webEnabled: s.web?.enabled === true,
    webHost: s.web?.host ?? "127.0.0.1",
    webPort: typeof s.web?.port === "number" ? s.web.port : 4632,
    shared,
    stateless: stateless.filter((n) => shared.includes(n)),
    healthProbeIntervalMs,
    sessionPersistenceEnabled,
    sessionMaxAgeSeconds,
    sessionPersistencePath,
  };
}

function _stringArray(o: unknown, key: string): string[] {
  if (!o || typeof o !== "object") return [];
  const v = (o as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.length > 0);
}

export interface McpMultiplexerPluginOpts {
  /** Override the path to `mcp-proxy.json`. Tests pass a tmpdir-scoped
   *  fake; production defaults to `~/.config/claudeclaw/mcp-proxy.json`. */
  configPath?: string;
  /** Override the base URL used by the synthesized `--mcp-config`. When
   *  unset, derived from `settings.web.host/port`. Tests can pin this. */
  bridgeBaseUrlOverride?: string;
  /** Test seam — provides the settings view directly instead of reading
   *  from the global `getSettings()`. Production wiring leaves this
   *  undefined; tests pass a pre-built view. */
  settingsView?: () => MuxSettingsView;
  /** Test seam — injects a pre-built persistence store instead of
   *  letting the plugin construct one at `start()`. When undefined and
   *  `settings.mcp.sessionPersistenceEnabled === true`, the plugin
   *  constructs a `SessionPersistenceStore` rooted at the configured
   *  path. Tests pass an in-memory or tmpdir-rooted fake.
   *
   *  When undefined, production wiring constructs a real
   *  `SessionPersistenceStore` rooted at `settings.mcp.sessionPersistencePath`. */
  persistenceFactory?: (opts: {
    storageRoot: string;
    maxAgeMs: number;
  }) => SessionPersistenceStore | null;
  /** GC tick interval in milliseconds. Default 1 hour. Tests pin this
   *  to a smaller value or 0 (disabled — drive via `_runGCTickForTests`). */
  gcTickMs?: number;
}

export class McpMultiplexerPlugin {
  private readonly configPath: string;
  private readonly bridgeBaseUrlOverride?: string;
  private readonly settingsView: () => MuxSettingsView;
  private readonly persistenceFactory?: (opts: {
    storageRoot: string;
    maxAgeMs: number;
  }) => SessionPersistenceStore | null;
  private readonly gcTickMsOverride?: number;
  private servers = new Map<string, McpServerProcess>();
  private handlers = new Map<string, McpHttpHandler>();
  private started = false;
  private active = false;
  private cachedSharedNames: string[] = [];
  private cachedStatelessNames: string[] = [];
  private cachedBridgeBaseUrl = "http://127.0.0.1:4632";
  /** Periodic liveness sampler. Null when probe is disabled (intervalMs=0)
   *  or the plugin is dormant. */
  private healthProbeTimer: ReturnType<typeof setInterval> | null = null;
  /** Previous observed status per shared server. Drives the transition
   *  log/audit on each probe tick. */
  private lastObservedStatus = new Map<string, string>();
  /** Session-map persistence layer. Null when:
   *   - operator disabled via `sessionPersistenceEnabled: false`, OR
   *   - no `persistenceFactory` was supplied (W1 not yet merged), OR
   *   - the factory returned null (degraded — disk/permission errors). */
  private persistence: SessionPersistenceStore | null = null;
  /** Periodic GC sweep. Null when persistence is dormant. */
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: McpMultiplexerPluginOpts = {}) {
    this.configPath = opts.configPath ?? join(homedir(), ".config", "claudeclaw", "mcp-proxy.json");
    this.bridgeBaseUrlOverride = opts.bridgeBaseUrlOverride;
    this.settingsView = opts.settingsView ?? _readSettings;
    this.persistenceFactory = opts.persistenceFactory;
    this.gcTickMsOverride = opts.gcTickMs;
  }

  async start(): Promise<void> {
    // Only commit `started = true` once the spawn loop has produced at least
    // one claimed server. A dormant bail-out leaves `started === false` so a
    // subsequent operator-driven re-`start()` after settings change can succeed.
    if (this.started) return;

    const settings = this.settingsView();

    // Refuse to expose MCP servers over a non-loopback gateway.
    if (settings.webHost !== "127.0.0.1" && settings.webHost !== "localhost") {
      console.error(
        `[mcp-multiplexer] dormant — gateway host '${settings.webHost}' is non-loopback; refusing to expose MCP routes externally.`,
      );
      try {
        getMcpBridge().audit("multiplexer_refused_non_loopback", {
          host: settings.webHost,
        });
      } catch {}
      return;
    }

    if (!settings.webEnabled) {
      console.error(
        "[mcp-multiplexer] dormant — settings.web.enabled is false; multiplexer requires the HTTP gateway.",
      );
      try {
        getMcpBridge().audit("multiplexer_dormant_web_disabled", {});
      } catch {}
      return;
    }

    if (settings.shared.length === 0) {
      console.error("[mcp-multiplexer] dormant — settings.mcp.shared is empty.");
      try {
        getMcpBridge().audit("multiplexer_dormant_empty_shared", {});
      } catch {}
      return;
    }

    // Cache the bridge URL used by W2 / the supervisor's synthesised
    // --mcp-config. `cachedSharedNames` and `cachedStatelessNames` are
    // populated AFTER the spawn loop so they reflect what we *actually*
    // claim, not what the operator *requested*. Codex PR #71 P2 #3:
    // a partial-start would otherwise report failed servers as claimed,
    // and `mcp-proxy`'s `_sharedActuallyClaimedByMultiplexer()` would
    // skip them too, leaving those servers unreachable from BOTH paths.
    this.cachedBridgeBaseUrl =
      this.bridgeBaseUrlOverride ?? `http://${settings.webHost}:${settings.webPort}`;

    const config = this._loadConfig();
    if (!config) {
      console.error(
        `[mcp-multiplexer] dormant — could not load ${this.configPath}; no shared servers will be spawned.`,
      );
      try {
        getMcpBridge().audit("multiplexer_no_config", { path: this.configPath });
      } catch {}
      // Clear the cache we set above so isActive() + bridgeBaseUrl() are
      // consistent ("plugin is not running" → "URL is default placeholder").
      this.cachedSharedNames = [];
      this.cachedStatelessNames = [];
      this.cachedBridgeBaseUrl = "http://127.0.0.1:4632";
      return;
    }

    // Construct the persistence layer BEFORE the spawn loop so handlers
    // get the store reference at construction time. Production wiring
    // typically calls `getMcpMultiplexerPlugin()` with no options, so
    // `persistenceFactory` is undefined — in that case we default to the
    // real `SessionPersistenceStore`. Tests pass a factory (e.g.
    // FakeStore) to override. Operator-disabled
    // (`sessionPersistenceEnabled: false`) skips construction entirely
    // — that's the kill-switch escape hatch.
    //
    // Codex PR #78 P1: previously gated on `&& this.persistenceFactory`,
    // which meant production never activated the layer. Fixed by
    // defaulting to the real store when the factory is absent.
    if (settings.sessionPersistenceEnabled) {
      const storageRoot =
        settings.sessionPersistencePath || join(homedir(), ".config", "claudeclaw", "mcp-sessions");
      const factory =
        this.persistenceFactory ??
        ((opts: { storageRoot: string; maxAgeMs: number }) => new SessionPersistenceStore(opts));
      try {
        this.persistence = factory({
          storageRoot,
          maxAgeMs: settings.sessionMaxAgeSeconds * 1000,
        });
      } catch (err) {
        console.warn(
          `[mcp-multiplexer] persistence layer init failed (continuing without): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.persistence = null;
      }
    }

    // Spawn the shared upstream children. Use `allSettled` so one bad
    // server doesn't take down the others — matches `mcp-proxy`
    // graceful-degradation semantics.
    const claimed: string[] = [];
    await Promise.allSettled(
      settings.shared.map(async (name) => {
        const cfg = config.servers[name];
        if (!cfg || cfg.enabled === false) {
          console.error(
            `[mcp-multiplexer] skipping '${name}' — not present or disabled in ${this.configPath}.`,
          );
          return;
        }
        try {
          const proc = new McpServerProcess(name, cfg as McpServerConfig, {
            onCrash: (n, reason) => this._onServerCrash(n, reason),
          });
          await proc.start();
          this.servers.set(name, proc);
          claimed.push(name);

          const handler = new McpHttpHandler({
            serverName: name,
            proc,
            stateless: settings.stateless.includes(name),
            // Only stateful handlers receive the store; stateless
            // declared servers ignore it internally as well.
            persistence: settings.stateless.includes(name)
              ? undefined
              : (this.persistence ?? undefined),
          });
          this.handlers.set(name, handler);

          // Mount the per-server HTTP route on the gateway.
          getHttpGateway().registerMcpHandler(name, (req) => handler.handle(req));

          // Register in-process bridge callbacks so legacy `claude -p`
          // callsites can still reach the tools. SPEC §10 Q#2.
          this._registerBridgeCallbacks(name, proc);

          console.error(
            `[mcp-multiplexer] spawned ${name} pid ${this._pidOf(proc)} — ${proc.tools.length} tools`,
          );
          try {
            getMcpBridge().audit("multiplexer_server_ready", {
              server: name,
              stateless: settings.stateless.includes(name),
              tools: proc.tools.length,
            });
          } catch {}
        } catch (err) {
          console.error(
            `[mcp-multiplexer] failed to start '${name}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );

    this.active = claimed.length > 0;
    if (!this.active) {
      console.error("[mcp-multiplexer] no shared servers came up successfully — going dormant.");
      this.cachedSharedNames = [];
      this.cachedStatelessNames = [];
      this.cachedBridgeBaseUrl = "http://127.0.0.1:4632";
      return;
    }

    // Codex PR #71 P2 #3: cache the names we ACTUALLY claimed (not the
    // operator's requested set). `sharedServerNames()` is the public
    // contract `mcp-proxy._sharedActuallyClaimedByMultiplexer()` reads
    // when deciding which servers to skip; if a requested server failed
    // to spawn, the proxy must still own it.
    this.cachedSharedNames = claimed.slice();
    // Stateless names are filtered to the intersection of declared
    // stateless AND actually-claimed.
    this.cachedStatelessNames = settings.stateless.filter((n) => claimed.includes(n));

    // Commit started AFTER we've claimed at least one server — a dormant
    // bail-out above leaves started=false so the operator can re-`start()`
    // post-settings-change.
    this.started = true;

    // Start the periodic health probe. Closes the silent-degradation gap
    // flagged on #64: when one shared MCP crashes all PTYs lose that tool
    // simultaneously, and without an active probe the operator only finds
    // out when something fails to respond.
    this._startHealthProbe(settings.healthProbeIntervalMs);

    // SPEC §4.4: replay persisted session bindings AFTER the spawn loop
    // succeeds and the health probe is armed, but BEFORE any PTY-side
    // claude can hit the gateway. The supervisor wakes up after this
    // method returns, so this ordering is safe.
    if (this.persistence) {
      await this._replayPersistedSessions();
      // Start the GC sweep. Default cadence 1h; tests pin to 0 to drive
      // synchronously via `_runGCTickForTests`.
      const gcTickMs = this.gcTickMsOverride ?? 3_600_000;
      this._startGCTick(gcTickMs);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.active = false;
    this._stopHealthProbe();
    this._stopGCTick();
    try {
      getMcpBridge().unregisterPlugin(PLUGIN_ID);
    } catch {}
    const gateway = getHttpGateway();
    for (const name of this.handlers.keys()) {
      gateway.unregisterMcpHandler?.(name);
    }
    await Promise.allSettled([...this.handlers.values()].map((h) => h.stop()));
    this.handlers.clear();
    await Promise.allSettled([...this.servers.values()].map((s) => s.stop()));
    this.servers.clear();
    // Drop the persistence reference last — handlers may have queued
    // touch/drop calls that we don't await here (they're fire-and-
    // forget). Letting GC reclaim the store object is fine; the next
    // `start()` constructs a new one.
    this.persistence = null;
    this.cachedSharedNames = [];
    this.cachedStatelessNames = [];
    this.cachedBridgeBaseUrl = "http://127.0.0.1:4632";
  }

  // ── Health probe ────────────────────────────────────────────────────

  private _startHealthProbe(intervalMs: number): void {
    if (intervalMs <= 0) return;
    // Seed the baseline before the first tick so we don't fire transition
    // events from `undefined` → `up` at startup.
    for (const [name, proc] of this.servers) {
      this.lastObservedStatus.set(name, proc.status);
    }
    this.healthProbeTimer = setInterval(() => this._sampleHealth(), intervalMs);
    if (typeof this.healthProbeTimer.unref === "function") {
      this.healthProbeTimer.unref();
    }
  }

  private _stopHealthProbe(): void {
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = null;
    }
    this.lastObservedStatus.clear();
  }

  // ── Session-map persistence ─────────────────────────────────────────

  /**
   * SPEC §4.4 replay sequence (post SPEC-DELTA-2026-05-16 always-resume).
   *
   * For each currently-claimed, non-stateless server, load the persisted
   * records and re-install a bucket for each ptyId. The persistence
   * layer (W1) is responsible for TTL/integrity filtering — by the time
   * `loadAll(serverName)` returns, the only entries are ones we should
   * actually try to resume.
   *
   * Replay is best-effort: any single entry's failure (transport error,
   * upstream not yet ready, etc.) is logged + audited but does NOT
   * block other entries or the daemon's overall startup.
   */
  private async _replayPersistedSessions(): Promise<void> {
    if (!this.persistence) return;
    const bridge = (() => {
      try {
        return getMcpBridge();
      } catch {
        return null;
      }
    })();
    const resumable = this.cachedSharedNames.filter(
      (name) => !this.cachedStatelessNames.includes(name),
    );
    for (const serverName of resumable) {
      const handler = this.handlers.get(serverName);
      if (!handler) continue;
      let records: Array<{ ptyId: string; sessionId: string }>;
      try {
        records = await this.persistence.loadAll(serverName);
      } catch (err) {
        console.warn(
          `[mcp-multiplexer] replay: loadAll('${serverName}') failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      for (const record of records) {
        try {
          bridge?.audit("mcp_session_resume_attempted", {
            server: serverName,
            pty_id: record.ptyId,
            session_id: record.sessionId,
          });
        } catch {}
        try {
          await handler.installResumedBucket(record.ptyId, record.sessionId);
          try {
            bridge?.audit("mcp_session_resumed", {
              server: serverName,
              pty_id: record.ptyId,
              session_id: record.sessionId,
            });
          } catch {}
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            bridge?.audit("mcp_session_lost_on_restart", {
              server: serverName,
              pty_id: record.ptyId,
              session_id: record.sessionId,
              reason: "replay_failed",
              error: message,
            });
          } catch {}
          // Drop the persisted record so we don't repeatedly fail on
          // the same broken binding across daemon restarts.
          await this.persistence.drop(serverName, record.ptyId).catch(() => {});
        }
      }
    }
  }

  private _startGCTick(intervalMs: number): void {
    if (intervalMs <= 0) return;
    if (!this.persistence) return;
    this.gcTimer = setInterval(() => {
      void this._runGCTick();
    }, intervalMs);
    if (typeof this.gcTimer.unref === "function") {
      this.gcTimer.unref();
    }
  }

  private _stopGCTick(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** One GC pass. Delegates the TTL sweep to the persistence layer;
   *  the store emits `mcp_session_gc` per dropped entry internally. */
  private async _runGCTick(): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.garbageCollect();
    } catch (err) {
      console.warn(
        `[mcp-multiplexer] persistence GC failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Test seam — run one GC tick synchronously without waiting for the
   *  interval. Mirrors the `_sampleHealthForTests` pattern. */
  async _runGCTickForTests(): Promise<void> {
    await this._runGCTick();
  }

  /** Test seam — drive replay synchronously. Useful for tests that
   *  inject the persistence factory + pre-populate records, then want
   *  to assert replay outcomes without re-`start()`ing. */
  async _replayForTests(): Promise<void> {
    await this._replayPersistedSessions();
  }

  /** Sample `proc.status` for every shared server. On state transition,
   *  emit a structured audit event and a console line. Degraded states
   *  (`crashed`, `failed`) go to stderr with a `DEGRADED` tag so operators
   *  can grep them from the daemon log. Exposed as `_sampleHealthForTests`
   *  to avoid timer flakiness in unit tests. */
  _sampleHealthForTests(): void {
    this._sampleHealth();
  }

  private _sampleHealth(): void {
    for (const [name, proc] of this.servers) {
      const prev = this.lastObservedStatus.get(name);
      const curr = proc.status as string;
      if (prev === curr) continue;
      const degraded = curr === "crashed" || curr === "failed";
      const uptimeS = proc.startedAt
        ? Math.floor((Date.now() - proc.startedAt.getTime()) / 1000)
        : null;
      try {
        getMcpBridge().audit(degraded ? "mcp_health_degraded" : "mcp_health_transition", {
          server: name,
          previous_status: prev ?? "unknown",
          current_status: curr,
          uptime_s: uptimeS,
        });
      } catch {}
      const line = `[mcp-multiplexer] HEALTH ${name}: ${prev ?? "unknown"} → ${curr}${degraded ? " (DEGRADED)" : ""}`;
      if (degraded) console.warn(line);
      else console.log(line);
      this.lastObservedStatus.set(name, curr);
    }
  }

  health(): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    for (const [name, proc] of this.servers) {
      servers[name] = {
        status: proc.status,
        tools: proc.tools.map((t) => t.name),
        uptime_s: proc.startedAt
          ? Math.floor((Date.now() - proc.startedAt.getTime()) / 1000)
          : null,
        last_invocation_at: proc.lastInvocationAt?.toISOString() ?? null,
        handler: this.handlers.get(name)?.health() ?? null,
      };
    }
    return {
      active: this.active,
      bridge_base_url: this.cachedBridgeBaseUrl,
      shared: this.cachedSharedNames.slice(),
      stateless: this.cachedStatelessNames.slice(),
      servers,
    };
  }

  // ── Public contract consumed by W2 ──────────────────────────────────

  isActive(): boolean {
    return this.active;
  }

  sharedServerNames(): string[] {
    return this.cachedSharedNames.slice();
  }

  bridgeBaseUrl(): string {
    return this.cachedBridgeBaseUrl;
  }

  issueIdentity(ptyId: string): PtyIdentity {
    const id = _issueIdentity(ptyId);
    try {
      getMcpBridge().audit("multiplexer_identity_issued", {
        pty_id: ptyId,
        issued_at: id.issuedAt,
      });
    } catch {}
    return id;
  }

  async releaseIdentity(ptyId: string): Promise<void> {
    const removed = _revokeIdentity(ptyId);
    await Promise.allSettled([...this.handlers.values()].map((h) => h.releasePty(ptyId)));
    if (removed) {
      try {
        getMcpBridge().audit("multiplexer_identity_released", { pty_id: ptyId });
      } catch {}
    }
  }

  // ── Test seam ───────────────────────────────────────────────────────

  /** Returns a snapshot of the (serverName → tools) tree. */
  _snapshotServers(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [name, proc] of this.servers) {
      out[name] = proc.tools.map((t) => t.name);
    }
    return out;
  }

  /** Returns the live handler for a given server name. Test-only. */
  _getHandler(name: string): McpHttpHandler | undefined {
    return this.handlers.get(name);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _loadConfig() {
    if (!existsSync(this.configPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
      const result = ProxyConfigSchema.safeParse(raw);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private _pidOf(proc: McpServerProcess): string {
    // McpServerProcess does not expose pid directly; surface via the
    // private transport when present (best-effort, observability only).
    // Cast through `unknown` to keep TS happy without leaking the
    // private member into the public type.
    const t = (proc as unknown as { transport?: { pid?: number } }).transport;
    return t && typeof t.pid === "number" ? String(t.pid) : "?";
  }

  private _onServerCrash(name: string, reason: string): void {
    const proc = this.servers.get(name);
    try {
      getMcpBridge().audit("multiplexer_server_crashed", {
        server: name,
        reason,
        status: proc?.status ?? "unknown",
      });
    } catch {}
    console.error(
      `[mcp-multiplexer] server '${name}' crashed: ${reason} — status: ${proc?.status ?? "unknown"}`,
    );
  }

  private _registerBridgeCallbacks(serverName: string, proc: McpServerProcess): void {
    const bridge = getMcpBridge();
    for (const tool of proc.tools) {
      const fqn = _toBridgeToolName(serverName, tool.name);
      try {
        bridge.registerPluginTool(PLUGIN_ID, {
          name: fqn,
          description: tool.description,
          schema: z.object({
            arguments: z.record(z.string(), z.unknown()).optional().default({}),
          }),
          handler: async (input) => {
            const args = input.arguments ?? {};
            return proc.call(tool.name, args);
          },
        });
      } catch {
        // duplicate registration (e.g. legacy `mcp-proxy` claimed the
        // same FQN before being told to skip it) — leave the existing
        // registration alone; the skip-shared rule in mcp-proxy/index.ts
        // is the structural fix.
      }
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: McpMultiplexerPlugin | null = null;

export function getMcpMultiplexerPlugin(opts?: McpMultiplexerPluginOpts): McpMultiplexerPlugin {
  if (!_instance) _instance = new McpMultiplexerPlugin(opts);
  return _instance;
}

export function _resetMcpMultiplexer(): void {
  _instance = null;
  _resetIdentityStore();
}

// Re-export identity types/functions so W2 can import everything from a
// single path: `import { issueIdentity, ... } from "../plugins/mcp-multiplexer/index.js";`
export type { PtyIdentity } from "./pty-identity.js";
export {
  AUTH_HEADER,
  PTY_ID_HEADER,
  PTY_TS_HEADER,
  verifyBearer,
} from "./pty-identity.js";
