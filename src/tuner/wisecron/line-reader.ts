/**
 * Bounded, synchronous, line-at-a-time file reader for the host telemetry
 * producers.
 *
 * WHY NOT `readFileSync`: the telemetry producers run on the cold `capabilities()`
 * path, which is SYNCHRONOUS by contract (the activation gate calls it sync), and
 * on low-spec (4GB) hosts. Slurping a whole transcript / journal into one string
 * (then a second array of parsed objects) can be tens of MB and stall the event
 * loop or OOM. This reader instead:
 *
 *   - reads the file in fixed 64KB chunks with `readSync` (stays synchronous, so
 *     it drops straight into the existing sync `scanFile`/`readAll` call sites);
 *   - decodes only COMPLETE lines (splits on the `\n` byte and keeps the tail as
 *     a Buffer), so a multibyte UTF-8 char that straddles a chunk boundary is
 *     never corrupted — behaviour is identical to a whole-file read for
 *     normal-size inputs;
 *   - holds at most one chunk + one pending line in memory, never the whole file;
 *   - CAPS at `maxBytes` (default 64MB): past the cap it stops reading rather than
 *     growing without bound, and reports it via `onTruncate` so the limit is never
 *     silent.
 */

import { closeSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 64 * 1024;
/** Default per-file byte cap. A single transcript this large is pathological;
 *  cap it rather than risk OOM on a 4GB box. */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface ForEachLineOpts {
  /** Stop after this many bytes; the rest of the file is skipped. */
  maxBytes?: number;
  /** Called once (with the byte count read so far) when `maxBytes` truncates the
   *  read, so the cap is observable instead of a silent partial scan. */
  onTruncate?: (bytesRead: number) => void;
}

/**
 * Invoke `onLine` for every newline-terminated line in `file`, plus a final
 * unterminated tail if present. Synchronous. Never holds more than one chunk +
 * one partial line. Throws on open/read failure — callers already wrap these in
 * try/catch to tolerate one bad file.
 */
export function forEachLineSync(
  file: string,
  onLine: (line: string) => void,
  opts: ForEachLineOpts = {},
): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let total = 0;
    let truncated = false;
    for (;;) {
      const bytes = readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (bytes <= 0) break;
      total += bytes;
      pending = Buffer.concat([pending, chunk.subarray(0, bytes)]);
      let nl = pending.indexOf(NEWLINE);
      while (nl !== -1) {
        onLine(pending.toString("utf8", 0, nl));
        pending = pending.subarray(nl + 1);
        nl = pending.indexOf(NEWLINE);
      }
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
    // Emit a final unterminated line only for a fully-read file; a truncated read
    // may have stopped mid-line, so its tail is dropped rather than mis-parsed.
    if (!truncated && pending.length > 0) onLine(pending.toString("utf8"));
    if (truncated) opts.onTruncate?.(total);
  } finally {
    closeSync(fd);
  }
}
