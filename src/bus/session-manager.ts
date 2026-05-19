/**
 * ClaudeClaw+ Bus runtime — Session Manager.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.3
 *
 * Responsibility: spawn + supervise one `claude` process per Plus agent.
 * Picks a `SupervisionMode` based on origin (channel-driven origins need the
 * PTY-backed REPL; non-channel origins use the lighter `process-stream-json`
 * runner). Provides a stable per-agent handle (`AgentProcess`) with
 * lifecycle methods and slash-command relay.
 *
 * Empirical foundations:
 * - Spike 0.4 — `claude` gates the REPL on `process.stdin.isTTY` AND
 *   `process.stdout.isTTY`. Plain `Bun.spawn({stdin:'pipe'})` downshifts
 *   to `--print` mode within ~3 s, so channel-driven agents must use
 *   `bun-pty`.
 * - Spike 0.5 — JSONL carries no top-level `session.end` marker; process
 *   exit IS the authoritative end signal. `/quit` is `/exit` under the
 *   hood. macOS `/tmp` is a symlink to `/private/tmp` — encoded JSONL
 *   paths must use realpath.
 * - Spike 0.6 — `claude -p --input-format=stream-json` supports long-lived
 *   multi-turn AND slash commands, but silently drops
 *   `notifications/claude/channel` (the entire reason the Bus exists).
 *   Use it only for non-channel origins.
 *
 * Helper classes (`PtyAgentProcess`, `ChildAgentProcess`) live in
 * `session-agent-process.ts` to keep this file under the 500-LOC budget.
 */

import { spawn as nodeSpawnChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanSpawnEnv, withCleanProcessEnv } from "../runner";
import { createSession } from "../sessions";
import {
  type AgentProcess,
  ChildAgentProcess,
  type DataHandler,
  type ExitHandler,
  PtyAgentProcess,
  type PtyHandle,
} from "./session-agent-process";
import {
  type AgentConfig,
  type BusOrigin,
  defaultSupervisionFor,
  type SupervisionMode,
  UDS_PATH_MAX_BYTES,
} from "./types";

/* ───────────────────────────────────────────────────────────────────── */
/* Public surface                                                        */
/* ───────────────────────────────────────────────────────────────────── */

export type { AgentProcess, DataHandler, ExitHandler };

export interface AgentHealth {
  alive: boolean;
  jsonl_recent: boolean;
}

export interface SessionManagerOptions {
  /**
   * Test seam: override the spawned executable (default `"claude"`). The same
   * trick is used by `src/runner/pty-process.ts` so unit tests can swap in
   * `/bin/cat`, `/bin/sh`, etc.
   */
  commandOverride?: string;
  /**
   * Test seam: when set, replaces the claude args list entirely. Used by
   * tests that swap `command` for a stand-in (e.g. `/bin/cat`) which doesn't
   * accept claude's flags.
   */
  argsOverride?: string[];
  /**
   * Test seam: override the IPC socket env propagated to children. When unset
   * we read `CCAW_BUS_SOCK` from the daemon env or fall back to the spec
   * default path (`${XDG_RUNTIME_DIR ?? $HOME/.claudeclaw/run}/bus.sock`).
   */
  busSocketPath?: string;
  /**
   * Window in milliseconds to watch for claude's "Session ID X is already
   * in use" startup error before considering the spawn healthy. On hit
   * the manager rotates the session id (mints a fresh UUID, persists,
   * respawns) once. Default 2000ms — claude emits the marker within
   * ~1s of spawn when the id collides, so 2s gives comfortable headroom
   * without slowing down happy-path spawns. Tests can set to 0 to skip
   * the wait entirely.
   */
  sessionCollisionDetectMs?: number;
  /**
   * Persistence hook invoked after a rotation. Defaults to
   * `createSession(freshId, agent.id)` from `src/sessions.ts`. Override
   * in tests to capture rotation without writing to disk.
   */
  persistRotatedSessionId?: (agentId: string, sessionId: string) => Promise<void>;
  /**
   * Optional logger override. Defaults to `console`.
   */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Helpers                                                               */
/* ───────────────────────────────────────────────────────────────────── */

function resolveBusSocketPath(override?: string): string {
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
 * Resolve `agent.cwd` through realpath to defeat the macOS `/tmp` →
 * `/private/tmp` symlink. The encoded JSONL path under `~/.claude/projects/`
 * uses the realpath as the dir name — naive `cwd` without realpath causes
 * the Sprint 2 tailer to miss the file (Spike 0.5).
 */
export function resolveAgentCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    // cwd may not exist yet (test/setup races); fall back to input.
    return cwd;
  }
}

/**
 * Build the env passed to the spawned child. Reuses `cleanSpawnEnv()` from
 * `src/runner.ts` (the canonical strip-list — DO NOT duplicate, see PR #104
 * for the long-lived `sk-ant-oat01-*` exception).
 */
function buildChildEnv(agent: AgentConfig, busSocketPath: string): Record<string, string> {
  const env = cleanSpawnEnv();
  env.CCAW_AGENT_ID = agent.id;
  env.CCAW_BUS_SOCK = busSocketPath;
  // Pin the bun runtime path to the daemon's own bun rather than
  // whatever `which bun` resolves to in the spawned claude's PATH.
  // Used by `scripts/start-bus-mcp` to launch the plus-bus MCP server.
  // Codex P2 on PR #133 — without this, restricted-PATH deployments
  // (e.g. daemons launched via absolute bun path with a stripped PATH)
  // would fail to start plus-bus.
  env.CCAW_BUS_BUN_PATH = process.execPath;
  // TCP fallback wiring is a stub in Sprint 1 — values flow through if the
  // daemon set them but we do not synthesise them here.
  //
  // PR #110 review (agent #4) flagged that propagating `CCAW_BUS_TOKEN` via
  // process env exposes it on Linux via `/proc/<pid>/environ` to any process
  // on the same UID for the lifetime of the spawned `claude` (the on-disk
  // token file is mode 0600 and avoids this — env-passing reduces that
  // protection to same-UID-only).
  //
  // Mitigation chosen for Sprint 1: only propagate `CCAW_BUS_TOKEN` when
  // `CCAW_BUS_SOCK` is unset, i.e. when the TCP fallback transport is the
  // active path. UDS sessions never need the token (UDS uses filesystem
  // permission bits) so withholding it removes the leak surface entirely
  // for the default transport. Sprint 2's TCP-fallback work (Spike 0.3)
  // will revisit this — options on the table: token via inherited file
  // descriptor instead of env, or short-lived token rotation.
  if (process.env.CCAW_BUS_PORT) env.CCAW_BUS_PORT = process.env.CCAW_BUS_PORT;
  const isTcpTransport = !busSocketPath && !!process.env.CCAW_BUS_PORT;
  if (isTcpTransport && process.env.CCAW_BUS_TOKEN) {
    env.CCAW_BUS_TOKEN = process.env.CCAW_BUS_TOKEN;
  }
  return env;
}

/**
 * Channel name the Bus MCP server registers under inside the spawned
 * `claude`. Matches the `mcpServers` key in the plugin's `.mcp.json`.
 */
export const PLUS_BUS_CHANNEL = "plus-bus";

/**
 * Plugin name as declared in the ClaudeClaw+ plugin's `plugin.json`.
 * Used to construct the tagged channel name claude requires
 * (`plugin:<name>@<marketplace>`).
 */
export const CLAUDECLAW_PLUGIN_NAME = "claudeclaw-plus";

/**
 * "Marketplace" tag claude assigns to plugins loaded via `--plugin-dir`.
 * Observed in the `init` event's `plugins[].source` field
 * (`"claudeclaw-plus@inline"`). We use it to construct the tagged
 * channel name passed to `--dangerously-load-development-channels`.
 */
const PLUGIN_MARKETPLACE_TAG = "inline";

/**
 * MCP tools exposed by the plus-bus channel. Auto-allowed at spawn time
 * via `--allowedTools` so claude doesn't prompt the user before sending
 * an outbound message through the bus — these tools are safe by design
 * (they only call back through the IPC channel, no filesystem / network
 * effects outside the daemon).
 */
const PLUS_BUS_TOOL_NAMES = [
  "mcp__plugin_claudeclaw-plus_plus-bus__reply",
  "mcp__plugin_claudeclaw-plus_plus-bus__ask",
  "mcp__plugin_claudeclaw-plus_plus-bus__cancel",
  "mcp__plugin_claudeclaw-plus_plus-bus__request_human",
];

/**
 * Resolve the absolute path to the ClaudeClaw+ plugin root — the
 * directory containing `.claude-plugin/plugin.json` and `.mcp.json`.
 * Computed from `session-manager.ts`'s own location: this file lives
 * at `<root>/src/bus/session-manager.ts` so two `dirname` hops give us
 * the plugin root. Works regardless of install path (`/opt/claudeclaw`
 * in production, the repo checkout in dev/tests).
 */
export function resolveClaudeclawPluginRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(here)));
}

/**
 * Default window for session-collision detection. Empirically the
 * marker arrives in the first PTY data chunk (~under 1s) when the
 * session id is stale; 2000ms is comfortable headroom for slow boots
 * without delaying happy-path spawns by more than a second.
 */
const DEFAULT_COLLISION_DETECT_MS = 2000;

/**
 * Regex matching claude's "Session ID is already in use" startup error.
 * Permissive on the uuid shape to survive any future formatting tweaks
 * (claude has used both classic 36-char dashed UUIDs and variants).
 */
const SESSION_COLLISION_PATTERN = /Session ID [0-9a-fA-F-]{8,} is already in use/;

/**
 * Watch the spawned agent process for the session-id collision marker
 * during a short window after spawn. Resolves true iff the marker is
 * seen AND the process exits with a non-zero code within the window —
 * both are required because claude can echo a similar string in benign
 * contexts and a stale-id failure always pairs with an immediate
 * exit. Resolves false for: alive past the window, clean exit, exit
 * without the marker.
 */
function detectSessionIdCollision(proc: AgentProcess, windowMs: number): Promise<boolean> {
  if (windowMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let resolved = false;
    let markerSeen = false;
    const finish = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    proc.onData((chunk) => {
      // Early-exit once the detector has resolved (timeout fired, exit
      // observed, or marker matched). `PtyAgentProcess.onData` has a
      // push-only handler array with no removal API, so this listener
      // stays attached for the proc's lifetime; the cheap flag check
      // keeps the regex from running on every PTY chunk after the
      // detection window closes.
      if (resolved) return;
      if (!markerSeen && SESSION_COLLISION_PATTERN.test(chunk)) {
        markerSeen = true;
      }
    });
    proc.onExit((code) => {
      finish(markerSeen && code !== 0);
    });
    setTimeout(() => finish(false), windowMs);
  });
}

/**
 * Build the args list passed to the spawned `claude`.
 *
 * Background — four wire-up attempts before this one worked end-to-end:
 *
 *   1. `--dangerously-load-development-channels plugin:plus-bus@local`
 *      (PR #110) — silently loaded no channel.
 *   2. `--dangerously-load-development-channels server:plus-bus` + a
 *      synth `--mcp-config` (PR #131) — claude 2.1.89 shows an
 *      interactive TUI confirmation prompt the PTY can't dismiss.
 *   3. `--plugin-dir <root>` alone — plugin loads, MCP server
 *      connects, but `notifications/claude/channel` pushes are
 *      silently dropped because the channel-notification subsystem
 *      is opt-in and the plus-bus channel isn't on Anthropic's
 *      default approved-plugins allowlist.
 *   4. `--plugin-dir` + `--settings` with `channelsEnabled` +
 *      `allowedChannelPlugins` — the managed-settings path is only
 *      honoured for `team`/`enterprise` subscription tiers; Pro users
 *      fall back to the baked allowlist.
 *
 * Working approach (this PR):
 *
 *   - `--plugin-dir <root>` declares the ClaudeClaw+ plugin (loads
 *     `.mcp.json` which registers the `plus-bus` stdio MCP server).
 *   - `--dangerously-load-development-channels plugin:claudeclaw-plus@inline`
 *     marks the bus channel as `dev:true`, which bypasses the approved-
 *     plugins allowlist. The TUI confirmation dialog only fires when
 *     `channelsEnabled` AND an OAuth token are both present — since we
 *     never set `channelsEnabled`, claude silently flags the channel
 *     dev-trusted with no prompt. The PTY supervisor still sends a
 *     belt-and-braces Enter keypress shortly after spawn to dismiss the
 *     dialog if it ever does appear (e.g. account-level harbor flag on).
 *   - `--allowedTools` auto-approves the bus channel's own tools so
 *     claude doesn't prompt-via-bus on every outbound reply.
 *
 * Operator-supplied `agent.mcp_config` is passed through unchanged.
 */
export function buildClaudeArgs(agent: AgentConfig, mode: SupervisionMode): string[] {
  const args: string[] = [];
  if (mode === "process-stream-json") {
    args.push("-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose");
  }
  args.push("--plugin-dir", resolveClaudeclawPluginRoot());
  args.push("--allowedTools", PLUS_BUS_TOOL_NAMES.join(","));
  args.push(
    "--dangerously-load-development-channels",
    `plugin:${CLAUDECLAW_PLUGIN_NAME}@${PLUGIN_MARKETPLACE_TAG}`,
  );
  if (agent.mcp_config) {
    args.push("--mcp-config", agent.mcp_config);
  }
  args.push("--permission-mode", agent.permission_mode ?? "plan");
  if (agent.system_prompt_file) {
    args.push("--append-system-prompt", agent.system_prompt_file);
  }
  args.push("--session-id", agent.session_id);
  return args;
}

/* ───────────────────────────────────────────────────────────────────── */
/* SessionManager                                                        */
/* ───────────────────────────────────────────────────────────────────── */

interface AgentRecord {
  agent: AgentConfig;
  origin: BusOrigin;
  mode: SupervisionMode;
  proc: PtyAgentProcess | ChildAgentProcess;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly agents = new Map<string, AgentRecord>();

  constructor(options: SessionManagerOptions = {}) {
    this.options = options;
  }

  async spawnAgent(agent: AgentConfig, origin: BusOrigin): Promise<AgentProcess> {
    return this.spawnAgentInternal(agent, origin, /* retry */ 0);
  }

  /**
   * Internal spawn that supports a single session-id rotation retry.
   *
   * If claude rejects the supplied `--session-id` with "Session ID X is
   * already in use" (typically because the previous daemon left a JSONL
   * lock or claude's session registry treats the id as live), we mint a
   * fresh UUID, persist it to `agents/<id>/session.json`, and respawn
   * once. Without this the operator has to manually `rm session.json`
   * and restart the daemon — a recurring papercut documented in PR #133.
   */
  private async spawnAgentInternal(
    agent: AgentConfig,
    origin: BusOrigin,
    retry: number,
  ): Promise<AgentProcess> {
    if (this.agents.has(agent.id)) {
      throw new Error(`agent ${agent.id} is already spawned; call stop() or restart() first`);
    }
    const mode: SupervisionMode = agent.supervision ?? defaultSupervisionFor(origin);
    const realCwd = resolveAgentCwd(agent.cwd);
    const busSock = resolveBusSocketPath(this.options.busSocketPath);

    // Path-length validation (Spike 0.3 — UDS sun_path budget).
    if (Buffer.byteLength(busSock, "utf8") > UDS_PATH_MAX_BYTES) {
      throw new Error(
        `bus socket path exceeds ${UDS_PATH_MAX_BYTES}-byte cap: ${busSock} ` +
          `(${Buffer.byteLength(busSock, "utf8")}B)`,
      );
    }

    const env = buildChildEnv(agent, busSock);
    const args = this.options.argsOverride ?? buildClaudeArgs(agent, mode);

    let proc: PtyAgentProcess | ChildAgentProcess;
    if (mode === "pty-stdin") {
      proc = await this.spawnPty(agent, args, env, realCwd);
    } else if (mode === "process-stream-json" || mode === "process") {
      proc = this.spawnChild(agent, mode, args, env, realCwd);
    } else if (mode === "tmux") {
      proc = this.spawnTmux(agent, args, env, realCwd);
    } else {
      throw new Error(`unsupported supervision mode: ${mode satisfies never}`);
    }

    // Register the proc + attach the cleanup `onExit` BEFORE awaiting
    // the collision detector. Codex P1 on this PR: if the process exits
    // during the detection window for a non-collision reason (auth
    // error, missing config, claude crash) and we register after the
    // await, our `proc.onExit` handler is pushed onto a handler array
    // whose owning proc has already exited — `PtyAgentProcess.onExit` /
    // `ChildAgentProcess.onExit` are push-only and don't replay past
    // exits. The cleanup never fires, leaving a dead entry in
    // `this.agents` that breaks the next `already spawned` guard.
    const record: AgentRecord = { agent, origin, mode, proc };
    this.agents.set(agent.id, record);
    // Auto-cleanup: drop registry entry on exit so restart() can reuse the id.
    proc.onExit(() => {
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
    });

    // Watch the spawn for a session-id collision before handing the
    // process back to the caller. Returns true iff claude emitted the
    // marker AND exited with code 1 within the detection window; any
    // other outcome (alive past the window, clean exit, non-collision
    // crash) returns false and the proc is returned as-is.
    // Skip the collision-detect wait when the test seam (`argsOverride`)
    // is in play — the spawned process is a stand-in (e.g. `/bin/cat`)
    // that will never emit claude's session-id marker, and adding a 2s
    // blocking wait to every test spawn doubles suite runtime for no
    // signal. Explicit `sessionCollisionDetectMs` always wins.
    const collisionWindow =
      this.options.sessionCollisionDetectMs ??
      (this.options.argsOverride !== undefined ? 0 : DEFAULT_COLLISION_DETECT_MS);
    const collision = await detectSessionIdCollision(proc, collisionWindow);
    if (collision && retry === 0) {
      const fresh = randomUUID();
      (this.options.logger ?? console).warn(
        `[bus-session] agent=${agent.id} claude rejected session_id=${agent.session_id} as already in use — rotating to ${fresh} and respawning`,
      );
      // The public option takes `(agentId, sessionId)` for readability;
      // the legacy `createSession` storage layer takes them reversed.
      const persist =
        this.options.persistRotatedSessionId ??
        ((agentId: string, sessionId: string) => createSession(sessionId, agentId));
      await persist(agent.id, fresh);
      agent.session_id = fresh;
      // The proc that emitted the collision marker has exited; clear
      // its registry slot so the recursive respawn doesn't trip the
      // `already spawned` guard (the `onExit` cleanup above may not
      // have fired yet if the exit raced the detector's resolve).
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
      return this.spawnAgentInternal(agent, origin, retry + 1);
    }
    if (collision) {
      // Retried once and still colliding — surface a real error so the
      // operator notices instead of silently looping. Same registry-
      // slot cleanup as the rotation path.
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
      throw new Error(
        `agent ${agent.id}: session-id collision persisted after rotation (id=${agent.session_id}) — manual intervention required`,
      );
    }

    return proc;
  }

  private async spawnPty(
    agent: AgentConfig,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): Promise<PtyAgentProcess> {
    const cmd = this.options.commandOverride ?? "claude";
    // Dynamic import keeps `bun-pty` (native) out of the cold path for tests
    // that exercise non-PTY modes.
    const { spawn: ptySpawn } = (await import("bun-pty")) as {
      spawn: (
        file: string,
        argv: string[],
        opts: {
          name: string;
          cols?: number;
          rows?: number;
          cwd?: string;
          env?: Record<string, string>;
        },
      ) => PtyHandle;
    };
    // PR #110 review (agent #3) flagged that not wrapping this call
    // reintroduces the exact env-leak class PR #83 fixed: bun-pty's Rust
    // `portable_pty` MERGES the parent process env at fork() time, so
    // passing a sanitised env Record is insufficient. `ANTHROPIC_API_KEY`
    // or short-lived `CLAUDE_CODE_OAUTH_TOKEN` would leak into spawned
    // claudes if the daemon ever had them in `process.env` (common in dev:
    // operator shell sets them, or `/etc/claudeclaw/.claudeclaw-env` loads
    // them). PR #104 added the `sk-ant-oat01-*` long-lived token exception
    // — that exception is honoured by `withCleanProcessEnv` itself, so
    // wrapping here is safe for the supported token shape.
    //
    // `withCleanProcessEnv` must run synchronously around the spawn (Rust
    // fork-time read of `environ`). The bun-pty handle is the first thing
    // returned so the post-spawn restore happens after the child has
    // inherited the stripped env.
    const pty = withCleanProcessEnv(() =>
      ptySpawn(cmd, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: realCwd,
        env,
      }),
    );
    // Belt-and-braces: dismiss the WARNING: Loading development channels
    // TUI dialog claude shows when `--dangerously-load-development-channels`
    // is set AND the `tengu_harbor` feature flag is on for the account.
    // Default selection is "I am using this for local development" so a
    // single Enter accepts it. We send at 1.5s + 4s — the first covers
    // a fast boot, the second is a no-op if the dialog has already been
    // dismissed and a safety net for slow boots. With our current
    // settings (no `channelsEnabled`) the dialog usually doesn't render
    // at all; the writes are cheap insurance.
    setTimeout(() => {
      try {
        pty.write("\r");
      } catch {
        /* pty may have exited already — non-fatal */
      }
    }, 1500);
    setTimeout(() => {
      try {
        pty.write("\r");
      } catch {
        /* pty may have exited already — non-fatal */
      }
    }, 4000);
    return new PtyAgentProcess(agent.id, pty);
  }

  private spawnChild(
    agent: AgentConfig,
    mode: SupervisionMode,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): ChildAgentProcess {
    const cmd = this.options.commandOverride ?? "claude";
    // Use node:child_process for broad compatibility and a stable
    // `ChildProcess` interface across Bun + Node runtimes. (`Bun.spawn`
    // returns a different shape; using node:child_process avoids the
    // type-divergence between Subprocess and ChildProcess.)
    const child = nodeSpawnChildProcess(cmd, args, {
      cwd: realCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ChildAgentProcess(agent.id, mode, child);
  }

  private spawnTmux(
    agent: AgentConfig,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): ChildAgentProcess {
    // tmux mode (opt-in, spec §5.3): wrap the same args under a detached
    // tmux session. The `tmux new-session -d` invocation forks the actual
    // session into the background and the spawning client process exits
    // immediately — so the ChildAgentProcess.stdin we hold here belongs to
    // an already-dead tmux client, and `send_slash` writes will silently
    // no-op. Operators selecting `tmux` mode in Sprint 1 LOSE slash-relay
    // (no /quit-via-relay, /compact, /clear) — `stop()` falls back to
    // SIGTERM directly, which is functional but not graceful.
    //
    // Surface this loudly at spawn time so an operator who picked `tmux`
    // by mistake notices before it bites them in production. PR #110
    // review (agent #5) flagged that the documentation didn't warn.
    //
    // TODO(sprint-2): implement a TmuxAgentProcess that overrides
    // `send_slash` to shell out to `tmux send-keys -t <session> "/<cmd>"
    // Enter`. Until then, `tmux` mode is best-effort + ungraceful.
    process.stderr.write(
      `[bus] WARNING: agent ${agent.id} supervision='tmux' — slash-command relay ` +
        `is not implemented in Sprint 1; stop() will use SIGTERM. Use 'pty-stdin' ` +
        `or 'process-stream-json' for graceful slash-command lifecycle.\n`,
    );
    const claudeBin = this.options.commandOverride ?? "claude";
    const sessionName = `claudeclaw-${agent.id}`;
    const tmuxArgs = ["new-session", "-d", "-s", sessionName, claudeBin, ...args];
    const child = nodeSpawnChildProcess("tmux", tmuxArgs, {
      cwd: realCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ChildAgentProcess(agent.id, "tmux", child);
  }

  /**
   * Stop an agent. Per Spike 0.5: write `/quit` via the active supervision
   * channel; observe process exit; the caller (Bus core) publishes
   * `session.end` AFTER the process exit fires — not before.
   */
  stop(agent_id: string): Promise<void> {
    const record = this.agents.get(agent_id);
    if (!record) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finalise = (): void => {
        // Drop from registry (the onExit handler installed in spawnAgent()
        // will also do this; harmless to do twice).
        this.agents.delete(agent_id);
        resolve();
      };
      if (record.proc._isExited()) {
        finalise();
        return;
      }
      record.proc.onExit(() => {
        finalise();
      });
      // Try graceful first: /quit via the active relay channel. If that path
      // fails (closed stdin, dead PTY), fall through to SIGTERM.
      record.proc
        .send_slash("quit")
        .catch(() => {
          /* fall through to kill */
        })
        .finally(() => {
          // Belt + braces: if the process hasn't exited within a short
          // grace window after /quit, SIGTERM. We schedule this rather than
          // calling kill() immediately so a clean /quit can complete (it's
          // the recorded path that produces `<command-name>/exit</...>`
          // envelopes in the JSONL — see Spike 0.5).
          setTimeout(() => {
            if (!record.proc._isExited()) record.proc._kill();
          }, 2000).unref?.();
        });
    });
  }

  /**
   * Restart an agent. Same `session_id` (claude resumes via `--session-id`).
   */
  async restart(agent_id: string): Promise<AgentProcess> {
    const record = this.agents.get(agent_id);
    if (!record) {
      throw new Error(`cannot restart unknown agent ${agent_id}`);
    }
    const { agent, origin } = record;
    await this.stop(agent_id);
    return this.spawnAgent(agent, origin);
  }

  /**
   * Health snapshot. For each known agent: alive (process not exited) +
   * `jsonl_recent` (file mtime within heartbeat interval).
   *
   * TODO(sprint-2): wire `jsonl_recent` to the JSONL tailer. The path is
   * `~/.claude/projects/<encoded-realpath>/<sessionId>.jsonl`. For Sprint 1
   * this stubs to `true` so callers can wire against the shape without
   * blocking on the tailer.
   */
  health(): Record<string, AgentHealth> {
    const out: Record<string, AgentHealth> = {};
    for (const [id, record] of this.agents) {
      out[id] = {
        alive: !record.proc._isExited(),
        jsonl_recent: true, // Sprint 2 fills this in
      };
    }
    return out;
  }

  /**
   * Look up the live `AgentProcess` for an agent id (or `undefined` if no
   * such agent is currently spawned). Sprint 4 wiring (spec §6.3): the
   * slash-relay handler needs read-only access to dispatch `send_slash`.
   * Adding a small accessor keeps the spawn lifecycle untouched.
   */
  getAgent(agent_id: string): AgentProcess | undefined {
    return this.agents.get(agent_id)?.proc;
  }

  /** Test helper: list spawned agent_ids. Not part of the public spec. */
  _list(): string[] {
    return Array.from(this.agents.keys());
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* Re-exports for callers + tests                                        */
/* ───────────────────────────────────────────────────────────────────── */

export { defaultSupervisionFor } from "./types";
export type { AgentConfig, BusOrigin, SupervisionMode } from "./types";
