/**
 * Bus runtime daemon mount.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §10 Sprint 5 +
 * §5.3 / §5.4. This is the entrypoint that wires the Sprint 1-4 Bus
 * components into a running daemon when `settings.runtime === "bus"`.
 *
 * Sprint 5.1 (PR #118) shipped the scaffold:
 *   - BusCore with UDS / TCP-fallback IPC server.
 *   - SessionManager (constructed only).
 *   - Slash-command relay via `wireSlashCommands`.
 *   - Teardown handle.
 *
 * Sprint 5.2a adds:
 *   - Auto-spawn of named agents from `settings.agents` (resolved into
 *     `AgentConfig` via `resolveBusAgentConfigs`). Issue #165: this spawn
 *     is now skippable at mount via `deferSpawn: true` — the daemon then
 *     calls `handle.spawnAgents()` after the MCP multiplexer issuer is
 *     wired, so spawned agents get a synthesized `--mcp-config`.
 *   - `BusRuntimeHandle.stop()` now stops every spawned agent in addition
 *     to tearing down BusCore.
 *   - Rollback of partial mounts: if agent N+1 fails to spawn, agents
 *     0..N are stopped before the error is re-thrown. The same batch
 *     rollback backs `handle.spawnAgents()`.
 *
 * Sprint 5.2b will follow with adapter wiring (Discord / Telegram /
 * Slack / WebUi) using a routing-config schema; Sprint 5.2c adds
 * `BusScheduler` integration. This file stays small by keeping
 * routing + scheduling as future responsibilities.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, BusOrigin } from "./types";
import { BusCoreImpl, type BusCore } from "./core";
import { SessionManager } from "./session-manager";
import { wireSlashCommands } from "./wiring";
import { createMcpReconciler } from "./mcp-reconciler";
import type { MountedAdapter } from "./adapter-wiring";
import { stopBusAdapters } from "./adapter-wiring";
import { detectOrphanAgents, formatOrphanWarnings } from "./orphan-agent-detect";
import { createPromptStreamHandler } from "./receipt-wiring";
import { peekSession } from "../sessions";
import { generateSummary } from "../rotation";
import { getSettings } from "../config";

export interface BusRuntimeHandle {
  /** The mounted BusCore. Adapters / tests subscribe via this. */
  bus: BusCore;
  /** The mounted SessionManager. Adapters call `getAgent()` etc. on this. */
  sessionManager: SessionManager;
  /** The resolved UDS path the IPC server bound to. Logged at start. */
  socketPath: string;
  /**
   * The list of agents successfully spawned by `mountBusRuntime`. Empty
   * when the caller passed no agents (Sprint 5.1 scaffold mode). The
   * daemon uses this in logs and the order doubles as the stop order
   * (reverse-iterated for symmetry with construction).
   */
  spawnedAgentIds: readonly string[];
  /**
   * The adapters whose lifecycle is owned by this handle. Sprint 5.2b
   * (PR #123) Codex P2 fold-in: the daemon now wires adapters AFTER
   * `mountBusRuntime` returns (so adapters never poll before the bus
   * IPC server + agents are live) and registers them via
   * `attachAdapters` for `stop()` to tear down. Empty until at least
   * one `attachAdapters` call.
   */
  mountedAdapterNames: readonly MountedAdapter["name"][];
  /**
   * Spawn agents after mount (issue #165). Used with `deferSpawn: true`:
   * the daemon mounts the bus, wires the MCP multiplexer identity issuer,
   * then calls this so the spawned `claude` PTYs get a synthesized
   * `--mcp-config` for `mcp.shared` servers.
   *
   * `batch` defaults to the `agents` passed at mount. Spawns sequentially;
   * on the first failure rolls back the agents THIS call spawned and
   * re-throws (the daemon's catch then calls `handle.stop()` + falls back
   * to legacy surfaces). Throws if the handle has already been stopped.
   */
  spawnAgents(batch?: readonly AgentConfig[], spawnOriginOverride?: BusOrigin): Promise<void>;
  /**
   * Restart-based session rotation for one agent (#227). Drops the live PTY,
   * mints a fresh session id, respawns, and best-effort summarizes the old
   * session in the background. Wired into the bridge's post-turn rotation gate
   * (`streamBusPrompt`'s `rotateAgent` option) so a threshold trip actually
   * rotates the live conversation instead of only logging a warning.
   */
  rotateAgent(agentId: string): Promise<void>;
  /**
   * Register adapters with the handle's stop lifecycle. Sprint 5.2b
   * (PR #123) Codex P1/P2 fold-in: callers wire adapters AFTER the
   * bus is mounted; this method lets the handle own teardown even
   * though construction happened outside the mount function.
   *
   * Multiple calls accumulate — operators can register subsets in
   * different phases if needed. Adapters are stopped in reverse
   * REGISTRATION order on stop().
   */
  attachAdapters(adapters: readonly MountedAdapter[]): void;
  /**
   * Register a BusScheduler handle with the stop lifecycle. Sprint
   * 5.2c (PR #125). The scheduler is constructed AFTER mount returns
   * (so it can dispatch through the live bus) and registered here so
   * `handle.stop()` cancels every trigger + stops the scheduler
   * before tearing down agents + bus. Only one scheduler can be
   * attached; subsequent calls overwrite the previous one (and stop
   * the previous one first so timers don't leak).
   */
  attachScheduler(scheduler: AttachedScheduler | null): void;
  /**
   * Tear down adapters + scheduler + agents + bus in reverse-
   * construction order. Idempotent; call as many times as you want.
   */
  stop(): Promise<void>;
}

/**
 * Minimal shape `attachScheduler` expects — the concrete
 * `BusSchedulerHandle` from `scheduler-wiring.ts` satisfies it. Kept
 * minimal here so `runtime-mount` doesn't pull a transitive
 * dependency on the scheduler module (which would cycle if the
 * scheduler ever needs the mount).
 */
export interface AttachedScheduler {
  stop(): Promise<void>;
}

export interface MountBusRuntimeOptions {
  /**
   * Override the IPC socket path. Default resolves via
   * `XDG_RUNTIME_DIR ?? ~/.claudeclaw/run` + `bus.sock` — identical
   * to the path `SessionManager` will tell spawned agents to dial.
   */
  socketPath?: string;
  /**
   * Agents to auto-spawn at mount time. Each entry is the spawnable
   * `AgentConfig` shape (post-resolution). Empty / absent = mount the
   * stack with no agents (Sprint 5.1 scaffold mode).
   *
   * Origin tag: each agent is associated with a `BusOrigin` for the
   * spawn call's supervision-mode default. `"system"` is the most
   * generic — operators can override the supervision mode per-agent if
   * they need to.
   */
  agents?: readonly AgentConfig[];
  /**
   * Defer the eager agent spawn (issue #165). When true, `mountBusRuntime`
   * brings up the bus + slash relay + orphan scan but does NOT spawn the
   * `agents` at mount time — the caller spawns them later via
   * `handle.spawnAgents()`, once the MCP multiplexer issuer is wired.
   *
   * Why this exists: the daemon wires the multiplexer identity issuer
   * AFTER `mountBusRuntime` (it depends on `pluginManager.startServices()`).
   * If agents spawn at mount, their `claude` PTYs are built before the
   * issuer exists, so `buildClaudeArgs` synthesizes no `--mcp-config` and
   * every `mcp.shared` server is unreachable for the agent's whole life.
   * Deferring the spawn lets the daemon wire the issuer first.
   *
   * `agents` is still passed (so the orphan-agent scan + startup log see
   * the full declared set); only the spawn is held back. Backward
   * compatible: callers that don't set this keep the eager-spawn behaviour.
   */
  deferSpawn?: boolean;
  /**
   * `BusOrigin` tag passed to `sessionManager.spawnAgent(agent, origin)`.
   * The agent's resolved `supervision` field takes precedence over the
   * origin-based picker (Codex P1 fold-in from PR #122 — see
   * `resolveBusAgentConfig` for why the resolver now defaults
   * supervision to `pty-stdin` directly).
   *
   * Defaults to `"cli"` — a real `BusOrigin` value that's
   * uncategorised among the channel-driven set, so the picker behaviour
   * stays predictable for agents that DO leave supervision unset.
   */
  spawnOrigin?: BusOrigin;
  /**
   * Project root used by the orphan-agent detector (issue #167) to scan
   * `agents/<name>/jobs/` for directories the operator has populated but
   * not declared in `settings.agents[]`. Defaults to `process.cwd()`.
   * Tests inject a fixture root.
   */
  projectRoot?: string;
  /**
   * Adapters already mounted by the daemon (Sprint 5.2b). The mount
   * function does not construct adapters itself — the daemon wires
   * them via `wireBusAdapters` and passes the result in here so the
   * `BusRuntimeHandle.stop()` lifecycle owns them.
   *
   * Stop ordering on shutdown: adapters first (so live traffic stops
   * reaching the bus), then agents (clean `/quit`), then bus IPC.
   */
  adapters?: readonly MountedAdapter[];
  /**
   * Test seam: inject a pre-built `BusCore` (lets the smoke test exercise
   * the mount path without binding a real UDS).
   */
  bus?: BusCore;
  /**
   * Test seam: inject a pre-built `SessionManager`.
   */
  sessionManager?: SessionManager;
  /** Logger. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/**
 * Resolve the daemon-side IPC socket path. The SessionManager mirrors
 * this resolution for child processes (see `resolveBusSocketPath` in
 * `session-manager.ts`); both functions must stay in sync so the
 * spawned `claude` connects to the path the daemon is listening on.
 *
 * Exported so callers that construct `BusCore` + `SessionManager`
 * eagerly (e.g. `start.ts` when wiring adapters before mount) can use
 * the exact same path the mount would have computed. Without this,
 * adapters and agents would dial different sockets.
 */
export function resolveDaemonSocketPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.CCAW_BUS_SOCK;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length > 0
      ? process.env.XDG_RUNTIME_DIR
      : join(homedir(), ".claudeclaw", "run");
  return join(runtimeDir, "bus.sock");
}

/**
 * Injectable dependencies for {@link createRotateAgent}. Kept narrow so the
 * rotation orchestration is unit-testable without spawning a real PTY, reading
 * settings, or shelling out to the summarizer.
 */
export interface RotateAgentDeps {
  /** Drop the live PTY + mint a fresh session id + respawn (the #226 primitive, with reason "rotation"). */
  restart: (agentId: string) => Promise<unknown>;
  /** The agent's CURRENT (about-to-be-rotated) session id, read BEFORE restart. */
  peekSessionId: (agentId: string) => Promise<string | undefined>;
  /** Summarize a (no-longer-live) session id into the summary dir. */
  summarize: (sessionId: string, summaryPath: string) => Promise<unknown>;
  /** Resolve the configured summary dir, or "" to skip summarization. Must not throw. */
  getSummaryPath: () => string;
  logger: Pick<Console, "warn" | "error">;
}

/**
 * Build the restart-based session-rotation orchestrator (#227).
 *
 * Order matters: capture the OLD session id, then `restart()` (which drops the
 * live PTY, mints+persists a fresh session id, respawns — re-arming the message
 * counter via the new session.json), THEN summarize the OLD id. Summarizing
 * after the restart is what sidesteps claude's locked-`--resume` refusal (the
 * old id is no longer live — #227 critical 3), and it runs in the background so
 * the turn that tripped the threshold isn't blocked on the ~60s summarizer.
 */
export function createRotateAgent(deps: RotateAgentDeps): (agentId: string) => Promise<void> {
  return async (agentId: string): Promise<void> => {
    let oldSessionId: string | undefined;
    try {
      oldSessionId = await deps.peekSessionId(agentId);
    } catch (err) {
      deps.logger.warn(`[bus-runtime] rotation: peek session for ${agentId} failed`, err);
    }

    // A rotation restart drops the live PTY BEFORE respawning. If the respawn
    // throws (spawn-time fault), the agent is left with no live process — worse
    // than the pre-#227 "warn and keep serving". restart() is budget-exempt for
    // rotation so it won't rate-limit-throw, but a genuine spawn fault still can.
    // Surface it as CRITICAL (watchdog-keyable) and rethrow so the caller does
    // NOT mistake a failed rotation for a successful one.
    try {
      await deps.restart(agentId);
    } catch (err) {
      deps.logger.error(
        `[bus-runtime] CRITICAL agent=${agentId} rotation restart failed — ` +
          `the agent may have no live PTY until it is respawned (operator/watchdog action needed)`,
        err,
      );
      throw err;
    }

    const summaryPath = deps.getSummaryPath();
    if (oldSessionId && summaryPath) {
      void deps
        .summarize(oldSessionId, summaryPath)
        .catch((err) =>
          deps.logger.warn(`[bus-runtime] rotation summary for ${agentId} failed`, err),
        );
    }
  };
}

/**
 * Mount the Bus runtime stack and return a teardown handle.
 *
 * Idempotency: each call returns a fresh handle. Callers must invoke
 * `stop()` on the returned handle (or use the test seams) — `mountBusRuntime`
 * does not track previous mounts.
 *
 * Failure semantics: if any step throws, prior steps are rolled back in
 * reverse order so the caller sees a clean failure rather than a
 * half-mounted daemon. This mirrors Sprint 4's `SlackAdapter.start()`
 * rollback pattern (Codex PR #117 P2 fix).
 */
export async function mountBusRuntime(
  opts: MountBusRuntimeOptions = {},
): Promise<BusRuntimeHandle> {
  const logger = opts.logger ?? console;
  const socketPath = resolveDaemonSocketPath(opts.socketPath);
  const origin: BusOrigin = opts.spawnOrigin ?? "cli";

  const bus: BusCore = opts.bus ?? new BusCoreImpl({ socketPath });
  const sessionManager: SessionManager =
    opts.sessionManager ?? new SessionManager({ busSocketPath: socketPath, bus });

  let busStarted = false;
  const spawned: string[] = [];

  try {
    await bus.start();
    busStarted = true;

    // The slash relay closes the seam Sprint 4 left open: when an adapter
    // invokes `bus.invokeSlashCommand`, the bus now knows how to route it
    // through the SessionManager's per-agent process handle.
    wireSlashCommands(bus, sessionManager);
    // Wire PTY-stdin prompt delivery: route inbound prompts to the agent's
    // REPL so headless claudes (which ignore the MCP channel notification)
    // start a turn. Receipt chain (issue #207): the helper looks up the open
    // receipt by `prompt_hash`, back-fills pid + generation + stamps
    // `stdin_written_at` on success, and closes as `stale_session` if the
    // PTY write fails or no process is registered. The caller (e.g. the
    // webui bridge) still owns the terminal close on observed/timeout.
    bus.setStreamPromptHandler(
      createPromptStreamHandler((agentId) => sessionManager.getAgent(agentId)),
    );

    // #222 reconciliation: when an IPC send fails because the agent's MCP
    // registration is gone but its process is still alive (the recurring
    // deaf-agent wedge), respawn it via the Session Manager. Confirm-delay +
    // cooldown + attempt cap live in the reconciler so this never storms or
    // kills an agent that's merely mid-spawn.
    bus.setMcpSendFailedHandler(
      createMcpReconciler({
        isConnected: (agentId) => bus.isAgentConnected(agentId),
        isProcessAlive: (agentId) => sessionManager.health()[agentId]?.alive ?? false,
        isTurnActive: (agentId) => bus.isAgentTurnActive(agentId),
        restart: (agentId) => sessionManager.restart(agentId),
        log: (msg, fields) => logger.error("[mcp-reconcile]", msg, fields),
      }),
    );

    // #227 restart-based session rotation. The bus PTY is spawned once at boot
    // and kept alive, so the session JSONL grows unbounded and per-prompt
    // latency creeps up (#213). When the per-agent message/age threshold trips,
    // the bridge calls this to actually rotate: restart() drops the live PTY,
    // mints+persists a FRESH session id, and respawns (criticals 1 & 2 — the
    // counter re-arms because a new session.json exists). The summary is the
    // rotation caller's concern per restart()'s contract: generated against the
    // now-freed OLD id (never the live one — critical 3) and in the background
    // so the turn that tripped the threshold isn't blocked on the summarizer.
    // (Injecting that summary into the fresh PTY's bootstrap has no bus consumer
    // yet — the legacy runner consumes loadLatestSummary, the bus spawn path
    // does not — so it stays a follow-up.)
    // Declared before the rotation wiring so `getSummaryPath` can short-circuit
    // once teardown has begun — never start a new ~60s summary subprocess while
    // the handle is stopping (it would outlive stop()). Set true in stop().
    let stopped = false;

    const rotateAgent = createRotateAgent({
      restart: (id) => sessionManager.restart(id, { reason: "rotation" }),
      peekSessionId: async (id) => (await peekSession(id))?.sessionId,
      summarize: generateSummary,
      getSummaryPath: () => {
        if (stopped) return ""; // tearing down — don't spawn a new summarizer
        try {
          return getSettings().session.summaryPath ?? "";
        } catch {
          return ""; // settings not loaded (early boot / tests) — skip summary
        }
      },
      logger,
    });

    const declaredAgents = opts.agents ?? [];

    // Spawn a batch of agents sequentially (readable logs + failures
    // surface against a known id rather than an unrelated parallel
    // reject). On the first failure, roll back ONLY the agents this batch
    // spawned (reverse order) and re-throw — agents from an earlier
    // successful batch stay up; the caller decides whether to tear the
    // whole handle down. Shared by the eager mount path and the deferred
    // `handle.spawnAgents()` path (issue #165).
    async function spawnAgentBatch(
      batch: readonly AgentConfig[],
      batchOrigin: BusOrigin,
    ): Promise<void> {
      const spawnedThisBatch: string[] = [];
      for (const agent of batch) {
        try {
          await sessionManager.spawnAgent(agent, batchOrigin);
          spawned.push(agent.id);
          spawnedThisBatch.push(agent.id);
          logger.info(`[bus-runtime] spawned agent=${agent.id}`);
        } catch (err) {
          for (let i = spawnedThisBatch.length - 1; i >= 0; i--) {
            const id = spawnedThisBatch[i];
            try {
              await sessionManager.stop(id);
            } catch (stopErr) {
              logger.error(`[bus-runtime] rollback: failed to stop agent=${id}`, stopErr);
            }
            const idx = spawned.lastIndexOf(id);
            if (idx >= 0) spawned.splice(idx, 1);
          }
          throw new Error(
            `[bus-runtime] failed to spawn agent="${agent.id}": ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
    }

    // Eager spawn unless the caller deferred it (issue #165). When
    // deferred, the daemon calls `handle.spawnAgents()` after wiring the
    // MCP multiplexer issuer.
    if (!opts.deferSpawn) {
      await spawnAgentBatch(declaredAgents, origin);
    }

    // Adapters list is now MUTABLE — Sprint 5.2b (PR #123) Codex P2
    // fold-in lets the caller register adapters AFTER mount returns via
    // `attachAdapters`. Backwards-compatible: `opts.adapters` still
    // accepted for callers that wired before mount.
    // Issue #167: catch the silent-job-death class (operator has
    // agents/<name>/jobs/* on disk but didn't declare <name> in
    // settings.agents[], so prompts publish with no consumer). Pure scan,
    // fires once at startup.
    const orphanReport = detectOrphanAgents(opts.agents ?? [], opts.projectRoot ?? process.cwd());
    for (const line of formatOrphanWarnings(orphanReport)) {
      logger.warn(line);
    }

    const adapters: MountedAdapter[] = opts.adapters ? [...opts.adapters] : [];
    // Sprint 5.2c (PR #125): the daemon attaches a `BusScheduler`
    // handle after mount so heartbeat + cron triggers are torn down
    // alongside adapters + agents + bus. Only one scheduler can be
    // attached at a time.
    let attachedScheduler: AttachedScheduler | null = null;
    const spawnedLabel = spawned.length === 0 ? "no agents" : `agents=[${spawned.join(", ")}]`;
    const adaptersLabel =
      adapters.length === 0
        ? "no adapters"
        : `adapters=[${adapters.map((a) => a.name).join(", ")}]`;
    logger.info(`[bus-runtime] mounted; socket=${socketPath}; ${spawnedLabel}; ${adaptersLabel}`);

    return {
      bus,
      sessionManager,
      socketPath,
      rotateAgent,
      get spawnedAgentIds() {
        // Snapshot via getter so the handle reflects the current state
        // even after stop() empties the list.
        return [...spawned];
      },
      get mountedAdapterNames() {
        return adapters.map((a) => a.name);
      },
      async spawnAgents(batch, spawnOriginOverride) {
        if (stopped) {
          throw new Error("[bus-runtime] spawnAgents called on a stopped handle");
        }
        await spawnAgentBatch(batch ?? declaredAgents, spawnOriginOverride ?? origin);
      },
      attachAdapters(more) {
        if (stopped) {
          // The handle has already torn down; tearing down the new
          // adapters immediately is the safest reaction so they don't
          // leak. Schedule on the microtask queue so the call itself
          // stays sync.
          for (const a of more) {
            Promise.resolve()
              .then(() => a.stop())
              .catch((err) => logger.error(`[bus-runtime] post-stop attach: ${a.name}`, err));
          }
          return;
        }
        for (const a of more) adapters.push(a);
      },
      attachScheduler(scheduler) {
        if (stopped) {
          // Same defence as attachAdapters: tear down immediately on
          // microtask so the late scheduler doesn't leak its timers.
          if (scheduler) {
            Promise.resolve()
              .then(() => scheduler.stop())
              .catch((err) => logger.error("[bus-runtime] post-stop attachScheduler", err));
          }
          return;
        }
        // Replacing an existing scheduler stops the previous one
        // first so its timers don't leak.
        if (attachedScheduler && attachedScheduler !== scheduler) {
          const prev = attachedScheduler;
          Promise.resolve()
            .then(() => prev.stop())
            .catch((err) => logger.error("[bus-runtime] previous scheduler.stop()", err));
        }
        attachedScheduler = scheduler;
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        // Adapters first: stop inbound traffic so nothing new hits the
        // bus while we're tearing down agents. Sprint 5.2b.
        await stopBusAdapters(adapters, logger);
        // Scheduler next: cancel every recurring trigger so heartbeats
        // / crons don't fire mid-teardown. Sprint 5.2c.
        if (attachedScheduler) {
          try {
            await attachedScheduler.stop();
          } catch (err) {
            logger.error("[bus-runtime] scheduler.stop() failed", err);
          }
          attachedScheduler = null;
        }
        // Detach the slash handler so any closure in `wireSlashCommands`
        // can't reach a torn-down SessionManager.
        try {
          bus.setSlashCommandHandler(null);
          bus.setStreamPromptHandler(null);
          bus.setMcpSendFailedHandler(null);
        } catch (err) {
          logger.error("[bus-runtime] setSlashCommandHandler(null) failed", err);
        }
        // Stop every spawned agent BEFORE the bus IPC server closes so
        // claude children get a clean `/quit` rather than an aborted
        // socket. Reverse order mirrors construction.
        for (let i = spawned.length - 1; i >= 0; i--) {
          const id = spawned[i];
          try {
            await sessionManager.stop(id);
          } catch (err) {
            logger.error(`[bus-runtime] sessionManager.stop(${id}) failed`, err);
          }
        }
        spawned.length = 0;
        try {
          await bus.stop();
        } catch (err) {
          logger.error("[bus-runtime] bus.stop() failed", err);
        }
      },
    };
  } catch (err) {
    if (busStarted) {
      // Mirror the happy-path teardown order: detach handler, stop any
      // surviving agents (already cleared above on spawn failure, but
      // belt-and-braces), then stop the bus.
      try {
        bus.setSlashCommandHandler(null);
        bus.setStreamPromptHandler(null);
        bus.setMcpSendFailedHandler(null);
      } catch {
        /* ignore — surfacing the original error matters more. */
      }
      for (let i = spawned.length - 1; i >= 0; i--) {
        try {
          await sessionManager.stop(spawned[i]);
        } catch {
          /* ignore */
        }
      }
      try {
        await bus.stop();
      } catch {
        /* ignore — surfacing the original error matters more. */
      }
    }
    throw err;
  }
}
