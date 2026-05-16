import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpMultiplexerPlugin, _resetMcpMultiplexer, type MuxSettingsView } from "../index.js";
import { _resetHttpGateway, getHttpGateway } from "../../http-gateway.js";
import { _resetMcpBridge, getMcpBridge } from "../../mcp-bridge.js";
import { _resetIdentityStore } from "../pty-identity.js";

const MOCK_SERVER = fileURLToPath(
  new URL("../../../__tests__/fixtures/mock-mcp-server.ts", import.meta.url),
);
const BUN_BIN = process.execPath;

function writeProxyConfig(dir: string, servers: string[]): string {
  const cfg = {
    servers: Object.fromEntries(
      servers.map((name) => [
        name,
        {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      ]),
    ),
  };
  const path = join(dir, "mcp-proxy.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function makeSettingsView(partial: Partial<MuxSettingsView>): () => MuxSettingsView {
  const view: MuxSettingsView = {
    webEnabled: true,
    webHost: "127.0.0.1",
    webPort: 4632,
    shared: [],
    stateless: [],
    // Disable the health probe by default so unit tests don't deal with
    // timer flakiness; the probe is exercised directly via
    // `_sampleHealthForTests` in dedicated tests below.
    healthProbeIntervalMs: 0,
    // Default to false in tests so the persistence-layer tests can opt
    // in explicitly. Backward-compat tests then prove that
    // `sessionPersistenceEnabled: false` keeps the plugin byte-identical
    // to PR #71.
    sessionPersistenceEnabled: false,
    sessionMaxAgeSeconds: 3600,
    sessionPersistencePath: "",
    ...partial,
  };
  return () => view;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-mux-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
});

afterEach(() => {
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── Activation gates ──────────────────────────────────────────────────────────

describe("McpMultiplexerPlugin — activation", () => {
  it("dormant when settings.web.enabled is false", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["one"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: false, shared: ["one"] }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(false);
    expect(plugin.sharedServerNames()).toEqual([]);
    await plugin.stop();
  });

  it("dormant when settings.mcp.shared is empty", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["one"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: [] }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(false);
    await plugin.stop();
  });

  it("refuses to start when gateway host is non-loopback", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["one"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        webEnabled: true,
        webHost: "0.0.0.0",
        shared: ["one"],
      }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(false);
    expect(getHttpGateway().hasMcpHandler("one")).toBe(false);
    await plugin.stop();
  });

  it("dormant when mcp-proxy.json missing", async () => {
    const plugin = new McpMultiplexerPlugin({
      configPath: join(tmpDir, "does-not-exist.json"),
      settingsView: makeSettingsView({ webEnabled: true, shared: ["one"] }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(false);
    await plugin.stop();
  });
});

// ── Real upstream spawn ───────────────────────────────────────────────────────

describe("McpMultiplexerPlugin — active path", () => {
  it("spawns only servers listed in settings.mcp.shared", async () => {
    // mcp-proxy.json has three servers; settings.shared only lists two.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta", "gamma"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha", "beta"],
      }),
    });

    await plugin.start();

    try {
      expect(plugin.isActive()).toBe(true);
      const snapshot = plugin._snapshotServers();
      expect(Object.keys(snapshot).sort()).toEqual(["alpha", "beta"]);
      expect(snapshot.alpha).toContain("echo");
      expect(plugin.sharedServerNames().sort()).toEqual(["alpha", "beta"]);
    } finally {
      await plugin.stop();
    }
  });

  it("Codex PR #71 P2 #3 regression — sharedServerNames reports CLAIMED, not requested", async () => {
    // Operator requests three shared servers but mcp-proxy.json only
    // defines one. The other two are missing from the proxy config →
    // the multiplexer logs "skipping … not present" and proceeds with
    // only the present one. sharedServerNames() must reflect what we
    // actually claim, NOT the operator's broader request — otherwise
    // mcp-proxy._sharedActuallyClaimedByMultiplexer() would also skip
    // the missing names, leaving them unreachable from BOTH paths.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]); // only alpha exists
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha", "missing-one", "missing-two"],
        stateless: ["alpha", "missing-one"], // stateless must also intersect with claimed
      }),
    });

    await plugin.start();

    try {
      expect(plugin.isActive()).toBe(true);
      // Only alpha actually came up; sharedServerNames must NOT include
      // missing-one or missing-two even though they were in settings.
      expect(plugin.sharedServerNames()).toEqual(["alpha"]);
      // Stateless filter applies to the claimed set, not the requested set.
      const health = plugin.health() as { stateless: string[] };
      expect(health.stateless).toEqual(["alpha"]);
    } finally {
      await plugin.stop();
    }
  });

  it("mounts a /mcp/<name> handler on the gateway for each shared server", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    try {
      const gw = getHttpGateway();
      expect(gw.hasMcpHandler("alpha")).toBe(true);
      expect(gw.hasMcpHandler("beta")).toBe(false);
    } finally {
      await plugin.stop();
    }
  });

  it("registers bridge callbacks for each shared tool under mcp-multiplexer__<server>__<tool>", async () => {
    // PluginMcpBridge always prefixes the registered tool name with the
    // pluginId — see mcp-bridge.ts L65 `${pluginId}__${tool.name}`. The
    // multiplexer registers its tools under `pluginId = "mcp-multiplexer"`
    // with the name argument `<server>__<tool>` (SPEC §10 Q#2). The
    // resulting stored FQN is `mcp-multiplexer__<server>__<tool>`. This
    // partitions the FQN namespace from mcp-proxy's tools cleanly.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    try {
      const bridgeTools = getMcpBridge()
        .listTools()
        .map((t) => t.fqn);
      expect(bridgeTools).toContain("mcp-multiplexer__alpha__echo");
    } finally {
      await plugin.stop();
    }
  });

  it("legacy callsites can invoke a shared tool via the bridge", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    try {
      const result = await getMcpBridge().invokeTool("mcp-multiplexer__alpha__echo", {
        arguments: { message: "hi" },
      });
      expect(result).toBeDefined();
    } finally {
      await plugin.stop();
    }
  });

  it("issueIdentity and releaseIdentity round-trip per ptyId", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    try {
      const a = plugin.issueIdentity("suzy");
      expect(a.ptyId).toBe("suzy");
      expect(a.headers["Authorization"]).toMatch(/^Bearer /);

      await plugin.releaseIdentity("suzy");
      const b = plugin.issueIdentity("suzy");
      expect(b.headers.Authorization).not.toBe(a.headers.Authorization);
    } finally {
      await plugin.stop();
    }
  });

  it("bridgeBaseUrl reflects settings.web.{host,port}", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        webEnabled: true,
        webHost: "127.0.0.1",
        webPort: 12345,
        shared: ["alpha"],
      }),
    });

    await plugin.start();

    try {
      expect(plugin.bridgeBaseUrl()).toBe("http://127.0.0.1:12345");
    } finally {
      await plugin.stop();
    }
  });

  it("stateless declaration is honoured", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha", "beta"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha", "beta"],
        // Note: stateless filtering to subset-of-shared happens in
        // _readSettings(); when tests pass a settingsView directly,
        // the view is taken as-is. The plugin still honours the value.
        stateless: ["beta"],
      }),
    });

    await plugin.start();

    try {
      const h = plugin.health() as Record<string, unknown>;
      expect(h.stateless).toEqual(["beta"]);
      const handlerAlpha = plugin._getHandler("alpha");
      const handlerBeta = plugin._getHandler("beta");
      expect((handlerAlpha?.health() as { stateless: boolean }).stateless).toBe(false);
      expect((handlerBeta?.health() as { stateless: boolean }).stateless).toBe(true);
    } finally {
      await plugin.stop();
    }
  });

  it("health() snapshot exposes server status + handler info", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    try {
      const h = plugin.health() as Record<string, unknown>;
      expect(h.active).toBe(true);
      expect(h.bridge_base_url).toBe("http://127.0.0.1:4632");
      expect(h.shared).toEqual(["alpha"]);
      const servers = h.servers as Record<string, unknown>;
      expect(servers.alpha).toBeDefined();
    } finally {
      await plugin.stop();
    }
  });

  it("stop() tears down all servers and handlers", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({ webEnabled: true, shared: ["alpha"] }),
    });

    await plugin.start();

    expect(plugin.isActive()).toBe(true);
    expect(getHttpGateway().hasMcpHandler("alpha")).toBe(true);

    await plugin.stop();
    expect(plugin.isActive()).toBe(false);
    expect(getHttpGateway().hasMcpHandler("alpha")).toBe(false);
    expect(plugin.sharedServerNames()).toEqual([]);
  });

  describe("health probe (filed in response to Nibbler review on #64)", () => {
    it("emits a degradation log + audit event when a shared server transitions to crashed", async () => {
      const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
      const plugin = new McpMultiplexerPlugin({
        configPath: cfgPath,
        settingsView: makeSettingsView({
          webEnabled: true,
          shared: ["alpha"],
          // Probe stays disabled — we drive sampling synchronously via the
          // test seam to avoid timer flakiness.
          healthProbeIntervalMs: 0,
        }),
      });

      await plugin.start();
      expect(plugin.isActive()).toBe(true);

      // Seed the baseline so the first sample is meaningful even though
      // the probe wasn't started by the plugin (probe disabled in tests).
      const proc = (
        plugin as unknown as {
          servers: Map<string, { status: string }>;
          lastObservedStatus: Map<string, string>;
        }
      ).servers.get("alpha")!;
      (
        plugin as unknown as {
          lastObservedStatus: Map<string, string>;
        }
      ).lastObservedStatus.set("alpha", proc.status);

      // Force a transition: simulate the upstream child crashing.
      const initial = proc.status;
      (proc as { status: string }).status = "crashed";

      // Capture audit events.
      const audited: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const origAudit = getMcpBridge().audit.bind(getMcpBridge());
      getMcpBridge().audit = (event: string, payload: Record<string, unknown>) => {
        audited.push({ event, payload });
        origAudit(event, payload);
      };

      try {
        (plugin as unknown as { _sampleHealthForTests: () => void })._sampleHealthForTests();
      } finally {
        getMcpBridge().audit = origAudit;
      }

      const degradationEvent = audited.find((e) => e.event === "mcp_health_degraded");
      expect(degradationEvent).toBeDefined();
      expect(degradationEvent?.payload.server).toBe("alpha");
      expect(degradationEvent?.payload.previous_status).toBe(initial);
      expect(degradationEvent?.payload.current_status).toBe("crashed");

      await plugin.stop();
    });

    it("does not emit duplicate events when status is stable across samples", async () => {
      const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
      const plugin = new McpMultiplexerPlugin({
        configPath: cfgPath,
        settingsView: makeSettingsView({
          webEnabled: true,
          shared: ["alpha"],
          healthProbeIntervalMs: 0,
        }),
      });
      await plugin.start();

      const proc = (
        plugin as unknown as {
          servers: Map<string, { status: string }>;
          lastObservedStatus: Map<string, string>;
        }
      ).servers.get("alpha")!;
      (
        plugin as unknown as {
          lastObservedStatus: Map<string, string>;
        }
      ).lastObservedStatus.set("alpha", proc.status);

      const audited: string[] = [];
      const origAudit = getMcpBridge().audit.bind(getMcpBridge());
      getMcpBridge().audit = (event: string, payload: Record<string, unknown>) => {
        audited.push(event);
        origAudit(event, payload);
      };

      try {
        (plugin as unknown as { _sampleHealthForTests: () => void })._sampleHealthForTests();
        (plugin as unknown as { _sampleHealthForTests: () => void })._sampleHealthForTests();
      } finally {
        getMcpBridge().audit = origAudit;
      }

      expect(
        audited.filter((e) => e === "mcp_health_degraded" || e === "mcp_health_transition"),
      ).toHaveLength(0);

      await plugin.stop();
    });
  });
});

// ── Session-map persistence (SPEC §4 + SPEC-DELTA-2026-05-16) ─────────────────
//
// These tests use an in-memory `FakeStore` that satisfies the structural
// shape of W1's `SessionPersistenceStore`. The plugin doesn't import the
// concrete class — it consumes the published interface and we inject the
// fake via `persistenceFactory`. Once W1 merges, these tests still pass
// against the real class because the contract is identical.

interface FakeRecord {
  serverName: string;
  ptyId: string;
  sessionId: string;
  issuedAt: number;
  lastUsedAt: number;
}

class FakeStore {
  records = new Map<string, FakeRecord>(); // key = `${serverName}::${ptyId}`
  calls: Array<{ op: string; serverName: string; ptyId?: string; sessionId?: string }> = [];
  gcCalls = 0;
  maxAgeMs: number;
  seedRecords: FakeRecord[] = [];

  constructor(opts: { maxAgeMs?: number } = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 3_600_000;
  }

  // Test helper: pre-populate records before start() runs replay.
  seed(records: FakeRecord[]): void {
    for (const r of records) {
      this.seedRecords.push(r);
      this.records.set(`${r.serverName}::${r.ptyId}`, { ...r });
    }
  }

  async record(serverName: string, ptyId: string, sessionId: string): Promise<void> {
    this.calls.push({ op: "record", serverName, ptyId, sessionId });
    const now = Date.now();
    const existing = this.records.get(`${serverName}::${ptyId}`);
    this.records.set(`${serverName}::${ptyId}`, {
      serverName,
      ptyId,
      sessionId,
      issuedAt: existing?.issuedAt ?? now,
      lastUsedAt: now,
    });
  }

  async drop(serverName: string, ptyId: string): Promise<void> {
    this.calls.push({ op: "drop", serverName, ptyId });
    this.records.delete(`${serverName}::${ptyId}`);
  }

  async touch(serverName: string, ptyId: string): Promise<void> {
    this.calls.push({ op: "touch", serverName, ptyId });
    const r = this.records.get(`${serverName}::${ptyId}`);
    if (r) r.lastUsedAt = Date.now();
  }

  async loadAll(serverName: string): Promise<FakeRecord[]> {
    return [...this.records.values()].filter((r) => r.serverName === serverName);
  }

  async garbageCollect(): Promise<{ scanned: number; kept: number; dropped: number }> {
    this.gcCalls += 1;
    const now = Date.now();
    let scanned = 0;
    let dropped = 0;
    for (const [key, r] of this.records) {
      scanned += 1;
      if (now - r.issuedAt > this.maxAgeMs) {
        this.records.delete(key);
        dropped += 1;
      }
    }
    return { scanned, kept: this.records.size, dropped };
  }
}

describe("McpMultiplexerPlugin — session persistence wiring", () => {
  it("backward compat: sessionPersistenceEnabled=false skips store construction", async () => {
    // The factory must NEVER be called when the operator has disabled
    // persistence (kill-switch). Behaviour is byte-identical to PR #71.
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    let factoryCalls = 0;
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: false,
      }),
      persistenceFactory: () => {
        factoryCalls += 1;
        return new FakeStore() as unknown as ReturnType<NonNullable<unknown>>;
      },
      gcTickMs: 0,
    });

    await plugin.start();
    try {
      expect(plugin.isActive()).toBe(true);
      expect(factoryCalls).toBe(0);
    } finally {
      await plugin.stop();
    }
  });

  it("replay on start() with empty store: no audit events, no buckets", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const store = new FakeStore();
    const audited: string[] = [];
    const origAudit = getMcpBridge().audit.bind(getMcpBridge());
    getMcpBridge().audit = (event: string, payload: Record<string, unknown>) => {
      audited.push(event);
      origAudit(event, payload);
    };

    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
      }),
      persistenceFactory: () => store as unknown as never,
      gcTickMs: 0,
    });

    try {
      await plugin.start();
      expect(plugin.isActive()).toBe(true);
      const replayEvents = audited.filter(
        (e) =>
          e === "mcp_session_resume_attempted" ||
          e === "mcp_session_resumed" ||
          e === "mcp_session_lost_on_restart",
      );
      expect(replayEvents).toHaveLength(0);
    } finally {
      getMcpBridge().audit = origAudit;
      await plugin.stop();
    }
  });

  it("replay on start() with persisted state installs buckets + emits audit", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const store = new FakeStore();
    const now = Date.now();
    store.seed([
      {
        serverName: "alpha",
        ptyId: "suzy",
        sessionId: "sess-1",
        issuedAt: now - 1000,
        lastUsedAt: now - 500,
      },
      {
        serverName: "alpha",
        ptyId: "bob",
        sessionId: "sess-2",
        issuedAt: now - 2000,
        lastUsedAt: now - 1500,
      },
    ]);

    const audited: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const origAudit = getMcpBridge().audit.bind(getMcpBridge());
    getMcpBridge().audit = (event: string, payload: Record<string, unknown>) => {
      audited.push({ event, payload });
      origAudit(event, payload);
    };

    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
      }),
      persistenceFactory: () => store as unknown as never,
      gcTickMs: 0,
    });

    try {
      await plugin.start();
      const resumed = audited.filter((a) => a.event === "mcp_session_resumed");
      expect(resumed).toHaveLength(2);
      const ptyIds = resumed.map((r) => r.payload.pty_id).sort();
      expect(ptyIds).toEqual(["bob", "suzy"]);

      const attempted = audited.filter((a) => a.event === "mcp_session_resume_attempted");
      expect(attempted).toHaveLength(2);

      // Buckets are now installed on the handler.
      const handler = plugin._getHandler("alpha");
      const health = handler?.health() as { bucket_keys: string[] };
      expect(health.bucket_keys.sort()).toEqual(["bob", "suzy"]);
    } finally {
      getMcpBridge().audit = origAudit;
      await plugin.stop();
    }
  });

  it("GC tick runs garbageCollect on the store", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const store = new FakeStore({ maxAgeMs: 1 }); // tiny window so seed records are stale
    store.seed([
      {
        serverName: "alpha",
        ptyId: "old",
        sessionId: "sess-old",
        issuedAt: Date.now() - 10_000,
        lastUsedAt: Date.now() - 10_000,
      },
    ]);

    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
      }),
      persistenceFactory: () => store as unknown as never,
      gcTickMs: 0, // disable automatic tick; we drive it via the test seam
    });

    try {
      await plugin.start();
      expect(store.gcCalls).toBe(0);
      await (plugin as unknown as { _runGCTickForTests: () => Promise<void> })._runGCTickForTests();
      expect(store.gcCalls).toBe(1);
      // The stale seed record was evicted by the store.
      expect(store.records.size).toBe(0);
    } finally {
      await plugin.stop();
    }
  });

  it("releaseIdentity drops the persisted record", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const store = new FakeStore();
    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
      }),
      persistenceFactory: () => store as unknown as never,
      gcTickMs: 0,
    });

    try {
      await plugin.start();
      // Seed a record as if a bucket had already been initialised for "suzy".
      await store.record("alpha", "suzy", "sess-suzy");
      expect(store.records.has("alpha::suzy")).toBe(true);

      await plugin.releaseIdentity("suzy");
      expect(store.records.has("alpha::suzy")).toBe(false);
      expect(store.calls.some((c) => c.op === "drop" && c.ptyId === "suzy")).toBe(true);
    } finally {
      await plugin.stop();
    }
  });

  // Codex PR #78 P1 regression — production calls
  // `getMcpMultiplexerPlugin()` with NO options, so `persistenceFactory`
  // is undefined. Pre-fix, this short-circuited persistence activation
  // and the feature was silently dead. The fix defaults to constructing
  // a real SessionPersistenceStore when no factory is provided.
  it("activates persistence in production wiring (no factory injected)", async () => {
    const cfgPath = writeProxyConfig(tmpDir, ["alpha"]);
    const storageRoot = join(tmpDir, "default-store-root");

    const plugin = new McpMultiplexerPlugin({
      configPath: cfgPath,
      // INTENTIONALLY no persistenceFactory — simulates production
      // wiring at `commands/start.ts` calling `getMcpMultiplexerPlugin()`
      // with no options.
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
        sessionPersistencePath: storageRoot,
        sessionMaxAgeSeconds: 3600,
      }),
    });

    await plugin.start();

    try {
      expect(plugin.isActive()).toBe(true);
      // The store should have been constructed and assigned. Use a
      // test-seam getter; alternatively assert by behavioural side
      // effect — the storage root dir gets created lazily on first
      // mutation, so issue a fake bucket-record flow.
      const persistence = (
        plugin as unknown as {
          persistence: { record: (...a: unknown[]) => Promise<void> } | null;
        }
      ).persistence;
      expect(persistence).not.toBeNull();
      // Smoke test: the real store accepts a record without throwing.
      await persistence!.record("alpha", "suzy", "sess-default");
      // File should now exist under storageRoot.
      expect(existsSync(join(storageRoot, "alpha.json"))).toBe(true);
    } finally {
      await plugin.stop();
    }
  });
});
