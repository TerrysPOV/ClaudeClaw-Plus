import { getSettings } from "../config.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../plugins/llm-router/openrouter.js";
import { callLlm, type Dispatch } from "../plugins/llm-router/router.js";
import {
  type ChatMessage,
  type LlmRouterRuntimeConfig,
  ProviderError,
} from "../plugins/llm-router/types.js";
import type { OneShotRequest, OneShotResult } from "./engine.js";
import { chatEngineConfig, DEFAULT_OLLAMA_BASE_URL, routerEngineConfig } from "./http-config.js";
import { validateIsolation } from "./isolation.js";
import { stderrExcerpt } from "./redact.js";

interface Reply {
  content: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Declaration under the engine's own name, for calls made without one. */
function ownDeclaration(id: string): Record<string, unknown> {
  try {
    const declared = getSettings().oneShot.engines;
    return Object.hasOwn(declared, id) ? declared[id]! : {};
  } catch {
    return {}; // standalone caller without daemon settings
  }
}

function apiKey(envName: string | undefined): string | undefined {
  return (envName ? process.env[envName]?.trim() : undefined) || undefined;
}

function messages(req: OneShotRequest): ChatMessage[] {
  return [
    ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
    { role: "user", content: req.prompt },
  ];
}

/**
 * One `POST {baseUrl}/chat/completions`. The body never carries `tools` or
 * `tool_choice`; only the text content of the reply is read, so `tool_calls`
 * is ignored, never executed.
 */
async function postChat(
  baseUrl: string,
  model: string,
  chat: ChatMessage[],
  maxTokens: number | undefined,
  key: string | undefined,
  signal: AbortSignal,
): Promise<Reply> {
  const body: Record<string, unknown> = { model, messages: chat };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
      // An API endpoint does not redirect; following one could carry the key elsewhere.
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // Retriable for the router's fallback, like its own client. Fixed text: a
    // fetch error can quote the request headers, the key included.
    throw new ProviderError("network error", 503, model);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(`HTTP ${res.status}`, res.status, model);
  }
  let json: {
    model?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  let text: string;
  try {
    text = await readBounded(res, signal);
  } catch (error) {
    if (signal.aborted || error instanceof ProviderError) throw error;
    throw new ProviderError("network error", 503, model);
  }
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(`invalid JSON reply (HTTP ${res.status})`, res.status, model);
  }
  const content = json.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : "",
    model: typeof json.model === "string" && json.model ? json.model : model,
    ...(json.usage
      ? {
          usage: {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
          },
        }
      : {}),
  };
}

/** Same bound as the print engine's stdout. */
const REPLY_LIMIT = 16 * 1024 * 1024;

async function readBounded(res: Response, signal: AbortSignal): Promise<string> {
  const tooLarge = () =>
    new ProviderError(`reply over ${REPLY_LIMIT} bytes (HTTP ${res.status})`, res.status, "");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REPLY_LIMIT) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Deadline and caller abort on the request; failures become a non-zero exit code. */
async function dispatch(
  req: OneShotRequest,
  id: string,
  model: string,
  call: (signal: AbortSignal) => Promise<Reply>,
): Promise<OneShotResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const onAbort = (): void => controller.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  // Status and reason only: request, response body and headers stay out of logs.
  const fail = (exitCode: number, reason: string): OneShotResult => {
    console.warn(`[oneshot] ${JSON.stringify({ route: req.route, engine: id, model, reason })}`);
    return { text: "", engine: id, model, exitCode };
  };
  try {
    const reply = await call(controller.signal);
    const text = reply.content.trim();
    if (!text) return fail(1, "empty content");
    return {
      text,
      engine: id,
      model: reply.model,
      exitCode: 0,
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  } catch (error) {
    // Same exit code as the print engine when stopped.
    if (controller.signal.aborted)
      return fail(124, timedOut ? `timeout after ${req.timeoutMs}ms` : "aborted");
    // ProviderError text is ours (status, fixed words); anything else is masked.
    if (error instanceof ProviderError) return fail(1, error.message);
    return fail(1, stderrExcerpt(error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

async function runChat(
  req: OneShotRequest,
  id: string,
  declared: Record<string, unknown> | undefined,
  defaultBaseUrl?: string,
): Promise<OneShotResult> {
  validateIsolation(req);
  req.signal?.throwIfAborted();
  // The configured model wins: request models name Claude models.
  const config = chatEngineConfig(declared ?? ownDeclaration(id), id, defaultBaseUrl);
  const key = apiKey(config.apiKeyEnv);
  return dispatch(req, id, config.model, (signal) =>
    postChat(config.baseUrl, config.model, messages(req), req.maxTokens, key, signal),
  );
}

export function runOpenAiCompatible(
  req: OneShotRequest,
  declared?: Record<string, unknown>,
): Promise<OneShotResult> {
  return runChat(req, "openai-compatible", declared);
}

export function runOllama(
  req: OneShotRequest,
  declared?: Record<string, unknown>,
): Promise<OneShotResult> {
  return runChat(req, "ollama", declared, DEFAULT_OLLAMA_BASE_URL);
}

function routerSettings(): LlmRouterRuntimeConfig {
  try {
    const { tiers, openRouterBaseUrl } = getSettings().llmRouter;
    return { tiers, openRouterBaseUrl };
  } catch {
    return {
      tiers: { fast: [], balanced: [], reasoning: [] },
      openRouterBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    };
  }
}

/** Tier resolution and model fallback stay in the router's `callLlm`. */
export async function runLlmRouter(
  req: OneShotRequest,
  declared?: Record<string, unknown>,
): Promise<OneShotResult> {
  validateIsolation(req);
  req.signal?.throwIfAborted();
  const config = routerEngineConfig(declared ?? ownDeclaration("llm-router"), "llm-router");
  const router = routerSettings();
  const key = apiKey(config.apiKeyEnv);
  const baseUrl = router.openRouterBaseUrl.replace(/\/+$/, "");
  return dispatch(req, "llm-router", `tier:${config.tier}`, async (signal) => {
    // callLlm folds every model's error into one long message; report the last
    // provider error instead, so the status survives and nothing else is logged.
    let last: ProviderError | undefined;
    let tried = 0;
    const dispatchModel: Dispatch = async (model, opts) => {
      signal.throwIfAborted();
      tried++;
      try {
        const reply = await postChat(baseUrl, model, opts.messages, opts.maxTokens, key, signal);
        // Retriable, so an empty answer moves on to the next tier model.
        if (!reply.content.trim()) throw new ProviderError("empty content", 502, model);
        const usage = {
          input: reply.usage?.inputTokens ?? 0,
          output: reply.usage?.outputTokens ?? 0,
        };
        return {
          content: reply.content,
          model: reply.model,
          usage: {
            promptTokens: usage.input,
            completionTokens: usage.output,
            totalTokens: usage.input + usage.output,
          },
          schemaApplied: false,
        };
      } catch (error) {
        if (error instanceof ProviderError) last = error;
        throw error;
      }
    };
    let result: Awaited<ReturnType<typeof callLlm>>;
    try {
      result = await callLlm(
        { tier: config.tier, messages: messages(req), maxTokens: req.maxTokens },
        router,
        dispatchModel,
      );
    } catch (error) {
      if (error instanceof ProviderError || !last) throw error;
      throw new ProviderError(`${last.message} (${tried} model(s) tried)`, last.status, last.model);
    }
    return {
      content: result.content,
      model: result.model,
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      },
    };
  });
}
