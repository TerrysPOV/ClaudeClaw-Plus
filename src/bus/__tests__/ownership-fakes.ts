/**
 * Shared fakes for the #595 round 3 ownership tests: an in-memory record store and a scripted
 * process probe that logs every read, signal and record change into one ordered event list.
 *
 * Round 5b: nothing here waits on the wall clock. `FakeClock` is moved by hand, `manual()` is
 * settled by hand, and `OsProbe` answers when the OS does, however long a loaded machine takes.
 */
import {
  createSystemProbe,
  type GuardClock,
  type OwnershipRecord,
  type OwnershipStore,
  type ProcessInfo,
  type ProcessProbe,
} from "../session-ownership";

export const SID = "5b7d1c2e-0000-4000-8000-0000000005a5";
export const UID = 501;

/** A claude process as the probe reads it; `argv` and `command` are kept consistent. */
export function claudeInfo(over: Partial<ProcessInfo> = {}): ProcessInfo {
  const argv = over.argv ?? [
    "/home/u/.local/bin/claude",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    SID,
  ];
  return {
    pid: 900,
    uid: UID,
    identity: "T1",
    zombie: false,
    argv,
    command: argv.join(" "),
    ...over,
  };
}

/** A record the previous daemon boot wrote for `claudeInfo()`. */
export function recordFor(over: Partial<OwnershipRecord> = {}): OwnershipRecord {
  return {
    agentId: "a",
    sessionId: SID,
    pid: 900,
    identity: "T1",
    bootId: "boot-old",
    exe: "claude",
    spawnedAt: "2026-10-23T10:00:00.000Z",
    ...over,
  };
}

/** A promise the test settles by hand. */
export function manual<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The guard's clock, moved by hand. `advance(ms)` fires every timer that falls due, in order, and
 * leaves `now()` at the target. `armed()` is event-driven: it resolves when a timer is pending.
 */
export class FakeClock implements GuardClock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private waiters: Array<() => void> = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    const ready = this.waiters;
    this.waiters = [];
    for (const w of ready) w();
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  /** Resolves once at least one timer is pending (now, or when the next is armed). */
  armed(): Promise<void> {
    if (this.timers.size > 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers)
        if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = target;
  }
}

export class MemoryStore implements OwnershipStore {
  readonly rec = new Map<string, OwnershipRecord>();
  readError: Error | null = null;
  stallRead = false;
  constructor(private readonly events: string[] = []) {}

  async read(agentId: string): Promise<OwnershipRecord | null> {
    this.events.push("store.read");
    if (this.stallRead) return new Promise(() => {});
    if (this.readError) throw this.readError;
    const r = this.rec.get(agentId);
    return r ? { ...r } : null;
  }
  async write(record: OwnershipRecord): Promise<void> {
    this.events.push("store.write");
    this.rec.set(record.agentId, { ...record });
  }
  async clear(agentId: string, expect: { pid: number; identity: string }): Promise<void> {
    const cur = this.rec.get(agentId);
    if (cur && (cur.pid !== expect.pid || cur.identity !== expect.identity)) return;
    this.events.push("store.clear");
    this.rec.delete(agentId);
  }
}

/**
 * A process table the test scripts. `table` is consulted on every `read`; `onKill` lets a test
 * make a process die (or not) when it is signalled. Every call is appended to `events`.
 */
export class FakeProbe implements ProcessProbe {
  readonly table = new Map<number, ProcessInfo>();
  readonly kills: Array<{ pid: number; signal: string }> = [];
  readonly reads: number[] = [];
  /** The `timeoutMs` the guard handed each `read`, in call order (same index as `reads`). */
  readonly readTimeouts: number[] = [];
  private readWaiters: Array<{ n: number; resolve: () => void }> = [];
  failure: Error | null = null;
  stall = false;
  /** Reads of this one pid never answer (a record's process, while spawns of the test still work). */
  stallPid: number | null = null;
  /** Called for every `read`, before the table; may return a replacement answer. */
  intercept: ((pid: number, nth: number) => ProcessInfo | null | undefined) | null = null;
  onKill: (pid: number, signal: string) => void = () => {};
  /** When set, a pid not in `table` still reads as alive: a process that cannot be proven dead. */
  alwaysAlive: ProcessInfo | null = null;
  constructor(private readonly events: string[] = []) {}

  /** Resolves once `n` reads have been issued (event-driven; the nth may still be unanswered). */
  readIssued(n: number): Promise<void> {
    if (this.reads.length >= n) return Promise.resolve();
    return new Promise((resolve) => this.readWaiters.push({ n, resolve }));
  }

  async read(pid: number, timeoutMs = Number.NaN): Promise<ProcessInfo | null> {
    this.reads.push(pid);
    this.readTimeouts.push(timeoutMs);
    this.events.push(`read:${pid}`);
    this.readWaiters = this.readWaiters.filter((w) => {
      if (this.reads.length < w.n) return true;
      w.resolve();
      return false;
    });
    if (this.stall || pid === this.stallPid) return new Promise(() => {});
    if (this.failure) throw this.failure;
    const nth = this.reads.filter((p) => p === pid).length;
    const replaced = this.intercept?.(pid, nth);
    if (replaced !== undefined) return replaced ? { ...replaced } : null;
    const p = this.table.get(pid) ?? this.alwaysAlive;
    return p ? { ...p, pid } : null;
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push({ pid, signal });
    this.events.push(`kill:${signal}`);
    this.onKill(pid, signal);
  }
}

/** What `OsProbe` saw the first time a spawned process was read. */
export interface SpawnedProcess {
  pid: number;
  argv: string[];
  /** Earlier spawns and watched pids still running (not gone, not a zombie) at that moment. */
  aliveAtStart: number[];
}

/**
 * The production probe (`createSystemProbe`: `/proc` or one `ps` per read) with the per-read
 * timeout lifted, so a loaded machine slows a read down instead of failing it. It also logs, from
 * what the OS reports, every process the manager spawned: the first read of a pid nobody `watch`ed
 * is the spawn's own identity read. `aliveAtStart` is checked BEFORE that read returns, so the
 * ordering "the previous process was gone before the next one existed" rests on the OS, not on a
 * stand-in script that may not have started yet.
 */
export class OsProbe implements ProcessProbe {
  private readonly inner = createSystemProbe();
  private readonly watched = new Set<number>();
  private readonly known = new Set<number>();
  readonly spawned: SpawnedProcess[] = [];
  readonly kills: Array<{ pid: number; signal: string }> = [];

  /** Far above any realistic read; the guard's own deadline is raised to match by the tests. */
  static readonly READ_MS = 120_000;

  /** A process the test started itself (an orphan): never counted as a spawn. */
  watch(pid: number): void {
    this.watched.add(pid);
    this.known.add(pid);
  }
  inspect(pid: number): Promise<ProcessInfo | null> {
    return this.inner.read(pid, OsProbe.READ_MS);
  }

  async read(pid: number): Promise<ProcessInfo | null> {
    const first = !this.known.has(pid);
    if (first) this.known.add(pid);
    let aliveAtStart: number[] = [];
    if (first) {
      const others = [...this.known].filter((p) => p !== pid);
      const infos = await Promise.all(others.map((p) => this.inspect(p)));
      aliveAtStart = others.filter((_, i) => {
        const info = infos[i];
        return info !== null && info !== undefined && !info.zombie;
      });
    }
    const info = await this.inspect(pid);
    if (first && info) {
      this.spawned.push({
        pid,
        argv: info.argv ?? info.command.split(/\s+/).filter(Boolean),
        aliveAtStart,
      });
    }
    return info;
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push({ pid, signal });
    this.inner.kill(pid, signal);
  }
}
