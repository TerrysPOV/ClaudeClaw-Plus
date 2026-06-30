/**
 * Host telemetry producers + composite (OutcomeLoop Phase B).
 *
 * The tuner CONSUMES telemetry through `provider.query(...)`; the HOST PRODUCES
 * it. `session-cost-provider.ts` covers the `session_cost` stream. This file
 * adds the remaining feasible reference-host producers, each owning ONE stream,
 * each reading a single real source with graceful degradation, and composes
 * them (+ the cost provider) into one `TelemetryProvider` the subjects see.
 *
 * Provenance, per stream:
 *  - `cron_run`     ← `journalctl --user -u 'wisecron-*'` (unit run completions).
 *                     value = exit_code (0 = clean, nonzero = failure — matches
 *                     CronSubject.critical_fire_success); labels = unit, status,
 *                     exit_code.
 *  - `hook_exec`    ← `~/.claude/hooks/*.log` (one JSON line per hook fire).
 *                     value = duration_ms; labels = hook, exit_code, event.
 *  - `skill_access` ← `~/.config/tuner/skill_accesses.jsonl` (log-skill-access.py
 *                     PostToolUse hook). value = 1 per access; labels = skill.
 *  - `tool_call`, `mode_dispatch`, `agent_dispatch`, `memory_access`
 *                   ← `~/.claudeclaw/journal/operations.jsonl`, IF the journal
 *                     carries matching event types. The reference journal records
 *                     coarse operation entries only, so these advertise
 *                     `available:false` with a reason today — declared + inactive
 *                     by design (no faked data), active the day those events land.
 *
 * Every producer returns `[]` (never throws) for a stream it does not own and
 * for its own stream when the source is absent. The composite therefore just
 * concatenates query results, and merges capabilities one-per-stream preferring
 * an available producer.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type DateRange,
  type MetricSample,
  type PanelData,
  type TelemetryCapability,
  type TelemetryProvider,
  type TelemetryStream,
  TELEMETRY_CONTRACT_VERSION,
  TELEMETRY_STREAMS,
  type ViewManifest,
  type ViewManifestSource,
} from "../../skills-tuner/core/telemetry.js";
import { McpToolCallTelemetryProducer } from "../../observability/mcp-tool-call-producer.js";
import { type TunerViewSources, TunerViewProvider } from "./tuner-view-provider.js";
import { DEFAULT_MODE_DISPATCH_LOG } from "../../governance/mode-dispatch-journal.js";
import { DEFAULT_TEMPLATE_FEEDBACK_LOG } from "../../skills-tuner/core/template-feedback.js";
import { SessionCostTelemetryProvider } from "./session-cost-provider.js";
import { SessionJsonlTelemetryProducer } from "./session-jsonl-provider.js";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function inRange(ts: Date, range: DateRange): boolean {
  const t = ts.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

// ── cron_run ─────────────────────────────────────────────────────────────────

export interface CronRunProducerConfig {
  /** journalctl unit glob. Default 'wisecron-*.service'. */
  journalUnitGlob?: string;
  /** Required unit prefix used for the capability match rate. Default 'wisecron-'. */
  unitPrefix?: string;
  schemaVersion?: string;
  /** Injected journalctl runner (args → raw stdout). Synchronous so capability
   *  detection stays sync per the TelemetryProvider contract. Tests pass a fixture. */
  journalRunner?: (args: string[]) => string;
  /** costs.db for ClaudeClaw bus-scheduler cron-session detection (fallback
   *  source). Default `~/agent/data/costs.db`. */
  costDbPath?: string;
  /** Injected cron-config presence probe (feeds the unavailable reason). Default
   *  inspects `crontab -l` + `~/.config/cron`. Tests override for hermeticity. */
  cronConfigProbe?: () => CronConfigPresence;
}

interface CronRunEntry {
  unit: string;
  ts: Date;
  exitCode: number;
}

/** Which classic cron systems are configured (for diagnostics only). */
interface CronConfigPresence {
  /** `crontab -l` returned at least one schedule line. */
  crontab: boolean;
  /** `~/.config/cron` (XDG crontab snapshot sidecar) is present. */
  configSnapshot: boolean;
}

/** The cron source auto-detection resolved to. */
type CronSourceKind = "systemd" | "bus_scheduler" | "none";

/**
 * Emits `cron_run` from whichever real cron source THIS host actually has,
 * detected at registration instead of assuming `wisecron-*`. Priority:
 *
 *   1. **systemd**       — `journalctl --user -u 'wisecron-*'` entries that
 *                          carry `EXIT_STATUS` (a service run completed).
 *                          value = exit_code (0 clean, nonzero failure) — the
 *                          richest source, true crash detection.
 *   2. **bus_scheduler** — ClaudeClaw bus-scheduler cron sessions in costs.db
 *                          (`job LIKE '%source="cron"%'` …). A recorded session
 *                          IS a completed fire, so value = 0 (success); costs.db
 *                          carries no exit code, so this source cannot surface
 *                          crash-failures — flagged in the capability reason.
 *   3. **none**          — neither present. Advertised unavailable, the reason
 *                          naming any classic cron config found (crontab /
 *                          `~/.config/cron`) which defines schedules but logs no
 *                          machine-readable run completions.
 *
 * Either way the consumer (`CronSubject.critical_fire_success = 1 - nonzeroRate`)
 * reads the same value contract: 0 = clean, nonzero = failure.
 */
export class CronRunTelemetryProducer implements TelemetryProvider {
  private readonly journalUnitGlob: string;
  private readonly unitPrefix: string;
  private readonly schemaVersion: string;
  private readonly journalRunner: (args: string[]) => string;
  private readonly costDbPath: string;
  private readonly cronConfigProbe: () => CronConfigPresence;

  constructor(cfg: CronRunProducerConfig = {}) {
    this.journalUnitGlob = cfg.journalUnitGlob ?? "wisecron-*.service";
    this.unitPrefix = cfg.unitPrefix ?? "wisecron-";
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
    this.journalRunner = cfg.journalRunner ?? defaultJournalRunner;
    this.costDbPath = expandHome(cfg.costDbPath ?? join(homedir(), "agent", "data", "costs.db"));
    this.cronConfigProbe = cfg.cronConfigProbe ?? defaultCronConfigProbe;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private readEntries(since: Date): CronRunEntry[] {
    const args = [
      "--user",
      "-u",
      this.journalUnitGlob,
      "--since",
      since.toISOString(),
      "--output",
      "json",
    ];
    let raw: string;
    try {
      raw = this.journalRunner(args);
    } catch {
      return [];
    }
    return parseCronRunJournal(raw);
  }

  /** Resolve the active source by probing each candidate in priority order. */
  private detectKind(): CronSourceKind {
    if (this.readEntries(new Date(Date.now() - 7 * 86_400_000)).length > 0) return "systemd";
    if (busSchedulerRowCount(this.costDbPath) > 0) return "bus_scheduler";
    return "none";
  }

  capabilities(): TelemetryCapability[] {
    const kind = this.detectKind();
    if (kind === "systemd") {
      return [
        {
          stream: "cron_run",
          schemaVersion: this.schemaVersion,
          available: true,
          reason: `source=systemd ('${this.journalUnitGlob}' journal, exit codes)`,
        },
      ];
    }
    if (kind === "bus_scheduler") {
      return [
        {
          stream: "cron_run",
          schemaVersion: this.schemaVersion,
          available: true,
          reason: `source=bus_scheduler (ClaudeClaw cron sessions in ${this.costDbPath}; completions only, no crash-failure signal)`,
        },
      ];
    }
    const cfg = this.cronConfigProbe();
    const configured: string[] = [];
    if (cfg.crontab) configured.push("crontab");
    if (cfg.configSnapshot) configured.push("~/.config/cron");
    const tail =
      configured.length > 0
        ? `${configured.join(" + ")} present but log no machine-readable run completions`
        : `no '${this.journalUnitGlob}' units, no bus-scheduler sessions, no crontab`;
    return [
      {
        stream: "cron_run",
        schemaVersion: this.schemaVersion,
        available: false,
        reason: `no cron run-completion source — ${tail}`,
      },
    ];
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (stream !== "cron_run") return [];
    const kind = this.detectKind();
    if (kind === "systemd") {
      return this.readEntries(range.start)
        .filter((e) => inRange(e.ts, range))
        .map((e) => ({
          ts: e.ts,
          value: e.exitCode,
          labels: {
            unit: e.unit,
            exit_code: String(e.exitCode),
            status: e.exitCode === 0 ? "success" : "failure",
            source: "systemd",
          },
        }));
    }
    if (kind === "bus_scheduler") {
      return readBusSchedulerRuns(this.costDbPath, range);
    }
    return [];
  }
}

/** Count cron-attributed sessions in costs.db (any date). 0 when absent/unreadable. */
function busSchedulerRowCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const r = db
      .query(
        `SELECT COUNT(*) AS n FROM session_costs
         WHERE job LIKE '%source="cron"%' OR job LIKE '%bus-scheduler%' OR job LIKE 'cron%'`,
      )
      .get() as { n: number } | null;
    return r ? r.n : 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Each cron-attributed session = one completed fire (value 0). day-granular ts. */
function readBusSchedulerRuns(dbPath: string, range: DateRange): MetricSample[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        `SELECT date, job FROM session_costs
         WHERE (job LIKE '%source="cron"%' OR job LIKE '%bus-scheduler%' OR job LIKE 'cron%')
           AND date >= ? AND date < ?
         ORDER BY date ASC`,
      )
      .all(range.start.toISOString().slice(0, 10), range.end.toISOString().slice(0, 10)) as Array<{
      date: string;
      job: string;
    }>;
    return rows.map((r) => ({
      ts: new Date(`${r.date}T00:00:00.000Z`),
      value: 0, // a recorded session is a completed fire; no exit code in costs.db
      labels: {
        unit: busSchedulerUnit(r.job),
        exit_code: "0",
        status: "success",
        source: "bus_scheduler",
      },
    }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Pull the `chat_id="bus-scheduler:<id>"` out of a job string, else "bus-scheduler". */
function busSchedulerUnit(job: string): string {
  const m = job.match(/chat_id="(bus-scheduler:[^"]+)"/);
  return m ? m[1]! : "bus-scheduler";
}

/** Default cron-config presence probe: `crontab -l` + `~/.config/cron`. */
function defaultCronConfigProbe(): CronConfigPresence {
  let crontab = false;
  try {
    const res = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 5_000 });
    crontab =
      res.status === 0 &&
      (res.stdout ?? "").split("\n").some((l) => l.trim() && !l.trim().startsWith("#"));
  } catch {
    crontab = false;
  }
  const configSnapshot = existsSync(join(homedir(), ".config", "cron"));
  return { crontab, configSnapshot };
}

function parseCronRunJournal(raw: string): CronRunEntry[] {
  const out: CronRunEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Only run-completion entries carry EXIT_STATUS.
    const exitStatus = parsed.EXIT_STATUS;
    let exitCode: number | null = null;
    if (typeof exitStatus === "string") {
      const n = parseInt(exitStatus, 10);
      if (!Number.isNaN(n)) exitCode = n;
    } else if (typeof exitStatus === "number") {
      exitCode = exitStatus;
    }
    if (exitCode === null) continue;

    const unit =
      (parsed._SYSTEMD_USER_UNIT as string) ??
      (parsed._SYSTEMD_UNIT as string) ??
      (parsed.UNIT as string) ??
      "";
    if (!unit) continue;

    const tsRaw = parsed.__REALTIME_TIMESTAMP as string | undefined;
    let ts = new Date();
    if (tsRaw) {
      const usec = Number(tsRaw);
      if (!Number.isNaN(usec)) ts = new Date(Math.floor(usec / 1000));
    }
    out.push({ unit, ts, exitCode });
  }
  return out;
}

function defaultJournalRunner(args: string[]): string {
  const res = spawnSync("journalctl", args, { encoding: "utf8", timeout: 10_000 });
  // journalctl exits 0 with "No data available" on stderr when the unit glob
  // matches nothing; treat any no-output case as empty rather than throwing.
  if (res.error) return "";
  return res.stdout ?? "";
}

// ── hook_exec ────────────────────────────────────────────────────────────────

export interface HookExecProducerConfig {
  /** Hooks dir. Default ~/.claude/hooks. */
  hooksDir?: string;
  schemaVersion?: string;
  /** Injected reader (dir → parsed entries). Tests pass a fixture. */
  logReader?: (dir: string) => HookExecEntry[];
}

export interface HookExecEntry {
  hook: string;
  exitCode: number;
  durationMs: number;
  event: string;
  ts: Date;
}

/** Canonical exec-logger sink written by `~/.claude/hooks/exec-log.sh`. */
const HOOK_EXEC_LOG_FILE = "exec-log.jsonl";

/**
 * Emits `hook_exec` from the hooks dir (one JSON object per line:
 * `{ hook?, exit_code, duration_ms, event?, ts }`). value = duration_ms;
 * exit_code + event ride in labels so a consumer can derive crash-rate and p95.
 *
 * Source files, in order: the canonical `exec-log.jsonl` written by the
 * `exec-log.sh` wrapper (the instrumentation this stream ships with), plus any
 * legacy per-hook `*.log` files using the same line shape. The wrapper is the
 * producer of record; `*.log` support is kept for hosts with an older logging
 * convention.
 */
export class HookExecTelemetryProducer implements TelemetryProvider {
  private readonly hooksDir: string;
  private readonly schemaVersion: string;
  private readonly logReader: (dir: string) => HookExecEntry[];

  constructor(cfg: HookExecProducerConfig = {}) {
    this.hooksDir = expandHome(cfg.hooksDir ?? join(homedir(), ".claude", "hooks"));
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
    this.logReader = cfg.logReader ?? defaultHookLogReader;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  capabilities(): TelemetryCapability[] {
    let entries: HookExecEntry[];
    try {
      entries = this.logReader(this.hooksDir);
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      return [
        {
          stream: "hook_exec",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: `no parseable ${HOOK_EXEC_LOG_FILE}/*.log entries in ${this.hooksDir} (exec-log.sh wrapper not wired into any hook yet)`,
        },
      ];
    }
    return [{ stream: "hook_exec", schemaVersion: this.schemaVersion, available: true }];
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (stream !== "hook_exec") return [];
    let entries: HookExecEntry[];
    try {
      entries = this.logReader(this.hooksDir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => inRange(e.ts, range))
      .map((e) => ({
        ts: e.ts,
        value: e.durationMs,
        labels: { hook: e.hook, exit_code: String(e.exitCode), event: e.event },
      }));
  }
}

function defaultHookLogReader(dir: string): HookExecEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    // Canonical exec-logger sink (.jsonl) + legacy per-hook *.log files.
    files = readdirSync(dir).filter((f) => f === HOOK_EXEC_LOG_FILE || f.endsWith(".log"));
  } catch {
    return [];
  }
  const out: HookExecEntry[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null) continue;
        const hook = (obj.hook as string) ?? f.replace(/\.log$/, "");
        const exitCode = Number(obj.exit_code ?? 0);
        const durationMs = Number(obj.duration_ms ?? 0);
        const event = (obj.event as string) ?? "unknown";
        const tsRaw = obj.ts as string | number | undefined;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        if (Number.isNaN(ts.getTime())) continue;
        out.push({ hook, exitCode, durationMs, event, ts });
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

// ── skill_access ───────────────────────────────────────────────────────────--

export interface SkillAccessProducerConfig {
  /** JSONL log. Default ~/.config/tuner/skill_accesses.jsonl. */
  accessLog?: string;
  schemaVersion?: string;
}

/**
 * Emits `skill_access` from `~/.config/tuner/skill_accesses.jsonl`
 * (`{ skill_path, accessed_at }` per line). value = 1 per access; the skill
 * name (file basename, minus `.md`) rides in labels for per-skill grouping.
 */
export class SkillAccessTelemetryProducer implements TelemetryProvider {
  private readonly accessLog: string;
  private readonly schemaVersion: string;

  constructor(cfg: SkillAccessProducerConfig = {}) {
    this.accessLog = expandHome(
      cfg.accessLog ?? join(homedir(), ".config", "tuner", "skill_accesses.jsonl"),
    );
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private read(): Array<{ ts: Date; skill: string }> {
    if (!existsSync(this.accessLog)) return [];
    let content: string;
    try {
      content = readFileSync(this.accessLog, "utf8");
    } catch {
      return [];
    }
    const out: Array<{ ts: Date; skill: string }> = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const path = obj.skill_path as string | undefined;
        const at = obj.accessed_at as string | undefined;
        if (!path || !at) continue;
        const ts = new Date(at);
        if (Number.isNaN(ts.getTime())) continue;
        out.push({ ts, skill: basename(path, ".md") });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  capabilities(): TelemetryCapability[] {
    if (this.read().length === 0) {
      return [
        {
          stream: "skill_access",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: `no skill-access entries at ${this.accessLog}`,
        },
      ];
    }
    return [{ stream: "skill_access", schemaVersion: this.schemaVersion, available: true }];
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (stream !== "skill_access") return [];
    return this.read()
      .filter((e) => inRange(e.ts, range))
      .map((e) => ({ ts: e.ts, value: 1, labels: { skill: e.skill } }));
  }
}

// ── operations.jsonl-derived streams ─────────────────────────────────────────

export interface JournalProducerConfig {
  /** Operations journal. Default ~/.claudeclaw/journal/operations.jsonl. */
  journalPath?: string;
  schemaVersion?: string;
}

/** Streams this producer can derive from the operations journal, by type match. */
const JOURNAL_STREAMS: TelemetryStream[] = [
  "tool_call",
  "mode_dispatch",
  "agent_dispatch",
  "memory_access",
];

/**
 * Derives the dispatch/tool/memory streams from `operations.jsonl` IF the
 * journal carries matching event types. The reference journal records coarse
 * operation entries (deploy, infra_fix, …) and emits none of these today, so
 * each advertises `available:false` with a reason — declared + inactive by
 * design. Activates automatically the day the host journals matching events.
 */
export class JournalTelemetryProducer implements TelemetryProvider {
  private readonly journalPath: string;
  private readonly schemaVersion: string;

  constructor(cfg: JournalProducerConfig = {}) {
    this.journalPath = expandHome(
      cfg.journalPath ?? join(homedir(), ".claudeclaw", "journal", "operations.jsonl"),
    );
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private readAll(): Array<Record<string, unknown>> {
    if (!existsSync(this.journalPath)) return [];
    let content: string;
    try {
      content = readFileSync(this.journalPath, "utf8");
    } catch {
      return [];
    }
    const out: Array<Record<string, unknown>> = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === "object" && obj !== null) out.push(obj as Record<string, unknown>);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Map one journal entry to a sample for `stream`, or null if it doesn't match. */
  private toSample(stream: TelemetryStream, e: Record<string, unknown>): MetricSample | null {
    const type = String(e.type ?? "");
    const tsRaw = e.ts as string | number | undefined;
    const ts = tsRaw ? new Date(tsRaw) : new Date();
    if (Number.isNaN(ts.getTime())) return null;
    const truthy = (v: unknown) => v === true;

    switch (stream) {
      case "tool_call": {
        if (type !== "tool_call" && type !== "mcp_tool_call" && e.tool === undefined) return null;
        const failed = e.success === false || e.ok === false || truthy(e.blocked);
        return {
          ts,
          value: failed ? 1 : 0,
          labels: {
            server: String(e.server ?? ""),
            tool: String(e.tool ?? ""),
            blocked: String(truthy(e.blocked)),
          },
        };
      }
      case "mode_dispatch": {
        if (type !== "mode_dispatch" && type !== "mode_dispatched") return null;
        return {
          ts,
          value: truthy(e.reclassified) ? 1 : 0,
          labels: {
            mode: String(e.mode ?? ""),
            keyword: String(e.keyword ?? ""),
            task_class: String(e.task_class ?? ""),
          },
        };
      }
      case "agent_dispatch": {
        if (type !== "agent_dispatch" && type !== "agent_dispatched") return null;
        return {
          ts,
          value: truthy(e.reclassified) ? 1 : 0,
          labels: { agent: String(e.agent ?? e.agent_name ?? "") },
        };
      }
      case "memory_access": {
        if (type !== "memory_access" && type !== "memory_read") return null;
        return { ts, value: 1, labels: { file: String(e.file ?? e.path ?? "") } };
      }
      default:
        return null;
    }
  }

  capabilities(): TelemetryCapability[] {
    const all = this.readAll();
    return JOURNAL_STREAMS.map((stream) => {
      const has = all.some((e) => this.toSample(stream, e) !== null);
      if (has) return { stream, schemaVersion: this.schemaVersion, available: true };
      return {
        stream,
        schemaVersion: this.schemaVersion,
        available: false,
        reason: existsSync(this.journalPath)
          ? `no '${stream}' events in ${this.journalPath}`
          : `operations journal not found at ${this.journalPath}`,
      };
    });
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (!JOURNAL_STREAMS.includes(stream)) return [];
    const out: MetricSample[] = [];
    for (const e of this.readAll()) {
      const s = this.toSample(stream, e);
      if (s && inRange(s.ts, range)) out.push(s);
    }
    return out;
  }
}

// ── mode_dispatch ────────────────────────────────────────────────────────────

export interface ModeDispatchProducerConfig {
  /** Dispatch journal. Default ~/.claudeclaw/journal/mode_dispatch.jsonl. */
  journalPath?: string;
  schemaVersion?: string;
}

interface ModeDispatchEntry {
  ts: Date;
  mode: string;
  matchedKeyword: string;
  reclassified: boolean;
}

/**
 * Emits `mode_dispatch` from the dedicated dispatch journal written by the
 * daemon's `recordModeDispatch` (`src/governance/mode-dispatch-journal.ts`) —
 * one `{ ts, mode, matched_keyword, reclassified }` line per agentic-mode route.
 * value = `reclassified ? 1 : 0`, matching ModelRoutingSubject's
 * `routing_reclassify_rate = nonzeroRate`; mode + matched_keyword ride in labels.
 *
 * Inactive-with-reason until the daemon writes its first dispatch (no faked
 * data). `JournalTelemetryProducer` still advertises mode_dispatch off the
 * coarse operations journal as a forward-compat fallback, but the live source is
 * disjoint (this dedicated file), so the composite never double-counts.
 */
export class ModeDispatchTelemetryProducer implements TelemetryProvider {
  private readonly journalPath: string;
  private readonly schemaVersion: string;

  constructor(cfg: ModeDispatchProducerConfig = {}) {
    this.journalPath = expandHome(cfg.journalPath ?? DEFAULT_MODE_DISPATCH_LOG);
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private read(): ModeDispatchEntry[] {
    if (!existsSync(this.journalPath)) return [];
    let content: string;
    try {
      content = readFileSync(this.journalPath, "utf8");
    } catch {
      return [];
    }
    const out: ModeDispatchEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null) continue;
        const tsRaw = obj.ts as string | number | undefined;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        if (Number.isNaN(ts.getTime())) continue;
        out.push({
          ts,
          mode: String(obj.mode ?? ""),
          matchedKeyword: String(obj.matched_keyword ?? ""),
          reclassified: obj.reclassified === true,
        });
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }

  capabilities(): TelemetryCapability[] {
    if (this.read().length === 0) {
      return [
        {
          stream: "mode_dispatch",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: existsSync(this.journalPath)
            ? `no dispatch records in ${this.journalPath}`
            : `dispatch journal not found at ${this.journalPath} (no agentic-mode route emitted yet)`,
        },
      ];
    }
    return [{ stream: "mode_dispatch", schemaVersion: this.schemaVersion, available: true }];
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (stream !== "mode_dispatch") return [];
    return this.read()
      .filter((e) => inRange(e.ts, range))
      .map((e) => ({
        ts: e.ts,
        value: e.reclassified ? 1 : 0,
        labels: { mode: e.mode, matched_keyword: e.matchedKeyword },
      }));
  }
}

// ── template_feedback ────────────────────────────────────────────────────────

export interface TemplateFeedbackProducerConfig {
  /** Feedback log. Default ~/.config/tuner/template_feedback.jsonl. */
  feedbackLog?: string;
  schemaVersion?: string;
}

interface TemplateFeedbackEntry {
  ts: Date;
  templateId: string;
  rating: number;
  verdict: string;
}

/**
 * Emits `template_feedback` from `~/.config/tuner/template_feedback.jsonl`
 * (written by `tuner rate-template`). value = rating (1..5); template_id +
 * verdict ride in labels. Matches PromptTemplateSubject's
 * `template_avg_rating = median(values)` (higher_is_better).
 *
 * Starts inactive-with-reason (the log doesn't exist until the first rating) and
 * activates on first `rate-template` — empty is correct, not faked.
 */
export class TemplateFeedbackTelemetryProducer implements TelemetryProvider {
  private readonly feedbackLog: string;
  private readonly schemaVersion: string;

  constructor(cfg: TemplateFeedbackProducerConfig = {}) {
    this.feedbackLog = expandHome(cfg.feedbackLog ?? DEFAULT_TEMPLATE_FEEDBACK_LOG);
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  private read(): TemplateFeedbackEntry[] {
    if (!existsSync(this.feedbackLog)) return [];
    let content: string;
    try {
      content = readFileSync(this.feedbackLog, "utf8");
    } catch {
      return [];
    }
    const out: TemplateFeedbackEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null) continue;
        const templateId = String(obj.template_id ?? "");
        if (!templateId) continue;
        const rating = Number(obj.rating);
        if (Number.isNaN(rating)) continue;
        const tsRaw = obj.ts as string | number | undefined;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        if (Number.isNaN(ts.getTime())) continue;
        out.push({ ts, templateId, rating, verdict: String(obj.verdict ?? "") });
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }

  capabilities(): TelemetryCapability[] {
    if (this.read().length === 0) {
      return [
        {
          stream: "template_feedback",
          schemaVersion: this.schemaVersion,
          available: false,
          reason: existsSync(this.feedbackLog)
            ? `no ratings in ${this.feedbackLog}`
            : `no ratings yet at ${this.feedbackLog} (run 'tuner rate-template <id> <yes|yes-but|no>')`,
        },
      ];
    }
    return [{ stream: "template_feedback", schemaVersion: this.schemaVersion, available: true }];
  }

  async query(stream: TelemetryStream, range: DateRange): Promise<MetricSample[]> {
    if (stream !== "template_feedback") return [];
    return this.read()
      .filter((e) => inRange(e.ts, range))
      .map((e) => ({
        ts: e.ts,
        value: e.rating,
        labels: { template_id: e.templateId, verdict: e.verdict },
      }));
  }
}

// ── composite ────────────────────────────────────────────────────────────────

/**
 * Composes per-stream producers into one `TelemetryProvider`. `query` simply
 * concatenates (each producer returns `[]` for streams it doesn't own).
 * `capabilities` resolves to one entry per contract stream, preferring an
 * available producer; streams no producer claims are reported unavailable.
 *
 * Provider order matters for the unavailable-reason chosen: list the specific
 * producers BEFORE the cost provider (which reports every non-cost stream with
 * a generic placeholder reason) so the specific reason wins.
 */
export class CompositeTelemetryProvider implements TelemetryProvider, ViewManifestSource {
  constructor(private readonly providers: TelemetryProvider[]) {}

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  capabilities(): TelemetryCapability[] {
    const caps: TelemetryCapability[] = [];
    for (const p of this.providers) caps.push(...p.capabilities());
    const best = new Map<TelemetryStream, TelemetryCapability>();
    for (const c of caps) {
      const cur = best.get(c.stream);
      // First writer wins; an available producer upgrades a prior unavailable.
      if (!cur) best.set(c.stream, c);
      else if (!cur.available && c.available) best.set(c.stream, c);
    }
    for (const s of TELEMETRY_STREAMS) {
      if (!best.has(s)) {
        best.set(s, {
          stream: s,
          schemaVersion: TELEMETRY_CONTRACT_VERSION,
          available: false,
          reason: "no producer wired for this stream",
        });
      }
    }
    return [...best.values()];
  }

  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    const out: MetricSample[] = [];
    for (const p of this.providers) {
      out.push(...(await p.query(stream, range, filters)));
    }
    return out;
  }

  // ── ViewManifestSource ────────────────────────────────────────────────────
  // Collect every plugin-declared page; dispatch a panel fill to the provider
  // that declared it. Plugins without a manifest contribute nothing here — they
  // get the universal page only.

  viewManifests(): ViewManifest[] {
    const out: ViewManifest[] = [];
    for (const p of this.providers) {
      const m = p.viewManifest?.();
      if (m) out.push(m);
    }
    return out;
  }

  async panelData(
    plugin: string,
    panelId: string,
    range: DateRange,
  ): Promise<PanelData | undefined> {
    for (const p of this.providers) {
      if (p.viewManifest?.()?.plugin !== plugin) continue;
      const d = await p.viewData?.(panelId, range);
      if (d) return d;
    }
    return undefined;
  }
}

import { MemorySignalProducer } from "./memory-signal-provider.js";

export interface HostTelemetryConfig {
  /** Path to the memory-signal sampler history; when set, wires the `memory_signal` stream. */
  memorySignalHistoryPath?: string;
  costDbPath?: string;
  hooksDir?: string;
  skillAccessLog?: string;
  journalPath?: string;
  /** Dedicated mode_dispatch journal. Default ~/.claudeclaw/journal/mode_dispatch.jsonl. */
  modeDispatchLog?: string;
  /** Template-rating log. Default ~/.config/tuner/template_feedback.jsonl. */
  templateFeedbackLog?: string;
  cronJournalRunner?: (args: string[]) => string;
  /** Session-transcript root for the universal producer. Default `~/.claude/projects`. */
  sessionProjectsDir?: string;
  /** Hermeticity escape hatch (tests): override the cron-config presence probe. */
  cronConfigProbe?: () => CronConfigPresence;
  /**
   * Phase A observability hub: path to the gateway's `mcp.tool_call` audit log.
   * When set, the universal MCP boundary stream becomes queryable; when absent
   * the composite advertises it unavailable (no producer wired).
   */
  mcpToolCallLog?: string;
  /**
   * Phase A observability hub: when set, the tuner declares its view-manifest
   * (the proposals→outcomes timeline). When absent, the tuner contributes no
   * specialized page and falls back to the universal page like any plugin.
   */
  tunerView?: TunerViewSources;
}

/**
 * The reference-host telemetry surface: every feasible producer composed into
 * one provider. Pass into `registerWisecronSubjects(registry, settings,
 * { telemetry })` so the activation gate runs and subjects measure fitness.
 *
 * `SessionJsonlTelemetryProducer` is the UNIVERSAL source for the dispatch/tool/
 * memory streams (real, abundant data on any Claude Code host). It is listed
 * before `JournalTelemetryProducer` so its available capabilities win the
 * per-stream merge; the journal producer stays wired only as a forward-compat
 * fallback for the day `operations.jsonl` carries matching events (it returns
 * `[]` for these streams on the reference host, so no double-counting).
 * `CronRunTelemetryProducer` auto-detects its source (systemd → bus-scheduler →
 * none) from `costDbPath`, so a host with no wisecron units still lights up.
 *
 * `ModeDispatchTelemetryProducer` owns `mode_dispatch` off the dedicated dispatch
 * journal the daemon writes (`recordModeDispatch`); it is listed before the
 * journal producer so its capability wins the merge. The two sources are
 * disjoint (dedicated file vs operations-journal event type), so the composite
 * never double-counts that stream either.
 */
export function buildHostTelemetryProvider(
  cfg: HostTelemetryConfig = {},
): CompositeTelemetryProvider {
  const providers: TelemetryProvider[] = [
    new CronRunTelemetryProducer({
      journalRunner: cfg.cronJournalRunner,
      costDbPath: cfg.costDbPath,
      cronConfigProbe: cfg.cronConfigProbe,
    }),
    new HookExecTelemetryProducer({ hooksDir: cfg.hooksDir }),
    new SkillAccessTelemetryProducer({ accessLog: cfg.skillAccessLog }),
    new ModeDispatchTelemetryProducer({ journalPath: cfg.modeDispatchLog }),
    new TemplateFeedbackTelemetryProducer({ feedbackLog: cfg.templateFeedbackLog }),
    new SessionJsonlTelemetryProducer({ projectsDir: cfg.sessionProjectsDir }),
    new JournalTelemetryProducer({ journalPath: cfg.journalPath }),
    new SessionCostTelemetryProvider({ dbPath: cfg.costDbPath }),
  ];
  // Phase A: universal MCP boundary stream — wired only when the gateway log is
  // configured, so existing capability tests (every stream unavailable on an
  // empty host) stay deterministic and machine-state-independent.
  if (cfg.memorySignalHistoryPath) {
    providers.push(new MemorySignalProducer({ historyPath: cfg.memorySignalHistoryPath }));
  }
  if (cfg.mcpToolCallLog) {
    providers.push(new McpToolCallTelemetryProducer({ logPath: cfg.mcpToolCallLog }));
  }
  // Phase A: the tuner declares its own page (proposals→outcomes timeline).
  if (cfg.tunerView) {
    providers.push(new TunerViewProvider(cfg.tunerView));
  }
  return new CompositeTelemetryProvider(providers);
}
