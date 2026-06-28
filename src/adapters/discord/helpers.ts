/**
 * Discord adapter — stateless helpers.
 *
 * Pulled out of `index.ts` to keep that file under the per-file LOC cap
 * (SPRINT_3_PLAN.md). Every function here is pure or has well-isolated
 * state (the rate-limit factory). Tests import these directly when
 * useful and otherwise exercise them via the adapter.
 *
 * Each helper has a back-reference to the legacy `src/commands/discord.ts`
 * line range it mirrors, so Sprint 4 (shared `src/discord/` extraction)
 * can collapse the two paths into one helper.
 */

import type { PermissionRequest } from "../../bus/types";
import type { AttachmentKind } from "../attachment-pipeline";
import { PERMISSION_BUTTON_PREFIX, type DiscordAttachment } from "./types";

/* ────────────────────────────────────────────────────────────────────── */
/* Rate-limit — parity with src/commands/discord.ts:144–162               */
/* ────────────────────────────────────────────────────────────────────── */

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX = 30;

interface RateEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory per-user counter. Returns false when the user is over the
 * limit in the current window. The returned closure owns its own Map,
 * so multiple adapter instances don't share state.
 */
export function makeDefaultRateLimit(): (userId: string) => boolean {
  const map = new Map<string, RateEntry>();
  return (userId: string): boolean => {
    const now = Date.now();
    const entry = map.get(userId);
    if (!entry || now > entry.resetAt) {
      map.set(userId, { count: 1, resetAt: now + DEFAULT_RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (entry.count >= DEFAULT_RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Attachment classification — parity with src/commands/discord.ts:604    */
/* ────────────────────────────────────────────────────────────────────── */

const VOICE_MESSAGE_FLAG = 1 << 13;

export function isImageAttachment(a: DiscordAttachment): boolean {
  return Boolean(a.content_type?.startsWith("image/"));
}

export function isVoiceAttachment(a: DiscordAttachment): boolean {
  if ((a.flags ?? 0) & VOICE_MESSAGE_FLAG) return true;
  return Boolean(a.content_type?.startsWith("audio/"));
}

/** Text-like attachments whose contents are safe to inline into the prompt. */
const INLINE_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".sh",
  ".bash",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".sql",
  ".toml",
  ".ini",
  ".env",
  ".conf",
];

export function isTextAttachment(a: DiscordAttachment): boolean {
  const ct = a.content_type?.toLowerCase() ?? "";
  if (ct.startsWith("text/")) return true;
  if (
    ct === "application/json" ||
    ct === "application/xml" ||
    ct.includes("+json") ||
    ct.includes("+xml")
  ) {
    return true;
  }
  const lower = a.filename.toLowerCase();
  return INLINE_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Single source of truth for an attachment's processing kind. Precedence:
 * image > voice > text > file (generic binary). Mirrors the pipeline's
 * `AttachmentKind`.
 */
export function classifyAttachmentKind(a: DiscordAttachment): AttachmentKind {
  if (isImageAttachment(a)) return "image";
  if (isVoiceAttachment(a)) return "voice";
  if (isTextAttachment(a)) return "text";
  return "file";
}

export interface AttachmentSummary {
  images: DiscordAttachment[];
  voices: DiscordAttachment[];
  texts: DiscordAttachment[];
  /** Generic binaries (pdf/zip/etc.) — previously dropped on the floor. */
  files: DiscordAttachment[];
  hasAny: boolean;
}

/**
 * Build the attachment summary that rides on the BusEvent payload. `hasAny`
 * now reflects EVERY attachment kind (incl. generic files) — a `.json`/`.pdf`
 * upload used to leave `hasAny` false and get silently dropped (#268 follow-up).
 */
export function summariseAttachments(attachments: DiscordAttachment[]): AttachmentSummary {
  const byKind = (k: AttachmentKind): DiscordAttachment[] =>
    attachments.filter((a) => classifyAttachmentKind(a) === k);
  return {
    images: byKind("image"),
    voices: byKind("voice"),
    texts: byKind("text"),
    files: byKind("file"),
    hasAny: attachments.length > 0,
  };
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size: number;
}

export function attachmentMeta(a: DiscordAttachment): AttachmentMeta {
  return {
    id: a.id,
    filename: a.filename,
    url: a.url,
    content_type: a.content_type,
    size: a.size,
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Permission-prompt formatting                                           */
/* ────────────────────────────────────────────────────────────────────── */

export function formatPermissionPrompt(req: PermissionRequest): string {
  return [
    `**Permission requested:** \`${req.tool_name}\``,
    req.description ? req.description : null,
    req.input_preview ? `\`\`\`\n${req.input_preview}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Discord component shape: type 1 = ACTION_ROW, type 2 = BUTTON,
 * style 3 = SUCCESS (green), 4 = DANGER (red). Returns `unknown[]` so
 * `index.ts` doesn't have to depend on a Discord SDK type.
 *
 * Note: permission buttons are NEW in the Bus runtime — the legacy
 * `src/commands/discord.ts` doesn't have an equivalent ACTION_ROW
 * builder (its permission flow is in-band TUI rendering). PR #113
 * review (agent #5) caught an earlier comment claiming legacy parity
 * here; correcting to acknowledge this is greenfield.
 */
export function buildPermissionButtons(requestId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Allow",
          custom_id: `${PERMISSION_BUTTON_PREFIX}allow_${requestId}`,
        },
        {
          type: 2,
          style: 4,
          label: "Deny",
          custom_id: `${PERMISSION_BUTTON_PREFIX}deny_${requestId}`,
        },
      ],
    },
  ];
}

/**
 * Parse a `ccaw_perm_<allow|deny>_<request_id>` button custom_id.
 * Returns null if the id is malformed or carries an unknown behavior.
 */
export function parsePermissionCustomId(
  customId: string,
): { behavior: "allow" | "deny"; request_id: string } | null {
  if (!customId.startsWith(PERMISSION_BUTTON_PREFIX)) return null;
  const rest = customId.slice(PERMISSION_BUTTON_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep < 0) return null;
  const decision = rest.slice(0, sep);
  const requestId = rest.slice(sep + 1);
  if (decision !== "allow" && decision !== "deny") return null;
  if (!requestId) return null;
  return { behavior: decision, request_id: requestId };
}
