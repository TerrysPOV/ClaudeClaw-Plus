/**
 * Pending-action button resolution, shared by the Bus Telegram adapter and the
 * legacy `commands/telegram.ts` path. A `pending:<id>:<value>` tap is handed to
 * the operator's `pending.py` (found via `CLAUDECLAW_PENDING_LIB_PATH`), and the
 * verdict it prints decides the ack. Kept in one module so the two Telegram
 * paths cannot drift on what a decision means.
 */
import { execFile, type ExecFileException } from "node:child_process";

/**
 * Ack for an `already:<decision>:<resolved_at>` resolution (#314) — the user
 * tapped a pending-action button whose action was resolved earlier (a
 * double-tap, a Telegram callback retry after a slow ack, or a duplicate
 * notification). Names the PRIOR decision and when it happened, so the ack is
 * informative instead of the alarming "not found" the boolean resolver forced.
 *
 * `resolved_at` is the ISO timestamp the resolver reports; it is rendered
 * `DD/MM HH:MM` when parseable, omitted otherwise.
 */
/**
 * What a decision value actually did, as far as this layer can honestly tell.
 *
 * The decision vocabulary is not owned here: the value comes from whoever built
 * the proposal's buttons, and one live database holds 39 distinct values. A
 * deny-list of the four we happen to know therefore answers `✅ Approuvé` for
 * everything else — including `refuse`, whose own button reads "je le refuse
 * pour 30 jours". Telling someone their refusal was approved is a worse failure
 * than saying nothing.
 *
 * So: an allow-list for approval, explicit answers for the outcomes we do know,
 * and for anything unknown an ack that reports the decision without claiming a
 * meaning it cannot verify.
 *
 * Shared by both ack paths on purpose. They answer the same question and had
 * drifted — `discuss` was handled in one and left lying in the other — which is
 * what a rule duplicated in two places does.
 */
type AckKind = "approved" | "rejected" | "postponed" | "discussed" | "informational" | "unknown";

/**
 * The one normalised form of a decision, used both to classify it and to echo it
 * back. `ackForAlready` lower-cases while parsing and `ackForResolution` does
 * not, so echoing each function's own local variable made the same decision
 * print two different ways — `Done` from a fresh tap, `done` from a repeated
 * one. Classification was right either way; only the display diverged, which is
 * precisely the drift this change exists to remove.
 */
export function normalizeDecision(decision: string): string {
  return decision.trim().toLowerCase();
}

export function classifyDecision(decision: string): AckKind {
  const d = normalizeDecision(decision);
  if (d === "skip" || d === "skipped" || d === "later" || d === "snooze") return "postponed";
  if (d === "reject" || d === "cancel" || d === "rejected" || d === "refuse" || d === "drop")
    return "rejected";
  if (d === "discuss") return "discussed";
  // `details` shows something and deliberately leaves the action pending; it is
  // not a decision at all, so it must not be acked as one.
  if (d === "details" || d === "note" || d === "keep") return "informational";
  if (d === "approve" || d === "approved" || d === "ok" || d === "yes" || d.startsWith("apply"))
    return "approved";
  return "unknown";
}

/**
 * Whether a tap should take the inline keyboard away from the action's
 * message (#375). Editing the message strips the keyboard, so it must happen
 * only once the action is no longer waiting on the operator:
 *
 * - a verdict other than `ok` (`already`, `not_found`) means the action is
 *   resolved or gone — the buttons point at nothing, strip them;
 * - `ok` on a decision that closes the action (approve, reject, discuss, or an
 *   unknown one the resolver accepted) — strip;
 * - `ok` on `details` — the resolver deliberately leaves the action `pending`
 *   so the buttons stay usable; stripping them would strand it: still pending
 *   in the store, nothing re-sends it (the flush path only covers actions with
 *   no message id, the reminder path only `skipped`);
 * - `ok` on `skip` — the resolver keeps the keyboard on purpose so the
 *   operator can tap again later; an edit afterwards would remove it.
 *
 * The vocabulary is `classifyDecision`'s, shared with the ack text: every
 * value it reads as informational or postponed keeps its keyboard here. A
 * resolver that treats one of those as terminal strips the keyboard itself
 * when it records the decision, so nothing is left dangling either way; the
 * one direction that would strand an action — a value the resolver leaves
 * pending but the classifier reads as a decision — has no instance.
 *
 * `no_answer` never edits: the ack asks the operator to retry and must not
 * delete the buttons it points them at.
 */
export function decisionStripsKeyboard(verdict: ResolverVerdict, decision: string): boolean {
  if (verdict === "no_answer") return false;
  if (verdict !== "ok") return true;
  const kind = classifyDecision(decision);
  return kind !== "informational" && kind !== "postponed";
}

export function ackForAlready(resolution: string): string {
  const rest = resolution.slice("already:".length);
  const sep = rest.indexOf(":");
  const decision = (sep === -1 ? rest : rest.slice(0, sep)).toLowerCase();
  const at = sep === -1 ? "" : rest.slice(sep + 1);
  // "2026-07-16T11:51…" → " (16/07 11:51)"
  const m = at.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  const when = m ? ` (${m[2]}/${m[1]} ${m[3]})` : "";
  switch (classifyDecision(decision)) {
    case "rejected":
      return `❌ Déjà rejeté${when}`;
    case "postponed":
      return `⏸ Déjà reporté${when}`;
    case "discussed":
      return `💬 Déjà envoyé en discussion${when}`;
    case "informational":
      return `👀 Déjà consulté${when}`;
    case "approved":
      return `✅ Déjà approuvé${when}`;
    default:
      return `↩︎ Déjà traité — ${normalizeDecision(decision)}${when}`;
  }
}

/** The four outcomes a pending resolver can report. `no_answer` is not a
 *  statement about the action — it means we never got a verdict. */
export type ResolverVerdict = "ok" | "already" | "not_found" | "no_answer";

/**
 * Read the resolver's verdict off its stdout.
 *
 * The verdict is the LAST non-empty line, not the whole buffer: the resolver is
 * operator-supplied, and a resolver that logs its own diagnostics (a failed
 * notification edit, a deprecation notice) prints them before the verdict it
 * was asked for. Comparing the whole buffer classifies "diagnostic\nok" as
 * garbage and misreports a decision that was in fact applied.
 */
export function parseResolverVerdict(stdout: string): { verdict: ResolverVerdict; line: string } {
  const line =
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  if (line === "ok") return { verdict: "ok", line };
  if (line.startsWith("already:")) return { verdict: "already", line };
  if (line === "not_found") return { verdict: "not_found", line };
  return { verdict: "no_answer", line };
}

/**
 * Ack for a pending-action resolution.
 *
 * `not_found` is a statement about the action: the id is unknown, the button is
 * stale. `no_answer` is a statement about the resolver: it never printed a
 * verdict, so the action's fate is unknown — the resolver commits its decision
 * before we read its exit status, so the tap may well have applied. Acking both
 * as "not found" claims the tap was rejected when it may have landed.
 */
export function ackForResolution(stdout: string, decision: string): string {
  const { verdict, line } = parseResolverVerdict(stdout);
  if (verdict === "ok") {
    switch (classifyDecision(decision)) {
      case "postponed":
        return "⏸ Plus tard";
      case "rejected":
        return "❌ Rejeté";
      case "discussed":
        // Routes to the discussion handler, which opens a thread on the proposal
        // instead of applying it. The ack names no agent: which assistant it went
        // to comes from the operator's own config, not from this string.
        return "💬 Envoyé en discussion — réponds pour continuer";
      case "informational":
        return "👀 Consulté";
      case "approved":
        return "✅ Approuvé";
      default:
        return `↩︎ Décision enregistrée — ${normalizeDecision(decision)}`;
    }
  }
  if (verdict === "already") return ackForAlready(line);
  if (verdict === "not_found") return "⚠️ Action introuvable";
  return "⚠️ Erreur — réessaie";
}

/**
 * Strip credentials from resolver diagnostics before they reach the log. A
 * resolver that fails while calling the Bot API can put the bot token — which
 * lives in the request URL — into its stderr. Mirrors the redaction the PTY
 * tail applies for the same reason.
 */
/**
 * Describe how the pending resolver failed, in the shape an operator can act on.
 *
 * `code` is not always an exit status: a spawn failure (ENOENT, EACCES…) reports
 * a string there, so labelling it `exit ENOENT` would misreport the very failure
 * this diagnostic exists to explain. A signal kill reports `code: null`, which is
 * why the signal and timeout cases are tested first.
 */
export function describeResolverFailure(result: {
  timedOut: boolean;
  signal: string | null;
  code: number | string | null;
}): string {
  if (result.timedOut) return "timed out";
  if (result.signal) return `killed by ${result.signal}`;
  if (typeof result.code === "string") return `spawn error ${result.code}`;
  return `exit ${result.code}`;
}

export function redactResolverDiagnostics(text: string): string {
  return text
    .replace(/\bbot\d+:[A-Za-z0-9_-]{20,}/g, "bot<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9_.-]{16,}/g, "Bearer <redacted>");
}

export interface ResolverRunResult {
  code: number | string | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run the operator's resolver for one tap. Prefers the richer
 * `resolve_pending_ex` (#314: `ok|not_found|already:<decision>:<at>`) and falls
 * back to the boolean `resolve_pending` for older libs. Never throws: a spawn
 * failure, a signal or the 5s timeout all come back in the result, which is
 * what `describeResolverFailure` reads.
 */
export function runPendingResolver(
  pendingLibPath: string,
  actionId: string,
  decision: string,
): Promise<ResolverRunResult> {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [
        "-c",
        "import sys; sys.path.insert(0, sys.argv[1]); import pending; f = getattr(pending, 'resolve_pending_ex', None); print(f(int(sys.argv[2]), sys.argv[3]) if f else ('ok' if pending.resolve_pending(int(sys.argv[2]), sys.argv[3]) else 'not_found'))",
        pendingLibPath,
        actionId,
        decision,
      ],
      { timeout: 5000 },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        // `err` carries the real exit code, or a signal when the 5s timeout
        // killed the process — the three failure shapes the caller tells apart.
        resolve({
          code: err?.code ?? (err ? 1 : 0),
          signal: err?.signal ?? null,
          timedOut: err?.killed === true,
          stdout: stdout.trim(),
          stderr,
        });
      },
    );
  });
}
