/**
 * Who may talk to the bot, one rule for every platform and both runtimes.
 *
 * An empty `allowedUserIds` used to mean "allow everyone". A fresh install
 * that set a bot token and skipped the optional list was therefore open to
 * any user of the platform, with the agent's full tool set behind it. The
 * list now fails closed: empty = nobody. An operator who really wants a
 * public bot says so with `allowAllUsers: true` on that platform.
 */

export type AllowlistPlatform = "telegram" | "discord" | "slack";

export function isUserAllowed<T>(
  allowed: ReadonlySet<T> | readonly T[],
  userId: T | undefined | null,
  allowAllUsers = false,
): boolean {
  if (allowAllUsers) return true;
  if (userId === undefined || userId === null) return false;
  return allowed instanceof Set ? allowed.has(userId) : (allowed as readonly T[]).includes(userId);
}

/**
 * The allow-list as a gate reads it. Bus adapters take a getter returning
 * this, so a settings reload applies to the next message without a restart
 * (#520) — the legacy runtime already reads `getSettings()` per event.
 */
export interface AllowlistState<T> {
  allowedUserIds: readonly T[];
  allowAllUsers?: boolean;
}

export function isAllowedBy<T>(state: AllowlistState<T>, userId: T | undefined | null): boolean {
  return isUserAllowed(state.allowedUserIds, userId, state.allowAllUsers === true);
}

/** One-line summary for startup banners and status commands. */
export function describeAllowlist(allowed: readonly unknown[], allowAllUsers = false): string {
  if (allowAllUsers) return "all (allowAllUsers: true)";
  if (allowed.length === 0) return "none — empty allowedUserIds refuses everyone";
  return allowed.join(", ");
}

/**
 * Startup warning for a platform whose list is empty, or null when there is
 * nothing to say. Spells out the migration because existing installs that
 * relied on "empty = everyone" go silent after upgrading.
 */
export function emptyAllowlistWarning(
  platform: AllowlistPlatform,
  allowed: readonly unknown[],
  allowAllUsers = false,
): string | null {
  if (allowAllUsers || allowed.length > 0) return null;
  return (
    `${platform}.allowedUserIds is empty, so every ${platform} user is REFUSED ` +
    `(an empty list used to allow everyone). Add the user IDs that may talk to the bot ` +
    `to ${platform}.allowedUserIds, or set ${platform}.allowAllUsers: true to accept anyone.`
  );
}

/**
 * Warnings for every platform that receives messages (has a token, and for
 * Telegram is not send-only) but whose allow-list would refuse everyone.
 */
export function allowlistStartupWarnings(settings: {
  telegram: {
    token: string;
    receiveEnabled?: boolean;
    allowedUserIds: readonly unknown[];
    allowAllUsers?: boolean;
  };
  discord: { token: string; allowedUserIds: readonly unknown[]; allowAllUsers?: boolean };
  slack: { botToken: string; allowedUserIds: readonly unknown[]; allowAllUsers?: boolean };
}): string[] {
  const out: string[] = [];
  const check = (
    platform: AllowlistPlatform,
    hasToken: boolean,
    cfg: { allowedUserIds: readonly unknown[]; allowAllUsers?: boolean },
  ) => {
    if (!hasToken) return;
    const w = emptyAllowlistWarning(platform, cfg.allowedUserIds, cfg.allowAllUsers);
    if (w) out.push(w);
  };
  check(
    "telegram",
    Boolean(settings.telegram.token) && settings.telegram.receiveEnabled !== false,
    settings.telegram,
  );
  check("discord", Boolean(settings.discord.token), settings.discord);
  check("slack", Boolean(settings.slack.botToken), settings.slack);
  return out;
}
