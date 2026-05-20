/**
 * Bus MCP — outbound tool definitions.
 *
 * Spec §5.1. Split out of `mcp-server.ts` to keep that file under the
 * 500 LOC budget (SPRINT_1_PLAN.md "Rules for agents").
 *
 * Each tool's runtime behaviour lives in `mcp-server.ts`; this file holds
 * only the static JSON-schema declarations the MCP client (claude) sees
 * when it calls `tools/list`.
 */

export const BUS_MCP_TOOLS = [
  {
    name: "reply",
    description:
      "Send a reply to the originating surface (Discord/Telegram/Slack/Web UI). " +
      "Use `intent: 'final'` for the turn-final message, `'progress'` for streaming " +
      "updates, `'tool_status'` for tool-execution notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            intent: { type: "string", enum: ["final", "progress", "tool_status"] },
          },
        },
      },
      required: ["message"],
    },
  },
  {
    name: "edit_message",
    description:
      "Edit the bot's most recent outbound message on this surface — for interim " +
      "progress updates (\"reading files...\", \"found 3 results...\"). Edits do NOT " +
      "push-notify the user, so finish a long task with `reply` intent:'final' to " +
      "ping their device. Falls back to a new message if nothing was sent yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "ask",
    description:
      "Ask the human a non-blocking clarifying question. Returns an `ask_id` " +
      "immediately; the answer arrives later as a notifications/claude/channel " +
      "event carrying the same id. The agent loop continues running while waiting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "cancel",
    description: "Gracefully cancel the current turn. Optional reason for the audit log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string" },
      },
    },
  },
  {
    name: "request_human",
    description:
      "Synchronous clarifying question — BLOCKS the agent loop until the human " +
      "answers. Use sparingly; prefer `ask` for non-blocking flows.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
] as const;
