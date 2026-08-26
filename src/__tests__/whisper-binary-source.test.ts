import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARY_SOURCES, binaryIsRunnable, isWhisperSharedLib, sharedLibTargets } from "../whisper";

/**
 * Regression cover for the linux-arm64 whisper install being unrunnable.
 *
 * `linux-arm64` pointed at a Homebrew bottle. Homebrew rewrites the ELF
 * interpreter at install time; extracting the raw tarball does not, so the
 * binary kept a literal "@@HOMEBREW_PREFIX@@/lib/ld.so" interpreter and every
 * exec failed with a misleading ENOENT. Because warmup only checked that the
 * file *existed*, it never re-downloaded and voice transcription stayed broken
 * silently for months.
 */
describe("whisper BINARY_SOURCES", () => {
  test("no Linux platform is served a Homebrew bottle", () => {
    const linuxEntries = Object.entries(BINARY_SOURCES).filter(([k]) => k.startsWith("linux-"));
    expect(linuxEntries.length).toBeGreaterThan(0);

    for (const [platform, source] of linuxEntries) {
      // Homebrew bottles are relocatable-by-brew only; their ELF interpreter is
      // a placeholder that no plain tar extraction will fix.
      expect(`${platform}:${source.url}`).not.toContain("ghcr.io/v2/homebrew");
      expect(`${platform}:${source.url}`).not.toContain("homebrew");
    }
  });

  test("linux-arm64 uses upstream's official Linux arm64 build", () => {
    const source = BINARY_SOURCES["linux-arm64"];
    expect(source).toBeDefined();
    expect(source?.url).toContain("ggml-org/whisper.cpp/releases");
    expect(source?.url).toContain("ubuntu-arm64");
    // A pinned tag, not a floating "latest" that can change under us.
    expect(source?.url).not.toContain("/latest/");
  });

  test("every source is fully specified", () => {
    for (const [platform, source] of Object.entries(BINARY_SOURCES)) {
      expect(`${platform}: ${source.url}`).toStartWith(`${platform}: https://`);
      expect(["tar.gz", "zip"]).toContain(source.format);
    }
  });
});

describe("binaryIsRunnable", () => {
  test("false when the path does not exist", async () => {
    expect(await binaryIsRunnable(join(tmpdir(), "definitely-not-a-real-whisper-cli"))).toBe(false);
  });

  test("false for a file that exists but cannot exec", async () => {
    // Stands in for the real failure: a plausible file that dies at exec time.
    const dir = await mkdtemp(join(tmpdir(), "whisper-probe-"));
    const fake = join(dir, "whisper-cli");
    await writeFile(fake, "not an executable");
    await chmod(fake, 0o755);
    expect(await binaryIsRunnable(fake)).toBe(false);
  });

  test("true for a genuinely runnable binary", async () => {
    // process.execPath is guaranteed present and exits 0 on --help.
    expect(await binaryIsRunnable(process.execPath)).toBe(true);
  });
});

describe("runtime shared libraries", () => {
  test("matches libggml as well as libwhisper", () => {
    // The original filter matched only *whisper* and silently dropped these.
    expect(isWhisperSharedLib("libggml.so.0")).toBe(true);
    expect(isWhisperSharedLib("libggml-base.so.0.20.2")).toBe(true);
    expect(isWhisperSharedLib("libggml-cpu.so")).toBe(true);
    expect(isWhisperSharedLib("libwhisper.so.1")).toBe(true);
    expect(isWhisperSharedLib("libwhisper.dylib")).toBe(true);
  });

  test("ignores non-libraries and unrelated libraries", () => {
    expect(isWhisperSharedLib("whisper-cli")).toBe(false);
    expect(isWhisperSharedLib("LICENSE")).toBe(false);
    expect(isWhisperSharedLib("libparakeet.so.1")).toBe(false);
  });

  test("every library is written beside the binary, not only into lib/", () => {
    // Load-bearing: ggml dlopens its compute backend by searching next to the
    // executable. If this collapses back to lib/ only, the binary still loads
    // and --help still exits 0, but transcription fails with "backends = 0".
    const targets = sharedLibTargets("libggml-cpu.so");
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.endsWith(`/lib/libggml-cpu.so`))).toBe(true);
    expect(targets.some((t) => t.endsWith(`/bin/libggml-cpu.so`))).toBe(true);
  });
});
