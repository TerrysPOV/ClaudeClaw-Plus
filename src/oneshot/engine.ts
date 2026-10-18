import { getSettings } from "../config.js";
import { parseOneShotSettings, resolveOneShotEngine, validateRouteEngine } from "./config.js";
import { validateIsolation } from "./isolation.js";
import { engines } from "./registry.js";
import { printRuntime } from "./print.js";

export interface OneShotRequest {
  route: string;
  prompt: string;
  system?: string;
  model?: string;
  isolation: "untrusted" | "trusted-session";
  resumeSessionId?: string;
  cwd?: string;
  allowedTools?: string[];
  maxTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OneShotResult {
  text: string;
  engine: string;
  model: string;
  exitCode: number;
  sessionId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface OneShotEngine {
  id: string;
  caps: { resume: boolean; tools: boolean; isolation: boolean };
  run(req: OneShotRequest): Promise<OneShotResult>;
}

export async function runOneShot(req: OneShotRequest): Promise<OneShotResult> {
  validateIsolation(req);
  // The standalone tuner does not load daemon settings. Only that absence
  // falls back; invalid loaded configuration is never swallowed.
  let settings: ReturnType<typeof parseOneShotSettings> | undefined;
  let defaultModel = "";
  try {
    settings = getSettings().oneShot;
    defaultModel = getSettings().model;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Settings not loaded")) throw error;
  }
  const id = printRuntime()?.forcePrint
    ? "print"
    : resolveOneShotEngine(settings ?? parseOneShotSettings(undefined), req.route);
  validateRouteEngine(
    id,
    req.route,
    req.isolation === "untrusted",
    req.resumeSessionId !== undefined,
  );
  const engine = engines.get(id)!;
  if (req.allowedTools !== undefined && !engine.caps.tools)
    throw new Error(`oneShot engine '${id}' does not support tools`);
  const started = Date.now();
  const request =
    req.isolation === "trusted-session" && req.model === undefined
      ? { ...req, model: defaultModel }
      : req;
  let result: OneShotResult | undefined;
  try {
    req.signal?.throwIfAborted();
    result = await engine.run(request);
    return result;
  } finally {
    console.info(
      `[oneshot] ${JSON.stringify({ route: req.route, engine: id, model: result?.model ?? req.model ?? "", isolation: req.isolation, ms: Date.now() - started, exitCode: result?.exitCode ?? 1, ...result?.usage })}`,
    );
  }
}
