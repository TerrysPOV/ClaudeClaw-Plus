import type { Settings } from "../config";
import type { Job } from "../jobs";
export type { AgentStreamEvent } from "../runner";

export interface WebSnapshot {
  pid: number;
  startedAt: number;
  heartbeatNextAt: number;
  settings: Settings;
  jobs: Job[];
}

export interface WebServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

export interface StartWebUiOptions {
  host: string;
  port: number;
  /**
   * The persisted 256-bit web token (issue #164). All `/api/*` routes
   * require it via `Authorization: Bearer <token>` or `?token=<token>`,
   * except `/api/health` (pre-auth) and `/api/inject` (which also accepts
   * the legacy `settings.apiToken`). Minted by `getOrCreateWebToken()` in
   * `start.ts` before the server boots.
   */
  token: string;
  getSnapshot: () => WebSnapshot;
  onHeartbeatEnabledChanged?: (enabled: boolean) => void | Promise<void>;
  onHeartbeatSettingsChanged?: (patch: {
    enabled?: boolean;
    interval?: number;
    prompt?: string;
    excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
  }) => void | Promise<void>;
  onJobsChanged?: () => void | Promise<void>;
  onChat?: (
    message: string,
    onChunk: (text: string) => void,
    onUnblock: () => void,
    onAgentEvent: (ev: import("../runner").AgentStreamEvent) => void,
  ) => Promise<void>;
  /**
   * Present when the daemon is running in bus mode. Routes that trigger
   * claude (`/api/jobs/fire`, `/api/inject`) call `sendPromptAndAwait`
   * instead of spawning a PTY claude directly; without this option the
   * routes fall back to the legacy `runUserMessage` / `fireJob` paths.
   *
   * The interface is intentionally callback-shaped so `server.ts`
   * doesn't depend on `BusCore` — `start.ts` owns the bus wiring.
   *
   * The chat SSE route (`/api/chat`) continues to use `onChat`;
   * `start.ts` switches its implementation between bus and PTY when
   * wiring that callback.
   */
  bus?: BusWebUiBridge;
}

/**
 * Bridge contract between the legacy webui and the bus runtime. See
 * `StartWebUiOptions.bus`.
 */
export interface BusWebUiBridge {
  /**
   * Send a one-shot prompt to an agent and resolve with the final
   * reply. Used by `/api/jobs/fire` and `/api/inject`. Shape mirrors
   * the legacy `runUserMessage` result so the response JSON the
   * dashboard already renders doesn't change.
   */
  sendPromptAndAwait: (
    agentId: string,
    text: string,
    opts?: { timeoutMs?: number; origin?: string; originId?: string },
  ) => Promise<BusWebUiPromptResult>;
  /**
   * Default agent id used when the route has no agent in the request
   * (e.g. `/api/inject`). Resolved from `settings.agents[0].id` at
   * daemon boot.
   */
  defaultAgentId: string;
  /**
   * #315: ids of agents with an in-flight turn, for the pre-auth `/api/health`
   * busy signal. Lets an external restart guard drain-then-restart instead of
   * killing a turn mid-flight. Bus-derived, so absent in legacy (non-bus) mode
   * → the health field is simply omitted.
   */
  activeTurnAgents: () => string[];
  /**
   * #325: recent out-of-band operator alerts (stall watchdog, restart-failed,
   * …), newest last, for the polled `/api/state` dashboard panel — the web UI
   * has no server→client push, so it reads them on its normal poll. Optional /
   * bus-derived: absent in legacy (non-bus) mode → the dashboard shows no
   * alerts panel.
   */
  recentOperatorAlerts?: () => OperatorAlertView[];
}

/** One entry of the `/api/state` operator-alerts panel (#325). */
export interface OperatorAlertView {
  ts: number;
  agentId: string;
  level: "warn" | "critical";
  text: string;
  source: string;
}

export interface BusWebUiPromptResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
}
