import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setSettingsFileForTests,
  defaultPtyEnabled,
  loadSettings,
  reloadSettings,
} from "../config.js";
import {
  RESUME_ROUTES,
  UNTRUSTED_ROUTES,
  parseOneShotSettings,
  resolveOneShotEngine,
} from "./config.js";
import { runOneShot } from "./engine.js";
import { engines } from "./registry.js";
import { withPrintRuntime } from "./print.js";
import { runCompact } from "../runner.js";
import { injectOneShotForTests } from "../runner/live-session-actions.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  shutdownSupervisor,
} from "../runner/pty-supervisor.js";
import {
  createSession,
  resetSession,
  createFallbackSession,
  getFallbackSession,
} from "../sessions.js";
import { saveGlobalMemoryOneShot } from "../shutdown-memory-save.js";

describe("#572 trusted route defaults", () => {
  for (const route of RESUME_ROUTES) {
    for (const enabled of [true, false]) {
      it(`${route}: pty.enabled=${enabled} selects ${enabled ? "pty" : "print"}`, () => {
        expect(resolveOneShotEngine(parseOneShotSettings(undefined), route, enabled)).toBe(
          enabled ? "pty" : "print",
        );
      });
    }
    it(`${route}: explicit route overrides either PTY setting and default`, () => {
      for (const enabled of [true, false]) {
        for (const engine of ["pty", "print"]) {
          const settings = parseOneShotSettings({ default: "print", routes: { [route]: engine } });
          expect(resolveOneShotEngine(settings, route, enabled)).toBe(engine);
        }
      }
    });
    it(`${route}: explicit default overrides either PTY setting`, () => {
      for (const enabled of [true, false]) {
        expect(
          resolveOneShotEngine(parseOneShotSettings({ default: "print" }), route, enabled),
        ).toBe("print");
        const explicitPty = parseOneShotSettings({
          default: "pty",
          routes: Object.fromEntries(UNTRUSTED_ROUTES.map((route) => [route, "print"])),
        });
        expect(resolveOneShotEngine(explicitPty, route, enabled)).toBe("pty");
      }
    });
  }
  for (const route of UNTRUSTED_ROUTES) {
    it(`${route}: pty.enabled selects pty, otherwise print (#570)`, () => {
      expect(resolveOneShotEngine(parseOneShotSettings(undefined), route, true)).toBe("pty");
      expect(resolveOneShotEngine(parseOneShotSettings(undefined), route, false)).toBe("print");
    });
    it(`${route}: explicit route and default still win over the untrusted default`, () => {
      for (const enabled of [true, false]) {
        expect(
          resolveOneShotEngine(
            parseOneShotSettings({ routes: { [route]: "print" } }),
            route,
            enabled,
          ),
        ).toBe("print");
        expect(
          resolveOneShotEngine(parseOneShotSettings({ default: "print" }), route, enabled),
        ).toBe("print");
        expect(
          resolveOneShotEngine(
            parseOneShotSettings({ default: "print", routes: { [route]: "pty" } }),
            route,
            enabled,
          ),
        ).toBe("pty");
      }
    });
    it(`${route}: settings accept an explicit pty route`, () => {
      expect(parseOneShotSettings({ routes: { [route]: "pty" } }).routes[route]).toBe("pty");
    });
  }
  it("the win32 platform default keeps untrusted routes on print", () => {
    const enabled = defaultPtyEnabled("win32");
    expect(enabled).toBe(false);
    for (const route of UNTRUSTED_ROUTES)
      expect(resolveOneShotEngine(parseOneShotSettings(undefined), route, enabled)).toBe("print");
  });
  it("explicit family wildcard overrides the implicit default", () => {
    expect(
      resolveOneShotEngine(
        parseOneShotSettings({ routes: { "memory.*": "print" } }),
        "memory.save.stop",
        true,
      ),
    ).toBe("print");
  });
  it("serialized implicit settings do not become an explicit print default", () => {
    const saved = JSON.parse(JSON.stringify(parseOneShotSettings(undefined)));
    expect(saved).not.toHaveProperty("default");
    expect(resolveOneShotEngine(parseOneShotSettings(saved), "compact", true)).toBe("pty");
  });
});

describe("#572 trusted fallback dispatch", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    __resetSupervisorForTests();
    dir = mkdtempSync(join(tmpdir(), "572-routes-"));
    file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ pty: { enabled: true } }));
    _setSettingsFileForTests(file);
    await loadSettings();
    injectOneShotForTests(null);
    injectOneShotTrustForTests(async () => {});
  });
  afterEach(async () => {
    await shutdownSupervisor();
    __resetSupervisorForTests();
    injectOneShotTrustForTests(null);
    _setSettingsFileForTests();
    await resetSession();
    rmSync(dir, { recursive: true, force: true });
  });
  it("reload changes implicit dispatch without re-parsing an explicit default", async () => {
    const previous = new Map(["print", "pty"].map((id) => [id, engines.get(id)!]));
    const calls: string[] = [];
    try {
      for (const [id, engine] of previous)
        engines.set(id, {
          ...engine,
          run: async () => {
            calls.push(id);
            return { text: "ok", engine: id, model: "", exitCode: 0 };
          },
        });
      for (const enabled of [true, false, true]) {
        writeFileSync(file, JSON.stringify({ pty: { enabled } }));
        await reloadSettings();
        await runOneShot({
          route: "memory.save.stop",
          isolation: "trusted-session",
          prompt: "save",
          timeoutMs: 1000,
        });
      }
      expect(calls).toEqual(["pty", "print", "pty"]);
    } finally {
      for (const [id, engine] of previous) engines.set(id, engine);
    }
  });
  it("not-live compact uses PTY with the supplied agent/fallback session and bare command", async () => {
    await createSession("primary-must-not-resume");
    await createFallbackSession("fallback-to-resume", "suzy");
    const spawns: Array<{ sessionId: string; cwd: string }> = [];
    const turns: Array<{ prompt: string; allowReplCommand?: boolean }> = [];
    injectSpawnPty(async (opts) => {
      spawns.push(opts);
      return {
        sessionId: opts.sessionId,
        isAlive: () => true,
        lastTurnEndedAt: () => 0,
        dispose: async () => {},
        runTurn: async (prompt, options) => {
          turns.push({ prompt, allowReplCommand: options?.allowReplCommand });
          return {
            text: "compacted",
            sessionId: opts.sessionId,
            bytesCaptured: 9,
            cleanBoundary: true,
          };
        },
      } as never;
    });
    const stored = await getFallbackSession("suzy");
    expect(
      await withPrintRuntime(
        {
          spawn: () => {
            throw new Error("unexpected print spawn");
          },
        },
        () =>
          runCompact({
            sessionId: stored!.sessionId,
            model: "sonnet",
            sessionKey: "fallback:agent:suzy",
            cwd: dir,
            timeoutMs: 1000,
          }),
      ),
    ).toBe(true);
    expect(spawns.map((opts) => ({ sessionId: opts.sessionId, cwd: opts.cwd }))).toEqual([
      { sessionId: "fallback-to-resume", cwd: dir },
    ]);
    expect(turns).toEqual([{ prompt: "/compact", allowReplCommand: true }]);
    expect((await getFallbackSession("suzy"))?.sessionId).toBe("fallback-to-resume");
  });
  it("no-daemon shutdown save resumes the stored session and bounds a hung PTY", async () => {
    await createSession("stored-stop-session");
    const resumed: string[] = [];
    let disposed = 0;
    injectSpawnPty(async (opts) => {
      resumed.push(opts.sessionId);
      let rejectTurn: (error: Error) => void = () => {};
      return {
        sessionId: opts.sessionId,
        isAlive: () => true,
        lastTurnEndedAt: () => 0,
        runTurn: () =>
          new Promise((_, reject) => {
            rejectTurn = reject;
          }),
        dispose: async () => {
          disposed++;
          rejectTurn(new Error("PTY disposed"));
        },
      } as never;
    });
    const start = performance.now();
    expect(
      await withPrintRuntime(
        {
          spawn: () => {
            throw new Error("unexpected print spawn");
          },
        },
        () => saveGlobalMemoryOneShot({ timeoutMs: 50 }),
      ),
    ).toBe("failed");
    expect(resumed).toEqual(["stored-stop-session"]);
    expect(disposed).toBe(1);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("#570 untrusted PTY dispatch", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "570-routes-"));
    file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ pty: { enabled: true } }));
    _setSettingsFileForTests(file);
    await loadSettings();
  });
  afterEach(() => {
    _setSettingsFileForTests();
    rmSync(dir, { recursive: true, force: true });
  });
  it("runOneShot sends the classifier to the pty engine only when pty.enabled", async () => {
    const previous = new Map(["print", "pty"].map((id) => [id, engines.get(id)!]));
    const calls: string[] = [];
    try {
      for (const [id, engine] of previous)
        engines.set(id, {
          ...engine,
          run: async () => {
            calls.push(id);
            return { text: "null", engine: id, model: "", exitCode: 0 };
          },
        });
      for (const enabled of [true, false, true]) {
        writeFileSync(file, JSON.stringify({ pty: { enabled } }));
        await reloadSettings();
        await runOneShot({
          route: "discord.classifier",
          isolation: "untrusted",
          prompt: "classify",
          timeoutMs: 1000,
        });
      }
      expect(calls).toEqual(["pty", "print", "pty"]);
    } finally {
      for (const [id, engine] of previous) engines.set(id, engine);
    }
  });
  it("an untrusted request still cannot pass cwd, tools or resume to the pty engine", async () => {
    const previous = engines.get("pty")!;
    const calls: string[] = [];
    try {
      engines.set("pty", {
        ...previous,
        run: async () => {
          calls.push("pty");
          return { text: "", engine: "pty", model: "", exitCode: 0 };
        },
      });
      const base = {
        route: "discord.classifier",
        isolation: "untrusted" as const,
        prompt: "classify",
        timeoutMs: 1000,
      };
      for (const extra of [
        { cwd: "/tmp" },
        { tools: ["Bash"] },
        { allowedTools: ["Bash"] },
        { resumeSessionId: "abc" },
      ])
        await expect(runOneShot({ ...base, ...extra })).rejects.toThrow("cannot specify");
      expect(calls).toEqual([]);
    } finally {
      engines.set("pty", previous);
    }
  });
});
