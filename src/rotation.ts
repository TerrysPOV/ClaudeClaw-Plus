import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { peekSession, backupSession, resetSession } from "./sessions";
import type { GlobalSession } from "./sessions";
import { actOnSession } from "./runner/live-session-actions";
import { retirePtySession } from "./runner/pty-supervisor";

const SUMMARY_TIMEOUT_MS = 60_000;
import type { SessionConfig } from "./config";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const SUMMARY_PROMPT_FILE = join(PROMPTS_DIR, "SUMMARY.md");

export function needsRotation(session: GlobalSession, config: SessionConfig): boolean {
  if (!config.autoRotate) return false;
  if ((session.messageCount ?? 0) >= config.maxMessages) return true;
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  if (ageMs >= config.maxAgeHours * 3_600_000) return true;
  return false;
}

/** The steps `rotateSession` takes, injectable so the order can be tested. */
export interface RotateDeps {
  peek: () => Promise<GlobalSession | null>;
  summarize: (
    sessionId: string,
    summaryPath: string,
    opts?: { sessionKey?: string },
  ) => Promise<string | null>;
  backup: () => Promise<string | null>;
  reset: () => Promise<unknown>;
  /** Retire the live supervisor entry for a key. */
  retireLive: (sessionKey: string) => Promise<void>;
}

const defaultRotateDeps: RotateDeps = {
  peek: peekSession,
  summarize: (sessionId, summaryPath, opts) => generateSummary(sessionId, summaryPath, opts),
  backup: backupSession,
  reset: resetSession,
  retireLive: retirePtySession,
};

/** Rotate the global session. Returns the freshly-written summary content, or null if summary generation was skipped, timed out, or failed. */
export async function rotateSession(
  config: SessionConfig,
  deps: RotateDeps = defaultRotateDeps,
): Promise<string | null> {
  const session = await deps.peek();
  if (!session) return null;

  const ageH = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 3_600_000);
  console.log(
    `[${new Date().toLocaleTimeString()}] Rotating session ${session.sessionId.slice(0, 8)} (messages: ${session.messageCount ?? 0}, age: ${ageH}h)`,
  );

  let freshSummary: string | null = null;
  if (config.summaryPath) {
    try {
      // The global session may be live in the PTY supervisor: ask it first (#549).
      freshSummary = await deps.summarize(session.sessionId, config.summaryPath, {
        sessionKey: "global",
      });
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to generate session summary:`, e);
    }
  }

  const backupName = await deps.backup();
  if (backupName) {
    console.log(`[${new Date().toLocaleTimeString()}] Session backed up as ${backupName}`);
  }

  await deps.reset();
  // The stored session is gone, but a live PTY would carry on with the old
  // conversation (and now the summary exchange too): retire it so the next turn
  // spawns fresh. Without this a rotation does nothing in PTY mode.
  try {
    await deps.retireLive("global");
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] Failed to retire the live session:`, e);
  }
  console.log(
    `[${new Date().toLocaleTimeString()}] Session rotated — next message will create a new session`,
  );
  return freshSummary;
}

/**
 * Write a summary for the given session. Returns the summary content on
 * success, null on timeout or failure.
 *
 * Exported for the bus restart-based rotation path (#227): after
 * `sessionManager.restart(reason:"rotation")` drops the live PTY, the rotation
 * caller summarizes the BACKED-UP (old) session id here — never the live one,
 * which would hit claude's locked-`--resume` refusal (the #227 critical 3).
 */
export async function generateSummary(
  sessionId: string,
  summaryPath: string,
  opts: { sessionKey?: string } = {},
): Promise<string | null> {
  await mkdir(summaryPath, { recursive: true });

  let summaryPrompt: string;
  try {
    summaryPrompt = await Bun.file(SUMMARY_PROMPT_FILE).text();
  } catch {
    summaryPrompt =
      "Generate a brief session summary in markdown. Include: key decisions, unfinished tasks, important context for the next session. Max 500 words.";
  }

  // Live session first when the caller knows one (`sessionKey`); otherwise a
  // one-shot resume of `sessionId` with no tools instead of the full default set (#549).
  const result = await actOnSession({
    route: "rotation.summary",
    prompt: summaryPrompt,
    sessionKey: opts.sessionKey,
    sessionId,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    // No tools: the summary comes back as text and THIS function writes the file.
    // (#549 asked for ["Write"]; the narrower grant is deliberate. A resumed session's
    // transcript holds untrusted channel text, so it must not hold a write grant.)
    allowedTools: [],
  });
  const stdout = result.text;

  if (!result.ok || !stdout.trim()) {
    console.error(
      `[${new Date().toLocaleTimeString()}] Summary generation failed (${result.detail ?? result.via}) — continuing rotation without summary`,
    );
    return null;
  }

  const content = stdout.trim();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.md`;
  const filepath = join(summaryPath, filename);

  await Bun.write(filepath, content + "\n");
  console.log(`[${new Date().toLocaleTimeString()}] Session summary saved: ${filepath}`);
  return content;
}

export async function loadLatestSummary(summaryPath: string): Promise<string | null> {
  if (!summaryPath || !existsSync(summaryPath)) return null;

  const glob = new Bun.Glob("*.md");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: summaryPath })) {
    files.push(file);
  }
  if (files.length === 0) return null;

  files.sort().reverse();
  try {
    const content = await Bun.file(join(summaryPath, files[0])).text();
    return content.trim() || null;
  } catch {
    return null;
  }
}
