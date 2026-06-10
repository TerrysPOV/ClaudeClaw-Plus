/**
 * Tests for `src/bus/adapter-wiring.ts` (Sprint 5.2b).
 *
 * Strategy: we cannot easily inject fakes for the four adapter classes
 * because `wireBusAdapters` uses dynamic imports of the real modules.
 * Instead the tests rely on `bus + routing` GATING — when routing or
 * token is absent, the adapter is skipped without ever being imported.
 * This is the load-bearing claim the daemon depends on: a daemon
 * running without a Slack token shouldn't import `src/adapters/slack/`
 * or pay its cold-start cost.
 *
 * Real adapter instantiation (with tokens + routing) is exercised by
 * each adapter's own suite + integration testing on Hetzner staging.
 */

import { describe, it, expect } from "bun:test";
import { wireBusAdapters, stopBusAdapters, configuredBusAdapterNames } from "../adapter-wiring";
import type { BusCore } from "../core";
import type { Settings } from "../../config";

const SILENT_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

// Test-only placeholder tokens. Real Slack prefixes (`xoxb-`, `xapp-`)
// are intentionally NOT used here so the `block-secrets-in-code.sh`
// pre-commit hook doesn't false-positive on the test file.
const FAKE_SLACK_BOT_TOKEN = "fake-slack-bot-token";

/** Minimal stub — adapter-wiring's gating logic only inspects settings, not the bus. */
function stubBus(): BusCore {
  return {} as BusCore;
}

function baseSettings(
  over: Partial<Pick<Settings, "discord" | "telegram" | "slack" | "web">> = {},
): Pick<Settings, "discord" | "telegram" | "slack" | "web"> {
  return {
    discord: {
      token: "",
      allowedUserIds: [],
      listenChannels: [],
      listenGuilds: [],
      allowedGuilds: [],
      imageOutputRoots: [],
      ...((over.discord ?? {}) as object),
    } as Settings["discord"],
    telegram: {
      token: "",
      allowedUserIds: [],
      listenChats: [],
      receiveEnabled: true,
      dmIsolation: "shared",
      ...((over.telegram ?? {}) as object),
    } as Settings["telegram"],
    slack: {
      botToken: "",
      appToken: "",
      allowedUserIds: [],
      listenChannels: [],
      allowBots: [],
      allowBotIds: [],
      ...((over.slack ?? {}) as object),
    } as Settings["slack"],
    web: {
      enabled: false,
      host: "127.0.0.1",
      port: 4632,
      ...((over.web ?? {}) as object),
    } as Settings["web"],
  };
}

describe("wireBusAdapters — gating", () => {
  it("mounts no adapters when no platform has both token AND routing", async () => {
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings(),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters).toHaveLength(0);
    expect(result.errors).toEqual({});
  });

  it("skips Discord when token is set but routing is absent", async () => {
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        discord: {
          token: "fake-discord-token",
          allowedUserIds: [],
          listenChannels: [],
          listenGuilds: [],
          allowedGuilds: [],
          imageOutputRoots: [],
        },
      }),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "discord")).toBeUndefined();
  });

  it("skips Discord when routing is set but token is absent", async () => {
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        discord: {
          token: "",
          allowedUserIds: [],
          listenChannels: [],
          listenGuilds: [],
          allowedGuilds: [],
          imageOutputRoots: [],
          busRouting: { channels: { C1: "triage" } },
        },
      }),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "discord")).toBeUndefined();
  });

  it("skips Telegram when routing AND defaultAgentId are both absent", async () => {
    // #197: a token alone is enough ONLY when a default agent exists to route
    // to. With no busRouting and no defaultAgentId there is no consumer, so the
    // adapter is still skipped (and never imported).
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        telegram: {
          token: "123:abc",
          allowedUserIds: [],
          listenChats: [],
          receiveEnabled: true,
          dmIsolation: "shared",
        },
      }),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "telegram")).toBeUndefined();
  });

  it("skips a token-only Telegram mount when receiveEnabled is false (send-only)", async () => {
    // Codex P2 on #197: the derive must not auto-mount a poll loop for a
    // send-only config. The adapter is never imported on this path.
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        telegram: {
          token: "123:abc",
          allowedUserIds: [],
          listenChats: [],
          receiveEnabled: false,
          dmIsolation: "shared",
        },
      }),
      defaultAgentId: "default",
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "telegram")).toBeUndefined();
  });

  it("skips Telegram when token is absent even if a defaultAgentId is provided", async () => {
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        telegram: {
          token: "",
          allowedUserIds: [],
          listenChats: [],
          receiveEnabled: true,
          dmIsolation: "shared",
        },
      }),
      defaultAgentId: "default",
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "telegram")).toBeUndefined();
  });

  it("reports Slack error when token + routing are present but signing secret is missing", async () => {
    // Slack's signing secret is required for Events API HTTP verification.
    // The wiring function throws a typed error when token + routing are
    // present without a secret — the gating treats this as a per-adapter
    // failure rather than a silent skip so operators get a log line.
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        slack: {
          botToken: FAKE_SLACK_BOT_TOKEN,
          appToken: "",
          allowedUserIds: [],
          listenChannels: [],
          allowBots: [],
          allowBotIds: [],
          busRouting: { channels: { C1: "triage" } },
        },
      }),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "slack")).toBeUndefined();
    expect(result.errors.slack).toMatch(/signing secret/);
  });

  it("skips WebUi when web.bus is undefined", async () => {
    const result = await wireBusAdapters({
      bus: stubBus(),
      settings: baseSettings({
        web: { enabled: true, host: "127.0.0.1", port: 4632 },
      }),
      logger: SILENT_LOGGER,
    });
    expect(result.adapters.find((a) => a.name === "webui")).toBeUndefined();
  });
});

describe("configuredBusAdapterNames — Telegram token-only mount (#197)", () => {
  const tgSettings = (token: string, busRouting?: { chats: Record<string, string> }) =>
    baseSettings({
      telegram: {
        token,
        allowedUserIds: [],
        listenChats: [],
        receiveEnabled: true,
        dmIsolation: "shared",
        ...(busRouting ? { busRouting } : {}),
      } as Settings["telegram"],
    });

  it("counts Telegram when token + defaultAgentId are present (busRouting derived)", () => {
    expect(configuredBusAdapterNames(tgSettings("123:abc"), "default")).toContain("telegram");
  });

  it("omits Telegram when token is set but there is no busRouting and no defaultAgentId", () => {
    expect(configuredBusAdapterNames(tgSettings("123:abc"))).not.toContain("telegram");
    expect(configuredBusAdapterNames(tgSettings("123:abc"), undefined)).not.toContain("telegram");
  });

  it("counts Telegram with explicit busRouting even when no defaultAgentId is passed", () => {
    expect(
      configuredBusAdapterNames(tgSettings("123:abc", { chats: { "100": "triage" } })),
    ).toContain("telegram");
  });

  it("omits Telegram when token is absent even with a defaultAgentId", () => {
    expect(configuredBusAdapterNames(tgSettings(""), "default")).not.toContain("telegram");
  });

  it("does not derive a token-only mount for a send-only config (receiveEnabled: false)", () => {
    // Codex P2 on #197: the token-only derive must respect receiveEnabled so a
    // send-only config doesn't start consuming inbound.
    const sendOnly = baseSettings({
      telegram: {
        token: "123:abc",
        allowedUserIds: [],
        listenChats: [],
        receiveEnabled: false,
        dmIsolation: "shared",
      } as Settings["telegram"],
    });
    expect(configuredBusAdapterNames(sendOnly, "default")).not.toContain("telegram");
  });

  it("still counts Telegram with explicit busRouting even when receiveEnabled is false", () => {
    // Explicit busRouting is the operator opting in; the bus adapter's
    // pre-existing receiveEnabled handling there is out of scope for #197.
    const explicitSendOnly = baseSettings({
      telegram: {
        token: "123:abc",
        allowedUserIds: [],
        listenChats: [],
        receiveEnabled: false,
        dmIsolation: "shared",
        busRouting: { chats: { "100": "triage" } },
      } as Settings["telegram"],
    });
    expect(configuredBusAdapterNames(explicitSendOnly, "default")).toContain("telegram");
  });
});

describe("stopBusAdapters", () => {
  it("stops every adapter in reverse construction order", async () => {
    const stopOrder: string[] = [];
    const mk = (name: "discord" | "telegram" | "slack" | "webui") => ({
      name,
      stop: async () => {
        stopOrder.push(name);
      },
    });
    await stopBusAdapters([mk("discord"), mk("telegram"), mk("slack"), mk("webui")], SILENT_LOGGER);
    expect(stopOrder).toEqual(["webui", "slack", "telegram", "discord"]);
  });

  it("continues past a stop() that throws", async () => {
    const stopOrder: string[] = [];
    const mk = (
      name: "discord" | "telegram" | "slack" | "webui",
      fail = false,
    ): { name: typeof name; stop: () => Promise<void> } => ({
      name,
      stop: async () => {
        if (fail) throw new Error(`fake ${name} stop failure`);
        stopOrder.push(name);
      },
    });
    await stopBusAdapters([mk("discord"), mk("telegram", true), mk("slack")], SILENT_LOGGER);
    // telegram threw; discord + slack still ran.
    expect(stopOrder).toEqual(["slack", "discord"]);
  });

  it("empty list is a no-op", async () => {
    await stopBusAdapters([], SILENT_LOGGER);
  });
});
