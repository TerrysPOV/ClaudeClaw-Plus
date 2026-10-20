import type { OneShotEngine } from "./engine.js";
import { chatEngineConfig, DEFAULT_OLLAMA_BASE_URL, routerEngineConfig } from "./http-config.js";

/** Stateless HTTP engines: no session to resume, no tools, nothing local to reach. */
const httpCaps = (): OneShotEngine["caps"] => ({ resume: false, tools: false, isolation: true });

/** Built-ins are lazy so configuration validation never loads the runner. */
export const engines = new Map<string, OneShotEngine>([
  [
    "print",
    {
      id: "print",
      caps: { resume: true, tools: true, isolation: true },
      run: async (req) => (await import("./print.js")).runPrint(req),
    },
  ],
  [
    "pty",
    {
      id: "pty",
      // No untrusted routing until the interactive isolation spike is reviewed
      // green; flipping this is the only switch, so it needs that review.
      caps: { resume: true, tools: true, isolation: false },
      run: async (req) => (await import("../runner/pty-supervisor.js")).runOnceOnPty(req),
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
