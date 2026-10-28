/**
 * The bus session manager starts claude with `--session-id <agent.session_id>`. It passes the
 * same quarantine gate as every other start on a session (#562 round 8): a transcript the PTY
 * supervisor has an unconfirmed writer on is not started beside it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyExitUnconfirmedError, type PtyProcess } from "../../runner/pty-process";
import {
  __resetQuarantineForTests,
  fenceSession,
  quarantineSession,
} from "../../runner/pty-quarantine";
import { SessionManager } from "../session-manager";

/** Poll for a stand-in's marker: a positive control must not depend on one fixed sleep. */
async function waitForFile(path: string, budgetMs = 5000): Promise<void> {
  const end = Date.now() + budgetMs;
  while (!existsSync(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

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

  it("the retirement fence stays on the dying process's session when the agent takes a fresh id", async () => {
    // `restartInternal` sets `agent.session_id = fresh` on the one shared `AgentConfig` after
    // `stop()` resolves, even when the retirement just quarantined the old process. Fault (site:
    // `fenceForRetirement`, `sessionId` read live from `record.agent` instead of captured when the
    // fence is made): the fence and any quarantine follow the fresh, never-used id and leave the
    // old transcript's live writer uncovered. Predicted result: the handle reads "sess-fresh".
    const recorder = join(cwd, "alive.sh");
    writeFileSync(recorder, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
    chmodSync(recorder, 0o755);
    mgr = new SessionManager({ commandOverride: recorder, sessionCollisionDetectMs: 0 });
    await mgr.spawnAgent(
      {
        id: "a",
        cwd,
        session_id: "sess-a",
        permission_mode: "bypassPermissions",
        supervision: "pty-stdin",
      },
      "cli",
    );
    const priv = mgr as unknown as {
      agents: Map<string, { agent: { session_id: string } }>;
      retirementHandles: Map<object, { sessionId: string }>;
      fenceForRetirement: (record: object) => void;
    };
    const record = priv.agents.get("a");
    expect(record).toBeDefined();
    if (!record) return;
    priv.fenceForRetirement(record);
    record.agent.session_id = "sess-fresh";

    expect(priv.retirementHandles.get(record)?.sessionId).toBe("sess-a");
  });

  /** A stand-in that records that it was started, then exits. */
  function stand(name: string): { script: string; marker: string } {
    const marker = join(cwd, `${name}.txt`);
    const script = join(cwd, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\necho started > "${marker}"\n`, { mode: 0o755 });
    chmodSync(script, 0o755);
    return { script, marker };
  }

  const agentOn = (supervision: "process-stream-json" | "tmux") => ({
    id: "a",
    cwd,
    session_id: "sess-a",
    permission_mode: "bypassPermissions" as const,
    supervision,
  });

  it("does not start the child process on a session whose retirement began after the async gate passed", async () => {
    // Fault (site: `spawnChild`, the synchronous check before `nodeSpawnChildProcess`): the gate
    // sees no record, so the stand-in is started. Predicted result: `child.txt` exists and the
    // call resolves.
    const { script, marker } = stand("child");
    fenceSession("global", stuckPty("sess-a"));
    mgr = new SessionManager({ commandOverride: script, sessionCollisionDetectMs: 0 });

    await expect(mgr.spawnAgent(agentOn("process-stream-json"), "cli")).rejects.toThrow(
      "quarantined",
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it("positive control: the same child is started when nothing is fenced", async () => {
    // Without this, the absent marker above could mean the stand-in never runs here at all.
    const { script, marker } = stand("child-control");
    mgr = new SessionManager({ commandOverride: script, sessionCollisionDetectMs: 0 });

    await mgr.spawnAgent(agentOn("process-stream-json"), "cli").catch(() => undefined);

    await waitForFile(marker);
    expect(existsSync(marker)).toBe(true);
  });

  describe("tmux", () => {
    let savedPath: string | undefined;
    let tmuxMarker: string;

    beforeEach(() => {
      // tmux itself is replaced by a stand-in first on PATH, so a spawn is observable and
      // no real tmux session is ever created.
      savedPath = process.env.PATH;
      tmuxMarker = join(cwd, "tmux.txt");
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho started > "${tmuxMarker}"\n`, {
        mode: 0o755,
      });
      chmodSync(join(bin, "tmux"), 0o755);
      process.env.PATH = `${bin}:${savedPath ?? ""}`;
    });
    afterEach(() => {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    });

    it("does not start tmux on a session whose retirement began after the async gate passed", async () => {
      // Fault (site: `spawnTmux`, the synchronous check before `nodeSpawnChildProcess`): the gate
      // sees no record, so tmux is started. Predicted result: `tmux.txt` exists and the call
      // does not reject with "quarantined".
      fenceSession("global", stuckPty("sess-a"));
      mgr = new SessionManager({ commandOverride: "/bin/true", sessionCollisionDetectMs: 0 });

      await expect(mgr.spawnAgent(agentOn("tmux"), "cli")).rejects.toThrow("quarantined");

      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(tmuxMarker)).toBe(false);
    });

    it("positive control: tmux is started when nothing is fenced", async () => {
      mgr = new SessionManager({ commandOverride: "/bin/true", sessionCollisionDetectMs: 0 });

      await mgr.spawnAgent(agentOn("tmux"), "cli").catch(() => undefined);

      await waitForFile(tmuxMarker);
      expect(existsSync(tmuxMarker)).toBe(true);
    });
  });
});
