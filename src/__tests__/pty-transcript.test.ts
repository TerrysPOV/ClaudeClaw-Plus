/**
 * The transcript reader behind every PTY turn (#562 round 2): acceptance, answer and the
 * end of the reply come from the file the CLI writes, never from the screen.
 *
 * Pure: a temp file stands in for the transcript and the tests append to it by hand, in
 * whatever partitions they like. Each assertion names the fault that turns it red.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_REPLY_TEXT,
  ID_LESS_TEXT,
  INTERLEAVED_TEXT,
  promptMatches,
  resolveTranscriptPath,
  TranscriptReplacedError,
  TranscriptTurn,
  type TranscriptTurnOptions,
} from "../runner/pty-transcript";
import {
  assistantLine,
  enqueueLine,
  systemLine,
  type TempTranscript,
  tempTranscript,
  userLine,
} from "./fixtures/fake-claude-tui";

const made: TempTranscript[] = [];
function tx(): TempTranscript {
  const t = tempTranscript();
  made.push(t);
  return t;
}
afterEach(() => {
  while (made.length) made.pop()?.cleanup();
});

function turn(
  t: TempTranscript,
  written = "R17x please",
  replCommand = false,
  extra: Partial<TranscriptTurnOptions> = {},
): TranscriptTurn {
  const turn = new TranscriptTurn({ path: t.path, written, replCommand, ...extra });
  turn.mark();
  return turn;
}
const nl = (...lines: string[]): string => `${lines.join("\n")}\n`;
const apiErrorLine = (text: string, id = "e"): string =>
  JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: {
      id,
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "stop_sequence",
    },
  });
const placeholderLine = (text = "No response requested."): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: "ph",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "stop_sequence",
    },
  });

describe("TranscriptTurn — acceptance", () => {
  test("a user entry for this prompt appended after the mark is acceptance", () => {
    const t = tx();
    const turn_ = turn(t);
    expect(turn_.poll().accepted).toBe(false);
    appendFileSync(t.path, nl(userLine("R17x please")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("an EARLIER identical prompt does not count: only bytes after the mark are read", () => {
    // Worst case exceeds the bound: the old entry is byte-identical to the new prompt.
    // Fault: mark() at offset 0 instead of the size and this goes true.
    const t = tx();
    writeFileSync(t.path, nl(userLine("R17x please"), assistantLine("OLD")));
    const turn_ = turn(t);
    const s = turn_.poll();
    expect(s.accepted).toBe(false);
    expect(s.answer).toBe("");
  });

  test("a queue-operation enqueue for this prompt is acceptance too", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(enqueueLine("R17x please")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("a different prompt is counted as foreign and is not acceptance", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("something else entirely")));
    const s = turn_.poll();
    expect(s.accepted).toBe(false);
    expect(s.foreignUserEntries).toBe(1);
  });

  test("tool results and sub-agent lines are not this turn's prompt", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "R17x please" }],
          },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          message: { role: "user", content: "R17x please" },
        }),
      ),
    );
    expect(turn_.poll().accepted).toBe(false);
  });

  test("whitespace AROUND the recorded payload is not part of the prompt", () => {
    // The CLI pads a recorded entry with newlines. Fault: compare without trimming and a
    // padded entry never matches the written text.
    const t = tx();
    const turn_ = turn(t, "R17x please");
    appendFileSync(t.path, nl(userLine("\nR17x please\n")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("a prompt the CLI recorded as a paste is wrapped in pasted_content tags and still matches", () => {
    // Every long prompt on CLI 2.1.296. Fault: do not take the wrapper off before the
    // comparison and the wrapped entry never equals the written text.
    const t = tx();
    const turn_ = turn(t, "R17x please do the thing");
    appendFileSync(
      t.path,
      nl(
        userLine(
          '<pasted_content id="4c50">\nR17x please do the thing\n</pasted_content id="4c50">',
        ),
      ),
    );
    expect(turn_.poll().accepted).toBe(true);
  });

  test("a TAB in the prompt, which the TUI turns into a completion key, does not stop it matching", () => {
    // Fault: compare the TAB as written and "a\tb" (written) never matches "ab"
    // (recorded): a permanent non-match that fails every such turn.
    const t = tx();
    const turn_ = turn(t, "a\tb");
    appendFileSync(t.path, nl(userLine("ab")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("an empty prompt matches nothing (it would match every entry)", () => {
    const t = tx();
    const turn_ = turn(t, "");
    appendFileSync(t.path, nl(userLine("anything")));
    expect(turn_.poll().accepted).toBe(false);
  });
});

describe("TranscriptTurn — answer and end of reply", () => {
  test("the answer is the assistant text after the matched user entry, and the terminal stop ends it", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("NEW-ANSWER")));
    let s = turn_.poll();
    expect(s.answer).toBe("NEW-ANSWER");
    // The final message is out, but the transcript has not yet said it is over.
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    s = turn_.poll();
    expect(s.answer).toBe("NEW-ANSWER");
    expect(s.ended).toBe(true);
  });

  test("an assistant entry BEFORE the user entry is not this turn's answer", () => {
    // Fault: ingest assistant lines regardless of userMatched and OLD is returned.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(assistantLine("OLD-ANSWER"), userLine("R17x please")));
    const s = turn_.poll();
    expect(s.answer).toBe("");
    expect(s.ended).toBe(false);
  });

  test("a tool_use stop does not end the turn; the final end_turn message does and is the answer", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", {
          id: "m1",
          stop: "tool_use",
          blocks: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          ],
        }),
      ),
    );
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    expect(s.toolLines).toEqual(['● Read({"file_path":"/a"})']);
    appendFileSync(
      t.path,
      nl(assistantLine("FINAL", { id: "m2", stop: "end_turn" }), systemLine("turn_duration")),
    );
    s = turn_.poll();
    expect(s.ended).toBe(true);
    // Only the final message: the narration before the tool call is not the answer.
    expect(s.answer).toBe("FINAL");
  });

  test("blocks of ONE message arriving over separate polls are joined, in full", () => {
    // The answer is split across appends; none of it may be dropped (round 2, finding 3).
    // Fault: replace instead of append for a repeated message id and only the tail is left.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("PART-ONE ", { id: "m1", stop: null })),
    );
    expect(turn_.poll().answer).toBe("PART-ONE ");
    appendFileSync(t.path, nl(assistantLine("PART-TWO ", { id: "m1", stop: null })));
    appendFileSync(
      t.path,
      nl(assistantLine("PART-THREE", { id: "m1", stop: "end_turn" }), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.answer).toBe("PART-ONE PART-TWO PART-THREE");
    expect(s.ended).toBe(true);
  });

  test("turn_duration ends a turn whose last assistant line carried no stop reason", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("A", { stop: null })));
    expect(turn_.poll().ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    expect(turn_.poll().ended).toBe(true);
  });

  test("a CLI-written API error line ends the turn as a FAILURE, with no answer", () => {
    // Fault: set only `ended` on an API error (the round-2 shape) and `failure` is null:
    // both callers would report the CLI's error text as a successful reply.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), apiErrorLine("API Error: 529")));
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "api-error", text: "API Error: 529" });
    expect(s.answer).toBe("");
  });
});

describe("TranscriptTurn — delivery shape never changes the verdict", () => {
  const FULL = nl(
    userLine("R17x please"),
    assistantLine("PART-A ", { id: "m1", stop: null }),
    assistantLine("PART-B", { id: "m1", stop: "end_turn" }),
    systemLine("turn_duration"),
  );
  // Cut points are bytes, so every one of these tears a JSON line somewhere.
  const cuts = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => Math.floor(((i + 1) * FULL.length) / (n + 1)));
  const partitions: Array<[string, number[]]> = [
    ["one write", []],
    ["two halves", cuts(1)],
    ["five parts", cuts(4)],
    ["a cut inside every line", [10, 30, FULL.indexOf("\n") + 5, FULL.length - 7]],
    ["one byte at a time at the end", Array.from({ length: 20 }, (_, i) => FULL.length - 20 + i)],
  ];
  for (const [name, points] of partitions) {
    test(`${name}: same verdict and answer as one write`, () => {
      // Fault: drop the carry of a torn trailing line and the second half of it is lost.
      const t = tx();
      const turn_ = turn(t);
      let from = 0;
      for (const at of [...points, FULL.length]) {
        appendFileSync(t.path, FULL.slice(from, at));
        turn_.poll();
        from = at;
      }
      const s = turn_.poll();
      expect(s.accepted).toBe(true);
      expect(s.answer).toBe("PART-A PART-B");
      expect(s.ended).toBe(true);
    });
  }
});

describe("TranscriptTurn — /compact", () => {
  const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>";
  test("accepted by the command entry, ended by compact_boundary", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(t.path, nl(userLine(cmd)));
    let s = turn_.poll();
    expect(s.accepted).toBe(true);
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("compact_boundary", "Conversation compacted")));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("Conversation compacted");
  });

  test("a failed compact ends as a FAILURE on its local_command error, carrying the CLI's text", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(
      t.path,
      nl(
        userLine(cmd),
        systemLine(
          "local_command",
          "<local-command-stderr>Error: Not enough messages to compact.</local-command-stderr>",
        ),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    // Fault: strip the tags but leave `failure` unset and a failed compact is a success.
    expect(s.failure).toEqual({
      kind: "command-error",
      text: "Error: Not enough messages to compact.",
    });
  });

  test("/compact with arguments is still matched by its command name", () => {
    const t = tx();
    const turn_ = turn(t, "/compact keep the tests", true);
    appendFileSync(
      t.path,
      nl(
        userLine(
          "<command-name>/compact</command-name>\n<command-args>keep the tests</command-args>",
        ),
      ),
    );
    expect(turn_.poll().accepted).toBe(true);
  });

  test("another command's entry is not this /compact", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(t.path, nl(userLine("<command-name>/clear</command-name>")));
    expect(turn_.poll().accepted).toBe(false);
  });
});

describe("resolveTranscriptPath", () => {
  const env = { CLAUDE_CONFIG_DIR: "/cfg" };
  test("config dir, projects, encoded cwd, session id", () => {
    expect(resolveTranscriptPath({ cwd: "/definitely/not/there", sessionId: "abc", env })).toBe(
      "/cfg/projects/-definitely-not-there/abc.jsonl",
    );
  });
  test("the cwd is realpath'd: the CLI encodes the physical directory", () => {
    const real = join(tmpdir(), `pty-real-${process.pid}`);
    const link = `${real}-link`;
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const physical = resolveTranscriptPath({ cwd: link, sessionId: "abc", env }) as string;
    const direct = resolveTranscriptPath({ cwd: real, sessionId: "abc", env }) as string;
    expect(physical).toBe(direct);
  });
  test("no session id, or an untrusted one-shot: no transcript", () => {
    expect(resolveTranscriptPath({ cwd: "/a", sessionId: "", env })).toBeNull();
    expect(resolveTranscriptPath({ cwd: "/a", sessionId: "abc", env, untrusted: true })).toBeNull();
  });
});

describe("promptMatches — the whole payload, not a substring (round 3, H3)", () => {
  test("a prompt that is only CONTAINED in a longer one does not match", () => {
    // Fault: go back to `includes` and `check status` matches the longer cron prompt.
    expect(promptMatches("hourly check status and restart failures", "check status", false)).toBe(
      false,
    );
    expect(promptMatches("check status", "check status", false)).toBe(true);
  });

  test("internal whitespace is part of the prompt: `a b` is not `ab`", () => {
    // Fault: strip all whitespace before comparing and both of these go true.
    expect(promptMatches("ab", "a b", false)).toBe(false);
    expect(promptMatches("a b", "ab", false)).toBe(false);
    expect(promptMatches("a  b", "a b", false)).toBe(false);
  });

  test("a prefix or suffix the prompt did not carry does not match", () => {
    expect(promptMatches("[clock 12:00]\nR17x please", "R17x please", false)).toBe(false);
    expect(promptMatches("R17x please\nand more", "R17x please", false)).toBe(false);
  });

  test("the paste wrapper and the padding it adds are taken off both ends", () => {
    const wrapped = '\n\n<pasted_content id="c678">\nR17x please\n</pasted_content id="c678">\n';
    expect(promptMatches(wrapped, "R17x please", false)).toBe(true);
  });

  test("a TAB may be recorded as nothing or as spaces, at that position only", () => {
    // Fault: drop the tab rule and `a\tb` never matches what the TUI recorded.
    expect(promptMatches("ab", "a\tb", false)).toBe(true);
    expect(promptMatches("a b", "a\tb", false)).toBe(true);
    expect(promptMatches("a    b", "a\tb", false)).toBe(true);
    // ...but a space with no TAB behind it is still not nothing.
    expect(promptMatches("a bc", "a\tb", false)).toBe(false);
    expect(promptMatches("axb", "a\tb", false)).toBe(false);
  });

  test("Unicode normalisation differences do not break an equal prompt", () => {
    expect(promptMatches("café", "café", false)).toBe(true);
  });
});

describe("TranscriptTurn — a second identical prompt is uncertain, never a success (round 3, H3)", () => {
  test("the same prompt recorded again inside the turn fails it as ambiguous", () => {
    // Fault: count the second match as `userMatched` again and the turn would take the
    // later reply as its own.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("working", { id: "m1", stop: "tool_use" }),
        userLine("R17x please"),
        assistantLine("LATE-ANSWER", { id: "m2" }),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure?.kind).toBe("ambiguous");
    expect(s.answer).toBe("");
  });

  test("the same prompt appended right after the reply (before the boundary) downgrades it to ambiguous", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("A")));
    expect(turn_.poll().failure).toBeNull();
    appendFileSync(t.path, nl(userLine("R17x please")));
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("ambiguous");
  });

  test("a line the CLI repeats (same uuid) is not a second prompt", () => {
    const t = tx();
    const turn_ = turn(t);
    const entry = JSON.stringify({
      type: "user",
      uuid: "u-1",
      promptId: "p-1",
      message: { role: "user", content: "R17x please" },
    });
    appendFileSync(t.path, nl(entry, entry, assistantLine("A")));
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("A");
  });

  test("a DIFFERENT prompt inside the turn fails it as ambiguous", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("working", { id: "m1", stop: "tool_use" }),
        userLine("something else, typed meanwhile"),
        assistantLine("ANSWER-TO-WHICH", { id: "m2" }),
      ),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("ambiguous");
    expect(s.answer).toBe("");
  });

  test("meta entries and tool results inside the turn are the turn's own", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", {
          id: "m1",
          stop: "tool_use",
          blocks: [{ type: "tool_use", name: "Skill", input: {} }],
        }),
        JSON.stringify({
          type: "user",
          isMeta: true,
          message: { role: "user", content: "Base directory for this skill: /x" },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
          },
        }),
        assistantLine("DONE", { id: "m2" }),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("DONE");
  });
});

describe("TranscriptTurn — failure is not success (round 3, H2)", () => {
  test("an API error after some assistant text still fails the turn, and the text is not an answer", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Let me try", { id: "m1", stop: "tool_use" }),
        apiErrorLine("API Error: 500 internal"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toEqual({ kind: "api-error", text: "API Error: 500 internal" });
    expect(s.answer).toBe("");
  });

  test("an `error` field on an assistant line, without the flag, is an API error too", () => {
    // The bus tailer tests `line.error || line.isApiErrorMessage`; so does this.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        JSON.stringify({
          type: "assistant",
          error: "rate_limit",
          message: {
            id: "e",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "You've hit your session limit" }],
            stop_reason: "stop_sequence",
          },
        }),
      ),
    );
    expect(turn_.poll().failure?.kind).toBe("api-error");
  });

  test("a local-command-stderr system line inside an ordinary turn fails it", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        systemLine("local_command", "<local-command-stderr>boom</local-command-stderr>"),
      ),
    );
    expect(turn_.poll().failure).toEqual({ kind: "command-error", text: "boom" });
  });

  test("a command's own stdout, recorded as a user entry, is not another prompt", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(
      t.path,
      nl(
        userLine("<command-name>/compact</command-name>"),
        userLine("<local-command-stdout>Compacted</local-command-stdout>"),
        systemLine("compact_boundary", "Conversation compacted"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("Conversation compacted");
  });
});

describe("TranscriptTurn — placeholders are not answers (round 3, H1)", () => {
  test("a non-error <synthetic> placeholder is neither text nor an end; the real reply that follows is the result", () => {
    // Fault: treat <synthetic> as terminal (the round-2 code) and the placeholder is the
    // answer, ended before the real reply starts.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), placeholderLine()));
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    expect(s.answer).toBe("");
    expect(s.failure).toBeNull();
    appendFileSync(
      t.path,
      nl(assistantLine("THE-REAL-REPLY", { id: "real" }), systemLine("turn_duration")),
    );
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("THE-REAL-REPLY");
  });

  test("the same, with the real reply arriving in the same poll", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        placeholderLine(),
        assistantLine("THE-REAL-REPLY", { id: "real" }),
      ),
    );
    expect(turn_.poll().answer).toBe("THE-REAL-REPLY");
  });
});

describe("TranscriptTurn — the matched turn is a window, frozen when it ends (round 3, H4)", () => {
  const ids = (id: string) => ({ id });

  test("A prompt, A answer, B prompt, B answer in ONE poll: the result is A's", () => {
    // Fault: keep ingesting after `ended` and the later message replaces A's answer.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("ANSWER-A", ids("a")),
        userLine("the next, scheduled prompt"),
        assistantLine("ANSWER-B", ids("b")),
      ),
    );
    const s = turn_.poll();
    expect(s.answer).toBe("ANSWER-A");
    expect(s.ended).toBe(true);
    expect(s.failure).toBeNull();
  });

  test("B arriving AFTER the poll that saw A's end cannot change the result", () => {
    // The screen-settling window: the poll that ended the turn is followed, a moment
    // later, by B's records. Fault: no `closed` phase and ANSWER-B replaces ANSWER-A.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("ANSWER-A", ids("a"))));
    expect(turn_.poll().answer).toBe("ANSWER-A");
    appendFileSync(t.path, nl(userLine("B"), assistantLine("ANSWER-B", ids("b"))));
    const s = turn_.poll();
    expect(s.answer).toBe("ANSWER-A");
    expect(s.ended).toBe(true);
  });

  test("narration, then a tool call, then the final answer: the answer is ONLY the final message", () => {
    // What a user would otherwise get in Telegram/Discord/cron output. Fault: join every
    // message of the window ("Let me look.\n\nThe tool ran.\n\nFINAL-ANSWER").
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", {
          id: "m1",
          stop: "tool_use",
          blocks: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          ],
        }),
        assistantLine("The tool ran.", { id: "m2", stop: "tool_use" }),
        assistantLine("FINAL-ANSWER", { id: "m3" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.answer).toBe("FINAL-ANSWER");
    expect(s.ended).toBe(true);
    expect(s.toolLines).toEqual(['● Read({"file_path":"/a"})']);
  });

  test("the blocks of the final message join as-is", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("narration", { id: "m1", stop: "tool_use" }),
        assistantLine("PART-A ", { id: "m2", stop: null }),
        assistantLine("PART-B", { id: "m2" }),
      ),
    );
    expect(turn_.poll().answer).toBe("PART-A PART-B");
  });

  test("a turn that ends on a tool-only message is an empty reply, whatever the narration before it said", () => {
    // Round 6, Fix 2: the answer is the FINAL message. A tool-only final message has no text,
    // so "The last words." is narration and must not stand in for it. (This reverses the
    // round-3 expectation, which returned the last message that had text.)
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Earlier narration.", { id: "m1", stop: "tool_use" }),
        assistantLine("The last words.", { id: "m2", stop: "tool_use" }),
        assistantLine("", {
          id: "m3",
          blocks: [{ type: "tool_use", name: "Bash", input: { command: "true" } }],
        }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "empty-reply", text: EMPTY_REPLY_TEXT });
    expect(s.answer).toBe("");
  });

  test("a final message written as a thinking line first still gets its text line", () => {
    // The CLI writes one line per block and repeats the stop_reason on each, so the final
    // message's first line can have no text. Fault: freeze at the first terminal line and
    // the text line is dropped.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", { id: "m1", blocks: [{ type: "thinking", thinking: "hm" }] }),
      ),
    );
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(assistantLine("THE-TEXT", ids("m1"))));
    s = turn_.poll();
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("THE-TEXT");
  });

  test("a final message with no text at all ends when the next entry closes the window", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", { id: "m1", blocks: [{ type: "thinking", thinking: "hm" }] }),
      ),
    );
    expect(turn_.poll().ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("");
  });

  test("a later assistant message with NO prompt between is not this turn's: the turn still ends only at its boundary", () => {
    // A background-task notification can start a reply of its own right after a turn's last
    // message. Fault: accept any assistant message after the final one (drop the id match in
    // the terminal phase) and its text is appended to this turn's answer.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("ANSWER-A", ids("a")),
        assistantLine("UNRELATED-NOTIFICATION-REPLY", ids("n")),
      ),
    );
    let s = turn_.poll();
    // Neither appended nor a boundary (round 5): the turn still waits for `turn_duration`.
    expect(s.answer).toBe("ANSWER-A");
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    s = turn_.poll();
    expect(s.answer).toBe("ANSWER-A");
    expect(s.ended).toBe(true);
  });

  test("a closed window reads nothing more: later lines are not even parsed into state", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("A", ids("a")), systemLine("turn_duration")),
    );
    turn_.poll();
    appendFileSync(t.path, nl(assistantLine("LATE", ids("a")), apiErrorLine("API Error: 500")));
    const s = turn_.poll();
    expect(s.answer).toBe("A");
    expect(s.failure).toBeNull();
  });
});

describe("TranscriptTurn — the file must stay the file the turn started on (round 3, M1)", () => {
  const history = nl(userLine("R17x please"), assistantLine("OLD-ANSWER", { id: "old" }));

  test("a BIGGER replacement holding an EARLIER identical prompt and its answer is not evidence", () => {
    // The replacement is larger than the old offset, so a size check alone sees nothing
    // wrong. Fault: drop the identity comparison and the file is read on from the old offset
    // as if it were the same one: no error, and a replacement the turn never wrote.
    const t = tx();
    writeFileSync(t.path, `${"x".repeat(50)}\n`);
    const turn_ = turn(t);
    const replacement = `${t.path}.new`;
    writeFileSync(replacement, history);
    renameSync(replacement, t.path);
    expect(() => turn_.poll()).toThrow(TranscriptReplacedError);
  });

  test("a SMALLER replacement holding an EARLIER identical prompt and its answer is not evidence", () => {
    // The round-2 bypass: the file shrank, so the reader started over from the top and read
    // this exact prompt and OLD-ANSWER as new evidence. Fault: restart from 0 on a shrink
    // (and skip the identity check) and this resolves to OLD-ANSWER instead of throwing.
    const t = tx();
    writeFileSync(t.path, `${"x".repeat(2000)}\n`);
    const turn_ = turn(t);
    const replacement = `${t.path}.new`;
    writeFileSync(replacement, history);
    renameSync(replacement, t.path);
    expect(() => turn_.poll()).toThrow(TranscriptReplacedError);
  });

  test("a file cut short is a named error, not a restart from the top", () => {
    const t = tx();
    writeFileSync(t.path, `${"x".repeat(500)}\n`);
    const turn_ = turn(t);
    writeFileSync(t.path, history); // same inode, now shorter than the offset
    expect(() => turn_.poll()).toThrow(/cut short/);
  });

  test("a file removed during the turn is a named error", () => {
    const t = tx();
    writeFileSync(t.path, `${"x".repeat(50)}\n`);
    const turn_ = turn(t);
    rmSync(t.path);
    expect(() => turn_.poll()).toThrow(/removed/);
  });

  test("a file the CLI creates after the mark is read from its first byte", () => {
    // Absent at mark(): everything in it is new. The identity is taken when it appears.
    const t = tx();
    const turn_ = turn(t);
    expect(turn_.poll().accepted).toBe(false);
    writeFileSync(t.path, nl(userLine("R17x please"), assistantLine("FIRST-ANSWER")));
    expect(turn_.poll().answer).toBe("FIRST-ANSWER");
  });

  test("once the turn has closed, a later replacement is not read at all", () => {
    const t = tx();
    writeFileSync(t.path, "");
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("A", { id: "a" }), systemLine("turn_duration")),
    );
    expect(turn_.poll().answer).toBe("A");
    rmSync(t.path);
    expect(turn_.poll().answer).toBe("A");
  });
});

describe("TranscriptTurn — a turn ends only at an authoritative boundary (round 5, HIGH 1 + 2)", () => {
  const ids = (id: string) => ({ id });
  const t0 = new Date("2026-10-22T10:00:00Z").getTime();

  afterEach(() => {
    setSystemTime();
  });

  test("block B of the final message arriving 5 s after block A is in the answer: a quiet file is not an end", () => {
    // Fault (site: `poll`): end a terminal turn once the file has not grown for 1.5 s (the
    // round-4 settle) and A alone is returned, B ignored.
    setSystemTime(new Date(t0));
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("A-BLOCK ", ids("m1"))));
    expect(turn_.poll().finalSeen).toBe(true);
    for (const waitedMs of [1_500, 1_501, 3_000]) {
      setSystemTime(new Date(t0 + waitedMs));
      const s = turn_.poll();
      expect(s.ended).toBe(false);
      expect(s.failure).toBeNull();
    }
    setSystemTime(new Date(t0 + 5_000));
    appendFileSync(t.path, nl(assistantLine("B-BLOCK", ids("m1"))));
    expect(turn_.poll().ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("A-BLOCK B-BLOCK");
  });

  test("a final message with no boundary never ends: finalSeen says so, there is no success", () => {
    // Fault (site: `ingestAssistant`, the `phase = "terminal"` branch): end the turn on the
    // terminal stop_reason itself and this is ended with an answer that may be incomplete.
    setSystemTime(new Date(t0));
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("FINAL", ids("m1"))));
    setSystemTime(new Date(t0 + 10 * 60_000));
    const s = turn_.poll();
    expect(s.finalSeen).toBe(true);
    expect(s.ended).toBe(false);
    expect(s.failure).toBeNull();
  });

  test("a tool_use stop is not a final message: finalSeen stays false", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("Let me look.", { id: "m1", stop: "tool_use" })),
    );
    expect(turn_.poll().finalSeen).toBe(false);
  });

  test("progress, hook, attachment and snapshot records between the blocks neither close nor cut the final message", () => {
    // Fault (site: `ingestInTurn`, the `default:` branch): let any other record type close
    // the window and B is dropped, the answer "A-BLOCK " committed.
    const t = tx();
    const turn_ = turn(t);
    const bookkeeping = [
      JSON.stringify({ type: "progress", data: { type: "hook_progress" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "hook_success" } }),
      JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "the NEXT prompt" }),
      systemLine("stop_hook_summary"),
      systemLine("api_metrics"),
    ];
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("A-BLOCK ", ids("m1")), ...bookkeeping),
    );
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(assistantLine("B-BLOCK", ids("m1"))));
    s = turn_.poll();
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("A-BLOCK B-BLOCK");
  });

  test("meta entries, tool results, compact summaries and sub-agent lines after the final message are not the next prompt", () => {
    // Fault (site: `ingestUserInTurn`, the terminal-phase `finish()`): treat any user entry
    // as the boundary and the first of these ends the turn before B.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("A-BLOCK ", ids("m1")),
        JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "meta" } }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
        }),
        JSON.stringify({
          type: "user",
          isCompactSummary: true,
          message: { role: "user", content: "summary" },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          message: { role: "user", content: "sub-agent prompt" },
        }),
        assistantLine("B-BLOCK", ids("m1")),
      ),
    );
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    expect(s.answer).toBe("A-BLOCK B-BLOCK");
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("A-BLOCK B-BLOCK");
  });

  test("the next real user prompt is a boundary: the turn ends and that prompt's reply is never read", () => {
    // Fault (site: `ingestUserInTurn`, drop the terminal-phase boundary): the turn never ends
    // on the next prompt, so `ended` stays false.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("ANSWER-A", ids("a")),
        userLine("the next prompt"),
        assistantLine("ANSWER-B", ids("b")),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("ANSWER-A");
  });

  test("an API error after the final text and before turn_duration fails the turn, with no answer", () => {
    // Fault (site: `ingestAssistant`, read the error flags AFTER the terminal-phase id
    // check): the error is ignored, `turn_duration` closes the turn and "FINAL" is a success.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("FINAL", ids("m1")),
        apiErrorLine("API Error: 529 overloaded"),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure?.kind).toBe("api-error");
    expect(s.failure?.text).toContain("529");
    expect(s.answer).toBe("");
  });

  test("an API error that reuses the final message's id is still an error, not a block of it", () => {
    // The error check comes before the same-id append: a flagged line with the final id.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("FINAL", ids("m1")),
        apiErrorLine("API Error: 500", "m1"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("api-error");
    expect(s.answer).toBe("");
  });

  test("a command's stderr after the final message fails the turn too", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("FINAL", ids("m1")),
        systemLine("local_command", "<local-command-stderr>boom</local-command-stderr>"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("command-error");
    expect(s.answer).toBe("");
  });
});

describe("TranscriptTurn — an empty reply is a failure (round 5, MEDIUM)", () => {
  const ids = (id: string) => ({ id });
  const toolOnly = (id: string) =>
    assistantLine("", { id, blocks: [{ type: "tool_use", name: "Read", input: {} }] });

  test("a turn whose only message is tool-only fails with the fixed text, and has no answer", () => {
    // Fault (site: `finish`): treat an empty answer as OK and this is ended with failure null.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), toolOnly("m1"), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "empty-reply", text: EMPTY_REPLY_TEXT });
    expect(EMPTY_REPLY_TEXT).toBe("empty reply in transcript");
    expect(s.answer).toBe("");
  });

  test("a whitespace-only reply is empty", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine(" \n\t ", ids("m1")), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("empty-reply");
  });

  test("a turn_duration with no assistant message at all is empty too", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), systemLine("turn_duration")));
    expect(turn_.poll().failure?.kind).toBe("empty-reply");
  });

  test("narration, then a thinking-only terminal message, then the boundary: fails as empty, the narration is not the answer (round 6)", () => {
    // Codex's r5 sequence. Fault (site: `addAssistantLine`, drop a message that has no text
    // again): the thinking-only message vanishes, "Let me check" is the last message with
    // text and the turn succeeds with it. Predicted result with the fault: failure null,
    // answer "Let me check".
    // This test replaces one that asserted the old behaviour (an earlier message with text
    // answered when the final message had none): a deliberate reversal, ruling 3.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Let me check", {
          id: "m1",
          stop: "tool_use",
          blocks: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", name: "Read", input: {} },
          ],
        }),
        assistantLine("", {
          id: "m2",
          stop: "end_turn",
          blocks: [{ type: "thinking", thinking: "hmm" }],
        }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "empty-reply", text: EMPTY_REPLY_TEXT });
    expect(s.answer).toBe("");
  });

  test("the same sequence with real text in the final message answers with the final message only", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Let me check", { id: "m1", stop: "tool_use" }),
        assistantLine("It is fine.", { id: "m2", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("It is fine.");
  });

  test("/compact with an empty completion marker is still a success: its result is its own output", () => {
    // Fault (site: `finish`, drop the `!this.replCommand` guard): /compact fails as empty.
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(
      t.path,
      nl(userLine("<command-name>/compact</command-name>"), systemLine("compact_boundary", "")),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toBeNull();
  });
});

describe("TranscriptTurn — incomplete assistant shapes (round 6, Fix 3)", () => {
  const ids = (id: string) => ({ id });
  const idless = (text: string, stop: string | null = "end_turn"): string =>
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text }],
        stop_reason: stop,
      },
    });

  test("an error-flagged assistant record with NO message, after the final message, fails the turn", () => {
    // Codex's r5 sequence. Fault (site: `ingestAssistant`, return on a missing message before
    // the error flags are read): the record is skipped, the boundary comes, and the turn
    // succeeds with "FINAL". Predicted result with the fault: failure null, answer "FINAL".
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("FINAL", ids("m1")),
        JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "529" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "api-error", text: "529" });
    expect(s.answer).toBe("");
  });

  test("an error flag with no message and no text still fails, with a fixed text", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), JSON.stringify({ type: "assistant", isApiErrorMessage: true })),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("api-error");
    expect(s.failure?.text).not.toBe("undefined");
  });

  test("an assistant record with no message and no error flag is ignored", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        JSON.stringify({ type: "assistant" }),
        assistantLine("FINAL", ids("m1")),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("FINAL");
  });

  test("id-less lines A then B, A carrying the terminal stop: uncertain, never A alone", () => {
    // Codex's r5 sequence. Fault (site: the terminal-phase id check, drop an id-less line
    // silently as before): B is dropped and the turn succeeds with "A". Predicted result with
    // the fault: failure null, answer "A".
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), idless("A"), idless("B"), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure?.kind).toBe("ambiguous");
    expect(s.failure?.text).toBe(ID_LESS_TEXT);
    expect(s.answer).toBe("");
  });

  test("id-less lines A (open) then B (terminal): uncertain, never B alone", () => {
    // Fault (site: the id-less counter, never fail on a second line): the two lines become
    // two messages and the answer is "B". Predicted result with the fault: failure null.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), idless("A", null), idless("B"), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.failure?.kind).toBe("ambiguous");
    expect(s.answer).toBe("");
  });

  test("a single id-less final line is a complete message, and answers", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), idless("ONLY"), systemLine("turn_duration")),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("ONLY");
  });

  test("an id-less line beside an id'd message is uncertain too", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("working", { id: "m1", stop: "tool_use" }),
        idless("FINAL"),
        systemLine("turn_duration"),
      ),
    );
    expect(turn_.poll().failure?.kind).toBe("ambiguous");
  });
});

describe("TranscriptTurn — interleaved messages are uncertain, not attributed (round 7, Fix 2)", () => {
  const toolResult = (): string =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    });

  test("A starts, B terminates, A finishes: uncertain, never B alone", () => {
    // Codex's r6 shape (i). Fault (site: the interleave check in `ingestAssistant`, removed):
    // the first terminal message (B) is frozen as the final one and A's tail is dropped.
    // Predicted result with the fault: failure null, answer "B-reply".
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("A-start ", { id: "mA", stop: null }),
        assistantLine("B-reply", { id: "mB", stop: "end_turn" }),
        assistantLine("A-end", { id: "mA", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "ambiguous", text: INTERLEAVED_TEXT });
    expect(s.answer).toBe("");
  });

  test("A-prefix, a non-terminal B, A-suffix: uncertain, never the suffix alone", () => {
    // Codex's r6 shape (ii). Same fault: A's blocks are not tied together across B, so the
    // terminal A-suffix answers by itself. Predicted result: answer "A-suffix".
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("A-prefix ", { id: "mA", stop: null }),
        assistantLine("B-working", { id: "mB", stop: null }),
        assistantLine("A-suffix", { id: "mA", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toEqual({ kind: "ambiguous", text: INTERLEAVED_TEXT });
    expect(s.answer).toBe("");
  });

  test("the final message resumes after another message's line that was ignored: uncertain", () => {
    // Fault (site: the interleave check, applied only while the turn is still open): B's line
    // after the final message is ignored without being counted, so A's later block extends the
    // answer as if nothing came between. Predicted result: failure null, answer "A-one A-two".
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("A-one ", { id: "mA", stop: "end_turn" }),
        assistantLine("B-bg", { id: "mB", stop: "end_turn" }),
        assistantLine("A-two", { id: "mA", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toEqual({ kind: "ambiguous", text: INTERLEAVED_TEXT });
  });

  test("interleaving across polls is the same verdict as within one", () => {
    // The state that decides it (`seenIds`, `lastLineId`) must live across polls.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("A1", { id: "mA", stop: null })),
    );
    expect(turn_.poll().failure).toBeNull();
    appendFileSync(t.path, nl(assistantLine("B", { id: "mB", stop: null })));
    expect(turn_.poll().failure).toBeNull();
    appendFileSync(t.path, nl(assistantLine("A2", { id: "mA", stop: "end_turn" })));
    expect(turn_.poll().failure?.kind).toBe("ambiguous");
  });

  test("the normal tool loop still answers with the final message", () => {
    // A tool_use message, its result, then the final message: different ids in sequence,
    // never back to an earlier one. Fault (site: the interleave check, `seenIds.has` made
    // always true): every second message would be called interleaved. Predicted: ambiguous.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Let me check", { id: "m1", stop: "tool_use" }),
        toolResult(),
        assistantLine("Checking more", { id: "m2", stop: "tool_use" }),
        toolResult(),
        assistantLine("It is fine.", { id: "m3", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("It is fine.");
  });

  test("blocks of one message split by bookkeeping records and tool results still join", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("Part one. ", { id: "m1", stop: null }),
        JSON.stringify({ type: "progress" }),
        toolResult(),
        assistantLine("Part two.", { id: "m1", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("Part one. Part two.");
  });

  test("a background reply that starts after the final message and never returns is still ignored", () => {
    // The round-5 ruling stays: another message AFTER the final one is neither appended nor
    // a boundary. It is only a return to an earlier message that cannot be placed.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("The answer.", { id: "mA", stop: "end_turn" }),
        assistantLine("bg notification reply", { id: "mB", stop: "end_turn" }),
        systemLine("turn_duration"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("The answer.");
  });
});

describe("TranscriptTurn — literal paste tags in the prompt (round 4, finding 4)", () => {
  const literal = 'Explain <pasted_content id="x">hi</pasted_content id="x">';

  test("a prompt that contains paste tags, recorded as is, is accepted", () => {
    // Fault: strip every paste tag from the recorded side (the round-3 code): the record
    // becomes "Explain hi", never equals the written text, and a healthy turn is rejected.
    const t = tx();
    const turn_ = turn(t, literal);
    appendFileSync(t.path, nl(userLine(literal)));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("the same prompt inside the CLI's outer paste wrapper is accepted, inner tags kept", () => {
    const t = tx();
    const turn_ = turn(t, literal);
    appendFileSync(
      t.path,
      nl(userLine(`<pasted_content id="4c50">\n${literal}\n</pasted_content id="4c50">`)),
    );
    expect(turn_.poll().accepted).toBe(true);
  });

  test("a prompt whose inner tags were stripped by the recorder is a different prompt", () => {
    const t = tx();
    const turn_ = turn(t, literal);
    appendFileSync(t.path, nl(userLine("Explain hi")));
    expect(turn_.poll().accepted).toBe(false);
  });
});

describe("TranscriptTurn — /compact API errors (round 4, finding 5)", () => {
  const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>";

  test("an assistant API-error record after /compact fails the turn promptly, with no local_command stderr", () => {
    // Fault: skip every assistant record for a command (the round-3 code): the error is
    // ignored and the call waits to the hard timeout.
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(t.path, nl(userLine(cmd), apiErrorLine("API Error: 529 overloaded")));
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.failure).toEqual({ kind: "api-error", text: "API Error: 529 overloaded" });
    expect(s.answer).toBe("");
  });

  test("a command's ordinary assistant text is still not its answer", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(
      t.path,
      nl(
        userLine(cmd),
        assistantLine("chatter", { id: "m1" }),
        systemLine("compact_boundary", "Done"),
      ),
    );
    const s = turn_.poll();
    expect(s.failure).toBeNull();
    expect(s.answer).toBe("Done");
  });
});
