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
  IpcJobRequest,
  IpcJobResult,
  IpcMessage,
  IpcPrompt,
  PermissionRequest,
  PermissionResponse,
} from "./types";
import { CHANNEL_DRIVEN_ORIGINS } from "./types";
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

export type IngestReplyRequest = {
  agent_id: string;
  text: string;
  intent: "final" | "progress" | "tool_status";
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
 * it in addition to the `notifications/claude/channel` IPC notification, so
 * headless (daemon-spawned) claudes — which don't start a turn from the MCP
 * notification alone — receive the prompt as typed input and reliably respond.
 */
export type StreamPromptHandler = (agent_id: string, text: string) => Promise<void>;

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
  /** Slash-command delegate (Agent C wires this). */
  slashCommandHandler?: SlashCommandHandler;
  /** REPL prompt delegate for PTY-stdin agents. Wired by the Session Manager. */
  streamPromptHandler?: StreamPromptHandler;
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
  sendPrompt(req: SendPromptRequest): Promise<{ promise_id: string }>;
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

export class BusCoreImpl implements BusCore {
  private subscribers = new Map<string, SubscriberRecord>();
  private connectedAgents = new Set<string>();
  private ipcServer: IpcServer | null = null;
  private readonly socketPath: string | null;
  private readonly ringbufferCapacity: number;
  private readonly eventLogAppend: EventLogAppendFn;
  private slashCommandHandler: SlashCommandHandler | null;
  private streamPromptHandler: StreamPromptHandler | null;
  // Settable post-hoc (like streamPromptHandler): the AgentJobRunner needs
  // `sendPrompt` for result delivery, so the daemon constructs it after the
  // bus and wires it via setJobHandler (#296 PR 3).
  private jobHandler: AgentJobHandler | null;
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  private readonly evaluatePolicy: (ctx: ToolRequestContext) => PolicyDecision;
  // Settable post-hoc (like streamPromptHandler): the bus is constructed
  // before the SessionManager exists, so the reconciler is wired afterwards.
  private onMcpSendFailed: (agentId: string, ctx: { reason: string }) => void = () => {};
  /**
   * Tracks the origin (surface + channel id) of the most recent prompt
   * per agent. Adapters use this on outbound `response.text` events to
   * route the reply back to the originating channel/DM rather than
   * fanning out to every channel the agent owns. Last-write-wins —
   * acceptable because Discord/Telegram bots wait for a reply before
   * sending another prompt; interleaved prompts on the same agent
   * fall back to broadcast behaviour at the adapter level.
   */
  private readonly lastPromptOrigin = new Map<
    string,
    { origin: BusOrigin; origin_id: string; userId?: string; skillName?: string }
  >();

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
  private readonly deliveryBackstopMs: number;
  /**
   * Pending turn-start verification for a BACKSTOP-flushed prompt. The backstop
   * fires on a TIMER because `replay_done` never arrived — but during an
   * IPC-reconnect storm the session is still re-initialising, so the flushed
   * keystroke can be swallowed and never start a turn (dossier 20260613T033017).
   * After such a flush we watch for proof THAT prompt started a turn — a tailer
   * `prompt` event whose ingested text matches the wrapped string we delivered
   * (exact attribution; an unrelated later prompt's turn must not satisfy an
   * earlier swallowed one) — and, if none lands within `flushVerifyMs`,
   * re-deliver THAT prompt ONCE through the gate. Per-prompt timers, not one
   * per agent: a second flush adds to the set instead of discarding pending
   * ones, and each prompt is verified/re-delivered independently. The watchdog
   * stays the ultimate net. Maps agent → (wrapped prompt → verify timer).
   */
  private readonly flushVerify = new Map<
    string,
    Map<string, { wrapped: string; graced: boolean; timer: ReturnType<typeof setTimeout> }>
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
   * (emitted by the JSONL tailer when `stop_reason === "end_turn"`), if
   * this is still `false` and the turn produced non-empty text, the
   * agent ended the turn without delivering — we synthesize an
   * `ingestReply` so the user actually receives the response.
   *
   * Single-slot per agent, last-write-wins — the same limitation
   * `lastPromptOrigin` carries above (and this map depends on
   * `lastPromptOrigin` for routing the synthesized reply). Interleaving two
   * in-flight prompts on one agent would let the second `sendPrompt` reset
   * the flag mid-turn for the first; the webui-bridge mutex serialising
   * prompt→reply per agent is the workaround for the path that would
   * otherwise violate the one-turn-at-a-time assumption. The residual
   * cross-channel stale/misroute race this leaves open (a lagged turn_end
   * synthesizing the wrong prompt's text to the wrong surface) is tracked
   * as deferred follow-up #239 — see the note in `handleTurnEnd`.
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

  constructor(opts: BusCoreOptions = {}) {
    this.replyNudgeEnabled = opts.replyNudge ?? true;
    this.socketPath = opts.socketPath ?? null;
    this.ringbufferCapacity = opts.ringbufferCapacity ?? DEFAULT_RINGBUFFER_CAPACITY;
    this.deliveryBackstopMs = opts.deliveryBackstopMs ?? 4000;
    this.flushVerifyMs = opts.flushVerifyMs ?? 8000;
    this.flushVerifyGraceMs =
      opts.flushVerifyGraceMs ?? Math.min(1500, Math.ceil(this.flushVerifyMs / 4));
    this.eventLogAppend = opts.eventLogAppend ?? eventLogAppend;
    this.slashCommandHandler = opts.slashCommandHandler ?? null;
    this.streamPromptHandler = opts.streamPromptHandler ?? null;
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
          this.lastPromptOrigin.delete(agentId);
          this.originAmbiguous.delete(agentId);
          this.currentTurnReplied.delete(agentId);
          this.currentTurnFinalPublished.delete(agentId);
          // Reply-tool enforcement (#215/#240): drop nudge state with the rest
          // of the per-turn flags so a dead session can't leave it dangling.
          this.replyNudged.delete(agentId);
          this.pendingNudgeText.delete(agentId);
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
          const pendingVerify = this.flushVerify.get(agentId);
          if (pendingVerify)
            for (const entry of pendingVerify.values()) carryOver.add(entry.wrapped);
          if (carryOver.size > 0) this.pendingRedelivery.set(agentId, [...carryOver]);
          this.deliveryQueue.delete(agentId);
          // Same hazard for a pending flush-verify timer: if it fired after a
          // restart that reused this agent_id it would type a stale keystroke
          // into the fresh session (#252 HIGH).
          this.clearFlushVerify(agentId);
          this.inFlightDeliveries.delete(agentId);
          this.agentTurnActive.delete(agentId);
          this.logIpc("close", {
            agent: agentId,
            connections: this.ipcServer?.connectionCount() ?? 0,
            registered: this.connectedAgents.size,
          });
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
    this.inFlightDeliveries.clear();
    this.agentTurnActive.clear();
    this.originAmbiguous.clear();
    this.pendingRedelivery.clear();
    this.replyNudged.clear();
    this.pendingNudgeText.clear();
  }

  /* ─────────────────────────────── prompts ─────────────────────────────── */

  async sendPrompt(req: SendPromptRequest): Promise<{ promise_id: string }> {
    const promise_id = randomUUID();
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
      payload: {
        origin: req.origin,
        origin_id: req.origin_id,
        user_id: req.user_id,
        text: req.text,
        metadata: req.metadata,
        promise_id,
      },
    };
    this.publish(promptEvent);
    // Remember the origin so `ingestReply` can attach it to the
    // outbound `response.text` event for surface-aware routing.
    //
    // #284 MEDIUM: if a prior prompt is still in flight (the slot is already
    // occupied), this overwrite makes the cached identity ambiguous for the
    // security gate — mark the agent so the permission gate won't attribute a
    // deny to the wrong user/skill. A `set` onto an empty slot is a clean,
    // unambiguous single prompt, so clear any prior taint.
    if (this.lastPromptOrigin.has(req.agent_id)) {
      this.originAmbiguous.add(req.agent_id);
    } else {
      this.originAmbiguous.delete(req.agent_id);
    }
    this.lastPromptOrigin.set(req.agent_id, {
      origin: req.origin,
      origin_id: req.origin_id,
      // #258 item 3 slice 2: carry the inbound identity so the per-tool
      // permission gate can scope policy by user and (when a surface tags the
      // submit with metadata.command) by skill.
      userId: req.user_id || undefined,
      skillName:
        typeof req.metadata?.command === "string"
          ? req.metadata.command.replace(/^\//, "")
          : undefined,
    });
    // Silent-drop safety net (#215): new prompt → reset the "did this
    // turn call reply?" flag. If the agent ends the turn (response.turn_end)
    // without ever setting this to true, we'll synthesize delivery.
    this.currentTurnReplied.set(req.agent_id, false);
    // #217 finding 2: a new turn starts undelivered — clear the
    // cross-transport "final already published" dedup flag.
    this.currentTurnFinalPublished.set(req.agent_id, false);
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
      const sent = this.ipcServer.send(req.agent_id, ipcMsg);
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
      // If the agent's session is (re)initialising the prompt is HELD and the
      // backstop flush-verify path already covers it. The uncovered case is an
      // IMMEDIATE delivery whose IPC send just failed: the MCP/IPC socket
      // blipped at the prompt boundary, so the PTY keystroke can coincide with a
      // reconnect and be swallowed without starting a turn — and the #222
      // reconciler disarms on "reconnected during confirm window" WITHOUT
      // checking a turn started (dossier 20260614T034258). Verify turn-start for
      // that prompt and re-deliver once if none lands.
      // Arm a turn-start verify when the PTY confirm-loop can't be trusted to
      // attribute the turn to THIS prompt: (a) the IPC send just failed (socket
      // blip), or (b) a neighbor turn is already streaming, so this keystroke is
      // queued in the REPL box and the confirm-loop may read the neighbor's
      // stream as this prompt's turn-start (#250 HIGH). The verify defers while a
      // turn stays active and re-delivers only if no turn ever starts.
      const deliveredImmediately = !this.agentInitializing.has(req.agent_id);
      const neighborTurnActive = this.agentTurnActive.has(req.agent_id);
      this.deliverOrQueuePrompt(req.agent_id, wrapped);
      if ((ipcSendFailed || neighborTurnActive) && deliveredImmediately) {
        this.armFlushVerify(req.agent_id, [wrapped]);
      }
    }
    return { promise_id };
  }

  /** Deliver a PTY-stdin prompt, or hold it if the agent's session is
   *  (re)initialising (the not-yet-ready TUI would swallow the keystroke).
   *  Held prompts flush on `replay_done` (`markAgentReady`) or the backstop. */
  private deliverOrQueuePrompt(agent_id: string, wrapped: string): void {
    if (!this.streamPromptHandler) return;
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
    void this.streamPromptHandler(agent_id, wrapped)
      .catch((err) => this.onError(err, { ctx: "streamPromptHandler", agent_id }))
      .finally(() => {
        const n = (this.inFlightDeliveries.get(agent_id) ?? 1) - 1;
        if (n <= 0) this.inFlightDeliveries.delete(agent_id);
        else this.inFlightDeliveries.set(agent_id, n);
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
  private markAgentReady(agent_id: string, session_id?: string, viaBackstop = false): void {
    if (session_id) this.agentLiveSession.set(agent_id, session_id);
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
    // Re-deliver prompts carried over from a prior socket close (e.g. a #222
    // reconciler restart of a deaf agent): the fresh session is now ready, so
    // push them through the gate. Independent of the held-queue below, and done
    // first so they keep their original order ahead of anything newly held.
    const carried = this.pendingRedelivery.get(agent_id);
    if (carried) {
      this.pendingRedelivery.delete(agent_id);
      for (const wrapped of carried) this.deliverOrQueuePrompt(agent_id, wrapped);
    }
    const q = this.deliveryQueue.get(agent_id);
    if (!q || q.length === 0) return;
    this.deliveryQueue.delete(agent_id);
    for (const wrapped of q) this.streamDeliver(agent_id, wrapped);
    // A backstop flush is timer-driven (no `replay_done`), so the session may
    // still be mid-(re)init and swallow the keystroke; verify a turn actually
    // starts and re-deliver once if not. The real `replay_done` path is
    // known-ready and needs no verification.
    if (viaBackstop) this.armFlushVerify(agent_id, q);
  }

  /** Arm per-prompt turn-start verification after a backstop flush. Each flushed
   *  prompt gets its own one-shot timer; a prompt already awaiting verification
   *  is left untouched (a second flush ADDS to the set, never discards pending
   *  ones — #252). The timer is cancelled by `noteFlushTurnStart` when the
   *  matching `prompt` lands, and re-delivers exactly that prompt otherwise. */
  private armFlushVerify(agent_id: string, prompts: string[]): void {
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
          `backstop-flushed prompt produced no turn within ${this.flushVerifyMs}ms; re-delivering once for agent_id=${agent_id}`,
        ),
        { ctx: "flushVerify", agent_id },
      );
      this.deliverOrQueuePrompt(agent_id, entry.wrapped);
    }, delayMs);
  }

  /** A tailer `prompt` event proves THAT specific prompt started its turn: its
   *  ingested text is the user line claude recorded = the wrapped string we
   *  delivered. Cancel only the matching pending verify, so an unrelated later
   *  prompt's turn never silences a still-swallowed earlier prompt's
   *  re-delivery (#252). */
  private noteFlushTurnStart(agent_id: string, ingestedText: string): void {
    const pending = this.flushVerify.get(agent_id);
    if (!pending) return;
    // ingestedText is the line claude recorded (already PTY-sanitized) and the
    // map keys are sanitized too; sanitize again — it is idempotent — to be
    // robust against any residual normalization before the exact-match lookup.
    const key = sanitizePtyPromptText(ingestedText);
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    if (pending.size === 0) this.flushVerify.delete(agent_id);
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
  activeTurnAgents(): string[] {
    return [...this.agentTurnActive];
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

  ingestReply(req: IngestReplyRequest, opts?: { synthetic?: boolean }): void {
    // Cross-transport dedup (#217 finding 2): a final reply can arrive both
    // as the agent's real `reply` IPC AND as the synthesized recovery from
    // `response.turn_end` (the JSONL tailer). They race on two unordered
    // channels; whichever lands first publishes and sets
    // `currentTurnFinalPublished`. The loser is suppressed here so the same
    // turn never delivers two finals. `synthetic` calls (from
    // `handleTurnEnd`) bypass the check — they only run AFTER confirming no
    // final has published yet, and must be allowed to publish the first.
    if (
      req.intent === "final" &&
      !opts?.synthetic &&
      this.currentTurnFinalPublished.get(req.agent_id) === true
    ) {
      return;
    }
    const topic: BusEventTopic =
      req.intent === "tool_status" ? "response.tool_use" : "response.text";
    // Attach the originating surface so adapters can route the reply
    // back to the same DM / channel rather than fanning out. The lookup
    // is best-effort — if no prompt has been seen yet (e.g. a scheduler-
    // initiated reply), the field stays undefined and the adapter falls
    // back to its configured channel set.
    const origin = this.lastPromptOrigin.get(req.agent_id);
    const event: BusEvent<{
      text: string;
      intent: string;
      origin?: BusOrigin;
      origin_id?: string;
      synthesized?: true;
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
      this.lastPromptOrigin.delete(req.agent_id);
      this.originAmbiguous.delete(req.agent_id);
      // Silent-drop safety net (#215): the agent called `reply` with a final
      // intent → mark this turn as delivered, so the `response.turn_end`
      // handler skips the synthetic-delivery fallback for this turn.
      this.currentTurnReplied.set(req.agent_id, true);
      // #217 finding 2: record that a final was published for this turn so
      // the cross-transport race loser (real reply vs synthesized) is
      // suppressed above.
      this.currentTurnFinalPublished.set(req.agent_id, true);
      // Reply-tool enforcement (#215/#240): a final was delivered (incl. one a
      // nudge successfully produced) — clear the nudge state for the turn.
      this.replyNudged.delete(req.agent_id);
      this.pendingNudgeText.delete(req.agent_id);
    }
  }

  /**
   * Silent-drop safety net handler (issue #215). Wired by
   * `ingestSessionEvent`/JSONL tailer when it observes a `response.turn_end`
   * with `stop_reason: "end_turn"`. If the agent ended the turn with
   * non-empty text but never called the `reply` tool for this prompt,
   * synthesize an `ingestReply` so the user actually receives the
   * response. Without this, the text sits in the session `.jsonl` and
   * the user-facing surface gets nothing — confirmed live 2x in 12h
   * on a real bus-mode deployment after issue #215 was filed.
   */
  private handleTurnEnd(agentId: string, text: string): void {
    if (this.currentTurnReplied.get(agentId) === true) return;
    // #217 finding 2: if a final already published for this turn (e.g. the
    // real reply IPC landed first), don't synthesize a duplicate.
    if (this.currentTurnFinalPublished.get(agentId) === true) return;
    // Effective text to deliver: this turn's own text, or — on a turn we already
    // nudged that produced none — the original text stashed when we nudged, so a
    // nudged-but-still-silent turn never loses the first turn's output (#215).
    const nudged = this.replyNudged.get(agentId) === true;
    const ownText = text && text.trim().length > 0 ? text : "";
    const deliverText = ownText || (nudged ? (this.pendingNudgeText.get(agentId) ?? "") : "");
    if (deliverText.trim().length === 0) return;
    // RESIDUAL RACE (#217 finding 3 → deferred #239): `lastPromptOrigin` and
    // the per-turn flags are single-slot, keyed by agent_id only, with no
    // prompt/turn identity. The JSONL tailer's `response.turn_end` is
    // delivered asynchronously (fs.watch + drain), so on a cross-channel
    // interleave — P1(telegram) ends → reply → P2(webui) arrives (resets the
    // flag, rewrites origin=webui) → P1's lagged turn_end lands here — this
    // can route P1's text to P2's origin (webui). The flag-reset path is
    // largely covered by the webui-bridge mutex serialising prompt→reply per
    // agent, but cross-surface interleave is NOT fully closed. A complete fix
    // threads the originating prompt_id onto the turn_end event and matches
    // it to the in-flight prompt before synthesizing; that requires the
    // tailer to carry prompt identity and is tracked as deferred follow-up
    // #239 to avoid destabilizing this safety-net PR.
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
    if (this.replyNudgeEnabled && !nudged) {
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
      console.warn(
        `[bus] reply nudge undeliverable for agent=${agentId} (no IPC/PTY transport) — ` +
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
   * with text but no reply. Delivered over the same seams as a prompt — IPC for
   * MCP-connected agents, PTY-stdin for headless ones — but best-effort: a
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
    this.currentTurnReplied.set(agentId, false);
    this.currentTurnFinalPublished.set(agentId, false);
    // IPC path (best-effort, no reconciler): reach an MCP-connected agent.
    // Wrapped so a synchronous send() throw can't skip the PTY path below or
    // propagate to the turn-end handler — the send is best-effort, mirroring
    // sendPrompt's IPC guard.
    let ipcDelivered = false;
    try {
      ipcDelivered =
        this.ipcServer?.send(agentId, {
          type: "prompt",
          agent_id: agentId,
          origin: origin.origin,
          origin_id: origin.origin_id,
          user_id: "system",
          text,
          metadata: { nudge: "reply-tool" },
        }) === true;
    } catch {
      /* best-effort: the PTY path + synthesize fallback still cover delivery */
    }
    // PTY-stdin path for headless agents. A <system-reminder> wrap signals this is
    // bus-injected guidance, not a user message. deliverOrQueuePrompt no-ops when no
    // streamPromptHandler is wired, so that is the PTY-availability signal.
    const ptyAvailable = this.streamPromptHandler !== null;
    this.deliverOrQueuePrompt(agentId, `<system-reminder>${escapeXmlText(text)}</system-reminder>`);
    // #261/#222: report whether ANY transport actually received the nudge, so a
    // deaf agent (neither IPC nor PTY) does not leave the caller waiting for a
    // turn that never starts.
    return ipcDelivered || ptyAvailable;
  }

  ingestSessionEvent(e: BusEvent): void {
    // Delivery gate: hold PTY-stdin prompts while the agent's session is
    // (re)initialising so a keystroke isn't swallowed by a not-yet-ready TUI,
    // and release them once it's live.
    if (e.agent_id) {
      if (e.topic === "session.init") this.markAgentInitializing(e.agent_id, e.session_id);
      else if (e.topic === "bus.events.replay_done") this.markAgentReady(e.agent_id, e.session_id);
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
        if (typeof text === "string") this.noteFlushTurnStart(e.agent_id, text);
        this.agentTurnActive.add(e.agent_id);
      }
    }
    // Silent-drop safety net (#215): the JSONL tailer publishes a
    // `response.turn_end` event when claude stops with `end_turn`. Hook
    // into it before the generic publish so we can synthesize a
    // delivery for turns that produced text but never called reply.
    if (e.topic === "response.turn_end" && e.agent_id) {
      const payload = e.payload as { text?: string };
      this.handleTurnEnd(e.agent_id, payload?.text ?? "");
      // The turn ended → the REPL is free, so a prompt queued behind it can now
      // start; stop deferring its flush-verify (see agentTurnActive).
      this.agentTurnActive.delete(e.agent_id);
    }
    this.publish(e);
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
    if (this.ipcServer) {
      this.ipcServer.send(req.agent_id, {
        type: "permission_response",
        agent_id: req.agent_id,
        response: { request_id: req.request_id, behavior: req.behavior },
      });
    }
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
    if (this.ipcServer) {
      this.ipcServer.send(req.agent_id, {
        type: "ask_answer",
        agent_id: req.agent_id,
        ask_id: req.ask_id,
        answer: req.answer,
      });
    }
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
  private publish(event: BusEvent): void {
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

  /** Send a correlated `job_result` back to the dispatching agent (#296 PR 3). */
  private sendJobResult(
    agentId: string,
    reqId: string,
    r: { ok: boolean; result?: unknown; error?: string },
  ): void {
    if (!this.ipcServer) return;
    const msg: IpcJobResult = {
      type: "job_result",
      req_id: reqId,
      ok: r.ok,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    };
    this.ipcServer.send(agentId, msg);
  }

  /**
   * Route messages received from the Bus MCP into the right ingest path.
   * Per spec §5.4, the Bus core handles `reply`, `ask`, `cancel`,
   * `request_human`, `job_request`, and `permission_request` inbound from MCP.
   */
  private handleIpcMessage(agentId: string, msg: IpcMessage): void {
    switch (msg.type) {
      case "reply":
        this.ingestReply({ agent_id: agentId, text: msg.text, intent: msg.intent });
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
        this.originAmbiguous.delete(agentId);
        // Silent-drop safety net (#215): cancelled turn won't produce
        // a real reply OR a `response.turn_end` event — drop the
        // tracking flag to keep the map bounded.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
        // Reply-tool enforcement (#215/#240): no turn_end is coming — drop the
        // nudge state too so it can't leak into a later turn for this agent.
        this.replyNudged.delete(agentId);
        this.pendingNudgeText.delete(agentId);
        // A cancelled/errored turn emits no response.turn_end, so the
        // neighbor-turn flag would never clear via the tailer — drop it here
        // too, else flush-verify defers forever for this agent (#252 stack ultra).
        this.agentTurnActive.delete(agentId);
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
        this.originAmbiguous.delete(agentId);
        // Silent-drop safety net (#215): error path won't produce a
        // turn_end either — clear tracking too.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
        // Reply-tool enforcement (#215/#240): no turn_end is coming — drop the
        // nudge state too so it can't leak into a later turn for this agent.
        this.replyNudged.delete(agentId);
        this.pendingNudgeText.delete(agentId);
        // A cancelled/errored turn emits no response.turn_end, so the
        // neighbor-turn flag would never clear via the tailer — drop it here
        // too, else flush-verify defers forever for this agent (#252 stack ultra).
        this.agentTurnActive.delete(agentId);
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
