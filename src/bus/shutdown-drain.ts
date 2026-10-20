/**
 * Graceful drain on shutdown (#315).
 *
 * `systemctl restart` while an agent turn is in flight used to kill that turn
 * with no guard and no signal: the reply the user was waiting on was gone and
 * nothing said so. #318 exposed the busy signal (`/api/health` → `busy`) so
 * an external guard can wait; this is the daemon-side half — on SIGTERM, wait
 * for the bus to owe the model nothing, bounded, and say what happened.
 *
 * What "busy" covers is `BusCore.busyAgents()`: a turn in flight, and every
 * prompt the bus still holds for the model (in-flight delivery, queued behind
 * an initialising session, held through a compaction, carried over a socket
 * close, turn-start still being verified). A prompt that reached the model
 * and whose reply is being sent is covered by the settle grace after the last
 * turn ends — nothing awaits outbound adapter sends, so the drain gives them
 * a moment.
 *
 * The verdict is honest about HOW an agent stopped being busy. The bus also
 * clears an agent's turn when its IPC connection closes, or on a `cancel` /
 * `error` from the agent — and a connection close is exactly what happens
 * when the service manager signals the whole control group and the `claude`
 * child dies with the daemon (systemd `KillMode=control-group`, the
 * default). The drain cannot tell those three apart, so it reports them as
 * one class, "ended without a turn_end", never as finished; the deploy doc
 * says to use `KillMode=mixed` so the child outlives the signal.
 *
 * Deliberately NOT done here: refusing new prompts during the drain. The
 * adapters do not turn a `sendPrompt` rejection into a message to the user,
 * so a refusal would be a silent drop of a different kind. Consequence: under
 * steady inbound traffic the drain chains turns and runs to the window.
 */

export interface DrainOutcome {
  /** Agents busy when the drain started. */
  busyAtStart: string[];
  /** Agents that reached `turn_end` during the drain. */
  finished: string[];
  /**
   * Agents that left the busy set WITHOUT a `turn_end`: the bus also clears
   * a turn when the agent's IPC connection closes, or on a `cancel` /
   * `error` from the agent — none of which emits `turn_end`. The drain
   * cannot tell these apart; it reports them as one class, not as finished.
   */
  endedWithoutTurnEnd: string[];
  /** Agents still busy when the window closed or the drain was aborted. */
  busyAtEnd: string[];
  aborted: boolean;
  waitedMs: number;
}

export interface DrainDeps {
  /** `BusCore.busyAgents()` (falls back to `activeTurnAgents()` on an older core). */
  busyAgents: () => string[];
  /** Subscribe to `response.turn_end`; the handler receives the agent id. Returns unsubscribe. */
  onTurnEnd?: (handler: (agentId: string) => void) => () => void;
  /** A second SIGTERM/SIGINT sets this: stop waiting, tear down now. */
  shouldAbort?: () => boolean;
  log?: (line: string) => void;
  /** Injected for tests. Monotonic clock (ms). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Grace after the last busy agent clears, for the reply send to leave the adapter. */
  settleMs?: number;
}

export const DEFAULT_DRAIN_TURNS_MS = 30_000;
const POLL_MS = 250;
const DEFAULT_SETTLE_MS = 1_000;

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Wait until no agent is busy, or until `maxMs` elapses, or until aborted.
 * `maxMs <= 0` disables the wait (returns at once, still reports what was
 * busy so the operator sees it in the log).
 */
export async function drainActiveTurns(maxMs: number, deps: DrainDeps): Promise<DrainOutcome> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => undefined);
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const startedAt = now();
  const busyAtStart = deps.busyAgents();
  const finished = new Set<string>();
  const done = (busyAtEnd: string[], aborted: boolean): DrainOutcome => {
    const endedWithoutTurnEnd = busyAtStart.filter(
      (a) => !finished.has(a) && !busyAtEnd.includes(a),
    );
    return {
      busyAtStart,
      finished: [...finished],
      endedWithoutTurnEnd,
      busyAtEnd,
      aborted,
      waitedMs: now() - startedAt,
    };
  };
  if (maxMs <= 0 && busyAtStart.length === 0) return done([], false);
  // Subscribe before any waiting: a turn that starts AND ends between two
  // polls is never seen in the busy set, only through its `turn_end`
  // (CodeRabbit on the PR). Its reply then gets the settle grace from that
  // moment, not from the signal.
  let lastTurnEndAt: number | null = null;
  const unsubscribe = deps.onTurnEnd?.((agentId) => {
    finished.add(agentId);
    lastTurnEndAt = now();
  });
  if (busyAtStart.length === 0) {
    // #420: adapters stay live until the teardown that follows, so a prompt
    // accepted right after SIGTERM can enter the busy set a few ms from now.
    // Give it the settle grace before concluding there is nothing to wait for;
    // if something shows up, drain it like any other.
    const hardStop = startedAt + maxMs;
    let settleUntil = Math.min(now() + settleMs, hardStop);
    let late: string[] = [];
    while (now() < settleUntil && late.length === 0) {
      if (deps.shouldAbort?.()) {
        unsubscribe?.();
        return done([], true);
      }
      await sleep(Math.min(POLL_MS, Math.max(1, settleUntil - now())));
      late = deps.busyAgents();
      // a turn ended while we were not looking: its reply is still on its way out
      if (lastTurnEndAt !== null) settleUntil = Math.min(lastTurnEndAt + settleMs, hardStop);
    }
    if (late.length === 0) {
      unsubscribe?.();
      return done([], false);
    }
    log(
      `[shutdown] ${late.length} agent(s) became busy right after the signal (${late.join(", ")}) — draining them`,
    );
    busyAtStart.push(...late);
  }
  if (maxMs <= 0) {
    log(
      `[shutdown] ${busyAtStart.length} agent(s) still busy (${busyAtStart.join(", ")}) — ` +
        "drain disabled (settings.shutdown.drainTurnsMs = 0); stopping now, their replies are lost",
    );
    unsubscribe?.();
    return done(busyAtStart, false);
  }
  log(
    `[shutdown] ${busyAtStart.length} agent(s) still busy (${busyAtStart.join(", ")}) — ` +
      `draining for up to ${secs(maxMs)} before stopping (settings.shutdown.drainTurnsMs); ` +
      "a second SIGTERM/SIGINT stops the wait",
  );
  let busy = busyAtStart;
  let aborted = false;
  try {
    while (busy.length > 0 && now() - startedAt < maxMs) {
      if (deps.shouldAbort?.()) {
        aborted = true;
        break;
      }
      await sleep(Math.min(POLL_MS, Math.max(1, maxMs - (now() - startedAt))));
      busy = deps.busyAgents();
    }
    if (busy.length === 0 && settleMs > 0 && !aborted) {
      // The last reply may still be on its way out of an adapter. Sleep in
      // slices so a second signal during the grace still aborts.
      const settleUntil = Math.min(now() + settleMs, startedAt + maxMs);
      while (now() < settleUntil) {
        if (deps.shouldAbort?.()) {
          aborted = true;
          break;
        }
        await sleep(Math.min(POLL_MS, Math.max(1, settleUntil - now())));
      }
      busy = deps.busyAgents();
    }
  } finally {
    unsubscribe?.();
  }
  const out = done(busy, aborted);
  const parts: string[] = [];
  if (out.finished.length)
    parts.push(`${out.finished.length} turn(s) finished (${out.finished.join(", ")})`);
  if (out.endedWithoutTurnEnd.length)
    parts.push(
      `${out.endedWithoutTurnEnd.length} agent(s) ended without a turn_end (${out.endedWithoutTurnEnd.join(", ")}) — ` +
        "connection closed, cancelled or errored; if the claude child died with the daemon's signal " +
        "(systemd KillMode=control-group) that reply is lost",
    );
  if (out.busyAtEnd.length)
    parts.push(
      `${out.busyAtEnd.length} agent(s) still busy (${out.busyAtEnd.join(", ")}) — stopping anyway; their replies are lost`,
    );
  const how = aborted
    ? `drain aborted by a second signal after ${secs(out.waitedMs)}`
    : busy.length === 0
      ? `drain complete after ${secs(out.waitedMs)}`
      : `drain window (${secs(maxMs)}) elapsed`;
  log(`[shutdown] ${how}: ${parts.join("; ") || "nothing left to wait for"} — stopping`);
  return out;
}
