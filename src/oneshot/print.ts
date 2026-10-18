import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSpawnEnv } from "../runner/spawn-env.js";
import type { OneShotRequest, OneShotResult } from "./engine.js";
import { UNTRUSTED_CLAUDE_ARGS, validateIsolation } from "./isolation.js";

interface PrintRuntime {
  spawn?: typeof spawn;
  env?: Record<string, string>;
  forcePrint?: boolean;
  stdinPrompt?: boolean;
}
// Preserve the tuner's per-instance spawn seam without expanding the frozen
// request API or introducing mutable process-wide overrides.
const runtime = new AsyncLocalStorage<PrintRuntime>();
export const printRuntime = (): PrintRuntime | undefined => runtime.getStore();
export function withPrintRuntime<T>(options: PrintRuntime, call: () => T): T {
  return runtime.run(options, call);
}

export function buildPrintArgs(req: OneShotRequest, stdinPrompt = false): string[] {
  validateIsolation(req);
  const args = stdinPrompt ? ["--print", "--output-format", "text"] : ["-p", req.prompt];
  const model = req.model?.trim();
  if (
    model &&
    model.toLowerCase() !== "glm" &&
    (req.isolation === "untrusted" || model.toLowerCase() !== "kimi-k2p6")
  )
    args.push("--model", model);
  if (req.system) args.push("--system-prompt", req.system);
  if (req.isolation === "untrusted") args.push(...UNTRUSTED_CLAUDE_ARGS);
  else {
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.allowedTools)
      args.push(
        "--tools",
        req.allowedTools.join(","),
        "--allowedTools",
        req.allowedTools.join(","),
      );
  }
  // Claude CLI has no maxTokens flag. HTTP engines can honour it later.
  return args;
}

/** Supported claude -p engine; wall-clock deadline includes child exit. */
export async function runPrint(req: OneShotRequest): Promise<OneShotResult> {
  validateIsolation(req);
  req.signal?.throwIfAborted();
  const overrides = printRuntime();
  let env = overrides?.env ?? cleanSpawnEnv();
  const args = buildPrintArgs(req, overrides?.stdinPrompt);
  if (req.isolation === "trusted-session") {
    const { getSettings } = await import("../config.js");
    let settings: ReturnType<typeof getSettings> | undefined;
    try {
      settings = getSettings();
    } catch {
      /* standalone caller */
    }
    if (settings) {
      const { buildChildEnv, buildSecurityArgs } = await import("../runner.js");
      env = buildChildEnv(env, req.model ?? settings.model, settings.api);
      // Explicit tool restrictions win over the default permission profile.
      if (!req.allowedTools) args.push(...buildSecurityArgs(settings.security));
    }
  }
  const cwd =
    req.isolation === "untrusted"
      ? mkdtempSync(join(tmpdir(), "claudeclaw-oneshot-"))
      : (req.cwd ?? process.cwd());
  try {
    return await new Promise<OneShotResult>((resolve, reject) => {
      const child = (overrides?.spawn ?? spawn)("claude", args, {
        stdio: [overrides?.stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
        env,
        cwd,
      });
      let text = "";
      let stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        stopped = true;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      };
      const timer = setTimeout(stop, req.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        req.signal?.removeEventListener("abort", stop);
      };
      child.stdout!.on("data", (data: Buffer) => {
        if (text.length + data.length > 16 * 1024 * 1024) stop();
        else text += data.toString();
      });
      // Drain stderr without copying potentially sensitive model output into logs.
      child.stderr!.on("data", () => {});
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        resolve({
          text: text.trim(),
          engine: "print",
          model: req.model?.trim() ?? "",
          exitCode: stopped ? 124 : (code ?? 1),
          ...(req.resumeSessionId ? { sessionId: req.resumeSessionId } : {}),
        });
      });
      if (overrides?.stdinPrompt) {
        child.stdin!.on("error", () => {}); // EPIPE is reported by child exit.
        child.stdin!.end(req.prompt);
      }
      req.signal?.addEventListener("abort", stop, { once: true });
      if (req.signal?.aborted) stop();
    });
  } finally {
    if (req.isolation === "untrusted") {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best effort, preserve result */
      }
    }
  }
}
