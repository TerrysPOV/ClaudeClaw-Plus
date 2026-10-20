/**
 * Test preload (#304) — runs once, before any test file, for every `bun test`
 * whose cwd is the repo root (bunfig.toml `[test].preload`; bun reads bunfig
 * from the cwd only, so a `bun test` from a subdirectory runs without it).
 *
 * Two files in the operator's HOME were being written by ordinary test runs:
 * the plugin bridge's default audit journal (`~/.config/plus/plugin-audit.jsonl`,
 * seven suites through `getMcpBridge()`) and `~/.claude.json` (the PTY
 * supervisor heals the trust dialog for every spawn cwd — thousands of temp
 * `projects[...]` entries over time, parsed and backed up by claude on every
 * launch). `PLUS_PLUGIN_AUDIT_PATH` and `PLUS_CLAUDE_CONFIG_PATH` (read by
 * `PluginMcpBridge` and `ensureTrustAccepted`) point both at a temp dir for
 * the run, as does `PLUS_TOOL_CALL_LOG_PATH` (the multiplexer's
 * `mcp.tool_call` chain, `ToolCallSink`) and `TUNER_AUDIT_PATH` (#474, the
 * tuner's `~/.config/tuner/audit.jsonl`, written by `auditLog()` from the
 * wisecron apply-pipeline suite). An explicit value in the
 * environment wins, so a run that wants a specific file can have one. The dir is removed when the process exits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_PTY_ISOLATION_CLAUDE_VERSION,
  applyPtyIsolationVersionGate,
} from "../src/oneshot/claude-version.js";
import {
  setLateSlotCeilingMsForTests,
  setRootRemovalQuietMsForTests,
} from "../src/oneshot/pty-cleanup.js";

// #570: PTY isolation is advertised only after a startup probe finds a measured claude, and
// starts OFF (fail closed). Unit tests stand in for that probe so the routing they exercise
// is the one a daemon on the measured build gets. The unprobed default is pinned by
// src/oneshot/claude-version.test.ts, which reads it in a fresh process.
applyPtyIsolationVersionGate(MIN_PTY_ISOLATION_CLAUDE_VERSION, () => {});
// #570 r11: removing an untrusted call's throwaway config root waits 200 ms to see it stay
// gone. Unit tests do not run a real claude that could write into it, so they wait 5 ms.
setRootRemovalQuietMsForTests(5);
// #570 r15e: a call that returned its deadline keeps its concurrency slot until its late claude
// has landed and been retired; the ceiling only logs that it is still waiting. Unit tests shorten
// it to 250 ms, and a test whose fake spawn never lands resets the slots in its own `afterEach`
// (`resetUntrustedSlotsForTests`).
setLateSlotCeilingMsForTests(250);

const need =
  !process.env.PLUS_PLUGIN_AUDIT_PATH ||
  !process.env.PLUS_CLAUDE_CONFIG_PATH ||
  !process.env.PLUS_TOOL_CALL_LOG_PATH ||
  !process.env.TUNER_AUDIT_PATH;
if (need) {
  const dir = mkdtempSync(join(tmpdir(), "ccaw-test-home-"));
  if (!process.env.PLUS_PLUGIN_AUDIT_PATH) {
    process.env.PLUS_PLUGIN_AUDIT_PATH = join(dir, "plugin-audit.jsonl");
  }
  if (!process.env.PLUS_CLAUDE_CONFIG_PATH) {
    process.env.PLUS_CLAUDE_CONFIG_PATH = join(dir, "claude.json");
  }
  if (!process.env.PLUS_TOOL_CALL_LOG_PATH) {
    process.env.PLUS_TOOL_CALL_LOG_PATH = join(dir, "mcp-tool-calls.jsonl");
  }
  if (!process.env.TUNER_AUDIT_PATH) {
    process.env.TUNER_AUDIT_PATH = join(dir, "tuner-audit.jsonl");
  }
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
