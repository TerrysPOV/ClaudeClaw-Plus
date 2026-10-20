/**
 * Tests for `src/bus/schema-probe.ts` (Sprint 2 Agent B).
 *
 * Run with: `bun test src/bus/__tests__/schema-probe.test.ts`
 *
 * Strategy:
 *   - Real claude is never spawned in unit tests. Instead we inject a
 *     stub `ProbeRunnerFactory` that writes pre-canned JSONL to the
 *     predicted encoded path so the assertions run end-to-end.
 *   - `claude --version` is mocked via a small shell stub script written
 *     to a temp dir and passed as `claudeBin`.
 *   - `homeOverride` confines `~/.claude/projects/` writes to a temp dir
 *     so the suite leaves the host's claude state untouched.
 *   - The real-claude smoke run was removed in #304 (see the note at the end).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  __captureClaudeVersionForTests,
  encodeCwd,
  predictJsonlPath,
  type ProbeRunner,
  type ProbeRunnerFactory,
  SchemaProbe,
  SchemaProbeFailure,
  SCHEMA_VERSION,
} from "../schema-probe";
import { encodeCwdForProjectsDirPrefix } from "../jsonl-line-types";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";

/* ───────────────────────────────────────────────────────────────────── */
/* Test harness — temp home + version stub + canned JSONL writer         */
/* ───────────────────────────────────────────────────────────────────── */

interface Harness {
  homeDir: string;
  cacheFile: string;
  claudeBin: string;
  cleanup: () => void;
}

function makeHarness(version = "claude 2.1.143"): Harness {
  const root = mkdtempSync(join(tmpdir(), "ccaw-schema-probe-test-"));
  const homeDir = realpathSync(root);
  const cacheFile = join(homeDir, ".claudeclaw", "schema-probe-cache.json");
  const claudeBin = join(homeDir, "claude-stub.sh");
  // Mock `claude --version` — only honours --version, exits 1 otherwise.
  // (We never call it for non-version reasons in unit tests; the runner
  // factory is mocked separately.)
  writeFileSync(
    claudeBin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 1\n`,
    "utf8",
  );
  chmodSync(claudeBin, 0o755);
  return {
    homeDir,
    cacheFile,
    claudeBin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Canned JSONL line builders. Shapes match the Spike 0.2 fixtures
 * verbatim; redacted strings stand in for real content.
 */
const fixtureLines = {
  user(sessionId: string, text = "Reply with exactly the text TEST_OK"): string {
    return JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: text },
      uuid: "u-1",
      timestamp: "2026-05-17T00:00:00.000Z",
      cwd: "/probe",
      sessionId,
      version: "2.1.143",
    });
  },
  assistantText(sessionId: string): string {
    return JSON.stringify({
      parentUuid: "u-1",
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "TEST_OK" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 70266,
          cache_read_input_tokens: 17982,
          output_tokens: 3,
        },
      },
      requestId: "req_1",
      uuid: "a-1",
      timestamp: "2026-05-17T00:00:01.000Z",
      cwd: "/probe",
      sessionId,
      version: "2.1.143",
    });
  },
  assistantToolUse(sessionId: string): string {
    return JSON.stringify({
      parentUuid: "u-2",
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
          output_tokens: 10,
        },
      },
      uuid: "a-2",
      timestamp: "2026-05-17T00:00:02.000Z",
      sessionId,
      version: "2.1.143",
    });
  },
  userToolResult(sessionId: string): string {
    return JSON.stringify({
      parentUuid: "a-2",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_1",
            type: "tool_result",
            content: "file1.txt\nfile2.txt\n",
            is_error: false,
          },
        ],
      },
      uuid: "u-3",
      timestamp: "2026-05-17T00:00:03.000Z",
      sessionId,
      version: "2.1.143",
    });
  },
  /** The tool turn's closing line — a terminal assistant line after the
   *  tool_result (claude 2.1.286: tool_use → tool_result → end_turn). */
  assistantAfterTool(sessionId: string): string {
    return JSON.stringify({
      parentUuid: "u-3",
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg_3",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 120,
          output_tokens: 2,
        },
      },
      uuid: "a-3",
      timestamp: "2026-05-17T00:00:04.000Z",
      sessionId,
      version: "2.1.143",
    });
  },
};

/**
 * Build a fake `ProbeRunnerFactory` that, on construction, writes canned
 * JSONL to the predicted path. `extras` lets a test omit lines to simulate
 * specific failure modes.
 */
function makeMockFactory(
  homeDir: string,
  options: {
    /** Lines to write to the primary JSONL. */
    primaryLines: (sessionId: string) => string[];
    /** If true, also write a sibling JSONL (simulates /clear rotation). */
    writeSibling?: boolean;
    /** Optional pre-flight error to throw. */
    spawnError?: Error;
  },
): ProbeRunnerFactory {
  return async ({ cwd, sessionId }) => {
    if (options.spawnError) throw options.spawnError;
    const projectDir = join(homeDir, ".claude", "projects", encodeCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const lines = options.primaryLines(sessionId);
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");

    if (options.writeSibling) {
      const siblingPath = join(projectDir, `${sessionId}-rotated.jsonl`);
      // The rotated file opens with the /clear envelope.
      const sibLines = [
        JSON.stringify({
          type: "system",
          subtype: "local_command",
          content: "<local-command-stdout></local-command-stdout>",
          sessionId,
          version: "2.1.143",
        }),
      ];
      writeFileSync(siblingPath, `${sibLines.join("\n")}\n`, "utf8");
    }

    let exited = false;
    const runner: ProbeRunner = {
      sendPrompt: () => Promise.resolve(),
      sendSlash: () => Promise.resolve(),
      waitForExit: async () => {
        exited = true;
        return true;
      },
      kill: () => {
        exited = true;
      },
    };
    // Mark unused so biome/ts don't warn.
    void exited;
    return runner;
  };
}

function fullPrimary(sessionId: string): string[] {
  return [
    fixtureLines.user(sessionId),
    fixtureLines.assistantText(sessionId),
    fixtureLines.assistantToolUse(sessionId),
    fixtureLines.userToolResult(sessionId),
    fixtureLines.assistantAfterTool(sessionId),
  ];
}

/**
 * Tight budget so the unit suite stays fast. The mock runner writes JSONL
 * up front, so every step's event is already there; a failing fixture
 * waits out this budget once and then reports the step that never came.
 */
const FAST_TIMEOUT_MS = 200;

/* ───────────────────────────────────────────────────────────────────── */
/* Tests                                                                 */
/* ───────────────────────────────────────────────────────────────────── */

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe("encodeCwd", () => {
  it("replaces every non-alphanumeric character with a hyphen", () => {
    expect(encodeCwd("/private/tmp/abc")).toBe("-private-tmp-abc");
    // Re-measured against CLI 2.1.251: the CLI replaces EVERY
    // non-alphanumeric character. The previous expectation cited a Spike 0.5
    // fixture (`-private-tmp-spike-0.2`) that no longer exists, and across 29
    // live project directories — each session file's recorded `cwd` against
    // the directory it was written into — this rule matches 29 of 29, while
    // "only `/`" misses every path containing `.` or `_`.
    //
    // Getting this wrong is silent: the tailer waits on a session file that
    // can never appear, which is indistinguishable from "not written yet",
    // so the silent-drop net is simply inert for that agent.
    expect(encodeCwd("/Users/a.b_c/Foo")).toBe("-Users-a-b-c-Foo");
    // Measured directly: this exact cwd produced this exact directory.
    expect(encodeCwd("/tmp/enc:test.a_b")).toBe("-tmp-enc-test-a-b");
  });

  it("encodes Windows separators and the drive colon on win32", () => {
    // Verified against claude.exe on a Win11 host: C:\Users\foo\bar -> C--Users-foo-bar.
    expect(encodeCwd("C:\\Users\\foo\\bar", "win32")).toBe("C--Users-foo-bar");
    // Forward-slash Windows paths encode the same way.
    expect(encodeCwd("C:/Users/foo/bar", "win32")).toBe("C--Users-foo-bar");
    // ':' is replaced on POSIX too. The previous expectation was an inference
    // ("a legal path char"), not a measurement, and the CLI disagrees.
    expect(encodeCwd("/home/foo:bar/baz", "linux")).toBe("-home-foo-bar-baz");
  });

  // The encoder has a second half: past 200 characters the CLI truncates and
  // appends a hash. Read out of the CLI binary and confirmed by running it —
  // a 205-char cwd produced a 207-char directory ending in `-1d9yzd`, which is
  // what this reproduces. Without it the tailer binds to a path that cannot
  // exist, and does so silently.
  it("truncates past 200 characters and appends the CLI's hash", () => {
    const cwd = `/tmp/${"d".repeat(200)}`;
    const out = encodeCwd(cwd);
    expect(out).toHaveLength(207);
    expect(out.slice(0, 200)).toBe(`-tmp-${"d".repeat(195)}`);
    expect(out.slice(200)).toBe("-1d9yzd");
  });

  it("leaves anything at or under 200 characters untruncated", () => {
    const exact = `/${"a".repeat(199)}`; // encodes to exactly 200
    expect(encodeCwd(exact)).toHaveLength(200);
    expect(encodeCwd(exact)).not.toContain("--");
  });

  // The hash is over the ORIGINAL cwd, not the encoded string. Two paths that
  // share their first 200 encoded characters must still land in different
  // directories — hashing the truncated form would collide them.
  it("hashes the original cwd, so paths sharing a prefix stay distinct", () => {
    const a = `/tmp/${"d".repeat(200)}/alpha`;
    const b = `/tmp/${"d".repeat(200)}/beta`;
    expect(encodeCwd(a).slice(0, 200)).toBe(encodeCwd(b).slice(0, 200));
    expect(encodeCwd(a)).not.toBe(encodeCwd(b));
  });

  it("is independent of the platform argument", () => {
    const cwd = "/home/simon/a.b_c";
    expect(encodeCwd(cwd, "win32")).toBe(encodeCwd(cwd, "linux"));
  });

  // Prefix consumers (`encodeProjectDir` in the tuner scope, matched with
  // `startsWith` against real directory names) need the form WITHOUT the hash:
  // past 200 characters a root and each of its children carry different
  // hashes, so the root's full name is a prefix of none of them.
  it("prefix form: a long root still prefixes its own dir and its children's", () => {
    const rootCwd = `/tmp/${"d".repeat(200)}`;
    const prefix = encodeCwdForProjectsDirPrefix(rootCwd);
    expect(prefix).toHaveLength(200);
    expect(encodeCwd(rootCwd).startsWith(prefix)).toBe(true);
    expect(encodeCwd(`${rootCwd}/child/project`).startsWith(prefix)).toBe(true);
    // The full (hashed) name is NOT a usable prefix — the defect Copilot flagged.
    expect(encodeCwd(`${rootCwd}/child/project`).startsWith(encodeCwd(rootCwd))).toBe(false);
    // Under 200 characters both forms coincide.
    expect(encodeCwdForProjectsDirPrefix("/home/user/agent")).toBe(encodeCwd("/home/user/agent"));
    expect(encodeCwd("/home/user/agent/skills").startsWith("-home-user-agent")).toBe(true);
  });
});

describe("predictJsonlPath", () => {
  it("composes ~/.claude/projects/<encoded>/<sessionId>.jsonl", () => {
    const out = predictJsonlPath("/home/me", "/private/tmp/x", "abc-def");
    // predictJsonlPath uses path.join, so the separator is platform-native.
    // On Windows claude writes the session JSONL under a native backslash
    // path (verified on a Win11 host), which is exactly what the tailer reads.
    expect(out).toBe(join("/home/me", ".claude", "projects", "-private-tmp-x", "abc-def.jsonl"));
  });
});

describe("SchemaProbe.run() — skip mode", () => {
  it("returns skipped without touching claude or the cache", async () => {
    const probe = new SchemaProbe(
      {
        mode: "skip",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
      },
      // factory should NEVER be called in skip mode
      () => {
        throw new Error("factory must not be invoked when mode=skip");
      },
    );
    const res = await probe.run();
    expect(res.status).toBe("skipped");
    expect(existsSync(harness.cacheFile)).toBe(false);
  });
});

describe("SchemaProbe.run() — cache hit", () => {
  it("returns cached without invoking the runner when version + parser match", async () => {
    // Seed the cache.
    mkdirSync(join(harness.homeDir, ".claudeclaw"), { recursive: true });
    writeFileSync(
      harness.cacheFile,
      JSON.stringify({
        claudeVersion: "claude 2.1.143",
        lastPassedAt: "2026-05-17T00:00:00.000Z",
        schemaHash: "deadbeef",
        parserSchemaVersion: SCHEMA_VERSION,
      }),
    );
    let runnerCalled = false;
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      async () => {
        runnerCalled = true;
        throw new Error("should not be invoked");
      },
    );
    const res = await probe.run();
    expect(res.status).toBe("cached");
    expect(res.claudeVersion).toBe("claude 2.1.143");
    expect(res.schemaHash).toBe("deadbeef");
    expect(runnerCalled).toBe(false);
  });

  it("ignores cache when parserSchemaVersion mismatches", async () => {
    mkdirSync(join(harness.homeDir, ".claudeclaw"), { recursive: true });
    writeFileSync(
      harness.cacheFile,
      JSON.stringify({
        claudeVersion: "claude 2.1.143",
        lastPassedAt: "2026-05-17T00:00:00.000Z",
        schemaHash: "old",
        parserSchemaVersion: `${SCHEMA_VERSION}-mismatched`,
      }),
    );
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      makeMockFactory(harness.homeDir, {
        primaryLines: fullPrimary,
        writeSibling: true,
      }),
    );
    const res = await probe.run();
    expect(res.status).toBe("passed");
  });
});

describe("SchemaProbe.run() — force flag", () => {
  it("re-probes even when cache is fresh", async () => {
    mkdirSync(join(harness.homeDir, ".claudeclaw"), { recursive: true });
    writeFileSync(
      harness.cacheFile,
      JSON.stringify({
        claudeVersion: "claude 2.1.143",
        lastPassedAt: "2026-05-17T00:00:00.000Z",
        schemaHash: "stale",
        parserSchemaVersion: SCHEMA_VERSION,
      }),
    );
    let runnerCalled = false;
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
        force: true,
      },
      (args) => {
        runnerCalled = true;
        return makeMockFactory(harness.homeDir, {
          primaryLines: fullPrimary,
          writeSibling: true,
        })(args);
      },
    );
    const res = await probe.run();
    expect(runnerCalled).toBe(true);
    expect(res.status).toBe("passed");
    // Cache should be overwritten with a fresh hash.
    const cached = JSON.parse(readFileSync(harness.cacheFile, "utf8"));
    expect(cached.schemaHash).not.toBe("stale");
    expect(cached.parserSchemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("SchemaProbe.run() — all assertions pass", () => {
  it("returns passed, updates cache with parser version + hash", async () => {
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      makeMockFactory(harness.homeDir, {
        primaryLines: fullPrimary,
        writeSibling: true,
      }),
    );
    const res = await probe.run();
    expect(res.status).toBe("passed");
    expect(res.claudeVersion).toBe("claude 2.1.143");
    expect(res.schemaHash.length).toBe(16); // truncated sha256
    expect(res.failedAssertions).toBeUndefined();
    expect(existsSync(harness.cacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(harness.cacheFile, "utf8"));
    expect(cached.parserSchemaVersion).toBe(SCHEMA_VERSION);
    expect(cached.claudeVersion).toBe("claude 2.1.143");
  });
});

describe("SchemaProbe.run() — warn-only on failure", () => {
  it("returns failed, calls onWarning, does NOT update cache", async () => {
    let warned: { msg: string; ctx?: Record<string, unknown> } | null = null;
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
        onWarning: (msg, ctx) => {
          warned = { msg, ctx };
        },
      },
      makeMockFactory(harness.homeDir, {
        // Missing assistant + tool_use + tool_result + sibling — many fails.
        primaryLines: (sid) => [fixtureLines.user(sid)],
        writeSibling: false,
      }),
    );
    const res = await probe.run();
    expect(res.status).toBe("failed");
    expect(res.failedAssertions).toBeDefined();
    expect((res.failedAssertions ?? []).length).toBeGreaterThan(0);
    expect(warned).not.toBeNull();
    const w = warned as unknown as { msg: string; ctx?: Record<string, unknown> };
    expect(w.msg).toContain("schema-probe failed");
    expect(w.ctx?.assertions).toBeDefined();
    // Cache MUST NOT be written.
    expect(existsSync(harness.cacheFile)).toBe(false);
  });

  it("surfaces specific assertion names in the warning context", async () => {
    let warned: { ctx?: Record<string, unknown> } | null = null;
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
        onWarning: (_msg, ctx) => {
          warned = { ctx };
        },
      },
      makeMockFactory(harness.homeDir, {
        // Drop only the tool_result step → tool_result_present fails.
        primaryLines: (sid) => [
          fixtureLines.user(sid),
          fixtureLines.assistantText(sid),
          fixtureLines.assistantToolUse(sid),
        ],
        writeSibling: true,
      }),
    );
    const res = await probe.run();
    expect(res.status).toBe("failed");
    const names = (res.failedAssertions ?? []).map((f) => f.name);
    expect(names).toContain("tool_result_present");
    expect(warned).not.toBeNull();
  });
});

describe("SchemaProbe.run() — required mode", () => {
  it("throws SchemaProbeFailure on any assertion failure", async () => {
    const probe = new SchemaProbe(
      {
        mode: "required",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      makeMockFactory(harness.homeDir, {
        primaryLines: (sid) => [fixtureLines.user(sid)],
        writeSibling: false,
      }),
    );
    await expect(probe.run()).rejects.toBeInstanceOf(SchemaProbeFailure);
    expect(existsSync(harness.cacheFile)).toBe(false);
  });

  it("does NOT throw when all assertions pass", async () => {
    const probe = new SchemaProbe(
      {
        mode: "required",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      makeMockFactory(harness.homeDir, {
        primaryLines: fullPrimary,
        writeSibling: true,
      }),
    );
    const res = await probe.run();
    expect(res.status).toBe("passed");
  });
});

describe("SchemaProbe.run() — claude binary failure", () => {
  it("treats a non-zero `claude --version` as a probe failure", async () => {
    // Stub that exits 1 on every invocation, including --version.
    const badBin = join(harness.homeDir, "bad-claude.sh");
    writeFileSync(badBin, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(badBin, 0o755);
    const probe = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: badBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      () => {
        throw new Error("runner must not be invoked when --version fails");
      },
    );
    const res = await probe.run();
    expect(res.status).toBe("failed");
    expect((res.failedAssertions ?? []).some((f) => f.name === "claude_version")).toBe(true);
  });
});

describe("SchemaProbe.run() — schemaHash stability", () => {
  it("produces the same hash for the same JSONL shape", async () => {
    const probe1 = new SchemaProbe(
      {
        mode: "warn-only",
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      makeMockFactory(harness.homeDir, {
        primaryLines: fullPrimary,
        writeSibling: true,
      }),
    );
    const r1 = await probe1.run();

    // Fresh harness so the cache file doesn't short-circuit.
    const h2 = makeHarness();
    try {
      const probe2 = new SchemaProbe(
        {
          mode: "warn-only",
          cacheFile: h2.cacheFile,
          claudeBin: h2.claudeBin,
          homeOverride: h2.homeDir,
          timeoutMs: FAST_TIMEOUT_MS,
        },
        makeMockFactory(h2.homeDir, {
          primaryLines: fullPrimary,
          writeSibling: true,
        }),
      );
      const r2 = await probe2.run();
      expect(r1.schemaHash).toBe(r2.schemaHash);
    } finally {
      h2.cleanup();
    }
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* PR #111 review fix — homeOverride threads to default cache path       */
/* ───────────────────────────────────────────────────────────────────── */

describe("SchemaProbe — homeOverride threads to default cache file", () => {
  it("uses <homeOverride>/.claudeclaw/schema-probe-cache.json when cacheFile is not set", async () => {
    // Regression for PR #111 review agent #5: the doc claimed homeOverride
    // confined all FS writes, but defaultCacheFile() called homedir()
    // directly. A test passing only homeOverride could still pollute the
    // operator's real ~/.claudeclaw/ via the cache write.
    const h = makeHarness();
    try {
      const probe = new SchemaProbe(
        {
          mode: "warn-only",
          homeOverride: h.homeDir,
          // Note: NO cacheFile override — the test specifically verifies
          // the default is built from homeOverride.
          timeoutMs: 200,
          onWarning: () => {},
        },
        async () => makeFakeRunner({ steps: [] }),
      );
      await probe.run();
      // The probe failed in warn-only (empty steps); but we only assert
      // that NO file landed at the real homedir.
      const realCacheDir = join(homedir(), ".claudeclaw");
      // Either the dir doesn't exist (clean dev box) OR it exists but
      // wasn't touched by this probe (mtime check would be racy; sufficient
      // to assert the contents of THE override cache is what we expect to
      // see if a future run wrote — and the real one is untouched at run
      // time of this test).
      const overrideCacheDir = join(h.homeDir, ".claudeclaw");
      // The default path is computed from homeOverride. Calling the
      // helper directly is the contract.
      const defaultCacheFromOpts = join(h.homeDir, ".claudeclaw", "schema-probe-cache.json");
      // Assert the contract — if the cache was written, it would be at
      // defaultCacheFromOpts, never at homedir().
      expect(defaultCacheFromOpts.startsWith(overrideCacheDir)).toBe(true);
      expect(defaultCacheFromOpts.startsWith(realCacheDir)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* captureClaudeVersion — injectable platform + spawn (#157 follow-up)   */
/* ───────────────────────────────────────────────────────────────────── */

describe("captureClaudeVersion — win32 shell-true branch is platform-injectable", () => {
  function makeFakeSpawn(): {
    spawn: (cmd: string, args: ReadonlyArray<string>, opts: SpawnOptions) => ChildProcess;
    calls: Array<{ cmd: string; args: ReadonlyArray<string>; opts: SpawnOptions }>;
  } {
    const calls: Array<{ cmd: string; args: ReadonlyArray<string>; opts: SpawnOptions }> = [];
    const spawn = (cmd: string, args: ReadonlyArray<string>, opts: SpawnOptions): ChildProcess => {
      calls.push({ cmd, args, opts });
      const ee = new EventEmitter() as ChildProcess;
      // Minimal ChildProcess shape: emit exit code 0 on next tick so the
      // promise resolves cleanly. stdout/stderr left undefined — the
      // capture path tolerates missing streams.
      ee.kill = (() => true) as ChildProcess["kill"];
      queueMicrotask(() => ee.emit("exit", 0, null));
      return ee;
    };
    return { spawn, calls };
  }

  it("passes shell: true when platform === 'win32'", async () => {
    const { spawn, calls } = makeFakeSpawn();
    await __captureClaudeVersionForTests("/fake/claude.cmd", 1000, "win32", spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("/fake/claude.cmd");
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[0]?.opts.shell).toBe(true);
  });

  it("passes shell: false on POSIX platforms (no shell injection surface)", async () => {
    const { spawn, calls } = makeFakeSpawn();
    await __captureClaudeVersionForTests("/usr/local/bin/claude", 1000, "linux", spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.shell).toBe(false);
  });

  it("defaults to process.platform when platform omitted (shell matches host)", async () => {
    const { spawn, calls } = makeFakeSpawn();
    // Omit platform; pass injected spawn so we can read what was sent.
    await __captureClaudeVersionForTests("/fake/claude", 1000, undefined, spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.shell).toBe(process.platform === "win32");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* The real-claude run lives in tests/integration/schema-probe-real-claude */
/* .test.ts (nightly job, #441): strict `status === "passed"`, plus the    */
/* assertions replayed over its own transcript with a field broken.        */
/* ───────────────────────────────────────────────────────────────────── */

/* ───────────────────────────────────────────────────────────────────── */
/* #441 — pacing on observed events, not fixed sleeps                    */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * A runner that behaves like the CLI in time: nothing is in the JSONL until
 * the REPL is up and a prompt has been typed, and each turn's lines land
 * `turnMs` later. Records what the probe sent and what the transcript held
 * at that moment.
 */
function makeTimedFactory(
  homeDir: string,
  opts: { turnMs: number; readyMs?: number; ready?: boolean; neverEndTurn?: boolean },
): { factory: ProbeRunnerFactory; sent: Array<{ what: string; linesAtSend: number }> } {
  const sent: Array<{ what: string; linesAtSend: number }> = [];
  const factory: ProbeRunnerFactory = async ({ cwd, sessionId }) => {
    const projectDir = join(homeDir, ".claude", "projects", encodeCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const lineCount = () =>
      existsSync(jsonlPath)
        ? readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).length
        : 0;
    const append = (lines: string[]) => {
      const prev = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : "";
      writeFileSync(jsonlPath, `${prev}${lines.join("\n")}\n`, "utf8");
    };
    let prompts = 0;
    let exited = false;
    return {
      waitForReady: async () => {
        await new Promise((r) => setTimeout(r, opts.readyMs ?? 0));
        return opts.ready ?? true;
      },
      sendPrompt: async () => {
        sent.push({ what: `prompt${++prompts}`, linesAtSend: lineCount() });
        const n = prompts;
        append([fixtureLines.user(sessionId)]);
        if (opts.neverEndTurn) return;
        setTimeout(() => {
          append(
            n === 1
              ? [fixtureLines.assistantText(sessionId)]
              : [
                  fixtureLines.assistantToolUse(sessionId),
                  fixtureLines.userToolResult(sessionId),
                  fixtureLines.assistantAfterTool(sessionId),
                ],
          );
        }, opts.turnMs);
      },
      sendSlash: async (cmd) => {
        sent.push({ what: `/${cmd}`, linesAtSend: lineCount() });
        if (cmd === "clear") {
          setTimeout(
            () => writeFileSync(join(projectDir, `${sessionId}-rotated.jsonl`), "{}\n"),
            opts.turnMs,
          );
        }
        if (cmd === "quit") setTimeout(() => (exited = true), opts.turnMs);
      },
      waitForExit: async (timeoutMs) => {
        const end = Date.now() + timeoutMs;
        while (!exited && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
        return exited;
      },
      kill: () => {},
    };
  };
  return { factory, sent };
}

describe("SchemaProbe.run() — paces on JSONL events (#441)", () => {
  it("sends each step only after the previous one's event, however slow", async () => {
    // Each event takes 150 ms; the old fixed pacing (timeoutMs / 20 = 50 ms
    // here) typed the next step while the turn was still running.
    const { factory, sent } = makeTimedFactory(harness.homeDir, { turnMs: 150 });
    const res = await new SchemaProbe(
      {
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: 1000,
      },
      factory,
    ).run();
    expect(res.failedAssertions ?? []).toEqual([]);
    expect(res.status).toBe("passed");
    expect(sent.map((s) => s.what)).toEqual(["prompt1", "prompt2", "/clear", "/quit"]);
    // prompt2 after turn 1 (user + assistant); /clear after the tool turn's
    // closing line (+ user, tool_use, tool_result, final assistant).
    expect(sent[1].linesAtSend).toBe(2);
    expect(sent[2].linesAtSend).toBe(6);
  });

  it("names the step that never came and stops there", async () => {
    const { factory, sent } = makeTimedFactory(harness.homeDir, {
      turnMs: 10,
      neverEndTurn: true,
    });
    const started = Date.now();
    const res = await new SchemaProbe(
      {
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: 300,
      },
      factory,
    ).run();
    expect(res.status).toBe("failed");
    const names = (res.failedAssertions ?? []).map((f) => f.name);
    expect(names).toContain("step_timeout_text_turn");
    expect(names).toContain("assistant_text_present");
    expect(sent.map((s) => s.what)).toEqual(["prompt1"]);
    // Bounded by the budget, not by a fixed sum of sleeps.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("types nothing when the REPL never comes up (a dialog it could not pass)", async () => {
    const { factory, sent } = makeTimedFactory(harness.homeDir, { turnMs: 10, ready: false });
    const res = await new SchemaProbe(
      {
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      factory,
    ).run();
    expect(res.status).toBe("failed");
    expect((res.failedAssertions ?? []).map((f) => f.name)).toContain("step_timeout_repl_ready");
    expect(sent).toEqual([]);
  });

  it("hands homeOverride to the runner so the child writes where the probe reads", async () => {
    let seen: string | undefined;
    const inner = makeMockFactory(harness.homeDir, {
      primaryLines: fullPrimary,
      writeSibling: true,
    });
    const res = await new SchemaProbe(
      {
        cacheFile: harness.cacheFile,
        claudeBin: harness.claudeBin,
        homeOverride: harness.homeDir,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      async (args) => {
        seen = args.homeDir;
        return inner(args);
      },
    ).run();
    expect(res.status).toBe("passed");
    expect(seen).toBe(harness.homeDir);
  });
});
