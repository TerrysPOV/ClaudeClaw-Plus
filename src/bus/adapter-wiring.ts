/**
 * Bus runtime adapter wiring (Sprint 5.2b).
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.5 + §10
 * Sprint 5.2.
 *
 * Responsibility: given a parsed `Settings` object + a live `BusCore`,
 * instantiate every external adapter (Discord / Telegram / Slack /
 * Web UI) whose token AND routing config are both present. Adapters
 * with missing config are silently skipped — operators opt in to
 * specific surfaces by populating both halves. Exception (#197):
 * Telegram mounts on a token alone when a default agent exists — its
 * `busRouting` is derived (`{ chats: {}, defaultAgentId }`) so a fresh
 * install (token but no routing block) isn't left silent. Discord/Slack
 * are channel-routed and keep the both-halves requirement.
 *
 * What this module is NOT:
 *   - Not responsible for `BusCore` / `SessionManager` lifecycle (that's
 *     `runtime-mount.ts`).
 *   - Not responsible for `BusScheduler` (Sprint 5.2c).
 *   - Not responsible for legacy adapter teardown when flipping runtimes
 *     (that's `start.ts`).
 *
 * Failure semantics: instantiation failures of one adapter do NOT block
 * the others. Each adapter's construction is wrapped — failures log a
 * warning and that adapter is omitted from the returned set. This
 * matches the operator-friendly "fall back gracefully" pattern the rest
 * of the daemon uses. The caller can still inspect `errors` to surface
 * them in the startup banner.
 */

import type { BusCore } from "./core";
import type { Settings, DiscordConfig, TelegramConfig, SlackConfig, WebConfig } from "../config";

/**
 * Each adapter exposes a similar surface: a constructor with options,
 * an async `start()` and `stop()`. We treat them all uniformly via this
 * adapter — the concrete classes are imported dynamically inside
 * `wireBusAdapters` so this module stays lightweight + the existing
 * adapter unit tests can keep mocking their own deps.
 */
export interface MountedAdapter {
  /** Stable name for logging / banner. */
  name: "discord" | "telegram" | "slack" | "webui";
  /** Tear down. Idempotent. */
  stop(): Promise<void>;
}

export interface WireBusAdaptersResult {
  /** Adapters that mounted successfully, in construction order. */
  adapters: MountedAdapter[];
  /** Per-adapter errors, keyed by adapter name. Logged at info level. */
  errors: Partial<Record<MountedAdapter["name"], string>>;
}

export interface WireBusAdaptersOptions {
  /** The live BusCore — adapters subscribe and publish through this. */
  bus: BusCore;
  /**
   * Parsed settings. Adapters mount when their token + routing config are both
   * present — except Telegram, which mounts on a token alone when
   * `defaultAgentId` is set (busRouting derived; see #197 and the field below).
   */
  settings: Pick<Settings, "discord" | "telegram" | "slack" | "web">;
  /**
   * The bus's default agent id (first spawned agent). When set, the Telegram
   * adapter can mount on a token alone — `telegram.busRouting` absent derives
   * `{ chats: {}, defaultAgentId }` so a fresh install (token but no routing
   * block) still routes inbound to the default agent (#197). Discord/Slack are
   * channel-routed and unaffected. Omit (or no agent) ⇒ token-only Telegram
   * still skips, since there is nothing to route to.
   */
  defaultAgentId?: string;
  /** Logger override. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
}

/**
 * Mount every adapter whose configuration is complete. Returns the
 * MountedAdapters in construction order plus any per-adapter errors.
 * Caller MUST call `stopBusAdapters(result.adapters)` on shutdown.
 */
export async function wireBusAdapters(
  opts: WireBusAdaptersOptions,
): Promise<WireBusAdaptersResult> {
  const logger = opts.logger ?? console;
  const adapters: MountedAdapter[] = [];
  const errors: WireBusAdaptersResult["errors"] = {};

  const tryMount = async (
    name: MountedAdapter["name"],
    fn: () => Promise<MountedAdapter | null>,
  ): Promise<void> => {
    try {
      const mounted = await fn();
      if (mounted) {
        adapters.push(mounted);
        logger.info(`[bus-adapters] mounted ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors[name] = msg;
      logger.warn(`[bus-adapters] failed to mount ${name}: ${msg}`);
    }
  };

  await tryMount("discord", () => mountDiscord(opts.bus, opts.settings.discord, logger));
  await tryMount("telegram", () =>
    mountTelegram(opts.bus, opts.settings.telegram, logger, opts.defaultAgentId),
  );
  await tryMount("slack", () => mountSlack(opts.bus, opts.settings.slack, logger));
  await tryMount("webui", () => mountWebUi(opts.bus, opts.settings.web, logger));

  return { adapters, errors };
}

/**
 * The adapter names `wireBusAdapters` WOULD mount for these settings —
 * computed from the same token/busRouting predicates the per-adapter mount
 * functions use, without constructing or starting anything. Single source
 * of truth for "which bus adapters are configured", so startup logs that
 * run BEFORE the (now deferred, issue #165) wiring can report intent
 * accurately. Order matches `wireBusAdapters`.
 */
export function configuredBusAdapterNames(
  settings: WireBusAdaptersOptions["settings"],
  defaultAgentId?: string,
): MountedAdapter["name"][] {
  const names: MountedAdapter["name"][] = [];
  if (settings.discord?.token && settings.discord?.busRouting) names.push("discord");
  // Telegram mounts on a token alone when a default agent exists: an absent
  // busRouting derives `{ chats: {}, defaultAgentId }` in mountTelegram (#197).
  // The token-only derive is skipped for send-only configs (receiveEnabled:
  // false) — see mountTelegram — so the banner must not claim telegram there.
  const tgDerives = !!defaultAgentId && settings.telegram?.receiveEnabled !== false;
  if (settings.telegram?.token && (settings.telegram?.busRouting || tgDerives))
    names.push("telegram");
  if (settings.slack?.botToken && settings.slack?.busRouting) names.push("slack");
  if (settings.web?.bus) names.push("webui");
  return names;
}

/**
 * Stop every adapter in reverse-construction order. Errors from one
 * adapter's stop() are logged and the loop continues so a single
 * misbehaving adapter can't block daemon shutdown.
 */
export async function stopBusAdapters(
  adapters: readonly MountedAdapter[],
  logger: Pick<Console, "warn" | "info" | "error"> = console,
): Promise<void> {
  for (let i = adapters.length - 1; i >= 0; i--) {
    const a = adapters[i];
    try {
      await a.stop();
    } catch (err) {
      logger.error(`[bus-adapters] ${a.name}.stop() failed`, err);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Per-adapter mount functions                                             */
/* ────────────────────────────────────────────────────────────────────── */

async function mountDiscord(
  bus: BusCore,
  cfg: DiscordConfig,
  logger: Pick<Console, "warn" | "info" | "error">,
): Promise<MountedAdapter | null> {
  if (!cfg.token || !cfg.busRouting) return null;
  const { DiscordAdapter } = await import("../adapters/discord");
  const adapter = new DiscordAdapter({
    bus,
    token: cfg.token,
    allowedUserIds: cfg.allowedUserIds,
    routing: cfg.busRouting,
    logger,
  });
  await adapter.start();
  return {
    name: "discord",
    async stop() {
      await adapter.stop();
    },
  };
}

async function mountTelegram(
  bus: BusCore,
  cfg: TelegramConfig,
  logger: Pick<Console, "warn" | "info" | "error">,
  defaultAgentId?: string,
): Promise<MountedAdapter | null> {
  if (!cfg.token) return null;
  // #197: a fresh install sets `telegram.token` but never writes `busRouting`,
  // which previously left the adapter unmounted ("no adapters") and the bot
  // silent. When busRouting is absent, derive `{ chats: {}, defaultAgentId }`:
  // an empty chats map routes every inbound chat to the default agent via
  // TelegramAdapter.resolveAgent's fall-through. Explicit busRouting wins. With
  // no default agent to route to, still skip — nothing would consume.
  let routing = cfg.busRouting;
  if (!routing) {
    if (!defaultAgentId) return null;
    // Respect send-only configs (Codex P2 on #197). A token-only mount has an
    // empty chats map and no inbound to populate a target chat, so with
    // receiveEnabled:false there is nothing to route outbound to either — skip
    // entirely rather than mount a no-op. (Explicit busRouting honors
    // receiveEnabled at the adapter level — see #201, below.)
    if (cfg.receiveEnabled === false) {
      logger.info(
        "[bus-adapters] telegram: token set but receiveEnabled=false and no busRouting — not mounting (send-only).",
      );
      return null;
    }
    routing = { chats: {}, defaultAgentId };
    // Surface the derive. When allowedUserIds is empty the adapter accepts
    // inbound from ANY Telegram user (empty allow-list = allow-all, a
    // pre-existing policy — see adapters/telegram allow-list gate), so a
    // token-only mount is open by default; warn so the operator can lock it down.
    if (cfg.allowedUserIds.length === 0) {
      logger.warn(
        `[bus-adapters] telegram: no busRouting configured — routing all inbound chats to default agent "${defaultAgentId}". telegram.allowedUserIds is empty, so ANY Telegram user can reach it; set telegram.allowedUserIds to restrict access.`,
      );
    } else {
      logger.info(
        `[bus-adapters] telegram: no busRouting configured; routing all inbound chats to default agent "${defaultAgentId}"`,
      );
    }
  }
  const { TelegramAdapter } = await import("../adapters/telegram");
  const adapter = new TelegramAdapter({
    bus,
    token: cfg.token,
    allowedUserIds: cfg.allowedUserIds,
    routing,
    // #201: honor send-only configs even with explicit busRouting — the
    // adapter wires outbound but skips the inbound long-poll. Default true.
    receiveEnabled: cfg.receiveEnabled,
    logger,
  });
  await adapter.start();
  return {
    name: "telegram",
    async stop() {
      await adapter.stop();
    },
  };
}

async function mountSlack(
  bus: BusCore,
  cfg: SlackConfig,
  logger: Pick<Console, "warn" | "info" | "error">,
): Promise<MountedAdapter | null> {
  if (!cfg.botToken || !cfg.busRouting) return null;
  // Signing secret resolution: explicit override on busRouting wins, else
  // the top-level slack.signingSecret (which itself can come from env via
  // parseSettings).
  const signingSecret = cfg.busRouting.signingSecret ?? cfg.signingSecret;
  if (!signingSecret) {
    throw new Error(
      "Slack Bus adapter needs a signing secret (set slack.signingSecret or slack.busRouting.signingSecret)",
    );
  }
  const { SlackAdapter } = await import("../adapters/slack");
  const adapter = new SlackAdapter({
    bus,
    token: cfg.botToken,
    signingSecret,
    allowedUserIds: cfg.allowedUserIds,
    routing: {
      channels: cfg.busRouting.channels,
      ...(cfg.busRouting.threadAgentId ? { threadAgentId: cfg.busRouting.threadAgentId } : {}),
      ...(cfg.busRouting.primaryChannelByAgent
        ? { primaryChannelByAgent: cfg.busRouting.primaryChannelByAgent }
        : {}),
    },
    ...(cfg.appToken ? { appToken: cfg.appToken } : {}),
    logger,
  });
  await adapter.start();
  return {
    name: "slack",
    async stop() {
      await adapter.stop();
    },
  };
}

async function mountWebUi(
  bus: BusCore,
  cfg: WebConfig,
  logger: Pick<Console, "warn" | "info" | "error">,
): Promise<MountedAdapter | null> {
  // Web UI mounts when `web.bus` is present — `enabled` only controls the
  // legacy dashboard. Operators can run the Bus WebUI without the legacy
  // one (and vice versa) by setting `web.enabled: false` + `web.bus: {…}`.
  if (!cfg.bus) return null;
  const { WebUiAdapter } = await import("../adapters/webui");
  const adapter = new WebUiAdapter({
    bus,
    ...(cfg.bus.bind ? { bind: cfg.bus.bind } : {}),
    ...(cfg.bus.token ? { token: cfg.bus.token } : {}),
    ...(cfg.bus.allowedAgentIds ? { allowedAgentIds: cfg.bus.allowedAgentIds } : {}),
    logger,
  });
  await adapter.start();
  return {
    name: "webui",
    async stop() {
      await adapter.stop();
    },
  };
}
