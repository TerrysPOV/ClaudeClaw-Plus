import { z } from "zod";

// ── Scope config ──────────────────────────────────────────────────────────────

export const ScopeConfigSchema = z.object({
  name: z.string(),
  daily_cap_usd: z.number().nonnegative(),
  weekly_cap_usd: z.number().nonnegative().optional(),
  monthly_cap_usd: z.number().nonnegative().optional(),
  deny_when_exceeded: z.boolean().default(true),
});
export type ScopeConfig = z.infer<typeof ScopeConfigSchema>;

// ── Plugin settings ───────────────────────────────────────────────────────────

export const BudgetGuardSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  database_path: z.string().default("~/.config/claudeclaw/budget-guard.db"),
  default_warning_thresholds: z.array(z.number().min(0).max(1)).default([0.5, 0.8, 0.95]),
  scopes: z.array(ScopeConfigSchema).default([
    { name: "default", daily_cap_usd: 5.0, weekly_cap_usd: 25.0, monthly_cap_usd: 80.0, deny_when_exceeded: true },
  ]),
});
export type BudgetGuardSettings = z.infer<typeof BudgetGuardSettingsSchema>;

// ── Tool args ─────────────────────────────────────────────────────────────────

export const CheckBudgetArgsSchema = z.object({
  scope: z.string(),
});

export const CurrentUsageArgsSchema = z.object({
  scope: z.string(),
  window: z.enum(["daily", "weekly", "monthly"]).optional(),
});

export const ListScopesArgsSchema = z.object({});

export const ResetScopeArgsSchema = z.object({
  scope: z.string(),
  window: z.enum(["daily", "weekly", "monthly", "all"]),
});

export const RecordUsageArgsSchema = z.object({
  scope: z.string(),
  cost_usd: z.number().nonnegative(),
  model: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  call_id: z.string(),
});

// ── Tool returns ──────────────────────────────────────────────────────────────

export const CheckBudgetReturnSchema = z.object({
  allow: z.boolean(),
  remaining_usd: z.number(),
  daily_used: z.number(),
  weekly_used: z.number(),
  reset_at_iso: z.string(),
});
export type CheckBudgetReturn = z.infer<typeof CheckBudgetReturnSchema>;

export const CurrentUsageReturnSchema = z.object({
  scope: z.string(),
  window: z.string(),
  used_usd: z.number(),
  cap_usd: z.number(),
  calls: z.number().int(),
  last_call_iso: z.string().nullable(),
});

export const ListScopesReturnSchema = z.array(
  z.object({
    scope: z.string(),
    daily_cap_usd: z.number(),
    weekly_cap_usd: z.number().nullable(),
  })
);

export const ResetScopeReturnSchema = z.object({
  scope: z.string(),
  resets: z.array(z.string()),
});

export const RecordUsageReturnSchema = z.object({
  recorded: z.literal(true),
  scope_status: z.object({
    allow: z.boolean(),
    remaining_usd: z.number(),
  }),
});

// ── Internal DB row types ─────────────────────────────────────────────────────

export interface UsageRecord {
  id: number;
  scope: string;
  call_id: string;
  model: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  recorded_at: string;
}

export interface ScopeRow {
  scope: string;
  daily_cap_usd: number;
  weekly_cap_usd: number | null;
  monthly_cap_usd: number | null;
  deny_when_exceeded: number; // SQLite boolean
}
