/**
 * #315: `settings.shutdown.drainTurnsMs` parses with the same shape as the
 * other numeric settings — default when absent or malformed, 0 allowed
 * (disables the drain), negatives rejected back to the default.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { copyFile, mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { getSettings, reloadSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.shutdown-drain-backup");

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

async function loadWith(shutdown: unknown): Promise<number> {
  const body: Record<string, unknown> = { runtime: "bus", agents: [{ id: "default" }] };
  if (shutdown !== undefined) body.shutdown = shutdown;
  await writeFile(SETTINGS_FILE, `${JSON.stringify(body, null, 2)}\n`);
  await reloadSettings();
  return getSettings().shutdown.drainTurnsMs;
}

describe("settings.shutdown.drainTurnsMs (#315)", () => {
  it("defaults to 30000 when the block is absent", async () => {
    expect(await loadWith(undefined)).toBe(30_000);
  });
  it("accepts 0 (drain disabled)", async () => {
    expect(await loadWith({ drainTurnsMs: 0 })).toBe(0);
  });
  it("accepts a positive value", async () => {
    expect(await loadWith({ drainTurnsMs: 5000 })).toBe(5000);
  });
  it("rejects negatives and non-numbers back to the default", async () => {
    expect(await loadWith({ drainTurnsMs: -1 })).toBe(30_000);
    expect(await loadWith({ drainTurnsMs: "soon" })).toBe(30_000);
  });
});
