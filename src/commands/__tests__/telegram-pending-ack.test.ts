import { describe, it, expect } from "bun:test";
import {
  ackForAlready,
  ackForResolution,
  parseResolverVerdict,
  redactResolverDiagnostics,
  describeResolverFailure,
} from "../telegram.js";

// #314: a pending-action button tapped after it was already resolved must ack
// the PRIOR decision + when, not the alarming "not found". ackForAlready parses
// the resolver's `already:<decision>:<resolved_at>` string.
describe("ackForAlready (#314)", () => {
  it("names the prior decision and renders the timestamp DD/MM HH:MM", () => {
    expect(ackForAlready("already:approve:2026-07-16T11:51:00")).toBe(
      "✅ Déjà approuvé (16/07 11:51)",
    );
    expect(ackForAlready("already:reject:2026-07-16T09:05:12")).toBe(
      "❌ Déjà rejeté (16/07 09:05)",
    );
    expect(ackForAlready("already:skip:2026-07-16T09:05:12")).toBe("⏸ Déjà reporté (16/07 09:05)");
  });

  it("maps decision synonyms (cancel/rejected/skipped)", () => {
    expect(ackForAlready("already:cancel:2026-01-02T03:04:00")).toBe(
      "❌ Déjà rejeté (02/01 03:04)",
    );
    expect(ackForAlready("already:rejected:2026-01-02T03:04:00")).toBe(
      "❌ Déjà rejeté (02/01 03:04)",
    );
    expect(ackForAlready("already:skipped:2026-01-02T03:04:00")).toBe(
      "⏸ Déjà reporté (02/01 03:04)",
    );
  });

  it("omits the timestamp when absent or unparseable, defaults to approved", () => {
    expect(ackForAlready("already:approve")).toBe("✅ Déjà approuvé");
    expect(ackForAlready("already:approve:not-a-date")).toBe("✅ Déjà approuvé");
    // Unknown decision string → treated as the approve default (informative, not alarming).
    expect(ackForAlready("already:done:2026-07-16T11:51:00")).toBe(
      "✅ Déjà approuvé (16/07 11:51)",
    );
  });
});

// A resolver that prints no verdict is not the same fact as `not_found`: the
// resolver commits its decision before we read its exit status, so "no verdict"
// says nothing about whether the tap applied. And the verdict is the LAST line,
// because an operator's resolver may log its own diagnostics first.
describe("parseResolverVerdict", () => {
  it("recognises the three verdicts a resolver can print", () => {
    expect(parseResolverVerdict("ok").verdict).toBe("ok");
    expect(parseResolverVerdict("not_found").verdict).toBe("not_found");
    const already = parseResolverVerdict("already:approve:2026-07-16T11:51:00");
    expect(already.verdict).toBe("already");
    expect(already.line).toBe("already:approve:2026-07-16T11:51:00");
  });

  it("reads the verdict off the last non-empty line, past the resolver's own logs", () => {
    // The shape that misreported an applied decision: the resolver logged a
    // failed notification edit on stdout, then printed its verdict.
    expect(parseResolverVerdict("[pending] Telegram edit error: HTTP 429\nok").verdict).toBe("ok");
    expect(parseResolverVerdict("warning: deprecated\nnot_found\n\n").verdict).toBe("not_found");
    expect(parseResolverVerdict("noise\nalready:skip:2026-07-16T09:05:12").line).toBe(
      "already:skip:2026-07-16T09:05:12",
    );
  });

  it("reports no verdict when the resolver printed none", () => {
    expect(parseResolverVerdict("").verdict).toBe("no_answer");
    expect(parseResolverVerdict("   \n  ").verdict).toBe("no_answer");
    expect(parseResolverVerdict("Traceback (most recent call last):").verdict).toBe("no_answer");
  });
});

describe("ackForResolution", () => {
  it("names the decision that was taken", () => {
    expect(ackForResolution("ok", "approve")).toBe("✅ Approuvé");
    expect(ackForResolution("ok", "skip")).toBe("⏸ Plus tard");
    expect(ackForResolution("ok", "reject")).toBe("❌ Rejeté");
    expect(ackForResolution("ok", "cancel")).toBe("❌ Rejeté");
  });

  it("delegates an already-resolved tap to ackForAlready", () => {
    expect(ackForResolution("already:reject:2026-07-16T09:05:12", "approve")).toBe(
      "❌ Déjà rejeté (16/07 09:05)",
    );
  });

  it("keeps 'not found' for a genuinely unknown action id", () => {
    expect(ackForResolution("not_found", "approve")).toBe("⚠️ Action introuvable");
  });

  it("acks a missing verdict as retryable instead of claiming the id is unknown", () => {
    expect(ackForResolution("", "approve")).toBe("⚠️ Erreur — réessaie");
    expect(ackForResolution("Traceback (most recent call last):", "approve")).toBe(
      "⚠️ Erreur — réessaie",
    );
  });

  it("acks the decision when the verdict trails the resolver's own output", () => {
    expect(ackForResolution("[pending] Telegram edit error: HTTP 429\nok", "approve")).toBe(
      "✅ Approuvé",
    );
  });
});

describe("redactResolverDiagnostics", () => {
  it("strips a bot token out of a resolver traceback", () => {
    const raw =
      "urllib.error.HTTPError: https://api.telegram.org/bot123456789:AAH1x_fakeTokenValue0000000/editMessageText";
    const out = redactResolverDiagnostics(raw);
    expect(out).toContain("bot<redacted>");
    expect(out).not.toContain("AAH1x_fakeTokenValue0000000");
  });

  it("strips bearer credentials and leaves ordinary text alone", () => {
    expect(redactResolverDiagnostics("Authorization: Bearer abcdefghijklmnopqrst")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(redactResolverDiagnostics("ConnectionRefusedError: [Errno 111]")).toBe(
      "ConnectionRefusedError: [Errno 111]",
    );
  });
});

describe("describeResolverFailure", () => {
  // The four shapes execFile actually produces, confirmed against the real API:
  // a spawn failure reports a STRING code and no signal, a timeout reports
  // code null with a signal, an ordinary failure reports a numeric code.
  it("names a spawn failure instead of calling it an exit status", () => {
    expect(describeResolverFailure({ timedOut: false, signal: null, code: "ENOENT" })).toBe(
      "spawn error ENOENT",
    );
  });

  it("reports an ordinary non-zero exit as an exit status", () => {
    expect(describeResolverFailure({ timedOut: false, signal: null, code: 3 })).toBe("exit 3");
  });

  it("prefers the timeout over the code the kill left behind", () => {
    expect(describeResolverFailure({ timedOut: true, signal: "SIGTERM", code: null })).toBe(
      "timed out",
    );
  });

  it("names the signal when the process was killed but not by the timeout", () => {
    expect(describeResolverFailure({ timedOut: false, signal: "SIGKILL", code: null })).toBe(
      "killed by SIGKILL",
    );
  });
});
