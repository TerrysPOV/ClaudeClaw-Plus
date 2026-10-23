/**
 * #562 soak and round 2: a PTY turn was reported "done" (exit 0) when the prompt never
 * reached the model, then, after the screen-based fix, could still be forged by a prompt's
 * own echo, scrollback, or a chunk boundary.
 *
 * The rule these tests pin: the SCREEN is never evidence that a prompt was accepted, that
 * a turn finished, or of what the answer was. Only the session transcript is. So most
 * tests here put the screen and the transcript in disagreement (done chrome with an empty
 * transcript, or a finished transcript under chaotic chrome) and check the transcript wins.
 *
 * The fake TUIs are real `/bin/sh` children that write a real JSONL file
 * (`fixtures/fake-claude-tui.ts`). The kernel's cooked-mode echo stands in for claude's
 * input box. No test gets its acceptance from the prompt's own echo: the prompts carry no
 * marker phrase, except the forgery tests, which exist to show the phrase proves nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecurityConfig } from "../config";
import {
  PtyClosedError,
  PtyPromptNotAcceptedError,
  PtyTranscriptUncertainError,
  PtyTranscriptUnavailableError,
  PtyTurnFailedError,
  PtyTurnTimeoutError,
  TranscriptReplacedError,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/index";
import {
  append,
  appendRaw,
  assistantLine,
  CHROME_BUSY,
  CHROME_DONE,
  CHROME_STALE,
  fakeTurn,
  systemLine,
  type TempTranscript,
  tempTranscript,
  userLine,
} from "./fixtures/fake-claude-tui";

const NO_SECURITY: SecurityConfig = {
  level: "unrestricted",
  allowedTools: [],
  disallowedTools: [],
};
const PROMPT = "R17x please";

const made: TempTranscript[] = [];
function tx(seed = ""): TempTranscript {
  const t = tempTranscript();
  made.push(t);
  if (seed) writeFileSync(t.path, seed);
  return t;
}
afterEach(() => {
  delete process.env.CLAUDECLAW_PTY_DUMP;
  while (made.length) made.pop()?.cleanup();
});

function opts(
  script: string,
  t: TempTranscript,
  over: Partial<PtyProcessOptions> = {},
): PtyProcessOptions {
  return {
    sessionId: "",
    cwd: "/tmp",
    security: NO_SECURITY,
    env: { ...process.env } as Record<string, string>,
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", script],
    transcriptPath: t.path,
    cols: 80,
    rows: 24,
    quietWindowMs: 50,
    settleCapMs: 400,
    // Longer than the fakes' think time, so a turn that wrongly "completes" finishes before
    // this timer could reject it: a test that goes red under a fault must go red because of
    // the fault, not a race.
    submitConfirmMs: 400,
    ...over,
  };
}

async function runOutcome(
  script: string,
  t: TempTranscript,
  over: Partial<PtyProcessOptions> = {},
  turn: {
    prompt?: string;
    timeoutMs?: number;
    allowReplCommand?: boolean;
    onChunk?: (c: string) => void;
  } = {},
): Promise<{ text?: string; err?: unknown }> {
  const proc = await spawnPty(opts(script, t, over));
  try {
    const r = await proc.runTurn(turn.prompt ?? PROMPT, {
      timeoutMs: turn.timeoutMs ?? 5000,
      allowReplCommand: turn.allowReplCommand,
      onChunk: turn.onChunk,
    });
    return { text: r.text };
  } catch (err) {
    return { err };
  } finally {
    await proc.dispose();
  }
}

/** Run with the PTY trace on; returns the trace text. */
async function withTrace<T>(body: () => Promise<T>): Promise<{ value: T; wire: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
  const trace = join(dir, "trace.log");
  process.env.CLAUDECLAW_PTY_DUMP = trace;
  try {
    const value = await body();
    return { value, wire: readFileSync(trace, "utf8") };
  } finally {
    delete process.env.CLAUDECLAW_PTY_DUMP;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#562 — the screen is never evidence the prompt was accepted", () => {
  // Each phrase is something the old detector read as "a turn is running". The prompt
  // ECHOES it (the kernel stands in for the input box) and the repaint paints it next to
  // the old conversation's done chrome, while the transcript holds OLD assistant text that
  // contains it too. None of that is a new entry for this prompt.
  for (const phrase of ["esc to interrupt", "esc cancel", "Compacting conversation"]) {
    test(`a prompt and old assistant text containing "${phrase}": the turn is NOT done`, async () => {
      const t = tx(`${assistantLine(`OLD text about ${phrase}`)}\n`);
      const script = `IFS= read -r l; printf '${CHROME_STALE}'; printf '${phrase} ${CHROME_BUSY}${CHROME_DONE}'; sleep 8`;
      const out = await runOutcome(
        script,
        t,
        { submitConfirmMs: 150 },
        { prompt: `Explain ${phrase}.` },
      );
      // Fault: treat a screen marker as acceptance again and this resolves with stale text.
      expect(out.text).toBeUndefined();
      expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
    });
  }

  test("running chrome, an answer and done chrome on screen, an empty transcript: NOT done", async () => {
    const t = tx();
    const script = `IFS= read -r l; printf '${CHROME_BUSY}'; printf '\\342\\227\\217 SCREEN-ANSWER\\n${CHROME_DONE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });

  test("the transcript holds a user entry for something ELSE: not accepted, and the error says so", async () => {
    const t = tx();
    const script = `IFS= read -r l; ${append(t.path, userLine("a different prompt"))}; printf '${CHROME_BUSY}${CHROME_DONE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
    expect((out.err as Error).message).toContain("did not match this prompt");
  });

  test("an earlier identical prompt and its answer in the transcript are not this turn", async () => {
    const t = tx(`${userLine(PROMPT)}\n${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l; printf '${CHROME_STALE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });

  test("onChunk is not fed the stale repaint of a turn that never started", async () => {
    const t = tx();
    const chunks: string[] = [];
    await runOutcome(
      `IFS= read -r l; printf '${CHROME_STALE}'; sleep 8`,
      t,
      { submitConfirmMs: 150 },
      {
        onChunk: (c) => chunks.push(c),
      },
    );
    // Fault: stream the screen again and the old answer reaches Discord/Telegram.
    expect(chunks.join("")).toBe("");
  });

  test("a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it", async () => {
    // After the retry CR the fake goes raw and records the next byte it gets. Ctrl-U (0x15)
    // is what empties claude's input box. The process is kept alive until the byte is
    // recorded: disposing it with the error would kill the fake mid-write on a loaded box.
    const t = tx();
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const seen = join(dir, "seen.hex");
    const proc = await spawnPty(
      opts(
        `IFS= read -r l1; printf '${CHROME_STALE}'; IFS= read -r l2; stty raw -echo; dd bs=1 count=1 2>/dev/null | od -An -tx1 > ${seen}; sleep 8`,
        t,
        { submitConfirmMs: 150 },
      ),
    );
    try {
      const err = await proc.runTurn(PROMPT, { timeoutMs: 5000 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PtyPromptNotAcceptedError);
      const read = (): string => {
        try {
          return readFileSync(seen, "utf8").trim();
        } catch {
          return "";
        }
      };
      for (let i = 0; i < 60 && read() === ""; i++) await new Promise((r) => setTimeout(r, 50));
      // Fault: skip the clear and the fake never receives a byte, so this is empty.
      expect(read()).toBe("15");
    } finally {
      await proc.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#562 — a turn is over only when the transcript says so", () => {
  test("accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done", async () => {
    const t = tx();
    const script = [
      "IFS= read -r l",
      `printf '${CHROME_BUSY}'`,
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("partial", { stop: null })),
      `printf '\\342\\227\\217 SCREEN-SAYS-DONE\\n${CHROME_DONE}'`,
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t, {}, { timeoutMs: 1500 });
    // Fault: let done chrome complete the turn and this resolves instead of timing out.
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnTimeoutError);
  });

  test("the answer is the transcript's, not the screen's", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "TRANSCRIPT-ANSWER" })}; printf '\\342\\227\\217 SCREEN-ANSWER\\n'; sleep 8`;
    const out = await runOutcome(script, t);
    expect(out.text).toBe("TRANSCRIPT-ANSWER");
  });

  test("output isolation: the previous turn's answer, repainted before this turn, is not the result", async () => {
    const t = tx(`${userLine("earlier")}\n${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l; printf '${CHROME_STALE}'; sleep 0.3; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "RESULT-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t);
    expect(out.text).toBe("RESULT-R17x");
  });

  test("resumed session: thirty old turns repainted are neither the answer nor mistaken for completion", async () => {
    const old = Array.from(
      { length: 30 },
      (_, i) =>
        `\\n\\342\\227\\217 OLD-R${i}x\\n\\342\\234\\273 Saut\\303\\251ed for ${i + 1}s \\302\\267 done 09:${String(i).padStart(2, "0")}`,
    ).join("");
    const seed = Array.from(
      { length: 30 },
      (_, i) => `${userLine(`q${i}`)}\n${assistantLine(`OLD-R${i}x`)}`,
    ).join("\n");
    const swallowed = tx(`${seed}\n`);
    const out1 = await runOutcome(
      `IFS= read -r l; printf '${old}\\n shift+tab to cycle\\n'; sleep 8`,
      swallowed,
      {
        submitConfirmMs: 150,
      },
    );
    expect(out1.err).toBeInstanceOf(PtyPromptNotAcceptedError);

    const accepted = tx(`${seed}\n`);
    const script = `IFS= read -r l; printf '${old}\\n shift+tab to cycle\\n'; sleep 0.3; ${fakeTurn({ tx: accepted.path, prompt: PROMPT, answer: "RESULT-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out2 = await runOutcome(script, accepted);
    expect(out2.text).toBe("RESULT-R17x");
    expect(out2.text).not.toMatch(/OLD-R\d+x/);
  });

  test("onChunk streams the assistant's own text from the transcript", async () => {
    const t = tx();
    const chunks: string[] = [];
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "STREAMED" })}; sleep 8`;
    const out = await runOutcome(script, t, {}, { onChunk: (c) => chunks.push(c) });
    expect(out.text).toBe("STREAMED");
    expect(chunks.join("")).toBe("STREAMED");
  });
});

describe("#562 — the same transcript, delivered in any shape, gives the same verdict and answer", () => {
  const A = assistantLine("FIRST ", { id: "m1", stop: null });
  const B = assistantLine("SECOND ", { id: "m1", stop: null });
  const C = assistantLine("THIRD", { id: "m1", stop: "end_turn" });
  const D = systemLine("turn_duration");
  const user = userLine(PROMPT);
  const whole = `${user}\n${A}\n${B}\n${C}\n${D}\n`;
  const cut = whole.indexOf(C) + C.length - 12;

  // Each partition tears the stream somewhere different, JSON lines included.
  const partitions: Array<[string, string[]]> = [
    ["one write", [whole]],
    [
      "user, then the three blocks in separate writes",
      [`${user}\n`, `${A}\n`, `${B}\n`, `${C}\n`, `${D}\n`],
    ],
    [
      "torn mid-line, resumed later",
      [
        whole.slice(0, 40),
        whole.slice(40, whole.indexOf("SECOND") + 3),
        whole.slice(whole.indexOf("SECOND") + 3),
      ],
    ],
    [
      "byte-sized fragments over the last block",
      [whole.slice(0, cut), ...whole.slice(cut, cut + 12).split(""), whole.slice(cut + 12)],
    ],
  ];
  for (const [name, parts] of partitions) {
    test(`${name}`, async () => {
      const t = tx();
      const writes = parts.map((p) => `${appendRaw(t.path, p)}; sleep 0.12`).join("; ");
      const script = `IFS= read -r l; printf '${CHROME_BUSY}'; ${writes}; printf '${CHROME_DONE}'; sleep 8`;
      const out = await runOutcome(script, t);
      // Fault: drop the carry of a torn trailing line and the answer comes back short.
      expect(out.err).toBeUndefined();
      expect(out.text).toBe("FIRST SECOND THIRD");
    });
  }
});

describe("#562 — acceptance does not depend on the screen painting anything", () => {
  test("a fast turn that paints NO running chrome is accepted, once, and not re-submitted", async () => {
    const t = tx();
    const script = `IFS= read -r l; ${append(t.path, userLine(PROMPT))}; ${append(t.path, assistantLine("QUICK"))}; ${append(t.path, systemLine("turn_duration"))}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.err).toBeUndefined();
    expect(value.text).toBe("QUICK");
    expect(wire).toContain("write prompt");
    // Fault: key the retry on a screen marker and a fast turn is re-submitted.
    expect(wire).not.toContain("retry submit");
  });

  test("chrome that renders differently (SGR inside the footer) changes nothing", async () => {
    const t = tx();
    const sgr = "\\033[2mesc\\033[0m \\033[2mto\\033[0m \\033[2minterrupt\\033[0m\\n";
    const script = `IFS= read -r l; printf '${sgr}'; ${append(t.path, userLine(PROMPT))}; sleep 0.3; ${append(t.path, assistantLine("OK"))}; ${append(t.path, systemLine("turn_duration"))}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.text).toBe("OK");
    expect(wire).not.toContain("retry submit");
  });

  test("/compact: accepted by its command entry, ended by compact_boundary, not re-submitted or rejected", async () => {
    const t = tx();
    // The compaction outlasts submitConfirmMs, as a real one does, and paints no running marker.
    const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>";
    const script = `IFS= read -r l; ${append(t.path, userLine(cmd))}; sleep 0.6; ${append(t.path, systemLine("compact_boundary", "Conversation compacted"))}; sleep 8`;
    const { value, wire } = await withTrace(() =>
      runOutcome(
        script,
        t,
        { submitConfirmMs: 200 },
        { prompt: "/compact", allowReplCommand: true },
      ),
    );
    expect(value.err).toBeUndefined();
    expect(value.text).toBe("Conversation compacted");
    expect(wire).not.toContain("retry submit");
  });
});

describe("#562 — the submit retry", () => {
  test("paste swallowed once, the retry lands: completes with only the new output", async () => {
    const t = tx(`${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l1; printf '${CHROME_STALE}'; IFS= read -r l2; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "NEW-ANSWER-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 200 });
    // Fault: delete the retry write; the second `read` never returns, so the turn is
    // rejected as not accepted instead of completing.
    expect(out.text).toBe("NEW-ANSWER-R17x");
  });

  test("evidence that arrives AFTER the confirm deadline: no duplicate submission", async () => {
    const t = tx();
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const reads = join(dir, "reads.log");
    try {
      // Accepted at once, but the CLI is slow to write the entry: past the first deadline
      // (200 ms), before the second (400 ms). The fake logs every line it is handed, so the
      // CR count and the number of times the prompt text arrived are both observable.
      const script = [
        `IFS= read -r l1; printf '%s\\n' "$l1" >> ${reads}`,
        "sleep 0.3",
        `IFS= read -r l2; printf '%s\\n' "$l2" >> ${reads}`,
        append(t.path, userLine(PROMPT)),
        append(t.path, assistantLine("LATE-BUT-ONCE")),
        append(t.path, systemLine("turn_duration")),
        "sleep 8",
      ].join("; ");
      const out = await runOutcome(script, t, { submitConfirmMs: 200 });
      expect(out.err).toBeUndefined();
      expect(out.text).toBe("LATE-BUT-ONCE");
      const lines = readFileSync(reads, "utf8")
        .split("\n")
        .filter((x, i, a) => i < a.length - 1);
      // One paste (the prompt text, once) and exactly one bare CR. Fault: a retry that
      // re-writes the prompt makes the text appear twice.
      expect(lines.filter((x) => x.includes(PROMPT)).length).toBe(1);
      expect(lines.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prompt accepted on the first CR, in a turn that outlasts submitConfirmMs, is never retried", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "SLOW", think: 0.6 })}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.text).toBe("SLOW");
    expect(wire).toContain("write prompt");
    // Fault: let the confirm timer ignore the transcript and this line appears.
    expect(wire).not.toContain("retry submit");
  });

  test("evidence after BOTH deadlines is too late: the turn fails, it does not wait for ever", async () => {
    const t = tx();
    const script = `IFS= read -r l1; sleep 1; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "TOO-LATE" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });
});

describe("#562 — the screen's only say is timing, and it can only delay", () => {
  test("a screen that never goes quiet still resolves with the transcript answer after the cap", async () => {
    const t = tx();
    // Paints a dot every 50 ms for as long as it lives: no quiet window ever opens.
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "NOISY-SCREEN" })}; while true; do printf .; sleep 0.05; done`;
    const t0 = Date.now();
    const out = await runOutcome(script, t, { quietWindowMs: 200, settleCapMs: 400 });
    // Fault: let the quiet window gate completion and this is a timeout, not a result.
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("NOISY-SCREEN");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a quiet screen resolves without waiting out the cap", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "QUIET" })}; sleep 8`;
    const t0 = Date.now();
    const out = await runOutcome(script, t, { quietWindowMs: 50, settleCapMs: 4000 });
    expect(out.text).toBe("QUIET");
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe("#562 round 3 — once the transcript commits the outcome, nothing the screen does changes it", () => {
  const noisy = "while true; do printf .; sleep 0.05; done";

  test("a hard timeout shorter than completion + settle does not turn the committed reply into a timeout", async () => {
    // Reply written at ~0.15 s; the screen never goes quiet, so the return waits out the
    // 1500 ms cap; the deadline (500 ms) falls inside that wait. Fault: leave the deadline
    // armed after the commit (drop the clear in `_commitTurn` AND the committed-guard in the
    // timeout callback) and the supervisor would retry the prompt.
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "COMMITTED" })}; ${noisy}`;
    const out = await runOutcome(
      script,
      t,
      { quietWindowMs: 200, settleCapMs: 1500 },
      { timeoutMs: 500 },
    );
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("COMMITTED");
  });

  test("the deadline passing with the reply already in the file, unread, is not a timeout", async () => {
    // The poll interval is stretched to 400 ms, so at the 300 ms deadline nothing has read
    // the reply yet. Fault: drop the poll in the timeout callback and this rejects with
    // PtyTurnTimeoutError.
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "UNREAD-AT-DEADLINE" })}; sleep 8`;
    const out = await runOutcome(
      script,
      t,
      {
        quietWindowMs: 50,
        settleCapMs: 400,
        submitConfirmMs: 2000,
        _setInterval: (cb) => setInterval(cb, 400),
      },
      { timeoutMs: 300 },
    );
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("UNREAD-AT-DEADLINE");
  });

  test("the process exiting while the screen settles keeps the committed reply (no PtyClosedError, so no replay)", async () => {
    // Fault: reject with PtyClosedError on exit even when the turn is committed, and the
    // supervisor respawns and runs the prompt a second time.
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "BEFORE-EXIT" })}; ${"for i in 1 2 3 4 5 6; do printf .; sleep 0.05; done"}; exit 0`;
    const out = await runOutcome(script, t, { quietWindowMs: 500, settleCapMs: 3000 });
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("BEFORE-EXIT");
  });

  test("the process exiting before the last poll read the reply still keeps it", async () => {
    // Reply appended and the process gone within one poll interval. Fault: drop the final
    // read in `_handleExit` and the reply is never seen: PtyClosedError.
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "UNREAD-AT-EXIT", think: 0.05 })}; exit 0`;
    const out = await runOutcome(
      script,
      t,
      { quietWindowMs: 500, settleCapMs: 3000, _setInterval: (cb) => setInterval(cb, 2000) },
      { timeoutMs: 5000 },
    );
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("UNREAD-AT-EXIT");
  });

  test("a later prompt and its answer arriving DURING the settle cannot change the result", async () => {
    // The screen is still painting, so the return waits; B's records land in that wait.
    // Fault: no `closed` phase (keep ingesting) and the result is ANSWER-B.
    const t = tx();
    const script = [
      fakeTurn({ tx: t.path, prompt: PROMPT, answer: "ANSWER-A" }),
      "sleep 0.1",
      append(t.path, userLine("the scheduled prompt B")),
      append(t.path, assistantLine("ANSWER-B", { id: "msg_b" })),
      noisy,
    ].join("; ");
    const out = await runOutcome(script, t, { quietWindowMs: 200, settleCapMs: 1200 });
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("ANSWER-A");
  });
});

describe("#562 round 3 — a failed turn is a failure", () => {
  test("an API error in the transcript rejects with the CLI's text, as a PtyTurnFailedError", async () => {
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(
        t.path,
        JSON.stringify({
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            id: "e",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: 529 overloaded" }],
            stop_reason: "stop_sequence",
          },
        }),
      ),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t);
    // Fault: resolve the failure with the text (the round-2 shape) and `err` is undefined.
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("api-error");
    expect((out.err as PtyTurnFailedError).text).toBe("API Error: 529 overloaded");
  });

  test("a transcript replaced during the turn rejects with TranscriptReplacedError", async () => {
    const t = tx(`${userLine(PROMPT)}\n${assistantLine("OLD-HISTORY")}\n`);
    const script = [
      "IFS= read -r l",
      `cp ${t.path} ${t.path}.copy`,
      `mv ${t.path}.copy ${t.path}`,
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t);
    // Fault: drop the identity check and the replacement's retained history is read as
    // this turn's reply: the turn resolves with OLD-HISTORY.
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(TranscriptReplacedError);
  });
});

describe("#562 round 3 — executions, not bytes: a late transcript record is one turn", () => {
  const userEntries = (path: string): number =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes('"type":"user"')).length;

  test("accepted at once, the record flushes late: ONE executed turn, one reply", async () => {
    const t = tx();
    // The CLI takes the prompt at the first CR and writes its record 0.5 s later: past the
    // first submit deadline (300 ms), so the retry CR goes in. A bare CR on an empty input
    // box runs nothing, as in the real TUI; a line that carries the prompt runs it AGAIN.
    // The fake keeps reading input and records every executed turn on its own, so a
    // resubmission of the whole prompt is counted (the first reply is slow enough for a
    // second execution's record to land before the turn resolves).
    const script = [
      "n=0",
      "while IFS= read -r l; do",
      `case "$l" in *'${PROMPT}'*)`,
      "n=$((n+1))",
      `( sleep 0.5; ${append(t.path, userLine(PROMPT))}; if [ "$n" -eq 1 ]; then sleep 0.9; ${append(t.path, assistantLine("RAN-ONCE"))}; ${append(t.path, systemLine("turn_duration"))}; fi ) &`,
      ";; esac",
      "done",
    ].join("\n");
    const out = await runOutcome(script, t, { submitConfirmMs: 300 }, { timeoutMs: 6000 });
    // Count what the CLI executed, not what we wrote. Fault: a retry that resubmits the
    // prompt makes the fake run it a second time and this is 2 (the first assertion on
    // purpose: it must be the count that goes red, not the outcome after it).
    expect(userEntries(t.path)).toBe(1);
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("RAN-ONCE");
  });

  test("a TUI that would execute twice on the retry Enter: two executions, and the turn is NOT a success", async () => {
    const t = tx();
    // Each Enter the TUI reads runs the buffered prompt. The retry CR (300 ms) triggers a
    // second execution whose record lands (0.75 s) before the first reply (1.05 s).
    const script = [
      "IFS= read -r l1",
      `( sleep 0.45; ${append(t.path, userLine(PROMPT))}; sleep 0.6; ${append(t.path, assistantLine("FIRST-REPLY", { id: "m1" }))} ) &`,
      "IFS= read -r l2",
      `( sleep 0.45; ${append(t.path, userLine(PROMPT))} ) &`,
      "wait",
      "sleep 8",
    ].join("\n");
    const out = await runOutcome(script, t, { submitConfirmMs: 300 }, { timeoutMs: 4000 });
    // Fault: let a second matching user entry through (drop the duplicate check) and this
    // resolves with FIRST-REPLY while the prompt ran twice.
    expect(userEntries(t.path)).toBe(2);
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("ambiguous");
  });
});

describe("#562 round 4 — the transcript alone decides how much of the answer, and when the turn ends", () => {
  const noisy = "while true; do printf .; sleep 0.05; done";
  /** A final message of two text blocks on separate lines (one id), B arriving `gap` s after A. */
  const twoBlocks = (path: string, gap: number): string[] => [
    "IFS= read -r l",
    append(path, userLine(PROMPT)),
    "sleep 0.1",
    append(path, assistantLine("A-BLOCK ", { id: "msg_1" })),
    `sleep ${gap}`,
    append(path, assistantLine("B-BLOCK", { id: "msg_1" })),
    append(path, systemLine("turn_duration")),
  ];

  test("a quiet screen and a repainting screen return the SAME answer for a final message whose block B arrives late", async () => {
    // Fault: commit the turn on the first terminal line that has text. The quiet screen then
    // returns "A-BLOCK " (nothing paints for 400 ms, past the 50 ms quiet window) while the
    // repainting one returns both: the same transcript, two answers.
    const quiet = tx();
    const quietOut = await runOutcome(`${twoBlocks(quiet.path, 0.4).join("; ")}; sleep 8`, quiet);
    const noisyT = tx();
    const noisyOut = await runOutcome(
      `${twoBlocks(noisyT.path, 0.4).join("; ")}; ${noisy}`,
      noisyT,
      { quietWindowMs: 200, settleCapMs: 1500 },
    );
    expect(quietOut.err).toBeUndefined();
    expect(noisyOut.err).toBeUndefined();
    expect(quietOut.text).toBe("A-BLOCK B-BLOCK");
    expect(noisyOut.text).toBe("A-BLOCK B-BLOCK");
  });

  test("a terminal thinking-only final message ends at turn_duration as an empty reply, not with the narration before it", async () => {
    // Round 6, Fix 2: the answer is the FINAL message. This test used to expect the last
    // message that had text ("THE-LAST-TEXT"); that was the bug, so it is reversed on
    // purpose. Fault (site: `addAssistantLine`, drop textless messages again): the turn
    // succeeds with "THE-LAST-TEXT". Fault (site: require text before a terminal message
    // counts): the turn waits for the 4 s deadline and rejects with PtyTurnTimeoutError.
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("THE-LAST-TEXT", { id: "msg_1", stop: "tool_use" })),
      append(
        t.path,
        assistantLine("", { id: "msg_2", blocks: [{ type: "thinking", thinking: "done" }] }),
      ),
      append(t.path, systemLine("turn_duration")),
      "sleep 8",
    ].join("; ");
    const t0 = Date.now();
    const out = await runOutcome(script, t, {}, { timeoutMs: 4000 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("empty-reply");
    expect(Date.now() - t0).toBeLessThan(3500);
  });
});

describe("#562 round 5 — a turn ends only at an authoritative boundary", () => {
  test("block B arriving 1.8 s after block A, past the old 1.5 s settle, is in the answer", async () => {
    // Fault: end a terminal turn after 1.5 s without growth (the round-4 settle) and the
    // answer is "A-BLOCK ", B ignored.
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("A-BLOCK ", { id: "msg_1" })),
      "sleep 1.8",
      append(t.path, assistantLine("B-BLOCK", { id: "msg_1" })),
      append(t.path, systemLine("turn_duration")),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t, {}, { timeoutMs: 6000 });
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("A-BLOCK B-BLOCK");
  }, 10_000);

  test("a final message and no boundary by the timeout: PtyTranscriptUncertainError, no answer", async () => {
    // Fault: drop the `finalSeen` branch of the hard timeout and this is a plain
    // PtyTurnTimeoutError; end the turn on the terminal message and `text` is "FINAL".
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("FINAL", { id: "msg_1" })),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t, {}, { timeoutMs: 1200 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTranscriptUncertainError);
  });

  test("no final message by the timeout is a plain timeout, not uncertain", async () => {
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("Let me look.", { id: "msg_1", stop: "tool_use" })),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t, {}, { timeoutMs: 1200 });
    expect(out.err).toBeInstanceOf(PtyTurnTimeoutError);
  });

  test("an API error after the final text, before turn_duration, rejects as api-error", async () => {
    // Fault: close the turn on the next record without reading the error flags first and
    // the turn resolves with "FINAL".
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("FINAL", { id: "msg_1" })),
      append(
        t.path,
        JSON.stringify({
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            id: "e",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: 529 overloaded" }],
            stop_reason: "stop_sequence",
          },
        }),
      ),
      append(t.path, systemLine("turn_duration")),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t);
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("api-error");
  });

  test("a reply with no text rejects as an empty-reply failure", async () => {
    // Fault: treat an empty answer as OK and the turn resolves with text "".
    const t = tx();
    const script = [
      "IFS= read -r l",
      append(t.path, userLine(PROMPT)),
      append(
        t.path,
        assistantLine("", { id: "msg_1", blocks: [{ type: "tool_use", name: "Read", input: {} }] }),
      ),
      append(t.path, systemLine("turn_duration")),
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t);
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("empty-reply");
    expect((out.err as PtyTurnFailedError).text).toBe("empty reply in transcript");
  });
});

describe("#562 round 5 — a stopped process cannot write a late record", () => {
  test("once dispose() has returned, nothing the process was writing reaches the file any more", async () => {
    // A process appending to the transcript every 50 ms. Fault: do not stop it in dispose()
    // (drop the kill) and it never exits, so dispose() hangs and this times out; a dispose()
    // that returned before the process was gone would let a write land after it.
    const t = tx();
    const proc = await spawnPty(
      opts(`while :; do printf 'late\\n' >> ${t.path}; sleep 0.05; done`, t),
    );
    for (let i = 0; i < 100 && !existsSync(t.path); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(t.path)).toBe(true);
    await proc.dispose();
    expect(proc.isAlive()).toBe(false);
    const after = readFileSync(t.path, "utf8").length;
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(t.path, "utf8").length).toBe(after);
  }, 10_000);

  test("turn 1 not accepted, process stopped, a new process on the same transcript: turn 2 answers with its OWN reply, never turn 1's late one", async () => {
    // The first process would write turn 1's record and answer late, once it has read a
    // third line. Stopped and awaited, it never does. Fault: leave the first process alive
    // (skip the dispose) and its record lands inside turn 2's window.
    const t = tx();
    const late = [
      "IFS= read -r l1",
      "IFS= read -r l2",
      "sleep 0.8",
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("ANSWER-OF-TURN-1")),
      append(t.path, systemLine("turn_duration")),
      "sleep 8",
    ].join("; ");
    const first = await spawnPty(opts(late, t, { submitConfirmMs: 150 }));
    const err = await first.runTurn(PROMPT, { timeoutMs: 5000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PtyPromptNotAcceptedError);
    await first.dispose();
    expect(first.isAlive()).toBe(false);
    // Past the point where the first process would have written.
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(t.path) ? readFileSync(t.path, "utf8") : "").not.toContain(
      "ANSWER-OF-TURN-1",
    );
    const second = await spawnPty(
      opts(`${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "ANSWER-OF-TURN-2" })}; sleep 8`, t),
    );
    try {
      const r = await second.runTurn(PROMPT, { timeoutMs: 5000 });
      expect(r.text).toBe("ANSWER-OF-TURN-2");
    } finally {
      await second.dispose();
    }
  }, 15_000);
});

describe("#562 — a process with no transcript cannot succeed", () => {
  test("an untrusted PTY turn errors before anything is written and never resolves from the screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const got = join(dir, "got.log");
    try {
      // The screen would happily "complete" this turn: it paints everything, as soon as it
      // sees any input at all. It must never see any.
      const t = tx();
      const script = `: > ${got}; IFS= read -r l && printf 'got\\n' >> ${got}; printf '${CHROME_BUSY}\\342\\227\\217 SCREEN\\n${CHROME_DONE}'; sleep 8`;
      const { transcriptPath: _omit, ...rest } = opts(script, t, { isolation: "untrusted" });
      const proc = await spawnPty(rest);
      const err = await proc.runTurn(PROMPT, { timeoutMs: 3000 }).then(
        () => null,
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 200));
      await proc.dispose();
      // Fault: drop the refusal and the screen path resolves (or the fake logs the prompt).
      expect(err).toBeInstanceOf(PtyTranscriptUnavailableError);
      expect((err as Error).message).toContain("--no-session-persistence");
      expect(readFileSync(got, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hooked process given no transcriptPath is refused the same way", async () => {
    const t = tx();
    const { transcriptPath: _omit, ...rest } = opts("sleep 8", t);
    const proc = await spawnPty(rest);
    const err = await proc.runTurn(PROMPT, { timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    await proc.dispose();
    expect(err).toBeInstanceOf(PtyTranscriptUnavailableError);
  });
});

// Silence "unused" for helpers kept for the shape of the file.
void appendFileSync;
