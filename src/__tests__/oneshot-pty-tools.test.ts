/**
 * The `pty` engine must build its tool flags exactly like the `print` engine (#549
 * security review): `--tools` takes bare tool names, path rules go in `--allowedTools`,
 * `[]` means no tools, and the default permission profile is used only when the caller
 * gave no grant at all. `docs/oneshot-engines.md` maps `memory.save.stop` to `pty`, so
 * a scoped memory-save grant reaches this engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import type { OneShotRequest } from "../oneshot/engine";
import { buildPrintArgs } from "../oneshot/print";
import type { PtyProcessOptions } from "../runner/pty-process";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor";

const base: OneShotRequest = {
  route: "memory.save.stop",
  prompt: "save",
  isolation: "trusted-session",
  resumeSessionId: "sid",
  cwd: "/tmp",
  timeoutMs: 2000,
};

let seen: PtyProcessOptions[];

beforeEach(async () => {
  __resetSupervisorForTests();
  await initConfig();
  await loadSettings();
  await reloadSettings();
  seen = [];
  injectOneShotTrustForTests(async () => ({ ok: true }));
  injectSpawnPty(async (opts) => {
    seen.push(opts);
    return {
      label: "fake",
      pid: 1,
      sessionId: "sid",
      cwd: "/tmp",
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      exitInfo: () => null,
      runTurn: async () => ({
        text: "ok",
        bytesCaptured: 2,
        cleanBoundary: true,
        sessionId: "sid",
      }),
      dispose: async () => {},
    };
  });
});

afterEach(() => {
  injectSpawnPty(null);
  injectOneShotTrustForTests(null);
  __resetSupervisorForTests();
});

const flagValue = (args: string[] | undefined, flag: string): string | undefined => {
  const i = (args ?? []).indexOf(flag);
  return i === -1 ? undefined : (args ?? [])[i + 1];
};

describe("pty engine tool flags", () => {
  it("explicit tools + scoped rules: --tools is the bare list, --allowedTools the rules", async () => {
    await runOnceOnPty({
      ...base,
      tools: ["Read", "Write"],
      allowedTools: ["Edit(//p/MEMORY.md)", "Read(//p/MEMORY.md)"],
    });

    expect(flagValue(seen[0].securityArgs, "--tools")).toBe("Read,Write");
    expect(flagValue(seen[0].securityArgs, "--allowedTools")).toBe(
      "Edit(//p/MEMORY.md),Read(//p/MEMORY.md)",
    );
  });

  it("allowedTools [] means no tools and NO default permission profile (no bypass flag)", async () => {
    await runOnceOnPty({ ...base, allowedTools: [] });

    const args = seen[0].securityArgs ?? [];
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(flagValue(args, "--permission-mode")).toBe("dontAsk"); // denies, never prompts
  });

  it("a rule list without explicit tools derives unique bare names", async () => {
    await runOnceOnPty({ ...base, allowedTools: ["Read(//a)", "Read(//b)", "Grep"] });

    expect(flagValue(seen[0].securityArgs, "--tools")).toBe("Read,Grep");
  });

  it("matches the print engine flag for flag", async () => {
    const req = {
      ...base,
      tools: ["Read", "Write"],
      allowedTools: ["Edit(//p/M.md)", "Read(//p/M.md)"],
    };
    await runOnceOnPty(req);
    const print = buildPrintArgs(req);

    for (const flag of ["--tools", "--allowedTools"]) {
      expect(flagValue(seen[0].securityArgs, flag)).toBe(flagValue(print, flag));
    }
  });

  it("no grant at all: the default permission profile applies, as before", async () => {
    await runOnceOnPty(base);

    const args = seen[0].securityArgs ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args).not.toContain("--tools"); // under the default profile, not an explicit grant
  });
});
