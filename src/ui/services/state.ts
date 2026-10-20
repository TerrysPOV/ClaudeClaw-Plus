import { readFile } from "fs/promises";
import { peekSession } from "../../sessions";
import { SESSION_FILE, SETTINGS_FILE, STATE_FILE } from "../constants";
import type { WebSnapshot } from "../types";

/**
 * What the dashboard is told about `settings.web`. Allowlisted rather than
 * passed through: `web.bus.token` is a credential for the webui bus (it can
 * send prompts to the agent), and the dashboard only needs to know whether
 * one is set. A field added to the config later stays out until it is
 * listed here.
 */
function sanitizeWeb(web: WebSnapshot["settings"]["web"]) {
  return {
    enabled: web.enabled,
    host: web.host,
    port: web.port,
    ...(web.bus
      ? {
          bus: {
            bind: web.bus.bind,
            // Same resolution as the adapter: config first, then the env.
            tokenConfigured: Boolean(web.bus.token?.trim() || process.env.CCAW_WEBUI_TOKEN?.trim()),
            allowedAgentIds: web.bus.allowedAgentIds,
            allowedOrigins: web.bus.allowedOrigins,
          },
        }
      : {}),
  };
}

export function sanitizeSettings(snapshot: WebSnapshot["settings"]) {
  return {
    timezone: snapshot.timezone,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
    heartbeat: snapshot.heartbeat,
    security: snapshot.security,
    telegram: {
      configured: Boolean(snapshot.telegram.token),
      allowedUserCount: snapshot.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.discord.token),
      allowedUserCount: snapshot.discord.allowedUserIds.length,
    },
    web: sanitizeWeb(snapshot.web),
  };
}

export async function buildState(snapshot: WebSnapshot) {
  const now = Date.now();
  const session = await peekSession();
  return {
    daemon: {
      running: true,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: now - snapshot.startedAt,
    },
    heartbeat: {
      enabled: snapshot.settings.heartbeat.enabled,
      intervalMinutes: snapshot.settings.heartbeat.interval,
      nextAt: snapshot.heartbeatNextAt || null,
      nextInMs: snapshot.heartbeatNextAt ? Math.max(0, snapshot.heartbeatNextAt - now) : null,
    },
    jobs: snapshot.jobs.map((j) => ({
      name: j.name,
      schedule: j.schedule,
      prompt: j.prompt,
    })),
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.settings.discord.token),
      allowedUserCount: snapshot.settings.discord.allowedUserIds.length,
    },
    session: session
      ? {
          sessionIdShort: session.sessionId?.slice(0, 8) ?? "no-session",
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
    web: sanitizeWeb(snapshot.settings.web),
  };
}

/**
 * Field names whose values are secrets and must never leave the daemon
 * unredacted. Matched case-insensitively against every key at every
 * depth (issue #164 item 5, ported from upstream #185). The previous
 * implementation only redacted a hand-enumerated set of top-level +
 * one-level-nested fields, so a secret under a new/renamed key (or
 * deeper nesting) would leak through `/api/technical-info`.
 *
 * A key is a secret when it *ends* in a secret-shaped word (#510): an
 * exact-name list let `slack.signingSecret` through while `botToken` next
 * to it was redacted. Plurals count (`apiKeys`, `secrets`, but not
 * `tokens`: that is `maxTokens`), and so do `credentials`, `passphrase`
 * and an `Authorization` header. `api` is the one bare name kept (the
 * GLM key). Erring on the side of hiding a
 * non-secret (`cacheKey`) is the intended trade-off on a debug endpoint.
 *
 * #510: `bearer` counts too.
 */
const SECRET_KEY_SUFFIX =
  /(token|secrets?|keys?|passwords?|passwd|passphrase|credentials?|authorization|cookies?|bearer)$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_SUFFIX.test(key) || key.toLowerCase() === "api";
}

/**
 * #510: names that are secret in a value — a flag (`--auth`), a query
 * parameter (`?X-Amz-Signature=`), an env entry (`GH_PAT=`) — without
 * ending in one of the key-name words above.
 */
const SECRET_NAME_PART = /(^|[-_])(sig|signature|auth|pat|pwd|pass)$/i;

function isSecretName(name: string): boolean {
  return isSecretKey(name) || SECRET_NAME_PART.test(name);
}

/**
 * #510: keys whose string leaves are all secrets though the key itself is
 * not secret-shaped. `tokens` and `auth` by exact name only — `tokens` as a
 * suffix would catch `maxTokens` — and any key ending in `webhook(s)` or
 * `webhook_url`: a webhook URL is the credential itself. Numbers and
 * booleans under them pass through, so `webhooks: { port: 8080 }` stays
 * readable.
 */
const SECRET_CONTAINER_KEY = /^(tokens|auth)$|webhooks?([-_]?urls?)?$/i;

/** #510: incoming-webhook URLs (the path is the credential), anywhere in a string. */
const WEBHOOK_URL =
  /(?<![\w.:/-])(?:https?:\/\/)?(?:hooks\.slack\.com(?::\d+)?\/(?:services|workflows|triggers)\/|(?:[\w-]+\.)?discord(?:app)?\.com(?::\d+)?\/api\/(?:v\d+\/)?webhooks\/)[^\s"'<>]*/gi;

/**
 * #510: credentials recognisable by their own shape, wherever they sit: a
 * Telegram bot token (`bot<id>:<secret>`, also inside an API URL) and the
 * documented prefixes of Anthropic, OpenAI, GitHub, GitLab and Slack tokens.
 */
const KNOWN_TOKEN =
  /(?<!\d)\d{6,12}:AA[\w-]{30,}|\b(?:sk-ant-[\w-]{20,}|sk-(?:proj|svcacct|admin|None|or-v1)-[\w-]{20,}|sk-[A-Za-z0-9]{20,}(?![\w-])|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|glpat-[\w-]{20,}|xox[abeprs]-[\w-]{10,})/g;

/** Words a secret-shaped name ends in (superset; {@link isSecretName} decides). */
const SECRET_WORD =
  "token|secrets?|keys?|passwords?|passwd|passphrase|credentials?|authorization|cookies?|bearer|sig|signature|auth|pat|pwd|pass|api";

/** A value: a quoted string (single line) or one unquoted token. */
const VALUE = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)`;

/** The value was already replaced by an earlier pattern (quoted, or after a scheme word). */
const ALREADY_REDACTED = /^["']?(?:(?:bearer|basic|token|digest)\s+)?<redacted:/i;

/**
 * #510: userinfo in a URL. The scheme must start a token (lookbehind), which
 * keeps the scan linear on a long run of letters. The authority runs to the
 * first `/ ? #` or space, and the userinfo to its LAST `@` (greedy), so a raw `@` in
 * a password is covered; a raw `/` in a password is not (RFC 3986 requires
 * it percent-encoded, and the host could not be found otherwise).
 */
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)@/gi;

/** #510: `name=value` after `? & ; #` — query and fragment parameters. */
const URL_PARAM = /([?&;#])([^=&#;?\s]+)=([^&#;\s]+)/g;

/**
 * #510: `Name: value` with a secret-shaped name (`Authorization: Bearer x`,
 * `X-Api-Key: x`, `password: 'x'`, `{'token': 'x'}`). The value is one token
 * or one quoted string, never the rest of the line: a match that is declined
 * (a non-secret name, a value already redacted) must not hide the next pair
 * on the line. A quote inside an unquoted value is part of it unless it
 * closes a string (followed by `, } ]`, a space or the end). An unquoted value may not open a JSON object or array
 * (`"auth": {…}` is left to the key rules). The name must end in a secret
 * word, so `note:` or the `http` of a URL never matches at all.
 */
const HEADER_LINE = new RegExp(
  String.raw`(?<![\w-])((?:[A-Za-z][\w-]*?)?(?:${SECRET_WORD}))(["']?[ \t]*:[ \t]*)((?:(?:bearer|basic|token|digest)[ \t]+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'{[](?:[^\s"']|["'](?![,}\]\s]|$))*))`,
  "gi",
);

/** #510: a `"name": "value"` pair of JSON carried inside a string. */
const JSON_PAIR = /"([^"\\\r\n]{1,100})"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"/g;

/** #510: `Bearer x` / `Basic x` credentials, any case. */
const AUTH_SCHEME = /\b(bearer|basic)([ \t]+)([^\s"',;]{8,})/gi;

/**
 * #510: `NAME=value` and `--name=value` inside a string (an env entry, a
 * command line), starting at the beginning or after a space or quote.
 */
const ASSIGNMENT = new RegExp(
  String.raw`(^|[\s"'])(-{0,2})([A-Za-z_][\w.-]*)([ \t]*=[ \t]*)(${VALUE})`,
  "g",
);

/** #510: `--name value` inside a string; a value never starts with `-`. */
const FLAG_VALUE = new RegExp(
  String.raw`(^|[\s"'])(--?)([A-Za-z][\w-]*)([ \t]+)((?!-)${VALUE})`,
  "g",
);

/** #510: a command-line flag (`--token`, `--api-key`) whose next argument is a secret. */
const SECRET_FLAG = /^--?([A-Za-z][\w-]*)$/;

function redacted(value: string): string {
  return `<redacted:${value.length} chars>`;
}

/**
 * #510: scrub a secret carried *in* a string value, whatever its key:
 * incoming-webhook URLs, tokens with a known shape, userinfo in a URL, a secret-named `"name": "value"`
 * JSON pair, secret-named query or fragment parameters, `Bearer`/`Basic` credentials, `Name: value` header lines, and
 * `NAME=value` / `--flag value` / `--flag=value` with a secret-shaped name,
 * quoted or not. Best effort on free text: a secret split across lines, or
 * with nothing in its name or shape to say it is one, still goes out.
 * Only the secret part is replaced, so the rest of the value stays readable.
 * Every pattern here is linear in the string's length: settings, state and
 * job prompts are free text and go through it on every request.
 */
function scrubSecretValue(value: string): string {
  return value
    .replace(WEBHOOK_URL, (url) => redacted(url))
    .replace(KNOWN_TOKEN, (token) => redacted(token))
    .replace(URL_USERINFO, (m, scheme: string, userinfo: string) =>
      userinfo.length === 0 ? m : `${scheme}${redacted(userinfo)}@`,
    )
    .replace(JSON_PAIR, (m, name: string, v: string) =>
      isSecretName(name) ? `"${name}":"${redacted(v)}"` : m,
    )
    .replace(URL_PARAM, (m, sep: string, name: string, v: string) =>
      isSecretName(name) ? `${sep}${name}=${redacted(v)}` : m,
    )
    .replace(HEADER_LINE, (m, name: string, sep: string, v: string) =>
      isSecretName(name) && !ALREADY_REDACTED.test(v) ? `${name}${sep}${redacted(v)}` : m,
    )
    .replace(AUTH_SCHEME, (m, scheme: string, gap: string, v: string) =>
      ALREADY_REDACTED.test(v) ? m : `${scheme}${gap}${redacted(v)}`,
    )
    .replace(ASSIGNMENT, (m, lead: string, dashes: string, name: string, eq: string, v: string) =>
      isSecretName(name) && !ALREADY_REDACTED.test(v)
        ? `${lead}${dashes}${name}${eq}${redacted(v)}`
        : m,
    )
    .replace(FLAG_VALUE, (m, lead: string, dashes: string, name: string, gap: string, v: string) =>
      isSecretName(name) && !ALREADY_REDACTED.test(v)
        ? `${lead}${dashes}${name}${gap}${redacted(v)}`
        : m,
    );
}

/**
 * Recursively replace any field whose name matches {@link isSecretKey}
 * with `<redacted:N chars>` (N = original string length, or `0` for
 * empty/non-string), every string leaf under a {@link SECRET_CONTAINER_KEY},
 * and the argument after a secret-named flag in an array; every other
 * string goes through {@link scrubSecretValue}. Returns a deep copy —
 * never mutates the input. Other primitives pass through untouched.
 */
function redactSettings(raw: unknown, inSecretContainer = false): unknown {
  if (typeof raw === "string") return inSecretContainer ? redacted(raw) : scrubSecretValue(raw);
  if (Array.isArray(raw)) {
    return raw.map((item, i) => {
      const prev = i > 0 ? raw[i - 1] : undefined;
      const flag = typeof prev === "string" ? SECRET_FLAG.exec(prev) : null;
      const isValue = typeof item !== "string" || !item.startsWith("-");
      if (flag && isSecretName(flag[1]) && isValue && item !== null && typeof item !== "object") {
        return redacted(String(item));
      }
      return redactSettings(item, inSecretContainer);
    });
  }
  if (!raw || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // An env map written as an object (`env: { DB_PASS: … }`) is judged like
    // its `DB_PASS=…` string form. Objects keep the container rule below, so
    // an `auth: { … }` block stays readable.
    const scalar = value === null || typeof value !== "object";
    if (isSecretKey(key) || (scalar && SECRET_NAME_PART.test(key))) {
      const len = typeof value === "string" ? value.length : 0;
      out[key] = `<redacted:${len} chars>`;
    } else {
      out[key] = redactSettings(value, inSecretContainer || SECRET_CONTAINER_KEY.test(key));
    }
  }
  return out;
}

/** Where {@link buildTechnicalInfo} reads the daemon's files (tests point it elsewhere). */
export interface TechnicalInfoFiles {
  settings: string;
  session: string;
  state: string;
}

const DAEMON_FILES: TechnicalInfoFiles = {
  settings: SETTINGS_FILE,
  session: SESSION_FILE,
  state: STATE_FILE,
};

export async function buildTechnicalInfo(
  snapshot: WebSnapshot,
  paths: TechnicalInfoFiles = DAEMON_FILES,
) {
  const rawSettings = await readJsonFile(paths.settings);
  return {
    daemon: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
    files: {
      settingsJson: redactSettings(rawSettings),
      sessionJson: redactSettings(await readJsonFile(paths.session)),
      stateJson: redactSettings(await readJsonFile(paths.state)),
    },
    snapshot: {
      ...snapshot,
      settings: redactSettings(snapshot.settings) as WebSnapshot["settings"],
      // #510: job prompts are free text and can carry a webhook or a token.
      jobs: redactSettings(snapshot.jobs) as WebSnapshot["jobs"],
    },
  };
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
