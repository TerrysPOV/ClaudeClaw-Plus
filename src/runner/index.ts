/**
 * Public entry point for the runner subdirectory.
 *
 * Re-exports the PtyProcess wrapper and the sentinel-echo turn-boundary
 * parser so the supervisor can import as
 *
 *     import { spawnPty, PtyProcess } from "../runner";
 *
 * without reaching into the implementation files.
 */

export {
  spawnPty,
  sanitizePtyPromptText,
  PtyTurnTimeoutError,
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  type PtyTurnResult,
  type PtyExitInfo,
} from "./pty-process";

export {
  createParser,
  startTurn,
  feed,
  tick,
  markSentinelWritten,
  resetTurn,
  buildSentinel,
  encodeSentinel,
  stripAnsi,
  normaliseNewlines,
  extractResponseText,
  decodeTurn,
  DEFAULT_QUIET_WINDOW_MS,
  type Parser,
  type ParserEvent,
  type ParserState,
} from "./pty-output-parser";
