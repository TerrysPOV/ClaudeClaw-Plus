/**
 * `/api/settings` (sanitizeSettings) and `/api/state` (buildState) return a
 * summary of `settings.web` to the dashboard. They used to pass the whole
 * object through, so the webui bus token (`web.bus.token`) — a second
 * credential that can send prompts to the agent — was served in clear to
 * anyone holding the dashboard token. `/api/technical-info` already
 * redacted it. Both routes now say whether a bus token is configured and
 * never return it.
 *
 * Run with: bun test src/ui/__tests__/state-web-bus-token.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startWebUi } from "../server";
import { buildState, sanitizeSettings } from "../services/state";

// Built at runtime to dodge the secrets-in-code scanner.
const BUS_TOKEN = `bus-${"secret"}-token-0123456789`;

function settingsWith(web: unknown) {
  return {
    timezone: "UTC",
    timezoneOffsetMinutes: 0,
    heartbeat: { enabled: false, interval: 15 },
    security: { level: "moderate" },
    telegram: { token: "", allowedUserIds: [] },
    discord: { token: "", allowedUserIds: [] },
    web,
  } as never;
}

const WEB_WITH_BUS = {
  enabled: true,
  host: "127.0.0.1",
  port: 4632,
  bus: {
    bind: "127.0.0.1:7878",
    token: BUS_TOKEN,
    allowedAgentIds: ["main"],
    allowedOrigins: ["http://127.0.0.1:4632"],
  },
};

// The bus also resolves its token from CCAW_WEBUI_TOKEN: start each test
// without it, so a value in the shell or CI cannot decide the outcome.
const savedEnvToken = process.env.CCAW_WEBUI_TOKEN;
beforeEach(() => {
  delete process.env.CCAW_WEBUI_TOKEN;
});
afterEach(() => {
  if (savedEnvToken === undefined) delete process.env.CCAW_WEBUI_TOKEN;
  else process.env.CCAW_WEBUI_TOKEN = savedEnvToken;
});

describe("web bus token is never served by /api/settings or /api/state", () => {
  it("sanitizeSettings reports the bus but not its token", () => {
    const out = sanitizeSettings(settingsWith(WEB_WITH_BUS));
    expect(JSON.stringify(out)).not.toContain(BUS_TOKEN);
    expect(out.web).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4632,
      bus: {
        bind: "127.0.0.1:7878",
        tokenConfigured: true,
        allowedAgentIds: ["main"],
        allowedOrigins: ["http://127.0.0.1:4632"],
      },
    });
  });

  it("buildState reports the bus but not its token", async () => {
    const out = await buildState({
      pid: 1,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: settingsWith(WEB_WITH_BUS),
      jobs: [],
    });
    expect(JSON.stringify(out)).not.toContain(BUS_TOKEN);
    expect(out.web.bus?.tokenConfigured).toBe(true);
    expect(out.web.bus?.bind).toBe("127.0.0.1:7878");
  });

  it("says a token is configured when it comes from CCAW_WEBUI_TOKEN", () => {
    process.env.CCAW_WEBUI_TOKEN = BUS_TOKEN;
    const out = sanitizeSettings(
      settingsWith({ ...WEB_WITH_BUS, bus: { bind: "127.0.0.1:7878" } }),
    );
    expect(out.web.bus?.tokenConfigured).toBe(true);
    expect(JSON.stringify(out)).not.toContain(BUS_TOKEN);
  });

  it("says no token is configured when the bus has none", () => {
    const out = sanitizeSettings(
      settingsWith({
        ...WEB_WITH_BUS,
        bus: { bind: "127.0.0.1:7878", allowedOrigins: ["http://localhost:4632"] },
      }),
    );
    expect(out.web.bus?.tokenConfigured).toBe(false);
    expect(out.web.bus?.allowedOrigins).toEqual(["http://localhost:4632"]);
  });

  it("treats a whitespace-only token as not configured, like the adapter", () => {
    const out = sanitizeSettings(
      settingsWith({ ...WEB_WITH_BUS, bus: { bind: "127.0.0.1:7878", token: "  \n" } }),
    );
    expect(out.web.bus?.tokenConfigured).toBe(false);
  });

  it("leaves bus out when web.bus is not set", () => {
    const out = sanitizeSettings(settingsWith({ enabled: true, host: "127.0.0.1", port: 4632 }));
    expect(out.web).toEqual({ enabled: true, host: "127.0.0.1", port: 4632 });
  });

  it("does not echo fields it does not know about", () => {
    const out = sanitizeSettings(
      settingsWith({
        ...WEB_WITH_BUS,
        extra: BUS_TOKEN,
        bus: { ...WEB_WITH_BUS.bus, futureSecret: BUS_TOKEN },
      }),
    );
    expect(JSON.stringify(out)).not.toContain(BUS_TOKEN);
  });
});

describe("over HTTP", () => {
  it("neither route returns the bus token", async () => {
    const webToken = `web-${"test"}-token-abcdefghijklmnop`;
    const handle = startWebUi({
      host: "127.0.0.1",
      port: 0,
      token: webToken,
      getSnapshot: () => ({
        pid: 1,
        startedAt: Date.now(),
        heartbeatNextAt: 0,
        settings: settingsWith(WEB_WITH_BUS),
        jobs: [],
      }),
    });
    try {
      for (const path of ["/api/settings", "/api/state"]) {
        const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
          headers: { Authorization: `Bearer ${webToken}` },
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).not.toContain(BUS_TOKEN);
        expect(JSON.parse(body).web.bus.tokenConfigured).toBe(true);
      }
    } finally {
      handle.stop();
    }
  });
});
