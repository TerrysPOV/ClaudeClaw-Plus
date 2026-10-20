import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBootId,
  pidIdentity,
  procStartMs,
  processStartMs,
  readBootId,
  recordedOnAnotherBoot,
  sameStart,
  TEST_BOOT_ID,
} from "./pty-proc-identity.js";
import { withPlatform } from "./pty-test-platform.js";

/** #570 r14 (E): on Linux the start time comes from `/proc/<pid>/stat` field 22, not from `ps`. */

describe("procStartMs (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const stat = (pid: number, text: string): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "stat"), text);
  };
  // Fields 3..22 after the command: state, ppid, pgrp, session, tty, tpgid, flags, minflt,
  // cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice, threads, itreal, starttime.
  const AFTER = "S 1 123 123 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 12345 99999 8888";

  it("reads field 22 (ticks since boot) as milliseconds", () => {
    stat(123, `123 (sleep) ${AFTER}\n`);
    // Went red (0) with field 21 read instead of field 22.
    expect(procStartMs(123, proc)).toBe(123_450);
  });

  it("is not thrown by a command name with spaces and parentheses", () => {
    stat(124, `124 (a) b) (c d) ${AFTER}\n`);
    expect(procStartMs(124, proc)).toBe(123_450);
  });

  it("is null for a pid that is gone, and for a stat it cannot parse", () => {
    expect(procStartMs(999, proc)).toBeNull();
    stat(125, "125 (x) S 1\n");
    expect(procStartMs(125, proc)).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("processStartMs on Linux", () => {
  it("is the /proc reading, and is steady across reads", () => {
    const first = processStartMs(process.pid);
    expect(first).not.toBeNull();
    expect(first).toBe(procStartMs(process.pid));
    expect(processStartMs(process.pid)).toBe(first);
  });
});

/** #570 r14e (H1): a `/proc` start time is exact, so any window only lets a recycled pid read as the same. */
describe("sameStart", () => {
  it("compares Linux /proc start times exactly: the next tick is another process", () => {
    expect(sameStart(10_000, 10_000, "linux")).toBe(true);
    // Went red (true) with `<= 10` put back on the Linux path.
    expect(sameStart(10_000, 10_010, "linux")).toBe(false);
    expect(sameStart(10_010, 10_000, "linux")).toBe(false);
    expect(sameStart(10_000, 11_000, "linux")).toBe(false);
  });

  it("keeps 2 s for `ps -o lstart=`, which has one-second resolution", () => {
    expect(sameStart(10_000, 11_000, "darwin")).toBe(true);
    expect(sameStart(10_000, 12_001, "darwin")).toBe(false);
  });

  it("takes the platform from the process by default", () => {
    expect(withPlatform("linux", () => sameStart(10_000, 11_000))).toBe(false);
    expect(withPlatform("darwin", () => sameStart(10_000, 11_000))).toBe(true);
  });
});

describe("pidIdentity on Linux", () => {
  const exists = () => true;
  it("calls a pid whose start moved by one second recycled", () => {
    const read = () => 11_000;
    expect(withPlatform("linux", () => pidIdentity(4242, 10_000, { exists, read }))).toBe(
      "recycled",
    );
    expect(withPlatform("darwin", () => pidIdentity(4242, 10_000, { exists, read }))).toBe("same");
  });
});

// #570 r15 (A1): Linux start times count from boot, so a persisted one is comparable only on the
// boot that wrote it. The boot id is stored beside it and checked first.
describe("recordedOnAnotherBoot", () => {
  const boot = (id: string | null) => ({ platform: "linux", bootId: () => id });

  it("same boot id: not another boot", () => {
    expect(recordedOnAnotherBoot("boot-A", boot("boot-A"))).toBe(false);
  });

  it("different boot id: another boot", () => {
    expect(recordedOnAnotherBoot("boot-A", boot("boot-B"))).toBe(true);
  });

  it("a Linux record with no boot id predates the field: another boot", () => {
    expect(recordedOnAnotherBoot(null, boot("boot-B"))).toBe(true);
    expect(recordedOnAnotherBoot(undefined, boot("boot-B"))).toBe(true);
  });

  it("this boot's id unreadable: nothing can be shown to differ", () => {
    expect(recordedOnAnotherBoot("boot-A", boot(null))).toBe(false);
    expect(recordedOnAnotherBoot(null, boot(null))).toBe(false);
  });

  it("off Linux there is no boot id to compare (ps lstart is epoch time)", () => {
    for (const platform of ["darwin", "freebsd"]) {
      expect(recordedOnAnotherBoot(null, { platform, bootId: () => "boot-B" })).toBe(false);
      expect(recordedOnAnotherBoot("boot-A", { platform, bootId: () => "boot-B" })).toBe(false);
    }
  });
});

describe("readBootId / currentBootId", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-id-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the id with its trailing newline removed", () => {
    const file = join(dir, "boot_id");
    writeFileSync(file, "6f1c2f64-0d0a-4a52-9d3b-2a0f6b7c1e11\n");
    expect(readBootId(file)).toBe("6f1c2f64-0d0a-4a52-9d3b-2a0f6b7c1e11");
  });

  it("is null for a missing or empty file", () => {
    expect(readBootId(join(dir, "none"))).toBeNull();
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    expect(readBootId(empty)).toBeNull();
  });

  it("is null off Linux", () => {
    expect(currentBootId("darwin")).toBeNull();
  });
});

// #570 r15b: CLAUDECLAW_TEST_PLATFORM=linux runs the boot-id branch on a Mac. It must change only
// the seam defaults, and only under NODE_ENV=test.
describe("the test-only Linux switch", () => {
  const saved = {
    platform: process.env.CLAUDECLAW_TEST_PLATFORM,
    nodeEnv: process.env.NODE_ENV,
  };
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore("CLAUDECLAW_TEST_PLATFORM", saved.platform);
    restore("NODE_ENV", saved.nodeEnv);
  });

  it("on: the defaults act as Linux with the fixed boot id", () => {
    process.env.NODE_ENV = "test";
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    expect(readBootId()).toBe(TEST_BOOT_ID);
    expect(currentBootId()).toBe(TEST_BOOT_ID);
    expect(recordedOnAnotherBoot(null)).toBe(true); // no boot id: from before the field
    expect(recordedOnAnotherBoot("some-other-boot")).toBe(true);
    expect(recordedOnAnotherBoot(TEST_BOOT_ID)).toBe(false);
  });

  it("on: an explicit path or platform still wins", () => {
    process.env.NODE_ENV = "test";
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    expect(readBootId("/nonexistent/boot_id")).toBeNull();
    expect(currentBootId("darwin")).toBeNull();
    expect(recordedOnAnotherBoot(null, { platform: "darwin" })).toBe(false);
  });

  it("off, or outside NODE_ENV=test: the real platform decides", () => {
    delete process.env.CLAUDECLAW_TEST_PLATFORM;
    expect(currentBootId()).toBe(currentBootId(process.platform));
    // On Linux the line above compares a call with itself; this one fails if the switch leaks.
    expect(currentBootId()).not.toBe(TEST_BOOT_ID);
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    process.env.NODE_ENV = "production";
    expect(readBootId()).not.toBe(TEST_BOOT_ID);
    expect(currentBootId()).not.toBe(TEST_BOOT_ID);
  });
});
