/**
 * Issue #586 — the plugin's `.mcp.json` must start the plus-bus MCP server on
 * every platform claude runs on.
 *
 * It used to point at `scripts/start-bus-mcp`, a bash script. On win32 claude
 * reads the shebang and runs `bash`, which a stock Windows install does not
 * have: plus-bus showed "failed" in `/mcp`, the agent never opened its IPC
 * connection, and every prompt to it ended in "No MCP connection". The launcher
 * is now bun itself, through the variable the daemon sets for exactly this
 * (`CCAW_BUS_BUN_PATH`, see `buildChildEnv`), with `bun` on PATH as the
 * fallback — the same contract the script had, without a shell.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeclawPluginRoot } from "../session-manager";

const root = resolveClaudeclawPluginRoot();
const server = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers["plus-bus"];

describe("plus-bus launcher in .mcp.json (#586)", () => {
  it("runs bun directly: the daemon's pinned bun, else bun on PATH", () => {
    expect(server.command).toBe("${CCAW_BUS_BUN_PATH:-bun}");
  });

  it("does not go through a script under the plugin root (no shell on win32)", () => {
    expect(server.command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  it("passes `run <mcp-server.ts>` and that file exists", () => {
    expect(server.args).toEqual(["run", "${CLAUDE_PLUGIN_ROOT}/src/bus/mcp-server.ts"]);
    expect(existsSync(join(root, "src", "bus", "mcp-server.ts"))).toBe(true);
  });

  it("the daemon still sets the variable the launcher reads", () => {
    const src = readFileSync(join(root, "src", "bus", "session-manager.ts"), "utf8");
    expect(src).toContain("env.CCAW_BUS_BUN_PATH = process.execPath;");
  });
});
