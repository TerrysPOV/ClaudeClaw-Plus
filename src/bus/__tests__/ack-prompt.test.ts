import { describe, expect, it } from "bun:test";
import {
  endsWithQuestion,
  isAnsweredRepeat,
  isBareAcknowledgement,
  REPEAT_WINDOW_MS,
  type SeenPrompt,
} from "../ack-prompt";

describe("isBareAcknowledgement", () => {
  it("accepts bare acknowledgements, EN and FR, with or without emoji", () => {
    for (const t of [
      "ok",
      "Ok",
      "OK!",
      "okay",
      "thanks",
      "thank you",
      "merci",
      "Merci 🙏",
      "👍",
      "👌🏻",
      "ok 👍",
      "parfait",
      "d’accord",
      "noté",
      "cool thx",
      "❤️",
      "✅ merci",
    ]) {
      expect(isBareAcknowledgement(t)).toBe(true);
    }
  });

  it("rejects decisions, questions, requests and anything longer", () => {
    for (const t of [
      "oui",
      "yes",
      "go",
      "ok?",
      "ok go",
      "ok send it",
      "you",
      "thank you, now check the logs",
      "ok 2",
      "!",
      "...",
      "",
      "merci merci merci merci",
      "ok？",
    ]) {
      expect(isBareAcknowledgement(t)).toBe(false);
    }
  });

  it("rejects emoji that may ask, refuse or stop", () => {
    for (const t of ["🤔", "❓", "👎", "❌", "😡", "🆘", "🚨", "⏹️", "ok 👎", "👍❌"]) {
      expect(isBareAcknowledgement(t)).toBe(false);
    }
  });
});

describe("isAnsweredRepeat", () => {
  const prev: SeenPrompt = { origin_id: "100", text: "check the logs", at: 1_000, answered: true };

  it("is a repeat only for the same chat and text, answered, inside the window", () => {
    expect(isAnsweredRepeat(prev, "100", " check the logs ", 2_000)).toBe(true);
    expect(isAnsweredRepeat(prev, "100", "check the logs", 1_000 + REPEAT_WINDOW_MS + 1)).toBe(
      false,
    );
    expect(isAnsweredRepeat(prev, "200", "check the logs", 2_000)).toBe(false);
    expect(isAnsweredRepeat(prev, "100", "check the mail", 2_000)).toBe(false);
    expect(isAnsweredRepeat({ ...prev, answered: false }, "100", "check the logs", 2_000)).toBe(
      false,
    );
    expect(isAnsweredRepeat(undefined, "100", "check the logs", 2_000)).toBe(false);
  });
});

describe("endsWithQuestion", () => {
  it("looks at the last non-empty line only", () => {
    expect(endsWithQuestion("Logs purged.\nShall I restart it?")).toBe(true);
    expect(endsWithQuestion("Shall I restart it? Done anyway.\n")).toBe(true);
    expect(endsWithQuestion("Why did it fail? The disk was full.\nFixed.")).toBe(false);
    expect(endsWithQuestion("Done.")).toBe(false);
  });
});
