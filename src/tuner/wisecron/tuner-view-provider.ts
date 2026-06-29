/**
 * The tuner DECLARES its own observability page — the hub does not hardcode it.
 *
 * This is the first specialized page: a `timeline` of applied tuning proposals
 * mapped to their measured outcomes (subject → {change, delta, verdict, branch,
 * commit, ts}), sourced from the EXISTING surfaces — the proposals ledger
 * (`proposals.jsonl`) joined to the outcomes table (wisecron.db) and the
 * hash-chained audit trail. It implements only the view side of the telemetry
 * contract (`viewManifest`/`viewData`); it advertises no streams.
 */

import {
  type DateRange,
  type MetricSample,
  type PanelData,
  type TelemetryCapability,
  TELEMETRY_CONTRACT_VERSION,
  type TelemetryProvider,
  type TelemetryStream,
  type ViewManifest,
} from "../../skills-tuner/core/telemetry.js";
import type { ProposalsStore } from "../../skills-tuner/storage/proposals.js";
import type { OutcomeRow } from "./state-db.js";

export const TUNER_PLUGIN = "tuner";
export const TUNER_TIMELINE_PANEL = "tuner.timeline";

export interface TunerViewSources {
  /** The applied/created/refused proposal ledger. */
  proposals: ProposalsStore;
  /** Outcome rows for a proposal_id — bind `WisecronStateDB.getOutcomes`. */
  outcomesFor: (proposalId: string) => OutcomeRow[];
}

export class TunerViewProvider implements TelemetryProvider {
  constructor(private readonly sources: TunerViewSources) {}

  contractVersion(): string {
    return TELEMETRY_CONTRACT_VERSION;
  }

  /** No streams — this provider is view-only. */
  capabilities(): TelemetryCapability[] {
    return [];
  }

  // View-only provider: it serves panels (getView), not metric streams, but
  // implements the full TelemetryProvider contract so it composes uniformly.
  // query() therefore matches the interface signature and returns no samples.
  async query(
    _stream: TelemetryStream,
    _range: DateRange,
    _filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    return [];
  }

  viewManifest(): ViewManifest {
    return {
      plugin: TUNER_PLUGIN,
      schemaVersion: "1.0.0",
      metrics: [
        {
          name: "applied_proposals",
          unit: "count",
          direction: "neutral",
          description: "Tuning changes applied in the window",
        },
        {
          name: "improved_rate",
          unit: "ratio",
          direction: "up_good",
          description: "Share of matured outcomes judged 'improved'",
        },
      ],
      panels: [
        {
          id: TUNER_TIMELINE_PANEL,
          kind: "timeline",
          title: "Tuning proposals → outcomes",
          columns: ["ts", "subject", "change", "delta", "verdict", "branch", "commit"],
        },
      ],
    };
  }

  async viewData(panelId: string, range: DateRange): Promise<PanelData | undefined> {
    if (panelId !== TUNER_TIMELINE_PANEL) return undefined;

    const rows: Array<Record<string, unknown>> = [];
    for (const rec of this.sources.proposals.readAll()) {
      if (rec.event !== "applied") continue;
      const ts = new Date(rec.ts);
      if (Number.isNaN(ts.getTime())) continue;
      if (ts < range.start || ts >= range.end) continue;

      const id = String(rec.proposal.id);
      const outcomes = this.sources.outcomesFor(id);
      // Prefer a matured outcome (non-null verdict); else the first row so the
      // timeline still shows the pending change with delta/verdict blank.
      const outcome = outcomes.find((o) => o.verdict !== null) ?? outcomes[0];

      rows.push({
        ts: rec.ts,
        subject: rec.proposal.subject,
        change: `${rec.proposal.kind}: ${rec.applied_target_path ?? rec.proposal.target_path}`,
        delta: outcome?.delta ?? null,
        verdict: outcome?.verdict ?? null,
        branch: `tune/proposal-${rec.proposal.id}`,
        commit: rec.commit_sha ?? outcome?.commit_sha ?? null,
      });
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { panelId, rows };
  }
}
