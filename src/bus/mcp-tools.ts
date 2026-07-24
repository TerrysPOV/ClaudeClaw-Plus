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
      'progress updates ("reading files...", "found 3 results..."). Edits do NOT ' +
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
  {
    name: "dispatch_job",
    description:
      "Dispatch a background job to another agent (e.g. run `reg`/`suzy` on a long " +
      "research/draft task). Fire-and-return: returns a `job_id` IMMEDIATELY and the " +
      "job runs headless in its own process — never blocks your turn. The result is " +
      "delivered back to you when it finishes, and is queryable via `job_status`. Use " +
      "this instead of shelling out to `claude -p` yourself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Name of the agent to run the job." },
        prompt: { type: "string", description: "The task for that agent." },
        model: { type: "string", description: "Optional model override." },
        timeoutMs: { type: "number", description: "Optional per-job wall-clock (capped)." },
      },
      required: ["agent", "prompt"],
    },
  },
  {
    name: "job_status",
    description: "Get the status + result of a dispatched job by its `job_id`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "list_jobs",
    description: "List all agent jobs and their statuses (queued/running/done/failed/…).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a queued or running job by its `job_id` (kills the process).",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "schedule_task",
    description:
      "Schedule a task to run later, on a cron schedule. Use this for ANY " +
      "time-based request — a one-off reminder ('remind me at 8am tomorrow'), " +
      "an ad-hoc future task, or a recurring job. This is the ONLY correct way " +
      "to schedule: do NOT use native `CronCreate`/`ScheduleWakeup` tools even " +
      "if they appear available — those are tied to this live session and " +
      "silently fail to fire once the session rotates (they will NOT survive " +
      "until tomorrow morning). Tasks scheduled here are durable across " +
      "restarts and session boundaries.\n\n" +
      "The `prompt` runs LATER in a fresh session with no memory of this " +
      "conversation, so it must be self-contained — say what to do AND where " +
      'to deliver it, e.g. "Send a Discord reminder to the user in channel ' +
      '<id>: 📞 Call the GP for Ginna."\n\n' +
      "`cron` is a standard 5-field expression (minute hour day-of-month month " +
      "day-of-week) interpreted in the daemon's local timezone. Finest " +
      "granularity is one minute, and there is up to ~30s of pickup latency, " +
      "so this can't do sub-minute timing. Set `recurring: true` for a " +
      "repeating job; it defaults to false (fires once, then disables itself).",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: {
          type: "string",
          description: "Short kebab-case name (becomes the job filename), e.g. `reminder-call-gp`.",
        },
        cron: {
          type: "string",
          description: "5-field cron expression, e.g. `0 8 24 7 *` for 08:00 on 24 July.",
        },
        prompt: {
          type: "string",
          description:
            "Self-contained instruction to run when it fires, including the delivery target.",
        },
        recurring: {
          type: "boolean",
          description:
            "Repeat on every match (true) vs fire once then self-disable (false, default).",
        },
        model: {
          type: "string",
          description: "Optional model override (opus/sonnet/haiku/glm).",
        },
      },
      required: ["label", "cron", "prompt"],
    },
  },
  {
    name: "list_scheduled_tasks",
    description:
      "List your durable scheduled tasks (label, cron, recurring). Distinct " +
      "from `list_jobs`, which lists in-flight background dispatches.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "delete_scheduled_task",
    description:
      "Delete one durable scheduled task by its `label` (e.g. to cancel a " +
      "reminder). Use `list_scheduled_tasks` to see labels.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string" },
      },
      required: ["label"],
    },
  },
] as const;
