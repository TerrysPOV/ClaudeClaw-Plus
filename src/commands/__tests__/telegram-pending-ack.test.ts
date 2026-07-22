import { describe, it, expect } from "bun:test";
import { ackForAlready } from "../telegram.js";

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
