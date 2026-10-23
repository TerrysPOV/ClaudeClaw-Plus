/**
 * Bus Core — in-process pub/sub broker.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.4.
 *
 * Responsibilities:
 *   - Accept inbound prompts from adapters (`sendPrompt`) and forward them
 *     to the right `claude` session via the Bus MCP IPC channel.
 *   - Fan-out `BusEvent`s to subscribers (adapters, web UI) with per-
 *     subscriber ringbuffer backpressure.
 *   - Audit-log every `BusEvent` to the existing event log (subset of the
 *     `EventLog` infrastructure — Bus core is NOT a parallel primitive).
 *   - Host the IPC server (UDS) that the Bus MCP plugin (`mcp-server.ts`,
 *     Agent B) connects to.
 *
 * Sprint 1 scope:
 *   - UDS transport only. TCP+token fallback is a Sprint 1.1 follow-up
 *     (see `core-ipc.ts` TODO comments).
 *   - In-process subscribe()/sendPrompt()/ingest*() surface complete.
 *   - `invokeSlashCommand()` delegates to a session-manager hook (Agent C);
 *     Sprint 1 provides the callback seam so the e2e test can wire it.
 *
 * Non-goals for Sprint 1:
 *   - JSONL tailer integration (Sprint 2).
 *   - Gateway policy/dedupe coupling (Sprint 3 — for now we run the audit
 *     write directly; Sprint 3 wraps it back in the Gateway flow per §5.4).
 */

import { randomUUID } from "node:crypto";
import type { EventRecord, EventEntryInput } from "../event-log";
import { append as eventLogAppend } from "../event-log";
import { bindUdsServer, encodeFrame, resolveDefaultUdsPath, type IpcServer } from "./core-ipc";
import { sanitizePtyPromptText } from "../runner/pty-prompt-sanitizer";
import {
  DEFAULT_RINGBUFFER_CAPACITY,
  drainSubscriber,
  enqueueForSubscriber,
  matchesFilter,
  type Subscription,
  type SubscriberRecord,
  type SubscriptionFilter,
  type SubscriptionHandler,
} from "./core-subscription";
import type {
  BusEvent,
  BusEventTopic,
  BusOrigin,
  IpcAskAnswer,
  IpcJobRequest,
  IpcJobResult,
  IpcMessage,
  IpcPermissionResponse,
  IpcPrompt,
  PermissionRequest,
  PermissionResponse,
  PromptDeliveryOutcome,
} from "./types";
import { CHANNEL_DRIVEN_ORIGINS } from "./types";
import {
  endsWithQuestion,
  hasAttachments,
  isAnsweredRepeat,
  isBareAcknowledgement,
  type SeenPrompt,
  seenKey,
} from "./ack-prompt";
import type { AgentJobHandler, JobView } from "./agent-jobs";

/**
 * Map a `JobView` to the snake_case shape agents see over the tools (#296 PR 3
 * Codex review). The `dispatch_job` contract and `job_status`/`list_jobs`/
 * `cancel_job` all speak `job_id`, so the wire representation must too — the
 * runner's internal camelCase (`jobId`, `createdAt`, …) never leaks to agents.
 */
function toWireJobView(v: JobView): Record<string, unknown> {
  return {
    job_id: v.jobId,
    agent: v.agent,
    dispatcher: v.dispatcher,
    status: v.status,
    created_at: v.createdAt,
    ...(v.startedAt !== undefined ? { started_at: v.startedAt } : {}),
    ...(v.endedAt !== undefined ? { ended_at: v.endedAt } : {}),
    ...(v.exitCode !== undefined ? { exit_code: v.exitCode } : {}),
    ...(v.resultText !== undefined ? { result_text: v.resultText } : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
  };
}
import { evaluate, type PolicyDecision, type ToolRequestContext } from "../policy/engine";
import {
  deleteScheduledTask,
  listScheduledTasks,
  scheduleTask,
  type ScheduleTaskInput,
} from "./schedule-ops";

/** Escape XML text content (`&`, `<`, `>`) so a `</channel>` in user text
 *  can't close the wrapper element early and inject sibling markup. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an XML attribute value: text escaping plus the `"` delimiter. */
function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

/* ───────────────────────────────────────────────────────────────────── */
/* Public types                                                          */
/* ───────────────────────────────────────────────────────────────────── */

export type SendPromptRequest = {
  agent_id: string;
  origin: BusOrigin;
  origin_id: string;
  user_id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type SendPromptAck = {
  promise_id: string;
  ipc_sent?: boolean;
  /** #239: the prompt is waiting behind the agent's active turn. It keeps its
   *  `promise_id`; `ipc_sent` is unknown until it is admitted. */
  queued?: true;
};

type QueuedPrompt = { req: SendPromptRequest; promise_id: string; queuedAt: number };

/** #239: the shape a delivered prompt and its transcript line agree on. The
 *  PTY is fed `sanitizePtyPromptText` output (a TAB survives it) while the CLI
 *  records what its input box parsed (a pasted TAB becomes spaces, a typed one
 *  is a completion key and vanishes) — the same disagreement the PTY layer's
 *  own matcher drops whitespace for (issue #362). A prompt the TUI took as a
 *  paste is recorded wrapped in `<pasted_content id="…">…</pasted_content
 *  id="…">` (every long prompt on CLI 2.1.296); the tags are the CLI's, so
 *  they go too, as in the PTY layer's `normalizePromptForMatch` — otherwise a
 *  long prompt's own transcript line never matches (#428). */
function promptLineKey(text: string): string {
  return stripPasteTags(sanitizePtyPromptText(text)).replace(/\s+/g, "");
}

/** #428: drop the CLI's `<pasted_content …>` wrapper from a recorded line. */
function stripPasteTags(text: string): string {
  return text.replace(/<\/?pasted_content\b[^>]*>/g, "");
}

/** #239: thrown by `sendPrompt` when an origin already has `promptQueueCapPerOrigin`
 *  prompts waiting on the agent. The newest is refused, never a queued one. */
export class PromptQueueFullError extends Error {
  readonly agent_id: string;
  readonly origin: BusOrigin;
  readonly origin_id: string;
  constructor(
    agent_id: string,
    origin: BusOrigin,
    origin_id: string,
    cap: number,
    scope: "origin" | "agent",
  ) {
    // The chat id stays out of the message (it reaches logs); it is on the
    // error object for callers that need it.
    super(
      `prompt queue full for agent=${agent_id} origin=${origin} ` +
        `(${scope} cap ${cap}) — the agent's current turn has not ended`,
    );
    this.name = "PromptQueueFullError";
    this.agent_id = agent_id;
    this.origin = origin;
    this.origin_id = origin_id;
  }
}

export type IngestReplyRequest = {
  agent_id: string;
  text: string;
  intent: "final" | "progress" | "tool_status";
  /** #224: the `origin_id` (chat) this reply answers, as the agent read it in the
   *  `<channel>` block. Honoured only when that chat has prompted this agent. */
  in_reply_to?: string;
};

export type IngestPermissionDecisionRequest = {
  agent_id: string;
  request_id: string;
  behavior: "allow" | "deny";
};

export interface BusState {
  subscriberCount: number;
  /** Map of agent_id → connected (handshake completed). */
  connectedAgents: string[];
  /** Total ringbuffer overflows across all subscribers. */
  totalOverflows: number;
}

/**
 * Optional event-log write fn so tests can substitute a memory writer.
 */
export type EventLogAppendFn = (entry: EventEntryInput) => Promise<EventRecord>;

/**
 * Callback invoked when an adapter requests a slash command. The Session
 * Manager (Agent C) is the eventual implementation — Sprint 1 provides
 * the seam.
 */
export type SlashCommandHandler = (agent_id: string, cmd: string) => Promise<void>;

/**
 * Delivers an inbound prompt to an agent process as REPL input (PTY-stdin
 * supervision). Wired by the Session Manager. When set, `sendPrompt` invokes
 * it so headless (daemon-spawned) claudes — which can't be relied on to start a
 * turn from the MCP notification alone (older builds never did; current ones
 * usually do) — receive the prompt as typed input and reliably respond. An
 * agent this leg reaches (see {@link PtyReachableCheck}) gets no
 * `notifications/claude/channel` copy of the same prompt (#428).
 *
 * May resolve with the process's delivery verdict (issue #361). A handler
 * that resolves `void` is taken at its word, as before.
 */
export type StreamPromptHandler = (
  agent_id: string,
  text: string,
) => Promise<PromptDeliveryOutcome | void>;

/**
 * Whether the PTY leg can currently deliver to this agent (#428). When it can,
 * `sendPrompt` sends no IPC `prompt` frame: the MCP server would turn it into
 * a channel notification that starts a turn of its own, and the agent got the
 * prompt twice. Wired by the daemon to `canStreamToAgent` (`receipt-wiring.ts`).
 * Defaults to `streamPromptHandler !== null` until wired.
 */
export type PtyReachableCheck = (agent_id: string) => boolean;

/**
 * Whether the agent's claude is spawned but not yet recorded as ours (#595 r5). Non-null while it
 * is: the promise resolves once the agent can be given a prompt and REJECTS if it could not be
 * recorded (the spawn is failing). This is a state of its own, not "unreachable": an unreachable PTY
 * sends the prompt over IPC instead, and an unrecorded claude must receive it on neither transport.
 * Wired by the daemon to `SessionManager.recordingPending`; null means nothing is pending.
 */
export type RecordingPendingCheck = (agent_id: string) => Promise<void> | null;

/**
 * Model input was not delivered because its agent's claude was not recorded (#595 r5): the record
 * write failed (`recording-failed`, the agent is being retired), did not settle within the delivery
 * backstop (`recording-timeout`), or the sender could not wait (`recording-pending`, the typed
 * refusal). It reached neither transport.
 */
export class AgentNotRecordedError extends Error {
  constructor(
    readonly agent_id: string,
    readonly reason: "recording-failed" | "recording-timeout" | "recording-pending",
  ) {
    super(`model input not delivered to agent_id=${agent_id}: reason=${reason}`);
    this.name = "AgentNotRecordedError";
  }
}

/**
 * #595 r7: the frames Bus core sends the MCP server, split by what the MCP server does with them.
 * A MODEL-INPUT frame becomes a `notifications/claude/channel` notification (or the next thing the
 * model reads) and can start a turn, so it must not reach a claude that is not yet recorded as ours:
 * `emitModelInput` is the only sender of these. A CONTROL frame answers a request the claude itself
 * made (a permission prompt, a job call) and starts nothing: `emitControl` sends those. Adding a
 * Bus-core-to-MCP frame type means choosing one of the two here; `IpcServer.send` is called from
 * nowhere else.
 */
export type ModelInputFrame = IpcPrompt | IpcAskAnswer;
export type ControlFrame = IpcPermissionResponse | IpcJobResult;

/** What `emitModelInput` did. `recording-pending` carries the promise a caller that can wait waits on. */
export type ModelInputSend =
  | { status: "sent" }
  | { status: "no-connection" }
  | { status: "recording-pending"; pending: Promise<void> };

export interface BusCoreOptions {
  /** Path to bind the UDS server. If omitted, no IPC server is started. */
  socketPath?: string;
  /** Event-log writer. Default uses the project event-log singleton. */
  eventLogAppend?: EventLogAppendFn;
  /** Ringbuffer cap per subscriber. */
  ringbufferCapacity?: number;
  /** Backstop (ms) for the delivery gate: max time a prompt is held while the
   *  agent's session (re)initialises before it's flushed even without a
   *  `replay_done`. Defaults to 4000. Lowered in tests. */
  deliveryBackstopMs?: number;
  /** After a BACKSTOP flush (timer-driven, not a real `replay_done`), the
   *  session may still be mid-(re)init and swallow the keystroke, so the prompt
   *  never starts a turn (the socket=no wedge, dossier 20260613T033017). Verify
   *  a turn actually starts within this window; if not, re-deliver ONCE. Only
   *  the backstop path is verified — the real `replay_done` path is known-ready.
   *  Defaults to 8000. Lowered in tests. */
  flushVerifyMs?: number;
  /** Grace (ms) after a delivery handler settles before a verify re-delivers,
   *  to let the asynchronous turn-start tailer event land first. Default 1500. */
  flushVerifyGraceMs?: number;
  /** #402: how long a prompt whose PTY delivery gave up on `stuck-compaction`
   *  is held for the compaction to end (`session.compact` from the tailer)
   *  before the same verify-then-re-deliver rule is applied anyway. Defaults to
   *  600000 (10 min, ≫ the PTY layer's own compaction budget). Lowered in tests. */
  stuckCompactionResolveMs?: number;
  /** #239: how long an admitted turn may go without ANY sign of life — no
   *  event for the agent, no delivery-layer transition — before the bus stops
   *  waiting for its terminator, releases the operation slot and admits the
   *  next queued prompt. Without it a turn that never terminates would leave
   *  the agent deaf to every origin (the #372 leak, turned from a mis-stamp
   *  into a stall by serialization). Defaults to 900000 (15 min: above the
   *  10-min compaction hold and the CLI's longest tool call). It is also the
   *  bound for an agent no transcript feeds (IPC-only, no tailer), whose turns
   *  never produce the `response.turn_end` that frees the slot. Lowered in
   *  tests. */
  turnDeadlineMs?: number;
  /** #239: cap on prompts one origin (surface + chat) may have waiting behind
   *  an active turn; the newest is refused past it. Defaults to 32. */
  promptQueueCapPerOrigin?: number;
  /** #239: cap on prompts waiting on one agent across every origin, so the
   *  number of origins cannot grow the queue without bound either. Defaults
   *  to 256. */
  promptQueueCapPerAgent?: number;
  /** #239 / #405: how long after a `response.turn_end` the next queued prompt
   *  is admitted. The CLI writes one line per content block and repeats the
   *  terminal stop_reason on each, so a thinking+text message ends in TWO
   *  boundary lines for one turn; admitting on the first would run the
   *  silent-drop net for the second against the newcomer's state (its origin,
   *  its reply flags) — the very misroute #239 closes. The CLI writes both
   *  lines together at message end; the settle lets them both land, with
   *  margin for a stalled event loop splitting the read. Defaults to 1000.
   *  `0` admits on the first line synchronously (tests, or a transcript whose
   *  terminal message is known to be one line). A line that still arrives
   *  after an admission is dropped rather than routed to the newcomer. */
  turnEndSettleMs?: number;
  /** Slash-command delegate (Agent C wires this). */
  slashCommandHandler?: SlashCommandHandler;
  /** REPL prompt delegate for PTY-stdin agents. Wired by the Session Manager. */
  streamPromptHandler?: StreamPromptHandler;
  /** See {@link PtyReachableCheck}. Also settable via `setPtyReachableHandler`. */
  ptyReachable?: PtyReachableCheck;
  /** Logger; defaults to console.error. */
  onError?: (err: unknown, ctx?: Record<string, unknown>) => void;
  /**
   * Policy evaluator for the per-tool permission gate (#258 item 3). Defaults to
   * the policy-engine singleton `evaluate`; injectable so tests (and future
   * callers) supply a deterministic decision without the global rule file.
   */
  evaluatePolicy?: (ctx: ToolRequestContext) => PolicyDecision;
  /**
   * Reconciliation signal (issue #222). Fired when an IPC `send` to an agent
   * fails because Bus core has no live MCP connection for it. The daemon
   * wires this to a debounced reconciler that checks process liveness via
   * the Session Manager and respawns the agent if it's alive-but-deaf
   * (process up, MCP/IPC registration gone). Default no-op so the bus is
   * usable without the wiring (and in tests).
   */
  onMcpSendFailed?: (agentId: string, ctx: { reason: string }) => void;
  /**
   * Agent-job handler (issue #296 PR 3). Set by the daemon so inbound
   * `job_request` IPC (from an agent's `dispatch_job`/`job_status`/`list_jobs`/
   * `cancel_job` tool) routes to the daemon-resident `AgentJobRunner`. Omitted
   * in tests / when agent jobs are disabled — a `job_request` then gets a clean
   * "not enabled" error rather than a hang. Also settable post-hoc via
   * `setJobHandler` (the runner needs `sendPrompt`, so it's constructed AFTER
   * the bus — same late-binding pattern as `slashCommandHandler`).
   */
  jobHandler?: AgentJobHandler;
  /**
   * Reply-tool enforcement (#215/#240). When an agent ends a channel-driven
   * turn with text but never calls `reply`, the bus first nudges it to call
   * `reply` (a curated reply beats a synthesized raw dump), and only synthesizes
   * the labeled safety-net delivery if the nudged turn ALSO skips `reply`.
   * Set to `false` to disable the nudge and synthesize immediately (the
   * pre-nudge #217 behaviour) — a kill switch for the live path. Default true.
   */
  replyNudge?: boolean;
}

/* ───────────────────────────────────────────────────────────────────── */
/* BusCore                                                               */
/* ───────────────────────────────────────────────────────────────────── */

export interface BusCore {
  /**
   * Resolves once the prompt is published and handed to its delivery leg —
   * the PTY when it reaches the agent, else the IPC `prompt` frame (#428).
   * `ipc_sent` reports the IPC leg (#390): `false` means the bus has no MCP
   * connection for the agent, so the prompt reached the PTY only and the
   * agent's `reply` tool has no channel back — a caller that awaits the
   * reply can tell its user now instead of at its own timeout. `undefined`
   * when the bus runs without an IPC server (in-process / tests).
   *
   * #239: one active turn per agent. A prompt arriving while the agent still
   * owes a terminator for an earlier one is QUEUED — the ack then carries
   * `queued: true` and no `ipc_sent`, and the prompt is delivered (with the
   * same `promise_id`) once the running turn ends or the turn deadline
   * releases it. Rejects with `PromptQueueFullError` past the per-origin cap.
   */
  sendPrompt(req: SendPromptRequest): Promise<SendPromptAck>;
  /** #239: prompts waiting behind an active turn on this agent, admission order. */
  queuedPrompts(
    agentId: string,
  ): ReadonlyArray<{ promise_id: string; origin: BusOrigin; origin_id: string }>;
  /** #239: drop a prompt still waiting (a caller that gave up on its reply);
   *  `false` once it was admitted. Optional: mocks need not implement it. */
  withdrawQueuedPrompt?(agentId: string, promise_id: string): boolean;
  /**
   * Whether the bus currently holds an MCP connection for the agent (#390).
   * Optional: mocks and in-process buses without an IPC server need not
   * implement it; callers treat `undefined` as "unknown".
   */
  hasIpcConnection?(agentId: string): boolean;
  subscribe(filter: SubscriptionFilter, handler: SubscriptionHandler): Subscription;
  invokeSlashCommand(agent_id: string, cmd: string): Promise<void>;
  /**
   * Install or replace the slash-command delegate. Sprint 4 wiring path
   * (spec §6.3): a `BusCore` is constructed before the `SessionManager`
   * is available, so the handler must be settable post-hoc rather than
   * being a constructor-only option. Pass `null` to detach.
   */
  setSlashCommandHandler(handler: SlashCommandHandler | null): void;
  setStreamPromptHandler(handler: StreamPromptHandler | null): void;
  /**
   * Install or replace the {@link PtyReachableCheck}. Pass `null` to reset to
   * the default. Optional: mocks need not implement it.
   */
  setPtyReachableHandler?(handler: PtyReachableCheck | null): void;
  /**
   * Install or replace the {@link RecordingPendingCheck}. Pass `null` to detach. Optional: mocks
   * need not implement it.
   */
  setRecordingPendingHandler?(handler: RecordingPendingCheck | null): void;
  /**
   * Install or replace the agent-job handler (#296 PR 3). The daemon wires
   * this once the `AgentJobRunner` is constructed (which needs `sendPrompt`,
   * so it can't be a constructor-only option). Pass `null` to detach on
   * teardown. When unset, inbound `job_request` IPC is answered with a clean
   * "agent jobs not enabled" error.
   */
  setJobHandler(handler: AgentJobHandler | null): void;
  /**
   * Install or replace the #222 reconciliation signal handler. Wired by the
   * bus runtime once the Session Manager is available. Pass `null` to detach
   * (resets to a no-op).
   */
  setMcpSendFailedHandler(
    handler: ((agentId: string, ctx: { reason: string }) => void) | null,
  ): void;
  /** True if Bus core currently holds a live MCP/IPC connection for the agent (#222). */
  isAgentConnected(agentId: string): boolean;
  /** True if the agent has a turn currently streaming (#222 reconciler reads
   *  this to skip restarting a deaf-but-mid-turn agent). */
  isAgentTurnActive(agentId: string): boolean;
  /** #315: ids of all agents with an in-flight turn (aggregate of {@link isAgentTurnActive}). */
  activeTurnAgents(): string[];
  /** #315: agents with a turn in flight OR a prompt the bus still owes the model. */
  busyAgents?(): string[];
  /**
   * #412 (item 1): the session manager announces a replacement process's
   * tailer generation the moment that process becomes the delivery target
   * (before its collision wait and before its tailer's `replay_done` is
   * ingested). A delivery typed into the new process in that window is then
   * tagged with the new generation, so a hold taken on its verdict cannot be
   * released by a late boundary from the old tailer's last read. Optional:
   * mocks and other wirings need not implement it.
   */
  noteSpawnedGeneration?(agent_id: string, generation: number): void;
  ingestReply(req: IngestReplyRequest): void;
  ingestSessionEvent(e: BusEvent): void;
  ingestPermissionDecision(req: IngestPermissionDecisionRequest): void;
  /** Sprint 2 (Sprint 1 follow-up): adapter API for `ask` / `request_human` answers. */
  ingestAskAnswer(req: { agent_id: string; ask_id: string; answer: string }): void;
  state(): BusState;
  /** Sprint 1 helper: start the IPC server (idempotent). */
  start(): Promise<void>;
  /** Stop the IPC server and drain. */
  stop(): Promise<void>;
}

/** The greater of two optional generations (`undefined` when neither is known). */
function maxGeneration(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** #224: how many distinct chats per agent the bus remembers as valid reply targets. */
const KNOWN_PROMPT_ORIGINS_MAX = 64;

export class BusCoreImpl implements BusCore {
  private subscribers = new Map<string, SubscriberRecord>();
  private connectedAgents = new Set<string>();
  private ipcServer: IpcServer | null = null;
  private readonly socketPath: string | null;
  private readonly ringbufferCapacity: number;
  private readonly eventLogAppend: EventLogAppendFn;
  private slashCommandHandler: SlashCommandHandler | null;
  private streamPromptHandler: StreamPromptHandler | null;
  private readonly defaultPtyReachable: PtyReachableCheck = () => this.streamPromptHandler !== null;
  private ptyReachable: PtyReachableCheck;
  private recordingPending: RecordingPendingCheck | null = null;
  /** #595 r6: agents whose queue head is waiting for the claude to be recorded (see `admitNext`). */
  private readonly recordHold = new Set<string>();
  // Settable post-hoc (like streamPromptHandler): the AgentJobRunner needs
  // `sendPrompt` for result delivery, so the daemon constructs it after the
  // bus and wires it via setJobHandler (#296 PR 3).
  private jobHandler: AgentJobHandler | null;
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  private readonly evaluatePolicy: (ctx: ToolRequestContext) => PolicyDecision;
  // Settable post-hoc (like streamPromptHandler): the bus is constructed
  // before the SessionManager exists, so the reconciler is wired afterwards.
  private onMcpSendFailed: (agentId: string, ctx: { reason: string }) => void = () => {};
  /** Last user prompt admitted per agent and chat (`seenKey`), to tell a
   *  repeat of an already-answered message from a fresh one, and an "ok" that
   *  approves the agent's question from a bare acknowledgement (reply nudge,
   *  see `ack-prompt.ts`). Keyed per chat so a heartbeat or another chat in
   *  between does not erase what this chat was last asked. */
  private readonly lastPromptSeen = new Map<string, SeenPrompt>();
  /** Origin of a turn a silent final just closed. A real `reply` that loses
   *  the race to that silent final is still delivered (see `ingestReply`); it
   *  routes here, since the silent final already cleared `lastPromptOrigin`.
   *  Dropped once a real final lands, the next turn opens, or the agent's
   *  origin is cleared (disconnect, cancel, error). */
  private readonly silentClosedOrigin = new Map<
    string,
    { origin: BusOrigin; origin_id: string; userId?: string; skillName?: string }
  >();

  /**
   * Tracks the origin (surface + channel id) of the most recent prompt
   * per agent. Adapters use this on outbound `response.text` events to
   * route the reply back to the originating channel/DM rather than
   * fanning out to every channel the agent owns. Single-slot: since #239 the
   * bus admits one prompt per agent at a time (`promptQueue`), so the slot is
   * the chat whose turn is running, and a prompt from another chat waits
   * rather than overwriting it mid-turn.
   */
  private readonly lastPromptOrigin = new Map<
    string,
    {
      origin: BusOrigin;
      origin_id: string;
      userId?: string;
      skillName?: string;
      silenceOk?: boolean;
    }
  >();

  /**
   * Per-agent identifier of the operation currently in flight, so every event
   * published during the turn can carry it (`BusEvent.promise_id`).
   *
   * Same lifetime as `lastPromptOrigin`, and released on the same set of
   * abnormal terminators (disconnect, cancel, error) for the same reason the
   * PR #138 review gave for the origin slot: on a path that never emits the
   * normal terminator, a slot left filled attaches the DEAD turn's identity to
   * the NEXT turn's events. For an operation id that is worse than carrying
   * none — a client would confidently correlate unrelated events to an
   * operation that already finished.
   *
   * One clear site is deliberately NOT shared: `ingestReply` releases the
   * origin slot on `intent: "final"`, but events legitimately follow a final
   * reply inside the same turn (`usage`, `response.turn_end`, and the reply the
   * silent-drop net synthesises). Releasing there would strip exactly the
   * events a client most needs correlated, so the operation slot survives the
   * final reply and is released on `response.turn_end`.
   *
   * #239: a second prompt no longer overwrites an occupied slot — it waits in
   * `promptQueue` until this one is released, so for bus-opened turns the id
   * is exact. It stays ADVISORY for the two cases counting cannot see: a turn
   * the bus did not open (the operator's own keyboard, a task notification)
   * ends a live operation early, and a slot the turn deadline freed may
   * belong to a turn that was merely slow (`deadlineReleased`).
   */
  private readonly currentOperation = new Map<string, string>();

  /**
   * Agents whose operation id is not trustworthy for the events now being
   * stamped with it.
   *
   * Deliberately NOT `originAmbiguous`, which exists for security attribution
   * and has the wrong lifetime for this job in two ways.
   *
   * It is cleared on `intent: "final"` alongside `lastPromptOrigin`, while the
   * operation slot deliberately outlives the final reply — so `usage`,
   * `response.turn_end` and the reply the silent-drop net synthesises would
   * carry an id with the taint already gone. Those are exactly the events a
   * client most needs correlated, reported as certain when they are not.
   *
   * And it is armed from `lastPromptOrigin`, which the final reply also
   * clears — so it never sees the window between a turn's final reply and its
   * lagged `response.turn_end`. That window is the sequential race (#217
   * finding 3, deferred #239): P1 replies, P2 is submitted and takes the slot,
   * P1's turn_end lands afterwards and is stamped with P2's id. A client
   * cannot detect the lag, which is the whole reason to report it.
   *
   * Keyed on the operation slot instead, both cases collapse into one
   * condition — a prompt arriving while a slot is still occupied — and the
   * taint lives and dies with the id it qualifies.
   *
   * #239: admission now waits for a free slot, so that condition is reached
   * on one path only — a slot the turn deadline freed (`deadlineReleased`).
   */
  private readonly correlationAmbiguous = new Set<string>();

  /**
   * How many turns are in flight per agent.
   *
   * `response.turn_end` is per-agent and carries no identity of its own, so it
   * cannot say which turn it ends. Releasing the slot on the first one to
   * arrive is wrong in exactly the case this machinery exists to report: P1
   * replies, P2 is submitted and takes the slot, P1's lagged turn_end lands —
   * and would release P2's slot while P2 is still running, leaving the rest of
   * P2's events with no operation id at all.
   *
   * Counting instead, the slot is released when the last outstanding turn ends.
   * The taint outlives the lagged terminator, which is correct: P2's
   * correlation really is uncertain for its whole life.
   */
  private readonly pendingTurns = new Map<string, number>();

  /**
   * #239: one active turn per agent. Every per-turn structure above is a
   * single slot keyed by agent (`lastPromptOrigin`, the reply flags, the
   * operation slot), and two prompts interleaving on one agent clobber each
   * other's — the second `sendPrompt` rewrites the origin mid-turn and the
   * first turn's reply, or the reply the silent-drop net synthesises for it,
   * is routed to the wrong chat. Keying each slot by origin was the other
   * option; it preserves a concurrency model inside one transcript that no
   * comparable runtime runs, so the bus serializes instead: a prompt arriving
   * while the agent still owes a terminator waits here and is admitted when
   * the slot frees (`admitNext`). Fair across origins — FIFO per lane (surface
   * + chat), round-robin across lanes — so one chatty surface cannot starve
   * another, and capped per lane so a runaway origin cannot grow it without
   * bound. #224's named replies stay the routing layer on top.
   *
   * What a queued prompt is NOT: held by the delivery layer. `deliveryQueue`,
   * `compactionHeld`, `pendingRedelivery` and `flushVerify` hold prompts the
   * bus has ALREADY admitted (the slot is theirs) while the PTY is not ready
   * for them. The distinction is what makes `turnDeadline` honest (#372): a
   * prompt waiting here holds no slot, so the deadline only ever runs against
   * a turn the bus actually opened.
   */
  private readonly promptQueue = new Map<
    string,
    { lanes: Map<string, QueuedPrompt[]>; order: string[] }
  >();
  private readonly promptQueueCapPerOrigin: number;
  private readonly promptQueueCapPerAgent: number;
  /**
   * #239 / #372: the release the serializing structure needs. A counted turn
   * that never produces its terminator — a prompt the CLI swallowed, a turn
   * interrupted at a session-generation boundary, an agent that died without
   * closing its socket — would otherwise hold the slot forever, and under
   * serialization that is no longer a mis-stamped `promise_id` but an agent
   * deaf to every origin. So the admission gate itself is given a deadline —
   * whatever holds it: a counted turn, a reply nudge whose turn never ends, a
   * streaming flag stuck by a turn the bus did not open — and the deadline is
   * IDLE-based, not total: it is re-armed by every sign of life for the agent
   * (any event published for it — the tailer's transcript lines, replies,
   * asks — and every delivery-layer transition: a hold taken, a verify armed,
   * a re-delivery). A long tool call or a subagent that writes nothing to the
   * transcript for longer than `turnDeadlineMs` is the known false positive;
   * the release is loud (`onError` + `[bus]` log) so it is tuned on evidence,
   * and its cost is bounded to the pre-#239 behaviour (one interleaved turn,
   * flagged `correlation_ambiguous`).
   */
  private readonly turnDeadline = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnDeadlineMs: number;
  /**
   * #239: agents whose slot was freed by the deadline rather than a terminator.
   * The next admitted prompt may then interleave with a turn that is merely
   * slow, so it is flagged `correlation_ambiguous` on admission — the one path
   * left on which a bus-opened turn can overlap another.
   */
  private readonly deadlineReleased = new Set<string>();
  /**
   * #239: agents whose gate was released EARLY — by the deadline, or by a
   * `cancel` / `error` from the process — while the CLI turn may still be
   * running. The next prompt admitted is typed into that turn, and the turn's
   * real `response.turn_end` then arrives AFTER the admission: taken as the
   * newcomer's terminator it would free the newcomer's count and admit the
   * prompt after it into the newcomer's turn, and so on down the queue — the
   * whole queue shifted by one. So a prompt admitted after an early release
   * waits for its OWN transcript line (`awaitOwnPromptLine`): a terminator
   * that lands before it belongs to the released turn and frees nothing.
   */
  private readonly earlyReleased = new Set<string>();
  /** #239: admitted prompts (their PTY text) whose `prompt` line has not been
   *  tailed yet, for agents whose previous turn was released early. */
  private readonly awaitOwnPromptLine = new Map<string, string | null>();
  /** #239: the origin of a prompt admitted after an early release, applied to
   *  the routing slot only once its own line is tailed — until then the slot
   *  still belongs to the released turn, whose late reply must reach ITS chat,
   *  not the newcomer's. */
  private readonly pendingOrigin = new Map<
    string,
    {
      origin: BusOrigin;
      origin_id: string;
      userId?: string;
      skillName?: string;
      silenceOk?: boolean;
    }
  >();
  /**
   * #239: agents whose IPC socket closed while a turn was live. The code's own
   * accounting (#402) says most closes are IPC-only drops with the process —
   * and the turn — alive, so the queue must NOT be admitted on the close: the
   * newcomer would be typed into the live turn. It waits for proof the turn
   * is over — the tailer's `response.turn_end`, a new session generation — or
   * the deadline.
   */
  private readonly gateParked = new Set<string>();
  /** #239: prompts the bus re-delivered since the agent's last socket close
   *  (the #402 carry-over, drained on `hello` or on `replay_done`). They hold
   *  no slot — the close freed it — yet each is a bus-owned prompt about to
   *  run; the gate stays parked on them until a `turn_end`, and one of them
   *  is the prompt whose `pendingOrigin` may still be applied. Cleared with
   *  the park. */
  private readonly redeliveredSinceClose = new Map<string, string[]>();
  /** #239 / #405: the pending admission after a `response.turn_end`, so every
   *  boundary line of the terminal message is processed before the next
   *  prompt goes. Held by `slotFree` for its duration. */
  private readonly admitSettle = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnEndSettleMs: number;

  /**
   * Agents whose `lastPromptOrigin` is currently AMBIGUOUS for security
   * attribution: a second prompt overwrote the slot while a prior prompt was
   * still in flight (the residual #239 interleave race). Best-effort *routing*
   * tolerates this, but the per-tool permission gate must NOT make a deny
   * decision from a possibly mis-attributed user/skill — when an agent is in
   * this set the gate ignores the cached identity and falls through to the
   * human card (fail-OPEN). Cleared whenever the slot returns to a clean
   * single-prompt state (a `set` onto an empty slot) or is torn down (#284 MEDIUM).
   */
  private readonly originAmbiguous = new Set<string>();
  /**
   * #224: every surface/chat that has prompted an agent, most recent last,
   * bounded. `lastPromptOrigin` is last-write-wins, so when two chats share an
   * agent and interleave, a reply routed by it reaches the wrong chat. A reply
   * that names the chat it answers (`in_reply_to`) is routed to that chat —
   * but only if the chat is in here: an agent must not be able to address a
   * chat that never spoke to it.
   */
  private readonly knownPromptOrigins = new Map<string, Map<string, Set<BusOrigin>>>();
  private readonly warnedUnknownReplyTarget = new Set<string>();
  /** #224: the chats a final already answered THIS turn — a second final to
   *  the same chat is the #217 race loser; to another chat it is a second
   *  answer. Reset with the other per-turn flags. */
  private readonly currentTurnFinalOrigins = new Map<string, Set<string>>();

  /**
   * Delivery gate. A prompt typed into a PTY-resident agent while its session
   * is (re)initialising — `session.init` seen but `bus.events.replay_done` not
   * yet — is swallowed by the not-yet-ready TUI and never starts a turn
   * (observed as an intermittent "prompt delivered, no reply"). Such prompts
   * are held and flushed on `replay_done`, or after a backstop timeout so a
   * missed `replay_done` can never strand a prompt (worst case = the previous
   * deliver-immediately behaviour). `agentInitializing` maps an agent to its
   * backstop timer; `deliveryQueue` holds the wrapped prompts awaiting flush.
   *
   * The gate is ORDER-INDEPENDENT. The JSONL tailer emits `replay_done` for
   * every session generation, but `session.init` only when the model writes
   * the first line of a previously-empty file. For a fresh / restart /
   * `/clear`-rotated session the file is empty at `start()`, so the tailer
   * emits `replay_done` FIRST and `session.init` LATER (once the model
   * writes). Treating `session.init` as an unconditional "arm" would then hold
   * an already-live session until the backstop fires — penalising exactly the
   * (re)init path this gate is meant to protect. So `replay_done`
   * unconditionally marks the agent READY for its session generation
   * (`agentLiveSession`) and flushes; a `session.init` for an already-live
   * generation is a no-op. `session.init` only arms a hold when the agent is
   * NOT already past `replay_done` for the current generation (the real
   * init→replay order, i.e. an existing/non-empty file at `start()`).
   */
  private readonly agentInitializing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deliveryQueue = new Map<string, string[]>();
  /**
   * Per-agent session generation (the `replay_done` `session_id`) that has
   * already reached `replay_done` and is therefore live. Makes the gate
   * order-independent: a late `session.init` carrying this same generation
   * must not re-arm a hold on a session that is already running.
   */
  private readonly agentLiveSession = new Map<string, string>();
  /** #402: the live tailer generation per agent (`payload.generation` on
   *  `replay_done` / `session.compact`, numbered by the session manager). A
   *  marker from an OLDER generation is a lagged read from a tailer being
   *  replaced — `SessionManager` does not await `tailer.stop()` — and must not
   *  move state or release a hold taken under the live one. The transcript's
   *  `session_id` cannot play this role: it is the stable Claude UUID and
   *  survives a `--resume` restart. */
  private readonly agentTailerGeneration = new Map<string, number>();
  /** #412: the generation the session manager has SPAWNED for an agent, which
   *  may be ahead of the live one (its `replay_done` not ingested yet). A
   *  delivery is tagged with the greater of the two. */
  private readonly agentSpawnedGeneration = new Map<string, number>();
  /** #412 item 3: once per agent — an un-numbered marker next to numbered ones. */
  private readonly warnedUnnumberedMarker = new Set<string>();
  private warnUnnumberedMarker(agent_id: string, topic: string): void {
    if (this.warnedUnnumberedMarker.has(agent_id)) return;
    this.warnedUnnumberedMarker.add(agent_id);
    console.warn(
      `[bus] agent=${agent_id}: a ${topic} marker without a tailer generation arrived while this agent's tailers are numbered — a second tailer wiring? Its markers are not ordered against the numbered ones and release every hold (pre-#402 semantics); logged once per agent`,
    );
  }

  private readonly deliveryBackstopMs: number;
  /**
   * Pending turn-start verification for a BACKSTOP-flushed prompt. The backstop
   * fires on a TIMER because `replay_done` never arrived — but during an
   * IPC-reconnect storm the session is still re-initialising, so the flushed
   * keystroke can be swallowed and never start a turn (dossier 20260613T033017).
   * After such a flush we watch for proof THAT prompt started a turn — a tailer
   * `prompt` event whose ingested text matches the wrapped string we delivered
   * (exact attribution; an unrelated later prompt's turn must not satisfy an
   * earlier swallowed one), or the CLI's record that it absorbed that prompt
   * into the turn already running (#389) — and, if neither lands within `flushVerifyMs`,
   * re-deliver THAT prompt ONCE through the gate. Per-prompt timers, not one
   * per agent: a second flush adds to the set instead of discarding pending
   * ones, and each prompt is verified/re-delivered independently. The watchdog
   * stays the ultimate net. Maps agent → (wrapped prompt → verify timer).
   */
  private readonly flushVerify = new Map<
    string,
    Map<
      string,
      {
        wrapped: string;
        graced: boolean;
        timer: ReturnType<typeof setTimeout>;
        /** Set once the entry's one re-delivery has been spent: the entry is
         *  then a marker that enforces at-most-once, not an active verify. */
        redelivered?: boolean;
      }
    >
  >();
  private readonly flushVerifyMs: number;
  /**
   * Grace (ms) between a delivery handler settling and declaring the prompt
   * swallowed. The turn-start `prompt` event reaches the bus asynchronously via
   * the JSONL tailer and can lag a little behind the handler return; without a
   * grace the verify could fire in that window and re-deliver a prompt whose
   * turn actually started (post-settle/pre-ingest double-submit). Defaults to
   * min(1500, flushVerifyMs/4) so it scales down with the lowered test timings.
   */
  private readonly flushVerifyGraceMs: number;
  /**
   * In-flight `streamPromptHandler` count per agent. A delivery handler that
   * hasn't settled is legitimately working — notably it holds through
   * auto-compaction (maxCompactionWaitMs, up to 240s ≫ flushVerifyMs). The
   * flush-verify timer must NOT re-deliver while a handler is in-flight or it
   * double-submits the prompt once compaction finishes (#252 regression). It
   * defers until the handler settles instead.
   */
  private readonly inFlightDeliveries = new Map<string, number>();
  /** Per agent: the deliveries whose handler has not resolved yet, keyed by
   *  the text the tailer will observe → whether the transcript already proved
   *  that prompt (a `prompt` line or an absorption record) while the handler
   *  was still deciding. The #361 verdict is read AFTER the handler resolves,
   *  so without this a proof that arrived mid-loop would already have
   *  cancelled its verify and left nothing for the give-up to find — it would
   *  re-arm a prompt the model already handled (adversarial finding 2). */
  private readonly inFlightProof = new Map<
    string,
    Map<string, { proven: boolean; token: number; closedEpoch?: number }>
  >();
  /** Per-delivery token counter (see `inFlightProof`): a verdict or cleanup
   *  from a delivery that has been superseded — the same text re-delivered
   *  after a socket close carried it over while the old handler was still
   *  deciding — must not read or mutate the newer delivery's entry. */
  private deliveryToken = 0;
  /** Per-agent epoch of the in-flight counter, bumped when a socket close
   *  resets it, so a late `finally` from before the reset does not decrement
   *  the counter of deliveries started after it. */
  private readonly inFlightEpoch = new Map<string, number>();
  /** The in-flight epoch at which the agent last reached a real `replay_done`
   *  (not the backstop, not a stale marker). A give-up verdict resolving after
   *  a socket close compares its `closedEpoch` to this: a fresh session is
   *  already ready → deliver through the gate now; not yet → carry the text
   *  to the next `replay_done`. */
  private readonly readyEpoch = new Map<string, number>();
  /** The in-flight epoch at which the agent last said `hello` (IPC connect).
   *  With `readyEpoch`, tells whether ANY readiness signal followed the last
   *  socket close — the same process reconnecting, or a replacement's tailer
   *  reaching `replay_done`. */
  private readonly helloEpoch = new Map<string, number>();
  /** #402: prompts (sanitized keys) whose ONE re-delivery is the delivery now
   *  in flight — a verify or hold carried over a socket close, or a late
   *  give-up re-delivered through the gate. Its verdict, whatever it is, arms
   *  nothing further: at-most-once survives the carry-over. */
  private readonly spentRetry = new Map<string, Set<string>>();
  /** The wrapped text behind each `inFlightProof` key, so a socket close can
   *  carry an in-flight (unproven) prompt over to the fresh session like it
   *  carries the held queue and the pending verifies (#402 review). */
  private readonly inFlightWrapped = new Map<string, Map<string, string>>();
  /**
   * #402: prompts whose PTY delivery gave up on `stuck-compaction`, held until
   * the compaction is positively over. The CLI can buffer the keystrokes
   * through an auto-compaction and submit them itself when it ends, so
   * re-typing DURING the compaction would land a second copy in the same
   * buffer; the pre-#402 answer was to never re-deliver, which left this the
   * last lost-prompt path from #361. The positive signal is the tailer's
   * `session.compact` (the `compact_boundary` line the CLI writes when the
   * compaction ends) — or a new session generation, which cannot still be
   * compacting. On either, the held prompt goes through the SAME at-most-once
   * verify the other give-ups use: if the CLI did submit the buffered
   * keystrokes, the transcript's `prompt` line attributes and cancels it; if
   * not, it is re-delivered once. A deadline bounds a compaction that never
   * reports its end. Keyed like `flushVerify` (sanitized text) so the
   * at-most-once rule spans both maps.
   */
  private readonly compactionHeld = new Map<
    string,
    Map<
      string,
      {
        wrapped: string;
        timer: ReturnType<typeof setTimeout>;
        generation?: number;
        /** When the hold was taken: a boundary line written BEFORE it belongs
         *  to an earlier compaction (tailer reads are asynchronous, so it can
         *  be ingested late) and must not release it. */
        heldAt: number;
      }
    >
  >();
  private readonly stuckCompactionResolveMs: number;
  /**
   * Agents with a turn currently streaming (tailer `prompt` seen, no
   * `response.turn_end` yet). A prompt delivered while a neighbor turn is in
   * progress can only be a queued keystroke in the REPL input box — the PTY
   * confirm-loop cannot attribute the neighbor's stream to it and may falsely
   * report it as turn-started (#250 ultra HIGH). The bus has reliable
   * attribution (the per-prompt `prompt` tailer event), so deliveries made
   * during an active turn arm a flush-verify; that verify is DEFERRED while a
   * turn is still active (the prompt legitimately waits behind it — re-delivering
   * sooner would double-submit), then re-delivers only if no turn ever starts.
   */
  private readonly agentTurnActive = new Set<string>();
  /** #405: message id of the last `turn_end` that released the operation slot,
   *  per agent — a later line of the same message must not release it again. */
  private readonly lastTurnEndMessageId = new Map<string, string>();
  /**
   * Prompts that were outstanding (held in the delivery queue, or flushed and
   * awaiting turn-start verification) when an agent's socket closed — typically
   * a #222 reconciler restart of an alive-but-deaf agent. Without this they are
   * silently dropped: onClose tears down the queue and the verify, and the
   * restart resumes the session WITHOUT re-typing the keystroke, so no recovery
   * layer owns the prompt (#252 stack ultra). Snapshotted on close, re-delivered
   * through the gate when the fresh generation reaches `replay_done`. Cleared on
   * shutdown; superseded if the agent never comes back (no further replay_done).
   */
  private readonly pendingRedelivery = new Map<string, string[]>();
  /**
   * Silent-drop safety net (issue #215): tracks per-agent whether the
   * current turn has called the `reply` MCP tool with `intent: "final"`.
   * Reset on every new inbound prompt (`sendPrompt`), set to `true` when
   * an `intent: "final"` `ingestReply` lands. On `response.turn_end`
   * (emitted by the JSONL tailer on any terminal `stop_reason`, #401), if
   * this is still `false` and the turn produced non-empty text, the
   * agent ended the turn without delivering — we synthesize an
   * `ingestReply` so the user actually receives the response.
   *
   * Single-slot per agent, like `lastPromptOrigin` (which routes the
   * synthesized reply). Interleaving two in-flight prompts on one agent would
   * let the second `sendPrompt` reset the flag mid-turn for the first — the
   * cross-channel misroute of #239. Since #239 the bus admits one prompt per
   * agent at a time (`promptQueue`), so the one-turn-at-a-time assumption
   * these flags rest on is enforced rather than hoped for.
   */
  private readonly currentTurnReplied = new Map<string, boolean>();

  /**
   * Cross-transport dedup for the silent-drop net (#217, finding 2).
   * `currentTurnReplied` is reset to `false` on every `sendPrompt` and set
   * to `true` once a final lands — but a real `reply` (IPC) and the
   * synthesized recovery (`response.turn_end` via the fs.watch tailer)
   * travel on two independent, unordered async channels. If the tailer
   * wins the race, `handleTurnEnd` synthesizes+delivers a final, then the
   * real `ingestReply(final)` IPC arrives and would deliver the SAME text
   * a second time. This per-turn flag records that a final `response.text`
   * was already PUBLISHED for the in-flight turn so the loser of the race
   * is suppressed. Set in both `ingestReply(final)` and the synthesizer;
   * cleared alongside `currentTurnReplied` on prompt / disconnect / cancel.
   */
  private readonly currentTurnFinalPublished = new Map<string, boolean>();

  /**
   * Reply-tool enforcement (#215/#240). `replyNudged` records that the agent
   * was already nudged once for the in-flight turn, so a nudged turn that again
   * ends without `reply` falls through to the synthesized safety net instead of
   * nudging forever. `pendingNudgeText` holds the original turn's text so the
   * fallback can still deliver it if the nudged turn produces no fresh text.
   * Both are cleared on prompt / final reply / disconnect / cancel / error,
   * alongside the other per-turn flags.
   */
  private readonly replyNudgeEnabled: boolean;
  private readonly replyNudged = new Map<string, boolean>();
  private readonly pendingNudgeText = new Map<string, string>();
  /** An IPC-only reply nudge waiting for its turn to start; typed into the PTY
   *  if none does within `flushVerifyMs` (see `nudgeForReply`). `key` is the
   *  nudge's `promptLineKey`, so only a line carrying the nudge disarms it. */
  private readonly nudgePtyFallback = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; key: string }
  >();

  constructor(opts: BusCoreOptions = {}) {
    this.replyNudgeEnabled = opts.replyNudge ?? true;
    this.socketPath = opts.socketPath ?? null;
    this.ringbufferCapacity = opts.ringbufferCapacity ?? DEFAULT_RINGBUFFER_CAPACITY;
    this.deliveryBackstopMs = opts.deliveryBackstopMs ?? 4000;
    this.flushVerifyMs = opts.flushVerifyMs ?? 8000;
    this.stuckCompactionResolveMs = opts.stuckCompactionResolveMs ?? 600_000;
    this.turnDeadlineMs = opts.turnDeadlineMs ?? 900_000;
    this.promptQueueCapPerOrigin = opts.promptQueueCapPerOrigin ?? 32;
    this.promptQueueCapPerAgent = opts.promptQueueCapPerAgent ?? 256;
    this.turnEndSettleMs = opts.turnEndSettleMs ?? 1000;
    this.flushVerifyGraceMs =
      opts.flushVerifyGraceMs ?? Math.min(1500, Math.ceil(this.flushVerifyMs / 4));
    this.eventLogAppend = opts.eventLogAppend ?? eventLogAppend;
    this.slashCommandHandler = opts.slashCommandHandler ?? null;
    this.streamPromptHandler = opts.streamPromptHandler ?? null;
    this.ptyReachable = opts.ptyReachable ?? this.defaultPtyReachable;
    this.jobHandler = opts.jobHandler ?? null;
    this.onError = opts.onError ?? ((err, ctx) => console.error("[bus]", err, ctx));
    this.evaluatePolicy = opts.evaluatePolicy ?? evaluate;
    if (opts.onMcpSendFailed) this.onMcpSendFailed = opts.onMcpSendFailed;
  }

  /**
   * Structured observability for the MCP registration seam (#222). Lands on
   * stderr → captured in the daemon log, grep-able as `[bus-ipc]`. Until this
   * existed, the bus logged the *symptom* ("No MCP connection") loudly but
   * nothing about *why* there was no connection — no hello/close/restart
   * trace — so a recurring deaf-agent wedge was undiagnosable from logs.
   */
  private logIpc(msg: string, fields: Record<string, unknown>): void {
    console.error(`[bus-ipc] ${msg}`, { ts: new Date().toISOString(), ...fields });
  }

  /* ─────────────────────────────── lifecycle ─────────────────────────────── */

  async start(): Promise<void> {
    if (this.ipcServer || !this.socketPath) return;
    this.ipcServer = await bindUdsServer(this.socketPath, {
      onHello: (agentId, _caps) => {
        this.connectedAgents.add(agentId);
        // #402: an IPC-only reconnect (same process, no new tailer, so no
        // `replay_done` will come) is the only readiness signal a prompt
        // carried at the previous close will get. A replacement PROCESS is
        // told apart by its tailer: the session manager starts it at spawn
        // and its `replay_done` lands before the CLI has even booted — so a
        // hello with no `replay_done` since the close is the same process
        // back, and one after it was already drained by `markAgentReady`.
        const carried = this.pendingRedelivery.get(agentId);
        const readySinceClose =
          this.readyEpoch.get(agentId) === (this.inFlightEpoch.get(agentId) ?? 0);
        this.helloEpoch.set(agentId, this.inFlightEpoch.get(agentId) ?? 0);
        if (carried && !readySinceClose) {
          this.pendingRedelivery.delete(agentId);
          for (const wrapped of carried) {
            this.noteRedelivered(agentId, wrapped);
            this.deliverOrQueuePrompt(agentId, wrapped);
          }
        }
        this.logIpc("hello", {
          agent: agentId,
          caps: _caps.length,
          connections: this.ipcServer?.connectionCount() ?? 0,
          registered: this.connectedAgents.size,
        });
      },
      onMessage: (agentId, msg) => this.handleIpcMessage(agentId, msg),
      onClose: (agentId) => {
        if (agentId) {
          this.connectedAgents.delete(agentId);
          // Clear any cached origin for this agent on disconnect — the
          // claude subprocess is gone, so any in-flight prompt won't
          // produce a `final` reply to trigger the usual clear path.
          // Without this, a subsequent scheduler/cron event for this
          // agent (after a reconnect) would inherit the dead session's
          // origin and misroute (5-agent review on PR #138, A1 finding).
          const turnCounted = this.currentOperation.has(agentId);
          this.lastPromptOrigin.delete(agentId);
          this.silentClosedOrigin.delete(agentId);
          this.originAmbiguous.delete(agentId);
          // Same lifecycle: no `response.turn_end` is coming either, so the
          // operation slot would stay filled and stamp the NEXT turn's events
          // with the dead turn's id — a client would correlate them to an
          // operation that already finished.
          this.currentOperation.delete(agentId);
          this.correlationAmbiguous.delete(agentId);
          this.pendingTurns.delete(agentId);
          this.currentTurnReplied.delete(agentId);
          this.currentTurnFinalPublished.delete(agentId);
          this.currentTurnFinalOrigins.delete(agentId);
          // Reply-tool enforcement (#215/#240): drop nudge state with the rest
          // of the per-turn flags so a dead session can't leave it dangling.
          this.replyNudged.delete(agentId);
          this.pendingNudgeText.delete(agentId);
          // #239: the slot is free; its deadline goes with it. The prompts
          // queued behind it are NOT dropped — like the carried re-deliveries
          // below they belong to the agent that comes back — and the next one
          // is admitted at the same point a direct prompt would have been
          // delivered before the queue existed (below, once the delivery-gate
          // state is reset; `markAgentReady` admits again after the flush).
          this.deadlineReleased.delete(agentId);
          // The subprocess is gone -- tear down this agent's delivery-gate
          // state too, so a held prompt plus an armed backstop timer can never
          // flush a stale keystroke into a restart that reuses this agent_id.
          // NOT agentLiveSession: clearing it would let a late session.init
          // arm a hold on the resumed (already-live) session -- the very
          // anti-pattern the order-independent gate avoids -- and the new
          // tailer re-emits replay_done which sets it again anyway.
          const heldInitTimer = this.agentInitializing.get(agentId);
          if (heldInitTimer) clearTimeout(heldInitTimer);
          this.agentInitializing.delete(agentId);
          // Snapshot any outstanding prompts (still-held queue + flushed-and-
          // awaiting-verify) BEFORE tearing them down, so a reconciler restart
          // of an alive-but-deaf agent re-delivers them once the fresh session
          // is ready instead of silently dropping them (#252 stack ultra). The
          // timers themselves still die here (no stale keystroke into a reused
          // agent_id — the #252 HIGH); only the prompt text is carried over.
          const carryOver = new Set<string>(this.deliveryQueue.get(agentId) ?? []);
          // A prompt awaiting its verify, or held through a compaction, has
          // been delivered once already: the carry-over IS its one re-delivery
          // (#402 review) — remembered so its verdict arms nothing further.
          const retries = this.spentRetry.get(agentId) ?? new Set<string>();
          const pendingVerify = this.flushVerify.get(agentId);
          if (pendingVerify)
            for (const [k, entry] of pendingVerify) {
              // An entry kept after its re-delivery is the at-most-once
              // sentinel, not an outstanding prompt: never carried again.
              if (entry.redelivered) continue;
              // A verify pre-armed by `sendPrompt` for a delivery whose handler
              // is still deciding: the verdict path carries it if it gives up
              // unproven; carrying it here too would re-deliver ahead of a late
              // `turn-started`, i.e. submit it twice.
              if (this.inFlightProof.get(agentId)?.has(k)) continue;
              carryOver.add(entry.wrapped);
              retries.add(k);
            }
          // #402: compaction holds are deliberately NOT touched here. An IPC
          // drop does not affect the tailer, so on the usual IPC-only close the
          // compaction is still running in the same process and its boundary
          // is still coming — carrying the hold and draining it on reconnect
          // would type the prompt into that very buffer. If the process really
          // is gone, the replacement's newer generation releases the hold into
          // the gate; the deadline is the bound in every other case.
          if (retries.size > 0) this.spentRetry.set(agentId, retries);
          // A delivery whose handler is still deciding is NOT carried over:
          // "unproven" only means the transcript's user line has not landed
          // yet — seconds on a healthy delivery — and ~95 % of closes on a live
          // daemon are IPC-only drops with the process alive, so carrying it
          // would re-type a prompt that succeeded, at the next restart. The
          // verdict decides instead: its entry is flagged with this close's
          // epoch, and only a give-up that is still unproven re-delivers (see
          // `readyEpoch`). Nothing is armed on the dead generation.
          const epoch = (this.inFlightEpoch.get(agentId) ?? 0) + 1;
          this.inFlightEpoch.set(agentId, epoch);
          const proofs = this.inFlightProof.get(agentId);
          if (proofs) for (const entry of proofs.values()) entry.closedEpoch = epoch;
          // Merge, never replace: a late give-up from an earlier close may
          // already be waiting here, and this close must not lose it.
          if (carryOver.size > 0) {
            const already = this.pendingRedelivery.get(agentId) ?? [];
            for (const w of already) carryOver.add(w);
            this.pendingRedelivery.set(agentId, [...carryOver]);
          }
          this.deliveryQueue.delete(agentId);
          // Same hazard for a pending flush-verify timer: if it fired after a
          // restart that reused this agent_id it would type a stale keystroke
          // into the fresh session (#252 HIGH).
          this.clearFlushVerify(agentId);
          this.inFlightDeliveries.delete(agentId);
          const turnWasLive = this.agentTurnActive.has(agentId) || turnCounted;
          this.agentTurnActive.delete(agentId);
          this.logIpc("close", {
            agent: agentId,
            connections: this.ipcServer?.connectionCount() ?? 0,
            registered: this.connectedAgents.size,
          });
          // #239: a close with a turn live is, most of the time, an IPC-only
          // drop with the process and its turn alive — the queue is PARKED
          // until the turn is proven over (its `turn_end`, a new generation)
          // or the deadline, never admitted into it. A close with the agent
          // idle admits as a direct prompt would have been delivered.
          if (turnWasLive) this.gateParked.add(agentId);
          this.redeliveredSinceClose.delete(agentId); // a new carry-over starts here
          // `awaitOwnPromptLine` / `pendingOrigin` survive the close: an
          // IPC-only blip leaves the released turn running, and its late
          // terminator must still count for nobody. A real replacement clears
          // them on its new generation.
          this.touchTurn(agentId);
          if (!turnWasLive) this.admitNext(agentId);
        } else {
          this.logIpc("close", { agent: null, note: "pre-handshake socket closed" });
        }
      },
      onError: (err, agentId) => this.onError(err, { ctx: "ipc", agentId }),
    });
  }

  async stop(): Promise<void> {
    if (this.ipcServer) {
      await this.ipcServer.stop();
      this.ipcServer = null;
    }
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
    }
    this.subscribers.clear();
    this.connectedAgents.clear();
    for (const timer of this.agentInitializing.values()) clearTimeout(timer);
    this.agentInitializing.clear();
    this.deliveryQueue.clear();
    this.agentLiveSession.clear();
    for (const pending of this.flushVerify.values())
      for (const entry of pending.values()) clearTimeout(entry.timer);
    this.flushVerify.clear();
    for (const { timer } of this.nudgePtyFallback.values()) clearTimeout(timer);
    this.nudgePtyFallback.clear();
    this.inFlightDeliveries.clear();
    this.inFlightProof.clear();
    this.inFlightWrapped.clear();
    this.inFlightEpoch.clear();
    this.readyEpoch.clear();
    this.helloEpoch.clear();
    this.spentRetry.clear();
    for (const held of this.compactionHeld.values())
      for (const entry of held.values()) clearTimeout(entry.timer);
    this.compactionHeld.clear();
    this.agentTailerGeneration.clear();
    this.agentSpawnedGeneration.clear();
    this.warnedUnnumberedMarker.clear();
    this.agentTurnActive.clear();
    this.lastTurnEndMessageId.clear();
    this.originAmbiguous.clear();
    this.knownPromptOrigins.clear();
    this.warnedUnknownReplyTarget.clear();
    this.currentTurnFinalOrigins.clear();
    this.currentOperation.clear();
    this.correlationAmbiguous.clear();
    this.pendingTurns.clear();
    this.pendingRedelivery.clear();
    this.replyNudged.clear();
    this.pendingNudgeText.clear();
    for (const timer of this.turnDeadline.values()) clearTimeout(timer);
    this.turnDeadline.clear();
    this.deadlineReleased.clear();
    this.earlyReleased.clear();
    this.awaitOwnPromptLine.clear();
    this.pendingOrigin.clear();
    this.silentClosedOrigin.clear();
    this.gateParked.clear();
    this.redeliveredSinceClose.clear();
    for (const timer of this.admitSettle.values()) clearTimeout(timer);
    this.admitSettle.clear();
    this.promptQueue.clear();
    this.recordHold.clear();
  }

  /* ─────────────────────────────── prompts ─────────────────────────────── */

  sendPrompt(req: SendPromptRequest): Promise<SendPromptAck> {
    // #595 r5: a claude not yet recorded as ours gets the prompt on NEITHER transport. Checked before
    // anything else, and only a pending agent leaves the synchronous path (the ack's tick count for
    // every other agent is unchanged).
    const pendingRecord = this.modelInputPending(req.agent_id);
    if (pendingRecord) return this.sendWhenRecorded(req, pendingRecord);
    const promise_id = randomUUID();
    // #239: one active turn per agent. The slot is free when the agent owes no
    // terminator for a bus-opened turn, no turn is streaming in its transcript
    // (a turn the bus did not open — typed into the TUI, a task notification —
    // still occupies the REPL and its reply slot), and no reply nudge is
    // outstanding (the nudged turn answers the PREVIOUS prompt; admitting the
    // next one now would rewrite the origin that answer routes by — the very
    // misroute this queue exists to close).
    if (!this.slotFree(req.agent_id) || this.promptQueue.has(req.agent_id)) {
      // Behind an active turn, or behind prompts already waiting (a free slot
      // with a non-empty queue is a release whose `admitNext` has not run yet
      // — never let a newcomer jump it).
      try {
        this.enqueuePrompt(req, promise_id);
      } catch (err) {
        return Promise.reject(err);
      }
      // A gate parked by a socket close whose agent has not come back: the
      // process may be dead, and the only automatic restart (#222) is woken by
      // a failed IPC send — which a queued prompt no longer attempts. Wake it
      // from here, as the pre-queue delivery of this prompt would have.
      if (
        this.gateParked.has(req.agent_id) &&
        this.ipcServer &&
        !this.ipcServer.hasConnection(req.agent_id)
      ) {
        this.logIpc("send-failed", {
          agent: req.agent_id,
          ctx: "sendPrompt:parked",
          registeredKnown: this.connectedAgents.has(req.agent_id),
          connections: this.ipcServer.connectionCount(),
        });
        this.onMcpSendFailed(req.agent_id, { reason: "sendPrompt:parked-no-mcp-connection" });
      }
      this.admitNext(req.agent_id);
      return Promise.resolve({ promise_id, queued: true });
    }
    // Not wrapped in an async function of its own: `admitPrompt` is the body
    // `sendPrompt` had before #239, and callers that race its ack against a
    // fast `final` (the webui bridge's receipt notes) rely on its tick count.
    return this.admitPrompt(req, promise_id);
  }

  /**
   * #595 r5: hold a prompt until its agent's claude is recorded, for at most `deliveryBackstopMs`,
   * then send it through the normal path (so both transports see an agent that is deliverable).
   * Prompts held for one agent resume in arrival order. If the record failed or is late, the prompt
   * is not delivered anywhere and the caller gets a reason code.
   */
  private async sendWhenRecorded(
    req: SendPromptRequest,
    pending: Promise<void>,
  ): Promise<SendPromptAck> {
    const outcome = await this.awaitRecorded(req.agent_id, pending, "sendPrompt:recording-pending");
    if (outcome !== "recorded") throw new AgentNotRecordedError(req.agent_id, outcome);
    return this.sendPrompt(req);
  }

  /**
   * #595 r6: the one bounded wait on a pending ownership record, shared by every path that is about
   * to put a prompt on a transport (a fresh prompt, a queued prompt being admitted). A path that
   * cannot wait (the reply nudge) asks `recordingPending` and drops instead. Logs a reason code on
   * any outcome but "recorded", never the prompt.
   */
  private async awaitRecorded(
    agent_id: string,
    pending: Promise<void>,
    ctx: string,
  ): Promise<"recorded" | "recording-failed" | "recording-timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => "recorded" as const,
        () => "recording-failed" as const,
      ),
      new Promise<"recording-timeout">((resolve) => {
        timer = setTimeout(() => resolve("recording-timeout"), this.deliveryBackstopMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (outcome !== "recorded")
      this.logIpc("undeliverable", { agent: agent_id, ctx, reason: outcome });
    return outcome;
  }

  /**
   * #595 r7: the ONLY reader of `recordingPending`. Non-null while the agent's claude is spawned but
   * not yet recorded as ours; every path that is about to hand the model input asks here (a path
   * that can wait waits on the promise via `awaitRecorded`, one that cannot refuses).
   */
  private modelInputPending(agent_id: string): Promise<void> | null {
    return this.recordingPending?.(agent_id) ?? null;
  }

  /**
   * #595 r7: the ONLY place Bus core sends an IPC frame the MCP server turns into model input (a
   * `prompt`, an `ask_answer`: both become `notifications/claude/channel`). It fails closed: a frame
   * for an agent whose claude is not yet recorded is not written, and the caller gets the pending
   * promise back to wait on, or to refuse with. A caller that checked earlier (to also hold the PTY
   * leg, or to wait) is checked again here, in the same tick, so no path can send around the gate.
   */
  private emitModelInput(frame: ModelInputFrame): ModelInputSend {
    const pending = this.modelInputPending(frame.agent_id);
    if (pending) return { status: "recording-pending", pending };
    const sent = this.ipcServer?.send(frame.agent_id, frame) === true;
    return { status: sent ? "sent" : "no-connection" };
  }

  /** #595 r7: the only other sender. A control frame answers a request the claude made and starts no turn. */
  private emitControl(agent_id: string, frame: ControlFrame): boolean {
    return this.ipcServer?.send(agent_id, frame) === true;
  }

  /** #239: no bus-opened turn in flight, no turn streaming, no nudge pending. */
  private slotFree(agent_id: string): boolean {
    return (
      !this.currentOperation.has(agent_id) &&
      !this.agentTurnActive.has(agent_id) &&
      this.replyNudged.get(agent_id) !== true &&
      !this.gateParked.has(agent_id) &&
      !this.admitSettle.has(agent_id)
    );
  }

  /** #239 / #405: admit after a `response.turn_end`, once the terminal
   *  message's other boundary lines have had `turnEndSettleMs` to land. A
   *  further line within the window restarts it. */
  private scheduleAdmit(agent_id: string): void {
    const prev = this.admitSettle.get(agent_id);
    if (prev) clearTimeout(prev);
    if (this.turnEndSettleMs <= 0) {
      this.admitSettle.delete(agent_id);
      this.touchTurn(agent_id);
      this.admitNext(agent_id);
      return;
    }
    const timer = setTimeout(() => {
      this.admitSettle.delete(agent_id);
      this.touchTurn(agent_id);
      this.admitNext(agent_id);
    }, this.turnEndSettleMs);
    (timer as { unref?: () => void }).unref?.();
    this.admitSettle.set(agent_id, timer);
    this.touchTurn(agent_id);
  }

  private enqueuePrompt(req: SendPromptRequest, promise_id: string): void {
    let q = this.promptQueue.get(req.agent_id);
    if (!q) {
      q = { lanes: new Map(), order: [] };
      this.promptQueue.set(req.agent_id, q);
    }
    const laneKey = `${req.origin}:${req.origin_id}`;
    let lane = q.lanes.get(laneKey);
    if (!lane) {
      lane = [];
      q.lanes.set(laneKey, lane);
      q.order.push(laneKey);
    }
    if (lane.length >= this.promptQueueCapPerOrigin) {
      if (lane.length === 0) this.dropLane(q, req.agent_id, laneKey);
      throw new PromptQueueFullError(
        req.agent_id,
        req.origin,
        req.origin_id,
        this.promptQueueCapPerOrigin,
        "origin",
      );
    }
    let total = 0;
    for (const l of q.lanes.values()) total += l.length;
    if (total >= this.promptQueueCapPerAgent) {
      if (lane.length === 0) this.dropLane(q, req.agent_id, laneKey);
      throw new PromptQueueFullError(
        req.agent_id,
        req.origin,
        req.origin_id,
        this.promptQueueCapPerAgent,
        "agent",
      );
    }
    lane.push({ req, promise_id, queuedAt: Date.now() });
    // Surface only, like the other `[bus]` lines: a chat id is not log material.
    console.warn(
      `[bus] prompt queued for agent=${req.agent_id} (origin=${req.origin}, ` +
        `lane depth=${lane.length}, lanes=${q.lanes.size}): a turn is still in flight. See #239.`,
    );
  }

  /** A lane created for a prompt that was then refused must not linger as an
   *  empty entry in the rotation (nor keep the agent's queue "non-empty"). */
  private dropLane(
    q: { lanes: Map<string, QueuedPrompt[]>; order: string[] },
    agent_id: string,
    laneKey: string,
  ): void {
    q.lanes.delete(laneKey);
    const i = q.order.indexOf(laneKey);
    if (i >= 0) q.order.splice(i, 1);
    if (q.lanes.size === 0) this.promptQueue.delete(agent_id);
  }

  /** #239: pop the next prompt in fair order — the first non-empty lane in
   *  rotation, which then moves to the back — or nothing. */
  private dequeuePrompt(agent_id: string): QueuedPrompt | undefined {
    const q = this.promptQueue.get(agent_id);
    if (!q) return undefined;
    for (let i = 0; i < q.order.length; i++) {
      const laneKey = q.order.shift() as string;
      const lane = q.lanes.get(laneKey);
      if (!lane || lane.length === 0) {
        q.lanes.delete(laneKey);
        continue;
      }
      const next = lane.shift() as QueuedPrompt;
      if (lane.length === 0) q.lanes.delete(laneKey);
      else q.order.push(laneKey);
      if (q.lanes.size === 0) this.promptQueue.delete(agent_id);
      return next;
    }
    this.promptQueue.delete(agent_id);
    return undefined;
  }

  withdrawQueuedPrompt(agentId: string, promise_id: string): boolean {
    const q = this.promptQueue.get(agentId);
    if (!q) return false;
    for (const [laneKey, lane] of q.lanes) {
      const i = lane.findIndex((e) => e.promise_id === promise_id);
      if (i < 0) continue;
      lane.splice(i, 1);
      if (lane.length === 0) this.dropLane(q, agentId, laneKey);
      return true;
    }
    return false;
  }

  queuedPrompts(
    agentId: string,
  ): ReadonlyArray<{ promise_id: string; origin: BusOrigin; origin_id: string }> {
    const q = this.promptQueue.get(agentId);
    if (!q) return [];
    // Admission order: walk the rotation round by round.
    const out: { promise_id: string; origin: BusOrigin; origin_id: string }[] = [];
    const cursors = new Map<string, number>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const laneKey of q.order) {
        const lane = q.lanes.get(laneKey) ?? [];
        const i = cursors.get(laneKey) ?? 0;
        if (i >= lane.length) continue;
        const entry = lane[i] as QueuedPrompt;
        out.push({
          promise_id: entry.promise_id,
          origin: entry.req.origin,
          origin_id: entry.req.origin_id,
        });
        cursors.set(laneKey, i + 1);
        progressed = true;
      }
    }
    return out;
  }

  /**
   * #239: the slot may have just freed — a terminator landed, an abnormal
   * release ran, the deadline fired. Admit the next queued prompt if so. Every
   * release site calls this; it is a no-op while the slot is still occupied
   * or nothing waits, so calling it too often costs nothing and missing a
   * call is the only way to strand a prompt.
   */
  private admitNext(agent_id: string): void {
    if (!this.slotFree(agent_id)) return;
    if (this.recordHold.has(agent_id) || !this.promptQueue.has(agent_id)) return;
    // #595 r6: a queued prompt is delivered here, not through `sendPrompt`, so it needs its own
    // check. The head stays queued (its promise id and place in the rotation intact; a newcomer
    // queues behind it) until the claude is recorded; a failed or late record fails the queue.
    const pending = this.modelInputPending(agent_id);
    if (pending) {
      this.recordHold.add(agent_id);
      void this.awaitRecorded(agent_id, pending, "admitNext:recording-pending").then((outcome) => {
        this.recordHold.delete(agent_id);
        if (outcome === "recorded") this.admitNext(agent_id);
        else this.failQueuedUnrecorded(agent_id, outcome);
      });
      return;
    }
    const next = this.dequeuePrompt(agent_id);
    if (!next) return;
    console.warn(
      `[bus] admitting queued prompt for agent=${agent_id} ` +
        `(origin=${next.req.origin}, waited ${Date.now() - next.queuedAt}ms).`,
    );
    // The ack of a queued prompt has no reader (its caller was answered at
    // enqueue time); a delivery failure surfaces through onError as it would
    // for a direct send.
    void this.admitPrompt(next.req, next.promise_id).catch((err) =>
      this.onError(err, { ctx: "admitNext", agent_id }),
    );
  }

  /** #595 r6: the claude was never recorded, so nothing queued for it is delivered. Each prompt
   *  fails through `onError` with its reason and promise id, as a queued prompt's delivery failure
   *  does; none of them reached a transport and none took the slot. */
  private failQueuedUnrecorded(
    agent_id: string,
    reason: "recording-failed" | "recording-timeout",
  ): void {
    for (let next = this.dequeuePrompt(agent_id); next; next = this.dequeuePrompt(agent_id)) {
      this.onError(new AgentNotRecordedError(agent_id, reason), {
        ctx: "admitNext:recording-pending",
        agent_id,
        promise_id: next.promise_id,
      });
    }
  }

  /** #239 / #372: bring the idle deadline in line with the admission gate —
   *  (re)armed while anything holds it (a counted turn, a nudge outstanding,
   *  a streaming flag), cleared once it is free. Called on admission, on every
   *  sign of life, and at every release site. */
  private touchTurn(agent_id: string): void {
    const prev = this.turnDeadline.get(agent_id);
    if (prev) clearTimeout(prev);
    if (this.slotFree(agent_id)) {
      this.turnDeadline.delete(agent_id);
      return;
    }
    const timer = setTimeout(() => this.onTurnDeadline(agent_id), this.turnDeadlineMs);
    (timer as { unref?: () => void }).unref?.();
    this.turnDeadline.set(agent_id, timer);
  }

  /**
   * #239 / #372: the admitted turn showed no sign of life for `turnDeadlineMs`.
   * Its terminator is not coming — or is coming from a turn too slow to tell
   * apart from a dead one. Either way the queue behind it must move: release
   * every per-turn slot exactly as the abnormal terminators (cancel / error /
   * disconnect) do, say so loudly, and admit the next prompt flagged as
   * possibly overlapping.
   */
  private onTurnDeadline(agent_id: string): void {
    this.turnDeadline.delete(agent_id);
    if (this.slotFree(agent_id)) return;
    const operation = this.currentOperation.get(agent_id);
    const held = [
      operation ? `operation=${operation}` : null,
      this.replyNudged.get(agent_id) === true ? "reply-nudge outstanding" : null,
      this.agentTurnActive.has(agent_id) ? "turn streaming" : null,
      this.gateParked.has(agent_id) ? "parked (IPC close or re-delivery)" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const waiting = this.queuedPrompts(agent_id).length;
    const msg =
      `turn deadline: agent=${agent_id} (${held}) showed no sign of life for ` +
      `${this.turnDeadlineMs}ms — releasing the turn (${waiting} prompt(s) queued). ` +
      "A turn that was merely slow may now overlap the next one; its events are flagged " +
      "correlation_ambiguous. See #239 / #372.";
    console.error(`[bus] ${msg}`);
    this.onError(new Error(msg), { ctx: "turn-deadline", agent_id, operation, held, waiting });
    // Only what HOLDS the gate is cleared. The origin and the reply flags stay:
    // the turn may merely be slow, and its late reply (or the text the net
    // synthesises for it) must still find its chat — deleting the origin here
    // turned a slow single-chat turn into a dropped answer (adversarial
    // finding). If a prompt is admitted next, its own admission overwrites the
    // origin and marks it ambiguous for the security gate, as before #239.
    this.currentOperation.delete(agent_id);
    this.correlationAmbiguous.delete(agent_id);
    this.pendingTurns.delete(agent_id);
    this.replyNudged.delete(agent_id);
    this.pendingNudgeText.delete(agent_id);
    this.agentTurnActive.delete(agent_id);
    this.gateParked.delete(agent_id);
    this.redeliveredSinceClose.delete(agent_id);
    this.awaitOwnPromptLine.delete(agent_id); // the next admission sets its own
    this.pendingOrigin.delete(agent_id);
    const settle = this.admitSettle.get(agent_id);
    if (settle) clearTimeout(settle);
    this.admitSettle.delete(agent_id);
    this.deadlineReleased.add(agent_id);
    this.earlyReleased.add(agent_id);
    this.admitNext(agent_id);
  }

  private async admitPrompt(req: SendPromptRequest, promise_id: string): Promise<SendPromptAck> {
    // #595 r7: both callers have just waited out (or found no) pending record, in this same tick; this
    // is the typed refusal for any path that reaches admission without having done so. It runs before
    // the turn is opened, so a refusal leaves no slot held.
    if (this.modelInputPending(req.agent_id))
      throw new AgentNotRecordedError(req.agent_id, "recording-pending");
    // Emit a `prompt` BusEvent so subscribers see the inbound message and
    // the audit log records it. We do this before forwarding so the event
    // is durable even if the IPC send fails.
    const promptEvent: BusEvent<{
      origin: BusOrigin;
      origin_id: string;
      user_id: string;
      text: string;
      metadata?: Record<string, unknown>;
      promise_id: string;
    }> = {
      ts: Date.now(),
      agent_id: req.agent_id,
      // We don't have a Claude session_id yet at the prompt boundary; the
      // JSONL tailer will fill it in for downstream events. Sprint 1 uses
      // a placeholder that the Session Manager can replace once it knows
      // the agent's session_id (spec §7).
      session_id: "",
      topic: "prompt",
      promise_id,
      payload: {
        origin: req.origin,
        origin_id: req.origin_id,
        user_id: req.user_id,
        text: req.text,
        metadata: req.metadata,
        promise_id,
      },
    };
    // Remember the operation BEFORE publishing so the prompt event and every
    // event after it are stamped from the same slot.
    //
    // A slot still occupied means the previous turn has not reached its
    // terminator, so events from here on cannot be attributed to one operation
    // with confidence. Say so on the envelope rather than letting a client
    // correlate confidently and wrongly.
    //
    // #239: admission waits for a free slot, so an occupied one is no longer
    // reachable here. The one overlap left is a slot the DEADLINE freed: the
    // turn it belonged to may still be running, and this prompt's events may
    // then be its. Flag it for the same reason.
    if (this.currentOperation.has(req.agent_id) || this.deadlineReleased.has(req.agent_id)) {
      this.correlationAmbiguous.add(req.agent_id);
    } else {
      this.correlationAmbiguous.delete(req.agent_id);
    }
    this.deadlineReleased.delete(req.agent_id);
    // Admitted while the released turn may still run (see `earlyReleased`):
    // a terminator that lands before this prompt's own transcript line is
    // that turn's, not ours. The PTY text is filled in below once wrapped;
    // `null` (no PTY leg) accepts the next `prompt` line whatever its text.
    if (this.earlyReleased.delete(req.agent_id)) this.awaitOwnPromptLine.set(req.agent_id, null);
    this.currentOperation.set(req.agent_id, promise_id);
    this.pendingTurns.set(req.agent_id, (this.pendingTurns.get(req.agent_id) ?? 0) + 1);
    this.touchTurn(req.agent_id);
    this.publish(promptEvent);
    // A bare acknowledgement, or a repeat of a message already answered, does
    // not call for a reply: its turn may end without `reply` and that is not a
    // dropped answer (see `handleTurnEnd`). Daemon injects and scheduled jobs
    // keep their own handling — their callers read the turn's output.
    // An "ok" that answers the agent's own question is an approval: it keeps
    // the nudge.
    // A text that comes with an attachment ("ok" under a screenshot) is not
    // a bare acknowledgement: the attachment is the message.
    let silenceOk = false;
    if (
      CHANNEL_DRIVEN_ORIGINS.has(req.origin) &&
      req.origin_id !== "inject" &&
      !req.origin_id.startsWith("job:")
    ) {
      const now = Date.now();
      const key = seenKey(req.agent_id, req.origin_id);
      const prevSeen = this.lastPromptSeen.get(key);
      const repeat = isAnsweredRepeat(prevSeen, req.origin_id, req.text, now);
      const answersQuestion = prevSeen?.asked === true;
      silenceOk =
        !hasAttachments(req.metadata) &&
        (repeat || (isBareAcknowledgement(req.text) && !answersQuestion));
      this.lastPromptSeen.set(key, {
        origin_id: req.origin_id,
        text: req.text.trim(),
        at: now,
        // A silenced repeat inherits the answer, so a third copy stays silent.
        answered: repeat,
        ...(repeat && prevSeen?.asked ? { asked: true } : {}),
      });
    }
    // Remember the origin so `ingestReply` can attach it to the
    // outbound `response.text` event for surface-aware routing.
    //
    // #284 MEDIUM: if a prior prompt is still in flight (the slot is already
    // occupied), this overwrite makes the cached identity ambiguous for the
    // security gate — mark the agent so the permission gate won't attribute a
    // deny to the wrong user/skill. A `set` onto an empty slot is a clean,
    // unambiguous single prompt, so clear any prior taint.
    const originRecord = {
      origin: req.origin,
      origin_id: req.origin_id,
      ...(silenceOk ? { silenceOk: true } : {}),
      // #258 item 3 slice 2: carry the inbound identity so the per-tool
      // permission gate can scope policy by user and (when a surface tags the
      // submit with metadata.command) by skill.
      userId: req.user_id || undefined,
      skillName:
        typeof req.metadata?.command === "string"
          ? req.metadata.command.replace(/^\//, "")
          : undefined,
    };
    if (this.awaitOwnPromptLine.has(req.agent_id)) {
      // #239: admitted onto a turn that may still be running. Its late reply
      // — or the text the net synthesises for it — routes by the slot, so the
      // slot keeps that turn's chat until THIS prompt's own line proves the
      // REPL moved on (`applyPendingOrigin`).
      this.pendingOrigin.set(req.agent_id, originRecord);
    } else {
      this.applyOrigin(req.agent_id, originRecord);
    }
    // Silent-drop safety net (#215): new prompt → reset the "did this
    // turn call reply?" flag. If the agent ends the turn (response.turn_end)
    // without ever setting this to true, we'll synthesize delivery.
    // #217 finding 2: a new turn starts undelivered — clear the
    // cross-transport "final already published" dedup flag.
    this.openTurn(req.agent_id);
    // Reply-tool enforcement (#215/#240): a fresh user turn — drop any nudge
    // state from the previous turn so this turn gets its own one-shot nudge.
    this.replyNudged.delete(req.agent_id);
    this.pendingNudgeText.delete(req.agent_id);

    const ipcMsg: IpcPrompt = {
      type: "prompt",
      agent_id: req.agent_id,
      origin: req.origin,
      origin_id: req.origin_id,
      user_id: req.user_id,
      text: req.text,
      metadata: req.metadata,
    };
    let ipcSendFailed = false;
    if (this.ipcServer) {
      // #428: deliver each prompt once. An agent the PTY leg below delivers to
      // gets NO `prompt` frame — the MCP server would turn it into a channel
      // notification that opens a turn of its own, so the agent received the
      // prompt twice, and a long prompt's typed copy, absorbed into that turn,
      // was then re-delivered by the turn-start verify as a second turn. Its
      // MCP liveness (#222) is still checked, without sending, and everything
      // that hangs off a failure below is unchanged.
      const ptyDelivers = this.streamPromptHandler !== null && this.ptyReachable(req.agent_id);
      const sent = ptyDelivers
        ? this.ipcServer.hasConnection(req.agent_id)
        : this.emitModelInput(ipcMsg).status === "sent";
      if (!sent) {
        ipcSendFailed = true;
        this.onError(new Error(`No MCP connection for agent_id=${req.agent_id}`), {
          ctx: "sendPrompt",
        });
        // #222 observability: was the agent ever registered, or did it just
        // drop? `registeredKnown=false` means we never saw a hello (a fresh
        // mcp-server never reached the bus); `=true` + no connection means the
        // socket dropped after handshake. Distinguishes "never connected"
        // from "connected then lost" at a glance.
        this.logIpc("send-failed", {
          agent: req.agent_id,
          ctx: "sendPrompt",
          registeredKnown: this.connectedAgents.has(req.agent_id),
          connections: this.ipcServer.connectionCount(),
        });
        // The inbound prompt still falls through to PTY-stdin below, but the
        // agent's outbound `reply` path rides this same dead IPC with no
        // fallback → it goes deaf. Signal the daemon to reconcile (respawn if
        // the process is alive-but-deaf). Debounce/cooldown live in the wired
        // reconciler, not here.
        this.onMcpSendFailed(req.agent_id, { reason: "sendPrompt:no-mcp-connection" });
      }
    }

    // PTY-stdin delivery for headless agents. Wrap the prompt as a
    // <channel source=... chat_id=... user_id=... ts=... [meta...]>text</channel>
    // block so the model knows it came from a surface and must respond with the
    // `reply` tool (mirrors the inbound contract of aerolalit's reference channel
    // plugin). Best-effort: a missing/failed handler never blocks the IPC path.
    if (this.streamPromptHandler) {
      const attrs = [
        `source="${escapeXmlAttr(req.origin)}"`,
        `chat_id="${escapeXmlAttr(req.origin_id)}"`,
        `user_id="${escapeXmlAttr(req.user_id)}"`,
        `ts="${new Date().toISOString()}"`,
      ];
      if (req.metadata) {
        for (const [k, v] of Object.entries(req.metadata)) {
          // Objects/arrays must be JSON-encoded — `String(obj)` yields the
          // useless literal "[object Object]" in the channel block. Guard against
          // circular refs (mirrors mcp-server's flattenChannelMeta) so a pathological
          // metadata value can't throw on this PTY-delivery path.
          let encoded: string;
          if (v !== null && typeof v === "object") {
            try {
              encoded = JSON.stringify(v);
            } catch {
              encoded = "[unserializable]";
            }
          } else {
            encoded = String(v);
          }
          attrs.push(`${k}="${escapeXmlAttr(encoded)}"`);
        }
      }
      const wrapped = `<channel ${attrs.join(" ")}>${escapeXmlText(req.text)}</channel>`;
      if (this.awaitOwnPromptLine.has(req.agent_id)) {
        this.awaitOwnPromptLine.set(req.agent_id, promptLineKey(wrapped));
      }
      // If the agent's session is (re)initialising the prompt is HELD and the
      // backstop flush-verify path already covers it. The uncovered case is an
      // IMMEDIATE delivery whose IPC send just failed: the MCP/IPC socket
      // blipped at the prompt boundary, so the PTY keystroke can coincide with a
      // reconnect and be swallowed without starting a turn — and the #222
      // reconciler disarms on "reconnected during confirm window" WITHOUT
      // checking a turn started (dossier 20260614T034258). Verify turn-start for
      // that prompt and re-deliver once if none lands.
      // Arm a turn-start verify when the PTY confirm-loop can't be trusted to
      // attribute the turn to THIS prompt: the IPC send just failed (socket
      // blip). The verify defers while a turn stays active and re-delivers
      // only if no turn ever starts.
      //
      // #239: the other reason this used to arm — a neighbor turn already
      // streaming, so the keystroke sat in the REPL box and the confirm-loop
      // could read the neighbor's stream as this prompt's start (#250 HIGH) —
      // cannot hold here any more: admission waits for the REPL to be free.
      // The deferral in the verify timer stays, for the re-deliveries that do
      // not pass through admission (a backstop flush, a #361 give-up).
      const deliveredImmediately = !this.agentInitializing.has(req.agent_id);
      // #239: admitted after an early release, the prompt may be typed into a
      // turn that is still running — the one case left where the REPL box can
      // swallow it (#250). Verify its own turn starts; re-deliver once if not.
      const intoLiveTurn = this.awaitOwnPromptLine.has(req.agent_id);
      this.deliverOrQueuePrompt(req.agent_id, wrapped);
      if ((ipcSendFailed || intoLiveTurn) && deliveredImmediately) {
        this.armFlushVerify(req.agent_id, [wrapped]);
      }
    } else if (ipcSendFailed) {
      // #372 source A: neither leg took the prompt — no PTY handler, and the
      // IPC send failed. No turn will start and no terminator is coming, so
      // the slot counted above would be held until the deadline, and under
      // #239 that is the agent deaf to every origin for `turnDeadlineMs`.
      // Release it now: a prompt that never reached the agent never held a
      // slot. (A bus with no IPC server at all is the in-process / test
      // configuration; its prompts are observed on the bus itself, so the
      // slot stays.)
      this.logIpc("undeliverable", { agent: req.agent_id, ctx: "sendPrompt", promise_id });
      this.releaseTurn(req.agent_id);
      this.admitNext(req.agent_id);
    }
    return { promise_id, ipc_sent: this.ipcServer ? !ipcSendFailed : undefined };
  }

  /** Deliver a PTY-stdin prompt, or hold it if the agent's session is
   *  (re)initialising (the not-yet-ready TUI would swallow the keystroke).
   *  Held prompts flush on `replay_done` (`markAgentReady`) or the backstop. */
  /** #402: has any readiness signal followed the agent's last socket close —
   *  the same process back (`hello`) or a replacement ready (`replay_done`)?
   *  True when no close has happened yet. */
  private readySinceClose(agent_id: string): boolean {
    const epoch = this.inFlightEpoch.get(agent_id) ?? 0;
    return (
      epoch === 0 ||
      this.readyEpoch.get(agent_id) === epoch ||
      this.helloEpoch.get(agent_id) === epoch
    );
  }

  /** A RE-delivery (verify, released hold, late give-up): after a socket
   *  close and before any readiness signal, the gate's init hold may already
   *  be gone and the process may be dead or booting — park it in the
   *  carry-over instead, to be drained on `hello` or `replay_done`. A fresh
   *  prompt keeps its immediate path (an IPC-only drop leaves the PTY usable). */
  private redeliverPrompt(agent_id: string, wrapped: string): void {
    if (this.readySinceClose(agent_id)) {
      this.deliverOrQueuePrompt(agent_id, wrapped);
      return;
    }
    const carried = this.pendingRedelivery.get(agent_id) ?? [];
    if (!carried.includes(wrapped)) this.pendingRedelivery.set(agent_id, [...carried, wrapped]);
  }

  private deliverOrQueuePrompt(agent_id: string, wrapped: string): void {
    if (!this.streamPromptHandler) return;
    this.touchTurn(agent_id); // #239: a delivery-layer transition is a sign of life
    if (this.agentInitializing.has(agent_id)) {
      const q = this.deliveryQueue.get(agent_id) ?? [];
      q.push(wrapped);
      this.deliveryQueue.set(agent_id, q);
      return;
    }
    this.streamDeliver(agent_id, wrapped);
  }

  private streamDeliver(agent_id: string, wrapped: string): void {
    if (!this.streamPromptHandler) return;
    // Track the handler as in-flight so a flush-verify timer can tell a prompt
    // that is legitimately being processed (e.g. holding through compaction)
    // from one that was silently swallowed (#252).
    this.inFlightDeliveries.set(agent_id, (this.inFlightDeliveries.get(agent_id) ?? 0) + 1);
    const epoch = this.inFlightEpoch.get(agent_id) ?? 0;
    // The tailer generation this delivery types into: a hold taken on its
    // verdict belongs to THIS generation, not to whatever is live when the
    // (possibly late) verdict lands. The process the PTY layer types into is
    // whichever the session manager has current — a replacement it has
    // spawned counts from the announce (#412), even before that tailer's
    // `replay_done` moves the live pointer.
    const generationAtStart = maxGeneration(
      this.agentTailerGeneration.get(agent_id),
      this.agentSpawnedGeneration.get(agent_id),
    );
    const key = sanitizePtyPromptText(wrapped);
    const token = ++this.deliveryToken;
    let proofs = this.inFlightProof.get(agent_id);
    if (!proofs) {
      proofs = new Map();
      this.inFlightProof.set(agent_id, proofs);
    }
    proofs.set(key, { proven: false, token });
    let wrappedByKey = this.inFlightWrapped.get(agent_id);
    if (!wrappedByKey) {
      wrappedByKey = new Map();
      this.inFlightWrapped.set(agent_id, wrappedByKey);
    }
    wrappedByKey.set(key, wrapped);
    // Only the delivery that owns the key may act on its entry: a superseded
    // one (see `deliveryToken`) resolves into nothing.
    const owns = () => this.inFlightProof.get(agent_id)?.get(key)?.token === token;
    void this.streamPromptHandler(agent_id, wrapped)
      .then((outcome) => {
        // Issue #361: the PTY confirm loop gave up — an auto-compaction (or a
        // redraw) swallowed the keystrokes, the screen could not prove a turn,
        // and the loop has already cleared the input box. Until now that
        // verdict died in a log line: nothing re-delivered, and the sender
        // learned of it at the 5 min receipt timeout. The prompt is no longer
        // anywhere the CLI could pick it up on its own, so the only way it
        // still reaches the model is if the CLI had already taken it — in
        // which case the transcript says so (`prompt`, or an absorption,
        // cancels the verify — or, if it spoke while the handler was still
        // deciding, `inFlightProof` remembers it) or its turn is running (the
        // verify defers). Otherwise re-deliver it once, through the same
        // at-most-once verify the backstop flush uses. `void` (a handler that
        // cannot judge) and `turn-started` arm nothing, exactly as before.
        //
        // `stuck-compaction` is not re-delivered NOW: the CLI can buffer the
        // keystrokes through an auto-compaction and submit them itself when it
        // ends, so re-typing while it runs would land a second copy in the
        // same buffer — two runs. Until #402 that verdict was simply dropped
        // (a log line, `delivery_outcome` on the receipt) — the last lost-
        // prompt path from #361. It is now HELD until the compaction is
        // positively over (`session.compact`, or a new session generation),
        // then put through the same verify: see `compactionHeld`. The
        // deadline exit is the one place the old hazard survives: a compaction
        // that outlives it (> 14 min with the PTY budget) while `agentTurnActive`
        // has been cleared would let the verify type into a still-compacting
        // REPL — bounded to one re-delivery by the at-most-once rule, and
        // preferred to losing the prompt outright.
        // Never re-delivered: a bus-injected `<system-reminder>` (the reply
        // nudge) — the synthesized fallback already backs it, and a stale
        // nudge re-typed ten seconds later would open a fresh turn whose
        // `reply` is not deduplicated against that fallback.
        // The in-flight record must still be there and unproven: `stop()`
        // clears it, so a handler that resolves after shutdown arms no timer
        // on a bus that has already torn its verifies down.
        const entry = owns() ? this.inFlightProof.get(agent_id)?.get(key) : undefined;
        // This delivery WAS the one re-delivery (carried over a close, or a
        // late give-up put through the gate): whatever it reports, at-most-once
        // says this is the end of the line for that prompt.
        // Only the delivery that owns the key may consume its sentinel: a
        // superseded retry must not spend it for the delivery that replaced it.
        const spent = this.spentRetry.get(agent_id);
        const wasRetry = owns() && spent?.delete(key) === true;
        if (spent && spent.size === 0) this.spentRetry.delete(agent_id);
        if (
          !wasRetry &&
          typeof outcome === "string" &&
          outcome !== "turn-started" &&
          entry?.proven === false &&
          !wrapped.startsWith("<system-reminder>")
        ) {
          if (outcome === "stuck-compaction") {
            // Closed or not: a compaction is (or was) running in the process
            // this delivery typed into. The hold covers both cases without
            // knowing which — its boundary releases it if the process is the
            // same (an IPC-only drop does not touch the tailer), a newer
            // generation releases it if the process was replaced, the deadline
            // bounds the rest — and a released hold re-delivers through
            // `redeliverPrompt`, which waits for readiness after a close.
            this.holdThroughCompaction(agent_id, wrapped, generationAtStart);
          } else if (entry.closedEpoch !== undefined) {
            // The socket closed while this delivery was deciding, and it gave
            // up unproven: the prompt never reached the model. This is its one
            // re-delivery: through the gate if a readiness signal followed the
            // close, otherwise carried to the next one.
            const retries = this.spentRetry.get(agent_id) ?? new Set<string>();
            retries.add(key);
            this.spentRetry.set(agent_id, retries);
            this.redeliverPrompt(agent_id, wrapped);
          } else this.armFlushVerify(agent_id, [wrapped]);
        }
      })
      .catch((err) => this.onError(err, { ctx: "streamPromptHandler", agent_id }))
      .finally(() => {
        // A socket close reset this agent's in-flight accounting since this
        // delivery began: it is not ours to decrement any more.
        if ((this.inFlightEpoch.get(agent_id) ?? 0) === epoch) {
          const n = (this.inFlightDeliveries.get(agent_id) ?? 1) - 1;
          if (n <= 0) this.inFlightDeliveries.delete(agent_id);
          else this.inFlightDeliveries.set(agent_id, n);
        }
        if (!owns()) return; // a newer delivery of the same text owns the key
        const p = this.inFlightProof.get(agent_id);
        if (p) {
          p.delete(key);
          if (p.size === 0) this.inFlightProof.delete(agent_id);
        }
        const w = this.inFlightWrapped.get(agent_id);
        if (w) {
          w.delete(key);
          if (w.size === 0) this.inFlightWrapped.delete(agent_id);
        }
      });
  }

  /** `session.init` → start holding PTY-stdin prompts for this agent, UNLESS
   *  the agent is already past `replay_done` for this session generation (the
   *  fresh/restart/rotation path emits `replay_done` BEFORE `session.init`, so
   *  the session is already live and must not be re-held). The backstop
   *  force-flushes if `replay_done` never arrives, so a held prompt is never
   *  stranded; the hold is re-armed on each fresh-generation `session.init`. */
  private markAgentInitializing(agent_id: string, session_id?: string): void {
    // Order-independence: if `replay_done` for this generation was already
    // observed, the session is live — a (late) `session.init` for it must not
    // arm a fresh hold. A missing/unknown session_id falls through to arming,
    // bounded by the backstop, so worst case = the previous behaviour.
    if (session_id && this.agentLiveSession.get(agent_id) === session_id) return;
    // Keep the EARLIEST deadline: don't re-arm if already holding. Otherwise a
    // rapid `session.init` churn (< backstop interval, e.g. an IPC-reconnect
    // storm) would keep pushing the deadline out and strand held prompts. The
    // backstop must fire within `deliveryBackstopMs` of the FIRST init.
    if (this.agentInitializing.has(agent_id)) return;
    const timer = setTimeout(() => {
      this.onError(
        new Error(
          `replay_done not seen within backstop; flushing held prompts for agent_id=${agent_id}`,
        ),
        { ctx: "deliveryBackstop", agent_id },
      );
      this.markAgentReady(agent_id, undefined, true);
    }, this.deliveryBackstopMs);
    this.agentInitializing.set(agent_id, timer);
  }

  /** `replay_done` (or backstop) → session ready: record the live generation
   *  (so a late `session.init` for it can't re-arm a hold), clear any pending
   *  hold, and flush held prompts in order. Called unconditionally on
   *  `replay_done`, which the tailer emits for every session generation. */
  private markAgentReady(
    agent_id: string,
    session_id?: string,
    viaBackstop = false,
    generation?: number,
  ): void {
    // #402: a marker from a tailer generation OLDER than the live one is the
    // tailer being replaced finishing its last read after the replacement
    // published. It must not move the live pointer back, clear the
    // replacement's init hold, flush the queue into a session that has not
    // said it is ready, nor release a compaction hold — a no-op, logged so a
    // rotation storm shows. Ordering is only known when the marker carries a
    // generation (session-manager wiring); without one, behaviour is as before.
    const liveGeneration = this.agentTailerGeneration.get(agent_id);
    // #412: a marker older than the generation the manager has SPAWNED is stale
    // too, even before that generation's own `replay_done` moved the live
    // pointer — the old tailer's last read must not clear the replacement's
    // init state nor drain the queue into it before its own readiness marker.
    const knownGeneration = maxGeneration(
      liveGeneration,
      this.agentSpawnedGeneration.get(agent_id),
    );
    if (generation !== undefined && knownGeneration !== undefined && generation < knownGeneration) {
      console.warn(
        `[bus] ignoring stale replay_done for agent=${agent_id} (tailer generation ${generation} < ${liveGeneration !== undefined && generation < liveGeneration ? `live ${liveGeneration}` : `spawned ${knownGeneration}`})`,
      );
      return;
    }
    // #412 item 3: a marker WITHOUT a generation for an agent whose tailers are
    // numbered means a second tailer wiring exists next to the session
    // manager's. Its markers get the pre-#402 semantics (they order nothing
    // and release every hold); nothing changes here, but say so once — the
    // day that wiring appears, this line is how the two are told apart.
    // The delivery backstop calls in with no marker at all (`viaBackstop`) —
    // that is not a tailer speaking, so it says nothing here.
    if (generation === undefined && !viaBackstop && knownGeneration !== undefined) {
      this.warnUnnumberedMarker(agent_id, "replay_done");
    }
    // A replacement is a numeric generation ADVANCING. The first marker ever
    // seen for an agent is not one: it may be the very tailer that accepted a
    // prompt before its marker was ingested, so it must not release a hold.
    const newGeneration =
      generation !== undefined && liveGeneration !== undefined && generation > liveGeneration;
    if (generation !== undefined) this.agentTailerGeneration.set(agent_id, generation);
    if (session_id) this.agentLiveSession.set(agent_id, session_id);
    if (!viaBackstop) this.readyEpoch.set(agent_id, this.inFlightEpoch.get(agent_id) ?? 0);
    const timer = this.agentInitializing.get(agent_id);
    if (timer) clearTimeout(timer);
    this.agentInitializing.delete(agent_id);
    // A (re)ready session generation cannot have the previous turn still
    // streaming, so clear the neighbor-turn flag here too. This is the
    // generation boundary that recovers a stuck agentTurnActive after a
    // reconciler restart whose new tailer (startAt:"end") never replays the
    // interrupted turn's end_turn — without it, flush-verify would defer
    // forever for this agent and leak a lingering entry per prompt (#252 stack
    // ultra HIGH).
    this.agentTurnActive.delete(agent_id);
    // #402: a NEW tailer generation cannot still be running the compaction a
    // held prompt was waiting on; verify it now. Neither a marker for the
    // generation the hold was taken in (a re-emitted `replay_done`, or a
    // `--resume` restart that keeps the session id) nor the init backstop —
    // a readiness fallback that can fire while the compaction continues — is
    // that signal; those leave the hold to its end signal or its deadline.
    if (newGeneration && !viaBackstop)
      this.releaseCompactionHold(agent_id, { notGeneration: generation });
    // Re-deliver prompts carried over from a prior socket close (e.g. a #222
    // reconciler restart of a deaf agent): the fresh session is now ready, so
    // push them through the gate. Independent of the held-queue below, and done
    // first so they keep their original order ahead of anything newly held.
    const carried = this.pendingRedelivery.get(agent_id);
    const flushed: string[] = [];
    if (carried) {
      this.pendingRedelivery.delete(agent_id);
      for (const wrapped of carried) {
        flushed.push(wrapped);
        this.noteRedelivered(agent_id, wrapped);
        this.deliverOrQueuePrompt(agent_id, wrapped);
      }
    }
    const q = this.deliveryQueue.get(agent_id);
    if (q && q.length > 0) {
      this.deliveryQueue.delete(agent_id);
      for (const wrapped of q) {
        flushed.push(wrapped);
        this.noteRedelivered(agent_id, wrapped);
        this.streamDeliver(agent_id, wrapped);
      }
      // A backstop flush is timer-driven (no `replay_done`), so the session may
      // still be mid-(re)init and swallow the keystroke; verify a turn actually
      // starts and re-deliver once if not. The real `replay_done` path is
      // known-ready and needs no verification.
      if (viaBackstop) this.armFlushVerify(agent_id, q);
    }
    // #239: the streaming flag was cleared above; if the slot is free too
    // (its turn ended, or was released abnormally) a prompt queued behind it
    // goes now — AFTER the carried and held prompts, which were admitted first.
    // The slot of a turn this boundary interrupted is deliberately NOT freed
    // here (#372: the held prompts just flushed were counted on it); the
    // deadline bounds that case. A gate parked by an IPC close is released:
    // a new generation cannot still be running the turn that was live then.
    // Only a generation known to be NEW — or, when generations are not
    // numbered, a real `replay_done` — says so; a re-emitted marker for the
    // live generation could still be mid-turn.
    const redelivered = this.redeliveredSinceClose.get(agent_id) ?? [];
    if (generation === undefined ? !viaBackstop : newGeneration) {
      // A new generation cannot still be running the turn that was live at
      // the close — unless the bus has since re-delivered a prompt into this
      // agent (on `hello`, or just above): that one is running, or about to.
      if (redelivered.length === 0) this.gateParked.delete(agent_id);
      // The interrupted turn's line will never be tailed by this generation.
      // The prompt admitted after it runs here only if it was re-delivered;
      // its chat takes the slot then, and only then — a slot pointing at a
      // chat whose turn is not coming would route an ambient turn's text
      // there (the #138 rule the close-time clear exists for).
      const awaited = this.awaitOwnPromptLine.get(agent_id);
      this.awaitOwnPromptLine.delete(agent_id);
      this.earlyReleased.delete(agent_id); // the released turn cannot outlive its generation
      this.deadlineReleased.delete(agent_id);
      const rerun =
        awaited === undefined ||
        awaited === null ||
        redelivered.some((w) => promptLineKey(w) === awaited);
      if (rerun) this.applyPendingOrigin(agent_id);
      else this.pendingOrigin.delete(agent_id);
    }
    // #239: a re-delivery holds no slot (the close freed it), yet it is a
    // bus-owned prompt about to run in this REPL. Admitting the queue behind
    // it would put two bus prompts in one turn — the invariant this queue
    // exists for. `noteRedelivered` parked the gate on it; its `turn_end`
    // un-parks, so nothing is admitted here.
    this.touchTurn(agent_id);
    if (flushed.length === 0) this.admitNext(agent_id);
  }

  /** #239: a carried prompt went back out — see `redeliveredSinceClose`. */
  private noteRedelivered(agent_id: string, wrapped: string): void {
    const list = this.redeliveredSinceClose.get(agent_id) ?? [];
    list.push(wrapped);
    this.redeliveredSinceClose.set(agent_id, list);
    this.gateParked.add(agent_id);
  }

  /** Arm per-prompt turn-start verification after a backstop flush — or after
   *  a delivery the PTY layer reported as a give-up (#361). Each such
   *  prompt gets its own one-shot timer; a prompt already awaiting verification
   *  is left untouched (a second flush ADDS to the set, never discards pending
   *  ones — #252). The timer is cancelled by `noteFlushTurnStart` when the
   *  matching `prompt` lands, and re-delivers exactly that prompt otherwise. */
  /** #402: park a prompt whose delivery gave up on `stuck-compaction` until the
   *  compaction is positively over, then verify-then-re-deliver it. At most
   *  once per prompt across holds and verifies: a prompt already verified (or
   *  already held) is never armed again. */
  private holdThroughCompaction(
    agent_id: string,
    wrapped: string,
    generation: number | undefined,
  ): void {
    const key = sanitizePtyPromptText(wrapped);
    // The generation this delivery typed into has already been replaced: the
    // compaction it was stuck in is gone with the process, and no later
    // "newer generation" marker will come for it — verify now (through the
    // readiness-gated re-delivery), instead of waiting the whole deadline.
    const live = this.agentTailerGeneration.get(agent_id);
    if (generation !== undefined && live !== undefined && live > generation) {
      if (this.flushVerify.get(agent_id)?.get(key)?.redelivered) return;
      this.armFlushVerify(agent_id, [wrapped]);
      return;
    }
    const pending = this.flushVerify.get(agent_id);
    const verifying = pending?.get(key);
    if (verifying) {
      // The one re-delivery is spent: this verdict is the re-delivery's own,
      // and at-most-once says stop here.
      if (verifying.redelivered) return;
      // Otherwise it is a verify `sendPrompt` pre-armed for this delivery (IPC
      // send failed, or a neighbor turn was active) — still live, and it would
      // fire on its ordinary clock while the compaction runs, retyping into it.
      // The hold replaces it: same prompt, same at-most-once, later clock.
      clearTimeout(verifying.timer);
      pending?.delete(key);
      if (pending && pending.size === 0) this.flushVerify.delete(agent_id);
    }
    // Known latency, accepted on purpose: two of the PTY layer's three
    // `stuck-compaction` sources fire AFTER the boundary was written (the
    // post-compaction tail with no footer, a compaction latch whose clear
    // marker was lost), so their `session.compact` has already passed and this
    // hold runs to the deadline. Verifying "right away when a boundary was seen
    // since the delivery began" was tried and is unsafe: the PTY layer
    // serialises writes, so a prompt can sit behind an earlier delivery while
    // an EARLIER compaction ends, and that boundary cannot be told apart from
    // this prompt's own — the shortcut would retype into a compaction that is
    // still running, the very double #400 refused. Binding a boundary to one
    // delivery needs the PTY layer to say which compaction it gave up on.
    let held = this.compactionHeld.get(agent_id);
    if (!held) {
      held = new Map();
      this.compactionHeld.set(agent_id, held);
    }
    if (held.has(key)) return;
    this.touchTurn(agent_id); // #239: the hold is a transition, not silence
    const heldAt = Date.now();
    held.set(key, {
      wrapped,
      // The tailer generation this hold belongs to: only its own generation's
      // `session.compact`, or a NEWER generation's `replay_done`, releases it.
      generation,
      heldAt,
      timer: setTimeout(() => {
        // #412: this exit is a measurement, not a routine event. Terry's
        // condition for closing #412 was that it be visible on a live daemon:
        // the remaining hazard there (a compaction outliving the hold) has
        // never been observed, and this line is what would reopen it with
        // evidence. Same shape as the #239 turn deadline, `[bus]` on stderr,
        // naming the agent and how long the prompt actually waited (the wall
        // clock, not the configured limit — a blocked event loop stretches it).
        const waited = Date.now() - heldAt;
        const others = (this.compactionHeld.get(agent_id)?.size ?? 1) - 1;
        const msg =
          `compaction hold deadline: agent=${agent_id} waited ${waited}ms ` +
          `(limit ${this.stuckCompactionResolveMs}ms, generation ${generation ?? "unknown"}` +
          `${others > 0 ? `, ${others} other prompt(s) still held` : ""}) — ` +
          "the compaction never reported its end; verifying the held prompt anyway. " +
          "If you are reading this on a live daemon, #412 wants to hear about it.";
        console.error(`[bus] ${msg}`);
        this.onError(new Error(msg), {
          ctx: "compactionHold",
          agent_id,
          waited,
          limit: this.stuckCompactionResolveMs,
          generation,
          others,
        });
        // Only THIS entry: a later prompt held behind a longer compaction keeps
        // its own deadline instead of being verified on the first one's clock.
        this.releaseCompactionHold(agent_id, { key });
      }, this.stuckCompactionResolveMs),
    });
  }

  /** #402: the compaction is over (or the session generation changed, which
   *  cannot still be compacting) — every held prompt now goes through the
   *  at-most-once verify. If the CLI submitted the buffered keystrokes when the
   *  compaction ended, the transcript's `prompt` line attributes and cancels
   *  it; otherwise it is re-delivered once. */
  private releaseCompactionHold(
    agent_id: string,
    only?: { key?: string; notGeneration?: number; generation?: number; boundaryAt?: number },
  ): void {
    const held = this.compactionHeld.get(agent_id);
    if (!held) return;
    const prompts: string[] = [];
    for (const [key, entry] of held) {
      if (only?.key !== undefined && key !== only.key) continue;
      // A boundary whose transcript line predates the hold ended an EARLIER
      // compaction — the one this prompt is stuck in ends after the hold was
      // taken. (Same-host clocks: the CLI stamps the line, the bus stamps the
      // hold; a small tolerance absorbs write latency.)
      if (only?.boundaryAt !== undefined && only.boundaryAt < entry.heldAt - 2000) continue;
      // A new generation's marker releases holds taken under OLDER ones only.
      if (only?.notGeneration !== undefined && entry.generation === only.notGeneration) continue;
      // A compaction boundary releases holds of ITS generation only (a hold
      // taken before any generation was known has nothing to compare).
      if (
        only?.generation !== undefined &&
        entry.generation !== undefined &&
        entry.generation !== only.generation
      )
        continue;
      clearTimeout(entry.timer);
      held.delete(key);
      prompts.push(entry.wrapped);
    }
    if (held.size === 0) this.compactionHeld.delete(agent_id);
    if (prompts.length > 0) this.armFlushVerify(agent_id, prompts);
  }

  private armFlushVerify(agent_id: string, prompts: string[]): void {
    this.touchTurn(agent_id); // #239: a verify armed is a sign of life
    let pending = this.flushVerify.get(agent_id);
    if (!pending) {
      pending = new Map();
      this.flushVerify.set(agent_id, pending);
    }
    for (const wrapped of prompts) {
      // Key by the text the tailer will actually observe, NOT the raw wrapped
      // string: the PTY layer runs sanitizePtyPromptText (collapses newlines to
      // spaces, strips control chars) before typing, and claude records — and
      // the tailer re-emits as the `prompt` event — that sanitized form. Keying
      // by the raw wrapped (with literal newlines) would never match a
      // multi-line prompt's turn-start event, so attribution would silently
      // fail and a healthy turn get re-delivered / double-submitted (#252
      // ultra-review HIGH). Keep the original wrapped to re-deliver verbatim.
      const key = sanitizePtyPromptText(wrapped);
      // pending.has(key) covers BOTH an active verify AND a re-delivered entry
      // left in place to enforce at-most-once (see scheduleFlushVerify): a later
      // backstop flush therefore never arms a 2nd verify for the same prompt.
      if (pending.has(key)) continue;
      pending.set(key, {
        wrapped,
        graced: false,
        timer: this.scheduleFlushVerify(agent_id, key, this.flushVerifyMs),
      });
    }
  }

  private scheduleFlushVerify(
    agent_id: string,
    key: string,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.flushVerify.get(agent_id);
      const entry = pending?.get(key);
      if (!pending || !entry) return;
      // Defer while the prompt legitimately can't have started its turn yet:
      //  - a delivery handler is still in-flight (compaction-aware: it holds
      //    through auto-compaction, up to maxCompactionWaitMs ≫ flushVerifyMs); or
      //  - a neighbor turn is still streaming, so this prompt is queued behind it
      //    in the REPL box and can only start once that turn ends (#250 HIGH).
      // Re-delivering in either case would double-submit. Re-arm and re-check.
      if ((this.inFlightDeliveries.get(agent_id) ?? 0) > 0 || this.agentTurnActive.has(agent_id)) {
        entry.graced = false;
        entry.timer = this.scheduleFlushVerify(agent_id, key, this.flushVerifyMs);
        return;
      }
      // Post-settle grace: the handler has returned but the turn-start `prompt`
      // event reaches the bus asynchronously (JSONL tailer) and can lag behind.
      // Wait one short grace for it before declaring the prompt swallowed, else a
      // turn that started right as the handler returned would be re-delivered
      // (the post-settle/pre-ingest double-submit window).
      if (!entry.graced) {
        entry.graced = true;
        entry.timer = this.scheduleFlushVerify(agent_id, key, this.flushVerifyGraceMs);
        return;
      }
      // No turn after settle + grace → genuinely swallowed by a still-(re)init
      // TUI. Re-deliver through the gate so an in-progress re-init re-holds it
      // instead of swallowing it again. KEEP the entry in `pending` (don't
      // delete) and do NOT re-arm: a later backstop flush sees pending.has(key)
      // and skips it, so a prompt gets AT MOST ONE re-delivery for its whole
      // lifetime (the watchdog is the net beyond that). The entry is cleared
      // when the re-delivery's turn-start lands (noteFlushTurnStart) or on
      // socket close / shutdown (clearFlushVerify).
      this.onError(
        new Error(
          `delivered prompt produced no turn within ${this.flushVerifyMs}ms; re-delivering once for agent_id=${agent_id}`,
        ),
        { ctx: "flushVerify", agent_id },
      );
      entry.redelivered = true;
      // This re-delivery is the prompt's one retry: whatever its verdict, it
      // arms nothing further (#402).
      const retries = this.spentRetry.get(agent_id) ?? new Set<string>();
      retries.add(key);
      this.spentRetry.set(agent_id, retries);
      this.redeliverPrompt(agent_id, entry.wrapped);
    }, delayMs);
  }

  /** A tailer `prompt` event proves THAT specific prompt started its turn: its
   *  ingested text is the user line claude recorded = the wrapped string we
   *  delivered. Cancel only the matching pending verify, so an unrelated later
   *  prompt's turn never silences a still-swallowed earlier prompt's
   *  re-delivery (#252). The absorption records (#389) are the other proof —
   *  same text, same exact-match lookup: the prompt reached the model inside
   *  the running turn instead of opening its own. */
  /** The exact key when one of the agent's pending entries carries it;
   *  otherwise the pending key whose whitespace-stripped form matches; else
   *  the exact key unchanged (no entry — the callers' lookups then miss). */
  private matchPromptKey(agent_id: string, key: string): string {
    const has = (m: Map<string, unknown> | undefined) => m?.has(key) === true;
    if (
      has(this.flushVerify.get(agent_id)) ||
      has(this.inFlightProof.get(agent_id)) ||
      has(this.compactionHeld.get(agent_id)) ||
      this.spentRetry.get(agent_id)?.has(key)
    ) {
      return key;
    }
    const stripped = key.replace(/\s+/g, "");
    for (const m of [
      this.flushVerify.get(agent_id),
      this.inFlightProof.get(agent_id),
      this.compactionHeld.get(agent_id),
    ]) {
      if (!m) continue;
      for (const k of m.keys()) if (k.replace(/\s+/g, "") === stripped) return k;
    }
    const sentinels = this.spentRetry.get(agent_id);
    if (sentinels) for (const k of sentinels) if (k.replace(/\s+/g, "") === stripped) return k;
    return key;
  }

  private noteFlushTurnStart(agent_id: string, ingestedText: string): boolean {
    // ingestedText is the line claude recorded (already PTY-sanitized) and the
    // map keys are sanitized too; sanitize again — it is idempotent — to be
    // robust against any residual normalization before the exact-match lookup.
    // #239: the CLI records whitespace differently from what was typed (a
    // pasted TAB becomes spaces), so an exact miss falls back to the
    // whitespace-agnostic shape both surfaces agree on — else a verify for a
    // prompt the CLI already ran would re-deliver it after the next turn.
    // #428: a long prompt is recorded inside the CLI's paste wrapper; its tags
    // go first. The newlines around them leave padding the exact lookup
    // misses; `matchPromptKey`'s whitespace fallback then finds the key armed
    // for what was typed.
    const key = this.matchPromptKey(agent_id, sanitizePtyPromptText(stripPasteTags(ingestedText)));
    // Proof for a delivery whose handler is still deciding (#361): remember
    // it, so a later give-up verdict for that same prompt arms nothing.
    const proofs = this.inFlightProof.get(agent_id);
    const proof = proofs?.get(key);
    if (proof) proof.proven = true;
    // A prompt the CLI recorded must not ride a carry-over into the next
    // session: drop it from the queue a late give-up verdict may have filled,
    // and drop its retry sentinel with it — the retry will never run, and a
    // later prompt with the same text must not be mistaken for it.
    const sentinels = this.spentRetry.get(agent_id);
    const wasRetryPending = sentinels?.delete(key) === true;
    if (wasRetryPending && sentinels && sentinels.size === 0) this.spentRetry.delete(agent_id);
    // A retry that reached the gate while the session was (re)initialising sits
    // in the held queue, not the carry-over: same rule, it must not flush on
    // `replay_done` for a prompt the CLI already has. Only a RETRY is removed
    // there — a fresh prompt with the same text is a different submission.
    if (wasRetryPending) {
      const q = this.deliveryQueue.get(agent_id);
      if (q) {
        const keptQ = q.filter((w) => sanitizePtyPromptText(w) !== key);
        if (keptQ.length === 0) this.deliveryQueue.delete(agent_id);
        else if (keptQ.length !== q.length) this.deliveryQueue.set(agent_id, keptQ);
      }
    }
    const carried = this.pendingRedelivery.get(agent_id);
    if (carried) {
      const kept = carried.filter((w) => sanitizePtyPromptText(w) !== key);
      if (kept.length === 0) this.pendingRedelivery.delete(agent_id);
      else if (kept.length !== carried.length) this.pendingRedelivery.set(agent_id, kept);
    }
    // #402: a prompt held through a compaction that the transcript records
    // anyway (the CLI processed the buffered input, or the compaction aborted
    // — no `compact_boundary` is written on failure) is proven: drop the hold
    // so the release never arms a verify for a prompt the model already has.
    const held = this.compactionHeld.get(agent_id);
    const heldEntry = held?.get(key);
    if (held && heldEntry) {
      clearTimeout(heldEntry.timer);
      held.delete(key);
      if (held.size === 0) this.compactionHeld.delete(agent_id);
      return true;
    }
    const pending = this.flushVerify.get(agent_id);
    if (!pending) return false;
    const entry = pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(key);
    if (pending.size === 0) this.flushVerify.delete(agent_id);
    return true;
  }

  /** #389: the CLI folded a delivered prompt into the turn already running.
   *  Its verify is satisfied (the prompt reached the model), and the turn
   *  `sendPrompt` counted for it will never terminate on its own — it is the
   *  running turn's. Release that count now, so the running turn's `turn_end`
   *  frees the operation slot instead of leaving it held (and every later
   *  event stamped with a stale `promise_id` + `correlation_ambiguous`) until
   *  some turn the bus did not open happens to end. Only a prompt whose
   *  verify was pending is counted: that is the one `sendPrompt` incremented
   *  for and the tailer never opened a turn for. */
  private noteAbsorbedPrompt(agent_id: string, text: string): void {
    // The CLI folded queued input into the running turn — if that input is the
    // IPC-only reply nudge, it reached the model; its PTY fallback must not type
    // a copy. Any other absorbed prompt leaves the fallback armed.
    this.clearNudgePtyFallback(agent_id, text);
    // #239: a prompt folded into the running turn will never get a line of
    // its own; the running turn's terminator is the one to wait for now.
    const awaited = this.awaitOwnPromptLine.get(agent_id);
    if (awaited !== undefined && (awaited === null || promptLineKey(text) === awaited)) {
      this.awaitOwnPromptLine.delete(agent_id);
      this.applyPendingOrigin(agent_id);
    }
    if (!this.noteFlushTurnStart(agent_id, text)) return;
    this.releaseTurn(agent_id);
  }

  /** One turn the bus counted has reached its end (its `turn_end`, or its
   *  absorption into another turn). Free the operation slot when no counted
   *  turn is left in flight. */
  private releaseTurn(agent_id: string): void {
    const left = (this.pendingTurns.get(agent_id) ?? 1) - 1;
    if (left > 0) {
      // A lagged terminator for an earlier turn. Another turn still owns the
      // slot; releasing here would strip its id mid-flight.
      this.pendingTurns.set(agent_id, left);
    } else {
      this.pendingTurns.delete(agent_id);
      this.currentOperation.delete(agent_id);
      this.correlationAmbiguous.delete(agent_id);
      this.touchTurn(agent_id); // #239: cleared, or re-armed for a nudge still outstanding
    }
  }

  /** Cancel and drop every pending flush-verify for an agent (socket close, or
   *  shutdown) so no stale timer fires into a restarted/reused session. */
  private clearFlushVerify(agent_id: string): void {
    const pending = this.flushVerify.get(agent_id);
    if (!pending) return;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    this.flushVerify.delete(agent_id);
  }

  async invokeSlashCommand(agent_id: string, cmd: string): Promise<void> {
    if (!this.slashCommandHandler) {
      throw new Error(
        "invokeSlashCommand requires a slashCommandHandler (wired by Session Manager — Sprint 1 Agent C)",
      );
    }
    await this.slashCommandHandler(agent_id, cmd);
  }

  setSlashCommandHandler(handler: SlashCommandHandler | null): void {
    this.slashCommandHandler = handler;
  }

  setStreamPromptHandler(handler: StreamPromptHandler | null): void {
    this.streamPromptHandler = handler;
  }

  setPtyReachableHandler(handler: PtyReachableCheck | null): void {
    this.ptyReachable = handler ?? this.defaultPtyReachable;
  }

  setRecordingPendingHandler(handler: RecordingPendingCheck | null): void {
    this.recordingPending = handler;
  }

  setJobHandler(handler: AgentJobHandler | null): void {
    this.jobHandler = handler;
  }

  setMcpSendFailedHandler(
    handler: ((agentId: string, ctx: { reason: string }) => void) | null,
  ): void {
    this.onMcpSendFailed = handler ?? (() => {});
  }

  isAgentConnected(agentId: string): boolean {
    return this.connectedAgents.has(agentId);
  }

  /** True if the agent has a turn currently streaming (tailer `prompt` seen, no
   *  `response.turn_end` yet). The #222 reconciler reads this to avoid a
   *  destructive restart of an agent that is merely deaf-but-mid-turn — the turn
   *  still completes and is delivered by the silent-drop net (#215), which rides
   *  the tailer, not the dead MCP socket. */
  isAgentTurnActive(agentId: string): boolean {
    return this.agentTurnActive.has(agentId);
  }

  /** #315: the ids of every agent with a turn currently in flight (prompt seen,
   *  no `response.turn_end` yet). Exposed so an external restart/deploy guard can
   *  drain-then-restart instead of killing a turn mid-flight. Aggregate sibling of
   *  {@link isAgentTurnActive}. */
  hasIpcConnection(agentId: string): boolean {
    return this.ipcServer?.hasConnection(agentId) ?? false;
  }

  activeTurnAgents(): string[] {
    return [...this.agentTurnActive];
  }

  /**
   * Agents a restart would cost something (#315): a turn in flight, or a
   * prompt the bus still owes the model — a delivery whose user line is not
   * in the transcript yet, one queued behind an initialising session, one
   * held through a compaction, one carried over a socket close, or one whose
   * turn-start is still being verified (an entry that already spent its one
   * re-delivery is a marker, not pending work) — or a prompt accepted whose
   * turn has not started nor ended yet (`pendingTurns`). `activeTurnAgents()`
   * is the subset the dashboard shows; this is what the shutdown drain waits on.
   */
  busyAgents(): string[] {
    const busy = new Set<string>(this.agentTurnActive);
    // A prompt accepted by sendPrompt whose turn has neither started in the
    // transcript nor ended: the window between the PTY delivery settling and
    // the JSONL `prompt` line being ingested (Copilot on the PR).
    for (const [agent, n] of this.pendingTurns) if (n > 0) busy.add(agent);
    // #239: a prompt waiting behind an active turn is owed to the model too.
    for (const [agent, q] of this.promptQueue) if (q.lanes.size > 0) busy.add(agent);
    for (const [agent, n] of this.inFlightDeliveries) if (n > 0) busy.add(agent);
    for (const [agent, q] of this.deliveryQueue) if (q.length > 0) busy.add(agent);
    for (const [agent, held] of this.compactionHeld) if (held.size > 0) busy.add(agent);
    for (const [agent, carried] of this.pendingRedelivery) if (carried.length > 0) busy.add(agent);
    // An outstanding reply nudge: from its send — over IPC, PTY, or the IPC
    // copy's armed PTY fallback — until the reply or the synthesized delivery,
    // the bus still owes the user this turn's answer.
    for (const [agent, nudged] of this.replyNudged) if (nudged) busy.add(agent);
    for (const [agent, pending] of this.flushVerify) {
      for (const entry of pending.values()) {
        if (!entry.redelivered) {
          busy.add(agent);
          break;
        }
      }
    }
    return [...busy];
  }

  noteSpawnedGeneration(agent_id: string, generation: number): void {
    const known = this.agentSpawnedGeneration.get(agent_id);
    if (known === undefined || generation > known) {
      this.agentSpawnedGeneration.set(agent_id, generation);
    }
  }

  /* ─────────────────────────────── subscriptions ─────────────────────────────── */

  subscribe(filter: SubscriptionFilter, handler: SubscriptionHandler): Subscription {
    const id = randomUUID();
    const record: SubscriberRecord = {
      id,
      filter,
      handler,
      ringbuffer: [],
      overflowCount: 0,
      capacity: this.ringbufferCapacity,
      closed: false,
    };
    this.subscribers.set(id, record);
    const sub: Subscription = {
      id,
      close: () => {
        record.closed = true;
        this.subscribers.delete(id);
      },
      get overflowCount() {
        return record.overflowCount;
      },
      get depth() {
        return record.ringbuffer.length;
      },
    };
    return sub;
  }

  /* ─────────────────────────────── ingest ─────────────────────────────── */

  /** Take the routing slot for a prompt (#284: an occupied slot makes the
   *  cached identity ambiguous for the security gate). */
  private applyOrigin(
    agent_id: string,
    record: {
      origin: BusOrigin;
      origin_id: string;
      userId?: string;
      skillName?: string;
      silenceOk?: boolean;
    },
  ): void {
    if (this.lastPromptOrigin.has(agent_id)) {
      this.originAmbiguous.add(agent_id);
    } else {
      this.originAmbiguous.delete(agent_id);
    }
    this.rememberPromptOrigin(agent_id, record.origin, record.origin_id);
    this.lastPromptOrigin.set(agent_id, record);
  }

  /** #239: the prompt admitted after an early release has its own turn now —
   *  its chat takes the slot. */
  private applyPendingOrigin(agent_id: string): void {
    const record = this.pendingOrigin.get(agent_id);
    if (!record) return;
    this.pendingOrigin.delete(agent_id);
    this.applyOrigin(agent_id, record);
  }

  private rememberPromptOrigin(agent_id: string, origin: BusOrigin, origin_id: string): void {
    let known = this.knownPromptOrigins.get(agent_id);
    if (!known) {
      known = new Map();
      this.knownPromptOrigins.set(agent_id, known);
    }
    const surfaces = known.get(origin_id) ?? new Set<BusOrigin>();
    surfaces.add(origin);
    known.delete(origin_id); // re-insert: most recent last
    known.set(origin_id, surfaces);
    if (known.size > KNOWN_PROMPT_ORIGINS_MAX) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
  }

  /**
   * The origin a reply explicitly names (`in_reply_to`), or undefined when it
   * names nothing, names a chat that never prompted this agent (warned once
   * per agent), or names an id two surfaces share and the slot does not
   * disambiguate — in every undefined case the caller routes by the slot.
   */
  private resolveNamedOrigin(
    agent_id: string,
    inReplyTo: string | undefined,
  ): { origin: BusOrigin; origin_id: string } | undefined {
    if (typeof inReplyTo !== "string" || inReplyTo.length === 0) return undefined;
    const surfaces = this.knownPromptOrigins.get(agent_id)?.get(inReplyTo);
    if (surfaces !== undefined && surfaces.size > 0) {
      if (surfaces.size === 1) return { origin: [...surfaces][0], origin_id: inReplyTo };
      // The same id on two surfaces (a Telegram chat and a Discord channel
      // both called "100"): the slot decides if it points at that id, else
      // the name is ambiguous and the slot routes.
      const slot = this.lastPromptOrigin.get(agent_id);
      if (slot && slot.origin_id === inReplyTo && surfaces.has(slot.origin)) {
        return { origin: slot.origin, origin_id: inReplyTo };
      }
      this.warnReplyTarget(
        agent_id,
        `names in_reply_to=${JSON.stringify(inReplyTo)}, an id two surfaces share`,
      );
      return undefined;
    }
    this.warnReplyTarget(
      agent_id,
      `names in_reply_to=${JSON.stringify(inReplyTo)}, a chat that never prompted it`,
    );
    return undefined;
  }

  private warnReplyTarget(agent_id: string, what: string): void {
    if (this.warnedUnknownReplyTarget.has(agent_id)) return;
    this.warnedUnknownReplyTarget.add(agent_id);
    console.warn(
      `[bus] agent=${agent_id} reply ${what} — ignored, routing by the last prompt instead (logged once per agent)`,
    );
  }

  ingestReply(req: IngestReplyRequest, opts?: { synthetic?: boolean; silent?: boolean }): void {
    // Cross-transport dedup (#217 finding 2): a final reply can arrive both
    // as the agent's real `reply` IPC AND as the synthesized recovery from
    // `response.turn_end` (the JSONL tailer). They race on two unordered
    // channels; whichever lands first publishes and sets
    // `currentTurnFinalPublished`. The loser is suppressed here so the same
    // turn never delivers two finals. `synthetic` calls (from
    // `handleTurnEnd`) bypass the check — they only run AFTER confirming no
    // final has published yet, and must be allowed to publish the first.
    // #224: a final that NAMES a chat is deduplicated per chat — two chats
    // answered in one turn are two finals, not a duplicate. Only a final that
    // repeats a chat already answered this turn (or names none, where the
    // slot is the implicit target) is the race loser the check exists for.
    const named = this.resolveNamedOrigin(req.agent_id, req.in_reply_to);
    // The origin this reply is EFFECTIVELY routed to: the named chat, else the
    // slot. Dedup and bookkeeping below use it, so an unnamed final answering
    // the slot's chat and a later final naming that same chat are one answer.
    const effective =
      named ??
      this.lastPromptOrigin.get(req.agent_id) ??
      (req.intent === "final" && !opts?.silent
        ? this.silentClosedOrigin.get(req.agent_id)
        : undefined);
    if (req.intent === "final" && !opts?.synthetic) {
      const answered = this.currentTurnFinalOrigins.get(req.agent_id);
      if (
        effective
          ? answered?.has(effective.origin_id)
          : this.currentTurnFinalPublished.get(req.agent_id) === true
      ) {
        return;
      }
    }
    const topic: BusEventTopic =
      req.intent === "tool_status" ? "response.tool_use" : "response.text";
    // Attach the originating surface so adapters can route the reply
    // back to the same DM / channel rather than fanning out. The lookup
    // is best-effort — if no prompt has been seen yet (e.g. a scheduler-
    // initiated reply), the field stays undefined and the adapter falls
    // back to its configured channel set.
    // #224: a reply that names the chat it answers wins over the last-write
    // slot — when two chats share the agent and interleave, the slot points
    // at whichever wrote last. Only a chat that has prompted this agent is
    // honoured; anything else falls back to the slot and is logged once.
    const origin = effective;
    const event: BusEvent<{
      text: string;
      intent: string;
      origin?: BusOrigin;
      origin_id?: string;
      synthesized?: true;
      silent?: true;
    }> = {
      ts: Date.now(),
      agent_id: req.agent_id,
      session_id: "",
      topic,
      payload: {
        text: req.text,
        intent: req.intent,
        ...(origin ? { origin: origin.origin, origin_id: origin.origin_id } : {}),
        // #240: tag the silent-drop safety-net delivery so surfaces can tell it
        // apart from a curated `reply` and choose to label, truncate, or
        // suppress it. The text was never curated through the `reply` tool — it
        // is the raw concatenated turn output #217 falls back to delivering.
        ...(opts?.synthetic ? { synthesized: true as const } : {}),
        // A silent final closes the turn for every caller (webui / inject /
        // job awaiters, the Telegram placeholder) with nothing to show: the
        // prompt did not call for an answer (see `handleTurnEnd`).
        ...(opts?.silent ? { silent: true as const } : {}),
      },
    };
    this.publish(event);
    // Codex P1 on PR #133: clear the cached origin once the agent has
    // signalled the turn is done (`intent: "final"`). Without this,
    // any unprompted reply that follows — scheduler ticks, background
    // tool_status events, cron-fired jobs without their own sendPrompt
    // — would inherit the previous prompt's origin and misroute to
    // whichever DM/channel last asked the agent something. Progress
    // and tool_status intents keep the origin so mid-stream updates
    // stay scoped to the originating surface.
    //
    // Other clear sites (5-agent review on PR #138, A1 finding):
    //   - `cancel` IPC      — turn won't emit `final`
    //   - `error` IPC       — turn likely won't emit `final`
    //   - socket disconnect — claude subprocess gone, no `final` coming
    // These are the only consumers of `lastPromptOrigin`:
    //   - this `ingestReply` (origin on response.text events)
    //   - `request_human` IPC handler (origin on system.request_human)
    //   - `permission_request` IPC handler (origin on channel.permission_request)
    if (req.intent === "final") {
      // #224: the slot is the chat still waiting for an answer. A final that
      // answered a DIFFERENT chat (named it) leaves the slot's chat unanswered,
      // so the slot stays; a final that named nothing, or named the slot's own
      // chat, clears it as before.
      const slot = this.lastPromptOrigin.get(req.agent_id);
      if (!named || !slot || slot.origin_id === named.origin_id) {
        this.lastPromptOrigin.delete(req.agent_id);
        this.originAmbiguous.delete(req.agent_id);
      }
      if (opts?.silent && slot) this.silentClosedOrigin.set(req.agent_id, slot);
      else if (!opts?.silent) this.silentClosedOrigin.delete(req.agent_id);
      // A silent final answers nothing: it leaves the dedup below open, so a
      // real `reply` that loses the race to the turn end is still delivered
      // rather than dropped as a duplicate.
      if (effective && !opts?.silent) {
        let answered = this.currentTurnFinalOrigins.get(req.agent_id);
        if (!answered) {
          answered = new Set();
          this.currentTurnFinalOrigins.set(req.agent_id, answered);
        }
        answered.add(effective.origin_id);
      }
      // Silent-drop safety net (#215): the agent called `reply` with a final
      // intent → mark this turn as delivered, so the `response.turn_end`
      // handler skips the synthetic-delivery fallback for this turn.
      this.currentTurnReplied.set(req.agent_id, true);
      // #217 finding 2: record that a final was published for this turn so
      // the cross-transport race loser (real reply vs synthesized) is
      // suppressed above.
      if (!opts?.silent) {
        this.currentTurnFinalPublished.set(req.agent_id, true);
        const seen = effective
          ? this.lastPromptSeen.get(seenKey(req.agent_id, effective.origin_id))
          : undefined;
        if (seen) {
          seen.answered = true;
          seen.asked = endsWithQuestion(req.text);
        }
      }
      // Reply-tool enforcement (#215/#240): a final was delivered (incl. one a
      // nudge successfully produced) — clear the nudge state for the turn.
      this.replyNudged.delete(req.agent_id);
      this.pendingNudgeText.delete(req.agent_id);
    }
  }

  /**
   * #239: the silent-drop net for a RELEASED turn's terminator, run while the
   * newcomer's own line is still awaited. The shared per-turn flags were
   * reset for the newcomer at its admission, so they say nothing about the
   * released turn — and a nudge would be typed into the newcomer's REPL. The
   * one signal that survives the admission is the routing slot: the released
   * turn's own final cleared it (answered — nothing to do), else it still
   * names that turn's chat and the text goes straight there. The flags are
   * then handed back to the newcomer clean.
   */
  private handleStaleTurnEnd(agentId: string, text: string, injectPrompt = false): void {
    if (text.trim().length === 0) return;
    const origin = this.lastPromptOrigin.get(agentId);
    if (!origin || !CHANNEL_DRIVEN_ORIGINS.has(origin.origin)) return;
    if (injectPrompt && origin.origin_id !== "inject") {
      this.keepInjectTurnInternal(agentId, origin.origin, text.length);
      return;
    }
    console.warn(
      `[bus] silent-drop recovered for agent=${agentId} (origin=${origin.origin}, ` +
        `chars=${text.length}): a released turn ended with text but no reply — ` +
        "synthesizing ingestReply to deliver (no nudge: its REPL now belongs to the next prompt). See #239.",
    );
    this.ingestReply({ agent_id: agentId, text, intent: "final" }, { synthetic: true });
    this.openTurn(agentId);
  }

  /**
   * A new turn starts undelivered (#392): clear the two per-turn delivery
   * flags. Called from `sendPrompt` (ahead of delivery) and from the tailer
   * `prompt` event — the turn start the bus observes for EVERY turn, whoever
   * opened it. Before #392 only `sendPrompt` reset them, so a turn opened by
   * any other door — a `<task-notification>` user line, a flush-verify
   * re-delivery, a prompt that waited behind (or was absorbed into) an active
   * turn — inherited the previous turn's `currentTurnFinalPublished = true`,
   * and its `final` was dropped by the #217 dedup as if it were the race
   * loser (the tool had already answered `delivered`).
   *
   * Resetting again for a bus-opened turn is harmless: a final also clears
   * `lastPromptOrigin`, without which the turn-end synthesizer cannot deliver,
   * so wiping the flags after a final cannot make it deliver twice.
   *
   * The nudge state (`replyNudged` / `pendingNudgeText`) is deliberately NOT
   * touched here: the nudge's own injected reminder is a user line, hence a
   * tailer `prompt`, and the stash must survive until the nudged turn ends.
   * Its owners stay `sendPrompt`, a final, the synthesizer, cancel, error and
   * disconnect. No origin bookkeeping either: a turn the bus did not open has
   * no inbound origin, and `ingestReply` publishes origin-less events that
   * adapters route by their own fallback (Telegram: the agent's last chat).
   */
  private openTurn(agentId: string): void {
    this.currentTurnReplied.set(agentId, false);
    this.currentTurnFinalPublished.set(agentId, false);
    this.currentTurnFinalOrigins.delete(agentId);
    // A new turn: a late reply to a silently closed one no longer routes there.
    this.silentClosedOrigin.delete(agentId);
  }

  /** Inject turns whose text the net kept off a user's chat, per agent. */
  private readonly injectTurnsKeptInternal = new Map<string, number>();

  /** Number of inject turns the net kept internal for `agentId`. */
  injectTurnsKeptInternalCount(agentId: string): number {
    return this.injectTurnsKeptInternal.get(agentId) ?? 0;
  }

  private keepInjectTurnInternal(agentId: string, slotOrigin: BusOrigin, chars: number): void {
    const count = (this.injectTurnsKeptInternal.get(agentId) ?? 0) + 1;
    this.injectTurnsKeptInternal.set(agentId, count);
    console.warn(
      `[bus] inject turn kept internal for agent=${agentId} (slot origin=${slotOrigin}, ` +
        `chars=${chars}, count=${count}): the turn answered a daemon inject and ended ` +
        "without reply — not nudged, not forwarded. See #215.",
    );
  }

  /**
   * Silent-drop safety net handler (issue #215). Wired by
   * `ingestSessionEvent`/JSONL tailer when it observes a `response.turn_end`
   * (any terminal `stop_reason`, #401). If the agent ended the turn with
   * non-empty text but never called the `reply` tool for this prompt,
   * synthesize an `ingestReply` so the user actually receives the
   * response. Without this, the text sits in the session `.jsonl` and
   * the user-facing surface gets nothing — confirmed live 2x in 12h
   * on a real bus-mode deployment after issue #215 was filed.
   */
  private handleTurnEnd(agentId: string, text: string, injectPrompt = false): void {
    if (this.currentTurnReplied.get(agentId) === true) return;
    // #217 finding 2: if a final already published for this turn (e.g. the
    // real reply IPC landed first), don't synthesize a duplicate.
    if (this.currentTurnFinalPublished.get(agentId) === true) return;
    // The transcript says this turn answered a daemon inject, but the bus slot
    // names another chat: a re-delivered copy of the inject ran while a user
    // prompt was waiting behind it. Its text is internal — nudging or
    // synthesizing here would ship it to that user's chat. The user's own turn
    // is still to come and keeps the net. A slot that IS the inject falls
    // through: its synthesized final settles /api/inject, which drops it.
    const slotOrigin = this.lastPromptOrigin.get(agentId);
    if (
      injectPrompt &&
      slotOrigin &&
      CHANNEL_DRIVEN_ORIGINS.has(slotOrigin.origin) &&
      slotOrigin.origin_id !== "inject"
    ) {
      if (text.trim().length > 0) {
        this.keepInjectTurnInternal(agentId, slotOrigin.origin, text.length);
      }
      return;
    }
    // Effective text to deliver: this turn's own text, or — on a turn we already
    // nudged that produced none — the original text stashed when we nudged, so a
    // nudged-but-still-silent turn never loses the first turn's output (#215).
    const nudged = this.replyNudged.get(agentId) === true;
    // A bare acknowledgement ("ok", 👍) or a repeat of an answered message:
    // silence is the answer, so no nudge into a filler reply and no raw text.
    // The turn is still closed with a silent final — webui / job awaiters get
    // their end and the Telegram placeholder is cleared — even when the turn
    // produced no text at all.
    const slot = this.lastPromptOrigin.get(agentId);
    if (slot?.silenceOk && !nudged && CHANNEL_DRIVEN_ORIGINS.has(slot.origin)) {
      console.warn(
        `[bus] turn ended without reply for agent=${agentId} (origin=${slot.origin}) ` +
          "on a bare acknowledgement or an answered repeat — closing it with a silent final " +
          "(no nudge, nothing shown).",
      );
      this.currentTurnReplied.set(agentId, true);
      this.ingestReply(
        { agent_id: agentId, text: "", intent: "final" },
        { synthetic: true, silent: true },
      );
      return;
    }
    const ownText = text && text.trim().length > 0 ? text : "";
    const deliverText = ownText || (nudged ? (this.pendingNudgeText.get(agentId) ?? "") : "");
    if (deliverText.trim().length === 0) return;
    // #239 (was the residual race of #217 finding 3): `lastPromptOrigin` and
    // the per-turn flags are single-slot, keyed by agent_id only. The JSONL
    // tailer's `response.turn_end` is delivered asynchronously, so a
    // cross-channel interleave — P1(telegram) ends → reply → P2(webui)
    // arrives (resets the flag, rewrites origin=webui) → P1's lagged turn_end
    // lands here — used to route P1's text to P2's chat. P2 is now held in
    // `promptQueue` until this very terminator has been processed, so the
    // origin read here is P1's own.
    const origin = this.lastPromptOrigin.get(agentId);
    if (!origin) {
      // No origin to route to (cron tick / unprompted ambient turn).
      // Log so operators can correlate; don't fabricate delivery.
      console.warn(
        `[bus] silent-drop detected for agent=${agentId} (turn ended with text but no reply); ` +
          `no lastPromptOrigin to route to — dropping silently as before.`,
      );
      return;
    }
    // Only channel-driven origins (telegram/webui/discord/slack) have a
    // user waiting on a reply. Scheduled/ambient origins (cron, heartbeat,
    // cli, rest) legitimately end turns with text WITHOUT calling `reply`
    // — that's not a silent drop, and there's no adapter to deliver the
    // synthesized reply to anyway. Synthesizing for them would spam a
    // bogus "recovered" warning and emit an undeliverable response.text on
    // every scheduled tick. Skip them.
    if (!CHANNEL_DRIVEN_ORIGINS.has(origin.origin)) {
      return;
    }
    // ROOT-CAUSE FIRST (#215): the agent skipped the `reply` tool. Rather than
    // immediately shipping the raw, uncurated turn text, give it ONE chance to
    // deliver properly — inject a system reminder telling it to call `reply`
    // now. A curated reply is what the user actually wants; the synthesized
    // dump is a last resort. Bounded to one nudge per turn via `replyNudged`.
    // A daemon inject (`/api/inject`, origin_id "inject") has no user waiting:
    // ending it without `reply` is a legitimate silence, so don't nudge the
    // agent into speaking. The synthesized final below still settles the
    // awaiting inject route, which drops it instead of forwarding it.
    const isInject = origin.origin_id === "inject";
    if (this.replyNudgeEnabled && !nudged && !isInject) {
      console.warn(
        `[bus] silent-drop detected for agent=${agentId} (origin=${origin.origin}, ` +
          `chars=${deliverText.length}): turn ended with text but no reply tool call — ` +
          `nudging the agent to call reply. See issue #215.`,
      );
      this.replyNudged.set(agentId, true);
      this.pendingNudgeText.set(agentId, deliverText);
      if (this.nudgeForReply(agentId, origin)) return;
      // #261/#222: neither IPC nor PTY received the nudge (deaf agent) — don't
      // strand the user waiting for a turn that will never start. Fall through to
      // synthesize immediately (zero-delay, exactly as the pre-#215 path did).
      const why = this.modelInputPending(agentId) ? "recording-pending" : "no IPC/PTY transport";
      console.warn(
        `[bus] reply nudge undeliverable for agent=${agentId} (${why}) — ` +
          `synthesizing immediately instead of waiting. See #261/#222.`,
      );
    }
    // FALLBACK (#217/#240): the nudge is disabled or already spent and the turn
    // STILL ended without a reply — synthesize a labeled delivery so the user
    // gets something rather than nothing.
    console.warn(
      `[bus] silent-drop recovered for agent=${agentId} (origin=${origin.origin}, ` +
        `chars=${deliverText.length}): no reply tool call${nudged ? " even after a nudge" : ""} — ` +
        `synthesizing ingestReply to deliver. See issue #215/#240.`,
    );
    // Mark BEFORE the recursive ingestReply so the synthetic call itself
    // doesn't trigger another safety-net pass (it would no-op anyway
    // because we set the flag here, but the explicit ordering makes the
    // single-fire intent clearer).
    this.currentTurnReplied.set(agentId, true);
    this.replyNudged.delete(agentId);
    this.pendingNudgeText.delete(agentId);
    // `synthetic: true` lets this first delivery through the cross-transport
    // dedup (#217 finding 2); it sets `currentTurnFinalPublished`, so a
    // later real `reply` IPC for the same turn is suppressed.
    this.ingestReply(
      {
        agent_id: agentId,
        text: deliverText,
        intent: "final",
      },
      { synthetic: true },
    );
  }

  /**
   * Reply-tool enforcement (#215/#240). Inject a one-shot system reminder
   * telling the agent to call `reply` now, after it ended a channel-driven turn
   * with text but no reply. Delivered over ONE of the prompt seams — IPC when an
   * MCP connection takes it, PTY-stdin otherwise — but best-effort: a
   * failed IPC send is swallowed here (it must NOT trip the #222 respawn
   * reconciler, which is for real prompts), and the synthesized safety net in
   * `handleTurnEnd` still backs the nudge if it does not yield a reply.
   *
   * The nudged turn is a fresh turn that should end in `reply`, so reset the
   * per-turn delivered/published flags: a real reply then lands cleanly, and if
   * it doesn't, the next `response.turn_end` falls through to the fallback.
   */
  private nudgeForReply(
    agentId: string,
    origin: { origin: BusOrigin; origin_id: string },
  ): boolean {
    const text =
      "You ended your turn without calling the `reply` tool, so the user received " +
      "nothing — your transcript text does not reach them. Call `reply` now with " +
      "intent:'final' to send your answer for this turn.";
    // #595 r6: the reminder is a prompt too (the MCP server turns the IPC frame into a channel
    // notification that starts a turn). It cannot wait: it is about a turn that has already ended,
    // and the claude it would reach is a replacement that has no part in it. Drop it (the caller logs
    // the reason code) and it synthesizes the delivery as for any agent no transport reaches.
    if (this.modelInputPending(agentId)) return false;
    this.currentTurnReplied.set(agentId, false);
    this.currentTurnFinalPublished.set(agentId, false);
    this.currentTurnFinalOrigins.delete(agentId);
    // A fallback still armed from an earlier nudge must not outlive it: its
    // callback would read this nudge's `replyNudged` and type a stale copy.
    this.clearNudgePtyFallback(agentId);
    // IPC path (best-effort, no reconciler): reach an MCP-connected agent.
    // Wrapped so a synchronous send() throw can't skip the PTY path below or
    // propagate to the turn-end handler — the send is best-effort, mirroring
    // sendPrompt's IPC guard.
    let ipcDelivered = false;
    try {
      ipcDelivered =
        this.emitModelInput({
          type: "prompt",
          agent_id: agentId,
          origin: origin.origin,
          origin_id: origin.origin_id,
          user_id: "system",
          text,
          metadata: { nudge: "reply-tool" },
        }).status === "sent";
    } catch {
      /* best-effort: the PTY path + synthesize fallback still cover delivery */
    }
    // PTY-stdin path for headless agents. A <system-reminder> wrap signals this is
    // bus-injected guidance, not a user message. deliverOrQueuePrompt no-ops when no
    // streamPromptHandler is wired, so that is the PTY-availability signal.
    const ptyAvailable = this.streamPromptHandler !== null;
    const typeIntoPty = () =>
      this.deliverOrQueuePrompt(
        agentId,
        `<system-reminder>${escapeXmlText(text)}</system-reminder>`,
      );
    // One transport per nudge: an MCP-connected agent renders the IPC copy as a
    // channel message, so also typing it into the PTY handed the agent the same
    // reminder twice — the second one landing after it had already replied.
    // A send() that returned true only proves the socket write, not that the
    // CLI opened a turn from the notification (older headless builds did not),
    // so the PTY copy stays armed as a fallback: typed only if, within
    // `flushVerifyMs`, no turn starts, no queued input is absorbed and the
    // nudge is still outstanding (no reply, deadline, cancel or disconnect).
    if (ipcDelivered) {
      if (ptyAvailable) {
        const key = promptLineKey(text);
        const arm = () => {
          const timer = setTimeout(() => {
            if (this.nudgePtyFallback.get(agentId)?.timer !== timer) return;
            if (this.replyNudged.get(agentId) !== true) {
              this.nudgePtyFallback.delete(agentId);
              return;
            }
            // A turn is streaming: the IPC copy may be queued behind it, and a
            // PTY copy typed now could be absorbed into it — the agent would get
            // both. Wait for that turn to end, as the flush verifier does (#250).
            if (this.agentTurnActive.has(agentId)) {
              arm();
              return;
            }
            this.nudgePtyFallback.delete(agentId);
            // A session (re)initialising would only queue the copy for after
            // `replay_done`, unchecked against a reply landing meanwhile, and its
            // context no longer holds the turn the reminder is about. The turn
            // deadline still covers the outstanding nudge.
            if (this.agentInitializing.has(agentId)) return;
            typeIntoPty();
          }, this.flushVerifyMs);
          timer.unref?.();
          this.nudgePtyFallback.set(agentId, { timer, key });
        };
        arm();
      }
      return true;
    }
    typeIntoPty();
    // #261/#222: report whether ANY transport actually received the nudge, so a
    // deaf agent (neither IPC nor PTY) does not leave the caller waiting for a
    // turn that never starts.
    return ptyAvailable;
  }

  /** Disarm the IPC-only nudge's PTY fallback. With `seenText` (a turn-start or
   *  absorbed line), only when that line carries the nudge — an unrelated
   *  prompt proves nothing about whether the notification was taken. */
  private clearNudgePtyFallback(agentId: string, seenText?: string): void {
    const armed = this.nudgePtyFallback.get(agentId);
    if (armed === undefined) return;
    if (seenText !== undefined && !promptLineKey(seenText).includes(armed.key)) return;
    clearTimeout(armed.timer);
    this.nudgePtyFallback.delete(agentId);
  }

  ingestSessionEvent(e: BusEvent): void {
    // Delivery gate: hold PTY-stdin prompts while the agent's session is
    // (re)initialising so a keystroke isn't swallowed by a not-yet-ready TUI,
    // and release them once it's live.
    if (e.agent_id) {
      if (e.topic === "session.init") this.markAgentInitializing(e.agent_id, e.session_id);
      else if (e.topic === "bus.events.replay_done") {
        const gen = (e.payload as { generation?: unknown } | undefined)?.generation;
        this.markAgentReady(
          e.agent_id,
          e.session_id,
          false,
          typeof gen === "number" ? gen : undefined,
        );
      }
      // #402: the compaction the PTY layer gave up on has ended — the CLI wrote
      // its `compact_boundary`. Whatever it buffered is submitted by now (or
      // never will be), so the held prompt can be verified.
      else if (e.topic === "session.compact") {
        // Only holds taken under the tailer generation that compacted: a
        // boundary the tailer being replaced publishes late belongs to the old
        // transcript and says nothing about a compaction in the replacement.
        const gen = (e.payload as { generation?: unknown } | undefined)?.generation;
        if (
          typeof gen !== "number" &&
          maxGeneration(
            this.agentTailerGeneration.get(e.agent_id),
            this.agentSpawnedGeneration.get(e.agent_id),
          ) !== undefined
        ) {
          this.warnUnnumberedMarker(e.agent_id, "session.compact");
        }
        this.releaseCompactionHold(e.agent_id, {
          ...(typeof gen === "number" ? { generation: gen } : {}),
          boundaryAt: e.ts,
        });
      }
      // Turn-start proof for a pending backstop-flush verification. ONLY the
      // tailer `prompt` topic qualifies — it carries the ingested user line
      // (= the wrapped string we delivered), so we can attribute the turn to the
      // exact flushed prompt and cancel only its verify. Fires within ms of
      // ingest (before any thinking), so a slow-but-healthy turn never trips a
      // spurious re-delivery. In-turn topics (tool_result/usage/turn_end) carry
      // no prompt identity and are deliberately NOT used: an unrelated prompt's
      // activity must not silence a still-swallowed prompt's re-delivery.
      else if (e.topic === "prompt") {
        const text = (e.payload as { text?: string } | undefined)?.text;
        // Cancel the matching prompt's verify FIRST (attribution), then mark the
        // agent as having an active turn so a LATER prompt delivered during it
        // arms — and defers — its own verify.
        if (typeof text === "string") {
          this.noteFlushTurnStart(e.agent_id, text);
          // A turn started on the IPC-only reply nudge — proof the CLI took the
          // notification; its PTY fallback is no longer needed.
          this.clearNudgePtyFallback(e.agent_id, text);
        }
        // #239: the prompt admitted after an early release has now started its
        // own turn — the next terminator is legitimately its own.
        const awaited = this.awaitOwnPromptLine.get(e.agent_id);
        if (
          awaited !== undefined &&
          (awaited === null || (typeof text === "string" && promptLineKey(text) === awaited))
        ) {
          this.awaitOwnPromptLine.delete(e.agent_id);
          this.applyPendingOrigin(e.agent_id);
        }
        this.agentTurnActive.add(e.agent_id);
        // #392: a turn is starting, whoever opened it (a bus prompt, a task
        // notification, a re-delivery, a prompt that waited behind an active
        // turn). Its delivery flags start clean, so its `final` is not dropped
        // as a #217 race loser of the previous turn. The nudge state is left
        // alone — see `openTurn`.
        this.openTurn(e.agent_id);
      }
      // #389: a prompt the CLI absorbed into the running turn never gets a
      // `user` line of its own, so the `prompt` proof above never comes and the
      // verify armed at delivery re-delivers it once the turn ends — the agent
      // then handles it twice. The transcript records the absorption in the
      // queue's own `remove` (reason `absorbed_mid_turn`; carries the text on
      // 2.1.270, not on 2.1.269) and in the `queued_command` attachment the
      // CLI renders to the model mid-turn (always carries it). Either is proof
      // the prompt reached the model; either cancels only ITS verify (same
      // exact attribution as `prompt`) and releases the turn `sendPrompt`
      // counted for it. Not a turn start: `openTurn` is not called here — the
      // running turn keeps its reply flags (`sendPrompt` already reset them on
      // arrival; the absorption must not reset them a second time), and a
      // `dequeue` still proves nothing (its `user` line follows within ms —
      // #363 stands).
      else if (e.topic === "session.queue") {
        const q = e.payload as
          | { operation?: unknown; reason?: unknown; content?: unknown }
          | undefined;
        if (
          q?.operation === "remove" &&
          q.reason === "absorbed_mid_turn" &&
          typeof q.content === "string"
        ) {
          this.noteAbsorbedPrompt(e.agent_id, q.content);
        }
      } else if (e.topic === "attachment.queued_command") {
        const prompt = (e.payload as { prompt?: unknown } | undefined)?.prompt;
        if (typeof prompt === "string") this.noteAbsorbedPrompt(e.agent_id, prompt);
      }
    }
    // Silent-drop safety net (#215): the JSONL tailer publishes a
    // `response.turn_end` event when claude stops for any terminal reason
    // (`end_turn`, `max_tokens`, `stop_sequence`, … — #401). Hook into it
    // before the generic publish so we can synthesize a delivery for turns
    // that produced text but never called reply.
    // #405: the CLI repeats the terminal stop_reason on every content-block
    // line of a message, so one turn can end in two `turn_end` events (thinking
    // line, then text line). Both feed the net — the text line is the one that
    // matters there — but the operation slot is released once per MESSAGE: a
    // second release for the same message id would free the slot of a prompt
    // counted in between and stamp its events with no `promise_id`.
    let releaseSlot = false;
    let staleTerminator = false;
    if (e.topic === "response.turn_end" && e.agent_id) {
      const payload = e.payload as { text?: string; message_id?: string; inject_prompt?: boolean };
      // #239: after an early release the admitted prompt's own line has not
      // been tailed yet — this terminator is the RELEASED turn's, arriving
      // late. The net still runs (that turn's text still needs its chat), the
      // REPL is free, but nothing the bus counted for the newcomer ends here.
      staleTerminator = this.awaitOwnPromptLine.has(e.agent_id);
      const id = payload?.message_id;
      // #405 beyond the settle: a further line of a message whose turn was
      // already released AND followed by an admission — the state the net
      // would read is the newcomer's. Routing that text would land it in the
      // newcomer's chat (the #239 misroute); it is dropped, loudly.
      // On the stale path the slot is still the released turn's own chat
      // (`pendingOrigin` unapplied), so its text routes correctly there.
      if (
        id &&
        !staleTerminator &&
        this.lastTurnEndMessageId.get(e.agent_id) === id &&
        !this.admitSettle.has(e.agent_id) &&
        this.currentOperation.has(e.agent_id)
      ) {
        console.warn(
          `[bus] late boundary line for agent=${e.agent_id}: its turn was released and a ` +
            "new prompt admitted since — not synthesizing (it would reach the next chat). See #239/#405.",
        );
        // Nothing else of this path is that line's to run: the streaming flag,
        // the parking, the release and the admission all belong to the
        // newcomer's turn now (CodeRabbit on the PR). It is published for the
        // record, uncorrelated — stamping it with the newcomer's operation id
        // would assert the very attribution it does not have.
        this.publishUncorrelated(e);
        return;
      } else if (staleTerminator) {
        this.handleStaleTurnEnd(e.agent_id, payload?.text ?? "", payload?.inject_prompt === true);
      } else {
        this.handleTurnEnd(e.agent_id, payload?.text ?? "", payload?.inject_prompt === true);
      }
      // The turn ended → the REPL is free, so a prompt queued behind it can now
      // start; stop deferring its flush-verify (see agentTurnActive).
      this.agentTurnActive.delete(e.agent_id);
      // #239: an IPC close (or a re-delivery) parked the gate on this turn;
      // the tailer just proved it over — unless this is the RELEASED turn's
      // late terminator while a re-delivered prompt is still outstanding: that
      // prompt's turn is the one the park is for (CodeRabbit on the PR).
      if (!staleTerminator || !this.redeliveredSinceClose.has(e.agent_id)) {
        this.gateParked.delete(e.agent_id);
        this.redeliveredSinceClose.delete(e.agent_id);
      }
      // This terminator proves the released turn is over: a prompt admitted
      // later cannot land in it, so it must not wait for its own line nor
      // defer its origin (CodeRabbit on the PR).
      if (!staleTerminator) {
        this.earlyReleased.delete(e.agent_id);
        this.deadlineReleased.delete(e.agent_id); // nor be flagged as overlapping it
      }
      if (id && this.lastTurnEndMessageId.get(e.agent_id) === id) {
        releaseSlot = false; // another line of the message that already released
      } else {
        releaseSlot = !staleTerminator;
        if (id) this.lastTurnEndMessageId.set(e.agent_id, id);
      }
    }
    this.publish(e);
    // Release the operation slot only AFTER `response.turn_end` has been
    // published: that event is the one a client most needs correlated, and
    // clearing alongside `agentTurnActive` above would strip it.
    if (releaseSlot && e.agent_id) this.releaseTurn(e.agent_id);
    // #239: the REPL is free and (unless a nudge just went out) so is the
    // slot — the next queued prompt goes once the terminal message's other
    // boundary lines have landed (`scheduleAdmit`, #405). Also after a
    // turn_end the bus did not count (a nudged turn's own end): its
    // `releaseTurn` above found nothing to free, but the nudge state it
    // cleared was what held admission. A stale terminator admits nothing: the
    // newcomer's turn is about to start in that same REPL.
    if (e.topic === "response.turn_end" && e.agent_id) {
      if (staleTerminator) this.touchTurn(e.agent_id);
      else this.scheduleAdmit(e.agent_id);
    }
  }

  /**
   * Consult the policy engine for a forwarded tool permission request and
   * report whether an EXPLICIT deny rule matches (#258 item 3). Deny-wins: an
   * operator-authored deny (skill overlay, scoped, or global) short-circuits to
   * a deny response without bothering the operator. The engine's no-match
   * default-deny (no matchedRuleId) is deliberately NOT treated as a deny here,
   * so tools stay available when no rules are configured. Fail-OPEN: any
   * evaluation error returns false so the request falls through to the card.
   *
   * `origin` carries the inbound channel/user/skill (slice 2) so skill overlays
   * and per-user rules can scope the decision. The caller passes it ONLY when
   * attribution is unambiguous (see the gate's `gateOrigin`): under a same-agent
   * interleave the cached identity may belong to a different prompt, so the
   * caller passes `undefined` and only tool-only/global rules apply (#284 MEDIUM).
   */
  private permissionPolicyDenies(
    agentId: string,
    request: PermissionRequest,
    origin?: { origin: BusOrigin; origin_id: string; userId?: string; skillName?: string },
  ): boolean {
    try {
      const ctx: ToolRequestContext = {
        eventId: randomUUID(),
        source: origin?.origin ?? "bus",
        channelId: origin?.origin_id,
        userId: origin?.userId,
        skillName: origin?.skillName,
        toolName: request.tool_name,
        timestamp: new Date().toISOString(),
      };
      const decision = this.evaluatePolicy(ctx);
      return decision.action === "deny" && !!decision.matchedRuleId;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)), {
        ctx: "permission-policy-eval",
        agentId,
      });
      return false;
    }
  }

  ingestPermissionDecision(req: IngestPermissionDecisionRequest): void {
    // Two side effects: emit an audit event AND forward the decision to the
    // MCP server so it can hand it back to claude.
    const event: BusEvent<PermissionResponse> = {
      ts: Date.now(),
      agent_id: req.agent_id,
      session_id: "",
      topic: "channel.permission_response",
      payload: { request_id: req.request_id, behavior: req.behavior },
    };
    this.publish(event);
    this.emitControl(req.agent_id, {
      type: "permission_response",
      agent_id: req.agent_id,
      response: { request_id: req.request_id, behavior: req.behavior },
    });
  }

  /**
   * Adapter-facing API for delivering an answer to a previously-issued
   * `ask` or `request_human` tool call. The MCP server allocates the
   * `ask_id` and emits the question outward as a `system.ask_request` or
   * `system.request_human` BusEvent (the latter carries `ask_id` per the
   * Codex P1 fix). Adapters collect the human's reply and call this
   * method to route it back; Bus core sends `IpcAskAnswer` over the IPC
   * channel and the MCP server's pendingAnswers map resolves the
   * outstanding tool-call promise.
   *
   * Sprint 1 deferred this API (no adapters needed it yet). Sprint 2
   * adds it ahead of Sprint 3 surface work so the Web UI adapter
   * (and Discord/Telegram in Sprint 3) can wire it up immediately.
   */
  ingestAskAnswer(req: { agent_id: string; ask_id: string; answer: string }): void {
    if (!this.ipcServer) return;
    const frame: IpcAskAnswer = {
      type: "ask_answer",
      agent_id: req.agent_id,
      ask_id: req.ask_id,
      answer: req.answer,
    };
    const first = this.emitModelInput(frame);
    if (first.status !== "recording-pending") return;
    // #595 r7: an answer is model input (the MCP server turns a non-blocking one into a channel
    // notification), so it waits, at most the delivery backstop, for the claude to be recorded. It
    // keeps its `ask_id` through the wait and into any failure report; nothing is sent on failure.
    void this.awaitRecorded(req.agent_id, first.pending, "ingestAskAnswer:recording-pending").then(
      (outcome) => {
        const again = outcome === "recorded" ? this.emitModelInput(frame) : null;
        if (again && again.status !== "recording-pending") return;
        this.onError(
          new AgentNotRecordedError(
            req.agent_id,
            outcome === "recorded" ? "recording-pending" : outcome,
          ),
          { ctx: "ingestAskAnswer:recording-pending", agent_id: req.agent_id, ask_id: req.ask_id },
        );
      },
    );
  }

  state(): BusState {
    let totalOverflows = 0;
    for (const s of this.subscribers.values()) totalOverflows += s.overflowCount;
    return {
      subscriberCount: this.subscribers.size,
      connectedAgents: Array.from(this.connectedAgents),
      totalOverflows,
    };
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  /**
   * Internal publish — fan out to matching subscribers and write to audit
   * log. Errors in either path are isolated; one bad subscriber must not
   * block other dispatches or fail the audit write.
   */
  /**
   * Attach the agent's in-flight operation id to an event that doesn't have
   * one. Returns the event unchanged when there is nothing to attach.
   */
  private stampOperation(event: BusEvent): BusEvent {
    if (!event.agent_id) return event;
    const op = this.currentOperation.get(event.agent_id);
    if (op === undefined) return event;
    // Two independent attachments. Returning early on an id that is already
    // present skipped the flag along with it, so the `prompt` event of an
    // ambiguous operation — which mints its own id at the top level — was the
    // one event that never carried the taint. It is also the first event a
    // client sees for that operation, so the omission was maximally visible.
    const needsId = event.promise_id === undefined;
    const needsFlag =
      event.correlation_ambiguous === undefined && this.correlationAmbiguous.has(event.agent_id);
    if (!needsId && !needsFlag) return event;
    // Copy rather than assign: the caller owns the object it passed.
    const out: BusEvent = { ...event };
    if (needsId) out.promise_id = op;
    if (needsFlag) out.correlation_ambiguous = true;
    return out;
  }

  private publish(incoming: BusEvent): void {
    // 0. Stamp the in-flight operation id. Every event that reaches a
    //    subscriber passes through here — those minted in this class, and
    //    those the JSONL tailer hands over via `ingestSessionEvent` — so this
    //    is the one place the identifier has to be attached.
    //
    //    Copy rather than assign: the caller owns the object it passed, and a
    //    field appearing on it after the call would be a surprise. An event
    //    that already carries an id, or belongs to no operation, is passed
    //    through untouched — no copy, no allocation.
    const event = this.stampOperation(incoming);
    // #239 / #372: any event for an agent is a sign of life for its admitted
    // turn — the tailer's transcript lines, a reply, an ask — so the idle
    // deadline starts over. A turn that publishes nothing for `turnDeadlineMs`
    // is the only one it ever releases.
    if (event.agent_id) this.touchTurn(event.agent_id);
    this.dispatch(event);
  }

  /** #239: a line of a message whose turn was released before the next
   *  prompt was admitted is nobody's now — published for the record, flagged,
   *  and NOT stamped with the operation that happens to own the slot. */
  private publishUncorrelated(event: BusEvent): void {
    this.dispatch({ ...event, correlation_ambiguous: true });
  }

  private dispatch(event: BusEvent): void {
    // 1. Audit log. Fire-and-forget on the promise — durability is the
    //    event-log's job. We swallow errors into onError so a transient
    //    disk failure doesn't take the bus down.
    void this.writeAudit(event);

    // 2. Fan-out to subscribers.
    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      if (!matchesFilter(event, sub.filter)) continue;
      enqueueForSubscriber(sub, event);
      drainSubscriber(sub, (err) => this.onError(err, { ctx: "subscriber-handler", sub: sub.id }));
    }
  }

  private async writeAudit(event: BusEvent): Promise<void> {
    try {
      await this.eventLogAppend({
        type: `bus:${event.topic}`,
        source: "bus",
        channelId: event.agent_id,
        threadId: event.session_id || event.agent_id,
        payload: event,
        dedupeKey: `bus:${event.agent_id}:${event.ts}:${event.topic}:${randomUUID()}`,
      });
    } catch (err) {
      this.onError(err, { ctx: "audit-write", topic: event.topic });
    }
  }

  /**
   * Handle an inbound agent-job control request (#296 PR 3). `agentId` is the
   * DISPATCHER — the agent whose socket carried the request; we stamp it as the
   * job's dispatcher rather than trusting any client-supplied value, so results
   * route back to the caller and one agent can't dispatch as another. Always
   * sends exactly one `job_result` (a missing handler / bad op / thrown error
   * becomes `ok:false` — never a silent drop that would hang the caller).
   */
  private handleJobRequest(agentId: string, msg: IpcJobRequest): void {
    // Durable scheduled-task ops are independent of the AgentJobRunner — they
    // only write/read file-backed cron jobs in the daemon's cwd, so they must
    // NOT be gated on `this.jobHandler` (which guards the headless dispatch
    // runner). Route them before that gate.
    if (msg.op === "schedule" || msg.op === "list_scheduled" || msg.op === "unschedule") {
      void this.handleScheduleRequest(agentId, msg);
      return;
    }
    const handler = this.jobHandler;
    if (!handler) {
      this.sendJobResult(agentId, msg.req_id, {
        ok: false,
        error: "agent jobs are not enabled on this daemon",
      });
      return;
    }
    const payload = (msg.payload ?? {}) as {
      agent?: unknown;
      prompt?: unknown;
      model?: unknown;
      timeoutMs?: unknown;
      job_id?: unknown;
    };
    try {
      switch (msg.op) {
        case "dispatch": {
          const result = handler.dispatch({
            agent: typeof payload.agent === "string" ? payload.agent : "",
            prompt: typeof payload.prompt === "string" ? payload.prompt : "",
            dispatcher: agentId,
            ...(typeof payload.model === "string" ? { model: payload.model } : {}),
            ...(typeof payload.timeoutMs === "number" ? { timeoutMs: payload.timeoutMs } : {}),
          });
          // Present the id as snake_case `job_id` to match the tool contract and
          // the follow-up tools (Codex review); pass `{ error }` through as-is.
          const wire = "jobId" in result ? { job_id: result.jobId, status: result.status } : result;
          this.sendJobResult(agentId, msg.req_id, { ok: true, result: wire });
          return;
        }
        case "status": {
          const result = handler.status(typeof payload.job_id === "string" ? payload.job_id : "");
          this.sendJobResult(agentId, msg.req_id, {
            ok: true,
            result: result ? toWireJobView(result) : null,
          });
          return;
        }
        case "list": {
          this.sendJobResult(agentId, msg.req_id, {
            ok: true,
            result: handler.list().map(toWireJobView),
          });
          return;
        }
        case "cancel": {
          const result = handler.cancel(typeof payload.job_id === "string" ? payload.job_id : "");
          this.sendJobResult(agentId, msg.req_id, { ok: true, result });
          return;
        }
        default:
          this.sendJobResult(agentId, msg.req_id, {
            ok: false,
            error: `unknown job op: ${String(msg.op)}`,
          });
          return;
      }
    } catch (err) {
      this.onError(err, { ctx: "job_request", op: msg.op, agent_id: agentId });
      this.sendJobResult(agentId, msg.req_id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle the durable scheduled-task ops (`schedule` / `list_scheduled` /
   * `unschedule`) inline in the daemon. Writing the job file here — not in the
   * agent's MCP subprocess — is deliberate: the daemon's cwd is the project
   * root, so `schedule-ops.ts` resolves the same jobs dir that `loadJobs()`
   * scans and the 30s hot-reload picks up. Errors (bad cron, bad label,
   * duplicate) are returned as `ok:false` so the agent sees a clear message
   * rather than a silent miss.
   */
  private async handleScheduleRequest(agentId: string, msg: IpcJobRequest): Promise<void> {
    const p = (msg.payload ?? {}) as {
      label?: unknown;
      cron?: unknown;
      prompt?: unknown;
      recurring?: unknown;
      model?: unknown;
    };
    try {
      if (msg.op === "schedule") {
        const input: ScheduleTaskInput = {
          agentId,
          label: typeof p.label === "string" ? p.label : "",
          cron: typeof p.cron === "string" ? p.cron : "",
          prompt: typeof p.prompt === "string" ? p.prompt : "",
          ...(typeof p.recurring === "boolean" ? { recurring: p.recurring } : {}),
          ...(typeof p.model === "string" ? { model: p.model } : {}),
        };
        const summary = await scheduleTask(input);
        this.sendJobResult(agentId, msg.req_id, { ok: true, result: summary });
        return;
      }
      if (msg.op === "list_scheduled") {
        const tasks = await listScheduledTasks(agentId);
        this.sendJobResult(agentId, msg.req_id, { ok: true, result: tasks });
        return;
      }
      // unschedule
      await deleteScheduledTask(agentId, typeof p.label === "string" ? p.label : "");
      this.sendJobResult(agentId, msg.req_id, { ok: true, result: { deleted: true } });
    } catch (err) {
      this.onError(err, { ctx: "schedule_request", op: msg.op, agent_id: agentId });
      this.sendJobResult(agentId, msg.req_id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Send a correlated `job_result` back to the dispatching agent (#296 PR 3). */
  private sendJobResult(
    agentId: string,
    reqId: string,
    r: { ok: boolean; result?: unknown; error?: string },
  ): void {
    const msg: IpcJobResult = {
      type: "job_result",
      req_id: reqId,
      ok: r.ok,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    };
    this.emitControl(agentId, msg);
  }

  /**
   * Route messages received from the Bus MCP into the right ingest path.
   * Per spec §5.4, the Bus core handles `reply`, `ask`, `cancel`,
   * `request_human`, `job_request`, and `permission_request` inbound from MCP.
   */
  private handleIpcMessage(agentId: string, msg: IpcMessage): void {
    switch (msg.type) {
      case "reply":
        this.ingestReply({
          agent_id: agentId,
          text: msg.text,
          intent: msg.intent,
          ...(msg.in_reply_to ? { in_reply_to: msg.in_reply_to } : {}),
        });
        break;
      case "edit_message": {
        const origin = this.lastPromptOrigin.get(agentId);
        this.publish({
          ts: Date.now(),
          agent_id: agentId,
          session_id: "",
          topic: "response.edit_text",
          payload: {
            text: msg.text,
            ...(origin ? { origin: origin.origin, origin_id: origin.origin_id } : {}),
          },
        });
        break;
      }
      case "ask":
        // Surface as an event; the adapter is responsible for answering via
        // `ingestAskAnswer` (added in a later sprint). Sprint 1 emits the
        // event so the e2e test can observe it.
        this.publish({
          ts: Date.now(),
          agent_id: agentId,
          session_id: "",
          topic: "system.ask",
          payload: { ask_id: msg.ask_id, question: msg.question },
        });
        break;
      case "cancel":
        this.publish({
          ts: Date.now(),
          agent_id: agentId,
          session_id: "",
          topic: "system.cancel",
          payload: { reason: msg.reason },
        });
        // Cancel signals the turn won't produce a `final` reply. Clear
        // the cached origin so any subsequent scheduler/cron event for
        // this agent doesn't inherit it and misroute (5-agent review
        // on PR #138, A1 finding).
        this.lastPromptOrigin.delete(agentId);
        this.silentClosedOrigin.delete(agentId);
        this.originAmbiguous.delete(agentId);
        // No `response.turn_end` is coming, so release the operation slot
        // here too — otherwise the next turn's events carry the cancelled
        // turn's id.
        this.currentOperation.delete(agentId);
        this.correlationAmbiguous.delete(agentId);
        this.pendingTurns.delete(agentId);
        // Silent-drop safety net (#215): cancelled turn won't produce
        // a real reply OR a `response.turn_end` event — drop the
        // tracking flag to keep the map bounded.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
        this.currentTurnFinalOrigins.delete(agentId);
        // Reply-tool enforcement (#215/#240): no turn_end is coming — drop the
        // nudge state too so it can't leak into a later turn for this agent.
        this.replyNudged.delete(agentId);
        this.pendingNudgeText.delete(agentId);
        // A cancelled/errored turn emits no response.turn_end, so the
        // neighbor-turn flag would never clear via the tailer — drop it here
        // too, else flush-verify defers forever for this agent (#252 stack ultra).
        this.agentTurnActive.delete(agentId);
        // #239: the process spoke, so the gate parked by a close is moot; but
        // the CLI turn itself may still be running (`cancel` is a tool the
        // agent calls mid-turn) — the next admission waits for its own line.
        this.gateParked.delete(agentId);
        this.redeliveredSinceClose.delete(agentId);
        this.earlyReleased.add(agentId);
        this.touchTurn(agentId); // the deadline goes with the slot
        this.admitNext(agentId);
        break;
      case "request_human": {
        // Forward the correlation id along with the question. Without
        // `ask_id` the subscriber (Sprint 3 adapter) can't echo back the
        // matching `IpcAskAnswer` and the originating tool call blocks
        // forever. PR #110 review (agent #5): the wire format carries
        // `ask_id` but this fan-out previously dropped it.
        //
        // Origin propagation (post-#137 bug): attach the originating
        // surface so the adapter that owns it (and only that adapter)
        // surfaces the question. Without this, the request fanned out
        // to every channel of every adapter that subscribed.
        const askOrigin = this.lastPromptOrigin.get(agentId);
        this.publish({
          ts: Date.now(),
          agent_id: agentId,
          session_id: "",
          topic: "system.request_human",
          payload: {
            ask_id: msg.ask_id,
            question: msg.question,
            ...(askOrigin ? { origin: askOrigin.origin, origin_id: askOrigin.origin_id } : {}),
          },
        });
        break;
      }
      case "job_request":
        // #296 PR 3: an agent's dispatch_job/job_status/list_jobs/cancel_job
        // tool routes here over IPC. The AgentJobRunner lives in the daemon
        // (only it spawns/tracks the headless `claude -p` job processes); we
        // run the op and send back a correlated `job_result`.
        this.handleJobRequest(agentId, msg);
        break;
      case "permission_request": {
        // Same origin-propagation fix as request_human above: the
        // request_id-bearing payload now also carries the originating
        // surface so the prompt UI lands only on the channel that
        // triggered the tool call.
        const permOrigin = this.lastPromptOrigin.get(agentId);
        // #284 MEDIUM: `lastPromptOrigin` is single-slot / last-write-wins with
        // no per-request correlation (residual #239 interleave race). It is fine
        // for best-effort *routing* of the operator card below, but it must NOT
        // drive a SECURITY deny when a concurrent same-agent prompt may have
        // overwritten the identity — a wrong user/skill could auto-deny the wrong
        // request or skip a deny that applies. Only feed identity into the gate
        // when attribution is unambiguous (a clean single in-flight prompt);
        // otherwise evaluate with no origin so identity/channel-scoped rules fall
        // through to the human card (fail-OPEN) while tool-only/global denies still apply.
        const gateOrigin =
          permOrigin && !this.originAmbiguous.has(agentId) ? permOrigin : undefined;
        // #258 item 3 (minimal slice): consult policy before the operator card.
        // Only an EXPLICIT matched deny rule auto-denies (deny-wins); the
        // engine's no-match default-deny must NOT short-circuit here, or every
        // tool would be blocked when no rules are configured. Fail-OPEN: any
        // evaluation error falls through to the normal human-in-the-loop card.
        if (this.permissionPolicyDenies(agentId, msg.request, gateOrigin)) {
          this.ingestPermissionDecision({
            agent_id: agentId,
            request_id: msg.request.request_id,
            behavior: "deny",
          });
          break;
        }
        this.publish({
          ts: Date.now(),
          agent_id: agentId,
          session_id: "",
          topic: "channel.permission_request",
          payload: {
            ...msg.request,
            ...(permOrigin ? { origin: permOrigin.origin, origin_id: permOrigin.origin_id } : {}),
          },
        });
        break;
      }
      case "error":
        this.onError(new Error(`MCP error: ${msg.code} ${msg.message}`), {
          ctx: "ipc-error",
          agentId,
        });
        // Error means the turn likely won't produce a `final` reply.
        // Same lifecycle concern as `cancel` — clear so subsequent
        // scheduler events for this agent don't inherit the stale
        // origin (5-agent review on PR #138, A1 finding).
        this.lastPromptOrigin.delete(agentId);
        this.silentClosedOrigin.delete(agentId);
        this.originAmbiguous.delete(agentId);
        // Same reason as `cancel`: no turn_end, so the slot must not survive
        // into the next turn.
        this.currentOperation.delete(agentId);
        this.correlationAmbiguous.delete(agentId);
        this.pendingTurns.delete(agentId);
        // Silent-drop safety net (#215): error path won't produce a
        // turn_end either — clear tracking too.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
        this.currentTurnFinalOrigins.delete(agentId);
        // Reply-tool enforcement (#215/#240): no turn_end is coming — drop the
        // nudge state too so it can't leak into a later turn for this agent.
        this.replyNudged.delete(agentId);
        this.pendingNudgeText.delete(agentId);
        // A cancelled/errored turn emits no response.turn_end, so the
        // neighbor-turn flag would never clear via the tailer — drop it here
        // too, else flush-verify defers forever for this agent (#252 stack ultra).
        this.agentTurnActive.delete(agentId);
        // #239: the process spoke, so the gate parked by a close is moot; but
        // the CLI turn itself may still be running (`cancel` is a tool the
        // agent calls mid-turn) — the next admission waits for its own line.
        this.gateParked.delete(agentId);
        this.redeliveredSinceClose.delete(agentId);
        this.earlyReleased.add(agentId);
        this.touchTurn(agentId); // the deadline goes with the slot
        this.admitNext(agentId);
        break;
      // hello already handled in the IPC layer; outbound types (prompt,
      // permission_response, ask_answer) shouldn't arrive from MCP.
      default:
        this.onError(
          new Error(`Unexpected IPC message from MCP: ${(msg as { type: string }).type}`),
          { ctx: "ipc-unexpected", agentId },
        );
    }
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* Convenience factory                                                   */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Create a Bus core with sensible defaults. Caller still needs to call
 * `start()` to bind the IPC socket.
 */
export function createBusCore(opts: BusCoreOptions = {}): BusCore {
  return new BusCoreImpl(opts);
}

// Re-exports for adapters / tests that don't want to dig into the helpers.
export type { Subscription, SubscriptionFilter, SubscriptionHandler } from "./core-subscription";
export { encodeFrame, resolveDefaultUdsPath };
