/**
 * Forensic post-mortem capture for the bus runtime's agent-respawn path.
 *
 * When `SessionManager.restart()` tears down a wedged / rotation-due agent
 * PTY, we snapshot just enough evidence to debug *why* the agent had to be
 * respawned — written to disk BEFORE the process is stopped, so the JSONL
 * we tail is the one the dying process was actually writing.
 *
 * Three respawn triggers feed this single capture (the shape is the same
 * regardless of which fired — the `reason` field discriminates):
 *   - control-plane wedge  — a prompt never reached the agent (`stdin_written=false`)
 *   - data-plane wedge     — prompt reached the agent but no turn followed
 *                            (the upstream model-hang, anthropics/claude-code#64496)
 *   - session rotation     — message/age threshold tripped
 *
 * Field shape ports the external watchdog's forensic dossier
 * (`scripts/wedge-action.sh`) to a daemon-side JSON emit: the triggering
 * receipt (already redacted — prompt is stored as a hash, never plaintext),
 * the agent's cwd + session id, and the tail of the session JSONL.
 *
 * The file is written 0600 (mirrors `receipt.ts`): the JSONL tail can carry
 * conversation fragments, so the artifact stays owner-only.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwdForProjectsDir } from "./jsonl-line-types";
import type { ReceiptRecord } from "./receipt";

/** Default tail size — last N JSONL lines retained in the post-mortem. */
const DEFAULT_TAIL_LINES = 50;

/**
 * Only read the trailing slice of the JSONL — a wedged session's transcript
 * is exactly the unbounded-growth case #213 is about, so reading the whole
 * file would defeat the purpose. 256 KiB comfortably holds 50 lines of even
 * a tool-result-heavy transcript without loading a multi-MB file into memory.
 */
const TAIL_READ_BYTES = 256 * 1024;

export interface PostMortemInput {
  /** Stable agent id (registry key). */
  agentId: string;
  /** Realpath'd cwd — must match what the JSONL tailer encodes. */
  cwd: string;
  /** Session id whose JSONL transcript we tail. */
  sessionId: string;
  /** Why the respawn fired (e.g. "rotation", "wedge-no-turn", "manual"). */
  reason: string;
  /** Snapshot of the triggering receipt, when one is available. */
  receipt?: Readonly<ReceiptRecord> | null;
  /** How many prior restarts this agent has had in the rate-limit window. */
  generation?: number;
}

export interface PostMortemOptions {
  /** Output dir. Defaults to `~/.claude/claudeclaw/post-mortems`. */
  dir?: string;
  /** Projects-dir root for JSONL lookup. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** How many trailing JSONL lines to retain. Defaults to 50. */
  tailLines?: number;
  /** Clock seam (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Filesystem-safe ISO stamp: `2026-06-04T07:12:33.221Z` → `...-07-12-33-221Z`. */
function isoStamp(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

/**
 * Read the trailing `tailLines` of an agent's session JSONL. Best-effort —
 * a missing file (e.g. the agent never produced a turn) yields `[]`, never
 * throws.
 */
async function readJsonlTail(jsonlPath: string, tailLines: number): Promise<string[]> {
  try {
    const file = Bun.file(jsonlPath);
    const size = file.size;
    if (!size) return [];
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const text = await file.slice(start).text();
    // When we sliced into the middle of the file the first element is a
    // partial line — `slice(-tailLines)` discards it as long as the tail
    // we want is shorter than what the window holds (it is for N=50).
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.slice(-tailLines);
  } catch {
    return [];
  }
}

/**
 * Capture a post-mortem snapshot for an agent about to be respawned.
 *
 * Best-effort: returns the written path, or `null` if the write failed
 * (caller must never let instrumentation break the respawn). Callers should
 * invoke this BEFORE stopping the process so the JSONL tail reflects the
 * dying session.
 */
export async function capturePostMortem(
  input: PostMortemInput,
  opts: PostMortemOptions = {},
): Promise<string | null> {
  const now = opts.now ?? (() => new Date());
  const dir = opts.dir ?? join(homedir(), ".claude", "claudeclaw", "post-mortems");
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;

  const jsonlPath = join(
    projectsDir,
    encodeCwdForProjectsDir(input.cwd),
    `${input.sessionId}.jsonl`,
  );
  const jsonlTail = await readJsonlTail(jsonlPath, tailLines);

  const record = {
    schema: "claudeclaw.post-mortem.v1",
    agent_id: input.agentId,
    reason: input.reason,
    captured_at: now().toISOString(),
    cwd: input.cwd,
    session_id: input.sessionId,
    process_generation: input.generation ?? 0,
    receipt: input.receipt ?? null,
    jsonl_path: jsonlPath,
    jsonl_tail_lines: jsonlTail.length,
    jsonl_tail: jsonlTail,
  };

  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${input.agentId}-${isoStamp(now())}.json`);
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    // mkdir/umask can leave the file group/other-readable on some systems;
    // chmod explicitly so the JSONL tail stays owner-only (mirrors receipt.ts).
    await chmod(path, 0o600).catch(() => {});
    return path;
  } catch {
    return null;
  }
}
