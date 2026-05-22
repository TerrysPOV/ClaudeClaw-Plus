/**
 * Discord adapter — channel/thread/DM → agent_id routing.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5.1 + §6.1.
 *
 * The legacy `src/commands/discord.ts` derives the same mapping
 * implicitly through `guildTriggerReason` (line 527) + `knownThreads`
 * (line 188). The Bus adapter externalises it: routing is config, not
 * runtime state, so the test surface stays deterministic.
 *
 * Rules (mirroring legacy behaviour):
 *   1. DM (no `guild_id`) → `routing.dmAgentId` if set, else "global".
 *      Returning a default for DMs matches existing single-session
 *      behaviour where the bot always replies to allowed DM users.
 *   2. Direct channel hit → `routing.channels[channel_id]`.
 *   3. Thread → explicit mapping in `routing.threads[thread_id]`, or
 *      (if a parent channel hint is provided) the parent channel's
 *      agent_id, else `null`.
 *   4. Unknown channel → `null` → adapter silently skips.
 */

export interface RoutingConfig {
  channels: Record<string, string>;
  threads?: Record<string, string>;
  dmAgentId?: string;
  /**
   * Mirrors `DiscordBusRouting.primaryChannelByAgent`. Listed here so
   * `uniqueAgentIds` can include agents that appear only in this map.
   * Without that, an operator who sets a primary channel for an agent
   * without listing the agent in `channels`/`threads`/`dmAgentId` would
   * silently get no subscription (Codex P2 on PR #151).
   */
  primaryChannelByAgent?: Record<string, string>;
}

export interface RouteContext {
  /** DM messages have no `guild_id`. */
  isDM: boolean;
  channelId: string;
  /**
   * Optional parent channel id for threads. The adapter doesn't track
   * Discord's thread graph (that's a Sprint 4 helper — see TODO in
   * `index.ts`). Callers can pass `undefined` and the router will fall
   * back to thread allow-list lookup only.
   */
  parentChannelId?: string;
}

/**
 * Resolve a Discord channel/DM context to an `agent_id`. Returns `null`
 * if the channel is unrouted — the caller is expected to silently
 * skip, matching the legacy `guildTriggerReason() === null` path
 * (`src/commands/discord.ts:864`).
 */
export function resolveAgentId(routing: RoutingConfig, ctx: RouteContext): string | null {
  if (ctx.isDM) {
    return routing.dmAgentId ?? "global";
  }
  // Direct channel hit takes precedence — a thread accidentally listed
  // in `channels` should still resolve.
  const directHit = routing.channels[ctx.channelId];
  if (directHit) return directHit;

  // Explicit thread mapping.
  const threadHit = routing.threads?.[ctx.channelId];
  if (threadHit) return threadHit;

  // Inherit from parent channel if known.
  if (ctx.parentChannelId) {
    const parentHit = routing.channels[ctx.parentChannelId];
    if (parentHit) return parentHit;
  }

  return null;
}

/**
 * Distinct agent ids the adapter must subscribe to. Includes the DM
 * default if set — even if no DMs ever arrive, subscribing keeps the
 * outbound response path open for any future DM.
 */
export function uniqueAgentIds(routing: RoutingConfig): string[] {
  const set = new Set<string>();
  for (const a of Object.values(routing.channels)) set.add(a);
  if (routing.threads) {
    for (const a of Object.values(routing.threads)) set.add(a);
  }
  if (routing.dmAgentId) set.add(routing.dmAgentId);
  // Include agents that appear only in `primaryChannelByAgent`. The parser
  // accepts that config shape, so the subscription set must too — otherwise
  // outbound events for those agents would never reach the adapter.
  if (routing.primaryChannelByAgent) {
    for (const a of Object.keys(routing.primaryChannelByAgent)) set.add(a);
  }
  return Array.from(set);
}
