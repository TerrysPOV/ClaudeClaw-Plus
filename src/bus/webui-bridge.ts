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
 * Receipt chain (issue #207): every call opens a receipt at entry, stamps
 * `route_resolved` + `prompt_hash` immediately, and closes on the terminal
 * state (`turn_observed` on final, `timeout` on timer, `wedged_prompt` on
 * `bus.sendPrompt` rejection). The bus → PTY seam in `runtime-mount.ts`
 * back-fills `process_pid`/`process_generation`/`agent_cwd` + stamps
 * `stdin_written` via `findByPromptHash`. Receipts land at
 * `~/.claude/claudeclaw/receipts.jsonl` (0600).
 */

import { randomBytes } from "node:crypto";
import type { BusCore } from "./core";
import { getDefaultReceiptStore, hashPrompt, type ReceiptStore } from "./receipt";
import type { BusOrigin } from "./types";
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
 * would block a follow-up chat. Acceptable: BusScheduler doesn't go
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
  /** Per-chunk callback. Called on every `response.text` event with non-empty text. */
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
}

export interface BusPromptResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

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
  if (prev) {
    try {
      await prev;
    } catch {
      /* upstream errors don't block our own attempt */
    }
  }
  try {
    const result = await runPrompt(bus, agentId, message, opts);
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
    // Only clear the tail slot if no other call has chained onto us;
    // chained callers will overwrite the map entry themselves.
    if (agentMutex.get(agentId) === slot) agentMutex.delete(agentId);
    release();
  }
}

function runPrompt(
  bus: BusCore,
  agentId: string,
  message: string,
  opts: StreamBusPromptOptions,
): Promise<BusPromptResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const origin = opts.origin ?? "webui";
  const originId = opts.originId ?? "webui";
  // Receipt: open at entry so the prompt is *visible* from the first byte
  // of bridge work. `message_id` includes a short nonce so concurrent calls
  // sharing the same `origin_id` (e.g. two webui chats) don't collide on
  // the receipt store's `message_id` index. The `prompt_hash` index, by
  // contrast, is keyed on the prompt text and is what the bus → PTY seam
  // uses to back-fill PID/generation/cwd.
  const store = opts.receiptStore ?? getDefaultReceiptStore();
  const messageId = `${origin}:${originId}:${randomBytes(4).toString("hex")}`;
  const prompt_hash = hashPrompt(message);
  const receipt = store.open(messageId, {
    selected_route: `agent=${agentId}`,
    agent_id: agentId,
    prompt_hash,
    notes: { origin, origin_id: originId },
  });
  let accumulated = "";
  return new Promise<BusPromptResult>((resolve) => {
    let resolved = false;
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
      // Close the receipt before resolving — best-effort, never throws.
      // We don't await here because the caller (e.g. dashboard SSE)
      // shouldn't block on a disk write, but the store appends serially
      // so observers see the line within a tick.
      void receipt.close(finalState, notes);
      resolve(r);
    };
    const sub = bus.subscribe({ agent_id: agentId, topics: ["response.text"] }, (event) => {
      const payload = event.payload as { text?: string; intent?: string };
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
          },
          "turn_observed",
          { output_chars: accumulated.length },
        );
      }
    });
    const timer = setTimeout(() => {
      finish(
        {
          ok: false,
          output: accumulated,
          exitCode: 1,
          error: `timed out after ${timeoutMs}ms waiting for agent ${agentId} reply`,
        },
        "timeout",
        { timeout_ms: timeoutMs, accumulated_chars: accumulated.length },
      );
    }, timeoutMs);
    bus
      .sendPrompt({
        agent_id: agentId,
        origin,
        origin_id: originId,
        user_id: "webui",
        text: message,
      })
      .then(() => {
        // The bus accepted the prompt — the route was resolvable. We
        // don't yet know whether the PTY actually accepted it (that's
        // stamped by `runtime-mount.ts` via prompt_hash lookup), but
        // we can confirm the bus seam is unblocked.
        receipt.patch({ notes: { ...receipt.record.notes, bus_send_ok: true } });
      })
      .catch((err) => {
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
  });
}
