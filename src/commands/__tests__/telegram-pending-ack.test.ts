import { describe, it, expect } from "bun:test";
import {
  ackForAlready,
  ackForResolution,
  decisionStripsKeyboard,
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

  it("omits the timestamp when absent or unparseable", () => {
    expect(ackForAlready("already:approve")).toBe("✅ Déjà approuvé");
    expect(ackForAlready("already:approve:not-a-date")).toBe("✅ Déjà approuvé");
  });

  it("reports an unknown decision instead of calling it approved", () => {
    // This assertion is the reverse of the one it replaces, deliberately. The
    // old test asserted that an unrecognised decision defaults to "Déjà
    // approuvé" — "informative, not alarming". That default is the defect: the
    // decision vocabulary is not owned here, and the live database holds 39
    // distinct values. Answering "approved" to a value this layer has never
    // seen is not informative, it is a guess presented as a fact.
    expect(ackForAlready("already:done:2026-07-16T11:51:00")).toBe(
      "↩︎ Déjà traité — done (16/07 11:51)",
    );
  });

  it("does not call a refusal an approval, in either ack path", () => {
    // `refuse` runs `tuner refuse`, which blocks the pattern for 30 days, and
    // its button reads "je le refuse pour 30 jours". It reached the default
    // branch, so both paths answered approved. Telling someone their refusal
    // was approved is the sharpest form of this bug.
    expect(ackForResolution("ok", "refuse")).toBe("❌ Rejeté");
    expect(ackForAlready("already:refuse:2026-07-16T11:51:00")).toBe(
      "❌ Déjà rejeté (16/07 11:51)",
    );
  });

  it("does not call a look at the details a decision", () => {
    // `details` deliberately leaves the action pending — it shows something and
    // decides nothing. Acking it as approved reported a decision that was never
    // taken.
    expect(ackForResolution("ok", "details")).toBe("👀 Consulté");
    expect(ackForAlready("already:details:2026-07-16T11:51:00")).toBe(
      "👀 Déjà consulté (16/07 11:51)",
    );
  });

  it("answers `discuss` the same way in both paths — the rule lived in one and not the other", () => {
    expect(ackForResolution("ok", "discuss")).toBe(
      "💬 Envoyé en discussion — réponds pour continuer",
    );
    expect(ackForAlready("already:discuss:2026-07-16T11:51:00")).toBe(
      "💬 Déjà envoyé en discussion (16/07 11:51)",
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
    // `discuss` does not apply the proposal — it routes to the discussion
    // handler, which opens a thread on it. Acking it as "Approuvé" would tell
    // the operator something that did not happen. Case-insensitive, because the
    // decision arrives from a callback payload that is not normalised.
    expect(ackForResolution("ok", "discuss")).toBe(
      "💬 Envoyé en discussion — réponds pour continuer",
    );
    expect(ackForResolution("ok", "DISCUSS")).toBe(
      "💬 Envoyé en discussion — réponds pour continuer",
    );
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

describe("decisionStripsKeyboard (#375)", () => {
  it("strips once a decision closed the action", () => {
    expect(decisionStripsKeyboard("ok", "approve")).toBe(true);
    expect(decisionStripsKeyboard("ok", "reject")).toBe(true);
    expect(decisionStripsKeyboard("ok", "discuss")).toBe(true);
    expect(decisionStripsKeyboard("ok", "something-the-resolver-accepted")).toBe(true);
  });

  it("strips when the buttons point at nothing (already resolved, unknown id)", () => {
    expect(decisionStripsKeyboard("already", "approve")).toBe(true);
    expect(decisionStripsKeyboard("not_found", "approve")).toBe(true);
  });

  it("keeps the keyboard for every value the classifier reads as informational or postponed", () => {
    // `details` leaves the action pending on purpose and `skip` keeps its
    // keyboard for a later tap; the other values share their ack class, and a
    // resolver that treats them as terminal strips the keyboard itself.
    expect(decisionStripsKeyboard("ok", "details")).toBe(false);
    expect(decisionStripsKeyboard("ok", "DETAILS")).toBe(false);
    expect(decisionStripsKeyboard("ok", "skip")).toBe(false);
    expect(decisionStripsKeyboard("ok", "later")).toBe(false);
  });

  it("never edits when the resolver gave no verdict", () => {
    expect(decisionStripsKeyboard("no_answer", "approve")).toBe(false);
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

describe("an unknown decision reads the same in both paths", () => {
  it("echoes one normalised form, whatever case the caller passed", () => {
    // The earlier tests all used a lowercase value, so they could not see this:
    // `ackForAlready` lower-cases while parsing and `ackForResolution` does not,
    // so the same decision printed two different ways depending only on which
    // path resolved it. Classification was never wrong — the display was.
    expect(ackForResolution("ok", "Done")).toBe("↩︎ Décision enregistrée — done");
    expect(ackForAlready("already:Done:2026-07-16T11:51:00")).toBe(
      "↩︎ Déjà traité — done (16/07 11:51)",
    );
    expect(ackForResolution("ok", "  DONE  ")).toBe("↩︎ Décision enregistrée — done");
  });
});
