/**
 * Calls that act on an existing Claude session: `/compact`, the memory save before an
 * auto-compact, the rotation summary (#549).
 *
 * They used to resume the session in a separate `claude -p` even when the PTY
 * supervisor held the same conversation live — two processes on one transcript, and
 * the live session never saw what it had been asked to do. Now the live session is
 * asked first (`sendToLiveSession`), and the one-shot resume is taken ONLY when no
 * process holds the session:
 *
 *   - `sent`      -> done in the live session.
 *   - `not-live`  -> nothing alive (no entry, dead process, one-shot stand-in): resume
 *                    it one-shot.
 *   - `failed`    -> the live session is busy past our budget, being torn down, or the
 *                    turn failed. NO fallback: a process may still be writing the
 *                    transcript, and a second one beside it is the race this removes.
 *   - `skipLive`  -> the caller says the session is wedged. The live process is retired
 *                    (disposed, awaited) BEFORE the one-shot starts, so the two never
 *                    overlap.
 *
 * Permissions: `allowedTools` restricts the ONE-SHOT only. The live path runs inside
 * the live session, which keeps whatever permissions it was spawned with (the
 * operator's permission mode and security level); a per-call tool grant cannot be
 * applied to a running PTY, and this module does not try to change it.
 */
import {
  type OneShotRequest,
  type OneShotResult,
  runOneShot as realRunOneShot,
} from "../oneshot/engine.js";
import { memoryFileGrant } from "../memory.js";
import { assertSessionWritable } from "./pty-quarantine.js";
import { retirePtySession, sendToLiveSession } from "./pty-supervisor.js";

type OneShotFn = (req: OneShotRequest) => Promise<OneShotResult>;
let _runOneShot: OneShotFn = realRunOneShot;

/** For tests only. Replace `runOneShot`; `null` restores it. */
export function injectOneShotForTests(fn: OneShotFn | null): void {
  _runOneShot = fn ?? realRunOneShot;
}

export interface SessionActionRequest {
  route: "compact" | "memory.save.precompact" | "rotation.summary";
  prompt: string;
  /** Supervisor key of the live session (`global`, `agent:<name>`, `thread:<id>`).
   *  Absent: the session is not (or no longer) live, go straight to the one-shot. */
  sessionKey?: string;
  /** Claude session id, for the one-shot resume. */
  sessionId: string;
  timeoutMs: number;
  model?: string;
  /** Working directory the session was created in; `--resume` finds it by this. */
  cwd?: string;
  /**
   * Tool grant for the one-shot fallback ONLY (see the note on permissions above).
   * `[]` means no tools; leave it out to get the default permission profile.
   */
  allowedTools?: string[];
  /** Bare tool names for `--tools` of the one-shot (see `OneShotRequest.tools`). */
  tools?: string[];
  /** The session is wedged (its last turn timed out): do not queue more on it. */
  skipLive?: boolean;
}

export interface SessionActionResult {
  ok: boolean;
  via: "live" | "oneshot";
  text: string;
  detail?: string;
}

/**
 * The TUI answers a slash command it cannot run with its own `Error: …` line (for
 * example "Error: Not enough messages to compact."), where `claude -p` would exit
 * non-zero. A live turn ends cleanly either way, so this is how a failed command shows.
 */
export function looksLikeCommandError(text: string): boolean {
  return /(^|\n)\s*Error:/.test(text);
}

const stamp = (): string => new Date().toLocaleTimeString();

export async function actOnSession(req: SessionActionRequest): Promise<SessionActionResult> {
  if (req.sessionKey && req.skipLive) {
    try {
      // Rejects when the exit could not be confirmed (#562 round 8): no one-shot beside it.
      await retirePtySession(req.sessionKey);
    } catch (err) {
      return {
        ok: false,
        via: "live",
        text: "",
        detail: `could not retire the wedged session ${req.sessionKey}: ${(err as Error).message}`,
      };
    }
  }
  if (req.sessionKey && !req.skipLive) {
    const sent = await sendToLiveSession(req.sessionKey, req.prompt, {
      timeoutMs: req.timeoutMs,
      // Only /compact is a deliberate REPL command; it is still matched exactly.
      allowReplCommand: req.route === "compact",
    });
    if (sent.status === "sent") {
      if (req.prompt.startsWith("/") && looksLikeCommandError(sent.text)) {
        return { ok: false, via: "live", text: sent.text, detail: sent.text.trim() };
      }
      console.log(`[${stamp()}] ${req.route}: done in the live session (${req.sessionKey})`);
      return { ok: true, via: "live", text: sent.text };
    }
    if (sent.status === "failed") {
      return { ok: false, via: "live", text: "", detail: sent.error };
    }
    console.log(
      `[${stamp()}] ${req.route}: ${req.sessionKey} is not live (${sent.reason}) — one-shot resume`,
    );
  }

  // #562 round 8: every path that reaches the one-shot (`not-live`, `skipLive`, no live key at
  // all) passes the gate, by key and by session id. A process the OS has not confirmed gone
  // may still write this transcript.
  try {
    await assertSessionWritable({ sessionKey: req.sessionKey, sessionId: req.sessionId });
  } catch (err) {
    return { ok: false, via: "live", text: "", detail: (err as Error).message };
  }

  try {
    const result = await _runOneShot({
      route: req.route,
      prompt: req.prompt,
      isolation: "trusted-session",
      resumeSessionId: req.sessionId,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
      ...(req.tools ? { tools: req.tools } : {}),
      timeoutMs: req.timeoutMs,
    });
    return {
      ok: result.exitCode === 0,
      via: "oneshot",
      text: result.text,
      ...(result.exitCode === 0 ? {} : { detail: `exit ${result.exitCode}` }),
    };
  } catch (err) {
    return { ok: false, via: "oneshot", text: "", detail: (err as Error).message };
  }
}

/**
 * The memory save before an auto-compact (`memory.save.precompact`). Live session
 * first, one-shot fallback otherwise; the fallback may Read and Write `memPath` and
 * nothing else (`memoryFileGrant`). A path that cannot be scoped fails the save: the
 * live session is not asked either, so the outcome does not depend on which path ran.
 */
export async function saveMemoryBeforeCompact(opts: {
  memPath: string;
  prompt: string;
  sessionKey?: string;
  sessionId: string;
  /** The turn timed out, so the session is wedged: retire it, then resume one-shot. */
  skipLive?: boolean;
  model?: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<SessionActionResult> {
  let grant: ReturnType<typeof memoryFileGrant>;
  try {
    grant = memoryFileGrant(opts.memPath);
  } catch (err) {
    return { ok: false, via: "oneshot", text: "", detail: (err as Error).message };
  }
  return actOnSession({
    route: "memory.save.precompact",
    prompt: opts.prompt,
    sessionKey: opts.sessionKey,
    sessionId: opts.sessionId,
    skipLive: opts.skipLive,
    model: opts.model,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    tools: grant.tools,
    allowedTools: grant.allowedTools,
  });
}
