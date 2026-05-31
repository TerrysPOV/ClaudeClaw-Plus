/**
 * Per-message receipt chain for the bus path (issue #207).
 *
 * A `Receipt` opens when an inbound message enters the bus and accumulates
 * stamps as the message moves through the pipeline:
 *
 *     message_polled → route_resolved → stdin_written → turn_observed
 *                                                       (or wedged_prompt)
 *
 * Each receipt closes on a terminal `final_state` and is appended as one JSON
 * line to `~/.claude/claudeclaw/receipts.jsonl` for offline analysis. The goal
 * is to make intermittent agent wedges *visible* — distinguishing between
 * "prompt never reached agent" / "agent never generated a turn" / "tailer never
 * observed it" — without needing to instrument at debug time.
 *
 * Failures (filesystem errors, malformed state) are surfaced through
 * `onError` and never thrown — instrumentation must not break the bus.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Terminal states a receipt can land on. The first four are normal flow;
 *  the rest are failure surfaces we want to make countable. */
export type ReceiptFinalState =
  | "message_polled"
  | "route_resolved"
  | "stdin_written"
  | "turn_observed"
  | "wedged_prompt"
  | "stale_session"
  | "timeout";

export interface ReceiptRecord {
  /** Adapter-side identifier (e.g. `tg-<update_id>`, `discord-<msg_id>`). */
  message_id: string;
  /** ISO timestamp the receipt opened. */
  received_at: string;
  selected_route?: string;
  agent_id?: string;
  session_id?: string;
  agent_cwd?: string;
  process_pid?: number;
  /** Bumps each time the agent process is respawned for the same `agent_id`. */
  process_generation?: number;
  /** Short SHA256 of the prompt text — proves what went in without storing it. */
  prompt_hash?: string;
  /** Path the `JsonlTailer` is watching for this session's turns. */
  claude_jsonl_path?: string;
  /** Byte offset of the observed `turn_duration` event in the JSONL (when matched). */
  turn_event_offset?: number | null;
  final_state: ReceiptFinalState;
  /** Milliseconds from `received_at` to `final_state`. */
  duration_ms?: number;
  /** Free-form per-stamp notes (e.g. error kind on `timeout`). */
  notes?: Record<string, unknown>;
}

export interface OpenReceipt {
  readonly message_id: string;
  /** Snapshot of the in-progress record (callers should not mutate). */
  readonly record: Readonly<ReceiptRecord>;
  /** Merge fields into the in-progress record. Idempotent for repeated keys. */
  patch(fields: Partial<ReceiptRecord>): void;
  /** Stamp the final state and append to the receipts log. Idempotent — a
   *  second `close` call is a no-op (the first one wins). */
  close(state: ReceiptFinalState, notes?: Record<string, unknown>): Promise<void>;
}

export interface ReceiptStore {
  /** Open a new receipt for an inbound message. If a receipt is already open
   *  for `message_id` (re-delivery), the existing one is returned. */
  open(message_id: string, fields?: Partial<ReceiptRecord>): OpenReceipt;
  /** Find an open receipt without creating one. */
  find(message_id: string): OpenReceipt | undefined;
  /** Close every still-open receipt with the given terminal state (e.g. on
   *  daemon shutdown, mark them as `timeout`). */
  drain(state: ReceiptFinalState): Promise<void>;
  /** Path receipts are written to. */
  readonly logPath: string;
}

export interface ReceiptStoreOptions {
  /** Override the receipts log path. Defaults to
   *  `~/.claude/claudeclaw/receipts.jsonl`. */
  path?: string;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Logger for non-fatal write failures. Defaults to a no-op so a broken disk
   *  never crashes the bus. */
  onError?: (err: Error, ctx: string) => void;
}

/** Compute a short, stable hash of a prompt string. Short on purpose — the
 *  receipt should not let the full prompt leak into observability logs. */
export function hashPrompt(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function defaultReceiptLogPath(): string {
  return join(homedir(), ".claude", "claudeclaw", "receipts.jsonl");
}

export function createReceiptStore(opts: ReceiptStoreOptions = {}): ReceiptStore {
  const logPath = opts.path ?? defaultReceiptLogPath();
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? (() => {});
  const openReceipts = new Map<string, OpenReceipt>();

  // Best-effort ensure parent directory exists. Synchronous (one-shot) so we
  // don't race the first append.
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    onError(err as Error, "mkdir");
  }

  async function appendRecord(rec: ReceiptRecord): Promise<void> {
    try {
      await appendFile(logPath, JSON.stringify(rec) + "\n", "utf8");
    } catch (err) {
      onError(err as Error, "append");
    }
  }

  function makeReceipt(message_id: string, fields: Partial<ReceiptRecord>): OpenReceipt {
    const startedAt = now();
    const rec: ReceiptRecord = {
      message_id,
      received_at: startedAt.toISOString(),
      // sentinel — overwritten by close()
      final_state: "message_polled",
      ...fields,
      // received_at + message_id from caller's fields are ignored on purpose
      // so a typo can't change the receipt's identity.
      ...(fields.message_id ? { message_id } : {}),
      ...(fields.received_at ? { received_at: startedAt.toISOString() } : {}),
    };
    let closed = false;
    const receipt: OpenReceipt = {
      message_id,
      get record() {
        return rec;
      },
      patch(more: Partial<ReceiptRecord>): void {
        if (closed) return;
        // Don't allow patch() to override identity or terminal state.
        const { message_id: _m, received_at: _r, final_state: _f, ...rest } = more;
        Object.assign(rec, rest);
      },
      async close(state: ReceiptFinalState, notes?: Record<string, unknown>): Promise<void> {
        if (closed) return;
        closed = true;
        rec.final_state = state;
        rec.duration_ms = now().getTime() - startedAt.getTime();
        if (notes) rec.notes = { ...(rec.notes ?? {}), ...notes };
        openReceipts.delete(message_id);
        await appendRecord(rec);
      },
    };
    return receipt;
  }

  return {
    logPath,
    open(message_id: string, fields: Partial<ReceiptRecord> = {}): OpenReceipt {
      const existing = openReceipts.get(message_id);
      if (existing) {
        // Idempotent re-open: merge any new fields into the existing receipt
        // so re-deliveries don't lose context.
        if (Object.keys(fields).length > 0) existing.patch(fields);
        return existing;
      }
      const created = makeReceipt(message_id, fields);
      openReceipts.set(message_id, created);
      return created;
    },
    find(message_id: string): OpenReceipt | undefined {
      return openReceipts.get(message_id);
    },
    async drain(state: ReceiptFinalState): Promise<void> {
      const pending = [...openReceipts.values()];
      await Promise.all(pending.map((r) => r.close(state, { drained: true })));
    },
  };
}
