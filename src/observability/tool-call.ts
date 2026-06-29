/**
 * The uniform MCP tool-call event — the atom of the Phase A observability hub.
 *
 * The gateway (mcp-multiplexer) emits ONE of these per `tools/call`, for every
 * plugin, with no per-plugin code. Boundary metrics only: call args are reduced
 * to a stable, non-reversible hash (`args_hash`) — raw args never leave the call
 * scope (privacy/audit). External (upstream) traffic is out of scope; this is the
 * gateway boundary, and depth is plugin-opt-in via the view-manifest.
 */

import { createHash } from "node:crypto";

/** The telemetry stream id AND the audit event name share this literal. */
export const MCP_TOOL_CALL_STREAM = "mcp.tool_call" as const;
export const MCP_TOOL_CALL_EVENT = "mcp.tool_call" as const;
/** Phase 1 (mandatory-audit) intent record — distinct from the result event so
 *  the metrics producer never counts an intent as a completed call. */
export const MCP_TOOL_CALL_INTENT_EVENT = "mcp.tool_call_intent" as const;
/** Boot-provenance record naming the active mandatory-audit policy. */
export const MCP_AUDIT_POLICY_EVENT = "mcp.audit_policy" as const;

/**
 * Mandatory-audit policy for the gateway, resolved from config (`settings.mcp.audit`).
 *
 * - `enforce`: an action that cannot be logged is REFUSED (fail-closed). The
 *   Phase-1 intent append is SYNCHRONOUS and a failure refuses the call —
 *   "no log → no action". Safe because the append is a cheap LOCAL write.
 * - `best-effort` (default, backward-compatible): logging is fully async
 *   fire-and-forget and can never block or fail a call. No synchronous intent
 *   gate; the result log is the only record (exactly the pre-mandatory-audit
 *   behaviour).
 */
export type AuditPolicy = "enforce" | "best-effort";

export type ToolCallStatus = "ok" | "error";

export interface ToolCallEvent {
  /** ISO-8601 — the call's own timestamp, not the (possibly later) flush time. */
  ts: string;
  /** Upstream MCP server name = the plugin label the hub auto-discovers on. */
  plugin: string;
  tool: string;
  /** PTY/bucket identity the call was dispatched under. */
  agent_id: string;
  status: ToolCallStatus;
  duration_ms: number;
  args_hash: string;
  /** Present only on `status: "error"`. */
  error?: string;
}

/**
 * The Phase-1 INTENT atom: what the gateway records BEFORE dispatching a tool
 * call. No `status`/`duration_ms` — the call hasn't run yet. Under `enforce`
 * this is written synchronously and a write failure refuses the call.
 */
export interface ToolCallIntent {
  /** ISO-8601 — when the intent was recorded (pre-dispatch). */
  ts: string;
  plugin: string;
  tool: string;
  /** PTY/bucket identity the call is dispatched under. */
  agent_id: string;
  args_hash: string;
}

/**
 * Stable, non-reversible digest of call arguments. 16 hex chars is enough to
 * spot identical-arg repeats without exposing — or being able to reconstruct —
 * the payload. Never throws (falls back to a string coercion for exotic input).
 */
export function hashArgs(args: unknown): string {
  let serial: string;
  try {
    serial = JSON.stringify(args ?? null);
  } catch {
    serial = String(args);
  }
  return createHash("sha256").update(serial).digest("hex").slice(0, 16);
}
