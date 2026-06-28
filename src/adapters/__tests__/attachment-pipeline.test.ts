/**
 * Unit tests for the generic inbound-attachment pipeline.
 *
 * Run: `bun test src/adapters/__tests__/attachment-pipeline.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachmentPipelineConfig,
  buildAttachmentManifest,
  formatBytes,
  type InboundAttachment,
  processAttachments,
  sanitizeFilename,
} from "../attachment-pipeline";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccaw-att-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cfg(over: Partial<AttachmentPipelineConfig> = {}): AttachmentPipelineConfig {
  return {
    enabled: true,
    maxBytes: 25 * 1024 * 1024,
    maxInlineTextBytes: 64 * 1024,
    rootDir: root,
    transcribeVoice: true,
    ...over,
  };
}

function att(over: Partial<InboundAttachment>): InboundAttachment {
  return {
    id: "a1",
    filename: "file.bin",
    url: "https://cdn/file.bin",
    contentType: "application/octet-stream",
    size: 10,
    kind: "file",
    ...over,
  };
}

/** Fetch stub: returns the bytes mapped by URL, or 404 for unknown. */
function fetchStub(map: Record<string, string>, calls?: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls?.push(url);
    const body = map[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(Buffer.from(body)), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("attachment-pipeline — processAttachments", () => {
  it("inlines text content and saves the file to disk", async () => {
    const a = att({
      filename: "cookies.json",
      url: "u/c.json",
      contentType: "application/json",
      kind: "text",
      size: 11,
    });
    const [p] = await processAttachments([a], cfg(), {
      fetchFn: fetchStub({ "u/c.json": "hello world" }),
    });
    expect(p.inlineText).toBe("hello world");
    expect(p.truncated).toBe(false);
    expect(p.savedPath).toBeTruthy();
    expect((await readFile(p.savedPath as string)).toString()).toBe("hello world");
  });

  it("saves images and references them by path", async () => {
    const a = att({
      filename: "shot.png",
      url: "u/s.png",
      contentType: "image/png",
      kind: "image",
      size: 4,
    });
    const [p] = await processAttachments([a], cfg(), { fetchFn: fetchStub({ "u/s.png": "PNG!" }) });
    expect(p.savedPath).toBeTruthy();
    expect(p.inlineText).toBeUndefined();
    expect(buildAttachmentManifest([p])).toContain("use the Read tool");
  });

  it("transcribes voice attachments via the injected transcriber", async () => {
    const a = att({
      filename: "note.ogg",
      url: "u/n.ogg",
      contentType: "audio/ogg",
      kind: "voice",
      size: 3,
    });
    const [p] = await processAttachments([a], cfg(), {
      fetchFn: fetchStub({ "u/n.ogg": "RAW" }),
      transcribe: async () => "spoken words here",
    });
    expect(p.transcript).toBe("spoken words here");
    expect(buildAttachmentManifest([p])).toContain('Transcript: "spoken words here"');
  });

  it("truncates inlined text beyond maxInlineTextBytes", async () => {
    const a = att({
      filename: "big.txt",
      url: "u/b.txt",
      contentType: "text/plain",
      kind: "text",
      size: 100,
    });
    const [p] = await processAttachments([a], cfg({ maxInlineTextBytes: 5 }), {
      fetchFn: fetchStub({ "u/b.txt": "0123456789" }),
    });
    expect(p.inlineText).toBe("01234");
    expect(p.truncated).toBe(true);
    expect(buildAttachmentManifest([p])).toContain("(truncated)");
  });

  it("skips oversize attachments WITHOUT downloading them", async () => {
    const calls: string[] = [];
    const a = att({ filename: "huge.zip", url: "u/h.zip", size: 99_999_999 });
    const [p] = await processAttachments([a], cfg({ maxBytes: 1000 }), {
      fetchFn: fetchStub({ "u/h.zip": "x" }, calls),
    });
    expect(p.note).toContain("exceeds max attachment size");
    expect(p.savedPath).toBeUndefined();
    expect(calls).toHaveLength(0); // never fetched
  });

  it("records download failures fail-soft and keeps processing the rest", async () => {
    const bad = att({ id: "a1", filename: "gone.bin", url: "u/missing", size: 5 });
    const good = att({
      id: "a2",
      filename: "ok.txt",
      url: "u/ok.txt",
      contentType: "text/plain",
      kind: "text",
      size: 2,
    });
    const out = await processAttachments([bad, good], cfg(), {
      fetchFn: fetchStub({ "u/ok.txt": "hi" }),
    });
    expect(out).toHaveLength(2);
    expect(out[0].note).toContain("download failed: HTTP 404");
    expect(out[0].savedPath).toBeUndefined();
    expect(out[1].inlineText).toBe("hi");
  });
});

describe("attachment-pipeline — buildAttachmentManifest", () => {
  it("returns '' when there are no attachments", () => {
    expect(buildAttachmentManifest([])).toBe("");
  });

  it("headers the count and lists each item", () => {
    const manifest = buildAttachmentManifest([
      { filename: "a.txt", kind: "text", size: 3, savedPath: "/x/a.txt", inlineText: "abc" },
      { filename: "b.png", kind: "image", size: 4, savedPath: "/x/b.png" },
    ]);
    expect(manifest).toContain("[Attachments: 2]");
    expect(manifest).toContain("a.txt");
    expect(manifest).toContain("abc");
    expect(manifest).toContain("b.png");
  });
});

describe("attachment-pipeline — helpers", () => {
  it("sanitizeFilename strips path separators and odd chars", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("my file (1).json")).toBe("my_file__1_.json");
  });

  it("formatBytes renders B/KB/MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
