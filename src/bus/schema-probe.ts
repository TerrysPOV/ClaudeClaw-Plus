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

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Injectable for tests so the win32 `shell: true` branch in
// `captureClaudeVersion` is verifiable off-Windows. Defaults to the real
// `node:child_process` `spawn`.
type SpawnFn = (cmd: string, args: ReadonlyArray<string>, opts: SpawnOptions) => ChildProcess;
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isTerminalStopReason, SCHEMA_VERSION } from "./jsonl-tailer";
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
   * Overall probe budget in ms — an upper bound, not a pace: every step
   * returns as soon as its event is observed (#441). Spec §11.1 said <5 s;
   * a real run is two model turns plus boot (~20-40 s measured on 2.1.286),
   * so the default leaves headroom for a slow API without hanging forever.
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
/* Helpers — path encoding (matches claude's own scheme)                 */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Encode a realpath cwd into the directory name claude uses under
 * `~/.claude/projects/`. Re-exported from `jsonl-line-types.ts` so the Tailer
 * and the probe stay in lock-step; see that file for the rule and how it was
 * derived.
 *
 * The previous note here claimed dots and underscores are preserved, citing a
 * Spike 0.5 fixture. They are not: the CLI replaces every non-alphanumeric
 * character, and truncates past 200 characters with a hash of the original
 * cwd. Kept as a warning because a stale comment on a re-export is worse than
 * none — it is read as documentation of the shared contract.
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
 *
 * `platform` is injectable so the win32 `shell: true` branch is testable
 * off-Windows, mirroring the pattern used by `encodeCwdForProjectsDir`
 * in `jsonl-line-types.ts`. Production callers omit it and pick up
 * `process.platform` by default.
 */
async function captureClaudeVersion(
  claudeBin: string,
  timeoutMs = 5000,
  platform: NodeJS.Platform = process.platform,
  spawn: SpawnFn = nodeSpawn,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows `claude` resolves to `claude.cmd`; since the CVE-2024-27980
      // fix Node refuses to spawn a .cmd/.bat without a shell (EINVAL/EFTYPE),
      // so route through the shell there. Args are static and `claudeBin` is
      // operator config (never request-derived) — no injection surface; keep
      // it that way so this win32 shell path never becomes a sink.
      // (runner.ts resolves the underlying claude.exe instead — that's for
      // Bun.spawn + long argvs; here we're on node:child_process with `--version`.)
      shell: platform === "win32",
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

/* JSONL observation — read the file, wait on its contents             */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Read every newline-delimited JSON object in `path` (missing file → none).
 * A partial trailing line is skipped; the next read picks it up whole.
 */
function readJsonl(path: string): { lines: Record<string, unknown>[]; raw: string } {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { lines: [], raw: "" };
  }
  const lines: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* tolerate partial/malformed line — assertions will surface gaps */
    }
  }
  return { lines, raw };
}

/**
 * Poll `done` until it holds or `timeoutMs` runs out. Polling rather than
 * `fs.watch`: cross-platform identical, and the probe is short-lived — the
 * Tailer handles long-lived watching.
 */
async function waitFor(done: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function waitForJsonl(
  path: string,
  done: (lines: Record<string, unknown>[]) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return waitFor(() => done(readJsonl(path).lines), timeoutMs);
}

function isTurnEnd(line: Record<string, unknown>): boolean {
  const msg = line.message as { stop_reason?: unknown } | undefined;
  return line.type === "assistant" && isTerminalStopReason(msg?.stop_reason);
}

/** Assistant lines that end a turn — the Tailer's own `turn_end` rule. */
function countTurnEnds(lines: Record<string, unknown>[]): number {
  return lines.filter(isTurnEnd).length;
}

/** A tool turn is over once a terminal assistant line follows a tool_result. */
function toolTurnEnded(lines: Record<string, unknown>[]): boolean {
  const iResult = lines.findIndex((l) => {
    const c = (l.message as { content?: unknown } | undefined)?.content;
    return (
      l.type === "user" &&
      Array.isArray(c) &&
      c.some((b) => (b as { type?: unknown } | null)?.type === "tool_result")
    );
  });
  return iResult >= 0 && lines.slice(iResult + 1).some(isTurnEnd);
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
      timeoutMs: opts.timeoutMs ?? 120_000,
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

    // #441: pace on observed events, not fixed sleeps. Each step waits for
    // its own evidence (REPL footer, a finished turn in the JSONL, the /clear
    // rotation, process exit) with whatever is left of `timeoutMs` as the
    // bound. A step that times out is recorded and the run tears down — the
    // assertions below then say which shapes were never seen.
    const deadline = Date.now() + this.opts.timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const stepTimedOut = (name: string, what: string) => {
      const tail = runner?.screenTail?.() ?? "";
      failures.push({
        name: `step_timeout_${name}`,
        reason: `${what} not observed within the ${this.opts.timeoutMs} ms budget${tail ? `; screen:\n${tail}` : ""}`,
      });
    };

    try {
      runner = await this.runnerFactory({
        cwd: realCwd,
        sessionId,
        claudeBin,
        homeDir: this.opts.homeOverride,
      });

      const steps = async (r: ProbeRunner): Promise<void> => {
        // Step 1 — REPL up (trust + dev-channels dialogs behind us).
        if (r.waitForReady && !(await r.waitForReady(remaining()))) {
          return stepTimedOut("repl_ready", "REPL idle footer");
        }

        // Step 6 prompt — canonical text prompt. Wait for its turn to end.
        await r.sendPrompt("Reply with exactly the text TEST_OK and call no tools.");
        if (!(await waitForJsonl(expectedPath, (l) => countTurnEnds(l) >= 1, remaining()))) {
          return stepTimedOut("text_turn", "end of the text turn (terminal assistant line)");
        }

        // Step 7 prompt — tool-eliciting. Its turn ends on an assistant line
        // AFTER the tool_result, so /clear is never typed mid-turn.
        await r.sendPrompt("List the cwd files using a tool, then say DONE.");
        if (!(await waitForJsonl(expectedPath, toolTurnEnded, remaining()))) {
          return stepTimedOut(
            "tool_turn",
            "end of the tool turn (tool_result, then a terminal assistant line)",
          );
        }

        // Step 8 — slash relay /clear: spec §11.1 + Spike 0.5 (rotation).
        await r.sendSlash("clear");
        if (!(await waitFor(() => collectSiblings(expectedPath).length > 0, remaining()))) {
          return stepTimedOut("clear_rotation", "a rotated JSONL after /clear");
        }

        // Step 9 — /quit. Process exit is the authoritative end signal.
        await r.sendSlash("quit");
        if (!(await r.waitForExit(remaining()))) {
          failures.push({ name: "process_exit", reason: "claude did not exit within budget" });
        }
      };
      await steps(runner);

      collected = { path: expectedPath, ...readJsonl(expectedPath) };

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

/** For tests only — verifies the win32 `shell: true` branch off-Windows. */
export { captureClaudeVersion as __captureClaudeVersionForTests };
