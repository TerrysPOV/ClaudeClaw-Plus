import { unlink, readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  getPidPath,
  cleanupPidFileIf,
  isPidAlive,
  waitForPidExit,
  stopGraceMs,
  readConfiguredDrainMs,
} from "../pid";
import { removeStatuslineSetting } from "../statusline-settings";
import { saveGlobalMemoryOneShot } from "../shutdown-memory-save";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

async function teardownStatusline() {
  try {
    await removeStatuslineSetting(CLAUDE_SETTINGS_FILE);
  } catch (err) {
    console.warn("[statusline] teardown failed:", err);
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

/** The CLI-side save is bounded like the old `claude -p` call was. */
const CLI_MEMORY_SAVE_TIMEOUT_MS = 30_000;

/** What `stop()` touches outside the daemon, injectable so it can be tested without a real project dir. */
export interface StopDeps {
  pidFile: string;
  /** One-shot memory save, for when NO daemon is running. */
  saveMemoryOneShot: () => Promise<unknown>;
  teardownStatusline: () => Promise<void>;
  removeHeartbeatState: () => Promise<void>;
}

function defaultStopDeps(): StopDeps {
  return {
    pidFile: getPidPath(),
    saveMemoryOneShot: () => saveGlobalMemoryOneShot({ timeoutMs: CLI_MEMORY_SAVE_TIMEOUT_MS }),
    teardownStatusline,
    removeHeartbeatState: async () => {
      try {
        await unlink(join(HEARTBEAT_DIR, "state.json"));
      } catch {
        // already gone
      }
    },
  };
}

export async function stop(deps: StopDeps = defaultStopDeps()) {
  const pidFile = deps.pidFile;
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  // #549: with a daemon running, the daemon saves memory itself when it gets the
  // SIGTERM, by asking its live sessions — a `claude -p` resumed here would be a
  // second process writing the transcript the live PTY owns. Only when no daemon is
  // running (a stale PID file) is there nobody else to do it.
  if (!isPidAlive(Number(pid))) {
    await deps.saveMemoryOneShot();
  }

  try {
    process.kill(Number(pid), "SIGTERM");
    // #315: the daemon drains its in-flight turns before exiting. Until it
    // is gone it still owns the bus socket and the agents, so it is not
    // "stopped" and its PID file must stay (a `start` meanwhile would launch
    // a second daemon on the same resources). Wait for it; force it past
    // the drain window, as a service manager would.
    const graceMs = stopGraceMs(await readConfiguredDrainMs(process.cwd()));
    console.log(
      `Sent SIGTERM to daemon (PID ${pid}); waiting up to ${Math.round(graceMs / 1000)}s for it to finish in-flight turns...`,
    );
    if (await waitForPidExit(Number(pid), graceMs)) {
      console.log(`Stopped daemon (PID ${pid}).`);
    } else {
      console.log(
        `Daemon (PID ${pid}) still alive after ${Math.round(graceMs / 1000)}s — sending SIGKILL.`,
      );
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* gone in between */
      }
      if (!(await waitForPidExit(Number(pid), 2000))) {
        // Still there after SIGKILL (uninterruptible sleep, zombie without a
        // reaper): it may still own the socket and the agents, so its PID
        // file stays — removing it would let a replacement start on top.
        console.log(
          `Daemon (PID ${pid}) did not exit after SIGKILL — leaving ${pidFile} in place; check the process before starting another daemon.`,
        );
        await deps.teardownStatusline();
        process.exit(1);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // #420: alive, not ours — say so and leave its file alone.
      console.log(
        `Daemon (PID ${pid}) belongs to another user — cannot signal it; PID file left in place.`,
      );
      await deps.teardownStatusline();
      process.exit(1);
    }
    console.log(`Daemon process ${pid} already dead.`);
  }

  // #420: only if the file still names the daemon we stopped — a `start` that
  // raced us may already own it. "absent" is the normal graceful case: the
  // daemon removes its own file when it exits.
  const cleanup = await cleanupPidFileIf(Number(pid), pidFile);
  if (cleanup === "foreign") {
    console.log(
      `PID file no longer names ${pid} (another daemon started meanwhile) — left in place.`,
    );
  } else if (cleanup === "locked") {
    // #435: the PID lock is held (a `start` mid-way) or cannot be taken. A
    // file naming a dead PID is removed by the next start's own check.
    console.log("PID lock busy or unavailable in this directory — PID file left in place.");
  }
  await deps.teardownStatusline();

  await deps.removeHeartbeatState();

  process.exit(0);
}

export async function stopAll() {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.log("No projects found.");
    process.exit(0);
  }

  let found = 0;
  let survivors = 0;
  for (const dir of dirs) {
    const projectPath = "/" + dir.slice(1).replace(/-/g, "/");
    const pidFile = join(projectPath, ".claude", "claudeclaw", "daemon.pid");

    let pid: string;
    try {
      pid = (await readFile(pidFile, "utf-8")).trim();
    } catch {
      continue;
    }
    if (!isPidAlive(Number(pid))) continue;
    found++;
    try {
      process.kill(Number(pid), "SIGTERM");
      // #315: same as `stop` — the daemon drains before it exits; its PID
      // file goes only once it is gone. Each project's own settings.json
      // says how long its drain may take.
      const graceMs = stopGraceMs(await readConfiguredDrainMs(projectPath));
      let gone = await waitForPidExit(Number(pid), graceMs);
      if (gone) {
        console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath}`);
      } else {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
        gone = await waitForPidExit(Number(pid), 2000);
        console.log(
          gone
            ? `\x1b[33m■ Killed\x1b[0m PID ${pid} — ${projectPath} (still alive after ${Math.round(graceMs / 1000)}s)`
            : `\x1b[31m✗ Still alive after SIGKILL\x1b[0m PID ${pid} — ${projectPath} (PID file left in place)`,
        );
      }
      if (gone) {
        // #420: compare-and-unlink — the file may already belong to a
        // replacement started meanwhile.
        await cleanupPidFileIf(Number(pid), pidFile);
      } else {
        survivors++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        // alive, another user's: cannot be signalled from here
        console.log(
          `\x1b[31m✗ Cannot signal\x1b[0m PID ${pid} — ${projectPath} (another user's daemon)`,
        );
        survivors++;
      } else if (!isPidAlive(Number(pid))) {
        // it exited on its own between the probe and the signal
        console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath} (exited on its own)`);
        await cleanupPidFileIf(Number(pid), pidFile);
      } else {
        console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${pid} — ${projectPath}`);
        survivors++;
      }
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  // #420: a daemon that survived SIGKILL (or could not be signalled) still owns
  // its socket and agents — say so with the exit code, not only in the log.
  process.exit(survivors > 0 ? 1 : 0);
}
