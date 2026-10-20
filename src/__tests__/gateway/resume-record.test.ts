/**
 * #376: `recordClaudeSessionId` runs on every successful turn — it must be
 * quiet when the id is unchanged and must follow the runner when it replaces
 * the conversation's session (the map mirrors `sessions.ts`, it decides nothing).
 *
 * The session map has no path seam; like `session-map.test.ts` this uses the
 * cwd file, but puts back whatever was there before instead of deleting it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOrCreateSessionMapping, recordClaudeSessionId } from "../../gateway/resume";
import { get, resetSessionMap } from "../../gateway/session-map";

const FILE = join(process.cwd(), ".claude", "claudeclaw", "session-map.json");
let before: string | null;
let warnings: string[];
let logs: string[];
const origWarn = console.warn;
const origLog = console.log;
beforeEach(() => {
  before = existsSync(FILE) ? readFileSync(FILE, "utf8") : null;
  resetSessionMap();
  rmSync(FILE, { force: true });
  warnings = [];
  logs = [];
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = origWarn;
  console.log = origLog;
  resetSessionMap();
  if (before === null) rmSync(FILE, { force: true });
  else {
    mkdirSync(join(process.cwd(), ".claude", "claudeclaw"), { recursive: true });
    writeFileSync(FILE, before);
  }
});

describe("recordClaudeSessionId (#376)", () => {
  it("two turns recording at once cannot race: same id → one record, no chatter; different ids → one of them, one replacement line", async () => {
    await getOrCreateSessionMapping("telegram:2", "default");
    await Promise.all([
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
    ]);
    expect((await get("telegram:2", "default"))?.claudeSessionId).toBe("sess-x");
    expect(warnings).toHaveLength(0);
    expect(logs.filter((l) => l.includes("the map follows"))).toHaveLength(0);
    await getOrCreateSessionMapping("telegram:3", "default");
    await Promise.all([
      recordClaudeSessionId("telegram:3", "default", "sess-p"),
      recordClaudeSessionId("telegram:3", "default", "sess-q"),
    ]);
    const kept = (await get("telegram:3", "default"))?.claudeSessionId;
    expect(["sess-p", "sess-q"]).toContain(kept);
    expect(warnings.filter((w) => w.includes("Not overwriting"))).toHaveLength(0);
    // serialized: the second write is a replacement of the first, said once
    expect(logs.filter((l) => l.includes("the map follows"))).toHaveLength(1);
  });

  it("records once, stays quiet on the same id, follows a rotation and says so once per replacement", async () => {
    await getOrCreateSessionMapping("telegram:1", "default");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    expect((await get("telegram:1", "default"))?.claudeSessionId).toBe("sess-a");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    expect(warnings).toHaveLength(0); // no "Not overwriting" chatter on the steady state
    expect(logs.filter((l) => l.includes("the map follows"))).toHaveLength(0);
    await recordClaudeSessionId("telegram:1", "default", "sess-b"); // the runner rotated
    await recordClaudeSessionId("telegram:1", "default", "sess-b");
    expect((await get("telegram:1", "default"))?.claudeSessionId).toBe("sess-b"); // the map mirrors the runner
    const l = logs.filter((x) => x.includes("reports session sess-b (was sess-a)"));
    expect(l).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});
