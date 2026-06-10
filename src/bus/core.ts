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
  IpcMessage,
  IpcPrompt,
  PermissionResponse,
} from "./types";
import { CHANNEL_DRIVEN_ORIGINS } from "./types";

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
  /** Slash-command delegate (Agent C wires this). */
  slashCommandHandler?: SlashCommandHandler;
  /** REPL prompt delegate for PTY-stdin agents. Wired by the Session Manager. */
  streamPromptHandler?: StreamPromptHandler;
  /** Logger; defaults to console.error. */
  onError?: (err: unknown, ctx?: Record<string, unknown>) => void;
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
  private readonly onError: (err: unknown, ctx?: Record<string, unknown>) => void;
  /**
   * Tracks the origin (surface + channel id) of the most recent prompt
   * per agent. Adapters use this on outbound `response.text` events to
   * route the reply back to the originating channel/DM rather than
   * fanning out to every channel the agent owns. Last-write-wins —
   * acceptable because Discord/Telegram bots wait for a reply before
   * sending another prompt; interleaved prompts on the same agent
   * fall back to broadcast behaviour at the adapter level.
   */
  private readonly lastPromptOrigin = new Map<string, { origin: BusOrigin; origin_id: string }>();

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

  constructor(opts: BusCoreOptions = {}) {
    this.socketPath = opts.socketPath ?? null;
    this.ringbufferCapacity = opts.ringbufferCapacity ?? DEFAULT_RINGBUFFER_CAPACITY;
    this.deliveryBackstopMs = opts.deliveryBackstopMs ?? 4000;
    this.eventLogAppend = opts.eventLogAppend ?? eventLogAppend;
    this.slashCommandHandler = opts.slashCommandHandler ?? null;
    this.streamPromptHandler = opts.streamPromptHandler ?? null;
    this.onError = opts.onError ?? ((err, ctx) => console.error("[bus]", err, ctx));
  }

  /* ─────────────────────────────── lifecycle ─────────────────────────────── */

  async start(): Promise<void> {
    if (this.ipcServer || !this.socketPath) return;
    this.ipcServer = await bindUdsServer(this.socketPath, {
      onHello: (agentId, _caps) => {
        this.connectedAgents.add(agentId);
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
          this.currentTurnReplied.delete(agentId);
          this.currentTurnFinalPublished.delete(agentId);
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
    this.lastPromptOrigin.set(req.agent_id, {
      origin: req.origin,
      origin_id: req.origin_id,
    });
    // Silent-drop safety net (#215): new prompt → reset the "did this
    // turn call reply?" flag. If the agent ends the turn (response.turn_end)
    // without ever setting this to true, we'll synthesize delivery.
    this.currentTurnReplied.set(req.agent_id, false);
    // #217 finding 2: a new turn starts undelivered — clear the
    // cross-transport "final already published" dedup flag.
    this.currentTurnFinalPublished.set(req.agent_id, false);

    const ipcMsg: IpcPrompt = {
      type: "prompt",
      agent_id: req.agent_id,
      origin: req.origin,
      origin_id: req.origin_id,
      user_id: req.user_id,
      text: req.text,
      metadata: req.metadata,
    };
    if (this.ipcServer) {
      const sent = this.ipcServer.send(req.agent_id, ipcMsg);
      if (!sent) {
        this.onError(new Error(`No MCP connection for agent_id=${req.agent_id}`), {
          ctx: "sendPrompt",
        });
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
          attrs.push(`${k}="${escapeXmlAttr(String(v))}"`);
        }
      }
      const wrapped = `<channel ${attrs.join(" ")}>${escapeXmlText(req.text)}</channel>`;
      this.deliverOrQueuePrompt(req.agent_id, wrapped);
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
    void this.streamPromptHandler(agent_id, wrapped).catch((err) =>
      this.onError(err, { ctx: "streamPromptHandler", agent_id }),
    );
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
      this.markAgentReady(agent_id);
    }, this.deliveryBackstopMs);
    this.agentInitializing.set(agent_id, timer);
  }

  /** `replay_done` (or backstop) → session ready: record the live generation
   *  (so a late `session.init` for it can't re-arm a hold), clear any pending
   *  hold, and flush held prompts in order. Called unconditionally on
   *  `replay_done`, which the tailer emits for every session generation. */
  private markAgentReady(agent_id: string, session_id?: string): void {
    if (session_id) this.agentLiveSession.set(agent_id, session_id);
    const timer = this.agentInitializing.get(agent_id);
    if (timer) clearTimeout(timer);
    this.agentInitializing.delete(agent_id);
    const q = this.deliveryQueue.get(agent_id);
    if (!q || q.length === 0) return;
    this.deliveryQueue.delete(agent_id);
    for (const wrapped of q) this.streamDeliver(agent_id, wrapped);
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
    }> = {
      ts: Date.now(),
      agent_id: req.agent_id,
      session_id: "",
      topic,
      payload: {
        text: req.text,
        intent: req.intent,
        ...(origin ? { origin: origin.origin, origin_id: origin.origin_id } : {}),
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
      // Silent-drop safety net (#215): the agent called `reply` with a final
      // intent → mark this turn as delivered, so the `response.turn_end`
      // handler skips the synthetic-delivery fallback for this turn.
      this.currentTurnReplied.set(req.agent_id, true);
      // #217 finding 2: record that a final was published for this turn so
      // the cross-transport race loser (real reply vs synthesized) is
      // suppressed above.
      this.currentTurnFinalPublished.set(req.agent_id, true);
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
    if (!text || text.trim().length === 0) return;
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
    console.warn(
      `[bus] silent-drop recovered for agent=${agentId} (origin=${origin.origin}, ` +
        `chars=${text.length}): the turn ended with text but the agent did not call the ` +
        `reply tool — synthesizing ingestReply to deliver. See issue #215.`,
    );
    // Mark BEFORE the recursive ingestReply so the synthetic call itself
    // doesn't trigger another safety-net pass (it would no-op anyway
    // because we set the flag here, but the explicit ordering makes the
    // single-fire intent clearer).
    this.currentTurnReplied.set(agentId, true);
    // `synthetic: true` lets this first delivery through the cross-transport
    // dedup (#217 finding 2); it sets `currentTurnFinalPublished`, so a
    // later real `reply` IPC for the same turn is suppressed.
    this.ingestReply(
      {
        agent_id: agentId,
        text,
        intent: "final",
      },
      { synthetic: true },
    );
  }

  ingestSessionEvent(e: BusEvent): void {
    // Delivery gate: hold PTY-stdin prompts while the agent's session is
    // (re)initialising so a keystroke isn't swallowed by a not-yet-ready TUI,
    // and release them once it's live.
    if (e.agent_id) {
      if (e.topic === "session.init") this.markAgentInitializing(e.agent_id, e.session_id);
      else if (e.topic === "bus.events.replay_done") this.markAgentReady(e.agent_id, e.session_id);
    }
    // Silent-drop safety net (#215): the JSONL tailer publishes a
    // `response.turn_end` event when claude stops with `end_turn`. Hook
    // into it before the generic publish so we can synthesize a
    // delivery for turns that produced text but never called reply.
    if (e.topic === "response.turn_end" && e.agent_id) {
      const payload = e.payload as { text?: string };
      this.handleTurnEnd(e.agent_id, payload?.text ?? "");
    }
    this.publish(e);
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
   * Route messages received from the Bus MCP into the right ingest path.
   * Per spec §5.4, the Bus core handles `reply`, `ask`, `cancel`,
   * `request_human`, and `permission_request` inbound from MCP.
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
        // Silent-drop safety net (#215): cancelled turn won't produce
        // a real reply OR a `response.turn_end` event — drop the
        // tracking flag to keep the map bounded.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
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
      case "permission_request": {
        // Same origin-propagation fix as request_human above: the
        // request_id-bearing payload now also carries the originating
        // surface so the prompt UI lands only on the channel that
        // triggered the tool call.
        const permOrigin = this.lastPromptOrigin.get(agentId);
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
        // Silent-drop safety net (#215): error path won't produce a
        // turn_end either — clear tracking too.
        this.currentTurnReplied.delete(agentId);
        this.currentTurnFinalPublished.delete(agentId);
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
