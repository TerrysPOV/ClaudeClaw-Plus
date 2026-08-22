/**
 * Deciding what a chat surface can actually render of a proposal.
 *
 * The proposal store deliberately does not bound `alternatives` on the read
 * path — a row written under an older, tighter bound must stay readable — so
 * a stored proposal can carry more alternatives than any chat API will
 * accept. Each surface then has three independent limits:
 *
 *   - how many action buttons it will take at all;
 *   - how long each identifier carried on a button may be, when that
 *     identifier has to survive the round trip and be parsed back out of the
 *     callback (a surface can impose more than one such limit on the same
 *     button, with different budgets);
 *   - how long the message body may be.
 *
 * Truncating the identifier is not an option where it is parsed back: the
 * button still renders, still looks clickable, and resolves to an alternative
 * that does not exist. Dropping the button and saying so is worse for one
 * alternative and better for the operator, who can still act on it from the
 * CLI.
 *
 * The three budgets are resolved TOGETHER, in one pass, because resolving
 * them separately is what produced the bug this module was written to fix:
 * picking buttons first and trimming text afterwards renders a button whose
 * alternative was cut out of the body, with nothing saying so. The invariant
 * here is that `shown` is exactly the set that got BOTH a block of text and a
 * button, and `notice` is derived from that final set — never from an
 * intermediate one.
 *
 * This lives in one place because the three adapters had drifted: the same
 * reasoning was written three times, corrected in one, and left stale in the
 * other two.
 */

import type { Alternative, Proposal } from "../core/types.js";

/** Blocks are joined — and therefore cut — on this boundary. */
const SEPARATOR = "\n\n";

const utf16 = (s: string) => s.length;

/**
 * One limit a surface puts on a string carried by a button.
 *
 * A surface may impose several on the same button — Slack bounds both the
 * `value` it hands back and the `action_id` that must stay unique within the
 * block — and an alternative is only addressable if it satisfies every one.
 */
export interface IdentifierConstraint {
  /** Builds the string the surface will carry and later parse back. */
  build: (alt: Alternative) => string;
  /** The surface's limit for it. */
  max: number;
  /**
   * How the surface counts. UTF-16 length by default; byte length where the
   * API counts bytes, which is not the same thing the moment the id is not
   * pure ASCII.
   */
  measure?: (s: string) => number;
}

export interface RenderedProposal {
  /**
   * The alternatives that got a button AND a block of text describing them.
   * Never one without the other — that is the whole point of this module.
   */
  shown: Alternative[];
  /** How many of the proposal's alternatives were left out, for any reason. */
  hidden: number;
  /**
   * A sentence naming the gap, or `""` when nothing was left out. Plain text —
   * no markup — so it is safe to append on any surface, and counted against
   * the body budget before the body is built.
   */
  notice: string;
  /** Header, kept blocks and notice, guaranteed within the surface's limit. */
  text: string;
}

/**
 * Filter to the alternatives every one of a surface's identifier limits can
 * carry. Order is preserved; nothing is truncated.
 */
export function pickAddressable(
  alternatives: readonly Alternative[],
  identifiers: readonly IdentifierConstraint[],
): Alternative[] {
  return alternatives.filter((alt) =>
    identifiers.every((c) => (c.measure ?? utf16)(c.build(alt)) <= c.max),
  );
}

/**
 * Flatten a string for inline use inside a markup body.
 *
 * `label` and `tradeoff` are unbounded `z.string()`s written by subjects, so
 * they can carry newlines and markup characters of their own. Either one is
 * enough to break the body: a newline splits a block across the cut boundary,
 * and a lone `_` leaves an entity Telegram will not close — it answers
 * `can't find end of entity` and drops the whole message, which is a worse
 * outcome than any amount of missing text.
 *
 * The markup characters are removed rather than backslash-escaped because
 * Telegram's legacy `Markdown` parse mode does not accept escapes everywhere
 * they would be needed. These are descriptive prose fields; losing an
 * asterisk from them costs nothing.
 */
export function stripInlineMarkup(s: string, markupChars: string): string {
  const flattened = s.replace(/\s+/g, " ").trim();
  return markupChars
    ? flattened.replace(new RegExp(`[${escapeForClass(markupChars)}]`, "g"), "")
    : flattened;
}

function escapeForClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, (c) => "\\" + c);
}

/**
 * Bound the one unbounded field the header interpolates.
 *
 * `target_path` is a `z.string()` with no length cap, and it is rendered
 * inside the header rather than in a droppable block — so an over-long one is
 * not a shortened header, it is a rejected message. The tail is kept because
 * that is the identifying end of a path.
 */
export function elidePath(path: string, max: number): string {
  return path.length <= max ? path : "\u2026" + path.slice(-(max - 1));
}

/**
 * Resolve the button budget, every identifier budget and the text budget in
 * one pass.
 *
 * `maxText` is assumed to exceed the length of the gap notice (~80 characters);
 * every surface's limit clears that by more than an order of magnitude. A
 * budget smaller than the notice has no correct answer — there is no room to
 * say what was dropped — and is not defended against.
 *
 * `block` renders one alternative and must not contain the separator itself —
 * `stripInlineMarkup` the fields it interpolates. Blocks are kept whole: the
 * body is cut between blocks, never inside one, which is what keeps a markup
 * entity from being left open.
 */
export function renderProposalBody(
  proposal: Proposal,
  opts: {
    identifiers: readonly IdentifierConstraint[];
    maxButtons: number;
    maxText: number;
    header: string;
    block: (alt: Alternative) => string;
  },
): RenderedProposal {
  const total = proposal.alternatives.length;
  const candidates = pickAddressable(proposal.alternatives, opts.identifiers).slice(
    0,
    Math.max(0, opts.maxButtons),
  );

  // Whether a notice is needed is only known after the text budget has been
  // spent, but the notice has to be paid for out of that same budget. So fit
  // twice: once assuming none is needed, and again reserving room the moment
  // the first pass proves otherwise. Reserving unconditionally would drop an
  // alternative from a proposal that fits whole, which is the same class of
  // silent loss this module exists to prevent.
  const free = fitBlocks(candidates, opts, opts.maxText);
  if (free.shown.length === total) {
    return { shown: free.shown, hidden: 0, notice: "", text: free.text };
  }

  // The notice's own length grows only with the digit count of a number that
  // cannot exceed `candidates.length`, so this is a true upper bound.
  const reserve = noticeFor(proposal, candidates.length, total).length;
  const fitted = fitBlocks(candidates, opts, opts.maxText - reserve);
  const notice = noticeFor(proposal, fitted.shown.length, total);
  return {
    shown: fitted.shown,
    hidden: total - fitted.shown.length,
    notice,
    text: fitted.text + notice,
  };
}

function fitBlocks(
  candidates: readonly Alternative[],
  opts: { header: string; block: (alt: Alternative) => string },
  budget: number,
): { shown: Alternative[]; text: string } {
  // The header carries the proposal id, so it is the last thing to give — but
  // it is not exempt from the budget. It interpolates `target_path`, another
  // unbounded string: a deep enough path blows the content limit on the header
  // alone, before a single alternative is considered, and the surface rejects
  // the message. Callers bound the path (`elidePath`); this is the backstop
  // that makes the return value's contract true whatever a caller passes.
  let text = clampToLine(opts.header, budget);
  const shown: Alternative[] = [];
  for (const alt of candidates) {
    const next = text + SEPARATOR + opts.block(alt);
    if (next.length > budget) break;
    text = next;
    shown.push(alt);
  }
  return { shown, text };
}

/**
 * Cut on a line boundary, as blocks are cut on a block boundary and for the
 * same reason: every line of a header opens and closes its own markup, so a
 * cut between lines cannot leave an entity open. A header with no line break
 * to cut at is cut hard — there is nothing safer available, and a message over
 * the limit is refused outright.
 */
function clampToLine(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", Math.max(0, budget));
  return cut <= 0 ? text.slice(0, Math.max(0, budget)) : text.slice(0, cut);
}

function noticeFor(proposal: Proposal, shown: number, total: number): string {
  // No markup, per the contract on `RenderedProposal.notice`: this string is
  // appended to bodies on three surfaces with three different markup dialects,
  // and it is the one part of the message that must never be the reason the
  // message is rejected.
  return `${SEPARATOR}${shown} of ${total} alternatives have a button here; apply the rest with: tuner apply ${proposal.id}`;
}
