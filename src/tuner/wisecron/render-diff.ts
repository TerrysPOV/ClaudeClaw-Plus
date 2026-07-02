/**
 * Unified-diff renderer for proposal display surfaces (Telegram, Discord, CLI).
 *
 * The wisecron subjects used to put their entire post-change file content
 * into `Alternative.diff_or_content` — for the memory subject's MEMORY.md
 * that's ~50KB per alternative × 3 alternatives = ~150KB of wall-of-text
 * per proposal, which silently truncates on Telegram/Discord and makes the
 * three options visually indistinguishable.
 *
 * `renderDiff` produces a compact unified-diff string with a header summary,
 * capped at `maxBytes` (default 2048) so it fits within Block Kit / Telegram
 * message limits. It is intentionally simple — linewise set-difference rather
 * than LCS — because the goal is operator-readable change disclosure, not a
 * byte-perfect patch to feed `patch -p1`.
 */

export interface RenderDiffOptions {
  /** Hard cap on output bytes. Default 2048 (~ Block Kit safe). */
  maxBytes?: number;
  /** Optional label for the "a/" side header. Default "a". */
  fromLabel?: string;
  /** Optional label for the "b/" side header. Default "b". */
  toLabel?: string;
}

export function renderDiff(
  original: string,
  modified: string,
  opts: RenderDiffOptions = {},
): string {
  const max = opts.maxBytes ?? 2048;
  const from = opts.fromLabel ?? "a";
  const to = opts.toLabel ?? "b";

  const a = original.split("\n");
  const b = modified.split("\n");

  // Linewise membership: presence in the other side. Multiset-correct for
  // duplicate lines via index tracking.
  const aIndex = new Map<string, number[]>();
  a.forEach((line, i) => {
    if (!aIndex.has(line)) aIndex.set(line, []);
    aIndex.get(line)?.push(i);
  });
  const bIndex = new Map<string, number[]>();
  b.forEach((line, i) => {
    if (!bIndex.has(line)) bIndex.set(line, []);
    bIndex.get(line)?.push(i);
  });

  const removed: string[] = [];
  const added: string[] = [];
  let reordered = 0;

  const aSeen = new Map<string, number>();
  for (const line of a) {
    const seen = aSeen.get(line) ?? 0;
    const bOccurrences = bIndex.get(line) ?? [];
    if (seen >= bOccurrences.length) {
      removed.push(line);
    } else {
      // Present in both — count as reorder if the index drifted.
      const aPos = (aIndex.get(line) ?? [])[seen];
      const bPos = bOccurrences[seen];
      if (aPos !== bPos) reordered += 1;
    }
    aSeen.set(line, seen + 1);
  }

  const bSeen = new Map<string, number>();
  for (const line of b) {
    const seen = bSeen.get(line) ?? 0;
    const aOccurrences = aIndex.get(line) ?? [];
    if (seen >= aOccurrences.length) added.push(line);
    bSeen.set(line, seen + 1);
  }

  // Reordered double-counts pairs (once from each side) — halve it.
  reordered = Math.floor(reordered / 2);

  const header =
    `--- ${from}\n+++ ${to}\n` +
    `@@ ${removed.length} removed, ${added.length} added, ${reordered} reordered @@\n`;

  const bodyLines: string[] = [];
  for (const l of removed) bodyLines.push(`-${l}`);
  for (const l of added) bodyLines.push(`+${l}`);
  let body = bodyLines.join("\n");

  if (header.length + body.length > max) {
    const trailer = "\n... [diff truncated]";
    const room = Math.max(0, max - header.length - trailer.length);
    body = body.slice(0, room) + trailer;
  }
  return header + body;
}
