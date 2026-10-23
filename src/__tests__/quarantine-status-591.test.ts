/**
 * #591: a quarantined PTY session is visible to the operator, and `/kill` does not claim
 * success before the exits are confirmed.
 *
 * - `/status` (Telegram, Discord, Slack) lists the quarantined sessions: a count, then each
 *   one's key, reason and time since. No pid, no claude session id, no path in chat text.
 * - `/kill` (Telegram) answers "pending" first and reports, once the retirement is over, how
 *   many exits were confirmed and how many were not.
 *
 * Fake PTYs only, in-memory session store, explicit cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { slackStatusText } from "../commands/slack";
import { discordStatusText } from "../commands/discord";
import { formatKillOutcome, replyToKill, telegramStatusText } from "../commands/telegram";
import { initConfig, loadSettings, reloadSettings } from "../config";
import { _trackMainProcForTests, killActiveReport } from "../runner";
import {
  PtyExitUnconfirmedError,
  type PtyProcess,
  type PtyTurnResult,
} from "../runner/pty-process";
import { __resetQuarantineForTests, type QuarantineInfo } from "../runner/pty-quarantine";
import { formatQuarantineStatus } from "../runner/quarantine-status";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectSleep,
  injectSpawnPty,
  runOnPty,
  shutdownSupervisor,
  snapshotSupervisor,
} from "../runner/pty-supervisor";

const NOW = Date.parse("2026-10-23T18:00:00Z");

const stuck: QuarantineInfo = {
  sessionKey: "thread:42",
  sessionId: "0f1e2d3c-secret-session-id",
  pid: 987654,
  reason: "retire-exit-unconfirmed",
  since: NOW - (3 * 60 + 12) * 1000,
};

function expectNoPrivateDetail(text: string): void {
  expect(text).not.toContain(String(stuck.pid));
  expect(text).not.toContain(stuck.sessionId);
  expect(text).not.toContain("/tmp/");
}

describe("formatQuarantineStatus (#591)", () => {
  it("counts the quarantined sessions and lists key, reason and time since", () => {
    const text = formatQuarantineStatus([stuck], NOW).join("\n");
    expect(text).toContain("Quarantined sessions: 1");
    expect(text).toContain("thread:42");
    expect(text).toContain("retire-exit-unconfirmed");
    expect(text).toContain("3m 12s ago");
    expectNoPrivateDetail(text);
  });

  it("counts sessions, not processes: two records on one key are one session", () => {
    const older = { ...stuck, reason: "pending-spawn-unsettled", since: NOW - 3_600_000 };
    const text = formatQuarantineStatus([stuck, older], NOW).join("\n");
    expect(text).toContain("Quarantined sessions: 1");
    expect(text).toContain("2 processes");
    expect(text).toContain("1h 0m ago");
  });

  it("lists at most five sessions, then how many more", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...stuck, sessionKey: `thread:${i}` }));
    const lines = formatQuarantineStatus(many, NOW);
    expect(lines[0]).toBe("Quarantined sessions: 8");
    expect(lines.filter((l) => l.includes("•"))).toHaveLength(5);
    expect(lines.at(-1)).toBe("  ... and 3 more");
  });

  it("says none when nothing is quarantined", () => {
    expect(formatQuarantineStatus([], NOW)).toEqual(["Quarantined sessions: 0"]);
  });
});

describe("formatKillOutcome (#591)", () => {
  it("names quarantine only for PTY processes, and the legacy child apart", () => {
    const legacyOnly = formatKillOutcome({ confirmed: 0, unconfirmed: 1, quarantined: 0 });
    expect(legacyOnly).toContain("1 not confirmed");
    expect(legacyOnly).toContain("claude -p");
    expect(legacyOnly).not.toContain("quarantined");
    const pty = formatKillOutcome({ confirmed: 2, unconfirmed: 1, quarantined: 1 });
    expect(pty).toContain("2 exits confirmed");
    expect(pty).toContain("quarantined");
    expect(pty).not.toContain("claude -p");
  });

  it("a session that had not started yet is not reported as zero confirmed exits", () => {
    expect(formatKillOutcome({ confirmed: 0, unconfirmed: 0, quarantined: 0 })).toBe(
      "Killed active agent (nothing was running yet).",
    );
  });

  it("a failed report is not presented as a clean kill", () => {
    const text = formatKillOutcome({ confirmed: 0, unconfirmed: 0, quarantined: 0, failed: true });
    expect(text).not.toContain("Killed active agent");
    expect(text).toContain("could not be checked");
  });

  it("several legacy children are counted in the plural", () => {
    expect(formatKillOutcome({ confirmed: 0, unconfirmed: 2, quarantined: 0 })).toContain(
      "2 `claude -p` processes were",
    );
  });
});

describe("/status lists quarantined sessions on every surface (#591)", () => {
  const settings = { model: "opus", security: { level: "moderate" } };
  const session = {
    sessionId: "abcdef0123456789",
    turnCount: 3,
    createdAt: "2026-10-23T10:00:00Z",
    lastUsedAt: "2026-10-23T17:00:00Z",
  };

  it("Telegram, with an active session", () => {
    const text = telegramStatusText(session, settings, [stuck], NOW);
    expect(text).toContain("Session Status");
    expect(text).toContain("Quarantined sessions: 1");
    expect(text).toContain("thread:42");
    expectNoPrivateDetail(text);
  });

  it("Telegram, with no active session: the quarantine is still shown", () => {
    const text = telegramStatusText(null, settings, [stuck], NOW);
    expect(text).toContain("No active session");
    expect(text).toContain("Quarantined sessions: 1");
    expect(text).toContain("retire-exit-unconfirmed");
  });

  it("Discord, with and without an active session", () => {
    const withSession = discordStatusText(session, [], settings, [stuck], NOW);
    expect(withSession).toContain("Session Status");
    expect(withSession).toContain("Quarantined sessions: 1");
    expectNoPrivateDetail(withSession);
    const without = discordStatusText(null, [], settings, [stuck], NOW);
    expect(without).toContain("No active session");
    expect(without).toContain("thread:42");
  });

  it("Slack", () => {
    const text = slackStatusText(null, [], "restricted", [stuck], NOW);
    expect(text).toContain("Quarantined sessions: 1");
    expect(text).toContain("thread:42");
    expectNoPrivateDetail(text);
  });
});

// --- /kill: pending first, result after the exits are confirmed (or not) ---

interface ControlledPty extends PtyProcess {
  /** Resolves (exit confirmed) or rejects (unconfirmed) the pending dispose. */
  finish(confirmed: boolean): void;
  disposeStarted: boolean;
}

function makeControlled(pid: number): ControlledPty {
  let alive = true;
  let canDie = false;
  let settle: ((confirmed: boolean) => void) | undefined;
  const fake = {
    label: `fake:${pid}`,
    pid,
    sessionId: `sess-${pid}`,
    cwd: "/tmp/fake-cwd",
    disposeStarted: false,
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string): Promise<PtyTurnResult> {
      return {
        text: `echo:${prompt}`,
        bytesCaptured: 1,
        cleanBoundary: true,
        sessionId: fake.sessionId,
      };
    },
    dispose(): Promise<void> {
      fake.disposeStarted = true;
      return new Promise<void>((resolve, reject) => {
        settle = (confirmed) => {
          alive = false;
          canDie = confirmed;
          if (confirmed) resolve();
          else reject(new PtyExitUnconfirmedError(fake.label, pid));
        };
      });
    },
    async confirmExit(): Promise<void> {
      if (!canDie) throw new PtyExitUnconfirmedError(fake.label, pid);
    },
    finish(confirmed: boolean): void {
      settle?.(confirmed);
    },
  };
  return fake as unknown as ControlledPty;
}

const memStore = () => {
  let id: string | undefined;
  return {
    load: async () => id,
    save: async (s: string) => {
      id = s;
    },
  };
};

const scope = () => ({
  sessionStore: memStore(),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("/kill answers pending, then the confirmed / unconfirmed counts (#591)", () => {
  let queue: PtyProcess[];

  beforeEach(async () => {
    __resetSupervisorForTests();
    __resetQuarantineForTests();
    await initConfig();
    await loadSettings();
    await reloadSettings();
    injectIsSessionResumable(async () => true);
    injectSleep(async () => {});
    injectMaxRetriesForTests(0);
    queue = [];
    injectSpawnPty(async () => queue.shift()!);
  });

  afterEach(async () => {
    __resetQuarantineForTests();
    await shutdownSupervisor();
    __resetSupervisorForTests();
  });

  it("no success is announced while an exit is still being confirmed", async () => {
    const a = makeControlled(1111);
    const b = makeControlled(2222);
    queue.push(a, b);
    await runOnPty("thread:a", "seed", { timeoutMs: 5000, ...scope() });
    await runOnPty("thread:b", "seed", { timeoutMs: 5000, ...scope() });

    const sent: string[] = [];
    const done = replyToKill(async (t) => {
      sent.push(t);
    });
    await tick();

    // Both disposals are in flight: only the pending notice has gone out.
    expect(a.disposeStarted && b.disposeStarted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("pending");
    expect(sent.join("\n")).not.toContain("Killed");

    a.finish(true);
    await tick();
    expect(sent).toHaveLength(1);

    b.finish(false);
    await done;

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("1 exit confirmed");
    expect(sent[1]).toContain("1 not confirmed");
    expect(sent[1]).toContain("/status");
    expect(sent[1]).not.toContain("2222");
    expect(snapshotSupervisor().quarantined.map((q) => q.sessionKey)).toEqual(["thread:b"]);
  });

  it("all exits confirmed: the final reply says so, with nothing unconfirmed", async () => {
    const a = makeControlled(3333);
    queue.push(a);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });

    const sent: string[] = [];
    const done = replyToKill(async (t) => {
      sent.push(t);
    });
    await tick();
    expect(sent).toEqual([expect.stringContaining("pending")]);
    a.finish(true);
    await done;

    expect(sent[1]).toContain("Killed active agent");
    expect(sent[1]).toContain("1 exit confirmed");
    expect(sent[1]).not.toContain("not confirmed");
  });

  it("a session already quarantined counts as unconfirmed when it is still alive", async () => {
    const a = makeControlled(4444);
    queue.push(a);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    const first = killActiveReport();
    await tick();
    a.finish(false);
    expect(await first.settled).toEqual({ confirmed: 0, unconfirmed: 1, quarantined: 1 });

    // Nothing live is left, only the quarantined process: /kill still reaches it.
    const second = killActiveReport();
    expect(second.killed).toBe(true);
    expect(await second.settled).toEqual({ confirmed: 0, unconfirmed: 1, quarantined: 1 });
  });

  it("the outcome is still sent when the pending notice fails", async () => {
    const a = makeControlled(5555);
    queue.push(a);
    await runOnPty("global", "seed", { timeoutMs: 5000, ...scope() });
    const sent: string[] = [];
    let calls = 0;
    const done = replyToKill(async (t) => {
      if (calls++ === 0) throw new Error("telegram 502");
      sent.push(t);
    });
    await tick();
    a.finish(true);
    await done;
    expect(sent).toEqual(["Killed active agent: 1 exit confirmed."]);
  });

  it("legacy claude -p children: one that exits is confirmed, one that does not is not quarantined", async () => {
    const legacy = (exits: boolean) => {
      let exit: () => void = () => {};
      const exited = new Promise<number>((r) => {
        exit = () => r(143);
      });
      return { kill: () => (exits ? exit() : undefined), exited } as unknown as ReturnType<
        typeof Bun.spawn
      >;
    };
    try {
      _trackMainProcForTests(legacy(true), 50);
      _trackMainProcForTests(legacy(false), 50);
      const r = killActiveReport();
      expect(r.killed).toBe(true);
      const outcome = await r.settled;
      expect(outcome).toEqual({ confirmed: 1, unconfirmed: 1, quarantined: 0 });
      expect(formatKillOutcome(outcome)).toContain("claude -p");
    } finally {
      _trackMainProcForTests(null); // empty the tracked set, default wait back
    }
  });

  it("nothing running: the old answer, no pending notice", async () => {
    const sent: string[] = [];
    await replyToKill(async (t) => {
      sent.push(t);
    });
    expect(sent).toEqual(["No active agent running."]);
  });
});
