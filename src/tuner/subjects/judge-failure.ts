/** Why an LLM quality judge produced no median. */
export interface QualityFailureReason {
  code?: string;
  message: string;
}

// Token-shaped runs (API keys, bearer tokens, long hex/base64) never reach a log
// or the cache, even when an error message carries one.
const SECRET_LIKE_RE = /\b(?:sk|pk|rk)-[\w-]{8,}|\bBearer\s+\S+|[A-Za-z0-9+/_=-]{32,}/g;

// A non-zero CLI exit carries the CLI's stderr after the code: free-form text
// that may quote the judged input. Only the exit code is kept.
const CLI_EXIT_RE = /^(claude CLI exited (?:-?\d+|null))(?::|$)/;

/** Error code + first line of the message, capped and redacted: enough to
 * diagnose (e.g. ENOENT when the CLI is not on PATH), short enough to keep a
 * CLI's stderr dump out. A CLI exit keeps its exit code, not its stderr. */
export function errorReason(e: unknown): QualityFailureReason {
  // Called from catch blocks: it must not throw itself (a null-prototype object
  // has no String(), a getter can throw).
  try {
    const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
    const code = typeof c === "string" ? c : undefined;
    const raw = e instanceof Error ? e.message : String(e);
    const first = (typeof raw === "string" ? raw : "").split("\n")[0]!;
    const cliExit = CLI_EXIT_RE.exec(first);
    if (cliExit) return { code: "CLI_EXIT", message: cliExit[1]! };
    const message = first.replace(SECRET_LIKE_RE, "[redacted]").slice(0, 200);
    return code ? { code, message } : { message };
  } catch {
    return { message: "unprintable error" };
  }
}

export function describeError(e: unknown): string {
  const r = errorReason(e);
  return r.code ? `${r.code}: ${r.message}` : r.message;
}

/** The 1-5 scores of a judge reply. A malformed array yields none — never the
 * parser's message, which quotes the reply. */
export function parseJudgeScores(raw: string): number[] {
  let nums: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse((raw.match(/\[[\s\S]*\]/) ?? ["[]"])[0]);
    if (Array.isArray(parsed)) nums = parsed;
  } catch {
    // Malformed array → no scores; the caller records UNPARSEABLE.
  }
  return nums.filter((n): n is number => typeof n === "number" && n >= 1 && n <= 5);
}
