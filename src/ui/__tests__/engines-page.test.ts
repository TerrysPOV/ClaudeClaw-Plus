/**
 * Engines modal (#552): the Settings entry and the modal are in the page,
 * every element the script wires exists, and every write goes through
 * mutatingFetch (CSRF + token).
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageScript } from "../page/script";
import { pageStyles } from "../page/styles";
import { htmlPage } from "../page/template";
import { writeSettingsAtomic } from "../../settings-json";

const page = htmlPage("test-nonce");
// The markup only: the page also inlines the script, which names the ids too.
const pageTemplate = page.slice(0, page.indexOf("<script"));
const enScript = pageScript.slice(pageScript.indexOf("(function enInit()"));

describe("Engines modal", () => {
  it("has a Settings entry next to LLM Router and its own modal with the three blocks", () => {
    const settings = pageTemplate.slice(
      pageTemplate.indexOf('id="settings-modal"'),
      pageTemplate.indexOf("</aside>"),
    );
    expect(settings.indexOf('id="lr-config"')).toBeLessThan(settings.indexOf('id="en-config"'));
    for (const id of ["en-modal", "en-agent-block", "en-oneshot-block", "en-engines-block"])
      expect(pageTemplate).toContain(`id="${id}"`);
  });

  it("wires only elements that exist in the template", () => {
    const ids = [...enScript.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(15);
    for (const id of ids) expect(pageTemplate).toContain(`id="${id}"`);
  });

  it("writes through mutatingFetch only, to the three endpoints", () => {
    expect(enScript).toContain('postJson("/api/settings/oneshot"');
    expect(enScript).toContain('postJson("/api/settings/engines"');
    expect(enScript).toContain('postJson("/api/oneshot/test"');
    const postJson = enScript.slice(enScript.indexOf("async function postJson"));
    expect(postJson.slice(0, 200)).toContain("mutatingFetch(url");
    expect(enScript).not.toMatch(/fetch\([^)]*method:\s*"POST"/);
  });

  it("never asks for the key itself, only the name of its variable", () => {
    const form = pageTemplate.slice(
      pageTemplate.indexOf('id="en-engine-form"'),
      pageTemplate.indexOf("</form>", pageTemplate.indexOf('id="en-engine-form"')),
    );
    expect(form).toContain('id="en-keyenv-input"');
    expect(form).not.toMatch(/type="password"|apiKey"/);
    expect(enScript).toContain("config.apiKeyEnv = keyEnv");
    expect(enScript).not.toContain("config.apiKey =");
  });

  it("parses, and styles the modal", () => {
    expect(() => new Function(pageScript)).not.toThrow();
    expect(pageStyles).toContain(".en-route");
  });
});

describe("writeSettingsAtomic", () => {
  it("replaces the file whole and keeps its mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-552-"));
    try {
      const file = join(dir, "settings.json");
      await writeFile(file, "{}\n", { mode: 0o640 });
      await writeSettingsAtomic(file, { a: 1 });
      expect(await readFile(file, "utf-8")).toBe('{\n  "a": 1\n}\n');
      expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o640);
      expect(await readdir(dir)).toEqual(["settings.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the old content and no temp file when the rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-552-"));
    try {
      // A non-empty directory where the file should be: rename over it fails.
      const target = join(dir, "settings.json");
      await mkdir(target);
      await writeFile(join(target, "keep"), "x");
      await expect(writeSettingsAtomic(target, { a: 1 })).rejects.toThrow();
      expect(await readdir(dir)).toEqual(["settings.json"]);
      expect(await readFile(join(target, "keep"), "utf-8")).toBe("x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
