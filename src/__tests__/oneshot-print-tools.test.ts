/**
 * `--tools` / `--allowedTools` as the print engine builds them (#549 review fix).
 *
 * `--tools` takes BARE built-in tool names; permission rules with a path belong in
 * `--allowedTools` (`claude --help`; docs: code.claude.com/docs/en/permissions). The
 * engine used to pass `allowedTools` to both flags, so a scoped rule would have landed
 * in `--tools`.
 */
import { describe, expect, it } from "bun:test";
import type { OneShotRequest } from "../oneshot/engine";
import { buildPrintArgs } from "../oneshot/print";

const base: OneShotRequest = {
  route: "memory.save.stop",
  prompt: "save",
  isolation: "trusted-session",
  resumeSessionId: "sid",
  timeoutMs: 1000,
};

const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe("buildPrintArgs tool flags (trusted-session)", () => {
  it("explicit tools + scoped rules: --tools is the bare list, --allowedTools the rules as given", () => {
    const args = buildPrintArgs({
      ...base,
      tools: ["Read", "Write"],
      allowedTools: ["Edit(//proj/MEMORY.md)", "Read(//proj/MEMORY.md)"],
    });

    expect(flagValue(args, "--tools")).toBe("Read,Write");
    expect(flagValue(args, "--permission-mode")).toBe("dontAsk"); // same as the pty engine
    expect(flagValue(args, "--allowedTools")).toBe("Edit(//proj/MEMORY.md),Read(//proj/MEMORY.md)");
  });

  it("without explicit tools, --tools is the unique bare names of the allowed entries", () => {
    const args = buildPrintArgs({
      ...base,
      allowedTools: ["Edit(//a/MEMORY.md)", "Read(//a/MEMORY.md)", "Read(//b/x)", "Grep"],
    });

    expect(flagValue(args, "--tools")).toBe("Edit,Read,Grep");
    expect(flagValue(args, "--allowedTools")).toBe(
      "Edit(//a/MEMORY.md),Read(//a/MEMORY.md),Read(//b/x),Grep",
    );
  });

  it("allowedTools [] means no tools: --tools '' and no --allowedTools at all", () => {
    const args = buildPrintArgs({ ...base, allowedTools: [] });

    expect(args).toContain("--tools");
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).not.toContain("--allowedTools");
  });

  it("no grant given: neither flag (the caller gets the default permission profile)", () => {
    const args = buildPrintArgs(base);

    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--permission-mode"); // dontAsk only comes with a grant
  });
});

describe("buildPrintArgs untrusted", () => {
  const untrusted: OneShotRequest = {
    route: "discord.classifier",
    prompt: "hi",
    isolation: "untrusted",
    timeoutMs: 1000,
  };

  it("argv is unchanged by this fix: isolation list only, prompt not in argv", () => {
    const args = buildPrintArgs(untrusted);

    expect(args.slice(0, 3)).toEqual(["--print", "--output-format", "text"]);
    expect(flagValue(args, "--tools")).toBe(""); // from UNTRUSTED_CLAUDE_ARGS
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("hi");
  });

  it("rejects tools just like allowedTools: untrusted calls never take a grant", () => {
    expect(() => buildPrintArgs({ ...untrusted, tools: ["Read"] })).toThrow(/untrusted/);
    expect(() => buildPrintArgs({ ...untrusted, allowedTools: ["Read"] })).toThrow(/untrusted/);
  });
});
