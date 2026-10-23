/**
 * Fake `claude` TUIs for the PTY turn tests (#562 round 2).
 *
 * A turn now succeeds only on the session transcript, so a fake TUI has to WRITE one.
 * These build `/bin/sh` scripts that append JSONL lines to a transcript file the way the
 * CLI does, and paint (or not) whatever chrome a test wants on the screen. The screen and
 * the transcript are independent on purpose: most tests paint "done" chrome with nothing
 * in the transcript, or the reverse, to show which one decides.
 *
 * Nothing here gets acceptance from the prompt's own echo: the kernel's cooked-mode echo
 * stands in for claude's input box, and the prompts the tests send carry no marker phrase
 * unless the test is about forging one.
 *
 * Glyphs are octal (`/bin/sh` dash on CI: its printf has no `\xHH`).
 * ✻ \342\234\273  ·  \302\267  ●  \342\227\217  ◐ \342\227\220  ✳ \342\234\263
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Running chrome, as a real claude paints it while a turn runs. */
export const CHROME_BUSY =
  "\\033]0;\\342\\227\\220 Work\\007\\342\\234\\273 Working\\342\\200\\246\\n\\302\\267 esc to interrupt\\n";
/** Completion chrome: the done summary and the idle ✳ title. */
export const CHROME_DONE =
  "\\033]0;\\342\\234\\263 Work\\007\\342\\234\\273 Saut\\303\\251ed for 2s \\302\\267 done 16:40\\n";
/** What a resumed session repaints: the previous turn's answer and its idle chrome. */
export const CHROME_STALE =
  "\\n\\342\\227\\217 OLD-ANSWER-R15x\\n\\342\\234\\273 Saut\\303\\251ed for 1s \\302\\267 done 16:36\\n shift+tab to cycle\\n";

export interface TempTranscript {
  dir: string;
  path: string;
  cleanup(): void;
}

/** A transcript path in a fresh temp dir (the file itself is created by the fake). */
export function tempTranscript(): TempTranscript {
  const dir = mkdtempSync(join(tmpdir(), "pty-tx-"));
  return {
    dir,
    path: join(dir, "session.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** JSON → a single-quoted `/bin/sh` word. JSON holds no single quote unless the text does. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function userLine(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

export function enqueueLine(content: string): string {
  return JSON.stringify({ type: "queue-operation", operation: "enqueue", content });
}

export function assistantLine(
  text: string,
  opts: { id?: string; stop?: string | null; blocks?: unknown[] } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: opts.id ?? "msg_1",
      role: "assistant",
      model: "claude-test",
      content: opts.blocks ?? [{ type: "text", text }],
      stop_reason: opts.stop === undefined ? "end_turn" : opts.stop,
    },
  });
}

export function systemLine(subtype: string, content?: string): string {
  return JSON.stringify({ type: "system", subtype, ...(content ? { content } : {}) });
}

/** `/bin/sh` fragment appending one transcript line (a complete line, newline included). */
export function append(path: string, line: string): string {
  return `printf '%s\\n' ${shq(line)} >> ${shq(path)}`;
}

/** A fragment appending raw bytes with NO newline added (to tear a line across polls). */
export function appendRaw(path: string, bytes: string): string {
  return `printf '%s' ${shq(bytes)} >> ${shq(path)}`;
}

export interface FakeTurn {
  tx: string;
  /** The prompt the test will send (the transcript's user entry carries it). */
  prompt: string;
  answer: string;
  /** Screen chrome painted before the answer; default {@link CHROME_BUSY}. */
  busy?: string;
  /** Screen chrome painted after the answer; default {@link CHROME_DONE}. */
  done?: string;
  /** Seconds between the user entry and the assistant entry. */
  think?: number;
}

/**
 * Read the paste line, record the user entry, think, record the assistant reply, painting
 * chrome around it. The caller appends `exec cat` or `sleep` to keep the process alive.
 */
export function fakeTurn(t: FakeTurn): string {
  return [
    "IFS= read -r l",
    `printf '${t.busy ?? CHROME_BUSY}'`,
    append(t.tx, userLine(t.prompt)),
    `sleep ${t.think ?? 0.15}`,
    append(t.tx, assistantLine(t.answer)),
    // The real CLI writes `turn_duration` right after the final message (every capture in
    // docs/spikes/fixtures does); it is what ends the turn, not the message itself.
    append(t.tx, systemLine("turn_duration")),
    `printf '\\342\\227\\217 ${t.answer.replace(/'/g, "")}\\n'`,
    `printf '${t.done ?? CHROME_DONE}'`,
  ].join("; ");
}
