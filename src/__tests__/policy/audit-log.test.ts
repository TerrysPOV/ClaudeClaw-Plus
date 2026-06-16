/**
 * Tests for policy/audit-log.ts
 *
 * Run with: bun test src/__tests__/policy/audit-log.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  log,
  logPolicyDecision,
  logApproval,
  logDenial,
  query,
  exportEntries,
  getStats,
  cleanupRetention,
  getRetentionPolicy,
  verifyChain,
  _resetChainCache,
  type AuditEntry,
  type AuditAction,
} from "../../policy/audit-log";

const AUDIT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const AUDIT_LOG_FILE = join(AUDIT_DIR, "audit-log.jsonl");

describe("Audit Log - Basic Operations", () => {
  beforeEach(async () => {
    // Clean audit log before test to ensure isolation
    try {
      await rm(AUDIT_LOG_FILE, { force: true });
    } catch {
      // File might not exist
    }
    await mkdir(AUDIT_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { force: true });
    } catch {
      // Ignore
    }
  });

  it("should log an audit entry", async () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      eventId: "event-1",
      requestId: "req-1",
      source: "telegram",
      channelId: "telegram:123",
      toolName: "Bash",
      action: "deny",
      reason: "Tool denied by policy",
      matchedRuleId: "global-deny-bash",
    };

    await log(entry);

    expect(existsSync(AUDIT_LOG_FILE)).toBe(true);

    const content = await readFile(AUDIT_LOG_FILE, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.eventId).toBe("event-1");
    expect(parsed.action).toBe("deny");
  });

  it("should append multiple entries", async () => {
    await log({
      timestamp: new Date().toISOString(),
      eventId: "event-1",
      requestId: "req-1",
      source: "telegram",
      toolName: "Bash",
      action: "deny",
      reason: "Denied",
    });

    await log({
      timestamp: new Date().toISOString(),
      eventId: "event-2",
      requestId: "req-2",
      source: "discord",
      toolName: "View",
      action: "allow",
      reason: "Allowed",
    });

    const content = await readFile(AUDIT_LOG_FILE, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    expect(lines).toHaveLength(2);
  });
});

describe("Audit Log - Policy Decision Logging", () => {
  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should log a policy decision", async () => {
    await logPolicyDecision(
      "event-1",
      "req-1",
      "telegram",
      "Bash",
      "deny",
      "Global policy denies Bash",
      { matchedRuleId: "global-deny-bash" },
    );

    const entries = await query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("deny");
    expect(entries[0].matchedRuleId).toBe("global-deny-bash");
  });

  it("should log an approval action", async () => {
    await logApproval("event-1", "req-1", "telegram", "Edit", "operator-1", "Looks good");

    const entries = await query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("approved");
    expect(entries[0].operatorId).toBe("operator-1");
    expect(entries[0].reason).toBe("Looks good");
  });

  it("should log a denial action", async () => {
    await logDenial("event-1", "req-1", "discord", "Bash", "operator-2", "Not allowed");

    const entries = await query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("denied");
    expect(entries[0].operatorId).toBe("operator-2");
  });
});

describe("Audit Log - Querying", () => {
  beforeEach(async () => {
    await mkdir(AUDIT_DIR, { recursive: true });

    // Create some test entries
    await logPolicyDecision("event-1", "req-1", "telegram", "Bash", "deny", "Denied");
    await logPolicyDecision("event-2", "req-2", "telegram", "View", "allow", "Allowed");
    await logPolicyDecision(
      "event-3",
      "req-3",
      "discord",
      "Edit",
      "require_approval",
      "Needs approval",
    );
    await logApproval("event-4", "req-4", "telegram", "Edit", "operator-1", "Approved");
  });

  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should return all entries with no filters", async () => {
    const entries = await query({});
    expect(entries).toHaveLength(4);
  });

  it("should filter by source", async () => {
    const entries = await query({ source: "telegram" });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.source === "telegram")).toBe(true);
  });

  it("should filter by action", async () => {
    const entries = await query({ action: "deny" });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("deny");
  });

  it("should filter by toolName", async () => {
    const entries = await query({ toolName: "Edit" });
    expect(entries).toHaveLength(2); // require_approval and approved
  });

  it("should filter by operatorId", async () => {
    const entries = await query({ operatorId: "operator-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0].operatorId).toBe("operator-1");
  });

  it("should filter by eventId", async () => {
    const entries = await query({ eventId: "event-2" });
    expect(entries).toHaveLength(1);
    expect(entries[0].eventId).toBe("event-2");
  });

  it("should sort by timestamp descending (newest first)", async () => {
    // Add another entry with a newer timestamp
    await log({
      timestamp: new Date(Date.now() + 10000).toISOString(), // 10 seconds in future
      eventId: "event-5",
      requestId: "req-5",
      source: "slack",
      toolName: "Bash",
      action: "deny",
      reason: "Latest",
    });

    const entries = await query({});
    expect(entries[0].eventId).toBe("event-5");
  });
});

describe("Audit Log - Export", () => {
  beforeEach(async () => {
    await mkdir(AUDIT_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should export entries within date range", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();

    await log({
      timestamp: new Date().toISOString(),
      eventId: "event-1",
      requestId: "req-1",
      source: "telegram",
      toolName: "Bash",
      action: "deny",
      reason: "Test",
    });

    const entries = await exportEntries(yesterday, tomorrow);
    expect(entries).toHaveLength(1);
  });
});

describe("Audit Log - Statistics", () => {
  beforeEach(async () => {
    await mkdir(AUDIT_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should return correct statistics", async () => {
    await logPolicyDecision("event-1", "req-1", "telegram", "Bash", "deny", "Deny");
    await logPolicyDecision("event-2", "req-2", "telegram", "View", "allow", "Allow");
    await logPolicyDecision("event-3", "req-3", "discord", "Edit", "require_approval", "Approve");

    const stats = await getStats();

    expect(stats.totalEntries).toBe(3);
    expect(stats.byAction.deny).toBe(1);
    expect(stats.byAction.allow).toBe(1);
    expect(stats.byAction.require_approval).toBe(1);
    expect(stats.bySource.telegram).toBe(2);
    expect(stats.bySource.discord).toBe(1);
  });

  it("should return empty stats for no entries", async () => {
    const stats = await getStats();

    expect(stats.totalEntries).toBe(0);
    expect(stats.oldestTimestamp).toBeNull();
    expect(stats.newestTimestamp).toBeNull();
  });
});

describe("Audit Log - Retention", () => {
  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should report retention policy", () => {
    const policy = getRetentionPolicy();

    expect(policy.defaultRetentionDays).toBe(30);
    expect(policy.defaultMaxFileSizeBytes).toBe(10 * 1024 * 1024);
    expect(policy.recommendation).toContain("30 days");
  });

  it("should identify entries older than retention period", async () => {
    await mkdir(AUDIT_DIR, { recursive: true });

    // Create an old entry
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 60 days ago
    await log({
      timestamp: oldDate.toISOString(),
      eventId: "old-event",
      requestId: "old-req",
      source: "telegram",
      toolName: "Bash",
      action: "deny",
      reason: "Old entry",
    });

    // Create a recent entry
    await log({
      timestamp: new Date().toISOString(),
      eventId: "new-event",
      requestId: "new-req",
      source: "telegram",
      toolName: "View",
      action: "allow",
      reason: "New entry",
    });

    const result = await cleanupRetention({ maxAgeDays: 30 });

    expect(result.deleted).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

describe("Audit Log - Tamper-evident hash chain", () => {
  beforeEach(async () => {
    _resetChainCache();
    try {
      await rm(AUDIT_LOG_FILE, { force: true });
    } catch {
      // ignore
    }
    await mkdir(AUDIT_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(AUDIT_LOG_FILE, { force: true });
    } catch {
      // ignore
    }
  });

  const sample = (id: string, action: AuditAction = "allow"): AuditEntry => ({
    timestamp: new Date().toISOString(),
    eventId: `event-${id}`,
    requestId: `req-${id}`,
    source: "telegram",
    toolName: "Bash",
    action,
    reason: `reason ${id}`,
  });

  it("stamps each entry with prevHash and hash, chaining genesis -> tail", async () => {
    await log(sample("1"));
    await log(sample("2"));
    await log(sample("3"));

    const content = await readFile(AUDIT_LOG_FILE, "utf8");
    const entries = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);

    expect(entries).toHaveLength(3);
    expect(entries[0].prevHash).toBe("0".repeat(64));
    expect(entries[0].hash).toBeDefined();
    // each entry's prevHash is the previous entry's hash
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
  });

  it("verifyChain() reports a valid, intact chain", async () => {
    await log(sample("1"));
    await log(sample("2"));

    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.brokenAt).toBeUndefined();
  });

  it("verifyChain() detects a tampered entry (content edited in place)", async () => {
    await log(sample("1"));
    await log(sample("2", "deny"));
    await log(sample("3"));

    // Tamper: flip the middle entry's action without recomputing its hash.
    const lines = (await readFile(AUDIT_LOG_FILE, "utf8")).trim().split("\n");
    const middle = JSON.parse(lines[1]) as AuditEntry;
    middle.action = "allow"; // was "deny"
    lines[1] = JSON.stringify(middle);
    await writeFile(AUDIT_LOG_FILE, lines.join("\n") + "\n", "utf8");

    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("hash mismatch");
  });

  it("verifyChain() detects a removed entry (chain link broken)", async () => {
    await log(sample("1"));
    await log(sample("2"));
    await log(sample("3"));

    // Remove the middle entry -> entry 3's prevHash no longer matches.
    const lines = (await readFile(AUDIT_LOG_FILE, "utf8")).trim().split("\n");
    await writeFile(AUDIT_LOG_FILE, [lines[0], lines[2]].join("\n") + "\n", "utf8");

    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("prevHash mismatch");
  });

  it("cleanupRetention() re-seals survivors so the chain stays valid", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90);
    await log({ ...sample("old"), timestamp: oldDate.toISOString() });
    await log(sample("recent-1"));
    await log(sample("recent-2"));

    const result = await cleanupRetention({ maxAgeDays: 30 });
    expect(result.deleted).toBe(1);
    expect(result.remaining).toBe(2);

    const verified = await verifyChain();
    expect(verified.valid).toBe(true);
    expect(verified.entries).toBe(2);
  });

  it("verifyChain() returns valid for an empty/absent log", async () => {
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(0);
  });
});
