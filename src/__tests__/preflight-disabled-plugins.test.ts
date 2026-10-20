import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// preflight.ts resolves ~/.claude/plugins from HOME when it loads, and bun reads
// HOME once per process: each call runs in a child process with a throwaway HOME,
// so a failing test can never touch the real plugin registry.
const home = mkdtempSync(join(tmpdir(), "preflight-home-"));
const pluginsDir = join(home, ".claude", "plugins");
const instFile = join(pluginsDir, "installed_plugins.json");
const modulePath = join(import.meta.dir, "..", "preflight.ts");

function call(fn: "installRepoPlugin" | "installOfficialPlugins", ...args: unknown[]): unknown {
  const script = `const m = await import(${JSON.stringify(modulePath)});
const r = m.${fn}(...${JSON.stringify(args)});
console.log("RESULT " + JSON.stringify(r));`;
  const res = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`preflight call failed: ${res.stderr}`);
  return JSON.parse(line.slice("RESULT ".length));
}

let project: string;
let repoUrl: string;
const repoKey = "demo-plugin@demo-market";
const officialKey = "demo-official@claude-plugins-official";

function writeSettings(enabledPlugins: Record<string, boolean> | undefined): string {
  const file = join(project, ".claude", "settings.json");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const body = `${JSON.stringify(enabledPlugins ? { enabledPlugins } : {}, null, 2)}\n`;
  writeFileSync(file, body);
  return body;
}

function readSettings(): string {
  return readFileSync(join(project, ".claude", "settings.json"), "utf-8");
}

function installed(): Record<string, unknown> {
  if (!existsSync(instFile)) return {};
  return JSON.parse(readFileSync(instFile, "utf-8")).plugins ?? {};
}

function markCached(key: string): void {
  const cacheDir = join(pluginsDir, "cache", key);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    instFile,
    JSON.stringify({ version: 2, plugins: { [key]: [{ installPath: cacheDir }] } }),
  );
}

beforeAll(() => {
  // A local plugin repo, so installRepoPlugin clones without the network.
  const repo = mkdtempSync(join(tmpdir(), "preflight-repo-"));
  mkdirSync(join(repo, ".claude-plugin"));
  writeFileSync(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "demo-market", plugins: [{ name: "demo-plugin" }] }),
  );
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", {
    cwd: repo,
  });
  repoUrl = repo;
});

beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
  // preflight() creates these before installing anything.
  mkdirSync(join(pluginsDir, "marketplaces"), { recursive: true });
  mkdirSync(join(pluginsDir, "cache"), { recursive: true });
  project = mkdtempSync(join(tmpdir(), "preflight-project-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoUrl, { recursive: true, force: true });
});

describe("preflight — repo plugins", () => {
  test("key set to false: no install, settings untouched", () => {
    const before = writeSettings({ [repoKey]: false });
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("skipped");
    expect(readSettings()).toBe(before);
    expect(installed()[repoKey]).toBeUndefined();
    expect(existsSync(join(pluginsDir, "marketplaces", "demo-market"))).toBe(false);
  });

  test("key set to false and cached: not re-enabled", () => {
    markCached(repoKey);
    const before = writeSettings({ [repoKey]: false });
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("skipped");
    expect(readSettings()).toBe(before);
  });

  test("key absent: installed and enabled, as before", () => {
    writeSettings(undefined);
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("installed");
    expect(installed()[repoKey]).toBeDefined();
    expect(JSON.parse(readSettings()).enabledPlugins[repoKey]).toBe(true);
  });
});

describe("preflight — a settings.json that does not parse (#512)", () => {
  const raw = '{\n  // operator note\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n';

  test("is never written over", () => {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), raw);
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("installed");
    expect(readSettings()).toBe(raw);
  });

  test("a BOM file with the key set to false: opt-out honoured", () => {
    mkdirSync(join(project, ".claude"), { recursive: true });
    const before = `\uFEFF${JSON.stringify({ enabledPlugins: { [repoKey]: false } })}`;
    writeFileSync(join(project, ".claude", "settings.json"), before);
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("skipped");
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8")).toBe(before);
  });

  test("a BOM is accepted and the plugin enabled, other keys kept", () => {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.json"),
      `\uFEFF${JSON.stringify({ permissions: { allow: ["x"] } })}`,
    );
    expect(call("installRepoPlugin", repoUrl, project, "bun")).toBe("installed");
    const after = JSON.parse(readSettings());
    expect(after.enabledPlugins[repoKey]).toBe(true);
    expect(after.permissions).toEqual({ allow: ["x"] });
  });
});

describe("preflight — official plugins", () => {
  test("key set to false and cached: skipped, settings untouched", () => {
    markCached(officialKey);
    const before = writeSettings({ [officialKey]: false });
    expect(call("installOfficialPlugins", ["demo-official"], project, "bun")).toEqual({
      installed: 0,
      skipped: 1,
    });
    expect(readSettings()).toBe(before);
  });

  test("key absent and cached: enabled, as before", () => {
    markCached(officialKey);
    writeSettings(undefined);
    expect(call("installOfficialPlugins", ["demo-official"], project, "bun")).toEqual({
      installed: 1,
      skipped: 0,
    });
    expect(JSON.parse(readSettings()).enabledPlugins[officialKey]).toBe(true);
  });
});
