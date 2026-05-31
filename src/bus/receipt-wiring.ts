/**
 * Bus → PTY receipt wiring for the daemon entry point (issue #207).
 *
 * Extracted from `runtime-mount.ts` so the back-filling logic — looking up
 * an open receipt by prompt hash, stamping pid / generation / stdin_written,
 * and rolling back to `stale_session` on PTY error — can be unit-tested
 * without booting the full bus runtime.
 */
import { getDefaultReceiptStore, hashPrompt, type ReceiptStore } from "./receipt";

/** Structural view of the bits an `AgentProcess` exposes that we touch.
 *  Declared here so the helper doesn't drag in `session-agent-process.ts`. */
export interface AgentProcessLike {
  readonly pid: number;
  send_prompt_stream?(line: string): Promise<void>;
}

export type StreamPromptHandler = (agent_id: string, text: string) => Promise<void>;

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
 *   4. Writes the prompt; on success, stamps `stdin_written_at`. On failure,
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

  return async (agent_id: string, text: string): Promise<void> => {
    const proc = getAgent(agent_id);
    const receipt = store.findByPromptHash(hashPrompt(text));

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
        await proc.send_prompt_stream(text);
        if (receipt) {
          receipt.patch({
            notes: { ...receipt.record.notes, stdin_written_at: now().toISOString() },
          });
        }
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
