/**
 * Boot-time credential readiness warnings (#514).
 *
 * Every fixture here is placeholder-shaped on purpose — the token bodies are
 * literally "placeholder-test-token" / "placeholder-short-lived-token" and
 * every timestamp is a round, obviously-synthetic constant. Nothing in this
 * file may be copied from, or resemble, a real credential store, and no test
 * here reads the real one.
 *
 * Run with: bun test src/bus/__tests__/credential-readiness.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCredentialReadiness,
  defaultCredentialsPath,
  enforceCredentialReadiness,
  formatDeadCredentialAlert,
  formatShadowedEnvTokenAlert,
  type CredentialGateIo,
} from "../credential-readiness";

// Placeholder token bodies. The oat01 prefix is load-bearing (it is the
// documented shape of a `claude setup-token` long-lived token, and what
// `shouldStripSpawnEnvKey` keys on); the body is deliberately inert.
// Split so a credential scanner does not flag an obviously-inert literal.
const OAT01_TOKEN = `sk-ant-oat01-${"placeholder-test-token"}`;
const SHORT_LIVED_TOKEN = "placeholder-short-lived-token";

// Synthetic clock. NOW sits between PAST and FUTURE.
const PAST = 1_600_000_000_000;
const NOW = 1_700_000_000_000;
const FUTURE = 1_800_000_000_000;

describe("checkCredentialReadiness", () => {
  let tempDir: string;
  let credPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "credential-readiness-test-"));
    credPath = join(tempDir, "placeholder-credentials.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeStore = (expiresAt: unknown, refreshTokenExpiresAt: unknown) =>
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { expiresAt, refreshTokenExpiresAt } }),
    );

  it("an oat01 env token with a DEAD on-disk store is env-token-shadowed, not using-env-token", () => {
    // This used to assert "using-env-token" on the theory that a long-lived
    // token makes the store's state irrelevant. It is NOT irrelevant —
    // interactive agents read the store's
    // `claudeAiOauth` login regardless of liveness, so a store holding one
    // (dead or not) shadows the env token and must be reported as such, not
    // waved through as "using-env-token".
    writeStore(PAST, PAST);

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("env-token-shadowed");
  });

  it("a short-lived env token is NOT sufficient — the store is consulted anyway", () => {
    writeStore(PAST, PAST);

    const result = checkCredentialReadiness({
      oauthTokenEnv: SHORT_LIVED_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("dead");
  });

  it("a missing store is no-store, not dead (dev box, fresh install)", () => {
    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: join(tempDir, "does-not-exist.json"),
      now: NOW,
    });

    expect(result.status).toBe("no-store");
  });

  it("LOAD-BEARING: an EXPIRED access token with a live refresh token is ok, not dead", () => {
    // Keying on `expiresAt` being in the past is the obvious design and the
    // wrong one: the access token's ~8h TTL is *expected* to read as expired
    // between refresh cycles, so that check fires constantly and harmlessly
    // and trains operators to ignore the warning. The check is on
    // refresh-token death instead — the state nothing can self-heal.
    //
    // If this test ever goes red by returning "dead", the gate has regressed
    // to the rejected design and will refuse normal boots. Do not "fix" it by
    // changing the expectation.
    writeStore(PAST, FUTURE);

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.expiresAt).toBe(PAST);
  });

  it("an expired REFRESH token is dead, and carries both timestamps", () => {
    writeStore(PAST, PAST);

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("dead");
    if (result.status === "dead") {
      expect(result.expiresAt).toBe(PAST);
      expect(result.refreshTokenExpiresAt).toBe(PAST);
    }
  });

  it("a refresh token expiring exactly now is NOT dead — the boundary is strictly-less-than", () => {
    writeStore(NOW, NOW);

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("ok");
  });

  it("malformed JSON degrades to no-store, never to dead", () => {
    // Fail-open on purpose: gating the daemon's boot on a parse quirk would
    // invent a new outage mode, which is exactly what this check must never do.
    writeFileSync(credPath, "{ this is not json");

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("no-store");
  });

  it("a store with no claudeAiOauth block degrades to no-store", () => {
    writeFileSync(credPath, JSON.stringify({ somethingElse: {} }));

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("no-store");
  });

  it("non-numeric timestamps degrade to no-store", () => {
    writeStore("not-a-number", "also-not-a-number");

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("no-store");
  });

  it("LOAD-BEARING: a finite but Date-unrepresentable timestamp degrades to no-store, not dead", () => {
    // Number.isFinite(1e100) is true — it only rejects NaN/Infinity, not
    // values outside Date's representable range. Left unguarded, this
    // classifies as "dead" and the caller's new Date(1e100).toISOString()
    // throws RangeError: Invalid Date, propagating out of
    // enforceCredentialReadiness and silently degrading the whole bus
    // runtime to legacy mode on a corrupt file — the opposite of what this
    // feature exists for.
    writeStore(1e100, -1e100);

    const result = checkCredentialReadiness({
      oauthTokenEnv: undefined,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("no-store");
    // Independent of the classifier's own verdict: prove the underlying
    // RangeError this guards against is real, not a hypothetical.
    expect(() => new Date(1e100).toISOString()).toThrow(RangeError);
  });

  it("an empty-string env token is treated as absent, not as a token", () => {
    writeStore(PAST, FUTURE);

    const result = checkCredentialReadiness({
      oauthTokenEnv: "",
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("ok");
  });
});

describe("checkCredentialReadiness — env-token-shadowed", () => {
  let tempDir: string;
  let credPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "credential-shadow-test-"));
    credPath = join(tempDir, "placeholder-credentials.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeStore = (expiresAt: unknown, refreshTokenExpiresAt: unknown) =>
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { expiresAt, refreshTokenExpiresAt } }),
    );

  it("a long-lived env token PLUS a store with a claudeAiOauth login is shadowed, with both times", () => {
    writeStore(PAST, FUTURE);

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("env-token-shadowed");
    if (result.status === "env-token-shadowed") {
      expect(result.expiresAt).toBe(PAST);
      expect(result.refreshTokenExpiresAt).toBe(FUTURE);
    }
  });

  it("the same, but with malformed times — shadowed is still reported, without the times", () => {
    // The REPL shadowing behaviour doesn't care whether the store's
    // timestamps parse; only whether a `claudeAiOauth` object exists.
    writeStore("not-a-number", "also-not-a-number");

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("env-token-shadowed");
    if (result.status === "env-token-shadowed") {
      expect(result.expiresAt).toBeUndefined();
      expect(result.refreshTokenExpiresAt).toBeUndefined();
    }
  });

  it("a Date-unrepresentable but finite time is dropped the same way `dead`/`ok` drop it", () => {
    writeStore(1e100, -1e100);

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("env-token-shadowed");
    if (result.status === "env-token-shadowed") {
      expect(result.expiresAt).toBeUndefined();
      expect(result.refreshTokenExpiresAt).toBeUndefined();
    }
  });

  it("a long-lived env token with a MISSING store file is using-env-token, not shadowed", () => {
    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: join(tempDir, "does-not-exist.json"),
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });

  it("a long-lived env token with UNPARSABLE JSON is using-env-token, not shadowed", () => {
    writeFileSync(credPath, "{ this is not json");

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });

  it("a long-lived env token with JSON that has no claudeAiOauth object is using-env-token, not shadowed", () => {
    writeFileSync(credPath, JSON.stringify({ somethingElse: {} }));

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });

  it("a claudeAiOauth ARRAY is not a login — using-env-token, not shadowed", () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: [] }));

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });

  it("a FIFO at the store path is not read (it would block boot forever)", () => {
    const fifo = join(tempDir, "placeholder-fifo");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo on this platform
    // A blocking read would hang this test until the runner's timeout.
    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: fifo,
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });

  it("an oversized file is not treated as a store", () => {
    const big = JSON.stringify({
      claudeAiOauth: { expiresAt: FUTURE, refreshTokenExpiresAt: FUTURE },
      pad: "x".repeat(2 * 1024 * 1024),
    });
    writeFileSync(credPath, big);

    const result = checkCredentialReadiness({
      oauthTokenEnv: OAT01_TOKEN,
      credentialsPath: credPath,
      now: NOW,
    });

    expect(result.status).toBe("using-env-token");
  });
});

describe("defaultCredentialsPath", () => {
  it("defaults to <home>/.claude/.credentials.json", () => {
    expect(defaultCredentialsPath({}, "/home/placeholder")).toBe(
      join("/home/placeholder", ".claude", ".credentials.json"),
    );
  });

  it("honours CLAUDE_CONFIG_DIR when set", () => {
    expect(
      defaultCredentialsPath({ CLAUDE_CONFIG_DIR: "/etc/placeholder-claude" }, "/home/placeholder"),
    ).toBe(join("/etc/placeholder-claude", ".credentials.json"));
  });

  it("the zero-argument form start.ts actually calls reads the real env and home", () => {
    // start.ts calls `defaultCredentialsPath()` with no arguments, so the
    // defaults are production code, not test scaffolding. Named fault:
    // dropping either default parameter (or reading the wrong env var) leaves
    // every injected-argument test above green and turns this red.
    const expected =
      typeof process.env.CLAUDE_CONFIG_DIR === "string" && process.env.CLAUDE_CONFIG_DIR.length > 0
        ? join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json")
        : join(homedir(), ".claude", ".credentials.json");

    expect(defaultCredentialsPath()).toBe(expected);
  });
});

describe("formatDeadCredentialAlert", () => {
  // Two DIFFERENT timestamps on purpose: a message that only ever renders one
  // of them would pass a single-value fixture by accident.
  const ACCESS_EXPIRY = 1_650_000_000_000;
  const message = formatDeadCredentialAlert(ACCESS_EXPIRY, PAST);

  it("names the failure and the exact refresh-token expiry as an ISO timestamp", () => {
    expect(message).toContain("[credentials] no valid path to authenticate:");
    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN is absent or short-lived");
    expect(message).toContain(`refresh token expired at ${new Date(PAST).toISOString()}`);
  });

  it("surfaces BOTH timestamps, not just the one that triggered the verdict", () => {
    // The check reads `expiresAt` too; an earlier version collected it and
    // never showed it to anyone. Named fault: dropping the first argument from
    // the rendered text turns this red and nothing else.
    expect(message).toContain(new Date(ACCESS_EXPIRY).toISOString());
    expect(message).toContain(new Date(PAST).toISOString());
  });

  it("says the daemon is starting anyway and what still works", () => {
    // The check does not refuse to start. A message that reads like a crash
    // report for a process that is running sends the operator hunting a dead
    // daemon. Named fault: reverting to the old fatal framing turns this red.
    expect(message).toContain("The daemon is starting anyway");
    expect(message).toContain("cron");
    expect(message).toContain("401");
    expect(message.toLowerCase()).not.toContain("refuses to start");
    expect(message.toLowerCase()).not.toContain("exiting");
  });

  it("gives the operator the full recovery loop", () => {
    expect(message).toContain("claude setup-token");
    expect(message).toContain("set CLAUDE_CODE_OAUTH_TOKEN to it");
    expect(message).toContain("docs/deploy-systemd-hardening.md");
    expect(message).toContain("Then restart the daemon.");
  });

  it("states the overwrite trap generically — no secrets-manager brand name", () => {
    expect(message).toContain("edit the secrets manager, not the file directly");
    expect(message).toContain("discarded on the next restart");
    // The trap is a class of problem, not one product's. Naming a
    // vendor would read as "this only applies to users of that one".
    expect(message.toLowerCase()).not.toContain("doppler");
  });
});

describe("formatShadowedEnvTokenAlert", () => {
  const STORE_PATH = "/home/placeholder/.claude/.credentials.json";
  const ACCESS_EXPIRY = 1_650_000_000_000;

  it("names the shadowing and the store path, with both ISO timestamps when present", () => {
    const message = formatShadowedEnvTokenAlert(STORE_PATH, ACCESS_EXPIRY, PAST);

    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN is set to a long-lived token");
    expect(message).toContain(STORE_PATH);
    expect(message).toContain("claude.ai login");
    expect(message).toContain(new Date(ACCESS_EXPIRY).toISOString());
    expect(message).toContain(new Date(PAST).toISOString());
  });

  it("omits the timestamp sentences entirely when the times are absent", () => {
    const message = formatShadowedEnvTokenAlert(STORE_PATH);

    expect(message).toContain(STORE_PATH);
    expect(message).not.toContain("expiry reads");
  });

  it("gives the move-the-store-aside fix, naming the path and 'mv'", () => {
    const message = formatShadowedEnvTokenAlert(STORE_PATH, ACCESS_EXPIRY, PAST);

    expect(message.toLowerCase()).toContain("move");
    expect(message).toContain("mv");
    expect(message).toContain(`mv ${STORE_PATH} ${STORE_PATH}.bak`);
    expect(message).toContain("restart");
  });

  it("warns against recreating the file via /login or claude without the env token set", () => {
    const message = formatShadowedEnvTokenAlert(STORE_PATH, ACCESS_EXPIRY, PAST);

    expect(message).toContain("/login");
    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(message).toContain("recreates");
  });
  // No token-leak test here: the formatter's signature cannot receive a token,
  // so such a test could never fail. The load-bearing leak check feeds a real
  // store through `enforceCredentialReadiness` (below).
});

describe("enforceCredentialReadiness — warn, never block", () => {
  let tempDir: string;
  let credPath: string;
  let warned: string[];
  let io: CredentialGateIo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "credential-gate-test-"));
    credPath = join(tempDir, "placeholder-credentials.json");
    warned = [];
    io = {
      warn: (m: string) => {
        warned.push(m);
      },
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeStore = (expiresAt: number, refreshTokenExpiresAt: number) =>
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { expiresAt, refreshTokenExpiresAt } }),
    );

  it("LOAD-BEARING: a dead store RETURNS the dead verdict normally", () => {
    // This is the property the old design got wrong. There is no injected
    // `exit` any more and no fake that throws, because there is nothing to
    // intercept: the function must run to completion and hand the verdict
    // back so `start.ts` can carry on booting.
    //
    // Named fault: reintroduce ANY `process.exit`/`throw` on the dead branch
    // and this test goes red — the call never returns, so neither the
    // `.status` nor the timestamp assertions below are ever reached.
    writeStore(PAST, PAST);

    const result = enforceCredentialReadiness(
      { oauthTokenEnv: undefined, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(result.status).toBe("dead");
    if (result.status === "dead") {
      expect(result.expiresAt).toBe(PAST);
      expect(result.refreshTokenExpiresAt).toBe(PAST);
    }
  });

  it("a dead store warns exactly once, with the alert text", () => {
    writeStore(PAST, PAST);

    enforceCredentialReadiness(
      { oauthTokenEnv: undefined, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("[credentials] no valid path to authenticate:");
    expect(warned[0]).toContain("The daemon is starting anyway");
    expect(warned[0]).toContain(new Date(PAST).toISOString());
  });

  it("a live refresh token does not warn — the common case must be silent", () => {
    writeStore(PAST, FUTURE);

    const result = enforceCredentialReadiness(
      { oauthTokenEnv: undefined, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(result.status).toBe("ok");
    expect(warned).toEqual([]);
  });

  it("an oat01 env token WARNS (shadowed) rather than staying silent, with a dead store that still has a login", () => {
    writeStore(PAST, PAST);

    const result = enforceCredentialReadiness(
      { oauthTokenEnv: OAT01_TOKEN, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(result.status).toBe("env-token-shadowed");
    expect(warned).toHaveLength(1);
  });

  it("a missing store does not warn", () => {
    const result = enforceCredentialReadiness(
      { oauthTokenEnv: undefined, credentialsPath: join(tempDir, "does-not-exist.json"), now: NOW },
      io,
    );

    expect(result.status).toBe("no-store");
    expect(warned).toEqual([]);
  });

  it("a shadowed env token warns exactly once, with the shadowed-alert text", () => {
    writeStore(PAST, FUTURE);

    const result = enforceCredentialReadiness(
      { oauthTokenEnv: OAT01_TOKEN, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(result.status).toBe("env-token-shadowed");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN is set to a long-lived token");
    expect(warned[0]).toContain(credPath);
  });

  it("using-env-token (no shadowing store) does not warn", () => {
    const result = enforceCredentialReadiness(
      {
        oauthTokenEnv: OAT01_TOKEN,
        credentialsPath: join(tempDir, "does-not-exist.json"),
        now: NOW,
      },
      io,
    );

    expect(result.status).toBe("using-env-token");
    expect(warned).toEqual([]);
  });

  it("LOAD-BEARING: the shadowed-alert warn text never contains the store's token values", () => {
    // Write a store shaped like the real thing — accessToken/refreshToken
    // fields present alongside the timestamps — and prove the full
    // enforceCredentialReadiness pipeline never lets those field VALUES reach
    // the warned text, only the two timestamps it's built to read. Values are
    // obviously-placeholder (your-..., no real-token prefix) per the
    // never-print-a-credential rule — this test's job is to prove they don't
    // leak, not to rehearse a realistic secret shape.
    const placeholderAccessTokenValue = "your-placeholder-access-token-value-not-real";
    const placeholderRefreshTokenValue = "your-placeholder-refresh-token-value-not-real";
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: placeholderAccessTokenValue,
          refreshToken: placeholderRefreshTokenValue,
          expiresAt: PAST,
          refreshTokenExpiresAt: FUTURE,
        },
      }),
    );

    const result = enforceCredentialReadiness(
      { oauthTokenEnv: OAT01_TOKEN, credentialsPath: credPath, now: NOW },
      io,
    );

    expect(result.status).toBe("env-token-shadowed");
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain(placeholderAccessTokenValue);
    expect(warned[0]).not.toContain(placeholderRefreshTokenValue);
    expect(warned[0]).not.toContain("not-real");
  });
});

describe("start.ts call-site placement", () => {
  // `start()` mounts the entire daemon and has no unit-test seam; the check's
  // BEHAVIOUR is covered above with injected io. What this pins is its
  // POSITION: early in boot, outside the bus-only branch, and never aborting.
  //
  // Named faults: deleting the call or moving it below agent resolution
  // (ordering test); moving it inside `if (settings.runtime === "bus")`, which
  // would silence it for legacy-runtime daemons whose PTY agents are just as
  // affected (runtime test); reintroducing an exit on the dead path (negative
  // test). Named blind spot: static text cannot prove the call's result is
  // used — the behaviour tests above do that.
  const source = readFileSync(join(import.meta.dir, "..", "..", "commands", "start.ts"), "utf8");

  it("start.ts calls enforceCredentialReadiness", () => {
    expect(source).toContain("enforceCredentialReadiness(");
  });

  it("the check runs BEFORE resolveBusAgentConfigs, so the warning is early in boot", () => {
    const gateAt = source.indexOf("enforceCredentialReadiness(");
    const resolveAt = source.indexOf("await resolveBusAgentConfigs(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(resolveAt);
  });

  it("LOAD-BEARING: the check runs for every runtime, not only inside the bus branch", () => {
    // Legacy-runtime daemons spawn the same interactive `claude` REPL under a
    // PTY (runner/pty-supervisor), so they are shadowed the same way.
    const gateAt = source.indexOf("enforceCredentialReadiness(");
    const busBranchAt = source.indexOf('if (settings.runtime === "bus") {');
    expect(busBranchAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(busBranchAt);
  });

  it("LOAD-BEARING: the credential path never exits or aborts boot", () => {
    // The `io.exit` shape is absent from `CredentialGateIo`, so a reintroduced
    // exit here could only arrive as a raw `process.exit` or an added
    // `io.exit` — both caught. Comments are stripped first: this is an
    // assertion about control flow, and prose explaining WHY there is no
    // throw must not read as a throw.
    // Bounded to the block itself: from the call to the bus branch it sits
    // in front of, so unrelated code further down cannot trip it.
    const gateAt = source.indexOf("enforceCredentialReadiness(");
    const blockEnd = source.indexOf('if (settings.runtime === "bus") {', gateAt);
    expect(blockEnd).toBeGreaterThan(gateAt);
    const code = source
      .slice(gateAt, blockEnd)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    expect(code).not.toContain("process.exit");
    expect(code).not.toContain("io.exit");
    expect(code).not.toMatch(/\breturn\b/);
    expect(code).not.toMatch(/\bthrow\b/);
  });

  it("the check is wired to the real credential path and env var, not hard-coded values", () => {
    expect(source).toContain("defaultCredentialsPath()");
    expect(source).toContain("oauthTokenEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN");
  });
});
