/**
 * #595 round 3, at the SessionManager: (1) a restart ends only a process the ownership record
 * proves this daemon spawned in an earlier boot, and proves it gone before the session is resumed;
 * (2) `/clear` is a controlled restart on a freshly minted id.
 *
 * Supervision is `process` throughout: no bun-pty, and no trust self-heal. The stand-in `claude`
 * records its argv, its pid, and whether the previous process (and any orphan) was alive when it
 * started, so ordering is asserted on what the OS saw, not on a stub. The orphans are REAL
 * processes, read by the production probe.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetQuarantineForTests,
  assertSessionWritable,
  isSessionQuarantined,
} from "../../runner/pty-quarantine";
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import { resolveAgentCwd, SessionManager } from "../session-manager";
import { createSystemProbe } from "../session-ownership";
import type { AgentConfig } from "../types";
import { wireSlashCommands } from "../wiring";
import { claudeInfo, FakeProbe, MemoryStore, SID } from "./ownership-fakes";

const BOOT = "boot-now";

type SlashHandler = (agentId: string, cmd: string) => Promise<void>;

describe("SessionManager — ownership guard and /clear (#595 r3)", () => {
  let dir: string;
  let projectsDir: string;
  let cwd: string;
  let mgr: SessionManager | undefined;
  let warned: string[];
  let errored: string[];
  let persisted: Array<{ agentId: string; sessionId: string }>;
  let store: MemoryStore;
  let orphan: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-own-mgr-"));
    projectsDir = join(dir, "projects");
    cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    cwd = resolveAgentCwd(cwd);
    warned = [];
    errored = [];
    persisted = [];
    store = new MemoryStore();
    __resetQuarantineForTests();
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    mgr = undefined;
    if (orphan && orphan.exitCode === null) orphan.kill("SIGKILL");
    orphan = undefined;
    __resetQuarantineForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(id: string): void {
    const d = join(projectsDir, encodeCwdForProjectsDir(cwd));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.jsonl`), '{"type":"user"}\n');
  }

  /**
   * Stand-in `claude`: argv to `argv.<n>`, its pid to `pid.<n>`, whether the previous start's
   * process was alive to `prev.state.<n>`, and whether `orphan.pid` was alive to `orphan.state.<n>`.
   */
  function standIn(): string {
    const script = join(dir, "claude.sh");
    writeFileSync(
      script,
      `#!/bin/sh
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${dir}/count"
printf '%s\\n' "$@" > "${dir}/argv.$n"
echo $$ > "${dir}/pid.$n"
if [ "$n" -gt 1 ]; then p=$((n-1)); if kill -0 "$(cat "${dir}/pid.$p")" 2>/dev/null; then echo alive; else echo gone; fi > "${dir}/prev.state.$n"; fi
if [ -f "${dir}/orphan.pid" ]; then if kill -0 "$(cat "${dir}/orphan.pid")" 2>/dev/null; then echo alive; else echo gone; fi > "${dir}/orphan.state.$n"; fi
exec sleep 60
`,
    );
    chmodSync(script, 0o755);
    return script;
  }

  const argvOf = (n: number): string[] =>
    readFileSync(join(dir, `argv.${n}`), "utf8")
      .split("\n")
      .filter(Boolean);
  const flagValue = (argv: string[], flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const stateOf = (file: string): string => readFileSync(join(dir, file), "utf8").trim();
  const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };

  function manager(
    over: {
      probe?: FakeProbe;
      persist?: (a: string, s: string) => Promise<void>;
      store?: boolean;
      guardMs?: number;
      stageMs?: number;
    } = {},
  ): SessionManager {
    mgr = new SessionManager({
      commandOverride: standIn(),
      busSocketPath: join(dir, "bus.sock"),
      projectsDir,
      sessionCollisionDetectMs: 600,
      postMortemDir: join(dir, "post-mortem"),
      ownershipStore: over.store === false ? undefined : store,
      processProbe: over.probe,
      bootId: BOOT,
      ownershipGuardMs: over.guardMs ?? 4000,
      ownershipTermMs: over.stageMs ?? 2500,
      persistRotatedSessionId:
        over.persist ??
        (async (agentId, sessionId) => {
          persisted.push({ agentId, sessionId });
        }),
      logger: {
        warn: (...a) => warned.push(a.join(" ")),
        info: () => {},
        error: (...a) => errored.push(a.join(" ")),
      },
    });
    return mgr;
  }

  const agentConfig = (): AgentConfig => ({
    id: "a",
    cwd,
    session_id: SID,
    permission_mode: "bypassPermissions",
    supervision: "process",
  });

  /** A real process "left behind": argv `sh fake-claude.sh --resume <id>`, ends on SIGTERM. */
  async function startOrphan(): Promise<{ pid: number; identity: string }> {
    const script = join(dir, "fake-claude.sh");
    writeFileSync(script, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
    chmodSync(script, 0o755);
    orphan = spawn("/bin/sh", [script, "--resume", SID], { stdio: "ignore" });
    const pid = orphan.pid as number;
    writeFileSync(join(dir, "orphan.pid"), String(pid));
    await new Promise((r) => setTimeout(r, 400));
    const info = await createSystemProbe().read(pid, 3000);
    if (!info) throw new Error("orphan did not start");
    return { pid, identity: info.identity };
  }

  const seed = (o: { pid: number; identity: string }, over: { bootId?: string } = {}): void => {
    store.rec.set("a", {
      agentId: "a",
      sessionId: SID,
      pid: o.pid,
      identity: o.identity,
      bootId: over.bootId ?? "boot-old",
      exe: "fake-claude.sh",
      spawnedAt: "2026-10-23T10:00:00.000Z",
    });
  };

  const orphanAlive = (): boolean => {
    try {
      process.kill(orphan?.pid as number, 0);
      return true;
    } catch {
      return false;
    }
  };

  /* ── ownership at restart ─────────────────────────────────────────── */

  it("a previous-boot orphan is revalidated, ended and confirmed gone BEFORE the session is resumed", async () => {
    // Fault (site: the `decideResume` call in `spawnAgentInternal`, removed): the stand-in starts
    // beside the live orphan. Predicted result: orphan.state.1 is "alive".
    writeTranscript(SID);
    seed(await startOrphan());
    const agent = agentConfig();
    await manager().spawnAgent(agent, "cli");

    expect(stateOf("orphan.state.1")).toBe("gone");
    expect(flagValue(argvOf(1), "--resume")).toBe(SID);
    expect(persisted).toHaveLength(0);
    expect(agent.session_id).toBe(SID);
    expect(warned.filter((l) => l.includes("reason=resume-orphan-reaped"))).toHaveLength(1);
  }, 30_000);

  it("pid reused by another process (different start identity): not signalled, session resumed", async () => {
    // Fault (site: identity comparison in `departed`, removed): the stranger is ended.
    // Predicted result: orphan.state.1 is "gone".
    writeTranscript(SID);
    const o = await startOrphan();
    seed({ pid: o.pid, identity: "a-different-start-identity" });
    await manager().spawnAgent(agentConfig(), "cli");

    expect(stateOf("orphan.state.1")).toBe("alive");
    expect(orphanAlive()).toBe(true);
    expect(flagValue(argvOf(1), "--resume")).toBe(SID);
    expect(persisted).toHaveLength(0);
  }, 30_000);

  it("a record from THIS boot whose process is alive: never signalled, the session rotates", async () => {
    // Fault (site: the boot-id comparison, removed): the daemon ends a process it manages.
    // Predicted result: the orphan is gone and nothing is rotated.
    writeTranscript(SID);
    seed(await startOrphan(), { bootId: BOOT });
    const agent = agentConfig();
    await manager().spawnAgent(agent, "cli");

    expect(orphanAlive()).toBe(true);
    expect(persisted).toHaveLength(1);
    const fresh = persisted[0]?.sessionId as string;
    expect(fresh).not.toBe(SID);
    const argv = argvOf(1);
    expect(flagValue(argv, "--session-id")).toBe(fresh);
    expect(argv).not.toContain("--resume");
    expect(warned.filter((l) => l.includes("reason=current-boot-owner-alive"))).toHaveLength(1);
  }, 30_000);

  it("an unrecorded claude that names the session is never signalled; the session is resumed", async () => {
    // Fault (site: a guard that searches for any process holding the id): it would be ended.
    // Predicted result: orphan.state.1 is "gone".
    writeTranscript(SID);
    await startOrphan();
    await manager().spawnAgent(agentConfig(), "cli");

    expect(stateOf("orphan.state.1")).toBe("alive");
    expect(orphanAlive()).toBe(true);
    expect(flagValue(argvOf(1), "--resume")).toBe(SID);
    expect(persisted).toHaveLength(0);
  }, 30_000);

  it("an unreadable record: nothing is signalled, the session rotates, the reason is logged", async () => {
    writeTranscript(SID);
    await startOrphan();
    store.readError = new Error("EACCES: owner.json");
    const agent = agentConfig();
    await manager().spawnAgent(agent, "cli");

    expect(orphanAlive()).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(flagValue(argvOf(1), "--session-id")).toBe(persisted[0]?.sessionId);
    expect(warned.filter((l) => l.includes("reason=ownership-record-unreadable"))).toHaveLength(1);
    expect(warned.join("\n")).not.toContain("EACCES");
  }, 30_000);

  it("a process read that times out: nothing is signalled, the session rotates within the guard deadline", async () => {
    writeTranscript(SID);
    seedFake();
    const probe = new FakeProbe();
    probe.stall = true;
    const t0 = Date.now();
    const agent = agentConfig();
    await manager({ probe, guardMs: 400 }).spawnAgent(agent, "cli");

    expect(Date.now() - t0).toBeLessThan(5000);
    expect(probe.kills).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(warned.filter((l) => l.includes("reason=guard-deadline"))).toHaveLength(1);
  }, 30_000);

  function seedFake(): void {
    store.rec.set("a", {
      agentId: "a",
      sessionId: SID,
      pid: 4242,
      identity: "T1",
      bootId: "boot-old",
      exe: "claude",
      spawnedAt: "2026-10-23T10:00:00.000Z",
    });
  }

  it("a first boot (no transcript) never reads the record", async () => {
    store.readError = new Error("must not be read");
    const agent = agentConfig();
    await manager().spawnAgent(agent, "cli");

    expect(flagValue(argvOf(1), "--session-id")).toBe(SID);
    expect(persisted).toHaveLength(0);
    expect(warned.join("\n")).not.toContain("ownership-record-unreadable");
  }, 30_000);

  it("with no store configured the bus keeps no records and resumes as before", async () => {
    writeTranscript(SID);
    await manager({ store: false }).spawnAgent(agentConfig(), "cli");
    expect(flagValue(argvOf(1), "--resume")).toBe(SID);
    expect(store.rec.size).toBe(0);
  }, 30_000);

  /* ── the record itself ────────────────────────────────────────────── */

  it("spawn writes an ownership record for the process it started, and it is cleared once the OS confirms the exit", async () => {
    // Fault (site: `recordSpawnOwnership` call, removed): no record, so a later restart could
    // never prove ownership. Predicted result: `store.rec.get("a")` is undefined.
    const m = manager();
    const proc = await m.spawnAgent(agentConfig(), "cli");
    await until(() => store.rec.has("a"));

    const rec = store.rec.get("a");
    expect(rec?.pid).toBe(proc.pid);
    expect(rec?.sessionId).toBe(SID);
    expect(rec?.bootId).toBe(BOOT);
    expect(rec?.exe).toBe("claude.sh");
    expect(rec?.identity.length).toBeGreaterThan(3);

    await m.stop("a");
    await until(() => !store.rec.has("a"));
    expect(store.rec.has("a")).toBe(false);
  }, 30_000);

  it("a record that cannot be written does not fail the spawn", async () => {
    store.write = async () => {
      throw new Error("ENOSPC");
    };
    const proc = await manager().spawnAgent(agentConfig(), "cli");
    expect(proc.pid).toBeGreaterThan(0);
    await until(() => warned.some((l) => l.includes("reason=ownership-record-failed")));
    expect(warned.filter((l) => l.includes("reason=ownership-record-failed"))).toHaveLength(1);
  }, 30_000);

  it("a same-boot restart that keeps the id resumes it: the earlier process is confirmed exited", async () => {
    writeTranscript(SID);
    const m = manager();
    await m.spawnAgent(agentConfig(), "cli");
    await until(() => store.rec.has("a"));
    await m.restart("a", { freshSession: false, reason: "manual" });

    expect(flagValue(argvOf(2), "--resume")).toBe(SID);
    expect(persisted).toHaveLength(0);
  }, 30_000);

  /* ── /clear as a controlled restart ───────────────────────────────── */

  function wired(m: SessionManager): SlashHandler {
    let handler: SlashHandler | null = null;
    wireSlashCommands({ setSlashCommandHandler: (h: SlashHandler) => (handler = h) } as never, m);
    return handler as unknown as SlashHandler;
  }

  it("/clear retires the old process BEFORE the new spawn, on `--session-id <new id>`, and stores that id", async () => {
    // Fault (site: `wiring.ts`, `/clear` relayed as a keystroke and the id rotated, the round-2
    // behaviour): no restart. Predicted result: `argv.2` does not exist.
    writeTranscript(SID);
    const m = manager();
    const clear = wired(m);
    const agent = agentConfig();
    await m.spawnAgent(agent, "cli");
    await until(() => store.rec.has("a"));
    expect(flagValue(argvOf(1), "--resume")).toBe(SID);

    await clear("a", "/clear");

    expect(persisted).toHaveLength(1);
    const fresh = persisted[0]?.sessionId as string;
    expect(fresh).not.toBe(SID);
    expect(stateOf("prev.state.2")).toBe("gone");
    const second = argvOf(2);
    expect(flagValue(second, "--session-id")).toBe(fresh);
    expect(second).not.toContain("--resume");
    // The stored id equals the live process's id.
    expect(agent.session_id).toBe(fresh);
    expect(persisted[0]?.agentId).toBe("a");
    expect(warned.filter((l) => l.includes("reason=session-cleared"))).toHaveLength(1);
    expect(m.getAgent("a")?.pid).toBeGreaterThan(0);
  }, 30_000);

  it("/clear whose old process cannot be confirmed gone fails, quarantines the session, and leaves the stored id", async () => {
    // Fault (site: `clearSessionInternal`, the confirmation result ignored): the clear "succeeds"
    // on a process that may still write. Predicted result: the promise resolves and a new id is
    // persisted.
    writeTranscript(SID);
    const probe = new FakeProbe();
    probe.alwaysAlive = claudeInfo({ identity: "T1" });
    const m = manager({ probe, stageMs: 150 });
    const clear = wired(m);
    const agent = agentConfig();
    await m.spawnAgent(agent, "cli");
    await until(() => store.rec.has("a"));

    await expect(clear("a", "/clear")).rejects.toThrow("not confirmed gone");

    expect(persisted).toHaveLength(0);
    expect(agent.session_id).toBe(SID);
    expect(existsSync(join(dir, "argv.2"))).toBe(false);
    expect(isSessionQuarantined({ sessionId: SID })).toBe(true);
    expect(probe.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
    expect(errored.filter((l) => l.includes("reason=clear-retire-unconfirmed"))).toHaveLength(1);
    // The existing #562 gate: nothing starts on the session while it is quarantined...
    await expect(assertSessionWritable({ sessionId: SID })).rejects.toThrow("quarantined");
    // ...and the quarantine lifts once the OS confirms the exit.
    probe.alwaysAlive = null;
    await assertSessionWritable({ sessionId: SID });
    expect(isSessionQuarantined({ sessionId: SID })).toBe(false);
  }, 30_000);

  it("/clear whose new id cannot be stored fails and brings the old session back", async () => {
    writeTranscript(SID);
    const m = manager({
      persist: async () => {
        throw new Error("EROFS");
      },
    });
    const clear = wired(m);
    const agent = agentConfig();
    await m.spawnAgent(agent, "cli");
    await until(() => store.rec.has("a"));

    await expect(clear("a", "/clear")).rejects.toThrow("could not be stored");

    expect(agent.session_id).toBe(SID);
    expect(flagValue(argvOf(2), "--resume")).toBe(SID);
    expect(m.getAgent("a")).toBeDefined();
    expect(errored.filter((l) => l.includes("reason=clear-persist-failed"))).toHaveLength(1);
  }, 30_000);

  it("/clear of an agent that is not running rejects instead of reporting success", async () => {
    const m = manager();
    await expect(m.clearSession("a")).rejects.toThrow("no active agent");
  });

  it("other slash commands neither restart the agent nor touch the stored id", async () => {
    writeTranscript(SID);
    const m = manager();
    const clear = wired(m);
    await m.spawnAgent(agentConfig(), "cli");
    await clear("a", "/compact");
    expect(persisted).toHaveLength(0);
    expect(existsSync(join(dir, "argv.2"))).toBe(false);
  }, 30_000);
});
