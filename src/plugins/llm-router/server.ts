/**
 * LLM router MCP stdio server (#70).
 *
 * Hosted as a multiplexer shared server (register "llm-router" in
 * settings.mcp.shared + an mcp-proxy.json entry). Exposes two tools:
 *   - llm_call({ tier|model, messages, schema?, providerHint?, maxTokens? })
 *   - llm_models({ query?, maxPromptPrice?, minContext?, limit? })
 *
 * Run standalone:  bun run src/plugins/llm-router/server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMcpBridge } from "../mcp-bridge.js";
import { loadSettings } from "../../config.js";
import { chatCompletion, DEFAULT_OPENROUTER_BASE_URL, type OpenRouterDeps } from "./openrouter.js";
import { ModelCatalogue } from "./catalogue.js";
import { callLlm, type Dispatch } from "./router.js";
import {
  TIERS,
  type LlmCallParams,
  type LlmModelsParams,
  type LlmRouterRuntimeConfig,
} from "./types.js";

const LLM_CALL_TOOL = {
  name: "llm_call",
  description:
    "Dispatch a chat completion across providers via OpenRouter. Route by cost tier " +
    "(fast|balanced|reasoning, mapped to models in settings.llmRouter) or pass an explicit " +
    "OpenRouter `model` id to bypass tiers. Non-streaming. Falls over to the next model in the " +
    "tier on 429/5xx.",
  inputSchema: {
    type: "object",
    properties: {
      tier: { type: "string", enum: ["fast", "balanced", "reasoning"] },
      model: { type: "string", description: "Explicit OpenRouter model id; bypasses tier." },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
            content: { type: "string" },
          },
          required: ["role", "content"],
        },
      },
      schema: { type: "object", description: "JSON schema for structured output (best-effort)." },
      providerHint: { type: "string" },
      maxTokens: { type: "number" },
    },
    required: ["messages"],
  },
} as const;

const LLM_MODELS_TOOL = {
  name: "llm_models",
  description:
    "Search the OpenRouter model catalogue (cached). Returns matching models with context " +
    "length and per-token pricing so you can pick ids for settings.llmRouter tiers or a per-call model.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive substring over id + name." },
      maxPromptPrice: { type: "number", description: "Max prompt price (USD/token)." },
      minContext: { type: "number", description: "Min context window (tokens)." },
      limit: { type: "number", description: "Max results (default 50)." },
    },
  },
} as const;

export function buildRuntimeConfig(settings: {
  llmRouter?: Partial<LlmRouterRuntimeConfig>;
}): LlmRouterRuntimeConfig {
  const cfg = settings.llmRouter ?? {};
  const tiers = cfg.tiers ?? { fast: [], balanced: [], reasoning: [] };
  return {
    tiers: {
      fast: tiers.fast ?? [],
      balanced: tiers.balanced ?? [],
      reasoning: tiers.reasoning ?? [],
    },
    openRouterBaseUrl: cfg.openRouterBaseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
    ...(cfg.ollamaBaseUrl ? { ollamaBaseUrl: cfg.ollamaBaseUrl } : {}),
  };
}

export interface LlmRouterHandlerDeps {
  config: LlmRouterRuntimeConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Catalogue override for tests. */
  catalogue?: ModelCatalogue;
  audit?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * The tool logic, decoupled from the stdio transport so it's unit-testable.
 * Returns the raw result object (the transport layer JSON-stringifies it).
 */
export function createLlmRouterHandlers(deps: LlmRouterHandlerDeps) {
  const orDeps: OpenRouterDeps = {
    apiKey: deps.apiKey,
    baseUrl: deps.config.openRouterBaseUrl,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const catalogue = deps.catalogue ?? new ModelCatalogue(orDeps);
  const audit = deps.audit ?? (() => {});
  const dispatch: Dispatch = (model, opts) => chatCompletion(model, opts, orDeps);

  async function llmCall(rawArgs: Record<string, unknown>) {
    if (!deps.apiKey) throw new Error("OPENROUTER_API_KEY is not set in the daemon environment.");
    const params = parseLlmCallArgs(rawArgs);
    const startedAt = Date.now();
    try {
      const result = await callLlm(params, deps.config, dispatch);
      audit("llm_call_dispatched", {
        tier: params.tier ?? null,
        model: result.model,
        provider: result.provider,
        latencyMs: Date.now() - startedAt,
        usage: result.usage,
      });
      if (result.fallbackFrom?.length) {
        audit("llm_call_fallback_taken", { from: result.fallbackFrom, to: result.model });
      }
      return result;
    } catch (err) {
      audit("llm_call_failed", {
        tier: params.tier ?? null,
        model: params.model ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async function llmModels(rawArgs: Record<string, unknown>) {
    if (!deps.apiKey) throw new Error("OPENROUTER_API_KEY is not set in the daemon environment.");
    const params = parseLlmModelsArgs(rawArgs);
    const { models, cachedAt } = await catalogue.search(params);
    audit("llm_models_listed", { query: params.query ?? null, returned: models.length });
    return { models, cachedAt };
  }

  return { llmCall, llmModels };
}

function parseLlmCallArgs(raw: Record<string, unknown>): LlmCallParams {
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("llm_call: `messages` must be a non-empty array.");
  }
  const tier = raw.tier;
  if (tier !== undefined && !TIERS.includes(tier as (typeof TIERS)[number])) {
    throw new Error(`llm_call: invalid tier "${String(tier)}" (expected fast|balanced|reasoning).`);
  }
  return {
    ...(typeof tier === "string" ? { tier: tier as LlmCallParams["tier"] } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    messages: messages as LlmCallParams["messages"],
    ...(raw.schema && typeof raw.schema === "object"
      ? { schema: raw.schema as Record<string, unknown> }
      : {}),
    ...(typeof raw.providerHint === "string" ? { providerHint: raw.providerHint } : {}),
    ...(typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {}),
  };
}

function parseLlmModelsArgs(raw: Record<string, unknown>): LlmModelsParams {
  return {
    ...(typeof raw.query === "string" ? { query: raw.query } : {}),
    ...(typeof raw.maxPromptPrice === "number" ? { maxPromptPrice: raw.maxPromptPrice } : {}),
    ...(typeof raw.minContext === "number" ? { minContext: raw.minContext } : {}),
    ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
  };
}

export async function startLlmRouterServer(): Promise<void> {
  const settings = await loadSettings();
  const config = buildRuntimeConfig(settings as { llmRouter?: Partial<LlmRouterRuntimeConfig> });
  const bridge = getMcpBridge();
  const handlers = createLlmRouterHandlers({
    config,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    audit: (event, payload) => bridge.audit(event, payload),
  });

  const server = new Server(
    { name: "llm-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LLM_CALL_TOOL, LLM_MODELS_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result =
        name === "llm_call"
          ? await handlers.llmCall(args ?? {})
          : name === "llm_models"
            ? await handlers.llmModels(args ?? {})
            : (() => {
                throw new Error(`unknown tool: ${name}`);
              })();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startLlmRouterServer().catch((err) => {
    console.error("[llm-router] Fatal:", err);
    process.exit(1);
  });
}
