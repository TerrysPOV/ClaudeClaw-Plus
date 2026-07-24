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
import {
  deleteConfigForPty,
  type PtyIdentity,
  writeConfigForPty,
} from "../runner/pty-mcp-config-writer";
import { createSession } from "../sessions";
import type { BusCore } from "./core";
import { JsonlTailer } from "./jsonl-tailer";
import { capturePostMortem, type PostMortemOptions } from "./post-mortem";
import type { ReceiptRecord } from "./receipt";
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
  /**
   * Bus core to feed session JSONL events into (issue #215). When set,
   * every spawned agent gets a `JsonlTailer` bound to its live session
   * that forwards `response.turn_end` (etc.) via `bus.ingestSessionEvent`,
   * which powers the silent-drop safety net. Absent in unit tests that
   * don't exercise the tailer. The daemon (`runtime-mount`) wires it.
   */
  bus?: BusCore;
  /**
   * Override the `~/.claude/projects` root the per-agent `JsonlTailer`
   * reads (issue #215). Defaults to the tailer's own default. Tests point
   * it at a temp dir so they never touch the real projects directory.
   */
  projectsDir?: string;
  /**
   * Clock seam for the `restart()` rate-limiter (tests). Returns epoch ms.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Override the directory restart post-mortems are written to. Defaults to
   * `~/.claude/claudeclaw/post-mortems` (see `post-mortem.ts`). Tests point
   * this at a temp dir.
   */
  postMortemDir?: string;
  /**
   * Override the `~/.claude/projects` root the post-mortem reads session
   * JSONL from. Tests point this at a temp dir.
   */
  postMortemProjectsDir?: string;
}

/**
 * Options for `SessionManager.restart()` — the shared respawn primitive.
 */
export interface RestartOptions {
  /**
   * Why the respawn fired. Stamped on the post-mortem so the three triggers
   * (control-plane wedge, data-plane model-hang, rotation) are
   * distinguishable offline. Defaults to `"manual"`.
   */
  reason?: string;
  /**
   * Snapshot of the receipt that triggered the respawn, when available.
   * Captured verbatim into the post-mortem (already redacted — the receipt
   * stores a prompt hash, never plaintext).
   */
  receipt?: Readonly<ReceiptRecord> | null;
  /**
   * Mint a fresh session id (rotate the conversation) vs. resume the existing
   * transcript. Defaults to `true` — the rotation + model-hang triggers both
   * want a clean session. Pass `false` to recycle a wedged process while
   * keeping context.
   */
  freshSession?: boolean;
}

/**
 * MCP multiplexer synthesizer seam (issue #165). The daemon injects this
 * AFTER it has started the MCP multiplexer plugin and confirmed
 * `plugin.isActive()`, so the bus spawn path can synthesize a per-agent
 * `--mcp-config` for `mcp.shared` servers — the same servers the legacy
 * PTY supervisor reaches via `synthesizeMcpConfigIfActive`. Without this
 * the bus's `buildClaudeArgs` only emits `--mcp-config` for a statically
 * configured `agent.mcp_config`, so multiplexed servers are unreachable
 * for every bus agent.
 *
 * Left `null` when the multiplexer is dormant (`mcp.shared` empty, web
 * disabled, or `plugin.isActive() === false`) — synthesis is then skipped
 * and agents spawn with no `--mcp-config`, byte-identical to the
 * pre-#165 dormant path.
 */
export interface BusMcpConfigSynthesizer {
  /** Mint the per-agent HMAC identity (headers) for the bridge. */
  issue: (ptyId: string) => PtyIdentity;
  /** Drop the per-agent identity when the agent is stopped. Idempotent. */
  revoke: (ptyId: string) => void | Promise<void>;
  /** The HTTP base URL the multiplexer bound to, e.g. http://127.0.0.1:4632. */
  bridgeBaseUrl: () => string;
  /** Names of the multiplexed shared servers (`settings.mcp.shared`). */
  sharedServers: readonly string[];
}

/**
 * Synthesize a per-agent `--mcp-config` path for the bus spawn path
 * (issue #165), or `undefined` when synthesis doesn't apply.
 *
 * Precedence + dormancy rules (mirrors the supervisor):
 *   - An operator-supplied static `agent.mcp_config` ALWAYS wins — return
 *     `undefined` so `buildClaudeArgs`'s own pass-through is the single
 *     source of that flag (never emit two `--mcp-config`).
 *   - No synthesizer wired, or zero shared servers → `undefined` (dormant,
 *     no flag, byte-identical to pre-#165).
 *
 * Keys the identity + config file on the STABLE `agent.id` rather than
 * `agent.session_id`: the session id can rotate on a collision respawn,
 * which would orphan the issued identity + on-disk file. One agent = one
 * long-lived PTY = one identity.
 */
export function synthesizeBusMcpConfig(
  agent: AgentConfig,
  synth: BusMcpConfigSynthesizer | null,
  cwd: string,
): string | undefined {
  if (agent.mcp_config) return undefined;
  if (!synth) return undefined;
  if (synth.sharedServers.length === 0) return undefined;

  const identity = synth.issue(agent.id);
  // Roll back the just-minted identity if the on-disk write fails
  // (EACCES, ENOSPC, EROFS, mkdir failure). Without this, the throw
  // escapes the spawn-dispatch try/catch in `spawnAgentInternal`
  // because `mcpConfigCwd` is only assigned AFTER this function
  // returns — `cleanupAgentMcpConfig(undefined, ...)` then short-
  // circuits via its `if (!cwd) return` guard and the identity stays
  // alive in the issuer's registry.
  let path: string;
  try {
    ({ path } = writeConfigForPty({
      ptyId: agent.id,
      cwd,
      sharedServers: synth.sharedServers.map((name) => ({ name })),
      perPtyServers: [],
      bridgeBaseUrl: synth.bridgeBaseUrl(),
      identity,
    }));
  } catch (err) {
    Promise.resolve(synth.revoke(agent.id)).catch(() => {
      // Fire-and-forget; the throw below is the operator-visible signal.
    });
    throw err;
  }
  return path.length > 0 ? path : undefined;
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
  // Issue #172: pass the agent's permission_mode to the plus-bus MCP server
  // so it can decide whether to FORWARD `permission_request` notifications
  // to Bus core (operator approval card) or short-circuit them locally with
  // a native auto-response. When the mode is one claude's native handler
  // resolves itself (`bypassPermissions`, `acceptEdits`, `dontAsk`), the
  // plugin auto-responds and never forwards — otherwise we'd hijack the
  // operator's intent back into a human approval loop. The IpcHello
  // always declares both required capabilities; Bus core's handshake gate
  // (`core-ipc.ts:REQUIRED_MCP_CAPABILITIES`) requires both.
  env.CCAW_PERMISSION_MODE = agent.permission_mode ?? "bypassPermissions";
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
  "mcp__plugin_claudeclaw-plus_plus-bus__edit_message",
  "mcp__plugin_claudeclaw-plus_plus-bus__ask",
  "mcp__plugin_claudeclaw-plus_plus-bus__cancel",
  "mcp__plugin_claudeclaw-plus_plus-bus__request_human",
];

/**
 * Claude Code's native scheduling tools, blocked unconditionally on every
 * bus agent via `--disallowedTools`.
 *
 * These are session-scoped: a wakeup they register is delivered only if the
 * exact underlying Claude session that created it is still live at fire time.
 * Under the bus runtime, sessions rotate and churn independently of the
 * daemon, so a reminder scheduled for hours later silently never fires (the
 * #342 "call the GP for Ginna at 8am" incident). ClaudeClaw+'s own
 * file-backed job scheduler (`schedule_job` bus tool → `agents/<id>/jobs/`)
 * is durable across session boundaries and is the only correct path here, so
 * the native tools are removed rather than left as a tempting wrong door.
 *
 * This is a hardcoded floor, not operator-configurable: the tools are broken
 * by architecture under bus, not merely a security preference, and hardcoding
 * means the block takes effect on deploy with no settings.json edit.
 */
const NATIVE_SCHEDULING_TOOLS_BLOCKLIST = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
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
 * Restart rate-limit (Terry's required add on the respawn primitive). More
 * than `MAX_RESTARTS_PER_WINDOW` restarts of one agent inside
 * `RESTART_WINDOW_MS` flips the agent into operator-intervention mode rather
 * than looping — a crash-on-boot / bad-config cause is NOT the upstream
 * model-hang and must not be papered over with an infinite respawn loop.
 */
const MAX_RESTARTS_PER_WINDOW = 3;
const RESTART_WINDOW_MS = 60 * 60 * 1000;

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
  // Block Claude Code's native session-scoped scheduling tools so the agent
  // is funnelled to the durable `schedule_job` bus tool instead. See the
  // NATIVE_SCHEDULING_TOOLS_BLOCKLIST comment for why (the #342 lost-reminder
  // incident). Comma-joined to match `--allowedTools` above and the value
  // `claude` parses for `--disallowedTools`.
  args.push("--disallowedTools", NATIVE_SCHEDULING_TOOLS_BLOCKLIST.join(","));
  args.push(
    "--dangerously-load-development-channels",
    `plugin:${CLAUDECLAW_PLUGIN_NAME}@${PLUGIN_MARKETPLACE_TAG}`,
  );
  if (agent.mcp_config) {
    args.push("--mcp-config", agent.mcp_config);
  }
  // Default to `bypassPermissions` to match the documented headless
  // contract in `commands/start.md` §"Security Levels": "All levels run
  // without permission prompts (headless)". The legacy `claude -p` path
  // delivered this implicitly; the bus runtime previously defaulted to
  // "plan", which made every Bash / Write tool call surface a
  // permission_request to the originating channel — a regression from
  // the legacy headless contract.
  //
  // Operators who want approvals back can set `permission_mode` per
  // agent in `settings.json` to one of the other valid values:
  //   "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto"
  args.push("--permission-mode", agent.permission_mode ?? "bypassPermissions");
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
  /**
   * Set to the agent's cwd when this spawn synthesized a multiplexer
   * `--mcp-config` (issue #165). Presence drives identity revoke + config
   * file cleanup on stop(). Absent when no synthesis happened (static
   * `agent.mcp_config`, or dormant multiplexer).
   */
  mcpConfigCwd?: string;
  /**
   * Live session JSONL tailer (issue #215). Present when `options.bus`
   * is set; feeds `response.turn_end` events so the bus can synthesize a
   * reply the agent forgot to send. Stopped on agent exit / stop().
   */
  tailer?: JsonlTailer;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly agents = new Map<string, AgentRecord>();
  private mcpSynth: BusMcpConfigSynthesizer | null = null;
  /**
   * Per-agent restart timestamps (epoch ms) inside the rate-limit window.
   * Guards a non-upstream failure cause (bad config, crash-on-boot) from
   * looping respawns forever — see `restart()` + `MAX_RESTARTS_PER_WINDOW`.
   * Only failure-driven restarts are recorded; healthy `reason==='rotation'`
   * respawns have their own backpressure and bypass this budget entirely.
   */
  private readonly restartHistory = new Map<string, number[]>();
  /**
   * Per-agent in-flight `restart()` promises. The three triggers
   * (control-plane wedge, data-plane model-hang, rotation) are independent
   * event sources that can fire for the SAME agent concurrently. Serializing
   * per agent makes the rate-limit gate meaningful, prevents double-mint /
   * double-post-mortem, and closes the `already spawned` race where the
   * loser tears down the freshly-spawned process. Cleared in `restart()`'s
   * finally.
   */
  private readonly restartInFlight = new Map<string, Promise<AgentProcess>>();

  constructor(options: SessionManagerOptions = {}) {
    this.options = options;
  }

  /**
   * Wire (or clear) the MCP multiplexer synthesizer (issue #165). The
   * daemon calls this AFTER the multiplexer issuer is wired and BEFORE it
   * spawns agents, so every subsequently-spawned agent gets a synthesized
   * `--mcp-config` for `mcp.shared` servers. Pass `null` to disable.
   */
  setMcpConfigSynthesizer(synth: BusMcpConfigSynthesizer | null): void {
    this.mcpSynth = synth;
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

    // Issue #165: synthesize the multiplexer `--mcp-config` for this agent
    // when the daemon has wired a synthesizer (active multiplexer) and the
    // agent has no static `mcp_config`. Skipped when `argsOverride` is set
    // — that test seam replaces the entire args list with a stand-in
    // process's flags, so appending claude flags would corrupt it.
    let mcpConfigCwd: string | undefined;
    if (this.options.argsOverride === undefined) {
      const synthesizedPath = synthesizeBusMcpConfig(agent, this.mcpSynth, realCwd);
      if (synthesizedPath) {
        args.push("--mcp-config", synthesizedPath);
        mcpConfigCwd = realCwd;
      }
    }

    // Issue #165 (PR #184 re-review): the synthesized identity + 0600
    // bearer file are minted ABOVE, before the spawn primitive runs. If the
    // primitive throws (bun-pty native fault, ENOENT on commandOverride,
    // tmux not on PATH), unwinding skips registry insertion + the onExit
    // cleanup, so without this the just-failed agent's identity is never
    // revoked and its file never deleted. Clean up then re-throw.
    let proc: PtyAgentProcess | ChildAgentProcess;
    try {
      if (mode === "pty-stdin") {
        proc = await this.spawnPty(agent, args, env, realCwd);
      } else if (mode === "process-stream-json" || mode === "process") {
        proc = this.spawnChild(agent, mode, args, env, realCwd);
      } else if (mode === "tmux") {
        proc = this.spawnTmux(agent, args, env, realCwd);
      } else {
        throw new Error(`unsupported supervision mode: ${mode satisfies never}`);
      }
    } catch (err) {
      this.cleanupAgentMcpConfig(mcpConfigCwd, agent.id);
      throw err;
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
    const record: AgentRecord = { agent, origin, mode, proc, mcpConfigCwd };
    this.agents.set(agent.id, record);
    // Auto-cleanup: drop registry entry on exit so restart() can reuse the id.
    proc.onExit(() => {
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        // Issue #215: tear down the session tailer on natural exit too.
        void current.tailer?.stop();
        // Issue #165 (PR #184 re-review): a natural exit (crash, OOM,
        // claude-side auth failure, operator kill) never routes through
        // stop(), so release the multiplexer identity + delete the 0600
        // bearer file here too. Idempotent, so it's safe if stop() also
        // ran (e.g. stop() racing the process's own exit).
        this.cleanupAgentMcpConfig(current.mcpConfigCwd, agent.id);
        this.agents.delete(agent.id);
        // A natural exit that bypasses stop() (crash, OOM, operator kill)
        // must also drop the restart-budget entry so a churn of distinct
        // agent ids can't leak number[] entries for the life of the manager.
        this.restartHistory.delete(agent.id);
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
      // Issue #165 (PR #184 review): this attempt may have synthesized an
      // --mcp-config (minted a multiplexer identity + wrote a 0600 file).
      // The retry below re-synthesizes from scratch, so revoke this
      // attempt's identity + delete its file first — otherwise the identity
      // leaks and a stale file lingers if the retry fails before rewriting.
      this.cleanupAgentMcpConfig(mcpConfigCwd, agent.id);
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
      // slot + MCP-config cleanup as the rotation path.
      this.cleanupAgentMcpConfig(mcpConfigCwd, agent.id);
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        this.agents.delete(agent.id);
      }
      throw new Error(
        `agent ${agent.id}: session-id collision persisted after rotation (id=${agent.session_id}) — manual intervention required`,
      );
    }

    // Issue #215: wire a JSONL tailer to this agent's live session so the
    // bus observes `response.turn_end` and can synthesize a reply when a
    // turn ends with text but the agent never called the `reply` tool.
    // Without this the safety net in BusCore.handleTurnEnd is inert (no
    // events are ever produced in the runtime). Created here — after any
    // session-id rotation — so it binds the FINAL session_id. start() is
    // fire-and-forget: it must not block returning the proc, and a tail
    // failure must never fail the spawn.
    if (this.options.bus) {
      const tailer = new JsonlTailer({
        bus: this.options.bus,
        agent_id: agent.id,
        session_id: agent.session_id,
        cwd: realCwd,
        startAt: "end",
        projectsDir: this.options.projectsDir,
      });
      record.tailer = tailer;
      void tailer
        .start()
        .catch((err) =>
          (this.options.logger ?? console).warn(
            `[bus-session] agent=${agent.id} jsonl tailer start failed`,
            err,
          ),
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
    // Boot-dialog handling lives in PtyAgentProcess's output-driven watcher
    // (issue #193): it answers the dev-channels confirmation with Enter and the
    // new "Bypass Permissions mode" confirmation by selecting "Yes, I accept"
    // (Down + Enter). A blind Enter — the previous approach — selects that
    // dialog's default "No, exit" and kills the agent at boot.
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
   * Release the multiplexer identity + delete the synthesized per-agent
   * `--mcp-config` (0600 bearer-token file) for an agent that synthesized
   * one (issue #165). `cwd` is the agent's resolved cwd, or undefined when
   * no config was synthesized (then this is a no-op). Best-effort: revoke
   * is documented idempotent and `deleteConfigForPty` swallows ENOENT, so a
   * double-call (e.g. stop() racing the onExit auto-cleanup, or a
   * collision-retry followed by stop()) is safe.
   */
  private cleanupAgentMcpConfig(cwd: string | undefined, agentId: string): void {
    if (!cwd) return;
    try {
      deleteConfigForPty(cwd, agentId);
    } catch (err) {
      (this.options.logger ?? console).warn(
        `[bus-session] agent=${agentId} mcp-config cleanup failed`,
        err,
      );
    }
    if (this.mcpSynth) {
      Promise.resolve(this.mcpSynth.revoke(agentId)).catch((err) =>
        (this.options.logger ?? console).warn(
          `[bus-session] agent=${agentId} mcp identity revoke failed`,
          err,
        ),
      );
    }
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
        // Issue #215: tear down the session tailer.
        void record.tailer?.stop();
        // Issue #165: release the multiplexer identity + delete the
        // synthesized per-agent --mcp-config when this spawn had one.
        this.cleanupAgentMcpConfig(record.mcpConfigCwd, agent_id);
        // Drop from registry (the onExit handler installed in spawnAgent()
        // will also do this; harmless to do twice).
        this.agents.delete(agent_id);
        // Drop the restart-budget entry too — otherwise a stopped-and-never-
        // restarted agent leaves a stranded number[] for the life of the
        // manager (slow leak in a primitive whose purpose is to bound growth).
        this.restartHistory.delete(agent_id);
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
   * Respawn an agent's live PTY. This is the SHARED primitive behind three
   * triggers — control-plane wedge (prompt never reached the agent), the
   * data-plane model-hang (prompt reached the agent but no turn followed),
   * and session rotation (message/age threshold tripped). One mechanism,
   * built once.
   *
   * Unlike the old same-`session_id` restart, this actually rotates the
   * conversation: it stops the current process, mints + persists a FRESH
   * session id, and spawns a new PTY against it. That's what makes it a real
   * fix for bus-mode session rotation (#213) — the live `claude` was writing
   * one ever-growing JSONL keyed to the boot session id; only respawning it
   * against a new id stops the growth. Minting fresh also sidesteps claude's
   * locked-`--resume` refusal: the old id is no longer live, and the summary
   * (rotation caller's concern) is generated against the backed-up id, not
   * the live one.
   *
   * `freshSession: false` keeps the existing id (resume the same transcript) —
   * for callers that only need to recycle a wedged process without discarding
   * context. Default is `true`.
   *
   * Before stopping, a best-effort post-mortem is written (cwd, last ~50
   * JSONL lines, triggering receipt) so the *why* survives the respawn.
   *
   * Rate-limited: more than `MAX_RESTARTS_PER_WINDOW` restarts for one agent
   * inside `RESTART_WINDOW_MS` logs a CRITICAL and throws WITHOUT respawning.
   * A crash-on-boot or bad-config agent must not loop forever — that's an
   * operator-intervention signal, not something to paper over.
   *
   * Best-effort instrumentation posture: the post-mortem capture never
   * rejects the restart, mirroring the receipt-chain "must not break the bus"
   * rule. The rate-limit throw is the one intentional refusal.
   */
  async restart(agent_id: string, opts: RestartOptions = {}): Promise<AgentProcess> {
    // Non-re-entrant per agent: the three triggers can fire for the SAME
    // agent concurrently. Coalesce — a concurrent caller awaits the same
    // in-flight restart instead of racing it (double-mint, double-post-mortem,
    // rate-limit undercount, and the `already spawned` teardown-the-fresh-proc
    // race all stem from overlapping restarts). The entry is cleared in the
    // finally below before the promise settles, so a follow-on restart can run.
    const inflight = this.restartInFlight.get(agent_id);
    if (inflight) return inflight;

    const p = this.restartInternal(agent_id, opts).finally(() => {
      this.restartInFlight.delete(agent_id);
    });
    this.restartInFlight.set(agent_id, p);
    return p;
  }

  private async restartInternal(agent_id: string, opts: RestartOptions): Promise<AgentProcess> {
    const record = this.agents.get(agent_id);
    if (!record) {
      throw new Error(`cannot restart unknown agent ${agent_id}`);
    }
    const reason = opts.reason ?? "manual";
    const log = this.options.logger ?? console;
    const nowMs = (this.options.now ?? Date.now)();

    // Healthy rotation (#213) has its own backpressure (message/age threshold)
    // and is a normal event on a high-traffic agent — it must NOT share the
    // crash-loop budget, or a busy agent gets denied a needed rotation and a
    // few benign rotations can starve a genuine wedge respawn. The gate exists
    // for failure-driven triggers (crash-on-boot / bad-config loops) only.
    const countsAgainstBudget = reason !== "rotation";

    // Rate-limit gate — prune the window, refuse if we're already at the cap.
    // Mutate the STORED array in place (no filtered-copy + overwrite) so the
    // accounting can't be clobbered. `history` is null for rotation (skipped).
    let history: number[] | null = null;
    if (countsAgainstBudget) {
      history = this.restartHistory.get(agent_id) ?? [];
      // Prune expired timestamps in place on the stored reference.
      for (let i = history.length - 1; i >= 0; i--) {
        if (nowMs - (history[i] as number) >= RESTART_WINDOW_MS) history.splice(i, 1);
      }
      this.restartHistory.set(agent_id, history);
      if (history.length >= MAX_RESTARTS_PER_WINDOW) {
        log.error(
          `[bus-session] CRITICAL agent=${agent_id} hit ${history.length} restarts in ` +
            `${RESTART_WINDOW_MS / 60000}min (reason=${reason}) — auto-restart SUSPENDED, ` +
            `operator intervention required (likely a crash-on-boot or bad-config cause, ` +
            `not the upstream model-hang)`,
        );
        throw new Error(
          `agent ${agent_id}: restart rate limit exceeded ` +
            `(${history.length}/${MAX_RESTARTS_PER_WINDOW} in ${RESTART_WINDOW_MS / 60000}min) — ` +
            `auto-restart suspended`,
        );
      }
    }

    const { agent, origin } = record;

    // Mint + persist the FRESH session id BEFORE stop() so a persist failure
    // (EACCES/ENOSPC/EROFS, or a throwing persistRotatedSessionId) aborts the
    // restart with the agent STILL LIVE and registered — never torn down with
    // no recovery path through restart(). The live record's session_id is only
    // mutated after the persist resolves; the post-mortem (below) still tails
    // the dying session because it captures from the same pre-stop snapshot.
    let freshId: string | null = null;
    if (opts.freshSession !== false) {
      freshId = randomUUID();
      // Public option takes `(agentId, sessionId)`; the legacy `createSession`
      // storage layer takes them reversed — same convention as the
      // collision-rotation path above.
      const persist =
        this.options.persistRotatedSessionId ??
        ((id: string, sid: string) => createSession(sid, id));
      await persist(agent_id, freshId);
    }

    // Post-mortem BEFORE the stop so the JSONL we tail is the dying session's.
    // Captured against the still-current `agent.session_id` (not yet rotated).
    // Best-effort — instrumentation must never break the respawn.
    const pmOpts: PostMortemOptions = {};
    if (this.options.postMortemDir !== undefined) pmOpts.dir = this.options.postMortemDir;
    if (this.options.postMortemProjectsDir !== undefined)
      pmOpts.projectsDir = this.options.postMortemProjectsDir;
    try {
      const path = await capturePostMortem(
        {
          agentId: agent_id,
          cwd: resolveAgentCwd(agent.cwd),
          sessionId: agent.session_id,
          reason,
          receipt: opts.receipt ?? null,
          generation: history?.length ?? 0,
        },
        pmOpts,
      );
      if (path) log.info(`[bus-session] agent=${agent_id} post-mortem written (reason=${reason})`);
    } catch (err) {
      log.warn(`[bus-session] agent=${agent_id} post-mortem capture failed`, err);
    }

    await this.stop(agent_id);

    // Persist succeeded — adopt the fresh id on the live record now that the
    // old process is gone (so the respawn boots against the new session).
    if (freshId !== null) agent.session_id = freshId;

    // Count this restart against the window only once we've committed to it
    // (past the rate-limit gate + persist + post-mortem). Push to the SAME
    // stored array reference + re-set so concurrent accounting can't be lost
    // — though `restart()`'s in-flight guard already serializes us per agent.
    // Rotation (history === null) is intentionally not recorded.
    if (history !== null) {
      history.push(nowMs);
      this.restartHistory.set(agent_id, history);
    }

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
