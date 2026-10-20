/**
 * Dashboard read/update helper for `settings.llmRouter` (#70 Phase C). Mirrors
 * `settings.ts` (heartbeat) — direct settings.json read + mutate sub-section +
 * writeFile.
 *
 * Only `tiers` are operator-editable from the dashboard in v1; advanced fields
 * (`openRouterBaseUrl`, `ollamaBaseUrl`) stay JSON-only to avoid widening the
 * UI surface.
 */

import { readFile, writeFile } from "fs/promises";
import { getSettingsFile } from "../../config";
import { parseSettingsForRewrite } from "../../settings-json";

export interface LlmRouterTiers {
  fast: string[];
  balanced: string[];
  reasoning: string[];
}

export interface LlmRouterSettingsPatch {
  tiers?: Partial<LlmRouterTiers>;
}

export interface LlmRouterSettingsData {
  tiers: LlmRouterTiers;
  openRouterBaseUrl: string;
  ollamaBaseUrl?: string;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

function toIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim());
}

function canonical(data: Record<string, unknown>): LlmRouterSettingsData {
  const lr = (data.llmRouter as Record<string, unknown> | undefined) ?? {};
  const tiersRaw = (lr.tiers as Record<string, unknown> | undefined) ?? {};
  const baseUrl =
    typeof lr.openRouterBaseUrl === "string" && lr.openRouterBaseUrl.trim()
      ? lr.openRouterBaseUrl.trim()
      : DEFAULT_BASE;
  return {
    tiers: {
      fast: toIdList(tiersRaw.fast),
      balanced: toIdList(tiersRaw.balanced),
      reasoning: toIdList(tiersRaw.reasoning),
    },
    openRouterBaseUrl: baseUrl,
    ...(typeof lr.ollamaBaseUrl === "string" && lr.ollamaBaseUrl.trim()
      ? { ollamaBaseUrl: lr.ollamaBaseUrl.trim() }
      : {}),
  };
}

export async function readLlmRouterSettings(): Promise<LlmRouterSettingsData> {
  const raw = await readFile(getSettingsFile(), "utf-8");
  return canonical(JSON.parse(raw) as Record<string, unknown>);
}

export async function updateLlmRouterSettings(
  patch: LlmRouterSettingsPatch,
): Promise<LlmRouterSettingsData> {
  const raw = await readFile(getSettingsFile(), "utf-8");
  const data = parseSettingsForRewrite(raw);
  if (!data.llmRouter || typeof data.llmRouter !== "object") {
    data.llmRouter = {
      tiers: { fast: [], balanced: [], reasoning: [] },
      openRouterBaseUrl: DEFAULT_BASE,
    };
  }
  const lr = data.llmRouter as Record<string, unknown>;
  if (!lr.tiers || typeof lr.tiers !== "object")
    lr.tiers = { fast: [], balanced: [], reasoning: [] };
  const tiers = lr.tiers as Record<string, unknown>;

  if (patch.tiers) {
    if (patch.tiers.fast !== undefined) tiers.fast = toIdList(patch.tiers.fast);
    if (patch.tiers.balanced !== undefined) tiers.balanced = toIdList(patch.tiers.balanced);
    if (patch.tiers.reasoning !== undefined) tiers.reasoning = toIdList(patch.tiers.reasoning);
  }

  await writeFile(getSettingsFile(), `${JSON.stringify(data, null, 2)}\n`);
  return canonical(data);
}
