import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TunableSubject } from "../core/interfaces.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class BaseSubject extends TunableSubject {
  protected async loadFrontmatter(
    filePath: string,
  ): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    const content = await readFile(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content };
    const yaml = await import("js-yaml");
    // Real-world frontmatter (e.g. ~/agent/agents/*.md) contains unquoted
    // values with embedded colons that js-yaml rejects as nested mappings.
    // A parse failure here used to abort the whole subject; treat it as a
    // missing frontmatter instead so one bad file doesn't zero the run.
    let parsed: unknown;
    try {
      parsed = yaml.load(match[1]!);
    } catch {
      return { frontmatter: {}, body: match[2]! };
    }
    return {
      frontmatter: (parsed != null && typeof parsed === "object" ? parsed : {}) as Record<
        string,
        unknown
      >,
      body: match[2]!,
    };
  }

  protected async scanMdFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    await this._scanDir(dir, results);
    return results;
  }

  private async _scanDir(dir: string, results: string[]): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this._scanDir(fullPath, results);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
}
