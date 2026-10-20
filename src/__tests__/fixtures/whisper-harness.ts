/**
 * Child-process harness for whisper-event-loop.test.ts.
 *
 * whisper.ts freezes its asset root from process.cwd() at import time, so the
 * test runs it in a child whose cwd holds a stub `whisper-cli`. Prints one JSON
 * line on stdout.
 *
 * Env: HARNESS_REPO (repo root), HARNESS_WAV (input), HARNESS_MODE
 * ("loop" = one transcription with a 50 ms timer racing it,
 *  "decode" = same, but on a corrupt .ogg so the node converter runs and fails,
 *  "queue" = two transcriptions started together with a tick counter).
 */

import { join } from "node:path";

const repo = process.env.HARNESS_REPO as string;
const wav = process.env.HARNESS_WAV as string;
const mode = process.env.HARNESS_MODE;

const { loadSettings } = await import(join(repo, "src", "config.ts"));
await loadSettings();
const { transcribeAudioToText } = await import(join(repo, "src", "whisper.ts"));

const t0 = performance.now();

if (mode === "loop") {
  const run = transcribeAudioToText(wav);
  const timerMs = await new Promise<number>((resolve) =>
    setTimeout(() => resolve(performance.now() - t0), 50),
  );
  const text = await run;
  console.log(JSON.stringify({ timerMs, totalMs: performance.now() - t0, text }));
} else if (mode === "decode") {
  const run = transcribeAudioToText(wav).then(
    () => "resolved",
    (err: Error) => err.message,
  );
  const timerMs = await new Promise<number>((resolve) =>
    setTimeout(() => resolve(performance.now() - t0), 50),
  );
  const message = await run;
  console.log(JSON.stringify({ timerMs, totalMs: performance.now() - t0, message }));
} else {
  let ticks = 0;
  const interval = setInterval(() => ticks++, 20);
  const texts = await Promise.all([transcribeAudioToText(wav), transcribeAudioToText(wav)]);
  clearInterval(interval);
  console.log(JSON.stringify({ ticks, totalMs: performance.now() - t0, texts }));
}
