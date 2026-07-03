import { describe, it, expect } from "bun:test";
import { markdownToTelegramHtml, isTelegramHtmlParseError } from "../format";

describe("markdownToTelegramHtml — code back-reference safety (#265 review)", () => {
  // A string 2nd arg to String.replace interprets `$&`/`$'`/`` $` ``/`$$`. The
  // restore step must use a function replacer so code content is inserted
  // verbatim — otherwise these splice the match / rest of the string in.
  it("renders `$&` inside inline code literally (no match splice / NUL leak)", () => {
    const out = markdownToTelegramHtml("See `a$&b` here");
    expect(out).toBe("See <code>a$&amp;b</code> here");
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("IC0");
  });

  it("renders `$'` inside inline code literally (no rest-of-string splice)", () => {
    const out = markdownToTelegramHtml("run `x$'y` end");
    expect(out).toBe("run <code>x$'y</code> end");
  });

  it("renders `$$` inside inline code literally (no silent $ loss)", () => {
    const out = markdownToTelegramHtml("cost `$$5` total");
    expect(out).toBe("cost <code>$$5</code> total");
  });

  it("renders `$&` inside a fenced code block literally", () => {
    const out = markdownToTelegramHtml("```\nawk '{print $&}'\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("$&");
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("CB0");
  });
});

describe("markdownToTelegramHtml — link href escaping (#265 review)", () => {
  it("attribute-escapes a double-quote in the URL", () => {
    const out = markdownToTelegramHtml('[x](https://a?q="hi")');
    expect(out).toBe('<a href="https://a?q=&quot;hi&quot;">x</a>');
  });

  it("keeps `&` in a URL as the correct &amp; entity (Telegram decodes it back)", () => {
    const out = markdownToTelegramHtml("[ex](https://x.com/a?b=1&c=2)");
    expect(out).toBe('<a href="https://x.com/a?b=1&amp;c=2">ex</a>');
  });
});

describe("isTelegramHtmlParseError — only true for malformed-HTML 400s", () => {
  it("true for a 400 can't-parse-entities error", () => {
    expect(
      isTelegramHtmlParseError(
        new Error("Telegram API sendMessage: 400 Bad Request: can't parse entities: unclosed tag"),
      ),
    ).toBe(true);
  });

  it("false for a benign 400 (message is not modified)", () => {
    expect(
      isTelegramHtmlParseError(
        new Error("Telegram API editMessageText: 400 Bad Request: message is not modified"),
      ),
    ).toBe(false);
  });

  it("false for 'message to edit not found' and for a 429 flood", () => {
    expect(
      isTelegramHtmlParseError(
        new Error("Telegram API editMessageText: 400 Bad Request: message to edit not found"),
      ),
    ).toBe(false);
    expect(
      isTelegramHtmlParseError(
        new Error("Telegram API sendMessage: 429 flood cooldown, 5s remaining"),
      ),
    ).toBe(false);
  });
});
