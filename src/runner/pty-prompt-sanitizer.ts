/**
 * Standalone prompt sanitiser for any path that writes user text to a PTY's
 * stdin. Lives in its own file (no `bun-pty` dependency) so non-PTY supervisor
 * paths — `process` / `process-stream-json` / `tmux` on Windows etc. — can
 * import the helper without forcing the native PTY module to load at startup
 * (Codex P1 on PR #149).
 */

// Constructed at module load so the source file contains no literal control
// chars (biome's `noControlCharactersInRegex` lint would otherwise fire on the
// intentional NUL/BS/DEL/etc. class).
const _ptyControlCharStrip = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]", "g");

/**
 * Strip control characters from a prompt string before writing to a PTY.
 *
 * - Embedded `\r` / `\n` are replaced with spaces. claude's TUI submits on
 *   any `\r` and treats `\n` similarly, so an embedded newline would submit
 *   the prompt mid-line — corrupting the turn or firing a stray submit
 *   before the supervisor's trailing CR.
 * - Other C0 controls + DEL (`\x00-\x08`, `\x0b-\x0c`, `\x0e-\x1f`, `\x7f`)
 *   are removed entirely. NUL terminates C-strings in the underlying FFI
 *   write path; BS / DEL act as inline-edit keystrokes in the TUI; BEL etc.
 *   are noisy. Tab (`\x09`) is preserved.
 * - C1 controls (`\x80-\x9f`, U+0080 to U+009F) are removed too. Some terminals
 *   read them as the 8-bit forms of ESC sequences (CSI is U+009B), so they can act
 *   as escape sequences without an ESC byte.
 */
export function sanitizePtyPromptText(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").replace(_ptyControlCharStrip, "");
}

/** First characters that make the REPL read a prompt as a command rather than text. */
const REPL_COMMAND_LEADERS = new Set(["/", "!", "#", "@"]);

/**
 * What the REPL skips before deciding what a prompt is: whitespace (JS `\s` includes
 * U+00A0, U+FEFF and the Unicode spaces), controls (so the check does not depend on the
 * sanitizer having run), U+0085, the zero-width marks, and the bidi controls (U+200E,
 * U+200F, U+202A to U+202E). Built from escapes so the source holds no literal control
 * characters.
 */
const LEADING_SKIPPABLE = new RegExp(
  "^[\\s\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\ufeff]*",
);

/**
 * Keep a prompt from being taken as a REPL command. The REPL treats a prompt that
 * starts with `/` as a slash command, `!` as a shell command (which bypasses the tool
 * deny lists), `#` as a memory note and `@` as a file mention. A prompt whose first
 * character that matters is one of those gets a single leading space.
 *
 * Apply it to the text that is actually written, after `sanitizePtyPromptText`: running
 * it before lets a leading control character hide the leader from the check and then be
 * stripped (`"\x00!id"` becomes `"!id"` on the wire).
 */
export function neutralizeLeadingReplCommand(text: string): string {
  const skipped = LEADING_SKIPPABLE.exec(text)?.[0].length ?? 0;
  const first = text[skipped];
  return first !== undefined && REPL_COMMAND_LEADERS.has(first) ? ` ${text}` : text;
}

/**
 * The only prompts allowed to reach the REPL as a command: `/compact`, alone or with
 * arguments on the same line, capped at 500 characters of arguments. An opt-out that
 * accepted any text would let a future caller pass arbitrary input through it.
 */
const ALLOWED_REPL_COMMAND = /^\/compact(?: [^\n]{0,500})?$/;

/**
 * U+FF20 FULLWIDTH COMMERCIAL AT: looks like `@`, is not the character the REPL expands.
 */
const FULLWIDTH_AT = "\uff20";

/**
 * Keep untrusted text from naming files. The REPL expands `@path` mentions anywhere in
 * a prompt, not only at the start, and does so itself rather than through a model tool
 * call, so `--tools ""` does not stop it. Apply to the text that is actually written
 * (after `sanitizePtyPromptText`), for untrusted prompts only: a trusted prompt may
 * legitimately mention a file.
 */
export function neutralizeFileMentions(text: string): string {
  return text.replaceAll("@", FULLWIDTH_AT);
}

/**
 * The inverse, for the model's reply: an untrusted prompt reaches the model with every `@`
 * as U+FF20, so a reply that quotes it (`@scope/pkg`, an e-mail address, a decorator) comes
 * back with U+FF20 too. A reply is never read as a prompt, so nothing expands it there. A
 * U+FF20 the model wrote on its own is mapped as well; that is the price of one rule.
 * Known limitation (#570 r12): a genuine U+FF20 in a reply comes back as `@`, and nothing here
 * can tell it from one we put there. Accepted; reversible escaping was considered and not built.
 */
export function restoreFileMentions(text: string): string {
  return text.replaceAll(FULLWIDTH_AT, "@");
}

export interface PtyPromptWriteOptions {
  /**
   * The caller is deliberately sending a REPL command. Honoured only when the sanitized
   * prompt is exactly an allowed command (`/compact`); anything else is neutralized.
   */
  allowReplCommand?: boolean;
}

/**
 * The single last transform before a prompt is written to the PTY: sanitize, then
 * neutralize a leading REPL-command character unless the caller opted out for an exactly
 * matching command.
 */
export function preparePtyPromptForWrite(text: string, opts: PtyPromptWriteOptions = {}): string {
  const sanitized = sanitizePtyPromptText(text);
  if (opts.allowReplCommand === true && ALLOWED_REPL_COMMAND.test(sanitized)) return sanitized;
  return neutralizeLeadingReplCommand(sanitized);
}
