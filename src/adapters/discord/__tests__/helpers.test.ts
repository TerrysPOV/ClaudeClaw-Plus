/**
 * Discord helpers — attachment classification.
 *
 * Run: `bun test src/adapters/discord/__tests__/helpers.test.ts`
 */

import { describe, expect, it } from "bun:test";
import { classifyAttachmentKind, isTextAttachment } from "../helpers";
import type { DiscordAttachment } from "../types";

function a(over: Partial<DiscordAttachment>): DiscordAttachment {
  return { id: "1", filename: "f", url: "https://x/f", size: 1, ...over };
}

describe("discord helpers — classifyAttachmentKind", () => {
  it("classifies images by content type", () => {
    expect(classifyAttachmentKind(a({ content_type: "image/png", filename: "p.png" }))).toBe(
      "image",
    );
  });

  it("classifies voice by audio content type or the voice flag", () => {
    expect(classifyAttachmentKind(a({ content_type: "audio/ogg", filename: "v.ogg" }))).toBe(
      "voice",
    );
    expect(classifyAttachmentKind(a({ filename: "v.bin", flags: 1 << 13 }))).toBe("voice");
  });

  it("classifies text by content type, +json/+xml suffix, and extension", () => {
    expect(classifyAttachmentKind(a({ content_type: "text/plain", filename: "a.txt" }))).toBe(
      "text",
    );
    expect(
      classifyAttachmentKind(a({ content_type: "application/json", filename: "a.json" })),
    ).toBe("text");
    expect(classifyAttachmentKind(a({ content_type: "application/ld+json", filename: "a" }))).toBe(
      "text",
    );
    expect(classifyAttachmentKind(a({ filename: "script.ts" }))).toBe("text");
    expect(classifyAttachmentKind(a({ filename: "data.csv" }))).toBe("text");
  });

  it("falls back to the generic 'file' bucket (previously dropped)", () => {
    expect(
      classifyAttachmentKind(a({ content_type: "application/pdf", filename: "doc.pdf" })),
    ).toBe("file");
    expect(classifyAttachmentKind(a({ content_type: "application/zip", filename: "x.zip" }))).toBe(
      "file",
    );
  });

  it("honours precedence image > voice > text > file", () => {
    // image content type wins even with a .txt name
    expect(classifyAttachmentKind(a({ content_type: "image/png", filename: "weird.txt" }))).toBe(
      "image",
    );
  });
});

describe("discord helpers — isTextAttachment", () => {
  it("matches text/*, json/xml, and known extensions", () => {
    expect(isTextAttachment(a({ content_type: "text/markdown", filename: "x" }))).toBe(true);
    expect(isTextAttachment(a({ content_type: "application/xml", filename: "x" }))).toBe(true);
    expect(isTextAttachment(a({ filename: "notes.md" }))).toBe(true);
    expect(isTextAttachment(a({ filename: "config.yaml" }))).toBe(true);
  });

  it("rejects binaries", () => {
    expect(isTextAttachment(a({ content_type: "application/pdf", filename: "x.pdf" }))).toBe(false);
    expect(isTextAttachment(a({ content_type: "image/png", filename: "x.png" }))).toBe(false);
  });
});
