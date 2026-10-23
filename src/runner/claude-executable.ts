/**
 * The claude binary to spawn. A leaf module so spawn sites outside the runner
 * (the one-shot print engine, the plugin CLI wrapper) can use it without
 * loading `runner.ts` and its dependencies. `runner.ts` re-exports
 * `claudeExecutable` and `_setClaudeExecutableForTests`.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Picks the binary from `where claude` output, in PATH order. The first
 * `claude.exe` (a native install) is used as is; the first `claude.cmd` (the
 * npm shim) is swapped for the `claude.exe` the package ships next to it.
 * Whichever comes first on PATH wins. A shim without its `claude.exe`,
 * extensionless and `.ps1` entries are skipped. `"claude"` when nothing fits.
 */
export function pickClaudeExecutable(
  whereOutput: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const lines = whereOutput
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.endsWith(".exe")) return line;
    if (lower.endsWith(".cmd")) {
      const exePath = win32.join(
        win32.dirname(line),
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (exists(exePath)) return exePath;
    }
  }
  return "claude";
}

/**
 * On Windows, `claude` resolves to `claude.cmd`, a batch wrapper that must
 * be run through cmd.exe (8191-char command-line limit). Resolving the
 * underlying `claude.exe` lets us call it directly via CreateProcessW
 * (32767-char limit). Required because --append-system-prompt + prompt
 * files + CLAUDE.md can easily exceed 8K. Takes the first `claude.exe` or
 * resolvable `claude.cmd` on PATH (see `pickClaudeExecutable`).
 */
function resolveClaudeExecutable(): string {
  if (process.platform !== "win32") return "claude";
  try {
    return pickClaudeExecutable(execSync("where claude", { encoding: "utf8" }));
  } catch {
    return "claude";
  }
}
export const CLAUDE_EXECUTABLE = resolveClaudeExecutable();
let claudeExecutableForTests: string | null = null;

/** The claude binary to spawn — `claude.exe` on Windows when it can be found,
 *  plain `"claude"` everywhere else. For spawn sites outside `runner.ts` (the
 *  interactive PTY, the bus session manager, the one-shot print engine, the
 *  plugin CLI wrapper): bun-pty cannot start the `claude.cmd` shim, and
 *  node's spawn does not run it without a shell. */
export function claudeExecutable(): string {
  return claudeExecutableForTests ?? CLAUDE_EXECUTABLE;
}

/** Test seam: make `claudeExecutable()` return `path` (null restores it). */
export function _setClaudeExecutableForTests(path: string | null): void {
  claudeExecutableForTests = path;
}
