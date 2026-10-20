/**
 * Schema-probe assertions.
 *
 * Split out of `schema-probe.ts` to keep both files under the 500-LOC
 * budget. Each assertion is a pure function over collected JSONL lines
 * (and optional sibling JSONLs from `/clear` rotation per Spike 0.5).
 *
 * Assertion taxonomy (spec §11.1):
 *  1. jsonl_path_present       - file exists at the predicted encoded path
 *  2. user_event_present       - "user" line with extractable content
 *  3. assistant_text_present   - "assistant" with content[].text block
 *  4. usage_block_present      - usage carries cache_* and input_tokens
 *  5. tool_use_present         - assistant.content[].tool_use block found
 *  6. tool_result_present      - user.content[].tool_result block (Spike 0.2
 *                                correction: tool_result is a content block
 *                                inside a user line, NOT top-level)
 *  7. clear_rotation_detected  - "/clear" rotated to a new JSONL (Spike 0.5)
 *
 * There used to be an 8th, `exit_envelope_present` (a `/exit` local_command
 * line on `/quit`, Spike 0.5). claude 2.1.286 writes no such line on `/quit`
 * or `/exit` (#441, measured), and nothing in the Bus reads it — process
 * exit is the authoritative end signal (session-manager.ts header), which
 * the probe checks as `process_exit`. Asserting a shape no consumer reads
 * would make the probe fail on every current CLI and protect nothing.
 *
 * Field-name match against the Tailer's parser is implicit in checks 2-6.
 * If the Tailer expects `message.content[].text` and the probe doesn't
 * find it, the probe fails. No separate "field name" assertion needed.
 */

export interface CollectedJsonl {
  path: string;
  lines: Record<string, unknown>[];
  raw: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  reason: string;
}

export interface AssertionContext {
  expectedPath: string;
  siblingJsonls: string[];
}

export interface AssertionDef {
  name: string;
  check: (collected: CollectedJsonl, ctx: AssertionContext) => AssertionResult;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Helpers                                                               */
/* ───────────────────────────────────────────────────────────────────── */

function pass(name: string): AssertionResult {
  return { name, passed: true, reason: "" };
}
function fail(name: string, reason: string): AssertionResult {
  return { name, passed: false, reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getContentArray(line: Record<string, unknown>): unknown[] | null {
  const msg = line.message;
  if (!isRecord(msg)) return null;
  const c = msg.content;
  return Array.isArray(c) ? c : null;
}

function getContentStringOrArray(line: Record<string, unknown>): string | unknown[] | null {
  const msg = line.message;
  if (!isRecord(msg)) return null;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c;
  return null;
}

function findLinesByType(
  lines: Record<string, unknown>[],
  type: string,
): Record<string, unknown>[] {
  return lines.filter((l) => l.type === type);
}

/* ───────────────────────────────────────────────────────────────────── */
/* Assertion definitions                                                 */
/* ───────────────────────────────────────────────────────────────────── */

export const ASSERTION_DEFS: AssertionDef[] = [
  {
    name: "jsonl_path_present",
    check(collected, ctx) {
      if (collected.path !== ctx.expectedPath) {
        return fail(
          "jsonl_path_present",
          `path mismatch: expected ${ctx.expectedPath}, got ${collected.path}`,
        );
      }
      if (collected.lines.length === 0 && !collected.raw) {
        return fail(
          "jsonl_path_present",
          `no JSONL appeared at ${ctx.expectedPath} within probe budget`,
        );
      }
      return pass("jsonl_path_present");
    },
  },

  {
    name: "user_event_present",
    check(collected) {
      // Spike 0.2: user.message.content is string OR array. Both shapes
      // must be extractable. We want a string-content user line specifically
      // for the canonical prompt (text-only, not tool_result).
      const users = findLinesByType(collected.lines, "user");
      if (users.length === 0) return fail("user_event_present", "no user line emitted");
      for (const u of users) {
        const c = getContentStringOrArray(u);
        if (c === null) continue;
        if (typeof c === "string" && c.length > 0) return pass("user_event_present");
        if (Array.isArray(c) && c.length > 0) return pass("user_event_present");
      }
      return fail("user_event_present", "user line(s) had no extractable content");
    },
  },

  {
    name: "assistant_text_present",
    check(collected) {
      const assistants = findLinesByType(collected.lines, "assistant");
      if (assistants.length === 0) {
        return fail("assistant_text_present", "no assistant line emitted");
      }
      for (const a of assistants) {
        const content = getContentArray(a);
        if (!content) continue;
        for (const block of content) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
            return pass("assistant_text_present");
          }
        }
      }
      return fail("assistant_text_present", "assistant line(s) had no content[].text block");
    },
  },

  {
    name: "usage_block_present",
    check(collected) {
      const assistants = findLinesByType(collected.lines, "assistant");
      if (assistants.length === 0) {
        return fail("usage_block_present", "no assistant line to read usage from");
      }
      for (const a of assistants) {
        const msg = a.message;
        if (!isRecord(msg)) continue;
        const usage = msg.usage;
        if (!isRecord(usage)) continue;
        // Spec §11.1 mandates these three; Spike 0.2 confirms presence on
        // every assistant turn from claude 2.1.143.
        const needed = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
        const missing = needed.filter((k) => typeof usage[k] !== "number");
        if (missing.length === 0) return pass("usage_block_present");
        return fail("usage_block_present", `usage missing numeric fields: ${missing.join(", ")}`);
      }
      return fail("usage_block_present", "no assistant line carried a usage object");
    },
  },

  {
    name: "tool_use_present",
    check(collected) {
      // Step 7 of the probe procedure: a tool-eliciting prompt should
      // produce an assistant content[].tool_use block.
      const assistants = findLinesByType(collected.lines, "assistant");
      for (const a of assistants) {
        const content = getContentArray(a);
        if (!content) continue;
        for (const block of content) {
          if (
            isRecord(block) &&
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            return pass("tool_use_present");
          }
        }
      }
      return fail("tool_use_present", "no assistant.content[].tool_use block observed");
    },
  },

  {
    name: "tool_result_present",
    check(collected) {
      // Spike 0.2 correction: tool_result is a content block inside a
      // user line, NOT a top-level type. Its .content is string OR
      // array (array when result includes images).
      const users = findLinesByType(collected.lines, "user");
      for (const u of users) {
        const c = getContentStringOrArray(u);
        if (!Array.isArray(c)) continue;
        for (const block of c) {
          if (!isRecord(block)) continue;
          if (block.type !== "tool_result") continue;
          if (typeof block.tool_use_id !== "string") continue;
          const inner = block.content;
          if (typeof inner === "string" || Array.isArray(inner)) {
            return pass("tool_result_present");
          }
        }
      }
      return fail(
        "tool_result_present",
        "no user.content[].tool_result block observed (Spike 0.2 shape)",
      );
    },
  },

  {
    name: "clear_rotation_detected",
    check(_collected, ctx) {
      // Spike 0.5: /clear does NOT append to the active JSONL. It
      // rotates to a brand-new file under the same project dir. We
      // assert at least one sibling materialised.
      if (ctx.siblingJsonls.length === 0) {
        return fail(
          "clear_rotation_detected",
          "no sibling JSONL appeared after /clear (rotation expected per Spike 0.5)",
        );
      }
      return pass("clear_rotation_detected");
    },
  },
];

/* ───────────────────────────────────────────────────────────────────── */
/* Driver                                                                */
/* ───────────────────────────────────────────────────────────────────── */

export function runAssertions(collected: CollectedJsonl, ctx: AssertionContext): AssertionResult[] {
  return ASSERTION_DEFS.map((def) => {
    try {
      return def.check(collected, ctx);
    } catch (err) {
      return fail(def.name, err instanceof Error ? err.message : String(err));
    }
  });
}
