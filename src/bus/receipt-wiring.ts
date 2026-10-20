/**
 * Bus → PTY receipt wiring for the daemon entry point (issue #207).
 *
 * Extracted from `runtime-mount.ts` so the back-filling logic — looking up
 * an open receipt by prompt hash, stamping pid / generation / stdin_written,
 * and rolling back to `stale_session` on PTY error — can be unit-tested
 * without booting the full bus runtime.
 */
import { getDefaultReceiptStore, hashPrompt, type OpenReceipt, type ReceiptStore } from "./receipt";
import type { TurnObservation } from "./jsonl-line-types";
import type { BusOrigin, PromptDeliveryOutcome, SupervisionMode } from "./types";

/**
 * Recover the original prompt text from the `<channel source=... chat_id=...
 * user_id=... ts=...>TEXT</channel>` wrapper that `BusCoreImpl.sendPrompt`
 * adds before invoking `streamPromptHandler`. Returns the inner text with
 * XML entities reversed so its `hashPrompt` matches the one the caller
 * computed on the raw prompt at receipt-open time.
 *
 * Idempotent for non-wrapped input — direct callers (no bus wrapper) get
 * their text back unchanged.
 */
export function unwrapChannelText(text: string): string {
  const m = text.match(/^<channel\s[^>]*>([\s\S]*)<\/channel>$/);
  if (!m) return text;
  // Reverse `escapeXmlText` from `bus/core.ts`: text-mode escaping only
  // covers `&`, `<`, `>`. Decode in reverse application order so an
  // already-encoded `&amp;` isn't double-unescaped.
  return m[1].replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

export interface OpenInboundReceiptParams {
  /** Adapter-side id, e.g. `tg-<update_id>`, `discord-<msg_id>`, `webui:inject:<nonce>`. */
  messageId: string;
  agentId: string;
  /** The RAW prompt text, hashed BEFORE the bus's `<channel ...>` wrapper is
   *  applied. The bus -> PTY seam unwraps the channel block before hashing
   *  (see `unwrapChannelText`), so hashing the raw text here keeps
   *  `findByPromptHash` hitting the same receipt. */
  rawText: string;
  origin: BusOrigin;
  originId: string;
  store?: ReceiptStore;
}

/**
 * Open an inbound receipt at the adapter boundary (the `message_polled`
 * surface), mirroring the open in `webui-bridge.ts`. Adapters and
 * `/api/inject` call `bus.sendPrompt` directly, bypassing `streamBusPrompt`,
 * so without this they never open a receipt and #207's headline symptom
 * (intermittent Telegram "no reply") stays uninstrumented. The returned
 * `OpenReceipt` is closed by the caller when it observes the outbound reply
 * (`turn_observed`) or when its own timeout fires (`timeout`).
 */
export function openInboundReceipt(params: OpenInboundReceiptParams): OpenReceipt {
  const store = params.store ?? getDefaultReceiptStore();
  return store.open(params.messageId, {
    selected_route: `agent=${params.agentId}`,
    agent_id: params.agentId,
    prompt_hash: hashPrompt(params.rawText),
    notes: { origin: params.origin, origin_id: params.originId },
  });
}

/** Structural view of the bits an `AgentProcess` exposes that we touch.
 *  Declared here so the helper doesn't drag in `session-agent-process.ts`. */
/**
 * #212: tailer → receipt seam. The tailer hands over the prompt text as the CLI
 * recorded it — the `<channel …>` wrapper the bus added around the surface's
 * text — so the hash is taken on the unwrapped inner text, the same key the
 * adapter opened the receipt with and the PTY seam patches it by.
 * Synthetic boundaries (a CLI-written API error) are not a model turn and are
 * not recorded as one. Never throws: the tailer must keep going.
 */
export function confirmTurnReceipt(
  observation: TurnObservation,
  store: ReceiptStore = getDefaultReceiptStore(),
): Promise<"patched" | "side-table" | "unknown" | "skipped"> {
  if (observation.synthetic) return Promise.resolve("skipped");
  return store
    .confirmTurn(hashPrompt(unwrapChannelText(observation.promptText)), {
      claude_jsonl_path: observation.jsonlPath,
      turn_event_offset: observation.offset,
      message_id: observation.messageId,
    })
    .catch(() => "unknown" as const);
}

export interface AgentProcessLike {
  readonly pid: number;
  /** Both real `AgentProcess` classes set it; fakes may omit it (treated as streamable). */
  readonly supervision?: SupervisionMode;
  send_prompt_stream?(line: string): Promise<PromptDeliveryOutcome | void>;
}

/**
 * Supervision modes whose `send_prompt_stream` does not reject.
 * `ChildAgentProcess` exposes the method in every mode but rejects it unless
 * the mode is `process-stream-json` (`session-agent-process.ts`), so a
 * `process` / `tmux` agent is NOT streamable: the IPC `prompt` frame is its
 * only delivery (#428).
 */
const STREAMABLE_SUPERVISION: ReadonlySet<SupervisionMode> = new Set([
  "pty-stdin",
  "process-stream-json",
]);

/**
 * Build the `PtyReachableCheck` (`core.ts`) the bus consults before it skips
 * the IPC `prompt` frame (#428: deliver each prompt once). Reachable means
 * registered, exposing `send_prompt_stream`, and in a supervision mode that
 * method serves. The daemon wires it with
 * `bus.setPtyReachableHandler(canStreamToAgent(getAgent))` alongside
 * `setStreamPromptHandler`.
 */
export function canStreamToAgent(
  getAgent: (agent_id: string) => AgentProcessLike | undefined,
): (agent_id: string) => boolean {
  return (agent_id) => {
    const proc = getAgent(agent_id);
    return (
      !!proc &&
      typeof proc.send_prompt_stream === "function" &&
      (proc.supervision === undefined || STREAMABLE_SUPERVISION.has(proc.supervision))
    );
  };
}

/** Resolves with the process's delivery verdict when it reports one (issue
 *  #361), so the bus can act on a give-up instead of assuming success. */
export type StreamPromptHandler = (
  agent_id: string,
  text: string,
) => Promise<PromptDeliveryOutcome | void>;

export interface PromptStreamHandlerOptions {
  /** Receipt store to back-fill into. Defaults to the process-wide singleton. */
  store?: ReceiptStore;
  /** Clock seam for tests (used to stamp `route_resolved_at`/`stdin_written_at`). */
  now?: () => Date;
}

/**
 * Build the `StreamPromptHandler` that the daemon installs via
 * `bus.setStreamPromptHandler(...)`. The handler:
 *
 *   1. Locates the agent process via `getAgent(agent_id)`.
 *   2. Looks up an open receipt by `hashPrompt(text)`.
 *   3. If both present, stamps `process_pid`, `process_generation`,
 *      `route_resolved_at` BEFORE writing to the PTY.
 *   4. Writes the prompt; on success, stamps `stdin_written_at` — and
 *      `delivery_outcome` when the process reports one (issue #361), so a
 *      receipt that later times out says the PTY layer gave up rather than
 *      looking like a delivery that simply went unanswered (a bus
 *      re-delivery's verdict lands in `redelivery_outcome`, the first one is
 *      kept). On failure,
 *      closes the receipt as `stale_session` so the cause is visible in the
 *      receipts log (the caller can still close it later — `close` is
 *      idempotent).
 *   5. If no agent process is registered (or it doesn't expose
 *      `send_prompt_stream`), closes the receipt as `stale_session`.
 *
 * `process_generation` bumps each time the same `agent_id` is observed with
 * a different pid (proxy for SessionManager respawns).
 */
export function createPromptStreamHandler(
  getAgent: (agent_id: string) => AgentProcessLike | undefined,
  opts: PromptStreamHandlerOptions = {},
): StreamPromptHandler {
  const store = opts.store ?? getDefaultReceiptStore();
  const now = opts.now ?? (() => new Date());
  const generationByAgent = new Map<string, { pid: number; gen: number }>();

  return async (agent_id: string, text: string): Promise<PromptDeliveryOutcome | void> => {
    const proc = getAgent(agent_id);
    // `BusCoreImpl.sendPrompt` wraps the prompt in a `<channel ...>...</channel>`
    // block before invoking us, so the receipt — keyed on the *raw* prompt at
    // open time — is found by hashing the unwrapped inner text. Plain
    // (unwrapped) callers fall through unchanged.
    const receipt = store.findByPromptHash(hashPrompt(unwrapChannelText(text)));

    if (proc && typeof proc.send_prompt_stream === "function") {
      if (receipt) {
        let gen = 1;
        const tracked = generationByAgent.get(agent_id);
        if (tracked && tracked.pid === proc.pid) {
          gen = tracked.gen;
        } else {
          gen = (tracked?.gen ?? 0) + 1;
          generationByAgent.set(agent_id, { pid: proc.pid, gen });
        }
        receipt.patch({
          process_pid: proc.pid,
          process_generation: gen,
          notes: { ...receipt.record.notes, route_resolved_at: now().toISOString() },
        });
      }
      try {
        const outcome = await proc.send_prompt_stream(text);
        if (receipt) {
          // A bus re-delivery (#361) comes back through this same handler and
          // finds the same open receipt: keep the first verdict, record the
          // retry's under its own key, so a give-up followed by a clean retry
          // still reads as "re-delivered", not as a first-try success.
          const outcomeKey =
            receipt.record.notes?.delivery_outcome === undefined
              ? "delivery_outcome"
              : "redelivery_outcome";
          receipt.patch({
            notes: {
              ...receipt.record.notes,
              stdin_written_at: now().toISOString(),
              ...(typeof outcome === "string" ? { [outcomeKey]: outcome } : {}),
            },
          });
        }
        return outcome;
      } catch (err) {
        // PTY write failed — `stale_session` reflects "the process was
        // there when we checked but rejected the write". The caller
        // (`streamBusPrompt`) will still close on timeout/error; close
        // here as a stronger signal so the receipts log carries the
        // PTY-side cause rather than an opaque timeout.
        if (receipt) {
          await receipt.close("stale_session", {
            error: err instanceof Error ? err.message : String(err),
            stage: "pty_write",
          });
        }
        throw err;
      }
    } else if (receipt) {
      // No process registered (or it doesn't support streaming). The
      // bus seam can't proceed — record `stale_session` so the wedge
      // is visible.
      await receipt.close("stale_session", {
        reason: proc ? "no_send_prompt_stream" : "agent_not_registered",
      });
    }
  };
}
