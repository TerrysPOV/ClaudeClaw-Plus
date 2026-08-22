/**
 * What the chat adapters do with a proposal carrying more alternatives than
 * the surface can render.
 *
 * The proposal store does not bound `alternatives` on the read path — a row
 * written under an older, tighter bound has to stay readable — so every one of
 * these limits is reachable from real data. Each of them rejects the WHOLE
 * message when exceeded, so the failure is not a shortened proposal, it is no
 * proposal at all.
 *
 * The fixtures here are deliberately hostile: realistic label and tradeoff
 * lengths, ids long enough to blow a callback identifier, and enough
 * alternatives to cross every cap. An earlier version of this work passed its
 * tests with one-word labels while the real shape failed in production.
 *
 * The load-bearing assertion in this file is `expectButtonsMatchBody`. Caps on
 * counts are easy to hold and easy to test; the failure that actually reached
 * an operator was a button whose alternative had been cut out of the body,
 * with nothing saying so. Every surface asserts that invariant on a fixture
 * that really does overflow.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DiscordAdapter } from "../../skills-tuner/adapters/discord";
import { SlackAdapter } from "../../skills-tuner/adapters/slack";
import { TelegramAdapter } from "../../skills-tuner/adapters/telegram";
import {
  elidePath,
  pickAddressable,
  renderProposalBody,
  stripInlineMarkup,
} from "../../skills-tuner/adapters/renderable";
import type { Alternative, Proposal } from "../../skills-tuner/core/types";

/** Alternatives shaped like the ones subjects actually emit. */
function alts(n: number, opts: { idLen?: number; labelLen?: number } = {}): Alternative[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i + 1}`.padEnd(opts.idLen ?? 2, "x"),
    // Padded with a non-space character on purpose: the adapters collapse
    // whitespace runs, so a label padded with spaces would shrink back and
    // stop overflowing anything.
    label: "Rewrite the retention window"
      .padEnd(opts.labelLen ?? 40, "x")
      .slice(0, opts.labelLen ?? 40),
    diff_or_content: "x",
    tradeoff: "Cheaper to run, slower to converge, and harder to explain afterwards",
  }));
}

function makeProposal(alternatives: Alternative[]): Proposal {
  return {
    id: 42,
    cluster_id: "cluster-1",
    subject: "memory",
    kind: "update",
    target_path: "/home/user/.claude/memory/retention.md",
    alternatives,
    pattern_signature: "sig-1",
    created_at: new Date("2026-05-17T00:00:00Z"),
    signature: "test-signature",
  } as Proposal;
}

/** A path deep enough to blow a content limit on the header alone. */
const HUGE_PATH = "/very/deep/" + "segment/".repeat(700) + "retention.md";

type CapturedCall = { url: string; init?: RequestInit };
let calls: CapturedCall[];
const origFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return new Response('{"ok":true,"id":"msg-1"}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

function body(): Record<string, unknown> {
  return JSON.parse(calls[0]!.init?.body as string);
}

// ── Reading a rendered message back, per surface ─────────────────────────────

/** The body text and the alternative ids that got an Apply button. */
interface Rendered {
  text: string;
  applied: string[];
}

function readDiscord(): Rendered {
  const b = body();
  const rows = b.components as Array<{ components: Array<{ custom_id: string }> }>;
  return {
    text: b.content as string,
    applied: rows
      .flatMap((r) => r.components)
      .map((c) => c.custom_id)
      .filter((id) => id.startsWith("apply:"))
      .map((id) => id.split(":")[2] as string),
  };
}

function readSlack(): Rendered {
  const blocks = body().blocks as Array<{
    type: string;
    text?: { text: string };
    elements?: Array<{ value: string; action_id: string }>;
  }>;
  const actions = blocks.find((x) => x.type === "actions");
  return {
    text: blocks.find((x) => x.type === "section")?.text?.text ?? "",
    applied: (actions?.elements ?? [])
      .map((e) => e.value)
      .filter((v) => v.startsWith("apply:"))
      .map((v) => v.split(":")[2] as string),
  };
}

function readTelegram(): Rendered {
  const b = body();
  const kb = (b.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
    .inline_keyboard;
  return {
    text: b.text as string,
    applied: kb
      .flat()
      .map((btn) => btn.callback_data)
      .filter((d) => d.startsWith("apply:"))
      .map((d) => d.split(":")[2] as string),
  };
}

/**
 * The invariant the whole module exists for: a button is never offered for an
 * alternative the reader cannot see, the body really did overflow (otherwise
 * the assertion proves nothing), and the notice counts what is actually there.
 */
function expectButtonsMatchBody(r: Rendered, total: number, cap: number) {
  expect(r.text.length).toBeLessThanOrEqual(cap);
  // Guard against a fixture that quietly stopped overflowing: if everything
  // fits, this test is not testing what it claims to test.
  expect(r.applied.length).toBeLessThan(total);
  for (const id of r.applied) {
    expect(r.text).toContain(id);
  }
  expect(r.text).toContain(`${r.applied.length} of ${total} alternatives`);
}

// ── The shared decision ─────────────────────────────────────────────────────

describe("pickAddressable", () => {
  it("drops an alternative whose identifier will not survive the round trip", () => {
    const proposal = makeProposal([
      ...alts(2),
      { id: "z".repeat(200), label: "huge id", diff_or_content: "x", tradeoff: "" },
    ]);
    const shown = pickAddressable(proposal.alternatives, [
      { build: (a) => `apply:${proposal.id}:${a.id}`, max: 100 },
    ]);
    expect(shown).toHaveLength(2);
  });

  it("measures the identifier the way the surface counts it", () => {
    // A four-byte emoji is one UTF-16 unit pair but four bytes. A surface that
    // counts bytes must not be told the id fits because it is short.
    const alternatives = [
      { id: "\u{1F4A5}".repeat(20), label: "emoji id", diff_or_content: "x", tradeoff: "" },
    ];
    const byChars = pickAddressable(alternatives, [{ build: (a) => `apply:42:${a.id}`, max: 64 }]);
    const byBytes = pickAddressable(alternatives, [
      { build: (a) => `apply:42:${a.id}`, max: 64, measure: (v) => Buffer.byteLength(v, "utf8") },
    ]);
    expect(byChars).toHaveLength(1);
    expect(byBytes).toHaveLength(0);
  });

  it("keeps an identifier of exactly the limit and drops the next character", () => {
    // The off-by-one that a fixture sitting far from the cap cannot catch.
    const atLimit = [{ id: "y".repeat(90), label: "l", diff_or_content: "x", tradeoff: "" }];
    const overLimit = [{ id: "y".repeat(91), label: "l", diff_or_content: "x", tradeoff: "" }];
    const build = (a: Alternative) => `apply:42:${a.id}`; // 9-char prefix → 99 and 100
    expect(pickAddressable(atLimit, [{ build, max: 99 }])).toHaveLength(1);
    expect(pickAddressable(overLimit, [{ build, max: 99 }])).toHaveLength(0);
  });

  it("requires EVERY limit to be satisfied, not just the loosest one", () => {
    // Slack's shape: a generous budget on the value it parses back, a much
    // tighter one on the action_id that has to stay unique in the block.
    const alternatives = [{ id: "q".repeat(300), label: "l", diff_or_content: "x", tradeoff: "" }];
    expect(
      pickAddressable(alternatives, [{ build: (a) => `apply:42:${a.id}`, max: 2000 }]),
    ).toHaveLength(1);
    expect(
      pickAddressable(alternatives, [
        { build: (a) => `apply:42:${a.id}`, max: 2000 },
        { build: (a) => `tuner_apply_42_${a.id}`, max: 255 },
      ]),
    ).toHaveLength(0);
  });
});

describe("renderProposalBody", () => {
  const opts = (over: Partial<Parameters<typeof renderProposalBody>[1]> = {}) => ({
    identifiers: [{ build: (a: Alternative) => a.id, max: 100 }],
    maxButtons: 20,
    maxText: 200,
    header: "HEADER",
    block: (a: Alternative) => `${a.id}: ${a.label}`,
    ...over,
  });

  it("shows an alternative only when its block fits, and counts the rest", () => {
    const r = renderProposalBody(makeProposal(alts(20)), opts());
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.shown.length).toBeGreaterThan(0);
    expect(r.hidden).toBe(20 - r.shown.length);
    expect(r.notice).toContain(`${r.shown.length} of 20 alternatives`);
    for (const alt of r.shown) expect(r.text).toContain(alt.id);
  });

  it("counts the notice against the budget instead of appending past it", () => {
    // A body sized to fill the limit exactly without a notice still has to
    // hold the notice once one is needed.
    const r = renderProposalBody(makeProposal(alts(20)), opts({ maxText: 300 }));
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.notice).not.toBe("");
    expect(r.text.endsWith(r.notice)).toBe(true);
  });

  it("says nothing and keeps everything when it all fits", () => {
    const r = renderProposalBody(makeProposal(alts(3)), opts({ maxText: 4000 }));
    expect(r.hidden).toBe(0);
    expect(r.notice).toBe("");
    expect(r.shown).toHaveLength(3);
  });

  it("cuts between blocks, never inside one", () => {
    const r = renderProposalBody(makeProposal(alts(20)), opts());
    // Every block that made it is present in full; no half of one is.
    for (const alt of r.shown) expect(r.text).toContain(`${alt.id}: ${alt.label}`);
    expect(r.text.split("\n\n")).toHaveLength(r.shown.length + 2); // header + blocks + notice
  });

  it("cuts the header rather than emitting a body over the limit", () => {
    // `target_path` is unbounded and lands in the header, not in a droppable
    // block: a deep enough path blows the limit before a single alternative is
    // considered, and the surface rejects the whole message.
    const r = renderProposalBody(makeProposal(alts(20)), {
      identifiers: [{ build: (a: Alternative) => a.id, max: 100 }],
      maxButtons: 20,
      maxText: 200,
      header: "Proposal #42\n\nTarget: `" + "x".repeat(500) + "`",
      block: (a: Alternative) => `${a.id}: ${a.label}`,
    });
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.text).toContain("Proposal #42");
  });

  it("keeps the notice free of markup, so it is safe on every surface", () => {
    const r = renderProposalBody(makeProposal(alts(20)), opts());
    for (const ch of ["*", "_", "`", "~", "["]) {
      expect(r.notice).not.toContain(ch);
    }
  });

  it("keeps the header even when not one alternative fits", () => {
    const r = renderProposalBody(makeProposal(alts(20)), opts({ maxText: 100 }));
    expect(r.shown).toHaveLength(0);
    expect(r.text).toContain("HEADER");
    expect(r.text.length).toBeLessThanOrEqual(100);
  });
});

describe("elidePath", () => {
  it("keeps the tail, which is the identifying end of a path", () => {
    const out = elidePath("/a/very/long/path/to/retention.md", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("retention.md")).toBe(true);
    expect(out.startsWith("\u2026")).toBe(true);
  });

  it("leaves a path that already fits untouched", () => {
    expect(elidePath("/short/path.md", 200)).toBe("/short/path.md");
  });
});

describe("stripInlineMarkup", () => {
  it("removes the characters that would leave an entity open", () => {
    expect(stripInlineMarkup("use snake_case for *keys*", "*_`[")).toBe("use snakecase for keys");
  });

  it("flattens newlines so a block cannot straddle the cut boundary", () => {
    expect(stripInlineMarkup("first line\nsecond line", "")).toBe("first line second line");
    expect(stripInlineMarkup("  padded\n\n  out  ", "")).toBe("padded out");
  });

  it("leaves ordinary prose untouched", () => {
    expect(stripInlineMarkup("Cheaper to run, slower to converge", "*_`[")).toBe(
      "Cheaper to run, slower to converge",
    );
  });
});

// ── Discord ─────────────────────────────────────────────────────────────────

describe("DiscordAdapter — a proposal bigger than the surface", () => {
  const cfg = {
    botToken: "t",
    channelId: "c",
    baseUrl: "https://discord.test",
    allowedUserIds: ["u"],
  };

  it("never offers a button for an alternative it cut out of the body", async () => {
    // 20 alternatives is the valid maximum a subject may emit, and it already
    // overflows the 2000-character content limit on text alone — while the
    // 20-button budget never bites. Deciding buttons before text rendered four
    // buttons whose alternatives were nowhere in the message.
    await new DiscordAdapter(cfg).renderProposal(makeProposal(alts(20)));
    expectButtonsMatchBody(readDiscord(), 20, 2000);
  });

  it("keeps content under the limit when the notice is also needed", async () => {
    await new DiscordAdapter(cfg).renderProposal(makeProposal(alts(24)));
    const r = readDiscord();
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expectButtonsMatchBody(r, 24, 2000);
  });

  it("chunks buttons five to a row and keeps Refuse/Edit last", async () => {
    await new DiscordAdapter(cfg).renderProposal(makeProposal(alts(12)));
    const rows = body().components as Array<{ components: Array<{ label: string }> }>;
    for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5);
    const last = rows[rows.length - 1]!.components;
    expect(last.map((c) => c.label)).toEqual(["Refuse", "Edit"]);
  });

  it("never truncates a custom_id, because it is parsed back out", async () => {
    const proposal = makeProposal([
      ...alts(2),
      { id: "z".repeat(200), label: "unaddressable", diff_or_content: "x", tradeoff: "" },
    ]);
    await new DiscordAdapter(cfg).renderProposal(proposal);
    const r = readDiscord();
    expect(r.applied).toEqual(["a1", "a2"]);
    expect(r.text).toContain("2 of 3 alternatives");
  });

  it("stays under the limit when the target path alone would blow it", async () => {
    await new DiscordAdapter(cfg).renderProposal(
      makeProposal(alts(20)) && ({ ...makeProposal(alts(20)), target_path: HUGE_PATH } as Proposal),
    );
    const r = readDiscord();
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("retention.md");
  });

  it("leaves a proposal that fits completely alone", async () => {
    await new DiscordAdapter(cfg).renderProposal(makeProposal(alts(3)));
    const r = readDiscord();
    expect(r.applied).toHaveLength(3);
    expect(r.text).not.toContain("alternatives have a button here");
  });
});

// ── Slack ───────────────────────────────────────────────────────────────────

describe("SlackAdapter — a proposal bigger than the surface", () => {
  const cfg = {
    botToken: "t",
    channelId: "c",
    baseUrl: "https://slack.test",
    allowedUserIds: ["u"],
  };

  it("never offers a button for an alternative it cut out of the body", async () => {
    await new SlackAdapter(cfg).renderProposal(makeProposal(alts(40)));
    expectButtonsMatchBody(readSlack(), 40, 3000);
  });

  it("keeps the actions block within Slack's 25-element cap", async () => {
    await new SlackAdapter(cfg).renderProposal(makeProposal(alts(40)));
    const blocks = body().blocks as Array<{ type: string; elements?: unknown[] }>;
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions?.elements?.length).toBeLessThanOrEqual(25);
  });

  it("stays under the limit when the target path alone would blow it", async () => {
    await new SlackAdapter(cfg).renderProposal({
      ...makeProposal(alts(20)),
      target_path: HUGE_PATH,
    } as Proposal);
    expect(readSlack().text.length).toBeLessThanOrEqual(3000);
  });

  it("keeps every action_id unique when ids share a 255-character prefix", async () => {
    // `action_id` is bounded four times tighter than `value`, and Slack
    // rejects the whole block if two elements share one. Bounding only the
    // value let both of these render as the same truncated action_id.
    const prefix = "p".repeat(300);
    const proposal = makeProposal([
      { id: prefix + "one", label: "first", diff_or_content: "x", tradeoff: "" },
      { id: prefix + "two", label: "second", diff_or_content: "x", tradeoff: "" },
      ...alts(2),
    ]);
    await new SlackAdapter(cfg).renderProposal(proposal);
    const blocks = body().blocks as Array<{
      type: string;
      elements?: Array<{ action_id: string }>;
    }>;
    const ids = (blocks.find((b) => b.type === "actions")?.elements ?? []).map((e) => e.action_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(255);
    // And the two that could not be addressed were dropped, not truncated.
    expect(readSlack().applied).toEqual(["a1", "a2"]);
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────

describe("TelegramAdapter — a proposal bigger than the surface", () => {
  const cfg = {
    botToken: "t",
    chatId: "c",
    baseUrl: "https://telegram.test",
    allowedUserIds: [1],
  };

  it("never offers a button for an alternative it cut out of the body", async () => {
    // Long labels, few alternatives: the text limit is what bites here, not
    // the button budget.
    await new TelegramAdapter(cfg).renderProposal(makeProposal(alts(20, { labelLen: 400 })));
    expectButtonsMatchBody(readTelegram(), 20, 4096);
  });

  it("emits the exact callback_data for an id that fits", async () => {
    await new TelegramAdapter(cfg).renderProposal(makeProposal(alts(2)));
    const kb = (body().reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard;
    expect(kb.flat().map((b) => b.callback_data)).toEqual([
      "apply:42:a1",
      "apply:42:a2",
      "refuse:42",
      "edit:42",
    ]);
  });

  it("counts callback_data in BYTES, not UTF-16 units", async () => {
    // 20 four-byte emoji are 40 UTF-16 units — comfortably under 64 — but 80
    // bytes, which Telegram rejects with BUTTON_DATA_INVALID for the whole
    // message. Counting characters here renders the button anyway.
    const proposal = makeProposal([
      { id: "\u{1F4A5}".repeat(20), label: "emoji id", diff_or_content: "x", tradeoff: "" },
      ...alts(2),
    ]);
    await new TelegramAdapter(cfg).renderProposal(proposal);
    const r = readTelegram();
    expect(r.applied).toEqual(["a1", "a2"]);
    for (const d of ["apply:42:a1", "apply:42:a2"]) {
      expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
    }
    expect(r.text).toContain("2 of 3 alternatives");
  });

  it("keeps every callback_data within 64 bytes", async () => {
    await new TelegramAdapter(cfg).renderProposal(makeProposal(alts(6, { idLen: 80 })));
    const kb = (body().reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard;
    for (const btn of kb.flat()) {
      expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
    // The over-long ids were dropped, so only the decision row survives — and
    // the message says so rather than pretending the proposal had no options.
    expect(readTelegram().applied).toEqual([]);
    expect(body().text as string).toContain("0 of 6 alternatives");
  });

  it("leaves the Markdown balanced on text that really was trimmed", async () => {
    const proposal = makeProposal(alts(20, { labelLen: 400 }));
    await new TelegramAdapter(cfg).renderProposal(proposal);
    const text = body().text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    // The fixture must actually overflow, or the parity below is vacuous.
    expect(text).toContain("alternatives have a button here");
    for (const delim of ["*", "_", "`"]) {
      expect(text.split(delim).length % 2).toBe(1);
    }
  });

  it("survives a label carrying its own markup and newlines", async () => {
    // `label` and `tradeoff` are unbounded strings written by a subject. A
    // lone underscore, or a newline splitting an italic run across the cut
    // boundary, makes Telegram reject the entire message.
    const proposal = makeProposal([
      {
        id: "a1",
        label: "use snake_case for keys",
        diff_or_content: "x",
        tradeoff: "opens *bold\nand never closes it",
      },
      ...alts(2),
    ]);
    await new TelegramAdapter(cfg).renderProposal(proposal);
    const text = body().text as string;
    for (const delim of ["*", "_", "`"]) {
      expect(text.split(delim).length % 2).toBe(1);
    }
    expect(text).not.toContain("snake_case");
    expect(text).toContain("snakecase");
  });

  it("stays under the limit when the target path alone would blow it", async () => {
    await new TelegramAdapter(cfg).renderProposal({
      ...makeProposal(alts(20, { labelLen: 400 })),
      target_path: HUGE_PATH,
    } as Proposal);
    const text = body().text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    for (const delim of ["*", "_", "`"]) {
      expect(text.split(delim).length % 2).toBe(1);
    }
  });

  it("bounds the keyboard instead of emitting hundreds of buttons", async () => {
    await new TelegramAdapter(cfg).renderProposal(makeProposal(alts(60)));
    const kb = (body().reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb.length).toBeLessThanOrEqual(11);
    for (const row of kb) expect(row.length).toBeGreaterThan(0);
  });

  it("puts at most two buttons on a row, because these are read on a phone", async () => {
    await new TelegramAdapter(cfg).renderProposal(makeProposal(alts(6)));
    const kb = (body().reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    for (const row of kb) expect(row.length).toBeLessThanOrEqual(2);
  });
});
