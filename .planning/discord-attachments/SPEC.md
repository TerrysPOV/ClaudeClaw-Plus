# SPEC — Discord inbound attachment pipeline (full media)

## 1. Problem statement

Files, images, and voice notes sent to the bot in Discord never reach the agent.
Under `runtime: bus`, the Discord adapter (`src/adapters/discord/index.ts`)
detects attachments and pins their URLs to `metadata.attachments`, but:

- It never downloads or processes the content (a `// Sprint 3 does NOT download`
  TODO that was never followed up).
- The bus PTY-delivery path (`src/bus/core.ts:565-570`) stringifies each metadata
  value with `String(v)`, so the nested `attachments` object becomes the literal
  `"[object Object]"` in the `<channel …>` prompt block. Even the URLs are lost.
- `summariseAttachments` only buckets `image/*`, `audio/*`, and `text/*`+`.txt/.md`.
  A `.json`/`.pdf`/`.csv` upload is dropped entirely (`hasAny` stays false).

Net: a user who attaches a JSON file (e.g. cookies) plus text gets only the text
forwarded; the file is invisible to the agent. Confirmed in production 2026-06-28.

## 2. Current behaviour (as-is)

- `src/adapters/discord/index.ts:254` — `summariseAttachments(message.attachments)`
  → `{ images, voices, texts, hasAny }`; other types silently excluded.
- `:281-300` — `bus.sendPrompt({ text: message.content, metadata: { attachments: {images,voices,texts}.map(attachmentMeta) } })`.
- `src/bus/core.ts:566-567` — `attrs.push(`${k}="${escapeXmlAttr(String(v))}"`)` →
  `attachments="[object Object]"`.
- `src/adapters/discord/helpers.ts:55-92` — classification predicates + `summariseAttachments`.
- `src/whisper.ts:378` — `transcribeAudioToText(inputPath, opts)` already exists
  (remote STT via `settings.stt.baseUrl`, else local whisper.cpp). No adapter uses it.

## 3. Target behaviour (to-be)

A new generic pipeline downloads each attachment, processes by kind, and the
Discord adapter appends a plain-text **manifest** to the prompt `text` (reliable —
it rides the `<channel>` inner text, not the mangled attribute path):

- **text/json/csv/log/yaml/xml/source** → download, inline contents (truncated to a
  cap) directly into the manifest, and also save to disk.
- **image/\*** → download, save to disk; manifest gives the absolute path with a
  "use the Read tool to view this image" hint.
- **audio/\* or voice flag** → download, save, transcribe via `transcribeAudioToText`;
  manifest carries the transcript (or a graceful "transcription unavailable" note).
- **anything else (pdf/zip/etc.)** → download, save; manifest gives path + type.

Files are written under an absolute root (`settings.attachments.rootDir`,
default `<cwd>/.claudeclaw/inbound-attachments/<agentId>/<messageId>/`) so the
PTY agent (same host) can `Read` them regardless of its own cwd.

Failures (download error, oversize, transcription error) never drop the message —
they are recorded as a per-item note in the manifest. Oversize items (> `maxBytes`)
are skipped with a note and not downloaded.

Also fix `src/bus/core.ts` to `JSON.stringify` object/array metadata values instead
of `String(v)` (eliminates `[object Object]`; benefits every adapter).

## 4. Architecture decisions (frozen)

- **Inject into prompt text, not metadata.** The PTY contract delivers the
  `<channel>` inner text to the agent verbatim; a text manifest is the only
  reliable channel. Metadata attributes stay for provenance only.
- **Generic, dependency-injected pipeline module** (`src/adapters/attachment-pipeline.ts`):
  pure of Discord specifics, takes `fetchFn` + `transcribe` deps → fully unit-testable
  without network or a real STT. Telegram can reuse it later (its `metadata.ts` has
  the same gap) — out of scope for this PR.
- **Absolute on-disk paths.** Adapter and agent share a host; absolute paths sidestep
  any per-agent cwd mismatch. Inline only text-like content; never base64 blobs into
  the prompt.
- **Reuse `transcribeAudioToText`** for voice — no new STT dependency.
- **Fail soft.** A bad attachment annotates the manifest; the user's message still
  goes through.

## 5. Key file references

- New: `src/adapters/attachment-pipeline.ts` (+ `__tests__/attachment-pipeline.test.ts`).
- Modify: `src/adapters/discord/helpers.ts` — broaden `isTextAttachment`; add a
  `files` bucket + `classifyAttachmentKind`; keep `hasAny` covering all kinds.
- Modify: `src/adapters/discord/index.ts:254-300` — run the pipeline, append manifest
  to `text`, keep lightweight metadata (counts only).
- Modify: `src/bus/core.ts:566-567` — JSON-stringify non-string metadata values.
- Modify: `src/config.ts` — `interface AttachmentsConfig` + `parseAttachmentsConfig` +
  `DEFAULT_SETTINGS.attachments`, wired into `parseSettings`.
- Reuse: `src/whisper.ts:378` `transcribeAudioToText`.

## 6. Out of scope (deferred)

Telegram/Slack wiring (same gap, follow-up); slash-command file uploads; outbound
attachment rendering; OCR of images; PDF text extraction; per-agent ACLs on
attachment size. Voice transcription quality depends on the operator's existing
`settings.stt` / whisper.cpp setup — unchanged here.
