/**
 * ClaudeClaw+ Bus runtime — Session Manager.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.3
 *
 * Responsibility: spawn + supervise one `claude` process per Plus agent.
 * Uses the PTY-backed REPL for every origin unless the agent explicitly
 * selects another `SupervisionMode`, including `process-stream-json`. The one
 * default exception is win32: an `AgentConfig` with no `supervision` falls back,
 * for non-channel origins, to `process-stream-json` (`defaultSupervisionFor`).
 * Declared agents always carry `supervision` (resolver default `pty-stdin`).
 * Provides a stable per-agent handle (`AgentProcess`) with
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
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_SCHEDULING_TOOLS_BLOCKLIST } from "../config";
import { claudeExecutable, cleanSpawnEnv, withCleanProcessEnv } from "../runner";
import {
  deleteConfigForPty,
  type PtyIdentity,
  writeConfigForPty,
} from "../runner/pty-mcp-config-writer";
import { createSession } from "../sessions";
import type { BusCore } from "./core";
import { encodeCwdForProjectsDir } from "./jsonl-line-types";
import { JsonlTailer } from "./jsonl-tailer";
import { BUS_MCP_TOOLS } from "./mcp-tools";
import { confirmTurnReceipt } from "./receipt-wiring";
import {
  confirmGoneAndClear,
  confirmRetired,
  createSystemProbe,
  decideResume,
  type OwnershipRecord,
  OwnershipRecordError,
  ownershipGuardApplies,
  type OwnershipStore,
  type ProcessProbe,
  recordOwnership,
} from "./session-ownership";
import { capturePostMortem, type PostMortemOptions } from "./post-mortem";
import type { ReceiptRecord } from "./receipt";
import { PtyExitUnconfirmedError, type PtyProcess } from "../runner/pty-process";
import {
  assertSessionSpawnable,
  assertSessionWritable,
  fenceKey,
  liftFence,
  quarantineSession,
} from "../runner/pty-quarantine";
import { ensureTrustAccepted } from "../runner/pty-trust-prompt";
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
   * Test seam: override the spawned executable (default: `claudeExecutable()`
   * from `src/runner.ts`, which is `"claude"` outside Windows). The same
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
   * Where ownership records live (#595 round 3). When unset the bus keeps none, and a restart
   * resumes as if no process of ours survived. The daemon wires `createFileOwnershipStore()`;
   * tests inject a store so nothing is written under the operator's agents dir.
   */
  ownershipStore?: OwnershipStore;
  /** Test seams for the ownership guard: the process reads and signals, boot id, and bounds in ms. */
  processProbe?: ProcessProbe;
  bootId?: string;
  ownershipGuardMs?: number;
  ownershipTermMs?: number;
  /**
   * Test seam: the bound in ms on each step of writing a NEW ownership record (the identity read
   * and the write). Unset keeps `RECORD_STEP_MS`.
   */
  ownershipRecordMs?: number;
  /** Test seam for the platform the ownership guard keys on (default: `process.platform`). */
  platform?: NodeJS.Platform;
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
  return synthesizeMcpConfigForKey(agent.id, synth, cwd);
}

/**
 * Shared core of the bus-side synthesis, keyed on an arbitrary spawn key
 * rather than on an `AgentConfig`. Long-lived bus agents key on the stable
 * `agent.id`; headless agent jobs key on a freshly-minted job key so two
 * concurrent jobs for the same agent never share an identity or clobber
 * each other's config file.
 *
 * The key lands in the synthesized file name (`mcp-pty-<key>.json`), so it
 * must be safe as a path segment. Both current callers satisfy that
 * differently: the agent path passes `agent.id`, which is operator-supplied
 * but validated upstream, and the job path passes a freshly-minted job key.
 * What the contract actually forbids is an unvalidated value — model-supplied
 * text in particular must never reach this parameter.
 */
function synthesizeMcpConfigForKey(
  key: string,
  synth: BusMcpConfigSynthesizer | null,
  cwd: string,
): string | undefined {
  if (!synth) return undefined;
  if (synth.sharedServers.length === 0) return undefined;

  const identity = synth.issue(key);
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
      ptyId: key,
      cwd,
      sharedServers: synth.sharedServers.map((name) => ({ name })),
      perPtyServers: [],
      bridgeBaseUrl: synth.bridgeBaseUrl(),
      identity,
    }));
  } catch (err) {
    Promise.resolve(synth.revoke(key)).catch(() => {
      // Fire-and-forget; the throw below is the operator-visible signal.
    });
    throw err;
  }
  return path.length > 0 ? path : undefined;
}

/**
 * Synthesize a per-JOB `--mcp-config` for the headless agent-job spawn path
 * (`dispatch_job` → `runAgentJobHeadless`).
 *
 * Issue #165 wired `mcp.shared` into the legacy PTY supervisor and then into
 * the bus agent spawn. The agent-job spawn is the THIRD spawn path and was
 * never wired: `runAgentJobHeadless` builds its argv by hand, so a dispatched
 * job started with no `--mcp-config` at all and could not reach a single
 * shared server — while the dispatching agent, spawned from the same daemon,
 * could.
 *
 * Unlike a long-lived agent (one agent = one identity for the process's whole
 * life), a job's identity is minted per run and MUST be released when the run
 * ends — see `releaseAgentJobMcpConfig`. Callers pass a generated `jobKey`.
 *
 * Scope is `mcp.shared` only, and there is deliberately no `AgentConfig`
 * parameter: the "static `agent.mcp_config` ALWAYS wins" precedence that
 * `synthesizeBusMcpConfig` enforces is applied by the CALLER on this path
 * (`staticAgentMcpConfig` in `runtime-mount.ts`), which forwards the
 * operator's path instead of calling this function at all.
 *
 * Throws when synthesis is active but the write fails, matching the
 * supervisor's contract (SPEC §4.5: fail the spawn, never fall through to a
 * silent no-MCP run). The job is then marked failed with that error.
 */
export function synthesizeAgentJobMcpConfig(
  jobKey: string,
  synth: BusMcpConfigSynthesizer | null,
  cwd: string,
): string | undefined {
  return synthesizeMcpConfigForKey(jobKey, synth, cwd);
}

/**
 * Drop a job's multiplexer identity and delete its synthesized config file.
 * Best-effort and idempotent: a job that never got a config (dormant
 * multiplexer) releases nothing, and a failure never fails the job — the run
 * is already over by the time this is called.
 *
 * Deliberately NOT async, mirroring `cleanupAgentMcpConfig`: `revoke` closes
 * transports and writes the multiplexer's persistence file, so awaiting it
 * would sit between the job settling and `AgentJobRunner.finish()` — holding
 * a concurrency slot for the whole teardown, and holding it FOREVER if a
 * close ever hangs. The unlink stays synchronous so the 0600 bearer file is
 * gone the moment the run ends.
 *
 * Failures are logged rather than swallowed: a directory that has become
 * unwritable would otherwise leave a live bearer token on disk after every
 * dispatch with no operator signal at all.
 */
export function releaseAgentJobMcpConfig(
  jobKey: string,
  synth: BusMcpConfigSynthesizer | null,
  cwd: string,
  logger: Pick<Console, "warn"> = console,
): void {
  if (!synth) return;
  try {
    deleteConfigForPty(cwd, jobKey);
  } catch (err) {
    logger.warn(`[bus-session] job=${jobKey} mcp-config cleanup failed`, err);
  }
  Promise.resolve(synth.revoke(jobKey)).catch((err) =>
    logger.warn(`[bus-session] job=${jobKey} mcp identity revoke failed`, err),
  );
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
  // The plugin's `.mcp.json` launches the plus-bus MCP server with
  // `${CCAW_BUS_BUN_PATH:-bun}` (claude expands it), so no shell script sits
  // in between — a bash launcher never started on win32 (#586).
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
 * Bus tools pre-allowed for every bus agent via `--allowedTools`, so claude
 * doesn't prompt the user before the agent sends an outbound message
 * through the bus or reads schedule state. These only call back through the
 * IPC channel.
 */
const PLUS_BUS_TOOLS_ALLOWED: ReadonlySet<string> = new Set([
  "reply",
  "edit_message",
  "ask",
  "cancel",
  "request_human",
  "list_scheduled_tasks",
]);

/**
 * Bus tools pre-allowed only for an agent that runs without approvals
 * (`bypassPermissions`, the default). `dispatch_job` and `schedule_task`
 * start work that runs headless under the daemon-wide permission mode
 * (`buildSecurityArgs`), not this agent's; `delete_scheduled_task` can remove
 * a task from the shared jobs directory when the agent has no directory of
 * its own; `job_status`, `list_jobs` and `cancel_job` reach every agent's
 * jobs, not only the caller's. For an agent under approvals the permission
 * flow is the only gate in front of that, so it stays.
 */
const PLUS_BUS_TOOLS_ALLOWED_WITHOUT_APPROVALS: ReadonlySet<string> = new Set([
  "dispatch_job",
  "schedule_task",
  "delete_scheduled_task",
  "job_status",
  "list_jobs",
  "cancel_job",
]);

/**
 * The `--allowedTools` entries for the plus-bus tools, built from
 * `BUS_MCP_TOOLS` (what the server answers `tools/list` with) so the names
 * match what claude sees. A tool in neither set above is never pre-allowed:
 * classify each new bus tool here. The hand-kept list this replaces had
 * drifted, leaving the job and schedule tools out (#523).
 */
function plusBusAllowedTools(permissionMode: AgentConfig["permission_mode"]): string[] {
  const approvals = (permissionMode ?? "bypassPermissions") !== "bypassPermissions";
  return BUS_MCP_TOOLS.filter(
    (tool) =>
      PLUS_BUS_TOOLS_ALLOWED.has(tool.name) ||
      (!approvals && PLUS_BUS_TOOLS_ALLOWED_WITHOUT_APPROVALS.has(tool.name)),
  ).map((tool) => `mcp__plugin_${CLAUDECLAW_PLUGIN_NAME}_${PLUS_BUS_CHANNEL}__${tool.name}`);
}

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
 * #326: how long the collision detector keeps listening after a NON-ZERO exit
 * whose marker has not been seen yet. `onData` and `onExit` ride two
 * independent PTY channels (a read loop and a wait loop), so under load the
 * exit can be delivered ahead of the process's own last output; concluding
 * "no collision" at that instant is what made the rotation tests flake. Only
 * a boot crash without the marker pays this (a real collision resolves the
 * moment its marker lands), and it is capped by the remaining window.
 */
const COLLISION_EXIT_DRAIN_MS = 250;
/** Rolling window the collision marker is matched against — wide enough for
 *  the marker line plus the escape codes the TUI wraps it in. */
const COLLISION_MARKER_WINDOW_CHARS = 400;
/** Issue #393: an exit this soon after spawn is a boot failure (claude never
 *  reached the REPL — auth, a dialog it could not pass, a broken install), and
 *  the exit log line names it as one instead of leaving it to be inferred. */
const BOOT_FAILURE_WINDOW_MS = 20_000;

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

/** How long `clearSession()` waits for `stop()` before the OS confirmation (and a SIGKILL) decides. */
const CLEAR_STOP_BOUND_MS = 8000;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A spawn failed because the process it started could not be recorded (#595 r4). `retired` says
 * whether the OS confirmed the unrecorded process gone; when it did not, its session is quarantined.
 */
export class SpawnUnrecordedError extends Error {
  readonly code = "ownership-record-failed";
  constructor(
    agentId: string,
    readonly stage: "identity-read" | "write",
    readonly retired: boolean,
  ) {
    super(
      `agent ${agentId}: the spawned claude could not be recorded (${stage}), so it was ended and the spawn failed` +
        (retired ? "" : "; it is not confirmed gone, so its session is quarantined"),
    );
    this.name = "SpawnUnrecordedError";
  }
}

/** The `/clear` replacement exited during startup: nothing is running, so the clear did not happen. */
export class ClearReplacementExitedError extends Error {
  readonly code = "clear-replacement-exited";
  constructor(agentId: string, exitedWithin: string) {
    super(
      `clear failed for agent ${agentId}: the replacement claude exited during startup (${exitedWithin}); the agent is not running`,
    );
    this.name = "ClearReplacementExitedError";
  }
}

/**
 * claude's refusal of `--resume <id>` when it cannot load a conversation for that id
 * ("No conversation found with session ID: <id>", exit 1). #595: the one genuine resume
 * failure that rotates the session; any other boot failure of a resumed spawn does not.
 */
const RESUME_NOT_FOUND_PATTERN = /No conversation found with session ID/;

/**
 * Watch the spawned agent process for the session-id collision marker
 * during a short window after spawn. Resolves true iff the marker is
 * seen AND the process exits with a non-zero code within the window —
 * both are required because claude can echo a similar string in benign
 * contexts and a stale-id failure always pairs with an immediate
 * exit. Resolves false for: alive past the window, clean exit, exit
 * without the marker. `pattern` names the marker (default: the session-id
 * collision); #595 reuses the detector for a resumed spawn's "No conversation
 * found" refusal.
 */
export function detectSessionIdCollision(
  proc: Pick<AgentProcess, "onData" | "onExit" | "recentOutputTail">,
  windowMs: number,
  exitDrainMs: number = COLLISION_EXIT_DRAIN_MS,
  pattern: RegExp = SESSION_COLLISION_PATTERN,
): Promise<boolean> {
  if (windowMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let resolved = false;
    let exitedNonZero = false;
    // Both timers are declared before any handler can run: `onExit` REPLAYS a
    // past exit synchronously at registration (#393), so `finish` may execute
    // inside the `proc.onExit(...)` call below.
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    // Output that landed before this detector attached is not replayed by
    // `onData`; the process keeps its own tail. A marker already on screen at
    // attach time (the child printed and exited before the spawn `await`
    // resumed — the ordering a loaded host produces) counts as seen.
    const tailHasMarker = () => {
      const tail = proc.recentOutputTail?.();
      return tail !== undefined && pattern.test(tail);
    };
    let markerSeen = tailHasMarker();
    // The marker can straddle two PTY chunks (Copilot on the PR): match on a
    // rolling window of recent output, never on one chunk alone.
    let recent = "";
    const finish = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      if (windowTimer) clearTimeout(windowTimer);
      if (drainTimer) clearTimeout(drainTimer);
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
      recent = (recent + chunk).slice(-COLLISION_MARKER_WINDOW_CHARS);
      if (!markerSeen && pattern.test(recent)) {
        markerSeen = true;
        // The exit already came in ahead of this chunk (#326): the verdict
        // was only waiting for it.
        if (exitedNonZero) finish(true);
      }
    });
    proc.onExit((code) => {
      if (code === 0) {
        finish(false);
        return;
      }
      // The marker may have reached the process's tail without passing
      // through our `onData` (delivered before we attached).
      if (!markerSeen && tailHasMarker()) markerSeen = true;
      if (markerSeen) {
        finish(true);
        return;
      }
      // Non-zero exit, marker not seen YET: its last output may still be in
      // flight on the data channel. Hold the verdict for a short drain,
      // bounded by the window that is left.
      exitedNonZero = true;
      const remaining = Math.max(0, windowMs - (Date.now() - startedAt));
      drainTimer = setTimeout(() => finish(false), Math.min(exitDrainMs, remaining));
    });
    if (!resolved) windowTimer = setTimeout(() => finish(false), windowMs);
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
 *
 * Session flag (#595): `--session-id <id>` CREATES a session, and claude refuses it with
 * "Session ID <id> is already in use" when `<projects>/<cwd>/<id>.jsonl` exists. A spawn whose
 * transcript already exists (a restart) must therefore `--resume <id>`; `resume` is that fact,
 * read from the filesystem by the caller (`sessionTranscriptExists`). Default: create.
 */
export function buildClaudeArgs(
  agent: AgentConfig,
  mode: SupervisionMode,
  opts: { resume?: boolean } = {},
): string[] {
  const args: string[] = [];
  if (mode === "process-stream-json") {
    args.push("-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose");
  }
  args.push("--plugin-dir", resolveClaudeclawPluginRoot());
  args.push("--allowedTools", plusBusAllowedTools(agent.permission_mode).join(","));
  // Block Claude Code's native session-scoped scheduling tools so the agent
  // is funnelled to the durable `schedule_task` bus tool instead. See the
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
  args.push(opts.resume ? "--resume" : "--session-id", agent.session_id);
  return args;
}

/**
 * Whether the transcript claude would write for `sessionId` already exists: the very file the
 * CLI `stat`s to decide "Session ID is already in use" (#595). `cwd` is the agent's REAL cwd (the
 * CLI encodes the physical directory). `projectsDir` overrides the projects root (tests, and the
 * tailer's own override); otherwise it is `$CLAUDE_CONFIG_DIR/projects`, as the child sees it.
 */
export function sessionTranscriptExists(opts: {
  cwd: string;
  sessionId: string;
  env: Record<string, string | undefined>;
  projectsDir?: string;
}): boolean {
  const root =
    opts.projectsDir ??
    join(opts.env.CLAUDE_CONFIG_DIR || join(opts.env.HOME || homedir(), ".claude"), "projects");
  return existsSync(join(root, encodeCwdForProjectsDir(opts.cwd), `${opts.sessionId}.jsonl`));
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
  /** Epoch ms of the spawn (issue #393): the exit log line reports uptime,
   *  and an exit within seconds of it is a boot failure and is named as one. */
  spawnedAt: number;
  /** Set by `stop()` before it asks the process to quit (issue #393), so the
   *  spawn-time `onExit` cleanup can tell an exit the daemon asked for from
   *  one it did not — only the latter is logged. */
  stopping?: boolean;
  /**
   * The ownership record written for this process (#595 round 3), or null when none could be
   * (identity unreadable, no store, tmux). Settles shortly after the spawn.
   */
  ownership?: Promise<OwnershipRecord | null>;
  /**
   * False from registration until the ownership write has settled (#595 r4): `getAgent()` hides the
   * process until then, so no prompt reaches a claude that is not yet recorded.
   */
  deliverable: boolean;
  /**
   * Settles with `deliverable` (#595 r5): resolves once the ownership write has settled, rejects when
   * it failed (the spawn is being failed). `recordingPending()` hands it to the bus, which holds
   * every prompt for this agent on it, on both transports, rather than reading `getAgent()`'s
   * undefined as 'unreachable' and sending the prompt over IPC to a claude that is not yet recorded.
   */
  recorded: Promise<void>;
  settleRecorded: { ok: () => void; fail: (err: unknown) => void };
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
  /** #402: tailers constructed per agent, in order — see JsonlTailerOptions.generation. */
  private readonly tailerGeneration = new Map<string, number>();
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
  /** In-flight `clearSession()` per agent: a second `/clear` joins the first instead of racing it. */
  private readonly clearInFlight = new Map<string, Promise<void>>();
  /**
   * Tail of the per-agent LIFECYCLE queue (#595 r4): spawn, restart and `/clear` all retire and/or
   * start the agent's claude, so they run one after another, never beside each other.
   */
  private readonly lifecycleTail = new Map<string, Promise<unknown>>();

  private enqueueLifecycle<T>(agent_id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleTail.get(agent_id) ?? Promise.resolve();
    const run = prev.then(op, op);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTail.set(agent_id, tail);
    void tail.then(() => {
      if (this.lifecycleTail.get(agent_id) === tail) this.lifecycleTail.delete(agent_id);
    });
    return run;
  }

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

  /**
   * The wired synthesizer, or `null` when the multiplexer is dormant. Read by
   * the agent-job spawn path, which lives outside this class but needs the
   * same issuer so a dispatched job reaches the same `mcp.shared` servers as
   * the agent that dispatched it.
   *
   * Only relevant for agents WITHOUT a static `agent.mcp_config`: as on the
   * agent path (`synthesizeBusMcpConfig`), a static config wins and synthesis
   * is skipped, so the job runs with the operator's file and no shared
   * servers — the same surface the long-lived agent gets.
   */
  getMcpConfigSynthesizer(): BusMcpConfigSynthesizer | null {
    return this.mcpSynth;
  }

  async spawnAgent(agent: AgentConfig, origin: BusOrigin): Promise<AgentProcess> {
    return this.enqueueLifecycle(agent.id, () =>
      this.spawnAgentInternal(agent, origin, /* retry */ 0),
    );
  }

  /**
   * Mint a fresh session id for `agent`, persist it, and adopt it on the live config. Used where
   * a stored session cannot be resumed safely (#595 r2). `reason` is a fixed code: nothing the
   * child printed is copied into the log line.
   */
  private async rotateStoredSession(agent: AgentConfig, reason: string): Promise<void> {
    const fresh = randomUUID();
    (this.options.logger ?? console).warn(
      `[bus-session] agent=${agent.id} reason=${reason} session_id=${agent.session_id} — rotating to ${fresh} (the conversation of the old session is not carried over)`,
    );
    const persist =
      this.options.persistRotatedSessionId ??
      ((agentId: string, sessionId: string) => createSession(sessionId, agentId));
    await persist(agent.id, fresh);
    agent.session_id = fresh;
  }

  /**
   * `/clear` as a CONTROLLED RESTART (#595 round 3). Typing `/clear` into the CLI moves it to a new
   * transcript whose id this process never learns, so the stored id would name the pre-clear
   * conversation. Instead the agent's claude is retired and started again on a freshly minted id,
   * persisted: the stored id always equals the live transcript's id.
   *
   * Retirement keeps the #562 semantics: the session is fenced from the first synchronous step; the
   * old process must be CONFIRMED gone by the OS (not by its exit event) before the new one starts;
   * if it cannot be, the session is quarantined, the stored id is left alone, and this rejects. It
   * never reports a clear that did not happen. Not available under tmux, where the daemon does not
   * own the claude.
   *
   * Where the ownership guard does not apply (win32, `ownershipGuardApplies`) nothing can prove the
   * old process gone (no record, and the POSIX `ps` it would be confirmed with does not exist), so a
   * restart would quarantine every clear. There `/clear` keeps its pre-#595 behaviour: it is relayed
   * to the agent as a slash command.
   */
  clearSession(agent_id: string): Promise<void> {
    if (!ownershipGuardApplies(this.options.platform)) return this.relayClear(agent_id);
    const inflight = this.clearInFlight.get(agent_id);
    if (inflight) return inflight;
    const p = this.enqueueLifecycle(agent_id, () => this.clearSessionInternal(agent_id)).finally(
      () => {
        this.clearInFlight.delete(agent_id);
      },
    );
    this.clearInFlight.set(agent_id, p);
    return p;
  }

  /** The pre-#595 `/clear`: typed into the agent's CLI; no restart, no new id, no exit confirmation. */
  private async relayClear(agent_id: string): Promise<void> {
    const record = this.agents.get(agent_id);
    if (!record) throw new Error(`clear: no active agent for id=${agent_id}`);
    await record.proc.send_slash("clear");
  }

  /**
   * End the claude in `record` and return only once the OS confirms it gone (#562 semantics, shared by
   * `/clear` and by a spawn that could not be recorded). The session is fenced from the first
   * synchronous step; `owned` (the ownership record, if any) lets the confirmation SIGKILL exactly that
   * process once; an exit that cannot be confirmed quarantines the session and throws. The registry
   * slot is free when this returns.
   */
  private async retireLive(
    agent_id: string,
    record: AgentRecord,
    owned: OwnershipRecord | null | undefined | Promise<OwnershipRecord | null>,
    ctx: { quarantineReason: string; logReason: string; failure: string },
  ): Promise<void> {
    const log = this.options.logger ?? console;
    const sessionId = record.agent.session_id;
    const key = `bus:${agent_id}`;
    const pid = record.proc.pid;
    const probe = this.options.processProbe ?? createSystemProbe();
    const stageMs = this.options.ownershipTermMs ?? 2000;

    // #562: fenced before the first await, so nothing is spawned on the old session while it retires.
    fenceKey(key, record, () => sessionId);
    try {
      const proven = (await owned) ?? null;
      const stopped = this.stop(agent_id);
      // A process that ignores /quit and SIGTERM must not hold the retirement forever: OS confirmation
      // (with a SIGKILL of the recorded process) decides, not the exit event.
      await Promise.race([stopped, sleepMs(CLEAR_STOP_BOUND_MS)]);
      const confirm = async (): Promise<boolean> => {
        const store = this.options.ownershipStore;
        if (proven && store) {
          return confirmRetired({
            store,
            probe,
            record: proven,
            graceMs: stageMs,
            killMs: stageMs,
          });
        }
        // No record to prove identity with: only a pid that no longer exists counts as gone.
        return (await probe.read(pid, 1500).catch(() => undefined)) === null;
      };
      if (!(await confirm())) {
        const unconfirmed = async (): Promise<void> => {
          if (!(await confirm())) throw new PtyExitUnconfirmedError(key, pid);
        };
        quarantineSession(
          key,
          {
            label: key,
            pid,
            sessionId,
            cwd: record.agent.cwd,
            isAlive: () => true,
            dispose: unconfirmed,
            confirmExit: unconfirmed,
          } as unknown as PtyProcess,
          ctx.quarantineReason,
          record,
        );
        log.error(
          `[bus-session] agent=${agent_id} reason=${ctx.logReason} session_id=${sessionId} pid=${pid} — ${ctx.failure}: the claude is not confirmed gone, so the session is quarantined and keeps its id`,
        );
        throw new Error(
          `${ctx.failure} for agent ${agent_id}: the old claude (pid ${pid}) is not confirmed gone; session ${sessionId} stays quarantined and keeps its id`,
        );
      }
      // Let stop()'s own bookkeeping land before a new process takes the registry slot.
      await Promise.race([stopped, sleepMs(1000)]);
      if (this.agents.get(agent_id) === record) this.agents.delete(agent_id);
    } finally {
      liftFence(record);
    }
  }

  private async clearSessionInternal(agent_id: string): Promise<void> {
    const record = this.agents.get(agent_id);
    if (!record) throw new Error(`clear: no active agent for id=${agent_id}`);
    if (record.mode === "tmux") {
      throw new Error(
        `clear: agent ${agent_id} runs under tmux, where its claude is not owned by the daemon and cannot be retired`,
      );
    }
    const log = this.options.logger ?? console;
    const { agent, origin } = record;
    const oldId = agent.session_id;

    await this.retireLive(agent_id, record, record.ownership, {
      quarantineReason: "bus-clear-exit-unconfirmed",
      logReason: "clear-retire-unconfirmed",
      failure: "clear failed",
    });

    const fresh = randomUUID();
    const persist =
      this.options.persistRotatedSessionId ??
      ((agentId: string, sessionId: string) => createSession(sessionId, agentId));
    try {
      await persist(agent_id, fresh);
    } catch (err) {
      log.error(
        `[bus-session] agent=${agent_id} reason=clear-persist-failed session_id=${oldId} — the clear failed; the old session is restarted`,
        err,
      );
      // The agent must not stay down for a failed write: bring the old session back, then fail.
      await this.spawnAgentInternal(agent, origin, 0).catch((e) =>
        log.error(`[bus-session] agent=${agent_id} reason=clear-restore-failed`, e),
      );
      throw new Error(`clear failed for agent ${agent_id}: the new session id could not be stored`);
    }
    agent.session_id = fresh;
    // Spawn completion is not success (#595 r4): a replacement that exits during startup (auth
    // failure, crash) leaves no agent. The spawn returns after its startup window, so a process that
    // is not live and registered here did not survive it.
    const replacement = await this.spawnAgentInternal(agent, origin, 0);
    const live = this.agents.get(agent_id);
    if (!live || live.proc !== replacement || live.proc._isExited()) {
      log.error(
        `[bus-session] agent=${agent_id} reason=clear-replacement-exited session_id=${fresh} — the clear failed: the replacement claude exited during startup; the agent is not running (old session ${oldId} was retired)`,
      );
      throw new ClearReplacementExitedError(agent_id, `new session ${fresh}`);
    }
    log.warn(
      `[bus-session] agent=${agent_id} reason=session-cleared session_id=${oldId} — restarted on new session ${fresh} (the conversation of the old session is not carried over)`,
    );
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
    // #595: a stored session whose transcript exists is RESUMED. `--session-id` would create it
    // again, and claude refuses that ("already in use"), which used to rotate the id and lose the
    // conversation on every restart. The test seam (`argsOverride`) replaces the whole argv, so
    // nothing is resumed there.
    const resume =
      this.options.argsOverride === undefined &&
      sessionTranscriptExists({
        cwd: realCwd,
        sessionId: agent.session_id,
        env,
        projectsDir: this.options.projectsDir,
      });
    // #595 r3: the CLI takes no lock on `--resume`, so a claude of ours that outlived the previous
    // daemon would append to the same transcript as the one about to be resumed. The guard looks
    // ONLY at the ownership record written when the bus spawned that claude, and signals only a
    // process that record proves ours (previous boot, same start identity). Anything it cannot
    // prove rotates to a fresh id instead (the conversation is lost, nothing is signalled).
    // win32 has no guard and no record (`ownershipGuardApplies`): it keeps its pre-#595 behaviour.
    if (resume && this.options.ownershipStore && ownershipGuardApplies(this.options.platform)) {
      const decision = await decideResume({
        agentId: agent.id,
        sessionId: agent.session_id,
        store: this.options.ownershipStore,
        probe: this.options.processProbe ?? createSystemProbe(),
        bootId: this.options.bootId,
        deadlineMs: this.options.ownershipGuardMs,
        termMs: this.options.ownershipTermMs,
        killMs: this.options.ownershipTermMs,
      });
      if (decision.kind === "rotate") {
        await this.rotateStoredSession(agent, decision.reason);
        return this.spawnAgentInternal(agent, origin, retry);
      }
      if (decision.reason === "orphan-reaped") {
        (this.options.logger ?? console).warn(
          `[bus-session] agent=${agent.id} reason=resume-orphan-reaped session_id=${agent.session_id} pid=${decision.reapedPid} — ended a claude this daemon spawned in an earlier boot before resuming its session`,
        );
      }
    }
    const args = this.options.argsOverride ?? buildClaudeArgs(agent, mode, { resume });

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
      // Issue #528: an interactive claude stalls on the trust dialog ("No,
      // exit" preselected) the first time it runs in a cwd. The legacy PTY
      // supervisor pre-accepts it; the bus spawn path must too, or a fresh
      // ~/.claude.json (container recreate) leaves the agent never connecting.
      // Best-effort: a failure is logged and the spawn proceeds.
      if (mode === "pty-stdin" || mode === "tmux") {
        const heal = await ensureTrustAccepted(realCwd);
        if (!heal.ok) {
          (this.options.logger ?? console).warn(
            `[bus-session] agent=${agent.id} trust self-heal failed for ${realCwd}: ${heal.reason ?? "unknown"}`,
          );
        }
      }
      // #562 round 8: the same gate every other start on a session passes. The bus names its
      // agent's session with `--session-id`, so a transcript the PTY supervisor still has an
      // unconfirmed writer on is not started beside it.
      await assertSessionWritable({ sessionId: agent.session_id });
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

    // #595 r4: the first statement after the process exists. Everything below until the write settles
    // is synchronous, so the only gap in which a daemon death leaves an unrecorded claude is the
    // identity read plus the write itself.
    const recording = this.recordSpawnOwnership(agent, mode, proc);

    // Register the proc + attach the cleanup `onExit` BEFORE awaiting
    // the collision detector. Codex P1 on this PR: if the process exits
    // during the detection window for a non-collision reason (auth
    // error, missing config, claude crash) and we register after the
    // await, our `proc.onExit` handler is pushed onto a handler array
    // whose owning proc has already exited. (Since #393 `onExit` replays a
    // past exit synchronously at registration, so this ordering is also a
    // correctness guard for the detector below, which may resolve inside
    // its own `onExit` call.) Registering after the await used to leave a
    // dead entry in `this.agents` that broke the next `already spawned` guard.
    let settleRecorded!: AgentRecord["settleRecorded"];
    const recorded = new Promise<void>((ok, fail) => {
      settleRecorded = { ok, fail };
    });
    // A waiter reads the rejection; with none waiting it must not surface as an unhandled one.
    recorded.catch(() => {});
    const record: AgentRecord = {
      agent,
      origin,
      mode,
      proc,
      mcpConfigCwd,
      spawnedAt: Date.now(),
      deliverable: false,
      recorded,
      settleRecorded,
    };
    // #402/#412: number this process's tailer generation and announce it to
    // the bus BEFORE the record goes live — from `agents.set` on, the bus's
    // PTY handler resolves this proc as the delivery target, and the
    // collision wait below takes 2 s on a healthy spawn. A prompt typed into
    // the replacement in that window must be tagged with its generation, not
    // the one being replaced. The announce is monotonic, so a collided attempt
    // that never builds its tailer leaves nothing behind; the retry announces
    // the next number and its tailer carries that one.
    const tailerGeneration = this.options.bus
      ? (this.tailerGeneration.get(agent.id) ?? 0) + 1
      : undefined;
    if (this.options.bus && tailerGeneration !== undefined) {
      this.tailerGeneration.set(agent.id, tailerGeneration);
      this.options.bus.noteSpawnedGeneration?.(agent.id, tailerGeneration);
    }
    this.agents.set(agent.id, record);
    // #595 r3: the record that THIS daemon spawned this process, so a later start can prove ownership.
    // The exit handler and a retirement read it as 'the record, or null': a failed write is handled
    // below, not here.
    record.ownership = recording.catch((err) =>
      err instanceof OwnershipRecordError ? err.record : null,
    );
    // The collision detector's verdict for this spawn, once it is armed below.
    // The exit log reads it so that "collision" is said by ONE judge (#326):
    // deciding from the screen tail at the instant of the exit mis-described a
    // collision whose marker was still in flight as "nothing was printed".
    let collisionVerdict: Promise<boolean> | null = null;
    // Auto-cleanup: drop registry entry on exit so restart() can reuse the id.
    proc.onExit((code) => {
      const current = this.agents.get(agent.id);
      if (current && current.proc === proc) {
        // Issue #393: an exit the daemon did not ask for used to be silent —
        // no agent id, no exit code, no output — so a claude that died at
        // boot every restart (#390) left the operator with `spawned` and
        // `reconcile-restart-ok` lines that all read as success. Say what
        // happened and quote the last lines of the screen. `stop()` sets
        // `stopping` first, so its exits stay quiet.
        if (!current.stopping) {
          const uptimeMs = Date.now() - current.spawnedAt;
          const verdictPromise = collisionVerdict;
          void (async () => {
            // Wait for the detector (it drains a non-zero exit for its marker,
            // #326) so the line quotes the screen the verdict was made on.
            const tailFn = (proc as AgentProcess).recentOutputTail;
            const tail = tailFn ? tailFn.call(proc) : undefined;
            // One judge: when the detector ran, its verdict is the verdict —
            // a marker-like line in the tail after a clean exit or an expired
            // window must not make the log disagree with the spawn path
            // (Copilot on the PR). The tail decides only when no detector was
            // armed (the exit replayed before it, or the window is 0).
            const collision = verdictPromise
              ? await verdictPromise
              : tail !== undefined &&
                (resume ? RESUME_NOT_FOUND_PATTERN : SESSION_COLLISION_PATTERN).test(tail);
            const what = resume ? "resume refused (#595)" : "session-id collision";
            const verdict = collision
              ? retry === 0
                ? ` — ${what}; the spawn is retried with a fresh id`
                : ` — ${what} persisted after rotation`
              : uptimeMs < BOOT_FAILURE_WINDOW_MS
                ? " — exited during boot; treat as a startup failure"
                : "";
            // A refused resume is named by its reason code; the screen adds nothing to it.
            const quoted =
              collision && resume
                ? "    (not quoted: the cause is the reason code above)"
                : tail === undefined
                  ? "    (no output captured in this supervision mode)"
                  : tail || "    (nothing was printed)";
            (this.options.logger ?? console).warn(
              `[bus-session] agent=${agent.id} pid=${proc.pid} exited outside stop(): ` +
                `code=${code} uptime=${(uptimeMs / 1000).toFixed(1)}s${verdict}. Last output:\n${quoted}`,
            );
          })();
        }
        // #595 r3: the exit event is not proof the OS process is gone (bun-pty fires it at once), so
        // the ownership record is cleared only once the OS confirms; otherwise it stays for the
        // next start to examine.
        const ownershipStore = this.options.ownershipStore;
        if (ownershipStore && current.ownership) {
          const probe = this.options.processProbe ?? createSystemProbe();
          void current.ownership.then((rec) =>
            rec ? confirmGoneAndClear({ store: ownershipStore, probe, record: rec }) : undefined,
          );
        }
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
    // A resumed spawn is judged on claude's resume refusal, a created one on the id collision.
    collisionVerdict = detectSessionIdCollision(
      proc,
      collisionWindow,
      COLLISION_EXIT_DRAIN_MS,
      resume ? RESUME_NOT_FOUND_PATTERN : SESSION_COLLISION_PATTERN,
    );
    // #595 r4: a claude that could not be recorded must not keep running: after a daemon death the
    // next boot would read 'no record' as 'nothing of ours' and resume beside it. End it, fail the spawn.
    // Nothing is delivered to it until the record exists (`getAgent` hides it).
    const recordFailure = await recording.then(
      () => null,
      (err: unknown) =>
        err instanceof OwnershipRecordError ? err : new OwnershipRecordError("write", null, err),
    );
    if (recordFailure) {
      // Held prompts fail now with their reason code; none is ever delivered to this process.
      record.settleRecorded.fail(recordFailure);
      await this.failUnrecordedSpawn(agent, record, recordFailure, mcpConfigCwd);
    }
    record.deliverable = true;
    record.settleRecorded.ok();
    const collision = await collisionVerdict;
    if (collision && retry === 0) {
      const fresh = randomUUID();
      // The reason is a fixed code: what claude printed is never copied into this line.
      const reason = resume ? "resume-rejected-no-conversation" : "session-id-in-use";
      (this.options.logger ?? console).warn(
        `[bus-session] agent=${agent.id} reason=${reason} session_id=${agent.session_id} — rotating to ${fresh} and respawning (the conversation of the old session is not carried over)`,
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
      // Widen to the interface: `proc` is the concrete union
      // `PtyAgentProcess | ChildAgentProcess`, and an optional member on the
      // interface is not visible through a union of the classes implementing
      // it. Both implement `AgentProcess`, so the transcript hooks are reached
      // through it — and a runtime without them stays a no-op via `?.`.
      const confirmable: AgentProcess = proc;
      // #402: the generation numbered (and announced, #412) before the record
      // went live above, so the bus can order this tailer's markers.
      const generation = tailerGeneration as number;
      const tailer = new JsonlTailer({
        bus: this.options.bus,
        agent_id: agent.id,
        session_id: agent.session_id,
        cwd: realCwd,
        startAt: "end",
        projectsDir: this.options.projectsDir,
        generation,
        // Issue #362: feed the transcript's prompt-ingestion fact back to the
        // PTY delivery-confirm loop, which otherwise has only the rendered
        // terminal to judge by and cannot distinguish a submitted prompt from
        // a repaint. `startAt: "end"` above is what makes this safe on a
        // resumed session: historical prompts are never replayed, so this can
        // only ever fire for a prompt typed by this process.
        onPromptIngested: (ingestion) => confirmable.notePromptIngested?.(ingestion),
        // #212: the tailer saw the boundary — record its proof on the receipt.
        onTurnObserved: (observation) => void confirmTurnReceipt(observation),
        // #383: every line, so the process can tell a transcript that went
        // quiet for good (rotated away by `/clear`) from one that is slow.
        onTranscriptLine: () => confirmable.noteTranscriptActivity?.(),
        // Only once a line has actually been read does the process stop
        // trusting a post-compaction repaint. Enabling it at wiring time would
        // strand any agent whose transcript path does not resolve: the strict
        // branch would wait for a signal that can never arrive.
        onTranscriptAlive: () => confirmable.enableTranscriptConfirmation?.(),
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

  /**
   * Write the ownership record for a just-spawned process (#595 r3). Resolves null when there is
   * nothing to record (no store, tmux, win32, the process already gone); REJECTS with `OwnershipRecordError`
   * when the process is alive and could not be recorded (#595 r4), which fails the spawn. tmux is not
   * recorded: the pid is a client that exits at once while the claude lives on in the tmux server.
   */
  private recordSpawnOwnership(
    agent: AgentConfig,
    mode: SupervisionMode,
    proc: AgentProcess,
  ): Promise<OwnershipRecord | null> {
    const store = this.options.ownershipStore;
    if (
      !store ||
      mode === "tmux" ||
      !(proc.pid > 0) ||
      !ownershipGuardApplies(this.options.platform)
    )
      return Promise.resolve(null);
    return recordOwnership({
      store,
      probe: this.options.processProbe ?? createSystemProbe(),
      agentId: agent.id,
      sessionId: agent.session_id,
      pid: proc.pid,
      exe: basename(this.options.commandOverride ?? claudeExecutable()),
      bootId: this.options.bootId,
      timeoutMs: this.options.ownershipRecordMs,
    });
  }

  /**
   * The spawned claude could not be recorded: log ONE line (a reason code and the errno, never screen
   * text), end the process through the shared retirement (so #562's fence and quarantine apply), and
   * throw. Never returns.
   */
  private async failUnrecordedSpawn(
    agent: AgentConfig,
    record: AgentRecord,
    failure: OwnershipRecordError,
    mcpConfigCwd: string | undefined,
  ): Promise<never> {
    const cause = failure.cause as { code?: unknown; name?: unknown } | undefined;
    const detail = String(cause?.code ?? cause?.name ?? "unknown");
    (this.options.logger ?? console).error(
      `[bus-session] agent=${agent.id} reason=${failure.code} stage=${failure.stage} cause=${detail} session_id=${agent.session_id} pid=${record.proc.pid} — the spawned claude could not be recorded; it is ended and the spawn fails`,
    );
    let retired = true;
    try {
      await this.retireLive(agent.id, record, failure.record, {
        quarantineReason: "bus-spawn-unrecorded-exit-unconfirmed",
        logReason: "spawn-retire-unconfirmed",
        failure: "spawn failed",
      });
    } catch {
      retired = false;
    }
    this.cleanupAgentMcpConfig(mcpConfigCwd, agent.id);
    throw new SpawnUnrecordedError(agent.id, failure.stage, retired);
  }

  private async spawnPty(
    agent: AgentConfig,
    args: string[],
    env: Record<string, string>,
    realCwd: string,
  ): Promise<PtyAgentProcess> {
    const cmd = this.options.commandOverride ?? claudeExecutable();
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
    // #562 round 9: the synchronous final word, after the `bun-pty` import above. No await
    // between this check and the spawn.
    assertSessionSpawnable({ sessionId: agent.session_id });
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
    const cmd = this.options.commandOverride ?? claudeExecutable();
    // #562 round 9: the synchronous final word; no await between it and the spawn below.
    assertSessionSpawnable({ sessionId: agent.session_id });
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
    // #562 round 9: the synchronous final word; no await between it and the spawn below.
    assertSessionSpawnable({ sessionId: agent.session_id });
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
    // Issue #393: this exit is asked for — keep the spawn-time exit log quiet.
    record.stopping = true;
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

    const p = this.enqueueLifecycle(agent_id, () => this.restartInternal(agent_id, opts)).finally(
      () => {
        this.restartInFlight.delete(agent_id);
      },
    );
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

    // Already inside the lifecycle queue: the internal spawn, never the queued public one.
    return this.spawnAgentInternal(agent, origin, 0);
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
    const record = this.agents.get(agent_id);
    return record?.deliverable === false ? undefined : record?.proc;
  }

  /**
   * Non-null while `agent_id`'s claude is spawned but its ownership record is not yet written
   * (#595 r5): a state of its own, distinct from 'no such agent'. The promise resolves when the
   * agent becomes deliverable and rejects if it could not be recorded. The bus holds prompts on it.
   */
  recordingPending(agent_id: string): Promise<void> | null {
    const record = this.agents.get(agent_id);
    return record && !record.deliverable ? record.recorded : null;
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
