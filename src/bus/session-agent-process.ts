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
// `pty-output-parser` is a pure module (no bun-pty), so reusing its
// cursor-move→space expander does NOT pull the native PTY dep into the bus
// module — same rationale as importing the sanitiser above.
import { expandCursorForwardToSpaces } from "../runner/pty-output-parser";
import type { SupervisionMode } from "./types";

/** Strip ANSI OSC/CSI escape sequences so dialog matching survives the
 *  cursor-positioning escapes the CLI interleaves into rendered text. Without
 *  this, a raw substring like "development channels" silently stops matching
 *  after a CLI build renders it as "development\x1b[32Gchannels".
 *
 *  CRITICALLY, cursor-move escapes are first EXPANDED to word-boundary spaces
 *  (`expandCursorForwardToSpaces`: CUF `\x1B[<n>C` #119, CHA `\x1B[<n>G` #345),
 *  not merely deleted. claude 2.1.220 lays out dialog affordances by absolute
 *  column ("Enter\x1B[39Gto\x1B[42Gconfirm"), so deleting the escape alone would
 *  glue the words ("Entertoconfirm") and break the literal `includes("Enter to
 *  confirm")` / `includes("Yes, I accept")` dialog gates — leaving a spawned
 *  agent stuck at the boot dialog. This is the bus-path analogue of the #345
 *  pty-supervisor footer hang. */
/**
 * Normalise a prompt for cross-surface comparison (issue #362). The PTY is fed
 * `sanitizePtyPromptText` output while the transcript stores what the CLI
 * parsed, so the two can differ in trailing whitespace and in how a run of
 * spaces survives the input box. Compare on the shape both surfaces agree on.
 */
function normalizePromptForMatch(text: string): string {
  // Whitespace is dropped entirely rather than collapsed. The two surfaces
  // disagree on more than runs of spaces: `sanitizePtyPromptText` preserves a
  // TAB, but a raw 0x09 typed into the TUI is a completion KEY, so it never
  // reaches the transcript at all. Collapsing would leave `"a\tb"` arming
  // `"a b"` against a recorded `"ab"` — a permanent non-match.
  //
  // This is only safe because identity no longer rests on the text: `promptId`
  // and the transcript timestamp are what decide which delivery an ingestion
  // belongs to. The text is a sanity check, not the key.
  return text.replace(/\s+/g, "");
}

/** Tolerance for CLI-vs-daemon clock skew when ordering an ingestion against
 *  the moment its prompt was armed. Same host, so this is generous. */
const INGESTION_CLOCK_SKEW_MS = 2000;

import type { PromptIngestion } from "./jsonl-line-types";

export type { PromptIngestion };

function stripAnsiEscapes(text: string): string {
  return (
    expandCursorForwardToSpaces(text)
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
  /**
   * Epoch ms of the most recent raw output chunk seen on the crash-signal
   * channel, or `null` if none yet. Used by the stall watchdog's auto-discovery
   * forensic as an "is this process emitting anything?" liveness signal — NOT
   * parsed as model output.
   */
  readonly lastDataAt: number | null;
  /** Relay a slash command (e.g. `compact`, `clear`, `quit`). No leading slash. */
  send_slash(cmd: string): Promise<void>;
  /** Send a stream-json line. Only valid in `process-stream-json` mode. */
  send_prompt_stream(line: string): Promise<void>;
  /**
   * Optional: report that the session transcript recorded the CLI ingesting
   * `text` as a top-level user prompt (issue #362). Implementations that have
   * no transcript simply omit this and keep the screen heuristics.
   */
  notePromptIngested?(ingestion: PromptIngestion): void;
  /**
   * Optional: declare that a session transcript is being tailed for this
   * process, so the confirm loop can require its word instead of trusting the
   * rendered terminal in the one window where the terminal is known to lie.
   */
  enableTranscriptConfirmation?(): void;
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
  private _lastDataAt: number | null = null;
  get lastDataAt(): number | null {
    return this._lastDataAt;
  }
  private _exited = false;
  /** Serializes the write/settle/CR sequence so concurrent prompts can't
   *  interleave in the PTY input buffer (review #141 P1). */
  private writeChain: Promise<void> = Promise.resolve();
  /** ANSI-stripped tail of PTY output, reset after each submit so the
   *  delivery-confirm check only inspects post-submit frames (#wedge). */
  private recentOut = "";
  /**
   * Sticky auto-compaction state, maintained on the DATA STREAM rather than
   * sampled from `recentOut`.
   *
   * Why sticky: the delivery-confirm loop clears `recentOut` at the top of every
   * confirm window, so an in-window `includes("Compacting…")` probe only sees the
   * banner if the CLI happens to REPAINT that phrase inside that 1.5s slice. The
   * real CLI paints it once and then renders a bare spinner -- and when the
   * compaction started BEFORE the prompt arrived (the common case: the inbound
   * prompt is what pushed the context over the limit) the banner is emitted
   * before the loop even begins and is wiped by the first reset. The probe then
   * sees "non-empty output, no idle footer" and declares a turn started that
   * never existed. Dossier 20260825T071822: compaction at 11:12:35, prompt
   * written 11:12:36.8, false turn-start stamped 11:12:38.313.
   */
  private compacting = false;
  /** Incremented on every compaction START, so a compaction that begins AND ends
   *  between the prompt write and the first confirm window is still observable. */
  private compactionEpoch = 0;
  /** Small rolling buffer used ONLY for compaction-marker detection. Separate
   *  from `recentOut` because the confirm loop clears that one, and a marker
   *  split across two PTY chunks would otherwise be missed -- missing the CLEAR
   *  would latch `compacting` forever and make every later prompt burn the full
   *  `maxCompactionWaitMs`. */
  private markerTail = "";
  /** The exact text last typed into the PTY. The output stream echoes it back,
   *  so without excluding it a chat message containing "Compacting conversation"
   *  would arm the latch below — remote text controlling a process-wide, sticky
   *  state. The pre-image was window-scoped so poisoning cost ~1.5s; a sticky
   *  latch costs `maxCompactionWaitMs` (240s) on a write chain that serialises
   *  EVERY prompt for the agent. The inverse is just as bad: text containing
   *  "to cycle" would clear a genuine compaction. This is not only an abuse
   *  case — an agent discussing its own compaction logic reproduces these
   *  strings in ordinary output. */
  private lastWritten = "";
  /** Cap on the text `stripEcho` matches against — see where it is assigned. */
  private static readonly ECHO_MATCH_MAX = 4096;

  /**
   * Remove our own echo from a slice of PTY output.
   *
   * The CLI renders the prompt we typed in its input box, so the text a chat
   * user sent comes straight back on the output stream. Every probe in this file
   * reads that stream, which means remote text can impersonate CLI status lines:
   * a message containing "Compacting conversation" makes the delivery loop wait
   * out `maxCompactionWaitMs` (240s by default) on a write chain that serialises
   * EVERY prompt for the agent, and one containing "to cycle" makes a genuine
   * compaction look finished.
   *
   * SCOPE, precisely: this removes OUR OWN ECHO only — lines that are a
   * substring of the prompt we just typed. Model OUTPUT containing the same
   * strings still arms the latch; that path is bounded because the idle footer
   * repaint clears it at turn end, but it is NOT closed here. Do not read this
   * helper as covering "an agent that discusses its own compaction logic".
   *
   * It also cuts both ways: a prompt that is a pasted CLI transcript containing
   * "to cycle" makes the genuine footer line a substring of `lastWritten`, so it
   * is stripped from every window and an idle REPL reads as a started turn. That
   * is the pre-patch behaviour, not a new regression, but it is a live
   * false-positive path for a plausible prompt.
   *
   * Filter by LINE rather than by exact occurrence: the buffers are rolling, so
   * the echo is routinely truncated mid-string and an exact match would leave a
   * fragment that still carries the marker. A line that is itself a substring of
   * what we typed is our echo; a genuine CLI status line never is.
   */
  private stripEcho(s: string): string {
    if (this.lastWritten.length < 8) return s;
    return s
      .split("\n")
      .filter((l, i) => {
        // TWO conditions, both required.
        //
        // (a) The row must LOOK like the input box: optional border/padding
        //     glyphs, then the prompt caret `>`. The TUI paints our text as
        //     `| > <text>  ...padding... |`, while CLI status lines start with a
        //     letter ("Compacting conversation…") and the idle footer with its
        //     own glyph and no caret ("> accept edits … to cycle" has no caret
        //     before "accept"). Without this, a prompt that merely CONTAINS
        //     "Compacting conversation" or "to cycle" would strip the CLI's own
        //     status and footer lines, killing detection and reintroducing the
        //     dropped-prompt wedge — the inverse of the bug this helper fixes.
        //
        // (b) The content must be a substring of what we typed. Strip BOTH ends
        //     first: keeping the trailing border made the match fail and let the
        //     echo through.
        // The FIRST line is the only one the rolling buffer can have truncated
        // mid-way, which strips its caret. Judge that one on content alone; every
        // other line must show the caret to count as our echo.
        if (i > 0 && !/^[^A-Za-z0-9]*>/.test(l)) return true;
        const bare = l
          .replace(/^[^A-Za-z0-9]*>/, "")
          .replace(/[^A-Za-z0-9]+$/, "")
          .trim();
        return bare.length < 8 || !this.lastWritten.includes(bare);
      })
      .join("\n");
  }
  /** When the latch was armed, so a missed clear cannot strand it indefinitely. */
  private compactingSince = 0;
  private readonly submitConfirmMs: number;
  private readonly maxSubmitNudges: number;
  private readonly maxCompactionWaitMs: number;
  /** Boot-dialog watcher state (issue #193). Claude shows interactive
   *  confirmation dialogs at startup (the trust-folder prompt, the dev-channels
   *  prompt, and the "Bypass Permissions mode" prompt). We answer them by
   *  inspecting early PTY output and sending the correct key per dialog. The
   *  watcher stays engaged until claude actually reaches the REPL (detected via
   *  the footer marker) or a bounded timeout — NOT until the first prompt.
   *  Codex P2 on PR #195: a dialog can render AFTER an early heartbeat/scheduler
   *  prompt on a slow fresh-install boot, so disengaging on first-prompt left
   *  late dialogs unanswered and the agent stuck at "No, exit". */
  private bootDialogActive = true;
  private bootDialogBuffer = "";
  private answeredBypassPrompt = false;
  private answeredTrustPrompt = false;
  /** Signature of the last generic confirm-dialog we answered, so we send one
   *  Enter per distinct dialog instead of on every render chunk. */
  private lastConfirmSig: string | null = null;
  private warnedUnhandledDialog = false;
  /** One-shot guard so an unconfirmed delivery is surfaced once per process
   *  (see the delivery-confirm loop) instead of spamming the log. */
  private warnedUnconfirmedDelivery = false;
  /**
   * Issue #362 — authoritative delivery signal.
   *
   * `pendingPromptMatch` is the normalised text of the prompt currently being
   * delivered; `promptIngested` flips when the session transcript records the
   * CLI ingesting exactly that text. Only `send_prompt_stream` arms and
   * disarms them, and the write chain serialises prompts, so at most one is
   * ever in flight.
   *
   * This exists because every other probe in the confirm loop reads the
   * rendered terminal, where a post-compaction repaint is byte-identical to a
   * streaming turn. The transcript is written by the CLI when it actually
   * ingests the prompt — a fact, not an inference from pixels.
   */
  private pendingPromptMatch: string | null = null;
  private pendingArmedAtMs = 0;
  private promptIngested = false;
  /**
   * Records already accepted, keyed by `promptId` + normalised text. The bus re-delivers a prompt verbatim on
   * flush-verify, so the same text can be armed twice; without this a late
   * event for the FIRST delivery would confirm the second — a phantom success
   * of exactly the kind this whole mechanism exists to remove. Bounded: only
   * the recent past can plausibly arrive late.
   */
  private readonly consumedPromptIds = new Set<string>();
  private static readonly CONSUMED_PROMPT_IDS_MAX = 64;
  /**
   * How many `user` records we still owe to ALREADY-CONFIRMED deliveries,
   * keyed by normalised text (issue #363 adversarial pass, finding 1).
   *
   * An `enqueue` record says the CLI took the keystrokes; the matching `user`
   * line is written later, when it actually runs the prompt. If the bus
   * re-delivers the same text in between — which `flushVerify` does verbatim,
   * on a timer — that late `user` line is a FIRST sighting, so `consumedPromptIds`
   * does not know it, and `user` records are deliberately exempt from the
   * timestamp check because the CLI backdates them. Nothing else rejected it,
   * so it confirmed the delivery still sitting un-submitted in the input box.
   *
   * Identity cannot separate the two: two submissions of byte-identical text
   * carry different `promptId`s, and we never learn which one is ours. So we
   * count instead. Confirming by `enqueue` owes one `user` record; the next
   * matching `user` record pays that debt and is absorbed rather than credited.
   */
  private readonly outstandingEnqueues = new Map<string, { count: number; lastSeenMs: number }>();
  private static readonly OUTSTANDING_ENQUEUE_MAX = 256;
  /**
   * How long an accepted-but-unrun submission stays outstanding. The measured
   * `user`-line tail on a busy session is 443 s; this is that with room to
   * spare. Past it, the queue entry is assumed gone — a session file rotated,
   * a CLI that dropped the queue without writing a withdrawal — because an
   * entry that never expires eventually absorbs a legitimate confirmation and
   * makes the bus re-deliver a prompt the agent already ran (second
   * adversarial pass, finding 4).
   */
  private static readonly OUTSTANDING_ENQUEUE_TTL_MS = 15 * 60_000;
  /**
   * True once a JSONL tailer is feeding `notePromptIngested`. Gates the
   * stricter post-compaction rule below: without a transcript there is nothing
   * better than the screen, so the original heuristics must stay in force.
   */
  private transcriptAvailable = false;
  private readonly transcriptGraceMs: number;
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
      /** How long to keep waiting for the transcript once the screen alone
       *  would have declared a turn. The union of the two transcript records
       *  has a measured p95 of 0.25s and a 0.27s maximum across 56 deliveries,
       *  so this default is roughly 10x the observed worst case. */
      transcriptGraceMs?: number;
    } = {},
  ) {
    this.agent_id = agent_id;
    this.pty = pty;
    this.pid = pty.pid;
    this.submitConfirmMs = opts.submitConfirmMs ?? 1500;
    this.transcriptGraceMs = opts.transcriptGraceMs ?? 3000;
    this.maxSubmitNudges = opts.maxSubmitNudges ?? 2;
    this.maxCompactionWaitMs = opts.maxCompactionWaitMs ?? 240_000;
    this.bootDialogTimer = setTimeout(
      () => this.endBootDialogPhase(),
      PtyAgentProcess.BOOT_DIALOG_MAX_MS,
    );
    pty.onData((chunk) => {
      this._lastDataAt = Date.now();
      if (this.bootDialogActive) this.handleBootDialog(chunk);
      // Keep a small ANSI-stripped tail so send_prompt_stream can tell whether a
      // submit actually started a turn (the idle REPL footer disappears on turn
      // start) -- see the delivery-confirm loop. Observation only.
      const cleanChunk = stripAnsiEscapes(chunk);
      this.recentOut = (this.recentOut + cleanChunk).slice(-2000);
      // Sticky compaction latch (see `compacting`): set on the banner, cleared
      // only on POSITIVE evidence the compaction ended -- the "Compacted"
      // confirmation or the idle REPL footer coming back. A spinner frame in
      // between must NOT clear it.
      this.markerTail = (this.markerTail + cleanChunk).slice(-400);
      const markerView = this.stripEcho(this.markerTail);
      // Compare the LAST position of a start marker against the last position of
      // an end marker, so whichever happened most recently wins. A plain
      // set-then-else-clear would stay latched whenever both strings are still
      // in the buffer, and testing a single chunk would miss a marker split
      // across a chunk boundary.
      const iStart = Math.max(
        markerView.lastIndexOf("Compacting conversation"),
        markerView.lastIndexOf("Compacting at auto"),
      );
      const endMatches = [...markerView.matchAll(/Compacted \(|to\s*cycle/g)];
      const iEnd = endMatches.length ? (endMatches[endMatches.length - 1].index ?? -1) : -1;
      if (iStart >= 0 || iEnd >= 0) {
        const nowCompacting = iStart > iEnd;
        if (nowCompacting && !this.compacting) {
          this.compactionEpoch++;
          this.compactingSince = Date.now();
        }
        this.compacting = nowCompacting;
      }
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
      // Snapshot the compaction state at write time. A compaction that was
      // ALREADY running when the prompt arrived (the common case -- the inbound
      // prompt is what overflowed the context) can also FINISH during the 200ms
      // settle below, i.e. before the confirm loop ever looks. Both the live
      // latch and the epoch counter are captured so neither case is missed.
      // A prompt must not inherit the previous one's markers: the buffer is
      // rolling and 400 chars of A's output can still be resident when B lands.
      this.markerTail = "";
      // Bound what the echo filter scans. `text` is caller-supplied and only
      // length-bounded by the adapter, while `stripEcho` runs `includes()` per
      // line on EVERY PTY chunk -- an oversized prompt would make each chunk
      // cost O(prompt x lines) for the life of the process. The input box only
      // ever echoes a screenful, so the head is the part that can come back.
      this.lastWritten = text.slice(0, PtyAgentProcess.ECHO_MATCH_MAX);
      // Issue #362: arm the transcript watcher BEFORE the write. The CLI can
      // ingest the prompt during the 200ms settle below — arming afterwards
      // would miss exactly the fast case and fall back to reading pixels.
      // A prompt that normalises to nothing — whitespace only — would arm the
      // empty string and then match ANY whitespace-only record in the
      // transcript, confirming a delivery it has no evidence for. Nothing to
      // compare on means nothing to confirm on: stay disarmed and let the
      // screen heuristic decide (adversarial pass, finding 4).
      const armed = normalizePromptForMatch(text);
      this.pendingPromptMatch = armed === "" ? null : armed;
      this.pendingArmedAtMs = Date.now();
      this.promptIngested = false;
      const compactingAtWrite = this.compacting;
      const compactionEpochAtWrite = this.compactionEpoch;
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
      let outcome: "turn-started" | "stuck-compaction" | "unconfirmed-idle" | "unconfirmed-live" =
        "unconfirmed-idle";
      // When the screen first claimed a turn while a live transcript had not
      // yet spoken. Bounds how long that claim is held unresolved.
      let screenClaimedTurnAtMs = 0;
      let sawCompaction = compactingAtWrite || this.compactionEpoch !== compactionEpochAtWrite;
      let retypedAfterCompaction = false;
      // Latched as soon as any window shows real output that is neither the idle
      // footer nor compaction chatter. If the CLI buffered the keystrokes through
      // the compaction and ran the turn itself, that turn's output lands here --
      // and a short turn can start AND finish inside one confirm window, so the
      // same window can hold both the output and the repainted footer. Without
      // this latch the footer alone would read as "no turn ran" and the retype
      // would submit the prompt a second time.
      let turnEvidenceSinceCompaction = false;
      for (let nudge = 0; nudge < this.maxSubmitNudges; ) {
        this.recentOut = "";
        await new Promise((r) => setTimeout(r, this.submitConfirmMs));
        // Exit mid-confirm must REJECT, in parity with the two pre-CR checks
        // above: the CR is not proof of delivery (the whole point of this loop),
        // so resolving here would report a phantom success for a prompt whose
        // target just died -- suppressing re-queue and masking the wedge.
        if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
        // Issue #362 — the transcript settles this window before any screen
        // heuristic gets a say. The CLI wrote a `user` entry for this exact
        // prompt, which it only does once it has actually ingested it. That
        // outranks every probe below, all of which infer delivery from the
        // rendered terminal and therefore cannot tell a submitted prompt from
        // a post-compaction repaint (the 2026-08-27 false positive).
        //
        // Checking here also removes the retype's remaining double-submit
        // risk: a confirmed ingestion exits the loop before the retype branch
        // can fire on a stale idle footer.
        if (this.promptIngested) {
          outcome = "turn-started";
          this.warnedUnconfirmedDelivery = false;
          break;
        }
        // Anchor the compaction probe to the CLI status line ("Compacting
        // conversation" / "Compacting at auto window") rather than the bare word
        // "Compacting", which also occurs in ordinary model output: a live turn
        // streaming that word would otherwise be mistaken for a compaction and
        // stall this loop -- and the serialised writeChain behind it -- up to the
        // deadline.
        // Every probe below reads this echo-free view, never `recentOut`
        // directly: our own prompt text must not be able to impersonate a CLI
        // status line, an idle footer, or turn output.
        const visible = this.stripEcho(this.recentOut);
        if (this.compactionEpoch !== compactionEpochAtWrite) sawCompaction = true;
        // A latch that never saw its clear (marker lost) must not strand the
        // process: treat it as stale once it outlives the compaction budget.
        if (
          this.compacting &&
          this.compactingSince > 0 &&
          Date.now() - this.compactingSince > 2 * this.maxCompactionWaitMs
        ) {
          this.compacting = false;
          // Also drop the buffer: leaving the start marker resident means the
          // next chunk re-evaluates it, sees `!compacting`, and re-arms with a
          // fresh budget — the escape hatch would never actually fire.
          this.markerTail = "";
          // Do not judge THIS window: it still holds the output of the
          // compaction that is (apparently) still running, and reading it as a
          // started turn is the exact regression the latch exists to prevent.
          if (Date.now() > compactionDeadline) {
            outcome = "stuck-compaction";
            break;
          }
          continue;
        }
        if (
          this.compacting ||
          visible.includes("Compacting conversation") ||
          visible.includes("Compacting at auto")
        ) {
          sawCompaction = true;
          screenClaimedTurnAtMs = 0; // the screen is not claiming a turn here
          // Evidence of a running turn only means anything AFTER the compaction:
          // before it, the echoed input line (the prompt sitting un-submitted in
          // the box) is itself non-footer output and would gate the retype off.
          turnEvidenceSinceCompaction = false;
          if (Date.now() > compactionDeadline) {
            outcome = "stuck-compaction";
            break;
          }
          continue; // compaction in progress -> wait, do not spend a nudge
        }
        const footerVisible = /to\s*cycle/.test(visible);
        // The idle footer is positive evidence that no turn is running, so any
        // earlier screen claim is withdrawn and its clock restarts.
        if (footerVisible) screenClaimedTurnAtMs = 0;
        // Everything in this window that is not a footer repaint and not a
        // spinner glyph. Printable ASCII only, so box-drawing and braille
        // spinner frames do not register as output.
        // Drop footer repaints and compaction chatter LINE BY LINE, not
        // window-wide: the window in which a short buffered turn finishes also
        // carries the "Compacted (…)" line, so discarding the whole window on
        // that basis would throw away the very output that proves a turn ran.
        const nonFooterOutput = visible
          .split("\n")
          .filter((l) => !/to\s*cycle/.test(l) && !/Compact(ing|ed)/.test(l))
          .join("")
          // Drop spinner frames and whitespace ONLY. Stripping everything
          // non-ASCII would erase a turn whose output is emoji or box-drawing
          // chrome, read the window as "no turn ran", and retype into a live
          // turn — the one path that submits a prompt twice.
          .replace(/[\u2800-\u28ff\u2500-\u257f\u25a0-\u25ff\u2022\u00b7\s]/g, "")
          .trim();
        if (nonFooterOutput.length > 0) {
          turnEvidenceSinceCompaction = true;
        }
        // The compaction's own tail ("Compacted (ctrl+o …)") is non-empty output
        // with no idle footer -- i.e. it looks exactly like a streaming turn to
        // the check below. It is not evidence of anything: stay inconclusive
        // (bounded by the same deadline) rather than spend a nudge on it.
        // Only "Compacted (" is reachable here: the two "Compacting…" markers are
        // already `continue`d by the branch above.
        if (!footerVisible && visible.includes("Compacted (")) {
          if (Date.now() > compactionDeadline) {
            outcome = "stuck-compaction";
            break;
          }
          continue;
        }

        // A turn-start is POSITIVE evidence -- the streaming view replaced the
        // footer. An EMPTY confirm window is NOT that: a long-idle, quiet REPL
        // emits nothing, so `!/to\s*cycle/.test(...)` on an empty buffer falsely
        // reads as turn-started, stops the nudging, and leaves the prompt
        // un-submitted until the 5-min receipt timeout. This is the residual
        // idle-REPL wedge (dossier 20260612T080557: idle 7h, stdin written,
        // turn_started_at absent, socket=no -- with the full delivery+compaction
        // fix stack already active). Require real output before trusting the
        // footer's absence; an empty/whitespace window stays inconclusive and
        // spends a nudge instead of claiming a phantom success.
        if (visible.trim().length > 0 && !footerVisible) {
          // Issue #362 — the 2026-08-27 false positive lands exactly here.
          // After a compaction the CLI repaints the restored transcript for
          // seconds; those repaints are non-empty, carry no idle footer, and
          // `Compacted (` has already scrolled out of this rolling window.
          // Byte for byte, that is a streaming turn.
          //
          // This deliberately does NOT test whether a compaction was seen.
          // `sawCompaction` is itself derived from the screen, and it is blind
          // to the production ordering: a compaction that STARTED BEFORE this
          // prompt was written and ENDED BEFORE it too bumps the epoch ahead of
          // the snapshot, clears the latch, and shows no start banner — which
          // is precisely the 2026-08-27 timeline (compaction ends 14:04:43,
          // prompt written 14:04:47). Gating on it would leave the reported
          // failure untouched.
          //
          // So: whenever a transcript is proven live, it is the only thing that
          // may CONFIRM a turn. The screen's claim is held, unresolved and
          // without spending a nudge, for a bounded grace period. If the
          // transcript still has not spoken, the honest answer is "unknown" —
          // not "yes" (the wedge) and not "no" (which would strand a turn that
          // really is running).
          if (this.transcriptAvailable) {
            // Reset whenever the screen stops claiming (see the idle/compaction
            // branches): otherwise one repaint window before a compaction burns
            // the whole grace, and the post-compaction turn — the case this
            // machinery exists for — gets none of it.
            if (screenClaimedTurnAtMs === 0) screenClaimedTurnAtMs = Date.now();
            if (Date.now() - screenClaimedTurnAtMs < this.transcriptGraceMs) continue;
            outcome = "unconfirmed-live";
            break;
          }
          outcome = "turn-started";
          // A turn confirmed → re-arm the one-shot wedge warning, so a LATER
          // genuine wedge on this long-lived process still surfaces a diagnostic
          // instead of being silenced for the rest of the process lifetime.
          this.warnedUnconfirmedDelivery = false;
          break;
        }
        // Only now, with the idle footer positively on screen (so no turn is
        // running), consider that a compaction wiped the input box. Retyping
        // without that gate would push a duplicate prompt into a live turn if
        // the CLI had buffered the keystrokes and submitted them itself.
        if (
          sawCompaction &&
          !retypedAfterCompaction &&
          footerVisible &&
          !turnEvidenceSinceCompaction
        ) {
          retypedAfterCompaction = true;
          if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
          this.pty.write("\x15"); // clear whatever survived the re-render
          this.pty.write(text);
          await new Promise((r) => setTimeout(r, 200));
          if (this._exited) throw new Error(`agent ${this.agent_id} has exited`);
          this.pty.write("\r");
          continue; // the retype is not a nudge
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
      // The prompt is no longer in the input box once this resolves, so the echo
      // filter has nothing left to match. Clearing it keeps the filter from
      // running against unrelated output for the whole idle period after a turn.
      this.lastWritten = "";
      // Disarm alongside the echo filter: a late transcript event for a prompt
      // this loop already resolved must not confirm the NEXT one. The arm
      // above resets both fields anyway, so an early throw cannot strand them.
      this.pendingPromptMatch = null;
      this.promptIngested = false;
      if (outcome === "unconfirmed-live") {
        // Distinct from the wedge warnings, and deliberately NOT one-shot-
        // silenced: this says the screen looked like a turn while the
        // transcript stayed quiet past the grace period. It is a real
        // ambiguity worth seeing every time, and burning the one-shot flag
        // here would mute a genuine wedge later in this process's life.
        console.warn(
          `[delivery-confirm] agent=${this.agent_id}: screen showed turn output but ` +
            `the session transcript did not record the prompt within ` +
            `${this.transcriptGraceMs}ms; reporting unconfirmed rather than guessing.`,
        );
      } else if (outcome !== "turn-started" && !this.warnedUnconfirmedDelivery) {
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
   *  (dev-channels) is confirmed with Enter. Two known dialogs default to a
   *  destructive "No, exit" instead — the bypass-permissions prompt, and (as of
   *  a claude CLI update that flipped its default off "Yes, I trust this
   *  folder" — dossier 20260907, discord-bot stuck in a respawn loop after
   *  every restart) the trust-folder prompt — both handled specifically with
   *  Down+Enter. An unrecognised dialog whose default looks destructive is NOT
   *  auto-answered (we log once instead), so a future CLI change degrades to
   *  "stuck + a warning" rather than "blindly pressed the wrong button". */
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

    // Trust-folder dialog ("Quick safety check: Is this a project you
    // created...") — this agent's cwd is operator-configured (settings.json
    // `agents[].cwd`), so trusting it here mirrors the operator's own intent,
    // same as the bypass-permissions and dev-channels dialogs below. Some
    // claude CLI builds preselect "No, exit" for this dialog (confirmed live
    // against 2.1.263, cwd already trusted from prior sessions — the trust
    // grant does not carry over to a fresh --session-id), which used to blind-
    // Enter into exit and kill the agent before the fail-safe generic branch
    // was tightened; now it just wedges silently instead. Move the selection
    // to the trust row first, same pattern as the bypass-permissions dialog.
    if (buf.includes("Yes, I trust this folder")) {
      if (this.answeredTrustPrompt) {
        // Already sent Down+Enter for this dialog — a redraw now shows the
        // trust row selected, but must NOT fall through to the generic
        // branch below, which would fire a second, racing blind Enter
        // (same hazard as the bypass-permissions dialog, Codex F3 on #195).
        return;
      }
      // Some builds still default to the trust row (❯ right next to "Yes, I
      // trust this folder") — that case is a plain proceed default and the
      // generic branch below already handles it correctly with a bare Enter.
      // Only intervene when "No, exit" is the one actually selected.
      const trustAlreadySelected = /❯\s*\d*[.):]?\s*Yes, I trust this folder/.test(buf);
      if (!trustAlreadySelected) {
        this.answeredTrustPrompt = true;
        this.sendBootKeys("\x1b[B", "\r"); // Down, then Enter
        return;
      }
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

  /**
   * Issue #362 — called by the session JSONL tailer when the transcript shows
   * the CLI ingested a top-level user prompt. Ignored unless it matches the
   * prompt currently in flight: the transcript also carries prompts this
   * process never typed (a resumed session's harness nudge, for one), and
   * treating those as confirmation would report delivery for a prompt still
   * sitting un-submitted in the input box.
   */
  /** Issue #362 — see `transcriptAvailable`. Called by the session manager
   *  when it binds a JSONL tailer to this process. */
  enableTranscriptConfirmation(): void {
    this.transcriptAvailable = true;
  }

  notePromptIngested(ingestion: PromptIngestion): void {
    // Key on promptId AND the text, never on promptId alone.
    //
    // A `promptId` identifies a submission, not a record: an auto-compaction
    // emits a cluster of `user` lines under one id — the continuation summary,
    // the `/compact` command echo, its stdout — and the summary is written
    // BEFORE the real prompt. Keying on the id alone let the summary consume
    // it, so the actual prompt's record was dismissed as already seen and could
    // never confirm. That failed in precisely the auto-compaction case this
    // mechanism exists for, and `enqueue` does not cover it: a prompt that
    // TRIGGERS a compaction is not queued behind a running turn.
    // An `enqueue` record carries no `promptId`, so keying on the id alone left
    // it with no identity at all: never recorded, never deduped, and free to
    // confirm again on any re-read of the same line (adversarial pass,
    // finding 3). Its transcript timestamp is written once, at acceptance, so
    // timestamp + text identifies the record even though it identifies no
    // submission. A stamp we cannot read yields no key — and the timestamp
    // check below refuses that record anyway.
    const key = ingestion.promptId
      ? `${ingestion.promptId}\u0000${normalizePromptForMatch(ingestion.text)}`
      : ingestion.source === "enqueue" && ingestion.ingestedAtMs > 0
        ? `enqueue\u0000${ingestion.ingestedAtMs}\u0000${normalizePromptForMatch(ingestion.text)}`
        : null;
    const alreadySeen = key ? this.consumedPromptIds.has(key) : false;
    // Record the id FIRST, before any early return.
    //
    // A delivery routinely ends with the transcript still silent, so its record
    // arrives while nothing is armed. Returning early without recording it left
    // that record eligible to confirm the NEXT arming of the same text — and
    // the bus re-delivers verbatim on flush-verify, so "the same text again" is
    // a coded path, not a coincidence. That phantom confirmation is the exact
    // failure this mechanism exists to remove.
    if (key && !alreadySeen) {
      if (this.consumedPromptIds.size >= PtyAgentProcess.CONSUMED_PROMPT_IDS_MAX) {
        // Set iteration is insertion-ordered, so this is genuinely the oldest.
        const oldest = this.consumedPromptIds.values().next().value;
        if (oldest !== undefined) this.consumedPromptIds.delete(oldest);
      }
      this.consumedPromptIds.add(key);
    }

    const normalised = normalizePromptForMatch(ingestion.text);

    // ── The queue is a conservation law, not a side effect of confirming ──
    //
    // First cut booked the debt only where an `enqueue` actually confirmed a
    // delivery. Every enqueue refused for any other reason booked nothing —
    // yet the CLI still had the prompt queued and still wrote its `user` line
    // later, which then confirmed the NEXT delivery of the same text. The
    // original phantom, untouched. Worse, refusing an unusable timestamp is
    // what SKIPPED the booking, so that guard manufactured the very failure it
    // was added to prevent (second adversarial pass, finding 1).
    //
    // What the transcript actually tells us is a count: how many submissions
    // of this text the CLI has accepted but not yet run. `enqueue` increments
    // it, `user` and a withdrawal decrement it. Whether any of them confirms
    // one of OUR deliveries is a separate question, asked afterwards.
    // Gated on `alreadySeen`: the count is a ledger, and a record presented
    // twice must not be counted twice in either direction. This is what makes
    // the identity key above load-bearing rather than decorative — without the
    // gate, a re-read enqueue books a phantom queue entry that later absorbs a
    // legitimate confirmation, and a re-read `user` line pays down two.
    if (!alreadySeen && ingestion.source === "enqueue") this.noteEnqueueObserved(normalised);
    if (!alreadySeen && ingestion.source === "user" && this.consumeOutstandingEnqueue(normalised)) {
      // This `user` line belongs to a submission accepted earlier and only now
      // running. It is evidence about that one, not about whatever is armed.
      return;
    }

    if (this.pendingPromptMatch === null) return;
    if (alreadySeen) return;
    // Staleness by timestamp applies to `enqueue` ONLY. Its timestamp tracks
    // acceptance within ~0.2s, whereas the CLI backdates `user` lines — observed
    // by up to 148s (a line written at 14:04:43 stamped 14:02:15). Judging a
    // `user` record stale on its own timestamp would discard live confirmations.
    //
    // An unusable timestamp REFUSES the record instead of waving it through.
    // The enqueue path carries no `promptId`, so this check is the only thing
    // deciding which delivery it belongs to; treating a missing stamp as
    // "recent enough" made a 60s-stale enqueue confirm whatever was armed
    // (adversarial pass, finding 2). Refusing costs a fall back to the screen
    // heuristic and its grace; accepting reports a delivery that never
    // happened, which is the failure this whole mechanism exists to remove.
    if (ingestion.source === "enqueue" && !this.enqueueStampBelongsToThisDelivery(ingestion)) {
      return;
    }
    if (normalised !== this.pendingPromptMatch) return;
    this.promptIngested = true;
  }

  /**
   * Whether an `enqueue` record's timestamp places it inside the delivery
   * currently in flight. Every way a stamp can be unusable is refused rather
   * than waved through: the enqueue path carries no `promptId`, so this is the
   * only thing deciding which delivery the record belongs to.
   *
   * A stamp in the future is unusable too — a forward clock skew on the CLI is
   * not hypothetical, and an absurd one also poisons the dedupe key built from
   * it.
   *
   * There is deliberately no `Number.isFinite` guard. A previous round added
   * one and justified it with "a bare `< armed` test let NaN through" — but
   * the comparison below is `>=` inside a `return`, and `NaN >= x` is false,
   * so NaN was already refused. Deleting the guard left every test green: it
   * was dead code dressed as a fix, the exact thing the round before it was
   * criticised for. The tailer also maps non-finite stamps to `0`
   * (`jsonl-tailer.ts`), which `ts <= 0` catches.
   *
   * Refusing costs a fall back to the screen heuristic and its grace period.
   * Accepting reports a delivery that never happened — the failure this whole
   * mechanism exists to remove — so the asymmetry is deliberate.
   */
  private enqueueStampBelongsToThisDelivery(ingestion: PromptIngestion): boolean {
    const ts = ingestion.ingestedAtMs;
    if (ts <= 0) return false;
    if (ts > Date.now() + INGESTION_CLOCK_SKEW_MS) return false;
    return ts >= this.pendingArmedAtMs - INGESTION_CLOCK_SKEW_MS;
  }

  /**
   * Record that the CLI accepted one more submission of this text. Called for
   * EVERY `enqueue` record seen, whatever it goes on to confirm — the count is
   * a fact about the CLI's queue, not about our confirmation logic.
   */
  private noteEnqueueObserved(normalised: string): void {
    this.expireOutstandingEnqueues();
    const entry = this.outstandingEnqueues.get(normalised);
    if (entry) {
      entry.count += 1;
      entry.lastSeenMs = Date.now();
      return;
    }
    if (this.outstandingEnqueues.size >= PtyAgentProcess.OUTSTANDING_ENQUEUE_MAX) {
      // Only reachable when 256 distinct texts are queued and unrun inside the
      // TTL. Dropping the oldest restores the phantom for that one text, which
      // is worse than the memory — but unbounded growth in a daemon that runs
      // for weeks is not acceptable either, so bound generously and evict only
      // after the TTL sweep above has already failed to free anything.
      const oldest = this.outstandingEnqueues.keys().next().value;
      if (oldest !== undefined) this.outstandingEnqueues.delete(oldest);
    }
    this.outstandingEnqueues.set(normalised, { count: 1, lastSeenMs: Date.now() });
  }

  /**
   * Account one outstanding submission of this text as run (or withdrawn).
   * Returns true when there WAS one — meaning the record just seen belongs to
   * that earlier submission and must not be credited to whatever is armed now.
   *
   * Decrements by one. The first cut deleted the whole entry, so a single
   * withdrawal wiped every outstanding copy of a text the bus had queued twice
   * — and the survivor's `user` line then confirmed the next delivery (second
   * adversarial pass, finding 2).
   */
  private consumeOutstandingEnqueue(normalised: string): boolean {
    this.expireOutstandingEnqueues();
    const entry = this.outstandingEnqueues.get(normalised);
    if (!entry || entry.count <= 0) return false;
    entry.count -= 1;
    entry.lastSeenMs = Date.now();
    if (entry.count === 0) this.outstandingEnqueues.delete(normalised);
    return true;
  }

  /** Drop queue entries old enough that their `user` line is never coming. */
  private expireOutstandingEnqueues(): void {
    if (this.outstandingEnqueues.size === 0) return;
    const cutoff = Date.now() - PtyAgentProcess.OUTSTANDING_ENQUEUE_TTL_MS;
    for (const [text, entry] of this.outstandingEnqueues) {
      if (entry.lastSeenMs < cutoff) this.outstandingEnqueues.delete(text);
    }
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
  private _lastDataAt: number | null = null;
  get lastDataAt(): number | null {
    return this._lastDataAt;
  }
  private _exited = false;

  constructor(agent_id: string, supervision: SupervisionMode, child: ChildProcess) {
    this.agent_id = agent_id;
    this.supervision = supervision;
    this.child = child;
    this.pid = child.pid ?? -1;
    // Capture stdout/stderr for crash-diag observation. We do NOT parse output —
    // this is purely a crash-signal channel (spec §5.3).
    const forward = (chunk: Buffer | string): void => {
      this._lastDataAt = Date.now();
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
