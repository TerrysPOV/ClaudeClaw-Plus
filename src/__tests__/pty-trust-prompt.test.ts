/**
 * Tests for the trust-prompt self-heal (issue #81 failure mode #1).
 *
 * Verifies that `ensureTrustAccepted` idempotently sets
 * `projects[<cwd>].hasTrustDialogAccepted: true` in ~/.claude.json.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTrustAccepted } from "../runner/pty-trust-prompt";

let tmpHome: string;
let configPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "claudeclaw-trust-test-"));
  configPath = join(tmpHome, ".claude.json");
});

afterEach(() => {
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("ensureTrustAccepted", () => {
  test("creates ~/.claude.json with the project entry when file is absent", async () => {
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.configPath).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
  });

  test("adds the project entry when ~/.claude.json exists but the cwd is absent", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { "/other": { hasTrustDialogAccepted: true } } }, null, 2),
    );

    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    // Old entries are preserved.
    expect(raw.projects["/other"]?.hasTrustDialogAccepted).toBe(true);
  });

  test("is idempotent: returns changed=false when already true", async () => {
    const cwd = "/home/test/project";
    await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    const res2 = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });

    expect(res2.ok).toBe(true);
    expect(res2.changed).toBe(false);
  });

  test("flips an explicit `false` to true (operator may have edited the file)", async () => {
    const cwd = "/home/test/project";
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          projects: {
            [cwd]: { hasTrustDialogAccepted: false, customField: "preserved" },
          },
        },
        null,
        2,
      ),
    );

    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean; customField?: string }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    // Other fields are preserved.
    expect(raw.projects[cwd]?.customField).toBe("preserved");
  });

  test("resolves the cwd to an absolute path before using it as a key", async () => {
    // Pass a relative path. The function should resolve it (relative to
    // process.cwd()) so the key matches what claude itself would record.
    const res = await ensureTrustAccepted(".", { homedir: () => tmpHome });
    expect(res.ok).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    const keys = Object.keys(raw.projects);
    expect(keys.length).toBe(1);
    // The recorded key must be an absolute path.
    expect(keys[0]!.startsWith("/")).toBe(true);
  });

  test("refuses to overwrite a malformed ~/.claude.json (surfaces non-fatal error)", async () => {
    writeFileSync(configPath, "{ not valid json");
    const res = await ensureTrustAccepted("/home/test/project", {
      homedir: () => tmpHome,
    });
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(false);
    expect(res.reason).toContain("malformed JSON");
    // The malformed file is left in place — operator must fix it.
    expect(readFileSync(configPath, "utf-8")).toBe("{ not valid json");
  });

  test("honours an explicit configPath override", async () => {
    const altPath = join(tmpHome, "alt-config.json");
    const res = await ensureTrustAccepted("/home/test/project", { configPath: altPath });
    expect(res.ok).toBe(true);
    expect(res.configPath).toBe(altPath);
    expect(existsSync(altPath)).toBe(true);
  });

  test("preserves unrelated top-level fields in ~/.claude.json", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          userId: "abc",
          someOtherTopLevel: { keep: "me" },
          projects: {},
        },
        null,
        2,
      ),
    );

    const res = await ensureTrustAccepted("/home/test/project", {
      homedir: () => tmpHome,
    });
    expect(res.ok).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      userId: string;
      someOtherTopLevel: { keep: string };
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.userId).toBe("abc");
    expect(raw.someOtherTopLevel.keep).toBe("me");
    expect(raw.projects["/home/test/project"]?.hasTrustDialogAccepted).toBe(true);
  });

  // Codex PR #82 P1 regression — concurrent ensureTrustAccepted calls for
  // different cwds against the same ~/.claude.json must NOT race the
  // read-modify-write. Pre-fix, last-writer-wins silently dropped one
  // cwd's trust flag. Production trigger: multiple PTY spawns for
  // different session keys run in parallel and all hit the same config
  // path.
  test("serialises concurrent writes for different cwds — no lost updates", async () => {
    writeFileSync(configPath, JSON.stringify({ userId: "concurrent-test", projects: {} }, null, 2));

    const cwds = [
      "/home/test/project-a",
      "/home/test/project-b",
      "/home/test/project-c",
      "/home/test/project-d",
      "/home/test/project-e",
    ];

    // Fire all five concurrently. Without the mutex, at least one of the
    // five updates would be lost (last-writer-wins on the read-modify-write).
    const results = await Promise.all(
      cwds.map((cwd) => ensureTrustAccepted(cwd, { homedir: () => tmpHome })),
    );

    // Every call should succeed.
    for (const r of results) expect(r.ok).toBe(true);

    // Final file MUST contain all five cwds with the flag set, plus the
    // seeded top-level field preserved.
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      userId: string;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.userId).toBe("concurrent-test");
    for (const cwd of cwds) {
      expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    }
  });
  // Issue #528: the bus spawn path heals the operator's real ~/.claude.json.
  test("keeps the file's 0600 mode when rewriting it", async () => {
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    chmodSync(configPath, 0o600);
    const res = await ensureTrustAccepted("/home/test/project", { homedir: () => tmpHome });
    expect(res.changed).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("creates a missing file 0600", async () => {
    await ensureTrustAccepted("/home/test/project", { homedir: () => tmpHome });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("writes through a symlinked ~/.claude.json and leaves the link in place", async () => {
    const real = join(tmpHome, "volume-claude.json");
    writeFileSync(real, JSON.stringify({ projects: {} }));
    chmodSync(real, 0o600);
    symlinkSync(real, configPath);
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    const raw = JSON.parse(readFileSync(real, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });
  test("a dangling symlink (link into a fresh volume) gets its target created, link kept", async () => {
    symlinkSync("volume/claude.json", configPath); // relative, target dir exists, file not yet
    mkdirSync(join(tmpHome, "volume"));
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    const real = join(tmpHome, "volume", "claude.json");
    const raw = JSON.parse(readFileSync(real, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  // A running claude rewrites ~/.claude.json under `<file>.lock` (mkdir lock,
  // read, write, rmdir). A heal that skips the lock lands between claude's
  // read and its write and is dropped — measured against claude 2.1.296 and
  // 2.1.303 with four live REPLs: 9-12 of 200 heals lost.
  test("waits for claude's .lock and keeps its entry when claude writes a stale snapshot", async () => {
    writeFileSync(configPath, JSON.stringify({ numStartups: 1, projects: {} }, null, 2));
    const lockPath = `${configPath}.lock`;
    // claude takes the lock and reads the file...
    mkdirSync(lockPath);
    const snapshot = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const cwd = "/tmp/ccaw-probe-lock";
    const heal = ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    // Held past the re-check window, so only the lock (not the re-check)
    // can keep the heal from landing before claude's write.
    await Bun.sleep(700);
    // ...then writes its (stale) snapshot back and releases the lock.
    writeFileSync(configPath, JSON.stringify({ ...snapshot, numStartups: 2 }, null, 2));
    rmdirSync(lockPath);
    const res = await heal;
    expect(res.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      numStartups: number;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.numStartups).toBe(2);
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
  test("removes a stale .lock left by a crashed writer and still heals", async () => {
    const lockPath = `${configPath}.lock`;
    mkdirSync(lockPath);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
  test("a stale .lock it cannot remove does not hang the heal", async () => {
    const lockPath = `${configPath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "keep"), ""); // rmdir fails: ENOTEMPTY
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const cwd = "/home/test/project";
    const res = await ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    expect(res.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    expect(existsSync(join(lockPath, "keep"))).toBe(true);
  }, 3000);
  // claude's exit path rewrites ~/.claude.json without the lock (read, then
  // write): a heal landing in between is dropped and must be put back.
  test("re-heals when an unlocked writer drops the entry right after the heal", async () => {
    writeFileSync(configPath, JSON.stringify({ numStartups: 1, projects: {} }, null, 2));
    const snapshot = readFileSync(configPath, "utf-8"); // read before the heal
    const cwd = "/tmp/ccaw-probe-exit";
    const heal = ensureTrustAccepted(cwd, { homedir: () => tmpHome });
    for (let i = 0; i < 200 && !readFileSync(configPath, "utf-8").includes(cwd); i++) {
      await Bun.sleep(5);
    }
    writeFileSync(configPath, snapshot); // ...written back after it
    const res = await heal;
    expect(res.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(raw.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
  });
  test("reports ok:false when another writer keeps dropping the flag", async () => {
    writeFileSync(configPath, JSON.stringify({ projects: {} }, null, 2));
    const snapshot = readFileSync(configPath, "utf-8");
    const cwd = "/tmp/ccaw-probe-dropped";
    let done = false;
    const heal = ensureTrustAccepted(cwd, { homedir: () => tmpHome }).finally(() => {
      done = true;
    });
    while (!done) {
      if (readFileSync(configPath, "utf-8").includes(cwd)) writeFileSync(configPath, snapshot);
      await Bun.sleep(5);
    }
    const res = await heal;
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("dropped");
  });
});
