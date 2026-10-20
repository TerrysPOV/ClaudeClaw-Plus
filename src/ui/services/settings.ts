import { readFile, writeFile } from "fs/promises";
import { getSettingsFile } from "../../config";
import { parseSettingsForRewrite } from "../../settings-json";

export async function setHeartbeatEnabled(enabled: boolean): Promise<void> {
  await updateHeartbeatSettings({ enabled });
}

export interface HeartbeatSettingsPatch {
  enabled?: boolean;
  interval?: number;
  prompt?: string;
  excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
}

export interface HeartbeatSettingsData {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: Array<{ days?: number[]; start: string; end: string }>;
}

export async function readHeartbeatSettings(): Promise<HeartbeatSettingsData> {
  const raw = await readFile(getSettingsFile(), "utf-8");
  const data = JSON.parse(raw) as Record<string, any>;
  if (!data.heartbeat || typeof data.heartbeat !== "object") data.heartbeat = {};
  return {
    enabled: Boolean(data.heartbeat.enabled),
    interval: Number(data.heartbeat.interval) || 15,
    prompt: typeof data.heartbeat.prompt === "string" ? data.heartbeat.prompt : "",
    excludeWindows: Array.isArray(data.heartbeat.excludeWindows)
      ? data.heartbeat.excludeWindows
      : [],
  };
}

export async function updateHeartbeatSettings(
  patch: HeartbeatSettingsPatch,
): Promise<HeartbeatSettingsData> {
  const raw = await readFile(getSettingsFile(), "utf-8");
  const data = parseSettingsForRewrite(raw) as Record<string, any>;
  if (!data.heartbeat || typeof data.heartbeat !== "object") data.heartbeat = {};

  if (typeof patch.enabled === "boolean") {
    data.heartbeat.enabled = patch.enabled;
  }
  if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
    const clamped = Math.max(1, Math.min(1440, Math.round(patch.interval)));
    data.heartbeat.interval = clamped;
  }
  if (typeof patch.prompt === "string") {
    data.heartbeat.prompt = patch.prompt;
  }
  if (Array.isArray(patch.excludeWindows)) {
    data.heartbeat.excludeWindows = patch.excludeWindows;
  }

  const text = JSON.stringify(data, null, 2) + "\n";
  await writeFile(getSettingsFile(), text);
  // Answer from a plain parse of what was written: the kept integers are
  // JSON.rawJSON objects, which Number() cannot read.
  const saved = (JSON.parse(text) as Record<string, any>).heartbeat;
  return {
    enabled: Boolean(saved.enabled),
    interval: Number(saved.interval) || 15,
    prompt: typeof saved.prompt === "string" ? saved.prompt : "",
    excludeWindows: Array.isArray(saved.excludeWindows) ? saved.excludeWindows : [],
  };
}
