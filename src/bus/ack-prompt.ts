/**
 * Prompts that do not call for an answer (reply nudge, #215/#240).
 *
 * The reply nudge assumes a channel-driven turn that ends without `reply` is a
 * dropped answer. After a bare acknowledgement ("ok", "thanks", a 👍) or a
 * repeat of a message the agent already answered, silence IS the answer:
 * nudging there makes the agent send a filler "👍" back. The bus still closes
 * such a turn for every caller, with a silent final (see `handleTurnEnd`).
 */

/** Words that, on their own, only acknowledge. Decisions ("yes", "go", "oui")
 *  are deliberately absent: they usually start work the user expects to hear
 *  about. "you" only counts after "thank" (see `isBareAcknowledgement`). */
const ACK_WORDS = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "oki",
  "okok",
  "thanks",
  "thank",
  "thx",
  "ty",
  "cool",
  "nice",
  "great",
  "noted",
  "merci",
  "parfait",
  "super",
  "d'accord",
  "daccord",
  "noté",
]);

/** At most this many words for a text to count as a bare acknowledgement. */
const ACK_MAX_WORDS = 3;

/** Emoji that only acknowledge. Any other emoji (🤔 ❓ 👎 ❌ 🛑 …) may ask,
 *  refuse or stop, so a text carrying one is not a bare acknowledgement. */
const ACK_EMOJI = new Set([
  "👍",
  "👌",
  "🙏",
  "✅",
  "✔",
  "☑",
  "👏",
  "🙌",
  "💯",
  "❤",
  "♥",
  "😊",
  "🙂",
  "😀",
  "😃",
  "😄",
  "😁",
  "🤝",
  "🫡",
  "💪",
  "🔥",
  "😎",
  "🤙",
]);

/** Emoji in `t` after dropping variation selectors and skin-tone modifiers. */
function emojiIn(t: string): string[] {
  return (
    t.replace(/[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, "").match(/\p{Extended_Pictographic}/gu) ?? []
  );
}

/** True when `text` is only an acknowledgement: ack words and/or emoji,
 *  nothing else (no question, no digits, no other word). */
export function isBareAcknowledgement(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > 40 || /[?？]/.test(t)) return false;
  const emoji = emojiIn(t);
  if (!emoji.every((e) => ACK_EMOJI.has(e))) return false;
  // Emoji, symbols and punctuation carry no request; drop them.
  const words = t
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    // Only emoji / punctuation (👍, 👌, 🙏): an acknowledgement. Bare
    // punctuation ("!", "...") is not — it may be a nudge from the user.
    return emoji.length > 0;
  }
  if (words.length > ACK_MAX_WORDS) return false;
  return words.every((w, i) => ACK_WORDS.has(w) || (w === "you" && words[i - 1] === "thank"));
}

/** A repeat counts only inside this window, and only once the earlier copy
 *  was answered — a resend of an UNanswered message must still be answered. */
export const REPEAT_WINDOW_MS = 120_000;

export type SeenPrompt = {
  origin_id: string;
  text: string;
  at: number;
  answered: boolean;
  /** The agent's final for this prompt ended on a question. */
  asked?: boolean;
};

/** True when a reply ends on a question: its last non-empty line has a "?".
 *  An "ok" after such a reply is an approval, not an acknowledgement. */
export function endsWithQuestion(text: string): boolean {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").includes("?");
}

/** True when `text` repeats the agent's previous prompt from the same chat,
 *  within `REPEAT_WINDOW_MS`, after the agent already answered it. */
export function isAnsweredRepeat(
  prev: SeenPrompt | undefined,
  origin_id: string,
  text: string,
  now: number,
): boolean {
  return (
    prev?.answered === true &&
    prev.origin_id === origin_id &&
    prev.text === text.trim() &&
    now - prev.at <= REPEAT_WINDOW_MS
  );
}

/** Key of `BusCore`'s last-seen prompt map: one entry per agent and chat. */
export function seenKey(agentId: string, originId: string): string {
  return `${agentId}\u0000${originId}`;
}

/** True when prompt metadata carries an attachment: `attachments` (Telegram),
 *  `files` (Slack) or `attachment_count` (Discord). */
export function hasAttachments(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const { attachments, files, attachment_count } = metadata;
  return (
    (Array.isArray(attachments) && attachments.length > 0) ||
    (Array.isArray(files) && files.length > 0) ||
    (typeof attachment_count === "number" && attachment_count > 0)
  );
}
