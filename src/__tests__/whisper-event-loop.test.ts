/**
 * Voice transcription must not block the Bun event loop (#279), and two
 * transcriptions must never run whisper at the same time.
 *
 * whisper.ts freezes its asset root from process.cwd() at import, so each case
 * runs the real transcribeAudioToText in a child process (fixtures/whisper-harness.ts)
 * whose cwd holds a stub `whisper-cli` that sleeps and logs start/end.
 *
 * Run: `bun test src/__tests__/whisper-event-loop.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const HARNESS = join(import.meta.dir, "fixtures", "whisper-harness.ts");
const STUB_SLEEP_S = 1;

let cwd: string;
let logPath: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccaw-whisper-"));
  logPath = join(cwd, "stub.log");
  const root = join(cwd, ".claude", "claudeclaw");
  const whisper = join(root, "whisper");
  await mkdir(join(whisper, "bin"), { recursive: true });
  await mkdir(join(whisper, "models"), { recursive: true });
  await writeFile(join(root, "settings.json"), "{}");
  await writeFile(join(whisper, "models", "ggml-base.en.bin"), "model");
  const stub = join(whisper, "bin", "whisper-cli");
  await writeFile(
    stub,
    `#!/bin/sh\necho start >> "$STUB_LOG"\nsleep ${STUB_SLEEP_S}\necho end >> "$STUB_LOG"\necho " hello world"\n`,
  );
  await chmod(stub, 0o755);
  await writeFile(join(cwd, "in.wav"), "RIFF");
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function runHarness(
  mode: "loop" | "queue" | "decode",
  wav = join(cwd, "in.wav"),
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([process.execPath, HARNESS], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HARNESS_REPO: REPO,
      HARNESS_WAV: wav,
      HARNESS_MODE: mode,
      STUB_LOG: logPath,
      ...extraEnv,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`harness exited ${code}: ${err}`);
  const line = out.split("\n").filter((l) => l.startsWith("{")).pop() as string;
  return JSON.parse(line);
}

describe("whisper transcription off the event loop (#279)", () => {
  it("lets a 50 ms timer fire while the ~1 s whisper run is in flight", async () => {
    const r = (await runHarness("loop")) as { timerMs: number; totalMs: number; text: string };
    expect(r.text).toBe("hello world");
    expect(r.totalMs).toBeGreaterThan(STUB_SLEEP_S * 1000 * 0.9);
    expect(r.timerMs).toBeLessThan(400);
  });

  it("keeps the loop free during the node ogg decode and keeps its error message", async () => {
    // A slow fake `node` first on PATH stands in for the converter process.
    const fakeBin = join(cwd, "fakebin");
    await mkdir(fakeBin);
    const fakeNode = join(fakeBin, "node");
    await writeFile(
      fakeNode,
      `#!/bin/sh\nsleep ${STUB_SLEEP_S}\necho boom >&2\nexit 3\n`,
    );
    await chmod(fakeNode, 0o755);
    const ogg = join(cwd, "in.ogg");
    await writeFile(ogg, "OggS");

    const r = (await runHarness("decode", ogg, {
      PATH: `${fakeBin}:${process.env.PATH}`,
    })) as { timerMs: number; totalMs: number; message: string };
    expect(r.message).toBe("node decode failed (exit 3): boom");
    expect(r.totalMs).toBeGreaterThan(STUB_SLEEP_S * 1000 * 0.9);
    expect(r.timerMs).toBeLessThan(400);
  });

  it("runs two transcriptions one after the other, not at the same time", async () => {
    const r = (await runHarness("queue")) as { ticks: number; totalMs: number; texts: string[] };
    expect(r.texts).toEqual(["hello world", "hello world"]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events).toEqual(["start", "end", "start", "end"]);
    expect(r.totalMs).toBeGreaterThan(STUB_SLEEP_S * 1000 * 1.8);
    expect(r.ticks).toBeGreaterThan(20);
  });
});
