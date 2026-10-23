/**
 * `PtyProcess.dispose()` against a REAL child (#562 round 7, Fix 1).
 *
 * bun-pty 0.4.9 `kill()` ignores its signal argument, fires `onExit` synchronously whether or
 * not the child died, and makes every later `kill()` a no-op. A mock of it can only encode what
 * we believe it does, which is how round 6 shipped a SIGKILL escalation that never ran. These
 * tests use the real library and a child that traps TERM and HUP, and read death from the OS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PtyExitUnconfirmedError, readPidIdentity, spawnPty } from "../runner/pty-process";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const spawned: number[] = [];
afterEach(() => {
  // A failed assertion must not leave a stubborn child behind.
  for (const pid of spawned.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
});

/** A shell that ignores TERM and HUP, with a child of its own in the same group. */
const stubbornScript = (pidFile: string): string =>
  `trap "" TERM HUP; sleep 300 & echo $! > ${pidFile}; while :; do sleep 1; done`;

async function spawnStubborn(extra: { _exitGraceMs?: number; _exitCapMs?: number } = {}) {
  const pidFile = `/tmp/pty-dispose-real-${process.pid}-${Math.random().toString(36).slice(2)}.pid`;
  const proc = await spawnPty({
    sessionId: "",
    cwd: "/tmp",
    security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
    env: { PATH: process.env.PATH ?? "" },
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", stubbornScript(pidFile)],
    transcriptPath: "/tmp/never-written.jsonl",
    ...extra,
  });
  spawned.push(proc.pid);
  // Let the shell install its trap and fork the grandchild.
  await Bun.sleep(400);
  const grandchild = Number((await Bun.file(pidFile).text()).trim());
  spawned.push(grandchild);
  return { proc, grandchild };
}

describe("PtyProcess.dispose — real child that ignores SIGTERM and SIGHUP", () => {
  test("is dead, with its group, by the time dispose() resolves", async () => {
    // Fault (a) (site: `_retire`, skip the pid confirmation and trust bun-pty's exit event):
    // dispose() resolves at once, because the synthetic `onExit` has already fired. Predicted
    // result: the shell is still alive when it resolves.
    // Fault (b) (site: `_confirmGoneByPid`, no direct SIGKILL): the shell never dies, so
    // dispose() rejects with PtyExitUnconfirmedError at the cap instead of resolving.
    const { proc, grandchild } = await spawnStubborn({ _exitGraceMs: 300, _exitCapMs: 1500 });
    expect(alive(proc.pid)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    await proc.dispose();

    expect(alive(proc.pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(proc.isAlive()).toBe(false);
  });

  test("a second dispose() joins the first and also resolves with the process gone", async () => {
    const { proc } = await spawnStubborn({ _exitGraceMs: 300, _exitCapMs: 1500 });
    const first = proc.dispose();
    const second = proc.dispose();
    await Promise.all([first, second]);
    expect(alive(proc.pid)).toBe(false);
  });

  test("a pid the OS will not let us signal (EPERM) is reported, not assumed dead", async () => {
    const proc = await spawnPty({
      sessionId: "",
      cwd: "/tmp",
      security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
      env: { PATH: process.env.PATH ?? "" },
      agentName: "test",
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      _commandOverride: "/bin/cat",
      _argsOverride: [],
      transcriptPath: "/tmp/never-written.jsonl",
      _exitGraceMs: 100,
      _exitCapMs: 300,
      _signalPid: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    spawned.push(proc.pid);
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
  });
});

describe("readPidIdentity — the birth identity that tells a reused pid from the original", () => {
  test("a live process has a stable identity; a pid nobody holds has none", () => {
    // Fault (site: `readPidIdentity`, return a constant): a pid nobody holds still "has" an
    // identity, so a reused or vanished pid could never be told from the original.
    // Predicted result: the `toBeNull()` below fails.
    const first = readPidIdentity(process.pid);
    expect(first).not.toBeNull();
    expect(readPidIdentity(process.pid)).toBe(first);
    expect(readPidIdentity(2 ** 22 + 12345)).toBeNull();
  });

  test("two different live processes do not share an identity once their start differs", async () => {
    // A child started later than this process (the test run is long past its start second)
    // must not read as the test runner itself.
    const child = Bun.spawn(["/bin/sleep", "30"]);
    spawned.push(child.pid);
    await Bun.sleep(50);
    const mine = readPidIdentity(process.pid);
    const theirs = readPidIdentity(child.pid);
    expect(theirs).not.toBeNull();
    expect(theirs).not.toBe(mine);
  });
});
