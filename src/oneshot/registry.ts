import { restoreFileMentions } from "../runner/pty-prompt-sanitizer.js";
import type { OneShotEngine, OneShotRequest, OneShotResult } from "./engine.js";
import { chatEngineConfig, DEFAULT_OLLAMA_BASE_URL, routerEngineConfig } from "./http-config.js";

/** Stateless HTTP engines: no session to resume, no tools, nothing local to reach. */
const httpCaps = (): OneShotEngine["caps"] => ({ resume: false, tools: false, isolation: true });

/**
 * `print` and `pty` replace every `@` in an untrusted prompt with U+FF20 so the CLI cannot
 * expand it into a file. This is the one place the reply gets the `@` back, for both.
 */
const restoreMentions = (req: OneShotRequest, result: OneShotResult): OneShotResult =>
  req.isolation === "untrusted" ? { ...result, text: restoreFileMentions(result.text) } : result;

/** Built-ins are lazy so configuration validation never loads the runner. */
export const engines = new Map<string, OneShotEngine>([
  [
    "print",
    {
      id: "print",
      caps: { resume: true, tools: true, isolation: true },
      run: async (req) => restoreMentions(req, await (await import("./print.js")).runPrint(req)),
    },
  ],
  [
    "pty",
    {
      id: "pty",
      // Interactive isolation spike: every row green in both directions on claude
      // 2.1.304, with a known intermittent no-reply on tool-instruction prompts
      // (bounded, fails closed). See docs/spikes/0.7-interactive-isolation.md. The untrusted
      // spawn passes untrustedInteractiveArgs() and the caller env policy, and removes its
      // on-disk state in runOnceOnPty's finally.
      // Fail closed: isolation starts OFF and `applyPtyIsolationVersionGate` (claude-version.ts)
      // turns it on only after a probe finds claude at least the measured version. A process
      // that never probes (a CLI tool, a test) therefore keeps untrusted routes on print.
      caps: { resume: true, tools: true, isolation: false },
      run: async (req) =>
        restoreMentions(req, await (await import("../runner/pty-supervisor.js")).runOnceOnPty(req)),
    },
  ],
  [
    "openai-compatible",
    {
      id: "openai-compatible",
      caps: httpCaps(),
      checkConfig: (config, name) => void chatEngineConfig(config, name),
      run: async (req, config) => (await import("./http.js")).runOpenAiCompatible(req, config),
    },
  ],
  [
    "ollama",
    {
      id: "ollama",
      caps: httpCaps(),
      checkConfig: (config, name) => void chatEngineConfig(config, name, DEFAULT_OLLAMA_BASE_URL),
      run: async (req, config) => (await import("./http.js")).runOllama(req, config),
    },
  ],
  [
    "llm-router",
    {
      id: "llm-router",
      caps: httpCaps(),
      checkConfig: (config, name) => void routerEngineConfig(config, name),
      run: async (req, config) => (await import("./http.js")).runLlmRouter(req, config),
    },
  ],
]);
