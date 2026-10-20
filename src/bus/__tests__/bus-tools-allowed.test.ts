/**
 * The plus-bus tools the daemon pre-allows in the `--allowedTools` it hands
 * each bus agent's `claude` (#523).
 *
 * A bus tool missing from that flag is not pre-approved: each call goes
 * through the permission flow, which under the default / plan / acceptEdits
 * modes forwards it to the operator as a permission card. That is what
 * happened to the job and schedule tools.
 *
 * An agent without approvals (`bypassPermissions`, the default) gets every
 * served tool. An agent under approvals keeps the permission flow on the
 * tools that reach past its own conversation: `dispatch_job` and
 * `schedule_task` start work under the daemon-wide permission mode,
 * `delete_scheduled_task` can remove a task from the shared jobs directory,
 * and `job_status`, `list_jobs` and `cancel_job` reach every agent's jobs.
 *
 * The test asks the real server for its `tools/list`, builds the name claude
 * gives a plugin MCP tool from the plugin manifest and `.mcp.json`
 * (`mcp__plugin_<plugin>_<server>__<tool>`), and compares the bus entries of
 * the flag with the expected set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BusMcpServer, type IpcTransport } from "../mcp-server";
import { buildClaudeArgs, resolveClaudeclawPluginRoot } from "../session-manager";
import type { AgentConfig } from "../types";

type PermissionMode = AgentConfig["permission_mode"];

/** Served tools an agent under approvals still gets pre-allowed. */
const ALLOWED_UNDER_APPROVALS = [
  "reply",
  "edit_message",
  "ask",
  "cancel",
  "request_human",
  "list_scheduled_tasks",
];
const APPROVAL_MODES: PermissionMode[] = ["default", "plan", "acceptEdits", "dontAsk", "auto"];
const NO_APPROVAL_MODES: PermissionMode[] = [undefined, "bypassPermissions"];

function agent(permission_mode: PermissionMode): AgentConfig {
  return {
    id: "bus-tools",
    cwd: process.cwd(),
    session_id: "00000000-0000-0000-0000-000000000000",
    permission_mode,
    supervision: "pty-stdin",
  };
}

const ipc: IpcTransport = {
  send() {},
  onMessage() {},
  async close() {},
};

async function servedToolNames(): Promise<string[]> {
  const bus = new BusMcpServer({ agentId: "bus-tools", ipc });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([bus.mcp.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await bus.mcp.close();
  return tools.map((t) => t.name);
}

/** The name claude registers a tool of this plugin's bus server under. */
function claudeToolName(tool: string): string {
  const root = resolveClaudeclawPluginRoot();
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const servers = Object.keys(mcp.mcpServers);
  expect(servers).toEqual(["plus-bus"]);
  return `mcp__plugin_${plugin.name}_${servers[0]}__${tool}`;
}

/** The bus entries of `--allowedTools`, sorted. */
function busAllowed(args: string[]): string[] {
  const i = args.indexOf("--allowedTools");
  expect(i).toBeGreaterThanOrEqual(0);
  const prefix = claudeToolName("");
  return (args[i + 1] ?? "")
    .split(",")
    .filter((n) => n.startsWith(prefix))
    .sort();
}

/** Every `--allowedTools` value the daemon can build for this permission mode. */
function busAllowedVariants(mode: PermissionMode): string[][] {
  const out = [
    busAllowed(buildClaudeArgs(agent(mode), "pty-stdin")),
    busAllowed(buildClaudeArgs(agent(mode), "process-stream-json")),
  ];
  return out;
}

describe("plus-bus tools pre-allowed for bus agents (#523)", () => {
  it("the server serves the job and schedule tools", async () => {
    const served = await servedToolNames();
    for (const tool of [
      "dispatch_job",
      "job_status",
      "list_jobs",
      "cancel_job",
      "schedule_task",
      "list_scheduled_tasks",
      "delete_scheduled_task",
    ]) {
      expect(served).toContain(tool);
    }
  });

  it("an agent without approvals has every served tool pre-allowed, and nothing else", async () => {
    const expected = (await servedToolNames()).map(claudeToolName).sort();
    for (const mode of NO_APPROVAL_MODES) {
      for (const allowed of busAllowedVariants(mode)) {
        expect({ mode, allowed }).toEqual({ mode, allowed: expected });
      }
    }
  });

  it("an agent under approvals keeps the permission flow on the job tools, schedule_task and delete_scheduled_task", async () => {
    const served = await servedToolNames();
    const expected = served
      .filter((t) => ALLOWED_UNDER_APPROVALS.includes(t))
      .map(claudeToolName)
      .sort();
    expect(served.filter((t) => !ALLOWED_UNDER_APPROVALS.includes(t)).sort()).toEqual([
      "cancel_job",
      "delete_scheduled_task",
      "dispatch_job",
      "job_status",
      "list_jobs",
      "schedule_task",
    ]);
    for (const mode of APPROVAL_MODES) {
      for (const allowed of busAllowedVariants(mode)) {
        expect({ mode, allowed }).toEqual({ mode, allowed: expected });
      }
    }
  });
});
