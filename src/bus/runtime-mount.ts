/**
 * Bus runtime daemon mount (Sprint 5.1).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §10 Sprint 5 +
 * §5.3 / §5.4. This is the entrypoint that wires the Sprint 1-4 Bus
 * components into a running daemon when `settings.runtime === "bus"`.
 *
 * Sprint 5.1 scope (intentional — kept minimal for reviewability):
 *   - Construct + start `BusCore` with its UDS / TCP-fallback IPC server.
 *   - Construct `SessionManager` so future spawn calls are addressable.
 *   - Install slash-command relay via `wireSlashCommands` (the seam BusCore
 *     exposed in Sprint 4).
 *   - Return a teardown handle the daemon can call on SIGTERM.
 *
 * Deferred to Sprint 5.2 (next PR — needs routing-config schema):
 *   - Adapter wiring (DiscordAdapter / TelegramAdapter / SlackAdapter /
 *     WebUiAdapter). Each needs `{channel_id → agent_id}` routing config
 *     that does not yet exist in `settings.json`. Mounting them today
 *     without that config would either silent-drop traffic or require
 *     synthesising a routing layer ad-hoc.
 *   - Auto-spawn of named agents — same reason. Need an `agents: []`
 *     settings block.
 *   - `BusScheduler` for cron/heartbeat — same reason. The legacy
 *     heartbeat config maps to a single agent today; the Bus model wants
 *     per-agent heartbeats.
 *
 * Why this split: Sprint 5.1's job is to prove the Bus stack can boot
 * inside the daemon without breaking the v1 (`runtime: "pty"`) path.
 * Adapter routing + auto-spawn are non-trivial config-schema decisions
 * better handled in their own PR with operator review.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { BusCoreImpl, type BusCore } from "./core";
import { SessionManager } from "./session-manager";
import { wireSlashCommands } from "./wiring";

export interface BusRuntimeHandle {
  /** The mounted BusCore. Adapters / tests subscribe via this. */
  bus: BusCore;
  /** The mounted SessionManager. Future `spawnAgent` calls go here. */
  sessionManager: SessionManager;
  /** The resolved UDS path the IPC server bound to. Logged at start. */
  socketPath: string;
  /** Tear down in reverse-construction order. Idempotent. */
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
 */
function resolveDaemonSocketPath(override?: string): string {
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

  const bus: BusCore = opts.bus ?? new BusCoreImpl({ socketPath });
  const sessionManager: SessionManager =
    opts.sessionManager ?? new SessionManager({ busSocketPath: socketPath });

  let busStarted = false;
  try {
    await bus.start();
    busStarted = true;

    // The slash relay closes the seam Sprint 4 left open: when an adapter
    // invokes `bus.invokeSlashCommand`, the bus now knows how to route it
    // through the SessionManager's per-agent process handle.
    wireSlashCommands(bus, sessionManager);

    logger.info(`[bus-runtime] mounted; socket=${socketPath}`);

    return {
      bus,
      sessionManager,
      socketPath,
      async stop() {
        // Detach the slash handler first so any in-flight adapter event
        // can't reach a torn-down SessionManager.
        try {
          bus.setSlashCommandHandler(null);
        } catch (err) {
          logger.error("[bus-runtime] setSlashCommandHandler(null) failed", err);
        }
        try {
          await bus.stop();
        } catch (err) {
          logger.error("[bus-runtime] bus.stop() failed", err);
        }
        // SessionManager has no global `stop()` — agent cleanup happens
        // per-agent via `sessionManager.stop(agent_id)`. Sprint 5.2 will
        // own the daemon-wide stop semantics once auto-spawn lands.
      },
    };
  } catch (err) {
    if (busStarted) {
      // Mirror the happy-path teardown order documented on `stop()`:
      // detach the slash handler first so any closure `wireSlashCommands`
      // installed before throwing can't reach a torn-down SessionManager,
      // then stop the bus. PR #117 5-agent review (Agent #2 #1).
      try {
        bus.setSlashCommandHandler(null);
      } catch {
        /* ignore — surfacing the original error matters more. */
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
