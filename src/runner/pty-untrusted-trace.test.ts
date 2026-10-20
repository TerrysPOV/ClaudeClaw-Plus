import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPty } from "./pty-process.js";

/** #570 r11 (D): `CLAUDECLAW_PTY_DUMP` must not keep an untrusted one-shot's prompt or reply. */

const CANARY = "EXAMPLE_TRACE_CANARY";
let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-trace-"));
  saved = process.env.CLAUDECLAW_PTY_DUMP;
  process.env.CLAUDECLAW_PTY_DUMP = join(dir, "dump.txt");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDECLAW_PTY_DUMP;
  else process.env.CLAUDECLAW_PTY_DUMP = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** `cat` echoes the prompt back, so the canary is in both the write and the output chunks. */
async function dumpFor(isolation: "untrusted" | undefined): Promise<string> {
  const child = await spawnPty({
    sessionId: "",
    cwd: dir,
    ...(isolation ? { isolation } : {}),
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/cat",
    _argsOverride: [],
    _skipReadySettle: true,
    quietWindowMs: 50,
    sentinelMaxWaitMs: 1000,
  });
  try {
    await child.runTurn(`classify ${CANARY} ✻ shift+tab to cycle`, { timeoutMs: 2000 });
  } finally {
    await child.dispose();
  }
  const file = process.env.CLAUDECLAW_PTY_DUMP!;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

it("an untrusted PTY writes metadata only: neither the prompt nor the raw output reaches the dump", async () => {
  // Went red when the untrusted flag was forced off.
  const dump = await dumpFor("untrusted");
  // The trace ran (so an empty file cannot pass), and carries lengths, not text.
  expect(dump).toContain("write prompt");
  expect(dump).toContain("<< pid=");
  expect(dump).toContain("[withheld: untrusted");
  expect(dump.includes(CANARY)).toBe(false);
});

it("a trusted PTY keeps the full trace (so the test above can go red)", async () => {
  const dump = await dumpFor(undefined);
  expect(dump.includes(CANARY)).toBe(true);
});
