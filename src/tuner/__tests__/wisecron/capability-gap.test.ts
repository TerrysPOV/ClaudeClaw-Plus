import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCapabilityGaps } from "../../wisecron/capability-gap.js";
import { lookupCapability } from "../../wisecron/technique-plugin-registry.js";
import { McpPluginSubject } from "../../subjects/mcp-plugin-subject.js";

let dir: string;
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const toolLine = (name: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name }] },
  });
function session(file: string, lines: string[]): void {
  const sdir = join(dir, "proj");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, file), `${lines.join("\n")}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capgap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detectCapabilityGaps", () => {
  it("flags research-intent prompts in a session with no search tool", () => {
    session("a.jsonl", [
      userLine("what's the latest version of bun"),
      userLine("can you google it for me"),
    ]);
    const [gap] = detectCapabilityGaps({ transcriptDirs: [dir] });
    expect(gap.capability).toBe("web_search");
    expect(gap.unmetIntentCount).toBe(2);
    expect(gap.sessionsWithGap).toBe(1);
    expect(gap.examples.length).toBe(2);
  });

  it("does NOT flag when a satisfying tool was used in the session", () => {
    session("b.jsonl", [
      userLine("what's the latest version of bun"),
      toolLine("brave_web_search"),
    ]);
    const [gap] = detectCapabilityGaps({ transcriptDirs: [dir] });
    expect(gap.unmetIntentCount).toBe(0);
    expect(gap.sessionsWithGap).toBe(0);
  });

  it("does NOT flag a session with no research intent", () => {
    session("c.jsonl", [userLine("rename this variable to totalCount")]);
    const [gap] = detectCapabilityGaps({ transcriptDirs: [dir] });
    expect(gap.unmetIntentCount).toBe(0);
  });

  it("ignores malformed lines and missing dirs without throwing", () => {
    session("d.jsonl", ["not json {{{", userLine("look it up online please")]);
    const gaps = detectCapabilityGaps({ transcriptDirs: [dir, join(dir, "does-not-exist")] });
    expect(gaps[0].unmetIntentCount).toBe(1);
  });
});

describe("lookupCapability (approved-list gate)", () => {
  it("returns nothing for an unverified seed by default (approved-only)", () => {
    // Brave/Perplexity seeds ship verified:false → not surfaced unless approved.
    expect(lookupCapability("web_search", { registryPath: join(dir, "none.json") })).toHaveLength(
      0,
    );
  });

  it("surfaces seeds when includeUnverified is set (shown as UNVERIFIED)", () => {
    const got = lookupCapability("web_search", {
      registryPath: join(dir, "none.json"),
      includeUnverified: true,
    });
    expect(got.map((e) => e.pluginId).sort()).toEqual(["brave-search", "perplexity-ask"]);
  });

  it("wires a detected gap through mcp_plugin into an install proposal", async () => {
    const noRegistry = join(dir, "no-registry.json");
    const sub = new McpPluginSubject({
      auditReader: () => [],
      registryPath: noRegistry,
      gapDetector: () => [
        {
          capability: "web_search",
          unmetIntentCount: 5,
          sessionsScanned: 10,
          sessionsWithGap: 3,
          examples: ["what's the latest bun version"],
        },
      ],
    });
    const obs = await sub.collectObservations(new Date(0));
    const capObs = obs.filter(
      (o) => (o.metadata as Record<string, unknown>).kind === "capability_gap",
    );
    expect(capObs).toHaveLength(1);
    const clusters = await sub.detectProblems(obs);
    const gapCluster = clusters.find((c) => c.id.startsWith("mcp-capability-gap"));
    expect(gapCluster).toBeDefined();
    const prop = await sub.proposeChange(gapCluster as NonNullable<typeof gapCluster>);
    // No approved entry → seeds surface as UNVERIFIED install options carrying an install spec.
    expect(prop.alternatives.some((a) => a.id.startsWith("install:"))).toBe(true);
    expect(prop.alternatives.some((a) => a.diff_or_content.includes("install-plugin"))).toBe(true);
  });

  it("does not raise a gap observation below the min threshold", async () => {
    const sub = new McpPluginSubject({
      auditReader: () => [],
      capabilityGapMin: 10,
      gapDetector: () => [
        {
          capability: "web_search",
          unmetIntentCount: 2,
          sessionsScanned: 5,
          sessionsWithGap: 1,
          examples: [],
        },
      ],
    });
    const obs = await sub.collectObservations(new Date(0));
    expect(
      obs.filter((o) => (o.metadata as Record<string, unknown>).kind === "capability_gap"),
    ).toHaveLength(0);
  });

  it("returns an operator-approved (verified) entry", () => {
    const opFile = join(dir, "op.json");
    writeFileSync(
      opFile,
      JSON.stringify([
        {
          technique: "web-search",
          capability: "web_search",
          pluginId: "brave-search",
          manager: "npm",
          source: "@modelcontextprotocol/server-brave-search@0.6.2",
          server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"] },
          description: "Brave web search",
          verified: true,
        },
      ]),
    );
    const got = lookupCapability("web_search", { registryPath: opFile });
    expect(got).toHaveLength(1);
    expect(got[0].pluginId).toBe("brave-search");
    expect(got[0].verified).toBe(true);
  });
});
