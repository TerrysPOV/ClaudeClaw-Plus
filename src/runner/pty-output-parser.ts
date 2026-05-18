/**
 * PTY output parser for Claude Code's interactive TUI (claude 2.1.89+).
 *
 * ─── Why a sentinel-echo round-trip ──────────────────────────────────────────
 *
 * Earlier claude versions emitted OSC 9;4 ("ConEmu progress") sequences around
 * each turn — START before processing, END when done. Claude 2.1.89 dropped
 * those markers and only emits OSC 0 (set window title) with spinner glyphs,
 * which are unreliable for turn-boundary detection. See issue #81.
 *
 * The new model uses a **sentinel-echo round-trip**:
 *
 *   1. Supervisor writes the user prompt + `\r` (Enter) to the PTY.
 *   2. Parser transitions `idle → accumulating` and buffers every byte after
 *      the prompt-write offset.
 *   3. Whenever the byte stream goes quiet for `quietWindowMs` (default 500),
 *      the parser emits a `quiet` event. The supervisor reacts by writing a
 *      unique sentinel string (no `\r`) into the PTY.
 *   4. claude's TUI is in raw mode — it echoes our sentinel bytes back into
 *      its own stdout (visible as "user typing into prompt area"). When the
 *      parser sees that echo, it emits `sentinel-found` and the turn is
 *      complete. The response bytes are the slice from `turn-start.offset` up
 *      to (but not including) `sentinel-found.offset`.
 *   5. Supervisor sends cleanup bytes (backspaces × sentinel length) to clear
 *      claude's in-progress input buffer before the next turn.
 *
 * The sentinel format `<<<CCAW_TURN_END_<uuid>>>>` is pure printable ASCII so
 * it won't collide with any control codes claude emits, and a fresh UUID per
 * turn guarantees a stale sentinel from an aborted turn can never match the
 * next turn. To defend against the (vanishing) chance of claude literally
 * producing the sentinel string in response text, we scan ONLY new bytes
 * after each chunk arrives — the supervisor writes the sentinel only AFTER
 * the `quiet` event fires, so the echo always lands strictly after that
 * boundary.
 *
 * ─── Event model ─────────────────────────────────────────────────────────────
 *
 * The parser is a pure state machine over the byte stream:
 *
 *   idle ─── start(uuid) ──▶ accumulating ─── feed() quiets ──▶ awaiting-sentinel
 *                                                            ◀── feed() (more bytes) ──╮
 *                                                                                     │
 *                                                                  awaiting-sentinel ─┘
 *                                                                          │
 *                                                                  sentinel echoed
 *                                                                          ▼
 *                                                                       complete
 *
 * Events:
 *   - `turn-start`     — synchronous emit from `startTurn()` at the offset of
 *                        the first response byte (everything before the offset
 *                        is pre-turn TUI noise the parser ignores).
 *   - `quiet`          — emitted by `tick(now)` when no bytes have arrived for
 *                        `quietWindowMs`. Supervisor reacts by writing the
 *                        sentinel.
 *   - `sentinel-found` — emitted by `feed()` when the sentinel string appears
 *                        in the accumulated bytes. Carries the offset of the
 *                        FIRST byte of the matched sentinel.
 *
 * NO I/O, NO globals, NO side effects beyond the `Parser` instance. The
 * supervisor (pty-process.ts) drives I/O.
 */

/** Quiet window before the supervisor writes the sentinel. Default 500ms. */
export const DEFAULT_QUIET_WINDOW_MS = 500;

/** State of the parser. */
export type ParserState = "idle" | "accumulating" | "awaiting-sentinel" | "complete";

/** Event types emitted by the parser. */
export type ParserEvent =
  | { type: "turn-start"; offset: number }
  | { type: "quiet"; offset: number }
  | { type: "sentinel-found"; offset: number; uuid: string };

/** Public parser state. Callers create one per turn (call `resetTurn`). */
export interface Parser {
  state: ParserState;
  /** UUID of the active turn's sentinel; empty when idle/complete. */
  uuid: string;
  /** Encoded sentinel bytes for the active turn (the string we wrote and are
   *  scanning for in the echo). */
  sentinelBytes: Uint8Array;
  /** Number of bytes seen across the entire stream so far. */
  totalBytes: number;
  /** Byte offset where the active turn started (start of response slice). */
  turnStartOffset: number;
  /** Byte offset of the sentinel match within the stream (only meaningful
   *  in `complete` state). */
  sentinelOffset: number;
  /** Last time `feed()` was called with a non-empty chunk. ms-epoch (or
   *  whatever the supervisor's clock returns). */
  lastByteAt: number;
  /** Quiet window in ms; supervisor reads this to size its tick interval. */
  quietWindowMs: number;
  /** Whether `quiet` has been emitted for the current accumulation. Reset on
   *  every new byte so the supervisor only writes the sentinel once per
   *  quiet period. */
  quietEmitted: boolean;
  /** Whether at least one byte has been seen SINCE the current turn started.
   *  Issue #87: pre-fix, `quiet` could fire 500ms after `startTurn` even
   *  though claude hadn't emitted a single byte of response yet — the
   *  initial "silence" was just claude's latency between receiving the
   *  prompt and starting to echo. We now only emit `quiet` once we've
   *  observed at least one byte after turn start, so quiet truly means
   *  "claude was responding and has stopped." */
  sawByteSinceTurnStart: boolean;
  /** Whether claude's TUI has emitted an active-generation spinner
   *  glyph since the turn started (✻ ✶ ✳ ✢ ✽ ✺ ✷ ◉). Spinners are
   *  the only reliable "claude is generating" signal — see the
   *  `ACTIVITY_INDICATOR_BYTES` comment for why `●`/`⏺` markers and
   *  `·` middle-dot are deliberately excluded.
   *
   *  Strengthens issue #87's `sawByteSinceTurnStart` gate. The original
   *  gate only required ANY byte after turn start, which was enough to
   *  catch the empty-silence variant of the bug. But it missed a
   *  second failure mode where the PTY emits bytes that are PURELY TUI
   *  redraws (input-area echo of the new prompt envelope,
   *  resumed-session scrollback) without claude having actually begun
   *  generating a response. Quiet fired, supervisor wrote the
   *  sentinel, claude echoed the sentinel without ever producing
   *  tokens, and the captured "response" was last-turn content + the
   *  new prompt envelope. See discord screenshot 2026-05-18 13:53 for
   *  the bug signature.
   *
   *  Failure mode under this gate: if claude truly has crashed or gone
   *  silent, `quiet` never fires and the supervisor's
   *  `sentinelMaxWaitMs` (default 30s) times the turn out. That's the
   *  correct outcome — visible failure beats returning garbage. */
  sawActivityIndicatorThisTurn: boolean;
  /** Carryover for activity-indicator byte-sequence scanning. The
   *  indicators are all 2-3 UTF-8 bytes; we keep up to 2 bytes from the
   *  previous chunk so a byte sequence straddling a chunk boundary
   *  still gets matched. */
  activityScanCarry: Uint8Array;
  /** Carry-over from previous chunks needed to detect a sentinel that
   *  straddles a chunk boundary. At most `sentinelBytes.length - 1` bytes. */
  pending: Uint8Array;
  /** Stream offset that the first byte of `pending` represents. */
  pendingBaseOffset: number;
}

/** Create a fresh parser instance (in `idle` state). */
export function createParser(opts?: { quietWindowMs?: number }): Parser {
  return {
    state: "idle",
    uuid: "",
    sentinelBytes: new Uint8Array(0),
    totalBytes: 0,
    turnStartOffset: 0,
    sentinelOffset: 0,
    lastByteAt: 0,
    quietWindowMs: opts?.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
    quietEmitted: false,
    sawByteSinceTurnStart: false,
    sawActivityIndicatorThisTurn: false,
    activityScanCarry: new Uint8Array(0),
    pending: new Uint8Array(0),
    pendingBaseOffset: 0,
  };
}

/**
 * Begin a new turn. The supervisor calls this immediately after writing the
 * user prompt + `\r` to the PTY. `turnStartOffset` should equal the parser's
 * current `totalBytes` (i.e. the offset of the next byte we expect from
 * claude). `uuid` is a fresh per-turn UUID — the supervisor encodes it into
 * the sentinel string and passes the encoded form via `sentinelBytes`.
 *
 * Returns the `turn-start` event so callers can record the offset.
 */
export function startTurn(
  parser: Parser,
  uuid: string,
  sentinelBytes: Uint8Array,
  now: number,
): ParserEvent {
  parser.state = "accumulating";
  parser.uuid = uuid;
  parser.sentinelBytes = sentinelBytes;
  parser.turnStartOffset = parser.totalBytes;
  parser.sentinelOffset = 0;
  parser.lastByteAt = now;
  parser.quietEmitted = false;
  parser.sawByteSinceTurnStart = false;
  parser.sawActivityIndicatorThisTurn = false;
  parser.activityScanCarry = new Uint8Array(0);
  parser.pending = new Uint8Array(0);
  parser.pendingBaseOffset = parser.totalBytes;
  return { type: "turn-start", offset: parser.turnStartOffset };
}

/**
 * Feed a chunk of raw PTY bytes through the parser. Returns any events
 * produced by this chunk, in order.
 *
 * Offsets in events are absolute byte offsets within the cumulative stream
 * (measured from the very first byte fed to this parser instance), and point
 * to the FIRST byte of the matched sentinel.
 */
export function feed(parser: Parser, chunk: Uint8Array, now: number): ParserEvent[] {
  const events: ParserEvent[] = [];
  if (chunk.length === 0) return events;

  const chunkBaseOffset = parser.totalBytes;
  parser.totalBytes += chunk.length;
  parser.lastByteAt = now;
  parser.quietEmitted = false; // any new byte resets the quiet emitter
  if (parser.state === "accumulating" || parser.state === "awaiting-sentinel") {
    parser.sawByteSinceTurnStart = true;
    // Activity-indicator scan — strengthens issue #87's gate so the
    // sentinel isn't written when the only bytes seen are TUI redraws.
    scanForActivityIndicator(parser, chunk);
  }

  // We only scan for the sentinel after the supervisor has actually written
  // it (state === "awaiting-sentinel"). Until then there's nothing to find,
  // and scanning would risk a false match if claude were to emit our sentinel
  // string in legitimate output before we wrote it (impossible in practice
  // given the fresh UUID, but cheap to enforce).
  if (parser.state !== "awaiting-sentinel") {
    // Drop pending: we're not yet looking for the sentinel.
    parser.pending = new Uint8Array(0);
    parser.pendingBaseOffset = chunkBaseOffset + chunk.length;
    return events;
  }

  // Combine pending carryover (last few bytes of previous chunks) with the
  // new chunk to detect a sentinel that straddles a chunk boundary.
  const search = new Uint8Array(parser.pending.length + chunk.length);
  search.set(parser.pending, 0);
  search.set(chunk, parser.pending.length);
  const searchBase = parser.pendingBaseOffset;

  const matchIdx = indexOfBytes(search, parser.sentinelBytes);
  if (matchIdx >= 0) {
    const absOffset = searchBase + matchIdx;
    parser.state = "complete";
    parser.sentinelOffset = absOffset;
    parser.pending = new Uint8Array(0);
    parser.pendingBaseOffset = chunkBaseOffset + chunk.length;
    events.push({ type: "sentinel-found", offset: absOffset, uuid: parser.uuid });
    return events;
  }

  // No match. Keep the last (sentinelBytes.length - 1) bytes as pending so a
  // sentinel straddling the next chunk boundary still gets caught.
  const keep = Math.max(0, parser.sentinelBytes.length - 1);
  const carryStart = Math.max(0, search.length - keep);
  parser.pending = search.slice(carryStart);
  parser.pendingBaseOffset = searchBase + carryStart;
  return events;
}

/**
 * Tick the parser's quiet timer. The supervisor should call this on a regular
 * interval (e.g. every 50ms). When the parser is in `accumulating` state and
 * `now - lastByteAt >= quietWindowMs`, emits a single `quiet` event so the
 * supervisor knows to write the sentinel. Idempotent within a quiet window —
 * only fires once until a new byte resets `quietEmitted`.
 *
 * Calling `tick` in any other state is a no-op.
 */
export function tick(parser: Parser, now: number): ParserEvent[] {
  if (parser.state !== "accumulating") return [];
  if (parser.quietEmitted) return [];
  // Issue #87: don't fire `quiet` until claude has emitted at least one byte
  // of response. Otherwise the initial silence between prompt write and
  // claude's first ack-echo (often ~500–800ms on claude 2.1.89) gets
  // interpreted as "claude is done", the sentinel is written prematurely
  // into claude's input buffer, claude echoes it back, the parser sees
  // sentinel-found, and the turn returns with only the TUI splash + prompt
  // echo as the "response" — model output never had a chance to arrive.
  if (!parser.sawByteSinceTurnStart) return [];
  // Strengthened gate: even when bytes ARE flowing, they may be pure TUI
  // redraws (prompt-envelope echo, resumed-session scrollback) with no
  // actual response in progress. The fix from the 2026-05-18 Discord
  // screenshot — claude had been idle ~1h23m and the new turn returned
  // last-turn content + the new prompt envelope. Wait for a real
  // activity indicator (spinner or assistant marker) before treating
  // silence as "claude is done." If claude has crashed or simply
  // doesn't respond, this gate keeps quiet from firing and the
  // supervisor's `sentinelMaxWaitMs` (default 30s) fails the turn
  // visibly — better than returning garbage.
  if (!parser.sawActivityIndicatorThisTurn) return [];
  if (now - parser.lastByteAt < parser.quietWindowMs) return [];
  parser.quietEmitted = true;
  return [{ type: "quiet", offset: parser.totalBytes }];
}

/**
 * Signal to the parser that the supervisor has written the sentinel bytes.
 * The parser transitions to `awaiting-sentinel` and starts scanning incoming
 * bytes for the echo.
 */
export function markSentinelWritten(parser: Parser): void {
  if (parser.state === "accumulating") {
    parser.state = "awaiting-sentinel";
  }
}

/**
 * Reset parser back to `idle`, clearing per-turn state. Total byte count is
 * preserved so subsequent turns get correct absolute offsets.
 */
export function resetTurn(parser: Parser): void {
  parser.state = "idle";
  parser.uuid = "";
  parser.sentinelBytes = new Uint8Array(0);
  parser.turnStartOffset = 0;
  parser.sentinelOffset = 0;
  parser.lastByteAt = 0;
  parser.quietEmitted = false;
  parser.sawActivityIndicatorThisTurn = false;
  parser.activityScanCarry = new Uint8Array(0);
  parser.pending = new Uint8Array(0);
  parser.pendingBaseOffset = parser.totalBytes;
}

/**
 * Build the canonical sentinel string for a given UUID. Pure printable ASCII
 * so the bytes survive claude's input echo intact.
 */
export function buildSentinel(uuid: string): string {
  return `<<<CCAW_TURN_END_${uuid}>>>`;
}

/** Encode a sentinel string into bytes (UTF-8 / ASCII-safe). */
export function encodeSentinel(sentinel: string): Uint8Array {
  return new TextEncoder().encode(sentinel);
}

// ─── Activity-indicator scan ─────────────────────────────────────────────────

/**
 * UTF-8 byte sequences for the spinner glyphs claude's TUI emits ONLY
 * while it is actively producing output. Spinner-only by design — see
 * the Codex P1 finding on PR #124 for the marker-glyph exclusion.
 *
 * Spinner family (per the `terminatorRe` in `extractResponseText`):
 *   ✻ U+273B (E2 9C BB)
 *   ✶ U+2736 (E2 9C B6)
 *   ✳ U+2733 (E2 9C B3)
 *   ✢ U+2722 (E2 9C A2)
 *   ✽ U+273D (E2 9C BD)
 *   ✺ U+273A (E2 9C BA)
 *   ✷ U+2737 (E2 9C B7)
 *   ◉ U+25C9 (E2 97 89)
 *
 * Deliberately EXCLUDED:
 *   - `●` U+25CF and `⏺` U+23FA — the assistant-message markers. They
 *     APPEAR in the TUI status-box row (e.g. `│ ● live │ 🎮 │`) and in
 *     scrollback re-paints from `--resume`. Matching them anywhere in
 *     the byte stream lets the gate false-positive on the exact TUI
 *     redraws this patch is trying to defeat (PR #124 Codex P1). The
 *     line-anchored `markerRe` in `extractResponseText` only fires
 *     when the marker is at start-of-line, but at gate-evaluation time
 *     we're scanning a raw byte stream where newline context is hard
 *     to reconstruct cheaply — spinner-only is the cleaner discriminator.
 *   - `·` U+00B7 — too common as TUI footer punctuation (`Opus · 1M
 *     context · /effort`) and body text.
 *
 * Trade-off: a hypothetical extremely-short claude response that never
 * shows a spinner would fail to open the gate. In practice every
 * response we've observed (validated against the golden fixture +
 * Hetzner production traffic) paints the spinner for at least one
 * frame before the marker — the spinner-only signal is sufficient.
 */
const ACTIVITY_INDICATOR_BYTES: readonly Uint8Array[] = [
  new Uint8Array([0xe2, 0x9c, 0xbb]), // ✻
  new Uint8Array([0xe2, 0x9c, 0xb6]), // ✶
  new Uint8Array([0xe2, 0x9c, 0xb3]), // ✳
  new Uint8Array([0xe2, 0x9c, 0xa2]), // ✢
  new Uint8Array([0xe2, 0x9c, 0xbd]), // ✽
  new Uint8Array([0xe2, 0x9c, 0xba]), // ✺
  new Uint8Array([0xe2, 0x9c, 0xb7]), // ✷
  new Uint8Array([0xe2, 0x97, 0x89]), // ◉
];

/**
 * Longest indicator length in bytes — used to size the carryover for
 * chunk-boundary handling. All current indicators are 3 bytes, so the
 * carry needs to hold up to 2 bytes from the previous chunk to catch a
 * sequence split across chunks.
 */
const ACTIVITY_CARRY_MAX = 2;

/**
 * Scan `chunk` (combined with any prior carry) for any activity
 * indicator byte sequence. Updates `parser.sawActivityIndicatorThisTurn`
 * if found, and updates `parser.activityScanCarry` so the next chunk
 * picks up a sequence split across the boundary.
 *
 * Cheap: the activity-indicator set is small (10 sequences) and we only
 * scan when the flag is unset. Once seen, this becomes a no-op for the
 * rest of the turn.
 */
function scanForActivityIndicator(parser: Parser, chunk: Uint8Array): void {
  if (parser.sawActivityIndicatorThisTurn) return;
  if (chunk.length === 0) return;

  // Combine with carry so a split-byte sequence at the chunk boundary is
  // still detectable.
  const carry = parser.activityScanCarry;
  const buf = carry.length === 0 ? chunk : concatBytes(carry, chunk);

  for (const seq of ACTIVITY_INDICATOR_BYTES) {
    if (indexOfBytes(buf, seq) >= 0) {
      parser.sawActivityIndicatorThisTurn = true;
      parser.activityScanCarry = new Uint8Array(0);
      return;
    }
  }

  // No hit — keep the tail (up to ACTIVITY_CARRY_MAX bytes) as carry.
  const tailLen = Math.min(ACTIVITY_CARRY_MAX, buf.length);
  parser.activityScanCarry = buf.slice(buf.length - tailLen);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ─── Byte-level search ───────────────────────────────────────────────────────

/** Find the first index of `needle` in `haystack`. -1 if not found. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ─── Response-text extraction ────────────────────────────────────────────────

/**
 * Cap on how many synthesised spaces a single CUF / CHA sequence can
 * produce. Claude's TUI occasionally emits cursor moves like `\x1B[120C`
 * to pad to the right column; converting those into 120 spaces would
 * blow up the captured body. 128 covers any normal word/column padding
 * (claude renders at ~100 cols) without enabling pathological inputs to
 * produce megabytes of whitespace. Anything past the cap collapses to a
 * single space so word boundaries are still visible.
 */
const CUF_MAX_SPACES = 128;

/**
 * Pre-pass that converts cursor-forward sequences into the spaces they
 * visually represent.
 *
 * Why this exists: claude's TUI (2.1.140+) emits `\x1B[1C` (cursor-forward
 * one column) BETWEEN words instead of a literal U+0020 space, and `\x1B[NC`
 * for column padding. When `stripAnsi` strips all CSI sequences without
 * understanding their semantics, the cursor moves are erased along with
 * the visible "space" they represented — leaving body text like
 * `Reviewpendingtasks,reminders,...` with every word run together. See
 * the discussion in issue #119 + the golden fixture
 * `.planning/pty-migration/fixtures/turn-boundary-sample.txt`.
 *
 * Handled:
 *   - `\x1B[<n>C`  → CUF (Cursor Forward n columns) — emit min(n, CAP) spaces.
 *   - `\x1B[C`     → CUF with default 1 — emit one space.
 *
 * Not handled (deliberately):
 *   - `\x1B[<n>G`  → CHA (absolute column) — needs current column tracking
 *     to compute the right padding; out of scope for a band-aid. Operators
 *     hitting this case should validate on the Bus runtime (Sprint 5) which
 *     reads JSONL instead of PTY rendering.
 *   - `\x1B[<n>D`  → CUB (Cursor Back) — only matters for redraws, not
 *     for first-pass word-boundary recovery.
 *   - `\x1B[<r>;<c>H` → CUP (Cursor Position) — full terminal-emulation
 *     territory; same JSONL-replacement rationale as CHA.
 */
export function expandCursorForwardToSpaces(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CUF is an ANSI CSI sequence.
  return text.replace(/\x1b\[(\d*)C/g, (_match, digits: string) => {
    const n = digits.length === 0 ? 1 : parseInt(digits, 10);
    if (!Number.isFinite(n) || n <= 0) return " ";
    return " ".repeat(Math.min(n, CUF_MAX_SPACES));
  });
}

/**
 * Strip ANSI control sequences from text. Removes:
 *   - OSC sequences:  ESC ] ... (BEL | ESC \)
 *   - CSI sequences:  ESC [ ... <final byte 0x40-0x7E>
 *   - Charset-select: ESC ( <byte>, ESC ) <byte>
 *   - Solo ESC bytes (defensive)
 *
 * Before the general CSI stripper runs, `expandCursorForwardToSpaces`
 * converts CUF (`\x1B[<n>C`) sequences to literal spaces so claude's
 * cursor-forward-as-word-separator pattern (TUI 2.1.140+) doesn't lose
 * inter-word spacing when the CSI stripper erases the sequence.
 *
 * Preserves all non-ANSI Unicode (emoji, box-drawing, CJK, etc.).
 */
export function stripAnsi(text: string): string {
  return (
    expandCursorForwardToSpaces(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences require control bytes.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape stripper.
      .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI charset-select escape stripper.
      .replace(/\x1b[()][0-9A-Za-z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: catch-all ESC byte stripper.
      .replace(/\x1b/g, "")
  );
}

/**
 * Normalise carriage returns. PTYs emit CRLF; we convert `\r\n` → `\n` and
 * drop bare `\r` carriage returns.
 */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Extract the assistant's response text from a stripped-and-normalised turn
 * buffer. claude's TUI renders the assistant message prefixed with the `⏺`
 * glyph (U+23FA), sometimes followed by a space.
 *
 * Algorithm:
 *   1. Find the last occurrence of `⏺` in the buffer.
 *   2. Take text from just after `⏺` up to the first occurrence of any
 *      spinner / tool-result terminator.
 *   3. Trim whitespace; if empty, fall back to the whole stripped buffer.
 */
export function extractResponseText(strippedNormalised: string): string {
  // Claude 2.1.89 emits `●` (U+25CF BLACK CIRCLE) before the assistant
  // message. Older versions used `⏺` (U+23FA RECORD button). Accept both.
  //
  // The marker MUST be anchored at the start of a line. claude's TUI
  // uses `●` in plenty of other places too — the ClaudeClaw+ status box
  // (`│ ● live │ 🎮 │`) renders the same glyph inside a box-drawn row,
  // and the status box paints AFTER the model response in the stream. A
  // naive `lastIndexOf("●")` would pick the box marker and return only
  // the TUI footer as the "response". The space after the marker is
  // optional: claude 2.1.89 ANSI-strips down to `●Pong` (no space) for
  // short responses; longer responses (or ones with leading punctuation)
  // come through as `● Body...`.
  const markerRe = /(?:^|\n)([●⏺]) ?/gu;
  // Spinner glyphs and `⎿` tool-result indent are the natural terminators
  // that follow the assistant message in the TUI. We also terminate on a
  // line of 4+ horizontal box-drawing chars (`─` U+2500 or `━` U+2501) —
  // claude's TUI prints that as the divider above the next input prompt
  // after a response completes. We intentionally do NOT include `❯` alone
  // — it can legitimately appear inside response text (e.g. a shell-prompt
  // example).
  const terminatorRe = /[✻✶✳✢✽✺✷·◉]| {2,}⎿|\n[─━]{4,}/u;

  // Find the LAST line-anchored marker. Take whichever appears latest in
  // the stream (handles streams that contain multiple turns or a turn
  // whose response includes nested assistant markers).
  let lastMarkerStart = -1;
  let lastMarkerEnd = -1;
  for (const m of strippedNormalised.matchAll(markerRe)) {
    // m.index points at the `\n` (or position 0). The marker character
    // itself begins at index + (newline ? 1 : 0). Easiest: m[0] is either
    // "\n● " or "● " (at string start); the marker char is the
    // penultimate char of the match. After-text begins right after.
    const matchStart = m.index ?? 0;
    const afterStart = matchStart + m[0].length;
    lastMarkerStart = matchStart;
    lastMarkerEnd = afterStart;
  }
  if (lastMarkerStart < 0) return strippedNormalised.trim();

  const after = strippedNormalised.slice(lastMarkerEnd);
  const termMatch = after.match(terminatorRe);
  const body = termMatch ? after.slice(0, termMatch.index) : after;
  const trimmed = body.trim();
  if (trimmed.length > 0) return trimmed;
  return strippedNormalised.trim();
}

/**
 * Convenience: take a raw byte slice (the bytes seen between turn-start and
 * sentinel-found), strip ANSI, normalise newlines, extract response.
 */
export function decodeTurn(rawBytes: Uint8Array): {
  stripped: string;
  text: string;
} {
  const decoded = new TextDecoder("utf-8").decode(rawBytes);
  const stripped = normaliseNewlines(stripAnsi(decoded));
  const text = extractResponseText(stripped);
  return { stripped, text };
}
