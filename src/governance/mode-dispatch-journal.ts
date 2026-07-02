/**
 * mode_dispatch instrumentation — the HOST-side producer of the `mode_dispatch`
 * telemetry stream (OutcomeLoop Phase B).
 *
 * ClaudeClaw routes each request to an `agentic.modes` mode by keyword/phrase
 * matching (`classifyTask`/`selectModel` in `../model-router.ts`, called from
 * `./model-router.ts`'s `selectModel`). That resolution IS the dispatch event.
 * This module records one `{ ts, mode, matched_keyword, reclassified }` line per
 * dispatch to a journal that `ModeDispatchTelemetryProducer` reads.
 *
 * Sink indirection (why it's not a bare `appendFileSync`): the classifier runs
 * inside unit tests and the `tuner` CLI, neither of which should touch the real
 * home dir. So emission goes through a module-level sink that defaults to a
 * NO-OP. The live daemon installs the file sink exactly once at router init
 * (`ensureGovernanceRouter` in `runner.ts`) via `setModeDispatchSink`. Tests
 * install an in-memory sink (or a temp-file one) explicitly. No env-sniffing,
 * no accidental writes.
 *
 * `reclassified` is the metric the consumer needs (ModelRoutingSubject's
 * `routing_reclassify_rate = nonzeroRate`). A fresh dispatch is never known to
 * be a mis-route at emit time, so it is recorded `false` (value 0) — an honest
 * baseline that activates the stream with a real dispatch count and a
 * reclassify-rate of 0, never a fabricated nonzero. A later corrector can append
 * a `reclassified:true` record for the same dispatch when one is detected.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One dispatch record. Field names match the on-disk JSONL + the producer. */
export interface ModeDispatchEvent {
  /** ISO-8601 UTC. Filled by `recordModeDispatch` when omitted. */
  ts: string;
  /** Resolved agentic mode name (e.g. "coding", "planning"). */
  mode: string;
  /** The phrase/keyword that selected the mode ("" on a default/tie fallback). */
  matched_keyword: string;
  /** True only when a later signal flags this dispatch a mis-route. */
  reclassified: boolean;
}

/** Default journal — alongside the ClaudeClaw operations journal. */
export const DEFAULT_MODE_DISPATCH_LOG = join(
  homedir(),
  ".claudeclaw",
  "journal",
  "mode_dispatch.jsonl",
);

export type ModeDispatchSink = (event: ModeDispatchEvent) => void;

/** No-op default: emission is inert until the host installs a real sink. */
let sink: ModeDispatchSink = () => {};

/** Install the active sink (daemon → file sink; tests → in-memory/temp). */
export function setModeDispatchSink(next: ModeDispatchSink): void {
  sink = next;
}

/** Restore the inert no-op sink (test teardown). */
export function resetModeDispatchSink(): void {
  sink = () => {};
}

/**
 * Record one dispatch. `ts` defaults to now and `reclassified` to false, so the
 * common call site is just `recordModeDispatch({ mode, matched_keyword })`.
 * Never throws — instrumentation must not break the routing path.
 */
export function recordModeDispatch(
  event: Pick<ModeDispatchEvent, "mode" | "matched_keyword"> & Partial<ModeDispatchEvent>,
): void {
  try {
    sink({
      ts: event.ts ?? new Date().toISOString(),
      mode: event.mode,
      matched_keyword: event.matched_keyword,
      reclassified: event.reclassified ?? false,
    });
  } catch {
    /* swallow — telemetry is best-effort */
  }
}

/**
 * A sink that appends one JSON line per event to `path` (default
 * `DEFAULT_MODE_DISPATCH_LOG`). Creates the parent dir on first write. All
 * filesystem errors are swallowed.
 */
export function fileModeDispatchSink(path: string = DEFAULT_MODE_DISPATCH_LOG): ModeDispatchSink {
  let dirEnsured = false;
  return (event: ModeDispatchEvent) => {
    try {
      if (!dirEnsured) {
        mkdirSync(dirname(path), { recursive: true });
        dirEnsured = true;
      }
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch {
      /* swallow */
    }
  };
}
