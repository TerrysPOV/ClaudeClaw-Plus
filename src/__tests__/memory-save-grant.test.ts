/**
 * The tool grant a memory save gets (#549 review fix): Read and Write, scoped to the
 * ONE memory file. A resumed session's transcript holds untrusted channel text, so the
 * grant must not let it write anywhere else.
 *
 * Permission-rule facts, from code.claude.com/docs/en/permissions: `//path` is an
 * absolute path from the filesystem root (`/path` anchors at the settings source);
 * "Edit rules apply to all built-in tools that edit files" (that includes Write), and
 * a path rule written as `Write(...)` is accepted but never consulted.
 */
import { describe, expect, it } from "bun:test";
import { memoryFileGrant } from "../memory";
import { buildPrintArgs } from "../oneshot/print";
import { memorySaveRequest } from "../shutdown-memory-save";

const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe("memoryFileGrant", () => {
  it("scopes Edit and Read rules to the absolute memory path (double slash = filesystem root)", () => {
    const g = memoryFileGrant("/work/proj/MEMORY.md");

    expect(g.allowedTools).toEqual(["Edit(//work/proj/MEMORY.md)", "Read(//work/proj/MEMORY.md)"]);
    expect(g.tools).toEqual(["Read", "Write"]);
  });

  it("never emits a bare tool name or a Write(...) path rule", () => {
    const g = memoryFileGrant("/work/proj/agents/suzy/MEMORY.md");

    for (const rule of g.allowedTools) expect(rule).toMatch(/^(Edit|Read)\(\/\/.+\)$/);
    expect(g.allowedTools.join()).not.toContain("Write(");
  });

  it("resolves a relative path against the cwd so the rule is always absolute", () => {
    const g = memoryFileGrant("MEMORY.md");

    expect(g.allowedTools[0]).toBe(`Edit(//${process.cwd().replace(/^\//, "")}/MEMORY.md)`);
  });

  it("refuses a path the rule syntax cannot pin to one file (glob, parenthesis, comma, newline)", () => {
    for (const bad of [
      "/p/a*b/MEMORY.md",
      "/p/a(b)/MEMORY.md",
      "/p/a,b/MEMORY.md",
      "/p/a?/MEMORY.md",
      "/p/[x]/MEMORY.md",
      "/p/a\nb/MEMORY.md",
    ]) {
      expect(() => memoryFileGrant(bad)).toThrow(/cannot be scoped/);
    }
  });
});

describe("memory save one-shot request -> argv", () => {
  it("resumes the session with Read,Write available and only the memory file pre-approved", () => {
    const req = memorySaveRequest({
      route: "memory.save.stop",
      prompt: "save it",
      memPath: "/work/proj/MEMORY.md",
      sessionId: "sid",
      model: "haiku",
      timeoutMs: 30_000,
    });
    const args = buildPrintArgs(req);

    expect(flagValue(args, "--resume")).toBe("sid");
    expect(flagValue(args, "--tools")).toBe("Read,Write");
    expect(flagValue(args, "--allowedTools")).toBe(
      "Edit(//work/proj/MEMORY.md),Read(//work/proj/MEMORY.md)",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("Write"); // never a bare, unscoped Write grant
  });
});
