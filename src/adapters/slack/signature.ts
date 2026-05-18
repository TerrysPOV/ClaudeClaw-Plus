/**
 * Slack adapter — Events API signature verification.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.3.
 * Reference: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Split out of `index.ts` so the main adapter file stays under the
 * per-file LOC cap (spec §5.5.3) and so the signing path is unit-
 * testable without standing up an adapter instance.
 *
 * The legacy listener at `src/commands/slack.ts` doesn't ship an HTTP
 * Events API fallback (Socket Mode only), so there's no shared module
 * to reuse — Sprint 4 introduces this helper from scratch.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySignatureOpts {
  /** Raw HTTP body string — NOT the parsed JSON. */
  body: string;
  /** `X-Slack-Request-Timestamp` header value. */
  timestamp: string;
  /** `X-Slack-Signature` header value (starts with `v0=`). */
  signature: string;
  /** Slack app signing secret. */
  signingSecret: string;
}

/**
 * Verify an Events API or interactivity request's signature in constant
 * time, with a 5-minute replay window per Slack's spec.
 *
 * Returns `false` for:
 *   - Invalid timestamp (non-numeric or > 5 min skew)
 *   - Mismatched signature
 *   - Length-mismatched signature (guards `timingSafeEqual` precondition)
 */
export function verifySlackSignature(opts: VerifySignatureOpts): boolean {
  const tsNum = Number(opts.timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  const base = `v0:${opts.timestamp}:${opts.body}`;
  const computed = `v0=${createHmac("sha256", opts.signingSecret).update(base).digest("hex")}`;
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(opts.signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
