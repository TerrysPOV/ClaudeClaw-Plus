/**
 * #376: a conversation that goes through the gateway resumes the session the
 * gateway gives it — so the slash commands (/reset, /compact, /status,
 * /context) must act on that session, not on the legacy key the direct path
 * uses. Found by the adversarial pass on the PR: with the flag on, `/reset`
 * in a private Telegram chat unlinked the GLOBAL session (cron, heartbeat,
 * every other gateway-global turn) and left the chat's own session intact.
 *
 * Settings are read through `getSettings()`, so the file under the cwd is
 * written for the run and put back afterwards, like the other config tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSettings, reloadSettings } from "../config";
import { gatewayCommandSessionKey } from "../event-processor";
import { discordConversation, telegramConversation } from "../gateway/normalizer";
import { interactionSessionKey } from "../commands/discord";
import { telegramSessionKey } from "../commands/telegram";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.command-key-backup");

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

async function withScope(scope: "global" | "conversation"): Promise<void> {
  const body = { runtime: "bus", agents: [{ id: "default" }], session: { gatewayScope: scope } };
  await writeFile(SETTINGS_FILE, `${JSON.stringify(body, null, 2)}\n`);
  await reloadSettings();
  expect(getSettings().session.gatewayScope).toBe(scope);
}

describe("gatewayCommandSessionKey (#376)", () => {
  it("is the turn's own key under conversation scope, the global session otherwise", () => {
    const tg = telegramConversation(123, 42);
    expect(gatewayCommandSessionKey(tg, { gatewayScope: "conversation" })).toBe("telegram:123:42");
    expect(gatewayCommandSessionKey(tg, { gatewayScope: "global" })).toBeUndefined();
    const dc = discordConversation("g1", "c2");
    expect(gatewayCommandSessionKey(dc, { gatewayScope: "conversation" })).toBe(
      "discord:guild:g1:c2:c2",
    );
  });
});

describe("the slash commands target the session the next message resumes (#376)", () => {
  it("Telegram, gateway on: the conversation's session under conversation scope, global otherwise; the legacy tg: key never", async () => {
    await withScope("conversation");
    // private chat — the case that used to reset the GLOBAL session
    expect(telegramSessionKey(555, undefined, 9, true, "shared", true)).toBe(
      "telegram:555:default",
    );
    // group topic
    expect(telegramSessionKey(-100777, 42, 9, false, "shared", true)).toBe("telegram:-100777:42");
    await withScope("global");
    expect(telegramSessionKey(555, undefined, 9, true, "shared", true)).toBeUndefined();
    expect(telegramSessionKey(-100777, 42, 9, false, "shared", true)).toBeUndefined();
  });

  it("Telegram, gateway off: the legacy keys, unchanged", async () => {
    await withScope("conversation");
    expect(telegramSessionKey(555, undefined, 9, true, "shared", false)).toBeUndefined();
    expect(telegramSessionKey(555, undefined, 9, true, "perUser", false)).toBe("tg:dm:9");
    expect(telegramSessionKey(-100777, 42, 9, false, "shared", false)).toBe("tg:-100777:42");
    expect(telegramSessionKey(-100777, undefined, 9, false, "shared", false)).toBe("tg:-100777");
  });

  it("Discord, gateway on: the conversation's session under conversation scope (DMs included), global otherwise", async () => {
    await withScope("conversation");
    expect(interactionSessionKey({ guild_id: "g1", channel_id: "c2" }, true)).toBe(
      "discord:guild:g1:c2:c2",
    );
    expect(interactionSessionKey({ channel_id: "dm9" }, true)).toBe("discord:dm:dm9:dm9");
    await withScope("global");
    expect(interactionSessionKey({ guild_id: "g1", channel_id: "c2" }, true)).toBeUndefined();
  });

  it("Discord, gateway off: guild channel = its channel id, DM = global, unchanged", async () => {
    await withScope("conversation");
    expect(interactionSessionKey({ guild_id: "g1", channel_id: "c2" }, false)).toBe("c2");
    expect(interactionSessionKey({ channel_id: "dm9" }, false)).toBeUndefined();
    expect(interactionSessionKey({ guild_id: "g1" }, false)).toBeUndefined();
  });
});
