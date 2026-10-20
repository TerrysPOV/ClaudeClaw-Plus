/**
 * Boot-time credential readiness (#514).
 *
 * A runtime-neutral leaf: no `bun:*`
 * imports, no `Bun.*` globals, no top-level side effects, and every input that
 * reaches the outside world (path, clock, env, io) injectable so the whole
 * module is testable without touching a real credential store. `DEFAULT_GATE_IO`
 * closes over `console` — that is the default only, and every test supplies its
 * own.
 *
 * THIS GATES NOTHING. IT CLASSIFIES, AND IT WARNS.
 * -----------------------------------------------
 * A daemon that refuses to start because of a credential problem also takes
 * cron and every other capability that does not spawn an agent down with it,
 * and the timestamps in the store are a weak signal to bet a boot on. So the
 * verdict is advisory: `enforceCredentialReadiness` writes a warning to the
 * daemon log and returns; `src/commands/start.ts` always carries on booting.
 * Do not introduce an exit here.
 *
 * Division of labour:
 *   - `checkCredentialReadiness` decides (pure, no I/O beyond one file read).
 *   - `enforceCredentialReadiness` logs locally and returns the verdict.
 *   - Continuing to boot regardless of the verdict is the CALLER's job.
 *
 * WHAT IT CLASSIFIES ON, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------------
 * The access token's lifetime is roughly eight hours and the store refreshes
 * it lazily, so `expiresAt` is *expected* to read as past for much of normal
 * operation. A warning on it would fire constantly and harmlessly — and a
 * signal that is usually wrong is a signal operators learn to ignore.
 *
 * So `dead` keys on `refreshTokenExpiresAt`: the one state nothing downstream
 * can self-heal. A live refresh token means the daemon can recover on its own
 * whatever the access token looks like. A dead one means every spawned agent
 * will 401 until an operator intervenes.
 *
 * Everything ambiguous degrades to `no-store` (quiet), never to `dead`. Warning
 * an operator because a JSON parse hiccuped is how a warning becomes noise.
 *
 * This is not a substitute for a real authenticated call; it covers two cases
 * only: a genuinely dead refresh token, and a stored claude.ai login shadowing
 * a long-lived env token (`env-token-shadowed`).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `claude setup-token` mints 1-year long-lived tokens with this prefix. Same
 * constant, same reasoning as `shouldStripSpawnEnvKey` in `src/runner.ts`: a
 * token of this shape is sufficient on its own for the NON-INTERACTIVE
 * `claude -p` path, which never looks at the on-disk store.
 *
 * It is NOT sufficient for interactive agents. When the store at
 * `~/.claude/.credentials.json` still holds a `claudeAiOauth` login, the
 * interactive `claude` REPL — what the daemon's PTY agents run — uses the
 * file's login instead of the env token. Agents then run on whatever account
 * that login belongs to, and once its access token expires without being
 * refreshed every agent turn 401s, while `claude -p` with the same env token
 * keeps working. So a long-lived env token does not make the store's state
 * irrelevant — the store's state decides whether interactive agents actually
 * use the env token at all. See `env-token-shadowed` below.
 */
const LONG_LIVED_OAUTH_TOKEN_PREFIX = "sk-ant-oat01-";

export interface CredentialReadinessOpts {
  /** Value of `CLAUDE_CODE_OAUTH_TOKEN`, or undefined when unset. */
  oauthTokenEnv: string | undefined;
  /** Absolute path to the credential store. Injectable for tests. */
  credentialsPath: string;
  /** Injectable clock; defaults to `Date.now()`. */
  now?: number;
}

export type CredentialReadiness =
  /**
   * A long-lived `sk-ant-oat01-` token is present and the store has no
   * `claudeAiOauth` login that would shadow it (missing, unreadable,
   * unparsable, or present without that block) — sufficient alone.
   */
  | { status: "using-env-token" }
  /** No store to check (dev box, fresh install, unreadable or malformed file). */
  | { status: "no-store" }
  /** Store present and its refresh token is still valid. */
  | { status: "ok"; expiresAt: number }
  /** The refresh token itself has expired — nothing can self-heal this. */
  | { status: "dead"; expiresAt: number; refreshTokenExpiresAt: number }
  /**
   * A long-lived `sk-ant-oat01-` env token is set, AND the store still holds
   * a `claudeAiOauth` object. Interactive agents (the `claude` REPL, not
   * `claude -p`) use the store's login instead of the env token in this case.
   * `expiresAt`/`refreshTokenExpiresAt` are included only when the store's
   * values are valid, representable numbers — a malformed store still shadows
   * the env token (the REPL doesn't care whether the timestamps parse), it just
   * can't be dated.
   */
  | { status: "env-token-shadowed"; expiresAt?: number; refreshTokenExpiresAt?: number };

/** Where the credential store lives, honouring `CLAUDE_CONFIG_DIR`. */
export function defaultCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (typeof configDir === "string" && configDir.length > 0) {
    return join(configDir, ".credentials.json");
  }
  return join(home, ".claude", ".credentials.json");
}

/**
 * `Number.isFinite` only rejects NaN/Infinity — a corrupt-but-finite value
 * like `1e100` passes it, but `new Date(1e100)` is an Invalid Date and
 * `.toISOString()` throws `RangeError` wherever this module's callers format
 * one (the "ok" log line and both warning texts). That throw would propagate
 * out of `enforceCredentialReadiness` into the boot path on a malformed store
 * — the opposite of this module's purpose. Reject anything outside Date's
 * representable range (±8,640,000,000,000,000 ms from epoch) the same way any
 * other malformed timestamp degrades.
 */
function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000
  );
}

/** A real store is a few hundred bytes; anything far larger is not one. */
const MAX_STORE_BYTES = 1024 * 1024;

/**
 * Reads and parses the credential store's `claudeAiOauth` block. Returns
 * `undefined` for every "nothing usable here" case — missing file,
 * unreadable, a directory, unparsable JSON, or JSON without a
 * `claudeAiOauth` object — so callers don't have to repeat the three-way
 * try/catch/shape-check. Never reads or returns a token value: only whatever
 * fields the caller asks for off the returned object (this module only ever
 * asks for `expiresAt` / `refreshTokenExpiresAt`).
 */
function readOauthBlock(
  credentialsPath: string,
): { expiresAt?: unknown; refreshTokenExpiresAt?: unknown } | undefined {
  let raw: string;
  try {
    // Only a regular file of plausible size is read: a FIFO at this path
    // would block boot forever, and a huge file is not a credential store.
    const st = statSync(credentialsPath);
    if (!st.isFile() || st.size > MAX_STORE_BYTES) return undefined;
    raw = readFileSync(credentialsPath, "utf8");
  } catch {
    // Missing, unreadable, a directory — all "nothing to check".
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  return oauth as { expiresAt?: unknown; refreshTokenExpiresAt?: unknown };
}

/**
 * Read-only verdict on whether this daemon has any working path to auth.
 * Reads exactly two fields — `claudeAiOauth.expiresAt` and
 * `claudeAiOauth.refreshTokenExpiresAt` — and never a token value.
 */
export function checkCredentialReadiness(opts: CredentialReadinessOpts): CredentialReadiness {
  const { oauthTokenEnv, credentialsPath } = opts;
  const now = opts.now ?? Date.now();

  if (
    typeof oauthTokenEnv === "string" &&
    oauthTokenEnv.startsWith(LONG_LIVED_OAUTH_TOKEN_PREFIX)
  ) {
    // The env token is sufficient for `claude -p`, but the interactive REPL
    // (what spawned agents actually run) prefers a `claudeAiOauth` login in
    // the store when one is present. So the store is still consulted here,
    // not to classify `dead`/`ok`, but to detect that shadowing.
    const oauth = readOauthBlock(credentialsPath);
    if (!oauth) return { status: "using-env-token" };

    const expiresAt = isValidTimestamp(oauth.expiresAt) ? oauth.expiresAt : undefined;
    const refreshTokenExpiresAt = isValidTimestamp(oauth.refreshTokenExpiresAt)
      ? oauth.refreshTokenExpiresAt
      : undefined;
    return {
      status: "env-token-shadowed",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
    };
  }

  const oauth = readOauthBlock(credentialsPath);
  if (!oauth) return { status: "no-store" };

  const { expiresAt, refreshTokenExpiresAt } = oauth;
  if (!isValidTimestamp(expiresAt) || !isValidTimestamp(refreshTokenExpiresAt)) {
    return { status: "no-store" };
  }

  // Strictly-less-than: a refresh token whose expiry is exactly `now` has not
  // yet failed, and of the two errors available at the boundary, a false
  // "dead" is the expensive one — it alarms the operator with nothing wrong.
  if (refreshTokenExpiresAt < now) {
    return { status: "dead", expiresAt, refreshTokenExpiresAt };
  }

  // `expiresAt` may well be in the past. That is normal mid-cycle state, not a
  // failure — see the module comment.
  return { status: "ok", expiresAt };
}

/**
 * The operator-facing warning for `dead`.
 *
 * Not a fatal message: the daemon is already starting by the time an operator
 * reads this. The message therefore has to say what still works, what does
 * not, and what to do — a message that reads like a crash report for a process
 * that is running sends the operator looking for a dead daemon.
 *
 * Both timestamps are surfaced. `expiresAt` alone is never the trigger (see
 * the module comment), but an operator diagnosing this wants to see the pair.
 *
 * Deliberately generic about where the daemon's environment comes from: a unit
 * file, an env file, or an `ExecStartPre` that rebuilds one from a secrets
 * manager on every start. The overwrite trap — a direct edit silently
 * discarded on the next restart — applies to every manager, so none is named.
 *
 * Assembled sentence-by-sentence rather than as one wrapped template so that
 * no phrase an operator (or a test) looks for can be split by a reformat.
 */
export function formatDeadCredentialAlert(
  expiresAt: number,
  refreshTokenExpiresAt: number,
): string {
  const expiredAtIso = new Date(refreshTokenExpiresAt).toISOString();
  const accessTokenExpiryIso = new Date(expiresAt).toISOString();
  return [
    "[credentials] no valid path to authenticate: CLAUDE_CODE_OAUTH_TOKEN is absent or short-lived,",
    `and the on-disk credential store's refresh token expired at ${expiredAtIso}.`,
    `(The access token's own expiry reads ${accessTokenExpiryIso}; that field alone is not the`,
    "trigger — it is expected to read as past mid-cycle.)",
    "The daemon is starting anyway: cron and every other capability that does not spawn an agent",
    "keep working. But spawned `claude` calls may 401 until this is fixed.",
    "Fix: run `claude setup-token` (any machine with a browser — it prints a URL, it does not need",
    "one locally) to mint a fresh long-lived token, then set CLAUDE_CODE_OAUTH_TOKEN to it in",
    "whatever populates this daemon's environment (see",
    '"Credential store warnings at startup" in docs/deploy-systemd-hardening.md).',
    "If an ExecStartPre script rebuilds the env file from a secrets manager on every start,",
    "edit the secrets manager, not the file directly — a direct edit is discarded on the next restart.",
    "Then restart the daemon.",
  ].join("\n");
}

/**
 * The operator-facing warning for `env-token-shadowed` (see the
 * `LONG_LIVED_OAUTH_TOKEN_PREFIX` comment above for the failure it encodes).
 *
 * Same shape as `formatDeadCredentialAlert`: assembled sentence-by-sentence
 * so no phrase a test (or an operator skimming the log) looks for can be
 * split by a reformat.
 *
 * `credentialsPath` is a parameter, not read from disk or env here — this
 * function does no I/O of its own, matching the module's runtime-neutrality
 * contract. The two timestamps are optional because a malformed store still
 * shadows the env token; there's just nothing datable to report.
 *
 * Never includes a token value: the only store fields this module ever reads
 * are the two timestamps, and this function's signature doesn't accept
 * anything else to print.
 */
export function formatShadowedEnvTokenAlert(
  credentialsPath: string,
  expiresAt?: number,
  refreshTokenExpiresAt?: number,
): string {
  const lines = [
    "[credentials] CLAUDE_CODE_OAUTH_TOKEN is set to a long-lived token, but the credential store at",
    `${credentialsPath} also holds a claude.ai login.`,
    "Interactive agents (the ones that run the `claude` REPL, as opposed to `claude -p`) use that",
    "stored login instead of CLAUDE_CODE_OAUTH_TOKEN — so they run on that login's account, and",
    "they will 401 once the stored login's access token expires rather than refreshing it, while",
    "`claude -p` with the same env token keeps working.",
  ];
  if (expiresAt !== undefined) {
    lines.push(
      `The stored login's access token expiry reads ${new Date(expiresAt).toISOString()}.`,
    );
  }
  if (refreshTokenExpiresAt !== undefined) {
    lines.push(`Its refresh token expiry reads ${new Date(refreshTokenExpiresAt).toISOString()}.`);
  }
  lines.push(
    `Fix: move the store aside (e.g. \`mv ${credentialsPath} ${credentialsPath}.bak\`) and restart`,
    "the daemon.",
    "Don't run `/login` or `claude` as the daemon user without CLAUDE_CODE_OAUTH_TOKEN set in its",
    "environment — doing so recreates the exact file this warning is about.",
  );
  return lines.join("\n");
}

export interface CredentialGateIo {
  warn: (message: string) => void;
}

const DEFAULT_GATE_IO: CredentialGateIo = {
  warn: (message: string) => console.warn(message),
};

/**
 * Classify, and on `dead` or `env-token-shadowed` write the warning text to
 * the daemon log.
 *
 * Non-blocking by construction: no exit, no throw, no promise. Every verdict —
 * `dead` and `env-token-shadowed` included — returns to the caller, which
 * carries on booting.
 *
 * `io` is injected so the warn is observable in tests. It stays synchronous so
 * no caller can be tempted to skip awaiting it.
 */
export function enforceCredentialReadiness(
  opts: CredentialReadinessOpts,
  io: CredentialGateIo = DEFAULT_GATE_IO,
): CredentialReadiness {
  const readiness = checkCredentialReadiness(opts);
  if (readiness.status === "dead") {
    io.warn(formatDeadCredentialAlert(readiness.expiresAt, readiness.refreshTokenExpiresAt));
  } else if (readiness.status === "env-token-shadowed") {
    io.warn(
      formatShadowedEnvTokenAlert(
        opts.credentialsPath,
        readiness.expiresAt,
        readiness.refreshTokenExpiresAt,
      ),
    );
  }
  return readiness;
}
