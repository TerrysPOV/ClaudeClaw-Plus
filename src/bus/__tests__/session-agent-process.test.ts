/**
 * Unit tests for `PtyAgentProcess` write behaviour (#141 review).
 *
 * Uses a fake `PtyHandle` that records every `write` so we can assert:
 *   - concurrent `send_prompt_stream` calls serialise (no byte interleave),
 *   - the boot-dialog watcher answers late dialogs and disengages on the
 *     REPL-ready marker, not on first prompt (issue #193 / Codex P2 on #195).
 */
import { describe, expect, it } from "bun:test";
import { PtyAgentProcess, type PtyHandle } from "../session-agent-process";

function fakePty(): { handle: PtyHandle; writes: string[] } {
  const writes: string[] = [];
  const handle: PtyHandle = {
    pid: 1234,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write: (data: string) => {
      writes.push(data);
    },
    kill: () => {},
  };
  return { handle, writes };
}

describe("PtyAgentProcess.send_prompt_stream", () => {
  it("serialises concurrent prompts so their bytes don't interleave", async () => {
    const { handle, writes } = fakePty();
    const proc = new PtyAgentProcess("alpha", handle, { submitConfirmMs: 5 });

    // Fire two prompts without awaiting the first — without serialisation the
    // second `write(line)` would land inside the first's 200ms settle window,
    // producing order [first, second, "\r", "\r"].
    const a = proc.send_prompt_stream("first");
    const b = proc.send_prompt_stream("second");
    await Promise.all([a, b]);

    // Each prompt's text is immediately followed by its own CR.
    expect(writes).toEqual(["first", "\r", "second", "\r"]);
  });

  it("keeps answering dialogs after an early prompt until the REPL is ready, then disengages (Codex P2 on #195)", async () => {
    const writes: string[] = [];
    let dataCb: ((d: string) => void) | null = null;
    const handle: PtyHandle = {
      pid: 1234,
      onData: (cb) => {
        dataCb = cb;
        return { dispose() {} };
      },
      onExit: () => ({ dispose() {} }),
      write: (data: string) => {
        writes.push(data);
      },
      kill: () => {},
    };
    const proc = new PtyAgentProcess("alpha", handle, { submitConfirmMs: 5 });

    // An early prompt is dispatched BEFORE the boot dialog renders (slow
    // fresh-install boot). The old code disengaged the watcher here, leaving
    // the later dialog unanswered. The watcher must stay engaged.
    await proc.send_prompt_stream("hi");
    writes.length = 0;

    // The bypass dialog renders AFTER the prompt — it must still be answered.
    dataCb?.("WARNING: Bypass Permissions mode\n  2. Yes, I accept\n");
    expect(writes).toContain("\x1b[B"); // watcher still active -> Down
    await new Promise((r) => setTimeout(r, 260));
    expect(writes).toContain("\r"); // then Enter

    // Once the REPL footer appears the watcher disengages — and the marker is
    // mode-independent (Codex P2 #2 on #195): a non-bypass agent shows a
    // mode-specific footer like "plan mode on", but every mode footer carries
    // the "shift+tab to cycle" hint. A later dialog-looking chunk must then be
    // ignored (no keys injected into a live REPL).
    dataCb?.("⏸ plan mode on (shift+tab to cycle)");
    writes.length = 0;
    dataCb?.("stray redraw with 2. Yes, I accept text");
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toEqual([]);
  });
});

function bootPty(): { handle: PtyHandle; writes: string[]; emit: (d: string) => void } {
  const writes: string[] = [];
  let dataCb: ((d: string) => void) | null = null;
  const handle: PtyHandle = {
    pid: 4321,
    onData: (cb) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
    write: (data: string) => {
      writes.push(data);
    },
    kill: () => {},
  };
  return { handle, writes, emit: (d) => dataCb?.(d) };
}

describe("PtyAgentProcess.send_prompt_stream delivery-confirm (#wedge)", () => {
  it("re-sends the submit keystroke when the idle REPL footer is still rendering (turn never started)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 60, maxSubmitNudges: 2 });
    const p = proc.send_prompt_stream("hello");
    // Simulate a prompt that was typed but NOT submitted: the idle prompt keeps
    // re-rendering its footer ("to cycle") instead of a streaming turn.
    const iv = setInterval(() => emit("\n⏵ accept edits on (shift+tab to cycle)"), 8);
    await p;
    clearInterval(iv);
    // 1 initial submit + 2 re-nudges (footer present at every confirm window).
    expect(writes.filter((w) => w === "\r").length).toBe(3);
  });

  it("does NOT re-nudge when a turn started (streaming output, footer gone)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 60, maxSubmitNudges: 2 });
    const p = proc.send_prompt_stream("hello");
    // Simulate a real turn: streaming output with NO idle footer.
    const iv = setInterval(() => emit("assistant is streaming a response chunk here"), 8);
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "\r").length).toBe(1); // only the submit
  });

  it("waits out an auto-compaction and re-submits when the REPL returns (socket=yes wedge)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    const p = proc.send_prompt_stream("hello");
    // An auto-compaction seizes the REPL for ~150ms and swallows the submit CR
    // (no turn). The footer then returns to its idle "to cycle" hint.
    let compacting = true;
    const iv = setInterval(
      () =>
        emit(
          compacting
            ? "\nCompacting conversation… (esc to interrupt)"
            : "\n⏵ accept edits on (shift+tab to cycle)",
        ),
      8,
    );
    const stop = setTimeout(() => {
      compacting = false;
    }, 150);
    await p;
    clearInterval(iv);
    clearTimeout(stop);
    // The submit was re-sent AFTER compaction finished: initial CR + >=1 nudge.
    // (Compaction-wait iterations must not have burned the nudge budget.)
    expect(writes.filter((w) => w === "\r").length).toBeGreaterThanOrEqual(2);
  });

  it("gives up on a stuck compaction at maxCompactionWaitMs without hanging or spurious submits", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 80,
    });
    const p = proc.send_prompt_stream("hello");
    const iv = setInterval(() => emit("\nCompacting conversation…"), 8); // never ends
    await p; // must resolve (bounded), not hang
    clearInterval(iv);
    // Only the initial submit CR -- no idle footer was ever seen, so no nudge.
    expect(writes.filter((w) => w === "\r").length).toBe(1);
  });

  it("does NOT mistake the bare word 'Compacting' in streamed output for a compaction (no stall)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    const p = proc.send_prompt_stream("hello");
    // A real turn is streaming and its text contains the bare word "Compacting"
    // (e.g. the agent discussing log/db compaction). No status line, no footer.
    // The anchored probe must read this as turn-started, not wait out a phantom
    // compaction (which would also block the serialised writeChain).
    const iv = setInterval(() => emit("the daemon was Compacting the old logs when it ran"), 8);
    const t0 = Date.now();
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "\r").length).toBe(1); // only the submit
    expect(Date.now() - t0).toBeLessThan(2500); // resolved fast, not the 5s deadline
  });

  it("clears the stranded input line and warns once when a submit is never confirmed", async () => {
    const { handle, writes, emit } = bootPty();
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    };
    try {
      const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 20, maxSubmitNudges: 2 });
      const p = proc.send_prompt_stream("hello");
      const iv = setInterval(() => emit("\n⏵ accept edits on (shift+tab to cycle)"), 6); // idle forever
      await p;
      clearInterval(iv);
      expect(writes).toContain("\x15"); // Ctrl-U cleared the un-submitted prompt
      expect(warnings.some((w) => w.includes("not confirmed"))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  it("rejects (not resolves) if the agent exits during the confirm wait", async () => {
    const writes: string[] = [];
    let exitCb: ((e: { exitCode: number }) => void) | null = null;
    const handle: PtyHandle = {
      pid: 99,
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        exitCb = cb as typeof exitCb;
        return { dispose() {} };
      },
      write: (d: string) => {
        writes.push(d);
      },
      kill: () => {},
    };
    const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 50, maxSubmitNudges: 2 });
    const p = proc.send_prompt_stream("hello");
    setTimeout(() => exitCb?.({ exitCode: 1 }), 230); // die after the CR, mid-confirm
    // The other _exited checks in send_prompt_stream throw; the in-loop check
    // must too, so the caller/receipt layer learns delivery failed.
    await expect(p).rejects.toThrow("has exited");
  });
});

describe("PtyAgentProcess boot-dialog watcher (structural / ANSI-resilient)", () => {
  it("answers a confirm dialog whose title is split by a cursor-move escape (the 2.1.x regression)", () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("alpha", handle);
    // Raw PTY: ESC[32G is interleaved INSIDE the title, so a literal
    // "development channels" match on the raw buffer fails — exactly the bug
    // that wedged boots after a CLI auto-update. The structural match (selected
    // option + "Enter to confirm") must still confirm the proceed default.
    emit(
      "WARNING: Loading development\x1b[32Gchannels\r\n" +
        " ❯ 1. I am using this for local development\r\n" +
        "   2. Exit\r\n Enter to confirm · Esc to cancel",
    );
    expect(writes).toEqual(["\r"]);
  });

  it("answers the new trust-folder dialog with Enter (default = trust)", () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("beta", handle);
    emit(
      "Quick safety check: Is this a project you trust?\r\n" +
        " ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n Enter to confirm · Esc to cancel",
    );
    expect(writes).toEqual(["\r"]);
  });

  it("sends one Enter per distinct dialog, not per render chunk", () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("gamma", handle);
    const trust = " ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n Enter to confirm";
    emit(trust);
    emit(trust); // same dialog re-rendered across chunks -> no second Enter
    expect(writes).toEqual(["\r"]);
    emit(" ❯ 1. I am using this for local development\r\n   2. Exit\r\n Enter to confirm"); // distinct dialog
    expect(writes).toEqual(["\r", "\r"]);
  });

  it("does NOT auto-answer an unknown dialog whose default is destructive; warns once", () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("delta", handle);
    const origErr = console.error;
    let warned = "";
    console.error = (...a: unknown[]) => {
      warned = a.map(String).join(" ");
    };
    try {
      emit(" ❯ 2. No, exit\r\n   1. Delete everything\r\n Enter to confirm");
    } finally {
      console.error = origErr;
    }
    expect(writes).toEqual([]); // no blind keypress on a non-proceed default
    expect(warned).toContain("non-proceed default");
  });

  it("fails safe on a destructive default phrased without an exit/cancel keyword (allowlist invert)", () => {
    // A selected default phrased "Delete everything" matched no proceed verb,
    // so the watcher must warn-and-wait rather than blind-Enter it — the case
    // the old destructive-blocklist (exit|cancel|abort|…) would have missed.
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("zeta", handle);
    const origErr = console.error;
    let warned = "";
    console.error = (...a: unknown[]) => {
      warned = a.map(String).join(" ");
    };
    try {
      emit(" ❯ 1. Delete everything\r\n   2. Keep files\r\n Enter to confirm");
    } finally {
      console.error = origErr;
    }
    expect(writes).toEqual([]); // not a recognised proceed action -> no Enter
    expect(warned).toContain("non-proceed default");
  });

  it("does NOT fire a second Enter when the bypass dialog re-renders after Down+Enter (Codex F3)", async () => {
    // The bypass-permissions dialog is answered by the gated Down+Enter branch.
    // On the redraw chunk the SAME dialog text is still on screen with "❯" now
    // on the accept row — it must NOT fall through to the generic confirm
    // branch and fire a second, blind Enter racing the deferred one.
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("eta", handle);
    emit(
      "WARNING: Bypass Permissions mode\r\n ❯ 1. No, exit\r\n   2. Yes, I accept\r\n Enter to confirm",
    );
    // redraw after Down: selection moved to the accept row, dialog still up.
    emit(
      "WARNING: Bypass Permissions mode\r\n   1. No, exit\r\n ❯ 2. Yes, I accept\r\n Enter to confirm",
    );
    await new Promise((r) => setTimeout(r, 250)); // let the deferred Enter land
    expect(writes).toEqual(["\x1b[B", "\r"]); // exactly Down then one Enter
  });

  it("disengages on the REPL footer and ignores later dialog-looking text", async () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("epsilon", handle);
    emit("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents");
    writes.length = 0;
    emit(" ❯ 1. I am using this for local development\r\n Enter to confirm");
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual([]); // disengaged -> no key into a live REPL
  });
});
