import { describe, expect, it } from "bun:test";
import type { PtyProcessOptions } from "../runner/pty-process.js";
import { __buildClaudeArgsForTests } from "../runner/pty-process.js";
import type { OneShotRequest } from "./engine.js";
import { buildPrintArgs } from "./print.js";

const security = { level: "moderate" as const, allowedTools: [], disallowedTools: [] };
const base: OneShotRequest = {
  route: "compact",
  prompt: "p",
  isolation: "trusted-session",
  timeoutMs: 1000,
};

function ptyArgs(model: string | undefined, isolation: PtyProcessOptions["isolation"]): string[] {
  return __buildClaudeArgsForTests({
    sessionId: "",
    cwd: "/tmp",
    isolation,
    modelOverride: model,
    security,
    env: {},
  });
}

describe("model alias rule shared by print and pty (Codex P2 on #560)", () => {
  for (const alias of ["glm", "kimi-k2p6", "KIMI-K2P6"]) {
    for (const isolation of ["trusted-session", "untrusted"] as const) {
      it(`neither engine forwards --model ${alias} (${isolation})`, () => {
        const print = buildPrintArgs({
          ...base,
          route: isolation === "untrusted" ? "tuner.judge" : "compact",
          isolation,
          model: alias,
        });
        expect(print).not.toContain("--model");
        expect(ptyArgs(alias, isolation)).not.toContain("--model");
      });
    }
  }
  it("both engines forward a real model name", () => {
    const model = "claude-sonnet-4-20250514";
    const print = buildPrintArgs({ ...base, model });
    expect(print.slice(print.indexOf("--model"), print.indexOf("--model") + 2)).toEqual([
      "--model",
      model,
    ]);
    const pty = ptyArgs(model, "trusted-session");
    expect(pty.slice(pty.indexOf("--model"), pty.indexOf("--model") + 2)).toEqual([
      "--model",
      model,
    ]);
  });
});
