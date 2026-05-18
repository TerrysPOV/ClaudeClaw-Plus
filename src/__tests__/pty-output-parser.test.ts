/**
 * Tests for the sentinel-echo PTY output parser (issue #81 rewrite).
 *
 * The parser owns the byte-stream state machine that detects turn boundaries
 * by writing a unique sentinel into claude's input buffer after a quiet
 * window and watching for the echo. These tests exercise the synthetic API
 * directly plus a real fixture captured against claude 2.1.89 on Hetzner.
 */
import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  createParser,
  startTurn,
  feed,
  tick,
  markSentinelWritten,
  resetTurn,
  buildSentinel,
  encodeSentinel,
  stripAnsi,
  normaliseNewlines,
  extractResponseText,
  decodeTurn,
  DEFAULT_QUIET_WINDOW_MS,
  type ParserEvent,
} from "../runner/pty-output-parser";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", ".planning", "pty-migration", "fixtures");
const FIXTURE_BIN = join(FIXTURE_DIR, "sentinel-turn-sample.bin");
const FIXTURE_MARKERS = join(FIXTURE_DIR, "sentinel-turn-sample.markers.json");

// ─── Synthetic flow tests (single + multi turn) ──────────────────────────────

describe("pty-output-parser — sentinel flow (synthetic)", () => {
  // Issue #87 regression: pre-fix, `quiet` could fire after `startTurn` even
  // though zero response bytes had arrived. The 500ms quiet window expired
  // between the prompt write and claude's first ack-echo (~500–800ms on
  // claude 2.1.89). The supervisor wrote the sentinel prematurely; claude's
  // TUI echoed the sentinel keystrokes back fast; sentinel-found fired;
  // runTurn returned with only the TUI splash + prompt-echo bytes as the
  // "response" — model output never had a chance to arrive.
  test("issue #87: quiet does NOT fire until at least one byte has arrived since startTurn", () => {
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-87";
    const sentinelBytes = encodeSentinel(buildSentinel(uuid));

    let now = 1000;
    // Pre-turn data exists in the stream (e.g. TUI banner from spawn).
    feed(parser, new TextEncoder().encode("pre-turn banner bytes"), now);
    expect(parser.state).toBe("idle");

    startTurn(parser, uuid, sentinelBytes, now);
    expect(parser.state).toBe("accumulating");
    expect(parser.sawByteSinceTurnStart).toBe(false);

    // The quiet window elapses with ZERO bytes since startTurn (claude has
    // received the prompt but hasn't started emitting its response yet).
    // Pre-fix this would emit `quiet`; post-fix it must not.
    now += 200;
    expect(tick(parser, now)).toEqual([]);

    // Even after several elapsed quiet windows, still no `quiet` — we need
    // an actual response byte before the parser will conclude "claude is
    // silent because it's done responding".
    now += 5000;
    expect(tick(parser, now)).toEqual([]);

    // First response byte arrives. Now the quiet window can be counted.
    feed(parser, new TextEncoder().encode("a"), now);
    expect(parser.sawByteSinceTurnStart).toBe(true);

    // Within the quiet window after that byte → still no quiet.
    expect(tick(parser, now + 50)).toEqual([]);

    // After the quiet window → quiet fires.
    const qEvs = tick(parser, now + 200);
    expect(qEvs.length).toBe(1);
    expect(qEvs[0]!.type).toBe("quiet");
  });

  test("happy path: prompt → response → quiet → sentinel echo → complete", () => {
    const enc = new TextEncoder();
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-test-1";
    const sentinel = buildSentinel(uuid);
    const sentinelBytes = encodeSentinel(sentinel);

    let now = 1000;
    // Pre-turn TUI noise should be ignored (parser is `idle`).
    feed(parser, enc.encode("[TUI init banner]\n"), now);
    expect(parser.state).toBe("idle");

    // Start the turn — equivalent to the supervisor having just written the
    // user prompt + \r.
    const startEv = startTurn(parser, uuid, sentinelBytes, now);
    expect(startEv).toEqual({ type: "turn-start", offset: parser.totalBytes });
    expect(parser.state).toBe("accumulating");

    // Response trickles in.
    now += 10;
    expect(feed(parser, enc.encode("ack"), now)).toEqual([]);
    expect(parser.state).toBe("accumulating");

    // tick fires before the quiet window elapses → no event.
    expect(tick(parser, now + 50)).toEqual([]);

    // Quiet window elapses → quiet event.
    now += 200;
    const qEvs = tick(parser, now);
    expect(qEvs.length).toBe(1);
    expect(qEvs[0]!.type).toBe("quiet");

    // Tick again in the same quiet period → no duplicate emission.
    expect(tick(parser, now + 10)).toEqual([]);

    // Supervisor writes the sentinel → markSentinelWritten flips state.
    markSentinelWritten(parser);
    expect(parser.state).toBe("awaiting-sentinel");

    // Claude echoes the sentinel back.
    now += 30;
    const echoEvs = feed(parser, sentinelBytes, now);
    expect(echoEvs.length).toBe(1);
    expect(echoEvs[0]!.type).toBe("sentinel-found");
    if (echoEvs[0]!.type === "sentinel-found") {
      expect(echoEvs[0]!.uuid).toBe(uuid);
    }
    expect(parser.state).toBe("complete");
  });

  test("quiet event is debounced: new bytes after quiet reset the emitter", () => {
    const enc = new TextEncoder();
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-debounce";
    const sentinelBytes = encodeSentinel(buildSentinel(uuid));

    let now = 1000;
    startTurn(parser, uuid, sentinelBytes, now);
    feed(parser, enc.encode("first chunk"), now);

    // Quiet window elapses → quiet fires.
    now += 200;
    expect(tick(parser, now).length).toBe(1);

    // More bytes arrive — quietEmitted resets.
    now += 10;
    feed(parser, enc.encode("more bytes"), now);
    expect(parser.state).toBe("accumulating");
    expect(parser.quietEmitted).toBe(false);

    // Quiet fires again after another quiet window.
    now += 200;
    expect(tick(parser, now).length).toBe(1);
  });

  test("sentinel scanning only activates after markSentinelWritten()", () => {
    // The fixture: claude legitimately emits a string that LOOKS like our
    // sentinel BEFORE we wrote it. This must NOT be matched (impossible in
    // practice with a fresh UUID per turn, but defensive).
    const enc = new TextEncoder();
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-no-premature-match";
    const sentinel = buildSentinel(uuid);
    const sentinelBytes = encodeSentinel(sentinel);

    startTurn(parser, uuid, sentinelBytes, 1000);

    // Feed the sentinel string before writing it. State should stay
    // `accumulating`.
    const evs = feed(parser, enc.encode(`prefix ${sentinel} suffix`), 1010);
    expect(evs).toEqual([]);
    expect(parser.state).toBe("accumulating");

    // Now activate scanning. The sentinel must arrive AGAIN to be detected.
    markSentinelWritten(parser);
    const evs2 = feed(parser, enc.encode(`more text ${sentinel}`), 1020);
    expect(evs2.length).toBe(1);
    expect(evs2[0]!.type).toBe("sentinel-found");
  });

  test("sentinel straddling chunk boundary is detected", () => {
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-straddle";
    const sentinelBytes = encodeSentinel(buildSentinel(uuid));

    startTurn(parser, uuid, sentinelBytes, 1000);
    markSentinelWritten(parser);

    // Split the sentinel across two feed calls.
    const split = 7;
    const evs1 = feed(parser, sentinelBytes.slice(0, split), 1010);
    expect(evs1).toEqual([]);

    const evs2 = feed(parser, sentinelBytes.slice(split), 1020);
    expect(evs2.length).toBe(1);
    expect(evs2[0]!.type).toBe("sentinel-found");
  });

  test("multiple turns reset cleanly between calls", () => {
    const enc = new TextEncoder();
    const parser = createParser({ quietWindowMs: 100 });

    // Turn 1.
    const u1 = "uuid-turn-1";
    const s1Bytes = encodeSentinel(buildSentinel(u1));
    startTurn(parser, u1, s1Bytes, 1000);
    feed(parser, enc.encode("first response"), 1010);
    markSentinelWritten(parser);
    const t1End = feed(parser, s1Bytes, 1020);
    expect(t1End[0]!.type).toBe("sentinel-found");
    expect(parser.state).toBe("complete");

    resetTurn(parser);
    expect(parser.state).toBe("idle");

    // Turn 2 with a different UUID. The old sentinel must NOT match.
    const u2 = "uuid-turn-2";
    const s2Bytes = encodeSentinel(buildSentinel(u2));
    startTurn(parser, u2, s2Bytes, 2000);
    feed(parser, enc.encode("second response"), 2010);
    markSentinelWritten(parser);

    // Feed the OLD sentinel — must not match.
    const stale = feed(parser, s1Bytes, 2020);
    expect(stale).toEqual([]);
    expect(parser.state).toBe("awaiting-sentinel");

    // Now feed the new one.
    const t2End = feed(parser, s2Bytes, 2030);
    expect(t2End.length).toBe(1);
    expect(t2End[0]!.type).toBe("sentinel-found");
    if (t2End[0]!.type === "sentinel-found") {
      expect(t2End[0]!.uuid).toBe(u2);
    }
  });

  test("byte-by-byte feed produces the same final state as one-shot", () => {
    const enc = new TextEncoder();
    const uuid = "uuid-bbb";
    const sentinelBytes = encodeSentinel(buildSentinel(uuid));

    // One-shot baseline.
    const baseline = createParser({ quietWindowMs: 100 });
    startTurn(baseline, uuid, sentinelBytes, 1000);
    feed(baseline, enc.encode("response text..."), 1010);
    markSentinelWritten(baseline);
    feed(baseline, sentinelBytes, 1020);

    // Byte-by-byte.
    const bbb = createParser({ quietWindowMs: 100 });
    startTurn(bbb, uuid, sentinelBytes, 1000);
    const r1 = enc.encode("response text...");
    for (let i = 0; i < r1.length; i++) feed(bbb, r1.slice(i, i + 1), 1010);
    markSentinelWritten(bbb);
    const r2 = sentinelBytes;
    const events: ParserEvent[] = [];
    for (let i = 0; i < r2.length; i++) events.push(...feed(bbb, r2.slice(i, i + 1), 1020));

    expect(bbb.state).toBe(baseline.state);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("sentinel-found");
  });

  test("default quiet window is exposed and used when not overridden", () => {
    const parser = createParser();
    expect(parser.quietWindowMs).toBe(DEFAULT_QUIET_WINDOW_MS);
  });

  test("tick before turn-start is a no-op", () => {
    const parser = createParser({ quietWindowMs: 100 });
    expect(tick(parser, 999_999)).toEqual([]);
    expect(parser.state).toBe("idle");
  });

  test("resetTurn after sentinel-found is safe and preserves totalBytes", () => {
    const enc = new TextEncoder();
    const parser = createParser({ quietWindowMs: 100 });
    const uuid = "uuid-reset";
    const sentinelBytes = encodeSentinel(buildSentinel(uuid));

    feed(parser, enc.encode("pre-turn-noise"), 999);
    const totalBefore = parser.totalBytes;

    startTurn(parser, uuid, sentinelBytes, 1000);
    feed(parser, enc.encode("body"), 1010);
    markSentinelWritten(parser);
    feed(parser, sentinelBytes, 1020);

    const totalAfter = parser.totalBytes;
    expect(totalAfter).toBeGreaterThan(totalBefore);

    resetTurn(parser);
    expect(parser.state).toBe("idle");
    expect(parser.totalBytes).toBe(totalAfter);
    expect(parser.pendingBaseOffset).toBe(totalAfter);
  });
});

// ─── Golden fixture (real claude 2.1.89 capture from Hetzner) ────────────────
//
// The fixture is captured by `scripts/capture-sentinel-fixture.ts` running
// against the production daemon's claude binary. It records the raw byte
// stream from a single PTY session, plus a JSON markers file recording the
// exact byte offsets of: prompt write, quiet trigger, sentinel write,
// sentinel echo detection, capture end.

describe("pty-output-parser — golden fixture (claude 2.1.89)", () => {
  test("parser locates the sentinel echo at the marker offset", async () => {
    const exists = await Bun.file(FIXTURE_BIN).exists();
    if (!exists) {
      // Fixture not captured yet — surface as a soft skip with a clear
      // message rather than a hard fail. The capture script lives at
      // scripts/capture-sentinel-fixture.ts and must be run against a live
      // claude 2.1.89 install (see README "PTY fixture capture").
      console.warn(
        `[pty-output-parser.test] skipping golden fixture — ${FIXTURE_BIN} not present.`,
      );
      return;
    }

    const bytes = await Bun.file(FIXTURE_BIN).bytes();
    const markers = JSON.parse(await Bun.file(FIXTURE_MARKERS).text()) as {
      sentinel: string;
      promptWrite: number;
      sentinelWrite: number;
      sentinelEchoFound: number;
      totalBytes: number;
    };

    const sentinelBytes = encodeSentinel(markers.sentinel);
    const parser = createParser({ quietWindowMs: 500 });

    // Feed bytes up to promptWrite as pre-turn noise.
    feed(parser, bytes.slice(0, markers.promptWrite), 1000);
    expect(parser.state).toBe("idle");

    // Begin the turn.
    const uuid = markers.sentinel.replace("<<<CCAW_TURN_END_", "").replace(">>>", "");
    startTurn(parser, uuid, sentinelBytes, 1000);
    expect(parser.state).toBe("accumulating");

    // Feed bytes from promptWrite to sentinelWrite — these are the
    // assistant's response. No events fire because we haven't activated
    // sentinel scanning yet.
    feed(parser, bytes.slice(markers.promptWrite, markers.sentinelWrite), 2000);

    // Activate sentinel scanning.
    markSentinelWritten(parser);

    // Feed the rest of the stream — the sentinel echo MUST be detected.
    const tail = bytes.slice(markers.sentinelWrite);
    const events: ParserEvent[] = [];
    // Chunk it into 256-byte slices to exercise the carry-over logic.
    for (let i = 0; i < tail.length; i += 256) {
      events.push(...feed(parser, tail.slice(i, i + 256), 3000 + i));
    }

    const found = events.filter((e) => e.type === "sentinel-found");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(parser.state).toBe("complete");
  });
});

// ─── ANSI strip + response extraction ────────────────────────────────────────

describe("stripAnsi", () => {
  test("strips CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
    expect(stripAnsi("\x1b[1;31;47mboth\x1b[m")).toBe("both");
  });

  test("strips OSC sequences (BEL terminator)", () => {
    expect(stripAnsi("\x1b]0;window title\x07after")).toBe("after");
  });

  test("strips OSC sequences (ESC backslash terminator)", () => {
    expect(stripAnsi("\x1b]0;title\x1b\\after")).toBe("after");
  });

  test("preserves emoji and box-drawing characters", () => {
    const input = "\x1b[32mhello 🌟 ─── ⏺ack box: ┌─┐ │ │ └─┘\x1b[0m";
    const out = stripAnsi(input);
    expect(out).toBe("hello 🌟 ─── ⏺ack box: ┌─┐ │ │ └─┘");
  });

  test("preserves Unicode multi-byte characters around stripped sequences", () => {
    const input = "日本語 \x1b[1mtext\x1b[0m 中文";
    expect(stripAnsi(input)).toBe("日本語 text 中文");
  });

  // Regression for #119: claude's TUI (2.1.140+) emits `\x1B[1C` (cursor
  // forward) between words instead of literal U+0020. Without the
  // pre-pass these "spaces" vanished with the CSI stripper, producing
  // body text like "Reviewpendingtasks,reminders,...".
  test("recovers inter-word spaces from CUF sequences (regression for #119)", () => {
    const input = "\x1b[38;2;116;199;236mOpus\x1b[1C4.7\x1b[1C(1M\x1b[1Ccontext)\x1b[39m";
    expect(stripAnsi(input)).toBe("Opus 4.7 (1M context)");
  });

  test("converts \\x1B[C (no count) to a single space", () => {
    expect(stripAnsi("foo\x1b[Cbar")).toBe("foo bar");
  });

  test("expands CUF with explicit count to that many spaces", () => {
    expect(stripAnsi("left\x1b[5Cright")).toBe("left     right");
  });

  test("caps pathological CUF counts to avoid runaway whitespace", () => {
    // \x1B[9999C would otherwise produce ~10kB of spaces per occurrence;
    // the cap keeps capture sizes bounded for malformed input.
    const out = stripAnsi("a\x1b[9999Cb");
    // 128-space cap from CUF_MAX_SPACES.
    expect(out).toBe(`a${" ".repeat(128)}b`);
  });
});

describe("normaliseNewlines", () => {
  test("converts CRLF to LF and drops bare CR", () => {
    expect(normaliseNewlines("a\r\nb\rc\nd")).toBe("a\nbc\nd");
  });
});

describe("extractResponseText", () => {
  test("extracts text after a line-anchored `⏺ ` and before terminator sigil", () => {
    const text = "garbage\n⏺ hello world✻ Worked for 2s\n more";
    expect(extractResponseText(text)).toBe("hello world");
  });

  // The marker must be at line-start and followed by a space — this is
  // exactly how claude's TUI prints the assistant message. A bare `⏺` or
  // `●` embedded inside a TUI element (e.g. the ClaudeClaw+ status box
  // row `│ ● live │ 🎮 │`) MUST NOT be picked up; pre-fix that bug
  // caused the captured "response" to be the TUI footer (everything from
  // the status-box marker onwards) instead of the model output.
  test("ignores `●` not at line-start (e.g. inside the ClaudeClaw+ status-box row)", () => {
    // Realistic shape: response marker, then the `─` separator the TUI
    // prints before re-rendering the input area, then the status box
    // which contains another `●` we MUST NOT pick up.
    const text = [
      "● Pong 🏓",
      "",
      "─".repeat(50),
      '❯ Try "how do I log an error?"',
      "─".repeat(50),
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
      "╭────── 🦞 ClaudeClaw+ 🦞 ──────╮",
      "│ 📋 7 jobs │ ● live │ 🎮 │",
      "╰───────────────────────────────╯",
    ].join("\n");
    expect(extractResponseText(text)).toBe("Pong 🏓");
  });

  test("uses the LAST line-anchored marker (response area, not echoed prompt)", () => {
    const text = "⏺ nope ✻done\n⏺ yes✻";
    expect(extractResponseText(text)).toBe("yes");
  });

  test("falls back to whole text when ⏺ absent", () => {
    expect(extractResponseText("  some text  ")).toBe("some text");
  });

  // Codex Phase D #4 regression: a literal `❯` inside the assistant response
  // (e.g. a shell-prompt example) must NOT split the response. Spinner glyphs
  // remain the only terminators.
  test("does not truncate when response contains a literal `❯` glyph", () => {
    const text =
      "⏺ Try running `❯ bun install` in your shell and then re-run the build.✻ Worked for 1s";
    expect(extractResponseText(text)).toBe(
      "Try running `❯ bun install` in your shell and then re-run the build.",
    );
  });

  test("does not truncate when `❯` appears mid-sentence without a spinner", () => {
    const text = "⏺ The prompt looked like `user@host ❯` when I tested it.";
    expect(extractResponseText(text)).toBe(
      "The prompt looked like `user@host ❯` when I tested it.",
    );
  });

  // Issue #87 follow-up: claude 2.1.89 emits `●` (U+25CF BLACK CIRCLE)
  // rather than `⏺` (U+23FA RECORD). Pre-fix, lastIndexOf("⏺") returned
  // -1 and we fell back to the WHOLE stripped buffer — captures leaked
  // TUI splash, prompt-echo, and footer into the response shown to the
  // user (Discord/Telegram).
  test("recognises `●` (U+25CF) as the assistant marker (claude 2.1.89)", () => {
    const text = 'garbage\n● Pong 🏓\n────────────\n❯ Try "..."';
    expect(extractResponseText(text)).toBe("Pong 🏓");
  });

  test("real-world claude 2.1.89 turn: banner + prompt-echo + response + footer", () => {
    // Verbatim shape captured from Hetzner (ANSI stripped). The marker
    // before the model response is `●`, and the divider that follows is
    // 100 horizontal-line chars before the next TUI input prompt.
    const text = [
      "▐▛███▜▌ Claude Code v2.1.89",
      "▝▜█████▛▘ Sonnet 4.6 · Claude Max",
      "▘▘ ▝▝   ~/project",
      "",
      "❯ [2026-05-16 18:33:59 UTC+1]",
      "[Discord Channel: 1488536365477138602]",
      "Message: Ping",
      "",
      "● Pong 🏓",
      "",
      "─".repeat(100),
      '❯ Try "how do I log an error?"',
      "─".repeat(100),
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(extractResponseText(text)).toBe("Pong 🏓");
  });

  test("uses the LAST marker even when both `●` and `⏺` appear", () => {
    // Defensive: if a future claude version mixes both, the most recent
    // marker is the one that introduces the assistant response.
    const text = "⏺ earlier\n● later✻";
    expect(extractResponseText(text)).toBe("later");
  });

  test("multi-line response is preserved until divider", () => {
    const text = `● Line one\nLine two\nLine three\n${"─".repeat(50)}\n❯ Try "next"`;
    expect(extractResponseText(text)).toBe("Line one\nLine two\nLine three");
  });

  test("a short horizontal-line run (<4) is NOT a terminator", () => {
    // 3 chars of ─ inside response (e.g. a markdown table) must not split.
    const text = "● A row: ─ ─ ─ that crosses cells.";
    expect(extractResponseText(text)).toBe("A row: ─ ─ ─ that crosses cells.");
  });

  // Hetzner-discovered shape: claude's TUI re-renders the entire screen
  // for every turn, so a turn-2 capture contains the FULL conversation
  // history (banner, turn-1 prompt + response, turn-2 prompt + response)
  // followed by the input area re-render and the ClaudeClaw+ status box.
  // The extractor must find the LATEST line-anchored marker (turn 2's
  // response) and stop at the next divider — ignoring both turn 1's
  // marker AND the status-box `●`.
  //
  // Note: claude 2.1.89 emits `●Pong` (no space) for short single-token
  // responses after ANSI strip. The marker regex accepts an optional
  // space after the marker glyph.
  test("multi-turn TUI re-render: picks the LATEST `●` response, not turn-1's or the status-box `●`", () => {
    const banner = [
      "▐▛███▜▌ Claude Code v2.1.89",
      "▝▜█████▛▘ Sonnet 4.6 · Claude Max",
      "▘▘ ▝▝   ~/project",
    ].join("\n");
    const turn1 = [
      "❯ [2026-05-16 18:33:59 UTC+1]",
      "[Discord Channel: 1488536365477138602]",
      "Message: Ping",
      "",
      "●Pong 🏓",
    ].join("\n");
    const turn2 = [
      "❯ [2026-05-16 19:51:02 UTC+1]",
      "[Discord Channel: 1488536365477138602]",
      "Message: Ping",
      "",
      "●Pong",
    ].join("\n");
    const footer = [
      "",
      "─".repeat(100),
      '❯ Try "write a test for reprocess-clippings.py"',
      "─".repeat(100),
      "⏵⏵ bypass permissions on (shift+tab to cycle) /buddy",
      "╭────── 🦞 ClaudeClaw+ 🦞 ──────╮",
      "│ 📋 7 jobs │ ● live │ 🎮 │",
      "╰───────────────────────────────╯",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    const fullScreen = [banner, "", turn1, "", turn2, footer].join("\n");

    expect(extractResponseText(fullScreen)).toBe("Pong");
  });
});

describe("decodeTurn", () => {
  test("decodes a UTF-8 byte slice and extracts the response", () => {
    const enc = new TextEncoder();
    const bytes = enc.encode("\x1b]0;title\x07⏺ hello there✻ Worked for 1s");
    const { stripped, text } = decodeTurn(bytes);
    expect(stripped).toBe("⏺ hello there✻ Worked for 1s");
    expect(text).toBe("hello there");
  });
});
