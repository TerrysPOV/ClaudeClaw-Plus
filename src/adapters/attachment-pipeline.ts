/**
 * Generic inbound-attachment pipeline.
 *
 * Surfaces (Discord today; Telegram/Slack later) hand this module a list of
 * `InboundAttachment`s (a URL + classified `kind`). It downloads each one,
 * processes it by kind, and produces a plain-text MANIFEST that the adapter
 * appends to the prompt text. We inject into the prompt *text* — not the bus
 * metadata — because the PTY delivery path (`src/bus/core.ts`) stringifies
 * object metadata to `"[object Object]"`, so the inner `<channel>` text is the
 * only reliable way to get attachment content in front of the agent.
 *
 * Design notes:
 * - Dependency-injected (`fetchFn`, `transcribe`) so it unit-tests with no
 *   network and no real STT.
 * - Fail-soft: a bad/oversize/failed attachment is annotated in the manifest;
 *   it never throws away the user's message.
 * - Absolute on-disk paths: adapter and agent share a host, so absolute paths
 *   are readable by the PTY agent regardless of its own cwd. Only text-like
 *   content is inlined; binaries are saved and referenced by path.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AttachmentKind = "image" | "voice" | "text" | "file";

export interface InboundAttachment {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  size: number;
  kind: AttachmentKind;
}

export interface ProcessedAttachment {
  filename: string;
  kind: AttachmentKind;
  contentType?: string;
  size: number;
  /** Absolute path the bytes were written to (image/voice/file, and text too). */
  savedPath?: string;
  /** Inlined UTF-8 contents for text-like attachments (possibly truncated). */
  inlineText?: string;
  /** Whether `inlineText` was truncated at `maxInlineTextBytes`. */
  truncated?: boolean;
  /** Voice transcript, when transcription succeeded. */
  transcript?: string;
  /** Non-fatal reason this item was skipped or partially processed. */
  note?: string;
}

export interface AttachmentPipelineConfig {
  enabled: boolean;
  /** Skip download entirely when the declared size exceeds this. */
  maxBytes: number;
  /** Inlined text is truncated to this many bytes. */
  maxInlineTextBytes: number;
  /** Absolute directory to write downloaded files into. */
  rootDir: string;
  /** Transcribe voice/audio attachments when true. */
  transcribeVoice: boolean;
}

export interface AttachmentPipelineDeps {
  fetchFn?: typeof fetch;
  transcribe?: (inputPath: string) => Promise<string>;
  log?: (msg: string) => void;
}

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — Discord free upload cap
export const DEFAULT_MAX_INLINE_TEXT_BYTES = 64 * 1024; // 64 KB

const noopLog = (_msg: string): void => {};

/** Replace path separators and control/odd chars so the name is safe on disk. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "file";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Download + process every attachment. Never throws on a single bad item —
 * each failure becomes a `note` on its `ProcessedAttachment`.
 */
export async function processAttachments(
  attachments: InboundAttachment[],
  cfg: AttachmentPipelineConfig,
  deps: AttachmentPipelineDeps = {},
): Promise<ProcessedAttachment[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? noopLog;
  const out: ProcessedAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const base: ProcessedAttachment = {
      filename: att.filename,
      kind: att.kind,
      contentType: att.contentType,
      size: att.size,
    };

    if (att.size > cfg.maxBytes) {
      out.push({
        ...base,
        note: `skipped: exceeds max attachment size (${formatBytes(cfg.maxBytes)})`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      const res = await fetchFn(att.url);
      if (!res.ok) {
        out.push({ ...base, note: `download failed: HTTP ${res.status}` });
        continue;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      out.push({
        ...base,
        note: `download failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (bytes.length > cfg.maxBytes) {
      out.push({
        ...base,
        note: `skipped: downloaded size ${formatBytes(bytes.length)} exceeds limit`,
      });
      continue;
    }

    // Persist to disk so the agent can Read it (images, voice, binaries — and
    // text too, so the full file is available if the inline copy is truncated).
    let savedPath: string | undefined;
    try {
      await mkdir(cfg.rootDir, { recursive: true });
      savedPath = join(
        cfg.rootDir,
        `${String(i + 1).padStart(2, "0")}-${sanitizeFilename(att.filename)}`,
      );
      await writeFile(savedPath, bytes);
    } catch (err) {
      out.push({
        ...base,
        note: `save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (att.kind === "text") {
      const slice = bytes.subarray(0, cfg.maxInlineTextBytes);
      out.push({
        ...base,
        savedPath,
        inlineText: slice.toString("utf-8"),
        truncated: bytes.length > cfg.maxInlineTextBytes,
      });
      continue;
    }

    if (att.kind === "voice" && cfg.transcribeVoice && deps.transcribe) {
      try {
        const transcript = (await deps.transcribe(savedPath)).trim();
        out.push({
          ...base,
          savedPath,
          transcript: transcript || undefined,
          note: transcript ? undefined : "transcription returned empty",
        });
      } catch (err) {
        log(`attachment transcribe failed: ${err instanceof Error ? err.message : String(err)}`);
        out.push({ ...base, savedPath, note: "transcription unavailable" });
      }
      continue;
    }

    out.push({ ...base, savedPath });
  }

  return out;
}

/**
 * Render processed attachments as a manifest block to append to the prompt
 * text. Returns "" when there is nothing to show.
 */
export function buildAttachmentManifest(processed: ProcessedAttachment[]): string {
  if (processed.length === 0) return "";

  const lines: string[] = [`[Attachments: ${processed.length}]`];
  processed.forEach((p, i) => {
    const typePart = p.contentType ? `${p.contentType}, ` : "";
    lines.push("");
    lines.push(`${i + 1}. ${p.filename} — ${typePart}${formatBytes(p.size)}`);
    if (p.note && !p.savedPath) {
      lines.push(`   ${p.note}`);
      return;
    }
    if (p.savedPath && p.kind === "image") {
      lines.push(`   Saved: ${p.savedPath} — use the Read tool to view this image.`);
    } else if (p.savedPath) {
      lines.push(`   Saved: ${p.savedPath}`);
    }
    if (p.transcript) {
      lines.push(`   Transcript: "${p.transcript}"`);
    }
    if (p.note && p.savedPath) {
      lines.push(`   Note: ${p.note}`);
    }
    if (p.inlineText !== undefined) {
      lines.push(`   ----- begin ${p.filename} -----`);
      lines.push(p.inlineText);
      lines.push(`   ----- end ${p.filename}${p.truncated ? " (truncated)" : ""} -----`);
    }
  });
  return lines.join("\n");
}
