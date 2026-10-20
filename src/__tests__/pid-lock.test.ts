/**
 * #435: every reader-that-removes, writer and remover of `daemon.pid` shares a
 * project-scoped lock, so `cleanupPidFileIf()`'s read → unlink cannot land
 * between a concurrent `start`'s `checkExistingDaemon()` and `writePidFile()`.
 *
 * Contenders run in child processes: the lock is cross-process by design, and
 * within one process it is re-entrant.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquirePidLock, cleanupPidFileIf, getPidLockPath, releasePidLock } from "../pid";

const PID_MODULE = resolve(import.meta.dir, "..", "pid.ts");
// A PID that existed and is gone: a spawned and reaped child, not a constant
// that may be a live PID on a host with a large pid_max.
const reaped = Bun.spawnSync(["true"]);
const DEAD_PID = reaped.pid;

let dir: string;
let pidFile: string;
let lockFile: string;

beforeEach(() => {
  // A temp dir, never the project's real daemon.pid / daemon.lock.
  dir = mkdtempSync(join(tmpdir(), "ccplus-pidlock-"));
  pidFile = join(dir, "daemon.pid");
  lockFile = getPidLockPath(pidFile);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A child that takes the lock, signals it holds it (`<dir>/held`), keeps it
 * for `holdMs`, then — like `start` — writes its own PID and releases.
 */
function spawnStartLike(holdMs: number) {
  const script = `
    import { writeFileSync } from "node:fs";
    import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
    const pidFile = ${JSON.stringify(pidFile)};
    const r = await acquirePidLock(pidFile, 5000);
    if (!r.ok) process.exit(3);
    writeFileSync(${JSON.stringify(join(dir, "held"))}, "1");
    await Bun.sleep(${holdMs});
    writeFileSync(pidFile, process.pid + "\\n");
    releasePidLock(pidFile);
  `;
  return Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" });
}

async function waitFor(path: string, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

describe("PID lock (#435)", () => {
  it("cleanupPidFileIf does not unlink while a start holds the lock between check and write", async () => {
    // The old daemon's file, as `stop` / `--replace-existing` find it after the drain.
    writeFileSync(pidFile, "4242\n");
    const child = spawnStartLike(600);
    try {
      await waitFor(join(dir, "held"));
      // The start is between its check and its write: removing now is the
      // residual window #435 is about.
      expect(await cleanupPidFileIf(4242, pidFile, 100)).toBe("locked");
      expect(readFileSync(pidFile, "utf-8").trim()).toBe("4242");
      expect(await child.exited).toBe(0);
      // Once released, the file names the new daemon and must survive.
      expect(await cleanupPidFileIf(4242, pidFile)).toBe("foreign");
      expect(readFileSync(pidFile, "utf-8").trim()).toBe(String(child.pid));
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("cleanupPidFileIf waits for a short hold and then proceeds", async () => {
    writeFileSync(pidFile, "4242\n");
    const child = spawnStartLike(150);
    try {
      await waitFor(join(dir, "held"));
      // The child writes its own PID before releasing: compare-and-unlink sees it.
      expect(await cleanupPidFileIf(4242, pidFile, 5000)).toBe("foreign");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a second contender is refused while the lock is held, with the holder's PID", async () => {
    const child = spawnStartLike(800);
    try {
      await waitFor(join(dir, "held"));
      const r = await acquirePidLock(pidFile, 100);
      expect(r).toEqual({ ok: false, holder: child.pid });
      expect(await child.exited).toBe(0);
      const r2 = await acquirePidLock(pidFile, 100);
      expect(r2.ok).toBe(true);
      releasePidLock(pidFile);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("concurrent contenders never overlap inside the lock", async () => {
    const log = join(dir, "log");
    writeFileSync(log, "");
    const script = `
      import { appendFileSync } from "node:fs";
      import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 20000);
      if (!r.ok) process.exit(3);
      appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");
      await Bun.sleep(40);
      appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n");
      releasePidLock(${JSON.stringify(pidFile)});
    `;
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" }),
    );
    const codes = await Promise.all(children.map((c) => c.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(12);
    // Strict alternation: every "in" is followed by the same PID's "out".
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toStartWith("in ");
      expect(lines[i + 1]).toBe(lines[i].replace("in ", "out "));
    }
    expect(existsSync(lockFile)).toBe(false);
  }, 30_000);

  it("contenders taking over a stale lock together never overlap", async () => {
    const log = join(dir, "log");
    const script = `
      import { appendFileSync } from "node:fs";
      import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 20000);
      if (!r.ok) process.exit(3);
      appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");
      await Bun.sleep(15);
      appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n");
      releasePidLock(${JSON.stringify(pidFile)});
    `;
    for (let round = 0; round < 8; round++) {
      writeFileSync(log, "");
      writeFileSync(lockFile, `${DEAD_PID}\n`); // left by a crashed start
      const children = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" }),
      );
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      const lines = readFileSync(log, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(16);
      for (let i = 0; i < lines.length; i += 2) {
        expect(lines[i]).toStartWith("in ");
        expect(lines[i + 1]).toBe(lines[i].replace("in ", "out "));
      }
      expect(existsSync(lockFile)).toBe(false);
    }
  }, 60_000);

  it("a lock left by a dead process is stale and taken over", async () => {
    writeFileSync(lockFile, `${DEAD_PID}\n`);
    const r = await acquirePidLock(pidFile, 100);
    expect(r.ok).toBe(true);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
    releasePidLock(pidFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("an old steal guard left by a dead stealer whose PID was recycled does not wedge the lock", async () => {
    writeFileSync(lockFile, `${DEAD_PID}\n`);
    writeFileSync(`${lockFile}.steal`, "1\n"); // PID 1: alive, unrelated
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockFile}.steal`, old, old);
    const r = await acquirePidLock(pidFile, 500);
    expect(r.ok).toBe(true);
    releasePidLock(pidFile);
    expect(existsSync(`${lockFile}.steal`)).toBe(false);
  });

  it("an old lock that does not hold a PID is not judged stale (fail closed)", async () => {
    writeFileSync(lockFile, "not-a-pid\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    const r = await acquirePidLock(pidFile, 300);
    expect(r).toEqual({ ok: false, holder: null });
    expect(readFileSync(lockFile, "utf-8")).toBe("not-a-pid\n");
  });

  it.skipIf(process.getuid?.() === 0)("an old unreadable lock is not judged stale", async () => {
    writeFileSync(lockFile, "12345\n");
    chmodSync(lockFile, 0o000);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    const r = await acquirePidLock(pidFile, 300);
    expect(r).toEqual({ ok: false, holder: null });
    expect(existsSync(lockFile)).toBe(true);
  });

  it("a fresh empty steal guard (an O_EXCL create not yet written) is not removed", async () => {
    writeFileSync(lockFile, `${DEAD_PID}\n`); // stale: would be taken over...
    writeFileSync(`${lockFile}.steal`, ""); // ...but another stealer is mid-create
    const r = await acquirePidLock(pidFile, 300);
    expect(r.ok).toBe(false);
    expect(existsSync(`${lockFile}.steal`)).toBe(true);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(DEAD_PID));
  });

  it("an empty lock (an O_EXCL create not yet written) is not stale until it is old", async () => {
    writeFileSync(lockFile, "");
    expect(await acquirePidLock(pidFile, 100)).toEqual({ ok: false, holder: null });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    releasePidLock(pidFile);
  });

  it("a lock naming this PID that this process does not hold is stale (recycled PID)", async () => {
    writeFileSync(lockFile, `${process.pid}\n`);
    const r = await acquirePidLock(pidFile, 100);
    expect(r.ok).toBe(true);
    releasePidLock(pidFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("is re-entrant within a process: cleanupPidFileIf under start's own hold proceeds", async () => {
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    try {
      writeFileSync(pidFile, "4242\n");
      // `--replace-existing` holds the lock and then removes the old daemon's file.
      expect(await cleanupPidFileIf(4242, pidFile, 0)).toBe("removed");
      // The inner release must not drop the outer hold.
      expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
    } finally {
      releasePidLock(pidFile);
    }
    expect(existsSync(lockFile)).toBe(false);
  });

  it("a process exiting while holding the lock leaves no lock file", async () => {
    const script = `
      import { acquirePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 1000);
      process.exit(r.ok ? 7 : 3);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stderr: "inherit" });
    expect(await child.exited).toBe(7);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("checkExistingDaemon run while a start holds the lock reports that start, and leaves the file", async () => {
    // checkExistingDaemon reads the cwd's project: run it in a child whose cwd is the temp project.
    const proj = mkdtempSync(join(tmpdir(), "ccplus-pidlock-proj-"));
    const pf = join(proj, ".claude", "claudeclaw", "daemon.pid");
    try {
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
          import { writeFileSync } from "node:fs";
          import { acquirePidLock } from ${JSON.stringify(PID_MODULE)};
          const r = await acquirePidLock(${JSON.stringify(pf)}, 1000);
          if (!r.ok) process.exit(3);
          writeFileSync(${JSON.stringify(pf)}, "${DEAD_PID}\\n"); // a stale file, mid-start
          writeFileSync(${JSON.stringify(join(proj, "held"))}, "1");
          await Bun.sleep(4000);
        `,
        ],
        { stderr: "inherit" },
      );
      try {
        await waitFor(join(proj, "held"));
        const check = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
            import { checkExistingDaemon } from ${JSON.stringify(PID_MODULE)};
            console.log(String(await checkExistingDaemon()));
          `,
          ],
          { cwd: proj, stdout: "pipe", stderr: "inherit" },
        );
        const out = (await new Response(check.stdout).text()).trim();
        expect(out).toBe(String(holder.pid));
        expect(readFileSync(pf, "utf-8").trim()).toBe(String(DEAD_PID)); // not removed under the start
      } finally {
        holder.kill("SIGKILL");
      }
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 20_000);

  it("release does not remove a lock that is no longer ours", async () => {
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    writeFileSync(lockFile, "1\n"); // replaced behind our back
    releasePidLock(pidFile);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe("1");
  });
});

describe("daemon.pid naming the caller (#526)", () => {
  let proj: string;
  let home: string;
  let pidPath: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "ccplus-pidself-"));
    home = mkdtempSync(join(tmpdir(), "ccplus-pidself-home-"));
    mkdirSync(join(proj, ".claude", "claudeclaw"), { recursive: true });
    pidPath = join(proj, ".claude", "claudeclaw", "daemon.pid");
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** checkExistingDaemon() in a child whose cwd is the temp project; `pidExpr` is written to daemon.pid first. */
  async function check(pidExpr: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { writeFileSync } from "node:fs";
          import { checkExistingDaemon } from ${JSON.stringify(PID_MODULE)};
          writeFileSync(${JSON.stringify(pidPath)}, String(${pidExpr}) + "\\n");
          console.log(String(await checkExistingDaemon()));
        `,
      ],
      { cwd: proj, env: { HOME: home, PATH: "/nonexistent" }, stdout: "pipe", stderr: "inherit" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const out = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(timer);
    return out.trim();
  }

  it("a file left with the caller's own PID (container restart, PID 1) is stale: no daemon, file removed", async () => {
    expect(await check("process.pid")).toBe("null");
    expect(existsSync(pidPath)).toBe(false);
  }, 20_000);

  it("another live PID is still reported as a running daemon", async () => {
    expect(await check(String(process.pid))).toBe(String(process.pid));
    expect(existsSync(pidPath)).toBe(true);
  }, 20_000);
});

/**
 * A lock that can be neither taken nor judged stale leaves the daemon's state
 * unknown. That must not read as "no daemon": `clear` and the one-shot
 * `start` act on it. The project's `daemon.lock` is made a fresh directory —
 * it exists (busy), holds no PID and is not old, so every attempt fails with
 * no holder — while `daemon.pid` names a live process (this test runner).
 */
describe("PID lock state unknown (#435)", () => {
  let proj: string;
  let home: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "ccplus-pidlock-unknown-"));
    home = mkdtempSync(join(tmpdir(), "ccplus-pidlock-home-"));
    const stateDir = join(proj, ".claude", "claudeclaw");
    mkdirSync(join(stateDir, "daemon.lock"), { recursive: true });
    writeFileSync(join(stateDir, "daemon.pid"), `${process.pid}\n`);
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Run `code` with the temp project as cwd; killed if it outlives `maxMs`. */
  async function runIn(code: string, maxMs = 15_000) {
    const child = Bun.spawn([process.execPath, "-e", code], {
      cwd: proj,
      // A temp HOME, no `claude` on PATH and nothing else inherited: a
      // one-shot that got past the check must not reach a real setup.
      env: { HOME: home, PATH: "/nonexistent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), maxMs);
    const [stdout, stderr, code_] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { stdout, stderr, code: code_ };
  }

  it("checkExistingDaemon throws DaemonStateUnknownError instead of reporting no daemon", async () => {
    const r = await runIn(`
      import { checkExistingDaemon, DaemonStateUnknownError } from ${JSON.stringify(PID_MODULE)};
      try {
        console.log("result=" + String(await checkExistingDaemon()));
      } catch (err) {
        console.log(err instanceof DaemonStateUnknownError ? "unknown" : "other: " + err);
      }
    `);
    expect(r.stdout.trim()).toBe("unknown");
  }, 20_000);

  it("clear refuses with a non-zero exit instead of declaring no daemon, session untouched", async () => {
    const session = join(proj, ".claude", "claudeclaw", "session.json");
    const body = JSON.stringify({
      sessionId: "s1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      turnCount: 1,
      compactWarned: false,
    });
    writeFileSync(session, body);
    const r = await runIn(`
      import { clear } from ${JSON.stringify(resolve(import.meta.dir, "..", "commands", "clear.ts"))};
      await clear();
    `);
    expect(r.stdout).not.toContain("No daemon running");
    expect(r.stderr).toContain("cannot tell whether a daemon is running");
    expect(r.code).toBe(1);
    // Refused before the backup: the session was not rotated away.
    expect(readFileSync(session, "utf-8")).toBe(body);
  }, 20_000);

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable daemon.pid is unknown, not absent",
    async () => {
      rmSync(join(proj, ".claude", "claudeclaw", "daemon.lock"), { recursive: true });
      chmodSync(join(proj, ".claude", "claudeclaw", "daemon.pid"), 0o000);
      const r = await runIn(`
        import { checkExistingDaemon, DaemonStateUnknownError } from ${JSON.stringify(PID_MODULE)};
        try {
          console.log("result=" + String(await checkExistingDaemon()));
        } catch (err) {
          console.log(err instanceof DaemonStateUnknownError ? "unknown" : "other: " + err);
        }
      `);
      expect(r.stdout.trim()).toBe("unknown");
    },
    20_000,
  );

  it("one-shot start refuses with a non-zero exit before running anything", async () => {
    const r = await runIn(`
      import { start } from ${JSON.stringify(resolve(import.meta.dir, "..", "commands", "start.ts"))};
      await start(["--prompt", "hello"]);
    `);
    expect(r.stderr).toContain("cannot tell whether a daemon is running");
    expect(r.code).toBe(1);
    // It stopped at the check: the config step that follows never ran.
    expect(existsSync(join(proj, ".claude", "claudeclaw", "settings.json"))).toBe(false);
  }, 20_000);
});
