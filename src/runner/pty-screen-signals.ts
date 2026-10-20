/**
 * What a CI log may say about a PTY screen: flags, fixed reason names and counts, never a
 * character of the text. The repo is public, so its CI logs are public, and no redaction of
 * arbitrary terminal text can be complete (#570 r14d, M1). The integration harness prints only
 * the object this returns.
 */

import { BLOCKED_BOOT_SCREENS, REPL_FOOTER } from "./pty-process.js";

export interface ScreenSignals {
  /** Non-blank lines in the captured text. */
  lines: number;
  permissionPrompt: boolean;
  errorBanner: boolean;
  spinner: boolean;
  /** Name of the first blocked boot screen the text matches, else "none". */
  blocked: string;
  /** The idle REPL footer is on screen. */
  ready: boolean;
}

/** Flags are computed on the whole text, so one sensitive word cannot hide a line. */
export function screenSignals(raw: string): ScreenSignals {
  const text = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-40)
    .join("\n");
  return {
    lines: text === "" ? 0 : text.split("\n").length,
    permissionPrompt: /do you want|allow (?:this|once)|approve|\(y\/n\)|1\. yes/i.test(text),
    errorBanner: /error|failed|unable to|rate limit|overloaded|invalid/i.test(text),
    spinner: /esc to interrupt|thinking|[✻✽✶✳✢]/i.test(text),
    blocked: BLOCKED_BOOT_SCREENS.find(([, pattern]) => pattern.test(text))?.[0] ?? "none",
    ready: REPL_FOOTER.test(text),
  };
}

/** The one CI line for a captured screen. Built only from `ScreenSignals` and fixed words. */
export function screenLogLine(label: string, source: string, signals: ScreenSignals): string {
  return `[isolation-spike] screen-signals ${label}: ${JSON.stringify(signals)}; source=${source}`;
}

/**
 * The words a CI line may carry for a field the child writes: a fixed list, and "other" for
 * anything else. A character filter is not a vocabulary: it passes any short plain word, so a
 * child that wrote a marker into a `type` would have printed it (#570 r14e, M1).
 */
export const TRANSCRIPT_RECORD_TYPES = [
  "user",
  "assistant",
  "system",
  "attachment",
  "ai-title",
  "cost-state",
] as const;
export const WIRE_EVENT_TYPES = [
  "system",
  "assistant",
  "user",
  "rate_limit_event",
  "result",
] as const;
export const STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
] as const;
export const BLOCK_TYPES = [
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
] as const;
export const RESULT_SUBTYPES = [
  "success",
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
] as const;

/** `value` when it is exactly one word of `vocabulary`, else the fixed word "other". */
export function fixedWord(value: unknown, vocabulary: readonly string[]): string {
  return typeof value === "string" && vocabulary.includes(value) ? value : "other";
}

/** `true` or `false` only for the booleans themselves; anything else the child wrote is "other". */
export function boolWord(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "other";
}

/** The `--output-format stream-json` events of a print call, as the counts and words a CI line may carry. */
export function wireSummary(events: readonly Record<string, unknown>[]): {
  events: Record<string, number>;
  resultSubtype: string;
  resultIsError: string;
} {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const kind = fixedWord(event.type, WIRE_EVENT_TYPES);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const done = events.find((event) => event.type === "result");
  return {
    events: counts,
    resultSubtype: fixedWord(done?.subtype, RESULT_SUBTYPES),
    resultIsError: boolWord(done?.is_error),
  };
}

/** Words a config path segment may carry in a CI line: short and plain, or the fixed word "other". */
const CONFIG_PATH_WORD = /^[A-Za-z0-9_.<>-]{1,32}$/;

/**
 * A path segment of the throwaway config root, kept only when it is a short plain word. For
 * `shapeSummary` and nothing sourced from the child's own output (that is `fixedWord`).
 */
export function configPathWord(value: unknown): string {
  const text = String(value);
  return CONFIG_PATH_WORD.test(text) ? text : "other";
}

/** The classifier action, as one of the words the harness knows: `hire`, any other (`other`), or `none`. */
export function actionWord(action: string | undefined): string {
  if (action === undefined) return "none";
  return action === "hire" ? "hire" : "other";
}

/** An error as an errno code or class name, stripped to plain characters. Never its message. */
export function errorWord(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "error";
  return (
    String(code)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 32) || "error"
  );
}

/** argv for a CI line: prompt text (`--system-prompt`, `--append-system-prompt`) becomes its length. */
export function argvShape(args: readonly string[]): string[] {
  return args.map((arg, i) =>
    /^--(append-)?system-prompt$/.test(args[i - 1] ?? "") ? `<${arg.length} chars>` : arg,
  );
}

/** A production warning line with the names of throwaway directories removed. */
export function withoutDirNames(line: string): string {
  return line.replace(/\bclaudeclaw-oneshot-[A-Za-z0-9-]+/g, "<dir>");
}
