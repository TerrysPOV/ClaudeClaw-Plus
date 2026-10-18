/**
 * `claudeclaw stop` must never signal what the PID file merely claims is the daemon
 * (#549 review). `kill(0, …)` and `kill(-1, …)` signal a whole process group / every
 * process the user owns; a recycled PID names an unrelated program.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StopDeps, stop } from "../commands/stop";
import {
  decideStopTarget,
  isPidAlive,
  parseDaemonPid,
  parseProcCmdline,
  readProcessCommand,
} from "../pid";

describe("parseDaemonPid", () => {
  it("accepts a plain positive integer, with surrounding whitespace", () => {
    expect(parseDaemonPid("4242")).toBe(4242);
    expect(parseDaemonPid(" 4242\n")).toBe(4242);
  });

  it("rejects 0, negatives, fractions, exponents, hex, garbage, empty and huge values", () => {
    for (const bad of [
      "0",
      "-1",
      "-0",
      "1.5",
      "1e3",
      "0x10",
      "abc",
      "12abc",
      "",
      "  ",
      "+5",
      "99999999999",
    ]) {
      expect(parseDaemonPid(bad)).toBeNull();
    }
  });
});

describe("isPidAlive", () => {
  it("is false for pids that would address a process group or everyone", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("is still true for a real, live process (this one)", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe("decideStopTarget", () => {
  const PROJECT = "/srv/proj";
  const cmd = (c: string | null) => () => c;
  const cwd = (d: string | null) => () => d;
  const decide = (
    raw: string,
    command: string | null,
    procCwd: string | null = PROJECT,
  ): ReturnType<typeof decideStopTarget> =>
    decideStopTarget(raw, cmd(command), cwd(procCwd), PROJECT);

  it("invalid file contents -> invalid, and neither command nor cwd is read", () => {
    let read = 0;
    const d = decideStopTarget(
      "-1",
      () => {
        read++;
        return "bun run src/index.ts start";
      },
      () => {
        read++;
        return PROJECT;
      },
      PROJECT,
    );
    expect(d).toEqual({ kind: "invalid" });
    expect(read).toBe(0);
  });

  describe("what IS the daemon", () => {
    for (const command of [
      "bun run src/index.ts start",
      "bun run /opt/claudeclaw/src/index.ts start --web",
      "/Users/me/.bun/bin/bun --watch src/index.ts start --web --replace-existing",
      "bun run /opt/my claw/src/index.ts start",
      "/usr/local/bin/claudeclaw start",
      "claudeclaw start --web",
      // the real launches carry no `start` token: index.ts falls through to start()
      "bun run src/index.ts --web", // commands/start.md
      "/usr/local/bin/bun run /opt/claudeclaw/src/index.ts --web", // docs/deploy-systemd-hardening.md
      "bun run src/index.ts", // package.json "start"
      "bun run src/index.ts ", // trailing whitespace from ps
      "bun run src/index.ts serve", // not a subcommand, so it starts the daemon too
      "bun run src/index.ts start --prompt hi", // unchanged
      "bun /usr/local/bin/claudeclaw start", // shim behind an interpreter
      "/usr/bin/env bun /usr/local/bin/claudeclaw start --web",
      "/usr/bin/env bun run /usr/local/bin/claudeclaw --web",
      "claudeclaw", // bare shim also starts the daemon
    ]) {
      it(JSON.stringify(command), () => {
        expect(decide("4242", command)).toEqual({ kind: "ok", pid: 4242 });
      });
    }

    it("when the process cwd cannot be read, the command shape alone decides", () => {
      expect(decide("4242", "bun run src/index.ts start", null)).toEqual({ kind: "ok", pid: 4242 });
    });
  });

  describe("what is NOT the daemon (a recycled PID)", () => {
    for (const command of [
      "bun some-other-app.ts",
      "bun run /srv/app/src/server.ts",
      "bun run dev",
      "/usr/bin/vim notes.txt",
      "bun run src/index.ts --stop", // right entry, a subcommand that is not the daemon
      "bun run src/index.ts --stop-all",
      "bun run src/index.ts status",
      "bun run src/index.ts  status --json", // extra spaces must not hide the subcommand
      "bun run src/index.ts send hello",
      "bun run src/index.ts fire reg:topic",
      "bun run src/index.ts --help",
      "bun run src/index.ts telegram",
      "claudeclaw --stop",
      "claudeclaw status",
      "bun /usr/local/bin/claudeclaw send hi",
      "node /srv/fake-src/index.ts start", // not a `src/` path component
      "bun run src/index.tsx start",
      "claudeclaw-helper start",
      "bun x claudeclaw-unrelated",
    ]) {
      it(JSON.stringify(command), () => {
        expect(decide("4242", command)).toMatchObject({ kind: "not-daemon", pid: 4242, command });
      });
    }

    it("the daemon's entry shape in a DIFFERENT directory is another project's app, not this daemon", () => {
      expect(decide("4242", "bun run src/index.ts start", "/srv/other-app")).toMatchObject({
        kind: "not-daemon",
        pid: 4242,
      });
    });

    it("a different string for the same directory (symlink) is still this project's daemon", () => {
      const real = mkdtempSync(join(tmpdir(), "proj-real-"));
      const link = `${real}-link`;
      symlinkSync(real, link);
      try {
        expect(
          decideStopTarget("4242", cmd("bun run src/index.ts start"), cwd(link), real),
        ).toEqual({
          kind: "ok",
          pid: 4242,
        });
      } finally {
        rmSync(link, { force: true });
        rmSync(real, { recursive: true, force: true });
      }
    });

    it("two different directories that merely look alike are not the same", () => {
      expect(decide("4242", "bun run src/index.ts start", `${PROJECT}-x`)).toMatchObject({
        kind: "not-daemon",
      });
    });
  });

  it("command line unreadable -> ok (falls back to the PID file alone, as before)", () => {
    expect(decide("4242", null)).toEqual({ kind: "ok", pid: 4242 });
  });

  it("pid 1 is only ever the daemon when its command line says so (container case, #526)", () => {
    expect(decide("1", "/sbin/init")).toMatchObject({ kind: "not-daemon", pid: 1 });
    expect(decide("1", null)).toEqual({ kind: "refuse-pid1", pid: 1 });
    expect(decide("1", "bun run /app/src/index.ts start")).toEqual({ kind: "ok", pid: 1 });
    expect(decide("1", "bun some-other-app.ts")).toMatchObject({ kind: "not-daemon", pid: 1 });
  });
});

describe("readProcessCommand without ps (slim containers, #526/#527)", () => {
  // A pid `ps` cannot find (above the 2^22 pid ceiling), so only the fallback can answer.
  const NO_SUCH_PID = 4_194_999;

  it("falls back to /proc/<pid>/cmdline when ps cannot read the process", () => {
    const asked: number[] = [];
    const cmd = readProcessCommand(NO_SUCH_PID, (pid) => {
      asked.push(pid);
      return "bun run /app/src/index.ts --web";
    });
    expect(cmd).toBe("bun run /app/src/index.ts --web");
    expect(asked).toEqual([NO_SUCH_PID]);
  });

  it("does not consult the fallback when ps answered", () => {
    let asked = 0;
    const cmd = readProcessCommand(process.pid, () => {
      asked++;
      return "fallback";
    });
    expect(cmd).not.toBe("fallback");
    expect(cmd).not.toBeNull();
    expect(asked).toBe(0);
  });

  it("null when neither ps nor the fallback can read it", () => {
    expect(readProcessCommand(NO_SUCH_PID, () => null)).toBeNull();
  });

  it("joins /proc's NUL-separated arguments with spaces, null for an empty file", () => {
    expect(parseProcCmdline("bun\0run\0/app/src/index.ts\0--web\0")).toBe(
      "bun run /app/src/index.ts --web",
    );
    expect(parseProcCmdline("")).toBeNull();
    expect(parseProcCmdline("\0\0")).toBeNull();
  });
});

class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe("stop() with a bad PID file", () => {
  let dir: string;
  let pidFile: string;
  let saves: number;
  let deps: StopDeps;
  let kills: Array<[number, string | number | undefined]>;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stop-pid-"));
    pidFile = join(dir, "daemon.pid");
    saves = 0;
    kills = [];
    deps = {
      pidFile,
      saveMemoryOneShot: async () => {
        saves++;
      },
      teardownStatusline: async () => {},
      removeHeartbeatState: async () => {},
      readProcessCommand: () => "bun run src/index.ts start",
      readProcessCwd: () => process.cwd(),
    };
    const realKill = process.kill.bind(process);
    spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      kills.push([pid, sig]);
      // signal 0 probes only; anything else would be a real signal: refuse in the test
      if (sig === 0 || sig === undefined) return realKill(pid, 0);
      return true;
    }) as typeof process.kill);
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(async () => {
    (process.kill as unknown as { mockRestore?: () => void }).mockRestore?.();
    (process.exit as unknown as { mockRestore?: () => void }).mockRestore?.();
    for (const c of children.splice(0)) {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function run(): Promise<number | undefined> {
    try {
      await stop(deps);
    } catch (e) {
      if (e instanceof ExitCalled) return e.code;
      throw e;
    }
    throw new Error("stop() returned without process.exit");
  }

  for (const bad of ["0", "-1", "garbage", "12abc", "1.5", ""]) {
    it(`PID file ${JSON.stringify(bad)}: nothing is probed or signalled, no save, exit 1, file left alone`, async () => {
      await writeFile(pidFile, bad);

      const code = await run();

      expect(code).toBe(1);
      expect(kills).toEqual([]);
      expect(saves).toBe(0);
      expect(await readFile(pidFile, "utf-8")).toBe(bad);
    });
  }

  it("PID 1 with an unreadable command line: refused, nothing signalled", async () => {
    await writeFile(pidFile, "1");
    deps.readProcessCommand = () => null;

    const code = await run();

    expect(code).toBe(1);
    expect(kills.filter(([, s]) => s !== 0)).toEqual([]);
    expect(saves).toBe(0);
  });

  it("a live process whose command line is not the daemon: not signalled, treated as no daemon", async () => {
    const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    children.push(other);
    await writeFile(pidFile, String(other.pid));
    deps.readProcessCommand = () => "/usr/bin/vim notes.txt";

    const code = await run();

    expect(code).toBe(0);
    expect(kills.filter(([, s]) => s !== 0)).toEqual([]); // no SIGTERM, no SIGKILL
    expect(isPidAlive(other.pid)).toBe(true); // the unrelated process is untouched
    expect(saves).toBe(1); // no daemon is running, so the one-shot save stays
  });
});
