/**
 * Session-transcript TelemetryProvider — the UNIVERSAL host producer
 * (OutcomeLoop Phase B, real-data wiring).
 *
 * Earlier producers pointed at idealized sources that don't exist on most
 * machines (`wisecron-*` units, specific `operations.jsonl` event shapes). The
 * abundant, universal source is the Claude Code session transcript:
 * `~/.claude/projects/<enc-cwd>/<session-id>.jsonl`. Every session carries
 * `tool_use` blocks, subagent (`Agent`/`Task`) dispatches and file reads. This
 * producer reads those transcripts and derives the dispatch/tool/memory streams
 * the subjects consume — behind the same `TelemetryProvider` contract, so the
 * tuner still only sees `query(...)`.
 *
 * Parser reuse: this does NOT define a new JSONL schema parser. It consumes the
 * Bus's authoritative line-type union + helpers (`src/bus/jsonl-line-types.ts`)
 * — `JsonlLine`, `AssistantLine`/`UserLine`, the `tool_use` content-block shape,
 * and `extractToolResults`. Bumping a line shape there is the single place that
 * owns it (see that file's `SCHEMA_VERSION` note).
 *
 * Provenance, per stream:
 *  - `tool_call`     ← assistant `tool_use` blocks. value = 1 if the matching
 *                      `tool_result` (joined by `tool_use_id`) is `is_error`,
 *                      else 0 — matches the host contract consumed by
 *                      McpPluginSubject (`mcp_tool_failure_rate = nonzeroRate`).
 *                      labels = { tool, server (mcp__<server>__ prefix or ""),
 *                      blocked:"false" — transcripts don't record a block flag }.
 *  - `agent_dispatch`← `Agent`/`Task` `tool_use` blocks. labels.agent =
 *                      input.subagent_type (or "default"). value = 0: a transcript
 *                      records that a subagent was dispatched, NOT whether the
 *                      router *reclassified* it (the metric AgentSubject computes).
 *                      So the stream activates with a real dispatch count and an
 *                      honest reclassify_rate of 0 — never a fabricated nonzero.
 *  - `memory_access` ← `Read` `tool_use` whose file_path is a CLAUDE.md file or
 *                      lives under a memory/learnings dir. value = 1 per read;
 *                      labels.file = the path (MemorySubject groups per file).
 *  - `mode_dispatch` ← NOT derivable: routing-mode dispatch is a ClaudeClaw
 *                      orchestration concept, not recorded in the transcript.
 *                      Advertised available:false with a reason — no faked data.
 *
 * Every query returns `[]` (never throws) for a stream it does not own and when
 * the projects dir is absent.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLineSync } from "./line-reader.js";
import {
  type AssistantLine,
  type AssistantToolUseBlock,
  type JsonlLine,
  type UserLine,
  extractToolResults,
} from "../../bus/jsonl-line-types.js";
import {
  type DateRange,
  type MetricSample,
  type TelemetryCapability,
  type TelemetryProvider,
  type TelemetryStream,
  TELEMETRY_CONTRACT_VERSION,
} from "../../skills-tuner/core/telemetry.js";
import { AGENT_SESSION_DIRS_FILTER_KEY } from "../../skills-tuner/core/scope.js";

/** Streams this producer owns (active + the inactive-by-design mode_dispatch). */
const OWNED_STREAMS: TelemetryStream[] = [
  "tool_call",
  "agent_dispatch",
  "memory_access",
  "mode_dispatch",
];
/** Subset this producer can actually populate from a transcript. */
const ACTIVE_STREAMS = ["tool_call", "agent_dispatch", "memory_access"] as const;
type ActiveStream = (typeof ACTIVE_STREAMS)[number];

/** Tool names that are a subagent dispatch (harness-dependent: `Agent` here, `Task` upstream). */
const AGENT_DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/** A Read is a memory access when its path is a CLAUDE.md file or under a memory/learnings dir. */
const MEMORY_PATH_RE = /(?:CLAUDE\.md$|\/memory\/|\/learnings\/|session-state\.md$)/;

/**
 * Cap the number of transcripts scanned per call. A busy host accumulates
 * thousands of session files; reading every one on the cold `capabilities()`
 * path is a synchronous event-loop stall / memory risk on a 4GB box. We scan the
 * newest N by mtime (older files hold older events, already down-weighted by
 * every metric's window) and `log()` when the cap truncates so the limit isn't
 * silent.
 */
const MAX_FILES_PER_SCAN = 200;

export interface SessionJsonlProducerConfig {
  /** Projects dir root. Default `~/.claude/projects`. Tests pass a temp dir. */
  projectsDir?: string;
  schemaVersion?: string;
}

interface Collected {
  tool_call: MetricSample[];
  agent_dispatch: MetricSample[];
  memory_access: MetricSample[];
}

function emptyCollected(): Collected {
  return { tool_call: [], agent_dispatch: [], memory_access: [] };
}

/** Parse `mcp__<server>__<tool>` → server; non-MCP tools have no server. */
function serverOf(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return "";
  return toolName.split("__")[1] ?? "";
}

export class SessionJsonlTelemetryProducer implements TelemetryProvider {
  private readonly projectsDir: string;
  private readonly schemaVersion: string;
  /** Memo keyed by range so the 3 active streams don't each rescan 1000+ files. */
  private readonly memo = new Map<string, Collected>();

  constructor(cfg: SessionJsonlProducerConfig = {}) {
    this.projectsDir = cfg.projectsDir ?? join(homedir(), ".claude", "projects");
    this.schemaVersion = cfg.schemaVersion ?? TELEMETRY_CONTRACT_VERSION;
  }

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  /**
   * Enumerate `<projectsDir>/<enc-cwd>/<session>.jsonl` files. When
   * `allowedDirPrefixes` is supplied (agent scope), only project dirs whose name
   * starts with one of the prefixes are scanned — this is how an agent-scoped
   * query is bounded to agent sessions at the source.
   */
  private sessionFiles(allowedDirPrefixes?: string[]): string[] {
    if (!existsSync(this.projectsDir)) return [];
    const out: string[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(this.projectsDir);
    } catch {
      return [];
    }
    for (const d of dirs) {
      if (allowedDirPrefixes && !allowedDirPrefixes.some((p) => d.startsWith(p))) continue;
      const sub = join(this.projectsDir, d);
      let files: string[];
      try {
        if (!statSync(sub).isDirectory()) continue;
        files = readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(".jsonl")) out.push(join(sub, f));
      }
    }
    return out;
  }

  /** Derive all three active streams in a single pass over in-window sessions. */
  private collect(range: DateRange, allowedDirPrefixes?: string[]): Collected {
    const dirKey = allowedDirPrefixes ? allowedDirPrefixes.join(",") : "*";
    const key = `${range.start.getTime()}|${range.end.getTime()}|${dirKey}`;
    const cached = this.memo.get(key);
    if (cached) return cached;

    const acc = emptyCollected();
    const startMs = range.start.getTime();

    // Gather in-window candidates with their mtime in one stat pass. A file last
    // modified before the window starts cannot hold an in-range event (lines only
    // append), so drop it up front without reading.
    const candidates: Array<{ file: string; mtime: number }> = [];
    for (const file of this.sessionFiles(allowedDirPrefixes)) {
      try {
        const mtime = statSync(file).mtime.getTime();
        if (mtime < startMs) continue;
        candidates.push({ file, mtime });
      } catch {
        // unstattable file — skip
      }
    }

    // Bound the scan to the newest MAX_FILES_PER_SCAN by mtime so a host with
    // thousands of sessions can't stall the sync path / exhaust memory.
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > MAX_FILES_PER_SCAN) {
      // Not silent: surface that the scan was capped.
      console.warn(
        `[session-jsonl] scan capped at ${MAX_FILES_PER_SCAN} of ${candidates.length} ` +
          `in-window transcripts (newest by mtime) — older sessions skipped this call`,
      );
      candidates.length = MAX_FILES_PER_SCAN;
    }

    for (const { file } of candidates) {
      // Per-file tolerance mirrors the per-line JSON.parse skip: one unreadable
      // or malformed transcript must never take down the whole telemetry surface
      // (`capabilities()` is sync and feeds the activation gate).
      try {
        this.scanFile(file, range, acc);
      } catch {
        // skip a bad file
      }
    }

    // Keep the memo small (different subjects use 7d/1d windows).
    if (this.memo.size > 8) this.memo.clear();
    this.memo.set(key, acc);
    return acc;
  }

  private scanFile(file: string, range: DateRange, acc: Collected): void {
    // Single streaming pass (bounded memory — never slurps the whole file):
    //   - `errById` maps tool_use_id → is_error, populated from user
    //     `tool_result` blocks (which live in later user lines than the
    //     assistant `tool_use`), so the failure join needs the whole file first.
    //   - `pending` holds a COMPACT record per emitted tool_use (ts + the few
    //     fields that ride in labels), NOT the raw JSON line. Its size is the
    //     output size — inherently O(samples) — not O(file bytes).
    // After the stream we join `pending` against `errById` in encounter order,
    // producing byte-for-byte the same samples the old two-pass slurp did.
    const errById = new Map<string, boolean>();
    const pending: Array<{
      ts: Date;
      name: string;
      id: string;
      agent?: string;
      memFile?: string;
    }> = [];
    const startMs = range.start.getTime();
    const endMs = range.end.getTime();

    forEachLineSync(file, (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      let line: JsonlLine;
      try {
        line = JSON.parse(trimmed) as JsonlLine;
      } catch {
        return;
      }

      if (line.type === "user") {
        const results = extractToolResults((line as UserLine).message?.content);
        for (const r of results) {
          if (r.tool_use_id) errById.set(r.tool_use_id, r.is_error === true);
        }
        return;
      }
      if (line.type !== "assistant") return;

      const a = line as AssistantLine;
      const ts = a.timestamp ? new Date(a.timestamp) : null;
      if (!ts || Number.isNaN(ts.getTime())) return;
      if (ts.getTime() < startMs || ts.getTime() >= endMs) return;

      // `message.content` comes from an untrusted transcript; a non-array
      // (e.g. `{"message":{"content":{}}}`) would make `for...of` throw. Guard
      // so a malformed line contributes nothing instead of crashing the scan.
      const content = Array.isArray(a.message?.content) ? a.message.content : [];
      for (const block of content) {
        if (!block || (block as { type?: string }).type !== "tool_use") continue;
        const tu = block as AssistantToolUseBlock;
        const name = tu.name ?? "";
        const rec: { ts: Date; name: string; id: string; agent?: string; memFile?: string } = {
          ts,
          name,
          id: tu.id ?? "",
        };

        if (AGENT_DISPATCH_TOOLS.has(name)) {
          const input = (tu.input ?? {}) as Record<string, unknown>;
          rec.agent =
            typeof input.subagent_type === "string" && input.subagent_type
              ? input.subagent_type
              : "default";
        }
        if (name === "Read") {
          const input = (tu.input ?? {}) as Record<string, unknown>;
          const fp = typeof input.file_path === "string" ? input.file_path : "";
          if (fp && MEMORY_PATH_RE.test(fp)) rec.memFile = fp;
        }
        pending.push(rec);
      }
    });

    for (const p of pending) {
      const failed = p.id ? errById.get(p.id) === true : false;
      // tool_call — every tool_use is one call; value carries failure.
      acc.tool_call.push({
        ts: p.ts,
        value: failed ? 1 : 0,
        labels: { tool: p.name, server: serverOf(p.name), blocked: "false" },
      });
      // agent_dispatch — value = 0: dispatch occurred; reclassification is not a transcript event.
      if (p.agent !== undefined) {
        acc.agent_dispatch.push({ ts: p.ts, value: 0, labels: { agent: p.agent } });
      }
      // memory_access — Reads of CLAUDE.md / memory / learnings files.
      if (p.memFile !== undefined) {
        acc.memory_access.push({ ts: p.ts, value: 1, labels: { file: p.memFile } });
      }
    }
  }

  capabilities(): TelemetryCapability[] {
    // Probe a 30d lookback so a single quiet week doesn't flip a whole stream
    // off; availability answers "can this source emit here", while fitness still
    // measures over each metric's own (shorter) windowDays.
    const since = new Date(Date.now() - 30 * 86_400_000);
    const collected = this.collect({ start: since, end: new Date() });

    const dirNote = existsSync(this.projectsDir)
      ? `no matching events in ${this.projectsDir}/*/*.jsonl (last 30d)`
      : `projects dir not found at ${this.projectsDir}`;

    const caps: TelemetryCapability[] = ACTIVE_STREAMS.map((stream) => {
      const has = collected[stream].length > 0;
      if (has) return { stream, schemaVersion: this.schemaVersion, available: true };
      const what =
        stream === "tool_call"
          ? "tool_use blocks"
          : stream === "agent_dispatch"
            ? "Agent/Task dispatches"
            : "memory-file reads";
      return {
        stream,
        schemaVersion: this.schemaVersion,
        available: false,
        reason: `no ${what} — ${dirNote}`,
      };
    });

    // mode_dispatch: declared, inactive by design (not in the transcript).
    caps.push({
      stream: "mode_dispatch",
      schemaVersion: this.schemaVersion,
      available: false,
      reason:
        "routing-mode dispatch is a ClaudeClaw orchestration event, not recorded in session transcripts",
    });

    return caps;
  }

  async query(
    stream: TelemetryStream,
    range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    if (!OWNED_STREAMS.includes(stream)) return [];
    if (stream === "mode_dispatch") return []; // inactive by design
    // Agent scope hands us a comma-joined list of agent project-dir prefixes;
    // when present we only scan transcripts under those dirs.
    const raw = filters?.[AGENT_SESSION_DIRS_FILTER_KEY];
    const allowedDirPrefixes = raw ? raw.split(",").filter(Boolean) : undefined;
    return this.collect(range, allowedDirPrefixes)[stream as ActiveStream];
  }
}
