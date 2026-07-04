import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isUnsafeBackground } from "../../hooks/guard-bash-backgrounding.mjs";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "guard-bash-backgrounding.mjs");

/* ── isUnsafeBackground (pure) ─────────────────────────────────────────── */

describe("isUnsafeBackground", () => {
  it("flags inline background jobs that can hold the pipe", () => {
    for (const c of [
      "nohup bun run /tmp/x.ts > /tmp/x.log 2>&1 &", // the #295 pattern
      "sleep 100 &",
      "cmd &",
      "cmd & echo done",
      "a & b &",
      "python server.py &",
    ]) {
      expect(isUnsafeBackground(c)).toBe(true);
    }
  });

  it("allows logical-AND, fd-dups, redirect-all, and non-background commands", () => {
    for (const c of [
      "make && make test",
      "cmd 2>&1",
      "grep x file >&2",
      "cmd &>out.log", // redirect-all, not a background operator
      "ls -la",
      "echo hello",
      "",
    ]) {
      expect(isUnsafeBackground(c)).toBe(false);
    }
  });

  it("allows the safe backgrounding forms (wait, full setsid detach)", () => {
    expect(isUnsafeBackground("cmd1 & cmd2 & wait")).toBe(false);
    expect(isUnsafeBackground("setsid mycmd </dev/null >log 2>&1 &")).toBe(false);
    expect(isUnsafeBackground("setsid mycmd 0</dev/null >log 2>&1 &")).toBe(false);
  });

  it("does not false-positive on '&' inside quotes or URLs", () => {
    expect(isUnsafeBackground('echo "a & b"')).toBe(false);
    expect(isUnsafeBackground("curl 'http://x?a=1&b=2'")).toBe(false);
    expect(isUnsafeBackground('curl "http://x?a=1&b=2"')).toBe(false);
  });

  it("non-string / empty input is safe", () => {
    expect(isUnsafeBackground(undefined)).toBe(false);
    expect(isUnsafeBackground(null)).toBe(false);
    expect(isUnsafeBackground(42)).toBe(false);
  });
});

/* ── tightened safe-form exemptions (#302 review: Codex + Claude) ───────── */

describe("isUnsafeBackground — safe-form exemptions are strict", () => {
  it("setsid with only stdin (or stdin+2>&1) redirected is still unsafe", () => {
    expect(isUnsafeBackground("setsid long-server </dev/null &")).toBe(true); // stdout/stderr leak
    expect(isUnsafeBackground("setsid x </dev/null 2>&1 &")).toBe(true); // stdout still on the pipe
  });
  it("a `wait` that is not a real wait-on-the-job does not exempt", () => {
    expect(isUnsafeBackground("echo wait; nohup server >log 2>&1 &")).toBe(true); // arg, before the bg
    expect(isUnsafeBackground("wait; nohup server &")).toBe(true); // wait before the background
  });
  it("a quoted wait/setsid does not exempt", () => {
    expect(isUnsafeBackground('nohup server >log 2>&1 & echo "please wait"')).toBe(true);
    expect(isUnsafeBackground('echo "via setsid"; nohup bad &')).toBe(true);
  });
  it("the full-detach and real-wait forms are still allowed", () => {
    expect(isUnsafeBackground("setsid x </dev/null >log 2>&1 &")).toBe(false);
    expect(isUnsafeBackground("setsid x </dev/null &>log &")).toBe(false); // &>log = both fds
    expect(isUnsafeBackground("a & b & wait")).toBe(false);
  });
});

/* ── hook integration (stdin JSON → deny/allow) ────────────────────────── */

describe("guard-bash-backgrounding hook", () => {
  const run = (payload: unknown) =>
    spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });

  it("denies an unsafe Bash background command with run_in_background guidance", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "nohup x > log 2>&1 &" } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("run_in_background");
  });

  it("allows a safe Bash command (emits nothing → default flow)", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "make && make test" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("ignores non-Bash tools", () => {
    const r = run({ tool_name: "Read", tool_input: { file_path: "/x & y" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("fails open on malformed input (never blocks the tool)", () => {
    const r = spawnSync("node", [HOOK], { input: "not json at all", encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
