/**
 * Quiet hours for proactive messages (#512): settings parsing, the window
 * clock, and the outbox holding proactive messages until the window ends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, reloadSettings } from "../config";
import {
  proactiveDeliver,
  quietHoldUntil,
  quietHoursFrom,
  type QuietHoursState,
} from "../quiet-hours";
import { type OutboxChunk, TelegramOutbox } from "../telegram-outbox";

const MIN = 60_000;
// Wednesday 2026-10-07 23:00 UTC; the window below ends Thursday 07:00.
const NIGHT = Date.UTC(2026, 9, 7, 23, 0);
const MORNING = Date.UTC(2026, 9, 8, 7, 0);
const NOON = Date.UTC(2026, 9, 8, 12, 0);

const NIGHTLY: QuietHoursState = {
  windows: [{ start: "22:00", end: "07:00" }],
  urgentBypass: false,
  timezoneOffsetMinutes: 0,
};

describe("settings.quietHours", () => {
  const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
  const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
  const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.quiet-hours-test-backup");

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
      /* the restore may have removed the file */
    }
  });

  it("is off by default: no windows, no bypass, nothing held", async () => {
    await Bun.write(SETTINGS_FILE, "{}\n");
    await reloadSettings();
    const s = getSettings();
    expect(s.quietHours).toEqual({ windows: [], urgentBypass: false });
    expect(quietHoldUntil(quietHoursFrom(s), NIGHT)).toBeNull();
  });

  it("parses windows with the heartbeat parser and the bypass flag", async () => {
    await Bun.write(
      SETTINGS_FILE,
      JSON.stringify({
        timezoneOffsetMinutes: 0,
        quietHours: {
          windows: [
            { start: "22:00", end: "07:00" },
            { start: "bad", end: "07:00" },
          ],
          urgentBypass: true,
        },
      }),
    );
    await reloadSettings();
    const s = getSettings();
    expect(s.quietHours.windows).toEqual([
      { start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
    ]);
    expect(s.quietHours.urgentBypass).toBe(true);
    expect(quietHoldUntil(quietHoursFrom(s), NIGHT)).toBe(MORNING);
  });
});

describe("quietHoldUntil", () => {
  it("gives the window's end inside it, null outside", () => {
    expect(quietHoldUntil(NIGHTLY, NIGHT)).toBe(MORNING);
    expect(quietHoldUntil(NIGHTLY, NOON)).toBeNull();
  });

  it("follows the timezone offset", () => {
    // 23:00 UTC is 19:00 at UTC-4: outside a 22:00-07:00 local window.
    expect(quietHoldUntil({ ...NIGHTLY, timezoneOffsetMinutes: -240 }, NIGHT)).toBeNull();
  });

  it("never holds when the windows never end", () => {
    const always = { ...NIGHTLY, windows: [{ start: "00:00", end: "00:00" }] };
    expect(quietHoldUntil(always, NIGHT)).toBeNull();
  });
});

describe("TelegramOutbox — quiet hours", () => {
  let dir: string;
  let path: string;
  let clock: number;
  let sent: Array<{ chatId: number; text: string }>;
  let failWith: Error | null;
  let logs: string[];

  const logger = {
    info: (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    warn: (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    error: (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
  };

  async function send(chatId: number, chunk: OutboxChunk): Promise<void> {
    if (failWith) throw failWith;
    sent.push({ chatId, text: chunk.text });
  }

  function make(quiet: QuietHoursState | undefined = NIGHTLY): TelegramOutbox {
    return new TelegramOutbox({
      path,
      send,
      now: () => clock,
      logger,
      quietUntil: (now) => quietHoldUntil(quiet, now),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-quiet-"));
    path = join(dir, "telegram-outbox.json");
    clock = NIGHT;
    sent = [];
    failWith = null;
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a proactive message inside the window is held, not sent, until its end", async () => {
    const ob = make();
    const ok = await ob.deliver(
      { chatId: 7, label: "nightly", chunks: [{ text: "report" }] },
      { proactive: true },
    );

    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
    const [entry] = ob.list();
    expect(entry).toMatchObject({
      chatId: 7,
      attempts: 0,
      nextAttemptAt: MORNING,
      proactive: true,
    });
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect(disk.entries).toHaveLength(1);
    expect(logs.some((l) => l.includes("quiet hours: held message to chat 7 [nightly]"))).toBe(
      true,
    );

    clock = MORNING - MIN;
    await ob.drain();
    expect(sent).toHaveLength(0);

    clock = MORNING;
    await ob.drain();
    expect(sent).toEqual([{ chatId: 7, text: "report" }]);
    expect(ob.list()).toHaveLength(0);
    expect(logs.some((l) => l.includes("delivered message held by quiet hours to chat 7"))).toBe(
      true,
    );
  });

  it("a message not marked proactive (a reply) is sent inside the window", async () => {
    const ob = make();
    expect(await ob.deliver({ chatId: 7, chunks: [{ text: "answer" }] })).toBe(true);
    expect(sent).toEqual([{ chatId: 7, text: "answer" }]);
    expect(ob.list()).toHaveLength(0);
  });

  it("without quiet hours a proactive message is sent at once", async () => {
    const ob = new TelegramOutbox({ path, send, now: () => clock, logger });
    expect(await ob.deliver({ chatId: 7, chunks: [{ text: "report" }] }, { proactive: true })).toBe(
      true,
    );
    expect(sent).toHaveLength(1);
  });

  it("outside the window a proactive message is sent at once", async () => {
    clock = NOON;
    const ob = make();
    expect(await ob.deliver({ chatId: 7, chunks: [{ text: "report" }] }, { proactive: true })).toBe(
      true,
    );
    expect(sent).toHaveLength(1);
  });

  it("a held message survives a restart", async () => {
    await make().deliver({ chatId: 7, chunks: [{ text: "report" }] }, { proactive: true });
    clock = MORNING;
    const reborn = make();
    await reborn.drain();
    expect(sent).toEqual([{ chatId: 7, text: "report" }]);
  });

  it("a proactive retry that comes due inside the window waits for its end, no attempt counted", async () => {
    clock = Date.UTC(2026, 9, 7, 21, 59);
    failWith = new Error("Telegram API sendMessage: 502 Bad Gateway");
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "report" }] }, { proactive: true });
    expect(ob.list()[0].attempts).toBe(1);

    failWith = null;
    clock = NIGHT;
    await ob.drain();
    expect(sent).toHaveLength(0);
    expect(ob.list()[0]).toMatchObject({ attempts: 1, nextAttemptAt: MORNING });

    clock = MORNING;
    await ob.drain();
    expect(sent).toHaveLength(1);
  });

  it("a non-proactive retry is not held by the window", async () => {
    clock = Date.UTC(2026, 9, 7, 21, 59);
    failWith = new Error("Telegram API sendMessage: 502 Bad Gateway");
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "answer" }] });

    failWith = null;
    clock = NIGHT;
    await ob.drain();
    expect(sent).toEqual([{ chatId: 7, text: "answer" }]);
  });

  it("legacy runtime: proactiveDeliver holds inside the window and reads the settings live", async () => {
    let current: QuietHoursState | undefined = NIGHTLY;
    const ob = new TelegramOutbox({ path, send, now: () => clock, logger });
    const deliver = proactiveDeliver(ob, () => current);

    await deliver({ chatId: 7, chunks: [{ text: "job result" }] });
    expect(sent).toHaveLength(0);
    expect(ob.list()).toHaveLength(1);

    current = { ...NIGHTLY, windows: [] };
    await deliver({ chatId: 7, chunks: [{ text: "after reload" }] });
    // The held one is released first, then the new one goes out.
    expect(sent.map((m) => m.text)).toEqual(["job result", "after reload"]);
  });

  it("right after the window, a new proactive message does not overtake the held ones", async () => {
    const ob = make();
    await ob.deliver({ chatId: 7, chunks: [{ text: "held 1" }] }, { proactive: true });
    await ob.deliver({ chatId: 7, chunks: [{ text: "held 2" }] }, { proactive: true });

    clock = MORNING + 10_000;
    await ob.deliver({ chatId: 7, chunks: [{ text: "new" }] }, { proactive: true });
    expect(sent.map((m) => m.text)).toEqual(["held 1", "held 2", "new"]);
    expect(ob.list()).toHaveLength(0);
  });

  it("a full queue drops a held message before a failed reply", async () => {
    clock = Date.UTC(2026, 9, 7, 21, 59);
    failWith = new Error("Telegram API sendMessage: 502 Bad Gateway");
    const ob = new TelegramOutbox({
      path,
      send,
      now: () => clock,
      logger,
      maxEntries: 3,
      quietUntil: (now) => quietHoldUntil(NIGHTLY, now),
    });
    await ob.deliver({ chatId: 7, chunks: [{ text: "reply" }] });
    failWith = null;
    clock = NIGHT;
    for (const n of [1, 2, 3]) {
      await ob.deliver({ chatId: 7, chunks: [{ text: `cron ${n}` }] }, { proactive: true });
    }
    expect(ob.list().map((e) => e.chunks[0].text)).toEqual(["reply", "cron 2", "cron 3"]);
  });

  it("switching quiet hours off releases what was held", async () => {
    let current: QuietHoursState = NIGHTLY;
    const ob = new TelegramOutbox({
      path,
      send,
      now: () => clock,
      logger,
      quietUntil: (now) => quietHoldUntil(current, now),
    });
    await ob.deliver({ chatId: 7, chunks: [{ text: "held" }] }, { proactive: true });
    current = { ...NIGHTLY, windows: [] };
    await ob.drain();
    expect(sent.map((m) => m.text)).toEqual(["held"]);
  });

  it("a queue full of failed replies keeps them and drops the new held message", async () => {
    clock = Date.UTC(2026, 9, 7, 21, 59);
    failWith = new Error("Telegram API sendMessage: 502 Bad Gateway");
    const ob = new TelegramOutbox({
      path,
      send,
      now: () => clock,
      logger,
      maxEntries: 2,
      quietUntil: (now) => quietHoldUntil(NIGHTLY, now),
    });
    await ob.deliver({ chatId: 7, chunks: [{ text: "r1" }] });
    await ob.deliver({ chatId: 7, chunks: [{ text: "r2" }] });
    clock = NIGHT;
    await ob.deliver({ chatId: 7, chunks: [{ text: "cron" }] }, { proactive: true });
    expect(ob.list().map((e) => e.chunks[0].text)).toEqual(["r1", "r2"]);
    expect(logs.some((l) => l.includes("dropped new message for chat 7"))).toBe(true);
  });
});
