/**
 * `claudeclaw oneshot` (#552): list, set (same refusal as the API), engine
 * add/rm (key env NAME only), test. settings.json is a temp file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests } from "../../config";
import type { OneShotEngine } from "../../oneshot/engine";
import { engines } from "../../oneshot/registry";
import { startWebUi } from "../../ui/server";
import type { WebSnapshot } from "../../ui/types";
import { runOneshotCommand } from "../oneshot";

const SECRET = "sk-cli-secret-552";
const KEY_ENV = "ONESHOT_CLI_552_KEY";
let tempDir = "";
let settingsFile = "";

const START = {
  model: "opus",
  oneShot: {
    engines: { local: { type: "ollama", model: "llama3.2" } },
    routes: { "tuner.*": "local" },
  },
};

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOneshotCommand(args, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

interface SavedSettings {
  oneShot: { default?: string; routes: Record<string, string>; engines: Record<string, unknown> };
}

async function saved(): Promise<SavedSettings> {
  return JSON.parse(await readFile(settingsFile, "utf-8"));
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "oneshot-cli-"));
  settingsFile = join(tempDir, "settings.json");
  _setSettingsFileForTests(settingsFile);
});

afterAll(async () => {
  _setSettingsFileForTests();
  delete process.env[KEY_ENV];
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env[KEY_ENV] = SECRET;
  await writeFile(settingsFile, `${JSON.stringify(START, null, 2)}\n`);
});

describe("oneshot list", () => {
  it("prints each route with the engine it uses now and where that comes from", async () => {
    const { code, out } = await cli("list");
    expect(code).toBe(0);
    expect(out[0]).toBe("default  print");
    expect(out.find((l) => l.startsWith("compact "))).toMatch(/^compact\s+print\s+\(default\)$/);
    expect(out.find((l) => l.startsWith("tuner.judge "))).toMatch(
      /^tuner\.judge\s+local\s+\(tuner\.\*\)$/,
    );
    expect(out.find((l) => l.startsWith("engine local"))).toContain("ollama");
  });
});

describe("oneshot set", () => {
  it("routes a call to an allowed engine", async () => {
    const { code } = await cli("set", "memory.recall", "local");
    expect(code).toBe(0);
    expect((await saved()).oneShot.routes).toEqual({
      "tuner.*": "local",
      "memory.recall": "local",
    });
  });

  it("sets the default, and refuses pty while untrusted routes would inherit it", async () => {
    const refused = await cli("set", "default", "pty");
    expect(refused.code).toBe(1);
    expect(refused.err[0]).toContain("untrusted route 'discord.classifier' cannot use 'pty'");
    for (const route of ["discord.classifier", "memory.recall"])
      expect((await cli("set", route, "print")).code).toBe(0);
    const { code } = await cli("set", "default", "pty");
    expect(code).toBe(0);
    expect((await saved()).oneShot.default).toBe("pty");
  });

  it("refuses a forbidden combination with the API's message and writes nothing", async () => {
    const before = await readFile(settingsFile, "utf-8");
    const { code, err } = await cli("set", "compact", "local");
    expect(code).toBe(1);
    expect(await readFile(settingsFile, "utf-8")).toBe(before);

    // Same refusal through POST /api/settings/oneshot.
    const token = "cli-api-compare-token-552-abcdefgh";
    const handle = startWebUi({
      host: "127.0.0.1",
      port: 0,
      token,
      getSnapshot: () =>
        ({
          pid: 1,
          startedAt: 0,
          heartbeatNextAt: 0,
          settings: { web: { host: "127.0.0.1" } },
          jobs: [],
        }) as unknown as WebSnapshot,
    });
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const auth = { Authorization: `Bearer ${token}` };
      const c = await fetch(`${base}/api/csrf-token`, { headers: auth });
      const { token: csrf } = (await c.json()) as { token: string };
      const res = await fetch(`${base}/api/settings/oneshot`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: c.headers.get("set-cookie") ?? "",
        },
        body: JSON.stringify({ routes: { compact: "local" } }),
      });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(err).toEqual([`error: ${error}`]);
      expect(error).toBe("oneShot route 'compact' requires resume; engine 'local' cannot resume");
    } finally {
      handle.stop();
    }
  });

  it("unset drops the explicit route", async () => {
    await cli("set", "memory.recall", "local");
    const { code } = await cli("unset", "memory.recall");
    expect(code).toBe(0);
    expect((await saved()).oneShot.routes).toEqual({ "tuner.*": "local" });
  });
});

describe("oneshot engine", () => {
  it("add writes the key env variable NAME, never the key", async () => {
    const { code } = await cli(
      "engine",
      "add",
      "remote",
      "--kind",
      "openai-compatible",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "gpt-x",
      "--key-env",
      KEY_ENV,
    );
    expect(code).toBe(0);
    const text = await readFile(settingsFile, "utf-8");
    expect(JSON.parse(text).oneShot.engines.remote).toEqual({
      type: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-x",
      apiKeyEnv: KEY_ENV,
    });
    expect(text).not.toContain(SECRET);
  });

  it("add refuses --key and writes nothing", async () => {
    const before = await readFile(settingsFile, "utf-8");
    const { code, err } = await cli(
      "engine",
      "add",
      "remote",
      "--kind",
      "openai-compatible",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "gpt-x",
      "--key",
      SECRET,
    );
    expect(code).toBe(1);
    expect(err[0]).toContain("never stored");
    expect(await readFile(settingsFile, "utf-8")).toBe(before);
  });

  it("add refuses a key passed as --key-env", async () => {
    const { code, err } = await cli(
      "engine",
      "add",
      "remote",
      "--kind",
      "openai-compatible",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "gpt-x",
      "--key-env",
      SECRET,
    );
    expect(code).toBe(1);
    expect(err[0]).toContain("must be the NAME of an environment variable");
    expect(await readFile(settingsFile, "utf-8")).not.toContain(SECRET);
  });

  it("rm removes an unused engine and refuses one a route still uses", async () => {
    await cli("engine", "add", "spare", "--kind", "ollama", "--model", "m");
    expect((await cli("engine", "rm", "spare")).code).toBe(0);
    expect((await saved()).oneShot.engines.spare).toBeUndefined();
    const used = await cli("engine", "rm", "local");
    expect(used.code).toBe(1);
    expect(used.err[0]).toContain("Unknown oneShot engine 'local'");
  });
});

describe("oneshot test", () => {
  const mock: OneShotEngine = {
    id: "mock-cli",
    caps: { resume: false, tools: false, isolation: true },
    run: async () => ({ text: "PONG", engine: "mock-cli", model: "m", exitCode: 0 }),
  };
  beforeAll(() => engines.set("mock-cli", mock));
  afterAll(() => engines.delete("mock-cli"));

  it("runs the probe and reports isolation ok", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({ oneShot: { engines: { m: { type: "mock-cli" } } } }),
    );
    const { code, out } = await cli("test", "m");
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^engine m: isolation ok, \d+ ms, exit 0$/);
    expect(out[1]).toBe("PONG");
  });
});

describe("oneshot engine add, key flag forms", () => {
  for (const flag of [`--key=${SECRET}`, `--api-key=${SECRET}`]) {
    it(`refuses ${flag.split("=")[0]}= and writes nothing`, async () => {
      const before = await readFile(settingsFile, "utf-8");
      const { code } = await cli("engine", "add", "r", "--kind", "ollama", "--model", "m", flag);
      expect(code).toBe(1);
      expect(await readFile(settingsFile, "utf-8")).toBe(before);
    });
  }
});
