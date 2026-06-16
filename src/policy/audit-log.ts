/**
 * Audit Log
 *
 * Durable audit trail capturing all policy-relevant decisions and operator actions.
 *
 * DESIGN:
 * - Every policy decision is logged
 * - Every approval/denial action is logged
 * - File stored at .claude/claudeclaw/audit-log.jsonl
 * - Log entries are queryable and exportable
 *
 * CRASH CONSCIOUSNESS:
 * - All log entries are append-only
 * - Entries include rule provenance and operator attribution
 */

import { appendFile, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export type AuditAction = "allow" | "deny" | "require_approval" | "approved" | "denied" | "expired";

export interface AuditEntry {
  timestamp: string;
  eventId: string;
  requestId: string;
  source: string;
  channelId?: string;
  threadId?: string;
  userId?: string;
  skillName?: string;
  toolName: string;
  action: AuditAction;
  reason: string;
  matchedRuleId?: string;
  operatorId?: string;
  metadata?: Record<string, unknown>;
  /** Hash of the previous entry's `hash` field, forming a tamper-evident chain. */
  prevHash?: string;
  /** sha256(prevHash + JSON(entry-without-prevHash/hash)). */
  hash?: string;
}

// ============================================================================
// Filters
// ============================================================================

export interface AuditLogFilters {
  startDate?: string;
  endDate?: string;
  source?: string;
  channelId?: string;
  userId?: string;
  skillName?: string;
  toolName?: string;
  action?: AuditAction;
  eventId?: string;
  operatorId?: string;
}

// ============================================================================
// Constants
// ============================================================================

const AUDIT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const AUDIT_LOG_FILE = join(AUDIT_DIR, "audit-log.jsonl");
const DEFAULT_RETENTION_DAYS = 30;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const GENESIS_HASH = "0".repeat(64);

// ============================================================================
// Tamper-evident hash chain
// ============================================================================
//
// Each entry carries `prevHash` (the previous entry's `hash`) and `hash`
// (sha256 over prevHash + the entry's own content). Inserting, removing,
// reordering or editing any entry breaks the chain at that point, which
// `verifyChain()` detects. Writes are serialized through `writeChain` so the
// chain stays consistent even with concurrent (fire-and-forget) callers.

let lastHash: string | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Stable hash of an entry's content (prevHash/hash fields excluded by caller). */
function computeEntryHash(prevHash: string, content: Record<string, unknown>): string {
  return createHash("sha256")
    .update(prevHash + JSON.stringify(content))
    .digest("hex");
}

/** Resolve the chain tail hash, re-seeding from disk and resetting on file loss. */
async function getLastHash(): Promise<string> {
  if (!existsSync(AUDIT_LOG_FILE)) {
    lastHash = GENESIS_HASH;
    return lastHash;
  }
  if (lastHash !== null) return lastHash;
  const content = await readFile(AUDIT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    lastHash = GENESIS_HASH;
    return lastHash;
  }
  try {
    const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
    lastHash = last.hash ?? GENESIS_HASH;
  } catch {
    lastHash = GENESIS_HASH;
  }
  return lastHash;
}

/** Reset the in-memory chain cache (test isolation helper). */
export function _resetChainCache(): void {
  lastHash = null;
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Log a policy decision or operator action.
 */
export async function log(entry: AuditEntry): Promise<void> {
  // Serialize writes so the hash chain stays consistent under concurrent
  // (often fire-and-forget) callers. A failed write must not stall the chain.
  const result = writeChain.then(async () => {
    if (!existsSync(AUDIT_DIR)) {
      await mkdir(AUDIT_DIR, { recursive: true });
    }

    // Never mutate the input; strip any caller-supplied chain fields so we
    // hash only the entry content.
    const { prevHash: _p, hash: _h, ...rest } = entry;
    const content: AuditEntry = rest.timestamp
      ? { ...rest }
      : { ...rest, timestamp: new Date().toISOString() };

    const prevHash = await getLastHash();
    const hash = computeEntryHash(prevHash, content as Record<string, unknown>);
    const chained = { ...content, prevHash, hash };

    await appendFile(AUDIT_LOG_FILE, JSON.stringify(chained) + "\n", "utf8");
    lastHash = hash;
  });
  writeChain = result.catch(() => {});
  return result;
}

/**
 * Log a policy decision.
 */
export async function logPolicyDecision(
  eventId: string,
  requestId: string,
  source: string,
  toolName: string,
  action: AuditAction,
  reason: string,
  options?: {
    channelId?: string;
    threadId?: string;
    userId?: string;
    skillName?: string;
    matchedRuleId?: string;
    operatorId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    eventId,
    requestId,
    source,
    toolName,
    action,
    reason,
    ...options,
  };

  await log(entry);
}

/**
 * Log an approval action.
 */
export async function logApproval(
  eventId: string,
  requestId: string,
  source: string,
  toolName: string,
  operatorId: string,
  reason?: string,
  options?: {
    channelId?: string;
    threadId?: string;
    userId?: string;
    skillName?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await logPolicyDecision(
    eventId,
    requestId,
    source,
    toolName,
    "approved",
    reason || "Approved by operator",
    {
      ...options,
      operatorId,
    },
  );
}

/**
 * Log a denial action.
 */
export async function logDenial(
  eventId: string,
  requestId: string,
  source: string,
  toolName: string,
  operatorId: string,
  reason?: string,
  options?: {
    channelId?: string;
    threadId?: string;
    userId?: string;
    skillName?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await logPolicyDecision(
    eventId,
    requestId,
    source,
    toolName,
    "denied",
    reason || "Denied by operator",
    {
      ...options,
      operatorId,
    },
  );
}

/**
 * Query audit log entries with filters.
 */
export async function query(filters: AuditLogFilters = {}): Promise<AuditEntry[]> {
  if (!existsSync(AUDIT_LOG_FILE)) {
    return [];
  }

  const content = await readFile(AUDIT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());

  const results: AuditEntry[] = [];

  for (const line of lines) {
    try {
      const entry: AuditEntry = JSON.parse(line);

      // Apply filters
      if (filters.startDate && entry.timestamp < filters.startDate) {
        continue;
      }

      if (filters.endDate && entry.timestamp > filters.endDate) {
        continue;
      }

      if (filters.source && entry.source !== filters.source) {
        continue;
      }

      if (filters.channelId && entry.channelId !== filters.channelId) {
        continue;
      }

      if (filters.userId && entry.userId !== filters.userId) {
        continue;
      }

      if (filters.skillName && entry.skillName !== filters.skillName) {
        continue;
      }

      if (filters.toolName && entry.toolName !== filters.toolName) {
        continue;
      }

      if (filters.action && entry.action !== filters.action) {
        continue;
      }

      if (filters.eventId && entry.eventId !== filters.eventId) {
        continue;
      }

      if (filters.operatorId && entry.operatorId !== filters.operatorId) {
        continue;
      }

      results.push(entry);
    } catch {}
  }

  // Sort by timestamp descending (newest first)
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return results;
}

/**
 * Export audit log entries within a date range.
 */
export async function exportEntries(startDate: string, endDate: string): Promise<AuditEntry[]> {
  return query({ startDate, endDate });
}

/**
 * Get audit log statistics.
 */
export async function getStats(): Promise<{
  totalEntries: number;
  byAction: Record<AuditAction, number>;
  bySource: Record<string, number>;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}> {
  if (!existsSync(AUDIT_LOG_FILE)) {
    return {
      totalEntries: 0,
      byAction: { allow: 0, deny: 0, require_approval: 0, approved: 0, denied: 0, expired: 0 },
      bySource: {},
      oldestTimestamp: null,
      newestTimestamp: null,
    };
  }

  const content = await readFile(AUDIT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());

  const byAction: Record<AuditAction, number> = {
    allow: 0,
    deny: 0,
    require_approval: 0,
    approved: 0,
    denied: 0,
    expired: 0,
  };
  const bySource: Record<string, number> = {};
  let oldestTimestamp: string | null = null;
  let newestTimestamp: string | null = null;

  for (const line of lines) {
    try {
      const entry: AuditEntry = JSON.parse(line);

      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;

      if (!oldestTimestamp || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
      if (!newestTimestamp || entry.timestamp > newestTimestamp) {
        newestTimestamp = entry.timestamp;
      }
    } catch {}
  }

  return {
    totalEntries: lines.length,
    byAction,
    bySource,
    oldestTimestamp,
    newestTimestamp,
  };
}

// ============================================================================
// Retention Management
// ============================================================================

export interface RetentionConfig {
  maxAgeDays?: number;
  maxFileSizeBytes?: number;
}

/**
 * Clean up old audit log entries based on retention policy.
 */
export async function cleanupRetention(
  config: RetentionConfig = {},
): Promise<{ deleted: number; remaining: number }> {
  const maxAgeDays = config.maxAgeDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoffTimestamp = cutoffDate.toISOString();

  if (!existsSync(AUDIT_LOG_FILE)) {
    return { deleted: 0, remaining: 0 };
  }

  const content = await readFile(AUDIT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());

  const keptLines: string[] = [];
  let deleted = 0;

  for (const line of lines) {
    try {
      const entry: AuditEntry = JSON.parse(line);

      if (entry.timestamp < cutoffTimestamp) {
        deleted++;
        continue;
      }

      keptLines.push(line);
    } catch {
      // Skip malformed entries - count as deleted
      deleted++;
    }
  }

  // Write kept lines back atomically (temp file + rename). Removing entries
  // necessarily breaks the original chain, so re-seal the survivors into a
  // fresh chain — retention is an authorized operation and verifyChain() must
  // still pass afterwards.
  if (deleted > 0) {
    let prev = GENESIS_HASH;
    const resealed = keptLines.map((line) => {
      const parsed = JSON.parse(line) as AuditEntry;
      const { prevHash: _p, hash: _h, ...content } = parsed;
      const hash = computeEntryHash(prev, content as Record<string, unknown>);
      const chained = { ...content, prevHash: prev, hash };
      prev = hash;
      return JSON.stringify(chained);
    });
    const tmpPath = AUDIT_LOG_FILE + ".tmp";
    await writeFile(tmpPath, resealed.map((l) => l + "\n").join(""), "utf8");
    await rename(tmpPath, AUDIT_LOG_FILE);
    lastHash = resealed.length > 0 ? prev : GENESIS_HASH;
  }

  return {
    deleted,
    remaining: keptLines.length,
  };
}

// ============================================================================
// Chain verification
// ============================================================================

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** Index (0-based) of the first entry that breaks the chain, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify the tamper-evident hash chain over the audit log.
 *
 * Walks every entry, recomputing each hash from the running previous hash and
 * the entry content. Any insertion, deletion, reorder or edit surfaces as a
 * prevHash or hash mismatch at the affected index.
 */
export async function verifyChain(): Promise<ChainVerification> {
  if (!existsSync(AUDIT_LOG_FILE)) {
    return { valid: true, entries: 0 };
  }

  const content = await readFile(AUDIT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  let prev = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, entries: lines.length, brokenAt: i, reason: "unparseable entry" };
    }

    if (entry.prevHash === undefined || entry.hash === undefined) {
      return {
        valid: false,
        entries: lines.length,
        brokenAt: i,
        reason: "entry missing chain fields (legacy or stripped)",
      };
    }
    if (entry.prevHash !== prev) {
      return {
        valid: false,
        entries: lines.length,
        brokenAt: i,
        reason: "prevHash mismatch (entry inserted, removed or reordered)",
      };
    }
    const { prevHash: _p, hash: storedHash, ...entryContent } = entry;
    const recomputed = computeEntryHash(prev, entryContent as Record<string, unknown>);
    if (recomputed !== storedHash) {
      return {
        valid: false,
        entries: lines.length,
        brokenAt: i,
        reason: "hash mismatch (entry content tampered)",
      };
    }
    prev = storedHash;
  }

  return { valid: true, entries: lines.length };
}

/**
 * Get retention configuration documentation.
 */
export function getRetentionPolicy(): {
  defaultRetentionDays: number;
  defaultMaxFileSizeBytes: number;
  recommendation: string;
} {
  return {
    defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    defaultMaxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    recommendation: `Default retention is ${DEFAULT_RETENTION_DAYS} days. Rotate log file monthly and archive entries older than retention period. Monitor file size and rotate when approaching ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
  };
}
