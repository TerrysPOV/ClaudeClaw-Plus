/**
 * Stall Watchdog — liveness guard for long-lived bus PTY sessions.
 *
 * A persistent session (main Discord, or a named agent like `reg`/`suzy`) drives
 * a SINGLE-THREADED event loop. If a tool call never returns — e.g. a `Bash`
 * call whose `&`-backgrounded children hold the shell's output stream open — the
 * loop blocks forever and the session ignores ALL subsequent messages (the
 * 2026-07-02 ~11h outage, #295).
 *
 * This watchdog observes the bus event stream (the JSONL tailer already emits
 * `response.tool_use` / `tool_result` per session), tracks outstanding tool
 * calls, and on a periodic sweep declares a STALL when a tool has been
 * outstanding past its per-tool ceiling. Recovery reuses `SessionManager.restart`
 * (via the injected `restart` dep) so it inherits the kill+respawn + rate-limiter.
 *
 * The kill-vs-legit-long-tool call is made by the tool's OWN bound (per-tool
 * ceilings), never by silence (silence is identical for both). Every kill is
 * audited by the auto-discovery forensic (see `stall-forensics.ts`): a kill that
 * looks like a false positive flags the operator with a suggestion to raise the
 * exact ceiling — so conservative defaults self-correct instead of silently
 * harming.  SPEC: `.planning/stall-watchdog/SPEC.md`.
 */

import type { BusEvent } from "./types";

/* ── Config ──────────────────────────────────────────────────────────────── */

export interface ToolCeiling {
  /** Seconds a tool may be outstanding before a warn (ping only). */
  warnSeconds: number;
  /** Seconds a tool may be outstanding before kill + respawn. */
  killSeconds: number;
}

export interface StallCeilings {
  /** `Read`/`Edit`/`Grep`/… — near-instant tools. */
  fast: ToolCeiling;
  /** `Bash` — its 10-min max + grace. */
  bash: ToolCeiling;
  /**
   * Agent-dispatch (`Task`/`Agent`) — a sub-agent legitimately runs many
   * minutes (deep research, migrations). Generous ceiling ~ the `claude -p`
   * 60-min cap from the #295 incident, so a real long job isn't killed. This is
   * also the class PR#3's first-class agent-job primitive will map onto.
   */
  task: ToolCeiling;
  /** MCP tools (`mcp__…`) — workflow/research tools can run minutes. */
  mcp: ToolCeiling;
  /** Truly unknown tools. */
  default: ToolCeiling;
}

export interface StallWatchdogConfig {
  enabled: boolean;
  /** How often the sweep runs. */
  sweepIntervalMs: number;
  ceilings: StallCeilings;
  /** `restart` = kill+respawn on kill; `warn` = never kill, only flag. */
  action: "restart" | "warn";
  autoDiscovery: {
    enabled: boolean;
    /** Window for the CPU-liveness probe sampled just before kill. */
    cpuProbeMs: number;
  };
  /** After a failed restart, suppress re-kill + re-notify of the same session
   *  for this many ms (bounds the alert storm from an unrecoverable wedge). */
  restartFailureCooldownMs: number;
}

export const DEFAULT_STALL_CONFIG: StallWatchdogConfig = {
  enabled: true,
  sweepIntervalMs: 30_000,
  ceilings: {
    fast: { warnSeconds: 60, killSeconds: 120 },
    bash: { warnSeconds: 300, killSeconds: 900 },
    task: { warnSeconds: 1800, killSeconds: 3600 },
    mcp: { warnSeconds: 600, killSeconds: 1800 },
    default: { warnSeconds: 300, killSeconds: 900 },
  },
  action: "restart",
  autoDiscovery: { enabled: true, cpuProbeMs: 1000 },
  /** After a restart FAILS (e.g. rate-limiter exhausted), don't re-kill /
   *  re-notify the same session for this long — bounds the critical-alert
   *  storm a truly unrecoverable wedge would otherwise produce every sweep. */
  restartFailureCooldownMs: 300_000,
};

/** Tools that should return in ms–seconds; anything slow is suspicious fast. */
const FAST_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Grep",
  "Glob",
  "LS",
  "NotebookEdit",
]);

/** Agent-dispatch tools that spawn a sub-agent (legitimately long-running). */
const TASK_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/** Map a `tool_use` name to its ceiling class. */
export function classifyTool(name: string): keyof StallCeilings {
  if (name === "Bash") return "bash";
  if (FAST_TOOLS.has(name)) return "fast";
  if (TASK_TOOLS.has(name)) return "task";
  if (name.startsWith("mcp__")) return "mcp";
  return "default";
}

export function ceilingFor(name: string, ceilings: StallCeilings): ToolCeiling {
  return ceilings[classifyTool(name)];
}

/* ── Config parsing (mirror of `parseWatchdogConfig`) ────────────────────── */

function posNum(v: unknown, fallback: number, min: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;
}

function parseCeiling(raw: unknown, d: ToolCeiling): ToolCeiling {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    warnSeconds: posNum(r.warnSeconds, d.warnSeconds, 1),
    killSeconds: posNum(r.killSeconds, d.killSeconds, 1),
  };
}

/**
 * Validate a raw settings value into a `StallWatchdogConfig`. Unknown keys are
 * ignored; each invalid/missing field falls back to `DEFAULT_STALL_CONFIG`.
 */
export function parseStallWatchdogConfig(raw: unknown): StallWatchdogConfig {
  const d = DEFAULT_STALL_CONFIG;
  if (!raw || typeof raw !== "object") return structuredClone(d);
  const r = raw as Record<string, unknown>;
  const rc = (r.ceilings ?? {}) as Record<string, unknown>;
  const ad = (r.autoDiscovery ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    sweepIntervalMs: posNum(r.sweepIntervalMs, d.sweepIntervalMs, 1000),
    ceilings: {
      fast: parseCeiling(rc.fast, d.ceilings.fast),
      bash: parseCeiling(rc.bash, d.ceilings.bash),
      task: parseCeiling(rc.task, d.ceilings.task),
      mcp: parseCeiling(rc.mcp, d.ceilings.mcp),
      default: parseCeiling(rc.default, d.ceilings.default),
    },
    action: r.action === "warn" || r.action === "restart" ? r.action : d.action,
    autoDiscovery: {
      enabled: typeof ad.enabled === "boolean" ? ad.enabled : d.autoDiscovery.enabled,
      cpuProbeMs: posNum(ad.cpuProbeMs, d.autoDiscovery.cpuProbeMs, 100),
    },
    restartFailureCooldownMs: posNum(r.restartFailureCooldownMs, d.restartFailureCooldownMs, 0),
  };
}

/* ── Per-session state + decision ────────────────────────────────────────── */

interface OutstandingTool {
  id: string;
  name: string;
  startedAt: number;
  /** True once a `warn` has been emitted, so we don't ping every sweep. */
  warned: boolean;
}

export interface SessionStallState {
  agentId: string;
  sessionId: string;
  /** tool_use_id → outstanding tool call awaiting its result. */
  outstanding: Map<string, OutstandingTool>;
  /** ts of the most recent event of any kind (telemetry / forensic aid). */
  lastActivityAt: number;
  /** When a restart last FAILED for this session; gates re-kill/re-notify for
   *  `restartFailureCooldownMs` so an unrecoverable wedge can't alert-storm. */
  restartFailedAt?: number;
}

export function newSessionState(
  agentId: string,
  sessionId: string,
  now: number,
): SessionStallState {
  return { agentId, sessionId, outstanding: new Map(), lastActivityAt: now };
}

export type StallDecision =
  | { action: "none" }
  | {
      action: "warn" | "kill";
      tool: string;
      toolUseId: string;
      outstandingMs: number;
      ceiling: ToolCeiling;
    };

const rank = (a: StallDecision["action"]): number => (a === "kill" ? 2 : a === "warn" ? 1 : 0);

/**
 * Pure: given a session's outstanding tool calls and the clock, decide whether
 * any tool has breached its per-tool ceiling. Picks the most severe (kill > warn)
 * and, among equals, the longest-outstanding. Silence is NOT the signal — the
 * tool's own bound is.
 */
export function evaluateStall(
  state: SessionStallState,
  now: number,
  ceilings: StallCeilings,
): StallDecision {
  let worst: StallDecision = { action: "none" };
  let worstAge = -1;

  for (const t of state.outstanding.values()) {
    const age = now - t.startedAt;
    const c = ceilingFor(t.name, ceilings);
    let action: "none" | "warn" | "kill" = "none";
    if (age >= c.killSeconds * 1000) action = "kill";
    else if (age >= c.warnSeconds * 1000) action = "warn";
    if (action === "none") continue;

    if (
      rank(action) > rank(worst.action) ||
      (rank(action) === rank(worst.action) && age > worstAge)
    ) {
      worst = { action, tool: t.name, toolUseId: t.id, outstandingMs: age, ceiling: c };
      worstAge = age;
    }
  }
  return worst;
}

/* ── Dependencies (injected — mirrors RotateAgentDeps) ───────────────────── */

export interface ForensicSnapshot {
  cpuAdvancing: boolean | null;
  outputRecencyMs: number | null;
}

export interface StallKillOutcome {
  classification: "genuine_wedge" | "suspected_false_positive" | "unknown";
  suggestedKillSeconds?: number;
}

export interface StallWatchdogDeps {
  /** Subscribe to the bus event stream; returns an unsubscribe fn. */
  subscribe(handler: (e: BusEvent) => void): () => void;
  /** Kill + respawn the session. Reuses SessionManager.restart. */
  restart(agentId: string, opts: { reason: string; forensic?: unknown }): Promise<void>;
  /** Best-effort liveness snapshot taken immediately BEFORE restart. */
  captureForensic(agentId: string): Promise<ForensicSnapshot>;
  /** Classify the kill from the snapshot + audit it to stall-kills.jsonl. */
  recordKill(input: {
    agentId: string;
    sessionId: string;
    tool: string;
    outstandingMs: number;
    ceiling: ToolCeiling;
    snapshot: ForensicSnapshot;
  }): Promise<StallKillOutcome>;
  /** Surface a warn / false-positive flag to the operator (Discord/critical log). */
  notify(level: "warn" | "critical", message: string): void;
  /** Clock seam (tests inject a deterministic clock). */
  now(): number;
}

/* ── The watchdog ────────────────────────────────────────────────────────── */

export class StallWatchdog {
  private readonly sessions = new Map<string, SessionStallState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Sessions with a kill in flight — never double-restart the same one. */
  private readonly killing = new Set<string>();

  constructor(
    private readonly config: StallWatchdogConfig,
    private readonly deps: StallWatchdogDeps,
  ) {}

  private key(agentId: string, sessionId: string): string {
    // Space delimiter (agent ids + session ids never contain spaces). NB: the
    // original used a literal NUL here, which made git flag this whole file
    // binary (`Binary files differ` / 0+0- in the PR diff) — see review note.
    return `${agentId} ${sessionId}`;
  }

  /** Feed one bus event into the per-session tracking. Idempotent + cheap. */
  ingest(e: BusEvent): void {
    const k = this.key(e.agent_id, e.session_id);
    let s = this.sessions.get(k);
    if (!s) {
      s = newSessionState(e.agent_id, e.session_id, e.ts);
      this.sessions.set(k, s);
    }
    if (e.ts > s.lastActivityAt) s.lastActivityAt = e.ts;

    switch (e.topic) {
      case "response.tool_use": {
        const p = e.payload as { id?: string; name?: string };
        if (p?.id && p?.name) {
          s.outstanding.set(p.id, { id: p.id, name: p.name, startedAt: e.ts, warned: false });
        }
        break;
      }
      case "tool_result": {
        const p = e.payload as { tool_use_id?: string };
        if (p?.tool_use_id) s.outstanding.delete(p.tool_use_id);
        break;
      }
      // A completed turn or ended session means nothing is legitimately in flight.
      case "response.turn_end":
      case "session.end":
        s.outstanding.clear();
        break;
      case "session.init":
        s.outstanding.clear();
        break;
    }
  }

  /** Evaluate every tracked session once. Exposed for deterministic tests. */
  async sweep(now: number = this.deps.now()): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      const decision = evaluateStall(s, now, this.config.ceilings);
      if (decision.action === "none") continue;

      if (decision.action === "warn") {
        const t = s.outstanding.get(decision.toolUseId);
        if (t && !t.warned) {
          t.warned = true;
          this.deps.notify(
            "warn",
            `Session ${s.agentId} has had \`${decision.tool}\` outstanding for ` +
              `${Math.round(decision.outstandingMs / 1000)}s (warn ${decision.ceiling.warnSeconds}s / ` +
              `kill ${decision.ceiling.killSeconds}s).`,
          );
        }
        continue;
      }

      // kill
      if (this.config.action === "warn") {
        // warn-only mode: flag at the kill ceiling but never restart.
        const t = s.outstanding.get(decision.toolUseId);
        if (t && !t.warned) {
          t.warned = true;
          this.deps.notify(
            "critical",
            `Session ${s.agentId} \`${decision.tool}\` outstanding ` +
              `${Math.round(decision.outstandingMs / 1000)}s — past kill ceiling ` +
              `(${decision.ceiling.killSeconds}s) but stallWatchdog.action=warn, NOT restarting.`,
          );
        }
        continue;
      }
      const k = this.key(s.agentId, s.sessionId);
      if (this.killing.has(k)) continue;
      // A restart that recently FAILED (e.g. rate-limiter exhausted) must not be
      // retried — nor re-alerted — every sweep. Back off for the cooldown; after
      // it elapses we try again (the restart window may have reopened).
      if (
        s.restartFailedAt !== undefined &&
        now - s.restartFailedAt < this.config.restartFailureCooldownMs
      ) {
        continue;
      }
      this.killing.add(k);
      kills.push(this.handleKill(s, decision, now).finally(() => this.killing.delete(k)));
    }
    // Await in-flight kills so sweeps never overlap on the same session and
    // tests observe the full capture→restart→classify sequence.
    await Promise.all(kills);
  }

  /** capture forensic → restart → classify+audit → flag false positives. */
  private async handleKill(
    s: SessionStallState,
    decision: Extract<StallDecision, { action: "kill" }>,
    now: number,
  ): Promise<void> {
    let snapshot: ForensicSnapshot = { cpuAdvancing: null, outputRecencyMs: null };
    if (this.config.autoDiscovery.enabled) {
      try {
        snapshot = await this.deps.captureForensic(s.agentId);
      } catch {
        /* forensic is best-effort — never block recovery */
      }
    }

    try {
      await this.deps.restart(s.agentId, {
        reason: "stall",
        forensic: { tool: decision.tool, outstandingMs: decision.outstandingMs, snapshot },
      });
    } catch (err) {
      // Stamp the failure so the next sweeps back off (see cooldown gate) —
      // otherwise an unrecoverable wedge re-notifies critical every sweep.
      s.restartFailedAt = now;
      this.deps.notify(
        "critical",
        `Stall-kill of ${s.agentId} FAILED to restart: ${err instanceof Error ? err.message : String(err)}. ` +
          `Backing off ${Math.round(this.config.restartFailureCooldownMs / 1000)}s before retry.`,
      );
      return;
    }

    // The killed session's tracking is stale — drop it; a fresh session.init rebuilds it.
    this.sessions.delete(this.key(s.agentId, s.sessionId));

    let outcome: StallKillOutcome = { classification: "unknown" };
    if (this.config.autoDiscovery.enabled) {
      try {
        outcome = await this.deps.recordKill({
          agentId: s.agentId,
          sessionId: s.sessionId,
          tool: decision.tool,
          outstandingMs: decision.outstandingMs,
          ceiling: decision.ceiling,
          snapshot,
        });
      } catch {
        /* audit is best-effort */
      }
    }

    if (outcome.classification === "suspected_false_positive") {
      const cls = classifyTool(decision.tool);
      this.deps.notify(
        "critical",
        `⚠️ Stall-killed ${s.agentId} on \`${decision.tool}\` after ` +
          `${Math.round(decision.outstandingMs / 1000)}s, but it looked ALIVE ` +
          `(cpuAdvancing=${snapshot.cpuAdvancing}, outputRecencyMs=${snapshot.outputRecencyMs}). ` +
          `If this tool legitimately runs that long, raise \`stallWatchdog.ceilings.${cls}.killSeconds\`` +
          (outcome.suggestedKillSeconds ? ` (suggest ~${outcome.suggestedKillSeconds}s).` : `.`),
      );
    } else {
      this.deps.notify(
        "warn",
        `Stall-killed ${s.agentId} on \`${decision.tool}\` after ` +
          `${Math.round(decision.outstandingMs / 1000)}s (genuine wedge — session respawned).`,
      );
    }
  }

  /** Begin observing + sweeping. No-op when disabled. */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.unsubscribe = this.deps.subscribe((e) => this.ingest(e));
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.config.sweepIntervalMs);
    // Don't keep the event loop alive solely for the sweep.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sessions.clear();
  }
}
