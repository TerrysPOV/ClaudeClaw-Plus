#!/usr/bin/env bun
/**
 * Spike 0.4 — Slash command delivery via stdin vs PTY.
 *
 * Sprint 0 of the Bus migration. §5.3 of the v2 spec defaults to `process`
 * supervision (plain pipes; relay slash commands by writing "/compact\n" to
 * the supervised claude's stdin). This probe checks whether claude actually
 * accepts that — or whether it isatty(0)-gates slash command handling and
 * therefore forces tmux (or a PTY shim) on Unix.
 *
 * Strategy
 * --------
 * 1. Plain stdin path: spawn `claude` (interactive, no `-p`) via Bun.spawn
 *    with `stdin: 'pipe'`. After a short settle, write "/compact\n". After
 *    another settle, send "/quit\n" (or SIGTERM). Capture stdout/stderr.
 * 2. PTY path: spawn the same `claude` invocation via bun-pty so it gets a
 *    real TTY on fd 0. Send the same sequence. Capture output.
 * 3. Compare. If plain-stdin output is "Welcome / Try (or copy ...)" boiler-
 *    plate only and slash never echoes / runs, conclude isatty(0) gating.
 *
 * Run:
 *   bun run docs/spikes/probes/slash-stdin-probe.ts
 *
 * Both paths use a throw-away cwd so we don't pollute the user's project
 * history. We also disable persistence not via `--no-session-persistence`
 * (that flag only works with -p) but by isolating the run dir.
 */

import { spawn as ptySpawn } from "bun-pty";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETTLE_BEFORE_SLASH_MS = 6000;
const SETTLE_AFTER_SLASH_MS = 4000;
const SETTLE_AFTER_QUIT_MS = 2000;

interface ProbeResult {
  mode: "plain-stdin" | "pty";
  stdoutBytes: number;
  stderrBytes: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

async function probePlainStdin(workdir: string): Promise<ProbeResult> {
  const start = Date.now();
  const proc = Bun.spawn(["claude"], {
    cwd: workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });

  // Drain stdout/stderr concurrently.
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const drainStdout = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) stdoutChunks.push(value);
    }
  })();
  const drainStderr = (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) stderrChunks.push(value);
    }
  })();

  // Wait for claude to settle (TUI paint).
  await Bun.sleep(SETTLE_BEFORE_SLASH_MS);

  // Try to send `/compact` as if it were a slash command typed in the prompt.
  // Bun.spawn with `stdin: 'pipe'` exposes a FileSink (NOT a WritableStream).
  // FileSink has .write/.flush/.end synchronously.
  const sink = proc.stdin as ReturnType<typeof Bun.file>["writer"] extends (...args: any[]) => infer R
    ? R
    : { write: (chunk: string | Uint8Array) => number; flush: () => void; end: () => void };
  // biome-ignore lint/suspicious/noExplicitAny: Bun's FileSink shape varies by version.
  const s = proc.stdin as any;
  s.write("/compact\n");
  s.flush?.();
  await Bun.sleep(SETTLE_AFTER_SLASH_MS);

  // Send /quit to try to exit cleanly. If isatty(0) check rejects slash,
  // this will also no-op and we will SIGTERM below.
  s.write("/quit\n");
  s.flush?.();
  await Bun.sleep(SETTLE_AFTER_QUIT_MS);

  try {
    s.end?.();
  } catch {
    // ignore
  }

  // Force exit if claude didn't quit on its own.
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    await Bun.sleep(500);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  const exitCode = await proc.exited;
  await Promise.race([drainStdout, Bun.sleep(1000)]);
  await Promise.race([drainStderr, Bun.sleep(1000)]);

  const decoder = new TextDecoder();
  const stdout = decoder.decode(Buffer.concat(stdoutChunks));
  const stderr = decoder.decode(Buffer.concat(stderrChunks));

  return {
    mode: "plain-stdin",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - start,
  };
}

async function probePty(workdir: string): Promise<ProbeResult> {
  const start = Date.now();
  const pty = ptySpawn("claude", [], {
    cwd: workdir,
    cols: 120,
    rows: 30,
    env: { ...process.env, CI: "1" } as Record<string, string>,
  });

  let buf = "";
  let exitCode: number | null = null;
  pty.onData((data: string) => {
    buf += data;
  });
  pty.onExit((info: { exitCode: number }) => {
    exitCode = info.exitCode;
  });

  await Bun.sleep(SETTLE_BEFORE_SLASH_MS);
  pty.write("/compact\r");
  await Bun.sleep(SETTLE_AFTER_SLASH_MS);
  pty.write("/quit\r");
  await Bun.sleep(SETTLE_AFTER_QUIT_MS);

  if (exitCode === null) {
    pty.kill("SIGTERM");
    await Bun.sleep(500);
    if (exitCode === null) pty.kill("SIGKILL");
  }

  return {
    mode: "pty",
    stdoutBytes: Buffer.byteLength(buf),
    stderrBytes: 0, // PTY merges stdout/stderr onto one stream.
    stdout: buf,
    stderr: "",
    exitCode,
    durationMs: Date.now() - start,
  };
}

function summarise(r: ProbeResult): void {
  const tail = (s: string, n = 600) => (s.length > n ? "...\n" + s.slice(-n) : s);
  console.log(`\n── ${r.mode} ──────────────────────────────────────────`);
  console.log(`exitCode:       ${r.exitCode}`);
  console.log(`stdout bytes:   ${r.stdoutBytes}`);
  console.log(`stderr bytes:   ${r.stderrBytes}`);
  console.log(`duration:       ${r.durationMs}ms`);
  console.log(`stdout (tail):\n${tail(r.stdout)}`);
  if (r.stderr) console.log(`stderr (tail):\n${tail(r.stderr)}`);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spike-0.4-"));
  // Seed a trivial file so claude has a workspace to chat about.
  await writeFile(join(dir, "README.md"), "# spike 0.4\n");

  console.log(`workdir: ${dir}`);
  console.log(`claude:  ${process.env.PATH?.split(":").find((p) => p) ?? "?"}`);

  try {
    const plain = await probePlainStdin(dir);
    summarise(plain);

    const pty = await probePty(dir);
    summarise(pty);

    // Write artifacts so the finding doc can cite specific bytes.
    const artDir = join(import.meta.dir, "..", "fixtures", "slash-stdin");
    await Bun.write(`${artDir}/plain-stdin.log`, plain.stdout + "\n[STDERR]\n" + plain.stderr);
    await Bun.write(`${artDir}/pty.log`, pty.stdout);
    console.log(`\nArtifacts: ${artDir}/`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
