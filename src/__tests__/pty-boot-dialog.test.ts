/**
 * Tests for the boot-dialog watcher (issue #193).
 *
 * PtyAgentProcess answers claude's interactive startup confirmation dialogs by
 * inspecting early PTY output and sending the correct key per dialog: Enter for
 * the dev-channels confirmation, and Down+Enter for the new "Bypass Permissions
 * mode" dialog (whose default is "No, exit" — a blind Enter would kill the
 * agent).
 */
import { describe, test, expect } from "bun:test";
import { PtyAgentProcess, type PtyHandle } from "../bus/session-agent-process";

function makeFakePty() {
  const writes: string[] = [];
  let dataCb: ((d: string) => void) | null = null;
  const pty: PtyHandle = {
    pid: 4242,
    onData(cb) {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit() {
      return { dispose() {} };
    },
    write(d) {
      writes.push(d);
    },
    kill() {},
  };
  return { pty, writes, emit: (s: string) => dataCb?.(s) };
}

describe("PtyAgentProcess boot-dialog watcher (issue #193)", () => {
  test("answers the Bypass Permissions dialog with Down then Enter", async () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit(
      "WARNING: Claude Code running in Bypass Permissions mode\n" +
        "❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to exit",
    );
    expect(writes).toContain("\x1b[B"); // down arrow → select "Yes, I accept"
    await new Promise((r) => setTimeout(r, 260));
    expect(writes).toContain("\r"); // then submit
  });

  test("answers the dev-channels dialog with a bare Enter (its default is accept)", () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    // The real dialog carries the "Enter to confirm" affordance below the
    // selected ("❯") option — the generic-confirm branch keys on it.
    emit(
      "WARNING: Loading development channels\n" +
        "❯ 1. I am using this for local development\n  2. Exit\n" +
        "Enter to confirm · Esc to cancel",
    );
    expect(writes).toEqual(["\r"]);
  });

  test("answers a CHA-rendered dev-channels dialog (claude 2.1.220 absolute-column layout; regression for the #345 drift class)", () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    // claude 2.1.220 positions words by absolute column (CHA, `\x1B[<col>G`).
    // Before stripAnsiEscapes expanded CHA to spaces, "Enter\x1B[..Gto\x1B[..Gconfirm"
    // collapsed to "Entertoconfirm" and the includes("Enter to confirm") gate
    // never fired — the dialog went unanswered and the agent hung at boot.
    emit(
      "WARNING: Loading development channels\n" +
        "❯ 1. I am using this for local development\n  2. Exit\n" +
        "Enter\x1b[39Gto\x1b[42Gconfirm\x1b[49G· Esc to cancel",
    );
    expect(writes).toEqual(["\r"]);
  });

  test("does not trigger on the REPL footer that also says 'bypass permissions on'", () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents");
    expect(writes).toEqual([]);
  });

  test("answers the bypass dialog only once even if it redraws", async () => {
    const { pty, writes, emit } = makeFakePty();
    new PtyAgentProcess("main", pty);
    emit("...2. Yes, I accept...");
    emit("...2. Yes, I accept... (redraw)");
    await new Promise((r) => setTimeout(r, 260));
    expect(writes.filter((w) => w === "\x1b[B").length).toBe(1);
  });
});

describe("PtyAgentProcess boot window expiry is loud (issue #393)", () => {
  function makeExitablePty() {
    const writes: string[] = [];
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number }) => void) | null = null;
    const pty: PtyHandle = {
      pid: 4343,
      onData(cb) {
        dataCb = cb;
        return { dispose() {} };
      },
      onExit(cb) {
        exitCb = cb;
        return { dispose() {} };
      },
      write(d) {
        writes.push(d);
      },
      kill() {},
    };
    return {
      pty,
      writes,
      emit: (s: string) => dataCb?.(s),
      exit: (code: number) => exitCb?.({ exitCode: code }),
    };
  }

  function captureConsoleError(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => (console.error = orig) };
  }

  test("a startup screen the watcher does not recognise is logged with the agent id and the screen text, and no key is sent", async () => {
    const { pty, writes, emit } = makeExitablePty();
    const err = captureConsoleError();
    try {
      new PtyAgentProcess("default", pty, { bootDialogMaxMs: 40 });
      // #390: claude's first-run login prompt. It has a "❯" row but no
      // "Enter to confirm" affordance, so the confirm-dialog branch never
      // matches; before #393 the window then closed silently.
      emit(
        "\x1b[2J\x1b[H Select login method:\n\n" +
          "\x1b[36m❯\x1b[0m 1. Claude account with subscription\n" +
          "  2. Anthropic Console account\n\n Enter to select · Esc to exit\n",
      );
      await new Promise((r) => setTimeout(r, 90));
      const line = err.lines.find((l) => l.includes("[boot-dialog] agent=default"));
      expect(line).toBeDefined();
      expect(line).toContain("no REPL footer within 40ms");
      expect(line).toContain("Select login method");
      expect(line).toContain("Claude account with subscription");
      // ANSI stripped, not echoed raw into the log.
      expect(line).not.toContain("\x1b[");
      expect(writes).toEqual([]);
    } finally {
      err.restore();
    }
  });

  test("a boot that reaches the REPL inside the window logs nothing", async () => {
    const { pty, emit } = makeExitablePty();
    const err = captureConsoleError();
    try {
      new PtyAgentProcess("default", pty, { bootDialogMaxMs: 40 });
      emit("\n⏵ accept edits on (shift+tab to cycle)\n");
      await new Promise((r) => setTimeout(r, 90));
      expect(err.lines.filter((l) => l.includes("[boot-dialog]"))).toEqual([]);
    } finally {
      err.restore();
    }
  });

  test("a process that exits inside the window is not reported as stuck (the exit line speaks for it)", async () => {
    const { pty, emit, exit } = makeExitablePty();
    const err = captureConsoleError();
    try {
      new PtyAgentProcess("default", pty, { bootDialogMaxMs: 40 });
      emit("Error: something went wrong at startup\n");
      exit(1);
      await new Promise((r) => setTimeout(r, 90));
      expect(err.lines.filter((l) => l.includes("[boot-dialog]"))).toEqual([]);
    } finally {
      err.restore();
    }
  });

  test("onExit replays an exit that already happened (bun-pty can deliver data and exit before the caller subscribes)", () => {
    const { pty, exit } = makeExitablePty();
    const proc = new PtyAgentProcess("default", pty, { bootDialogMaxMs: 10_000 });
    exit(4);
    const seen: number[] = [];
    proc.onExit((code) => seen.push(code));
    expect(seen).toEqual([4]);
    expect(proc._isExited()).toBe(true);
  });

  test("the quoted tail cannot carry control characters that would forge a top-level log line", () => {
    const { pty, emit } = makeExitablePty();
    const proc = new PtyAgentProcess("default", pty, { bootDialogMaxMs: 10_000 });
    emit("real line\n\x08\x08\x08\x08\x07[bus-session] forged\x9b31m\n");
    const lines = proc.recentOutputTail().split("\n");
    expect(lines).toEqual(["    real line", "    [bus-session] forged31m"]);
  });

  test("recentOutputTail keeps the last non-blank lines, trimmed and bounded", () => {
    const { pty, emit } = makeExitablePty();
    const proc = new PtyAgentProcess("default", pty, { bootDialogMaxMs: 10_000 });
    emit("\x1b[1mfirst\x1b[0m   line\n\n\n   second line   \n");
    emit(`${"x".repeat(400)}\n`);
    const tail = proc.recentOutputTail();
    const lines = tail.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("    first line");
    expect(lines[1]).toBe("    second line");
    expect(lines[2].length).toBeLessThan(200);
    expect(lines[2].endsWith("…")).toBe(true);
    // Bounded to the last 8 lines.
    for (let i = 0; i < 20; i++) emit(`line ${i}\n`);
    expect(proc.recentOutputTail().split("\n")).toHaveLength(8);
  });
});
