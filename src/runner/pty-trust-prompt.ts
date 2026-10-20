/**
 * Trust-prompt self-heal for claude 2.1.89+ (issue #81 failure mode #1).
 *
 * Claude shows an interactive trust prompt the first time it's invoked in a
 * given cwd:
 *
 *     Quick safety check: Is this a project you created or one you trust?
 *      > 1. Yes, I trust this folder
 *        2. No, exit
 *
 * The bun-pty spawn doesn't answer this prompt, so claude blocks forever and
 * the supervisor times out with an empty response. The "trust ack" state
 * lives in `~/.claude.json` under `projects["<absolute-cwd>"].
 * hasTrustDialogAccepted: true`.
 *
 * `ensureTrustAccepted(cwd, homedir)` writes that flag idempotently. Safe to
 * call repeatedly: a no-op when the project entry already has the flag set
 * to `true`. Mirrors the patch the operator applied manually during
 * diagnosis.
 *
 * Failures (filesystem errors, malformed JSON, etc.) are NOT thrown — they
 * are returned as `{ ok: false, reason }` so the supervisor can log them
 * without breaking PTY startup. A failing self-heal still lets the runtime
 * try (it just means the trust prompt may stall the first invocation).
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir as defaultHomedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";

export interface TrustHealResult {
  ok: boolean;
  changed: boolean;
  configPath: string;
  reason?: string;
}

/**
 * The file a write to `path` must land on: `path` itself, or the end of its
 * symlink chain — even when that end does not exist yet (a link into a fresh
 * volume), so the rename never replaces the link with a regular file.
 */
function writeTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return current; // does not exist: create it here
    }
    if (!isLink) return current;
    current = resolvePath(dirname(current), readlinkSync(current));
  }
  throw new Error(`too many symlinks resolving ${path}`);
}

/** Default project-entry shape claude 2.1.89 writes when accepting trust. */
function defaultProjectEntry(): Record<string, unknown> {
  return {
    hasTrustDialogAccepted: true,
    mcpServers: {},
    allowedTools: [],
    mcpContextUris: [],
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    projectOnboardingSeenCount: 1,
    exampleFiles: [],
  };
}

/**
 * Ensure `~/.claude.json` has `projects[<absoluteCwd>].hasTrustDialogAccepted
 * = true`. Creates the file and the `projects` map if absent. Atomic write
 * (temp file + rename) to avoid partial writes.
 *
 * Idempotent: if the flag is already true, returns `{ ok: true, changed:
 * false }`.
 */
/**
 * Per-config-path serialisation queue. Multiple `ensureTrustAccepted`
 * calls for different cwds against the SAME `~/.claude.json` would race
 * the read-modify-write pattern below — concurrent PTY spawns for
 * different session keys can run in parallel, and last-writer-wins
 * silently drops one cwd's trust flag, re-triggering the interactive
 * trust prompt stall the self-heal exists to prevent. Codex PR #82 P1.
 *
 * Queue is keyed on the absolute config path so tests with separate
 * tmpdirs don't serialise against each other, and production callers
 * all collapse to one chain against the operator's real `~/.claude.json`.
 *
 * The queue chains via `.catch(() => undefined).then(...)` so a single
 * failed write doesn't poison the chain — same defensive pattern used
 * in `SessionPersistenceStore._mutate`.
 */
const _writeQueues = new Map<string, Promise<TrustHealResult | void>>();

export async function ensureTrustAccepted(
  cwd: string,
  opts?: {
    /** Override the homedir lookup. Used by tests for tmp dirs. */
    homedir?: () => string;
    /** Override the config-file path entirely. Used by tests. */
    configPath?: string;
  },
): Promise<TrustHealResult> {
  // #304: `PLUS_CLAUDE_CONFIG_PATH` overrides the DEFAULT file this heals —
  // the test preload points it at a temp file so synthetic PTY spawns (every
  // test cwd is a temp dir) stop adding `projects[<tmp>]` entries to the
  // operator's real ~/.claude.json, which claude parses and backs up on every
  // launch. An explicit `configPath` or `homedir` from the caller still wins.
  const configPath =
    opts?.configPath ??
    (opts?.homedir
      ? resolvePath(opts.homedir(), ".claude.json")
      : process.env.PLUS_CLAUDE_CONFIG_PATH
        ? resolvePath(process.env.PLUS_CLAUDE_CONFIG_PATH)
        : resolvePath(defaultHomedir(), ".claude.json"));
  const absoluteCwd = resolvePath(cwd);

  const prev = _writeQueues.get(configPath) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => _doEnsureTrustAccepted(configPath, absoluteCwd));
  _writeQueues.set(configPath, next);
  return next;
}

/**
 * claude serialises most of its writes to `~/.claude.json` with a directory
 * lock next to the file (`<file>.lock`, created with mkdir, removed after the
 * rename) and re-reads the file under it. A running claude rewrites the file
 * many times at startup; a heal that skips the lock lands between one of its
 * reads and its write and is silently dropped, so the next claude in that cwd
 * opens the trust dialog with "No, exit" preselected. Taking the same lock
 * makes the two writers queue instead of race.
 *
 * claude's exit path writes the file WITHOUT the lock (read, then write), so
 * a heal can still be dropped by a claude exiting at that moment — the case
 * when a spawn follows another session's shutdown. After a write that changed
 * the file, the flag is read back after VERIFY_DELAY_MS and re-healed if it
 * is gone, up to VERIFY_ATTEMPTS times; still gone after that is reported
 * as `ok: false`.
 *
 * A lock older than LOCK_STALE_MS is a crashed holder's and is removed (the
 * lock library claude uses treats 10 s as stale). If the lock stays busy for
 * LOCK_WAIT_MS, the write goes ahead unlocked: a possibly lost entry is
 * better than never writing one.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;
const VERIFY_DELAY_MS = 200;
const VERIFY_ATTEMPTS = 3;

function lockPathFor(configPath: string): string {
  const target = writeTarget(configPath);
  let real = target;
  try {
    real = realpathSync(target);
  } catch {
    // not created yet: lock next to where it will be created
  }
  return `${real}.lock`;
}

async function acquireConfigLock(lockPath: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    if (Date.now() >= deadline) return false;
    let stale = false;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch (err) {
      // released between mkdir and stat: retry now
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (stale) {
      try {
        await rmdir(lockPath);
      } catch (err) {
        // cannot remove it (not ours, not empty): stop waiting on it
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      continue;
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

async function _doEnsureTrustAccepted(
  configPath: string,
  absoluteCwd: string,
): Promise<TrustHealResult> {
  const first = await _healLocked(configPath, absoluteCwd);
  if (!first.ok || !first.changed) return first;
  for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
    await Bun.sleep(VERIFY_DELAY_MS);
    const again = await _healLocked(configPath, absoluteCwd);
    if (!again.ok) return again;
    if (!again.changed) return first; // the flag survived
  }
  return {
    ok: false,
    changed: true,
    configPath,
    reason: `trust flag dropped by another writer of ~/.claude.json ${VERIFY_ATTEMPTS} times`,
  };
}

async function _healLocked(configPath: string, absoluteCwd: string): Promise<TrustHealResult> {
  let lockPath: string | null = null;
  try {
    lockPath = lockPathFor(configPath);
    if (!(await acquireConfigLock(lockPath))) lockPath = null;
  } catch {
    lockPath = null;
  }
  try {
    return await _readModifyWrite(configPath, absoluteCwd);
  } finally {
    if (lockPath) await rmdir(lockPath).catch(() => undefined);
  }
}

async function _readModifyWrite(configPath: string, absoluteCwd: string): Promise<TrustHealResult> {
  try {
    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const text = await Bun.file(configPath).text();
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
          }
        } catch (err) {
          // Malformed JSON — refuse to overwrite, surface as a non-fatal
          // failure so the operator knows to fix the file.
          return {
            ok: false,
            changed: false,
            configPath,
            reason: `~/.claude.json is malformed JSON: ${(err as Error).message}`,
          };
        }
      }
    }

    const projects = (raw.projects as Record<string, unknown> | undefined) ?? {};
    const existing = (projects[absoluteCwd] as Record<string, unknown> | undefined) ?? null;

    if (existing && existing.hasTrustDialogAccepted === true) {
      return { ok: true, changed: false, configPath };
    }

    const next: Record<string, unknown> = { ...projects };
    next[absoluteCwd] = existing
      ? { ...existing, hasTrustDialogAccepted: true }
      : defaultProjectEntry();

    const updated = { ...raw, projects: next };
    const payload = `${JSON.stringify(updated, null, 2)}\n`;

    // Atomic-ish write: write a temp file then rename, so a process dying
    // mid-write never leaves the file half-written. The rename lands on the
    // symlink's target (a ~/.claude.json linked into a persisted volume stays
    // a link) and the temp file carries the original mode: the file holds
    // account state and is 0600, a fresh one is created 0600 too.
    const target = writeTarget(configPath);
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
    const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmpPath, payload, { mode });
      await chmod(tmpPath, mode); // `mode` above is filtered by the umask
      await rename(tmpPath, target);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    return { ok: true, changed: true, configPath };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      configPath,
      reason: `failed to write ~/.claude.json: ${(err as Error).message}`,
    };
  }
}
