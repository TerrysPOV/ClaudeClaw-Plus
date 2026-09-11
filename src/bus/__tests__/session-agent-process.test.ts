/**
 * Unit tests for `PtyAgentProcess` write behaviour (#141 review).
 *
 * Uses a fake `PtyHandle` that records every `write` so we can assert:
 *   - concurrent `send_prompt_stream` calls serialise (no byte interleave),
 *   - the boot-dialog watcher answers late dialogs and disengages on the
 *     REPL-ready marker, not on first prompt (issue #193 / Codex P2 on #195).
 */
import { describe, expect, it } from "bun:test";
import { PtyAgentProcess, type PromptIngestion, type PtyHandle } from "../session-agent-process";

describe("PtyAgentProcess.send_prompt_stream", () => {
  it("serialises concurrent prompts so their bytes don't interleave", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("alpha", handle, { submitConfirmMs: 5 });

    // A real REPL redraws after each CR: streaming output replaces the footer,
    // so each turn confirms started after the first window -> exactly one CR per
    // prompt. (A silent fake never confirms and now nudges to budget — covered
    // by the idle-REPL test below — which would mask the interleave check here.)
    const iv = setInterval(() => emit("assistant is streaming a response chunk"), 2);

    // Fire two prompts without awaiting the first — without serialisation the
    // second `write(line)` would land inside the first's 200ms settle window,
    // producing order [first, second, "\r", "\r"].
    const a = proc.send_prompt_stream("first");
    const b = proc.send_prompt_stream("second");
    await Promise.all([a, b]);
    clearInterval(iv);

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
    // The turn never started, so the typed line is still stranded in the input
    // box; a stuck compaction must clear it too (else it concatenates onto the
    // next prompt) -- not only the unconfirmed-idle outcome.
    expect(writes).toContain("\x15"); // Ctrl-U cleared the stranded line
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

  it("treats a WHITESPACE-only confirm window as inconclusive (not a started turn) — the .trim() guard", async () => {
    // A confirm window that contains only whitespace/newlines must NOT be read
    // as a started turn: `recentOut.trim().length > 0` is false on "   \n", so
    // the window stays inconclusive, spends a nudge, and (budget gone) gives up
    // honestly with a line-clear + warn — same as a truly-empty window. Guards
    // the `.trim()` half of the gate that a non-whitespace test would miss.
    const { handle, writes, emit } = bootPty();
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    };
    try {
      const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 20, maxSubmitNudges: 2 });
      const p = proc.send_prompt_stream("hello");
      // Only whitespace flows during the confirm windows — never a footer,
      // never streaming text.
      const iv = setInterval(() => emit("   \n  \n"), 6);
      await p;
      clearInterval(iv);
      expect(writes.filter((w) => w === "\r").length).toBe(3); // submit + 2 nudges
      expect(writes).toContain("\x15"); // Ctrl-U cleared the un-submitted line
      expect(warnings.some((w) => w.includes("not confirmed"))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  it("does NOT mistake a silent idle REPL (zero output) for a started turn — keeps nudging then gives up honestly (idle-REPL wedge, dossier 20260612T080557)", async () => {
    const { handle, writes } = bootPty();
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    };
    try {
      const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 20, maxSubmitNudges: 2 });
      // A long-idle REPL whose swallowed CR triggers no redraw emits NOTHING
      // during the confirm windows (never call emit). The empty buffer must not
      // be read as a started turn: `!includes("to cycle")` is true on "" too.
      // The loop must spend its full nudge budget and then give up honestly,
      // not claim a phantom turn-started and let the prompt rot to the 5-min
      // receipt timeout (the residual wedge this guards).
      await proc.send_prompt_stream("hello");
      // initial submit CR + 2 nudges = 3 (an empty window is inconclusive, not
      // a turn-start, so every window spends a nudge until the budget is gone).
      expect(writes.filter((w) => w === "\r").length).toBe(3);
      expect(writes).toContain("\x15"); // Ctrl-U cleared the un-submitted line
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

  it("answers the trust-folder dialog with Down+Enter when the CLI defaults to \"No, exit\" (2026-09-07 regression)", async () => {
    // Captured live against claude 2.1.263: the trust-folder dialog now
    // preselects "No, exit" for a cwd re-entering under a fresh --session-id
    // even though it was already trusted in a prior session — same shape as
    // the bypass-permissions dialog's destructive default. Before this fix
    // the generic branch correctly refused to blind-Enter into exit, but had
    // no Down+Enter fallback for this dialog, so the agent just wedged and
    // was later killed — every mcp-reconciler respawn of a live agent hit
    // this and never came back up.
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("theta", handle);
    emit(
      "Quick safety check: Is this a project you trust?\r\n" +
        " ❯ 1. No, exit\r\n   2. Yes, I trust this folder\r\n Enter to confirm · Esc to cancel",
    );
    expect(writes).toContain("\x1b[B"); // Down
    await new Promise((r) => setTimeout(r, 250));
    expect(writes).toEqual(["\x1b[B", "\r"]); // then Enter, exactly once
  });

  it("does NOT fire a second Enter when the trust-folder dialog re-renders after Down+Enter", async () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("iota", handle);
    emit(
      "Quick safety check: Is this a project you trust?\r\n" +
        " ❯ 1. No, exit\r\n   2. Yes, I trust this folder\r\n Enter to confirm",
    );
    // redraw after Down: selection moved to the trust row, dialog still up.
    emit(
      "Quick safety check: Is this a project you trust?\r\n" +
        "   1. No, exit\r\n ❯ 2. Yes, I trust this folder\r\n Enter to confirm",
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(writes).toEqual(["\x1b[B", "\r"]);
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

// #271 regression: the CLI renders the REPL footer with CHA cursor positioning
// (ESC[NG between tokens), not literal spaces. After the ANSI stripper runs the
// markers collapse — "shift+tab to cycle" -> "shift+tabtocycle" — so the OLD
// literal-substring matchers (`includes("to cycle")` / `includes("tab to
// cycle")`) never matched on the real render. Every test above feeds a
// PRE-SPACED footer, which is exactly why the bug hid. These feed the raw
// CHA-sequenced footer through the real `stripAnsiEscapes` path so a future
// regression to literal matching is caught.
describe("PtyAgentProcess CHA-collapsed REPL footer (#271)", () => {
  // The captured raw footer from the PR: cursor-positioned tokens with no
  // literal spaces. `\x1b[NG` is the CHA (Cursor Horizontal Absolute) escape.
  const CHA_IDLE_FOOTER = "\n⏵ accept edits on (shift+tab\x1b[39Gto\x1b[42Gcycle)";

  it("delivery-confirm: re-nudges on the CHA-collapsed idle footer (turn never started)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, { submitConfirmMs: 60, maxSubmitNudges: 2 });
    const p = proc.send_prompt_stream("hello");
    // Idle REPL re-rendering its footer via CHA positioning. With the old
    // `includes("to cycle")` this stripped to "tocycle" and never matched, so
    // the loop read every window as turn-started and emitted only 1 CR.
    const iv = setInterval(() => emit(CHA_IDLE_FOOTER), 8);
    await p;
    clearInterval(iv);
    // 1 initial submit + 2 re-nudges — the `/to\s*cycle/` matcher fires on the
    // collapsed render exactly as it would on the spaced one.
    expect(writes.filter((w) => w === "\r").length).toBe(3);
  });

  it("boot-ready: disengages the watcher on the CHA-collapsed footer", async () => {
    const { handle, writes, emit } = bootPty();
    new PtyAgentProcess("epsilon", handle);
    // Raw CHA footer with the boot-ready "tab to cycle" core collapsed to
    // "tabtocycle". The `/tab\s*to\s*cycle/` matcher must still disengage.
    emit("⏵⏵ bypass permissions on (shift+tab\x1b[39Gto\x1b[42Gcycle) · ← for agents");
    writes.length = 0;
    emit(" ❯ 1. I am using this for local development\r\n Enter to confirm");
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual([]); // disengaged -> no key into a live REPL
  });
});

describe("PtyAgentProcess compaction latch", () => {
  // The real CLI paints "Compacting conversation…" ONCE and then renders a bare
  // spinner. The confirm loop clears `recentOut` at the top of every window, so
  // an in-window probe only sees the banner if the CLI repaints it inside that
  // slice. When the inbound prompt is what pushed the context over the limit the
  // compaction starts BEFORE the prompt is written, so the banner is already
  // gone at the first reset. The window then reads "non-empty output, no idle
  // footer" and the loop declares a turn that never started.
  //
  // These cases assert on PTY writes only, so they hold regardless of how a
  // turn-start is reported to callers.
  it("retypes when the compaction leaves the REPL idle (the prompt was swallowed)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    emit("\nCompacting conversation… (esc to interrupt)"); // painted once, before the prompt
    const p = proc.send_prompt_stream("hello");
    let compacting = true;
    const iv = setInterval(
      () => emit(compacting ? "\n⠋" : "\n⏵ accept edits on (shift+tab to cycle)"),
      5,
    );
    setTimeout(() => {
      compacting = false;
      emit("\nCompacted (ctrl+o to see full summary)");
    }, 150);
    await p;
    clearInterval(iv);
    // The compaction re-rendered the REPL and left it idle, so the prompt is
    // gone from the input box: a bare CR would submit nothing. Retype once.
    expect(writes.filter((w) => w === "hello").length).toBe(2);
    // The footer never gives way to a streaming turn, so the loop ends on a
    // give-up and clears the stranded input line LAST. An earlier \x15 belongs
    // to the retype, so only the final write separates the two outcomes.
    expect(writes[writes.length - 1]).toBe("\x15");
  });

  it("does NOT retype when the turn is already streaming after the compaction", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 3,
      maxCompactionWaitMs: 5000,
    });
    emit("\nCompacting at auto window");
    const p = proc.send_prompt_stream("hello");
    let phase: "compacting" | "streaming" = "compacting";
    const iv = setInterval(
      () => emit(phase === "compacting" ? "\n⠙" : "\nassistant is streaming a chunk"),
      5,
    );
    setTimeout(() => {
      emit("\nCompacted (ctrl+o to see full summary)");
      phase = "streaming";
    }, 120);
    await p;
    clearInterval(iv);
    // The CLI buffered the keystrokes through the compaction and submitted them
    // itself: a turn IS running. Retyping here would push the same prompt into a
    // live turn and run it twice.
    expect(writes.filter((w) => w === "hello").length).toBe(1);
    expect(writes).not.toContain("\x15");
  });

  it("a spinner frame does not clear the latch once compaction is seen", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 300,
    });
    emit("\nCompacting conversation…");
    const p = proc.send_prompt_stream("hello");
    // Nothing but spinner frames, forever: the latch must hold, so the loop waits
    // out maxCompactionWaitMs instead of reading the spinner as a live turn.
    const iv = setInterval(() => emit("\n⠸"), 5);
    const t0 = Date.now();
    await p;
    const elapsed = Date.now() - t0;
    clearInterval(iv);
    // 200ms pre-CR settle + the full 300ms compaction deadline. An in-window
    // probe that misses the banner returns at ~220ms (settle + one 20ms window),
    // so this threshold discriminates instead of being met by the settle alone.
    // Headroom below the ~500ms nominal (200ms settle + 300ms budget): a loaded
    // box only makes real timers fire LATE, so the discriminating gap is against
    // the ~220ms an early false turn-start would take, not against the ceiling.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(writes.filter((w) => w === "\r").length).toBe(1); // no nudge spent
  });

  it("clears the latch when the end marker is split across PTY chunks", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    emit("\nCompacting conversation…");
    const p = proc.send_prompt_stream("hello");
    let compacting = true;
    const iv = setInterval(
      () => emit(compacting ? "\n⠋" : "\n⏵ accept edits on (shift+tab to cycle)"),
      5,
    );
    setTimeout(() => {
      compacting = false;
      // The marker arrives in two pieces, as a real PTY read boundary would
      // deliver it. Detecting on a single chunk misses this and leaves the
      // latch armed for the rest of the process's life.
      emit("\nCompact");
      emit("ed (ctrl+o to see full summary)");
    }, 120);
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "hello").length).toBe(2); // latch cleared -> retype ran
  });

  it("does not retype when a short buffered turn started and finished in one window", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 40,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    emit("\nCompacting conversation…");
    const p = proc.send_prompt_stream("hello");
    let phase: "compacting" | "burst" | "idle" = "compacting";
    const iv = setInterval(() => {
      if (phase === "compacting") emit("\n⠋");
      else if (phase === "idle") emit("\n⏵ accept edits on (shift+tab to cycle)");
    }, 5);
    setTimeout(() => {
      emit("\nCompacted (ctrl+o to see full summary)");
      phase = "burst";
      // The CLI had buffered the keystrokes and ran the turn itself. It is short
      // enough that its output AND the repainted idle footer land in the SAME
      // confirm window — so the footer alone cannot be read as "no turn ran".
      emit("\nassistant answered already\n⏵ accept edits on (shift+tab to cycle)");
      phase = "idle";
      // 260ms: past the 200ms pre-CR settle, so this lands INSIDE a confirm
      // window rather than before the loop starts.
    }, 260);
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "hello").length).toBe(1); // no duplicate submit
  });

  it("retypes even when output appeared BEFORE the compaction started", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 40,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    const p = proc.send_prompt_stream("hello");
    // Window 1: the REPL is idle and repaints its bottom chrome — the input box
    // still holding the un-submitted prompt, plus the footer. That echoed line is
    // non-footer output, but it proves nothing about a turn: treating it as
    // evidence would gate off the retype below and drop the prompt silently.
    let phase: "echo" | "compacting" | "idle" = "echo";
    const iv = setInterval(() => {
      if (phase === "echo") emit("\n> hello\n⏵ accept edits on (shift+tab to cycle)");
      else if (phase === "compacting") emit("\n⠋");
      else emit("\n⏵ accept edits on (shift+tab to cycle)");
    }, 5);
    setTimeout(() => {
      phase = "compacting";
      emit("\nCompacting conversation… (esc to interrupt)");
    }, 260);
    setTimeout(() => {
      phase = "idle";
      emit("\nCompacted (ctrl+o to see full summary)");
    }, 420);
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "hello").length).toBe(2); // retype still runs
  });

  it("counts non-ASCII turn output as evidence (no duplicate submit)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 40,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    emit("\nCompacting conversation…");
    const p = proc.send_prompt_stream("hello");
    let phase: "compacting" | "idle" = "compacting";
    const iv = setInterval(() => {
      if (phase === "compacting") emit("\n⠋");
      else emit("\n⏵ accept edits on (shift+tab to cycle)");
    }, 5);
    setTimeout(() => {
      emit("\nCompacted (ctrl+o to see full summary)");
      // The buffered turn ran and its visible output is entirely non-ASCII —
      // emoji and box-drawing tool chrome, no Latin text. Filtering the window
      // down to ASCII would erase it, read "no turn ran", and retype into the
      // live turn.
      emit("\n╭──────────╮\n│ ✅ 🎉 📦 │\n╰──────────╯\n⏵ accept edits on (shift+tab to cycle)");
      phase = "idle";
    }, 260);
    await p;
    clearInterval(iv);
    expect(writes.filter((w) => w === "hello").length).toBe(1);
  });

  it("a prompt whose own text contains the banner does not arm the latch", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 2000,
    });
    const poisoned = "explain what Compacting conversation means";
    const t0 = Date.now();
    const p = proc.send_prompt_stream(poisoned);
    // The CLI echoes the typed text back on the output stream. Matching markers
    // against that echo lets any chat message arm a sticky, process-wide latch
    // and stall the serialised write chain for the whole compaction budget.
    const iv = setInterval(() => {
      emit("\n> " + poisoned);
      emit("\nassistant is streaming a chunk");
    }, 5);
    await p;
    const elapsed = Date.now() - t0;
    clearInterval(iv);
    // A real turn is streaming, so this must confirm on the first window
    // (~230ms). If the echo armed the latch the loop would instead wait out
    // maxCompactionWaitMs and only return after ~2200ms.
    expect(elapsed).toBeLessThan(1000);
    expect(writes.filter((w) => w === "\r").length).toBe(1); // confirmed, no nudge
  });

  it("strips the echo as the TUI actually renders it (bordered input box)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 2000,
    });
    const poisoned = "explain what Compacting conversation means";
    const t0 = Date.now();
    const p = proc.send_prompt_stream(poisoned);
    // The real TUI paints the input box with borders and padding. Stripping only
    // the LEADING glyphs leaves the trailing bar, the echo stops matching what we
    // typed, and remote text reaches the marker probes again.
    const iv = setInterval(() => {
      emit("\n│ > " + poisoned + "        │");
      emit("\nassistant is streaming a chunk");
    }, 5);
    await p;
    const elapsed = Date.now() - t0;
    clearInterval(iv);
    expect(elapsed).toBeLessThan(1000);
    expect(writes.filter((w) => w === "\r").length).toBe(1);
  });

  it("keeps the real footer when the prompt quotes it verbatim (Copilot #359)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("z", handle, {
      submitConfirmMs: 30,
      maxSubmitNudges: 2,
      maxCompactionWaitMs: 5000,
    });
    // A plausible prompt: the user pastes a CLI transcript that contains the
    // idle footer verbatim. Stripping every line that is merely a substring of
    // what we typed would erase the CLI's OWN footer, so an idle REPL would read
    // as a started turn and the prompt would be dropped — the inverse of the
    // echo-poisoning this filter exists to stop.
    const quoted = "regarde ce transcript: accept edits on (shift+tab to cycle) — explique-moi";
    const p = proc.send_prompt_stream(quoted);
    const iv = setInterval(() => {
      emit("\n⏵ accept edits on (shift+tab to cycle)");
      emit("\nassistant is streaming a chunk");
    }, 5);
    await p;
    clearInterval(iv);
    // Footer preserved ⇒ the REPL is correctly seen as idle ⇒ the loop nudges
    // instead of declaring a turn. 1 initial submit + 2 nudges.
    expect(writes.filter((w) => w === "\r").length).toBe(3);
  });
});

describe("PtyAgentProcess transcript-confirmed delivery (issue #362)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ingestion = (text: string, over: Partial<PromptIngestion> = {}): PromptIngestion => ({
    text,
    source: "user",
    promptId: `pid-${Math.random().toString(36).slice(2)}`,
    ingestedAtMs: Date.now(),
    ...over,
  });

  /**
   * A compaction that STARTS AND ENDS BEFORE the prompt is written, then keeps
   * repainting the restored transcript. This is the production ordering of the
   * 2026-08-27 wedge (compaction ends 14:04:43, prompt written 14:04:47) and
   * the one no screen-derived signal can see: the epoch was bumped before the
   * snapshot, the latch is already cleared, `markerTail` is wiped at write, and
   * `Compacted (` never appears in a confirm window.
   */
  async function compactionEndsThenWrite(
    proc: PtyAgentProcess,
    emit: (d: string) => void,
    prompt: string,
  ) {
    emit("Compacting conversation…");
    await sleep(20);
    emit("Compacted (ctrl+o to see full summary)");
    await sleep(30);
    const iv = setInterval(() => emit("earlier turn text being repainted\n"), 5);
    const done = proc.send_prompt_stream(prompt);
    return { done, stop: () => clearInterval(iv) };
  }

  it("does not confirm a turn from a repaint when the compaction ended BEFORE the write", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("f1", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    const { done, stop } = await compactionEndsThenWrite(proc, emit, "please summarise");
    await done;
    stop();

    // The prompt was never ingested: reporting a started turn here is the wedge.
    expect(writes).toContain("\x15");
  });

  it("keeps the old screen behaviour for that same ordering when no transcript is live", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("f1b", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    // No enableTranscriptConfirmation: also the blind-tailer case, where a
    // path mismatch means no line is ever read. Such an agent must degrade to
    // the previous behaviour, never stall waiting on a transcript that cannot
    // speak. Identical config to the test above — only the transcript differs.

    const { done, stop } = await compactionEndsThenWrite(proc, emit, "please summarise");
    await done;
    stop();

    expect(writes).not.toContain("\x15");
  });

  it("confirms as soon as the transcript records the prompt, whatever the screen shows", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("ok", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 3,
      transcriptGraceMs: 5000,
    });
    proc.enableTranscriptConfirmation();

    const { done, stop } = await compactionEndsThenWrite(proc, emit, "hello there");
    setTimeout(() => proc.notePromptIngested(ingestion("hello there")), 30);
    await done;
    stop();

    expect(writes).not.toContain("\x15");
    expect(writes.filter((w) => w === "\r").length).toBe(1);
  });

  it("reports unconfirmed rather than a turn when a live transcript stays silent", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("f2", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    // Genuine streaming output the whole way, but the transcript never speaks.
    const p = proc.send_prompt_stream("hi");
    const iv = setInterval(() => emit("assistant is streaming a response\n"), 5);
    await p;
    clearInterval(iv);

    // Held for the grace period without spending a nudge, then answered
    // "unknown" — exactly one submit CR, never re-nudged or re-typed.
    expect(writes.filter((w) => w === "\r").length).toBe(1);
    // A single \r holds identically for `turn-started`, so it does not name the
    // outcome this test is about: deleting the whole transcript branch left it
    // green (adversarial pass, finding 6). `\x15` is the discriminator — the
    // loop clears the input box only when it refuses to call the delivery
    // confirmed.
    expect(writes).toContain("\x15");
  });

  /**
   * Staleness-by-timestamp applies to `enqueue` only. Its stamp tracks
   * acceptance within ~0.2s, whereas the CLI backdates `user` lines — observed
   * by up to 148s — so a `user` record cannot be judged stale that way. What
   * protects the `user` path is the consumed-id set, covered separately.
   */
  it("ignores an enqueue recorded before this prompt was armed (late event, earlier delivery)", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("f4a", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    const { done, stop } = await compactionEndsThenWrite(
      proc,
      emit,
      "heartbeat: any new messages?",
    );
    // The bus re-delivers verbatim; this is the FIRST delivery's transcript
    // line arriving late. Same text, but stamped well before this arming.
    setTimeout(
      () =>
        proc.notePromptIngested({
          text: "heartbeat: any new messages?",
          source: "enqueue",
          ingestedAtMs: Date.now() - 60_000,
        }),
      30,
    );
    await done;
    stop();

    expect(writes).toContain("\x15");
  });

  it("refuses to reuse a promptId that already confirmed a delivery", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("f4b", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const shared = "identical prompt text";
    const pid = "pid-reused";

    // First delivery, confirmed by the transcript.
    const first = proc.send_prompt_stream(shared);
    setTimeout(
      () =>
        proc.notePromptIngested({
          text: shared,
          source: "user",
          promptId: pid,
          ingestedAtMs: Date.now(),
        }),
      25,
    );
    await first;
    const afterFirst = writes.length;

    // Second, verbatim re-delivery. The same promptId must not confirm it.
    const { done, stop } = await compactionEndsThenWrite(proc, emit, shared);
    setTimeout(
      () =>
        proc.notePromptIngested({
          text: shared,
          source: "user",
          promptId: pid,
          ingestedAtMs: Date.now(),
        }),
      25,
    );
    await done;
    stop();

    expect(writes.slice(afterFirst)).toContain("\x15");
  });

  it("ignores a transcript prompt that is not the one in flight", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("other", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    const { done, stop } = await compactionEndsThenWrite(proc, emit, "the real prompt");
    setTimeout(() => proc.notePromptIngested(ingestion("Continue from where you left off")), 30);
    await done;
    stop();

    expect(writes).toContain("\x15");
  });

  it("matches a prompt containing a tab, which the transcript cannot carry", async () => {
    const { handle, writes } = bootPty();
    const proc = new PtyAgentProcess("tab", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 3,
      transcriptGraceMs: 5000,
    });
    proc.enableTranscriptConfirmation();

    // sanitizePtyPromptText preserves TAB, but a raw 0x09 typed into the TUI is
    // a completion key and never reaches the transcript.
    const p = proc.send_prompt_stream("col a\tcol b");
    setTimeout(() => proc.notePromptIngested(ingestion("col acol b")), 40);
    await p;

    expect(writes).not.toContain("\x15");
  });
});

describe("PtyAgentProcess enqueue-confirmed delivery (issue #363)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const enqueued = (text: string, over: Partial<PromptIngestion> = {}): PromptIngestion => ({
    text,
    source: "enqueue",
    ingestedAtMs: Date.now(),
    ...over,
  });

  /**
   * The case that refuted the `user`-only design. The bus delivers into an
   * active turn: the CLI queues the keystrokes and does not write the `user`
   * line until the neighbouring turn ends — measured past 8s for 12 of 56
   * deliveries, with a 443s maximum. Meanwhile the screen is non-empty,
   * footer-free streaming output, so requiring `user` turned a rare false
   * "delivered" into a frequent false "lost".
   *
   * `enqueue` is written ~0.2s after the keystrokes land, precisely BECAUSE
   * the prompt was queued. Every one of those 12 slow deliveries has one.
   */
  it("confirms a prompt queued behind a live turn from its enqueue record", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("q1", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 200,
    });
    proc.enableTranscriptConfirmation();

    const p = proc.send_prompt_stream("new inbound message");
    // A neighbour turn streams the whole time; the `user` line never arrives.
    const iv = setInterval(() => emit("neighbour turn is streaming its answer\n"), 5);
    setTimeout(() => proc.notePromptIngested(enqueued("new inbound message")), 40);
    await p;
    clearInterval(iv);

    // Confirmed, so no stranded-line clear and exactly one submit CR.
    expect(writes).not.toContain("\x15");
    expect(writes.filter((w) => w === "\r").length).toBe(1);
  });

  /**
   * An auto-compaction emits a cluster of `user` lines sharing ONE promptId —
   * the continuation summary first, the real prompt after. Keying the consumed
   * set on the id alone let the summary burn it, so the prompt that followed
   * could never confirm: the failure landed in exactly the case this mechanism
   * exists for, and `enqueue` does not cover it (a prompt that TRIGGERS a
   * compaction is not queued behind a running turn).
   */
  it("still confirms when a compaction cluster shares one promptId with earlier lines", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("cluster", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 3,
      transcriptGraceMs: 400,
    });
    proc.enableTranscriptConfirmation();
    const sharedId = "pid-compaction-cluster";

    const p = proc.send_prompt_stream("summarise the thread");
    const iv = setInterval(() => emit("restored transcript repaint\n"), 5);
    // The cluster's earlier lines arrive first, under the same promptId.
    setTimeout(() => {
      proc.notePromptIngested({
        text: "This session is being continued from a previous conversation…",
        source: "user",
        promptId: sharedId,
        ingestedAtMs: Date.now(),
      });
      proc.notePromptIngested({
        text: "<command-name>/compact</command-name>",
        source: "user",
        promptId: sharedId,
        ingestedAtMs: Date.now(),
      });
      // Then the real prompt, same id.
      proc.notePromptIngested({
        text: "summarise the thread",
        source: "user",
        promptId: sharedId,
        ingestedAtMs: Date.now(),
      });
    }, 40);
    await p;
    clearInterval(iv);

    expect(writes).not.toContain("\x15");
  });

  it("refuses to confirm from the screen when the transcript says nothing at all", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("q2", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    const p = proc.send_prompt_stream("dropped prompt");
    const iv = setInterval(() => emit("repaint noise\n"), 5);
    // Nothing is injected: this is the transcript-silent case, and the point is
    // that the screen alone never confirms.
    //
    // Renamed. It used to be called "ignores a de-queue: only operation=enqueue
    // is an ingestion" and its comment said a `remove` record was filtered at
    // the tailer — both false since withdrawals became a forwarded signal, and
    // neither was ever true of this body, which injects no record at all. The
    // withdrawal paths are covered by their own tests above.
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * The screen claimed a turn, the transcript spoke only afterwards. This is
   * the path the grace period exists for, and the previous attempt never
   * exercised it: its ingestions all fired inside the 200ms paste settle, so
   * deleting the grace entirely left every test passing.
   */
  it("holds the screen's claim and confirms when the transcript speaks during the grace", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("grace", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 400,
    });
    proc.enableTranscriptConfirmation();

    const p = proc.send_prompt_stream("held then confirmed");
    const iv = setInterval(() => emit("output with no footer\n"), 5);
    // Well after the settle, so the loop must reach the claim branch and hold.
    setTimeout(() => proc.notePromptIngested(enqueued("held then confirmed")), 260);
    await p;
    clearInterval(iv);

    expect(writes).not.toContain("\x15");
    expect(writes.filter((w) => w === "\r").length).toBe(1);
  });

  /**
   * An ingestion arriving while nothing is armed must still be recorded as
   * consumed. Deliveries routinely end with the transcript silent, so this is
   * the common case — and leaving the id unrecorded let it confirm the next
   * verbatim re-delivery, which the bus produces on flush-verify.
   */
  /**
   * Adversarial pass, finding 1 — the phantom this whole mechanism exists to
   * remove, still open until this test.
   *
   * `enqueue` confirms delivery #1 the moment the CLI takes the keystrokes.
   * The matching `user` line is written later, when the prompt actually runs.
   * `flushVerify` re-delivers the SAME text verbatim in between, so that late
   * `user` line lands while delivery #2 is armed. It is a first sighting, so
   * the consumed-ids set does not know it, and `user` records are exempt from
   * the timestamp check because the CLI backdates them by up to 148 s.
   * Nothing rejected it: delivery #2 was reported delivered while still
   * sitting un-submitted in the input box.
   */
  it("does not let a late user record from an enqueue-confirmed delivery confirm the next one", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("late-user", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "heartbeat: any new messages?";

    // Delivery #1 — confirmed by its enqueue. Its `user` line has not landed.
    const first = proc.send_prompt_stream(text);
    const iv1 = setInterval(() => emit("streaming\n"), 5);
    setTimeout(() => proc.notePromptIngested(enqueued(text)), 25);
    await first;
    clearInterval(iv1);

    // Delivery #2 — same bytes, as flushVerify re-delivers them.
    const before = writes.length;
    const second = proc.send_prompt_stream(text);
    const iv2 = setInterval(() => emit("streaming\n"), 5);
    // Delivery #1's `user` line, arriving for the FIRST time, mid-delivery #2.
    setTimeout(
      () =>
        proc.notePromptIngested({
          text,
          source: "user",
          promptId: "pid-of-first",
          ingestedAtMs: Date.now(),
        }),
      30,
    );
    await second;
    clearInterval(iv2);

    // Un-submitted: the loop must have given up on the transcript, not been
    // satisfied by a record that belonged to the delivery before it.
    expect(writes.slice(before)).toContain("\x15");
  });

  /**
   * Adversarial pass, finding 2 — an unusable timestamp used to wave the
   * record through. The enqueue path carries no `promptId`, so the timestamp
   * is the ONLY thing deciding which delivery a record belongs to; treating a
   * missing stamp as "recent enough" let a stale enqueue confirm whatever
   * happened to be armed.
   */
  it("refuses an enqueue whose timestamp is unusable instead of trusting it", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("no-stamp", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "deploy the thing";

    const p = proc.send_prompt_stream(text);
    const iv = setInterval(() => emit("streaming\n"), 5);
    setTimeout(() => proc.notePromptIngested(enqueued(text, { ingestedAtMs: 0 })), 30);
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * Adversarial pass, finding 2 (the other half) — an enqueue stamped before
   * this prompt was armed belongs to an earlier delivery.
   */
  it("refuses an enqueue stamped before the prompt was armed", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("stale-enqueue", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "deploy the other thing";

    const p = proc.send_prompt_stream(text);
    const iv = setInterval(() => emit("streaming\n"), 5);
    setTimeout(
      () => proc.notePromptIngested(enqueued(text, { ingestedAtMs: Date.now() - 60_000 })),
      30,
    );
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * Adversarial pass, finding 4 — a whitespace-only prompt normalises to the
   * empty string, which then matched ANY whitespace-only record in the
   * transcript. Nothing to compare on means nothing to confirm on.
   */
  it("does not arm on a prompt that normalises to nothing", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("blank", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();

    const p = proc.send_prompt_stream("   ");
    const iv = setInterval(() => emit("streaming\n"), 5);
    // A different whitespace-only record — normalises to "" just the same.
    setTimeout(
      () =>
        proc.notePromptIngested({
          text: "\t\n",
          source: "user",
          promptId: "pid-blank",
          ingestedAtMs: Date.now(),
        }),
      30,
    );
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * Second adversarial pass, finding 1 — the headline. The first cut booked the
   * queue entry only where an `enqueue` actually CONFIRMED a delivery, so an
   * enqueue seen while nothing was armed (the common case: it lands after the
   * confirm loop has already resolved) booked nothing. The CLI still had the
   * prompt queued and still wrote its `user` line later, which then confirmed
   * the next delivery of the same text — the original phantom, untouched.
   */
  it("counts an enqueue seen while unarmed, so its later user line cannot confirm the next delivery", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("unarmed-enqueue", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "heartbeat: any new messages?";

    // The CLI accepted a submission of this text while nothing was armed.
    proc.notePromptIngested(enqueued(text));

    // A later delivery of the same bytes. Its `user` line is the one owed to
    // the submission above, not evidence about this delivery.
    const p = proc.send_prompt_stream(text);
    const iv = setInterval(() => emit("streaming\n"), 5);
    setTimeout(
      () =>
        proc.notePromptIngested({
          text,
          source: "user",
          promptId: "pid-of-the-queued-one",
          ingestedAtMs: Date.now(),
        }),
      30,
    );
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * Second adversarial pass, finding 1, second shape — a refused enqueue must
   * still be counted. Refusing an unusable timestamp is a statement about which
   * DELIVERY the record belongs to; it says nothing about whether the CLI
   * queued the prompt. Skipping the booking made that guard manufacture the
   * phantom it exists to prevent.
   */
  it("counts an enqueue even when its timestamp makes it unusable as a confirmation", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("refused-enqueue", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "run the nightly sync";

    // Delivery #1: the enqueue is refused as a confirmation (no usable stamp),
    // but the prompt IS queued.
    const first = proc.send_prompt_stream(text);
    const iv1 = setInterval(() => emit("streaming\n"), 5);
    setTimeout(() => proc.notePromptIngested(enqueued(text, { ingestedAtMs: 0 })), 25);
    await first;
    clearInterval(iv1);

    // Delivery #2, same bytes. Delivery #1's `user` line must not confirm it.
    const before = writes.length;
    const second = proc.send_prompt_stream(text);
    const iv2 = setInterval(() => emit("streaming\n"), 5);
    setTimeout(
      () =>
        proc.notePromptIngested({
          text,
          source: "user",
          promptId: "pid-of-first",
          ingestedAtMs: Date.now(),
        }),
      30,
    );
    await second;
    clearInterval(iv2);

    expect(writes.slice(before)).toContain("\x15");
  });

  /**
   * A `dequeue` record is NOT a cancellation, and nothing here treats it as one.
   *
   * Two rounds of review built a withdrawal path on the opposite reading. The
   * repo's own fixtures settle it: in
   * `docs/spikes/fixtures/jsonl/01-headless-text-only.jsonl` the `dequeue`
   * fires 1 ms after the `enqueue` and 2 s before the `user` line, in a normal
   * successful delivery — the queue handing the prompt to the runner. It also
   * carries no `content`. The tests that covered the withdrawal synthesised a
   * record the CLI does not write, and the code they covered would have
   * un-confirmed every delivery the day the CLI started writing it.
   */

  /**
   * Second adversarial pass, fix 2 — `NaN` fails every comparison it appears
   * in, so a bare `< armed` test let it through, and a stamp in the future
   * passed both bounds while also poisoning the dedupe key built from it.
   */
  it("refuses an enqueue whose timestamp is not a usable instant", async () => {
    for (const stamp of [Number.NaN, Date.parse("2099-01-01T00:00:00.000Z")]) {
      const { handle, writes, emit } = bootPty();
      const proc = new PtyAgentProcess(`bad-stamp-${stamp}`, handle, {
        submitConfirmMs: 20,
        maxSubmitNudges: 2,
        transcriptGraceMs: 60,
      });
      proc.enableTranscriptConfirmation();
      const text = "deploy with a broken clock";

      const p = proc.send_prompt_stream(text);
      const iv = setInterval(() => emit("streaming\n"), 5);
      setTimeout(() => proc.notePromptIngested(enqueued(text, { ingestedAtMs: stamp })), 30);
      await p;
      clearInterval(iv);

      expect(writes).toContain("\x15");
    }
  });

  /**
   * Second adversarial pass — the enqueue identity key had no test at all:
   * reverting it to `null` left the whole suite green. It is load-bearing
   * because the queue count is a ledger: the same enqueue record presented
   * twice must not book two outstanding submissions, or the second one absorbs
   * a legitimate confirmation later.
   */
  it("counts a repeated enqueue record once, not twice", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("dup-enqueue", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "a prompt whose enqueue is read twice";

    // The identical record, twice — same text, same stamp, so same identity.
    const stamped = enqueued(text, { ingestedAtMs: Date.now() });
    proc.notePromptIngested({ ...stamped });
    proc.notePromptIngested({ ...stamped });

    // One outstanding submission, so one `user` line pays it off. The delivery
    // below must then be confirmed by its OWN record, not starved by a phantom
    // second entry.
    proc.notePromptIngested({
      text,
      source: "user",
      promptId: "pid-the-queued-one",
      ingestedAtMs: Date.now(),
    });

    const p = proc.send_prompt_stream(text);
    const iv = setInterval(() => emit("streaming\n"), 5);
    setTimeout(
      () =>
        proc.notePromptIngested({
          text,
          source: "user",
          promptId: "pid-this-delivery",
          ingestedAtMs: Date.now(),
        }),
      30,
    );
    await p;
    clearInterval(iv);

    expect(writes).not.toContain("\x15");
  });

  it("consumes an id seen while unarmed, so it cannot confirm a later delivery", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("unarmed", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 2,
      transcriptGraceMs: 60,
    });
    proc.enableTranscriptConfirmation();
    const text = "heartbeat: any new messages?";
    const pid = "pid-late";

    // Nothing armed: the tail hands over a record between deliveries.
    proc.notePromptIngested({ text, source: "user", promptId: pid, ingestedAtMs: Date.now() });

    const p = proc.send_prompt_stream(text);
    const iv = setInterval(() => emit("repaint noise\n"), 5);
    // The same record arrives again mid-delivery. Already consumed.
    setTimeout(
      () =>
        proc.notePromptIngested({ text, source: "user", promptId: pid, ingestedAtMs: Date.now() }),
      30,
    );
    await p;
    clearInterval(iv);

    expect(writes).toContain("\x15");
  });

  /**
   * The claim clock must restart when the screen stops claiming. Otherwise a
   * repaint window before a compaction spends the whole grace, and the
   * post-compaction turn gets none of it.
   */
  it("restarts the grace after the screen withdraws its claim", async () => {
    const { handle, writes, emit } = bootPty();
    const proc = new PtyAgentProcess("reset", handle, {
      submitConfirmMs: 20,
      maxSubmitNudges: 4,
      transcriptGraceMs: 150,
    });
    proc.enableTranscriptConfirmation();

    const p = proc.send_prompt_stream("do the thing");
    // Claim, then withdraw it (idle footer), then a real turn whose transcript
    // record lands shortly after it starts.
    emit("a repaint with no footer\n");
    await sleep(60);
    const idle = setInterval(() => emit("\n> accept edits on (shift+tab to cycle)"), 5);
    await sleep(60);
    clearInterval(idle);
    const turn = setInterval(() => emit("the real turn is streaming\n"), 5);
    setTimeout(() => proc.notePromptIngested(enqueued("do the thing")), 60);
    await p;
    clearInterval(turn);

    expect(writes).not.toContain("\x15");
  });
});
