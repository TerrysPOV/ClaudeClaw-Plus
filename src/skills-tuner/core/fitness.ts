/**
 * OutcomeLoop fitness activation gate (Phase 1, observation-only).
 *
 * At registration the loop intersects each subject's declared `fitnessSignals()`
 * sources with the host's `TelemetryProvider.capabilities()`:
 *   - artifact (Tier 1b) metrics ALWAYS activate (static scan, no stream).
 *   - stream (Tier 1) metrics activate ONLY if the host advertises an available,
 *     schema-compatible stream; otherwise they degrade to proposal-only and are
 *     logged `fitness_inactive(reason)`.
 *
 * Every activation decision is written to the audit log — the certifier reviews
 * one contract + one provider + one ledger, never N subject adapters.
 */

import type { TunableSubject } from "./interfaces.js";
import type {
  Metric,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
} from "./telemetry.js";
import { ARTIFACT_SOURCE, TELEMETRY_CONTRACT_VERSION } from "./telemetry.js";
import type { AuditLog } from "./audit-log.js";

export interface ActiveMetric {
  subject: string;
  metric: Metric;
}

export interface InactiveMetric {
  subject: string;
  metric: Metric;
  reason: string;
}

export interface ActivationResult {
  active: ActiveMetric[];
  inactive: InactiveMetric[];
}

/** Why a stream-based metric could not activate, or `null` if it can. */
function streamInactiveReason(
  metric: Metric,
  caps: Map<TelemetryStream, TelemetryCapability>,
): string | null {
  const cap = caps.get(metric.source as TelemetryStream);
  if (!cap) return `host does not advertise stream '${metric.source}'`;
  if (!cap.available) {
    return cap.reason
      ? `stream '${metric.source}' unavailable: ${cap.reason}`
      : `stream '${metric.source}' advertised but not available`;
  }
  return null;
}

/**
 * Decide whether a single metric is active against a provider's capabilities.
 * Artifact (Tier 1b) → always active. Judge/proxy (Tier 2) → never in Phase 1.
 * Stream (Tier 1) → active iff the host advertises an available stream.
 */
export function isMetricActive(
  metric: Metric,
  provider: TelemetryProvider,
): { active: boolean; reason?: string } {
  if (metric.kind === "judge" || metric.kind === "proxy_state") {
    return { active: false, reason: "judge/proxy metric deferred past Phase 1" };
  }
  if (metric.source === ARTIFACT_SOURCE) return { active: true };
  const caps = new Map<TelemetryStream, TelemetryCapability>();
  for (const c of provider.capabilities()) caps.set(c.stream, c);
  const reason = streamInactiveReason(metric, caps);
  return reason ? { active: false, reason } : { active: true };
}

/**
 * Run the activation gate over `subjects` against `provider`, writing
 * `fitness_active` / `fitness_inactive` records to `audit`. Pure decision
 * logic — does not measure anything. Judge-kind (Tier 2) metrics never
 * activate in Phase 1 regardless of telemetry (deferred, gated).
 */
export function activateFitness(
  subjects: readonly TunableSubject[],
  provider: TelemetryProvider,
  audit: AuditLog,
): ActivationResult {
  const caps = new Map<TelemetryStream, TelemetryCapability>();
  for (const c of provider.capabilities()) caps.set(c.stream, c);

  const result: ActivationResult = { active: [], inactive: [] };

  for (const subject of subjects) {
    for (const metric of subject.fitnessSignals()) {
      // Tier 2 judge metrics are deferred past Phase 1 — never auto-activate.
      if (metric.kind === "judge" || metric.kind === "proxy_state") {
        result.inactive.push({
          subject: subject.name,
          metric,
          reason: "judge/proxy metric deferred past Phase 1",
        });
        audit.append({
          event: "fitness_inactive",
          subject: subject.name,
          metric: metric.name,
          detail: {
            source: metric.source,
            kind: metric.kind,
            reason: "judge/proxy deferred (Phase 1)",
          },
        });
        continue;
      }

      if (metric.source === ARTIFACT_SOURCE) {
        result.active.push({ subject: subject.name, metric });
        audit.append({
          event: "fitness_active",
          subject: subject.name,
          metric: metric.name,
          detail: { source: ARTIFACT_SOURCE, tier: "1b", windowDays: metric.windowDays },
        });
        continue;
      }

      const reason = streamInactiveReason(metric, caps);
      if (reason) {
        result.inactive.push({ subject: subject.name, metric, reason });
        audit.append({
          event: "fitness_inactive",
          subject: subject.name,
          metric: metric.name,
          detail: { source: metric.source, reason },
        });
      } else {
        result.active.push({ subject: subject.name, metric });
        audit.append({
          event: "fitness_active",
          subject: subject.name,
          metric: metric.name,
          detail: {
            source: metric.source,
            tier: "1",
            schemaVersion: caps.get(metric.source as TelemetryStream)?.schemaVersion,
            windowDays: metric.windowDays,
          },
        });
      }
    }
  }
  return result;
}

/**
 * FOLD: bridge the legacy per-subject `healthCheck()` producer-probes into the
 * single `TelemetryProvider.capabilities()` surface. A reference host (e.g.
 * a self-hosted agent) that has not yet implemented native stream emitters can
 * still advertise capabilities derived from what each subject's healthCheck
 * found — `producer_found=false` → `available=false` with the probe's reason.
 *
 * `subjectStream` maps a subject name to the stream its healthCheck probes
 * (cron→cron_run, hook→hook_exec, …). Subjects without a healthCheck or a
 * mapping contribute nothing. This is the migration path off healthCheck:
 * capabilities() is canonical; healthCheck remains the boot diagnostic.
 */
export async function deriveCapabilitiesFromHealthChecks(
  subjects: readonly TunableSubject[],
  subjectStream: Partial<Record<string, TelemetryStream>>,
  schemaVersion = TELEMETRY_CONTRACT_VERSION,
): Promise<TelemetryCapability[]> {
  const caps: TelemetryCapability[] = [];
  for (const subject of subjects) {
    const stream = subjectStream[subject.name];
    if (!stream) continue;
    const fn = (
      subject as TunableSubject & {
        healthCheck?: () => Promise<{
          producer_found: boolean;
          sample_event_match_rate: number;
          reason?: string;
        }>;
      }
    ).healthCheck;
    if (typeof fn !== "function") continue;
    try {
      const r = await fn.call(subject);
      caps.push({
        stream,
        schemaVersion,
        available: r.producer_found,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    } catch (e) {
      caps.push({
        stream,
        schemaVersion,
        available: false,
        reason: `healthCheck threw: ${(e as Error).message.slice(0, 120)}`,
      });
    }
  }
  return caps;
}
