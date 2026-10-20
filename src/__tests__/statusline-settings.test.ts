import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  STATUSLINE_SETTING,
  ensureStatuslineSetting,
  removeStatuslineSetting,
} from "../statusline-settings";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "statusline-settings-"));
  file = join(dir, "settings.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Back-date the file so an unwanted rewrite would visibly move its mtime.
async function backdate(path: string): Promise<number> {
  const past = new Date(Date.now() - 3_600_000);
  await utimes(path, past, past);
  return (await stat(path)).mtimeMs;
}

const INVALID = '{\n  // hand edit in progress\n  "permissions": { "allow": ["Bash(ls)"], },\n}\n';

describe("ensureStatuslineSetting", () => {
  test("leaves a settings file that does not parse byte-identical", async () => {
    await writeFile(file, INVALID);
    const mtime = await backdate(file);
    expect(await ensureStatuslineSetting(file)).toBe("skipped-invalid");
    expect(await readFile(file, "utf8")).toBe(INVALID);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test("leaves a non-object JSON file untouched", async () => {
    await writeFile(file, "[1, 2]\n");
    expect(await ensureStatuslineSetting(file)).toBe("skipped-invalid");
    expect(await readFile(file, "utf8")).toBe("[1, 2]\n");
  });

  test("accepts a settings file with a UTF-8 BOM", async () => {
    await writeFile(file, '\uFEFF{"env":{"A":"b"}}');
    expect(await ensureStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      env: { A: "b" },
      statusLine: STATUSLINE_SETTING,
    });
  });

  test("treats an empty settings file as missing", async () => {
    await writeFile(file, "  \n");
    expect(await ensureStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ statusLine: STATUSLINE_SETTING });
  });

  test("creates the file when it is missing", async () => {
    expect(await ensureStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ statusLine: STATUSLINE_SETTING });
  });

  test("keeps every other key and adds statusLine", async () => {
    const before = { permissions: { allow: ["Bash(ls)"] }, env: { FOO: "1" }, hooks: {} };
    await writeFile(file, JSON.stringify(before));
    expect(await ensureStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...before,
      statusLine: STATUSLINE_SETTING,
    });
  });

  test("does not rewrite a file that already has the same statusLine (content + mtime)", async () => {
    // Deliberately not our serialisation: 4-space indent, statusLine first.
    const content = `{\n    "statusLine": ${JSON.stringify(STATUSLINE_SETTING)},\n    "env": {"A": "b"}\n}\n`;
    await writeFile(file, content);
    const mtime = await backdate(file);
    expect(await ensureStatuslineSetting(file)).toBe("unchanged");
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test("replaces a different statusLine value", async () => {
    await writeFile(file, JSON.stringify({ statusLine: { type: "command", command: "other" } }));
    expect(await ensureStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8")).statusLine).toEqual(STATUSLINE_SETTING);
  });

  test("start, stop, start leaves the file as the first start wrote it", async () => {
    await writeFile(file, JSON.stringify({ env: { A: "b" } }, null, 2) + "\n");
    await ensureStatuslineSetting(file);
    const afterFirstStart = await readFile(file, "utf8");
    await removeStatuslineSetting(file);
    await ensureStatuslineSetting(file);
    expect(await readFile(file, "utf8")).toBe(afterFirstStart);
  });
});

describe("removeStatuslineSetting", () => {
  test("leaves a settings file that does not parse byte-identical", async () => {
    await writeFile(file, INVALID);
    const mtime = await backdate(file);
    expect(await removeStatuslineSetting(file)).toBe("skipped-invalid");
    expect(await readFile(file, "utf8")).toBe(INVALID);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test("does not create a missing file", async () => {
    expect(await removeStatuslineSetting(file)).toBe("unchanged");
    expect(existsSync(file)).toBe(false);
  });

  test("does not rewrite a file without statusLine", async () => {
    const content = '{"env":{"A":"b"}}';
    await writeFile(file, content);
    const mtime = await backdate(file);
    expect(await removeStatuslineSetting(file)).toBe("unchanged");
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test("removes statusLine and keeps the other keys", async () => {
    await writeFile(file, JSON.stringify({ env: { A: "b" }, statusLine: STATUSLINE_SETTING }));
    expect(await removeStatuslineSetting(file)).toBe("written");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ env: { A: "b" } });
  });
});
