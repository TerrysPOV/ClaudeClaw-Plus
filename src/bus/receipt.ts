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
import { appendFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Terminal states a receipt can land on. The first four are normal flow;
 *  the rest are failure surfaces we want to make countable.
 *
 *  Vocabulary note vs issue #207 (where the chain was originally
 *  specified): #207 used `wedged_prompt` to mean `stdin_written` ✓ but
 *  `turn_observed` never fires within the timeout window — what this
 *  implementation calls `timeout`. Here, `wedged_prompt` is reserved
 *  for the narrower failure of `bus.sendPrompt` itself rejecting at
 *  entry (route was resolvable but the bus refused the prompt). Keep
 *  this mapping in mind when cross-reading #207 against `receipts.jsonl`.
 *
 *  Caveat on `turn_observed`: this state is *bridge-inferred* from an
 *  `intent: "final"` event on `response.text` — it means "the bridge
 *  thinks the turn happened". It is NOT yet tailer-confirmed via
 *  `claude_jsonl_path` + `turn_event_offset` (follow-up). Treat it as
 *  a strong-but-not-authoritative signal until that wire lands. */
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
   *  second `close` call is a no-op (the first one wins).
   *
   *  `notes` is caller-controlled free-form metadata (latency, error kind,
   *  retry count, etc.). **Do not put secrets here** — receipts land on disk
   *  as JSONL for offline analysis. Hash anything sensitive first. */
  close(state: ReceiptFinalState, notes?: Record<string, unknown>): Promise<void>;
}

export interface ReceiptStore {
  /** Open a new receipt for an inbound message. If a receipt is already open
   *  for `message_id` (re-delivery), the existing one is returned. */
  open(message_id: string, fields?: Partial<ReceiptRecord>): OpenReceipt;
  /** Find an open receipt without creating one. */
  find(message_id: string): OpenReceipt | undefined;
  /** Look up an open receipt by its `prompt_hash`. Used at the bus → PTY
   *  seam, where only the prompt text is available (no message_id). Returns
   *  undefined if no receipt is currently open for that hash. */
  findByPromptHash(prompt_hash: string): OpenReceipt | undefined;
  /**
   * #212: the JSONL tailer saw the turn boundary for the prompt with this
   * hash. An open receipt is patched with `claude_jsonl_path` +
   * `turn_event_offset` (the bridge's `turn_observed` close then carries the
   * tailer's proof). A receipt already closed — the bridge timed out first, or
   * closed `turn_observed` a moment earlier — is not reopened: the fact goes
   * to the append-only side table `receipt-turns.jsonl` next to the log,
   * keyed by the message_id the hash last belonged to, so the join stays
   * possible without relaxing "close is the end". Returns where it went.
   */
  confirmTurn(
    prompt_hash: string,
    proof: { claude_jsonl_path: string; turn_event_offset: number; message_id?: string },
  ): Promise<"patched" | "side-table" | "unknown">;
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
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export function defaultReceiptLogPath(): string {
  return join(homedir(), ".claude", "claudeclaw", "receipts.jsonl");
}

export function createReceiptStore(opts: ReceiptStoreOptions = {}): ReceiptStore {
  const logPath = opts.path ?? defaultReceiptLogPath();
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? (() => {});
  const openReceipts = new Map<string, OpenReceipt>();
  // Secondary index for the bus → PTY seam, which only sees `text` (no
  // message_id). Populated when a receipt is patched with `prompt_hash` and
  // cleared on close. A hash collision would shadow an earlier still-open
  // receipt; we accept that for the short window between stdin_written and
  // turn_observed since the alternative (collision-free uuid plumbing
  // through every adapter) is invasive.
  const byPromptHash = new Map<string, OpenReceipt>();
  // #212: the message_id a prompt hash last belonged to, kept after close so a
  // tailer confirmation that lands after the bridge closed the receipt can
  // still be joined to it. Bounded (insertion order, oldest evicted).
  const recentlyClosedByHash = new Map<string, string>();
  const RECENTLY_CLOSED_MAX = 500;
  const turnsPath = join(dirname(logPath), "receipt-turns.jsonl");
  let turnsModeEnsured = false;
  // A thinking+text message yields two boundary lines: one side-table row per
  // (hash, transcript message), not per line.
  const lastSideRowByHash = new Map<string, string | undefined>();

  // Best-effort ensure parent directory exists. Synchronous (one-shot) so we
  // don't race the first append.
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    onError(err as Error, "mkdir");
  }

  // Tighten the receipts.jsonl file mode to 0600 once we've written to it.
  // The default umask leaves it 0664 (group-readable), which is loose for a
  // log that carries operational metadata (session_id, pid, cwd, prompt hash).
  // Idempotent — we only need to chmod the first time the file actually exists
  // on disk for this store.
  let modeEnsured = false;

  async function appendRecord(rec: ReceiptRecord): Promise<void> {
    try {
      await appendFile(logPath, `${JSON.stringify(rec)}\n`, "utf8");
      if (!modeEnsured) {
        try {
          await chmod(logPath, 0o600);
        } catch (err) {
          onError(err as Error, "chmod");
        }
        modeEnsured = true;
      }
    } catch (err) {
      onError(err as Error, "append");
    }
  }

  function indexHash(receipt: OpenReceipt, hash: string | undefined): void {
    if (!hash) return;
    byPromptHash.set(hash, receipt);
  }

  function deindexHash(hash: string | undefined): void {
    if (!hash) return;
    byPromptHash.delete(hash);
  }

  function makeReceipt(message_id: string, fields: Partial<ReceiptRecord>): OpenReceipt {
    const startedAt = now();
    // Drop any caller-supplied identity / terminal fields up-front so a typo
    // in `fields` can't change which receipt this is or close it prematurely.
    const {
      message_id: _ignoreMessageId,
      received_at: _ignoreReceivedAt,
      final_state: _ignoreFinalState,
      duration_ms: _ignoreDurationMs,
      ...safeFields
    } = fields;
    const rec: ReceiptRecord = {
      message_id,
      received_at: startedAt.toISOString(),
      // sentinel — overwritten by close()
      final_state: "message_polled",
      ...safeFields,
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
        // Track hash transitions so the prompt-hash index stays in sync if a
        // caller back-fills the hash after open.
        const before = rec.prompt_hash;
        Object.assign(rec, rest);
        if (rec.prompt_hash !== before) {
          deindexHash(before);
          indexHash(this, rec.prompt_hash);
        }
      },
      async close(state: ReceiptFinalState, notes?: Record<string, unknown>): Promise<void> {
        if (closed) return;
        closed = true;
        rec.final_state = state;
        rec.duration_ms = now().getTime() - startedAt.getTime();
        if (notes) rec.notes = { ...(rec.notes ?? {}), ...notes };
        // Several causes share `timeout`; only `notes.reason` tells them
        // apart. A caller that forgot one still lands as a countable reason.
        const reason = rec.notes?.reason;
        if (state === "timeout" && (typeof reason !== "string" || reason === "")) {
          rec.notes = { ...(rec.notes ?? {}), reason: "unspecified" };
        }
        openReceipts.delete(message_id);
        deindexHash(rec.prompt_hash);
        if (rec.prompt_hash) {
          recentlyClosedByHash.delete(rec.prompt_hash);
          recentlyClosedByHash.set(rec.prompt_hash, message_id);
          if (recentlyClosedByHash.size > RECENTLY_CLOSED_MAX) {
            const oldest = recentlyClosedByHash.keys().next().value;
            if (oldest !== undefined) recentlyClosedByHash.delete(oldest);
          }
        }
        await appendRecord(rec);
      },
    };
    indexHash(receipt, rec.prompt_hash);
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
    findByPromptHash(prompt_hash: string): OpenReceipt | undefined {
      return byPromptHash.get(prompt_hash);
    },
    async confirmTurn(prompt_hash, proof) {
      const open = byPromptHash.get(prompt_hash);
      if (open) {
        open.patch({
          claude_jsonl_path: proof.claude_jsonl_path,
          turn_event_offset: proof.turn_event_offset,
          ...(proof.message_id
            ? { notes: { ...open.record.notes, transcript_message_id: proof.message_id } }
            : {}),
        });
        return "patched";
      }
      const message_id = recentlyClosedByHash.get(prompt_hash);
      if (
        proof.message_id !== undefined &&
        lastSideRowByHash.get(prompt_hash) === proof.message_id
      ) {
        return message_id ? "side-table" : "unknown";
      }
      lastSideRowByHash.set(prompt_hash, proof.message_id);
      if (lastSideRowByHash.size > RECENTLY_CLOSED_MAX) {
        const oldest = lastSideRowByHash.keys().next().value;
        if (oldest !== undefined) lastSideRowByHash.delete(oldest);
      }
      const row = {
        kind: "turn_confirmed",
        message_id: message_id ?? null,
        prompt_hash,
        claude_jsonl_path: proof.claude_jsonl_path,
        turn_event_offset: proof.turn_event_offset,
        transcript_message_id: proof.message_id ?? null,
        confirmed_at: now().toISOString(),
      };
      try {
        await appendFile(turnsPath, `${JSON.stringify(row)}\n`, "utf8");
        if (!turnsModeEnsured) {
          try {
            await chmod(turnsPath, 0o600);
          } catch (err) {
            onError(err as Error, "chmod");
          }
          turnsModeEnsured = true;
        }
      } catch (err) {
        onError(err as Error, "append");
      }
      return message_id ? "side-table" : "unknown";
    },
    async drain(state: ReceiptFinalState): Promise<void> {
      const pending = [...openReceipts.values()];
      await Promise.all(pending.map((r) => r.close(state, { drained: true, reason: "drained" })));
    },
  };
}

/**
 * Process-wide singleton store. Lazily created on first access so importing
 * this module does not touch the filesystem. The store writes to
 * `~/.claude/claudeclaw/receipts.jsonl` and forwards non-fatal failures to
 * stderr — instrumentation must never break the bus, but we still want to
 * know if the disk is wedged.
 */
let _defaultStore: ReceiptStore | null = null;
export function getDefaultReceiptStore(): ReceiptStore {
  if (_defaultStore) return _defaultStore;
  _defaultStore = createReceiptStore({
    onError: (err, ctx) => {
      // One-line, prefixed, on stderr — easy to grep, won't drown daemon logs.
      console.error(`[receipt:${ctx}] ${err.message}`);
    },
  });
  return _defaultStore;
}

/** Test-only: swap the singleton. Returns a disposer that restores the
 *  previous one. Not exported via the module's main entry — the bus runtime
 *  always calls `getDefaultReceiptStore()`. */
export function _setDefaultReceiptStoreForTests(store: ReceiptStore | null): () => void {
  const prev = _defaultStore;
  _defaultStore = store;
  return () => {
    _defaultStore = prev;
  };
}
