/**
 * ClaudeClaw+ Bus runtime — Schema-probe harness (spec §11.1).
 *
 * Validates Claude Code's JSONL schema + Channels behaviour against the
 * Bus parser's expectations. Runs on daemon startup (when `claude --version`
 * changes vs the cache) and on operator-forced re-probe.
 *
 * Empirical foundations:
 *  - Spike 0.2 — JSONL line shapes (user/assistant/usage/tool_use/tool_result)
 *  - Spike 0.4 — REPL needs PTY on stdin AND stdout (plain pipe downshifts)
 *  - Spike 0.5 — `/clear` rotates to a NEW JSONL; `/quit` emits exit envelope
 *  - Spike 0.6 — `-p` silently drops channel notifications → probe MUST use PTY
 *
 * Cache key includes the parser's `SCHEMA_VERSION` (imported from
 * `jsonl-tailer.ts`); a parser bump auto-invalidates the cache and re-probes.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "./jsonl-tailer";
import {
  ASSERTION_DEFS,
  type AssertionResult,
  type CollectedJsonl,
  runAssertions,
} from "./schema-probe-assertions";
import { defaultPtyRunnerFactory } from "./schema-probe-runner";
import type { ProbeRunner, ProbeRunnerFactory, ProbeRunnerSpawnArgs } from "./schema-probe-types";

export { SCHEMA_VERSION };

/* ───────────────────────────────────────────────────────────────────── */
/* Public surface (per task brief)                                       */
/* ───────────────────────────────────────────────────────────────────── */

export interface SchemaProbeOptions {
  /** Mode per spec §11.1. */
  mode?: "warn-only" | "required" | "skip";
  /** Cache file path. Defaults to `~/.claudeclaw/schema-probe-cache.json`. */
  cacheFile?: string;
  /** Path to claude binary; defaults to PATH lookup of `claude`. */
  claudeBin?: string;
  /** Force re-probe regardless of cache. */
  force?: boolean;
  /** Optional structured-warning sink (e.g. logger.warn). */
  onWarning?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Test seam — override the home dir that holds `~/.claude/projects/`.
   * Production callers don't set this; tests use it to confine FS writes.
   */
  homeOverride?: string;
  /**
   * Overall probe timeout in ms. Spec §11.1 budget is <5 s; we default
   * to 15 s to give CI a safety margin without unbounded hangs.
   */
  timeoutMs?: number;
}

export interface ProbeResult {
  status: "passed" | "failed" | "skipped" | "cached";
  claudeVersion: string;
  schemaHash: string;
  failedAssertions?: Array<{ name: string; reason: string }>;
}

interface CacheEntry {
  claudeVersion: string;
  lastPassedAt: string; // ISO 8601
  schemaHash: string;
  parserSchemaVersion: string;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Helpers — path encoding (matches claude's own scheme; Spike 0.5)      */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Encode a realpath cwd into the directory name claude uses under
 * `~/.claude/projects/`. claude replaces `/` with `-` only — other
 * characters (dots, underscores) are preserved. Empirically confirmed
 * against fixture: cwd `/private/tmp/spike-0.2` encodes as
 * `-private-tmp-spike-0.2` (dot kept). Re-exported from
 * `jsonl-line-types.ts` so the Tailer and the probe stay in lock-step.
 */
export { encodeCwdForProjectsDir as encodeCwd } from "./jsonl-line-types";
import { encodeCwdForProjectsDir as _encodeCwdImpl } from "./jsonl-line-types";

/**
 * Compute the encoded JSONL path the probe expects. Uses `realpathSync`
 * on tmpdir first to defeat the macOS `/tmp` → `/private/tmp` symlink
 * (Spike 0.5).
 */
export function predictJsonlPath(homeDir: string, realpathCwd: string, sessionId: string): string {
  return join(homeDir, ".claude", "projects", _encodeCwdImpl(realpathCwd), `${sessionId}.jsonl`);
}

/* ───────────────────────────────────────────────────────────────────── */
/* Cache I/O                                                             */
/* ───────────────────────────────────────────────────────────────────── */

function defaultCacheFile(homeOverride?: string): string {
  return join(homeOverride ?? homedir(), ".claudeclaw", "schema-probe-cache.json");
}

function readCache(path: string): CacheEntry | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as Partial<CacheEntry>;
    if (
      typeof data.claudeVersion === "string" &&
      typeof data.lastPassedAt === "string" &&
      typeof data.schemaHash === "string" &&
      typeof data.parserSchemaVersion === "string"
    ) {
      return data as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(path: string, entry: CacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

/* ───────────────────────────────────────────────────────────────────── */
/* claude --version (sync; we only run this once per daemon startup)     */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Run `<claudeBin> --version` and return the trimmed first line. Returns
 * `null` on any failure (binary missing, non-zero exit) so callers can
 * decide whether that warrants a warn or a throw.
 */
async function captureClaudeVersion(claudeBin: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = nodeSpawn(claudeBin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows `claude` resolves to `claude.cmd`; since the CVE-2024-27980
      // fix Node refuses to spawn a .cmd/.bat without a shell (EINVAL/EFTYPE),
      // so route through the shell there. Args are static — no injection risk.
      shell: process.platform === "win32",
    });
    let out = "";
    let settled = false;
    const settle = (v: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => settle(null));
    child.on("exit", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
        settle(first ? first.trim() : null);
      } else {
        settle(null);
      }
    });
    setTimeout(() => settle(null), timeoutMs);
  });
}

/* ───────────────────────────────────────────────────────────────────── */
/* JSONL collector — polls a file path until budget exhausted            */
/* ───────────────────────────────────────────────────────────────────── */

interface CollectorBudget {
  totalMs: number;
  pollMs?: number;
}

/**
 * Wait for `path` to exist + grow, polling at `pollMs` (default 50 ms)
 * for up to `totalMs`. Returns every newline-delimited JSON object
 * observed, plus the latest raw text (for debugging).
 *
 * Uses polling rather than `fs.watch` because:
 *  - Polling is cross-platform identical (no inotify/FSEvents quirks)
 *  - The probe is short-lived; missed-event hazards aren't material
 *  - The Tailer (Agent A) handles long-lived watching; we don't.
 */
async function collectJsonl(path: string, budget: CollectorBudget): Promise<CollectedJsonl> {
  const start = Date.now();
  const pollMs = budget.pollMs ?? 50;
  const lines: Record<string, unknown>[] = [];
  let raw = "";
  let lastSize = 0;
  while (Date.now() - start < budget.totalMs) {
    if (existsSync(path)) {
      try {
        const next = readFileSync(path, "utf8");
        if (next.length !== lastSize) {
          raw = next;
          lastSize = next.length;
        }
      } catch {
        /* race: file briefly missing */
      }
    }
    await sleep(pollMs);
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* tolerate partial/malformed line — assertions will surface gaps */
    }
  }
  return { path, lines, raw };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ───────────────────────────────────────────────────────────────────── */
/* SchemaProbe                                                            */
/* ───────────────────────────────────────────────────────────────────── */

export class SchemaProbe {
  private readonly opts: Required<
    Omit<SchemaProbeOptions, "claudeBin" | "onWarning" | "homeOverride">
  > &
    Pick<SchemaProbeOptions, "claudeBin" | "onWarning" | "homeOverride">;
  private readonly runnerFactory: ProbeRunnerFactory;

  constructor(opts: SchemaProbeOptions = {}, runnerFactory?: ProbeRunnerFactory) {
    this.opts = {
      mode: opts.mode ?? "warn-only",
      // PR #111 review (agent #5): thread `homeOverride` into the cache
      // path too so tests passing only `homeOverride` don't end up writing
      // to the developer's real `~/.claudeclaw/`. Explicit `cacheFile`
      // still wins (matches the doc on SchemaProbeOptions).
      cacheFile: opts.cacheFile ?? defaultCacheFile(opts.homeOverride),
      claudeBin: opts.claudeBin,
      force: opts.force ?? false,
      onWarning: opts.onWarning,
      homeOverride: opts.homeOverride,
      timeoutMs: opts.timeoutMs ?? 15_000,
    };
    this.runnerFactory = runnerFactory ?? defaultPtyRunnerFactory;
  }

  /**
   * Run the probe. In `required` mode, throws on failure.
   */
  async run(): Promise<ProbeResult> {
    if (this.opts.mode === "skip") {
      return { status: "skipped", claudeVersion: "", schemaHash: "" };
    }

    const claudeBin = this.opts.claudeBin ?? "claude";
    const version = await captureClaudeVersion(claudeBin);
    if (!version) {
      return this.handleFailure("", [
        { name: "claude_version", reason: `\`${claudeBin} --version\` failed` },
      ]);
    }

    // Cache check: only honoured when not forced + entry matches version + parser version
    if (!this.opts.force) {
      const cached = readCache(this.opts.cacheFile);
      if (
        cached &&
        cached.claudeVersion === version &&
        cached.parserSchemaVersion === SCHEMA_VERSION
      ) {
        return {
          status: "cached",
          claudeVersion: version,
          schemaHash: cached.schemaHash,
        };
      }
    }

    return await this.runFullProbe(version, claudeBin);
  }

  private async runFullProbe(version: string, claudeBin: string): Promise<ProbeResult> {
    const sessionId = randomUuid();
    const home = this.opts.homeOverride ?? homedir();
    const cwd = mkdtemp(tmpdir(), "ccaw-probe-");
    const realCwd = safeRealpath(cwd);
    const expectedPath = predictJsonlPath(home, realCwd, sessionId);

    let runner: ProbeRunner | null = null;
    const failures: Array<{ name: string; reason: string }> = [];
    let collected: CollectedJsonl = { path: expectedPath, lines: [], raw: "" };

    // Pacing budget — split the configured timeout into the 6 steps that
    // need wall-time. Default 15 s → ~750 ms steps + 3 s exit window.
    // Tests inject a tiny timeoutMs to keep the suite fast (mock writes
    // JSONL up front, so even sub-50 ms steps work).
    const stepMs = Math.max(5, Math.floor(this.opts.timeoutMs / 20));
    const exitMs = Math.max(20, Math.floor(this.opts.timeoutMs / 5));

    try {
      runner = await this.runnerFactory({ cwd: realCwd, sessionId, claudeBin });

      // Step 1 — wait for JSONL to materialise at the predicted path.
      await sleep(stepMs);

      // Step 6 prompt — canonical text prompt.
      await runner.sendPrompt("Reply with exactly the text TEST_OK and call no tools.");
      await sleep(stepMs);

      // Step 7 prompt — tool-eliciting (probe accepts that the stub may
      // synthesise a tool_use/tool_result pair; real claude will pick a
      // safe tool given a benign nudge).
      await runner.sendPrompt("List the cwd files using a tool, then say DONE.");
      await sleep(stepMs);

      // Step 8 — slash relay /clear: spec §11.1 + Spike 0.5 (rotation).
      await runner.sendSlash("clear");
      await sleep(stepMs);

      // Step 9 — /quit. Validate exit + exit envelope in JSONL.
      await runner.sendSlash("quit");
      const exited = await runner.waitForExit(exitMs);
      if (!exited) {
        failures.push({ name: "process_exit", reason: "claude did not exit within budget" });
      }

      // Final tail of the original JSONL.
      collected = await collectJsonl(expectedPath, {
        totalMs: stepMs,
        pollMs: Math.max(2, Math.floor(stepMs / 5)),
      });

      // Also collect any sibling JSONLs (the /clear rotation).
      const siblings = collectSiblings(expectedPath);

      const assertionResults = runAssertions(collected, {
        expectedPath,
        siblingJsonls: siblings,
      });
      for (const r of assertionResults) {
        if (!r.passed) failures.push({ name: r.name, reason: r.reason });
      }
    } catch (err) {
      failures.push({
        name: "probe_runtime",
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (runner) {
        try {
          runner.kill();
        } catch {
          /* swallow */
        }
      }
    }

    const schemaHash = hashSchemaShape(collected);
    if (failures.length === 0) {
      writeCache(this.opts.cacheFile, {
        claudeVersion: version,
        lastPassedAt: new Date().toISOString(),
        schemaHash,
        parserSchemaVersion: SCHEMA_VERSION,
      });
      return { status: "passed", claudeVersion: version, schemaHash };
    }

    return this.handleFailure(version, failures, schemaHash);
  }

  private handleFailure(
    version: string,
    failed: Array<{ name: string; reason: string }>,
    schemaHash = "",
  ): ProbeResult {
    if (this.opts.mode === "required") {
      const names = failed.map((f) => f.name).join(", ");
      throw new SchemaProbeFailure(
        `schema-probe failed in required mode: ${names}`,
        version,
        failed,
      );
    }
    // warn-only (default): emit structured warning + do NOT update cache.
    if (this.opts.onWarning) {
      try {
        this.opts.onWarning("schema-probe failed (warn-only)", {
          claudeVersion: version,
          parserSchemaVersion: SCHEMA_VERSION,
          assertions: failed,
        });
      } catch {
        /* never let the warning sink crash the daemon */
      }
    }
    return {
      status: "failed",
      claudeVersion: version,
      schemaHash,
      failedAssertions: failed,
    };
  }
}

export class SchemaProbeFailure extends Error {
  readonly claudeVersion: string;
  readonly failedAssertions: Array<{ name: string; reason: string }>;
  constructor(
    message: string,
    claudeVersion: string,
    failedAssertions: Array<{ name: string; reason: string }>,
  ) {
    super(message);
    this.name = "SchemaProbeFailure";
    this.claudeVersion = claudeVersion;
    this.failedAssertions = failedAssertions;
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* Local utilities                                                       */
/* ───────────────────────────────────────────────────────────────────── */

function randomUuid(): string {
  // crypto.randomUUID exists on bun + node ≥19.
  return crypto.randomUUID();
}

function mkdtemp(base: string, prefix: string): string {
  const root = join(
    base,
    `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function collectSiblings(jsonlPath: string): string[] {
  // The probe's /clear emits a NEW jsonl in the same dir. We surface
  // every *.jsonl in that dir EXCEPT the primary so assertions can
  // detect the rotation. Use sync glob; the dir is throwaway + small.
  const dir = dirname(jsonlPath);
  if (!existsSync(dir)) return [];
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && join(dir, f) !== jsonlPath)
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function hashSchemaShape(collected: CollectedJsonl): string {
  // Build a stable signature of the schema *shape* (line types + top-level
  // keys per type) so cache invalidation tracks structural drift, not just
  // version-string changes.
  const shape: Record<string, Set<string>> = {};
  for (const line of collected.lines) {
    const t = typeof line.type === "string" ? line.type : "unknown";
    if (!shape[t]) shape[t] = new Set();
    for (const k of Object.keys(line)) shape[t].add(k);
  }
  const canonical = Object.keys(shape)
    .sort()
    .map((t) => `${t}=${[...shape[t]].sort().join(",")}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/* ───────────────────────────────────────────────────────────────────── */
/* Re-export assertion catalogue for visibility / coverage tests         */
/* ───────────────────────────────────────────────────────────────────── */

export { ASSERTION_DEFS, runAssertions };
export type { AssertionResult, CollectedJsonl };
export { defaultPtyRunnerFactory };
export type { ProbeRunner, ProbeRunnerFactory, ProbeRunnerSpawnArgs };
