/**
 * #595 round 8: ONE gate before ANY signal.
 *
 * `confirmRetired` (`/clear`, a preserving restart, the cleanup after a failed ownership write) used
 * to SIGKILL on a bare start-identity match. On macOS without libproc that identity is only
 * second-precise, so a pid reused within the second was killed without the uid/argv checks
 * `decideResume` makes. Both paths now go through `mayAuthoriseSignal` (via `signalOwned`).
 *
 * Everything runs on a scripted probe and an in-memory store, with zero-length stages (`graceMs: 0`,
 * `killMs: 0`): one read per stage, no timer, no sleep.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmRetired,
  createFileOwnershipStore,
  mayAuthoriseSignal,
  type ProcessInfo,
  recordOwnership,
} from "../session-ownership";
import { claudeInfo, FakeProbe, MemoryStore, recordFor, SID, UID } from "./ownership-fakes";

const S = "Thu Oct 23 10:00:00 2026";
const MICRO = `${S}+111111`;

describe("confirmRetired signals only what mayAuthoriseSignal allows (#595 r9)", () => {
  const retire = async (
    rec: ReturnType<typeof recordFor>,
    live: ProcessInfo,
    dies = false,
  ): Promise<{ gone: boolean; kills: string[]; recordLeft: boolean }> => {
    const probe = new FakeProbe();
    const store = new MemoryStore();
    store.rec.set("a", rec);
    probe.table.set(rec.pid, live);
    if (dies) probe.onKill = (pid) => probe.table.delete(pid);
    const gone = await confirmRetired({
      store,
      probe,
      record: rec,
      graceMs: 0,
      killMs: 0,
      uid: UID,
    });
    return { gone, kills: probe.kills.map((k) => k.signal), recordLeft: store.rec.has("a") };
  };

  it("microsecond identity on both sides, uid and argv matching: SIGKILL, confirmed, record cleared", async () => {
    // The unchanged path. Fault (site: the `signalOwned` call in `confirmRetired`, removed): nothing
    // is ever signalled. Predicted result: `kills` is `[]` and `gone` is false.
    const r = await retire(recordFor({ identity: MICRO }), claudeInfo({ identity: MICRO }), true);
    expect(r).toEqual({ gone: true, kills: ["SIGKILL"], recordLeft: false });
  });

  it("a second-precise LIVE read is not signalled: unconfirmed, record kept", async () => {
    // Fault (site: `signalOwned`, `mayAuthoriseSignal` bypassed in `confirmRetired`, the round-7
    // behaviour): a pid reused within the second is killed. Predicted result: `kills` is `["SIGKILL"]`.
    const r = await retire(
      recordFor({ identity: S }),
      claudeInfo({ identity: S, lowPrecision: true }),
      true,
    );
    expect(r).toEqual({ gone: false, kills: [], recordLeft: true });
  });

  it("a second-precise RECORD is not signalled, even against a microsecond live read", async () => {
    // The precision bit rides in the record. Fault (site: `owned.lowPrecision` and the `includes("+")`
    // mismatch clause in `mayAuthoriseSignal`, both removed): the record's second-precision match
    // is enough to kill. Predicted result: `kills` is `["SIGKILL"]`.
    const flagged = await retire(
      recordFor({ identity: MICRO, lowPrecision: true }),
      claudeInfo({ identity: MICRO }),
      true,
    );
    expect(flagged).toEqual({ gone: false, kills: [], recordLeft: true });
    const mismatched = await retire(
      recordFor({ identity: S }),
      claudeInfo({ identity: MICRO }),
      true,
    );
    expect(mismatched).toEqual({ gone: false, kills: [], recordLeft: true });
  });

  it("high precision with a foreign uid is not signalled", async () => {
    const r = await retire(
      recordFor({ identity: MICRO }),
      claudeInfo({ identity: MICRO, uid: UID + 1 }),
      true,
    );
    expect(r).toEqual({ gone: false, kills: [], recordLeft: true });
  });

  it("high precision with an argv that no longer names the launched claude is not signalled", async () => {
    const r = await retire(
      recordFor({ identity: MICRO }),
      claudeInfo({ identity: MICRO, argv: ["claude", "--resume", "someone-elses-session"] }),
      true,
    );
    expect(r).toEqual({ gone: false, kills: [], recordLeft: true });
  });

  it("a process that is already gone is confirmed without any signal, whatever the record's precision", async () => {
    const probe = new FakeProbe();
    const store = new MemoryStore();
    const rec = recordFor({ identity: S, lowPrecision: true });
    store.rec.set("a", rec);
    // Not in the table: gone. A low-precision record still answers 'is it gone?'.
    const gone = await confirmRetired({
      store,
      probe,
      record: rec,
      graceMs: 0,
      killMs: 0,
      uid: UID,
    });
    expect(gone).toBe(true);
    expect(probe.kills).toEqual([]);
    expect(store.rec.has("a")).toBe(false);
  });
});

describe("mayAuthoriseSignal (#595 r9)", () => {
  const verdict = (rec: Partial<ReturnType<typeof recordFor>>, live: Partial<ProcessInfo>) =>
    mayAuthoriseSignal({ owned: recordFor(rec), live: claudeInfo(live), uid: UID });

  it("refuses in the order precision, uid, argv; authorises only when all three hold", () => {
    expect(verdict({ identity: MICRO }, { identity: MICRO })).toBeNull();
    expect(verdict({ identity: S }, { identity: S, lowPrecision: true, uid: UID + 1 })).toBe(
      "resume-identity-low-precision",
    );
    expect(verdict({ identity: MICRO }, { identity: MICRO, uid: UID + 1 })).toBe(
      "owner-uid-mismatch",
    );
    expect(
      verdict({ identity: MICRO }, { identity: MICRO, argv: ["claude", "--resume", "x"] }),
    ).toBe("owner-argv-mismatch");
  });
});

describe("the record carries the precision bit (#595 r9)", () => {
  it("recordOwnership stores lowPrecision when the identity read was second-precise, and only then", async () => {
    // Fault (site: the `lowPrecision` spread in `recordOwnership`, removed): a second-precise identity
    // is recorded as if it were precise. Predicted result: `low.lowPrecision` is undefined.
    const store = new MemoryStore();
    const probe = new FakeProbe();
    const base = { store, probe, agentId: "a", sessionId: SID, pid: 900, exe: "claude" };
    probe.table.set(900, claudeInfo({ identity: S, lowPrecision: true }));
    const low = await recordOwnership(base);
    expect(low?.lowPrecision).toBe(true);
    probe.table.set(900, claudeInfo({ identity: MICRO }));
    const precise = await recordOwnership(base);
    expect(precise).not.toBeNull();
    expect("lowPrecision" in (precise as object)).toBe(false);
  });

  it("the file store round-trips the bit and rejects a non-boolean one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccaw-r9-"));
    try {
      const file = createFileOwnershipStore(() => dir);
      await file.write(recordFor({ lowPrecision: true }));
      expect((await file.read("a"))?.lowPrecision).toBe(true);
      mkdirSync(join(dir, "b"), { recursive: true });
      writeFileSync(
        join(dir, "b", "owner.json"),
        JSON.stringify({ ...recordFor({ agentId: "b" }), lowPrecision: "yes" }),
      );
      await expect(file.read("b")).rejects.toThrow("unrecognised shape");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("one place signals (#595 r9), shape of the source", () => {
  // Comments stripped so prose that mentions `.kill(` cannot satisfy or break the count.
  const source = readFileSync(join(import.meta.dir, "..", "session-ownership.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("`ProcessProbe.kill` is called from `signalOwned` only, after the gate", () => {
    // Fault (a signal sent directly from a new path): the count rises above one. Predicted result: 2.
    const calls = [...source.matchAll(/\bprobe\.kill\(/g)];
    expect(calls).toHaveLength(1);
    const body = source.slice(source.indexOf("function signalOwned("));
    expect(body.indexOf("mayAuthoriseSignal(")).toBeGreaterThan(-1);
    expect(body.indexOf("mayAuthoriseSignal(")).toBeLessThan(body.indexOf("probe.kill("));
  });

  it("both signalling paths, `confirmRetired` and `decideResume`, call it", () => {
    // The declaration plus the two call sites.
    expect([...source.matchAll(/\bsignalOwned\(/g)]).toHaveLength(3);
    const retired = source.slice(
      source.indexOf("export async function confirmRetired("),
      source.indexOf("export type ResumeReason"),
    );
    expect(retired).toContain("signalOwned(");
    const decide = source.slice(source.indexOf("export async function decideResume("));
    expect(decide).toContain("signalOwned(");
  });
});
