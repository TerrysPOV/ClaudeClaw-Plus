/**
 * Phase C wire-level integration tests for MCP session persistence.
 *
 * Phase B unit tests stubbed the persistence boundary (in-memory `FakeStore`)
 * and the upstream MCP child (mocked transports). This file proves the
 * full wire end-to-end:
 *
 *   - real `SessionPersistenceStore` writing JSON files to a tmpdir,
 *   - real `McpMultiplexerPlugin` instantiating the store via factory,
 *   - real `McpHttpHandler` recording/dropping/touching the store on
 *     real `WebStandardStreamableHTTPServerTransport` events,
 *   - real upstream MCP stdio child (fixture) proxied through,
 *   - real daemon stop → start cycle exercising replay end-to-end.
 *
 * Scenarios (per Phase C scope, SPEC §4.4–4.5, SPEC-DELTA-2026-05-16):
 *   1. End-to-end round-trip + replay reinstalls the bucket with the
 *      original sessionId.
 *   2. TTL expiration on replay (record outside maxAgeMs).
 *   3. Integrity check on replay (tampered hash).
 *   4. File corruption on replay (garbage JSON).
 *   5. GC tick at runtime drops expired entries, leaves live buckets.
 *   6. Backward compat: `sessionPersistenceEnabled: false` writes no
 *      files, fires no persistence audits.
 *   7. Stateless server is never persisted.
 *
 * Hermetic: every test uses a tmpdir-scoped `mcp-proxy.json` AND a
 * tmpdir-scoped persistence root. Gateway binds to port 0. All children,
 * listeners, and singletons reset in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { _resetHttpGateway, getHttpGateway } from "../plugins/http-gateway.js";
import { _resetMcpBridge, getMcpBridge } from "../plugins/mcp-bridge.js";
import {
  _resetMcpMultiplexer,
  McpMultiplexerPlugin,
  type MuxSettingsView,
} from "../plugins/mcp-multiplexer/index.js";
import { _resetIdentityStore } from "../plugins/mcp-multiplexer/pty-identity.js";
import { SessionPersistenceStore } from "../plugins/mcp-multiplexer/session-persistence.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeProxyConfig(dir: string, names: string[]): string {
  const cfg = {
    servers: Object.fromEntries(
      names.map((name) => [
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
    healthProbeIntervalMs: 0,
    sessionPersistenceEnabled: true,
    sessionMaxAgeSeconds: 3600,
    sessionPersistencePath: "",
    ...partial,
  };
  return () => view;
}

/** Real factory — constructs an actual `SessionPersistenceStore`. */
function makePersistenceFactory(): (opts: {
  storageRoot: string;
  maxAgeMs: number;
}) => SessionPersistenceStore {
  return ({ storageRoot, maxAgeMs }) => new SessionPersistenceStore({ storageRoot, maxAgeMs });
}

/** Ephemeral loopback gateway that routes `/mcp/*` and `/api/plugin/*`. */
function startTestGateway(): {
  origin: string;
  port: number;
  stop: () => Promise<void>;
} {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/plugin/") || url.pathname.startsWith("/mcp/")) {
        const resp = await getHttpGateway().handleRequest(req, url);
        if (resp !== null) return resp;
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function connectClient(opts: {
  origin: string;
  server: string;
  ptyId: string;
  bearer: string;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${opts.origin}/mcp/${opts.server}`),
    {
      requestInit: {
        headers: {
          Authorization: opts.bearer,
          "X-Claudeclaw-Pty-Id": opts.ptyId,
        },
      },
    },
  );
  const client = new Client(
    { name: `test-client/${opts.ptyId}`, version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {}
    },
  };
}

/** Capture every audit event the bridge sees for the duration of `fn`. */
type AuditEvent = { event: string; payload: Record<string, unknown> };
async function withAudit<T>(fn: (events: AuditEvent[]) => Promise<T>): Promise<T> {
  const events: AuditEvent[] = [];
  const bridge = getMcpBridge();
  const orig = bridge.audit.bind(bridge);
  bridge.audit = (event, payload) => {
    events.push({ event, payload });
    orig(event, payload);
  };
  try {
    return await fn(events);
  } finally {
    bridge.audit = orig;
  }
}

/** Compute the same integrity hash the store uses. */
function hashFor(serverName: string, ptyId: string, sessionId: string): string {
  return createHash("sha256").update(`${serverName}:${ptyId}:${sessionId}`).digest("hex");
}

/** Read the persistence file for a server. Returns null on missing. */
function readPersistenceFile(
  persistRoot: string,
  serverName: string,
): {
  version: number;
  serverName: string;
  entries: Array<{
    serverName: string;
    ptyId: string;
    sessionId: string;
    issuedAt: number;
    lastUsedAt: number;
    hash: string;
  }>;
} | null {
  const path = join(persistRoot, `${serverName}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Wait up to `timeoutMs` for `events` to contain `event`. Polls inline. */
async function waitForAudit(
  events: AuditEvent[],
  event: string,
  timeoutMs = 2000,
): Promise<AuditEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = events.find((e) => e.event === event);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `timed out waiting for audit '${event}' (saw: ${[...new Set(events.map((e) => e.event))].join(", ")})`,
  );
}

// ── Suite plumbing ──────────────────────────────────────────────────────────

let tmpDir: string;
let persistRoot: string;
let plugin: McpMultiplexerPlugin | null = null;
let gateway: { origin: string; port: number; stop: () => Promise<void> } | null = null;

async function teardown(): Promise<void> {
  if (plugin) {
    try {
      await plugin.stop();
    } catch {}
    plugin = null;
  }
  if (gateway) {
    try {
      await gateway.stop();
    } catch {}
    gateway = null;
  }
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-persist-itest-"));
  persistRoot = join(tmpDir, "sessions");
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
});

afterEach(async () => {
  await teardown();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── 1) End-to-end persistence round-trip with replay ────────────────────────

describe("session-persistence integration — round-trip + replay", () => {
  it("records sessionId on initialize, replays it on a fresh daemon, bucket reuses the SAME sessionId", {
    timeout: 15000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);

    // ── Daemon #1: drive a real client, force persistence write. ──
    let recordedSessionId: string | undefined;

    await withAudit(async (ev) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha"],
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });
      await plugin.start();
      gateway = startTestGateway();

      const ident = plugin.issueIdentity("pty-roundtrip");
      const conn = await connectClient({
        origin: gateway.origin,
        server: "alpha",
        ptyId: "pty-roundtrip",
        bearer: ident.headers.Authorization,
      });
      try {
        // First real-tool roundtrip — proves upstream is wired AND
        // forces `onsessioninitialized` to fire.
        const result = await conn.client.callTool({
          name: "echo",
          arguments: { message: "round-trip" },
        });
        const content = (result.content as Array<{ text: string }>)[0];
        expect(content?.text).toContain("round-trip");
      } finally {
        await conn.close();
      }

      // Wait for the fire-and-forget `record()` to land on disk.
      const persisted = await waitForAudit(ev, "mcp_session_persisted");
      expect(persisted.payload.server).toBe("alpha");
      expect(persisted.payload.ptyId).toBe("pty-roundtrip");
      recordedSessionId = persisted.payload.sessionId as string;
      expect(recordedSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    });

    // File on disk now contains the record.
    const file1 = readPersistenceFile(persistRoot, "alpha");
    expect(file1).not.toBeNull();
    expect(file1?.entries).toHaveLength(1);
    expect(file1?.entries[0]?.ptyId).toBe("pty-roundtrip");
    expect(file1?.entries[0]?.sessionId).toBe(recordedSessionId!);
    expect(file1?.entries[0]?.hash).toBe(hashFor("alpha", "pty-roundtrip", recordedSessionId!));

    // ── Stop daemon #1. ──
    await plugin!.stop();
    await gateway!.stop();
    plugin = null;
    gateway = null;
    // Reset gateway/bridge/mux singletons but KEEP the identity store
    // (the operator-side ptyId is conceptually long-lived across
    // daemon restarts; the issued bearer in this test wouldn't survive
    // a real restart but we keep the identity entry so we can still
    // drive auth from the same test).
    _resetHttpGateway();
    _resetMcpBridge();
    _resetMcpMultiplexer();

    // ── Daemon #2: fresh plugin pointing at the SAME persist root. ──
    await withAudit(async (events2) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha"],
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });
      await plugin.start();

      // Replay should have fired `mcp_session_resume_attempted` +
      // `mcp_session_resumed` for the persisted entry.
      const attempted = events2.find((e) => e.event === "mcp_session_resume_attempted");
      expect(attempted).toBeDefined();
      expect(attempted?.payload.server).toBe("alpha");
      expect(attempted?.payload.pty_id).toBe("pty-roundtrip");
      expect(attempted?.payload.session_id).toBe(recordedSessionId);

      const resumed = events2.find((e) => e.event === "mcp_session_resumed");
      expect(resumed).toBeDefined();
      expect(resumed?.payload.pty_id).toBe("pty-roundtrip");
      expect(resumed?.payload.session_id).toBe(recordedSessionId);

      // Bucket installed under the original ptyId.
      const handler = plugin._getHandler("alpha");
      const h = handler?.health() as { bucket_keys: string[] };
      expect(h.bucket_keys).toEqual(["pty-roundtrip"]);

      // The SDK transport only sets `transport.sessionId` when its
      // generator fires on the FIRST request after install. Prior to
      // a request, the resumed bucket has the generator armed but
      // `sessionId` is still undefined (SPEC §4.5 design). Invoke the
      // generator to verify it produces the persisted UUID.
      type HandlerInternals = {
        buckets: Map<
          string,
          { transport: { sessionId?: string; sessionIdGenerator?: () => string } }
        >;
      };
      const bucket = (handler as unknown as HandlerInternals).buckets.get("pty-roundtrip");
      expect(bucket).toBeDefined();
      const generated = bucket?.transport.sessionIdGenerator?.();
      expect(generated).toBe(recordedSessionId);
    });
  });
});

// ── 2) TTL expiration on replay ─────────────────────────────────────────────

describe("session-persistence integration — TTL expiration on replay", () => {
  it("record with stale issuedAt is dropped on load, audited as ttl_expired, file rewritten without it", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);

    // Pre-seed the persistence file with an expired entry by writing
    // the file directly. SessionPersistenceStore reads the same
    // format; the multiplexer will load it via `loadAll()` on
    // start(), which is where TTL eviction fires.
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const ptyId = "pty-stale";
    const expiredIssuedAt = Date.now() - 7200_000; // 2h ago
    const entry = {
      serverName: "alpha",
      ptyId,
      sessionId,
      issuedAt: expiredIssuedAt,
      lastUsedAt: expiredIssuedAt,
      hash: hashFor("alpha", ptyId, sessionId),
    };

    // Use the store itself to create the file with the correct shape
    // and permissions, then overwrite with the stale entry.
    const seedStore = new SessionPersistenceStore({
      storageRoot: persistRoot,
      maxAgeMs: 3600_000,
    });
    // Record a fresh entry so the dir + file get created with the
    // right perms, then overwrite with the stale entry.
    await seedStore.record("alpha", ptyId, sessionId);
    writeFileSync(
      join(persistRoot, "alpha.json"),
      JSON.stringify({ version: 1, serverName: "alpha", entries: [entry] }),
    );

    await withAudit(async (events) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha"],
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
          sessionMaxAgeSeconds: 3600, // 1h — entry is 2h old, expired
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });
      await plugin.start();

      const lost = events.find(
        (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "ttl_expired",
      );
      expect(lost).toBeDefined();
      expect(lost?.payload.ptyId).toBe(ptyId);

      // Replay did NOT install a bucket.
      const handler = plugin._getHandler("alpha");
      const h = handler?.health() as { bucket_keys: string[] };
      expect(h.bucket_keys).toEqual([]);

      // File on disk was rewritten without the expired entry.
      const file = readPersistenceFile(persistRoot, "alpha");
      expect(file?.entries).toHaveLength(0);
    });
  });
});

// ── 3) Integrity check on replay ────────────────────────────────────────────

describe("session-persistence integration — integrity check on replay", () => {
  it("record with tampered hash is dropped, audited as integrity_failed, replay installs no bucket", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);

    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ptyId = "pty-tampered";
    const now = Date.now();
    const tampered = {
      serverName: "alpha",
      ptyId,
      sessionId,
      issuedAt: now - 1000,
      lastUsedAt: now - 1000,
      hash: "0".repeat(64), // valid hex length, wrong value
    };

    // Seed a real file by recording, then overwrite with tampered.
    const seed = new SessionPersistenceStore({ storageRoot: persistRoot });
    await seed.record("alpha", ptyId, sessionId);
    writeFileSync(
      join(persistRoot, "alpha.json"),
      JSON.stringify({ version: 1, serverName: "alpha", entries: [tampered] }),
    );

    await withAudit(async (events) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha"],
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });
      await plugin.start();

      const lost = events.find(
        (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "integrity_failed",
      );
      expect(lost).toBeDefined();
      expect(lost?.payload.ptyId).toBe(ptyId);

      // Replay did NOT install a bucket.
      const handler = plugin._getHandler("alpha");
      const h = handler?.health() as { bucket_keys: string[] };
      expect(h.bucket_keys).toEqual([]);

      // Replay-attempted should NOT fire — the loadAll() filter
      // already dropped the entry before the plugin saw it.
      const attempted = events.find((e) => e.event === "mcp_session_resume_attempted");
      expect(attempted).toBeUndefined();
    });
  });
});

// ── 4) File corruption on replay ────────────────────────────────────────────

describe("session-persistence integration — file corruption on replay", () => {
  it("garbage JSON in one server's file is audited file_corrupt, plugin still starts, other servers unaffected", {
    timeout: 12000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha", "beta"]);

    // Pre-seed beta with a VALID record so we can prove its file
    // survives corruption of alpha's file.
    const seedBeta = new SessionPersistenceStore({ storageRoot: persistRoot });
    await seedBeta.record("beta", "pty-beta-clean", "deadbeef-0000-0000-0000-000000000000");

    // Trash alpha's file with raw garbage.
    const persistDir = persistRoot;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(persistDir, { recursive: true });
    writeFileSync(join(persistDir, "alpha.json"), "{not valid json at all");

    await withAudit(async (events) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha", "beta"],
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });

      // Plugin start MUST succeed despite the corrupt file.
      await plugin.start();
      expect(plugin.isActive()).toBe(true);

      const lost = events.find(
        (e) =>
          e.event === "mcp_session_lost_on_restart" &&
          e.payload.reason === "file_corrupt" &&
          e.payload.server === "alpha",
      );
      expect(lost).toBeDefined();

      // Beta's clean record replayed cleanly.
      const resumed = events.find(
        (e) => e.event === "mcp_session_resumed" && e.payload.server === "beta",
      );
      expect(resumed).toBeDefined();
      expect(resumed?.payload.pty_id).toBe("pty-beta-clean");

      // Beta's bucket installed; alpha has no buckets.
      const alphaH = plugin._getHandler("alpha")?.health() as { bucket_keys: string[] };
      const betaH = plugin._getHandler("beta")?.health() as { bucket_keys: string[] };
      expect(alphaH.bucket_keys).toEqual([]);
      expect(betaH.bucket_keys).toEqual(["pty-beta-clean"]);

      // Beta's file is intact.
      const betaFile = readPersistenceFile(persistRoot, "beta");
      expect(betaFile?.entries).toHaveLength(1);
    });
  });
});

// ── 5) GC tick at runtime ───────────────────────────────────────────────────

describe("session-persistence integration — runtime GC", () => {
  it("GC tick drops on-disk expired entries while leaving live in-memory buckets intact", {
    timeout: 12000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);

    // Daemon up, drive a live bucket, persist a fresh record.
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        shared: ["alpha"],
        sessionPersistenceEnabled: true,
        sessionPersistencePath: persistRoot,
        sessionMaxAgeSeconds: 3600,
      }),
      persistenceFactory: makePersistenceFactory(),
      gcTickMs: 0, // manual drive
    });

    await withAudit(async (events) => {
      await plugin!.start();
      gateway = startTestGateway();

      const ident = plugin!.issueIdentity("pty-live");
      const conn = await connectClient({
        origin: gateway.origin,
        server: "alpha",
        ptyId: "pty-live",
        bearer: ident.headers.Authorization,
      });
      try {
        await conn.client.callTool({ name: "echo", arguments: { message: "hi" } });
      } finally {
        await conn.close();
      }
      await waitForAudit(events, "mcp_session_persisted");

      // Manually append a second, EXPIRED entry to the same file.
      const file = readPersistenceFile(persistRoot, "alpha");
      expect(file?.entries).toHaveLength(1);
      const liveEntry = file!.entries[0]!;

      const stale = {
        serverName: "alpha",
        ptyId: "pty-stale",
        sessionId: "ffffffff-0000-0000-0000-000000000000",
        issuedAt: Date.now() - 7200_000, // 2h
        lastUsedAt: Date.now() - 7200_000,
        hash: hashFor("alpha", "pty-stale", "ffffffff-0000-0000-0000-000000000000"),
      };
      writeFileSync(
        join(persistRoot, "alpha.json"),
        JSON.stringify({
          version: 1,
          serverName: "alpha",
          entries: [liveEntry, stale],
        }),
      );

      // Sanity: file now has 2 entries.
      const before = readPersistenceFile(persistRoot, "alpha");
      expect(before?.entries).toHaveLength(2);

      // Drive a GC pass.
      await (plugin as unknown as { _runGCTickForTests: () => Promise<void> })._runGCTickForTests();

      // GC audit fired.
      const gcAudit = events.find((e) => e.event === "mcp_session_gc");
      expect(gcAudit).toBeDefined();
      expect(gcAudit?.payload.scanned).toBe(2);
      expect(gcAudit?.payload.kept).toBe(1);
      expect(gcAudit?.payload.dropped).toBe(1);

      // The stale entry was also audited individually.
      const lost = events.find(
        (e) =>
          e.event === "mcp_session_lost_on_restart" &&
          e.payload.reason === "ttl_expired" &&
          e.payload.ptyId === "pty-stale",
      );
      expect(lost).toBeDefined();

      // File now contains only the live entry.
      const after = readPersistenceFile(persistRoot, "alpha");
      expect(after?.entries).toHaveLength(1);
      expect(after?.entries[0]?.ptyId).toBe("pty-live");

      // Critical contract: the in-memory bucket for the LIVE pty
      // survived the GC sweep. GC is for on-disk hygiene, not
      // live-bucket teardown.
      const handler = plugin!._getHandler("alpha");
      const h = handler?.health() as { bucket_keys: string[] };
      expect(h.bucket_keys).toEqual(["pty-live"]);
    });
  });
});

// ── 6) Backward compat: sessionPersistenceEnabled: false ───────────────────

describe("session-persistence integration — kill-switch", () => {
  it("sessionPersistenceEnabled=false writes no files, fires no persistence audits, behaves like PR #71", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);

    let factoryCalls = 0;
    const wrappingFactory = (opts: { storageRoot: string; maxAgeMs: number }) => {
      factoryCalls += 1;
      return new SessionPersistenceStore(opts);
    };

    await withAudit(async (events) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha"],
          sessionPersistenceEnabled: false, // kill-switch
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: wrappingFactory,
        gcTickMs: 0,
      });
      await plugin.start();
      gateway = startTestGateway();
      expect(plugin.isActive()).toBe(true);

      // Drive a roundtrip to be sure no persistence side effects fire.
      const ident = plugin.issueIdentity("pty-killed");
      const conn = await connectClient({
        origin: gateway.origin,
        server: "alpha",
        ptyId: "pty-killed",
        bearer: ident.headers.Authorization,
      });
      try {
        await conn.client.callTool({ name: "echo", arguments: { message: "no persist" } });
      } finally {
        await conn.close();
      }

      // Give any straggling fire-and-forget callbacks a window to
      // misbehave; assert nothing fired.
      await new Promise((r) => setTimeout(r, 100));

      // Factory was never invoked.
      expect(factoryCalls).toBe(0);

      // No persistence audit events.
      const persistenceEvents = events.filter((e) =>
        [
          "mcp_session_persisted",
          "mcp_session_dropped",
          "mcp_session_loaded",
          "mcp_session_resumed",
          "mcp_session_resume_attempted",
          "mcp_session_gc",
          "mcp_session_lost_on_restart",
        ].includes(e.event),
      );
      expect(persistenceEvents).toEqual([]);

      // No file in the persistence root.
      expect(existsSync(join(persistRoot, "alpha.json"))).toBe(false);
    });
  });
});

// ── 7) Stateless server is not persisted ────────────────────────────────────

describe("session-persistence integration — stateless server skips persistence", () => {
  it("stateless server creates a collapsed bucket but never writes to disk", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha", "beta"]);

    await withAudit(async (events) => {
      plugin = new McpMultiplexerPlugin({
        configPath: cfg,
        settingsView: makeSettingsView({
          shared: ["alpha", "beta"],
          stateless: ["beta"], // beta is stateless → no persistence
          sessionPersistenceEnabled: true,
          sessionPersistencePath: persistRoot,
        }),
        persistenceFactory: makePersistenceFactory(),
        gcTickMs: 0,
      });
      await plugin.start();
      gateway = startTestGateway();

      const ident = plugin.issueIdentity("pty-s");
      const conn = await connectClient({
        origin: gateway.origin,
        server: "beta",
        ptyId: "pty-s",
        bearer: ident.headers.Authorization,
      });
      try {
        await conn.client.callTool({ name: "echo", arguments: { message: "stateless" } });
      } finally {
        await conn.close();
      }

      // Window for any fire-and-forget.
      await new Promise((r) => setTimeout(r, 100));

      // Beta bucket collapsed to the sentinel.
      const betaH = plugin._getHandler("beta")?.health() as {
        bucket_keys: string[];
        stateless: boolean;
      };
      expect(betaH.stateless).toBe(true);
      expect(betaH.bucket_keys).toEqual(["__stateless__"]);

      // No persistence file for beta.
      expect(existsSync(join(persistRoot, "beta.json"))).toBe(false);

      // No persistence audits scoped to beta.
      const betaPersist = events.filter(
        (e) =>
          (e.event === "mcp_session_persisted" || e.event === "mcp_session_dropped") &&
          e.payload.server === "beta",
      );
      expect(betaPersist).toEqual([]);

      // Sanity: replay step on next start would find nothing for beta
      // either. We confirm by reading the storage root directory.
      const files = existsSync(persistRoot) ? readdirSync(persistRoot) : [];
      expect(files).not.toContain("beta.json");
    });
  });
});
