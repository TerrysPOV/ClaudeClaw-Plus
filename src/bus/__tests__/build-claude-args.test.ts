/**
 * Unit tests for `buildClaudeArgs` + `writeBusMcpConfig`.
 *
 * These cover the wire-up that Sprint 1 missed: the actual CLI args the
 * Bus runtime passes to `claude`. Sprint 0.6's working probe used a
 * bare channel name + an `--mcp-config` JSON whose `mcpServers` key
 * matched the channel name; the original `plugin:plus-bus@local` arg
 * shipped in PR #110 never matched that contract and silently loaded
 * no channel. Every previous test bypassed this by setting
 * `argsOverride: []` on the SessionManager seam.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PLUS_BUS_CHANNEL, buildClaudeArgs, writeBusMcpConfig } from "../session-manager";
import type { AgentConfig } from "../types";

function makeAgent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: over.id ?? "test-agent",
    cwd: over.cwd ?? process.cwd(),
    session_id: over.session_id ?? "00000000-0000-0000-0000-000000000000",
    permission_mode: over.permission_mode,
    system_prompt_file: over.system_prompt_file,
    mcp_config: over.mcp_config,
    supervision: over.supervision ?? "pty-stdin",
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claudeclaw-bus-args-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("PLUS_BUS_CHANNEL", () => {
  it("is the bare channel name expected by --dangerously-load-development-channels", () => {
    // The flag value MUST match an `mcpServers` key. Anything other than
    // a bare identifier (e.g. `plugin:plus-bus@local`) silently loads no
    // channel. Spike 0.6 reference: docs/spikes/0.6-stream-json-channels-probe.md.
    expect(PLUS_BUS_CHANNEL).toBe("plus-bus");
  });
});

describe("writeBusMcpConfig", () => {
  it("writes a JSON config whose mcpServers contains a plus-bus stdio entry", () => {
    const agent = makeAgent({ id: "alpha" });
    const path = writeBusMcpConfig(agent, { warn: () => {} });
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers[PLUS_BUS_CHANNEL]).toBeDefined();
    const entry = cfg.mcpServers[PLUS_BUS_CHANNEL]!;
    // Spawned via current bun (process.execPath); points at mcp-server.ts.
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toBe("run");
    expect(entry.args[1]).toMatch(/\/bus\/mcp-server\.ts$/);
  });

  it("merges operator-supplied mcpServers preserving non-conflicting entries", () => {
    const userCfgPath = join(tmp, "user-mcp.json");
    writeFileSync(
      userCfgPath,
      JSON.stringify({
        mcpServers: {
          playwright: { command: "bun", args: ["run", "/some/playwright.ts"] },
          everything: { command: "node", args: ["/some/everything.js"] },
        },
      }),
    );
    const agent = makeAgent({ id: "beta", mcp_config: userCfgPath });
    const path = writeBusMcpConfig(agent, { warn: () => {} });
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["everything", "playwright", "plus-bus"]);
  });

  it("overwrites an operator-supplied plus-bus entry and warns", () => {
    const userCfgPath = join(tmp, "user-mcp.json");
    writeFileSync(
      userCfgPath,
      JSON.stringify({
        mcpServers: {
          "plus-bus": { command: "evil", args: ["bad"] },
        },
      }),
    );
    const agent = makeAgent({ id: "gamma", mcp_config: userCfgPath });
    const warnings: string[] = [];
    const path = writeBusMcpConfig(agent, { warn: (m: string) => warnings.push(m) });
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(cfg.mcpServers["plus-bus"]?.command).toBe(process.execPath);
    expect(warnings.some((w) => w.includes("reserved name"))).toBe(true);
  });

  it("falls back to bus-only when operator mcp_config is unreadable", () => {
    const agent = makeAgent({ id: "delta", mcp_config: join(tmp, "does-not-exist.json") });
    const path = writeBusMcpConfig(agent, { warn: () => {} });
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(["plus-bus"]);
  });

  it("creates the synthesised config with 0600 perms (no leak of operator secrets)", () => {
    // Codex P2 on PR #131: operator `mcp_config` entries may carry
    // credentials in `env`/`headers`; the synth copy lives in /tmp and
    // must not be world-readable. Mirrors PR #72 item 2 for the PTY
    // mcp-config writer.
    const userCfgPath = join(tmp, "user-mcp.json");
    writeFileSync(
      userCfgPath,
      JSON.stringify({
        mcpServers: {
          secret: { command: "bun", env: { GITHUB_TOKEN: "ghp_secret" } },
        },
      }),
    );
    const agent = makeAgent({ id: "perms-test", mcp_config: userCfgPath });
    const path = writeBusMcpConfig(agent, { warn: () => {} });
    // Lowest 9 bits = file permission bits; mask off type bits.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("falls back to bus-only when operator mcp_config is malformed JSON", () => {
    const userCfgPath = join(tmp, "bad-mcp.json");
    writeFileSync(userCfgPath, "{not json");
    const agent = makeAgent({ id: "epsilon", mcp_config: userCfgPath });
    const warnings: string[] = [];
    const path = writeBusMcpConfig(agent, { warn: (m: string) => warnings.push(m) });
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(["plus-bus"]);
    expect(warnings.some((w) => w.includes("failed to read operator mcp_config"))).toBe(true);
  });
});

describe("buildClaudeArgs", () => {
  it("includes --mcp-config + bare-name channel arg for pty-stdin agents", () => {
    const agent = makeAgent({ id: "mu" });
    const args = buildClaudeArgs(agent, "pty-stdin");
    const mcpIdx = args.indexOf("--mcp-config");
    const chanIdx = args.indexOf("--dangerously-load-development-channels");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(chanIdx).toBeGreaterThanOrEqual(0);
    expect(args[chanIdx + 1]).toBe(PLUS_BUS_CHANNEL);
    // The mcp-config path must exist on disk; claude reads it on startup.
    expect(existsSync(args[mcpIdx + 1]!)).toBe(true);
  });

  it("prepends -p stream-json flags for process-stream-json mode", () => {
    const agent = makeAgent({ id: "nu" });
    const args = buildClaudeArgs(agent, "process-stream-json");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--input-format=stream-json");
    expect(args).toContain("--output-format=stream-json");
    expect(args).toContain("--mcp-config");
    expect(args).toContain(PLUS_BUS_CHANNEL);
  });

  it("passes through permission_mode and session_id", () => {
    const agent = makeAgent({
      id: "xi",
      permission_mode: "acceptEdits",
      session_id: "deadbeef-1234-1234-1234-000000000000",
    });
    const args = buildClaudeArgs(agent, "pty-stdin");
    const pmIdx = args.indexOf("--permission-mode");
    const sidIdx = args.indexOf("--session-id");
    expect(args[pmIdx + 1]).toBe("acceptEdits");
    expect(args[sidIdx + 1]).toBe("deadbeef-1234-1234-1234-000000000000");
  });
});
