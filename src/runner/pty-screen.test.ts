import { describe, expect, it } from "bun:test";
import { Screen } from "./pty-screen.js";

/** #570 r13 (E): the screen as it is now, rebuilt from the bytes a PTY child wrote. */

const screenOf = (...chunks: string[]): string => {
  const screen = new Screen(40, 6);
  for (const chunk of chunks) screen.feed(chunk);
  return screen.text();
};

describe("Screen", () => {
  it("shows plain lines", () => {
    expect(screenOf("one\r\ntwo\r\n")).toBe("one\ntwo");
  });

  it("drops what a clear-screen wiped, and shows what was drawn after it", () => {
    expect(screenOf("Select login method:\r\n", "\x1b[2J\x1b[H", "ready\r\n")).toBe("ready");
  });

  it("erases a line and redraws it in place (cursor up, erase line)", () => {
    expect(screenOf("Not logged in\r\n", "\x1b[1A\x1b[2K\r", "all good\r\n")).toBe("all good");
  });

  it("erases from the cursor to the end of the line, and from the cursor down", () => {
    expect(screenOf("abcdef\x1b[3D\x1b[K")).toBe("abc");
    expect(screenOf("a\r\nb\r\nc\x1b[2;1H\x1b[J")).toBe("a");
  });

  it("places text by absolute cursor position, and renders a gap as a space", () => {
    expect(screenOf("\x1b[2;5Hhi")).toBe("\n    hi");
    expect(screenOf("tab\x1b[4Cto\x1b[12Gcycle")).toBe("tab    to  cycle");
  });

  it("ignores colours and other escape sequences, and OSC titles", () => {
    expect(screenOf("\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok \x1b(Bdone")).toBe("red ok done");
  });

  it("finishes an escape sequence that a chunk ended in the middle of", () => {
    expect(screenOf("login\x1b[", "2J\x1b[H", "fresh")).toBe("fresh");
    expect(screenOf("x\x1b]0;ti", "tle\x07y")).toBe("xy");
  });

  it("scrolls: a line that has gone off the top is no longer on the screen", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line${i}\r\n`).join("");
    const text = screenOf(lines);
    expect(text).not.toContain("line0");
    expect(text).toContain("line7");
  });

  it("wraps at the right edge", () => {
    expect(screenOf("x".repeat(45))).toBe(`${"x".repeat(40)}\n${"x".repeat(5)}`);
  });

  it("treats the alternate screen as a fresh one", () => {
    expect(screenOf("login\r\n", "\x1b[?1049h", "repl")).toBe("repl");
  });

  it("saves and restores the cursor", () => {
    expect(screenOf("ab\x1b7\r\ncd\x1b8X")).toBe("abX\ncd");
  });
});
