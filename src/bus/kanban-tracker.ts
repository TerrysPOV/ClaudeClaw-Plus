/**
 * Kanban Tracker — turns subagent (Task/Agent) lifecycle into live board cards.
 *
 * The Web UI's Kanban board (`src/ui/services/kanban.ts`) shipped with working
 * `addCardToColumn` / `moveCard` mutators but ZERO callers — a static scratchpad,
 * not a view of anything the daemon does (#294). This subscriber wires those
 * mutators to the bus event stream so the board becomes a LIVE view of subagent
 * activity:
 *
 *   - a subagent dispatch (`response.tool_use`, name `Agent`/`Task`) → a card in
 *     `in_progress`,
 *   - its completion (`tool_result` with the matching `tool_use_id`) → the card
 *     moves to `done`,
 *   - a session ending/restarting (`session.end` / `session.init`) sweeps that
 *     session's still-open cards to `done (orphaned)` so the board never
 *     accumulates zombies.
 *
 * Structure mirrors `StallWatchdog`: a pure `BusCore` subscriber with injected
 * deps for testability, a synchronous `ingest()` that NEVER throws into the bus,
 * and no timer (retention is capped on each move, not swept). V1 feed is
 * subagent-only; cron / per-session cards are phase 2.
 *
 * SAFETY: `addCard`/`moveCard`/cap are read-modify-write on ONE JSON file, so
 * concurrent bus events would race and lose updates. Every kanban op is chained
 * through a single in-tracker promise queue (a tiny mutex) so writes apply
 * strictly in order. SPEC: `.planning/kanban-live/SPEC.md`.
 */

import type { BusEvent } from "./types";
import type { KanbanBoard, KanbanCard } from "../ui/services/kanban";

/* ── Config ──────────────────────────────────────────────────────────────── */

export interface KanbanTrackerConfig {
  enabled: boolean;
  /** Cap the `done` column to this many newest cards after each move-to-done. */
  maxDoneCards: number;
}

export const DEFAULT_KANBAN_CONFIG: KanbanTrackerConfig = {
  enabled: true,
  maxDoneCards: 50,
};

/** Board column key. */
type Column = keyof KanbanBoard["columns"];

/** Tool names that dispatch a subagent (the only signal V1 tracks). */
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

/* ── Dependencies (injected — mirrors StallWatchdogDeps) ─────────────────── */

export interface KanbanTrackerDeps {
  /** Subscribe to the bus event stream; returns an unsubscribe fn. */
  subscribe(handler: (e: BusEvent) => void): () => void;
  /** Prepend a card to a column (kanban service `addCardToColumn`). */
  addCard(column: Column, card: KanbanCard): Promise<void>;
  /** Move a card to a column, applying a patch (kanban service `moveCard`). */
  moveCard(id: string, column: Column, patch?: Partial<KanbanCard>): Promise<void>;
  /** Cap the `done` column to `max` newest cards (kanban service `capDoneCards`). */
  capDone(max: number): Promise<void>;
  /** Clock seam (tests inject a deterministic clock). */
  now(): number;
  /** Optional log sink for swallowed errors. */
  log?(message: string, err?: unknown): void;
}

/* ── Per-card tracking ───────────────────────────────────────────────────── */

interface LiveCard {
  /** `agentId session_id` key of the session that spawned this subagent. */
  sessionKey: string;
  /** Resolved agent_type, reused when sweeping an orphan. */
  agentType: string;
}

/* ── The tracker ─────────────────────────────────────────────────────────── */

export class KanbanTracker {
  /** tool_use id → live in-progress agent card metadata. */
  private readonly live = new Map<string, LiveCard>();
  /** session key → set of live tool_use ids, for orphan sweeps. */
  private readonly sessions = new Map<string, Set<string>>();
  /** agent_id → last `session.agent_name`, a fallback for agent_type. */
  private readonly agentNames = new Map<string, string>();
  /** Serializes all kanban writes so read-modify-write ops can't lose updates. */
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: KanbanTrackerConfig,
    private readonly deps: KanbanTrackerDeps,
  ) {}

  private key(agentId: string, sessionId: string): string {
    // Space delimiter (agent + session ids never contain spaces), matching
    // StallWatchdog's session keying.
    return `${agentId} ${sessionId}`;
  }

  /** Chain a kanban write onto the single serialized queue; errors are swallowed
   *  + logged so one failed write never breaks the chain or the bus handler. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      this.deps.log?.("kanban write failed", err);
    });
  }

  /** Await all currently-queued writes (test seam). */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Feed one bus event into the tracker. NEVER throws (swallows + logs). */
  ingest(e: BusEvent): void {
    try {
      this.ingestInner(e);
    } catch (err) {
      this.deps.log?.("kanban ingest failed", err);
    }
  }

  private ingestInner(e: BusEvent): void {
    const key = this.key(e.agent_id, e.session_id);
    switch (e.topic) {
      case "session.agent_name": {
        const name = (e.payload as { agentName?: string })?.agentName;
        if (typeof name === "string" && name.trim()) this.agentNames.set(e.agent_id, name.trim());
        break;
      }

      case "response.tool_use": {
        const p = e.payload as {
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        };
        if (!p?.id || typeof p.name !== "string" || !AGENT_TOOL_NAMES.has(p.name)) break;
        if (this.live.has(p.id)) break; // idempotent — ignore a duplicate spawn for a live id

        const input = p.input ?? {};
        const rawTitle =
          (typeof input.description === "string" && input.description) ||
          (typeof input.prompt === "string" && input.prompt) ||
          "subagent";
        const agentType = this.resolveAgentType(e.agent_id, input);
        const card: KanbanCard = {
          id: p.id,
          title: rawTitle.slice(0, 120),
          started_at: new Date(e.ts).toISOString(),
          agent_type: agentType,
        };

        this.live.set(p.id, { sessionKey: key, agentType });
        let set = this.sessions.get(key);
        if (!set) {
          set = new Set();
          this.sessions.set(key, set);
        }
        set.add(p.id);

        this.enqueue(() => this.deps.addCard("in_progress", card));
        break;
      }

      case "tool_result": {
        const id = (e.payload as { tool_use_id?: string })?.tool_use_id;
        if (!id) break;
        const meta = this.live.get(id);
        if (!meta) break; // not a tracked agent card (e.g. a Bash result) → ignore
        this.forget(id, meta.sessionKey);
        const completedAt = new Date(e.ts).toISOString();
        this.enqueue(async () => {
          await this.deps.moveCard(id, "done", { completed_at: completedAt });
          await this.deps.capDone(this.config.maxDoneCards);
        });
        break;
      }

      // A session ending or (re)initialising means its in-flight subagents are
      // gone — sweep them to done so the board never keeps zombie cards. Mirrors
      // StallWatchdog clearing `outstanding` on the same events.
      case "session.end":
      case "session.init":
        this.sweepSession(key, e.ts);
        break;
    }
  }

  /** Prefer the Task/Agent tool's own `subagent_type`; else the parent session's
   *  cached agent name; else the literal "subagent". Cheap, no over-engineering. */
  private resolveAgentType(agentId: string, input: Record<string, unknown>): string {
    const sub = input.subagent_type;
    if (typeof sub === "string" && sub.trim()) return sub.trim();
    const cached = this.agentNames.get(agentId);
    if (cached) return cached;
    return "subagent";
  }

  private forget(id: string, sessionKey: string): void {
    this.live.delete(id);
    const set = this.sessions.get(sessionKey);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.sessions.delete(sessionKey);
    }
  }

  private sweepSession(key: string, ts: number): void {
    const ids = this.sessions.get(key);
    if (!ids || ids.size === 0) {
      this.sessions.delete(key);
      return;
    }
    const completedAt = new Date(ts).toISOString();
    for (const id of ids) {
      const meta = this.live.get(id);
      this.live.delete(id);
      const agentType = `${meta?.agentType ?? "subagent"} (orphaned)`;
      this.enqueue(async () => {
        await this.deps.moveCard(id, "done", { completed_at: completedAt, agent_type: agentType });
        await this.deps.capDone(this.config.maxDoneCards);
      });
    }
    this.sessions.delete(key);
  }

  /** Begin observing. No-op when disabled or already started. */
  start(): void {
    if (!this.config.enabled || this.unsubscribe) return;
    this.unsubscribe = this.deps.subscribe((e) => this.ingest(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.live.clear();
    this.sessions.clear();
    this.agentNames.clear();
  }
}
