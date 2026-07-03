import { describe, it, expect } from "bun:test";
import type {
  DateRange,
  MetricSample,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
} from "../telemetry.js";
import {
  AGENT_SESSION_DIRS_FILTER_KEY,
  type AgentSurface,
  DEFAULT_SCOPE,
  PREDICATE_STREAMS,
  SCOPE_ACK_LABEL,
  SCOPE_FILTER_KEY,
  SOURCE_SCOPED_STREAMS,
  ScopedTelemetryProvider,
  defaultAgentSurface,
  resolveScope,
  sampleInAgentScope,
} from "../scope.js";

const RANGE: DateRange = {
  start: new Date("2026-05-01T00:00:00.000Z"),
  end: new Date("2026-05-31T00:00:00.000Z"),
};

/** Fixed agent surface rooted at /home/simon/agent (matches defaultAgentSurface). */
const SURFACE: AgentSurface = defaultAgentSurface("/home/simon");

function s(labels: Record<string, string>, value = 1): MetricSample {
  return { ts: new Date("2026-05-10T00:00:00.000Z"), value, labels };
}

/** Inner provider that records the filters it received and returns fixed samples. */
class FakeProvider implements TelemetryProvider {
  lastFilters?: Record<string, string>;
  constructor(private readonly samples: MetricSample[]) {}
  contractVersion(): string {
    return "1.1.0";
  }
  capabilities(): TelemetryCapability[] {
    return [];
  }
  async query(
    _stream: TelemetryStream,
    _range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    this.lastFilters = filters;
    return this.samples;
  }
}

describe("resolveScope precedence", () => {
  it("per-subject > global > default", () => {
    expect(resolveScope("all", "agent")).toBe("agent");
    expect(resolveScope("agent", undefined)).toBe("agent");
    expect(resolveScope(undefined, undefined)).toBe(DEFAULT_SCOPE);
  });
});

describe("defaultAgentSurface", () => {
  it('does NOT carry the generic source="cron" marker (fix #1)', () => {
    // A generic cron tag would attribute the whole cron/cost stream to the agent.
    expect(SURFACE.jobMarkers).not.toContain('source="cron"');
    // Only agent-specific markers remain.
    expect(SURFACE.jobMarkers).toEqual(["bus-scheduler", "/home/simon/agent"]);
  });
});

describe("sampleInAgentScope — cron/cost attribution (fix #1)", () => {
  for (const stream of ["cron_run", "session_cost"] as const) {
    it(`${stream}: generic cron row is NOT attributed to the agent`, () => {
      // Carries the generic tag every cron row has, but no agent-specific marker.
      const generic = s({ job: '<channel source="cron" chat_id="telegram:123">', model: "opus" });
      expect(sampleInAgentScope(stream, generic, SURFACE)).toBe(false);
    });

    it(`${stream}: bus-scheduler row IS attributed`, () => {
      const agentJob = s({ job: '<channel source="cron" chat_id="bus-scheduler:abc">' });
      expect(sampleInAgentScope(stream, agentJob, SURFACE)).toBe(true);
    });

    it(`${stream}: a unit anchored under the agent root IS attributed`, () => {
      const byUnit = s({ unit: "/home/simon/agent/jobs/nightly.service" });
      expect(sampleInAgentScope(stream, byUnit, SURFACE)).toBe(true);
    });

    it(`${stream}: empty markers never match everything`, () => {
      const surfaceWithEmpty: AgentSurface = { ...SURFACE, jobMarkers: [""] };
      expect(sampleInAgentScope(stream, s({ job: "anything" }), surfaceWithEmpty)).toBe(false);
    });
  }
});

describe("sampleInAgentScope — memory_access root boundary (fix #3)", () => {
  it("keeps a file under the agent root", () => {
    expect(
      sampleInAgentScope("memory_access", s({ file: "/home/simon/agent/memory/x.md" }), SURFACE),
    ).toBe(true);
  });

  it("keeps the root path itself", () => {
    expect(sampleInAgentScope("memory_access", s({ file: "/home/simon/agent" }), SURFACE)).toBe(
      true,
    );
  });

  it("does NOT match the agent-backup sibling directory", () => {
    // /home/simon/agent must not prefix-match /home/simon/agent-backup/...
    expect(
      sampleInAgentScope(
        "memory_access",
        s({ file: "/home/simon/agent-backup/secrets.md" }),
        SURFACE,
      ),
    ).toBe(false);
  });

  it("drops a sample with no file label", () => {
    expect(sampleInAgentScope("memory_access", s({}), SURFACE)).toBe(false);
  });
});

describe("sampleInAgentScope — fail closed for non-predicate streams (fix #2)", () => {
  const nonPredicate: TelemetryStream[] = [
    "hook_exec",
    "skill_access",
    "template_feedback",
    "mode_dispatch",
    "mcp.tool_call",
  ];
  for (const stream of nonPredicate) {
    it(`${stream}: dropped (no attribution, no ack)`, () => {
      expect(sampleInAgentScope(stream, s({ some: "label" }), SURFACE)).toBe(false);
    });
    it(`${stream}: kept when the producer stamps the explicit ack`, () => {
      expect(sampleInAgentScope(stream, s({ [SCOPE_ACK_LABEL]: "agent" }), SURFACE)).toBe(true);
    });
  }

  it("a wrong ack value does not pass", () => {
    expect(sampleInAgentScope("mode_dispatch", s({ [SCOPE_ACK_LABEL]: "all" }), SURFACE)).toBe(
      false,
    );
  });

  it("source-scoped streams (tool_call, agent_dispatch) are kept (narrowed upstream)", () => {
    for (const stream of SOURCE_SCOPED_STREAMS) {
      expect(sampleInAgentScope(stream, s({}), SURFACE)).toBe(true);
    }
  });

  it("allowlists are disjoint and cover the intended streams", () => {
    for (const stream of PREDICATE_STREAMS) {
      expect(SOURCE_SCOPED_STREAMS.has(stream)).toBe(false);
    }
    expect([...PREDICATE_STREAMS].sort()).toEqual(["cron_run", "memory_access", "session_cost"]);
  });
});

describe("ScopedTelemetryProvider", () => {
  it("all scope is a pure pass-through (no filters injected, no drops)", async () => {
    const inner = new FakeProvider([s({ some: "x" })]);
    const p = new ScopedTelemetryProvider(inner, "all", SURFACE);
    const out = await p.query("mode_dispatch", RANGE);
    expect(out).toHaveLength(1);
    expect(inner.lastFilters).toBeUndefined();
  });

  it("agent scope injects scope hints into the inner query", async () => {
    const inner = new FakeProvider([]);
    const p = new ScopedTelemetryProvider(inner, "agent", SURFACE);
    await p.query("tool_call", RANGE, { existing: "keep" });
    expect(inner.lastFilters?.[SCOPE_FILTER_KEY]).toBe("agent");
    expect(inner.lastFilters?.[AGENT_SESSION_DIRS_FILTER_KEY]).toBe(
      SURFACE.sessionProjectDirs.join(","),
    );
    expect(inner.lastFilters?.existing).toBe("keep");
  });

  it("agent scope drops generic cron rows but keeps agent ones", async () => {
    const inner = new FakeProvider([
      s({ job: '<channel source="cron" chat_id="telegram:1">' }), // generic → dropped
      s({ job: '<channel source="cron" chat_id="bus-scheduler:2">' }), // agent → kept
    ]);
    const p = new ScopedTelemetryProvider(inner, "agent", SURFACE);
    const out = await p.query("cron_run", RANGE);
    expect(out).toHaveLength(1);
    expect(out[0]?.labels?.job).toContain("bus-scheduler");
  });

  it("agent scope fails closed on a non-predicate stream whose producer ignores the hint", async () => {
    // Producer returns rows without honouring __scope / without an ack → all dropped.
    const inner = new FakeProvider([s({ mode: "agentic" }), s({ mode: "plan" })]);
    const p = new ScopedTelemetryProvider(inner, "agent", SURFACE);
    const out = await p.query("mode_dispatch", RANGE);
    expect(out).toHaveLength(0);
  });
});
