import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { type Scope, SCOPES, resolveScope } from "./scope.js";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "tuner", "config.yaml");

// ─── Standard discovery paths (per-subject defaults) ──────────────────────────────────
// Each TunableSubject writes its artifacts to the canonical path the consuming runtime
// already reads from. No custom directories, no symlink dance — see issue #52.

/** Anthropic Skills global path. Read by Claude Code and ClaudeClaw-Plus daemon. */
export const DEFAULT_SKILLS_DIR = join(homedir(), ".claude", "skills");

/** XDG-standard path for systemd user units. */
export const DEFAULT_SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");

/** XDG-config sidecar for POSIX crontab snapshots (table itself is root-managed). */
export const DEFAULT_CRONTAB_DIR = join(homedir(), ".config", "cron");

/** Subject-name → standard path mapping. Override via `subjects.<name>.git_repo` in config. */
export const SUBJECT_STANDARD_PATHS: Record<string, { git_repo?: string; scan_dirs?: string[] }> = {
  skills: {
    git_repo: DEFAULT_SKILLS_DIR,
    scan_dirs: [DEFAULT_SKILLS_DIR],
  },
  wisecron: {
    git_repo: DEFAULT_SYSTEMD_USER_DIR,
  },
  cron: {
    git_repo: DEFAULT_CRONTAB_DIR,
  },
};

const ModelConfigSchema = z.object({
  intent_classifier: z.string().default("claude-haiku-4-5-20251001"),
  detector: z.string().default("claude-opus-4-7"),
  proposer_default: z.string().default("claude-sonnet-4-6"),
  proposer_high_stakes: z.string().default("claude-opus-4-7"),
  judge: z.string().default("claude-opus-4-7"),
});

const SubjectConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Per-subject scope override. Falls back to the global `scope` when omitted. */
  scope: z.enum(SCOPES).optional(),
  git_repo: z.string().optional(),
  auto_merge: z.union([z.boolean(), z.array(z.string())]).default(false),
  proposer: z.string().optional(),
  proposer_for_create: z.string().optional(),
  scan_dirs: z.array(z.string()).default([]),
  emotional_patterns: z.array(z.string()).optional(),
  overrides: z.record(z.unknown()).optional(),
});
export type SubjectConfig = z.infer<typeof SubjectConfigSchema>;

const DetectionConfigSchema = z.object({
  improvement_keywords_extra: z.array(z.string()).default([]),
  confidence_floor: z.number().min(0).max(1).default(0.65),
  max_proposals_per_run: z.number().int().positive().default(5),
});

const ProposerConfigSchema = z.object({
  alternatives_count: z.number().int().positive().default(3),
  language_preference: z.string().default("en"),
});

const UiConfigSchema = z.object({
  primary_adapter: z.string().default("cli"),
  follow_up_survey: z.boolean().default(true),
  follow_up_after_seconds: z.number().int().positive().default(30),
});

const StorageConfigSchema = z.object({
  proposals_jsonl: z.string().default(join(homedir(), ".config", "tuner", "proposals.jsonl")),
  refused_jsonl: z.string().default(join(homedir(), ".config", "tuner", "refused.jsonl")),
  schema_version: z.number().int().default(1),
  backup_keep: z.number().int().default(7),
  git_repo: z.string().optional(),
});

const LLMConfigSchema = z.object({
  backend: z.enum(["anthropic_api", "claude_cli"]).default("anthropic_api"),
  api_key: z.string().optional(),
});

export const TunerConfigSchema = z.object({
  /**
   * Global tuning scope — the tuner's blast radius. `all` (default) tunes the
   * whole Claude Code setup (`~/.claude/*` + all sessions); `agent` restricts
   * every subject to the agent's own surface. Override per subject via
   * `subjects.<name>.scope`. See core/scope.ts.
   */
  scope: z.enum(SCOPES).default("all"),
  models: ModelConfigSchema.default({}),
  llm: LLMConfigSchema.default({}),
  detection: DetectionConfigSchema.default({}),
  proposer: ProposerConfigSchema.default({}),
  subjects: z.record(SubjectConfigSchema).default({}),
  ui: UiConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
});
export type TunerConfig = z.infer<typeof TunerConfigSchema>;

/**
 * Effective scope of a subject under this config: `subjects.<name>.scope` wins,
 * else the global `scope`, else `all`. Thin wrapper over `resolveScope` so callers
 * read one config object.
 */
export function subjectScope(config: TunerConfig, name: string): Scope {
  return resolveScope(config.scope, config.subjects[name]?.scope);
}

/**
 * Returns the effective config for a subject, merging user overrides with
 * standard-path defaults. User values always win — defaults only fill gaps.
 *
 * - `git_repo` defaults to the canonical path read by the consuming runtime
 *   (e.g. `~/.claude/skills/` for the `skills` subject).
 * - `scan_dirs` defaults are appended if the user did not provide any.
 *
 * Override the env var `TUNER_DISABLE_STANDARD_DEFAULTS=1` to get raw user
 * config without defaults (useful for tests / introspection).
 */
export function subjectConfig(config: TunerConfig, name: string): SubjectConfig {
  const userCfg = config.subjects[name] ?? SubjectConfigSchema.parse({});
  if (process.env.TUNER_DISABLE_STANDARD_DEFAULTS === "1") return userCfg;

  const standard = SUBJECT_STANDARD_PATHS[name];
  if (!standard) return userCfg;

  return {
    ...userCfg,
    git_repo: userCfg.git_repo ?? standard.git_repo,
    scan_dirs: userCfg.scan_dirs.length > 0 ? userCfg.scan_dirs : (standard.scan_dirs ?? []),
  };
}

/** Returns true if the configured path matches the standard one for this subject. */
export function isStandardPath(subjectName: string, path: string | undefined): boolean {
  if (!path) return false;
  const standard = SUBJECT_STANDARD_PATHS[subjectName]?.git_repo;
  return !!standard && standard === path;
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): TunerConfig {
  if (!existsSync(path)) {
    return TunerConfigSchema.parse({});
  }
  const raw = (yaml.load(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
  // Expand ~ in storage paths
  if (raw["storage"] && typeof raw["storage"] === "object") {
    const storage = raw["storage"] as Record<string, unknown>;
    for (const key of ["proposals_jsonl", "refused_jsonl", "git_repo"]) {
      if (typeof storage[key] === "string") {
        storage[key] = (storage[key] as string).replace(/^~/, homedir());
      }
    }
  }
  // Expand ~ in per-subject git_repo paths
  if (raw["subjects"] && typeof raw["subjects"] === "object") {
    for (const subj of Object.values(raw["subjects"] as Record<string, unknown>)) {
      if (subj && typeof subj === "object") {
        const s = subj as Record<string, unknown>;
        if (typeof s["git_repo"] === "string") {
          s["git_repo"] = (s["git_repo"] as string).replace(/^~/, homedir());
        }
        if (Array.isArray(s["scan_dirs"])) {
          s["scan_dirs"] = (s["scan_dirs"] as unknown[]).map((d) =>
            typeof d === "string" ? d.replace(/^~/, homedir()) : d,
          );
        }
      }
    }
  }
  return TunerConfigSchema.parse(raw);
}

const DEFAULT_YAML = `# Skills Tuner TS configuration
#
# Per-subject defaults (git_repo, scan_dirs) resolve to standard discovery paths
# automatically — see SUBJECT_STANDARD_PATHS in core/config.ts. Override here only
# when you need a non-standard location.
#
# Standard paths:
#   skills    → ~/.claude/skills/              (Anthropic Skills, read by Claude Code)
#   wisecron  → ~/.config/systemd/user/        (XDG systemd user units)
#   cron      → ~/.config/cron/                (XDG sidecar for crontab snapshot)

# Scope = the tuner's blast radius.
#   all    tune your whole Claude Code setup (~/.claude/* + all sessions)  [default]
#   agent  restrict every subject to the agent's own surface (~/agent/*, agent rows)
# Override per subject below with subjects.<name>.scope.
scope: all

llm:
  backend: anthropic_api
  # api_key: sk-ant-...   # or set ANTHROPIC_API_KEY env var

detection:
  confidence_floor: 0.65
  max_proposals_per_run: 5

models:
  intent_classifier: claude-haiku-4-5-20251001
  detector: claude-opus-4-7
  proposer_default: claude-sonnet-4-6
  proposer_high_stakes: claude-opus-4-7
  judge: claude-opus-4-7

proposer:
  alternatives_count: 3
  language_preference: en

subjects:
  skills:
    enabled: true
    auto_merge: [patch, frontmatter]
    proposer: claude-sonnet-4-6
    proposer_for_create: claude-opus-4-7
    # git_repo defaults to ~/.claude/skills/
    # scan_dirs defaults to [~/.claude/skills]

ui:
  primary_adapter: cli
  follow_up_survey: true
  follow_up_after_seconds: 30

storage:
  backup_keep: 7
`;

export function writeDefaultConfig(path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) throw new Error(`Config already exists at ${path}`);
  writeFileSync(path, DEFAULT_YAML, "utf8");
}
