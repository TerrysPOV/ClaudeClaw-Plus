/**
 * #595 round 3: the daemon signals only a process an ownership record proves it spawned.
 *
 * `decideResume` runs against a scripted probe and an in-memory store, so every signal, read and
 * record change lands in one ordered event list. The probe and store tests then check the real
 * readers against a fake `/proc` tree and a fake `ps` executable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileOwnershipStore,
  createSystemProbe,
  decideResume,
  namesOwnedClaude,
  type ProcessInfo,
  readFromPs,
} from "../session-ownership";
import { claudeInfo, FakeProbe, MemoryStore, recordFor, SID, UID } from "./ownership-fakes";

const BOOT = "boot-now";
const FAST = { uid: UID, bootId: BOOT, deadlineMs: 2000, termMs: 150, killMs: 150 };

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
    const d = await decide({ deadlineMs: 2000, termMs: 150, killMs: 150 });
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

  it("a record for a different session id is not about this session", async () => {
    store.rec.set("a", recordFor({ sessionId: "some-older-session" }));
    probe.table.set(900, claudeInfo());
    const d = await decide();
    expect(d).toEqual({ kind: "resume", reason: "record-other-session" });
    expect(probe.reads).toEqual([]);
    expect(probe.kills).toEqual([]);
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
  it("a process read that never returns: rotates within the bound, nothing signalled", async () => {
    // Fault (site: the deadline wrapper around `probe.read`, removed): the read is awaited
    // forever. Predicted result: the call does not return and the test times out.
    const probe = new FakeProbe();
    const store = new MemoryStore();
    store.rec.set("a", recordFor());
    probe.stall = true;
    const t0 = Date.now();
    const d = await decideResume({
      agentId: "a",
      sessionId: SID,
      store,
      probe,
      uid: UID,
      bootId: BOOT,
      deadlineMs: 300,
    });
    const took = Date.now() - t0;
    expect(d).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(900);
    expect(probe.kills).toEqual([]);
  }, 5000);

  it("a record read that never returns is bounded too", async () => {
    const store = new MemoryStore();
    store.stallRead = true;
    const t0 = Date.now();
    const d = await decideResume({
      agentId: "a",
      sessionId: SID,
      store,
      probe: new FakeProbe(),
      uid: UID,
      bootId: BOOT,
      deadlineMs: 300,
    });
    expect(d).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(Date.now() - t0).toBeLessThan(900);
  }, 5000);

  it("a stall AFTER the SIGTERM is bounded by the same deadline", async () => {
    const probe = new FakeProbe();
    const store = new MemoryStore();
    store.rec.set("a", recordFor());
    probe.table.set(900, claudeInfo());
    probe.onKill = () => {
      probe.stall = true; // the table read hangs once the signal is out
    };
    const t0 = Date.now();
    const d = await decideResume({
      agentId: "a",
      sessionId: SID,
      store,
      probe,
      uid: UID,
      bootId: BOOT,
      deadlineMs: 400,
      termMs: 3000,
    });
    expect(d).toEqual({ kind: "rotate", reason: "guard-deadline" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
  }, 5000);

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

  it("linux: a zombie is reported as one, and a missing pid is null", async () => {
    const stat = `901 (claude) Z 1 901 901 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 777 1000 100 1`;
    const root = fakeProc(901, stat, "");
    const probe = createSystemProbe({ platform: "linux", procRoot: root });
    expect((await probe.read(901, 1000))?.zombie).toBe(true);
    expect(await probe.read(4242, 1000)).toBeNull();
  });

  it("reads this very process on the host's own platform", async () => {
    const info = await createSystemProbe().read(process.pid, 3000);
    expect(info?.pid).toBe(process.pid);
    expect(info?.uid).toBe(process.getuid?.() as number);
    expect(info?.identity.length).toBeGreaterThan(3);
    expect(info?.zombie).toBe(false);
    // And it is stable: the identity of a live process does not change between reads.
    expect((await createSystemProbe().read(process.pid, 3000))?.identity).toBe(info?.identity);
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
    const info = await readFromPs(900, 2000, ps);
    expect(info).toMatchObject({
      pid: 900,
      uid: 501,
      identity: "Thu Oct 23 10:00:00 2026",
      zombie: false,
      argv: null,
      command: `/opt/bin/claude --resume ${SID}`,
    });
  });

  it("ps: exit 1 with no output is 'no such process'; any other failure rejects", async () => {
    expect(await readFromPs(900, 2000, fakePs("exit 1"))).toBeNull();
    await expect(readFromPs(900, 2000, fakePs("exit 2"))).rejects.toThrow();
    await expect(readFromPs(900, 2000, fakePs("echo garbage"))).rejects.toThrow();
  });

  it("ps: a stalled subprocess is killed at its timeout and rejects", async () => {
    // Fault (site: `timeout` in readFromPs's execFile options, removed): the stand-in runs its
    // full 8 s. Predicted result: the call takes ~8 s and the elapsed bound below fails.
    const ps = fakePs("sleep 8");
    const t0 = Date.now();
    await expect(readFromPs(900, 400, ps)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 6000);
});
