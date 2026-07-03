// Markdown → Telegram HTML conversion (ported from nanobot).
//
// Telegram does not render the GitHub-flavored markdown Claude emits. Sending
// raw text leaves `**bold**`, backticks, links, etc. visible as literal markup
// (issue: bus adapter delivered unformatted text). Converting to Telegram's
// HTML parse mode — a small, supported tag set (b/i/u/s/code/pre/a) — renders
// correctly. Unsupported constructs (headers, blockquotes, lists) are flattened
// rather than dropped.
//
// Single source of truth for this conversion: both the bus adapter and the
// legacy `commands/telegram.ts` path import this function, so the two paths
// can't drift apart.

export function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML special characters
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links [text](url) — before bold/italic to handle nested cases. Function
  //    replacer (not a string) so `$`-sequences in the URL/label aren't treated
  //    as replacement patterns, and the URL's `"` is attribute-escaped.
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
  );

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic *text* (after bold consumed **…**) and _text_.
  //    *…*: opening not preceded by word/asterisk, not followed by whitespace,
  //    so bullet markers ("* item") and stray asterisks are left alone.
  text = text.replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, "<i>$1</i>");
  //    _…_: avoid matching inside words like some_var_name.
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // 11. Restore inline code with HTML tags
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Function replacer: a string 2nd arg would interpret `$&`/`$'`/`` $` ``/`$$`
    // in `escaped`, corrupting the code (splicing the match / rest of the string).
    text = text.replace(`\x00IC${i}\x00`, () => `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks with HTML tags
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i]
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Function replacer — same `$`-sequence hazard as the inline-code restore.
    text = text.replace(`\x00CB${i}\x00`, () => `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

// Telegram returns HTTP 400 for MANY reasons; only some mean "the HTML you sent
// was malformed". This matches ONLY the parse/entity failures — so a caller can
// retry as plain text for those, and NOT downgrade a correctly-formatted message
// to raw markdown on a benign 400 like "message is not modified" / "message to
// edit not found" (or a 429 flood). See the Telegram Bot API error strings.
const HTML_PARSE_ERROR_RE =
  /can't parse entities|can't find end tag|unsupported start tag|unclosed|reserved|byte offset|entity/i;

export function isTelegramHtmlParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Must be a 400 AND look like an entity/tag parse failure. `api.ts` surfaces
  // the Telegram `description` in the thrown message so this can discriminate.
  return / 400\b/.test(msg) && HTML_PARSE_ERROR_RE.test(msg);
}
