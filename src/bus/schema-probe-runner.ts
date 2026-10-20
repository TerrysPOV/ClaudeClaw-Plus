/**
 * Schema-probe runner — default `bun-pty` factory.
 *
 * Split out of `schema-probe.ts` to keep that file under the 500-LOC
 * budget AND so unit tests that inject their own `ProbeRunnerFactory`
 * never load the native PTY module.
 *
 * Why PTY (not `-p`)?
 *   - Spike 0.4: claude REPL gates on `process.stdin.isTTY` AND
 *     `process.stdout.isTTY`. Plain `Bun.spawn({stdin:'pipe'})`
 *     downshifts to `--print` mode within ~3 s.
 *   - Spike 0.6: `claude -p --input-format=stream-json` silently drops
 *     `notifications/claude/channel`. The probe MUST validate the same
 *     supervision path production uses — and production needs channels.
 *
 * Issue #441 — three things kept a real claude from ever reaching a turn:
 *   1. Trust dialog. A fresh temp cwd opens "Is this a project you created or
 *      one you trust?" with "No, exit" preselected. Pre-accepted here with the
 *      same `ensureTrustAccepted` helper the PTY supervisor uses.
 *   2. Dev-channels dialog ("I am using this for local development / Exit").
 *      Answered by `PtyAgentProcess`'s output-driven boot-dialog watcher
 *      (issue #193) — the probe drives the PTY through the same class the
 *      SessionManager uses, so dialog handling and prompt delivery are the
 *      production path, not a probe-only copy.
 *   3. Fixed pacing. `waitForReady` resolves on the REPL footer actually
 *      appearing; the probe then paces each step on JSONL events.
 */

import { cleanSpawnEnv, withCleanProcessEnv } from "../runner";
import { stripAnsi } from "../runner/pty-output-parser";
import { ensureTrustAccepted } from "../runner/pty-trust-prompt";
import { PtyAgentProcess } from "./session-agent-process";
import type { ProbeRunner, ProbeRunnerFactory } from "./schema-probe-types";

interface BunPtyHandle {
  readonly pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(d: string): void;
  kill(sig?: string): void;
}

interface BunPtyModule {
  spawn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; cols?: number; rows?: number; env?: Record<string, string> },
  ) => BunPtyHandle;
}

/** Idle REPL footer — the mode-cycler hint, same marker the boot-dialog
 *  watcher in `PtyAgentProcess` disengages on. */
const REPL_READY_RE = /tab\s*to\s*cycle/;

export const defaultPtyRunnerFactory: ProbeRunnerFactory = async ({
  cwd,
  sessionId,
  claudeBin,
  homeDir,
}) => {
  // #441 (1): without this, claude's trust dialog preselects "No, exit".
  // A failure here is not fatal — the run then fails on `repl_ready`, which
  // names the stuck screen.
  await ensureTrustAccepted(cwd, homeDir ? { homedir: () => homeDir } : undefined);

  const bunPty = (await import("bun-pty")) as BunPtyModule;

  // Match spec §5.3 / session-manager.ts:154 — load the Bus plugin into
  // claude. Probe uses the same plugin spec as production so validation
  // reflects real behaviour, not a probe-only path. Spike 0.6 confirmed
  // this flag does NOT need `-p` (and `-p` would silently drop channel
  // notifications anyway).
  const args = [
    "--dangerously-load-development-channels",
    "plugin:plus-bus@local",
    "--permission-mode",
    "plan",
    "--session-id",
    sessionId,
  ];

  // PR #111 review (agent #3 + agent #4) flagged: bun-pty.spawn MUST go
  // through `withCleanProcessEnv` + use `cleanSpawnEnv()` for the same
  // reason PR #110 wrapped session-manager.ts's spawn. bun-pty's Rust
  // `portable_pty` merges the parent process env at fork() time; passing
  // a sanitised env Record alone is insufficient. The leak class:
  // `ANTHROPIC_API_KEY` (and other strip-list keys) in `process.env` get
  // inherited by the spawned claude, trigger the "Detected a custom API
  // key" gate, and dump a truncated key into the PTY. PR #104's
  // long-lived `sk-ant-oat01-*` token exception is honoured by
  // `withCleanProcessEnv` itself, so the wrap is safe for the supported
  // token shape.
  const env: Record<string, string> = { ...cleanSpawnEnv(), CI: "1" };
  // `homeOverride` means "the home claude reads and writes": the probe
  // predicts the JSONL path under it, so the child must use it too.
  if (homeDir) env.HOME = homeDir;
  const handle = withCleanProcessEnv(() =>
    bunPty.spawn(claudeBin, args, {
      cwd,
      cols: 120,
      rows: 30,
      env,
    }),
  );

  const proc = new PtyAgentProcess(`schema-probe-${sessionId.slice(0, 8)}`, handle);

  let exited = false;
  const exitWaiters: Array<() => void> = [];
  proc.onExit(() => {
    exited = true;
    for (const w of exitWaiters.splice(0)) w();
  });
  // Bus does NOT parse this channel for model output — the JSONL is the
  // source of truth (spec §5.3). Only the REPL-ready footer is read here.
  let screen = "";
  let ready = false;
  const readyWaiters: Array<() => void> = [];
  proc.onData((chunk) => {
    if (ready) return;
    screen = (screen + stripAnsi(chunk)).slice(-4000);
    if (REPL_READY_RE.test(screen)) {
      ready = true;
      for (const w of readyWaiters.splice(0)) w();
    }
  });

  const waitUntil = (done: () => boolean, waiters: Array<() => void>, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (done()) return resolve(true);
      const timer = setTimeout(() => resolve(done()), Math.max(0, timeoutMs));
      waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const runner: ProbeRunner = {
    async sendPrompt(text) {
      await proc.send_prompt_stream(text);
    },
    sendSlash(cmd) {
      return proc.send_slash(cmd);
    },
    waitForReady(timeoutMs) {
      // An exit while booting (e.g. a dialog answered "Exit") is not ready.
      return waitUntil(() => ready, readyWaiters, timeoutMs).then((ok) => ok && !exited);
    },
    waitForExit(timeoutMs) {
      return waitUntil(() => exited, exitWaiters, timeoutMs);
    },
    screenTail() {
      return proc.recentOutputTail();
    },
    kill() {
      proc._kill("SIGTERM");
    },
  };
  return runner;
};
