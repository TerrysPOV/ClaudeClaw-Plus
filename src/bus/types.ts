/**
 * ClaudeClaw+ Bus runtime — shared types.
 *
 * Sources of truth:
 * - `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5 (component specs)
 * - `docs/spikes/0.1-permission-flow.md` (permission flow shape)
 * - `docs/spikes/0.2-jsonl-schema-snapshot.md` (JSONL line types)
 *
 * Sprint 1 scope: BusEvent, AgentConfig, Permission flow, IPC message
 * shapes, runner-selection types. Full JSONL line-type enumeration is
 * Sprint 2 (JSONL Tailer). Skeleton types provided here for forward
 * compatibility — the Tailer fills in the rest.
 */

/* ───────────────────────────────────────────────────────────────────── */
/* Origins + runner selection                                            */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * External surface that originated a prompt. Used by Session Manager
 * to pick the right supervision mode per spec §5.3 + Probe 0.6 outcome.
 */
export type BusOrigin =
  | "discord"
  | "telegram"
  | "slack"
  | "webui"
  | "cron"
  | "heartbeat"
  | "cli"
  | "rest";

/**
 * Channel-driven origins need the REPL (Channels can't reach `-p` mode
 * per Probe 0.6). Non-channel origins can use the lighter
 * `process-stream-json` runner.
 */
export const CHANNEL_DRIVEN_ORIGINS: ReadonlySet<BusOrigin> = new Set([
  "discord",
  "telegram",
  "slack",
  "webui",
]);

/**
 * Supervision mode per §5.3.
 */
export type SupervisionMode =
  | "pty-stdin" // default for channel-driven; bun-pty for TTY, stdout ignored
  | "process-stream-json" // default for non-channel; `claude -p --input-format=stream-json`
  | "tmux" // opt-in: detached tmux for pane-attach inspection
  | "process"; // Windows fallback only — slash commands won't work

export function defaultSupervisionFor(origin: BusOrigin): SupervisionMode {
  return CHANNEL_DRIVEN_ORIGINS.has(origin) ? "pty-stdin" : "process-stream-json";
}

/* ───────────────────────────────────────────────────────────────────── */
/* BusEvent — single normalised event shape                              */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Bus event topic. The Bus's external API depends on these names being
 * stable regardless of the underlying JSONL or notification source.
 *
 * `system.<subtype>` and `attachment.<subtype>` are open-ended families;
 * Sprint 2's JSONL Tailer enumerates the actual subtype space.
 */
export type BusEventTopic =
  | "prompt"
  | "response.text"
  | "response.tool_use"
  | "response.edit_text"
  | "response.thinking"
  | "tool_result"
  | "usage"
  | "session.init"
  | "session.compact"
  | "session.end"
  | "session.permission_mode_change"
  | "session.title"
  | "session.agent_name"
  | "session.custom_title"
  | "session.pr_link"
  | "session.last_prompt"
  | "session.queue"
  | "session.file_snapshot"
  | "channel.permission_request"
  | "channel.permission_response"
  | `attachment.${string}`
  | `system.${string}`
  /**
   * Bus-internal control events emitted by infrastructure (Tailer, schema
   * probe, etc.). Sprint 2 introduces:
   *  - `bus.events.replay_done` — JSONL Tailer finished historical replay
   *    and is now live-tailing (spec §5.2).
   *  - `bus.event.unknown` — JSONL Tailer encountered an unrecognised line
   *    type; payload carries the raw line for forward-compat audit
   *    (spec §11.1).
   */
  | `bus.${string}`;

export interface BusEvent<P = unknown> {
  /** Milliseconds since epoch. */
  ts: number;
  /** Stable agent slug (`agent_id`). */
  agent_id: string;
  /** Stable session UUID (the `--session-id` argument to claude). */
  session_id: string;
  /** Topic per BusEventTopic. */
  topic: BusEventTopic;
  /** Topic-specific payload. */
  payload: P;
  /** Original JSONL line or MCP message — kept for audit. */
  raw?: unknown;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Permission flow (§5.1 v2.2)                                           */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Inbound: Claude → plugin via `notifications/claude/channel/permission_request`.
 * Schema validated empirically against aerolalit reference plugin
 * (Spike 0.1, `server.ts:420` zod schema).
 */
export interface PermissionRequest {
  /** `[a-km-z]{5}` lowercase (Spike 0.1 finding). */
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/**
 * Outbound: plugin → Claude via `notifications/claude/channel/permission`.
 * Note: field is `behavior` NOT `decision`, and no `reason?` field
 * (Spike 0.1 binary inspection at `server.ts:774,933`).
 */
export interface PermissionResponse {
  request_id: string;
  behavior: "allow" | "deny";
}

/** `request_id` charset assertion — useful as probe/test invariant. */
export const REQUEST_ID_PATTERN = /^[a-km-z]{5}$/;

/* ───────────────────────────────────────────────────────────────────── */
/* AgentConfig + Session Manager surface                                 */
/* ───────────────────────────────────────────────────────────────────── */

export interface AgentConfig {
  /** Stable slug. Becomes part of socket path (max ~36 chars on macOS). */
  id: string;
  /** Working directory. Tailer must realpath() before encoding. */
  cwd: string;
  /** UUID passed to `claude --session-id`. Stable across restarts. */
  session_id: string;
  /** Default permission mode for spawned claude. */
  permission_mode?: "plan" | "bypassPermissions" | "default";
  /** Optional path to system prompt addendum. */
  system_prompt_file?: string;
  /** Optional path to per-agent MEMORY.md. */
  memory_file?: string;
  /** Optional path to per-agent MCP config (extra MCP servers). */
  mcp_config?: string;
  /** Override the supervision default chosen from origin. */
  supervision?: SupervisionMode;
}

/* ───────────────────────────────────────────────────────────────────── */
/* IPC (Bus core ↔ Bus MCP server) — wire format                         */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Length-prefixed JSON over UDS / named pipe / localhost-TCP.
 * Sprint 1 ships only the message types Bus core ↔ Bus MCP need.
 * Each transport per §5.4 frames with `<uint32-be length><json bytes>`.
 */
export type IpcMessage =
  | IpcHello
  | IpcPrompt
  | IpcReply
  | IpcEditMessage
  | IpcAsk
  | IpcAskAnswer
  | IpcCancel
  | IpcRequestHuman
  | IpcPermissionRequest
  | IpcPermissionResponse
  | IpcError;

export interface IpcHello {
  type: "hello";
  agent_id: string;
  /** From the MCP capabilities. */
  capabilities: string[];
}

export interface IpcPrompt {
  type: "prompt";
  agent_id: string;
  origin: BusOrigin;
  origin_id: string;
  user_id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface IpcReply {
  type: "reply";
  agent_id: string;
  text: string;
  intent: "final" | "progress" | "tool_status";
}

/**
 * Edit the agent's most-recent outbound message on its surface — for in-place
 * progress updates. No message_id: the adapter remembers the last bot message
 * it sent per agent and edits that, falling back to a new send if none exists.
 */
export interface IpcEditMessage {
  type: "edit_message";
  agent_id: string;
  text: string;
}

export interface IpcAsk {
  type: "ask";
  agent_id: string;
  ask_id: string;
  question: string;
}

export interface IpcAskAnswer {
  type: "ask_answer";
  agent_id: string;
  ask_id: string;
  answer: string;
}

export interface IpcCancel {
  type: "cancel";
  agent_id: string;
  reason?: string;
}

export interface IpcRequestHuman {
  type: "request_human";
  agent_id: string;
  /**
   * Correlation id for the eventual `IpcAskAnswer` carrying the human's
   * reply. The MCP server allocates this when the tool is invoked; the
   * adapter MUST echo the same value in its `IpcAskAnswer` so the MCP
   * server can resolve the blocking tool-call promise.
   *
   * Without this id, `request_human` calls block indefinitely (Codex P1
   * on PR #110 — Sprint 1 fix-up).
   */
  ask_id: string;
  question: string;
}

export interface IpcPermissionRequest {
  type: "permission_request";
  agent_id: string;
  request: PermissionRequest;
}

export interface IpcPermissionResponse {
  type: "permission_response";
  agent_id: string;
  response: PermissionResponse;
}

export interface IpcError {
  type: "error";
  agent_id?: string;
  code: string;
  message: string;
}

/* ───────────────────────────────────────────────────────────────────── */
/* JSONL line types (skeleton; Sprint 2 fills in)                        */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Common envelope fields seen across every JSONL line in Spike 0.2 fixtures.
 * Sprint 2 expands this with the discriminated union of line types.
 */
export interface JsonlEnvelope {
  uuid: string;
  parentUuid: string | null;
  isSidechain?: boolean;
  timestamp: string; // ISO 8601
  userType?: "external" | "internal";
  entrypoint?: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: string; // discriminator — Sprint 2 narrows
}

/* ───────────────────────────────────────────────────────────────────── */
/* Constants from spec §5.4                                              */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Max bytes for the FINAL UDS path on macOS (sun_path is 104; atomic-create
 * `.tmp` adds 4B; safety margin leaves 96B). Per Spike 0.3 finding.
 */
export const UDS_PATH_MAX_BYTES = 96;
