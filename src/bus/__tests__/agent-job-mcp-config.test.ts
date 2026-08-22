/**
 * Issue #165 follow-up — the agent-job spawn path (`dispatch_job` →
 * `runAgentJobHeadless`) must synthesize a `--mcp-config` for `mcp.shared`
 * servers, the same way the legacy PTY supervisor and the bus agent spawn
 * already do. Before this, a dispatched job ran with no MCP servers at all
 * while the agent that dispatched it had every shared server.
 *
 * Coverage:
 *   1. `synthesizeAgentJobMcpConfig` — dormancy, JSON shape, per-job keys.
 *   2. `releaseAgentJobMcpConfig` — revoke + unlink, idempotent, dormant no-op.
 *   3. `withAgentJobMcpConfig` — the mint → run → release wrapper actually
 *      hands the path to the run and releases it, including when the run
 *      throws.
 *   4. `staticAgentMcpConfig` — the precedence rule: an operator-supplied
 *      static `agent.mcp_config` wins over synthesis on the job path, exactly
 *      as it does on the agent path (`synthesizeBusMcpConfig`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PtyIdentity } from "../../runner/pty-mcp-config-writer";
import { buildAgentJobArgs } from "../../runner";
import { staticAgentMcpConfig, withAgentJobMcpConfig } from "../runtime-mount";
import {
  type BusMcpConfigSynthesizer,
  releaseAgentJobMcpConfig,
  synthesizeAgentJobMcpConfig,
} from "../session-manager";

function makeSynth(overrides: Partial<BusMcpConfigSynthesizer> = {}): {
  synth: BusMcpConfigSynthesizer;
  issued: string[];
  revoked: string[];
} {
  const issued: string[] = [];
  const revoked: string[] = [];
  const synth: BusMcpConfigSynthesizer = {
    sharedServers: ["alpha", "beta"],
    bridgeBaseUrl: () => "http://127.0.0.1:4632",
    issue: (ptyId): PtyIdentity => {
      issued.push(ptyId);
      return {
        ptyId,
        issuedAt: 1234,
        headers: {
          Authorization: `Bearer secret-${ptyId}`,
          "X-Claudeclaw-Pty-Id": ptyId,
          "X-Claudeclaw-Ts": "1234",
        },
      };
    },
    revoke: (ptyId) => {
      revoked.push(ptyId);
    },
    ...overrides,
  };
  return { synth, issued, revoked };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ccaw-job-mcp-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("synthesizeAgentJobMcpConfig", () => {
  it("returns undefined and writes nothing when the multiplexer is dormant", () => {
    expect(synthesizeAgentJobMcpConfig("agent-job-1", null, cwd)).toBeUndefined();

    const { synth } = makeSynth({ sharedServers: [] });
    expect(synthesizeAgentJobMcpConfig("agent-job-1", synth, cwd)).toBeUndefined();
    expect(existsSync(join(cwd, ".claudeclaw"))).toBe(false);
  });

  it("writes a 0600 config carrying the shared servers and the job's own identity", () => {
    const { synth, issued } = makeSynth();

    const path = synthesizeAgentJobMcpConfig("agent-job-abc", synth, cwd);
    expect(path).toBeDefined();
    expect(issued).toEqual(["agent-job-abc"]);

    // 0600 — the file holds a bearer token at rest.
    expect(statSync(path as string).mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(readFileSync(path as string, "utf8"));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["alpha", "beta"]);
    expect(parsed.mcpServers.alpha.url).toBe("http://127.0.0.1:4632/mcp/alpha");
    expect(parsed.mcpServers.alpha.headers.Authorization).toBe("Bearer secret-agent-job-abc");
  });

  it("keys on the job, so two concurrent jobs never share a file or an identity", () => {
    const { synth, issued } = makeSynth();

    const first = synthesizeAgentJobMcpConfig("agent-job-one", synth, cwd);
    const second = synthesizeAgentJobMcpConfig("agent-job-two", synth, cwd);

    expect(first).not.toBe(second);
    expect(existsSync(first as string)).toBe(true);
    expect(existsSync(second as string)).toBe(true);
    expect(issued).toEqual(["agent-job-one", "agent-job-two"]);
  });

  it("revokes the identity and rethrows when the write fails (never a silent no-MCP run)", () => {
    const { synth, revoked } = makeSynth();
    // A path under a regular file: mkdir of `.claudeclaw` fails with ENOTDIR.
    // Written synchronously on purpose — an unawaited async write would let
    // mkdir(recursive) create the path as a DIRECTORY and invert this test.
    const notADir = join(cwd, "regular-file");
    writeFileSync(notADir, "x");

    expect(() => synthesizeAgentJobMcpConfig("agent-job-boom", synth, notADir)).toThrow();
    expect(revoked).toEqual(["agent-job-boom"]);
  });
});

describe("releaseAgentJobMcpConfig", () => {
  it("revokes the identity and deletes the config", async () => {
    const { synth, revoked } = makeSynth();
    const path = synthesizeAgentJobMcpConfig("agent-job-rel", synth, cwd) as string;
    expect(existsSync(path)).toBe(true);

    releaseAgentJobMcpConfig("agent-job-rel", synth, cwd);

    expect(revoked).toEqual(["agent-job-rel"]);
    expect(existsSync(path)).toBe(false);
  });

  it("is idempotent and a no-op when the multiplexer is dormant", async () => {
    const { synth } = makeSynth();
    releaseAgentJobMcpConfig("agent-job-never-issued", synth, cwd);
    releaseAgentJobMcpConfig("agent-job-never-issued", synth, cwd);
    releaseAgentJobMcpConfig("agent-job-never-issued", null, cwd);
  });
});

describe("withAgentJobMcpConfig", () => {
  it("hands the synthesized path to the run and releases it afterwards", async () => {
    const { synth, issued, revoked } = makeSynth();
    let seen: string | undefined;
    let existedDuringRun = false;

    const result = await withAgentJobMcpConfig(cwd, synth, async (mcpConfigPath) => {
      seen = mcpConfigPath;
      existedDuringRun = existsSync(mcpConfigPath as string);
      return "done";
    });

    expect(result).toBe("done");
    expect(seen).toBeDefined();
    expect(existedDuringRun).toBe(true);
    // Job-scoped key, generated per run — not the agent's id.
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatch(/^agent-job-/);
    expect(revoked).toEqual(issued);
    expect(existsSync(seen as string)).toBe(false);
  });

  it("passes undefined through when the multiplexer is dormant", async () => {
    let seen: string | undefined = "sentinel";
    await withAgentJobMcpConfig(cwd, null, async (mcpConfigPath) => {
      seen = mcpConfigPath;
      return 0;
    });
    expect(seen).toBeUndefined();
  });

  it("releases the identity even when the run throws", async () => {
    const { synth, issued, revoked } = makeSynth();

    await expect(
      withAgentJobMcpConfig(cwd, synth, async () => {
        throw new Error("job blew up");
      }),
    ).rejects.toThrow("job blew up");

    expect(revoked).toEqual(issued);
    expect(existsSync(join(cwd, ".claudeclaw", `mcp-pty-${issued[0]}.json`))).toBe(false);
  });
});

describe("release under a real (async) revoke", () => {
  it("does not wait on multiplexer teardown — the job's slot is freed immediately", async () => {
    // The real `revoke` is `plugin.releaseIdentity`, which closes transports
    // and writes the multiplexer's persistence file. Awaiting it would hold
    // the job's concurrency slot for the whole teardown — and forever if a
    // close ever hangs.
    let settle: (() => void) | undefined;
    const { synth } = makeSynth({
      revoke: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });

    const started = Date.now();
    await withAgentJobMcpConfig(cwd, synth, async () => "done");
    // Returned while the teardown promise is still pending.
    expect(settle).toBeDefined();
    expect(Date.now() - started).toBeLessThan(1000);
    settle?.();
  });

  it("logs instead of swallowing when the revoke rejects (a live token would stay issued)", async () => {
    const warnings: unknown[][] = [];
    const { synth } = makeSynth({
      revoke: () => Promise.reject(new Error("multiplexer down")),
    });

    await withAgentJobMcpConfig(cwd, synth, async () => "done", {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    });
    // The rejection is handled on a microtask — let it land.
    await Promise.resolve();
    await Promise.resolve();

    expect(warnings.length).toBeGreaterThan(0);
    expect(String(warnings[0][0])).toContain("revoke failed");
  });
});

describe("staticAgentMcpConfig", () => {
  const agents = [{ id: "plain" }, { id: "narrowed", mcp_config: "/etc/claudeclaw/servers.json" }];

  it("returns the operator's static config so the job path can skip synthesis", () => {
    // Without this, a job dispatched to `narrowed` would get the FULL
    // `mcp.shared` set the operator deliberately opted that agent out of,
    // and would never see the operator's own servers.
    expect(staticAgentMcpConfig("narrowed", agents)).toBe("/etc/claudeclaw/servers.json");
  });

  it("returns undefined for an agent with no static config (synthesis applies)", () => {
    expect(staticAgentMcpConfig("plain", agents)).toBeUndefined();
  });

  it("returns undefined for an agent absent from settings (dir-only agent)", () => {
    // `dispatch_job` validates against `agents/<name>/`, which can exist
    // without a matching `settings.agents` entry.
    expect(staticAgentMcpConfig("not-in-settings", agents)).toBeUndefined();
    expect(staticAgentMcpConfig("plain", [])).toBeUndefined();
  });

  it("keeps exactly one --mcp-config in the argv when a static config wins", () => {
    const args = buildAgentJobArgs({
      prompt: "p",
      securityArgs: [],
      persona: "",
      mcpConfigPath: staticAgentMcpConfig("narrowed", agents),
    });
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/etc/claudeclaw/servers.json");
  });
});

describe("buildAgentJobArgs", () => {
  const base = { prompt: "do the thing", securityArgs: ["--sec"], persona: "SOUL" };

  it("passes --mcp-config through to the spawned claude", () => {
    const args = buildAgentJobArgs({ ...base, mcpConfigPath: "/tmp/x/mcp-pty-agent-job-1.json" });
    const at = args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("/tmp/x/mcp-pty-agent-job-1.json");
  });

  it("omits the flag entirely when the multiplexer is dormant", () => {
    expect(buildAgentJobArgs(base)).not.toContain("--mcp-config");
    // Dormant argv is byte-identical to the pre-fix shape.
    expect(buildAgentJobArgs(base).slice(1)).toEqual([
      "-p",
      "do the thing",
      "--sec",
      "--append-system-prompt",
      "SOUL",
    ]);
  });
});
