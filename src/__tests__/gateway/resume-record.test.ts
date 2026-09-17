/**
 * #376: `recordClaudeSessionId` runs on every successful turn — it must be
 * quiet when the id is unchanged and must follow a rotation.
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
  it("two turns recording at once cannot race: same id → one record, no chatter; different ids → first wins, one warning", async () => {
    await getOrCreateSessionMapping("telegram:2", "default");
    await Promise.all([
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
      recordClaudeSessionId("telegram:2", "default", "sess-x"),
    ]);
    expect((await get("telegram:2", "default"))?.claudeSessionId).toBe("sess-x");
    expect(warnings).toHaveLength(0);
    await getOrCreateSessionMapping("telegram:3", "default");
    await Promise.all([
      recordClaudeSessionId("telegram:3", "default", "sess-p"),
      recordClaudeSessionId("telegram:3", "default", "sess-q"),
    ]);
    const kept = (await get("telegram:3", "default"))?.claudeSessionId;
    expect(["sess-p", "sess-q"]).toContain(kept);
    expect(warnings.filter((w) => w.includes("Not overwriting"))).toHaveLength(0);
    expect(warnings.filter((w) => w.includes("mapping keeps"))).toHaveLength(1);
  });

  it("records once, stays quiet on the same id, keeps the first id on a rotation and says so once", async () => {
    await getOrCreateSessionMapping("telegram:1", "default");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    expect((await get("telegram:1", "default"))?.claudeSessionId).toBe("sess-a");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    await recordClaudeSessionId("telegram:1", "default", "sess-a");
    expect(warnings).toHaveLength(0); // no "Not overwriting" chatter on the steady state
    await recordClaudeSessionId("telegram:1", "default", "sess-b"); // the runner rotated
    await recordClaudeSessionId("telegram:1", "default", "sess-b");
    expect((await get("telegram:1", "default"))?.claudeSessionId).toBe("sess-a"); // documented contract: first id wins
    const w = warnings.filter((x) => x.includes("mapping keeps sess-a"));
    expect(w).toHaveLength(1);
    expect(logs.filter((l) => l.includes("Not overwriting"))).toHaveLength(0);
  });
});
