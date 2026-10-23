/**
 * #595 round 10: one file operation of the ownership store that never settles must not hold the
 * operations queued behind it.
 *
 * The store serialises operations per agent. Before round 10 the queue stayed attached to the raw
 * `readFile` / `writeFile`: the caller's own deadline expired, but the next operation for that agent
 * (a rotated spawn's record write, the `store.clear` of a failed spawn's retirement) waited behind the
 * stalled call for good. Every operation here runs on a `FakeClock` and a hand-settled fake file
 * system, so no test waits on, or measures, the wall clock.
 */
import { describe, expect, it } from "bun:test";
import {
  CLEAR_BOUND_MS,
  confirmGoneAndClear,
  confirmRetired,
  createFileOwnershipStore,
  OwnershipStoreTimeoutError,
  type OwnershipStore,
  STORE_OP_MS,
  type StoreFs,
} from "../session-ownership";
import { FakeClock, FakeProbe, manual, recordFor } from "./ownership-fakes";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const enoent = (): Error => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const DIR = "/agents";
const OP = 500;

/** A file system whose every call answers at once (nothing on disk) unless a test overrides it. */
const fsWith = (over: Partial<StoreFs> = {}): StoreFs => ({
  readFile: async () => {
    throw enoent();
  },
  writeFile: async () => {},
  mkdir: async () => undefined,
  rename: async () => {},
  rm: async () => {},
  ...over,
});

const storeOn = (clock: FakeClock, fs: StoreFs) =>
  createFileOwnershipStore(
    () => DIR,
    () => "t",
    { opMs: OP, clock, fs },
  );

/** Observe a promise without awaiting it. */
const watch = <T>(p: Promise<T>) => {
  const seen: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(seen, { done: true, value }),
    (error) => Object.assign(seen, { done: true, error }),
  );
  return seen;
};

describe("the file ownership store bounds every operation (#595 r10)", () => {
  it("the shipped per-operation bound is shorter than every bound a caller puts around it", () => {
    expect(STORE_OP_MS).toBe(2000);
    expect(CLEAR_BOUND_MS).toBe(3 * STORE_OP_MS);
  });

  it("a read that never settles times out at the bound as an error, and the NEXT read for the agent proceeds", async () => {
    // Fault (site: the queue tail in `serial`, re-attached to the raw file call): the second read
    // waits behind the stalled first one for good. Predicted result: `second` never settles.
    const clock = new FakeClock();
    const stalled = manual<string>();
    let calls = 0;
    const store = storeOn(
      clock,
      fsWith({
        readFile: () => {
          calls++;
          if (calls === 1) return stalled.promise;
          return Promise.reject(enoent());
        },
      }),
    );
    const first = watch(store.read("a"));
    const second = watch(store.read("a"));
    await clock.armed();
    clock.advance(OP - 1);
    await flush();
    expect(first.done).toBe(false);

    clock.advance(1);
    await flush();
    // A timeout is an error. It is never `null` ("no record"), which would let a restart resume.
    expect(first.done).toBe(true);
    expect(first.error).toBeInstanceOf(OwnershipStoreTimeoutError);
    expect(first.value).toBeUndefined();
    // The second read was released by the first one's bound and ran: ENOENT is a real "no record".
    expect(second.done).toBe(true);
    expect(second.value).toBeNull();
    expect(calls).toBe(2);
  });

  it("the queued operation gets its own full bound, counted from when it starts", async () => {
    // Fault (site: the timer in `bounded`, armed when the operation is QUEUED rather than when it
    // starts): the queued read inherits the stalled one's elapsed time and times out as it starts.
    // Predicted result: `next` rejects with a timeout.
    const clock = new FakeClock();
    const stalled = manual<string>();
    const second = manual<string>();
    let calls = 0;
    const store = storeOn(
      clock,
      fsWith({ readFile: () => (++calls === 1 ? stalled.promise : second.promise) }),
    );
    const first = watch(store.read("a"));
    const next = watch(store.read("a"));
    await clock.armed();
    clock.advance(OP);
    await flush();
    expect(first.error).toBeInstanceOf(OwnershipStoreTimeoutError);
    expect(next.done).toBe(false); // started at OP, so it has until 2 * OP

    clock.advance(OP - 1);
    await flush();
    expect(next.done).toBe(false);
    second.reject(enoent());
    await flush();
    expect(next.value).toBeNull();
  });

  it("a write that outlives its bound publishes nothing when the file system finally answers", async () => {
    // Fault (site: the `assertLive` before `rename` in `write`, removed): the late write renames
    // its temp file over whatever came after it. Predicted result: `renames` holds one entry.
    const clock = new FakeClock();
    const stalled = manual<void>();
    const issued = manual<void>();
    const renames: string[] = [];
    const removed: string[] = [];
    const store = storeOn(
      clock,
      fsWith({
        writeFile: () => {
          issued.resolve();
          return stalled.promise;
        },
        rename: async (from) => {
          renames.push(from);
        },
        rm: async (path) => {
          removed.push(path);
        },
      }),
    );
    const write = watch(store.write(recordFor()));
    await issued.promise; // the stalled write is out (its bound is armed)
    clock.advance(OP);
    await flush();
    expect(write.error).toBeInstanceOf(OwnershipStoreTimeoutError);

    stalled.resolve(); // the stalled write completes long after its caller was told it failed
    await flush();
    expect(renames).toEqual([]);
    expect(removed).toEqual([`${DIR}/a/owner.json.t.tmp`]); // its temp file is cleaned up, not published
  });

  it("a stalled mkdir that answers late writes no temp file", async () => {
    // Fault (site: the `assertLive` after `mkdir` in `write`, removed): the late write creates its
    // temp file. Predicted result: `writes` holds the temp path.
    const clock = new FakeClock();
    const stalled = manual<undefined>();
    const writes: string[] = [];
    const store = storeOn(
      clock,
      fsWith({
        mkdir: () => stalled.promise,
        writeFile: async (path) => {
          writes.push(path);
        },
      }),
    );
    const write = watch(store.write(recordFor()));
    await clock.armed();
    clock.advance(OP);
    await flush();
    expect(write.error).toBeInstanceOf(OwnershipStoreTimeoutError);
    stalled.resolve(undefined);
    await flush();
    expect(writes).toEqual([]);
  });

  it("a clear whose read outlives its bound deletes nothing, and a newer record written after it survives", async () => {
    // Fault (site: the `assertLive` after the read in `clear`, removed): the late clear removes the
    // file the next spawn's write just published. Predicted result: `removed` holds the owner path.
    const clock = new FakeClock();
    const stalled = manual<string>();
    const removed: string[] = [];
    const renames: string[] = [];
    let reads = 0;
    const store = storeOn(
      clock,
      fsWith({
        readFile: () => (++reads === 1 ? stalled.promise : Promise.reject(enoent())),
        rename: async (from) => {
          renames.push(from);
        },
        rm: async (path) => {
          removed.push(path);
        },
      }),
    );
    const old = recordFor({ pid: 900, identity: "T1" });
    const clear = watch(store.clear("a", { pid: 900, identity: "T1" }));
    const newer = watch(store.write(recordFor({ pid: 901, identity: "T2" })));
    await clock.armed();
    clock.advance(OP);
    await flush();
    expect(clear.error).toBeInstanceOf(OwnershipStoreTimeoutError);
    expect(newer.done).toBe(true); // the write ran and published once the clear was let go
    expect(newer.error).toBeUndefined();
    expect(renames).toHaveLength(1);

    stalled.resolve(JSON.stringify(old)); // the stalled read now reports the OLD record
    await flush();
    expect(removed).toEqual([]);
  });

  it("an operation that settles in time is untouched by the bound, and leaves no timer behind", async () => {
    const clock = new FakeClock();
    const store = storeOn(clock, fsWith());
    expect(await store.read("a")).toBeNull();
    await store.write(recordFor());
    expect(clock.pending).toBe(0);
  });
});

describe("the failure path cannot hang on a stalled clear (#595 r10)", () => {
  const record = recordFor();
  const stalledClear = (): OwnershipStore => ({
    read: async () => null,
    write: async () => {},
    clear: () => new Promise(() => {}),
  });

  it("confirmRetired returns false at the clear bound when the clear never settles", async () => {
    // Fault (site: the `withDeadline` around `store.clear` in `confirmRetired`, removed): the
    // retirement awaits the clear forever. Predicted result: the call does not return.
    const clock = new FakeClock();
    const done = watch(
      confirmRetired({
        store: stalledClear(),
        probe: new FakeProbe(), // the process is gone: only the clear is left
        record,
        clearMs: 300,
        clock,
      }),
    );
    await clock.armed();
    clock.advance(299);
    await flush();
    expect(done.done).toBe(false);
    clock.advance(1);
    await flush();
    expect(done.done).toBe(true);
    expect(done.value).toBe(false); // unconfirmed: the record stays for the next start to see
    expect(clock.now()).toBe(300);
  });

  it("confirmGoneAndClear answers unknown at the clear bound", async () => {
    const clock = new FakeClock();
    const done = watch(
      confirmGoneAndClear({
        store: stalledClear(),
        probe: new FakeProbe(),
        record,
        clearMs: 300,
        clock,
      }),
    );
    await clock.armed();
    clock.advance(300);
    await flush();
    expect(done.value).toBe("unknown");
  });

  it("end to end: a clear queued behind a stalled write runs once the write is let go, inside the clear bound", async () => {
    // Fault (site: the queue tail in `serial`, re-attached to the raw file call): the clear never
    // runs, so `confirmRetired` can only give up at its own bound. Predicted result: `removed`
    // stays empty and the call is still pending after the write's bound.
    const clock = new FakeClock();
    const stalled = manual<void>();
    const issued = manual<void>();
    const removed: string[] = [];
    const store = storeOn(
      clock,
      fsWith({
        writeFile: () => {
          issued.resolve();
          return stalled.promise;
        },
        rm: async (path) => {
          removed.push(path);
        },
      }),
    );
    const write = watch(store.write(recordFor()));
    const done = watch(
      confirmRetired({ store, probe: new FakeProbe(), record, clearMs: CLEAR_BOUND_MS, clock }),
    );
    await issued.promise; // the stalled write is out; the clear is queued behind it
    clock.advance(OP); // the write's bound passes; the clear starts
    await flush();
    expect(write.error).toBeInstanceOf(OwnershipStoreTimeoutError);
    expect(done.done).toBe(true);
    expect(done.value).toBe(true);
    expect(removed).toContain(`${DIR}/a/owner.json`);
    expect(clock.now()).toBeLessThan(CLEAR_BOUND_MS);
  });
});
