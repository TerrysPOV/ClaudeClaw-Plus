import { backupSession } from "../sessions";
import { checkExistingDaemon, DaemonStateUnknownError } from "../pid";
import { stop } from "./stop";

export async function clear() {
  // If daemon is running, stop it so the next start gets a fresh session.
  // Checked before the backup, so a refusal leaves the session untouched.
  let pid: number | null;
  try {
    pid = await checkExistingDaemon();
  } catch (err) {
    if (!(err instanceof DaemonStateUnknownError)) throw err;
    // #435: unknown is not "none" — a daemon left running keeps the old session.
    console.error(
      `\x1b[31mAborted: cannot tell whether a daemon is running: ${err.message}.\x1b[0m`,
    );
    process.exit(1);
  }

  const backup = await backupSession();

  if (backup) {
    console.log(`Session backed up → ${backup}`);
  } else {
    console.log("No active session to back up.");
  }

  if (pid) {
    console.log("Stopping daemon so next start creates a fresh session...");
    await stop();
  } else {
    console.log("No daemon running. Next start will create a new session.");
    process.exit(0);
  }
}
