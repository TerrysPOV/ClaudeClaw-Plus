/**
 * #474 — `bun test` must never append to the operator's live tuner audit file.
 *
 * `auditLog()` (security.ts) used to write straight to `AUDIT_PATH` under
 * `homedir()`, and the apply-pipeline suite builds its pipeline with that
 * default — every run added its `file_subject` / `apply-pipe-*` lines to the
 * real `~/.config/tuner/audit.jsonl`. The test preload now points
 * `TUNER_AUDIT_PATH` at a temp file; these guards fail when that isolation is
 * removed or when `auditLog()` stops honouring it.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDIT_PATH, auditLog, auditPath } from "../../../skills-tuner/core/security.js";

const sizeOf = (p: string): number => (existsSync(p) ? statSync(p).size : 0);

describe("tuner audit path isolation (#474)", () => {
  const saved = process.env.TUNER_AUDIT_PATH;
  let dir: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env.TUNER_AUDIT_PATH;
    else process.env.TUNER_AUDIT_PATH = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("a bun test run resolves the audit path outside the operator's HOME", () => {
    expect(process.env.TUNER_AUDIT_PATH).toBeTruthy();
    expect(auditPath()).not.toBe(AUDIT_PATH);
    expect(auditPath().startsWith(`${resolve(homedir())}/`)).toBe(false);
  });

  it("auditLog() appends to TUNER_AUDIT_PATH and leaves AUDIT_PATH untouched", () => {
    dir = mkdtempSync(join(tmpdir(), "tuner-audit-guard-"));
    const target = join(dir, "audit.jsonl");
    process.env.TUNER_AUDIT_PATH = target;
    const before = sizeOf(AUDIT_PATH);

    auditLog("wisecron_rollback", { subject: "guard_subject" });

    expect(sizeOf(AUDIT_PATH)).toBe(before);
    const lines = readFileSync(target, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "wisecron_rollback",
      subject: "guard_subject",
    });
  });

  it("without the override the default stays AUDIT_PATH", () => {
    delete process.env.TUNER_AUDIT_PATH;
    expect(auditPath()).toBe(AUDIT_PATH);
  });
});
