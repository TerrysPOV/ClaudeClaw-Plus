import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CronRunTelemetryProducer,
  HookExecTelemetryProducer,
  SkillAccessTelemetryProducer,
  JournalTelemetryProducer,
  ModeDispatchTelemetryProducer,
  TemplateFeedbackTelemetryProducer,
  CompositeTelemetryProvider,
  buildHostTelemetryProvider,
} from "../../wisecron/host-telemetry-provider.js";
import { SessionJsonlTelemetryProducer } from "../../wisecron/session-jsonl-provider.js";
import type {
  DateRange,
  MetricSample,
  TelemetryProvider,
  TelemetryStream,
} from "../../../skills-tuner/core/telemetry.js";
import { TELEMETRY_STREAMS } from "../../../skills-tuner/core/telemetry.js";

// Relative to now so the wall-clock probe in `capabilities()` (last 30d) always
// brackets IN — a fixed calendar fixture silently drifts out of the window and
// flips data-derived streams to available:false as time passes.
const DAY_MS = 86_400_000;
const NOW_MS = Date.now();
const RANGE: DateRange = {
  start: new Date(NOW_MS - 9 * DAY_MS),
  end: new Date(NOW_MS - 1 * DAY_MS),
};
const IN = new Date(NOW_MS - 5 * DAY_MS); // inside RANGE and inside the 30d probe
const OUT = new Date(NOW_MS - 40 * DAY_MS); // before RANGE.start -> excluded

/** Build a journalctl JSON line as `journalctl --output json` would emit. */
function journalLine(opts: { unit: string; ts: Date; exit?: number | null }): string {
  const obj: Record<string, unknown> = {
    _SYSTEMD_USER_UNIT: opts.unit,
    __REALTIME_TIMESTAMP: String(opts.ts.getTime() * 1000),
    MESSAGE: "ran",
  };
  if (opts.exit !== null && opts.exit !== undefined) obj.EXIT_STATUS = String(opts.exit);
  return JSON.stringify(obj);
}

describe("CronRunTelemetryProducer", () => {
  it("emits cron_run samples with value=exit_code and status label", async () => {
    const raw = [
      journalLine({ unit: "wisecron-a.service", ts: IN, exit: 0 }),
      journalLine({ unit: "wisecron-b.service", ts: IN, exit: 1 }),
      journalLine({ unit: "wisecron-a.service", ts: IN, exit: null }), // no EXIT_STATUS → ignored
      journalLine({ unit: "wisecron-c.service", ts: OUT, exit: 0 }), // out of window
    ].join("\n");
    const p = new CronRunTelemetryProducer({ journalRunner: () => raw });
    const samples = await p.query("cron_run", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.value).toBe(0);
    expect(samples[0]!.labels).toEqual({
      unit: "wisecron-a.service",
      exit_code: "0",
      status: "success",
      source: "systemd",
    });
    expect(samples[1]!.labels!.status).toBe("failure");
  });

  it("advertises systemd source when wisecron completions exist", () => {
    const ok = new CronRunTelemetryProducer({
      journalRunner: () => journalLine({ unit: "wisecron-a.service", ts: IN, exit: 0 }),
    });
    const cap = ok.capabilities()[0]!;
    expect(cap.available).toBe(true);
    expect(cap.reason).toMatch(/source=systemd/);
  });

  it("advertises unavailable+reason naming configured cron when no completion source", () => {
    const empty = new CronRunTelemetryProducer({
      journalRunner: () => "",
      costDbPath: "/nonexistent/costs.db",
      cronConfigProbe: () => ({ crontab: true, configSnapshot: true }),
    });
    const cap = empty.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no cron run-completion source/);
    expect(cap.reason).toMatch(/crontab/);
  });

  it("returns [] (does not throw) when the journal runner fails", async () => {
    const p = new CronRunTelemetryProducer({
      journalRunner: () => {
        throw new Error("journalctl missing");
      },
      costDbPath: "/nonexistent/costs.db",
      cronConfigProbe: () => ({ crontab: false, configSnapshot: false }),
    });
    expect(await p.query("cron_run", RANGE)).toEqual([]);
    expect(p.capabilities()[0]!.available).toBe(false);
  });

  it("returns [] for any non-cron_run stream", async () => {
    const p = new CronRunTelemetryProducer({
      journalRunner: () => "",
      costDbPath: "/nonexistent/costs.db",
    });
    expect(await p.query("hook_exec", RANGE)).toEqual([]);
  });

  it("caches the resolved source-kind within the TTL (no re-spawn on repeat calls)", () => {
    let probes = 0;
    let clock = 1_000_000;
    const p = new CronRunTelemetryProducer({
      journalRunner: () => {
        probes++;
        return journalLine({ unit: "wisecron-a.service", ts: IN, exit: 0 });
      },
      costDbPath: "/nonexistent/costs.db",
      kindCacheTtlMs: 60_000,
      now: () => clock,
    });

    // First call resolves + caches (one journalctl spawn).
    expect(p.capabilities()[0]!.available).toBe(true);
    expect(probes).toBe(1);

    // Repeat calls within the TTL reuse the cached kind — no new spawn.
    p.capabilities();
    p.capabilities();
    expect(probes).toBe(1);

    // Past the TTL, it re-probes.
    clock += 61_000;
    p.capabilities();
    expect(probes).toBe(2);
  });

  it("auto-detects the bus_scheduler source from costs.db when no systemd units", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "cron-costs-"));
    const dbPath = join(dbDir, "costs.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE session_costs (session_id TEXT, date TEXT, job TEXT, model TEXT, cost_usd REAL)",
    );
    // Dates relative to now (see IN/OUT) so they bracket RANGE regardless of wall-clock.
    const inDay = IN.toISOString().slice(0, 10); // in-window
    const outDay = OUT.toISOString().slice(0, 10); // out-of-window
    db.run(
      `INSERT INTO session_costs VALUES
        ('s1', '${inDay}', '<channel source="cron" chat_id="bus-scheduler:abc">', 'opus', 0.1),
        ('s2', '${inDay}', 'gmail', 'opus', 0.2),
        ('s3', '${outDay}', '<channel source="cron" chat_id="bus-scheduler:abc">', 'opus', 0.1)`,
    );
    db.close();

    const p = new CronRunTelemetryProducer({
      journalRunner: () => "", // no systemd units
      costDbPath: dbPath,
    });
    const cap = p.capabilities()[0]!;
    expect(cap.available).toBe(true);
    expect(cap.reason).toMatch(/source=bus_scheduler/);

    const samples = await p.query("cron_run", RANGE);
    // s1 in-window (cron), s2 not cron, s3 out-of-window.
    expect(samples).toHaveLength(1);
    expect(samples[0]!.value).toBe(0); // completed fire
    expect(samples[0]!.labels).toEqual({
      unit: "bus-scheduler:abc",
      exit_code: "0",
      status: "success",
      source: "bus_scheduler",
    });
    rmSync(dbDir, { recursive: true, force: true });
  });
});

describe("HookExecTelemetryProducer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits hook_exec with value=duration_ms and exit_code/event labels", async () => {
    writeFileSync(
      join(dir, "pre.log"),
      [
        JSON.stringify({
          hook: "pre",
          exit_code: 0,
          duration_ms: 120,
          event: "UserPromptSubmit",
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          hook: "pre",
          exit_code: 2,
          duration_ms: 999,
          event: "UserPromptSubmit",
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          hook: "pre",
          exit_code: 0,
          duration_ms: 50,
          event: "x",
          ts: OUT.toISOString(),
        }), // out of window
        "not json",
      ].join("\n"),
    );
    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const samples = await p.query("hook_exec", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([120, 999]);
    expect(samples.find((s) => s.value === 999)!.labels!.exit_code).toBe("2");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("reads the canonical exec-log.jsonl sink written by exec-log.sh", async () => {
    writeFileSync(
      join(dir, "exec-log.jsonl"),
      [
        JSON.stringify({
          ts: IN.toISOString(),
          hook: "log-skill-access",
          exit_code: 0,
          duration_ms: 42,
          event: "PostToolUse",
        }),
        JSON.stringify({
          ts: IN.toISOString(),
          hook: "context-injector",
          exit_code: 1,
          duration_ms: 1500,
          event: "UserPromptSubmit",
        }),
      ].join("\n"),
    );
    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const samples = await p.query("hook_exec", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([42, 1500]);
    expect(samples.find((s) => s.value === 1500)!.labels!.exit_code).toBe("1");
    expect(samples.find((s) => s.value === 42)!.labels!.hook).toBe("log-skill-access");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason when no exec-log/*.log present", () => {
    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const cap = p.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no parseable .* entries/);
    expect(cap.reason).toMatch(/exec-log\.sh wrapper not wired/);
  });
});

describe("SkillAccessTelemetryProducer", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-"));
    log = join(dir, "skill_accesses.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits one skill_access sample per in-window access, labelled by skill name", async () => {
    writeFileSync(
      log,
      [
        JSON.stringify({
          skill_path: "/home/x/agent/skills/foo.md",
          accessed_at: IN.toISOString(),
        }),
        JSON.stringify({
          skill_path: "/home/x/agent/skills/foo.md",
          accessed_at: IN.toISOString(),
        }),
        JSON.stringify({
          skill_path: "/home/x/agent/skills/bar.md",
          accessed_at: OUT.toISOString(),
        }), // out
      ].join("\n"),
    );
    const p = new SkillAccessTelemetryProducer({ accessLog: log });
    const samples = await p.query("skill_access", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.value).toBe(1);
    expect(samples[0]!.labels!.skill).toBe("foo");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason when the log is absent", () => {
    const p = new SkillAccessTelemetryProducer({ accessLog: join(dir, "missing.jsonl") });
    expect(p.capabilities()[0]!.available).toBe(false);
    expect(p.capabilities()[0]!.reason).toMatch(/no skill-access entries/);
  });
});

describe("JournalTelemetryProducer", () => {
  let dir: string;
  let journal: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-"));
    journal = join(dir, "operations.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advertises the 4 derived streams unavailable+reason when no matching events", () => {
    writeFileSync(journal, `${JSON.stringify({ type: "deploy", ts: IN.toISOString() })}\n`);
    const p = new JournalTelemetryProducer({ journalPath: journal });
    const caps = p.capabilities();
    expect(caps.map((c) => c.stream).sort()).toEqual([
      "agent_dispatch",
      "memory_access",
      "mode_dispatch",
      "tool_call",
    ]);
    expect(caps.every((c) => c.available === false && /no '.*' events/.test(c.reason ?? ""))).toBe(
      true,
    );
  });

  it("activates + emits a stream when matching events appear (no faked data)", async () => {
    writeFileSync(
      journal,
      [
        JSON.stringify({
          type: "tool_call",
          tool: "Read",
          server: "fs",
          success: true,
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          type: "tool_call",
          tool: "Bash",
          server: "fs",
          success: false,
          ts: IN.toISOString(),
        }),
        JSON.stringify({ type: "deploy", ts: IN.toISOString() }),
      ].join("\n"),
    );
    const p = new JournalTelemetryProducer({ journalPath: journal });
    const cap = p.capabilities().find((c) => c.stream === "tool_call")!;
    expect(cap.available).toBe(true);
    const samples = await p.query("tool_call", RANGE);
    expect(samples).toHaveLength(2);
    // value 1 = failed/blocked, 0 = ok
    expect(samples.map((s) => s.value).sort()).toEqual([0, 1]);
  });

  it("reports journal-not-found reason when the file is absent", () => {
    const p = new JournalTelemetryProducer({ journalPath: join(dir, "nope.jsonl") });
    expect(p.capabilities().every((c) => /journal not found/.test(c.reason ?? ""))).toBe(true);
  });
});

describe("ModeDispatchTelemetryProducer", () => {
  let dir: string;
  let journal: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mode-dispatch-"));
    journal = join(dir, "mode_dispatch.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits mode_dispatch with value=reclassified and mode/matched_keyword labels", async () => {
    writeFileSync(
      journal,
      [
        JSON.stringify({
          ts: IN.toISOString(),
          mode: "coding",
          matched_keyword: "fix",
          reclassified: false,
        }),
        JSON.stringify({
          ts: IN.toISOString(),
          mode: "planning",
          matched_keyword: "design",
          reclassified: true,
        }),
        JSON.stringify({
          ts: OUT.toISOString(),
          mode: "coding",
          matched_keyword: "x",
          reclassified: false,
        }), // out of window
        "not json",
      ].join("\n"),
    );
    const p = new ModeDispatchTelemetryProducer({ journalPath: journal });
    const samples = await p.query("mode_dispatch", RANGE);
    expect(samples).toHaveLength(2);
    const reclassified = samples.find((s) => s.value === 1)!;
    expect(reclassified.labels).toEqual({ mode: "planning", matched_keyword: "design" });
    expect(samples.find((s) => s.value === 0)!.labels!.mode).toBe("coding");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason when the dispatch journal is absent", () => {
    const p = new ModeDispatchTelemetryProducer({ journalPath: journal });
    const cap = p.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/dispatch journal not found/);
    expect(cap.reason).toMatch(/no agentic-mode route emitted yet/);
  });

  it("advertises unavailable+reason when the journal exists but is empty", () => {
    writeFileSync(journal, "");
    const p = new ModeDispatchTelemetryProducer({ journalPath: journal });
    expect(p.capabilities()[0]!.available).toBe(false);
    expect(p.capabilities()[0]!.reason).toMatch(/no dispatch records/);
  });

  it("returns [] for streams it does not own", async () => {
    writeFileSync(
      journal,
      `${JSON.stringify({ ts: IN.toISOString(), mode: "coding", matched_keyword: "fix", reclassified: false })}\n`,
    );
    const p = new ModeDispatchTelemetryProducer({ journalPath: journal });
    expect(await p.query("hook_exec", RANGE)).toEqual([]);
  });
});

describe("TemplateFeedbackTelemetryProducer", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmpl-fb-"));
    log = join(dir, "template_feedback.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits template_feedback with value=rating and template_id/verdict labels", async () => {
    writeFileSync(
      log,
      [
        JSON.stringify({
          ts: IN.toISOString(),
          template_id: "daily-brief",
          rating: 5,
          verdict: "yes",
        }),
        JSON.stringify({ ts: IN.toISOString(), template_id: "pitch", rating: 1, verdict: "no" }),
        JSON.stringify({ ts: OUT.toISOString(), template_id: "x", rating: 3, verdict: "yes-but" }), // out
        "not json",
      ].join("\n"),
    );
    const p = new TemplateFeedbackTelemetryProducer({ feedbackLog: log });
    const samples = await p.query("template_feedback", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([1, 5]);
    expect(samples.find((s) => s.value === 5)!.labels).toEqual({
      template_id: "daily-brief",
      verdict: "yes",
    });
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason (with the rate-template hint) when no log exists", () => {
    const p = new TemplateFeedbackTelemetryProducer({ feedbackLog: log });
    const cap = p.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no ratings yet/);
    expect(cap.reason).toMatch(/rate-template/);
  });

  it("returns [] for streams it does not own", async () => {
    writeFileSync(
      log,
      `${JSON.stringify({ ts: IN.toISOString(), template_id: "t", rating: 5, verdict: "yes" })}\n`,
    );
    const p = new TemplateFeedbackTelemetryProducer({ feedbackLog: log });
    expect(await p.query("mode_dispatch", RANGE)).toEqual([]);
  });
});

describe("CompositeTelemetryProvider", () => {
  /** A trivial provider owning exactly one stream. */
  function one(
    stream: TelemetryStream,
    available: boolean,
    samples: MetricSample[],
  ): TelemetryProvider {
    return {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        {
          stream,
          schemaVersion: "1.0.0",
          available,
          ...(available ? {} : { reason: `${stream} down` }),
        },
      ],
      query: async (s) => (s === stream ? samples : []),
    };
  }

  it("merges to one capability per contract stream, preferring available", () => {
    const c = new CompositeTelemetryProvider([
      one("cron_run", true, []),
      one("hook_exec", false, []),
    ]);
    const caps = c.capabilities();
    // Exactly one entry per declared stream.
    expect(caps).toHaveLength(TELEMETRY_STREAMS.length);
    expect(caps.find((x) => x.stream === "cron_run")!.available).toBe(true);
    expect(caps.find((x) => x.stream === "hook_exec")!.available).toBe(false);
    // A stream no producer claims is reported unavailable with a reason.
    const uncovered = caps.find((x) => x.stream === "agent_dispatch")!;
    expect(uncovered.available).toBe(false);
    expect(uncovered.reason).toMatch(/no producer wired/);
  });

  it("upgrades an unavailable stream to available when a later producer emits it", () => {
    const c = new CompositeTelemetryProvider([
      one("session_cost", false, []),
      one("session_cost", true, []),
    ]);
    expect(c.capabilities().find((x) => x.stream === "session_cost")!.available).toBe(true);
  });

  it("query concatenates across producers (each returns [] for unowned streams)", async () => {
    const sample: MetricSample = { ts: IN, value: 5, labels: {} };
    const c = new CompositeTelemetryProvider([
      one("cron_run", true, [sample]),
      one("hook_exec", true, []),
    ]);
    expect(await c.query("cron_run", RANGE)).toEqual([sample]);
    expect(await c.query("hook_exec", RANGE)).toEqual([]);
  });
});

describe("buildHostTelemetryProvider (real host wiring)", () => {
  it("returns a provider advertising one capability per declared stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-"));
    mkdirSync(join(dir, "hooks"), { recursive: true });
    mkdirSync(join(dir, "projects"), { recursive: true });
    const p = buildHostTelemetryProvider({
      costDbPath: join(dir, "costs.db"),
      hooksDir: join(dir, "hooks"),
      skillAccessLog: join(dir, "skills.jsonl"),
      journalPath: join(dir, "ops.jsonl"),
      modeDispatchLog: join(dir, "mode_dispatch.jsonl"),
      templateFeedbackLog: join(dir, "template_feedback.jsonl"),
      sessionProjectsDir: join(dir, "projects"),
      cronJournalRunner: () => "",
      cronConfigProbe: () => ({ crontab: false, configSnapshot: false }),
    });
    const caps = p.capabilities();
    expect(caps).toHaveLength(TELEMETRY_STREAMS.length);
    // Nothing seeded → every stream degrades to unavailable, each with a reason.
    expect(caps.every((c) => c.available === false && !!c.reason)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SessionJsonlTelemetryProducer", () => {
  let root: string;
  let sessionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sessions-"));
    sessionDir = join(root, "-home-x-proj");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Build a session JSONL fixture: assistant tool_use lines + user tool_result lines. */
  function writeSession(name: string, lines: object[]): void {
    writeFileSync(join(sessionDir, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }

  function assistantToolUse(ts: Date, blocks: object[]): object {
    return {
      type: "assistant",
      timestamp: ts.toISOString(),
      message: { role: "assistant", content: blocks },
    };
  }
  function userToolResult(ts: Date, toolUseId: string, isError: boolean): object {
    return {
      type: "user",
      timestamp: ts.toISOString(),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: "ok", is_error: isError },
        ],
      },
    };
  }

  it("derives tool_call with failure joined from the matching tool_result is_error", async () => {
    writeSession("s.jsonl", [
      assistantToolUse(IN, [
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "tool_use", id: "t2", name: "mcp__busplug__reply", input: {} },
      ]),
      userToolResult(IN, "t1", false),
      userToolResult(IN, "t2", true), // failed MCP call
      // out-of-window line ignored
      assistantToolUse(OUT, [
        { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/x" } },
      ]),
    ]);
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const samples = await p.query("tool_call", RANGE);
    expect(samples).toHaveLength(2);
    const bash = samples.find((s) => s.labels!.tool === "Bash")!;
    expect(bash.value).toBe(0);
    expect(bash.labels!.server).toBe("");
    const mcp = samples.find((s) => s.labels!.tool === "mcp__busplug__reply")!;
    expect(mcp.value).toBe(1); // is_error → failure
    expect(mcp.labels!.server).toBe("busplug");
    expect(p.capabilities().find((c) => c.stream === "tool_call")!.available).toBe(true);
  });

  it("derives agent_dispatch from Agent/Task tool_use, labelled by subagent (value 0)", async () => {
    writeSession("s.jsonl", [
      assistantToolUse(IN, [
        { type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore" } },
        { type: "tool_use", id: "a2", name: "Agent", input: {} }, // no subagent_type → default
        { type: "tool_use", id: "t1", name: "Bash", input: {} }, // not a dispatch
      ]),
    ]);
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const samples = await p.query("agent_dispatch", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.value === 0)).toBe(true);
    expect(samples.map((s) => s.labels!.agent).sort()).toEqual(["Explore", "default"]);
    expect(p.capabilities().find((c) => c.stream === "agent_dispatch")!.available).toBe(true);
  });

  it("derives memory_access only for Reads of memory/CLAUDE.md paths", async () => {
    writeSession("s.jsonl", [
      assistantToolUse(IN, [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/home/x/CLAUDE.md" } },
        {
          type: "tool_use",
          id: "r2",
          name: "Read",
          input: { file_path: "/home/x/memory/a.md" },
        },
        { type: "tool_use", id: "r3", name: "Read", input: { file_path: "/home/x/src/index.ts" } }, // not memory
      ]),
    ]);
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const samples = await p.query("memory_access", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.value === 1)).toBe(true);
    expect(samples.map((s) => s.labels!.file).sort()).toEqual([
      "/home/x/CLAUDE.md",
      "/home/x/memory/a.md",
    ]);
  });

  it("advertises mode_dispatch inactive-with-reason (not in the transcript)", () => {
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const cap = p.capabilities().find((c) => c.stream === "mode_dispatch")!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/orchestration event/);
  });

  it("degrades gracefully (all active streams unavailable+reason) on an empty/absent dir", async () => {
    const empty = new SessionJsonlTelemetryProducer({ projectsDir: root }); // dir exists, no sessions
    const caps = empty.capabilities();
    for (const s of ["tool_call", "agent_dispatch", "memory_access"] as const) {
      const c = caps.find((x) => x.stream === s)!;
      expect(c.available).toBe(false);
      expect(c.reason).toBeTruthy();
    }
    expect(await empty.query("tool_call", RANGE)).toEqual([]);

    const absent = new SessionJsonlTelemetryProducer({ projectsDir: join(root, "nope") });
    expect(await absent.query("tool_call", RANGE)).toEqual([]);
    expect(absent.capabilities().find((c) => c.stream === "tool_call")!.reason).toMatch(
      /projects dir not found/,
    );
  });

  it("returns [] for streams it does not own", async () => {
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    expect(await p.query("cron_run", RANGE)).toEqual([]);
    expect(await p.query("session_cost", RANGE)).toEqual([]);
  });

  it("caps the scan at the newest 200 transcripts (bounded reads) and warns", async () => {
    // 205 in-window sessions, each with one tool_use. The producer must scan at
    // most 200 (newest by mtime) so a busy host can't stall / OOM the sync path.
    const total = 205;
    for (let i = 0; i < total; i++) {
      writeSession(`s${i}.jsonl`, [
        assistantToolUse(IN, [{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }]),
      ]);
    }
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
      const samples = await p.query("tool_call", RANGE);
      expect(samples).toHaveLength(200);
      expect(warnings.some((w) => /scan capped at 200 of 205/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("streams a transcript larger than the read chunk without slurping (all lines parsed)", async () => {
    // >64KB single file spanning many read chunks: padding forces multi-chunk
    // reads, and a multibyte path exercises the chunk-boundary decode. Every
    // in-window tool_use must still be derived (behaviour identical to a slurp).
    const lines: object[] = [];
    const pad = "x".repeat(4096); // bloat each line so the file crosses 64KB
    for (let i = 0; i < 40; i++) {
      lines.push(
        assistantToolUse(IN, [
          { type: "tool_use", id: `b${i}`, name: "Bash", input: { note: pad } },
          {
            type: "tool_use",
            id: `m${i}`,
            name: "Read",
            input: { file_path: `/home/x/mémoire/${i}/CLAUDE.md` },
          },
        ]),
      );
    }
    writeSession("big.jsonl", lines);
    const p = new SessionJsonlTelemetryProducer({ projectsDir: root });
    const calls = await p.query("tool_call", RANGE);
    expect(calls).toHaveLength(80); // 40 Bash + 40 Read
    const mem = await p.query("memory_access", RANGE);
    expect(mem).toHaveLength(40);
    // Multibyte path survived the chunk-boundary decode intact.
    expect(mem.every((s) => s.labels!.file.includes("mémoire"))).toBe(true);
  });
});

describe("buildHostTelemetryProvider — extraProducers (operator extension point)", () => {
  // A minimal operator-supplied producer advertising its OWN (custom-namespaced)
  // stream — the third-party instrumentation path this PR unlocks.
  class CustomDemoProducer implements TelemetryProvider {
    contractVersion(): string {
      return "1.0.0";
    }
    capabilities() {
      return [
        { stream: "custom.demo" as TelemetryStream, schemaVersion: "1.0.0", available: true },
      ];
    }
    async query(stream: TelemetryStream, _range: DateRange): Promise<MetricSample[]> {
      if (stream !== "custom.demo") return [];
      return [{ ts: new Date(NOW_MS), value: 42, labels: { source: "demo" } }];
    }
  }

  it("composes an operator producer advertising a CUSTOM stream", async () => {
    const provider = buildHostTelemetryProvider({ extraProducers: [new CustomDemoProducer()] });
    const demo = provider.capabilities().find((c) => c.stream === "custom.demo");
    expect(demo?.available).toBe(true);
    const samples = await provider.query("custom.demo" as TelemetryStream, RANGE);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(42);
  });

  it("still advertises every built-in stream (no regression)", () => {
    const provider = buildHostTelemetryProvider({ extraProducers: [new CustomDemoProducer()] });
    const streams = new Set(provider.capabilities().map((c) => c.stream));
    for (const s of TELEMETRY_STREAMS) expect(streams.has(s)).toBe(true);
  });

  it("an available operator producer upgrades a built-in stream that shipped unavailable", async () => {
    class UpgradeProducer implements TelemetryProvider {
      contractVersion(): string {
        return "1.0.0";
      }
      capabilities() {
        return [
          { stream: "memory_signal" as TelemetryStream, schemaVersion: "1.0.0", available: true },
        ];
      }
      async query(): Promise<MetricSample[]> {
        return [];
      }
    }
    // Without `memorySignalHistoryPath` the built-in memory_signal ships unavailable;
    // the operator producer (composed last) upgrades it via the available-wins merge.
    const provider = buildHostTelemetryProvider({ extraProducers: [new UpgradeProducer()] });
    const cap = provider.capabilities().find((c) => c.stream === "memory_signal");
    expect(cap?.available).toBe(true);
  });

  it("omitting extraProducers is a no-op (back-compat)", () => {
    const before = buildHostTelemetryProvider({}).capabilities().length;
    const after = buildHostTelemetryProvider({ extraProducers: [] }).capabilities().length;
    expect(after).toBe(before);
  });
});

describe("CompositeTelemetryProvider — double-served stream guard (#319 review)", () => {
  // A producer that owns exactly one stream at a fixed availability, optionally
  // returning one sample for it — lets us stage the contested-available case
  // deterministically (no built-in probe/fs flakiness).
  class FixedProducer implements TelemetryProvider {
    constructor(
      private readonly stream: string,
      private readonly available: boolean,
      private readonly sample?: MetricSample,
    ) {}
    contractVersion(): string {
      return "1.0.0";
    }
    capabilities() {
      return [
        {
          stream: this.stream as TelemetryStream,
          schemaVersion: "1.0.0",
          available: this.available,
        },
      ];
    }
    async query(stream: TelemetryStream): Promise<MetricSample[]> {
      return stream === this.stream && this.sample ? [this.sample] : [];
    }
  }

  function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = orig;
    }
  }

  it("two producers serving the same stream available → one capability, warns once, query still doubles", async () => {
    const composite = new CompositeTelemetryProvider([
      new FixedProducer("tool_call", true, { ts: new Date(NOW_MS), value: 1 }),
      new FixedProducer("tool_call", true, { ts: new Date(NOW_MS), value: 2 }),
    ]);

    const { result: caps, warnings } = captureWarn(() => {
      const first = composite.capabilities();
      composite.capabilities(); // second call must NOT re-warn (once per instance)
      return first;
    });

    // The manifest keeps ONE entry (the first producer); the second is hidden.
    expect(caps.filter((c) => c.stream === "tool_call")).toHaveLength(1);
    // Guard fired exactly once despite two capabilities() calls.
    expect(warnings.filter((w) => w.includes("tool_call"))).toHaveLength(1);

    // But query() concatenates — the guard warns, it does NOT dedupe. This pins
    // the double-count so a future "silent dedupe" refactor is a conscious choice.
    const samples = await composite.query("tool_call" as TelemetryStream, RANGE);
    expect(samples).toHaveLength(2);
  });

  it("upgrading an UNAVAILABLE built-in does not trip the guard", () => {
    class UpgradeProducer implements TelemetryProvider {
      contractVersion(): string {
        return "1.0.0";
      }
      capabilities() {
        return [
          { stream: "memory_signal" as TelemetryStream, schemaVersion: "1.0.0", available: true },
        ];
      }
      async query(): Promise<MetricSample[]> {
        return [];
      }
    }
    // No memorySignalHistoryPath → the built-in memory_signal ships unavailable,
    // so the operator producer legitimately upgrades it — not a conflict.
    const { result: provider, warnings } = captureWarn(() =>
      buildHostTelemetryProvider({ extraProducers: [new UpgradeProducer()] }),
    );
    const cap = provider.capabilities().find((c) => c.stream === "memory_signal");
    expect(cap?.available).toBe(true);
    expect(warnings.filter((w) => w.includes("memory_signal"))).toHaveLength(0);
  });

  it("a disjoint custom stream never leaks into a built-in stream's query()", async () => {
    class CustomProducer implements TelemetryProvider {
      contractVersion(): string {
        return "1.0.0";
      }
      capabilities() {
        return [
          { stream: "custom.demo" as TelemetryStream, schemaVersion: "1.0.0", available: true },
        ];
      }
      async query(stream: TelemetryStream): Promise<MetricSample[]> {
        return stream === "custom.demo" ? [{ ts: new Date(NOW_MS), value: 7 }] : [];
      }
    }
    const provider = buildHostTelemetryProvider({ extraProducers: [new CustomProducer()] });
    const toolCall = await provider.query("tool_call" as TelemetryStream, RANGE);
    expect(toolCall.every((s) => s.value !== 7)).toBe(true);
  });
});
