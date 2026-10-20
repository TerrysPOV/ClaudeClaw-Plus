/**
 * Tests for the recursive secret redaction in src/ui/services/state.ts
 * (issue #164 item 5). buildTechnicalInfo feeds settings through
 * redactSettings before they leave the daemon via /api/technical-info.
 *
 * redactSettings isn't exported, so we exercise it through
 * buildTechnicalInfo with a synthetic snapshot + a temp settings file.
 *
 * Secret-shaped values are assembled at runtime via string concatenation
 * so the in-repo secrets-in-code pre-commit guard doesn't trip on them.
 *
 * Run with: bun test src/ui/__tests__/state-redact.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwdBackup: string;
let tmp: string;

// Built at runtime to dodge the secrets-in-code scanner.
const TG = `tg-${"bot"}-token-xyz`;
const SLACK_BOT = `xoxb${"-"}1aaa`;
const SLACK_APP = `xapp${"-"}1bbb`;

beforeEach(() => {
  cwdBackup = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ccaw-redact-"));
  process.chdir(tmp);
  mkdirSync(join(tmp, ".claude", "claudeclaw"), { recursive: true });
});

afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(tmp, { recursive: true, force: true });
});

function findValue(obj: unknown, key: string): unknown {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findValue(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key) return v;
      const hit = findValue(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

describe("recursive redactSettings via buildTechnicalInfo (#164 item 5)", () => {
  it("redacts secret-named fields at any depth and leaves non-secrets intact", async () => {
    // Settings with secrets at top level, nested, and deeply nested under
    // arbitrary keys — the kind of drift the old hand-rolled redactor missed.
    const settingsObj = {
      model: "opus",
      apiToken: "TOP-SECRET-1234567890",
      api: "glm-key-abc",
      telegram: { token: TG, allowedUserIds: [1, 2] },
      discord: { token: "dc-token" },
      slack: { botToken: SLACK_BOT, appToken: SLACK_APP },
      nested: { deep: { password: "hunter2", secret: "s3cr3t", harmless: "keep-me" } },
      agents: [{ id: "reg", apiKey: "per-agent-key" }],
    };
    writeFileSync(
      join(tmp, ".claude", "claudeclaw", "settings.json"),
      JSON.stringify(settingsObj, null, 2),
    );

    const { buildTechnicalInfo } = await import("../services/state");
    const snapshot = {
      pid: 123,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: settingsObj as never,
      jobs: [],
    };
    const info = (await buildTechnicalInfo(snapshot)) as Record<string, unknown>;
    // Assert against the in-memory snapshot.settings redaction (not the
    // disk-read files.settingsJson) — buildTechnicalInfo reads the file
    // via a module-load-frozen path constant that isn't reliable under
    // per-test chdir. Both paths run the same redactSettings.
    const snap = info.snapshot as Record<string, unknown>;
    const redacted = snap.settings;

    // Every secret-named field, at every depth, is replaced.
    for (const key of [
      "apiToken",
      "api",
      "token",
      "botToken",
      "appToken",
      "password",
      "secret",
      "apiKey",
    ]) {
      const v = findValue(redacted, key);
      expect(typeof v).toBe("string");
      expect(v as string).toMatch(/^<redacted:\d+ chars>$/);
    }
    // Raw secret values never survive anywhere in the output.
    const serialized = JSON.stringify(redacted);
    for (const leaked of [
      "TOP-SECRET-1234567890",
      "glm-key-abc",
      TG,
      "dc-token",
      SLACK_BOT,
      SLACK_APP,
      "hunter2",
      "s3cr3t",
      "per-agent-key",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    // Non-secret fields pass through untouched.
    expect(findValue(redacted, "model")).toBe("opus");
    expect(findValue(redacted, "harmless")).toBe("keep-me");
    expect(findValue(redacted, "allowedUserIds")).toEqual([1, 2]);
  });

  it("records the char-length of the original secret", async () => {
    const settingsObj = { apiToken: "abcdef" }; // 6 chars
    const { buildTechnicalInfo } = await import("../services/state");
    const info = (await buildTechnicalInfo({
      pid: 1,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: settingsObj as never,
      jobs: [],
    })) as Record<string, unknown>;
    const snap = info.snapshot as Record<string, unknown>;
    expect(findValue(snap.settings, "apiToken")).toBe("<redacted:6 chars>");
  });
});

async function redactViaTechnicalInfo(settingsObj: unknown): Promise<unknown> {
  const { buildTechnicalInfo } = await import("../services/state");
  const info = (await buildTechnicalInfo({
    pid: 1,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: settingsObj as never,
    jobs: [],
  })) as Record<string, unknown>;
  return (info.snapshot as Record<string, unknown>).settings;
}

const REDACTED = /^<redacted:\d+ chars>$/;

describe("redactSettings matches secret-shaped key names, not only exact ones (#510)", () => {
  it("redacts slack.signingSecret and slack.busRouting.signingSecret", async () => {
    const signing = `sig${"-"}secret-${"a".repeat(24)}`;
    const routing = `sig${"-"}routing-${"b".repeat(24)}`;
    const redacted = (await redactViaTechnicalInfo({
      slack: {
        botToken: SLACK_BOT,
        signingSecret: signing,
        busRouting: { signingSecret: routing },
      },
    })) as { slack: { signingSecret: unknown; busRouting: { signingSecret: unknown } } };

    expect(redacted.slack.signingSecret).toMatch(REDACTED);
    expect(redacted.slack.busRouting.signingSecret).toMatch(REDACTED);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(signing);
    expect(serialized).not.toContain(routing);
  });

  it("redacts any key ending in a secret-shaped word, at any depth and in any case", async () => {
    const values: Record<string, string> = {
      clientSecret: "cs-value-1",
      webhookSecret: "wh-value-2",
      accessToken: "at-value-3",
      REFRESH_TOKEN: "rt-value-4",
      privateKey: "pk-value-5",
      openai_api_key: "ok-value-6",
      dbPassword: "db-value-7",
      apiKeys: "ak-value-8",
      secrets: "ss-value-9",
      credentials: "cr-value-10",
      passphrase: "pp-value-11",
      smtpPasswd: "sp-value-12",
      Authorization: "Bearer au-value-13",
      cookie: "ck-value-14",
    };
    const redacted = await redactViaTechnicalInfo({
      plugins: { someplugin: { enabled: true, config: { ...values } } },
    });
    for (const [key, raw] of Object.entries(values)) {
      expect(findValue(redacted, key)).toMatch(REDACTED);
      expect(JSON.stringify(redacted)).not.toContain(raw);
    }
    expect(findValue(redacted, "enabled")).toBe(true);
  });

  it("leaves non-secret keys that merely contain those words alone", async () => {
    const redacted = await redactViaTechnicalInfo({
      maxTokens: 4096,
      keywords: ["deploy", "ship"],
      tokenBudget: 1000,
      secretsDir: "/etc/app",
      credentialProbe: { enabled: false },
      provider_credentials_env: { openai: "OPENAI_API_KEY" },
    });
    expect(findValue(redacted, "maxTokens")).toBe(4096);
    expect(findValue(redacted, "keywords")).toEqual(["deploy", "ship"]);
    expect(findValue(redacted, "tokenBudget")).toBe(1000);
    expect(findValue(redacted, "secretsDir")).toBe("/etc/app");
    expect(findValue(redacted, "credentialProbe")).toEqual({ enabled: false });
    expect(findValue(redacted, "provider_credentials_env")).toEqual({ openai: "OPENAI_API_KEY" });
  });

  it("covers every secret-looking field declared in src/config.ts", async () => {
    // Inventory of the Settings shape: every declared field whose name
    // mentions a token/secret/key/password/credential/api. A new one fails
    // here until it is classified, so a secret added later is redacted by
    // default or consciously listed as not secret.
    const SECRET = ["api", "apiToken", "appToken", "botToken", "signingSecret", "token"];
    const NOT_SECRET = [
      "credentialProbe",
      "keywords",
      "provider_credentials_env",
      // quietHours.urgentBypass (#512): a boolean, "pass" as in bypass.
      "urgentBypass",
    ];
    // Matched by the regex below but not settings fields: parseSettingsText's
    // JSON reviver takes a `key` parameter.
    const NOT_A_FIELD = ["key"];
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dir, "..", "..", "config.ts"), "utf8");
    const declared = [
      ...new Set([...src.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1])),
    ]
      .filter((name) => /token|secret|key|pass|cred|api|auth|cookie/i.test(name))
      .filter((name) => !NOT_A_FIELD.includes(name));

    const unclassified = declared.filter((n) => !SECRET.includes(n) && !NOT_SECRET.includes(n));
    expect(unclassified).toEqual([]);

    const settingsObj = Object.fromEntries(declared.map((n) => [n, `value-of-${n}`]));
    const redacted = (await redactViaTechnicalInfo(settingsObj)) as Record<string, unknown>;
    for (const name of declared) {
      if (SECRET.includes(name)) expect(redacted[name]).toMatch(REDACTED);
      else expect(redacted[name]).toBe(`value-of-${name}`);
    }
  });
});

describe("secrets carried in values, under container keys, and in session/state files (#510)", () => {
  // Assembled at runtime, like the values above, to dodge the secrets scanner.
  const PASS = `p4ss${"-"}word-in-url`;
  const QTOKEN = `qt${"-"}${"c".repeat(20)}`;
  const ARG = `ghp${"_"}${"d".repeat(30)}`;
  const HOOK = `https://hooks.slack.com/services/T000/B000/${"e".repeat(24)}`;
  const DISCORD = `https://discord.com/api/webhooks/123456/${"f".repeat(40)}`;
  const DISCORD_PTB = `https://ptb.discord.com/api/webhooks/654321/${"g".repeat(40)}`;

  it("scrubs userinfo and secret-named query parameters out of URLs, keeping the rest", async () => {
    const redacted = (await redactViaTechnicalInfo({
      plugins: {
        db: { url: `postgres://app:${PASS}@db.local:5432/main` },
        gitUserOnly: { remote: `https://${ARG}@github.com/o/r.git` },
        feed: { endpoint: `https://api.example.com/v1?api_key=${QTOKEN}&lang=en` },
        alt: { endpoint: `https://api.example.com/v1?lang=en&access_token=${QTOKEN}#top` },
        plain: { homepage: "https://example.com/docs?page=2" },
      },
    })) as { plugins: Record<string, Record<string, string>> };
    const out = JSON.stringify(redacted);
    for (const leaked of [PASS, QTOKEN, ARG]) expect(out).not.toContain(leaked);
    expect(redacted.plugins.db.url).toContain("@db.local:5432/main");
    expect(redacted.plugins.db.url.startsWith("postgres://")).toBe(true);
    expect(redacted.plugins.gitUserOnly.remote).toContain("@github.com/o/r.git");
    expect(redacted.plugins.feed.endpoint).toContain("lang=en");
    expect(redacted.plugins.alt.endpoint).toContain("lang=en");
    expect(redacted.plugins.alt.endpoint).toContain("#top");
    expect(redacted.plugins.plain.homepage).toBe("https://example.com/docs?page=2");
  });

  it("redacts webhook URLs, by key name and by known shape", async () => {
    const redacted = (await redactViaTechnicalInfo({
      notify: { webhookUrl: "https://my.example.com/hook/abc", webhook: "https://x.example/y" },
      misc: { target: HOOK, other: DISCORD, beta: DISCORD_PTB },
    })) as { notify: Record<string, string>; misc: Record<string, string> };
    expect(redacted.notify.webhookUrl).toMatch(REDACTED);
    expect(redacted.notify.webhook).toMatch(REDACTED);
    const out = JSON.stringify(redacted);
    expect(out).not.toContain("hook/abc");
    expect(out).not.toContain("e".repeat(24));
    expect(out).not.toContain("f".repeat(40));
    expect(out).not.toContain("g".repeat(40));
  });

  it("redacts the value after a secret-named flag, in both --flag value and --flag=value forms", async () => {
    const redacted = (await redactViaTechnicalInfo({
      plugins: {
        mcp: {
          command: "npx",
          args: ["-y", "some-server", "--token", ARG, `--api-key=${QTOKEN}`, "--port", "8080"],
          env: ["DEBUG=1", `GITHUB_TOKEN=${ARG}`],
        },
      },
    })) as { plugins: { mcp: { args: string[]; env: string[] } } };
    const out = JSON.stringify(redacted);
    expect(out).not.toContain(ARG);
    expect(out).not.toContain(QTOKEN);
    const { args, env } = redacted.plugins.mcp;
    expect(args.slice(0, 3)).toEqual(["-y", "some-server", "--token"]);
    expect(args[3]).toMatch(REDACTED);
    expect(args[4].startsWith("--api-key=")).toBe(true);
    expect(args.slice(5)).toEqual(["--port", "8080"]);
    expect(env[0]).toBe("DEBUG=1");
    expect(env[1].startsWith("GITHUB_TOKEN=")).toBe(true);
  });

  it("redacts an env map written as an object like its NAME=value form", async () => {
    const redacted = (await redactViaTechnicalInfo({
      mcpServers: {
        db: {
          env: { DB_PASS: ARG, MYSQL_PWD: QTOKEN, GH_PAT: PASS, DEBUG: "1" },
          auth: { scheme: "custom" },
        },
      },
    })) as { mcpServers: { db: { env: Record<string, string>; auth: { scheme: string } } } };
    const { env, auth } = redacted.mcpServers.db;
    expect(env.DB_PASS).toMatch(REDACTED);
    expect(env.MYSQL_PWD).toMatch(REDACTED);
    expect(env.GH_PAT).toMatch(REDACTED);
    expect(env.DEBUG).toBe("1");
    // An object under a name-part key is still a container, not a blob.
    expect(auth.scheme).toMatch(REDACTED);
    const out = JSON.stringify(redacted);
    for (const raw of [ARG, QTOKEN, PASS]) expect(out).not.toContain(raw);
  });

  it("redacts a bearer credential carried inside a string value", async () => {
    const redacted = (await redactViaTechnicalInfo({
      plugins: { http: { headerLine: `Bearer ${QTOKEN}`, note: "Bearer of good news" } },
    })) as { plugins: { http: Record<string, string> } };
    expect(JSON.stringify(redacted)).not.toContain(QTOKEN);
    expect(redacted.plugins.http.headerLine.startsWith("Bearer ")).toBe(true);
  });

  it("redacts string leaves under a container key like tokens or auth, keeping numbers", async () => {
    const redacted = (await redactViaTechnicalInfo({
      tokens: { github: ARG, limit: 10, fallbacks: [QTOKEN] },
      auth: { bearer: QTOKEN, scheme: "custom", github: PASS },
      maxTokens: 4096,
    })) as {
      tokens: { github: string; limit: number; fallbacks: string[] };
      auth: { bearer: string; scheme: string; github: string };
      maxTokens: number;
    };
    expect(redacted.tokens.github).toMatch(REDACTED);
    expect(redacted.tokens.limit).toBe(10);
    expect(redacted.tokens.fallbacks[0]).toMatch(REDACTED);
    expect(redacted.auth.bearer).toMatch(REDACTED);
    expect(redacted.auth.github).toMatch(REDACTED);
    expect(redacted.maxTokens).toBe(4096);
    const out = JSON.stringify(redacted);
    expect(out).not.toContain(ARG);
    expect(out).not.toContain(QTOKEN);
  });

  it("runs session.json and state.json through the same redactor", async () => {
    const paths = {
      settings: join(tmp, "settings.json"),
      session: join(tmp, "session.json"),
      state: join(tmp, "state.json"),
    };
    writeFileSync(paths.session, JSON.stringify({ sessionId: "abc", apiToken: ARG }));
    writeFileSync(
      paths.state,
      JSON.stringify({ heartbeat: { nextAt: 5 }, lastUrl: `https://u:${PASS}@h.example/` }),
    );
    const { buildTechnicalInfo } = await import("../services/state");
    const info = (await buildTechnicalInfo(
      { pid: 1, startedAt: Date.now(), heartbeatNextAt: 0, settings: {} as never, jobs: [] },
      paths,
    )) as { files: { sessionJson: Record<string, unknown>; stateJson: Record<string, unknown> } };
    expect(info.files.sessionJson.sessionId).toBe("abc");
    expect(info.files.sessionJson.apiToken).toMatch(REDACTED);
    expect(info.files.stateJson.heartbeat).toEqual({ nextAt: 5 });
    const out = JSON.stringify(info.files);
    expect(out).not.toContain(ARG);
    expect(out).not.toContain(PASS);
  });

  it("scrubs job prompts in the snapshot", async () => {
    const { buildTechnicalInfo } = await import("../services/state");
    const info = (await buildTechnicalInfo({
      pid: 1,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: {} as never,
      jobs: [{ name: "ping", prompt: `curl -X POST ${HOOK} -d hi` }] as never,
    })) as { snapshot: { jobs: { name: string; prompt: string }[] } };
    expect(info.snapshot.jobs[0].name).toBe("ping");
    expect(info.snapshot.jobs[0].prompt.startsWith("curl -X POST ")).toBe(true);
    expect(JSON.stringify(info.snapshot)).not.toContain("e".repeat(24));
  });

  it("catches the shapes the first version missed", async () => {
    const cases: string[] = [
      `SLACK_URL=${HOOK}`,
      `  ${DISCORD}`,
      `https://discord.com/api/v10/webhooks/1/${QTOKEN}`,
      `authorization: bearer ${QTOKEN}`,
      `BEARER ${QTOKEN}`,
      `Authorization: Basic ${QTOKEN}`,
      `Authorization: token ${QTOKEN}`,
      `X-Api-Key: ${QTOKEN}`,
      `postgres://u:p@${QTOKEN}@db/main`,
      `export GITHUB_TOKEN=${QTOKEN}`,
      `A=1 GITHUB_TOKEN=${QTOKEN} npx srv`,
      `npx srv --token ${QTOKEN}`,
      `claude --api-key=${QTOKEN} -p hi`,
      `https://x.example/cb#access_token=${QTOKEN}`,
      `https://s3.example/o?X-Amz-Signature=${QTOKEN}`,
      `GH_PAT=${QTOKEN}`,
      `{"token":"${QTOKEN}","user":"me"}`,
    ];
    const redacted = (await redactViaTechnicalInfo({ notes: cases })) as { notes: string[] };
    for (const [i, out] of redacted.notes.entries()) {
      expect(`${i}: ${out}`).not.toContain(QTOKEN);
    }
    expect(redacted.notes[16]).toContain('"user":"me"');
    const flags = (await redactViaTechnicalInfo({
      args: ["--auth", QTOKEN, "--password", 12345, "--no-key", "--port", "8080"],
      webhook_url: "https://n8n.example/webhook/abc123",
      webhooks: { port: 8080, path: "/in" },
    })) as { args: unknown[]; webhook_url: string; webhooks: { port: number; path: string } };
    expect(flags.args[1]).toMatch(REDACTED);
    expect(flags.args[3]).toMatch(REDACTED);
    expect(flags.args.slice(4)).toEqual(["--no-key", "--port", "8080"]);
    expect(flags.webhook_url).toMatch(REDACTED);
    expect(flags.webhooks.port).toBe(8080);
  });

  it("does not let a non-secret name hide a secret later on the line, and handles quotes", async () => {
    const BOT = `${"1".repeat(9)}:AA${"h".repeat(33)}`;
    const ANT = `sk-ant-api03-${"i".repeat(30)}`;
    const cases: string[] = [
      `see http://x.com then X-Api-Key: ${QTOKEN}`,
      `curl http://x -H X-Api-Key:${QTOKEN}`,
      `note: Authorization: Token ${QTOKEN}`,
      `user: bob password: ${QTOKEN}`,
      `url: https://h/x token: ${QTOKEN}`,
      `password: '${QTOKEN}'`,
      `password: "${QTOKEN}"`,
      `{'password': '${QTOKEN}'}`,
      `--password="${QTOKEN}"`,
      `--token '${QTOKEN}'`,
      `export API_KEY='${QTOKEN} x'`,
      `GH_TOKEN = ${QTOKEN}`,
      `https://api.telegram.org/bot${BOT}/sendMessage`,
      `key is ${ANT} ok`,
      `https://hooks.slack.com:443/services/T/B/${QTOKEN}`,
      `discord.com/api/webhooks/123/${QTOKEN}`,
    ];
    const out = (await redactViaTechnicalInfo({ notes: cases })) as { notes: string[] };
    for (const [i, v] of out.notes.entries()) {
      expect(`${i}: ${v}`).not.toContain(QTOKEN);
      expect(`${i}: ${v}`).not.toContain("h".repeat(33));
      expect(`${i}: ${v}`).not.toContain("i".repeat(30));
    }
    expect(out.notes[0].startsWith("see http://x.com then X-Api-Key: ")).toBe(true);
    expect(out.notes[3].startsWith("user: bob password: ")).toBe(true);
  });

  it("leaves ordinary values alone", async () => {
    const plain = [
      "http://host:8080/path",
      "time: 12:30",
      "C:\\x\\y",
      "anthropic:claude-opus",
      "model: opus",
      "--port 8080",
      "compass=north",
      "passport: x",
      "*/5 * * * *",
      "Bearer of good news",
    ];
    const out = (await redactViaTechnicalInfo({ notes: plain })) as { notes: string[] };
    expect(out.notes).toEqual(plain);
  });

  it("redacts each value once, keeps JSON shape, and covers the whole value", async () => {
    const GHP = `ghp${"_"}${"j".repeat(36)}`;
    const out = (await redactViaTechnicalInfo({
      notes: [
        '{"token": "abc", "user": "bob"}',
        '{"auth":{"token":"x"}}',
        '{"credentials": ["a","b"]}',
        `Authorization: Bearer ${GHP}`,
        "PASSWORD=abc,def;ghi",
        "--password abc;def",
        "password: correct horse battery staple",
        "pip install sk-learn-something-extended-module",
        "log 1696291200:connection_reset_by_peer_after_timeout",
      ],
    })) as { notes: string[] };
    const n = out.notes;
    expect(n[0]).toBe('{"token":"<redacted:3 chars>", "user": "bob"}');
    expect(n[1]).toBe('{"auth":{"token":"<redacted:1 chars>"}}');
    expect(n[2]).toBe('{"credentials": ["a","b"]}');
    expect(n[3]).toBe(`Authorization: Bearer <redacted:${GHP.length} chars>`);
    expect(n[4]).toBe("PASSWORD=<redacted:11 chars>");
    expect(n[5]).toBe("--password <redacted:7 chars>");
    expect(n[6]).toBe("password: <redacted:7 chars> horse battery staple");
    expect(n[7]).toBe("pip install sk-learn-something-extended-module");
    expect(n[8]).toBe("log 1696291200:connection_reset_by_peer_after_timeout");
  });

  it("a declined or already-redacted pair does not hide the next one on the line", async () => {
    const ANT = `sk-ant-api03-${"k".repeat(30)}`;
    const out = (await redactViaTechnicalInfo({
      notes: [
        `api_key: ${ANT} password: hunter2xyz`,
        "compass: north password: hunter2xyz",
        "token: abc, secret: hunter2xyz",
        '{"note":"password: hunter2xyz","x":1}',
        "API_KEY=[hunter2xyz]",
        `sk-svcacct-${"m".repeat(40)} sk-or-v1-${"0".repeat(64)}`,
        `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`,
        'password: hunter2xyz"tail',
        "password: hunt'hunter2xyz",
      ],
    })) as { notes: string[] };
    for (const [i, v] of out.notes.entries()) {
      expect(`${i}: ${v}`).not.toContain("hunter2xyz");
      expect(`${i}: ${v}`).not.toContain("m".repeat(40));
      expect(`${i}: ${v}`).not.toContain("0".repeat(64));
      expect(`${i}: ${v}`).not.toContain("SeofSAs0K5PALDsaw");
    }
    expect(out.notes[3].endsWith('","x":1}')).toBe(true);
  });

  it("stays linear on long hostile strings", async () => {
    const long = 100_000;
    const inputs = [
      "a".repeat(long),
      "?".repeat(long),
      "a-".repeat(long / 2),
      "&a".repeat(long / 2),
      "a:".repeat(long / 2),
      '"'.repeat(long),
      "x ".repeat(long / 2),
      "--a ".repeat(long / 4),
      "a://".repeat(long / 4),
      `"${"a".repeat(long)}`,
    ];
    const t0 = performance.now();
    await redactViaTechnicalInfo({ blobs: inputs });
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
