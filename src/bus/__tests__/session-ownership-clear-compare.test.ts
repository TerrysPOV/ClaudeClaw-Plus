/**
 * #596 round 11: `store.clear` compares the on-disk record with the one the caller names before it
 * deletes. A compare-read that FAILS (EIO, EACCES, a malformed record, the store timeout) is not "no
 * record": before this round it was swallowed into `null`, so a delayed clear from an old process
 * deleted the record its replacement had just written, and the next restart resumed beside the
 * replacement still running. Only a true ENOENT counts as absent.
 *
 * Every test runs on an in-memory file system and a `FakeClock`; nothing touches the disk or waits
 * on the wall clock.
 */
import { describe, expect, it } from "bun:test";
import {
  confirmGoneAndClear,
  confirmRetired,
  createFileOwnershipStore,
  OwnershipStoreTimeoutError,
  type StoreFs,
} from "../session-ownership";
import { FakeClock, FakeProbe, manual, recordFor } from "./ownership-fakes";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const DIR = "/agents";
const OWNER = `${DIR}/a/owner.json`;
const errno = (code: string): Error => Object.assign(new Error(code), { code });

/** An in-memory file system. `readFault` makes `readFile` fail; `removed` lists every `rm`. */
function memFs(files: Record<string, string> = {}) {
  const state = {
    files: new Map(Object.entries(files)),
    readFault: null as null | (() => Promise<string>),
    removed: [] as string[],
  };
  const fs: StoreFs = {
    readFile: async (path) => {
      if (state.readFault) return state.readFault();
      const raw = state.files.get(path);
      if (raw === undefined) throw errno("ENOENT");
      return raw;
    },
    writeFile: async (path, data) => {
      state.files.set(path, data);
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      state.files.set(to, state.files.get(from) ?? "");
      state.files.delete(from);
    },
    rm: async (path) => {
      state.removed.push(path);
      state.files.delete(path);
    },
  };
  return { state, fs };
}

const storeOn = (fs: StoreFs, clock = new FakeClock()) =>
  createFileOwnershipStore(
    () => DIR,
    () => "t",
    { opMs: 500, clock, fs },
  );

const json = (over: Parameters<typeof recordFor>[0] = {}): string =>
  `${JSON.stringify(recordFor(over))}\n`;

const OLD = { pid: 900, identity: "T1" };

describe("store.clear: a failed compare-read is never 'absent' (#596 r11)", () => {
  for (const code of ["EIO", "EACCES"]) {
    it(`${code} on the compare-read rejects and keeps the record`, async () => {
      // Fault (site: `await load(agentId)` in `clear`, back to `.catch(() => null)`): the failure
      // reads as "no record" and the file is removed. Predicted result: `removed` holds OWNER.
      const { state, fs } = memFs({ [OWNER]: json(OLD) });
      state.readFault = () => Promise.reject(errno(code));
      await expect(storeOn(fs).clear("a", OLD)).rejects.toMatchObject({ code });
      expect(state.removed).toEqual([]);
      expect(state.files.has(OWNER)).toBe(true);
    });
  }

  it("a malformed record rejects and is kept", async () => {
    const { state, fs } = memFs({ [OWNER]: "{not json" });
    await expect(storeOn(fs).clear("a", OLD)).rejects.toThrow();
    expect(state.removed).toEqual([]);
    expect(state.files.get(OWNER)).toBe("{not json");
  });

  it("a record that names another agent rejects and is kept", async () => {
    const { state, fs } = memFs({ [OWNER]: json({ agentId: "b" }) });
    await expect(storeOn(fs).clear("a", OLD)).rejects.toThrow();
    expect(state.removed).toEqual([]);
  });

  it("a compare-read that times out rejects with the store timeout, and a late answer deletes nothing", async () => {
    const clock = new FakeClock();
    const { state, fs } = memFs({ [OWNER]: json(OLD) });
    const stalled = manual<string>();
    state.readFault = () => stalled.promise;
    const outcome: { error?: unknown } = {};
    const clear = storeOn(fs, clock)
      .clear("a", OLD)
      .catch((e) => {
        outcome.error = e;
      });
    await clock.armed();
    clock.advance(500);
    await clear;
    expect(outcome.error).toBeInstanceOf(OwnershipStoreTimeoutError);

    stalled.resolve(json(OLD)); // the stalled read now reports a MATCHING record
    await flush();
    expect(state.removed).toEqual([]);
    expect(state.files.has(OWNER)).toBe(true);
  });

  it("ENOENT is a true 'no record': the clear succeeds", async () => {
    const { state, fs } = memFs();
    await expect(storeOn(fs).clear("a", OLD)).resolves.toBeUndefined();
    expect(state.files.size).toBe(0);
  });

  it("a matching record is removed", async () => {
    const { state, fs } = memFs({ [OWNER]: json(OLD) });
    await storeOn(fs).clear("a", OLD);
    expect(state.removed).toEqual([OWNER]);
    expect(state.files.has(OWNER)).toBe(false);
  });

  it("a non-matching record is kept", async () => {
    const { state, fs } = memFs({ [OWNER]: json({ pid: 901, identity: "T2" }) });
    await storeOn(fs).clear("a", OLD);
    expect(state.removed).toEqual([]);
    expect(state.files.has(OWNER)).toBe(true);
  });
});

describe("a delayed clear from the old process cannot delete its replacement's record (#596 r11)", () => {
  const replacement = { pid: 901, identity: "T2" };
  const lines: string[] = [];
  const logger = { warn: (m: string) => void lines.push(m) };

  /** The replacement has written its record; the old process's confirmation arrives late, read failing. */
  const scene = () => {
    lines.length = 0;
    const { state, fs } = memFs({ [OWNER]: json(replacement) });
    state.readFault = () => Promise.reject(errno("EIO"));
    return { state, store: storeOn(fs) };
  };

  it("confirmGoneAndClear answers unknown, logs one reason-coded line, and the replacement's record survives", async () => {
    // Fault (site: `.catch(() => null)` restored in `clear`): the failed read is "absent" and the
    // replacement's file is removed. Predicted result: `removed` holds OWNER and the answer is "cleared".
    const { state, store } = scene();
    const answer = await confirmGoneAndClear({
      store,
      probe: new FakeProbe(), // the OLD process is gone, so only the clear is left
      record: recordFor(OLD),
      logger,
    });
    expect(answer).toBe("unknown");
    expect(state.removed).toEqual([]);
    expect(JSON.parse(state.files.get(OWNER) as string)).toMatchObject(replacement);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=ownership-clear-failed");
    expect(lines[0]).toContain("op=confirm-gone");
    expect(lines[0]).toContain("error=EIO");
  });

  it("confirmRetired does not report the retirement as recorded, logs once, and keeps the record", async () => {
    const { state, store } = scene();
    const ok = await confirmRetired({
      store,
      probe: new FakeProbe(),
      record: recordFor(OLD),
      logger,
    });
    expect(ok).toBe(false);
    expect(state.removed).toEqual([]);
    expect(state.files.has(OWNER)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("op=confirm-retired");
  });
});
