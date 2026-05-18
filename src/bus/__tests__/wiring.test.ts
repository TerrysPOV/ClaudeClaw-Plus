/**
 * Tests for src/bus/wiring.ts — slash-command relay wiring.
 *
 * Run with: bun test src/bus/__tests__/wiring.test.ts
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §6.3
 *
 * Strategy:
 *   - Unit tests use a fake SessionManager + fake AgentProcess to assert
 *     handler logic (forwarding, slash-stripping, unknown-agent error).
 *   - One integration test uses the real SessionManager + bun-pty (with
 *     `/bin/cat` as the stand-in claude — same seam used by
 *     `session-manager.test.ts`) to prove the bytes actually reach the
 *     PTY master. This is the per-supervision-mode sanity check called
 *     out in the Sprint 4 plan.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusCore, type BusCore } from "../core";
import { SessionManager, type AgentProcess } from "../session-manager";
import type { AgentConfig, SupervisionMode } from "../types";
import { wireSlashCommands } from "../wiring";

const IS_UNIX = process.platform !== "win32";

/* ───────────────────────────────────────────────────────────────────── */
/* Fakes                                                                 */
/* ───────────────────────────────────────────────────────────────────── */

class FakeAgentProcess implements AgentProcess {
  readonly agent_id: string;
  readonly supervision: SupervisionMode = "pty-stdin";
  readonly pid = 1234;
  /** Captured slash commands (bare, as `send_slash` receives them). */
  readonly slashCalls: string[] = [];

  constructor(agent_id: string) {
    this.agent_id = agent_id;
  }

  send_slash(cmd: string): Promise<void> {
    this.slashCalls.push(cmd);
    return Promise.resolve();
  }

  send_prompt_stream(_line: string): Promise<void> {
    return Promise.reject(new Error("not implemented in fake"));
  }

  onExit(_handler: (code: number) => void): void {
    /* no-op */
  }

  onData(_handler: (chunk: string) => void): void {
    /* no-op */
  }
}

/**
 * Minimal SessionManager stand-in exposing only `getAgent`. We don't
 * extend `SessionManager` because that would drag in spawn lifecycle —
 * the wiring contract only depends on `getAgent`.
 */
class FakeSessionManager {
  private readonly registry = new Map<string, FakeAgentProcess>();

  register(p: FakeAgentProcess): void {
    this.registry.set(p.agent_id, p);
  }

  getAgent(agent_id: string): AgentProcess | undefined {
    return this.registry.get(agent_id);
  }
}

/** Bus core with a no-op event log so tests don't touch the project audit log. */
function makeBus(): BusCore {
  return createBusCore({
    eventLogAppend: async (entry) =>
      ({
        eventId: "test",
        sequence: 0,
        timestamp: Date.now(),
        ...entry,
      }) as never,
  });
}

/* ───────────────────────────────────────────────────────────────────── */
/* Unit — handler logic                                                  */
/* ───────────────────────────────────────────────────────────────────── */

describe("wireSlashCommands — handler logic", () => {
  it("forwards bus.invokeSlashCommand to AgentProcess.send_slash", async () => {
    const bus = makeBus();
    const sm = new FakeSessionManager();
    const alpha = new FakeAgentProcess("alpha");
    sm.register(alpha);

    // Cast: wireSlashCommands only depends on `getAgent`, and the fake
    // provides exactly that surface.
    wireSlashCommands(bus, sm as unknown as SessionManager);

    await bus.invokeSlashCommand("alpha", "/compact");

    expect(alpha.slashCalls).toEqual(["compact"]);
  });

  it("strips the leading slash before calling send_slash", async () => {
    // `AgentProcess.send_slash` expects the bare name (it re-prepends `/`
    // per supervision mode). Adapters may pass either form.
    const bus = makeBus();
    const sm = new FakeSessionManager();
    const alpha = new FakeAgentProcess("alpha");
    sm.register(alpha);
    wireSlashCommands(bus, sm as unknown as SessionManager);

    await bus.invokeSlashCommand("alpha", "/compact");
    await bus.invokeSlashCommand("alpha", "compact");

    expect(alpha.slashCalls).toEqual(["compact", "compact"]);
  });

  it("throws when no agent is registered for the given id", async () => {
    const bus = makeBus();
    const sm = new FakeSessionManager();
    wireSlashCommands(bus, sm as unknown as SessionManager);

    await expect(bus.invokeSlashCommand("ghost", "/compact")).rejects.toThrow(
      /no active agent for id=ghost/,
    );
  });

  it("isolates registered agents — slash to one agent does not leak to another", async () => {
    const bus = makeBus();
    const sm = new FakeSessionManager();
    const alpha = new FakeAgentProcess("alpha");
    const beta = new FakeAgentProcess("beta");
    sm.register(alpha);
    sm.register(beta);
    wireSlashCommands(bus, sm as unknown as SessionManager);

    await bus.invokeSlashCommand("beta", "/clear");

    expect(alpha.slashCalls).toEqual([]);
    expect(beta.slashCalls).toEqual(["clear"]);
  });

  it("propagates errors from AgentProcess.send_slash", async () => {
    const bus = makeBus();
    const sm = new FakeSessionManager();
    const exploding = new (class extends FakeAgentProcess {
      override send_slash(): Promise<void> {
        return Promise.reject(new Error("pty closed"));
      }
    })("alpha");
    sm.register(exploding);
    wireSlashCommands(bus, sm as unknown as SessionManager);

    await expect(bus.invokeSlashCommand("alpha", "/compact")).rejects.toThrow(/pty closed/);
  });

  it("setSlashCommandHandler(null) detaches the handler", async () => {
    // Sanity: wiring uses the setter, so a `null` detach (e.g. for shutdown
    // ordering) restores the Sprint 1 "no handler" error path.
    const bus = makeBus();
    const sm = new FakeSessionManager();
    const alpha = new FakeAgentProcess("alpha");
    sm.register(alpha);
    wireSlashCommands(bus, sm as unknown as SessionManager);

    bus.setSlashCommandHandler(null);

    await expect(bus.invokeSlashCommand("alpha", "/compact")).rejects.toThrow(
      /invokeSlashCommand requires a slashCommandHandler/,
    );
  });
});

/* ───────────────────────────────────────────────────────────────────── */
/* Integration — real SessionManager + bun-pty                           */
/* ───────────────────────────────────────────────────────────────────── */

function mkAgent(id: string): AgentConfig {
  const dir = mkdtempSync(join(tmpdir(), "ccaw-wiring-"));
  return {
    id,
    cwd: dir,
    session_id: "00000000-1111-2222-3333-444444444444",
    permission_mode: "plan",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for predicate after ${timeoutMs}ms`);
}

describe("wireSlashCommands — real SessionManager + pty-stdin", () => {
  if (!IS_UNIX) {
    it.skip("skipped on non-Unix (no bun-pty)", () => {});
    return;
  }

  let sm: SessionManager;
  const spawned: AgentProcess[] = [];

  beforeEach(() => {
    // `/bin/cat` as the stand-in claude — same seam used by session-manager.test.ts.
    // Echoes everything written to the PTY master back through onData so we
    // can observe the slash bytes hitting the PTY.
    sm = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      busSocketPath: "/tmp/test-bus-wiring.sock",
    });
  });

  afterEach(async () => {
    for (const p of spawned) {
      try {
        await sm.stop(p.agent_id);
      } catch {
        /* ignore */
      }
    }
    spawned.length = 0;
  });

  it("pty-stdin path: bus.invokeSlashCommand writes /<cmd> to the PTY master", async () => {
    const bus = makeBus();
    wireSlashCommands(bus, sm);

    const agent = mkAgent("wire-pty");
    // origin=discord → defaultSupervisionFor → pty-stdin (Spike 0.4).
    const proc = await sm.spawnAgent(agent, "discord");
    spawned.push(proc);
    expect(proc.supervision).toBe("pty-stdin");

    let captured = "";
    proc.onData((chunk) => {
      captured += chunk;
    });

    await bus.invokeSlashCommand("wire-pty", "/compact");
    await waitFor(() => captured.includes("/compact"));
    expect(captured).toContain("/compact");
  });

  it("process-stream-json path: bus.invokeSlashCommand writes /<cmd> to stdin", async () => {
    const bus = makeBus();
    wireSlashCommands(bus, sm);

    const agent = mkAgent("wire-psj");
    // origin=cron → defaultSupervisionFor → process-stream-json (Probe 0.6 Q5).
    const proc = await sm.spawnAgent(agent, "cron");
    spawned.push(proc);
    expect(proc.supervision).toBe("process-stream-json");

    let captured = "";
    proc.onData((chunk) => {
      captured += chunk;
    });

    await bus.invokeSlashCommand("wire-psj", "compact");
    await waitFor(() => captured.includes("/compact"));
    expect(captured).toContain("/compact\n");
  });

  it("unknown agent id surfaces a clear error", async () => {
    const bus = makeBus();
    wireSlashCommands(bus, sm);
    await expect(bus.invokeSlashCommand("never-spawned", "/clear")).rejects.toThrow(
      /no active agent for id=never-spawned/,
    );
  });
});
