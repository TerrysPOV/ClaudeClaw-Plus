/**
 * Band-aid for #105 — see the call site in `run()` for full context.
 *
 * Constrains the model's user-facing reply to plain prose so the PTY
 * sentinel-echo parser can extract textual content rather than TUI box
 * chrome from rendered markdown blocks. Temporary; remove with the PTY
 * runtime when the Bus runtime (epic #107, spec PR #106) becomes default.
 */
export const PTY_OUTPUT_FORMAT_CONSTRAINT = [
  "OUTPUT FORMAT CONSTRAINT (response surface limitation):",
  "Your final user-facing reply MUST be plain prose. The reply is captured through a text-only transport that cannot render markdown.",
  "Do NOT use in your final reply:",
  "  - Backtick code fences (```...``` or single `...`) — write paths and commands plainly, e.g. /home/x/file.png NOT `/home/x/file.png`",
  "  - Markdown bullets (`*`, `-`, `+`) at the start of lines",
  "  - Numbered list items (`1.`, `2.`)",
  "  - Block quotes (`>` at start of lines)",
  "  - Horizontal rules (`---`)",
  "This constraint applies ONLY to your final response text. You may still use markdown freely inside tool inputs and internal reasoning.",
].join("\n");
