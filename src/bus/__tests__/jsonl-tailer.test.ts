/**
 * Tests for `src/bus/jsonl-tailer.ts` (JSONL Tailer, Sprint 2 Agent A).
 *
 * Run with: `bun test src/bus/__tests__/jsonl-tailer.test.ts`
 *
 * Strategy:
 *   - Use a temp dir as `projectsDir` — never touch real `~/.claude/projects`.
 *   - Stub `BusCore` with an in-memory recorder. We assert on the sequence
 *     and shape of `ingestSessionEvent` calls.
 *   - Real `fs.watch` + real I/O — catches buffering, partial-line, and
 *     offset-tracking bugs that a mock would miss.
 *   - Synthesise JSONL lines for attachment subtypes the existing fixtures
 *     don't cover (edited_text_file, command_permissions, etc.). The
 *     envelope shape is documented in Spike 0.2.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusCore, SendPromptRequest } from "../core";
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import { JsonlTailer, SCHEMA_VERSION } from "../jsonl-tailer";
import type { PromptIngestion } from "../jsonl-line-types";
import type { BusEvent, BusEventTopic } from "../types";

/* ───────────────────────────────────────────────────────────────────── */
/* Fixtures                                                              */
/* ───────────────────────────────────────────────────────────────────── */

const SESSION_ID = "5e1ce8c2-5fdb-4682-a40c-6e93d470d518";
const AGENT_ID = "test-agent";

/** Bus core mock — records every ingestSessionEvent call. */
function createMockBus() {
  const events: BusEvent[] = [];
  const bus: BusCore = {
    sendPrompt: async (_req: SendPromptRequest) => ({ promise_id: "p" }),
    subscribe: () => ({ id: "", close: () => undefined, overflowCount: 0, depth: 0 }),
    invokeSlashCommand: async () => undefined,
    ingestReply: () => undefined,
    ingestSessionEvent: (e: BusEvent) => {
      events.push(e);
    },
    ingestPermissionDecision: () => undefined,
    state: () => ({ subscriberCount: 0, connectedAgents: [], totalOverflows: 0 }),
    start: async () => undefined,
    stop: async () => undefined,
  };
  return { bus, events };
}

/** Build a JSONL line + append to file with a trailing newline. */
function jsonl(...lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Per-test temp scaffold                                                */
/* ───────────────────────────────────────────────────────────────────── */

let tempRoot: string;
let projectsDir: string;
let cwd: string;
let sessionPath: string;
let tailer: JsonlTailer | null = null;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "jsonl-tailer-test-"));
  projectsDir = join(tempRoot, "projects");
  cwd = "/private/tmp/spike-2";
  const encoded = encodeCwdForProjectsDir(cwd);
  mkdirSync(join(projectsDir, encoded), { recursive: true });
  sessionPath = join(projectsDir, encoded, `${SESSION_ID}.jsonl`);
});

afterEach(async () => {
  if (tailer) {
    await tailer.stop();
    tailer = null;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Convenience: spin up a tailer pointed at the temp dir. */
function makeTailer(bus: BusCore): JsonlTailer {
  return new JsonlTailer({
    bus,
    agent_id: AGENT_ID,
    session_id: SESSION_ID,
    cwd,
    projectsDir,
    onError: (_err) => undefined, // swallow in tests; assert via events
  });
}

/** Wait for a predicate over recorded events with a soft deadline. */
async function waitFor(
  events: BusEvent[],
  pred: (evts: BusEvent[]) => boolean,
  timeoutMs = 750,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(events)) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms. Got ${events.length} events: ${events
      .map((e) => e.topic)
      .join(", ")}`,
  );
}

/* ───────────────────────────────────────────────────────────────────── */
/* Replay path                                                           */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — replay", () => {
  it("emits replay_done marker after reading from byte 0", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-17T14:00:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    // Init + prompt + replay_done.
    const topics = events.map((e) => e.topic);
    expect(topics).toContain("session.init");
    expect(topics).toContain("prompt");
    expect(topics).toContain("bus.events.replay_done");
    // Replay marker must come AFTER the replayed events.
    const replayIdx = topics.indexOf("bus.events.replay_done");
    expect(replayIdx).toBeGreaterThan(topics.indexOf("prompt"));
  });

  it("replay_done carries schema_version + offset", async () => {
    writeFileSync(sessionPath, "");
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const marker = events.find((e) => e.topic === "bus.events.replay_done");
    expect(marker).toBeDefined();
    expect((marker?.payload as { schema_version: string }).schema_version).toBe(SCHEMA_VERSION);
    expect((marker?.payload as { offset: number }).offset).toBe(0);
  });

  it("does not crash when JSONL file does not yet exist on start", async () => {
    // No writeFileSync → file is absent. Tailer should still emit
    // replay_done and arm a live tail for when the file appears.
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.map((e) => e.topic)).toContain("bus.events.replay_done");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* user line dispatch                                                    */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — user lines", () => {
  it("emits `prompt` for user lines with string content", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "user",
        message: { role: "user", content: "Hello Claude" },
        timestamp: "2026-05-17T14:00:00.000Z",
        sessionId: SESSION_ID,
        permissionMode: "default",
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const prompt = events.find((e) => e.topic === "prompt");
    expect(prompt).toBeDefined();
    expect((prompt?.payload as { text: string }).text).toBe("Hello Claude");
    expect((prompt?.payload as { permissionMode: string }).permissionMode).toBe("default");
  });

  it("walks user.message.content[] and emits one tool_result per block", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_A", content: "ok-A", is_error: false },
            { type: "tool_result", tool_use_id: "toolu_B", content: "ok-B" },
          ],
        },
        timestamp: "2026-05-17T14:01:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const results = events.filter((e) => e.topic === "tool_result");
    expect(results.length).toBe(2);
    expect((results[0]?.payload as { tool_use_id: string }).tool_use_id).toBe("toolu_A");
    expect((results[0]?.payload as { content: string }).content).toBe("ok-A");
    expect((results[0]?.payload as { is_error: boolean }).is_error).toBe(false);
    expect((results[1]?.payload as { tool_use_id: string }).tool_use_id).toBe("toolu_B");
  });

  it("handles tool_result.content as array (image result) without crashing", async () => {
    // Spike 0.2 finding 6: array content when result includes images.
    writeFileSync(
      sessionPath,
      jsonl({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_IMG",
              content: [
                { type: "image", source: { type: "base64", data: "AAAA" } },
                { type: "text", text: "see attached" },
              ],
              is_error: false,
            },
          ],
        },
        timestamp: "2026-05-17T14:02:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const result = events.find((e) => e.topic === "tool_result");
    expect(result).toBeDefined();
    const payload = result?.payload as {
      content: string | null;
      contentRaw: unknown;
      contentIsString: boolean;
    };
    expect(payload.contentIsString).toBe(false);
    expect(payload.content).toBeNull();
    expect(Array.isArray(payload.contentRaw)).toBe(true);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* assistant line dispatch                                               */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — assistant lines", () => {
  it("walks assistant.message.content[] for text/tool_use/thinking", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_A",
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "Here is the answer." },
            { type: "tool_use", id: "toolu_X", name: "Read", input: { path: "/tmp/x" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1024 },
        },
        timestamp: "2026-05-17T14:03:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const text = events.find((e) => e.topic === "response.text");
    const thinking = events.find((e) => e.topic === "response.thinking");
    const tool = events.find((e) => e.topic === "response.tool_use");
    const usage = events.find((e) => e.topic === "usage");

    expect((text?.payload as { text: string }).text).toBe("Here is the answer.");
    expect((thinking?.payload as { thinking: string }).thinking).toBe("let me think");
    expect((tool?.payload as { name: string }).name).toBe("Read");
    expect((tool?.payload as { id: string }).id).toBe("toolu_X");
    expect((usage?.payload as { input_tokens: number }).input_tokens).toBe(100);
  });

  it("emits response.turn_end with concatenated text blocks when stop_reason is end_turn (issue #215)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_TE",
          content: [
            { type: "text", text: "First line." },
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "Second line." },
          ],
          stop_reason: "end_turn",
        },
        timestamp: "2026-06-02T10:00:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd).toBeDefined();
    const payload = turnEnd!.payload as { stop_reason: string; text: string };
    expect(payload.stop_reason).toBe("end_turn");
    // Text blocks concatenated with newline, thinking excluded, trimmed.
    expect(payload.text).toBe("First line.\nSecond line.");
  });

  it("does NOT emit response.turn_end when stop_reason is tool_use (turn continues)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_TU",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "tool_use", id: "toolu_Y", name: "Read", input: { path: "/tmp/y" } },
          ],
          stop_reason: "tool_use",
        },
        timestamp: "2026-06-02T10:00:01.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd).toBeUndefined();
  });

  it("emits response.turn_end carrying the real stop_reason when the turn stops on max_tokens (#401)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_MT",
          content: [{ type: "text", text: "A long answer that got cut" }],
          stop_reason: "max_tokens",
        },
        timestamp: "2026-06-02T10:00:02.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd).toBeDefined();
    const payload = turnEnd?.payload as { stop_reason: string; text: string };
    expect(payload.stop_reason).toBe("max_tokens");
    expect(payload.text).toBe("A long answer that got cut");
  });

  it("emits response.turn_end when the turn stops on stop_sequence (#401)", async () => {
    // Observed live: the CLI's synthetic error line ("Prompt is too long …")
    // stops with `stop_sequence` and the next transcript line is the next
    // prompt — the turn is over, and nothing else will terminate it.
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_SS",
          content: [{ type: "text", text: "Prompt is too long" }],
          stop_reason: "stop_sequence",
        },
        timestamp: "2026-06-02T10:00:03.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd).toBeDefined();
    expect((turnEnd?.payload as { stop_reason: string }).stop_reason).toBe("stop_sequence");
  });

  it("emits an empty-text response.turn_end for a synthetic API-error line, so the turn releases without a nudge (#401)", async () => {
    // Live shape: the CLI writes `model: "<synthetic>"` + `isApiErrorMessage`
    // for "Prompt is too long …" / "You've hit your session limit …", stopping
    // with `stop_sequence`; the next transcript line is `last-prompt`.
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_ERR",
          model: "<synthetic>",
          content: [{ type: "text", text: "Prompt is too long · the request is ~3664273 tokens" }],
          stop_reason: "stop_sequence",
        },
        isApiErrorMessage: true,
        error: "invalid_request",
        apiErrorStatus: "400",
        timestamp: "2026-06-02T10:00:06.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const turnEnd = events.find((e) => e.topic === "response.turn_end");
    expect(turnEnd).toBeDefined();
    const payload = turnEnd?.payload as { stop_reason: string; text: string; synthetic?: boolean };
    expect(payload.stop_reason).toBe("stop_sequence");
    expect(payload.text).toBe(""); // never handed to the #215 synthesizer
    expect(payload.synthetic).toBe(true);
    // The error itself still reaches subscribers through its own topic — and
    // BEFORE the boundary, so it is still stamped with the turn's promise_id
    // when bus core releases the operation slot on turn_end.
    const apiErrorAt = events.findIndex((e) => e.topic === "system.api_error");
    const turnEndAt = events.findIndex((e) => e.topic === "response.turn_end");
    expect(apiErrorAt).toBeGreaterThanOrEqual(0);
    expect(apiErrorAt).toBeLessThan(turnEndAt);
  });

  it("does NOT emit response.turn_end for the synthetic 'No response requested.' placeholder (#401)", async () => {
    // Live shape: an SDK-enqueued prompt produces a meta user line, then this
    // placeholder, then the REAL user prompt ~90 ms later. It precedes the
    // turn, so it must not terminate anything.
    writeFileSync(
      sessionPath,
      jsonl(
        {
          type: "user",
          isMeta: true,
          message: {
            role: "user",
            content: [{ type: "text", text: "Continue from where you left off." }],
          },
          timestamp: "2026-06-02T10:00:07.000Z",
          sessionId: SESSION_ID,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            id: "msg_NRR",
            model: "<synthetic>",
            content: [{ type: "text", text: "No response requested." }],
            stop_reason: "stop_sequence",
          },
          isApiErrorMessage: false,
          timestamp: "2026-06-02T10:00:07.050Z",
          sessionId: SESSION_ID,
        },
      ),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.find((e) => e.topic === "response.turn_end")).toBeUndefined();
  });

  it("tags each boundary line of a multi-line message with its message_id (#405)", async () => {
    // Live shape on current CLIs: thinking line and text line, same message id,
    // the terminal stop_reason repeated on both.
    writeFileSync(
      sessionPath,
      jsonl(
        {
          type: "assistant",
          message: {
            role: "assistant",
            id: "msg_MULTI",
            content: [{ type: "thinking", thinking: "…" }],
            stop_reason: "end_turn",
          },
          timestamp: "2026-06-02T10:00:08.000Z",
          sessionId: SESSION_ID,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            id: "msg_MULTI",
            content: [{ type: "text", text: "the answer" }],
            stop_reason: "end_turn",
          },
          timestamp: "2026-06-02T10:00:08.100Z",
          sessionId: SESSION_ID,
        },
      ),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const ends = events.filter((e) => e.topic === "response.turn_end");
    expect(ends).toHaveLength(2);
    const ids = ends.map((e) => (e.payload as { message_id?: string }).message_id);
    expect(ids).toEqual(["msg_MULTI", "msg_MULTI"]);
    // The text line still carries the text the #215 net needs.
    expect((ends[1].payload as { text: string }).text).toBe("the answer");
  });

  it("does NOT emit response.turn_end when stop_reason is pause_turn (server-tool turn resumes, #401)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_PT",
          content: [{ type: "text", text: "searching…" }],
          stop_reason: "pause_turn",
        },
        timestamp: "2026-06-02T10:00:05.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.find((e) => e.topic === "response.turn_end")).toBeUndefined();
  });

  it("does NOT emit response.turn_end for a content-block line whose stop_reason is null (still streaming, #401)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_NULL",
          content: [{ type: "text", text: "partial" }],
          stop_reason: null,
        },
        timestamp: "2026-06-02T10:00:04.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.find((e) => e.topic === "response.turn_end")).toBeUndefined();
    // The text block itself is still surfaced.
    expect(events.find((e) => e.topic === "response.text")).toBeDefined();
  });

  it("carries the tailer generation on replay_done and session.compact when given one (#402)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 10, postTokens: 5, durationMs: 1 },
        timestamp: "2026-06-02T10:00:09.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = new JsonlTailer({
      bus,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      cwd,
      projectsDir,
      generation: 7,
      onError: () => {},
    });
    await tailer.start();

    const replay = events.find((e) => e.topic === "bus.events.replay_done");
    expect((replay?.payload as { generation?: number }).generation).toBe(7);
    const compact = events.find((e) => e.topic === "session.compact");
    expect((compact?.payload as { generation?: number }).generation).toBe(7);
  });

  it("omits the generation when none was given (older wiring stays unchanged)", async () => {
    writeFileSync(sessionPath, "");
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();
    const replay = events.find((e) => e.topic === "bus.events.replay_done");
    expect(replay).toBeDefined();
    expect("generation" in (replay?.payload as object)).toBe(false);
  });

  it("surfaces api_error fields as system.api_error", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "(partial)" }],
        },
        error: "rate_limited",
        isApiErrorMessage: true,
        apiErrorStatus: "429",
        timestamp: "2026-05-17T14:04:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const err = events.find((e) => e.topic === "system.api_error");
    expect(err).toBeDefined();
    expect((err?.payload as { status: string }).status).toBe("429");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* system + compact_boundary                                             */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — system lines", () => {
  it("compact_boundary emits BOTH system.compact_boundary AND session.compact", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: {
          trigger: "auto",
          preTokens: 587729,
          postTokens: 13223,
          durationMs: 113423,
        },
        timestamp: "2026-05-17T14:05:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const sys = events.find((e) => e.topic === "system.compact_boundary");
    const compact = events.find((e) => e.topic === "session.compact");
    expect(sys).toBeDefined();
    expect(compact).toBeDefined();
    expect((compact?.payload as { trigger: string }).trigger).toBe("auto");
    expect((compact?.payload as { preTokens: number }).preTokens).toBe(587729);
  });

  it("non-compact system subtypes only emit system.<subtype>", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "system",
        subtype: "turn_duration",
        durationMs: 1234,
        timestamp: "2026-05-17T14:05:30.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const td = events.find((e) => e.topic === "system.turn_duration");
    const compact = events.find((e) => e.topic === "session.compact");
    expect(td).toBeDefined();
    expect(compact).toBeUndefined();
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* attachment subtypes                                                   */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — attachment dispatch", () => {
  it("emits attachment.<subtype> for each of the 6 Bus-critical subtypes", async () => {
    const subtypes = [
      "hook_success",
      "hook_cancelled",
      "hook_blocking_error",
      "edited_text_file",
      "command_permissions",
      "plan_mode",
      "task_reminder",
    ];
    writeFileSync(
      sessionPath,
      `${subtypes
        .map((s) =>
          JSON.stringify({
            type: "attachment",
            attachment: { type: s, payload: `for-${s}` },
            timestamp: "2026-05-17T14:06:00.000Z",
            sessionId: SESSION_ID,
            uuid: `u-${s}`,
          }),
        )
        .join("\n")}\n`,
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    for (const s of subtypes) {
      const evt = events.find((e) => e.topic === `attachment.${s}`);
      expect(evt).toBeDefined();
      // Critical-subtype meta flag — used by Web UI shortlist.
      const meta = (evt?.payload as { _meta?: { bus_critical?: boolean } })._meta;
      expect(meta?.bus_critical).toBe(true);
    }
  });

  it("emits attachment.<subtype> for unknown subtypes (forward-compat)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "attachment",
        attachment: { type: "totally_new_subtype_v2", thing: 42 },
        timestamp: "2026-05-17T14:07:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const evt = events.find((e) => e.topic === "attachment.totally_new_subtype_v2");
    expect(evt).toBeDefined();
    expect((evt?.payload as { _meta?: { bus_critical?: boolean } })._meta?.bus_critical).toBe(
      false,
    );
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* rare line types                                                       */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — rare line types", () => {
  it("maps permission-mode → session.permission_mode_change", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "permission-mode",
        permissionMode: "bypassPermissions",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const evt = events.find((e) => e.topic === "session.permission_mode_change");
    expect(evt).toBeDefined();
    expect((evt?.payload as { permissionMode: string }).permissionMode).toBe("bypassPermissions");
  });

  it("maps ai-title, pr-link, last-prompt, queue-operation to session.* topics", async () => {
    writeFileSync(
      sessionPath,
      jsonl(
        { type: "ai-title", aiTitle: "Test Title", sessionId: SESSION_ID },
        {
          type: "pr-link",
          prNumber: 131,
          prUrl: "https://github.com/x/y/pull/131",
          prRepository: "x/y",
          sessionId: SESSION_ID,
        },
        { type: "last-prompt", lastPrompt: "what next?", sessionId: SESSION_ID },
        {
          type: "queue-operation",
          operation: "enqueue",
          sessionId: SESSION_ID,
          timestamp: "2026-05-17T14:08:00.000Z",
        },
      ),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const topics = new Set(events.map((e) => e.topic));
    expect(topics.has("session.title")).toBe(true);
    expect(topics.has("session.pr_link")).toBe(true);
    expect(topics.has("session.last_prompt")).toBe(true);
    expect(topics.has("session.queue")).toBe(true);
  });

  it("file-history-snapshot → session.file_snapshot", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "file-history-snapshot",
        messageId: "msg-1",
        snapshot: { files: [] },
        isSnapshotUpdate: false,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.find((e) => e.topic === "session.file_snapshot")).toBeDefined();
  });

  it("unknown top-level type → bus.event.unknown (no throw)", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "some_brand_new_type",
        whatever: true,
        timestamp: "2026-05-17T14:09:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const unknown = events.find((e) => e.topic === "bus.event.unknown");
    expect(unknown).toBeDefined();
    expect((unknown?.payload as { type: string }).type).toBe("some_brand_new_type");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* session.init                                                          */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — session.init", () => {
  it("emits session.init exactly once on the first parsed line", async () => {
    writeFileSync(
      sessionPath,
      jsonl(
        { type: "queue-operation", operation: "enqueue", sessionId: SESSION_ID },
        { type: "user", message: { role: "user", content: "hi" }, sessionId: SESSION_ID },
        { type: "user", message: { role: "user", content: "bye" }, sessionId: SESSION_ID },
      ),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const inits = events.filter((e) => e.topic === "session.init");
    expect(inits.length).toBe(1);
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* live tail                                                             */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — live tail", () => {
  it("picks up new bytes appended after start()", async () => {
    await writeFile(
      sessionPath,
      jsonl({
        type: "user",
        message: { role: "user", content: "first" },
        timestamp: "2026-05-17T14:10:00.000Z",
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    expect(events.find((e) => e.topic === "prompt")).toBeDefined();
    const before = events.length;

    // Append a second line — fs.watch should fire.
    await appendFile(
      sessionPath,
      jsonl({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "live!" }] },
        timestamp: "2026-05-17T14:10:30.000Z",
        sessionId: SESSION_ID,
      }),
    );

    await waitFor(events, (e) => e.some((x) => x.topic === "response.text"));
    expect(events.length).toBeGreaterThan(before);
    const live = events.find((e) => e.topic === "response.text");
    expect((live?.payload as { text: string }).text).toBe("live!");
  });

  it("handles partial-line writes — only flushes complete lines", async () => {
    const { bus, events } = createMockBus();
    await writeFile(sessionPath, "");
    tailer = makeTailer(bus);
    await tailer.start();

    // Write half a line (no trailing newline).
    const partial = JSON.stringify({
      type: "user",
      message: { role: "user", content: "partial" },
      sessionId: SESSION_ID,
    });
    await appendFile(sessionPath, partial);
    // Give fs.watch a tick — nothing should be emitted yet.
    await new Promise((r) => setTimeout(r, 80));
    const beforeCount = events.filter((e) => e.topic === "prompt").length;
    expect(beforeCount).toBe(0);

    // Complete the line.
    await appendFile(sessionPath, "\n");
    await waitFor(events, (e) => e.some((x) => x.topic === "prompt"));
    const after = events.find((e) => e.topic === "prompt");
    expect((after?.payload as { text: string }).text).toBe("partial");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* lifecycle + cleanup                                                   */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — start/stop hygiene", () => {
  it("stop() closes watchers and is idempotent", async () => {
    writeFileSync(sessionPath, "");
    const { bus } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();
    await tailer.stop();
    await tailer.stop(); // no throw
  });

  it("start() is idempotent — does not double-replay", async () => {
    writeFileSync(
      sessionPath,
      jsonl({
        type: "user",
        message: { role: "user", content: "once" },
        sessionId: SESSION_ID,
      }),
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();
    await tailer.start();
    const prompts = events.filter((e) => e.topic === "prompt");
    expect(prompts.length).toBe(1);
  });

  it("malformed JSON line does not throw and does not stop subsequent lines", async () => {
    writeFileSync(
      sessionPath,
      `${"{not-valid-json"}\n${JSON.stringify({
        type: "user",
        message: { role: "user", content: "ok" },
        sessionId: SESSION_ID,
      })}\n`,
    );
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();
    expect(events.find((e) => e.topic === "prompt")).toBeDefined();
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Path encoding                                                         */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — path encoding", () => {
  it("computes path = <projectsDir>/<encoded-cwd>/<session_id>.jsonl", () => {
    const { bus } = createMockBus();
    const t = new JsonlTailer({
      bus,
      agent_id: "x",
      session_id: "abc-123",
      cwd: "/Users/foo/bar",
      projectsDir: "/tmp/projects-root",
    });
    expect(t.path).toBe("/tmp/projects-root/-Users-foo-bar/abc-123.jsonl");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Real-fixture smoke test                                               */
/* ───────────────────────────────────────────────────────────────────── */

describe("JsonlTailer — real fixtures", () => {
  it("processes fixture 02 (tool-call) end-to-end without throwing", async () => {
    const fs = await import("node:fs/promises");
    const fixture = await fs.readFile(
      join(process.cwd(), "docs/spikes/fixtures/jsonl/02-tool-call-read-edit.jsonl"),
      "utf8",
    );
    writeFileSync(sessionPath, fixture);
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    // Should have a healthy mix of topics: prompt, assistant response,
    // tool_use, tool_result, usage, attachment.<...>.
    const topics = new Set<BusEventTopic>(events.map((e) => e.topic));
    expect(topics.has("session.init")).toBe(true);
    expect(topics.has("prompt")).toBe(true);
    expect(topics.has("response.tool_use")).toBe(true);
    expect(topics.has("tool_result")).toBe(true);
    expect(topics.has("usage")).toBe(true);
    expect(topics.has("bus.events.replay_done")).toBe(true);
  });

  it("processes fixture 03 (interactive lifecycle) — compact_boundary fan-out", async () => {
    const fs = await import("node:fs/promises");
    const fixture = await fs.readFile(
      join(process.cwd(), "docs/spikes/fixtures/jsonl/03-interactive-lifecycle.jsonl"),
      "utf8",
    );
    writeFileSync(sessionPath, fixture);
    const { bus, events } = createMockBus();
    tailer = makeTailer(bus);
    await tailer.start();

    const topics = new Set<BusEventTopic>(events.map((e) => e.topic));
    expect(topics.has("session.compact")).toBe(true);
    expect(topics.has("system.compact_boundary")).toBe(true);
    expect(topics.has("session.permission_mode_change")).toBe(true);
    expect(topics.has("session.title")).toBe(true);
    expect(topics.has("session.agent_name")).toBe(true);
    expect(topics.has("session.file_snapshot")).toBe(true);
    expect(topics.has("session.pr_link")).toBe(true);
  });
});

describe("JsonlTailer — prompt absorbed mid-turn (issue #389)", () => {
  /**
   * Fixture 04 is the real record (CLI 2.1.270) of a prompt the CLI folded
   * into the running turn instead of starting its own: `enqueue` → `remove`
   * with `reason: "absorbed_mid_turn"` → a `queued_command` attachment carrying
   * the same text, and NO `user` line ever. The core cancels that prompt's
   * flush-verify on either of the last two; this pins that both reach it with
   * the text intact, and that the tailer's own delivery-confirm channel (#363)
   * still counts the enqueue only.
   */
  it("forwards the remove (with reason and content) and the attachment (with prompt) to the bus", async () => {
    const fs = await import("node:fs/promises");
    const fixture = await fs.readFile(
      join(process.cwd(), "docs/spikes/fixtures/jsonl/04-absorbed-mid-turn.jsonl"),
      "utf8",
    );
    writeFileSync(sessionPath, fixture);
    const { bus, events } = createMockBus();
    const ingested: PromptIngestion[] = [];
    tailer = new JsonlTailer({
      bus,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      cwd,
      projectsDir,
      onError: () => undefined,
      onPromptIngested: (i) => ingested.push(i),
    });
    await tailer.start();

    const text = (JSON.parse(fixture.split("\n")[0] ?? "{}") as { content: string }).content;
    expect(text).toContain('message_id="18786"');

    const queue = events
      .filter((e) => e.topic === "session.queue")
      .map((e) => e.payload as { operation?: string; reason?: string; content?: string });
    expect(queue.map((q) => q.operation)).toEqual(["enqueue", "remove"]);
    expect(queue[1]).toMatchObject({ reason: "absorbed_mid_turn", content: text });

    const attachment = events.find((e) => e.topic === "attachment.queued_command");
    expect(attachment).toBeDefined();
    expect((attachment?.payload as { prompt?: string }).prompt).toBe(text);

    expect(events.some((e) => e.topic === "prompt")).toBe(false);
    expect(ingested.map((i) => i.source)).toEqual(["enqueue"]);
  });
});

describe("startAt: 'end' (issue #215 runtime wiring)", () => {
  function endTurn(text: string, ts = "2026-06-02T10:00:00.000Z"): object {
    return {
      type: "assistant",
      message: {
        role: "assistant",
        id: "msg_ST",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
      },
      timestamp: ts,
      sessionId: SESSION_ID,
    };
  }

  it("does NOT replay historical turn_end, but live-tails new ones", async () => {
    // History present before start() — must be skipped (would otherwise
    // re-synthesize a stale reply when wired into the runtime).
    writeFileSync(sessionPath, jsonl(endTurn("old historical turn")));
    const { bus, events } = createMockBus();
    tailer = new JsonlTailer({
      bus,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      cwd,
      projectsDir,
      startAt: "end",
      onError: () => undefined,
    });
    await tailer.start();
    expect(events.some((e) => e.topic === "response.turn_end")).toBe(false);

    // A turn appended AFTER start is delivered.
    await appendFile(sessionPath, jsonl(endTurn("fresh live turn", "2026-06-02T10:01:00.000Z")));
    await waitFor(events, (e) => e.some((x) => x.topic === "response.turn_end"));
    const te = events.find((e) => e.topic === "response.turn_end");
    expect((te?.payload as { text: string }).text).toBe("fresh live turn");
  });

  it("attaches to a session file that appears AFTER start (fresh session)", async () => {
    // File does not exist at start() — the common runtime case (claude
    // writes the JSONL lazily on the first turn). The pre-fix tailer just
    // logged the ENOENT and never tailed.
    const { bus, events } = createMockBus();
    tailer = new JsonlTailer({
      bus,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      cwd,
      projectsDir,
      startAt: "end",
      onError: () => undefined,
    });
    await tailer.start();
    await writeFile(sessionPath, jsonl(endTurn("first turn of a brand new session")));
    await waitFor(events, (e) => e.some((x) => x.topic === "response.turn_end"));
    const te = events.find((e) => e.topic === "response.turn_end");
    expect((te?.payload as { text: string }).text).toBe("first turn of a brand new session");
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Prompt-ingestion callbacks (issue #363)                               */
/*                                                                       */
/* Added after the adversarial pass found this half of the change        */
/* covered by nothing: deleting the `operation === "enqueue"` filter AND  */
/* the sidechain/isMeta exclusion left the whole suite green. The tests   */
/* that existed called `notePromptIngested` directly, bypassing the code  */
/* that decides which transcript records qualify in the first place.      */
/* ───────────────────────────────────────────────────────────────────── */

describe("prompt ingestion callbacks", () => {
  /** A tailer wired to capture what it reports, rather than only bus events. */
  function makeIngestTailer(bus: BusCore) {
    const ingested: PromptIngestion[] = [];
    let aliveCalls = 0;
    const t = new JsonlTailer({
      bus,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      cwd,
      projectsDir,
      onError: () => undefined,
      onPromptIngested: (i) => ingested.push(i),
      onTranscriptAlive: () => {
        aliveCalls += 1;
      },
    });
    return { t, ingested, alive: () => aliveCalls };
  }

  it("reports an enqueue record as an ingestion", async () => {
    const { bus, events } = createMockBus();
    const h = makeIngestTailer(bus);
    tailer = h.t;
    await writeFile(
      sessionPath,
      jsonl({
        type: "queue-operation",
        operation: "enqueue",
        content: "run the nightly sync",
        timestamp: "2026-09-07T15:00:00.000Z",
      }),
    );
    await h.t.start();
    await waitFor(events, (e) => e.some((x) => x.topic === "session.queue"));

    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.source).toBe("enqueue");
    expect(h.ingested[0]?.text).toBe("run the nightly sync");
    expect(h.ingested[0]?.ingestedAtMs).toBe(Date.parse("2026-09-07T15:00:00.000Z"));
  });

  /**
   * A `dequeue` is the queue handing the prompt to the RUNNER, not handing it
   * back. `docs/spikes/fixtures/jsonl/01-headless-text-only.jsonl` shows it
   * 1 ms after the enqueue and 13 ms before the `user` line of a normal
   * delivery, and it carries no `content`. Two rounds of review read it as a
   * cancellation; a test asserted that reading, against a record shape the CLI
   * does not write.
   */
  it("does not report a dequeue as an ingestion", async () => {
    const { bus, events } = createMockBus();
    const h = makeIngestTailer(bus);
    tailer = h.t;
    await writeFile(
      sessionPath,
      jsonl(
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "the prompt",
          timestamp: "2026-09-07T15:00:00.000Z",
        },
        // The fixture's own shape: 1 ms later, no `content`.
        {
          type: "queue-operation",
          operation: "dequeue",
          timestamp: "2026-09-07T15:00:00.001Z",
        },
        // And the shape that would actually reach the consumer if a future CLI
        // started writing `content` on this line. Without the operation filter
        // this one IS forwarded, and the delivery it names gets un-confirmed —
        // so this is the assertion that holds the guard in place, not the one
        // above (which the missing `content` would drop anyway).
        {
          type: "queue-operation",
          operation: "dequeue",
          content: "the prompt",
          timestamp: "2026-09-07T15:00:00.002Z",
        },
      ),
    );
    await h.t.start();
    await waitFor(events, (e) => e.filter((x) => x.topic === "session.queue").length >= 3);

    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.source).toBe("enqueue");
  });

  it("ignores a queue operation that is not an acceptance", async () => {
    const { bus, events } = createMockBus();
    const h = makeIngestTailer(bus);
    tailer = h.t;
    await writeFile(
      sessionPath,
      jsonl({
        type: "queue-operation",
        operation: "reorder",
        content: "still queued",
        timestamp: "2026-09-07T15:00:00.000Z",
      }),
    );
    await h.t.start();
    await waitFor(events, (e) => e.some((x) => x.topic === "session.queue"));

    expect(h.ingested).toHaveLength(0);
  });

  it("does not report a sub-agent prompt as this process's delivery", async () => {
    const { bus, events } = createMockBus();
    const h = makeIngestTailer(bus);
    tailer = h.t;
    await writeFile(
      sessionPath,
      jsonl(
        {
          type: "user",
          isSidechain: true,
          message: { content: "a sub-agent's prompt" },
          timestamp: "2026-09-07T15:00:00.000Z",
        },
        {
          type: "user",
          isMeta: true,
          message: { content: "<command-name>/compact</command-name>" },
          timestamp: "2026-09-07T15:00:01.000Z",
        },
        {
          type: "user",
          message: { content: "the real prompt" },
          promptId: "pid-real",
          timestamp: "2026-09-07T15:00:02.000Z",
        },
      ),
    );
    await h.t.start();
    await waitFor(events, (e) => e.filter((x) => x.topic === "prompt").length >= 3);

    // All three publish `prompt`; only the last is OUR delivery.
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]?.text).toBe("the real prompt");
    expect(h.ingested[0]?.promptId).toBe("pid-real");
  });

  it("signals the transcript is alive exactly once, on the first line", async () => {
    const { bus, events } = createMockBus();
    const h = makeIngestTailer(bus);
    tailer = h.t;
    await writeFile(
      sessionPath,
      jsonl(
        { type: "ai-title", aiTitle: "first", timestamp: "2026-09-07T15:00:00.000Z" },
        { type: "ai-title", aiTitle: "second", timestamp: "2026-09-07T15:00:01.000Z" },
      ),
    );
    await h.t.start();
    await waitFor(events, (e) => e.filter((x) => x.topic === "session.title").length >= 2);

    expect(h.alive()).toBe(1);
  });
});
