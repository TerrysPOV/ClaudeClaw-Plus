import { join, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { parseWatchdogConfig, type WatchdogConfig } from "./watchdog";
import {
  DEFAULT_STALL_CONFIG,
  parseStallWatchdogConfig,
  type StallWatchdogConfig,
} from "./bus/stall-watchdog";
import {
  DEFAULT_AGENT_JOB_CONFIG,
  parseAgentJobConfig,
  type AgentJobConfig,
} from "./bus/agent-jobs";
import { parsePlugins, type PluginEntry } from "./plugins";
import { parseMemorySearchSettings, type MemorySearchSettings } from "./memory";
import { parseOneShotSettings, type OneShotSettings } from "./oneshot/config.js";
import type { AuditPolicy } from "./observability/tool-call";

/** Re-exported under the name used in the Settings interface. */
export type WatchdogSettings = WatchdogConfig;

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const DEFAULT_SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
// Mutable only so tests can redirect it via _setSettingsFileForTests(); the
// daemon never reassigns it. Frozen at module load to the start-up cwd.
let SETTINGS_FILE = DEFAULT_SETTINGS_FILE;
const DEFAULT_JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

/**
 * Default Claude session timeout (120 minutes).
 *
 * Bumped from 30 minutes (issue #179): named agents like Reg and Suzy run
 * long pipelines by design — daily-content-research does 8–15 web searches,
 * NotebookLM source loading + 6 insight queries, an SEO-optimised content
 * suite across 7 surfaces, fact-check pass, image generation, and Discord
 * notification. The legacy 30-minute cap fired mid-pipeline. Operators with
 * shorter workloads can override via `sessionTimeoutMs` in the project-local
 * settings file the daemon reads — `<cwd>/.claude/claudeclaw/settings.json`,
 * i.e. relative to the directory the daemon was started in. The `~/.claude/`
 * path is the Claude CLI's user-scope config, not where this daemon reads.
 *
 * Exported so runner.ts can reference the same value.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 120 * 60 * 1000;

export const DEFAULT_IMAGE_OUTPUT_ROOT = join(HEARTBEAT_DIR, "outbox", "discord");

/**
 * Claude Code's native scheduling tools, blocked on every claude process the
 * daemon spawns — both the interactive bus PTY session (`buildClaudeArgs`) and
 * every other claude spawn (`buildSecurityArgs`, e.g. the `dispatch_job`
 * subagent runner, whether it runs on PTY or as `claude -p`).
 *
 * Their wakeups are tied to the specific session that registered them. Under
 * the bus runtime a session rotates/churns independently of the daemon, and a
 * headless dispatch is a one-shot process that exits immediately — so a
 * wakeup scheduled through these tools silently never fires (issue #342, the
 * lost "call the GP for Ginna at 8am" reminder). ClaudeClaw+'s own file-backed
 * scheduler (`schedule_task`) is durable across those boundaries and is the
 * only correct path, so the native tools are removed rather than left as a
 * tempting wrong door. Hardcoded, not operator-configurable: they're broken by
 * architecture here, not a security preference.
 */
export const NATIVE_SCHEDULING_TOOLS_BLOCKLIST = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
] as const;

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
  oneShot: parseOneShotSettings(undefined),
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
  attachments: {
    enabled: true,
    maxBytes: 25 * 1024 * 1024,
    maxInlineTextBytes: 64 * 1024,
    maxAttachmentsPerMessage: 10,
    maxTranscribeBytes: 8 * 1024 * 1024,
    rootDir: "",
    transcribeVoice: true,
    retentionHours: 24,
  },
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  timeouts: { telegram: 5, discord: 5, heartbeat: 15, job: 30, default: 5 },
  // #315: on SIGTERM, wait this long for active agent turns to finish before
  // stopping (0 = stop at once, the pre-#315 behaviour). Keep it below your
  // service manager's stop timeout (systemd TimeoutStopSec defaults to 90s).
  shutdown: { drainTurnsMs: 30_000 },
  pty: {
    // Official engine for agent turns and cron jobs (#550). The MCP multiplexer
    // has shipped but is opt-in and dormant by default (it needs `mcp.shared`, an
    // `mcp-proxy.json` and `web.enabled`); without it each PTY spawns its own MCP
    // servers, and startup warns. OAuth refresh through it is NOT shipped code: the
    // operator validates it in the pre-release soak. false keeps print. Windows is the
    // exception: no evidence the PTY path works there, so win32 defaults to print
    // and `pty.enabled: true` opts in (see `defaultPtyEnabled`).
    enabled: defaultPtyEnabled(),
    idleReapMinutes: 30,
    maxRetries: 5,
    respawnRetries: 3,
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
    // Issue #69: response caching for idempotent tools. Default OFF;
    // operators enumerate cacheable (server, tool) pairs explicitly.
    cache: {
      enabled: false,
      ttlMs: 5_000,
      maxEntries: 1_000,
      cacheable: {},
      defensiveInvalidation: true,
    },
  },
  watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
  // Clone so a future in-place edit of settings.stallWatchdog can't mutate the
  // shared exported default.
  stallWatchdog: structuredClone(DEFAULT_STALL_CONFIG),
  agentJobs: structuredClone(DEFAULT_AGENT_JOB_CONFIG),
  quietHours: { windows: [], urgentBypass: false },
  governance: { watchdog: {} },
  session: {
    autoRotate: false,
    maxMessages: 50,
    maxAgeHours: 24,
    summaryPath: "",
    gatewayScope: "global",
  },
  // Default runtime: `bus` (Sprint 5.4 flip after Hetzner staging soak ended
  // 2026-05-25). `runtime: "pty"` remains as a permanent first-class option
  // for operators who want the legacy per-event runner. It runs on the PTY
  // supervisor by default (a long-lived PTY per session key, reused across
  // turns); with `pty.enabled: false` (or on win32) it is the
  // `claude -p` / API-billed path — particularly for enterprise deployments
  // where audit, cost-ceiling, or regulatory constraints make API billing the
  // safer or only viable route.
  runtime: "bus",
  // One default agent so a fresh install actually mounts something. The
  // runtime default is `bus`, which spawns one `claude` per `agents[]` entry;
  // an empty default would mount the bus with zero agents — daemon up,
  // channels polling, but nothing behind them ("no agents declared"). Written
  // by `initConfig` for a fresh install (#196 / cause #1 of #193), and used by
  // `parseSettings` when an existing file omits `agents` — the shape of every
  // config carried over from the original claudeclaw (#508). An explicit
  // `agents: []` is still honoured as "no agent".
  agents: [{ id: "default" }],
  plugins: {},
  memorySearch: {},
  // LLM router (#70). Tiers ship EMPTY — no opinionated model defaults; the
  // operator searches the OpenRouter catalogue (llm_models tool) and assigns
  // ids, or passes a per-call model. Only consulted by the llm-router MCP
  // plugin when registered as a shared server. The secret OPENROUTER_API_KEY
  // is env-only and never stored here.
  llmRouter: {
    tiers: { fast: [], balanced: [], reasoning: [] },
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
  },
  // eval-framework (#80) lives under `governance.evalFramework` (see
  // GovernanceConfig) — its field defaults come from the plugin's own zod
  // schema (src/plugins/eval-framework/types.ts), so nothing to seed here.
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

/**
 * Quiet hours for proactive messages (#512): job results, heartbeat, trigger
 * output, the usage-limit notice and operator alerts produced inside a window
 * are held and delivered when it ends. Replies to a message the user sent are
 * never held. Same window shape and semantics as `heartbeat.excludeWindows`.
 * Empty `windows` (the default) = off.
 */
export interface QuietHoursConfig {
  windows: HeartbeatExcludeWindow[];
  /** A `critical` operator alert goes out anyway. Off: it waits like the rest. */
  urgentBypass: boolean;
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
  /**
   * `agent_id → channel_id`. When a non-channel-driven origin
   * ("cron" / "heartbeat" / "cli" / "rest" / no origin) fires for an agent
   * that appears here, the event is delivered ONLY to this channel rather
   * than fanning out to every channel routed to the agent. Opt-in: agents
   * with no entry keep the legacy fan-out behaviour.
   */
  primaryChannelByAgent?: Record<string, string>;
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
  /**
   * `agent_id → channel_id`. Same semantics as `DiscordBusRouting`.
   * When a non-channel-driven origin fires for an agent that appears here,
   * deliver only to this channel instead of fanning out across every
   * routed channel. Opt-in.
   */
  primaryChannelByAgent?: Record<string, string>;
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
  /** Browser origins allowed to call the Web UI adapter cross-origin. */
  allowedOrigins?: string[];
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  /** Accept every Telegram user. Without it an empty `allowedUserIds` refuses everyone. */
  allowAllUsers?: boolean;
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
  /** Accept every Discord user. Without it an empty `allowedUserIds` refuses everyone. */
  allowAllUsers?: boolean;
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
  /** Accept every Slack user. Without it an empty `allowedUserIds` refuses everyone. */
  allowAllUsers?: boolean;
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
   * needed an operator-visible signal before `pty.enabled` could default to true
   * (#550; on win32 it defaults to false, see `defaultPtyEnabled`).
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
  /**
   * Response caching for idempotent multiplexer tools (issue #69).
   * Opt-in per `(server, tool)` pair — no tool is cacheable by
   * default. Cache lives in-process, bounded by `maxEntries`, with a
   * short `ttlMs` expiry. A non-cacheable call against a server with
   * cacheable tools triggers defensive invalidation of every cached
   * entry for that server. Cache stats are exposed in the
   * multiplexer's `health()` snapshot.
   */
  cache: {
    /** Master switch. Default false. */
    enabled: boolean;
    /** TTL in milliseconds. Default 5000. */
    ttlMs: number;
    /** Max entries across all cache keys. Default 1000. */
    maxEntries: number;
    /** Per-server allowlist of cacheable tool names.
     *  Example: `{ "retrieval-mcp": ["get_record", "list_records"] }`. */
    cacheable: Record<string, string[]>;
    /** Defensive invalidation on every non-cacheable call against a
     *  server with cacheable tools. Default true. Operators with
     *  cleanly partitioned tools (mixed-tool servers where the
     *  non-cacheable tools are read-only) can flip false to avoid
     *  thrashing the cache. 5-agent review on PR #69 Agent 3 finding. */
    defensiveInvalidation: boolean;
  };
  /**
   * Per-plugin kill switch on the plugin-tool bridge (#230), with the words
   * the multiplexer uses for its servers in `mcp-proxy.json`. Absent or empty
   * → every registered tool stays callable (the behaviour before this block).
   * Re-read by the settings hot-reload, so a tool can be switched off without
   * unregistering its plugin or restarting.
   *
   * Scope: calls that go through the daemon's bridge (`invokeTool`: plugin
   * HTTP gateway, in-process callers); `listTools` hides what it refuses. A
   * shared server's `/mcp/<server>` route is governed by its `mcp-proxy.json`
   * entry.
   */
  bridge?: McpBridgeConfig;
  /**
   * Mandatory-audit policy for MCP tool calls, on both dispatch paths (the
   * multiplexer and the plugin-tool bridge). `"enforce"`: a call whose intent
   * cannot be appended to the `mcp.tool_call` chain is refused before it
   * runs — no log, no action. `"best-effort"` (default): logging never blocks
   * a call. Re-read by the settings hot-reload.
   */
  audit?: AuditPolicy;
}

/**
 * One entry in `settings.mcp.bridge.plugins`, keyed by plugin id — or, for a
 * tool the mcp-proxy plugin or the multiplexer proxies from another MCP
 * server, by that server's name (plugin ids and server names share this one
 * namespace). Tool names are matched exactly against the name under that
 * key: `{ "github": { "deniedTools": ["delete_repo"] } }` fences the proxied
 * tool whichever wrapper carries it; `{ "mcp-proxy": { "deniedTools":
 * ["github__delete_repo"] } }` fences it only as registered by mcp-proxy
 * (the multiplexer registers as `mcp-multiplexer`). When both keys have an
 * entry, either can refuse.
 */
export interface McpBridgePluginConfig {
  /** `false` → every tool under this key is refused and hidden. Default true. */
  enabled?: boolean;
  /** When set, only these tools are callable. `[]` allows none. */
  allowedTools?: string[];
  /** Never callable, even when also listed in `allowedTools`. */
  deniedTools?: string[];
}

export interface McpBridgeConfig {
  plugins: Record<string, McpBridgePluginConfig>;
  /**
   * `true` → on the bridge, a tool is callable only if its plugin id or (for
   * a proxied tool) its upstream server has an entry in `plugins`; anything
   * else is refused and hidden, built-in plugins that register on the bridge
   * included. An entry allows whatever carries that name: list servers rather
   * than the `mcp-proxy` / `mcp-multiplexer` wrappers, whose entry counts for
   * every server they proxy. Default false: unlisted plugins stay callable.
   * Like the rest of this block it governs the bridge only, not a shared
   * server's `/mcp/<server>` route (see `mcp-proxy.json`).
   */
  defaultDeny?: boolean;
}

/** #315: graceful drain on shutdown. */
export interface ShutdownConfig {
  /** Max time to wait for in-flight agent turns on SIGTERM/SIGINT; 0 disables. */
  drainTurnsMs: number;
}

export interface PtyConfig {
  /** Master switch for runner turns. Defaults to true (#550), except on win32 where
   *  it defaults to false (`defaultPtyEnabled`); an explicit boolean always wins.
   *  An explicit false selects the `claude -p` path for every callsite.
   *  See README "Execution Modes and Engine Policy" and docs/pty-migration.md. */
  enabled: boolean;
  /** Ad-hoc thread PTYs are disposed after this many minutes of inactivity.
   *  Named agents are NEVER reaped when namedAgentsAlwaysAlive is true.
   *  Default: 30. */
  idleReapMinutes: number;
  /** Maximum number of crash-respawn-replay attempts per event.
   *  Default: 5. */
  maxRetries: number;
  /** Maximum number of `respawnEntry()` attempts after each retryable
   *  `runTurn` failure. The outer `maxRetries` budget controls how many
   *  turn replays we attempt; this inner budget controls how many times
   *  we try to bring the PTY back up between turns. Before this was
   *  introduced (issue #175), a single failed respawn would truncate the
   *  outer envelope to one attempt, causing production cron jobs to give
   *  up after one bad respawn. Default: 3. */
  respawnRetries: number;
  /** Backoff between retries (ms). Cycles through this list; if maxRetries
   *  exceeds the list length, the last value is reused. The same array is
   *  reused for inner respawn retries.
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
   * How long the TUI's output must be quiet, after the session transcript shows the
   * reply complete, before the next prompt may be sent (#562 round 2). It is a
   * readiness delay only: it can postpone the end of a turn (by at most 2 s), never
   * decide it. Default: 500.
   */
  quietWindowMs: number;
  /**
   * Unused since #562 round 2: there is no sentinel any more, and a turn ends only when
   * the session transcript shows the reply complete. Kept so existing settings files
   * and callers still parse. Default: 30000.
   */
  sentinelMaxWaitMs: number;
}

/**
 * Daemon runtime selector. `pty` is the legacy stack (PTY supervisor, with
 * `claude -p` only when `pty.enabled` is false or on win32); it was the v1
 * default, but the default is now `bus`. `bus` mounts
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
  oneShot: OneShotSettings;
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
  attachments: AttachmentsConfig;
  apiToken?: string;
  sessionTimeoutMs: number;
  timeouts: TimeoutsConfig;
  /** #315: bounded wait for active turns before the daemon stops. */
  shutdown: ShutdownConfig;
  /**
   * Daemon runtime selector. Defaults to `"bus"` (event-bus + per-agent
   * processes, multi-channel routing, MCP multiplexer) — subscription-billed
   * interactive mode. `"pty"` selects the legacy per-event runner: the
   * PTY supervisor by default (a long-lived PTY per session key, reused
   * across turns until retired or idle-reaped), or one `claude -p`
   * subprocess per call when `pty.enabled` is false (or on win32) — API-billed (Agent SDK pool
   * post-2026-06-15). Kept as a permanent first-class option for enterprise
   * deployments where API billing is the safer or only viable route (audit
   * trails, predictable cost ceilings, regulatory constraints).
   */
  runtime: RuntimeMode;
  /**
   * Bus runtime agent declarations. Only consulted when `runtime: "bus"`;
   * `runtime: "pty"` ignores this field entirely. Empty list = the daemon
   * mounts the Bus stack but spawns no agents (operator wires them via
   * REST/CLI later). A fresh install ships one `{ id: "default" }` entry
   * (see `DEFAULT_SETTINGS`), and a file with no `agents` key parses to the
   * same entry (#508), so the bus mounts a working agent out of the box;
   * setting the list to `[]` is a deliberate "wire later" opt-out.
   * See `BusAgentSettings` for the per-agent shape.
   */
  agents: BusAgentSettings[];
  pty: PtyConfig;
  mcp: McpConfig;
  watchdog: WatchdogSettings;
  stallWatchdog: StallWatchdogConfig;
  /** Agent-job primitive config (#296 PR 3): concurrency cap + per-job timeouts. */
  agentJobs: AgentJobConfig;
  /** Quiet hours for proactive Telegram messages (#512). Off (no windows) by default. */
  quietHours: QuietHoursConfig;
  governance: GovernanceConfig;
  plugins: Record<string, PluginEntry>;
  session: SessionConfig;
  memorySearch: MemorySearchSettings;
  llmRouter: LlmRouterConfig;
  jobsDir?: string;
  /**
   * Live Kanban board of subagent activity (#294). Optional; when absent the
   * tracker defaults ON. Set `{ enabled: false }` to disable the bus-driven
   * board feed (the manual `/api/kanban` "+ Add task" path is unaffected).
   */
  kanban?: KanbanSettings;
}

export interface KanbanSettings {
  enabled: boolean;
}

/**
 * LLM router config (#70). Non-secret only — `OPENROUTER_API_KEY` is read from
 * the environment by the llm-router plugin, never stored here. `tiers` maps each
 * cost tier to an ordered list of OpenRouter model ids (fallback order). Empty
 * by default: the operator chooses models via the `llm_models` search tool or a
 * per-call `model`.
 */
export interface LlmRouterConfig {
  tiers: { fast: string[]; balanced: string[]; reasoning: string[] };
  /** OpenRouter API base. Default https://openrouter.ai/api/v1. */
  openRouterBaseUrl: string;
  /** Optional local Ollama OpenAI-compatible base (e.g. http://127.0.0.1:11434/v1). */
  ollamaBaseUrl?: string;
}

/**
 * Operator-facing config for the governance watchdog (`src/governance/watchdog.ts`).
 *
 * The fields here mirror the runtime `WatchdogConfig` but are kept narrow so
 * settings.json doesn't have to deal with the internal in-memory shape. Unset
 * fields fall back to the hardcoded runtime defaults.
 */
export interface GovernanceWatchdogConfig {
  enabled?: boolean;
  maxToolCalls?: number;
  maxTurns?: number;
  maxRuntimeSeconds?: number;
  maxRepeatedTools?: number;
  repeatedToolThreshold?: number;
}

export interface GovernanceConfig {
  watchdog: GovernanceWatchdogConfig;
  // eval-framework (#80). All fields optional: the plugin's zod schema
  // (EvalFrameworkSettingsSchema) fills defaults at construction, so an
  // operator only writes the keys they change (plus enabled=true to opt in).
  evalFramework?: {
    enabled?: boolean;
    evals_root?: string;
    database_path?: string;
    reports_dir?: string;
    default_max_cost_usd?: number;
    default_judge_model?: string;
    provider_credentials_env?: Record<string, string>;
    budget_guard_scope?: string;
  };
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

export interface AttachmentsConfig {
  /** Master switch for the inbound attachment pipeline. Default: true. */
  enabled: boolean;
  /** Skip attachments larger than this many bytes. Default: 25 MiB. */
  maxBytes: number;
  /** Inlined text content is truncated to this many bytes. Default: 64 KiB. */
  maxInlineTextBytes: number;
  /** Base directory downloaded attachments are written under; per agent/message
   *  subdirs are created beneath it. Empty → `<cwd>/.claudeclaw/inbound-attachments`. */
  rootDir: string;
  /** Transcribe voice/audio attachments via the STT pipeline. Default: true. */
  transcribeVoice: boolean;
  /** Max attachments processed per message; the rest are noted. Default: 10. */
  maxAttachmentsPerMessage: number;
  /** Don't transcribe audio larger than this many bytes. Default: 8 MiB. */
  maxTranscribeBytes: number;
  /** Delete saved attachment dirs older than this many hours (TTL cleanup).
   *  Default: 24. Set 0 to disable cleanup. */
  retentionHours: number;
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
  /**
   * #376: which Claude session a gateway turn (Discord / Telegram through the
   * event log) resumes. `"global"` (default, the behaviour so far): every
   * gateway conversation shares the one global session, so what was said in
   * one channel is context for the answer in another. `"conversation"`: each
   * channel / thread / chat / topic gets its own session (keyed
   * `channelId:threadId`, the gateway's own conversation identity), handled
   * like a Discord thread session: its own queue (conversations run in
   * parallel), no auto-rotation — `/reset` and `/compact` act on it. Splitting
   * one context into many costs more tokens and the assistant stops
   * remembering across channels — hence opt-in.
   */
  gatewayScope: "global" | "conversation";
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(getJobsDir(), { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
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

/**
 * #550 made the PTY supervisor the default engine for runner turns. Nothing in this
 * codebase shows that path working on win32: `claude` resolves to a `.cmd` wrapper
 * there (runner.ts `CLAUDE_EXECUTABLE`) and the spec (§5.3) names `process` as the
 * Windows fallback. So win32 keeps print by default and `pty.enabled: true` opts in,
 * mirroring `defaultSupervisionFor` in `src/bus/types.ts`. `platform` is a parameter
 * so the choice is testable on any host.
 *
 * Scope: `pty.enabled` governs `runner.ts` turns only. Declared bus agents are not
 * affected: `resolveBusAgentConfig` defaults them to `pty-stdin` on every platform, win32
 * included.
 */
export function defaultPtyEnabled(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

const invalidPtyEnabledWarned = new Set<string>();
/** An explicit boolean wins; anything else gets the platform default (non-booleans warn once). */
export function resolvePtyEnabled(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof value === "boolean") return value;
  const fallback = defaultPtyEnabled(platform);
  if (value !== undefined) {
    const key = `${platform}:${JSON.stringify(value)}`;
    if (!invalidPtyEnabledWarned.has(key)) {
      invalidPtyEnabledWarned.add(key);
      console.warn(`pty.enabled must be a boolean; using the platform default (${fallback})`);
    }
  }
  return fallback;
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
    oneShot: parseOneShotSettings(raw.oneShot),
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
      allowedUserIds: parseTelegramUserIds(raw.telegram?.allowedUserIds),
      ...(raw.telegram?.allowAllUsers === true ? { allowAllUsers: true } : {}),
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
      allowedUserIds: parseChatUserIds("discord", raw.discord?.allowedUserIds, discordUserIds),
      ...(raw.discord?.allowAllUsers === true ? { allowAllUsers: true } : {}),
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
      allowedUserIds: parseChatUserIds("slack", raw.slack?.allowedUserIds),
      ...(raw.slack?.allowAllUsers === true ? { allowAllUsers: true } : {}),
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
    attachments: {
      enabled: raw.attachments?.enabled !== false,
      maxBytes:
        Number.isFinite(raw.attachments?.maxBytes) && Number(raw.attachments.maxBytes) > 0
          ? Number(raw.attachments.maxBytes)
          : 25 * 1024 * 1024,
      maxInlineTextBytes:
        Number.isFinite(raw.attachments?.maxInlineTextBytes) &&
        Number(raw.attachments.maxInlineTextBytes) > 0
          ? Number(raw.attachments.maxInlineTextBytes)
          : 64 * 1024,
      maxAttachmentsPerMessage:
        Number.isFinite(raw.attachments?.maxAttachmentsPerMessage) &&
        Number(raw.attachments.maxAttachmentsPerMessage) > 0
          ? Number(raw.attachments.maxAttachmentsPerMessage)
          : 10,
      maxTranscribeBytes:
        Number.isFinite(raw.attachments?.maxTranscribeBytes) &&
        Number(raw.attachments.maxTranscribeBytes) > 0
          ? Number(raw.attachments.maxTranscribeBytes)
          : 8 * 1024 * 1024,
      rootDir: typeof raw.attachments?.rootDir === "string" ? raw.attachments.rootDir.trim() : "",
      transcribeVoice: raw.attachments?.transcribeVoice !== false,
      retentionHours:
        Number.isFinite(raw.attachments?.retentionHours) &&
        Number(raw.attachments.retentionHours) >= 0
          ? Number(raw.attachments.retentionHours)
          : 24,
    },
    sessionTimeoutMs:
      Number.isFinite(raw.sessionTimeoutMs) && (raw.sessionTimeoutMs as number) > 0
        ? (raw.sessionTimeoutMs as number)
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
    shutdown: {
      drainTurnsMs:
        Number.isFinite(raw.shutdown?.drainTurnsMs) && Number(raw.shutdown.drainTurnsMs) >= 0
          ? Number(raw.shutdown.drainTurnsMs)
          : 30_000,
    },
    pty: {
      enabled: resolvePtyEnabled(raw.pty?.enabled), // explicit boolean wins; else platform default (#550)
      idleReapMinutes:
        Number.isFinite(raw.pty?.idleReapMinutes) && Number(raw.pty.idleReapMinutes) > 0
          ? Number(raw.pty.idleReapMinutes)
          : 30,
      maxRetries:
        Number.isFinite(raw.pty?.maxRetries) && Number(raw.pty.maxRetries) >= 0
          ? Number(raw.pty.maxRetries)
          : 5,
      respawnRetries:
        Number.isFinite(raw.pty?.respawnRetries) && Number(raw.pty.respawnRetries) >= 1
          ? // Cap at 20 to prevent footgun config (security review on #175):
            // every inner attempt sleeps the backoff schedule (max 16s after
            // the array runs out), so an operator who sets a huge value can
            // wedge a cron turn for hours waiting on hopeless respawns.
            Math.min(20, Number(raw.pty.respawnRetries))
          : 3,
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
    // #508: absent key → the fresh-install default; `[]` stays empty.
    agents:
      raw.agents === undefined
        ? structuredClone(DEFAULT_SETTINGS.agents)
        : parseBusAgents(raw.agents),
    mcp: parseMcpConfig(raw.mcp, raw.web?.enabled),
    watchdog: parseWatchdogConfig(raw.watchdog),
    stallWatchdog: parseStallWatchdogConfig(raw.stallWatchdog),
    agentJobs: parseAgentJobConfig(raw.agentJobs),
    quietHours: parseQuietHours(raw.quietHours),
    governance: parseGovernanceConfig(raw.governance),
    plugins: parsePlugins(raw.plugins),
    memorySearch: parseMemorySearchSettings(raw.memorySearch),
    llmRouter: parseLlmRouterConfig(raw.llmRouter),
    session: {
      autoRotate: raw.session?.autoRotate ?? false,
      maxMessages: Number.isFinite(raw.session?.maxMessages) ? Number(raw.session.maxMessages) : 50,
      maxAgeHours: Number.isFinite(raw.session?.maxAgeHours) ? Number(raw.session.maxAgeHours) : 24,
      summaryPath:
        typeof raw.session?.summaryPath === "string" ? raw.session.summaryPath.trim() : "",
      // Anything but the exact opt-in word keeps the shared session (#376).
      gatewayScope: raw.session?.gatewayScope === "conversation" ? "conversation" : "global",
    },
    apiToken:
      typeof raw.apiToken === "string" && raw.apiToken.trim() ? raw.apiToken.trim() : undefined,
    ...(typeof raw.jobsDir === "string" && raw.jobsDir.trim()
      ? { jobsDir: raw.jobsDir.trim() }
      : {}),
    // #294: live Kanban board of subagent activity. Present-but-not-false ⇒
    // enabled; absent block leaves `kanban` undefined (tracker treats as ON).
    ...(raw.kanban && typeof raw.kanban === "object"
      ? { kanban: { enabled: (raw.kanban as { enabled?: unknown }).enabled !== false } }
      : {}),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const VALID_RUNTIMES: ReadonlySet<RuntimeMode> = new Set(["pty", "bus"]);

/**
 * Parse `settings.runtime`. Unknown / missing values fall back to the
 * default `"bus"` (event-bus runtime, the v2.0 architecture). Operators
 * who haven't migrated from v1 can explicitly set `runtime: "pty"`.
 * Unknown values are logged so typos (e.g. `runtime: "buss"`) surface
 * rather than silently selecting bus.
 */
function parseRuntimeMode(raw: unknown): RuntimeMode {
  if (typeof raw !== "string" || raw.length === 0) return "bus";
  const trimmed = raw.trim() as RuntimeMode;
  if (VALID_RUNTIMES.has(trimmed)) return trimmed;
  console.warn(
    `[config] settings.runtime="${raw}" is not a valid mode (expected "pty" | "bus"); falling back to "bus"`,
  );
  return "bus";
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
 * Parse the `settings.governance` block: `watchdog` (narrow, optional fields
 * falling back to runtime defaults in `src/governance/watchdog.ts`) and
 * `evalFramework` (#80 — carried through as-is when present; the plugin's
 * zod schema validates and fills defaults at construction).
 */
export function parseGovernanceConfig(raw: unknown): GovernanceConfig {
  const out: GovernanceConfig = { watchdog: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  const numIfFinitePositive = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

  const w = r.watchdog;
  if (w && typeof w === "object") {
    const wr = w as Record<string, unknown>;
    out.watchdog = {
      enabled: typeof wr.enabled === "boolean" ? wr.enabled : undefined,
      maxToolCalls: numIfFinitePositive(wr.maxToolCalls),
      maxTurns: numIfFinitePositive(wr.maxTurns),
      maxRuntimeSeconds: numIfFinitePositive(wr.maxRuntimeSeconds),
      maxRepeatedTools: numIfFinitePositive(wr.maxRepeatedTools),
      repeatedToolThreshold: numIfFinitePositive(wr.repeatedToolThreshold),
    };
  }

  const ef = r.evalFramework;
  if (ef && typeof ef === "object") {
    out.evalFramework = ef as GovernanceConfig["evalFramework"];
  }

  return out;
}

/**
 * Parse `settings.llmRouter` (#70). Non-secret config only. Tier model lists
 * default to empty (operator chooses via the llm_models tool); invalid entries
 * are dropped with a warning rather than throwing. `OPENROUTER_API_KEY` is never
 * read here — it's an env-only secret consumed by the llm-router plugin.
 */
function parseLlmRouterConfig(raw: unknown): LlmRouterConfig {
  const defaults = DEFAULT_SETTINGS.llmRouter;
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Record<string, unknown>;

  const parseTier = (key: "fast" | "balanced" | "reasoning"): string[] => {
    const tiers = r.tiers as Record<string, unknown> | undefined;
    const list = tiers?.[key];
    if (!Array.isArray(list)) return [];
    return list
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .map((m) => m.trim());
  };

  const baseUrl =
    typeof r.openRouterBaseUrl === "string" && r.openRouterBaseUrl.trim().length > 0
      ? r.openRouterBaseUrl.trim()
      : defaults.openRouterBaseUrl;

  return {
    tiers: {
      fast: parseTier("fast"),
      balanced: parseTier("balanced"),
      reasoning: parseTier("reasoning"),
    },
    openRouterBaseUrl: baseUrl,
    ...(typeof r.ollamaBaseUrl === "string" && r.ollamaBaseUrl.trim().length > 0
      ? { ollamaBaseUrl: r.ollamaBaseUrl.trim() }
      : {}),
  };
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
  const primaryChannelByAgent = parseStringMap(
    (raw as Record<string, unknown>).primaryChannelByAgent,
  );
  const hasDm = typeof dmAgentId === "string" && dmAgentId.length > 0;
  const hasPrimary = Object.keys(primaryChannelByAgent).length > 0;
  if (
    Object.keys(channels).length === 0 &&
    Object.keys(threads).length === 0 &&
    !hasDm &&
    !hasPrimary
  ) {
    return null;
  }
  const out: DiscordBusRouting = { channels };
  if (Object.keys(threads).length > 0) out.threads = threads;
  if (hasDm) out.dmAgentId = (dmAgentId as string).trim();
  if (hasPrimary) out.primaryChannelByAgent = primaryChannelByAgent;
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
  const primaryChannelByAgent = parseStringMap(
    (raw as Record<string, unknown>).primaryChannelByAgent,
  );
  const hasThread = typeof threadAgentId === "string" && threadAgentId.length > 0;
  const hasSigning = typeof signingSecret === "string" && signingSecret.length > 0;
  const hasPrimary = Object.keys(primaryChannelByAgent).length > 0;
  if (Object.keys(channels).length === 0 && !hasThread && !hasSigning && !hasPrimary) return null;
  const out: SlackBusRouting = { channels };
  if (hasThread) out.threadAgentId = (threadAgentId as string).trim();
  if (hasSigning) out.signingSecret = (signingSecret as string).trim();
  if (hasPrimary) out.primaryChannelByAgent = primaryChannelByAgent;
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
  const allowedOrigins = Array.isArray(r.allowedOrigins)
    ? r.allowedOrigins
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    : [];
  if (!bind && !token && allowedAgentIds.length === 0 && allowedOrigins.length === 0) return null;
  const out: WebBusConfig = {};
  if (bind) out.bind = bind;
  if (token) out.token = token;
  if (allowedAgentIds.length > 0) out.allowedAgentIds = allowedAgentIds;
  if (allowedOrigins.length > 0) out.allowedOrigins = allowedOrigins;
  return out;
}

/** `settings.mcp` warnings already printed: the hot-reload re-parses the
 *  settings every 30 s, and one bad value should not warn forever. */
const mcpSettingWarned = new Set<string>();
function warnMcpSettingOnce(message: string): void {
  if (mcpSettingWarned.has(message)) return;
  mcpSettingWarned.add(message);
  console.warn(message);
}

const BRIDGE_ENTRY_KEYS = new Set(["enabled", "allowedTools", "deniedTools"]);

/**
 * Parse `settings.mcp.bridge` (#230). This block only ever restricts, so a
 * typo must not leave open a tool the operator meant to fence: a malformed
 * plugin entry (not an object, an unknown key such as a misspelt
 * `deniedTools`, `enabled` not a boolean, a tool list that is not an array of
 * strings) turns that key OFF, and a non-object block, an unknown key next to
 * `plugins`, or a `defaultDeny` that is not a boolean turns deny-by-default
 * ON. Each with one warning. `false` / `null` read as absent.
 */
function parseMcpBridgeConfig(raw: unknown): McpBridgeConfig {
  const plugins: Record<string, McpBridgePluginConfig> = {};
  if (raw === undefined || raw === null || raw === false) return { plugins };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnMcpSettingOnce(
      "[mcp] settings.mcp.bridge must be an object; refusing every bridge tool (defaultDeny, nothing listed)",
    );
    return { plugins, defaultDeny: true };
  }
  const obj = raw as Record<string, unknown>;
  // Same fail-closed rule one level up: a misspelt `defaultDeny`, or a value
  // that is not a boolean, turns deny-by-default ON rather than off.
  let defaultDeny = false;
  for (const key of Object.keys(obj)) {
    if (key === "plugins" || key === "defaultDeny") continue;
    warnMcpSettingOnce(
      `[mcp] settings.mcp.bridge.${key} is not a known key (plugins, defaultDeny); unlisted plugins are refused`,
    );
    defaultDeny = true;
  }
  if (obj.defaultDeny === true) defaultDeny = true;
  else if (obj.defaultDeny !== undefined && obj.defaultDeny !== null && obj.defaultDeny !== false) {
    warnMcpSettingOnce(
      "[mcp] settings.mcp.bridge.defaultDeny must be a boolean; unlisted plugins are refused",
    );
    defaultDeny = true;
  }
  const done = (): McpBridgeConfig => ({ plugins, ...(defaultDeny ? { defaultDeny } : {}) });
  const rawPlugins = obj.plugins;
  if (rawPlugins === undefined) return done();
  if (!rawPlugins || typeof rawPlugins !== "object" || Array.isArray(rawPlugins)) {
    warnMcpSettingOnce("[mcp] settings.mcp.bridge.plugins must be an object; ignoring it");
    return done();
  }
  const toolList = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((t) => typeof t === "string") ? (v as string[]) : null;
  for (const [id, v] of Object.entries(rawPlugins as Record<string, unknown>)) {
    // Cannot name a plugin or a server, and assigning it would set the
    // object's prototype rather than add an entry.
    if (id === "__proto__") {
      warnMcpSettingOnce(
        "[mcp] settings.mcp.bridge.plugins.__proto__ is not a valid key; ignoring it",
      );
      continue;
    }
    const entry = v as Record<string, unknown> | null;
    const malformed =
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((k) => !BRIDGE_ENTRY_KEYS.has(k)) ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean") ||
      (entry.allowedTools !== undefined && toolList(entry.allowedTools) === null) ||
      (entry.deniedTools !== undefined && toolList(entry.deniedTools) === null);
    if (malformed) {
      warnMcpSettingOnce(
        `[mcp] settings.mcp.bridge.plugins.${id} is malformed (keys: enabled, allowedTools, deniedTools); all its tools are refused`,
      );
      plugins[id] = { enabled: false };
      continue;
    }
    const parsed: McpBridgePluginConfig = {};
    if (entry.enabled !== undefined) parsed.enabled = entry.enabled as boolean;
    if (entry.allowedTools !== undefined)
      parsed.allowedTools = [...(entry.allowedTools as string[])];
    if (entry.deniedTools !== undefined) parsed.deniedTools = [...(entry.deniedTools as string[])];
    plugins[id] = parsed;
  }
  return done();
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
  const sessionPersistenceEnabled = raw?.sessionPersistenceEnabled !== false;

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

  // Issue #69: response caching. Default off; operator must enumerate
  // cacheable (server, tool) pairs explicitly.
  const rawCache = raw?.cache;
  const cacheEnabled = rawCache?.enabled === true;
  const rawCacheTtl = rawCache?.ttlMs;
  const cacheTtlMs =
    typeof rawCacheTtl === "number" && Number.isFinite(rawCacheTtl) && rawCacheTtl > 0
      ? Math.max(100, Math.floor(rawCacheTtl))
      : 5_000;
  const rawCacheMax = rawCache?.maxEntries;
  const cacheMaxEntries =
    typeof rawCacheMax === "number" && Number.isFinite(rawCacheMax) && rawCacheMax > 0
      ? Math.max(1, Math.floor(rawCacheMax))
      : 1_000;
  const cacheableRaw =
    rawCache?.cacheable && typeof rawCache.cacheable === "object" ? rawCache.cacheable : {};
  const cacheable: Record<string, string[]> = {};
  for (const [serverName, tools] of Object.entries(cacheableRaw)) {
    if (!Array.isArray(tools)) continue;
    const filtered = tools.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (filtered.length > 0) cacheable[serverName] = filtered;
  }

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
    cache: {
      enabled: cacheEnabled,
      ttlMs: cacheTtlMs,
      maxEntries: cacheMaxEntries,
      cacheable,
      // Default true per issue #69 acceptance; operator opts out by
      // setting false (e.g. cleanly-partitioned tools).
      defensiveInvalidation: rawCache?.defensiveInvalidation !== false,
    },
    bridge: parseMcpBridgeConfig(raw?.bridge),
    audit: parseMcpAuditPolicy(raw?.audit),
  };
}

/** The `telegram.allowedUserIds` warnings printed by the last parse: the
 *  hot-reload re-parses the settings every 30 s, and one bad value should not
 *  warn forever. A clean parse clears it, so a value that goes bad again warns
 *  again. */
let telegramIdsLastWarnings = "";

/** TEST-ONLY: forget the last printed warnings, so each test sees its own. */
export function _resetTelegramIdsWarningsForTests(): void {
  telegramIdsLastWarnings = "";
}

/**
 * `telegram.allowedUserIds`: a list of integer ids. A list keeps its non-zero
 * integers, and integer strings as the number they spell; any other entry is
 * dropped with a warning. Negative ids (group chats) never match a sender but
 * are kept: the list also names where job output is forwarded. Taken as-is, a
 * string reached `includes` in the allow check and matched any user whose id
 * is a substring of it.
 *
 * A value that is present but holds no valid id (a lone string or number
 * written by mistake, a list of junk) becomes `[0]`, not `[]`: no Telegram user
 * has id 0, so both runtimes' allow checks refuse every sender, and the startup
 * check (`allowlistStartupWarnings`) does not report the value as "empty" when
 * the warning above already names the real problem. Outbound forwards that walk
 * the list then target chat 0 and log a send error until the value is fixed.
 */
function parseTelegramUserIds(value: unknown): number[] {
  const warnings: string[] = [];
  const ids = telegramUserIdsOf(value, warnings);
  const key = warnings.join("\n");
  if (key !== telegramIdsLastWarnings) for (const w of warnings) console.warn(w);
  telegramIdsLastWarnings = key;
  return ids;
}

function telegramUserIdsOf(value: unknown, warnings: string[]): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(
      `[config] telegram.allowedUserIds must be a list of integer user ids, got a ${typeof value}; no Telegram user is allowed until it is fixed`,
    );
    return [0];
  }
  const ids: number[] = [];
  for (const entry of value) {
    const id =
      typeof entry === "string" && /^\s*-?\d+\s*$/.test(entry) ? Number(entry.trim()) : entry;
    if (typeof id === "number" && Number.isSafeInteger(id) && id !== 0) ids.push(id);
  }
  if (ids.length < value.length) {
    warnings.push(
      `[config] telegram.allowedUserIds: ignored ${value.length - ids.length} entry(ies) that are not integer ids`,
    );
  }
  if (value.length > 0 && ids.length === 0) {
    warnings.push(
      "[config] telegram.allowedUserIds has no valid user id; no Telegram user is allowed until it is fixed",
    );
    return [0];
  }
  return ids;
}

/** The `slack`/`discord` `allowedUserIds` warnings printed by the last parse,
 *  per platform: same once-per-problem rule as `telegramIdsLastWarnings`. */
const chatIdsLastWarnings = new Map<string, string>();

/** TEST-ONLY: forget the last printed warnings, so each test sees its own. */
export function _resetChatUserIdsWarningsForTests(): void {
  chatIdsLastWarnings.clear();
}

/**
 * `slack.allowedUserIds` / `discord.allowedUserIds`: a list of ids, kept as
 * strings. Discord ids come from `preciseIds` (`parseSettingsText`: JSON
 * numbers lose precision on snowflakes) only when they spell the parsed list
 * entry for entry.
 *
 * A value that is present but is not a list (a single id written as a string
 * or a number by mistake) becomes `["0"]`, not `[]`: no Slack or Discord user
 * has id "0", so every allow check refuses every sender. Outbound DMs that walk the list
 * then target "0" and log a send error until the value is fixed. Same rule as
 * `telegram.allowedUserIds`.
 */
function parseChatUserIds(
  platform: "slack" | "discord",
  value: unknown,
  preciseIds?: string[],
): string[] {
  const warnings: string[] = [];
  let ids: string[];
  if (value === undefined || value === null) {
    ids = [];
  } else if (!Array.isArray(value)) {
    warnings.push(
      `[config] ${platform}.allowedUserIds must be a list of user ids, got a ${typeof value}; no ${platform === "slack" ? "Slack" : "Discord"} user is allowed until it is fixed`,
    );
    ids = ["0"];
  } else if (preciseIds && sameIds(preciseIds, value)) {
    ids = preciseIds;
  } else {
    // A number past 2^53 was rounded by JSON.parse: its string is another id,
    // not the one written (so is a nested list's: String([n])). Keep only
    // strings and exact integers, drop the rest rather than allow whoever owns
    // the rounded id; a list left empty that way allows nobody, not everyone.
    const exact = (v: unknown) =>
      typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));
    ids = value.filter(exact).map(String);
    if (ids.length < value.length) {
      warnings.push(
        `[config] ${platform}.allowedUserIds holds an entry that is not an id, or an id written as a number too large to read exactly; write each id in quotes. It is ignored until then`,
      );
      if (ids.length === 0) ids = ["0"];
    }
  }
  const key = warnings.join("\n");
  if (key !== (chatIdsLastWarnings.get(platform) ?? "")) for (const w of warnings) console.warn(w);
  chatIdsLastWarnings.set(platform, key);
  return ids;
}

/** True when the raw-text ids are the parsed list, at full precision. */
function sameIds(precise: string[], parsed: unknown[]): boolean {
  return (
    precise.length === parsed.length &&
    precise.every((id, i) => {
      const entry = parsed[i];
      return typeof entry === "number" ? Number(id) === entry : entry === id;
    })
  );
}

/**
 * `settings.mcp.audit`. Absent or null → `best-effort`. Any value other than the two
 * known ones is read as `enforce`, with a warning: someone who set the key
 * asked for something stricter than the default, and a typo must not
 * silently turn the guarantee off.
 */
function parseMcpAuditPolicy(raw: unknown): AuditPolicy {
  if (raw === undefined || raw === null || raw === "best-effort") return "best-effort";
  if (raw === "enforce") return "enforce";
  warnMcpSettingOnce(
    `[mcp] settings.mcp.audit must be "enforce" or "best-effort" (got ${JSON.stringify(raw)}); using "enforce"`,
  );
  return "enforce";
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

function parseQuietHours(value: unknown): QuietHoursConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    windows: parseExcludeWindows(raw.windows),
    urgentBypass: raw.urgentBypass === true,
  };
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Parse the settings text and read `discord.allowedUserIds` at full precision.
 * JSON numbers lose precision past 2^53 (Discord snowflakes), so the parse
 * keeps the source text of every number held in an array, keyed by the array
 * JSON.parse built. The ids are then read from the very list the settings
 * use: another "discord" or "allowedUserIds" anywhere in the file, a
 * duplicated key or a key written with a \u escape cannot stand in for it.
 * A runtime without the reviver's source text gives no ids, and the parsed
 * list is used as is (a rounded id is dropped there, never allowed).
 */
function parseSettingsText(rawText: string) {
  const numberSources = new WeakMap<object, string[]>();
  function keepNumberSource(
    this: unknown,
    key: string,
    value: unknown,
    context?: { source?: string },
  ): unknown {
    if (Array.isArray(this) && typeof value === "number" && typeof context?.source === "string") {
      const sources = numberSources.get(this) ?? [];
      sources[Number(key)] = context.source;
      numberSources.set(this, sources);
    }
    return value;
  }
  const raw = JSON.parse(rawText, keepNumberSource);
  return { raw, discordUserIds: discordUserIdsOf(raw?.discord?.allowedUserIds, numberSources) };
}

/** The ids of `list` as written, or [] unless every entry is a plain integer. */
function discordUserIdsOf(list: unknown, numberSources: WeakMap<object, string[]>): string[] {
  if (!Array.isArray(list)) return [];
  const sources = numberSources.get(list) ?? [];
  const ids: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const id = typeof list[i] === "number" ? sources[i] : list[i];
    if (typeof id !== "string" || !/^\d+$/.test(id)) return [];
    ids.push(id);
  }
  return ids;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const { raw, discordUserIds } = parseSettingsText(rawText);
  cached = parseSettings(raw, discordUserIds);
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const { raw, discordUserIds } = parseSettingsText(rawText);
  cached = parseSettings(raw, discordUserIds);
  return cached;
}

/** Path of the settings.json the loader and the web UI save handlers use. */
export function getSettingsFile(): string {
  return SETTINGS_FILE;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

/**
 * TEST-ONLY: redirect the settings file path so tests never read or write the
 * developer's real `<cwd>/.claude/claudeclaw/settings.json` (which is frozen at
 * module load to the start-up cwd). Pass a temp path to point there; call with
 * no argument to restore the default. The web UI save handlers follow it too.
 * Clears the settings cache so the next
 * `loadSettings()` / `reloadSettings()` reads from the (new) path. Pair with a
 * call in the test's `afterEach` to avoid leaking the override or cached
 * settings across tests.
 */
export function _setSettingsFileForTests(path?: string): void {
  SETTINGS_FILE = path ?? DEFAULT_SETTINGS_FILE;
  cached = null;
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
