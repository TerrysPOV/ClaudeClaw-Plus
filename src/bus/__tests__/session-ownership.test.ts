/**
 * #595 round 3: the daemon signals only a process an ownership record proves it spawned.
 *
 * `decideResume` runs against a scripted probe and an in-memory store, so every signal, read and
 * record change lands in one ordered event list. The probe and store tests then check the real
 * readers against a fake `/proc` tree and a fake `ps` executable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileOwnershipStore,
  BSDINFO_OFFSETS,
  createSystemProbe,
  decideResume,
  decodeBsdInfoStart,
  libprocStartTime,
  LiveOwnerRecordError,
  namesOwnedClaude,
  PROC_BSDINFO_SIZE,
  PS_PATH,
  type ProcessInfo,
  readFromPs,
  recordOwnership,
  sameStart,
} from "../session-ownership";
import {
  claudeInfo,
  FakeClock,
  FakeProbe,
  MemoryStore,
  recordFor,
  SID,
  UID,
} from "./ownership-fakes";

const BOOT = "boot-now";
/** A bound a real subprocess read must not race: far above a loaded machine's slowest `ps`. */
const LOADED = 120_000;
/**
 * The deadline is far above any realistic runtime so a loaded machine cannot turn "orphan
 * unconfirmed" into "guard deadline"; the stage bounds are what these tests mean to expire (the
 * fake probe answers at once, so a longer wall-clock only delays the stage ending, never changes it).
 * The deadline itself is tested on a fake clock below.
 */
const FAST = { uid: UID, bootId: BOOT, deadlineMs: 120_000, termMs: 150, killMs: 150 };

describe("decideResume — what a restart may do (#595 r3)", () => {
  let events: string[];
  let probe: FakeProbe;
  let store: MemoryStore;
  beforeEach(() => {
    events = [];
    probe = new FakeProbe(events);
    store = new MemoryStore(events);
  });

  const decide = (over: Partial<Parameters<typeof decideResume>[0]> = {}) =>
    decideResume({ agentId: "a", sessionId: SID, store, probe, ...FAST, ...over });

  it("no record: there is no process we own, so resume; nothing is read or signalled", async () => {
    // Fault (site: the `if (!rec)` return, removed): the guard falls through to `rec.sessionId`
    // on null. Predicted result: it rotates (owner-read-failed) instead of resuming.
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "no-record" });
    expect(probe.reads).toEqual([]);
    expect(probe.kills).toEqual([]);
  });

  it("an unrecorded claude that names the session is never looked for and never signalled", async () => {
    // The operator's interactive `claude --resume <id>`: same uid, same id, no record of ours.
    // Fault (site: the guard reaching for any pid naming the id): it would be read and killed.
    // Predicted result: `reads` / `kills` non-empty.
    probe.table.set(777, claudeInfo({ pid: 777, identity: "OPERATOR" }));
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "no-record" });
    expect(probe.reads).toEqual([]);
    expect(probe.kills).toEqual([]);
  });

  it("a previous-boot orphan with the same identity: revalidated, killed, confirmed gone, THEN resumed", async () => {
    // Fault (site: `kill` called before the revalidating read, or the confirmation poll removed):
    // the order below changes. Predicted result: `events` differs from the expected sequence.
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo());
    probe.onKill = (pid) => probe.table.delete(pid);

    const d = await decide();

    expect(d).toEqual({ kind: "resume", reason: "orphan-reaped", reapedPid: 900 });
    expect(events).toEqual([
      "store.read",
      "read:900", // does the process the record names still exist?
      "read:900", // revalidate immediately before the signal
      "kill:SIGTERM",
      "read:900", // confirm it is gone
      "store.clear", // only then is the record dropped
    ]);
  });

  it("an orphan that ignores SIGTERM gets SIGKILL, after another revalidation", async () => {
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo());
    probe.onKill = (pid, sig) => {
      if (sig === "SIGKILL") probe.table.delete(pid);
    };
    const d = await decide();
    expect(d).toMatchObject({ kind: "resume", reason: "orphan-reaped" });
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    const killAt = events.lastIndexOf("kill:SIGKILL");
    expect(events[killAt - 1]).toBe("read:900");
  });

  it("an orphan that survives SIGKILL is unconfirmed: rotate, never resume beside it", async () => {
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo());
    const d = await decide({ termMs: 150, killMs: 150 });
    expect(d).toEqual({ kind: "rotate", reason: "orphan-unconfirmed" });
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(store.rec.has("a")).toBe(true);
  });

  it("pid reused (alive with a different start identity): not signalled, resumed", async () => {
    // Fault (site: `departed`, identity comparison removed): the stranger is treated as the
    // orphan and signalled. Predicted result: `kills` is non-empty and the reason is orphan-reaped
    // or orphan-unconfirmed.
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo({ identity: "T2-SOMEONE-ELSE" }));
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "pid-reused" });
    expect(probe.kills).toEqual([]);
    expect(store.rec.has("a")).toBe(false);
  });

  it("pid dead: nothing to signal, resumed, record dropped", async () => {
    store.rec.set("a", recordFor());
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "owner-gone" });
    expect(probe.kills).toEqual([]);
    expect(store.rec.has("a")).toBe(false);
  });

  it("a zombie is a process that has exited: resumed without a signal", async () => {
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo({ zombie: true }));
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "owner-gone" });
    expect(probe.kills).toEqual([]);
  });

  describe("a record for a DIFFERENT session id (#596 r12)", () => {
    // The daemon died during a fresh-session restart: `session.json` holds the new id, `owner.json`
    // still names the live claude of the older one. The new spawn will overwrite that record, so a
    // survivor it names must be proved gone or ours BEFORE that, or it is left running untracked.
    const OLDER = "0ld3r000-0000-4000-8000-0000000005a5";
    const older = (over: Partial<ProcessInfo> = {}) =>
      claudeInfo({
        argv: ["/home/u/.local/bin/claude", "--resume", OLDER],
        command: `/home/u/.local/bin/claude --resume ${OLDER}`,
        ...over,
      });
    const refused = { kind: "refuse", reason: "other-session-owner-unconfirmed" } as const;

    it("previous boot, alive and proven ours: reaped and confirmed gone, record cleared, spawn proceeds", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.table.set(900, older());
      probe.onKill = (pid) => probe.table.delete(pid);
      const d = await decide();
      expect(d).toEqual({
        kind: "resume",
        reason: "other-session-reaped",
        reapedPid: 900,
        reapedSessionId: OLDER,
      });
      expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
      expect(probe.table.has(900)).toBe(false);
      expect(store.rec.has("a")).toBe(false);
    });

    it("previous boot, dead: nothing signalled, record cleared, spawn proceeds", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      const d = await decide();
      expect(d).toEqual({ kind: "resume", reason: "owner-gone" });
      expect(probe.reads).not.toEqual([]);
      expect(probe.kills).toEqual([]);
      expect(store.rec.has("a")).toBe(false);
    });

    it("previous boot, pid reused by a stranger: not signalled, record cleared, spawn proceeds", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.table.set(900, older({ identity: "T2-SOMEONE-ELSE" }));
      const d = await decide();
      expect(d).toEqual({ kind: "resume", reason: "pid-reused" });
      expect(probe.kills).toEqual([]);
      expect(store.rec.has("a")).toBe(false);
    });

    it("previous boot, alive but only second-precise: nothing signalled, record kept, spawn refused", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER, lowPrecision: true }));
      probe.table.set(900, older());
      const d = await decide();
      expect(d).toEqual({ ...refused, cause: "resume-identity-low-precision" });
      expect(probe.kills).toEqual([]);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });

    it("previous boot, alive under another uid: nothing signalled, record kept, spawn refused", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.table.set(900, older({ uid: UID + 1 }));
      const d = await decide();
      expect(d).toEqual({ ...refused, cause: "owner-uid-mismatch" });
      expect(probe.kills).toEqual([]);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });

    it("previous boot, alive but its argv does not name the RECORD's session: nothing signalled, record kept, spawn refused", async () => {
      // The argv names the session being started, not the one the record is for.
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.table.set(900, claudeInfo());
      const d = await decide();
      expect(d).toEqual({ ...refused, cause: "owner-argv-mismatch" });
      expect(probe.kills).toEqual([]);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });

    it("previous boot, proven but it survives SIGKILL: spawn refused, record kept", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.table.set(900, older());
      const d = await decide({ termMs: 150, killMs: 150 });
      expect(d).toEqual({ ...refused, cause: "orphan-unconfirmed" });
      expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });

    it("previous boot, the process read fails: nothing signalled, record kept, spawn refused", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER }));
      probe.failure = new Error("ps: operation not permitted");
      const d = await decide();
      expect(d).toEqual({ ...refused, cause: "owner-read-failed" });
      expect(probe.kills).toEqual([]);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });

    it("THIS boot: never read, never signalled, spawn proceeds (unchanged)", async () => {
      store.rec.set("a", recordFor({ sessionId: OLDER, bootId: BOOT }));
      probe.table.set(900, older());
      probe.onKill = (pid) => probe.table.delete(pid);
      const d = await decide();
      expect(d).toEqual({ kind: "resume", reason: "record-other-session" });
      expect(probe.reads).toEqual([]);
      expect(probe.kills).toEqual([]);
      expect(probe.table.has(900)).toBe(true);
      expect(store.rec.get("a")?.sessionId).toBe(OLDER);
    });
  });

  it("the identity changes between the read and the signal: no signal is sent", async () => {
    // The process the record named exits and its pid is reused AFTER the first read.
    // Fault (site: the per-signal `read()` in the loop, replaced by the first read's result):
    // SIGTERM goes to the stranger. Predicted result: `kills` has one SIGTERM.
    store.rec.set("a", recordFor());
    probe.intercept = (_pid, nth) => (nth === 1 ? claudeInfo() : claudeInfo({ identity: "T9" }));
    const d = await decide();
    expect(probe.kills).toEqual([]);
    expect(d.kind).toBe("resume");
  });

  it("a record from THIS boot whose process is alive is never signalled: rotate", async () => {
    // Fault (site: the `bootId` comparison, removed): the live process the daemon manages is
    // treated as an orphan and signalled. Predicted result: `kills` has a SIGTERM.
    store.rec.set("a", recordFor({ bootId: BOOT }));
    probe.table.set(900, claudeInfo());
    probe.onKill = (pid) => probe.table.delete(pid);
    const d = await decide();
    expect(d).toEqual({ kind: "rotate", reason: "current-boot-owner-alive" });
    expect(probe.kills).toEqual([]);
    expect(probe.table.has(900)).toBe(true);
  });

  it("a record from THIS boot whose process is confirmed exited: resumed", async () => {
    store.rec.set("a", recordFor({ bootId: BOOT }));
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "owner-gone" });
    expect(probe.kills).toEqual([]);
  });

  it("a record that cannot be read: rotate, nothing is read or signalled", async () => {
    store.readError = new Error("EACCES: owner.json");
    probe.table.set(900, claudeInfo());
    const d = await decide();
    expect(d).toEqual({ kind: "rotate", reason: "ownership-record-unreadable" });
    expect(probe.reads).toEqual([]);
    expect(probe.kills).toEqual([]);
  });

  it("a process read that fails: rotate, nothing signalled", async () => {
    store.rec.set("a", recordFor());
    probe.failure = new Error("ps: operation not permitted");
    const d = await decide();
    expect(d).toEqual({ kind: "rotate", reason: "owner-read-failed" });
    expect(probe.kills).toEqual([]);
  });

  it("another user's process under a recorded pid: not signalled, rotate", async () => {
    // Fault (site: the uid comparison, removed): it is signalled. Predicted result: `kills` has
    // a SIGTERM.
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo({ uid: UID + 1 }));
    const d = await decide();
    expect(d).toEqual({ kind: "rotate", reason: "owner-uid-mismatch" });
    expect(probe.kills).toEqual([]);
  });

  it("a recorded pid whose argv no longer names our claude and the session: not signalled, rotate", async () => {
    // Fault (site: the `namesOwnedClaude` check, removed). Predicted result: a SIGTERM.
    store.rec.set("a", recordFor());
    probe.table.set(
      900,
      claudeInfo({ argv: ["/usr/bin/vim", "notes.md"], command: "/usr/bin/vim notes.md" }),
    );
    const d = await decide();
    expect(d).toEqual({ kind: "rotate", reason: "owner-argv-mismatch" });
    expect(probe.kills).toEqual([]);
  });
});

describe("decideResume — one deadline for the whole guard (#595 r3)", () => {
  // Round 5b: the deadline runs on a `FakeClock` (the `GuardClock` test seam), moved by hand. No
  // test here waits on, or measures, the wall clock, so a loaded machine cannot fail them.
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
  const base = { agentId: "a", sessionId: SID, uid: UID, bootId: BOOT };

  it("a process read that never returns: rotates at the bound, not before it, nothing signalled", async () => {
    // Fault (site: the deadline wrapper around `probe.read`, removed): the read is awaited
    // forever. Predicted result: the call does not return and the test times out.
    const clock = new FakeClock();
    const probe = new FakeProbe();
    const store = new MemoryStore();
    store.rec.set("a", recordFor());
    probe.stall = true;
    const decided = decideResume({ ...base, store, probe, deadlineMs: 300, clock });
    let settled = false;
    void decided.then(() => {
      settled = true;
    });

    await probe.readIssued(1); // the stalled read is out and its deadline is armed
    clock.advance(299);
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    expect(await decided).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(clock.now()).toBe(300);
    expect(probe.kills).toEqual([]);
  }, 10_000);

  it("the read is handed what is left of the deadline, capped at the probe timeout", async () => {
    // Two faults at the one site `Math.min(PROBE_TIMEOUT_MS, left())` in `read`, one at a time:
    // `left()` dropped (a read told it has longer than the guard does: 1500 where 300 is left) and
    // the probe cap dropped (a read told it has the whole deadline: 10000 where 1500 is the cap).
    const handed = async (deadlineMs: number): Promise<number[]> => {
      const clock = new FakeClock();
      const probe = new FakeProbe();
      const store = new MemoryStore();
      store.rec.set("a", recordFor());
      probe.stall = true;
      const decided = decideResume({ ...base, store, probe, deadlineMs, clock });
      await probe.readIssued(1);
      const timeouts = [...probe.readTimeouts];
      clock.advance(deadlineMs);
      await decided;
      return timeouts;
    };
    expect(await handed(300)).toEqual([300]);
    expect(await handed(10_000)).toEqual([1500]);
  }, 10_000);

  it("a record read that never returns is bounded too", async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    store.stallRead = true;
    const decided = decideResume({
      ...base,
      store,
      probe: new FakeProbe(),
      deadlineMs: 300,
      clock,
    });
    await clock.armed();
    clock.advance(300);
    expect(await decided).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(clock.now()).toBe(300);
  }, 10_000);

  it("a stall AFTER the SIGTERM is bounded by the same deadline, not by the longer SIGTERM stage", async () => {
    // Fault (site: `bounded(...)` around the post-signal `read`, removed): the confirmation read
    // hangs for the whole 3 s stage and beyond. Predicted result: the call does not return.
    const clock = new FakeClock();
    const probe = new FakeProbe();
    const store = new MemoryStore();
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo());
    probe.onKill = () => {
      probe.stall = true; // the table read hangs once the signal is out
    };
    const decided = decideResume({
      ...base,
      store,
      probe,
      deadlineMs: 400,
      termMs: 3000,
      clock,
    });
    await probe.readIssued(3); // first read, revalidation, then the read after the signal
    clock.advance(400);
    expect(await decided).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(clock.now()).toBe(400);
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
  }, 10_000);

  it("the shipped defaults keep the whole guard at or under 6 s", async () => {
    const { GUARD_DEADLINE_MS, ORPHAN_KILL_MS, ORPHAN_TERM_MS, PROBE_TIMEOUT_MS } = await import(
      "../session-ownership"
    );
    expect(GUARD_DEADLINE_MS).toBe(5000);
    expect(ORPHAN_TERM_MS + ORPHAN_KILL_MS).toBeLessThanOrEqual(GUARD_DEADLINE_MS);
    // One read in flight at the deadline can overrun it by at most its own timeout, which is
    // itself capped by what is left: the guard never exceeds GUARD_DEADLINE_MS plus timer slack.
    expect(GUARD_DEADLINE_MS + PROBE_TIMEOUT_MS).toBeLessThanOrEqual(6500);
  });
});

describe("namesOwnedClaude (#595 r3)", () => {
  const rec = recordFor();

  it("real argv: the id is a whole argument directly after --resume / --session-id", () => {
    expect(namesOwnedClaude(claudeInfo(), rec)).toBe(true);
    expect(
      namesOwnedClaude(claudeInfo({ argv: ["claude", "--session-id", SID, "--x"] }), rec),
    ).toBe(true);
    expect(namesOwnedClaude(claudeInfo({ argv: ["claude", `--resume=${SID}`] }), rec)).toBe(true);
  });

  it("real argv: a prompt that merely contains the text is one argument and does not match", () => {
    // Codex HIGH 2: `claude --print "explain --resume <id>"`.
    const decoy = claudeInfo({ argv: ["claude", "--print", `explain --resume ${SID}`] });
    expect(namesOwnedClaude(decoy, rec)).toBe(false);
  });

  it("real argv: an id that only starts with, or contains, the stored one does not match", () => {
    expect(namesOwnedClaude(claudeInfo({ argv: ["claude", "--resume", `${SID}9`] }), rec)).toBe(
      false,
    );
    expect(namesOwnedClaude(claudeInfo({ argv: ["claude", "--resume", `x${SID}`] }), rec)).toBe(
      false,
    );
  });

  it("the program must be the executable recorded at spawn, not any name containing 'claude'", () => {
    expect(
      namesOwnedClaude(claudeInfo({ argv: ["/usr/bin/claude-impostor", "--resume", SID] }), rec),
    ).toBe(false);
    expect(namesOwnedClaude(claudeInfo({ argv: ["vim", "claude", "--resume", SID] }), rec)).toBe(
      false,
    );
  });

  it("an interpreter running the recorded script matches", () => {
    expect(
      namesOwnedClaude(claudeInfo({ argv: ["node", "/opt/bin/claude", "--resume", SID] }), rec),
    ).toBe(true);
  });

  it("flat command text (macOS) is a fallback with the same program and flag rules", () => {
    const flat = (command: string): ProcessInfo => claudeInfo({ argv: null, command });
    expect(namesOwnedClaude(flat(`/opt/bin/claude --resume ${SID}`), rec)).toBe(true);
    expect(namesOwnedClaude(flat(`/usr/bin/vim --resume ${SID}`), rec)).toBe(false);
  });
});

describe("createFileOwnershipStore (#595 r3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-owner-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a record next to the agent's session, mode 0600", async () => {
    const store = createFileOwnershipStore(() => dir);
    expect(await store.read("a")).toBeNull();
    await store.write(recordFor());
    expect(await store.read("a")).toEqual(recordFor());
    expect(statSync(join(dir, "a", "owner.json")).mode & 0o777).toBe(0o600);
  });

  it("clear drops the record it was asked about but keeps a newer spawn's", async () => {
    // Fault (site: the compare in `clear`, removed): an old process's late exit clears the NEW
    // process's record. Predicted result: the second read is null.
    const store = createFileOwnershipStore(() => dir);
    await store.write(recordFor({ pid: 901, identity: "T-new" }));
    await store.clear("a", { pid: 900, identity: "T1" });
    expect((await store.read("a"))?.pid).toBe(901);
    await store.clear("a", { pid: 901, identity: "T-new" });
    expect(await store.read("a")).toBeNull();
  });

  it("a corrupt or foreign-shaped file rejects (so the guard rotates) rather than reading as 'none'", async () => {
    const store = createFileOwnershipStore(() => dir);
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "owner.json"), "{not json");
    await expect(store.read("a")).rejects.toThrow();
    writeFileSync(join(dir, "a", "owner.json"), '{"pid":"x"}');
    await expect(store.read("a")).rejects.toThrow();
  });

  it("an agent id that is a path is refused, not joined", async () => {
    const store = createFileOwnershipStore(() => dir);
    await expect(store.read("../escape")).rejects.toThrow();
    await expect(store.write(recordFor({ agentId: "a/b" }))).rejects.toThrow();
  });
});

describe("the real process readers (#595 r3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-owner-probe-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeProc(pid: number, stat: string, cmdline: string): string {
    const root = join(dir, "proc");
    mkdirSync(join(root, String(pid)), { recursive: true });
    writeFileSync(join(root, "stat"), "cpu 1 2 3\nbtime 1790000000\n");
    writeFileSync(join(root, String(pid), "stat"), stat);
    writeFileSync(join(root, String(pid), "cmdline"), cmdline);
    return root;
  }

  it("linux: identity is boot time + start ticks, argv keeps its boundaries, comm may hold ') ('", async () => {
    // field 22 (starttime) is index 19 after the last ")": here 123456.
    const stat = `900 (claude) (x) S 1 900 900 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 123456 1000 100 18446744073709551615`;
    const root = fakeProc(900, stat, "/bin/claude\0--print\0explain --resume X\0");
    const info = await createSystemProbe({ platform: "linux", procRoot: root }).read(900, 1000);
    expect(info?.identity).toBe("1790000000:123456");
    expect(info?.argv).toEqual(["/bin/claude", "--print", "explain --resume X"]);
    expect(info?.zombie).toBe(false);
    expect(info?.uid).toBe(statSync(join(root, "900")).uid);
  });

  it("linux: the boot time is read per proc root, not once per process", async () => {
    // Fault (site: `bootTime`, the cache keyed by nothing: one module-level value): a read of a
    // second proc root returns the first root's `btime`, so the identity of a process on another
    // root (a fake `/proc` here, an earlier real read in a full-suite run) carries the wrong boot.
    // Predicted result: the second identity is "1790000000:555", not "1791111111:555".
    const stat = (ticks: number) =>
      `902 (claude) S 1 902 902 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${ticks} 1000 100 1`;
    const first = fakeProc(902, stat(555), "/bin/claude\0");
    const second = join(dir, "proc2");
    mkdirSync(join(second, "902"), { recursive: true });
    writeFileSync(join(second, "stat"), "cpu 1 2 3\nbtime 1791111111\n");
    writeFileSync(join(second, "902", "stat"), stat(555));
    writeFileSync(join(second, "902", "cmdline"), "/bin/claude\0");

    const a = await createSystemProbe({ platform: "linux", procRoot: first }).read(902, 1000);
    const b = await createSystemProbe({ platform: "linux", procRoot: second }).read(902, 1000);
    expect(a?.identity).toBe("1790000000:555");
    expect(b?.identity).toBe("1791111111:555");
  });

  it("linux: a zombie is reported as one, and a missing pid is null", async () => {
    const stat = `901 (claude) Z 1 901 901 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 777 1000 100 1`;
    const root = fakeProc(901, stat, "");
    const probe = createSystemProbe({ platform: "linux", procRoot: root });
    expect((await probe.read(901, 1000))?.zombie).toBe(true);
    expect(await probe.read(4242, 1000)).toBeNull();
  });

  it("reads this very process on the host's own platform", async () => {
    const info = await createSystemProbe().read(process.pid, LOADED);
    expect(info?.pid).toBe(process.pid);
    expect(info?.uid).toBe(process.getuid?.() as number);
    expect(info?.identity.length).toBeGreaterThan(3);
    expect(info?.zombie).toBe(false);
    // And it is stable: the identity of a live process does not change between reads.
    expect((await createSystemProbe().read(process.pid, LOADED))?.identity).toBe(info?.identity);
  });

  /** A stand-in `ps`: prints `body` and exits `code`, or sleeps. */
  function fakePs(body: string): string {
    const file = join(dir, "ps.sh");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it("ps: parses one row of stat, uid, lstart and the flat command", async () => {
    const ps = fakePs(`echo " S  501 Thu Oct 23 10:00:00 2026 /opt/bin/claude --resume ${SID}"`);
    const info = await readFromPs(900, LOADED, ps, () => null);
    expect(info).toMatchObject({
      pid: 900,
      uid: 501,
      identity: "Thu Oct 23 10:00:00 2026",
      lowPrecision: true,
      zombie: false,
      argv: null,
      command: `/opt/bin/claude --resume ${SID}`,
    });
  });

  it("ps: exit 1 with no output is 'no such process'; any other failure rejects", async () => {
    expect(await readFromPs(900, LOADED, fakePs("exit 1"))).toBeNull();
    await expect(readFromPs(900, LOADED, fakePs("exit 2"))).rejects.toThrow();
    await expect(readFromPs(900, LOADED, fakePs("echo garbage"))).rejects.toThrow();
  });

  it("ps: a stalled subprocess is killed at its timeout and rejects", async () => {
    // Fault (site: `timeout` in readFromPs's execFile options, removed): the stand-in runs its
    // full 20 s. Predicted result: the call takes ~20 s and the elapsed bound below fails.
    // The stand-in sleeps 20 s; the 400 ms timeout is what ends it. The bound below is far above a
    // loaded machine's slowest `sh` start and far below the stand-in's 20 s, so only a timeout that
    // is not applied can fail it.
    const ps = fakePs("sleep 20");
    const t0 = Date.now();
    await expect(readFromPs(900, 400, ps)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
  /* ── macOS: sub-second birth identity (#595 r4) ─────────────────── */

  const LSTART = "Thu Oct 23 10:00:00 2026";
  const LSTART_SEC = Date.parse(`${LSTART} UTC`) / 1000;
  const psRow = (): string => fakePs(`echo " S  501 ${LSTART} /opt/bin/claude --resume ${SID}"`);

  /** A `struct proc_bsdinfo` as libproc fills it, with only the fields the decoder reads set. */
  function bsdInfo(pid: number, sec: number, usec: number): Uint8Array {
    const buf = new Uint8Array(PROC_BSDINFO_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint32(BSDINFO_OFFSETS.pid, pid, true);
    view.setBigUint64(BSDINFO_OFFSETS.startSec, BigInt(sec), true);
    view.setBigUint64(BSDINFO_OFFSETS.startUsec, BigInt(usec), true);
    return buf;
  }

  it("libproc struct: the start time is read at offsets 120 and 128 (pid at 12) of a 136-byte struct", () => {
    // Fault (site: `decodeBsdInfoStart`, tvusec decoded as 0): the microseconds are lost, so a
    // replacement born in the same second shares the identity. Predicted result: usec is 0.
    expect(PROC_BSDINFO_SIZE).toBe(136);
    expect(BSDINFO_OFFSETS).toEqual({
      status: 4,
      pid: 12,
      uid: 20,
      comm: 48,
      name: 64,
      pgid: 100,
      startSec: 120,
      startUsec: 128,
    });
    expect(decodeBsdInfoStart(bsdInfo(4242, 1792761049, 464209), 4242)).toEqual({
      sec: 1792761049,
      usec: 464209,
    });
  });

  it("libproc struct: another pid's struct, a short buffer and an out-of-range usec decode to null", () => {
    expect(decodeBsdInfoStart(bsdInfo(4242, 1792761049, 5), 4243)).toBeNull();
    expect(decodeBsdInfoStart(new Uint8Array(100), 4242)).toBeNull();
    expect(decodeBsdInfoStart(bsdInfo(4242, 1792761049, 1_000_000), 4242)).toBeNull();
    expect(decodeBsdInfoStart(bsdInfo(4242, 0, 5), 4242)).toBeNull();
  });

  it("ps + libproc: the identity carries the microseconds and is not marked low-precision", async () => {
    const info = await readFromPs(900, LOADED, psRow(), () => ({ sec: LSTART_SEC, usec: 464209 }));
    expect(info?.identity).toBe(`${LSTART}+464209`);
    expect(info?.lowPrecision).toBeUndefined();
    const small = await readFromPs(900, LOADED, psRow(), () => ({ sec: LSTART_SEC + 1, usec: 7 }));
    expect(small?.identity).toBe(`${LSTART}+000007`);
  });

  it("libproc unavailable, throwing, or disagreeing with ps on the second: lstart alone, marked low-precision", async () => {
    // Fault (site: `startIdentity`, the second-agreement check removed): a mismatched struct is
    // trusted. Predicted result: the third case gets a `+` suffix.
    const cases: Array<(pid: number) => { sec: number; usec: number } | null> = [
      () => null,
      () => {
        throw new Error("ffi");
      },
      () => ({ sec: LSTART_SEC + 3600, usec: 1 }),
    ];
    for (const startTime of cases) {
      const info = await readFromPs(900, LOADED, psRow(), startTime);
      expect(info?.identity).toBe(LSTART);
      expect(info?.lowPrecision).toBe(true);
    }
  });

  it("sameStart: microseconds must match; a second-precise side matches on the second only", () => {
    expect(sameStart(`${LSTART}+000001`, `${LSTART}+000001`)).toBe(true);
    expect(sameStart(`${LSTART}+000001`, `${LSTART}+000002`)).toBe(false);
    expect(sameStart(LSTART, `${LSTART}+000002`)).toBe(true);
    expect(sameStart(`${LSTART}+000002`, LSTART)).toBe(true);
    expect(sameStart(LSTART, "Thu Oct 23 10:00:01 2026")).toBe(false);
    expect(sameStart("1700000000:12345", "1700000000:12345")).toBe(true);
    expect(sameStart("1700000000:12345", "1700000000:12346")).toBe(false);
  });

  const darwinIt = process.platform === "darwin" ? it : it.skip;

  darwinIt(
    "macOS: the real libproc call answers for this process, in agreement with ps",
    async () => {
      const start = libprocStartTime(process.pid);
      expect(start).not.toBeNull();
      const now = Date.now() / 1000;
      expect(start?.sec).toBeLessThanOrEqual(now);
      expect(start?.sec).toBeGreaterThan(now - 7 * 86400);
      const info = await createSystemProbe().read(process.pid, LOADED);
      expect(info?.identity).toMatch(/\+\d{6}$/);
      expect(info?.lowPrecision).toBeUndefined();
      expect((await createSystemProbe().read(process.pid, LOADED))?.identity).toBe(info?.identity);
      expect(libprocStartTime(2 ** 30)).toBeNull();
    },
  );
});

describe("decideResume — identity precision (#595 r4)", () => {
  const S = "Thu Oct 23 10:00:00 2026";
  let probe: FakeProbe;
  let store: MemoryStore;
  beforeEach(() => {
    probe = new FakeProbe();
    store = new MemoryStore();
  });
  const decide = () =>
    decideResume({ agentId: "a", sessionId: SID, store, probe, ...FAST, termMs: 150, killMs: 150 });

  it("a replacement born in the SAME SECOND as the recorded process is told apart by its microseconds", async () => {
    // Fault (site: `departed`, `sameStart` replaced by lstart-only equality, the round-3 behaviour):
    // the replacement is taken for the recorded process and signalled. Predicted result: a SIGTERM.
    store.rec.set("a", recordFor({ identity: `${S}+111111` }));
    probe.table.set(900, claudeInfo({ identity: `${S}+222222` }));
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "pid-reused" });
    expect(probe.kills).toEqual([]);
  });

  // #595 r5: a signal rests on a microsecond identity on BOTH sides. A second-precise match can
  // still be a pid reused in the same second, and uid + argv cannot tell those apart.

  it("a second-precise LIVE read of a process recorded at microsecond precision is not signalled: rotate", async () => {
    // Fault (site: the low-precision refusal in `decideResume`, removed, the round-4 behaviour that
    // logged it and signalled anyway): the process is killed. Predicted result: a SIGTERM and a
    // `resume`, not a `rotate`.
    store.rec.set("a", recordFor({ identity: `${S}+111111` }));
    probe.table.set(900, claudeInfo({ identity: S, lowPrecision: true }));
    probe.onKill = (pid) => probe.table.delete(pid);
    expect(await decide()).toEqual({ kind: "rotate", reason: "resume-identity-low-precision" });
    expect(probe.kills).toEqual([]);
  });

  it("a second-precise RECORD against a microsecond live read is not signalled either: rotate", async () => {
    // Fault (site: the `includes("+")` mismatch clause, removed): a record written when libproc was
    // unavailable is matched on the second alone and its process killed. Predicted result: a SIGTERM.
    store.rec.set("a", recordFor({ identity: S }));
    probe.table.set(900, claudeInfo({ identity: `${S}+222222` }));
    probe.onKill = (pid) => probe.table.delete(pid);
    expect(await decide()).toEqual({ kind: "rotate", reason: "resume-identity-low-precision" });
    expect(probe.kills).toEqual([]);
  });

  it("second precision on both sides is not signalled", async () => {
    store.rec.set("a", recordFor({ identity: S }));
    probe.table.set(900, claudeInfo({ identity: S, lowPrecision: true }));
    probe.onKill = (pid) => probe.table.delete(pid);
    expect(await decide()).toEqual({ kind: "rotate", reason: "resume-identity-low-precision" });
    expect(probe.kills).toEqual([]);
  });

  it("second precision refuses before uid and argv are even weighed", async () => {
    store.rec.set("a", recordFor({ identity: S }));
    probe.table.set(900, claudeInfo({ identity: S, lowPrecision: true, uid: UID + 1 }));
    expect(await decide()).toEqual({ kind: "rotate", reason: "resume-identity-low-precision" });
    expect(probe.kills).toEqual([]);
  });

  it("microsecond identity on both sides and matching: the orphan is signalled, as before", async () => {
    store.rec.set("a", recordFor({ identity: `${S}+111111` }));
    probe.table.set(900, claudeInfo({ identity: `${S}+111111` }));
    probe.onKill = (pid) => probe.table.delete(pid);
    expect(await decide()).toEqual({ kind: "resume", reason: "orphan-reaped", reapedPid: 900 });
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
  });

  it("a microsecond match is still gated on uid and argv: a foreign uid is not signalled", async () => {
    store.rec.set("a", recordFor({ identity: `${S}+111111` }));
    probe.table.set(900, claudeInfo({ identity: `${S}+111111`, uid: UID + 1 }));
    expect(await decide()).toEqual({ kind: "rotate", reason: "owner-uid-mismatch" });
    probe.table.set(
      900,
      claudeInfo({ identity: `${S}+111111`, argv: ["claude", "--resume", "other"] }),
    );
    expect(await decide()).toEqual({ kind: "rotate", reason: "owner-argv-mismatch" });
    expect(probe.kills).toEqual([]);
  });

  it("second precision still answers 'reused or gone?': a different second resumes without a signal", async () => {
    store.rec.set("a", recordFor({ identity: S }));
    probe.table.set(900, claudeInfo({ identity: "Thu Oct 23 10:00:09 2026", lowPrecision: true }));
    expect(await decide()).toEqual({ kind: "resume", reason: "pid-reused" });
    expect(probe.kills).toEqual([]);
  });
});

describe("ownership store hardening (#595 r7c)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-owner-r7c-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plant = (agent: string, body: unknown): void => {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(join(dir, agent, "owner.json"), JSON.stringify(body));
  };

  it("the temp file is exclusive: a symlink already at the temp path is not written through", async () => {
    // Fault (site: `flag: "wx"` in `write`, removed): writeFile follows the planted symlink and
    // overwrites the victim. Predicted result: the victim holds the record and `write` resolves.
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    mkdirSync(join(dir, "a"), { recursive: true });
    symlinkSync(victim, join(dir, "a", "owner.json.fixed.tmp"));
    const store = createFileOwnershipStore(
      () => dir,
      () => "fixed",
    );
    await expect(store.write(recordFor())).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(existsSync(join(dir, "a", "owner.json"))).toBe(false);
  });

  it("the temp name is not predictable: a symlink at the old pid-named path is never used", async () => {
    // Fault (site: the temp name reverted to `owner.json.<pid>.tmp`): the write goes through the
    // symlink planted at that name. Predicted result: the victim is overwritten.
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    mkdirSync(join(dir, "a"), { recursive: true });
    symlinkSync(victim, join(dir, "a", `owner.json.${process.pid}.tmp`));
    const store = createFileOwnershipStore(() => dir);
    await store.write(recordFor());
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect((await store.read("a"))?.pid).toBe(900);
  });

  it("a record under one agent's directory that names another agent is unreadable and leaves theirs alone", async () => {
    // Fault (site: the agentId compare in `load`, removed): b's guard reads a's record and may
    // signal its process. Predicted result: `decideResume` for b does not rotate.
    const store = createFileOwnershipStore(() => dir);
    await store.write(recordFor({ agentId: "a", pid: 900 }));
    plant("b", recordFor({ agentId: "a", pid: 900 }));
    await expect(store.read("b")).rejects.toThrow();
    const d = await decideResume({
      agentId: "b",
      sessionId: SID,
      store,
      probe: new FakeProbe(),
      ...FAST,
    });
    expect(d).toEqual({ kind: "rotate", reason: "ownership-record-unreadable" });
    expect((await store.read("a"))?.pid).toBe(900);
  });

  it("a pid that is 1, this daemon, or beyond pid_max is not a record", async () => {
    // Fault (site: the pid bounds in `isRecord`, back to `pid > 0`): each is read back as a record
    // a restart could aim a signal at. Predicted result: the reads resolve.
    const store = createFileOwnershipStore(() => dir);
    for (const pid of [1, process.pid, 2 ** 31, 4194305]) {
      plant("a", recordFor({ pid }));
      await expect(store.read("a")).rejects.toThrow();
    }
    for (const pid of [2, 4194304]) {
      plant("a", recordFor({ pid }));
      expect((await store.read("a"))?.pid).toBe(pid);
    }
  });

  it("ps is run by absolute path: a poisoned PATH entry named ps is not used", async () => {
    // Fault (site: the `psCommand` default, back to "ps"): the stand-in on PATH runs and its
    // garbage fails the parse. Predicted result: readFromPs rejects.
    expect(PS_PATH).toBe("/bin/ps");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const poison = join(bin, "ps");
    writeFileSync(poison, "#!/bin/sh\necho garbage\n");
    chmodSync(poison, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      const info = await readFromPs(process.pid, LOADED, undefined, () => null);
      expect(info?.pid).toBe(process.pid);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("recordOwnership never overwrites the record of a live process (#595 r10)", () => {
  const NEW_PID = 777;
  /** The spawn's own process as the probe reads it, and a previous boot's claude on the same session. */
  const setup = (): { store: MemoryStore; probe: FakeProbe } => {
    const store = new MemoryStore();
    const probe = new FakeProbe();
    probe.table.set(NEW_PID, claudeInfo({ pid: NEW_PID, identity: "T2+000002" }));
    return { store, probe };
  };
  const record = (store: MemoryStore, probe: FakeProbe) =>
    recordOwnership({ store, probe, agentId: "a", sessionId: SID, pid: NEW_PID, exe: "claude" });
  const rejection = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  it("a live record for another process of this session: the write is refused and the record stays", async () => {
    // Fault (site: `refuseLiveRecord` in `recordOwnership`, removed): the orphan's record is
    // replaced by the new pid. Predicted result: `store.rec.get("a")?.pid` is 777, not 900.
    const { store, probe } = setup();
    store.rec.set("a", recordFor({ pid: 900, identity: "T1+000001" }));
    probe.table.set(900, claudeInfo({ pid: 900, identity: "T1+000001" }));

    const err = (await rejection(record(store, probe))) as { stage?: string; cause?: unknown };
    expect(err.stage).toBe("write");
    expect(err.cause).toBeInstanceOf(LiveOwnerRecordError);
    expect(store.rec.get("a")?.pid).toBe(900);
    expect(probe.kills).toEqual([]);
  });

  it("a live record whose process cannot be read counts as live: refused", async () => {
    const { store, probe } = setup();
    store.rec.set("a", recordFor({ pid: 900, identity: "T1+000001" }));
    probe.stallPid = 900;

    const err = (await rejection(
      recordOwnership({
        store,
        probe,
        agentId: "a",
        sessionId: SID,
        pid: NEW_PID,
        exe: "claude",
        timeoutMs: 20,
      }),
    )) as { cause?: unknown };
    expect(err.cause).toBeInstanceOf(LiveOwnerRecordError);
    expect(store.rec.get("a")?.pid).toBe(900);
  });

  it("a record whose process is gone is replaced", async () => {
    const { store, probe } = setup();
    store.rec.set("a", recordFor({ pid: 900, identity: "T1+000001" }));

    const written = await record(store, probe);
    expect(written?.pid).toBe(NEW_PID);
    expect(store.rec.get("a")?.pid).toBe(NEW_PID);
  });

  it("a record for another session, or none, is replaced", async () => {
    const { store, probe } = setup();
    store.rec.set("a", recordFor({ pid: 900, sessionId: "another-session" }));
    probe.table.set(900, claudeInfo({ pid: 900, identity: "T1" }));

    await record(store, probe);
    expect(store.rec.get("a")?.pid).toBe(NEW_PID);
  });

  it("an unreadable record is replaced: a corrupt file heals", async () => {
    const { store, probe } = setup();
    store.readError = new Error("unrecognised shape");

    expect((await record(store, probe))?.pid).toBe(NEW_PID);
    expect(store.rec.get("a")?.pid).toBe(NEW_PID);
  });
});
