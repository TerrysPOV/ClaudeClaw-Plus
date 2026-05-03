/**
 * Memory Persistence
 *
 * Loads and manages MEMORY.md files for the main session and agent sessions.
 * Memory is injected into --append-system-prompt on every invocation.
 */

import { join } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";

const PROJECT_DIR = process.cwd();
const CLAUDECLAW_DIR = join(PROJECT_DIR, ".claude", "claudeclaw");
// MEMORY.md lives in project root (NOT .claude/) because Claude Code
// blocks writes to .claude/ directories even with --dangerously-skip-permissions
const MEMORY_FILE = join(PROJECT_DIR, "MEMORY.md");
const AGENTS_DIR = join(CLAUDECLAW_DIR, "agents");

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const MEMORY_INSTRUCTIONS_FILE = join(PROMPTS_DIR, "MEMORY_INSTRUCTIONS.md");

const MEMORY_TEMPLATE = [
  "# Memory",
  "",
  "## Current Status",
  "- No tasks in progress",
  "",
  "## Key Decisions",
  "- None yet",
  "",
  "## Session Log",
  "- Session started",
  "",
].join("\n");

// Agent memory also lives outside .claude/ for the same write permission reason
const AGENTS_MEMORY_DIR = join(PROJECT_DIR, "agents");

export function getMemoryPath(agentName?: string): string {
  if (agentName) {
    return join(AGENTS_MEMORY_DIR, agentName, "MEMORY.md");
  }
  return MEMORY_FILE;
}

export async function ensureMemoryFile(agentName?: string): Promise<void> {
  const memPath = getMemoryPath(agentName);
  const dir = join(memPath, "..");
  await mkdir(dir, { recursive: true });
  if (!existsSync(memPath)) {
    await writeFile(memPath, MEMORY_TEMPLATE, "utf8");
  }
}

export async function loadMemory(agentName?: string): Promise<string> {
  const memPath = getMemoryPath(agentName);
  try {
    if (!existsSync(memPath)) return "";
    const content = await readFile(memPath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

export async function loadMemoryInstructions(agentName?: string): Promise<string> {
  try {
    if (!existsSync(MEMORY_INSTRUCTIONS_FILE)) return "";
    const content = await readFile(MEMORY_INSTRUCTIONS_FILE, "utf8");
    if (!content.trim()) return "";
    return content.trim().replace(/<MEMORY_PATH>/g, getMemoryPath(agentName));
  } catch {
    return "";
  }
}
// ---------------------------------------------------------------------------
// Session-history search (added 2026-05-03 for issue #19)
//
// Wraps the Python `tools/memory-search/` indexer + searcher. We keep the
// heavy lifting (SQLite + FTS5 + sentence-transformer embeddings) in Python
// where the libraries are mature, and expose deterministic read/write entry
// points to the rest of the daemon from here.
//
// Determinism notes:
//   - No in-process cache: every searchSessions() call shells out to a
//     fresh Python subprocess that reads from the on-disk SQLite database.
//     If you write a memory or index a new session, the very next read
//     reflects it.
//   - indexSessions() is idempotent (the Python indexer skips files whose
//     mtime has not changed) so calling it on every boot is cheap.
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_DIR = join(import.meta.dir, "..", "tools", "memory-search");
const MEMORY_SEARCH_BIN = join(MEMORY_SEARCH_DIR, ".venv", "bin", "memory-search");

export interface MemorySearchSettings {
  /** Disable the whole subsystem at runtime. Default: true. */
  enabled?: boolean;
  /** Path to the `memory-search` CLI. Falls back to project venv then PATH. */
  binPath?: string;
  /** Path to the SQLite DB. Falls back to ~/.claude/claudeclaw/memory-search.db. */
  dbPath?: string;
  /** Colon-separated session JSONL directories. Falls back to all of ~/.claude/projects/*. */
  sessionsDir?: string;
  /** sentence-transformer model name. Default: all-MiniLM-L6-v2. */
  model?: string;
  /** Hybrid blend, 1.0=semantic only, 0.0=FTS5 only. Default: 0.5. */
  alpha?: number;
  /**
   * NYI — wired in a follow-up PR. Currently parsed but not enforced.
   *
   * Re-index after every N runner turns. Default: 10. 0 disables.
   */
  reindexEveryNTurns?: number;
  /** Max seconds a search subprocess is allowed to run. Default: 60. */
  searchTimeoutSec?: number;
  /** Max seconds an index subprocess is allowed to run. Default: 600. */
  indexTimeoutSec?: number;
}

/**
 * Parse a raw settings.memorySearch object into a strict MemorySearchSettings.
 * Unknown / wrong-type fields are dropped. Returns `{}` (all defaults) when
 * the input is missing or not an object.
 */
export function parseMemorySearchSettings(raw: unknown): MemorySearchSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: MemorySearchSettings = {};

  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.binPath === "string" && r.binPath.trim()) out.binPath = r.binPath.trim();
  if (typeof r.dbPath === "string" && r.dbPath.trim()) out.dbPath = r.dbPath.trim();
  if (typeof r.sessionsDir === "string" && r.sessionsDir.trim()) out.sessionsDir = r.sessionsDir.trim();
  if (typeof r.model === "string" && r.model.trim()) out.model = r.model.trim();

  if (typeof r.alpha === "number" && Number.isFinite(r.alpha) && r.alpha >= 0 && r.alpha <= 1) {
    out.alpha = r.alpha;
  }
  if (typeof r.reindexEveryNTurns === "number" && Number.isInteger(r.reindexEveryNTurns) && r.reindexEveryNTurns >= 0) {
    out.reindexEveryNTurns = r.reindexEveryNTurns;
  }
  if (typeof r.searchTimeoutSec === "number" && Number.isFinite(r.searchTimeoutSec) && r.searchTimeoutSec > 0) {
    out.searchTimeoutSec = r.searchTimeoutSec;
  }
  if (typeof r.indexTimeoutSec === "number" && Number.isFinite(r.indexTimeoutSec) && r.indexTimeoutSec > 0) {
    out.indexTimeoutSec = r.indexTimeoutSec;
  }

  return out;
}

export interface SessionSearchHit {
  score: number;
  session_id: string;
  timestamp: string;
  turn_count: number;
  excerpt: string;
}

export interface SessionSearchResult {
  query: string;
  hits: SessionSearchHit[];
  summary: string | null;
}

export interface IndexResult {
  found: number;
  indexed: number;
  skipped: number;
}

const SETUP_HINT =
  "Run: cd tools/memory-search && uv pip install -e .";

type BinCheck =
  | { ok: true; bin: string }
  | { ok: false; reason: string };

/**
 * Locate the memory-search binary, with a clear setup hint when missing.
 * Order: explicit `opts.binPath` → project venv → `which memory-search` on PATH.
 */
function checkMemorySearchBin(opts?: MemorySearchSettings): BinCheck {
  if (opts?.binPath) {
    if (existsSync(opts.binPath)) return { ok: true, bin: opts.binPath };
    return {
      ok: false,
      reason: `binary not found at configured binPath '${opts.binPath}'. ${SETUP_HINT}`,
    };
  }
  if (existsSync(MEMORY_SEARCH_BIN)) return { ok: true, bin: MEMORY_SEARCH_BIN };

  // Fall back to PATH lookup so users with a system-wide install still work.
  const which = spawnSync("which", ["memory-search"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return { ok: true, bin: which.stdout.trim() };
  }

  return {
    ok: false,
    reason: `binary not installed (looked at ${MEMORY_SEARCH_BIN} and PATH). ${SETUP_HINT}`,
  };
}

function buildEnv(opts?: MemorySearchSettings): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (opts?.dbPath) env.MEMORY_SEARCH_DB = opts.dbPath;
  if (opts?.sessionsDir) env.MEMORY_SEARCH_SESSIONS_DIR = opts.sessionsDir;
  if (opts?.model) env.MEMORY_SEARCH_MODEL = opts.model;
  return env;
}

/**
 * Re-index every configured session JSONL into the search DB.
 * Idempotent — skips files whose mtime is unchanged.
 *
 * Returns counts. Throws on subprocess failure (caller decides whether
 * a failed boot-time index should be fatal).
 */
export function indexSessions(opts?: MemorySearchSettings): IndexResult {
  if (opts?.enabled === false) {
    return { found: 0, indexed: 0, skipped: 0 };
  }
  const check = checkMemorySearchBin(opts);
  if (!check.ok) {
    throw new Error(`memory-search ${check.reason}`);
  }
  const result = spawnSync(check.bin, ["index"], {
    env: buildEnv(opts),
    encoding: "utf8",
    timeout: (opts?.indexTimeoutSec ?? 600) * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`memory-search index failed (exit ${result.status}): ${stderr}`);
  }

  // Parse the human-readable output: "📂 found: N  ✅ indexed: N  ⏭️  skipped: N"
  const stdout = result.stdout || "";
  const found = parseInt(stdout.match(/found:\s*(\d+)/)?.[1] ?? "0", 10);
  const indexed = parseInt(stdout.match(/indexed:\s*(\d+)/)?.[1] ?? "0", 10);
  const skipped = parseInt(stdout.match(/skipped[^:]*:\s*(\d+)/)?.[1] ?? "0", 10);
  return { found, indexed, skipped };
}

/**
 * Async fire-and-forget variant of indexSessions, suitable for the daemon
 * boot trigger where blocking the event loop is not acceptable.
 *
 * The first run downloads ~80MB of model weights and may walk hundreds of
 * sessions; with spawnSync that froze the entire daemon (no Telegram /
 * Discord during boot). Switching to spawn keeps the event loop responsive.
 *
 * Returns immediately. Logs completion / failure asynchronously.
 */
export function indexSessionsBackground(opts?: MemorySearchSettings): void {
  if (opts?.enabled === false) return;
  const check = checkMemorySearchBin(opts);
  if (!check.ok) {
    console.log(`[memory-search] ${check.reason}`);
    return;
  }
  const { spawn } = require("child_process") as typeof import("child_process");
  const proc = spawn(check.bin, ["index"], {
    env: buildEnv(opts),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.on("close", (code: number | null) => {
    if (code === 0) {
      const indexed = parseInt(stdout.match(/indexed:\s*(\d+)/)?.[1] ?? "0", 10);
      const skipped = parseInt(stdout.match(/skipped[^:]*:\s*(\d+)/)?.[1] ?? "0", 10);
      if (indexed > 0) {
        console.log(`[memory-search] background index done: ${indexed} new, ${skipped} up-to-date`);
      }
    } else {
      const detail = (stderr || stdout || "").trim().slice(0, 200);
      console.log(`[memory-search] background index failed (exit ${code}): ${detail}`);
    }
  });
  proc.on("error", (e: Error) => {
    console.log(`[memory-search] background index could not start: ${e.message}`);
  });
}

/**
 * Search past sessions for a query.
 * Always reads the on-disk DB fresh (no cache), so writes from a concurrent
 * indexSessions() are visible immediately.
 *
 * @param query  free-text query
 * @param topK   max distinct sessions to return (default 5)
 * @param withSummary  if false, skip the `claude --print` summarization step
 *                     for ~1-3s less latency. Default true, matching the
 *                     `memory-search recall` CLI default and the
 *                     session-recall skill documentation.
 */
export function searchSessions(
  query: string,
  opts?: MemorySearchSettings & { topK?: number; withSummary?: boolean }
): SessionSearchResult {
  if (opts?.enabled === false) {
    return { query, hits: [], summary: null };
  }
  const args = [
    "recall",
    query,
    "--top",
    String(opts?.topK ?? 5),
    "--json",
  ];
  if (opts?.alpha !== undefined) {
    args.push("--alpha", String(opts.alpha));
  }
  if (opts?.withSummary === false) {
    args.push("--no-summary");
  }

  const check = checkMemorySearchBin(opts);
  if (!check.ok) {
    throw new Error(`memory-search ${check.reason}`);
  }

  const result = spawnSync(check.bin, args, {
    env: buildEnv(opts),
    encoding: "utf8",
    timeout: (opts?.searchTimeoutSec ?? 60) * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // exit code 1 just means "no hits" (caller can still parse JSON for empty array)
  if (result.status !== 0 && result.status !== 1) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`memory-search recall failed (exit ${result.status}): ${stderr}`);
  }

  const stdout = (result.stdout || "").trim();
  if (!stdout) return { query, hits: [], summary: null };

  try {
    return JSON.parse(stdout) as SessionSearchResult;
  } catch (e) {
    throw new Error(`memory-search returned invalid JSON: ${(e as Error).message}`);
  }
}
