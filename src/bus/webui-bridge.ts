/**
 * Bridge helpers used by the legacy webui (`src/ui/server.ts`) to drive
 * the bus runtime's claude session instead of spawning a sidecar PTY.
 *
 * Pulled out of `src/commands/start.ts` so it can be unit-tested
 * without booting the full daemon.
 *
 * Routes consuming this:
 *   - `/api/jobs/fire` — injects a runner into `fireJob` that calls
 *     `streamBusPrompt` with no `onChunk` and returns the accumulated
 *     final reply.
 *   - `/api/inject` — same shape, defaulting the agent to
 *     `BusWebUiBridge.defaultAgentId`.
 *   - `/api/chat` — passes `onChunk` so each `response.text` event is
 *     streamed back to the dashboard SSE as it arrives. Resolves
 *     when `intent: "final"` lands or the timeout fires.
 *
 * Receipt chain (issue #207): every call opens a receipt at entry (before the
 * per-agent lock wait, #454), stamps `prompt_hash` when the prompt is sent,
 * and closes on the terminal state (`turn_observed` on final, `timeout` on
 * timer or on giving up at the lock without sending — `notes.stage:
 * "bridge_lock"` — and `wedged_prompt` on `bus.sendPrompt` rejection). The bus → PTY seam in `runtime-mount.ts`
 * back-fills `process_pid`/`process_generation`/`agent_cwd` + stamps
 * `stdin_written` via `findByPromptHash`. Receipts land at
 * `~/.claude/claudeclaw/receipts.jsonl` (0600).
 */

import { randomBytes } from "node:crypto";
import type { BusCore } from "./core";
import { getDefaultReceiptStore, hashPrompt, type ReceiptStore } from "./receipt";
import { type BusOrigin, isTailerOriginEvent } from "./types";
import { incrementMessageCount, peekSession } from "../sessions";
import { needsRotation } from "../rotation";
import { getSettings } from "../config";

/**
 * Per-agent mutex tail used to serialize `streamBusPrompt` calls. Codex
 * P1 on #136: the bus subscriber filter `{agent_id, topics:
 * ["response.text"]}` doesn't carry a per-prompt correlation id, and
 * `BusCore.lastPromptOrigin` is last-write-wins, so two prompts in
 * flight on the same agent can return each other's replies. Serializing
 * at the bridge guarantees at most one prompt awaits per agent — chat,
 * fire, and inject from the dashboard now queue rather than racing.
 *
 * Tradeoff: a long-running cron job firing through `streamBusPrompt`
 * blocks a follow-up chat; since #454 the chat's own timeout covers that
 * wait, and it gives up unsent rather than queueing without a bound. Acceptable: BusScheduler doesn't go
 * through this bridge (it dispatches via `bus.sendPrompt` directly and
 * doesn't await), and dashboard interactions are intrinsically
 * single-user. If we ever route scheduler triggers through this
 * bridge, swap the mutex for a per-prompt correlation id propagated
 * from the bus core.
 */
const agentMutex = new Map<string, Promise<unknown>>();

export interface StreamBusPromptOptions {
  /** BusOrigin tag attached to the outgoing prompt. Defaults to "webui". */
  origin?: BusOrigin;
  /** Free-form correlation id stamped on the prompt event. */
  originId?: string;
  /**
   * Per-chunk callback. Called on every `response.text` event with non-empty
   * text, except the JSONL tailer's echo of the turn's raw text (#217).
   */
  onChunk?: (text: string) => void;
  /**
   * Hard ceiling on how long to wait for `intent: "final"`. Defaults to
   * 5 minutes — claude turns under bus can be long-running. Returns
   * with `ok: false` and whatever was accumulated when the timeout fires.
   */
  timeoutMs?: number;
  /**
   * Receipt store to record per-prompt observability into. Defaults to the
   * process-wide singleton (`getDefaultReceiptStore`). Override is for tests.
   */
  receiptStore?: ReceiptStore;
  /**
   * Restart-based session rotation hook (#227). When the per-agent message/age
   * threshold trips after a successful turn, the bridge calls this to drop the
   * live PTY and respawn it on a fresh session id (`restart()`, #226), which is
   * what actually rotates the live bus conversation. Injected by the daemon
   * (it owns the SessionManager — `BusRuntimeHandle.rotateAgent`). When omitted
   * (early boot / tests / webui without a SessionManager) the bridge falls back
   * to a WARN, the pre-#227 behaviour. Awaited so the next prompt (serialized
   * on the same per-agent slot) lands on the fresh PTY.
   */
  rotateAgent?: (agentId: string) => Promise<void>;
  /** #390: override of the reconnect grace before the no-MCP warning (tests). */
  ipcWarningGraceMs?: number;
  /** #454: override of the 5 s cap on the minimum reply budget (tests). */
  minReplyBudgetCapMs?: number;
  /**
   * #436: called once when the turn this prompt started is over — which the
   * returned promise does not say: it resolves on the reply or on `timeoutMs`,
   * and the timeout ends the WAIT, not the turn. Fires on that turn's
   * `response.turn_end` (matched by `promise_id`, not flagged ambiguous, and
   * the agent no longer busy — else once it goes idle), at once when no turn
   * will run (send failed, prompt withdrawn from the
   * queue), and at `turnSettleCeilingMs` at the latest. Never called before
   * the returned promise resolves.
   */
  onTurnSettled?: (reason: TurnSettleReason) => void;
  /** #436: latest the turn-settled callback fires. Default 30 minutes. */
  turnSettleCeilingMs?: number;
  /** #436: idle-poll interval after a turn_end seen while the agent was busy (tests). */
  turnSettlePollMs?: number;
}

export type TurnSettleReason = "turn_end" | "idle" | "no_turn" | "ceiling";

export interface BusPromptResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
  /** The final was the #215 safety net's raw turn text, not a `reply` call. */
  synthesized?: boolean;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TURN_SETTLE_CEILING_MS = 30 * 60 * 1000;
const DEFAULT_TURN_SETTLE_POLL_MS = 5_000;
/**
 * #390: how long a prompt sent with no MCP connection waits before the
 * dashboard is told. A fresh spawn, a restart or a #227 rotation delivers the
 * prompt to the PTY before the MCP server's `hello` lands, and the reply then
 * comes through the connection that arrived in between — that window is the
 * reconciler's confirm delay, so the warning re-checks the connection after
 * the same 5 s instead of crying wolf on every restart.
 */
const IPC_WARNING_GRACE_MS = 5_000;
/**
 * #454: a caller that gets the lock with less than a tenth of its budget left,
 * capped at 5 s, gives up unsent. Sending would start a turn whose reply the
 * caller stops waiting for a moment later — on an idle agent the prompt is
 * admitted at once and cannot be withdrawn, so the turn runs for no one.
 */
const MIN_REPLY_BUDGET_FRACTION = 0.1;
const MIN_REPLY_BUDGET_CAP_MS = 5_000;
/** Largest delay `setTimeout` honours; above it the timer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Send a prompt through the bus to one agent and resolve with the
 * accumulated reply.
 *
 * Subscribes to `response.text` events for the target agent, streams
 * any text via `onChunk` (if provided), and resolves with the
 * accumulated text on `intent: "final"`. Cleans up its subscriber and
 * timer before resolving so callers don't leak listeners.
 *
 * In the common case claude emits ONE event with `intent: "final"`
 * containing the full reply. The accumulator + chunk callback also
 * cover any future progress-streaming behaviour without changing the
 * caller contract.
 *
 * Failure paths:
 *   - The agent's lock (another web-UI prompt) is still held when the
 *     timeout runs out, or frees with too little of it left (#454) →
 *     resolves `{ok:false, error}` without sending the prompt.
 *   - `bus.sendPrompt` rejects → resolves `{ok:false, error}` immediately.
 *   - Timeout fires before `final` lands → resolves with whatever was
 *     accumulated so far + `exitCode: 1` + error message.
 */
export async function streamBusPrompt(
  bus: BusCore,
  agentId: string,
  message: string,
  opts: StreamBusPromptOptions = {},
): Promise<BusPromptResult> {
  // Serialize per-agent so the unfiltered `response.text` subscriber
  // below can't pick up a reply meant for an earlier in-flight prompt.
  // The mutex tail is a Promise that the previous call resolves when
  // it finishes; this call awaits it before sending its own prompt.
  // Callers race each other only on which one enters the queue first,
  // not on which reply they consume.
  const prev = agentMutex.get(agentId);
  let release: () => void = () => undefined;
  const slot = new Promise<void>((res) => {
    release = res;
  });
  agentMutex.set(agentId, slot);
  // #454: the caller's timeout covers the wait for this lock too, not only
  // the reply wait in `runPrompt`. The receipt opens now, so `received_at`
  // is when the request arrived and its duration includes the lock wait.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const arrivedAt = Date.now();
  const receipt = openPromptReceipt(agentId, opts);
  if (prev) {
    const acquired = await waitForLock(prev, timeoutMs);
    const lockWaitMs = Date.now() - arrivedAt;
    const minReplyMs = Math.min(
      timeoutMs * MIN_REPLY_BUDGET_FRACTION,
      opts.minReplyBudgetCapMs ?? MIN_REPLY_BUDGET_CAP_MS,
    );
    if (!acquired || timeoutMs - lockWaitMs < minReplyMs) {
      // Give up without sending. Our slot stays held until `prev` settles,
      // so a caller queued behind us still waits for the one actually running.
      void prev.then(
        () => releaseSlot(agentId, slot, release),
        () => releaseSlot(agentId, slot, release),
      );
      void receipt.close("timeout", {
        reason: "bridge_lock_wait_exceeded",
        stage: "bridge_lock",
        timeout_ms: timeoutMs,
        lock_wait_ms: lockWaitMs,
      });
      if (opts.onTurnSettled) {
        const onSettled = opts.onTurnSettled;
        setTimeout(() => {
          try {
            onSettled("no_turn");
          } catch {
            /* a settle callback error must not escape into the bus */
          }
        }, 0);
      }
      return {
        ok: false,
        output: "",
        exitCode: 1,
        error:
          `timed out after ${timeoutMs}ms waiting for agent ${agentId}: ` +
          `busy with another web-UI prompt, this one was not sent`,
      };
    }
    receipt.patch({ notes: { ...receipt.record.notes, lock_wait_ms: lockWaitMs } });
  }
  // #436: the turn-settled watcher is armed here, at the outer boundary,
  // after the rotation work below — never before this function's promise.
  const settleArm: { arm?: () => void } = {};
  try {
    const result = await runPrompt(bus, agentId, message, opts, receipt, {
      timeoutMs,
      remainingMs: timeoutMs - (Date.now() - arrivedAt),
      settleArm,
    });
    if (result.ok) {
      // Per-agent turn accounting for #213, scoped to the named agent's
      // own `session.json` (the long-lived PTY session) rather than the
      // global bootstrap tracker. Best-effort: a tracking failure must
      // never break the prompt the caller is awaiting.
      //
      // #227: when the threshold trips we now perform RESTART-BASED rotation
      // via the injected `rotateAgent` hook — restart() drops the live PTY and
      // respawns it on a fresh session id, which is the only thing that
      // actually rotates a live bus conversation (filesystem rotation alone
      // keeps the same process + id alive). Without the hook (early boot /
      // tests / no SessionManager) we keep the pre-#227 WARN.
      try {
        await incrementMessageCount(agentId);
        let sessionConfig: ReturnType<typeof getSettings>["session"] | null = null;
        try {
          sessionConfig = getSettings().session;
        } catch {
          /* settings not loaded yet (early boot / tests) — skip the gate */
        }
        if (sessionConfig?.autoRotate) {
          const peeked = await peekSession(agentId);
          if (peeked && needsRotation(peeked, sessionConfig)) {
            if (opts.rotateAgent) {
              await opts.rotateAgent(agentId);
              console.log(
                `[${new Date().toLocaleTimeString()}] [bus] agent=${agentId} session rotated ` +
                  `(${peeked.messageCount ?? 0} msgs >= ${sessionConfig.maxMessages}) — ` +
                  `fresh PTY + session id; next prompt lands on the new session.`,
              );
            } else {
              console.warn(
                `[${new Date().toLocaleTimeString()}] [bus] agent=${agentId} session needs rotation ` +
                  `(${peeked.messageCount ?? 0} msgs >= ${sessionConfig.maxMessages}) — ` +
                  `no rotateAgent hook injected; rotation skipped.`,
              );
            }
          }
        }
      } catch (e) {
        console.error(`[${new Date().toLocaleTimeString()}] bus rotation tracking failed:`, e);
      }
    }
    return result;
  } finally {
    releaseSlot(agentId, slot, release);
    settleArm.arm?.();
  }
}

/**
 * #454: wait for the previous holder of the agent's lock, at most `timeoutMs`.
 * Resolves `false` when the deadline wins. An upstream error still counts as
 * released — it doesn't block our own attempt.
 */
function waitForLock(prev: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, MAX_TIMER_MS));
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    prev.then(done, done);
  });
}

function releaseSlot(agentId: string, slot: Promise<void>, release: () => void): void {
  // Only clear the tail slot if no other call has chained onto us;
  // chained callers will overwrite the map entry themselves.
  if (agentMutex.get(agentId) === slot) agentMutex.delete(agentId);
  release();
}

/**
 * Receipt: open at entry so the prompt is *visible* from the first byte of
 * bridge work. `message_id` includes a short nonce so concurrent calls sharing
 * the same `origin_id` (e.g. two webui chats) don't collide on the receipt
 * store's `message_id` index. The `prompt_hash` — the index the bus → PTY seam
 * uses to back-fill PID/generation/cwd — is stamped by `runPrompt` once the
 * lock is ours, so a prompt still waiting (or never sent) is not found there.
 */
function openPromptReceipt(agentId: string, opts: StreamBusPromptOptions) {
  const origin = opts.origin ?? "webui";
  const originId = opts.originId ?? "webui";
  const store = opts.receiptStore ?? getDefaultReceiptStore();
  const messageId = `${origin}:${originId}:${randomBytes(4).toString("hex")}`;
  return store.open(messageId, {
    selected_route: `agent=${agentId}`,
    agent_id: agentId,
    notes: { origin, origin_id: originId },
  });
}

function runPrompt(
  bus: BusCore,
  agentId: string,
  message: string,
  opts: StreamBusPromptOptions,
  receipt: ReturnType<typeof openPromptReceipt>,
  budget: {
    /** The caller's whole budget, reported in the error and on the receipt. */
    timeoutMs: number;
    /** What is left of it once the lock is ours (#454). */
    remainingMs: number;
    settleArm: { arm?: () => void };
  },
): Promise<BusPromptResult> {
  const { timeoutMs, remainingMs, settleArm } = budget;
  const origin = opts.origin ?? "webui";
  const originId = opts.originId ?? "webui";
  receipt.patch({ prompt_hash: hashPrompt(message) });
  let accumulated = "";
  return new Promise<BusPromptResult>((resolve) => {
    let resolved = false;
    let ipcWarningTimer: ReturnType<typeof setTimeout> | null = null;
    // #436: the turn outlives the wait when the wait times out. `noTurn` is
    // set when no turn will ever run for this prompt.
    let noTurn = false;
    const finish = (
      r: BusPromptResult,
      finalState: "turn_observed" | "timeout" | "wedged_prompt",
      notes?: Record<string, unknown>,
    ) => {
      if (resolved) return;
      resolved = true;
      try {
        sub.close();
      } catch {
        /* idempotent close — fine */
      }
      clearTimeout(timer);
      if (ipcWarningTimer) clearTimeout(ipcWarningTimer);
      // Close the receipt before resolving — best-effort, never throws.
      // We don't await here because the caller (e.g. dashboard SSE)
      // shouldn't block on a disk write, but the store appends serially
      // so observers see the line within a tick.
      void receipt.close(finalState, notes);
      resolve(r);
      if (settle) settleArm.arm = settle.arm;
    };
    // #239: the bus may queue this prompt behind another chat's running turn,
    // so that turn's final reliably lands on this agent-wide subscription
    // before our own turn has even started. Nothing before our own `prompt`
    // event (published on admission, carrying our origin and text) is ours.
    // Within our turn the first `final` resolves as before — including one
    // the agent names for another chat (#224).
    let promiseId: string | null = null;
    let admitted = false;
    const settle = opts.onTurnSettled ? watchTurnSettled() : null;
    const sub = bus.subscribe(
      { agent_id: agentId, topics: ["prompt", "response.text"] },
      (event) => {
        if (event.topic === "prompt") {
          const p = event.payload as { origin?: string; origin_id?: string; text?: string };
          if (
            (promiseId !== null && event.promise_id === promiseId) ||
            (p.origin === origin && p.origin_id === originId && p.text === message)
          ) {
            admitted = true;
          }
          return;
        }
        if (!admitted) return;
        // #217: the JSONL tailer echoes each text block of the turn for
        // observability; what the agent sends comes through `reply`. Skip the
        // echo as the chat adapters do, or a caller relaying `output` (an
        // inject pushed to Telegram) sends the agent's working notes glued in
        // front of its reply.
        if (isTailerOriginEvent(event)) return;
        const payload = event.payload as { text?: string; intent?: string; synthesized?: true };
        if (typeof payload.text === "string" && payload.text.length > 0) {
          accumulated += payload.text;
          if (opts.onChunk) {
            try {
              opts.onChunk(payload.text);
            } catch {
              /* chunk callback errors must not break the prompt flow */
            }
          }
        }
        if (payload.intent === "final") {
          finish(
            {
              ok: true,
              output: accumulated || (payload.text ?? ""),
              exitCode: 0,
              ...(payload.synthesized ? { synthesized: true } : {}),
            },
            "turn_observed",
            { output_chars: accumulated.length },
          );
        }
      },
    );
    const timer = setTimeout(
      () => {
        // #239: a prompt still waiting in the bus queue when its caller gives up
        // would run later with no listener — its reply lost, the turn wasted.
        if (promiseId !== null && !admitted && bus.withdrawQueuedPrompt?.(agentId, promiseId)) {
          noTurn = true;
        }
        finish(
          {
            ok: false,
            output: accumulated,
            exitCode: 1,
            error: `timed out after ${timeoutMs}ms waiting for agent ${agentId} reply`,
          },
          "timeout",
          {
            reason: "no_final_reply_within_timeout",
            timeout_ms: timeoutMs,
            accumulated_chars: accumulated.length,
          },
        );
      },
      Math.min(remainingMs, MAX_TIMER_MS),
    );
    bus
      .sendPrompt({
        agent_id: agentId,
        origin,
        origin_id: originId,
        user_id: "webui",
        text: message,
      })
      .then((ack) => {
        promiseId = ack.promise_id;
        if (!ack.queued) admitted = true; // admitted directly (its prompt event already passed)
        // A fast `final` or the timeout may already have settled the prompt.
        if (resolved) return;
        // The bus accepted the prompt — the route was resolvable. We
        // don't yet know whether the PTY actually accepted it (that's
        // stamped by `runtime-mount.ts` via prompt_hash lookup), but
        // we can confirm the bus seam is unblocked.
        const notes: Record<string, unknown> = { ...receipt.record.notes, bus_send_ok: true };
        // #390: the bus knew at send time that the agent has no MCP
        // connection — the prompt went to the PTY only and the agent's
        // `reply` tool has no way back. Without this the dashboard sat
        // silent until the 5-minute timeout while the daemon log already
        // said `[bus-ipc] send-failed`. Note it on the receipt now; tell the
        // dashboard after the reconnect grace, and only if the connection is
        // still missing then. Keep waiting either way: the transcript-driven
        // turn_end path can still deliver.
        if (ack.ipc_sent === false) {
          notes.ipc_sent = false;
          if (opts.onChunk) {
            const graceMs = opts.ipcWarningGraceMs ?? IPC_WARNING_GRACE_MS;
            ipcWarningTimer = setTimeout(() => {
              ipcWarningTimer = null;
              if (resolved || bus.hasIpcConnection?.(agentId) === true) return;
              try {
                opts.onChunk?.(
                  `\n[chat warning: agent ${agentId} still has no MCP connection ` +
                    `${graceMs / 1000}s after the prompt — it reached the agent's ` +
                    `terminal but the reply channel is down (reconcile armed). If no reply ` +
                    `follows, check the daemon log for [bus-ipc] send-failed and [boot-dialog].]\n`,
                );
              } catch {
                /* chunk callback errors must not break the prompt flow */
              }
            }, graceMs);
          }
        }
        receipt.patch({ notes });
      })
      .catch((err) => {
        noTurn = true;
        finish(
          {
            ok: false,
            output: accumulated,
            exitCode: 1,
            error: err instanceof Error ? err.message : String(err),
          },
          "wedged_prompt",
          { error: err instanceof Error ? err.message : String(err), stage: "bus_send_prompt" },
        );
      });

    /**
     * #436: tell the caller when the turn is over. Subscribed from the start
     * so this prompt's admission and turn_end are seen even when they land
     * after the wait gave up; the callback itself waits for `arm()` (the
     * wait's resolution), so a caller never hears "settled" before its result.
     */
    function watchTurnSettled() {
      const ceilingMs = opts.turnSettleCeilingMs ?? DEFAULT_TURN_SETTLE_CEILING_MS;
      const pollMs = opts.turnSettlePollMs ?? DEFAULT_TURN_SETTLE_POLL_MS;
      let seen: TurnSettleReason | null = null;
      let armed = false;
      let done = false;
      let idlePolls = 0;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
      const watchSub = bus.subscribe(
        { agent_id: agentId, topics: ["prompt", "response.turn_end"] },
        (event) => {
          if (event.topic === "prompt") {
            const p = event.payload as { origin?: string; origin_id?: string; text?: string };
            if (
              (promiseId !== null && event.promise_id === promiseId) ||
              (p.origin === origin && p.origin_id === originId && p.text === message)
            ) {
              admitted = true;
            }
            return;
          }
          // Ours only when stamped with our id AND not flagged ambiguous: a
          // released earlier turn's late turn_end is stamped with the id of
          // whatever holds the slot now — possibly us, before we even started.
          const amb = (event as { correlation_ambiguous?: boolean }).correlation_ambiguous;
          if (promiseId !== null && event.promise_id === promiseId && amb !== true) {
            seen = "turn_end";
            if (armed) setTimeout(onOwnTurnEnd, 0);
          }
        },
      );
      const fire = (reason: TurnSettleReason) => {
        if (done) return;
        done = true;
        try {
          watchSub.close();
        } catch {
          /* idempotent close — fine */
        }
        if (pollTimer) clearInterval(pollTimer);
        if (ceilingTimer) clearTimeout(ceilingTimer);
        try {
          opts.onTurnSettled?.(reason);
        } catch {
          /* a settle callback error must not escape into the bus */
        }
      };
      const idle = () => {
        const busy = bus.busyAgents?.() ?? bus.activeTurnAgents();
        return !busy.includes(agentId);
      };
      // A turn_end of ours with the agent still busy (another prompt queued,
      // or a mis-stamped terminator that slipped past the flag) is not trusted
      // alone: the idle polls decide.
      const onOwnTurnEnd = () => {
        if (idle()) fire("turn_end");
      };
      return {
        arm() {
          if (armed) return;
          armed = true;
          // Deferred one tick: the caller handles its result before it hears
          // the turn is over.
          if (seen) setTimeout(onOwnTurnEnd, 0);
          if (noTurn) {
            setTimeout(() => fire("no_turn"), 0);
            return;
          }
          ceilingTimer = setTimeout(() => fire("ceiling"), ceilingMs);
          // After our own turn_end with the agent still busy, wait for it to go
          // idle. Idleness alone is not an end: the bus releases a slow turn's
          // busy state at its turn deadline while the turn may still run, so a
          // turn with no turn_end (crash, restart) settles at the ceiling, or
          // at daemon shutdown through the caller.
          pollTimer = setInterval(() => {
            if (noTurn) return fire("no_turn");
            if (seen && idle()) {
              if (++idlePolls >= 2) fire("idle");
            } else {
              idlePolls = 0;
            }
          }, pollMs);
          (ceilingTimer as { unref?: () => void }).unref?.();
          (pollTimer as { unref?: () => void }).unref?.();
        },
      };
    }
  });
}
