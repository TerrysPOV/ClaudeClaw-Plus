/**
 * Bridge-side MCP session-persistence store.
 *
 * Persists `(serverName, ptyId, sessionId)` tuples across daemon restarts so the
 * multiplexer can attempt session resume on restart. Always-resume model — no
 * per-server "is this resumable?" gate (see SPEC-DELTA-2026-05-16.md).
 *
 * One JSON file per server: `${storageRoot}/${serverName}.json`. Atomic writes
 * via tmpfile + rename. SHA-256 hex integrity hash per entry. TTL eviction at
 * load time and on GC ticks.
 *
 * Audit events (via PluginMcpBridge.audit):
 *   - mcp_session_persisted        — on record()
 *   - mcp_session_dropped          — on drop()
 *   - mcp_session_loaded           — per record returned from loadAll()
 *   - mcp_session_lost_on_restart  — per record dropped during load (TTL,
 *                                    integrity, version, or corruption)
 *   - mcp_session_gc               — per GC tick (aggregate counts)
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getMcpBridge } from "../mcp-bridge.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** One persisted (server, pty) session record. */
export interface PersistedSessionRecord {
  serverName: string;
  ptyId: string;
  sessionId: string;
  /** Epoch ms — when the session was first minted. */
  issuedAt: number;
  /** Epoch ms — bumped on every touch(). */
  lastUsedAt: number;
  /** SHA-256 hex of `${serverName}:${ptyId}:${sessionId}`. */
  hash: string;
}

export interface SessionPersistenceStoreOpts {
  /**
   * Root directory for the JSON files. One file per server. Production default
   * is `~/.config/claudeclaw/mcp-sessions/`; tests pass a tmpdir-scoped fake.
   */
  storageRoot: string;
  /**
   * Max age (ms) for a persisted record. Records older than this are dropped
   * during loadAll() and garbageCollect(). Default 3_600_000 (1 hour, per SPEC
   * §6).
   */
  maxAgeMs?: number;
}

// ── Module-private types ─────────────────────────────────────────────────────

/** On-disk JSON shape — one file per server. */
interface PersistedFile {
  version: number;
  serverName: string;
  entries: PersistedSessionRecord[];
}

const CURRENT_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Validate a server name — same lax shape as ptyId (path-safe identifier). */
function _validateServerName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new Error(`invalid serverName: ${JSON.stringify(name)} (1-128 chars required)`);
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    throw new Error(
      `invalid serverName: ${JSON.stringify(name)} (must match /^[A-Za-z0-9_.:-]+$/)`,
    );
  }
}

/** Validate a ptyId — mirrors pty-identity.ts validation. */
function _validatePtyId(ptyId: string): void {
  if (typeof ptyId !== "string" || ptyId.length === 0 || ptyId.length > 128) {
    throw new Error(`invalid ptyId: ${JSON.stringify(ptyId)} (1-128 chars required)`);
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(ptyId)) {
    throw new Error(`invalid ptyId: ${JSON.stringify(ptyId)} (must match /^[A-Za-z0-9_.:-]+$/)`);
  }
}

/** Compute the SHA-256 hex integrity hash for a record. */
function _hashFor(serverName: string, ptyId: string, sessionId: string): string {
  return createHash("sha256").update(`${serverName}:${ptyId}:${sessionId}`).digest("hex");
}

/** Fire an audit event, swallowing any failure (audits must never break us). */
function _audit(event: string, payload: Record<string, unknown>): void {
  try {
    getMcpBridge().audit(event, payload);
  } catch {
    // intentionally swallowed — persistence layer must never throw from audit
  }
}

/** Type-guard for a parsed PersistedFile. */
function _isPersistedFile(value: unknown): value is PersistedFile {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Partial<PersistedFile>;
  return (
    typeof f.version === "number" && typeof f.serverName === "string" && Array.isArray(f.entries)
  );
}

/** Type-guard for a parsed entry. */
function _isPersistedRecord(value: unknown): value is PersistedSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<PersistedSessionRecord>;
  return (
    typeof r.serverName === "string" &&
    typeof r.ptyId === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.issuedAt === "number" &&
    typeof r.lastUsedAt === "number" &&
    typeof r.hash === "string"
  );
}

// ── SessionPersistenceStore ──────────────────────────────────────────────────

/**
 * Bridge-side persistence store for (server, ptyId, sessionId) bindings.
 *
 * All methods are idempotent. Per-server file mutex (in-process Promise chain)
 * prevents concurrent mutation of the same file from racing the rename.
 */
export class SessionPersistenceStore {
  private readonly storageRoot: string;
  private readonly maxAgeMs: number;

  /** Per-server write mutex — every file mutation chains onto the previous. */
  private readonly writeQueue = new Map<string, Promise<void>>();

  /** Ensure-dir runs exactly once per instance lifetime. */
  private initPromise: Promise<void> | null = null;

  constructor(opts: SessionPersistenceStoreOpts) {
    if (!opts.storageRoot || typeof opts.storageRoot !== "string") {
      throw new Error("SessionPersistenceStore: storageRoot is required");
    }
    this.storageRoot = opts.storageRoot;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Record a fresh (server, pty) session. Replaces any existing entry for the
   * same (server, pty) — idempotent w.r.t. repeat calls.
   */
  async record(serverName: string, ptyId: string, sessionId: string): Promise<void> {
    _validateServerName(serverName);
    _validatePtyId(ptyId);
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(
        `invalid sessionId: ${JSON.stringify(sessionId)} (non-empty string required)`,
      );
    }

    const now = Date.now();
    const newRecord: PersistedSessionRecord = {
      serverName,
      ptyId,
      sessionId,
      issuedAt: now,
      lastUsedAt: now,
      hash: _hashFor(serverName, ptyId, sessionId),
    };

    await this._mutate(serverName, (current) => {
      const entries = current.entries.filter((e) => e.ptyId !== ptyId);
      entries.push(newRecord);
      return { ...current, entries };
    });

    _audit("mcp_session_persisted", {
      server: serverName,
      ptyId,
      sessionId,
      issuedAt: now,
    });
  }

  /** Drop the (server, pty) entry. No-op if not present. */
  async drop(serverName: string, ptyId: string): Promise<void> {
    _validateServerName(serverName);
    _validatePtyId(ptyId);

    let dropped = false;
    await this._mutate(serverName, (current) => {
      const before = current.entries.length;
      const entries = current.entries.filter((e) => e.ptyId !== ptyId);
      dropped = entries.length < before;
      return { ...current, entries };
    });

    if (dropped) {
      _audit("mcp_session_dropped", {
        server: serverName,
        ptyId,
        reason: "explicit",
      });
    }
  }

  /**
   * Bump `lastUsedAt` for the (server, pty) entry. No-op if not present. Not
   * coalesced at this layer — W2 is free to coalesce upstream if needed.
   */
  async touch(serverName: string, ptyId: string): Promise<void> {
    _validateServerName(serverName);
    _validatePtyId(ptyId);

    const now = Date.now();
    await this._mutate(serverName, (current) => {
      let changed = false;
      const entries = current.entries.map((e) => {
        if (e.ptyId === ptyId) {
          changed = true;
          return { ...e, lastUsedAt: now };
        }
        return e;
      });
      return changed ? { ...current, entries } : current;
    });
  }

  /**
   * Load all persisted records for a server, filtered to those still within
   * TTL and passing integrity check. Records that fail TTL, hash, or version
   * checks are dropped from disk during the load (with audit).
   *
   * Returns [] on missing/corrupt/version-mismatch files.
   */
  async loadAll(serverName: string): Promise<PersistedSessionRecord[]> {
    _validateServerName(serverName);
    await this._ensureDir();
    const filePath = this._filePath(serverName);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      // ENOENT is the empty-file case — common, not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      _audit("mcp_session_lost_on_restart", {
        server: serverName,
        reason: "file_corrupt",
        message: (err as Error).message,
      });
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      _audit("mcp_session_lost_on_restart", {
        server: serverName,
        reason: "file_corrupt",
      });
      await this._unlinkSafe(filePath);
      return [];
    }

    if (!_isPersistedFile(parsed)) {
      _audit("mcp_session_lost_on_restart", {
        server: serverName,
        reason: "file_corrupt",
      });
      await this._unlinkSafe(filePath);
      return [];
    }

    if (parsed.version !== CURRENT_VERSION) {
      _audit("mcp_session_lost_on_restart", {
        server: serverName,
        reason: "version_mismatch",
        foundVersion: parsed.version,
        expectedVersion: CURRENT_VERSION,
      });
      await this._unlinkSafe(filePath);
      return [];
    }

    const now = Date.now();
    const kept: PersistedSessionRecord[] = [];
    let mutated = false;

    for (const entry of parsed.entries) {
      if (!_isPersistedRecord(entry)) {
        _audit("mcp_session_lost_on_restart", {
          server: serverName,
          reason: "file_corrupt",
        });
        mutated = true;
        continue;
      }

      const expectedHash = _hashFor(entry.serverName, entry.ptyId, entry.sessionId);
      if (entry.hash !== expectedHash || entry.serverName !== serverName) {
        _audit("mcp_session_lost_on_restart", {
          server: serverName,
          ptyId: entry.ptyId,
          sessionId: entry.sessionId,
          reason: "integrity_failed",
        });
        mutated = true;
        continue;
      }

      const ageMs = now - entry.issuedAt;
      if (ageMs > this.maxAgeMs) {
        _audit("mcp_session_lost_on_restart", {
          server: serverName,
          ptyId: entry.ptyId,
          sessionId: entry.sessionId,
          reason: "ttl_expired",
          ageMs,
        });
        mutated = true;
        continue;
      }

      kept.push(entry);
      _audit("mcp_session_loaded", {
        server: serverName,
        ptyId: entry.ptyId,
        sessionId: entry.sessionId,
        ageMs,
      });
    }

    // If we dropped anything, rewrite the file with only the kept entries.
    if (mutated) {
      await this._mutate(serverName, () => ({
        version: CURRENT_VERSION,
        serverName,
        entries: kept,
      }));
    }

    return kept;
  }

  /**
   * Periodic GC tick. Scans every server file, drops expired and
   * integrity-failed records. Returns counts.
   */
  async garbageCollect(): Promise<{ scanned: number; kept: number; dropped: number }> {
    await this._ensureDir();

    let files: string[];
    try {
      files = await readdir(this.storageRoot);
    } catch {
      return { scanned: 0, kept: 0, dropped: 0 };
    }

    let scanned = 0;
    let kept = 0;
    let dropped = 0;

    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;
      const serverName = filename.slice(0, -".json".length);
      try {
        _validateServerName(serverName);
      } catch {
        continue;
      }

      const before = (await this._readFile(serverName))?.entries.length ?? 0;
      const records = await this.loadAll(serverName); // loadAll() already prunes + audits
      scanned += before;
      kept += records.length;
      dropped += Math.max(0, before - records.length);
    }

    _audit("mcp_session_gc", { scanned, kept, dropped });
    return { scanned, kept, dropped };
  }

  /** Test seam — clears all persisted state. */
  async _resetForTests(): Promise<void> {
    try {
      await rm(this.storageRoot, { recursive: true, force: true });
    } catch {
      // ignore — directory may not exist
    }
    this.writeQueue.clear();
    this.initPromise = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private _filePath(serverName: string): string {
    return join(this.storageRoot, `${serverName}.json`);
  }

  /**
   * Ensure the storage directory exists with mode 0700. Idempotent — runs
   * exactly once per instance lifetime; subsequent calls reuse the promise.
   */
  private async _ensureDir(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await mkdir(this.storageRoot, { recursive: true, mode: DIR_MODE });
      // mkdir's `mode` is masked by umask; chmod explicitly to lock it down.
      try {
        await chmod(this.storageRoot, DIR_MODE);
      } catch {
        // best-effort — some filesystems (e.g. tmpfs in odd configs) reject chmod
      }
    })();
    return this.initPromise;
  }

  /** Read + parse a server file. Returns null on missing/corrupt — no audit. */
  private async _readFile(serverName: string): Promise<PersistedFile | null> {
    const filePath = this._filePath(serverName);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (_isPersistedFile(parsed)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** Atomic write — tmpfile + rename + fsync parent. */
  private async _atomicWrite(filePath: string, payload: string): Promise<void> {
    await this._ensureDir();
    const tmpSuffix = randomBytes(4).toString("hex");
    const tmpPath = `${filePath}.tmp.${tmpSuffix}`;
    await writeFile(tmpPath, payload, { mode: FILE_MODE, encoding: "utf8" });
    // Some FS / umask combinations strip the mode bits from writeFile; force.
    try {
      await chmod(tmpPath, FILE_MODE);
    } catch {
      // best-effort
    }
    await rename(tmpPath, filePath);
  }

  /** Safe unlink — swallows ENOENT, silently ignores other errors. */
  private async _unlinkSafe(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      // Non-fatal — caller will re-write a fresh file on the next mutation.
    }
  }

  /**
   * Apply a mutation to a server's persisted file under a per-server mutex.
   * `mutator` receives the current file (or a fresh empty one if absent) and
   * returns the new file to write. If the mutator returns the same object
   * reference, no write occurs.
   */
  private async _mutate(
    serverName: string,
    mutator: (current: PersistedFile) => PersistedFile,
  ): Promise<void> {
    // Codex PR #78 P2: chain `prev.catch(() => undefined).then(...)` so a
    // previously-rejected write doesn't permanently poison the chain. The
    // current caller still sees their own write's success/failure via
    // `await next` below; future callers continue to make progress.
    // Without this, one transient filesystem error bricks persistence for
    // this server until daemon restart.
    const prev = this.writeQueue.get(serverName) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const current = (await this._readFile(serverName)) ?? {
          version: CURRENT_VERSION,
          serverName,
          entries: [],
        };
        const updated = mutator(current);
        if (updated === current) return; // no-op — short-circuit write
        // Always normalise version + serverName even if mutator forgot.
        const normalised: PersistedFile = {
          version: CURRENT_VERSION,
          serverName,
          entries: updated.entries,
        };
        await this._atomicWrite(this._filePath(serverName), JSON.stringify(normalised));
      });
    // Store the next-link so concurrent callers chain onto it; await it so the
    // current caller sees any error from THEIR mutation (the .catch above
    // swallows the predecessor's error so it can't leak into ours).
    this.writeQueue.set(serverName, next);
    await next;
  }
}
