/**
 * #301 — the stall watchdog's operator-alert path.
 *
 * Acceptance from the issue:
 *  - a `suspected_false_positive` kill delivers its flag + ceiling suggestion
 *    to the operator's chat surface, in addition to the log + audit;
 *  - delivery is best-effort — a delivery error never affects recovery.
 */

import { describe, it, expect } from "bun:test";
import type { BusEvent } from "../types";
import {
  createStallAlertNotifier,
  STALL_ALERT_PREFIX,
  OPERATOR_ALERT_TOPIC,
  MAX_ALERT_CHARS,
  type StallAlertBus,
  type StallAlertLogger,
} from "../stall-alert-delivery";
import { StallWatchdog, DEFAULT_STALL_CONFIG, type StallWatchdogDeps } from "../stall-watchdog";

/** Length of the cap suffix appended by clampForChat, in code points. */
const SUFFIX_LEN = Array.from("… (rest in the daemon log)").length;

function harness(opts?: { busThrows?: boolean }) {
  const published: BusEvent[] = [];
  const logs: Array<{ level: "warn" | "error"; args: unknown[] }> = [];

  const bus: StallAlertBus = {
    ingestSessionEvent: (e) => {
      if (opts?.busThrows) throw new Error("bus is down");
      published.push(e);
    },
  };
  const logger: StallAlertLogger = {
    warn: (...args) => logs.push({ level: "warn", args }),
    error: (...args) => logs.push({ level: "error", args }),
  };

  const notify = createStallAlertNotifier({ bus, logger, now: () => 1_700_000_000_000 });
  return { notify, published, logs };
}

describe("stall alert delivery (#301)", () => {
  it("delivers the alert on the dedicated operator-alert topic", () => {
    const { notify, published } = harness();
    notify("critical", "Stall-killed reg but it looked ALIVE", "reg");

    expect(published).toHaveLength(1);
    const e = published[0];
    expect(e?.topic).toBe(OPERATOR_ALERT_TOPIC);
    expect(e?.agent_id).toBe("reg");
    expect((e?.payload as { text: string }).text).toContain("looked ALIVE");
  });

  it("labels the alert so it is not mistaken for the agent's own reply", () => {
    const { notify, published } = harness();
    notify("critical", "raise stallWatchdog.ceilings.bash.killSeconds", "reg");

    const text = (published[0]?.payload as { text: string }).text;
    expect(text.startsWith(STALL_ALERT_PREFIX)).toBe(true);
  });

  it("sets NO origin so Discord routes via primaryChannelByAgent, not a reply channel", () => {
    // An origin would either be dropped (foreign channel-driven) or routed
    // back to a source channel. The operator-alert path needs neither.
    const { notify, published } = harness();
    notify("warn", "outstanding 400s", "suzy");

    const payload = published[0]?.payload as { origin?: string; origin_id?: string };
    expect(payload.origin).toBeUndefined();
    expect(payload.origin_id).toBeUndefined();
  });

  it("still logs both levels, on the durable path, as before", () => {
    const { notify, logs } = harness();
    notify("critical", "critical msg", "reg");
    notify("warn", "warn msg", "reg");

    expect(logs.find((l) => l.level === "error")?.args).toContain("critical msg");
    expect(logs.find((l) => l.level === "warn")?.args).toContain("warn msg");
  });

  it("logs BEFORE attempting delivery, so a bus failure cannot lose the alert", () => {
    const { notify, logs } = harness({ busThrows: true });
    notify("critical", "the alert text", "reg");

    // The original alert is still in the log even though delivery threw.
    expect(logs.some((l) => l.args.includes("the alert text"))).toBe(true);
  });

  it("swallows a delivery failure — never throws at the caller (recovery path)", () => {
    const { notify, logs } = harness({ busThrows: true });

    expect(() => notify("critical", "alert", "reg")).not.toThrow();
    // and it surfaces the delivery failure itself
    expect(logs.some((l) => l.args.some((a) => String(a).includes("delivery failed")))).toBe(true);
  });

  it("skips delivery when there is no agent to route to", () => {
    const { notify, published, logs } = harness();
    notify("critical", "no agent", "");

    expect(published).toHaveLength(0);
    expect(logs).toHaveLength(1); // still logged
  });

  it("NEVER publishes a reply topic — a reply carries turn semantics", () => {
    // Regression guard. `response.text` would make Telegram close the open
    // receipt as `turn_observed` and edit the alert OVER the agent's live
    // reply message, and would make the web UI bridge splice the alert into
    // an in-flight /api/chat response.
    const { notify, published } = harness();
    notify("critical", "c", "reg");
    notify("warn", "w", "reg");

    // Assert delivery actually happened FIRST: `.every()` on an empty array
    // is vacuously true, so without this the guard would still pass if the
    // notifier stopped publishing altogether.
    expect(published).toHaveLength(2);
    const replyTopics = ["response.text", "response.edit_text", "response.turn_end"];
    expect(published.every((e) => !replyTopics.includes(e.topic))).toBe(true);
  });

  it("carries the level so a surface can style by severity", () => {
    const { notify, published } = harness();
    notify("warn", "w", "reg");
    notify("critical", "c", "reg");

    expect((published[0]?.payload as { level: string }).level).toBe("warn");
    expect((published[1]?.payload as { level: string }).level).toBe("critical");
  });

  it("truncates the chat copy but logs the full text", () => {
    // The chat surface is a less trusted sink than the daemon log: an
    // interpolated err.message can carry absolute host paths or a session id.
    const { notify, published, logs } = harness();
    const huge = `restart failed: ${"/very/long/host/path".repeat(200)}`;
    notify("critical", huge, "reg");

    const delivered = (published[0]?.payload as { text: string }).text;
    // Assert it lands AT the cap, not merely "shorter than input" — the
    // loose form would pass a cap that let 3000 chars through.
    const body = delivered.slice(STALL_ALERT_PREFIX.length + 1);
    expect(Array.from(body).length).toBeLessThanOrEqual(MAX_ALERT_CHARS + SUFFIX_LEN);
    expect(delivered).toContain("rest in the daemon log");
    // full text still reached the log
    expect(logs.some((l) => l.args.includes(huge))).toBe(true);
  });

  it("passes a short message through UNcapped, with no suffix", () => {
    const { notify, published } = harness();
    notify("warn", "short and sweet", "reg");

    const text = (published[0]?.payload as { text: string }).text;
    expect(text).toBe(`${STALL_ALERT_PREFIX} short and sweet`);
    expect(text).not.toContain("rest in the daemon log");
  });

  it("caps by code POINT, so all-astral text is not measured in one unit and cut in another", () => {
    // 400 emoji = 800 UTF-16 units but only 400 code points. Measuring the
    // guard in units while slicing in points made this trip the cap and then
    // remove nothing — claiming content was dropped when none was, and
    // delivering ~2x the intended cap.
    const { notify, published } = harness();
    const astral = "😀".repeat(400);
    notify("critical", astral, "reg");

    const text = (published[0]?.payload as { text: string }).text;
    expect(text).not.toContain("rest in the daemon log");
    expect(text).toBe(`${STALL_ALERT_PREFIX} ${astral}`);
  });

  it("never splits a surrogate pair when capping the chat copy", () => {
    // An interpolated err.message can carry an emoji. Cutting by UTF-16 code
    // unit at exactly the boundary would emit a lone surrogate.
    const { notify, published } = harness();
    // Pad so the cap lands mid-emoji, then fill past it with astral chars.
    const msg = `${"a".repeat(599)}${"😀".repeat(50)}`;
    notify("critical", msg, "reg");

    const text = (published[0]?.payload as { text: string }).text;
    // No unpaired surrogate anywhere in the delivered text.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text),
    ).toBe(false);
  });

  it("does not throw even when the logger itself throws", () => {
    const boom: StallAlertLogger = {
      warn: () => {
        throw new Error("logger down");
      },
      error: () => {
        throw new Error("logger down");
      },
    };
    const notify = createStallAlertNotifier({
      bus: {
        ingestSessionEvent: () => {
          throw new Error("bus down");
        },
      },
      logger: boom,
    });

    expect(() => notify("critical", "alert", "reg")).not.toThrow();
  });
});

/* ── End-to-end through the watchdog itself ───────────────────────────────── */

function watchdogDeps(notify: StallWatchdogDeps["notify"]): StallWatchdogDeps {
  return {
    subscribe: () => () => {},
    restart: async () => {},
    captureForensic: async () => ({ cpuAdvancing: true, outputRecencyMs: 500 }),
    recordKill: async () => ({
      classification: "suspected_false_positive",
      suggestedKillSeconds: 1800,
    }),
    notify,
    now: () => 0,
  };
}

function toolUse(ts: number): BusEvent {
  return {
    ts,
    agent_id: "reg",
    session_id: "s1",
    topic: "response.tool_use",
    payload: { id: "b1", name: "Bash" },
  };
}

describe("stall watchdog → operator alert, end to end (#301)", () => {
  it("a suspected_false_positive kill reaches the operator surface with the ceiling suggestion", async () => {
    const published: BusEvent[] = [];
    const logs: Array<{ level: "warn" | "error"; args: unknown[] }> = [];
    const notify = createStallAlertNotifier({
      bus: { ingestSessionEvent: (e) => published.push(e) },
      logger: {
        warn: (...args) => logs.push({ level: "warn", args }),
        error: (...args) => logs.push({ level: "error", args }),
      },
    });

    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, watchdogDeps(notify));
    wd.ingest(toolUse(0));
    await wd.sweep(950_000);

    const alert = published.find((e) =>
      (e.payload as { text: string }).text.includes("looked ALIVE"),
    );
    expect(alert).toBeDefined();
    expect(alert?.agent_id).toBe("reg");

    const text = (alert?.payload as { text: string }).text;
    expect(text).toContain("stallWatchdog.ceilings.bash.killSeconds");
    expect(text).toContain("1800");
  });

  it("passes the stalled agent id through so the alert routes to that agent's channel", async () => {
    const seen: string[] = [];
    const wd = new StallWatchdog(
      DEFAULT_STALL_CONFIG,
      watchdogDeps((_l, _m, agentId) => seen.push(agentId)),
    );
    wd.ingest(toolUse(0));
    await wd.sweep(950_000);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a === "reg")).toBe(true);
  });

  it("a failing delivery does not prevent the restart (recovery is unaffected)", async () => {
    let restarts = 0;
    const deps = watchdogDeps(
      createStallAlertNotifier({
        bus: {
          ingestSessionEvent: () => {
            throw new Error("bus is down");
          },
        },
        logger: { warn: () => {}, error: () => {} },
      }),
    );
    deps.restart = async () => {
      restarts++;
    };

    const wd = new StallWatchdog(DEFAULT_STALL_CONFIG, deps);
    wd.ingest(toolUse(0));
    await wd.sweep(950_000);

    expect(restarts).toBe(1);
  });
});
