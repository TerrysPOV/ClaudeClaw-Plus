/**
 * MCP/IPC reconciliation (issue #222).
 *
 * Root-cause class addressed: an agent's `claude` process stays alive but its
 * MCP/IPC registration with Bus core is gone (segfault-respawn of the bus MCP
 * subprocess, peer reset, a fresh mcp-server that never re-handshakes). Bus
 * core's `connectionsByAgent` then has no socket for the agent, so every
 * `sendPrompt` returns false ("No MCP connection") AND the agent's outbound
 * `reply` rides the same dead IPC with no fallback — the agent goes deaf.
 *
 * The pre-existing mcp-server reconnect logic only recovers an in-process
 * socket drop. It does NOT recover the case where the whole mcp-server PROCESS
 * dies and is relaunched (observed live 2026-06-07: a 1-min-old mcp-server
 * under a 6h-old agent, send failing 15×+). This reconciler closes that gap at
 * the process level: on the send-fail signal, confirm the agent is still
 * disconnected after a short window (so we don't kill an agent mid-spawn whose
 * mcp-server simply hasn't handshaked yet), then respawn it via the Session
 * Manager's existing `restart()` primitive.
 *
 * Safety rails:
 *   - confirm-delay: ignore the first signal for `confirmMs`; re-check before
 *     acting. A normal spawn's connect window self-heals and is never touched.
 *   - cooldown: at most one restart per agent per `cooldownMs`.
 *   - attempt cap: `maxAttempts` restarts within `windowMs`, then back off and
 *     log loudly (the out-of-process watchdog / a human takes over) — no storm.
 */

export interface McpReconcilerDeps {
  /** True iff Bus core currently holds a live MCP connection for the agent. */
  isConnected(agentId: string): boolean;
  /** True iff the agent's process is alive (not exited) per the Session Manager. */
  isProcessAlive(agentId: string): boolean;
  /** Respawn the agent (Session Manager `restart()` — same session_id, resumes). */
  restart(agentId: string): Promise<unknown>;
  /** Structured logger. Lands in the daemon log, grep-able. */
  log(msg: string, fields: Record<string, unknown>): void;
  /** Schedule a callback. Injectable for tests. Returns a handle to cancel. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Clock. Injectable for tests. */
  now?: () => number;
}

export interface McpReconcilerOptions {
  /** Wait this long after a signal, then re-check before acting (default 5s). */
  confirmMs?: number;
  /** Minimum interval between restarts per agent (default 60s). */
  cooldownMs?: number;
  /** Max restarts within `windowMs` before backing off (default 3). */
  maxAttempts?: number;
  /** Rolling window for the attempt cap (default 15min). */
  windowMs?: number;
}

export type McpSendFailedHandler = (agentId: string, ctx: { reason: string }) => void;

interface AgentState {
  /** A confirm-check is already scheduled — coalesce further signals. */
  pendingConfirm: boolean;
  /** A restart is in flight — don't pile on. */
  inFlight: boolean;
  /** Timestamps of recent restarts (within `windowMs`). */
  restartHistory: number[];
}

export function createMcpReconciler(
  deps: McpReconcilerDeps,
  opts: McpReconcilerOptions = {},
): McpSendFailedHandler {
  const confirmMs = opts.confirmMs ?? 5_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      // Don't keep the daemon alive solely for a reconcile timer.
      (t as { unref?: () => void }).unref?.();
      return t;
    });

  const states = new Map<string, AgentState>();
  const stateFor = (id: string): AgentState => {
    let s = states.get(id);
    if (!s) {
      s = { pendingConfirm: false, inFlight: false, restartHistory: [] };
      states.set(id, s);
    }
    return s;
  };

  function attempt(agentId: string, reason: string): void {
    const s = stateFor(agentId);
    s.pendingConfirm = false;

    // Self-healed during the confirm window (mcp-server (re)connected) — done.
    if (deps.isConnected(agentId)) {
      deps.log("reconcile-recovered", {
        agent: agentId,
        note: "reconnected during confirm window",
      });
      return;
    }
    // Process is gone (or never spawned): the Session Manager's own onExit /
    // supervisor owns respawn. The reconciler only handles alive-but-deaf.
    if (!deps.isProcessAlive(agentId)) {
      deps.log("reconcile-skip", { agent: agentId, reason: "process-not-alive" });
      return;
    }
    if (s.inFlight) return;

    const t = now();
    s.restartHistory = s.restartHistory.filter((ts) => t - ts < windowMs);
    const last = s.restartHistory[s.restartHistory.length - 1] ?? 0;
    if (last && t - last < cooldownMs) {
      deps.log("reconcile-skip", {
        agent: agentId,
        reason: "cooldown",
        sinceLastMs: t - last,
      });
      return;
    }
    if (s.restartHistory.length >= maxAttempts) {
      deps.log("reconcile-giveup", {
        agent: agentId,
        attempts: s.restartHistory.length,
        windowMs,
        note: "attempt cap hit — backing off, watchdog/human takes over",
      });
      return;
    }

    s.inFlight = true;
    const attemptNo = s.restartHistory.length + 1;
    deps.log("reconcile-restart", { agent: agentId, attempt: attemptNo, reason });
    Promise.resolve(deps.restart(agentId))
      .then(() => {
        s.restartHistory.push(now());
        deps.log("reconcile-restart-ok", { agent: agentId, attempt: attemptNo });
      })
      .catch((err) => {
        deps.log("reconcile-restart-failed", { agent: agentId, err: String(err) });
      })
      .finally(() => {
        s.inFlight = false;
      });
  }

  return function onMcpSendFailed(agentId: string, ctx: { reason: string }): void {
    const s = stateFor(agentId);
    if (s.pendingConfirm || s.inFlight) return; // coalesce
    s.pendingConfirm = true;
    deps.log("reconcile-armed", { agent: agentId, reason: ctx.reason, confirmMs });
    setTimer(() => attempt(agentId, ctx.reason), confirmMs);
  };
}
