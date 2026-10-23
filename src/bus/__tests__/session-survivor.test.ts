/**
 * #595 round 2: (1) a claude that outlived its daemon must be ended, and proved gone, before the
 * stored session is resumed beside it; if that cannot be proved the session is rotated, not
 * resumed. (2) After `/clear` the stored id must not keep naming the pre-clear conversation.
 *
 * The process-table tests run `reapSessionSurvivors` against a scripted table. The SessionManager
 * tests start a stand-in `claude` that records the argv it gets; one of them starts a REAL
 * surviving process so the `ps` read, the signal and the confirmation are the production ones.
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
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import { resolveAgentCwd, SessionManager } from "../session-manager";
import {
  holdsSession,
  type ProcessEntry,
  type ProcessProbe,
  reapSessionSurvivors,
} from "../session-survivor";
import type { AgentConfig } from "../types";
import { wireSlashCommands } from "../wiring";

const STORED = "5b7d1c2e-0000-4000-8000-0000000005a5";
const UID = 501;
const START_A = "Thu Oct 23 10:00:00 2026";
const START_B = "Thu Oct 23 10:05:41 2026";

const claudeEntry = (over: Partial<ProcessEntry> = {}): ProcessEntry => ({
  pid: 900,
  uid: UID,
  start: START_A,
  args: `/home/u/.local/bin/claude --plugin-dir /x --permission-mode bypassPermissions --resume ${STORED}`,
  ...over,
});

/** A process table the test scripts: `rows` is re-read on every `list()`; kills are recorded. */
class FakeTable implements ProcessProbe {
  rows: ProcessEntry[];
  kills: Array<{ pid: number; signal: string }> = [];
  onKill: (pid: number, signal: string) => void = () => {};
  readFailure: Error | null = null;
  constructor(rows: ProcessEntry[]) {
    this.rows = rows;
  }
  async list(): Promise<ProcessEntry[]> {
    if (this.readFailure) throw this.readFailure;
    return this.rows.map((r) => ({ ...r }));
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push({ pid, signal });
    this.onKill(pid, signal);
  }
}

const FAST = { uid: UID, termMs: 150, killMs: 150 };

describe("holdsSession (#595 r2)", () => {
  it("matches the exact id as a whole argv token after --resume / --session-id", () => {
    expect(holdsSession(`claude --resume ${STORED}`, STORED)).toBe(true);
    expect(holdsSession(`claude --session-id ${STORED} --x`, STORED)).toBe(true);
    expect(holdsSession(`claude --resume=${STORED}`, STORED)).toBe(true);
  });

  it("does not match an id that merely starts with, or contains, the stored one", () => {
    expect(holdsSession(`claude --resume ${STORED}9`, STORED)).toBe(false);
    expect(holdsSession(`claude --resume x${STORED}`, STORED)).toBe(false);
    expect(holdsSession(`claude --resume ${STORED}-old`, STORED)).toBe(false);
  });

  it("needs the flag and a claude program, not just the id somewhere in the line", () => {
    expect(holdsSession(`claude --note ${STORED}`, STORED)).toBe(false);
    expect(holdsSession(`vim ${STORED} --resume ${STORED}`, STORED)).toBe(false);
  });
});

describe("reapSessionSurvivors (#595 r2)", () => {
  it("no process holds the session: nothing is signalled", async () => {
    const t = new FakeTable([claudeEntry({ args: "claude --resume other-session-id" })]);
    expect(await reapSessionSurvivors(STORED, { probe: t, ...FAST })).toEqual({ kind: "none" });
    expect(t.kills).toEqual([]);
  });

  it("a survivor that dies on SIGTERM is reaped; SIGKILL is never sent", async () => {
    // Fault (site: the result of the confirmation, `unconfirmed` reported as `reaped`):
    // that only shows in the stubborn case below; this case pins the happy path.
    const t = new FakeTable([claudeEntry()]);
    t.onKill = () => {
      t.rows = [];
    };
    const out = await reapSessionSurvivors(STORED, { probe: t, ...FAST });
    expect(out).toEqual({ kind: "reaped", pids: [900] });
    expect(t.kills).toEqual([{ pid: 900, signal: "SIGTERM" }]);
  });

  it("a survivor that ignores SIGTERM gets SIGKILL; one that survives that too is unconfirmed", async () => {
    // Fault (site: `left.length === 0 ? reaped : unconfirmed`, always `reaped`): the caller
    // would resume beside a live writer. Predicted result: `kind` is "reaped".
    const t = new FakeTable([claudeEntry()]);
    const out = await reapSessionSurvivors(STORED, { probe: t, ...FAST });
    expect(out).toEqual({ kind: "unconfirmed", pids: [900] });
    expect(t.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("an unreadable process table is its own outcome and signals nothing", async () => {
    const t = new FakeTable([claudeEntry()]);
    t.readFailure = new Error("ps: operation not permitted");
    expect(await reapSessionSurvivors(STORED, { probe: t, ...FAST })).toEqual({
      kind: "table-unreadable",
    });
    expect(t.kills).toEqual([]);
  });

  it("a pid recycled by another process (different start time, different argv) is not the survivor", async () => {
    // Fault (site: `sameProcess`, comparing pid only): the recycled process reads as the
    // survivor still alive, gets SIGKILL, and the outcome is `unconfirmed`.
    const t = new FakeTable([claudeEntry()]);
    t.onKill = () => {
      t.rows = [{ pid: 900, uid: UID, start: START_B, args: "/usr/bin/postgres -D /data" }];
    };
    const out = await reapSessionSurvivors(STORED, { probe: t, ...FAST });
    expect(out).toEqual({ kind: "reaped", pids: [900] });
    expect(t.kills).toEqual([{ pid: 900, signal: "SIGTERM" }]);
  });

  it("a pid recycled BEFORE the signal is never signalled", async () => {
    // The survivor is found, then its pid is recycled before we signal. The re-read at signal
    // time sees a different start time, so nothing is sent to the stranger.
    let reads = 0;
    const t = new FakeTable([claudeEntry()]);
    const list = t.list.bind(t);
    t.list = async () => {
      reads++;
      if (reads === 2) {
        t.rows = [{ pid: 900, uid: UID, start: START_B, args: "/usr/bin/postgres -D /data" }];
      }
      return list();
    };
    const out = await reapSessionSurvivors(STORED, { probe: t, ...FAST });
    expect(out).toEqual({ kind: "reaped", pids: [900] });
    expect(t.kills).toEqual([]);
  });

  it("an id-prefix decoy, another user's claude and a non-claude line are not survivors", async () => {
    // Fault (site: `holdsSession`, `args.includes(sessionId)`): the decoy matches and is killed.
    const t = new FakeTable([
      claudeEntry({ pid: 11, args: `claude --resume ${STORED}9` }),
      claudeEntry({ pid: 12, uid: 0 }),
      claudeEntry({ pid: 13, args: `tail -f ${STORED}.jsonl` }),
    ]);
    expect(await reapSessionSurvivors(STORED, { probe: t, ...FAST })).toEqual({ kind: "none" });
    expect(t.kills).toEqual([]);
  });
});

describe("SessionManager — survivor guard and /clear (#595 r2)", () => {
  let dir: string;
  let projectsDir: string;
  let cwd: string;
  let mgr: SessionManager | undefined;
  let warned: string[];
  let persisted: Array<{ agentId: string; sessionId: string }>;
  let survivor: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-survivor-"));
    projectsDir = join(dir, "projects");
    cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    cwd = resolveAgentCwd(cwd);
    warned = [];
    persisted = [];
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    mgr = undefined;
    if (survivor && survivor.exitCode === null) survivor.kill("SIGKILL");
    survivor = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(id: string): void {
    const d = join(projectsDir, encodeCwdForProjectsDir(cwd));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.jsonl`), '{"type":"user"}\n');
  }

  /** Stand-in `claude`: records its argv and whether `survivor.pid` was alive when it started. */
  function standIn(): string {
    const script = join(dir, "claude.sh");
    writeFileSync(
      script,
      `#!/bin/sh
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${dir}/count"
printf '%s\\n' "$@" > "${dir}/argv.$n"
if kill -0 "$(cat "${dir}/survivor.pid" 2>/dev/null)" 2>/dev/null; then echo alive; else echo gone; fi > "${dir}/survivor.state.$n"
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

  function manager(probe?: ProcessProbe, bounds = { term: 3000, kill: 1000 }): SessionManager {
    mgr = new SessionManager({
      commandOverride: standIn(),
      busSocketPath: join(dir, "bus.sock"),
      projectsDir,
      sessionCollisionDetectMs: 600,
      postMortemDir: join(dir, "post-mortem"),
      persistRotatedSessionId: async (agentId, sessionId) => {
        persisted.push({ agentId, sessionId });
      },
      processProbe: probe,
      survivorTermMs: bounds.term,
      survivorKillMs: bounds.kill,
      logger: { warn: (...a) => warned.push(a.join(" ")), info: () => {}, error: () => {} },
    });
    return mgr;
  }

  const agentConfig = (): AgentConfig => ({
    id: "a",
    cwd,
    session_id: STORED,
    permission_mode: "bypassPermissions",
    supervision: "process",
  });

  /** A real process a previous daemon "left behind": argv `sh fake-claude.sh --resume <id>`. */
  async function startSurvivor(): Promise<number> {
    const script = join(dir, "fake-claude.sh");
    writeFileSync(script, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
    chmodSync(script, 0o755);
    survivor = spawn("/bin/sh", [script, "--resume", STORED], { stdio: "ignore" });
    const pid = survivor.pid as number;
    writeFileSync(join(dir, "survivor.pid"), String(pid));
    await new Promise((r) => setTimeout(r, 300));
    return pid;
  }

  it("a surviving claude is ended and confirmed gone BEFORE the session is resumed", async () => {
    // Fault (site: the `reapSessionSurvivors` call in `spawnAgentInternal`, removed): the
    // stand-in starts while the survivor is alive. Predicted result: state is "alive".
    writeTranscript(STORED);
    const pid = await startSurvivor();
    const agent = agentConfig();
    await manager().spawnAgent(agent, "cli");

    expect(readFileSync(join(dir, "survivor.state.1"), "utf8").trim()).toBe("gone");
    const argv = argvOf(1);
    expect(flagValue(argv, "--resume")).toBe(STORED);
    expect(persisted).toHaveLength(0);
    expect(agent.session_id).toBe(STORED);
    const line = warned.filter((l) => l.includes("reason=resume-survivor-reaped"));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain(`pids=${pid}`);
  }, 30_000);

  it("a survivor that cannot be confirmed dead: no resume, rotation, reason logged", async () => {
    // Fault (site: `unconfirmed` treated as gone): the session is resumed beside the live writer.
    // Predicted result: argv.1 carries `--resume`, nothing is persisted.
    writeTranscript(STORED);
    const table = new FakeTable([claudeEntry()]);
    const agent = agentConfig();
    // Short bounds: this survivor never dies.
    const m = manager(table, { term: 150, kill: 150 });
    await m.spawnAgent(agent, "cli");

    expect(persisted).toHaveLength(1);
    const fresh = persisted[0]?.sessionId as string;
    expect(fresh).not.toBe(STORED);
    expect(agent.session_id).toBe(fresh);
    const argv = argvOf(1);
    expect(flagValue(argv, "--session-id")).toBe(fresh);
    expect(argv).not.toContain("--resume");
    expect(existsSync(join(dir, "argv.2"))).toBe(false);
    expect(table.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    const line = warned.filter((l) => l.includes("reason=resume-survivor-unconfirmed"));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain(`session_id=${STORED}`);
  }, 30_000);

  it("an unreadable process table fails closed: rotation, reason logged, no resume", async () => {
    writeTranscript(STORED);
    const table = new FakeTable([]);
    table.readFailure = new Error("ps: operation not permitted");
    const agent = agentConfig();
    await manager(table).spawnAgent(agent, "cli");

    expect(persisted).toHaveLength(1);
    const argv = argvOf(1);
    expect(flagValue(argv, "--session-id")).toBe(persisted[0]?.sessionId);
    expect(argv).not.toContain("--resume");
    expect(warned.filter((l) => l.includes("reason=resume-process-table-unreadable"))).toHaveLength(
      1,
    );
    expect(warned.join("\n")).not.toContain("operation not permitted");
  }, 30_000);

  it("no survivor: the session is resumed as in round 1, nothing signalled", async () => {
    writeTranscript(STORED);
    const table = new FakeTable([claudeEntry({ args: "claude --resume some-other-session" })]);
    const agent = agentConfig();
    await manager(table).spawnAgent(agent, "cli");

    expect(flagValue(argvOf(1), "--resume")).toBe(STORED);
    expect(persisted).toHaveLength(0);
    expect(table.kills).toEqual([]);
  }, 30_000);

  it("a first boot (no transcript) never reads the process table", async () => {
    const table = new FakeTable([]);
    table.readFailure = new Error("must not be read");
    const agent = agentConfig();
    await manager(table).spawnAgent(agent, "cli");

    expect(flagValue(argvOf(1), "--session-id")).toBe(STORED);
    expect(persisted).toHaveLength(0);
  }, 30_000);

  it("/clear then a restart that keeps the id: a new session, not the pre-clear conversation", async () => {
    // Fault (site: `wiring.ts`, the `noteSessionCleared` call removed): the stored id stays
    // the pre-clear one and the restart resumes it. Predicted result: argv.2 has `--resume`.
    writeTranscript(STORED);
    let handler: ((agentId: string, cmd: string) => Promise<void>) | null = null;
    const m = manager(new FakeTable([]));
    wireSlashCommands({ setSlashCommandHandler: (h: typeof handler) => (handler = h) } as never, m);
    const agent = agentConfig();
    await m.spawnAgent(agent, "cli");
    expect(flagValue(argvOf(1), "--resume")).toBe(STORED);

    await (handler as unknown as (a: string, c: string) => Promise<void>)("a", "/clear");

    expect(persisted).toHaveLength(1);
    const fresh = persisted[0]?.sessionId as string;
    expect(fresh).not.toBe(STORED);
    expect(agent.session_id).toBe(fresh);
    expect(warned.filter((l) => l.includes("reason=session-cleared"))).toHaveLength(1);

    await m.restart("a", { freshSession: false, reason: "manual" });
    const second = argvOf(2);
    expect(flagValue(second, "--session-id")).toBe(fresh);
    expect(second).not.toContain("--resume");
  }, 30_000);

  it("other slash commands leave the stored id alone", async () => {
    writeTranscript(STORED);
    let handler: ((agentId: string, cmd: string) => Promise<void>) | null = null;
    const m = manager(new FakeTable([]));
    wireSlashCommands({ setSlashCommandHandler: (h: typeof handler) => (handler = h) } as never, m);
    await m.spawnAgent(agentConfig(), "cli");
    await (handler as unknown as (a: string, c: string) => Promise<void>)("a", "/compact");
    expect(persisted).toHaveLength(0);
  }, 30_000);
});
