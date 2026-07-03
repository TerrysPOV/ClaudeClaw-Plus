import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalsStore } from "../../../skills-tuner/storage/proposals.js";
import type { OutcomeRow } from "../../wisecron/state-db.js";
import {
  TUNER_PLUGIN,
  TUNER_TIMELINE_PANEL,
  TunerViewProvider,
} from "../../wisecron/tuner-view-provider.js";

const RANGE = {
  start: new Date("2026-05-01T00:00:00.000Z"),
  end: new Date("2026-06-01T00:00:00.000Z"),
};

function proposalLine(over: {
  id: number;
  subject: string;
  kind: string;
  target_path: string;
  event: "created" | "applied" | "refused";
  ts: string;
  commit_sha?: string;
}): string {
  return JSON.stringify({
    proposal: {
      id: over.id,
      cluster_id: `c${over.id}`,
      subject: over.subject,
      kind: over.kind,
      target_path: over.target_path,
      alternatives: [{ id: "alt-1", diff_or_content: "..." }],
      pattern_signature: `sig${over.id}`,
      created_at: over.ts,
      signature: "sig",
    },
    event: over.event,
    ts: over.ts,
    ...(over.commit_sha ? { commit_sha: over.commit_sha } : {}),
  });
}

function outcome(over: Partial<OutcomeRow> & { proposal_id: string }): OutcomeRow {
  return {
    metric: "cron_cost",
    commit_sha: "abc123",
    subject: "cron",
    baseline: 100,
    post: 80,
    delta: -20,
    window_start: "2026-05-01T00:00:00.000Z",
    window_end: "2026-05-08T00:00:00.000Z",
    verdict: "improved",
    ...over,
  };
}

describe("TunerViewProvider", () => {
  let dir: string;
  let proposalsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tuner-view-"));
    proposalsPath = join(dir, "proposals.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("declares a timeline manifest for the tuner plugin", () => {
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: () => [],
    });
    const m = p.viewManifest();
    expect(m.plugin).toBe(TUNER_PLUGIN);
    expect(m.panels).toHaveLength(1);
    expect(m.panels[0]?.kind).toBe("timeline");
    expect(m.panels[0]?.id).toBe(TUNER_TIMELINE_PANEL);
    expect(m.panels[0]?.columns).toEqual([
      "ts",
      "subject",
      "change",
      "delta",
      "verdict",
      "branch",
      "commit",
    ]);
    // view-only: advertises no telemetry streams.
    expect(p.capabilities()).toEqual([]);
  });

  it("builds timeline rows from applied proposals joined to their outcomes", async () => {
    writeFileSync(
      proposalsPath,
      [
        proposalLine({
          id: 7,
          subject: "cron",
          kind: "patch",
          target_path: "~/.config/cron.yaml",
          event: "applied",
          ts: "2026-05-10T12:00:00.000Z",
          commit_sha: "cafe01",
        }),
        // a 'created' (not applied) row must be ignored
        proposalLine({
          id: 8,
          subject: "hook",
          kind: "patch",
          target_path: "x",
          event: "created",
          ts: "2026-05-11T12:00:00.000Z",
        }),
      ].join("\n"),
    );
    const outcomesByProposal: Record<string, OutcomeRow[]> = {
      "7": [outcome({ proposal_id: "7", delta: -20, verdict: "improved" })],
    };
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: (id) => outcomesByProposal[id] ?? [],
    });

    const data = await p.viewData(TUNER_TIMELINE_PANEL, RANGE);
    expect(data?.panelId).toBe(TUNER_TIMELINE_PANEL);
    expect(data?.rows).toHaveLength(1);
    expect(data?.rows[0]).toMatchObject({
      subject: "cron",
      change: "patch: ~/.config/cron.yaml",
      delta: -20,
      verdict: "improved",
      branch: "tune/proposal-7",
      commit: "cafe01",
    });
  });

  it("surfaces the decisive verdict, not the alphabetically-first matured guardrail", async () => {
    writeFileSync(
      proposalsPath,
      proposalLine({
        id: 11,
        subject: "model_routing",
        kind: "patch",
        target_path: "p",
        event: "applied",
        ts: "2026-05-13T12:00:00.000Z",
        commit_sha: "dec01",
      }),
    );
    // Ordered by metric ASC: a neutral guardrail ("cost_guard") sorts before the
    // target ("latency") that actually regressed. The panel must show the target.
    const rows: OutcomeRow[] = [
      outcome({ proposal_id: "11", metric: "cost_guard", delta: 0, verdict: "neutral" }),
      outcome({ proposal_id: "11", metric: "latency", delta: 42, verdict: "regressed" }),
    ];
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: () => rows,
    });
    const data = await p.viewData(TUNER_TIMELINE_PANEL, RANGE);
    expect(data?.rows[0]).toMatchObject({ verdict: "regressed", delta: 42 });
  });

  it("shows an applied proposal with blank delta/verdict when no outcome matured yet", async () => {
    writeFileSync(
      proposalsPath,
      proposalLine({
        id: 9,
        subject: "model_routing",
        kind: "patch",
        target_path: "p",
        event: "applied",
        ts: "2026-05-12T12:00:00.000Z",
        commit_sha: "beef02",
      }),
    );
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: () => [],
    });
    const data = await p.viewData(TUNER_TIMELINE_PANEL, RANGE);
    expect(data?.rows).toHaveLength(1);
    expect(data?.rows[0]).toMatchObject({ delta: null, verdict: null, branch: "tune/proposal-9" });
  });

  it("excludes applied proposals outside the window", async () => {
    writeFileSync(
      proposalsPath,
      proposalLine({
        id: 10,
        subject: "cron",
        kind: "patch",
        target_path: "p",
        event: "applied",
        ts: "2025-01-01T00:00:00.000Z",
        commit_sha: "old",
      }),
    );
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: () => [],
    });
    const data = await p.viewData(TUNER_TIMELINE_PANEL, RANGE);
    expect(data?.rows).toEqual([]);
  });

  it("returns undefined for an unknown panel id", async () => {
    const p = new TunerViewProvider({
      proposals: new ProposalsStore(proposalsPath),
      outcomesFor: () => [],
    });
    expect(await p.viewData("nope", RANGE)).toBeUndefined();
  });
});
