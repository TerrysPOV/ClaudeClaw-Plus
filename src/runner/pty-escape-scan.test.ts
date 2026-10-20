import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEscapees, terminateEscapees } from "./pty-escape-scan.js";
import { type PtyProcessOptions, spawnPty } from "./pty-process.js";
import { withPlatformAsync } from "./pty-test-platform.js";

/**
 * #570 r13 (C): a descendant that leaves claude's process group (`setsid`, `setpgid`) escapes
 * the group kill. On Linux it is found by the throwaway config root it inherited, or by running
 * inside the throwaway cwd. The fake-/proc half runs everywhere; the real-process half only on
 * Linux, where `setsid(1)` and `/proc` exist.
 */

const ROOT = "/tmp/claudeclaw-oneshot-cfg-AAAA";
const CWD = "/tmp/claudeclaw-oneshot-pty-BBBB";
const TARGET = { root: ROOT, cwds: [CWD] };
const START = 1_700_000_000_000;

describe("findEscapees (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const process_ = (pid: number, { env, cwd }: { env?: string[]; cwd?: string }): void => {
    mkdirSync(join(proc, String(pid)));
    if (env) writeFileSync(join(proc, String(pid), "environ"), `${env.join("\0")}\0`);
    if (cwd) symlinkSync(cwd, join(proc, String(pid), "cwd"));
  };

  it("finds a process that carries this root in its environment, by exact entry", () => {
    process_(5001, { env: ["PATH=/bin", `CLAUDE_CONFIG_DIR=${ROOT}`, "HOME=/x"] });
    process_(5002, { env: [`CLAUDE_CONFIG_DIR=${ROOT}-other`] }); // a longer path
    process_(5003, { env: [`X_CLAUDE_CONFIG_DIR=${ROOT}`] }); // another variable
    process_(5004, { env: [`CLAUDE_CONFIG_DIR=${ROOT.slice(0, -1)}`] }); // a shorter path
    process_(5005, { env: ["PATH=/bin"] });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids).toEqual([5001]);
  });

  it("finds a process running in the temp cwd or below it, and not a sibling with the same prefix", () => {
    process_(5101, { cwd: CWD });
    process_(5102, { cwd: `${CWD}/sub/dir` });
    process_(5103, { cwd: `${CWD}-sibling` });
    process_(5104, { cwd: "/" });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids.sort()).toEqual([5101, 5102]);
  });

  it("matches the temp cwd in either of its forms", () => {
    process_(5201, { cwd: "/private/tmp/claudeclaw-oneshot-pty-BBBB" });
    const target = { root: ROOT, cwds: [CWD, "/private/tmp/claudeclaw-oneshot-pty-BBBB"] };
    expect(findEscapees(target, { procDir: proc, selfPid: 1 }).pids).toEqual([5201]);
  });

  it("skips the daemon itself and pids that cannot be signalled", () => {
    process_(5301, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    process_(1, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    mkdirSync(join(proc, "self"));
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 5301 })).toEqual({
      pids: [],
      unknown: [],
    });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids).toEqual([5301]);
  });

  // ── #570 r14b: which unreadable processes can be ours ─────────────────────────────────────
  // `/proc/<pid>/stat` field 22 is in ticks; the reader turns them into ms (x10). The leader of
  // these tests started at tick 1000 (10 000 ms).
  const LEADER = 10_000;
  const statLine = (pid: number, ppid: number, ticks: number): string =>
    `${pid} (x) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1 1\n`;
  /** A process whose environ AND cwd cannot be read: a directory where each should be. */
  const unreadable = (pid: number, ticks: number, ppid = 1): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "stat"), statLine(pid, ppid, ticks));
    mkdirSync(join(proc, String(pid), "environ")); // EISDIR
    writeFileSync(join(proc, String(pid), "cwd"), "not a link"); // EINVAL
  };
  const scan = (selfPid = 1, leaderStartMs: number | null = LEADER) =>
    findEscapees({ ...TARGET, leaderStartMs }, { procDir: proc, selfPid });

  it("ignores an unreadable process that started before the leader: foreign, not unknown", () => {
    unreadable(5302, 500); // 5 000 ms, before the leader's 10 000 ms
    // Went red (the process reported as unknown) with the age filter removed or inverted.
    expect(scan()).toEqual({ pids: [], unknown: [] });
  });

  it("reports an unreadable process born after the leader as unknown, with metadata only", () => {
    unreadable(5303, 1250);
    // Went red (empty unknown) with the both-reads-fail rule removed.
    expect(scan(999).unknown).toEqual([
      {
        pid: 5303,
        startMs: 12_500,
        envErrno: "EISDIR",
        cwdErrno: "EINVAL",
        descendant: false,
        ageMs: 2_500,
      },
    ]);
    expect(scan().pids).toEqual([]);
  });

  it("counts a process that started in the very tick of the leader as born after it", () => {
    unreadable(5304, 1000);
    expect(scan().unknown.map((u) => u.pid)).toEqual([5304]);
  });

  it("does not skip on age when the leader's start time is not known", () => {
    unreadable(5305, 500);
    expect(scan(1, null).unknown.map((u) => u.pid)).toEqual([5305]);
  });

  it("is not unknown when only the environment cannot be read and the cwd says it is foreign", () => {
    mkdirSync(join(proc, "5306"));
    writeFileSync(join(proc, "5306", "stat"), statLine(5306, 1, 1250));
    mkdirSync(join(proc, "5306", "environ"));
    symlinkSync("/somewhere/else", join(proc, "5306", "cwd"));
    // Went red (reported unknown) with a single failed read made enough.
    expect(scan().unknown).toEqual([]);
  });

  it("is not unknown when only the cwd cannot be read and the environment says it is foreign", () => {
    mkdirSync(join(proc, "5307"));
    writeFileSync(join(proc, "5307", "stat"), statLine(5307, 1, 1250));
    writeFileSync(join(proc, "5307", "environ"), "PATH=/bin\0");
    writeFileSync(join(proc, "5307", "cwd"), "not a link");
    expect(scan().unknown).toEqual([]);
  });

  it("uses the readable one of the two: an unreadable environment, a cwd inside the temp cwd", () => {
    mkdirSync(join(proc, "5308"));
    writeFileSync(join(proc, "5308", "stat"), statLine(5308, 1, 1250));
    mkdirSync(join(proc, "5308", "environ"));
    symlinkSync(CWD, join(proc, "5308", "cwd"));
    expect(scan()).toEqual({ pids: [5308], unknown: [] });
  });

  it("still names a post-spawn match, and skips a pre-spawn process that would match too", () => {
    process_(5309, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    writeFileSync(join(proc, "5309", "stat"), statLine(5309, 1, 1250));
    process_(5310, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    writeFileSync(join(proc, "5310", "stat"), statLine(5310, 1, 500));
    // Went red with the age filter removed: the older one cannot be ours.
    expect(scan().pids).toEqual([5309]);
  });

  it("says whether the daemon is an ancestor of an unreadable process", () => {
    mkdirSync(join(proc, "4000"));
    writeFileSync(join(proc, "4000", "stat"), statLine(4000, 77, 1100)); // daemon is 77
    unreadable(5311, 1250, 4000); // child of 4000
    unreadable(5312, 1250, 1); // reparented to init
    // Went red (5311 false) with the ancestry walk answering false.
    const byPid = Object.fromEntries(scan(77).unknown.map((u) => [u.pid, u.descendant]));
    expect(byPid).toEqual({ 5311: true, 5312: false });
  });

  it("does not report a process that is gone, or one owned by another uid", () => {
    mkdirSync(join(proc, "5313")); // no stat, environ or cwd: every read fails with ENOENT
    unreadable(5314, 1250);
    const foreign = (process.getuid?.() ?? 0) + 1;
    expect(
      findEscapees(
        { ...TARGET, leaderStartMs: LEADER },
        { procDir: proc, selfPid: 1, uid: foreign },
      ),
    ).toEqual({
      pids: [],
      unknown: [],
    });
    rmSync(join(proc, "5314"), { recursive: true });
    expect(scan()).toEqual({ pids: [], unknown: [] });
  });

  it("throws when /proc cannot be listed, and finds nothing for a root nobody carries", () => {
    expect(() => findEscapees(TARGET, { procDir: join(proc, "missing") })).toThrow();
    const result = findEscapees({
      root: `/tmp/no-such-root-${process.pid}-${Date.now()}`,
      cwds: [],
    });
    expect(result.pids).toEqual([]);
  });
});

describe("terminateEscapees (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const spawnFake = (pid: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "environ"), `CLAUDE_CONFIG_DIR=${ROOT}\0`);
  };
  /** A kernel on which the process dies of `diesOn` (never, when null). */
  const kernel = (diesOn: NodeJS.Signals | null) => {
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    return {
      sent,
      signal: (pid: number, name: NodeJS.Signals | 0): void => {
        sent.push([pid, name]);
        if (name === diesOn) rmSync(join(proc, String(pid)), { recursive: true, force: true });
      },
    };
  };
  const fast = { sleep: async () => {}, pollMs: 100, termGraceMs: 100, killGraceMs: 100 };

  it("SIGTERMs an escapee, and is done once the scan comes back empty", async () => {
    spawnFake(6001);
    const k = kernel("SIGTERM");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([]);
    expect(k.sent).toEqual([[6001, "SIGTERM"]]);
  });

  it("escalates to SIGKILL for one that ignores SIGTERM", async () => {
    spawnFake(6002);
    const k = kernel("SIGKILL");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([]);
    expect(k.sent).toEqual([
      [6002, "SIGTERM"],
      [6002, "SIGKILL"],
    ]);
  });

  it("reports an escapee that outlives SIGKILL, never success", async () => {
    spawnFake(6003);
    const k = kernel(null);
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([6003]);
  });

  it("does not signal a pid whose start time changed since it was found", async () => {
    spawnFake(6004);
    const k = kernel("SIGTERM");
    let reads = 0;
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => (reads++ === 0 ? START : START + 3_600_000), // reused after the scan
      ...fast,
    });
    expect(k.sent).toEqual([]);
    expect(left).toEqual([6004]);
  });

  it("does not signal a pid whose /proc start time moved by one second (a recycled pid on Linux)", async () => {
    spawnFake(6009);
    const k = kernel("SIGTERM");
    let reads = 0;
    const startMs = () => (reads++ === 0 ? 10_000 : 11_000);
    const left = await withPlatformAsync("linux", () =>
      terminateEscapees(TARGET, { procDir: proc, selfPid: 1, signal: k.signal, startMs, ...fast }),
    );
    // Went red (a SIGTERM sent to the replacement) with the 2000 ms window on the Linux path.
    expect(k.sent).toEqual([]);
    expect(left).toEqual([6009]);
  });

  it("does not signal a pid whose start time cannot be read", async () => {
    spawnFake(6005);
    const k = kernel("SIGTERM");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => null,
      ...fast,
    });
    expect(k.sent).toEqual([]);
    expect(left).toEqual([6005]);
  });

  const unreadableFake = (pid: number, ticks: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(
      join(proc, String(pid), "stat"),
      `${pid} (x) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1 1\n`,
    );
    mkdirSync(join(proc, String(pid), "environ"));
    writeFileSync(join(proc, String(pid), "cwd"), "not a link");
  };

  it("hands unreadable processes to onUnknown and returns [], signalling nothing", async () => {
    unreadableFake(6006, 1250);
    const k = kernel("SIGTERM");
    const told: number[][] = [];
    const left = await terminateEscapees(
      { ...TARGET, leaderStartMs: 10_000 },
      {
        procDir: proc,
        selfPid: 1,
        signal: k.signal,
        onUnknown: (unknown) => told.push(unknown.map((u) => u.pid)),
        ...fast,
      },
    );
    // Went red (onUnknown never called) with the report removed.
    expect(told).toEqual([[6006]]);
    expect(left).toEqual([]);
    expect(k.sent).toEqual([]);
  });

  it("still stops a readable post-spawn escapee, and reports the unreadable one beside it", async () => {
    spawnFake(6007);
    writeFileSync(
      join(proc, "6007", "stat"),
      "6007 (x) S 1 6007 6007 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1100 1 1\n",
    );
    unreadableFake(6008, 1300);
    const k = kernel("SIGTERM");
    const told: number[][] = [];
    const left = await terminateEscapees(
      { ...TARGET, leaderStartMs: 10_000 },
      {
        procDir: proc,
        selfPid: 1,
        signal: k.signal,
        startMs: () => START,
        onUnknown: (unknown) => told.push(unknown.map((u) => u.pid)),
        ...fast,
      },
    );
    // Went red (nothing signalled) with positive matches no longer stopped.
    expect(k.sent).toEqual([[6007, "SIGTERM"]]);
    expect(left).toEqual([]);
    expect(told).toEqual([[6008]]);
  });

  it("throws when /proc cannot be listed", async () => {
    await expect(
      terminateEscapees(TARGET, { procDir: join(proc, "missing"), ...fast }),
    ).rejects.toThrow();
  });

  it("is a no-op when there is nothing to stop", async () => {
    const k = kernel("SIGTERM");
    expect(
      await terminateEscapees(TARGET, { procDir: proc, selfPid: 1, signal: k.signal, ...fast }),
    ).toEqual([]);
    expect(k.sent).toEqual([]);
  });
});

// ─── Linux only: a real descendant that leaves the group ──────────────────────

describe.skipIf(process.platform !== "linux")("a descendant that calls setsid() (Linux)", () => {
  let dir: string;
  let root: string;
  const strays: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pty-escape-"));
    root = join(dir, "cfg-root");
    mkdirSync(root);
  });
  afterEach(() => {
    const target = { root, cwds: [] as string[] };
    for (const pid of [...strays.splice(0), ...findEscapees(target).pids]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  async function until(condition: () => boolean, ms = 5000): Promise<void> {
    for (const start = Date.now(); !condition(); ) {
      if (Date.now() - start > ms) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * A PTY child whose helper moves to its own session (so also its own process group) and carries
   * the throwaway root, as a daemonised git or a setsid() helper of claude would. The helper
   * writes its own pid, which `exec` keeps, so it is told apart from the shell that carries the
   * same environment.
   */
  async function spawnEscaping(extra: Partial<PtyProcessOptions>) {
    const pidFile = join(dir, "escapee.pid");
    const child = await spawnPty({
      sessionId: "",
      cwd: dir,
      isolation: "untrusted",
      env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: root },
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      _commandOverride: "/bin/sh",
      _argsOverride: [
        "-c",
        `setsid sh -c 'echo $$ > ${pidFile}; trap "" HUP; exec sleep 60' & sleep 60`,
      ],
      _skipReadySettle: true,
      ...extra,
    });
    strays.push(child.pid);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const escapee = Number(readFileSync(pidFile, "utf8").trim());
    strays.push(escapee);
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(escapee)]).toString());
    expect(pgid).not.toBe(child.pid); // it is outside the group the kill reaches
    return { child, escapee };
  }

  it("is dead once the child is retired", async () => {
    const { child, escapee } = await spawnEscaping({
      reapEscapees: async (leader) =>
        terminateEscapees({ root, cwds: [], leaderStartMs: leader.startMs }),
    });
    expect(alive(escapee)).toBe(true);
    await child.dispose();
    expect(alive(escapee)).toBe(false);
  });

  it("twin: with the scan switched off it survives the group kill (so the test above can fail)", async () => {
    const { child, escapee } = await spawnEscaping({});
    await child.dispose();
    expect(alive(escapee)).toBe(true); // killed in afterEach
  });
});
