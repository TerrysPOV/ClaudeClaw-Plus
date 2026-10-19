import type { OneShotEngine } from "./engine.js";

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
]);
