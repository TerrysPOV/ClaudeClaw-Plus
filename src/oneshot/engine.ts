import { getSettings } from "../config.js";
import {
  engineType,
  parseOneShotSettings,
  resolveOneShotEngine,
  validateRouteEngine,
} from "./config.js";
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
  /**
   * Permission rules to pre-approve, `--allowedTools` syntax: bare names or scoped
   * rules such as `Edit(//abs/path)`. `[]` means no tools. Trusted-session only.
   */
  allowedTools?: string[];
  /**
   * Bare built-in tool names to make available (`--tools`). Optional: when absent the
   * unique bare names of `allowedTools` are used. Needed when the rule name differs
   * from the tool, e.g. `Edit(//p)` governs the Write tool too. Trusted-session only.
   */
  tools?: string[];
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
  /** Throws on settings this engine cannot run with; called at settings load. */
  checkConfig?(config: Record<string, unknown>, name: string): void;
  /** `config` is the `oneShot.engines` declaration the route named, if any. */
  run(req: OneShotRequest, config?: Record<string, unknown>): Promise<OneShotResult>;
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
  const declarations = settings?.engines ?? {};
  validateRouteEngine(
    id,
    req.route,
    req.isolation === "untrusted",
    req.resumeSessionId !== undefined,
    declarations,
  );
  const engine = engines.get(engineType(id, declarations))!;
  if ((req.allowedTools !== undefined || req.tools !== undefined) && !engine.caps.tools)
    throw new Error(`oneShot engine '${id}' does not support tools`);
  const started = Date.now();
  const request =
    req.isolation === "trusted-session" && req.model === undefined
      ? { ...req, model: defaultModel }
      : req;
  let result: OneShotResult | undefined;
  try {
    req.signal?.throwIfAborted();
    result = await engine.run(
      request,
      Object.hasOwn(declarations, id) ? declarations[id] : undefined,
    );
    return result;
  } finally {
    console.info(
      `[oneshot] ${JSON.stringify({ route: req.route, engine: id, model: result?.model ?? req.model ?? "", isolation: req.isolation, ms: Date.now() - started, exitCode: result?.exitCode ?? 1, ...result?.usage })}`,
    );
  }
}
