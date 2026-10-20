import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import {
  __buildClaudeArgsForTests,
  spawnPty,
  type PtyProcessOptions,
} from "../runner/pty-process.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import { setPromptPrepareForTests } from "../runner/pty-process-test-seams.js";
import { untrustedPtyProjectDir } from "./pty-cleanup.js";
import { PRINT_ONLY_UNTRUSTED_ARGS, UNTRUSTED_CLAUDE_ARGS } from "./isolation.js";
import { printRuntime, withPrintRuntime } from "./print.js";
import { engines } from "./registry.js";

let dir: string;
let savedConfig: string | undefined;
let savedIsolation: boolean;
let spawned: PtyProcessOptions[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-isolation-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = join(dir, "settings.json");
  writeFileSync(file, "{}");
  _setSettingsFileForTests(file);
  await loadSettings();
  savedIsolation = engines.get("pty")!.caps.isolation;
  engines.get("pty")!.caps.isolation = true;
  spawned = [];
  injectOneShotTrustForTests(async () => {});
});

afterEach(() => {
  __resetSupervisorForTests();
  injectOneShotTrustForTests(null);
  engines.get("pty")!.caps.isolation = savedIsolation;
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  _setSettingsFileForTests();
  rmSync(dir, { recursive: true, force: true });
});

function fakeSpawn(onTurn: (opts: PtyProcessOptions) => void = () => {}): void {
  injectSpawnPty(async (opts) => {
    spawned.push(opts);
    return {
      label: "isolation",
      pid: 1,
      sessionId: "probe-session",
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: async () => {
        onTurn(opts);
        // An untrusted one-shot returns the transcript reply (#570), so the
        // double writes one under the child's (throwaway) config root.
        const project = untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
        mkdirSync(project, { recursive: true });
        writeFileSync(
          join(project, "reply.jsonl"),
          `${JSON.stringify({ type: "assistant", message: { id: "m", model: "haiku", content: [{ type: "text", text: "ok" }] } })}\n`,
        );
        return { text: "ok", sessionId: "probe-session", cleanBoundary: true, bytesCaptured: 2 };
      },
      dispose: async () => {},
    } as never;
  });
}

const request = {
  route: "discord.classifier",
  prompt: "classify",
  isolation: "untrusted" as const,
  timeoutMs: 1000,
};

it("the internal prompt-write test seam reaches the wire without changing the default sanitizer", async () => {
  let called = false;
  // Read when the process is constructed, so it is set before the spawn.
  setPromptPrepareForTests(() => {
    called = true;
    return "✻ TEST_SEAM_VISIBLE shift+tab to cycle";
  });
  const child = await spawnPty({
    sessionId: "",
    cwd: dir,
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/cat",
    _argsOverride: [],
    _skipReadySettle: true,
    quietWindowMs: 50,
    sentinelMaxWaitMs: 1000,
  });
  try {
    const result = await child.runTurn("/probe ✻ shift+tab to cycle", { timeoutMs: 2000 });
    expect(called).toBe(true);
    expect(result.text.includes("TEST_SEAM_VISIBLE")).toBe(true);
  } finally {
    setPromptPrepareForTests(null);
    await child.dispose();
  }
});

it("the actual untrusted PTY spawn preserves every interactive isolation argument", async () => {
  fakeSpawn();
  expect((await runOnceOnPty(request)).exitCode).toBe(0);
  expect(spawned).toHaveLength(1);
  const args = __buildClaudeArgsForTests(spawned[0]!);
  expect(args.slice(args.indexOf("--tools"))).toEqual(
    UNTRUSTED_CLAUDE_ARGS.filter(
      (arg) => !(PRINT_ONLY_UNTRUSTED_ARGS as readonly string[]).includes(arg),
    ),
  );
});

it("the print-only exception is exactly the explicit compensated persistence flag", () => {
  expect([...PRINT_ONLY_UNTRUSTED_ARGS]).toEqual(["--no-session-persistence"]);
  for (const required of [
    "--tools",
    "--strict-mcp-config",
    "--setting-sources",
    "--disable-slash-commands",
  ]) {
    expect(PRINT_ONLY_UNTRUSTED_ARGS as readonly string[]).not.toContain(required);
  }
});

it("untrusted PTY spawn uses the exact same caller environment policy as print", async () => {
  fakeSpawn();
  const env = { PATH: "/usr/bin:/bin", HOME: dir, ONESHOT_ALLOWED_CANARY: "EXAMPLE_PLACEHOLDER" };
  // The credential directory also falls back to the daemon's own env (r12), so the daemon
  // must have none for the expected "" below, whatever shell this suite runs in.
  const savedDaemon = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  };
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  try {
    await withPrintRuntime({ env }, () => runOnceOnPty({ ...request, model: "glm" }));
  } finally {
    for (const [key, value] of Object.entries(savedDaemon)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(spawned).toHaveLength(1);
  // Compare in memory: a failed assertion must never dump a real environment.
  // Exactly print's policy, plus three variables: the throwaway root, the operator's
  // credential store ("" = the default, as none is set), and the marketplace-clone switch.
  const childRoot = spawned[0]!.env.CLAUDE_CONFIG_DIR ?? "";
  expect(childRoot.includes("claudeclaw-oneshot-cfg-")).toBe(true);
  const expected = {
    ...env,
    CLAUDE_CONFIG_DIR: childRoot,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  };
  expect(
    JSON.stringify(Object.entries(spawned[0]!.env).sort()) ===
      JSON.stringify(Object.entries(expected).sort()),
  ).toBe(true);
});

it("the transcript lives under the throwaway root, never under the caller's Claude config directory", async () => {
  const configDir = join(dir, "caller-config");
  let project = "";
  let root = "";
  fakeSpawn((opts) => {
    root = opts.env.CLAUDE_CONFIG_DIR!;
    project = untrustedPtyProjectDir(opts.cwd, root);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "caller-session.jsonl"), "private prompt");
  });
  await withPrintRuntime({ env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: configDir } }, () =>
    runOnceOnPty(request),
  );
  expect(project !== "").toBe(true);
  expect(root === configDir).toBe(false);
  expect(existsSync(project)).toBe(false);
  expect(existsSync(root)).toBe(false);
  // The caller's directory was never even created.
  expect(existsSync(configDir)).toBe(false);
});

it("untrusted native PTY inheritance excludes even native-only variables and restores the parent", async () => {
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
      getenv: { args: [FFIType.cstring], returns: FFIType.cstring },
    },
  );
  const name = `ONESHOT_NATIVE_TEST_${process.pid}`;
  const key = Buffer.from(`${name}\0`);
  const previous = library.symbols.getenv(key)?.toString();
  const savedJs = process.env[name];
  const marker = join(dir, "inherited");
  const done = join(dir, "child-ready");
  // Seed libc only. process.env can be missing an inherited native variable.
  library.symbols.setenv(key, Buffer.from("EXAMPLE_PLACEHOLDER\0"), 1);
  delete process.env[name];
  let child: Awaited<ReturnType<typeof spawnPty>> | undefined;
  try {
    child = await spawnPty({
      sessionId: "",
      cwd: dir,
      isolation: "untrusted",
      env: { PATH: "/usr/bin:/bin" },
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      _commandOverride: "/bin/sh",
      _skipReadySettle: true,
      _argsOverride: [
        "-c",
        `if [ -n "$${name}" ]; then touch '${marker}'; fi; touch '${done}'; cat`,
      ],
    });
    const deadline = Date.now() + 2000;
    while (!existsSync(done) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(done)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // A failed assertion prints only a boolean, never a native value.
    expect(library.symbols.getenv(key)?.toString() === "EXAMPLE_PLACEHOLDER").toBe(true);
    expect(process.env[name] === undefined).toBe(true);
    const { withCleanProcessEnv } = await import("../runner.js");
    expect(() =>
      withCleanProcessEnv(() => {
        throw new Error("expected probe failure");
      }, {}),
    ).toThrow("expected probe failure");
    expect(library.symbols.getenv(key)?.toString() === "EXAMPLE_PLACEHOLDER").toBe(true);
    expect(process.env[name] === undefined).toBe(true);
  } finally {
    await child?.dispose();
    if (previous === undefined) library.symbols.unsetenv(key);
    else library.symbols.setenv(key, Buffer.from(`${previous}\0`), 1);
    if (savedJs === undefined) delete process.env[name];
    else process.env[name] = savedJs;
    library.close();
  }
});

for (const failure of [false, true]) {
  it(`removes external transcripts and the empty cwd after ${failure ? "failure" : "success"}`, async () => {
    let project = "";
    const sibling = join(dir, "projects", "another-project", "keep.jsonl");
    mkdirSync(join(dir, "projects", "another-project"), { recursive: true });
    writeFileSync(sibling, "keep");
    fakeSpawn((opts) => {
      project = untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "probe-session.jsonl"), "private prompt");
      if (failure) throw new Error("probe failure");
    });
    const result = await runOnceOnPty(request);
    expect(result.exitCode === 0).toBe(!failure);
    expect(project).not.toBe("");
    expect(existsSync(project)).toBe(false);
    expect(existsSync(spawned[0]!.cwd)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });
}
