import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUserAllowed } from "../allowlist";
import {
  _resetTelegramIdsWarningsForTests,
  _setSettingsFileForTests,
  reloadSettings,
} from "../config";

/**
 * `telegram.allowedUserIds` through the REAL settings loader. Taken as-is, a
 * string written by mistake reached the legacy runtime's `includes` check and
 * allowed any user whose id is a substring of it; a bare number threw there.
 *
 * A malformed value must not collapse to `[]`: it becomes `[0]`, which allows
 * nobody and is not reported as an empty list at startup.
 */

// The allow check every gate of both runtimes uses (`src/allowlist.ts`).
function allows(ids: number[], userId: number): boolean {
  return isUserAllowed(ids, userId);
}

describe("settings loader — telegram.allowedUserIds", () => {
  let dir: string | null = null;

  // Reset before too: a test file that ran earlier may have left a warning recorded.
  beforeEach(() => _resetTelegramIdsWarningsForTests());

  afterEach(() => {
    _setSettingsFileForTests(undefined);
    _resetTelegramIdsWarningsForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function loadWith(allowedUserIds: unknown) {
    dir = mkdtempSync(join(tmpdir(), "ccplus-settings-telegram-ids-"));
    const file = join(dir, "settings.json");
    const telegram = allowedUserIds === undefined ? { token: "t" } : { token: "t", allowedUserIds };
    writeFileSync(file, JSON.stringify({ telegram }));
    _setSettingsFileForTests(file);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const settings = await reloadSettings();
      return { ids: settings.telegram.allowedUserIds, warnings: warn.mock.calls.map(String) };
    } finally {
      warn.mockRestore();
    }
  }

  it("a string is not a list: nobody is allowed, not a substring of it", async () => {
    const { ids, warnings } = await loadWith("4242424242");
    expect(Array.isArray(ids)).toBe(true);
    expect(allows(ids, 424242)).toBe(false);
    expect(allows(ids, 4242424242)).toBe(false);
    expect(warnings.some((w) => w.includes("telegram.allowedUserIds must be a list"))).toBe(true);
  });

  it("a bare number is not a list either: nobody is allowed and the check does not throw", async () => {
    const { ids } = await loadWith(4242424242);
    expect(Array.isArray(ids)).toBe(true);
    expect(allows(ids, 4242424242)).toBe(false);
  });

  it("keeps integer ids and digit-only strings, drops everything else with a warning", async () => {
    const { ids, warnings } = await loadWith([123, " 4567 ", "abc", 1.5, 0, null, "12x"]);
    expect(ids).toEqual([123, 4567]);
    expect(allows(ids, 4567)).toBe(true);
    expect(allows(ids, 999)).toBe(false);
    expect(warnings.some((w) => w.includes("ignored 5 entry(ies)"))).toBe(true);
  });

  it("keeps negative (group chat) ids: they forward job output and never match a sender", async () => {
    const { ids, warnings } = await loadWith([-1001234567890, "-42", 111]);
    expect(ids).toEqual([-1001234567890, -42, 111]);
    expect(allows(ids, 111)).toBe(true);
    expect(allows(ids, 1001234567890)).toBe(false);
    expect(warnings.filter((w) => w.includes("telegram.allowedUserIds"))).toEqual([]);
  });

  it("a list with no valid id allows nobody, it does not fall back to allow-all", async () => {
    const { ids, warnings } = await loadWith(["abc", 0, 1.5]);
    expect(ids.length).toBeGreaterThan(0);
    expect(allows(ids, 424242)).toBe(false);
    // The deny-all placeholder: no Telegram sender has id 0.
    expect(ids).toEqual([0]);
    expect(warnings.some((w) => w.includes("has no valid user id"))).toBe(true);
  });

  it("warns once per distinct problem, not on every 30 s hot-reload", async () => {
    const first = await loadWith(true);
    const second = await loadWith(true);
    expect(first.ids).toEqual([0]);
    expect(second.ids).toEqual([0]);
    expect(first.warnings.filter((w) => w.includes("got a boolean"))).toHaveLength(1);
    expect(second.warnings.filter((w) => w.includes("telegram.allowedUserIds"))).toEqual([]);
  });

  it("a value that goes bad again after a fix warns again", async () => {
    expect((await loadWith("x")).warnings.some((w) => w.includes("got a string"))).toBe(true);
    expect((await loadWith([111])).warnings).toEqual([]);
    expect((await loadWith("x")).warnings.some((w) => w.includes("got a string"))).toBe(true);
  });

  it("a valid list loads unchanged and silently", async () => {
    const { ids, warnings } = await loadWith([111, 222]);
    expect(ids).toEqual([111, 222]);
    expect(warnings.filter((w) => w.includes("telegram.allowedUserIds"))).toEqual([]);
  });

  it("absent or an explicit empty list → empty, which refuses everyone, no warning", async () => {
    for (const value of [undefined, []]) {
      const { ids, warnings } = await loadWith(value);
      expect(ids).toEqual([]);
      expect(allows(ids, 111)).toBe(false);
      expect(warnings.filter((w) => w.includes("telegram.allowedUserIds"))).toEqual([]);
    }
  });
});
