/**
 * Shared fakes for the #595 round 3 ownership tests: an in-memory record store and a scripted
 * process probe that logs every read, signal and record change into one ordered event list.
 */
import type {
  OwnershipRecord,
  OwnershipStore,
  ProcessInfo,
  ProcessProbe,
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
  failure: Error | null = null;
  stall = false;
  /** Called for every `read`, before the table; may return a replacement answer. */
  intercept: ((pid: number, nth: number) => ProcessInfo | null | undefined) | null = null;
  onKill: (pid: number, signal: string) => void = () => {};
  /** When set, a pid not in `table` still reads as alive: a process that cannot be proven dead. */
  alwaysAlive: ProcessInfo | null = null;
  constructor(private readonly events: string[] = []) {}

  async read(pid: number): Promise<ProcessInfo | null> {
    this.reads.push(pid);
    this.events.push(`read:${pid}`);
    if (this.stall) return new Promise(() => {});
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
