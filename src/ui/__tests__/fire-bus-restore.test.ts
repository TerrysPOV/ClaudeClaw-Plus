/**
 * #436: `/api/jobs/fire` in bus mode. The bridge's timeout ends the WAIT, not
 * the agent's turn, so the job's frontmatter snapshot is restored when the
 * bridge reports the turn settled — not when the route answers.
 *
 * Run with: bun test src/ui/__tests__/fire-bus-restore.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { startWebUi } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";

const TOKEN = "test-web-token-abcdefghijklmnop";
const AGENTS_DIR = join(process.cwd(), "agents");
const agent = `tst-firebus-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const jobFile = join(AGENTS_DIR, agent, "jobs", "nightly.md");

function snapshot(): WebSnapshot {
  return {
    pid: 1234,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

let handle: WebServerHandle;
let base: string;
const auth = { Authorization: `Bearer ${TOKEN}` };
const settleCallbacks: Array<(() => void) | undefined> = [];

beforeAll(() => {
  handle = startWebUi({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    getSnapshot: snapshot,
    bus: {
      defaultAgentId: agent,
      activeTurnAgents: () => [],
      // The bridge gave up waiting; the turn runs on.
      sendPromptAndAwait: async (_agent, _text, opts) => {
        settleCallbacks.push(opts?.onTurnSettled);
        return { ok: false, output: "", exitCode: 1, error: "timed out" };
      },
    } as unknown as NonNullable<Parameters<typeof startWebUi>[0]["bus"]>,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
});

afterEach(async () => {
  await rm(join(AGENTS_DIR, agent), { recursive: true, force: true });
  settleCallbacks.length = 0;
});

async function csrf(): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base}/api/csrf-token`, { headers: auth });
  const data = (await res.json()) as { token: string };
  return { token: data.token, cookie: res.headers.get("set-cookie") ?? "" };
}

describe("/api/jobs/fire in bus mode (#436)", () => {
  it("restores the job's frontmatter when the bridge reports the turn settled", async () => {
    await mkdir(join(AGENTS_DIR, agent, "jobs"), { recursive: true });
    await writeFile(jobFile, "---\nschedule: 0 2 * * *\nrecurring: true\n---\ntidy up\n", "utf8");
    const { token, cookie } = await csrf();
    const res = await fetch(`${base}/api/jobs/fire`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        Cookie: cookie,
      },
      body: JSON.stringify({ agent, label: "nightly" }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe("timed out");
    expect(settleCallbacks).toHaveLength(1);
    expect(typeof settleCallbacks[0]).toBe("function");

    // The turn's tail, after the route answered: it drops `schedule:`.
    await writeFile(jobFile, "---\nrecurring: true\n---\ntidy up\n", "utf8");
    await Bun.sleep(20);
    expect(await readFile(jobFile, "utf8")).not.toContain("schedule:");

    settleCallbacks[0]?.();
    await Bun.sleep(50);
    expect(await readFile(jobFile, "utf8")).toContain("schedule: 0 2 * * *");
  });
});
