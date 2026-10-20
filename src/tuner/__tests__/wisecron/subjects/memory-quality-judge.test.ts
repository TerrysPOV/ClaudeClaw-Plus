import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySubject } from "../../../subjects/memory-subject.js";
import { ClaudeCliBackend, type LLMClient } from "../../../../skills-tuner/core/llm.js";

let dir: string;
let indexPath: string;
let qcPath: string;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memjudge-"));
  indexPath = join(dir, "MEMORY.md");
  qcPath = join(dir, "memory-quality-cache.json");
  writeFileSync(join(dir, "alpha.md"), "# alpha\n", "utf8");
  writeFileSync(indexPath, "- [Alpha](alpha.md) — the alpha entry\n", "utf8");
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

/** A CLI backend whose `claude` cannot be found: spawn with an empty PATH → real ENOENT. */
function missingCli(): ClaudeCliBackend {
  const emptyBin = join(dir, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const spawnNoPath = ((cmd: string, args: string[], opts: object) =>
    spawn(cmd, args, { ...opts, env: { PATH: emptyBin } })) as unknown as typeof spawn;
  return new ClaudeCliBackend({ models: {} } as never, spawnNoPath);
}
function judged(llm: LLMClient): MemorySubject {
  return new MemorySubject({
    memoryIndex: indexPath,
    signalHistoryPath: join(dir, "signal.jsonl"),
    qualityCachePath: qcPath,
    llm,
  });
}
function cache(): {
  median: unknown;
  failed?: boolean;
  reason?: { code?: string; message: string };
} {
  return JSON.parse(readFileSync(qcPath, "utf8"));
}
function warned(): string {
  return warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}
function throwing(message: string): LLMClient {
  return {
    call: async () => {
      throw new Error(message);
    },
    modelFor: () => "m",
  };
}

describe("MemorySubject — entry quality judge failure reason", () => {
  it("records and logs spawn ENOENT instead of a bare median null", async () => {
    expect(await judged(missingCli()).measureEntryQuality(12)).toBeNull();
    const c = cache();
    expect(c.median).toBeNull();
    expect(c.failed).toBe(true);
    expect(c.reason?.code).toBe("ENOENT");
    expect(c.reason?.message).toContain("claude");
    expect(warned()).toContain("memory quality judge failed: ENOENT");
  });

  it("keeps the cycle going: collectObservations does not throw and leaves the reason", async () => {
    const obs = await judged(missingCli()).collectObservations(new Date(0));
    expect(Array.isArray(obs)).toBe(true);
    expect(cache().reason?.code).toBe("ENOENT");
  });

  it("an unparseable reply gets a reason without the reply text", async () => {
    const llm: LLMClient = {
      call: async () => "secret-ish reply with no scores",
      modelFor: () => "m",
    };
    expect(await judged(llm).measureEntryQuality(12)).toBeNull();
    expect(cache().reason?.code).toBe("UNPARSEABLE");
    expect(readFileSync(qcPath, "utf8")).not.toContain("secret-ish");
    expect(warned()).toContain("UNPARSEABLE");
  });

  it("a malformed score array gets UNPARSEABLE, not the parser's message quoting the reply", async () => {
    const llm: LLMClient = { call: async () => "[secretish token]", modelFor: () => "m" };
    expect(await judged(llm).measureEntryQuality(12)).toBeNull();
    expect(cache().reason?.code).toBe("UNPARSEABLE");
    expect(readFileSync(qcPath, "utf8")).not.toContain("secretish");
    expect(warned()).not.toContain("secretish");
  });

  it("redacts token-shaped text and keeps only the first line", async () => {
    // Built at runtime so the fixture never reads as a committed credential.
    const key = ["sk", "ant", "api03", "AbCdEfGhIjKlMnOp_qrstuv"].join("-");
    await judged(throwing(`401 invalid x-api-key ${key}\nsecond line`)).measureEntryQuality(12);
    const r = cache().reason;
    expect(r?.message).toBe("401 invalid x-api-key [redacted]");
    expect(readFileSync(qcPath, "utf8")).not.toContain("AbCdEf");
    expect(warned()).not.toContain("AbCdEf");
  });

  it("a CLI exit keeps its exit code, never the CLI's stderr", async () => {
    await judged(
      throwing("claude CLI exited 1: Error near: - [Alpha](alpha.md) private note"),
    ).measureEntryQuality(12);
    const r = cache().reason;
    expect(r).toEqual({ code: "CLI_EXIT", message: "claude CLI exited 1" });
    expect(readFileSync(qcPath, "utf8")).not.toContain("private note");
    expect(warned()).toContain("memory quality judge failed: CLI_EXIT: claude CLI exited 1");
    expect(warned()).not.toContain("private note");
  });

  it("a CLI killed by a signal (exit code null) keeps no stderr either", async () => {
    await judged(throwing("claude CLI exited null: killed mid-entry text")).measureEntryQuality(12);
    expect(cache().reason).toEqual({ code: "CLI_EXIT", message: "claude CLI exited null" });
  });

  it("does not call the judge again within the failure cooldown", async () => {
    let calls = 0;
    const llm: LLMClient = {
      call: async () => {
        calls++;
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
      modelFor: () => "m",
    };
    await judged(llm).collectObservations(new Date(0));
    await judged(llm).collectObservations(new Date(0));
    expect(calls).toBe(1);
    expect(cache().reason?.code).toBe("ETIMEDOUT");
  });

  it("logs an unreadable cache instead of a silent null", async () => {
    writeFileSync(qcPath, "{not json", "utf8");
    const out = await judged(throwing("x")).measureFitness(
      { from: new Date(0), to: new Date() } as never,
      { query: async () => [] } as never,
    );
    expect(out.memory_entry_quality).toBeUndefined();
    expect(warned()).toContain("memory quality cache unreadable");
  });

  it("a good reply still caches a median with no reason", async () => {
    const llm: LLMClient = { call: async () => "[4]", modelFor: () => "m" };
    expect(await judged(llm).measureEntryQuality(12)).toBe(4);
    expect(cache().median).toBe(4);
    expect(cache().reason).toBeUndefined();
  });
});
