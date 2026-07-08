/**
 * Eval-framework MCP stdio server (#80).
 *
 * Hosted like the llm-router plugin: register "eval-framework" in
 * settings.mcp.shared + an mcp-proxy.json entry, or run standalone:
 *
 *   bun run src/plugins/eval-framework/server.ts
 *
 * Configuration comes from `settings.governance.evalFramework` (see
 * src/config.ts parseGovernanceConfig); the server refuses to start when the
 * block is absent or `enabled` is false — evals spend real provider tokens,
 * so the operator opts in explicitly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadSettings } from "../../config.js";
import { EvalFrameworkPlugin } from "./index.js";

// Hand-written JSON input schemas for MCP list_tools (zod does runtime
// validation inside the handlers; these describe the wire contract).
const TOOL_INPUT_SCHEMAS: Record<string, object> = {
  run_eval: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Eval task id (plain identifier)." },
      model_id: { type: "string", description: "Model under evaluation." },
      set_id: { type: "string", description: "Eval set id (default: 'default')." },
      max_cost_usd: { type: "number", description: "Hard cost ceiling for the run." },
    },
    required: ["task_id", "model_id"],
  },
  run_cascade_eval: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      cheap_model: { type: "string", description: "First-tier (cheap) model." },
      escalation_model: { type: "string", description: "Escalation (premium) model." },
      set_id: { type: "string" },
      max_cost_usd: { type: "number" },
    },
    required: ["task_id", "cheap_model", "escalation_model"],
  },
  compare_models: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      model_ids: { type: "array", items: { type: "string" }, minItems: 1 },
      set_id: { type: "string" },
      max_cost_usd: { type: "number" },
    },
    required: ["task_id", "model_ids"],
  },
  recommend_tier: {
    type: "object",
    properties: { task_id: { type: "string" } },
    required: ["task_id"],
  },
  list_runs: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      since_iso: { type: "string" },
      limit: { type: "number" },
    },
  },
  get_run_report: {
    type: "object",
    properties: { run_id: { type: "string" } },
    required: ["run_id"],
  },
  validate_eval_set: {
    type: "object",
    properties: { set_path: { type: "string" } },
    required: ["set_path"],
  },
};

export async function startEvalFrameworkServer(): Promise<void> {
  const settings = await loadSettings();
  const efSettings = settings.governance?.evalFramework;
  if (!efSettings || efSettings.enabled !== true) {
    console.error(
      "eval-framework: disabled — set settings.governance.evalFramework.enabled=true to serve.",
    );
    process.exit(1);
  }

  const plugin = new EvalFrameworkPlugin({ configOverride: efSettings });
  await plugin.start();

  const server = new Server(
    { name: "eval-framework", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: plugin.toolDescriptors().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: TOOL_INPUT_SCHEMAS[t.name] ?? { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await plugin.callTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("eval-framework MCP server ready (stdio)");
}

if (import.meta.main) {
  startEvalFrameworkServer().catch((err) => {
    console.error(`eval-framework server failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
