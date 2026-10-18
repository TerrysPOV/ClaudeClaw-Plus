/**
 * `claudeclaw stop` (#549): with a daemon running, the CLI spawns no `claude` — the
 * daemon saves memory itself on SIGTERM. Only with no daemon running does the CLI
 * keep a one-shot save.
 *
 * The "daemon" is a real `sleep` child so SIGTERM, `waitForPidExit` and the PID-file
 * cleanup run for real; the PID file, statusline and heartbeat state are injected so
 * nothing outside the temp dir is touched.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StopDeps, stop } from "../commands/stop";

class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let dir: string;
let pidFile: string;
let saveCalls: number;
let deps: StopDeps;
let spawns: string[][];
let realSpawn: typeof Bun.spawn;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stop-test-"));
  pidFile = join(dir, "daemon.pid");
  saveCalls = 0;
  deps = {
    pidFile,
    saveMemoryOneShot: async () => {
      saveCalls++;
    },
    teardownStatusline: async () => {},
    removeHeartbeatState: async () => {},
    // the stand-in daemon is a `sleep`; make it look like one
    readProcessCommand: () => "bun run src/index.ts start",
  };
  spawns = [];
  realSpawn = Bun.spawn;
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
});

afterEach(async () => {
  (Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn;
  (process.exit as unknown as { mockRestore?: () => void }).mockRestore?.();
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
});

/** Watch every later Bun.spawn; the child below is started before the spy goes on. */
function watchSpawns(): void {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((
    cmd: string[] | { cmd: string[] },
    ...rest: unknown[]
  ) => {
    spawns.push(Array.isArray(cmd) ? cmd : cmd.cmd);
    return (realSpawn as (...a: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof Bun.spawn;
}

async function runStop(): Promise<number | undefined> {
  try {
    await stop(deps);
  } catch (e) {
    if (e instanceof ExitCalled) return e.code;
    throw e;
  }
  throw new Error("stop() returned without calling process.exit");
}

describe("stop()", () => {
  it("with a running daemon, spawns no claude and runs no CLI-side save", async () => {
    const daemon = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    children.push(daemon);
    await writeFile(pidFile, String(daemon.pid));
    watchSpawns();

    const code = await runStop();

    expect(code).toBe(0);
    expect(spawns.filter((c) => c.some((a) => /claude/.test(a)))).toEqual([]);
    expect(saveCalls).toBe(0);
    // it did signal the daemon: the sleep child is gone
    await daemon.exited;
    expect(daemon.signalCode).toBe("SIGTERM");
  }, 15_000);

  it("with a PID file naming a dead process (no daemon), keeps the one-shot save", async () => {
    const gone = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    await writeFile(pidFile, String(gone.pid));

    const code = await runStop();

    expect(code).toBe(0);
    expect(saveCalls).toBe(1);
  }, 15_000);

  it("with no PID file, does nothing and saves nothing", async () => {
    const code = await runStop();

    expect(code).toBe(0);
    expect(saveCalls).toBe(0);
    await expect(readFile(pidFile, "utf-8")).rejects.toBeDefined();
  });
});
