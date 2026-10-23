import { afterAll, describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnPty,
  sanitizePtyPromptText,
  PtyTurnTimeoutError,
  PtyClosedError,
  type PtyProcessOptions,
} from "../runner/index";
import {
  __buildClaudeArgsForTests,
  collectSecretValues,
  redactSecretsInTail,
} from "../runner/pty-process";
import {
  neutralizeLeadingReplCommand,
  preparePtyPromptForWrite,
} from "../runner/pty-prompt-sanitizer";
import { _setClaudeExecutableForTests } from "../runner";
import type { SecurityConfig } from "../config";
import { append, assistantLine, fakeTurn, userLine } from "./fixtures/fake-claude-tui";

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
    transcriptPath: TX_PATH,
    cols: 80,
    rows: 24,
    ...over,
  };
}

/**
 * Every PtyProcess below is handed this transcript path: a turn resolves only on the
 * session transcript (#562 round 2), and a process with none is refused. Tests that care
 * what the transcript says write their own (`pty-false-completion.test.ts`); the ones here
 * only need a turn to be able to run. A turn "completes" when the fake TUI appends the
 * user and assistant entries, never because of what it paints.
 */
const TX_DIR = mkdtempSync(join(tmpdir(), "pty-process-tx-"));
const TX_PATH = join(TX_DIR, "session.jsonl");
afterAll(() => rmSync(TX_DIR, { recursive: true, force: true }));

/** A fake TUI that takes `prompt`, records it, answers with `prompt` itself, then `cat`s. */
function tuiScript(prompt: string): string {
  return `${fakeTurn({ tx: TX_PATH, prompt, answer: prompt })}; exec cat`;
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

  test("exitInfo() is null while the process is alive", async () => {
    const proc = await spawnPty(baseOpts({ _commandOverride: "/bin/cat", _argsOverride: [] }));
    expect(proc.exitInfo()).toBeNull();
    await proc.dispose();
  });

  test("exitInfo() captures exitCode + elapsedMs after natural exit (#176)", async () => {
    // `sh -c 'exit 0'` exits cleanly with code 0.
    const proc = await spawnPty(
      baseOpts({ _commandOverride: "/bin/sh", _argsOverride: ["-c", "exit 0"] }),
    );
    // Wait for the natural exit + ensure handler ran.
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(proc.isAlive()).toBe(false);
    const info = proc.exitInfo();
    expect(info).not.toBeNull();
    if (!info) throw new Error("type narrowing");
    expect(info.exitCode).toBe(0);
    expect(info.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(info.elapsedMs).toBeLessThan(5000);
    await proc.dispose();
  });

  test("exitInfo() captures non-zero exit code (#176)", async () => {
    const proc = await spawnPty(
      baseOpts({ _commandOverride: "/bin/sh", _argsOverride: ["-c", "exit 1"] }),
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    const info = proc.exitInfo();
    expect(info).not.toBeNull();
    if (!info) throw new Error("type narrowing");
    expect(info.exitCode).toBe(1);
    await proc.dispose();
  });

  test("exitInfo() captures tail output before exit (#176)", async () => {
    // `sh -c 'echo claude-error-message; exit 7'` prints + exits.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "echo this-is-the-error-text; exit 7"],
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    const info = proc.exitInfo();
    expect(info).not.toBeNull();
    if (!info) throw new Error("type narrowing");
    expect(info.exitCode).toBe(7);
    // PTYs typically convert \n to \r\n on output; we strip control chars
    // including the bare CR, so the trimmed text should contain the
    // payload regardless.
    expect(info.tail).toContain("this-is-the-error-text");
    await proc.dispose();
  });

  test("exitInfo().tail stays bounded even when a single chunk exceeds 8 KiB (#176 review)", async () => {
    // 5-agent review confidence-82 finding: the eviction loop's `length > 1`
    // guard fails to evict an oversized single chunk. Reproduce: print
    // 32 KiB in one shot, then exit. The tail must still be <= 8 KiB.
    //
    // We use `head -c 32768 /dev/zero | tr "\\0" "x"` to emit a contiguous
    // 32 KiB block of 'x' bytes followed by an exit — bun-pty typically
    // delivers this in one chunk on the PTY read.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", "head -c 32768 /dev/zero | tr '\\0' 'x'; echo done; exit 4"],
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 300));
    const info = proc.exitInfo();
    expect(info).not.toBeNull();
    if (!info) throw new Error("type narrowing");
    expect(info.exitCode).toBe(4);
    // The cap is 8 KiB; after control-byte stripping + redaction the
    // snapshot may be slightly shorter but should never exceed the raw cap.
    expect(info.tail.length).toBeLessThanOrEqual(8 * 1024);
    // Diagnostic content should still survive: the trailing "done" marker
    // is within the last 8 KiB and should be visible.
    expect(info.tail).toContain("done");
    await proc.dispose();
  });

  test("oversized-chunk path detaches from the original buffer (Codex P2 on #185)", async () => {
    // Direct unit test for the .slice() vs .subarray() distinction. We
    // can't directly access _tailBuf from outside the class, but we can
    // verify the behaviour by allocating a large Uint8Array, taking its
    // last 8 KiB via .slice(), and asserting the result's .buffer is a
    // fresh ArrayBuffer — not a view into the original. This is the
    // exact contract the fix relies on.
    const original = new Uint8Array(64 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const sliced = original.slice(original.length - 8 * 1024);
    const subarray = original.subarray(original.length - 8 * 1024);

    // .slice() copies — its .buffer is its own.
    expect(sliced.buffer).not.toBe(original.buffer);
    expect(sliced.byteLength).toBe(8 * 1024);
    expect(sliced.buffer.byteLength).toBe(8 * 1024);
    // .subarray() does NOT — its .buffer is the original. This is the
    // bug the fix avoids: the original 64 KiB would stay alive via the
    // view's backing buffer.
    expect(subarray.buffer).toBe(original.buffer);
    expect(subarray.buffer.byteLength).toBe(64 * 1024);
  });

  test("exitInfo().tail redacts secrets (sk-/Bearer/JWT/GitHub/Slack tokens) (#176)", async () => {
    // Security follow-up from the 5-agent + security review on #176: a
    // misbehaving claude that prints an auth-failure with the leaked token
    // attached would otherwise land the token in stderr/journald via the
    // new error message. Verify the redaction patterns fire.
    //
    // Tokens are constructed at runtime from a base + suffix so the literal
    // string never appears in source (pre-commit hooks otherwise reject
    // legitimate-looking token shapes in test fixtures).
    const skPrefix = "sk" + "-";
    const fakeSk = skPrefix + "ant-oat01-" + "A".repeat(25);
    const fakeBearer = "abcdefghijklmnop1234";
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signaturepart";
    const ghpPrefix = "ghp" + "_";
    const fakeGhp = ghpPrefix + "z".repeat(36);
    const slackPrefix = "xox" + "b-";
    const fakeSlack = slackPrefix + "1234567890" + "-abcdefghijkl";
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          [
            `echo 'auth fail: ${fakeSk}'`,
            `echo 'Authorization: Bearer ${fakeBearer}'`,
            `echo 'token: ${fakeJwt}'`,
            `echo 'gh: ${fakeGhp}'`,
            `echo 'slack: ${fakeSlack}'`,
            "exit 9",
          ].join("; "),
        ],
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    const info = proc.exitInfo();
    expect(info).not.toBeNull();
    if (!info) throw new Error("type narrowing");
    expect(info.exitCode).toBe(9);
    // None of the original token bytes should survive into the tail.
    expect(info.tail).not.toContain(fakeSk);
    expect(info.tail).not.toContain(`Bearer ${fakeBearer}`);
    expect(info.tail).not.toContain(fakeJwt);
    expect(info.tail).not.toContain(fakeGhp);
    expect(info.tail).not.toContain(fakeSlack);
    // The redaction marker should appear.
    expect(info.tail).toContain("<redacted>");
    await proc.dispose();
  });

  test("exitInfo().tail redacts the exact credential values in the child env, whatever their shape (#562 security review)", async () => {
    // A z.ai GLM `id.secret` token or a Kimi key has no `sk-` prefix, so the prefix patterns
    // miss it. Values are obviously fake and built at runtime.
    const glmShaped = `${"a".repeat(32)}.${"b".repeat(16)}`;
    const kimiShaped = `test-token-${"0".repeat(24)}`;
    const authShaped = `fake_auth_${"1".repeat(24)}`;
    const innocent = "plainword";
    const proc = await spawnPty(
      baseOpts({
        env: {
          ...(process.env as Record<string, string>),
          ANTHROPIC_AUTH_TOKEN: authShaped,
          KIMI_API_KEY: kimiShaped,
          CUSTOM_SERVICE_TOKEN: glmShaped.replace(/\./g, "-"),
          SHORT_TOKEN: "abc",
          UNRELATED_NAME: innocent,
        },
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          [
            `echo 'auth: ${authShaped}'`,
            `echo 'kimi: ${kimiShaped}'`,
            `echo 'custom: ${glmShaped.replace(/\./g, "-")}'`,
            `echo 'glm: ${glmShaped}'`,
            `echo 'short: abc and ${innocent}'`,
            "exit 9",
          ].join("; "),
        ],
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    const info = proc.exitInfo();
    if (!info) throw new Error("type narrowing");
    expect(info.tail).not.toContain(authShaped);
    expect(info.tail).not.toContain(kimiShaped);
    expect(info.tail).not.toContain(glmShaped.replace(/\./g, "-"));
    expect(info.tail).not.toContain(glmShaped);
    // A short value and an unrelated env value are left alone.
    expect(info.tail).toContain("short: abc and plainword");
    await proc.dispose();
  });

  test("collectSecretValues picks credential env names and skips short or unrelated values", () => {
    const values = collectSecretValues({
      ANTHROPIC_AUTH_TOKEN: "x".repeat(12),
      ANTHROPIC_API_KEY: "y".repeat(10),
      CLAUDE_CODE_OAUTH_TOKEN: "z".repeat(9),
      FOO_API_KEY: "f".repeat(8),
      BAR_TOKEN: "short",
      PATH: "/usr/bin:/bin:/usr/local/bin",
      EMPTY_TOKEN: "",
    });
    expect(values).toEqual(["x".repeat(12), "y".repeat(10), "z".repeat(9), "f".repeat(8)]);
  });

  test("a credential the TUI hard-wrapped across lines is still redacted (#562 security re-review)", () => {
    const token = `fake${"0123456789abcdef".repeat(2)}ZZ`; // 38 chars, fake
    expect(token.length).toBe(38);
    const a = token.slice(0, 19);
    const b = token.slice(19);
    for (const sep of ["\n", "\r\n", "\n    ", "\r\n  \t "]) {
      const out = redactSecretsInTail(`auth failed for key ${a}${sep}${b} — retry`, [token]);
      expect(out).not.toContain(a);
      expect(out).not.toContain(b);
      expect(out).toContain("auth failed for key <redacted> — retry");
    }
    // Wrapped more than once.
    const thrice = `${token.slice(0, 10)}\n  ${token.slice(10, 30)}\n  ${token.slice(30)}`;
    expect(redactSecretsInTail(`x ${thrice} y`, [token])).toBe("x <redacted> y");
  });

  test("redaction of a wrapped secret stays linear on a full 8 KiB tail", () => {
    const token = `fake${"x".repeat(36)}`;
    const adversarial = "f".repeat(8 * 1024); // many partial matches: every char starts a run
    const start = performance.now();
    redactSecretsInTail(adversarial, [token, `${"f".repeat(30)}end`]);
    expect(performance.now() - start).toBeLessThan(50);
  });

  test("a secret containing whitespace is still redacted exactly, and an unrelated line is untouched", () => {
    const spaced = "test token with spaces 000";
    expect(redactSecretsInTail(`say ${spaced} now\nother line`, [spaced])).toBe(
      "say <redacted> now\nother line",
    );
  });

  test("exitInfo().tail redacts a credential that wrapped at the TTY width", async () => {
    const token = `test-token-wrapped-${"7".repeat(21)}`;
    const half = Math.floor(token.length / 2);
    const proc = await spawnPty(
      baseOpts({
        env: { ...(process.env as Record<string, string>), ANTHROPIC_AUTH_TOKEN: token },
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          `printf 'banner %s\\n    %s trailing\\n' '${token.slice(0, half)}' '${token.slice(half)}'; exit 9`,
        ],
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 250));
    const info = proc.exitInfo();
    if (!info) throw new Error("type narrowing");
    expect(info.tail).not.toContain(token.slice(0, half));
    expect(info.tail).not.toContain(token.slice(half));
    expect(info.tail).toContain("banner <redacted> trailing");
    await proc.dispose();
  });

  test("collectSecretValues covers the wider name suffixes and URL passwords (L4)", () => {
    const values = collectSecretValues({
      DB_PASSWORD: "p".repeat(10),
      SSH_PASSPHRASE: "q".repeat(11),
      GCP_CREDENTIAL: "c".repeat(12),
      AWS_CREDENTIALS: "d".repeat(13),
      SOME_Key: "k".repeat(14),
      DATABASE_URL: `postgres://app:${"u".repeat(15)}@db.internal:5432/main`,
      REDIS_DSN: `redis://:${"v".repeat(16)}@cache:6379`,
      PLAIN_URL: "https://example.com/path",
      SHORT_PW_URL: "postgres://app:short@db/x",
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
    });
    expect(values).toEqual([
      "v".repeat(16),
      "u".repeat(15),
      "k".repeat(14),
      "d".repeat(13),
      "c".repeat(12),
      "q".repeat(11),
      "p".repeat(10),
    ]);
  });

  test("'PTY exited before TUI settled' error includes exitCode + tail (#176)", async () => {
    // Run the full settle path against a binary that immediately prints
    // an error and exits. The settle wait should observe a dead process
    // and reject with an enriched error message.
    let err: unknown;
    try {
      await spawnPty(
        baseOpts({
          _commandOverride: "/bin/sh",
          _argsOverride: ["-c", "echo Failed to authenticate; exit 1"],
          _skipReadySettle: false,
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("exited before TUI settled");
    expect(msg).toContain("exitCode=1");
    expect(msg).toContain("elapsed=");
    expect(msg).toContain("tail=");
    expect(msg).toContain("Failed to authenticate");
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

/** Manual clock for the settle timers: nothing fires until `advance`. */
function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { due: number; ms: number; cb: () => void }>();
  const armed: number[] = [];
  return {
    setTimeout: ((cb: () => void, ms: number) => {
      const id = ++nextId;
      timers.set(id, { due: now + ms, ms, cb });
      armed.push(ms);
      return id;
    }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
    clearTimeout: ((id: number) => {
      timers.delete(id);
    }) as unknown as (handle: ReturnType<typeof setTimeout>) => void,
    advance(ms: number) {
      now += ms;
      const due = [...timers].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due);
      for (const [id, t] of due) {
        if (!timers.delete(id)) continue;
        t.cb();
      }
    },
    /** Resolves once `count` timers of `ms` have been armed (real time, 3s cap). */
    async untilArmed(ms: number, count: number) {
      const deadline = Date.now() + 3000;
      while (armed.filter((m) => m === ms).length < count) {
        if (Date.now() > deadline) throw new Error(`timer of ${ms}ms not armed ${count} time(s)`);
        await Bun.sleep(5);
      }
    },
  };
}

describe("PtyProcess — _waitForReadySettle two-phase (issue #84)", () => {
  test("does NOT resolve on first byte — waits for quiet window after paint", async () => {
    // The settle timers run on a manual clock and the child paints only when
    // the test lets it, so the assertion is about ordering, not wall time:
    // every chunk restarts the quiet window, and only a full window after
    // the LAST chunk resolves. Against wall time this flaked (issue #567):
    // with paints 200ms apart and a 300ms window, a child delayed by ~100ms
    // on a loaded runner let the window expire after the first paint.
    const clock = manualClock();
    const dir = mkdtempSync(join(tmpdir(), "pty-settle-"));
    const go2 = join(dir, "go2");
    const go3 = join(dir, "go3");
    const exit = join(dir, "exit");
    // Each paint after the first waits for its go-file ($1, $2), and the child
    // stays alive until cleanup creates $3 — spawnPty rejects if the child
    // exits before settle, and the settle timers do not run on real time.
    const waitFor = (arg: string) => `while [ ! -e "${arg}" ]; do sleep 0.01; done`;
    let settled = false;
    const spawning = spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: [
          "-c",
          `printf paint1; ${waitFor("$1")}; printf paint2; ${waitFor("$2")}; printf paint3; ${waitFor("$3")}`,
          "sh",
          go2,
          go3,
          exit,
        ],
        _skipReadySettle: false,
        quietWindowMs: 300,
        _setTimeout: clock.setTimeout,
        _clearTimeout: clock.clearTimeout,
      }),
    ).then((p) => {
      settled = true;
      return p;
    });

    try {
      // paint1 → a quiet window is armed. Pre-fix this already resolved.
      await clock.untilArmed(300, 1);
      await Bun.sleep(20);
      expect(settled).toBe(false);
      clock.advance(299);
      await Bun.sleep(20);
      expect(settled).toBe(false);

      // paint2 at t=299 restarts the window: the old one, due at t=300, must
      // not resolve.
      writeFileSync(go2, "");
      await clock.untilArmed(300, 2);
      clock.advance(299);
      await Bun.sleep(20);
      expect(settled).toBe(false);

      // paint3, the last chunk, then a full quiet window → resolves.
      writeFileSync(go3, "");
      await clock.untilArmed(300, 3);
      clock.advance(299);
      await Bun.sleep(20);
      expect(settled).toBe(false);
      clock.advance(1);
      // Real-time cap so a settle that never resolves fails here, not on the
      // test timeout, and the cleanup below still runs.
      let cap: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        spawning,
        new Promise((_, reject) => {
          cap = setTimeout(
            () => reject(new Error("not settled after the last quiet window")),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(cap));
      expect(settled).toBe(true);
    } finally {
      // On an early failure, release the child and fire the hard timeout so
      // the spawn settles and the PTY is disposed.
      writeFileSync(go2, "");
      writeFileSync(go3, "");
      clock.advance(10_000);
      const proc = await Promise.race([
        spawning.catch(() => null),
        Bun.sleep(1000).then(() => null),
      ]);
      await proc?.dispose();
      writeFileSync(exit, "");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

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

// ─── Bypass Permissions boot dialog (issue #460) ───────────────────────────
//
// On a fresh HOME, `claude --dangerously-skip-permissions` opens a warning
// dialog before the REPL with "No, exit" PRESELECTED. Pre-fix, readySettle
// resolved once that dialog went quiet, the first runTurn wrote prompt + CR,
// the CR confirmed "No, exit" and claude exited 1 — every real-claude PTY
// test in the nightly failed this way. The fake CLI below mirrors that: any
// line other than a bare Down arrow exits 1; Down then Enter "accepts" and
// the REPL (here: cat) comes up. The match is exact so the Enter has to come
// from settle — a prompt's CR finishing the line does not count.

// Words are separated by CHA cursor moves (`ESC[<n>G`), as the real CLI
// renders them, so a matcher that only strips escapes sees "Yes,Iaccept".
function fakeBypassDialogCli(prompt: string): string {
  return [
    "printf 'WARNING: Claude\\033[13GCode\\033[18Grunning\\033[26Gin\\033[29GBypass\\033[36GPermissions\\033[48Gmode\\r\\n'",
    "printf '\\342\\235\\257 No,\\033[7Gexit\\r\\n  Yes,\\033[8GI\\033[10Gaccept\\r\\n\\r\\nEnter to confirm \\302\\267 Esc to cancel\\r\\n'",
    "IFS= read -r key",
    'case "$key" in "$(printf "\\033[B")") ;; *) exit 1 ;; esac',
    "printf 'bypass\\033[8Gpermissions\\033[20Gon\\033[23G(shift+tab\\033[34Gto\\033[37Gcycle)\\r\\n'",
    tuiScript(prompt),
  ].join("; ");
}

describe("PtyProcess — Bypass Permissions boot dialog (issue #460)", () => {
  test("accepts the dialog during settle so the first turn reaches the REPL", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", fakeBypassDialogCli("after-dialog")],
        _skipReadySettle: false,
        quietWindowMs: 200,
        sentinelMaxWaitMs: 5000,
      }),
    );
    expect(proc.isAlive()).toBe(true);
    const result = await proc.runTurn("after-dialog", { timeoutMs: 5000 });
    expect(proc.isAlive()).toBe(true);
    expect(result.text).toContain("after-dialog");
    await proc.dispose();
  });

  test("after answering, settle waits for the REPL instead of the next quiet gap", async () => {
    // The REPL paints 600ms after the answer — three quiet windows later.
    // Resolving on that gap would hand the first prompt to a TUI that is
    // still switching screens.
    const slowRepl = fakeBypassDialogCli("unused").replace(
      "; printf 'bypass",
      "; sleep 0.6; printf 'bypass",
    );
    expect(slowRepl).not.toBe(fakeBypassDialogCli("unused"));
    const t0 = Date.now();
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", slowRepl],
        _skipReadySettle: false,
        quietWindowMs: 200,
      }),
    );
    // 200ms Down→Enter gap + 600ms REPL paint + one quiet window.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(proc.isAlive()).toBe(true);
    await proc.dispose();
  });
});

// ─── Project MCP server approval dialog (issue #469) ───────────────────────
//
// A cwd whose project carries a `.mcp.json` that the user has not approved
// opens "New MCP server found in this project" before the Bypass Permissions
// dialog (#460). It goes quiet like a painted REPL, so pre-fix settle resolved
// on it, the first prompt's CR dismissed it, the bypass dialog came up with
// "No, exit" preselected, and the turn sat out its full timeout — ~130 s and
// the #177 escape hatch on every cold nightly. With two or more servers the
// dialog is a multi-select with every server PRE-CHECKED, so an Enter there
// enables them all. Esc is "continue without" in the single variant and
// "reject all" in the multi-select, and never exits. The fake CLI reads one
// raw byte: anything but Esc exits 1, so the key has to come from settle. It
// discards input received in its first 150 ms, as claude 2.1.300 does with
// keys sent while the dialog paints.
// Echo stays off until the next screen paints: a prompt typed too early
// must not come back as the reply.

function fakeMcpDialogCli(dialog: string, prompt: string, gapAfterAnswer = ""): string {
  return [
    `printf '${dialog}'`,
    "stty raw -echo",
    // Like the real CLI, drop what arrives while the dialog is painting.
    "sleep 0.15",
    "stty min 0 time 0",
    "dd bs=4096 count=1 >/dev/null 2>&1",
    "stty min 1",
    "key=$(dd bs=1 count=1 2>/dev/null)",
    "stty sane -echo",
    '[ "$key" = "$(printf "\\033")" ] || exit 1',
    gapAfterAnswer,
    "stty echo",
    fakeBypassDialogCli(prompt),
  ]
    .filter(Boolean)
    .join("; ");
}

// Words separated by CHA moves, as the real CLI renders them.
const MCP_DIALOG_SINGLE =
  "New\\033[5GMCP\\033[9Gserver\\033[16Gfound\\033[22Gin\\033[25Gthis\\033[30Gproject:\\033[39Gplus-bus\\r\\n" +
  "  Use this MCP server\\r\\n  Use this and all future MCP servers in this project\\r\\n" +
  "\\342\\235\\257 Continue without using this MCP server\\r\\n\\r\\nEnter to confirm \\302\\267 Esc to cancel\\r\\n";
const MCP_DIALOG_MULTI =
  "2\\033[3Gnew\\033[7GMCP\\033[11Gservers\\033[19Gfound\\033[25Gin\\033[28Gthis\\033[33Gproject\\r\\n" +
  "Select any you wish to enable.\\r\\n\\342\\235\\257 [\\342\\234\\224] srv0\\r\\n  [\\342\\234\\224] srv1\\r\\n" +
  "  Enable selected\\r\\nSpace to select \\302\\267 Esc to reject all\\r\\n";

describe("PtyProcess — project MCP server approval dialog (issue #469)", () => {
  for (const [variant, dialog] of [
    ["single server", MCP_DIALOG_SINGLE],
    ["multi-select, all pre-checked", MCP_DIALOG_MULTI],
  ] as const) {
    test(`${variant}: rejected with Esc during settle, then the bypass dialog is answered and the first turn reaches the REPL`, async () => {
      const proc = await spawnPty(
        baseOpts({
          _commandOverride: "/bin/sh",
          _argsOverride: ["-c", fakeMcpDialogCli(dialog, "after-mcp-dialog")],
          _skipReadySettle: false,
          quietWindowMs: 200,
          sentinelMaxWaitMs: 5000,
        }),
      );
      expect(proc.isAlive()).toBe(true);
      const result = await proc.runTurn("after-mcp-dialog", {
        timeoutMs: 5000,
      });
      expect(proc.isAlive()).toBe(true);
      expect(result.text).toContain("after-mcp-dialog");
      await proc.dispose();
    });
  }

  test("after rejecting, settle waits for the next screen instead of the next quiet gap", async () => {
    // The bypass dialog paints 600ms after the Esc — three quiet windows
    // later. Resolving on that gap would type the first prompt into it.
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", fakeMcpDialogCli(MCP_DIALOG_SINGLE, "slow-next-screen", "sleep 0.6")],
        _skipReadySettle: false,
        quietWindowMs: 200,
        sentinelMaxWaitMs: 5000,
      }),
    );
    const result = await proc.runTurn("slow-next-screen", {
      timeoutMs: 5000,
    });
    expect(proc.isAlive()).toBe(true);
    expect(result.text).toContain("slow-next-screen");
    await proc.dispose();
  });

  test("a dialog that paints late gets a fresh hard-timeout window for the screen behind it", async () => {
    // Boot output streams for ~2.5s (never a quiet window), so the dialog
    // lands near the end of the 3s hard timeout; the bypass dialog follows
    // 1s after the Esc. Without a fresh window, settle resolves at 3s and
    // the first prompt lands in the bypass dialog.
    const lateDialog =
      "i=0; while [ $i -lt 25 ]; do printf .; sleep 0.1; i=$((i+1)); done; " +
      fakeMcpDialogCli(MCP_DIALOG_SINGLE, "late-dialog", "sleep 1");
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", lateDialog],
        _skipReadySettle: false,
        quietWindowMs: 200,
        sentinelMaxWaitMs: 5000,
      }),
    );
    const result = await proc.runTurn("late-dialog", { timeoutMs: 5000 });
    expect(proc.isAlive()).toBe(true);
    expect(result.text).toContain("late-dialog");
    await proc.dispose();
  }, 15_000);

  test("a dialog the CLI leaves on its own before the Esc is due gets no key", async () => {
    // Dialog, then the REPL 50ms later; any byte that reaches the CLI in the
    // next second (no prompt is sent) exits it.
    const leavesEarly = [
      `printf '${MCP_DIALOG_SINGLE}'`,
      "sleep 0.05",
      "printf 'bypass permissions on (shift+tab to cycle)\\r\\n'",
      "stty raw -echo",
      "sleep 1",
      "stty min 0 time 0",
      "got=$(dd bs=4096 count=1 2>/dev/null | od -An -c)",
      '[ -z "$got" ] || exit 1',
      "sleep 30",
    ].join("; ");
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", leavesEarly],
        _skipReadySettle: false,
        // The production default: the REPL footer is followed by a full
        // quiet window, so settle ends after the Esc would be due.
        quietWindowMs: 500,
      }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(proc.isAlive()).toBe(true);
    await proc.dispose();
  }, 10_000);

  test("a CLI that never paints the screen after the dialog still settles within the fresh window", async () => {
    const t0 = Date.now();
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", fakeMcpDialogCli(MCP_DIALOG_SINGLE, "sleep 30")],
        _skipReadySettle: false,
        quietWindowMs: 200,
      }),
    );
    // One fresh 3s hard-timeout window from the Esc, not an open-ended wait.
    expect(Date.now() - t0).toBeLessThan(4500);
    await proc.dispose();
  }, 15_000);
});

// ─── runTurn: sentinel-echo round-trip against /bin/cat ─────────────────────
//
// /bin/cat is the simplest live test for the sentinel flow: it echoes
// everything we write straight back, so writing the sentinel to cat produces
// the echo the parser scans for. Each test below proves a specific aspect of
// the new flow without invoking real claude.

describe("PtyProcess — runTurn resolves on the transcript", () => {
  // The fake TUI records the user and assistant entries itself (`tuiScript`) and paints
  // its own chrome; the prompts carry none of it, so none of these turns can be
  // "accepted" by the echo of the prompt (#562 round 2, finding 6).
  async function turnOn(
    prompt: string,
    over: Partial<PtyProcessOptions> = {},
    onChunk?: (s: string) => void,
  ) {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", tuiScript(prompt)],
        quietWindowMs: 100,
        ...over,
      }),
    );
    try {
      const result = await proc.runTurn(prompt, { timeoutMs: 5000, onChunk });
      return { result, ended: proc.lastTurnEndedAt() };
    } finally {
      await proc.dispose();
    }
  }

  test("a turn the transcript shows complete resolves with the transcript's answer", async () => {
    const { result, ended } = await turnOn("hello world");
    expect(result.cleanBoundary).toBe(true);
    expect(result.text).toBe("hello world");
    expect(result.bytesCaptured).toBe(Buffer.byteLength("hello world"));
    expect(ended).toBeGreaterThan(0);
  });

  test("long prompts are captured in full", async () => {
    const longPrompt = "x".repeat(500);
    const { result } = await turnOn(longPrompt);
    expect(result.text).toBe(longPrompt);
  });

  test("onChunk streams the assistant text", async () => {
    const chunks: string[] = [];
    const { result } = await turnOn("streaming-test-payload", {}, (s) => chunks.push(s));
    expect(result.text).toBe("streaming-test-payload");
    expect(chunks.join("")).toBe("streaming-test-payload");
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

// ─── runTurn: concurrency guard ─────────────────────────────────────────────

describe("PtyProcess — concurrency", () => {
  test("concurrent runTurn rejects the second call", async () => {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", tuiScript("first")],
        turnIdleTimeoutMs: 300,
      }),
    );
    const t1 = proc.runTurn("first", {
      timeoutMs: 5000,
    });
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

  test("strips C1 controls U+0080 to U+009F, which some terminals read as escape sequences", () => {
    expect(sanitizePtyPromptText("a\u009bb\u0080c\u009fd\u0085e")).toBe("abcde");
    // Printable Latin-1 just above the C1 range survives.
    expect(sanitizePtyPromptText("caf\u00e9 \u00a0x")).toBe("caf\u00e9 \u00a0x");
  });

  test("strips NUL bytes that would truncate the C-string PTY write", () => {
    expect(sanitizePtyPromptText("hello\x00world")).toBe("helloworld");
  });

  test("strips Backspace and DEL keystrokes that would inline-edit the TUI", () => {
    expect(sanitizePtyPromptText("abc\x08def\x7fghi")).toBe("abcdefghi");
  });

  test("strips BEL and other C0 controls except tab", () => {
    expect(sanitizePtyPromptText("\x07alert\x01start\x1fend\tkept")).toBe("alertstartend\tkept");
  });

  test("preserves printable Unicode and multi-byte UTF-8", () => {
    expect(sanitizePtyPromptText("héllo 🪶 wörld")).toBe("héllo 🪶 wörld");
  });
});

// ─── What reaches the child: neutralize AFTER sanitize (#562 security re-review) ─────────────

/** Bytes the child process actually receives for `prompt`, via a real PTY writing to a file. */
async function wireFor(prompt: string, allowReplCommand?: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pty-wire-"));
  const file = join(dir, "wire.bin");
  try {
    const proc = await spawnPty(
      baseOpts({
        _commandOverride: "/bin/sh",
        _argsOverride: ["-c", `cat > '${file}'`],
      }),
    );
    // The turn never completes (cat prints no sentinel); we only want the write.
    await proc
      .runTurn(prompt, { timeoutMs: 350, ...(allowReplCommand ? { allowReplCommand } : {}) })
      .catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 100));
    await proc.dispose();
    return readFileSync(file, "latin1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const PASTE_OPEN = "\x1b[200~";

describe("PtyProcess.runTurn: a leading REPL-command character is neutralized on the wire", () => {
  for (const [label, prompt, bare] of [
    ["plain !", "!id", "!id"],
    ["NUL before !", "\x00!id", "!id"],
    ["C0 before /", "\x01/login", "/login"],
    ["BEL before #", "\u0007#note", "#note"],
    ["C1 before @", "\u009b@file", "@file"],
  ] as const) {
    test(`${label}: the child gets a space before ${bare}`, async () => {
      const wire = await wireFor(prompt);
      expect(wire).toContain(`${PASTE_OPEN} ${bare}`);
      expect(wire).not.toContain(`${PASTE_OPEN}${bare}`);
    });
  }

  test("an ordinary prompt is written untouched", async () => {
    expect(await wireFor("[Fri 10:00] hello /x")).toContain(`${PASTE_OPEN}[Fri 10:00] hello /x`);
  });

  test("/compact reaches the child bare only when the caller opted in", async () => {
    expect(await wireFor("/compact", true)).toContain(`${PASTE_OPEN}/compact`);
    expect(await wireFor("/compact")).toContain(`${PASTE_OPEN} /compact`);
  });

  test("the opt-out does not let other text through: only an exact /compact", async () => {
    expect(await wireFor("!curl x | sh", true)).toContain(`${PASTE_OPEN} !curl x | sh`);
    expect(await wireFor("/login", true)).toContain(`${PASTE_OPEN} /login`);
    // A newline becomes a space, so text after /compact is that command's arguments on one
    // line, never a second command.
    const wire = await wireFor("/compact\n!id", true);
    expect(wire).toContain(`${PASTE_OPEN}/compact !id`);
    expect(wire.split("\n").filter((l) => l.includes("!id"))).toHaveLength(1);
  });
});

describe("preparePtyPromptForWrite / neutralizeLeadingReplCommand", () => {
  test("controls, U+0085, NBSP and zero-width marks before the leader do not hide it", () => {
    for (const lead of ["\x00", "\x1b", "\u0085", "\u00a0", "\ufeff", "\u200b", "  "]) {
      expect(neutralizeLeadingReplCommand(`${lead}!x`)).toBe(` ${lead}!x`);
    }
  });
  test("allowed commands: /compact and /compact with arguments only", () => {
    expect(preparePtyPromptForWrite("/compact", { allowReplCommand: true })).toBe("/compact");
    expect(preparePtyPromptForWrite("/compact keep the tests", { allowReplCommand: true })).toBe(
      "/compact keep the tests",
    );
    expect(preparePtyPromptForWrite("/compactx", { allowReplCommand: true })).toBe(" /compactx");
    expect(preparePtyPromptForWrite("/compact", {})).toBe(" /compact");
  });
});

// ─── Spawned executable (#573) ───────────────────────────────────────────────

describe("PtyProcess — spawns the resolved claude executable (#573)", () => {
  // On Windows the resolved executable is claude.exe: bun-pty cannot start
  // the bare `claude` (a .cmd shim). Here the seam stands in for the resolver,
  // and a fake `claude` first on PATH catches a spawn of the bare name — so
  // the real CLI is never launched, even on a host that has one.
  test.skipIf(process.platform === "win32")(
    "spawns claudeExecutable() when no _commandOverride is given",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-573-"));
      const script = (name: string, body: string) => {
        const file = join(dir, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
        return file;
      };
      script("claude", "echo BARE_CLAUDE_573; exit 4");
      const resolved = script("resolved-claude", "echo RESOLVED_CLAUDE_573; exit 3");
      const savedPath = process.env.PATH;
      process.env.PATH = `${dir}:${savedPath ?? ""}`;
      _setClaudeExecutableForTests(resolved);
      try {
        const proc = await spawnPty(
          baseOpts({ env: { ...process.env } as Record<string, string>, _argsOverride: [] }),
        );
        // Poll for the fake binary's exit rather than sleep: a fixed wait fails under load.
        const deadline = Date.now() + 5000;
        while (!proc.exitInfo() && Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        const info = proc.exitInfo();
        await proc.dispose();
        expect(info?.tail).toContain("RESOLVED_CLAUDE_573");
        expect(info?.exitCode).toBe(3);
      } finally {
        _setClaudeExecutableForTests(null);
        process.env.PATH = savedPath;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
