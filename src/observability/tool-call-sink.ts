/**
 * Sink for `mcp.tool_call` telemetry + the mandatory-audit Phase-1 intent gate.
 *
 * TWO PHASES, governed by the `AuditPolicy`:
 *
 *   Phase 1 — intent. `recordIntent()` runs at the gateway BEFORE a tool
 *     dispatches. Under `enforce` it is a SYNCHRONOUS local append that THROWS
 *     on failure so the caller can fail closed ("no log → no action"). Under
 *     `best-effort` it is a no-op — the result log alone is kept, exactly the
 *     pre-mandatory-audit behaviour. The intent append is local-only: no
 *     network, no fsync-storm, at most a sub-ms buffered write on the call path.
 *
 *   Phase 2 — result. `record()` is the unchanged fire-and-forget result sink.
 *     NON-NEGOTIABLE: a hub hiccup can never stall tool I/O (the getUpdates-hang
 *     lesson). It is O(1), synchronous, never throws, never touches disk, and is
 *     NEVER awaited — it only buffers and arms a deferred flush that drains into
 *     a hash-chained `AuditLog` OFF the request path, swallowing every error.
 *
 * The dedicated tool-call chain is its OWN file — never the tuner's outcome
 * audit chain — so high-volume call traffic can't bloat or couple to that
 * certifiable surface, while still being tamper-evident in its own right. Intent
 * and result records share that one chain so the audit narrative (attempt →
 * outcome) is complete and ordered.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditEntry } from "../skills-tuner/core/audit-log.js";
import {
  type AuditPolicy,
  MCP_AUDIT_POLICY_EVENT,
  MCP_TOOL_CALL_EVENT,
  MCP_TOOL_CALL_INTENT_EVENT,
  type ToolCallEvent,
  type ToolCallIntent,
} from "./tool-call.js";

/** `PLUS_TOOL_CALL_LOG_PATH` overrides the location — same seam as
 *  `PLUS_PLUGIN_AUDIT_PATH` (#304): the test preload points it at a temp file
 *  so suites that dispatch through the multiplexer never append to the
 *  operator's live chain. */
export const DEFAULT_TOOL_CALL_LOG =
  process.env.PLUS_TOOL_CALL_LOG_PATH ||
  join(homedir(), ".claudeclaw", "telemetry", "mcp-tool-calls.jsonl");

/** The single method the sink needs from its backing chain. Narrowing to this
 *  lets tests inject a chain whose `append` throws (to exercise enforce's
 *  fail-closed path) without standing up a real unwritable file. */
export interface AuditLogLike {
  append(entry: AuditEntry): unknown;
}

export interface ToolCallSinkOptions {
  /** Backing log path. `null`/`":memory:"` keeps the chain in memory. */
  path?: string | null;
  /** Arm a deferred timer flush on record (production). When false, the caller
   *  drives `flush()` — used by tests for deterministic assertions. Default true. */
  autoFlush?: boolean;
  /** Mandatory-audit policy. Default `best-effort` (backward-compatible). */
  policy?: AuditPolicy;
  /** Test seam — build the backing chain. Production constructs a real
   *  `AuditLog`; tests can inject a throwing chain to drive enforce's
   *  fail-closed refusal. */
  logFactory?: (path: string | null) => AuditLogLike;
}

interface PendingPolicyRecord {
  policy: AuditPolicy;
  /** Absent on the boot record. */
  previous?: AuditPolicy;
  changed_at: string;
}

export class ToolCallSink {
  private enabled = true;
  private policy: AuditPolicy;
  /** Set by the first `applyPolicy` (boot); later calls are reloads. */
  private policyApplied = false;
  /** Policy records (boot under enforce, later changes) not written yet. */
  private pendingPolicyRecords: PendingPolicyRecord[] = [];
  private droppedPolicyRecords = 0;
  private static readonly MAX_PENDING_POLICY_RECORDS = 64;
  private buffer: ToolCallEvent[] = [];
  private flushArmed = false;
  private log: AuditLogLike | null = null;
  private readonly path: string | null;
  private readonly autoFlush: boolean;
  private readonly logFactory: (path: string | null) => AuditLogLike;
  /** Bound the buffer so a wedged flusher can't grow memory without limit;
   *  past the cap we DROP events rather than block or grow — telemetry is
   *  best-effort and must never threaten the daemon. */
  private static readonly MAX_BUFFER = 10_000;
  /** Bound the in-memory chain window on the high-volume tool-call log so the
   *  process-lifetime singleton can't leak; reads go through the file producer. */
  private static readonly MAX_RECORDS = 5_000;
  /** Rotate the tool-call JSONL past this size so an append-only file can't grow
   *  without bound and the producer's per-query full-file read stays cheap. */
  private static readonly ROTATE_BYTES = 32 * 1024 * 1024;
  /** Cap a captured tool `error` string: error text is not redacted and can be
   *  arbitrarily large (echoed bodies, paths). Truncate before it is retained on
   *  disk + in memory. */
  private static readonly MAX_ERROR_LEN = 2_000;
  /** Cap the tool name the same way: on a refused call it is whatever the
   *  caller sent (bounded only by the request body cap), and one oversized name
   *  per call would force the chain to rotate away its own history. */
  private static readonly MAX_TOOL_LEN = 256;

  constructor(opts: ToolCallSinkOptions = {}) {
    this.path = opts.path === undefined ? DEFAULT_TOOL_CALL_LOG : opts.path;
    this.autoFlush = opts.autoFlush !== false;
    this.policy = opts.policy ?? "best-effort";
    this.logFactory =
      opts.logFactory ??
      ((p) =>
        new AuditLog(p ?? ":memory:", {
          maxRecords: ToolCallSink.MAX_RECORDS,
          rotateBytes: ToolCallSink.ROTATE_BYTES,
        }));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  isEnabled(): boolean {
    return this.enabled;
  }

  setPolicy(policy: AuditPolicy): void {
    this.policy = policy;
  }
  getPolicy(): AuditPolicy {
    return this.policy;
  }

  /** Lazily materialise the shared backing chain. Both the synchronous intent
   *  append and the async result flush write to this one instance so the hash
   *  chain stays consistent (JS is single-threaded — neither can interleave
   *  mid-append). */
  private ensureLog(): AuditLogLike {
    if (!this.log) this.log = this.logFactory(this.path);
    return this.log;
  }

  /**
   * PHASE 1 — intent, run on the call path BEFORE dispatch.
   *
   * - `enforce`: a SYNCHRONOUS local append. It deliberately does NOT swallow
   *   errors — a throw propagates so the gateway refuses the call ("no log → no
   *   action"). Intentionally independent of `enabled`: enforce is a hard
   *   auditability guarantee, not a metrics nicety, so the intent is recorded
   *   even when result-capture is toggled off.
   * - `best-effort`: a no-op. No synchronous gate; the async result log is the
   *   only record — exactly the pre-mandatory-audit behaviour, so the call path
   *   is byte-for-byte unchanged.
   *
   * The append is local-only: no network and no awaited I/O on the call path.
   */
  recordIntent(intent: ToolCallIntent): void {
    if (this.policy !== "enforce") return;
    // A policy change waiting for the chain goes in before what it governs;
    // if it still cannot, neither can this intent.
    this.drainPolicyRecords();
    if (this.pendingPolicyRecords.length > 0) {
      throw new Error("audit chain unavailable (policy record pending)");
    }
    this.ensureLog().append({
      event: MCP_TOOL_CALL_INTENT_EVENT,
      subject: intent.plugin,
      detail: {
        tool: ToolCallSink.clamp(intent.tool, ToolCallSink.MAX_TOOL_LEN),
        agent_id: intent.agent_id,
        event_ts: intent.ts,
      },
    });
  }

  /**
   * Boot provenance — record the active policy once at start. Synchronous local
   * append, emitted only under `enforce` (best-effort must stay write-free at
   * boot to preserve the pre-mandatory-audit behaviour). Best-effort about its
   * OWN failure: a boot record must never crash daemon start, so it swallows.
   */
  recordPolicy(): void {
    if (this.policy !== "enforce") return;
    this.queuePolicyRecord({ policy: this.policy, changed_at: new Date().toISOString() });
    this.drainPolicyRecords();
  }

  /**
   * Apply the policy resolved from settings (`settings.mcp.audit`), at boot and
   * on every settings reload. The first application records the boot
   * provenance (enforce only, so best-effort stays write-free). Every later
   * CHANGE is recorded in either direction: a switch from enforce to
   * best-effort is exactly the window an auditor needs to see, and without it
   * the chain would read "enforce" across calls that were never gated.
   * A record that cannot be written (chain down at that moment) is kept and
   * written, in order, before the next intent, result batch or reload that
   * reaches the chain; past the queue bound the oldest is dropped and the
   * next record carries the count. Unchanged and nothing pending → nothing.
   */
  applyPolicy(policy: AuditPolicy): void {
    const now = new Date().toISOString();
    if (!this.policyApplied) {
      this.policyApplied = true;
      this.policy = policy;
      if (policy === "enforce") this.queuePolicyRecord({ policy, changed_at: now });
    } else if (policy !== this.policy) {
      this.queuePolicyRecord({ policy, previous: this.policy, changed_at: now });
      this.policy = policy;
    }
    this.drainPolicyRecords();
  }

  private queuePolicyRecord(record: PendingPolicyRecord): void {
    if (this.pendingPolicyRecords.length >= ToolCallSink.MAX_PENDING_POLICY_RECORDS) {
      this.pendingPolicyRecords.shift();
      this.droppedPolicyRecords++;
    }
    this.pendingPolicyRecords.push(record);
  }

  /** Write pending policy records in order; stop at the first failure and
   *  keep the rest. Never throws. */
  private drainPolicyRecords(): void {
    while (this.pendingPolicyRecords.length > 0) {
      if (!this.appendPolicyRecord(this.pendingPolicyRecords[0])) return;
      this.pendingPolicyRecords.shift();
    }
  }

  /** Swallows its own failure (reported as `false`): a policy record must
   *  never crash daemon start, a settings reload or a call — the per-call
   *  gate is what enforces. Without `record`, the active policy (boot). */
  private appendPolicyRecord(record?: PendingPolicyRecord): boolean {
    try {
      this.ensureLog().append({
        event: MCP_AUDIT_POLICY_EVENT,
        detail: {
          policy: record ? record.policy : this.policy,
          ...(record?.previous !== undefined ? { previous: record.previous } : {}),
          ...(record ? { changed_at: record.changed_at } : {}),
          ...(record && this.droppedPolicyRecords > 0
            ? { dropped_before: this.droppedPolicyRecords }
            : {}),
          recorded_at: new Date().toISOString(),
        },
      });
      if (record) this.droppedPolicyRecords = 0;
      return true;
    } catch {
      // Provenance is documentation; the per-call gate is what enforces.
      return false;
    }
  }

  /** PHASE 2 — result. HOT PATH. Synchronous, O(1), never throws, never awaited. */
  record(event: ToolCallEvent): void {
    if (!this.enabled) return;
    if (this.buffer.length >= ToolCallSink.MAX_BUFFER) return;
    this.buffer.push(event);
    this.armFlush();
  }

  private armFlush(): void {
    if (!this.autoFlush) return;
    if (this.flushArmed) return;
    this.flushArmed = true;
    const t = setTimeout(() => {
      this.flushArmed = false;
      this.flush();
    }, 0);
    // Don't keep the event loop alive for a telemetry flush.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  }

  /**
   * Drain the buffer into the audited chain. Runs OFF the request path (timer
   * macrotask in production; callable directly in tests for determinism).
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    // Materialise the chain BEFORE detaching the batch: if the backing log can't
    // be built, keep the events buffered (bounded by MAX_BUFFER) for the next
    // flush rather than silently dropping the batch and wedging telemetry.
    let log: AuditLogLike;
    try {
      log = this.ensureLog();
    } catch {
      return;
    }
    // A policy change waiting for the chain goes in before what it governs;
    // until it does, the results stay buffered (bounded by MAX_BUFFER).
    this.drainPolicyRecords();
    if (this.pendingPolicyRecords.length > 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      for (const e of batch) {
        log.append({
          event: MCP_TOOL_CALL_EVENT,
          subject: e.plugin,
          detail: {
            tool: ToolCallSink.clamp(e.tool, ToolCallSink.MAX_TOOL_LEN),
            agent_id: e.agent_id,
            status: e.status,
            duration_ms: e.duration_ms,
            event_ts: e.ts,
            ...(e.error !== undefined
              ? { error: ToolCallSink.clamp(e.error, ToolCallSink.MAX_ERROR_LEN) }
              : {}),
          },
        });
      }
    } catch {
      // Fire-and-forget: a sink failure must never surface on the call path.
    }
  }

  /** Bound a caller- or child-supplied string before it is persisted + retained. */
  private static clamp(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
  }

  /** Test helper — events buffered but not yet flushed. */
  pending(): readonly ToolCallEvent[] {
    return this.buffer;
  }
}

let sink: ToolCallSink | null = null;

export function getToolCallSink(): ToolCallSink {
  if (!sink) sink = new ToolCallSink();
  return sink;
}

/** The one Phase-2 call the gateway makes per terminal path. Fire-and-forget. */
export function recordToolCall(event: ToolCallEvent): void {
  getToolCallSink().record(event);
}

/**
 * The Phase-1 call the gateway makes before dispatch. Under `enforce` this can
 * THROW — the caller MUST treat a throw as "refuse the call". Under best-effort
 * it is a no-op and never throws.
 */
export function recordToolCallIntent(intent: ToolCallIntent): void {
  getToolCallSink().recordIntent(intent);
}

/** Test seam — swap in an isolated sink (e.g. `new ToolCallSink(tmpPath)`). */
export function __setToolCallSinkForTest(s: ToolCallSink | null): void {
  sink = s;
}
