/**
 * Bus runtime — slash-command relay wiring.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §6.3.
 *
 * Sprint 1 left two seams in place:
 *   - `BusCore.invokeSlashCommand(agent_id, cmd)` (core.ts) — public entry
 *     point for adapters/subscribers, delegating to a `SlashCommandHandler`.
 *   - `AgentProcess.send_slash(cmd)` (session-agent-process.ts) — per-
 *     supervision-mode implementations (`pty-stdin` writes `/<cmd>\n` to
 *     the bun-pty master; `process-stream-json` writes to stdin; `process`
 *     warns + no-ops; `tmux` is a known gap, see PR #110 review).
 *
 * Sprint 4 (Agent C) closes the loop: looking up the live `AgentProcess`
 * via `SessionManager.getAgent` and forwarding the command. This file
 * stays deliberately tiny — the supervision-mode behaviour all lives in
 * Sprint 1's AgentProcess classes, the slash-stripping is a one-liner,
 * and the unknown-agent error path is a single throw.
 */

import type { BusCore } from "./core";
import type { SessionManager } from "./session-manager";

/**
 * Wire `BusCore.invokeSlashCommand` → `SessionManager` agent lookup →
 * `AgentProcess.send_slash`. After this call any subscriber or adapter
 * can call `bus.invokeSlashCommand(agent_id, '/compact')` and the
 * Session Manager's `AgentProcess` for that agent receives
 * `send_slash('compact')`.
 *
 * Accepts both leading-slash and bare command names — `AgentProcess.send_slash`
 * expects the bare name (it re-prepends `/` per supervision mode).
 *
 * Throws (via the returned promise) when no `AgentProcess` is registered
 * for `agent_id`. Adapters wrap this into their own error-surfacing path
 * (e.g. Discord posts an ephemeral reply, the CLI prints to stderr).
 */
export function wireSlashCommands(bus: BusCore, sm: SessionManager): void {
  bus.setSlashCommandHandler(async (agent_id, cmd) => {
    const agentProcess = sm.getAgent(agent_id);
    if (!agentProcess) {
      throw new Error(
        `invokeSlashCommand: no active agent for id=${agent_id} ` +
          "(was spawnAgent called and not yet exited?)",
      );
    }
    // Accept either `/compact` (adapter-side convention) or `compact`
    // (AgentProcess-internal convention); the bare name is what
    // `send_slash` expects.
    const bareCmd = cmd.startsWith("/") ? cmd.slice(1) : cmd;
    await agentProcess.send_slash(bareCmd);
  });
}
