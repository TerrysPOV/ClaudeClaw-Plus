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
      caps: { resume: true, tools: true, isolation: true },
      run: async (req) => (await import("../runner/pty-supervisor.js")).runOnceOnPty(req),
    },
  ],
]);
