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
 */

import type { BusCore } from "./core";
import type { BusOrigin } from "./types";

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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  let accumulated = "";
  return new Promise<BusPromptResult>((resolve) => {
    let resolved = false;
    const finish = (r: BusPromptResult) => {
      if (resolved) return;
      resolved = true;
      try {
        sub.close();
      } catch {
        /* idempotent close — fine */
      }
      clearTimeout(timer);
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
        finish({
          ok: true,
          output: accumulated || (payload.text ?? ""),
          exitCode: 0,
        });
      }
    });
    const timer = setTimeout(() => {
      finish({
        ok: false,
        output: accumulated,
        exitCode: 1,
        error: `timed out after ${timeoutMs}ms waiting for agent ${agentId} reply`,
      });
    }, timeoutMs);
    bus
      .sendPrompt({
        agent_id: agentId,
        origin: opts.origin ?? "webui",
        origin_id: opts.originId ?? "webui",
        user_id: "webui",
        text: message,
      })
      .catch((err) => {
        finish({
          ok: false,
          output: accumulated,
          exitCode: 1,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}
