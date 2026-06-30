import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupPlugin,
  loadOperatorEntries,
  BUILTIN_REGISTRY,
  type PluginEntry,
} from "../../wisecron/technique-plugin-registry.js";

let tmpRoot: string;
let regPath: string;
const VALID: PluginEntry = {
  technique: "my-technique",
  pluginId: "my-plugin",
  manager: "npm",
  source: "my-plugin@1.0.0",
  server: { command: "npx", args: ["-y", "my-plugin"] },
  description: "x",
  verified: true,
};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tpr-"));
  regPath = join(tmpRoot, "technique-plugins.json");
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("technique-plugin-registry", () => {
  it("resolves a built-in seed by technique", () => {
    const e = lookupPlugin("vectorized-retrieval", { registryPath: regPath });
    expect(e?.pluginId).toBe("mcp-server-qdrant");
    expect(e?.verified).toBe(false); // seeds are unverified by contract
  });

  it("returns null for an unmapped technique (→ caller emits detect-only)", () => {
    expect(lookupPlugin("no-such-technique", { registryPath: regPath })).toBeNull();
  });

  it("loads operator entries and they win over a same-id built-in", () => {
    const override: PluginEntry = {
      ...VALID,
      pluginId: "mcp-server-qdrant",
      technique: "vectorized-retrieval",
      verified: true,
    };
    writeFileSync(regPath, JSON.stringify([override]));
    const e = lookupPlugin("vectorized-retrieval", { registryPath: regPath });
    expect(e?.verified).toBe(true); // operator override applied
    expect(e?.source).toBe("my-plugin@1.0.0");
  });

  it("adds a brand-new operator technique", () => {
    writeFileSync(regPath, JSON.stringify([VALID]));
    expect(lookupPlugin("my-technique", { registryPath: regPath })?.pluginId).toBe("my-plugin");
  });

  it("malformed registry file → [] (never throws)", () => {
    writeFileSync(regPath, "{ not json");
    expect(loadOperatorEntries(regPath)).toEqual([]);
  });

  it("filters out structurally-invalid operator entries", () => {
    writeFileSync(regPath, JSON.stringify([{ technique: "t", pluginId: "p" }, VALID]));
    const all = loadOperatorEntries(regPath);
    expect(all).toHaveLength(1);
    expect(all[0]!.pluginId).toBe("my-plugin");
  });

  it("rejects an unknown manager", () => {
    writeFileSync(regPath, JSON.stringify([{ ...VALID, manager: "curl-pipe-bash" }]));
    expect(loadOperatorEntries(regPath)).toEqual([]);
  });

  it("built-in seeds are all unverified (forces a human verify at the gate)", () => {
    expect(BUILTIN_REGISTRY.every((e) => e.verified === false)).toBe(true);
  });
});
