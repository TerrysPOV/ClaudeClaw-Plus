/**
 * Who may press a Telegram button on the legacy runtime (#442).
 *
 * `handleCallbackQuery` checks the allow-list once, before it looks at the
 * button, so every kind — `pending:<id>:<value>`, `btn:<id>`, `sec_*`, and a
 * stray `perm:` — follows the rule of `src/allowlist.ts`: an empty
 * `allowedUserIds` refuses everyone (#518, PR #519), in a group and in a private chat
 * alike; a listed user is accepted wherever the button is.
 *
 * Settings are read through `getSettings()`, pointed at a temp file with
 * `_setSettingsFileForTests` so the checkout's real one is never touched.
 * The Bot API is a stubbed `fetch`; the resolver is a stand-in `pending.py`
 * that records each call.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, reloadSettings } from "../config";
import { handleCallbackQuery } from "../commands/telegram";

type CallbackQuery = Parameters<typeof handleCallbackQuery>[0];

const OPERATOR = 42;
const GROUP_MEMBER = 7;
const GROUP = { id: -100500, type: "supergroup" };

const realFetch = globalThis.fetch;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let libDir: string;
let savedLibPath: string | undefined;

afterAll(() => {
  // Back to the default path; the next reader reloads from it.
  _setSettingsFileForTests();
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  savedLibPath = process.env.CLAUDECLAW_PENDING_LIB_PATH;
  libDir = mkdtempSync(join(tmpdir(), "cc-cb-auth-"));
  writeFileSync(
    join(libDir, "pending.py"),
    [
      "import os",
      "def resolve_pending_ex(action_id, decision):",
      "    with open(os.path.join(os.path.dirname(__file__), 'calls.txt'), 'a') as f:",
      "        f.write(f'{action_id} {decision}\\n')",
      "    return 'ok'",
      "",
    ].join("\n"),
  );
  process.env.CLAUDECLAW_PENDING_LIB_PATH = libDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedLibPath === undefined) delete process.env.CLAUDECLAW_PENDING_LIB_PATH;
  else process.env.CLAUDECLAW_PENDING_LIB_PATH = savedLibPath;
  rmSync(libDir, { recursive: true, force: true });
});

/** Settings in a temp file (never the checkout's real one), then reloaded. */
async function withAllowlist(allowedUserIds: number[], allowAllUsers = false): Promise<void> {
  const file = join(libDir, "settings.json");
  const body = { telegram: { token: "tg-test", allowedUserIds, allowAllUsers } };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  _setSettingsFileForTests(file);
  await reloadSettings();
}

function tap(
  from: number,
  data: string,
  chat: { id: number; type: string } = GROUP,
): CallbackQuery {
  return {
    id: `cb-${from}-${data}`,
    from: { id: from, first_name: "u" },
    data,
    message: { message_id: 1, chat, text: "Approve?" },
  } as unknown as CallbackQuery;
}

function acks(): unknown[] {
  return calls.filter((c) => c.url.endsWith("/answerCallbackQuery")).map((c) => c.body.text);
}

function resolverCalls(): string {
  const f = join(libDir, "calls.txt");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

describe("legacy Telegram callbacks — allow-list on every button kind (#442)", () => {
  it("empty list, group chat: a pending: tap is refused and the resolver never runs", async () => {
    await withAllowlist([]);
    await handleCallbackQuery(tap(GROUP_MEMBER, "pending:2623:pay"));
    expect(acks()).toEqual(["Unauthorized."]);
    expect(resolverCalls()).toBe("");
    // Refused before any side effect: the only Bot API call is the ack.
    expect(calls).toHaveLength(1);
  });

  it("empty list, private chat (sender = chat): still refused — empty means nobody", async () => {
    await withAllowlist([]);
    await handleCallbackQuery(tap(OPERATOR, "pending:2623:pay", { id: OPERATOR, type: "private" }));
    expect(acks()).toEqual(["Unauthorized."]);
    expect(resolverCalls()).toBe("");
  });

  it("empty list: perm:, btn: and sec_ taps are refused by the same rule", async () => {
    await withAllowlist([]);
    for (const data of ["perm:allow:qwert", "btn:abc123", "sec_yes_0123abcd"]) {
      await handleCallbackQuery(tap(GROUP_MEMBER, data));
    }
    expect(acks()).toEqual(["Unauthorized.", "Unauthorized.", "Unauthorized."]);
    // The secretary button would have called its local confirm endpoint.
    expect(calls.some((c) => c.url.includes(":9999/"))).toBe(false);
  });

  it("listed operator, group chat: a pending: tap reaches the resolver", async () => {
    await withAllowlist([OPERATOR]);
    await handleCallbackQuery(tap(OPERATOR, "pending:2623:pay"));
    expect(resolverCalls()).toBe("2623 pay");
    expect(acks()).toHaveLength(1);
    expect(acks()[0]).not.toBe("Unauthorized.");
  });

  it("listed operator, group chat: an unlisted member's tap is refused", async () => {
    await withAllowlist([OPERATOR]);
    await handleCallbackQuery(tap(GROUP_MEMBER, "pending:2623:pay"));
    expect(acks()).toEqual(["Unauthorized."]);
    expect(resolverCalls()).toBe("");
  });

  it("allowAllUsers: true, group chat: any member's pending: tap is accepted (documented)", async () => {
    await withAllowlist([], true);
    await handleCallbackQuery(tap(GROUP_MEMBER, "pending:2623:pay"));
    expect(resolverCalls()).toBe("2623 pay");
    expect(acks()[0]).not.toBe("Unauthorized.");
  });
});
