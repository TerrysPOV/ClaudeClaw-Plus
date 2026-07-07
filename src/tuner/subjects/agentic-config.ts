/**
 * agentic-config — reconciles the model_routing benchmark reroute (#292) with how
 * ClaudeClaw ACTUALLY stores routing: the `agentic` block of settings.json (a LIST
 * of {name, model, keywords}), NOT a standalone agentic.yaml map. It also maps the
 * operator's model names to Artificial Analysis slugs and constrains reroute
 * candidates to models the runtime can actually invoke.
 *
 * Runnable-model constraint: ClaudeClaw launches `claude --model <x>`, so a reroute
 * to a non-Claude model (minimax, command-a, …) is not applicable until an
 * llm-router provider exists. Until then candidates are Claude-only — which is also
 * where the real win is (e.g. claude-3-5-sonnet → claude-sonnet-5: better AND
 * cheaper). Keep this list curated as models ship.
 */
import type { ModelBenchmark } from "./model-routing-benchmarks.js";

/** Operator model name (settings.json) → Artificial Analysis slug. Extend as models ship. */
export const CLAUDE_SLUG_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-7-non-reasoning",
  haiku: "claude-3-5-haiku",
  "claude-3-5-sonnet": "claude-35-sonnet",
  "claude-3-5-haiku": "claude-3-5-haiku",
  "claude-3-haiku": "claude-3-haiku",
  "claude-sonnet-5": "claude-sonnet-5",
};

/** Normalize an operator model name to the AA slug used for benchmark lookup. */
export function toAaSlug(model: string): string {
  const key = model.trim().toLowerCase();
  return CLAUDE_SLUG_ALIASES[key] ?? key;
}

/** Is this benchmark a Claude model (the only thing ClaudeClaw can run today)? */
export function isRunnableModel(b: ModelBenchmark): boolean {
  return b.model_id.toLowerCase().includes("claude");
}

export interface AgenticAssignment {
  /** Mode name (settings.json agentic.modes[].name). */
  mode: string;
  /** Operator model name as written in the config. */
  model: string;
  /** The AA slug used to look this model up in the benchmark set. */
  aaSlug: string;
}

/**
 * Read `agentic.modes` from a settings.json string. Returns [] gracefully on parse
 * failure, a disabled block, or no modes — a config problem must never throw into
 * the proactive loop.
 */
export function readAgenticModes(settingsContent: string): AgenticAssignment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsContent);
  } catch {
    return [];
  }
  const agentic = (parsed as { agentic?: unknown })?.agentic as { modes?: unknown } | undefined;
  const modes = agentic?.modes;
  if (!Array.isArray(modes)) return [];
  const out: AgenticAssignment[] = [];
  for (const m of modes) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const mode = typeof r.name === "string" ? r.name.trim() : "";
    const model = typeof r.model === "string" ? r.model.trim() : "";
    if (!mode || !model) continue;
    out.push({ mode, model, aaSlug: toAaSlug(model) });
  }
  return out;
}

/**
 * Set the `model` of a specific mode in a settings.json string, preserving the rest
 * byte-for-byte via a structural JSON round-trip. Returns the original string
 * unchanged if the mode is absent or the JSON can't be parsed (never corrupts).
 */
export function setAgenticModel(settingsContent: string, mode: string, newModel: string): string {
  let parsed: { agentic?: { modes?: Array<{ name?: string; model?: string }> } };
  try {
    parsed = JSON.parse(settingsContent);
  } catch {
    return settingsContent;
  }
  const modes = parsed.agentic?.modes;
  if (!Array.isArray(modes)) return settingsContent;
  const target = modes.find((m) => m && m.name === mode);
  if (!target) return settingsContent;
  target.model = newModel;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
