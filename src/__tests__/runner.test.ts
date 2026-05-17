/**
 * Tests for runner.ts modelOverride wiring (Phase 18 Plan 01).
 *
 * Strategy: spy on runClaudeOnce to intercept model arg, throw sentinel
 * to short-circuit downstream side effects. Use isolated tmp cwd to
 * contain any session/log writes.
 *
 * Run with: bun test src/__tests__/runner.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn, test } from "bun:test";
import * as runnerMod from "../runner";
import * as configMod from "../config";
import { loadSettings, getSettings } from "../config";

const SENTINEL = "RUNNER_TEST_SENTINEL";

let runOnceSpy: ReturnType<typeof spyOn> | null = null;
const capturedModels: string[] = [];

beforeAll(async () => {
  await loadSettings();
});

beforeEach(() => {
  capturedModels.length = 0;
  runOnceSpy = spyOn(runnerMod, "runClaudeOnce").mockImplementation((async (
    _args: string[],
    model: string,
  ) => {
    capturedModels.push(model);
    throw new Error(SENTINEL);
  }) as any);
});

afterEach(() => {
  runOnceSpy?.mockRestore();
  runOnceSpy = null;
});

async function tryRun(opts?: { modelOverride?: string }): Promise<void> {
  try {
    await runnerMod.run("test-job", "hello world", undefined, opts);
  } catch (e) {
    if ((e as Error).message !== SENTINEL && !(e as Error).message?.includes(SENTINEL)) {
      throw e;
    }
  }
}

describe("Phase 18: runner modelOverride wiring", () => {
  it("forwards modelOverride to runClaudeOnce as primaryConfig.model", async () => {
    await tryRun({ modelOverride: "opus" });
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    expect(capturedModels[0]).toBe("opus");
  });

  it("without options uses settings.model (back-compat)", async () => {
    const { model, agentic } = getSettings();
    await tryRun();
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    if (!agentic.enabled) {
      // Only assert exact match in non-agentic mode (otherwise router picks)
      expect(capturedModels[0]).toBe(model);
    }
  });

  it("modelOverride='glm' is forwarded as model='glm'", async () => {
    await tryRun({ modelOverride: "glm" });
    expect(capturedModels[0]).toBe("glm");
  });

  // Phase 18 Plan 03 Task 1: all supported model strings + agentic interaction
  test.each([
    "opus",
    "sonnet",
    "haiku",
    "glm",
  ])("forwards %s as primaryConfig.model via modelOverride", async (m) => {
    await tryRun({ modelOverride: m });
    expect(capturedModels.length).toBeGreaterThanOrEqual(1);
    expect(capturedModels[0]).toBe(m);
  });

  it("modelOverride wins when agentic.enabled=true (override branch precedes agentic)", async () => {
    const real = getSettings();
    const forcedAgentic = {
      ...real,
      agentic: {
        ...real.agentic,
        enabled: true,
        defaultMode: real.agentic?.defaultMode ?? "implementation",
        modes: real.agentic?.modes ?? [],
      },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedAgentic as any);
    try {
      await tryRun({ modelOverride: "opus" });
      expect(capturedModels[0]).toBe("opus");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  it("no modelOverride + agentic.enabled=false uses settings.model (regression sanity)", async () => {
    const real = getSettings();
    const forcedNonAgentic = {
      ...real,
      model: "sonnet",
      agentic: { ...real.agentic, enabled: false },
    };
    const settingsSpy = spyOn(configMod, "getSettings").mockReturnValue(forcedNonAgentic as any);
    try {
      await tryRun();
      expect(capturedModels[0]).toBe("sonnet");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  // fallbackConfig is derived from settings.fallback regardless of modelOverride.
  // This is verified by inspection of src/runner.ts execClaude: fallbackConfig
  // is built from `fallback?.model` after the override branch, never from
  // options.modelOverride. Documented here rather than asserted because the
  // runClaudeOnce spy only captures the primary model arg, not fallback.
});

// ─── withCleanProcessEnv (issue: bun-pty env leak) ───────────────────────────
//
// Regression cover for the production failure where `claude` 2.1.89's
// "Detected a custom API key" interactive gate leaked into Discord. Root
// cause: bun-pty's Rust wrapper does NOT call CommandBuilder::env_clear()
// before adding env pairs, so portable_pty MERGES the caller-supplied env
// with the parent process env at fork(). Sanitising the opts.env Record via
// cleanSpawnEnv() was not sufficient because the daemon's process.env still
// had ANTHROPIC_API_KEY (loaded from /etc/claudeclaw/.claudeclaw-env), which
// claude inherited at fork() time. withCleanProcessEnv strips the keys from
// process.env around the synchronous FFI call.
describe("withCleanProcessEnv", () => {
  const STRIP_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ] as const;

  function snapshot(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of STRIP_KEYS) out[k] = process.env[k];
    return out;
  }

  function restore(snap: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("removes strip-list keys from process.env while fn is running", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak-to-child";
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "true";

      const seen = runnerMod.withCleanProcessEnv(() => ({
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDECODE: process.env.CLAUDECODE,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      }));

      expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen.CLAUDECODE).toBeUndefined();
      expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(seen.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    } finally {
      restore(original);
    }
  });

  it("restores originals after fn returns", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-restore-me";
      process.env.CLAUDECODE = "1";

      runnerMod.withCleanProcessEnv(() => {
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-restore-me");
      expect(process.env.CLAUDECODE).toBe("1");
    } finally {
      restore(original);
    }
  });

  it("restores originals even when fn throws", () => {
    const original = snapshot();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-restore-on-throw";

      expect(() => {
        runnerMod.withCleanProcessEnv(() => {
          throw new Error("boom");
        });
      }).toThrow("boom");

      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-restore-on-throw");
    } finally {
      restore(original);
    }
  });

  it("leaves keys absent that were absent originally", () => {
    const original = snapshot();
    try {
      for (const k of STRIP_KEYS) delete process.env[k];

      runnerMod.withCleanProcessEnv(() => {
        for (const k of STRIP_KEYS) {
          expect(process.env[k]).toBeUndefined();
        }
      });

      for (const k of STRIP_KEYS) {
        expect(process.env[k]).toBeUndefined();
      }
    } finally {
      restore(original);
    }
  });

  it("returns fn's return value", () => {
    expect(runnerMod.withCleanProcessEnv(() => 42)).toBe(42);
    expect(runnerMod.withCleanProcessEnv(() => "hello")).toBe("hello");
  });

  // Hetzner-discovered regression: Bun's `delete process.env.X` only updates
  // the JS hash — libc `environ` retains the value. bun-pty's Rust wrapper
  // reads `environ` via `std::env::vars_os()` so its spawned child still
  // inherits the un-stripped value. withCleanProcessEnv MUST also call libc
  // unsetenv so the child fork sees a clean env.
  //
  // This test spawns a real bun-pty child running `/bin/sh -c env` and
  // verifies the strip-list keys do not appear in the child's environment
  // dump — proving the libc-level strip works end-to-end against the same
  // codepath that production uses.
  it("strips keys at the libc level so bun-pty children do not inherit them via fork+exec", async () => {
    const SECRET = "sk-ant-libc-regression-do-not-leak";
    const original = snapshot();
    // Codex P2 from PR #83 (issue #85): Bun's `process.env.X = "..."` does
    // NOT update libc `environ` (mirroring the documented `delete` behaviour
    // on `withCleanProcessEnv`). If we seeded via process.env, the var
    // would never be in environ to begin with — and the bun-pty child would
    // pass the assertion whether or not `libc.unsetenv` actually runs.
    //
    // Seed via libc `setenv` directly so the var genuinely lives in
    // environ, matching the production daemon's startup state (launcher
    // sources /home/claw/.claudeclaw-env via `set -a; source …; set +a`
    // before exec'ing bun — by the time bun starts, the var is in environ).
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Bun runtime import
    const { dlopen, FFIType } = (await import("bun:ffi")) as any;
    const libcCandidates =
      process.platform === "darwin"
        ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]
        : ["libc.so.6", "libc.so"];
    let libc: {
      setenv: (n: Buffer, v: Buffer, o: number) => number;
      unsetenv: (n: Buffer) => number;
    } | null = null;
    for (const candidate of libcCandidates) {
      try {
        const lib = dlopen(candidate, {
          setenv: {
            args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
            returns: FFIType.i32,
          },
          unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
        });
        libc = { setenv: lib.symbols.setenv, unsetenv: lib.symbols.unsetenv };
        break;
      } catch {}
    }
    if (!libc) {
      throw new Error(
        "libc dlopen failed in test setup — cannot seed environ via setenv to exercise the libc-unset codepath",
      );
    }
    // Snapshot the libc-level value BEFORE we mutate it, so the teardown
    // can restore it (or unset if absent). Bun's process.env reflects the
    // libc environ at startup, so this snapshot is accurate at test entry.
    const libcOriginalApiKey = original.ANTHROPIC_API_KEY;
    libc.setenv(Buffer.from("ANTHROPIC_API_KEY\0", "utf8"), Buffer.from(`${SECRET}\0`, "utf8"), 1);
    // Also reflect into JS hash so snapshot/restore see consistent state.
    process.env.ANTHROPIC_API_KEY = SECRET;

    try {
      const { spawn } = await import("bun-pty");

      const out = runnerMod.withCleanProcessEnv(() => {
        const p = spawn("/bin/sh", ["-c", "env"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          // Explicit env intentionally minimal — the leak would come via
          // bun-pty's parent-env merge, NOT this explicit map.
          env: { PATH: "/usr/bin:/bin" },
        });
        let buf = "";
        p.onData((d: string) => {
          buf += d;
        });
        return new Promise<string>((resolve) => {
          // The child exits after `env` prints; give it time to flush.
          setTimeout(() => {
            resolve(buf);
          }, 400);
        });
      });

      const dump = await out;
      // The child must not have seen ANTHROPIC_API_KEY at all.
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toMatch(/(^|\n)ANTHROPIC_API_KEY=/);
    } finally {
      // Codex P2 follow-up: we mutated libc environ via setenv, so the JS-
      // side `restore(original)` is not enough — without libc cleanup the
      // seeded key would persist in environ and contaminate later fork+exec
      // tests with order-dependent failures. Restore (or unset) libc first,
      // then sync the JS hash.
      if (libcOriginalApiKey !== undefined) {
        libc.setenv(
          Buffer.from("ANTHROPIC_API_KEY\0", "utf8"),
          Buffer.from(`${libcOriginalApiKey}\0`, "utf8"),
          1,
        );
      } else {
        libc.unsetenv(Buffer.from("ANTHROPIC_API_KEY\0", "utf8"));
      }
      restore(original);
    }
  }, 5000);
});

// ─── shouldStripSpawnEnvKey (long-lived OAuth token exception) ──────────────
//
// Regression cover for the Hetzner activation flow. The original strip list
// removed CLAUDE_CODE_OAUTH_TOKEN unconditionally to prevent short-lived
// OAuth tokens (which expire ~daily and have no refresh path in PTY-mode
// claudes) from being silently inherited by long-running PTY processes.
// Long-lived `sk-ant-oat01-*` tokens minted via `claude setup-token` have a
// 1-year hard expiry and a different leak profile — operators wire them
// intentionally and want them to flow through to spawned claudes. This
// helper carves out that single exception while leaving every other strip
// (ANTHROPIC_API_KEY, CLAUDECODE, etc.) unconditional.
describe("shouldStripSpawnEnvKey (long-lived OAuth exception)", () => {
  it("keeps sk-ant-oat01-* OAuth tokens (returns false)", () => {
    expect(
      runnerMod.shouldStripSpawnEnvKey(
        "CLAUDE_CODE_OAUTH_TOKEN",
        "sk-ant-oat01-abc123_realistic-token-shape",
      ),
    ).toBe(false);
  });

  it("strips short-lived (non-oat01) OAuth tokens", () => {
    expect(runnerMod.shouldStripSpawnEnvKey("CLAUDE_CODE_OAUTH_TOKEN", "some-session-oauth")).toBe(
      true,
    );
    expect(
      runnerMod.shouldStripSpawnEnvKey("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-something-else"),
    ).toBe(true);
  });

  it("strips ANTHROPIC_API_KEY even if it happens to look oat01-ish", () => {
    expect(
      runnerMod.shouldStripSpawnEnvKey("ANTHROPIC_API_KEY", "sk-ant-oat01-not-the-right-key"),
    ).toBe(true);
  });

  it("strips other strip-list keys unconditionally", () => {
    expect(runnerMod.shouldStripSpawnEnvKey("CLAUDECODE", "1")).toBe(true);
    expect(runnerMod.shouldStripSpawnEnvKey("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "true")).toBe(
      true,
    );
  });

  it("strips when value is undefined or empty (no false-positive keep)", () => {
    expect(runnerMod.shouldStripSpawnEnvKey("CLAUDE_CODE_OAUTH_TOKEN", undefined)).toBe(true);
    expect(runnerMod.shouldStripSpawnEnvKey("CLAUDE_CODE_OAUTH_TOKEN", "")).toBe(true);
  });
});

describe("cleanSpawnEnv (oat01 exception wiring)", () => {
  function withTempEnv<T>(seed: Record<string, string | undefined>, fn: () => T): T {
    const snapshot: Record<string, string | undefined> = {};
    for (const k of Object.keys(seed)) snapshot[k] = process.env[k];
    for (const [k, v] of Object.entries(seed)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(snapshot)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("keeps long-lived CLAUDE_CODE_OAUTH_TOKEN in the output env", () => {
    withTempEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-long-lived",
        ANTHROPIC_API_KEY: "sk-ant-api03-should-still-strip",
        CLAUDECODE: "1",
      },
      () => {
        const out = runnerMod.cleanSpawnEnv();
        expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test-long-lived");
        expect(out.ANTHROPIC_API_KEY).toBeUndefined();
        expect(out.CLAUDECODE).toBeUndefined();
      },
    );
  });

  it("strips CLAUDE_CODE_OAUTH_TOKEN when not in oat01 shape", () => {
    withTempEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: "ephemeral-session-token",
      },
      () => {
        const out = runnerMod.cleanSpawnEnv();
        expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      },
    );
  });
});

describe("withCleanProcessEnv (oat01 exception wiring)", () => {
  const STRIP_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ] as const;

  function snap(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of STRIP_KEYS) out[k] = process.env[k];
    return out;
  }

  function rest(s: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(s)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("leaves sk-ant-oat01-* OAuth tokens visible to fn (does not strip)", () => {
    const original = snap();
    try {
      const LONG_LIVED = "sk-ant-oat01-keep-me-visible";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = LONG_LIVED;
      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-still-stripped";
      const seen = runnerMod.withCleanProcessEnv(() => ({
        oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        api: process.env.ANTHROPIC_API_KEY,
      }));
      expect(seen.oauth).toBe(LONG_LIVED);
      expect(seen.api).toBeUndefined();
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(LONG_LIVED);
    } finally {
      rest(original);
    }
  });

  it("still strips short-lived (non-oat01) OAuth tokens", () => {
    const original = snap();
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "session-style-token";
      runnerMod.withCleanProcessEnv(() => {
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      });
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("session-style-token");
    } finally {
      rest(original);
    }
  });
});
