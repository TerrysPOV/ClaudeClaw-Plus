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
 * Sprint 5.2a (this PR) adds:
 *   - Auto-spawn of named agents from `settings.agents` (resolved into
 *     `AgentConfig` via `resolveBusAgentConfigs`).
 *   - `BusRuntimeHandle.stop()` now stops every spawned agent in addition
 *     to tearing down BusCore.
 *   - Rollback of partial mounts: if agent N+1 fails to spawn, agents
 *     0..N are stopped before the error is re-thrown.
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
import type { MountedAdapter } from "./adapter-wiring";
import { stopBusAdapters } from "./adapter-wiring";

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
    opts.sessionManager ?? new SessionManager({ busSocketPath: socketPath });

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
    // start a turn. No-op for agents whose process doesn't support streaming.
    bus.setStreamPromptHandler(async (agentId, text) => {
      const proc = sessionManager.getAgent(agentId);
      if (proc && typeof proc.send_prompt_stream === "function") {
        await proc.send_prompt_stream(text);
      }
    });

    // Auto-spawn declared agents. Sequential rather than parallel so
    // log output stays readable + spawn failures surface against a
    // known agent id rather than an unrelated parallel reject.
    for (const agent of opts.agents ?? []) {
      try {
        await sessionManager.spawnAgent(agent, origin);
        spawned.push(agent.id);
        logger.info(`[bus-runtime] spawned agent=${agent.id}`);
      } catch (err) {
        // Stop any already-spawned agents in reverse order before
        // bubbling. The outer catch handles bus teardown.
        for (let i = spawned.length - 1; i >= 0; i--) {
          try {
            await sessionManager.stop(spawned[i]);
          } catch (stopErr) {
            logger.error(`[bus-runtime] rollback: failed to stop agent=${spawned[i]}`, stopErr);
          }
        }
        spawned.length = 0;
        throw new Error(
          `[bus-runtime] failed to spawn agent="${agent.id}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    // Adapters list is now MUTABLE — Sprint 5.2b (PR #123) Codex P2
    // fold-in lets the caller register adapters AFTER mount returns via
    // `attachAdapters`. Backwards-compatible: `opts.adapters` still
    // accepted for callers that wired before mount.
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

    let stopped = false;
    return {
      bus,
      sessionManager,
      socketPath,
      get spawnedAgentIds() {
        // Snapshot via getter so the handle reflects the current state
        // even after stop() empties the list.
        return [...spawned];
      },
      get mountedAdapterNames() {
        return adapters.map((a) => a.name);
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
