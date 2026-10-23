/**
 * #595 round 3, at the SessionManager: (1) a restart ends only a process the ownership record
 * proves this daemon spawned in an earlier boot, and proves it gone before the session is resumed;
 * (2) `/clear` is a controlled restart on a freshly minted id.
 *
 * Supervision is `process` throughout: no bun-pty, and no trust self-heal. The orphans are REAL
 * processes, read by the production probe (`OsProbe` wraps `createSystemProbe`). Ordering is
 * asserted on what the OS reported about each spawned process (`OsProbe.spawned`), not on a
 * stand-in script that may not have started yet.
 *
 * Round 4 adds: a spawn whose process cannot be recorded is ended and fails; spawn, restart and
 * `/clear` share one lifecycle queue per agent; `/clear` succeeds only on a live replacement.
 *
 * Round 5b: no test here races the wall clock. A loaded machine (load average 100+) made these
 * fail with no fault injected, from three causes, each removed:
 *  - the stand-in `claude` had not written its argv/pid files when the test read them, so every
 *    read of the stand-in's files now waits for its `ready.<pid>` marker (`started`);
 *  - the production bounds (the guard deadline, the record steps, the orphan's SIGTERM stage, a
 *    `ps` read) raced a slow `ps` or a slow `sh`, so real-process tests run with those bounds far
 *    above any runtime (`LOADED`, `OsProbe.READ_MS`), while the fault tests that need a bound to
 *    EXPIRE use a fake probe that cannot be slow;
 *  - fixed sleeps and elapsed-time assertions are gone: a pending write is a promise the test
 *    settles by hand, and "the guard honours its deadline" is read off the `timeoutMs` the guard
 *    handed the probe (the deadline arithmetic itself is driven by a fake clock in
 *    `session-ownership.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetQuarantineForTests,
  assertSessionWritable,
  isSessionQuarantined,
} from "../../runner/pty-quarantine";
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import {
  ClearReplacementExitedError,
  resolveAgentCwd,
  SessionManager,
  type SessionManagerOptions,
  SpawnUnrecordedError,
} from "../session-manager";
import type { ProcessInfo, ProcessProbe } from "../session-ownership";
import type { AgentConfig } from "../types";
import { wireSlashCommands } from "../wiring";
import {
  claudeInfo,
  FakeProbe,
  manual,
  MemoryStore,
  OsProbe,
  SID,
  type SpawnedProcess,
} from "./ownership-fakes";

const BOOT = "boot-now";
/** Every bound a real-process test must not race, set far above a loaded machine's slowest step. */
const LOADED = 120_000;
/** The stand-in `claude` is `sleep 60`: a retirement test that outlasts this is not a retirement. */
const T = 120_000;

type SlashHandler = (agentId: string, cmd: string) => Promise<void>;

describe("SessionManager — ownership guard and /clear (#595 r3)", () => {
  let dir: string;
  let projectsDir: string;
  let cwd: string;
  let mgr: SessionManager | undefined;
  let warned: string[];
  let errored: string[];
  let persisted: Array<{ agentId: string; sessionId: string }>;
  let store: MemoryStore;
  let os: OsProbe;
  let orphan: ChildProcess | undefined;
  /** The options the manager was built with; it reads them at each spawn, so a test may adjust one. */
  let opts: SessionManagerOptions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-own-mgr-"));
    projectsDir = join(dir, "projects");
    cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    cwd = resolveAgentCwd(cwd);
    warned = [];
    errored = [];
    persisted = [];
    store = new MemoryStore();
    os = new OsProbe();
    __resetQuarantineForTests();
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    mgr = undefined;
    // SIGTERM: the orphan's trap ends its background `sleep` too.
    if (orphan && orphan.exitCode === null) orphan.kill("SIGTERM");
    orphan = undefined;
    __resetQuarantineForTests();
    rmSync(dir, { recursive: true, force: true });
    // `stop()` always waits its 2 s /quit grace before SIGTERM; the hook default (5 s) is not enough.
  }, T);

  function writeTranscript(id: string): void {
    const d = join(projectsDir, encodeCwdForProjectsDir(cwd));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.jsonl`), '{"type":"user"}\n');
  }

  /**
   * Stand-in `claude`: its argv to `argv.<pid>`, then (unless `die` exists) `ready.<pid>`, then it
   * stays up. Files are keyed by pid, so nothing depends on the order the stand-ins start in, or on
   * a stand-in that was retired before it ever ran. It does NOT `exec` into `sleep`: its command
   * line, which `OsProbe` reads from the OS, stays `sh claude.sh <args>` however late it is read.
   */
  function standIn(): string {
    const script = join(dir, "claude.sh");
    writeFileSync(
      script,
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/argv.$$"
if [ -f "${dir}/die" ]; then exit 1; fi
sleep 30 &
p=$!
trap 'kill $p 2>/dev/null; exit 0' TERM
: > "${dir}/ready.$$"
wait $p
`,
    );
    chmodSync(script, 0o755);
    return script;
  }

  /**
   * Wait for `cond`, polling a cheap local condition. The bound is far above any realistic runtime
   * and a miss FAILS (a silent fall-through is how a slow start used to read as a wrong answer).
   */
  const until = async (cond: () => boolean, what: string, ms = 90_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** The stand-in with this pid has run its script (its argv file is complete). */
  const started = (pid: number): Promise<void> =>
    until(() => existsSync(join(dir, `ready.${pid}`)), `stand-in ${pid} to start`);
  const argvOf = (pid: number): string[] =>
    readFileSync(join(dir, `argv.${pid}`), "utf8")
      .split("\n")
      .filter(Boolean);
  const flagValue = (argv: string[], flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const idOfArgv = (argv: string[]): string | undefined =>
    flagValue(argv, "--session-id") ?? flagValue(argv, "--resume");
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** The OS has finished with `pid` (a reaped zombie takes a moment to leave the table). */
  const exited = (pid: number): Promise<void> =>
    until(() => !alive(pid), `pid ${pid} to exit`, 15_000);
  const livePid = (): number => mgr?.getAgent("a")?.pid as number;
  const errLines = (reason: string): string[] =>
    errored.filter((l) => l.includes(`reason=${reason}`));

  function manager(
    over: {
      probe?: ProcessProbe;
      persist?: (a: string, s: string) => Promise<void>;
      store?: boolean;
      guardMs?: number;
      stageMs?: number;
      platform?: NodeJS.Platform;
    } = {},
  ): SessionManager {
    opts = {
      commandOverride: standIn(),
      busSocketPath: join(dir, "bus.sock"),
      projectsDir,
      sessionCollisionDetectMs: 600,
      postMortemDir: join(dir, "post-mortem"),
      ownershipStore: over.store === false ? undefined : store,
      processProbe: over.probe ?? os,
      platform: over.platform,
      bootId: BOOT,
      ownershipGuardMs: over.guardMs ?? LOADED,
      ownershipTermMs: over.stageMs ?? 30_000,
      ownershipRecordMs: LOADED,
      persistRotatedSessionId:
        over.persist ??
        (async (agentId, sessionId) => {
          persisted.push({ agentId, sessionId });
        }),
      logger: {
        warn: (...a) => warned.push(a.join(" ")),
        info: () => {},
        error: (...a) => errored.push(a.join(" ")),
      },
    };
    mgr = new SessionManager(opts);
    return mgr;
  }

  const agentConfig = (): AgentConfig => ({
    id: "a",
    cwd,
    session_id: SID,
    permission_mode: "bypassPermissions",
    supervision: "process",
  });

  /**
   * A real process "left behind": argv `sh fake-claude.sh --resume <id>`, ends on SIGTERM. It
   * reports `orphan.ready` once its trap is installed, so no test guesses how long `sh` takes.
   */
  async function startOrphan(): Promise<{ pid: number; identity: string }> {
    const script = join(dir, "fake-claude.sh");
    writeFileSync(
      script,
      `#!/bin/sh
sleep 120 &
p=$!
trap 'kill $p 2>/dev/null; exit 0' TERM
: > "${dir}/orphan.ready"
wait $p
`,
    );
    chmodSync(script, 0o755);
    orphan = spawn("/bin/sh", [script, "--resume", SID], { stdio: "ignore" });
    const pid = orphan.pid as number;
    os.watch(pid);
    await until(() => existsSync(join(dir, "orphan.ready")), "the orphan to start");
    const info = await os.inspect(pid);
    if (!info) throw new Error("orphan did not start");
    return { pid, identity: info.identity };
  }

  const seed = (o: { pid: number; identity: string }, over: { bootId?: string } = {}): void => {
    store.rec.set("a", {
      agentId: "a",
      sessionId: SID,
      pid: o.pid,
      identity: o.identity,
      bootId: over.bootId ?? "boot-old",
      exe: "fake-claude.sh",
      spawnedAt: "2026-10-23T10:00:00.000Z",
    });
  };

  const orphanAlive = (): boolean => alive(orphan?.pid as number);

  /**
   * The stand-in as a fake probe reads it: microsecond identity, this daemon's uid, and the argv the
   * manager launched (`sh claude.sh --session-id <id>`). Since #595 r9 a retirement signals only a
   * process that passes the same gate as `decideResume`, so a fake that is to be SIGKILLed must be one.
   */
  const standInInfo = (over: Partial<ProcessInfo> = {}): ProcessInfo =>
    claudeInfo({
      identity: "T1+000001",
      uid: process.getuid?.() ?? -1,
      argv: ["sh", join(dir, "claude.sh"), "--session-id", SID],
      ...over,
    });

  /* ── ownership at restart ─────────────────────────────────────────── */

  it(
    "a previous-boot orphan is revalidated, ended and confirmed gone BEFORE the session is resumed",
    async () => {
      // Fault (site: the `decideResume` call in `spawnAgentInternal`, removed): the new process starts
      // beside the live orphan. Predicted result: `aliveAtStart` is `[orphan.pid]`, not `[]`.
      writeTranscript(SID);
      const o = await startOrphan();
      seed(o);
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(os.spawned).toHaveLength(1);
      expect(os.spawned[0]?.aliveAtStart).toEqual([]);
      expect(os.kills).toEqual([{ pid: o.pid, signal: "SIGTERM" }]);
      expect(flagValue(argvOf(proc.pid), "--resume")).toBe(SID);
      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      expect(warned.filter((l) => l.includes("reason=resume-orphan-reaped"))).toHaveLength(1);
    },
    T,
  );

  it(
    "pid reused by another process (different start identity): not signalled, session resumed",
    async () => {
      // Fault (site: identity comparison in `departed`, removed): the stranger is ended.
      // Predicted result: `kills` is `[SIGTERM → orphan]` and `aliveAtStart` is `[]`.
      writeTranscript(SID);
      const o = await startOrphan();
      seed({ pid: o.pid, identity: "a-different-start-identity" });
      const proc = await manager().spawnAgent(agentConfig(), "cli");
      await started(proc.pid);

      expect(os.spawned[0]?.aliveAtStart).toEqual([o.pid]);
      expect(os.kills).toEqual([]);
      expect(orphanAlive()).toBe(true);
      expect(flagValue(argvOf(proc.pid), "--resume")).toBe(SID);
      expect(persisted).toHaveLength(0);
    },
    T,
  );

  it(
    "a record from THIS boot whose process is alive: never signalled, the session rotates",
    async () => {
      // Fault (site: the boot-id comparison, removed): the daemon ends a process it manages.
      // Predicted result: `kills` has the orphan and nothing is rotated.
      writeTranscript(SID);
      seed(await startOrphan(), { bootId: BOOT });
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(os.kills).toEqual([]);
      expect(orphanAlive()).toBe(true);
      expect(persisted).toHaveLength(1);
      const fresh = persisted[0]?.sessionId as string;
      expect(fresh).not.toBe(SID);
      const argv = argvOf(proc.pid);
      expect(flagValue(argv, "--session-id")).toBe(fresh);
      expect(argv).not.toContain("--resume");
      expect(warned.filter((l) => l.includes("reason=current-boot-owner-alive"))).toHaveLength(1);
    },
    T,
  );

  it(
    "an unrecorded claude that names the session is never signalled; the session is resumed",
    async () => {
      // Fault (site: a guard that searches for any process holding the id): it would be ended.
      // Predicted result: `kills` has the orphan and `aliveAtStart` is `[]`.
      writeTranscript(SID);
      const o = await startOrphan();
      const proc = await manager().spawnAgent(agentConfig(), "cli");
      await started(proc.pid);

      expect(os.spawned[0]?.aliveAtStart).toEqual([o.pid]);
      expect(os.kills).toEqual([]);
      expect(orphanAlive()).toBe(true);
      expect(flagValue(argvOf(proc.pid), "--resume")).toBe(SID);
      expect(persisted).toHaveLength(0);
    },
    T,
  );

  it(
    "an unreadable record: nothing is signalled, the session rotates, the reason is logged",
    async () => {
      // Fault (site: the `readError` branch of `decideResume`, resuming on a failed read): the
      // session is resumed beside the orphan. Predicted result: `persisted` is empty.
      writeTranscript(SID);
      await startOrphan();
      store.readError = new Error("EACCES: owner.json");
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(os.kills).toEqual([]);
      expect(orphanAlive()).toBe(true);
      expect(persisted).toHaveLength(1);
      expect(flagValue(argvOf(proc.pid), "--session-id")).toBe(persisted[0]?.sessionId);
      expect(warned.filter((l) => l.includes("reason=ownership-record-unreadable"))).toHaveLength(
        1,
      );
      expect(warned.join("\n")).not.toContain("EACCES");
    },
    T,
  );

  it(
    "a process read that times out: nothing is signalled, the session rotates within the guard deadline",
    async () => {
      // Fault (site: `ownershipGuardMs` not forwarded to `decideResume`, so the 5 s default applies):
      // the guard hands the probe a 1500 ms read timeout instead of one capped by the 400 ms left.
      // Predicted result: the first read of pid 4242 carries `timeoutMs` 1500, not <= 400.
      // The deadline itself (that it fires at `deadlineMs`, not before) is driven by a fake clock in
      // `session-ownership.test.ts`; here a stalled read cannot be answered, so the only way the spawn
      // resolves is the real 400 ms deadline firing.
      writeTranscript(SID);
      seedFake();
      const probe = new FakeProbe();
      probe.stallPid = 4242; // the seeded record's process; the new spawn's own record still works
      const agent = agentConfig();
      const proc = await manager({ probe, guardMs: 400 }).spawnAgent(agent, "cli");
      await started(proc.pid);

      const firstRead = probe.reads.indexOf(4242);
      expect(firstRead).toBeGreaterThanOrEqual(0);
      expect(probe.readTimeouts[firstRead]).toBeLessThanOrEqual(400);
      expect(probe.kills).toEqual([]);
      expect(persisted).toHaveLength(1);
      expect(warned.filter((l) => l.includes("reason=guard-deadline"))).toHaveLength(1);
    },
    T,
  );

  function seedFake(): void {
    store.rec.set("a", {
      agentId: "a",
      sessionId: SID,
      pid: 4242,
      identity: "T1",
      bootId: "boot-old",
      exe: "claude",
      spawnedAt: "2026-10-23T10:00:00.000Z",
    });
  }

  it(
    "a first boot (no record, no transcript) starts on --session-id with nothing rotated or signalled",
    async () => {
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      const argv = argvOf(proc.pid);
      expect(flagValue(argv, "--session-id")).toBe(SID);
      expect(argv).not.toContain("--resume");
      expect(persisted).toHaveLength(0);
      expect(os.kills).toEqual([]);
      expect(warned).toEqual([]);
      expect(store.rec.get("a")?.pid).toBe(proc.pid);
    },
    T,
  );

  /* ── a record with no transcript (#595 r10) ───────────────────────── */

  it(
    "a previous-boot orphan that never wrote a transcript is reaped and confirmed gone, then the id is started again: one process, and the record names it",
    async () => {
      // Fault (site: `resume &&` restored in front of the `decideResume` guard in `spawnAgentInternal`):
      // the decision is skipped without a transcript, the new claude starts beside the live orphan and
      // overwrites its record. Predicted result: `aliveAtStart` is `[orphan.pid]` and `kills` is empty.
      const o = await startOrphan();
      seed(o);
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(os.spawned).toHaveLength(1);
      expect(os.spawned[0]?.aliveAtStart).toEqual([]);
      expect(os.kills).toEqual([{ pid: o.pid, signal: "SIGTERM" }]);
      await exited(o.pid);
      const argv = argvOf(proc.pid);
      expect(flagValue(argv, "--session-id")).toBe(SID);
      expect(argv).not.toContain("--resume");
      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      expect(store.rec.get("a")?.pid).toBe(proc.pid);
      expect(warned.filter((l) => l.includes("reason=resume-orphan-reaped"))).toHaveLength(1);
    },
    T,
  );

  it(
    "the transcript is looked at again after the orphan is reaped: one it wrote while ending is resumed",
    async () => {
      // Fault (site: `resume = transcriptExists()` after a reap, removed): the id is started with
      // `--session-id` over a transcript that now exists, which claude refuses as 'already in use'.
      // Predicted result: `--session-id` is in the argv and `--resume` is not.
      const o = await startOrphan();
      seed(o);
      const clear = store.clear.bind(store);
      store.clear = async (agentId, expect) => {
        writeTranscript(SID); // the orphan's first line lands while it is being ended
        await clear(agentId, expect);
      };
      const proc = await manager().spawnAgent(agentConfig(), "cli");
      await started(proc.pid);

      const argv = argvOf(proc.pid);
      expect(flagValue(argv, "--resume")).toBe(SID);
      expect(argv).not.toContain("--session-id");
      expect(persisted).toHaveLength(0);
    },
    T,
  );

  it(
    "a record from THIS boot whose process is alive, with no transcript: never signalled, the session rotates",
    async () => {
      const o = await startOrphan();
      seed(o, { bootId: BOOT });
      const agent = agentConfig();
      const proc = await manager().spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(os.kills).toEqual([]);
      expect(orphanAlive()).toBe(true);
      expect(persisted).toHaveLength(1);
      const fresh = persisted[0]?.sessionId as string;
      expect(fresh).not.toBe(SID);
      expect(flagValue(argvOf(proc.pid), "--session-id")).toBe(fresh);
      expect(warned.filter((l) => l.includes("reason=current-boot-owner-alive"))).toHaveLength(1);
    },
    T,
  );

  describe("a previous-boot orphan that cannot be proven ours, with no transcript, rotates untouched (#595 r10)", () => {
    /** The orphan's pid and record as a fake probe reads them; the new spawn's own pid is not in the table. */
    async function rotatesAround(live: Partial<ProcessInfo>): Promise<void> {
      const rec = {
        agentId: "a",
        sessionId: SID,
        pid: 4242,
        identity: "T1+000001",
        bootId: "boot-old",
        exe: "claude",
        spawnedAt: "2026-10-23T10:00:00.000Z",
      };
      store.rec.set("a", rec);
      const probe = new FakeProbe();
      probe.table.set(
        4242,
        claudeInfo({
          pid: 4242,
          identity: "T1+000001",
          uid: process.getuid?.() ?? -1,
          argv: ["/usr/bin/claude", "--session-id", SID],
          ...live,
        }),
      );
      const agent = agentConfig();
      const proc = await manager({ probe }).spawnAgent(agent, "cli");
      await started(proc.pid);

      expect(probe.kills).toEqual([]);
      expect(store.rec.get("a")).toEqual(rec);
      expect(persisted).toHaveLength(1);
      expect(flagValue(argvOf(proc.pid), "--session-id")).toBe(persisted[0]?.sessionId);
      expect(persisted[0]?.sessionId).not.toBe(SID);
    }

    it("a foreign uid", async () => {
      await rotatesAround({ uid: (process.getuid?.() ?? 0) + 1 });
      expect(warned.filter((l) => l.includes("reason=owner-uid-mismatch"))).toHaveLength(1);
    });

    it("a second-precise identity", async () => {
      await rotatesAround({ identity: "T1", lowPrecision: true });
      expect(warned.filter((l) => l.includes("reason=resume-identity-low-precision"))).toHaveLength(
        1,
      );
    });
  });

  it(
    "with no store configured the bus keeps no records and resumes as before",
    async () => {
      writeTranscript(SID);
      const proc = await manager({ store: false }).spawnAgent(agentConfig(), "cli");
      await started(proc.pid);
      expect(flagValue(argvOf(proc.pid), "--resume")).toBe(SID);
      expect(store.rec.size).toBe(0);
    },
    T,
  );

  it(
    "win32 keeps its pre-#595 behaviour: no record is written, none is read, the spawn succeeds and the session is resumed",
    async () => {
      // Fault (site: `ownershipGuardApplies` in `recordSpawnOwnership`, removed): on Windows the POSIX
      // `ps` read fails and the (now fatal) record failure retires every child. Predicted result: the
      // spawn rejects with `SpawnUnrecordedError`.
      writeTranscript(SID);
      store.readError = new Error("must not be read on win32");
      let writes = 0;
      store.write = async () => {
        writes += 1;
      };
      const probe = new FakeProbe();
      probe.failure = new Error("ps: command not found");
      const proc = await manager({ probe, platform: "win32" }).spawnAgent(agentConfig(), "cli");
      await started(proc.pid);

      expect(proc.pid).toBeGreaterThan(0);
      expect(flagValue(argvOf(proc.pid), "--resume")).toBe(SID);
      expect(persisted).toHaveLength(0);
      expect(writes).toBe(0);
      expect(probe.reads).toEqual([]);
      expect(errored.filter((l) => l.includes("ownership-record-failed"))).toEqual([]);
      expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
      expect(mgr?.getAgent("a")?.pid).toBe(proc.pid);
    },
    T,
  );

  /* ── the record itself ────────────────────────────────────────────── */

  it(
    "spawn writes an ownership record for the process it started, and it is cleared once the OS confirms the exit",
    async () => {
      // Fault (site: `recordSpawnOwnership` call, removed): no record, so a later restart could
      // never prove ownership. Predicted result: `store.rec.get("a")` is undefined.
      const m = manager();
      const proc = await m.spawnAgent(agentConfig(), "cli");

      const rec = store.rec.get("a");
      expect(rec?.pid).toBe(proc.pid);
      expect(rec?.sessionId).toBe(SID);
      expect(rec?.bootId).toBe(BOOT);
      expect(rec?.exe).toBe("claude.sh");
      expect(rec?.identity.length).toBeGreaterThan(3);

      await m.stop("a");
      await until(() => !store.rec.has("a"), "the record to be cleared");
      expect(store.rec.has("a")).toBe(false);
    },
    T,
  );

  it(
    "a record that cannot be written ends the child and fails the spawn: no record, and nothing of ours left",
    async () => {
      // Fault (site: the `if (recordFailure)` branch in `spawnAgentInternal`, write failure tolerated
      // again as in round 3): the child keeps running unrecorded. Predicted result: the spawn
      // resolves and the child is still alive when `exited` gives up.
      store.write = async () => {
        throw Object.assign(new Error("secret path /x/owner.json"), { code: "ENOSPC" });
      };
      const m = manager();
      const err = await m.spawnAgent(agentConfig(), "cli").then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(SpawnUnrecordedError);
      expect((err as SpawnUnrecordedError).code).toBe("ownership-record-failed");
      expect((err as SpawnUnrecordedError).retired).toBe(true);
      // The child's pid is the one its identity was read for (its stand-in may never have run).
      expect(os.spawned).toHaveLength(1);
      const child = (os.spawned[0] as SpawnedProcess).pid;
      await exited(child);
      expect(alive(child)).toBe(false);
      expect(store.rec.size).toBe(0);
      expect(m._list()).toEqual([]);
      expect(m.getAgent("a")).toBeUndefined();
      expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
      // One line, a reason code and the errno; nothing the child or the error message printed.
      const lines = errLines("ownership-record-failed");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("cause=ENOSPC");
      expect(lines[0]).not.toContain("secret path");
    },
    T,
  );

  it(
    "a record that cannot be written AND a child that is not confirmed gone: the session is quarantined",
    async () => {
      // Fault (site: `retireLive`, the confirmation ignored): the failed spawn leaves a child that may
      // still write and no quarantine. Predicted result: `isSessionQuarantined` is false.
      store.write = async () => {
        throw new Error("EROFS");
      };
      const probe = new FakeProbe();
      probe.alwaysAlive = standInInfo();
      const m = manager({ probe, stageMs: 150 });
      const err = await m.spawnAgent(agentConfig(), "cli").then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(SpawnUnrecordedError);
      expect((err as SpawnUnrecordedError).retired).toBe(false);
      expect(String((err as Error).message)).toContain("quarantined");
      expect(isSessionQuarantined({ sessionId: SID })).toBe(true);
      expect(probe.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
      expect(errLines("spawn-retire-unconfirmed")).toHaveLength(1);
      // The existing #562 gate holds the session until the OS confirms the exit.
      await expect(assertSessionWritable({ sessionId: SID })).rejects.toThrow("quarantined");
      probe.alwaysAlive = null;
      await assertSessionWritable({ sessionId: SID });
    },
    T,
  );

  describe("a failed ownership write signals only a process that passes the signal gate (#595 r9)", () => {
    const S = "Thu Oct 23 10:00:00 2026";
    /** Spawn with an unwritable record against a child the fake probe reads as `info`; return the signals sent. */
    async function failedWriteSignals(info: ProcessInfo): Promise<string[]> {
      store.write = async () => {
        throw new Error("EROFS");
      };
      const probe = new FakeProbe();
      probe.alwaysAlive = info;
      const m = manager({ probe, stageMs: 150 });
      const err = await m.spawnAgent(agentConfig(), "cli").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SpawnUnrecordedError);
      expect((err as SpawnUnrecordedError).retired).toBe(false);
      expect(isSessionQuarantined({ sessionId: SID })).toBe(true);
      return probe.kills.map((k) => k.signal);
    }

    it("second precision: nothing is signalled, the session is quarantined", async () => {
      // Fault (site: `confirmRetired`, the gate bypassed): a pid reused within the second is killed.
      // Predicted result: `["SIGKILL"]`.
      expect(await failedWriteSignals(standInInfo({ identity: S, lowPrecision: true }))).toEqual(
        [],
      );
    });

    it("a foreign uid: nothing is signalled", async () => {
      expect(await failedWriteSignals(standInInfo({ uid: (process.getuid?.() ?? 0) + 1 }))).toEqual(
        [],
      );
    });

    it("an argv that is not the launched claude: nothing is signalled", async () => {
      expect(
        await failedWriteSignals(standInInfo({ argv: ["sh", "other.sh", "--resume", SID] })),
      ).toEqual([]);
    });
  });

  it(
    "an identity that cannot be read fails the spawn the same way",
    async () => {
      const probe = new FakeProbe();
      probe.failure = new Error("ps: operation not permitted");
      const m = manager({ probe, stageMs: 150 });
      const err = await m.spawnAgent(agentConfig(), "cli").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SpawnUnrecordedError);
      expect((err as SpawnUnrecordedError).stage).toBe("identity-read");
      expect(store.rec.size).toBe(0);
      expect(errLines("ownership-record-failed")).toHaveLength(1);
    },
    T,
  );

  it(
    "the agent is not reported spawned, and gets no prompt, before its record exists",
    async () => {
      // Fault (site: `deliverable` hiding in `getAgent`, removed): the process is handed out while the
      // write is still pending. Predicted result: `getAgent("a")` is defined while the write waits.
      const write = store.write.bind(store);
      const writing = manual();
      const release = manual();
      store.write = async (r) => {
        writing.resolve();
        await release.promise;
        await write(r);
      };
      const m = manager();
      const spawning = m.spawnAgent(agentConfig(), "cli");
      await writing.promise;

      // The write is pending right now: the process exists and is not yet the caller's.
      expect(m.getAgent("a")).toBeUndefined();
      expect(m.recordingPending("a")).not.toBeNull();
      expect(store.rec.has("a")).toBe(false);

      release.resolve();
      const proc = await spawning;
      expect(store.rec.has("a")).toBe(true);
      expect(m.getAgent("a")?.pid).toBe(proc.pid);
      expect(m.recordingPending("a")).toBeNull();
    },
    T,
  );

  it(
    "a same-boot restart that keeps the id resumes it: the earlier process is confirmed exited",
    async () => {
      // Fault (site: the confirmation in `retireLive`, skipped): the new process starts while the
      // earlier one is still running. Predicted result: `aliveAtStart` is `[first.pid]`.
      writeTranscript(SID);
      const m = manager();
      const first = await m.spawnAgent(agentConfig(), "cli");
      await started(first.pid);
      await m.restart("a", { freshSession: false, reason: "manual" });
      const second = livePid();
      await started(second);

      expect(second).not.toBe(first.pid);
      expect(flagValue(argvOf(second), "--resume")).toBe(SID);
      expect(os.spawned).toHaveLength(2);
      expect(os.spawned[1]?.aliveAtStart).toEqual([]);
      expect(persisted).toHaveLength(0);
    },
    T,
  );

  it(
    "a preserving restart waits for the OS: an old pid still visible for a moment does not rotate the session",
    async () => {
      // Fault (site: the `retireLive` branch of `restartInternal`, back to a bare `stop()`): the
      // resume decision reads the same-boot record while the old pid is still visible. Predicted
      // result: `current-boot-owner-alive`, so `persisted` has one rotated id and `--resume` is absent.
      writeTranscript(SID);
      const probe = new FakeProbe();
      probe.alwaysAlive = standInInfo();
      // Read 1 of a pid is the spawn's identity read. Reads 2-4 find it still there: the exit event
      // has fired and the OS has not finished with it, and BOTH the exit handler's own confirmation
      // and the next start look. Fewer visible reads let the exit handler's poll clear the record
      // before the start reads it, which hides the fault (an injection showed it). From read 5 on it
      // is gone.
      probe.intercept = (_pid, nth) => (nth >= 5 ? null : undefined);
      const m = manager({ probe });
      const agent = agentConfig();
      const first = await m.spawnAgent(agent, "cli");
      await started(first.pid);

      await m.restart("a", { freshSession: false, reason: "manual" });
      const second = livePid();
      await started(second);

      expect(second).not.toBe(first.pid);
      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      expect(flagValue(argvOf(second), "--resume")).toBe(SID);
      expect(probe.reads.filter((p) => p === first.pid).length).toBeGreaterThanOrEqual(5);
      expect(errored.filter((l) => l.includes("rotating"))).toHaveLength(0);
    },
    T,
  );

  it(
    "a preserving restart whose old pid never leaves is the existing unconfirmed path: quarantined, same id, no rotation",
    async () => {
      // Fault (site: the same `retireLive` branch, a bare `stop()`): the restart rotates silently.
      // Predicted result: the promise resolves and `persisted` has one entry.
      writeTranscript(SID);
      const probe = new FakeProbe();
      probe.alwaysAlive = standInInfo();
      const m = manager({ probe, stageMs: 150 });
      const agent = agentConfig();
      await m.spawnAgent(agent, "cli");

      await expect(m.restart("a", { freshSession: false, reason: "manual" })).rejects.toThrow(
        "not confirmed gone",
      );

      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      // No second process: every spawn's identity is read before its `spawnAgent` resolves.
      expect(new Set(probe.reads).size).toBe(1);
      expect(isSessionQuarantined({ sessionId: SID })).toBe(true);
      expect(errLines("restart-retire-unconfirmed")).toHaveLength(1);
      probe.alwaysAlive = null;
      await assertSessionWritable({ sessionId: SID });
      expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
    },
    T,
  );

  /* ── /clear as a controlled restart ───────────────────────────────── */

  function wired(m: SessionManager): SlashHandler {
    let handler: SlashHandler | null = null;
    wireSlashCommands({ setSlashCommandHandler: (h: SlashHandler) => (handler = h) } as never, m);
    return handler as unknown as SlashHandler;
  }

  it(
    "/clear retires the old process BEFORE the new spawn, on `--session-id <new id>`, and stores that id",
    async () => {
      // Fault (site: `wiring.ts`, `/clear` relayed as a keystroke and the id rotated, the round-2
      // behaviour): no restart. Predicted result: `os.spawned` has one process, so `spawned[1]` is
      // undefined.
      writeTranscript(SID);
      const m = manager();
      const clear = wired(m);
      const agent = agentConfig();
      const first = await m.spawnAgent(agent, "cli");
      await started(first.pid);
      expect(flagValue(argvOf(first.pid), "--resume")).toBe(SID);

      await clear("a", "/clear");
      const second = livePid();
      await started(second);

      expect(persisted).toHaveLength(1);
      const fresh = persisted[0]?.sessionId as string;
      expect(fresh).not.toBe(SID);
      expect(os.spawned).toHaveLength(2);
      expect(os.spawned[1]?.pid).toBe(second);
      expect(os.spawned[1]?.aliveAtStart).toEqual([]);
      const argv = argvOf(second);
      expect(flagValue(argv, "--session-id")).toBe(fresh);
      expect(argv).not.toContain("--resume");
      // The stored id equals the live process's id.
      expect(agent.session_id).toBe(fresh);
      expect(persisted[0]?.agentId).toBe("a");
      expect(warned.filter((l) => l.includes("reason=session-cleared"))).toHaveLength(1);
      expect(m.getAgent("a")?.pid).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "/clear whose old process cannot be confirmed gone fails, quarantines the session, and leaves the stored id",
    async () => {
      // Fault (site: `clearSessionInternal`, the confirmation result ignored): the clear "succeeds"
      // on a process that may still write. Predicted result: the promise resolves and a new id is
      // persisted.
      writeTranscript(SID);
      const probe = new FakeProbe();
      probe.alwaysAlive = standInInfo();
      const m = manager({ probe, stageMs: 150 });
      const clear = wired(m);
      const agent = agentConfig();
      await m.spawnAgent(agent, "cli");

      await expect(clear("a", "/clear")).rejects.toThrow("not confirmed gone");

      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      // No second process was spawned: every spawn's identity is read before its `spawnAgent` resolves.
      expect(new Set(probe.reads).size).toBe(1);
      expect(isSessionQuarantined({ sessionId: SID })).toBe(true);
      expect(probe.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
      expect(errored.filter((l) => l.includes("reason=clear-retire-unconfirmed"))).toHaveLength(1);
      // The existing #562 gate: nothing starts on the session while it is quarantined...
      await expect(assertSessionWritable({ sessionId: SID })).rejects.toThrow("quarantined");
      // ...and the quarantine lifts once the OS confirms the exit.
      probe.alwaysAlive = null;
      await assertSessionWritable({ sessionId: SID });
      expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
    },
    T,
  );

  it(
    "/clear whose new id cannot be stored fails and brings the old session back",
    async () => {
      writeTranscript(SID);
      const m = manager({
        persist: async () => {
          throw new Error("EROFS");
        },
      });
      const clear = wired(m);
      const agent = agentConfig();
      await m.spawnAgent(agent, "cli");

      await expect(clear("a", "/clear")).rejects.toThrow("could not be stored");
      const restored = livePid();
      await started(restored);

      expect(agent.session_id).toBe(SID);
      expect(flagValue(argvOf(restored), "--resume")).toBe(SID);
      expect(m.getAgent("a")).toBeDefined();
      expect(errored.filter((l) => l.includes("reason=clear-persist-failed"))).toHaveLength(1);
    },
    T,
  );

  it(
    "win32 keeps its pre-#595 /clear: relayed as a slash command, nothing quarantined, no ps probe, id unchanged",
    async () => {
      // Fault (site: the `ownershipGuardApplies` branch of `clearSession`, removed): on Windows the
      // restart cannot be confirmed (no record, no POSIX `ps`), so every clear quarantines the
      // session. Predicted result: `clear` rejects with "not confirmed gone" and nothing is relayed.
      writeTranscript(SID);
      const probe = new FakeProbe();
      probe.failure = new Error("ps: command not found");
      const m = manager({ probe, platform: "win32" });
      const clear = wired(m);
      const agent = agentConfig();
      const proc = await m.spawnAgent(agent, "cli");
      await started(proc.pid);
      const relayed: string[] = [];
      (m.getAgent("a") as { send_slash: (cmd: string) => Promise<void> }).send_slash = async (
        cmd,
      ) => {
        relayed.push(cmd);
      };

      await clear("a", "/clear");

      expect(relayed).toEqual(["clear"]);
      expect(persisted).toHaveLength(0);
      expect(agent.session_id).toBe(SID);
      expect(probe.reads).toEqual([]);
      expect(probe.kills).toEqual([]);
      // The same process is still the live one: nothing was retired or restarted.
      expect(m.getAgent("a")?.pid).toBe(proc.pid);
      expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
      expect(errored.filter((l) => l.includes("reason=clear-retire-unconfirmed"))).toEqual([]);
    },
    T,
  );

  it("win32 /clear of an agent that is not running rejects instead of reporting success", async () => {
    const m = manager({ platform: "win32" });
    await expect(m.clearSession("a")).rejects.toThrow("no active agent");
  });

  it("/clear of an agent that is not running rejects instead of reporting success", async () => {
    const m = manager();
    await expect(m.clearSession("a")).rejects.toThrow("no active agent");
  });

  it(
    "other slash commands neither restart the agent nor touch the stored id",
    async () => {
      writeTranscript(SID);
      const m = manager();
      const clear = wired(m);
      await m.spawnAgent(agentConfig(), "cli");
      await clear("a", "/compact");
      expect(persisted).toHaveLength(0);
      expect(os.spawned).toHaveLength(1);
    },
    T,
  );

  /* ── one lifecycle queue per agent ────────────────────────────────── */

  for (const order of ["clear-then-restart", "restart-then-clear"] as const) {
    it(
      `/clear and restart issued together (${order}) run one after the other and leave one live process on the stored id`,
      async () => {
        // Fault (site: `enqueueLifecycle`, the queue removed so each op runs at once): the two
        // operations capture the same record and retire it together. Predicted result: a rejection
        // ("already spawned") or two live processes, or a stored id that is not the live one.
        writeTranscript(SID);
        const m = manager();
        const clear = wired(m);
        const agent = agentConfig();
        await m.spawnAgent(agent, "cli");

        const doClear = (): Promise<void> => clear("a", "/clear");
        const doRestart = (): Promise<unknown> => m.restart("a", { reason: "manual" });
        const results =
          order === "clear-then-restart"
            ? await Promise.allSettled([doClear(), doRestart()])
            : await Promise.allSettled([doRestart(), doClear()]);

        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(persisted).toHaveLength(2);
        // Three processes, in this order, read from the OS (a retired one may never have run its script).
        expect(os.spawned).toHaveLength(3);
        const [p1, p2, p3] = os.spawned as [SpawnedProcess, SpawnedProcess, SpawnedProcess];
        // Each start found every earlier process already gone: they did not overlap.
        expect(p2.aliveAtStart).toEqual([]);
        expect(p3.aliveAtStart).toEqual([]);
        // Exactly one live process, and the stored id is the one it runs on.
        await exited(p1.pid);
        await exited(p2.pid);
        expect(alive(p3.pid)).toBe(true);
        const last = persisted[1]?.sessionId;
        expect(idOfArgv(p3.argv)).toBe(last);
        expect(agent.session_id).toBe(last);
        expect(idOfArgv(p2.argv)).toBe(persisted[0]?.sessionId);
        expect(m.getAgent("a")?.pid).toBe(p3.pid);
      },
      T,
    );
  }

  /* ── /clear succeeds only on a live replacement ───────────────────── */

  it(
    "a /clear whose replacement exits during startup rejects with its reason, and logs no success",
    async () => {
      // Fault (site: the liveness check after the replacement spawn, removed: spawn completion taken
      // as success): the clear resolves with no agent running. Predicted result: the promise resolves
      // and `reason=session-cleared` is logged.
      // The replacement's startup window is far longer than its life: its spawn returns when it
      // exits, however slowly `sh` gets going, rather than when 600 ms have passed.
      writeTranscript(SID);
      const m = manager();
      const clear = wired(m);
      const agent = agentConfig();
      const first = await m.spawnAgent(agent, "cli");
      await started(first.pid);
      writeFileSync(join(dir, "die"), "");
      opts.sessionCollisionDetectMs = 60_000;

      const err = await clear("a", "/clear").then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ClearReplacementExitedError);
      expect((err as ClearReplacementExitedError).code).toBe("clear-replacement-exited");
      expect(warned.filter((l) => l.includes("reason=session-cleared"))).toHaveLength(0);
      expect(errLines("clear-replacement-exited")).toHaveLength(1);
      expect(m.getAgent("a")).toBeUndefined();
      await exited(first.pid);
      expect(alive(first.pid)).toBe(false);
    },
    T,
  );
});
