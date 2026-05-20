import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { parseWatchdogConfig, type WatchdogConfig } from "./watchdog";
import { parsePlugins, type PluginEntry } from "./plugins";
import { parseMemorySearchSettings, type MemorySearchSettings } from "./memory";

/** Re-exported under the name used in the Settings interface. */
export type WatchdogSettings = WatchdogConfig;

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const DEFAULT_JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

/** Default Claude session timeout (30 minutes). Exported so runner.ts can reference the same value. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_IMAGE_OUTPUT_ROOT = join(HEARTBEAT_DIR, "outbox", "discord");

export function getJobsDir(): string {
  if (cached?.jobsDir) {
    return isAbsolute(cached.jobsDir) ? cached.jobsDir : join(process.cwd(), cached.jobsDir);
  }
  return DEFAULT_JOBS_DIR;
}

/** Returns the root directory for agent-scoped sessions and jobs. */
export function getAgentsDir(): string {
  return join(process.cwd(), "agents");
}

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan",
          "design",
          "architect",
          "strategy",
          "approach",
          "research",
          "investigate",
          "analyze",
          "explore",
          "understand",
          "think",
          "consider",
          "evaluate",
          "assess",
          "review",
          "system design",
          "trade-off",
          "decision",
          "choose",
          "compare",
          "brainstorm",
          "ideate",
          "concept",
          "proposal",
        ],
        phrases: [
          "how to implement",
          "how should i",
          "what's the best way to",
          "should i",
          "which approach",
          "help me decide",
          "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement",
          "code",
          "write",
          "create",
          "build",
          "add",
          "fix",
          "debug",
          "refactor",
          "update",
          "modify",
          "change",
          "deploy",
          "run",
          "execute",
          "install",
          "configure",
          "test",
          "commit",
          "push",
          "merge",
          "release",
          "generate",
          "scaffold",
          "setup",
          "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: true,
    forwardToDiscord: true,
  },
  telegram: {
    token: "",
    allowedUserIds: [],
    listenChats: [],
    receiveEnabled: true,
    dmIsolation: "shared",
  },
  discord: {
    token: "",
    allowedUserIds: [],
    listenChannels: [],
    listenGuilds: [],
    imageOutputRoots: [],
    streaming: false,
  },
  slack: {
    botToken: "",
    appToken: "",
    allowedUserIds: [],
    listenChannels: [],
    allowBots: [],
    allowBotIds: [],
  },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  timeouts: { telegram: 5, discord: 5, heartbeat: 15, job: 30, default: 5 },
  pty: {
    // Opt-in by default. Operators flip this to true ONLY after the MCP
    // multiplexer follow-up lands and they've validated OAuth refresh on a
    // test deployment. See README "PTY runner mode" + PR #62 rollout notes.
    enabled: false,
    idleReapMinutes: 30,
    maxRetries: 5,
    backoffMs: [1000, 2000, 4000, 8000, 16000],
    namedAgentsAlwaysAlive: true,
    turnIdleTimeoutMs: 5000,
    cols: 100,
    rows: 30,
    maxConcurrent: 32,
    quietWindowMs: 500,
    sentinelMaxWaitMs: 30_000,
  },
  mcp: {
    // Default empty — the multiplexer is dormant out of the box. Operators
    // opt in by listing server names from mcp-proxy.json here. See SPEC §6.
    shared: [],
    perPtyOnly: [],
    stateless: [],
    healthProbeIntervalMs: 30000,
    // Always-resume default per SPEC-DELTA-2026-05-16. Persistence layer
    // is dormant in practice when `shared` is empty (the multiplexer
    // never starts), so this default is cost-free for non-MCP users.
    sessionPersistenceEnabled: true,
    sessionMaxAgeSeconds: 3600,
    sessionPersistencePath: "",
    rateLimit: { maxRequestsPerWindow: 600, windowMs: 60_000 },
    // Issue #68: cost-tracking metrics on the multiplexer dispatch
    // path. Default OFF for MVP — operators opt in via settings once
    // the schema is stable.
    metricsEnabled: false,
  },
  watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
  session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
  // Default `pty` keeps v1 behaviour byte-identical. Sprint 5.4 will flip
  // this to `bus` after staging validation.
  runtime: "pty",
  // Default no agents. Operators who opt in to `runtime: "bus"` declare
  // agents explicitly. Spec §5.3 / §10 Sprint 5.2.
  agents: [],
  plugins: {},
  memorySearch: {},
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
  forwardToDiscord: boolean;
}

/**
 * Bus runtime routing config for Telegram. Only consulted when
 * `settings.runtime === "bus"`; legacy `runtime: "pty"` ignores this.
 *
 * `chats` is the inbound `chat_id → agent_id` map. `defaultAgentId`
 * catches messages from chats not in the map (omit to silent-drop
 * unrouted chats).
 */
export interface TelegramBusRouting {
  chats: Record<string, string>;
  defaultAgentId?: string;
}

/**
 * Bus runtime routing config for Discord. Spec §5.5.1. Channels and
 * threads are matched against guild channel ids; DMs fall through to
 * `dmAgentId` if set.
 */
export interface DiscordBusRouting {
  channels: Record<string, string>;
  threads?: Record<string, string>;
  dmAgentId?: string;
}

/**
 * Bus runtime routing config for Slack. Spec §5.5.3. `channels` maps
 * `channel_id → agent_id`. `threadAgentId` is the override for
 * thread-only traffic in unrouted channels.
 */
export interface SlackBusRouting {
  channels: Record<string, string>;
  threadAgentId?: string;
  /** Optional override for the Events API signing secret. */
  signingSecret?: string;
}

/**
 * Bus runtime config for the Web UI adapter. Spec §5.5.4. Distinct
 * `bind` so operators can run the Bus Web UI on a different port than
 * the legacy dashboard without losing either.
 */
export interface WebBusConfig {
  bind?: string;
  token?: string;
  allowedAgentIds?: string[];
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  listenChats: number[];
  /** When false, skip Telegram polling (incoming messages). Useful for send-only instances. Default: true */
  receiveEnabled: boolean;
  /**
   * Controls session isolation for Telegram DMs.
   * - "shared": all DMs share the global session (matches Discord DM behaviour). Default.
   * - "perUser": each DM user gets their own isolated session.
   */
  dmIsolation: "shared" | "perUser";
  /** Local whisper.cpp model for voice transcription. Default: "base.en".
   *  Supported values: tiny, base, small, medium, large-v3, large-v3-turbo (with or without .en suffix).
   *  Ignored when stt.baseUrl is configured. */
  whisperModel?: string;
  /** Sprint 5.2b: Bus runtime routing. Ignored under runtime=pty. */
  busRouting?: TelegramBusRouting;
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
  listenGuilds: string[]; // Guild IDs where bot responds to all messages in any channel/thread
  channelNames?: Record<string, string>; // channelId -> friendly name for system prompt context
  imageOutputRoots: string[]; // Absolute path prefixes from which image uploads are permitted
  streaming?: boolean; // When true, POST a live preview while Claude is working. Default: false.
  /** Sprint 5.2b: Bus runtime routing. Ignored under runtime=pty. */
  busRouting?: DiscordBusRouting;
}

export interface SlackConfig {
  botToken: string; // xoxb-... bot token
  appToken: string; // xapp-... Socket Mode token
  /** Slack app signing secret for Events API HTTP verification. Required for Bus runtime HTTP mode. */
  signingSecret?: string;
  allowedUserIds: string[];
  listenChannels: string[]; // Channel IDs where bot responds without @mention
  allowBots: string[]; // Channel IDs where bot-posted messages are passed through
  allowBotIds: string[]; // Optional: Slack app/bot IDs (B...) that may post; empty = any bot in allowBots channel
  /** Sprint 5.2b: Bus runtime routing. Ignored under runtime=pty. */
  busRouting?: SlackBusRouting;
}

export type SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface TimeoutsConfig {
  /** Max minutes for a telegram message subprocess. Default: 5 min. */
  telegram: number;
  /** Max minutes for a discord message subprocess. Default: 5 min. */
  discord: number;
  /** Max minutes for a heartbeat subprocess. Default: 15 min. */
  heartbeat: number;
  /** Max minutes for a scheduled job subprocess. Default: 30 min. */
  job: number;
  /** Max minutes for all other subprocesses (bootstrap, trigger, etc). Default: 5 min. */
  default: number;
}

/**
 * MCP multiplexer settings (SPEC §5). Operators enumerate WHICH MCP servers
 * from `mcp-proxy.json` get hosted shared by the daemon vs spawned per-PTY.
 *
 * Default empty `shared` list keeps the PTY path byte-identical to today —
 * the multiplexer is dormant and Claude Code's stock per-PTY MCP discovery
 * applies. This is the rollback path: clear `shared`, reload settings.
 */
export interface McpConfig {
  /**
   * Names of MCP servers to multiplex over the bridge. Each must also appear
   * in `~/.config/claudeclaw/mcp-proxy.json`. Empty list (default) → multiplexer
   * is dormant.
   */
  shared: string[];
  /**
   * Names of MCP servers that MUST spawn per-PTY locally (security-sensitive
   * filesystem MCPs etc). Mutually exclusive with `shared`. Today a no-op
   * surface (non-shared servers already spawn per-PTY); listed here for
   * future extension (per-PTY env scoping, ACL hooks).
   */
  perPtyOnly: string[];
  /**
   * Subset of `shared`. Declares that the MCP server has no per-session state
   * and can safely share one upstream MCP session across all PTYs. Default
   * empty → assume every shared server is stateful (per-PTY session map).
   */
  stateless: string[];
  /**
   * Interval in milliseconds between health-probe samples of each shared
   * MCP server. Set to 0 to disable. Default: 30000 (30s).
   *
   * The probe samples each `McpServerProcess.status` and emits a structured
   * audit event + log line on transitions (e.g. `up` → `crashed`). Pairs
   * with the per-server crash/failure events already emitted by the proxy
   * substrate. Filed in response to Nibbler review on #64: the silent
   * degradation mode (one shared MCP crashes → all PTYs lose that tool)
   * needs an operator-visible signal before `pty.enabled: true` ships.
   */
  healthProbeIntervalMs: number;
  /**
   * Master switch for bridge-side session-map persistence. When true (the
   * always-resume default per SPEC-DELTA-2026-05-16), the multiplexer
   * persists (server, ptyId, sessionId) tuples to disk on every mutation
   * and replays them on `start()`. Flip to false as a kill-switch escape
   * hatch if the persistence layer itself misbehaves in production; the
   * multiplexer then reverts to PR #71 behaviour (buckets in memory only,
   * daemon restart loses stateful sessions).
   *
   * Default: true.
   */
  sessionPersistenceEnabled: boolean;
  /**
   * Maximum age (seconds) of a persisted (server, pty) entry. Entries older
   * than this on load are dropped with audit
   * `mcp_session_lost_on_restart reason=ttl_expired`. Should be ≥
   * `pty.idleReapMinutes * 60` — entries older than the PTY reap window
   * correspond to PTYs that have been idle-reaped and would be
   * re-initialised on next message anyway.
   *
   * Default: 3600 (1 hour). Clamped to a minimum of 60.
   */
  sessionMaxAgeSeconds: number;
  /**
   * Directory holding the session store. Empty string (default) means
   * "compute from homedir at start time" — the multiplexer resolves to
   * `~/.config/claudeclaw/mcp-sessions/`. Operator-overridable to an
   * absolute path. Non-absolute paths are ignored with a warning and the
   * default is used.
   */
  sessionPersistencePath: string;
  /**
   * Per-bearer (i.e. per-PTY) rate limit on `/mcp/<server>` requests
   * (#72 item 1). The `/mcp/<server>` route is bearer-only: a leaked
   * bearer would otherwise allow full replay of MCP calls against the
   * shared upstream until the issuing PTY respawns. Defense-in-depth
   * cap on requests per PTY per sliding window.
   *
   * Default: 600 requests per 60s (10/sec sustained — generous for
   * tool-call traffic, tight enough to limit damage from a leaked
   * bearer). Set `maxRequestsPerWindow: 0` to disable.
   */
  rateLimit: {
    /** Cap on requests per `windowMs` per `ptyId`. 0 = disabled. */
    maxRequestsPerWindow: number;
    /** Sliding-window length in milliseconds. */
    windowMs: number;
  };
  /**
   * Cost-tracking metrics on the multiplexer dispatch path (issue #68).
   * Per-tuple `(serverName, bucketKey, toolName)` counters + latency
   * samples (p50/p95/p99). Default `false` for MVP; flip on once the
   * schema is stable.
   *
   * When `true`, metrics are exposed at `/api/multiplexer/metrics`
   * (operator-only — bootstrap-token-authenticated).
   */
  metricsEnabled: boolean;
}

export interface PtyConfig {
  /** Master switch. When false (default), runner uses today's `claude -p` path
   *  for every callsite. Operators flip to true ONLY after the MCP multiplexer
   *  follow-up ships and they've validated OAuth refresh on a test deployment.
   *  See README "PTY runner mode". */
  enabled: boolean;
  /** Ad-hoc thread PTYs are disposed after this many minutes of inactivity.
   *  Named agents are NEVER reaped when namedAgentsAlwaysAlive is true.
   *  Default: 30. */
  idleReapMinutes: number;
  /** Maximum number of crash-respawn-replay attempts per event.
   *  Default: 5. */
  maxRetries: number;
  /** Backoff between retries (ms). Cycles through this list; if maxRetries
   *  exceeds the list length, the last value is reused.
   *  Default: [1000, 2000, 4000, 8000, 16000]. */
  backoffMs: number[];
  /** When true, agents under agents/*\/ get a PTY pre-spawned at startup and
   *  kept alive indefinitely. When false, all PTYs are lazy + idle-reaped.
   *  Default: true. */
  namedAgentsAlwaysAlive: boolean;
  /** Safety net: if a turn produces no PTY bytes for this many ms AND no
   *  OSC progress-end has been seen, the turn is considered complete.
   *  Default: 5000. */
  turnIdleTimeoutMs: number;
  /** Initial PTY columns. Default: 100. */
  cols: number;
  /** Initial PTY rows. Default: 30. */
  rows: number;
  /**
   * Hard cap on concurrent live PTYs. When the cap is hit, the supervisor
   * evicts the LRU ad-hoc PTY (named agents are exempt — they're guarded by
   * `namedAgentsAlwaysAlive`). Prevents a Discord/Telegram thread burst from
   * accumulating dozens of idle `claude` processes faster than the 30-min
   * idle-reaper can clear them. Default: 32.
   */
  maxConcurrent: number;
  /**
   * Quiet window before the supervisor writes the turn-end sentinel into the
   * PTY (issue #81 — claude 2.1.89 dropped OSC 9;4 progress markers, so we
   * detect turn completion via a sentinel-echo round-trip instead). When the
   * byte stream has been silent for this many ms, the supervisor writes the
   * sentinel and waits for claude's TUI to echo it back. Lower values reduce
   * per-turn latency overhead but risk false-positives during legitimate
   * mid-turn pauses (model thinking, slow streaming, etc.). Default: 500.
   */
  quietWindowMs: number;
  /**
   * Hard cap on how long the supervisor waits for the sentinel echo after
   * writing it. If the sentinel never echoes back (claude crashed, TUI
   * stalled), the turn completes with `cleanBoundary=false` and whatever
   * bytes have been captured so far. Default: 30000 (30s).
   */
  sentinelMaxWaitMs: number;
}

/**
 * Daemon runtime selector. `pty` is the legacy stack (PTY supervisor +
 * `claude -p` for non-PTY paths) and remains the v1 default. `bus` mounts
 * the Sprint 1-4 Bus stack (BusCore + SessionManager + per-surface
 * adapters + JSONL tailer) per spec §10 Sprint 5.
 *
 * The two runtimes share neither IPC nor state — the switch happens at
 * daemon startup in `src/commands/start.ts`.
 */
export type RuntimeMode = "pty" | "bus";

/**
 * Operator-facing supervision picker. Mirrors the spec's internal
 * `SupervisionMode` but kept as a separate config string so settings.json
 * remains a stable surface even if the internal enum changes.
 */
export type BusSupervisionMode = "pty-stdin" | "tmux" | "process" | "process-stream-json";

/**
 * One Bus runtime agent declared in `settings.agents`. The daemon
 * auto-spawns one `claude` per entry at startup when `runtime: "bus"`.
 *
 * `id` is the only required field — defaults keep settings.json terse
 * for the common single-agent case.
 */
export interface BusAgentSettings {
  /**
   * Stable slug. Becomes part of the UDS socket path on macOS (≤36 chars
   * after the bus.sock prefix) and the `agents/<id>/session.json`
   * directory. Required.
   */
  id: string;
  /** Working directory the spawned claude runs in. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Permission mode for the spawned claude. Defaults to `"plan"`. */
  permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
  /**
   * Override the supervision picker. Default is mode-dependent (see
   * `defaultSupervisionFor` in `src/bus/types.ts`). Operators rarely
   * need to set this.
   */
  supervision?: BusSupervisionMode;
  /** Path to a system-prompt addendum appended to claude's system prompt. */
  system_prompt_file?: string;
  /** Path to a per-agent MEMORY.md surfaced to the spawned claude. */
  memory_file?: string;
  /** Path to a per-agent MCP config (extra MCP servers). */
  mcp_config?: string;
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  security: SecurityConfig;
  web: WebConfig;
  stt: SttConfig;
  apiToken?: string;
  sessionTimeoutMs: number;
  timeouts: TimeoutsConfig;
  /**
   * Daemon runtime selector. Defaults to `"pty"` for v1 compatibility.
   * Sprint 5.4 will flip the default to `"bus"` after Hetzner staging
   * validation; until then operators opt in by setting this to `"bus"`
   * in `settings.json`.
   */
  runtime: RuntimeMode;
  /**
   * Bus runtime agent declarations. Only consulted when `runtime: "bus"`;
   * `runtime: "pty"` ignores this field entirely. Empty list = the daemon
   * mounts the Bus stack but spawns no agents (operator wires them via
   * REST/CLI later). See `BusAgentSettings` for the per-agent shape.
   */
  agents: BusAgentSettings[];
  pty: PtyConfig;
  mcp: McpConfig;
  watchdog: WatchdogSettings;
  plugins: Record<string, PluginEntry>;
  session: SessionConfig;
  memorySearch: MemorySearchSettings;
  jobsDir?: string;
}

export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Sprint 5.2b: Bus runtime Web UI config. Ignored under runtime=pty. */
  bus?: WebBusConfig;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, claudeclaw routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
  /** MCP tool name or CLI command to delegate transcription to (e.g. "mcp__whisper__transcribe"
   *  or "whisper"). When set, whisper is skipped and Claude is asked to call this tool directly
   *  with the audio file path. When unset (default), whisper handles transcription. */
  delegateTool?: string;
}

export interface SessionConfig {
  /** Automatically rotate the global session when a threshold is exceeded. Default: false. */
  autoRotate: boolean;
  /** Rotate after this many messages. Default: 50. */
  maxMessages: number;
  /** Rotate after this many hours. Default: 24. */
  maxAgeHours: number;
  /** Directory to write markdown summaries before rotation. Empty string disables summaries. */
  summaryPath: string;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(getJobsDir(), { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>(["locked", "strict", "moderate", "unrestricted"]);

function parseAgenticMode(raw: any): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .filter((k: unknown) => typeof k === "string")
        .map((k: string) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(raw.phrases)
    ? raw.phrases
        .filter((p: unknown) => typeof p === "string")
        .map((p: string) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: any): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;

  const enabled = raw.enabled ?? false;

  // Backward compat: old planningModel/implementationModel format
  if (!Array.isArray(raw.modes) && ("planningModel" in raw || "implementationModel" in raw)) {
    const planningModel = typeof raw.planningModel === "string" ? raw.planningModel.trim() : "opus";
    const implModel =
      typeof raw.implementationModel === "string" ? raw.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  // New modes format
  const modes: AgenticMode[] = [];
  if (Array.isArray(raw.modes)) {
    for (const m of raw.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

function parseSettings(raw: Record<string, any>, discordUserIds?: string[]): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
      forwardToTelegram: raw.heartbeat?.forwardToTelegram ?? false,
      forwardToDiscord: raw.heartbeat?.forwardToDiscord ?? true,
    },
    telegram: {
      token:
        process.env.TELEGRAM_TOKEN?.trim() ||
        (typeof raw.telegram?.token === "string" ? raw.telegram.token.trim() : ""),
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
      listenChats: Array.isArray(raw.telegram?.listenChats)
        ? raw.telegram.listenChats.map(Number)
        : [],
      receiveEnabled: raw.telegram?.receiveEnabled !== false,
      dmIsolation: raw.telegram?.dmIsolation === "perUser" ? "perUser" : "shared",
      ...(typeof raw.telegram?.whisperModel === "string" && raw.telegram.whisperModel.trim()
        ? { whisperModel: raw.telegram.whisperModel.trim() }
        : {}),
      ...(parseTelegramBusRouting(raw.telegram?.busRouting)
        ? { busRouting: parseTelegramBusRouting(raw.telegram?.busRouting)! }
        : {}),
    },
    discord: {
      token:
        process.env.DISCORD_TOKEN?.trim() ||
        (typeof raw.discord?.token === "string" ? raw.discord.token.trim() : ""),
      allowedUserIds:
        Array.isArray(discordUserIds) && discordUserIds.length > 0
          ? discordUserIds
          : Array.isArray(raw.discord?.allowedUserIds)
            ? raw.discord.allowedUserIds.map(String)
            : [],
      listenChannels: Array.isArray(raw.discord?.listenChannels)
        ? raw.discord.listenChannels.map(String)
        : [],
      listenGuilds: Array.isArray(raw.discord?.listenGuilds)
        ? raw.discord.listenGuilds.map(String)
        : [],
      channelNames:
        raw.discord?.channelNames && typeof raw.discord.channelNames === "object"
          ? Object.fromEntries(
              Object.entries(raw.discord.channelNames as Record<string, unknown>).map(([k, v]) => [
                String(k),
                String(v),
              ]),
            )
          : undefined,
      imageOutputRoots: Array.isArray(raw.discord?.imageOutputRoots)
        ? raw.discord.imageOutputRoots.filter(
            (r: unknown) => typeof r === "string" && isAbsolute(r),
          )
        : [],
      streaming: raw.discord?.streaming === true,
      ...(parseDiscordBusRouting(raw.discord?.busRouting)
        ? { busRouting: parseDiscordBusRouting(raw.discord?.busRouting)! }
        : {}),
    },
    slack: {
      botToken:
        process.env.SLACK_BOT_TOKEN?.trim() ||
        (typeof raw.slack?.botToken === "string" ? raw.slack.botToken.trim() : ""),
      appToken:
        process.env.SLACK_APP_TOKEN?.trim() ||
        (typeof raw.slack?.appToken === "string" ? raw.slack.appToken.trim() : ""),
      allowedUserIds: Array.isArray(raw.slack?.allowedUserIds)
        ? raw.slack.allowedUserIds.map(String)
        : [],
      listenChannels: Array.isArray(raw.slack?.listenChannels)
        ? raw.slack.listenChannels.map(String)
        : [],
      allowBots: Array.isArray(raw.slack?.allowBots) ? raw.slack.allowBots.map(String) : [],
      allowBotIds: Array.isArray(raw.slack?.allowBotIds) ? raw.slack.allowBotIds.map(String) : [],
      ...(typeof raw.slack?.signingSecret === "string" && raw.slack.signingSecret.trim()
        ? { signingSecret: raw.slack.signingSecret.trim() }
        : process.env.SLACK_SIGNING_SECRET?.trim()
          ? { signingSecret: process.env.SLACK_SIGNING_SECRET.trim() }
          : {}),
      ...(parseSlackBusRouting(raw.slack?.busRouting)
        ? { busRouting: parseSlackBusRouting(raw.slack?.busRouting)! }
        : {}),
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools) ? raw.security.allowedTools : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
      ...(parseWebBusConfig(raw.web?.bus) ? { bus: parseWebBusConfig(raw.web?.bus)! } : {}),
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
      ...(typeof raw.stt?.delegateTool === "string" && raw.stt.delegateTool.trim()
        ? { delegateTool: raw.stt.delegateTool.trim() }
        : {}),
    },
    sessionTimeoutMs:
      typeof raw.sessionTimeoutMs === "number" && raw.sessionTimeoutMs > 0
        ? raw.sessionTimeoutMs
        : DEFAULT_SESSION_TIMEOUT_MS,
    timeouts: {
      telegram:
        Number.isFinite(raw.timeouts?.telegram) && Number(raw.timeouts.telegram) > 0
          ? Number(raw.timeouts.telegram)
          : 5,
      discord:
        Number.isFinite(raw.timeouts?.discord) && Number(raw.timeouts.discord) > 0
          ? Number(raw.timeouts.discord)
          : 5,
      heartbeat:
        Number.isFinite(raw.timeouts?.heartbeat) && Number(raw.timeouts.heartbeat) > 0
          ? Number(raw.timeouts.heartbeat)
          : 15,
      job:
        Number.isFinite(raw.timeouts?.job) && Number(raw.timeouts.job) > 0
          ? Number(raw.timeouts.job)
          : 30,
      default:
        Number.isFinite(raw.timeouts?.default) && Number(raw.timeouts.default) > 0
          ? Number(raw.timeouts.default)
          : 5,
    },
    pty: {
      enabled: raw.pty?.enabled === true, // default false — opt-in (see DEFAULT_SETTINGS.pty)
      idleReapMinutes:
        Number.isFinite(raw.pty?.idleReapMinutes) && Number(raw.pty.idleReapMinutes) > 0
          ? Number(raw.pty.idleReapMinutes)
          : 30,
      maxRetries:
        Number.isFinite(raw.pty?.maxRetries) && Number(raw.pty.maxRetries) >= 0
          ? Number(raw.pty.maxRetries)
          : 5,
      backoffMs:
        Array.isArray(raw.pty?.backoffMs) &&
        raw.pty.backoffMs.length > 0 &&
        raw.pty.backoffMs.every((n: unknown) => Number.isFinite(n) && Number(n) >= 0)
          ? raw.pty.backoffMs.map(Number)
          : [1000, 2000, 4000, 8000, 16000],
      namedAgentsAlwaysAlive: raw.pty?.namedAgentsAlwaysAlive !== false, // default true
      turnIdleTimeoutMs:
        Number.isFinite(raw.pty?.turnIdleTimeoutMs) && Number(raw.pty.turnIdleTimeoutMs) > 0
          ? Number(raw.pty.turnIdleTimeoutMs)
          : 5000,
      cols:
        Number.isFinite(raw.pty?.cols) && Number(raw.pty.cols) >= 40 ? Number(raw.pty.cols) : 100,
      rows:
        Number.isFinite(raw.pty?.rows) && Number(raw.pty.rows) >= 10 ? Number(raw.pty.rows) : 30,
      maxConcurrent:
        Number.isFinite(raw.pty?.maxConcurrent) && Number(raw.pty.maxConcurrent) > 0
          ? Number(raw.pty.maxConcurrent)
          : 32,
      quietWindowMs:
        Number.isFinite(raw.pty?.quietWindowMs) && Number(raw.pty.quietWindowMs) > 0
          ? Number(raw.pty.quietWindowMs)
          : 500,
      sentinelMaxWaitMs:
        Number.isFinite(raw.pty?.sentinelMaxWaitMs) && Number(raw.pty.sentinelMaxWaitMs) > 0
          ? Number(raw.pty.sentinelMaxWaitMs)
          : 30_000,
    },
    runtime: parseRuntimeMode(raw.runtime),
    agents: parseBusAgents(raw.agents),
    mcp: parseMcpConfig(raw.mcp, raw.web?.enabled),
    watchdog: parseWatchdogConfig(raw.watchdog),
    plugins: parsePlugins(raw.plugins),
    memorySearch: parseMemorySearchSettings(raw.memorySearch),
    session: {
      autoRotate: raw.session?.autoRotate ?? false,
      maxMessages: Number.isFinite(raw.session?.maxMessages) ? Number(raw.session.maxMessages) : 50,
      maxAgeHours: Number.isFinite(raw.session?.maxAgeHours) ? Number(raw.session.maxAgeHours) : 24,
      summaryPath:
        typeof raw.session?.summaryPath === "string" ? raw.session.summaryPath.trim() : "",
    },
    apiToken:
      typeof raw.apiToken === "string" && raw.apiToken.trim() ? raw.apiToken.trim() : undefined,
    ...(typeof raw.jobsDir === "string" && raw.jobsDir.trim()
      ? { jobsDir: raw.jobsDir.trim() }
      : {}),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const VALID_RUNTIMES: ReadonlySet<RuntimeMode> = new Set(["pty", "bus"]);

/**
 * Parse `settings.runtime`. Unknown / missing values fall back to the
 * v1-compatible `"pty"` default. Unknown values are logged so operators
 * notice typos (e.g. `runtime: "buss"`) rather than silently sliding back
 * to PTY.
 */
function parseRuntimeMode(raw: unknown): RuntimeMode {
  if (typeof raw !== "string" || raw.length === 0) return "pty";
  const trimmed = raw.trim() as RuntimeMode;
  if (VALID_RUNTIMES.has(trimmed)) return trimmed;
  console.warn(
    `[config] settings.runtime="${raw}" is not a valid mode (expected "pty" | "bus"); falling back to "pty"`,
  );
  return "pty";
}

/**
 * Allowed values for `BusAgentSettings.permission_mode`.
 *
 * Full-parity with the choices Claude Code accepts via `--permission-mode`
 * (verified against `claude --help` 2026-05-20: `acceptEdits`,
 * `bypassPermissions`, `default`, `dontAsk`, `plan`, `auto`). Earlier
 * versions of this parser only accepted the `default | plan |
 * bypassPermissions` trio, which made `commands/start.md` lie when it
 * documented `acceptEdits` as valid (Codex P2 on PR #145).
 */
const VALID_PERMISSION_MODES = new Set<
  "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto"
>(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"]);

/** Allowed values for `BusAgentSettings.supervision`. */
const VALID_SUPERVISION_MODES = new Set<BusSupervisionMode>([
  "pty-stdin",
  "tmux",
  "process",
  "process-stream-json",
]);

/**
 * Slug constraint for `BusAgentSettings.id`. Kebab-case alphanumeric +
 * `-` / `_`. We're stricter than the spec's "any string" because the
 * value lands in UDS socket paths (sun_path budget) and on-disk dirs
 * (`agents/<id>/...`). The 36-char cap protects the macOS sun_path budget
 * (spec §5.4 — final UDS path ≤96B, leaves ~36 chars after the typical
 * `/Users/<user>/.claudeclaw/run/bus-<id>.sock` prefix).
 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,35}$/;

/**
 * Parse `settings.agents`. Operator-facing surface — invalid entries log
 * a warning and are dropped rather than crashing the daemon. Sprint 5.2.
 *
 * Validation:
 *   - `id` required, matches `AGENT_ID_PATTERN`, unique across the list.
 *   - `permission_mode` must be one of the six values accepted by
 *     Claude Code's `--permission-mode` flag (else drop and let
 *     `resolveBusAgentConfig` apply the default of `"bypassPermissions"`,
 *     matching the documented headless contract).
 *   - `supervision` must be a known mode (else drop the field — internal
 *     `defaultSupervisionFor` picks one).
 *   - `cwd` / `system_prompt_file` / `memory_file` / `mcp_config` must be
 *     non-empty strings if present (else drop the field).
 */
function parseBusAgents(raw: unknown): BusAgentSettings[] {
  if (!Array.isArray(raw)) return [];
  const out: BusAgentSettings[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      console.warn(`[config] settings.agents[${i}] is not an object; skipping`);
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !AGENT_ID_PATTERN.test(id)) {
      console.warn(
        `[config] settings.agents[${i}].id=${JSON.stringify(id)} is invalid (expect [a-z0-9][a-z0-9_-]{0,35}); skipping`,
      );
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[config] settings.agents[${i}] duplicate id "${id}"; skipping`);
      continue;
    }
    seen.add(id);

    const e = entry as Record<string, unknown>;
    const parsed: BusAgentSettings = { id };
    if (typeof e.cwd === "string" && e.cwd.trim().length > 0) parsed.cwd = e.cwd.trim();
    if (typeof e.permission_mode === "string") {
      const pm = e.permission_mode.trim() as
        | "default"
        | "plan"
        | "acceptEdits"
        | "bypassPermissions"
        | "dontAsk"
        | "auto";
      if (VALID_PERMISSION_MODES.has(pm)) parsed.permission_mode = pm;
      // Codex P1 follow-up on PR #143: the warning previously said
      // "falling back to plan" but left `parsed.permission_mode`
      // unset, so the resolver's `?? "bypassPermissions"` default
      // would silently override — i.e. the warning lied. Now state
      // the actual fallback the resolver applies.
      else
        console.warn(
          `[config] settings.agents[${i}].permission_mode="${e.permission_mode}" invalid; falling back to "bypassPermissions" (resolver default)`,
        );
    }
    if (typeof e.supervision === "string") {
      const sv = e.supervision.trim() as BusSupervisionMode;
      if (VALID_SUPERVISION_MODES.has(sv)) parsed.supervision = sv;
      else
        console.warn(
          `[config] settings.agents[${i}].supervision="${e.supervision}" invalid; dropping (will use default)`,
        );
    }
    if (typeof e.system_prompt_file === "string" && e.system_prompt_file.trim().length > 0) {
      parsed.system_prompt_file = e.system_prompt_file.trim();
    }
    if (typeof e.memory_file === "string" && e.memory_file.trim().length > 0) {
      parsed.memory_file = e.memory_file.trim();
    }
    if (typeof e.mcp_config === "string" && e.mcp_config.trim().length > 0) {
      parsed.mcp_config = e.mcp_config.trim();
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Parse the `mcp` block from a raw settings object (SPEC §5).
 *
 * Validation rules — log warnings, never throw:
 *   1. Same name in both `shared` and `perPtyOnly` → drop from `shared`.
 *   2. `stateless` entries must be a subset of `shared` → drop strays.
 *   3. `settings.web.enabled === false` + non-empty `shared` → warn that the
 *      multiplexer can't activate; callers must check this combo at startup.
 *
 * Note: we deliberately can't validate that names appear in `mcp-proxy.json`
 * at parse time (that file lives on disk and is read by the multiplexer
 * plugin, not by parseSettings). The multiplexer's own startup path warns
 * when a shared name has no definition; see SPEC §5 rule 2.
 */
/**
 * Parse a `{ key → string }` mapping from a raw object. Drops entries
 * whose key or value isn't a non-empty string. Returns an empty
 * object on non-object input.
 */
function parseStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Parse `settings.telegram.busRouting`. Returns `null` when no usable
 * routing was found (no `chats` and no `defaultAgentId`) so the caller
 * can omit the field entirely rather than carry an empty object.
 */
function parseTelegramBusRouting(raw: unknown): TelegramBusRouting | null {
  if (!raw || typeof raw !== "object") return null;
  const chats = parseStringMap((raw as Record<string, unknown>).chats);
  const defaultAgentId = (raw as Record<string, unknown>).defaultAgentId;
  const hasDefault = typeof defaultAgentId === "string" && defaultAgentId.length > 0;
  if (Object.keys(chats).length === 0 && !hasDefault) return null;
  const out: TelegramBusRouting = { chats };
  if (hasDefault) out.defaultAgentId = (defaultAgentId as string).trim();
  return out;
}

/**
 * Parse `settings.discord.busRouting`. Same null-when-empty semantics
 * as `parseTelegramBusRouting`.
 */
function parseDiscordBusRouting(raw: unknown): DiscordBusRouting | null {
  if (!raw || typeof raw !== "object") return null;
  const channels = parseStringMap((raw as Record<string, unknown>).channels);
  const threads = parseStringMap((raw as Record<string, unknown>).threads);
  const dmAgentId = (raw as Record<string, unknown>).dmAgentId;
  const hasDm = typeof dmAgentId === "string" && dmAgentId.length > 0;
  if (Object.keys(channels).length === 0 && Object.keys(threads).length === 0 && !hasDm) {
    return null;
  }
  const out: DiscordBusRouting = { channels };
  if (Object.keys(threads).length > 0) out.threads = threads;
  if (hasDm) out.dmAgentId = (dmAgentId as string).trim();
  return out;
}

/**
 * Parse `settings.slack.busRouting`. Same null-when-empty semantics.
 */
function parseSlackBusRouting(raw: unknown): SlackBusRouting | null {
  if (!raw || typeof raw !== "object") return null;
  const channels = parseStringMap((raw as Record<string, unknown>).channels);
  const threadAgentId = (raw as Record<string, unknown>).threadAgentId;
  const signingSecret = (raw as Record<string, unknown>).signingSecret;
  const hasThread = typeof threadAgentId === "string" && threadAgentId.length > 0;
  const hasSigning = typeof signingSecret === "string" && signingSecret.length > 0;
  if (Object.keys(channels).length === 0 && !hasThread && !hasSigning) return null;
  const out: SlackBusRouting = { channels };
  if (hasThread) out.threadAgentId = (threadAgentId as string).trim();
  if (hasSigning) out.signingSecret = (signingSecret as string).trim();
  return out;
}

/**
 * Parse `settings.web.bus`. Same null-when-empty semantics — drop the
 * whole sub-object if nothing usable was set.
 */
function parseWebBusConfig(raw: unknown): WebBusConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bind = typeof r.bind === "string" && r.bind.length > 0 ? r.bind.trim() : null;
  const token = typeof r.token === "string" && r.token.length > 0 ? r.token.trim() : null;
  const allowedAgentIds = Array.isArray(r.allowedAgentIds)
    ? r.allowedAgentIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (!bind && !token && allowedAgentIds.length === 0) return null;
  const out: WebBusConfig = {};
  if (bind) out.bind = bind;
  if (token) out.token = token;
  if (allowedAgentIds.length > 0) out.allowedAgentIds = allowedAgentIds;
  return out;
}

function parseMcpConfig(raw: any, webEnabled: unknown): McpConfig {
  const asStringList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s.length > 0).map(String)
      : [];

  const rawShared = asStringList(raw?.shared);
  const rawPerPtyOnly = asStringList(raw?.perPtyOnly);
  const rawStateless = asStringList(raw?.stateless);

  // De-duplicate inside each list (silent — pure data hygiene).
  const shared = [...new Set(rawShared)];
  const perPtyOnly = [...new Set(rawPerPtyOnly)];
  const stateless = [...new Set(rawStateless)];

  // Rule 1: a name in both `shared` and `perPtyOnly` → `perPtyOnly` wins.
  const sharedSet = new Set(shared);
  for (const name of perPtyOnly) {
    if (sharedSet.has(name)) {
      console.warn(
        `[mcp] server '${name}' is in both 'shared' and 'perPtyOnly'; treating as 'perPtyOnly'`,
      );
      sharedSet.delete(name);
    }
  }
  const filteredShared = shared.filter((n) => sharedSet.has(n));

  // Rule 2: `stateless` must be a subset of `shared`.
  const filteredStateless: string[] = [];
  for (const name of stateless) {
    if (!sharedSet.has(name)) {
      console.warn(
        `[mcp] server '${name}' in settings.mcp.stateless must also be in settings.mcp.shared; ignoring 'stateless' marker`,
      );
      continue;
    }
    filteredStateless.push(name);
  }

  // Rule 3: gateway must be enabled for the multiplexer to mount HTTP routes.
  if (filteredShared.length > 0 && webEnabled === false) {
    console.warn(
      "[mcp] multiplexer requires the HTTP gateway (settings.web.enabled); shared MCPs will be skipped",
    );
  }

  // Rule 4: health-probe interval is a non-negative integer; clamp+default.
  const rawProbeMs = raw?.healthProbeIntervalMs;
  const healthProbeIntervalMs =
    typeof rawProbeMs === "number" && Number.isFinite(rawProbeMs) && rawProbeMs >= 0
      ? Math.floor(rawProbeMs)
      : 30000;

  // Rule 5: sessionPersistenceEnabled — strict boolean. Default true
  // (SPEC-DELTA-2026-05-16 always-resume). Anything other than an
  // explicit `false` keeps the default — protects against typos like
  // `"false"` (string) silently disabling persistence.
  const sessionPersistenceEnabled = raw?.sessionPersistenceEnabled === false ? false : true;

  // Rule 6: sessionMaxAgeSeconds — positive integer, clamp to 60. Anything
  // sub-minute is operator error (TTL eviction would fire faster than a
  // typical tool invocation cycle).
  const rawMaxAge = raw?.sessionMaxAgeSeconds;
  let sessionMaxAgeSeconds = 3600;
  if (typeof rawMaxAge === "number" && Number.isFinite(rawMaxAge) && rawMaxAge > 0) {
    sessionMaxAgeSeconds = Math.max(60, Math.floor(rawMaxAge));
    if (Math.floor(rawMaxAge) < 60) {
      console.warn(
        `[mcp] sessionMaxAgeSeconds=${Math.floor(rawMaxAge)} is below the 60s minimum; clamping to 60`,
      );
    }
  }

  // Rule 7: sessionPersistencePath — empty default ("compute at start").
  // If supplied, must be absolute; otherwise warn and revert to empty.
  let sessionPersistencePath = "";
  if (typeof raw?.sessionPersistencePath === "string" && raw.sessionPersistencePath.length > 0) {
    if (
      raw.sessionPersistencePath.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(raw.sessionPersistencePath)
    ) {
      sessionPersistencePath = raw.sessionPersistencePath;
    } else {
      console.warn(
        `[mcp] sessionPersistencePath '${raw.sessionPersistencePath}' is not absolute; ignoring and using default`,
      );
    }
  }

  // Rule 8: per-bearer rate limit (#72 item 1). Sensible defaults; allow
  // operators to tune via settings.mcp.rateLimit. `maxRequestsPerWindow: 0`
  // (or any non-positive integer) disables the cap entirely.
  const DEFAULT_RATE_MAX = 600;
  const DEFAULT_RATE_WINDOW_MS = 60_000;
  const rawRateMax = raw?.rateLimit?.maxRequestsPerWindow;
  const rawRateWin = raw?.rateLimit?.windowMs;
  let rateMaxRequestsPerWindow = DEFAULT_RATE_MAX;
  if (typeof rawRateMax === "number" && Number.isFinite(rawRateMax)) {
    rateMaxRequestsPerWindow = Math.max(0, Math.floor(rawRateMax));
  }
  let rateWindowMs = DEFAULT_RATE_WINDOW_MS;
  if (typeof rawRateWin === "number" && Number.isFinite(rawRateWin) && rawRateWin > 0) {
    // Floor at 100ms so accidentally tiny windows can't pin the CPU.
    rateWindowMs = Math.max(100, Math.floor(rawRateWin));
  }

  // Issue #68: cost-tracking metrics. Default off — operator opts in.
  const metricsEnabled = raw?.metricsEnabled === true;

  return {
    shared: filteredShared,
    perPtyOnly,
    stateless: filteredStateless,
    healthProbeIntervalMs,
    sessionPersistenceEnabled,
    sessionMaxAgeSeconds,
    sessionPersistencePath,
    rateLimit: {
      maxRequestsPerWindow: rateMaxRequestsPerWindow,
      windowMs: rateWindowMs,
    },
    metricsEnabled,
  };
}

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort(
      (a: number, b: number) => a - b,
    );

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = rawText.match(/"discord"\s*:\s*\{[\s\S]*?\}/);
  if (!discordBlock) return [];
  const arrayMatch = discordBlock[0].match(/"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
