import { writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { extractErrorDetail } from "../messaging";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  run,
  runUserMessage,
  streamUserMessage,
  bootstrap,
  ensureProjectClaudeMd,
  loadHeartbeatPromptTemplate,
  isRateLimited,
  getRateLimitResetAt,
  wasRateLimitNotified,
  markRateLimitNotified,
  probeClaudeCliVersion,
} from "../runner";
import {
  initGatewayProcessor,
  registerGatewayDelivery,
  unregisterGatewayDelivery,
} from "../event-processor";
import { writeState, type StateData } from "../statusline";
import { cronMatches, nextCronMatch } from "../cron";
import { clearJobSchedule, loadJobs, resolveJobModel, snapshotJobFrontmatter } from "../jobs";
import { migrateLegacyAgentJobs } from "../migrations";
import { ensureUserSymlinks } from "../install";
import { writePidFile, cleanupPidFile, checkExistingDaemon } from "../pid";
import {
  initConfig,
  loadSettings,
  reloadSettings,
  resolvePrompt,
  type HeartbeatConfig,
  type Settings,
} from "../config";
import { getDayAndMinuteAtOffset, buildClockPromptPrefix } from "../timezone";
import { isHeartbeatExcludedAt, isHeartbeatExcludedNow } from "../heartbeat-windows";
import { startWebUi, type WebServerHandle } from "../web";
import { getOrCreateWebToken } from "../ui/auth";
import { streamBusPrompt } from "../bus/webui-bridge";
import { initializeJobSystem } from "../orchestrator/resumable-jobs";
import type { Job } from "../jobs";
import { isWizardTrigger, hasActiveWizard, handleWizardInput } from "./plugin-wizard";
import { PluginManager, setPluginManager } from "../plugins";
import { indexSessionsBackground } from "../memory";
import { getMcpProxyPlugin } from "../plugins/mcp-proxy/index.js";
import { getMcpMultiplexerPlugin } from "../plugins/mcp-multiplexer/index.js";
import { injectMcpIdentityIssuer } from "../runner/pty-supervisor";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../preflight.ts", import.meta.url));

// --- Statusline setup/teardown ---

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join } = require("path");

const DIR = join(__dirname, "claudeclaw");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function stripAnsi(s) { return s.replace(/\\x1b\\[[0-9;]*m/g, ""); }
function visibleLen(s) {
  var clean = stripAnsi(s);
  var len = 0;
  for (var i = 0; i < clean.length; i++) {
    var code = clean.codePointAt(i);
    if (code > 0xffff) { i++; len += 2; }
    else { len++; }
  }
  return len;
}

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    var parsedPid = Number(pid);
    if (!Number.isFinite(parsedPid) || !Number.isInteger(parsedPid) || parsedPid <= 0) {
      return false;
    }
    process.kill(parsedPid, 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TITLE = " \\ud83e\\udd9e ClaudeClaw+ \\ud83e\\udd9e ";
var PAD = 6;
var INNER_W = PAD + visibleLen(TITLE) + PAD;

function render(content) {
  var contentW = visibleLen(content);
  var w = Math.max(contentW, INNER_W);
  var titlePad = w - visibleLen(TITLE);
  var leftPad = Math.floor(titlePad / 2);
  var rightPad = titlePad - leftPad;
  var H = DIM + "\\u2500" + R;
  var header = DIM + "\\u256d" + R + H.repeat(leftPad) + TITLE + H.repeat(rightPad) + DIM + "\\u256e" + R;
  var footer = DIM + "\\u2570" + R + H.repeat(w) + DIM + "\\u256f" + R;
  var gap = w - contentW;
  var padded = gap > 0 ? content + " ".repeat(gap) : content;
  process.stdout.write(header + "\\n" + B + padded + B + "\\n" + footer);
}

if (!alive()) {
  render("        " + RED + "\\u25cb offline" + R);
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  if (state.discord) {
    info.push(GREEN + "\\ud83c\\udfae" + R);
  }

  render(" " + info.join(" " + B + " ") + " ");
} catch {
  render(DIM + "         waiting...         " + R);
}
`;

// Sprint 5.2d (PR #126): exclusion-window logic extracted to
// `src/heartbeat-windows.ts` so `wireBusScheduler` can reuse it. The
// legacy heartbeat tick still imports + calls these.

/**
 * Stable digest of the jobs that affect scheduler behaviour. Two job
 * lists with identical digests can re-use the existing in-memory
 * scheduler; different digests trigger the hot-reload path.
 *
 * Fields covered:
 *   - `name` — keying / log labels.
 *   - `schedule` — cron expression.
 *   - `prompt` — payload sent at each fire.
 *   - `enabled` — when toggled to false, the Bus scheduler must drop
 *     the trigger. Defaults to true when missing.
 *   - `agent` — when changed, the Bus scheduler must reroute. Defaults
 *     to "" when missing (matches the daemon's "use first agent"
 *     fallback).
 *
 * Codex P1 on PR #126: pre-fix this only covered schedule + prompt,
 * so flipping `enabled` or rerouting `agent` left stale triggers
 * firing until daemon restart.
 *
 * Exported for unit testing.
 */
export function computeJobsDigest(jobs: readonly Job[]): string {
  return jobs
    .map((j) => `${j.name}:${j.schedule}:${j.prompt}:${j.enabled !== false}:${j.agent ?? ""}`)
    .sort()
    .join("|");
}

function nextAllowedHeartbeatAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  intervalMs: number,
  fromMs: number,
): number {
  const interval = Math.max(60_000, Math.round(intervalMs));
  let candidate = fromMs + interval;
  let guard = 0;

  while (
    isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date(candidate)) &&
    guard < 20_000
  ) {
    candidate += interval;
    guard++;
  }

  return candidate;
}

async function setupStatusline() {
  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(STATUSLINE_FILE, STATUSLINE_SCRIPT);

  let settings: Record<string, unknown> = {};
  try {
    settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
  } catch {
    // file doesn't exist or isn't valid JSON
  }
  settings.statusLine = {
    type: "command",
    command: "node .claude/statusline.cjs",
  };
  await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

// --- Main ---

export async function start(args: string[] = []) {
  let hasPromptFlag = false;
  let hasTriggerFlag = false;
  let telegramFlag = false;
  let discordFlag = false;
  let slackFlag = false;
  let debugFlag = false;
  let webFlag = false;
  let replaceExistingFlag = false;
  let webPortFlag: number | null = null;
  const payloadParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prompt") {
      hasPromptFlag = true;
    } else if (arg === "--trigger") {
      hasTriggerFlag = true;
    } else if (arg === "--telegram") {
      telegramFlag = true;
    } else if (arg === "--discord") {
      discordFlag = true;
    } else if (arg === "--slack") {
      slackFlag = true;
    } else if (arg === "--debug") {
      debugFlag = true;
    } else if (arg === "--web") {
      webFlag = true;
    } else if (arg === "--replace-existing") {
      replaceExistingFlag = true;
    } else if (arg === "--web-port") {
      const raw = args[i + 1];
      if (!raw) {
        console.error("`--web-port` requires a numeric value.");
        process.exit(1);
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        console.error("`--web-port` must be a valid TCP port (1-65535).");
        process.exit(1);
      }
      webPortFlag = parsed;
      i++;
    } else {
      payloadParts.push(arg);
    }
  }
  const payload = payloadParts.join(" ").trim();
  if (hasPromptFlag && !payload) {
    console.error(
      "Usage: claudeclaw start --prompt <prompt> [--trigger] [--telegram] [--discord] [--slack] [--debug] [--web] [--web-port <port>] [--replace-existing]",
    );
    process.exit(1);
  }
  if (!hasPromptFlag && payload) {
    console.error("Prompt text requires `--prompt`.");
    process.exit(1);
  }
  if (telegramFlag && !hasTriggerFlag) {
    console.error("`--telegram` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (discordFlag && !hasTriggerFlag) {
    console.error("`--discord` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (slackFlag && !hasTriggerFlag) {
    console.error("`--slack` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (hasPromptFlag && !hasTriggerFlag && (webFlag || webPortFlag !== null)) {
    console.error("`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.");
    process.exit(1);
  }

  // One-shot mode: explicit prompt without trigger.
  if (hasPromptFlag && !hasTriggerFlag) {
    const existingPid = await checkExistingDaemon();
    if (existingPid) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(
        "Use `claudeclaw send <message> [--telegram] [--discord]` while daemon is running.",
      );
      process.exit(1);
    }

    await initConfig();
    await loadSettings();
    await ensureProjectClaudeMd();
    const result = await runUserMessage("prompt", payload);
    console.log(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const existingPid = await checkExistingDaemon();
  if (existingPid) {
    if (!replaceExistingFlag) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(`Use --stop first, or kill PID ${existingPid} manually.`);
      process.exit(1);
    }

    console.log(`Replacing existing daemon (PID ${existingPid})...`);
    try {
      process.kill(existingPid, "SIGTERM");
    } catch {
      // ignore if process is already dead
    }

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        process.kill(existingPid, 0);
        await Bun.sleep(100);
      } catch {
        break;
      }
    }

    await cleanupPidFile();
  }

  await initConfig();
  const settings = await loadSettings();
  await ensureProjectClaudeMd();

  // Wire deployed claudeclaw's skills/commands into Claude Code's user-level
  // discovery paths (~/.claude/skills/, ~/.claude/commands/). No-op in local
  // dev. Idempotent and non-destructive.
  try {
    const links = await ensureUserSymlinks();
    const now = new Date().toLocaleTimeString();
    if (links.created.length > 0) {
      console.log(
        `[${now}] Installed ${links.created.length} user symlink(s): ${links.created.join(", ")}`,
      );
    }
    if (links.errors.length > 0) {
      for (const e of links.errors) {
        console.error(`[${now}] Symlink install error: ${e.path} → ${e.reason}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] ensureUserSymlinks failed:`, err);
  }

  // memory-search: incremental session re-index on boot (issue #19).
  // Async fire-and-forget — must NOT block the Bun event loop on first boot
  // (model download + indexing of N sessions could otherwise freeze Telegram /
  // Discord polling for tens of seconds). Top-level try so failures here are
  // never confused with symlink-installation failures.
  try {
    const memSettings = await loadSettings();
    indexSessionsBackground(memSettings.memorySearch);
  } catch (e) {
    console.log(`[memory-search] background index could not be scheduled: ${(e as Error).message}`);
  }

  // Phase 17: migrate any Phase 16 single-job agents from flat dir into agents/<name>/jobs/default.md
  const migration = await migrateLegacyAgentJobs();
  if (migration.migrated.length > 0) {
    console.log(
      `[migration] moved ${migration.migrated.length} agent job(s) to agents/<name>/jobs/default.md: ${migration.migrated.join(", ")}`,
    );
  }

  const jobs = await loadJobs();

  // Initialize job system: wires governance adapter and resumes any pending workflows
  const { pendingResumed, pendingFailed } = await initializeJobSystem();
  if (pendingResumed > 0 || pendingFailed > 0) {
    console.log(
      `[${new Date().toLocaleTimeString()}] Job system: ${pendingResumed} resumed, ${pendingFailed} failed`,
    );
  }

  const webEnabled = webFlag || webPortFlag !== null || settings.web.enabled;
  const webPort = webPortFlag ?? settings.web.port;

  await setupStatusline();
  await writePidFile();
  let web: WebServerHandle | null = null;
  let discordStopGateway: (() => void) | null = null;
  let slackStopFn: (() => void) | null = null;
  // Full `BusRuntimeHandle` shape (rather than the narrow `{stop}`)
  // so the hot-reload loop can reach `.bus` to rebuild the scheduler
  // when heartbeat/jobs change. Sprint 5.2d.
  let busRuntimeHandle: import("../bus/runtime-mount").BusRuntimeHandle | null = null;
  // The live BusCore once `runtime: "bus"` mounts. Hoisted so the
  // webui can build a bridge that calls `bus.sendPrompt` for its
  // trigger routes (jobs/fire, inject, chat) instead of spawning a
  // sidecar PTY claude that would race the bus's own session.
  let busCoreForWebUi: import("../bus/core").BusCore | null = null;

  // Plugin system — initialize before gateway start
  const pluginManager = new PluginManager(process.cwd());
  if (Object.keys(settings.plugins).length > 0) {
    await pluginManager.loadAll(settings.plugins);
    setPluginManager(pluginManager);
  }

  // Bus runtime mount (Sprint 5.1 + 5.2a + 5.2b) — opt-in via `settings.runtime: "bus"`.
  //
  // 5.1: BusCore + SessionManager + slash-relay (IPC server listening).
  // 5.2a: auto-spawn `claude` per `settings.agents` entry.
  // 5.2b (this PR): adapter wiring — Discord/Telegram/Slack/WebUi
  //   instantiated from per-platform `busRouting` config + token, then
  //   passed into `mountBusRuntime` so the handle's stop() owns them.
  //   When the Bus mount succeeds, the legacy `initTelegram` / `initDiscord`
  //   / `initSlack` / legacy `startWebUi` blocks below are SKIPPED so
  //   inbound traffic is delivered only once.
  //
  // 5.2c follow-up: `BusScheduler` integration for heartbeat/cron.
  //
  // Failure semantics: a mount failure (resolution, spawn, or adapter
  // wiring) logs an error and falls back to the legacy adapters so the
  // daemon doesn't half-mount.
  let busRuntimeSpawnedAgents: readonly string[] = [];
  let busRuntimeAdapterNames: readonly string[] = [];
  if (settings.runtime === "bus") {
    try {
      const { mountBusRuntime, resolveDaemonSocketPath } = await import("../bus/runtime-mount");
      const { resolveBusAgentConfigs } = await import("../bus/agent-resolver");
      const { BusCoreImpl } = await import("../bus/core");
      const { SessionManager } = await import("../bus/session-manager");

      const resolved = await resolveBusAgentConfigs(settings.agents, {
        defaultCwd: process.cwd(),
      });
      const failures = resolved.filter((r) => r.config === null);
      if (failures.length > 0) {
        const ids = failures.map((f) => f.entry.id).join(", ");
        throw new Error(`failed to resolve agent config(s): ${ids}`);
      }
      const agentConfigs = resolved
        .map((r) => r.config)
        .filter((c): c is NonNullable<typeof c> => c !== null);

      // Boot order matters. PR #123 Codex P1+P2 + issue #165:
      //   1. Build BusCore + SessionManager (no I/O yet).
      //   2. mountBusRuntime with `deferSpawn: true` — starts the IPC
      //      server + slash relay + orphan scan, but does NOT spawn agents
      //      yet. The bus is live and addressable; no agents registered.
      //   3. (after the MCP multiplexer block below) wire the synthesizer,
      //      `handle.spawnAgents()`, THEN `wireBusAdapters` +
      //      `handle.attachAdapters`. Issue #165: agents must spawn after
      //      the multiplexer issuer is wired (so they get `--mcp-config`),
      //      and adapters must start AFTER agents exist (Codex P2:
      //      prompt-loss race — adapters polling with zero registered
      //      agents would silently drop inbound prompts).
      // Search "Issue #165: deferred bus agent spawn" for step 3.
      const socketPath = resolveDaemonSocketPath();
      const bus = new BusCoreImpl({ socketPath });
      const sessionManager = new SessionManager({ busSocketPath: socketPath });
      const handle = await mountBusRuntime({
        bus,
        sessionManager,
        agents: agentConfigs,
        deferSpawn: true,
        projectRoot: process.cwd(),
      });
      busRuntimeHandle = handle;
      busRuntimeSpawnedAgents = handle.spawnedAgentIds; // [] until deferred spawn
      busRuntimeAdapterNames = handle.mountedAdapterNames; // [] until adapters wired
      busCoreForWebUi = bus;
    } catch (err) {
      console.error(
        `[${ts()}] Bus runtime: mount failed — falling back to legacy command surfaces only`,
        err,
      );
      busRuntimeHandle = null;
      busRuntimeSpawnedAgents = [];
      busRuntimeAdapterNames = [];
      // Issue #166 / Codex P1 on PR #171: a previous successful bus boot
      // may have left a CCPLUS_ARCHITECTURE.md saying "Mode: bus" on disk.
      // Now that we've fallen back to legacy, that doc is actively
      // misleading — agents reading it would diagnose against a runtime
      // that isn't actually running. Remove it best-effort.
      try {
        const { defaultArchitectureDocPath } = await import("../architecture-doc");
        const { unlinkSync, existsSync } = await import("node:fs");
        const docPath = defaultArchitectureDocPath(process.cwd());
        if (existsSync(docPath)) {
          unlinkSync(docPath);
          console.log(`[${ts()}] removed stale architecture doc: ${docPath}`);
        }
      } catch (unlinkErr) {
        console.warn(`[${ts()}] failed to remove stale architecture doc:`, unlinkErr);
      }
    }
  }
  // Legacy adapter gate (Sprint 5.2b): when the Bus mount succeeded, the
  // legacy initTelegram / initDiscord / initSlack startup below MUST be
  // skipped so each platform's inbound traffic is handled only by the
  // Bus adapter. The variable is hoisted so the existing
  // `await initTelegram(...)` call sites further down can guard on it.
  //
  // NOTE: web is NOT skipped any more. The legacy dashboard (sessions,
  // logs, kanban, settings, job mgmt) is the documented operator UI
  // and has feature parity for read paths; the trigger paths
  // (/api/jobs/fire, /api/inject, /api/chat) route through
  // `bus.sendPrompt` via the BusWebUiBridge so they don't sidestep the
  // bus's per-agent claude. Sprint 5.2b's old behaviour (skip legacy
  // web) left operators with a "not_found" page because the bus webui
  // adapter at `/health` + `/prompt` is not a dashboard replacement.
  // `let`, not `const` (issue #165): if the DEFERRED agent spawn below
  // fails, we tear the bus down and fall back to legacy command surfaces,
  // which means flipping this back to false so the legacy adapter + legacy
  // heartbeat paths re-engage.
  let skipLegacyAdapters = busRuntimeHandle !== null;

  // Issue #165: bus adapters are now wired AFTER the deferred agent spawn
  // (below the multiplexer block), so `busRuntimeAdapterNames` is still
  // empty at the startup-banner + legacy-skip logs above this point. Use
  // the configured-intent list (same token/busRouting predicates
  // wireBusAdapters uses) so those logs report the right platforms.
  // #197: pass the declared default agent id so the banner reflects the
  // token-only Telegram mount (busRouting derived from the default agent).
  const configuredBusAdapters: readonly string[] = busRuntimeHandle
    ? (await import("../bus/adapter-wiring")).configuredBusAdapterNames(
        settings,
        settings.agents[0]?.id,
      )
    : [];

  let mcpProxyStarted: Promise<void> = Promise.resolve();

  async function shutdown() {
    await mcpProxyStarted.catch(() => {}); // drain start() before stop() clears server map
    await getMcpProxyPlugin().stop();
    await pluginManager.stopServices();
    setPluginManager(null);
    if (discordStopGateway) discordStopGateway();
    if (slackStopFn) slackStopFn();
    if (web) web.stop();
    if (busRuntimeHandle) {
      try {
        await busRuntimeHandle.stop();
      } catch (err) {
        console.error("[bus-runtime] shutdown failed", err);
      }
    }
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("ClaudeClaw+ daemon started");
  console.log(`  PID: ${process.pid}`);
  // Probe and log the Claude CLI version so operators see which `claude`
  // the daemon is invoking. Mismatch against the parser's known-good list
  // logs a warning but does NOT block startup — the PTY parser also has
  // a turnIdleTimeoutMs safety net for unknown versions.
  const cliProbe = await probeClaudeCliVersion();
  if (cliProbe.version === null) {
    console.warn(`  Claude CLI: could not probe (claude --version failed)`);
  } else if (cliProbe.known) {
    console.log(`  Claude CLI: ${cliProbe.version} (validated)`);
  } else {
    console.warn(
      `  Claude CLI: ${cliProbe.version} (NOT in PTY parser's known-good list; turn-boundary detection may degrade — check .planning/pty-migration/SPEC.md §2)`,
    );
  }
  if (settings.runtime === "bus" && busRuntimeHandle) {
    // Issue #165: agents spawn AFTER the multiplexer block below, so at
    // banner time they're declared-but-not-yet-spawned. Report the
    // declared count here; the per-agent `[bus-runtime] spawned agent=…`
    // lines confirm the actual spawn a few steps later.
    const agentsLabel =
      settings.agents.length === 0
        ? "no agents declared"
        : `${settings.agents.length} agent(s) declared (spawn deferred until MCP issuer wired)`;
    const adaptersLabel =
      configuredBusAdapters.length === 0
        ? "no adapters configured"
        : `adapters=[${configuredBusAdapters.join(", ")}] (wired after agents)`;
    console.log(`  Runtime: bus (Bus stack mounted, ${agentsLabel}, ${adaptersLabel})`);
  } else if (settings.runtime === "bus") {
    console.log(`  Runtime: bus (Bus mount failed; legacy surfaces only)`);
  } else {
    console.log(`  Runtime: ${settings.runtime}`);
  }
  console.log(`  Security: ${settings.security.level}`);
  if (settings.security.allowedTools.length > 0)
    console.log(`    + allowed: ${settings.security.allowedTools.join(", ")}`);
  if (settings.security.disallowedTools.length > 0)
    console.log(`    - blocked: ${settings.security.disallowedTools.join(", ")}`);
  console.log(
    `  Heartbeat: ${settings.heartbeat.enabled ? `every ${settings.heartbeat.interval}m` : "disabled"}`,
  );
  console.log(`  Web UI: ${webEnabled ? `http://${settings.web.host}:${webPort}` : "disabled"}`);
  if (debugFlag) console.log("  Debug: enabled");
  console.log(`  Jobs loaded: ${jobs.length}`);
  jobs.forEach((j) => {
    console.log(`    - ${j.name} [${j.schedule}]`);
  });

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStartedAt = Date.now();

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  let telegramToken = "";
  let telegramReceiveEnabled = true;

  async function initTelegram(token: string, receiveEnabled = true) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage, deliverGatewayReply } = await import("./telegram");
      if (receiveEnabled) startPolling(debugFlag);
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramToken = token;
      telegramReceiveEnabled = receiveEnabled;
      // Register the outbound delivery hook so gateway-routed events get a reply.
      registerGatewayDelivery("telegram", (event, result) =>
        deliverGatewayReply(token, event, result),
      );
      console.log(`[${ts()}] Telegram: enabled${receiveEnabled ? "" : " (send-only)"}`);
    } else if (token && token === telegramToken && receiveEnabled !== telegramReceiveEnabled) {
      const { startPolling, stopPolling } = await import("./telegram");
      if (receiveEnabled) {
        startPolling(debugFlag);
        console.log(`[${ts()}] Telegram: receive enabled`);
      } else {
        stopPolling();
        console.log(`[${ts()}] Telegram: receive disabled (send-only)`);
      }
      telegramReceiveEnabled = receiveEnabled;
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramToken = "";
      unregisterGatewayDelivery("telegram");
      console.log(`[${ts()}] Telegram: disabled`);
    }
  }

  if (skipLegacyAdapters) {
    console.log(
      `  Telegram: handled by Bus adapter${configuredBusAdapters.includes("telegram") ? "" : " (not configured)"}`,
    );
  } else {
    await initTelegram(currentSettings.telegram.token, currentSettings.telegram.receiveEnabled);
    if (!telegramToken) console.log("  Telegram: not configured");
  }

  // --- Gateway event processor ---
  // Wire up the event processor for gateway v2 path (Discord/Telegram → event log → processor → runUserMessage)
  await initGatewayProcessor(async (source, prompt) => runUserMessage(source, prompt));

  // --- Discord ---
  let discordSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let discordToken = "";

  async function initDiscord(token: string) {
    if (token && token !== discordToken) {
      const { startGateway, sendMessageToUser, stopGateway, deliverGatewayReply } = await import(
        "./discord"
      );
      if (discordToken) stopGateway();
      startGateway(debugFlag);
      discordStopGateway = stopGateway;
      discordSendToUser = (userId, text) => sendMessageToUser(token, userId, text);
      discordToken = token;
      // Register the outbound delivery hook so gateway-routed events get a reply.
      registerGatewayDelivery("discord", (event, result) =>
        deliverGatewayReply(token, event, result),
      );
      console.log(`[${ts()}] Discord: enabled`);
    } else if (!token && discordToken) {
      if (discordStopGateway) discordStopGateway();
      discordStopGateway = null;
      discordSendToUser = null;
      discordToken = "";
      unregisterGatewayDelivery("discord");
      console.log(`[${ts()}] Discord: disabled`);
    }
  }

  if (skipLegacyAdapters) {
    console.log(
      `  Discord: handled by Bus adapter${configuredBusAdapters.includes("discord") ? "" : " (not configured)"}`,
    );
  } else {
    await initDiscord(currentSettings.discord.token);
    if (!discordToken) console.log("  Discord: not configured");
  }

  // --- Slack ---
  let slackSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let slackBotToken = "";
  let slackAppToken = "";

  async function initSlack(botToken: string, appToken: string) {
    if (botToken && appToken && (botToken !== slackBotToken || appToken !== slackAppToken)) {
      const { startSlack, sendMessageToUser: slackSend, stopSlack } = await import("./slack");
      if (slackBotToken || slackAppToken) stopSlack();
      startSlack(debugFlag);
      slackStopFn = stopSlack;
      slackSendToUser = (userId, text) => slackSend(botToken, userId, text);
      slackBotToken = botToken;
      slackAppToken = appToken;
      console.log(`[${ts()}] Slack: enabled`);
    } else if ((!botToken || !appToken) && (slackBotToken || slackAppToken)) {
      if (slackStopFn) slackStopFn();
      slackStopFn = null;
      slackSendToUser = null;
      slackBotToken = "";
      slackAppToken = "";
      console.log(`[${ts()}] Slack: disabled`);
    }
  }

  if (skipLegacyAdapters) {
    console.log(
      `  Slack: handled by Bus adapter${configuredBusAdapters.includes("slack") ? "" : " (not configured)"}`,
    );
  } else {
    await initSlack(currentSettings.slack.botToken, currentSettings.slack.appToken);
    if (!slackBotToken) console.log("  Slack: not configured");
  }

  // Wire channel senders into plugin runtime so plugins can send messages
  if (pluginManager.hasPlugins) {
    pluginManager.setChannelSenders({
      telegram: {
        sendMessageTelegram: telegramSend
          ? (chatId: number, text: string) => telegramSend!(chatId, text)
          : () => Promise.resolve(),
      },
      discord: {
        sendMessageDiscord: discordSendToUser
          ? (userId: string, text: string) => discordSendToUser!(userId, text)
          : () => Promise.resolve(),
      },
      slack: {
        sendMessageSlack: (userId: string, text: string) =>
          slackSendToUser ? slackSendToUser(userId, text) : Promise.resolve(),
      },
    });
    await pluginManager.startServices();
    await pluginManager.emit("gateway_start", {}, { workspaceDir: process.cwd() });
  }

  // MCP multiplexer (SPEC §4.5, §6.3): start BEFORE mcp-proxy so the proxy
  // can read settings.mcp.shared to skip servers the multiplexer owns. Also
  // wires the multiplexer's issue/release functions into the PTY supervisor.
  //
  // Activation rule (SPEC §6.3): only attempt to start when shared is
  // non-empty AND web.enabled is true. Otherwise the plugin would have
  // nothing to mount routes on.
  if (settings.mcp.shared.length > 0 && settings.web.enabled) {
    try {
      const plugin = getMcpMultiplexerPlugin();
      await plugin.start();
      // Codex PR #71 P1: plugin.start() can return successfully but leave
      // the multiplexer dormant (missing/invalid mcp-proxy.json, zero
      // claimed servers, etc). Only wire the supervisor seam when the
      // plugin is *actually* serving — otherwise the supervisor would
      // synthesize --mcp-config entries pointing at routes that were
      // never registered. When dormant, supervisor's existing
      // null-issuer guard skips synthesis and PTYs fall back to default
      // MCP discovery, exactly as the surrounding comment promises.
      if (plugin.isActive()) {
        // bridgeBaseUrl reads from the plugin so supervisor and plugin
        // can't drift on the URL the multiplexer actually bound to.
        injectMcpIdentityIssuer({
          issue: (ptyId) => plugin.issueIdentity(ptyId),
          revoke: (ptyId) => plugin.releaseIdentity(ptyId),
          bridgeBaseUrl: () => plugin.bridgeBaseUrl(),
        });
        // Issue #165: the legacy PTY supervisor reaches mcp.shared via the
        // issuer wired just above, but the BUS spawn path has its own
        // buildClaudeArgs that never synthesized from mcp.shared. Wire the
        // same issuer into the bus SessionManager so deferred bus agents
        // (spawned below) get a synthesized --mcp-config too. Only inside
        // this isActive() branch, so the dormant path stays byte-identical.
        if (busRuntimeHandle) {
          // Codex P2 on PR #184: use the ACTUALLY claimed server names, not
          // the operator's requested list. When the multiplexer starts
          // partially (e.g. one shared server failed to claim, another
          // succeeded), `plugin.isActive()` is true as soon as any one
          // claimed, but `settings.mcp.shared` still lists the failures.
          // Writing those names into bus agents' --mcp-config would point
          // them at /mcp/<server> routes that were never registered. The
          // multiplexer already caches the claimed set explicitly for this
          // case (see `sharedServerNames()` + the "ACTUALLY claimed"
          // comment in src/plugins/mcp-multiplexer/index.ts).
          busRuntimeHandle.sessionManager.setMcpConfigSynthesizer({
            issue: (ptyId) => plugin.issueIdentity(ptyId),
            revoke: (ptyId) => plugin.releaseIdentity(ptyId),
            bridgeBaseUrl: () => plugin.bridgeBaseUrl(),
            sharedServers: plugin.sharedServerNames(),
          });
        }
        console.log("[mcp-multiplexer] started");
      } else {
        console.warn(
          "[mcp-multiplexer] start() returned dormant — supervisor wiring skipped, PTYs fall back to default MCP discovery.",
        );
      }
    } catch (err) {
      // Don't crash the daemon — log clearly and fall back to per-PTY MCP
      // discovery (settings.mcp.shared becomes effectively dormant).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[mcp-multiplexer] startup failed (non-fatal, falling back to per-PTY MCP discovery): ${msg}`,
      );
    }
  } else if (settings.mcp.shared.length > 0 && !settings.web.enabled) {
    // Issue #165 (PR #184 review): mcp.shared is configured but web is
    // disabled, so the multiplexer never starts and the synthesizer is
    // never wired — bus agents launch with NO --mcp-config and every
    // mcp.shared server is silently unreachable. Warn loudly so the
    // operator isn't left with the exact silent-failure mode this fix
    // set out to kill. (Enable web, or clear mcp.shared.)
    console.warn(
      `[mcp-multiplexer] settings.mcp.shared is set (${settings.mcp.shared.join(", ")}) but web.enabled is false — the multiplexer cannot mount its HTTP routes, so bus agents will spawn WITHOUT --mcp-config and these servers will be unreachable. Set web.enabled: true to use mcp.shared.`,
    );
  }

  // Issue #165: deferred bus agent spawn. The MCP multiplexer issuer is now
  // wired (or confirmed dormant) above, so spawning here means each agent's
  // claude PTY is built with the synthesizer in place — buildClaudeArgs/spawn
  // can attach a --mcp-config for mcp.shared servers. We also wire the
  // BusScheduler (targets the first spawned agent id) and write the
  // architecture doc (reports the spawned set) here, since both depend on the
  // spawn. On failure we tear the bus down and fall back to legacy surfaces,
  // matching a mount failure (the legacy adapter init was skipped at the gate
  // because busRuntimeHandle was non-null — re-run it here).
  if (busRuntimeHandle) {
    try {
      await busRuntimeHandle.spawnAgents();
      busRuntimeSpawnedAgents = busRuntimeHandle.spawnedAgentIds;

      // Issue #165 / PR #123 Codex P2: wire adapters AFTER agents are
      // spawned. Adapters call adapter.start() (poll loops / HTTP
      // listeners) on mount, so wiring them before any agent is registered
      // would let an inbound prompt hit a live bus with zero targets and be
      // silently dropped during the multiplexer-start window.
      const { wireBusAdapters } = await import("../bus/adapter-wiring");
      const { adapters, errors } = await wireBusAdapters({
        bus: busRuntimeHandle.bus,
        settings: currentSettings,
        // #197: lets the Telegram adapter mount on a token alone by routing to
        // the bus's default agent when `telegram.busRouting` is unset.
        defaultAgentId: busRuntimeHandle.spawnedAgentIds[0],
      });
      for (const [name, msg] of Object.entries(errors)) {
        console.warn(`[${ts()}] Bus adapter "${name}" failed to mount: ${msg}`);
      }
      busRuntimeHandle.attachAdapters(adapters);
      busRuntimeAdapterNames = busRuntimeHandle.mountedAdapterNames;

      const { wireBusScheduler } = await import("../bus/scheduler-wiring");
      const schedulerHandle = await wireBusScheduler({
        bus: busRuntimeHandle.bus,
        defaultAgentId: busRuntimeHandle.spawnedAgentIds[0] ?? null,
        heartbeat: currentSettings.heartbeat,
        jobs: currentJobs,
        timezoneOffsetMinutes: currentSettings.timezoneOffsetMinutes,
      });
      busRuntimeHandle.attachScheduler(schedulerHandle);

      // Issue #166: write the architecture doc only after the bus booted
      // end-to-end (spawn + scheduler), so a doc on disk always reflects a
      // genuinely-running bus. Best-effort — a missing doc degrades agent
      // diagnostics but doesn't break operation.
      try {
        const { collectArchitectureSnapshot } = await import("../architecture-doc-snapshot");
        const { writeArchitectureDoc, defaultArchitectureDocPath } = await import(
          "../architecture-doc"
        );
        const snapshot = await collectArchitectureSnapshot({
          settings: currentSettings,
          spawnedAgentIds: busRuntimeHandle.spawnedAgentIds,
          adapters: busRuntimeAdapterNames.map((name) => ({ name })),
        });
        const path = defaultArchitectureDocPath(process.cwd());
        writeArchitectureDoc(snapshot, path);
        console.log(`[${ts()}] wrote architecture doc: ${path}`);
      } catch (docErr) {
        console.warn(`[${ts()}] architecture doc write failed:`, docErr);
      }
    } catch (spawnErr) {
      console.error(
        `[${ts()}] Bus runtime: deferred agent spawn failed — tearing down and falling back to legacy command surfaces`,
        spawnErr,
      );
      try {
        await busRuntimeHandle.stop();
      } catch (stopErr) {
        console.error(`[${ts()}] handle.stop() during deferred-spawn rollback failed`, stopErr);
      }
      busRuntimeHandle = null;
      busRuntimeSpawnedAgents = [];
      busRuntimeAdapterNames = [];
      busCoreForWebUi = null;
      skipLegacyAdapters = false;
      // A prior bus boot may have left a CCPLUS_ARCHITECTURE.md saying
      // "Mode: bus"; now that we've fallen back to legacy it's misleading.
      try {
        const { defaultArchitectureDocPath } = await import("../architecture-doc");
        const { existsSync: exists, unlinkSync: unlink } = await import("node:fs");
        const docPath = defaultArchitectureDocPath(process.cwd());
        if (exists(docPath)) unlink(docPath);
      } catch {
        /* best-effort */
      }
      // Re-engage the legacy adapters that were skipped at the gate above.
      await initTelegram(currentSettings.telegram.token, currentSettings.telegram.receiveEnabled);
      await initDiscord(currentSettings.discord.token);
      await initSlack(currentSettings.slack.botToken, currentSettings.slack.appToken);
    }
  }

  // Start mcp-proxy plugin only when a config file is present — avoids opening
  // an HTTP gateway on deployments that don't use external MCP plugins.
  const mcpProxyConfigPath = join(homedir(), ".config", "claudeclaw", "mcp-proxy.json");
  const mcpProxyAltConfigPath = join(homedir(), ".config", "claude", "mcp.json");
  if (existsSync(mcpProxyConfigPath) || existsSync(mcpProxyAltConfigPath)) {
    mcpProxyStarted = getMcpProxyPlugin({
      reasonedInvokeFn: async (fqn, args) => {
        const prompt = `Use tool \`${fqn}\` with these arguments: ${JSON.stringify(args)}. Return ONLY the raw JSON result of the tool, no prose, no markdown.`;
        const result = await runUserMessage("inject", prompt);
        const text = result.stdout
          .trim()
          .replace(/^```[a-z]*\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    })
      .start()
      .catch((err) => {
        console.error(
          "[mcp-proxy] Startup error (non-fatal):",
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  function isAddrInUse(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = "code" in err ? String((err as { code?: unknown }).code) : "";
    const message = "message" in err ? String((err as { message?: unknown }).message) : "";
    return code === "EADDRINUSE" || message.includes("EADDRINUSE");
  }

  function startWebWithFallback(
    host: string,
    preferredPort: number,
    token: string,
  ): WebServerHandle {
    const maxAttempts = 10;
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidatePort = preferredPort + i;
      try {
        return startWebUi({
          host,
          port: candidatePort,
          token,
          getSnapshot: () => ({
            pid: process.pid,
            startedAt: daemonStartedAt,
            heartbeatNextAt: nextHeartbeatAt,
            settings: currentSettings,
            jobs: currentJobs,
          }),
          onHeartbeatEnabledChanged: (enabled) => {
            if (currentSettings.heartbeat.enabled === enabled) return;
            currentSettings.heartbeat.enabled = enabled;
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Heartbeat ${enabled ? "enabled" : "disabled"} from Web UI`);
          },
          onHeartbeatSettingsChanged: (patch) => {
            let changed = false;
            if (
              typeof patch.enabled === "boolean" &&
              currentSettings.heartbeat.enabled !== patch.enabled
            ) {
              currentSettings.heartbeat.enabled = patch.enabled;
              changed = true;
            }
            if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
              const interval = Math.max(1, Math.min(1440, Math.round(patch.interval)));
              if (currentSettings.heartbeat.interval !== interval) {
                currentSettings.heartbeat.interval = interval;
                changed = true;
              }
            }
            if (
              typeof patch.prompt === "string" &&
              currentSettings.heartbeat.prompt !== patch.prompt
            ) {
              currentSettings.heartbeat.prompt = patch.prompt;
              changed = true;
            }
            if (Array.isArray(patch.excludeWindows)) {
              const prev = JSON.stringify(currentSettings.heartbeat.excludeWindows);
              const next = JSON.stringify(patch.excludeWindows);
              if (prev !== next) {
                currentSettings.heartbeat.excludeWindows = patch.excludeWindows;
                changed = true;
              }
            }
            if (!changed) return;
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Heartbeat settings updated from Web UI`);
          },
          onJobsChanged: async () => {
            currentJobs = await loadJobs();
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Jobs reloaded from Web UI`);
          },
          onChat: async (message, onChunk, onUnblock, onAgentEvent) => {
            const wizardCtx = { iface: "web" as const, scopeId: "default" };
            if (isWizardTrigger(message) || hasActiveWizard(wizardCtx)) {
              onChunk(await handleWizardInput(wizardCtx, message));
              return;
            }
            // Bus runtime: route the chat through the bus's default
            // agent so it lands in the same claude session every other
            // surface (Discord/Telegram/cron) drives. Pass the chunk
            // callback so each `response.text` event from the agent
            // gets streamed back to the dashboard SSE in real time.
            const bus = busCoreForWebUi;
            const defaultAgent = busRuntimeSpawnedAgents[0];
            if (bus && defaultAgent) {
              const result = await streamBusPrompt(bus, defaultAgent, message, {
                origin: "webui",
                originId: "chat",
                onChunk,
              });
              // Codex P2 on #136: surface timeout / dispatch failure to
              // the SSE stream so a failed turn doesn't render as a
              // successful `done` event on the dashboard. The error
              // chunk is rendered inline; the SSE `done` still follows
              // via `onUnblock` so the client unblocks the input.
              if (!result.ok && result.error) {
                onChunk(`\n[chat error: ${result.error}]\n`);
              }
              onUnblock();
              return;
            }
            await streamUserMessage("chat", message, onChunk, onUnblock, onAgentEvent);
          },
          bus:
            busCoreForWebUi && busRuntimeSpawnedAgents[0]
              ? {
                  defaultAgentId: busRuntimeSpawnedAgents[0],
                  sendPromptAndAwait: (agentId, text, sendOpts) =>
                    streamBusPrompt(
                      busCoreForWebUi as NonNullable<typeof busCoreForWebUi>,
                      agentId,
                      text,
                      {
                        // `BusWebUiBridge.sendPromptAndAwait`'s `origin` is
                        // typed as `string` to keep `src/ui/types.ts`
                        // independent of the bus types. The bus tagged
                        // union is narrower; only webui callers reach
                        // this path so the cast is safe at the seam.
                        origin: sendOpts?.origin as import("../bus/types").BusOrigin | undefined,
                        originId: sendOpts?.originId,
                        timeoutMs: sendOpts?.timeoutMs,
                      },
                    ),
                }
              : undefined,
        });
      } catch (err) {
        lastError = err;
        if (!isAddrInUse(err) || i === maxAttempts - 1) throw err;
      }
    }

    throw lastError;
  }

  if (currentSettings.telegram.token && currentSettings.telegram.allowedUserIds.length === 0) {
    console.error("Refusing to start: telegram.token is set but telegram.allowedUserIds is empty.");
    console.error("The allowlist is now fail-closed; an empty list blocks all users.");
    console.error(
      "Add your Telegram user ID(s) to telegram.allowedUserIds in .claude/claudeclaw/settings.json.",
    );
    console.error(
      "Run `claudeclaw config` for guided setup, or see the README for migration steps.",
    );
    process.exit(1);
  }

  if (currentSettings.discord.token && currentSettings.discord.allowedUserIds.length === 0) {
    console.error("Refusing to start: discord.token is set but discord.allowedUserIds is empty.");
    console.error("The allowlist is now fail-closed; an empty list blocks all users.");
    console.error(
      "Add your Discord user ID(s) to discord.allowedUserIds in .claude/claudeclaw/settings.json.",
    );
    console.error(
      "Run `claudeclaw config` for guided setup, or see the README for migration steps.",
    );
    process.exit(1);
  }

  if (webEnabled) {
    currentSettings.web.enabled = true;
    // Issue #164: mint + persist a 256-bit web token at
    // .claude/claudeclaw/web.token (0600) on first start, then enforce it
    // on every /api/* route. On the rare chance provisioning fails (e.g.
    // unwritable .claude dir) we fall back to an in-memory random token so
    // the server still boots WITH auth rather than unauthenticated — the
    // operator just won't have the file to read; they can restart once the
    // dir is writable.
    let webToken: string;
    try {
      webToken = await getOrCreateWebToken();
    } catch (err) {
      console.warn(
        `[${ts()}] could not persist web.token, using in-memory token: ${extractErrorDetail(err)}`,
      );
      webToken = randomBytes(32).toString("base64url");
    }
    web = startWebWithFallback(currentSettings.web.host, webPort, webToken);
    currentSettings.web.port = web.port;
    console.log(
      `[${new Date().toLocaleTimeString()}] Web UI listening on http://${web.host}:${web.port}` +
        (skipLegacyAdapters ? " (bus-aware)" : ""),
    );
    if (skipLegacyAdapters && busRuntimeAdapterNames.includes("webui")) {
      // Operator has BOTH the legacy dashboard AND the optional bus
      // webui adapter mounted. They serve different surfaces (dashboard
      // vs `/health` + `/prompt`) and live on different ports. Worth a
      // one-line log so the operator isn't surprised by two listeners.
      console.log(
        `[${new Date().toLocaleTimeString()}] Web UI: bus adapter also mounted on ${currentSettings.web.bus?.bind ?? "(no bind configured)"}`,
      );
    }
  }

  // --- Helpers ---
  function ts() {
    return new Date().toLocaleTimeString();
  }

  function startPreflightInBackground(projectPath: string): void {
    try {
      const proc = Bun.spawn([process.execPath, "run", PREFLIGHT_SCRIPT, projectPath], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      proc.unref();
      console.log(`[${ts()}] Plugin preflight started in background`);
    } catch (err) {
      console.error(`[${ts()}] Failed to start plugin preflight:`, err);
    }
  }

  function forwardToTelegram(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!telegramSend || currentSettings.telegram.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.telegram.allowedUserIds) {
      telegramSend(userId, text).catch((err) =>
        console.error(`[Telegram] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  function forwardToDiscord(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!discordSendToUser || currentSettings.discord.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.discord.allowedUserIds) {
      discordSendToUser(userId, text).catch((err) =>
        console.error(`[Discord] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  function forwardToSlack(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!slackSendToUser || currentSettings.slack.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.slack.allowedUserIds) {
      slackSendToUser(userId, text).catch((err) =>
        console.error(`[Slack] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;

    if (!currentSettings.heartbeat.enabled) {
      nextHeartbeatAt = 0;
      return;
    }

    const ms = currentSettings.heartbeat.interval * 60_000;
    nextHeartbeatAt = nextAllowedHeartbeatAt(
      currentSettings.heartbeat,
      currentSettings.timezoneOffsetMinutes,
      ms,
      Date.now(),
    );

    function tick() {
      if (isRateLimited()) {
        const resetAt = new Date(getRateLimitResetAt());
        console.log(`[${ts()}] Heartbeat skipped (rate limited until ${resetAt.toISOString()})`);
        if (!wasRateLimitNotified()) {
          markRateLimitNotified();
          const msg = `Usage limit hit. Pausing until ${resetAt.toUTCString()}. Heartbeats and jobs suspended.`;
          forwardToTelegram("", { exitCode: 1, stdout: msg, stderr: "" });
          forwardToDiscord("", { exitCode: 1, stdout: msg, stderr: "" });
        }
        return;
      }
      if (
        isHeartbeatExcludedNow(currentSettings.heartbeat, currentSettings.timezoneOffsetMinutes)
      ) {
        console.log(`[${ts()}] Heartbeat skipped (excluded window)`);
        nextHeartbeatAt = nextAllowedHeartbeatAt(
          currentSettings.heartbeat,
          currentSettings.timezoneOffsetMinutes,
          ms,
          Date.now(),
        );
        return;
      }
      Promise.all([resolvePrompt(currentSettings.heartbeat.prompt), loadHeartbeatPromptTemplate()])
        .then(([prompt, template]) => {
          const userPromptSection = prompt.trim()
            ? `User custom heartbeat prompt:\n${prompt.trim()}`
            : "";
          const mergedPrompt = [template.trim(), userPromptSection]
            .filter((part) => part.length > 0)
            .join("\n\n");
          if (!mergedPrompt) return null;
          const clock = buildClockPromptPrefix(new Date(), currentSettings.timezoneOffsetMinutes);
          return run("heartbeat", `${clock}\n${mergedPrompt}`);
        })
        .then((r) => {
          if (!r) return;
          const normalized = r.stdout.trim();
          const shouldSuppress =
            normalized.startsWith("HEARTBEAT_OK") || normalized.endsWith("HEARTBEAT_OK");
          const shouldForward = currentSettings.heartbeat.forwardToTelegram || !shouldSuppress;
          if (shouldForward) {
            forwardToTelegram("", r);
          }
          if (currentSettings.heartbeat.forwardToDiscord || !shouldSuppress) {
            forwardToDiscord("", r);
          }
        });
      nextHeartbeatAt = nextAllowedHeartbeatAt(
        currentSettings.heartbeat,
        currentSettings.timezoneOffsetMinutes,
        ms,
        Date.now(),
      );
    }

    heartbeatTimer = setTimeout(function runAndReschedule() {
      tick();
      heartbeatTimer = setTimeout(runAndReschedule, ms);
    }, ms);
  }

  // Startup init:
  // - trigger mode: run exactly one trigger prompt (no separate bootstrap)
  // - normal mode: bootstrap to initialize session context
  if (hasTriggerFlag) {
    const triggerPrompt = hasPromptFlag ? payload : "Wake up, my friend!";
    const triggerResult = await run("trigger", triggerPrompt);
    console.log(triggerResult.stdout);
    if (telegramFlag) forwardToTelegram("", triggerResult);
    if (discordFlag) forwardToDiscord("", triggerResult);
    if (slackFlag) forwardToSlack("", triggerResult);
    if (triggerResult.exitCode !== 0) {
      console.error(
        `[${ts()}] Startup trigger failed (exit ${triggerResult.exitCode}). Daemon will continue running.`,
      );
    }
  } else {
    // Bootstrap the session first so system prompt is initial context
    // and session.json is created immediately.
    await bootstrap();
  }

  // Install plugins without blocking daemon startup.
  startPreflightInBackground(process.cwd());

  // Sprint 5.2c: when the Bus runtime is mounted, the legacy heartbeat
  // tick is skipped — `wireBusScheduler` already registered the
  // heartbeat against the Bus scheduler so firing it again here would
  // double-trigger.
  if (currentSettings.heartbeat.enabled && !skipLegacyAdapters) scheduleHeartbeat();

  // --- Hot-reload loop (every 30s) ---
  setInterval(async () => {
    try {
      const newSettings = await reloadSettings();
      const newJobs = await loadJobs();

      // Detect heartbeat config changes
      const hbChanged =
        newSettings.heartbeat.enabled !== currentSettings.heartbeat.enabled ||
        newSettings.heartbeat.interval !== currentSettings.heartbeat.interval ||
        newSettings.heartbeat.prompt !== currentSettings.heartbeat.prompt ||
        newSettings.timezoneOffsetMinutes !== currentSettings.timezoneOffsetMinutes ||
        newSettings.timezone !== currentSettings.timezone ||
        JSON.stringify(newSettings.heartbeat.excludeWindows) !==
          JSON.stringify(currentSettings.heartbeat.excludeWindows);

      // Detect security config changes
      const secChanged =
        newSettings.security.level !== currentSettings.security.level ||
        newSettings.security.allowedTools.join(",") !==
          currentSettings.security.allowedTools.join(",") ||
        newSettings.security.disallowedTools.join(",") !==
          currentSettings.security.disallowedTools.join(",");

      if (secChanged) {
        console.log(`[${ts()}] Security level changed → ${newSettings.security.level}`);
      }

      if (hbChanged) {
        console.log(
          `[${ts()}] Config change detected — heartbeat: ${newSettings.heartbeat.enabled ? `every ${newSettings.heartbeat.interval}m` : "disabled"}`,
        );
        currentSettings = newSettings;
        if (!skipLegacyAdapters) scheduleHeartbeat();
      } else {
        currentSettings = newSettings;
      }
      if (web) {
        currentSettings.web.enabled = true;
        currentSettings.web.port = web.port;
      }

      // Detect job changes. Digest covers every field the schedulers
      // consume: schedule + prompt for both paths, plus `enabled` and
      // `agent` which the Bus scheduler uses to decide whether the job
      // fires AND which agent it dispatches to (Codex P1 on PR #126 —
      // `enabled: false` toggles and `agent` reroutes were silently
      // ignored, so the in-memory scheduler kept stale triggers until
      // restart).
      const jobNames = computeJobsDigest(newJobs);
      const oldJobNames = computeJobsDigest(currentJobs);
      if (jobNames !== oldJobNames) {
        console.log(`[${ts()}] Jobs reloaded: ${newJobs.length} job(s)`);
        newJobs.forEach((j) => {
          console.log(`    - ${j.name} [${j.schedule}]`);
        });
      }
      currentJobs = newJobs;

      if (!skipLegacyAdapters) {
        // Telegram changes
        await initTelegram(newSettings.telegram.token, newSettings.telegram.receiveEnabled);

        // Discord changes
        await initDiscord(newSettings.discord.token);

        // Slack changes
        await initSlack(newSettings.slack.botToken, newSettings.slack.appToken);
      } else if (busRuntimeHandle && (hbChanged || jobNames !== oldJobNames)) {
        // Sprint 5.2d: Bus-scheduler hot-reload for heartbeat + jobs.
        // Adapter routing changes still require daemon restart — only
        // the scheduler's per-trigger registration is cheap enough to
        // rebuild in-process (cancel + create against the live bus).
        try {
          const { wireBusScheduler } = await import("../bus/scheduler-wiring");
          const fresh = await wireBusScheduler({
            bus: busRuntimeHandle.bus,
            defaultAgentId: busRuntimeHandle.spawnedAgentIds[0] ?? null,
            heartbeat: newSettings.heartbeat,
            jobs: newJobs,
            timezoneOffsetMinutes: newSettings.timezoneOffsetMinutes,
          });
          // attachScheduler stops the previous scheduler before
          // replacing it (see runtime-mount.ts) so old triggers can't
          // leak.
          busRuntimeHandle.attachScheduler(fresh);
          console.log(`[${ts()}] Bus scheduler reloaded — ${fresh.scheduled.length} trigger(s)`);
        } catch (reErr) {
          console.error(`[${ts()}] Bus scheduler hot-reload failed`, reErr);
        }
      }
      // Note: Bus ADAPTER changes (routing, tokens) still require a
      // daemon restart. Hot-reloading running adapters with new
      // routing would invalidate pending permission/ask maps; the
      // restart is the safer move until we have a session-migration
      // story.
    } catch (err) {
      console.error(`[${ts()}] Hot-reload error:`, err);
    }
  }, 30_000);

  // --- Cron tick (every 60s) ---
  function updateState() {
    const now = new Date();
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled ? { nextAt: nextHeartbeatAt } : undefined,
      jobs: currentJobs.map((job) => {
        const last = jobLastResult.get(job.name);
        const retryState = jobRetryState.get(job.name);
        return {
          name: job.name,
          nextAt: nextCronMatch(job.schedule, now, currentSettings.timezoneOffsetMinutes).getTime(),
          ...(last ? { lastResult: last.result, lastRanAt: last.ranAt } : {}),
          ...(retryState ? { failCount: retryState.failCount, retryAt: retryState.retryAt } : {}),
        };
      }),
      security: currentSettings.security.level,
      telegram: !!currentSettings.telegram.token,
      discord: !!currentSettings.discord.token,
      startedAt: daemonStartedAt,
      web: {
        enabled: !!web,
        host: currentSettings.web.host,
        port: currentSettings.web.port,
      },
    };
    writeState(state);
  }

  // In-memory retry state: resets on daemon restart (no stale debt across restarts).
  const jobRetryState = new Map<string, { failCount: number; retryAt: number }>();

  // Track each job's most recent outcome so state.json can expose lastResult/lastRanAt
  // for crash-recovery + status displays. Resets on daemon restart (in-memory only).
  const jobLastResult = new Map<string, { result: "ok" | "error" | "skipped"; ranAt: number }>();

  updateState();

  function runJob(job: (typeof currentJobs)[0]) {
    const timeoutMs = job.timeoutSeconds ? job.timeoutSeconds * 1000 : undefined;
    snapshotJobFrontmatter(job.name).then((restoreFrontmatter) =>
      resolvePrompt(job.prompt)
        .then(async (prompt) => {
          const modelOverride = await resolveJobModel(job);
          const clock = buildClockPromptPrefix(new Date(), currentSettings.timezoneOffsetMinutes);
          return run(
            job.name,
            `${clock}\n${prompt}`,
            job.agent ? `agent:${job.agent}` : job.name,
            modelOverride ?? job.model,
            timeoutMs,
            job.agent,
            "job",
          );
        })
        .then(async (r) => {
          const restored = await restoreFrontmatter();
          if (restored) console.log(`[${ts()}] Restored frontmatter for job: ${job.name}`);
          jobLastResult.set(job.name, {
            result: r.exitCode === 0 ? "ok" : "error",
            ranAt: Date.now(),
          });
          if (r.exitCode === 0) {
            jobRetryState.delete(job.name);
          } else if (job.retry && job.retry > 0) {
            // Preserve existing state so failCount accumulates correctly across retries.
            const state = jobRetryState.get(job.name) ?? { failCount: 0, retryAt: 0 };
            state.failCount += 1;
            if (state.failCount <= job.retry) {
              const delayMs = (job.retryDelay ?? 300) * 1000;
              state.retryAt = Date.now() + delayMs;
              jobRetryState.set(job.name, state);
              console.log(
                `[${ts()}] Job ${job.name} failed (attempt ${state.failCount}/${job.retry}), retrying in ${job.retryDelay ?? 300}s`,
              );
            } else {
              jobRetryState.delete(job.name);
              console.log(`[${ts()}] Job ${job.name} exhausted ${job.retry} retries`);
            }
          }
          if (job.notify === false) return;
          if (job.notify === "error" && r.exitCode === 0) return;
          const forwardLabel = job.agent && job.label ? `${job.agent}: ${job.label}` : job.name;
          forwardToTelegram(forwardLabel, r);
          forwardToDiscord(forwardLabel, r);
        })
        .finally(async () => {
          if (job.recurring) return;
          // Only clear one-shot schedule when no retry is pending.
          if (jobRetryState.has(job.name)) return;
          try {
            await clearJobSchedule(job.name);
            console.log(`[${ts()}] Cleared schedule for one-time job: ${job.name}`);
          } catch (err) {
            console.error(`[${ts()}] Failed to clear schedule for ${job.name}:`, err);
          }
        }),
    );
  }

  setInterval(() => {
    const now = new Date();
    if (!isRateLimited()) {
      for (const job of currentJobs) {
        // Fire pending retries before checking the cron schedule.
        const retryState = jobRetryState.get(job.name);
        if (retryState && retryState.retryAt <= Date.now()) {
          // Push retryAt to sentinel so subsequent cron ticks don't re-fire while in flight.
          // runJob's .then() handler overwrites this with the real next-retry time (or deletes it).
          retryState.retryAt = Number.MAX_SAFE_INTEGER;
          console.log(
            `[${ts()}] Retrying job: ${job.name} (attempt ${retryState.failCount + 1}/${job.retry})`,
          );
          runJob(job);
          continue;
        }
        if (cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes)) {
          runJob(job);
        }
      }
    } else {
      const skippedAt = Date.now();
      for (const job of currentJobs) {
        const retryState = jobRetryState.get(job.name);
        const retryDue = !!retryState && retryState.retryAt <= skippedAt;
        const scheduleDue = cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes);
        if (retryDue || scheduleDue) {
          jobLastResult.set(job.name, { result: "skipped", ranAt: skippedAt });
        }
      }
    }
    updateState();
  }, 60_000);
}
