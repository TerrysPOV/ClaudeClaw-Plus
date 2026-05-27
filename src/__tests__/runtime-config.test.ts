/**
 * parseSettings round-trip tests for the new `runtime` field (Sprint 5.1).
 *
 * Same harness pattern as `pty-config.test.ts`: mutate settings.json and
 * call `reloadSettings()` so we exercise the real parseSettings path.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";

import { DEFAULT_SESSION_TIMEOUT_MS, reloadSettings, getSettings } from "../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.runtime-cfg-test-backup");

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
  try {
    await reloadSettings();
  } catch {
    /* ok — restore may have removed the file */
  }
});

describe("parseSettings — runtime field (Sprint 5.4 flip — bus is default)", () => {
  it('defaults to "bus" when the field is absent', async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });

  it('accepts "bus" explicitly', async () => {
    await writeRawSettings({ runtime: "bus" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });

  it('accepts "pty" (legacy opt-out for pre-v2 deployments)', async () => {
    await writeRawSettings({ runtime: "pty" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("pty");
  });

  it('falls back to "bus" on an unknown value', async () => {
    // Unknown string — parseRuntimeMode logs a warning but never throws.
    await writeRawSettings({ runtime: "buss" });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });

  it('falls back to "bus" when the field is non-string', async () => {
    await writeRawSettings({ runtime: 42 });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });

  it("trims whitespace before matching", async () => {
    await writeRawSettings({ runtime: "  bus  " });
    await reloadSettings();
    expect(getSettings().runtime).toBe("bus");
  });
});

describe("parseSettings — agents field (Sprint 5.2a)", () => {
  it("defaults to empty array when the field is absent", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().agents).toEqual([]);
  });

  it("accepts a minimal entry (id only)", async () => {
    await writeRawSettings({ agents: [{ id: "triage" }] });
    await reloadSettings();
    expect(getSettings().agents).toEqual([{ id: "triage" }]);
  });

  it("preserves all optional fields when set", async () => {
    await writeRawSettings({
      agents: [
        {
          id: "research",
          cwd: "/srv/research",
          permission_mode: "bypassPermissions",
          supervision: "pty-stdin",
          system_prompt_file: "/etc/cc/research.md",
          memory_file: "/etc/cc/research-memory.md",
          mcp_config: "/etc/cc/research-mcp.json",
        },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents[0]).toMatchObject({
      id: "research",
      cwd: "/srv/research",
      permission_mode: "bypassPermissions",
      supervision: "pty-stdin",
      system_prompt_file: "/etc/cc/research.md",
      memory_file: "/etc/cc/research-memory.md",
      mcp_config: "/etc/cc/research-mcp.json",
    });
  });

  it("drops entries missing or with invalid id", async () => {
    await writeRawSettings({
      agents: [
        { id: "ok-1" },
        { id: "" },
        { cwd: "/no/id" },
        { id: "Has-Caps-And-Periods.bad" },
        { id: "ok_2" },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents.map((a) => a.id)).toEqual(["ok-1", "ok_2"]);
  });

  it("dedupes by id keeping the first occurrence", async () => {
    await writeRawSettings({
      agents: [
        { id: "triage", cwd: "/first" },
        { id: "triage", cwd: "/second" },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents).toEqual([{ id: "triage", cwd: "/first" }]);
  });

  it("drops invalid permission_mode and supervision but keeps the rest", async () => {
    await writeRawSettings({
      agents: [
        {
          id: "triage",
          permission_mode: "all-the-powers",
          supervision: "windows-fancy",
          cwd: "/srv",
        },
      ],
    });
    await reloadSettings();
    expect(getSettings().agents[0]).toEqual({ id: "triage", cwd: "/srv" });
  });

  it("accepts every Claude Code --permission-mode choice (Codex P2 on PR #145)", async () => {
    // Earlier the parser only accepted default/plan/bypassPermissions,
    // so users following commands/start.md's documented choices got
    // their permission_mode silently dropped if they picked acceptEdits,
    // dontAsk, or auto. Full-parity with the CLI flag now.
    const modes = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"];
    await writeRawSettings({
      agents: modes.map((m, i) => ({ id: `agent-${i}`, permission_mode: m })),
    });
    await reloadSettings();
    const parsed = getSettings().agents.map((a) => a.permission_mode);
    expect(parsed).toEqual(modes);
  });

  it("falls back to empty array when the field is not an array", async () => {
    await writeRawSettings({ agents: "triage" });
    await reloadSettings();
    expect(getSettings().agents).toEqual([]);
  });

  it("enforces 36-char id cap (sun_path budget)", async () => {
    const tooLong = "a".repeat(37);
    await writeRawSettings({ agents: [{ id: tooLong }, { id: "a".repeat(36) }] });
    await reloadSettings();
    expect(getSettings().agents.map((a) => a.id)).toEqual(["a".repeat(36)]);
  });
});

describe("parseSettings — bus routing (Sprint 5.2b)", () => {
  it("telegram.busRouting parses chats map and defaultAgentId", async () => {
    await writeRawSettings({
      telegram: { busRouting: { chats: { "12345": "triage" }, defaultAgentId: "general" } },
    });
    await reloadSettings();
    expect(getSettings().telegram.busRouting).toEqual({
      chats: { "12345": "triage" },
      defaultAgentId: "general",
    });
  });

  it("telegram.busRouting drops empty routing entirely", async () => {
    await writeRawSettings({ telegram: { busRouting: {} } });
    await reloadSettings();
    expect(getSettings().telegram.busRouting).toBeUndefined();
  });

  it("discord.busRouting parses channels + threads + dmAgentId", async () => {
    await writeRawSettings({
      discord: {
        busRouting: {
          channels: { C1: "triage" },
          threads: { T1: "research" },
          dmAgentId: "global",
        },
      },
    });
    await reloadSettings();
    expect(getSettings().discord.busRouting).toEqual({
      channels: { C1: "triage" },
      threads: { T1: "research" },
      dmAgentId: "global",
    });
  });

  it("slack.busRouting parses channels + threadAgentId + signingSecret", async () => {
    await writeRawSettings({
      slack: {
        busRouting: {
          channels: { C1: "triage" },
          threadAgentId: "global",
          signingSecret: "abc123",
        },
      },
    });
    await reloadSettings();
    expect(getSettings().slack.busRouting).toEqual({
      channels: { C1: "triage" },
      threadAgentId: "global",
      signingSecret: "abc123",
    });
  });

  it("web.bus parses bind + token + allowedAgentIds", async () => {
    await writeRawSettings({
      web: {
        bus: {
          bind: "127.0.0.1:7878",
          token: "secret-token",
          allowedAgentIds: ["triage", "research"],
        },
      },
    });
    await reloadSettings();
    expect(getSettings().web.bus).toEqual({
      bind: "127.0.0.1:7878",
      token: "secret-token",
      allowedAgentIds: ["triage", "research"],
    });
  });

  it("web.bus drops empty config entirely", async () => {
    await writeRawSettings({ web: { bus: {} } });
    await reloadSettings();
    expect(getSettings().web.bus).toBeUndefined();
  });

  it("slack.signingSecret is parsed from top-level when present", async () => {
    await writeRawSettings({ slack: { signingSecret: "top-level-secret" } });
    await reloadSettings();
    expect(getSettings().slack.signingSecret).toBe("top-level-secret");
  });

  it("string-map parser drops non-string keys/values silently", async () => {
    await writeRawSettings({
      discord: {
        busRouting: {
          channels: { valid: "agent-a", empty: "", noValue: 42, "": "skip-key" },
        },
      },
    });
    await reloadSettings();
    expect(getSettings().discord.busRouting).toEqual({ channels: { valid: "agent-a" } });
  });
});

describe("parseSettings — sessionTimeoutMs default (#179)", () => {
  it("defaults DEFAULT_SESSION_TIMEOUT_MS to 120 minutes", () => {
    // 120 * 60 * 1000 = 7,200,000 ms
    expect(DEFAULT_SESSION_TIMEOUT_MS).toBe(120 * 60 * 1000);
  });

  it("falls back to the 120-minute default when the field is absent", async () => {
    await writeRawSettings({});
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(120 * 60 * 1000);
  });

  it("honours an explicit positive sessionTimeoutMs override", async () => {
    await writeRawSettings({ sessionTimeoutMs: 90_000 });
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(90_000);
  });

  it("falls back to the default when sessionTimeoutMs is zero or negative", async () => {
    await writeRawSettings({ sessionTimeoutMs: 0 });
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(120 * 60 * 1000);

    await writeRawSettings({ sessionTimeoutMs: -1 });
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(120 * 60 * 1000);
  });

  it("falls back to the default when sessionTimeoutMs is the wrong type", async () => {
    await writeRawSettings({ sessionTimeoutMs: "120000" });
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(120 * 60 * 1000);
  });

  it("falls back to the default when sessionTimeoutMs is Infinity or NaN", async () => {
    // JSON serialises Infinity/NaN as null on write but operators editing
    // the file by hand might attempt them as bare tokens. The parser must
    // reject them either way — `Number.isFinite` guards both cases.
    await writeRawSettings({ sessionTimeoutMs: null });
    await reloadSettings();
    expect(getSettings().sessionTimeoutMs).toBe(120 * 60 * 1000);
  });
});
