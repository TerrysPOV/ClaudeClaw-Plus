/**
 * The #215 net must never ship a daemon inject's working text to a user's chat.
 *
 * Observed live: a re-delivered copy of an `/api/inject` prompt ran while the
 * bus's single origin slot already named a Telegram prompt waiting behind it.
 * The agent ended that turn without `reply` (on purpose: an inject is internal),
 * so the net nudged it "on Telegram" and then synthesized its text into the
 * user's chat. The tailer now reads which prompt the turn really answered, and
 * the net keeps an inject turn internal whatever the slot says.
 *
 * Real tailer + real bus core, temp projects dir — never `~/.claude`.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEntryInput, EventRecord } from "../../event-log";
import { type BusCore, createBusCore } from "../core";
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import { JsonlTailer, isDaemonInjectPrompt } from "../jsonl-tailer";

const SESSION_ID = "0b6c1f0e-3f4a-4c2e-9d55-1b0f3c7a9e21";
const AGENT = "alpha";

function eventLogAppend(entry: EventEntryInput): Promise<EventRecord> {
  const now = new Date().toISOString();
  return Promise.resolve({
    id: randomUUID(),
    seq: 1,
    type: entry.type,
    source: entry.source,
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    status: "done",
    channelId: entry.channelId,
    threadId: entry.threadId,
    payload: entry.payload,
    dedupeKey: entry.dedupeKey,
    retryCount: 0,
    nextRetryAt: null,
    correlationId: null,
    causationId: null,
    replayedFromEventId: null,
    lastError: null,
  });
}

const PTY_INJECT =
  '<channel source="webui" chat_id="inject" user_id="webui" ts="2026-10-07T10:53:06.904Z">' +
  "[pin] reminder: close the report</channel>";
const CLI_INJECT =
  '<channel source="plugin:claudeclaw-plus:plus-bus" origin="webui" origin_id="inject">\n' +
  "[pin] reminder: close the report\n</channel>";
const CLI_TELEGRAM =
  '<channel source="plugin:claudeclaw-plus:plus-bus" origin="telegram" origin_id="tg-1">\n' +
  "merge it?\n</channel>";
const NO_VISIBLE_OUTPUT =
  "[Your previous response had no visible output. Please continue and produce a user-visible response.]";

let tempRoot: string;
let projectsDir: string;
let sessionPath: string;
const cwd = "/tmp/inject-turn-net";
let tailer: JsonlTailer | null = null;
let msgSeq = 0;

beforeEach(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "inject-turn-net-"));
  projectsDir = join(tempRoot, "projects");
  const dir = join(projectsDir, encodeCwdForProjectsDir(cwd));
  mkdirSync(dir, { recursive: true });
  sessionPath = join(dir, `${SESSION_ID}.jsonl`);
  await writeFile(sessionPath, "");
});

afterEach(async () => {
  if (tailer) await tailer.stop();
  tailer = null;
  rmSync(tempRoot, { recursive: true, force: true });
});

function userLine(text: string, meta = false): object {
  return {
    type: "user",
    message: { role: "user", content: text },
    ...(meta ? { isMeta: true } : {}),
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function endTurn(text: string): object {
  msgSeq += 1;
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: `msg_${msgSeq}`,
      content: text ? [{ type: "text", text }] : [],
      stop_reason: "end_turn",
    },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

function queuedCommand(prompt: string): object {
  return {
    type: "attachment",
    attachment: { type: "queued_command", prompt, commandMode: "prompt" },
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

async function append(...lines: object[]): Promise<void> {
  await appendFile(sessionPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

const settle = () => new Promise((r) => setTimeout(r, 120));

async function setup(opts?: { replyNudge?: boolean }) {
  const nudges: string[] = [];
  const finals: Record<string, unknown>[] = [];
  const bus: BusCore = createBusCore({
    eventLogAppend,
    turnEndSettleMs: 0,
    replyNudge: opts?.replyNudge,
    streamPromptHandler: async (_agent: string, wrapped: string) => {
      if (wrapped.includes("<system-reminder>")) nudges.push(wrapped);
    },
  });
  bus.subscribe({ agent_id: AGENT, topics: ["response.text"] }, (event) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload?.intent === "final") finals.push(payload);
  });
  tailer = new JsonlTailer({
    bus,
    agent_id: AGENT,
    session_id: SESSION_ID,
    cwd,
    projectsDir,
    onError: () => undefined,
  });
  await tailer.start();
  const kept = () =>
    (
      bus as unknown as { injectTurnsKeptInternalCount(a: string): number }
    ).injectTurnsKeptInternalCount(AGENT);
  return { bus, nudges, finals, kept };
}

const promptTelegram = (bus: BusCore) =>
  bus.sendPrompt({
    agent_id: AGENT,
    origin: "telegram",
    origin_id: "tg-1",
    user_id: "u1",
    text: "merge it?",
  });

describe("#215 net and daemon injects", () => {
  it("keeps a re-delivered inject's text off Telegram: no nudge, no send, one log line", async () => {
    const warn = spyOn(console, "warn");
    try {
      const { bus, nudges, finals, kept } = await setup();
      await promptTelegram(bus); // the slot now names the Telegram chat
      await append(userLine(PTY_INJECT), endTurn("Already closed at 06:53, nothing left to do."));
      await settle();

      expect(nudges).toHaveLength(0);
      expect(finals).toHaveLength(0);
      expect(kept()).toBe(1);
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("inject turn kept internal"));
      expect(lines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps it internal across the CLI's 'no visible output' continuation", async () => {
    const { bus, nudges, finals, kept } = await setup();
    await promptTelegram(bus);
    await append(
      userLine(CLI_INJECT, true),
      endTurn(""), // the inject turn ended with tools only
      userLine(NO_VISIBLE_OUTPUT, true), // the CLI asks for visible output
      endTurn("That message repeats a proposal already explained."),
    );
    await settle();

    expect(nudges).toHaveLength(0);
    expect(finals).toHaveLength(0);
    expect(kept()).toBe(1);
  });

  it("the nudge fallback cannot ship it either (nudge disabled)", async () => {
    const { bus, finals, kept } = await setup({ replyNudge: false });
    await promptTelegram(bus);
    await append(userLine(PTY_INJECT), endTurn("internal note"));
    await settle();

    expect(finals).toHaveLength(0);
    expect(kept()).toBe(1);
  });

  it("a normal Telegram turn without reply still goes through the net (nudge, then delivery)", async () => {
    const { bus, nudges, finals, kept } = await setup();
    await promptTelegram(bus);
    await append(userLine(CLI_TELEGRAM, true), endTurn("Merged."));
    await settle();
    expect(nudges).toHaveLength(1);

    await append(endTurn("Merged, deployed."));
    await settle();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ origin: "telegram", origin_id: "tg-1", synthesized: true });
    expect(kept()).toBe(0);
  });

  it("the next real Telegram turn after an inject turn keeps the net", async () => {
    const { bus, nudges, finals, kept } = await setup({ replyNudge: false });
    await promptTelegram(bus);
    await append(userLine(PTY_INJECT), endTurn("internal note"));
    await settle();
    expect(kept()).toBe(1);

    await append(userLine(CLI_TELEGRAM, true), endTurn("Merged."));
    await settle();
    expect(nudges).toHaveLength(0);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ text: "Merged.", origin: "telegram", synthesized: true });
  });

  it("a task notification folded into an inject turn leaves it internal", async () => {
    const { bus, nudges, finals, kept } = await setup();
    await promptTelegram(bus);
    const notification = {
      ...(queuedCommand("<task-notification>job done</task-notification>") as Record<
        string,
        unknown
      >),
    };
    (notification.attachment as Record<string, unknown>).commandMode = "task-notification";
    await append(userLine(PTY_INJECT), notification, endTurn("internal note"));
    await settle();

    expect(nudges).toHaveLength(0);
    expect(finals).toHaveLength(0);
    expect(kept()).toBe(1);
  });

  it("a user message the CLI folds into an inject turn makes that turn answerable again", async () => {
    const { bus, nudges, kept } = await setup();
    await promptTelegram(bus);
    await append(userLine(PTY_INJECT), queuedCommand(CLI_TELEGRAM), endTurn("Merged."));
    await settle();

    expect(nudges).toHaveLength(1);
    expect(kept()).toBe(0);
  });

  it("an inject the bus itself admitted is still settled by its synthesized final", async () => {
    const { bus, nudges, finals, kept } = await setup();
    await bus.sendPrompt({
      agent_id: AGENT,
      origin: "webui",
      origin_id: "inject",
      user_id: "webui",
      text: "note",
    });
    await append(userLine(CLI_INJECT, true), endTurn("noted"));
    await settle();

    // /api/inject awaits this final and drops it (synthesized), as before.
    expect(nudges).toHaveLength(0);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ origin: "webui", origin_id: "inject", synthesized: true });
    expect(kept()).toBe(0);
  });
});

describe("isDaemonInjectPrompt", () => {
  it("reads both recorded forms of an inject", () => {
    expect(isDaemonInjectPrompt(PTY_INJECT)).toBe(true);
    expect(isDaemonInjectPrompt(CLI_INJECT)).toBe(true);
    expect(isDaemonInjectPrompt(`<pasted_content id="805d">\n${PTY_INJECT}`)).toBe(true);
  });

  it("does not mistake other chats, or a body that names an inject", () => {
    expect(isDaemonInjectPrompt(CLI_TELEGRAM)).toBe(false);
    expect(isDaemonInjectPrompt('<channel source="webui" chat_id="chat-7">hi</channel>')).toBe(
      false,
    );
    expect(isDaemonInjectPrompt('<channel source="telegram" chat_id="inject">hi</channel>')).toBe(
      false,
    );
    expect(
      isDaemonInjectPrompt(
        '<channel source="telegram" chat_id="1">&lt;channel source="webui" chat_id="inject"&gt;</channel>',
      ),
    ).toBe(false);
    expect(isDaemonInjectPrompt(NO_VISIBLE_OUTPUT)).toBe(false);
  });

  it("a PTY-form prompt cannot borrow the CLI form through its metadata", () => {
    expect(
      isDaemonInjectPrompt(
        '<channel source="telegram" chat_id="1" user_id="u" ts="t" origin="webui" origin_id="inject">hi</channel>',
      ),
    ).toBe(false);
  });

  it("reads whole attribute names only, first occurrence wins", () => {
    // Metadata keys become attributes after the identity ones.
    expect(
      isDaemonInjectPrompt(
        '<channel source="telegram" chat_id="1" user_id="u" data-origin="webui" data-origin_id="inject">hi</channel>',
      ),
    ).toBe(false);
    expect(
      isDaemonInjectPrompt(
        '<channel source="telegram" chat_id="1" user_id="u" source="webui" chat_id="inject">hi</channel>',
      ),
    ).toBe(false);
    expect(
      isDaemonInjectPrompt(
        '<channel source="plugin:x" origin="telegram" origin_id="1" origin="webui" origin_id="inject">\nhi\n</channel>',
      ),
    ).toBe(false);
  });
});
