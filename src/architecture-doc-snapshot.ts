/**
 * Collect the live runtime snapshot that `renderArchitectureDoc` needs.
 *
 * Separated from the renderer so the pure generator stays trivially
 * testable. This file is the "ask the daemon what's currently true" side
 * of the boundary.
 *
 * Sources:
 *   - `settings.runtime` and `settings.agents[]` from the loaded settings.
 *   - The list of agent IDs the bus runtime actually spawned (caller passes
 *     `BusRuntimeHandle.spawnedAgentIds` to disambiguate "declared but
 *     failed to spawn" from "running").
 *   - The on-disk jobs scan from `loadJobs()` (the same call the scheduler
 *     itself uses, so the architecture doc matches reality).
 *   - The list of mounted adapters from `wireBusAdapters()` result.
 */

import { loadJobs } from "./jobs";
import type { Settings } from "./config";
import type { ArchitectureSnapshot, ArchitectureSnapshotAdapter } from "./architecture-doc";

/* eslint-disable @typescript-eslint/no-require-imports */
function readPluginVersion(): string {
  try {
    const pkg = require("../.claude-plugin/plugin.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

export interface CollectSnapshotOptions {
  settings: Settings;
  /** Agent IDs the bus runtime successfully spawned. Empty under pty. */
  spawnedAgentIds?: readonly string[];
  /** Mounted adapter names + optional descriptive detail (channel counts etc.). */
  adapters?: readonly ArchitectureSnapshotAdapter[];
  /** Override clock for tests; defaults to `new Date()`. */
  now?: Date;
  /** Override plugin version (for tests). */
  pluginVersion?: string;
}

export async function collectArchitectureSnapshot(
  opts: CollectSnapshotOptions,
): Promise<ArchitectureSnapshot> {
  const { settings, spawnedAgentIds, adapters, now, pluginVersion } = opts;
  const ts = (now ?? new Date()).toISOString();

  const declaredAgents = settings.agents ?? [];
  // `spawnedAgentIds` is accepted but not surfaced in the rendered doc yet —
  // future enhancement could flag "declared but failed to spawn". Reference
  // the parameter so the linter doesn't drop it as unused.
  void spawnedAgentIds;

  const snapshotAgents = declaredAgents.map((a) => ({
    id: a.id,
    permissionMode: a.permission_mode,
    cwd: a.cwd,
    systemPromptFile: a.system_prompt_file,
    memoryFile: a.memory_file,
  }));

  // Jobs are read from disk via the same scanner the scheduler uses, so
  // the doc reflects exactly what the daemon would schedule.
  const jobs = await loadJobs().catch(() => []);
  const snapshotJobs = jobs.map((j) => ({
    agent: j.agent ?? "global",
    label: j.label ?? j.name,
    schedule: j.schedule,
    enabled: j.enabled !== false,
  }));

  return {
    pluginVersion: pluginVersion ?? readPluginVersion(),
    runtime: settings.runtime,
    agents: snapshotAgents,
    jobs: snapshotJobs,
    adapters: adapters ?? [],
    generatedAt: ts,
  };
}
