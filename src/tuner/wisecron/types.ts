import { z } from "zod";
import type { Patch, Proposal, UnsignedProposal } from "../../skills-tuner/core/types.js";
import type { RiskTier } from "../../skills-tuner/core/interfaces.js";
import { SCOPES } from "../../skills-tuner/core/scope.js";

// ── Adaptive scheduling ─────────────────────────────────────────────────────

export const ScheduleStateSchema = z.object({
  subject: z.string(),
  last_run: z.coerce.date(),
  next_run: z.coerce.date(),
  current_interval_hours: z.number().int().min(1).max(168),
  consecutive_zero_runs: z.number().int().min(0),
  last_proposal_count: z.number().int().min(0),
  enabled: z.boolean(),
});
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

export const INITIAL_INTERVAL_HOURS = 24;
export const MAX_INTERVAL_HOURS = 168;
export const HIGH_RISK_OBSERVATION_WINDOW_MS = 5 * 60 * 1000;

// ── Rollback history ────────────────────────────────────────────────────────

export const AppliedBy = z.enum(["cli", "telegram", "auto-revert", "mcp", "research"]);
export type AppliedBy = z.infer<typeof AppliedBy>;

export const RevisionRecordSchema = z.object({
  id: z.number().int(),
  proposal_id: z.string(),
  subject: z.string(),
  applied_at: z.coerce.date(),
  forward_patch: z.object({
    target_path: z.string(),
    kind: z.string(),
    applied_content: z.string(),
  }),
  inverse_patch: z.object({
    target_path: z.string(),
    kind: z.string(),
    applied_content: z.string(),
  }),
  applied_by: AppliedBy,
  rolled_back_at: z.coerce.date().nullable(),
});
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;

// ── Subject contract extension ──────────────────────────────────────────────
//
// All 8 new wisecron subjects implement this surface on top of TunableSubject.
// `apply()` must return a Patch (existing TunableSubject contract). `revert()`
// is wisecron-specific — it consumes the inverse_patch persisted in
// rollback_history.

export interface RevertibleSubject {
  readonly name: string;
  readonly risk_tier: RiskTier;
  revert(inversePatch: Patch): Promise<void>;
}

// ── Proposal lifecycle ──────────────────────────────────────────────────────

export interface ProposalSummary {
  proposal: Proposal;
  subject: string;
  risk_tier: RiskTier;
  diff_preview: string;
}

export interface ProposalCycleResult {
  subject: string;
  observations: number;
  clusters: number;
  proposals: UnsignedProposal[];
  duration_ms: number;
}

// ── Apply pipeline ──────────────────────────────────────────────────────────

export interface ApplyOutcome {
  revision: RevisionRecord;
  observation_window_armed: boolean;
  auto_reverted: boolean;
  audit_event_id: string;
}

export interface ObservationWindowResult {
  reverted: boolean;
  reason: string | null;
  errors_detected: string[];
}

// ── External (subprocess-backed) subjects ───────────────────────────────────
//
// A subject whose logic lives in an out-of-process program speaking the
// ExternalProcessSubject JSON-RPC protocol. ClaudeClaw stays GENERIC: the code
// hardcodes no specific external program. Operators declare their own under
// `wisecron.external_subjects` in their PRIVATE config.yaml (command + cwd +
// allowedRoots + fitnessSignals). This keeps the upstream-shippable code free of
// any one operator's tool while still enabling subprocess subjects.

/** Mirrors `Metric` in ../../skills-tuner/core/telemetry.ts. `source` is a
 *  TelemetryStream name or the literal "artifact" — kept as a free string so
 *  new streams need no schema bump; the activation gate degrades unknowns. */
export const MetricConfigSchema = z.object({
  name: z.string(),
  source: z.string(),
  kind: z.enum(["verifiable", "judge", "proxy_state"]).default("verifiable"),
  direction: z.enum(["lower_is_better", "higher_is_better"]),
  windowDays: z.number().int().min(0),
  guardrails: z.array(z.string()).optional(),
});

export const ExternalSubjectSettingsSchema = z.object({
  /** Unique subject name (registry key). */
  name: z.string(),
  /** Enabled flag (parallels per-subject enabled). */
  enabled: z.boolean().default(true),
  /** argv of the subprocess; command[0] is the executable. */
  command: z.array(z.string()).min(1),
  /** Working directory for the subprocess. */
  cwd: z.string().optional(),
  /** Extra environment variables merged over the parent process env. */
  env: z.record(z.string(), z.string()).optional(),
  /** Write-zone allowlist for apply() patches (REQUIRED before any apply). */
  allowedRoots: z.array(z.string()).optional(),
  riskTier: z.enum(["low", "medium", "high", "critical"]).optional(),
  autoMergeDefault: z.boolean().optional(),
  supportsCreation: z.boolean().optional(),
  orphanMinObservations: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().min(1).optional(),
  /** Opaque config object forwarded verbatim in every RPC envelope. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Static fitness declaration (sync, no RPC) — see ExternalProcessConfig. */
  fitnessSignals: z.array(MetricConfigSchema).optional(),
});
export type ExternalSubjectSettings = z.infer<typeof ExternalSubjectSettingsSchema>;

// ── Wisecron settings (extends TunerConfig.wisecron section) ────────────────

export const WisecronSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Global tuning scope for the wisecron-managed subjects (mirrors
   * TunerConfig.scope for this subject set). `all` reads every stream unfiltered;
   * `agent` restricts each subject to agent-originated telemetry. Override per
   * subject via `subjects.<name>.scope`. See ../../skills-tuner/core/scope.ts.
   */
  scope: z.enum(SCOPES).default("all"),
  db_path: z.string().default("~/.config/tuner/wisecron.db"),
  systemd_unit_prefix: z.string().default("wisecron-"),
  initial_interval_hours: z.number().int().min(1).default(INITIAL_INTERVAL_HOURS),
  max_interval_hours: z.number().int().min(1).default(MAX_INTERVAL_HOURS),
  llm_model_for_propose: z.string().default("claude-sonnet-4-6"),
  llm_call_path: z.enum(["direct-sdk", "llm-router"]).default("direct-sdk"),
  subjects: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean(),
        /** Per-subject scope override. Falls back to the global `scope` when omitted. */
        scope: z.enum(SCOPES).optional(),
        /**
         * Per-subject ctor overrides. Forwarded verbatim to the subject's
         * constructor opts (e.g. `{ hooksDir: '~/agent/hooks' }`). Keys recognised
         * are subject-specific — see each subject's `*SubjectConfig` interface and
         * the wisecron README "Per-subject config" table.
         */
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default({}),
  rollback: z
    .object({
      retention_days: z.number().int().min(1).default(90),
      require_confirm_on_rollback: z.boolean().default(true),
    })
    .default({}),
  /**
   * Subprocess-backed subjects (ExternalProcessSubject). Empty by default, so
   * the generic upstream build registers none. Operators add their own in their
   * private config.yaml. See ExternalSubjectSettingsSchema.
   */
  external_subjects: z.array(ExternalSubjectSettingsSchema).default([]),
});
export type WisecronSettings = z.infer<typeof WisecronSettingsSchema>;
