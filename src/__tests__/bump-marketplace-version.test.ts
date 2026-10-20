import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/bump-marketplace-version.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Same shape and formatting as .claude-plugin/marketplace.json on main. */
function marketplaceText(pluginVersion: string, topLevel?: string): string {
  const doc: Record<string, unknown> = {
    name: "claudeclaw-plus",
    owner: { name: "TerrysPOV" },
    plugins: [
      {
        name: "claudeclaw-plus",
        source: "./",
        description: "fixture",
        version: pluginVersion,
        keywords: ["cron", "memory"],
        category: "productivity",
      },
    ],
  };
  if (topLevel !== undefined) doc.version = topLevel;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function runBump(text: string, bumpType?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "bump-marketplace-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".claude-plugin"));
  const file = join(cwd, ".claude-plugin", "marketplace.json");
  writeFileSync(file, text, "utf8");
  const args = ["bun", "run", SCRIPT, ...(bumpType ? [bumpType] : [])];
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    after: readFileSync(file, "utf8"),
  };
}

describe("bump-marketplace-version", () => {
  test("bumps the plugin entry and the top-level version together", () => {
    const r = runBump(marketplaceText("2.2.341", "2.2.341"));
    expect(r.exitCode).toBe(0);
    expect(r.after).toBe(marketplaceText("2.2.342", "2.2.342"));
    expect(r.stdout).not.toContain("out of step");
  });

  test("out of step, top-level higher: both become the bump of the higher", () => {
    const r = runBump(marketplaceText("2.2.340", "2.2.345"));
    expect(r.exitCode).toBe(0);
    expect(r.after).toBe(marketplaceText("2.2.346", "2.2.346"));
    expect(r.stdout).toContain("out of step");
  });

  test("out of step, plugin entry higher: both become the bump of the higher", () => {
    const r = runBump(marketplaceText("2.10.0", "2.9.7"));
    expect(r.exitCode).toBe(0);
    expect(r.after).toBe(marketplaceText("2.10.1", "2.10.1"));
    expect(r.stdout).toContain("out of step");
  });

  test("a missing top-level version stays missing", () => {
    const r = runBump(marketplaceText("2.2.341"));
    expect(r.exitCode).toBe(0);
    expect(r.after).toBe(marketplaceText("2.2.342"));
    expect(JSON.parse(r.after)).not.toHaveProperty("version");
  });

  test("minor bump resets patch on both fields", () => {
    const r = runBump(marketplaceText("2.2.341", "2.2.341"), "minor");
    expect(r.after).toBe(marketplaceText("2.3.0", "2.3.0"));
  });

  test("major bump resets minor and patch on both fields", () => {
    const r = runBump(marketplaceText("2.2.341", "2.2.341"), "major");
    expect(r.after).toBe(marketplaceText("3.0.0", "3.0.0"));
  });

  test("only the version fields change (byte-identical otherwise, trailing newline kept)", () => {
    const before = marketplaceText("2.2.341", "2.2.341");
    const r = runBump(before);
    expect(r.after.endsWith("}\n")).toBe(true);
    expect(r.after.replaceAll("2.2.342", "2.2.341")).toBe(before);
  });

  test("an unknown bump type fails and leaves the file alone", () => {
    const before = marketplaceText("2.2.341", "2.2.341");
    const r = runBump(before, "bogus");
    expect(r.exitCode).toBe(1);
    expect(r.after).toBe(before);
  });
});
