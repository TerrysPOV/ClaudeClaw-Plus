import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import { classifyThreadIntent } from "../commands/discord.js";
import type { PtyProcessOptions } from "../runner/pty-process.js";
import {
  __resetSupervisorForTests,
  injectOneShotTranscriptWaitForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import { untrustedPtyProjectDir } from "./pty-cleanup.js";
import {
  TRANSCRIPT_WAIT_FLOOR_MS,
  TRANSCRIPT_WAIT_MS,
  awaitLastAssistantReply,
  scanTranscript,
  transcriptWaitBudget,
} from "./pty-transcript.js";

/** #570: an untrusted one-shot returns the model's transcript reply, never screen text. */
const SCREEN_WITH_EXAMPLE = [
  "classify this message",
  'Return: {"action":"hire","names":["name1"]}',
  "Return ONLY valid JSON or the word null.",
].join("\n");

let dir: string;
let savedConfig: string | undefined;
let warn: ReturnType<typeof spyOn>;

type Entry = Record<string, unknown>;
const userEntry = (): Entry => ({ type: "user", message: { role: "user", content: "x" } });
const assistant = (id: string, blocks: Entry[], extra: Entry = {}): Entry => ({
  type: "assistant",
  message: { id, model: "claude-haiku", content: blocks },
  ...extra,
});
const text = (value: string): Entry => ({ type: "text", text: value });
const syntheticError = (): Entry =>
  assistant("syn", [text("API Error: 400 invalid signature")], {
    isApiErrorMessage: true,
    message: {
      id: "syn",
      model: "<synthetic>",
      content: [text("API Error: 400 invalid signature")],
    },
  });

/** A PTY double whose turn writes `entries` where the untrusted cleanup and reader look. */
function fakePty(entries: Entry[] | undefined, screen = SCREEN_WITH_EXAMPLE): void {
  injectSpawnPty(async (opts: PtyProcessOptions) => {
    return {
      label: "reply",
      pid: 1,
      sessionId: "reply-session",
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: async () => {
        if (entries) {
          const project = untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
          mkdirSync(project, { recursive: true });
          writeFileSync(
            join(project, "reply-session.jsonl"),
            `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{"type":"assis`,
          );
        }
        return { text: screen, sessionId: "reply-session", cleanBoundary: true, bytesCaptured: 9 };
      },
      dispose: async () => {},
    } as never;
  });
}

const request = {
  route: "discord.classifier",
  prompt: "classify",
  isolation: "untrusted" as const,
  timeoutMs: 2000,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-reply-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ pty: { enabled: true } }));
  _setSettingsFileForTests(file);
  await loadSettings();
  __resetSupervisorForTests();
  injectOneShotTrustForTests(async () => {});
  injectOneShotTranscriptWaitForTests(60);
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  injectOneShotTranscriptWaitForTests(null);
  injectOneShotTrustForTests(null);
  injectSpawnPty(null);
  __resetSupervisorForTests();
  _setSettingsFileForTests();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

describe("#570 one-shot PTY reply extraction", () => {
  it("(a) returns the exact transcript reply, not the screen text", async () => {
    fakePty([userEntry(), assistant("m1", [text("hello there")])]);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("hello there");
  });

  it("joins the text blocks of a reply split across entries of one message", async () => {
    fakePty([
      userEntry(),
      assistant("m1", [{ type: "thinking", thinking: "..." }]),
      assistant("m1", [text("first "), text("part ")]),
      assistant("m1", [text("second")]),
    ]);
    expect((await runOnceOnPty(request)).text).toBe("first part second");
  });

  it("(b) a real reply followed by an API-error entry is a failure, not a partial success", async () => {
    fakePty([userEntry(), assistant("m1", [text("the real reply")]), syntheticError()]);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("");
    const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).toContain("api-error");
  });

  it("(c) returns a non-zero exit and no screen text when no reply appears in time", async () => {
    fakePty([userEntry()]);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).not.toBe(0);
    expect(result.text).toBe("");
    expect(result.text.includes("Return")).toBe(false);
    // The warning names the route, never content.
    const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).toContain("no assistant reply");
    expect(logged.includes("Return ONLY")).toBe(false);
  });

  it("(c) a missing transcript is also a failure, not the screen", async () => {
    fakePty(undefined);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).not.toBe(0);
    expect(result.text).toBe("");
  });

  it("(d) the classifier returns null when the screen holds example JSON but the reply is null", async () => {
    fakePty([userEntry(), assistant("m1", [text("null")])]);
    expect(await classifyThreadIntent("good morning everyone")).toBeNull();
  });

  it("(d) a genuine thread message parses to the model's intent, not the example", async () => {
    fakePty([userEntry(), assistant("m1", [text('{"action":"hire","names":["release-notes"]}')])]);
    expect(await classifyThreadIntent("please create a thread called release-notes")).toEqual({
      action: "hire",
      names: ["release-notes"],
    });
  });

  it("(d) a failed turn classifies as null rather than reading the screen", async () => {
    fakePty([userEntry()]);
    expect(await classifyThreadIntent("good morning everyone")).toBeNull();
  });

  it("removes the transcript after extracting the reply", async () => {
    let project = "";
    injectSpawnPty(async (opts: PtyProcessOptions) => {
      project = untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "s.jsonl"), `${JSON.stringify(assistant("m1", [text("ok")]))}\n`);
      return {
        runTurn: async () => ({
          text: "screen",
          sessionId: "s",
          cleanBoundary: true,
          bytesCaptured: 1,
        }),
        dispose: async () => {},
      } as never;
    });
    expect((await runOnceOnPty(request)).text).toBe("ok");
    expect(await Bun.file(join(project, "s.jsonl")).exists()).toBe(false);
  });
});

describe("#570 failed-turn latency", () => {
  /** A project dir holding the given transcript entries, no PTY involved. */
  function project(entries: Entry[]): string {
    const projectDir = join(dir, "latency-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "s.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    return projectDir;
  }
  /** A fake clock: sleeping advances time, so latency is measured without waiting. */
  function fakeClock() {
    let time = 0;
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      elapsed: () => time,
    };
  }

  it("an API-error-only transcript fails at once, far under the bound", async () => {
    const clock = fakeClock();
    const result = await awaitLastAssistantReply(project([userEntry(), syntheticError()]), {
      waitMs: TRANSCRIPT_WAIT_MS,
      ...clock,
    });
    expect(result).toEqual({ failure: "api-error" });
    expect(clock.elapsed()).toBeLessThan(TRANSCRIPT_WAIT_MS / 10);
  });

  it("an empty transcript still waits out the bound, then reports a timeout", async () => {
    const clock = fakeClock();
    const result = await awaitLastAssistantReply(project([userEntry()]), {
      waitMs: 2000,
      ...clock,
    });
    expect(result).toEqual({ failure: "timeout" });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(2000);
  });

  it("a real reply wins over an earlier API-error entry", async () => {
    const clock = fakeClock();
    const result = await awaitLastAssistantReply(
      project([userEntry(), syntheticError(), assistant("m2", [text("recovered")])]),
      { waitMs: 2000, ...clock },
    );
    expect(result).toEqual({ text: "recovered" });
  });

  it("a real reply followed by an API-error entry fails the turn (D3)", async () => {
    const clock = fakeClock();
    const result = await awaitLastAssistantReply(
      project([userEntry(), assistant("m1", [text("real")]), syntheticError()]),
      { waitMs: 2000, ...clock },
    );
    expect(result).toEqual({ failure: "api-error" });
  });

  it("an error record that lands during the settle still fails the reply (E: the post-settle re-read)", async () => {
    // Went red when the verdict of the post-settle re-read was dropped.
    const projectDir = project([userEntry(), assistant("m1", [text("real")])]);
    const file = join(projectDir, "s.jsonl");
    const sleeps: number[] = [];
    // The reply is already on disk when the first read happens, so the only sleep is the
    // settle; the error record is appended exactly then.
    const result = await awaitLastAssistantReply(projectDir, {
      waitMs: 2000,
      settleMs: 50,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        appendFileSync(file, `\n${JSON.stringify(syntheticError())}\n`);
      },
    });
    expect(sleeps).toEqual([50]);
    expect(result).toEqual({ failure: "api-error" });
  });

  it("scanning a project dir that cannot be listed supplies no evidence and does not throw (D3)", () => {
    // A FILE where the directory should be: existsSync is true, readdirSync throws ENOTDIR.
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    expect(scanTranscript(notADir)).toEqual({ failed: false });
  });

  it("an abort while waiting reports aborted, not timeout (D1)", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    const result = await awaitLastAssistantReply(project([userEntry()]), {
      waitMs: 2000,
      signal: controller.signal,
      ...clock,
    });
    expect(result).toEqual({ failure: "aborted" });
  });

  it("the transcript wait is what the turn left of timeoutMs, capped, with a floor", () => {
    expect(transcriptWaitBudget(15_000, 2_000)).toBe(13_000);
    expect(transcriptWaitBudget(60_000, 1_000)).toBe(TRANSCRIPT_WAIT_MS);
    expect(transcriptWaitBudget(15_000, 14_500)).toBe(TRANSCRIPT_WAIT_FLOOR_MS);
    expect(transcriptWaitBudget(15_000, 20_000)).toBe(TRANSCRIPT_WAIT_FLOOR_MS);
  });

  it("runOnceOnPty: an API-error-only transcript returns exit 1 straight away", async () => {
    injectOneShotTranscriptWaitForTests(null);
    fakePty([userEntry(), syntheticError()]);
    const started = Date.now();
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("");
    expect(Date.now() - started).toBeLessThan(1500);
    const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).toContain("api-error");
  });

  it("runOnceOnPty: an exhausted budget bounds the transcript wait to the floor", async () => {
    injectOneShotTranscriptWaitForTests(null);
    fakePty([userEntry()]);
    const started = Date.now();
    const result = await runOnceOutcome();
    // The caller's whole deadline is gone by the end of the wait: a timeout (124), not a failure.
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
    // 15 s without the budget; the floor is 1 s.
    expect(Date.now() - started).toBeLessThan(2500);

    async function runOnceOutcome() {
      return runOnceOnPty({ ...request, timeoutMs: 400 });
    }
  });

  it("runOnceOnPty: no reply with deadline to spare is a failure (1), not a timeout", async () => {
    injectOneShotTranscriptWaitForTests(60);
    fakePty([userEntry()]);
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(1);
  });

  it("runOnceOnPty: an abort during the transcript wait is exit 124, not 1 (D1)", async () => {
    injectOneShotTranscriptWaitForTests(null);
    fakePty([userEntry()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000, signal: controller.signal });
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
  });
});
