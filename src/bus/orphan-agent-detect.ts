/**
 * Detect mismatches between declared bus agents (`settings.agents[]`) and
 * on-disk agent directories (`agents/<name>/jobs/*.md`).
 *
 * Bus runtime only spawns processes for agents in `settings.agents[]`. If an
 * `agents/<name>/` directory has scheduled jobs but `<name>` is not declared,
 * the scheduler fires prompts to the bus with `agent_id: <name>` and they sit
 * `status: "pending"` forever — silent job death. This module surfaces the
 * mismatch at daemon startup so the operator gets a loud warning instead of
 * jobs that disappear without a trace.
 *
 * Production incident 2026-05-26: three agents (`suzy`, `reg`, `publisher`)
 * had jobs on disk but were not declared. Prompts published, nothing
 * consumed, days of "daily" jobs silently missed. This check would have
 * caught it the first time the daemon restarted after the disk state went
 * out of sync. See issue #167.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BusAgentSettings } from "../config";

export interface OrphanAgentDir {
  /** Directory name under `agents/`, e.g. `"reg"`. */
  name: string;
  /** Count of files under `agents/<name>/jobs/` (any extension). */
  jobCount: number;
}

export interface OrphanAgentDecl {
  /** Agent id from `settings.agents[].id`. */
  id: string;
}

export interface OrphanAgentReport {
  /** On-disk dirs with at least one job file but no matching declaration. */
  orphanedDirs: OrphanAgentDir[];
  /** Declared agents with no matching on-disk directory. */
  orphanedDecls: OrphanAgentDecl[];
}

/**
 * Pure function — no I/O when given an injected directory listing. The
 * default `listDir`/`countJobs` read the filesystem; tests pass fakes.
 *
 * Behaviour:
 *   - If `agents/` doesn't exist or isn't a directory → return empty
 *     report (greenfield deployments aren't a mismatch).
 *   - Only directories with at least one file under `agents/<name>/jobs/`
 *     count as orphan dirs. Empty `agents/<name>/` (no jobs subdir, or
 *     jobs dir empty) doesn't trip the warning — operator might just have
 *     a workspace dir for that agent without scheduled work.
 *   - Declared agents missing their on-disk dir are reported separately;
 *     these are softer (a declared agent with no jobs is fine if the
 *     operator just hasn't written any yet) but still surfaced so the
 *     operator can spot stale declarations.
 */
export function detectOrphanAgents(
  declared: readonly BusAgentSettings[],
  projectRoot: string,
  io: { listDir?: (path: string) => string[]; countJobs?: (path: string) => number } = {},
): OrphanAgentReport {
  const listDir = io.listDir ?? defaultListDir;
  const countJobs = io.countJobs ?? defaultCountJobs;

  const agentsRoot = join(projectRoot, "agents");
  const onDisk = listDir(agentsRoot);

  if (onDisk.length === 0) {
    return { orphanedDirs: [], orphanedDecls: [] };
  }

  const declaredIds = new Set(declared.map((a) => a.id));
  const onDiskNames = new Set(onDisk);

  const orphanedDirs: OrphanAgentDir[] = [];
  for (const name of onDisk) {
    if (declaredIds.has(name)) continue;
    const jobCount = countJobs(join(agentsRoot, name, "jobs"));
    if (jobCount > 0) {
      orphanedDirs.push({ name, jobCount });
    }
  }

  const orphanedDecls: OrphanAgentDecl[] = [];
  for (const decl of declared) {
    if (!onDiskNames.has(decl.id)) {
      orphanedDecls.push({ id: decl.id });
    }
  }

  return { orphanedDirs, orphanedDecls };
}

/**
 * Format the report as one or more `[bus-runtime] WARN: ...` lines, one
 * per orphan, ready to feed to a logger. Empty report → empty array.
 */
export function formatOrphanWarnings(report: OrphanAgentReport): string[] {
  const lines: string[] = [];
  for (const o of report.orphanedDirs) {
    lines.push(
      `[bus-runtime] WARN: agent dir "${o.name}" has ${o.jobCount} scheduled job(s) in ` +
        `agents/${o.name}/jobs/ but is not declared in settings.agents. ` +
        `Prompts for this agent will publish to the bus with no consumer. ` +
        `Add { "id": "${o.name}" } to settings.agents or remove agents/${o.name}/jobs/.`,
    );
  }
  for (const o of report.orphanedDecls) {
    lines.push(
      `[bus-runtime] WARN: agent "${o.id}" is declared in settings.agents but has no ` +
        `matching agents/${o.id}/ directory. A claude process is spawned but no jobs are ` +
        `configured for it. Either add agents/${o.id}/jobs/ or remove the declaration.`,
    );
  }
  return lines;
}

/* ───────────────────────────────── I/O defaults ───────────────────────────── */

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => {
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function defaultCountJobs(jobsPath: string): number {
  // Only count `*.md` files — that matches the filter the scheduler itself
  // applies in `src/jobs.ts:loadJobs` (line 183), so the warning count is
  // accurate. README, .gitkeep, editor backups etc. would otherwise inflate
  // the count and trip the warning for dirs that have no schedulable jobs.
  try {
    return readdirSync(jobsPath).filter((name) => {
      if (!name.endsWith(".md")) return false;
      try {
        return statSync(join(jobsPath, name)).isFile();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}
