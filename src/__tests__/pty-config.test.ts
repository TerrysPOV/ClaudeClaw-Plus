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
    expect(pty.quietWindowMs).toBe(500);
    expect(pty.sentinelMaxWaitMs).toBe(30_000);
  });

  it("accepts custom quietWindowMs / sentinelMaxWaitMs (issue #81 sentinel-echo)", async () => {
    await writeRawSettings({ pty: { quietWindowMs: 250, sentinelMaxWaitMs: 60_000 } });
    await reloadSettings();
    expect(getSettings().pty.quietWindowMs).toBe(250);
    expect(getSettings().pty.sentinelMaxWaitMs).toBe(60_000);
  });

  it("rejects non-positive quietWindowMs / sentinelMaxWaitMs", async () => {
    await writeRawSettings({ pty: { quietWindowMs: 0, sentinelMaxWaitMs: -1 } });
    await reloadSettings();
    expect(getSettings().pty.quietWindowMs).toBe(500);
    expect(getSettings().pty.sentinelMaxWaitMs).toBe(30_000);
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
        idleReapMinutes: 0, // must be > 0
        maxRetries: -1, // must be >= 0
        backoffMs: "not-an-array", // must be array
        turnIdleTimeoutMs: -100, // must be > 0
        cols: 10, // must be >= 40
        rows: 5, // must be >= 10
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
        respawnRetries: 3,
        backoffMs: [1000, 2000, 4000, 8000, 16000],
        namedAgentsAlwaysAlive: true,
        turnIdleTimeoutMs: 5000,
        cols: 100,
        rows: 30,
        maxConcurrent: 32,
        quietWindowMs: 500,
        sentinelMaxWaitMs: 30_000,
      },
    };
    await writeRawSettings(explicitDefaults);
    await reloadSettings();
    expect(getSettings().pty).toEqual(explicitDefaults.pty);
  });

  it("defaults respawnRetries to 3 when omitted (#175)", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(3);
  });

  it("accepts custom respawnRetries when finite and >= 1", async () => {
    await writeRawSettings({ pty: { respawnRetries: 5 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(5);

    await writeRawSettings({ pty: { respawnRetries: 1 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(1);
  });

  it("rejects invalid respawnRetries, falls back to default", async () => {
    await writeRawSettings({ pty: { respawnRetries: 0 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(3);

    await writeRawSettings({ pty: { respawnRetries: -1 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(3);

    await writeRawSettings({ pty: { respawnRetries: "lots" as unknown as number } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(3);
  });

  it("caps respawnRetries at 20 (footgun guard per security review on #175)", async () => {
    await writeRawSettings({ pty: { respawnRetries: 100 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(20);

    await writeRawSettings({ pty: { respawnRetries: 20 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(20);

    await writeRawSettings({ pty: { respawnRetries: 21 } });
    await reloadSettings();
    expect(getSettings().pty.respawnRetries).toBe(20);
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
      // SPEC-DELTA-2026-05-16 always-resume defaults.
      sessionPersistenceEnabled: true,
      sessionMaxAgeSeconds: 3600,
      sessionPersistencePath: "",
      rateLimit: { maxRequestsPerWindow: 600, windowMs: 60_000 },
      // Issue #68 metrics + #69 response cache defaults (added after this
      // test was written; sync explicit-empty expectation with the schema).
      metricsEnabled: false,
      cache: {
        enabled: false,
        ttlMs: 5_000,
        maxEntries: 1_000,
        cacheable: {},
        defensiveInvalidation: true,
      },
      // #230 bridge kill switch: empty = no restriction.
      bridge: { plugins: {} },
      // #232 mandatory audit: off unless asked for.
      audit: "best-effort",
    });
  });
});

describe("parseSettings — mcp session persistence (SPEC-DELTA-2026-05-16)", () => {
  it("defaults sessionPersistenceEnabled to true (always-resume)", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistenceEnabled).toBe(true);
  });

  it("respects an explicit sessionPersistenceEnabled = false (kill-switch)", async () => {
    await writeRawSettings({ mcp: { sessionPersistenceEnabled: false } });
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistenceEnabled).toBe(false);
  });

  it("ignores non-boolean sessionPersistenceEnabled (defaults to true)", async () => {
    // Operator typo like `"false"` (string) shouldn't silently disable
    // persistence — strict boolean check, default to true.
    await writeRawSettings({ mcp: { sessionPersistenceEnabled: "false" } });
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistenceEnabled).toBe(true);
  });

  it("defaults sessionMaxAgeSeconds to 3600", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(3600);
  });

  it("accepts a custom sessionMaxAgeSeconds", async () => {
    await writeRawSettings({ mcp: { sessionMaxAgeSeconds: 7200 } });
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(7200);
  });

  it("clamps a sub-60 sessionMaxAgeSeconds to 60", async () => {
    await writeRawSettings({ mcp: { sessionMaxAgeSeconds: 5 } });
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(60);
  });

  it("falls back to default for negative / zero / non-numeric sessionMaxAgeSeconds", async () => {
    await writeRawSettings({ mcp: { sessionMaxAgeSeconds: -1 } });
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(3600);

    await writeRawSettings({ mcp: { sessionMaxAgeSeconds: 0 } });
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(3600);

    await writeRawSettings({ mcp: { sessionMaxAgeSeconds: "9999" } });
    await reloadSettings();
    expect(getSettings().mcp.sessionMaxAgeSeconds).toBe(3600);
  });

  it("defaults sessionPersistencePath to empty (compute at start)", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistencePath).toBe("");
  });

  it("accepts an absolute sessionPersistencePath", async () => {
    await writeRawSettings({ mcp: { sessionPersistencePath: "/custom/path/sessions" } });
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistencePath).toBe("/custom/path/sessions");
  });

  it("rejects a non-absolute sessionPersistencePath with a warn (reverts to default)", async () => {
    await writeRawSettings({ mcp: { sessionPersistencePath: "relative/path" } });
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistencePath).toBe("");
  });

  it("ignores non-string sessionPersistencePath", async () => {
    await writeRawSettings({ mcp: { sessionPersistencePath: 42 } });
    await reloadSettings();
    expect(getSettings().mcp.sessionPersistencePath).toBe("");
  });
});

describe("parseSettings — mcp.bridge kill switch (#230)", () => {
  it("is empty when absent: no restriction", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: {} });
  });

  it("keeps enabled / allowedTools / deniedTools per plugin", async () => {
    await writeRawSettings({
      mcp: {
        bridge: {
          plugins: {
            demo: { allowedTools: ["safe", "danger"], deniedTools: ["danger"] },
            noisy: { enabled: false },
          },
        },
      },
    });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({
      plugins: {
        demo: { allowedTools: ["safe", "danger"], deniedTools: ["danger"] },
        noisy: { enabled: false },
      },
    });
  });

  it("turns a malformed plugin entry off instead of ignoring it", async () => {
    await writeRawSettings({
      mcp: {
        bridge: {
          plugins: {
            a: { enabled: "false" },
            b: { allowedTools: "safe" },
            c: { deniedTools: ["x", 1] },
            d: true,
            e: { denyTools: ["danger"] },
            ok: { deniedTools: [] },
          },
        },
      },
    });
    await reloadSettings();
    expect(getSettings().mcp.bridge?.plugins).toEqual({
      a: { enabled: false },
      b: { enabled: false },
      c: { enabled: false },
      d: { enabled: false },
      e: { enabled: false },
      ok: { deniedTools: [] },
    });
  });

  it("warns once per malformed entry across hot-reloads, and skips __proto__", async () => {
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
      seen.push(String(args[0]));
    };
    try {
      await writeRawSettings(
        JSON.parse(
          '{"mcp":{"bridge":{"plugins":{"__proto__":{"enabled":false},"z":{"enabled":1}}}}}',
        ),
      );
      await reloadSettings();
      await reloadSettings();
    } finally {
      console.warn = warn;
    }
    const plugins = getSettings().mcp.bridge?.plugins ?? {};
    expect(Object.keys(plugins)).toEqual(["z"]);
    expect(Object.getPrototypeOf(plugins)).toBe(Object.prototype);
    expect(seen.filter((m) => m.includes("plugins.z is malformed"))).toHaveLength(1);
  });

  it("ignores a plugins value that is not an object", async () => {
    await writeRawSettings({ mcp: { bridge: { plugins: ["demo"] } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: {} });
  });
});

describe("parseSettings — mcp.bridge.defaultDeny (#230)", () => {
  it("is off unless set to true", async () => {
    await writeRawSettings({ mcp: { bridge: { plugins: { calc: {} } } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge?.defaultDeny).toBeUndefined();
    await writeRawSettings({ mcp: { bridge: { defaultDeny: false } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge?.defaultDeny).toBeUndefined();
    await writeRawSettings({ mcp: { bridge: { defaultDeny: true, plugins: { calc: {} } } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: { calc: {} }, defaultDeny: true });
  });

  it("turns on for a non-boolean value or a misspelt key", async () => {
    await writeRawSettings({ mcp: { bridge: { defaultDeny: "yes" } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge?.defaultDeny).toBe(true);
    await writeRawSettings({ mcp: { bridge: { defaultdeny: false } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge?.defaultDeny).toBe(true);
  });

  it("reads a bridge value that is not an object as deny-by-default, false and null as absent", async () => {
    await writeRawSettings({ mcp: { bridge: true } });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: {}, defaultDeny: true });
    await writeRawSettings({ mcp: { bridge: false } });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: {} });
    await writeRawSettings({ mcp: { bridge: { defaultDeny: null } } });
    await reloadSettings();
    expect(getSettings().mcp.bridge).toEqual({ plugins: {} });
  });
});

describe("parseSettings — mcp.audit (#232)", () => {
  it("defaults to best-effort", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().mcp.audit).toBe("best-effort");
  });

  it("accepts enforce and best-effort", async () => {
    await writeRawSettings({ mcp: { audit: "enforce" } });
    await reloadSettings();
    expect(getSettings().mcp.audit).toBe("enforce");
    await writeRawSettings({ mcp: { audit: "best-effort" } });
    await reloadSettings();
    expect(getSettings().mcp.audit).toBe("best-effort");
  });

  it("reads null as absent", async () => {
    await writeRawSettings({ mcp: { audit: null } });
    await reloadSettings();
    expect(getSettings().mcp.audit).toBe("best-effort");
  });

  it("reads an unknown value as enforce, not as the default", async () => {
    await writeRawSettings({ mcp: { audit: "enforced" } });
    await reloadSettings();
    expect(getSettings().mcp.audit).toBe("enforce");
  });
});
