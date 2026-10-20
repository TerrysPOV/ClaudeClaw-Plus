/**
 * #376: `settings.session.gatewayScope` parses to exactly two values —
 * `"conversation"` opts a deployment into one runner session per gateway
 * conversation; anything else (absent, malformed, any other word) is
 * `"global"`, the shared session every gateway turn resumed before #376.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSettings, reloadSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.gateway-scope-backup");

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

async function loadWith(session: unknown): Promise<string> {
  const body: Record<string, unknown> = { runtime: "bus", agents: [{ id: "default" }] };
  if (session !== undefined) body.session = session;
  await writeFile(SETTINGS_FILE, `${JSON.stringify(body, null, 2)}\n`);
  await reloadSettings();
  return getSettings().session.gatewayScope;
}

describe("settings.session.gatewayScope (#376)", () => {
  it("defaults to global when the block or the key is absent", async () => {
    expect(await loadWith(undefined)).toBe("global");
    expect(await loadWith({ autoRotate: false })).toBe("global");
  });
  it("accepts the opt-in word", async () => {
    expect(await loadWith({ gatewayScope: "conversation" })).toBe("conversation");
  });
  it("anything else stays global", async () => {
    expect(await loadWith({ gatewayScope: "Conversation" })).toBe("global");
    expect(await loadWith({ gatewayScope: true })).toBe("global");
    expect(await loadWith({ gatewayScope: "thread" })).toBe("global");
  });
});
