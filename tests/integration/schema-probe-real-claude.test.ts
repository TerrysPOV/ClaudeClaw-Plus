/**
 * SchemaProbe against a REAL `claude` — nightly job, not the PR job (#441).
 *
 * The probe exists to say "this CLI update changed the transcript shapes the
 * Bus reads". It only does that if it can (a) pass on a healthy CLI and (b)
 * fail when a shape is gone. So: a strict `status === "passed"` run — never
 * `["passed", "failed"]`, which is how the pre-#304 smoke test stayed green
 * while the probe could not reach a single turn — and the same assertions
 * replayed over that run's own transcript with one field broken at a time,
 * each of which must fail.
 *
 * Run locally: `cd tests/integration && bun test schema-probe` with `claude`
 * on PATH and logged in. Uses the real HOME (that is where claude's auth is);
 * the probe cache goes to a temp file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  defaultPtyRunnerFactory,
  predictJsonlPath,
  type ProbeRunnerFactory,
  runAssertions,
  SchemaProbe,
} from "../../src/bus/schema-probe";
import {
  readClaudeConfig,
  seedClaudeOnboarding,
  unseedClaudeOnboarding,
  writeClaudeConfig,
} from "./claude-onboarding";

// Boot + two short model turns + /clear + /quit: ~10 s measured on 2.1.286.
// The budget is a bound, not a pace — the probe moves on each event.
const PROBE_BUDGET_MS = 180_000;

const cacheDir = mkdtempSync(join(tmpdir(), "ccaw-probe-it-"));
let spawned: { cwd: string; sessionId: string } | null = null;

// Same runner production would use; only records where it ran, so the test
// can read the transcript and clean up after itself.
const recordingFactory: ProbeRunnerFactory = async (args) => {
  spawned = { cwd: args.cwd, sessionId: args.sessionId };
  return defaultPtyRunnerFactory(args);
};

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(() => {
  seedClaudeOnboarding();
});

afterAll(() => {
  unseedClaudeOnboarding();
  rmSync(cacheDir, { recursive: true, force: true });
  if (!spawned) return;
  // The probe's temp cwd, its transcripts, and the trust entry the runner
  // added for it — leave the developer's ~/.claude.json as it was.
  const projectDir = dirname(predictJsonlPath(homedir(), spawned.cwd, spawned.sessionId));
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(spawned.cwd, { recursive: true, force: true });
  const cfgPath = join(homedir(), ".claude.json");
  const cfg = readClaudeConfig(cfgPath);
  const projects = cfg?.projects as Record<string, unknown> | undefined;
  if (cfg && projects && spawned.cwd in projects) {
    const { [spawned.cwd]: _probe, ...rest } = projects;
    writeClaudeConfig(cfgPath, { ...cfg, projects: rest });
  }
});

describe("SchemaProbe — real claude", () => {
  test(
    "passes against the installed CLI",
    async () => {
      const probe = new SchemaProbe(
        {
          force: true,
          cacheFile: join(cacheDir, "schema-probe-cache.json"),
          timeoutMs: PROBE_BUDGET_MS,
        },
        recordingFactory,
      );
      const res = await probe.run();
      // Print the reasons on failure: they name the step and the screen.
      expect(res.failedAssertions ?? []).toEqual([]);
      expect(res.status).toBe("passed");
    },
    PROBE_BUDGET_MS + 30_000,
  );

  test("its assertions fail when a shape the Bus reads is broken", () => {
    expect(spawned).not.toBeNull();
    const { cwd, sessionId } = spawned as { cwd: string; sessionId: string };
    const expectedPath = predictJsonlPath(homedir(), cwd, sessionId);
    expect(existsSync(expectedPath)).toBe(true);
    const dir = dirname(expectedPath);
    const siblings = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && join(dir, f) !== expectedPath)
      .map((f) => join(dir, f));
    const lines = readLines(expectedPath);

    const failing = (mutated: Record<string, unknown>[], sibs = siblings) =>
      runAssertions(
        { path: expectedPath, lines: mutated, raw: "x" },
        { expectedPath, siblingJsonls: sibs },
      )
        .filter((r) => !r.passed)
        .map((r) => r.name);

    // The real transcript, untouched: nothing fails.
    expect(failing(lines)).toEqual([]);

    // Rewrites one field on every line, deep-cloned so cases stay independent.
    // Loose on purpose: the point is to break shapes the types describe.
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed transcript lines.
    type Loose = Record<string, any>;
    const mutate = (fn: (l: Loose) => void) =>
      lines.map((l) => {
        const c = structuredClone(l) as Loose;
        fn(c);
        return c;
      });

    // Usage counters renamed (what a usage-schema change would look like).
    expect(
      failing(
        mutate((l) => {
          const u = l.message?.usage;
          if (u && "cache_read_input_tokens" in u) {
            u.cache_read_tokens = u.cache_read_input_tokens;
            delete u.cache_read_input_tokens;
          }
        }),
      ),
    ).toContain("usage_block_present");

    // Text blocks renamed.
    expect(
      failing(
        mutate((l) => {
          if (l.type !== "assistant" || !Array.isArray(l.message?.content)) return;
          for (const b of l.message.content) if (b.type === "text") b.type = "output_text";
        }),
      ),
    ).toContain("assistant_text_present");

    // tool_result promoted out of user content (the pre-Spike-0.2 guess).
    expect(
      failing(
        mutate((l) => {
          if (l.type !== "user" || !Array.isArray(l.message?.content)) return;
          for (const b of l.message.content) if (b.type === "tool_result") b.type = "result";
        }),
      ),
    ).toContain("tool_result_present");

    // /clear stops rotating to a new file.
    expect(failing(lines, [])).toContain("clear_rotation_detected");
  });
});
