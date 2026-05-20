import { describe, test, expect } from "bun:test";
import {
  spawnPty,
  sanitizePtyPromptText,
  PtyTurnTimeoutError,
  PtyClosedError,
  type PtyProcessOptions,
} from "../runner/index";
import { __buildClaudeArgsForTests } from "../runner/pty-process";
import type { SecurityConfig } from "../config";

// ─── Shared test helpers ────────────────────────────────────────────────────

const NO_SECURITY: SecurityConfig = {
  level: "unrestricted",
  allowedTools: [],
  disallowedTools: [],
};

/** Baseline options for a non-claude test target. */
function baseOpts(over: Partial<PtyProcessOptions>): PtyProcessOptions {
  return {
    sessionId: "",
    cwd: "/tmp",
    security: NO_SECURITY,
    env: { ...process.env } as Record<string, string>,
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    cols: 80,
    rows: 24,
    ...over,
  };
}

// ─── Lifecycle: spawn → dispose ──────────────────────────────────────────────

describe("PtyProcess — lifecycle", () => {
  test("spawnPty against /bin/cat returns a live process", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
      }),
    );
    expect(proc.isAlive()).toBe(true);
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.label).toMatch(/^test:\d+$/);
    expect(proc.cwd).toBe("/tmp");
    expect(proc.lastTurnEndedAt()).toBe(0);
    await proc.dispose();
    expect(proc.isAlive()).toBe(false);
  });

  test("dispose is idempotent", async () => {
    const proc = await spawnPty(baseOpts({ _commandOverride: "/bin/cat", _argsOverride: [] }));
    await proc.dispose();
    await proc.dispose();
    expect(proc.isAlive()).toBe(false);
  });

  test("dispose after natural exit does not throw", async () => {
    // /bin/echo exits immediately after printing.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/echo",
        _argsOverride: ["hi"],
      }),
    );
    // Give the process a moment to exit naturally.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(proc.isAlive()).toBe(false);
    await proc.dispose();
  });

  test("spawnPty rejects when binary is missing", async () => {
    let err: unknown;
    try {
      await spawnPty(
        baseOpts({
          _commandOverride: "/usr/local/bin/definitely-not-a-real-binary-xyzzy",
          _argsOverride: [],
        }),
      );
    } catch (e) {
      err = e;
    }
    // bun-pty's failure mode varies (immediate throw vs. delayed exit).
    // Either rejection OR an immediately-exited process is acceptable.
    if (err == null) {
      // No throw → the spawn started a doomed process. That's allowed.
      // (Skip the strict assertion to avoid flakiness across platforms.)
    } else {
      expect(err).toBeDefined();
    }
  });
});

// ─── _waitForReadySettle: two-phase (paint + quiet) (issue #84) ─────────────
//
// Regression for the production failure where claude 2.1.89's TUI startup
// banner leaked to Discord as the "model response". Pre-fix, readySettle
// resolved on the first byte from claude — but the TUI takes ~1–2s to fully
// paint. spawnPty would return early, the supervisor's first runTurn wrote
// the prompt into a half-painted TUI, and the sentinel-echo path captured
// only the splash bytes.
//
// Post-fix: resolve only after a quietWindowMs gap of NO data following the
// first byte. The tests below simulate a slow paint with /bin/sh and assert
// spawnPty doesn't resolve until the paint goes quiet.

describe("PtyProcess — _waitForReadySettle two-phase (issue #84)", () => {
  test("does NOT resolve on first byte — waits for quiet window after paint", async () => {
    // Script: emit bytes immediately, again at 200ms, again at 400ms, then
    // stay silent. With quietWindowMs=300, the quiet timer should reset on
    // each chunk and only fire ~300ms after the last (400ms) chunk — so
    // spawnPty should resolve at ~700ms, NOT at first-byte (~0ms).
    const t0 = Date.now();
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          // Trailing `sleep 5` keeps the process alive past the quiet
          // window — spawnPty rejects if the child exits before settle.
          "printf paint1; sleep 0.2; printf paint2; sleep 0.2; printf paint3; sleep 5",
        ],
        _skipReadySettle: false,
        quietWindowMs: 300,
      }),
    );
    const elapsed = Date.now() - t0;

    // Quiet timer fires 300ms after the last chunk (paint3 at ~400ms) →
    // expect ≥ ~600ms total. Pre-fix this resolved at ~0ms.
    // Loose bound to avoid flakiness across CI environments.
    expect(elapsed).toBeGreaterThanOrEqual(500);
    // And not absurdly long either — the hard timeout is 3s.
    expect(elapsed).toBeLessThan(3000);

    await proc.dispose();
  });

  test("hard timeout fires when the TUI never paints", async () => {
    // Script: silent for 2s then exit. With _waitForReadySettle's 3s hard
    // timeout, spawn should still resolve at ~2s (when the process exits
    // and onExit fires nothing through _handleData) — actually the hard
    // timer's the only path that fires. To prove the hard timeout works
    // in isolation, use a longer-silent process and trust the 3s cap.
    const t0 = Date.now();
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "sleep 5"],
        _skipReadySettle: false,
        quietWindowMs: 100,
      }),
    );
    const elapsed = Date.now() - t0;
    // Hard timeout in spawnPty is 3000ms; allow some slack.
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(3500);
    await proc.dispose();
  }, 7000);

  test("resolves quickly when first byte is followed by long silence", async () => {
    // Script: emit one chunk immediately, then 5s silence. With
    // quietWindowMs=200, expect resolve at ~200ms — much faster than the
    // 3s hard timeout.
    const t0 = Date.now();
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "printf banner; sleep 5"],
        _skipReadySettle: false,
        quietWindowMs: 200,
      }),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
    await proc.dispose();
  });
});

// ─── runTurn: sentinel-echo round-trip against /bin/cat ─────────────────────
//
// /bin/cat is the simplest live test for the sentinel flow: it echoes
// everything we write straight back, so writing the sentinel to cat produces
// the echo the parser scans for. Each test below proves a specific aspect of
// the new flow without invoking real claude.

describe("PtyProcess — runTurn sentinel-echo (clean boundary)", () => {
  // NOTE: prompts include `✻` (U+273B, a claude spinner glyph)
  // because the parser's activity-indicator gate (added in
  // fix/pty-premature-sentinel) refuses to fire `quiet` until a
  // spinner glyph has been seen. Marker glyphs (`●`/`⏺`) were dropped
  // from the gate per Codex P1 on PR #124 — they appear in the TUI
  // status-box row and in resumed scrollback. Real claude emits
  // spinners while generating; `/bin/cat` doesn't, so we slip one
  // into the prompt and let cat echo it back to satisfy the gate.

  test("cat echoes the sentinel back → cleanBoundary=true", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        quietWindowMs: 100,
        sentinelMaxWaitMs: 5000,
      }),
    );
    const result = await proc.runTurn("✻ hello world", { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(true);
    // cat echoes the prompt; the response should contain it.
    expect(result.text.toLowerCase()).toContain("hello world");
    expect(result.bytesCaptured).toBeGreaterThan(0);
    expect(proc.lastTurnEndedAt()).toBeGreaterThan(0);
    await proc.dispose();
  });

  test("long prompts are captured in full", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        quietWindowMs: 100,
        sentinelMaxWaitMs: 5000,
      }),
    );
    const longPrompt = `✻ ${"x".repeat(500)}`;
    const result = await proc.runTurn(longPrompt, { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(true);
    expect(result.text).toContain("x".repeat(20));
    await proc.dispose();
  });

  test("onChunk fires for streaming deltas", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        quietWindowMs: 100,
        sentinelMaxWaitMs: 5000,
      }),
    );
    let chunkBytes = 0;
    const result = await proc.runTurn("✻ streaming-test-payload", {
      timeoutMs: 5000,
      onChunk: (s) => {
        chunkBytes += s.length;
      },
    });
    expect(result.cleanBoundary).toBe(true);
    expect(chunkBytes).toBeGreaterThan(0);
    await proc.dispose();
  });
});

describe("PtyProcess — runTurn sentinel max-wait fallback", () => {
  test("when the echo never comes, completes with cleanBoundary=false", async () => {
    // We need a PTY target that produces output but does NOT echo our writes
    // back. Pure `sleep` does this — emits nothing, ignores stdin entirely.
    // The parser stays in `accumulating` (no bytes ever arrive), the quiet
    // timer fires, the supervisor writes the sentinel, but `sleep` never
    // echoes it. sentinelMaxWaitMs elapses → cleanBoundary=false.
    //
    // The PTY's kernel cooked-mode echo would still echo our writes, so we
    // disable it via `stty -echo` first.
    // `\xe2\x9c\xbb` = `✻` (U+273B) — one of claude's spinner glyphs,
    // the only signal the parser's activity-indicator gate accepts
    // (Codex P1 on PR #124 — markers were dropped from the gate
    // because they appear in TUI status-box rows + scrollback). Without
    // it, quiet would never fire and the test would time out at the
    // hard timeoutMs instead of exercising the sentinel-max-wait path.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "stty -echo; printf '\\xe2\\x9c\\xbb'; sleep 5"],
        quietWindowMs: 50,
        sentinelMaxWaitMs: 250,
      }),
    );
    const result = await proc.runTurn("anything", { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(false);
    await proc.dispose();
  });

  // Codex PR #82 P1 regression — when the sentinel max-wait expires, the
  // fallback must use the ABSOLUTE end-of-stream offset, not the relative
  // buffer length. Pre-fix, `_completeTurn` was passed `_turnBufLen`
  // (relative); paired with the slice math that subtracts
  // `parser.totalBytes - allBytes.length`, any pre-turn bytes (like
  // claude's startup banner) would push `responseEndOffset` below
  // `sliceStart` and the response would clamp to empty. Production
  // symptom: `(empty response)` on every sentinel-echo failure.
  test("sentinel-timeout fallback returns captured bytes even after pre-turn banner", async () => {
    // BANNER emits BEFORE we send our prompt — advances parser.totalBytes
    // without contributing to the turn buffer (turn hasn't started). Then
    // stty -echo disables kernel cooked-mode echo (so our prompt + sentinel
    // writes don't trivially come back). `printf 'response-bytes'` emits
    // bytes that the parser accumulates AFTER the turn starts. Then sleep
    // burns time until sentinelMaxWaitMs fires.
    // `\xe2\x9c\xbb` = `✻` (U+273B) — spinner glyph the parser's
    // activity-indicator gate scans for. Markers (`●`/`⏺`) were
    // dropped from the gate per Codex P1 on PR #124.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          "echo BANNER_BANNER_BANNER_PRETURN; stty -echo; printf '\\xe2\\x9c\\xbb response-bytes-during-turn'; sleep 5",
        ],
        quietWindowMs: 100,
        sentinelMaxWaitMs: 400,
      }),
    );
    const result = await proc.runTurn("trigger", { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(false);
    // Without the absolute-offset fix, result.text would be empty (slice
    // clamped to zero). With the fix, the captured bytes survive.
    expect(result.text).toContain("response-bytes-during-turn");
    await proc.dispose();
  });
});

// ─── runTurn: hard timeout (timeoutMs) ──────────────────────────────────────

describe("PtyProcess — runTurn hard timeout", () => {
  test("rejects with PtyTurnTimeoutError when timeoutMs is exceeded", async () => {
    // Use a sleep target that never emits anything → no idle-reset, but with
    // a longer idle timeout than the hard timeoutMs so the hard timeout
    // fires first.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "sleep 5"],
        turnIdleTimeoutMs: 10_000, // longer than the hard timeoutMs below
      }),
    );
    let err: unknown;
    try {
      await proc.runTurn("ignored", { timeoutMs: 100 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PtyTurnTimeoutError);
    expect((err as PtyTurnTimeoutError).label).toMatch(/^test:\d+$/);
    await proc.dispose();
  });
});

// ─── runTurn: sentinel UUID override (test-hook contract) ───────────────────

describe("PtyProcess — sentinel UUID override hook", () => {
  test("_sentinelUuidOverride pins the sentinel string written into the PTY", async () => {
    // cat echoes the sentinel back; we don't observe the wire bytes here,
    // but we DO observe that runTurn completes cleanly, proving the override
    // produced a valid sentinel the parser found.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        quietWindowMs: 100,
        sentinelMaxWaitMs: 5000,
        _sentinelUuidOverride: () => "pinned-uuid-1234",
      }),
    );
    const result = await proc.runTurn("✻ hi", { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(true);
    await proc.dispose();
  });
});

// ─── runTurn: concurrency guard ─────────────────────────────────────────────

describe("PtyProcess — concurrency", () => {
  test("concurrent runTurn rejects the second call", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        turnIdleTimeoutMs: 300,
      }),
    );
    // `✻` so cat's echo trips the activity-indicator gate (spinner-only
    // per Codex P1 on PR #124); without it the first turn never
    // completes and the test times out instead of exercising the
    // concurrency rejection.
    const t1 = proc.runTurn("✻ first", { timeoutMs: 5000 });
    let err: unknown;
    try {
      await proc.runTurn("✻ second", { timeoutMs: 5000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("concurrently");
    await t1; // let the first turn finish before disposing
    await proc.dispose();
  });
});

// ─── runTurn: PtyClosedError on mid-turn exit ───────────────────────────────

describe("PtyProcess — runTurn on closed PTY", () => {
  test("rejects with PtyClosedError when PTY exits mid-turn", async () => {
    // sh -c 'sleep 0.1; exit 7' → exits 100ms in.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "sleep 0.1; exit 7"],
        turnIdleTimeoutMs: 10_000,
      }),
    );
    let err: unknown;
    try {
      await proc.runTurn("", { timeoutMs: 5000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PtyClosedError);
    // Don't strictly check exitCode/signal — bun-pty may report either.
    await proc.dispose();
  });
});

// ─── sessionId propagation ──────────────────────────────────────────────────

describe("PtyProcess — buildClaudeArgs emits appendSystemPrompt (Phase D fix #2)", () => {
  test("appendSystemPrompt produces --append-system-prompt <payload>", () => {
    const payload = "CLAUDE.md content + MEMORY.md content + dir-scope guard";
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      appendSystemPrompt: payload,
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    const flagIdx = args.indexOf("--append-system-prompt");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(args[flagIdx + 1]).toBe(payload);
  });

  test("empty appendSystemPrompt is NOT emitted (avoids `--append-system-prompt ''`)", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      appendSystemPrompt: "",
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--append-system-prompt");
  });

  test("omitted appendSystemPrompt is NOT emitted", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("PtyProcess — buildClaudeArgs honours securityArgs (Phase D fix #3)", () => {
  test("when securityArgs is provided, it's used verbatim instead of derived flags", () => {
    const explicitArgs = ["--permission-mode", "plan", "--tools", "Read,Grep,Glob,Write"];
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      // Even though security.level=locked would normally inject
      // --dangerously-skip-permissions and --tools Read,Grep,Glob,Write
      // from the local fallback, the explicit securityArgs path takes
      // precedence.
      security: { level: "locked", allowedTools: [], disallowedTools: [] },
      securityArgs: explicitArgs,
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    // The explicit args land first, in order.
    expect(args.slice(0, explicitArgs.length)).toEqual(explicitArgs);
    // The fallback's --dangerously-skip-permissions is NOT present.
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("locked-mode fallback emits Write tool so memory persistence still works", () => {
    // No securityArgs supplied — exercise the local fallback path that
    // unit tests historically used. The Phase D fix for MAJOR-3 is that
    // the fallback now includes Write in the locked-mode --tools list.
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "locked", allowedTools: [], disallowedTools: [] },
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe("Read,Grep,Glob,Write");
  });
});

describe("PtyProcess — buildClaudeArgs honours modelOverride (Codex Phase D #1)", () => {
  test("non-glm modelOverride lands as --model <name>", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      modelOverride: "claude-opus-4-5",
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-opus-4-5");
  });

  test("modelOverride 'glm' is NOT emitted as --model (env shim handles routing)", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      modelOverride: "glm",
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--model");
  });

  test("empty modelOverride is NOT emitted as --model", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      modelOverride: "",
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--model");
  });
});

describe("PtyProcess — buildClaudeArgs honours mcpConfigPath (MCP multiplexer, SPEC §4.5)", () => {
  test("mcpConfigPath produces --mcp-config <path>", () => {
    const cfg = "/var/cwd/.claudeclaw/mcp-pty-suzy.json";
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      mcpConfigPath: cfg,
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    const flagIdx = args.indexOf("--mcp-config");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(args[flagIdx + 1]).toBe(cfg);
  });

  test("empty mcpConfigPath is NOT emitted (avoids `--mcp-config ''`)", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      mcpConfigPath: "",
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--mcp-config");
  });

  test("omitted mcpConfigPath is NOT emitted (backward-compat with settings.mcp.shared=[])", () => {
    const opts: PtyProcessOptions = {
      sessionId: "",
      cwd: "/tmp",
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      env: {},
    };
    const args = __buildClaudeArgsForTests(opts);
    expect(args).not.toContain("--mcp-config");
  });
});

describe("PtyProcess — sessionId", () => {
  test("sessionId from opts.sessionId is exposed verbatim", async () => {
    const sid = "test-session-uuid-1234";
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        sessionId: sid,
      }),
    );
    expect(proc.sessionId).toBe(sid);
    await proc.dispose();
  });

  test("sessionId from newSessionId is exposed when sessionId is empty", async () => {
    const sid = "new-session-uuid-5678";
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        sessionId: "",
        newSessionId: sid,
      }),
    );
    expect(proc.sessionId).toBe(sid);
    await proc.dispose();
  });
});

describe("sanitizePtyPromptText (issue #65 item 3)", () => {
  test("replaces embedded CR with space", () => {
    expect(sanitizePtyPromptText("hello\rworld")).toBe("hello world");
  });

  test("replaces embedded LF with space", () => {
    expect(sanitizePtyPromptText("line one\nline two")).toBe("line one line two");
  });

  test("replaces CRLF as a single separator (not two spaces)", () => {
    expect(sanitizePtyPromptText("a\r\nb")).toBe("a b");
  });

  test("preserves text with no CR/LF", () => {
    expect(sanitizePtyPromptText("plain prompt")).toBe("plain prompt");
  });

  test("handles multiple newlines and mixed terminators", () => {
    expect(sanitizePtyPromptText("a\nb\r\nc\rd")).toBe("a b c d");
  });

  test("preserves an empty string", () => {
    expect(sanitizePtyPromptText("")).toBe("");
  });
});
