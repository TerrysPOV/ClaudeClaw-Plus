/**
 * Memory save at shutdown (#549), run by the daemon.
 *
 * `claudeclaw stop` used to resume the global session in its own `claude -p` before
 * signalling the daemon: a second process on a transcript the live PTY was still
 * writing, and nothing for any session but the global one. Now the daemon asks each
 * live session to save through the session it already has (`sendToLiveSession`),
 * after the turn drain and before the bus goes away.
 *
 * The save has its own time slot (`SHUTDOWN_MEMORY_SAVE_MS`), independent of the drain,
 * so a turn that used up `shutdown.drainTurnsMs` (or `drainTurnsMs: 0`) does not cost
 * it; drain plus save stay inside the window `claudeclaw stop` waits for (`stopGraceMs`).
 */
import { loadSettings } from "./config";
import { getMemoryPath, memoryFileGrant } from "./memory";
import { type OneShotRequest, runOneShot } from "./oneshot/engine";
import type { LiveSendResult } from "./runner/pty-supervisor";
import { getSession } from "./sessions";

/** Parallel saves at most; each one is a model turn on an already-live process. */
const DEFAULT_CONCURRENCY = 4;

export function memorySavePrompt(memPath: string): string {
  return `Session is shutting down. Save your current memory to ${memPath} now. Include: current status, what was accomplished, key context for next session.`;
}

/**
 * The memory file a supervisor session saves to, or null when its kind has none:
 * `global` and `agent:<name>` have one; a thread shares the global file, which a
 * thread must not overwrite, and a rate-limit fallback is a stand-in for another key.
 */
export function memoryPathForSessionKey(sessionKey: string): string | null {
  if (sessionKey === "global") return getMemoryPath();
  if (sessionKey.startsWith("agent:")) return getMemoryPath(sessionKey.slice("agent:".length));
  return null;
}

export interface MemorySaveDeps {
  /** `liveSessionKeys()` of the supervisor. */
  liveKeys: () => string[];
  /** `sendToLiveSession`, with the time left for this one send. */
  send: (
    sessionKey: string,
    text: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<LiveSendResult>;
  memoryPathFor: (sessionKey: string) => string | null;
  /**
   * Save the global session when it has no live PTY (the legacy `-p` runtime keeps
   * none). Called when `liveKeys()` has no `global`, or when the global live send
   * returns `not-live` (no process holds the session). Never after `failed`: a live
   * process may still be writing the transcript, and this would be a second writer.
   */
  fallbackSave?: (opts: {
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<"saved" | "skipped" | "failed">;
  /** A second SIGTERM/SIGINT aborts the save as it aborts the drain. */
  signal?: AbortSignal;
  concurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MemorySaveOutcome {
  saved: string[];
  skipped: Array<{ key: string; reason: string }>;
  failed: Array<{ key: string; error: string }>;
  aborted: boolean;
  waitedMs: number;
}

const FALLBACK_LABEL = "global (one-shot)";

/**
 * Ask every live global/agent session to save its memory, within `budgetMs`.
 * Never throws: a shutdown must go on whatever happens here.
 */
export async function saveMemoryAtShutdown(
  budgetMs: number,
  deps: MemorySaveDeps,
): Promise<MemorySaveOutcome> {
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? (() => undefined);
  const startedAt = now();
  const out: MemorySaveOutcome = {
    saved: [],
    skipped: [],
    failed: [],
    aborted: false,
    waitedMs: 0,
  };

  const keys = deps.liveKeys();
  const jobs: Array<{
    key: string;
    run: (timeoutMs: number, signal: AbortSignal) => Promise<void>;
  }> = [];
  const fallback = deps.fallbackSave;
  /** The one-shot save of the global session, recorded under its own label. */
  const runFallback = async (timeoutMs: number, signal: AbortSignal): Promise<void> => {
    if (!fallback) return;
    const r = await fallback({ timeoutMs, signal });
    if (r === "saved") out.saved.push(FALLBACK_LABEL);
    else if (r === "skipped") out.skipped.push({ key: FALLBACK_LABEL, reason: "nothing to save" });
    else out.failed.push({ key: FALLBACK_LABEL, error: "one-shot save failed" });
  };
  for (const key of keys) {
    const memPath = deps.memoryPathFor(key);
    if (!memPath) {
      out.skipped.push({ key, reason: "no memory file for this kind of session" });
      continue;
    }
    jobs.push({
      key,
      run: async (timeoutMs, signal) => {
        const r = await deps.send(key, memorySavePrompt(memPath), { timeoutMs, signal });
        if (r.status === "sent") out.saved.push(key);
        else if (r.status === "not-live") {
          // The global process went away between the snapshot and this send (exited,
          // or finished retiring): `not-live` means NO process holds the session, so
          // the one-shot cannot race it, and skipping would lose the save. Only the
          // global session has a one-shot save; `failed` never gets one (the live turn
          // was attempted and a process may still be writing the transcript).
          if (key === "global" && fallback) {
            await runFallback(Math.max(1, timeoutMs), signal);
          } else {
            out.skipped.push({ key, reason: `not-live: ${r.reason}` });
          }
        } else out.failed.push({ key, error: r.error });
      },
    });
  }
  if (fallback && !keys.includes("global")) {
    jobs.push({ key: FALLBACK_LABEL, run: runFallback });
  }

  if (jobs.length === 0) {
    out.waitedMs = now() - startedAt;
    return out;
  }
  if (budgetMs <= 0) {
    for (const j of jobs) {
      out.skipped.push({ key: j.key, reason: "no time left in the memory-save budget" });
    }
    log("[shutdown] memory save skipped: no time left in the memory-save budget");
    out.waitedMs = now() - startedAt;
    return out;
  }

  // One signal for the whole save: the budget or the operator's second signal.
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    out.aborted = true;
    controller.abort();
  };
  if (deps.signal?.aborted) onExternalAbort();
  else deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  (timer as { unref?: () => void }).unref?.();

  log(
    `[shutdown] saving memory for ${jobs.length} session(s) (${jobs.map((j) => j.key).join(", ")}) ` +
      `for up to ${(budgetMs / 1000).toFixed(1)}s; a second SIGTERM/SIGINT stops the wait`,
  );

  const queue = [...jobs];
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const job = queue.shift();
      if (!job) return;
      const left = Math.max(1, budgetMs - (now() - startedAt));
      try {
        await job.run(left, controller.signal);
      } catch (err) {
        out.failed.push({ key: job.key, error: (err as Error)?.message ?? String(err) });
      }
    }
  };
  try {
    const n = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, jobs.length));
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }

  for (const job of queue) {
    out.skipped.push({
      key: job.key,
      reason: out.aborted ? "aborted by a second signal" : "no time left in the memory-save budget",
    });
  }
  out.waitedMs = now() - startedAt;
  const parts = [
    `${out.saved.length} saved${out.saved.length ? ` (${out.saved.join(", ")})` : ""}`,
    ...(out.skipped.length
      ? [
          `${out.skipped.length} skipped (${out.skipped.map((s) => `${s.key}: ${s.reason}`).join("; ")})`,
        ]
      : []),
    ...(out.failed.length
      ? [
          `${out.failed.length} failed (${out.failed.map((f) => `${f.key}: ${f.error}`).join("; ")})`,
        ]
      : []),
  ];
  log(
    `[shutdown] memory save ${out.aborted ? "aborted by a second signal" : "done"} after ${(out.waitedMs / 1000).toFixed(1)}s: ${parts.join("; ")}`,
  );
  return out;
}

/**
 * The one-shot that saves a memory file by resuming `sessionId`: Read and Write
 * available, and only `memPath` pre-approved (see `memoryFileGrant`). The resumed
 * transcript can hold untrusted channel text, so the grant must not reach any other path.
 * Throws if `memPath` cannot be scoped; callers treat that as a failed save.
 */
export function memorySaveRequest(opts: {
  route: "memory.save.stop" | "memory.save.precompact";
  prompt: string;
  memPath: string;
  sessionId: string;
  model?: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): OneShotRequest {
  const grant = memoryFileGrant(opts.memPath);
  return {
    route: opts.route,
    prompt: opts.prompt,
    isolation: "trusted-session",
    resumeSessionId: opts.sessionId,
    tools: grant.tools,
    allowedTools: grant.allowedTools,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeoutMs: opts.timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

/**
 * Save the global session's memory through a one-shot resume (`memory.save.stop`).
 * For the two cases with no live PTY to ask: the legacy `-p` runtime inside the
 * daemon, and `claudeclaw stop` when no daemon is running. Never while a live PTY
 * holds the session: that is what `sendToLiveSession` is for.
 */
export async function saveGlobalMemoryOneShot(opts: {
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<"saved" | "skipped" | "failed"> {
  const session = await getSession();
  if (!session) return "skipped";
  const settings = await loadSettings();
  const memPath = getMemoryPath();
  console.log(`[shutdown] Saving memory to ${memPath}...`);
  try {
    const r = await runOneShot(
      memorySaveRequest({
        route: "memory.save.stop",
        prompt: memorySavePrompt(memPath),
        memPath,
        sessionId: session.sessionId,
        model: settings.model || "haiku",
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      }),
    );
    if (r.exitCode !== 0) return "failed";
    console.log("[shutdown] Memory saved.");
    return "saved";
  } catch (e) {
    console.warn("[shutdown] Memory save failed:", e);
    return "failed";
  }
}
