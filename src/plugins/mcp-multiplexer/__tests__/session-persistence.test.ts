import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPersistenceStore, type PersistedSessionRecord } from "../session-persistence.js";
import { _resetMcpBridge, _setMcpBridge, PluginMcpBridge } from "../../mcp-bridge.js";

// ── Test scaffolding ─────────────────────────────────────────────────────────

interface AuditEvent {
  event: string;
  payload: Record<string, unknown>;
}

/** Captures audit events for assertion. */
class CapturingBridge extends PluginMcpBridge {
  public events: AuditEvent[] = [];
  override audit(event: string, payload: Record<string, unknown>): void {
    this.events.push({ event, payload });
  }
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mcp-session-persistence-test-"));
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("SessionPersistenceStore", () => {
  let tmpRoot: string;
  let storageRoot: string;
  let bridge: CapturingBridge;
  let store: SessionPersistenceStore;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    storageRoot = join(tmpRoot, "mcp-sessions");
    _resetMcpBridge();
    bridge = new CapturingBridge(join(tmpRoot, "audit.jsonl"));
    _setMcpBridge(bridge);
    store = new SessionPersistenceStore({ storageRoot });
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    _resetMcpBridge();
  });

  // ── 1. round-trip ─────────────────────────────────────────────────────

  it("record + loadAll round-trips a single entry", async () => {
    await store.record("graphiti", "suzy", "sess-abc-123");
    const records = await store.loadAll("graphiti");

    expect(records).toHaveLength(1);
    const [r] = records;
    expect(r.serverName).toBe("graphiti");
    expect(r.ptyId).toBe("suzy");
    expect(r.sessionId).toBe("sess-abc-123");
    expect(typeof r.issuedAt).toBe("number");
    expect(typeof r.lastUsedAt).toBe("number");
    expect(typeof r.hash).toBe("string");
    expect(r.hash.length).toBe(64); // sha256 hex
  });

  // ── 2. record replaces existing ───────────────────────────────────────

  it("record replaces an existing entry for the same (server, pty)", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store.record("graphiti", "suzy", "sess-B");

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBe("sess-B");
  });

  // ── 3. drop removes entry ─────────────────────────────────────────────

  it("drop removes the entry", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store.drop("graphiti", "suzy");

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);
  });

  // ── 4. drop is idempotent ─────────────────────────────────────────────

  it("drop on a non-existent entry does not throw", async () => {
    await expect(store.drop("graphiti", "nobody")).resolves.toBeUndefined();
  });

  it("drop on a missing server file does not throw", async () => {
    await expect(store.drop("never-existed", "ghost")).resolves.toBeUndefined();
  });

  // ── 5. touch bumps lastUsedAt ─────────────────────────────────────────

  it("touch bumps lastUsedAt", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const before = (await store.loadAll("graphiti"))[0].lastUsedAt;

    // small wait so the clock moves
    await new Promise((r) => setTimeout(r, 5));
    await store.touch("graphiti", "suzy");

    const after = (await store.loadAll("graphiti"))[0].lastUsedAt;
    expect(after).toBeGreaterThan(before);
  });

  it("touch on a missing entry is a no-op", async () => {
    await expect(store.touch("graphiti", "ghost")).resolves.toBeUndefined();
    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);
  });

  // ── 6. TTL drops expired entries on load ──────────────────────────────

  it("loadAll drops entries past maxAgeMs and rewrites the file without them", async () => {
    // maxAgeMs: 1 → anything older than 1ms is expired
    const shortLivedStore = new SessionPersistenceStore({
      storageRoot,
      maxAgeMs: 1,
    });

    await shortLivedStore.record("graphiti", "suzy", "sess-A");
    // Sleep past the TTL.
    await new Promise((r) => setTimeout(r, 10));

    const records = await shortLivedStore.loadAll("graphiti");
    expect(records).toHaveLength(0);

    // Audit fired for the dropped entry.
    const dropAudits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "ttl_expired",
    );
    expect(dropAudits).toHaveLength(1);
    expect(dropAudits[0].payload.ptyId).toBe("suzy");

    // File rewritten without the entry — fresh loadAll returns 0 with no extra audits.
    const beforeCount = bridge.events.length;
    const second = await shortLivedStore.loadAll("graphiti");
    expect(second).toHaveLength(0);
    // No new "lost_on_restart" audits — entry was already pruned.
    const newDropAudits = bridge.events
      .slice(beforeCount)
      .filter((e) => e.event === "mcp_session_lost_on_restart");
    expect(newDropAudits).toHaveLength(0);
  });

  // ── 7. integrity check rejects mutated hash ───────────────────────────

  it("loadAll drops entries with a tampered integrity hash", async () => {
    await store.record("graphiti", "suzy", "sess-A");

    // Tamper with the on-disk file.
    const filePath = join(storageRoot, "graphiti.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    parsed.entries[0].hash = "0".repeat(64);
    writeFileSync(filePath, JSON.stringify(parsed));

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);

    const integrityAudits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "integrity_failed",
    );
    expect(integrityAudits).toHaveLength(1);
  });

  it("loadAll drops entries whose serverName field doesn't match the file", async () => {
    await store.record("graphiti", "suzy", "sess-A");

    const filePath = join(storageRoot, "graphiti.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    parsed.entries[0].serverName = "mempress"; // mismatch
    writeFileSync(filePath, JSON.stringify(parsed));

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);
    const audits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "integrity_failed",
    );
    expect(audits).toHaveLength(1);
  });

  // ── 8. version mismatch drops file ────────────────────────────────────

  it("loadAll on a future-version file returns empty + audits version_mismatch", async () => {
    // Seed an entry so the directory exists.
    await store.record("graphiti", "suzy", "sess-A");
    const filePath = join(storageRoot, "graphiti.json");
    writeFileSync(filePath, JSON.stringify({ version: 999, serverName: "graphiti", entries: [] }));

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);

    const versionAudits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "version_mismatch",
    );
    expect(versionAudits).toHaveLength(1);

    // File deleted — subsequent loadAll returns empty with no new audit.
    const before = bridge.events.length;
    const second = await store.loadAll("graphiti");
    expect(second).toHaveLength(0);
    const newAudits = bridge.events.slice(before);
    expect(newAudits.filter((e) => e.event === "mcp_session_lost_on_restart")).toHaveLength(0);
  });

  // ── 9. file corruption returns empty, audits, no throw ────────────────

  it("loadAll on a malformed-JSON file returns empty + audits file_corrupt", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const filePath = join(storageRoot, "graphiti.json");
    writeFileSync(filePath, "this is not json {]");

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);

    const corruptAudits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "file_corrupt",
    );
    expect(corruptAudits).toHaveLength(1);
  });

  it("loadAll on a non-object JSON file returns empty + audits file_corrupt", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const filePath = join(storageRoot, "graphiti.json");
    writeFileSync(filePath, '"just a string"');

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);
    const audits = bridge.events.filter(
      (e) => e.event === "mcp_session_lost_on_restart" && e.payload.reason === "file_corrupt",
    );
    expect(audits).toHaveLength(1);
  });

  // ── 10. GC removes expired across multiple servers ────────────────────

  it("garbageCollect prunes expired entries across all server files", async () => {
    const gcStore = new SessionPersistenceStore({
      storageRoot,
      maxAgeMs: 1,
    });

    await gcStore.record("graphiti", "suzy", "sess-A");
    await gcStore.record("graphiti", "tim", "sess-B");
    await gcStore.record("mempress", "global", "sess-C");

    // Sleep past TTL.
    await new Promise((r) => setTimeout(r, 10));

    const result = await gcStore.garbageCollect();
    expect(result.scanned).toBe(3);
    expect(result.kept).toBe(0);
    expect(result.dropped).toBe(3);

    // Loading after GC returns nothing.
    expect(await gcStore.loadAll("graphiti")).toHaveLength(0);
    expect(await gcStore.loadAll("mempress")).toHaveLength(0);

    // Audit fired for the tick.
    const gcAudits = bridge.events.filter((e) => e.event === "mcp_session_gc");
    expect(gcAudits).toHaveLength(1);
    expect(gcAudits[0].payload).toMatchObject({ scanned: 3, kept: 0, dropped: 3 });
  });

  it("garbageCollect keeps fresh entries and drops expired ones in the same sweep", async () => {
    // Fresh store with a long TTL, write one entry, then back-date it on disk.
    await store.record("graphiti", "suzy", "fresh-session");
    await store.record("graphiti", "tim", "stale-session");

    const filePath = join(storageRoot, "graphiti.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      serverName: string;
      entries: PersistedSessionRecord[];
    };
    // Back-date "tim" to well over the default 1h TTL.
    const stale = parsed.entries.find((e) => e.ptyId === "tim");
    if (!stale) throw new Error("expected tim entry");
    stale.issuedAt = Date.now() - 10 * 60 * 60 * 1000; // 10 hours ago
    writeFileSync(filePath, JSON.stringify(parsed));

    const result = await store.garbageCollect();
    expect(result.scanned).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.dropped).toBe(1);

    const remaining = await store.loadAll("graphiti");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ptyId).toBe("suzy");
  });

  it("garbageCollect on an empty directory returns zero counts", async () => {
    const result = await store.garbageCollect();
    expect(result).toEqual({ scanned: 0, kept: 0, dropped: 0 });
  });

  // ── 11. concurrent writes don't corrupt the file ──────────────────────

  it("concurrent record() calls to the same server are serialized correctly", async () => {
    await Promise.all([
      store.record("graphiti", "suzy", "sess-1"),
      store.record("graphiti", "tim", "sess-2"),
      store.record("graphiti", "bob", "sess-3"),
    ]);

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(3);
    const ids = records.map((r) => r.ptyId).sort();
    expect(ids).toEqual(["bob", "suzy", "tim"]);
  });

  it("concurrent record + drop interleave safely", async () => {
    await store.record("graphiti", "suzy", "sess-A");

    await Promise.all([
      store.record("graphiti", "tim", "sess-B"),
      store.drop("graphiti", "suzy"),
      store.record("graphiti", "bob", "sess-C"),
    ]);

    const records = await store.loadAll("graphiti");
    const ids = records.map((r) => r.ptyId).sort();
    expect(ids).toEqual(["bob", "tim"]);
  });

  // ── 12. file & dir permission modes ───────────────────────────────────

  it("the server file is created with mode 0600", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const filePath = join(storageRoot, "graphiti.json");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("the storage root is created with mode 0700", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const mode = statSync(storageRoot).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  // ── 13. audit events fire on the expected operations ─────────────────

  it("record() fires mcp_session_persisted", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    const persisted = bridge.events.filter((e) => e.event === "mcp_session_persisted");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].payload).toMatchObject({
      server: "graphiti",
      ptyId: "suzy",
      sessionId: "sess-A",
    });
    expect(typeof persisted[0].payload.issuedAt).toBe("number");
  });

  it("drop() fires mcp_session_dropped only when it removed something", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    bridge.events = [];
    await store.drop("graphiti", "suzy");
    await store.drop("graphiti", "suzy"); // second drop is no-op

    const dropped = bridge.events.filter((e) => e.event === "mcp_session_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].payload).toMatchObject({
      server: "graphiti",
      ptyId: "suzy",
      reason: "explicit",
    });
  });

  it("loadAll() fires mcp_session_loaded per surviving record", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store.record("graphiti", "tim", "sess-B");
    bridge.events = [];

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(2);

    const loaded = bridge.events.filter((e) => e.event === "mcp_session_loaded");
    expect(loaded).toHaveLength(2);
    const audited = loaded.map((e) => e.payload.ptyId).sort();
    expect(audited).toEqual(["suzy", "tim"]);
  });

  // ── 14. validation ────────────────────────────────────────────────────

  it("record() rejects invalid serverName", async () => {
    await expect(store.record("../etc", "suzy", "sess-A")).rejects.toThrow();
    await expect(store.record("", "suzy", "sess-A")).rejects.toThrow();
  });

  it("record() rejects invalid ptyId", async () => {
    await expect(store.record("graphiti", "../bad", "sess-A")).rejects.toThrow();
    await expect(store.record("graphiti", "", "sess-A")).rejects.toThrow();
  });

  it("record() rejects empty sessionId", async () => {
    await expect(store.record("graphiti", "suzy", "")).rejects.toThrow();
  });

  // ── 15. test seam: reset clears all state ────────────────────────────

  it("_resetForTests clears the storage directory", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store._resetForTests();

    const records = await store.loadAll("graphiti");
    expect(records).toHaveLength(0);
  });

  // ── 16. cross-server isolation ───────────────────────────────────────

  it("entries for one server are isolated from another", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store.record("mempress", "suzy", "sess-B");

    const a = await store.loadAll("graphiti");
    const b = await store.loadAll("mempress");
    expect(a).toHaveLength(1);
    expect(a[0].sessionId).toBe("sess-A");
    expect(b).toHaveLength(1);
    expect(b[0].sessionId).toBe("sess-B");
  });

  it("dropping from one server doesn't affect another", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    await store.record("mempress", "suzy", "sess-B");
    await store.drop("graphiti", "suzy");

    expect(await store.loadAll("graphiti")).toHaveLength(0);
    expect(await store.loadAll("mempress")).toHaveLength(1);
  });

  // Codex PR #78 P2 regression — a rejected mutation in the write queue
  // must NOT brick subsequent mutations for that server. Pre-fix, a
  // transient filesystem error would poison the chain and every
  // subsequent record/drop/touch for that server would reject without
  // running its mutator.
  it("write queue self-heals after a rejected mutation", async () => {
    await store.record("graphiti", "suzy", "sess-A");
    expect(await store.loadAll("graphiti")).toHaveLength(1);

    // Force a single mutation to fail by patching the atomic-write path
    // to throw once. We can't easily monkey-patch a private method, so
    // simulate via a synthetic mutator that throws — same shape since
    // the `_mutate` wrapper handles both the I/O reject AND a mutator
    // reject the same way.
    const originalRecord = store.record.bind(store);
    let injected = false;
    // @ts-expect-error — test-only monkey-patch
    store.record = async (server: string, pty: string, sid: string) => {
      if (!injected && server === "graphiti") {
        injected = true;
        // Manually push a rejecting mutation through the queue.
        const fakeRejection = Promise.reject(new Error("simulated FS error"));
        // @ts-expect-error — test-only access to private field
        const prev = store.writeQueue.get("graphiti") ?? Promise.resolve();
        // @ts-expect-error — test-only access to private field
        store.writeQueue.set(
          "graphiti",
          prev.then(() => fakeRejection),
        );
        try {
          // @ts-expect-error — await the rejection so subsequent calls
          // see a poisoned chain (without the fix).
          await store.writeQueue.get("graphiti");
        } catch {}
      }
      return originalRecord(server, pty, sid);
    };

    // First call: triggers the injected rejection. With the P2 fix, the
    // subsequent record() still succeeds.
    await store.record("graphiti", "reg", "sess-B");

    // Verify the second record's mutation actually landed on disk.
    const entries = await store.loadAll("graphiti");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.ptyId === "reg" && e.sessionId === "sess-B")).toBe(true);
  });
});
