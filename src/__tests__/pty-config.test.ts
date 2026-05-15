/**
 * parseSettings round-trip tests for the new `pty` block.
 *
 * We exercise parseSettings indirectly via loadSettings / reloadSettings
 * because parseSettings itself is not exported. The settings.json file
 * already exists in this worktree from a previous test run / init step,
 * so we mutate it for each scenario and call reloadSettings().
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";

import { loadSettings, reloadSettings, getSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.pty-cfg-test-backup");

async function writeRawSettings(obj: unknown): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await Bun.write(SETTINGS_FILE, JSON.stringify(obj, null, 2) + "\n");
}

beforeAll(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) {
    await copyFile(SETTINGS_FILE, BACKUP_FILE);
  }
});

afterAll(async () => {
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
  // Re-prime cached settings against whatever the post-restore file says.
  try {
    await reloadSettings();
  } catch {
    // ok — restore may have removed the file
  }
});

describe("parseSettings — pty defaults", () => {
  it("applies all defaults when pty block is missing", async () => {
    await writeRawSettings({});
    await reloadSettings();
    const { pty } = getSettings();
    expect(pty.enabled).toBe(false); // opt-in default — operators must explicitly enable
    expect(pty.idleReapMinutes).toBe(30);
    expect(pty.maxRetries).toBe(5);
    expect(pty.backoffMs).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(pty.namedAgentsAlwaysAlive).toBe(true);
    expect(pty.turnIdleTimeoutMs).toBe(5000);
    expect(pty.cols).toBe(100);
    expect(pty.rows).toBe(30);
  });

  it("respects an explicit pty.enabled = true", async () => {
    await writeRawSettings({ pty: { enabled: true } });
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(true);
    // Other fields remain defaults.
    expect(getSettings().pty.idleReapMinutes).toBe(30);
  });

  it("respects an explicit pty.enabled = false", async () => {
    await writeRawSettings({ pty: { enabled: false } });
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(false);
  });

  it("treats a missing pty.enabled (object present, key absent) as false", async () => {
    await writeRawSettings({ pty: { idleReapMinutes: 7 } });
    await reloadSettings();
    expect(getSettings().pty.enabled).toBe(false);
  });

  it("honours user-supplied numeric values", async () => {
    await writeRawSettings({
      pty: {
        enabled: true,
        idleReapMinutes: 7,
        maxRetries: 2,
        backoffMs: [100, 200],
        namedAgentsAlwaysAlive: false,
        turnIdleTimeoutMs: 250,
        cols: 200,
        rows: 60,
      },
    });
    await reloadSettings();
    const { pty } = getSettings();
    expect(pty.enabled).toBe(true);
    expect(pty.idleReapMinutes).toBe(7);
    expect(pty.maxRetries).toBe(2);
    expect(pty.backoffMs).toEqual([100, 200]);
    expect(pty.namedAgentsAlwaysAlive).toBe(false);
    expect(pty.turnIdleTimeoutMs).toBe(250);
    expect(pty.cols).toBe(200);
    expect(pty.rows).toBe(60);
  });

  it("rejects invalid numeric values and falls back to defaults", async () => {
    await writeRawSettings({
      pty: {
        idleReapMinutes: 0,           // must be > 0
        maxRetries: -1,                // must be >= 0
        backoffMs: "not-an-array",     // must be array
        turnIdleTimeoutMs: -100,       // must be > 0
        cols: 10,                      // must be >= 40
        rows: 5,                       // must be >= 10
      },
    });
    await reloadSettings();
    const { pty } = getSettings();
    expect(pty.idleReapMinutes).toBe(30);
    expect(pty.maxRetries).toBe(5);
    expect(pty.backoffMs).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(pty.turnIdleTimeoutMs).toBe(5000);
    expect(pty.cols).toBe(100);
    expect(pty.rows).toBe(30);
  });

  it("allows maxRetries = 0 (legitimately no retries)", async () => {
    await writeRawSettings({ pty: { maxRetries: 0 } });
    await reloadSettings();
    expect(getSettings().pty.maxRetries).toBe(0);
  });

  it("rejects a backoffMs array containing a non-finite value", async () => {
    await writeRawSettings({ pty: { backoffMs: [100, "boom", 200] } });
    await reloadSettings();
    expect(getSettings().pty.backoffMs).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("rejects a backoffMs array containing a negative value", async () => {
    await writeRawSettings({ pty: { backoffMs: [100, -1, 200] } });
    await reloadSettings();
    expect(getSettings().pty.backoffMs).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("rejects an empty backoffMs array", async () => {
    await writeRawSettings({ pty: { backoffMs: [] } });
    await reloadSettings();
    expect(getSettings().pty.backoffMs).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("round-trips: write defaults, load, assert identical pty shape", async () => {
    // Write a settings.json that explicitly includes every default pty value.
    const explicitDefaults = {
      pty: {
        enabled: true,
        idleReapMinutes: 30,
        maxRetries: 5,
        backoffMs: [1000, 2000, 4000, 8000, 16000],
        namedAgentsAlwaysAlive: true,
        turnIdleTimeoutMs: 5000,
        cols: 100,
        rows: 30,
        maxConcurrent: 32,
      },
    };
    await writeRawSettings(explicitDefaults);
    await reloadSettings();
    expect(getSettings().pty).toEqual(explicitDefaults.pty);
  });

  it("defaults maxConcurrent to 32 when omitted", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().pty.maxConcurrent).toBe(32);
  });

  it("accepts custom maxConcurrent when finite and positive", async () => {
    await writeRawSettings({ pty: { maxConcurrent: 8 } });
    await reloadSettings();
    expect(getSettings().pty.maxConcurrent).toBe(8);
  });

  it("rejects invalid maxConcurrent values, falls back to default", async () => {
    await writeRawSettings({ pty: { maxConcurrent: -5 } });
    await reloadSettings();
    expect(getSettings().pty.maxConcurrent).toBe(32);

    await writeRawSettings({ pty: { maxConcurrent: 0 } });
    await reloadSettings();
    expect(getSettings().pty.maxConcurrent).toBe(32);

    await writeRawSettings({ pty: { maxConcurrent: "lots" as unknown as number } });
    await reloadSettings();
    expect(getSettings().pty.maxConcurrent).toBe(32);
  });
});

describe("parseSettings — pty interacts with existing fields", () => {
  it("loadSettings is idempotent for the pty block", async () => {
    await writeRawSettings({});
    await loadSettings();
    const first = getSettings().pty;
    await reloadSettings();
    expect(getSettings().pty).toEqual(first);
  });
});

describe("parseSettings — mcp block (MCP multiplexer, SPEC §5)", () => {
  it("applies all defaults when mcp block is missing", async () => {
    await writeRawSettings({});
    await reloadSettings();
    const { mcp } = getSettings();
    expect(mcp.shared).toEqual([]);
    expect(mcp.perPtyOnly).toEqual([]);
    expect(mcp.stateless).toEqual([]);
    expect(mcp.healthProbeIntervalMs).toBe(30000);
  });

  it("accepts a custom healthProbeIntervalMs", async () => {
    await writeRawSettings({ mcp: { healthProbeIntervalMs: 5000 } });
    await reloadSettings();
    expect(getSettings().mcp.healthProbeIntervalMs).toBe(5000);
  });

  it("disables the health probe when healthProbeIntervalMs is 0", async () => {
    await writeRawSettings({ mcp: { healthProbeIntervalMs: 0 } });
    await reloadSettings();
    expect(getSettings().mcp.healthProbeIntervalMs).toBe(0);
  });

  it("clamps negative healthProbeIntervalMs to the default", async () => {
    await writeRawSettings({ mcp: { healthProbeIntervalMs: -1 } });
    await reloadSettings();
    expect(getSettings().mcp.healthProbeIntervalMs).toBe(30000);
  });

  it("accepts a non-empty shared list", async () => {
    await writeRawSettings({ mcp: { shared: ["graphiti", "context7"] } });
    await reloadSettings();
    expect(getSettings().mcp.shared).toEqual(["graphiti", "context7"]);
  });

  it("filters non-string entries out of the shared list", async () => {
    await writeRawSettings({ mcp: { shared: ["graphiti", 42, null, "context7", ""] } });
    await reloadSettings();
    expect(getSettings().mcp.shared).toEqual(["graphiti", "context7"]);
  });

  it("de-duplicates entries inside shared", async () => {
    await writeRawSettings({ mcp: { shared: ["graphiti", "graphiti", "context7"] } });
    await reloadSettings();
    expect(getSettings().mcp.shared).toEqual(["graphiti", "context7"]);
  });

  it("treats a non-array shared field as empty", async () => {
    await writeRawSettings({ mcp: { shared: "graphiti" } });
    await reloadSettings();
    expect(getSettings().mcp.shared).toEqual([]);
  });

  it("removes a name from shared when it's also in perPtyOnly (perPtyOnly wins)", async () => {
    await writeRawSettings({
      mcp: { shared: ["graphiti", "filesystem"], perPtyOnly: ["filesystem"] },
    });
    await reloadSettings();
    const { mcp } = getSettings();
    expect(mcp.shared).toEqual(["graphiti"]);
    expect(mcp.perPtyOnly).toEqual(["filesystem"]);
  });

  it("drops a stateless entry that isn't also in shared", async () => {
    await writeRawSettings({
      mcp: { shared: ["graphiti"], stateless: ["context7"] },
    });
    await reloadSettings();
    expect(getSettings().mcp.stateless).toEqual([]);
  });

  it("keeps stateless entries that are also in shared", async () => {
    await writeRawSettings({
      mcp: { shared: ["graphiti", "context7"], stateless: ["context7"] },
    });
    await reloadSettings();
    expect(getSettings().mcp.stateless).toEqual(["context7"]);
  });

  it("accepts non-empty shared even when web.enabled is false (warning logged)", async () => {
    // Warning is advisory — parseSettings does NOT remove the entries. The
    // multiplexer plugin enforces activation at startup (SPEC §6.3).
    await writeRawSettings({
      web: { enabled: false },
      mcp: { shared: ["graphiti"] },
    });
    await reloadSettings();
    expect(getSettings().mcp.shared).toEqual(["graphiti"]);
  });

  it("round-trips an explicit empty mcp object", async () => {
    await writeRawSettings({ mcp: {} });
    await reloadSettings();
    expect(getSettings().mcp).toEqual({
      shared: [],
      perPtyOnly: [],
      stateless: [],
      healthProbeIntervalMs: 30000,
    });
  });
});
