import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  allowlistStartupWarnings,
  describeAllowlist,
  emptyAllowlistWarning,
  isUserAllowed,
} from "../allowlist";
import { getSettings, reloadSettings } from "../config";

describe("isUserAllowed", () => {
  it("refuses everyone when the list is empty", () => {
    expect(isUserAllowed([], 42)).toBe(false);
    expect(isUserAllowed(new Set<string>(), "U1")).toBe(false);
  });

  it("accepts members only when the list is set", () => {
    expect(isUserAllowed([42], 42)).toBe(true);
    expect(isUserAllowed([42], 7)).toBe(false);
    expect(isUserAllowed(new Set(["U1"]), "U1")).toBe(true);
    expect(isUserAllowed(new Set(["U1"]), "U2")).toBe(false);
  });

  it("refuses a missing user id", () => {
    expect(isUserAllowed([42], undefined)).toBe(false);
    expect(isUserAllowed(["a"], null)).toBe(false);
  });

  it("accepts anyone, missing id included, with allowAllUsers", () => {
    expect(isUserAllowed([], 42, true)).toBe(true);
    expect(isUserAllowed([], undefined, true)).toBe(true);
  });
});

describe("startup messaging", () => {
  it("describes the list for banners", () => {
    expect(describeAllowlist([])).toMatch(/none/);
    expect(describeAllowlist([1, 2])).toBe("1, 2");
    expect(describeAllowlist([], true)).toMatch(/^all/);
  });

  it("warns with the migration path when the list is empty", () => {
    const w = emptyAllowlistWarning("telegram", []);
    expect(w).toContain("telegram.allowedUserIds");
    expect(w).toContain("telegram.allowAllUsers: true");
    expect(emptyAllowlistWarning("telegram", [1])).toBeNull();
    expect(emptyAllowlistWarning("telegram", [], true)).toBeNull();
  });

  it("only warns for platforms that are configured", () => {
    const warnings = allowlistStartupWarnings({
      telegram: { token: "t", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      slack: { botToken: "x", allowedUserIds: ["U1"] },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("telegram");
  });

  it("does not warn for a send-only Telegram bot", () => {
    const warnings = allowlistStartupWarnings({
      telegram: { token: "t", receiveEnabled: false, allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      slack: { botToken: "", allowedUserIds: [] },
    });
    expect(warnings).toHaveLength(0);
  });
});

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.allowlist-backup");

async function loadRaw(body: unknown) {
  await writeFile(SETTINGS_FILE, `${JSON.stringify(body, null, 2)}\n`);
  await reloadSettings();
  return getSettings();
}

describe("settings: allowAllUsers", () => {
  beforeAll(async () => {
    await mkdir(SETTINGS_DIR, { recursive: true });
    if (existsSync(SETTINGS_FILE)) await copyFile(SETTINGS_FILE, BACKUP_FILE);
  });

  afterAll(async () => {
    if (existsSync(BACKUP_FILE)) {
      await copyFile(BACKUP_FILE, SETTINGS_FILE);
      await unlink(BACKUP_FILE);
    } else if (existsSync(SETTINGS_FILE)) {
      await unlink(SETTINGS_FILE);
    }
    try {
      await reloadSettings();
    } catch {
      /* ok — restore may have removed the file */
    }
  });

  it("is off unless set to exactly true", async () => {
    const off = await loadRaw({ telegram: { allowAllUsers: "yes" } });
    expect(off.telegram.allowAllUsers).toBeUndefined();
    expect(off.discord.allowAllUsers).toBeUndefined();
    expect(off.slack.allowAllUsers).toBeUndefined();
  });

  it("is parsed per platform", async () => {
    const on = await loadRaw({
      telegram: { allowAllUsers: true },
      discord: { allowAllUsers: true },
      slack: { allowAllUsers: true },
    });
    expect(on.telegram.allowAllUsers).toBe(true);
    expect(on.discord.allowAllUsers).toBe(true);
    expect(on.slack.allowAllUsers).toBe(true);
  });
});
