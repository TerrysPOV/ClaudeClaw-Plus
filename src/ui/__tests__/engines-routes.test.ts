/**
 * /api/settings/oneshot, /api/settings/engines and /api/oneshot/test (#552).
 * Real startWebUi on an ephemeral port, settings.json redirected to a temp
 * file; the probe runs against mock engines registered for the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests } from "../../config";
import type { OneShotEngine } from "../../oneshot/engine";
import { engines } from "../../oneshot/registry";
import { startWebUi } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";

const TOKEN = "test-web-token-engines-552-abcdef";
const SECRET = "sk-test-secret-value-552";
const KEY_ENV = "ENGINES_552_TEST_KEY";

let tempDir = "";
let settingsFile = "";
let handle: WebServerHandle;
let base = "";

const auth = { Authorization: `Bearer ${TOKEN}` };

/** Engine stubs: one answers, one does what the injected text asks (creates the canary). */
const mockOk: OneShotEngine = {
  id: "mock-ok",
  caps: { resume: false, tools: false, isolation: true },
  run: async () => ({ text: "PONG", engine: "mock-ok", model: "m", exitCode: 0 }),
};
const mockLeak: OneShotEngine = {
  id: "mock-leak",
  caps: { resume: false, tools: false, isolation: true },
  run: async (req) => {
    const path = /touch (\S+)/.exec(req.prompt)?.[1];
    if (path) writeFileSync(path, "pwned");
    return { text: "done", engine: "mock-leak", model: "m", exitCode: 0 };
  },
};

const BASE_SETTINGS = {
  model: "opus",
  futureKey: { kept: true },
  discord: { allowedUserIds: ["BIG_ID"] },
  pty: { enabled: false, idleReapMinutes: 7 },
  oneShot: {
    engines: {
      local: {
        type: "openai-compatible",
        baseUrl: "https://user:hunter2@llm.example/v1",
        model: "m1",
        apiKeyEnv: KEY_ENV,
      },
      okay: { type: "mock-ok" },
      leaky: { type: "mock-leak" },
    },
    routes: { "memory.recall": "local" },
  },
};
// The big integer must survive a rewrite verbatim (#496): written by hand.
const BASE_TEXT = JSON.stringify(BASE_SETTINGS, null, 2).replace(
  '"BIG_ID"',
  "123456789012345678901",
);

function snapshot(): WebSnapshot {
  return {
    pid: 1,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
      pty: { enabled: false },
      agents: [{ id: "default" }],
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

async function csrfHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/csrf-token`, { headers: auth });
  const { token } = (await res.json()) as { token: string };
  return {
    ...auth,
    "Content-Type": "application/json",
    "X-CSRF-Token": token,
    Cookie: res.headers.get("set-cookie") ?? "",
  };
}

async function post(path: string, payload: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  engines.set("mock-ok", mockOk);
  engines.set("mock-leak", mockLeak);
  tempDir = await mkdtemp(join(tmpdir(), "engines-routes-"));
  settingsFile = join(tempDir, "settings.json");
  _setSettingsFileForTests(settingsFile);
  handle = startWebUi({ host: "127.0.0.1", port: 0, token: TOKEN, getSnapshot: snapshot });
  base = `http://${handle.host}:${handle.port}`;
});

afterAll(async () => {
  handle.stop();
  engines.delete("mock-ok");
  engines.delete("mock-leak");
  delete process.env[KEY_ENV];
  _setSettingsFileForTests();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env[KEY_ENV] = SECRET;
  await writeFile(settingsFile, `${BASE_TEXT}\n`);
});

describe("token", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/settings/oneshot"],
    ["POST", "/api/settings/oneshot"],
    ["GET", "/api/settings/engines"],
    ["POST", "/api/settings/engines"],
    ["POST", "/api/oneshot/test"],
  ];
  for (const [method, path] of routes) {
    it(`${method} ${path} without the token → 401`, async () => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ engine: "okay" }) } : {}),
      });
      expect(res.status).toBe(401);
    });
  }

  it("POST without the CSRF token → 403, nothing written", async () => {
    const res = await fetch(`${base}/api/settings/oneshot`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ default: "okay" }),
    });
    expect(res.status).toBe(403);
    expect(await readFile(settingsFile, "utf-8")).toBe(`${BASE_TEXT}\n`);
  });
});

describe("/api/settings/oneshot", () => {
  it("GET lists routes, effective engines and caps-filtered choices", async () => {
    const res = await fetch(`${base}/api/settings/oneshot`, { headers: auth });
    expect(res.status).toBe(200);
    const { oneShot } = (await res.json()) as {
      oneShot: {
        default: string;
        effective: Record<string, string>;
        choices: Record<string, string[]>;
      };
    };
    expect(oneShot.default).toBe("print");
    expect(oneShot.effective["memory.recall"]).toBe("local");
    expect(oneShot.effective.compact).toBe("print");
    // resume routes: print / pty only
    expect(oneShot.choices.compact).toEqual(["print", "pty"]);
    // untrusted routes: isolation only, so no pty
    expect(oneShot.choices["tuner.judge"]).not.toContain("pty");
    expect(oneShot.choices["tuner.judge"]).toContain("print");
    expect(oneShot.choices["tuner.judge"]).toContain("local");
  });

  it("GET never returns a key: keyPresent and a masked base URL only", async () => {
    const res = await fetch(`${base}/api/settings/oneshot`, { headers: auth });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunter2");
    const local = (
      JSON.parse(text) as { oneShot: { engines: Array<Record<string, unknown>> } }
    ).oneShot.engines.find((e) => e.name === "local");
    expect(local).toEqual({
      name: "local",
      type: "openai-compatible",
      baseUrl: "https://***:***@llm.example/v1",
      model: "m1",
      apiKeyEnv: KEY_ENV,
      keyPresent: true,
    });
    delete process.env[KEY_ENV];
    const again = (await (
      await fetch(`${base}/api/settings/oneshot`, { headers: auth })
    ).json()) as {
      oneShot: { engines: Array<{ name: string; keyPresent: boolean }> };
    };
    expect(again.oneShot.engines.find((e) => e.name === "local")?.keyPresent).toBe(false);
  });

  it("a resume route on an HTTP engine → 400 with the loader's reason, file untouched", async () => {
    const res = await post("/api/settings/oneshot", { routes: { compact: "local" } });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe(
      "oneShot route 'compact' requires resume; engine 'local' cannot resume",
    );
    expect(await readFile(settingsFile, "utf-8")).toBe(`${BASE_TEXT}\n`);
  });

  it("an untrusted route on pty → 400 (no isolation)", async () => {
    const res = await post("/api/settings/oneshot", { routes: { "tuner.propose": "pty" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "does not advertise isolation",
    );
  });

  it("an engine with an apiKey → 400, the key is never written", async () => {
    const res = await post("/api/settings/oneshot", {
      engines: {
        bad: { type: "openai-compatible", baseUrl: "http://x/v1", model: "m", apiKey: SECRET },
      },
    });
    expect(res.status).toBe(400);
    expect(await readFile(settingsFile, "utf-8")).not.toContain(SECRET);
  });

  it("removing an engine a route still uses → 400", async () => {
    const res = await post("/api/settings/oneshot", { engines: { local: null } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Unknown oneShot engine 'local'",
    );
  });

  it("a valid POST writes settings.json atomically, keeps other keys, and GET returns it", async () => {
    const res = await post("/api/settings/oneshot", {
      routes: { "tuner.judge": "local", "memory.recall": null },
      engines: {
        local: {
          type: "openai-compatible",
          baseUrl: "https://***:***@llm.example/v1",
          model: "m2",
          apiKeyEnv: KEY_ENV,
        },
      },
    });
    expect(res.status).toBe(200);
    const text = await readFile(settingsFile, "utf-8");
    const saved = JSON.parse(text);
    expect(saved.oneShot.routes).toEqual({ "tuner.judge": "local" });
    expect(saved.oneShot.engines.local.model).toBe("m2");
    // the masked URL sent back unchanged keeps the stored one
    expect(saved.oneShot.engines.local.baseUrl).toBe("https://user:hunter2@llm.example/v1");
    expect(saved.futureKey).toEqual({ kept: true });
    expect(saved.pty).toEqual({ enabled: false, idleReapMinutes: 7 });
    expect(text).toContain("123456789012345678901");
    expect((await readdir(tempDir)).filter((f) => f.includes(".tmp-"))).toEqual([]);

    const back = (await (
      await fetch(`${base}/api/settings/oneshot`, { headers: auth })
    ).json()) as {
      oneShot: { routes: Record<string, string>; effective: Record<string, string> };
    };
    expect(back.oneShot.routes).toEqual({ "tuner.judge": "local" });
    expect(back.oneShot.effective["memory.recall"]).toBe("print");
  });

  it("POST with no oneShot field → 400", async () => {
    const res = await post("/api/settings/oneshot", { nothing: 1 });
    expect(res.status).toBe(400);
  });
});

describe("/api/settings/engines", () => {
  it("GET reports saved vs running and the bus supervision per agent", async () => {
    const res = await fetch(`${base}/api/settings/engines`, { headers: auth });
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toEqual({
      ok: true,
      saved: { pty: { enabled: false }, agents: [{ id: "default", supervision: "pty-stdin" }] },
      running: { pty: { enabled: false }, agents: [{ id: "default", supervision: "pty-stdin" }] },
      restartRequired: false,
    });
  });

  it("POST pty.enabled writes it, keeps the other pty keys, and flags a restart", async () => {
    const res = await post("/api/settings/engines", { pty: { enabled: true } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      saved: { pty: { enabled: boolean } };
      restartRequired: boolean;
    };
    expect(data.saved.pty.enabled).toBe(true);
    expect(data.restartRequired).toBe(true);
    const saved = JSON.parse(await readFile(settingsFile, "utf-8"));
    expect(saved.pty).toEqual({ enabled: true, idleReapMinutes: 7 });
  });

  it("POST with a non-boolean → 400, nothing written", async () => {
    const res = await post("/api/settings/engines", { pty: { enabled: "yes" } });
    expect(res.status).toBe(400);
    expect(await readFile(settingsFile, "utf-8")).toBe(`${BASE_TEXT}\n`);
  });
});

describe("/api/oneshot/test", () => {
  it("a mock engine that stays isolated → isolation ok, latency and output", async () => {
    const res = await post("/api/oneshot/test", { engine: "okay" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.isolation).toBe("ok");
    expect(data.output).toBe("PONG");
    expect(typeof data.latencyMs).toBe("number");
  });

  it("an engine stubbed to leave the canary → isolation fail", async () => {
    const res = await post("/api/oneshot/test", { engine: "leaky" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isolation: string }).isolation).toBe("fail");
  });

  it("pty (isolation spike off) → 400, the canary is not run", async () => {
    const res = await post("/api/oneshot/test", { engine: "pty" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "does not advertise isolation",
    );
  });

  it("an unknown engine → 400", async () => {
    const res = await post("/api/oneshot/test", { engine: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("review follow-ups", () => {
  it("masks a token in the user name or the query string too", async () => {
    const res = await post("/api/settings/oneshot", {
      engines: {
        q: { type: "ollama", baseUrl: "http://tok123@h.example:1/v1?api_key=SECRETQ", model: "m" },
      },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("tok123");
    expect(text).not.toContain("SECRETQ");
    // saving the masked URL back keeps the stored one
    const view = JSON.parse(text) as {
      oneShot: { engines: Array<{ name: string; baseUrl: string }> };
    };
    const masked = view.oneShot.engines.find((e) => e.name === "q")?.baseUrl;
    await post("/api/settings/oneshot", {
      engines: { q: { type: "ollama", baseUrl: masked, model: "m2" } },
    });
    const saved = JSON.parse(await readFile(settingsFile, "utf-8"));
    expect(saved.oneShot.engines.q.baseUrl).toBe("http://tok123@h.example:1/v1?api_key=SECRETQ");
  });

  it("refuses a key pasted as apiKeyEnv and does not echo it", async () => {
    const res = await post("/api/settings/oneshot", {
      engines: { k: { type: "ollama", model: "m", apiKeyEnv: "sk123abcdef0123456789" } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("sk123abcdef0123456789");
    expect(await readFile(settingsFile, "utf-8")).toBe(`${BASE_TEXT}\n`);
  });

  it("a wildcard route is validated like the routes it covers", async () => {
    const bad = await post("/api/settings/oneshot", { routes: { "memory.*": "local" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("requires resume");
    const ok = await post("/api/settings/oneshot", { routes: { "tuner.*": "local" } });
    expect(ok.status).toBe(200);
    const { oneShot } = (await ok.json()) as { oneShot: { effective: Record<string, string> } };
    expect(oneShot.effective["tuner.propose"]).toBe("local");
  });

  it("concurrent POSTs do not lose an update", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const results = await Promise.all([
      ...names.map((n) =>
        post("/api/settings/oneshot", { engines: { [n]: { type: "ollama", model: n } } }),
      ),
      post("/api/settings/engines", { pty: { enabled: true } }),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    const saved = JSON.parse(await readFile(settingsFile, "utf-8"));
    for (const n of names) expect(saved.oneShot.engines[n]).toEqual({ type: "ollama", model: n });
    expect(saved.pty.enabled).toBe(true);
  });

  it("an engine that creates the canary and then fails → isolation fail, canary removed", async () => {
    engines.set("mock-throw", {
      id: "mock-throw",
      caps: { resume: false, tools: false, isolation: true },
      run: async (req) => {
        const path = /touch (\S+)/.exec(req.prompt)?.[1] ?? "";
        writeFileSync(path, "pwned");
        leftover = path;
        throw new Error("boom");
      },
    });
    let leftover = "";
    try {
      await writeFile(
        settingsFile,
        JSON.stringify({ oneShot: { engines: { t: { type: "mock-throw" } } } }),
      );
      const res = await post("/api/oneshot/test", { engine: "t" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { isolation: string }).isolation).toBe("fail");
      expect(leftover).not.toBe("");
      expect(await Bun.file(leftover).exists()).toBe(false);
    } finally {
      engines.delete("mock-throw");
    }
  });

  it("an unknown supervision value reads like the loader: no permanent restart flag", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({ agents: [{ id: "default", supervision: "bogus" }] }),
    );
    const data = (await (
      await fetch(`${base}/api/settings/engines`, { headers: auth })
    ).json()) as {
      restartRequired: boolean;
    };
    expect(data.restartRequired).toBe(false);
  });
});

describe("hand-edited settings.json", () => {
  it("an apiKey written by hand is never returned, GET answers the loader's refusal", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({
        oneShot: { engines: { h: { type: "ollama", model: "m", apiKey: SECRET } } },
      }),
    );
    const res = await fetch(`${base}/api/settings/oneshot`, { headers: auth });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("never stored in settings");
  });
});

describe("hand-written lower-case apiKeyEnv", () => {
  it("stays editable when saved back unchanged, a new lower-case value is refused", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({
        oneShot: { engines: { l: { type: "ollama", model: "m", apiKeyEnv: "openai_key" } } },
      }),
    );
    const kept = await post("/api/settings/oneshot", {
      engines: { l: { type: "ollama", model: "m2", apiKeyEnv: "openai_key" } },
    });
    expect(kept.status).toBe(200);
    const changed = await post("/api/settings/oneshot", {
      engines: { l: { type: "ollama", model: "m2", apiKeyEnv: "other_key" } },
    });
    expect(changed.status).toBe(400);
  });
});
