import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_SOURCES,
  assertSharedLibsStaged,
  binaryIsRunnable,
  collectSharedLibs,
  isWhisperSharedLib,
  reprobeUnsupportedLatch,
  sharedLibTargets,
  decideWarmupAction,
} from "../whisper";

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
    // Linux only, deliberately: the darwin entries are still Homebrew bottles.
    // Mach-O relocation differs from ELF and does not hit the interpreter bug,
    // and those URLs are content-addressed. Do not widen this to all platforms.
    const linuxEntries = Object.entries(BINARY_SOURCES).filter(([k]) => k.startsWith("linux-"));
    expect(linuxEntries.length).toBeGreaterThan(0);

    for (const [platform, source] of linuxEntries) {
      // Homebrew bottles are relocatable-by-brew only; their ELF interpreter is
      // a placeholder that no plain tar extraction will fix.
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

  test("every mutable URL carries a sha256 pin", () => {
    // A URL containing /blobs/sha256: is content-addressed — the registry can
    // only serve those bytes. Anything else (a GitHub release asset) is
    // name-addressed and re-uploadable, so it needs its digest pinned here.
    // These bytes get chmod 0755'd and executed with the daemon's environment.
    for (const [platform, source] of Object.entries(BINARY_SOURCES)) {
      const contentAddressed = source.url.includes("/blobs/sha256:");
      if (contentAddressed) continue;
      expect(`${platform}: ${source.sha256 ?? "MISSING"}`).toMatch(/^[a-z0-9-]+: [0-9a-f]{64}$/);
    }
  });

  test("every source has an https url and a known archive format", () => {
    for (const [platform, source] of Object.entries(BINARY_SOURCES)) {
      expect(`${platform}: ${source.url}`).toStartWith(`${platform}: https://`);
      // Asserted on source.format, not the literal, so a failure names the
      // offending platform rather than printing the allowed list.
      expect(`${platform}: ${source.format}`).toMatch(/^[a-z0-9-]+: (tar\.gz|zip)$/);
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

  test("matches Windows DLLs", () => {
    // The pinned win32-x64 zip ships these next to whisper-cli.exe; Windows loads
    // DLLs from the executable's directory, so they must be staged.
    expect(isWhisperSharedLib("ggml.dll")).toBe(true);
    expect(isWhisperSharedLib("ggml-base.dll")).toBe(true);
    expect(isWhisperSharedLib("ggml-cpu.dll")).toBe(true);
    expect(isWhisperSharedLib("whisper.dll")).toBe(true);
  });

  test("ignores non-libraries and unrelated libraries", () => {
    expect(isWhisperSharedLib("whisper-cli")).toBe(false);
    expect(isWhisperSharedLib("LICENSE")).toBe(false);
    expect(isWhisperSharedLib("libparakeet.so.1")).toBe(false);
    // Shipped in the same zip, but whisper-cli.exe does not need it.
    expect(isWhisperSharedLib("SDL2.dll")).toBe(false);
  });

  test("every library is written beside the binary, not only into lib/", () => {
    // Load-bearing: ggml dlopens its compute backend by searching next to the
    // executable. If this collapses back to lib/ only, the binary still loads
    // and --help still exits 0, but transcription fails, with whisper-cli reporting `backends   = 0`
    // at runtime (a printf format, so do not expect to grep it out of the binary).
    const targets = sharedLibTargets("libggml-cpu.so");
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.endsWith(`/lib/libggml-cpu.so`))).toBe(true);
    expect(targets.some((t) => t.endsWith(`/bin/libggml-cpu.so`))).toBe(true);
  });
});

describe("collectSharedLibs", () => {
  // Mirrors the pinned linux-arm64 tarball: whisper-cli is linked against
  // libggml.so.0 and libwhisper.so.1, which are symlinks to the versioned files.
  async function arm64Layout(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "whisper-libs-"));
    const root = join(dir, "whisper-bin-ubuntu-arm64");
    await mkdir(root);
    await writeFile(join(root, "libggml.so.0.20.2"), "ggml-bytes");
    await symlink("libggml.so.0.20.2", join(root, "libggml.so.0"));
    await symlink("libggml.so.0", join(root, "libggml.so"));
    await writeFile(join(root, "libwhisper.so.1.9.3"), "whisper-bytes");
    await symlink("libwhisper.so.1.9.3", join(root, "libwhisper.so.1"));
    await writeFile(join(root, "libggml-cpu.so"), "cpu-bytes");
    await writeFile(join(root, "libparakeet.so.1.9.3"), "unrelated");
    await writeFile(join(root, "whisper-cli"), "bin");
    return dir;
  }

  test("stages the SONAME symlinks the loader asks for, not only the versioned files", async () => {
    const libs = await collectSharedLibs(await arm64Layout());
    const names = libs.map((l) => l.name).sort();
    expect(names).toContain("libggml.so.0");
    expect(names).toContain("libwhisper.so.1");
    expect(names).toContain("libggml.so.0.20.2");
    expect(names).toContain("libwhisper.so.1.9.3");
    expect(names).toContain("libggml-cpu.so");
  });

  test("a staged symlink reads as its target's bytes", async () => {
    const libs = await collectSharedLibs(await arm64Layout());
    const soname = libs.find((l) => l.name === "libggml.so.0");
    expect(soname).toBeDefined();
    expect(await readFile(soname?.srcPath as string, "utf8")).toBe("ggml-bytes");
  });

  test("leaves out unrelated libraries and the binary", async () => {
    const names = (await collectSharedLibs(await arm64Layout())).map((l) => l.name);
    expect(names).not.toContain("libparakeet.so.1.9.3");
    expect(names).not.toContain("whisper-cli");
  });

  test("a dangling library symlink fails loudly instead of being skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whisper-libs-"));
    await symlink("libggml.so.0.20.2", join(dir, "libggml.so.0"));
    await expect(collectSharedLibs(dir)).rejects.toThrow();
  });
});

describe("unsupported-platform latch", () => {
  const LATCH = "whisper: downloaded binary is not runnable";

  test("stays unset when nothing was latched", async () => {
    expect(await reprobeUnsupportedLatch(null, join(tmpdir(), "no-such-whisper-cli"))).toBeNull();
  });

  test("releases once the binary on disk runs again", async () => {
    // A single failed probe can be transient (memory pressure, fd exhaustion).
    // process.execPath is present and exits 0 on --help.
    expect(await reprobeUnsupportedLatch(LATCH, process.execPath)).toBeNull();
  });

  test("holds while the binary still will not run", async () => {
    expect(await reprobeUnsupportedLatch(LATCH, join(tmpdir(), "no-such-whisper-cli"))).toBe(LATCH);
  });
});

describe("zero-library guard", () => {
  test("rejects a dynamically linked archive that yields no libraries", () => {
    const arm64 = BINARY_SOURCES["linux-arm64"];
    expect(() => assertSharedLibsStaged("linux-arm64", arm64, 0)).toThrow(/no shared libraries/);
  });

  test("accepts a dynamically linked archive that yields libraries", () => {
    const arm64 = BINARY_SOURCES["linux-arm64"];
    expect(() => assertSharedLibsStaged("linux-arm64", arm64, 3)).not.toThrow();
  });

  test("accepts the static linux-x64 archive, which ships no libraries", () => {
    // The pinned dscripka asset holds only main/server/quantize/bench.
    const x64 = BINARY_SOURCES["linux-x64"];
    expect(() => assertSharedLibsStaged("linux-x64", x64, 0)).not.toThrow();
  });

  test("only linux-x64 is exempt from the guard", () => {
    // Every other source is dynamically linked; exempting one by mistake would
    // let a broken archive install and then pass the --help probe.
    const exempt = Object.entries(BINARY_SOURCES)
      .filter(([, source]) => source.staticBinary)
      .map(([platform]) => platform);
    expect(exempt).toEqual(["linux-x64"]);
  });
});

describe("decideWarmupAction", () => {
  test("installs when nothing is there", async () => {
    expect(await decideWarmupAction(join(tmpdir(), "no-such-whisper-cli"))).toBe("install");
  });

  test("REPAIRS a binary that is present but will not run", async () => {
    // The regression that mattered. Warmup used to branch on existence alone,
    // so this state was classified "ok": the file was present, warmup reported
    // success, and every transcription failed. Deciding on runnability is the
    // fix — if this ever returns "ok" again, linux-arm64 silently breaks.
    const dir = await mkdtemp(join(tmpdir(), "whisper-warmup-"));
    const broken = join(dir, "whisper-cli");
    await writeFile(broken, "not an executable");
    await chmod(broken, 0o755);
    expect(await decideWarmupAction(broken)).toBe("repair");
  });

  test("leaves a working binary alone", async () => {
    expect(await decideWarmupAction(process.execPath)).toBe("ok");
  });
});
