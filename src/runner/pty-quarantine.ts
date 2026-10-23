/**
 * Session quarantine (#562 round 8).
 *
 * A process whose exit the OS did not confirm after SIGKILL may still append to its
 * transcript, so no other claude may start on that session until a later confirmation
 * succeeds. The registry is keyed by SESSION (the supervisor key AND the claude session
 * id), not by whether an entry is still in the supervisor's map: the retained process of a
 * failed crash recovery, a retired entry and a one-shot `--resume` of the same transcript
 * all meet the same record.
 *
 * `assertSessionWritable` is the ONE gate. Every path that can start a claude on a session
 * passes it: PTY spawn and respawn, `sendToLiveSession`, the one-shot engine, the legacy
 * `claude -p --resume`. It also retries the confirmation, so a quarantine does not need a
 * timer to be released: the next use of the session does it. The gate honours the caller's
 * deadline and abort signal (#562 round 9): the confirmation keeps running in the background
 * and the quarantine stays, but the caller is not held past its own budget.
 *
 * The gate is async, so it cannot be the last word: a retirement that fails during the await
 * between the gate and the spawn would quarantine a session the spawn then goes ahead on.
 * Round 9 closes that with two more pieces, in this same registry:
 *   - a FENCE, set synchronously when a retirement begins (before its first await) and
 *     turned into the quarantine record, with no gap, when the exit is not confirmed (or
 *     dropped when it is);
 *   - `assertSessionSpawnable`, a synchronous check that every spawn site runs on the line
 *     immediately before the process is created, after all its async preparation.
 * The final round (#592) fences the KEY as well (`fenceKey`, owned by the retiring entry), so a
 * spawn still in its ready-settle, which has a child and no `PtyProcess` yet, is covered; a
 * spawn that does not settle within the bound is quarantined through a stand-in record.
 */
import type { PtyProcess } from "./pty-process.js";

/** Thrown while a process on the session has not been proven dead. */
export class PtyQuarantinedError extends Error {
  constructor(session: string, retiring = false) {
    super(
      retiring
        ? `[pty-supervisor] ${session} is quarantined: a previous process on it is being retired, so nothing is spawned or resumed on the session until the OS confirms it gone`
        : `[pty-supervisor] ${session} is quarantined: its previous process is still alive after SIGKILL, so nothing is spawned or resumed on the session until the OS confirms it gone`,
    );
    this.name = "PtyQuarantinedError";
  }
}

/**
 * The caller's deadline passed or its signal fired while the gate waited for a confirmation.
 * The confirmation goes on in the background and the quarantine is untouched.
 */
export class SessionGateInterrupted extends Error {
  constructor(readonly how: "timeout" | "aborted") {
    super(
      how === "timeout"
        ? "[pty-supervisor] gave up waiting for the session's previous process to be confirmed gone; it stays quarantined"
        : "[pty-supervisor] aborted while waiting for the session's previous process to be confirmed gone; it stays quarantined",
    );
    this.name = "SessionGateInterrupted";
  }
}

/** What bounds a caller's wait at the gate. */
export interface GateOptions {
  /** Absolute `Date.now()` ms after which the caller stops waiting. */
  deadline?: number;
  signal?: AbortSignal;
}

/** What identifies a session to the gate: either id matches a record. */
export interface SessionTarget {
  /** Supervisor key (`global`, `agent:<name>`, `thread:<id>`, `fallback:<key>`). */
  sessionKey?: string;
  /** Claude session id (the transcript). */
  sessionId?: string;
}

export interface QuarantineInfo {
  sessionKey: string;
  sessionId: string;
  pid: number;
  /** Short fixed code, safe to show in a status listing. */
  reason: string;
  /** Wall-clock ms when the session entered quarantine. */
  since: number;
}

interface QuarantineRecord {
  sessionKey: string;
  pty: PtyProcess;
  reason: string;
  since: number;
}

let records: QuarantineRecord[] = [];

interface Fence {
  sessionKey: string;
  /** Read at check time: a pending spawn learns its session id only as it boots. */
  sessionId: () => string | undefined;
}

/**
 * Retirements that have begun and not yet finished, by owner: a process (`fenceSession`) or,
 * for a session with no landed process, the entry that owns a pending spawn (`fenceKey`).
 */
const fences = new Map<object, Fence>();

/**
 * Fence the session of `pty` from the moment its retirement BEGINS. Call it synchronously,
 * before the first await of the retirement. Idempotent. Every exit from the retirement ends
 * in `quarantineSession` (not confirmed: the fence becomes the record, in one synchronous
 * step) or `liftFence` (confirmed, or the retirement is over).
 */
export function fenceSession(sessionKey: string, pty: PtyProcess): void {
  fences.set(pty, { sessionKey, sessionId: () => pty.sessionId });
}

/**
 * Fence a session KEY from the moment a retirement begins, whether or not a process has
 * landed on it (#562 #592). A spawn still in its ready-settle already has a running child, but
 * no `PtyProcess` to fence; the owner is then the entry. `sessionId` is read on every check.
 * Idempotent. Ended by `liftFence(owner)`, or handed to `quarantineSession` via `alsoLift`.
 */
export function fenceKey(
  sessionKey: string,
  owner: object,
  sessionId: () => string | undefined = () => undefined,
): void {
  fences.set(owner, { sessionKey, sessionId });
}

/** End the fence of `owner` (a process or an entry). A no-op once a quarantine has taken it. */
export function liftFence(owner: object): void {
  fences.delete(owner);
}

/**
 * Put a session under quarantine. Logs once per process (pids belong in the daemon log).
 * `alsoLift` is a second fence owner (the retiring entry) that changes hands in the same step.
 */
export function quarantineSession(
  sessionKey: string,
  pty: PtyProcess,
  reason: string,
  alsoLift?: object,
): void {
  // Record and fence change hands in one synchronous step: no moment with neither.
  fences.delete(pty);
  if (alsoLift) fences.delete(alsoLift);
  if (records.some((r) => r.pty === pty)) return;
  records.push({ sessionKey, pty, reason, since: Date.now() });
  console.warn(
    `[pty-supervisor] session ${sessionKey} quarantined (${reason}): pid ${pty.pid} not confirmed gone after SIGKILL; nothing starts on it until the OS confirms the exit`,
  );
}

function matchesIds(key: string, pty: PtyProcess, t: SessionTarget): boolean {
  if (t.sessionKey !== undefined && key === t.sessionKey) return true;
  const id = pty.sessionId;
  return Boolean(t.sessionId) && Boolean(id) && id === t.sessionId;
}

function matches(r: QuarantineRecord, t: SessionTarget): boolean {
  return matchesIds(r.sessionKey, r.pty, t);
}

function isFenced(t: SessionTarget): boolean {
  for (const f of fences.values()) {
    if (t.sessionKey !== undefined && f.sessionKey === t.sessionKey) return true;
    const id = f.sessionId();
    if (t.sessionId && id && id === t.sessionId) return true;
  }
  return false;
}

/** True while a process on the session is not proven dead. Synchronous: no retry. */
export function isSessionQuarantined(target: SessionTarget): boolean {
  return records.some((r) => matches(r, target));
}

async function tryRelease(r: QuarantineRecord): Promise<void> {
  try {
    await (r.pty.confirmExit ? r.pty.confirmExit() : r.pty.dispose());
  } catch {
    return;
  }
  records = records.filter((x) => x !== r);
}

/**
 * Wait for `p`, or give up when `opts.deadline` passes or `opts.signal` fires. `p` is not
 * cancelled: it is the confirmation, which must run to its end whoever stops waiting.
 */
function waitBounded(p: Promise<unknown>, opts: GateOptions): Promise<void> {
  const left = opts.deadline === undefined ? Infinity : opts.deadline - Date.now();
  if (opts.signal?.aborted) return Promise.reject(new SessionGateInterrupted("aborted"));
  if (left <= 0) return Promise.reject(new SessionGateInterrupted("timeout"));
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      done();
      reject(new SessionGateInterrupted("aborted"));
    };
    const done = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    if (left !== Infinity) {
      timer = setTimeout(() => {
        done();
        reject(new SessionGateInterrupted("timeout"));
      }, left);
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      () => {
        done();
        resolve();
      },
      () => {
        done();
        resolve();
      },
    );
  });
}

/**
 * The gate. Resolves when no process is quarantined on the session, after asking each one
 * that is to prove its exit again (identity-checked, see `PtyProcessImpl`). Throws
 * `PtyQuarantinedError` while one still lives, and `SessionGateInterrupted` when the
 * caller's `deadline` or `signal` ends the wait first (the quarantine is kept, never
 * released on a timeout).
 *
 * It does not look at fences: a retirement in flight is the caller's to wait out (the
 * supervisor does), and `assertSessionSpawnable` is what refuses a spawn beside it.
 */
export async function assertSessionWritable(
  target: SessionTarget,
  opts?: GateOptions,
): Promise<void> {
  const hits = records.filter((r) => matches(r, target));
  if (hits.length === 0) return;
  const confirmation = Promise.all(hits.map(tryRelease));
  if (opts && (opts.deadline !== undefined || opts.signal)) await waitBounded(confirmation, opts);
  else await confirmation;
  if (records.some((r) => matches(r, target))) {
    throw new PtyQuarantinedError(target.sessionKey ?? target.sessionId ?? "session");
  }
}

/**
 * The final word before a process is created for a session. SYNCHRONOUS: no await, so
 * nothing can change between this check and the spawn on the next line. Throws
 * `PtyQuarantinedError` for a session that is quarantined or whose retirement has begun.
 */
export function assertSessionSpawnable(target: SessionTarget): void {
  const label = target.sessionKey ?? target.sessionId ?? "session";
  if (records.some((r) => matches(r, target))) throw new PtyQuarantinedError(label);
  if (isFenced(target)) throw new PtyQuarantinedError(label, true);
}

/** Re-ask every quarantined process to prove its exit; returns how many are still alive. */
export async function confirmAllQuarantined(): Promise<number> {
  await Promise.all([...records].map(tryRelease));
  return records.length;
}

/** The quarantined sessions, for status. Sorted by key. */
export function quarantineSnapshot(): QuarantineInfo[] {
  return records
    .map((r) => ({
      sessionKey: r.sessionKey,
      sessionId: r.pty.sessionId,
      pid: r.pty.pid,
      reason: r.reason,
      since: r.since,
    }))
    .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

/** Keys of the quarantined sessions (unique). */
export function quarantinedKeys(): string[] {
  return [...new Set(records.map((r) => r.sessionKey))];
}

/** For tests only. */
export function __resetQuarantineForTests(): void {
  records = [];
  fences.clear();
}
