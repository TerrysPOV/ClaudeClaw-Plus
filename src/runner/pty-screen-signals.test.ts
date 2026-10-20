import { describe, expect, it } from "bun:test";
import {
  actionWord,
  argvShape,
  BLOCK_TYPES,
  boolWord,
  configPathWord,
  errorWord,
  fixedWord,
  RESULT_SUBTYPES,
  screenLogLine,
  screenSignals,
  STOP_REASONS,
  TRANSCRIPT_RECORD_TYPES,
  WIRE_EVENT_TYPES,
  wireSummary,
  withoutDirNames,
} from "./pty-screen-signals.js";

/**
 * #570 r14d (M1): the repo is public, so a CI log line about the child's screen may carry flags,
 * fixed reason names and counts, and nothing else. A word-by-word redaction of terminal text
 * cannot be complete; these fix the shape of what is allowed out instead.
 */

const LOG_LINE =
  /^\[isolation-spike\] screen-signals [\w-]+: \{"lines":\d+,"permissionPrompt":(true|false),"errorBanner":(true|false),"spinner":(true|false),"blocked":"(none|login-required|onboarding|trust-dialog)","ready":(true|false)\}; source=(live|exit-tail)$/;

describe("screenSignals", () => {
  const SECRET = "hunter2-Zq81vLmN4";
  const hostile = [
    `password is ${SECRET}`,
    `Do you trust the files in this folder?\n  /tmp/claudeclaw-oneshot-cfg-AbC123/.claude.json\nalice@example.com ${SECRET}`,
    `error: sk-ant-oat01-${SECRET}\n\n\nesc to interrupt ✻ ${SECRET}\ntab to cycle`,
    `${SECRET}\r\n`.repeat(100),
  ];

  it("lets nothing of the screen into the log line, whatever the screen holds", () => {
    for (const screen of hostile) {
      const line = screenLogLine("probe-1", "live", screenSignals(screen));
      // Went red (the secret in the line) with a sample of the text added to the signals.
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("example.com");
      expect(line).not.toContain("claudeclaw-oneshot");
      // Went red (no match) with any field beyond the six fixed ones, or a free-text value in them.
      expect(line).toMatch(LOG_LINE);
    }
  });

  it("still says what the screen is: flags, a blocked screen by name, the footer, a line count", () => {
    const signals = screenSignals(
      `Do you trust the files in this folder?\n1. Yes\n\n   \nerror: x\nesc to interrupt\ntab to cycle`,
    );
    // Went red (blocked "none") with the blocked-screen lookup removed.
    expect(signals).toEqual({
      lines: 5,
      permissionPrompt: true,
      errorBanner: true,
      spinner: true,
      blocked: "trust-dialog",
      ready: true,
    });
  });

  it("reports an empty screen as zero lines and nothing blocked", () => {
    expect(screenSignals("  \n\r\n")).toEqual({
      lines: 0,
      permissionPrompt: false,
      errorBanner: false,
      spinner: false,
      blocked: "none",
      ready: false,
    });
  });

  it("counts at most the last 40 lines", () => {
    expect(screenSignals("x\n".repeat(100)).lines).toBe(40);
  });
});

describe("the other words the harness prints from the child's side", () => {
  it("configPathWord keeps a short plain word and replaces anything else", () => {
    expect(configPathWord("projects")).toBe("projects");
    expect(configPathWord(".claude.json")).toBe(".claude.json");
    // Went red (the sentence passed through) with the pattern loosened to allow spaces.
    expect(configPathWord("my password is hunter2")).toBe("other");
    expect(configPathWord("a".repeat(33))).toBe("other");
    expect(configPathWord("")).toBe("other");
  });

  // r14e (M1): a short plain marker passes a character filter, so each field the child writes
  // has a fixed vocabulary instead.
  const MARKER = "PRIVMARK123";

  it("fixedWord prints a word of the vocabulary and nothing else, a short plain marker included", () => {
    expect(fixedWord("assistant", TRANSCRIPT_RECORD_TYPES)).toBe("assistant");
    expect(fixedWord("ai-title", TRANSCRIPT_RECORD_TYPES)).toBe("ai-title");
    expect(fixedWord("stop_sequence", STOP_REASONS)).toBe("stop_sequence");
    expect(fixedWord("tool_use", BLOCK_TYPES)).toBe("tool_use");
    for (const vocabulary of [
      TRANSCRIPT_RECORD_TYPES,
      WIRE_EVENT_TYPES,
      STOP_REASONS,
      BLOCK_TYPES,
      RESULT_SUBTYPES,
    ]) {
      // Went red (PRIVMARK123 printed) with the raw value passed through.
      expect(fixedWord(MARKER, vocabulary)).toBe("other");
      expect(fixedWord(undefined, vocabulary)).toBe("other");
      expect(fixedWord({ type: "assistant" }, vocabulary)).toBe("other");
    }
  });

  it("boolWord prints true or false for the booleans only", () => {
    expect(boolWord(true)).toBe("true");
    expect(boolWord(false)).toBe("false");
    // Went red (Received "true") with the string "true" accepted as well.
    expect(boolWord(MARKER)).toBe("other");
    expect(boolWord("true")).toBe("other");
    expect(boolWord(1)).toBe("other");
    expect(boolWord(undefined)).toBe("other");
  });

  it("wireSummary counts known event types, and prints a marker in a type, subtype or is_error as other", () => {
    const summary = wireSummary([
      { type: "system" },
      { type: "assistant" },
      { type: MARKER },
      { type: MARKER },
      { type: "result", subtype: MARKER, is_error: MARKER },
    ]);
    expect(summary).toEqual({
      events: { system: 1, assistant: 1, other: 2, result: 1 },
      resultSubtype: "other",
      resultIsError: "other",
    });
    expect(JSON.stringify(summary)).not.toContain(MARKER);
    expect(wireSummary([{ type: "result", subtype: "success", is_error: false }])).toEqual({
      events: { result: 1 },
      resultSubtype: "success",
      resultIsError: "false",
    });
    expect(wireSummary([{ type: "assistant" }]).resultSubtype).toBe("other"); // no result event
  });

  it("actionWord names the one known action and hides the rest", () => {
    expect(actionWord("hire")).toBe("hire");
    expect(actionWord("hunter2")).toBe("other");
    expect(actionWord(undefined)).toBe("none");
  });

  it("errorWord is a code or a class name, never the message", () => {
    expect(errorWord(Object.assign(new Error("secret at /tmp/x"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(errorWord(new TypeError("secret at /tmp/x"))).toBe("TypeError");
    // Went red (the message in the word) with String(error) printed.
    expect(errorWord(Object.assign(new Error("m"), { code: "bad code: hunter2/" }))).toBe(
      "badcodehunter2",
    );
    expect(errorWord(undefined)).toBe("error");
  });

  it("argvShape replaces prompt text with its length and leaves the flags", () => {
    expect(
      argvShape(["--model", "haiku", "--system-prompt", "Return hunter2", "--tools", ""]),
    ).toEqual(["--model", "haiku", "--system-prompt", "<14 chars>", "--tools", ""]);
    expect(argvShape(["--append-system-prompt", "abc"])).toEqual([
      "--append-system-prompt",
      "<3 chars>",
    ]);
  });

  it("withoutDirNames drops the random name of a throwaway directory", () => {
    const line = "[oneshot] 2 unreadable process(es) of claudeclaw-oneshot-cfg-AbC123 still alive";
    expect(withoutDirNames(line)).toBe("[oneshot] 2 unreadable process(es) of <dir> still alive");
  });
});
