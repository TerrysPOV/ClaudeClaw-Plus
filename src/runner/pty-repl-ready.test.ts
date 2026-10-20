import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyNotReadyError, type PtyProcess, spawnPty } from "./pty-process.js";

/**
 * #570 r12 (E): an untrusted prompt is written only into a REPL that is ready. A shell stands
 * in for claude: it prints a screen, then `cat`s everything written to the PTY into a file, so
 * "nothing was pasted" is an empty file rather than an inference. The spawn itself succeeds
 * (the integration harness inspects the live child right after it), and the first turn refuses.
 */

const FOOTER = "⏵⏵ auto mode on (shift+tab to cycle)";
let dir: string;
let sink: string;
const spawned: PtyProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-ready-"));
  sink = join(dir, "received.txt");
});
afterEach(async () => {
  for (const child of spawned.splice(0)) await child.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function spawnScreen(
  lines: string[],
  budgetMs = 1500,
  quietWindowMs = 50,
): Promise<PtyProcess> {
  const printed = lines.map((l) => `'${l}'`).join(" ");
  const child = await spawnPty({
    sessionId: "",
    cwd: dir,
    isolation: "untrusted",
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", `printf '%s\\n' ${printed}; exec cat > '${sink}'`],
    quietWindowMs,
    _replReadyBudgetMs: budgetMs,
  });
  spawned.push(child);
  return child;
}

async function settled(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const received = (): string => (existsSync(sink) ? readFileSync(sink, "utf8") : "");

/** The turn a one-shot makes; the prompt is the canary that must never reach the PTY. */
const turn = (child: PtyProcess, timeoutMs = 2000) =>
  child.runTurn("PROMPT_MUST_NOT_REACH_THE_PTY", { timeoutMs });

describe("an untrusted first turn waits for a ready REPL", () => {
  it("refuses a login menu, with the reason, and writes nothing", async () => {
    // Went red (the turn was not refused) with the blocked-screen check removed, and with the
    // gate switched off for untrusted spawns.
    const child = await spawnScreen(["Select login method:", "1. Claude account", FOOTER]);
    await expect(turn(child)).rejects.toThrow(/not ready \(login-required\); nothing was sent/);
    await settled();
    expect(received()).toBe("");
  });

  // The REPL paints its footer in the logged-out state too; each wording is checked alone.
  // Went red per wording: the bare 'Not logged in' and the bare 'Run /login' each failed when
  // their own alternative was removed; only the combined string hid that.
  for (const status of ["Not logged in · Run /login", "Not logged in", "Please Run /login"]) {
    it(`refuses the logged-out status '${status}', though the footer is painted`, async () => {
      const child = await spawnScreen([status, FOOTER]);
      await expect(turn(child)).rejects.toThrow(/login-required/);
      await settled();
      expect(received()).toBe("");
    });
  }

  it("refuses an onboarding screen", async () => {
    // Went red with the onboarding pattern removed.
    const child = await spawnScreen(["Choose the text style that looks best", FOOTER]);
    await expect(turn(child)).rejects.toThrow(/onboarding/);
    expect(received()).toBe("");
  });

  it("refuses a trust dialog", async () => {
    // Went red with the trust-dialog pattern removed.
    const child = await spawnScreen(["Do you trust the files in this folder?", FOOTER]);
    await expect(turn(child)).rejects.toThrow(/trust-dialog/);
    expect(received()).toBe("");
  });

  it("refuses when no footer arrives within the budget", async () => {
    // Went red (the turn was not refused) with the footer requirement dropped, and hung with
    // the deadline removed.
    const child = await spawnScreen(["Loading..."], 400);
    await expect(turn(child)).rejects.toThrow(/no-repl-footer/);
    await settled();
    expect(received()).toBe("");
  });

  it("is bound by the turn's own timeout when that is shorter than the footer budget", async () => {
    const child = await spawnScreen(["Loading..."], 60_000);
    const started = Date.now();
    await expect(turn(child, 300)).rejects.toThrow(/no-repl-footer/);
    // Went red (the test timed out at 8 s) with the wait not bounded by the turn's timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("keeps refusing: a second turn is not written either, and does not wait again", async () => {
    const child = await spawnScreen(["Select login method:", FOOTER]);
    await expect(turn(child)).rejects.toBeInstanceOf(PtyNotReadyError);
    const started = Date.now();
    // Went red (the second turn resolved and its prompt was written) with the refusal not remembered.
    await expect(turn(child)).rejects.toBeInstanceOf(PtyNotReadyError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(received()).toBe("");
  });

  it("accepts the default mode's footer too", async () => {
    const child = await spawnScreen(["Claude Code v2.1.304", "? for shortcuts"]);
    await child.runTurn("PROMPT_REACHED_THE_PTY", { timeoutMs: 600 }).catch(() => {});
    // Went red (nothing written) with the "for shortcuts" alternative removed.
    expect(received()).toContain("PROMPT_REACHED_THE_PTY");
  });

  it("twin: a screen with the footer and no blocking text is ready, and a prompt does reach the PTY", async () => {
    const child = await spawnScreen(["Claude Code v2.1.304", FOOTER]);
    await child.runTurn("PROMPT_REACHED_THE_PTY", { timeoutMs: 600 }).catch(() => {});
    // The sink records writes, so the empty files above mean something.
    expect(received()).toContain("PROMPT_REACHED_THE_PTY");
  });
});

/** Bytes the child "wrote": the same path real output takes, fed after the spawn has settled. */
const paint = (child: PtyProcess, data: string): void =>
  (child as unknown as { _handleData(data: string): void })._handleData(data);

// #570 r13 (E): readiness is judged on the screen as it is now.
describe("the ready gate reads the current screen", () => {
  it("is ready when a login screen was cleared and replaced by the REPL", async () => {
    const child = await spawnScreen(["Starting"]);
    // The menu sits below the rows the REPL is drawn on, so a clear that did not happen would
    // leave it on the screen.
    paint(
      child,
      "Welcome to Claude Code\r\n\r\nSelect login method:\r\n1. Claude account\r\n2. Anthropic Console\r\n",
    );
    paint(child, `\x1b[2J\x1b[HClaude Code v2.1.304\r\n${FOOTER}`);
    await child.runTurn("PROMPT_REACHED_THE_PTY", { timeoutMs: 600 }).catch(() => {});
    expect(received()).toContain("PROMPT_REACHED_THE_PTY");
  });

  it("refuses a footer that is drawn first and 'Not logged in' drawn after it", async () => {
    const child = await spawnScreen(["Starting"], 1500, 150);
    paint(child, FOOTER);
    const turned = turn(child);
    setTimeout(() => paint(child, "\r\nNot logged in"), 40); // inside the quiet window
    await expect(turned).rejects.toThrow(/not ready \(login-required\); nothing was sent/);
    await settled();
    expect(received()).toBe("");
  });

  it("refuses a blocked screen after one quiet window, not after the whole budget", async () => {
    const child = await spawnScreen(["Starting"], 20_000, 100);
    paint(child, "Select login method:\r\n");
    const started = Date.now();
    await expect(turn(child, 20_000)).rejects.toThrow(/login-required/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is ready when the REPL only moves its cursor or repaints identical text", async () => {
    const child = await spawnScreen(["Starting"], 2500, 400);
    paint(child, `\x1b[2J\x1b[H${FOOTER}`);
    const started = Date.now();
    // Every 100 ms, inside the 400 ms quiet window: a cursor move, then the same text again.
    const timer = setInterval(() => {
      paint(child, "\x1b[2;5H");
      paint(child, `\x1b[1;1H${FOOTER}`);
    }, 100);
    try {
      await child.runTurn("PROMPT_REACHED_THE_PTY", { timeoutMs: 600 }).catch(() => {});
    } finally {
      clearInterval(timer);
    }
    // Went red (nothing written) with the quiet window restarted on every chunk.
    expect(received()).toContain("PROMPT_REACHED_THE_PTY");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses a footer that is still there but a screen that never went quiet", async () => {
    const child = await spawnScreen(["Starting"], 600, 400);
    paint(child, FOOTER);
    const turned = turn(child, 600);
    // Repaints every 100 ms: the 400 ms quiet window never completes.
    const timer = setInterval(() => paint(child, "."), 100);
    try {
      await expect(turned).rejects.toThrow(/screen-not-settled/);
    } finally {
      clearInterval(timer);
    }
    expect(received()).toBe("");
  });
});

// #570 r15 (A2): a pending ready gate ends when the child is retired or exits, instead of
// running to its own deadline. The gate's 12 s deadline is held on a fake clock and never
// fires, so a turn that settles here was ended by dispose or exit, not by the deadline.
describe("a pending ready gate ends with the child (r15, A2)", () => {
  const GATE_MS = 12_000;

  function gateClock() {
    const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
    return {
      pending,
      options: {
        _setTimeout: (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
          if (ms !== GATE_MS) return setTimeout(cb, ms);
          const handle = {} as ReturnType<typeof setTimeout>;
          pending.set(handle, cb);
          return handle;
        },
        _clearTimeout: (handle: ReturnType<typeof setTimeout>): void => {
          if (!pending.delete(handle)) clearTimeout(handle);
        },
      },
    };
  }

  /** A shell that paints a screen with no footer, then runs `after` (default: waits for input). */
  async function spawnWithClock(
    clock: ReturnType<typeof gateClock>,
    after = `exec cat > '${sink}'`,
  ): Promise<PtyProcess> {
    const child = await spawnPty({
      sessionId: "",
      cwd: dir,
      isolation: "untrusted",
      env: { PATH: "/usr/bin:/bin" },
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      _commandOverride: "/bin/sh",
      _argsOverride: ["-c", `printf 'Loading...\\n'; ${after}`],
      quietWindowMs: 50,
      _replReadyBudgetMs: GATE_MS,
      ...clock.options,
    });
    spawned.push(child);
    return child;
  }

  /** What the turn did within `ms` of real time: its error, or "waiting" if it was still pending. */
  async function outcome(turned: Promise<unknown>, ms = 3000): Promise<unknown> {
    const settledTurn = turned.then(
      () => "resolved",
      (error: unknown) => error,
    );
    const giveUp = new Promise((resolve) => setTimeout(() => resolve("waiting"), ms));
    return Promise.race([settledTurn, giveUp]);
  }

  it("dispose during the gate rejects the turn at once, not at the gate deadline", async () => {
    const clock = gateClock();
    const child = await spawnWithClock(clock);
    const turned = turn(child, GATE_MS);
    await settled(100);
    expect(clock.pending.size).toBe(1); // the gate is waiting on its deadline
    await child.dispose();
    const result = await outcome(turned);
    expect(result).toBeInstanceOf(PtyNotReadyError);
    expect((result as Error).message).toMatch(/\(closed\)/);
    expect(clock.pending.size).toBe(0); // the deadline timer was cleared, not left to fire
    expect(received()).toBe("");
  });

  it("a child that exits during the gate rejects the turn at once", async () => {
    const clock = gateClock();
    const child = await spawnWithClock(clock, "sleep 0.3; exit 3");
    const result = await outcome(turn(child, GATE_MS));
    expect(result).toBeInstanceOf(PtyNotReadyError);
    expect((result as Error).message).toMatch(/\(exited\)/);
    expect(clock.pending.size).toBe(0);
  });

  it("a turn started on a child that already exited does not start a gate", async () => {
    const clock = gateClock();
    // spawnPty rejects a child that dies before the screen settles, so it exits just after.
    const child = await spawnWithClock(clock, "sleep 0.3; exit 3");
    // Wait for the exit to be seen: runTurn must find the child gone, not catch it dying.
    for (let waited = 0; child.isAlive() && waited < 3000; waited += 50) await settled(50);
    expect(child.isAlive()).toBe(false);
    const result = await outcome(turn(child, GATE_MS));
    expect(result).toBeInstanceOf(PtyNotReadyError);
    expect((result as Error).message).toMatch(/\(exited\)/);
    expect(clock.pending.size).toBe(0);
    expect(received()).toBe("");
  });

  it("a turn started on a child that is already retired does not start a gate", async () => {
    const clock = gateClock();
    const child = await spawnWithClock(clock);
    await child.dispose();
    const result = await outcome(turn(child, GATE_MS));
    expect(result).toBeInstanceOf(PtyNotReadyError);
    expect((result as Error).message).toMatch(/\(closed\)/);
    expect(clock.pending.size).toBe(0);
  });
});
