/**
 * Shared by the real-claude suites: on a fresh HOME (the nightly runner)
 * claude boots into its onboarding screens — theme picker first — which no
 * runner answers. Mark onboarding done, touching nothing else in the file and
 * leaving it alone when it already says so (a developer's own machine).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let seededOnboarding = false;

export function readClaudeConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // malformed: not ours to rewrite
  }
}

// Write-then-rename: claude rewrites this file itself (atomically, with
// backups); a partial write must never be what it reads.
export function writeClaudeConfig(path: string, cfg: Record<string, unknown>): void {
  const tmp = `${path}.pty-it-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function seedClaudeOnboarding(): void {
  const path = join(homedir(), ".claude.json");
  const cfg = readClaudeConfig(path);
  if (cfg === null || cfg.hasCompletedOnboarding === true) return;
  writeClaudeConfig(path, { ...cfg, hasCompletedOnboarding: true });
  seededOnboarding = true;
}

/** Undo the seed on the machine it was made on — a developer who had not
 *  onboarded gets their onboarding back; the runner's HOME is discarded. */
export function unseedClaudeOnboarding(): void {
  if (!seededOnboarding) return;
  const path = join(homedir(), ".claude.json");
  const cfg = readClaudeConfig(path);
  if (cfg === null) return;
  const { hasCompletedOnboarding: _seeded, ...rest } = cfg;
  writeClaudeConfig(path, rest);
  seededOnboarding = false;
}
