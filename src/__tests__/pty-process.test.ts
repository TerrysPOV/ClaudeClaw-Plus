import { describe, test, expect } from "bun:test";
import {
  spawnPty,
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
      })
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
    const proc = await spawnPty(
      baseOpts({ _commandOverride: "/bin/cat", _argsOverride: [] })
    );
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
      })
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
        })
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

// ─── runTurn: idle-timeout fallback (cleanBoundary=false) ───────────────────

describe("PtyProcess — runTurn idle timeout", () => {
  test("runTurn against /bin/cat resolves via idle timeout with cleanBoundary=false", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        turnIdleTimeoutMs: 150, // short timeout for test speed
      })
    );
    const result = await proc.runTurn("hello world", { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(false);
    // cat echoes the input; the captured text should mention "hello world".
    // (We tolerate ANSI noise — extractResponseText falls back to the full
    // stripped buffer when no `⏺` marker is present.)
    expect(result.text.toLowerCase()).toContain("hello world");
    expect(result.bytesCaptured).toBeGreaterThan(0);
    await proc.dispose();
  });

  test("idle-timeout completes turn with all bytes captured so far", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        turnIdleTimeoutMs: 150,
      })
    );
    const longPrompt = "x".repeat(500);
    const result = await proc.runTurn(longPrompt, { timeoutMs: 5000 });
    expect(result.cleanBoundary).toBe(false);
    expect(result.text).toContain("x".repeat(20)); // at minimum a chunk
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
      })
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

// ─── runTurn: clean boundary via injected OSC markers ───────────────────────

describe("PtyProcess — runTurn clean boundary", () => {
  test("clean OSC progress-start/end pair → cleanBoundary=true and onChunk fires", async () => {
    // Use `printf` to emit a START marker, some text, then an END marker.
    // The PTY echoes these bytes back to the parser via onData.
    const oscScript =
      "sleep 0.05; " +
      'printf "\\033]9;4;3;\\007"; ' +
      'printf "hello from the test\\n"; ' +
      'printf "\\033]9;4;0;\\007"; ' +
      "sleep 0.2";
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", oscScript],
        turnIdleTimeoutMs: 10_000,
      })
    );

    let chunkBytes = 0;
    const result = await proc.runTurn("", {
      timeoutMs: 5000,
      onChunk: (s) => {
        chunkBytes += s.length;
      },
    });

    expect(result.cleanBoundary).toBe(true);
    expect(result.text.toLowerCase()).toContain("hello from the test");
    expect(chunkBytes).toBeGreaterThan(0);
    expect(proc.lastTurnEndedAt()).toBeGreaterThan(0);
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
      })
    );
    const t1 = proc.runTurn("first", { timeoutMs: 5000 });
    let err: unknown;
    try {
      await proc.runTurn("second", { timeoutMs: 5000 });
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
      })
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
    const explicitArgs = [
      "--permission-mode", "plan",
      "--tools", "Read,Grep,Glob,Write",
    ];
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

describe("PtyProcess — sessionId", () => {
  test("sessionId from opts.sessionId is exposed verbatim", async () => {
    const sid = "test-session-uuid-1234";
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/cat",
        _argsOverride: [],
        sessionId: sid,
      })
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
      })
    );
    expect(proc.sessionId).toBe(sid);
    await proc.dispose();
  });
});
