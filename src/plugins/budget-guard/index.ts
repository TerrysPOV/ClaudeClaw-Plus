import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMcpBridge } from "../mcp-bridge.js";
import { getHttpGateway } from "../http-gateway.js";
import { BudgetGuardDb, type Window } from "./db.js";
import {
  BudgetGuardSettingsSchema,
  CheckBudgetArgsSchema,
  CurrentUsageArgsSchema,
  ListScopesArgsSchema,
  ResetScopeArgsSchema,
  RecordUsageArgsSchema,
  type BudgetGuardSettings,
  type CheckBudgetReturn,
} from "./types.js";

const PLUGIN_ID = "budget-guard";
const WARNING_THRESHOLDS_DEFAULT = [0.5, 0.8, 0.95];

export interface BudgetGuardPluginOpts {
  configOverride?: Partial<BudgetGuardSettings>;
  tokenPath?: string;
  dbPath?: string;
}

export class BudgetGuardPlugin {
  private settings: BudgetGuardSettings;
  private tokenPath: string;
  private pluginToken: Buffer | null = null;
  private db: BudgetGuardDb | null = null;
  private startedAt: Date | null = null;
  private started = false;
  private firedThresholds = new Map<string, Set<number>>();

  constructor(opts: BudgetGuardPluginOpts = {}) {
    this.settings = BudgetGuardSettingsSchema.parse(opts.configOverride ?? {});
    this.tokenPath = opts.tokenPath ?? join(homedir(), ".config", "claudeclaw", `${PLUGIN_ID}.token`);
    if (opts.dbPath) this.settings = { ...this.settings, database_path: opts.dbPath };
  }

  async start(): Promise<void> {
    if (this.started) return;

    try {
      const stat = statSync(this.tokenPath);
      if (stat.mode & 0o077) {
        console.error(
          `[${PLUGIN_ID}] WARN: ${this.tokenPath} has permissive permissions (${(stat.mode & 0o777).toString(8)}); recommended 0600.`
        );
      }
    } catch {}

    this.db = new BudgetGuardDb(this.settings.database_path);

    for (const scope of this.settings.scopes) {
      this.db.upsertScope(scope);
    }

    this._registerTools();
    this._registerWithGateway();

    this.startedAt = new Date();
    this.started = true;

    getMcpBridge().audit("budget_guard_started", {
      scope_count: this.settings.scopes.length,
      db_path: this.settings.database_path,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.db?.close();
    this.db = null;
    getMcpBridge().audit("budget_guard_stopped", {});
  }

  health(): Record<string, unknown> {
    const db = this.db;
    const now = Date.now();
    const uptime_s = this.startedAt ? Math.floor((now - this.startedAt.getTime()) / 1000) : 0;

    if (!db) {
      return { status: "stopped", uptime_s };
    }

    let total_calls_24h = 0;
    let total_denied_24h = 0;
    let oldest_record_iso: string | null = null;

    try {
      for (const row of db.listScopes()) {
        total_calls_24h += db.getCallCountInWindow(row.scope, "daily");
      }
    } catch {}

    return {
      status: "up",
      uptime_s,
      db_size_bytes: db.getDbSizeBytes(),
      scope_count: this.settings.scopes.length,
      total_calls_24h,
      total_denied_24h,
      oldest_record_iso,
      last_invocation_at: null,
    };
  }

  private _checkBudget(scope: string): CheckBudgetReturn {
    const db = this._requireDb();
    const scopeRow = db.getScope(scope);

    if (!scopeRow) {
      return {
        allow: true,
        remaining_usd: Infinity,
        daily_used: 0,
        weekly_used: 0,
        reset_at_iso: new Date(Date.now() + 86400_000).toISOString(),
      };
    }

    const dailyUsed = db.getUsedInWindow(scope, "daily");
    const weeklyUsed = db.getUsedInWindow(scope, "weekly");
    const monthlyUsed = db.getUsedInWindow(scope, "monthly");
    const dailyCap = scopeRow.daily_cap_usd;
    const weeklyCap = scopeRow.weekly_cap_usd;
    const monthlyCap = scopeRow.monthly_cap_usd;
    const remaining = dailyCap - dailyUsed;

    // Check daily, weekly, and monthly caps
    let exceededWindow: "daily" | "weekly" | "monthly" | null = null;
    if (dailyUsed >= dailyCap) {
      exceededWindow = "daily";
    } else if (weeklyCap != null && weeklyUsed >= weeklyCap) {
      exceededWindow = "weekly";
    } else if (monthlyCap != null && monthlyUsed >= monthlyCap) {
      exceededWindow = "monthly";
    }

    this._fireThresholdEvents(scope, dailyUsed, dailyCap);

    if (exceededWindow) {
      getMcpBridge().audit("budget_guard_denied", {
        scope,
        window: exceededWindow,
        daily_used: dailyUsed,
        daily_cap: dailyCap,
        ...(weeklyCap != null ? { weekly_used: weeklyUsed, weekly_cap: weeklyCap } : {}),
        ...(monthlyCap != null ? { monthly_used: monthlyUsed, monthly_cap: monthlyCap } : {}),
      });
    } else {
      getMcpBridge().audit("budget_guard_allowed", {
        scope,
        daily_used: dailyUsed,
        daily_cap: dailyCap,
        remaining_usd: remaining,
      });
    }

    return {
      allow: exceededWindow ? !scopeRow.deny_when_exceeded : true,
      remaining_usd: Math.max(0, remaining),
      daily_used: dailyUsed,
      weekly_used: weeklyUsed,
      reset_at_iso: new Date(Date.now() + 86400_000).toISOString(),
    };
  }

  private _fireThresholdEvents(scope: string, used: number, cap: number): void {
    if (cap <= 0) return;
    const fraction = used / cap;
    const thresholds = [...(this.settings.default_warning_thresholds ?? WARNING_THRESHOLDS_DEFAULT)].sort((a, b) => a - b);

    if (!this.firedThresholds.has(scope)) {
      this.firedThresholds.set(scope, new Set());
    }
    const fired = this.firedThresholds.get(scope)!;

    for (const threshold of thresholds) {
      if (fraction >= threshold && !fired.has(threshold)) {
        fired.add(threshold);
        getMcpBridge().audit("budget_guard_threshold_crossed", {
          scope,
          fraction,
          threshold,
          used_usd: used,
          cap_usd: cap,
        });
      }
    }

    if (fraction < (thresholds[0] ?? 0.5)) {
      fired.clear();
    }
  }

  private _registerTools(): void {
    const bridge = getMcpBridge();

    bridge.registerPluginTool(PLUGIN_ID, {
      name: "check_budget",
      description: "Pre-flight check: returns allow/deny + remaining budget for a scope.",
      schema: CheckBudgetArgsSchema,
      handler: async (input) => this._checkBudget(input.scope),
    });

    bridge.registerPluginTool(PLUGIN_ID, {
      name: "current_usage",
      description: "Returns usage statistics for a scope within a time window.",
      schema: CurrentUsageArgsSchema,
      handler: async (input) => {
        const db = this._requireDb();
        const window: Window = (input.window as Window) ?? "daily";
        const scopeRow = db.getScope(input.scope);
        const cap = scopeRow?.daily_cap_usd ?? 0;
        return {
          scope: input.scope,
          window,
          used_usd: db.getUsedInWindow(input.scope, window),
          cap_usd: window === "daily" ? cap : (window === "weekly" ? (scopeRow?.weekly_cap_usd ?? 0) : (scopeRow?.monthly_cap_usd ?? 0)),
          calls: db.getCallCountInWindow(input.scope, window),
          last_call_iso: db.getLastCallAt(input.scope),
        };
      },
    });

    bridge.registerPluginTool(PLUGIN_ID, {
      name: "list_scopes",
      description: "Lists all configured budget scopes.",
      schema: ListScopesArgsSchema,
      handler: async (_input) => {
        const db = this._requireDb();
        return db.listScopes().map((row) => ({
          scope: row.scope,
          daily_cap_usd: row.daily_cap_usd,
          weekly_cap_usd: row.weekly_cap_usd,
        }));
      },
    });

    bridge.registerPluginTool(PLUGIN_ID, {
      name: "reset_scope",
      description: "Resets usage counters for a scope. Admin operation — audit-trailed.",
      schema: ResetScopeArgsSchema,
      handler: async (input) => {
        const db = this._requireDb();
        const resets = db.resetWindow(input.scope, input.window);
        getMcpBridge().audit("budget_guard_scope_reset", {
          scope: input.scope,
          window: input.window,
        });
        return { scope: input.scope, resets };
      },
    });

    bridge.registerPluginTool(PLUGIN_ID, {
      name: "record_usage",
      description: "Records a completed LLM call cost against a scope.",
      schema: RecordUsageArgsSchema,
      handler: async (input) => {
        const db = this._requireDb();
        db.recordUsage(
          input.scope,
          input.call_id,
          input.model,
          input.cost_usd,
          input.tokens_in,
          input.tokens_out
        );
        const status = this._checkBudget(input.scope);
        return {
          recorded: true as const,
          scope_status: { allow: status.allow, remaining_usd: status.remaining_usd },
        };
      },
    });
  }

  private _registerWithGateway(): void {
    const gateway = getHttpGateway();
    this.pluginToken = gateway.registerInProcess(PLUGIN_ID, {
      version: "1.0.0",
      tools: [
        { name: "check_budget", description: "Pre-flight budget check", schema: {} },
        { name: "current_usage", description: "Scope usage stats", schema: {} },
        { name: "list_scopes", description: "List configured scopes", schema: {} },
        { name: "reset_scope", description: "Reset scope usage (admin)", schema: {} },
        { name: "record_usage", description: "Record LLM call cost", schema: {} },
      ],
      healthFn: async () => this.health(),
    });

    mkdirSync(join(this.tokenPath, ".."), { recursive: true });
    writeFileSync(this.tokenPath, this.pluginToken.toString("hex"), { encoding: "utf8", mode: 0o600 });
  }

  private _requireDb(): BudgetGuardDb {
    if (!this.db) throw new Error(`[${PLUGIN_ID}] not started`);
    return this.db;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _plugin: BudgetGuardPlugin | null = null;

export function getBudgetGuardPlugin(opts?: BudgetGuardPluginOpts): BudgetGuardPlugin {
  if (!_plugin) _plugin = new BudgetGuardPlugin(opts);
  return _plugin;
}

export function _resetBudgetGuard(): void {
  _plugin = null;
}
