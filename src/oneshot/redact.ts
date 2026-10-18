const MAX_EXCERPT = 200;

// Credential shapes that can appear in CLI stderr. Applied to the whole
// captured text before truncation, so a token cut by the limit is still masked.
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted]"],
  [
    /\b([A-Za-z0-9_]*(?:token|key|secret|password|passwd|authorization|credential)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
    "$1=[redacted]",
  ],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"],
];

/** Bounded, credential-masked stderr excerpt for error messages. */
export function stderrExcerpt(raw: string, max = MAX_EXCERPT): string {
  let text = raw;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, max);
}
