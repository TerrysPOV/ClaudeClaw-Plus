/**
 * OutcomeLoop audit log — the commercial-auditability deliverable.
 *
 * Every proposal, activation, baseline, verdict, approval and revert is an
 * immutable, attributable, exportable record an external auditor can inspect:
 * *why was X changed, did it measurably help, who approved it, how was it
 * reverted?* Append-only JSONL with a SHA-256 hash chain → tamper-evident
 * (any edit to an earlier line breaks every subsequent `hash`). One certifiable
 * surface, pairing with the single `TelemetryProvider`.
 *
 * Phase 1 emits: fitness_active / fitness_inactive (activation gate),
 * baseline_snapshot (at apply), verdict (maturation), revert (defensive close).
 * telemetry_query records each fitness measurement served over the MCP bridge,
 * so the provenance of every number that fed a verdict is itself in the chain.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { homedir } from "node:os";

export type AuditEvent =
  | "fitness_active"
  | "fitness_inactive"
  | "baseline_snapshot"
  | "verdict"
  | "revert"
  | "proposal"
  | "telemetry_query"
  // Proposal-gate lifecycle over the MCP bridge (gate-mcp.ts). detail carries
  // source (cron|research|mcp) so an auditor reads which surface drove the call.
  | "gate_propose"
  | "gate_apply"
  | "gate_refuse"
  | "gate_mature"
  // Provenance: the active global + per-subject tuning scope at boot/registration.
  // An auditor reads "the tuner operated at scope=X" from one immutable record.
  | "scope_registration"
  // Phase A observability hub: one tamper-evident record per MCP tool call,
  // emitted by the gateway (mcp-multiplexer) onto a DEDICATED tool-call chain
  // (never the tuner's outcome chain). subject=plugin; detail carries tool,
  // status, duration_ms, agent_id, args_hash (no raw args).
  | "mcp.tool_call"
  // Mandatory-audit Phase 1: the INTENT record written synchronously at the
  // gateway BEFORE a tool dispatches, under `audit: "enforce"`. Distinct event
  // name (not `mcp.tool_call`) so the metrics producer — which filters on
  // `mcp.tool_call` — never counts an intent as a completed call. subject=plugin;
  // detail carries tool, agent_id, args_hash, event_ts (no status/duration — the
  // call hasn't run yet). Pairs with the later `mcp.tool_call` result record.
  | "mcp.tool_call_intent"
  // Boot provenance: the active mandatory-audit policy (enforce|best-effort)
  // recorded once at multiplexer start under enforce, so an auditor reads
  // "the gateway operated fail-closed" from the chain itself.
  | "mcp.audit_policy";

/** The author-supplied content of an audit record (everything but the chain fields). */
export interface AuditEntry {
  event: AuditEvent;
  subject?: string;
  metric?: string;
  proposal_id?: string;
  commit_sha?: string;
  /** Attribution: `system` for automated steps, `human:<id>` for gated approvals. */
  actor?: string;
  detail?: Record<string, unknown>;
}

/** A persisted record: the entry plus immutable chain metadata. */
export interface AuditRecord extends AuditEntry {
  seq: number;
  ts: string; // ISO-8601
  prev_hash: string;
  hash: string;
}

const GENESIS_HASH = "0".repeat(64);

/** Canonical, stable serialization of the chained fields (key order fixed). */
function canonical(seq: number, ts: string, prevHash: string, entry: AuditEntry): string {
  return JSON.stringify({
    seq,
    ts,
    prev_hash: prevHash,
    event: entry.event,
    subject: entry.subject ?? null,
    metric: entry.metric ?? null,
    proposal_id: entry.proposal_id ?? null,
    commit_sha: entry.commit_sha ?? null,
    actor: entry.actor ?? "system",
    detail: entry.detail ?? {},
  });
}

function hashRecord(seq: number, ts: string, prevHash: string, entry: AuditEntry): string {
  return createHash("sha256")
    .update(canonical(seq, ts, prevHash, entry))
    .digest("hex");
}

/**
 * Append-only audit log. File-backed (JSONL) when given a path; in-memory when
 * `path` is omitted or `":memory:"` (tests). Reads existing tail to continue
 * the chain across process restarts.
 */
export class AuditLog {
  private readonly path: string | null;
  private records: AuditRecord[] = [];
  private lastHash = GENESIS_HASH;
  private seq = 0;

  constructor(path?: string) {
    this.path = path && path !== ":memory:" ? path.replace(/^~/, homedir()) : null;
    if (this.path && existsSync(this.path)) this.loadTail();
  }

  private loadTail(): void {
    const text = readFileSync(this.path as string, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rec = JSON.parse(trimmed) as AuditRecord;
      this.records.push(rec);
    }
    const last = this.records.at(-1);
    if (last) {
      this.lastHash = last.hash;
      this.seq = last.seq;
    }
  }

  append(entry: AuditEntry): AuditRecord {
    const seq = this.seq + 1;
    const ts = new Date().toISOString();
    const prev_hash = this.lastHash;
    const hash = hashRecord(seq, ts, prev_hash, entry);
    const record: AuditRecord = {
      seq,
      ts,
      prev_hash,
      hash,
      event: entry.event,
      ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
      ...(entry.metric !== undefined ? { metric: entry.metric } : {}),
      ...(entry.proposal_id !== undefined ? { proposal_id: entry.proposal_id } : {}),
      ...(entry.commit_sha !== undefined ? { commit_sha: entry.commit_sha } : {}),
      actor: entry.actor ?? "system",
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    };
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    }
    this.records.push(record);
    this.lastHash = hash;
    this.seq = seq;
    return record;
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  /** Re-derive the chain and report the first index where it breaks, if any. */
  verifyChain(): { ok: boolean; brokenAtSeq?: number } {
    let prev = GENESIS_HASH;
    for (const r of this.records) {
      const expected = hashRecord(r.seq, r.ts, prev, r);
      if (expected !== r.hash) return { ok: false, brokenAtSeq: r.seq };
      prev = r.hash;
    }
    return { ok: true };
  }

  /** Exportable JSONL snapshot for an external auditor. */
  exportJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n");
  }
}
