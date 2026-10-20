/**
 * The upstream no-reply hang, as the integration spike sees it (#570 r15b): the turn timed out
 * (exit 124, reason `timeout`), the prompt reached the transcript, and claude wrote neither an
 * assistant entry nor an API error. Production retries this once; the spike's CONTROL PRESENT rows
 * do the same. Any other failure is a result, not a hang.
 */
export interface HangObservation {
  exitCode: number;
  reason: string | undefined;
  promptSeen: boolean;
  assistantEntries: number;
  apiErrors: number;
}

export function isHangSignature(seen: HangObservation): boolean {
  return (
    seen.exitCode === 124 &&
    seen.reason === "timeout" &&
    seen.promptSeen &&
    seen.assistantEntries === 0 &&
    seen.apiErrors === 0
  );
}

/** The log line for a retry: a fixed vocabulary, with only the row's own label in it. */
export function rowRetryLine(rowLabel: string): string {
  return `[isolation-spike] row-retry ${rowLabel}: reason=hang-signature`;
}

/** A CONTROL PRESENT row makes its call at most this many times: once, and once more on a hang. */
export const RETRY_ATTEMPTS = 2;

/**
 * What one attempt costs beyond its call budget: a 60 s call was seen to end at about 75 s
 * (run 39485100730, exec 75 044 ms), and REPL startup and cleanup come on top.
 */
export const ATTEMPT_OVERHEAD_MS = 15_000;

/** Room left over for the row's own work around the calls (plants, snapshots, assertions). */
export const RETRY_MARGIN_MS = 30_000;

/**
 * Test timeout of a row that can retry: every attempt at its full cost, plus the margin. Run
 * 39485100730 gave row C 140 s for a 60 s call that hung for 75 s, and the timeout killed the retry
 * partway (#570 r15c).
 */
export function retryRowTimeoutMs(callBudgetMs: number): number {
  return RETRY_ATTEMPTS * (callBudgetMs + ATTEMPT_OVERHEAD_MS) + RETRY_MARGIN_MS;
}

/** The log line for the retry's own result: fixed vocabulary, numbers and a diagnostic code. */
export function rowRetryResultLine(
  rowLabel: string,
  exitCode: number,
  reason: string | undefined,
  elapsedMs: number,
): string {
  return `[isolation-spike] row-retry ${rowLabel}: attempt=2 exit=${exitCode} reason=${reason ?? "none"} elapsedMs=${elapsedMs}`;
}

/**
 * Wrap a per-spawn hook so it runs on a row's FIRST spawn only. A baseline taken in a
 * `beforeSpawn` hook must not be taken again when the row retries: attempt 2's "before" would
 * already contain whatever attempt 1 wrote into the operator config, and the row would compare
 * attempt 2 against a baseline that hides attempt 1's regression (#570 r15d).
 */
export function firstSpawnOnly<A extends unknown[]>(
  hook: (...args: A) => void,
): (...args: A) => void {
  let done = false;
  return (...args: A) => {
    if (done) return;
    done = true;
    hook(...args);
  };
}
