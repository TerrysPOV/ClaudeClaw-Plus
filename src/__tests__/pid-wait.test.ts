/**
 * #315: `stop` / `--replace-existing` must not declare a daemon stopped (and
 * remove its PID file) while it is still draining. `waitForPidExit` is the
 * primitive they wait on.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cleanupPidFileIf,
  getPidPath,
  isPidAlive,
  readConfiguredDrainMs,
  stopGraceMs,
  SHUTDOWN_MEMORY_SAVE_MS,
  waitForPidExit,
} from "../pid";

describe("waitForPidExit (#315)", () => {
  it("resolves true at once for a pid that does not exist", async () => {
    const t0 = Date.now();
    expect(await waitForPidExit(2 ** 22 - 7, 5000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("resolves false at the deadline while the process is alive, true once it exits", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    try {
      expect(await waitForPidExit(child.pid, 150, 20)).toBe(false);
      child.kill("SIGTERM");
      expect(await waitForPidExit(child.pid, 5000, 20)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("readConfiguredDrainMs reads a project's own settings.json, validated like the loader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccplus-pid-drain-"));
    try {
      expect(await readConfiguredDrainMs(dir)).toBeUndefined(); // no file
      mkdirSync(join(dir, ".claude", "claudeclaw"), { recursive: true });
      const f = join(dir, ".claude", "claudeclaw", "settings.json");
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: 60_000 } }));
      expect(await readConfiguredDrainMs(dir)).toBe(60_000);
      expect(stopGraceMs(await readConfiguredDrainMs(dir))).toBe(95_000);
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: 0 } }));
      expect(await readConfiguredDrainMs(dir)).toBe(0);
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: -5 } }));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: "soon" } }));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, "{ not json");
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, JSON.stringify({}));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isPidAlive: EPERM means alive (a process that is not ours), ESRCH means gone (#420)", () => {
    // PID 1 exists and is not ours: kill(1, 0) throws EPERM for an unprivileged user.
    if (process.getuid?.() !== 0) expect(isPidAlive(1)).toBe(true);
    expect(isPidAlive(2 ** 22 - 7)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("cleanupPidFileIf removes the file only when it still names the expected pid (#420)", async () => {
    // A temp file, never the project's real daemon.pid (CodeRabbit): a daemon
    // command running alongside the tests must not read a test value.
    const dir = mkdtempSync(join(tmpdir(), "ccplus-pidfile-"));
    const file = join(dir, "daemon.pid");
    try {
      writeFileSync(file, "4242\n");
      expect(await cleanupPidFileIf(9999, file)).toBe("foreign"); // another daemon owns it now
      expect(existsSync(file)).toBe(true);
      expect(await cleanupPidFileIf(4242, file)).toBe("removed");
      expect(existsSync(file)).toBe(false);
      expect(await cleanupPidFileIf(4242, file)).toBe("absent"); // the daemon removed its own file: normal
      writeFileSync(file, "garbage\n");
      expect(await cleanupPidFileIf(4242, file)).toBe("removed"); // a corrupt file names nobody
      expect(existsSync(file)).toBe(false);
      expect(getPidPath()).toContain("daemon.pid"); // the default path is the project's
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopGraceMs = drain window + the memory save's own slot + teardown margin, default 65s", () => {
    expect(stopGraceMs()).toBe(65_000);
    expect(stopGraceMs(0)).toBe(SHUTDOWN_MEMORY_SAVE_MS + 5_000);
    expect(stopGraceMs(0)).toBe(35_000);
    expect(stopGraceMs(10_000)).toBe(45_000);
  });
});
