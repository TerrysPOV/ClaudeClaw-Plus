/**
 * #595: a bus agent whose session already has a transcript is RESUMED on a restart.
 *
 * Before: `buildClaudeArgs` always emitted `--session-id <stored id>`. claude treats that as a
 * create and refuses it when `<projects>/<cwd>/<id>.jsonl` exists ("Session ID ... is already in
 * use", a plain `stat` in the CLI), so every restart rotated the id and the agent lost its
 * conversation. The stand-in below is a shell script that records the argv it is started with,
 * so the flag is asserted on the real argv the manager builds, not on a stub of it.
 *
 * Supervision is `process` throughout: no bun-pty, and no trust self-heal (which writes the
 * operator's ~/.claude.json).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyExitUnconfirmedError, type PtyProcess } from "../../runner/pty-process";
import { __resetQuarantineForTests, quarantineSession } from "../../runner/pty-quarantine";
import { encodeCwdForProjectsDir } from "../jsonl-line-types";
import {
  buildClaudeArgs,
  resolveAgentCwd,
  SessionManager,
  sessionTranscriptExists,
} from "../session-manager";
import type { AgentConfig } from "../types";

const STORED = "5b7d1c2e-0000-4000-8000-0000000005a5";

describe("buildClaudeArgs — session flag (#595)", () => {
  const agent: AgentConfig = {
    id: "flag",
    cwd: "/tmp",
    session_id: STORED,
    permission_mode: "bypassPermissions",
    supervision: "process",
  };

  it("creates the session with --session-id by default", () => {
    const args = buildClaudeArgs(agent, "process");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(STORED);
    expect(args).not.toContain("--resume");
  });

  it("resumes the session with --resume when told its transcript exists", () => {
    const args = buildClaudeArgs(agent, "process", { resume: true });
    expect(args[args.indexOf("--resume") + 1]).toBe(STORED);
    expect(args).not.toContain("--session-id");
  });
});

describe("sessionTranscriptExists (#595)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccaw-resume-exists-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is true only for the file the CLI stats: <projects>/<encoded cwd>/<id>.jsonl", () => {
    const cwd = "/work/agent-x";
    const dir = join(root, encodeCwdForProjectsDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${STORED}.jsonl`), "{}\n");
    const base = { cwd, env: {}, projectsDir: root };
    expect(sessionTranscriptExists({ ...base, sessionId: STORED })).toBe(true);
    expect(sessionTranscriptExists({ ...base, sessionId: "other-id" })).toBe(false);
    expect(sessionTranscriptExists({ ...base, sessionId: STORED, cwd: "/work/elsewhere" })).toBe(
      false,
    );
  });

  it("looks under $CLAUDE_CONFIG_DIR/projects when no projects root is given", () => {
    const cwd = "/work/agent-y";
    const dir = join(root, "projects", encodeCwdForProjectsDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${STORED}.jsonl`), "{}\n");
    expect(
      sessionTranscriptExists({ cwd, sessionId: STORED, env: { CLAUDE_CONFIG_DIR: root } }),
    ).toBe(true);
    expect(
      sessionTranscriptExists({
        cwd,
        sessionId: STORED,
        env: { CLAUDE_CONFIG_DIR: join(root, "no") },
      }),
    ).toBe(false);
  });
});

describe("SessionManager.spawnAgent — resume on restart (#595)", () => {
  let dir: string;
  let projectsDir: string;
  let cwd: string;
  let mgr: SessionManager | undefined;
  let warned: string[];
  let persisted: Array<{ agentId: string; sessionId: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-resume-"));
    projectsDir = join(dir, "projects");
    cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    cwd = resolveAgentCwd(cwd);
    warned = [];
    persisted = [];
    __resetQuarantineForTests();
  });
  afterEach(async () => {
    try {
      await mgr?.stop("a");
    } catch {
      /* ignore */
    }
    mgr = undefined;
    __resetQuarantineForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A transcript for `id` in the place claude writes it for `cwd`. */
  function writeTranscript(id: string): void {
    const d = join(projectsDir, encodeCwdForProjectsDir(cwd));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.jsonl`), '{"type":"user"}\n');
  }

  /**
   * A stand-in `claude`: records each start's argv to `argv.<n>`. `failFirst` makes the first
   * start print `output` and exit with `code`; later starts stay alive.
   */
  function standIn(failFirst?: { output: string; code: number }): string {
    const script = join(dir, "claude.sh");
    const fail = failFirst
      ? `if [ "$n" = "1" ]; then echo "${failFirst.output}"; exit ${failFirst.code}; fi`
      : "";
    writeFileSync(
      script,
      `#!/bin/sh
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${dir}/count"
printf '%s\\n' "$@" > "${dir}/argv.$n"
${fail}
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

  function manager(command: string): SessionManager {
    mgr = new SessionManager({
      commandOverride: command,
      busSocketPath: join(dir, "bus.sock"),
      projectsDir,
      sessionCollisionDetectMs: 1500,
      postMortemDir: join(dir, "post-mortem"),
      persistRotatedSessionId: async (agentId, sessionId) => {
        persisted.push({ agentId, sessionId });
      },
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

  it("restart with a stored session whose transcript exists: --resume <id>, no --session-id, no rotation", async () => {
    // Fault (site: `spawnAgentInternal`, the `resume` decision, forced false): the argv carries
    // `--session-id <id>` and the real CLI rotates. Predicted result: `--resume` missing.
    writeTranscript(STORED);
    const agent = agentConfig();
    await manager(standIn()).spawnAgent(agent, "cli");

    const argv = argvOf(1);
    expect(argv[argv.indexOf("--resume") + 1]).toBe(STORED);
    expect(argv).not.toContain("--session-id");
    expect(persisted).toHaveLength(0);
    expect(agent.session_id).toBe(STORED);
  });

  it("first boot, no transcript yet: --session-id <id>, not --resume", async () => {
    // Fault (site: same decision, forced true): `--resume` of an id with no conversation is
    // refused by the CLI ("No conversation found"). Predicted result: `--resume` present.
    const agent = agentConfig();
    await manager(standIn()).spawnAgent(agent, "cli");

    const argv = argvOf(1);
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(STORED);
    expect(argv).not.toContain("--resume");
    expect(persisted).toHaveLength(0);
  });

  it("a genuine resume failure rotates exactly once, and the log carries a reason code, not the screen", async () => {
    // Fault (site: the detector's pattern, left as the id-collision marker): the refusal is not
    // recognised, no rotation. Predicted result: `persisted` is empty and `argv.2` absent.
    writeTranscript(STORED);
    const agent = agentConfig();
    await manager(
      standIn({ output: `No conversation found with session ID: ${STORED}`, code: 1 }),
    ).spawnAgent(agent, "cli");

    expect(persisted).toHaveLength(1);
    const fresh = persisted[0]?.sessionId as string;
    expect(fresh).not.toBe(STORED);
    expect(agent.session_id).toBe(fresh);
    const first = argvOf(1);
    expect(first[first.indexOf("--resume") + 1]).toBe(STORED);
    const second = argvOf(2);
    expect(second[second.indexOf("--session-id") + 1]).toBe(fresh);
    expect(second).not.toContain("--resume");

    const rotation = warned.filter((l) => l.includes("rotating to"));
    expect(rotation).toHaveLength(1);
    expect(rotation[0]).toContain("reason=resume-rejected-no-conversation");
    expect(rotation[0]).toContain(`session_id=${STORED}`);
    expect(warned.join("\n")).not.toContain("No conversation found");
  });

  it("any other boot failure of a resumed spawn does not rotate (the conversation is kept)", async () => {
    // Fault (site: rotation trigger widened to any non-zero exit): an auth or config failure
    // would discard the conversation for nothing. Predicted result: `persisted` has one entry.
    writeTranscript(STORED);
    const agent = agentConfig();
    await manager(standIn({ output: "Error: not logged in", code: 1 })).spawnAgent(agent, "cli");

    expect(persisted).toHaveLength(0);
    expect(agent.session_id).toBe(STORED);
  });

  it("a created spawn that collides is still rotated once, with its own reason code", async () => {
    // The transcript appears between our check and the CLI's (a writer we did not know of).
    const agent = agentConfig();
    await manager(
      standIn({ output: `Error: Session ID ${STORED} is already in use.`, code: 1 }),
    ).spawnAgent(agent, "cli");

    expect(persisted).toHaveLength(1);
    expect(warned.filter((l) => l.includes("reason=session-id-in-use"))).toHaveLength(1);
  });

  it("restart({ freshSession: false }) resumes the same transcript instead of rotating", async () => {
    // Fault (site: `buildClaudeArgs` flag, reverted to `--session-id`): the documented
    // "resume the same transcript" restart is refused by the CLI. Predicted result: the
    // second argv has `--session-id`.
    writeTranscript(STORED);
    const m = manager(standIn());
    await m.spawnAgent(agentConfig(), "cli");
    await m.restart("a", { freshSession: false, reason: "manual" });

    const second = argvOf(2);
    expect(second[second.indexOf("--resume") + 1]).toBe(STORED);
    expect(second).not.toContain("--session-id");
    expect(persisted).toHaveLength(0);
  });

  it("the #562 gate still stands: a resumed session with an unconfirmed writer is not started", async () => {
    // Fault (site: `assertSessionWritable`, removed): the stand-in is started beside the
    // unconfirmed writer. Predicted result: `argv.1` exists and the call resolves.
    writeTranscript(STORED);
    const stuck = {
      label: "fake:4242",
      pid: 4242,
      sessionId: STORED,
      cwd,
      canDie: false,
      isAlive: () => true,
      dispose: async () => {
        throw new PtyExitUnconfirmedError("fake:4242", 4242);
      },
      confirmExit: async () => {
        throw new PtyExitUnconfirmedError("fake:4242", 4242);
      },
    } as unknown as PtyProcess;
    quarantineSession("global", stuck, "retire-exit-unconfirmed");

    await expect(manager(standIn()).spawnAgent(agentConfig(), "cli")).rejects.toThrow(
      "quarantined",
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(() => readFileSync(join(dir, "argv.1"))).toThrow();
  });
});
