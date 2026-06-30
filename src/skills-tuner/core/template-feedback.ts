/**
 * template_feedback — the rating mechanism that feeds the `template_feedback`
 * telemetry stream (OutcomeLoop Phase B).
 *
 * `PromptTemplateSubject` already CONSUMES this log (its `collectObservations`
 * + `measureFitness` read `~/.config/tuner/template_feedback.jsonl`), but nothing
 * PRODUCED it. The `tuner rate-template <id> <yes|yes-but|no>` CLI command and
 * the `TemplateFeedbackTelemetryProducer` both go through here so the on-disk
 * shape stays in one place.
 *
 * Verdict → rating uses the same yes/yes-but/no vocabulary the proposal
 * `feedback` command uses, mapped onto the 1..5 scale the subject buckets on
 * (`rating <= 2` correction, `>= 4` positive, middle = neutral). The stream
 * metric `template_avg_rating` is a median, higher_is_better.
 *
 * Line shape (matches PromptTemplateSubject.defaultFeedbackReader):
 *   { ts, template_id, rating, verdict, comment? }
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TEMPLATE_FEEDBACK_LOG = join(
  homedir(),
  ".config",
  "tuner",
  "template_feedback.jsonl",
);

export type TemplateVerdict = "yes" | "yes-but" | "no";

/** 1..5 scale: yes = strong-positive, yes-but = neutral, no = correction. */
export const VERDICT_RATING: Record<TemplateVerdict, number> = {
  yes: 5,
  "yes-but": 3,
  no: 1,
};

export function isTemplateVerdict(v: string): v is TemplateVerdict {
  return v === "yes" || v === "yes-but" || v === "no";
}

export interface TemplateFeedbackEntry {
  ts: string;
  template_id: string;
  rating: number;
  verdict: TemplateVerdict;
  comment?: string;
}

/**
 * Append one rating to the feedback log (default
 * `~/.config/tuner/template_feedback.jsonl`), creating the parent dir. Returns
 * the written entry. Throws on a bad verdict (caller validates user input).
 */
export function appendTemplateFeedback(
  input: { templateId: string; verdict: TemplateVerdict; comment?: string; ts?: string },
  path: string = DEFAULT_TEMPLATE_FEEDBACK_LOG,
): TemplateFeedbackEntry {
  if (!isTemplateVerdict(input.verdict)) {
    throw new Error(`invalid verdict: ${input.verdict} (expected yes|yes-but|no)`);
  }
  const entry: TemplateFeedbackEntry = {
    ts: input.ts ?? new Date().toISOString(),
    template_id: input.templateId,
    rating: VERDICT_RATING[input.verdict],
    verdict: input.verdict,
    ...(input.comment ? { comment: input.comment } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}
