import { describe, it, expect, afterEach } from "bun:test";
import { sendMessage } from "../discord.js";

// The legacy command runtime (commands/discord.ts) drives its own HTTP sends
// through the module-global `fetch`, distinct from the Bus runtime's
// DiscordRestApi (covered in adapters/discord/__tests__/rest-api.test.ts). This
// pins the #323 mention-deny on that runtime's primary text path — the one an
// adversarial review found still leaking after the first fix.
const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("commands/discord sendMessage — mention deny (#323)", () => {
  it("attaches allowed_mentions:{parse:[]} to every chunk POST", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await sendMessage("tok", "c1", "hello @everyone");

    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b.allowed_mentions).toEqual({ parse: [] });
      expect(b.content).toContain("@everyone"); // content is untouched; only pings are denied
    }
  });
});
