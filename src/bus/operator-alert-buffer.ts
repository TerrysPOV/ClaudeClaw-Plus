/**
 * Bounded ring of recent `system.operator_alert` events for the web dashboard.
 *
 * operator_alerts (stall watchdog false-positive flags, restart failures, …)
 * are delivered live to the chat adapters (Slack/Discord/Telegram) but the web
 * UI has no server→client push — only polled `/api/state`. So instead of a
 * stream, the daemon keeps the last N alerts here and the dashboard reads them
 * on its normal poll (#325). Subscribe once across ALL agents; the panel reads
 * `recent()`.
 *
 * Volume, not disclosure: the producer already caps each alert's text
 * (`MAX_ALERT_CHARS`) and the full copy lives in the daemon log — this only
 * bounds how many alerts the polled surface remembers.
 */
import type { BusCore, Subscription } from "./core";
import type { BusEvent } from "./types";
import { OPERATOR_ALERT_TOPIC, type OperatorAlertPayload } from "./stall-alert-delivery";

export interface OperatorAlertRecord {
  /** Event timestamp (ms). */
  ts: number;
  agentId: string;
  level: "warn" | "critical";
  text: string;
  /** Producer id (e.g. `stall-watchdog`), best-effort. */
  source: string;
}

/** Default retained-alert cap. ~25 × ≤600 chars ≈ 15 kB worst case. */
export const DEFAULT_MAX_OPERATOR_ALERTS = 25;

export class OperatorAlertBuffer {
  private readonly ring: OperatorAlertRecord[] = [];
  private sub: Subscription | null = null;

  constructor(private readonly max: number = DEFAULT_MAX_OPERATOR_ALERTS) {}

  /** Subscribe to operator_alert across every agent. Idempotent. */
  attach(bus: BusCore): void {
    if (this.sub) return;
    this.sub = bus.subscribe({ topics: [OPERATOR_ALERT_TOPIC] }, (e) => this.ingest(e));
  }

  /** Record one alert. Exposed for deterministic tests. A payload with no
   *  usable `text` is dropped (nothing to show). */
  ingest(event: BusEvent): void {
    const p = event.payload as Partial<OperatorAlertPayload> | undefined;
    const text = typeof p?.text === "string" ? p.text : "";
    if (!text) return;
    this.ring.push({
      ts: event.ts,
      agentId: event.agent_id,
      level: p?.level === "critical" ? "critical" : "warn",
      text,
      source: typeof p?.source === "string" ? p.source : "",
    });
    // Evict oldest-first past the cap.
    if (this.ring.length > this.max) this.ring.splice(0, this.ring.length - this.max);
  }

  /** Retained alerts, oldest-first (newest last). Copy — callers can't mutate. */
  recent(): OperatorAlertRecord[] {
    return [...this.ring];
  }

  detach(): void {
    this.sub?.close();
    this.sub = null;
  }
}
