/**
 * Bus runtime — AgentProcess implementations.
 *
 * Split out of `session-manager.ts` to stay under the 500-LOC file budget.
 * Two concrete classes implement the `AgentProcess` contract:
 *
 *   - `PtyAgentProcess` wraps a `bun-pty` handle (supervision=`pty-stdin`).
 *     `onData` is the crash-signal channel ONLY — never parsed as model
 *     output. Slash commands relayed by writing `/<cmd>\n` to the PTY
 *     master.
 *   - `ChildAgentProcess` wraps a `node:child_process` handle for
 *     `process-stream-json`, `process` (Windows-only fallback) and `tmux`
 *     modes. Stdin carries either JSON-line turns or slash commands per
 *     Probe 0.6.
 *
 * Spec: `docs/ClaudeClaw_Plus_Bus_Architecture_Spec.md` §5.3
 */

import type { ChildProcess } from "node:child_process";
import type { SupervisionMode } from "./types";

export type ExitHandler = (code: number) => void;
export type DataHandler = (chunk: string) => void;

export interface AgentProcess {
  readonly agent_id: string;
  readonly supervision: SupervisionMode;
  readonly pid: number;
  /** Relay a slash command (e.g. `compact`, `clear`, `quit`). No leading slash. */
  send_slash(cmd: string): Promise<void>;
  /** Send a stream-json line. Only valid in `process-stream-json` mode. */
  send_prompt_stream(line: string): Promise<void>;
  onExit(handler: ExitHandler): void;
  /**
   * Crash-signal observer ONLY. The Bus must NEVER parse model output from
   * this channel — model output comes from the JSONL Tailer (Sprint 2).
   *
   * Implementation note: the underlying child is spawned with `stdio: 'pipe'`
   * (so the daemon can observe crash diagnostics), but the Bus treats the
   * stdout/stderr stream as **opaque bytes** — equivalent to `stdout: 'ignore'`
   * for the model-output channel. The spec's "`stdout: 'ignore'` semantics"
   * is a behavioural claim about how the Bus handles the bytes, not the
   * literal stdio flag passed to the spawn.
   */
  onData(handler: DataHandler): void;
}

/**
 * Minimal subset of bun-pty's `IPty` we depend on. Declared as a structural
 * interface so we can avoid hard-importing `bun-pty` at top-level and tests
 * that don't exercise PTY mode skip the native module entirely.
 */
export interface PtyHandle {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | string }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  kill(signal?: string): void;
}

export class PtyAgentProcess implements AgentProcess {
  readonly agent_id: string;
  readonly supervision: SupervisionMode = "pty-stdin";
  readonly pid: number;
  private readonly pty: PtyHandle;
  private readonly exitHandlers: ExitHandler[] = [];
  private readonly dataHandlers: DataHandler[] = [];
  private _exited = false;

  constructor(agent_id: string, pty: PtyHandle) {
    this.agent_id = agent_id;
    this.pty = pty;
    this.pid = pty.pid;
    pty.onData((chunk) => {
      // Crash-signal observation ONLY (spec §5.3). Never parsed as model output.
      for (const h of this.dataHandlers) {
        try {
          h(chunk);
        } catch {
          /* handler errors must not crash the supervisor */
        }
      }
    });
    pty.onExit((e) => {
      this._exited = true;
      const code = typeof e.exitCode === "number" ? e.exitCode : -1;
      for (const h of this.exitHandlers) {
        try {
          h(code);
        } catch {
          /* swallow */
        }
      }
    });
  }

  send_slash(cmd: string): Promise<void> {
    if (this._exited) return Promise.reject(new Error(`agent ${this.agent_id} has exited`));
    // Spike 0.4 validated: bun-pty write with trailing newline fires the slash
    // command and produces the expected `system.local_command` JSONL line.
    this.pty.write(`/${cmd}\n`);
    return Promise.resolve();
  }

  async send_prompt_stream(line: string): Promise<void> {
    if (this._exited) return Promise.reject(new Error(`agent ${this.agent_id} has exited`));
    // Deliver an inbound prompt by typing it into claude's REPL via the PTY.
    //
    // Why not rely on `notifications/claude/channel` (the MCP path)? In a
    // headless, daemon-spawned claude (no human at the TTY) that notification
    // is accepted at the JSON-RPC layer but does NOT start a turn — claude
    // stays idle. Typing into the PTY (exactly what an interactive user does)
    // reliably fires a turn.
    //
    // claude's TUI enables bracketed-paste mode (ESC[?2004h). Writing the text
    // and the submitting CR in a single chunk is interpreted as a paste: the
    // text lands in the input box but is not submitted. So we write the text,
    // let the paste settle, then send the CR as a separate keystroke.
    this.pty.write(line);
    await new Promise((r) => setTimeout(r, 200));
    this.pty.write("\r");
  }

  onExit(handler: ExitHandler): void {
    this.exitHandlers.push(handler);
  }

  onData(handler: DataHandler): void {
    this.dataHandlers.push(handler);
  }

  /** Internal — called by SessionManager.stop(). */
  _kill(signal?: string): void {
    try {
      this.pty.kill(signal);
    } catch {
      /* already gone */
    }
  }

  _isExited(): boolean {
    return this._exited;
  }
}

export class ChildAgentProcess implements AgentProcess {
  readonly agent_id: string;
  readonly supervision: SupervisionMode;
  readonly pid: number;
  private readonly child: ChildProcess;
  private readonly exitHandlers: ExitHandler[] = [];
  private readonly dataHandlers: DataHandler[] = [];
  private _exited = false;

  constructor(agent_id: string, supervision: SupervisionMode, child: ChildProcess) {
    this.agent_id = agent_id;
    this.supervision = supervision;
    this.child = child;
    this.pid = child.pid ?? -1;
    // Capture stdout/stderr for crash-diag observation. We do NOT parse output —
    // this is purely a crash-signal channel (spec §5.3).
    const forward = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const h of this.dataHandlers) {
        try {
          h(s);
        } catch {
          /* swallow */
        }
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("exit", (code) => {
      this._exited = true;
      const exitCode = typeof code === "number" ? code : -1;
      for (const h of this.exitHandlers) {
        try {
          h(exitCode);
        } catch {
          /* swallow */
        }
      }
    });
  }

  send_slash(cmd: string): Promise<void> {
    if (this._exited) return Promise.reject(new Error(`agent ${this.agent_id} has exited`));
    if (this.supervision === "process") {
      // Spike 0.4: plain `Bun.spawn({stdin:'pipe'})` downshifts claude to
      // --print and discards slash input. We warn here rather than throw
      // because the public surface contract is identical across modes;
      // operators picking `process` mode on Windows have already accepted
      // the tradeoff (spec §5.3).
      console.warn(
        `[session-manager] supervision=process does not relay slash commands ` +
          `(agent ${this.agent_id}, cmd /${cmd}). See spec §5.3.`,
      );
      return Promise.resolve();
    }
    // process-stream-json: Probe 0.6 Q5 confirms slash commands work via stdin.
    if (!this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error(`stdin unavailable for agent ${this.agent_id}`));
    }
    this.child.stdin.write(`/${cmd}\n`);
    return Promise.resolve();
  }

  send_prompt_stream(line: string): Promise<void> {
    if (this._exited) return Promise.reject(new Error(`agent ${this.agent_id} has exited`));
    if (this.supervision !== "process-stream-json") {
      return Promise.reject(
        new Error(
          `send_prompt_stream is only valid for supervision=process-stream-json ` +
            `(agent ${this.agent_id} is ${this.supervision})`,
        ),
      );
    }
    if (!this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error(`stdin unavailable for agent ${this.agent_id}`));
    }
    const out = line.endsWith("\n") ? line : `${line}\n`;
    this.child.stdin.write(out);
    return Promise.resolve();
  }

  onExit(handler: ExitHandler): void {
    this.exitHandlers.push(handler);
  }

  onData(handler: DataHandler): void {
    this.dataHandlers.push(handler);
  }

  /** Internal — called by SessionManager.stop(). */
  _kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  _isExited(): boolean {
    return this._exited;
  }
}
