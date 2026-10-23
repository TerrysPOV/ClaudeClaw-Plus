/**
 * The bus session manager starts claude with `--session-id <agent.session_id>`. It passes the
 * same quarantine gate as every other start on a session (#562 round 8): a transcript the PTY
 * supervisor has an unconfirmed writer on is not started beside it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyExitUnconfirmedError, type PtyProcess } from "../../runner/pty-process";
import {
  __resetQuarantineForTests,
  fenceSession,
  quarantineSession,
} from "../../runner/pty-quarantine";
import { SessionManager } from "../session-manager";

function stuckPty(sessionId: string): PtyProcess {
  return {
    label: "fake:4242",
    pid: 4242,
    sessionId,
    cwd: "/tmp",
    canDie: false,
    isAlive: () => true,
    lastTurnEndedAt: () => 0,
    exitInfo: () => null,
    runTurn: async () => {
      throw new Error("unused");
    },
    dispose: async () => {
      throw new PtyExitUnconfirmedError("fake:4242", 4242);
    },
    confirmExit: async () => {
      throw new PtyExitUnconfirmedError("fake:4242", 4242);
    },
  } as unknown as PtyProcess;
}

describe("SessionManager.spawnAgent and the quarantine gate", () => {
  let cwd: string;
  let mgr: SessionManager;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ccaw-bus-quarantine-"));
    __resetQuarantineForTests();
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    __resetQuarantineForTests();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not start claude on a session id with an unconfirmed writer", async () => {
    // Fault (site: `spawnAgentInternal`, the gate before the spawn): the stand-in is started
    // and records its argv. Predicted result: `argv.txt` exists and the call resolves.
    const marker = join(cwd, "argv.txt");
    const recorder = join(cwd, "recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\necho started > "${marker}"\ncat >/dev/null\n`, {
      mode: 0o755,
    });
    chmodSync(recorder, 0o755);
    quarantineSession("global", stuckPty("sess-a"), "retire-exit-unconfirmed");
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });

    await expect(
      mgr.spawnAgent(
        {
          id: "a",
          cwd,
          session_id: "sess-a",
          permission_mode: "bypassPermissions",
          supervision: "pty-stdin",
        },
        "cli",
      ),
    ).rejects.toThrow("quarantined");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it("does not start claude on a session whose retirement began after the async gate passed", async () => {
    // Fault (site: `spawnPty`, the synchronous check after the `bun-pty` import): the gate
    // sees no quarantine record (the retirement is only fenced, not yet unconfirmed), so the
    // stand-in is started. Predicted result: `started.txt` exists and the call resolves.
    const marker = join(cwd, "started.txt");
    const recorder = join(cwd, "recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\necho started > "${marker}"\ncat >/dev/null\n`, {
      mode: 0o755,
    });
    chmodSync(recorder, 0o755);
    fenceSession("global", stuckPty("sess-a"));
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });

    await expect(
      mgr.spawnAgent(
        {
          id: "a",
          cwd,
          session_id: "sess-a",
          permission_mode: "bypassPermissions",
          supervision: "pty-stdin",
        },
        "cli",
      ),
    ).rejects.toThrow("quarantined");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });
});
