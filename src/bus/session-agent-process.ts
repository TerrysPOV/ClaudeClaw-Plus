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
// Import from the standalone sanitiser module to avoid pulling bun-pty into
// `session-agent-process` at startup. Non-PTY supervision modes (process,
// process-stream-json, tmux) must not require the native PTY dep just to
// construct an AgentProcess (Codex P1 on PR #149).
import { sanitizePtyPromptText } from "../runner/pty-prompt-sanitizer";
import type { SupervisionMode } from "./types";

/** Strip ANSI OSC/CSI escape sequences so dialog matching survives the
 *  cursor-positioning escapes the CLI interleaves into rendered text. Without
 *  this, a raw substring like "development channels" silently stops matching
 *  after a CLI build renders it as "development\x1b[32Gchannels". Mirrors the
 *  stripper in `runner/pty-process.ts` (kept local to avoid importing the PTY
 *  runner into the bus module). */
function stripAnsiEscapes(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escape sequences require control bytes.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape stripper.
      .replace(/\x1b\[[?0-9;]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: catch-all ESC byte stripper.
      .replace(/\x1b/g, "")
  );
}

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
  /** Serializes the write/settle/CR sequence so concurrent prompts can't
   *  interleave in the PTY input buffer (review #141 P1). */
  private writeChain: Promise<void> = Promise.resolve();
  /** ANSI-stripped tail of PTY output, reset after each submit so the
   *  delivery-confirm check only inspects post-submit frames (#wedge). */
  private recentOut = "";
  private readonly submitConfirmMs: number;
  private readonly maxSubmitNudges: number;
  private readonly maxCompactionWaitMs: number;
  /** Boot-dialog watcher state (issue #193). Claude shows interactive
   *  confirmation dialogs at startup (the dev-channels prompt, and the newer
   *  "Bypass Permissions mode" prompt). We answer them by inspecting early PTY
   *  output and sending the correct key per dialog. The watcher stays engaged
   *  until claude actually reaches the REPL (detected via the footer marker) or
   *  a bounded timeout — NOT until the first prompt. Codex P2 on PR #195: a
   *  dialog can render AFTER an early heartbeat/scheduler prompt on a slow
   *  fresh-install boot, so disengaging on first-prompt left late dialogs
   *  unanswered and the agent stuck at "No, exit". */
  private bootDialogActive = true;
  private bootDialogBuffer = "";
  private answeredBypassPrompt = false;
  /** Signature of the last generic confirm-dialog we answered, so we send one
   *  Enter per distinct dialog instead of on every render chunk. */
  private lastConfirmSig: string | null = null;
  private warnedUnhandledDialog = false;
  /** One-shot guard so an unconfirmed delivery is surfaced once per process
   *  (see the delivery-confirm loop) instead of spamming the log. */
  private warnedUnconfirmedDelivery = false;
  /** Hard cap on the boot-dialog watch window (issue #193 / Codex P2). If no
   *  REPL-ready marker is observed within this window (e.g. a future CLI
   *  changes the footer text), the watcher disengages anyway so it never
   *  buffers PTY output for the whole process lifetime. */
  private static readonly BOOT_DIALOG_MAX_MS = 15_000;
  private bootDialogTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    agent_id: string,
    pty: PtyHandle,
    opts: {
      /** Grace window to confirm a submit started a turn before re-nudging. */
      submitConfirmMs?: number;
      /** Max times to re-send the submit keystroke when no turn is observed. */
      maxSubmitNudges?: number;
      /** Upper bound to wait out an in-progress auto-compaction before the
       *  submit is abandoned to the watchdog (compaction can run ~100s). */
      maxCompactionWaitMs?: number;
    } = {},
  ) {
    this.agent_id = agent_id;
    this.pty = pty;
    this.pid = pty.pid;
    this.submitConfirmMs = opts.submitConfirmMs ?? 1500;
    this.maxSubmitNudges = opts.maxSubmitNudges ?? 2;
    this.maxCompactionWaitMs = opts.maxCompactionWaitMs ?? 240_000;
    this.bootDialogTimer = setTimeout(
      () => this.endBootDialogPhase(),
      PtyAgentProcess.BOOT_DIALOG_MAX_MS,
    );
    pty.onData((chunk) => {
      if (this.bootDialogActive) this.handleBootDialog(chunk);
      // Keep a small ANSI-stripped tail so send_prompt_stream can tell whether a
      // submit actually started a turn (the idle REPL footer disappears on turn
      // start) -- see the delivery-confirm loop. Observation only.
      this.recentOut = (this.recentOut + stripAnsiEscapes(chunk)).slice(-2000);
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

  send_prompt_stream(line: string): Promise<void> {
    if (this._exited) return Promise.reject(new Error(`agent ${this.agent_id} has exited`));
    // NOTE (Codex P2 on PR #195): we deliberately do NOT disengage the
    // boot-dialog watcher here. An early heartbeat/scheduler prompt can be
    // dispatched before a slow fresh-install boot has rendered its
    // bypass-permissions dialog; disengaging on first-prompt left that later
    // dialog unanswered (default "No, exit") and killed the agent. The watcher
    // now disengages on the REPL-ready footer marker or the bounded timeout
    // instead (see handleBootDialog / endBootDialogPhase). The watcher only
    // ever writes in response to specific dialog text, so leaving it engaged
    // cannot inject keys mid-turn once the REPL is up.
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
    //
    // Sanitize CR/LF in the prompt: an embedded `\r` would submit the prompt
    // mid-line and corrupt the turn (Codex review P2 on PR #140).
    //
    // The write/settle/CR sequence is chained per process so two prompts
    // dispatched within the 200ms settle window serialise instead of
    // interleaving their bytes in the PTY input buffer (#141 review P1).
    const text = sanitizePtyPromptText(line);
    const run = this.writeChain.then(async () => {
      if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
      this.pty.write(text);
      await new Promise((r) => setTimeout(r, 200));
      if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
      this.pty.write("\r");
      // #wedge fix (prompt-delivery-confirm): the typed text + CR can fail to
      // start a turn when the CR lands during a transient REPL render (paste /
      // redraw race) -- the prompt sits un-submitted, no turn, no API socket,
      // and the receipt only times out 5 min later. Confirm a turn started: the
      // idle REPL footer ("to cycle", the version-stable core of the mode-cycler
      // hint -- "shift+tab to cycle" in older CLIs, "to cycle permission modes"
      // in 2.1.168+, so the bare "to cycle" is what survives the rename) is
      // replaced by the streaming view the instant a turn begins; if it is still
      // being rendered after a grace window, re-send the submit keystroke (the
      // text is already in the input box). Bounded; a stray CR at an idle REPL
      // is a no-op, and a genuinely stuck REPL still degrades to the watchdog.
      // NB: handleBootDialog uses the stricter "tab to cycle" to avoid
      // disengaging on boot prose (#195); here the REPL is already up, so boot
      // prose is not a concern and the bare core is the safer live-footer match.
      // A second wedge class (socket=yes): an auto-compaction can seize the
      // REPL the instant the prompt arrives and swallow the submit CR -- the
      // turn never starts and the receipt only times out 5 min later. While
      // "Compacting" is on screen, wait it out; this does NOT spend a submit
      // nudge (compaction runs ~100s, far longer than the nudge cadence). When
      // it finishes the footer returns to "to cycle" and the idle-footer branch
      // re-submits the still-typed prompt. Bounded by maxCompactionWaitMs so a
      // stuck compaction degrades to the watchdog instead of looping forever.
      // Outcomes: "turn-started" (delivered) | "stuck-compaction" |
      // "unconfirmed-idle" (gave up). A give-up degrades to the watchdog, but
      // NEVER silently -- the stranded input line is cleared and a diagnostic is
      // surfaced, since a silently-dropped prompt is the failure this loop fixes.
      const compactionDeadline = Date.now() + this.maxCompactionWaitMs;
      let outcome: "turn-started" | "stuck-compaction" | "unconfirmed-idle" = "unconfirmed-idle";
      for (let nudge = 0; nudge < this.maxSubmitNudges; ) {
        this.recentOut = "";
        await new Promise((r) => setTimeout(r, this.submitConfirmMs));
        // Exit mid-confirm must REJECT, in parity with the two pre-CR checks
        // above: the CR is not proof of delivery (the whole point of this loop),
        // so resolving here would report a phantom success for a prompt whose
        // target just died -- suppressing re-queue and masking the wedge.
        if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
        // Anchor the compaction probe to the CLI status line ("Compacting
        // conversation" / "Compacting at auto window") rather than the bare word
        // "Compacting", which also occurs in ordinary model output: a live turn
        // streaming that word would otherwise be mistaken for a compaction and
        // stall this loop -- and the serialised writeChain behind it -- up to the
        // deadline.
        if (
          this.recentOut.includes("Compacting conversation") ||
          this.recentOut.includes("Compacting at auto")
        ) {
          if (Date.now() > compactionDeadline) {
            outcome = "stuck-compaction";
            break;
          }
          continue; // compaction in progress -> wait, do not spend a nudge
        }
        // A turn-start is POSITIVE evidence -- the streaming view replaced the
        // footer. An EMPTY confirm window is NOT that: a long-idle, quiet REPL
        // emits nothing, so `!includes("to cycle")` on an empty buffer falsely
        // reads as turn-started, stops the nudging, and leaves the prompt
        // un-submitted until the 5-min receipt timeout. This is the residual
        // idle-REPL wedge (dossier 20260612T080557: idle 7h, stdin written,
        // turn_started_at absent, socket=no -- with the full delivery+compaction
        // fix stack already active). Require real output before trusting the
        // footer's absence; an empty/whitespace window stays inconclusive and
        // spends a nudge instead of claiming a phantom success.
        if (this.recentOut.trim().length > 0 && !/to\s*cycle/.test(this.recentOut)) {
          outcome = "turn-started";
          // A turn confirmed → re-arm the one-shot wedge warning, so a LATER
          // genuine wedge on this long-lived process still surfaces a diagnostic
          // instead of being silenced for the rest of the process lifetime.
          this.warnedUnconfirmedDelivery = false;
          break;
        }
        this.pty.write("\r"); // footer still idle (or silent) -> CR did not submit -> nudge
        nudge++;
      }
      if (outcome !== "turn-started") {
        // The prompt is still sitting un-submitted in the REPL input box; left
        // there it would concatenate onto the next prompt. This holds for BOTH
        // give-up outcomes: "unconfirmed-idle" (footer present or silent the
        // whole time) AND "stuck-compaction" (a compaction never finished within
        // maxCompactionWaitMs, so the typed line never submitted). A Ctrl-U at a
        // REPL whose turn never started is a no-op on an empty/legit line, so
        // clearing on any non-turn-started outcome is safe and symmetric.
        this.pty.write("\x15"); // Ctrl-U: kill the input line
      }
      if (outcome !== "turn-started" && !this.warnedUnconfirmedDelivery) {
        this.warnedUnconfirmedDelivery = true;
        console.warn(
          `[delivery-confirm] agent=${this.agent_id}: submit not confirmed ` +
            `(${outcome}); degraded to the watchdog. Recurring occurrences may mean ` +
            `the REPL footer marker changed in the CLI.`,
        );
      }
    });
    // Keep the chain alive past a rejected write so later prompts still run.
    this.writeChain = run.catch(() => {});
    return run;
  }

  /** Stop answering boot dialogs — called when the REPL-ready footer marker is
   *  observed, the bounded timeout fires, or on kill. Idempotent. */
  private endBootDialogPhase(): void {
    if (!this.bootDialogActive) return;
    this.bootDialogActive = false;
    this.bootDialogBuffer = "";
    if (this.bootDialogTimer) {
      clearTimeout(this.bootDialogTimer);
      this.bootDialogTimer = undefined;
    }
  }

  /** Answer claude's interactive startup confirmation dialogs by inspecting
   *  early PTY output (issue #193), then disengage once the REPL is up.
   *
   *  Resilient to CLI rendering changes (the reason this used to wedge after a
   *  CLI auto-update): the raw PTY stream interleaves cursor-positioning
   *  escapes *inside* dialog text — e.g. a build renders the title
   *  "development<ESC>[32Gchannels" — so a literal substring match on the raw
   *  buffer silently stops matching, leaving the dialog unanswered and the
   *  agent stuck before the REPL. We therefore (1) strip ANSI before matching,
   *  and (2) drive the dialog by its *structure* — the selected ("❯") option +
   *  the "Enter to confirm" affordance — rather than per-title strings.
   *
   *  Default-key safety: a dialog whose selected option is a proceed action
   *  (trust-folder, dev-channels) is confirmed with Enter. The only known
   *  dialog whose default is destructive is the bypass-permissions prompt
   *  ("No, exit" preselected) — handled specifically with Down+Enter. An
   *  unrecognised dialog whose default looks destructive is NOT auto-answered
   *  (we log once instead), so a future CLI change degrades to "stuck + a
   *  warning" rather than "blindly pressed the wrong button". */
  private handleBootDialog(chunk: string): void {
    this.bootDialogBuffer = (this.bootDialogBuffer + chunk).slice(-4000);
    const buf = stripAnsiEscapes(this.bootDialogBuffer);

    // REPL is up — disengage FIRST so we never inject a key into a live REPL.
    // Every REPL mode footer carries the mode-cycler hint ("shift+tab to
    // cycle" / a future "tab to cycle permission modes"); "tab to cycle" is its
    // version-stable core and — unlike the bare "to cycle" — cannot trip on
    // arbitrary boot prose, which would disengage early and re-expose #195.
    if (/tab\s*to\s*cycle/.test(buf)) {
      this.endBootDialogPhase();
      return;
    }

    // Bypass-permissions dialog — DEFAULT is "No, exit"; a blind Enter selects
    // exit and kills the agent, so move the selection to the accept row first.
    if (buf.includes("Yes, I accept")) {
      if (!this.answeredBypassPrompt) {
        this.answeredBypassPrompt = true;
        this.sendBootKeys("\x1b[B", "\r"); // Down, then Enter
      }
      // The bypass dialog is still on screen (re-rendered after the Down): do
      // NOT fall through to the generic confirm branch, which would fire a
      // second, blind Enter racing the deferred one above (Codex F3 / #195).
      return;
    }

    // Generic confirm dialog. Identify the selected option (the "❯" row) just
    // above the "Enter to confirm" affordance and only press Enter when that
    // default is a proceed action. Dedup on the option region so we send one
    // Enter per distinct dialog (trust-folder → dev-channels → REPL), not one
    // per render chunk.
    // Use the LAST affordance: the buffer accumulates across dialogs, so an
    // earlier (already-answered) dialog's text may still be present above the
    // current one.
    const ec = buf.lastIndexOf("Enter to confirm");
    if (ec === -1) return;
    const region = buf.slice(0, ec);
    const arrow = region.lastIndexOf("❯");
    if (arrow === -1) return;
    const eol = region.indexOf("\n", arrow);
    // The selected ("❯") option line identifies the dialog stably regardless of
    // how much earlier output has accumulated in the buffer — use it both as
    // the proceed/destructive discriminator AND the per-dialog dedup key (one
    // Enter per distinct dialog, not per render chunk).
    const selected = region
      .slice(arrow, eol === -1 ? region.length : eol)
      .trim()
      .toLowerCase();
    if (selected === this.lastConfirmSig) return; // same dialog still rendering
    // Fail-safe ALLOWLIST: only auto-press Enter when the selected ("❯") option
    // affirmatively reads as a proceed/accept action. This subsumes the old
    // destructive-blocklist (which both blind-Entered destructive defaults
    // phrased delete/discard/… and false-wedged on benign labels that merely
    // mentioned "exit"): an unrecognised default now degrades to "stuck + a
    // one-time warning" rather than "blindly pressed the wrong button".
    const label = selected.replace(/^❯\s*\d*[.):]?\s*/, ""); // strip "❯ N." prefix
    const proceedDefault =
      /\b(yes|accept|trust|continue|proceed|allow|enable|confirm|ok|i am using this)\b/.test(label);
    if (proceedDefault) {
      this.lastConfirmSig = selected;
      this.sendBootKeys("\r"); // default is a recognised proceed option
    } else if (!this.warnedUnhandledDialog) {
      // Default does not read as a proceed action — don't guess which key is
      // safe. Surface it so the drift is visible (the watchdog / a follow-up
      // can react) instead of silently pressing the wrong button.
      this.warnedUnhandledDialog = true;
      console.error(
        `[boot-dialog] agent=${this.agent_id}: confirm dialog with non-proceed default ` +
          `not auto-answered (selected="${selected.trim().slice(0, 60)}"). REPL may stall.`,
      );
    }
  }

  /** Write one or two keystrokes to the PTY, the second after a short settle so
   *  a bracketed-paste terminal treats them as distinct keys. Swallows write
   *  errors (the PTY can exit mid-boot). */
  private sendBootKeys(first: string, second?: string): void {
    try {
      this.pty.write(first);
      if (second !== undefined) {
        setTimeout(() => {
          try {
            this.pty.write(second);
          } catch {
            /* pty may have exited — non-fatal */
          }
        }, 200);
      }
    } catch {
      /* pty may have exited — non-fatal */
    }
  }

  onExit(handler: ExitHandler): void {
    this.exitHandlers.push(handler);
  }

  onData(handler: DataHandler): void {
    this.dataHandlers.push(handler);
  }

  /** Internal — called by SessionManager.stop(). */
  _kill(signal?: string): void {
    this.endBootDialogPhase();
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
