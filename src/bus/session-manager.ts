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
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanSpawnEnv, withCleanProcessEnv } from "../runner";
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
 * Channel name used for the Bus MCP stdio plugin loaded into every
 * spawned `claude`. The `--dangerously-load-development-channels` value
 * MUST match an `mcpServers` key in the `--mcp-config` JSON — that
 * mapping is what tells `claude` which stdio command to start as the
 * channel-bearing MCP server. Spike 0.6's working probe used a bare
 * channel name (`probe-channel`); the legacy `plugin:plus-bus@local`
 * string didn't resolve to anything and silently loaded no channel,
 * which is why every Sprint 1 e2e test passed (those inject a fake
 * IPC transport directly) while real `claude` never connected to the
 * Bus IPC server.
 */
export const PLUS_BUS_CHANNEL = "plus-bus";

/** Absolute path to the Bus MCP server entrypoint we tell `claude` to spawn. */
function resolveBusMcpServerPath(): string {
  // `session-manager.ts` lives in `src/bus/`; so does `mcp-server.ts`.
  // Resolved via `import.meta.url` so it works both for `bun run` against
  // the TS source (production) and for any future bundled deployment.
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "mcp-server.ts");
}

/**
 * Synthesise the `--mcp-config` JSON `claude` will read at startup. The
 * config always contains a `plus-bus` entry whose `command`/`args` point
 * at our Bus MCP server. If the operator supplied their own
 * `agent.mcp_config` we merge their `mcpServers` map into ours so user
 * MCPs continue to load alongside Bus IPC. The `plus-bus` key is
 * reserved — operator entries with the same name are overwritten with a
 * warning (the bus channel won't function under any other name).
 *
 * The synthesised file lives under `os.tmpdir()` and is keyed by pid +
 * agent id so concurrent daemons / restarts don't clobber each other.
 */
export function writeBusMcpConfig(
  agent: AgentConfig,
  logger: Pick<Console, "warn"> = console,
): string {
  const busEntry = {
    command: process.execPath, // current bun
    args: ["run", resolveBusMcpServerPath()],
  };
  let mcpServers: Record<string, unknown> = {};
  if (agent.mcp_config && existsSync(agent.mcp_config)) {
    try {
      const parsed = JSON.parse(readFileSync(agent.mcp_config, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      mcpServers = { ...(parsed.mcpServers ?? {}) };
    } catch (err) {
      logger.warn(
        `[bus-session] failed to read operator mcp_config at ${agent.mcp_config}; falling back to bus-only: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (mcpServers[PLUS_BUS_CHANNEL]) {
    logger.warn(
      `[bus-session] operator mcp_config defines a "${PLUS_BUS_CHANNEL}" server — overwriting (reserved name)`,
    );
  }
  mcpServers[PLUS_BUS_CHANNEL] = busEntry;
  const path = join(tmpdir(), `claudeclaw-bus-mcp-${process.pid}-${agent.id}.json`);
  // 0600 — operator mcp_config entries may carry credentials in `env` or
  // `headers`; the synthesised copy must not be world-readable in /tmp.
  // Belt-and-braces (same pattern as src/runner/pty-mcp-config-writer.ts:172):
  // `writeFileSync({mode})` only takes effect on CREATE and a permissive
  // umask can still widen bits — an explicit chmodSync after the write
  // forces 0600 regardless of platform / umask / prior file state.
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort. Some test/FUSE filesystems lack permission semantics;
    // the writeFileSync mode already applied where supported.
  }
  return path;
}

/**
 * Build the args list passed to the spawned `claude`. Mirrors §5.3 sample.
 *
 * Side effect: writes a per-agent `--mcp-config` file to `os.tmpdir()`.
 * Called once per spawn from `SessionManager.spawnAgent`.
 */
export function buildClaudeArgs(agent: AgentConfig, mode: SupervisionMode): string[] {
  const args: string[] = [];
  if (mode === "process-stream-json") {
    args.push("-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose");
  }
  args.push("--mcp-config", writeBusMcpConfig(agent));
  args.push("--dangerously-load-development-channels", PLUS_BUS_CHANNEL);
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

    const record: AgentRecord = { agent, origin, mode, proc };
    this.agents.set(agent.id, record);
    // Auto-cleanup: drop registry entry on exit so restart() can reuse the id.
    proc.onExit(() => {
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
    });
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
