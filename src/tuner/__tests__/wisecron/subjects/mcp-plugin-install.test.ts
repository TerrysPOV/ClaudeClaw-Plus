import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPluginSubject, type PluginInstaller } from "../../../subjects/mcp-plugin-subject.js";
import type { Proposal } from "../../../../skills-tuner/core/types.js";

let tmpRoot: string;
let settingsPath: string;
let pluginsDir: string;
let installerCalls: Array<{ manager: string; source: string; destDir: string }>;

/** Fake installer: records the call and drops a marker file in destDir (success). */
const okInstaller: PluginInstaller = (s) => {
  installerCalls.push(s);
  mkdirSync(s.destDir, { recursive: true });
  writeFileSync(join(s.destDir, "INSTALLED"), s.source);
  return { ok: true, output: "ok" };
};
const failInstaller: PluginInstaller = (s) => {
  installerCalls.push(s);
  return { ok: false, output: "boom" };
};

function installProposal(target: string, pluginId = "mcp-server-qdrant"): Proposal {
  const spec = {
    op: "install-plugin",
    pluginId,
    manager: "git",
    source: "https://github.com/qdrant/mcp-server-qdrant",
    server: { command: "uvx", args: ["mcp-server-qdrant"] },
  };
  return {
    id: 1,
    cluster_id: "c",
    subject: "mcp_plugin",
    kind: "patch",
    target_path: target,
    alternatives: [
      {
        id: "install-plugin",
        label: "install",
        diff_or_content: JSON.stringify(spec),
        tradeoff: "",
      },
    ],
    pattern_signature: "plugin-install:test",
    created_at: new Date(),
  } as unknown as Proposal;
}

function subject(installer: PluginInstaller) {
  return new McpPluginSubject({ settingsPath, managedPluginsDir: pluginsDir, installer });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mcpinst-"));
  settingsPath = join(tmpRoot, "settings.json");
  pluginsDir = join(tmpRoot, "plugins");
  installerCalls = [];
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("McpPluginSubject — real plugin install (confined + reversible)", () => {
  it("installs into the managed dir + registers the server in settings + records a manifest", async () => {
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: ["x"] }));
    const sub = subject(okInstaller);
    const patch = await sub.apply(installProposal(settingsPath), "install-plugin");

    expect(installerCalls).toHaveLength(1);
    expect(existsSync(join(pluginsDir, "mcp-server-qdrant", "INSTALLED"))).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.mcpServers["mcp-server-qdrant"]).toEqual({
      command: "uvx",
      args: ["mcp-server-qdrant"],
    });
    expect(settings.allowedTools).toEqual(["x"]); // pre-existing config preserved
    expect(patch.kind).toBe("plugin_install");
    const manifest = JSON.parse(readFileSync(join(pluginsDir, "installed.json"), "utf8"));
    expect(manifest[0].pluginId).toBe("mcp-server-qdrant");
  });

  it("install FAILURE → throws, settings untouched, dir cleaned (no dangling entry)", async () => {
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: [] }));
    const sub = subject(failInstaller);
    await expect(sub.apply(installProposal(settingsPath), "install-plugin")).rejects.toThrow(
      /install failed/,
    );
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.mcpServers).toBeUndefined();
    expect(existsSync(join(pluginsDir, "mcp-server-qdrant"))).toBe(false);
  });

  it("revert restores settings AND uninstalls the plugin dir (reconcile)", async () => {
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: [] }));
    const sub = subject(okInstaller);
    const inverseContent = await sub.snapshotInverse(settingsPath); // pre-install snapshot
    await sub.apply(installProposal(settingsPath), "install-plugin");
    expect(existsSync(join(pluginsDir, "mcp-server-qdrant"))).toBe(true);

    await sub.revert({
      target_path: settingsPath,
      kind: "plugin_install_inverse",
      applied_content: inverseContent,
    });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.mcpServers).toBeUndefined(); // entry gone
    expect(existsSync(join(pluginsDir, "mcp-server-qdrant"))).toBe(false); // uninstalled
    expect(JSON.parse(readFileSync(join(pluginsDir, "installed.json"), "utf8"))).toEqual([]);
  });

  it("CONFINEMENT: apply refuses a target_path that is not the managed settings", async () => {
    const sub = subject(okInstaller);
    const foreign = join(tmpRoot, "evil", "engine.ts");
    await expect(sub.apply(installProposal(foreign), "install-plugin")).rejects.toThrow(
      /not the managed settings/,
    );
    expect(installerCalls).toHaveLength(0); // never ran the installer
  });

  it("CONFINEMENT: a traversal pluginId is sanitized, install stays inside managed dir", async () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const sub = subject(okInstaller);
    await sub.apply(installProposal(settingsPath, "../../etc/evil"), "install-plugin");
    // destDir was sanitized to a single safe segment under pluginsDir
    const dest = installerCalls[0]!.destDir;
    expect(dest.startsWith(join(pluginsDir) + "/")).toBe(true);
    expect(dest).not.toContain("..");
  });

  it("the allowedTools path still works + is also confined", async () => {
    writeFileSync(settingsPath, JSON.stringify({ allowedTools: [] }));
    const sub = subject(okInstaller);
    const p = {
      id: 2,
      cluster_id: "c",
      subject: "mcp_plugin",
      kind: "patch",
      target_path: settingsPath,
      alternatives: [
        {
          id: "a",
          label: "l",
          diff_or_content: JSON.stringify({ allowedTools: ["y"] }),
          tradeoff: "",
        },
      ],
      pattern_signature: "s",
      created_at: new Date(),
    } as unknown as Proposal;
    const patch = await sub.apply(p, "a");
    expect(JSON.parse(patch.applied_content).allowedTools).toEqual(["y"]);
    expect(installerCalls).toHaveLength(0); // not an install
  });
});
