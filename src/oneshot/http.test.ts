import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings, reloadSettings } from "../config.js";
import { parseOneShotSettings } from "./config.js";
import { runOneShot, type OneShotRequest } from "./engine.js";
import { withPrintRuntime } from "./print.js";
import { engines } from "./registry.js";

const HTTP_ENGINES = ["openai-compatible", "ollama", "llm-router"];
const KEY_ENV = "ONESHOT_HTTP_TEST_KEY";
// Not shaped like any credential the stderr masker knows, so only the engine keeps it out.
const SECRET = "hunter2-oneshot-secret";

interface Seen {
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

const completion = (message: Record<string, unknown>, model = "served-model"): Response =>
  Response.json({
    model,
    choices: [{ message }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  });

/** A local chat-completions server recording every request it receives. */
function mockServer(reply: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const entry = {
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      };
      seen.push(entry);
      return reply(entry);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

const untrusted: OneShotRequest = {
  route: "discord.classifier",
  prompt: "user text",
  system: "classify",
  model: "claude-sonnet-4-20250514",
  isolation: "untrusted",
  maxTokens: 64,
  timeoutMs: 2000,
};

let dir: string;
let server: ReturnType<typeof mockServer> | undefined;
async function useSettings(settings: unknown): Promise<void> {
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  _setSettingsFileForTests(file);
  await loadSettings();
}
/** Settings that point `id` at the mock server, and the declaration to pass it. */
async function pointAt(id: string, url: string, extra: Record<string, unknown> = {}) {
  await useSettings({
    llmRouter: { openRouterBaseUrl: url, tiers: { fast: ["router-model"] } },
  });
  return id === "llm-router" ? { ...extra } : { baseUrl: url, model: "local-model", ...extra };
}
/** Everything written to the console while `call` runs. */
async function captureConsole<T>(call: () => Promise<T>): Promise<{ result: T; out: string }> {
  const lines: string[] = [];
  const saved = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  Object.assign(console, { info: record, warn: record, error: record, log: record });
  try {
    return { result: await call(), out: lines.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-http-"));
  await useSettings({});
  delete process.env[KEY_ENV];
});
afterEach(() => {
  server?.stop();
  server = undefined;
  delete process.env[KEY_ENV];
  _setSettingsFileForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("HTTP engines", () => {
  it("are registered stateless: no resume, no tools, isolation", () => {
    for (const id of HTTP_ENGINES)
      expect(engines.get(id)?.caps).toEqual({ resume: false, tools: false, isolation: true });
  });

  for (const id of HTTP_ENGINES) {
    it(`${id}: the request body has no tools and no tool_choice`, async () => {
      server = mockServer(() => completion({ content: "ok" }));
      const config = await pointAt(id, server.url);
      const result = await engines.get(id)!.run(untrusted, config);
      expect(result.exitCode).toBe(0);
      expect(server.seen).toHaveLength(1);
      const { path, body } = server.seen[0]!;
      expect(path).toBe("/v1/chat/completions");
      expect(Object.keys(body)).not.toContain("tools");
      expect(Object.keys(body)).not.toContain("tool_choice");
      expect(body.messages).toEqual([
        { role: "system", content: "classify" },
        { role: "user", content: "user text" },
      ]);
      expect(body.max_tokens).toBe(64);
      // The configured model, never the Claude model the caller names.
      expect(body.model).toBe(id === "llm-router" ? "router-model" : "local-model");
    });

    it(`${id}: a reply carrying tool_calls yields its text only and triggers no call`, async () => {
      server = mockServer(() =>
        completion({
          content: "the answer",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"touch /tmp/pwned"}' },
            },
          ],
        }),
      );
      const config = await pointAt(id, server.url);
      const result = await engines.get(id)!.run(untrusted, config);
      expect(result).toMatchObject({ text: "the answer", exitCode: 0, engine: id });
      expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
      // No follow-up request carrying a tool result.
      expect(server.seen).toHaveLength(1);
    });

    it(`${id}: a reply with only tool_calls is empty content, a non-zero exit`, async () => {
      server = mockServer(() =>
        completion({
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }],
        }),
      );
      const config = await pointAt(id, server.url);
      const { result, out } = await captureConsole(() => engines.get(id)!.run(untrusted, config));
      expect(result.exitCode).not.toBe(0);
      expect(result.text).toBe("");
      expect(out).toContain("empty content");
      expect(server.seen).toHaveLength(1);
    });

    it(`${id}: no Authorization header when apiKeyEnv is unset or empty`, async () => {
      server = mockServer(() => completion({ content: "ok" }));
      const unset = await pointAt(id, server.url, { apiKeyEnv: KEY_ENV });
      await engines.get(id)!.run(untrusted, unset);
      process.env[KEY_ENV] = "  ";
      await engines.get(id)!.run(untrusted, unset);
      expect(server.seen.map((s) => s.auth)).toEqual([null, null]);
    });

    it(`${id}: apiKeyEnv set sends Bearer <value>, and the key never reaches a log`, async () => {
      let status = 200;
      server = mockServer(() =>
        status === 200 ? completion({ content: "ok" }) : new Response(SECRET, { status }),
      );
      const config = await pointAt(id, server.url, { apiKeyEnv: KEY_ENV });
      process.env[KEY_ENV] = SECRET;
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          llmRouter: { openRouterBaseUrl: server.url, tiers: { fast: ["router-model"] } },
          oneShot: { engines: { [id]: config }, routes: { "discord.classifier": id } },
        }),
      );
      await reloadSettings();
      const ok = await captureConsole(() => runOneShot(untrusted));
      expect(ok.result.exitCode).toBe(0);
      status = 401; // the server echoes the key in its error body
      const denied = await captureConsole(() => runOneShot(untrusted));
      expect(denied.result.exitCode).not.toBe(0);
      expect(server.seen.map((s) => s.auth)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
      expect(ok.out).toContain("[oneshot]");
      expect(denied.out).toContain("HTTP 401");
      for (const out of [ok.out, denied.out]) expect(out).not.toContain(SECRET);
      expect(JSON.stringify([ok.result, denied.result])).not.toContain(SECRET);
    });

    it(`${id}: the timeout aborts the request and returns a non-zero exit code`, async () => {
      server = mockServer(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(completion({ content: "late" })), 1500),
          ),
      );
      const config = await pointAt(id, server.url);
      const started = Date.now();
      const { result, out } = await captureConsole(() =>
        engines.get(id)!.run({ ...untrusted, timeoutMs: 50 }, config),
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.exitCode).toBe(124);
      expect(result.text).toBe("");
      expect(out).toContain("timeout after 50ms");
    });

    it(`${id}: the timeout also stops a reply whose body stalls after the headers`, async () => {
      server = mockServer(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"choices":'));
              },
            }),
            { status: 200 },
          ),
      );
      const config = await pointAt(id, server.url);
      const started = Date.now();
      const { result, out } = await captureConsole(() =>
        engines.get(id)!.run({ ...untrusted, timeoutMs: 50 }, config),
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.exitCode).toBe(124);
      expect(out).toContain("timeout after 50ms");
    });

    it(`${id}: a caller abort mid-request stops it with a non-zero exit code`, async () => {
      server = mockServer(() => new Promise<Response>(() => {}));
      const config = await pointAt(id, server.url);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const started = Date.now();
      const { result, out } = await captureConsole(() =>
        engines.get(id)!.run({ ...untrusted, signal: controller.signal }, config),
      );
      // Well before the 2 s deadline: the abort, not the timer, stopped it.
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.exitCode).toBe(124);
      expect(out).toContain('"reason":"aborted"');
    });

    it(`${id}: a non-2xx reply is a non-zero exit with the status in the log line`, async () => {
      // Chat-shaped body: only the status says it failed.
      server = mockServer(() =>
        Response.json({ choices: [{ message: { content: "bad request" } }] }, { status: 400 }),
      );
      const config = await pointAt(id, server.url);
      const { result, out } = await captureConsole(() => engines.get(id)!.run(untrusted, config));
      expect(result.exitCode).toBe(1);
      expect(out).toContain("HTTP 400");
      expect(out).toContain('"route":"discord.classifier"');
      expect(out).not.toContain("bad request");
    });

    it(`${id}: a key the HTTP client rejects never reaches the log`, async () => {
      server = mockServer(() => completion({ content: "ok" }));
      const config = await pointAt(id, server.url, { apiKeyEnv: KEY_ENV });
      // A pasted curly quote: fetch refuses the header and quotes it in its error.
      process.env[KEY_ENV] = "pasted\u2019SECRETTAIL99";
      const { result, out } = await captureConsole(() => engines.get(id)!.run(untrusted, config));
      expect(result.exitCode).toBe(1);
      expect(out).toContain("network error");
      expect(out).not.toContain("SECRETTAIL99");
      expect(server.seen).toHaveLength(0);
    });

    it(`${id}: a 200 reply that is not JSON is a non-zero exit, logged with its status`, async () => {
      server = mockServer(() => new Response("<html>proxy login</html>", { status: 200 }));
      const config = await pointAt(id, server.url);
      const { result, out } = await captureConsole(() => engines.get(id)!.run(untrusted, config));
      expect(result.exitCode).toBe(1);
      expect(out).toContain("invalid JSON reply (HTTP 200)");
    });

    it(`${id}: a reply over 16 MiB is cut off, not buffered`, async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      server = mockServer(() => {
        // 17 MiB then the end: just over the bound, finite so a missing bound fails the test
        // instead of filling memory.
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent++ < 17) controller.enqueue(chunk);
              else controller.close();
            },
          }),
          { status: 200 },
        );
      });
      const config = await pointAt(id, server.url);
      const { result, out } = await captureConsole(() =>
        engines.get(id)!.run({ ...untrusted, timeoutMs: 4000 }, config),
      );
      expect(result.exitCode).toBe(1);
      expect(out).toContain("reply over 16777216 bytes");
    });

    it(`${id}: a redirect is refused, so the key never follows it`, async () => {
      const elsewhere = mockServer(() => completion({ content: "captured" }));
      try {
        server = mockServer(
          () =>
            new Response(null, {
              status: 307,
              headers: { location: `${elsewhere.url}/chat/completions` },
            }),
        );
        const config = await pointAt(id, server.url, { apiKeyEnv: KEY_ENV });
        process.env[KEY_ENV] = SECRET;
        const { result } = await captureConsole(() => engines.get(id)!.run(untrusted, config));
        expect(result.exitCode).not.toBe(0);
        expect(elsewhere.seen).toHaveLength(0);
      } finally {
        elsewhere.stop();
      }
    });
  }

  it("ollama defaults its base URL to the local Ollama OpenAI endpoint", () => {
    // Accepted with a model only; openai-compatible requires the base URL.
    expect(() =>
      parseOneShotSettings({ engines: { ollama: { model: "qwen3:4b" } } }),
    ).not.toThrow();
    expect(() =>
      parseOneShotSettings({ engines: { "openai-compatible": { model: "m" } } }),
    ).toThrow("baseUrl is required");
  });

  it("llm-router delegates to callLlm: tier models in order, fallback on 5xx", async () => {
    server = mockServer(({ body }) =>
      body.model === "first"
        ? new Response("overloaded", { status: 503 })
        : completion({ content: "from second" }, String(body.model)),
    );
    await useSettings({
      llmRouter: { openRouterBaseUrl: server.url, tiers: { balanced: ["first", "second"] } },
    });
    const result = await engines.get("llm-router")!.run(untrusted, { tier: "balanced" });
    expect(result).toMatchObject({ text: "from second", model: "second", exitCode: 0 });
    expect(server.seen.map((s) => s.body.model)).toEqual(["first", "second"]);
  });

  it("llm-router logs the last status when every tier model fails", async () => {
    server = mockServer(() => new Response("overloaded", { status: 503 }));
    const many = Array.from({ length: 30 }, (_, n) => `vendor/a-rather-long-model-id-${n}`);
    await useSettings({ llmRouter: { openRouterBaseUrl: server.url, tiers: { fast: many } } });
    const { result, out } = await captureConsole(() =>
      engines.get("llm-router")!.run(untrusted, {}),
    );
    expect(result.exitCode).toBe(1);
    expect(server.seen).toHaveLength(30);
    expect(out).toContain('"reason":"HTTP 503 (30 model(s) tried)"');
  });

  it("llm-router moves to the next tier model when one replies with empty content", async () => {
    server = mockServer(({ body }) =>
      completion({ content: body.model === "first" ? "" : "from second" }, String(body.model)),
    );
    await useSettings({
      llmRouter: { openRouterBaseUrl: server.url, tiers: { fast: ["first", "second"] } },
    });
    const result = await engines.get("llm-router")!.run(untrusted, {});
    expect(result).toMatchObject({ text: "from second", model: "second", exitCode: 0 });
    expect(server.seen.map((s) => s.body.model)).toEqual(["first", "second"]);
  });

  it("llm-router moves to the next tier model when the connection drops mid-body", async () => {
    let calls = 0;
    const tcp = createServer((socket) => {
      socket.once("data", () => {
        if (++calls === 1) {
          // Headers promise 500 bytes; the connection drops after 11.
          socket.write(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"choices":',
          );
          setTimeout(() => socket.destroy(), 20);
          return;
        }
        const body = JSON.stringify({ model: "second", choices: [{ message: { content: "ok" } }] });
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = tcp.address() as AddressInfo;
      await useSettings({
        llmRouter: {
          openRouterBaseUrl: `http://127.0.0.1:${port}`,
          tiers: { fast: ["first", "second"] },
        },
      });
      const result = await engines.get("llm-router")!.run(untrusted, {});
      expect(result).toMatchObject({ text: "ok", model: "second", exitCode: 0 });
      expect(calls).toBe(2);
    } finally {
      tcp.close();
    }
  });

  it("llm-router reads OPENROUTER_API_KEY by default", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = SECRET;
    try {
      server = mockServer(() => completion({ content: "ok" }));
      const config = await pointAt("llm-router", server.url);
      await engines.get("llm-router")!.run(untrusted, config);
      expect(server.seen[0]!.auth).toBe(`Bearer ${SECRET}`);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it("the classifier's print-only runtime does not divert an HTTP route to print", async () => {
    server = mockServer(() => completion({ content: '{"action":"hire","names":["a"]}' }));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        oneShot: {
          engines: { local: { type: "ollama", baseUrl: server.url, model: "qwen3:4b" } },
          routes: { "discord.classifier": "local" },
        },
      }),
    );
    await reloadSettings();
    const throwingSpawn = (() => {
      throw new Error("unexpected spawn");
    }) as unknown as typeof spawn;
    const { result } = await captureConsole(() =>
      withPrintRuntime({ env: {}, stdinPrompt: true, spawn: throwingSpawn }, () =>
        runOneShot(untrusted),
      ),
    );
    expect(result).toMatchObject({ engine: "ollama", exitCode: 0 });
    expect(server.seen[0]!.body.model).toBe("qwen3:4b");
  });
});

describe("HTTP engine configuration", () => {
  it("compact (resume) mapped to ollama fails at load", async () => {
    expect(() => parseOneShotSettings({ routes: { compact: "ollama" } })).toThrow(
      "requires resume",
    );
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        oneShot: { engines: { ollama: { model: "m" } }, routes: { compact: "ollama" } },
      }),
    );
    await expect(reloadSettings()).rejects.toThrow("requires resume");
  });

  it("every resume route and the default reject each HTTP engine, by name or alias", () => {
    for (const type of HTTP_ENGINES) {
      const local = { type, baseUrl: "http://127.0.0.1:1/v1", model: "m" };
      const declared = type === "llm-router" ? { type } : local;
      for (const route of [
        "compact",
        "memory.save.precompact",
        "rotation.summary",
        "memory.save.stop",
      ])
        expect(() =>
          parseOneShotSettings({ engines: { local: declared }, routes: { [route]: "local" } }),
        ).toThrow("requires resume");
      expect(() =>
        parseOneShotSettings({ engines: { local: declared }, default: "local" }),
      ).toThrow("requires resume");
    }
  });

  it("an alias names its built-in through engines.<name>.type", () => {
    const settings = parseOneShotSettings({
      engines: {
        local: { type: "ollama", baseUrl: "http://10.0.0.5:11434/v1", model: "qwen3:4b" },
      },
      routes: { "tuner.*": "local", "discord.classifier": "local", "memory.recall": "local" },
    });
    expect(settings.routes["tuner.*"]).toBe("local");
  });

  it("rejects an alias whose type is not a built-in, or that retypes a built-in", () => {
    expect(() =>
      parseOneShotSettings({
        engines: { local: { type: "llama", model: "m" } },
        routes: { "tuner.*": "local" },
      }),
    ).toThrow("oneShot.engines.local.type must be one of");
    expect(() => parseOneShotSettings({ engines: { local: { model: "m" } } })).toThrow(
      "oneShot.engines.local.type must be one of",
    );
    expect(() => parseOneShotSettings({ engines: { ollama: { type: "print" } } })).toThrow(
      "cannot change the type of a built-in",
    );
  });

  it("checks the settings of an HTTP engine a route uses without declaring it", () => {
    expect(() => parseOneShotSettings({ routes: { "tuner.*": "openai-compatible" } })).toThrow(
      "oneShot.engines.openai-compatible.baseUrl is required",
    );
    expect(() => parseOneShotSettings({ routes: { "tuner.*": "ollama" } })).toThrow(
      "oneShot.engines.ollama.model is required",
    );
    expect(parseOneShotSettings({ routes: { "tuner.*": "llm-router" } }).routes["tuner.*"]).toBe(
      "llm-router",
    );
  });

  it("never accepts a key in settings, only the name of its env variable", () => {
    const base = { type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "m" };
    expect(() => parseOneShotSettings({ engines: { or: { ...base, apiKey: SECRET } } })).toThrow(
      "name its env variable in apiKeyEnv",
    );
    expect(() => parseOneShotSettings({ engines: { or: { ...base, apiKeyEnv: SECRET } } })).toThrow(
      "must be the name of an environment variable",
    );
    expect(
      parseOneShotSettings({ engines: { or: { ...base, apiKeyEnv: "OPENROUTER_API_KEY" } } })
        .engines.or,
    ).toMatchObject({ apiKeyEnv: "OPENROUTER_API_KEY" });
  });

  it("rejects malformed HTTP engine settings at load", () => {
    for (const [config, message] of [
      [{ type: "openai-compatible", baseUrl: "file:///etc", model: "m" }, "http(s) URL"],
      [{ type: "openai-compatible", baseUrl: "not a url", model: "m" }, "http(s) URL"],
      [{ type: "ollama", model: "" }, "non-empty string"],
      [{ type: "ollama", model: "m", modle: "typo" }, "is not a setting of this engine"],
      [{ type: "llm-router", tier: "cheap" }, "tier must be one of"],
      [{ type: "llm-router", baseUrl: "http://x" }, "is not a setting of this engine"],
    ] as const) {
      expect(() => parseOneShotSettings({ engines: { local: config } })).toThrow(message);
    }
  });
});
